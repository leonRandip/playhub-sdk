/**
 * A room you're in: members, readiness, and the WebRTC links to (or from, if you host) them.
 *
 * Topology: the room's host is the one authoritative peer; every other member connects directly to
 * the host (a star, not a mesh: N links instead of N², one referee). The joining side always
 * initiates the offer and the host only answers, so there's never a question of who goes first.
 * What the game sends over those links is its own business (`sendToHost` / `broadcast`).
 */
import type {
  AbortReason,
  LobbyPlayer,
  PrepareFailReason,
  RoomPhase,
  RoomSummary,
} from '@playhub/protocol';
import { createPeerLink, type Link, type LinkFactory, type PeerLinkState } from './peer-link.ts';

export type RoomEvent =
  | { type: 'joined'; name: string }
  | { type: 'left'; name: string }
  | { type: 'ready'; name: string }
  /** The host pressed start: load, check your controller, then call `prepared()` within `timeoutMs`. */
  | { type: 'prepare'; timeoutMs: number }
  /** Everyone is ready: the lights go green `startInMs` from when this event was raised. */
  | { type: 'go'; startInMs: number }
  /** The start was called off for everybody (`who` is '' when no single player is to blame). */
  | { type: 'abort'; who: string; name: string; reason: AbortReason }
  /** The link to the host could not be recovered; the room is unusable for a client. */
  | { type: 'linkLost' };

export interface RoomTuning {
  /** Backoff between link reconnect attempts, in ms (last value repeats). */
  retryMs: number[];
  /** How long a link may sit short of 'connected' before it counts as failed. Faster than most
   * browsers' own ICE-failure detection, which can take 20 s+. */
  linkTimeoutMs: number;
  /** Retries before a link is given up on (`hostLinkLost`). */
  maxReconnectAttempts: number;
  /** Players needed before the host can start. */
  minPlayers: number;
}

export const DEFAULT_TUNING: RoomTuning = {
  retryMs: [1000, 2000, 4000, 4000],
  linkTimeoutMs: 6000,
  maxReconnectAttempts: 4,
  minPlayers: 2,
};

export const LINK_LABEL: Record<PeerLinkState, string> = {
  connecting: 'connecting…',
  connected: 'connected',
  disconnected: 'disconnected',
  failed: 'failed',
};

export class LiveRoom {
  summary: RoomSummary;
  players: LobbyPlayer[] = [];
  /** True while preparing or racing. */
  started = false;
  phase: RoomPhase = 'lobby';
  /** When the hub will close this room for inactivity unless something happens, ms; null if never. */
  private closesAtMs: number | null = null;
  private hostId: string;
  private initialized = false;
  private events: RoomEvent[] = [];
  private peers = new Map<string, Link>();
  private peerStates = new Map<string, PeerLinkState>();
  private reconnectAttempts = new Map<string, number>();
  private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Peers given up on after maxReconnectAttempts; see `hostLinkLost`. */
  private failedPeers = new Set<string>();
  private readonly tuning: RoomTuning;
  private readonly createLink: LinkFactory;
  /** Host: a client's message arrived over its data channel. */
  onClientMessage: ((fromId: string, msg: unknown) => void) | null = null;
  /** Client: a message arrived from the host's data channel. */
  onHostMessage: ((msg: unknown) => void) | null = null;

  constructor(
    summary: RoomSummary,
    readonly myId: string,
    private readonly send: (msg: unknown) => void,
    private readonly iceServers: () => RTCIceServer[],
    opts: { tuning?: Partial<RoomTuning>; createLink?: LinkFactory } = {},
  ) {
    this.summary = summary;
    this.hostId = summary.hostId;
    this.tuning = { ...DEFAULT_TUNING, ...opts.tuning };
    this.createLink = opts.createLink ?? createPeerLink;
  }

  get hosting(): boolean {
    return this.hostId === this.myId;
  }

  get you(): LobbyPlayer {
    return this.players.find((p) => p.id === this.myId)!;
  }

  get full(): boolean {
    return this.players.length >= this.summary.maxPlayers;
  }

  get allReady(): boolean {
    return this.players.every((p) => p.ready);
  }

  get canStart(): boolean {
    return this.hosting && this.players.length >= this.tuning.minPlayers && this.allReady;
  }

  /**
   * Seconds until the hub closes this (unstarted) room for inactivity, counted down locally from
   * the last state the hub sent; every join, leave, ready or reopen resets it. Null once started.
   */
  get closesInSeconds(): number | null {
    return this.closesAtMs === null
      ? null
      : Math.max(0, Math.ceil((this.closesAtMs - Date.now()) / 1000));
  }

  /** True once reconnecting to the host has been given up on: you can't continue in this room. */
  get hostLinkLost(): boolean {
    return !this.hosting && this.failedPeers.has(this.hostId);
  }

  /** A one-line summary of the direct connection(s), or null if you're alone. */
  get linkStatus(): string | null {
    if (this.players.length < 2) return null;
    if (!this.hosting) {
      const s = this.peerStates.get(this.hostId) ?? 'connecting';
      return `Direct connection to host: ${LINK_LABEL[s]}`;
    }
    const others = this.players.length - 1;
    const linked = [...this.peerStates.values()].filter((s) => s === 'connected').length;
    return `${linked}/${others} players linked directly`;
  }

  setReady(ready: boolean): void {
    const me = this.you;
    if (me) me.ready = ready;
    this.send({ type: 'lobbyReady', ready });
  }

  /** Host only. Returns false when the room isn't ready to start. */
  start(): boolean {
    if (!this.canStart || this.started) return false;
    this.send({ type: 'lobbyStart' });
    return true;
  }

  /** Answer a `prepare` event: ready to race, or why not (which calls the start off for everyone). */
  prepared(ok: boolean, reason?: PrepareFailReason): void {
    this.send({ type: 'lobbyPrepared', ok, ...(reason ? { reason } : {}) });
  }

  /** Host only: call off a start while everyone is still preparing. */
  cancelStart(): void {
    if (this.hosting) this.send({ type: 'lobbyCancel' });
  }

  /**
   * Host only: take a finished match back to the lobby. The hub clears `started` and every ready
   * flag (a `lobbyRoomState` follows), so the room takes a rematch and late joiners again.
   */
  reopen(): void {
    if (this.hosting) this.send({ type: 'lobbyReopen' });
  }

  /** Drains the membership events (joined/left/ready/prepare/go/abort/linkLost) since the last call. */
  tick(): RoomEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  /** Client only: one message to the host over its data channel (no-op before it's open). */
  sendToHost(msg: unknown): void {
    this.peers.get(this.hostId)?.send(JSON.stringify(msg));
  }

  /** Host only: one message to every member over their data channels. */
  broadcast(msg: unknown): void {
    const text = JSON.stringify(msg);
    for (const p of this.peers.values()) p.send(text);
  }

  /** Host only: one message to one member. */
  sendTo(id: string, msg: unknown): void {
    this.peers.get(id)?.send(JSON.stringify(msg));
  }

  /**
   * Tears a link down without letting its own 'disconnected' callback schedule a reconnect (which
   * would double-count the retry budget and block the replacement link's own timer).
   */
  private dropLink(id: string): void {
    const link = this.peers.get(id);
    if (!link) return;
    this.peers.delete(id);
    this.peerStates.delete(id);
    link.onState = () => {};
    link.close();
  }

  dispose(): void {
    for (const id of [...this.peers.keys()]) this.dropLink(id);
    for (const t of this.reconnectTimers.values()) clearTimeout(t);
    this.reconnectTimers.clear();
    this.reconnectAttempts.clear();
    this.failedPeers.clear();
    this.onClientMessage = null;
    this.onHostMessage = null;
  }

  // ── fed by HubClient ────────────────────────────────────────────────────────────────────────

  /** A fresh `lobbyRoomState`: the room's full, current membership. */
  handleRoomState(summary: RoomSummary, players: readonly LobbyPlayer[]): void {
    this.summary = summary;
    this.hostId = summary.hostId;
    // The hub is the authority on the phase; a room state also tells a late arrival it is preparing.
    this.phase = summary.phase;
    this.started = summary.started;
    this.closesAtMs =
      summary.closesInSeconds === undefined ? null : Date.now() + summary.closesInSeconds * 1000;
    const next = [...players];
    if (this.initialized) {
      const prevById = new Map(this.players.map((p) => [p.id, p]));
      const nowIds = new Set(next.map((p) => p.id));
      for (const p of next)
        if (!prevById.has(p.id) && p.id !== this.myId)
          this.events.push({ type: 'joined', name: p.name });
      for (const p of this.players)
        if (!nowIds.has(p.id) && p.id !== this.myId)
          this.events.push({ type: 'left', name: p.name });
      for (const p of next) {
        const prev = prevById.get(p.id);
        if (prev && !prev.ready && p.ready && p.id !== this.myId)
          this.events.push({ type: 'ready', name: p.name });
      }
    }
    this.initialized = true;
    this.players = next;
    this.syncPeers();
  }

  handlePrepare(timeoutMs: number): void {
    this.events.push({ type: 'prepare', timeoutMs });
  }

  handleGo(startInMs: number): void {
    this.started = true;
    this.phase = 'racing';
    this.events.push({ type: 'go', startInMs });
  }

  handleAbort(who: string, name: string, reason: AbortReason): void {
    this.started = false;
    this.phase = 'lobby';
    this.events.push({ type: 'abort', who, name, reason });
  }

  async handleSignal(from: string, data: unknown): Promise<void> {
    let link = this.peers.get(from);
    const isOffer = (data as { kind?: string } | null)?.kind === 'offer';
    if (this.hosting && isOffer && link) {
      // A reconnecting joiner always starts fresh with a new offer; don't feed it into whatever
      // this end still has for them (which may itself be stale and about to be torn down by its own
      // reconnect timer): close it and answer the new one properly.
      this.dropLink(from);
      this.cancelReconnect(from);
      link = undefined;
    }
    if (!link) {
      if (this.hosting) link = this.linkTo(from, false);
      else return; // a signal from someone who isn't our host; ignore
    }
    await link.onSignalReceived(data);
  }

  // ── links ───────────────────────────────────────────────────────────────────────────────────

  /** Who a live WebRTC link should currently exist for. */
  private wantedPeers(): Set<string> {
    return this.hosting
      ? new Set(this.players.filter((p) => p.id !== this.myId).map((p) => p.id))
      : new Set(this.players.some((p) => p.id === this.hostId) ? [this.hostId] : []);
  }

  /** Opens (or closes) links so they match who's actually in the room. */
  private syncPeers(): void {
    const wanted = this.wantedPeers();
    for (const id of [...this.peers.keys()]) {
      if (!wanted.has(id)) {
        this.dropLink(id);
        this.cancelReconnect(id);
      }
    }
    if (!this.hosting && !this.peers.has(this.hostId) && wanted.has(this.hostId)) {
      // The joining side always initiates. A fresh attempt (e.g. after rejoining the room) gets a
      // clean slate, even if we'd previously given up on this host.
      this.failedPeers.delete(this.hostId);
      this.reconnectAttempts.delete(this.hostId);
      void this.linkTo(this.hostId, true).start();
    }
    // As host, links are created lazily on the first signal received from each joiner.
  }

  private cancelReconnect(id: string): void {
    const t = this.reconnectTimers.get(id);
    if (t) clearTimeout(t);
    this.reconnectTimers.delete(id);
  }

  /**
   * A link to `id` dropped (or never came up in time): close it and, if they're still in the room,
   * try again after a backoff. Gives up after `maxReconnectAttempts` rather than retrying forever
   * (see `hostLinkLost`).
   */
  private scheduleReconnect(id: string, deadLink: Link): void {
    if (this.peers.get(id) !== deadLink || this.reconnectTimers.has(id)) return;
    if (!this.wantedPeers().has(id)) return;
    const attempt = this.reconnectAttempts.get(id) ?? 0;
    if (attempt >= this.tuning.maxReconnectAttempts) {
      if (!this.failedPeers.has(id)) {
        this.failedPeers.add(id);
        if (!this.hosting && id === this.hostId) this.events.push({ type: 'linkLost' });
      }
      return;
    }
    const delay = this.tuning.retryMs[Math.min(attempt, this.tuning.retryMs.length - 1)]!;
    this.reconnectAttempts.set(id, attempt + 1);
    const t = setTimeout(() => {
      this.reconnectTimers.delete(id);
      if (this.peers.get(id) === deadLink) this.dropLink(id);
      if (!this.wantedPeers().has(id)) return;
      // The joiner re-initiates; the host just clears the dead link and waits for a fresh offer
      // (re-offering from both sides would just race).
      if (!this.hosting && id === this.hostId && !this.peers.has(id))
        void this.linkTo(id, true).start();
    }, delay);
    this.reconnectTimers.set(id, t);
  }

  private linkTo(id: string, initiator: boolean): Link {
    const link = this.createLink(initiator, this.iceServers());
    link.onSignal = (data) => this.send({ type: 'lobbySignal', to: id, data });
    link.onState = (s) => {
      this.peerStates.set(id, s);
      if (s === 'connected') {
        this.reconnectAttempts.delete(id);
        this.failedPeers.delete(id);
        this.cancelReconnect(id);
      } else if (s === 'disconnected' || s === 'failed') {
        this.scheduleReconnect(id, link);
      }
    };
    link.onMessage = (text) => {
      let msg: unknown;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (this.hosting) this.onClientMessage?.(id, msg);
      else this.onHostMessage?.(msg);
    };
    this.peers.set(id, link);
    setTimeout(() => {
      if (this.peers.get(id) === link && link.state !== 'connected')
        this.scheduleReconnect(id, link);
    }, this.tuning.linkTimeoutMs);
    return link;
  }
}
