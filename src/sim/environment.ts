import type { World } from './world';
import { Planet } from './planet';
import { Noise3 } from './noise';
import { Rng, clamp } from './rng';
import { N, NR, RW, RH, RF, W, H, idx, cellLat, cellLon, dirFromLonLat, NBR8, regionOfCell } from './grid';
import { DAYS_PER_YEAR, seasonPhase, yearOf } from './time';

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
        if (!planet.ocean[i]) this.regionLand[this.cellRegion[i]]++;
      }
    }
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
    return 14 * v * (0.25 + 0.75 * this.fert[i]) * nearWater * coast;
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
    // weather anomalies on the region grid
    for (let ry = 0; ry < RH; ry++) {
      for (let rx = 0; rx < RW; rx++) {
        const r = ry * RW + rx;
        const lat = cellLat(ry * RF + RF / 2);
        const lon = cellLon(rx * RF + RF / 2);
        dirFromLonLat(lon, lat, d);
        const a = this.noise.fbm(d[0] * 1.4 + t * 0.06, d[1] * 1.4 + 5, d[2] * 1.4 + t * 0.045, 3);
        const osc = 0.22 * Math.sin((2 * Math.PI * t) / 8.7 + lon * 2);
        const m = clamp(1 + 1.5 * a + osc, 0.12, 1.9);
        this.anomaly[r] = m;
        if (m < 0.55) {
          if (this.droughtSince[r] < 0) this.droughtSince[r] = day;
        } else if (this.droughtSince[r] >= 0) {
          const years = (day - this.droughtSince[r]) / DAYS_PER_YEAR;
          const cx = (r % RW) * RF + RF / 2;
          const cy = Math.floor(r / RW) * RF + RF / 2;
          this.recentDroughts = this.recentDroughts.filter((d) => day - d.day < 6 * DAYS_PER_YEAR);
          if (years >= 2 && world.settlementsNearRegion(r) > 0 && !this.recentDroughts.some((d) => Math.hypot(d.x - cx, d.y - cy) < 30)) {
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
      let cap = p.baseVeg[i] * Math.min(1.4, tvS / this.tvMean[i]) * this.rainMod[r] * fertMod * (this.cultivated[i] ? 0.85 : 1) * dust;
      cap = cap > 1 ? 1 : cap;
      const v = this.veg[i];
      this.veg[i] = v + (cap - v) * (cap > v ? 0.55 : 0.5);
      if (this.fert[i] < p.fertility[i]) this.fert[i] = Math.min(p.fertility[i], this.fert[i] + 0.012);
      if (this.cultivated[i] && world.random() < 0.02) this.cultivated[i] = 0;
    }
    for (let r = 0; r < NR; r++) {
      if (cnt[r] > 0) {
        this.regionTemp[r] /= cnt[r];
        this.regionTempRange[r] /= cnt[r];
      }
    }
    this.volcanoes(world);
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
    world.history.record('DISASTER', world.day, `A volcano erupted${deaths ? `, killing ${deaths}` : ''}.`, deaths ? 2 : 1, {
      x, y, cause: 'Magma pressure beneath a volcanic region reached the surface.',
    });
  }
}
