import { World } from '../src/sim/world';
import { DAYS_PER_YEAR } from '../src/sim/time';
import { TECHS, TECH_IDS } from '../src/sim/technology';

const seed = process.argv[2] ?? 'pocket';
const preYears = Number(process.argv[3] ?? 3000);
const humanYears = Number(process.argv[4] ?? 300);
const t0 = Date.now();
const w = new World(seed);
console.log('planet ms', Date.now() - t0);
w.begin();
let t1 = Date.now();
let seasons = 0;
while (!w.awakened && seasons < preYears * 4) {
  w.stepPrehistory(40);
  seasons += 40;
  if (seasons % 400 === 0) {
    const t = w.eco.totals();
    console.log(`y${w.year} species ${t.species}/${w.eco.species.length} animals ${t.animals} intelMax ${Math.max(0, ...[...w.eco.pops.values()].filter(p=>w.eco.speciesById(p.sp).diet==='omni').map(p=>p.t.intel)).toFixed(2)} ${(Date.now()-t1)}ms`);
  }
}
console.log('awakened', w.awakened, 'year', w.year, 'prehistory ms', Date.now() - t1);
t1 = Date.now();
const end = w.day + humanYears * DAYS_PER_YEAR;
let last = w.year;
while (w.day < end) {
  w.step(w.alive.length > 1500 ? 30 : 7);
  if (w.year - last >= 50) {
    last = w.year;
    const sets = w.activeSettlements();
    const firsts = TECH_IDS.filter((t) => (w.research.ledger[t]?.first ?? -1) >= 0);
    const programmes = sets.reduce((a, s) => a + TECH_IDS.filter((t) => s.prog?.[t]?.st === 2).length, 0);
    console.log(`y${w.year} pop ${w.alive.length} settl ${sets.length} civs ${w.livingCivs().length} firsts ${firsts.length} [${firsts.slice(-3).join(',')}] programmes ${programmes} ${Date.now()-t1}ms`);
  }
}
console.log('history counts', w.history.counts);
// the research ledger: when each art was first made to work, what it cost, when it was mastered or lost
const Y = DAYS_PER_YEAR;
console.log('\nTECH            first  took  attempts fails lives  mastered  lost');
for (const t of TECH_IDS) {
  const L = w.research.ledger[t];
  if (!L) { console.log(`${TECHS[t].name.padEnd(16)} -`); continue; }
  console.log(`${TECHS[t].name.padEnd(16)}${String(L.first >= 0 ? Math.floor(L.first / Y) : '-').padStart(5)} ${String(L.first >= 0 ? Math.floor(L.took / Y) : '-').padStart(5)} ${String(L.pre[0]).padStart(8)} ${String(L.pre[1]).padStart(5)} ${String(L.pre[2]).padStart(5)} ${String(L.mastered >= 0 ? Math.floor(L.mastered / Y) : '-').padStart(9)} ${L.lost >= 0 ? Math.floor(L.lost / Y) : '-'}`);
}
for (const f of ['satellite', 'orbit', 'moon'] as const) { const L = w.research.ledger[f]; console.log(`${f}: ${L ? `${L.first >= 0 ? Math.floor(L.first / Y) : 'not yet'} (failures ${L.f}, lives ${L.k})` : 'not attempted'}`); }
const byCentury = new Map<number, [number, number]>();
for (const e of w.history.events) if (e.weight >= 2) { const c = Math.floor(e.day / Y / 100); const v = byCentury.get(c) ?? [0, 0]; v[e.weight >= 3 ? 1 : 0]++; byCentury.set(c, v); }
console.log('major events per century (w2/w3):', [...byCentury.entries()].sort((a, b) => a[0] - b[0]).map(([c, [a, b]]) => `${c * 100}s:${a}/${b}`).join(' '));
console.log('death causes', w.stats.causes);
console.log(w.activeSettlements().map(s=>`${s.name}(${s.stage},${s.pop},${[...s.tech].join('+')})`).join('  '));
for (const e of w.history.query({ minWeight: 2, limit: 25 }).reverse()) console.log(`Y${Math.floor(e.day/360)} [${e.type}] ${e.text.split('\n')[0]}`);
console.log(w.langs.tree());
