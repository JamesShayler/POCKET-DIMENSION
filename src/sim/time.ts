/** Simulation time. 1 year = 360 days = 4 seasons x 90 days. Everything is measured in days since epoch. */
export const DAYS_PER_YEAR = 360;
export const DAYS_PER_SEASON = 90;
export const AXIAL_TILT = (23.5 * Math.PI) / 180;

export const yearOf = (day: number) => Math.floor(day / DAYS_PER_YEAR);
export const dayOfYear = (day: number) => ((day % DAYS_PER_YEAR) + DAYS_PER_YEAR) % DAYS_PER_YEAR;
export const seasonOf = (day: number) => Math.floor(dayOfYear(day) / DAYS_PER_SEASON); // 0 spring .. 3 winter
export const SEASON_NAMES = ['Spring', 'Summer', 'Autumn', 'Winter'];

/** Solar declination (radians): +tilt at northern midsummer (day 135 of 360). */
export function declination(day: number): number {
  return AXIAL_TILT * Math.sin(((dayOfYear(day) - 90) / DAYS_PER_YEAR) * Math.PI * 2);
}
/** -1..1, +1 at northern midsummer. */
export function seasonPhase(day: number): number {
  return Math.sin(((dayOfYear(day) - 90) / DAYS_PER_YEAR) * Math.PI * 2);
}
export function formatYear(day: number): string {
  return 'YEAR ' + yearOf(day).toLocaleString('en-US');
}
