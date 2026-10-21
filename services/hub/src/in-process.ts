/**
 * A hub with no network: `HubClient`s in the same process talk straight to a `Registry`. For tests,
 * local development, a game's own dev server, or local multiplayer on one machine.
 *
 *   const hub = new InProcessHub({ games: parseGames([{ id: 'my-game' }]) });
 *   const client = new HubClient({ transport: hub.transport(), game: 'my-game', player });
 *
 * Messages still go through JSON and arrive asynchronously (one microtask later, in order), as they
 * would over a socket, so code tested here behaves the same against a real hub. What lives in the
 * network layer (`server.ts`) does not apply: the admission line, per-connection and per-address
 * socket caps, the per-socket message budget, the hello timeout and heartbeats. Everything the
 * registry enforces does (rooms, limits, origins, code guessing, the reconnect grace period).
 *
 * `InProcessTransport` matches `SignalingTransport` from `@playhub/client` by shape, so this package
 * does not depend on the client.
 */
import type { ClientMessageInput } from '@playhub/protocol';
import { CLOSE_PROTOCOL, type Limits, Registry, type Sock } from './registry.ts';
import type { GameConfig } from './games.ts';
import type { TurnProvider } from './turn.ts';

export interface InProcessEvents {
  onOpen(): void;
  onMessage(msg: unknown): void;
  onClose(info: { fatal: boolean }): void;
}

export interface InProcessConnection {
  readonly isOpen: boolean;
  send(msg: ClientMessageInput): void;
  close(): void;
}

export interface InProcessTransportOptions {
  /** The web origin this client claims (checked against the game's `origins`). Default: none. */
  origin?: string;
  /** The address the registry's per-address limits see. Default: one of its own per transport. */
  ip?: string;
  /** Round-trip time the start handshake compensates for, ms. Default 0. */
  rttMs?: number;
}

let transports = 0;

/** One simulated device: every `open()` is a fresh connection from the same address. */
export class InProcessTransport {
  readonly name = 'in-process';
  private readonly ip: string;

  constructor(
    private readonly registry: Registry,
    private readonly opts: InProcessTransportOptions = {},
  ) {
    this.ip = opts.ip ?? `in-process:${++transports}`;
  }

  open(events: InProcessEvents): InProcessConnection {
    let open = false;
    let ended = false;
    const end = (fatal: boolean) => {
      if (ended) return;
      ended = true;
      open = false;
      this.registry.onClose(sock);
      events.onClose({ fatal });
    };
    const sock: Sock = {
      origin: this.opts.origin,
      ip: this.ip,
      rttMs: this.opts.rttMs ?? 0,
      // The registry → the client.
      send: (text) =>
        queueMicrotask(() => {
          if (!ended) events.onMessage(JSON.parse(text));
        }),
      // The registry hanging up (a protocol refusal is the only reason it does).
      close: (code) => queueMicrotask(() => end(code === CLOSE_PROTOCOL)),
    };
    queueMicrotask(() => {
      if (ended) return;
      open = true;
      events.onOpen();
    });
    const registry = this.registry;
    return {
      get isOpen() {
        return open;
      },
      send(msg) {
        if (!open) return;
        const text = JSON.stringify(msg);
        queueMicrotask(() => {
          if (!ended) registry.onMessage(sock, text);
        });
      },
      close() {
        open = false;
        queueMicrotask(() => end(false));
      },
    };
  }
}

export interface InProcessHubOptions {
  games: Map<string, GameConfig>;
  turn?: TurnProvider | null;
  limits?: Partial<Limits>;
  /** How often idle/expired rooms and lapsed grace periods are swept, ms. Default 1000. */
  sweepMs?: number;
  /** Use this registry instead of making one (games, turn and limits are then ignored). */
  registry?: Registry;
  log?: (msg: string) => void;
}

/** A registry plus the sweeping a server would do for it. */
export class InProcessHub {
  readonly registry: Registry;
  private readonly sweeper: ReturnType<typeof setInterval>;

  constructor(opts: InProcessHubOptions) {
    this.registry =
      opts.registry ??
      new Registry({ games: opts.games, turn: opts.turn, limits: opts.limits, log: opts.log });
    this.sweeper = setInterval(() => this.registry.sweep(), opts.sweepMs ?? 1000);
    (this.sweeper as { unref?: () => void }).unref?.();
  }

  /** A transport for one client (or one device: reuse it to keep the same address). */
  transport(opts?: InProcessTransportOptions): InProcessTransport {
    return new InProcessTransport(this.registry, opts);
  }

  /** Stops sweeping and forgets every room. Close the clients first. */
  dispose(): void {
    clearInterval(this.sweeper);
    this.registry.dispose();
  }
}
