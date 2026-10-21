/**
 * How a `HubClient` reaches the lobby authority. The contract is the wire protocol itself
 * (`@playhub/protocol`): a transport carries `ClientMessage`s out and `ServerMessage`s back, and
 * knows nothing about rooms, queues or seats. Everything with meaning (the hello, pending requests,
 * the waiting line, the reconnect grace period, the `LiveRoom`) stays in `HubClient`, so a new
 * back end only has to move messages.
 *
 * - `WebSocketTransport`: a playhub hub (or anything speaking its protocol) at a `wss://` URL. The
 *   default.
 * - Others (a Cloudflare Durable Object running the registry, a hosted pub/sub with an elected
 *   authority, an in-process hub for tests) implement the same three calls.
 *
 * One `open()` is one connection attempt. `HubClient` owns retries: when a connection closes and
 * `fatal` is false, it waits and calls `open()` again.
 */
import type { ClientMessageInput } from '@playhub/protocol';

export interface SignalingEvents {
  /** The connection is up; `HubClient` sends its `lobbyHello` next. */
  onOpen(): void;
  /** One decoded message from the authority (not yet validated: `HubClient` reads it defensively). */
  onMessage(msg: unknown): void;
  /**
   * The connection is gone. `fatal` means the authority refused us for good (unknown game, wrong
   * origin, bad protocol version): retrying would only be refused again.
   */
  onClose(info: { fatal: boolean }): void;
}

export interface SignalingConnection {
  /** True while `send` delivers. */
  readonly isOpen: boolean;
  /** Sends one message; dropped silently while not open (the next welcome resynchronizes). */
  send(msg: ClientMessageInput): void;
  /** Closes this connection. `onClose` still follows. */
  close(): void;
}

export interface SignalingTransport {
  /** Short name for logs and debugging ("websocket"). */
  readonly name: string;
  /**
   * Starts one connection attempt. Events arrive on `events` until `onClose`, and never before
   * `open()` has returned (defer them, e.g. with `queueMicrotask`, if the back end is synchronous).
   */
  open(events: SignalingEvents): SignalingConnection;
}

// ── WebSocket (a playhub hub) ───────────────────────────────────────────────────────────────────

/** The hub closes with this code on a protocol-level refusal (bad game/origin/version). */
export const CLOSE_PROTOCOL = 4400;

/** The slice of the WebSocket API the transport uses (lets tests inject a fake). */
export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number }) => void) | null;
}
export type SocketFactory = (url: string) => SocketLike;

const OPEN = 1;

export interface WebSocketTransportOptions {
  /** wss://hub.example.com/v1/lobby */
  url: string;
  /** Defaults to `new WebSocket(url)`. */
  socket?: SocketFactory;
}

/** JSON text frames over one WebSocket per connection attempt. */
export class WebSocketTransport implements SignalingTransport {
  readonly name = 'websocket';

  constructor(private readonly opts: WebSocketTransportOptions) {}

  open(events: SignalingEvents): SignalingConnection {
    const ws = this.opts.socket
      ? this.opts.socket(this.opts.url)
      : (new WebSocket(this.opts.url) as unknown as SocketLike);
    ws.onopen = () => events.onOpen();
    ws.onmessage = (e) => {
      let msg: unknown;
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      events.onMessage(msg);
    };
    ws.onclose = (e) => events.onClose({ fatal: e.code === CLOSE_PROTOCOL });
    return {
      get isOpen() {
        return ws.readyState === OPEN;
      },
      send(msg) {
        if (ws.readyState === OPEN) ws.send(JSON.stringify(msg));
      },
      close() {
        ws.close();
      },
    };
  }
}
