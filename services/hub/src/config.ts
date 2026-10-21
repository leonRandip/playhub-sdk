import { readFileSync } from 'node:fs';
import { parseGames, type GameConfig } from './games.ts';
import { createTurnProvider, type TurnProvider } from './turn.ts';

export interface HubConfig {
  port: number;
  games: Map<string, GameConfig>;
  turn: TurnProvider;
  /** Max simultaneous sockets per client IP. */
  maxConnectionsPerIp: number;
  /** Players served at once; the rest wait in line. */
  maxActive: number;
  maxQueue: number;
}

/** Reads configuration from the environment (see deploy/.env.example). */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  log: (msg: string) => void = () => {},
): HubConfig {
  const gamesFile = env['GAMES_FILE'] ?? 'games.json';
  const games = parseGames(JSON.parse(readFileSync(gamesFile, 'utf8')));
  if (games.size === 0) throw new Error(`${gamesFile} lists no games`);
  return {
    port: Number(env['PORT'] ?? 8080),
    games,
    turn: createTurnProvider(env, { log }),
    maxConnectionsPerIp: Number(env['MAX_CONNECTIONS_PER_IP'] ?? 20),
    maxActive: Number(env['MAX_ACTIVE'] ?? 400),
    maxQueue: Number(env['MAX_QUEUE'] ?? 1000),
  };
}
