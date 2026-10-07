import type { World } from './world';
import { military } from './techfx';
import type { Band } from './behavior';
import type { Person } from './people';
import { P } from './people';
import type { Settlement } from './settlements';
import { clamp } from './rng';
import { distKm, idx, wrapX } from './grid';
import { DAYS_PER_YEAR, yearOf } from './time';
import { startMigration } from './society';
import { shock } from './research';

/** Relations between peoples. Tension is built by causes (crowded borders, hunger, raids, alien customs, ambitious rulers)
 *  and relieved by trade; wars only happen when tension is high and someone expects to win. */
export interface Relation {
  a: number;
  b: number;
  tension: number;
  trade: number;
  raids: number;
  war: boolean;
  warStart: number;
  attacker: number;
  cause: string;
  losses: [number, number];
  battles: number;
  lastPeace: number;
}

export class Diplomacy {
  rel = new Map<string, Relation>();
  static key(a: number, b: number) { return a < b ? `${a}:${b}` : `${b}:${a}`; }

  get(a: number, b: number): Relation {
    const k = Diplomacy.key(a, b);
    let r = this.rel.get(k);
    if (!r) {
      r = { a: Math.min(a, b), b: Math.max(a, b), tension: 0.1, trade: 0, raids: 0, war: false, warStart: -1, attacker: 0, cause: '', losses: [0, 0], battles: 0, lastPeace: -1e9 };
      this.rel.set(k, r);
    }
    return r;
  }
  atWar(a: number, b: number): boolean {
    return a !== b && (this.rel.get(Diplomacy.key(a, b))?.war ?? false);
  }
  warCount(civ: number): number {
    let n = 0;
    for (const r of this.rel.values()) if (r.war && (r.a === civ || r.b === civ)) n++;
    return n;
  }
  wars(): Relation[] {
    return [...this.rel.values()].filter((r) => r.war);
  }

  season(w: World) {
    const civs = w.livingCivs();
    const sets = w.activeSettlements();
    // neighbouring pairs
    const byCiv = new Map<number, Settlement[]>();
    for (const s of sets) { const l = byCiv.get(s.civ) ?? []; l.push(s); byCiv.set(s.civ, l); }
    for (let i = 0; i < civs.length; i++) {
      const A = civs[i];
      const sa = byCiv.get(A.id);
      if (!sa) continue;
      for (let j = i + 1; j < civs.length; j++) {
        const B = civs[j];
        const sb = byCiv.get(B.id);
        if (!sb) continue;
        let near = 0;
        let minD = 1e9;
        for (const x of sa) for (const y of sb) {
          const d = distKm(x.x, x.y, y.x, y.y);
          if (d < minD) minD = d;
          if (d < 110) near++;
        }
        if (minD > 300) { const r0 = this.rel.get(Diplomacy.key(A.id, B.id)); if (r0) { r0.tension *= 0.9; if (!r0.war) continue; } else continue; }
        const r = this.get(A.id, B.id);
        const ca = w.cultures.get(A.culture), cb = w.cultures.get(B.culture);
        const cdist = ca && cb ? w.cultures.distance(ca, cb) : 0.3;
        const stressA = sa.reduce((a, s) => a + s.stress, 0) / sa.length;
        const stressB = sb.reduce((a, s) => a + s.stress, 0) / sb.length;
        const la = A.leader ? w.people.get(A.leader) : undefined;
        const lb = B.leader ? w.people.get(B.leader) : undefined;
        const aggr = ((la?.personality[P.aggression] ?? 0.4) + (la?.personality[P.ambition] ?? 0.4) + (lb?.personality[P.aggression] ?? 0.4) + (lb?.personality[P.ambition] ?? 0.4)) / 4;
        let d = Math.min(0.06, near * 0.008) + (stressA + stressB) * 0.03 + cdist * 0.025 + (aggr - 0.45) * 0.04 + Math.min(0.05, r.raids * 0.02);
        d -= Math.min(0.07, r.trade * 0.012);
        r.tension = clamp(r.tension * 0.965 + d);
        r.trade *= 0.8;
        r.raids *= 0.85;
        if (r.war) this.warSeason(w, r, A.id, B.id, byCiv);
        else if (r.tension > 0.8 && w.day - r.lastPeace > 15 * DAYS_PER_YEAR && this.warCount(A.id) === 0 && this.warCount(B.id) === 0 && w.random() < 0.12) this.declare(w, r, A.id, B.id, byCiv, { stressA, stressB, cdist, near, aggr });
      }
    }
  }

  private strength(w: World, list: Settlement[]): number {
    let s = 0;
    for (const x of list) s += (x.pop * 0.25 + (x.occupations['warrior'] ?? 0) * 1.2) * military(x) + x.defense * 20;
    return s;
  }

  private declare(w: World, r: Relation, a: number, b: number, byCiv: Map<number, Settlement[]>, f: { stressA: number; stressB: number; cdist: number; near: number; aggr: number }) {
    const sa = byCiv.get(a)!, sb = byCiv.get(b)!;
    const ta = this.strength(w, sa), tb = this.strength(w, sb);
    const attacker = ta >= tb ? a : b;
    const ratio = Math.max(ta, tb) / Math.max(1, Math.min(ta, tb));
    if (ratio < 0.8) return;
    const A = w.civs[attacker - 1], D = w.civs[(attacker === a ? b : a) - 1];
    const reasons: [number, string][] = [
      [r.raids, `revenge for raids on ${A.name} lands`],
      [(f.stressA + f.stressB) / 2 * 2, 'the hunger of a land too full of people'],
      [f.near / 6, 'competition for the same rivers and fields'],
      [f.cdist * 1.5, 'old enmity between very different peoples'],
      [(f.aggr - 0.4) * 3, `the ambition of ${A.name}'s ruler`],
    ];
    reasons.sort((x, y) => y[0] - x[0]);
    r.war = true;
    r.warStart = w.day;
    r.attacker = attacker;
    r.cause = reasons[0][1];
    r.losses = [0, 0];
    r.battles = 0;
    w.history.record('WAR', w.day, `The ${A.name} declared war on the ${D.name}.`, 3, {
      civ: A.id, x: w.settlements[A.capital - 1]?.x, y: w.settlements[A.capital - 1]?.y,
      cause: `Tension between the two peoples reached ${r.tension.toFixed(2)}, driven by ${reasons[0][1]}.`,
    });
  }

  private warSeason(w: World, r: Relation, a: number, b: number, byCiv: Map<number, Settlement[]>) {
    const years = (w.day - r.warStart) / DAYS_PER_YEAR;
    const exhaustion = clamp((r.losses[0] + r.losses[1]) / 60);
    const peace = r.tension < 0.35 || years > 2 + w.random() * 5 || w.random() < 0.05 + exhaustion * 0.35;
    if (peace) {
      r.war = false;
      r.tension = 0.3;
      r.lastPeace = w.day;
      const A = w.civs[a - 1], B = w.civs[b - 1];
      w.history.record('WAR', w.day, `The war between the ${A.name} and the ${B.name} ended after ${years.toFixed(1)} years.`, 2, {
        civ: a, cause: `Exhaustion (${r.losses[0] + r.losses[1]} dead in ${r.battles} battles) and falling tension brought a peace.`,
      });
      return;
    }
    // each side may march an army against the nearest enemy settlement
    for (const [me, foe] of [[r.attacker, r.attacker === a ? b : a], [r.attacker === a ? b : a, r.attacker]]) {
      if (me !== r.attacker && w.random() > 0.35) continue;
      const mine = byCiv.get(me) ?? [];
      const theirs = byCiv.get(foe) ?? [];
      if (!mine.length || !theirs.length) continue;
      if (w.random() > 0.7) continue;
      let best: { from: Settlement; to: Settlement; d: number } | null = null;
      for (const x of mine) { if (x.pop < 20) continue; for (const y of theirs) { const d = distKm(x.x, x.y, y.x, y.y); if (d < 320 && (!best || d < best.d)) best = { from: x, to: y, d }; } }
      if (!best) continue;
      this.mobilize(w, r, best.from, best.to);
    }
  }

  private mobilize(w: World, r: Relation, from: Settlement, to: Settlement) {
    // across water the army must be carried by ships, and an enemy fleet may meet them first
    const ci = (s: Settlement) => idx(wrapX(Math.floor(s.x)), Math.floor(s.y));
    if (w.landComp[ci(from)] !== w.landComp[ci(to)]) {
      if (from.ships < 2) return;
      if (to.ships >= 1) {
        const atk = from.ships * military(from) * (0.7 + w.random() * 0.6);
        const def = to.ships * military(to) * (0.8 + w.random() * 0.6);
        const win = atk > def;
        const lostA = Math.min(from.ships, Math.ceil(from.ships * (win ? 0.2 : 0.6) * w.random() + (win ? 0 : 1)));
        const lostD = Math.min(to.ships, Math.ceil(to.ships * (win ? 0.6 : 0.2) * w.random() + (win ? 1 : 0)));
        from.ships -= lostA;
        to.ships -= lostD;
        const fa = w.civs[from.civ - 1], fd = w.civs[to.civ - 1];
        w.history.record('BATTLE', w.day, `The fleets of the ${fa.name} and the ${fd.name} fought off ${to.name}: ${win ? `the ${fa.name}` : `the ${fd.name}`} won (${Math.round(lostA)} and ${Math.round(lostD)} ships lost).`, 2, {
          settlement: to.id, civ: from.civ, x: (from.x + to.x) / 2, y: (from.y + to.y) / 2, cause: `An invasion across the sea from ${from.name} had to get past the defenders' ships.`,
        });
        r.battles++;
        if (!win) return;
      }
    }
    const adults = (w.residents.get(from.id) ?? []).filter((p) => p.alive && !p.band && p.ageYears(w.day) >= 16 && p.ageYears(w.day) < 50 && p.id !== from.leader && p.sex === 0);
    if (adults.length < 6) return;
    adults.sort((a, b) => (b.occupation === 'warrior' ? 1 : 0) + b.personality[P.aggression] * 0.5 - ((a.occupation === 'warrior' ? 1 : 0) + a.personality[P.aggression] * 0.5));
    const n = Math.round(clamp(adults.length * 0.45, 5, 70));
    const army = adults.slice(0, n);
    const leader = army[0];
    const band: Band = {
      id: w.nextBand++, kind: 'army', leader: leader.id, tx: to.x, ty: to.y, from: from.id, culture: from.culture, civ: from.civ, tech: new Set(from.tech),
      note: 'war', created: w.day, members: army.map((p) => p.id), stuck: 0, lastRaid: -1e9, lastTarget: to.id,
    };
    w.bands.set(band.id, band);
    for (const p of army) { p.band = band.id; p.food += 8; p.hasTarget = false; p.task = ''; p.phase = 0; }
    from.food = Math.max(0, from.food - n * 8);
    void r;
    w.history.record('INVASION', w.day, `${leader.name} marched ${n} fighters from ${from.name} against ${to.name}.`, 1, { persons: [leader.id], settlement: from.id, civ: from.civ, x: from.x, y: from.y, cause: `The ${w.civs[from.civ - 1].name} were at war.` });
  }

  /** A marching army reached its target (or came home). */
  arrive(w: World, b: Band, members: Person[], leader: Person) {
    const from = w.settlements[b.from - 1];
    if (b.returning || !b.lastTarget) {
      for (const m of members) { m.band = 0; m.goal = 'work'; m.hasTarget = false; }
      w.bands.delete(b.id);
      return;
    }
    const target = w.settlements[b.lastTarget - 1];
    if (!target || target.abandoned >= 0) { b.returning = true; if (from) { b.tx = from.x; b.ty = from.y; } return; }
    const r = this.get(from?.civ ?? b.civ, target.civ);
    const defenders = (w.residents.get(target.id) ?? []).filter((p) => p.alive && p.ageYears(w.day) >= 15 && !p.band);
    let atk = 0;
    for (const m of members) atk += m.personality[P.aggression] * 0.5 + m.personality[P.bravery] * 0.4 + 0.4 + (m.occupation === 'warrior' ? 0.5 : 0);
    atk *= military(from);
    let def = 0;
    for (const d of defenders) def += (d.occupation === 'warrior' ? 1.2 : 0.4) * (0.6 + d.personality[P.bravery] * 0.5);
    const towers = w.buildings.count(target.id, 'tower');
    def *= (1 + target.defense * 4 + towers * 0.45) * military(target);
    // walls: an army that cannot storm them settles in for a siege, starving the town and battering a breach
    const walls = wallFactor(w, target, from);
    if (walls > 1.3) {
      if (b.siege === undefined) {
        b.siege = w.day;
        b.lastAssault = w.day;
        w.history.record('BATTLE', w.day, `${leader.name}'s army laid siege to ${target.name}.`, 2, {
          persons: [leader.id], settlement: target.id, civ: b.civ, x: target.x, y: target.y, cause: `${target.name}'s ${w.buildings.count(target.id, 'wall') ? 'stone walls' : 'palisade'} were too strong to storm at once.`,
        });
        return;
      }
      const days = w.day - b.siege;
      target.food = Math.max(0, target.food - target.pop * 0.25 * w.dt);
      for (const m of members) m.food += w.env.takeForage(idx(wrapX(Math.floor(m.x)), Math.floor(m.y)), 1.2 * w.dt, w.day) * 0.5;
      if (target.food <= 0 && w.random() < 0.02 * w.dt) {
        def *= 0.15; // starving defenders open the gates
      } else if (days > 240 || members.length < 5) {
        w.history.record('BATTLE', w.day, `The siege of ${target.name} was lifted after ${Math.round(days)} days.`, 1, { settlement: target.id, civ: b.civ, x: target.x, y: target.y, cause: 'The besiegers ran out of men, food or patience.' });
        b.returning = true;
        if (from && from.abandoned < 0) { b.tx = from.x; b.ty = from.y; }
        return;
      } else if (w.day - (b.lastAssault ?? b.siege) < 15) return;
      b.lastAssault = w.day;
      const breach = Math.min(0.75, (days / 300) * (from?.tech.has('engineering') ? 2 : 1) * (from?.tech.has('gunpowder') ? 2.5 : 1));
      def *= 1 + (walls - 1) * (1 - breach);
    }
    const win = w.random() < atk / (atk + def + 0.01);
    const lossA = Math.round(members.length * (win ? 0.08 + w.random() * 0.12 : 0.3 + w.random() * 0.3));
    const lossD = Math.round(defenders.length * (win ? 0.15 + w.random() * 0.25 : 0.05 + w.random() * 0.08));
    for (let i = 0; i < lossD && defenders.length; i++) { const v = defenders.splice(w.rng.int(defenders.length), 1)[0]; if (v.alive) w.die(v, 'war'); }
    for (let i = 0; i < lossA && members.length > 1; i++) { const v = members.splice(w.rng.int(members.length), 1)[0]; w.die(v, 'war'); }
    r.losses[0] += lossA; r.losses[1] += lossD; r.battles++;
    b.members = members.map((m) => m.id);
    for (const d of defenders) {
      if (!d.alive) continue;
      d.remember({ day: w.day, kind: 'war', text: `${target.name} was attacked by the ${w.civs[b.civ - 1]?.name ?? 'enemy'}`, valence: -0.9, intensity: 0.95, x: target.x, y: target.y, other: leader.id });
      d.relations.set(leader.id, { affinity: -0.95, kind: 'rival' });
      d.personality[P.fearfulness] = clamp(d.personality[P.fearfulness] + 0.08);
      d.personality[P.aggression] = clamp(d.personality[P.aggression] + 0.05);
    }
    target.threat = clamp(target.threat + 0.6);
    target.defense += 0.03;
    const fromCiv = w.civs[b.civ - 1], toCiv = w.civs[target.civ - 1];
    let text = `${leader.name}'s army ${win ? 'defeated the defenders of' : 'was repulsed at'} ${target.name} (${lossA} and ${lossD} dead).`;
    let weight = 2;
    if (win) {
      target.food *= 0.4;
      const burned = w.buildings.destroy(target.id, 0.2 + w.random() * 0.25, w.rng);
      if (burned) text += ` ${burned} buildings burned.`;
      shock(target, 0.9); // workshops and scholars scattered by the sack
      // a beaten, small, or poorly defended place is taken; a strong one is merely sacked
      if (target.pop < 160 || def < atk * 0.5) {
        const old = toCiv;
        target.civ = fromCiv.id;
        if (old) old.members = old.members.filter((i) => i !== target.id);
        fromCiv.members.push(target.id);
        // part of the conqueror's tongue spreads
        for (const d of defenders) if (d.alive) w.langs.contact(w, d, leader, 0.25);
        text = `${target.name} fell to the ${fromCiv.name}. ${text}`;
        weight = 3;
        // refugees leave
        if (target.pop >= 30 && w.random() < 0.7) startMigration(w, target, `fleeing the ${fromCiv.name} conquest`);
        const c = w.civs[target.civ - 1];
        if (old && old.members.length === 0) old.collapsed = w.day;
        void c;
      }
    }
    w.history.record('BATTLE', w.day, text, weight, {
      persons: [leader.id], settlement: target.id, civ: b.civ, x: target.x, y: target.y,
      cause: `Part of the war between the ${fromCiv?.name} and the ${toCiv?.name}, begun over ${r.cause || 'old grievances'}.`,
    });
    // a failed assault on a besieged town does not end the siege while the army holds together
    if (b.siege !== undefined && !win && members.length >= 6 && target.civ !== b.civ) return;
    b.returning = true;
    if (from && from.abandoned < 0) { b.tx = from.x; b.ty = from.y; } else { b.tx = leader.x; b.ty = leader.y; }
  }
}

/** How much a town's walls multiply its defenders (cannon and siege engines blunt them). */
export function wallFactor(w: World, s: Settlement, attacker?: Settlement): number {
  const f = w.buildings.count(s.id, 'wall') ? 2.8 : w.buildings.count(s.id, 'palisade') ? 1.7 : 1;
  if (f === 1) return 1;
  let k = 1;
  if (attacker?.tech.has('engineering')) k *= 0.75;
  if (attacker?.tech.has('gunpowder')) k *= 0.45;
  return 1 + (f - 1) * k;
}
void idx; void wrapX; void yearOf;
