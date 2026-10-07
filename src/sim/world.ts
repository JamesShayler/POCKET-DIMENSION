import { Planet } from './planet';
import { Environment } from './environment';
import { Ecology, Species, Traits } from './ecology';
import { EventBus, History } from './events';
import { Languages } from './languages';
import { Cultures } from './culture';
import { Rng, clamp, hashStr } from './rng';
import { Person, randomPersonality, NP, PERSONALITY, P } from './people';
import { Civ, Settlement, stageFor } from './settlements';
import { TechSet } from './technology';
import { DAYS_PER_SEASON, DAYS_PER_YEAR, yearOf } from './time';
import { H, N, NBR8, RF, RW, W, distKm, idx, regionOfCell, NR } from './grid';
import { makeWord } from './names';
import { personStep, Band } from './behavior';
import { settlementSeason, civSeason, outcastSeason, arriveBand, bandStuck } from './society';

export const WORLD_VERSION = 1;

export function seedFromText(text: string): number {
  return hashStr(text.trim().toLowerCase() || 'pocket');
}

export class World {
  readonly seedText: string;
  readonly seed: number;
  planet: Planet;
  env: Environment;
  eco: Ecology;
  bus = new EventBus();
  history = new History(this.bus);
  langs = new Languages();
  cultures = new Cultures();
  rng: Rng;
  day = 0;
  dt = 1;
  people = new Map<number, Person>();
  alive: Person[] = [];
  nextPerson = 1;
  settlements: Settlement[] = [];
  civs: Civ[] = [];
  bands = new Map<number, Band>();
  nextBand = 1;
  landComp = new Int32Array(N);
  landCompBoat = new Int32Array(N);
  seasonAcc = 0;
  yearAcc = 0;
  awakened = false;
  firstPermanent = false;
  residents = new Map<number, Person[]>();
  farmLoad = new Map<number, number>();
  discoveredComps = new Set<number>();
  famineAt = new Map<number, number>();
  lastMigration = new Map<number, number>();
  diseaseAt = new Map<number, number>();
  /** Fraction of a full ration each settlement's store can cover this tick (communal sharing). */
  ration = new Map<number, number>();
  /** Simulation counters surfaced on the developer dashboard. */
  stats = { births: 0, deaths: 0, starved: 0, ticks: 0, causes: {} as Record<string, number> };
  /** Optional hint: where the observer is looking (reserved for aggregation LOD). */
  focus: { x: number; y: number } | null = null;

  constructor(seedText: string) {
    this.seedText = seedText;
    this.seed = seedFromText(seedText);
    this.rng = Rng.derive(this.seed, 'society');
    this.planet = new Planet(this.seed);
    this.env = new Environment(this.planet);
    this.eco = new Ecology(this, Rng.derive(this.seed, 'ecology'));
    this.computeLandComponents();
  }

  random() {
    return this.rng.next();
  }

  /** Create a fresh universe: planet, climate, initial life. Humans are NOT scripted; they must evolve. */
  begin() {
    this.env.updateSeason(this);
    this.eco.seedLife();
  }

  private computeLandComponents() {
    const parent = new Int32Array(N);
    const find = (a: number): number => {
      while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; }
      return a;
    };
    const union = (a: number, b: number) => { a = find(a); b = find(b); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); };
    const link = (radius: number, out: Int32Array) => {
      for (let i = 0; i < N; i++) parent[i] = i;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = idx(x, y);
        if (this.planet.ocean[i]) continue;
        for (let dy = -radius; dy <= radius; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= H) continue;
          for (let dx = -radius; dx <= radius; dx++) {
            const j = idx((x + dx + W) % W, yy);
            if (!this.planet.ocean[j]) union(i, j);
          }
        }
      }
      for (let i = 0; i < N; i++) out[i] = this.planet.ocean[i] ? -1 : find(i);
    };
    link(1, this.landComp);
    link(3, this.landCompBoat);
  }

  // ---------- spawning & lifecycle ----------
  newPerson(opts: { sex?: 0 | 1; x: number; y: number; home: number; culture: number; species: number; mother?: Person; father?: Person; ageDays?: number; intelMean?: number }): Person {
    const p = new Person();
    const rng = this.rng;
    p.id = this.nextPerson++;
    p.sex = opts.sex ?? (rng.chance(0.5) ? 1 : 0);
    p.species = opts.species;
    p.birth = this.day - (opts.ageDays ?? 0);
    p.x = p.px = opts.x;
    p.y = p.py = opts.y;
    p.home = opts.home;
    p.culture = opts.culture;
    randomPersonality(rng, p.personality, opts.mother?.personality, opts.father?.personality);
    if (opts.intelMean !== undefined && !opts.mother) p.personality[P.intelligence] = clamp(opts.intelMean + rng.gauss() * 0.12);
    const cul = this.cultures.get(opts.culture)!;
    const lang = this.langs.get(cul.language)!;
    for (let k = 0; k < p.beliefs.length; k++) {
      const inherited = opts.mother && opts.father ? (opts.mother.beliefs[k] + opts.father.beliefs[k]) / 2 : cul.values[k];
      p.beliefs[k] = clamp(0.5 * inherited + 0.5 * cul.values[k] + rng.gauss() * 0.12);
    }
    p.name = makeWord(lang.phonology, rng, 1 + rng.int(2));
    if (opts.mother) {
      p.mother = opts.mother.id;
      p.father = opts.father?.id ?? 0;
      p.generation = Math.max(opts.mother.generation, opts.father?.generation ?? 0) + 1;
      p.status = clamp(((opts.mother.status + (opts.father?.status ?? 0)) / 2) * 0.7);
    }
    p.health = 1;
    p.needs[0] = 0.15;
    p.skills.fill(0.05);
    this.people.set(p.id, p);
    this.alive.push(p);
    return p;
  }

  die(p: Person, cause: string) {
    if (!p.alive) return;
    p.death = this.day;
    p.deathCause = cause;
    this.stats.deaths++;
    if (cause === 'starvation' || cause === 'thirst') this.stats.starved++;
    this.stats.causes[cause] = (this.stats.causes[cause] ?? 0) + 1;
    // grief: relatives remember
    for (const [oid, rel] of p.relations) {
      if (rel.kind !== 'kin' && rel.kind !== 'partner') continue;
      const o = this.people.get(oid);
      if (!o || !o.alive) continue;
      o.remember({ day: this.day, kind: 'family death', text: `${p.name} died of ${cause}`, valence: -0.8, intensity: 0.75, x: p.x, y: p.y, other: p.id });
      if (o.partner === p.id) o.partner = 0;
    }
    if (p.partner) {
      const o = this.people.get(p.partner);
      if (o && o.partner === p.id) o.partner = 0;
    }
    const s = p.home ? this.settlements[p.home - 1] : undefined;
    if (s && s.leader === p.id) s.leader = 0;
    const heavy = p.status > 0.65 || p.legend;
    this.history.record('DEATH', this.day, `${p.name} died of ${cause} aged ${Math.floor(p.ageYears(this.day))}.`, heavy ? 1 : 0, { persons: [p.id], x: p.x, y: p.y, settlement: p.home });
    p.archive();
    if (this.history.counts['DEATH'] % 400 === 0) this.pruneDead();
  }

  /** Keep memory bounded across deep time: forget unremarkable ancestors of long-dead lines. */
  private pruneDead() {
    const limit = 250000;
    if (this.people.size < limit) return;
    const cutoff = this.day - 700 * DAYS_PER_YEAR;
    for (const [id, p] of this.people) {
      if (!p.alive && p.death < cutoff && p.status < 0.6 && !p.legend && p.children.length === 0) this.people.delete(id);
    }
  }

  killInRadius(x: number, y: number, rad: number, frac: number, cause: string): number {
    let n = 0;
    for (const p of this.alive) {
      if (!p.alive) continue;
      if (Math.hypot(p.x - x, p.y - y) <= rad && this.random() < frac) {
        this.die(p, cause);
        n++;
      }
    }
    return n;
  }

  // ---------- settlements ----------
  foundSettlement(o: { x: number; y: number; culture: number; civ?: number; founder?: number; parent?: number; tech: TechSet; nomadic: boolean; note: string; name?: string }): Settlement {
    const cul = this.cultures.get(o.culture)!;
    const lang = this.langs.get(cul.language)!;
    const s: Settlement = {
      id: this.settlements.length + 1,
      name: o.name ?? makeWord(lang.phonology, this.rng, 2 + this.rng.int(2)),
      x: o.x, y: o.y, culture: o.culture, civ: o.civ ?? 0, founded: this.day, founder: o.founder ?? 0, parent: o.parent ?? 0,
      abandoned: -1, tech: new Set(o.tech), food: 20, goods: 0, housing: 0, nomadic: o.nomadic, permanent: false, stage: 'camp', pop: 0, peak: 0,
      knownKm: 90, stress: 0, stressSeasons: 0, surplus: 0, produced: 0, consumed: 0, drift: 0, langDrift: 0, disease: 0, diseaseUntil: 0,
      leader: 0, defense: 0, cohesion: 0.5, threat: 0, lastRaid: -99999, occupations: {}, originNote: o.note, yearsSettled: 0,
    };
    this.settlements.push(s);
    if (!s.civ) this.createCiv(s, o.note);
    else {
      const c = this.civs[s.civ - 1];
      c.members.push(s.id);
    }
    return s;
  }

  createCiv(s: Settlement, note: string, parent = 0): Civ {
    const cul = this.cultures.get(s.culture)!;
    const lang = this.langs.get(cul.language)!;
    const civ: Civ = {
      id: this.civs.length + 1, name: makeWord(lang.phonology, this.rng, 2), culture: s.culture, capital: s.id, members: [s.id],
      government: 'tribal leadership', leader: 0, lastLeader: 0, founded: this.day, collapsed: -1, legitimacy: 0.4, parent, pop: 0, territory: 0, rank: 'band', note,
    };
    this.civs.push(civ);
    s.civ = civ.id;
    this.history.record('CIVILIZATION_FOUNDING', this.day, `The ${civ.name} emerged around ${s.name}.`, 2, { civ: civ.id, settlement: s.id, x: s.x, y: s.y, culture: s.culture, cause: note });
    return civ;
  }

  settlementsNearRegion(r: number): number {
    const rx = (r % RW) * RF + RF / 2;
    const ry = Math.floor(r / RW) * RF + RF / 2;
    let n = 0;
    for (const s of this.settlements) if (s.abandoned < 0 && Math.hypot(s.x - rx, s.y - ry) < 12) n++;
    return n;
  }

  /** Best nearby cell for a founding camp: land, fresh water within reach, fertile. Searches a few regions around. */
  findAwakenSite(region: number): number {
    const planet = this.planet;
    const rx = (region % RW) * RF + RF / 2;
    const ry = Math.floor(region / RW) * RF + RF / 2;
    let best = -1;
    let bs = -Infinity;
    const R = RF * 2 + 2;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const y = Math.floor(ry) + dy;
      if (y < 1 || y >= H - 1) continue;
      const i = idx((((Math.floor(rx) + dx) % W) + W) % W, y);
      if (planet.ocean[i] || planet.lake[i] || planet.freshDist[i] > 1 || planet.elev[i] > 2.5 || planet.tempMean[i] < -4) continue;
      let rich = this.env.forageRate(i);
      for (let k = 0; k < 8; k++) { const n = NBR8[i * 8 + k]; if (n >= 0 && !planet.ocean[n]) rich += this.env.forageRate(n); }
      const sc = this.env.fert[i] + this.env.veg[i] * 0.5 + rich * 0.02 - Math.hypot(dx, dy) * 0.02;
      if (rich >= 9 * 1.2 && sc > bs) { bs = sc; best = i; }
    }
    return best;
  }

  /** Is this region far enough from existing people for a lineage to awaken here independently, and is there a viable site? */
  canAwakenAt(r: number): boolean {
    const rx = (r % RW) * RF + RF / 2;
    const ry = Math.floor(r / RW) * RF + RF / 2;
    for (const s of this.settlements) if (s.abandoned < 0 && distKm(s.x, s.y, rx, ry) < 1500) return false;
    return this.env.regionLand[r] >= 6 && this.findAwakenSite(r) >= 0;
  }

  awakenBand(sp: Species, region: number, n: number, traits: Traits): boolean {
    const rng = this.rng;
    const best = this.findAwakenSite(region);
    if (best < 0) return false;
    const sx = (best % W) + 0.5;
    const sy = Math.floor(best / W) + 0.5;
    const lang = this.langs.create(rng, this.day);
    lang.vocabulary = 150;
    const cul = this.cultures.create(rng, this.day, lang.id, lang.phonology, undefined, `The first words and customs of a lineage descended from ${sp.name}.`);
    lang.name = cul.name;
    const s = this.foundSettlement({ x: sx, y: sy, culture: cul.id, tech: new Set(), nomadic: true, note: `The first people to wake, descended from ${sp.name}, gathered here.` });
    this.awakened = true;
    this.history.record('AWAKENING', this.day, `Among the ${sp.name}, a lineage learned to think in symbols and speak. They call themselves the ${cul.name}.`, 3, {
      x: sx, y: sy, culture: cul.id, settlement: s.id,
      cause: `Generations of selection favoured intelligence (${traits.intel.toFixed(2)}) and sociality (${traits.soc.toFixed(2)}) in this omnivore lineage.`,
    });
    const group: Person[] = [];
    for (let k = 0; k < n; k++) {
      const age = rng.range(14, 36) * DAYS_PER_YEAR;
      const p = this.newPerson({ x: sx + rng.range(-0.4, 0.4), y: sy + rng.range(-0.4, 0.4), home: s.id, culture: cul.id, species: sp.id, ageDays: age, intelMean: clamp(traits.intel * 0.75), sex: k % 2 === 0 ? 1 : 0 });
      p.generation = 0;
      p.skills[0] = 0.3;
      p.occupation = 'forager';
      p.remember({ day: this.day, kind: 'born', text: 'Awoke into thought beside the river', valence: 0.5, intensity: 0.9, x: sx, y: sy });
      group.push(p);
    }
    // pair up
    const men = group.filter((p) => p.sex === 0);
    const women = group.filter((p) => p.sex === 1);
    for (let k = 0; k < Math.min(men.length, women.length) * 0.6; k++) {
      men[k].partner = women[k].id;
      women[k].partner = men[k].id;
      men[k].relations.set(women[k].id, { affinity: 0.7, kind: 'partner' });
      women[k].relations.set(men[k].id, { affinity: 0.7, kind: 'partner' });
    }
    const leader = group.reduce((a, b) => (b.personality[P.ambition] + b.personality[P.sociability] > a.personality[P.ambition] + a.personality[P.sociability] ? b : a));
    s.leader = leader.id;
    leader.occupation = 'leader';
    const civ = this.civs[s.civ - 1];
    civ.leader = leader.id;
    s.pop = group.length;
    s.food = group.length * 8;
    s.stage = stageFor(s.pop, true);
    return true;
  }

  bandArrived(b: Band) {
    arriveBand(this, b);
  }
  bandStuck(b: Band) {
    bandStuck(this, b);
  }

  // ---------- stepping ----------
  step(dt: number) {
    this.dt = dt;
    this.env.stepDays = dt;
    this.day += dt;
    this.stats.ticks++;
    this.seasonAcc += dt;
    while (this.seasonAcc >= DAYS_PER_SEASON) {
      this.seasonAcc -= DAYS_PER_SEASON;
      this.env.updateSeason(this);
      this.eco.step();
      if (this.awakened) {
        settlementSeason(this);
        outcastSeason(this);
        civSeason(this);
      }
    }
    if (!this.awakened || this.alive.length === 0) return;
    // index residents once per tick
    this.residents.clear();
    for (const p of this.alive) {
      if (!p.alive) continue;
      const l = this.residents.get(p.home);
      if (l) l.push(p); else this.residents.set(p.home, [p]);
    }
    this.ration.clear();
    for (const [sid, list] of this.residents) {
      if (!sid) continue;
      const st = this.settlements[sid - 1];
      this.ration.set(sid, Math.min(1, st.food / Math.max(1, list.length * dt * 0.85)));
    }
    this.farmLoad.clear();
    const snapshot = this.alive.slice();
    for (const p of snapshot) if (p.alive) personStep(this, p, dt);
    if (this.alive.length && this.stats.ticks % 8 === 0) this.alive = this.alive.filter((p) => p.alive);
    else this.alive = this.alive.filter((p) => p.alive);
  }

  /** Run only the pre-human world forward (ecology + environment), in season-sized steps. */
  stepPrehistory(seasons: number) {
    for (let k = 0; k < seasons && !this.awakened; k++) {
      this.day += DAYS_PER_SEASON;
      this.env.updateSeason(this);
      this.eco.step();
    }
  }

  // ---------- queries ----------
  get year() {
    return yearOf(this.day);
  }
  population() {
    return this.alive.length;
  }
  activeSettlements() {
    return this.settlements.filter((s) => s.abandoned < 0);
  }
  livingCivs() {
    return this.civs.filter((c) => c.collapsed < 0);
  }
  settlementAt(x: number, y: number, maxCells = 1.5): Settlement | undefined {
    let best: Settlement | undefined;
    let bd = maxCells;
    for (const s of this.settlements) {
      if (s.abandoned >= 0) continue;
      const dx = Math.min(Math.abs(s.x - x), W - Math.abs(s.x - x));
      const d = Math.hypot(dx, s.y - y);
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }
  /** Ancestors up to `gens` generations (for genealogy display). */
  ancestors(id: number, gens: number): number[][] {
    const out: number[][] = [];
    let level = [id];
    for (let g = 0; g < gens; g++) {
      const next: number[] = [];
      for (const pid of level) {
        const p = this.people.get(pid);
        if (p?.mother) next.push(p.mother);
        if (p?.father) next.push(p.father);
      }
      if (!next.length) break;
      out.push(next);
      level = next;
    }
    return out;
  }
  /** The founder-lineage root of a person (earliest known ancestor). */
  rootAncestor(id: number): { id: number; depth: number } {
    let cur = id;
    let depth = 0;
    for (;;) {
      const p = this.people.get(cur);
      const par = p?.mother || p?.father;
      if (!par || !this.people.has(par)) return { id: cur, depth };
      cur = par;
      depth++;
    }
  }
  descendantsCount(id: number, cap = 5000): number {
    let n = 0;
    const stack = [id];
    while (stack.length && n < cap) {
      const p = this.people.get(stack.pop()!);
      if (!p) continue;
      for (const c of p.children) { n++; stack.push(c); }
    }
    return n;
  }
  techCount(): number {
    const all = new Set<string>();
    for (const s of this.activeSettlements()) for (const t of s.tech) all.add(t);
    return all.size;
  }
}

export { personStep };
export type { Band };
