import { World } from '../src/sim/world';
import { serialize, deserialize } from '../src/sim/persistence';
import { DAYS_PER_YEAR } from '../src/sim/time';
(globalThis as any).btoa ??= (s: string) => Buffer.from(s, 'binary').toString('base64');
const w = new World('roundtrip'); w.begin();
while (!w.awakened) w.stepPrehistory(40);
const end = w.day + 120 * DAYS_PER_YEAR; while (w.day < end) w.step(7);
const json = serialize(w);
console.log('save bytes', json.length, 'pop', w.alive.length);
const w2 = deserialize(json);
// advance both identically: deterministic replay from a save
for (let i = 0; i < 400; i++) { w.step(7); w2.step(7); }
console.log('pop', w.alive.length, w2.alive.length, 'day', w.day, w2.day, 'births', w.stats.births, w2.stats.births, 'settl', w.settlements.length, w2.settlements.length);
console.log('MATCH', w.alive.length === w2.alive.length && w.stats.births === w2.stats.births && w.history.nextId === w2.history.nextId);
