# @playhub/hub

The self-hosted server of [playhub](https://github.com/leonRandip/playhub): rooms, the WebRTC
signaling relay, TURN credentials and the game registry, for any number of web games on one small
server. It never sees match traffic; players talk peer-to-peer.

Run it:

```bash
GAMES_FILE=games.json npx @playhub/hub      # ws://localhost:8080/v1/lobby, GET /healthz
```

Or embed it in your own Fastify app:

```ts
import { buildServer, parseGames, createTurnProvider } from '@playhub/hub';

const app = await buildServer({
  games: parseGames([{ id: 'my-game', maxPlayers: 4 }]),
  turn: createTurnProvider(process.env), // TURN_PROVIDER=cloudflare|coturn|static|none
});
await app.listen({ port: 8080 });
```

`registerHub(app, options)` mounts it on an existing Fastify app that already has
`@fastify/websocket` registered. Configuration, limits and deployment:
[docs](https://github.com/leonRandip/playhub/tree/main/docs). MIT licensed.
