# @playhub/cloudflare

Run a [playhub](https://github.com/leonRandip/playhub) hub on Cloudflare instead of a server: a
Worker routes lobby connections to a Durable Object that runs the same registry and gateway as the
Node hub. Clients don't change; point `HubClient` at the Worker's URL.

```ts
new HubClient({ url: 'wss://playhub.<you>.workers.dev/v1/lobby', game: 'my-game', player });
```

## Deploy

1. Edit `wrangler.toml`: your games under `[vars] GAMES` (same format as `games.json`, see
   [ADDING-A-GAME](https://github.com/leonRandip/playhub/blob/main/docs/ADDING-A-GAME.md)) and
   `TURN_PROVIDER`.
2. Secrets with `wrangler secret put`, e.g. `CLOUDFLARE_TURN_KEY_ID` and
   `CLOUDFLARE_TURN_API_TOKEN` for `TURN_PROVIDER=cloudflare`.
3. `pnpm --filter @playhub/cloudflare deploy` (or `npx wrangler deploy` in this folder).

Durable Objects with SQLite storage are available on the Workers Free plan; check Cloudflare's
current limits and pricing for your traffic.

Or use it inside a Worker of your own:

```ts
import { handleLobbyRequest, PlayhubHub, type Env } from '@playhub/cloudflare';
export { PlayhubHub };
export default {
  async fetch(req: Request, env: Env) {
    return (await handleLobbyRequest(req, env)) ?? myOtherRoutes(req, env);
  },
};
```

## How it maps to the Node hub

| Node hub                              | Here                                                                  |
| ------------------------------------- | --------------------------------------------------------------------- |
| one server, one `Registry`            | one Durable Object (`hub`); `?game=<id>` gives a game its own         |
| Fastify WebSocket route `/v1/lobby`   | the Worker routes `/v1/lobby` to the object, which accepts the socket |
| `Gateway`: caps, message budget, line | the same `Gateway`                                                    |
| `X-Forwarded-For` behind Caddy        | `CF-Connecting-IP`                                                    |
| `.env`, `games.json`                  | `wrangler.toml` `[vars]` and secrets                                  |
| `/healthz` (counts from localhost)    | `/healthz` is `{ok:true}`; counts via `PlayhubHub.health()` (RPC)     |

## Differences to know

- **No round-trip measurement.** Workers can't send WebSocket pings, so the synchronized start
  doesn't subtract half of each player's round trip; countdowns can end a few tens of ms apart.
- **Rooms live in memory.** The object uses ordinary WebSockets (not hibernation), so it stays in
  memory while anyone is connected, and Cloudflare bills its duration for that time. Once the last
  connection closes it may be evicted, along with any seat still held for a player who dropped.
  Hibernation would need the registry's state persisted; that is future work.
- **Needs `nodejs_compat`**, for the `node:crypto` HMAC used by coturn credentials.
- **`@playhub/hub` is a dependency** (for `@playhub/hub/core`), so Fastify gets installed even
  though nothing here imports it.

## Develop

`pnpm --filter @playhub/cloudflare dev` runs it locally (`wrangler dev`). The tests start
`wrangler dev` with `test/wrangler.toml` and drive it with real `HubClient`s.

MIT licensed.
