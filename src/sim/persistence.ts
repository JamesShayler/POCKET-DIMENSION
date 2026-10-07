import { World } from './world';
import { Person, Memory, Relationship } from './people';
import { Rng } from './rng';
import type { Band } from './behavior';
import type { Species, Pop } from './ecology';
import { N, NR } from './grid';

/** Save format: the seed regenerates the planet (terrain, climate, rivers, resources) exactly; only evolving state is stored. */
export const SAVE_VERSION = 1;

const b64 = (a: Float32Array | Float64Array | Uint8Array | Uint16Array): string => {
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
function unb64<T extends Float32Array | Float64Array | Uint8Array>(str: string, Ctor: { new (buf: ArrayBuffer): T }): T {
  const s = atob(str);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return new Ctor(bytes.buffer);
}

interface PersonRec {
  id: number; name: string; sex: number; species: number; birth: number; death: number; deathCause: string; mother: number; father: number;
  children: number[]; partner: number; pregnantUntil: number; pregnancyFather: number; x: number; y: number; home: number; culture: number; band: number;
  personality: number[]; needs: number[]; skills: number[]; beliefs: number[]; health: number; memories: Memory[]; relations: [number, Relationship][];
  occupation: string; goal: string; goalUntil: number; reputation: number; status: number; food: number; tools: number; goods: number;
  generation: number; alive: boolean; legend: boolean; workCell: number;
  tx: number; ty: number; hasTarget: boolean; stuck: number; px: number; py: number;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const arr = (a: Float32Array, alive: boolean): number[] => (alive ? Array.from(a) : Array.from(a, r3));

export function serialize(w: World): string {
  const people: PersonRec[] = [];
  for (const p of w.people.values()) {
    const q = p.alive ? (n: number) => n : r3;
    people.push({
      id: p.id, name: p.name, sex: p.sex, species: p.species, birth: p.birth, death: p.death, deathCause: p.deathCause, mother: p.mother, father: p.father,
      children: p.children, partner: p.partner, pregnantUntil: p.pregnantUntil, pregnancyFather: p.pregnancyFather, x: q(p.x), y: q(p.y), home: p.home, culture: p.culture,
      band: p.band, personality: arr(p.personality, p.alive), needs: arr(p.needs, p.alive), skills: arr(p.skills, p.alive), beliefs: arr(p.beliefs, p.alive), health: q(p.health),
      memories: p.memories, relations: [...p.relations], occupation: p.occupation, goal: p.goal, goalUntil: p.goalUntil, reputation: q(p.reputation), status: q(p.status),
      food: q(p.food), tools: p.tools, goods: p.goods, generation: p.generation, alive: p.alive, legend: p.legend, workCell: p.workCell,
      tx: p.tx, ty: p.ty, hasTarget: p.hasTarget, stuck: p.stuck, px: p.px, py: p.py,
    });
  }
  const data = {
    version: SAVE_VERSION,
    seedText: w.seedText,
    savedAt: Date.now(),
    day: w.day, seasonAcc: w.seasonAcc, awakened: w.awakened, firstPermanent: w.firstPermanent,
    rng: w.rng.state, ecoRng: w.eco.rng.state, nextPerson: w.nextPerson, nextBand: w.nextBand,
    stats: w.stats,
    env: {
      veg: b64(w.env.veg), fert: b64(w.env.fert), anomaly: b64(w.env.anomaly), cultivated: b64(w.env.cultivated),
      droughtSince: b64(w.env.droughtSince), forageStock: b64(w.env.forageStock), forageDay: b64(w.env.forageDay),
      regionTemp: b64(w.env.regionTemp), regionTempRange: b64(w.env.regionTempRange),
    },
    species: w.eco.species, pops: [...w.eco.pops.values()], nextSpecies: w.eco.nextSpecies,
    predRisk: b64(w.eco.predRisk),
    langs: { list: w.langs.list, next: w.langs.next },
    cultures: { list: w.cultures.list.map((c) => ({ ...c, values: [...c.values] })), next: w.cultures.next },
    settlements: w.settlements.map((s) => ({ ...s, tech: [...s.tech] })),
    civs: w.civs,
    bands: [...w.bands.values()].map((b) => ({ ...b, tech: [...b.tech] })),
    people,
    discovered: [...w.discoveredComps],
    famineAt: [...w.famineAt], lastMigration: [...w.lastMigration], recentDroughts: w.env.recentDroughts,
    history: { events: w.history.events, nextId: w.history.nextId, counts: w.history.counts },
  };
  return JSON.stringify(data);
}

export function deserialize(json: string): World {
  const d = JSON.parse(json);
  if (d.version !== SAVE_VERSION) throw new Error('Incompatible save version ' + d.version);
  const w = new World(d.seedText);
  w.day = d.day; w.seasonAcc = d.seasonAcc; w.awakened = d.awakened; w.firstPermanent = d.firstPermanent;
  w.rng = new Rng(d.rng); w.eco.rng = new Rng(d.ecoRng);
  w.nextPerson = d.nextPerson; w.nextBand = d.nextBand; w.stats = d.stats;
  const e = d.env;
  w.env.veg.set(unb64(e.veg, Float32Array)); w.env.fert.set(unb64(e.fert, Float32Array));
  w.env.anomaly.set(unb64(e.anomaly, Float32Array)); w.env.cultivated.set(unb64(e.cultivated, Uint8Array));
  w.env.droughtSince.set(unb64(e.droughtSince, Float64Array)); w.env.forageStock.set(unb64(e.forageStock, Float32Array));
  w.env.forageDay.set(unb64(e.forageDay, Float64Array));
  w.env.regionTemp.set(unb64(e.regionTemp, Float32Array)); w.env.regionTempRange.set(unb64(e.regionTempRange, Float32Array));
  w.eco.species = d.species as Species[]; w.eco.nextSpecies = d.nextSpecies;
  w.eco.pops.clear();
  for (const p of d.pops as Pop[]) w.eco.pops.set(p.sp * NR + p.r, p);
  w.eco.predRisk.set(unb64(d.predRisk, Float32Array));
  w.langs.list = d.langs.list; w.langs.next = d.langs.next;
  w.cultures.list = d.cultures.list.map((c: any) => ({ ...c, values: Float32Array.from(c.values) })); w.cultures.next = d.cultures.next;
  w.settlements = d.settlements.map((s: any) => ({ ...s, tech: new Set(s.tech) }));
  w.civs = d.civs;
  w.bands = new Map((d.bands as any[]).map((b) => [b.id, { ...b, tech: new Set(b.tech) } as Band]));
  w.people.clear(); w.alive = [];
  for (const r of d.people as PersonRec[]) {
    const p = new Person();
    Object.assign(p, r, {
      personality: Float32Array.from(r.personality), needs: Float32Array.from(r.needs), skills: Float32Array.from(r.skills), beliefs: Float32Array.from(r.beliefs),
      relations: new Map(r.relations),
    });
    w.people.set(p.id, p);
    if (p.alive) w.alive.push(p);
  }
  w.discoveredComps = new Set(d.discovered);
  w.famineAt = new Map(d.famineAt); w.lastMigration = new Map(d.lastMigration); w.env.recentDroughts = d.recentDroughts;
  w.history.events = d.history.events; w.history.nextId = d.history.nextId; w.history.counts = d.history.counts;
  return w;
}

// ---------- IndexedDB storage (saves are far larger than localStorage allows) ----------
const DB = 'pocket-dimension';
function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('saves');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
export async function saveToBrowser(w: World, slot = 'autosave'): Promise<number> {
  const json = serialize(w);
  const db = await open();
  await new Promise<void>((res, rej) => {
    const tx = db.transaction('saves', 'readwrite');
    tx.objectStore('saves').put(json, slot);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
  return json.length;
}
export async function loadFromBrowser(slot = 'autosave'): Promise<World | null> {
  const db = await open();
  const json: string | undefined = await new Promise((res, rej) => {
    const r = db.transaction('saves').objectStore('saves').get(slot);
    r.onsuccess = () => res(r.result as string | undefined);
    r.onerror = () => rej(r.error);
  });
  return json ? deserialize(json) : null;
}
export async function hasSave(slot = 'autosave'): Promise<boolean> {
  try {
    const db = await open();
    return await new Promise((res) => {
      const r = db.transaction('saves').objectStore('saves').count(slot);
      r.onsuccess = () => res(r.result > 0);
      r.onerror = () => res(false);
    });
  } catch { return false; }
}
void N;
