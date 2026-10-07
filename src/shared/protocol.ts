/**
 * Messages between the main thread (renderer + interface) and the simulation worker. The simulation owns the world; the
 * main thread only ever receives read-only snapshots of what is near the observer, plus HTML for the panels it asks for.
 */
import type { Storm } from '../sim/weather';
import type { Satellite, Mission, Route } from '../sim/space';

export type FollowTarget = { kind: 'person'; id: number } | { kind: 'settlement'; id: number } | { kind: 'civ'; id: number } | null;

export type PanelKind = 'person' | 'settlement' | 'civ' | 'species' | 'culture' | 'node' | 'building' | 'marine' | 'body';

export type ToWorker =
  | { t: 'init'; seed?: string; resume?: boolean }
  | { t: 'speed'; i: number }
  | { t: 'jump'; years: number; label: string }
  | { t: 'cancelJump' }
  | { t: 'camera'; x: number; y: number; km: number; alt: number }
  | { t: 'follow'; target: FollowTarget; family: boolean }
  | { t: 'panel'; req: number; kind: PanelKind; id: number; extra?: number; following: boolean; family: boolean }
  | { t: 'almanac'; req: number; tab: string; filters: string[] }
  | { t: 'dev'; req: number; fps: number }
  | { t: 'save' }
  | { t: 'export' }
  | { t: 'replay' }
  | { t: 'event'; req: number; id: number }
  | { t: 'personExists'; req: number; id: number };

export interface PlanetPayload {
  seed: number;
  seaLevel: number;
  landCells: number;
  arrays: Record<string, ArrayBufferView>;
}

export interface StaticInfo {
  seedText: string;
  seed: number;
  planet: PlanetPayload;
}

export interface EventLite {
  id: number;
  type: string;
  day: number;
  text: string;
  cause?: string;
  weight: number;
  x?: number;
  y?: number;
  person?: number;
  settlement?: number;
}

export interface SettlementLite {
  id: number;
  name: string;
  x: number;
  y: number;
  pop: number;
  stage: string;
  civ: number;
  hue: number;
  civHue: number;
  capital: boolean;
  nomadic: boolean;
  /** 0 none, 1 palisade, 2 stone wall */
  walls: number;
  /** street lights: 0 firelight only … 1 electrified */
  lights: number;
  ships: number;
  tech: number; // count, for labels
  /** 0 stone age, 1 sail, 2 steam, 3 motor */
  era: number;
}

export interface PeopleBlock {
  n: number;
  id: Int32Array;
  x: Float32Array;
  y: Float32Array;
  px: Float32Array;
  py: Float32Array;
  /** packed: see packPerson() in the worker */
  attr: Uint32Array;
}

export interface BuildingBlock {
  n: number;
  id: Int32Array;
  sid: Int32Array;
  kind: Uint8Array;
  x: Float32Array;
  y: Float32Array;
  rot: Float32Array;
  progress: Float32Array;
  /** bit0 done, bit1-2 fstate, bit3 ruined */
  state: Uint8Array;
  growth: Float32Array;
  hue: Float32Array;
}

export interface AnimalPop {
  sp: number;
  r: number;
  n: number;
  size: number;
  diet: number; // 0 herb 1 omni 2 carn
  hue: number;
}

export interface MarineLite {
  /** per region, density of forage fish, whales, sharks, seals, turtles (0..1, Uint8 scaled) */
  fish: Uint8Array;
  whale: Uint8Array;
  shark: Uint8Array;
  seal: Uint8Array;
  turtle: Uint8Array;
}

export interface EnvBlock {
  day: number;
  veg: Uint8Array;
  snow: Uint8Array;
  burn: Uint8Array; // 0..127 burned scar, 128+ burning now
  cultivated: Uint8Array;
  soil: Uint8Array;
}

export interface WeatherBlock {
  day: number;
  cloud: Uint8Array;
  precip: Uint8Array;
  temp: Int8Array;
  u: Int8Array;
  v: Int8Array;
  lightning: Uint8Array;
  sst: Int8Array;
  cu: Int8Array;
  cv: Int8Array;
}

export interface SkyBlock {
  storms: Storm[];
  fires: { x: number; y: number; cells: number }[];
  quakes: { x: number; y: number; day: number; mag: number }[];
  satellites: Satellite[];
  missions: Mission[];
  routes: Route[];
}

export interface Snapshot {
  t: 'snap';
  day: number;
  /** the simulation tick length at this moment, for interpolation */
  step: number;
  speedIdx: number;
  effective: number;
  stepMs: number;
  jumping: { remaining: number; total: number; label: string } | null;
  awakened: boolean;
  pop: number;
  civs: number;
  lod: { detailed: number; coarse: number; k: number };
  people: PeopleBlock;
  settlements?: SettlementLite[];
  buildings?: BuildingBlock;
  /** depletion of resource nodes near the observer: key = cell*64+slot, value = remaining fraction */
  nodeKeys?: Int32Array;
  nodeFrac?: Float32Array;
  /** prospected (known) ore and clay nodes near the observer */
  knownKeys?: Int32Array;
  animals?: AnimalPop[];
  /** tree species colour (hue) and growth per region, for forests */
  flora?: { hue: Float32Array; height: Float32Array };
  marine?: MarineLite;
  env?: EnvBlock;
  weather?: WeatherBlock;
  sky?: SkyBlock;
  events: EventLite[];
  follow: { kind: string; id: number; x: number; y: number; px: number; py: number; alive: boolean; name: string } | null;
  followMsg?: string;
}

export type FromWorker =
  | { t: 'progress'; msg: string; sub?: string }
  | { t: 'ready'; info: StaticInfo; resumed: boolean; awakeningText?: string; firstSettlement?: { x: number; y: number } }
  | Snapshot
  | { t: 'html'; req: number; html: string }
  | { t: 'toast'; msg: string }
  | { t: 'export'; name: string; json: string }
  | { t: 'event'; req: number; e: EventLite | null; personAlive?: boolean }
  | { t: 'exists'; req: number; ok: boolean }
  | { t: 'error'; msg: string };

// ---------------------------------------------------------------- packed person attributes
export const ACT = { idle: 0, walk: 1, work: 2, farm: 3, build: 4, sleep: 5, sail: 6, fight: 7 } as const;
export const CARGO = ['', 'food', 'wood', 'stone', 'clay', 'ore', 'metal', 'gold', 'goods'] as const;

export function unpackPerson(a: number) {
  return {
    female: (a & 1) === 1,
    age: (a >>> 1) & 3, // 0 child, 1 adult, 2 elder
    act: (a >>> 3) & 7,
    cargo: (a >>> 6) & 15,
    cargoAmt: (a >>> 10) & 63,
    hue: ((a >>> 16) & 255) / 255,
    band: (a >>> 24) & 3,
    legend: ((a >>> 26) & 1) === 1,
    occ: (a >>> 27) & 31,
  };
}
export const OCCS = ['child', 'forager', 'hunter', 'farmer', 'woodcutter', 'miner', 'trader', 'crafter', 'builder', 'healer', 'leader', 'warrior', 'explorer', 'priest', 'scholar', 'hermit', 'exile', 'raider', 'wanderer', 'cult founder', 'rebel'];
