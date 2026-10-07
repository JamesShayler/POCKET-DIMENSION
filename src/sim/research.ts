/**
 * Earned technology. A community does not simply "discover" an art: someone gets the idea, the town (or, for the great
 * ideas of a whole people, its leading town) starts experiments that cost materials and sometimes lives, most attempts
 * fail, every failure teaches something, and one day an attempt works. Then the art is crude and has to be practised for
 * generations before it is mastered; practice needs the right people and buildings, and an art whose experts die or whose
 * town shrinks below what can sustain it fades and can be lost. Neighbours learn by contact — the idea and the lessons
 * travel, the mastery does not. Every record is saved with its settlement; the world keeps a ledger of firsts.
 */
import type { World } from './world';
import type { Settlement } from './settlements';
import type { Person } from './people';
import { P, SK } from './people';
import { clamp } from './rng';
import { H, distKm, idx, wrapX } from './grid';
import { DAYS_PER_YEAR } from './time';
import { BDEFS, type BKind, type Building, type ResKey } from './buildings';
import { TECHS, TECH_IDS, type FeatId, type Hazard, type Ledger, type Research, type Stage, type TechDef, type TechId, type TechProgress } from './technology';
import { contactRange, eff, innovationMult, mastery } from './techfx';

const Y = DAYS_PER_YEAR;
/** The main pace knob: research rates and mastery growth scale with it. */
export const TECH_PACE = 1.0;
const TECH_RATE = 0.35;
const INKLING_K = 2;
const AW_OWN = 0.15;
const AW_TAUGHT = 0.075;
const XP_CAP = 10;
const PS_MAX = 0.92;
const M0_OWN = 0.12;
const M0_TAUGHT = 0.2;
const MASTERY_K = 1.2;
const PREREQ_M = 0.4;
const PREREQ_M_TAUGHT = 0.25;
const TEACH_MIN = 0.2;
const REFINED = 0.3;
const MASTERED = 0.85;
const UNMASTER = 0.75;
const LOST_M = 0.06;
const STALL_SEASONS = 80;
const EV_GAP = 8 * Y;
const FRONTIER_GAP = 30 * Y;
const MAJOR_GAP = 10 * Y;
const BAD_P: Record<Hazard, number> = { none: 0, fire: 0.35, harvest: 0.6, collapse: 0.4, wreck: 0.5, poison: 0.4, explosion: 0.5, crash: 0.7, shock: 0.3 };
const ACC: Record<Hazard, number> = { none: 0, explosion: 0.04, crash: 0.05, wreck: 0.03, collapse: 0.02, fire: 0.02, shock: 0.02, poison: 0.015, harvest: 0 };
const CAUSE: Record<Hazard, string> = { none: 'an accident', harvest: 'hunger', fire: 'a workshop fire', collapse: 'a collapse', wreck: 'lost at sea', poison: 'poisoning', explosion: 'an explosion', crash: 'a crash', shock: 'electrocution' };
const SKILL_FOR: Record<Hazard, number> = { none: -1, harvest: SK.farming, wreck: SK.exploring, crash: SK.exploring, collapse: SK.building, fire: SK.crafting, explosion: SK.crafting, shock: SK.crafting, poison: SK.healing };

const yr = (day: number) => Math.floor(day / Y);
const lc = (t: TechDef) => t.name.toLowerCase();

// ------------------------------------------------------------------ the ledger
export function ledgerOf(w: World, id: TechId | FeatId): Ledger {
  let L = w.research.ledger[id];
  if (!L) {
    L = { first: -1, by: 0, at: 0, civ: 0, took: 0, pre: [0, 0, 0], p: 0, mastered: -1, mAt: 0, n: 0, f: 0, k: 0, big: -1e9, lost: -1 };
    w.research.ledger[id] = L;
  }
  return L;
}
export function newResearch(): Research {
  return { ledger: {}, lastMajor: -1e9 };
}

function record(day: number, st: Stage, by = 0): TechProgress {
  return { st, d0: day, d: day, la: day, w: 0, bl: 0, r: 0, xp: 0, n: 0, f: 0, k: 0, m: 0, pk: 0, lead: 0, pl: [], ev: -1e9, by, g: 0, until: 0 };
}

/**
 * How a research event is chronicled: weight 1 at most every 8 years per record, weight 2 at most once a decade worldwide
 * (and once in 30 years per frontier), weight 3 always. Demoted events are still counted.
 */
function chron(w: World, want: number, tp?: TechProgress, L?: Ledger, frontier = false): number {
  const day = w.day;
  if (want >= 3) { w.research.lastMajor = day; return 3; }
  if (want === 2) {
    if ((!frontier || !L || day - L.big >= FRONTIER_GAP) && day - w.research.lastMajor >= MAJOR_GAP) {
      if (frontier && L) L.big = day;
      w.research.lastMajor = day;
      if (tp) tp.ev = day;
      return 2;
    }
    want = 1;
  }
  if (want === 1) {
    if (!tp) return 1;
    if (day - tp.ev >= EV_GAP) { tp.ev = day; return 1; }
  }
  return 0;
}

// ------------------------------------------------------------------ per-season context
interface Needs { stone: number; clay: number; copper: number; iron: number; coal: number; coast: number; fert: number; wood: number }
interface Ctx {
  s: Settlement;
  adults: Person[];
  innov: number;
  res: Needs;
  civPop: number;
  kiln: number; smithy: number; masonry: number; factory: number; power: number; airport: number; pad: number;
  farmers: number; healers: number; warriors: number; scholars: number;
  openness: number; spirituality: number;
}

function localNeeds(w: World, s: Settlement): Needs {
  const cx = Math.floor(s.x), cy = Math.floor(s.y);
  const res: Needs = { stone: 0, clay: 0, copper: 0, iron: 0, coal: 0, coast: 0, fert: 0, wood: 0 };
  const pr = w.planet.res;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const y = cy + dy;
    if (y < 0 || y >= H) continue;
    const i = idx(wrapX(cx + dx), y);
    if (w.planet.ocean[i]) { res.coast = 1; continue; }
    res.stone = Math.max(res.stone, pr.stone[i] / 255);
    res.clay = Math.max(res.clay, pr.clay[i] / 255);
    res.copper = Math.max(res.copper, pr.copper[i] / 255);
    res.iron = Math.max(res.iron, pr.iron[i] / 255);
    res.coal = Math.max(res.coal, pr.coal[i] / 255);
    res.fert = Math.max(res.fert, w.env.fert[i]);
    res.wood = Math.max(res.wood, w.env.veg[i]);
  }
  return res;
}

function contextOf(w: World, s: Settlement): Ctx {
  const res = (w.residents.get(s.id) ?? []);
  const adults = res.filter((p) => p.alive && p.ageYears(w.day) >= 15 && !p.band);
  const cul = w.cultures.get(s.culture);
  let innov = 0;
  let scholars = 0;
  for (const p of adults) {
    const v = p.personality[P.creativity] * 0.6 + p.personality[P.curiosity] * 0.2 + p.personality[P.intelligence] * 0.2;
    innov += v * v;
    if (p.occupation === 'scholar') scholars++;
  }
  const openness = cul ? cul.values[0] : 0.5;
  innov *= (1 + scholars * 1.5) * (0.6 + 0.8 * openness) * (1 + 0.3 * eff(s, 'writing')) * innovationMult(s);
  const c: Ctx = {
    s, adults, innov, res: localNeeds(w, s), civPop: w.civs[s.civ - 1]?.pop ?? s.pop,
    kiln: 0, smithy: 0, masonry: 0, factory: 0, power: 0, airport: 0, pad: 0,
    farmers: s.occupations['farmer'] ?? 0, healers: s.occupations['healer'] ?? 0, warriors: s.occupations['warrior'] ?? 0, scholars,
    openness, spirituality: cul ? cul.values[3] : 0.5,
  };
  for (const b of w.buildings.of(s.id)) {
    if (b.done < 0) continue;
    switch (b.kind) {
      case 'kiln': c.kiln++; break;
      case 'smithy': c.smithy++; break;
      case 'stonehouse': case 'temple': case 'wall': case 'tower': c.masonry++; break;
      case 'factory': c.factory++; break;
      case 'powerplant': c.power++; break;
      case 'airport': c.airport++; break;
      case 'launchpad': c.pad++; break;
      default: break;
    }
  }
  return c;
}

function practiceOf(t: TechDef, c: Ctx): number {
  let v = 1;
  switch (t.practice) {
    case 'farm': v = c.farmers / Math.max(1, 0.3 * c.adults.length); break;
    case 'kiln': v = c.kiln ? 1 : 0.5; break;
    case 'smithy': v = c.smithy ? 1 : 0.4; break;
    case 'masonry': v = 0.5 + 0.15 * c.masonry; break;
    case 'ships': v = 0.35 + 0.15 * c.s.ships; break;
    case 'scholars': v = 0.5 + 0.1 * c.scholars; break;
    case 'healers': v = 0.4 + 0.15 * c.healers; break;
    case 'warriors': v = 0.5 + c.warriors / 20; break;
    case 'mills': v = c.factory ? 1.1 : c.smithy ? 0.7 : 0.4; break;
    case 'factory': v = c.factory ? 1 + 0.1 * (c.factory - 1) : 0.4; break;
    case 'power': v = c.power ? 1 : 0.4; break;
    case 'airport': v = c.airport ? 1 : 0.4; break;
    case 'pad': v = c.pad ? 0.8 : 0.35; break;
    default: v = 1;
  }
  return clamp(v, 0.35, 1.2);
}

function pressureOf(w: World, s: Settlement, id: TechId): number {
  switch (id) {
    case 'agriculture': return 1 + 2 * s.stress + (s.nomadic ? 0 : 0.5);
    case 'metallurgy': return 1 + s.goods / Math.max(10, s.pop);
    case 'navigation': case 'seafaring': return 1.5;
    case 'gunpowder': return 1 + s.threat;
    case 'medicine': return s.diseaseUntil > w.day ? 2 : 1;
    default: return 1;
  }
}

/** The mastery a town can sustain: size against the art's needs, how much it is practised, whether it is written down. */
function capOf(s: Settlement, t: TechDef, c: Ctx): number {
  const popF = s.pop / (1.2 * t.minPop);
  const civF = t.civPop ? c.civPop / (1.2 * t.civPop) : Infinity;
  const P_ = practiceOf(t, c);
  let v = clamp(1.1 * Math.min(popF, civF) - 0.1, 0, 1) * (0.55 + 0.45 * Math.min(1, P_)) * (t.difficulty >= 250 && t.id !== 'writing' && !s.tech.has('writing') ? 0.85 : 1);
  if (t.difficulty < 100) v = Math.max(v, 0.3);
  return v;
}

function prereqMin(s: Settlement, t: TechDef): number {
  let m = 1;
  for (const q of t.prereq) m = Math.min(m, mastery(s, q));
  return m;
}

/** Whether the town could start this idea itself (the seat rule for a people's great ideas is applied separately). */
function eligibleUntaught(s: Settlement, t: TechDef, c: Ctx, cx: Map<number, Ctx>): boolean {
  if (s.pop < t.minPop && (s.pop < t.minPop * 0.35 || c.civPop < t.minPop * 2.5)) return false;
  if (t.civPop && c.civPop < t.civPop) return false;
  if (t.needs) for (const k of Object.keys(t.needs) as (keyof Needs)[]) if (c.res[k] < (t.needs[k] ?? 0)) return false;
  for (const q of t.prereq) {
    if (!s.tech.has(q)) return false;
    if (mastery(s, q) < Math.min(PREREQ_M, 0.9 * capOf(s, TECHS[q], c))) return false;
  }
  void cx;
  return true;
}

/** Whether the town can go on with an idea it was taught (no local-resource or polity-size test, as before). */
function eligibleTaught(s: Settlement, t: TechDef, c: Ctx): boolean {
  if (s.pop < 0.5 * t.minPop) return false;
  for (const q of t.prereq) {
    if (!s.tech.has(q)) return false;
    if (mastery(s, q) < Math.min(PREREQ_M_TAUGHT, 0.9 * capOf(s, TECHS[q], c))) return false;
  }
  return true;
}

/** The chance that one attempt works (pure: the panels use it to show the odds). */
export function attemptChance(t: TechDef, xp: number, lead: Person | undefined, frac: number, preMin: number): number {
  const h = clamp(Math.pow(120 / t.difficulty, 0.35), 0.45, 1.8);
  const apt = lead ? 0.85 + 0.3 * (0.5 * lead.personality[P.creativity] + 0.3 * lead.personality[P.intelligence] + 0.2 * lead.personality[P.patience]) : 1;
  const prereqF = clamp(preMin / 0.6, 0.5, 1);
  return Math.min(PS_MAX, (0.06 * h + 0.14 * h * xp) * (0.4 + 0.6 * clamp(frac, 0, 1)) * prereqF * apt);
}

// ------------------------------------------------------------------ leads
function pickLead(w: World, s: Settlement, t: TechDef, c: Ctx): number {
  const sk = SKILL_FOR[t.hazard];
  let best: Person | undefined;
  let bs = -Infinity;
  for (const p of c.adults) {
    const age = p.ageYears(w.day);
    if (age < 18 || age > 60 || !p.alive || p.home !== s.id) continue;
    const sc = 0.45 * p.personality[P.creativity] + 0.35 * p.personality[P.intelligence] + 0.2 * p.personality[P.curiosity]
      + (p.occupation === 'scholar' ? 0.15 : 0) + (sk >= 0 ? 0.2 * p.skills[sk] : 0) + 0.15 * w.rng.next();
    if (sc > bs || (sc === bs && best && p.id < best.id)) { bs = sc; best = p; }
  }
  return best ? best.id : 0;
}

function checkLead(w: World, s: Settlement, t: TechDef, tp: TechProgress, c: Ctx) {
  if (tp.lead) {
    const p = w.people.get(tp.lead);
    if (p && p.alive && p.home === s.id) return;
    // the work loses its leader: what they knew goes with them, unless it was written down
    tp.pl.push(tp.lead);
    if (tp.pl.length > 3) tp.pl.shift();
    const written = s.tech.has('writing');
    if (tp.st === 2) tp.xp = Math.max(0, tp.xp - (written ? 0.3 : 1));
    else if (tp.st <= 4) tp.m -= tp.m * (written ? 0.02 : 0.06);
    if (t.difficulty >= 100 && (tp.m >= 0.2 || tp.st === 2) && p) {
      const left = p.alive;
      const wgt = chron(w, !written || p.legend ? 1 : 0, tp);
      w.history.record('EXPERIMENT', w.day, left
        ? `${p.name} left ${s.name}, taking much of what the town knew about ${lc(t)} with them.`
        : `With the death of ${p.name}, ${s.name} lost much of what it knew about ${lc(t)}.`, wgt, {
        persons: [p.id], settlement: s.id, civ: s.civ, culture: s.culture, x: s.x, y: s.y,
        cause: `${p.name} had led the work for ${Math.max(1, yr(w.day - tp.d))} years${written ? '; written records kept part of it' : ` and ${s.name} kept no written records`}.`,
      });
    }
    tp.lead = 0;
  }
  tp.lead = pickLead(w, s, t, c);
}

// ------------------------------------------------------------------ the season
/** Ideas, experiments, practice and teaching for every living settlement (once per season). */
export function researchSeason(w: World, alive: Settlement[]) {
  const day = w.day;
  const cx = new Map<number, Ctx>();
  for (const s of alive) { if (!s.prog) s.prog = {}; cx.set(s.id, contextOf(w, s)); }
  // a people's great ideas are worked on at one town (its seat for that idea), drawing on the whole people
  const seats = new Map<string, { seat: number; innov: number }>();
  const seatOf = (s: Settlement, t: TechDef): { seat: number; innov: number } => {
    const key = `${s.civ}:${t.id}`;
    let r = seats.get(key);
    if (r) return r;
    const civ = w.civs[s.civ - 1];
    const members = civ ? civ.members.map((id) => cx.get(id)).filter((c): c is Ctx => !!c) : [cx.get(s.id)!];
    let best: Ctx | undefined;
    let total = 0;
    for (const c of members) {
      total += c.innov;
      if (!eligibleUntaught(c.s, t, c, cx)) continue;
      if (!best || c.innov > best.innov || (c.innov === best.innov && c.s.id < best.s.id)) best = c;
    }
    r = best ? { seat: best.s.id, innov: best.innov + 0.4 * (total - best.innov) } : { seat: 0, innov: 0 };
    seats.set(key, r);
    return r;
  };
  const innovEff = (s: Settlement, t: TechDef, c: Ctx) => {
    if (!t.civPop) return c.innov;
    const r = seatOf(s, t);
    return r.seat === s.id ? r.innov : c.innov;
  };
  const rateOf = (s: Settlement, t: TechDef, c: Ctx) => (TECH_PACE * TECH_RATE * Math.sqrt(Math.max(0, innovEff(s, t, c))) * pressureOf(w, s, t.id)) / t.difficulty;
  /** may this record go on (or be started / promoted, when `start`)? */
  const okFor = (s: Settlement, t: TechDef, tp: TechProgress | undefined, c: Ctx, start: boolean): boolean => {
    if (tp?.by) return eligibleTaught(s, t, c);
    if (!eligibleUntaught(s, t, c, cx)) return false;
    if (start && t.civPop) return seatOf(s, t).seat === s.id;
    return true;
  };
  // facilities somewhere in each polity (a launch site for spaceflight)
  const facility = (s: Settlement, kind: BKind) => {
    const civ = w.civs[s.civ - 1];
    const ids = civ ? civ.members : [s.id];
    return ids.some((id) => w.buildings.count(id, kind) > 0);
  };

  for (const s of alive) {
    const c = cx.get(s.id)!;
    const prog = s.prog;
    const canWork = c.adults.length >= 3;
    let risk = 0;
    const risky: [TechId, number][] = [];
    let inExperiment = 0;
    for (const id of TECH_IDS) {
      const t = TECHS[id];
      let tp = prog[id];
      if (!tp) {
        // (a) an idea arises
        if (!canWork || s.tech.has(id) || !okFor(s, t, undefined, c, true)) continue;
        const R = rateOf(s, t, c);
        if (w.rng.next() < 1 - Math.exp((-INKLING_K * R) / 4)) {
          prog[id] = record(day, 1);
          w.history.record('EXPERIMENT', day, `People at ${s.name} began to wonder whether ${lc(t)} could be made to work.`, 0, { settlement: s.id, civ: s.civ, culture: s.culture, x: s.x, y: s.y });
        }
        continue;
      }
      if (tp.st === 1) continue;
      if (tp.st === 2) {
        inExperiment++;
        if (!canWork) continue;
        experiments(w, s, t, tp, c, okFor(s, t, tp, c, false) && (!t.facility || facility(s, t.facility)), rateOf(s, t, c));
        continue;
      }
      // (d) practice: mastery grows toward what the town can sustain, and decays when it cannot
      const cap = capOf(s, t, c);
      const P_ = practiceOf(t, c);
      const gro = (MASTERY_K * TECH_PACE * TECH_RATE * Math.sqrt(Math.max(0, innovEff(s, t, c)))) / t.difficulty * 0.25 * P_;
      const strained = s.diseaseUntil > day || s.stress > 0.6;
      if (!strained && tp.m < cap) tp.m = Math.min(cap, tp.m + gro * (1 - tp.m));
      else if (tp.m > cap) tp.m -= (tp.m - cap) * (s.tech.has('writing') ? 0.02 : 0.06);
      if (strained) tp.m -= 0.004 * tp.m;
      tp.m = clamp(tp.m, 0, 1);
      if (tp.st <= 4 && t.difficulty >= 100 && canWork) checkLead(w, s, t, tp, c);
      tp.pk = Math.max(tp.pk, tp.m);
      if (tp.st === 3 && tp.m >= REFINED) { tp.st = 4; tp.d = day; }
      if (tp.st === 4 && tp.m >= MASTERED) masteredAt(w, s, t, tp);
      else if (tp.st === 5 && tp.m < UNMASTER) { tp.st = 4; tp.d = day; }
      if (t.difficulty >= 100 && tp.m < LOST_M) { loseTech(w, s, id, tp, c); continue; }
      tp.g *= 0.95;
      if (t.difficulty >= 100 && t.danger > 0 && t.hazard !== 'none') {
        const r = ACC[t.hazard] * (1 - tp.m) * (1 - tp.m) * Math.min(1, P_);
        if (r > 0) { risk += r; risky.push([id, r]); }
      }
    }
    // (e) promote an idea into experiments if the town has room for another programme
    if (canWork) {
      const slots = Math.min(3, 1 + (s.pop >= 60 ? 1 : 0) + Math.min(1, Math.floor(c.scholars / 4)));
      if (inExperiment < slots) {
        let pick: TechId | undefined;
        let ps = -1;
        for (const id of TECH_IDS) {
          const tp = prog[id];
          if (!tp || tp.st !== 1 || tp.until > day) continue;
          const t = TECHS[id];
          if (!okFor(s, t, tp, c, true)) continue;
          const score = ((tp.by ? 2 : 1) * pressureOf(w, s, id)) / Math.sqrt(t.difficulty);
          if (score > ps) { ps = score; pick = id; }
        }
        if (pick) startProgramme(w, s, TECHS[pick], prog[pick]!, c);
      }
    }
    // (f) a crude art is dangerous to practise
    if (risk > 0 && w.rng.next() < risk) {
      let r = w.rng.next() * risk;
      let which = risky[0][0];
      for (const [id, v] of risky) { r -= v; if (r <= 0) { which = id; break; } }
      accident(w, s, TECHS[which], prog[which]!, c);
    }
  }
  teach(w, alive, cx);
}

function startProgramme(w: World, s: Settlement, t: TechDef, tp: TechProgress, c: Ctx) {
  const day = w.day;
  tp.st = 2; tp.d = day; tp.la = day; tp.w = 0; tp.bl = 0; tp.until = 0; tp.why = undefined;
  tp.lead = pickLead(w, s, t, c);
  const L = ledgerOf(w, t.id);
  const frontier = L.first < 0;
  L.p++;
  const lead = w.people.get(tp.lead);
  const pre = t.prereq.filter((q) => TECHS[q].difficulty >= 100).map((q) => `${lc(TECHS[q])} (${Math.round(mastery(s, q) * 100)}%)`);
  const want = frontier && L.p <= 2 && (t.era || t.difficulty >= 300) ? 1 : 0;
  w.history.record('EXPERIMENT', day, `${lead ? `${lead.name} of ${s.name}` : `People at ${s.name}`} began experiments toward ${t.description}.`, chron(w, want, tp), {
    persons: lead ? [lead.id] : [], settlement: s.id, civ: s.civ, culture: s.culture, x: s.x, y: s.y,
    cause: tp.by
      ? `Word of it had come from ${w.settlements[tp.by - 1]?.name ?? 'elsewhere'}.`
      : `${s.name} had ${pre.length ? `mastered ${pre.join(' and ')}` : 'the means and the curiosity'}${Object.keys(t.needs ?? {}).length ? ', with what it needed close at hand' : ''}.`,
  });
}

// ------------------------------------------------------------------ experiments
function experiments(w: World, s: Settlement, t: TechDef, tp: TechProgress, c: Ctx, ok: boolean, R: number) {
  const day = w.day;
  if (!ok) {
    tp.bl++;
    if (tp.bl >= STALL_SEASONS) {
      tp.st = 1; tp.until = day + 10 * Y; tp.why = 'stalled'; tp.bl = 0; tp.w = 0;
      w.history.record('EXPERIMENT', day, `The experiments with ${lc(t)} at ${s.name} were given up.`, chron(w, 0, tp), { settlement: s.id, civ: s.civ, x: s.x, y: s.y, cause: 'For twenty years the work could not go on.' });
    }
    return;
  }
  checkLead(w, s, t, tp, c);
  tp.r = R;
  tp.w += R / 4;
  const AW = tp.by ? AW_TAUGHT : AW_OWN;
  if (tp.w < AW) { tp.bl = 0; return; }
  // materials for the attempt (what is set aside for a great work is not touched)
  let frac = 1;
  const trial = t.trial;
  if (trial) {
    for (const k of Object.keys(trial) as (ResKey | 'food')[]) {
      const cost = trial[k] ?? 0;
      if (cost <= 0) continue;
      const free = k === 'food' ? s.food - 3 * s.pop : s.res[k] - (s.reserve?.[k] ?? 0);
      frac = Math.min(frac, clamp(free / cost, 0, 1));
    }
    if (frac < 0.25 && tp.w < 1.5 * AW) return; // the town saves up for it
    for (const k of Object.keys(trial) as (ResKey | 'food')[]) {
      const cost = trial[k] ?? 0;
      if (k === 'food') s.food -= Math.min(cost, Math.max(0, s.food - 3 * s.pop));
      else s.res[k] -= Math.min(cost, Math.max(0, s.res[k] - (s.reserve?.[k] ?? 0)));
    }
  }
  tp.w -= AW; tp.n++; tp.la = day; tp.bl = 0;
  const L = ledgerOf(w, t.id);
  L.n++;
  const lead = w.people.get(tp.lead);
  const ps = attemptChance(t, tp.xp, lead && lead.alive ? lead : undefined, frac, prereqMin(s, t));
  if (w.rng.next() < ps) firstSuccess(w, s, t, tp, c);
  else failure(w, s, t, tp, ps, c);
}

export function firstSuccess(w: World, s: Settlement, t: TechDef, tp: TechProgress, c: Ctx | undefined) {
  const day = w.day;
  const L = ledgerOf(w, t.id);
  const worldFirst = L.first === -1;
  tp.st = 3; tp.m = tp.pk = tp.by ? M0_TAUGHT : M0_OWN; tp.d = day; tp.until = 0; tp.why = undefined; tp.w = 0;
  s.tech.add(t.id);
  const lead = w.people.get(tp.lead);
  const cul = w.cultures.get(s.culture);
  const civ = w.civs[s.civ - 1];
  if (lead && lead.alive) {
    lead.reputation = clamp(lead.reputation + 0.4, -1, 1);
    lead.status = clamp(lead.status + 0.25);
    lead.remember({ day, kind: 'experiment', text: `Made ${lc(t)} work at last`, valence: 0.9, intensity: 0.95, x: s.x, y: s.y });
    if (worldFirst && t.difficulty >= 100) lead.legend = true;
  }
  if (worldFirst) {
    L.first = day; L.by = lead?.id ?? 0; L.at = s.id; L.civ = s.civ; L.took = day - tp.d0; L.pre = [L.n, L.f, L.k];
  }
  const years = Math.max(1, yr(day - tp.d0));
  const fails = tp.f;
  const who = lead ? `${lead.name} of the ${civ?.name ?? cul?.name ?? 'people'}` : `the people of ${s.name}`;
  const prev = tp.pl.map((id) => w.people.get(id)).filter((p): p is Person => !!p).map((p) => `${p.name}${p.alive ? '' : ` († ${yr(p.death)})`}`);
  const pre = t.prereq.filter((q) => TECHS[q].difficulty >= 100).map((q) => `${lc(TECHS[q])} (${Math.round(mastery(s, q) * 100)}%)`);
  if (tp.by) {
    const from = w.settlements[tp.by - 1];
    w.history.record('TRADE', day, `${s.name} learned ${lc(t)} from ${from?.name ?? 'its neighbours'}${fails ? `, after ${fails} failed attempt${fails > 1 ? 's' : ''} of its own` : ''}.`, chron(w, t.difficulty > 100 ? 1 : 0, tp), {
      persons: lead ? [lead.id] : [], settlement: s.id, civ: s.civ, culture: s.culture, x: s.x, y: s.y,
      cause: `${years} year${years > 1 ? 's' : ''} of contact with ${from?.name ?? 'a town that knew it'}${from ? ` (mastery ${Math.round(mastery(from, t.id) * 100)}%, ${Math.round(distKm(s.x, s.y, from.x, from.y))} km away)` : ''}.`,
    });
  } else if (worldFirst) {
    const opening = fails ? `After ${years} year${years > 1 ? 's' : ''} and ${fails} failed attempt${fails > 1 ? 's' : ''}, ` : 'At the first attempt, ';
    const text = `${opening}${who} ${t.success} at ${s.name}.`;
    w.history.record('TECHNOLOGY_DISCOVERY', day, text + '\n' + t.impact.join('\n'), chron(w, t.era || t.difficulty >= 100 ? 3 : 2), {
      persons: lead ? [lead.id] : [], settlement: s.id, civ: s.civ, culture: s.culture, x: s.x, y: s.y,
      cause: `${s.name} (${s.pop} people${t.civPop ? `, drawing on the ${c?.civPop ?? s.pop} of the ${civ?.name ?? 'people'}` : ''}) built on ${pre.length ? pre.join(' and ') : 'what it already knew'}`
        + `${Object.keys(t.needs ?? {}).length ? ' with what it needed close at hand' : ''}`
        + `${prev.length ? `; ${prev.join(' and ')} had led the work before` : ''}`
        + `${L.pre[1] > fails ? `; across the world ${L.pre[1]} attempts had failed before this` : ''}`
        + `${L.pre[2] ? `; the work had cost ${L.pre[2]} li${L.pre[2] === 1 ? 'fe' : 'ves'}` : ''}.`,
    });
  } else {
    w.history.record('TECHNOLOGY_DISCOVERY', day, `${s.name} made ${lc(t)} work on its own${fails ? ` after ${fails} failed attempt${fails > 1 ? 's' : ''}` : ''}.`, chron(w, t.difficulty >= 100 ? 1 : 0, tp), {
      persons: lead ? [lead.id] : [], settlement: s.id, civ: s.civ, culture: s.culture, x: s.x, y: s.y,
      cause: `${years} year${years > 1 ? 's' : ''} of experiments led by ${lead?.name ?? 'its people'}.`,
    });
  }
  // what a first success changes at once
  if (t.id === 'writing' || t.id === 'mathematics' || t.id === 'engineering') {
    const lang = cul ? w.langs.get(cul.language) : undefined;
    if (lang) lang.writing = t.id === 'writing' ? 'pictographic' : t.id === 'mathematics' ? 'syllabic' : 'alphabetic';
  }
  if (t.id === 'agriculture' && s.nomadic) s.yearsSettled = Math.max(s.yearsSettled, 1);
}

function masteredAt(w: World, s: Settlement, t: TechDef, tp: TechProgress) {
  const day = w.day;
  tp.st = 5; tp.d = day;
  const L = ledgerOf(w, t.id);
  const worldFirst = L.mastered < 0;
  if (worldFirst) { L.mastered = day; L.mAt = s.id; }
  const civFirst = !w.settlements.some((o) => o !== s && o.civ === s.civ && o.abandoned < 0 && (o.prog?.[t.id]?.st ?? 0) === 5);
  const want = worldFirst ? (t.era ? 2 : t.difficulty >= 100 ? 1 : 0) : civFirst && t.difficulty >= 300 ? 1 : 0;
  const since = yr(day - (tp.d0 || day));
  w.history.record('MASTERY', day, `${t.name} was mastered at ${s.name}: ${t.impact[0].replace(/^\+ /, '')}.`, chron(w, want, tp, L, false), {
    settlement: s.id, civ: s.civ, culture: s.culture, x: s.x, y: s.y,
    cause: `${since} years of practice since the work began${tp.f ? `, through ${tp.f} failed attempt${tp.f > 1 ? 's' : ''}` : ''}.`,
  });
}

// ------------------------------------------------------------------ failure, accidents, loss
function failure(w: World, s: Settlement, t: TechDef, tp: TechProgress, ps: number, c: Ctx) {
  const day = w.day;
  const L = ledgerOf(w, t.id);
  const frontier = L.first < 0;
  tp.f++; L.f++;
  tp.xp = Math.min(XP_CAP, tp.xp + 1);
  const lead = w.people.get(tp.lead);
  if (lead) lead.reputation = clamp(lead.reputation - 0.02, -1, 1);
  const imp = lead ? lead.personality[P.impulsiveness] : 0.5, pat = lead ? lead.personality[P.patience] : 0.5;
  const bad = t.hazard !== 'none' && w.rng.next() < Math.min(0.95, BAD_P[t.hazard] * (1 - ps) * (0.7 + 0.6 * imp) * (1.2 - 0.4 * pat));
  const nth = ordinal(tp.f);
  if (!bad) {
    w.history.record('EXPERIMENT', day, `At ${s.name}, ${lead ? `${lead.name}'s` : 'an'} attempt at ${lc(t)} failed: ${t.miss} (attempt ${tp.n}).`, chron(w, frontier ? 1 : 0, tp), {
      persons: lead ? [lead.id] : [], settlement: s.id, civ: s.civ, culture: s.culture, x: s.x, y: s.y,
      cause: `No one had yet made it work; this attempt had about a ${Math.round(ps * 100)}% chance.`,
    });
    return;
  }
  const h = harm(w, s, t, c, Math.min(1 + Math.floor(0.03 * c.adults.length), Math.max(1, Math.round(t.danger * (0.5 + w.rng.next())))), true);
  if (h.dead.some((p) => p.id === tp.lead)) tp.lead = 0; // the survivors learned what went wrong: no lesson is lost
  const n = h.dead.length;
  tp.k += n; tp.g += n; L.k += n;
  const after = w.people.get(tp.lead);
  if (after && after.alive) after.remember({ day, kind: 'experiment', text: `Saw ${t.fail ?? t.miss}`, valence: -0.5, intensity: 0.6, x: s.x, y: s.y });
  const civ = w.civs[s.civ - 1];
  if (civ && civ.capital === s.id && n >= 2) civ.legitimacy = clamp(civ.legitimacy - 0.02, -1, 1);
  const victims = h.dead.slice(0, 2).map((p) => p.name);
  const killed = n ? `, killing ${victims.join(' and ')}${n > 2 ? ` and ${n - 2} other${n > 3 ? 's' : ''}` : ''}` : '';
  const wrecked = h.lost ? `${killed ? ' and' : ','} wrecking ${h.lost}` : '';
  const want = frontier && n >= 2 ? 2 : n || h.lost ? 1 : frontier ? 1 : 0;
  w.history.record('EXPERIMENT', day, `${cap1(t.fail ?? t.miss)} at ${s.name}${killed}${wrecked} — the town's ${nth} failed attempt at ${lc(t)}.`, chron(w, want, tp, L, frontier), {
    persons: [...(lead ? [lead.id] : []), ...h.dead.map((p) => p.id)], settlement: s.id, civ: s.civ, culture: s.culture, x: s.x, y: s.y,
    cause: frontier
      ? `No one had yet made it work; ${tp.f > 1 ? `${tp.f - 1} earlier failure${tp.f > 2 ? 's' : ''} gave` : 'it was the first try, and'} this attempt about a ${Math.round(ps * 100)}% chance.`
      : `${s.name} was still learning what others had already mastered.`,
  });
  // after deaths, a cautious people may forbid the work for a generation
  if (n > 0) {
    const ldr = w.people.get(s.leader);
    const fear = ldr ? ldr.personality[P.fearfulness] : 0.5;
    const pA = Math.min(0.6, 0.06 * tp.g * (1.3 - c.openness) * (0.7 + 0.6 * c.spirituality) * (0.7 + 0.6 * fear));
    if (w.rng.next() < pA) {
      tp.st = 1; tp.xp *= 0.8; tp.until = day + (15 + 15 * w.rng.next()) * Y; tp.why = 'deaths'; tp.w = 0; tp.lead = 0;
      const cul = w.cultures.get(s.culture);
      w.history.record('EXPERIMENT', day, `After ${tp.k} death${tp.k > 1 ? 's' : ''} the elders of ${s.name} forbade further experiments with ${lc(t)}.`, chron(w, 1, tp), {
        settlement: s.id, civ: s.civ, culture: s.culture, x: s.x, y: s.y,
        cause: `The ${cul?.name ?? 'people'}${c.openness < 0.4 ? ', a cautious people,' : ''} judged the work too dangerous; it may resume around ${yr(tp.until)}.`,
      });
    }
  }
}

/** Deaths and damage from a failed attempt or an accident: victims are chosen from the town (the lead first, in the riskiest arts). */
function harm(w: World, s: Settlement, t: TechDef, c: Ctx, n: number, leadFirst: boolean): { dead: Person[]; lost?: string } {
  const dead: Person[] = [];
  const pool = c.adults.filter((p) => p.alive);
  if (t.danger > 0 && n > 0 && pool.length) {
    const tp = s.prog[t.id];
    const lead = tp ? w.people.get(tp.lead) : undefined;
    if (leadFirst && lead && lead.alive && lead.home === s.id && (t.hazard === 'crash' || t.hazard === 'explosion' || t.hazard === 'wreck' || t.hazard === 'shock') && w.rng.next() < 0.6) dead.push(lead);
    for (let tries = 0; dead.length < n && tries < 3 * n; tries++) {
      const p = pool[w.rng.int(pool.length)];
      if (!p.alive || dead.includes(p)) continue;
      dead.push(p);
    }
    for (const p of dead) w.die(p, CAUSE[t.hazard]);
  }
  // damage to the town
  const B = w.buildings;
  const mine = B.of(s.id);
  const pickOf = (pred: (b: Building) => boolean): Building | undefined => {
    const cand = mine.filter(pred);
    return cand.length ? cand[w.rng.int(cand.length)] : undefined;
  };
  let lost: string | undefined;
  const ruin = (b: Building | undefined) => { if (b) { lost = `a ${BDEFS[b.kind].name.toLowerCase()}`; B.ruin(b); } };
  switch (t.hazard) {
    case 'fire':
      ruin(pickOf((b) => b.done >= 0 && (b.kind === 'workshop' || b.kind === 'kiln' || b.kind === 'smithy')) ?? pickOf((b) => b.done >= 0 && (b.kind === 'hut' || b.kind === 'house')));
      s.res.wood *= 0.9;
      break;
    case 'explosion':
      ruin(pickOf((b) => b.done >= 0 && (b.kind === 'workshop' || b.kind === 'smithy' || b.kind === 'factory' || b.kind === 'powerplant')));
      break;
    case 'collapse':
      ruin(pickOf((b) => b.done < 0 && b.kind !== 'field') ?? pickOf((b) => b.kind === 'stonehouse' || b.kind === 'temple' || b.kind === 'tower' || b.kind === 'wall' || b.kind === 'hall'));
      s.res.stone = Math.max(0, s.res.stone - 2 * (t.trial?.stone ?? 0));
      break;
    case 'wreck':
      s.ships = Math.max(0, s.ships - 1);
      break;
    case 'harvest':
      s.food *= 0.85;
      s.stress = clamp(s.stress + 0.05);
      break;
    default: break;
  }
  return { dead, lost };
}

function accident(w: World, s: Settlement, t: TechDef, tp: TechProgress, c: Ctx) {
  const day = w.day;
  const n = Math.min(w.rng.int(t.danger + 1), 1 + Math.floor(0.03 * c.adults.length));
  const h = harm(w, s, t, c, n, false);
  const L = ledgerOf(w, t.id);
  tp.k += h.dead.length; tp.g += h.dead.length; L.k += h.dead.length;
  tp.m = Math.min(1, tp.m + 0.01 * (1 - tp.m));
  if (!h.dead.length && !h.lost) return;
  const killed = h.dead.length ? `, killing ${h.dead.length === 1 ? h.dead[0].name : `${h.dead.length}`}` : '';
  w.history.record('EXPERIMENT', day, `${cap1(t.fail ?? t.miss)} at ${s.name}${killed}${h.lost ? `${killed ? ' and' : ','} wrecking ${h.lost}` : ''}.`, chron(w, h.dead.length >= 2 || h.lost ? 1 : 0, tp), {
    persons: h.dead.map((p) => p.id), settlement: s.id, civ: s.civ, culture: s.culture, x: s.x, y: s.y,
    cause: `${t.name} is still unreliable there (${Math.round(tp.m * 100)}% mastered).`,
  });
}

/** An art no longer practised well enough is lost; it is remembered (more so where it was written down). */
export function loseTech(w: World, s: Settlement, id: TechId, tp: TechProgress, c?: Ctx) {
  const day = w.day;
  const t = TECHS[id];
  s.tech.delete(id);
  tp.st = 1; tp.m = 0; tp.until = day + 10 * Y; tp.why = 'lost'; tp.w = 0; tp.lead = 0;
  tp.xp = Math.max(tp.xp, s.tech.has('printing') ? 6 : s.tech.has('writing') ? 4 : 2);
  const L = ledgerOf(w, id);
  const anywhere = w.settlements.some((o) => o.abandoned < 0 && o.tech.has(id));
  if (!anywhere) L.lost = day;
  const want = !anywhere ? 2 : s.peak >= t.minPop ? 1 : 0;
  w.history.record('KNOWLEDGE_LOST', day, `The art of ${lc(t)} was lost at ${s.name}${anywhere ? '' : ' — and with it, to the whole world'}.`, chron(w, want, tp, L, false), {
    settlement: s.id, civ: s.civ, culture: s.culture, x: s.x, y: s.y,
    cause: `${s.name} ${s.peak > s.pop * 1.5 ? `fell from ${s.peak} to ${s.pop} people and ` : ''}${s.tech.has('writing') ? 'could no longer keep it up' : 'kept no written records'}; too few still practised the craft.`,
  });
  void c;
}

/** Use of an art (a launch, a voyage) builds mastery beyond the slow growth of practice. */
export function practise(s: Settlement, id: TechId, k: number) {
  const tp = s.prog?.[id];
  if (tp && tp.st >= 3) tp.m = Math.min(1, tp.m + k * (1 - tp.m));
}

/** A shock — a collapse, a sack — scatters scholars and idles workshops. */
export function shock(s: Settlement, f: number) {
  if (!s.prog) return;
  for (const id of TECH_IDS) {
    const tp = s.prog[id];
    if (!tp || TECHS[id].difficulty < 300) continue;
    if (tp.st >= 3) tp.m *= f;
    else if (tp.st === 2) { tp.w = 0; tp.xp *= 0.8; tp.lead = 0; }
  }
}

// ------------------------------------------------------------------ teaching
/** Ideas and lessons travel between towns in contact; mastery is approached, never copied. */
function teach(w: World, living: Settlement[], cx: Map<number, Ctx>) {
  const n = living.length;
  if (n < 2) return;
  const step = n > 300 ? 3 : 1;
  for (let a = 0; a < n; a += 1) {
    const A = living[a];
    for (let b = a + 1; b < n; b += step) {
      const B = living[b];
      const d = distKm(A.x, A.y, B.x, B.y);
      const range = A.civ === B.civ ? Math.max(400, contactRange(A), contactRange(B)) : Math.max(contactRange(A), contactRange(B));
      if (d > range) continue;
      const cA = w.cultures.get(A.culture)!;
      const cB = w.cultures.get(B.culture)!;
      const contact = (1 - d / range) * (0.5 + 0.25 * (cA.values[5] + cB.values[5])) * (A.culture === B.culture ? 1 : 0.55) * (A.civ === B.civ ? 2 : 1)
        * (w.tradePairs.has(A.id < B.id ? `${A.id}:${B.id}` : `${B.id}:${A.id}`) ? 1.8 : 1);
      for (const [from, to, tc] of [[A, B, cB], [B, A, cA]] as [Settlement, Settlement, typeof cA][]) {
        for (const id of TECH_IDS) {
          if (!from.tech.has(id)) continue;
          const fm = mastery(from, id);
          if (fm < TEACH_MIN) continue; // the inventors keep a head start
          const t = TECHS[id];
          if (to.pop < 0.5 * t.minPop || !t.prereq.every((q) => to.tech.has(q))) continue;
          const pc = 1 - Math.exp(-0.18 * contact * (0.3 + tc.values[0]));
          if (!to.prog) to.prog = {};
          const tp = to.prog[id];
          if (!tp) {
            if (w.rng.next() < pc) {
              const r = record(w.day, 1, from.id);
              r.xp = 1;
              to.prog[id] = r;
              w.history.record('TRADE', w.day, `Word of ${lc(t)} reached ${to.name} from ${from.name}.`, 0, { settlement: to.id, civ: to.civ, x: to.x, y: to.y, cause: `Contact between neighbouring settlements (${Math.round(d)} km apart).` });
            }
            continue;
          }
          if (tp.st <= 2) {
            tp.xp = Math.min(XP_CAP, tp.xp + 4 * pc * fm);
            if (!tp.by) tp.by = from.id;
            if (tp.until > w.day && from.civ === to.civ) tp.until = 0;
            continue;
          }
          if (tp.m < fm) tp.m = Math.min(fm, tp.m + 0.08 * pc * (fm - tp.m));
        }
      }
    }
  }
  void cx;
}

// ------------------------------------------------------------------ carrying knowledge, saves, tests
/** What a departing group carries: most of a simple art, three quarters of a hard one. */
export function knowOf(s: Settlement): Partial<Record<TechId, number>> {
  const out: Partial<Record<TechId, number>> = {};
  for (const id of TECH_IDS) {
    if (!s.tech.has(id)) continue;
    const m = mastery(s, id);
    out[id] = TECHS[id].difficulty >= 100 ? 0.75 * m : m;
  }
  return out;
}

export function progFromKnow(tech: Set<TechId>, know: Partial<Record<TechId, number>> | undefined, day: number): Partial<Record<TechId, TechProgress>> {
  const prog: Partial<Record<TechId, TechProgress>> = {};
  for (const id of TECH_IDS) {
    if (!tech.has(id)) continue;
    const m = Math.min(0.9, know?.[id] ?? 0.5);
    const r = record(day, m >= MASTERED ? 5 : m >= REFINED ? 4 : 3);
    r.m = r.pk = m;
    prog[id] = r;
  }
  return prog;
}

/** Saves from before research records: every known art counts as long practised. */
export function progFromTech(tech: Set<TechId>, day: number): Partial<Record<TechId, TechProgress>> {
  const prog: Partial<Record<TechId, TechProgress>> = {};
  for (const id of TECH_IDS) {
    if (!tech.has(id)) continue;
    const r = record(day, 5);
    r.m = r.pk = 0.9;
    prog[id] = r;
  }
  return prog;
}

export function upgradeV3(w: World) {
  for (const s of w.settlements) {
    if (s.tech.has('navigation') && s.tech.has('astronomy')) s.tech.add('seafaring');
    s.prog = s.abandoned < 0 ? progFromTech(s.tech, w.day) : {};
  }
  for (const b of w.bands.values()) if (b.tech.has('navigation') && b.tech.has('astronomy')) b.tech.add('seafaring');
}

export function migrateResearch(w: World): Research {
  const r = newResearch();
  for (const id of TECH_IDS) {
    const t = TECHS[id];
    const ev = w.history.events.find((e) => e.type === 'TECHNOLOGY_DISCOVERY' && e.weight >= 3 && e.text.includes(t.description));
    const known = w.settlements.some((s) => s.tech.has(id));
    if (!ev && !known) continue;
    const L: Ledger = { first: ev ? ev.day : -2, by: ev?.persons?.[0] ?? 0, at: ev?.settlement ?? 0, civ: ev?.civ ?? 0, took: 0, pre: [0, 0, 0], p: 0, mastered: ev ? ev.day : -2, mAt: ev?.settlement ?? 0, n: 0, f: 0, k: 0, big: -1e9, lost: -1 };
    r.ledger[id] = L;
  }
  const progs = [...w.space.programs.values()];
  const sat = progs.filter((p) => p.firstSatellite >= 0).map((p) => p.firstSatellite);
  const moon = progs.filter((p) => p.moonLanding >= 0).map((p) => p.moonLanding);
  const feat = (first: number): Ledger => ({ first, by: 0, at: 0, civ: 0, took: 0, pre: [0, 0, 0], p: 0, mastered: -1, mAt: 0, n: 0, f: 0, k: 0, big: -1e9, lost: -1 });
  if (sat.length) r.ledger.satellite = feat(Math.min(...sat));
  if (progs.some((p) => p.crewed > 0)) r.ledger.orbit = feat(w.history.events.find((e) => e.type === 'DISCOVERY' && e.text.includes('first person to orbit'))?.day ?? -2);
  if (moon.length) r.ledger.moon = feat(Math.min(...moon));
  return r;
}

/** Tests: force one attempt's outcome at a town (creating the programme if needed). */
export function forceAttempt(w: World, s: Settlement, id: TechId, outcome: 'success' | 'fail' | 'bad') {
  const t = TECHS[id];
  const c = contextOf(w, s);
  if (!s.prog) s.prog = {};
  let tp = s.prog[id];
  if (!tp || tp.st !== 2) { tp = record(w.day, 2); tp.lead = pickLead(w, s, t, c); s.prog[id] = tp; }
  tp.n++;
  ledgerOf(w, id).n++;
  if (outcome === 'success') firstSuccess(w, s, t, tp, c);
  else if (outcome === 'fail') failure(w, s, { ...t, hazard: 'none' }, tp, 0.1, c);
  else failure(w, s, t, tp, 0, c);
}

/** For the panels: the stage of a town's work on an art. */
export function stageOf(s: Settlement, id: TechId): Stage | 0 {
  return s.prog?.[id]?.st ?? (s.tech.has(id) ? 5 : 0);
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
function cap1(t: string): string {
  return t.charAt(0).toUpperCase() + t.slice(1);
}
