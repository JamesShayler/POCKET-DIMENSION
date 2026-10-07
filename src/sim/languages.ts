import { Rng, clamp } from './rng';
import type { World } from './world';
import type { Person } from './people';
import { Phonology, makeWord, randomPhonology } from './names';

export type WordOrder = 'SOV' | 'SVO' | 'VSO';
export type Morphology = 'isolating' | 'agglutinative' | 'fusional';
export type Writing = 'none' | 'pictographic' | 'syllabic' | 'alphabetic';

/**
 * A generated grammar. Features hang together the way they tend to in real languages (verb-final languages favour
 * postpositions and adjectives before nouns; isolating languages mark tense and plurals with particles, not endings), and
 * they change when languages split: endings erode, word order shifts, particles fuse into new endings.
 */
export interface Grammar {
  adjective: 'before' | 'after';
  adposition: 'pre' | 'post';
  /** how the plural is marked */
  plural: { how: 'suffix' | 'prefix' | 'reduplication' | 'particle' | 'none'; form: string };
  /** case endings (empty strings when nouns do not inflect) */
  cases: { acc: string; gen: string; loc: string };
  tense: { how: 'suffix' | 'prefix' | 'particle'; past: string; future: string };
  negation: { word: string; place: 'before-verb' | 'after-verb' | 'end' };
  question: { how: 'particle-end' | 'particle-start' | 'verb-first'; word: string };
  article: string;
}

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
  grammar: Grammar;
  /** a contact language between two peoples */
  pidgin?: boolean;
  merged?: number[];
}

const CONCEPTS = ['water', 'fire', 'mother', 'father', 'sun', 'river', 'stone', 'home', 'food', 'child',
  'hunter', 'deer', 'see', 'eat', 'give', 'go', 'big', 'small', 'I', 'you', 'we', 'people', 'king', 'god', 'sky', 'town', 'to', 'of', 'in'];
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
      grammar: undefined as unknown as Grammar,
    };
    lang.name = name ?? makeWord(phon, rng, 2);
    if (parent) {
      // inherited words undergo the same sound changes
      for (const c of CONCEPTS) lang.lexicon[c] = this.applyShifts(parent.lexicon[c] ?? wordFor(parent, c), shifts);
      lang.grammar = this.evolveGrammar(parent, lang, shifts, rng);
    } else {
      for (const c of CONCEPTS) lang.lexicon[c] = makeWord(phon, rng, c.length <= 3 ? 1 : 1 + rng.int(2));
      lang.grammar = randomGrammar(lang, rng);
    }
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
  /** Daughter grammars inherit, with sound change on their endings and the occasional structural change. */
  private evolveGrammar(parent: Language, lang: Language, shifts: string[], rng: Rng): Grammar {
    const pg = parent.grammar ?? randomGrammar(parent, rng);
    const sh = (a: string) => (a ? this.applyShifts(a, shifts).toLowerCase() : a);
    const g: Grammar = {
      adjective: pg.adjective, adposition: pg.adposition,
      plural: { ...pg.plural, form: sh(pg.plural.form) },
      cases: { acc: sh(pg.cases.acc), gen: sh(pg.cases.gen), loc: sh(pg.cases.loc) },
      tense: { ...pg.tense, past: sh(pg.tense.past), future: sh(pg.tense.future) },
      negation: { ...pg.negation, word: sh(pg.negation.word) },
      question: { ...pg.question, word: sh(pg.question.word) },
      article: sh(pg.article),
    };
    if (lang.morphology === 'isolating') {
      // endings wear away; particles take over their work
      g.cases = { acc: '', gen: '', loc: '' };
      if (g.plural.how === 'suffix' || g.plural.how === 'prefix') g.plural = { how: 'particle', form: affix(lang, rng) };
      if (g.tense.how !== 'particle') g.tense = { how: 'particle', past: affix(lang, rng), future: affix(lang, rng) };
    } else if (rng.chance(0.25) && !g.cases.loc) {
      // a postposition fuses onto the noun and becomes a case ending
      g.cases.loc = affix(lang, rng);
    }
    if (rng.chance(0.12)) g.adjective = g.adjective === 'before' ? 'after' : 'before';
    if (rng.chance(0.08)) g.question = { how: rng.pick(['particle-end', 'particle-start', 'verb-first'] as const), word: affix(lang, rng) };
    if (rng.chance(0.15)) g.article = g.article ? '' : affix(lang, rng);
    g.adposition = lang.wordOrder === 'SOV' ? (rng.chance(0.85) ? 'post' : g.adposition) : g.adposition;
    return g;
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

/** A short grammatical morpheme from the language's own sounds. */
function affix(l: Language, rng: Rng): string {
  const ph = l.phonology;
  const v = rng.pick(ph.vowels);
  const r = rng.next();
  return (r < 0.45 ? v + rng.pick(ph.codas.filter((c) => c) .concat([''])) : rng.pick(ph.onsets) + v).toLowerCase();
}

function randomGrammar(l: Language, rng: Rng): Grammar {
  const verbFinal = l.wordOrder === 'SOV';
  const inflecting = l.morphology !== 'isolating';
  const pl = inflecting ? rng.pick(['suffix', 'suffix', 'prefix', 'reduplication'] as const) : rng.pick(['particle', 'none', 'reduplication'] as const);
  return {
    adjective: verbFinal ? (rng.chance(0.75) ? 'before' : 'after') : rng.chance(0.6) ? 'after' : 'before',
    adposition: verbFinal ? 'post' : l.wordOrder === 'VSO' ? 'pre' : rng.chance(0.8) ? 'pre' : 'post',
    plural: { how: pl, form: pl === 'none' || pl === 'reduplication' ? '' : affix(l, rng) },
    cases: inflecting && rng.chance(verbFinal ? 0.85 : 0.5) ? { acc: affix(l, rng), gen: affix(l, rng), loc: rng.chance(0.6) ? affix(l, rng) : '' } : { acc: '', gen: '', loc: '' },
    tense: inflecting ? { how: rng.chance(0.75) ? 'suffix' : 'prefix', past: affix(l, rng), future: affix(l, rng) } : { how: 'particle', past: affix(l, rng), future: affix(l, rng) },
    negation: { word: affix(l, rng), place: rng.pick(['before-verb', 'before-verb', 'after-verb', 'end'] as const) },
    question: { how: l.wordOrder === 'VSO' ? 'particle-start' : rng.pick(['particle-end', 'particle-end', 'verb-first'] as const), word: affix(l, rng) },
    article: rng.chance(0.4) ? affix(l, rng) : '',
  };
}

/** The word for a concept; words not yet coined are derived from the language's sounds (a pure function, no side effects). */
export function wordFor(l: Language, concept: string): string {
  const w = l.lexicon[concept];
  if (w) return w;
  let h = 2166136261 ^ l.id;
  for (let i = 0; i < concept.length; i++) h = Math.imul(h ^ concept.charCodeAt(i), 16777619);
  return makeWord(l.phonology, new Rng(h >>> 0), concept.length <= 3 ? 1 : 2);
}

interface Np { noun: string; gloss: string; plural?: boolean; adj?: string; case?: 'acc' | 'gen' | 'loc' | ''; poss?: Np }

/**
 * Example sentences in a language, each with the native text, a word-by-word gloss and a translation — built from the
 * generated grammar and lexicon. Pure: reading a language never changes it.
 */
export function sampleSentences(l: Language): { native: string; gloss: string; english: string }[] {
  const g = l.grammar;
  if (!g) return [];
  const W_ = (c: string) => wordFor(l, c).toLowerCase();
  const np = (n: Np): [string[], string[]] => {
    let w = W_(n.noun), gl = n.gloss;
    if (n.plural) {
      if (g.plural.how === 'suffix') { w += g.plural.form; gl += '-PL'; }
      else if (g.plural.how === 'prefix') { w = g.plural.form + w; gl = 'PL-' + gl; }
      else if (g.plural.how === 'reduplication') { w = w.slice(0, 2) + w; gl = 'PL~' + gl; }
    }
    const c = n.case ? g.cases[n.case] : '';
    if (c && n.case) { w += c; gl += '-' + n.case.toUpperCase(); }
    const words = [w], gls = [gl];
    if (n.plural && g.plural.how === 'particle') { words.unshift(g.plural.form); gls.unshift('PL'); }
    if (n.adj) { if (g.adjective === 'before') { words.unshift(W_(n.adj)); gls.unshift(n.adj); } else { words.push(W_(n.adj)); gls.push(n.adj); } }
    if (g.article && !['I', 'you', 'we'].includes(n.noun)) { words.unshift(g.article); gls.unshift('the'); }
    if (n.poss) {
      const [pw, pg] = np({ ...n.poss, case: g.cases.gen ? 'gen' : '' });
      if (!g.cases.gen) {
        const of = W_('of');
        const pre = g.adposition === 'pre';
        const ow = pre ? [of, ...pw] : [...pw, of], og = pre ? ['of', ...pg] : [...pg, 'of'];
        return g.adjective === 'before' ? [[...ow, ...words], [...og, ...gls]] : [[...words, ...ow], [...gls, ...og]];
      }
      return g.adjective === 'before' ? [[...pw, ...words], [...pg, ...gls]] : [[...words, ...pw], [...gls, ...pg]];
    }
    return [words, gls];
  };
  const verb = (c: string, tense: 'past' | 'present' | 'future', neg = false): [string[], string[]] => {
    let w = W_(c), gl = c;
    const words: string[] = [], gls: string[] = [];
    if (tense !== 'present') {
      const m = g.tense[tense];
      const T = tense === 'past' ? 'PST' : 'FUT';
      if (g.tense.how === 'suffix') { w += m; gl += '-' + T; }
      else if (g.tense.how === 'prefix') { w = m + w; gl = T + '-' + gl; }
      else { words.push(m); gls.push(T); }
    }
    words.push(w); gls.push(gl);
    if (neg && g.negation.place === 'before-verb') { words.unshift(g.negation.word); gls.unshift('NEG'); }
    if (neg && g.negation.place === 'after-verb') { words.push(g.negation.word); gls.push('NEG'); }
    return [words, gls];
  };
  const pp = (n: Np): [string[], string[]] => {
    if (g.cases.loc) return np({ ...n, case: 'loc' });
    const [w, gl] = np(n);
    const p = W_('to');
    return g.adposition === 'pre' ? [[p, ...w], ['to', ...gl]] : [[...w, p], [...gl, 'to']];
  };
  const clause = (S: [string[], string[]], V: [string[], string[]], O?: [string[], string[]], X?: [string[], string[]], neg = false, q = false) => {
    const parts: [string[], string[]][] = [];
    const order = q && g.question.how === 'verb-first' ? 'VSO' : l.wordOrder;
    for (const ch of order) {
      if (ch === 'S') parts.push(S);
      else if (ch === 'V') { if (X && order === 'SOV') parts.push(X); parts.push(V); if (X && order !== 'SOV') parts.push(X); }
      else if (O) parts.push(O);
    }
    let w = parts.flatMap((p) => p[0]), gl = parts.flatMap((p) => p[1]);
    if (neg && g.negation.place === 'end') { w.push(g.negation.word); gl.push('NEG'); }
    if (q && g.question.how === 'particle-end') { w.push(g.question.word); gl.push('Q'); }
    if (q && g.question.how === 'particle-start') { w = [g.question.word, ...w]; gl = ['Q', ...gl]; }
    const native = w.join(' ');
    return { native: native.charAt(0).toUpperCase() + native.slice(1) + (q ? '?' : '.'), gloss: gl.join(' ') };
  };
  const out: { native: string; gloss: string; english: string }[] = [];
  out.push({ ...clause(np({ noun: 'hunter', gloss: 'hunter' }), verb('see', 'present'), np({ noun: 'deer', gloss: 'deer', adj: 'big', case: 'acc' })), english: 'The hunter sees the big deer.' });
  out.push({ ...clause(np({ noun: 'we', gloss: 'we' }), verb('go', 'future'), undefined, pp({ noun: 'river', gloss: 'river' })), english: 'We will go to the river.' });
  out.push({ ...clause(np({ noun: 'child', gloss: 'child', plural: true, poss: { noun: 'town', gloss: 'town' } }), verb('eat', 'past'), np({ noun: 'food', gloss: 'food', case: 'acc' })), english: 'The children of the town ate food.' });
  out.push({ ...clause(np({ noun: 'king', gloss: 'king' }), verb('give', 'past', true), np({ noun: 'water', gloss: 'water', case: 'acc' }), undefined, true), english: 'The king did not give water.' });
  out.push({ ...clause(np({ noun: 'god', gloss: 'god', plural: true }), verb('see', 'present'), np({ noun: 'people', gloss: 'people', plural: true, case: 'acc' }), undefined, false, true), english: 'Do the gods see the people?' });
  return out;
}

/** One-line description of a grammar for the almanac. */
export function describeGrammar(l: Language): string {
  const g = l.grammar;
  if (!g) return '';
  const parts = [
    `${l.wordOrder} word order`, `${l.morphology}`,
    g.cases.acc ? `case endings (-${g.cases.acc} object, -${g.cases.gen} possessor${g.cases.loc ? `, -${g.cases.loc} place` : ''})` : 'no noun cases',
    g.plural.how === 'none' ? 'no plural marking' : g.plural.how === 'reduplication' ? 'plural by reduplication' : `plural ${g.plural.how} "${g.plural.form}"`,
    `${g.tense.how === 'particle' ? 'tense particles' : `tense ${g.tense.how}es`} (past "${g.tense.past}", future "${g.tense.future}")`,
    `${g.adposition}positions`, `adjectives ${g.adjective} nouns`,
    g.article ? `article "${g.article}"` : 'no articles',
  ];
  return parts.join(' · ');
}
