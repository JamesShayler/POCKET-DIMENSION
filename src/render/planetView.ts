import * as THREE from 'three';
import type { World } from '../sim/world';
import { H, N, R_KM, W, cellLat, cellLon, dirFromLonLat, idx, wrapX } from '../sim/grid';
import { clamp } from '../sim/rng';
import { OCEAN_DEEP, RGB, URBAN, ICE, landColor, mixc, oceanColor, seaIce } from './colors';
import { atmosphereMaterial, cloudMaterial, planetMaterial } from './materials';

/** Height exaggeration: scene units per km of relief. The world is "pocket" sized, so relief is stretched to read at planetary scale. */
export const HS = 5;
export const NX = 512;
export const NY = 256;

export const surfaceRadius = (elevKm: number) => R_KM + Math.max(0, elevKm) * HS;
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

export class PlanetView {
  mesh!: THREE.Mesh;
  clouds!: THREE.Mesh;
  atmosphere!: THREE.Mesh;
  material = planetMaterial();
  humidTex: THREE.DataTexture;
  private cloudMat!: THREE.ShaderMaterial;
  private elevV = new Float32Array((NX + 1) * (NY + 1));
  private x0 = new Int32Array((NX + 1) * (NY + 1));
  private y0 = new Int32Array((NX + 1) * (NY + 1));
  private fx = new Float32Array((NX + 1) * (NY + 1));
  private fy = new Float32Array((NX + 1) * (NY + 1));
  private colorAttr!: THREE.BufferAttribute;
  private auxAttr!: THREE.BufferAttribute;
  politics = false;
  private cellC = new Float32Array(N * 3);
  private cellOv = new Float32Array(N * 4);
  private cellLight = new Float32Array(N);
  private cellIce = new Float32Array(N);
  private humidData = new Uint8Array(128 * 64);

  constructor(private world: World, private scene: THREE.Scene) {
    this.humidTex = new THREE.DataTexture(this.humidData, 128, 64, THREE.RedFormat, THREE.UnsignedByteType);
    this.humidTex.magFilter = THREE.LinearFilter;
    this.humidTex.minFilter = THREE.LinearFilter;
    this.humidTex.wrapS = THREE.RepeatWrapping;
    this.humidTex.needsUpdate = true;
  }

  /** Build geometry in slices so the loading screen stays alive. */
  async build(onProgress?: (f: number) => void) {
    const w = this.world;
    const vw = NX + 1;
    const pos = new Float32Array(vw * (NY + 1) * 3);
    const d: [number, number, number] = [0, 0, 0];
    for (let iv = 0; iv <= NY; iv++) {
      const lat = Math.PI / 2 - (iv / NY) * Math.PI;
      for (let iu = 0; iu <= NX; iu++) {
        const lon = -Math.PI + (iu / NX) * Math.PI * 2;
        dirFromLonLat(lon, lat, d);
        const v = iv * vw + iu;
        const cx = ((lon + Math.PI) / (Math.PI * 2)) * W - 0.5;
        const cy = ((Math.PI / 2 - lat) / Math.PI) * H - 0.5;
        const x0 = Math.floor(cx);
        const y0 = Math.floor(cy);
        const fx = cx - x0;
        const fy = cy - y0;
        const xa = ((x0 % W) + W) % W, xb = (xa + 1) % W;
        const ya = Math.min(H - 1, Math.max(0, y0)), yb = Math.min(H - 1, Math.max(0, y0 + 1));
        const el = w.planet.elev;
        // the ground follows the simulation grid (so coasts, rivers and settlements agree with what the people experience), plus fine relief
        let e = (el[ya * W + xa] * (1 - fx) + el[ya * W + xb] * fx) * (1 - fy) + (el[yb * W + xa] * (1 - fx) + el[yb * W + xb] * fx) * fy;
        if (e > 0.05) e += w.planet.terrain.noise.fbm(d[0] * 22, d[1] * 22, d[2] * 22, 3) * 0.28 * Math.min(1, e * 2.5);
        this.elevV[v] = e;
        const r = surfaceRadius(e);
        pos[v * 3] = d[0] * r;
        pos[v * 3 + 1] = d[1] * r;
        pos[v * 3 + 2] = d[2] * r;
        // colours sample the simulation through a gently domain-warped lookup, so biome edges wander instead of following the grid
        const nz = w.planet.terrain.noise;
        const wcx = cx + nz.fbm(d[0] * 9 + 3, d[1] * 9, d[2] * 9, 2) * 1.1;
        const wcy = cy + nz.fbm(d[0] * 9, d[1] * 9 + 7, d[2] * 9, 2) * 1.1;
        const wx0 = Math.floor(wcx);
        const wy0 = Math.floor(wcy);
        this.x0[v] = ((wx0 % W) + W) % W;
        this.y0[v] = wy0;
        this.fx[v] = wcx - wx0;
        this.fy[v] = wcy - wy0;
      }
      if (iv % 32 === 0) {
        onProgress?.(iv / NY);
        await nextFrame();
      }
    }
    const indices = new Uint32Array(NX * NY * 6);
    let k = 0;
    for (let iv = 0; iv < NY; iv++)
      for (let iu = 0; iu < NX; iu++) {
        const a = iv * vw + iu;
        const b = a + 1;
        const c = a + vw;
        const e = c + 1;
        indices[k++] = a; indices[k++] = b; indices[k++] = c;
        indices[k++] = b; indices[k++] = e; indices[k++] = c;
      }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.computeVertexNormals();
    this.colorAttr = new THREE.BufferAttribute(new Float32Array(vw * (NY + 1) * 3), 3);
    this.auxAttr = new THREE.BufferAttribute(new Float32Array(vw * (NY + 1) * 4), 4);
    this.colorAttr.setUsage(THREE.DynamicDrawUsage);
    this.auxAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('color', this.colorAttr);
    geo.setAttribute('aux', this.auxAttr);
    geo.computeBoundingSphere();
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);

    this.cloudMat = cloudMaterial(this.humidTex);
    this.clouds = new THREE.Mesh(new THREE.SphereGeometry(R_KM + 55, 160, 96), this.cloudMat);
    this.clouds.renderOrder = 2;
    this.scene.add(this.clouds);
    this.atmosphere = new THREE.Mesh(new THREE.SphereGeometry(R_KM * 1.06, 96, 64), atmosphereMaterial());
    this.atmosphere.renderOrder = 3;
    this.scene.add(this.atmosphere);
    this.updateColors();
    this.updateClouds();
  }

  setLighting(sun: THREE.Vector3, cam: THREE.Vector3, alt: number, time: number) {
    this.material.uniforms.uSun.value.copy(sun);
    this.material.uniforms.uCam.value.copy(cam);
    this.material.uniforms.uAlt.value = alt;
    this.material.uniforms.uTime.value = time;
    this.cloudMat.uniforms.uSun.value.copy(sun);
    this.cloudMat.uniforms.uTime.value = time;
    const am = this.atmosphere.material as THREE.ShaderMaterial;
    am.uniforms.uSun.value.copy(sun);
    am.uniforms.uCam.value.copy(cam);
  }

  updateClouds() {
    const w = this.world;
    for (let ty = 0; ty < 64; ty++) {
      for (let tx = 0; tx < 128; tx++) {
        const cx = Math.floor((tx / 128) * W);
        const cy = Math.floor((ty / 64) * H);
        const i = idx(cx, cy);
        const lat = Math.abs(cellLat(cy));
        const itcz = 0.45 * Math.exp(-Math.pow(lat / 0.17, 2));
        const storm = 0.25 * Math.exp(-Math.pow((lat - 0.95) / 0.22, 2));
        const r = w.planet.ocean[i] ? 0.35 + 0.1 * Math.sin(cx * 0.3) : w.env.rainAt(i) * 0.5;
        const a = w.env.anomaly[Math.floor(cy / 4) * 64 + Math.floor(cx / 4)];
        const cover = clamp(0.02 + 0.35 * w.planet.humidity[i] + 0.2 * r + itcz * 0.6 + storm * 0.6) * (0.6 + 0.45 * a);
        this.humidData[ty * 128 + tx] = Math.round(clamp(cover) * 255);
      }
    }
    this.humidTex.needsUpdate = true;
  }

  /** Re-colour from the live state of the world: vegetation, snow, fields, cities, borders. */
  updateColors() {
    const w = this.world;
    const p = w.planet;
    const cc = this.cellC;
    for (let i = 0; i < N; i++) {
      if (p.ocean[i]) { this.cellIce[i] = seaIce(w, i); continue; }
      const c = landColor(w, i);
      cc[i * 3] = c[0]; cc[i * 3 + 1] = c[1]; cc[i * 3 + 2] = c[2];
    }
    this.cellLight.fill(0);
    this.cellOv.fill(0);
    for (const s of w.activeSettlements()) {
      const cx = Math.floor(s.x);
      const cy = Math.floor(s.y);
      const rUrb = 0.5 + Math.sqrt(s.pop) / 14;
      const rLight = 1.0 + Math.sqrt(s.pop) / 8;
      const ri = Math.ceil(Math.max(rUrb, rLight)) + 1;
      const cul = w.cultures.get(s.culture);
      const hue = cul ? cul.color : 0;
      const ov = hsl(hue);
      const civ = w.civs[s.civ - 1];
      const rPol = 3 + Math.sqrt(s.pop) * 0.55 + (civ && civ.capital === s.id ? 2 : 0);
      const rr = this.politics ? Math.ceil(rPol) : ri;
      for (let dy = -rr; dy <= rr; dy++) for (let dx = -rr; dx <= rr; dx++) {
        const y = cy + dy;
        if (y < 0 || y >= H) continue;
        const i = idx(wrapX(cx + dx), y);
        const d = Math.hypot(dx + 0.0, dy + 0.0);
        if (this.politics && !p.ocean[i] && d < rPol) {
          const a = 0.2 * (1 - d / rPol) + (d > rPol - 1 ? 0.14 : 0);
          if (a > this.cellOv[i * 4 + 3]) { this.cellOv[i * 4] = ov[0]; this.cellOv[i * 4 + 1] = ov[1]; this.cellOv[i * 4 + 2] = ov[2]; this.cellOv[i * 4 + 3] = a; }
        }
        if (p.ocean[i]) continue;
        if (d < rLight) this.cellLight[i] = Math.max(this.cellLight[i], clamp(0.25 + s.pop / 500) * (1 - d / (rLight + 0.5)));
        if (d < rUrb && s.pop >= 25) {
          const t = clamp(0.5 * (1 - d / rUrb) * Math.min(1, s.pop / 120));
          cc[i * 3] += (URBAN[0] - cc[i * 3]) * t;
          cc[i * 3 + 1] += (URBAN[1] - cc[i * 3 + 1]) * t;
          cc[i * 3 + 2] += (URBAN[2] - cc[i * 3 + 2]) * t;
        }
      }
    }
    const col = this.colorAttr.array as Float32Array;
    const aux = this.auxAttr.array as Float32Array;
    const total = (NX + 1) * (NY + 1);
    for (let v = 0; v < total; v++) {
      const e = this.elevV[v];
      const x0 = this.x0[v];
      const y0 = this.y0[v];
      const x1 = (x0 + 1) % W;
      const ya = clamp(y0, 0, H - 1);
      const yb = clamp(y0 + 1, 0, H - 1);
      const fx = this.fx[v];
      const fy = this.fy[v];
      const ia = idx(x0, ya), ib = idx(x1, ya), ic = idx(x0, yb), id = idx(x1, yb);
      const wa = (1 - fx) * (1 - fy), wb = fx * (1 - fy), wc = (1 - fx) * fy, wd = fx * fy;
      // lights & overlay use all four cells
      const light = this.cellLight[ia] * wa + this.cellLight[ib] * wb + this.cellLight[ic] * wc + this.cellLight[id] * wd;
      let r: number, g: number, b: number, water = 0;
      if (e <= 0) {
        const c = oceanColor(e);
        const ice = this.cellIce[ia] * wa + this.cellIce[ib] * wb + this.cellIce[ic] * wc + this.cellIce[id] * wd;
        r = c[0]; g = c[1]; b = c[2];
        if (ice > 0.02) { const t = clamp(ice * 1.4); r += (ICE[0] - r) * t; g += (ICE[1] - g) * t; b += (ICE[2] - b) * t; water = 1 - t * 0.85; } else water = 1;
      } else {
        let sw = 0; r = g = b = 0; let lake = 0;
        const cells = [ia, ib, ic, id];
        const ws = [wa, wb, wc, wd];
        for (let k = 0; k < 4; k++) {
          const i = cells[k];
          if (p.ocean[i]) continue;
          sw += ws[k];
          r += cc[i * 3] * ws[k]; g += cc[i * 3 + 1] * ws[k]; b += cc[i * 3 + 2] * ws[k];
          if (p.lake[i]) lake += ws[k];
        }
        if (sw < 1e-4) { const c = oceanColor(-0.1); r = c[0]; g = c[1]; b = c[2]; } else { r /= sw; g /= sw; b /= sw; water = lake / sw > 0.5 ? 1 : 0; }
        void OCEAN_DEEP;
      }
      if (this.politics && e > 0) {
        const oa = this.cellOv[ia * 4 + 3] * wa + this.cellOv[ib * 4 + 3] * wb + this.cellOv[ic * 4 + 3] * wc + this.cellOv[id * 4 + 3] * wd;
        if (oa > 0.005) {
          const orr = (this.cellOv[ia * 4] * wa + this.cellOv[ib * 4] * wb + this.cellOv[ic * 4] * wc + this.cellOv[id * 4] * wd);
          const og = (this.cellOv[ia * 4 + 1] * wa + this.cellOv[ib * 4 + 1] * wb + this.cellOv[ic * 4 + 1] * wc + this.cellOv[id * 4 + 1] * wd);
          const ob = (this.cellOv[ia * 4 + 2] * wa + this.cellOv[ib * 4 + 2] * wb + this.cellOv[ic * 4 + 2] * wc + this.cellOv[id * 4 + 2] * wd);
          const t = Math.min(0.5, oa * 2.0);
          const nr = orr / Math.max(1e-4, oa), ng = og / Math.max(1e-4, oa), nb = ob / Math.max(1e-4, oa);
          r += (nr - r) * t; g += (ng - g) * t; b += (nb - b) * t;
        }
      }
      col[v * 3] = r; col[v * 3 + 1] = g; col[v * 3 + 2] = b;
      aux[v * 4] = water; aux[v * 4 + 1] = e > 0 ? light : light * 0.1; aux[v * 4 + 2] = 0; aux[v * 4 + 3] = 0;
    }
    this.colorAttr.needsUpdate = true;
    this.auxAttr.needsUpdate = true;
  }

  /** Ground radius exactly as the rendered triangles have it (same diagonal split), so anything placed on it sits on the drawn surface. */
  private radiusAtUV(u: number, v: number): number {
    const vw = NX + 1;
    u = Math.min(NX - 1e-6, Math.max(0, u));
    v = Math.min(NY - 1e-6, Math.max(0, v));
    const u0 = Math.floor(u), v0 = Math.floor(v);
    const fu = u - u0, fv = v - v0;
    const A = surfaceRadius(this.elevV[v0 * vw + u0]), B = surfaceRadius(this.elevV[v0 * vw + u0 + 1]);
    const C = surfaceRadius(this.elevV[(v0 + 1) * vw + u0]), E = surfaceRadius(this.elevV[(v0 + 1) * vw + u0 + 1]);
    if (fu + fv <= 1) return A + fu * (B - A) + fv * (C - A);
    return E + (1 - fu) * (C - E) + (1 - fv) * (B - E);
  }
  groundRadiusAt(lon: number, lat: number): number {
    const u = ((lon + Math.PI) / (Math.PI * 2)) * NX;
    const v = ((Math.PI / 2 - lat) / Math.PI) * NY;
    return this.radiusAtUV(((u % NX) + NX) % NX, v);
  }
  /** Terrain radius at a cell coordinate (continuous), for placing things on the ground. */
  groundRadius(x: number, y: number): number {
    return this.radiusAtUV((x / W) * NX, (y / H) * NY);
  }
}

function hsl(h: number): RGB {
  const sat = 0.62, l = 0.52;
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = sat * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}
export { mixc, cellLon };
