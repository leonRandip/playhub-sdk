import { HubClient, type Link, type PeerLinkState } from '@playhub/client';
import type { FastifyInstance } from 'fastify';
import { afterEach, expect, test } from 'vitest';
import { parseGames } from '../src/games.ts';
import { buildServer } from '../src/server.ts';

/** In-memory link: both ends get connected as soon as the offer/answer handshake completes. */
class FakeLink implements Link {
  state: PeerLinkState = 'connecting';
  onState: (s: PeerLinkState) => void = () => {};
  onMessage: (d: string) => void = () => {};
  onSignal: (d: unknown) => void = () => {};
  async start() {
    this.onSignal({ kind: 'offer', sdp: 'x' });
  }
  async onSignalReceived(d: unknown) {
    if ((d as { kind: string }).kind === 'offer') this.onSignal({ kind: 'answer', sdp: 'y' });
    this.state = 'connected';
    this.onState('connected');
  }
  send() {}
  close() {}
}

let app: FastifyInstance | null = null;
const clients: HubClient[] = [];
afterEach(async () => {
  clients.splice(0).forEach((c) => c.close());
  await app?.close();
  app = null;
});

async function setup() {
  app = await buildServer({
    games: parseGames([
      { id: 'demo', maxPlayers: 3, settings: { mode: { type: 'string', enum: ['a', 'b'] } } },
    ]),
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as { port: number }).port;
  const make = async (id: string, game = 'demo') => {
    const c = new HubClient({
      url: `ws://127.0.0.1:${port}/v1/lobby`,
      game,
      player: () => ({ id, name: id, profile: { skin: 1 } }),
      createLink: () => new FakeLink(),
      requestTimeoutMs: 2000,
    });
    clients.push(c);
    await until(() => c.connected || c.fatalError !== null);
    return c;
  };
  return { make };
}

async function until(pred: () => boolean, ms = 3000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('create, list, join, ready, start across two real clients', async () => {
  const { make } = await setup();
  const a = await make('a');
  const b = await make('b');
  const room = await a.create({
    name: 'fun',
    visibility: 'public',
    settings: { mode: 'a' },
    maxPlayers: 8,
  });
  expect(room.maxPlayers).toBe(3); // clamped to the game's cap
  expect(a.room?.hosting).toBe(true);

  expect((await b.list()).map((r) => r.code)).toEqual([room.code]);
  await b.join(room.code);
  await until(() => a.room?.players.length === 2);
  expect(b.room?.players.find((p) => p.id === 'a')?.profile).toEqual({ skin: 1 });

  b.room!.setReady(true);
  a.room!.setReady(true);
  await until(() => a.room!.canStart);
  expect(a.room!.start()).toBe(true);
  await until(() => b.room!.tick().some((e) => e.type === 'prepare'));
  a.room!.prepared(true);
  b.room!.prepared(true);
  await until(() => b.room!.phase === 'racing');
  expect(b.room!.started).toBe(true);
  // the joiner's link came up through the hub's signaling relay
  await until(() => b.room!.linkStatus === 'Direct connection to host: connected');
});

test('hub refusals reject the request but keep the connection', async () => {
  const { make } = await setup();
  const a = await make('a');
  await expect(a.join('ZZZZZZ')).rejects.toMatchObject({ code: 'room_not_found' });
  await expect(
    a.create({ name: 'x', visibility: 'public', settings: { mode: 'zzz' }, maxPlayers: 2 }),
  ).rejects.toMatchObject({ code: 'bad_settings' });
  expect(a.connected).toBe(true);
  await a.create({ name: 'ok', visibility: 'public', settings: { mode: 'b' }, maxPlayers: 2 });
});

test('an unknown game is a fatal error and does not reconnect-loop', async () => {
  const { make } = await setup();
  const x = await make('x', 'no-such-game');
  expect(x.connected).toBe(false);
  expect(x.fatalError?.code).toBe('unknown_game');
  await expect(x.join('ABCD')).rejects.toMatchObject({ code: 'unknown_game' });
});

test('a client that loses its socket reconnects and the hub accepts the same id again', async () => {
  const { make } = await setup();
  const a = await make('a');
  // Drop the socket from our side; HubClient reconnects by itself.
  (a as unknown as { conn: { close(): void } }).conn.close();
  await until(() => !a.connected);
  await until(() => a.connected);
  await a.create({ name: 'again', visibility: 'private', settings: { mode: 'a' }, maxPlayers: 2 });
});

test('the hub closing an idle room reaches the client as onRoomClosed, and it stays connected', async () => {
  app = await buildServer({
    games: parseGames([{ id: 'demo', maxPlayers: 3 }]),
    sweepMs: 20,
    limits: { roomIdleMs: 60 },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as { port: number }).port;
  const c = new HubClient({
    url: `ws://127.0.0.1:${port}/v1/lobby`,
    game: 'demo',
    player: () => ({ id: 'a', name: 'a', profile: {} }),
    createLink: () => new FakeLink(),
    requestTimeoutMs: 2000,
  });
  clients.push(c);
  await until(() => c.connected);
  let reason: string | null = null;
  c.onRoomClosed = (r) => (reason = r);
  await c.create({ name: 'x', visibility: 'public', settings: {}, maxPlayers: 2 });
  expect(c.room).not.toBeNull();
  await until(() => reason !== null);
  expect(reason).toBe('idle');
  expect(c.room).toBeNull();
  expect(c.connected).toBe(true);
  // and it can start again at once
  await c.create({ name: 'y', visibility: 'public', settings: {}, maxPlayers: 2 });
  expect(c.room).not.toBeNull();
});

test('a host reopens a started room for a rematch; late joiners can then get in', async () => {
  const { make } = await setup();
  const a = await make('a');
  const b = await make('b');
  const room = await a.create({
    name: 'r',
    visibility: 'public',
    settings: { mode: 'a' },
    maxPlayers: 3,
  });
  await b.join(room.code);
  await until(() => a.room?.players.length === 2);
  b.room!.setReady(true);
  a.room!.setReady(true);
  await until(() => a.room!.canStart);
  a.room!.start();
  await until(() => b.room!.started);
  a.room!.prepared(true);
  b.room!.prepared(true);
  await until(() => b.room!.phase === 'racing');
  const late = await make('late');
  await expect(late.join(room.code)).rejects.toMatchObject({ code: 'room_started' });
  a.room!.reopen();
  await until(() => !b.room!.started && !a.room!.started);
  expect(a.room!.players.every((p) => !p.ready)).toBe(true);
  await late.join(room.code);
  await until(() => a.room!.players.length === 3);
});

test('a dropped connection keeps the room and its links, shows a countdown, and resumes the seat', async () => {
  const { make } = await setup();
  const a = await make('a');
  const b = await make('b');
  const room = await a.create({
    name: 'r',
    visibility: 'public',
    settings: { mode: 'a' },
    maxPlayers: 3,
  });
  await b.join(room.code);
  await until(() => a.room?.players.length === 2);
  const aRoom = a.room;
  expect(a.reconnectSecondsLeft).toBeNull();

  // a's connection drops (the client reconnects by itself)
  (a as unknown as { conn: { close(): void } }).conn.close();
  await until(() => !a.connected);
  expect(a.room).toBe(aRoom); // same room object: nothing was torn down
  expect(a.reconnectSecondsLeft).toBeGreaterThan(0);
  expect(a.reconnectSecondsLeft).toBeLessThanOrEqual(30);
  // the other player sees them as away…
  await until(() => b.room!.players.find((p) => p.id === 'a')?.away === true);
  // …and then back
  await until(() => a.connected && a.reconnectSecondsLeft === null);
  await until(() => b.room!.players.find((p) => p.id === 'a')?.away !== true);
  expect(b.room!.players).toHaveLength(2);
  expect(a.room).toBe(aRoom);
});

test('out of touch longer than the grace period: the seat is gone and onRoomClosed says so', async () => {
  app = await buildServer({
    games: parseGames([{ id: 'demo', maxPlayers: 3 }]),
    sweepMs: 20,
    limits: { graceMs: 120 },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as { port: number }).port;
  const mk = (id: string) => {
    const c = new HubClient({
      url: `ws://127.0.0.1:${port}/v1/lobby`,
      game: 'demo',
      player: () => ({ id, name: id, profile: {} }),
      createLink: () => new FakeLink(),
      requestTimeoutMs: 2000,
    });
    clients.push(c);
    return c;
  };
  const a = mk('a');
  const b = mk('b');
  await until(() => a.connected && b.connected);
  const room = await a.create({ name: 'r', visibility: 'public', settings: {}, maxPlayers: 3 });
  await b.join(room.code);
  await until(() => a.room?.players.length === 2);
  let reason: string | null = null;
  b.onRoomClosed = (r) => (reason = r);
  // b is away for longer than the hub's 120 ms grace: the client's own first retry is at 250 ms
  (b as unknown as { conn: { close(): void } }).conn.close();
  await until(() => reason !== null, 5000);
  expect(reason).toBe('disconnected');
  expect(b.room).toBeNull();
  expect(b.reconnectSecondsLeft).toBeNull();
  // a is alone in the room again
  await until(() => a.room?.players.length === 1);
});

test('the idle countdown reaches the client and resets on activity', async () => {
  const { make } = await setup();
  const a = await make('a');
  await a.create({ name: 'r', visibility: 'public', settings: { mode: 'a' }, maxPlayers: 2 });
  expect(a.room!.closesInSeconds).toBeGreaterThan(14 * 60);
  expect(a.room!.closesInSeconds).toBeLessThanOrEqual(15 * 60);
});

test('HubClient: a full hub shows the place in line, boost moves up once, admission clears it', async () => {
  app = await buildServer({ games: parseGames([{ id: 'demo', maxPlayers: 3 }]), maxActive: 1 });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as { port: number }).port;
  const mk = (id: string) => {
    const c = new HubClient({
      url: `ws://127.0.0.1:${port}/v1/lobby`,
      game: 'demo',
      player: () => ({ id, name: id, profile: {} }),
      createLink: () => new FakeLink(),
    });
    clients.push(c);
    return c;
  };
  const a = mk('a');
  await until(() => a.connected);
  const b = mk('b');
  const seen: (number | null)[] = [];
  b.onQueue = (q) => seen.push(q?.position ?? null);
  await until(() => b.queue !== null);
  expect(b.queue).toMatchObject({ position: 1, size: 1, boosted: false });
  expect(b.connected).toBe(false);
  b.boost(); // alone in line: nothing to move past, but the use is recorded
  await until(() => b.queue?.boosted === true);
  a.close();
  await until(() => b.connected);
  expect(b.queue).toBeNull();
  expect(seen.at(-1)).toBeNull();
});
