import { createHmac } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';
import {
  CloudflareTurn,
  CoturnTurn,
  createTurnProvider,
  type Fetch,
  NoTurn,
  parseIceServers,
  STUN_ONLY,
  StaticTurn,
} from '../src/turn.ts';

describe('none and static', () => {
  test('none is STUN only', async () => {
    expect(await new NoTurn().iceServers()).toEqual([{ urls: 'stun:stun.l.google.com:19302' }]);
  });
  test('static hands out its list as given', async () => {
    const list = [{ urls: 'turn:x:80', username: 'u', credential: 'c' }];
    expect(await new StaticTurn(list).iceServers()).toEqual(list);
  });
});

describe('coturn', () => {
  test('credentials follow coturn use-auth-secret (HMAC-SHA1, expiring username)', async () => {
    const now = 1_700_000_000_000;
    const p = new CoturnTurn({ host: 't.example', secret: 's3cret', ttlSeconds: 3600 }, () => now);
    const [stun, turn] = await p.iceServers('pl/ayer 1');
    expect(stun).toEqual({ urls: 'stun:stun.l.google.com:19302' });
    expect(turn!.username).toBe(`${1_700_003_600}:player1`);
    expect(turn!.credential).toBe(
      createHmac('sha1', 's3cret').update(turn!.username!).digest('base64'),
    );
    expect(turn!.urls).toEqual([
      'turn:t.example:3478?transport=udp',
      'turn:t.example:3478?transport=tcp',
    ]);
  });

  test('turns: is advertised only when TLS is enabled', async () => {
    const p = new CoturnTurn({ host: 't.example', secret: 'x', ttlSeconds: 60, tls: true });
    const [, turn] = await p.iceServers('a');
    expect(turn!.urls).toContain('turns:t.example:5349?transport=tcp');
  });
});

describe('cloudflare', () => {
  const relay = {
    iceServers: [
      { urls: ['stun:stun.cloudflare.com:3478'] },
      {
        urls: [
          'turn:turn.cloudflare.com:3478?transport=udp',
          'turns:turn.cloudflare.com:443?transport=tcp',
        ],
        username: 'cf-user',
        credential: 'cf-secret',
      },
    ],
  };
  const reply = (body: unknown, status = 201): ReturnType<Fetch> =>
    Promise.resolve({ ok: status < 300, status, json: async () => body });
  const cfg = { keyId: 'KEY1', apiToken: 'TOKEN-XYZ', ttlSeconds: 1000 };

  function make(fetchImpl: Fetch, at = { t: 0 }) {
    const log = vi.fn();
    const p = new CloudflareTurn(cfg, {
      fetch: fetchImpl,
      now: () => at.t,
      log,
      retryAfterMs: 30_000,
      timeoutMs: 50,
    });
    return { p, log, at };
  }

  test('asks the documented endpoint with the key id, bearer token and ttl', async () => {
    const fetch = vi.fn<Fetch>(() => reply(relay));
    const { p } = make(fetch);
    expect(await p.iceServers()).toEqual(relay.iceServers);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(
      'https://rtc.live.cloudflare.com/v1/turn/keys/KEY1/credentials/generate-ice-servers',
    );
    expect(init.method).toBe('POST');
    expect(init.headers['Authorization']).toBe('Bearer TOKEN-XYZ');
    expect(JSON.parse(init.body)).toEqual({ ttl: 1000 });
  });

  test('one call serves every player; concurrent joins share a single flight', async () => {
    const fetch = vi.fn<Fetch>(() => reply(relay));
    const { p } = make(fetch);
    await Promise.all([p.iceServers(), p.iceServers(), p.iceServers()]);
    await p.iceServers();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('refreshes at half the ttl, so handed-out credentials always have half left', async () => {
    const fetch = vi.fn<Fetch>(() => reply(relay));
    const { p, at } = make(fetch);
    await p.iceServers();
    at.t = 499_000;
    await p.iceServers();
    expect(fetch).toHaveBeenCalledTimes(1);
    at.t = 500_000;
    await p.iceServers();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('an API failure falls back to STUN, logs without the token, and backs off', async () => {
    const fetch = vi.fn<Fetch>(() => reply({}, 401));
    const { p, log, at } = make(fetch);
    expect(await p.iceServers()).toEqual(STUN_ONLY);
    expect(await p.iceServers()).toEqual(STUN_ONLY);
    expect(fetch).toHaveBeenCalledTimes(1); // not retried at once
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]![0])).toContain('HTTP 401');
    expect(String(log.mock.calls[0]![0])).not.toContain('TOKEN-XYZ');
    at.t = 31_000;
    await p.iceServers();
    expect(fetch).toHaveBeenCalledTimes(2); // after the back-off
  });

  test('a failed refresh keeps serving the last good credentials until they expire', async () => {
    let ok = true;
    const fetch = vi.fn<Fetch>(() => (ok ? reply(relay) : reply({}, 500)));
    const { p, at } = make(fetch);
    await p.iceServers();
    ok = false;
    at.t = 600_000; // past the refresh point, before expiry (1 000 s)
    expect(await p.iceServers()).toEqual(relay.iceServers);
    at.t = 1_100_000; // expired
    at.t += 31_000;
    expect(await p.iceServers()).toEqual(STUN_ONLY);
  });

  test('a hung API call is abandoned after the timeout', async () => {
    const fetch: Fetch = (_url, init) =>
      new Promise((_, reject) =>
        init.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
      );
    const { p, log } = make(fetch);
    expect(await p.iceServers()).toEqual(STUN_ONLY);
    expect(log).toHaveBeenCalled();
  });

  test('a malformed response is a failure, not a crash', async () => {
    const { p } = make(() => reply({ iceServers: [{ nope: 1 }] }));
    expect(await p.iceServers()).toEqual(STUN_ONLY);
  });
});

describe('parseIceServers', () => {
  test('accepts strings and arrays, keeps credentials, rejects the malformed', () => {
    expect(
      parseIceServers([{ urls: 'stun:x' }, { urls: ['turn:y'], username: 'u', credential: 'c' }]),
    ).toEqual([{ urls: 'stun:x' }, { urls: ['turn:y'], username: 'u', credential: 'c' }]);
    expect(() => parseIceServers([])).toThrow();
    expect(() => parseIceServers('x')).toThrow();
    expect(() => parseIceServers([{ urls: [] }])).toThrow();
    expect(() => parseIceServers([{ urls: 5 }])).toThrow();
  });
});

describe('createTurnProvider (environment)', () => {
  test('defaults: none, or coturn when the old TURN_HOST/TURN_SECRET are set', () => {
    expect(createTurnProvider({}).name).toBe('none');
    expect(createTurnProvider({ TURN_HOST: 'h', TURN_SECRET: 's' }).name).toBe('coturn');
  });
  test('TURN_PROVIDER picks one explicitly, case-insensitively', () => {
    expect(createTurnProvider({ TURN_PROVIDER: 'NONE' }).name).toBe('none');
    expect(
      createTurnProvider({
        TURN_PROVIDER: 'cloudflare',
        CLOUDFLARE_TURN_KEY_ID: 'k',
        CLOUDFLARE_TURN_API_TOKEN: 't',
      }).name,
    ).toBe('cloudflare');
    expect(
      createTurnProvider({ TURN_PROVIDER: 'static', TURN_STATIC_JSON: '[{"urls":"turn:z"}]' }).name,
    ).toBe('static');
    expect(
      createTurnProvider({ TURN_PROVIDER: 'coturn', TURN_HOST: 'h', TURN_SECRET: 's' }).name,
    ).toBe('coturn');
  });
  test('missing settings or an unknown provider fail at startup with a clear message', () => {
    expect(() => createTurnProvider({ TURN_PROVIDER: 'cloudflare' })).toThrow(
      /CLOUDFLARE_TURN_KEY_ID/,
    );
    expect(() =>
      createTurnProvider({ TURN_PROVIDER: 'cloudflare', CLOUDFLARE_TURN_KEY_ID: 'k' }),
    ).toThrow(/CLOUDFLARE_TURN_API_TOKEN/);
    expect(() => createTurnProvider({ TURN_PROVIDER: 'coturn' })).toThrow(/TURN_HOST/);
    expect(() => createTurnProvider({ TURN_PROVIDER: 'static' })).toThrow(/TURN_STATIC_JSON/);
    expect(() => createTurnProvider({ TURN_PROVIDER: 'static', TURN_STATIC_JSON: '{' })).toThrow(
      /valid JSON/,
    );
    expect(() => createTurnProvider({ TURN_PROVIDER: 'nope' })).toThrow(/unknown TURN_PROVIDER/);
  });
});
