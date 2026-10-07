import type { World } from './world';
import { Rng, clamp } from './rng';
import { NR, RW, RH } from './grid';
import { NATURAL_PHONOLOGY, makeWord } from './names';

/** Trees are evolving species too: each region has a dominant species that adapts to its climate and diverges. */
export interface TreeSpecies {
  id: number;
  name: string;
  parent: number;
  hue: number; // 0..1 foliage hue
  tempOpt: number;
  growYears: number; // generation time: years for a felled stand to regrow
  wood: number; // wood units per tree
  hardness: number; // 0 soft .. 1 very hard (needs better tools to fell quickly)
  born: number;
}

export class Flora {
  species: TreeSpecies[] = [];
  regionSp = new Int16Array(NR);
  rng: Rng;

  constructor(private world: World, rng: Rng) {
    this.rng = rng;
  }

  private mk(parent: TreeSpecies | null, tempOpt: number, name?: string): TreeSpecies {
    const rng = this.rng;
    const cold = clamp((12 - tempOpt) / 20);
    const warm = clamp((tempOpt - 12) / 20);
    const base: Omit<TreeSpecies, 'id' | 'name' | 'parent' | 'born' | 'hue' | 'tempOpt'> = parent
      ? {
          growYears: clamp(parent.growYears * (1 + rng.gauss() * 0.12), 8, 140),
          wood: clamp(parent.wood * (1 + rng.gauss() * 0.1), 2, 14),
          hardness: clamp(parent.hardness + rng.gauss() * 0.06),
        }
      : { growYears: 30 + cold * 60 - warm * 10 + rng.range(-8, 8), wood: 4 + warm * 4 + rng.range(-1, 2), hardness: clamp(0.3 + rng.gauss() * 0.15 + cold * 0.2) };
    const sp: TreeSpecies = {
      id: this.species.length + 1,
      name: name ?? `${makeWord(NATURAL_PHONOLOGY, rng, 2)} ${tempOpt > 22 ? rng.pick(['palm', 'teak', 'fig']) : tempOpt > 11 ? rng.pick(['oak', 'ash', 'elm', 'beech']) : rng.pick(['pine', 'spruce', 'birch', 'larch'])}`,
      parent: parent?.id ?? 0,
      hue: parent ? (parent.hue + rng.range(-0.03, 0.03) + 1) % 1 : 0.28 + warm * 0.04 - cold * 0.03 + rng.range(-0.03, 0.03),
      tempOpt,
      born: this.world.day,
      ...base,
    };
    this.species.push(sp);
    return sp;
  }

  seed() {
    const founders: TreeSpecies[] = [];
    for (let T = -4; T <= 30; T += 3.5) founders.push(this.mk(null, T + this.rng.range(-1, 1)));
    const env = this.world.env;
    for (let r = 0; r < NR; r++) {
      const T = env.regionTemp[r];
      let best = founders[0];
      let bd = 1e9;
      for (const f of founders) { const d = Math.abs(f.tempOpt - T); if (d < bd) { bd = d; best = f; } }
      this.regionSp[r] = best.id;
    }
  }

  /** Each season, local tree populations adapt; stands far from their ancestors' optimum become new species. */
  step() {
    const w = this.world;
    const env = w.env;
    for (let r = 0; r < NR; r++) {
      if (env.regionLand[r] < 3 || this.rng.next() > 0.03) continue;
      const sp = this.species[this.regionSp[r] - 1];
      const T = env.regionTemp[r];
      if (Math.abs(T - sp.tempOpt) > 3.2 && this.species.length < 260) {
        const child = this.mk(sp, T + this.rng.range(-1, 1));
        this.regionSp[r] = child.id;
        // neighbours with similar climate adopt it (spread)
        for (const nb of [r + 1, r - 1, r + RW, r - RW]) {
          if (nb >= 0 && nb < NR && Math.abs(env.regionTemp[nb] - T) < 2 && this.rng.chance(0.5)) this.regionSp[nb] = child.id;
        }
      }
    }
  }

  at(region: number): TreeSpecies {
    return this.species[(this.regionSp[region] || 1) - 1];
  }
}
void RH;
