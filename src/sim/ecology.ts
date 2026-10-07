import type { World } from './world';
import { Rng, clamp, mix32 } from './rng';
import { NATURAL_PHONOLOGY, makeWord } from './names';
import { NR, RW, RH, RF, W, H, idx, N, regionOfCell } from './grid';
import { yearOf } from './time';

export type Diet = 'herb' | 'carn' | 'omni';

export interface Traits {
  size: number; speed: number; strength: number; intel: number; eyes: number; hear: number;
  tol: number; tempOpt: number; aggr: number; soc: number;
}
export const TRAIT_KEYS: (keyof Traits)[] = ['size', 'speed', 'strength', 'intel', 'eyes', 'hear', 'tol', 'tempOpt', 'aggr', 'soc'];

export interface Species {
  id: number; name: string; parent: number; diet: Diet; ref: Traits; born: number; extinct: number;
  hue: number; sapientAwakenings: number; peak: number;
}
export interface Pop { sp: number; r: number; n: number; t: Traits }

const K_PER_VEG = 30;
const metab = (s: number) => Math.pow(s, 0.75);
const sq = (x: number) => x * x;

interface RegionEnv { T: number; range01: number; Pp: number; preyAvail: number; Lshare: number }

/** Habitat- and trait-dependent log-fitness. Costs and benefits of each trait live here. */
export function fitness(t: Traits, diet: Diet, e: RegionEnv): number {
  const cf = Math.exp(-sq((e.T - t.tempOpt) / t.tol));
  const cost = 0.05 * Math.sqrt(t.size) + 0.12 * t.speed + 0.1 * t.strength + 0.18 * t.intel * t.intel + 0.05 * (t.eyes + t.hear) + 0.05 * t.aggr + 0.004 * t.tol;
  const escape = 0.3 + t.speed + 0.5 * t.eyes + 0.4 * t.hear + 0.4 * t.intel + 0.5 * t.soc + 0.5 * (t.size / (t.size + 2)) + 0.3 * t.strength;
  const survive = 1 / (1 + (2.5 * e.Pp * (diet === 'carn' ? 0.2 : 1)) / escape);
  const flex = diet === 'omni' ? 1 : diet === 'carn' ? 0.45 : 0.12;
  const D = 0.4 + 0.8 * e.range01 + 0.4 * e.Pp;
  const food = 1 + 0.95 * t.intel * D * flex + 0.1 * t.eyes;
  let F = Math.log(cf + 1e-3) - 1.5 * cost + Math.log(survive) + Math.log(food) - 0.06 * t.soc * e.Lshare;
  if (diet !== 'herb') {
    const ability = (0.25 + t.speed + 0.6 * t.eyes + 0.5 * t.strength + 0.4 * t.intel) * (0.5 + 0.5 * t.aggr) * (1 + 0.3 * t.soc);
    F += 0.5 * Math.log(0.4 + (diet === 'carn' ? 1 : 0.4) * ability * e.preyAvail);
  }
  return F;
}

const clampTrait = (k: keyof Traits, v: number): number => {
  switch (k) {
    case 'size': return clamp(v, 0.05, 20);
    case 'tol': return clamp(v, 3, 28);
    case 'tempOpt': return clamp(v, -25, 40);
    default: return clamp(v, 0, 1);
  }
};
const MUT_SCALE: Record<keyof Traits, number> = {
  size: 0.08, speed: 0.04, strength: 0.04, intel: 0.03, eyes: 0.04, hear: 0.04, tol: 0.6, tempOpt: 0.9, aggr: 0.04, soc: 0.04,
};

export class Ecology {
  species: Species[] = [];
  pops = new Map<number, Pop>();
  nextSpecies = 1;
  liveSpecies = 0;
  rng: Rng;
  regionNbr: Int32Array;
  /** land cells of every region (wildlife stands on these) */
  regionCells: Int32Array[] = [];
  /** Per-region danger to people from predators (0..1), refreshed each season. */
  predRisk = new Float32Array(NR);

  constructor(private world: World, rng: Rng) {
    this.rng = rng;
    const lists: number[][] = Array.from({ length: NR }, () => []);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = idx(x, y);
      if (!world.planet.ocean[i] && !world.planet.lake[i]) lists[Math.floor(y / RF) * RW + Math.floor(x / RF)].push(i);
    }
    this.regionCells = lists.map((l) => Int32Array.from(l));
    this.regionNbr = new Int32Array(NR * 4).fill(-1);
    for (let r = 0; r < NR; r++) {
      const x = r % RW;
      const y = Math.floor(r / RW);
      this.regionNbr[r * 4] = y * RW + ((x + 1) % RW);
      this.regionNbr[r * 4 + 1] = y * RW + ((x - 1 + RW) % RW);
      this.regionNbr[r * 4 + 2] = y > 0 ? (y - 1) * RW + x : -1;
      this.regionNbr[r * 4 + 3] = y < RH - 1 ? (y + 1) * RW + x : -1;
    }
  }

  private key(sp: number, r: number) {
    return sp * NR + r;
  }
  speciesById(id: number): Species {
    return this.species[id - 1];
  }

  /** Initial life: a handful of founder species placed where their traits suit the climate. */
  seedLife() {
    const w = this.world;
    const rng = this.rng;
    const env = w.env;
    const land: number[] = [];
    for (let r = 0; r < NR; r++) if (env.regionLand[r] >= 8) land.push(r);
    const regionVeg = (r: number) => this.regionVeg(r);
    const productive = land.filter((r) => regionVeg(r) > 3);
    if (!productive.length) return;
    const place = (sp: Species, count: number, minDist: number, clusters: number) => {
      const centres: number[] = [];
      let tries = 0;
      while (centres.length < clusters && tries++ < 400) {
        const r = rng.pick(productive);
        const fit = Math.exp(-sq((env.regionTemp[r] - sp.ref.tempOpt) / sp.ref.tol));
        if (fit < 0.5) continue;
        if (centres.some((c) => this.regionDist(c, r) < minDist)) continue;
        centres.push(r);
      }
      for (const c of centres) {
        const frontier = [c];
        const seen = new Set([c]);
        let placed = 0;
        while (frontier.length && placed < count) {
          const r = frontier.shift()!;
          if (env.regionLand[r] < 4 || regionVeg(r) < 1.5) continue;
          const t = { ...sp.ref };
          this.pops.set(this.key(sp.id, r), { sp: sp.id, r, n: Math.max(4, regionVeg(r) * K_PER_VEG * 0.04), t });
          placed++;
          for (let k = 0; k < 4; k++) {
            const nb = this.regionNbr[r * 4 + k];
            if (nb >= 0 && !seen.has(nb)) { seen.add(nb); frontier.push(nb); }
          }
        }
      }
      return centres;
    };
    const mk = (diet: Diet, over: Partial<Traits>, tempOpt?: number): Species => {
      const t: Traits = {
        size: Math.exp(rng.range(Math.log(0.15), Math.log(6))), speed: rng.range(0.25, 0.8), strength: rng.range(0.1, 0.6),
        intel: rng.range(0.05, 0.25), eyes: rng.range(0.3, 0.8), hear: rng.range(0.3, 0.8), tol: rng.range(6, 14),
        tempOpt: tempOpt ?? rng.range(-2, 30), aggr: rng.range(0.1, 0.4), soc: rng.range(0.1, 0.9), ...over,
      };
      if (diet === 'carn') { t.aggr = rng.range(0.5, 0.9); t.strength = rng.range(0.4, 0.8); t.size = Math.exp(rng.range(Math.log(0.8), Math.log(5))); }
      return this.createSpecies(null, diet, t);
    };
    const temps = [26, 22, 17, 12, 7, 2, 28, 15, 19, 9];
    temps.forEach((T) => {
      const sp = mk('herb', {}, T + rng.range(-2, 2));
      place(sp, 14, 6, 2 + rng.int(2));
    });
    [24, 14, 6, 20].forEach((T) => {
      const sp = mk('carn', {}, T);
      place(sp, 10, 8, 2);
    });
    [18, 10].forEach((T) => {
      const sp = mk('omni', { intel: rng.range(0.2, 0.35), soc: rng.range(0.2, 0.5) }, T);
      place(sp, 10, 8, 2);
    });
    // The lineage that might one day wake up: social, curious, adaptable generalist omnivores.
    const proto = this.createSpecies(null, 'omni', {
      size: 1.0, speed: 0.5, strength: 0.35, intel: 0.42, eyes: 0.7, hear: 0.5, tol: 14, tempOpt: 20, aggr: 0.35, soc: 0.7,
    });
    proto.name = 'Proto ' + proto.name;
    place(proto, 16, 12, 3);
    // adapt founding populations to their landscape
    for (const p of this.pops.values()) {
      if (p.sp === proto.id) p.t.tempOpt = env.regionTemp[p.r];
    }
  }

  regionVeg(r: number): number {
    const env = this.world.env;
    const rx = (r % RW) * RF;
    const ry = Math.floor(r / RW) * RF;
    let s = 0;
    for (let dy = 0; dy < RF; dy++) for (let dx = 0; dx < RF; dx++) {
      const i = idx(rx + dx, ry + dy);
      if (!this.world.planet.ocean[i]) s += env.veg[i];
    }
    return s;
  }
  regionDist(a: number, b: number): number {
    let dx = Math.abs((a % RW) - (b % RW));
    if (dx > RW / 2) dx = RW - dx;
    return Math.hypot(dx, Math.floor(a / RW) - Math.floor(b / RW));
  }

  createSpecies(parent: Species | null, diet: Diet, ref: Traits, name?: string): Species {
    const id = this.nextSpecies++;
    const nm = name ?? this.nameFor(diet, ref);
    const sp: Species = {
      id, name: nm, parent: parent?.id ?? 0, diet, ref: { ...ref }, born: this.world.day, extinct: -1,
      hue: parent ? (parent.hue + this.rng.range(-0.06, 0.06) + 1) % 1 : this.rng.next(), sapientAwakenings: 0, peak: 0,
    };
    this.species.push(sp);
    return sp;
  }
  private nameFor(diet: Diet, t: Traits): string {
    const base = makeWord(NATURAL_PHONOLOGY, this.rng, 2);
    const noun = diet === 'herb' ? (t.size < 0.5 ? 'hopper' : t.size < 2 ? 'grazer' : t.size < 6 ? 'browser' : 'behemoth')
      : diet === 'carn' ? (t.size < 1 ? 'stalker' : t.size < 3 ? 'hunter' : 'prowler') : 'forager';
    return `${base} ${noun}`;
  }
  private daughterName(parent: Species, t: Traits): string {
    const r = parent.ref;
    const devs: [number, string, string][] = [
      [(t.tempOpt - r.tempOpt) / 6, 'Southern', 'Northern'],
      [Math.log(t.size / r.size) / 0.6, 'Greater', 'Lesser'],
      [(t.speed - r.speed) / 0.35, 'Swift', 'Plodding'],
      [(t.intel - r.intel) / 0.3, 'Clever', 'Dull'],
      [(t.soc - r.soc) / 0.4, 'Herding', 'Solitary'],
      [(t.eyes - r.eyes) / 0.4, 'Keen-eyed', 'Dim'],
    ];
    devs.sort((a, b) => Math.abs(b[0]) - Math.abs(a[0]));
    const [d, up, down] = devs[0];
    const base = parent.name.replace(/^(Southern|Northern|Greater|Lesser|Swift|Plodding|Clever|Dull|Herding|Solitary|Keen-eyed|Dim) /, '');
    return `${d > 0 ? up : down} ${base}`;
  }

  /** One season of ecology. */
  step() {
    const w = this.world;
    const env = w.env;
    const rng = this.rng;
    const byRegion = new Map<number, Pop[]>();
    for (const p of this.pops.values()) {
      const l = byRegion.get(p.r);
      if (l) l.push(p); else byRegion.set(p.r, [p]);
    }
    const regions = [...byRegion.keys()].sort((a, b) => a - b);
    const moves: { sp: number; r: number; n: number; t: Traits }[] = [];
    const speciate: Pop[] = [];

    for (const r of regions) {
      const pops = byRegion.get(r)!;
      const Kc = Math.max(1, this.regionVeg(r) * K_PER_VEG);
      const T = env.regionTemp[r];
      const range01 = clamp(env.regionTempRange[r] / 22);
      let L = 0;
      let herbBio = 0;
      let predBio = 0;
      for (const p of pops) {
        const sp = this.speciesById(p.sp);
        const m = p.n * metab(p.t.size);
        if (sp.diet === 'herb') { L += m; herbBio += m; } else if (sp.diet === 'omni') { L += 0.5 * m; herbBio += 0.5 * m; predBio += 0.3 * m; } else predBio += m;
      }
      const Lshare = L / Kc;
      const Pp = clamp((predBio / (herbBio + 1)) * 3, 0, 2);
      // predation
      const prey = pops.filter((p) => this.speciesById(p.sp).diet !== 'carn');
      const preyLoss = new Map<Pop, number>();
      const intake = new Map<Pop, number>();
      let preyAvailTotal = 0;
      for (const p of prey) preyAvailTotal += p.n * metab(p.t.size);
      for (const c of pops) {
        const spc = this.speciesById(c.sp);
        if (spc.diet === 'herb') continue;
        const ability = (0.25 + c.t.speed + 0.6 * c.t.eyes + 0.5 * c.t.strength + 0.4 * c.t.intel) * (0.5 + 0.5 * c.t.aggr) * (1 + 0.3 * c.t.soc);
        let S = 0;
        const ws: [Pop, number][] = [];
        for (const p of prey) {
          if (p === c || p.sp === c.sp) continue;
          const ratio = p.t.size / c.t.size;
          if (ratio > 3 || ratio < 0.03) continue;
          const escape = 0.3 + p.t.speed + 0.5 * p.t.eyes + 0.4 * p.t.hear + 0.4 * p.t.intel + 0.5 * p.t.soc + 0.4 * (p.t.size / (p.t.size + 2));
          const vul = clamp(ability / escape, 0, 3);
          const wgt = p.n * metab(p.t.size) * vul;
          ws.push([p, wgt]);
          S += wgt;
        }
        const need = metab(c.t.size) * 0.5;
        const Kh = 0.12 * Kc + 1;
        const I = Math.min(2 * need, (2 * need * S) / (S + Kh));
        intake.set(c, I / need);
        const total = I * c.n;
        if (S > 0) for (const [p, wgt] of ws) preyLoss.set(p, (preyLoss.get(p) ?? 0) + (total * wgt) / S);
      }
      const preyAvail = clamp(preyAvailTotal / (Kc * 0.5));
      const renv: RegionEnv = { T, range01, Pp, preyAvail, Lshare };
      for (const p of pops) {
        const sp = this.speciesById(p.sp);
        const cf = Math.exp(-sq((T - p.t.tempOpt) / p.t.tol));
        const cost = 0.05 * Math.sqrt(p.t.size) + 0.12 * p.t.speed + 0.1 * p.t.strength + 0.18 * p.t.intel * p.t.intel + 0.05 * (p.t.eyes + p.t.hear);
        const rmax = clamp(0.9 * Math.pow(p.t.size, -0.25), 0.15, 0.8);
        let g: number;
        if (sp.diet === 'herb') {
          const f = clamp(cf * (1 - cost) * (1 + 0.3 * p.t.intel * range01));
          g = rmax * (f - Lshare * 0.9);
          const loss = preyLoss.get(p) ?? 0;
          p.n = Math.max(0, p.n - Math.min(0.7 * p.n, loss / metab(p.t.size)));
        } else if (sp.diet === 'omni') {
          const veg = 0.7 * clamp(1 - 0.6 * Lshare) * cf;
          const meat = 0.5 * (intake.get(p) ?? 0) * cf;
          g = rmax * (veg + meat - (0.58 + cost * 0.5));
          const loss = preyLoss.get(p) ?? 0;
          p.n = Math.max(0, p.n - Math.min(0.7 * p.n, loss / metab(p.t.size)));
        } else {
          g = 0.55 * rmax * ((intake.get(p) ?? 0) * cf * (1 - cost * 0.5) - 1);
        }
        p.n *= Math.exp(clamp(g, -1.2, 0.9));
        // mutation + selection: stochastic hill-climbing on log-fitness
        const k = TRAIT_KEYS[rng.int(TRAIT_KEYS.length)];
        const old = p.t[k];
        const nv = clampTrait(k, old + rng.gauss() * MUT_SCALE[k]);
        if (nv !== old) {
          const F0 = fitness(p.t, sp.diet, renv);
          p.t[k] = nv;
          const F1 = fitness(p.t, sp.diet, renv);
          const dF = F1 - F0;
          if (rng.next() > 1 / (1 + Math.exp(-dF / 0.03))) p.t[k] = old;
        }
        // dispersal
        if (p.n > 3) {
          const rate = 0.012 + 0.02 * p.t.speed;
          for (let q = 0; q < 4; q++) {
            const nb = this.regionNbr[r * 4 + q];
            if (nb < 0 || env.regionLand[nb] < 3) continue;
            const amt = p.n * rate;
            if (amt < 0.3) continue;
            const fitNb = Math.exp(-sq((env.regionTemp[nb] - p.t.tempOpt) / (p.t.tol * 1.3)));
            if (fitNb < 0.15) continue;
            moves.push({ sp: p.sp, r: nb, n: amt, t: p.t });
            p.n -= amt;
          }
        }
        // speciation check
        if (p.n > 30 && rng.chance(0.015) && this.liveSpecies < 90) speciate.push(p);
      }
      // grazing feeds back on vegetation
      const graze = clamp(Lshare, 0, 1.2);
      if (graze > 0.05) {
        const rx = (r % RW) * RF;
        const ry = Math.floor(r / RW) * RF;
        for (let dy = 0; dy < RF; dy++) for (let dx = 0; dx < RF; dx++) env.veg[idx(rx + dx, ry + dy)] *= 1 - 0.17 * Math.min(1, graze);
      }
    }
    // apply dispersal (deterministic order)
    for (const m of moves) {
      const key = this.key(m.sp, m.r);
      const ex = this.pops.get(key);
      if (ex) {
        const tot = ex.n + m.n;
        for (const k of TRAIT_KEYS) ex.t[k] = (ex.t[k] * ex.n + m.t[k] * m.n) / tot;
        ex.n = tot;
      } else if (m.n >= 0.8) {
        this.pops.set(key, { sp: m.sp, r: m.r, n: m.n, t: { ...m.t } });
      }
    }
    // speciation: peripheral, isolated populations that drifted far from their ancestors
    for (const p of speciate) {
      if (!this.pops.has(this.key(p.sp, p.r))) continue;
      const sp = this.speciesById(p.sp);
      const ref = sp.ref;
      const dev = Math.abs(p.t.tempOpt - ref.tempOpt) / 6 + Math.abs(Math.log(p.t.size / ref.size)) / 0.6 + Math.abs(p.t.intel - ref.intel) / 0.3
        + Math.abs(p.t.speed - ref.speed) / 0.35 + Math.abs(p.t.soc - ref.soc) / 0.4 + Math.abs(p.t.eyes - ref.eyes) / 0.4;
      if (dev < 2.4 || w.day - sp.born < 30 * 360) continue;
      let neigh = 0;
      for (let q = 0; q < 4; q++) {
        const nb = this.regionNbr[p.r * 4 + q];
        const o = nb >= 0 ? this.pops.get(this.key(p.sp, nb)) : undefined;
        if (o && o.n > 5) neigh++;
      }
      if (neigh > 1) continue;
      const child = this.createSpecies(sp, sp.diet, p.t, this.daughterName(sp, p.t));
      this.pops.delete(this.key(p.sp, p.r));
      p.sp = child.id;
      this.pops.set(this.key(child.id, p.r), p);
      w.history.record('SPECIATION', w.day, `${child.name} diverged from ${sp.name}.`, 1, {
        x: (p.r % RW) * RF + RF / 2, y: Math.floor(p.r / RW) * RF + RF / 2,
        cause: 'An isolated population adapted to local conditions until it could no longer interbreed with its ancestors.',
      });
    }
    // predator danger map for the human layer
    this.predRisk.fill(0);
    for (const p of this.pops.values()) {
      if (this.speciesById(p.sp).diet !== 'carn') continue;
      this.predRisk[p.r] = Math.min(1, this.predRisk[p.r] + (p.n * metab(p.t.size) * (0.3 + p.t.aggr) * (0.3 + p.t.strength)) / 120);
    }
    // extirpation / extinction, awakening, bookkeeping
    const alive = new Map<number, number>();
    let awaken: Pop | null = null;
    for (const [key, p] of [...this.pops]) {
      if (p.n < 0.6) { this.pops.delete(key); continue; }
      alive.set(p.sp, (alive.get(p.sp) ?? 0) + p.n);
      const sp = this.speciesById(p.sp);
      if (sp.diet === 'omni' && p.t.intel >= 0.8 && p.t.soc >= 0.5 && p.n >= 30 && w.canAwakenAt(p.r)) {
        if (!awaken || p.n > awaken.n) awaken = p;
      }
    }
    this.liveSpecies = alive.size;
    for (const sp of this.species) {
      const tot = alive.get(sp.id) ?? 0;
      sp.peak = Math.max(sp.peak, tot);
      if (sp.extinct < 0 && tot <= 0) {
        sp.extinct = w.day;
        w.history.record('EXTINCTION', w.day, `${sp.name} went extinct.`, sp.peak > 500 ? 2 : 1, { cause: 'Its last populations could no longer sustain themselves.' });
      }
    }
    if (awaken) this.awaken(awaken);
    else if (!w.awakened && w.day >= this.nextRescueCheck) {
      this.nextRescueCheck = w.day + 40 * 360;
      this.rescueLineage();
    }
  }

  nextRescueCheck = 150 * 360;

  /**
   * If every omnivore lineage capable of becoming people has died out before anyone woke, a remnant population
   * survives in a refuge and re-founds the lineage (logged as a speciation, so the history stays honest).
   */
  private rescueLineage() {
    const w = this.world;
    const candidates = new Set<number>();
    for (const p of this.pops.values()) {
      const sp = this.speciesById(p.sp);
      if (sp.diet === 'omni' && p.t.intel > 0.3 && p.t.soc > 0.4) candidates.add(sp.id);
    }
    if (candidates.size) return;
    const env = w.env;
    let best = -1;
    let bs = -1;
    for (let r = 0; r < NR; r++) {
      if (env.regionLand[r] < 10) continue;
      const v = this.regionVeg(r);
      const T = env.regionTemp[r];
      const sc = v * Math.exp(-sq((T - 18) / 9));
      if (sc > bs) { bs = sc; best = r; }
    }
    if (best < 0) return;
    const T = env.regionTemp[best];
    const proto = this.createSpecies(null, 'omni', { size: 1.0, speed: 0.5, strength: 0.35, intel: 0.55, eyes: 0.7, hear: 0.5, tol: 14, tempOpt: T, aggr: 0.35, soc: 0.7 });
    proto.name = 'Proto ' + proto.name;
    const seen = new Set([best]);
    const frontier = [best];
    let placed = 0;
    while (frontier.length && placed < 9) {
      const r = frontier.shift()!;
      if (env.regionLand[r] < 4) continue;
      this.pops.set(this.key(proto.id, r), { sp: proto.id, r, n: Math.max(8, this.regionVeg(r) * K_PER_VEG * 0.05), t: { ...proto.ref, tempOpt: env.regionTemp[r] } });
      placed++;
      for (let k = 0; k < 4; k++) { const nb = this.regionNbr[r * 4 + k]; if (nb >= 0 && !seen.has(nb)) { seen.add(nb); frontier.push(nb); } }
    }
    w.history.record('SPECIATION', w.day, `A new social omnivore lineage, ${proto.name}, took hold in a sheltered refuge.`, 1, {
      x: (best % RW) * RF + RF / 2, y: Math.floor(best / RW) * RF + RF / 2, cause: 'Earlier omnivore lineages had died out; a remnant population in a refuge re-founded the line.',
    });
  }

  private awaken(p: Pop) {
    const w = this.world;
    const sp = this.speciesById(p.sp);
    const band = Math.round(clamp(p.n * 0.5, 22, 40));
    if (!w.awakenBand(sp, p.r, band, p.t)) return;
    sp.sapientAwakenings++;
    // the proto-population in the surrounding area became people
    for (const [key, q] of [...this.pops]) {
      if (q.sp === p.sp && this.regionDist(q.r, p.r) <= 2) this.pops.delete(key);
    }
  }

  // ---- queries used by the rest of the world ----
  gameBiomass(r: number): number {
    let b = 0;
    for (const p of this.pops.values()) {
      if (p.r !== r) continue;
      const sp = this.speciesById(p.sp);
      if (sp.diet !== 'carn') b += p.n * p.t.size;
    }
    return b;
  }
  /** People hunt: removes animals, returns food (person-days). */
  hunt(r: number, want: number): number {
    const FOOD_PER_MASS = 9;
    const cands: Pop[] = [];
    let tot = 0;
    for (const p of this.pops.values()) {
      if (p.r !== r) continue;
      if (this.speciesById(p.sp).diet === 'carn') continue;
      if (p.n < 2) continue;
      cands.push(p);
      tot += p.n * p.t.size;
    }
    if (tot < 1) return 0;
    const wantMass = want / FOOD_PER_MASS;
    const take = Math.min(wantMass, tot * 0.2);
    for (const p of cands) {
      const share = (p.n * p.t.size) / tot;
      p.n = Math.max(0, p.n - (take * share) / p.t.size);
    }
    return take * FOOD_PER_MASS;
  }
  /** How many individual animals are "visible" for a population (a representative sample of an aggregated herd). */
  markerCount(pop: Pop): number {
    return Math.min(14, Math.max(1, Math.ceil(Math.log2(1 + pop.n) * 1.4)));
  }
  /** Where the m-th visible animal of a population is at a given time: deterministic, so hunters and the camera agree. */
  markerPos(pop: Pop, m: number, day: number): { x: number; y: number } | null {
    const cells = this.regionCells[pop.r];
    if (!cells.length) return null;
    const h = mix32(mix32(pop.sp, pop.r), m);
    const cell = cells[h % cells.length];
    const wx = ((h >>> 8) % 1000) / 1000;
    const wy = ((h >>> 18) % 1000) / 1000;
    const ph = ((h >>> 3) % 628) / 100;
    return {
      x: (cell % W) + 0.15 + wx * 0.7 + Math.sin(day * 0.9 + ph) * 0.02,
      y: Math.floor(cell / W) + 0.15 + wy * 0.7 + Math.cos(day * 0.8 + ph) * 0.02,
    };
  }
  /** A hunter killed one animal of this population. Returns meat in food units, or 0 if the herd is gone. */
  killAnimal(pop: Pop): number {
    if (pop.n < 1.5) return 0;
    pop.n -= 1;
    return pop.t.size * 12;
  }
  popsInRegion(r: number): Pop[] {
    const out: Pop[] = [];
    for (const p of this.pops.values()) if (p.r === r) out.push(p);
    return out;
  }

  totals() {
    let n = 0;
    const live = new Set<number>();
    for (const p of this.pops.values()) { n += p.n; live.add(p.sp); }
    return { animals: Math.round(n), species: live.size };
  }
}
