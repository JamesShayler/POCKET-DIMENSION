import type { World } from './world';
import type { Storm } from './weather';
import type { Building } from './buildings';
import type { Settlement } from './settlements';
import { clamp } from './rng';
import { H, KM_PER_CELL_Y, N, NBR8, NBR_DX, NBR_DY, W, distKm, idx, wrapX } from './grid';
import { DAYS_PER_YEAR, SEASON_NAMES, seasonOf } from './time';

/**
 * Natural hazards that grow out of the physical systems rather than dice rolls:
 *  - wildfires start from lightning (or careless people) in hot, dry, fuel-rich land, run with the wind and die in rain
 *  - floods come from runoff the soil could not hold, routed down the real river network
 *  - earthquakes and tsunamis strike along converging plate boundaries
 *  - storms make landfall with wind, surge and rain
 */
export interface Fire {
  id: number;
  x: number;
  y: number;
  cells: number[];
  burnt: number;
  started: number;
  cause: string;
  reported: boolean;
}

const FIRE_BURNOUT = 2.2; // days a cell burns
const MASONRY = new Set(['stonehouse', 'temple', 'tower', 'smithy', 'brickhouse']);
const WOODEN = new Set(['hut', 'house', 'granary', 'workshop', 'market', 'hall']);

function settlementsWithin(w: World, x: number, y: number, km: number): { s: Settlement; d: number }[] {
  const out: { s: Settlement; d: number }[] = [];
  for (const s of w.settlements) {
    if (s.abandoned >= 0) continue;
    const d = distKm(s.x, s.y, x, y);
    if (d < km) out.push({ s, d });
  }
  return out;
}

function cropLoss(w: World, s: Settlement, frac: number) {
  for (const b of w.buildings.of(s.id)) if (b.kind === 'field' && b.fstate === 1) b.crop = clamp(b.crop + frac);
}

// ------------------------------------------------------------------ wildfire
export function ignite(w: World, cell: number, cause: string): boolean {
  const env = w.env;
  if (env.burning[cell] > 0 || w.planet.ocean[cell] || env.veg[cell] < 0.2 || env.soil[cell] > 0.35 || env.snow[cell] > 5 || env.burned[cell] > 0.4) return false;
  env.burning[cell] = 1e-4;
  env.fires.push({ id: env.nextFire++, x: (cell % W) + 0.5, y: Math.floor(cell / W) + 0.5, cells: [cell], burnt: 0, started: w.day, cause, reported: false });
  return true;
}

/** Spread and burn out fires; called with the weather (which supplies wind, rain and temperature). */
export function stepFires(w: World, dt: number) {
  const env = w.env;
  const wx = w.weather;
  const rng = wx.rng;
  // people start fires too: land clearing, hearths, signal fires
  for (const s of w.settlements) {
    if (s.abandoned >= 0 || !s.tech.has('fire') || rng.next() > dt * 0.0015 * Math.min(4, s.pop / 60)) continue;
    const c = idx(wrapX(Math.floor(s.x + (rng.next() - 0.5) * 2)), Math.max(0, Math.min(H - 1, Math.floor(s.y + (rng.next() - 0.5) * 2))));
    if (wx.airTemp((c % W) + 0.5, Math.floor(c / W) + 0.5, w.day, false) > 15) ignite(w, c, `A fire set by the people of ${s.name} got out of control.`);
  }
  if (!env.fires.length) return;
  for (const f of env.fires) {
    const next: number[] = [];
    for (const c of f.cells) {
      const x = (c % W) + 0.5, y = Math.floor(c / W) + 0.5;
      const rain = wx.at('precip', x, y);
      env.burning[c] += dt * (rain > 4 ? 3 : 1);
      if (env.burning[c] >= FIRE_BURNOUT || rain > 12) {
        env.burning[c] = 0;
        env.veg[c] *= rain > 12 ? 0.6 : 0.2;
        env.burned[c] = rain > 12 ? 0.5 : 1;
        f.burnt++;
        burnCell(w, c, f);
        continue;
      }
      next.push(c);
      const u = wx.at('u', x, y), v = wx.at('v', x, y);
      const ws = Math.hypot(u, v) + 0.5;
      const T = wx.airTemp(x, y, w.day, false);
      if (T < 4) continue;
      for (let k = 0; k < 8; k++) {
        const n = NBR8[c * 8 + k];
        if (n < 0 || w.planet.ocean[n] || env.burning[n] > 0 || env.burned[n] > 0.4) continue;
        const fuel = env.veg[n] - 0.18;
        const dry = 0.36 - env.soil[n];
        if (fuel <= 0 || dry <= 0 || env.snow[n] > 5) continue;
        const dl = Math.hypot(NBR_DX[k], NBR_DY[k]);
        const along = (NBR_DX[k] * u - NBR_DY[k] * v) / (dl * ws); // north is -y on the grid
        const p = dt * 1.1 * fuel * (dry / 0.36) * (0.6 + Math.max(-0.5, along) * Math.min(2, ws / 6)) * (T > 25 ? 1.4 : 1);
        if (rng.next() < p) { env.burning[n] = 1e-4; next.push(n); }
      }
    }
    f.cells = next.length > 400 ? next.slice(0, 400) : next;
    if (!f.reported && f.burnt + f.cells.length >= 12) {
      f.reported = true;
      const near = settlementsWithin(w, f.x, f.y, 150).length;
      w.history.record('DISASTER', w.day, `A great wildfire is burning${near ? ' near settlements' : ''}.`, near ? 2 : 1, { x: f.x, y: f.y, cause: f.cause });
    }
  }
  env.fires = env.fires.filter((f) => f.cells.length > 0);
}

function burnCell(w: World, c: number, f: Fire) {
  // trees and bushes in the cell burn (they regrow at their species' pace)
  const nodes = w.res.nodes(c);
  for (const n of nodes) if (n.kind === 'tree' || n.kind === 'bush') w.res.take(c, n.slot, n.max * (0.5 + w.weather.rng.next() * 0.45), w.day);
  const x = (c % W) + 0.5, y = Math.floor(c / W) + 0.5;
  for (const { s } of settlementsWithin(w, x, y, 20)) {
    const brigade = s.tech.has('engineering') ? 0.4 : s.tech.has('architecture') ? 0.7 : 1;
    const burned = w.buildings.destroy(s.id, 0.22 * brigade, w.rng, (b: Building) => (WOODEN.has(b.kind) ? 1 : b.kind === 'field' ? 0 : 0.15));
    cropLoss(w, s, 0.7);
    s.res.wood *= 0.6;
    const dead = w.killInRadius(s.x, s.y, 0.35, 0.03 * brigade, 'a wildfire');
    w.history.record('DISASTER', w.day, `Wildfire swept into ${s.name}${burned ? `, burning ${burned} buildings` : ''}${dead ? ` and killing ${dead}` : ''}.`, burned + dead > 3 ? 2 : 1, {
      settlement: s.id, civ: s.civ, x: s.x, y: s.y, cause: `${f.cause} Dry soil and thick vegetation fed it.`,
    });
  }
}

// ------------------------------------------------------------------ crops
/** Once per season: growing crops suffer from the frosts and the dry soil they actually lived through. */
export function cropSeason(w: World) {
  const env = w.env;
  for (const s of w.settlements) {
    if (s.abandoned >= 0) continue;
    for (const b of w.buildings.of(s.id)) {
      if (b.kind !== 'field' || b.fstate !== 1) continue;
      const c = idx(wrapX(Math.floor(b.x)), Math.max(0, Math.min(H - 1, Math.floor(b.y))));
      const frost = env.frost[c];
      const dry = Math.max(0, 0.3 - env.soilMean[c]);
      const irrigated = s.tech.has('engineering') && w.planet.freshDist[c] <= 1 ? 0.35 : 1;
      b.crop = clamp(b.crop + Math.min(0.9, frost * 0.05) + dry * 2.2 * irrigated);
    }
  }
}

// ------------------------------------------------------------------ floods
/** Once per season: route the season's runoff down the river network; flows far above normal flood the valleys. */
export function floodSeason(w: World) {
  const p = w.planet;
  const env = w.env;
  const q = new Float32Array(N);
  for (let i = 0; i < N; i++) if (!p.ocean[i]) q[i] = env.runoff[i];
  const order = p.flowOrder;
  for (let k = order.length - 1; k >= 0; k--) {
    const i = order[k];
    const d = p.drain[i];
    if (d >= 0 && !p.ocean[d]) q[d] += q[i];
  }
  const season = seasonOf(w.day - 1);
  const seen = env.flowN[season];
  const learned = seen >= 3;
  const hit = new Set<number>();
  for (let i = 0; i < N; i++) {
    if (p.ocean[i]) continue;
    const ni = i * 4 + season;
    const norm = env.flowNorm[ni];
    if (learned && p.river[i] && q[i] > 400 && q[i] > norm * 2.2 + 150) {
      for (const { s, d } of settlementsWithin(w, (i % W) + 0.5, Math.floor(i / W) + 0.5, 30)) {
        if (hit.has(s.id)) continue;
        hit.add(s.id);
        const sev = clamp((q[i] / Math.max(1, norm) - 2.2) / 4, 0.1, 1) * (1 - d / 40);
        const lost = w.buildings.destroy(s.id, 0.12 * sev, w.rng, (b) => (b.kind === 'field' ? 0 : MASONRY.has(b.kind) ? 0.3 : 1));
        cropLoss(w, s, 0.8 * sev);
        s.food *= 1 - 0.3 * sev;
        const dead = w.killInRadius(s.x, s.y, 0.3, 0.02 * sev, 'a flood');
        // floods leave fertile silt behind
        for (let k = 0; k < 8; k++) { const n = NBR8[i * 8 + k]; if (n >= 0) env.fert[n] = clamp(env.fert[n] + 0.05 * sev); }
        w.history.record('DISASTER', w.day, `The river flooded ${s.name}${lost ? `, destroying ${lost} buildings` : ''}${dead ? `; ${dead} drowned` : ''}.`, sev > 0.5 || dead > 2 ? 2 : 1, {
          settlement: s.id, civ: s.civ, x: s.x, y: s.y, cause: `An unusually wet ${SEASON_NAMES[season].toLowerCase()} saturated the soil and ${(q[i] / Math.max(1, norm)).toFixed(1)}× the usual water came down the river.`,
        });
      }
    }
    env.flowNorm[ni] = seen < 5 ? (norm * seen + q[i]) / (seen + 1) : norm * 0.85 + q[i] * 0.15;
  }
  env.flowN[season] = Math.min(60000, seen + 1);
  env.runoff.fill(0);
}

// ------------------------------------------------------------------ earthquakes & tsunamis
export function quakeSeason(w: World) {
  const p = w.planet;
  const rng = w.rng;
  for (let i = 0; i < N; i++) {
    const near = p.plateNear[i];
    if (near < 0.35) continue;
    const conv = p.plateConv[i];
    const rate = near * near * (0.25 + Math.abs(conv)) * 3.5e-5 * (conv > 0 ? 1.6 : 0.6);
    if (rng.next() > rate) continue;
    // Gutenberg-Richter: big quakes are exponentially rarer; collisions and subduction allow the largest
    const mag = Math.min(conv > 0.4 ? 9.4 : 7.6, 5.2 + -Math.log(1 - rng.next()) * 0.75);
    quake(w, (i % W) + rng.next(), Math.floor(i / W) + rng.next(), mag, i);
  }
}

export function quake(w: World, x: number, y: number, mag: number, cell: number) {
  const p = w.planet;
  const radius = Math.pow(10, 0.42 * mag - 1.75); // km of strong shaking
  const offshore = p.ocean[cell] || p.coastDist[cell] <= 1;
  const tsunami = offshore && mag >= 7.6 && p.plateConv[cell] > 0.2;
  let deaths = 0;
  let lost = 0;
  const struck: string[] = [];
  for (const { s, d } of settlementsWithin(w, x, y, radius * 1.5)) {
    const sh = clamp(1 - d / (radius * 1.5)) * clamp((mag - 5) / 3);
    const wise = s.tech.has('engineering') ? 0.5 : 1;
    const n = w.buildings.destroy(s.id, 0.45 * sh * wise, w.rng, (b) => (b.kind === 'field' ? 0 : MASONRY.has(b.kind) ? 1.4 : 0.5));
    const dd = w.killInRadius(s.x, s.y, 0.35, 0.06 * sh * wise, 'an earthquake');
    if (n || dd) struck.push(s.name);
    lost += n; deaths += dd;
  }
  if (tsunami) {
    const reach = (mag - 7) * 700;
    for (const { s, d } of settlementsWithin(w, x, y, reach)) {
      const c = idx(wrapX(Math.floor(s.x)), Math.max(0, Math.min(H - 1, Math.floor(s.y))));
      if (p.coastDist[c] > 1) continue;
      const sev = clamp(1 - d / reach) * (p.elev[c] < 0.15 ? 1 : 0.4);
      const n = w.buildings.destroy(s.id, 0.5 * sev, w.rng, (b) => (b.kind === 'field' ? 0.6 : 1));
      cropLoss(w, s, sev);
      const dd = w.killInRadius(s.x, s.y, 0.4, 0.15 * sev, 'a tsunami');
      if (n || dd) struck.push(s.name);
      lost += n; deaths += dd;
    }
  }
  w.env.quakes.push({ x, y, day: w.day, mag });
  if (w.env.quakes.length > 40) w.env.quakes.shift();
  if (!struck.length && mag < 8) return;
  const conv = p.plateConv[cell];
  w.history.record('DISASTER', w.day, `A magnitude ${mag.toFixed(1)} earthquake${tsunami ? ' and tsunami' : ''} struck${struck.length ? ` ${struck.slice(0, 3).join(', ')}${struck.length > 3 ? ' and more' : ''}` : ''}${deaths ? `, killing ${deaths}` : ''}${lost ? ` and destroying ${lost} buildings` : ''}.`, deaths > 10 || mag >= 8 ? 3 : 2, {
    x, y, cause: conv > 0 ? 'Two tectonic plates are colliding here; stress built up along the fault until it slipped.' : 'The crust is being pulled apart along a rift, and a fault gave way.',
  });
}

// ------------------------------------------------------------------ storms
export function stormLandfall(w: World, s: Storm, x: number, y: number) {
  const radius = s.radius * (2 * Math.PI * 1000 / 128) * 0.9;
  const tropical = s.tropical && s.depth > 25;
  const winter = !s.tropical && s.depth > 18 && w.weather.airTemp(x, y, w.day, false) < 0;
  if (!tropical && !winter) return;
  const struck: string[] = [];
  let deaths = 0;
  let lost = 0;
  for (const { s: st, d } of settlementsWithin(w, x, y, radius)) {
    const sev = clamp(1 - d / radius) * clamp((s.depth - 15) / 60);
    const c = idx(wrapX(Math.floor(st.x)), Math.max(0, Math.min(H - 1, Math.floor(st.y))));
    const coastal = w.planet.coastDist[c] <= 1;
    if (tropical) {
      const n = w.buildings.destroy(st.id, 0.3 * sev * (coastal ? 1.4 : 1), w.rng, (b) => (b.kind === 'field' ? 0 : WOODEN.has(b.kind) ? 1 : 0.3));
      cropLoss(w, st, 0.6 * sev);
      const dd = w.killInRadius(st.x, st.y, 0.35, (coastal ? 0.04 : 0.015) * sev, s.tropical ? `Hurricane ${s.name}` : 'a storm');
      lost += n; deaths += dd;
      if (n || dd) struck.push(st.name);
    } else {
      const shelter = st.housing / Math.max(1, st.pop);
      const dd = w.killInRadius(st.x, st.y, 0.35, 0.02 * sev * clamp(1 - shelter), 'exposure in a blizzard');
      st.food *= 1 - 0.05 * sev;
      deaths += dd;
      if (dd) struck.push(st.name);
    }
  }
  if (!struck.length) return;
  w.history.record('DISASTER', w.day, `${tropical ? `Hurricane ${s.name}` : `A blizzard`} struck ${struck.slice(0, 3).join(', ')}${struck.length > 3 ? ' and more' : ''}${deaths ? `, killing ${deaths}` : ''}${lost ? `; ${lost} buildings were wrecked` : ''}.`, deaths > 5 || lost > 10 ? 2 : 1, {
    x, y, cause: tropical ? `The storm drew its strength from warm sea water and came ashore with ${Math.round(s.depth)} hPa below normal pressure at its eye.` : 'A deep winter low brought snow and gales.',
  });
}

void DAYS_PER_YEAR; void KM_PER_CELL_Y;
