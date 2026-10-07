import type { World } from './world';
import type { Person } from './people';
import { SK } from './people';
import type { Settlement } from './settlements';
import type { NodeKind } from './resources';
import { BDEFS, Building, ResKey } from './buildings';
import { Pop } from './ecology';
import { NR, W, KM_PER_CELL_Y, kmPerCellX, wrapDx, regionOfCell, idx, wrapX } from './grid';
import { clamp, mix32 } from './rng';
import { seasonOf } from './time';
import { WALK_KMH as WALK, kmTo, walk } from './behavior';
import { eff, travelMult, workMult, yieldMult } from './techfx';

/** The physical work loop. A person walks to a real node of a real resource, works there for a number of hours that
 *  depends on tools and skill, carries a load home and deposits it at the stockpile. Fields, buildings, kilns and
 *  caravans follow the same shape. At coarse time steps the same loop is simply repeated. */

const CAP: Record<string, number> = { food: 14, wood: 24, stone: 16, clay: 20, copper: 14, iron: 14, coal: 16, gold: 6 };
// units per hour at tool tier 0 / 1 / 2
const RATE: Record<string, [number, number, number]> = {
  wood: [0.45, 1.5, 3], stone: [0.3, 1.2, 2.2], clay: [1, 2, 2.4], copper: [0, 0.8, 2], iron: [0, 0.7, 1.9], coal: [0, 1.1, 2.4], gold: [0, 0.15, 0.3],
  berry: [0.6, 0.6, 0.7], fish: [0.3, 0.55, 0.8],
};
const NODE_ORDER = ['tree', 'bush', 'stone', 'clay', 'fish', 'copper', 'iron', 'coal', 'gold'];
const KIND_TO_RES: Partial<Record<NodeKind, ResKey>> = { tree: 'wood', stone: 'stone', clay: 'clay', copper: 'copper', iron: 'iron', coal: 'coal', gold: 'gold' };

export const FIELD_HOURS = { plant: 60, weed: 30, harvest: 160 };
export const GROW_DAYS = 125;

function home(s: Settlement, p: Person) {
  // a deterministic spot in the yard so a crowd does not stand on one pixel
  const h = mix32(p.id, 7);
  const r = 0.006 + ((h % 100) / 100) * 0.03;
  const a = ((h >>> 8) % 628) / 100;
  return { x: s.x + (Math.cos(a) * r) / kmPerCellX(s.y), y: s.y + (Math.sin(a) * r) / KM_PER_CELL_Y };
}

export function skillMult(p: Person, k: number) {
  return 0.7 + 0.8 * Math.min(1, p.skills[k]);
}

function nodePos(w: World, p: Person) {
  const n = w.res.nodes(p.tcell)[p.tslot];
  return n ? { x: n.x, y: n.y } : null;
}

function dropCargo(w: World, p: Person, s: Settlement) {
  if (p.cargoAmt > 0 && p.cargo) deposit(w, p, s);
  p.task = '';
  p.phase = 0;
  p.cargo = '';
  p.cargoAmt = 0;
}

function deposit(w: World, p: Person, s: Settlement) {
  if (p.cargo === 'food') {
    s.food += p.cargoAmt;
    s.produced += p.cargoAmt;
  } else if (p.cargo) {
    s.res[p.cargo as ResKey] += p.cargoAmt;
  }
  p.cargo = '';
  p.cargoAmt = 0;
}

/** Choose and start a task. Returns false when there is nothing physical to do (caller falls back to wild foraging). */
function choose(w: World, p: Person, s: Settlement, fine0 = false): boolean {
  const day = w.day;
  const rng = w.rng;
  const tier = s.toolTier;
  p.task = '';
  p.phase = 0;
  p.timer = 0;
  const trip = (kinds: NodeKind[], task: NodeKind extends never ? never : any, hold = 1): boolean => {
    // a failed search is remembered for a few days so a crowd does not repeat it
    const failed = s.scarce[kinds[0]];
    if (failed !== undefined && day - failed < (fine0 ? 0.3 : 4)) return false;
    const cacheable = true;
    const ck = s.id * 16 + NODE_ORDER.indexOf(kinds[0]);
    if (cacheable) {
      const c = w.findCache.get(ck);
      if (c && day - c.day < 15 && w.res.amount(c.cell, c.slot, day) > (kinds[0] === 'bush' || kinds[0] === 'fish' ? 4 : 6)) {
        p.task = task; p.tcell = c.cell; p.tslot = c.slot; p.phase = 1; p.timer = 0;
        return true;
      }
    }
    let r = s.range;
    let f = w.res.find(kinds, s.x, s.y, r, day, s.id);
    if (!f && r < 30) f = w.res.find(kinds, s.x, s.y, r * 2.2, day, s.id);
    if (!f) { s.scarce[kinds[0]] = day; return false; }
    if (cacheable) w.findCache.set(ck, { cell: f.cell, slot: f.slot, day });
    p.task = task;
    p.tcell = f.cell;
    p.tslot = f.slot;
    p.phase = 1;
    p.timer = 0;
    void hold;
    return true;
  };
  switch (p.occupation) {
    case 'woodcutter':
      return trip(['tree'], 'chop');
    case 'miner': {
      // work on whatever the community needs most and can actually find
      const opts: [string, NodeKind[], string, number][] = [
        ['stone', ['stone'], 'quarry', s.need.stone ?? 0],
        ['clay', ['clay'], 'clay', s.need.clay ?? 0],
        ['ore', ['copper', 'iron'], 'mine', s.need.ore ?? 0],
        ['coal', ['coal'], 'mine', s.need.coal ?? 0],
        ['gold', ['gold'], 'mine', s.tech.has('metallurgy') ? 0.05 : 0],
      ];
      opts.sort((a, b) => b[3] + rng.next() * 0.1 - (a[3] + rng.next() * 0.1));
      for (const [, kinds, task, need] of opts) {
        if (need <= 0.02 && kinds[0] !== 'stone') continue;
        if (tier === 0 && kinds[0] !== 'stone' && kinds[0] !== 'clay') continue;
        if (trip(kinds, task)) return true;
        if (kinds.some((k) => ['copper', 'iron', 'coal', 'gold', 'clay'].includes(k))) { p.task = 'prospect'; p.phase = 1; pickProspect(w, p, s); return true; }
      }
      return trip(['stone'], 'quarry');
    }
    case 'forager':
      if (rng.next() < 0.5) {
        if (trip(['bush'], 'berry')) return true;
        if (trip(['fish'], 'fish')) return true;
      }
      return false;
    case 'hunter':
      return startHunt(w, p, s);
    case 'farmer':
      return startField(w, p, s);
    case 'builder': {
      const proj = projectFor(w, s);
      if (proj) { p.task = 'build'; p.tb = proj.id; p.phase = 1; return true; }
      // no building site: bring in the next material the community is short of
      const wants: [NodeKind, string, number][] = [['tree', 'chop', s.need.wood ?? 0], ['stone', 'quarry', s.need.stone ?? 0], ['clay', 'clay', s.need.clay ?? 0]];
      wants.sort((a, b) => b[2] - a[2]);
      for (const [k, t] of wants) if (trip([k], t)) return true;
      return false;
    }
    case 'crafter': {
      if (s.goods > 12 + s.pop * 1.5 && s.res.copper + s.res.iron < 3 && s.res.clay < 30) return false; // nothing worth making right now
      const b = craftSite(w, s);
      p.task = 'craft';
      p.tb = b ? b.id : 0;
      p.phase = 1;
      return true;
    }
    case 'trader':
      return false; // missions are assigned by the economy planner
    case 'explorer':
      if ((s.need.ore ?? 0) > 0.1 || (s.need.clay ?? 0) > 0.1 || rng.next() < 0.3) { p.task = 'prospect'; p.phase = 1; pickProspect(w, p, s); return true; }
      return false;
    default:
      return false;
  }
}

function pickProspect(w: World, p: Person, s: Settlement) {
  const a = w.rng.next() * Math.PI * 2;
  const r = s.range * (0.3 + w.rng.next() * 1.6);
  p.hasTarget = true;
  p.ty = clamp(s.y + (Math.sin(a) * r) / KM_PER_CELL_Y, 1, 126);
  p.tx = s.x + (Math.cos(a) * r) / kmPerCellX(p.y);
}

// ---------------- construction & crafts ----------------
export function projectFor(w: World, s: Settlement): Building | undefined {
  let best: Building | undefined;
  for (const b of w.buildings.of(s.id)) {
    if (b.done >= 0 || b.progress >= 1) continue;
    if (!best || b.started < best.started) best = b;
  }
  return best;
}

function craftSite(w: World, s: Settlement): Building | undefined {
  const bs = w.buildings.of(s.id).filter((b) => b.done >= 0 && (b.kind === 'workshop' || b.kind === 'kiln' || b.kind === 'smithy'));
  if (!bs.length) return undefined;
  // smithy first when ore is waiting, kiln if clay, else workshop
  const pref = (b: Building) => (b.kind === 'smithy' && (s.res.copper + s.res.iron) > 2 ? 3 : b.kind === 'kiln' && s.res.clay > 8 ? 2 : b.kind === 'workshop' ? 1 : 0);
  bs.sort((a, b) => pref(b) - pref(a));
  return bs[0];
}

// ---------------- hunting ----------------
function startHunt(w: World, p: Person, s: Settlement): boolean {
  const eco = w.eco;
  const rad = Math.ceil(s.range / (KM_PER_CELL_Y * 4)) + 1;
  const cr = Math.floor(s.y / 4), cx = Math.floor(s.x / 4);
  let best: { pop: Pop; m: number; d: number } | null = null;
  for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
    const ry = cr + dy;
    if (ry < 0 || ry >= 32) continue;
    const r = ry * 64 + ((cx + dx + 64) % 64);
    for (const pop of eco.popsInRegion(r)) {
      const sp = eco.speciesById(pop.sp);
      if (sp.diet === 'carn' || pop.n < 3 || pop.t.size < 0.25) continue;
      const k = eco.markerCount(pop);
      for (let m = 0; m < Math.min(k, 4); m++) {
        const pos = eco.markerPos(pop, m, w.day);
        if (!pos) continue;
        const d = kmTo({ x: s.x, y: s.y }, pos.x, pos.y);
        if (d <= s.range * 2.2 && (!best || d < best.d)) best = { pop, m, d };
      }
    }
  }
  if (!best) { s.scarce['game'] = w.day; return false; }
  p.task = 'hunt';
  p.tcell = best.pop.r;
  p.tslot = best.pop.sp;
  p.tb = best.m;
  p.phase = 1;
  p.timer = 0;
  return true;
}

function huntTarget(w: World, p: Person): { pop: Pop; pos: { x: number; y: number } } | null {
  const pop = w.eco.pops.get(p.tslot * NR + p.tcell);
  if (!pop || pop.n < 1.5) return null;
  const pos = w.eco.markerPos(pop, p.tb, w.day);
  return pos ? { pop, pos } : null;
}

// ---------------- fields ----------------
function startField(w: World, p: Person, s: Settlement): boolean {
  if (!s.tech.has('agriculture')) return false;
  const fields = w.buildings.of(s.id).filter((b) => b.kind === 'field' && b.done >= 0);
  const season = seasonOf(w.day);
  let pick: { b: Building; act: number } | null = null;
  // 3 harvest, 2 weed, 1 plant
  for (const b of fields) if (b.fstate === 2) { pick = { b, act: 3 }; break; }
  if (!pick) for (const b of fields) if (b.fstate === 1 && b.weeds > 0.3) { pick = { b, act: 2 }; break; }
  if (!pick && (season === 0 || season === 1)) for (const b of fields) if (b.fstate === 0) { pick = { b, act: 1 }; break; }
  if (pick) {
    p.task = 'field';
    p.tb = pick.b.id;
    p.tslot = pick.act;
    p.phase = 1;
    p.timer = 0;
    return true;
  }
  // a new field being cleared?
  const clearing = w.buildings.of(s.id).find((b) => b.kind === 'field' && b.done < 0 && b.progress < 1);
  if (clearing) { p.task = 'build'; p.tb = clearing.id; p.phase = 1; return true; }
  const want = fieldsWanted(w, s);
  if (fields.length < want && !(s.scarce['field'] !== undefined && w.day - s.scarce['field'] < 20)) {
    if (w.buildings.start(s, 'field', false)) return startField(w, p, s);
    s.scarce['field'] = w.day; // nowhere left to clear
  }
  return false;
}

export function fieldsWanted(w: World, s: Settlement): number {
  const farmers = s.occupations['farmer'] ?? 0;
  const byLand = Math.ceil(farmers * 6);
  const byNeed = Math.ceil((s.pop * 0.7 * 365) / 420);
  return Math.max(1, Math.min(byLand, byNeed + 1, 60));
}

export function fieldYield(w: World, s: Settlement, b: Building, skill: number): number {
  const cell = idx(wrapX(Math.floor(b.x)), Math.floor(b.y));
  const reg = regionOfCell(cell % W, Math.floor(cell / W));
  // with live weather, drought and frost have already marked the crop as it grew; otherwise use the regional anomaly
  const rain = w.weather.seasonsObserved > 2 ? clamp(0.9 + 0.15 * w.env.anomaly[reg], 0.9, 1.15) : clamp(Math.pow(w.env.anomaly[reg], 1.1), 0.1, 1.25);
  let y = 480 * (0.25 + w.env.fert[cell]) * rain * (0.7 + 0.7 * skill) * (1 - 0.6 * clamp(b.weeds)) * (1 - clamp(b.crop)) * yieldMult(s);
  y *= 1 + 0.15 * eff(s, 'tools');
  if (s.toolTier >= 2) y *= 1.15;
  y *= 1 + 0.12 * eff(s, 'mathematics');
  y *= 1 + 0.25 * eff(s, 'engineering');
  // overripe crops spoil in the field
  const late = Math.max(0, w.day - (b.planted + GROW_DAYS) - 45);
  y *= clamp(1 - late / 120, 0.35, 1);
  w.env.fert[cell] = clamp(w.env.fert[cell] - 0.012);
  w.env.cultivated[cell] = 1;
  return y;
}

// ---------------- the loop ----------------
export function runJob(w: World, p: Person, s: Settlement, dtDays: number, fine: boolean): boolean {
  const rng = w.rng;
  let hours = dtDays * 24 * (fine ? 1 : 0.5);
  // vehicles shorten trips; machines multiply what an hour of work produces
  const WALK_KMH = WALK * travelMult(s);
  const machine = workMult(s);
  const tier = s.toolTier;
  let guard = 0;
  let didSomething = false;
  while (hours > 1e-6 && guard++ < 14) {
    if (p.phase === 0 || !p.task) {
      if (!choose(w, p, s, fine)) return didSomething;
    }
    didSomething = true;
    const task = p.task;
    switch (task) {
      // ---------- gather trips: chop, quarry, mine, clay, berry, fish ----------
      case 'chop': case 'quarry': case 'mine': case 'clay': case 'berry': case 'fish': {
        const node = w.res.nodes(p.tcell)[p.tslot];
        if (!node) { p.phase = 0; break; }
        const kind = node.kind;
        const res = KIND_TO_RES[kind];
        const key = kind === 'tree' ? 'wood' : kind === 'bush' ? 'berry' : kind;
        if (p.phase === 1) {
          const tgt = nodePos(w, p)!;
          const dkm = kmTo(p, tgt.x, tgt.y);
          const need = dkm / WALK_KMH;
          if (need <= hours) { p.x = tgt.x; p.y = tgt.y; hours -= need; p.phase = 2; p.timer = 0; }
          else { walk(w, p, tgt.x, tgt.y, hours * WALK_KMH, false); hours = 0; }
          break;
        }
        if (p.phase === 2) {
          const tgt = nodePos(w, p)!;
          if (kmTo(p, tgt.x, tgt.y) > 0.12) { p.phase = 1; break; }
          const skillIdx = kind === 'tree' ? SK.woodcutting : kind === 'bush' || kind === 'fish' ? SK.foraging : SK.mining;
          let rate = RATE[key][Math.min(2, tier)] * skillMult(p, skillIdx) * machine;
          if (kind === 'tree') rate *= 1 - 0.45 * w.flora.at(regionOfCell(p.tcell % W, Math.floor(p.tcell / W))).hardness * (tier === 0 ? 1.5 : 1);
          // the catch depends on the fish actually in the water, and boats reach the richer grounds offshore
          if (kind === 'fish') rate *= w.marine.fishery(tgt.x, tgt.y) * (1 + Math.min(1, s.ships * 0.08));
          if (rate <= 0.01) { s.scarce['tools'] = w.day; p.phase = 0; p.task = ''; break; }
          const cargoKind = kind === 'bush' || kind === 'fish' ? 'food' : res!;
          const cap = CAP[cargoKind];
          const treeWood = kind === 'tree' ? w.flora.at(regionOfCell(p.tcell % W, Math.floor(p.tcell / W))).wood : 1;
          const have = w.res.amount(p.tcell, p.tslot, w.day) * treeWood;
          const target = Math.min(cap - p.cargoAmt, have);
          if (target <= 0.05) { p.phase = p.cargoAmt > 0 ? 3 : 0; break; }
          const needH = target / rate - p.timer;
          if (needH <= hours) {
            hours -= Math.max(0, needH);
            const taken = w.res.take(p.tcell, p.tslot, target / treeWood, w.day) * treeWood;
            p.cargo = cargoKind;
            p.cargoAmt += taken;
            p.timer = 0;
            p.phase = 3;
            if (kind === 'fish') w.marine.take(tgt.x, tgt.y, taken);
            if (kind === 'tree') p.skills[SK.woodcutting] = Math.min(1, p.skills[SK.woodcutting] + 0.004);
            else if (kind === 'bush' || kind === 'fish') p.skills[SK.foraging] = Math.min(1, p.skills[SK.foraging] + 0.002);
            else p.skills[SK.mining] = Math.min(1, p.skills[SK.mining] + 0.004);
          } else { p.timer += hours; hours = 0; }
          break;
        }
        // phase 3: carry it home
        {
          const h = home(s, p);
          const dkm = kmTo(p, h.x, h.y);
          const need = dkm / (WALK_KMH * 0.85);
          if (need <= hours) {
            p.x = h.x; p.y = h.y; hours -= need;
            const unit = p.cargoAmt;
            deposit(w, p, s);
            p.phase = 0;
            // coarse steps: repeat the same trip for as long as the time lasts
            if (!fine && hours > 1) {
              const trip = need * 2 + unit / Math.max(0.1, RATE[key][Math.min(2, tier)] * 0.9);
              const reps = Math.min(Math.floor(hours / Math.max(trip, 0.5)), 240);
              for (let i = 0; i < reps; i++) {
                const tw = kind === 'tree' ? w.flora.at(regionOfCell(p.tcell % W, Math.floor(p.tcell / W))).wood : 1;
                const got = w.res.take(p.tcell, p.tslot, Math.min(unit, CAP[kind === 'bush' || kind === 'fish' ? 'food' : res!]) / tw, w.day) * tw;
                if (got <= 0.05) break;
                if (kind === 'bush' || kind === 'fish') { s.food += got; s.produced += got; } else s.res[res!] += got;
                if (kind === 'fish') { const nd = w.res.nodes(p.tcell)[p.tslot]; w.marine.take(nd.x, nd.y, got); }
                hours -= trip;
              }
              hours = Math.max(0, hours);
            }
          } else { walk(w, p, h.x, h.y, hours * WALK_KMH, false); hours = 0; }
        }
        break;
      }
      // ---------- hunting ----------
      case 'hunt': {
        const tg = huntTarget(w, p);
        if (!tg) { p.task = ''; p.phase = 0; break; }
        if (p.phase === 1) {
          const dkm = kmTo(p, tg.pos.x, tg.pos.y);
          const need = dkm / (WALK_KMH * 1.1);
          if (need <= hours) { p.x = tg.pos.x; p.y = tg.pos.y; hours -= need; p.phase = 2; p.timer = 0; }
          else { walk(w, p, tg.pos.x, tg.pos.y, hours * WALK_KMH, false); hours = 0; }
          break;
        }
        if (p.phase === 2) {
          const chase = 1 + tg.pop.t.speed * 3 + tg.pop.t.size * 0.3;
          const gear = tier >= 2 ? 1.35 : tier === 1 ? 1.15 : 0.8;
          const needH = chase / (skillMult(p, SK.hunting) * gear) - p.timer;
          if (needH <= hours) {
            hours -= Math.max(0, needH);
            const prob = clamp(0.28 + 0.4 * p.skills[SK.hunting] + 0.15 * gear + 0.15 * p.personality[3] - tg.pop.t.speed * 0.35 - tg.pop.t.size * 0.02, 0.08, 0.92);
            p.timer = 0;
            if (rng.next() < prob) {
              const meat = w.eco.killAnimal(tg.pop);
              if (meat > 0) {
                p.cargo = 'food';
                p.cargoAmt = Math.min(CAP.food * 3, meat);
                p.skills[SK.hunting] = Math.min(1, p.skills[SK.hunting] + 0.01);
                if (tg.pop.t.size > 2.5 && rng.next() < 0.06 * (1 - p.skills[SK.hunting])) {
                  p.health = clamp(p.health - 0.3);
                  p.remember({ day: w.day, kind: 'disaster', text: 'Gored while hunting', valence: -0.5, intensity: 0.6, x: p.x, y: p.y });
                }
              }
              p.phase = p.cargoAmt > 0 ? 3 : 0;
            } else { p.phase = 0; p.skills[SK.hunting] = Math.min(1, p.skills[SK.hunting] + 0.003); }
          } else { p.timer += hours; hours = 0; }
          break;
        }
        {
          const h = home(s, p);
          const need = kmTo(p, h.x, h.y) / (WALK_KMH * 0.7);
          if (need <= hours) { p.x = h.x; p.y = h.y; hours -= need; deposit(w, p, s); p.phase = 0; }
          else { walk(w, p, h.x, h.y, hours * WALK_KMH * 0.7, false); hours = 0; }
        }
        break;
      }
      // ---------- farming ----------
      case 'field': {
        const b = w.buildings.get(p.tb);
        if (!b || b.done < 0) { p.task = ''; p.phase = 0; break; }
        if (p.phase === 1) {
          const need = kmTo(p, b.x, b.y) / WALK_KMH;
          if (need <= hours) { p.x = b.x; p.y = b.y; hours -= need; p.phase = 2; p.timer = 0; }
          else { walk(w, p, b.x, b.y, hours * WALK_KMH, false); hours = 0; }
          break;
        }
        const act = p.tslot;
        const total = act === 3 ? FIELD_HOURS.harvest : act === 2 ? FIELD_HOURS.weed : FIELD_HOURS.plant;
        if ((act === 3 && b.fstate !== 2) || (act === 1 && b.fstate !== 0) || (act === 2 && b.fstate !== 1)) { p.phase = 0; p.task = ''; break; }
        const mult = skillMult(p, SK.farming) * (tier >= 1 ? 1.2 : 1) * machine;
        const need = (total - p.timer * mult) / mult;
        if (need <= hours) {
          hours -= Math.max(0, need);
          p.timer = 0;
          p.skills[SK.farming] = Math.min(1, p.skills[SK.farming] + 0.006);
          if (act === 1) { b.fstate = 1; b.planted = w.day; b.weeds = 0.05; b.crop = 0; s.food = Math.max(0, s.food - 4); }
          else if (act === 2) b.weeds = 0.05;
          else {
            const y = fieldYield(w, s, b, p.skills[SK.farming]);
            s.food += y;
            s.produced += y;
            b.fstate = 0;
            b.weeds = 0;
            b.planted = -1;
          }
          p.phase = 0;
          p.task = '';
        } else { p.timer += hours; hours = 0; }
        break;
      }
      // ---------- building ----------
      case 'build': {
        const b = w.buildings.get(p.tb);
        if (!b || b.done !== -1) { p.task = ''; p.phase = 0; break; }
        if (p.phase === 1) {
          const need = kmTo(p, b.x, b.y) / WALK_KMH;
          if (need <= hours) { p.x = b.x; p.y = b.y; hours -= need; p.phase = 2; }
          else { walk(w, p, b.x, b.y, hours * WALK_KMH, false); hours = 0; }
          break;
        }
        const q = (0.7 + 0.8 * Math.min(1, p.skills[SK.building])) * (tier >= 1 ? 1.15 : 1) * machine;
        const left = (1 - b.progress) * BDEFS[b.kind].labor / q;
        const use = Math.min(hours, left);
        const finished = w.buildings.work(b, use, q);
        p.skills[SK.building] = Math.min(1, p.skills[SK.building] + use * 0.0004);
        hours -= use;
        if (finished) { w.buildingDone(b, s, p); p.task = ''; p.phase = 0; }
        else hours = 0;
        break;
      }
      // ---------- crafting ----------
      case 'craft': {
        const bb = p.tb ? w.buildings.get(p.tb) : undefined;
        const b = bb && bb.done >= 0 ? bb : undefined; // a ruined workshop is no workshop
        const spot = b ? { x: b.x, y: b.y } : { x: s.x, y: s.y };
        if (p.phase === 1) {
          const need = kmTo(p, spot.x, spot.y) / WALK_KMH;
          if (need <= hours) { p.x = spot.x; p.y = spot.y; hours -= need; p.phase = 2; }
          else { walk(w, p, spot.x, spot.y, hours * WALK_KMH, false); hours = 0; }
          break;
        }
        const sk = skillMult(p, SK.crafting);
        const kind = b?.kind ?? 'workshop';
        let made = 0;
        if (kind === 'smithy') {
          const ore = s.res.copper + s.res.iron;
          const fuel = s.res.coal + s.res.wood / 4;
          const units = Math.min(hours / 3 * sk, ore / 2, fuel);
          if (units > 0.01) {
            const useCu = Math.min(s.res.copper, units * 2);
            s.res.copper -= useCu;
            s.res.iron -= units * 2 - useCu;
            const useCoal = Math.min(s.res.coal, units);
            s.res.coal -= useCoal;
            s.res.wood -= (units - useCoal) * 4;
            s.res.metal += units;
            made = units;
          }
        } else if (kind === 'kiln') {
          const units = Math.min(hours / 2 * sk, s.res.clay / 2, (s.res.wood + 1) / 1);
          if (units > 0.01) { s.res.clay -= units * 2; s.res.wood -= Math.min(s.res.wood, units * 0.5); s.goods += units; made = units; }
        } else {
          const rateMul = b ? 1 : 0.4;
          // crafts use only what is not set aside for a great work
          const woodFree = Math.max(0, s.res.wood - (s.reserve?.wood ?? 0)), stoneFree = Math.max(0, s.res.stone - (s.reserve?.stone ?? 0));
          const units = Math.min(hours / 2 * sk * rateMul, woodFree, stoneFree / 0.5 + 99);
          if (units > 0.01) { s.res.wood -= units; s.res.stone -= Math.min(stoneFree, units * 0.5); s.goods += units; made = units; }
        }
        p.skills[SK.crafting] = Math.min(1, p.skills[SK.crafting] + hours * 0.0004);
        if (made <= 0.01) { s.scarce['craft'] = w.day; p.task = ''; p.phase = 0; hours = 0; } else hours = 0;
        break;
      }
      // ---------- prospecting: walking the hills looking for ore, clay and coal ----------
      case 'prospect': {
        if (!p.hasTarget) pickProspect(w, p, s);
        const dkm = kmTo(p, p.tx, p.ty);
        const need = dkm / WALK_KMH;
        const found = (px: number, py: number) => {
          const rev = w.res.prospect(s.id, px, py, 2.2);
          for (const r of rev) {
            w.nodeFound(s, r.node.kind, p);
            p.skills[SK.exploring] = Math.min(1, p.skills[SK.exploring] + 0.01);
          }
        };
        if (need <= hours) { walk(w, p, p.tx, p.ty, dkm, false, 0.05); hours -= need; found(p.x, p.y); p.hasTarget = false; p.task = ''; p.phase = 0; }
        else {
          const f = hours / Math.max(need, 1e-6);
          walk(w, p, p.tx, p.ty, hours * WALK_KMH, false, 0.05);
          void f;
          found(p.x, p.y);
          hours = 0;
        }
        break;
      }
      case 'trade': {
        hours = w.tradeStep(p, s, hours, fine);
        break;
      }
      default:
        p.task = '';
        p.phase = 0;
        hours = 0;
    }
    void rng;
  }
  return didSomething;
}

export { dropCargo, deposit, home };
void wrapDx; void NR;
