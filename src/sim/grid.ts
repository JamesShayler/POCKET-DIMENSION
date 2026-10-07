/** Spherical (equirectangular) simulation grid and coordinate helpers. Pure data, no rendering. */

export const W = 256;
export const H = 128;
export const N = W * H;
export const RF = 4; // cells per region edge
export const RW = W / RF;
export const RH = H / RF;
export const NR = RW * RH;
export const R_KM = 1000; // pocket planet radius
export const KM_PER_CELL_Y = (Math.PI * R_KM) / H;

export const idx = (x: number, y: number) => y * W + x;
export const wrapX = (x: number) => ((x % W) + W) % W;
export const cellLon = (x: number) => ((x + 0.5) / W) * Math.PI * 2 - Math.PI;
export const cellLat = (y: number) => Math.PI / 2 - ((y + 0.5) / H) * Math.PI;
export const kmPerCellX = (y: number) => Math.max(1, ((2 * Math.PI * R_KM) / W) * Math.cos(cellLat(Math.floor(y))));
export const regionOfCell = (x: number, y: number) => Math.floor(y / RF) * RW + Math.floor(x / RF);
export const regionX = (r: number) => r % RW;
export const regionY = (r: number) => Math.floor(r / RW);

/** Unit direction (y up) for continuous lon/lat in radians. */
export function dirFromLonLat(lon: number, lat: number, out: [number, number, number] = [0, 0, 0]) {
  const c = Math.cos(lat);
  out[0] = c * Math.cos(lon);
  out[1] = Math.sin(lat);
  out[2] = c * Math.sin(lon);
  return out;
}
/** Continuous cell coords -> lon/lat. */
export const lonOfX = (x: number) => (x / W) * Math.PI * 2 - Math.PI;
export const latOfY = (y: number) => Math.PI / 2 - (y / H) * Math.PI;

/** 8-neighbour table; -1 where off-grid (poles). */
export const NBR8 = new Int32Array(N * 8).fill(-1);
export const NBR_DX = [-1, 0, 1, -1, 1, -1, 0, 1];
export const NBR_DY = [-1, -1, -1, 0, 0, 1, 1, 1];
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    for (let k = 0; k < 8; k++) {
      const ny = y + NBR_DY[k];
      if (ny < 0 || ny >= H) continue;
      NBR8[idx(x, y) * 8 + k] = idx(wrapX(x + NBR_DX[k]), ny);
    }
  }
}

/** Great-ish-circle distance in km between two continuous cell positions (equirectangular approximation). */
export function distKm(ax: number, ay: number, bx: number, by: number): number {
  let dx = Math.abs(ax - bx);
  if (dx > W / 2) dx = W - dx;
  const my = (ay + by) / 2;
  const kx = ((2 * Math.PI * R_KM) / W) * Math.cos(latOfY(my));
  const dkx = dx * kx;
  const dky = (ay - by) * KM_PER_CELL_Y;
  return Math.sqrt(dkx * dkx + dky * dky);
}
/** Signed shortest dx in cells (wrapping). */
export function wrapDx(ax: number, bx: number): number {
  let dx = bx - ax;
  if (dx > W / 2) dx -= W;
  if (dx < -W / 2) dx += W;
  return dx;
}
