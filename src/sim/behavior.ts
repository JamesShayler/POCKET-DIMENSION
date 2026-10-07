import type { World } from './world';
import { clamp, lerp } from './rng';
import { H, W, KM_PER_CELL_Y, NBR8, distKm, idx, kmPerCellX, regionOfCell, wrapDx, wrapX } from './grid';
import { Goal, ND, NS, Occupation, P, Person, SK } from './people';
import type { Settlement } from './settlements';
import type { TechSet } from './technology';
import { DAYS_PER_YEAR, seasonOf } from './time';
import { NV } from './culture';
import { runJob } from './jobs';
import { isNight, localTime } from './time';

export interface Band {
  id: number;
  kind: 'migrants' | 'outcasts' | 'raiders' | 'army';
  leader: number;
  tx: number;
  ty: number;
  from: number;
  culture: number;
  civ: number;
  tech: TechSet;
  note: string;
  created: number;
  members: number[];
  stuck: number;
  lastRaid: number;
  returning?: boolean;
  lastTarget?: number;
}

const SEASON_YIELD = [0.75, 1.15, 1.4, 0.3];

export const cellOf = (p: Person) => idx(wrapX(Math.floor(p.x)), clamp(Math.floor(p.y), 0, H - 1));
const hasTech = (s: Settlement | undefined, t: string) => !!s && (s.tech as Set<string>).has(t);

/** Can this position be walked on (or sailed, with navigation)? */
function passable(w: World, x: number, y: number, boat: boolean): boolean {
  if (y < 0 || y >= H) return false;
  const i = idx(wrapX(Math.floor(x)), Math.floor(y));
  if (w.planet.ocean[i]) return boat && w.planet.elev[i] > -2.4;
  return w.planet.elev[i] < 4.8;
}

/** Greedy walk with obstacle sidestepping, in kilometres. Returns true on arrival (within `tol` km). */
export function walk(w: World, p: Person, tx: number, ty: number, km: number, boat: boolean, tol = 0.03): boolean {
  let guard = 0;
  const side = p.id % 2 === 0 ? 1 : -1;
  const ky = KM_PER_CELL_Y;
  while (km > 1e-5 && guard++ < 60) {
    const kx = kmPerCellX(p.y);
    const dxk = wrapDx(p.x, tx) * kx;
    const dyk = (ty - p.y) * ky;
    const dist = Math.hypot(dxk, dyk);
    if (dist <= tol) return true;
    const step = Math.min(dist, km, 8);
    const ang = Math.atan2(dyk, dxk);
    let moved = false;
    for (let k = 0; k < 7 && !moved; k++) {
      const a = ang + side * ((k + 1) >> 1) * (k % 2 === 0 ? 1 : -1) * (Math.PI / 4);
      const nx = p.x + (Math.cos(a) * step) / kx;
      const ny = p.y + (Math.sin(a) * step) / ky;
      if (passable(w, nx, ny, boat)) {
        p.x = ((nx % W) + W) % W;
        p.y = ny;
        const e = w.planet.elev[idx(wrapX(Math.floor(p.x)), Math.floor(p.y))];
        km -= step * (1 + Math.max(0, e - 1.5) * 0.4);
        moved = true;
        if (k > 0) p.stuck += 0.03;
        else p.stuck = Math.max(0, p.stuck - 0.1);
      }
    }
    if (!moved) { p.stuck += 1; return false; }
  }
  const dx = wrapDx(p.x, tx) * kmPerCellX(p.y);
  return Math.hypot(dx, (ty - p.y) * ky) <= tol;
}

/** Distance between a person and a point, in km. */
export function kmTo(p: { x: number; y: number }, x: number, y: number): number {
  return Math.hypot(wrapDx(p.x, x) * kmPerCellX(p.y), (y - p.y) * KM_PER_CELL_Y);
}
export const WALK_KMH = 4.5;

// -------- site selection (used by migration, outcasts, founding) --------
export function findSite(w: World, ox: number, oy: number, radiusKm: number, boat: boolean, fromComp: number, culture: number, avoidKm = 35): { x: number; y: number; score: number } | null {
  const rng = w.rng;
  const planet = w.planet;
  let best: { x: number; y: number; score: number } | null = null;
  const living = w.activeSettlements();
  for (let t = 0; t < 70; t++) {
    const ang = rng.next() * Math.PI * 2;
    const d = Math.max(30, radiusKm * Math.sqrt(rng.next()));
    const cy = oy + (Math.sin(ang) * d) / KM_PER_CELL_Y;
    if (cy < 1 || cy > H - 2) continue;
    const cx = ox + (Math.cos(ang) * d) / kmPerCellX(cy);
    const x = wrapX(Math.floor(cx));
    const y = Math.floor(cy);
    const i = idx(x, y);
    if (planet.ocean[i] || planet.lake[i] || planet.elev[i] > 2.8 || planet.tempMean[i] < -6 || planet.freshDist[i] > 1) continue;
    const comp = boat ? w.landCompBoat[i] : w.landComp[i];
    if (comp !== fromComp) continue;
    // a camp needs enough living land around it to be worth the journey
    let rich = w.env.forageRate(i);
    for (let k = 0; k < 8; k++) { const n = NBR8[i * 8 + k]; if (n >= 0 && !planet.ocean[n]) rich += w.env.forageRate(n); }
    if (rich < 9 * 1.3) continue;
    let crowd = 0;
    let tooClose = false;
    for (const s of living) {
      const dk = distKm(s.x, s.y, x + 0.5, y + 0.5);
      if (dk < avoidKm) { tooClose = true; break; }
      if (dk < 130) crowd += 0.12 * (1 - dk / 130);
    }
    if (tooClose) continue;
    let score = w.env.fert[i] + w.env.veg[i] * 0.4 + (planet.coastDist[i] <= 1 ? 0.12 : 0) + (planet.river[i] ? 0.12 : 0)
      + (planet.res.stone[i] + planet.res.clay[i]) / 255 * 0.05 + (planet.res.iron[i] + planet.res.copper[i]) / 255 * 0.08
      - d / (radiusKm * 2.2) - crowd;
    const r = regionOfCell(x, y);
    score += Math.min(0.25, w.eco.gameBiomass(r) / 4000) - w.eco.predRisk[r] * 0.2;
    for (let k = 0; k < 8; k++) { const n = NBR8[i * 8 + k]; if (n >= 0 && planet.volcanic[n]) score -= 0.1; }
    if (!best || score > best.score) best = { x: x + 0.5, y: y + 0.5, score };
  }
  return best;
}

// -------- memory, trauma, relationships --------
export function traumatize(w: World, p: Person, kind: 'raid' | 'war' | 'famine' | 'disaster' | 'plague', other = 0) {
  const pe = p.personality;
  const k = kind === 'raid' || kind === 'war' ? 1 : 0.5;
  pe[P.fearfulness] = clamp(pe[P.fearfulness] + 0.07 * k);
  pe[P.aggression] = clamp(pe[P.aggression] + 0.04 * k * (pe[P.bravery] > 0.5 ? 1.5 : 0.5));
  if (kind === 'famine') pe[P.greed] = clamp(pe[P.greed] + 0.05);
  p.needs[ND.safety] = clamp(p.needs[ND.safety] + 0.3);
  void other; void w;
}

function relate(p: Person, o: Person, delta: number, kind?: 'friend' | 'rival' | 'acquaintance') {
  let r = p.relations.get(o.id);
  if (!r) {
    if (p.relations.size >= 30) {
      // forget the weakest acquaintances in one sweep (kin and partners are never forgotten)
      const ranked = [...p.relations].map(([id, rr]) => [id, Math.abs(rr.affinity) + (rr.kind === 'kin' || rr.kind === 'partner' ? 5 : 0)] as [number, number]).sort((x, y) => x[1] - y[1]);
      for (let i = 0; i < 10; i++) p.relations.delete(ranked[i][0]);
    }
    r = { affinity: 0, kind: kind ?? 'acquaintance' };
    p.relations.set(o.id, r);
  }
  r.affinity = clamp(r.affinity + delta, -1, 1);
  if (r.kind !== 'kin' && r.kind !== 'partner') r.kind = r.affinity > 0.35 ? 'friend' : r.affinity < -0.35 ? 'rival' : 'acquaintance';
}

function areKin(w: World, a: Person, b: Person): boolean {
  if (a.id === b.id) return true;
  if (a.mother && (a.mother === b.mother || a.mother === b.id)) return true;
  if (a.father && (a.father === b.father || a.father === b.id)) return true;
  if (b.mother === a.id || b.father === a.id) return true;
  // grandparent / grandchild
  for (const par of [a.mother, a.father]) {
    const pp = par ? w.people.get(par) : undefined;
    if (pp && (pp.mother === b.id || pp.father === b.id)) return true;
  }
  for (const par of [b.mother, b.father]) {
    const pp = par ? w.people.get(par) : undefined;
    if (pp && (pp.mother === a.id || pp.father === a.id)) return true;
  }
  return false;
}

// -------- occupations --------
export function assignOccupation(w: World, p: Person, s: Settlement | undefined) {
  if (['hermit', 'exile', 'raider', 'wanderer', 'cult founder', 'rebel', 'woodcutter', 'miner', 'builder', 'crafter', 'trader'].includes(p.occupation)) return; // flexible roles are balanced by the economy
  if (!s) { p.occupation = 'forager'; return; }
  const pe = p.personality;
  const sk = p.skills;
  const n = Math.max(1, s.pop);
  const occ = s.occupations;
  const share = (o: string) => (occ[o] ?? 0) / n;
  const cul = w.cultures.get(s.culture)!;
  const stressed = s.stress > 0.4;
  const scores: [Occupation, number][] = [];
  scores.push(['forager', 0.45 + 0.3 * sk[SK.foraging]]);
  scores.push(['hunter', (0.15 + 0.55 * (pe[P.bravery] * 0.5 + pe[P.aggression] * 0.3) + 0.5 * sk[SK.hunting]) * (hasTech(s, 'tools') ? 1.1 : 0.9)]);
  if (hasTech(s, 'agriculture')) scores.push(['farmer', 0.5 + 0.4 * pe[P.patience] + sk[SK.farming] * 0.8 + (stressed ? 0.2 : 0)]);
  if (!stressed) {
    if (hasTech(s, 'tools') && share('crafter') < 0.12) scores.push(['crafter', 0.15 + 0.6 * pe[P.creativity] + 0.4 * sk[SK.crafting]]);
    if (hasTech(s, 'tools') && share('builder') < 0.08 && s.pop > 20) scores.push(['builder', 0.1 + 0.4 * pe[P.patience] + 0.3 * sk[SK.building]]);
    if (share('healer') < 0.05 && s.pop > 25) scores.push(['healer', 0.1 + 0.6 * pe[P.empathy] + 0.3 * sk[SK.healing]]);
    if (share('warrior') < 0.12 && (cul.values[1] > 0.45 || s.threat > 0.3)) scores.push(['warrior', 0.1 + 0.5 * pe[P.aggression] + 0.4 * pe[P.bravery]]);
    if (share('explorer') < 0.05) scores.push(['explorer', 0.05 + 0.7 * pe[P.curiosity] * (0.5 + 0.5 * pe[P.bravery])]);
    if (share('priest') < 0.04 && cul.values[3] > 0.4 && s.pop > 30) scores.push(['priest', 0.1 + 0.6 * p.beliefs[3] * pe[P.sociability]]);
    if (share('scholar') < 0.04 && s.pop > 100 && hasTech(s, 'writing')) scores.push(['scholar', 0.1 + 0.8 * pe[P.intelligence]]);
  }
  let best: Occupation = 'forager';
  let bs = -1;
  for (const [o, sc] of scores) {
    const v = sc + w.rng.next() * 0.12;
    if (v > bs) { bs = v; best = o; }
  }
  if (p.occupation !== 'child' && occ[p.occupation]) occ[p.occupation]--;
  p.occupation = best;
  occ[best] = (occ[best] ?? 0) + 1;
}

// -------- the per-person tick --------
export function personStep(w: World, p: Person, dt: number) {
  const day = w.day;
  const rng = w.rng;
  const planet = w.planet;
  const age = p.ageYears(day);
  const s = p.home ? w.settlements[p.home - 1] : undefined;
  const live = s && s.abandoned < 0 ? s : undefined;
  p.px = p.x;
  p.py = p.y;
  const cell = cellOf(p);

  // ---- mortality (age, illness) ----
  let h = 0.006 + 0.00012 * Math.exp(0.095 * age) + (age < 5 ? 0.06 * (1 - age / 5) : 0);
  h *= 1.7 - p.health;
  if (live) {
    if (live.diseaseUntil > day) h += live.disease * 0.6;
    const healers = live.occupations['healer'] ?? 0;
    h *= 1 - 0.35 * Math.min(1, (healers * 25) / Math.max(1, live.pop));
  }
  if (rng.next() < 1 - Math.exp((-h * dt) / DAYS_PER_YEAR)) {
    w.die(p, age > 55 ? 'old age' : age < 5 ? 'childhood illness' : 'illness');
    return;
  }

  // ---- children are carried by their mothers ----
  const child = age < 12;
  if (child) {
    const m = p.mother ? w.people.get(p.mother) : undefined;
    if (m && m.alive && m.home === p.home) {
      p.x = m.x + (rng.next() - 0.5) * 0.1;
      p.y = m.y + (rng.next() - 0.5) * 0.1;
    } else if (live) {
      // orphans are looked after by their settlement
      const dx = wrapDx(p.x, live.x);
      p.x = wrapX(p.x + clamp(dx, -0.5, 0.5));
      p.y += clamp(live.y - p.y, -0.5, 0.5);
    }
  }

  // ---- needs ----
  const needs = p.needs;
  const needFood = dt * (child ? 0.55 : 1);
  let got = 0;
  const reach = live ? 6 + 0.45 * Math.sqrt(live.pop) + live.stress * 3.5 : 0; // workers return to the common store each day
  const nearHome = live ? child || (Math.abs(wrapDx(p.x, live.x)) < reach && Math.abs(p.y - live.y) < reach) : false;
  if (nearHome && live && live.food > 0) {
    got = Math.min(needFood * (w.ration.get(live.id) ?? 1), live.food);
    live.food -= got;
  }
  if (got < needFood && p.food > 0) {
    const t = Math.min(needFood - got, p.food);
    p.food -= t;
    got += t;
  }
  if (got < needFood * 0.9) {
    // when the common store runs short, everybody (children with their mothers) forages for themselves
    got += w.env.takeForage(cell, (needFood - got) * 1.3, day) / 1.3;
  }
  if (live) live.consumed += needFood;
  const fed = got / needFood;
  needs[ND.hunger] = clamp(needs[ND.hunger] + (1 - fed - needs[ND.hunger]) * (1 - Math.exp(-dt / 6)));
  // water: carried skins and pots let people work a few days from a river
  const fd = planet.freshDist[cell];
  const carry = hasTech(live, 'pottery') ? 0.09 : 0.14;
  if (fd <= 1 || child && live || (live && nearHome && planet.freshDist[idx(wrapX(Math.floor(live.x)), Math.floor(live.y))] <= 1)) needs[ND.thirst] = Math.max(0.05, needs[ND.thirst] - 0.5 * dt);
  else needs[ND.thirst] = Math.min(1, needs[ND.thirst] + Math.min(0.5, carry * dt));
  // cold / heat
  const T = planet.tempAt(cell, day);
  let warmth = 0;
  if (live) {
    if (hasTech(live, 'fire')) warmth += 6;
    if (hasTech(live, 'weaving')) warmth += 6;
    if (live.housing / Math.max(1, live.pop) > 0.4) warmth += 4;
  }
  const cold = clamp((6 - T - warmth) / 30);
  needs[ND.shelter] = cold;
  // predators
  const risk = w.eco.predRisk[regionOfCell(Math.floor(p.x) % W, clamp(Math.floor(p.y), 0, H - 1))];
  let hurt = 0;
  if (risk > 0.02 && rng.next() < risk * 0.0006 * dt * (hasTech(live, 'fire') ? 0.5 : 1) * (nearHome ? 0.5 : 1)) {
    hurt = 0.4 + rng.next() * 0.5;
    p.remember({ day, kind: 'disaster', text: 'Mauled by a beast', valence: -0.7, intensity: 0.7, x: p.x, y: p.y });
    p.personality[P.fearfulness] = clamp(p.personality[P.fearfulness] + 0.06);
  }
  needs[ND.safety] = clamp(needs[ND.safety] * Math.exp(-dt / 120) + risk * 0.1 + (live ? live.threat * 0.3 : 0.15));
  needs[ND.social] = clamp(needs[ND.social] + dt * 0.02 * (0.4 + p.personality[P.sociability]));
  needs[ND.belonging] = live ? Math.max(0, needs[ND.belonging] - dt * 0.05) : Math.min(1, needs[ND.belonging] + dt * 0.01);
  needs[ND.curiosity] = clamp(needs[ND.curiosity] + dt * 0.004 * (0.3 + p.personality[P.curiosity]));
  needs[ND.status] = clamp(needs[ND.status] + dt * 0.002 * p.personality[P.ambition] - p.status * 0.0005 * dt);

  // ---- health ----
  let dh = -hurt;
  const hungerWorry = needs[ND.hunger];
  if (hungerWorry > 0.8) dh -= 0.02 * dt * Math.min(1.5, (hungerWorry - 0.75) / 0.25);
  if (needs[ND.thirst] > 0.85) dh -= 0.05 * dt * ((needs[ND.thirst] - 0.8) / 0.2);
  if (cold > 0.5) dh -= 0.012 * dt * ((cold - 0.5) * 2);
  if (T > 40) dh -= 0.01 * dt;
  if (hungerWorry < 0.45 && needs[ND.thirst] < 0.5) dh += 0.01 * dt;
  p.health = clamp(p.health + dh);
  if (p.health <= 0) {
    const cause = hurt > 0 ? 'wounds from a beast' : needs[ND.thirst] > 0.85 ? 'thirst' : hungerWorry > 0.75 ? 'starvation' : cold > 0.5 ? 'exposure' : 'hardship';
    w.die(p, cause);
    return;
  }
  if (child) {
    // learning from parents
    for (const par of [p.mother, p.father]) {
      const pp = par ? w.people.get(par) : undefined;
      if (pp && pp.alive) for (let k = 0; k < NS; k++) p.skills[k] += (pp.skills[k] * 0.8 - p.skills[k]) * 0.0004 * dt * (0.5 + p.personality[P.intelligence]);
    }
    return;
  }
  if (p.occupation === 'child') {
    p.occupation = 'forager';
    assignOccupation(w, p, live);
  }

  // ---- reproduction ----
  if (p.sex === 1) {
    if (p.pregnantUntil >= 0 && day >= p.pregnantUntil) giveBirth(w, p, live);
    else if (p.partner && p.pregnantUntil < 0 && age >= 16 && age < 43 && p.health > 0.5 && needs[ND.hunger] < 0.5 && (!live || (live.stress < 0.35 && live.food > live.pop * 5))) {
      const base = (live && live.stage === 'camp' ? 450 : 520) / Math.max(0.3, 1 - (live ? live.stress : 0) * 1.6);
      if (rng.next() < 1 - Math.exp(-dt / base)) {
        const f = w.people.get(p.partner);
        if (f && f.alive) { p.pregnantUntil = day + 270; p.pregnancyFather = f.id; }
      }
    }
  }
  if (!p.partner && age >= 16 && age < 55 && live && rng.next() < Math.min(0.9, 0.012 * dt)) tryPair(w, p, live);

  // ---- social contact ----
  if (live && rng.next() < Math.min(0.9, 0.35 * dt * (0.3 + p.personality[P.sociability]))) {
    const res = w.residents.get(p.home);
    if (res && res.length > 1) {
      const o = res[rng.int(res.length)];
      if (o !== p && o.alive && Math.hypot(wrapDx(p.x, o.x), p.y - o.y) < 4) {
        let compat = 0;
        for (const k of [P.empathy, P.aggression, P.curiosity, P.patience, P.loyalty]) compat += 1 - Math.abs(p.personality[k] - o.personality[k]);
        compat /= 5;
        const bf = needs[ND.hunger] > 0.6 && o.food > 3 && rng.chance(0.3);
        relate(p, o, (compat - 0.55) * 0.15 + (bf ? 0.1 : 0));
        relate(o, p, (compat - 0.55) * 0.15);
        needs[ND.social] = Math.max(0, needs[ND.social] - 0.4);
        // minor cultural exchange of beliefs
        for (let k = 0; k < NV; k++) p.beliefs[k] += (o.beliefs[k] - p.beliefs[k]) * 0.01;
      }
    }
  }

  // ---- goals ----
  decideGoal(w, p, live, dt, cell, T);
  actOnGoal(w, p, live, dt, cell);

  // ---- skills & status ----
  if (p.occupation === 'forager') p.skills[SK.foraging] = Math.min(1, p.skills[SK.foraging] + dt * 0.0009 * (0.5 + p.personality[P.intelligence]));
}

function giveBirth(w: World, m: Person, s: Settlement | undefined) {
  const f = w.people.get(m.pregnancyFather);
  m.pregnantUntil = -1;
  if (w.rng.chance(0.012)) { w.die(m, 'childbirth'); return; }
  const c = w.newPerson({ x: m.x, y: m.y, home: m.home, culture: m.culture, species: m.species, mother: m, father: f && f.alive ? f : undefined });
  c.occupation = 'child';
  m.children.push(c.id);
  if (f) f.children.push(c.id);
  c.relations.set(m.id, { affinity: 0.9, kind: 'kin' });
  m.relations.set(c.id, { affinity: 0.9, kind: 'kin' });
  if (f) { c.relations.set(f.id, { affinity: 0.8, kind: 'kin' }); f.relations.set(c.id, { affinity: 0.9, kind: 'kin' }); }
  c.remember({ day: w.day, kind: 'born', text: `Born in ${s ? s.name : 'the wild'}`, valence: 0.3, intensity: 0.6, x: m.x, y: m.y });
  m.remember({ day: w.day, kind: 'birth of child', text: `Gave birth to ${c.name}`, valence: 0.8, intensity: 0.7, x: m.x, y: m.y, other: c.id });
  w.stats.births++;
  w.history.record('BIRTH', w.day, `${c.name} was born to ${m.name}${f ? ' and ' + f.name : ''}.`, 0, { persons: [c.id, m.id], settlement: m.home, x: m.x, y: m.y });
}

function tryPair(w: World, p: Person, s: Settlement) {
  const res = w.residents.get(p.home);
  if (!res) return;
  for (let t = 0; t < 6; t++) {
    const o = res[w.rng.int(res.length)];
    if (o === p || !o.alive || o.sex === p.sex || o.partner || o.ageYears(w.day) < 16) continue;
    if (areKin(w, p, o)) continue;
    const aff = (p.relations.get(o.id)?.affinity ?? 0) + 0.25;
    const attract = 0.35 + 0.4 * aff + 0.15 * (o.status + o.personality[P.sociability]);
    if (w.rng.next() < attract * 0.7) {
      p.partner = o.id; o.partner = p.id;
      p.relations.set(o.id, { affinity: Math.max(0.5, aff), kind: 'partner' });
      o.relations.set(p.id, { affinity: Math.max(0.5, aff), kind: 'partner' });
      const m = { day: w.day, kind: 'marriage' as const, valence: 0.8, intensity: 0.6, x: p.x, y: p.y };
      p.remember({ ...m, text: `Partnered with ${o.name}`, other: o.id });
      o.remember({ ...m, text: `Partnered with ${p.name}`, other: p.id });
      const big = s.leader === p.id || s.leader === o.id;
      w.history.record('MARRIAGE', w.day, `${p.name} and ${o.name} became partners in ${s.name}.`, big ? 1 : 0, { persons: [p.id, o.id], settlement: s.id });
      return;
    }
  }
}

function decideGoal(w: World, p: Person, s: Settlement | undefined, dt: number, cell: number, T: number) {
  const needs = p.needs;
  const pe = p.personality;
  const day = w.day;
  // thirst and hunger crises override everything, even a long march
  if (needs[ND.thirst] > 0.55 && w.planet.freshDist[cell] > 1) { p.goal = 'drink'; p.goalUntil = day + 1; return; }
  if (p.band || p.occupation === 'hermit') {
    if (needs[ND.hunger] > 0.8) { p.goal = 'eat'; p.goalUntil = day + 1; return; }
  }
  // bands override: migrating / outcast groups follow their leader's target
  if (p.band) {
    const b = w.bands.get(p.band);
    if (b) {
      const L = w.people.get(b.leader);
      if (!L || !L.alive) b.leader = p.id;
      p.goal = b.kind === 'army' ? 'attack' : b.kind === 'raiders' ? 'raid' : b.kind === 'migrants' ? 'migrate' : 'wander';
      return;
    }
    p.band = 0;
  }
  if (p.occupation === 'hermit') { p.goal = 'wander'; return; }
  // at fine time steps people keep a daily rhythm: they sleep at night (in their house when they have one)
  if (dt < 0.2 && s) {
    const lt = localTime(day, p.x);
    if (isNight(lt) && needs[ND.thirst] < 0.7 && needs[ND.hunger] < 0.85) {
      if (p.goal !== 'rest') { p.hasTarget = false; if (p.phase === 2) p.phase = 1; }
      p.goal = 'rest';
      p.goalUntil = day + 0.01;
      return;
    }
    if (p.goal === 'rest') { p.goal = 'work'; p.goalUntil = 0; p.hasTarget = false; }
  }
  if (p.goalUntil > day && p.goal !== 'work' && needs[ND.thirst] < 0.6 && needs[ND.hunger] < 0.7) return;
  // crisis first: thirst, then hunger
  if (needs[ND.thirst] > 0.55 && w.planet.freshDist[cell] > 1) { p.goal = 'drink'; p.goalUntil = day + 1; return; }
  if (needs[ND.hunger] > 0.75 && (!s || s.food <= 0.5)) { p.goal = 'eat'; p.goalUntil = day + 2; return; }
  // personality-weighted utilities
  const uExplore = needs[ND.curiosity] * (0.3 + 1.2 * pe[P.curiosity]) * (0.5 + 0.5 * pe[P.bravery]) * (1 - 0.8 * pe[P.fearfulness]) * (p.occupation === 'explorer' ? 3 : 0.6);
  const uSocial = needs[ND.social] * (0.3 + pe[P.sociability]) * 0.8;
  const uWork = 0.35 + 0.3 * pe[P.patience] + (s && s.stress > 0.3 ? 0.4 : 0) - 0.2 * pe[P.impulsiveness];
  const noise = (w.rng.next() - 0.5) * 0.3 * pe[P.impulsiveness];
  let best: Goal = 'work';
  let bu = uWork + noise;
  if (uExplore + noise > bu && needs[ND.hunger] < 0.5) { best = 'explore'; bu = uExplore + noise; }
  if (uSocial > bu) { best = 'socialize'; bu = uSocial; }
  if (best !== p.goal) { p.hasTarget = false; p.workCell = -1; }
  p.goal = best;
  p.goalUntil = day + (best === 'explore' ? 20 + w.rng.next() * 40 : best === 'work' ? 2 : 3);
  void T;
}

function actOnGoal(w: World, p: Person, s: Settlement | undefined, dt: number, cell: number) {
  const fine = dt < 0.2;
  const budget = fine ? WALK_KMH * 24 * dt : 28 * dt; // km this step
  const rng = w.rng;
  const planet = w.planet;
  const boat = hasTech(s, 'navigation');
  switch (p.goal) {
    case 'rest': {
      const hb = p.house ? w.buildings.get(p.house) : undefined;
      if (s) {
        const hx = hb ? hb.x : s.x, hy = hb ? hb.y : s.y;
        walk(w, p, hx, hy, budget, boat, 0.01);
      }
      break;
    }
    case 'drink': {
      let bi = -1; let bd = planet.freshDist[cell];
      for (let k = 0; k < 8; k++) { const n = NBR8[cell * 8 + k]; if (n >= 0 && planet.freshDist[n] < bd && !planet.ocean[n]) { bd = planet.freshDist[n]; bi = n; } }
      if (bi < 0 && s) { walk(w, p, s.x, s.y, budget, boat, 0.05); break; }
      if (bi >= 0) walk(w, p, (bi % W) + 0.5, Math.floor(bi / W) + 0.5, budget, boat);
      else p.goal = 'wander';
      break;
    }
    case 'eat': {
      if (s && s.food > 0.5) { walk(w, p, s.x, s.y, budget, boat, 0.05); break; }
      // go to the richest neighbouring cell
      let bi = cell; let bv = w.env.forageAvailable(cell, w.day);
      for (let k = 0; k < 8; k++) { const n = NBR8[cell * 8 + k]; if (n < 0 || planet.ocean[n]) continue; const v = w.env.forageAvailable(n, w.day) + 1; if (v > bv) { bv = v; bi = n; } }
      if (bi !== cell) walk(w, p, (bi % W) + 0.5, Math.floor(bi / W) + 0.5, budget, boat);
      break;
    }
    case 'socialize': {
      if (s) { const a = Math.abs(wrapDx(p.x, s.x)); if (a > 0.05) walk(w, p, s.x, s.y, budget, boat, 0.1); else { p.x = wrapX(p.x + (rng.next() - 0.5) * 0.0006 * Math.min(1, dt * 20)); } }
      break;
    }
    case 'explore': {
      if (!p.hasTarget) {
        const ang = rng.next() * Math.PI * 2;
        const d = 4 + rng.next() * (8 + (s ? s.knownKm / 40 : 0));
        p.tx = p.x + Math.cos(ang) * d;
        p.ty = clamp(p.y + Math.sin(ang) * d, 1, H - 2);
        p.hasTarget = true;
      }
      const arrived = walk(w, p, p.tx, p.ty, budget, boat, 2);
      if (s) {
        const dk = distKm(p.x, p.y, s.x, s.y);
        if (dk > s.knownKm) s.knownKm = dk + 15;
      }
      if (arrived || p.stuck > 3) {
        p.hasTarget = false; p.stuck = 0; p.needs[ND.curiosity] = 0.05; p.goal = 'work';
        p.skills[SK.exploring] = Math.min(1, p.skills[SK.exploring] + 0.02);
        const c = planet.ocean[cell] ? -1 : w.landComp[cell];
        if (c >= 0 && !w.discoveredComps.has(c)) {
          w.discoveredComps.add(c);
          w.history.record('DISCOVERY', w.day, `${p.name} reached a new land no one had walked before.`, 2, { persons: [p.id], x: p.x, y: p.y, cause: 'A curious explorer pushed beyond the known world.' });
          p.remember({ day: w.day, kind: 'discovery', text: 'First to reach a new land', valence: 0.9, intensity: 0.9, x: p.x, y: p.y });
          p.reputation = clamp(p.reputation + 0.3);
          p.status = clamp(p.status + 0.2);
        }
      }
      break;
    }
    case 'migrate':
    case 'wander':
    case 'attack':
    case 'raid': {
      const b = w.bands.get(p.band);
      if (p.occupation === 'hermit' || !b) { wanderAbout(w, p, budget); break; }
      const tx = b.tx; const ty = b.ty;
      const arrived = walk(w, p, tx, ty, budget, boat || hasTech(w.settlements[b.from - 1], 'navigation'), 1.5);
      // travellers carry a ration and forage on the way
      if (p.food < 1) p.food += w.env.takeForage(cell, 1.2 * dt, w.day) * 0.6;
      if (p.id === b.leader) {
        b.stuck = p.stuck;
        if (arrived) w.bandArrived(b);
        else if (p.stuck > 6) w.bandStuck(b);
      }
      break;
    }
    default: {
      work(w, p, s, dt, cell, budget, boat);
    }
  }
}

function wanderAbout(w: World, p: Person, budget: number) {
  if (!p.hasTarget || p.stuck > 3) {
    const ang = w.rng.next() * Math.PI * 2;
    const d = 3 + w.rng.next() * 8;
    p.tx = p.x + Math.cos(ang) * d;
    p.ty = clamp(p.y + Math.sin(ang) * d, 1, H - 2);
    p.hasTarget = true; p.stuck = 0;
  }
  if (walk(w, p, p.tx, p.ty, budget, false, 1)) p.hasTarget = false;
  // hermits and wanderers live off the land
  const cell = cellOf(p);
  const got = w.env.takeForage(cell, 1.2, w.day);
  if (p.food < 3) p.food += got * 0.5;
}

const JOB_ROLES = new Set<string>(['forager', 'hunter', 'farmer', 'woodcutter', 'miner', 'builder', 'crafter', 'trader', 'explorer']);

function work(w: World, p: Person, s: Settlement | undefined, dt: number, cell: number, budget: number, boat: boolean) {
  const planet = w.planet;
  const rng = w.rng;
  if (!s) { wanderAbout(w, p, budget); return; }
  const fine = dt < 0.2;
  if (kmTo(p, s.x, s.y) > 160) { walk(w, p, s.x, s.y, budget, boat, 0.2); return; }
  const occ = p.occupation;
  if (JOB_ROLES.has(occ) && runJob(w, p, s, dt, fine)) return;
  const sk = p.skills;
  // work done by hand-picked wild foods when there is no specific job to do
  const dayScale = fine ? 1.75 : 1;
  const mult = (0.7 + 0.8 * sk[SK.foraging]) * (s.toolTier >= 1 ? 1.25 : 1);
  const radius = 1.2 + s.stress * 3.5 + (s.stage === 'camp' ? 0 : 0.8);
  const forage = () => {
    if (p.workCell < 0 || w.env.forageAvailable(p.workCell, w.day) < 0.5 || rng.chance(0.05 * Math.min(dt, 5))) {
      let bi = -1; let bv = -1;
      for (let t = 0; t < 5; t++) {
        const a = rng.next() * Math.PI * 2;
        const r = rng.next() * radius;
        const x = wrapX(Math.floor(s.x + Math.cos(a) * r));
        const y = Math.floor(clamp(s.y + Math.sin(a) * r, 0, H - 1));
        const i = idx(x, y);
        if (planet.ocean[i]) continue;
        const v = w.env.forageAvailable(i, w.day);
        if (v > bv) { bv = v; bi = i; }
      }
      p.workCell = bi;
    }
    if (p.workCell < 0) return;
    const tx = (p.workCell % W) + 0.5; const ty = Math.floor(p.workCell / W) + 0.5;
    const arrived = walk(w, p, tx, ty, budget, boat, 6) ;
    const frac = arrived ? 0.85 : 0.2;
    const got = w.env.takeForage(p.workCell, 2.6 * mult * dt * frac * dayScale, w.day);
    s.food += got;
    s.produced += got;
  };
  switch (occ) {
    case 'forager': case 'hunter': case 'farmer': case 'woodcutter': case 'miner': case 'builder': case 'crafter': case 'trader': case 'explorer':
      forage();
      break;
    case 'healer': sk[SK.healing] = Math.min(1, sk[SK.healing] + dt * 0.001); idleAround(w, p, s, budget); supplemental(w, p, s, dt * dayScale, 0.7); break;
    case 'leader': sk[SK.leading] = Math.min(1, sk[SK.leading] + dt * 0.001); s.cohesion = clamp(s.cohesion + dt * 0.0005); idleAround(w, p, s, budget); supplemental(w, p, s, dt * dayScale, 0.7); break;
    case 'priest': s.cohesion = clamp(s.cohesion + dt * 0.0004); idleAround(w, p, s, budget); supplemental(w, p, s, dt * dayScale, 0.7); break;
    case 'warrior': s.defense += dt * 0.00002; idleAround(w, p, s, budget); supplemental(w, p, s, dt * dayScale, 0.8); break;
    case 'scholar': idleAround(w, p, s, budget); supplemental(w, p, s, dt * dayScale, 0.5); break;
    default: idleAround(w, p, s, budget); supplemental(w, p, s, dt * dayScale, 1);
  }
}

/** Specialists still gather a little themselves. */
function supplemental(w: World, p: Person, s: Settlement, dt: number, frac: number) {
  const cell = cellOf(p);
  const got = w.env.takeForage(cell, 1.4 * dt * frac, w.day);
  s.food += got;
  s.produced += got;
}

function idleAround(w: World, p: Person, s: Settlement, budget: number) {
  // people loiter within the built-up area, a few hundred metres to a couple of km
  const Rkm = 0.08 + 0.02 * Math.sqrt(s.pop);
  if (!p.hasTarget || kmTo(p, s.x, s.y) > Rkm * 2.5) {
    const a = w.rng.next() * Math.PI * 2;
    const r = Math.sqrt(w.rng.next()) * Rkm;
    p.tx = s.x + (Math.cos(a) * r) / kmPerCellX(s.y);
    p.ty = clamp(s.y + (Math.sin(a) * r) / KM_PER_CELL_Y, 0, H - 1);
    p.hasTarget = true;
  }
  if (walk(w, p, p.tx, p.ty, Math.min(budget, 1.5), false, 0.02)) p.hasTarget = false;
}
