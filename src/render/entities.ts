import * as THREE from 'three';
import type { SimClient } from '../client';
import { BDEFS, RINGS, type BKind } from '../sim/buildings';
import { H, R_KM, W, lonOfX, latOfY, idx, wrapX } from '../sim/grid';
import { ACT, unpackPerson } from '../shared/protocol';
import type { Terrain } from './terrain';
import { hsl } from './fields';
import * as M from './models';

/**
 * Everything standing on the ground, at true size: people, animals, buildings, walls, fields, forests, rocks, ore,
 * berry bushes, ships and aircraft. Positions are kept relative to a local anchor near the camera (double precision on
 * the CPU, small float32 offsets on the GPU), and everything sits on the drawn terrain surface.
 */
const BKINDS = Object.keys(BDEFS) as BKind[];
const KM = 0.001; // metres → kilometres

export type PickKind = 'person' | 'settlement' | 'animal' | 'node' | 'building';
export interface Pickable { kind: PickKind; id: number; extra?: number; p: [number, number, number] }

const tmpM = new THREE.Matrix4();
const tmpC = new THREE.Color();
const vUp = new THREE.Vector3(), vN = new THREE.Vector3(), vE = new THREE.Vector3(), vF = new THREE.Vector3(), vR = new THREE.Vector3();
const Y = new THREE.Vector3(0, 1, 0);

function inst(g: THREE.BufferGeometry, n: number, mat?: THREE.Material): THREE.InstancedMesh {
  const m = new THREE.InstancedMesh(g, mat ?? new THREE.MeshLambertMaterial({ vertexColors: true }), n);
  m.frustumCulled = false;
  m.count = 0;
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  return m;
}

export class Entities {
  readonly group = new THREE.Group();
  anchor: [number, number, number] = [0, 0, R_KM];
  private people: THREE.InstancedMesh;
  private cargo: THREE.InstancedMesh;
  private skiffs: THREE.InstancedMesh;
  private animals: THREE.InstancedMesh[];
  private buildings = new Map<BKind, THREE.InstancedMesh>();
  private palisade: THREE.InstancedMesh;
  private stoneWall: THREE.InstancedMesh;
  private towers: THREE.InstancedMesh;
  private fields: THREE.Mesh;
  private trunks: THREE.InstancedMesh;
  private crowns: THREE.InstancedMesh[];
  private rocks: THREE.InstancedMesh;
  private ores: THREE.InstancedMesh;
  private sailships: THREE.InstancedMesh;
  private steamships: THREE.InstancedMesh;
  private planes: THREE.InstancedMesh;
  private trails: THREE.LineSegments;
  private sea: THREE.InstancedMesh;
  /** what can be clicked, in planet-frame km */
  pickables: Pickable[] = [];
  private staticPicks: Pickable[] = [];
  private stamp = '';
  private lastStatic = 0;
  private terrainStamp = 0;
  selected: { kind: string; id: number; extra?: number } | null = null;
  personPos = new Map<number, [number, number, number]>();

  constructor(private c: SimClient, private terrain: Terrain) {
    this.people = inst(M.personModel(), 8000);
    this.cargo = inst(M.cargoModel(), 8000);
    this.skiffs = inst(M.boatModel(false), 2000);
    this.animals = [0, 1, 2].map((d) => inst(M.animalModel(d), 3000));
    for (const k of BKINDS) if (k !== 'field' && !RINGS.includes(k)) this.buildings.set(k, inst(M.buildingModel(k), 6000));
    this.palisade = inst(M.wallSegment(false), 12000);
    this.stoneWall = inst(M.wallSegment(true), 12000);
    this.towers = inst(M.wallTower(), 400);
    this.fields = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    this.fields.frustumCulled = false;
    this.trunks = inst(M.treeTrunk(), 90000);
    this.crowns = [M.conifer(), M.broadleaf(), M.palm(), M.shrub()].map((g) => inst(g, 90000));
    this.rocks = inst(M.boulder(), 30000);
    this.ores = inst(M.boulder(), 3000, new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x222222 }));
    this.sailships = inst(M.boatModel(true), 400);
    this.steamships = inst(M.steamshipModel(), 400);
    this.planes = inst(M.planeModel(), 300);
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(300 * 6), 3));
    this.trails = new THREE.LineSegments(tg, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false }));
    this.trails.frustumCulled = false;
    this.sea = inst(M.whaleModel(), 600);
    this.group.add(this.people, this.cargo, this.skiffs, ...this.animals, ...this.buildings.values(), this.palisade, this.stoneWall, this.towers, this.fields,
      this.trunks, ...this.crowns, this.rocks, this.ores, this.sailships, this.steamships, this.planes, this.trails, this.sea);
  }

  // ---------------------------------------------------------------- placement helpers
  /** Planet-frame position (km) on the drawn ground at map coordinates, lifted `lift` km. */
  ground(x: number, y: number, lift = 0, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
    const lon = lonOfX(x), lat = latOfY(y);
    const cl = Math.cos(lat);
    const dx = cl * Math.cos(lon), dy = Math.sin(lat), dz = cl * Math.sin(lon);
    let h = this.terrain.heightAt(dx, dy, dz);
    if (h === null) h = Math.max(0, this.c.planet.elevAt(x, y));
    const r = R_KM + h + lift;
    out[0] = dx * r; out[1] = dy * r; out[2] = dz * r;
    return out;
  }
  /** Instance matrix: at planet-frame `p`, standing up, facing `heading` (radians from north toward east), scaled. */
  private place(p: [number, number, number], heading: number, sx: number, sy: number, sz: number, tilt = 0): THREE.Matrix4 {
    const r = Math.hypot(p[0], p[1], p[2]);
    vUp.set(p[0] / r, p[1] / r, p[2] / r);
    vN.copy(Y).addScaledVector(vUp, -vUp.y);
    if (vN.lengthSq() < 1e-10) vN.set(1, 0, 0);
    vN.normalize();
    vE.crossVectors(vUp, vN);
    vF.copy(vN).multiplyScalar(Math.cos(heading)).addScaledVector(vE, Math.sin(heading));
    vR.crossVectors(vUp, vF); // right-hand side (x axis)
    // a proper rotation: x = y × z, so nothing is mirrored
    if (tilt) {
      // lying down: the body's "up" points along the ground, its front faces the sky... or the earth
      tmpM.makeBasis(vR.clone().multiplyScalar(sx), vF.clone().multiplyScalar(sy), vUp.clone().negate().multiplyScalar(sz));
    } else tmpM.makeBasis(vR.clone().multiplyScalar(sx), vUp.clone().multiplyScalar(sy), vF.clone().multiplyScalar(sz));
    tmpM.setPosition(p[0] - this.anchor[0], p[1] - this.anchor[1], p[2] - this.anchor[2]);
    return tmpM;
  }
  private kmTo(p: [number, number, number], q: [number, number, number]) {
    return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  }

  // ---------------------------------------------------------------- per frame
  update(cam: [number, number, number], target: [number, number, number], origin: [number, number, number], day: number, alpha: number, time: number, camAlt: number, terrainVersion: number) {
    // re-anchor when the view has moved far enough for float32 offsets to matter
    if (this.kmTo(target, this.anchor) > 4) { this.anchor = [target[0], target[1], target[2]]; this.stamp = ''; }
    this.group.position.set(this.anchor[0] - origin[0], this.anchor[1] - origin[1], this.anchor[2] - origin[2]);
    const near = camAlt < 40;
    this.group.visible = camAlt < 400;
    if (!this.group.visible) { this.pickables = []; return; }
    const c = this.c;
    // static things: rebuilt when the simulation or the ground under them changes
    const st = `${c.versions.buildings}:${c.versions.nodes}:${c.versions.env}:${this.terrain.treeVersion}:${near}`;
    const now = performance.now();
    if ((st !== this.stamp || terrainVersion !== this.terrainStamp) && now - this.lastStatic > 450) {
      this.stamp = st;
      this.terrainStamp = terrainVersion;
      this.lastStatic = now;
      this.buildStatic(target, day);
    }
    this.pickables = this.staticPicks.slice();
    this.updatePeople(target, alpha, time, camAlt);
    this.updateAnimals(target, day, time, camAlt);
    this.updateVehicles(target, day, camAlt);
    this.updateSea(target, day, time, camAlt);
  }

  /** Whales, sharks, seals and turtles at the surface, as many as the sea's simulated populations allow. */
  private updateSea(target: [number, number, number], day: number, time: number, camAlt: number) {
    const m = this.c.marine;
    let n = 0;
    if (m && camAlt < 15) {
      const r0 = Math.hypot(target[0], target[1], target[2]);
      const tx = ((Math.atan2(target[2], target[0]) + Math.PI) / (Math.PI * 2)) * W, ty = ((Math.PI / 2 - Math.asin(target[1] / r0)) / Math.PI) * H;
      const kinds: [Uint8Array, number, number, number][] = [[m.whale, 14, 0x3a4048, 3], [m.shark, 3.5, 0x6a7078, 5], [m.seal, 1.8, 0x5a5048, 6], [m.turtle, 1.1, 0x4f5a3a, 5]];
      const p3: [number, number, number] = [0, 0, 0];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const ry = Math.floor(ty / 4) + dy;
        if (ry < 0 || ry >= H / 4) continue;
        const rx = (((Math.floor(tx / 4) + dx) % (W / 4)) + W / 4) % (W / 4);
        const r = ry * (W / 4) + rx;
        kinds.forEach(([dens, len, col, maxN], ki) => {
          const k = Math.round((dens[r] / 255) * maxN);
          for (let j = 0; j < k && n < 600; j++) {
            const h = (r * 2654435761 + ki * 97 + j * 7919) >>> 0;
            const period = 0.6 + (h % 100) / 100;
            const ang = (day / period) * Math.PI * 2 * 0.02 + (h % 628) / 100;
            const cx = rx * 4 + 0.5 + ((h >>> 8) % 300) / 100, cy = ry * 4 + 0.5 + ((h >>> 16) % 300) / 100;
            const x = cx + Math.cos(ang) * 0.06, y = cy + Math.sin(ang) * 0.06;
            const cell = Math.floor(y) * W + (((Math.floor(x) % W) + W) % W);
            if (!this.c.planet.ocean[cell]) continue;
            const surf = Math.sin(time * (0.25 + (h % 7) * 0.03) + j) ;
            const lift = (surf > 0.4 ? 0 : -0.006) + (ki === 0 && surf > 0.92 ? 0.002 * (surf - 0.92) * 12 : 0);
            const lon = lonOfX(x), lat = latOfY(y), cl = Math.cos(lat);
            const R = R_KM + lift + 0.0002;
            p3[0] = cl * Math.cos(lon) * R; p3[1] = Math.sin(lat) * R; p3[2] = cl * Math.sin(lon) * R;
            if (this.kmTo(p3, target) > 12) continue;
            const L = len * KM * (0.8 + ((h >>> 4) % 40) / 100);
            this.sea.setMatrixAt(n, this.place(p3, ang + Math.PI / 2, L, L, L));
            this.sea.setColorAt(n, tmpC.setHex(col));
            n++;
          }
        });
      }
    }
    this.sea.count = n;
    this.sea.instanceMatrix.needsUpdate = true;
    if (this.sea.instanceColor) this.sea.instanceColor.needsUpdate = true;
  }

  private updatePeople(target: [number, number, number], alpha: number, time: number, camAlt: number) {
    const P = this.c.people;
    let n = 0, nc = 0, nb = 0;
    this.personPos.clear();
    const p3: [number, number, number] = [0, 0, 0];
    const range = Math.max(2.5, Math.min(8, camAlt * 3));
    if (camAlt < 12) {
      for (let i = 0; i < P.n && n < 8000; i++) {
        let dx = P.x[i] - P.px[i];
        if (dx > W / 2) dx -= W;
        if (dx < -W / 2) dx += W;
        const x = P.px[i] + dx * alpha, y = P.py[i] + (P.y[i] - P.py[i]) * alpha;
        const a = unpackPerson(P.attr[i]);
        const sail = a.act === ACT.sail;
        this.ground(x, y, 0, p3);
        if (sail) { const r = Math.hypot(p3[0], p3[1], p3[2]); const k = (R_KM + 0.0004) / r; if (k > 1) { p3[0] *= k; p3[1] *= k; p3[2] *= k; } }
        this.personPos.set(P.id[i], [p3[0], p3[1], p3[2]]);
        if (this.kmTo(p3, target) > range) continue;
        const heading = Math.atan2(dx, -(P.y[i] - P.py[i])) || (P.id[i] % 628) / 100;
        const sc = (a.age === 0 ? 0.62 : a.age === 2 ? 0.95 : 1) * (a.female ? 0.95 : 1) * KM;
        const walking = a.act === ACT.walk || (Math.abs(dx) + Math.abs(P.y[i] - P.py[i]) > 1e-7 && a.act !== ACT.sleep);
        const bob = walking ? Math.abs(Math.sin(time * 9 + P.id[i])) * 0.04 * KM : a.act === ACT.work || a.act === ACT.build ? Math.abs(Math.sin(time * 5 + P.id[i])) * 0.06 * KM : 0;
        if (bob) { const r = Math.hypot(p3[0], p3[1], p3[2]); const k = (r + bob) / r; p3[0] *= k; p3[1] *= k; p3[2] *= k; }
        const m = this.place(p3, heading, sc, sc, sc, a.act === ACT.sleep ? 1 : 0);
        this.people.setMatrixAt(n, m);
        const sel = this.selected?.kind === 'person' && this.selected.id === P.id[i];
        const clothing = hsl(a.hue, a.band === 3 ? 0.25 : 0.5, a.female ? 0.5 : 0.4);
        tmpC.setRGB(clothing[0], clothing[1], clothing[2]);
        if (a.band === 3) tmpC.setRGB(0.55, 0.15, 0.12);
        if (sel) tmpC.setRGB(1.6, 1.4, 0.7);
        this.people.setColorAt(n, tmpC);
        n++;
        if (a.cargo && a.cargoAmt > 0 && nc < 8000) {
          const s2 = sc * (0.7 + Math.min(1, a.cargoAmt / 24) * 0.8);
          this.cargo.setMatrixAt(nc, this.place(p3, heading, s2, s2, s2));
          const col = [0, 0xd9b45a, 0x8a5a2b, 0x8b8b8b, 0xb85a3a, 0x555566, 0xb0b8c4, 0xf0c53a, 0xb07ab8][a.cargo] ?? 0x888888;
          this.cargo.setColorAt(nc, tmpC.setHex(col));
          nc++;
        }
        if (sail && nb < 2000) {
          this.skiffs.setMatrixAt(nb, this.place(p3, heading, KM, KM, KM));
          this.skiffs.setColorAt(nb, tmpC.setHex(0xffffff));
          nb++;
        }
        this.pickables.push({ kind: 'person', id: P.id[i], p: [p3[0], p3[1], p3[2]] });
      }
    }
    this.people.count = n;
    this.cargo.count = nc;
    this.skiffs.count = nb;
    for (const m of [this.people, this.cargo, this.skiffs]) { m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; }
  }

  private updateAnimals(target: [number, number, number], day: number, time: number, camAlt: number) {
    const counts = [0, 0, 0];
    const p3: [number, number, number] = [0, 0, 0];
    if (camAlt < 10) {
      const eco = this.c.eco;
      for (const pop of this.c.animals) {
        const k = eco.markerCount(pop as never);
        const herd = Math.max(1, Math.min(9, Math.round(pop.n / Math.max(1, k) / 25)));
        for (let m = 0; m < k; m++) {
          const mp = eco.markerPos(pop as never, m, day);
          if (!mp) continue;
          this.ground(mp.x, mp.y, 0, p3);
          if (this.kmTo(p3, target) > 4) continue;
          for (let j = 0; j < herd; j++) {
            const d = pop.diet;
            if (counts[d] >= 3000) break;
            const h = (pop.sp * 7919 + m * 104729 + j * 1299709) >>> 0;
            const ang = (h % 6283) / 1000, dist = (((h >>> 12) % 1000) / 1000) * 0.03 * Math.sqrt(herd);
            const kx = 1 / (24.5 * Math.max(0.1, Math.cos(latOfY(mp.y)))), ky = 1 / 24.5;
            const graze = Math.sin(time * 0.3 + j) * 0.002;
            const q = this.ground(mp.x + Math.cos(ang) * (dist + graze) * kx, mp.y + Math.sin(ang) * (dist + graze) * ky, 0, [0, 0, 0]);
            const len = Math.max(0.25, pop.size * 0.9) * KM;
            const mesh = this.animals[d];
            mesh.setMatrixAt(counts[d], this.place(q, ang + Math.sin(day * 30 + j) * 0.6, len, len, len));
            const col = hsl(pop.hue, d === 2 ? 0.45 : 0.3, d === 2 ? 0.3 : 0.38);
            mesh.setColorAt(counts[d], tmpC.setRGB(col[0], col[1], col[2]));
            counts[d]++;
            if (j === 0) this.pickables.push({ kind: 'animal', id: pop.sp, p: q });
          }
        }
      }
    }
    this.animals.forEach((mesh, d) => { mesh.count = counts[d]; mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true; });
  }

  private updateVehicles(target: [number, number, number], day: number, camAlt: number) {
    let ns = 0, nm = 0, np = 0, nt = 0;
    const tp = this.trails.geometry.attributes.position as THREE.BufferAttribute;
    const p3: [number, number, number] = [0, 0, 0];
    for (const r of this.c.skyState.routes) {
      const a = this.c.settlementById.get(r.a), b = this.c.settlementById.get(r.b);
      if (!a || !b) continue;
      for (let k = 0; k < r.fleet; k++) {
        const v = this.c.space.vehicleT(r, k, day);
        if (r.kind === 'sea') {
          const pt = alongPath(r.path, v.back ? 1 - v.t : v.t);
          if (!pt) continue;
          const lon = lonOfX(pt.x), lat = latOfY(pt.y), cl = Math.cos(lat);
          const R = R_KM + 0.0008;
          p3[0] = cl * Math.cos(lon) * R; p3[1] = Math.sin(lat) * R; p3[2] = cl * Math.sin(lon) * R;
          if (this.kmTo(p3, target) > 80) continue;
          const heading = Math.atan2(pt.dx, -pt.dy) + (v.back ? Math.PI : 0);
          const era = Math.max(a.era, b.era);
          if (era >= 2 && nm < 400) { this.steamships.setMatrixAt(nm++, this.place(p3, heading, KM, KM, KM)); }
          else if (ns < 400) { this.sailships.setMatrixAt(ns++, this.place(p3, heading, KM, KM, KM)); }
        } else if (np < 300) {
          const t = v.back ? 1 - v.t : v.t;
          const from = v.back ? b : a, to = v.back ? a : b;
          const g = greatCircle(from.x, from.y, to.x, to.y, t);
          const climb = Math.min(1, t * 12, (1 - t) * 12);
          const R = R_KM + 0.002 + 9.5 * climb;
          p3[0] = g.d[0] * R; p3[1] = g.d[1] * R; p3[2] = g.d[2] * R;
          if (this.kmTo(p3, target) > 160) continue;
          this.planes.setMatrixAt(np++, this.place(p3, g.heading, KM, KM, KM));
          if (climb > 0.95 && nt < 300) {
            const back = greatCircle(from.x, from.y, to.x, to.y, Math.max(0, t - 12 / Math.max(50, r.km)));
            const q = [back.d[0] * R, back.d[1] * R, back.d[2] * R];
            tp.setXYZ(nt * 2, p3[0] - this.anchor[0], p3[1] - this.anchor[1], p3[2] - this.anchor[2]);
            tp.setXYZ(nt * 2 + 1, q[0] - this.anchor[0], q[1] - this.anchor[1], q[2] - this.anchor[2]);
            nt++;
          }
        }
      }
    }
    this.sailships.count = ns; this.steamships.count = nm; this.planes.count = np;
    for (const m of [this.sailships, this.steamships, this.planes]) m.instanceMatrix.needsUpdate = true;
    this.trails.geometry.setDrawRange(0, nt * 2);
    tp.needsUpdate = true;
    void camAlt;
  }

  // ---------------------------------------------------------------- static layer
  private buildStatic(target: [number, number, number], day: number) {
    const c = this.c;
    const picks: Pickable[] = [];
    const p3: [number, number, number] = [0, 0, 0];
    const counts = new Map<BKind, number>();
    const clear: { p: [number, number, number]; r: number }[] = [];
    // ---- buildings
    const B = c.buildings;
    const fieldPos: number[] = [], fieldCol: number[] = [], fieldNorm: number[] = [];
    const extent = new Map<number, number>();
    if (B) {
      for (let i = 0; i < B.n; i++) {
        const kind = BKINDS[B.kind[i]];
        const done = (B.state[i] & 1) === 1;
        this.ground(B.x[i], B.y[i], 0, p3);
        const dist = this.kmTo(p3, target);
        if (dist > 12) continue;
        const s = c.settlementById.get(B.sid[i]);
        if (s && !RINGS.includes(kind) && kind !== 'field' && !['dock', 'airport', 'launchpad', 'factory', 'powerplant'].includes(kind)) {
          const sp = this.ground(s.x, s.y, 0, [0, 0, 0]);
          extent.set(s.id, Math.max(extent.get(s.id) ?? 0, this.kmTo(p3, sp)));
        }
        if (kind === 'field') {
          this.fieldQuad(B.x[i], B.y[i], B.rot[i], done ? B.progress[i] : B.progress[i] * 0.6 + 0.3, (B.state[i] >> 1) & 3, B.growth[i], fieldPos, fieldCol, fieldNorm);
          clear.push({ p: [p3[0], p3[1], p3[2]], r: 0.075 });
          picks.push({ kind: 'building', id: B.id[i], p: [p3[0], p3[1], p3[2]] });
          continue;
        }
        if (RINGS.includes(kind)) continue;
        const mesh = this.buildings.get(kind);
        if (!mesh) continue;
        const n = counts.get(kind) ?? 0;
        if (n >= 6000) continue;
        const prog = done ? 1 : 0.12 + 0.88 * B.progress[i];
        mesh.setMatrixAt(n, this.place(p3, B.rot[i], KM, KM * prog, KM));
        const tint = hsl(B.hue[i], 0.25, 0.75);
        tmpC.setRGB(0.55 + tint[0] * 0.45, 0.55 + tint[1] * 0.45, 0.55 + tint[2] * 0.45);
        if (!done) tmpC.multiplyScalar(0.65);
        if (this.selected?.kind === 'building' && this.selected.id === B.id[i]) tmpC.setRGB(1.5, 1.35, 0.8);
        mesh.setColorAt(n, tmpC);
        counts.set(kind, n + 1);
        clear.push({ p: [p3[0], p3[1], p3[2]], r: BDEFS[kind].size * 0.9 + 0.006 });
        picks.push({ kind: 'building', id: B.id[i], p: [p3[0], p3[1], p3[2]] });
      }
    }
    for (const [k, mesh] of this.buildings) { mesh.count = counts.get(k) ?? 0; mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true; }
    // fields
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.Float32BufferAttribute(fieldPos, 3));
    fg.setAttribute('normal', new THREE.Float32BufferAttribute(fieldNorm, 3));
    fg.setAttribute('color', new THREE.Float32BufferAttribute(fieldCol, 3));
    this.fields.geometry.dispose();
    this.fields.geometry = fg;
    // ---- walls: a ring of palisade or stone around the built-up area
    let np = 0, nw = 0, nt = 0;
    for (const s of c.settlements) {
      if (!s.walls) continue;
      const cp = this.ground(s.x, s.y, 0, [0, 0, 0]);
      if (this.kmTo(cp, target) > 10) continue;
      const rad = (extent.get(s.id) ?? 0.06) + 0.02;
      const segLen = 0.001;
      const nSeg = Math.floor((2 * Math.PI * rad) / segLen);
      const kx = 1 / (24.5 * Math.max(0.1, Math.cos(latOfY(s.y)))), ky = 1 / 24.5;
      for (let i = 0; i < nSeg; i++) {
        if (i % 160 < 6) continue; // gates
        const a = (i / nSeg) * Math.PI * 2;
        const q = this.ground(s.x + Math.cos(a) * rad * kx, s.y + Math.sin(a) * rad * ky, 0, [0, 0, 0]);
        const heading = Math.atan2(-Math.sin(a), -Math.cos(a)) + Math.PI / 2;
        if (s.walls === 2) {
          if (nw < 12000) this.stoneWall.setMatrixAt(nw++, this.place(q, heading + Math.PI / 2, KM, KM, KM));
          if (i % 90 === 0 && nt < 400) this.towers.setMatrixAt(nt++, this.place(q, 0, KM, KM, KM));
        } else if (np < 12000) this.palisade.setMatrixAt(np++, this.place(q, heading + Math.PI / 2, KM, KM, KM));
      }
    }
    this.palisade.count = np; this.stoneWall.count = nw; this.towers.count = nt;
    for (const m of [this.palisade, this.stoneWall, this.towers]) m.instanceMatrix.needsUpdate = true;
    // ---- resource sites: outcrops, ore, clay, berry bushes (and the groves that thin the forest)
    const groves: { p: [number, number, number]; r: number; frac: number }[] = [];
    let nr = 0, no = 0;
    const camMx = ((Math.atan2(target[2], target[0]) + Math.PI) / (Math.PI * 2)) * W;
    const camMy = ((Math.PI / 2 - Math.asin(target[1] / Math.hypot(target[0], target[1], target[2]))) / Math.PI) * H;
    const shrubs: { p: [number, number, number]; s: number; berries: number; key: number }[] = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const cy = Math.floor(camMy) + dy;
      if (cy < 0 || cy >= H) continue;
      const cell = idx(wrapX(Math.floor(camMx) + dx), cy);
      for (const nd of c.res.nodes(cell)) {
        const key = cell * 64 + nd.slot;
        const frac = c.nodeFrac.get(key) ?? 1;
        const q = this.ground(nd.x, nd.y, 0, [0, 0, 0]);
        const dist = this.kmTo(q, target);
        if (nd.kind === 'tree') { groves.push({ p: q, r: 0.12 + 0.0025 * nd.max, frac }); continue; }
        if (dist > 5 || nd.kind === 'fish') continue;
        if (nd.kind === 'bush') { shrubs.push({ p: q, s: 2.2, berries: frac, key }); picks.push({ kind: 'node', id: cell, extra: nd.slot, p: q }); continue; }
        const hidden = ['copper', 'iron', 'coal', 'gold', 'clay'].includes(nd.kind) && !c.known.has(key);
        if (hidden) continue;
        const rr = (key * 2654435761) >>> 0;
        const k = nd.kind === 'stone' ? 6 : 3;
        for (let j = 0; j < k; j++) {
          const h = (rr ^ (j * 40503)) >>> 0;
          const ang = (h % 6283) / 1000, dd = ((h >>> 13) % 1000) / 1000 * 0.012;
          const kx = 1 / (24.5 * Math.max(0.1, Math.cos(latOfY(nd.y)))), ky = 1 / 24.5;
          const qq = this.ground(nd.x + Math.cos(ang) * dd * kx, nd.y + Math.sin(ang) * dd * ky, 0, [0, 0, 0]);
          const size = (nd.kind === 'stone' ? 2 + ((h >>> 5) % 100) / 22 : 1.4) * Math.max(0.25, frac) * KM;
          if (nd.kind === 'stone') {
            if (nr < 30000) { this.rocks.setMatrixAt(nr, this.place(qq, ang, size, size, size)); this.rocks.setColorAt(nr, tmpC.setHex(0x9a958c)); nr++; }
          } else if (no < 3000) {
            const col = nd.kind === 'clay' ? 0xa8553a : nd.kind === 'copper' ? 0xc86f3a : nd.kind === 'iron' ? 0x7a4a3a : nd.kind === 'coal' ? 0x1e1e22 : 0xf0c53a;
            this.ores.setMatrixAt(no, this.place(qq, ang, size, nd.kind === 'clay' ? size * 0.25 : size, size));
            this.ores.setColorAt(no, tmpC.setHex(col));
            no++;
          }
        }
        picks.push({ kind: 'node', id: cell, extra: nd.slot, p: q });
      }
    }
    // ---- forests from the terrain lattice, thinned by what the simulation says is growing there
    const env = c.env;
    let ntr = 0;
    const nc = [0, 0, 0, 0];
    const flora = c.flora;
    const season = Math.sin(((day % 360) - 90) / 360 * Math.PI * 2);
    const anchor = this.anchor;
    for (const tc of this.terrain.treeChunks) {
      const t = tc.trees;
      for (let k = 0; k < t.length; k += 8) {
        const px = t[k] + tc.center[0], py = t[k + 1] + tc.center[1], pz = t[k + 2] + tc.center[2];
        const q: [number, number, number] = [px, py, pz];
        const d = Math.hypot(px - target[0], py - target[1], pz - target[2]);
        if (d > 4) continue;
        const type = t[k + 5], hgt = t[k + 3], crown = t[k + 4], hv = t[k + 6], cell = t[k + 7];
        if (type === 4) {
          if (nr < 30000) { const s = hgt; this.rocks.setMatrixAt(nr, this.place(q, hv * 6.28, crown, s, crown)); this.rocks.setColorAt(nr, tmpC.setHex(0x8a857c)); nr++; }
          continue;
        }
        // is the forest still standing here?
        const base = c.planet.baseVeg[cell] + 0.05;
        const veg = env ? env.veg[cell] / 255 : base;
        if (hv > Math.min(1, (veg / base) * 1.15)) continue;
        let skip = false;
        for (const g of clear) { if (Math.abs(g.p[0] - px) < g.r && Math.abs(g.p[1] - py) < g.r && Math.abs(g.p[2] - pz) < g.r && Math.hypot(g.p[0] - px, g.p[1] - py, g.p[2] - pz) < g.r) { skip = true; break; } }
        if (skip) continue;
        for (const g of groves) {
          if (g.frac >= 0.999) continue;
          if (Math.hypot(g.p[0] - px, g.p[1] - py, g.p[2] - pz) < g.r && ((hv * 7.13) % 1) > g.frac) { skip = true; break; }
        }
        if (skip) continue;
        const burn = env ? env.burn[cell] : 0;
        const dead = burn >= 64 && burn < 128 && ((hv * 3.7) % 1) < burn / 127;
        if (ntr >= 90000) break;
        this.trunks.setMatrixAt(ntr, this.place(q, hv * 6.28, hgt * (type === 2 ? 0.35 : 0.55), hgt, hgt * (type === 2 ? 0.35 : 0.55)));
        this.trunks.setColorAt(ntr, tmpC.setHex(dead ? 0x2a2420 : 0xffffff));
        ntr++;
        if (dead) continue;
        const ct = type === 0 ? 0 : type === 2 ? 2 : type === 3 ? 3 : 1;
        if (nc[ct] >= 90000) continue;
        const mesh = this.crowns[ct];
        mesh.setMatrixAt(nc[ct], this.place(q, hv * 6.28, crown, hgt, crown));
        const reg = Math.floor(Math.floor(cell / W) / 4) * 64 + Math.floor((cell % W) / 4);
        const hue = (flora ? flora.hue[reg] : 0.3) + (hv - 0.5) * 0.04;
        const lat = latOfY(Math.floor(cell / W) + 0.5);
        const autumn = ct === 1 ? Math.max(0, Math.min(1, 1 - Math.abs(season * Math.sign(lat) + 0.35) / 0.45)) * Math.max(0, Math.min(1, (Math.abs(lat) - 0.35) / 0.3)) : 0;
        const col = hsl(hue * (1 - autumn) + 0.08 * autumn, ct === 0 ? 0.35 : 0.45, ct === 0 ? 0.2 : 0.26 + 0.06 * hv);
        tmpC.setRGB(col[0], col[1], col[2]);
        const snow = env ? Math.min(1, ((env.snow[cell] / 4) ** 2) / 60) : 0;
        if (snow > 0.2 && ct === 0) tmpC.lerp(new THREE.Color(0.9, 0.92, 0.95), snow * 0.6);
        mesh.setColorAt(nc[ct], tmpC);
        nc[ct]++;
      }
    }
    for (const s of shrubs) {
      if (nc[3] >= 90000) break;
      for (let j = 0; j < 3; j++) {
        const h = (s.key * 7 + j * 131) >>> 0;
        const a = (h % 628) / 100, dd = 0.003 * (j + 1);
        const r = Math.hypot(s.p[0], s.p[1], s.p[2]);
        const up = [s.p[0] / r, s.p[1] / r, s.p[2] / r];
        const side = Math.abs(up[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
        const ex = [up[1] * side[2] - up[2] * side[1], up[2] * side[0] - up[0] * side[2], up[0] * side[1] - up[1] * side[0]];
        const el = Math.hypot(ex[0], ex[1], ex[2]);
        const q: [number, number, number] = [s.p[0] + (ex[0] / el) * dd * Math.cos(a), s.p[1] + (ex[1] / el) * dd * Math.cos(a), s.p[2] + (ex[2] / el) * dd * Math.cos(a)];
        const sz = s.s * KM * (0.7 + 0.3 * s.berries);
        this.crowns[3].setMatrixAt(nc[3], this.place(q, a, sz * 0.6, sz * 0.7, sz * 0.6));
        this.crowns[3].setColorAt(nc[3], tmpC.setRGB(0.18 + 0.5 * s.berries * 0.4, 0.32, 0.14));
        nc[3]++;
      }
    }
    this.trunks.count = ntr;
    this.crowns.forEach((m, k) => { m.count = nc[k]; });
    this.rocks.count = nr;
    this.ores.count = no;
    for (const m of [this.trunks, ...this.crowns, this.rocks, this.ores]) { m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; }
    // settlements are pickable from anywhere
    for (const s of c.settlements) picks.push({ kind: 'settlement', id: s.id, p: this.ground(s.x, s.y, 0.01, [0, 0, 0]) });
    this.staticPicks = picks;
    void anchor;
  }

  /** A field: a 100 m square of crop rows draped over the ground. */
  private fieldQuad(x: number, y: number, rot: number, prog: number, fstate: number, growth: number, pos: number[], col: number[], nor: number[]) {
    const size = BDEFS.field.size * prog; // km
    const kx = 1 / (24.5 * Math.max(0.1, Math.cos(latOfY(y)))), ky = 1 / 24.5;
    const cr = Math.cos(rot), sr = Math.sin(rot);
    const S = 6, ROWS = 12;
    const at = (u: number, v: number): [number, number, number] => {
      const lx = (u - 0.5) * size, ly = (v - 0.5) * size;
      return this.ground(x + (lx * cr - ly * sr) * kx, y + (lx * sr + ly * cr) * ky, 0.0003, [0, 0, 0]);
    };
    const base = fstate === 0 ? [0.42, 0.32, 0.2] : fstate === 2 ? [0.78, 0.66, 0.28] : [0.25 + 0.15 * (1 - growth), 0.38 + 0.12 * growth, 0.14];
    const grid: [number, number, number][] = [];
    for (let j = 0; j <= S; j++) for (let i = 0; i <= ROWS; i++) grid.push(at(i / ROWS, j / S));
    for (let j = 0; j < S; j++) for (let i = 0; i < ROWS; i++) {
      const a = grid[j * (ROWS + 1) + i], b = grid[j * (ROWS + 1) + i + 1], c = grid[(j + 1) * (ROWS + 1) + i], d = grid[(j + 1) * (ROWS + 1) + i + 1];
      const shade = i % 2 ? 0.86 : 1.04;
      for (const p of [a, b, c, b, d, c]) {
        pos.push(p[0] - this.anchor[0], p[1] - this.anchor[1], p[2] - this.anchor[2]);
        const r = Math.hypot(p[0], p[1], p[2]);
        nor.push(p[0] / r, p[1] / r, p[2] / r);
        col.push(base[0] * shade, base[1] * shade, base[2] * shade);
      }
    }
  }
}

/** A point a fraction `t` of the way along a polyline of map coordinates, with its direction. */
function alongPath(path: number[], t: number): { x: number; y: number; dx: number; dy: number } | null {
  const n = path.length / 2;
  if (n < 2) return null;
  let total = 0;
  const seg: number[] = [];
  for (let i = 1; i < n; i++) {
    let dx = path[i * 2] - path[i * 2 - 2];
    if (dx > W / 2) dx -= W;
    if (dx < -W / 2) dx += W;
    const l = Math.hypot(dx * Math.cos(latOfY(path[i * 2 + 1])), path[i * 2 + 1] - path[i * 2 - 1]);
    seg.push(l);
    total += l;
  }
  let want = t * total;
  for (let i = 1; i < n; i++) {
    const l = seg[i - 1];
    if (want <= l || i === n - 1) {
      const f = l > 0 ? Math.min(1, want / l) : 0;
      let dx = path[i * 2] - path[i * 2 - 2];
      if (dx > W / 2) dx -= W;
      if (dx < -W / 2) dx += W;
      const dy = path[i * 2 + 1] - path[i * 2 - 1];
      return { x: path[i * 2 - 2] + dx * f, y: path[i * 2 - 1] + dy * f, dx, dy };
    }
    want -= l;
  }
  return null;
}

/** Great-circle point between two map positions, and the heading there. */
function greatCircle(ax: number, ay: number, bx: number, by: number, t: number): { d: [number, number, number]; heading: number } {
  const dir = (x: number, y: number) => { const lon = lonOfX(x), lat = latOfY(y), c = Math.cos(lat); return [c * Math.cos(lon), Math.sin(lat), c * Math.sin(lon)]; };
  const A = dir(ax, ay), B = dir(bx, by);
  const dot = Math.max(-1, Math.min(1, A[0] * B[0] + A[1] * B[1] + A[2] * B[2]));
  const om = Math.acos(dot);
  const s = Math.sin(om) || 1;
  const k1 = Math.sin((1 - t) * om) / s, k2 = Math.sin(t * om) / s;
  const d: [number, number, number] = [A[0] * k1 + B[0] * k2, A[1] * k1 + B[1] * k2, A[2] * k1 + B[2] * k2];
  // heading: toward B in the local east/north frame
  const up = new THREE.Vector3(...d);
  const north = new THREE.Vector3(0, 1, 0).addScaledVector(up, -up.y).normalize();
  const east = new THREE.Vector3().crossVectors(up, north);
  const to = new THREE.Vector3(B[0] - d[0], B[1] - d[1], B[2] - d[2]);
  return { d, heading: Math.atan2(to.dot(east), to.dot(north)) };
}
