/**
 * Architecture and determinism checks. Run with `npm test`.
 *  1. src/sim must not depend on rendering, UI, DOM or Three.js.
 *  2. The same seed must produce the same planet and the same initial life.
 *  3. A saved world restored twice and stepped identically must stay identical (deterministic replay).
 *  4. A restored world continues exactly like the world it was saved from; old (version 3) saves still load.
 *  5. Research: records stay consistent and finite, failures, deaths and losses replay identically.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { World } from '../src/sim/world';
import { serialize, deserialize } from '../src/sim/persistence';
import { DAYS_PER_YEAR } from '../src/sim/time';
import { TECHS, TECH_IDS } from '../src/sim/technology';
import { attemptChance, forceAttempt, loseTech } from '../src/sim/research';
import { eff, military, oceanGoing } from '../src/sim/techfx';
import type { Settlement } from '../src/sim/settlements';
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


// 6. research records are consistent and finite
{
  let bad6 = '';
  const finite = (o: Record<string, unknown>) => Object.values(o).every((v) => typeof v !== 'number' || Number.isFinite(v));
  for (const st of w.activeSettlements()) {
    for (const t of st.tech) { const tp = st.prog?.[t]; if (!tp || tp.st < 3) bad6 ||= `${st.name}: ${t} usable without a success`; }
    for (const t of TECH_IDS) {
      const tp = st.prog?.[t];
      if (!tp) continue;
      if (tp.st <= 2 && st.tech.has(t)) bad6 ||= `${st.name}: ${t} at stage ${tp.st} but usable`;
      if (!finite(tp as unknown as Record<string, unknown>) || tp.m < 0 || tp.m > 1) bad6 ||= `${st.name}: ${t} has a bad number`;
    }
  }
  for (const L of Object.values(w.research.ledger)) if (L && !finite(L as unknown as Record<string, unknown>)) bad6 ||= 'ledger has a bad number';
  const rnd = walk('src/sim').filter((f) => /Math\.random\s*\(/.test(readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '')));
  if (rnd.length) bad6 ||= 'Math.random in ' + rnd.join(', ');
  ok(!bad6, `research records are consistent and finite${bad6 ? ' — ' + bad6 : ''}`);
}
// 7. research state replays and survives a save
{
  const progOf = (x: World) => JSON.stringify(x.settlements.map((st) => st.prog));
  ok(progOf(w) === progOf(r3) && JSON.stringify(w.research) === JSON.stringify(r3.research), 'research records and the ledger replay identically after a restore');
  const a1 = JSON.parse(snap), a2 = JSON.parse(serialize(deserialize(snap)));
  const pick = (d: any) => JSON.stringify([d.settlements.map((st: any) => st.prog), d.research, d.bands.map((b: any) => b.know)]);
  ok(pick(a1) === pick(a2), 'research state survives a save and load unchanged');
}
// 8. an old (version 3) save still loads, with every known art counted as long practised
{
  const d = JSON.parse(snap);
  d.version = 3;
  for (const st of d.settlements) delete st.prog;
  for (const b of d.bands) delete b.know;
  delete d.research;
  let okLoad = true, msg = '';
  try {
    const old = deserialize(JSON.stringify(d));
    for (const st of old.activeSettlements()) for (const t of st.tech) { const tp = st.prog[t]; if (!tp || tp.st !== 5 || tp.m !== 0.9) { okLoad = false; msg = `${st.name}: ${t}`; } }
    const before = old.history.nextId;
    for (let i = 0; i < 100; i++) old.step(7);
    for (const e of old.history.events) if (e.id >= before && e.type === 'TECHNOLOGY_DISCOVERY' && e.weight >= 3) {
      const t = TECH_IDS.find((id) => e.text.includes(TECHS[id].success));
      if (t && old.research.ledger[t] && old.research.ledger[t]!.first !== -1 && old.research.ledger[t]!.first < before) { okLoad = false; msg = 'a known art was announced as a world first'; }
    }
  } catch (err) { okLoad = false; msg = String(err); }
  ok(okLoad, `a version-3 save loads and continues${msg ? ' — ' + msg : ''}`);
}
// 9. failures with deaths and wrecks, a success and a lost art all replay identically
{
  const run = () => {
    const x = deserialize(snap);
    const big = x.activeSettlements().slice().sort((p, q) => q.pop - p.pop || p.id - q.id)[0] as Settlement;
    forceAttempt(x, big, 'steam', 'bad');
    forceAttempt(x, big, 'seafaring', 'bad');
    forceAttempt(x, big, 'flight', 'bad');
    forceAttempt(x, big, 'metallurgy', 'success');
    const tp = big.prog.metallurgy!;
    tp.m = 0.05;
    loseTech(x, big, 'metallurgy', tp);
    for (let i = 0; i < 100; i++) x.step(7);
    return { x, big };
  };
  const A = run(), B = run();
  const sig = (r: { x: World }) => JSON.stringify([r.x.rng.state, r.x.history.nextId, r.x.alive.length, r.x.settlements.map((st) => st.prog)]);
  ok(sig(A) === sig(B), `forced failures, deaths, a success and a loss replay identically (${A.x.history.counts['EXPERIMENT'] ?? 0} experiment events)`);
}
// 10. the research arithmetic
{
  const t = TECHS.steam;
  let mono = true;
  for (let xp = 0; xp < 10; xp++) if (attemptChance(t, xp + 1, undefined, 1, 1) < attemptChance(t, xp, undefined, 1, 1) || attemptChance(t, xp, undefined, 1, 1) > 0.92) mono = false;
  const fake = (m: Record<string, number>): Settlement => ({ tech: new Set(Object.keys(m)), prog: Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { m: v }])), toolTier: 0 } as unknown as Settlement);
  const mil = military(fake({ gunpowder: 0.85, industry: 0.85 }));
  ok(mono && Math.abs(eff(fake({ steam: 0.85 }), 'steam') - 1) < 1e-9 && Math.abs(eff(fake({ steam: 0.12 }), 'steam') - 0.3559) < 1e-3
    && Math.abs(mil - 1.9 * 1.6) < 1e-9 && !oceanGoing(fake({ seafaring: 0.29 })) && oceanGoing(fake({ seafaring: 0.3 })),
  'attempt odds grow with lessons; effects scale with mastery (full at 85%); the open ocean needs 30% seafaring');
}

process.exit(failed ? 1 : 0);
