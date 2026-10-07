import type { World } from './world';
import type { Person, Occupation } from './people';
import { P, SK } from './people';
import type { Settlement } from './settlements';
import { BDEFS, BKind, Building, HOUSING, ResKey } from './buildings';
import { FIELD_HOURS, GROW_DAYS, deposit, dropCargo, fieldsWanted } from './jobs';
import { clamp } from './rng';
import { KM_PER_CELL_Y, distKm, idx, wrapX } from './grid';
import { WALK_KMH, kmTo, walk } from './behavior';
import { DAYS_PER_YEAR } from './time';

const has = (s: Settlement, t: string) => (s.tech as Set<string>).has(t);

/** Per-capita stock a community would like to hold. */
const WANT: Record<string, number> = { wood: 6, stone: 4, clay: 3, copper: 0.35, iron: 0.35, coal: 0.4, metal: 0.25, goods: 0.6, gold: 0 };
const BASE_PRICE: Record<string, number> = { wood: 1, stone: 1.4, clay: 1.2, copper: 5, iron: 4, coal: 2, gold: 60, metal: 12, goods: 3, food: 1 };

export function stockOf(s: Settlement, k: string): number {
  return k === 'goods' ? s.goods : k === 'food' ? s.food : s.res[k as ResKey] ?? 0;
}
function addStock(s: Settlement, k: string, v: number) {
  if (k === 'goods') s.goods = Math.max(0, s.goods + v);
  else if (k === 'food') s.food = Math.max(0, s.food + v);
  else s.res[k as ResKey] = Math.max(0, s.res[k as ResKey] + v);
}
export function price(s: Settlement, k: string): number {
  const want = (WANT[k] ?? 1) * s.pop + 10;
  const scarcity = clamp(1 - stockOf(s, k) / want, 0, 1);
  return BASE_PRICE[k] * (0.6 + 1.6 * scarcity);
}

// ======================================================= season planning
export function economySeason(w: World, s: Settlement) {
  const day = w.day;
  // --- tools wear out and are replaced
  if (!has(s, 'tools')) s.toolTier = 0;
  else if (has(s, 'metallurgy') && s.res.metal > 1 && w.buildings.count(s.id, 'smithy') > 0) {
    s.toolTier = 2;
    s.res.metal = Math.max(0, s.res.metal - Math.max(0.05, s.pop * 0.002));
  } else s.toolTier = 1;
  // --- everybody burns wood for cooking and warmth
  {
    const cold = clamp(1.3 - (s.tech.has('fire') ? 0.0 : 0) - (w.env.regionTemp[0] * 0), 0.8, 1.4);
    const fuel = Math.min(s.res.wood, s.pop * 0.3 * 90 * cold * 0.5);
    s.res.wood -= fuel;
  }
  // goods wear out, are used up and are given away
  s.goods *= 0.93;
  // --- housing
  s.housing = w.buildings.capacity(s.id);
  // --- fields: crops ripen, weeds creep
  for (const b of w.buildings.of(s.id)) {
    if (b.kind !== 'field' || b.done < 0) continue;
    if (b.fstate === 1) {
      b.weeds = clamp(b.weeds + 0.22);
      if (day - b.planted >= GROW_DAYS) b.fstate = 2;
    }
  }
  // --- wealth
  let bw = 0;
  for (const b of w.buildings.of(s.id)) if (b.done >= 0) bw += b.kind === 'field' ? 8 : BDEFS[b.kind].labor / 8;
  const r = s.res;
  s.wealth = s.food * 0.5 + r.wood + r.stone * 1.4 + r.clay * 1.2 + (r.copper + r.iron) * 4.5 + r.coal * 2 + r.gold * 60 + r.metal * 12 + s.goods * 3 + bw;
  // --- search radius widens when things are scarce, relaxes otherwise
  const scarceNow = Object.values(s.scarce).some((t) => day - t < 100);
  s.range = clamp(scarceNow ? s.range * 1.22 : s.range * 0.96, 2.5, 70);
  // --- what do we need?
  const need: Record<string, number> = {};
  const pop = Math.max(1, s.pop);
  let pending: Partial<Record<ResKey, number>> = {};
  const plan = nextProjects(w, s);
  for (const k of plan.shopping) for (const rk of Object.keys(BDEFS[k].cost) as ResKey[]) pending[rk] = (pending[rk] ?? 0) + (BDEFS[k].cost[rk] ?? 0);
  for (const b of w.buildings.of(s.id)) if (b.done < 0 && b.progress < 1) { /* materials were reserved at the start */ }
  const target = (k: ResKey, per: number) => per * pop + 12 + (pending[k] ?? 0) * 1.1;
  need.wood = clamp(1 - r.wood / target('wood', WANT.wood));
  need.stone = has(s, 'tools') ? clamp(1 - r.stone / target('stone', WANT.stone)) : 0;
  need.clay = has(s, 'pottery') ? clamp(1 - r.clay / target('clay', WANT.clay)) : 0;
  const smith = has(s, 'metallurgy');
  need.ore = smith ? clamp(1 - (r.copper + r.iron) / target('copper', WANT.copper * 2)) : 0;
  need.coal = smith ? clamp(1 - r.coal / target('coal', WANT.coal)) : 0;
  s.need = need;
  // --- start new construction when we can afford it
  startProjects(w, s, plan);
  assignHouses(w, s);
  rebalanceRoles(w, s);
  planTrade(w, s);
}

/** Which buildings does the community want next, in priority order, and which ones does it still need to shop for? */
function nextProjects(w: World, s: Settlement): { start: BKind[]; shopping: BKind[] } {
  const B = w.buildings;
  const pop = s.pop;
  const cnt = (k: BKind) => B.of(s.id).filter((b) => b.kind === k).length; // including unfinished
  const underway = B.of(s.id).filter((b) => b.done < 0 && b.progress < 1).length;
  const out: BKind[] = [];
  const cap = B.of(s.id).reduce((a, b) => a + (b.done >= -1 ? BDEFS[b.kind].cap : 0), 0);
  const homeless = pop - cap;
  if (homeless > 1) {
    const tiers: BKind[] = ['stonehouse', 'brickhouse', 'house', 'hut'];
    const ok = tiers.filter((k) => BDEFS[k].tech.every((t) => has(s, t)) && pop >= BDEFS[k].minPop);
    out.push(...ok);
  }
  const want = (k: BKind, n: number) => { if (BDEFS[k].tech.every((t) => has(s, t)) && pop >= BDEFS[k].minPop && cnt(k) < n) out.push(k); };
  want('hall', pop >= 70 ? 1 : 0);
  want('well', Math.floor(pop / 160) + (pop >= 40 ? 1 : 0));
  want('workshop', 1 + Math.floor(pop / 160));
  want('kiln', 1 + Math.floor(pop / 220));
  want('granary', 1 + Math.floor(pop / 160));
  if (has(s, 'metallurgy') && (s.res.copper + s.res.iron > 4)) want('smithy', 1 + Math.floor(pop / 320));
  want('market', (s.occupations['trader'] ?? 0) > 0 || pop >= 150 ? 1 + Math.floor(pop / 500) : 0);
  want('temple', (s.occupations['priest'] ?? 0) > 0 ? 1 + Math.floor(pop / 700) : 0);
  want('tower', s.threat > 0.25 ? 1 + Math.floor(pop / 250) : 0);
  void underway;
  return { start: out, shopping: out.slice(0, 2) };
}

function startProjects(w: World, s: Settlement, plan: { start: BKind[] }) {
  const B = w.buildings;
  const active = B.of(s.id).filter((b) => b.done < 0 && b.progress < 1 && b.kind !== 'field').length;
  const builders = s.occupations['builder'] ?? 0;
  const slots = 1 + Math.floor(builders / 3) - active;
  let started = 0;
  const homeless = s.pop - B.of(s.id).reduce((a, b) => a + (b.done >= -1 ? BDEFS[b.kind].cap : 0), 0);
  for (const k of plan.start) {
    if (started >= slots) break;
    const isHome = HOUSING.includes(k);
    // among housing tiers only the best affordable one is built (or a hut if people are freezing)
    const def = BDEFS[k];
    const afford = (Object.keys(def.cost) as ResKey[]).every((rk) => s.res[rk] >= (def.cost[rk] ?? 0));
    if (!afford) continue;
    if (isHome && homeless <= 1) continue;
    if (B.start(s, k)) {
      started++;
      if (isHome) break;
    }
  }
}

export function assignHouses(w: World, s: Settlement) {
  const B = w.buildings;
  const homes = B.of(s.id).filter((b) => b.done >= 0 && b.progress >= 1 && BDEFS[b.kind].cap > 0);
  for (const b of homes) b.residents = 0;
  const people = (w.residents.get(s.id) ?? []).filter((p) => p.alive);
  for (const p of people) p.house = 0;
  const free = (b: Building) => BDEFS[b.kind].cap - b.residents;
  const done = new Set<number>();
  for (const p of people) {
    if (done.has(p.id)) continue;
    const family = [p];
    const pt = p.partner ? w.people.get(p.partner) : undefined;
    if (pt && pt.alive && pt.home === s.id) family.push(pt);
    for (const cid of p.children) { const c = w.people.get(cid); if (c && c.alive && c.home === s.id && c.ageYears(w.day) < 14) family.push(c); }
    const house = homes.filter((b) => free(b) >= family.length).sort((a, b) => free(a) - free(b))[0];
    if (!house) continue;
    for (const m of family) { m.house = house.id; done.add(m.id); }
    house.residents += family.length;
  }
}

// ======================================================= roles
export function rebalanceRoles(w: World, s: Settlement) {
  const adults = (w.residents.get(s.id) ?? []).filter((p) => p.alive && p.ageYears(w.day) >= 15 && !p.band && p.id !== s.leader);
  if (adults.length < 6) return;
  const A = adults.length;
  const B = w.buildings;
  const count = (o: Occupation) => adults.filter((p) => p.occupation === o).length;
  const labor = B.of(s.id).filter((b) => b.done < 0 && b.progress < 1).reduce((a, b) => a + (1 - b.progress) * BDEFS[b.kind].labor, 0);
  const smithy = B.count(s.id, 'smithy') > 0;
  const crafts = B.of(s.id).filter((b) => b.done >= 0 && ['workshop', 'kiln', 'smithy'].includes(b.kind)).length;
  const hasTrade = has(s, 'tools') && s.pop >= 50;
  const target: Partial<Record<Occupation, number>> = {
    builder: labor > 0 ? clamp(Math.ceil(labor / 200), 1, Math.ceil(A * 0.18)) : s.need.wood > 0.4 || s.need.stone > 0.4 ? 1 : 0,
    woodcutter: (s.need.wood ?? 0) > 0.04 ? Math.max(1, Math.ceil(A * 0.16 * (s.need.wood ?? 0))) : 0,
    miner: has(s, 'tools') ? Math.ceil(A * 0.1 * Math.max(s.need.stone ?? 0, s.need.clay ?? 0, s.need.ore ?? 0, s.need.coal ?? 0)) + (smithy && s.need.ore > 0.3 ? 1 : 0) : 0,
    crafter: crafts ? Math.min(Math.ceil(A * 0.08), crafts + 1) : has(s, 'tools') ? 1 : 0,
    trader: hasTrade ? Math.min(3, Math.ceil(A / 70)) : 0,
  };
  const maxChange = Math.max(2, Math.ceil(A * 0.15));
  let changes = 0;
  const flex: Occupation[] = ['forager', 'hunter', 'farmer', 'woodcutter', 'miner', 'builder', 'crafter', 'trader'];
  const set = (p: Person, o: Occupation) => {
    dropCargo(w, p, s);
    p.occupation = o;
    p.task = '';
    p.phase = 0;
  };
  for (const role of Object.keys(target) as Occupation[]) {
    const want = target[role] ?? 0;
    let have = count(role);
    const aptitude = (p: Person) => {
      switch (role) {
        case 'woodcutter': return p.personality[P.patience] * 0.3 + p.skills[SK.woodcutting] + p.personality[P.bravery] * 0.2;
        case 'miner': return p.personality[P.patience] * 0.3 + p.skills[SK.mining] + p.personality[P.bravery] * 0.2;
        case 'builder': return p.personality[P.patience] * 0.3 + p.skills[SK.building] + p.personality[P.creativity] * 0.2;
        case 'crafter': return p.personality[P.creativity] * 0.5 + p.skills[SK.crafting];
        case 'trader': return p.personality[P.sociability] * 0.5 + p.personality[P.greed] * 0.3 + p.skills[SK.leading] * 0.2;
        default: return 0;
      }
    };
    while (have < want && changes < maxChange) {
      const pool = adults.filter((p) => ['forager', 'hunter'].includes(p.occupation) || (p.occupation === 'farmer' && s.stress < 0.2 && (s.occupations['farmer'] ?? 0) > 3));
      if (!pool.length) break;
      pool.sort((a, b) => aptitude(b) - aptitude(a) + (w.rng.next() - 0.5) * 0.2);
      set(pool[0], role);
      have++;
      changes++;
    }
    while (have > want && changes < maxChange) {
      const pool = adults.filter((p) => p.occupation === role);
      if (!pool.length) break;
      pool.sort((a, b) => aptitude(a) - aptitude(b));
      set(pool[0], s.tech.has('agriculture') && w.rng.next() < 0.6 ? 'farmer' : 'forager');
      have--;
      changes++;
    }
  }
  void flex; void fieldsWanted; void FIELD_HOURS; void DAYS_PER_YEAR;
}

// ======================================================= trade
function planTrade(w: World, s: Settlement) {
  const traders = (w.residents.get(s.id) ?? []).filter((p) => p.alive && p.occupation === 'trader' && p.task !== 'trade' && !p.band);
  if (!traders.length) return;
  const living = w.activeSettlements();
  let best: { o: Settlement; give: string; get: string; score: number; amt: number } | null = null;
  const keys = ['wood', 'stone', 'clay', 'copper', 'iron', 'coal', 'metal', 'goods'];
  for (const o of living) {
    if (o === s || o.pop < 8) continue;
    const d = distKm(s.x, s.y, o.x, o.y);
    if (d > 450) continue;
    const comp = w.landComp[idx(wrapX(Math.floor(s.x)), Math.floor(s.y))];
    if (w.landComp[idx(wrapX(Math.floor(o.x)), Math.floor(o.y))] !== comp && !(has(s, 'navigation') && w.landCompBoat[idx(wrapX(Math.floor(o.x)), Math.floor(o.y))] === w.landCompBoat[idx(wrapX(Math.floor(s.x)), Math.floor(s.y))])) continue;
    if (w.diplomacy.atWar(s.civ, o.civ)) continue;
    for (const give of keys) {
      const surplus = stockOf(s, give) - 1.4 * (WANT[give] ?? 0.5) * s.pop - 6;
      if (surplus < 4) continue;
      for (const get of [...keys, 'gold']) {
        if (get === give) continue;
        const theirSurplus = stockOf(o, get) - 1.2 * (WANT[get] ?? 0.5) * o.pop - 6;
        if (theirSurplus < 3 && get !== 'gold') continue;
        const myDeficit = get === 'gold' ? 0.4 : clamp(1 - stockOf(s, get) / (((WANT[get] ?? 0.5) * s.pop) + 8));
        const theirDeficit = clamp(1 - stockOf(o, give) / (((WANT[give] ?? 0.5) * o.pop) + 8));
        const score = (myDeficit + theirDeficit + 0.1) * Math.min(surplus, 60) * BASE_PRICE[give] / (1 + d / 120);
        if (!best || score > best.score) best = { o, give, get, score, amt: Math.min(surplus * 0.6, 70) };
      }
    }
  }
  if (!best || best.score < 2) return;
  const t = traders.sort((a, b) => b.personality[P.sociability] - a.personality[P.sociability])[0];
  addStock(s, best.give, -best.amt);
  t.task = 'trade';
  t.phase = 1;
  t.tb = best.o.id;
  t.cargo = best.give;
  t.cargoAmt = best.amt;
  t.back = best.get;
  t.timer = 0;
}

/** Walk a caravan, trade, and walk home. Returns remaining hours. */
export function tradeStep(w: World, p: Person, s: Settlement, hours: number, fine: boolean): number {
  const o = w.settlements[p.tb - 1];
  if (!o || o.abandoned >= 0) {
    // partner gone: bring the goods home
    if (p.phase < 3) p.phase = 3;
  }
  const speed = WALK_KMH * 0.8;
  if (p.phase === 1 && o) {
    const need = kmTo(p, o.x, o.y) / speed;
    if (need <= hours) { p.x = o.x; p.y = o.y; hours -= need; p.phase = 2; }
    else { walk(w, p, o.x, o.y, hours * speed, false, 0.1); hours = 0; }
    return hours;
  }
  if (p.phase === 2 && o) {
    hours = Math.max(0, hours - 1);
    const partners = (w.residents.get(o.id) ?? []).filter((q) => q.alive && q.ageYears(w.day) >= 15);
    const q = partners.length ? partners[Math.floor(w.rng.next() * partners.length)] : undefined;
    const understand = q ? w.langs.understanding(w, p, q) : 0.3;
    // misunderstandings cost goods; shared words make for better bargains
    const give = p.cargo;
    const amt = p.cargoAmt;
    const value = amt * price(o, give) * (0.75 + 0.25 * understand);
    let get = p.back;
    let back = value / Math.max(0.3, price(o, get));
    const theirs = stockOf(o, get);
    back = Math.min(back, theirs * 0.5 + 0.0);
    if (back < 0.5) { p.back = ''; back = 0; }
    addStock(o, give, amt);
    if (back > 0) addStock(o, get, -back);
    p.cargo = back > 0 ? get : '';
    p.cargoAmt = back;
    if (q) w.langs.contact(w, p, q, 0.05);
    w.noteTrade(s, o, value);
    if (!p.cargo) get = '';
    p.phase = 3;
    return hours;
  }
  if (p.phase === 3 || !o) {
    const need = kmTo(p, s.x, s.y) / speed;
    if (need <= hours) {
      p.x = s.x; p.y = s.y; hours -= need;
      if (p.cargo === 'goods') s.goods += p.cargoAmt; else if (p.cargo) deposit(w, p, s);
      p.cargo = ''; p.cargoAmt = 0; p.task = ''; p.phase = 0;
      p.skills[SK.leading] = Math.min(1, p.skills[SK.leading] + 0.01);
    } else { walk(w, p, s.x, s.y, hours * speed, false, 0.1); hours = 0; }
    return hours;
  }
  void fine;
  return 0;
}
void KM_PER_CELL_Y;
