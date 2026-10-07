import type { World } from './world';
import { Planet } from './planet';
import { Noise3 } from './noise';
import { Rng, clamp } from './rng';
import { N, NR, RW, RH, RF, W, H, idx, cellLat, cellLon, dirFromLonLat, NBR8, regionOfCell } from './grid';
import { DAYS_PER_YEAR, seasonPhase, yearOf } from './time';
import { cropSeason, floodSeason, quakeSeason, type Fire } from './hazards';

/** Root-zone water a soil holds at field capacity (mm). */
export const SOIL_MM = 150;

/** The living, changing environment layered on the fixed planet: vegetation, climate anomalies, fertility, disasters. */
export class Environment {
  veg = new Float32Array(N);
  fert = new Float32Array(N);
  anomaly = new Float32Array(NR).fill(1); // rainfall multiplier per region (droughts < 1, floods > 1)
  droughtSince = new Float64Array(NR).fill(-1);
  cultivated = new Uint8Array(N); // fields tended by a culture that knows agriculture
  forageStock = new Float32Array(N);
  forageDay = new Float64Array(N);
  regionTemp = new Float32Array(NR);
  regionTempRange = new Float32Array(NR);
  regionLand = new Uint16Array(NR);
  seasonT = new Float32Array(N);
  private noise: Noise3;
  private cellRegion = new Uint16Array(N);
  private seasonK = new Float32Array(N);
  private tvMean = new Float32Array(N);
  private rainMod = new Float32Array(NR);
  stepDays = 1;
  recentDroughts: { x: number; y: number; day: number }[] = [];
  // ---- the land surface under the weather
  /** root-zone soil moisture, fraction of field capacity */
  soil = new Float32Array(N);
  /** snow water equivalent (mm); deep, old snow is glacier ice */
  snow = new Float32Array(N);
  /** water the soil could not hold this season (mm) and the river flow it made */
  runoff = new Float32Array(N);
  /** usual river flow per cell for each season of the year */
  flowNorm = new Float32Array(N * 4);
  flowN = new Uint16Array(4);
  /** frost-days this season (crops suffer) */
  frost = new Float32Array(N);
  /** mean soil moisture over the last season */
  soilMean = new Float32Array(N);
  soilAcc = new Float32Array(N);
  soilDays = 0;
  /** 1 = just burned; fades as plants return */
  burned = new Float32Array(N);
  /** days a cell has been on fire (0 = not burning) */
  burning = new Float32Array(N);
  fires: Fire[] = [];
  nextFire = 1;
  quakes: { x: number; y: number; day: number; mag: number }[] = [];
  private wCount = new Uint8Array((W >> 1) * (H >> 1));

  constructor(public planet: Planet) {
    this.noise = new Noise3(Rng.derive(planet.seed, 'weather').state);
    this.veg.set(planet.baseVeg);
    this.fert.set(planet.fertility);
    for (let y = 0; y < H; y++) {
      const lat = Math.abs(cellLat(y));
      const sign = cellLat(y) >= 0 ? 1 : -1;
      for (let x = 0; x < W; x++) {
        const i = idx(x, y);
        this.cellRegion[i] = regionOfCell(x, y);
        this.seasonK[i] = planet.tempAmp[i] * sign * Math.min(1, 0.25 + lat * 1.6);
        const Tm = planet.tempMean[i];
        this.tvMean[i] = Math.max(0.08, clamp((Tm + 2) / 12) * clamp((38 - Tm) / 12));
        if (!planet.ocean[i]) {
          this.regionLand[this.cellRegion[i]]++;
          this.soil[i] = clamp(0.1 + planet.rain[i] * 0.6);
          this.soilMean[i] = this.soil[i];
          // ice sheets and high snowfields exist from the start
          const e = planet.elev[i];
          if (Tm < -9) this.snow[i] = 2500;
          else if (Tm < -3 && e > 1.5) this.snow[i] = 900;
        }
      }
    }
  }

  /**
   * The land surface's water balance over `days`, fed by the weather grid (2×2 sim cells per weather cell): rain soaks in
   * (snow piles up below freezing), snow melts with warmth, plants and sun draw water out, and what the soil cannot hold
   * runs off into the rivers. Temperatures are corrected for each cell's own height. Also returns the mean soil moisture
   * and vegetation under each weather cell (for evaporation).
   */
  surface(rainW: Float32Array, tW: Float32Array, elevW: Float32Array, days: number, regionRain: Float32Array, soilW: Float32Array, vegW: Float32Array) {
    const p = this.planet;
    const ocean = p.ocean, elev = p.elev;
    const soilA = this.soil, snowA = this.snow, vegA = this.veg, runoff = this.runoff, frost = this.frost, acc = this.soilAcc;
    // module constants copied to locals: hot loop (and much faster under CommonJS transpilation)
    const Wl = W, Hl = H, rf = RF, rw = RW, smm = SOIL_MM;
    const ww = Wl >> 1;
    soilW.fill(0);
    vegW.fill(0);
    const cnt = this.wCount;
    cnt.fill(0);
    this.soilDays += days;
    for (let y = 0; y < Hl; y++) {
      const wrow = (y >> 1) * ww;
      const rrow = Math.floor(y / rf) * rw;
      for (let x = 0; x < Wl; x++) {
        const i = y * Wl + x;
        if (ocean[i]) continue;
        const k = wrow + (x >> 1);
        const mm = rainW[k];
        const e = elev[i] > 0 ? elev[i] : 0;
        const T = tW[k] - 6.5 * (e - elevW[k]);
        let soil = soilA[i];
        let snow = snowA[i];
        if (mm > 0) {
          if (T < 0.5) snow = snow + mm > 6000 ? 6000 : snow + mm;
          else soil += mm / smm;
        }
        if (T > 0.5 && snow > 0) {
          let m = (T * 3.2 + mm * 0.15) * days;
          if (m > snow) m = snow;
          snow -= m;
          soil += m / smm;
        }
        // evapotranspiration: warm, leafy and wet means fast
        let pet = 0.5 + T * 0.17;
        if (pet > 0) {
          pet *= (0.45 + vegA[i] * 0.8) * (snow > 20 ? 0.1 : 1);
          const loss = (pet * days * Math.sqrt(soil > 0 ? soil : 0)) / smm;
          soil = loss > soil ? 0 : soil - loss;
        }
        if (soil > 1) {
          runoff[i] += (soil - 1) * smm;
          soil = 1;
        }
        soilA[i] = soil;
        snowA[i] = snow;
        if (T < -1) frost[i] += days;
        acc[i] += soil * days;
        regionRain[rrow + Math.floor(x / rf)] += mm / (rf * rf);
        soilW[k] += soil;
        vegW[k] += vegA[i];
        cnt[k]++;
      }
    }
    for (let k = 0; k < soilW.length; k++) if (cnt[k]) { soilW[k] /= cnt[k]; vegW[k] /= cnt[k]; }
  }

  rainAt(i: number): number {
    const y = Math.floor(i / W);
    const x = i % W;
    return this.planet.rain[i] * this.anomaly[regionOfCell(x, y)];
  }

  /** Food available to foragers in a cell right now (lazy-regenerating stock). */
  forageAvailable(i: number, day: number): number {
    const p = this.planet;
    if (p.ocean[i]) return 0;
    const rate = this.forageRate(i);
    const dt = Math.min(day - this.forageDay[i], 40);
    if (dt > 0) {
      this.forageStock[i] = Math.min(rate * (12 + this.stepDays), this.forageStock[i] + rate * dt);
      this.forageDay[i] = day;
    }
    return this.forageStock[i];
  }
  forageRate(i: number): number {
    const v = this.veg[i];
    const nearWater = this.planet.freshDist[i] <= 1 ? 1.25 : 1;
    const coast = this.planet.coastDist[i] <= 1 ? 1.2 : 1;
    return 14 * v * (0.25 + 0.75 * this.fert[i]) * nearWater * coast * (this.snow[i] > 60 ? 0.35 : 1);
  }
  takeForage(i: number, amount: number, day: number): number {
    const avail = this.forageAvailable(i, day);
    const got = Math.min(avail, amount);
    this.forageStock[i] -= got;
    // sustained over-foraging thins the vegetation
    this.veg[i] = Math.max(0, this.veg[i] - got * 0.0006);
    return got;
  }

  /** Called once per season. */
  updateSeason(world: World) {
    const p = this.planet;
    const day = world.day;
    const t = day / DAYS_PER_YEAR;
    const d: [number, number, number] = [0, 0, 0];
    const wx = world.weather;
    const live = wx && wx.seasonDays >= 45;
    if (live) {
      // the season's rain relative to the local climate, from the simulated weather
      this.anomaly.set(wx.seasonEnd());
      if (this.soilDays > 0) for (let i = 0; i < N; i++) this.soilMean[i] = this.soilAcc[i] / this.soilDays;
      floodSeason(world);
      cropSeason(world);
    } else if (wx) wx.resetSeason();
    this.soilAcc.fill(0);
    this.soilDays = 0;
    // weather anomalies on the region grid
    for (let ry = 0; ry < RH; ry++) {
      for (let rx = 0; rx < RW; rx++) {
        const r = ry * RW + rx;
        const lat = cellLat(ry * RF + RF / 2);
        const lon = cellLon(rx * RF + RF / 2);
        dirFromLonLat(lon, lat, d);
        const a = this.noise.fbm(d[0] * 1.4 + t * 0.06, d[1] * 1.4 + 5, d[2] * 1.4 + t * 0.045, 3);
        const osc = 0.22 * Math.sin((2 * Math.PI * t) / 8.7 + lon * 2);
        const m = live ? this.anomaly[r] : clamp(1 + 1.5 * a + osc, 0.12, 1.9);
        this.anomaly[r] = m;
        if (m < 0.55) {
          if (this.droughtSince[r] < 0) this.droughtSince[r] = day;
        } else if (this.droughtSince[r] >= 0) {
          const years = (day - this.droughtSince[r]) / DAYS_PER_YEAR;
          const cx = (r % RW) * RF + RF / 2;
          const cy = Math.floor(r / RW) * RF + RF / 2;
          this.recentDroughts = this.recentDroughts.filter((d) => day - d.day < 6 * DAYS_PER_YEAR);
          if (years >= 1 && world.settlementsNearRegion(r) > 0 && !this.recentDroughts.some((d) => Math.hypot(d.x - cx, d.y - cy) < 30)) {
            this.recentDroughts.push({ x: cx, y: cy, day });
            world.history.record('DISASTER', day, `The Great Drought of ${yearOf(this.droughtSince[r]).toLocaleString('en-US')} ended after ${years.toFixed(0)} years.`, 2, {
              x: (r % RW) * RF + RF / 2, y: Math.floor(r / RW) * RF + RF / 2, cause: 'A persistent negative rainfall anomaly parched the region.',
            });
          }
          this.droughtSince[r] = -1;
        }
      }
    }
    // vegetation toward seasonal capacity; regional temperature summaries
    this.regionTemp.fill(0);
    this.regionTempRange.fill(0);
    const cnt = new Uint16Array(NR);
    const phase = seasonPhase(day + 45);
    for (let r = 0; r < NR; r++) this.rainMod[r] = Math.pow(clamp(this.anomaly[r], 0.1, 1.5), 0.8);
    const dust = world.sky.dust(day);
    for (let i = 0; i < N; i++) {
      if (p.ocean[i]) continue;
      const r = this.cellRegion[i];
      const Ts = p.tempMean[i] + this.seasonK[i] * phase;
      this.seasonT[i] = Ts;
      this.regionTemp[r] += Ts;
      this.regionTempRange[r] += p.tempAmp[i];
      cnt[r]++;
      const tvS = clamp((Ts + 2) / 12) * clamp((38 - Ts) / 12);
      const fertMod = 0.55 + 0.45 * this.fert[i];
      // when the weather is live, last season's soil water stands in for the regional anomaly
      const water = live ? clamp(0.35 + this.soilMean[i] * 1.1, 0.15, 1.3) : this.rainMod[r];
      const snowCover = this.snow[i] > 400 ? 0.15 : this.snow[i] > 60 ? 0.7 : 1;
      let cap = p.baseVeg[i] * Math.min(1.4, tvS / this.tvMean[i]) * water * fertMod * (this.cultivated[i] ? 0.85 : 1) * dust * snowCover * (1 - 0.7 * this.burned[i]);
      cap = cap > 1 ? 1 : cap;
      const v = this.veg[i];
      this.veg[i] = v + (cap - v) * (cap > v ? 0.55 : 0.5);
      this.burned[i] *= 0.82;
      this.frost[i] = 0;
      if (this.fert[i] < p.fertility[i]) this.fert[i] = Math.min(p.fertility[i], this.fert[i] + 0.012);
      // erosion: bare, rain-washed slopes lose their soil
      if (this.veg[i] < 0.22 && p.rain[i] > 0.45 && p.elev[i] > 0.6) this.fert[i] = Math.max(0.02, this.fert[i] - 0.006 * p.rain[i]);
      if (this.cultivated[i] && world.random() < 0.02) this.cultivated[i] = 0;
    }
    for (let r = 0; r < NR; r++) {
      if (cnt[r] > 0) {
        this.regionTemp[r] /= cnt[r];
        this.regionTempRange[r] /= cnt[r];
      }
    }
    this.volcanoes(world);
    quakeSeason(world);
  }

  private volcanoes(world: World) {
    const p = this.planet;
    for (let i = 0; i < N; i++) {
      if (!p.volcanic[i]) continue;
      if (world.random() > 0.00022) continue;
      const x = i % W;
      const y = Math.floor(i / W);
      this.erupt(world, x, y);
    }
  }

  erupt(world: World, x: number, y: number) {
    const rad = 3;
    for (let dy = -rad; dy <= rad; dy++)
      for (let dx = -rad; dx <= rad; dx++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        const xx = (x + dx + W) % W;
        const dist = Math.hypot(dx, dy);
        if (dist > rad) continue;
        const i = idx(xx, yy);
        const s = 1 - dist / (rad + 0.5);
        this.veg[i] *= 1 - 0.85 * s;
        // ash enriches soil over the long run
        this.fert[i] = clamp(this.fert[i] + 0.08 * s);
      }
    const deaths = world.killInRadius(x, y, rad, 0.7, 'a volcanic eruption');
    // a rare great eruption throws enough ash into the stratosphere to cool the whole planet for a few years
    const great = world.random() < 0.07;
    if (great) {
      world.sky.dustUntil = Math.max(world.sky.dustUntil, world.day + 3 * DAYS_PER_YEAR);
      world.sky.dustStrength = Math.max(world.sky.dustStrength, 0.12);
    }
    world.history.record('DISASTER', world.day, `${great ? 'A colossal' : 'A'} volcano erupted${deaths ? `, killing ${deaths}` : ''}${great ? '; its ash dimmed the sun across the world' : ''}.`, deaths || great ? 2 : 1, {
      x, y, cause: 'Magma pressure beneath a volcanic region reached the surface.',
    });
  }
}
