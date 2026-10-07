import type { World } from '../sim/world';
import { Biome } from '../sim/planet';
import { clamp, lerp } from '../sim/rng';

type RGB = [number, number, number];
const hex = (h: number): RGB => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];
const mixc = (a: RGB, b: RGB, t: number): RGB => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

// [barren, lush]
const LAND: Record<number, [RGB, RGB]> = {
  [Biome.Ice]: [hex(0xe9f1f7), hex(0xe9f1f7)],
  [Biome.Tundra]: [hex(0x8a8473), hex(0x7a8a63)],
  [Biome.Taiga]: [hex(0x55654a), hex(0x2f5236)],
  [Biome.TemperateForest]: [hex(0x667a45), hex(0x2f6a30)],
  [Biome.Grassland]: [hex(0xa59b55), hex(0x6c9a3d)],
  [Biome.Savanna]: [hex(0xb39a53), hex(0x8f9a3f)],
  [Biome.Desert]: [hex(0xd3b27a), hex(0xc3a35f)],
  [Biome.Rainforest]: [hex(0x2f6a34), hex(0x14502a)],
  [Biome.Swamp]: [hex(0x4d6a50), hex(0x36573f)],
  [Biome.Mountain]: [hex(0x7b7468), hex(0x6a6d58)],
  [Biome.SnowPeak]: [hex(0xf2f5f8), hex(0xf2f5f8)],
  [Biome.Volcanic]: [hex(0x3b3331), hex(0x4a3b34)],
  [Biome.Lake]: [hex(0x2c6a9a), hex(0x2c6a9a)],
};
export const OCEAN_SHALLOW = hex(0x2f8aa8);
export const OCEAN_DEEP = hex(0x0b2a52);
const ICE = hex(0xdfeaf2);
const SNOW = hex(0xf4f7fa);
const FIELD = hex(0xc4b25a);
const RIVER = hex(0x3a86b8);
const URBAN = hex(0x8c7a64);

export function oceanColor(elevKm: number): RGB {
  const t = clamp(-elevKm / 4.5);
  return mixc(OCEAN_SHALLOW, OCEAN_DEEP, Math.pow(t, 0.6));
}

/** Albedo of a land cell given the current state of the simulation. */
export function landColor(w: World, i: number): RGB {
  const p = w.planet;
  const b = p.biome[i];
  const pair = LAND[b] ?? LAND[Biome.Grassland];
  const veg = clamp(w.env.veg[i] / Math.max(0.15, p.baseVeg[i] + 0.05));
  let c = mixc(pair[0], pair[1], b === Biome.Desert || b === Biome.Ice || b === Biome.SnowPeak ? 0 : veg);
  if (p.river[i] && b !== Biome.Ice) c = mixc(c, RIVER, 0.12);
  const Ts = w.env.seasonT[i];
  if (b !== Biome.Lake && Ts < -1 && b !== Biome.Desert) c = mixc(c, SNOW, clamp((-1 - Ts) / 8) * 0.95);
  if (w.env.cultivated[i]) c = mixc(c, FIELD, 0.55);
  return c;
}

export function seaIce(w: World, i: number): number {
  const p = w.planet;
  if (p.tempMean[i] > 2) return 0;
  const T = p.tempAt(i, w.day);
  return clamp((-8 - T) / 8);
}
export { mixc, URBAN, ICE };
export type { RGB };
