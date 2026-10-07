import { Rng, clamp } from './rng';
import { NV } from './culture';
import type { TechSet } from './technology';

export const PERSONALITY = [
  'curiosity', 'aggression', 'empathy', 'bravery', 'fearfulness', 'ambition', 'sociability',
  'intelligence', 'creativity', 'loyalty', 'greed', 'patience', 'impulsiveness',
] as const;
export const NP = PERSONALITY.length;
export const P = Object.fromEntries(PERSONALITY.map((k, i) => [k, i])) as Record<(typeof PERSONALITY)[number], number>;

export const NEEDS = ['hunger', 'thirst', 'shelter', 'safety', 'social', 'belonging', 'reproduction', 'status', 'curiosity', 'purpose'] as const;
export const NN = NEEDS.length;
export const ND = Object.fromEntries(NEEDS.map((k, i) => [k, i])) as Record<(typeof NEEDS)[number], number>;

export const SKILLS = ['foraging', 'hunting', 'farming', 'crafting', 'building', 'leading', 'exploring', 'healing', 'woodcutting', 'mining'] as const;
export const NS = SKILLS.length;
export const SK = Object.fromEntries(SKILLS.map((k, i) => [k, i])) as Record<(typeof SKILLS)[number], number>;

export type TaskKind = '' | 'chop' | 'quarry' | 'mine' | 'clay' | 'berry' | 'fish' | 'hunt' | 'build' | 'field' | 'craft' | 'trade' | 'prospect';

export type Goal =
  | 'work' | 'drink' | 'eat' | 'socialize' | 'seek mate' | 'explore' | 'migrate' | 'wander' | 'rest' | 'flee' | 'raid' | 'found settlement' | 'follow' | 'attack';

export type Occupation =
  | 'child' | 'forager' | 'hunter' | 'farmer' | 'woodcutter' | 'miner' | 'trader' | 'crafter' | 'builder' | 'healer' | 'leader' | 'warrior' | 'explorer'
  | 'priest' | 'scholar' | 'hermit' | 'exile' | 'raider' | 'wanderer' | 'cult founder' | 'rebel';

export type MemoryKind =
  | 'born' | 'helped' | 'betrayed' | 'disaster' | 'famine' | 'family death' | 'discovery' | 'migration' | 'war' | 'raid'
  | 'leader' | 'revelation' | 'exile' | 'marriage' | 'birth of child' | 'plague' | 'founded' | 'art' | 'voyage';

export interface Memory {
  day: number;
  kind: MemoryKind;
  text: string;
  /** -1 terrible .. +1 wonderful */
  valence: number;
  intensity: number;
  x: number;
  y: number;
  other?: number;
}

export interface Relationship {
  affinity: number; // -1..1
  kind: 'kin' | 'partner' | 'friend' | 'rival' | 'mentor' | 'acquaintance';
}

export class Person {
  id = 0;
  name = '';
  sex: 0 | 1 = 0;
  species = 0;
  birth = 0;
  death = -1;
  deathCause = '';
  mother = 0;
  father = 0;
  children: number[] = [];
  partner = 0;
  pregnantUntil = -1;
  pregnancyFather = 0;
  x = 0;
  y = 0;
  px = 0;
  py = 0;
  home = 0; // settlement id; 0 = none
  culture = 0;
  band = 0; // migrating / outcast group id
  personality = new Float32Array(NP);
  needs = new Float32Array(NN);
  skills = new Float32Array(NS);
  beliefs = new Float32Array(NV);
  health = 1;
  memories: Memory[] = [];
  relations = new Map<number, Relationship>();
  occupation: Occupation = 'child';
  goal: Goal = 'work';
  goalUntil = 0;
  tx = 0;
  ty = 0;
  hasTarget = false;
  reputation = 0; // -1..1
  status = 0; // 0..1
  food = 0;
  tools = 0;
  goods = 0;
  generation = 0;
  alive = true;
  legend = false;
  lastDetail = '';
  workCell = -1;
  killed = 0;
  // physical work: a person is always doing one concrete thing somewhere
  task: TaskKind = '';
  phase = 0; // 0 choose, 1 travel out, 2 work, 3 travel back
  tcell = -1;
  tslot = -1;
  tb = 0; // target building or settlement id
  timer = 0; // hours spent on the current phase
  cargo = ''; // 'food' | resource key
  cargoAmt = 0;
  back = ''; // what a trader brings home
  house = 0;
  tongue = 0; // native language id
  fluency = new Map<number, number>(); // other languages: 0..1
  stuck = 0;
  lastCell = -1;

  ageYears(day: number) {
    return ((this.death >= 0 ? this.death : day) - this.birth) / 360;
  }
  isAdult(day: number) {
    return this.ageYears(day) >= 15;
  }
  remember(m: Memory) {
    this.memories.push(m);
    if (this.memories.length > 14) {
      // forget the least important/oldest first
      let worst = 0;
      let ws = Infinity;
      for (let i = 0; i < this.memories.length; i++) {
        const mm = this.memories[i];
        const s = mm.intensity + (i / this.memories.length) * 0.3;
        if (s < ws) { ws = s; worst = i; }
      }
      this.memories.splice(worst, 1);
    }
  }
  /** Compact the record once dead so genealogies can persist cheaply for ages. */
  archive() {
    this.alive = false;
    this.needs = new Float32Array(0);
    this.relations = new Map();
    this.memories = this.memories.filter((m) => m.intensity > 0.6).slice(-4);
    this.hasTarget = false;
  }
}

export function randomPersonality(rng: Rng, out: Float32Array, a?: Float32Array, b?: Float32Array, mean = 0.5) {
  for (let i = 0; i < NP; i++) {
    const rand = clamp(mean + rng.gauss() * 0.2);
    out[i] = a && b ? clamp(0.4 * ((a[i] + b[i]) / 2) + 0.6 * rand) : rand;
  }
}

export interface PersonSummary { id: number; name: string; x: number; y: number }
export type { TechSet };
