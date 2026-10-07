import { AXIAL_TILT, DAYS_PER_YEAR, dayOfYear } from '../sim/time';
import { AU_KM, MOON } from '../sim/space';

/**
 * From the solar system's frame (ecliptic, heliocentric, km) to the planet's own rotating frame (y = north pole), for a
 * given day and sun azimuth. The sun's direction comes out exactly as the day/night cycle on the ground has it.
 */
export class Heavens {
  lambda = 0; // sun's ecliptic longitude
  beta = 0; // spin: equatorial → planet frame rotation about the pole
  sunDir: [number, number, number] = [1, 0, 0];
  /** heliocentric ecliptic position of the home planet (km) */
  home: [number, number, number] = [AU_KM, 0, 0];
  private ce = Math.cos(AXIAL_TILT);
  private se = Math.sin(AXIAL_TILT);
  private cb = 1;
  private sb = 0;

  update(day: number, sunAzimuth: number) {
    this.lambda = ((dayOfYear(day) - 90) / DAYS_PER_YEAR) * Math.PI * 2;
    const l = this.lambda;
    const ex = Math.cos(l), ey = Math.sin(l) * this.se, ez = Math.sin(l) * this.ce; // sun, equatorial
    const alpha = Math.atan2(ez, ex);
    this.beta = sunAzimuth - alpha;
    this.cb = Math.cos(this.beta);
    this.sb = Math.sin(this.beta);
    this.home = [-Math.cos(l) * AU_KM, 0, -Math.sin(l) * AU_KM];
    this.sunDir = this.vec(Math.cos(l), 0, Math.sin(l));
  }

  /** Planet-frame position (km) of a heliocentric ecliptic point (km). */
  place(hx: number, hy: number, hz: number): [number, number, number] {
    return this.vec(hx - this.home[0], hy - this.home[1], hz - this.home[2]);
  }
  vec(X: number, Y: number, Z: number): [number, number, number] {
    const x = X, y = Z * this.se + Y * this.ce, z = Z * this.ce - Y * this.se;
    return [x * this.cb - z * this.sb, y, x * this.sb + z * this.cb];
  }
  /** The 4×4 (column-major) matrix taking heliocentric ecliptic km to planet frame km. */
  matrix(out: number[]): number[] {
    // R = Rspin · Rtilt, then translate by -R·home
    const ce = this.ce, se = this.se, cb = this.cb, sb = this.sb;
    // Rtilt rows: x' = X; y' = ce Y + se Z; z' = -se Y + ce Z
    // Rspin rows: x'' = cb x' - sb z'; y'' = y'; z'' = sb x' + cb z'
    const m = [
      [cb, sb * se, -sb * ce],
      [0, ce, se],
      [sb, -cb * se, cb * ce],
    ];
    const h = this.home;
    const t = [-(m[0][0] * h[0] + m[0][1] * h[1] + m[0][2] * h[2]), -(m[1][0] * h[0] + m[1][1] * h[1] + m[1][2] * h[2]), -(m[2][0] * h[0] + m[2][1] * h[1] + m[2][2] * h[2])];
    out[0] = m[0][0]; out[1] = m[1][0]; out[2] = m[2][0]; out[3] = 0;
    out[4] = m[0][1]; out[5] = m[1][1]; out[6] = m[2][1]; out[7] = 0;
    out[8] = m[0][2]; out[9] = m[1][2]; out[10] = m[2][2]; out[11] = 0;
    out[12] = t[0]; out[13] = t[1]; out[14] = t[2]; out[15] = 1;
    return out;
  }

  /** The moon (planet frame, km): it circles once a sidereal month on a slightly tilted orbit. */
  moon(day: number): [number, number, number] {
    const lm = this.lambda + Math.PI + (day / MOON.synodicDays) * Math.PI * 2;
    const inc = 0.09;
    const node = (day / 6798) * Math.PI * 2;
    const X = Math.cos(lm), Z = Math.sin(lm), Y = Math.sin(inc) * Math.sin(lm - node);
    return this.vec(X * MOON.distKm, Y * MOON.distKm, Z * MOON.distKm);
  }
}
