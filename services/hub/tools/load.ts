/**
 * `pnpm hub-load`: how many players one hub serves, with evidence. For each level N it starts a fresh hub process,
 * connects N simulated players (ramped), puts them in rooms of six, keeps them busy (room lists, ready toggles and
 * relayed signals, about 3 messages a second each) and records: how long hello → welcome takes, how long a room-list
 * request takes, the hub's memory (RSS), and how many were admitted or waited in line. Writes
 * `load-report/results.csv`, `results.json` and a self-contained `report.html` with charts.
 *
 *   pnpm hub-load                       # levels 100 250 400 600 800, 15 s each, hub capacity 400
 *   LEVELS=100,500 SECONDS=30 MAX_ACTIVE=300 pnpm hub-load
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, '../../../load-report');
const LEVELS = (process.env['LEVELS'] ?? '100,250,400,600,800').split(',').map(Number);
const SECONDS = Number(process.env['SECONDS'] ?? 15);
const MAX_ACTIVE = Number(process.env['MAX_ACTIVE'] ?? 400);
const RAMP_PER_SECOND = Number(process.env['RAMP'] ?? 150);
const PORT = 8099;

const pct = (a: number[], p: number) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rssMb = (pid: number) =>
  Number(
    execFileSync('ps', ['-o', 'rss=', '-p', String(pid)])
      .toString()
      .trim(),
  ) / 1024;

interface Row {
  players: number;
  admitted: number;
  queued: number;
  welcomeP50: number;
  welcomeP95: number;
  welcomeP99: number;
  listP50: number;
  listP95: number;
  listP99: number;
  rssIdleMb: number;
  rssMaxMb: number;
  mbPerAdmitted: number;
  errors: number;
}

async function runLevel(n: number): Promise<Row> {
  const hub = spawn(process.execPath, ['--import', 'tsx', path.join(here, 'load-hub.ts')], {
    env: {
      ...process.env,
      MAX_ACTIVE: String(MAX_ACTIVE),
      MAX_QUEUE: String(Math.max(n, 1000)),
      PORT: String(PORT),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise<void>((resolve, reject) => {
    hub.stdout!.on('data', (d) => String(d).includes('ready') && resolve());
    hub.on('exit', (c) => reject(new Error(`hub exited ${c}`)));
  });
  const rssIdle = rssMb(hub.pid!);
  const welcomeMs: number[] = [];
  const listMs: number[] = [];
  let errors = 0;
  const sockets: WebSocket[] = [];
  const roomCode: Record<number, string> = {};
  let admitted = 0;

  const startClient = (i: number) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/v1/lobby`, { origin: 'https://load.example' });
    sockets.push(ws);
    let helloAt = 0;
    let listAt = 0;
    let timer: ReturnType<typeof setInterval> | null = null;
    let welcomed = false;
    const group = Math.floor(i / 6);
    ws.on('open', () => {
      helloAt = Date.now();
      ws.send(
        JSON.stringify({
          type: 'lobbyHello',
          v: 2,
          game: 'load',
          player: { id: `p${i}`, name: `Player${i}`, profile: {} },
        }),
      );
    });
    ws.on('error', () => errors++);
    ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      if (m.type === 'lobbyWelcome' && !welcomed) {
        welcomed = true;
        admitted++;
        welcomeMs.push(Date.now() - helloAt);
        if (i % 6 === 0)
          ws.send(
            JSON.stringify({
              type: 'lobbyCreate',
              name: `room ${group}`,
              visibility: 'public',
              settings: {},
              maxPlayers: 8,
            }),
          );
        else {
          const wait = setInterval(() => {
            if (roomCode[group]) {
              clearInterval(wait);
              ws.send(JSON.stringify({ type: 'lobbyJoin', code: roomCode[group] }));
            }
          }, 200);
        }
        let k = 0;
        timer = setInterval(
          () => {
            if (ws.readyState !== WebSocket.OPEN) return;
            k++;
            if (k % 2 === 0) {
              listAt = Date.now();
              ws.send(JSON.stringify({ type: 'lobbyList' }));
            }
            ws.send(JSON.stringify({ type: 'lobbyReady', ready: k % 3 === 0 }));
            ws.send(
              JSON.stringify({
                type: 'lobbySignal',
                to: `p${group * 6 + ((i + 1) % 6)}`,
                data: { k },
              }),
            );
          },
          700 + (i % 7) * 20,
        );
      } else if (m.type === 'lobbyRoomState' && i % 6 === 0 && !roomCode[group])
        roomCode[group] = m.room.code;
      else if (m.type === 'lobbyListResult' && listAt) {
        listMs.push(Date.now() - listAt);
        listAt = 0;
      } else if (m.type === 'lobbyError') errors++;
    });
    ws.on('close', () => timer && clearInterval(timer));
  };

  // ramp the players in, then hold the load while sampling memory
  const perTick = Math.max(1, Math.round(RAMP_PER_SECOND / 10));
  for (let i = 0; i < n; i += perTick) {
    for (let j = i; j < Math.min(n, i + perTick); j++) startClient(j);
    await sleep(100);
  }
  let rssMax = rssIdle;
  for (let s = 0; s < SECONDS; s++) {
    await sleep(1000);
    rssMax = Math.max(rssMax, rssMb(hub.pid!));
  }
  const health = (await (await fetch(`http://127.0.0.1:${PORT}/healthz`)).json()) as {
    players: number;
    queued: number;
  };
  for (const ws of sockets) ws.terminate();
  hub.kill('SIGTERM');
  await sleep(300);
  return {
    players: n,
    admitted: health.players,
    queued: health.queued,
    welcomeP50: pct(welcomeMs, 50),
    welcomeP95: pct(welcomeMs, 95),
    welcomeP99: pct(welcomeMs, 99),
    listP50: pct(listMs, 50),
    listP95: pct(listMs, 95),
    listP99: pct(listMs, 99),
    rssIdleMb: Math.round(rssIdle),
    rssMaxMb: Math.round(rssMax),
    mbPerAdmitted: health.players ? +((rssMax - rssIdle) / health.players).toFixed(3) : 0,
    errors,
  };
}

/** A small SVG line chart (no libraries): one series, labelled axes. */
function chart(title: string, unit: string, xs: number[], ys: number[], color: string): string {
  const W = 460;
  const H = 240;
  const L = 52;
  const B = 34;
  const maxY = Math.max(1, ...ys) * 1.15;
  const maxX = Math.max(...xs);
  const px = (x: number) => L + (x / maxX) * (W - L - 14);
  const py = (y: number) => H - B - (y / maxY) * (H - B - 28);
  const pts = xs.map((x, i) => `${px(x).toFixed(1)},${py(ys[i]!).toFixed(1)}`).join(' ');
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map(
      (f) =>
        `<line x1="${L}" x2="${W - 14}" y1="${py(((maxY * f) / 1.15) * 1.15).toFixed(1)}" y2="${py(maxY * f).toFixed(1)}" stroke="#ddd"/><text x="${L - 6}" y="${(py(maxY * f) + 4).toFixed(1)}" text-anchor="end" font-size="11">${(maxY * f).toFixed(maxY < 10 ? 1 : 0)}</text>`,
    )
    .join('');
  const dots = xs
    .map(
      (x, i) =>
        `<circle cx="${px(x).toFixed(1)}" cy="${py(ys[i]!).toFixed(1)}" r="3.5" fill="${color}"/><text x="${px(x).toFixed(1)}" y="${H - 14}" text-anchor="middle" font-size="11">${x}</text>`,
    )
    .join('');
  return `<figure><svg viewBox="0 0 ${W} ${H}" width="100%"><text x="${L}" y="16" font-size="13" font-weight="700">${title}</text>${grid}<polyline fill="none" stroke="${color}" stroke-width="2.5" points="${pts}"/>${dots}<text x="${W / 2}" y="${H - 1}" text-anchor="middle" font-size="11" fill="#666">players connecting</text><text x="10" y="${H / 2}" font-size="11" fill="#666" transform="rotate(-90 10 ${H / 2})">${unit}</text></svg></figure>`;
}

const rows: Row[] = [];
for (const n of LEVELS) {
  process.stdout.write(`level ${n}… `);
  const r = await runLevel(n);
  rows.push(r);
  console.log(
    `admitted ${r.admitted}, queued ${r.queued}, welcome p95 ${r.welcomeP95} ms, list p95 ${r.listP95} ms, rss ${r.rssMaxMb} MB, errors ${r.errors}`,
  );
}

mkdirSync(OUT, { recursive: true });
const cols = Object.keys(rows[0]!) as (keyof Row)[];
writeFileSync(
  path.join(OUT, 'results.csv'),
  [cols.join(','), ...rows.map((r) => cols.map((c) => r[c]).join(','))].join('\n') + '\n',
);
writeFileSync(
  path.join(OUT, 'results.json'),
  JSON.stringify(
    {
      when: new Date().toISOString(),
      maxActive: MAX_ACTIVE,
      seconds: SECONDS,
      machine: `${os.cpus()[0]?.model} x${os.cpus().length}, ${Math.round(os.totalmem() / 2 ** 30)} GB`,
      rows,
    },
    null,
    2,
  ),
);
const xs = rows.map((r) => r.players);
writeFileSync(
  path.join(OUT, 'report.html'),
  `<!doctype html><meta charset="utf-8"><title>Hub load test</title><style>body{font:15px/1.5 system-ui;max-width:1000px;margin:2rem auto;padding:0 1rem;color:#222}.g{display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:1rem}table{border-collapse:collapse;width:100%;font-size:13px}td,th{border:1px solid #ddd;padding:4px 8px;text-align:right}th{background:#f3f3f3}figure{margin:0;border:1px solid #eee;padding:8px;border-radius:8px}</style>
<h1>Hub load test</h1><p>${new Date().toISOString()} · hub capacity (maxActive) <b>${MAX_ACTIVE}</b> · ${SECONDS} s per level · simulated players are in rooms of six and send about 3 messages a second · machine: ${os.cpus()[0]?.model} ×${os.cpus().length}, ${Math.round(os.totalmem() / 2 ** 30)} GB (the hub and the simulated players share it, so latency here is pessimistic).</p>
<div class="g">${chart(
    'Hub memory (RSS)',
    'MB',
    xs,
    rows.map((r) => r.rssMaxMb),
    '#2f8f7d',
  )}${chart(
    'Room-list answer, 95th percentile',
    'ms',
    xs,
    rows.map((r) => r.listP95),
    '#d7263d',
  )}${chart(
    'Hello → welcome, 95th percentile',
    'ms',
    xs,
    rows.map((r) => r.welcomeP95),
    '#2f6fed',
  )}${chart(
    'Waiting in line',
    'players',
    xs,
    rows.map((r) => r.queued),
    '#f59e0b',
  )}</div>
<h2>Numbers</h2><table><tr>${cols.map((c) => `<th>${c}</th>`).join('')}</tr>${rows.map((r) => `<tr>${cols.map((c) => `<td>${r[c]}</td>`).join('')}</tr>`).join('')}</table>
<p>Reading it: up to the capacity everyone is admitted and the answer times stay flat; beyond it the extra players wait in line (the "queued" column) instead of slowing everybody down. Memory per admitted player is in <code>mbPerAdmitted</code>; multiply by the capacity to size the server.</p>`,
);
console.log(`\nreport: ${path.join(OUT, 'report.html')}`);
