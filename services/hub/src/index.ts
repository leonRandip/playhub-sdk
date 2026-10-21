#!/usr/bin/env node
import { loadConfig } from './config.ts';
import { buildServer } from './server.ts';

const cfg = loadConfig(process.env, (m) => console.error(m));
const app = await buildServer({
  games: cfg.games,
  turn: cfg.turn,
  maxConnectionsPerIp: cfg.maxConnectionsPerIp,
  maxActive: cfg.maxActive,
  maxQueue: cfg.maxQueue,
  logger: true,
});
await app.listen({ host: '0.0.0.0', port: cfg.port });
app.log.info(`playhub hub up: games=[${[...cfg.games.keys()].join(', ')}] turn=${cfg.turn.name}`);
