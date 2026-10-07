// Writes an equirectangular PNG of a seed's planet (elevation + biomes) for quick visual checks of terrain generation.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { Planet } from '../src/sim/planet';
import { dirFromLonLat } from '../src/sim/grid';

function png(w: number, h: number, rgb: Uint8Array): Buffer {
  const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = (b: Buffer) => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (t: string, d: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb.subarray(y * w * 3, (y + 1) * w * 3).forEach((v, i) => (raw[y * (w * 3 + 1) + 1 + i] = v)); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const seed = process.argv[2] ?? 'pocket';
const W = Number(process.argv[3] ?? 1024), H = W / 2;
const t0 = Date.now();
const { seedFromText } = await import('../src/sim/world');
const p = new Planet(seedFromText(seed));
console.log('planet ms', Date.now() - t0, 'land', (p.landCells / 32768).toFixed(3));
const rgb = new Uint8Array(W * H * 3);
const d: [number, number, number] = [0, 0, 0];
let maxE = -99, minE = 99;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const lon = (x / W) * Math.PI * 2 - Math.PI, lat = Math.PI / 2 - (y / H) * Math.PI;
  dirFromLonLat(lon, lat, d);
  const e = p.terrain.elevKm(d[0], d[1], d[2]);
  maxE = Math.max(maxE, e); minE = Math.min(minE, e);
  const cell = Math.floor((y / H) * 128) * 256 + Math.floor((x / W) * 256);
  let r: number, g: number, b: number;
  if (e < 0) { const t = Math.min(1, -e / 6); r = 20 * (1 - t) + 5; g = 90 * (1 - t) + 20; b = 160 * (1 - t) + 60; }
  else {
    const T = p.tempMean[cell] - 6.5 * e + 6.5 * Math.max(0, p.elev[cell]);
    const wet = Math.min(1, p.rain[cell]);
    if (T < -8) { r = g = b = 235; }
    else { r = 190 - 120 * wet; g = 170 - 40 * wet; b = 110 - 60 * wet; }
    const sh = Math.min(1, e / 5); r = r * (1 - sh) + 200 * sh; g = g * (1 - sh) + 190 * sh; b = b * (1 - sh) + 180 * sh;
    if (p.river[cell] && (x + y) % 2 === 0) { r = 60; g = 110; b = 200; }
    if (p.volcanic[cell]) { r = 200; g = 40; b = 30; }
  }
  rgb.set([r, g, b], (y * W + x) * 3);
}
writeFileSync(`/tmp/claude-0/maps/${seed}.png`, png(W, H, rgb));
console.log('elev range', minE.toFixed(2), maxE.toFixed(2), 'plates', p.terrain.plates.length);
