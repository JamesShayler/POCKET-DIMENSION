import { Planet } from './sim/planet';
import { Resources } from './sim/resources';
import { Ecology } from './sim/ecology';
import { Sky } from './sim/sky';
import { Space } from './sim/space';
import { Rng } from './sim/rng';
import type { World } from './sim/world';
import { SPEEDS } from './engine';
import type {
  AnimalPop, BuildingBlock, EnvBlock, EventLite, FollowTarget, FromWorker, MarineLite, PanelKind, PeopleBlock, SettlementLite, SkyBlock, Snapshot, StaticInfo, ToWorker, WeatherBlock,
} from './shared/protocol';

/**
 * The main thread's window onto the universe. The simulation runs in a worker; this keeps the latest read-only snapshot of
 * what is near the observer, plus seed-derived things the renderer can rebuild locally and identically (the planet, its
 * resource sites, the solar system), and asks the worker for panel text.
 */
export class SimClient {
  readonly worker: Worker;
  info!: StaticInfo;
  planet!: Planet;
  /** seed-derived helpers rebuilt locally: identical to the worker's because they depend only on the seed */
  res!: Resources;
  eco!: Ecology;
  sky!: Sky;
  space!: Space;
  snap: Snapshot | null = null;
  people: PeopleBlock = { n: 0, id: new Int32Array(0), x: new Float32Array(0), y: new Float32Array(0), px: new Float32Array(0), py: new Float32Array(0), attr: new Uint32Array(0) };
  settlements: SettlementLite[] = [];
  settlementById = new Map<number, SettlementLite>();
  buildings: BuildingBlock | null = null;
  nodeFrac = new Map<number, number>();
  known = new Set<number>();
  animals: AnimalPop[] = [];
  env: EnvBlock | null = null;
  weather: WeatherBlock | null = null;
  skyState: SkyBlock = { storms: [], fires: [], quakes: [], satellites: [], missions: [], routes: [] };
  flora: { hue: Float32Array; height: Float32Array } | null = null;
  marine: MarineLite | null = null;
  /** bumped when a block changes, so consumers rebuild only then */
  versions = { settlements: 0, buildings: 0, nodes: 0, env: 0, weather: 0, sky: 0, animals: 0 };
  /** when the simulation's current tick started arriving (for smooth motion between ticks) */
  private tickDay = -1;
  private tickTime = 0;
  private reqId = 1;
  private waiting = new Map<number, (v: unknown) => void>();
  onEvent: ((e: EventLite) => void)[] = [];
  onProgress: ((msg: string, sub?: string) => void) | null = null;
  onToast: ((msg: string) => void) | null = null;
  onError: ((msg: string) => void) | null = null;

  constructor() {
    this.worker = new Worker(new URL('./worker/sim.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<FromWorker>) => this.receive(ev.data);
    this.worker.onerror = (ev) => this.onError?.(String(ev.message ?? ev));
  }

  send(m: ToWorker) {
    this.worker.postMessage(m);
  }

  start(opts: { seed?: string; resume?: boolean }): Promise<{ resumed: boolean; awakeningText?: string; firstSettlement?: { x: number; y: number } }> {
    return new Promise((resolve) => {
      this.readyCb = resolve;
      this.send({ t: 'init', seed: opts.seed, resume: opts.resume });
    });
  }
  private readyCb: ((v: { resumed: boolean; awakeningText?: string; firstSettlement?: { x: number; y: number } }) => void) | null = null;

  private receive(m: FromWorker) {
    switch (m.t) {
      case 'progress': this.onProgress?.(m.msg, m.sub); return;
      case 'ready': {
        this.info = m.info;
        this.planet = new Planet(m.info.planet.seed, m.info.planet);
        const fake = { planet: this.planet, seed: m.info.seed } as unknown as World;
        this.res = new Resources(fake);
        this.eco = new Ecology(fake, new Rng(1));
        this.sky = new Sky(fake);
        this.space = new Space(fake);
        this.readyCb?.({ resumed: m.resumed, awakeningText: m.awakeningText, firstSettlement: m.firstSettlement });
        return;
      }
      case 'snap': this.applySnap(m); return;
      case 'html': case 'event': case 'exists': { const cb = this.waiting.get(m.req); if (cb) { this.waiting.delete(m.req); cb(m); } return; }
      case 'toast': this.onToast?.(m.msg); return;
      case 'export': {
        const blob = new Blob([m.json], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = m.name;
        a.click();
        return;
      }
      case 'error': console.error('[sim]', m.msg); this.onError?.(m.msg); return;
    }
  }

  private applySnap(s: Snapshot) {
    const now = performance.now();
    if (s.day !== this.tickDay) { this.tickDay = s.day; this.tickTime = now; }
    this.snap = s;
    this.people = s.people;
    if (s.settlements) {
      this.settlements = s.settlements;
      this.settlementById = new Map(s.settlements.map((x) => [x.id, x]));
      this.versions.settlements++;
    }
    if (s.buildings) { this.buildings = s.buildings; this.versions.buildings++; }
    if (s.nodeKeys && s.nodeFrac) {
      this.nodeFrac = new Map();
      for (let i = 0; i < s.nodeKeys.length; i++) this.nodeFrac.set(s.nodeKeys[i], s.nodeFrac[i]);
      this.known = new Set(s.knownKeys ?? []);
      this.versions.nodes++;
    }
    if (s.animals) { this.animals = s.animals; this.versions.animals++; }
    if (s.env) { this.env = s.env; this.versions.env++; }
    if (s.flora) this.flora = s.flora;
    if (s.marine) this.marine = s.marine;
    if (s.weather) { this.weather = s.weather; this.versions.weather++; }
    if (s.sky) { this.skyState = s.sky; this.versions.sky++; }
    for (const e of s.events) for (const f of this.onEvent) f(e);
  }

  get day() { return this.snap?.day ?? 0; }
  get daysPerSec() { return SPEEDS[this.snap?.speedIdx ?? 1]; }
  get paused() { return (this.snap?.speedIdx ?? 1) === 0; }
  /** 0..1 progress through the current simulation tick (motion is interpolated, never extrapolated) */
  alpha(now = performance.now()): number {
    const s = this.snap;
    if (!s || s.speedIdx === 0 || s.jumping) return 1;
    const t = ((now - this.tickTime) / 1000) * SPEEDS[s.speedIdx];
    return Math.max(0, Math.min(1, t / Math.max(1e-9, s.step)));
  }
  /** the smoothly advancing day the picture shows (one tick behind the simulation) */
  renderDay(now = performance.now()): number {
    const s = this.snap;
    if (!s) return 0;
    if (s.speedIdx === 0 || s.jumping) return s.day;
    return s.day - s.step + this.alpha(now) * s.step;
  }

  private ask<T>(m: ToWorker & { req: number }): Promise<T> {
    return new Promise((resolve) => {
      this.waiting.set(m.req, resolve as (v: unknown) => void);
      this.send(m);
    });
  }
  panel(kind: PanelKind, id: number, extra: number | undefined, following: boolean, family: boolean): Promise<string> {
    return this.ask<{ html: string }>({ t: 'panel', req: this.reqId++, kind, id, extra, following, family }).then((r) => r.html);
  }
  almanac(tab: string, filters: string[]): Promise<string> {
    return this.ask<{ html: string }>({ t: 'almanac', req: this.reqId++, tab, filters }).then((r) => r.html);
  }
  dev(fps: number): Promise<string> {
    return this.ask<{ html: string }>({ t: 'dev', req: this.reqId++, fps }).then((r) => r.html);
  }
  event(id: number): Promise<{ e: EventLite | null; personAlive?: boolean }> {
    return this.ask({ t: 'event', req: this.reqId++, id });
  }
  personExists(id: number): Promise<boolean> {
    return this.ask<{ ok: boolean }>({ t: 'personExists', req: this.reqId++, id }).then((r) => r.ok);
  }
  setSpeed(i: number) { this.send({ t: 'speed', i }); if (this.snap) this.snap.speedIdx = i; }
  jump(years: number, label: string) { this.send({ t: 'jump', years, label }); }
  cancelJump() { this.send({ t: 'cancelJump' }); }
  camera(x: number, y: number, km: number, alt: number) { this.send({ t: 'camera', x, y, km, alt }); }
  follow(target: FollowTarget, family: boolean) { this.send({ t: 'follow', target, family }); }
  save() { this.send({ t: 'save' }); }
  exportSave() { this.send({ t: 'export' }); }
  replay() { this.send({ t: 'replay' }); }
}
