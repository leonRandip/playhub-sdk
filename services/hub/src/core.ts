/**
 * The hub without its HTTP server: the registry, the gateway in front of it, games, TURN providers
 * and the in-process transport. No Fastify, so it runs anywhere with WebSockets of its own (a
 * Cloudflare Durable Object, Deno, Bun). `createTurnProvider` and coturn credentials need
 * `node:crypto` (on Cloudflare: the `nodejs_compat` flag).
 */
export {
  CLOSE_PROTOCOL,
  DEFAULT_REGISTRY_LIMITS,
  Registry,
  type Limits,
  type RegistryOptions,
  type Sock,
} from './registry.ts';
export {
  CLOSE_BUSY,
  CLOSE_HELLO,
  CLOSE_RATE,
  Gateway,
  type GatewayOptions,
  type Session,
} from './gateway.ts';
export { parseGames, type GameConfig, type SettingSpec } from './games.ts';
export {
  CloudflareTurn,
  CoturnTurn,
  createTurnProvider,
  NoTurn,
  StaticTurn,
  type TurnProvider,
} from './turn.ts';
export {
  InProcessHub,
  InProcessTransport,
  type InProcessHubOptions,
  type InProcessTransportOptions,
} from './in-process.ts';
