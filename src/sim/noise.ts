import { Rng } from './rng';

/** Seeded 3D gradient noise. Pure function of position => planets are exactly reproducible. */
export class Noise3 {
  private perm = new Uint8Array(512);
  constructor(seed: number) {
    const rng = new Rng(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = rng.int(i + 1);
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }
  private static fade(t: number) {
    return t * t * t * (t * (t * 6 - 15) + 10);
  }
  private static grad(h: number, x: number, y: number, z: number) {
    const hh = h & 15;
    const u = hh < 8 ? x : y;
    const v = hh < 4 ? y : hh === 12 || hh === 14 ? x : z;
    return ((hh & 1) === 0 ? u : -u) + ((hh & 2) === 0 ? v : -v);
  }
  /** Range approx [-1, 1]. */
  noise(x: number, y: number, z: number): number {
    const perm = this.perm;
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;
    const Z = Math.floor(z) & 255;
    x -= Math.floor(x);
    y -= Math.floor(y);
    z -= Math.floor(z);
    const u = Noise3.fade(x);
    const v = Noise3.fade(y);
    const w = Noise3.fade(z);
    const A = perm[X] + Y;
    const AA = perm[A] + Z;
    const AB = perm[A + 1] + Z;
    const B = perm[X + 1] + Y;
    const BA = perm[B] + Z;
    const BB = perm[B + 1] + Z;
    const g = Noise3.grad;
    const l = (a: number, b: number, t: number) => a + t * (b - a);
    return l(
      l(l(g(perm[AA], x, y, z), g(perm[BA], x - 1, y, z), u), l(g(perm[AB], x, y - 1, z), g(perm[BB], x - 1, y - 1, z), u), v),
      l(
        l(g(perm[AA + 1], x, y, z - 1), g(perm[BA + 1], x - 1, y, z - 1), u),
        l(g(perm[AB + 1], x, y - 1, z - 1), g(perm[BB + 1], x - 1, y - 1, z - 1), u),
        v,
      ),
      w,
    );
  }
  fbm(x: number, y: number, z: number, octaves: number, lacunarity = 2, gain = 0.5): number {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * this.noise(x * freq, y * freq, z * freq);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }
  /** Ridged multifractal in [0,1]: sharp mountain crests. */
  ridged(x: number, y: number, z: number, octaves: number): number {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      const n = 1 - Math.abs(this.noise(x * freq, y * freq, z * freq));
      sum += amp * n * n;
      norm += amp;
      amp *= 0.5;
      freq *= 2.1;
    }
    return sum / norm;
  }
}
