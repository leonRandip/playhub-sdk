import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { LobbyPlayer, RoomSummary } from '@playhub/protocol';
import { LiveRoom } from '../src/room.ts';
import type { Link, PeerLinkState } from '../src/peer-link.ts';

class FakeLink implements Link {
  state: PeerLinkState = 'connecting';
  sent: string[] = [];
  received: unknown[] = [];
  closed = false;
  onState: (s: PeerLinkState) => void = () => {};
  onMessage: (d: string) => void = () => {};
  onSignal: (d: unknown) => void = () => {};
  constructor(readonly initiator: boolean) {}
  async start() {
    this.onSignal({ kind: 'offer', sdp: 'o' });
  }
  async onSignalReceived(d: unknown) {
    this.received.push(d);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.closed = true;
    this.set('disconnected');
  }
  set(s: PeerLinkState) {
    this.state = s;
    this.onState(s);
  }
}

const player = (id: string, host = false, ready = false): LobbyPlayer => ({
  id,
  name: id.toUpperCase(),
  profile: {},
  ready,
  host,
});
const summary = (hostId: string, n = 2): RoomSummary => ({
  code: 'ABCD',
  name: 'r',
  hostId,
  hostName: hostId,
  visibility: 'public',
  settings: {},
  maxPlayers: 4,
  playerCount: n,
  started: false,
  phase: 'lobby',
});

let links: FakeLink[];
let signals: unknown[];
function room(me: string, hostId: string, players: LobbyPlayer[]) {
  const r = new LiveRoom(
    summary(hostId, players.length),
    me,
    (m) => signals.push(m),
    () => [],
    {
      createLink: (initiator) => {
        const l = new FakeLink(initiator);
        links.push(l);
        return l;
      },
    },
  );
  r.handleRoomState(summary(hostId, players.length), players);
  return r;
}

beforeEach(() => {
  vi.useFakeTimers();
  links = [];
  signals = [];
});
afterEach(() => vi.useRealTimers());

describe('client side', () => {
  test('opens one initiating link to the host and relays its signals', () => {
    room('b', 'a', [player('a', true), player('b')]);
    expect(links).toHaveLength(1);
    expect(links[0]!.initiator).toBe(true);
    expect(signals).toContainEqual({
      type: 'lobbySignal',
      to: 'a',
      data: { kind: 'offer', sdp: 'o' },
    });
  });

  test('a link that never connects is retried with backoff, then given up on', () => {
    const r = room('b', 'a', [player('a', true), player('b')]);
    // 6 s timeout, then 1 s, 2 s, 4 s, 4 s of backoff (4 attempts), each new link also never connecting
    vi.advanceTimersByTime(6000);
    expect(r.hostLinkLost).toBe(false);
    for (const ms of [1000, 2000, 4000, 4000]) vi.advanceTimersByTime(ms + 6000);
    expect(links.length).toBe(5); // original + 4 retries
    expect(r.hostLinkLost).toBe(true);
    expect(r.tick().filter((e) => e.type === 'linkLost')).toHaveLength(1);
  });

  test('connecting resets the retry budget', () => {
    const r = room('b', 'a', [player('a', true), player('b')]);
    links[0]!.set('failed');
    vi.advanceTimersByTime(1000);
    expect(links).toHaveLength(2);
    links[1]!.set('connected');
    links[1]!.set('failed');
    vi.advanceTimersByTime(1000); // attempt counter was reset, so the first backoff (1 s) again
    expect(links).toHaveLength(3);
    expect(r.hostLinkLost).toBe(false);
  });

  test('messages: sendToHost goes to the host link, host messages reach the handler', () => {
    const r = room('b', 'a', [player('a', true), player('b')]);
    const got: unknown[] = [];
    r.onHostMessage = (m) => got.push(m);
    links[0]!.set('connected');
    r.sendToHost({ t: 'input', steer: 1 });
    expect(links[0]!.sent).toEqual(['{"t":"input","steer":1}']);
    links[0]!.onMessage('{"t":"snap"}');
    links[0]!.onMessage('garbage'); // ignored
    expect(got).toEqual([{ t: 'snap' }]);
  });

  test('losing the host from the room closes the link', () => {
    const r = room('b', 'a', [player('a', true), player('b')]);
    r.handleRoomState(summary('b', 1), [player('b', true)]);
    expect(links[0]!.closed).toBe(true);
  });
});

describe('host side', () => {
  test('creates links lazily, one per joiner, answering their offers', async () => {
    const r = room('a', 'a', [player('a', true), player('b'), player('c')]);
    expect(links).toHaveLength(0);
    await r.handleSignal('b', { kind: 'offer', sdp: 'x' });
    await r.handleSignal('c', { kind: 'offer', sdp: 'y' });
    expect(links.map((l) => l.initiator)).toEqual([false, false]);
    expect(links[0]!.received).toEqual([{ kind: 'offer', sdp: 'x' }]);
  });

  test('a fresh offer from a reconnecting joiner replaces the stale link', async () => {
    const r = room('a', 'a', [player('a', true), player('b')]);
    await r.handleSignal('b', { kind: 'offer', sdp: '1' });
    await r.handleSignal('b', { kind: 'offer', sdp: '2' });
    expect(links).toHaveLength(2);
    expect(links[0]!.closed).toBe(true);
    expect(links[1]!.received).toEqual([{ kind: 'offer', sdp: '2' }]);
  });

  test('ignores signals from non-members, client messages carry the sender id', async () => {
    const r = room('a', 'a', [player('a', true), player('b')]);
    const got: [string, unknown][] = [];
    r.onClientMessage = (id, m) => got.push([id, m]);
    await r.handleSignal('b', { kind: 'offer', sdp: 'x' });
    links[0]!.onMessage('{"t":"input"}');
    expect(got).toEqual([['b', { t: 'input' }]]);
    r.broadcast({ t: 'snap' });
    expect(links[0]!.sent).toEqual(['{"t":"snap"}']);
  });

  test('host does not give up on a dead client link; it waits for a new offer', async () => {
    const r = room('a', 'a', [player('a', true), player('b')]);
    await r.handleSignal('b', { kind: 'offer', sdp: '1' });
    links[0]!.set('failed');
    vi.advanceTimersByTime(60_000);
    expect(links).toHaveLength(1); // host never re-offers
    expect(r.hostLinkLost).toBe(false);
  });
});

describe('state and events', () => {
  test('canStart needs the host, enough players, and everyone ready', () => {
    const r = room('a', 'a', [player('a', true, true), player('b')]);
    expect(r.canStart).toBe(false);
    r.handleRoomState(summary('a'), [player('a', true, true), player('b', false, true)]);
    expect(r.canStart).toBe(true);
    expect(r.start()).toBe(true);
    expect(signals).toContainEqual({ type: 'lobbyStart' });
  });

  test('joined / left / ready events, but not for yourself or on the first state', () => {
    const r = room('a', 'a', [player('a', true), player('b')]);
    expect(r.tick()).toEqual([]);
    r.handleRoomState(summary('a'), [player('a', true), player('b', false, true), player('c')]);
    expect(r.tick()).toEqual([
      { type: 'joined', name: 'C' },
      { type: 'ready', name: 'B' },
    ]);
    r.handleRoomState(summary('a'), [player('a', true), player('c')]);
    expect(r.tick()).toEqual([{ type: 'left', name: 'B' }]);
    r.handlePrepare(15000);
    r.handleGo(3900);
    expect(r.tick()).toEqual([
      { type: 'prepare', timeoutMs: 15000 },
      { type: 'go', startInMs: 3900 },
    ]);
    expect(r.phase).toBe('racing');
    r.handleAbort('c', 'C', 'hidden');
    expect(r.tick()).toEqual([{ type: 'abort', who: 'c', name: 'C', reason: 'hidden' }]);
    expect(r.started).toBe(false);
  });

  test('dispose closes every link and clears handlers', () => {
    const r = room('b', 'a', [player('a', true), player('b')]);
    r.onHostMessage = () => {};
    r.dispose();
    expect(links[0]!.closed).toBe(true);
    expect(r.onHostMessage).toBeNull();
  });
});
