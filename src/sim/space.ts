import type { World } from './world';
import type { Settlement } from './settlements';
import { Rng, clamp, hashStr } from './rng';
import { H, N, NBR8, R_KM, W, distKm, idx, wrapX } from './grid';
import { DAYS_PER_YEAR } from './time';
import { NATURAL_PHONOLOGY, makeWord } from './names';
import type { Person } from './people';
import { mastery, oceanGoing } from './techfx';
import { ledgerOf, practise } from './research';

/**
 * The rest of the solar system, and what people put into it; plus the long-distance transport network (sea lanes and air
 * routes). Everything is stored as orbits, routes and schedules, so positions are pure functions of time: the renderer
 * computes where a ship, plane or satellite is without the simulation ticking it.
 */

export const AU_KM = 149_600_000;
export const SUN_RADIUS_KM = 696_000;
/** The moon, scaled with the planet: ~60 planet radii away, ~0.27 planet radii across, 27.3-day orbit. */
export const MOON = { distKm: R_KM * 60.3, radiusKm: R_KM * 0.273, periodDays: 27.32, synodicDays: 29.53 };
/** Surface gravity like Earth's; GM = g R². */
const GM = 9.81 * (R_KM * 1000) ** 2; // m³/s²

export type BodyKind = 'rocky' | 'lava' | 'desert' | 'ocean' | 'gas' | 'ice';
export interface Body {
  name: string;
  kind: BodyKind;
  a: number; // AU
  e: number;
  incl: number;
  node: number;
  phase: number;
  radiusKm: number;
  color: [number, number, number];
  rings: boolean;
  moons: number;
  home?: boolean;
}

export interface Satellite {
  id: number;
  civ: number;
  name: string;
  kind: 'satellite' | 'station' | 'telescope';
  launched: number;
  altKm: number;
  inc: number;
  raan: number;
  phase: number;
  until: number;
}

export interface Mission {
  id: number;
  civ: number;
  name: string;
  target: number; // body index, or -1 for the moon
  crewed: boolean;
  crew: number[];
  launched: number;
  arrive: number;
  landed: boolean;
  done: boolean;
  /** how well the art behind it was mastered at launch (older saves: fully) */
  skill?: number;
}

export interface Route {
  id: number;
  kind: 'sea' | 'air';
  a: number;
  b: number;
  civ: number;
  since: number;
  /** waypoints [x0, y0, x1, y1, ...] in map cells (sea lanes follow open water; air routes fly the great circle) */
  path: number[];
  km: number;
  /** vehicles on the route at once */
  fleet: number;
}

export interface CivSpace {
  launches: number;
  failures: number;
  firstSatellite: number;
  crewed: number;
  moonLanding: number;
  /** crews lost, moon missions lost, and the day crewed flights may resume */
  crewLost?: number;
  moonFails?: number;
  grounded?: number;
}

export class Space {
  bodies: Body[] = [];
  home = 0;
  satellites: Satellite[] = [];
  missions: Mission[] = [];
  routes: Route[] = [];
  programs = new Map<number, CivSpace>();
  next = 1;

  constructor(private world: World) {
    const rng = new Rng(hashStr('solar-system') ^ world.seed);
    const n = 6 + rng.int(4);
    // spacing grows geometrically outwards; the home world sits in the temperate zone at 1 AU
    let a = 0.32 + rng.next() * 0.12;
    const list: Body[] = [];
    let placedHome = false;
    for (let i = 0; i < n; i++) {
      if (!placedHome && a * 1.7 > 1.0) {
        list.push({ name: '', kind: 'ocean', a: 1, e: 0.016, incl: 0, node: 0, phase: 0, radiusKm: R_KM, color: [0.3, 0.45, 0.7], rings: false, moons: 1, home: true });
        placedHome = true;
        a = 1.55 + rng.next() * 0.2;
        continue;
      }
      const cold = a > 2.6;
      const kind: BodyKind = cold ? (a > 12 ? 'ice' : 'gas') : a < 0.5 ? 'lava' : rng.next() < 0.5 ? 'desert' : 'rocky';
      const radiusKm = kind === 'gas' ? 25000 + rng.next() * 45000 : kind === 'ice' ? 14000 + rng.next() * 14000 : 900 + rng.next() * 3600;
      const color: [number, number, number] = kind === 'gas' ? [0.78 + rng.next() * 0.15, 0.62 + rng.next() * 0.2, 0.42 + rng.next() * 0.2]
        : kind === 'ice' ? [0.55, 0.75 + rng.next() * 0.15, 0.9] : kind === 'lava' ? [0.55, 0.45, 0.4] : kind === 'desert' ? [0.75, 0.42, 0.25] : [0.6, 0.58, 0.55];
      list.push({
        name: makeWord(NATURAL_PHONOLOGY, rng, 2), kind, a, e: rng.next() * 0.09, incl: (rng.next() - 0.5) * 0.12, node: rng.next() * Math.PI * 2,
        phase: rng.next(), radiusKm, color, rings: kind === 'gas' ? rng.next() < 0.5 : kind === 'ice' && rng.next() < 0.3, moons: kind === 'gas' ? 4 + rng.int(40) : kind === 'ice' ? 2 + rng.int(12) : rng.int(3),
      });
      a *= 1.55 + rng.next() * 0.45;
    }
    if (!placedHome) list.push({ name: '', kind: 'ocean', a: 1, e: 0.016, incl: 0, node: 0, phase: 0, radiusKm: R_KM, color: [0.3, 0.45, 0.7], rings: false, moons: 1, home: true });
    list.sort((p, q) => p.a - q.a);
    this.bodies = list;
    this.home = list.findIndex((b) => b.home);
  }

  /** Orbital period of a body (years). */
  period(b: Body): number {
    return Math.pow(b.a, 1.5);
  }

  /** Heliocentric position (AU) of a body on a given day; the home planet's year is exactly one year. */
  bodyPos(i: number, day: number): [number, number, number] {
    const b = this.bodies[i];
    const M = 2 * Math.PI * (day / DAYS_PER_YEAR / this.period(b) + b.phase);
    let E = M;
    for (let k = 0; k < 5; k++) E = M + b.e * Math.sin(E);
    const x = b.a * (Math.cos(E) - b.e);
    const z = b.a * Math.sqrt(1 - b.e * b.e) * Math.sin(E);
    const cn = Math.cos(b.node), sn = Math.sin(b.node);
    const X = x * cn - z * sn, Z = x * sn + z * cn;
    return [X, Z * Math.sin(b.incl), Z * Math.cos(b.incl)];
  }

  /** Satellite position in the planet frame (km from the centre). */
  satPos(s: Satellite, day: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
    const r = R_KM + s.altKm;
    const periodDays = (2 * Math.PI * Math.sqrt(((r * 1000) ** 3) / GM)) / 86400;
    const th = 2 * Math.PI * (day / periodDays + s.phase);
    const x = Math.cos(th) * r, y0 = Math.sin(th) * r;
    // tilt by inclination about x, then rotate the node about the polar axis (y up)
    const y = y0 * Math.sin(s.inc), z = y0 * Math.cos(s.inc);
    const c = Math.cos(s.raan), sn = Math.sin(s.raan);
    out[0] = x * c - z * sn; out[1] = y; out[2] = x * sn + z * c;
    return out;
  }

  program(civ: number): CivSpace {
    let p = this.programs.get(civ);
    if (!p) { p = { launches: 0, failures: 0, firstSatellite: -1, crewed: 0, moonLanding: -1 }; this.programs.set(civ, p); }
    return p;
  }

  /**
   * Once per season: launches, missions arriving, orbits decaying. Rockets explode and capsules are lost until the arts
   * behind them are mastered: every launch is practice, and a lost crew grounds a programme for years.
   */
  season() {
    const w = this.world;
    const day = w.day;
    const rng = w.rng;
    this.satellites = this.satellites.filter((s) => s.until > day);
    for (const civ of w.livingCivs()) {
      const pad = civ.members.map((id) => w.settlements[id - 1]).find((s) => s && s.abandoned < 0 && s.tech.has('rocketry') && w.buildings.count(s.id, 'launchpad') > 0);
      if (!pad) continue;
      const prog = this.program(civ.id);
      const mR = mastery(pad, 'rocketry'), mS = mastery(pad, 'spaceflight');
      const crewedAge = mS >= 0.3 && (prog.grounded ?? 0) <= day;
      const rate = (crewedAge ? 0.9 : 0.35) * clamp(civ.pop / 600, 0.3, 2);
      if (rng.next() > 1 - Math.exp(-rate)) continue;
      prog.launches++;
      const roll = rng.next(); // what this launch is for is decided before it flies
      practise(pad, 'rocketry', 0.03);
      const explodeP = clamp(0.03 + 0.72 * Math.pow(1 - mR, 1.4), 0.03, 0.75);
      if (rng.next() < explodeP) {
        prog.failures++;
        practise(pad, 'rocketry', 0.02);
        const L = ledgerOf(w, 'satellite');
        L.f++;
        const dead = rng.next() < 0.25 ? this.padCrew(pad, 1 + rng.int(2)) : [];
        for (const p of dead) w.die(p, 'a rocket explosion');
        L.k += dead.length;
        const want = L.first === -1 ? 2 : prog.launches <= 5 ? 1 : 0;
        w.history.record('EXPERIMENT', day, `A ${civ.name} rocket exploded ${rng.next() < 0.5 ? 'on the pad' : 'during ascent'} at ${pad.name}${dead.length ? `, killing ${dead.map((p) => p.name).join(' and ')}` : ''}.`, this.weight(want), {
          persons: dead.map((p) => p.id), civ: civ.id, settlement: pad.id, x: pad.x, y: pad.y,
          cause: `Rocketry is unforgiving: ${pad.name}'s rockets were ${Math.round(mR * 100)}% mastered, and this was launch ${prog.launches}.`,
        });
        continue;
      }
      if (!crewedAge || prog.firstSatellite < 0 || roll < 0.5) {
        // a satellite (or, while crews are not yet trusted to them, an uncrewed test of a capsule)
        if (mS > 0 && !crewedAge) practise(pad, 'spaceflight', 0.02);
        if (rng.next() < clamp(mR / 0.45, 0, 1)) this.launchSatellite(civ.id, pad, prog, rng);
        else {
          prog.failures++;
          const L = ledgerOf(w, 'satellite');
          L.f++;
          w.history.record('EXPERIMENT', day, `A ${civ.name} satellite launched from ${pad.name} fell back short of orbit.`, this.weight(L.first === -1 ? 1 : 0), {
            civ: civ.id, settlement: pad.id, x: pad.x, y: pad.y, cause: `The rocket could not yet reach orbital speed (rocketry ${Math.round(mR * 100)}% mastered).`,
          });
        }
        continue;
      }
      if (prog.crewed === 0 || roll < 0.65) {
        const Lo = ledgerOf(w, 'orbit');
        const crew = this.crew(pad, prog.crewed < 2 ? 1 : 2);
        if (!crew.length) { this.launchSatellite(civ.id, pad, prog, rng); continue; } // no one fit to fly: it goes up uncrewed
        const name = makeWord(NATURAL_PHONOLOGY, rng, 2);
        Lo.n++;
        if (rng.next() < 0.02 + 0.5 * Math.pow(1 - mS, 1.5)) {
          for (const p of crew) w.die(p, 'a rocket explosion');
          prog.crewLost = (prog.crewLost ?? 0) + 1;
          prog.grounded = day + (2 + 3 * rng.next()) * DAYS_PER_YEAR;
          civ.legitimacy = clamp(civ.legitimacy - 0.1, -1, 1);
          practise(pad, 'spaceflight', 0.05);
          Lo.f++; Lo.k += crew.length;
          w.history.record('DISASTER', day, `The crew of the ${civ.name} capsule ${name} died when their rocket exploded${crew.length ? `: ${crew.map((p) => p.name).join(' and ')}` : ''}.`, this.weight(Lo.first === -1 || prog.crewLost === 1 ? 2 : 1), {
            persons: crew.map((p) => p.id), civ: civ.id, settlement: pad.id, x: pad.x, y: pad.y,
            cause: `Crewed spaceflight was still ${Math.round(mS * 100)}% mastered; the programme was grounded until ${Math.floor(prog.grounded / DAYS_PER_YEAR)}.`,
          });
          continue;
        }
        practise(pad, 'spaceflight', 0.03);
        prog.crewed++;
        if (prog.crewed === 1) {
          const astro = crew[0];
          const worldFirst = Lo.first === -1;
          if (worldFirst) { Lo.first = day; Lo.by = astro?.id ?? 0; Lo.at = pad.id; Lo.civ = civ.id; Lo.pre = [Lo.n - 1, Lo.f, Lo.k]; }
          w.history.record('DISCOVERY', day, worldFirst
            ? `${astro ? astro.name : 'An astronaut'} of the ${civ.name} became the first person to orbit the world.`
            : `${astro ? astro.name : 'An astronaut'} became the first of the ${civ.name} to orbit the world.`, this.weight(worldFirst ? 3 : 1), {
            persons: astro ? [astro.id] : [], civ: civ.id, settlement: pad.id, x: pad.x, y: pad.y,
            cause: `Rockets powerful and reliable enough to carry a person had been built and tested: ${prog.launches} launches${prog.crewLost ? `, ${prog.crewLost} crew${prog.crewLost > 1 ? 's' : ''} lost on the way` : ''}.`,
          });
          if (astro) { astro.legend = worldFirst || astro.legend; astro.status = clamp(astro.status + 0.4); }
        }
        if (prog.crewed >= 3 && !this.satellites.some((s) => s.civ === civ.id && s.kind === 'station')) {
          this.satellites.push({ id: this.next++, civ: civ.id, name: makeWord(NATURAL_PHONOLOGY, rng, 2), kind: 'station', launched: day, altKm: 350 + rng.next() * 150, inc: 0.4 + rng.next() * 0.5, raan: rng.next() * 6.28, phase: rng.next(), until: day + 40 * DAYS_PER_YEAR });
          w.history.record('GROWTH', day, `The ${civ.name} assembled a space station in orbit.`, 2, { civ: civ.id, x: pad.x, y: pad.y, cause: 'Repeated crewed flights made a permanent home in orbit possible.' });
        }
      } else if (prog.moonLanding < 0 && prog.crewed >= 2 && mS >= 0.55 && roll < 0.82 && !this.missions.some((m) => m.civ === civ.id && m.target < 0 && !m.done) && this.crew(pad, 3).length) {
        const crew = this.crew(pad, 3);
        const t = 3 + rng.next() * 2;
        this.missions.push({ id: this.next++, civ: civ.id, name: makeWord(NATURAL_PHONOLOGY, rng, 2), target: -1, crewed: true, crew: crew.map((p) => p.id), launched: day, arrive: day + t, landed: true, done: false, skill: mS });
      } else {
        // a robotic probe to another world: a Hohmann transfer takes half the transfer orbit's period
        const targets = this.bodies.map((_, i) => i).filter((i) => i !== this.home);
        if (!targets.length) { this.launchSatellite(civ.id, pad, prog, rng); continue; }
        const ti = targets[rng.int(targets.length)];
        const b = this.bodies[ti];
        const at = (1 + b.a) / 2;
        const tYears = 0.5 * Math.pow(at, 1.5);
        this.missions.push({ id: this.next++, civ: civ.id, name: makeWord(NATURAL_PHONOLOGY, rng, 2), target: ti, crewed: false, crew: [], launched: day, arrive: day + tYears * DAYS_PER_YEAR, landed: b.kind !== 'gas' && rng.next() < 0.6, done: false, skill: mR });
      }
    }
    // missions arriving
    for (const m of this.missions) {
      if (m.done || m.arrive > day) continue;
      m.done = true;
      const civ = w.civs[m.civ - 1];
      const prog = this.program(m.civ);
      if (m.target < 0) {
        const crew = m.crew.map((id) => w.people.get(id)).filter((p): p is Person => !!p && p.alive);
        const Lm = ledgerOf(w, 'moon');
        Lm.n++;
        if (rng.next() >= 0.35 + 0.6 * (m.skill ?? 1)) {
          if (rng.next() < 0.6) {
            Lm.f++;
            w.history.record('EXPERIMENT', day, `The crew of the ${m.name} turned back short of the moon after a fault aboard.`, this.weight(1), {
              persons: crew.map((p) => p.id), civ: m.civ, cause: `Crewed spaceflight was not yet reliable enough for the journey (${Math.round((m.skill ?? 1) * 100)}% mastered).`,
            });
          } else {
            Lm.f++; Lm.k += crew.length;
            for (const p of crew) w.die(p, 'a lost moon mission');
            prog.moonFails = (prog.moonFails ?? 0) + 1;
            prog.grounded = day + (2 + 3 * rng.next()) * DAYS_PER_YEAR;
            w.history.record('DISASTER', day, `The crew of the ${m.name} were lost on their way to the moon: ${crew.map((p) => p.name).join(', ') || 'all aboard'}.`, this.weight(Lm.first === -1 ? 2 : 1), {
              persons: crew.map((p) => p.id), civ: m.civ, cause: `A ${(m.arrive - m.launched).toFixed(0)}-day voyage beyond any help; the ${civ?.name ?? 'lost'} programme was grounded.`,
            });
          }
          continue;
        }
        const first = Lm.first === -1;
        if (first) { Lm.first = day; Lm.by = crew[0]?.id ?? 0; Lm.civ = m.civ; Lm.pre = [Lm.n - 1, Lm.f, Lm.k]; }
        if (prog.moonLanding < 0) prog.moonLanding = day;
        w.history.record('DISCOVERY', day, `${crew.map((p) => p.name).join(', ') || 'A crew'} of the ${civ?.name ?? 'lost'} landed on the moon${first ? ' — the first people to walk on another world' : ''}.`, this.weight(first ? 3 : 2), {
          persons: crew.map((p) => p.id), civ: m.civ,
          cause: `A ${(m.arrive - m.launched).toFixed(0)}-day voyage across ${Math.round(MOON.distKm).toLocaleString('en-US')} km, built on ${prog.launches} launches${prog.moonFails ? `; ${prog.moonFails} mission${prog.moonFails > 1 ? 's' : ''} had been lost` : ''}${Lm.k ? `; ${Lm.k} li${Lm.k === 1 ? 'fe' : 'ves'} lost in all` : ''}.`,
        });
        for (const p of crew) { p.legend = true; p.status = clamp(p.status + 0.4); }
        continue;
      }
      const b = this.bodies[m.target];
      const ok = rng.next() > 0.05 + 0.4 * Math.pow(1 - (m.skill ?? 1), 2);
      w.history.record('DISCOVERY', m.arrive, ok
        ? `The ${civ?.name ?? 'lost'} probe ${m.name} ${m.landed ? 'landed on' : 'reached'} ${b.name}, a ${describe(b)} ${b.a.toFixed(2)} AU from the sun.`
        : `Contact with the probe ${m.name} was lost on approach to ${b.name}.`, ok ? 2 : 1, {
        civ: m.civ, cause: `It was launched ${((m.arrive - m.launched) / DAYS_PER_YEAR).toFixed(1)} years earlier on a transfer orbit.`,
      });
    }
    this.missions = this.missions.filter((m) => !m.done || day - m.arrive < 30 * DAYS_PER_YEAR);
  }

  /** Research weights go through the world's throttle (one major research event a decade); 3 is never held back. */
  private weight(want: number): number {
    const r = this.world.research;
    if (want >= 3) { r.lastMajor = this.world.day; return 3; }
    if (want === 2 && this.world.day - r.lastMajor < 10 * DAYS_PER_YEAR) return 1;
    if (want === 2) r.lastMajor = this.world.day;
    return want;
  }

  /** People away on a mission that has not yet come home cannot fly (or die on the pad) meanwhile. */
  private busy(): Set<number> {
    const b = new Set<number>();
    for (const m of this.missions) if (!m.done) for (const id of m.crew) b.add(id);
    return b;
  }

  private padCrew(s: Settlement, n: number) {
    const busy = this.busy();
    const adults = (this.world.residents.get(s.id) ?? []).filter((p) => p.alive && !p.band && !busy.has(p.id) && p.ageYears(this.world.day) >= 18);
    const out: Person[] = [];
    for (let k = 0; k < n * 3 && out.length < n && adults.length; k++) {
      const p = adults[this.world.rng.int(adults.length)];
      if (!out.includes(p)) out.push(p);
    }
    return out;
  }

  private launchSatellite(civ: number, pad: Settlement, prog: CivSpace, rng: Rng) {
    const w = this.world;
    const tele = rng.next() < 0.12;
    const s: Satellite = {
      id: this.next++, civ, name: makeWord(NATURAL_PHONOLOGY, rng, 2), kind: tele ? 'telescope' : 'satellite', launched: w.day,
      altKm: tele ? 500 + rng.next() * 300 : 180 + rng.next() * (rng.next() < 0.3 ? 9000 : 1400), inc: Math.abs(padLat(pad)) + rng.next() * 1.2, raan: rng.next() * Math.PI * 2, phase: rng.next(),
      until: w.day + (2 + rng.next() * 25) * DAYS_PER_YEAR,
    };
    this.satellites.push(s);
    if (this.satellites.filter((x) => x.civ === civ).length > 80) this.satellites.splice(this.satellites.findIndex((x) => x.civ === civ), 1);
    if (prog.firstSatellite < 0) {
      prog.firstSatellite = w.day;
      const L = ledgerOf(w, 'satellite');
      const worldFirst = L.first === -1;
      if (worldFirst) { L.first = w.day; L.at = pad.id; L.civ = civ; L.pre = [prog.launches - 1, L.f, L.k]; }
      const civName = w.civs[civ - 1]?.name;
      w.history.record('DISCOVERY', w.day, worldFirst
        ? `The ${civName} put the first artificial satellite, ${s.name}, into orbit.`
        : `The ${civName} put their first satellite, ${s.name}, into orbit.`, this.weight(worldFirst ? 3 : 1), {
        civ, settlement: pad.id, x: pad.x, y: pad.y,
        cause: `A rocket from ${pad.name} reached orbital speed after ${prog.launches} launch${prog.launches > 1 ? 'es' : ''}, ${prog.failures} of which failed; at ${Math.round(s.altKm)} km it circles the world every ${Math.round(orbitMinutes(s.altKm))} minutes.`,
      });
    }
  }

  private crew(s: Settlement, n: number) {
    const busy = this.busy();
    const adults = (this.world.residents.get(s.id) ?? []).filter((p) => p.alive && !p.band && !busy.has(p.id) && p.ageYears(this.world.day) > 25 && p.ageYears(this.world.day) < 45);
    adults.sort((a, b) => b.personality[3] + b.health - (a.personality[3] + a.health));
    return adults.slice(0, n);
  }

  // ------------------------------------------------------------ transport network
  /** Called when two settlements trade: open a sea lane or an air route if both ends have the means. */
  connect(a: Settlement, b: Settlement) {
    const w = this.world;
    const key = (k: 'sea' | 'air') => this.routes.find((r) => r.kind === k && ((r.a === a.id && r.b === b.id) || (r.a === b.id && r.b === a.id)));
    const d = distKm(a.x, a.y, b.x, b.y);
    if (d > 120 && w.buildings.count(a.id, 'airport') && w.buildings.count(b.id, 'airport') && !key('air')) {
      const path = [a.x, a.y, b.x, b.y];
      this.routes.push({ id: this.next++, kind: 'air', a: a.id, b: b.id, civ: a.civ, since: w.day, path, km: d, fleet: 1 + Math.floor(Math.min(a.pop, b.pop) / 300) });
      w.history.record('TRADE', w.day, `The first scheduled flights linked ${a.name} and ${b.name}.`, 1, { settlement: a.id, x: a.x, y: a.y, cause: `Both cities had airports and a trade worth flying for (${Math.round(d)} km).` });
    }
    // a lane needs a harbour at one end at least; the other town only has to be on the water (boats can land on a beach)
    const coastal = (s: Settlement) => { const c = idx(wrapX(Math.floor(s.x)), Math.floor(s.y)); return w.planet.coastDist[c] <= 1 || w.planet.lake[c] === 1; };
    const harbour = w.buildings.count(a.id, 'dock') > 0 || w.buildings.count(b.id, 'dock') > 0;
    if (d > 40 && harbour && coastal(a) && coastal(b) && !key('sea') && this.routes.filter((r) => r.kind === 'sea').length < 400) {
      const ocean = oceanGoing(a) ? 2 : 1;
      const path = seaPath(w, a, b, ocean);
      if (path) {
        let km = 0;
        for (let i = 2; i < path.length; i += 2) km += distKm(path[i - 2], path[i - 1], path[i], path[i + 1]);
        this.routes.push({ id: this.next++, kind: 'sea', a: a.id, b: b.id, civ: a.civ, since: w.day, path, km, fleet: 1 + Math.floor(Math.max(a.ships, b.ships) / 3) });
        if (this.routes.filter((r) => r.kind === 'sea').length === 1 || km > 600) {
          w.history.record('TRADE', w.day, `Ships began to sail between ${a.name} and ${b.name}.`, 1, { settlement: a.id, x: a.x, y: a.y, cause: `A harbour, ships, and a sea lane of ${Math.round(km)} km that was shorter or safer than any road.` });
        }
      }
    }
  }

  /** Drop routes whose ends are gone. */
  prune() {
    const w = this.world;
    this.routes = this.routes.filter((r) => w.settlements[r.a - 1]?.abandoned < 0 && w.settlements[r.b - 1]?.abandoned < 0);
  }

  /** Where a vehicle on a route is: fraction along the path for vehicle k at time `day` (0..1, and which way). */
  vehicleT(r: Route, k: number, day: number): { t: number; back: boolean } {
    const speedKmh = r.kind === 'air' ? 650 : 28;
    const hours = r.km / speedKmh + (r.kind === 'air' ? 1.5 : 10); // turnaround in port
    const cycle = (2 * hours) / 24; // days for a round trip
    const ph = ((day / cycle + (k / Math.max(1, r.fleet)) + (r.id % 7) / 7) % 1 + 1) % 1;
    const legT = r.km / speedKmh / 24 / cycle;
    const half = 0.5;
    if (ph < half) return { t: clamp(ph / legT), back: false };
    return { t: clamp((ph - half) / legT), back: true };
  }
}

function describe(b: Body): string {
  return b.kind === 'gas' ? `gas giant${b.rings ? ' with rings' : ''}` : b.kind === 'ice' ? 'frozen ice giant' : b.kind === 'lava' ? 'scorched world' : b.kind === 'desert' ? 'red desert world' : 'rocky world';
}

function padLat(s: Settlement): number {
  return (0.5 - s.y / H) * Math.PI;
}

export function orbitMinutes(altKm: number): number {
  const r = (R_KM + altKm) * 1000;
  return (2 * Math.PI * Math.sqrt((r * r * r) / GM)) / 60;
}

/** Shortest open-water route between two ports (8-connected cells; coastal craft keep to shallow seas). */
function seaPath(w: World, a: Settlement, b: Settlement, boat: number): number[] | null {
  const p = w.planet;
  const start = nearestSea(w, a), goal = nearestSea(w, b);
  if (start < 0 || goal < 0) return null;
  const ok = (i: number) => p.ocean[i] || p.lake[i] ? (boat >= 2 || p.elev[i] > -2.4) : false;
  const prev = new Int32Array(N).fill(-1);
  prev[start] = start;
  let frontier = [start];
  let steps = 0;
  while (frontier.length && prev[goal] < 0 && steps++ < 600) {
    const next: number[] = [];
    for (const c of frontier) for (let k = 0; k < 8; k++) {
      const n = NBR8[c * 8 + k];
      if (n < 0 || prev[n] >= 0 || !ok(n)) continue;
      prev[n] = c;
      next.push(n);
    }
    frontier = next;
  }
  if (prev[goal] < 0) return null;
  const cells: number[] = [];
  for (let c = goal; c !== start; c = prev[c]) cells.push(c);
  cells.push(start);
  cells.reverse();
  const out: number[] = [a.x, a.y];
  // keep every few cells (smoothed) so ships do not zig-zag along the grid
  for (let i = 0; i < cells.length; i += 2) out.push((cells[i] % W) + 0.5, Math.floor(cells[i] / W) + 0.5);
  out.push(b.x, b.y);
  return out;
}

function nearestSea(w: World, s: Settlement): number {
  const cx = Math.floor(s.x), cy = Math.floor(s.y);
  let best = -1, bd = 1e9;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const y = cy + dy;
    if (y < 0 || y >= H) continue;
    const i = idx(wrapX(cx + dx), y);
    if (!w.planet.ocean[i]) continue;
    const d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}
