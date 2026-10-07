/**
 * Architecture and determinism checks. Run with `npm test`.
 *  1. src/sim must not depend on rendering, UI, DOM or Three.js.
 *  2. The same seed must produce the same planet and the same initial life.
 *  3. A saved world restored twice and stepped identically must stay identical (deterministic replay).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { World } from '../src/sim/world';
import { serialize, deserialize } from '../src/sim/persistence';
import { DAYS_PER_YEAR } from '../src/sim/time';
(globalThis as any).btoa ??= (s: string) => Buffer.from(s, 'binary').toString('base64');
(globalThis as any).atob ??= (s: string) => Buffer.from(s, 'base64').toString('binary');

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failed++;
};

// 1. layering
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const bad: string[] = [];
for (const f of walk('src/sim')) {
  const src = readFileSync(f, 'utf8');
  if (/from\s+['"](three|\.\.\/render|\.\.\/ui|\.\.\/engine|\.\.\/main)/.test(src) || /\b(document|window|requestAnimationFrame)\b/.test(src.replace(/\/\/.*$/gm, ''))) bad.push(f);
}
ok(bad.length === 0, `src/sim is independent of rendering, UI and the DOM${bad.length ? ' — violations: ' + bad.join(', ') : ''}`);

// 2. seed determinism
const hash = (a: ArrayLike<number>) => { let h = 2166136261 >>> 0; for (let i = 0; i < a.length; i += 7) h = Math.imul(h ^ (a[i] * 1000 | 0), 16777619) >>> 0; return h; };
const a = new World('check-seed'); a.begin();
const b = new World('check-seed'); b.begin();
const c = new World('another-seed'); c.begin();
ok(hash(a.planet.elev) === hash(b.planet.elev) && hash(a.planet.rain) === hash(b.planet.rain), 'same seed → identical planet (terrain, climate)');
ok(hash(a.planet.elev) !== hash(c.planet.elev), 'different seed → different planet');
for (let i = 0; i < 400; i++) { a.stepPrehistory(1); b.stepPrehistory(1); }
ok(a.eco.pops.size === b.eco.pops.size && a.eco.species.length === b.eco.species.length && a.eco.rng.state === b.eco.rng.state, 'same seed → identical ecological history');

// 3. replay from a save
const w = new World('pocket'); w.begin();
let n = 0; while (!w.awakened && n++ < 120) w.stepPrehistory(40);
ok(w.awakened, `a lineage awoke on its own (year ${w.year})`);
const end = w.day + 60 * DAYS_PER_YEAR; while (w.day < end) w.step(7);
const snap = serialize(w);
const r1 = deserialize(snap), r2 = deserialize(snap);
for (let i = 0; i < 300; i++) { r1.step(7); r2.step(7); }
ok(r1.alive.length === r2.alive.length && r1.stats.births === r2.stats.births && r1.rng.state === r2.rng.state && r1.history.nextId === r2.history.nextId, `deterministic replay from a save (pop ${r1.alive.length})`);
ok(w.alive.length > 0 && w.activeSettlements().length > 0, 'people and settlements exist after the awakening');
// 4. a restored world continues exactly like the world it was saved from (no hidden runtime state)
const r3 = deserialize(snap);
for (let i = 0; i < 300; i++) { w.step(7); r3.step(7); }
ok(w.alive.length === r3.alive.length && w.stats.births === r3.stats.births && w.rng.state === r3.rng.state && w.history.nextId === r3.history.nextId, `a restored save continues identically to the original (pop ${w.alive.length})`);
// 5. weather and the land surface stay physical
let wet = 0, nl = 0;
for (let i = 0; i < w.env.soil.length; i++) if (!w.planet.ocean[i]) { nl++; if (w.env.soil[i] >= 0 && w.env.soil[i] <= 1) wet++; }
ok(wet === nl && w.weather.seasonsObserved > 0, `weather has run (${w.weather.seasonsObserved} seasons) and soil moisture stays within field capacity`);

process.exit(failed ? 1 : 0);
