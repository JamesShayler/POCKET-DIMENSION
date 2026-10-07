import { Noise3 } from './noise';
import { Rng, clamp, smoothstep } from './rng';
import { W, H, N, NBR8, cellLat, cellLon, dirFromLonLat, idx, lonOfX, latOfY } from './grid';
import { seasonPhase } from './time';

export enum Biome {
  Ocean, DeepOcean, SeaIce, Ice, Tundra, Taiga, TemperateForest, Grassland, Savanna,
  Desert, Rainforest, Swamp, Mountain, SnowPeak, Volcanic, Lake,
}
export const BIOME_NAMES = [
  'Ocean', 'Deep ocean', 'Sea ice', 'Ice sheet', 'Tundra', 'Taiga', 'Temperate forest', 'Grassland', 'Savanna',
  'Desert', 'Rainforest', 'Swamp', 'Mountains', 'Snow peaks', 'Volcanic', 'Lake',
];

export { TerrainSampler } from './terrain';
import { TerrainSampler } from './terrain';

const LAT_T = [[0, 27], [15, 25], [30, 20], [45, 10], [60, 1], [75, -12], [90, -23]];
function latTemp(a: number): number {
  for (let k = 1; k < LAT_T.length; k++) {
    if (a <= LAT_T[k][0]) {
      const t = (a - LAT_T[k - 1][0]) / (LAT_T[k][0] - LAT_T[k - 1][0]);
      return LAT_T[k - 1][1] + t * (LAT_T[k][1] - LAT_T[k - 1][1]);
    }
  }
  return -23;
}

export interface ResourceMaps {
  stone: Uint8Array; clay: Uint8Array; coal: Uint8Array; iron: Uint8Array; copper: Uint8Array; gold: Uint8Array;
}

/** Everything about the planet that is a deterministic function of the seed (never changes during a run). */
export class Planet {
  readonly seed: number;
  readonly terrain: TerrainSampler;
  elev = new Float32Array(N); // km relative to sea level
  ocean = new Uint8Array(N);
  lake = new Uint8Array(N);
  tempMean = new Float32Array(N); // deg C
  tempAmp = new Float32Array(N); // seasonal half-range
  rain = new Float32Array(N); // normalised annual rainfall (~1 = wet)
  humidity = new Float32Array(N);
  windU = new Float32Array(N); // east-west wind component by latitude (-1..1)
  drain = new Int32Array(N).fill(-1);
  flow = new Float32Array(N);
  /** land cells ordered from the sea upstream (iterate backwards to route water downhill) */
  flowOrder = new Int32Array(0);
  river = new Uint8Array(N);
  freshDist: Uint8Array = new Uint8Array(N); // cells to nearest river/lake
  coastDist: Uint8Array = new Uint8Array(N); // cells to nearest ocean
  fertility = new Float32Array(N);
  biome = new Uint8Array(N);
  volcanic = new Uint8Array(N);
  /** water surface of lakes (km), -1e9 where there is no lake */
  lakeLevel = new Float32Array(N).fill(-1e9);
  /** closeness to a plate boundary (0 far .. 1 on it) and its convergence (+ collision, - spreading) */
  plateNear = new Float32Array(N);
  plateConv = new Float32Array(N);
  cave = new Uint8Array(N);
  res: ResourceMaps = {
    stone: new Uint8Array(N), clay: new Uint8Array(N), coal: new Uint8Array(N),
    iron: new Uint8Array(N), copper: new Uint8Array(N), gold: new Uint8Array(N),
  };
  /** Per-cell base vegetation capacity (0..1), before seasonal/climate modulation. */
  baseVeg = new Float32Array(N);
  landCells = 0;

  constructor(seed: number, data?: { seaLevel: number; landCells: number; arrays: Record<string, ArrayBufferView> }) {
    this.seed = seed;
    this.terrain = new TerrainSampler(seed);
    if (data) {
      // rebuilt from arrays generated elsewhere (the simulation worker): identical, without regenerating
      this.terrain.seaLevel = data.seaLevel;
      this.landCells = data.landCells;
      const self = this as unknown as Record<string, unknown>;
      for (const [k, v] of Object.entries(data.arrays)) {
        if (k.startsWith('res.')) (this.res as unknown as Record<string, unknown>)[k.slice(4)] = v;
        else self[k] = v;
      }
      return;
    }
    this.generateTerrain();
    this.generateClimate();
    this.generateHydrology();
    this.generateBiomesAndResources();
  }

  /** Everything needed to rebuild this planet with `new Planet(seed, data)`. */
  toData(): { seaLevel: number; landCells: number; arrays: Record<string, ArrayBufferView> } {
    const arrays: Record<string, ArrayBufferView> = {};
    const keys = ['elev', 'ocean', 'lake', 'tempMean', 'tempAmp', 'rain', 'humidity', 'windU', 'drain', 'flow', 'flowOrder', 'river', 'freshDist', 'coastDist',
      'fertility', 'biome', 'volcanic', 'lakeLevel', 'plateNear', 'plateConv', 'cave', 'baseVeg'] as const;
    for (const k of keys) arrays[k] = (this[k] as ArrayBufferView);
    for (const [k, v] of Object.entries(this.res)) arrays['res.' + k] = v as ArrayBufferView;
    return { seaLevel: this.terrain.seaLevel, landCells: this.landCells, arrays };
  }

  /** Exact base elevation (km) at a continuous map position — the same function the renderer draws. */
  elevAt(x: number, y: number): number {
    const lon = lonOfX(((x % W) + W) % W);
    const lat = latOfY(Math.max(0.001, Math.min(H - 0.001, y)));
    const c = Math.cos(lat);
    return this.terrain.elevKm(c * Math.cos(lon), Math.sin(lat), c * Math.sin(lon));
  }
  /** Dry land (not sea, not under a lake surface) at a continuous position. */
  isLand(x: number, y: number, minKm = 0.002): boolean {
    const e = this.elevAt(x, y);
    if (e <= minKm) return false;
    const i = idx(((Math.floor(x) % W) + W) % W, Math.max(0, Math.min(H - 1, Math.floor(y))));
    return !(this.lake[i] && e < this.lakeLevel[i]);
  }
  /** Find a dry point near (x, y) within `radius` cells, or null. Deterministic in its inputs. */
  landNear(x: number, y: number, radius = 0.45): { x: number; y: number } | null {
    if (this.isLand(x, y)) return { x, y };
    for (let r = 1; r <= 6; r++) {
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2 + r;
        const px = x + Math.cos(a) * radius * (r / 6), py = y + Math.sin(a) * radius * (r / 6);
        if (py > 0.01 && py < H - 0.01 && this.isLand(px, py)) return { x: ((px % W) + W) % W, y: py };
      }
    }
    return null;
  }

  tempAt(i: number, day: number): number {
    const y = Math.floor(i / W);
    const sign = cellLat(y) >= 0 ? 1 : -1;
    const lat = Math.abs(cellLat(y));
    return this.tempMean[i] + this.tempAmp[i] * seasonPhase(day) * sign * Math.min(1, 0.25 + lat * 1.6);
  }

  private generateTerrain() {
    const t = this.terrain;
    const raws = new Float32Array(N);
    const d: [number, number, number] = [0, 0, 0];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        dirFromLonLat(cellLon(x), cellLat(y), d);
        const ii = idx(x, y);
        raws[ii] = t.raw(d[0], d[1], d[2]);
        const tc = t.tectonics(d[0], d[1], d[2]);
        this.plateNear[ii] = Math.exp(-Math.pow(tc.b / 0.06, 2));
        this.plateConv[ii] = tc.conv;
      }
    }
    const sorted = Float32Array.from(raws).sort();
    t.seaLevel = sorted[Math.floor(N * 0.64)]; // ~36% land
    for (let i = 0; i < N; i++) {
      const e = raws[i] - t.seaLevel;
      this.elev[i] = e >= 0 ? e * 6.4 : e * 7.5;
      this.ocean[i] = this.elev[i] < 0 ? 1 : 0;
      if (!this.ocean[i]) this.landCells++;
    }
  }

  private generateClimate() {
    const noise = new Noise3(Rng.derive(this.seed, 'climate').state);
    const d: [number, number, number] = [0, 0, 0];
    for (let y = 0; y < H; y++) {
      const lat = cellLat(y);
      const a = Math.abs(lat) * (180 / Math.PI);
      const u = a < 60 ? -Math.cos((2 * Math.PI * a) / 60) : -1;
      for (let x = 0; x < W; x++) {
        const i = idx(x, y);
        dirFromLonLat(cellLon(x), lat, d);
        this.windU[i] = u;
        const s = Math.abs(Math.sin(lat));
        const land = !this.ocean[i];
        let T = latTemp(Math.abs(lat) * (180 / Math.PI)) + noise.fbm(d[0] * 2, d[1] * 2, d[2] * 2, 3) * 4;
        if (land) T -= 6.5 * Math.max(0, this.elev[i]);
        this.tempMean[i] = T;
        this.tempAmp[i] = 2 + 20 * s * (land ? 1 : 0.35);
      }
    }
    // Moisture advection along prevailing wind: oceans charge the air, land (esp. uphill) rains it out.
    const rain = new Float32Array(N);
    const hum = new Float32Array(N);
    for (let y = 0; y < H; y++) {
      const dir = this.windU[idx(0, y)] >= 0 ? 1 : -1;
      const a = Math.abs(cellLat(y)) * (180 / Math.PI);
      let m = 0;
      let prev = 0;
      for (let step = 0; step < 2 * W; step++) {
        const x = dir > 0 ? step % W : W - 1 - (step % W);
        const i = idx(x, y);
        const e = Math.max(0, this.elev[i]);
        if (this.ocean[i]) {
          const warm = clamp((this.tempMean[i] + 5) / 35);
          m = Math.min(1, m + 0.06 + 0.1 * warm);
        } else {
          const up = Math.max(0, e - prev);
          const p = m * (0.032 + 0.9 * up) ;
          m -= Math.min(m, p);
          if (step >= W) rain[i] = p;
        }
        if (step >= W) hum[i] = m;
        prev = e;
      }
      // latitude bands: wet tropics, dry subtropics, moderate mid-latitudes, dry poles
      for (let x = 0; x < W; x++) {
        const i = idx(x, y);
        const itcz = 0.35 * Math.exp(-Math.pow(a / 9, 2));
        const sub = 1 - 0.55 * Math.exp(-Math.pow((a - 27) / 9, 2));
        const polar = 1 - 0.6 * smoothstep(55, 90, a);
        rain[i] = rain[i] * 24 * sub * polar + (this.ocean[i] ? 0 : itcz * (0.4 + hum[i]));
      }
    }
    // blur away the row-sweep streaks
    const tmp = new Float32Array(N);
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < N; i++) {
        let s = rain[i] * 2;
        let w = 2;
        for (let k = 0; k < 8; k++) {
          const n = NBR8[i * 8 + k];
          if (n >= 0) { s += rain[n]; w += 1; }
        }
        tmp[i] = s / w;
      }
      rain.set(tmp);
    }
    let maxLand = 0;
    const lr: number[] = [];
    for (let i = 0; i < N; i++) if (!this.ocean[i]) lr.push(rain[i]);
    lr.sort((a, b) => a - b);
    maxLand = lr[Math.floor(lr.length * 0.92)] || 1;
    for (let i = 0; i < N; i++) {
      this.rain[i] = clamp(rain[i] / maxLand, 0, 1.6);
      this.humidity[i] = clamp(hum[i] * 0.7 + this.rain[i] * 0.3);
    }
  }

  /** Priority-flood so every land cell drains to the sea; depressions become lakes. */
  private generateHydrology() {
    const filled = new Float32Array(N);
    const visited = new Uint8Array(N);
    const order: number[] = [];
    // min-heap on filled elevation
    const heap: number[] = [];
    const push = (i: number) => {
      heap.push(i);
      let c = heap.length - 1;
      while (c > 0) {
        const p = (c - 1) >> 1;
        if (filled[heap[p]] <= filled[heap[c]]) break;
        [heap[p], heap[c]] = [heap[c], heap[p]];
        c = p;
      }
    };
    const pop = () => {
      const top = heap[0];
      const last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        let c = 0;
        for (;;) {
          const l = 2 * c + 1;
          const r = l + 1;
          let m = c;
          if (l < heap.length && filled[heap[l]] < filled[heap[m]]) m = l;
          if (r < heap.length && filled[heap[r]] < filled[heap[m]]) m = r;
          if (m === c) break;
          [heap[m], heap[c]] = [heap[c], heap[m]];
          c = m;
        }
      }
      return top;
    };
    for (let i = 0; i < N; i++) {
      if (this.ocean[i]) {
        visited[i] = 1;
        filled[i] = this.elev[i];
      }
    }
    for (let i = 0; i < N; i++) {
      if (!this.ocean[i]) continue;
      for (let k = 0; k < 8; k++) {
        const n = NBR8[i * 8 + k];
        if (n >= 0 && !this.ocean[n]) { push(i); break; }
      }
    }
    while (heap.length) {
      const c = pop();
      for (let k = 0; k < 8; k++) {
        const n = NBR8[c * 8 + k];
        if (n < 0 || visited[n]) continue;
        visited[n] = 1;
        filled[n] = Math.max(this.elev[n], filled[c]);
        this.drain[n] = c;
        order.push(n);
        push(n);
      }
    }
    const acc = new Float32Array(N);
    for (let i = 0; i < N; i++) if (!this.ocean[i]) acc[i] = 0.2 + this.rain[i];
    for (let k = order.length - 1; k >= 0; k--) {
      const i = order[k];
      const d = this.drain[i];
      if (d >= 0 && !this.ocean[d]) acc[d] += acc[i];
      else if (d >= 0) acc[d] += 0; // reaches the sea
    }
    this.flow.set(acc);
    this.flowOrder = Int32Array.from(order);
    const land = Array.from({ length: N }, (_, i) => i).filter((i) => !this.ocean[i]);
    const sortedAcc = land.map((i) => acc[i]).sort((a, b) => a - b);
    const thr = sortedAcc[Math.floor(sortedAcc.length * 0.93)] || 1;
    for (const i of land) {
      if (acc[i] >= thr && this.tempMean[i] > -8) this.river[i] = 1;
      if (filled[i] - this.elev[i] > 0.04 && acc[i] > thr * 0.25) { this.lake[i] = 1; this.lakeLevel[i] = filled[i]; }
    }
    // distances
    const bfs = (src: (i: number) => boolean, passOcean: boolean): Uint8Array => {
      const dist = new Uint8Array(N).fill(255);
      let q: number[] = [];
      for (let i = 0; i < N; i++) if (src(i)) { dist[i] = 0; q.push(i); }
      let qi = 0;
      while (qi < q.length) {
        const c = q[qi++];
        if (dist[c] >= 60) continue;
        for (let k = 0; k < 8; k++) {
          const n = NBR8[c * 8 + k];
          if (n < 0 || dist[n] !== 255) continue;
          if (!passOcean && this.ocean[n]) continue;
          dist[n] = dist[c] + 1;
          q.push(n);
        }
      }
      return dist;
    };
    this.freshDist = bfs((i) => !this.ocean[i] && (this.river[i] === 1 || this.lake[i] === 1), false);
    this.coastDist = bfs((i) => this.ocean[i] === 1, true);
  }

  private generateBiomesAndResources() {
    const rng = Rng.derive(this.seed, 'resources');
    const nz = new Noise3(rng.state);
    const d: [number, number, number] = [0, 0, 0];
    // volcanic hotspots: top ~1.4% of land by a ridged noise
    const volc = new Float32Array(N);
    const landIdx: number[] = [];
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = idx(x, y);
        dirFromLonLat(cellLon(x), cellLat(y), d);
        // volcanoes stand on arcs behind colliding plate boundaries and over hotspots
        let hot = 0;
        for (const h of this.terrain.hotspots) { const dd = 1 - (h.c[0] * d[0] + h.c[1] * d[1] + h.c[2] * d[2]); hot = Math.max(hot, Math.exp(-dd / (h.r * h.r * 0.6))); }
        volc[i] = Math.max(0, this.plateConv[i]) * this.plateNear[i] * 1.2 + hot * 1.5 + 0.15 * nz.noise(d[0] * 9, d[1] * 9, d[2] * 9);
        if (!this.ocean[i]) landIdx.push(i);
      }
    const vs = landIdx.map((i) => volc[i]).sort((a, b) => a - b);
    const vthr = vs[Math.floor(vs.length * 0.992)];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = idx(x, y);
        dirFromLonLat(cellLon(x), cellLat(y), d);
        const e = this.elev[i];
        if (this.ocean[i]) {
          this.biome[i] = e < -2.2 ? Biome.DeepOcean : Biome.Ocean;
          if (this.tempMean[i] < -13) this.biome[i] = Biome.SeaIce;
          continue;
        }
        const T = this.tempMean[i];
        const r = this.rain[i];
        if (volc[i] >= vthr) this.volcanic[i] = 1;
        const karst = nz.fbm(d[0] * 7 + 4, d[1] * 7, d[2] * 7 - 4, 3);
        if (e > 0.3 && karst > 0.22 && !this.lake[i]) this.cave[i] = 1;
        let b: Biome;
        const flat = this.flow[i];
        if (this.lake[i]) b = Biome.Lake;
        else if (this.volcanic[i] && e > 0.6) b = Biome.Volcanic;
        else if (e > 4.6) b = Biome.SnowPeak;
        else if (e > 3.0) b = T < -6 ? Biome.SnowPeak : Biome.Mountain;
        else if (T < -9) b = Biome.Ice;
        else if (T < 0) b = Biome.Tundra;
        else if (T < 7) b = r > 0.28 ? Biome.Taiga : Biome.Tundra;
        else if (T < 19) {
          if (r < 0.1) b = Biome.Desert;
          else if (r < 0.4) b = Biome.Grassland;
          else if (r > 0.85 && e < 0.5 && this.freshDist[i] <= 2) b = Biome.Swamp;
          else b = Biome.TemperateForest;
        } else {
          if (r < 0.1) b = Biome.Desert;
          else if (r < 0.5) b = Biome.Savanna;
          else if (r > 0.75 && e < 0.45 && this.freshDist[i] <= 2 && flat > 3) b = Biome.Swamp;
          else b = Biome.Rainforest;
        }
        this.biome[i] = b;
        // base vegetation capacity & fertility
        const rv = clamp(r / 0.7);
        const tv = clamp((T + 2) / 12) * clamp((38 - T) / 12);
        let veg = rv * tv * 0.9;
        if (b === Biome.Mountain) veg *= 0.3;
        if (b === Biome.SnowPeak || b === Biome.Ice || b === Biome.Volcanic || b === Biome.Lake) veg = 0;
        if (b === Biome.Desert) veg = Math.min(veg, 0.06);
        this.baseVeg[i] = clamp(veg + (this.river[i] ? 0.15 : 0) * tv);
        let f = 0.15 + 0.5 * rv * tv + (this.freshDist[i] <= 1 ? 0.2 : 0) + (this.volcanic[i] ? 0.15 : 0) - Math.max(0, e - 1.5) * 0.2;
        if (b === Biome.Desert || b === Biome.Ice || b === Biome.SnowPeak) f *= 0.25;
        this.fertility[i] = clamp(f);
        // resources (spatially clustered via noise)
        const hill = clamp(e / 2.5);
        const r8 = (v: number) => Math.round(clamp(v) * 255);
        this.res.stone[i] = r8(0.25 + hill * 0.7 + nz.noise(d[0] * 5, d[1] * 5, d[2] * 5) * 0.2);
        this.res.clay[i] = r8((this.freshDist[i] <= 2 ? 0.5 : 0.1) * (1 - hill) + smoothstep(0.1, 0.5, nz.noise(d[0] * 6 + 1, d[1] * 6, d[2] * 6)) * 0.5);
        this.res.coal[i] = r8(smoothstep(0.18, 0.5, nz.fbm(d[0] * 4 + 7, d[1] * 4, d[2] * 4 + 3, 2)) * (e < 2 ? 1 : 0.3));
        this.res.iron[i] = r8(smoothstep(0.12, 0.4, nz.fbm(d[0] * 5 - 9, d[1] * 5 + 2, d[2] * 5, 2)) * smoothstep(0.2, 1.2, e));
        this.res.copper[i] = r8(smoothstep(0.2, 0.5, nz.fbm(d[0] * 5 + 13, d[1] * 5 - 3, d[2] * 5, 2)) * smoothstep(0.2, 1.4, e));
        this.res.gold[i] = r8(smoothstep(0.38, 0.6, nz.fbm(d[0] * 6 - 5, d[1] * 6 + 8, d[2] * 6, 2)) * smoothstep(0.5, 1.8, e));
      }
    }
  }
}
