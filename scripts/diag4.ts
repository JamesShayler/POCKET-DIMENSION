import { World } from '../src/sim/world';
import { DAYS_PER_YEAR } from '../src/sim/time';
const w = new World('pocket'); w.begin();
while (!w.awakened) w.stepPrehistory(40);
const tally: Record<string, number> = {};
const orig = w.die.bind(w);
w.die = (p, cause) => {
  if (cause === 'starvation') {
    const s = p.home ? w.settlements[p.home-1] : undefined;
    const sAge = s ? (w.day - s.founded)/360 : -1;
    const k = `${p.band?('band:'+w.bands.get(p.band)?.kind):'-'}|${p.ageYears(w.day)<12?'child':'adult'}|${s? (sAge<5?'new<5y':sAge<20?'young<20y':'old'):'nohome'}|${s?s.stage:''}|foodstock${s? (s.food/Math.max(1,s.pop)>5?'ok':'low'):''}`;
    tally[k]=(tally[k]||0)+1;
  }
  orig(p, cause);
};
const end = w.day + 300*DAYS_PER_YEAR;
while (w.day < end) w.step(w.alive.length>1500?30:7);
console.log(Object.entries(tally).sort((a,b)=>b[1]-a[1]).slice(0,14).map(([k,v])=>v+' '+k).join('\n'));
