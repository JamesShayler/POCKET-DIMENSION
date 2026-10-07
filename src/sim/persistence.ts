import { World } from './world';
import { Person, Memory, Relationship } from './people';
import { Rng } from './rng';
import type { Band } from './behavior';
import type { Species, Pop } from './ecology';
import { N, NR } from './grid';

/** Save format: the seed regenerates the planet (terrain, climate, rivers, resources) exactly; only evolving state is stored. */
export const SAVE_VERSION = 3;

const b64 = (a: Float32Array | Float64Array | Uint8Array | Uint16Array | Int32Array): string => {
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
function unb64<T extends Float32Array | Float64Array | Uint8Array | Uint16Array | Int32Array>(str: string, Ctor: { new (buf: ArrayBuffer): T }): T {
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
  task: string; phase: number; tcell: number; tslot: number; tb: number; timer: number; cargo: string; cargoAmt: number; back: string; house: number; tongue: number; fluency: [number, number][];
}

const WEATHER_ARRAYS = ['T', 'q', 'cloud', 'precip', 'sst', 'cu', 'cv', 'upwell', 'rain3', 'lightning', 'seasonRain', 'climRain', 'climN', 'rainAcc', 'tAcc', 'wSoil', 'wVeg'] as const;

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
      task: p.task, phase: p.phase, tcell: p.tcell, tslot: p.tslot, tb: p.tb, timer: p.timer, cargo: p.cargo, cargoAmt: p.cargoAmt, back: p.back, house: p.house, tongue: p.tongue, fluency: [...p.fluency],
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
    surface: {
      soil: b64(w.env.soil), snow: b64(w.env.snow), runoff: b64(w.env.runoff), flowNorm: b64(w.env.flowNorm), flowN: b64(w.env.flowN),
      frost: b64(w.env.frost), soilMean: b64(w.env.soilMean), soilAcc: b64(w.env.soilAcc), soilDays: w.env.soilDays,
      burned: b64(w.env.burned), burning: b64(w.env.burning), fires: w.env.fires, nextFire: w.env.nextFire, quakes: w.env.quakes,
    },
    weather: WEATHER_ARRAYS.reduce((o, k) => ({ ...o, [k]: b64(w.weather[k]) }), {
      storms: w.weather.storms, nextStorm: w.weather.nextStorm, acc: w.weather.acc, seasonsObserved: w.weather.seasonsObserved,
      seasonDays: w.weather.seasonDays, sstAcc: w.weather.sstAcc, surfAcc: w.weather.surfAcc, rng: w.weather.rng.state,
    } as Record<string, unknown>),
    species: w.eco.species, pops: [...w.eco.pops.values()], nextSpecies: w.eco.nextSpecies,
    predRisk: b64(w.eco.predRisk),
    langs: { list: w.langs.list, next: w.langs.next },
    cultures: { list: w.cultures.list.map((c) => ({ ...c, values: [...c.values] })), next: w.cultures.next },
    settlements: w.settlements.map((s) => ({ ...s, tech: [...s.tech] })),
    civs: w.civs,
    bands: [...w.bands.values()].map((b) => ({ ...b, tech: [...b.tech] })),
    people,
    flora: { species: w.flora.species, regionSp: b64(new Uint8Array(w.flora.regionSp.buffer)), rng: w.flora.rng.state },
    buildings: w.buildings.list,
    resState: [...w.res.state],
    resKnown: [...w.res.known].map(([k, v]) => [k, [...v]]),
    diplomacy: [...w.diplomacy.rel.values()],
    sky: { dustUntil: w.sky.dustUntil, dustStrength: w.sky.dustStrength, struck: w.sky.asteroids.map((a) => a.struck) },
    tradePairs: [...w.tradePairs], firstFinds: [...w.firstFinds],
    findCache: [...w.findCache], cavePaintings: w.cavePaintings,
    space: { satellites: w.space.satellites, missions: w.space.missions, routes: w.space.routes, programs: [...w.space.programs], next: w.space.next },
    marine: {
      species: w.marine.species.map((sp) => ({ ...sp, pop: b64(sp.pop), drift: b64(sp.drift) })), next: w.marine.next, rng: w.marine.rng.state, catch: b64(w.marine.catch),
    },
    discovered: [...w.discoveredComps],
    famineAt: [...w.famineAt], lastMigration: [...w.lastMigration], diseaseAt: [...w.diseaseAt], recentDroughts: w.env.recentDroughts,
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
  const sf = d.surface;
  w.env.soil.set(unb64(sf.soil, Float32Array)); w.env.snow.set(unb64(sf.snow, Float32Array)); w.env.runoff.set(unb64(sf.runoff, Float32Array));
  w.env.flowNorm.set(unb64(sf.flowNorm, Float32Array)); w.env.flowN.set(unb64(sf.flowN, Uint16Array));
  w.env.frost.set(unb64(sf.frost, Float32Array)); w.env.soilMean.set(unb64(sf.soilMean, Float32Array)); w.env.soilAcc.set(unb64(sf.soilAcc, Float32Array));
  w.env.soilDays = sf.soilDays; w.env.burned.set(unb64(sf.burned, Float32Array)); w.env.burning.set(unb64(sf.burning, Float32Array));
  w.env.fires = sf.fires; w.env.nextFire = sf.nextFire; w.env.quakes = sf.quakes;
  const wd = d.weather;
  for (const k of WEATHER_ARRAYS) {
    const a = w.weather[k];
    a.set(unb64(wd[k], a.constructor as { new (buf: ArrayBuffer): typeof a }) as never);
  }
  Object.assign(w.weather, { storms: wd.storms, nextStorm: wd.nextStorm, acc: wd.acc, seasonsObserved: wd.seasonsObserved, seasonDays: wd.seasonDays, sstAcc: wd.sstAcc, surfAcc: wd.surfAcc });
  w.weather.rng = new Rng(wd.rng);
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
      relations: new Map(r.relations), fluency: new Map(r.fluency ?? []),
    });
    w.people.set(p.id, p);
    if (p.alive) w.alive.push(p);
  }
  w.discoveredComps = new Set(d.discovered);
  w.flora.species = d.flora.species; w.flora.rng = new Rng(d.flora.rng);
  w.flora.regionSp = new Int16Array(unb64(d.flora.regionSp, Uint8Array).buffer);
  w.buildings.list = d.buildings; w.buildings.rebuildIndex();
  w.res.state = new Map(d.resState);
  w.res.known = new Map((d.resKnown as [number, number[]][]).map(([k, v]) => [k, new Set(v)]));
  w.diplomacy.rel = new Map((d.diplomacy as any[]).map((r) => [`${r.a}:${r.b}`, r]));
  w.sky.dustUntil = d.sky.dustUntil; w.sky.dustStrength = d.sky.dustStrength;
  (d.sky.struck as boolean[]).forEach((st, i) => { if (w.sky.asteroids[i]) w.sky.asteroids[i].struck = st; });
  w.tradePairs = new Map(d.tradePairs); w.firstFinds = new Set(d.firstFinds);
  w.findCache = new Map(d.findCache); w.cavePaintings = d.cavePaintings;
  Object.assign(w.space, { satellites: d.space.satellites, missions: d.space.missions, routes: d.space.routes, programs: new Map(d.space.programs), next: d.space.next });
  w.marine.species = (d.marine.species as any[]).map((sp) => ({ ...sp, pop: unb64(sp.pop, Float32Array), drift: unb64(sp.drift, Float32Array) }));
  w.marine.next = d.marine.next; w.marine.rng = new Rng(d.marine.rng); w.marine.catch.set(unb64(d.marine.catch, Float32Array));
  w.famineAt = new Map(d.famineAt); w.lastMigration = new Map(d.lastMigration); w.diseaseAt = new Map(d.diseaseAt ?? []); w.env.recentDroughts = d.recentDroughts;
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
