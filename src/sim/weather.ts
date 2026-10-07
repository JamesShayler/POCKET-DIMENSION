import type { World } from './world';
import { Rng, clamp } from './rng';
import { H, N, W, NR, RF, RW, cellLat, idx } from './grid';
import { AXIAL_TILT, DAYS_PER_YEAR, declination, seasonOf, seasonPhase, localTime } from './time';
import { NATURAL_PHONOLOGY, makeWord } from './names';
import { ignite, stepFires, stormLandfall } from './hazards';

/**
 * Weather on a 128×64 grid (≈50 km cells), stepped in sim time:
 *  - air temperature relaxes to the seasonal climate but is carried by the wind, so cold and warm air masses meet in fronts
 *  - humidity evaporates from warm seas, lakes and wet soil, is carried by the wind and rains out when air is lifted
 *    (mountains, the shifting tropical convergence zone, storms, fronts) or saturated
 *  - cyclones form over warm tropical seas and in the temperate westerlies, drift with the steering winds, and die over land
 *  - monsoons: continents heat up in summer (thermal lows pull moist air inland) and chill in winter
 *  - ocean currents are wind-driven, turn along coasts (warm poleward western-boundary currents, cold equatorward
 *    eastern-boundary currents with upwelling) and carry sea-surface temperature
 * Rain and snow fall onto the simulation grid as soil moisture and snowpack, which drive plants, crops, droughts, floods
 * and wildfires.
 */
export const WW = 128;
export const WH = 64;
export const WN = WW * WH;
const SC = W / WW; // sim cells per weather cell (2)

export interface Storm {
  id: number;
  name: string;
  x: number; // weather-grid coords
  y: number;
  depth: number; // hPa below ambient
  radius: number; // weather cells
  tropical: boolean;
  age: number; // days
  peak: number;
  landfall: boolean;
}

/** saturation humidity (normalised) from -40 °C to 45 °C in 0.1 °C steps */
const QSAT = Float32Array.from({ length: 851 }, (_, i) => 0.25 * Math.exp(0.06 * (i / 10 - 40)));

const wlat = (y: number) => Math.PI / 2 - ((y + 0.5) / WH) * Math.PI;

export class Weather {
  T = new Float32Array(WN); // air °C
  q = new Float32Array(WN); // precipitable water (normalised)
  cloud = new Float32Array(WN); // 0..1
  precip = new Float32Array(WN); // mm/day now
  u = new Float32Array(WN); // m/s east
  v = new Float32Array(WN); // m/s north
  p = new Float32Array(WN); // pressure anomaly, hPa
  sst = new Float32Array(WN); // sea surface temperature °C
  cu = new Float32Array(WN); // ocean current east m/s
  cv = new Float32Array(WN); // ocean current north m/s
  upwell = new Float32Array(WN); // 0..1 nutrient upwelling (rich fisheries)
  rain3 = new Float32Array(WN); // rain over the last ~3 days (mm)
  lightning = new Float32Array(WN); // strikes per day
  storms: Storm[] = [];
  nextStorm = 1;
  acc = 0; // sim days waiting to be integrated
  lastDay = 0;
  // geography on the weather grid
  land = new Float32Array(WN); // land fraction
  elev = new Float32Array(WN); // mean land elevation (km)
  climT = new Float32Array(WN); // annual mean temperature
  ampT = new Float32Array(WN); // seasonal amplitude signed by hemisphere
  /** per-region rain this season, and its long-run mean (for anomalies that are always relative to the local climate) */
  seasonRain = new Float32Array(NR);
  /** long-run mean rain per region for each season of the year */
  climRain = new Float32Array(NR * 4);
  climN = new Uint16Array(4);
  seasonsObserved = 0;
  /** sim days of weather integrated this season */
  seasonDays = 0;
  private tmp = new Float32Array(WN);
  private depA = new Int32Array(WN);
  private depB = new Int32Array(WN);
  private depFx = new Float32Array(WN);
  private depFy = new Float32Array(WN);
  private carried: Float32Array[];
  sstAcc = 0;
  /** rain (mm) and temperature·days waiting to be handed to the land surface */
  rainAcc = new Float32Array(WN);
  tAcc = new Float32Array(WN);
  surfAcc = 0;
  /** mean soil moisture and vegetation of the land under each weather cell (for evaporation) */
  wSoil = new Float32Array(WN);
  wVeg = new Float32Array(WN);
  rng: Rng;

  constructor(private world: World) {
    this.rng = Rng.derive(world.seed, 'weather-dyn');
    const p = world.planet;
    for (let y = 0; y < WH; y++) for (let x = 0; x < WW; x++) {
      const k = y * WW + x;
      let land = 0, e = 0, t = 0, a = 0;
      for (let dy = 0; dy < SC; dy++) for (let dx = 0; dx < SC; dx++) {
        const i = idx(x * SC + dx, y * SC + dy);
        if (!p.ocean[i]) { land++; e += Math.max(0, p.elev[i]); }
        t += p.tempMean[i];
        const lat = cellLat(y * SC + dy);
        a += p.tempAmp[i] * (lat >= 0 ? 1 : -1) * Math.min(1, 0.25 + Math.abs(lat) * 1.6);
      }
      const n = SC * SC;
      this.land[k] = land / n;
      this.elev[k] = land ? e / land : 0;
      this.climT[k] = t / n;
      this.ampT[k] = a / n;
    }
    // start from climate: moist marine air, drier air inland, and the cloud such air carries (a dry start would leave
    // the sky empty for days of living time while evaporation caught up)
    for (let k = 0; k < WN; k++) {
      this.T[k] = this.climT[k];
      this.sst[k] = this.climT[k];
      const rh = 0.72 - 0.22 * this.land[k];
      this.q[k] = rh * this.qsat(this.T[k]);
      this.cloud[k] = Math.max(0, Math.min(1, (rh - 0.45) * 1.7));
    }
    this.computeCurrents(0);
    this.carried = [this.T, this.q, this.cloud];
    for (let y = 0; y < WH; y++) for (let x = 0; x < WW; x++) {
      const k = y * WW + x;
      let soil = 0, veg = 0, n = 0;
      for (let dy = 0; dy < SC; dy++) for (let dx = 0; dx < SC; dx++) {
        const i = idx(x * SC + dx, y * SC + dy);
        if (p.ocean[i]) continue;
        soil += world.env.soil[i]; veg += world.env.veg[i]; n++;
      }
      this.wSoil[k] = n ? soil / n : 0;
      this.wVeg[k] = n ? veg / n : 0;
    }
  }

  qsat(T: number) {
    const t = (T < -40 ? -40 : T > 45 ? 45 : T) * 10 + 400;
    const i = Math.floor(t);
    const f = t - i;
    return QSAT[i] * (1 - f) + QSAT[i + 1 > 850 ? 850 : i + 1] * f;
  }

  /** Base circulation at a latitude (radians) and season: trades, westerlies, polar easterlies, Hadley inflow to the ITCZ. */
  private baseWind(lat: number, day: number): [number, number] {
    const itcz = 0.45 * declination(day); // the convergence zone follows the sun
    const a = (lat - itcz) * (180 / Math.PI);
    const aa = Math.abs(a);
    const u = (aa < 60 ? -Math.cos((2 * Math.PI * aa) / 60) : -1) * 7;
    const v = aa < 30 ? -Math.sign(a) * 2.2 * Math.sin((aa / 30) * Math.PI) : aa < 60 ? Math.sign(a) * 1.2 * Math.sin(((aa - 30) / 30) * Math.PI) : 0;
    return [u, v];
  }

  private computeCurrents(day: number) {
    // wind-driven surface drift, deflected along coasts: westward equatorial flow piles against eastern shores and turns
    // poleward (warm), eastward drift at mid-latitudes reaching western shores turns equatorward (cold, upwelling)
    for (let y = 0; y < WH; y++) {
      const lat = wlat(y);
      const [ub] = this.baseWind(lat, day);
      for (let x = 0; x < WW; x++) {
        const k = y * WW + x;
        if (this.land[k] > 0.5) { this.cu[k] = this.cv[k] = 0; this.upwell[k] = 0; continue; }
        let cu = ub * 0.045;
        let cv = 0;
        const dir = cu >= 0 ? 1 : -1;
        let coast = 0;
        for (let s = 1; s <= 3; s++) if (this.land[y * WW + ((x + dir * s + WW) % WW)] > 0.5) { coast = 1 - (s - 1) / 3; break; }
        if (coast > 0) {
          const pole = lat >= 0 ? 1 : -1;
          const speed = Math.abs(cu);
          cv = (dir < 0 ? pole : -pole) * speed * 1.6 * coast;
          cu *= 1 - coast;
          this.upwell[k] = dir > 0 ? coast : 0;
        } else this.upwell[k] = Math.max(0, 1 - Math.abs(lat * (180 / Math.PI)) / 4) * 0.5; // equatorial upwelling
        this.cu[k] = cu;
        this.cv[k] = cv;
      }
    }
    // smooth into coherent streams
    for (let it = 0; it < 3; it++) {
      for (const f of [this.cu, this.cv]) {
        this.tmp.set(f);
        for (let y = 1; y < WH - 1; y++) for (let x = 0; x < WW; x++) {
          const k = y * WW + x;
          if (this.land[k] > 0.5) continue;
          let s = this.tmp[k] * 2, w = 2;
          for (const n of [k - 1, k + 1, k - WW, k + WW]) { const nn = n < 0 || n >= WN ? k : n; if (this.land[nn] <= 0.5) { s += this.tmp[nn]; w++; } }
          f[k] = s / w;
        }
      }
    }
  }

  /** Bilinear sample with east-west wrap. */
  private sample(f: Float32Array, x: number, y: number): number {
    y = Math.max(0, Math.min(WH - 1.001, y));
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const xa = ((x0 % WW) + WW) % WW, xb = (xa + 1) % WW;
    const ya = y0, yb = Math.min(WH - 1, y0 + 1);
    return (f[ya * WW + xa] * (1 - fx) + f[ya * WW + xb] * fx) * (1 - fy) + (f[yb * WW + xa] * (1 - fx) + f[yb * WW + xb] * fx) * fy;
  }

  /**
   * Semi-Lagrangian transport: each cell takes the value found upwind, where its air came from `dtDays` ago. The
   * departure points are computed once and shared by every field carried by the same flow.
   */
  private advect(fields: Float32Array[], u: Float32Array, v: Float32Array, dtDays: number, scale = 1) {
    const ia = this.depA, ib = this.depB, fxA = this.depFx, fyA = this.depFy;
    const kmy = (Math.PI * 1000) / WH;
    for (let y = 0; y < WH; y++) {
      const kmx = Math.max(15, (2 * Math.PI * 1000 * Math.cos(wlat(y))) / WW);
      for (let x = 0; x < WW; x++) {
        const k = y * WW + x;
        let sx = x - (u[k] * scale * 86.4 * dtDays) / kmx;
        let sy = y + (v[k] * scale * 86.4 * dtDays) / kmy;
        sy = sy < 0 ? 0 : sy > WH - 1.001 ? WH - 1.001 : sy;
        sx = ((sx % WW) + WW) % WW;
        const x0 = Math.floor(sx), y0 = Math.floor(sy);
        ia[k] = y0 * WW + x0;
        ib[k] = y0 * WW + (x0 + 1 === WW ? 0 : x0 + 1);
        fxA[k] = sx - x0;
        fyA[k] = sy - y0;
      }
    }
    for (const f of fields) {
      const t = this.tmp;
      t.set(f);
      for (let k = 0; k < WN; k++) {
        const a = ia[k], b = ib[k], fx = fxA[k], fy = fyA[k];
        const a2 = a + WW < WN ? a + WW : a, b2 = b + WW < WN ? b + WW : b;
        f[k] = (t[a] * (1 - fx) + t[b] * fx) * (1 - fy) + (t[a2] * (1 - fx) + t[b2] * fx) * fy;
      }
    }
  }

  /** Air temperature (°C) at a map position, with a day/night swing when `day` resolves hours. */
  airTemp(x: number, y: number, day: number, diurnal = true): number {
    const t = this.sample(this.T, x / SC - 0.5, y / SC - 0.5);
    const e = Math.max(0, this.world.planet.elev[idx(((Math.floor(x) % W) + W) % W, Math.max(0, Math.min(H - 1, Math.floor(y))))]);
    const lapse = -6.5 * (e - this.sample(this.elev, x / SC - 0.5, y / SC - 0.5));
    if (!diurnal) return t + lapse;
    const lt = localTime(day, x);
    const cloud = this.sample(this.cloud, x / SC - 0.5, y / SC - 0.5);
    return t + lapse + Math.cos((lt - 0.6) * Math.PI * 2) * 6 * (1 - 0.6 * cloud);
  }
  at(f: 'cloud' | 'precip' | 'u' | 'v' | 'rain3' | 'p', x: number, y: number): number {
    return this.sample(this[f], x / SC - 0.5, y / SC - 0.5);
  }

  /**
   * Advance the weather by `dt` days (called every tick; integrates in steps of at least half an hour). At high time
   * rates the atmosphere is advanced in at most 4 sub-steps of at most a day each, and their rain, snow and evaporation
   * are scaled to the full elapsed time — a fair sample of the weather rather than a skipped one.
   */
  step(dt: number) {
    this.acc += dt;
    if (this.acc < 1 / 48) return;
    const left = this.acc;
    this.acc = 0;
    const n = Math.min(4, Math.ceil(left / 0.5));
    const sub = Math.min(1, left / n);
    for (let i = 0; i < n; i++) this.integrate(sub, left / (n * sub));
    this.seasonDays += left;
  }

  private integrate(dt: number, scale = 1) {
    const w = this.world;
    const day = w.day;
    const phase = seasonPhase(day);
    const dust = w.sky.dust(day);
    const full = dt * scale; // sim days this sample stands for
    // ---- pressure: thermal highs/lows over continents (monsoons) + storms
    for (let k = 0; k < WN; k++) this.p[k] = -this.land[k] * this.ampT[k] * phase * 0.7;
    for (const s of this.storms) {
      const r = Math.ceil(s.radius * 2.5);
      const inv = 1 / (s.radius * s.radius);
      for (let dy = -r; dy <= r; dy++) {
        const y = Math.floor(s.y) + dy;
        if (y < 0 || y >= WH) continue;
        for (let dx = -r; dx <= r; dx++) {
          const x = ((Math.floor(s.x) + dx) % WW + WW) % WW;
          this.p[y * WW + x] -= s.depth * Math.exp(-(dx * dx + dy * dy) * inv);
        }
      }
    }
    // ---- winds: base circulation + flow around pressure anomalies (along the isobars, with some inflow to lows)
    for (let y = 0; y < WH; y++) {
      const lat = wlat(y);
      const [ub, vb] = this.baseWind(lat, day);
      const f = Math.sin(lat);
      const hemi = Math.abs(f) < 0.12 ? 0 : Math.sign(f);
      const row = y * WW;
      for (let x = 0; x < WW; x++) {
        const k = row + x;
        const gx = (this.p[row + (x + 1 === WW ? 0 : x + 1)] - this.p[row + (x === 0 ? WW - 1 : x - 1)]) * 0.5;
        const gy = ((y > 0 ? this.p[k - WW] : this.p[k]) - (y < WH - 1 ? this.p[k + WW] : this.p[k])) * 0.5; // north minus south
        this.u[k] = ub - hemi * gy * 0.9 - gx * 0.25;
        this.v[k] = vb + hemi * gx * 0.9 - gy * 0.25;
      }
    }
    // ---- carry heat, water and cloud with the wind
    this.advect(this.carried, this.u, this.v, dt);
    // ---- ocean: currents carry sea temperature (slowly: integrated about once a day)
    if (Math.floor(day / 30) !== Math.floor((day - full) / 30)) this.computeCurrents(day);
    this.sstAcc += dt;
    if (this.sstAcc >= 1) { this.advect([this.sst], this.cu, this.cv, this.sstAcc, 4); this.sstAcc = 0; }
    const kR = 1 - Math.exp(-dt / 5);
    const kS = 1 - Math.exp(-full / 40);
    const kC = 1 - Math.exp(-dt / 0.3);
    const rainDecay = Math.exp(-dt / 3);
    const itczLat = 0.45 * declination(day);
    const T_ = this.T, q_ = this.q, el = this.elev, sst = this.sst, landA = this.land, climT = this.climT, ampT = this.ampT, upw = this.upwell;
    const pA = this.p, uA = this.u, vA = this.v, cloud = this.cloud, precip = this.precip, rain3 = this.rain3, lightA = this.lightning;
    const wSoil = this.wSoil, wVeg = this.wVeg, rainAcc = this.rainAcc, tAcc = this.tAcc;
    const ocean = w.planet.ocean;
    const rng = this.rng;
    const dustT = (1 - dust) * 8;
    const dtc = Math.max(dt, 0.02);
    for (let y = 0; y < WH; y++) {
      const lat = wlat(y);
      const il = (lat - itczLat) / 0.12;
      const itcz08 = Math.exp(-il * il) * 0.8;
      const row = y * WW;
      for (let x = 0; x < WW; x++) {
        const k = row + x;
        const xr = x + 1 === WW ? row : k + 1, xl = x === 0 ? row + WW - 1 : k - 1;
        const land = landA[k];
        const seasonalT = ampT[k] * phase;
        // sea surface: slow, current-driven, cooled where deep water wells up
        const ss = sst[k] + (climT[k] + seasonalT * 0.35 - upw[k] * 4 - sst[k]) * kS;
        sst[k] = ss;
        // air relaxes toward the surface below it (sea air toward the sea temperature)
        const base = (climT[k] + seasonalT) * dust - dustT;
        const surf = land > 0.5 ? base : base * 0.3 + ss * 0.7;
        const T = T_[k] + (surf - T_[k]) * kR;
        T_[k] = T;
        const qs = this.qsat(T);
        // evaporation: warm open water most, wet soil and plants on land
        const evap = land < 0.5 ? 0.32 * this.qsat(ss) * (1 - land) : 0.22 * qs * wSoil[k] * (0.4 + wVeg[k]);
        const qcap = qs * 1.2;
        let q = q_[k];
        if (q < qcap) { const e = (evap * dt) / qcap; q += (qcap - q) * (e < 0.05 ? e * (1 - e * 0.5) : 1 - Math.exp(-e)); }
        // lifting: wind blowing uphill, the tropical convergence zone, storms, fronts, afternoon convection
        const ex = el[xr] - el[xl];
        const ey = (y > 0 ? el[k - WW] : el[k]) - (y < WH - 1 ? el[k + WW] : el[k]);
        const up = uA[k] * ex + vA[k] * ey;
        const oro = up > 0 ? up * 0.25 : 0;
        const tx = T_[xr] - T_[xl];
        const ty = (y > 0 ? T_[k - WW] : T) - (y < WH - 1 ? T_[k + WW] : T);
        const g = Math.sqrt(tx * tx + ty * ty) / 12;
        const front = (g < 1 ? g : 1) * 0.5;
        const sp = -pA[k] + land * seasonalT * 0.7; // the storm part of the low
        const stormLift = sp > 0 ? sp / 25 : 0;
        const rh = q / qs;
        const convect = land > 0.5 && T > 18 ? Math.min(0.6, (T - 18) / 20) * (rh < 1 ? rh : 1) : 0;
        const lift = oro + itcz08 + front + stormLift + convect;
        let P = (rh > 0.75 ? (rh - 0.75) * 1.8 : 0) + q * lift * 0.9; // per day, normalised water
        const pmax = q / dtc;
        if (P > pmax) P = pmax;
        q -= P * dt;
        q_[k] = q > 0 ? q : 0;
        const mm = P * 22;
        precip[k] = mm;
        rain3[k] = rain3[k] * rainDecay + mm * dt;
        let ct = (rh - 0.45) * 1.7 + lift * 0.35;
        ct = ct < 0 ? 0 : ct > 1 ? 1 : ct;
        cloud[k] += (ct - cloud[k]) * kC;
        const lightning = (stormLift > 0.3 || convect > 0.2) && mm > 3 ? (mm / 10) * (0.5 + convect) : 0;
        lightA[k] = lightning;
        if (land > 0) {
          rainAcc[k] += mm * full;
          tAcc[k] += T * full;
          // dry lightning (or lightning at the edge of a storm) starts wildfires in parched, overgrown land
          if (lightning > 0 && rh < 0.95 && T > 12 && rng.next() < Math.min(0.5, lightning * full * 0.2)) {
            const i = idx(x * SC + rng.int(SC), y * SC + rng.int(SC));
            if (!ocean[i]) ignite(w, i, 'Lightning struck dry, overgrown land.');
          }
        }
      }
    }
    this.surfAcc += full;
    if (this.surfAcc >= 0.25) this.deliver();
    stepFires(w, full);
    this.stepStorms(dt, scale);
  }

  /** Hand the accumulated rain and mean temperature to the land surface (each cell corrected for its own height). */
  private deliver() {
    const days = this.surfAcc;
    for (let k = 0; k < WN; k++) if (this.land[k] > 0) this.tAcc[k] /= days;
    this.world.env.surface(this.rainAcc, this.tAcc, this.elev, days, this.seasonRain, this.wSoil, this.wVeg);
    this.rainAcc.fill(0);
    this.tAcc.fill(0);
    this.surfAcc = 0;
  }

  private stepStorms(dt: number, scale: number) {
    const w = this.world;
    const day = w.day;
    const rng = this.rng;
    const north = declination(day) > 0;
    for (const s of this.storms) {
      const k = Math.max(0, Math.min(WH - 1, Math.floor(s.y))) * WW + ((Math.floor(s.x) % WW) + WW) % WW;
      const lat = wlat(Math.floor(s.y));
      // steering flow + poleward drift
      const kmx = Math.max(15, (2 * Math.PI * 1000 * Math.cos(lat)) / WW);
      const kmy = (Math.PI * 1000) / WH;
      const [ub, vb] = this.baseWind(lat, day);
      const drift = (s.tropical ? 0.5 : 0.6) * Math.sign(lat || 1);
      s.x = (((s.x + ((ub * 0.8) * 86.4 * dt) / kmx) % WW) + WW) % WW;
      s.y = Math.max(1, Math.min(WH - 2, s.y - ((vb * 0.4 + drift) * 86.4 * dt) / kmy));
      s.age += dt * scale;
      const overLand = this.land[k] > 0.5;
      if (overLand && !s.landfall) {
        s.landfall = true;
        const sx = s.x * SC + SC / 2, sy = s.y * SC + SC / 2;
        const near = w.settlementsNearRegion(Math.floor(sy / RF) * RW + Math.floor(sx / RF));
        if (s.tropical && s.depth > 25) {
          w.history.record('DISASTER', day, `Hurricane ${s.name} made landfall${near ? ' near settlements' : ''}.`, near ? 2 : 1, {
            x: sx, y: sy, cause: `It grew over sea water of ${this.sst[k].toFixed(0)}°C and was steered ashore by the trade winds.`,
          });
        }
        stormLandfall(w, s, sx, sy);
      }
      // warm sea feeds tropical storms, land and cool water starve them; temperate lows live off temperature contrasts
      if (s.tropical) s.depth += (overLand ? -14 : this.sst[k] > 26 ? 15 : this.sst[k] > 24.5 ? 9 : -5) * dt;
      else s.depth += (s.age < 2.5 ? 6 : -5) * dt;
      s.peak = Math.max(s.peak, s.depth);
    }
    this.storms = this.storms.filter((s) => s.depth > 2 && s.age < 20);
    // genesis
    for (let t = 0; t < 2; t++) {
      // tropical: warm sea in the late summer of either hemisphere
      const hemiN = t === 0;
      const late = hemiN ? north : !north;
      if (late && rng.next() < 0.35 * dt * scale && this.storms.length < 14) {
        // seedlings drift off the trade-wind waves between 5° and 20° latitude; only warm water lets them grow
        for (let tries = 0; tries < 4; tries++) {
          const y = hemiN ? WH / 2 - 2 - rng.int(6) : WH / 2 + 1 + rng.int(6);
          const x = rng.int(WW);
          const k = y * WW + x;
          if (this.land[k] < 0.2 && this.sst[k] > 25.5) {
            this.storms.push({ id: this.nextStorm, name: makeWord(NATURAL_PHONOLOGY, rng, 2), x, y, depth: 6, radius: 1.6, tropical: true, age: 0, peak: 6, landfall: false });
            this.nextStorm++;
            break;
          }
        }
      }
      // temperate lows ride the westerlies all year
      if (rng.next() < 0.9 * dt * scale && this.storms.length < 16) {
        const yy = hemiN ? 6 + rng.int(12) : WH - 7 - rng.int(12);
        this.storms.push({ id: this.nextStorm, name: makeWord(NATURAL_PHONOLOGY, rng, 2), x: rng.int(WW), y: yy, depth: 8, radius: 3 + rng.next() * 2, tropical: false, age: 0, peak: 8, landfall: false });
        this.nextStorm++;
      }
    }
  }

  /** Forget a season the weather did not run through (prehistory is stepped a season at a time). */
  resetSeason() {
    this.seasonRain.fill(0);
    this.seasonDays = 0;
  }

  /** Once per season: rainfall relative to the local long-run mean for this time of year becomes the anomaly the land feels. */
  seasonEnd(): Float32Array {
    const out = new Float32Array(NR);
    const season = seasonOf(this.world.day - 1);
    const n = this.climN[season];
    const off = season * NR;
    for (let r = 0; r < NR; r++) {
      const rain = this.seasonRain[r];
      const c = n < 5 ? (this.climRain[off + r] * n + rain) / (n + 1) : this.climRain[off + r] * 0.9 + rain * 0.1;
      this.climRain[off + r] = c;
      out[r] = n === 0 ? 1 : clamp((rain + 3) / (c + 3), 0.08, 2.2);
      this.seasonRain[r] = 0;
    }
    this.climN[season] = Math.min(60000, n + 1);
    this.seasonsObserved++;
    this.seasonDays = 0;
    return out;
  }
}
void AXIAL_TILT; void N; void DAYS_PER_YEAR; void H;
