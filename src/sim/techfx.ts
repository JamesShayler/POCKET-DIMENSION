import type { Settlement } from './settlements';
import type { TechId } from './technology';
import type { BDef } from './buildings';

/**
 * What a community's technologies actually do. Every number here is used by the simulation, not just displayed.
 * An art that has only just been made to work is crude: its effect grows with mastery and is complete at mastery.
 */
const has = (s: Settlement | undefined, t: TechId) => !!s && (s.tech as Set<string>).has(t);

/** How well the town practises an art, 0..1 (0 if it cannot use it; an art from before records counts as mastered). */
export const mastery = (s: Settlement | undefined, t: TechId): number => (!s || !has(s, t) ? 0 : s.prog?.[t]?.m ?? 1);
/** The share of an art's full effect the town gets: about a third at first success, all of it once mastered. */
export const eff = (s: Settlement | undefined, t: TechId): number => {
  const m = mastery(s, t);
  return m > 0 ? Math.min(1, 0.25 + (0.75 * m) / 0.85) : 0;
};
const boost = (base: number, e: number) => 1 + (base - 1) * e;
/** Whether the town can raise this building: it knows the arts, and practises them well enough. */
export const techOk = (s: Settlement, def: BDef) => def.tech.every((t) => has(s, t) && mastery(s, t) >= (def.mastery ?? 0));

/** Fighting strength per fighter. */
export function military(s: Settlement | undefined): number {
  if (!s) return 1;
  let m = s.toolTier >= 3 ? 1.6 : s.toolTier >= 2 ? 1.35 : 1;
  m *= boost(1.9, eff(s, 'gunpowder'));
  m *= boost(1.6, eff(s, 'industry'));
  m *= boost(1.4, eff(s, 'combustion'));
  m *= boost(1.5, eff(s, 'flight'));
  m *= boost(1.2, eff(s, 'radio'));
  return m;
}

/** Labour productivity from machines and power (on top of hand tools). */
export function workMult(s: Settlement): number {
  let m = 1;
  if (s.toolTier >= 3) m *= 1.25;
  m *= boost(1.35, eff(s, 'steam'));
  m *= boost(1.4, eff(s, 'industry'));
  m *= boost(1.25, eff(s, 'electricity'));
  m *= boost(1.3, eff(s, 'combustion'));
  m *= boost(1.15, eff(s, 'computing'));
  return m;
}

/** Crop yield multiplier from knowledge (calendar, fertilisers, machines). */
export function yieldMult(s: Settlement): number {
  let m = 1;
  m *= boost(1.06, eff(s, 'astronomy'));
  m *= boost(1.25, eff(s, 'chemistry'));
  m *= boost(1.2, eff(s, 'industry'));
  m *= boost(1.35, eff(s, 'combustion'));
  return m;
}

/** Travel speed multiplier for trips and caravans. */
export function travelMult(s: Settlement | undefined): number {
  return Math.max(1, boost(4, eff(s, 'combustion')) * (has(s, 'combustion') ? 1 : 0), boost(1.8, eff(s, 'steam')) * (has(s, 'steam') ? 1 : 0));
}

/** Ships able to cross open ocean (not just narrow straits): earned by seafaring, or by steam. */
export function oceanGoing(s: Settlement | undefined): boolean {
  return mastery(s, 'steam') >= 0.3 || mastery(s, 'seafaring') >= 0.3;
}

/** Multiplier on illness mortality. */
export function healthMult(s: Settlement | undefined): number {
  let m = 1;
  m *= boost(0.7, eff(s, 'medicine'));
  m *= boost(0.9, eff(s, 'chemistry'));
  m *= boost(0.85, eff(s, 'electricity'));
  return m;
}

/** Inventiveness multiplier (more people with the means to experiment and share results). */
export function innovationMult(s: Settlement): number {
  let m = 1;
  m *= boost(1.6, eff(s, 'printing'));
  m *= boost(1.2, eff(s, 'electricity'));
  m *= boost(2, eff(s, 'computing'));
  return m;
}

/** How far ideas and news reach (km). */
export function contactRange(s: Settlement): number {
  if (mastery(s, 'radio') >= 0.3) return 2500;
  if (mastery(s, 'printing') >= 0.2 || mastery(s, 'steam') >= 0.2) return 700;
  if (has(s, 'navigation') || has(s, 'writing')) return 420;
  return 280;
}

/** How far from the capital a province can be and still be governed (km). */
export function governRange(s: Settlement | undefined): number {
  if (mastery(s, 'radio') >= 0.3) return 2000;
  if (mastery(s, 'steam') >= 0.2) return 700;
  if (has(s, 'writing')) return 330;
  return 270;
}
