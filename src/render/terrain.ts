import * as THREE from 'three';
import type { SimClient } from '../client';
import { R_KM } from '../sim/grid';
import { FACES, SEG, TREE_LEVEL, dirFace, faceDir, type ChunkResult, type TerrainInput } from './terrainGen';
import type { Fields } from './fields';
import { ATMOSPHERE, HAZE, LOGDEPTH_FRAG, LOGDEPTH_FRAG_PARS, LOGDEPTH_VERT, LOGDEPTH_VERT_PARS, NOISE } from './shaders';

/**
 * The ground at true scale: a cube-sphere quadtree whose chunks are built in worker threads and refined around the
 * observer, from 1,500 km tiles seen from orbit down to a few metres between vertices underfoot. Chunk positions are kept
 * relative to a floating origin at the camera, so a person and a planet can share one scene without losing precision.
 */
export const MAX_LEVEL = 14;
const SPLIT = 3.2;

interface Node {
  key: string;
  face: number;
  level: number;
  i: number;
  j: number;
  dir: [number, number, number];
  sizeKm: number;
  children?: Node[];
  mesh?: THREE.Mesh;
  water?: THREE.Mesh;
  center?: [number, number, number];
  detailOff?: THREE.Vector3;
  heights?: Float32Array;
  seg?: number;
  surface?: Float32Array;
  trees?: Float32Array;
  pending: boolean;
  used: number;
  /** distance / size when last wanted: lower is more urgent */
  prio: number;
  minH: number;
  maxH: number;
}

export interface TreeChunk { key: string; center: [number, number, number]; trees: Float32Array; level: number }

export class Terrain {
  readonly group = new THREE.Group();
  readonly material: THREE.ShaderMaterial;
  readonly waterMaterial: THREE.ShaderMaterial;
  private roots: Node[] = [];
  private all = new Map<string, Node>();
  private workers: Worker[] = [];
  private busy: number[] = [];
  private queue: Node[] = [];
  private frame = 0;
  drawn: Node[] = [];
  /** chunks near the camera that carry trees (consumed by the forest layer) */
  treeChunks: TreeChunk[] = [];
  treeVersion = 0;
  stats = { drawn: 0, cached: 0, pending: 0 };

  constructor(private c: SimClient, fields: Fields) {
    const p = c.planet;
    const input: TerrainInput = {
      seed: p.seed, seaLevel: p.terrain.seaLevel, ocean: p.ocean, lake: p.lake, lakeLevel: p.lakeLevel, river: p.river, drain: p.drain, flow: p.flow,
      biome: p.biome, baseVeg: p.baseVeg, tempMean: p.tempMean, elev: p.elev,
    };
    const n = Math.max(2, Math.min(6, (navigator.hardwareConcurrency || 4) - 2));
    for (let k = 0; k < n; k++) {
      const wk = new Worker(new URL('./terrain.worker.ts', import.meta.url), { type: 'module' });
      wk.postMessage({ t: 'init', input });
      wk.onmessage = (ev: MessageEvent<ChunkResult>) => { this.busy[k]--; this.receive(ev.data); this.pump(); };
      this.workers.push(wk);
      this.busy.push(0);
    }
    for (let f = 0; f < 6; f++) this.roots.push(this.node(f, 0, 0, 0));
    this.material = terrainMaterial(fields);
    this.waterMaterial = waterMaterial(fields);
  }

  private node(face: number, level: number, i: number, j: number): Node {
    const key = `${face}/${level}/${i}/${j}`;
    let n = this.all.get(key);
    if (n) return n;
    const k = 1 << level;
    n = {
      key, face, level, i, j, dir: faceDir(face, -1 + (2 * (i + 0.5)) / k, -1 + (2 * (j + 0.5)) / k), sizeKm: ((Math.PI / 2) * R_KM) / k,
      pending: false, used: 0, minH: 0, maxH: 0, prio: 1e9,
    };
    this.all.set(key, n);
    return n;
  }

  private request(n: Node) {
    if (n.pending || n.mesh) return;
    n.pending = true;
    this.queue.push(n);
  }

  private pump() {
    if (!this.queue.length) return;
    for (let k = 0; k < this.workers.length; k++) {
      while (this.busy[k] < 2 && this.queue.length) {
        // the most urgent job first: wanted this frame, and largest on screen (distance / size)
        let bi = 0;
        for (let q = 1; q < this.queue.length; q++) {
          const a = this.queue[q], b = this.queue[bi];
          if (a.used > b.used + 2 || (Math.abs(a.used - b.used) <= 2 && a.prio < b.prio)) bi = q;
        }
        const n = this.queue.splice(bi, 1)[0];
        if (this.frame - n.used > 30) { n.pending = false; continue; }
        this.busy[k]++;
        this.workers[k].postMessage({ t: 'chunk', face: n.face, level: n.level, i: n.i, j: n.j, key: n.key });
      }
    }
  }

  private receive(r: ChunkResult) {
    const n = this.all.get(r.key);
    if (!n) return;
    n.pending = false;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(r.pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(r.normal, 3));
    g.setAttribute('aDir', new THREE.BufferAttribute(r.dir, 3));
    g.setAttribute('aElev', new THREE.BufferAttribute(r.elev, 1));
    g.setIndex(new THREE.BufferAttribute(r.index, 1));
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, this.material);
    m.matrixAutoUpdate = true;
    n.center = r.center;
    // the 289-periodic detail lattice: this chunk's centre, wrapped (exact in float64)
    n.detailOff = new THREE.Vector3(mod289(r.center[0]), mod289(r.center[1]), mod289(r.center[2]));
    const off = n.detailOff;
    m.onBeforeRender = () => { this.material.uniforms.uDetailOff.value.copy(off); this.material.uniformsNeedUpdate = true; };
    m.visible = false;
    n.mesh = m;
    n.heights = r.heights;
    n.surface = r.surface;
    n.seg = r.seg;
    n.minH = r.minH;
    n.maxH = r.maxH;
    this.group.add(m);
    if (r.water) {
      const wg = new THREE.BufferGeometry();
      wg.setAttribute('position', new THREE.BufferAttribute(r.water.pos, 3));
      wg.setAttribute('aDir', new THREE.BufferAttribute(r.water.dir, 3));
      wg.setAttribute('aDepth', new THREE.BufferAttribute(r.water.depth, 1));
      wg.setIndex(new THREE.BufferAttribute(r.water.index, 1));
      wg.computeBoundingSphere();
      const wm = new THREE.Mesh(wg, this.waterMaterial);
      wm.renderOrder = 2;
      wm.onBeforeRender = () => { this.waterMaterial.uniforms.uDetailOff.value.copy(off); this.waterMaterial.uniformsNeedUpdate = true; };
      wm.visible = false;
      n.water = wm;
      this.group.add(wm);
    }
    if (r.trees && r.trees.length) n.trees = r.trees;
  }

  /** Choose and place chunks for a camera at `cam` (planet frame, km). */
  update(cam: [number, number, number], origin: [number, number, number]) {
    this.frame++;
    for (const n of this.drawn) { if (n.mesh) n.mesh.visible = false; if (n.water) n.water.visible = false; }
    this.drawn = [];
    const camR = Math.hypot(cam[0], cam[1], cam[2]);
    const camAlt = camR - R_KM;
    const coarseSplit = SPLIT + (7 - SPLIT) * Math.max(0, Math.min(1, (camAlt - 150) / 300));
    const camDir: [number, number, number] = [cam[0] / camR, cam[1] / camR, cam[2] / camR];
    const horizon = Math.acos(Math.min(1, (R_KM - 8) / Math.max(R_KM, camR)));
    const visit = (n: Node): boolean => {
      n.used = this.frame;
      // horizon culling (with a margin for the tile's own size)
      const ang = Math.acos(Math.max(-1, Math.min(1, n.dir[0] * camDir[0] + n.dir[1] * camDir[1] + n.dir[2] * camDir[2])));
      if (ang > horizon + (n.sizeKm / R_KM) * 1.1 + 0.02) return true;
      const ch = n.mesh ? (n.minH + n.maxH) / 2 : 0;
      const cx = n.dir[0] * (R_KM + ch) - cam[0], cy = n.dir[1] * (R_KM + ch) - cam[1], cz = n.dir[2] * (R_KM + ch) - cam[2];
      const d = Math.hypot(cx, cy, cz);
      // coarse tiles (seen from orbit) refine sooner, so coasts stay within a pixel or two; the factor eases in with
      // altitude so nothing coarsens as the camera descends, and stops at level 4 (level-6 children of a level-5 tile
      // sample the same vertex lattice, since tiles up to level 5 carry twice the segments)
      const split = n.level < MAX_LEVEL && d < n.sizeKm * (n.level <= 4 ? coarseSplit : SPLIT);
      n.prio = d / n.sizeKm;
      if (split) {
        if (!n.children) {
          const l = n.level + 1;
          n.children = [this.node(n.face, l, n.i * 2, n.j * 2), this.node(n.face, l, n.i * 2 + 1, n.j * 2), this.node(n.face, l, n.i * 2, n.j * 2 + 1), this.node(n.face, l, n.i * 2 + 1, n.j * 2 + 1)];
        }
        let ready = true;
        for (const k of n.children) { k.used = this.frame; k.prio = n.prio * 2; if (!k.mesh) { ready = false; this.request(k); } }
        if (ready) {
          for (const k of n.children) visit(k);
          return true;
        }
      }
      if (n.mesh) { this.draw(n); return true; }
      this.request(n);
      return false;
    };
    for (const r of this.roots) visit(r);
    for (const n of this.drawn) {
      const c = n.center!;
      n.mesh!.position.set(c[0] - origin[0], c[1] - origin[1], c[2] - origin[2]);
      n.mesh!.visible = true;
      if (n.water) { n.water.position.copy(n.mesh!.position); n.water.visible = true; }
    }
    this.pump();
    // forest layer: tree-carrying chunks among those drawn, near the camera
    const tc: TreeChunk[] = [];
    for (const n of this.drawn) {
      if (!n.trees || n.level < TREE_LEVEL) continue;
      const c = n.center!;
      if (Math.hypot(c[0] - cam[0], c[1] - cam[1], c[2] - cam[2]) > 4.5 + n.sizeKm) continue;
      tc.push({ key: n.key, center: c, trees: n.trees, level: n.level });
    }
    const sig = tc.map((t) => t.key).join('|');
    if (sig !== this.treeSig) { this.treeSig = sig; this.treeChunks = tc; this.treeVersion++; }
    if (this.frame % 120 === 0) this.evict();
    this.stats.drawn = this.drawn.length;
    this.stats.cached = this.all.size;
    this.stats.pending = this.queue.length + this.busy.reduce((a, b) => a + b, 0);
  }
  private treeSig = '';

  private draw(n: Node) {
    this.drawn.push(n);
  }

  private evict() {
    if (this.all.size < 1400) return;
    const old = [...this.all.values()].filter((n) => n.level > 0 && this.frame - n.used > 240).sort((a, b) => a.used - b.used);
    for (const n of old.slice(0, this.all.size - 1000)) {
      if (n.mesh) { this.group.remove(n.mesh); n.mesh.geometry.dispose(); }
      if (n.water) { this.group.remove(n.water); n.water.geometry.dispose(); }
      n.mesh = n.water = undefined;
      n.heights = n.surface = n.trees = undefined;
      n.children = undefined;
      this.all.delete(n.key);
    }
    // parents may still point at evicted children
    for (const n of this.all.values()) if (n.children && n.children.some((k) => !this.all.has(k.key))) n.children = undefined;
  }

  /** Height (km) of the drawn ground at a unit direction, from the finest loaded chunk (null if none). */
  heightAt(x: number, y: number, z: number): number | null {
    return this.gridAt(x, y, z, false);
  }
  /** Height (km) of the ground or of the water over it, whichever is higher: the observer stays above it. */
  surfaceAt(x: number, y: number, z: number): number | null {
    return this.gridAt(x, y, z, true);
  }
  private gridAt(x: number, y: number, z: number, water: boolean): number | null {
    const f = dirFace(x, y, z);
    let best: Node | undefined;
    let n: Node | undefined = this.roots[f.face];
    while (n) {
      if (n.heights) best = n;
      if (!n.children) break;
      const k: number = 1 << (n.level + 1);
      const ci: number = Math.min(k - 1, Math.max(0, Math.floor(((f.s + 1) / 2) * k))) - n.i * 2;
      const cj: number = Math.min(k - 1, Math.max(0, Math.floor(((f.t + 1) / 2) * k))) - n.j * 2;
      n = n.children[cj * 2 + ci];
    }
    if (!best || !best.heights) return null;
    const k = 1 << best.level;
    const S = best.seg ?? SEG;
    const a = (((f.s + 1) / 2) * k - best.i) * S, b = (((f.t + 1) / 2) * k - best.j) * S;
    const a0 = Math.max(0, Math.min(S - 1, Math.floor(a))), b0 = Math.max(0, Math.min(S - 1, Math.floor(b)));
    const u = Math.max(0, Math.min(1, a - a0)), v = Math.max(0, Math.min(1, b - b0));
    const V = S + 1, hh = water && best.surface ? best.surface : best.heights;
    const A = hh[b0 * V + a0], B = hh[b0 * V + a0 + 1], C = hh[(b0 + 1) * V + a0], D = hh[(b0 + 1) * V + a0 + 1];
    return u + v <= 1 ? A + u * (B - A) + v * (C - A) : D + (1 - u) * (C - D) + (1 - v) * (B - D);
  }

  setCities(list: { dir: [number, number, number]; r: number; lights: number; hue: number }[]) {
    const u = this.material.uniforms;
    const a = u.uCity.value as THREE.Vector4[], b = u.uCityInfo.value as THREE.Vector4[];
    for (let k = 0; k < a.length; k++) {
      const c = list[k];
      if (c) { a[k].set(c.dir[0], c.dir[1], c.dir[2], c.r); b[k].set(c.lights, c.hue, 1, 0); } else { a[k].set(0, 0, 0, 0); b[k].set(0, 0, 0, 0); }
    }
  }

  dispose() {
    for (const w of this.workers) w.terminate();
  }
}

function mod289(v: number) {
  return v - Math.floor(v / 289) * 289;
}

const UV = /* glsl */ `
vec2 uvOf(vec3 d){ return vec2(atan(d.z, d.x) * 0.15915494 + 0.5, 0.5 - asin(clamp(d.y, -1.0, 1.0)) * 0.31830989); }
`;

export const CITY_SLOTS = 32;

function terrainMaterial(f: Fields): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uLand: { value: f.land }, uAux: { value: f.aux }, uClimate: { value: f.climate }, uPolitics: { value: f.politics }, uWeather: { value: f.weather },
      uSun: { value: new THREE.Vector3(1, 0, 0) }, uTime: { value: 0 }, uCamH: { value: 1 }, uCamDir: { value: new THREE.Vector3(0, 1, 0) }, uDetailOff: { value: new THREE.Vector3() },
      uCity: { value: Array.from({ length: CITY_SLOTS }, () => new THREE.Vector4()) }, uCityInfo: { value: Array.from({ length: CITY_SLOTS }, () => new THREE.Vector4()) },
      uPolOn: { value: 0 }, uDust: { value: 1 }, uFlash: { value: 0 },
    },
    vertexShader: /* glsl */ `
      ${LOGDEPTH_VERT_PARS}
      attribute vec3 aDir; attribute float aElev;
      varying vec3 vDir; varying vec3 vN; varying float vElev; varying vec3 vLocal; varying vec3 vView;
      void main(){
        vDir = aDir; vN = normal; vElev = aElev; vLocal = position;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vView = (modelMatrix * vec4(position, 1.0)).xyz; // camera-relative (the camera sits at the origin)
        gl_Position = projectionMatrix * mv;
        ${LOGDEPTH_VERT}
      }`,
    fragmentShader: /* glsl */ `
      ${LOGDEPTH_FRAG_PARS}
      uniform sampler2D uLand; uniform sampler2D uAux; uniform sampler2D uClimate; uniform sampler2D uPolitics; uniform sampler2D uWeather;
      uniform vec3 uSun; uniform float uTime; uniform float uCamH; uniform vec3 uDetailOff; uniform float uPolOn; uniform float uDust; uniform float uFlash;
      uniform vec4 uCity[${CITY_SLOTS}]; uniform vec4 uCityInfo[${CITY_SLOTS}];
      varying vec3 vDir; varying vec3 vN; varying float vElev; varying vec3 vLocal; varying vec3 vView;
      ${NOISE}
      ${UV}
      ${HAZE}
      void main(){
        ${LOGDEPTH_FRAG}
        vec3 d = normalize(vDir);
        vec3 N = normalize(vN);
        float dist = length(vView);
        vec3 V = -vView / max(dist, 1e-6);
        vec2 uv = uvOf(d);
        vec2 wuv = uv + (vec2(fbm3(d * 120.0), fbm3(d * 120.0 + 7.0)) - 0.5) * vec2(0.011, 0.016) + (vec2(vnoise(d * 700.0 + 3.0), vnoise(d * 700.0 + 11.0)) - 0.5) * vec2(0.003, 0.004);
        vec4 land = texture2D(uLand, wuv);
        vec4 aux = texture2D(uAux, wuv);
        vec4 clim = texture2D(uClimate, uv);
        float cellT = clim.r * 127.5 - 50.0;
        float cellE = clim.g * 8.5;
        float h = vElev;
        float T = cellT - 6.5 * (h - cellE);
        float slope = 1.0 - clamp(dot(N, d), 0.0, 1.0);
        // fine detail: seamless lattice noise near the camera, fading with distance
        vec3 lp = uDetailOff + vLocal;
        float mid = 1.0 - smoothstep(4.0, 60.0, dist);
        float near = 1.0 - smoothstep(0.3, 4.0, dist);
        float vnear = 1.0 - smoothstep(0.02, 0.5, dist);
        float n1 = fbm3(lp * 0.9);
        float n2 = fbm3(lp * 33.0);
        float n3 = vnoise(lp * 330.0);
        float n4 = vnoise(lp * 2100.0);
        float dn = (n1 - 0.5) * mid + (n2 - 0.5) * 0.55 * near + (n3 - 0.5) * 0.4 * vnear + (n4 - 0.5) * 0.3 * (1.0 - smoothstep(0.002, 0.04, dist));
        vec3 alb = land.rgb * (1.0 + 0.42 * dn);
        // dry and lush patches in living ground, bare earth showing through
        float lushV = land.a;
        alb = mix(alb, alb * vec3(1.18, 1.06, 0.72), smoothstep(0.55, 0.8, n2) * 0.4 * near * lushV);
        alb = mix(alb, vec3(0.36, 0.3, 0.22), smoothstep(0.7, 0.85, n3) * 0.35 * vnear * (1.0 - lushV * 0.5));
        // small-scale relief for the light to catch
        vec3 rnd = vec3(vnoise(lp * 330.0 + 3.1), vnoise(lp * 330.0 + 7.7), vnoise(lp * 330.0 + 1.3)) - 0.5;
        N = normalize(N + (rnd - d * dot(rnd, d)) * 0.5 * vnear + (vec3(n2, n1, n2) - 0.5 - d * dot(vec3(n2, n1, n2) - 0.5, d)) * 0.25 * near);
        // bare rock on steep and high ground; sand and shingle at the shore
        vec3 rockC = mix(vec3(0.42, 0.40, 0.37), vec3(0.55, 0.52, 0.47), fbm3(lp * 6.0));
        // peaks standing well above their cell's mean height: colder, by the lapse rate, than the air the simulation tracks
        float above = smoothstep(0.1, 0.5, h - cellE);
        float rock = smoothstep(0.16, 0.42, slope + (dn - 0.5) * 0.12) + smoothstep(-1.0, -7.0, T) * 0.6 * above * (1.0 - land.a * 0.5);
        alb = mix(alb, rockC, clamp(rock, 0.0, 1.0));
        float shore = (1.0 - smoothstep(0.0012, 0.0045 + dn * 0.002, h)) * (clim.b > 0.5 || h < 0.003 ? 1.0 : 0.0);
        alb = mix(alb, vec3(0.76, 0.69, 0.52), shore * 0.85);
        // snow: the simulated snowpack (thinning out on warmer low ground), plus high ground above the present snow line;
        // it slides off cliffs. T is this week's air temperature carried to this height at 6.5 °C per km.
        float snowField = smoothstep(0.25, 0.75, aux.r + (fbm3(d * 400.0) - 0.5) * 0.6) * (1.0 - smoothstep(2.0, 8.0, T));
        float snow = max(snowField, smoothstep(-0.5, -5.0, T + (dn - 0.5) * 3.0) * above) * (1.0 - smoothstep(0.35, 0.62, slope));
        alb = mix(alb, vec3(0.93, 0.95, 0.98), clamp(snow, 0.0, 1.0));
        // towns: paved ground, roofs and, at night, street light
        float lightAmt = 0.0;
        vec3 P = d * (1000.0 + h);
        for (int k = 0; k < ${CITY_SLOTS}; k++) {
          vec4 c = uCity[k];
          if (c.w <= 0.0) continue;
          float dk = length(P - c.xyz * 1000.0);
          float r = c.w;
          if (dk > r * 1.6) continue;
          float core = 1.0 - smoothstep(r * 0.25, r * (1.1 + 0.3 * vnoise(lp * 3.0)), dk);
          float grid = step(0.82, fract(lp.x * 22.0)) + step(0.82, fract(lp.z * 22.0));
          alb = mix(alb, mix(vec3(0.45, 0.42, 0.38), vec3(0.3, 0.29, 0.28), clamp(grid, 0.0, 1.0)), core * 0.55);
          lightAmt += core * uCityInfo[k].x * (0.35 + 0.65 * vnoise(lp * 60.0)) * (0.5 + 0.5 * clamp(grid, 0.0, 1.0));
        }
        // political map
        vec4 pol = texture2D(uPolitics, wuv);
        alb = mix(alb, pol.rgb, pol.a * uPolOn * 0.6);
        // the palette above is in sRGB; light in linear space
        alb = pow(max(alb, vec3(0.0)), vec3(2.2));
        // lighting
        vec3 L = normalize(uSun);
        float sunUp = dot(d, L);
        float day = smoothstep(-0.1, 0.15, sunUp);
        float ndl = max(dot(N, L), 0.0) * smoothstep(-0.03, 0.06, sunUp);
        vec4 wx = texture2D(uWeather, uv);
        float shade = 1.0 - 0.6 * wx.r * smoothstep(0.0, 0.3, sunUp);
        float wet = smoothstep(0.55, 1.0, aux.b) * 0.25 + smoothstep(0.02, 0.2, wx.g) * 0.35;
        alb *= 1.0 - wet * (1.0 - snow);
        vec3 sunCol = mix(vec3(1.0, 0.5, 0.25), vec3(1.0, 0.96, 0.9), smoothstep(0.0, 0.3, sunUp)) * uDust;
        vec3 amb = mix(vec3(0.015, 0.02, 0.035), vec3(0.3, 0.38, 0.52) * 0.42, day) * (0.7 + 0.3 * dot(N, d));
        vec3 col = alb * (sunCol * ndl * 1.25 * shade + amb + vec3(0.6, 0.65, 0.8) * uFlash);
        // night: town lights and wildfires glow
        float night = 1.0 - smoothstep(-0.12, 0.04, sunUp);
        col += vec3(1.0, 0.72, 0.38) * lightAmt * (0.25 + 0.75 * night) * 0.9;
        float fire = aux.g * (0.6 + 0.4 * sin(uTime * 7.0 + vnoise(lp * 8.0) * 20.0)) * smoothstep(0.3, 0.8, vnoise(lp * 4.0 + uTime * 0.2));
        col += vec3(1.0, 0.35, 0.05) * fire * (0.5 + 1.5 * night);
        col = haze(col, dist, uCamH, h, d, -V, L);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

function waterMaterial(f: Fields): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    uniforms: {
      uOcean: { value: f.ocean }, uWeather: { value: f.weather }, uSun: { value: new THREE.Vector3(1, 0, 0) }, uTime: { value: 0 }, uCamH: { value: 1 },
      uDetailOff: { value: new THREE.Vector3() }, uDust: { value: 1 }, uFlash: { value: 0 },
    },
    vertexShader: /* glsl */ `
      ${LOGDEPTH_VERT_PARS}
      attribute vec3 aDir; attribute float aDepth;
      varying vec3 vDir; varying float vDepth; varying vec3 vLocal; varying vec3 vView;
      void main(){
        vDir = aDir; vDepth = aDepth; vLocal = position;
        vView = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        ${LOGDEPTH_VERT}
      }`,
    fragmentShader: /* glsl */ `
      ${LOGDEPTH_FRAG_PARS}
      uniform sampler2D uOcean; uniform sampler2D uWeather; uniform vec3 uSun; uniform float uTime; uniform float uCamH; uniform vec3 uDetailOff; uniform float uDust; uniform float uFlash;
      varying vec3 vDir; varying float vDepth; varying vec3 vLocal; varying vec3 vView;
      ${NOISE}
      ${UV}
      ${HAZE}
      void main(){
        ${LOGDEPTH_FRAG}
        if (vDepth <= 0.0) discard;
        vec3 d = normalize(vDir);
        float dist = length(vView);
        vec3 V = -vView / max(dist, 1e-6);
        vec2 uv = uvOf(d);
        vec4 oc = texture2D(uOcean, uv);
        vec4 wx = texture2D(uWeather, uv);
        float sst = (oc.b * 255.0 - 128.0) / 3.0;
        vec2 cur = (oc.rg * 255.0 - 128.0) / 200.0;
        float wind = abs(oc.a * 255.0 - 128.0) / 4.0;
        // waves: lattice noise drifting with wind and current
        vec3 lp = uDetailOff + vLocal;
        float t = uTime;
        float rough = 0.35 + clamp(wind / 12.0, 0.0, 1.0) + wx.g * 0.02;
        vec3 q0 = lp * 8.0 + vec3(t * 0.05, 0.0, t * 0.03);
        vec3 q1 = lp * 90.0 + vec3(t * 0.9 + cur.x * t * 3.0, t * 0.3, cur.y * t * 3.0);
        vec3 q2 = lp * 420.0 + vec3(-t * 1.7, t * 1.1, t * 0.6);
        float nearW = 1.0 - smoothstep(0.3, 12.0, dist);
        // each wave octave fades out once its lattice (125 m, 11 m, 2.4 m) is smaller than a few pixels
        float foot = max(length(fwidth(vLocal)), 1e-7);
        float f0 = 1.0 - smoothstep(0.03, 0.12, foot), f1 = 1.0 - smoothstep(0.003, 0.012, foot), f2 = 1.0 - smoothstep(0.0006, 0.0025, foot);
        float v0 = vnoise(q0), v1 = vnoise(q1), v2 = vnoise(q2);
        vec3 grad = (vec3(vnoise(q0 + vec3(0.13, 0.0, 0.0)), vnoise(q0 + vec3(0.0, 0.13, 0.0)), vnoise(q0 + vec3(0.0, 0.0, 0.13))) - v0) * 1.2 * f0
                  + (vec3(vnoise(q1 + vec3(0.13, 0.0, 0.0)), vnoise(q1 + vec3(0.0, 0.13, 0.0)), vnoise(q1 + vec3(0.0, 0.0, 0.13))) - v1) * 2.2 * f1
                  + (vec3(vnoise(q2 + vec3(0.1, 0.0, 0.0)), vnoise(q2 + vec3(0.0, 0.1, 0.0)), vnoise(q2 + vec3(0.0, 0.0, 0.1))) - v2) * 1.4 * f2;
        vec3 N = normalize(d + (grad - d * dot(grad, d)) * 0.35 * rough);
        // waves too small to resolve still roughen the surface: the sun's glint spreads out instead of sparkling
        float unres = 1.0 - f1;
        // ocean-scale current streaks seen from altitude
        float streak = smoothstep(0.55, 0.8, fbm3(d * 260.0 + vec3(cur * t * 0.002, 0.0))) * length(cur) * 2.0 * (1.0 - nearW);
        vec3 L = normalize(uSun);
        float sunUp = dot(d, L);
        float day = smoothstep(-0.1, 0.15, sunUp);
        float deep = 1.0 - exp(-vDepth / 0.025);
        vec3 shallow = vec3(0.07, 0.36, 0.38), abyss = vec3(0.03, 0.11, 0.24);
        vec3 body = pow(mix(shallow, abyss, deep) * (1.0 + streak * 0.6), vec3(2.2));
        // sea ice where the water freezes
        float floes = fbm3(d * 240.0) + (fbm3(lp * 3.0) - 0.5) * 0.4 * nearW;
        float ice = smoothstep(-0.8, -2.4, sst + (floes - 0.5) * 2.5) * (1.0 - nearW * 0.2);
        float fres = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
        vec3 R = reflect(-V, N);
        // the reflected sky: blue overhead, with the low sun's glow only toward the sun
        vec3 zen = mix(vec3(0.02, 0.03, 0.06), vec3(0.4, 0.56, 0.88), smoothstep(-0.15, 0.25, sunUp));
        float az = dot(normalize(R - d * dot(R, d) + 1e-5), normalize(L - d * dot(L, d) + 1e-5));
        float glowK = pow(max(az, 0.0), 6.0) * (1.0 - smoothstep(0.05, 0.4, sunUp)) * smoothstep(-0.15, 0.0, sunUp);
        vec3 skyC = mix(zen, vec3(0.95, 0.5, 0.25), glowK);
        float shin = mix(220.0, mix(60.0, 18.0, clamp(rough - 0.35, 0.0, 1.0)), unres);
        float spec = pow(max(dot(R, L), 0.0), shin) * 6.0 * (shin / 220.0) * smoothstep(-0.02, 0.05, sunUp) * (1.0 - ice);
        float ndl = max(dot(N, L), 0.0) * smoothstep(-0.03, 0.06, sunUp);
        vec3 sunCol = mix(vec3(1.0, 0.5, 0.25), vec3(1.0, 0.96, 0.9), smoothstep(0.0, 0.3, sunUp)) * uDust;
        vec3 col = body * (ndl * sunCol * 0.6 + day * 0.25 + 0.02) + skyC * fres * 0.9 + sunCol * spec;
        col = mix(col, vec3(0.72, 0.79, 0.88) * (ndl * 1.1 * sunCol + 0.12 * day + 0.01), ice);
        // surf where the water is shallow
        float foam = (1.0 - smoothstep(0.0, 0.0015, vDepth)) * smoothstep(0.4, 0.75, vnoise(lp * 600.0 + t * 0.6)) * nearW;
        col += vec3(0.8) * foam * (ndl + 0.1);
        col += vec3(0.6, 0.65, 0.8) * uFlash * 0.2;
        col = haze(col, dist, uCamH, 0.0, d, -V, L);
        float alpha = mix(smoothstep(0.0, 0.004, vDepth) * 0.92, 1.0, max(fres * 0.5, ice));
        gl_FragColor = vec4(col, clamp(alpha + deep * 0.1, 0.0, 1.0));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

void ATMOSPHERE; void FACES;
