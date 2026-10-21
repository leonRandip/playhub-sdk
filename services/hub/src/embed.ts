/** Public surface for hosts that embed the hub in their own Fastify server. */
export { buildServer, registerHub, type HubRoutesOptions, type ServerOptions } from './server.ts';
export { Registry, type Limits, type Sock } from './registry.ts';
export {
  InProcessHub,
  InProcessTransport,
  type InProcessHubOptions,
  type InProcessTransportOptions,
} from './in-process.ts';
export { parseGames, type GameConfig, type SettingSpec } from './games.ts';
export {
  CloudflareTurn,
  CoturnTurn,
  createTurnProvider,
  NoTurn,
  StaticTurn,
  type TurnProvider,
} from './turn.ts';
