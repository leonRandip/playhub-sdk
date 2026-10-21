/**
 * The signaling connection to a playhub hub: room discovery, create/join/leave, and a `LiveRoom`
 * (with its WebRTC links) once you're in one. Reconnects with backoff when the socket drops and
 * resumes your seat by player id.
 */
import type {
  AbortReason,
  Bag,
  IceServer,
  LobbyErrorCode,
  LobbyPlayer,
  PlayerInfoInput,
  RoomSummary,
  Visibility,
} from '@playhub/protocol';
import { PROTOCOL_VERSION } from '@playhub/protocol';
import { LiveRoom, type RoomTuning } from './room.ts';
import type { LinkFactory } from './peer-link.ts';

const BACKOFF_MS = [250, 500, 1000, 2000];
/** The hub closes with this code on a protocol-level refusal (bad game/origin/version): retrying
 * would just be refused again. */
const CLOSE_PROTOCOL = 4400;

/** The slice of the WebSocket API the client uses (lets tests inject a fake). */
export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number }) => void) | null;
}
export type SocketFactory = (url: string) => SocketLike;

export interface HubClientOptions {
  /** wss://hub.example.com/v1/lobby */
  url: string;
  /** Game id registered with the hub. */
  game: string;
  /** Called on every (re)connect so the hub always sees the current name/profile. */
  player: () => PlayerInfoInput;
  tuning?: Partial<RoomTuning>;
  /** Defaults to `new WebSocket(url)`. */
  socket?: SocketFactory;
  /** Defaults to a real `RTCPeerConnection`. */
  createLink?: LinkFactory;
  /** How long create/join/list wait for the hub before failing, ms. */
  requestTimeoutMs?: number;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Where you stand when the hub is full and you are waiting to be let in. */
export interface QueueInfo {
  position: number;
  size: number;
  etaSeconds: number;
  /** The boost (move up) has been used. */
  boosted: boolean;
}

export class HubError extends Error {
  constructor(
    readonly code: LobbyErrorCode | 'unreachable' | 'timeout',
    message: string,
  ) {
    super(message);
  }
}

const OPEN = 1;

export class HubClient {
  private ws: SocketLike | null = null;
  private attempt = 0;
  private closedByUser = false;
  private _rooms: RoomSummary[] = [];
  private _room: LiveRoom | null = null;
  private iceServers: IceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
  /** Re-sent as a `lobbyJoin` on reconnect so a dropped link doesn't lose your seat. */
  private lastRoomCode: string | null = null;
  private pending: { list: Pending[]; create: Pending | null; join: Pending | null } = {
    list: [],
    create: null,
    join: null,
  };
  /** True while a welcomed socket is open: lets a UI tell "no hub" apart from "no rooms". */
  connected = false;
  /** Set while the hub is full and we are in line; null otherwise (including once admitted). */
  queue: QueueInfo | null = null;
  /** Called when `queue` changes (place, size, or admitted = null). */
  onQueue: (q: QueueInfo | null) => void = () => {};
  /** Set when the hub refused us for good (unknown game, wrong origin, bad version). */
  fatalError: HubError | null = null;
  /** Called when `connected` flips. */
  onConnection: (connected: boolean) => void = () => {};
  /**
   * You are no longer in your room: the hub closed it (idle or too old), or you were out of touch
   * longer than the grace period. You stay connected (or keep reconnecting), just in no room.
   */
  onRoomClosed: (reason: 'idle' | 'expired' | 'disconnected') => void = () => {};
  /** How long the hub holds your seat after a drop, ms (the welcome says; 30 s until it has). */
  private graceMs = 30_000;
  /** Set while the connection is down but a room is still held (peer links keep running). */
  private outageSince: number | null = null;
  private outageTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: HubClientOptions) {
    this.connect();
  }

  get rooms(): readonly RoomSummary[] {
    return this._rooms;
  }

  get room(): LiveRoom | null {
    return this._room;
  }

  /**
   * Seconds left to get back to the hub before the room is given up, or null when the connection is
   * fine. While it counts down the room, its peer-to-peer links and any match in progress keep
   * running; only lobby actions (ready, start) wait for the connection.
   */
  get reconnectSecondsLeft(): number | null {
    if (this.outageSince === null) return null;
    return Math.max(0, Math.ceil((this.graceMs - (Date.now() - this.outageSince)) / 1000));
  }

  async list(): Promise<RoomSummary[]> {
    if (!this.connected) return this._rooms;
    await this.request('list', { type: 'lobbyList' });
    return this._rooms;
  }

  create(args: {
    name: string;
    visibility: Visibility;
    settings: Bag;
    maxPlayers: number;
  }): Promise<RoomSummary> {
    return this.request('create', { type: 'lobbyCreate', ...args }) as Promise<RoomSummary>;
  }

  join(code: string): Promise<RoomSummary> {
    return this.request('join', {
      type: 'lobbyJoin',
      code: code.toUpperCase(),
    }) as Promise<RoomSummary>;
  }

  /** While waiting in line: move up (the hub allows it once per connection; a game offers it as a reward). */
  boost(): void {
    if (this.queue && !this.queue.boosted) this.send({ type: 'lobbyBoost' });
  }

  leave(): void {
    this.dropRoom();
    this.send({ type: 'lobbyLeave' });
  }

  /** Forgets the room locally (no message to the hub) and ends any outage countdown. */
  private dropRoom(): void {
    this._room?.dispose();
    this._room = null;
    this.lastRoomCode = null;
    this.clearOutage();
  }

  private clearOutage(): void {
    this.outageSince = null;
    if (this.outageTimer) clearTimeout(this.outageTimer);
    this.outageTimer = null;
  }

  /** Disconnects for good (no reconnect). */
  close(): void {
    this.closedByUser = true;
    this.dropRoom();
    this.ws?.close();
  }

  // ── plumbing ────────────────────────────────────────────────────────────────────────────────

  private request(kind: 'list' | 'create' | 'join', msg: unknown): Promise<unknown> {
    if (!this.connected)
      return Promise.reject(
        this.fatalError ?? new HubError('unreachable', "Can't reach the game server"),
      );
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const p = kind === 'list' ? null : this.pending[kind];
        if (kind === 'list') this.pending.list = this.pending.list.filter((x) => x.timer !== timer);
        else if (p?.timer === timer) this.pending[kind] = null;
        reject(new HubError('timeout', 'The game server did not answer'));
      }, this.opts.requestTimeoutMs ?? 8000);
      const entry: Pending = { resolve, reject, timer };
      if (kind === 'list') this.pending.list.push(entry);
      else {
        // A newer request supersedes an older one of the same kind.
        this.pending[kind]?.reject(new HubError('bad_message', 'superseded'));
        this.pending[kind] = entry;
      }
      this.send(msg);
    });
  }

  private settle(p: Pending | null, ok: boolean, v: unknown): void {
    if (!p) return;
    clearTimeout(p.timer);
    if (ok) p.resolve(v);
    else p.reject(v as Error);
  }

  private setQueue(q: QueueInfo | null): void {
    const same =
      (q === null && this.queue === null) ||
      (q !== null &&
        this.queue !== null &&
        q.position === this.queue.position &&
        q.size === this.queue.size &&
        q.boosted === this.queue.boosted &&
        q.etaSeconds === this.queue.etaSeconds);
    if (same) return;
    this.queue = q;
    this.onQueue(q);
  }

  private setConnected(v: boolean): void {
    if (this.connected === v) return;
    this.connected = v;
    this.onConnection(v);
  }

  private connect(): void {
    const ws = this.opts.socket
      ? this.opts.socket(this.opts.url)
      : (new WebSocket(this.opts.url) as unknown as SocketLike);
    this.ws = ws;
    this.setQueue(null);
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: 'lobbyHello',
          v: PROTOCOL_VERSION,
          game: this.opts.game,
          player: this.opts.player(),
        }),
      );
    };
    ws.onmessage = (e) => this.onMessage(String(e.data));
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.setConnected(false);
      this.setQueue(null);
      if (this._room && !this.closedByUser && e.code !== CLOSE_PROTOCOL) {
        // Keep the room and its peer links: the hub holds our seat for the grace period, and a
        // match in progress does not need the hub. Give up if we cannot get back in time.
        if (this.outageSince === null) {
          this.outageSince = Date.now();
          this.outageTimer = setTimeout(() => {
            this.dropRoom();
            this.onRoomClosed('disconnected');
          }, this.graceMs);
        }
      } else this.dropRoom();
      for (const p of this.pending.list.splice(0)) this.settle(p, true, undefined);
      for (const kind of ['create', 'join'] as const) {
        this.settle(this.pending[kind], false, new HubError('unreachable', 'Lost the connection'));
        this.pending[kind] = null;
      }
      if (this.closedByUser || e.code === CLOSE_PROTOCOL) return;
      const delay = BACKOFF_MS[Math.min(this.attempt++, BACKOFF_MS.length - 1)]!;
      setTimeout(() => this.connect(), delay);
    };
  }

  private send(msg: unknown): void {
    if (this.ws?.readyState === OPEN) this.ws.send(JSON.stringify(msg));
  }

  private onMessage(text: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    switch (msg['type']) {
      case 'lobbyQueued':
        this.setQueue({
          position: Number(msg['position']),
          size: Number(msg['size']),
          etaSeconds: Number(msg['etaSeconds']),
          boosted: !!msg['boosted'],
        });
        break;
      case 'lobbyWelcome':
        this.setQueue(null);
        this.iceServers = (msg['iceServers'] as IceServer[] | undefined) ?? this.iceServers;
        if (typeof msg['graceSeconds'] === 'number') this.graceMs = msg['graceSeconds'] * 1000;
        this.attempt = 0;
        this.fatalError = null;
        this.setConnected(true);
        if (this.lastRoomCode) this.send({ type: 'lobbyJoin', code: this.lastRoomCode });
        break;
      case 'lobbyListResult':
        this._rooms = msg['rooms'] as RoomSummary[];
        for (const p of this.pending.list.splice(0)) this.settle(p, true, this._rooms);
        break;
      case 'lobbyRoomState': {
        const summary = msg['room'] as RoomSummary;
        const players = msg['players'] as LobbyPlayer[];
        this.lastRoomCode = summary.code;
        this.clearOutage(); // (re)joined: the seat is ours again
        if (!this._room || this._room.summary.code !== summary.code) {
          this._room?.dispose();
          this._room = new LiveRoom(
            summary,
            this.opts.player().id,
            (m) => this.send(m),
            () => this.iceServers as RTCIceServer[],
            { tuning: this.opts.tuning, createLink: this.opts.createLink },
          );
        }
        this._room.handleRoomState(summary, players);
        for (const kind of ['create', 'join'] as const) {
          this.settle(this.pending[kind], true, summary);
          this.pending[kind] = null;
        }
        break;
      }
      case 'lobbyPrepare':
        this._room?.handlePrepare(msg['timeoutMs'] as number);
        break;
      case 'lobbyGo':
        this._room?.handleGo(msg['startInMs'] as number);
        break;
      case 'lobbyAbort':
        this._room?.handleAbort(
          String(msg['who'] ?? ''),
          String(msg['name'] ?? ''),
          msg['reason'] as AbortReason,
        );
        break;
      case 'lobbyClosed': {
        this.dropRoom(); // and don't rejoin a room that is gone on the next reconnect
        const r = msg['reason'];
        this.onRoomClosed(r === 'expired' || r === 'disconnected' ? r : 'idle');
        break;
      }
      case 'lobbySignal':
        void this._room?.handleSignal(msg['from'] as string, msg['data']);
        break;
      case 'lobbyError': {
        const code = msg['code'] as LobbyErrorCode;
        const err = new HubError(code, String(msg['message'] ?? code));
        if (code === 'unknown_game' || code === 'forbidden_origin' || code === 'bad_version')
          this.fatalError = err;
        // Coming back after a drop and the seat is gone (the grace period ran out, or the hub
        // restarted): the room is lost.
        if (
          this.outageSince !== null &&
          (code === 'room_not_found' || code === 'room_started' || code === 'room_full')
        ) {
          this.dropRoom();
          this.onRoomClosed('disconnected');
        }
        for (const kind of ['create', 'join'] as const) {
          this.settle(this.pending[kind], false, err);
          this.pending[kind] = null;
        }
        break;
      }
    }
  }
}
