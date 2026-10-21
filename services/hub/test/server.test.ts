import { afterEach, expect, test } from 'vitest';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import { parseGames } from '../src/games.ts';
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

function open(port: number, origin = 'https://demo.example') {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/lobby`, { origin });
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

test('healthz reports ok', async () => {
  const port = await start();
  const r = await fetch(`http://127.0.0.1:${port}/healthz`);
  expect(await r.json()).toMatchObject({ ok: true, players: 0, rooms: 0 });
});

test('two real sockets: create, join, relay a signal', async () => {
  const port = await start();
  const a = open(port);
  const b = open(port);
  await Promise.all([a.opened, b.opened]);
  a.ws.send(hello('a'));
  await a.next((m) => m['type'] === 'lobbyWelcome');
  a.ws.send(
    JSON.stringify({
      type: 'lobbyCreate',
      name: 'r',
      visibility: 'public',
      settings: {},
      maxPlayers: 4,
    }),
  );
  const st = await a.next((m) => m['type'] === 'lobbyRoomState');
  const code = (st['room'] as { code: string }).code;
  b.ws.send(hello('b'));
  await b.next((m) => m['type'] === 'lobbyWelcome');
  b.ws.send(JSON.stringify({ type: 'lobbyJoin', code }));
  await a.next((m) => m['type'] === 'lobbyRoomState' && (m['players'] as unknown[]).length === 2);
  b.ws.send(JSON.stringify({ type: 'lobbySignal', to: 'a', data: { hi: 1 } }));
  expect(await a.next((m) => m['type'] === 'lobbySignal')).toEqual({
    type: 'lobbySignal',
    from: 'b',
    data: { hi: 1 },
  });
  a.ws.close();
  b.ws.close();
});

test('a browser origin outside the game list is refused', async () => {
  const port = await start();
  const x = open(port, 'https://evil.example');
  await x.opened;
  x.ws.send(hello('x'));
  expect(await x.next((m) => m['type'] === 'lobbyError')).toMatchObject({
    code: 'forbidden_origin',
  });
  expect(await x.closed).toBe(4400);
});

test('per-IP connection cap and per-socket message rate limit', async () => {
  const port = await start({ maxConnectionsPerIp: 2, burst: 5, messagesPerSecond: 1 });
  const a = open(port);
  const b = open(port);
  const c = open(port);
  expect(await c.closed).toBe(4503);
  await Promise.all([a.opened, b.opened]);
  a.ws.send(hello('a'));
  for (let i = 0; i < 10; i++) a.ws.send(JSON.stringify({ type: 'lobbyList' }));
  expect(await a.closed).toBe(4429);
  b.ws.close();
});
