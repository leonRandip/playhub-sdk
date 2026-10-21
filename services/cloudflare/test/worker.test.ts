/**
 * The Worker and its Durable Object, end to end: `wrangler dev` runs them in workerd (Cloudflare's
 * runtime) and real `HubClient`s talk to them over WebSocket, the same way they talk to the Node hub.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HubClient, type Link, type PeerLinkState } from '@playhub/client';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';

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

const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = `127.0.0.1:${PORT}`;
let wrangler: ChildProcess | null = null;
let output = '';

beforeAll(async () => {
  wrangler = spawn(
    'pnpm',
    [
      'exec',
      'wrangler',
      'dev',
      '-c',
      'test/wrangler.toml',
      '--port',
      String(PORT),
      '--ip',
      '127.0.0.1',
    ],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  wrangler.stdout?.on('data', (d) => (output += d));
  wrangler.stderr?.on('data', (d) => (output += d));
  const t0 = Date.now();
  while (true) {
    try {
      if ((await fetch(`http://${BASE}/healthz`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() - t0 > 60_000) throw new Error(`wrangler dev did not start:\n${output}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}, 90_000);

afterAll(() => {
  wrangler?.kill('SIGINT');
});

const clients: HubClient[] = [];
afterEach(() => clients.splice(0).forEach((c) => c.close()));

function client(id: string, game = 'demo', query = '') {
  const c = new HubClient({
    url: `ws://${BASE}/v1/lobby${query}`,
    game,
    player: () => ({ id, name: id, profile: { skin: 1 } }),
    createLink: () => new FakeLink(),
    requestTimeoutMs: 3000,
  });
  clients.push(c);
  return c;
}

async function until(pred: () => boolean, ms = 5000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('the Worker answers health publicly and refuses non-WebSocket lobby requests', async () => {
  expect(await (await fetch(`http://${BASE}/healthz`)).json()).toEqual({ ok: true });
  expect((await fetch(`http://${BASE}/v1/lobby`)).status).toBe(426);
  expect((await fetch(`http://${BASE}/elsewhere`)).status).toBe(404);
});

test('create, list, join, ready, start and the signaling relay, through the Durable Object', async () => {
  const a = client('a');
  const b = client('b');
  await until(() => a.connected && b.connected);
  const room = await a.create({
    name: 'fun',
    visibility: 'public',
    settings: { mode: 'a' },
    maxPlayers: 8,
  });
  expect(room.maxPlayers).toBe(3); // the registry clamps to the game's cap
  expect((await b.list()).map((r) => r.code)).toContain(room.code);
  await b.join(room.code);
  await until(() => a.room?.players.length === 2);
  expect(b.room?.players.find((p) => p.id === 'a')?.profile).toEqual({ skin: 1 });

  a.room!.setReady(true);
  b.room!.setReady(true);
  await until(() => a.room!.canStart);
  a.room!.start();
  await until(() => b.room!.tick().some((e) => e.type === 'prepare'));
  a.room!.prepared(true);
  b.room!.prepared(true);
  await until(() => b.room!.phase === 'racing');
  await until(() => b.room!.linkStatus === 'Direct connection to host: connected');
});

test('refusals: a bad setting keeps the connection, an unknown game is fatal', async () => {
  const a = client('r');
  await until(() => a.connected);
  await expect(
    a.create({ name: 'x', visibility: 'public', settings: { mode: 'zzz' }, maxPlayers: 2 }),
  ).rejects.toMatchObject({ code: 'bad_settings' });
  expect(a.connected).toBe(true);

  const x = client('x', 'no-such-game');
  await until(() => x.fatalError !== null);
  expect(x.fatalError?.code).toBe('unknown_game');
  expect(x.connected).toBe(false);
});

test('a dropped connection gets its seat back from the Durable Object', async () => {
  const a = client('s1');
  const b = client('s2');
  await until(() => a.connected && b.connected);
  const room = await a.create({
    name: 'r',
    visibility: 'private',
    settings: { mode: 'a' },
    maxPlayers: 3,
  });
  await b.join(room.code);
  await until(() => a.room?.players.length === 2);
  const bRoom = b.room;

  (b as unknown as { conn: { close(): void } }).conn.close();
  await until(() => a.room!.players.find((p) => p.id === 's2')?.away === true);
  await until(() => b.connected && b.reconnectSecondsLeft === null);
  expect(b.room).toBe(bRoom);
  await until(() => a.room!.players.find((p) => p.id === 's2')?.away !== true);
});

test('?game= gives a game its own Durable Object: rooms elsewhere are not listed', async () => {
  const shared = client('g1');
  const own = client('g2', 'demo', '?game=demo');
  await until(() => shared.connected && own.connected);
  const room = await shared.create({
    name: 'in the shared hub',
    visibility: 'public',
    settings: { mode: 'a' },
    maxPlayers: 2,
  });
  expect((await own.list()).map((r) => r.code)).not.toContain(room.code);
  await expect(own.join(room.code)).rejects.toMatchObject({ code: 'room_not_found' });
});

test('the gateway protects the Durable Object too: a flood of messages is cut off', async () => {
  const ws = new WebSocket(`ws://${BASE}/v1/lobby`);
  const closed = new Promise<number>((r) => ws.addEventListener('close', (e) => r(e.code)));
  await new Promise((r) => ws.addEventListener('open', r));
  ws.send(
    JSON.stringify({ type: 'lobbyHello', v: 2, game: 'demo', player: { id: 'flood', name: 'f' } }),
  );
  for (let i = 0; i < 200; i++) ws.send(JSON.stringify({ type: 'lobbyList' }));
  expect(await closed).toBe(4429); // rate_limited, after the burst of 120
});
