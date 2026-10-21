/**
 * A small profanity filter for names people see (player names, room names). It normalises look-alike characters and
 * separators ("f.u-c_k", "sh1t", "fuuuck") and then looks for whole words and, for the unambiguous ones, for the word
 * inside a longer string. It is a first line of defence for a kids-friendly portal, not a complete moderation system.
 */

/** Look-alikes mapped to letters. */
const LEET: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '8': 'b',
  '@': 'a',
  $: 's',
  '!': 'i',
  '|': 'i',
  '+': 't',
};

/** Whole words only (they appear inside harmless words, such as "cockpit" or "assist"). */
const WORDS = new Set([
  'ass',
  'arse',
  'bitch',
  'bastard',
  'bollocks',
  'cock',
  'cum',
  'dick',
  'douche',
  'fag',
  'fuck',
  'hoe',
  'jerk',
  'nazi',
  'piss',
  'porn',
  'prick',
  'pussy',
  'rape',
  'rapist',
  'sex',
  'shit',
  'slut',
  'tit',
  'tits',
  'twat',
  'wank',
  'whore',
  'nigga',
  'nigger',
  'retard',
  'cunt',
  'dildo',
  'penis',
  'vagina',
  'anus',
  'kys',
]);

/** Long and unambiguous: refused anywhere inside the name. */
const INSIDE = [
  'fuck',
  'shitt',
  'bullshit',

  'nigg',
  'faggot',
  'whore',
  'slut',
  'bitch',
  'wanker',

  'dickhead',
  'asshole',
  'motherf',

  'nazi',

  'pussy',
  'blowjob',
  'handjob',
  'cocksuck',
  'jizz',
  'porn',
  'hitler',
  'kkk',
];

/** Letters only, look-alikes mapped, separators turned into spaces. */
export function normalise(text: string): string {
  let out = '';
  for (const ch of text.toLowerCase().normalize('NFKD')) out += LEET[ch] ?? ch;
  return out
    .replace(/[^a-z\s]/g, (c) => (/[\s_.\-,;:]/.test(c) ? ' ' : ''))
    .replace(/\s+/g, ' ')
    .trim();
}

/** A word as a pattern that allows stretched letters ("fuuuck") but keeps double letters double (so "as" is not "ass"). */
function stretch(word: string): string {
  return word.replace(/(.)\1*/g, (run, ch: string) => `${ch}{${run.length},}`);
}
const wordRe = [...WORDS].map((w) => new RegExp(`^${stretch(w)}(s|ing|ed)?$`));
const insideRe = INSIDE.map((w) => new RegExp(stretch(w)));

/** True when the text contains a word the portal would not want shown. */
export function isProfane(text: string): boolean {
  const n = normalise(text);
  if (!n) return false;
  const tokens = n.split(' ');
  if (tokens.some((t) => wordRe.some((re) => re.test(t)))) return true;
  // Letters split up by separators ("f u c k"): glue runs of single letters together.
  let run = '';
  const glued: string[] = [];
  for (const t of tokens) {
    if (t.length === 1) run += t;
    else {
      if (run.length >= 3) glued.push(run);
      run = '';
    }
  }
  if (run.length >= 3) glued.push(run);
  if (glued.some((g) => wordRe.some((re) => re.test(g)))) return true;
  // The unambiguous ones anywhere in the name, spaces removed ("mother fucker", "bit.ch").
  const flat = tokens.join('');
  return insideRe.some((re) => re.test(flat));
}
