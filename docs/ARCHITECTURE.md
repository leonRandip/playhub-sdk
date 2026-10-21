# Architecture

```
 game page (https)                      one server                              game page (https)
┌──────────────────┐          ┌───────────────────────────┐              ┌──────────────────┐
│ client SDK       │─ wss ───▶│ Caddy ─▶ hub (Node)       │◀── wss ──────│ client SDK       │
│  OnlineClient    │          │   rooms · signaling relay │              │                  │
│  PeerLink ───────┼──── WebRTC data channel (direct) ───────────────────┼─ PeerLink        │
│                  │          │ coturn (relay if no path) │              │                  │
└──────────────────┘          └───────────────────────────┘              └──────────────────┘
```

## What the hub does and does not do

- **Does:** game registry (per-game origin allow-list, player cap, optional settings spec), rooms
  (public/private, 6-letter codes, ready, start, host migration), relay of WebRTC offer/answer/ICE
  between members of one room, short-lived TURN credentials, per-IP and per-socket rate limits,
  `/healthz`.
- **Does not:** run game logic, see match traffic, or interpret `settings`/`profile`. Those are opaque
  JSON (size-capped) that the game defines.

## Game namespace

Everything is keyed by `gameId`: rooms, room codes, listings. Two games can use the same code at the
same time and never see each other. A game is a row in `games.json`; no code change to add one.

## Wire protocol (`/v1/lobby`, `packages/protocol`)

Client → hub: `lobbyHello{v,game,player}` (first frame), `lobbyList`, `lobbyCreate{name,visibility,
settings,maxPlayers}`, `lobbyJoin{code}`, `lobbyLeave`, `lobbyReady`, `lobbyStart`, `lobbySignal{to,data}`.
Hub → client: `lobbyWelcome{you,iceServers}`, `lobbyListResult`, `lobbyRoomState`, `lobbyStarted`,
`lobbySignal{from,data}`, `lobbyError{code,message}`.

Errors: protocol faults (bad first frame, bad version, unknown game, wrong origin, rate limit) close
the socket; recoverable ones (`room_not_found`, `room_full`, `room_started`, `bad_settings`,
`not_host`) keep it open.

Reconnecting with the same player id resumes your seat; a stale socket closing later does not evict a
newer one.

## Signaling transports (`packages/client/src/signaling.ts`)

`HubClient` does not care how its messages travel. A `SignalingTransport` carries protocol messages
(`ClientMessage` out, `ServerMessage` back) and nothing else: one `open()` per connection attempt,
then `send`, `close` and three events (`onOpen`, `onMessage`, `onClose{fatal}`). The hello, pending
requests, the waiting line, the reconnect grace period and the `LiveRoom` all stay in `HubClient`,
so a new back end only moves messages. `HubClient` owns retries: a non-fatal close is retried with
backoff; a fatal one (refused for good) is not.

- `WebSocketTransport` (the default, from `url`): JSON text frames to a hub. Close code 4400 is fatal.
- `InProcessHub` / `InProcessTransport` (`@playhub/hub`): no network; clients in the same process
  talk straight to a `Registry`. Messages still go through JSON, one microtask later and in order.
  Each `hub.transport()` is one address for the per-address limits. The network layer's protections
  (admission line, socket caps, message budget, hello timeout, heartbeats) do not apply; everything
  the registry enforces does. The SDK tests run against both this and the WebSocket hub.

On the server side, `Gateway` (`services/hub/src/gateway.ts`) is everything between a raw
connection and the registry: connection caps, the hello timeout, the message budget, the admission
line and sweeping. The Fastify server and the Cloudflare Durable Object (`services/cloudflare`) both
feed sockets through it, so a hub on Cloudflare is protected the same way as one on a VM.
`@playhub/hub/core` exports it all without Fastify.

- Your own: pass `transport` instead of `url`.

```ts
const hub = new HubClient({ transport: myTransport, game: 'my-game', player: () => me });
```

What a back end has to provide depends on where the rules live. The hub enforces them (rate limits,
room caps, code guessing, admission, who is host), so a transport that reaches **a trusted
authority speaking the protocol** gets every feature: the hub over WebSocket, or the same registry
code running somewhere else (a Cloudflare Durable Object, an in-process hub). A transport over **a
plain relay** (a hosted pub/sub channel) has no trusted party, so it must elect one (for example the
room's host) to answer as the authority, and the server-side protections become best effort.

## TURN

The hub does not care where the relay comes from. A `TurnProvider` (`services/hub/src/turn.ts`)
returns the ICE servers that go into `lobbyWelcome`, chosen by `TURN_PROVIDER`:

- `cloudflare`: Cloudflare Realtime TURN. One API call mints credentials; one set is cached and shared
  by every player and refreshed at half its lifetime. The hub's server only does signaling.
- `coturn`: our own coturn in REST-credential mode. The hub signs `username = <expiry>:<id>` with the
  shared secret (HMAC-SHA1); credentials expire after `TURN_TTL_SECONDS`; coturn refuses to relay into
  private ranges.
- `static`: fixed credentials from any provider. `none`: STUN only.

A failing provider never blocks a join: after 4 s (or on any error) the welcome carries STUN only.
Only ~10–20 % of player pairs need a relay; the rest connect directly.

## Rooms: lifetime, limits and what the hub does about abuse

| What                    | Value                                                                                                                                                                                               | Why                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Idle room (not started) | closed after **15 min** without a join, leave, ready or reopen                                                                                                                                      | nobody is using it; clients get `closesInSeconds` and show a countdown |
| Started room            | closed after **1 h**                                                                                                                                                                                | matches are minutes; a rematch (`lobbyReopen`) restarts the clock      |
| Last player leaves      | room deleted at once                                                                                                                                                                                |                                                                        |
| Connection drops        | seat held **30 s** (`away`, `graceSeconds`); a returning player (same id) resumes it, otherwise they are removed. The client keeps its room and peer links alive meanwhile (`reconnectSecondsLeft`) | a flaky network must not cost anyone their room or match               |
| Room codes              | **6 letters** (23⁶ ≈ 148 million); joins accept 4–6                                                                                                                                                 | a private room is reachable only by its code                           |
| Wrong codes             | 10 per minute per address, then joins pause until the minute is up (the message says how long); a correct code is refused too, so the answer does not leak                                          | stops code guessing without locking anyone else out                    |
| Rooms                   | 500 per game, 5 per address; the list shows the 100 fullest                                                                                                                                         | the list is a display limit, not a capacity limit                      |
| Connections             | 20 per address, 1 500 overall; a socket must say hello within 10 s                                                                                                                                  | an idle socket is cheap, but not free                                  |
| Messages                | 40/s sustained, burst 120, 32 KB max; settings ≤ 2 KB, profile ≤ 1 KB                                                                                                                               |                                                                        |
| Heartbeat               | ping every 10 s, dropped after 2 missed                                                                                                                                                             | dead sockets do not linger                                             |

All of it is configurable (`Limits` in `registry.ts`, options on `buildServer` / `registerHub`).

## Limits and the free tier

coturn (when used): relay range 49160–49200 (≈20 simultaneous relayed sessions), per-user quota 12.
Cloudflare Realtime's free allowance is 1 000 GB/month of relay egress (shared with its SFU); with your
own coturn, relay traffic is your server's egress.

## Not built yet

Accounts (guest → account), Postgres, friends, leaderboards, matchmaking, host migration during a
match, a TURNS (TLS) listener.
