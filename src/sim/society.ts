import type { World } from './world';
import { clamp, lerp } from './rng';
import { H, W, distKm, idx, wrapDx, wrapX } from './grid';
import { ANY_COMP, Band, CIV_RADIUS_KM, FOREIGN_GAP_KM, assignOccupation, cellOf, findSite, traumatize } from './behavior';
import { ND, P, Person, SK } from './people';
import { Civ, Government, Settlement, stageFor } from './settlements';
import { TECHS, TECH_IDS, TechId } from './technology';
import { DAYS_PER_SEASON, DAYS_PER_YEAR, seasonOf, yearOf } from './time';
import { NV, VALUE_KEYS } from './culture';
import { economySeason } from './economy';
import { wallFactor } from './diplomacy';
import { RES_KEYS } from './buildings';
import { contactRange, governRange, innovationMult, oceanGoing, yieldMult } from './techfx';

const TECH_RATE = 0.35;
const has = (s: Settlement, t: string) => (s.tech as Set<string>).has(t);
const stageRank = { camp: 0, settlement: 1, village: 2, town: 3, city: 4 } as const;

export function leaderScore(p: Person): number {
  return p.skills[SK.leading] * 0.3 + p.personality[P.ambition] * 0.2 + p.status * 0.3 + p.personality[P.sociability] * 0.1 + p.personality[P.intelligence] * 0.1 + p.reputation * 0.1;
}

function adultsOf(w: World, sid: number): Person[] {
  const res = w.residents.get(sid) ?? [];
  return res.filter((p) => p.alive && p.ageYears(w.day) >= 15 && !p.band);
}

/** Capacity used to decide when a community outgrows its land. */
function capacity(w: World, s: Settlement): number {
  const cx = Math.floor(s.x);
  const cy = Math.floor(s.y);
  const r = has(s, 'agriculture') ? 4 : 2;
  let tot = 0;
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const y = cy + dy;
    if (y < 0 || y >= H) continue;
    const i = idx(wrapX(cx + dx), y);
    if (w.planet.ocean[i]) { tot += 0.3; continue; }
    const fertile = w.env.fert[i] * (0.4 + w.planet.baseVeg[i]);
    tot += has(s, 'agriculture') ? 15 * fertile + 1.5 : 3.2 * fertile;
  }
  // better farming (calendars, fertilisers, machines) lets the same land feed more people
  return tot * (has(s, 'mathematics') ? 1.15 : 1) * (has(s, 'engineering') ? 1.3 : 1) * yieldMult(s) * (has(s, 'medicine') ? 1.1 : 1);
}

// ============================ settlement season ============================
export function settlementSeason(w: World) {
  const day = w.day;
  const rng = w.rng;
  const living = w.activeSettlements();
  // index residents (people keep moving; index is rebuilt each tick, but season may run first)
  w.residents.clear();
  const hungerSum = new Map<number, number>();
  for (const s of living) { s.pop = 0; s.occupations = {}; }
  for (const p of w.alive) {
    if (!p.alive) continue;
    const l = w.residents.get(p.home);
    if (l) l.push(p); else w.residents.set(p.home, [p]);
    const s = p.home ? w.settlements[p.home - 1] : undefined;
    if (!s || s.abandoned >= 0) continue;
    s.pop++;
    if (p.occupation !== 'child') s.occupations[p.occupation] = (s.occupations[p.occupation] ?? 0) + 1;
    hungerSum.set(s.id, (hungerSum.get(s.id) ?? 0) + p.needs[ND.hunger]);
  }
  const newYear = seasonOf(day) === 0;
  for (const s of living) {
    s.peak = Math.max(s.peak, s.pop);
    if (s.pop === 0) {
      s.abandoned = day;
      w.history.record('GROWTH', day, `${s.name} was abandoned.`, s.peak > 25 ? 1 : 0, { settlement: s.id, civ: s.civ, x: s.x, y: s.y, cause: 'Its last inhabitants died or left.' });
      continue;
    }
    // --- food stress & spoilage
    const avgHunger = (hungerSum.get(s.id) ?? 0) / s.pop;
    const cover = s.food / Math.max(1, s.pop);
    const target = clamp(avgHunger * 1.8 + (cover < 5 ? 0.25 : 0));
    s.stress = lerp(s.stress, target, 0.6);
    s.stressSeasons = s.stress > 0.45 ? s.stressSeasons + 1 : Math.max(0, s.stressSeasons - 1);
    s.surplus = (s.produced - s.consumed) / Math.max(1, s.consumed);
    s.produced = 0;
    s.consumed = 0;
    s.food = Math.min(s.pop * 40, s.food * Math.exp(-(has(s, 'pottery') ? 0.003 : 0.006) * DAYS_PER_SEASON));
    // stored timber slowly rots, and a town keeps only what it has room and hands for: the excess is used, traded or lost
    s.res.wood *= Math.exp(-0.0004 * DAYS_PER_SEASON);
    const room = 400 + s.pop * 40;
    for (const k of RES_KEYS) if (s.res[k] > room) s.res[k] = room + (s.res[k] - room) * 0.5;
    s.threat = Math.max(0, s.threat - 0.05);
    s.defense = Math.max(0, s.defense * 0.98);
    s.yearsSettled += 0.25;
    caveLife(w, s);
    // famine event
    if (s.stress > 0.7 && s.pop >= 12 && day - (w.famineAt.get(s.id) ?? -1e9) > 4 * DAYS_PER_YEAR) {
      w.famineAt.set(s.id, day);
      const reg = Math.floor(Math.floor(s.y) / 4) * 64 + Math.floor(Math.floor(s.x) / 4);
      const drought = w.env.anomaly[reg] < 0.7;
      const cause = drought ? 'Failed rains left crops and game scarce.' : 'The land around could no longer feed its people.';
      w.history.record('FAMINE', day, `Famine struck ${s.name}.`, s.pop > 40 ? 2 : 1, { settlement: s.id, civ: s.civ, x: s.x, y: s.y, cause });
      for (const p of adultsOf(w, s.id)) {
        p.remember({ day, kind: 'famine', text: `Starved through the famine at ${s.name}`, valence: -0.8, intensity: 0.8, x: s.x, y: s.y });
        traumatize(w, p, 'famine');
      }
    }
    // --- stage
    const stage = stageFor(s.pop, s.nomadic);
    if (stage !== s.stage) {
      const up = stageRank[stage] > stageRank[s.stage];
      s.stage = stage;
      if (up && stageRank[stage] >= 2) {
        w.history.record('GROWTH', day, `${s.name} grew into a ${stage}.`, stageRank[stage] >= 3 ? 2 : 1, { settlement: s.id, civ: s.civ, x: s.x, y: s.y, cause: `Its population reached ${s.pop}.` });
      }
    }
    // --- permanence
    if (s.nomadic && has(s, 'agriculture') && s.pop >= 18 && s.yearsSettled > 3) {
      s.nomadic = false;
      s.permanent = true;
      const first = !w.firstPermanent;
      w.firstPermanent = true;
      w.history.record('FOUNDING', day, first ? `The first permanent settlement was founded: ${s.name}.` : `${s.name} became a permanent settlement.`, first ? 3 : 1, {
        settlement: s.id, civ: s.civ, x: s.x, y: s.y, cause: 'Farming tied the community to its fields.',
      });
    }
    // --- leader
    ensureLeader(w, s);
    // --- housing grows with population (tents & huts), disease
    disease(w, s);
    // --- yearly reassignment of work
    if (newYear || s.pop < 30) for (const p of adultsOf(w, s.id)) {
      if (p.id === s.leader) { p.occupation = 'leader'; continue; }
      if (newYear || p.occupation === 'child') assignOccupation(w, p, s);
    }
    // --- status
    for (const p of adultsOf(w, s.id)) {
      const mx = Math.max(...p.skills);
      const target = clamp(0.2 * mx + 0.25 * p.reputation + (p.id === s.leader ? 0.3 : 0) + Math.min(0.15, p.children.length * 0.03) + (p.occupation === 'priest' || p.occupation === 'scholar' ? 0.1 : 0));
      p.status = lerp(p.status, target, 0.25);
    }
  }
  for (const b of [...w.bands.values()]) {
    const alive = b.members.filter((id) => w.people.get(id)?.alive);
    if (!alive.length) { w.bands.delete(b.id); continue; }
    if (b.kind !== 'raiders' && w.day - b.created > 4 * DAYS_PER_YEAR) { b.created = w.day; bandStuck(w, b); }
  }
  const alive = w.activeSettlements();
  for (const s of alive) economySeason(w, s);
  for (const s of alive) techSeason(w, s);
  diffuse(w, alive);
  for (const s of alive) { cultureDrift(w, s, alive); nomadMove(w, s); migrationCheck(w, s); aidNeighbours(w, s, alive); }
  void rng;
}

function ensureLeader(w: World, s: Settlement) {
  const cur = s.leader ? w.people.get(s.leader) : undefined;
  if (cur && cur.alive && cur.home === s.id) return;
  const adults = adultsOf(w, s.id);
  if (!adults.length) { s.leader = 0; return; }
  let best = adults[0];
  let bs = -1;
  for (const p of adults) { const sc = leaderScore(p) + w.rng.next() * 0.05; if (sc > bs) { bs = sc; best = p; } }
  s.leader = best.id;
  if (best.occupation !== 'leader') best.occupation = 'leader';
  best.remember({ day: w.day, kind: 'leader', text: `Chosen to lead ${s.name}`, valence: 0.6, intensity: 0.7, x: s.x, y: s.y });
  best.status = clamp(best.status + 0.2);
}

function disease(w: World, s: Settlement) {
  const day = w.day;
  if (s.diseaseUntil > day) return;
  s.disease = 0;
  const housing = 20 + s.housing + (has(s, 'architecture') ? 40 : 0);
  const crowding = s.pop / housing;
  const p = Math.min(0.09, 0.004 * Math.pow(s.pop / 50, 1.4) * (has(s, 'fire') ? 0.7 : 1) * (0.6 + crowding * 0.4));
  if (s.pop >= 15 && day - (w.diseaseAt.get(s.id) ?? -1e9) > 3 * DAYS_PER_YEAR && w.rng.next() < p) {
    w.diseaseAt.set(s.id, day);
    s.disease = 0.25 + w.rng.next() * 0.5;
    s.diseaseUntil = day + 60 + w.rng.next() * 90;
    const big = s.pop > 60;
    w.history.record('DISEASE', day, `A sickness swept through ${s.name}.`, s.pop > 150 ? 2 : 1, { settlement: s.id, civ: s.civ, x: s.x, y: s.y, cause: `Crowding (${s.pop} people) let an infection spread.` });
    for (const p2 of adultsOf(w, s.id)) if (w.rng.chance(0.25)) { p2.remember({ day, kind: 'plague', text: `Survived the sickness at ${s.name}`, valence: -0.6, intensity: 0.6, x: s.x, y: s.y }); traumatize(w, p2, 'plague'); }
    // trade contacts carry disease onward
    for (const o of w.activeSettlements()) {
      if (o === s || o.diseaseUntil > day) continue;
      const d = distKm(s.x, s.y, o.x, o.y);
      if (d < 180 && w.rng.chance(0.35 * (1 - d / 180))) { o.disease = s.disease * 0.8; o.diseaseUntil = day + 80; w.history.record('DISEASE', day, `The sickness spread from ${s.name} to ${o.name}.`, 1, { settlement: o.id, x: o.x, y: o.y, cause: 'Travellers between neighbouring settlements carried the illness.' }); }
    }
  }
}

// ---------------- technology ----------------
function techSeason(w: World, s: Settlement) {
  const adults = adultsOf(w, s.id);
  if (adults.length < 3) return;
  const cul = w.cultures.get(s.culture)!;
  // local resources within reach
  const cx = Math.floor(s.x);
  const cy = Math.floor(s.y);
  const res = { stone: 0, clay: 0, copper: 0, iron: 0, coal: 0, coast: 0, fert: 0, wood: 0 };
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const y = cy + dy;
    if (y < 0 || y >= H) continue;
    const i = idx(wrapX(cx + dx), y);
    if (w.planet.ocean[i]) { res.coast = 1; continue; }
    res.stone = Math.max(res.stone, w.planet.res.stone[i] / 255);
    res.clay = Math.max(res.clay, w.planet.res.clay[i] / 255);
    res.copper = Math.max(res.copper, w.planet.res.copper[i] / 255);
    res.iron = Math.max(res.iron, w.planet.res.iron[i] / 255);
    res.coal = Math.max(res.coal, w.planet.res.coal[i] / 255);
    res.fert = Math.max(res.fert, w.env.fert[i]);
    res.wood = Math.max(res.wood, w.env.veg[i]);
  }
  let innov = 0;
  let scholars = 0;
  for (const p of adults) {
    const v = p.personality[P.creativity] * 0.6 + p.personality[P.curiosity] * 0.2 + p.personality[P.intelligence] * 0.2;
    innov += v * v;
    if (p.occupation === 'scholar') scholars++;
  }
  innov *= (1 + scholars * 1.5) * (0.6 + 0.8 * cul.values[0]) * (has(s, 'writing') ? 1.3 : 1) * innovationMult(s);
  const civPop = w.civs[s.civ - 1]?.pop ?? s.pop;
  for (const id of TECH_IDS) {
    if (s.tech.has(id)) continue;
    const t = TECHS[id];
    // an idea needs a big enough town, or a people large enough to keep it alive between its villages
    if ((s.pop < t.minPop && (s.pop < t.minPop * 0.35 || civPop < t.minPop * 2.5)) || (t.civPop && civPop < t.civPop)) continue;
    if (!t.prereq.every((q) => s.tech.has(q))) continue;
    let ok = true;
    if (t.needs) for (const k of Object.keys(t.needs) as (keyof typeof res)[]) if (res[k] < (t.needs[k] ?? 0)) ok = false;
    if (!ok) continue;
    let pressure = 1;
    if (id === 'agriculture') pressure += 2 * s.stress + (s.nomadic ? 0 : 0.5);
    if (id === 'metallurgy') pressure += s.goods / Math.max(10, s.pop);
    if (id === 'navigation') pressure += 0.5;
    const rate = (TECH_RATE * Math.sqrt(innov) * pressure) / t.difficulty; // per year
    if (w.rng.next() < 1 - Math.exp(-rate / 4)) discover(w, s, id as TechId, adults);
  }
}

function discover(w: World, s: Settlement, id: TechId, adults: Person[]) {
  const def = TECHS[id];
  let best = adults[0];
  let bs = -1;
  for (const p of adults) {
    const sc = p.personality[P.creativity] * 0.6 + p.personality[P.curiosity] * 0.2 + p.personality[P.intelligence] * 0.2 + w.rng.next() * 0.25;
    if (sc > bs) { bs = sc; best = p; }
  }
  s.tech.add(id);
  const cul = w.cultures.get(s.culture)!;
  const civ = w.civs[s.civ - 1];
  const everBefore = w.settlements.some((o) => o !== s && o.tech.has(id));
  best.remember({ day: w.day, kind: 'discovery', text: `Discovered ${def.name.toLowerCase()}`, valence: 0.9, intensity: 0.95, x: s.x, y: s.y });
  best.reputation = clamp(best.reputation + 0.4);
  best.status = clamp(best.status + 0.25);
  if (!everBefore && def.difficulty >= 100) best.legend = true;
  const text = `${best.name} of the ${cul.name} civilization has discovered ${def.description}.`;
  w.history.record('TECHNOLOGY_DISCOVERY', w.day, text + '\n' + def.impact.join('\n'), everBefore ? 1 : 3, {
    persons: [best.id], settlement: s.id, civ: civ?.id, culture: s.culture, x: s.x, y: s.y,
    cause: `A settlement of ${s.pop} people with ${Object.keys(def.needs ?? {}).length ? 'suitable local resources' : 'enough curiosity'} and prerequisites (${def.prereq.join(', ') || 'none'}) made the idea possible.`,
  });
  if (id === 'writing' || id === 'mathematics' || id === 'engineering') {
    const lang = w.langs.get(cul.language);
    if (lang) lang.writing = id === 'writing' ? 'pictographic' : id === 'mathematics' ? 'syllabic' : 'alphabetic';
  }
}

function diffuse(w: World, living: Settlement[]) {
  const n = living.length;
  if (n < 2) return;
  const step = n > 300 ? 3 : 1;
  for (let a = 0; a < n; a += 1) {
    const A = living[a];
    for (let b = a + 1; b < n; b += step) {
      const B = living[b];
      const d = distKm(A.x, A.y, B.x, B.y);
      // ideas travel as far as the better-connected of the two can reach; within one polity they always circulate
      const range = A.civ === B.civ ? Math.max(400, contactRange(A), contactRange(B)) : Math.max(contactRange(A), contactRange(B));
      if (d > range) continue;
      const cA = w.cultures.get(A.culture)!;
      const cB = w.cultures.get(B.culture)!;
      const contact = (1 - d / range) * (0.5 + 0.25 * (cA.values[5] + cB.values[5])) * (A.culture === B.culture ? 1 : 0.55) * (A.civ === B.civ ? 2 : 1)
        * (w.tradePairs.has(A.id < B.id ? `${A.id}:${B.id}` : `${B.id}:${A.id}`) ? 1.8 : 1);
      for (const [from, to, tc] of [[A, B, cB], [B, A, cA]] as [Settlement, Settlement, typeof cA][]) {
        for (const id of from.tech) {
          if (to.tech.has(id)) continue;
          const def = TECHS[id];
          if (!def.prereq.every((q) => to.tech.has(q)) || to.pop < def.minPop * 0.5) continue;
          const p = 1 - Math.exp(-0.18 * contact * (0.3 + tc.values[0]));
          if (w.rng.next() < p) {
            to.tech.add(id);
            if (def.id === 'agriculture' && to.nomadic) to.yearsSettled = Math.max(to.yearsSettled, 1);
            w.history.record('TRADE', w.day, `${to.name} learned ${def.name.toLowerCase()} from ${from.name}.`, def.difficulty > 100 ? 1 : 0, {
              settlement: to.id, civ: to.civ, x: to.x, y: to.y, cause: `Contact between neighbouring settlements (${Math.round(d)} km apart).`,
            });
          }
        }
      }
    }
  }
}

// ---------------- culture & language drift ----------------
function cultureDrift(w: World, s: Settlement, living: Settlement[]) {
  const cul = w.cultures.get(s.culture)!;
  let contacts = 0;
  for (const o of living) {
    if (o === s || o.culture !== s.culture) continue;
    const d = distKm(s.x, s.y, o.x, o.y);
    if (d < 250) contacts += 1 - d / 250;
  }
  const contact = Math.min(1, contacts / 1.5);
  s.drift += (1 / (140 * 4)) * (1 - 0.92 * contact) * (s.pop < 8 ? 0.3 : 1);
  s.langDrift += (1 / (320 * 4)) * (1 - 0.9 * contact);
  if (s.drift >= 1) {
    // all close, equally-drifted neighbours share the new culture
    const kin = living.filter((o) => o.culture === s.culture && o.drift > 0.55 && distKm(s.x, s.y, o.x, o.y) < 250);
    const lang = w.langs.get(cul.language)!;
    const leader = s.leader ? w.people.get(s.leader) : undefined;
    const child = w.cultures.create(w.rng, w.day, cul.language, lang.phonology, cul, `Diverged from the ${cul.name} after long separation around ${s.name}.`, leader?.beliefs);
    for (const o of kin) { o.culture = child.id; o.drift = 0; }
    s.culture = child.id;
    s.drift = 0;
    for (const p of w.alive) if (p.alive && kin.some((k) => k.id === p.home)) p.culture = child.id;
    w.history.record('CULTURAL_SPLIT', w.day, `The ${child.name} culture diverged from the ${cul.name}.`, 2, {
      settlement: s.id, civ: s.civ, culture: child.id, x: s.x, y: s.y, cause: `${kin.length} isolated settlement${kin.length > 1 ? 's' : ''} developed their own customs after generations with little contact.`,
    });
  }
  if (s.langDrift >= 1) {
    const kin = living.filter((o) => o.culture === s.culture || (w.cultures.get(o.culture)?.language === cul.language && distKm(s.x, s.y, o.x, o.y) < 250));
    const lang = w.langs.get(cul.language)!;
    const child = w.langs.create(w.rng, w.day, lang);
    // a language split always travels with a culture
    const c2 = w.cultures.get(s.culture)!;
    c2.language = child.id;
    child.name = c2.name;
    for (const o of kin) { o.langDrift = 0; const oc = w.cultures.get(o.culture); if (oc && o.culture === s.culture) oc.language = child.id; }
    s.langDrift = 0;
    w.history.record('LANGUAGE_SPLIT', w.day, `The ${child.name} language split from ${lang.name} (${child.shifts.slice(-3).join(', ')}).`, 2, {
      settlement: s.id, culture: s.culture, x: s.x, y: s.y, cause: 'Sound changes accumulated while speech communities stayed apart.',
    });
  }
  const lang = w.langs.get(cul.language);
  if (lang) lang.vocabulary = Math.max(lang.vocabulary, 150 + s.tech.size * 220 + s.pop * 2);
}

// ---------------- nomadic bands move on when local forage is depleted ----------------
function nomadMove(w: World, s: Settlement) {
  if (!s.nomadic || s.pop < 5) return;
  const cx = Math.floor(s.x);
  const cy = Math.floor(s.y);
  let here = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const y = cy + dy;
    if (y < 0 || y >= H) continue;
    const i = idx(wrapX(cx + dx), y);
    if (!w.planet.ocean[i]) here += w.env.forageAvailable(i, w.day) / Math.max(0.1, w.env.forageRate(i) * 12);
  }
  const comfort = here / 9;
  if (comfort > 0.35 && s.stress < 0.4) return;
  if (w.rng.next() > 0.5) return;
  // look nearby for a better camp
  const site = findSite(w, s.x, s.y, 120, has(s, 'navigation'), oceanGoing(s) ? ANY_COMP : w.landComp[idx(cx, cy)], s.culture, 18, s.civ);
  if (!site) return;
  const here0 = w.env.fert[idx(cx, cy)] + w.env.veg[idx(cx, cy)] * 0.4;
  if (site.score < here0 - 0.1) return;
  s.x = site.x;
  s.y = site.y;
  s.yearsSettled = 0;
}

// ---------------- migration ----------------
function migrationCheck(w: World, s: Settlement) {
  if (s.pop < 14) return;
  const cap = capacity(w, s);
  const over = s.pop > cap * 1.35;
  const nomadSplit = s.nomadic && s.pop > 70;
  if (!((s.stressSeasons >= 2 && s.stress > 0.45) || over || nomadSplit)) return;
  if (w.day - (w.lastMigration.get(s.id) ?? -1e9) < 1.5 * DAYS_PER_YEAR) return;
  w.lastMigration.set(s.id, w.day);
  startMigration(w, s, over ? 'the land could no longer support its numbers' : nomadSplit ? 'the band grew too large to move together' : 'repeated food shortage');
}

export function startMigration(w: World, s: Settlement, reason: string) {
  const adults = adultsOf(w, s.id);
  if (adults.length < 4) return;
  const rng = w.rng;
  // seed the group: restless, curious or disloyal people go first
  const weight = (p: Person) => 0.2 + (1 - p.personality[P.loyalty]) + p.personality[P.curiosity] + p.personality[P.impulsiveness] + (p.relations.size < 3 ? 0.3 : 0);
  let tot = 0;
  for (const p of adults) tot += weight(p);
  let r = rng.next() * tot;
  let seed = adults[0];
  for (const p of adults) { r -= weight(p); if (r <= 0) { seed = p; break; } }
  const ageAdults = adults.filter((p) => p.id !== s.leader);
  const targetSize = Math.round(clamp(s.pop * (0.22 + 0.2 * s.stress), 5, 45));
  const group = new Set<Person>([seed]);
  const addWithFamily = (p: Person) => {
    group.add(p);
    const pt = p.partner ? w.people.get(p.partner) : undefined;
    if (pt && pt.alive && !pt.band) group.add(pt);
    for (const cid of p.children) {
      const c = w.people.get(cid);
      if (c && c.alive && c.home === s.id && c.ageYears(w.day) < 12 && !c.band) group.add(c);
    }
  };
  addWithFamily(seed);
  const pool = ageAdults.filter((p) => p !== seed && !p.band && p.id !== s.leader);
  // friends and kin first
  pool.sort((a, b) => (seed.relations.get(b.id)?.affinity ?? 0) - (seed.relations.get(a.id)?.affinity ?? 0) + (rng.next() - 0.5) * 0.4);
  for (const p of pool) {
    if (group.size >= targetSize) break;
    if (group.has(p)) continue;
    if (rng.next() < 0.75) addWithFamily(p);
  }
  const radius = clamp(s.knownKm * (1 + s.stress * 0.4), 70, 650);
  const comp = w.landComp[cellOf(seed)];
  const reachComp = oceanGoing(s) ? ANY_COMP : has(s, 'navigation') ? w.landCompBoat[cellOf(seed)] : comp;
  // first look for room close to home among their own people; if the homeland is full, strike out for empty lands
  let site = findSite(w, s.x, s.y, Math.min(radius, CIV_RADIUS_KM), has(s, 'navigation'), reachComp, s.culture, 30, s.civ);
  if (!site) site = findSite(w, s.x, s.y, Math.max(radius * 1.6, 350), has(s, 'navigation'), reachComp, s.culture, 40, 0);
  if (!site) return;
  const members = [...group];
  const band: Band = {
    id: w.nextBand++, kind: 'migrants', leader: seed.id, tx: site.x, ty: site.y, from: s.id, culture: s.culture, civ: s.civ, tech: new Set(s.tech),
    note: reason, created: w.day, members: members.map((m) => m.id), stuck: 0, lastRaid: -1e9,
  };
  w.bands.set(band.id, band);
  const ration = Math.min(14, s.food / Math.max(1, members.length) * 0.6);
  for (const m of members) {
    m.band = band.id;
    m.food += ration;
    s.food -= ration;
    m.hasTarget = false;
    m.stuck = 0;
    if (m.occupation === 'leader') m.occupation = 'forager';
  }
  const dk = distKm(s.x, s.y, site.x, site.y);
  w.history.record('MIGRATION', w.day, `${seed.name} led ${members.length} people from ${s.name} ${Math.round(dk)} km toward new lands.`, dk > 400 ? 2 : 1, {
    persons: [seed.id], settlement: s.id, civ: s.civ, x: s.x, y: s.y, cause: `Departure caused by: ${reason}.`,
  });
  for (const m of members) if (m.ageYears(w.day) >= 12) m.remember({ day: w.day, kind: 'migration', text: `Left ${s.name} after ${reason}`, valence: -0.2, intensity: 0.6, x: s.x, y: s.y });
}

export function bandStuck(w: World, b: Band) {
  const leader = w.people.get(b.leader);
  if (!leader || !leader.alive) return;
  const from = w.settlements[b.from - 1];
  const site = findSite(w, leader.x, leader.y, 260, has(from ?? ({ tech: new Set() } as unknown as Settlement), 'navigation'), w.landComp[cellOf(leader)], b.culture, 30, b.kind === 'migrants' ? b.civ : 0);
  leader.stuck = 0;
  if (site && !b.returning) { b.tx = site.x; b.ty = site.y; return; }
  // give up and go home (or settle where they stand)
  if (from && from.abandoned < 0 && !b.returning) { b.tx = from.x; b.ty = from.y; b.returning = true; return; }
  if (!b.returning && b.kind === 'migrants') {
    // home is gone: join the nearest town of our own people rather than squat beside strangers
    let kin: Settlement | undefined;
    let kd = 400;
    for (const s of w.activeSettlements()) {
      if (s.civ !== b.civ && s.culture !== b.culture) continue;
      const d = distKm(s.x, s.y, leader.x, leader.y);
      if (d < kd) { kd = d; kin = s; }
    }
    if (kin) { b.tx = kin.x; b.ty = kin.y; b.returning = true; return; }
  }
  b.returning = false;
  b.tx = leader.x; b.ty = leader.y;
  arriveBand(w, b);
}

export function arriveBand(w: World, b: Band) {
  const members = b.members.map((id) => w.people.get(id)!).filter((p) => p && p.alive && p.band === b.id);
  if (!members.length) { w.bands.delete(b.id); return; }
  const leader = w.people.get(b.leader);
  if (!leader || !leader.alive) {
    b.leader = members[0].id;
    return;
  }
  const from = w.settlements[b.from - 1];
  if (b.kind === 'army') { w.diplomacy.arrive(w, b, members, leader); return; }
  if (b.kind === 'raiders') { resolveRaid(w, b, members, leader); return; }
  const site = { x: leader.x, y: leader.y };
  // are we back home, or next to an existing settlement? then join it.
  const near = w.settlementAt(site.x, site.y, 1.2) ?? (b.returning && from && from.abandoned < 0 ? from : undefined);
  if (near && b.kind === 'migrants') {
    for (const m of members) { m.home = near.id; m.band = 0; m.culture = near.culture; m.goal = 'work'; m.hasTarget = false; }
    w.bands.delete(b.id);
    return;
  }
  const cell = cellOf(leader);
  if (w.planet.ocean[cell]) {
    // couldn't find land: settle nowhere
    for (const m of members) m.band = 0;
    w.bands.delete(b.id);
    return;
  }
  const parentCiv = from ? w.civs[from.civ - 1] : undefined;
  let culture = b.culture;
  let civId = 0;
  let note = '';
  let name: string | undefined;
  if (b.kind === 'migrants') {
    note = `Founded by ${members.length} migrants from ${from?.name ?? 'afar'}: ${b.note}.`;
    // a colony stays with its people if it is within reach of any of their towns
    if (from && parentCiv && parentCiv.collapsed < 0 && parentCiv.members.some((id) => { const o = w.settlements[id - 1]; return o.abandoned < 0 && distKm(o.x, o.y, site.x, site.y) < CIV_RADIUS_KM * 1.5; })) civId = parentCiv.id;
  } else {
    // outcasts: a new culture shaped by the founder's rejection of the old one
    const oldC = w.cultures.get(b.culture)!;
    const lang = w.langs.get(oldC.language)!;
    const shift = new Float32Array(NV);
    for (let k = 0; k < NV; k++) shift[k] = leader.beliefs[k] - oldC.values[k];
    const nc = w.cultures.create(w.rng, w.day, lang.id, lang.phonology, oldC, `Founded by ${leader.name}, who rejected the ways of the ${oldC.name} (${b.note}).`, shift);
    nc.founder = leader.id;
    culture = nc.id;
    note = `Founded by ${leader.name} and ${members.length - 1} followers: ${b.note}.`;
    w.history.record('CULTURAL_SPLIT', w.day, `${leader.name} founded a new people, the ${nc.name}, apart from the ${oldC.name}.`, 2, {
      persons: [leader.id], culture: nc.id, x: site.x, y: site.y, cause: `Outcasts led by ${leader.name} rejected the old customs (${b.note}).`,
    });
  }
  const nomadic = !b.tech.has('agriculture');
  const s = w.foundSettlement({
    ...(w.planet.landNear(Math.floor(site.x) + 0.5, Math.floor(site.y) + 0.5) ?? { x: Math.floor(site.x) + 0.5, y: Math.floor(site.y) + 0.5 }), culture, civ: civId || undefined, founder: leader.id, parent: from?.id, tech: b.tech, nomadic, note, name,
  });
  s.knownKm = from ? Math.max(90, from.knownKm * 0.6) : 90;
  if (!civId) {
    const civ = w.civs[s.civ - 1];
    civ.parent = parentCiv?.id ?? 0;
    civ.leader = leader.id;
  }
  for (const m of members) { m.home = s.id; m.band = 0; m.culture = culture; m.goal = 'work'; m.hasTarget = false; m.stuck = 0; m.occupation = m.occupation === 'child' ? 'child' : 'forager'; }
  s.leader = leader.id;
  leader.occupation = 'leader';
  s.pop = members.length;
  s.stage = stageFor(s.pop, nomadic);
  for (const m of members) if (m.ageYears(w.day) >= 12) m.remember({ day: w.day, kind: 'founded', text: `Helped found ${s.name}`, valence: 0.7, intensity: 0.7, x: s.x, y: s.y });
  leader.reputation = clamp(leader.reputation + 0.25);
  leader.status = clamp(leader.status + 0.2);
  w.history.record('FOUNDING', w.day, `${s.name} was founded${from ? ' by settlers from ' + from.name : ''}.`, b.kind === 'outcasts' ? 2 : 1, {
    persons: [leader.id], settlement: s.id, civ: s.civ, culture, x: s.x, y: s.y, cause: note,
  });
  w.bands.delete(b.id);
}

function resolveRaid(w: World, b: Band, members: Person[], leader: Person) {
  if (w.day - b.lastRaid < 200) return;
  const target = w.settlementAt(b.tx, b.ty, 3);
  if (!target || target.abandoned >= 0 || target.pop === 0) { pickRaidTarget(w, b, leader); return; }
  const defenders = adultsOf(w, target.id);
  let attack = 0;
  for (const m of members) attack += m.personality[P.aggression] * 0.6 + m.personality[P.bravery] * 0.4 + 0.3;
  let defense = 0;
  for (const d of defenders) defense += (d.occupation === 'warrior' ? 1 : 0.35) * (0.6 + d.personality[P.bravery] * 0.5);
  defense *= (1 + target.defense * 5 + (has(target, 'metallurgy') ? 0.4 : 0)) * wallFactor(w, target);
  const win = w.rng.next() < attack / (attack + defense + 0.01);
  const killTheirs = Math.round(defenders.length * (win ? 0.04 + w.rng.next() * 0.1 : 0.01));
  const killOurs = Math.round(members.length * (win ? 0.05 : 0.2 + w.rng.next() * 0.2));
  for (let i = 0; i < killTheirs; i++) { const v = defenders[w.rng.int(defenders.length)]; if (v.alive) w.die(v, 'a raid'); }
  for (let i = 0; i < killOurs && members.length > 1; i++) { const v = members.splice(w.rng.int(members.length), 1)[0]; w.die(v, 'a failed raid'); }
  let loot = 0;
  if (win) {
    loot = target.food * 0.4;
    target.food -= loot;
    const share = loot / Math.max(1, members.length);
    for (const m of members) m.food += share * 0.6;
  }
  target.threat = clamp(target.threat + 0.4);
  target.lastRaid = w.day;
  { const home = w.settlements[b.from - 1]; if (home && home.civ !== target.civ) w.diplomacy.get(home.civ, target.civ).raids += 1; }
  target.defense += 0.02;
  for (const d of defenders) {
    if (!d.alive) continue;
    d.remember({ day: w.day, kind: 'raid', text: `Raiders led by ${leader.name} attacked ${target.name}`, valence: -0.9, intensity: win ? 0.9 : 0.5, x: target.x, y: target.y, other: leader.id });
    d.relations.set(leader.id, { affinity: -0.9, kind: 'rival' });
    traumatize(w, d, 'raid', leader.id);
  }
  w.history.record('BATTLE', w.day, `Raiders led by ${leader.name} ${win ? 'plundered' : 'were driven from'} ${target.name}${killTheirs ? `, killing ${killTheirs}` : ''}.`, (win && (killTheirs >= 3 || target.pop > 80)) ? 2 : 1, {
    persons: [leader.id], settlement: target.id, civ: target.civ, x: target.x, y: target.y,
    cause: `Outcasts without land raided a settlement's stores after being cast out of ${w.settlements[b.from - 1]?.name ?? 'society'}.`,
  });
  b.lastTarget = target.id;
  b.lastRaid = w.day;
  b.members = members.map((m) => m.id);
  // victorious, large bands may settle and become a people
  const age = (w.day - b.created) / DAYS_PER_YEAR;
  if (members.length >= 7 && age > 4 && win) {
    b.kind = 'outcasts';
    b.note = 'a raider band turned to settled life';
    const site = findSite(w, leader.x, leader.y, 300, false, w.landComp[cellOf(leader)], b.culture, 30);
    if (site) { b.tx = site.x; b.ty = site.y; return; }
  }
  pickRaidTarget(w, b, leader);
}

function pickRaidTarget(w: World, b: Band, leader: Person) {
  let best: Settlement | undefined;
  let bd = 450;
  for (const s of w.activeSettlements()) {
    if (s.id === b.from || s.id === b.lastTarget && w.rng.chance(0.6)) continue;
    if (w.landComp[idx(wrapX(Math.floor(s.x)), Math.floor(s.y))] !== w.landComp[cellOf(leader)]) continue;
    const d = distKm(leader.x, leader.y, s.x, s.y);
    if (d < bd && d > 15) { bd = d; best = s; }
  }
  if (best) { b.tx = best.x; b.ty = best.y; }
  else {
    // nothing in reach: wander and eventually settle
    b.kind = 'outcasts';
    b.note = 'raiders with nothing left to raid';
    const site = findSite(w, leader.x, leader.y, 300, false, w.landComp[cellOf(leader)], b.culture, 30);
    if (site) { b.tx = site.x; b.ty = site.y; }
  }
}

function aidNeighbours(w: World, s: Settlement, living: Settlement[]) {
  if (s.stress < 0.5 || s.pop < 10) return;
  const cul = w.cultures.get(s.culture)!;
  for (const o of living) {
    if (o === s || o.surplus < 0.25 || o.food < o.pop * 8 || o.stress > 0.2) continue;
    const d = distKm(s.x, s.y, o.x, o.y);
    if (d > 150) continue;
    const oc = w.cultures.get(o.culture)!;
    const will = 0.2 + 0.4 * oc.values[5] + 0.3 * oc.values[2] - (o.culture === s.culture ? 0 : 0.2);
    if (w.rng.next() < will) {
      const amount = Math.min(o.food * 0.15, s.pop * 6);
      o.food -= amount;
      s.food += amount;
      w.history.record('TRADE', w.day, `${o.name} sent ${Math.round(amount)} measures of grain to ${s.name}.`, 1, { settlement: s.id, civ: s.civ, x: s.x, y: s.y, cause: `${s.name} was starving while ${o.name} had a surplus, and traded or shared.` });
      void cul;
      return;
    }
  }
}

// ============================ outcasts ============================
export function outcastSeason(w: World) {
  const rng = w.rng;
  const day = w.day;
  for (const s of w.activeSettlements()) {
    if (s.pop < 14) continue;
    const cul = w.cultures.get(s.culture)!;
    const adults = adultsOf(w, s.id).filter((p) => p.id !== s.leader);
    if (adults.length < 9) continue;
    const leader = s.leader ? w.people.get(s.leader) : undefined;
    for (const p of adults) {
      if (!['forager', 'hunter', 'farmer', 'crafter', 'builder', 'explorer', 'warrior'].includes(p.occupation)) continue;
      const pe = p.personality;
      let mismatch = 0;
      for (let k = 0; k < NV; k++) mismatch += Math.abs(p.beliefs[k] - cul.values[k]);
      mismatch /= NV;
      let bad = 0;
      for (const m of p.memories) if (m.valence < -0.5 && (m.kind === 'betrayed' || m.kind === 'famine' || m.kind === 'raid')) bad += 0.05 * m.intensity;
      const lead = leader ? p.relations.get(leader.id)?.affinity ?? 0 : 0;
      let a = 0.9 * mismatch + 0.25 * (1 - p.status) * pe[P.ambition] + 0.4 * (1 - pe[P.loyalty]) * 0.5 + 0.3 * s.stress + bad + 0.15 * pe[P.impulsiveness] - 0.3 * lead - 0.2 * p.needs[ND.belonging] * 0 - 0.2 * Math.min(1, p.children.length / 3);
      a = clamp(a, 0, 1);
      if (rng.next() > 0.0002 + 0.008 * a * a * a) continue;
      makeOutcast(w, s, p, adults, a);
      break; // at most one per settlement per season
    }
  }
  void day;
}

function makeOutcast(w: World, s: Settlement, p: Person, adults: Person[], alienation: number) {
  const rng = w.rng;
  const pe = p.personality;
  const spirit = p.beliefs[3];
  let kind: Person['occupation'];
  if (pe[P.sociability] < 0.38 && pe[P.patience] > 0.45) kind = 'hermit';
  else if (pe[P.aggression] > 0.62 && pe[P.bravery] > 0.5 && pe[P.empathy] < 0.5) kind = 'raider';
  else if (spirit > 0.65 && pe[P.sociability] > 0.45 && pe[P.creativity] > 0.4) kind = 'cult founder';
  else if (pe[P.ambition] > 0.6 && pe[P.creativity] > 0.45) kind = 'rebel';
  else if (pe[P.greed] > 0.62 && pe[P.empathy] < 0.45) kind = 'exile';
  else kind = 'wanderer';
  const verb: Record<string, string> = {
    hermit: 'withdrew from society to live alone', raider: 'took to banditry', 'cult founder': 'left to found a new faith', rebel: 'rejected the old ways and left with followers',
    exile: 'was banished for theft and betrayal', wanderer: 'left to wander the world',
  };
  const cause: Record<string, string> = {
    hermit: 'Low sociability and deep patience made communal life unbearable.',
    raider: 'Aggressive, bold and short on empathy, with no place in a peaceful camp.',
    'cult founder': 'Intense personal belief and charisma set them against the established customs.',
    rebel: 'Ambition and creativity met a rigid culture and little status to gain.',
    exile: 'Greed led to theft that the community would not forgive.',
    wanderer: `Alienation (${alienation.toFixed(2)}) from a culture that did not fit them.`,
  };
  const reasonKey = kind as string;
  w.history.record('EXILE', w.day, `${p.name} ${verb[reasonKey]} (${s.name}).`, kind === 'hermit' ? 0 : 1, { persons: [p.id], settlement: s.id, civ: s.civ, x: p.x, y: p.y, cause: cause[reasonKey] });
  p.remember({ day: w.day, kind: 'exile', text: `Left ${s.name}: ${verb[reasonKey]}`, valence: -0.4, intensity: 0.8, x: s.x, y: s.y });
  p.occupation = kind;
  p.home = 0;
  p.hasTarget = false;
  if (p.partner) { const pt = w.people.get(p.partner); if (pt && pt.alive && (kind === 'hermit' || kind === 'exile') ) { pt.partner = 0; p.partner = 0; } }
  if (kind === 'hermit' || kind === 'wanderer' && rng.next() < 0.5) {
    if (kind === 'wanderer') p.occupation = 'wanderer';
    p.goal = 'wander';
    return;
  }
  // recruit followers among the alienated
  const group: Person[] = [p];
  const maxF = kind === 'exile' ? 1 : kind === 'raider' ? 6 : 12;
  const want = Math.floor(maxF * (0.3 + pe[P.sociability]) * (0.4 + pe[P.ambition]));
  for (const o of adults) {
    if (group.length > want) break;
    if (o === p || o.band || o.id === s.leader) continue;
    const aff = p.relations.get(o.id)?.affinity ?? 0;
    const kin = p.relations.get(o.id)?.kind === 'kin' || p.partner === o.id;
    let mismatch = 0;
    for (let k = 0; k < NV; k++) mismatch += Math.abs(o.beliefs[k] - p.beliefs[k]);
    const shared = 1 - mismatch / NV;
    if ((aff > 0.2 || kin) && rng.next() < 0.4 + shared * 0.4 || shared > 0.85 && rng.next() < 0.3) {
      group.push(o);
      o.occupation = kind;
      o.home = 0;
      if (o.partner) { const pt = w.people.get(o.partner); if (pt && !group.includes(pt) && pt.alive) { group.push(pt); pt.home = 0; pt.occupation = kind; } }
    }
  }
  // dependants come along
  const withKids: Person[] = [...group];
  for (const g of group) for (const cid of g.children) { const c = w.people.get(cid); if (c && c.alive && c.ageYears(w.day) < 12 && c.home === s.id && !withKids.includes(c)) { withKids.push(c); c.home = 0; } }
  const bandKind: Band['kind'] = kind === 'raider' ? 'raiders' : 'outcasts';
  const band: Band = {
    id: w.nextBand++, kind: bandKind, leader: p.id, tx: p.x, ty: p.y, from: s.id, culture: s.culture, civ: 0, tech: new Set(s.tech),
    note: verb[reasonKey], created: w.day, members: withKids.map((m) => m.id), stuck: 0, lastRaid: -1e9,
  };
  for (const m of withKids) { m.band = band.id; m.food += 5; m.hasTarget = false; }
  w.bands.set(band.id, band);
  if (bandKind === 'raiders') {
    pickRaidTarget(w, band, p);
  } else {
    const site = findSite(w, s.x, s.y, 600, has(s, 'navigation'), w.landComp[idx(wrapX(Math.floor(s.x)), Math.floor(s.y))], s.culture, 30, 0);
    if (site) { band.tx = site.x; band.ty = site.y; }
    else { for (const m of withKids) { m.band = 0; } w.bands.delete(band.id); p.goal = 'wander'; }
  }
}

// ============================ caves ============================
/** A cave within a few hours' walk of a settlement (cell index), or -1. */
export function caveNear(w: World, s: Settlement): number {
  const cx = Math.floor(s.x), cy = Math.floor(s.y);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const y = cy + dy;
    if (y < 0 || y >= H) continue;
    const i = idx(wrapX(cx + dx), y);
    if (w.planet.cave[i]) return i;
  }
  return -1;
}

/** Caves shelter early peoples, become sacred places and canvases, and lead prospectors to buried ore. */
function caveLife(w: World, s: Settlement) {
  const c = caveNear(w, s);
  if (c < 0) return;
  const rng = w.rng;
  if (!has(s, 'writing') && s.pop >= 12 && rng.next() < 0.012) {
    const cul = w.cultures.get(s.culture)!;
    const adults = adultsOf(w, s.id);
    if (!adults.length) return;
    const artist = adults.reduce((a, b) => (b.personality[P.creativity] > a.personality[P.creativity] ? b : a));
    const sp = w.eco.species.filter((x) => x.extinct < 0 && x.diet !== 'omni');
    const subject = sp.length ? sp[rng.int(sp.length)].name : 'the hunt';
    const kind = rng.next() < 0.6 ? `herds of ${subject}` : rng.next() < 0.5 ? 'hands outlined in ochre' : `a hunt of ${subject}`;
    w.cavePaintings.push({ cell: c, settlement: s.id, culture: s.culture, day: w.day, artist: artist.id, subject: kind });
    artist.reputation = clamp(artist.reputation + 0.2);
    artist.remember({ day: w.day, kind: 'art', text: `Painted ${kind} on the walls of a cave`, valence: 0.7, intensity: 0.7, x: s.x, y: s.y });
    if (w.cavePaintings.filter((p) => p.culture === s.culture).length === 1) {
      w.history.record('LEGEND', w.day, `${artist.name} of the ${cul.name} painted ${kind} on the walls of a cave near ${s.name}.`, 2, {
        persons: [artist.id], settlement: s.id, culture: s.culture, x: (c % W) + 0.5, y: Math.floor(c / W) + 0.5,
        cause: 'A sheltered cave, firelight and a people with stories to tell.',
      });
    }
  }
}

// ============================ polities ============================
export function civSeason(w: World) {
  const day = w.day;
  const rng = w.rng;
  for (const civ of w.civs) {
    if (civ.collapsed >= 0) continue;
    const members = civ.members.map((id) => w.settlements[id - 1]).filter((s) => s.abandoned < 0 && s.civ === civ.id);
    civ.members = members.map((s) => s.id);
    if (!members.length) {
      civ.collapsed = day;
      w.history.record('CIVILIZATION_COLLAPSE', day, `The ${civ.name} disappeared.`, 2, { civ: civ.id, culture: civ.culture, cause: 'Its last settlement was abandoned.' });
      continue;
    }
    civ.pop = members.reduce((a, s) => a + s.pop, 0);
    civ.territory = members.length * 4800 + civ.pop * 12;
    let cap = members[0];
    for (const s of members) if (s.pop > cap.pop) cap = s;
    civ.capital = cap.id;
    const cul = w.cultures.get(civ.culture) ?? w.cultures.get(cap.culture)!;
    civ.culture = cap.culture;
    // leader
    const leaderP = civ.leader ? w.people.get(civ.leader) : undefined;
    if (!leaderP || !leaderP.alive) succession(w, civ, cap);
    // legitimacy follows prosperity and the leader's reputation
    const stress = members.reduce((a, s) => a + s.stress * s.pop, 0) / Math.max(1, civ.pop);
    const lp = civ.leader ? w.people.get(civ.leader) : undefined;
    civ.legitimacy = clamp(civ.legitimacy + (stress < 0.2 ? 0.03 : -0.08 * stress) + (lp ? (lp.skills[SK.leading] - 0.3) * 0.01 : 0) - (members.length > 6 ? 0.01 : 0), -1, 1);
    // government evolves under internal pressure
    if (rng.next() < 0.03) evolveGovernment(w, civ, cap, cul.values);
    // coup
    if (civ.legitimacy < -0.15 && civ.pop >= 25 && rng.next() < 0.1) coup(w, civ, cap);
    // collapse
    if (civ.legitimacy < -0.75 && members.length > 1 && civ.pop >= 80) collapse(w, civ, members);
    civ.rank = rankOf(civ, cap);
  }
  politicalGeography(w);
}

function rankOf(civ: Civ, cap: Settlement): string {
  const n = civ.members.length;
  if (civ.pop < 30) return 'band';
  if (n === 1) return cap.stage === 'city' ? 'city-state' : cap.stage === 'town' ? 'chiefdom' : 'tribe';
  if (n >= 8 || civ.pop >= 6000) return 'empire';
  if (n >= 3 && (civ.government === 'monarchy' || civ.government === 'dictatorship')) return 'kingdom';
  if (n >= 3) return 'federation';
  return 'tribal confederation';
}

function succession(w: World, civ: Civ, cap: Settlement) {
  const old = civ.leader ? w.people.get(civ.leader) : undefined;
  civ.lastLeader = civ.leader;
  let next: Person | undefined;
  const adults = adultsOf(w, cap.id);
  if (!adults.length) { civ.leader = 0; return; }
  const hereditary = civ.government === 'monarchy' || civ.government === 'tribal leadership' && old;
  if (hereditary && old) {
    const kids = old.children.map((id) => w.people.get(id)).filter((c): c is Person => !!c && c.alive && c.ageYears(w.day) >= 15);
    kids.sort((a, b) => a.birth - b.birth);
    next = kids[0];
  }
  let how = 'inheritance';
  if (!next) {
    how = civ.government === 'theocracy' ? 'divine selection' : civ.government === 'republic' || civ.government === 'council' ? 'election' : 'rivalry';
    let bs = -1;
    for (const p of adults) {
      const sc = leaderScore(p) + (civ.government === 'theocracy' ? p.beliefs[3] * 0.4 : 0) + rng(w) * 0.08;
      if (sc > bs) { bs = sc; next = p; }
    }
  }
  if (!next) return;
  civ.leader = next.id;
  cap.leader = next.id;
  next.occupation = 'leader';
  next.status = clamp(next.status + 0.3);
  next.remember({ day: w.day, kind: 'leader', text: `Became leader of the ${civ.name}`, valence: 0.7, intensity: 0.8, x: cap.x, y: cap.y });
  if (old) w.history.record('SUCCESSION', w.day, `${next.name} succeeded ${old.name} as leader of the ${civ.name} by ${how}.`, civ.members.length > 2 ? 2 : 1, { persons: [next.id, old.id], civ: civ.id, settlement: cap.id, x: cap.x, y: cap.y, cause: `${old.name} died; the ${civ.government} chose a successor by ${how}.` });
}
const rng = (w: World) => w.rng.next();

function evolveGovernment(w: World, civ: Civ, cap: Settlement, v: Float32Array) {
  const pop = cap.pop;
  const options: [Government, number][] = [['tribal leadership', pop < 90 ? 1 : 0.05]];
  if (pop >= 60) options.push(['council', 0.3 + v[2] * 0.8]);
  if (pop >= 120) options.push(['monarchy', 0.2 + v[4] * 1.2]);
  if (pop >= 100) options.push(['theocracy', v[3] > 0.6 ? v[3] * 0.9 : 0.05]);
  if (pop >= 250 && has(cap, 'writing')) options.push(['republic', (v[0] + v[2]) * 0.7 - v[4] * 0.3]);
  if (civ.legitimacy < -0.5) options.push(['anarchy', 0.8]);
  let best = civ.government;
  let bs = -1;
  const cur = options.find(([g]) => g === civ.government);
  const curScore = cur ? Math.max(0, cur[1]) + 0.45 : 0.45;
  for (const [g, wt] of options) { const sc = Math.max(0, wt) + w.rng.next() * 0.3; if (sc > bs) { bs = sc; best = g; } }
  if (bs < curScore + 0.3) best = civ.government;
  if (best !== civ.government) {
    const old = civ.government;
    civ.government = best;
    w.history.record('SUCCESSION', w.day, `The ${civ.name} changed from ${old} to ${best}.`, civ.pop > 200 ? 2 : 1, { civ: civ.id, settlement: cap.id, x: cap.x, y: cap.y, cause: `Internal pressures (population ${pop}, values favouring ${VALUE_KEYS.reduce((a, k, i) => (v[i] > v[VALUE_KEYS.indexOf(a)] ? k : a), VALUE_KEYS[0])}) reshaped how power is held.` });
  }
}

function coup(w: World, civ: Civ, cap: Settlement) {
  const old = civ.leader ? w.people.get(civ.leader) : undefined;
  const rivals = adultsOf(w, cap.id).filter((p) => p.id !== civ.leader && p.status > 0.3 && p.personality[P.ambition] > 0.55);
  if (!rivals.length) return;
  rivals.sort((a, b) => b.personality[P.ambition] * (0.5 + b.status) - a.personality[P.ambition] * (0.5 + a.status));
  const usurper = rivals[0];
  if (old) { old.relations.set(usurper.id, { affinity: -0.9, kind: 'rival' }); if (w.rng.chance(0.5)) w.die(old, 'assassination'); else old.occupation = 'exile'; }
  civ.lastLeader = civ.leader;
  civ.leader = usurper.id;
  cap.leader = usurper.id;
  usurper.occupation = 'leader';
  usurper.status = clamp(usurper.status + 0.3);
  civ.legitimacy = 0.2;
  if (civ.government !== 'dictatorship' && w.rng.chance(0.5)) civ.government = 'dictatorship';
  usurper.remember({ day: w.day, kind: 'leader', text: `Seized power over the ${civ.name}`, valence: 0.5, intensity: 0.9, x: cap.x, y: cap.y, other: old?.id });
  w.history.record('REVOLT', w.day, `${usurper.name} seized power from ${old?.name ?? 'the ruler'} in ${cap.name}.`, 2, {
    persons: [usurper.id], civ: civ.id, settlement: cap.id, x: cap.x, y: cap.y, cause: 'Famine and failing authority eroded legitimacy until an ambitious figure acted.',
  });
}

/** A collapsing state breaks into regional successors: the largest surviving towns become capitals and their neighbours follow them. */
function collapse(w: World, civ: Civ, members: Settlement[]) {
  civ.collapsed = w.day;
  const sorted = [...members].sort((a, b) => b.pop - a.pop);
  const groups: Settlement[][] = [];
  const taken = new Set<number>();
  for (const s of sorted) {
    if (taken.has(s.id)) continue;
    const g = [s];
    taken.add(s.id);
    for (const o of sorted) if (!taken.has(o.id) && distKm(s.x, s.y, o.x, o.y) < CIV_RADIUS_KM * 0.8) { g.push(o); taken.add(o.id); }
    groups.push(g);
  }
  w.history.record('CIVILIZATION_COLLAPSE', w.day, `The ${civ.name} collapsed, breaking into ${groups.length} successor${groups.length > 1 ? ' states' : ''}.`, 3, {
    civ: civ.id, culture: civ.culture, x: members[0].x, y: members[0].y, cause: 'Prolonged hardship destroyed the legitimacy that held its settlements together.',
  });
  for (const g of groups) {
    const c = w.createCiv(g[0], 'Emerged from the ruins of the ' + civ.name + '.', civ.id);
    for (const o of g.slice(1)) { o.civ = c.id; c.members.push(o.id); }
    const lead = g[0].leader ? w.people.get(g[0].leader) : undefined;
    c.leader = lead?.alive ? lead.id : 0;
    c.legitimacy = 0.3;
    c.government = 'tribal leadership';
  }
}

/**
 * Borders settle into compact states: towns far from the capital drift out of its control and break away (taking their
 * neighbours with them), and a small people squeezed against a much larger neighbour of similar culture is absorbed by it.
 */
function politicalGeography(w: World) {
  const rng = w.rng;
  for (const civ of w.livingCivs()) {
    if (civ.members.length < 2) continue;
    const cap = w.settlements[civ.capital - 1];
    vassals(w, civ, cap);
    for (const id of civ.members) {
      const s = w.settlements[id - 1];
      if (s === cap || s.abandoned >= 0 || s.civ !== civ.id || s.pop < 25) continue;
      const d = distKm(s.x, s.y, cap.x, cap.y);
      const reach = governRange(cap);
      const lord = s.lord ? w.people.get(s.lord) : undefined;
      // a disloyal lord raises his town in revolt; an ungoverned town too far away simply drifts off
      if (lord?.alive && s.loyalty < 0.12 && rng.next() < 0.3) { secede(w, civ, s, cap, d, lord.id); break; }
      if (d < reach || lord?.alive) continue;
      const p = 0.03 + Math.max(0, -civ.legitimacy) * 0.15 + (d / reach - 1) * 0.05;
      if (rng.next() < p) { secede(w, civ, s, cap, d); break; }
    }
  }
  const active = w.activeSettlements();
  for (const small of w.livingCivs()) {
    if (small.members.length > 2) continue;
    const sc = w.settlements[small.capital - 1];
    if (!sc || sc.abandoned >= 0) continue;
    let best: Civ | undefined;
    let bd = FOREIGN_GAP_KM;
    for (const s of active) {
      if (s.civ === small.id) continue;
      const d = distKm(s.x, s.y, sc.x, sc.y);
      if (d >= bd) continue;
      const o = w.civs[s.civ - 1];
      if (o && o.collapsed < 0 && o.pop > small.pop * 1.8) { bd = d; best = o; }
    }
    if (!best) continue;
    const rel = w.diplomacy.get(small.id, best.id);
    if (rel.war) continue;
    const ca = w.cultures.get(small.culture), cb = w.cultures.get(best.culture);
    const kin = ca && cb ? 1 - w.cultures.distance(ca, cb) : 0.5;
    const p = 0.08 * (1 - bd / FOREIGN_GAP_KM) * (rel.tension < 0.5 ? 1 : 0.35) * (0.4 + kin) * (rel.trade > 0 ? 1.5 : 1);
    if (rng.next() >= p) continue;
    const names = small.members.map((id) => w.settlements[id - 1].name).join(' and ');
    for (const id of small.members) { const s = w.settlements[id - 1]; s.civ = best.id; best.members.push(id); }
    small.members = [];
    small.collapsed = w.day;
    w.history.record('CIVILIZATION_COLLAPSE', w.day, `The ${small.name} joined the ${best.name}.`, 2, {
      civ: best.id, settlement: sc.id, x: sc.x, y: sc.y, culture: small.culture,
      cause: `${names}, only ${Math.round(bd)} km from the ${best.name} and ${kin > 0.6 ? 'of kindred customs' : 'outnumbered'}, ${rel.trade > 0 ? 'already traded with them and ' : ''}chose union over rivalry.`,
    });
  }
}

/**
 * Larger polities rule their outlying towns through lords: the best-placed local notable governs for the ruler. Loyalty
 * grows with the ruler's legitimacy and kinship, and erodes with distance, hardship, foreign customs and the lord's own
 * ambition.
 */
function vassals(w: World, civ: Civ, cap: Settlement) {
  const ruler = civ.leader ? w.people.get(civ.leader) : undefined;
  for (const id of civ.members) {
    const s = w.settlements[id - 1];
    if (s === cap || s.abandoned >= 0 || s.pop < 30) { s.lord = 0; continue; }
    let lord = s.lord ? w.people.get(s.lord) : undefined;
    if (!lord || !lord.alive || lord.home !== s.id) {
      const cands = adultsOf(w, s.id);
      if (!cands.length) { s.lord = 0; continue; }
      lord = cands.reduce((a, b) => (leaderScore(b) > leaderScore(a) ? b : a));
      const kin = !!ruler && (ruler.relations.get(lord.id)?.kind === 'kin' || ruler.children.includes(lord.id));
      s.lord = lord.id;
      s.loyalty = clamp(0.55 + (kin ? 0.3 : 0) + w.rng.next() * 0.1 - (lord.personality[P.ambition] - 0.5) * 0.2);
      lord.status = clamp(lord.status + 0.2);
      lord.remember({ day: w.day, kind: 'leader', text: `Became lord of ${s.name} under the ${civ.name}`, valence: 0.6, intensity: 0.7, x: s.x, y: s.y });
      if (s.pop >= 150) w.history.record('SUCCESSION', w.day, `${lord.name} became lord of ${s.name}, ruling for the ${civ.name}${kin ? ` as kin of ${ruler!.name}` : ''}.`, 1, {
        persons: [lord.id], settlement: s.id, civ: civ.id, x: s.x, y: s.y, cause: `${s.name} lies ${Math.round(distKm(s.x, s.y, cap.x, cap.y))} km from the capital and needs a governor.`,
      });
    }
    const d = distKm(s.x, s.y, cap.x, cap.y);
    const reach = governRange(cap);
    s.loyalty = clamp(s.loyalty + 0.012 * civ.legitimacy + 0.006 - 0.025 * Math.max(0, d / reach - 0.6) - 0.02 * (lord.personality[P.ambition] - 0.5)
      - 0.02 * s.stress - (s.culture !== cap.culture ? 0.012 : 0) + (s.threat > 0.3 ? 0.01 : 0));
  }
}

function secede(w: World, civ: Civ, s: Settlement, cap: Settlement, d: number, rebel = 0) {
  civ.members = civ.members.filter((id) => id !== s.id);
  const lordP = rebel ? w.people.get(rebel) : undefined;
  const c = w.createCiv(s, lordP ? `${lordP.name}, lord of ${s.name}, rose against the ${civ.name}.` : `${s.name}, ${Math.round(d)} km from ${cap.name}, broke away from the ${civ.name}.`, civ.id);
  const lead = lordP ?? (s.leader ? w.people.get(s.leader) : undefined);
  c.leader = lead?.alive ? lead.id : 0;
  s.lord = 0;
  s.loyalty = 1;
  c.legitimacy = 0.35;
  c.government = civ.government;
  // nearby towns that are themselves far from the old capital follow the new one
  for (const id of [...civ.members]) {
    const o = w.settlements[id - 1];
    if (o === cap || o.abandoned >= 0) continue;
    if (distKm(o.x, o.y, s.x, s.y) < CIV_RADIUS_KM * 0.7 && distKm(o.x, o.y, cap.x, cap.y) > CIV_RADIUS_KM * 1.2) {
      o.civ = c.id;
      c.members.push(o.id);
      civ.members = civ.members.filter((i) => i !== o.id);
    }
  }
  // a lord's revolt is a war of independence; a quiet drift apart leaves only resentment
  w.diplomacy.get(civ.id, c.id).tension = Math.max(w.diplomacy.get(civ.id, c.id).tension, lordP ? 0.95 : 0.45);
  w.history.record('REVOLT', w.day, lordP ? `${lordP.name}, lord of ${s.name}, rebelled against the ${civ.name} and proclaimed the ${c.name}.` : `${s.name} seceded from the ${civ.name}, founding the ${c.name}.`, lordP ? 3 : 2, {
    persons: lordP ? [lordP.id] : [], civ: c.id, settlement: s.id, x: s.x, y: s.y, culture: s.culture,
    cause: lordP
      ? `Loyalty to the ${civ.name} had worn away: ${Math.round(d)} km from the capital${civ.legitimacy < 0 ? ', rulers who had lost legitimacy' : ''}${s.stress > 0.3 ? ', hard times' : ''}, and an ambitious lord.`
      : `It lay ${Math.round(d)} km from the capital ${cap.name}${civ.legitimacy < 0 ? ' and the rulers had lost legitimacy' : ''}, too far to be governed.`,
  });
}
