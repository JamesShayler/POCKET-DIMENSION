import { Rng, clamp } from './rng';
import { makeWord, Phonology } from './names';

export const VALUE_KEYS = ['openness', 'martial', 'collectivism', 'spirituality', 'hierarchy', 'commerce'] as const;
export const NV = VALUE_KEYS.length;

export const TRADITION_POOLS = {
  clothing: ['hides and furs', 'woven wool', 'feathered cloaks', 'bark cloth', 'dyed linen', 'painted skins'],
  architecture: ['reed huts', 'stone cairns', 'timber longhouses', 'mud-brick houses', 'cave dwellings', 'domed shelters'],
  food: ['smoked meat', 'flat breads', 'fermented drinks', 'roasted roots', 'dried fish', 'spiced stews'],
  music: ['drum circles', 'bone flutes', 'chanted epics', 'string lyres', 'throat singing', 'clapped rhythms'],
  rituals: ['sun greetings', 'ancestor feasts', 'river offerings', 'fire vigils', 'coming-of-age trials', 'harvest dances'],
  customs: ['shared hearths', 'gift exchange', 'silent mornings', 'oath stones', 'hospitality to strangers', 'name-day vigils'],
  laws: ['elder judgement', 'blood price', 'communal oaths', 'exile for theft', 'equal shares', 'chief decides'],
} as const;
export type TraditionKey = keyof typeof TRADITION_POOLS;
export const TRADITION_KEYS = Object.keys(TRADITION_POOLS) as TraditionKey[];

export interface Culture {
  id: number;
  name: string;
  parent: number;
  language: number;
  born: number;
  values: Float32Array; // 0..1
  traditions: Record<TraditionKey, string>;
  symbol: string;
  color: number; // hue 0..1
  founder?: number;
  /** Why this culture exists, in one line. */
  origin: string;
}

const SYMBOLS = ['☉', '☽', '△', '◇', '≈', '✦', '⌘', '⚘', '☗', '⛬', '❖', '⚶'];

export class Cultures {
  list: Culture[] = [];
  next = 1;
  create(rng: Rng, day: number, language: number, phon: Phonology, parent: Culture | undefined, origin: string, shiftValues?: Float32Array): Culture {
    const id = this.next++;
    const values = new Float32Array(NV);
    const traditions = {} as Record<TraditionKey, string>;
    if (parent) {
      for (let k = 0; k < NV; k++) values[k] = clamp(parent.values[k] + rng.gauss() * 0.12 + (shiftValues ? shiftValues[k] * 0.3 : 0));
      for (const k of TRADITION_KEYS) traditions[k] = parent.traditions[k];
      // two traditions change on divergence
      for (let n = 0; n < 2; n++) {
        const k = rng.pick(TRADITION_KEYS);
        traditions[k] = rng.pick(TRADITION_POOLS[k]);
      }
    } else {
      for (let k = 0; k < NV; k++) values[k] = rng.range(0.25, 0.75);
      for (const k of TRADITION_KEYS) traditions[k] = rng.pick(TRADITION_POOLS[k]);
    }
    const c: Culture = {
      id, name: makeWord(phon, rng, 2), parent: parent?.id ?? 0, language, born: day, values, traditions,
      symbol: parent && rng.chance(0.6) ? parent.symbol : rng.pick(SYMBOLS),
      color: parent ? (parent.color + rng.range(-0.08, 0.08) + 1) % 1 : rng.next(), origin,
    };
    this.list.push(c);
    return c;
  }
  get(id: number): Culture | undefined {
    return this.list[id - 1];
  }
  /** Cultural distance 0..1. */
  distance(a: Culture, b: Culture): number {
    let d = 0;
    for (let k = 0; k < NV; k++) d += Math.abs(a.values[k] - b.values[k]);
    let t = 0;
    for (const k of TRADITION_KEYS) if (a.traditions[k] !== b.traditions[k]) t++;
    return clamp(d / NV * 1.6 + t / TRADITION_KEYS.length * 0.5);
  }
}
