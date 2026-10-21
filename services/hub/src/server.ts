import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { peekType } from '@playhub/protocol';
import { Admission } from './admission.ts';
import { type Limits, Registry } from './registry.ts';
import type { GameConfig } from './games.ts';
import type { TurnProvider } from './turn.ts';

export interface HubRoutesOptions {
  games: Map<string, GameConfig>;
  turn?: TurnProvider | null;
  /** Max simultaneous sockets per client IP. */
  maxConnectionsPerIp?: number;
  /** Max simultaneous sockets overall (a 1 GB VM holds a few thousand idle ones comfortably). */
  maxConnections?: number;
  /** Players served at once; the rest wait in a line (see `Admission`). Default 400: measure with `pnpm hub-load`. */
  maxActive?: number;
  /** People allowed to wait. Default 1000. */
  maxQueue?: number;
  /** While people wait, a player in no room who has been silent this long gives up their place, ms. Default 5 minutes. */
  idleKickMs?: number;
  /** A socket must say a valid `lobbyHello` within this long or it is dropped, ms. */
  helloTimeoutMs?: number;
  /** How often idle/expired rooms and lapsed grace periods are swept, ms (a second keeps the
   * 30 s grace period honest). */
  sweepMs?: number;
  /** Room and rate limits (see `Limits`). */
  limits?: Partial<Limits>;
  /** Per-socket message budget: sustained messages/second and burst size. */
  messagesPerSecond?: number;
  burst?: number;
  /** Liveness ping interval; a socket silent for two intervals is dropped. */
  heartbeatMs?: number;
  registry?: Registry;
  /** WebSocket route. Default `/v1/lobby`. */
  path?: string;
  /** Health route, or null to leave it out. Default `/healthz`. */
  healthPath?: string | null;
}

export type ServerOptions = HubRoutesOptions & { logger?: boolean };

const CLOSE_RATE = 4429;
const CLOSE_BUSY = 4503;
const CLOSE_HELLO = 4408;

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
  const heartbeatMs = opts.heartbeatMs ?? 10_000;
  const perIp = opts.maxConnectionsPerIp ?? 20;
  const rate = opts.messagesPerSecond ?? 40;
  const burst = opts.burst ?? 120;
  const maxConnections = opts.maxConnections ?? 1500;
  const admission = new Admission({
    registry,
    maxActive: opts.maxActive ?? 400,
    maxQueue: opts.maxQueue ?? 1000,
  });
  const helloTimeoutMs = opts.helloTimeoutMs ?? 10_000;
  const connections = new Map<string, number>();
  let total = 0;
  // Rooms nobody uses go away on their own.
  const sweeper = setInterval(() => registry.sweep(), opts.sweepMs ?? 1000);
  sweeper.unref();
  // The line moves as slots free up, and everyone waiting hears where they stand.
  const pump = setInterval(() => admission.pump(), 500);
  pump.unref();
  const live = new Map<{ send(t: string): void; close(c?: number, r?: string): void }, number>();
  const idleKickMs = opts.idleKickMs ?? 5 * 60_000;
  const notify = setInterval(() => {
    admission.notifyAll();
    // Someone is waiting: free the slots of players who are just sitting in a menu.
    if (admission.size > 0) {
      const t = Date.now();
      for (const [s, last] of live)
        if (t - last > idleKickMs && registry.isIdleInLobby(s as never))
          s.close(CLOSE_BUSY, 'idle');
    }
  }, 3000);
  notify.unref();

  // Public: just "up". The counts and game ids (which a stranger has no use for) are for callers on
  // the machine itself: the watchdog and an admin's curl, which reach the hub from 127.0.0.1.
  if (opts.healthPath !== null)
    app.get(opts.healthPath ?? '/healthz', async (req) => {
      const local = req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1';
      return local
        ? {
            ok: true,
            players: registry.playerCount,
            queued: admission.size,
            maxActive: opts.maxActive ?? 400,
            rooms: registry.roomCount,
            games: registry.stats(),
          }
        : { ok: true };
    });

  app.get(opts.path ?? '/v1/lobby', { websocket: true }, (socket, req) => {
    const ip = req.ip;
    const fromIp = (connections.get(ip) ?? 0) + 1;
    if (fromIp > perIp) return socket.close(CLOSE_BUSY, 'too many connections');
    if (total >= maxConnections) return socket.close(CLOSE_BUSY, 'server busy');
    connections.set(ip, fromIp);
    total++;

    const sock: {
      send(t: string): void;
      close(c?: number, r?: string): void;
      origin?: string;
      ip: string;
      rttMs?: number;
    } = {
      send: (t: string) => socket.send(t),
      close: (c?: number, r?: string) => socket.close(c, r),
      origin: req.headers.origin,
      ip,
    };
    live.set(sock, Date.now());
    // A connection that never says hello would otherwise sit there (answering pings) forever.
    const helloTimer = setTimeout(() => {
      if (!registry.hasClient(sock) && !admission.has(sock))
        socket.close(CLOSE_HELLO, 'hello_timeout');
    }, helloTimeoutMs);

    // Token bucket: `burst` messages up front, refilled at `rate` per second.
    let tokens = burst;
    let last = Date.now();
    let missed = 0;
    // Round-trip time, measured from the same pings that detect dead sockets: the start handshake
    // uses it so every player's lights go green at the same real instant.
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
      if (isBinary) return;
      const now = Date.now();
      tokens = Math.min(burst, tokens + ((now - last) / 1000) * rate);
      last = now;
      if (tokens < 1) return socket.close(CLOSE_RATE, 'rate_limited');
      tokens -= 1;
      const text = data.toString();
      live.set(sock, now);
      if (admission.has(sock)) {
        // Waiting in line: the only thing a player can do is use their boost.
        if (peekType(text) === 'lobbyBoost') admission.boost(sock);
        return;
      }
      if (!registry.hasClient(sock) && peekType(text) === 'lobbyHello') {
        const verdict = admission.offer(sock, text);
        if (verdict === 'queued') return;
        if (verdict === 'full') return socket.close(CLOSE_BUSY, 'queue full');
      }
      registry.onMessage(sock, text);
    });
    socket.on('close', () => {
      clearInterval(timer);
      clearTimeout(helloTimer);
      total--;
      const n = (connections.get(ip) ?? 1) - 1;
      if (n <= 0) connections.delete(ip);
      else connections.set(ip, n);
      live.delete(sock);
      admission.remove(sock);
      registry.onClose(sock);
      admission.pump(); // that slot may let the next in line in
    });
    socket.on('error', () => socket.terminate());
  });

  app.addHook('onClose', async () => {
    clearInterval(sweeper);
    clearInterval(pump);
    clearInterval(notify);
    registry.dispose();
  });
  return registry;
}

export async function buildServer(opts: ServerOptions): Promise<FastifyInstance> {
  // Behind Caddy: trust X-Forwarded-For so per-IP limits see the real client.
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: true });
  await app.register(fastifyWebsocket, { options: { maxPayload: 32 * 1024 } });
  registerHub(app, opts);
  return app;
}
