import type { World } from './sim/world';
import { DAYS_PER_YEAR } from './sim/time';

/** Simulated days per real second. ×1 is "living pace": one simulated minute per second, so a day lasts 24 real minutes
 *  and a person visibly walks, chops and builds. Higher steps compress hours, days, seasons and finally centuries. */
export const SPEEDS = [0, 1 / 1440, 1 / 144, 1 / 14.4, 1 / 1.44, 6.94, 69.4, 694, 6944];
export const SPEED_LABELS = ['❚❚', '×1', '×10', '×100', '×1k', '×10k', '×100k', '×1M', '×10M'];
export const SPEED_HINT = ['paused', '1 minute per second', '10 minutes per second', '100 minutes per second', '~17 hours per second', '~7 days per second', '~70 days per second', '~2 years per second', '~19 years per second'];
export const SPEED = { pause: 0, x1: 1, x10: 2, x100: 3, x1k: 4, x10k: 5, x100k: 6, x1M: 7, x10M: 8 };

/** Tick size: about a fifth of a real second of simulated time, from 30 simulated seconds up to 30 days. */
export function stepFor(daysPerSec: number): number {
  return Math.max(1 / 2880, Math.min(30, daysPerSec * 0.2));
}

/** Drives the simulation from real time with a per-frame budget. Rendering reads the world; it never writes. */
export class Engine {
  speedIdx = 1;
  debt = 0;
  sinceTick = 0;
  lastStep = 1;
  /** Measured simulation days per real second. */
  effective = 0;
  stepMs = 0;
  budgetMs = 11;
  ticksThisSecond = 0;
  private effAcc = 0;
  private effT = 0;
  jumping: { remaining: number; total: number; label: string } | null = null;
  renderDay = 0;

  constructor(public world: World) {
    this.renderDay = world.day;
  }

  get daysPerSec() {
    return SPEEDS[this.speedIdx];
  }
  get paused() {
    return this.speedIdx === 0;
  }
  setSpeed(i: number) {
    this.speedIdx = Math.max(0, Math.min(SPEEDS.length - 1, i));
  }

  /** Returns interpolation alpha for the renderer. */
  advance(dtReal: number): number {
    const w = this.world;
    const t0 = performance.now();
    let simmed = 0;
    if (this.jumping) {
      const j = this.jumping;
      const target = j.remaining;
      let done = 0;
      while (done < target && performance.now() - t0 < 22) {
        const step = Math.min(30, target - done);
        w.step(step);
        done += step;
      }
      j.remaining -= done;
      simmed = done;
      if (j.remaining <= 0.001) this.jumping = null;
      this.sinceTick = 0;
      this.debt = 0;
    } else if (!this.paused) {
      const dps = this.daysPerSec;
      const step = stepFor(dps);
      this.lastStep = step;
      this.debt += Math.min(dtReal, 0.25) * dps;
      let guard = 0;
      while (this.debt >= step && guard++ < 40000) {
        w.step(step);
        this.debt -= step;
        simmed += step;
        if (performance.now() - t0 > this.budgetMs) {
          // out of budget: shed the backlog so the observer never freezes
          this.debt = Math.min(this.debt, step * 2);
          break;
        }
      }
      this.sinceTick = step - this.debt;
    }
    const ms = performance.now() - t0;
    if (simmed > 0) this.stepMs = this.stepMs * 0.9 + ms * 0.1;
    this.effAcc += simmed;
    this.effT += dtReal;
    if (this.effT >= 0.5) {
      this.effective = this.effAcc / this.effT;
      this.effAcc = 0;
      this.effT = 0;
    }
    const still = this.paused || this.jumping;
    const alpha = still ? 1 : Math.max(0, Math.min(1, this.debt / this.lastStep));
    // the picture lags the simulation by one tick so motion is interpolated, never extrapolated
    this.renderDay = still ? w.day : Math.max(0, w.day - this.lastStep + this.debt);
    return alpha;
  }

  jump(years: number, label: string) {
    const days = years * DAYS_PER_YEAR;
    this.jumping = { remaining: days, total: days, label };
  }
  cancelJump() {
    this.jumping = null;
  }
}
