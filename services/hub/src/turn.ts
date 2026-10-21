import { createHmac } from 'node:crypto';
import type { IceServer } from '@playhub/protocol';

/**
 * Where a player's TURN relay comes from. The hub never cares which: it asks a provider for the
 * ICE servers to put in `lobbyWelcome`. Swap the provider with `TURN_PROVIDER` and nothing else
 * changes, so the interim "Cloudflare relays, a small VM only does signaling" setup can later
 * move to "our own coturn on a bigger VM" (or anything else) by changing environment variables.
 *
 * A provider must never throw into the join path: failures fall back to STUN only (direct
 * connections still work for most players; only the ~10-20 % behind strict NATs need the relay).
 */
export interface TurnProvider {
  readonly name: string;
  iceServers(playerId: string): Promise<IceServer[]>;
}

export const PUBLIC_STUN = 'stun:stun.l.google.com:19302';
export const STUN_ONLY: IceServer[] = [{ urls: PUBLIC_STUN }];

/** STUN only: no relay. Players on the same network or with friendly NATs still connect. */
export class NoTurn implements TurnProvider {
  readonly name = 'none';
  async iceServers(): Promise<IceServer[]> {
    return STUN_ONLY;
  }
}

// ── coturn (our own server) ──────────────────────────────────────────────────────────────────────

export interface CoturnConfig {
  /** Public hostname of the coturn server (turn.example.com). */
  host: string;
  /** Shared with coturn's `static-auth-secret` (use-auth-secret mode). */
  secret: string;
  /** Credential lifetime. */
  ttlSeconds: number;
  /** Also advertise turns: on 5349 (needs a certificate on coturn). */
  tls?: boolean;
}

/**
 * ICE servers for one player from our own coturn. Credentials follow coturn's REST-API scheme: the
 * username is the expiry timestamp (plus an id for the logs) and the password is
 * base64(HMAC-SHA1(secret, username)), so nothing static ships to the client and a leaked
 * credential dies within `ttlSeconds`.
 */
export function coturnIceServers(
  playerId: string,
  turn: CoturnConfig,
  now = Date.now(),
): IceServer[] {
  const expiry = Math.floor(now / 1000) + turn.ttlSeconds;
  const username = `${expiry}:${playerId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32)}`;
  const credential = createHmac('sha1', turn.secret).update(username).digest('base64');
  const urls = [`turn:${turn.host}:3478?transport=udp`, `turn:${turn.host}:3478?transport=tcp`];
  if (turn.tls) urls.push(`turns:${turn.host}:5349?transport=tcp`);
  return [{ urls: PUBLIC_STUN }, { urls, username, credential }];
}

export class CoturnTurn implements TurnProvider {
  readonly name = 'coturn';
  constructor(
    private readonly cfg: CoturnConfig,
    private readonly now: () => number = Date.now,
  ) {}
  async iceServers(playerId: string): Promise<IceServer[]> {
    return coturnIceServers(playerId, this.cfg, this.now());
  }
}

// ── Cloudflare Realtime TURN ─────────────────────────────────────────────────────────────────────

export interface CloudflareConfig {
  /** The TURN key's id (Cloudflare dashboard → Realtime → TURN). */
  keyId: string;
  /** That key's API token. A secret: never logged. */
  apiToken: string;
  /** Lifetime of the credentials Cloudflare mints, seconds. */
  ttlSeconds: number;
}

export type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface CloudflareOptions {
  fetch?: Fetch;
  now?: () => number;
  /** Give up on one API call after this long, ms. */
  timeoutMs?: number;
  /** After a failed call, don't try again for this long, ms (don't hammer a failing API). */
  retryAfterMs?: number;
  log?: (msg: string) => void;
}

const CLOUDFLARE_API = 'https://rtc.live.cloudflare.com/v1/turn/keys';

/**
 * Cloudflare Realtime TURN: one API call mints credentials (and the server list) valid for
 * `ttlSeconds`. They are not per-player secrets (a relay credential is only worth the bandwidth
 * until it expires), so ONE set is cached and handed to every player and refreshed at half its
 * lifetime: a handful of API calls a day however many players join, and every player always gets
 * credentials with at least half the TTL left (long enough to reconnect mid-session). On failure
 * the last good set is reused while it is still valid, otherwise STUN only.
 */
export class CloudflareTurn implements TurnProvider {
  readonly name = 'cloudflare';
  private cached: { servers: IceServer[]; refreshAt: number; expiresAt: number } | null = null;
  private inflight: Promise<void> | null = null;
  private retryAt = 0;
  private readonly fetchFn: Fetch;
  private readonly now: () => number;

  constructor(
    private readonly cfg: CloudflareConfig,
    private readonly opts: CloudflareOptions = {},
  ) {
    this.fetchFn = opts.fetch ?? (globalThis.fetch as unknown as Fetch);
    this.now = opts.now ?? Date.now;
  }

  async iceServers(): Promise<IceServer[]> {
    const t = this.now();
    if (!this.cached || t >= this.cached.refreshAt) await this.refresh(t);
    const c = this.cached;
    return c && this.now() < c.expiresAt ? c.servers : STUN_ONLY;
  }

  private refresh(t: number): Promise<void> {
    if (this.inflight) return this.inflight; // single flight: concurrent joins share one call
    if (t < this.retryAt) return Promise.resolve();
    this.inflight = this.fetchCredentials()
      .then((servers) => {
        const at = this.now();
        this.cached = {
          servers,
          refreshAt: at + (this.cfg.ttlSeconds * 1000) / 2,
          expiresAt: at + this.cfg.ttlSeconds * 1000,
        };
      })
      .catch((e: unknown) => {
        this.retryAt = this.now() + (this.opts.retryAfterMs ?? 30_000);
        this.opts.log?.(`cloudflare turn: ${e instanceof Error ? e.message : 'request failed'}`);
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  private async fetchCredentials(): Promise<IceServer[]> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? 3000);
    try {
      const res = await this.fetchFn(
        `${CLOUDFLARE_API}/${encodeURIComponent(this.cfg.keyId)}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: {
            // The token only ever goes in this header.
            Authorization: `Bearer ${this.cfg.apiToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ttl: this.cfg.ttlSeconds }),
          signal: ctl.signal,
        },
      );
      if (!res.ok) throw new Error(`API answered HTTP ${res.status}`);
      const body = (await res.json()) as { iceServers?: unknown };
      return parseIceServers(body.iceServers);
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── static list (any provider that hands out fixed credentials, e.g. Metered Open Relay) ─────────

export class StaticTurn implements TurnProvider {
  readonly name = 'static';
  constructor(private readonly servers: IceServer[]) {}
  async iceServers(): Promise<IceServer[]> {
    return this.servers;
  }
}

/** Validates an `iceServers` array from an API or a config value; throws on anything malformed. */
export function parseIceServers(raw: unknown): IceServer[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('no iceServers in the response');
  return raw.map((s, i) => {
    if (!s || typeof s !== 'object') throw new Error(`iceServers[${i}] is not an object`);
    const e = s as Record<string, unknown>;
    const urls = e['urls'];
    const ok =
      typeof urls === 'string' ||
      (Array.isArray(urls) && urls.length > 0 && urls.every((u) => typeof u === 'string'));
    if (!ok) throw new Error(`iceServers[${i}].urls must be a string or string array`);
    const out: IceServer = { urls: urls as string | string[] };
    if (typeof e['username'] === 'string') out.username = e['username'];
    if (typeof e['credential'] === 'string') out.credential = e['credential'];
    return out;
  });
}

// ── choosing one from the environment ────────────────────────────────────────────────────────────

/**
 * `TURN_PROVIDER` = none | coturn | cloudflare | static. When unset it is `coturn` if TURN_HOST and
 * TURN_SECRET are present (the original behaviour), else `none`. Missing settings for the chosen
 * provider are an error at startup, not a surprise at the first join.
 */
export function createTurnProvider(
  env: NodeJS.ProcessEnv = process.env,
  opts: CloudflareOptions = {},
): TurnProvider {
  const named = env['TURN_PROVIDER']?.trim().toLowerCase();
  const kind = named || (env['TURN_HOST'] && env['TURN_SECRET'] ? 'coturn' : 'none');
  const need = (key: string): string => {
    const v = env[key];
    if (!v) throw new Error(`TURN_PROVIDER=${kind} needs ${key}`);
    return v;
  };
  switch (kind) {
    case 'none':
      return new NoTurn();
    case 'coturn':
      return new CoturnTurn({
        host: need('TURN_HOST'),
        secret: need('TURN_SECRET'),
        ttlSeconds: Number(env['TURN_TTL_SECONDS'] ?? 3600),
        tls: env['TURN_TLS'] === '1',
      });
    case 'cloudflare':
      return new CloudflareTurn(
        {
          keyId: need('CLOUDFLARE_TURN_KEY_ID'),
          apiToken: need('CLOUDFLARE_TURN_API_TOKEN'),
          ttlSeconds: Number(env['TURN_TTL_SECONDS'] ?? 86_400),
        },
        opts,
      );
    case 'static': {
      let list: unknown;
      try {
        list = JSON.parse(need('TURN_STATIC_JSON'));
      } catch {
        throw new Error('TURN_STATIC_JSON is not valid JSON');
      }
      return new StaticTurn(parseIceServers(list));
    }
    default:
      throw new Error(`unknown TURN_PROVIDER "${kind}" (none | coturn | cloudflare | static)`);
  }
}
