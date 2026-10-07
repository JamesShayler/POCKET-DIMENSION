/// <reference lib="webworker" />
/**
 * The simulation, off the main thread. It owns the World, advances it against real time at the chosen speed, and sends
 * the observer read-only snapshots of what is near them. The main thread never touches the World.
 */
import { World, FOCUS_KM } from '../sim/world';
import { Engine } from '../engine';
import { Panels } from '../sim/panels';
import { loadFromBrowser, saveToBrowser, serialize, deserialize } from '../sim/persistence';
import { H, N, NR, RF, RW, W, distKm, idx, wrapX } from '../sim/grid';
import { BDEFS, type BKind } from '../sim/buildings';
import { GROW_DAYS } from '../sim/jobs';
import { yearOf } from '../sim/time';
import { WN } from '../sim/weather';
import type { Person } from '../sim/people';
import type { SimEvent } from '../sim/events';
import { ACT, CARGO, OCCS } from '../shared/protocol';
import type { AnimalPop, BuildingBlock, EventLite, FollowTarget, FromWorker, PeopleBlock, SettlementLite, Snapshot, ToWorker } from '../shared/protocol';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const post = (m: FromWorker, transfer: Transferable[] = []) => ctx.postMessage(m, transfer);

let world: World | null = null;
let engine: Engine | null = null;
let panels: Panels | null = null;
let cam = { x: 0, y: 0, km: 40, alt: 1000 };
let follow: FollowTarget = null;
let family = false;
let followMsg: string | undefined;
const queue: EventLite[] = [];
const devLog: string[] = [];
let determinism = '';
let lastSave = 0;
let fps = 60;

const BKINDS = Object.keys(BDEFS) as BKind[];
const lite = (e: SimEvent): EventLite => ({ id: e.id, type: e.type, day: e.day, text: e.text, cause: e.cause, weight: e.weight, x: e.x, y: e.y, person: e.persons?.[0], settlement: e.settlement });

ctx.onmessage = (ev: MessageEvent<ToWorker>) => {
  const m = ev.data;
  try {
    handle(m);
  } catch (err) {
    post({ t: 'error', msg: String((err as Error)?.stack ?? err) });
  }
};

function handle(m: ToWorker) {
  if (m.t === 'init') { void init(m.seed, m.resume); return; }
  const w = world, e = engine;
  if (!w || !e) return;
  switch (m.t) {
    case 'speed': e.cancelJump(); e.setSpeed(m.i); break;
    case 'jump': e.jump(m.years, m.label); break;
    case 'cancelJump': e.cancelJump(); break;
    case 'camera': cam = { x: m.x, y: m.y, km: m.km, alt: m.alt }; w.focus = { x: m.x, y: m.y }; break;
    case 'follow': follow = m.target; family = m.family; break;
    case 'panel': post({ t: 'html', req: m.req, html: panels!.panel(m.kind, m.id, m.extra, m.following, m.family) }); break;
    case 'almanac': post({ t: 'html', req: m.req, html: panels!.almanac(m.tab, m.filters) }); break;
    case 'dev': fps = m.fps; post({ t: 'html', req: m.req, html: panels!.dev(m.fps, rate(e.effective), e.stepMs, devLog, determinism) }); break;
    case 'save': saveToBrowser(w).then(() => post({ t: 'toast', msg: 'Universe saved.' }), (err) => post({ t: 'toast', msg: 'Save failed: ' + String(err) })); break;
    case 'export': post({ t: 'export', name: `pocket-dimension-${w.seedText}-y${yearOf(w.day)}.json`, json: serialize(w) }); break;
    case 'replay': replayCheck(); break;
    case 'event': { const e2 = w.history.events.find((x) => x.id === m.id); const p = e2?.persons?.[0] ? w.people.get(e2.persons[0]) : undefined; post({ t: 'event', req: m.req, e: e2 ? lite(e2) : null, personAlive: !!p?.alive }); break; }
    case 'personExists': post({ t: 'exists', req: m.req, ok: w.people.has(m.id) }); break;
  }
}

async function init(seed?: string, resume?: boolean) {
  let w: World | null = null;
  let resumed = false;
  if (resume) {
    post({ t: 'progress', msg: 'Restoring the universe…' });
    w = await loadFromBrowser().catch(() => null);
    resumed = !!w;
  }
  if (!w) {
    const s = seed || 'pocket';
    post({ t: 'progress', msg: 'Generating planet…', sub: 'seed: ' + s });
    w = new World(s);
    w.begin();
    // life must evolve before anyone can wake: run the pre-human world forward until a lineage crosses the threshold
    let guard = 0;
    let lastPost = 0;
    while (!w.awakened && w.year < 12000 && guard++ < 100000) {
      w.stepPrehistory(4);
      const now = performance.now();
      if (now - lastPost > 120) {
        lastPost = now;
        const t = w.eco.totals();
        post({ t: 'progress', msg: 'Life is evolving…', sub: `year ${w.year.toLocaleString()} · ${t.species} species · ${t.animals.toLocaleString()} animals · ${w.marine.species.filter((x) => x.extinct < 0).length} sea species` });
      }
    }
  }
  world = w;
  engine = new Engine(w);
  panels = new Panels(w);
  w.bus.on('*', (e) => {
    if (e.weight >= 1) queue.push(lite(e));
    devLog.push(`Y${yearOf(e.day)} ${e.type} ${e.text.split('\n')[0]}`);
    if (devLog.length > 120) devLog.shift();
  });
  const first = w.activeSettlements().sort((a, b) => b.pop - a.pop)[0];
  const aw = w.history.query({ type: 'AWAKENING', limit: 1 })[0];
  if (first) { cam.x = first.x; cam.y = first.y; w.focus = { x: first.x, y: first.y }; }
  post({
    t: 'ready', resumed, awakeningText: aw?.text, firstSettlement: first ? { x: first.x, y: first.y } : undefined,
    info: { seedText: w.seedText, seed: w.seed, planet: { seed: w.seed, ...w.planet.toData() } },
  });
  lastSave = performance.now();
  last = performance.now();
  sendAll = true;
  setTimeout(loop, 0);
}

// ------------------------------------------------------------------ the clock
let last = 0;
let lastSnap = 0;
let snapN = 0;
let sendAll = true;
function loop() {
  const w = world!, e = engine!;
  const now = performance.now();
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  e.budgetMs = 14;
  e.advance(dt);
  followCheck();
  if (now - lastSnap > 45) {
    lastSnap = now;
    snapshot();
  }
  if (now - lastSave > 120000 && !e.jumping) { lastSave = now; saveToBrowser(w).catch(() => {}); }
  const spent = performance.now() - now;
  setTimeout(loop, Math.max(1, 16 - spent));
}

function rate(daysPerSec: number): string {
  const perMin = daysPerSec * 1440;
  if (perMin < 1.5) return `${perMin.toFixed(1)} min/s`;
  if (perMin < 90) return `${perMin.toFixed(0)} min/s`;
  if (daysPerSec < 1.5) return `${(daysPerSec * 24).toFixed(0)} h/s`;
  if (daysPerSec < 180) return `${daysPerSec.toFixed(0)} days/s`;
  return `${(daysPerSec / 360).toFixed(1)} yr/s`;
}

function followCheck() {
  const w = world!;
  if (!follow || follow.kind !== 'person') return;
  const p = w.people.get(follow.id);
  if (!p || p.alive) return;
  if (family) {
    const heir = p.children.map((id) => w.people.get(id)).filter((c): c is Person => !!c && c.alive).sort((a, b) => a.birth - b.birth)[0];
    if (heir) { followMsg = `${p.name} has died. Following ${heir.name}.`; follow = { kind: 'person', id: heir.id }; return; }
  }
  followMsg = `${p.name} has died${p.deathCause ? ' of ' + p.deathCause : ''}.`;
  follow = null;
}

// ------------------------------------------------------------------ snapshots
function packPerson(w: World, p: Person): number {
  const age = p.ageYears(w.day);
  let act: number = ACT.idle;
  const band = p.band ? w.bands.get(p.band) : undefined;
  if (p.goal === 'rest') act = ACT.sleep;
  else if (band) act = band.kind === 'army' && band.siege !== undefined ? ACT.fight : w.planet.ocean[idx(wrapX(Math.floor(p.x)), Math.max(0, Math.min(H - 1, Math.floor(p.y))))] ? ACT.sail : ACT.walk;
  else if (p.task) {
    if (p.phase === 1 || p.phase === 3) act = ACT.walk;
    else if (p.task === 'field') act = ACT.farm;
    else if (p.task === 'build') act = ACT.build;
    else if (p.phase === 2) act = ACT.work;
  } else if (p.hasTarget) act = ACT.walk;
  if (act === ACT.walk && w.planet.ocean[idx(wrapX(Math.floor(p.x)), Math.max(0, Math.min(H - 1, Math.floor(p.y))))]) act = ACT.sail;
  const cargo = p.cargoAmt > 0.5 ? Math.max(0, CARGO.indexOf((p.cargo === 'copper' || p.cargo === 'iron' || p.cargo === 'coal' ? 'ore' : p.cargo) as (typeof CARGO)[number])) : 0;
  const cul = w.cultures.get(p.culture);
  const hue = Math.round(((cul?.color ?? 0) % 1) * 255) & 255;
  const bk = band ? (band.kind === 'migrants' ? 1 : band.kind === 'army' ? 3 : 2) : 0;
  const occ = Math.max(0, OCCS.indexOf(p.occupation));
  return (p.sex & 1) | ((age < 12 ? 0 : age > 55 ? 2 : 1) << 1) | (act << 3) | ((cargo & 15) << 6) | ((Math.min(63, Math.round(p.cargoAmt)) & 63) << 10) | (hue << 16) | (bk << 24) | ((p.legend ? 1 : 0) << 26) | ((occ & 31) << 27);
}

function snapshot() {
  const w = world!, e = engine!;
  snapN++;
  const km = cam.km;
  const transfer: Transferable[] = [];
  // ---- people near the observer (and whoever is being followed)
  const near: Person[] = [];
  if (cam.alt < 60 && w.awakened) {
    for (const p of w.alive) {
      if (!p.alive) continue;
      if (Math.abs(p.y - cam.y) * 24.5 > km) continue;
      if (distKm(p.x, p.y, cam.x, cam.y) <= km) near.push(p);
      if (near.length >= 24000) break;
    }
  }
  let fol: Snapshot['follow'] = null;
  if (follow) {
    if (follow.kind === 'person') {
      const p = w.people.get(follow.id);
      if (p) {
        fol = { kind: 'person', id: p.id, x: p.x, y: p.y, px: p.px, py: p.py, alive: p.alive, name: p.name };
        if (p.alive && !near.includes(p)) near.push(p);
      }
    } else if (follow.kind === 'settlement') {
      const s = w.settlements[follow.id - 1];
      if (s) fol = { kind: 'settlement', id: s.id, x: s.x, y: s.y, px: s.x, py: s.y, alive: s.abandoned < 0, name: s.name };
    } else {
      const c = w.civs[follow.id - 1];
      const s = c ? w.settlements[c.capital - 1] : undefined;
      if (c && s) fol = { kind: 'civ', id: c.id, x: s.x, y: s.y, px: s.x, py: s.y, alive: c.collapsed < 0, name: c.name };
    }
  }
  const n = near.length;
  const people: PeopleBlock = { n, id: new Int32Array(n), x: new Float32Array(n), y: new Float32Array(n), px: new Float32Array(n), py: new Float32Array(n), attr: new Uint32Array(n) };
  for (let i = 0; i < n; i++) {
    const p = near[i];
    people.id[i] = p.id; people.x[i] = p.x; people.y[i] = p.y; people.px[i] = p.px; people.py[i] = p.py; people.attr[i] = packPerson(w, p);
  }
  transfer.push(people.id.buffer, people.x.buffer, people.y.buffer, people.px.buffer, people.py.buffer, people.attr.buffer);
  const snap: Snapshot = {
    t: 'snap', day: w.day, step: e.lastStep, speedIdx: e.speedIdx, effective: e.effective, stepMs: e.stepMs, jumping: e.jumping ? { ...e.jumping } : null,
    awakened: w.awakened, pop: w.alive.length, civs: w.livingCivs().length, lod: { ...w.lodStats }, people, events: queue.splice(0), follow: fol, followMsg,
  };
  followMsg = undefined;
  // ---- settlements (a few times a second)
  if (sendAll || snapN % 5 === 0) snap.settlements = settlementsLite(w);
  // ---- buildings, resource depletion, animals near the observer
  if (sendAll || snapN % 3 === 0) {
    if (cam.alt < 400 && w.awakened) {
      const b = buildingsNear(w, km + 6);
      snap.buildings = b;
      transfer.push(b.id.buffer, b.sid.buffer, b.kind.buffer, b.x.buffer, b.y.buffer, b.rot.buffer, b.progress.buffer, b.state.buffer, b.growth.buffer, b.hue.buffer);
    }
    if (cam.alt < 120) {
      const nd = nodesNear(w, Math.min(km, 40) + 4);
      snap.nodeKeys = nd.keys; snap.nodeFrac = nd.frac; snap.knownKeys = nd.known;
      transfer.push(nd.keys.buffer, nd.frac.buffer, nd.known.buffer);
      snap.animals = animalsNear(w, km + 60);
    }
  }
  // ---- the land surface and the weather
  if (sendAll || snapN % 22 === 0) {
    const env = w.env;
    const veg = new Uint8Array(N), snow = new Uint8Array(N), burn = new Uint8Array(N), cult = new Uint8Array(N), soil = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      veg[i] = Math.round(Math.min(1, env.veg[i]) * 255);
      snow[i] = Math.min(255, Math.round(Math.sqrt(env.snow[i]) * 4));
      burn[i] = env.burning[i] > 0 ? 128 + Math.min(127, Math.round(env.burning[i] * 50)) : Math.round(Math.min(1, env.burned[i]) * 127);
      cult[i] = env.cultivated[i] ? 255 : 0;
      soil[i] = Math.round(Math.min(1, env.soil[i]) * 255);
    }
    snap.env = { day: w.day, veg, snow, burn, cultivated: cult, soil };
    transfer.push(veg.buffer, snow.buffer, burn.buffer, cult.buffer, soil.buffer);
    const hue = new Float32Array(NR), height = new Float32Array(NR);
    for (let r = 0; r < NR; r++) { const sp = w.flora.at(r); hue[r] = sp?.hue ?? 0.3; height[r] = sp ? Math.min(1.6, 0.6 + sp.growYears / 80) : 1; }
    snap.flora = { hue, height };
    const ms = w.marine;
    const mk = (role: Parameters<typeof ms.density>[0]) => { const a = new Uint8Array(NR); for (let r = 0; r < NR; r++) a[r] = Math.round(ms.density(role, r) * 255); return a; };
    snap.marine = { fish: mk('forage'), whale: mk('whale'), shark: mk('shark'), seal: mk('seal'), turtle: mk('turtle') };
  }
  if (sendAll || snapN % 6 === 0) {
    const wx = w.weather;
    const q8 = (f: Float32Array, k: number) => { const a = new Uint8Array(WN); for (let i = 0; i < WN; i++) a[i] = Math.max(0, Math.min(255, Math.round(f[i] * k))); return a; };
    const s8 = (f: Float32Array, k: number) => { const a = new Int8Array(WN); for (let i = 0; i < WN; i++) a[i] = Math.max(-127, Math.min(127, Math.round(f[i] * k))); return a; };
    snap.weather = { day: w.day, cloud: q8(wx.cloud, 255), precip: q8(wx.precip, 8), temp: s8(wx.T, 2), u: s8(wx.u, 4), v: s8(wx.v, 4), lightning: q8(wx.lightning, 40), sst: s8(wx.sst, 3), cu: s8(wx.cu, 200), cv: s8(wx.cv, 200) };
    for (const a of Object.values(snap.weather)) if (typeof a !== 'number') transfer.push((a as Uint8Array).buffer);
    snap.sky = {
      storms: wx.storms.map((s) => ({ ...s })), fires: w.env.fires.map((f) => ({ x: f.x, y: f.y, cells: f.cells.length + f.burnt })), quakes: w.env.quakes.slice(-8),
      satellites: w.space.satellites, missions: w.space.missions.filter((m) => !m.done), routes: w.space.routes,
    };
  }
  sendAll = false;
  post(snap, transfer);
}

function settlementsLite(w: World): SettlementLite[] {
  const out: SettlementLite[] = [];
  for (const s of w.settlements) {
    if (s.abandoned >= 0) continue;
    const civ = w.civs[s.civ - 1];
    const cul = w.cultures.get(s.culture);
    const civCul = civ ? w.cultures.get(civ.culture) : undefined;
    out.push({
      id: s.id, name: s.name, x: s.x, y: s.y, pop: s.pop, stage: s.stage, civ: s.civ, hue: cul?.color ?? 0, civHue: civCul?.color ?? cul?.color ?? 0,
      capital: !!civ && civ.capital === s.id, nomadic: s.nomadic, walls: w.buildings.count(s.id, 'wall') ? 2 : w.buildings.count(s.id, 'palisade') ? 1 : 0,
      lights: s.tech.has('electricity') ? 1 : s.tech.has('engineering') ? 0.35 : s.tech.has('fire') ? 0.15 : 0, ships: s.ships, tech: s.tech.size,
      era: s.tech.has('combustion') ? 3 : s.tech.has('steam') ? 2 : s.tech.has('navigation') ? 1 : 0,
    });
  }
  return out;
}

function buildingsNear(w: World, km: number): BuildingBlock {
  const list: { b: (typeof w.buildings.list)[number]; hue: number }[] = [];
  for (const s of w.settlements) {
    if (s.abandoned >= 0) continue;
    if (distKm(s.x, s.y, cam.x, cam.y) > km + 12) continue;
    const hue = w.cultures.get(s.culture)?.color ?? 0;
    for (const b of w.buildings.of(s.id)) if (b.done !== -2) list.push({ b, hue });
  }
  const n = list.length;
  const out: BuildingBlock = {
    n, id: new Int32Array(n), sid: new Int32Array(n), kind: new Uint8Array(n), x: new Float32Array(n), y: new Float32Array(n), rot: new Float32Array(n),
    progress: new Float32Array(n), state: new Uint8Array(n), growth: new Float32Array(n), hue: new Float32Array(n),
  };
  for (let i = 0; i < n; i++) {
    const { b, hue } = list[i];
    out.id[i] = b.id; out.sid[i] = b.sid; out.kind[i] = BKINDS.indexOf(b.kind); out.x[i] = b.x; out.y[i] = b.y; out.rot[i] = b.rot; out.progress[i] = b.progress;
    out.state[i] = (b.done >= 0 ? 1 : 0) | ((b.fstate & 3) << 1);
    out.growth[i] = b.kind === 'field' ? (b.fstate === 2 ? 1 : b.fstate === 1 ? Math.min(0.97, (w.day - b.planted) / GROW_DAYS) : 0) + Math.min(0.99, b.weeds) * 0 : 0;
    out.hue[i] = hue;
  }
  return out;
}

function nodesNear(w: World, km: number) {
  const keys: number[] = [], frac: number[] = [], known: number[] = [];
  const cy0 = Math.floor(cam.y);
  const r = Math.ceil(km / 24) + 1;
  const knownBy = new Set<number>();
  for (const s of w.settlements) if (s.abandoned < 0 && distKm(s.x, s.y, cam.x, cam.y) < km + 80) for (const k of w.res.known.get(s.id) ?? []) knownBy.add(k);
  for (let dy = -r; dy <= r; dy++) {
    const y = cy0 + dy;
    if (y < 0 || y >= H) continue;
    const rx = Math.ceil(r / Math.max(0.15, Math.cos(((y + 0.5) / H - 0.5) * Math.PI)));
    for (let dx = -Math.min(rx, W / 2); dx <= Math.min(rx, W / 2); dx++) {
      const cell = idx(wrapX(Math.floor(cam.x) + dx), y);
      if (w.planet.ocean[cell] && !w.planet.coastDist[cell]) continue;
      for (const nd of w.res.nodes(cell)) {
        const key = cell * 64 + nd.slot;
        if (w.res.state.has(key)) { keys.push(key); frac.push(w.res.amount(cell, nd.slot, w.day) / nd.max); }
        if (knownBy.has(key)) known.push(key);
      }
    }
  }
  return { keys: Int32Array.from(keys), frac: Float32Array.from(frac), known: Int32Array.from(known) };
}

function animalsNear(w: World, km: number): AnimalPop[] {
  const out: AnimalPop[] = [];
  for (const p of w.eco.pops.values()) {
    if (p.n < 1) continue;
    const rx = (p.r % RW) * RF + RF / 2, ry = Math.floor(p.r / RW) * RF + RF / 2;
    if (distKm(rx, ry, cam.x, cam.y) > km + 70) continue;
    const sp = w.eco.speciesById(p.sp);
    out.push({ sp: p.sp, r: p.r, n: p.n, size: p.t.size, diet: sp.diet === 'herb' ? 0 : sp.diet === 'omni' ? 1 : 2, hue: sp.hue });
  }
  return out;
}

function replayCheck() {
  const w = world!;
  determinism = 'running…';
  setTimeout(() => {
    try {
      const json = serialize(w);
      const a = deserialize(json), b = deserialize(json);
      for (let i = 0; i < 200; i++) { a.step(7); b.step(7); }
      const same = a.alive.length === b.alive.length && a.stats.births === b.stats.births && a.history.nextId === b.history.nextId && a.rng.state === b.rng.state;
      determinism = same ? `✓ replay identical after 200 ticks (pop ${a.alive.length}, rng ${a.rng.state})` : '✗ replays diverged!';
    } catch (err) { determinism = 'error: ' + String(err); }
  }, 10);
}

void FOCUS_KM; void fps;
