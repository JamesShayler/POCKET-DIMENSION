import { World } from '../src/sim/world';
import { DAYS_PER_YEAR } from '../src/sim/time';

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
  if (w.year - last >= 25) {
    last = w.year;
    const sets = w.activeSettlements();
    console.log(`y${w.year} pop ${w.alive.length} settl ${sets.length} civs ${w.livingCivs().length} cultures ${w.cultures.list.length} langs ${w.langs.list.length} techs ${w.techCount()} bands ${w.bands.size} births ${w.stats.births} deaths ${w.stats.deaths} (starved ${w.stats.starved}) ${Date.now()-t1}ms`);
  }
}
console.log('history counts', w.history.counts);
console.log('death causes', w.stats.causes);
console.log(w.activeSettlements().map(s=>`${s.name}(${s.stage},${s.pop},${[...s.tech].join('+')})`).join('  '));
for (const e of w.history.query({ minWeight: 2, limit: 25 }).reverse()) console.log(`Y${Math.floor(e.day/360)} [${e.type}] ${e.text.split('\n')[0]}`);
console.log(w.langs.tree());
