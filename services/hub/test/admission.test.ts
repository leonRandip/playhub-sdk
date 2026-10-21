import type { FastifyInstance } from 'fastify';
import { afterEach, expect, test } from 'vitest';
import WebSocket from 'ws';
import { originAllowed, originMatches, parseGames } from '../src/games.ts';
import { buildServer } from '../src/server.ts';

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

const games = () => parseGames([{ id: 'demo', maxPlayers: 4, origins: ['https://demo.example'] }]);
async function start(extra = {}) {
  app = await buildServer({ games: games(), ...extra });
  await app.listen({ port: 0, host: '127.0.0.1' });
  return (app.server.address() as { port: number }).port;
}
function open(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/lobby`, { origin: 'https://demo.example' });
  const got: Record<string, unknown>[] = [];
  const waiters: (() => void)[] = [];
  ws.on('message', (d) => {
    got.push(JSON.parse(d.toString()));
    waiters.splice(0).forEach((w) => w());
  });
  const closed = new Promise<number>((r) => ws.on('close', (c) => r(c)));
  const next = async (pred: (m: Record<string, unknown>) => boolean) => {
    for (;;) {
      const m = got.find(pred);
      if (m) return m;
      await new Promise<void>((r) => waiters.push(r));
    }
  };
  const opened = new Promise<void>((r) => ws.on('open', () => r()));
  return { ws, got, next, closed, opened };
}
const hello = (id: string) =>
  JSON.stringify({ type: 'lobbyHello', v: 2, game: 'demo', player: { id, name: id } });
const type = (t: string) => (m: Record<string, unknown>) => m['type'] === t;

test('a full hub puts newcomers in line, in order, and admits them as slots free up', async () => {
  const port = await start({ maxActive: 1 });
  const a = open(port);
  await a.opened;
  a.ws.send(hello('a'));
  await a.next(type('lobbyWelcome'));

  const b = open(port);
  const c = open(port);
  await Promise.all([b.opened, c.opened]);
  b.ws.send(hello('b'));
  const qb = await b.next(type('lobbyQueued'));
  expect(qb).toMatchObject({ position: 1, boosted: false });
  c.ws.send(hello('c'));
  const qc = await c.next(type('lobbyQueued'));
  expect(qc).toMatchObject({ position: 2, size: 2 });
  expect(b.got.some(type('lobbyWelcome'))).toBe(false);

  // the health route (local) shows the line
  const h = (await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()) as Record<
    string,
    number
  >;
  expect(h).toMatchObject({ players: 1, queued: 2, maxActive: 1 });

  a.ws.close(); // a slot frees: b is first
  await b.next(type('lobbyWelcome'));
  expect(c.got.some(type('lobbyWelcome'))).toBe(false);
  b.ws.close();
  await c.next(type('lobbyWelcome'));
});

test('a waiting player can boost once, up to ten places', async () => {
  const port = await start({ maxActive: 1 });
  const first = open(port);
  await first.opened;
  first.ws.send(hello('first'));
  await first.next(type('lobbyWelcome'));
  const line = [];
  for (let i = 0; i < 13; i++) {
    const s = open(port);
    await s.opened;
    s.ws.send(hello(`p${i}`));
    await s.next(type('lobbyQueued'));
    line.push(s);
  }
  const last = line[12]!;
  expect(last.got.filter(type('lobbyQueued')).at(-1)).toMatchObject({ position: 13 });
  last.ws.send(JSON.stringify({ type: 'lobbyBoost' }));
  await last.next((m) => m['type'] === 'lobbyQueued' && m['boosted'] === true);
  expect(last.got.filter(type('lobbyQueued')).at(-1)).toMatchObject({ position: 3, boosted: true });
  const n = last.got.length;
  last.ws.send(JSON.stringify({ type: 'lobbyBoost' })); // a second boost does nothing
  await new Promise((r) => setTimeout(r, 150));
  expect(last.got.length).toBe(n);
  for (const s of line) s.ws.close();
});

test('a player coming back to a held seat is let in even when the hub is full', async () => {
  const port = await start({ maxActive: 1, limits: { graceMs: 30_000 } });
  const a = open(port);
  await a.opened;
  a.ws.send(hello('a'));
  await a.next(type('lobbyWelcome'));
  a.ws.send(
    JSON.stringify({
      type: 'lobbyCreate',
      name: 'r',
      visibility: 'public',
      settings: {},
      maxPlayers: 4,
    }),
  );
  await a.next(type('lobbyRoomState'));
  a.ws.close();
  await a.closed;
  const other = open(port); // takes the one slot
  await other.opened;
  other.ws.send(hello('x'));
  await other.next(type('lobbyWelcome'));
  const back = open(port); // 'a' returns while the hub is full
  await back.opened;
  back.ws.send(hello('a'));
  await back.next(type('lobbyWelcome'));
  expect(back.got.some(type('lobbyQueued'))).toBe(false);
  other.ws.close();
  back.ws.close();
});

test('a queued socket is not dropped for saying hello late, and a full line refuses', async () => {
  const port = await start({ maxActive: 1, maxQueue: 1, helloTimeoutMs: 200 });
  const a = open(port);
  await a.opened;
  a.ws.send(hello('a'));
  await a.next(type('lobbyWelcome'));
  const b = open(port);
  await b.opened;
  b.ws.send(hello('b'));
  await b.next(type('lobbyQueued'));
  await new Promise((r) => setTimeout(r, 500)); // past the hello timeout
  expect(b.ws.readyState).toBe(WebSocket.OPEN);
  const c = open(port);
  await c.opened;
  c.ws.send(hello('c'));
  expect(await c.closed).toBe(4503);
  a.ws.close();
  b.ws.close();
});

test('origins: exact entries and https://*.host patterns', () => {
  expect(originMatches('https://*.portal.example', 'https://games.portal.example')).toBe(true);
  expect(originMatches('https://*.portal.example', 'https://a.b.portal.example')).toBe(true);
  expect(originMatches('https://*.portal.example', 'https://portal.example')).toBe(false);
  expect(originMatches('https://*.portal.example', 'https://evilportal.example')).toBe(false);
  expect(originMatches('https://*.portal.example', 'https://portal.example.evil.io')).toBe(false);
  expect(originMatches('https://*.portal.example', 'http://games.portal.example')).toBe(false);
  expect(originMatches('capacitor://app.portal.example', 'capacitor://app.portal.example')).toBe(
    true,
  );
  expect(originMatches('capacitor://app.portal.example', 'capacitor://other.portal.example')).toBe(
    false,
  );
  const g = parseGames([
    { id: 'demo', origins: ['https://*.portal.example', 'capacitor://app.portal.example'] },
  ]).get('demo')!;
  expect(originAllowed(g, 'https://abc.portal.example')).toBe(true);
  expect(originAllowed(g, 'https://evil.example')).toBe(false);
  expect(originAllowed(g, undefined)).toBe(true); // native clients send none
});
