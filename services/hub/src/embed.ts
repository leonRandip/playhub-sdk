/** Public surface for hosts that run the hub, standalone or inside their own Fastify server. */
export * from './core.ts';
export { buildServer, registerHub, type HubRoutesOptions, type ServerOptions } from './server.ts';
