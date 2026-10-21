/**
 * playhub wire protocol: what a game client and the hub say to each other over `wss://…/v1/lobby`.
 *
 * Game-agnostic on purpose. The hub never interprets a game's rules or a player's profile; it only
 * stores them (size-capped, optionally checked against a declarative per-game spec) and hands them
 * to the room's members. The race/match traffic itself goes peer-to-peer over WebRTC; the hub only
 * relays the handshake (`lobbySignal`) and tells clients which STUN/TURN servers to use.
 */
import { z } from 'zod';

/**
 * v2: starting a match is a handshake (`lobbyStart` → `lobbyPrepare` → everyone `lobbyPrepared` →
 * `lobbyGo`), replacing v1's `lobbyStarted`, so every player's countdown ends together and nobody
 * is left behind.
 */
export { isProfane, normalise } from './profanity.ts';

export const PROTOCOL_VERSION = 2;

/** Room codes: letters, no I/L/O (they look like 1/1/0). */
export const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ';
/**
 * New rooms get 6 letters (23^6 ≈ 148 million): a private room is reachable only by its code, and a
 * 4-letter code (280 000) can be guessed by a botnet. Joins accept 4–6 so a mistyped short code is
 * a polite "no such room", not a protocol error.
 */
export const ROOM_CODE_LENGTH = 6;
export const RoomCode = z.string().regex(/^[A-HJKMNP-Z]{4,6}$/);

/** Lower-case id of a game registered with the hub (`my-game`). */
export const GameId = z.string().regex(/^[a-z0-9][a-z0-9-]{1,31}$/);
export type GameId = z.infer<typeof GameId>;

/** Free-form per-game data (room rules, player cosmetics). Hub-capped, never interpreted. */
export const Bag = z.record(z.string().max(40), z.unknown());
export type Bag = z.infer<typeof Bag>;

export const PlayerInfo = z.object({
  /** Stable per device (localStorage); reconnecting with the same id resumes your seat. */
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(32),
  /** Anything the game wants other players to see (level, avatar, car…). */
  profile: Bag.default({}),
});
export type PlayerInfo = z.infer<typeof PlayerInfo>;
/** What a client sends: `profile` may be left out (the hub fills in `{}`). */
export type PlayerInfoInput = z.input<typeof PlayerInfo>;

export const LobbyPlayer = PlayerInfo.extend({
  ready: z.boolean(),
  host: z.boolean(),
  /** Their connection to the hub dropped; the seat is held for the grace period (`lobbyWelcome.graceSeconds`). */
  away: z.boolean().optional(),
  /** While the room is `preparing`: has this player reported ready yet? */
  prep: z.enum(['pending', 'ready']).optional(),
});
export type LobbyPlayer = z.infer<typeof LobbyPlayer>;

export const Visibility = z.enum(['public', 'private']);

/** Why a player cannot start (sent by that player in `lobbyPrepared`). */
export const PrepareFailReason = z.enum(['no_controller', 'load_failed', 'hidden', 'other']);
export type PrepareFailReason = z.infer<typeof PrepareFailReason>;
/** Why a start was called off (in `lobbyAbort`): a player's reason, or one the hub found itself. */
export const AbortReason = z.enum([
  ...PrepareFailReason.options,
  'timeout',
  'away',
  'left',
  'cancelled',
]);
export type AbortReason = z.infer<typeof AbortReason>;
/** `lobby` (players gather), `preparing` (everyone loads and reports), `racing` (go was sent). */
export const RoomPhase = z.enum(['lobby', 'preparing', 'racing']);
export type RoomPhase = z.infer<typeof RoomPhase>;
export type Visibility = z.infer<typeof Visibility>;

export const RoomSummary = z.object({
  code: RoomCode,
  name: z.string().min(1).max(60),
  hostId: z.string(),
  hostName: z.string(),
  visibility: Visibility,
  /** Game-defined room rules (track, laps, mode…). */
  settings: Bag,
  maxPlayers: z.number().int().min(2),
  playerCount: z.number().int().min(0),
  /** The host pressed start (preparing or racing); late joiners are refused. */
  started: z.boolean(),
  phase: RoomPhase,
  /**
   * An unstarted room closes when nobody does anything for this long; this is the time left as of
   * this message (every join, leave, ready or reopen resets it). Absent once started.
   */
  closesInSeconds: z.number().int().min(0).optional(),
});
export type RoomSummary = z.infer<typeof RoomSummary>;

export const IceServer = z.object({
  urls: z.union([z.string(), z.array(z.string())]),
  username: z.string().optional(),
  credential: z.string().optional(),
});
export type IceServer = z.infer<typeof IceServer>;

// ── Client → hub ─────────────────────────────────────────────────────────────

export const LobbyHello = z.object({
  type: z.literal('lobbyHello'),
  v: z.number().int(),
  game: GameId,
  player: PlayerInfo,
});
export const LobbyList = z.object({ type: z.literal('lobbyList') });
export const LobbyCreate = z.object({
  type: z.literal('lobbyCreate'),
  name: z.string().min(1).max(60),
  visibility: Visibility,
  settings: Bag,
  /** Clamped to the game's cap by the hub. */
  maxPlayers: z.number().int().min(2).max(64),
});
export const LobbyJoin = z.object({ type: z.literal('lobbyJoin'), code: RoomCode });
export const LobbyLeave = z.object({ type: z.literal('lobbyLeave') });
export const LobbyReady = z.object({ type: z.literal('lobbyReady'), ready: z.boolean() });
/** Host only: begin starting the match (the hub answers with `lobbyPrepare` to everyone). */
export const LobbyStart = z.object({ type: z.literal('lobbyStart') });
/** Your answer to `lobbyPrepare`: ready to race, or why not (the start is then called off for all). */
export const LobbyPrepared = z.object({
  type: z.literal('lobbyPrepared'),
  ok: z.boolean(),
  reason: PrepareFailReason.optional(),
});
/** Host only: call off a start while everyone is still preparing. */
export const LobbyCancel = z.object({ type: z.literal('lobbyCancel') });
/**
 * Host only: take a started room back to the lobby (a rematch). Clears `started` and every ready
 * flag, so the room can take late joiners again. Without it a room stays "started" until it empties.
 */
export const LobbyReopen = z.object({ type: z.literal('lobbyReopen') });
/** Opaque relay of one WebRTC SDP offer/answer or ICE candidate to another member of your room. */
export const LobbySignal = z.object({
  type: z.literal('lobbySignal'),
  to: z.string(),
  data: z.unknown(),
});

/**
 * While waiting in the admission queue: move up (once per connection, by `BOOST_PLACES`). A game offers it as a
 * reward (for example after a rewarded ad); the hub cannot verify why it was sent, so it is capped at once.
 */
export const LobbyBoost = z.object({ type: z.literal('lobbyBoost') });
export const BOOST_PLACES = 10;

export const ClientMessage = z.discriminatedUnion('type', [
  LobbyHello,
  LobbyList,
  LobbyCreate,
  LobbyJoin,
  LobbyLeave,
  LobbyReady,
  LobbyStart,
  LobbyPrepared,
  LobbyCancel,
  LobbyReopen,
  LobbySignal,
  LobbyBoost,
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// ── Hub → client ─────────────────────────────────────────────────────────────

export const LobbyWelcome = z.object({
  type: z.literal('lobbyWelcome'),
  you: z.string(),
  /** Pass straight to `new RTCPeerConnection({ iceServers })`. TURN credentials are short-lived. */
  iceServers: z.array(IceServer),
  /** How long the hub holds your seat after your connection drops, so the UI can count down. */
  graceSeconds: z.number().int().min(0).optional(),
});
/**
 * The hub is full: you are in line and will be admitted in order (a `lobbyWelcome` follows when it is your turn).
 * Sent when you join the line and every few seconds after.
 */
export const LobbyQueued = z.object({
  type: z.literal('lobbyQueued'),
  /** 1 = next in. */
  position: z.number().int().min(1),
  /** People in line. */
  size: z.number().int().min(1),
  /** A rough wait, seconds. */
  etaSeconds: z.number().int().min(0),
  /** True once the boost has been used. */
  boosted: z.boolean(),
});
export const LobbyListResult = z.object({
  type: z.literal('lobbyListResult'),
  rooms: z.array(RoomSummary),
});
/** Full state of the room you're in; sent on every join/leave/ready-toggle. */
export const LobbyRoomState = z.object({
  type: z.literal('lobbyRoomState'),
  room: RoomSummary,
  players: z.array(LobbyPlayer),
});
/** The host started the match: load the track, check your controller and window, then answer `lobbyPrepared`. */
export const LobbyPrepare = z.object({
  type: z.literal('lobbyPrepare'),
  /** Answer within this long or the start is called off. */
  timeoutMs: z.number().int().positive(),
});
/**
 * Everyone is ready: your lights go green `startInMs` after you receive this. A duration, not a clock
 * time (clients' clocks differ); the hub already took off half this connection's round trip, so every
 * player's deadline lands at the same real instant.
 */
export const LobbyGo = z.object({
  type: z.literal('lobbyGo'),
  hostId: z.string(),
  startInMs: z.number().int().min(0),
});
/** The start was called off for everybody; `who`/`name` is the player the reason is about ('' if none). */
export const LobbyAbort = z.object({
  type: z.literal('lobbyAbort'),
  who: z.string(),
  name: z.string(),
  reason: AbortReason,
});
/**
 * You are no longer in your room: the hub closed it (idle, or past its maximum life), or you were
 * disconnected longer than the grace period. You stay connected.
 */
export const LobbyClosed = z.object({
  type: z.literal('lobbyClosed'),
  reason: z.enum(['idle', 'expired', 'disconnected']),
});
export const LobbySignalRelay = z.object({
  type: z.literal('lobbySignal'),
  from: z.string(),
  data: z.unknown(),
});
export const LobbyErrorCode = z.enum([
  'room_not_found',
  'room_full',
  'room_started',
  'bad_version',
  'bad_message',
  'not_host',
  'unknown_game',
  'forbidden_origin',
  'bad_settings',
  'rate_limited',
  /** The hub is at capacity (too many rooms); try again later. */
  'server_busy',
]);
export type LobbyErrorCode = z.infer<typeof LobbyErrorCode>;
export const LobbyError = z.object({
  type: z.literal('lobbyError'),
  code: LobbyErrorCode,
  message: z.string(),
});

export const ServerMessage = z.discriminatedUnion('type', [
  LobbyWelcome,
  LobbyQueued,
  LobbyListResult,
  LobbyRoomState,
  LobbyPrepare,
  LobbyGo,
  LobbyAbort,
  LobbyClosed,
  LobbySignalRelay,
  LobbyError,
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

/** Cheap `type` peek without full validation. */
export function peekType(text: string): string | null {
  const m = /^\s*\{\s*"type"\s*:\s*"([a-zA-Z]+)"/.exec(text);
  return m ? m[1]! : null;
}
