import { HubClient, type Link, type PeerLinkState, type SignalingTransport } from '@playhub/client';
import { afterEach, expect, test } from 'vitest';
import { parseGames } from '../src/games.ts';
import { InProcessHub } from '../src/in-process.ts';

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

let hub: InProcessHub | null = null;
const clients: HubClient[] = [];
afterEach(() => {
  clients.splice(0).forEach((c) => c.close());
  hub?.dispose();
  hub = null;
});

function start(opts: Partial<ConstructorParameters<typeof InProcessHub>[0]> = {}) {
  hub = new InProcessHub({ games: parseGames([{ id: 'demo', maxPlayers: 4 }]), ...opts });
  return hub;
}

function client(transport: SignalingTransport, id: string) {
  const c = new HubClient({
    transport,
    game: 'demo',
    player: () => ({ id, name: id }),
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

const tick = () => new Promise((r) => setTimeout(r, 0));

test('the transport behaves like a socket: asynchronous, in order, JSON objects, close reaches the registry', async () => {
  const h = start();
  const log: string[] = [];
  const got: unknown[] = [];
  const conn = h.transport().open({
    onOpen: () => log.push('open'),
    onMessage: (m) => got.push(m),
    onClose: ({ fatal }) => log.push(`close fatal=${fatal}`),
  });
  expect(log).toEqual([]); // nothing fires inside open()
  expect(conn.isOpen).toBe(false);
  conn.send({ type: 'lobbyList' }); // not open yet: dropped, as on a socket
  await tick();
  expect(log).toEqual(['open']);
  expect(conn.isOpen).toBe(true);

  conn.send({ type: 'lobbyHello', v: 2, game: 'demo', player: { id: 'a', name: 'A' } });
  expect(got).toEqual([]); // not delivered synchronously
  await tick();
  expect(got).toMatchObject([{ type: 'lobbyWelcome', you: 'a' }]);
  expect(h.registry.playerCount).toBe(1);

  // Several messages arrive in the order they were sent.
  conn.send({ type: 'lobbyCreate', name: 'r', visibility: 'public', settings: {}, maxPlayers: 2 });
  conn.send({ type: 'lobbyList' });
  await tick();
  expect(got.slice(1).map((m) => (m as { type: string }).type)).toEqual([
    'lobbyRoomState',
    'lobbyListResult',
  ]);

  conn.close();
  expect(conn.isOpen).toBe(false);
  await tick();
  expect(log).toEqual(['open', 'close fatal=false']);
  expect(h.registry.playerCount).toBe(0);
});

test('origins are checked: a wrong one is refused for good, an allowed one gets in', async () => {
  const h = start({
    games: parseGames([{ id: 'demo', origins: ['https://ok.example'] }]),
  });
  const bad = h.transport({ origin: 'https://evil.example' });
  let attempts = 0;
  const counting: SignalingTransport = {
    name: bad.name,
    open: (events) => (attempts++, bad.open(events)),
  };
  const x = client(counting, 'x');
  await until(() => x.fatalError !== null);
  expect(x.fatalError?.code).toBe('forbidden_origin');
  await new Promise((r) => setTimeout(r, 400)); // past the first reconnect backoff
  expect(attempts).toBe(1);

  const ok = client(h.transport({ origin: 'https://ok.example' }), 'ok');
  await until(() => ok.connected);
});

test('one transport is one address: per-address room caps count across its clients', async () => {
  const h = start({ limits: { maxRoomsPerIp: 1 } });
  const device = h.transport();
  const a = client(device, 'a');
  const b = client(device, 'b');
  const c = client(h.transport(), 'c');
  await until(() => a.connected && b.connected && c.connected);
  const create = (x: HubClient) =>
    x.create({ name: 'r', visibility: 'public', settings: {}, maxPlayers: 2 });
  await create(a);
  await expect(create(b)).rejects.toMatchObject({ code: 'rate_limited' });
  await create(c); // another device
});

test('rttMs feeds the synchronized start: the lights go green half a round trip earlier', async () => {
  const h = start({ limits: { startLeadMs: 2000 } });
  const a = client(h.transport({ rttMs: 200 }), 'a');
  const b = client(h.transport(), 'b');
  await until(() => a.connected && b.connected);
  const room = await a.create({ name: 'r', visibility: 'public', settings: {}, maxPlayers: 2 });
  await b.join(room.code);
  await until(() => a.room?.players.length === 2);
  a.room!.setReady(true);
  b.room!.setReady(true);
  await until(() => a.room!.canStart);
  a.room!.start();
  const go = new Map<string, number>();
  await until(() => {
    for (const [id, c] of [
      ['a', a],
      ['b', b],
    ] as const)
      for (const e of c.room!.tick()) {
        if (e.type === 'prepare') c.room!.prepared(true);
        if (e.type === 'go') go.set(id, e.startInMs);
      }
    return go.size === 2;
  });
  expect(go.get('a')).toBe(1900);
  expect(go.get('b')).toBe(2000);
});
