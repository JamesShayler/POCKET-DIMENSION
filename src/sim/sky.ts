import type { World } from './world';
import { Rng, clamp, hashStr } from './rng';
import { W, H, idx, NR, regionOfCell } from './grid';
import { DAYS_PER_YEAR, yearOf } from './time';
import { NATURAL_PHONOLOGY, makeWord } from './names';

/** Comets (periodic, visible) and rare asteroid strikes. Orbits are drawn from the seed; consequences are physical. */
export interface Comet {
  name: string;
  period: number; // years
  phase: number; // 0..1 at day 0
  e: number;
  incl: number;
  node: number;
  size: number;
}
export interface Asteroid {
  name: string;
  impactDay: number;
  x: number;
  y: number;
  struck: boolean;
}

export class Sky {
  comets: Comet[] = [];
  asteroids: Asteroid[] = [];
  dustUntil = -1;
  dustStrength = 0;
  private rng: Rng;

  constructor(private world: World) {
    const rng = new Rng(hashStr('sky') ^ world.seed);
    this.rng = rng;
    const n = 2 + rng.int(3);
    for (let i = 0; i < n; i++) {
      this.comets.push({
        name: makeWord(NATURAL_PHONOLOGY, rng, 2), period: 40 + rng.next() * 400, phase: rng.next(), e: 0.82 + rng.next() * 0.15,
        incl: (rng.next() - 0.5) * 1.6, node: rng.next() * Math.PI * 2, size: 0.5 + rng.next(),
      });
    }
    // a handful of future strikes over deep time (roughly one per ten thousand years)
    let t = 0;
    for (let i = 0; i < 12; i++) {
      t += -Math.log(1 - rng.next()) * 9000;
      this.asteroids.push({ name: makeWord(NATURAL_PHONOLOGY, rng, 3), impactDay: t * DAYS_PER_YEAR, x: rng.next() * W, y: 10 + rng.next() * (H - 20), struck: false });
    }
  }

  /** Direction (planet frame, unit) and relative brightness of a comet. */
  cometState(c: Comet, day: number): { dir: [number, number, number]; r: number; bright: number } {
    const M = 2 * Math.PI * (day / DAYS_PER_YEAR / c.period + c.phase);
    // crude Kepler: iterate E
    let E = M;
    for (let i = 0; i < 6; i++) E = M + c.e * Math.sin(E);
    const nu = 2 * Math.atan2(Math.sqrt(1 + c.e) * Math.sin(E / 2), Math.sqrt(1 - c.e) * Math.cos(E / 2));
    const a = 1;
    const r = (a * (1 - c.e * c.e)) / (1 + c.e * Math.cos(nu));
    const x = Math.cos(nu + c.node) * Math.cos(c.incl);
    const z = Math.sin(nu + c.node) * Math.cos(c.incl);
    const y = Math.sin(c.incl) * Math.sin(nu);
    const L = Math.hypot(x, y, z) || 1;
    return { dir: [x / L, y / L, z / L], r, bright: clamp(0.04 / (r * r) - 0.02) * c.size };
  }

  /** An approaching asteroid within the final year, for the sky. */
  approaching(day: number): { a: Asteroid; t: number } | null {
    for (const a of this.asteroids) if (!a.struck && a.impactDay - day < 330 && a.impactDay - day > 0) return { a, t: 1 - (a.impactDay - day) / 330 };
    return null;
  }

  dust(day: number): number {
    if (day >= this.dustUntil) return 1;
    return 1 - this.dustStrength * clamp((this.dustUntil - day) / (4 * DAYS_PER_YEAR));
  }

  step() {
    const w = this.world;
    for (const a of this.asteroids) {
      if (a.struck || w.day < a.impactDay) continue;
      a.struck = true;
      this.impact(a);
    }
  }

  private impact(a: Asteroid) {
    const w = this.world;
    const rad = 7;
    let killed = 0;
    for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
      const y = Math.floor(a.y) + dy;
      if (y < 0 || y >= H || Math.hypot(dx, dy) > rad) continue;
      const i = idx(((Math.floor(a.x) + dx) % W + W) % W, y);
      w.env.veg[i] = 0;
      w.env.fert[i] *= 0.5;
    }
    killed = w.killInRadius(a.x, a.y, rad, 0.93, 'an asteroid impact');
    for (const s of w.activeSettlements()) if (Math.hypot(s.x - a.x, s.y - a.y) < rad) { w.buildings.destroy(s.id, 0.95, w.rng); s.food = 0; }
    this.dustUntil = w.day + 4 * DAYS_PER_YEAR;
    this.dustStrength = 0.45;
    w.history.record('DISASTER', w.day, `An asteroid, ${a.name}, struck the world${killed ? `, killing ${killed}` : ''}. Dust dimmed the sky for years.`, 3, {
      x: a.x, y: a.y, cause: `${a.name} was on a collision course that began ${yearOf(w.day)} years of orbits before; the cold that followed shortened growing seasons everywhere.`,
    });
  }
}
void NR; void regionOfCell;
