import { expect, test } from 'vitest';
import { checkSettings, originAllowed, parseGames } from '../src/games.ts';

test('parseGames validates ids, caps and duplicates', () => {
  expect(() => parseGames([{ id: 'Bad Id' }])).toThrow(/bad game id/);
  expect(() => parseGames([{ id: 'a1', maxPlayers: 1 }])).toThrow(/maxPlayers/);
  expect(() => parseGames([{ id: 'a1' }, { id: 'a1' }])).toThrow(/duplicate/);
  expect(() => parseGames({})).toThrow(/array/);
  expect(parseGames([{ id: 'a1' }]).get('a1')).toMatchObject({ maxPlayers: 8, origins: [] });
});

test('originAllowed: exact match, wildcard, empty list, native clients', () => {
  const [g] = [...parseGames([{ id: 'ab', origins: ['https://x.example'] }]).values()];
  expect(originAllowed(g!, 'https://x.example')).toBe(true);
  expect(originAllowed(g!, 'https://x.example.evil.com')).toBe(false);
  expect(originAllowed(g!, undefined)).toBe(true);
  const [any] = [...parseGames([{ id: 'ab', origins: ['*'] }]).values()];
  expect(originAllowed(any!, 'https://whatever')).toBe(true);
});

test('checkSettings enforces types, ranges, enums and optional keys', () => {
  const [g] = [
    ...parseGames([
      {
        id: 'ab',
        settings: {
          mode: { type: 'string', enum: ['race', 'trial'] },
          laps: { type: 'number', integer: true, min: 1, max: 5 },
          hard: { type: 'boolean', optional: true },
        },
      },
    ]).values(),
  ];
  expect(checkSettings(g!, { mode: 'race', laps: 3 })).toBeNull();
  expect(checkSettings(g!, { mode: 'race', laps: 3, hard: true })).toBeNull();
  expect(checkSettings(g!, { mode: 'x', laps: 3 })).toMatch(/one of/);
  expect(checkSettings(g!, { mode: 'race', laps: 9 })).toMatch(/≤ 5/);
  expect(checkSettings(g!, { mode: 'race', laps: 2.5 })).toMatch(/integer/);
  expect(checkSettings(g!, { mode: 'race', laps: 2, hard: 'y' })).toMatch(/boolean/);
});
