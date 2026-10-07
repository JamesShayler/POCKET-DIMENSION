import * as THREE from 'three';
import type { SimClient } from '../client';
import { Biome } from '../sim/planet';
import { H, N, W, cellLat } from '../sim/grid';
import { seasonPhase } from '../sim/time';
import { WH, WW } from '../sim/weather';

/**
 * The simulation's state as textures the shaders can read: land albedo (biome × vegetation × season × farming × fire),
 * snow and fire, climate (temperature and elevation for the local snow line), political colours, and the weather and
 * ocean fields.
 */
type RGB = [number, number, number];
const hex = (h: number): RGB => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

// [barren, lush] ground colour as seen from above (canopy where there is forest)
const LAND: Record<number, [RGB, RGB]> = {
  [Biome.Ice]: [hex(0xe8eff5), hex(0xe8eff5)],
  [Biome.Tundra]: [hex(0x7f7a68), hex(0x6a7a55)],
  [Biome.Taiga]: [hex(0x4f5a43), hex(0x24402b)],
  [Biome.TemperateForest]: [hex(0x5f6e40), hex(0x29552a)],
  [Biome.Grassland]: [hex(0x9c9150), hex(0x5f8a36)],
  [Biome.Savanna]: [hex(0xab9150), hex(0x86903c)],
  [Biome.Desert]: [hex(0xcfac74), hex(0xc0a05c)],
  [Biome.Rainforest]: [hex(0x2b5f2f), hex(0x123f22)],
  [Biome.Swamp]: [hex(0x4a634a), hex(0x2f4d37)],
  [Biome.Mountain]: [hex(0x77705f), hex(0x5c6450)],
  [Biome.SnowPeak]: [hex(0x8a8478), hex(0x7d7d6c)],
  [Biome.Volcanic]: [hex(0x36302e), hex(0x45392f)],
  [Biome.Lake]: [hex(0x5f6e40), hex(0x3f6a35)],
  [Biome.Ocean]: [hex(0x8a8a70), hex(0x8a8a70)],
  [Biome.DeepOcean]: [hex(0x8a8a70), hex(0x8a8a70)],
  [Biome.SeaIce]: [hex(0xdde8ef), hex(0xdde8ef)],
};
const FIELD = hex(0xb8a253);
const AUTUMN = hex(0x9a6a2a);
const BURNT = hex(0x2a2522);

function tex(w: number, h: number, data: Uint8Array): THREE.DataTexture {
  const t = new THREE.DataTexture(data as unknown as BufferSource, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

export class Fields {
  land = tex(W, H, new Uint8Array(N * 4));
  aux = tex(W, H, new Uint8Array(N * 4));
  climate = tex(W, H, new Uint8Array(N * 4));
  politics = tex(W, H, new Uint8Array(N * 4));
  weather = tex(WW, WH, new Uint8Array(WW * WH * 4));
  ocean = tex(WW, WH, new Uint8Array(WW * WH * 4));
  politicsOn = false;
  private lastEnv = -1;
  private lastWx = -1;
  private lastSet = -1;
  private lastDay = -1e9;

  constructor(private c: SimClient) {}

  update(day: number) {
    const c = this.c;
    if (c.versions.env !== this.lastEnv || Math.abs(day - this.lastDay) > 6) {
      this.lastEnv = c.versions.env;
      this.lastDay = day;
      this.landColors(day);
    }
    if (c.versions.weather !== this.lastWx) {
      this.lastWx = c.versions.weather;
      this.weatherFields();
    }
    if (c.versions.settlements !== this.lastSet) {
      this.lastSet = c.versions.settlements;
      this.politicalMap();
    }
  }

  private landColors(day: number) {
    const c = this.c;
    const p = c.planet;
    const env = c.env;
    const land = this.land.image.data as Uint8Array;
    const aux = this.aux.image.data as Uint8Array;
    const clim = this.climate.image.data as Uint8Array;
    const phase = seasonPhase(day);
    for (let y = 0; y < H; y++) {
      const lat = cellLat(y);
      const sign = lat >= 0 ? 1 : -1;
      const latK = Math.min(1, 0.25 + Math.abs(lat) * 1.6);
      // autumn: phase falling through zero toward winter in this hemisphere
      const ph = phase * sign;
      const autumn = clamp01(1 - Math.abs(ph + 0.35) / 0.45) * clamp01((Math.abs(lat) - 0.35) / 0.3);
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const b = p.biome[i];
        const pair = LAND[b] ?? LAND[Biome.Grassland];
        const veg = env ? env.veg[i] / 255 : p.baseVeg[i];
        const lush = b === Biome.Desert || b === Biome.Ice ? 0 : clamp01(veg / Math.max(0.15, p.baseVeg[i] + 0.05));
        let col = mix(pair[0], pair[1], lush);
        if (b === Biome.TemperateForest || b === Biome.Grassland) col = mix(col, AUTUMN, autumn * 0.55 * lush);
        if (env && env.cultivated[i]) col = mix(col, FIELD, 0.35);
        const burn = env ? env.burn[i] : 0;
        const scar = burn >= 128 ? 1 : burn / 127;
        if (scar > 0.02) col = mix(col, BURNT, scar * 0.8);
        land[i * 4] = col[0] * 255; land[i * 4 + 1] = col[1] * 255; land[i * 4 + 2] = col[2] * 255; land[i * 4 + 3] = Math.round(lush * 255);
        // snow cover (from the simulated snowpack), active fire, soil wetness
        const snowMm = env ? (env.snow[i] / 4) ** 2 : 0;
        aux[i * 4] = Math.round(clamp01(snowMm / 60) * 255);
        aux[i * 4 + 1] = burn >= 128 ? 255 : 0;
        aux[i * 4 + 2] = env ? env.soil[i] : 128;
        aux[i * 4 + 3] = Math.round(scar * 255);
        const T = p.tempMean[i] + p.tempAmp[i] * phase * sign * latK;
        clim[i * 4] = Math.max(0, Math.min(255, Math.round((T + 50) * 2)));
        clim[i * 4 + 1] = Math.max(0, Math.min(255, Math.round(Math.max(0, p.elev[i]) * 30)));
        clim[i * 4 + 2] = p.ocean[i] ? 255 : 0;
        clim[i * 4 + 3] = p.lake[i] ? 255 : 0;
      }
    }
    this.land.needsUpdate = true;
    this.aux.needsUpdate = true;
    this.climate.needsUpdate = true;
  }

  private weatherFields() {
    const w = this.c.weather;
    if (!w) return;
    const d = this.weather.image.data as Uint8Array;
    const o = this.ocean.image.data as Uint8Array;
    for (let k = 0; k < WW * WH; k++) {
      d[k * 4] = w.cloud[k];
      d[k * 4 + 1] = w.precip[k];
      d[k * 4 + 2] = w.lightning[k];
      d[k * 4 + 3] = Math.max(0, Math.min(255, w.temp[k] + 128));
      o[k * 4] = w.cu[k] + 128;
      o[k * 4 + 1] = w.cv[k] + 128;
      o[k * 4 + 2] = Math.max(0, Math.min(255, w.sst[k] + 128));
      o[k * 4 + 3] = Math.max(0, Math.min(255, (w.u[k] + 128)));
    }
    this.weather.needsUpdate = true;
    this.ocean.needsUpdate = true;
  }

  /** Each people's lands, as soft coloured territories around their towns. */
  politicalMap() {
    const d = this.politics.image.data as Uint8Array;
    d.fill(0);
    if (!this.politicsOn) { this.politics.needsUpdate = true; return; }
    const p = this.c.planet;
    const best = new Float32Array(N);
    for (const s of this.c.settlements) {
      const r = 2.5 + Math.sqrt(s.pop) * 0.35 + (s.capital ? 1.5 : 0);
      const ri = Math.ceil(r);
      const col = hsl(s.civHue);
      for (let dy = -ri; dy <= ri; dy++) for (let dx = -ri; dx <= ri; dx++) {
        const y = Math.floor(s.y) + dy;
        if (y < 0 || y >= H) continue;
        const i = y * W + (((Math.floor(s.x) + dx) % W) + W) % W;
        if (p.ocean[i]) continue;
        const dd = Math.hypot(dx, dy);
        if (dd > r) continue;
        const a = 1 - dd / (r + 0.5);
        if (a > best[i]) {
          best[i] = a;
          d[i * 4] = col[0] * 255; d[i * 4 + 1] = col[1] * 255; d[i * 4 + 2] = col[2] * 255; d[i * 4 + 3] = Math.round(Math.min(1, 0.35 + a * 0.4) * 255);
        }
      }
    }
    this.politics.needsUpdate = true;
  }
}

export function hsl(h: number, sat = 0.62, l = 0.52): RGB {
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = sat * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}
