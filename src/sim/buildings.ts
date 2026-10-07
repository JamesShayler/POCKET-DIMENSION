import type { World } from './world';
import type { Settlement } from './settlements';
import type { TechId } from './technology';
import { Rng, clamp, mix32 } from './rng';
import { H, KM_PER_CELL_Y, W, idx, kmPerCellX, wrapDx, wrapX } from './grid';

export type ResKey = 'wood' | 'stone' | 'clay' | 'copper' | 'iron' | 'coal' | 'gold' | 'metal';
export const RES_KEYS: ResKey[] = ['wood', 'stone', 'clay', 'copper', 'iron', 'coal', 'gold', 'metal'];
export type Stock = Record<ResKey, number>;
export const emptyStock = (): Stock => ({ wood: 0, stone: 0, clay: 0, copper: 0, iron: 0, coal: 0, gold: 0, metal: 0 });

export type BKind =
  | 'hut' | 'house' | 'brickhouse' | 'stonehouse' | 'granary' | 'workshop' | 'kiln' | 'smithy'
  | 'market' | 'temple' | 'hall' | 'tower' | 'well' | 'field'
  | 'dock' | 'palisade' | 'wall' | 'factory' | 'powerplant' | 'airport' | 'launchpad';

export interface BDef {
  name: string;
  cost: Partial<Stock>;
  /** person-hours of construction labour */
  labor: number;
  cap: number; // residents housed
  size: number; // footprint, km
  tech: TechId[];
  minPop: number;
}

export const BDEFS: Record<BKind, BDef> = {
  hut: { name: 'Hut', cost: { wood: 24 }, labor: 24, cap: 4, size: 0.012, tech: [], minPop: 0 },
  house: { name: 'Timber house', cost: { wood: 90 }, labor: 110, cap: 6, size: 0.016, tech: ['tools'], minPop: 8 },
  brickhouse: { name: 'Mud-brick house', cost: { clay: 60, wood: 30 }, labor: 160, cap: 8, size: 0.017, tech: ['pottery', 'agriculture'], minPop: 20 },
  stonehouse: { name: 'Stone house', cost: { stone: 130, wood: 40 }, labor: 320, cap: 10, size: 0.02, tech: ['architecture'], minPop: 50 },
  granary: { name: 'Granary', cost: { wood: 80, clay: 40 }, labor: 160, cap: 0, size: 0.02, tech: ['pottery', 'agriculture'], minPop: 30 },
  workshop: { name: 'Workshop', cost: { wood: 70, stone: 30 }, labor: 140, cap: 0, size: 0.02, tech: ['tools'], minPop: 25 },
  kiln: { name: 'Kiln', cost: { clay: 60 }, labor: 90, cap: 0, size: 0.014, tech: ['pottery'], minPop: 25 },
  smithy: { name: 'Smithy', cost: { stone: 120, clay: 70, wood: 40 }, labor: 220, cap: 0, size: 0.02, tech: ['metallurgy'], minPop: 50 },
  market: { name: 'Market', cost: { wood: 170 }, labor: 260, cap: 0, size: 0.04, tech: ['tools'], minPop: 120 },
  temple: { name: 'Temple', cost: { stone: 280, wood: 80 }, labor: 700, cap: 0, size: 0.03, tech: ['architecture'], minPop: 100 },
  hall: { name: 'Council hall', cost: { wood: 160, stone: 90 }, labor: 380, cap: 0, size: 0.03, tech: ['tools'], minPop: 70 },
  tower: { name: 'Watchtower', cost: { stone: 170, wood: 50 }, labor: 300, cap: 0, size: 0.012, tech: ['architecture'], minPop: 60 },
  well: { name: 'Well', cost: { stone: 50 }, labor: 80, cap: 0, size: 0.006, tech: ['tools'], minPop: 40 },
  field: { name: 'Field', cost: {}, labor: 150, cap: 0, size: 0.1, tech: ['agriculture'], minPop: 0 },
  dock: { name: 'Dock', cost: { wood: 90, stone: 20 }, labor: 260, cap: 0, size: 0.03, tech: ['navigation'], minPop: 50 },
  palisade: { name: 'Palisade', cost: { wood: 260 }, labor: 380, cap: 0, size: 0, tech: ['tools'], minPop: 60 },
  wall: { name: 'Town wall', cost: { stone: 700, wood: 60 }, labor: 1800, cap: 0, size: 0, tech: ['architecture'], minPop: 220 },
  factory: { name: 'Factory', cost: { stone: 300, wood: 100, metal: 40 }, labor: 1500, cap: 0, size: 0.06, tech: ['industry'], minPop: 150 },
  powerplant: { name: 'Power station', cost: { stone: 400, metal: 80 }, labor: 2400, cap: 0, size: 0.07, tech: ['electricity'], minPop: 220 },
  airport: { name: 'Airport', cost: { stone: 700, metal: 60 }, labor: 4000, cap: 0, size: 0.5, tech: ['flight'], minPop: 280 },
  launchpad: { name: 'Launch site', cost: { stone: 900, metal: 220 }, labor: 9000, cap: 0, size: 0.25, tech: ['rocketry'], minPop: 300 },
};
/** Ring defences: drawn around the whole town, not placed as a single footprint. */
export const RINGS: BKind[] = ['palisade', 'wall'];
export const HOUSING: BKind[] = ['hut', 'house', 'brickhouse', 'stonehouse'];

export interface Building {
  id: number;
  sid: number;
  kind: BKind;
  x: number;
  y: number;
  rot: number;
  progress: number; // 0..1 built
  started: number;
  done: number; // day completed, -1 while under construction
  // field state
  fstate: number; // 0 cleared, 1 growing, 2 ripe
  planted: number;
  weeds: number;
  crop: number;
  lastWork: number;
  residents: number;
}

export class Buildings {
  list: Building[] = [];
  /** per settlement: its buildings (a cached array, never copy it in hot paths) */
  bySettlement = new Map<number, Building[]>();
  private static EMPTY: Building[] = [];
  /** shoreline points around a town, a pure function of its position (so caching it never changes the history) */
  private shoreMemo = new Map<string, { x: number; y: number }[]>();

  constructor(private world: World) {}

  get(id: number): Building | undefined {
    return this.list[id - 1];
  }
  of(sid: number): Building[] {
    return this.bySettlement.get(sid) ?? Buildings.EMPTY;
  }
  count(sid: number, kind: BKind, doneOnly = true): number {
    let n = 0;
    for (const b of this.of(sid)) if (b.kind === kind && (!doneOnly || b.done >= 0)) n++;
    return n;
  }

  /** Housing capacity of completed dwellings. */
  capacity(sid: number): number {
    let c = 0;
    for (const b of this.of(sid)) if (b.done >= 0 && b.progress >= 1) c += BDEFS[b.kind].cap;
    return c;
  }

  /** Organic placement: a growing, jittered rosette around the centre with spacing; fields on fertile ground further out. */
  place(s: Settlement, kind: BKind, rng: Rng): { x: number; y: number } | null {
    const w = this.world;
    const p = w.planet;
    const mine = this.of(s.id);
    const def = BDEFS[kind];
    const isField = kind === 'field';
    const n = mine.length;
    if (RINGS.includes(kind)) return { x: s.x, y: s.y };
    if (kind === 'dock') {
      // a dock stands on the town's own shore, just inland of the waterline
      const pts = this.shore(s);
      const k0 = rng.int(Math.max(1, pts.length));
      for (let q = 0; q < pts.length; q++) {
        const c = pts[(k0 + q) % pts.length];
        if (mine.some((b) => Math.hypot(wrapDx(c.x, b.x) * kmPerCellX(c.y), (c.y - b.y) * KM_PER_CELL_Y) < (def.size + BDEFS[b.kind].size) * 1.15 + 0.004)) continue;
        return { x: ((c.x % W) + W) % W, y: c.y };
      }
      return null;
    }
    const far = kind === 'factory' || kind === 'powerplant' ? [0.5, 1.6] : kind === 'airport' ? [2.5, 4] : kind === 'launchpad' ? [5, 9] : null;
    for (let attempt = 0; attempt < 30; attempt++) {
      // radial density falls off from the centre; civic buildings stay central
      const civic = kind === 'hall' || kind === 'market' || kind === 'temple' || kind === 'well';
      const rKm = far ? far[0] + rng.next() * (far[1] - far[0]) : isField ? 0.35 + Math.sqrt(rng.next()) * (0.8 + Math.sqrt(s.pop) * 0.08 + n * 0.004) : civic ? 0.03 + rng.next() * 0.12 : 0.03 + Math.sqrt(rng.next()) * (0.06 + Math.sqrt(n + 3) * 0.042);
      const ang = rng.next() * Math.PI * 2;
      const y = s.y + (Math.sin(ang) * rKm) / KM_PER_CELL_Y;
      if (y < 0.2 || y > H - 0.2) continue;
      const x = s.x + (Math.cos(ang) * rKm) / kmPerCellX(y);
      const xi = wrapX(Math.floor(x));
      const cell = idx(xi, Math.floor(y));
      if (p.ocean[cell] || p.elev[cell] > 3.2 || !p.isLand(x, y, 0.004)) continue;
      let ok = true;
      for (const b of mine) {
        const kx = kmPerCellX(y);
        const d = Math.hypot(wrapDx(x, b.x) * kx, (y - b.y) * KM_PER_CELL_Y);
        if (d < (def.size + BDEFS[b.kind].size) * (isField ? 0.8 : 1.15) + 0.004) { ok = false; break; }
      }
      if (!ok) continue;
      if (isField && w.env.fert[cell] < 0.12) continue;
      return { x: ((x % W) + W) % W, y };
    }
    return null;
  }

  /** Where the water begins around a town: along 24 bearings, the first sea or lake within 24 km, found to a few metres. */
  private shore(s: Settlement): { x: number; y: number }[] {
    const key = `${s.id}:${s.x}:${s.y}`;
    const hit = this.shoreMemo.get(key);
    if (hit) return hit;
    const p = this.world.planet;
    const at = (ca: number, sa: number, r: number) => {
      const y = s.y + (sa * r) / KM_PER_CELL_Y;
      return { x: s.x + (ca * r) / kmPerCellX(y), y };
    };
    const out: { x: number; y: number }[] = [];
    for (let k = 0; k < 24; k++) {
      const ang = (k / 24) * Math.PI * 2 + 0.1;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      let lo = 0, hi = -1;
      for (let r = 0.25; r <= 24; r += 0.25) {
        const q = at(ca, sa, r);
        if (q.y < 0.2 || q.y > H - 0.2) break;
        if (!p.isLand(q.x, q.y, 0.0)) { hi = r; break; }
        lo = r;
      }
      if (hi < 0) continue;
      for (let it = 0; it < 6; it++) {
        const m = (lo + hi) / 2, q = at(ca, sa, m);
        if (p.isLand(q.x, q.y, 0.0)) lo = m; else hi = m;
      }
      const q = at(ca, sa, Math.max(0.03, lo - 0.012));
      if (p.isLand(q.x, q.y, 0.0)) out.push(q);
    }
    this.shoreMemo.set(key, out);
    return out;
  }

  start(s: Settlement, kind: BKind, spend = true): Building | null {
    const w = this.world;
    const def = BDEFS[kind];
    if (spend) {
      for (const k of Object.keys(def.cost) as ResKey[]) if (s.res[k] < (def.cost[k] ?? 0)) return null;
    }
    const rng = new Rng(mix32(w.seed, s.id * 131 + this.list.length));
    const pos = this.place(s, kind, rng);
    if (!pos) return null;
    if (spend) for (const k of Object.keys(def.cost) as ResKey[]) s.res[k] -= def.cost[k] ?? 0;
    const b: Building = {
      id: this.list.length + 1, sid: s.id, kind, x: pos.x, y: pos.y, rot: rng.next() * Math.PI, progress: 0, started: w.day, done: -1,
      fstate: 0, planted: -1, weeds: 0, crop: 0, lastWork: w.day, residents: 0,
    };
    this.list.push(b);
    const arr = this.bySettlement.get(s.id) ?? [];
    arr.push(b);
    this.bySettlement.set(s.id, arr);
    return b;
  }

  /** Add construction labour (person-hours). Returns true if the building has just been completed. */
  work(b: Building, hours: number, quality = 1): boolean {
    if (b.done >= 0) return false;
    b.progress = clamp(b.progress + (hours * quality) / BDEFS[b.kind].labor, 0, 1);
    if (b.progress >= 1) {
      b.done = this.world.day;
      return true;
    }
    return false;
  }

  /** Return destroyed/abandoned buildings of a settlement to the wild. */
  destroy(sid: number, fraction: number, rng: Rng, weight?: (b: Building) => number): number {
    let n = 0;
    const keep: Building[] = [];
    for (const b of this.of(sid)) {
      if (rng.next() < fraction * (weight ? weight(b) : 1)) { b.progress = 0; b.done = -2; n++; } else keep.push(b);
    }
    this.bySettlement.set(sid, keep);
    return n;
  }

  rebuildIndex() {
    this.bySettlement.clear();
    for (const b of this.list) {
      if (b.done === -2) continue;
      const a = this.bySettlement.get(b.sid) ?? [];
      a.push(b);
      this.bySettlement.set(b.sid, a);
    }
  }
}
