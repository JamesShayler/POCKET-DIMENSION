import { TerrainSampler } from '../sim/terrain';
import { Biome } from '../sim/planet';
import { H, R_KM, W } from '../sim/grid';

/**
 * Terrain chunks for the cube-sphere quadtree. Pure functions of the seed and the planet's arrays, run in worker threads.
 * Heights are the simulation's own terrain function (plate tectonics + noise) plus fine relief and carved river channels,
 * at true scale (no vertical exaggeration). Coastlines never move with level of detail, because fine relief never
 * crosses sea level.
 */

export const SEG = 32; // quads per chunk edge (fine levels)
/** Coarse tiles seen from orbit get twice the vertices, so coasts stay crisp from far away. */
export const segFor = (level: number) => (level <= 5 ? 64 : SEG);
export const TREE_LEVEL = 10; // chunks at or below this size carry individual trees
export const TREE_GRID = 1 << 17; // global tree lattice per cube face (≈12 m spacing)

export const FACES: { n: [number, number, number]; u: [number, number, number]; v: [number, number, number] }[] = [
  { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
  { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
  { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
  { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
];

/** Face parameter s in [-1, 1] → cube coordinate (tan mapping keeps cells nearly equal in area). */
const warp = (s: number) => Math.tan((s * Math.PI) / 4);
const unwarp = (c: number) => (Math.atan(c) * 4) / Math.PI;

export function faceDir(face: number, s: number, t: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  const f = FACES[face];
  const a = warp(s), b = warp(t);
  const x = f.n[0] + f.u[0] * a + f.v[0] * b;
  const y = f.n[1] + f.u[1] * a + f.v[1] * b;
  const z = f.n[2] + f.u[2] * a + f.v[2] * b;
  const L = Math.hypot(x, y, z);
  out[0] = x / L; out[1] = y / L; out[2] = z / L;
  return out;
}

/** Which face a direction falls on, and where (s, t in [-1, 1]). */
export function dirFace(x: number, y: number, z: number): { face: number; s: number; t: number } {
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  let face: number;
  if (ax >= ay && ax >= az) face = x > 0 ? 0 : 1;
  else if (ay >= az) face = y > 0 ? 2 : 3;
  else face = z > 0 ? 4 : 5;
  const f = FACES[face];
  const d = x * f.n[0] + y * f.n[1] + z * f.n[2];
  const a = (x * f.u[0] + y * f.u[1] + z * f.u[2]) / d;
  const b = (x * f.v[0] + y * f.v[1] + z * f.v[2]) / d;
  return { face, s: unwarp(a), t: unwarp(b) };
}

/** Map cell coordinates (continuous) of a unit direction. */
export function dirToMap(x: number, y: number, z: number): [number, number] {
  const lon = Math.atan2(z, x);
  const lat = Math.asin(Math.max(-1, Math.min(1, y)));
  return [((lon + Math.PI) / (Math.PI * 2)) * W, ((Math.PI / 2 - lat) / Math.PI) * H];
}

export interface TerrainInput {
  seed: number;
  seaLevel: number;
  ocean: Uint8Array;
  lake: Uint8Array;
  lakeLevel: Float32Array;
  river: Uint8Array;
  drain: Int32Array;
  flow: Float32Array;
  biome: Uint8Array;
  baseVeg: Float32Array;
  tempMean: Float32Array;
  elev: Float32Array;
}

interface Seg { ax: number; ay: number; bx: number; by: number; w: number; d: number }

export interface ChunkResult {
  key: string;
  center: [number, number, number]; // planet frame, km
  pos: Float32Array; // relative to center
  normal: Float32Array;
  dir: Float32Array; // unit direction per vertex (for texture lookups)
  elev: Float32Array; // km above sea level per vertex
  index: Uint32Array;
  heights: Float32Array; // (seg+1)² surface heights for placing things on the ground
  seg: number;
  water?: { pos: Float32Array; depth: Float32Array; dir: Float32Array; index: Uint32Array };
  trees?: Float32Array; // stride 8: x y z height crown type hue cell
  minH: number;
  maxH: number;
}

const hash = (a: number, b: number, c: number) => {
  let h = Math.imul(a, 374761393) ^ Math.imul(b, 668265263) ^ Math.imul(c, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

export class TerrainGen {
  sampler: TerrainSampler;
  private segs: Seg[] = [];
  private grid = new Map<number, number[]>();

  constructor(private d: TerrainInput) {
    this.sampler = new TerrainSampler(d.seed);
    this.sampler.seaLevel = d.seaLevel;
    // river channels: from each river cell to the cell it drains into
    let maxFlow = 1;
    for (let i = 0; i < d.flow.length; i++) if (d.river[i] && d.flow[i] > maxFlow) maxFlow = d.flow[i];
    for (let i = 0; i < d.river.length; i++) {
      if (!d.river[i] || d.ocean[i]) continue;
      const j = d.drain[i];
      if (j < 0) continue;
      const ax = (i % W) + 0.5, ay = Math.floor(i / W) + 0.5;
      let bx = (j % W) + 0.5;
      const by = Math.floor(j / W) + 0.5;
      if (bx - ax > W / 2) bx -= W;
      if (ax - bx > W / 2) bx += W;
      const f = Math.sqrt(d.flow[i] / maxFlow);
      const w = 0.025 + 0.55 * f * f + 0.08 * f; // km
      const seg: Seg = { ax, ay, bx, by, w, d: 0.002 + w * 0.025 };
      const si = this.segs.push(seg) - 1;
      const x0 = Math.floor(Math.min(ax, bx)) - 1, x1 = Math.floor(Math.max(ax, bx)) + 1;
      const y0 = Math.floor(Math.min(ay, by)) - 1, y1 = Math.floor(Math.max(ay, by)) + 1;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        if (y < 0 || y >= H) continue;
        const k = y * W + (((x % W) + W) % W);
        let l = this.grid.get(k);
        if (!l) { l = []; this.grid.set(k, l); }
        l.push(si);
      }
    }
  }

  /** Nearest river channel to a map position: distance (km), half-width, depth. */
  private river(mx: number, my: number): { dist: number; w: number; d: number } | null {
    const k = Math.floor(Math.max(0, Math.min(H - 1, my))) * W + (((Math.floor(mx) % W) + W) % W);
    const l = this.grid.get(k);
    if (!l) return null;
    const ky = (Math.PI * R_KM) / H;
    const kx = Math.max(1, ((2 * Math.PI * R_KM) / W) * Math.cos((0.5 - my / H) * Math.PI));
    let best: { dist: number; w: number; d: number } | null = null;
    for (const si of l) {
      const s = this.segs[si];
      let px = mx;
      if (px - s.ax > W / 2) px -= W;
      if (s.ax - px > W / 2) px += W;
      const dx = (s.bx - s.ax) * kx, dy = (s.by - s.ay) * ky;
      const qx = (px - s.ax) * kx, qy = (my - s.ay) * ky;
      const L2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, (qx * dx + qy * dy) / L2));
      const ex = qx - dx * t, ey = qy - dy * t;
      const dist = Math.sqrt(ex * ex + ey * ey);
      if (!best || dist < best.dist) best = { dist, w: s.w, d: s.d };
    }
    return best;
  }

  /** Full-detail surface height (km) and water surface (km, or NaN) for a unit direction at a given detail. */
  sample(x: number, y: number, z: number, maxFreq: number, out: { h: number; w: number; base: number }) {
    const base = this.sampler.elevKm(x, y, z);
    let h = base + this.sampler.detailKm(x, y, z, base, maxFreq);
    let water = NaN;
    if (base <= 0) {
      water = 0;
    } else {
      const [mx, my] = dirToMap(x, y, z);
      const cell = Math.floor(Math.max(0, Math.min(H - 1, my))) * W + (((Math.floor(mx) % W) + W) % W);
      // meanders: rivers wander around their cell-to-cell course
      const n = this.sampler.detailNoise;
      const wx = mx + n.noise(x * 700, y * 700, z * 700) * 0.06 + n.noise(x * 2100 + 5, y * 2100, z * 2100) * 0.015;
      const wy = my + n.noise(x * 700 + 9, y * 700 + 3, z * 700) * 0.06 + n.noise(x * 2100, y * 2100 + 7, z * 2100) * 0.015;
      const r = this.river(wx, wy);
      if (r) {
        const half = r.w / 2;
        const valley = r.w * 7 + 0.6;
        if (r.dist < valley) {
          const vd = Math.min(0.09, base * 0.12) * Math.pow(1 - r.dist / valley, 2);
          h -= vd;
        }
        if (r.dist < half * 1.25) {
          const bank = h;
          const q = Math.min(1, r.dist / (half * 1.25));
          h = Math.max(base * 0.05, bank - r.d * (1 - q * q));
          if (r.dist < half) water = bank - r.d * 0.25;
        }
      }
      // lakes: the water of a lake cell also floods low ground just across its edge, so shores follow the land, not the grid
      const cx = Math.floor(mx), cy = Math.floor(my);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = cy + dy;
        if (yy < 0 || yy >= H) continue;
        const c2 = yy * W + ((((cx + dx) % W) + W) % W);
        if (!this.d.lake[c2]) continue;
        const ex = Math.max(0, Math.abs(mx - (cx + dx + 0.5)) - 0.5), ey = Math.max(0, Math.abs(my - (yy + 0.5)) - 0.5);
        if (Math.hypot(ex, ey) > 0.45) continue;
        const lvl = this.d.lakeLevel[c2];
        if (h < lvl + 0.001) water = Math.max(isNaN(water) ? -1e9 : water, lvl);
      }
      void cell;
      h = Math.max(h, 0.0005);
    }
    out.h = h;
    out.w = water;
    out.base = base;
  }

  chunk(face: number, level: number, i: number, j: number, key: string): ChunkResult {
    const n = 1 << level;
    const SEG = segFor(level);
    const s0 = -1 + (2 * i) / n, t0 = -1 + (2 * j) / n;
    const ds = 2 / n / SEG;
    const sizeKm = ((Math.PI / 2) * R_KM) / n;
    const spacing = sizeKm / SEG;
    const maxFreq = (2 * Math.PI * R_KM) / Math.max(0.008, spacing * 2.5);
    const cdir = faceDir(face, s0 + ds * SEG * 0.5, t0 + ds * SEG * 0.5);
    const center: [number, number, number] = [cdir[0] * R_KM, cdir[1] * R_KM, cdir[2] * R_KM];
    // samples with a one-vertex border for seamless normals
    const G = SEG + 3;
    const P = new Float64Array(G * G * 3);
    const Hh = new Float32Array(G * G);
    const Wt = new Float32Array(G * G);
    const D = new Float32Array(G * G * 3);
    const o = { h: 0, w: 0, base: 0 };
    const dd: [number, number, number] = [0, 0, 0];
    let minH = Infinity, maxH = -Infinity;
    for (let b = 0; b < G; b++) for (let a = 0; a < G; a++) {
      faceDir(face, s0 + (a - 1) * ds, t0 + (b - 1) * ds, dd);
      this.sample(dd[0], dd[1], dd[2], maxFreq, o);
      const k = b * G + a;
      const r = R_KM + o.h;
      P[k * 3] = dd[0] * r; P[k * 3 + 1] = dd[1] * r; P[k * 3 + 2] = dd[2] * r;
      D[k * 3] = dd[0]; D[k * 3 + 1] = dd[1]; D[k * 3 + 2] = dd[2];
      Hh[k] = o.h;
      Wt[k] = o.w;
      if (a >= 1 && b >= 1 && a <= SEG + 1 && b <= SEG + 1) { minH = Math.min(minH, o.h, isNaN(o.w) ? o.h : o.w); maxH = Math.max(maxH, o.h); }
    }
    const V = SEG + 1;
    const skirt = 4 * V;
    const nv = V * V + skirt;
    const pos = new Float32Array(nv * 3);
    const normal = new Float32Array(nv * 3);
    const dir = new Float32Array(nv * 3);
    const elev = new Float32Array(nv);
    const heights = new Float32Array(V * V);
    for (let b = 0; b < V; b++) for (let a = 0; a < V; a++) {
      const k = (b + 1) * G + (a + 1);
      const v = b * V + a;
      pos[v * 3] = P[k * 3] - center[0]; pos[v * 3 + 1] = P[k * 3 + 1] - center[1]; pos[v * 3 + 2] = P[k * 3 + 2] - center[2];
      dir[v * 3] = D[k * 3]; dir[v * 3 + 1] = D[k * 3 + 1]; dir[v * 3 + 2] = D[k * 3 + 2];
      elev[v] = Hh[k];
      heights[v] = Hh[k];
      // normal from the cross product of central differences
      const l = k - 1, r = k + 1, dn = k - G, up = k + G;
      const ux = P[r * 3] - P[l * 3], uy = P[r * 3 + 1] - P[l * 3 + 1], uz = P[r * 3 + 2] - P[l * 3 + 2];
      const vx = P[up * 3] - P[dn * 3], vy = P[up * 3 + 1] - P[dn * 3 + 1], vz = P[up * 3 + 2] - P[dn * 3 + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const L = Math.hypot(nx, ny, nz) || 1;
      nx /= L; ny /= L; nz /= L;
      normal[v * 3] = nx; normal[v * 3 + 1] = ny; normal[v * 3 + 2] = nz;
    }
    // skirts: a curtain hanging below each edge hides cracks between neighbours of different detail
    const drop = Math.max(0.004, sizeKm * 0.02);
    const edge = (k: number) => {
      const out: number[] = [];
      for (let q = 0; q < V; q++) out.push(k === 0 ? q : k === 1 ? q * V + SEG : k === 2 ? SEG * V + (SEG - q) : (SEG - q) * V);
      return out;
    };
    let sv = V * V;
    const index: number[] = [];
    for (let b = 0; b < SEG; b++) for (let a = 0; a < SEG; a++) {
      const v0 = b * V + a, v1 = v0 + 1, v2 = v0 + V, v3 = v2 + 1;
      index.push(v0, v1, v2, v1, v3, v2);
    }
    for (let k = 0; k < 4; k++) {
      const e = edge(k);
      const start = sv;
      for (const v of e) {
        const dx = dir[v * 3], dy = dir[v * 3 + 1], dz = dir[v * 3 + 2];
        pos[sv * 3] = pos[v * 3] - dx * drop; pos[sv * 3 + 1] = pos[v * 3 + 1] - dy * drop; pos[sv * 3 + 2] = pos[v * 3 + 2] - dz * drop;
        normal.set(normal.subarray(v * 3, v * 3 + 3), sv * 3);
        dir.set(dir.subarray(v * 3, v * 3 + 3), sv * 3);
        elev[sv] = elev[v];
        sv++;
      }
      for (let q = 0; q < V - 1; q++) {
        const a0 = e[q], a1 = e[q + 1], b0 = start + q, b1 = start + q + 1;
        index.push(a0, b0, a1, a1, b0, b1);
      }
    }
    const res: ChunkResult = { key, center, pos, normal, dir, elev, index: Uint32Array.from(index), heights, minH, maxH, seg: SEG };
    // ---- water surface (sea, lakes, rivers)
    let anyWater = false;
    for (let b = 1; b <= SEG + 1 && !anyWater; b++) for (let a = 1; a <= SEG + 1; a++) if (!isNaN(Wt[b * G + a])) { anyWater = true; break; }
    if (anyWater) {
      const wpos = new Float32Array(V * V * 3), wdepth = new Float32Array(V * V), wdir = new Float32Array(V * V * 3);
      for (let b = 0; b < V; b++) for (let a = 0; a < V; a++) {
        const k = (b + 1) * G + (a + 1);
        const v = b * V + a;
        let wl = Wt[k];
        if (isNaN(wl)) {
          // dry vertex: borrow a neighbour's water level so the shoreline falls between vertices
          let best = NaN;
          for (const q of [k - 1, k + 1, k - G, k + G]) if (!isNaN(Wt[q])) best = isNaN(best) ? Wt[q] : Math.max(best, Wt[q]);
          wl = isNaN(best) ? Hh[k] - 0.003 : best;
        }
        const r = R_KM + wl;
        wpos[v * 3] = D[k * 3] * r - center[0]; wpos[v * 3 + 1] = D[k * 3 + 1] * r - center[1]; wpos[v * 3 + 2] = D[k * 3 + 2] * r - center[2];
        wdir[v * 3] = D[k * 3]; wdir[v * 3 + 1] = D[k * 3 + 1]; wdir[v * 3 + 2] = D[k * 3 + 2];
        wdepth[v] = wl - Hh[k];
      }
      const widx: number[] = [];
      for (let b = 0; b < SEG; b++) for (let a = 0; a < SEG; a++) {
        const v0 = b * V + a, v1 = v0 + 1, v2 = v0 + V, v3 = v2 + 1;
        if (wdepth[v0] > 0 || wdepth[v1] > 0 || wdepth[v2] > 0 || wdepth[v3] > 0) widx.push(v0, v1, v2, v1, v3, v2);
      }
      if (widx.length) res.water = { pos: wpos, depth: wdepth, dir: wdir, index: Uint32Array.from(widx) };
    }
    // ---- trees and boulders, on a fixed global lattice so they never move when detail changes
    if (level >= TREE_LEVEL) res.trees = this.scatter(face, level, i, j, center, heights, Wt, G, SEG);
    return res;
  }

  private scatter(face: number, level: number, i: number, j: number, center: [number, number, number], heights: Float32Array, Wt: Float32Array, G: number, SEG: number): Float32Array {
    const d = this.d;
    const n = 1 << level;
    const per = TREE_GRID / n; // lattice points per chunk edge
    const g0 = i * per, h0 = j * per;
    const out: number[] = [];
    const dd: [number, number, number] = [0, 0, 0];
    const V = SEG + 1;
    for (let gb = 0; gb < per; gb++) for (let ga = 0; ga < per; ga++) {
      const gi = g0 + ga, gj = h0 + gb;
      const r0 = hash(gi, gj, face * 7 + 1);
      if (r0 > 0.62) continue; // the lattice is thinned at random so no grid shows
      const fa = (ga + 0.15 + hash(gi, gj, 11) * 0.7) / per, fb = (gb + 0.15 + hash(gi, gj, 23) * 0.7) / per;
      // height on the drawn triangles of this chunk
      const ax = fa * SEG, bx = fb * SEG;
      const a0 = Math.min(SEG - 1, Math.floor(ax)), b0 = Math.min(SEG - 1, Math.floor(bx));
      const u = ax - a0, v = bx - b0;
      const hA = heights[b0 * V + a0], hB = heights[b0 * V + a0 + 1], hC = heights[(b0 + 1) * V + a0], hD = heights[(b0 + 1) * V + a0 + 1];
      const hh = u + v <= 1 ? hA + u * (hB - hA) + v * (hC - hA) : hD + (1 - u) * (hC - hD) + (1 - v) * (hB - hD);
      const wk = (b0 + 1 + Math.round(v)) * G + (a0 + 1 + Math.round(u));
      if (!isNaN(Wt[wk]) && Wt[wk] > hh - 0.001) continue; // in water
      const slope = Math.max(Math.abs(hB - hA), Math.abs(hC - hA)) / (((Math.PI / 2) * R_KM) / n / SEG);
      faceDir(face, -1 + (2 * (i + fa)) / n, -1 + (2 * (j + fb)) / n, dd);
      const [mx, my] = dirToMap(dd[0], dd[1], dd[2]);
      const cell = Math.floor(Math.max(0, Math.min(H - 1, my))) * W + (((Math.floor(mx) % W) + W) % W);
      if (d.ocean[cell] && hh < 0.003) continue;
      const biome = d.biome[cell] as Biome;
      // the local climate at this height decides the tree line
      const T = d.tempMean[cell] - 6.5 * (hh - Math.max(0, d.elev[cell]));
      const tree = TREE_DENSITY[biome] ?? 0;
      const rock = slope > 0.7 || biome === Biome.Mountain || biome === Biome.SnowPeak || biome === Biome.Volcanic ? 0.08 + Math.min(0.3, slope * 0.15) : biome === Biome.Tundra || biome === Biome.Desert ? 0.03 : 0.006;
      const r1 = hash(gi, gj, 37);
      const dens = tree * (0.25 + d.baseVeg[cell]) * (slope > 1.2 ? 0.2 : 1) * (T < -3 ? 0 : T < 1 ? (T + 3) / 4 : 1) * (hh < 0.004 ? 0.2 : 1);
      let type = -1;
      if (r1 < dens) {
        type = biome === Biome.Taiga || (biome === Biome.Tundra) || T < 5 ? 0 : biome === Biome.Rainforest ? (hash(gi, gj, 41) < 0.12 ? 2 : 1) : biome === Biome.Savanna || biome === Biome.Desert ? (hash(gi, gj, 43) < 0.35 ? 3 : 1) : biome === Biome.Swamp ? 1 : hash(gi, gj, 47) < (T < 10 ? 0.55 : 0.18) ? 0 : 1;
      } else if (r1 < dens + rock) type = 4;
      else if (r1 < dens + rock + (biome === Biome.Grassland || biome === Biome.Savanna || biome === Biome.Tundra ? 0.05 : 0.02)) type = 3;
      if (type < 0) continue;
      const big = hash(gi, gj, 53);
      const height = type === 4 ? 0.0015 + big * big * 0.006 : type === 3 ? 0.0012 + big * 0.0025 : (TREE_HEIGHT[biome] ?? 0.014) * (0.55 + big * 0.7) * (T < 3 ? 0.6 : 1);
      const crown = type === 0 ? height * 0.22 : type === 2 ? height * 0.28 : type === 3 ? height * 0.9 : type === 4 ? height * 1.2 : height * 0.38;
      const r = R_KM + hh;
      out.push(dd[0] * r - center[0], dd[1] * r - center[1], dd[2] * r - center[2], height, crown, type, hash(gi, gj, 59), cell);
    }
    return Float32Array.from(out);
  }
}

const TREE_DENSITY: Partial<Record<Biome, number>> = {
  [Biome.Rainforest]: 0.95, [Biome.TemperateForest]: 0.8, [Biome.Taiga]: 0.7, [Biome.Swamp]: 0.45, [Biome.Savanna]: 0.12, [Biome.Grassland]: 0.05,
  [Biome.Tundra]: 0.02, [Biome.Mountain]: 0.12, [Biome.Desert]: 0.004, [Biome.Volcanic]: 0.02,
};
const TREE_HEIGHT: Partial<Record<Biome, number>> = {
  [Biome.Rainforest]: 0.035, [Biome.TemperateForest]: 0.024, [Biome.Taiga]: 0.02, [Biome.Swamp]: 0.016, [Biome.Savanna]: 0.009, [Biome.Grassland]: 0.008,
  [Biome.Tundra]: 0.004, [Biome.Mountain]: 0.014, [Biome.Desert]: 0.006,
};
