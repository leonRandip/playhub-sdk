# Admission control, the waiting line and moderation

**Why:** a small VM must not slow down for everyone when it gets popular. The hub serves up to `MAX_ACTIVE` players at once (default 400, set from a load test) and puts the rest in a first-come, first-served line.

**How it works** (`services/hub/src/admission.ts`)

- A connection that says hello while the hub is full gets `lobbyQueued {position, size, etaSeconds, boosted}` now and every 3 s; when its turn comes the normal `lobbyWelcome` follows. `HubClient` exposes it as `client.queue` / `client.onQueue`.
- The line holds at most `MAX_QUEUE` (default 1000) people; beyond that the connection is refused with close code 4503.
- A player returning to a seat the hub is holding for them (inside the grace period) skips the line.
- A waiting player can send `lobbyBoost` once (`client.boost()`): it moves them up 10 places. The hub cannot tell why it was sent; the game offers it as a reward (a rewarded ad) and the once-per-connection cap limits abuse.
- While anyone is waiting, a player who sits in no room and has been silent for 5 minutes gives up their slot (`idleKickMs`).
- `/healthz` (from the machine itself) reports `players`, `queued`, `maxActive`, `rooms`.

**Allowed origins** accept `https://*.example.com` patterns (same scheme, any host ending in `.example.com`; not the bare domain, not look-alikes). Put the game portal's patterns in `games.json`.

**Moderation:** player names and room names go through `isProfane` (`packages/protocol/src/profanity.ts`: look-alike characters, separators, stretched letters; whole words for short or ambiguous ones, anywhere-in-the-name only for unambiguous ones, so "Cockpit" and "Scunthorpe" pass). A refused name is answered with `bad_message` and logged with the address. The game uses the same function on its side before sending.

**Sizing:** `pnpm hub-load` starts a fresh hub per level, connects that many simulated players, keeps them busy and writes `load-report/report.html` (charts), `results.csv` and `results.json`. Run it on a machine like your server for numbers you can trust.
