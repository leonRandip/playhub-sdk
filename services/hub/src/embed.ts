/** Public surface for hosts that embed the hub in their own Fastify server. */
export { buildServer, registerHub, type HubRoutesOptions, type ServerOptions } from './server.ts';
export { Registry } from './registry.ts';
export { parseGames, type GameConfig, type SettingSpec } from './games.ts';
export {
  CloudflareTurn,
  CoturnTurn,
  createTurnProvider,
  NoTurn,
  StaticTurn,
  type TurnProvider,
} from './turn.ts';
