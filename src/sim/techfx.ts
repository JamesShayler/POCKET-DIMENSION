import type { Settlement } from './settlements';
import type { TechId } from './technology';

/** What a community's technologies actually do. Every number here is used by the simulation, not just displayed. */
const has = (s: Settlement | undefined, t: TechId) => !!s && (s.tech as Set<string>).has(t);

/** Fighting strength per fighter. */
export function military(s: Settlement | undefined): number {
  if (!s) return 1;
  let m = s.toolTier >= 3 ? 1.6 : s.toolTier >= 2 ? 1.35 : 1;
  if (has(s, 'gunpowder')) m *= 1.9;
  if (has(s, 'industry')) m *= 1.6;
  if (has(s, 'combustion')) m *= 1.4;
  if (has(s, 'flight')) m *= 1.5;
  if (has(s, 'radio')) m *= 1.2;
  return m;
}

/** Labour productivity from machines and power (on top of hand tools). */
export function workMult(s: Settlement): number {
  let m = 1;
  if (s.toolTier >= 3) m *= 1.25;
  if (has(s, 'steam')) m *= 1.35;
  if (has(s, 'industry')) m *= 1.4;
  if (has(s, 'electricity')) m *= 1.25;
  if (has(s, 'combustion')) m *= 1.3;
  if (has(s, 'computing')) m *= 1.15;
  return m;
}

/** Crop yield multiplier from knowledge (calendar, fertilisers, machines). */
export function yieldMult(s: Settlement): number {
  let m = 1;
  if (has(s, 'astronomy')) m *= 1.06;
  if (has(s, 'chemistry')) m *= 1.25;
  if (has(s, 'industry')) m *= 1.2;
  if (has(s, 'combustion')) m *= 1.35;
  return m;
}

/** Travel speed multiplier for trips and caravans. */
export function travelMult(s: Settlement | undefined): number {
  if (has(s, 'combustion')) return 4;
  if (has(s, 'steam')) return 1.8;
  return 1;
}

/** Ships able to cross open ocean (not just narrow straits). */
export function oceanGoing(s: Settlement | undefined): boolean {
  return has(s, 'steam') || (has(s, 'astronomy') && has(s, 'navigation'));
}

/** Multiplier on illness mortality. */
export function healthMult(s: Settlement | undefined): number {
  let m = 1;
  if (has(s, 'medicine')) m *= 0.7;
  if (has(s, 'chemistry')) m *= 0.9;
  if (has(s, 'electricity')) m *= 0.85;
  return m;
}

/** Inventiveness multiplier (more people with the means to experiment and share results). */
export function innovationMult(s: Settlement): number {
  let m = 1;
  if (has(s, 'printing')) m *= 1.6;
  if (has(s, 'electricity')) m *= 1.2;
  if (has(s, 'computing')) m *= 2;
  return m;
}

/** How far ideas and news reach (km). */
export function contactRange(s: Settlement): number {
  if (has(s, 'radio')) return 2500;
  if (has(s, 'printing') || has(s, 'steam')) return 700;
  if (has(s, 'navigation') || has(s, 'writing')) return 420;
  return 280;
}

/** How far from the capital a province can be and still be governed (km). */
export function governRange(s: Settlement | undefined): number {
  if (has(s, 'radio')) return 2000;
  if (has(s, 'steam')) return 700;
  if (has(s, 'writing')) return 330;
  return 270;
}
