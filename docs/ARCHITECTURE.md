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
