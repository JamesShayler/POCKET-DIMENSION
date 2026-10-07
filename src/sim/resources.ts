import type { World } from './world';
import { Biome } from './planet';
import { Rng, clamp, mix32 } from './rng';
import { KM_PER_CELL_Y, H, W, idx, kmPerCellX, regionOfCell, wrapX } from './grid';

/** Physical, spatial resources: groves, berry bushes, fishing spots, stone outcrops, clay pits and ore veins.
 *  Positions are continuous and generated deterministically from the seed; only *depletion* is stored. */
export type NodeKind = 'tree' | 'bush' | 'stone' | 'clay' | 'fish' | 'copper' | 'iron' | 'coal' | 'gold';
export const NODE_KINDS: NodeKind[] = ['tree', 'bush', 'stone', 'clay', 'fish', 'copper', 'iron', 'coal', 'gold'];
export const HIDDEN_KINDS = new Set<NodeKind>(['copper', 'iron', 'coal', 'gold', 'clay']); // must be prospected before use

export interface NodeDef {
  kind: NodeKind;
  x: number;
  y: number;
  max: number;
  slot: number;
}
interface NodeState { amt: number; t: number }

const TREE_BASE: Partial<Record<Biome, number>> = {
  [Biome.Rainforest]: 12, [Biome.TemperateForest]: 9, [Biome.Taiga]: 8, [Biome.Swamp]: 5, [Biome.Savanna]: 3, [Biome.Grassland]: 1.4, [Biome.Tundra]: 0.7, [Biome.Mountain]: 1,
};
const BUSH_BASE: Partial<Record<Biome, number>> = {
  [Biome.Rainforest]: 6, [Biome.TemperateForest]: 5, [Biome.Grassland]: 4, [Biome.Savanna]: 4, [Biome.Taiga]: 3, [Biome.Swamp]: 3, [Biome.Tundra]: 2,
};

export class Resources {
  private cache = new Map<number, NodeDef[]>();
  /** Depleted/regrowing nodes only. key = cell * 64 + slot */
  state = new Map<number, NodeState>();
  /** Prospected nodes by settlement id (ores & clay are hidden until someone finds them). */
  known = new Map<number, Set<number>>();

  constructor(private world: World) {}

  nodes(cell: number): NodeDef[] {
    let l = this.cache.get(cell);
    if (l) return l;
    if (this.cache.size > 6000) this.cache.clear();
    l = this.gen(cell);
    this.cache.set(cell, l);
    return l;
  }

  private gen(cell: number): NodeDef[] {
    const w = this.world;
    const p = w.planet;
    const out: NodeDef[] = [];
    if (p.ocean[cell]) return out;
    const rng = new Rng(mix32(w.seed, cell * 7 + 13));
    const cx = cell % W;
    const cy = Math.floor(cell / W);
    const b = p.biome[cell] as Biome;
    const add = (kind: NodeKind, max: number) => {
      if (out.length >= 63) return;
      // fishing waters must be wet, everything else must stand on dry land
      for (let t = 0; t < 5; t++) {
        const x = cx + 0.04 + rng.next() * 0.92, y = cy + 0.04 + rng.next() * 0.92;
        const e = p.elevAt(x, y);
        const wet = e <= 0 || (p.lake[cell] && e < p.lakeLevel[cell]);
        if (kind === 'fish' ? wet || (p.river[cell] && t === 4) : !wet && e > 0.003) {
          out.push({ kind, x, y, max: Math.round(max), slot: out.length });
          return;
        }
      }
    };
    const veg = 0.35 + p.baseVeg[cell];
    const nt = Math.floor((TREE_BASE[b] ?? 0) * veg + rng.next());
    for (let i = 0; i < nt; i++) add('tree', 50 + rng.next() * 150);
    const nb = Math.floor((BUSH_BASE[b] ?? 0) * veg + rng.next());
    for (let i = 0; i < nb; i++) add('bush', 14 + rng.next() * 20);
    if (p.coastDist[cell] <= 1 || p.river[cell] || p.lake[cell]) for (let i = 0; i < 2 + (rng.next() < 0.4 ? 1 : 0); i++) add('fish', 50 + rng.next() * 60);
    const s = p.res.stone[cell] / 255;
    const ns = Math.floor(s * 4.2 + rng.next() * 0.8);
    for (let i = 0; i < ns; i++) add('stone', 500 + rng.next() * 700);
    const c = p.res.clay[cell];
    if (c > 70) for (let i = 0; i < 1 + (c > 170 ? 1 : 0); i++) add('clay', 160 + rng.next() * 200);
    const ore = (kind: NodeKind, v: number, thr: number, max: number) => {
      if (v > thr) for (let i = 0; i < 1 + (v > thr + 100 ? 1 : 0) + (v > thr + 170 ? 1 : 0); i++) add(kind, max * (0.5 + rng.next()));
    };
    ore('copper', p.res.copper[cell], 55, 360);
    ore('iron', p.res.iron[cell], 60, 520);
    ore('coal', p.res.coal[cell], 60, 600);
    ore('gold', p.res.gold[cell], 85, 70);
    return out;
  }

  /** Wood-per-tree and regrowth rate depend on the local tree species (which evolves). */
  private regenRate(kind: NodeKind, node: NodeDef, cell: number): number {
    switch (kind) {
      case 'tree': {
        const sp = this.world.flora.at(regionOfCell(cell % W, Math.floor(cell / W)));
        return node.max / (sp.growYears * 360);
      }
      case 'bush': return node.max / 130;
      case 'fish': return node.max / 220;
      case 'clay': return node.max / (3 * 360);
      default: return 0;
    }
  }

  amount(cell: number, slot: number, day: number): number {
    const node = this.nodes(cell)[slot];
    if (!node) return 0;
    const key = cell * 64 + slot;
    const st = this.state.get(key);
    if (!st) return node.max;
    const r = this.regenRate(node.kind, node, cell);
    const amt = Math.min(node.max, st.amt + (day - st.t) * r);
    if (amt >= node.max - 1e-6) { this.state.delete(key); return node.max; }
    return amt;
  }

  /** Remove up to `want` units; returns what was actually taken. */
  take(cell: number, slot: number, want: number, day: number): number {
    const have = this.amount(cell, slot, day);
    const got = Math.min(have, want);
    if (got <= 0) return 0;
    this.state.set(cell * 64 + slot, { amt: have - got, t: day });
    return got;
  }

  isKnown(sid: number, cell: number, slot: number): boolean {
    return this.known.get(sid)?.has(cell * 64 + slot) ?? false;
  }
  markKnown(sid: number, cell: number, slot: number): boolean {
    let k = this.known.get(sid);
    if (!k) { k = new Set(); this.known.set(sid, k); }
    const key = cell * 64 + slot;
    if (k.has(key)) return false;
    k.add(key);
    return true;
  }

  /** Nearest usable node of any of `kinds` within radiusKm of a position; hidden kinds must be known to settlement `sid`. */
  find(kinds: readonly NodeKind[], x: number, y: number, radiusKm: number, day: number, sid: number, minAmt = 1): { cell: number; slot: number; node: NodeDef; d: number; amt: number } | null {
    let best: { cell: number; slot: number; node: NodeDef; d: number; amt: number } | null = null;
    const ky = KM_PER_CELL_Y;
    const rows = Math.ceil(radiusKm / ky) + 1;
    const cy0 = Math.floor(y);
    for (let dy = -rows; dy <= rows; dy++) {
      const yy = cy0 + dy;
      if (yy < 0 || yy >= H) continue;
      const kx = kmPerCellX(yy);
      const cols = Math.min(W / 2, Math.ceil(radiusKm / kx) + 1);
      const rowMin = Math.max(0, Math.abs(dy) - 1) * ky;
      if (best && rowMin > best.d) continue;
      for (let dx = -cols; dx <= cols; dx++) {
        const colMin = Math.max(0, Math.abs(dx) - 1) * kx;
        if (best && Math.hypot(colMin, rowMin) > best.d) continue;
        const cell = idx(wrapX(Math.floor(x) + dx), yy);
        const list = this.nodes(cell);
        for (let i = 0; i < list.length; i++) {
          const n = list[i];
          if (!kinds.includes(n.kind)) continue;
          let ddx = n.x - x;
          const base = Math.floor(x) + dx;
          ddx = (base + (n.x - Math.floor(n.x))) - x;
          const d = Math.hypot(ddx * kx, (n.y - y) * ky);
          if (d > radiusKm || (best && d >= best.d)) continue;
          if (HIDDEN_KINDS.has(n.kind) && !this.isKnown(sid, cell, i)) continue;
          const amt = this.amount(cell, i, day);
          if (amt < minAmt) continue;
          best = { cell, slot: i, node: n, d, amt };
        }
      }
    }
    return best;
  }

  /** Prospecting: reveal hidden nodes within `radiusKm` of a position for a settlement. Returns revealed nodes. */
  prospect(sid: number, x: number, y: number, radiusKm: number): { cell: number; node: NodeDef }[] {
    const found: { cell: number; node: NodeDef }[] = [];
    const ky = KM_PER_CELL_Y;
    const rows = Math.ceil(radiusKm / ky) + 1;
    for (let dy = -rows; dy <= rows; dy++) {
      const yy = Math.floor(y) + dy;
      if (yy < 0 || yy >= H) continue;
      const kx = kmPerCellX(yy);
      const cols = Math.min(W / 2, Math.ceil(radiusKm / kx) + 1);
      for (let dx = -cols; dx <= cols; dx++) {
        const cell = idx(wrapX(Math.floor(x) + dx), yy);
        const list = this.nodes(cell);
        for (let i = 0; i < list.length; i++) {
          const n = list[i];
          if (!HIDDEN_KINDS.has(n.kind)) continue;
          const nx = Math.floor(x) + dx + (n.x - Math.floor(n.x));
          if (Math.hypot((nx - x) * kx, (n.y - y) * ky) <= radiusKm && this.markKnown(sid, cell, i)) found.push({ cell, node: n });
        }
      }
    }
    return found;
  }

  /** Position (cell coordinates) of a node, unwrapped near a reference x. */
  static pos(node: NodeDef): { x: number; y: number } {
    return { x: node.x, y: node.y };
  }
}
void clamp;
