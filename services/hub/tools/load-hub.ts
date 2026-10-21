/** The hub as the load test runs it: a child process (so its memory is its own), with limits that suit one machine playing many clients. */
import { buildServer } from '../src/server.ts';
import { parseGames } from '../src/games.ts';

const env = process.env;
const app = await buildServer({
  games: parseGames([{ id: 'load', maxPlayers: 8 }]),
  maxActive: Number(env['MAX_ACTIVE'] ?? 400),
  maxQueue: Number(env['MAX_QUEUE'] ?? 1000),
  maxConnectionsPerIp: 1_000_000,
  maxConnections: 100_000,
  idleKickMs: 3_600_000,
  limits: { maxRoomsPerIp: 1_000_000, maxRoomsPerGame: 1_000_000, failedJoinsPerMinute: 1_000_000 },
});
await app.listen({ host: '127.0.0.1', port: Number(env['PORT'] ?? 8099) });
console.log('ready');
