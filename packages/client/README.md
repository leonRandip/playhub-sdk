# @playhub/client

Browser SDK for [playhub](https://github.com/leonRandip/playhub): connect to a playhub hub, list,
create and join rooms, ready up, start together, and talk to the other players over WebRTC data
channels.

```bash
npm install @playhub/client
```

```ts
import { HubClient } from '@playhub/client';

const hub = new HubClient({
  url: 'wss://play.example.com/v1/lobby',
  game: 'my-game',
  player: () => ({ id: myStablePlayerId, name: 'Ada' }),
});
const room = await hub.create({ name: 'Fun', visibility: 'public', settings: {}, maxPlayers: 4 });
```

- `HubClient`: the signaling connection. Reconnects with backoff and resumes your seat by player id.
- `LiveRoom` (`hub.room`): members, readiness, the synchronized start (`tick()` events) and the peer
  links: `sendToHost`, `broadcast`, `sendTo`, `onHostMessage`, `onClientMessage`.
- `PeerLink`: one WebRTC data channel. Pass your own `createLink` to swap it out (tests do).

See the [repository README](https://github.com/leonRandip/playhub#readme) for the full flow. MIT licensed.
