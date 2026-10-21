/**
 * playhub on Cloudflare: a Worker that routes `/v1/lobby` WebSocket upgrades to a Durable Object,
 * and the Durable Object (`PlayhubHub`) that runs the same `Registry` and `Gateway` as the Node hub.
 * Clients connect exactly as they would to a self-hosted hub (`new HubClient({ url, ... })`).
 *
 * Instances: one Durable Object holds every game, like one server does. Add `?game=<id>` to the URL
 * and that game gets an object of its own (rooms, codes and listings never cross games anyway, so
 * splitting changes nothing for players and spreads the load).
 *
 * Deploy it as is (`wrangler.toml` in this package), or export `PlayhubHub` and call
 * `handleLobbyRequest` from a Worker of your own.
 */
import { DurableObject } from 'cloudflare:workers';
import { createTurnProvider, Gateway, parseGames, Registry, type Sock } from '@playhub/hub/core';

export interface Env {
  /** The Durable Object namespace bound to `PlayhubHub`. */
  PLAYHUB: DurableObjectNamespace<PlayhubHub>;
  /** The games: the contents of a `games.json` (a JSON string, or an array in `[vars]`). */
  GAMES: string | unknown[];
  /** none | cloudflare | coturn | static, and that provider's settings (see the hub's .env.example). */
  TURN_PROVIDER?: string;
  CLOUDFLARE_TURN_KEY_ID?: string;
  CLOUDFLARE_TURN_API_TOKEN?: string;
  TURN_TTL_SECONDS?: string;
  TURN_HOST?: string;
  TURN_SECRET?: string;
  TURN_STATIC_JSON?: string;
  MAX_CONNECTIONS_PER_IP?: string;
  MAX_ACTIVE?: string;
  MAX_QUEUE?: string;
}

/** The hub's own cap on one frame (the Node hub's `maxPayload`). */
const MAX_FRAME = 32 * 1024;
const CLOSE_TOO_BIG = 1009;
const LOBBY_PATH = '/v1/lobby';
const DEFAULT_INSTANCE = 'hub';

const num = (v: string | undefined) => (v === undefined || v === '' ? undefined : Number(v));

/**
 * One hub. It keeps its rooms in memory, like the Node hub, and uses ordinary (not hibernatable)
 * WebSockets: the object stays in memory while anyone is connected, so rooms and held seats live
 * exactly as long as they would on a server. When the last connection goes, Cloudflare may evict
 * it, and with it any seat still held for a player who dropped.
 */
export class PlayhubHub extends DurableObject<Env> {
  private readonly gateway: Gateway;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const games = parseGames(typeof env.GAMES === 'string' ? JSON.parse(env.GAMES) : env.GAMES);
    if (games.size === 0) throw new Error('GAMES lists no games');
    const registry = new Registry({
      games,
      turn: createTurnProvider(env as unknown as Record<string, string | undefined>, {
        log: (m) => console.warn(m),
      }),
      log: (m) => console.log(m),
    });
    this.gateway = new Gateway({
      registry,
      maxConnectionsPerIp: num(env.MAX_CONNECTIONS_PER_IP),
      maxActive: num(env.MAX_ACTIVE),
      maxQueue: num(env.MAX_QUEUE),
    });
  }

  /** Counts for an operator (the Worker does not expose them publicly). */
  health() {
    return this.gateway.health();
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
      return new Response('expected a WebSocket upgrade', { status: 426 });

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    const sock: Sock = {
      send: (text) => {
        try {
          server.send(text);
        } catch {
          /* already closing */
        }
      },
      close: (code, reason) => {
        try {
          server.close(code ?? 1000, reason ?? '');
        } catch {
          /* already closed */
        }
      },
      origin: request.headers.get('Origin') ?? undefined,
      // Set by Cloudflare's edge; a client cannot forge it.
      ip: request.headers.get('CF-Connecting-IP') ?? '',
    };
    const session = this.gateway.accept(sock);
    if (session) {
      server.addEventListener('message', (e) => {
        if (typeof e.data !== 'string') return; // text frames only, like the Node hub
        if (e.data.length > MAX_FRAME) return sock.close(CLOSE_TOO_BIG, 'message too big');
        session.message(e.data);
      });
      server.addEventListener('close', () => {
        session.closed();
        sock.close(1000, ''); // complete the closing handshake
      });
      server.addEventListener('error', () => session.closed());
    }
    return new Response(null, { status: 101, webSocket: client });
  }
}

/**
 * Routes a lobby connection to its hub instance. Returns null for any other path, so it can sit in
 * a Worker that serves other things too.
 */
export async function handleLobbyRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== LOBBY_PATH) return null;
  const name = url.searchParams.get('game') || DEFAULT_INSTANCE;
  return env.PLAYHUB.get(env.PLAYHUB.idFromName(name)).fetch(request);
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    // Public: just "up". The counts are for the operator: `PlayhubHub.health()` over RPC.
    if (url.pathname === '/healthz') return Response.json({ ok: true });
    return (await handleLobbyRequest(request, env)) ?? new Response('not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
