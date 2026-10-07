import { Planet, Biome, BIOME_NAMES } from '../src/sim/planet';
import { N } from '../src/sim/grid';
const t0 = Date.now();
const p = new Planet(12345);
console.log('gen ms', Date.now() - t0, 'land', p.landCells / N);
const c: number[] = new Array(16).fill(0);
for (let i = 0; i < N; i++) c[p.biome[i]]++;
BIOME_NAMES.forEach((n, i) => console.log(n.padEnd(18), ((c[i] / N) * 100).toFixed(1) + '%'));
let riv = 0, lake = 0, vol = 0, cave = 0; for (let i = 0; i < N; i++) { riv += p.river[i]; lake += p.lake[i]; vol += p.volcanic[i]; cave += p.cave[i]; }
console.log({ riv, lake, vol, cave });
