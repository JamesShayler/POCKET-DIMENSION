import type { World } from './world';
import { Rng, clamp } from './rng';
import { H, NR, RF, RH, RW, W, idx } from './grid';
import { NATURAL_PHONOLOGY, makeWord } from './names';
import { WW } from './weather';

/**
 * Life in the sea. Ocean productivity comes from the simulated ocean: cold, nutrient-rich upwelling feeds plankton, warm
 * still water starves it, and light falls off toward the poles in winter. On that base live lineages of forage fish,
 * predatory fish, sharks, squid, turtles, seals and whales, each with a temperature preference that mutates; populations
 * drift with the currents into neighbouring waters, and those isolated in different climates split into new species.
 * Fishing fleets take from the same populations they depend on.
 */
export type MarineRole = 'forage' | 'predator' | 'shark' | 'squid' | 'turtle' | 'seal' | 'whale';
export interface MarineSpecies {
  id: number;
  name: string;
  role: MarineRole;
  parent: number;
  born: number;
  extinct: number;
  tempOpt: number; // °C
  tempTol: number;
  size: number; // m
  /** biomass per ocean region (tonnes, scaled) */
  pop: Float32Array;
  /** per-region drift of the temperature preference away from the species reference */
  drift: Float32Array;
}

const ROLE: Record<MarineRole, { trophic: number; growth: number; size: [number, number]; coastal: number }> = {
  forage: { trophic: 0, growth: 1.6, size: [0.1, 0.4], coastal: 0.5 },
  squid: { trophic: 1, growth: 1.1, size: [0.3, 2], coastal: 0.2 },
  predator: { trophic: 1, growth: 0.8, size: [0.6, 3], coastal: 0.4 },
  turtle: { trophic: 0.5, growth: 0.25, size: [0.6, 1.8], coastal: 0.8 },
  seal: { trophic: 1.5, growth: 0.3, size: [1.2, 4], coastal: 0.9 },
  shark: { trophic: 2, growth: 0.3, size: [1.5, 8], coastal: 0.3 },
  whale: { trophic: 0.8, growth: 0.12, size: [8, 28], coastal: 0.1 },
};

export class Marine {
  species: MarineSpecies[] = [];
  /** ocean cells per region (0 = no sea) and mean sea temperature / productivity there */
  oceanCells = new Uint16Array(NR);
  coastCells = new Uint16Array(NR);
  sst = new Float32Array(NR);
  prod = new Float32Array(NR);
  /** what fishing fleets took this season (for the fishing yield) */
  catch = new Float32Array(NR);
  next = 1;
  rng: Rng;

  constructor(private world: World) {
    this.rng = Rng.derive(world.seed, 'marine');
    const p = world.planet;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = idx(x, y);
      const r = Math.floor(y / RF) * RW + Math.floor(x / RF);
      if (p.ocean[i]) { this.oceanCells[r]++; if (p.coastDist[i] <= 1) this.coastCells[r]++; }
    }
  }

  /** Seed the first lineages (called once, with the rest of life). */
  seed() {
    const rng = this.rng;
    const roles: MarineRole[] = ['forage', 'forage', 'forage', 'squid', 'predator', 'predator', 'turtle', 'seal', 'shark', 'whale', 'whale'];
    this.measure();
    for (const role of roles) {
      const R = ROLE[role];
      const sp = this.make(role, rng.range(-1, 27), rng.range(R.size[0], R.size[1]), 0);
      for (let r = 0; r < NR; r++) if (this.oceanCells[r]) sp.pop[r] = this.capacity(sp, r) * 0.5;
    }
  }

  private make(role: MarineRole, tempOpt: number, size: number, parent: number): MarineSpecies {
    const sp: MarineSpecies = {
      id: this.next++, name: makeWord(NATURAL_PHONOLOGY, this.rng, 2 + this.rng.int(2)), role, parent, born: this.world.day, extinct: -1,
      tempOpt, tempTol: 6 + this.rng.next() * 6, size, pop: new Float32Array(NR), drift: new Float32Array(NR),
    };
    this.species.push(sp);
    return sp;
  }

  /** Sea temperature and productivity per region from the weather's ocean. */
  private measure() {
    const wx = this.world.weather;
    this.sst.fill(0);
    this.prod.fill(0);
    const cnt = new Uint16Array(NR);
    const wh = wx.sst.length / WW;
    for (let y = 0; y < wh; y++) for (let x = 0; x < WW; x++) {
      const k = y * WW + x;
      if (wx.land[k] > 0.5) continue;
      const r = Math.floor((y * 2) / RF) * RW + Math.floor((x * 2) / RF);
      this.sst[r] += wx.sst[k];
      this.prod[r] += 0.35 + wx.upwell[k] * 1.6 + clamp((18 - wx.sst[k]) / 25) * 0.6;
      cnt[r]++;
    }
    for (let r = 0; r < NR; r++) if (cnt[r]) { this.sst[r] /= cnt[r]; this.prod[r] /= cnt[r]; }
    // shallow coastal shelves are richer
    for (let r = 0; r < NR; r++) if (this.oceanCells[r]) this.prod[r] *= 1 + (this.coastCells[r] / this.oceanCells[r]) * 0.8;
  }

  private suit(sp: MarineSpecies, r: number): number {
    const t = (this.sst[r] - (sp.tempOpt + sp.drift[r])) / sp.tempTol;
    return Math.exp(-t * t);
  }

  private capacity(sp: MarineSpecies, r: number): number {
    const R = ROLE[sp.role];
    const area = this.oceanCells[r] * (1 - R.coastal) + this.coastCells[r] * R.coastal * 2.5;
    return area * this.prod[r] * this.suit(sp, r) * 100 / Math.pow(4, R.trophic) / Math.sqrt(sp.size);
  }

  /** Biomass of forage and predatory fish in a region (what fishers depend on). */
  fishAt(r: number): number {
    let s = 0;
    for (const sp of this.species) if (sp.extinct < 0 && (sp.role === 'forage' || sp.role === 'predator' || sp.role === 'squid')) s += sp.pop[r];
    return s;
  }
  /** How rich the local fishery is relative to an untouched one (0..~1.5). */
  fishery(x: number, y: number): number {
    const r = Math.floor(clamp(y, 0, H - 1) / RF) * RW + Math.floor((((x % W) + W) % W) / RF);
    if (!this.oceanCells[r]) return 1; // rivers and lakes: freshwater fish, not modelled per species
    let cap = 0;
    for (const sp of this.species) if (sp.extinct < 0 && (sp.role === 'forage' || sp.role === 'predator' || sp.role === 'squid')) cap += this.capacity(sp, r);
    return clamp(this.fishAt(r) / Math.max(1, cap * 0.6), 0.05, 1.5);
  }
  /** Fishing fleets take biomass; called from the fishing job with the catch in food units. */
  take(x: number, y: number, amount: number) {
    const r = Math.floor(clamp(y, 0, H - 1) / RF) * RW + Math.floor((((x % W) + W) % W) / RF);
    this.catch[r] += amount;
  }

  /** Once per season. */
  season() {
    const w = this.world;
    const rng = this.rng;
    this.measure();
    const live = this.species.filter((s) => s.extinct < 0);
    // predators need prey: total lower-level biomass per region
    const prey = new Float32Array(NR);
    for (const sp of live) if (ROLE[sp.role].trophic < 1) for (let r = 0; r < NR; r++) prey[r] += sp.pop[r];
    const tmp = new Float32Array(NR);
    for (const sp of live) {
      const R = ROLE[sp.role];
      for (let r = 0; r < NR; r++) {
        if (!this.oceanCells[r]) continue;
        let n = sp.pop[r];
        let cap = this.capacity(sp, r);
        if (R.trophic >= 1) cap *= clamp(prey[r] / Math.max(1, cap * 6));
        const g = R.growth * 0.25;
        n += g * n * (1 - n / Math.max(0.01, cap));
        // fishing pressure falls on fish (and, with ships, on whales)
        const c = this.catch[r];
        if (c > 0 && (sp.role === 'forage' || sp.role === 'predator' || sp.role === 'squid')) n -= Math.min(n * 0.5, c * 0.4 * (n / Math.max(1, this.fishAt(r))));
        sp.pop[r] = Math.max(0, n);
        // selection nudges the local population toward the local water
        sp.drift[r] += clamp(this.sst[r] - (sp.tempOpt + sp.drift[r]), -1, 1) * 0.02 + rng.gauss() * 0.03;
      }
      // dispersal: a share swims (or is carried) into neighbouring seas
      tmp.fill(0);
      for (let r = 0; r < NR; r++) {
        const n = sp.pop[r];
        if (n <= 0) continue;
        const out = n * (sp.role === 'whale' ? 0.25 : sp.role === 'turtle' ? 0.12 : 0.06);
        const x = r % RW, y = Math.floor(r / RW);
        const nb = [y * RW + ((x + 1) % RW), y * RW + ((x - 1 + RW) % RW), y > 0 ? r - RW : -1, y < RH - 1 ? r + RW : -1].filter((q) => q >= 0 && this.oceanCells[q]);
        if (!nb.length) continue;
        tmp[r] -= out;
        for (const q of nb) { tmp[q] += out / nb.length; sp.drift[q] = sp.drift[q] * 0.97 + sp.drift[r] * 0.03; }
      }
      let total = 0;
      for (let r = 0; r < NR; r++) { sp.pop[r] = Math.max(0, sp.pop[r] + tmp[r]); total += sp.pop[r]; }
      if (total < 0.5) {
        sp.extinct = w.day;
        w.history.record('EXTINCTION', w.day, `The ${sp.name}, a ${roleName(sp.role)} of the seas, died out.`, 1, { cause: sp.role === 'forage' || sp.role === 'predator' ? 'Its waters warmed or cooled beyond its tolerance, or were fished empty.' : 'It could no longer find enough food in waters that suited it.' });
      }
      // speciation: a population that has drifted far in its own waters becomes a new species
      if (live.length < 40 && rng.next() < 0.03) {
        let best = -1, bd = 0;
        for (let r = 0; r < NR; r++) if (sp.pop[r] > 5 && Math.abs(sp.drift[r]) > bd) { bd = Math.abs(sp.drift[r]); best = r; }
        if (best >= 0 && bd > 4) {
          const child = this.make(sp.role, sp.tempOpt + sp.drift[best], sp.size * (0.8 + rng.next() * 0.45), sp.id);
          for (let r = 0; r < NR; r++) if (Math.abs(sp.drift[r] - sp.drift[best]) < 2) { child.pop[r] = sp.pop[r] * 0.6; sp.pop[r] *= 0.4; child.drift[r] = sp.drift[r] - sp.drift[best]; }
          w.history.record('SPECIATION', w.day, `${child.name}, a ${roleName(child.role)}, diverged from ${sp.name} in ${child.tempOpt > sp.tempOpt ? 'warmer' : 'colder'} waters.`, 1, {
            x: (best % RW) * RF + RF / 2, y: Math.floor(best / RW) * RF + RF / 2, cause: `A population adapted to ${this.sst[best].toFixed(0)}°C water drifted apart from its ancestors.`,
          });
        }
      }
    }
    this.catch.fill(0);
  }

  /** Density of a role in a region relative to its carrying capacity (for drawing schools, spouts and fins). */
  density(role: MarineRole, r: number): number {
    let n = 0, cap = 0;
    for (const sp of this.species) if (sp.extinct < 0 && sp.role === role) { n += sp.pop[r]; cap += this.capacity(sp, r); }
    return cap > 0 ? clamp(n / cap) : 0;
  }
}

export function roleName(r: MarineRole): string {
  return r === 'forage' ? 'schooling fish' : r === 'predator' ? 'hunting fish' : r === 'squid' ? 'squid' : r === 'turtle' ? 'sea turtle' : r === 'seal' ? 'seal' : r === 'shark' ? 'shark' : 'whale';
}
