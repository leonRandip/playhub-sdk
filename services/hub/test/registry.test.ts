import { beforeEach, describe, expect, test, vi } from 'vitest';
import { parseGames } from '../src/games.ts';
import { CLOSE_PROTOCOL, Registry, type Sock, TURN_WAIT_MS } from '../src/registry.ts';

class FakeSock implements Sock {
  sent: Record<string, unknown>[] = [];
  closed: { code?: number; reason?: string } | null = null;
  constructor(public origin?: string) {}
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
  }
  last() {
    return this.sent.at(-1)!;
  }
}

const games = () =>
  parseGames([
    {
      id: 'kart',
      name: 'Kart',
      maxPlayers: 4,
      origins: ['https://kart.example'],
      settings: {
        track: { type: 'string', enum: ['lider', 'neon'] },
        laps: { type: 'number', integer: true, min: 1, max: 20 },
      },
    },
    { id: 'chess', name: 'Chess', maxPlayers: 2 },
  ]);

const SETTINGS = { track: 'lider', laps: 3 };
let reg: Registry;
let seq: number;
beforeEach(() => {
  seq = 0;
  reg = new Registry({ games: games(), random: () => (seq++ % 23) / 23 });
});

function connect(id: string, game = 'kart', origin: string | undefined = 'https://kart.example') {
  const s = new FakeSock(origin);
  reg.onMessage(
    s,
    JSON.stringify({
      type: 'lobbyHello',
      v: 2,
      game,
      player: { id, name: id.toUpperCase(), profile: { car: 'blaze' } },
    }),
  );
  return s;
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const send = (s: FakeSock, m: object) => reg.onMessage(s, JSON.stringify(m));
const roomOf = (s: FakeSock) => s.last()['room'] as { code: string; maxPlayers: number };
function create(id: string, game = 'kart', settings: object = SETTINGS) {
  const s = connect(id, game);
  send(s, { type: 'lobbyCreate', name: 'r', visibility: 'public', settings, maxPlayers: 8 });
  return s;
}

describe('hello', () => {
  test('welcome echoes the id and carries ice servers', async () => {
    const s = connect('a');
    await flush();
    expect(s.last()).toMatchObject({ type: 'lobbyWelcome', you: 'a' });
    expect(s.last()['iceServers']).toEqual([{ urls: 'stun:stun.l.google.com:19302' }]);
  });
  test('first frame must be hello', () => {
    const s = new FakeSock();
    send(s, { type: 'lobbyList' });
    expect(s.last()).toMatchObject({ type: 'lobbyError', code: 'bad_message' });
    expect(s.closed?.code).toBe(CLOSE_PROTOCOL);
  });
  test('unknown game is refused', () => {
    const s = connect('a', 'nope');
    expect(s.last()).toMatchObject({ code: 'unknown_game' });
    expect(s.closed).not.toBeNull();
  });
  test('wrong origin is refused, missing origin (native client) is fine', async () => {
    expect(connect('a', 'kart', 'https://evil.example').last()).toMatchObject({
      code: 'forbidden_origin',
    });
    const b = connect('b', 'kart', undefined);
    // a game with no origin list accepts anything
    const c = connect('c', 'chess', 'https://anywhere');
    await flush();
    expect(b.last()).toMatchObject({ type: 'lobbyWelcome' });
    expect(c.last()).toMatchObject({ type: 'lobbyWelcome' });
  });
  test('wrong protocol version is refused', () => {
    const s = new FakeSock();
    reg.onMessage(
      s,
      JSON.stringify({ type: 'lobbyHello', v: 99, game: 'kart', player: { id: 'a', name: 'A' } }),
    );
    expect(s.last()).toMatchObject({ code: 'bad_version' });
  });
  test('oversized profile is refused', () => {
    const s = new FakeSock('https://kart.example');
    reg.onMessage(
      s,
      JSON.stringify({
        type: 'lobbyHello',
        v: 2,
        game: 'kart',
        player: { id: 'a', name: 'A', profile: { blob: 'x'.repeat(2000) } },
      }),
    );
    expect(s.last()).toMatchObject({ code: 'bad_message' });
  });
});

describe('rooms', () => {
  test('create → room state with game settings, host flag, clamped maxPlayers', () => {
    const s = create('a');
    const st = s.last();
    expect(st['type']).toBe('lobbyRoomState');
    expect(roomOf(s).maxPlayers).toBe(4); // asked for 8, the game caps at 4
    expect(st['room']).toMatchObject({ settings: SETTINGS, started: false, hostName: 'A' });
    expect(st['players']).toEqual([
      { id: 'a', name: 'A', profile: { car: 'blaze' }, ready: false, host: true },
    ]);
  });

  test('settings are checked against the game spec; the connection survives', () => {
    const s = create('a', 'kart', { track: 'moon', laps: 3 });
    expect(s.last()).toMatchObject({ code: 'bad_settings' });
    expect(s.closed).toBeNull();
    send(s, {
      type: 'lobbyCreate',
      name: 'r',
      visibility: 'public',
      settings: { track: 'lider' },
      maxPlayers: 2,
    });
    expect(s.last()).toMatchObject({ code: 'bad_settings' }); // missing laps
    send(s, {
      type: 'lobbyCreate',
      name: 'r',
      visibility: 'public',
      settings: { ...SETTINGS, x: 1 },
      maxPlayers: 2,
    });
    expect(s.last()).toMatchObject({ code: 'bad_settings' }); // unknown key
    send(s, {
      type: 'lobbyCreate',
      name: 'r',
      visibility: 'public',
      settings: SETTINGS,
      maxPlayers: 2,
    });
    expect(s.last()['type']).toBe('lobbyRoomState'); // still usable
  });

  test('a game without a settings spec accepts any (size-capped) settings', () => {
    const s = create('a', 'chess', { clock: 300, anything: ['goes'] });
    expect(s.last()['type']).toBe('lobbyRoomState');
    const big = create('b', 'chess', { blob: 'x'.repeat(3000) });
    expect(big.last()).toMatchObject({ code: 'bad_settings' });
  });

  test('join by code, list shows public rooms only, join/leave/ready broadcast', () => {
    const host = create('a');
    const code = roomOf(host).code;
    const guest = connect('b');
    send(guest, { type: 'lobbyJoin', code });
    expect(host.last()['players']).toHaveLength(2);
    send(guest, { type: 'lobbyReady', ready: true });
    expect(
      (host.last()['players'] as { id: string; ready: boolean }[]).find((p) => p.id === 'b')?.ready,
    ).toBe(true);

    const priv = connect('p');
    send(priv, {
      type: 'lobbyCreate',
      name: 'secret',
      visibility: 'private',
      settings: SETTINGS,
      maxPlayers: 2,
    });
    const viewer = connect('v');
    send(viewer, { type: 'lobbyList' });
    expect((viewer.last()['rooms'] as unknown[]).length).toBe(1);
    send(guest, { type: 'lobbyLeave' });
    expect(host.last()['players']).toHaveLength(1);
  });

  test('unknown code and full rooms are recoverable errors', () => {
    const host = create('a', 'chess'); // cap 2
    const code = roomOf(host).code;
    const g1 = connect('b', 'chess');
    send(g1, { type: 'lobbyJoin', code });
    const g2 = connect('c', 'chess');
    send(g2, { type: 'lobbyJoin', code });
    expect(g2.last()).toMatchObject({ code: 'room_full' });
    send(g2, { type: 'lobbyJoin', code: 'ZZZZZZ' });
    expect(g2.last()).toMatchObject({ code: 'room_not_found' });
    expect(g2.closed).toBeNull();
  });

  test('games are isolated: same code, other game, not found; lists do not leak', () => {
    const host = create('a', 'kart');
    const code = roomOf(host).code;
    const other = connect('x', 'chess');
    send(other, { type: 'lobbyJoin', code });
    expect(other.last()).toMatchObject({ code: 'room_not_found' });
    send(other, { type: 'lobbyList' });
    expect(other.last()['rooms']).toEqual([]);
    expect(reg.stats()).toEqual({
      kart: { rooms: 1, players: 1 },
      chess: { rooms: 0, players: 1 },
    });
  });

  test('only the host can start; start flags the room and bars late joiners', () => {
    const host = create('a');
    const code = roomOf(host).code;
    const guest = connect('b');
    send(guest, { type: 'lobbyJoin', code });
    send(guest, { type: 'lobbyStart' });
    expect(guest.last()).toMatchObject({ code: 'not_host' });
    send(host, { type: 'lobbyStart' });
    expect(guest.sent.some((m) => m['type'] === 'lobbyPrepare')).toBe(true);
    send(host, { type: 'lobbyPrepared', ok: true });
    send(guest, { type: 'lobbyPrepared', ok: true });
    expect(guest.sent.some((m) => m['type'] === 'lobbyGo' && m['hostId'] === 'a')).toBe(true);
    const late = connect('c');
    send(late, { type: 'lobbyJoin', code });
    expect(late.last()).toMatchObject({ code: 'room_started' });
    // …but a member whose socket dropped can resume their seat
    const back = connect('b');
    send(back, { type: 'lobbyJoin', code });
    expect(back.last()['type']).toBe('lobbyRoomState');
  });

  test('host leaving migrates the host; empty rooms are deleted', () => {
    let clock = 1_000_000;
    reg = new Registry({ games: games(), now: () => clock });
    const host = create('a');
    const code = roomOf(host).code;
    const guest = connect('b');
    send(guest, { type: 'lobbyJoin', code });
    send(host, { type: 'lobbyLeave' }); // leaving on purpose hands over at once
    expect((guest.last()['players'] as { host: boolean }[])[0]!.host).toBe(true);
    expect((guest.last()['room'] as { hostId: string }).hostId).toBe('b');
    reg.onClose(guest); // dropping is held for the grace period, then the room goes
    clock += 31_000;
    reg.sweep();
    expect(reg.roomCount).toBe(0);
  });

  test('a reconnect on a new socket keeps the seat when the old socket closes late', () => {
    const host = create('a');
    const code = roomOf(host).code;
    const g1 = connect('b');
    send(g1, { type: 'lobbyJoin', code });
    const g2 = connect('b'); // same player, new socket
    send(g2, { type: 'lobbyJoin', code });
    reg.onClose(g1); // the old, dead socket finally reports closed
    expect(host.last()['players']).toHaveLength(2);
  });
});

describe('signaling', () => {
  test('relays only between members of the same room, stamping the sender', () => {
    const host = create('a');
    const code = roomOf(host).code;
    const guest = connect('b');
    send(guest, { type: 'lobbyJoin', code });
    send(guest, { type: 'lobbySignal', to: 'a', data: { sdp: 'offer' } });
    expect(host.last()).toEqual({ type: 'lobbySignal', from: 'b', data: { sdp: 'offer' } });
    const outsider = create('z');
    const before = host.sent.length;
    send(outsider, { type: 'lobbySignal', to: 'a', data: 1 });
    expect(host.sent.length).toBe(before);
  });
});

describe('turn providers in the welcome', () => {
  const hello = (id: string) =>
    JSON.stringify({ type: 'lobbyHello', v: 2, game: 'chess', player: { id, name: id } });
  const relay = [{ urls: ['turn:t.example:3478'], username: 'u', credential: 'c' }];

  test('the welcome carries whatever the provider returns', async () => {
    const r = new Registry({
      games: games(),
      turn: { name: 'fake', iceServers: async () => relay },
    });
    const s = new FakeSock();
    r.onMessage(s, hello('a'));
    await flush();
    expect(s.last()).toMatchObject({ type: 'lobbyWelcome', you: 'a', iceServers: relay });
  });

  test('a provider that throws still lets the player in, with STUN only', async () => {
    const r = new Registry({
      games: games(),
      turn: {
        name: 'broken',
        iceServers: async () => {
          throw new Error('boom');
        },
      },
    });
    const s = new FakeSock();
    r.onMessage(s, hello('a'));
    await flush();
    expect(s.last()['iceServers']).toEqual([{ urls: 'stun:stun.l.google.com:19302' }]);
  });

  test('a provider that never answers cannot keep a player out', async () => {
    vi.useFakeTimers();
    try {
      const r = new Registry({
        games: games(),
        turn: { name: 'stuck', iceServers: () => new Promise(() => {}) },
      });
      const s = new FakeSock();
      r.onMessage(s, hello('a'));
      await vi.advanceTimersByTimeAsync(TURN_WAIT_MS + 10);
      expect(s.last()).toMatchObject({ type: 'lobbyWelcome' });
      expect(s.last()['iceServers']).toEqual([{ urls: 'stun:stun.l.google.com:19302' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  test('no welcome is sent to a socket that closed while the provider was working', async () => {
    let release: (v: typeof relay) => void = () => {};
    const r = new Registry({
      games: games(),
      turn: { name: 'slow', iceServers: () => new Promise((res) => (release = res)) },
    });
    const s = new FakeSock();
    r.onMessage(s, hello('a'));
    r.onClose(s);
    release(relay);
    await flush();
    expect(s.sent).toEqual([]);
  });

  test('the player is registered at once: frames sent before the welcome are handled', async () => {
    const r = new Registry({
      games: games(),
      turn: {
        name: 'slow',
        iceServers: () => new Promise((res) => setTimeout(() => res(relay), 20)),
      },
    });
    const s = new FakeSock();
    r.onMessage(s, hello('a'));
    r.onMessage(s, JSON.stringify({ type: 'lobbyList' }));
    expect(s.sent.map((m) => m['type'])).toEqual(['lobbyListResult']);
    await new Promise((res) => setTimeout(res, 40));
    expect(s.sent.map((m) => m['type'])).toEqual(['lobbyListResult', 'lobbyWelcome']);
  });
});

describe('moderation', () => {
  test('a profane player name is refused at hello, and logged', () => {
    const lines: string[] = [];
    reg = new Registry({ games: games(), log: (m) => lines.push(m) });
    const s = connect('f.u.c.k');
    expect(s.last()).toMatchObject({ type: 'lobbyError', code: 'bad_message' });
    expect(s.closed?.code).toBe(CLOSE_PROTOCOL);
    expect(lines.some((l) => l.includes('refused player name'))).toBe(true);
  });
  test('ordinary names are fine', async () => {
    const s = connect('cockpit');
    await flush();
    expect(s.last()).toMatchObject({ type: 'lobbyWelcome' });
  });
  test('a profane room name is refused without dropping the player', async () => {
    const s = connect('a');
    await flush();
    send(s, {
      type: 'lobbyCreate',
      name: 'sh1t room',
      visibility: 'public',
      settings: SETTINGS,
      maxPlayers: 4,
    });
    expect(s.last()).toMatchObject({ type: 'lobbyError', code: 'bad_message' });
    expect(s.closed).toBeNull();
    send(s, {
      type: 'lobbyCreate',
      name: 'Fun room',
      visibility: 'public',
      settings: SETTINGS,
      maxPlayers: 4,
    });
    expect(s.last()).toMatchObject({ type: 'lobbyRoomState' });
  });
});
