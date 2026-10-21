import { afterEach, expect, test } from 'vitest';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import { parseGames } from '../src/games.ts';
import { buildServer, type ServerOptions } from '../src/server.ts';

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

async function start(extra: Partial<ServerOptions> = {}) {
  app = await buildServer({ games: parseGames([{ id: 'demo', maxPlayers: 4 }]), ...extra });
  await app.listen({ port: 0, host: '127.0.0.1' });
  return (app.server.address() as { port: number }).port;
}

function open(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/lobby`);
  const closed = new Promise<number>((r) => ws.on('close', (c) => r(c)));
  const opened = new Promise<void>((r) => ws.on('open', () => r()));
  return { ws, closed, opened };
}
const hello = JSON.stringify({
  type: 'lobbyHello',
  v: 2,
  game: 'demo',
  player: { id: 'p', name: 'P' },
});
const race = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<'still open'>((r) => setTimeout(() => r('still open'), ms))]);

test('a socket that never says hello is dropped; one that does is left alone', async () => {
  const port = await start({ helloTimeoutMs: 150 });
  const silent = open(port);
  const polite = open(port);
  await Promise.all([silent.opened, polite.opened]);
  polite.ws.send(hello);
  expect(await silent.closed).toBe(4408);
  expect(await race(polite.closed, 400)).toBe('still open');
  polite.ws.close();
});

test('the overall connection cap refuses further sockets', async () => {
  const port = await start({ maxConnections: 2, maxConnectionsPerIp: 10 });
  const a = open(port);
  const b = open(port);
  await Promise.all([a.opened, b.opened]);
  const c = open(port);
  expect(await c.closed).toBe(4503);
  a.ws.close();
  b.ws.close();
});

test('a closed socket frees its slot', async () => {
  const port = await start({ maxConnections: 1, maxConnectionsPerIp: 10 });
  const a = open(port);
  await a.opened;
  a.ws.close();
  await a.closed;
  await new Promise((r) => setTimeout(r, 50));
  const b = open(port);
  await b.opened;
  b.ws.send(hello);
  expect(await race(b.closed, 300)).toBe('still open');
  b.ws.close();
});

test('healthz says only "ok" to the world and gives the counts to the machine itself', async () => {
  const port = await start();
  const local = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
  expect(local).toMatchObject({ ok: true, players: 0, rooms: 0 });
  expect(local.games).toBeDefined();
  // As Caddy forwards a stranger: the real address arrives in X-Forwarded-For.
  const stranger = await (
    await fetch(`http://127.0.0.1:${port}/healthz`, { headers: { 'x-forwarded-for': '8.8.8.8' } })
  ).json();
  expect(stranger).toEqual({ ok: true });
});

test('idle rooms are swept by the server on its own, and the room vanishes from the list', async () => {
  const port = await start({ sweepMs: 20, limits: { roomIdleMs: 60 } });
  const a = open(port);
  await a.opened;
  const got: Record<string, unknown>[] = [];
  a.ws.on('message', (d) => got.push(JSON.parse(d.toString())));
  a.ws.send(hello);
  await new Promise((r) => setTimeout(r, 30));
  a.ws.send(
    JSON.stringify({
      type: 'lobbyCreate',
      name: 'r',
      visibility: 'public',
      settings: {},
      maxPlayers: 2,
    }),
  );
  await new Promise((r) => setTimeout(r, 300));
  expect(got.map((m) => m['type'])).toContain('lobbyClosed');
  const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
  expect(health.rooms).toBe(0);
  a.ws.close();
});
