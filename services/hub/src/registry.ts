import {
  type AbortReason,
  ClientMessage,
  type LobbyErrorCode,
  type LobbyPlayer,
  type PlayerInfo,
  isProfane,
  peekType,
  PROTOCOL_VERSION,
  ROOM_ALPHABET,
  ROOM_CODE_LENGTH,
  type Bag,
  type PrepareFailReason,
  type RoomPhase,
  type RoomSummary,
  type Visibility,
} from '@playhub/protocol';
import { checkSettings, DEFAULT_LIMITS, type GameConfig, originAllowed } from './games.ts';
import { NoTurn, STUN_ONLY, type TurnProvider } from './turn.ts';

/** The slice of a WebSocket the registry needs (lets tests use fakes). */
export interface Sock {
  send(text: string): void;
  close(code?: number, reason?: string): void;
  /** Request details captured at upgrade time. */
  origin?: string;
  /** The client's address (behind Caddy: from X-Forwarded-For); keys the per-IP limits. */
  ip?: string;
  /** Latest round-trip time to this client, ms (the server measures it from its pings). */
  rttMs?: number;
}

interface Member {
  /** null while the player is away (their connection dropped; the seat is held for the grace period). */
  sock: Sock | null;
  player: PlayerInfo;
  ready: boolean;
  client: Client;
  /** When the connection dropped, ms; null while connected. */
  awaySince: number | null;
  /** While the room is preparing: has this player reported ready? */
  prep: 'pending' | 'ready' | null;
}

interface Room {
  game: string;
  code: string;
  name: string;
  visibility: Visibility;
  settings: Bag;
  maxPlayers: number;
  hostId: string;
  members: Map<string, Member>;
  /** True while preparing or racing (late joiners are refused). */
  started: boolean;
  phase: RoomPhase;
  /** When a preparing room gives up waiting, ms. */
  prepareDeadline: number;
  /** Who created it (address of the host's connection), for the per-IP room cap. */
  creatorIp: string;
  /** Last lobby activity (create, join, leave, ready, reopen), ms. */
  lastActive: number;
  startedAt: number;
}

interface Client {
  game: GameConfig;
  player: PlayerInfo;
  room: Room | null;
  ip: string;
}

export const CLOSE_PROTOCOL = 4400;
/** How long a join waits for the TURN provider before settling for STUN only, ms. */
export const TURN_WAIT_MS = 4000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timed out')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * What keeps a small VM safe from a lobby that fills up or never drains. All overridable per hub.
 */
export interface Limits {
  /** Open rooms per game; beyond it `lobbyCreate` answers `server_busy`. */
  maxRoomsPerGame: number;
  /** Rooms one address may host at once. */
  maxRoomsPerIp: number;
  /** A room nobody touched for this long is closed (it has not started), ms. Clients are told how
   * long is left (`closesInSeconds`) so the UI can show a countdown. */
  roomIdleMs: number;
  /** A started room is closed after this long however it is going (matches are minutes), ms. */
  startedMaxMs: number;
  /** How long a start waits for every player to load and report ready, ms. Per-game override: `prepareTimeoutMs`. */
  prepareTimeoutMs: number;
  /** Once everyone is ready, the lights go green this long after (minus half each player's round trip), ms. */
  startLeadMs: number;
  /** After a player's connection drops, their seat is held this long for them to come back, ms.
   * Clients show the countdown (`graceSeconds` in the welcome, `away` on the player). */
  graceMs: number;
  /** Failed joins (unknown code) one address may make per minute before joins are refused: a
   * 4-letter code is only 280 000 combinations, so unthrottled guessing finds private rooms. */
  failedJoinsPerMinute: number;
  /** Rooms returned by `lobbyList`. */
  listLimit: number;
}

export const DEFAULT_REGISTRY_LIMITS: Limits = {
  maxRoomsPerGame: 500,
  maxRoomsPerIp: 5,
  roomIdleMs: 15 * 60_000,
  startedMaxMs: 60 * 60_000,
  graceMs: 30_000,
  prepareTimeoutMs: 15_000,
  startLeadMs: 8_000,
  failedJoinsPerMinute: 10,
  listLimit: 100,
};

export interface RegistryOptions {
  games: Map<string, GameConfig>;
  limits?: Partial<Limits>;
  /** Clock, ms (tests). */
  now?: () => number;
  /** Where players' TURN relay comes from; STUN only when omitted. */
  turn?: TurnProvider | null;
  random?: () => number;
  log?: (msg: string) => void;
}

/**
 * Rooms, ready-up and WebRTC signaling relay for any number of games. One socket is one player for
 * its whole connection; `lobbyHello` (which names the game) must be the first frame. Everything is
 * scoped by game: rooms, codes and listings never cross games.
 */
export class Registry {
  /** game id → room code → room */
  private rooms = new Map<string, Map<string, Room>>();
  private clients = new Map<Sock, Client>();
  private readonly games: Map<string, GameConfig>;
  private readonly turn: TurnProvider;
  private readonly random: () => number;
  private readonly log: (msg: string) => void;
  private readonly limits: Limits;
  private readonly now: () => number;
  /** Failed joins per address in the current minute. */
  private failedJoins = new Map<string, { count: number; resetAt: number }>();

  constructor(opts: RegistryOptions) {
    this.limits = { ...DEFAULT_REGISTRY_LIMITS, ...opts.limits };
    this.now = opts.now ?? Date.now;
    this.games = opts.games;
    this.turn = opts.turn ?? new NoTurn();
    this.random = opts.random ?? Math.random;
    this.log = opts.log ?? (() => {});
  }

  get roomCount(): number {
    let n = 0;
    for (const m of this.rooms.values()) n += m.size;
    return n;
  }

  get playerCount(): number {
    return this.clients.size;
  }

  /** Per-game counts for /healthz and logs. */
  stats(): Record<string, { rooms: number; players: number }> {
    const out: Record<string, { rooms: number; players: number }> = {};
    for (const id of this.games.keys()) out[id] = { rooms: 0, players: 0 };
    for (const [id, m] of this.rooms) out[id]!.rooms = m.size;
    for (const c of this.clients.values()) out[c.game.id]!.players++;
    return out;
  }

  onMessage(sock: Sock, text: string): void {
    const client = this.clients.get(sock);
    if (!client) {
      if (peekType(text) !== 'lobbyHello')
        return this.fail(sock, 'bad_message', 'expected lobbyHello first');
      return this.handleHello(sock, text);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return this.fail(sock, 'bad_message', 'invalid JSON');
    }
    const msg = ClientMessage.safeParse(parsed);
    if (!msg.success) return this.fail(sock, 'bad_message', 'invalid message');
    switch (msg.data.type) {
      case 'lobbyHello':
        return; // already hello'd; ignore a repeat
      case 'lobbyList':
        return this.sendList(sock, client);
      case 'lobbyCreate':
        return this.createRoom(sock, client, msg.data);
      case 'lobbyJoin':
        return this.joinRoom(sock, client, msg.data.code);
      case 'lobbyLeave':
        return this.leaveRoom(client);
      case 'lobbyReady':
        return this.setReady(client, msg.data.ready);
      case 'lobbyStart':
        return this.startRoom(sock, client);
      case 'lobbyPrepared':
        return this.onPrepared(client, msg.data.ok, msg.data.reason);
      case 'lobbyCancel':
        return this.cancelStart(sock, client);
      case 'lobbyReopen':
        return this.reopenRoom(sock, client);
      case 'lobbySignal':
        return this.relaySignal(client, msg.data.to, msg.data.data);
      case 'lobbyBoost':
        return; // only meaningful while queued (the server handles it)
    }
  }

  onClose(sock: Sock): void {
    const client = this.clients.get(sock);
    if (!client) return;
    this.clients.delete(sock);
    const room = client.room;
    if (!room) return;
    const member = room.members.get(client.player.id);
    // A newer socket may already have taken this seat (reconnect); then there is nothing to do.
    if (!member || member.sock !== sock) {
      client.room = null;
      return;
    }
    // Hold the seat for the grace period instead of dropping the player at once: a flaky
    // connection must not cost them their room (or, mid-match, the host their match). Everyone
    // else sees them as away; `sweep` removes them if they do not come back in time.
    member.sock = null;
    member.awaySince = this.now();
    this.log(`${room.game}/${room.code}: ${client.player.name} is away`);
    // Someone dropping while everyone is preparing calls the start off (their seat is still held).
    if (room.phase === 'preparing') this.abortPrepare(room, member, 'away');
    else this.broadcastRoomState(room);
  }

  /** Seconds until an unstarted room is closed for inactivity (counted from its last activity). */
  private closesIn(room: Room): number | undefined {
    if (room.started) return undefined;
    return Math.max(0, Math.ceil((this.limits.roomIdleMs - (this.now() - room.lastActive)) / 1000));
  }

  /**
   * Does this player hold a seat they lost the connection to (inside the grace period)? Such a player coming back
   * is let in even when the hub is full, or the wait would cost them their room.
   */
  hasAwaySeat(gameId: string, playerId: string): boolean {
    for (const room of this.rooms.get(gameId)?.values() ?? []) {
      const m = room.members.get(playerId);
      if (m && m.awaySince !== null) return true;
    }
    return false;
  }

  /** Connected, said hello, and sitting in no room (a menu or lobby browser): the first to give up a slot when others wait. */
  isIdleInLobby(sock: Sock): boolean {
    const c = this.clients.get(sock);
    return !!c && c.room === null;
  }

  /** Has this socket said a valid hello? (The server drops sockets that never do.) */
  hasClient(sock: Sock): boolean {
    return this.clients.has(sock);
  }

  /**
   * Housekeeping, run every few seconds by the server: closes rooms that sat idle (not started) or
   * outlived the maximum match length (started), telling their members, and forgets old failed-join
   * counters. Players stay connected; only the room goes. Returns how many rooms it closed.
   */
  sweep(): number {
    const t = this.now();
    let closed = 0;
    for (const rooms of this.rooms.values())
      for (const room of [...rooms.values()]) {
        // Players whose grace period ran out leave now (the room may empty and go with them).
        for (const m of [...room.members.values()])
          if (m.awaySince !== null && t - m.awaySince >= this.limits.graceMs)
            this.removeMember(room, m.player.id);
        if (!rooms.has(room.code)) continue;
        if (room.phase === 'preparing' && t >= room.prepareDeadline)
          this.abortPrepare(
            room,
            [...room.members.values()].find((m) => m.prep === 'pending') ?? null,
            'timeout',
          );
        const idle = !room.started && t - room.lastActive > this.limits.roomIdleMs;
        const expired = room.started && t - room.startedAt > this.limits.startedMaxMs;
        if (!idle && !expired) continue;
        const msg = JSON.stringify({ type: 'lobbyClosed', reason: idle ? 'idle' : 'expired' });
        for (const m of room.members.values()) {
          m.client.room = null;
          m.sock?.send(msg);
        }
        rooms.delete(room.code);
        closed++;
        this.log(`${room.game}/${room.code}: closed (${idle ? 'idle' : 'expired'})`);
      }
    for (const [ip, f] of this.failedJoins) if (t >= f.resetAt) this.failedJoins.delete(ip);
    return closed;
  }

  dispose(): void {
    this.rooms.clear();
    this.clients.clear();
    this.failedJoins.clear();
  }

  // ── handlers ───────────────────────────────────────────────────────────────

  private handleHello(sock: Sock, text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return this.fail(sock, 'bad_message', 'invalid JSON');
    }
    const hello = ClientMessage.safeParse(parsed);
    if (!hello.success || hello.data.type !== 'lobbyHello')
      return this.fail(sock, 'bad_message', 'invalid lobbyHello');
    if (hello.data.v !== PROTOCOL_VERSION)
      return this.fail(sock, 'bad_version', `hub speaks v${PROTOCOL_VERSION}`);
    const game = this.games.get(hello.data.game);
    if (!game) return this.fail(sock, 'unknown_game', `no game "${hello.data.game}"`);
    if (!originAllowed(game, sock.origin))
      return this.fail(sock, 'forbidden_origin', `${sock.origin} may not play ${game.id}`);
    if (JSON.stringify(hello.data.player.profile).length > DEFAULT_LIMITS.profileBytes)
      return this.fail(sock, 'bad_message', 'profile too large');
    if (isProfane(hello.data.player.name)) {
      // Names are shown to other players: a refused one is logged (with the address) so abuse can be followed up.
      this.log(
        `refused player name (profanity) from ${sock.ip ?? '?'}: ${JSON.stringify(hello.data.player.name)}`,
      );
      return this.fail(sock, 'bad_message', 'that name is not allowed');
    }
    const client: Client = { game, player: hello.data.player, room: null, ip: sock.ip ?? '?' };
    this.clients.set(sock, client);
    // The welcome carries the ICE servers, which a provider may have to fetch. A provider that
    // fails or stalls must never keep a player out: after TURN_WAIT_MS it is STUN only.
    const id = hello.data.player.id;
    void withTimeout(this.turn.iceServers(id), TURN_WAIT_MS)
      .catch(() => STUN_ONLY)
      .then((iceServers) => {
        // The socket may have closed while we waited.
        if (this.clients.get(sock) !== client) return;
        sock.send(
          JSON.stringify({
            type: 'lobbyWelcome',
            you: id,
            iceServers,
            graceSeconds: Math.round(this.limits.graceMs / 1000),
          }),
        );
      });
  }

  private gameRooms(game: string): Map<string, Room> {
    let m = this.rooms.get(game);
    if (!m) this.rooms.set(game, (m = new Map()));
    return m;
  }

  private summary(room: Room): RoomSummary {
    const host = room.members.get(room.hostId);
    return {
      code: room.code,
      name: room.name,
      hostId: room.hostId,
      hostName: host?.player.name ?? '?',
      visibility: room.visibility,
      settings: room.settings,
      maxPlayers: room.maxPlayers,
      playerCount: room.members.size,
      started: room.started,
      phase: room.phase,
      ...(room.started ? {} : { closesInSeconds: this.closesIn(room) }),
    };
  }

  private lobbyPlayers(room: Room): LobbyPlayer[] {
    return [...room.members.values()].map((m) => ({
      ...m.player,
      ready: m.ready,
      host: m.player.id === room.hostId,
      ...(m.sock === null ? { away: true } : {}),
      ...(m.prep ? { prep: m.prep } : {}),
    }));
  }

  private sendList(sock: Sock, client: Client): void {
    // Public rooms, fullest first (so a joiner sees live ones), capped.
    const rooms = [...this.gameRooms(client.game.id).values()]
      .filter((r) => r.visibility === 'public' && [...r.members.values()].some((m) => m.sock))
      .sort((a, b) => b.members.size - a.members.size)
      .slice(0, this.limits.listLimit)
      .map((r) => this.summary(r));
    sock.send(JSON.stringify({ type: 'lobbyListResult', rooms }));
  }

  private broadcastRoomState(room: Room): void {
    const msg = JSON.stringify({
      type: 'lobbyRoomState',
      room: this.summary(room),
      players: this.lobbyPlayers(room),
    });
    for (const m of room.members.values()) m.sock?.send(msg);
  }

  private newCode(rooms: Map<string, Room>): string {
    for (;;) {
      let c = '';
      for (let i = 0; i < ROOM_CODE_LENGTH; i++)
        c += ROOM_ALPHABET[Math.floor(this.random() * ROOM_ALPHABET.length)];
      if (!rooms.has(c)) return c;
    }
  }

  private createRoom(
    sock: Sock,
    client: Client,
    msg: { name: string; visibility: Visibility; settings: Bag; maxPlayers: number },
  ): void {
    const bad = checkSettings(client.game, msg.settings);
    if (bad) return this.reply(sock, 'bad_settings', bad);
    if (isProfane(msg.name)) {
      this.log(`refused room name (profanity) from ${client.ip}: ${JSON.stringify(msg.name)}`);
      return this.reply(sock, 'bad_message', 'that room name is not allowed');
    }
    this.leaveRoom(client);
    const rooms = this.gameRooms(client.game.id);
    if (rooms.size >= this.limits.maxRoomsPerGame)
      return this.reply(sock, 'server_busy', 'too many rooms right now, try again shortly');
    let hostedHere = 0;
    for (const r of rooms.values()) if (r.creatorIp === client.ip) hostedHere++;
    if (hostedHere >= this.limits.maxRoomsPerIp)
      return this.reply(sock, 'rate_limited', 'too many rooms from your address');
    const now = this.now();
    const room: Room = {
      game: client.game.id,
      code: this.newCode(rooms),
      name: msg.name,
      visibility: msg.visibility,
      settings: msg.settings,
      maxPlayers: Math.min(msg.maxPlayers, client.game.maxPlayers),
      hostId: client.player.id,
      members: new Map([
        [
          client.player.id,
          { sock, player: client.player, ready: false, client, awaySince: null, prep: null },
        ],
      ]),
      started: false,
      phase: 'lobby',
      prepareDeadline: 0,
      creatorIp: client.ip,
      lastActive: now,
      startedAt: 0,
    };
    rooms.set(room.code, room);
    client.room = room;
    this.log(`${room.game}/${room.code}: created by ${client.player.name}`);
    this.broadcastRoomState(room);
  }

  private joinRoom(sock: Sock, client: Client, code: string): void {
    const t = this.now();
    const fails = this.failedJoins.get(client.ip);
    if (fails && t < fails.resetAt && fails.count >= this.limits.failedJoinsPerMinute)
      return this.reply(
        sock,
        'rate_limited',
        `too many wrong room codes, try again in ${Math.ceil((fails.resetAt - t) / 1000)} s`,
      );
    const room = this.gameRooms(client.game.id).get(code);
    if (!room) {
      const f = fails && t < fails.resetAt ? fails : { count: 0, resetAt: t + 60_000 };
      f.count++;
      this.failedJoins.set(client.ip, f);
      return this.reply(sock, 'room_not_found', `no room ${code}`);
    }
    room.lastActive = t;
    const existing = room.members.get(client.player.id);
    if (existing) {
      // Reconnecting with the same id (page reload, network blip, or back within the grace
      // period): resume the seat.
      existing.sock = sock;
      existing.client = client;
      existing.awaySince = null;
      client.room = room;
      return this.broadcastRoomState(room);
    }
    if (room.started) return this.reply(sock, 'room_started', `room ${code} already started`);
    if (room.members.size >= room.maxPlayers)
      return this.reply(sock, 'room_full', `room ${code} is full`);
    this.leaveRoom(client);
    room.members.set(client.player.id, {
      sock,
      player: client.player,
      ready: false,
      client,
      awaySince: null,
      prep: null,
    });
    client.room = room;
    this.log(`${room.game}/${room.code}: ${client.player.name} joined`);
    this.broadcastRoomState(room);
  }

  private leaveRoom(client: Client): void {
    const room = client.room;
    if (!room) return;
    client.room = null;
    this.removeMember(room, client.player.id);
  }

  /** Takes a player out of a room: hands the host over if needed, closes the room if it empties. */
  private removeMember(room: Room, id: string): void {
    const member = room.members.get(id);
    if (!member) return;
    if (room.phase === 'preparing') this.abortPrepare(room, member, 'left');
    room.members.delete(id);
    room.lastActive = this.now();
    if (room.members.size === 0) {
      this.gameRooms(room.game).delete(room.code);
      this.log(`${room.game}/${room.code}: closed (empty)`);
      return;
    }
    // Host left: hand over to whoever has been in the room longest (Map keeps insertion order),
    // preferring someone who is actually connected.
    if (room.hostId === id) {
      const next = [...room.members.values()].find((m) => m.sock) ?? [...room.members.values()][0]!;
      room.hostId = next.player.id;
    }
    this.log(`${room.game}/${room.code}: ${member.player.name} left`);
    this.broadcastRoomState(room);
  }

  private setReady(client: Client, ready: boolean): void {
    const member = client.room?.members.get(client.player.id);
    if (!client.room || !member || client.room.phase !== 'lobby') return;
    member.ready = ready;
    client.room.lastActive = this.now();
    this.broadcastRoomState(client.room);
  }

  /**
   * Host pressed start. The match does not begin yet: every player is asked to load and check their
   * controller (`lobbyPrepare`), and only when all have said they are ready does everyone get the
   * same `lobbyGo` (see `go`). Anyone who cannot, or does not answer in time, calls it off for all.
   */
  private startRoom(sock: Sock, client: Client): void {
    const room = client.room;
    if (!room) return;
    if (room.hostId !== client.player.id)
      return this.reply(sock, 'not_host', 'only the host can start');
    if (room.phase !== 'lobby') return; // already preparing or racing
    const away = [...room.members.values()].find((m) => m.sock === null);
    if (away) {
      // Nobody can start without them: say so straight away instead of waiting for a timeout.
      const msg = JSON.stringify({
        type: 'lobbyAbort',
        who: away.player.id,
        name: away.player.name,
        reason: 'away',
      });
      for (const m of room.members.values()) m.sock?.send(msg);
      return;
    }
    const timeoutMs = client.game.prepareTimeoutMs ?? this.limits.prepareTimeoutMs;
    const t = this.now();
    room.phase = 'preparing';
    room.started = true;
    room.startedAt = room.lastActive = t;
    room.prepareDeadline = t + timeoutMs;
    for (const m of room.members.values()) m.prep = 'pending';
    const msg = JSON.stringify({ type: 'lobbyPrepare', timeoutMs });
    for (const m of room.members.values()) m.sock?.send(msg);
    this.log(`${room.game}/${room.code}: preparing (${room.members.size} players)`);
    this.broadcastRoomState(room);
  }

  /** A player's answer to `lobbyPrepare`. All ready → go; any not ready → call it off. */
  private onPrepared(client: Client, ok: boolean, reason?: PrepareFailReason): void {
    const room = client.room;
    const member = room?.members.get(client.player.id);
    if (!room || !member || room.phase !== 'preparing') return;
    if (!ok) return this.abortPrepare(room, member, reason ?? 'other');
    member.prep = 'ready';
    if ([...room.members.values()].every((m) => m.prep === 'ready')) return this.go(room);
    this.broadcastRoomState(room);
  }

  /** Host only: call off a start while everyone is still preparing. */
  private cancelStart(sock: Sock, client: Client): void {
    const room = client.room;
    if (!room) return;
    if (room.hostId !== client.player.id)
      return this.reply(sock, 'not_host', 'only the host can cancel');
    const host = room.members.get(client.player.id);
    if (room.phase === 'preparing' && host) this.abortPrepare(room, host, 'cancelled');
  }

  /**
   * Everyone is ready. Each player gets "go in N ms", N being the lead time minus half that
   * connection's round trip, so the lights go green for all of them at the same real instant.
   */
  private go(room: Room): void {
    const t = this.now();
    room.phase = 'racing';
    room.startedAt = room.lastActive = t;
    room.prepareDeadline = 0;
    for (const m of room.members.values()) {
      m.prep = null;
      const startInMs = Math.max(
        250,
        Math.round(this.limits.startLeadMs - (m.sock?.rttMs ?? 0) / 2),
      );
      m.sock?.send(JSON.stringify({ type: 'lobbyGo', hostId: room.hostId, startInMs }));
    }
    this.log(`${room.game}/${room.code}: go`);
    this.broadcastRoomState(room);
  }

  /** Calls the start off for everyone and puts the room back in the lobby. */
  private abortPrepare(room: Room, who: Member | null, reason: AbortReason): void {
    if (room.phase !== 'preparing') return;
    room.phase = 'lobby';
    room.started = false;
    room.startedAt = 0;
    room.prepareDeadline = 0;
    room.lastActive = this.now();
    for (const m of room.members.values()) m.prep = null;
    const msg = JSON.stringify({
      type: 'lobbyAbort',
      who: who?.player.id ?? '',
      name: who?.player.name ?? '',
      reason,
    });
    for (const m of room.members.values()) m.sock?.send(msg);
    this.log(
      `${room.game}/${room.code}: start called off (${reason}${who ? `: ${who.player.name}` : ''})`,
    );
    this.broadcastRoomState(room);
  }

  /** Host only: back to the lobby after a match, so the room can take a rematch and late joiners. */
  private reopenRoom(sock: Sock, client: Client): void {
    const room = client.room;
    if (!room) return;
    if (room.hostId !== client.player.id)
      return this.reply(sock, 'not_host', 'only the host can reopen the room');
    if (room.phase !== 'racing') return;
    room.phase = 'lobby';
    room.started = false;
    room.startedAt = 0;
    room.lastActive = this.now();
    for (const m of room.members.values()) m.ready = false;
    this.broadcastRoomState(room);
  }

  private relaySignal(client: Client, to: string, data: unknown): void {
    const target = client.room?.members.get(to);
    if (!target?.sock) return; // not (or no longer) in your room, or away: drop silently
    target.sock.send(JSON.stringify({ type: 'lobbySignal', from: client.player.id, data }));
  }

  /** A recoverable problem: tell the client, keep the connection. */
  private reply(sock: Sock, code: LobbyErrorCode, message: string): void {
    sock.send(JSON.stringify({ type: 'lobbyError', code, message }));
  }

  /** A fatal protocol problem: tell the client and drop the connection. */
  private fail(sock: Sock, code: LobbyErrorCode, message: string): void {
    this.reply(sock, code, message);
    sock.close(CLOSE_PROTOCOL, code);
  }
}
