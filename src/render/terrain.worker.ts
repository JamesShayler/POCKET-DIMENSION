/// <reference lib="webworker" />
import { TerrainGen, type TerrainInput, type ChunkResult } from './terrainGen';

/** Builds terrain chunks off the main thread. */
const ctx = self as unknown as DedicatedWorkerGlobalScope;
let gen: TerrainGen | null = null;

ctx.onmessage = (ev: MessageEvent<{ t: 'init'; input: TerrainInput } | { t: 'chunk'; face: number; level: number; i: number; j: number; key: string }>) => {
  const m = ev.data;
  if (m.t === 'init') { gen = new TerrainGen(m.input); return; }
  if (!gen) return;
  const r: ChunkResult = gen.chunk(m.face, m.level, m.i, m.j, m.key);
  const tr: Transferable[] = [r.pos.buffer, r.normal.buffer, r.dir.buffer, r.elev.buffer, r.index.buffer, r.heights.buffer];
  if (r.water) tr.push(r.water.pos.buffer, r.water.depth.buffer, r.water.dir.buffer, r.water.index.buffer);
  if (r.trees) tr.push(r.trees.buffer);
  ctx.postMessage(r, tr);
};
