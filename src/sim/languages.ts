import { Rng, clamp } from './rng';
import type { World } from './world';
import type { Person } from './people';
import { Phonology, makeWord, randomPhonology } from './names';

export type WordOrder = 'SOV' | 'SVO' | 'VSO';
export type Morphology = 'isolating' | 'agglutinative' | 'fusional';
export type Writing = 'none' | 'pictographic' | 'syllabic' | 'alphabetic';

export interface Language {
  id: number;
  name: string;
  parent: number; // 0 = proto-language
  phonology: Phonology;
  born: number;
  vocabulary: number;
  wordOrder: WordOrder;
  morphology: Morphology;
  writing: Writing;
  symbols: string[];
  /** Sound changes applied since the proto-language (for display and kinship). */
  shifts: string[];
  /** Sample lexicon: concept -> word. Diverges as languages split. */
  lexicon: Record<string, string>;
  /** a contact language between two peoples */
  pidgin?: boolean;
  merged?: number[];
}

const CONCEPTS = ['water', 'fire', 'mother', 'father', 'sun', 'river', 'stone', 'home', 'food', 'child'];
const SYMBOL_POOL = ['☉', '☽', '△', '◇', '≈', '✦', '⌘', '⚘', '☗', '⛬', '❖', '⚶'];

export class Languages {
  list: Language[] = [];
  next = 1;

  create(rng: Rng, day: number, parent?: Language, name?: string): Language {
    const id = this.next++;
    let phon: Phonology;
    const shifts: string[] = [];
    if (parent) {
      phon = { onsets: [...parent.phonology.onsets], vowels: [...parent.phonology.vowels], codas: [...parent.phonology.codas] };
      const nShift = 2 + rng.int(2);
      for (let k = 0; k < nShift; k++) this.soundShift(phon, rng, shifts);
    } else phon = randomPhonology(rng);
    const lang: Language = {
      id, name: '', parent: parent?.id ?? 0, phonology: phon, born: day, vocabulary: parent ? parent.vocabulary : 120,
      wordOrder: parent && !rng.chance(0.1) ? parent.wordOrder : rng.pick(['SOV', 'SVO', 'VSO'] as WordOrder[]),
      morphology: parent && !rng.chance(0.08) ? parent.morphology : rng.pick(['isolating', 'agglutinative', 'fusional'] as Morphology[]),
      writing: 'none', symbols: parent ? [...parent.symbols] : [], shifts: parent ? [...parent.shifts, ...shifts] : shifts, lexicon: {},
    };
    lang.name = name ?? makeWord(phon, rng, 2);
    if (parent) {
      // inherited words undergo the same sound changes
      for (const c of CONCEPTS) lang.lexicon[c] = this.applyShifts(parent.lexicon[c] ?? makeWord(parent.phonology, rng, 2), shifts);
    } else for (const c of CONCEPTS) lang.lexicon[c] = makeWord(phon, rng, 1 + rng.int(2));
    if (rng.chance(0.5)) lang.symbols.push(rng.pick(SYMBOL_POOL));
    this.list.push(lang);
    return lang;
  }

  private soundShift(ph: Phonology, rng: Rng, log: string[]) {
    const pools: [keyof Phonology, string[]][] = [
      ['onsets', ['k', 'g', 'p', 'b', 't', 'd', 's', 'sh', 'th', 'f', 'v', 'z', 'ch', 'h', 'l', 'r']],
      ['vowels', ['a', 'e', 'i', 'o', 'u', 'ae', 'ia', 'ou', 'ei', 'y']],
    ];
    const [key, pool] = rng.pick(pools);
    const arr = ph[key];
    if (!arr.length) return;
    const from = rng.pick(arr);
    const to = rng.pick(pool);
    if (from === to) return;
    const i = arr.indexOf(from);
    arr[i] = to;
    log.push(`${from}→${to}`);
  }
  private applyShifts(word: string, shifts: string[]): string {
    let w = word.toLowerCase();
    for (const s of shifts) {
      const [a, b] = s.split('→');
      w = w.split(a).join(b);
    }
    return w.charAt(0).toUpperCase() + w.slice(1);
  }
  get(id: number): Language | undefined {
    return this.list[id - 1];
  }

  /** Coin a word for a new concept the first time a people has a use for it. */
  coin(rng: Rng, langId: number, concept: string): string | null {
    const l = this.get(langId);
    if (!l || l.lexicon[concept]) return null;
    l.lexicon[concept] = makeWord(l.phonology, rng, 1 + rng.int(2));
    l.vocabulary += 1;
    return l.lexicon[concept];
  }

  private root(id: number): number {
    let l = this.get(id);
    while (l && l.parent) l = this.get(l.parent);
    return l?.id ?? id;
  }
  /** 1 same language, ~0.7 parent/daughter, ~0.45 sisters, ~0.2 same family, 0 unrelated. */
  relatedness(a: number, b: number): number {
    if (a === b) return 1;
    const A = this.get(a), B = this.get(b);
    if (!A || !B) return 0;
    if (A.parent === b || B.parent === a) return 0.7;
    if (A.parent && A.parent === B.parent) return 0.45;
    return this.root(a) === this.root(b) ? 0.2 : 0;
  }
  /** How well two individuals can understand each other, 0..1 (shared tongue, related tongues, learned fluency, contact pidgins). */
  understanding(w: World, p: Person, q: Person): number {
    void w;
    let u = this.relatedness(p.tongue, q.tongue);
    u = Math.max(u, p.fluency.get(q.tongue) ?? 0, q.fluency.get(p.tongue) ?? 0);
    for (const [id, f] of p.fluency) {
      if (id === q.tongue) continue;
      const g = q.fluency.get(id);
      if (g !== undefined) u = Math.max(u, Math.min(f, g));
    }
    return clamp(u);
  }
  /** Time together teaches each person some of the other's language. */
  contact(w: World, p: Person, q: Person, amount: number) {
    void w;
    if (p.tongue === q.tongue) return;
    const learn = (a: Person, b: Person) => {
      const cur = a.fluency.get(b.tongue) ?? 0;
      if (cur < 1) a.fluency.set(b.tongue, Math.min(1, cur + amount * (0.4 + a.personality[7])));
    };
    learn(p, q);
    learn(q, p);
  }
  /** Text rendering of the language family tree. */
  tree(): string {
    const kids = new Map<number, Language[]>();
    for (const l of this.list) {
      const a = kids.get(l.parent) ?? [];
      a.push(l);
      kids.set(l.parent, a);
    }
    const lines: string[] = [];
    const walk = (parent: number, prefix: string) => {
      const ch = kids.get(parent) ?? [];
      ch.forEach((l, i) => {
        const last = i === ch.length - 1;
        lines.push(`${prefix}${last ? '└── ' : '├── '}${l.name}${l.writing !== 'none' ? ' ✎' : ''}`);
        walk(l.id, prefix + (last ? '    ' : '│   '));
      });
    };
    walk(0, '');
    return lines.join('\n');
  }
}
