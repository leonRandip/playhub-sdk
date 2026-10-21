import { afterEach, expect, test } from 'vitest';
import type { ClientMessageInput, RoomSummary } from '@playhub/protocol';
import { HubClient } from '../src/hub-client.ts';
import type { Link, PeerLinkState } from '../src/peer-link.ts';
import {
  CLOSE_PROTOCOL,
  WebSocketTransport,
  type SignalingConnection,
  type SignalingEvents,
  type SignalingTransport,
  type SocketLike,
} from '../src/signaling.ts';

class FakeLink implements Link {
  state: PeerLinkState = 'connecting';
  onState: (s: PeerLinkState) => void = () => {};
  onMessage: (d: string) => void = () => {};
  onSignal: (d: unknown) => void = () => {};
  async start() {}
  async onSignalReceived() {}
  send() {}
  close() {}
}

/** One connection attempt of the scripted transport: the test plays the authority. */
class FakeConnection implements SignalingConnection {
  isOpen = false;
  sent: ClientMessageInput[] = [];
  constructor(readonly events: SignalingEvents) {}
  send(msg: ClientMessageInput) {
    if (this.isOpen) this.sent.push(msg);
  }
  close() {
    this.drop(false);
  }
  /** The authority answers. */
  reply(msg: object) {
    this.events.onMessage(msg);
  }
  drop(fatal: boolean) {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.events.onClose({ fatal });
  }
}

/** A transport with no network at all: proves HubClient needs nothing but the three calls. */
class ScriptedTransport implements SignalingTransport {
  readonly name = 'scripted';
  attempts: FakeConnection[] = [];
  open(events: SignalingEvents) {
    const c = new FakeConnection(events);
    this.attempts.push(c);
    queueMicrotask(() => {
      c.isOpen = true;
      events.onOpen();
    });
    return c;
  }
  get last() {
    return this.attempts.at(-1)!;
  }
}

const SUMMARY: RoomSummary = {
  code: 'ABCDEF',
  name: 'fun',
  hostName: 'A',
  hostId: 'a',
  playerCount: 1,
  maxPlayers: 4,
  visibility: 'public',
  started: false,
  phase: 'lobby',
  settings: {},
};
const ROOM_STATE = {
  type: 'lobbyRoomState',
  room: SUMMARY,
  players: [{ id: 'a', name: 'A', profile: {}, ready: false, host: true }],
};
const WELCOME = { type: 'lobbyWelcome', you: 'a', iceServers: [], graceSeconds: 30 };

const clients: HubClient[] = [];
afterEach(() => clients.splice(0).forEach((c) => c.close()));

function client(transport: SignalingTransport) {
  const c = new HubClient({
    transport,
    game: 'demo',
    player: () => ({ id: 'a', name: 'A' }),
    createLink: () => new FakeLink(),
    requestTimeoutMs: 1000,
  });
  clients.push(c);
  return c;
}

async function until(pred: () => boolean, ms = 2000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('a custom transport: hello on open, connected on welcome, create resolves on the room state', async () => {
  const t = new ScriptedTransport();
  const c = client(t);
  await until(() => t.last.sent.length === 1);
  expect(t.last.sent[0]).toMatchObject({ type: 'lobbyHello', game: 'demo', player: { id: 'a' } });

  t.last.reply(WELCOME);
  expect(c.connected).toBe(true);

  const created = c.create({ name: 'fun', visibility: 'public', settings: {}, maxPlayers: 4 });
  expect(t.last.sent[1]).toMatchObject({ type: 'lobbyCreate', name: 'fun' });
  t.last.reply(ROOM_STATE);
  expect((await created).code).toBe('ABCDEF');
  expect(c.room?.hosting).toBe(true);

  c.room!.setReady(true); // LiveRoom's lobby messages go through the same transport
  expect(t.last.sent.at(-1)).toEqual({ type: 'lobbyReady', ready: true });
});

test('a dropped connection reconnects through the transport and asks for the same room again', async () => {
  const t = new ScriptedTransport();
  const c = client(t);
  await until(() => t.last.isOpen);
  t.last.reply(WELCOME);
  const created = c.create({ name: 'fun', visibility: 'public', settings: {}, maxPlayers: 4 });
  t.last.reply(ROOM_STATE);
  await created;

  t.last.drop(false);
  expect(c.connected).toBe(false);
  expect(c.room).not.toBeNull(); // held for the grace period
  expect(c.reconnectSecondsLeft).toBe(30);

  await until(() => t.attempts.length === 2 && t.last.isOpen);
  t.last.reply(WELCOME);
  expect(t.last.sent.map((m) => m.type)).toEqual(['lobbyHello', 'lobbyJoin']);
  expect(t.last.sent[1]).toEqual({ type: 'lobbyJoin', code: 'ABCDEF' });
  t.last.reply(ROOM_STATE);
  expect(c.reconnectSecondsLeft).toBeNull();
});

test('a fatal close is final: no retry, and the refusal stays readable', async () => {
  const t = new ScriptedTransport();
  const c = client(t);
  await until(() => t.last.isOpen);
  t.last.reply({ type: 'lobbyError', code: 'unknown_game', message: 'no such game' });
  t.last.drop(true);
  await new Promise((r) => setTimeout(r, 400)); // longer than the first backoff step
  expect(t.attempts).toHaveLength(1);
  expect(c.fatalError?.code).toBe('unknown_game');
  await expect(c.list()).resolves.toEqual([]);
  await expect(
    c.create({ name: 'x', visibility: 'public', settings: {}, maxPlayers: 2 }),
  ).rejects.toMatchObject({ code: 'unknown_game' });
});

// ── WebSocketTransport ──────────────────────────────────────────────────────────────────────────

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code?: number }) => void) | null = null;
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.closed = true;
  }
}

function wsTransport() {
  const sockets: { url: string; s: FakeSocket }[] = [];
  const t = new WebSocketTransport({
    url: 'wss://hub.example/v1/lobby',
    socket: (url) => {
      const s = new FakeSocket();
      sockets.push({ url, s });
      return s;
    },
  });
  const got: unknown[] = [];
  const closes: boolean[] = [];
  let opened = 0;
  const conn = t.open({
    onOpen: () => opened++,
    onMessage: (m) => got.push(m),
    onClose: ({ fatal }) => closes.push(fatal),
  });
  return { conn, sockets, got, closes, opened: () => opened };
}

test('WebSocketTransport: JSON both ways, sends only while open, drops frames that are not JSON', () => {
  const { conn, sockets, got, opened } = wsTransport();
  const s = sockets[0]!.s;
  expect(sockets[0]!.url).toBe('wss://hub.example/v1/lobby');

  conn.send({ type: 'lobbyList' }); // not open yet
  expect(s.sent).toEqual([]);
  expect(conn.isOpen).toBe(false);

  s.readyState = 1;
  s.onopen?.({});
  expect(opened()).toBe(1);
  expect(conn.isOpen).toBe(true);
  conn.send({ type: 'lobbyList' });
  expect(s.sent).toEqual(['{"type":"lobbyList"}']);

  s.onmessage?.({ data: '{"type":"lobbyListResult","rooms":[]}' });
  s.onmessage?.({ data: 'not json' });
  expect(got).toEqual([{ type: 'lobbyListResult', rooms: [] }]);

  conn.close();
  expect(s.closed).toBe(true);
});

test('WebSocketTransport: the protocol close code is fatal, any other close is not', () => {
  const a = wsTransport();
  a.sockets[0]!.s.onclose?.({ code: CLOSE_PROTOCOL });
  expect(a.closes).toEqual([true]);

  const b = wsTransport();
  b.sockets[0]!.s.onclose?.({ code: 1006 });
  b.sockets[0]!.s.onclose?.({});
  expect(b.closes).toEqual([false, false]);
});
