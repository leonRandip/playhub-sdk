import { describe, expect, it } from 'vitest';
import { isProfane } from '../src/profanity.ts';

describe('profanity filter', () => {
  it('refuses plain, disguised and stretched words', () => {
    for (const t of [
      'fuck',
      'FUCK you',
      'f.u.c.k',
      'f u c k',
      'fuuuuck',
      'sh1t',
      'b!tch',
      '$hit',
      'a$$hole',
      'motherfucker',
      'mother fucker',
      'p0rn',
      'n1gg3r',
      'shitting',
      'whores',
    ])
      expect(isProfane(t), t).toBe(true);
  });

  it('lets ordinary names and racing words through (no Scunthorpe problem)', () => {
    for (const t of [
      'Racer1234',
      'DriftOtter42',
      'Cockpit',
      'Assist',
      'Class A',
      'as fast as',
      'Scunthorpe',
      'Dickinson',
      'Peniston',
      'Analyst',
      'Therapist',
      'Pass',
      'Grass',
      'Bassline',
      'Massive',
      'Hello World',
      'Turbo_Fox',
      'Mishap',
      'Sextant',
      'Tito',
      'Titan',
      'Hoedown',
    ])
      expect(isProfane(t), t).toBe(false);
  });

  it('empty and punctuation-only text is fine', () => {
    expect(isProfane('')).toBe(false);
    expect(isProfane('---')).toBe(false);
  });
});
