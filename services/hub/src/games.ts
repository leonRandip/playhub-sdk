/**
 * The games a hub serves. Adding a game is one entry in `games.json` — no code change. Each game is
 * a namespace: its rooms, room codes and player lists are invisible to every other game.
 */

/** Declarative check for one key of a room's `settings` (kept tiny; the hub never runs game code). */
export type SettingSpec =
  | { type: 'string'; enum?: string[]; maxLength?: number; optional?: boolean }
  | { type: 'number'; min?: number; max?: number; integer?: boolean; optional?: boolean }
  | { type: 'boolean'; optional?: boolean };

export interface GameConfig {
  id: string;
  name: string;
  /** Web origins allowed to connect (exact match, e.g. https://game.example.com). Empty = any. */
  origins: string[];
  /** Hard cap on players per room for this game. */
  maxPlayers: number;
  /** How long a start waits for every player to load and report ready, ms (default: the hub's
   * `prepareTimeoutMs`). A game with big tracks may want more. */
  prepareTimeoutMs?: number;
  /** When set, `lobbyCreate.settings` must match (unknown keys are rejected). */
  settings?: Record<string, SettingSpec>;
}

export const DEFAULT_LIMITS = {
  /** Serialized JSON size caps, so a client can't park megabytes in room state. */
  settingsBytes: 2048,
  profileBytes: 1024,
};

export function parseGames(raw: unknown): Map<string, GameConfig> {
  if (!Array.isArray(raw)) throw new Error('games config must be an array');
  const games = new Map<string, GameConfig>();
  for (const g of raw) {
    if (!g || typeof g !== 'object') throw new Error('bad game entry');
    const e = g as Record<string, unknown>;
    const id = String(e['id'] ?? '');
    if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(id)) throw new Error(`bad game id "${id}"`);
    if (games.has(id)) throw new Error(`duplicate game id "${id}"`);
    const maxPlayers = Number(e['maxPlayers'] ?? 8);
    if (!Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > 64)
      throw new Error(`game ${id}: maxPlayers must be 2..64`);
    const origins = e['origins'] ?? [];
    if (!Array.isArray(origins) || !origins.every((o) => typeof o === 'string'))
      throw new Error(`game ${id}: origins must be a string array`);
    games.set(id, {
      id,
      name: String(e['name'] ?? id),
      origins: origins as string[],
      maxPlayers,
      ...(e['prepareTimeoutMs'] !== undefined
        ? { prepareTimeoutMs: Number(e['prepareTimeoutMs']) }
        : {}),
      settings: e['settings'] as GameConfig['settings'],
    });
  }
  return games;
}

export function originAllowed(game: GameConfig, origin: string | undefined): boolean {
  if (game.origins.length === 0 || game.origins.includes('*')) return true;
  // Native/server clients send no Origin; browsers always do, and can't forge it.
  if (origin === undefined) return true;
  return game.origins.some((o) => originMatches(o, origin));
}

/**
 * An allowed-origin entry matches exactly, or as `https://*.example.com`: the same scheme and any host that ends in
 * `.example.com` (at least one label before it; the bare `example.com` and look-alikes such as
 * `evilexample.com` do not match).
 */
export function originMatches(pattern: string, origin: string): boolean {
  if (pattern === origin) return true;
  const m = /^([a-z][a-z0-9+.-]*):\/\/\*\.([a-z0-9.-]+)(:\d+)?$/i.exec(pattern);
  if (!m) return false;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol !== `${m[1]!.toLowerCase()}:`) return false;
  if (m[3] && `:${u.port}` !== m[3]) return false;
  const host = u.hostname.toLowerCase();
  const suffix = `.${m[2]!.toLowerCase()}`;
  return host.endsWith(suffix) && host.length > suffix.length;
}

/** Returns an error message, or null when `settings` satisfies the game's spec (or there is none). */
export function checkSettings(game: GameConfig, settings: Record<string, unknown>): string | null {
  if (JSON.stringify(settings).length > DEFAULT_LIMITS.settingsBytes) return 'settings too large';
  const spec = game.settings;
  if (!spec) return null;
  for (const key of Object.keys(settings)) if (!(key in spec)) return `unknown setting "${key}"`;
  for (const [key, s] of Object.entries(spec)) {
    const v = settings[key];
    if (v === undefined) {
      if (s.optional) continue;
      return `missing setting "${key}"`;
    }
    if (s.type === 'string') {
      if (typeof v !== 'string') return `"${key}" must be a string`;
      if (s.enum && !s.enum.includes(v)) return `"${key}" must be one of ${s.enum.join(', ')}`;
      if (v.length > (s.maxLength ?? 64)) return `"${key}" is too long`;
    } else if (s.type === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v)) return `"${key}" must be a number`;
      if (s.integer && !Number.isInteger(v)) return `"${key}" must be an integer`;
      if (s.min !== undefined && v < s.min) return `"${key}" must be ≥ ${s.min}`;
      if (s.max !== undefined && v > s.max) return `"${key}" must be ≤ ${s.max}`;
    } else if (typeof v !== 'boolean') return `"${key}" must be a boolean`;
  }
  return null;
}
