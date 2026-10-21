import { expect, test } from 'vitest';
import {
  ClientMessage,
  GameId,
  peekType,
  PlayerInfo,
  ROOM_CODE_LENGTH,
  RoomCode,
  ServerMessage,
} from '../src/index.ts';

test('room codes: 4 to 6 letters, no I/L/O (new rooms get 6)', () => {
  for (const ok of ['ABCD', 'ABCDE', 'ABCDEF']) expect(RoomCode.safeParse(ok).success).toBe(true);
  for (const bad of ['ABC', 'ABCDEFG', 'abcdef', 'ABIOKM', 'ALCDEF', 'AB1DEF'])
    expect(RoomCode.safeParse(bad).success).toBe(false);
  expect(ROOM_CODE_LENGTH).toBe(6);
});

test('game ids are lower-case slugs', () => {
  expect(GameId.safeParse('kart-racer').success).toBe(true);
  for (const bad of ['K', 'Kart', '-kart', 'a b', 'x'.repeat(40)])
    expect(GameId.safeParse(bad).success).toBe(false);
});

test('player profile defaults to {} and keeps arbitrary game data', () => {
  expect(PlayerInfo.parse({ id: 'a', name: 'A' }).profile).toEqual({});
  expect(PlayerInfo.parse({ id: 'a', name: 'A', profile: { car: 'x', lvl: 3 } }).profile).toEqual({
    car: 'x',
    lvl: 3,
  });
});

test('client/server messages round-trip through their schemas', () => {
  expect(
    ClientMessage.safeParse({
      type: 'lobbyCreate',
      name: 'r',
      visibility: 'public',
      settings: {},
      maxPlayers: 4,
    }).success,
  ).toBe(true);
  expect(
    ClientMessage.safeParse({
      type: 'lobbyCreate',
      name: 'r',
      visibility: 'x',
      settings: {},
      maxPlayers: 4,
    }).success,
  ).toBe(false);
  expect(
    ServerMessage.safeParse({ type: 'lobbyWelcome', you: 'a', iceServers: [{ urls: 'stun:x' }] })
      .success,
  ).toBe(true);
});

test('peekType reads the type without parsing', () => {
  expect(peekType('{"type":"lobbyHello","v":1}')).toBe('lobbyHello');
  expect(peekType('nope')).toBeNull();
});
