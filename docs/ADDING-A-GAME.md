# Adding a game

1. Add an entry to `games.json` on the server (and restart the hub: `docker compose restart hub`):

```json
{
  "id": "my-game",
  "name": "My Game",
  "origins": ["https://my-game.example.com"],
  "maxPlayers": 4,
  "settings": {
    "mode": { "type": "string", "enum": ["classic", "blitz"] },
    "rounds": { "type": "number", "integer": true, "min": 1, "max": 9 },
    "teams": { "type": "boolean", "optional": true }
  }
}
```

- `id`: lower-case slug; this is the namespace.
- `origins`: exact web origins allowed to connect (add `http://localhost:5173` for development).
  Empty list or `"*"` allows anything.
- `maxPlayers`: hard cap per room (2–64); clients may ask for less.
- `settings` (optional): checked when a room is created. Without it any JSON ≤2 KB is accepted.

2. In the game, connect with `game: "my-game"` and put your own data in `settings` (room rules) and
   `profile` (per-player cosmetics, ≤1 KB). The hub never reads them.
3. Use `iceServers` from `lobbyWelcome` for your `RTCPeerConnection`, and relay offer/answer/ICE with
   `lobbySignal`. The client SDK does this for you.
4. Decide your topology. `LiveRoom` builds a star: every member links to the room's host, which can
   run the authoritative simulation and send state with `broadcast` / `sendTo`.
