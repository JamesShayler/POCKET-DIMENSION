import { Rng } from './rng';

/** Syllable-based name generation shared by animals and languages (languages specialise it, see languages.ts). */
export interface Phonology {
  onsets: string[];
  vowels: string[];
  codas: string[];
}

export const BASE_ONSETS = ['b', 'd', 'f', 'g', 'h', 'k', 'l', 'm', 'n', 'p', 'r', 's', 't', 'v', 'z', 'th', 'sh', 'br', 'tr', 'kr', 'gl', 'st', 'j', 'w', 'y'];
export const BASE_VOWELS = ['a', 'e', 'i', 'o', 'u', 'ae', 'ia', 'ou', 'ei'];
export const BASE_CODAS = ['', '', '', 'n', 'r', 's', 'l', 'th', 'k', 'm', 'x'];

export function randomPhonology(rng: Rng): Phonology {
  const pickSome = (src: string[], min: number, max: number) => {
    const n = min + rng.int(max - min + 1);
    const pool = [...src];
    const out: string[] = [];
    while (out.length < n && pool.length) out.push(pool.splice(rng.int(pool.length), 1)[0]);
    return out;
  };
  return {
    onsets: pickSome(BASE_ONSETS, 8, 13),
    vowels: pickSome(BASE_VOWELS, 4, 6),
    codas: ['', ...pickSome(BASE_CODAS.filter((c) => c), 3, 5)],
  };
}

export function makeWord(ph: Phonology, rng: Rng, syllables = 2 + rng.int(2)): string {
  let w = '';
  for (let i = 0; i < syllables; i++) {
    w += rng.pick(ph.onsets) + rng.pick(ph.vowels);
    if (i === syllables - 1 || rng.chance(0.25)) w += rng.pick(ph.codas);
  }
  return w.charAt(0).toUpperCase() + w.slice(1);
}

export const NATURAL_PHONOLOGY: Phonology = {
  onsets: ['v', 'k', 'th', 'm', 'r', 'z', 'b', 'l', 'n', 's', 'tr', 'gl', 'br'],
  vowels: ['a', 'e', 'i', 'o', 'u', 'ae'],
  codas: ['', '', 'n', 'r', 'x', 'l'],
};
