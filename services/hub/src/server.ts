import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { Gateway, type GatewayOptions } from './gateway.ts';
import { type Limits, Registry, type Sock } from './registry.ts';
import type { GameConfig } from './games.ts';
import type { TurnProvider } from './turn.ts';

export interface HubRoutesOptions extends Omit<GatewayOptions, 'registry'> {
  games: Map<string, GameConfig>;
  turn?: TurnProvider | null;
  /** Room and rate limits (see `Limits`). */
  limits?: Partial<Limits>;
  /** Liveness ping interval; a socket silent for two intervals is dropped. */
  heartbeatMs?: number;
  registry?: Registry;
  /** WebSocket route. Default `/v1/lobby`. */
  path?: string;
  /** Health route, or null to leave it out. Default `/healthz`. */
  healthPath?: string | null;
}

export type ServerOptions = HubRoutesOptions & { logger?: boolean };

/**
 * Mounts the hub on an existing Fastify app (which must already have @fastify/websocket
 * registered). Lets a host application, e.g. a game's dev server, run the hub in-process.
 */
export function registerHub(app: FastifyInstance, opts: HubRoutesOptions): Registry {
  const registry =
    opts.registry ??
    new Registry({
      games: opts.games,
      turn: opts.turn,
      limits: opts.limits,
      log: (m) => app.log.info(m),
    });
  const gateway = new Gateway({ ...opts, registry });
  const heartbeatMs = opts.heartbeatMs ?? 10_000;

  // Public: just "up". The counts and game ids (which a stranger has no use for) are for callers on
  // the machine itself: the watchdog and an admin's curl, which reach the hub from 127.0.0.1.
  if (opts.healthPath !== null)
    app.get(opts.healthPath ?? '/healthz', async (req) => {
      const local = req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1';
      return local ? gateway.health() : { ok: true };
    });

  app.get(opts.path ?? '/v1/lobby', { websocket: true }, (socket, req) => {
    const sock: Sock = {
      send: (t: string) => socket.send(t),
      close: (c?: number, r?: string) => socket.close(c, r),
      origin: req.headers.origin,
      ip: req.ip,
    };
    const session = gateway.accept(sock);
    if (!session) return;

    // Round-trip time, measured from the same pings that detect dead sockets: the start handshake
    // uses it so every player's lights go green at the same real instant.
    let missed = 0;
    let pingSentAt = 0;
    const ping = () => {
      pingSentAt = Date.now();
      socket.ping();
    };
    socket.on('pong', () => {
      missed = 0;
      if (pingSentAt) sock.rttMs = Date.now() - pingSentAt;
    });
    ping(); // a first reading right away, not after a whole heartbeat
    const timer = setInterval(() => {
      if (++missed > 2) return socket.terminate();
      ping();
    }, heartbeatMs);

    socket.on('message', (data, isBinary) => {
      if (!isBinary) session.message(data.toString());
    });
    socket.on('close', () => {
      clearInterval(timer);
      session.closed();
    });
    socket.on('error', () => socket.terminate());
  });

  app.addHook('onClose', async () => gateway.dispose());
  return registry;
}

export async function buildServer(opts: ServerOptions): Promise<FastifyInstance> {
  // Behind Caddy: trust X-Forwarded-For so per-IP limits see the real client.
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: true });
  await app.register(fastifyWebsocket, { options: { maxPayload: 32 * 1024 } });
  registerHub(app, opts);
  return app;
}
