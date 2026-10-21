import { beforeEach, describe, expect, test } from 'vitest';
import { parseGames } from '../src/games.ts';
import { type Limits, Registry, type Sock } from '../src/registry.ts';

class FakeSock implements Sock {
  sent: Record<string, unknown>[] = [];
  closed = false;
  constructor(public ip = '1.1.1.1') {}
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close() {
    this.closed = true;
  }
  last() {
    return this.sent.at(-1)!;
  }
  types() {
    return this.sent.map((m) => m['type']);
  }
}

const games = () => parseGames([{ id: 'gm', maxPlayers: 4 }]);
const MIN = 60_000;
let clock: number;
function registry(limits: Partial<Limits> = {}) {
  clock = 1_000_000;
  let n = 0;
  return new Registry({
    games: games(),
    limits,
    now: () => clock,
    random: () => (n++ % 23) / 23,
  });
}

let reg: Registry;
beforeEach(() => {
  reg = registry();
});

const send = (s: FakeSock, m: object) => reg.onMessage(s, JSON.stringify(m));
function connect(id: string, ip = '1.1.1.1'): FakeSock {
  const s = new FakeSock(ip);
  send(s, { type: 'lobbyHello', v: 2, game: 'gm', player: { id, name: id } });
  return s;
}
const create = (s: FakeSock, visibility: 'public' | 'private' = 'public') =>
  send(s, { type: 'lobbyCreate', name: 'r', visibility, settings: {}, maxPlayers: 4 });
const codeOf = (s: FakeSock) => (s.last()['room'] as { code: string }).code;

describe('rooms do not outlive their use', () => {
  test('a room is deleted when its last player leaves, or once their grace period runs out', () => {
    const a = connect('a');
    create(a);
    const b = connect('b');
    send(b, { type: 'lobbyJoin', code: codeOf(a) });
    send(a, { type: 'lobbyLeave' }); // an explicit leave is immediate
    expect(reg.roomCount).toBe(1);
    reg.onClose(b); // the last one drops without saying goodbye: the seat is held 30 s
    expect(reg.roomCount).toBe(1);
    clock += 29_000;
    reg.sweep();
    expect(reg.roomCount).toBe(1);
    clock += 2_000;
    reg.sweep();
    expect(reg.roomCount).toBe(0);
  });

  test('an untouched room is closed after the idle limit and its members are told', () => {
    const a = connect('a');
    create(a);
    const b = connect('b');
    send(b, { type: 'lobbyJoin', code: codeOf(a) });
    clock += 14 * MIN;
    expect(reg.sweep()).toBe(0);
    clock += 2 * MIN;
    expect(reg.sweep()).toBe(1);
    expect(reg.roomCount).toBe(0);
    for (const s of [a, b]) expect(s.last()).toEqual({ type: 'lobbyClosed', reason: 'idle' });
    // they are still connected and can start over
    expect(a.closed).toBe(false);
    create(a);
    expect(a.last()['type']).toBe('lobbyRoomState');
    // …and nobody is a ghost member of the closed room (leave is a harmless no-op)
    expect(() => send(b, { type: 'lobbyLeave' })).not.toThrow();
  });

  test('any lobby activity keeps a room alive', () => {
    const a = connect('a');
    create(a);
    clock += 10 * MIN;
    send(a, { type: 'lobbyReady', ready: true });
    clock += 10 * MIN;
    expect(reg.sweep()).toBe(0); // 20 min old, but only 10 since the last activity
    clock += 6 * MIN;
    expect(reg.sweep()).toBe(1);
  });

  test('a started room is not "idle" (play is peer to peer) but has a maximum life', () => {
    const a = connect('a');
    create(a);
    send(a, { type: 'lobbyStart' });
    send(a, { type: 'lobbyPrepared', ok: true });
    clock += 55 * MIN;
    expect(reg.sweep()).toBe(0);
    clock += 6 * MIN;
    expect(reg.sweep()).toBe(1);
    expect(a.last()).toEqual({ type: 'lobbyClosed', reason: 'expired' });
  });
});

describe('rematch: reopen', () => {
  function started() {
    const host = connect('h');
    create(host);
    const code = codeOf(host);
    const g = connect('g');
    send(g, { type: 'lobbyJoin', code });
    send(g, { type: 'lobbyReady', ready: true });
    send(host, { type: 'lobbyStart' });
    send(host, { type: 'lobbyPrepared', ok: true });
    send(g, { type: 'lobbyPrepared', ok: true });
    return { host, g, code };
  }

  test('without it a started room refuses newcomers; with it the host reopens the lobby', () => {
    const { host, g, code } = started();
    const late = connect('late');
    send(late, { type: 'lobbyJoin', code });
    expect(late.last()).toMatchObject({ code: 'room_started' });
    send(host, { type: 'lobbyReopen' });
    const st = host.last();
    expect(st['type']).toBe('lobbyRoomState');
    expect((st['room'] as { started: boolean }).started).toBe(false);
    expect((st['players'] as { ready: boolean }[]).every((p) => !p.ready)).toBe(true);
    expect(g.last()).toEqual(st);
    send(late, { type: 'lobbyJoin', code });
    expect(late.last()['type']).toBe('lobbyRoomState');
  });

  test('only the host may reopen, and reopening an unstarted room does nothing', () => {
    const { host, g } = started();
    send(g, { type: 'lobbyReopen' });
    expect(g.last()).toMatchObject({ code: 'not_host' });
    send(host, { type: 'lobbyReopen' });
    const before = host.sent.length;
    send(host, { type: 'lobbyReopen' });
    expect(host.sent.length).toBe(before);
  });

  test('a reopened room is subject to the idle limit again, not the match limit', () => {
    const { host } = started();
    clock += 10 * MIN;
    send(host, { type: 'lobbyReopen' });
    clock += 16 * MIN;
    expect(reg.sweep()).toBe(1);
    expect(host.last()).toEqual({ type: 'lobbyClosed', reason: 'idle' });
  });
});

describe('abuse limits', () => {
  test('wrong room codes are throttled per address, even for a later correct one', () => {
    const owner = connect('o', '9.9.9.9');
    create(owner, 'private');
    const code = codeOf(owner);
    const guesser = connect('x', '2.2.2.2');
    for (let i = 0; i < 10; i++) send(guesser, { type: 'lobbyJoin', code: 'ZZZZZZ' });
    expect(guesser.last()).toMatchObject({ code: 'room_not_found' });
    send(guesser, { type: 'lobbyJoin', code: 'ZZZZZZ' });
    expect(guesser.last()).toMatchObject({ code: 'rate_limited' });
    // a correct guess is refused too: the throttle must not leak whether a code exists
    send(guesser, { type: 'lobbyJoin', code });
    expect(guesser.last()).toMatchObject({ code: 'rate_limited' });
    // another address is unaffected
    const friend = connect('f', '3.3.3.3');
    send(friend, { type: 'lobbyJoin', code });
    expect(friend.last()['type']).toBe('lobbyRoomState');
    // the window passes
    clock += MIN + 1;
    send(guesser, { type: 'lobbyJoin', code });
    expect(guesser.last()['type']).toBe('lobbyRoomState');
  });

  test('one address cannot hold more than maxRoomsPerIp rooms (many sockets)', () => {
    reg = registry({ maxRoomsPerIp: 3 });
    for (let i = 0; i < 3; i++) create(connect(`p${i}`, '4.4.4.4'));
    const extra = connect('p3', '4.4.4.4');
    create(extra);
    expect(extra.last()).toMatchObject({ code: 'rate_limited' });
    const other = connect('q', '5.5.5.5');
    create(other);
    expect(other.last()['type']).toBe('lobbyRoomState');
    expect(reg.roomCount).toBe(4);
  });

  test('a game is capped at maxRoomsPerGame open rooms; the answer is recoverable', () => {
    reg = registry({ maxRoomsPerGame: 2, maxRoomsPerIp: 99 });
    create(connect('a', '1.0.0.1'));
    create(connect('b', '1.0.0.2'));
    const c = connect('c', '1.0.0.3');
    create(c);
    expect(c.last()).toMatchObject({ code: 'server_busy' });
    expect(c.closed).toBe(false);
  });

  test('the room list is capped and shows the fullest rooms first', () => {
    reg = registry({ listLimit: 2, maxRoomsPerIp: 99 });
    const hosts = ['a', 'b', 'c'].map((id) => connect(id, `7.7.7.${id.charCodeAt(0)}`));
    hosts.forEach((h) => create(h));
    const joiner = connect('j');
    send(joiner, { type: 'lobbyJoin', code: codeOf(hosts[2]!) }); // room c now has 2 players
    const viewer = connect('v');
    send(viewer, { type: 'lobbyList' });
    const rooms = viewer.last()['rooms'] as { code: string; playerCount: number }[];
    expect(rooms).toHaveLength(2);
    expect(rooms[0]!.playerCount).toBe(2);
  });
});

describe('grace period: a dropped player keeps their seat for 30 s', () => {
  function pair() {
    const host = connect('h');
    create(host);
    const code = codeOf(host);
    const g = connect('g');
    send(g, { type: 'lobbyJoin', code });
    return { host, g, code };
  }
  const players = (s: FakeSock) =>
    s.last()['players'] as { id: string; away?: boolean; host: boolean }[];

  test('others see them as away; they are not removed until the grace period ends', () => {
    const { host, g } = pair();
    reg.onClose(g);
    expect(host.last()['type']).toBe('lobbyRoomState');
    expect(players(host).find((p) => p.id === 'g')?.away).toBe(true);
    expect(players(host)).toHaveLength(2);
    clock += 29_000;
    reg.sweep();
    expect(players(host)).toHaveLength(2);
    clock += 1_500;
    reg.sweep();
    expect(players(host)).toHaveLength(1);
    expect(players(host)[0]!.away).toBeUndefined();
  });

  test('coming back with the same id inside the period resumes the seat (no longer away)', () => {
    const { host, code } = pair();
    const old = host; // keep the host; drop g and bring g back on a new socket
    const g1 = connect('g2');
    send(g1, { type: 'lobbyJoin', code });
    reg.onClose(g1);
    clock += 20_000;
    const back = connect('g2');
    send(back, { type: 'lobbyJoin', code });
    expect(back.last()['type']).toBe('lobbyRoomState');
    expect(players(old).find((p) => p.id === 'g2')?.away).toBeUndefined();
    clock += 60_000;
    reg.sweep(); // the old grace timer must not remove the returned player
    expect(players(old).some((p) => p.id === 'g2')).toBe(true);
  });

  test('a host who drops is replaced only after the period, by a connected player', () => {
    const { host, g } = pair();
    reg.onClose(host);
    expect((g.last()['room'] as { hostId: string }).hostId).toBe('h'); // still theirs while away
    clock += 31_000;
    reg.sweep();
    expect((g.last()['room'] as { hostId: string }).hostId).toBe('g');
  });

  test('messages are not sent to an away player and signals to them are dropped', () => {
    const { host, g } = pair();
    reg.onClose(g);
    const before = g.sent.length;
    send(host, { type: 'lobbyReady', ready: true });
    send(host, { type: 'lobbySignal', to: 'g', data: 1 });
    expect(g.sent.length).toBe(before);
  });

  test('a room whose players are all away is not offered in the public list', () => {
    const host = connect('solo');
    create(host);
    const viewer = connect('v', '8.8.8.8');
    send(viewer, { type: 'lobbyList' });
    expect((viewer.last()['rooms'] as unknown[]).length).toBe(1);
    reg.onClose(host);
    send(viewer, { type: 'lobbyList' });
    expect((viewer.last()['rooms'] as unknown[]).length).toBe(0);
  });

  test('the welcome tells the client how long the grace period is', async () => {
    const s = connect('w');
    await new Promise((r) => setTimeout(r, 0));
    expect(s.last()).toMatchObject({ type: 'lobbyWelcome', graceSeconds: 30 });
  });
});

describe('countdown fields and codes', () => {
  test('an unstarted room reports how long until it closes; a started one does not', () => {
    const host = connect('h');
    create(host);
    const left = (s: FakeSock) =>
      (s.last()['room'] as { closesInSeconds?: number }).closesInSeconds;
    expect(left(host)).toBe(15 * 60);
    clock += 5 * MIN;
    send(host, { type: 'lobbyReady', ready: false }); // activity resets it
    expect(left(host)).toBe(15 * 60);
    clock += 4 * MIN;
    const viewer = connect('v', '9.9.9.9');
    send(viewer, { type: 'lobbyList' });
    expect((viewer.last()['rooms'] as { closesInSeconds: number }[])[0]!.closesInSeconds).toBe(
      11 * 60,
    );
    send(host, { type: 'lobbyStart' });
    send(host, { type: 'lobbyPrepared', ok: true });
    send(host, { type: 'lobbyReopen' });
    expect(left(host)).toBe(15 * 60);
    send(host, { type: 'lobbyStart' });
    expect(host.sent.some((m) => m['type'] === 'lobbyPrepare')).toBe(true);
  });

  test('new rooms get six-letter codes, and a mistyped short code is a polite no such room', () => {
    const host = connect('h');
    create(host);
    expect(codeOf(host)).toMatch(/^[A-HJKMNP-Z]{6}$/);
    const p = connect('p', '6.6.6.6');
    send(p, { type: 'lobbyJoin', code: 'ABCD' });
    expect(p.last()).toMatchObject({ code: 'room_not_found' });
    expect(p.closed).toBe(false);
  });

  test('the throttle message says how long to wait', () => {
    const g = connect('x', '2.2.2.2');
    for (let i = 0; i < 11; i++) send(g, { type: 'lobbyJoin', code: 'ZZZZZZ' });
    expect(String(g.last()['message'])).toMatch(/try again in \d+ s/);
  });
});

describe('synchronized start', () => {
  function pair() {
    const host = connect('h');
    create(host);
    const g = connect('g');
    send(g, { type: 'lobbyJoin', code: codeOf(host) });
    send(host, { type: 'lobbyStart' });
    return { host, g };
  }
  const types = (s: FakeSock) => s.sent.map((m) => m['type']);

  test('go is sent only once every player is ready, with the lead time minus half the RTT', () => {
    const { host, g } = pair();
    (g as unknown as { rttMs: number }).rttMs = 200;
    send(host, { type: 'lobbyPrepared', ok: true });
    expect(types(host)).not.toContain('lobbyGo');
    send(g, { type: 'lobbyPrepared', ok: true });
    expect(host.sent.find((m) => m['type'] === 'lobbyGo')).toMatchObject({ startInMs: 8000 });
    expect(g.sent.find((m) => m['type'] === 'lobbyGo')).toMatchObject({ startInMs: 7900 });
  });

  test('a player who cannot start calls it off for everyone, back to the lobby', () => {
    const { host, g } = pair();
    send(g, { type: 'lobbyPrepared', ok: false, reason: 'load_failed' });
    expect(host.sent.find((m) => m['type'] === 'lobbyAbort')).toMatchObject({
      who: 'g',
      reason: 'load_failed',
    });
    expect((host.last()['room'] as { phase: string }).phase).toBe('lobby');
  });

  test('silence past the deadline aborts with a timeout naming who was pending', () => {
    const { host, g } = pair();
    send(host, { type: 'lobbyPrepared', ok: true });
    clock += 14_000;
    reg.sweep();
    expect(types(g)).not.toContain('lobbyAbort');
    clock += 2_000;
    reg.sweep();
    expect(g.sent.find((m) => m['type'] === 'lobbyAbort')).toMatchObject({
      who: 'g',
      reason: 'timeout',
    });
  });

  test('the host can cancel, a guest cannot, and a drop while preparing aborts', () => {
    const { host, g } = pair();
    send(g, { type: 'lobbyCancel' });
    expect(g.last()).toMatchObject({ code: 'not_host' });
    send(host, { type: 'lobbyCancel' });
    expect(g.sent.find((m) => m['type'] === 'lobbyAbort')).toMatchObject({ reason: 'cancelled' });
    send(host, { type: 'lobbyStart' });
    reg.onClose(g);
    expect(host.sent.filter((m) => m['type'] === 'lobbyAbort').at(-1)).toMatchObject({
      who: 'g',
      reason: 'away',
    });
  });
});
