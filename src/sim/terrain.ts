import { Noise3 } from './noise';
import { Rng, smoothstep } from './rng';

/**
 * Terrain as a pure function of direction on the unit sphere, so the simulation and the renderer can sample it at any
 * resolution and always agree. Large-scale shape comes from plate tectonics (continental and oceanic plates moving on
 * Euler poles: collisions raise mountain ranges and island arcs, subduction digs trenches, spreading opens rifts and
 * mid-ocean ridges); hotspots add volcanic islands; noise adds coastlines and erosion-like relief. The fine-detail
 * octaves used for close-up rendering never change the sign of the base elevation, so coastlines are identical at
 * every level of detail.
 */
export interface Plate {
  c: [number, number, number];
  pole: [number, number, number];
  rate: number;
  base: number;
  continental: boolean;
}
export interface Hotspot { c: [number, number, number]; r: number; h: number }

export interface Tectonics { i: number; j: number; b: number; conv: number }

export class TerrainSampler {
  noise: Noise3;
  detailNoise: Noise3;
  seaLevel = 0;
  plates: Plate[] = [];
  hotspots: Hotspot[] = [];

  constructor(seed: number) {
    this.noise = new Noise3(Rng.derive(seed, 'terrain').state);
    this.detailNoise = new Noise3(Rng.derive(seed, 'terrain-detail').state);
    const rng = Rng.derive(seed, 'plates');
    const n = 12 + rng.int(6);
    const unit = (): [number, number, number] => {
      const u = rng.next() * 2 - 1;
      const t = rng.next() * Math.PI * 2;
      const q = Math.sqrt(1 - u * u);
      return [q * Math.cos(t), u, q * Math.sin(t)];
    };
    for (let i = 0; i < n; i++) {
      const continental = rng.next() < 0.42;
      this.plates.push({ c: unit(), pole: unit(), rate: 0.4 + rng.next() * 1.1, base: continental ? 0.2 + rng.next() * 0.1 : -0.3 - rng.next() * 0.1, continental });
    }
    const nh = 3 + rng.int(4);
    for (let i = 0; i < nh; i++) this.hotspots.push({ c: unit(), r: 0.025 + rng.next() * 0.035, h: 0.5 + rng.next() * 0.6 });
  }

  /** Nearest plate, second-nearest plate, closeness to their boundary (radians) and convergence rate there. */
  tectonics(x: number, y: number, z: number): Tectonics {
    const nz = this.noise;
    // warp so plate boundaries wander like real ones
    const wx = x + nz.noise(x * 1.7 + 11, y * 1.7, z * 1.7) * 0.26 + nz.noise(x * 5 + 3, y * 5, z * 5) * 0.06;
    const wy = y + nz.noise(x * 1.7, y * 1.7 + 17, z * 1.7) * 0.26 + nz.noise(x * 5, y * 5 + 9, z * 5) * 0.06;
    const wz = z + nz.noise(x * 1.7, y * 1.7, z * 1.7 + 23) * 0.26 + nz.noise(x * 5, y * 5, z * 5 + 5) * 0.06;
    const L = Math.hypot(wx, wy, wz) || 1;
    const px = wx / L, py = wy / L, pz = wz / L;
    let i = 0, j = 1, di = -2, dj = -2;
    for (let k = 0; k < this.plates.length; k++) {
      const c = this.plates[k].c;
      const d = c[0] * px + c[1] * py + c[2] * pz;
      if (d > di) { dj = di; j = i; di = d; i = k; } else if (d > dj) { dj = d; j = k; }
    }
    const b = (Math.acos(Math.max(-1, Math.min(1, dj))) - Math.acos(Math.max(-1, Math.min(1, di)))) / 2;
    const A = this.plates[i], B = this.plates[j];
    // tangent direction from plate i towards plate j at this point
    let nx = B.c[0] - A.c[0], ny = B.c[1] - A.c[1], nzz = B.c[2] - A.c[2];
    const dp = nx * px + ny * py + nzz * pz;
    nx -= dp * px; ny -= dp * py; nzz -= dp * pz;
    const nl = Math.hypot(nx, ny, nzz) || 1;
    nx /= nl; ny /= nl; nzz /= nl;
    // surface velocities (pole x position) * rate
    const vel = (P: Plate) => [
      (P.pole[1] * pz - P.pole[2] * py) * P.rate,
      (P.pole[2] * px - P.pole[0] * pz) * P.rate,
      (P.pole[0] * py - P.pole[1] * px) * P.rate,
    ];
    const va = vel(A), vb = vel(B);
    const conv = (va[0] - vb[0]) * nx + (va[1] - vb[1]) * ny + (va[2] - vb[2]) * nzz;
    return { i, j, b, conv };
  }

  raw(x: number, y: number, z: number): number {
    const n = this.noise;
    const t = this.tectonics(x, y, z);
    const A = this.plates[t.i], B = this.plates[t.j];
    const wgt = 0.5 + 0.5 * smoothstep(0, 0.2, t.b);
    let e = A.base * wgt + B.base * (1 - wgt);
    // coastlines and continental interiors
    {
      // domain-warped continental noise: irregular coasts, peninsulas, inland seas
      const qx = n.fbm(x * 1.1 + 5, y * 1.1, z * 1.1, 3) * 0.6, qy = n.fbm(x * 1.1, y * 1.1 + 8, z * 1.1, 3) * 0.6, qz = n.fbm(x * 1.1, y * 1.1, z * 1.1 - 4, 3) * 0.6;
      e += n.fbm((x + qx) * 1.6 + 3.1, (y + qy) * 1.6 + 1.7, (z + qz) * 1.6 - 2.3, 6, 2.05, 0.52) * 0.62;
    }
    // plate boundaries
    const near = Math.exp(-Math.pow(t.b / 0.075, 2));
    const ridge = n.ridged(x * 3.2 - 7, y * 3.2 + 5, z * 3.2 + 11, 4);
    if (t.conv > 0) {
      const both = A.continental && B.continental;
      const one = A.continental !== B.continental;
      const strength = t.conv * (both ? 1.0 : one ? 0.75 : 0.45);
      // ranges sit on the overriding (continental) side; the subducting oceanic side gets a trench
      const side = one ? (A.continental ? 1 : -0.55) : 1;
      e += strength * near * side * (0.35 + 0.65 * ridge) * 0.85;
      if (one && !A.continental) e -= strength * Math.exp(-Math.pow(t.b / 0.03, 2)) * 0.35;
    } else {
      const s = -t.conv;
      if (A.continental && B.continental) e -= s * near * 0.22; // rift valley
      else if (!A.continental && !B.continental) e += s * Math.exp(-Math.pow(t.b / 0.05, 2)) * 0.14; // mid-ocean ridge
    }
    // old eroded uplands inside continents
    if (A.continental) e += Math.max(0, ridge - 0.55) * 0.35 * smoothstep(0.1, 0.4, t.b);
    // rolling relief
    e += n.fbm(x * 5 + 9, y * 5 - 4, z * 5 + 2, 4, 2, 0.5) * 0.13;
    // hotspot volcanoes
    for (const h of this.hotspots) {
      const d = 1 - (h.c[0] * x + h.c[1] * y + h.c[2] * z);
      if (d < h.r * h.r * 8) e += h.h * Math.exp(-d / (h.r * h.r * 0.5));
    }
    return e;
  }

  /** Base elevation in km relative to sea level (negative = ocean depth). This is what the simulation uses. */
  elevKm(x: number, y: number, z: number): number {
    const e = this.raw(x, y, z) - this.seaLevel;
    return e >= 0 ? e * 6.4 : e * 7.5;
  }

  /**
   * Fine relief (km) added on top of the base elevation for close-up rendering, down to wavelengths of
   * 2π/maxFreq planet radii. Rough in mountains, gentle on plains, nothing under the sea, and it never moves a point
   * across sea level.
   */
  detailKm(x: number, y: number, z: number, baseKm: number, maxFreq: number): number {
    if (baseKm <= 0) return 0;
    const n = this.detailNoise;
    const rough = 0.12 + 0.88 * smoothstep(0.15, 2.4, baseKm);
    let f = 48;
    let sum = 0;
    let k = 0;
    while (f <= maxFreq && k < 16) {
      const lambda = (2 * Math.PI * 1000) / f; // km
      const amp = 0.9 * Math.pow(lambda / 100, 0.8) * rough;
      const o = k * 17.13;
      // ridged in rough terrain (crests and gullies), smooth noise elsewhere
      const v = n.noise(x * f + o, y * f - o, z * f + o * 0.5);
      const r = 1 - Math.abs(v) * 2;
      sum += amp * (rough > 0.5 ? 0.6 * r + 0.4 * v : v);
      f *= 2;
      k++;
    }
    const coast = smoothstep(0, 0.04, baseKm);
    const e = baseKm + sum * coast;
    return Math.max(baseKm * 0.25, e) - baseKm;
  }
}
