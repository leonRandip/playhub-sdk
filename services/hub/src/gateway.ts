import { peekType } from '@playhub/protocol';
import { Admission } from './admission.ts';
import type { Registry, Sock } from './registry.ts';

export interface GatewayOptions {
  registry: Registry;
  /** Max simultaneous connections per client address. */
  maxConnectionsPerIp?: number;
  /** Max simultaneous connections overall (a 1 GB VM holds a few thousand idle ones comfortably). */
  maxConnections?: number;
  /** Players served at once; the rest wait in a line (see `Admission`). Default 400: measure with `pnpm hub-load`. */
  maxActive?: number;
  /** People allowed to wait. Default 1000. */
  maxQueue?: number;
  /** While people wait, a player in no room who has been silent this long gives up their place, ms. Default 5 minutes. */
  idleKickMs?: number;
  /** A connection must say a valid `lobbyHello` within this long or it is dropped, ms. */
  helloTimeoutMs?: number;
  /** How often idle/expired rooms and lapsed grace periods are swept, ms (a second keeps the
   * 30 s grace period honest). */
  sweepMs?: number;
  /** Per-connection message budget: sustained messages/second and burst size. */
  messagesPerSecond?: number;
  burst?: number;
}

/** What the transport tells the gateway about one accepted connection. */
export interface Session {
  /** A text frame arrived. */
  message(text: string): void;
  /** The connection is gone (whoever closed it). */
  closed(): void;
}

export const CLOSE_RATE = 4429;
export const CLOSE_BUSY = 4503;
export const CLOSE_HELLO = 4408;

const unref = (t: ReturnType<typeof setInterval>) => (t as { unref?: () => void }).unref?.();

/**
 * Everything between a raw connection and the registry that does not depend on how connections
 * arrive: connection caps, the hello timeout, the per-connection message budget, the admission line
 * and its idle kick, and the periodic sweeping. The Fastify server and the Cloudflare Durable Object
 * both feed their sockets through one of these, so they protect the registry the same way.
 */
export class Gateway {
  readonly registry: Registry;
  readonly admission: Admission;
  private readonly perIp: number;
  private readonly maxConnections: number;
  private readonly maxActive: number;
  private readonly helloTimeoutMs: number;
  private readonly rate: number;
  private readonly burst: number;
  private readonly connections = new Map<string, number>();
  private total = 0;
  /** Accepted connections and when each last sent something. */
  private readonly live = new Map<Sock, number>();
  private readonly timers: ReturnType<typeof setInterval>[];

  constructor(opts: GatewayOptions) {
    this.registry = opts.registry;
    this.perIp = opts.maxConnectionsPerIp ?? 20;
    this.maxConnections = opts.maxConnections ?? 1500;
    this.maxActive = opts.maxActive ?? 400;
    this.helloTimeoutMs = opts.helloTimeoutMs ?? 10_000;
    this.rate = opts.messagesPerSecond ?? 40;
    this.burst = opts.burst ?? 120;
    this.admission = new Admission({
      registry: this.registry,
      maxActive: this.maxActive,
      maxQueue: opts.maxQueue ?? 1000,
    });
    const idleKickMs = opts.idleKickMs ?? 5 * 60_000;
    this.timers = [
      // Rooms nobody uses go away on their own.
      setInterval(() => this.registry.sweep(), opts.sweepMs ?? 1000),
      // The line moves as slots free up, and everyone waiting hears where they stand.
      setInterval(() => this.admission.pump(), 500),
      setInterval(() => {
        this.admission.notifyAll();
        // Someone is waiting: free the slots of players who are just sitting in a menu.
        if (this.admission.size > 0) {
          const t = Date.now();
          for (const [s, last] of this.live)
            if (t - last > idleKickMs && this.registry.isIdleInLobby(s))
              s.close(CLOSE_BUSY, 'idle');
        }
      }, 3000),
    ];
    this.timers.forEach(unref);
  }

  /** Counts for health checks (meant for the operator, not the public). */
  health() {
    return {
      ok: true as const,
      players: this.registry.playerCount,
      queued: this.admission.size,
      maxActive: this.maxActive,
      rooms: this.registry.roomCount,
      games: this.registry.stats(),
    };
  }

  /**
   * A new connection (`sock.ip` keys the per-address caps). Returns its session, or null when it is
   * refused, in which case it has already been closed with the reason.
   */
  accept(sock: Sock): Session | null {
    const ip = sock.ip ?? '';
    const fromIp = (this.connections.get(ip) ?? 0) + 1;
    if (fromIp > this.perIp) {
      sock.close(CLOSE_BUSY, 'too many connections');
      return null;
    }
    if (this.total >= this.maxConnections) {
      sock.close(CLOSE_BUSY, 'server busy');
      return null;
    }
    this.connections.set(ip, fromIp);
    this.total++;
    this.live.set(sock, Date.now());

    const { registry, admission } = this;
    // A connection that never says hello would otherwise sit there (answering pings) forever.
    const helloTimer = setTimeout(() => {
      if (!registry.hasClient(sock) && !admission.has(sock))
        sock.close(CLOSE_HELLO, 'hello_timeout');
    }, this.helloTimeoutMs);

    // Token bucket: `burst` messages up front, refilled at `rate` per second.
    let tokens = this.burst;
    let last = Date.now();
    let ended = false;
    return {
      message: (text) => {
        if (ended) return;
        const now = Date.now();
        tokens = Math.min(this.burst, tokens + ((now - last) / 1000) * this.rate);
        last = now;
        if (tokens < 1) return sock.close(CLOSE_RATE, 'rate_limited');
        tokens -= 1;
        this.live.set(sock, now);
        if (admission.has(sock)) {
          // Waiting in line: the only thing a player can do is use their boost.
          if (peekType(text) === 'lobbyBoost') admission.boost(sock);
          return;
        }
        if (!registry.hasClient(sock) && peekType(text) === 'lobbyHello') {
          const verdict = admission.offer(sock, text);
          if (verdict === 'queued') return;
          if (verdict === 'full') return sock.close(CLOSE_BUSY, 'queue full');
        }
        registry.onMessage(sock, text);
      },
      closed: () => {
        if (ended) return;
        ended = true;
        clearTimeout(helloTimer);
        this.total--;
        const n = (this.connections.get(ip) ?? 1) - 1;
        if (n <= 0) this.connections.delete(ip);
        else this.connections.set(ip, n);
        this.live.delete(sock);
        admission.remove(sock);
        registry.onClose(sock);
        admission.pump(); // that slot may let the next in line in
      },
    };
  }

  /** Stops the timers and forgets every room. */
  dispose(): void {
    this.timers.forEach(clearInterval);
    this.registry.dispose();
  }
}
