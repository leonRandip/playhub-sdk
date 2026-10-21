# playhub

Multiplayer for web games: **lobbies, ready-up, a synchronized start, WebRTC signaling and TURN
credentials**, self-hosted on one small server. Match traffic goes peer-to-peer over WebRTC data
channels; the hub only introduces players to each other, so it stays cheap to run (about 0.1 MB of
memory per connected player).

```
packages/protocol   @playhub/protocol   zod wire schemas shared by hub and clients
packages/client     @playhub/client     browser SDK: HubClient, LiveRoom, PeerLink
services/hub        @playhub/hub        the server: rooms, signaling relay, TURN creds, game registry
deploy/             docker compose (Caddy + hub, optional coturn)
docs/               architecture, adding a game, admission control, deploying
```

## What you get

- **Rooms:** public or private (6-letter codes), a public room list, ready-up, a new host when the host leaves the lobby.
- **A start everyone sees together:** `prepare` → everyone `prepared` → `go` with a lead time
  compensated for each player's round trip, so countdowns end at the same moment.
- **Peer links:** a star around the room's host (one referee, N links instead of N²), with link
  timeouts and reconnects.
- **Reconnects that keep your seat:** a dropped player has 30 s to come back to the same room.
- **TURN from anywhere:** Cloudflare Realtime, your own coturn, any static credentials, or STUN only.
  A failing provider never blocks a join.
- **Swappable signaling:** `HubClient` talks to the hub through a `SignalingTransport`. WebSocket is
  built in; any back end that can carry the protocol's messages can plug in.
- **Many games, one server:** each game is a row in `games.json` with its own allowed origins,
  player cap and optional settings schema.
- **Built for the open internet:** per-address connection and room caps, message budgets, a throttle
  on room-code guessing, a waiting line when the server is full, a profanity filter on names.

## Quick start

Run a hub locally:

```bash
pnpm install
cp deploy/games.example.json games.json
GAMES_FILE=games.json pnpm dev        # ws://localhost:8080/v1/lobby, GET /healthz
```

Or without cloning: `npx @playhub/hub` with `GAMES_FILE` pointing at your `games.json`.

Connect from a game:

```ts
import { HubClient } from '@playhub/client';

const hub = new HubClient({
  url: 'ws://localhost:8080/v1/lobby',
  game: 'my-game',
  player: () => ({ id: myStablePlayerId, name: 'Ada' }),
});

const room = await hub.create({
  name: 'Ada’s room',
  visibility: 'public',
  settings: { mode: 'classic' }, // checked against the game's spec in games.json, if it has one
  maxPlayers: 4, // clamped to the game's cap
});
// someone else: await hub.join(room.code)

hub.room?.setReady(true);
hub.room?.start(); // host only, once everyone is ready

// In your game loop:
for (const ev of hub.room?.tick() ?? []) {
  if (ev.type === 'prepare') hub.room?.prepared(true); // after loading the level
  if (ev.type === 'go') startCountdown(ev.startInMs);
}

// Game traffic is yours: the host is the referee.
hub.room!.onClientMessage = (from, msg) => {
  /* host receives inputs */
};
hub.room!.onHostMessage = (msg) => {
  /* clients receive state */
};
hub.room?.sendToHost({ input: 'left' });
hub.room?.broadcast({ state: snapshot }); // host
```

Embed the hub in your own Fastify server instead of running it separately:

```ts
import { buildServer, parseGames, createTurnProvider } from '@playhub/hub';

const app = await buildServer({
  games: parseGames([{ id: 'my-game', maxPlayers: 4 }]),
  turn: createTurnProvider(process.env),
});
await app.listen({ port: 8080 });
```

## Develop

```bash
pnpm install
pnpm typecheck
pnpm test          # protocol, client and hub (registry, games, TURN, real WebSocket tests)
pnpm build         # dist/ for each package
pnpm hub-load   # load test: writes load-report/
```

## Deploy

[docs/DEPLOY.md](docs/DEPLOY.md): Docker Compose on any Linux server with a domain. Caddy gets the
TLS certificate; the hub needs no open UDP ports unless you run your own coturn.

## Add a game

One entry in `games.json`. See [docs/ADDING-A-GAME.md](docs/ADDING-A-GAME.md).

## What playhub is not

- **Not an authoritative game server.** It never runs your game logic or sees match traffic. The
  room's host is the referee, so a player who controls the host can cheat. For competitive games
  that need cheat resistance, use a server-authoritative framework such as Colyseus.
- **Not a media server.** Data channels only; no voice or video routing.

## License

[MIT](LICENSE)
