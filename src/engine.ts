import type { World } from './sim/world';
import { DAYS_PER_YEAR } from './sim/time';

export const SPEEDS = [0, 0.1, 1, 10, 100, 1000, 10000];
export const SPEED_LABELS = ['❚❚', '×0.1', '×1', '×10', '×100', '×1,000', '×10,000'];
export const SPEED = { pause: 0, slow: 1, x1: 2, x10: 3, x100: 4, x1k: 5, x10k: 6 };

/** Tick size grows with speed: fine-grained when watching one person, coarse when centuries fly by. */
export function stepFor(daysPerSec: number): number {
  if (daysPerSec <= 0.1) return 0.05;
  if (daysPerSec <= 1) return 0.25;
  if (daysPerSec <= 10) return 1;
  if (daysPerSec <= 100) return 2;
  if (daysPerSec <= 1000) return 7;
  return 30;
}

/** Drives the simulation from real time with a per-frame budget. Rendering reads the world; it never writes. */
export class Engine {
  speedIdx = 4;
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
      this.debt += Math.min(dtReal, 0.1) * dps;
      let guard = 0;
      while (this.debt >= step && guard++ < 20000) {
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
