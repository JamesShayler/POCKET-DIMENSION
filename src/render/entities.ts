import * as THREE from 'three';
import type { World } from '../sim/world';
import { H, NR, R_KM, RF, RW, W, idx, lonOfX, latOfY } from '../sim/grid';
import { Rng, mix32 } from '../sim/rng';
import { PlanetView } from './planetView';
import { CameraRig } from './camera';

const Y = new THREE.Vector3(0, 1, 0);
const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpP = new THREE.Vector3();
const tmpS = new THREE.Vector3();
const tmpN = new THREE.Vector3();
const tmpC = new THREE.Color();

export type Pick = { kind: 'person' | 'settlement' | 'animal'; id: number; sx: number; sy: number };

function hsl(h: number, s: number, l: number) {
  return tmpC.setHSL(h, s, l);
}

/** Instanced markers for settlements, buildings, people and animals. They only *observe* the world. */
export class EntityLayer {
  readonly group = new THREE.Group();
  private people: THREE.InstancedMesh;
  private animals: THREE.InstancedMesh;
  private houses: THREE.InstancedMesh;
  private markers: THREE.InstancedMesh;
  private ring: THREE.Mesh;
  private pings: THREE.Mesh[] = [];
  private pingState: { x: number; y: number; t0: number; color: number }[] = [];
  private regionLand: Int32Array[] = [];
  private peopleIds: number[] = [];
  private animalInfo: { sp: number; r: number; x: number; y: number; z: number }[] = [];
  private lastHouseBuild = -1e9;
  private houseKey = '';
  selected: { kind: string; id: number } | null = null;
  static readonly MAX_PEOPLE = 7000;
  static readonly MAX_ANIMALS = 7000;
  static readonly MAX_HOUSES = 5000;

  constructor(private world: World, private pv: PlanetView) {
    const capsule = new THREE.CapsuleGeometry(0.28, 0.9, 2, 5);
    capsule.translate(0, 0.7, 0);
    this.people = new THREE.InstancedMesh(capsule, new THREE.MeshLambertMaterial({ color: 0xffffff }), EntityLayer.MAX_PEOPLE);
    const cone = new THREE.ConeGeometry(0.5, 1.2, 5);
    cone.translate(0, 0.6, 0);
    this.animals = new THREE.InstancedMesh(cone, new THREE.MeshLambertMaterial({ color: 0xffffff }), EntityLayer.MAX_ANIMALS);
    const box = new THREE.BoxGeometry(1, 1, 1);
    box.translate(0, 0.5, 0);
    this.houses = new THREE.InstancedMesh(box, new THREE.MeshLambertMaterial({ color: 0xffffff }), EntityLayer.MAX_HOUSES);
    const marker = new THREE.ConeGeometry(0.6, 2, 6);
    marker.translate(0, 1, 0);
    this.markers = new THREE.InstancedMesh(marker, new THREE.MeshBasicMaterial({ color: 0xffffff }), 2000);
    for (const m of [this.people, this.animals, this.houses, this.markers]) {
      m.frustumCulled = false;
      m.count = 0;
      this.group.add(m);
    }
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.8, 1, 40), new THREE.MeshBasicMaterial({ color: 0xfff1b0, side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthTest: false }));
    this.ring.visible = false;
    this.ring.renderOrder = 10;
    this.group.add(this.ring);
    for (let i = 0; i < 6; i++) {
      const p = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 48), new THREE.MeshBasicMaterial({ color: 0xffd27a, side: THREE.DoubleSide, transparent: true, opacity: 0, depthTest: false }));
      p.visible = false;
      p.renderOrder = 9;
      this.pings.push(p);
      this.group.add(p);
    }
    // land cells per region for placing wildlife
    for (let r = 0; r < NR; r++) this.regionLand.push(new Int32Array(0));
    const lists: number[][] = Array.from({ length: NR }, () => []);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = idx(x, y);
      if (!world.planet.ocean[i] && !world.planet.lake[i]) lists[Math.floor(y / RF) * RW + Math.floor(x / RF)].push(i);
    }
    this.regionLand = lists.map((l) => Int32Array.from(l));
    world.bus.on('*', (e) => {
      if (e.weight >= 2 && e.x !== undefined && e.y !== undefined) this.ping(e.x, e.y, e.type === 'DISASTER' || e.type === 'BATTLE' || e.type === 'REVOLT' ? 0xff6b5a : e.type === 'TECHNOLOGY_DISCOVERY' ? 0x9be8ff : 0xffd27a);
    });
  }

  ping(x: number, y: number, color: number) {
    this.pingState.push({ x, y, t0: performance.now(), color });
    if (this.pingState.length > 6) this.pingState.shift();
  }

  private place(x: number, y: number, lift: number, out: THREE.Vector3, n: THREE.Vector3) {
    const lon = lonOfX(x);
    const lat = latOfY(y);
    CameraRig.dir(lon, lat, n);
    const r = this.pv.groundRadius(x, y) + lift + 0.03;
    out.copy(n).multiplyScalar(r);
  }

  personPos(p: { x: number; y: number; px: number; py: number }, alpha: number, out: THREE.Vector3, n: THREE.Vector3) {
    let dx = p.x - p.px;
    if (dx > W / 2) dx -= W;
    if (dx < -W / 2) dx += W;
    const x = p.px + dx * alpha;
    const y = p.py + (p.y - p.py) * alpha;
    this.place(x, y, 0, out, n);
  }

  update(cam: CameraRig, camera: THREE.PerspectiveCamera, alpha: number, time: number, sunDir: THREE.Vector3) {
    const w = this.world;
    const alt = cam.alt;
    const camPos = camera.position;
    const lookDir = cam.target.clone().normalize();
    // ---- settlement markers (visible from orbit) ----
    let mi = 0;
    const markScale = Math.max(0.35, alt * 0.0042);
    const showMarkers = alt > 18;
    if (showMarkers) {
      for (const s of w.activeSettlements()) {
        if (mi >= 2000) break;
        this.place(s.x, s.y, 0.3, tmpP, tmpN);
        if (tmpN.dot(camPos.clone().normalize()) < -0.1 && alt < R_KM * 1.2) continue;
        const stage = { camp: 0.55, settlement: 0.75, village: 0.95, town: 1.2, city: 1.6 }[s.stage];
        const cul = w.cultures.get(s.culture);
        hsl(cul ? cul.color : 0.1, 0.75, 0.62);
        tmpQ.setFromUnitVectors(Y, tmpN);
        tmpS.setScalar(markScale * stage * (alt > 20000 ? alt / 20000 : 1));
        tmpM.compose(tmpP, tmpQ, tmpS);
        this.markers.setMatrixAt(mi, tmpM);
        this.markers.setColorAt(mi, tmpC);
        mi++;
      }
    }
    this.markers.count = mi;
    this.markers.instanceMatrix.needsUpdate = true;
    if (this.markers.instanceColor) this.markers.instanceColor.needsUpdate = true;

    // ---- buildings (zoomed in) ----
    this.buildHouses(cam, camera);

    // ---- people ----
    let pi = 0;
    this.peopleIds.length = 0;
    const personScale = Math.min(6, Math.max(0.02, alt * 0.0075));
    const maxDist = alt * 4 + 40;
    if (alt < 900) {
      for (const p of w.alive) {
        if (pi >= EntityLayer.MAX_PEOPLE) break;
        if (!p.alive) continue;
        this.personPos(p, alpha, tmpP, tmpN);
        if (tmpP.distanceToSquared(camPos) > maxDist * maxDist) continue;
        const selected = this.selected && this.selected.kind === 'person' && this.selected.id === p.id;
        const cul = w.cultures.get(p.culture);
        const age = p.ageYears(w.day);
        hsl(cul ? cul.color : 0.1, p.band ? 0.35 : 0.8, selected ? 0.9 : p.sex ? 0.64 : 0.52);
        tmpQ.setFromUnitVectors(Y, tmpN);
        const s = personScale * (age < 12 ? 0.55 : 1) * (selected ? 1.8 : 1);
        tmpS.setScalar(s);
        tmpM.compose(tmpP, tmpQ, tmpS);
        this.people.setMatrixAt(pi, tmpM);
        this.people.setColorAt(pi, tmpC);
        this.peopleIds[pi] = p.id;
        pi++;
      }
    }
    this.people.count = pi;
    this.people.instanceMatrix.needsUpdate = true;
    if (this.people.instanceColor) this.people.instanceColor.needsUpdate = true;

    // ---- wildlife (aggregated populations drawn as a representative sample) ----
    let ai = 0;
    this.animalInfo.length = 0;
    if (alt < 1400) {
      const eco = w.eco;
      const vis = alt * 5 + 80;
      for (const pop of eco.pops.values()) {
        if (ai >= EntityLayer.MAX_ANIMALS) break;
        const cells = this.regionLand[pop.r];
        if (!cells.length) continue;
        const rx = (pop.r % RW) * RF + RF / 2;
        const ry = Math.floor(pop.r / RW) * RF + RF / 2;
        this.place(rx, ry, 0, tmpP, tmpN);
        if (tmpP.distanceToSquared(camPos) > (vis + 80) * (vis + 80)) continue;
        const sp = eco.speciesById(pop.sp);
        const k = Math.min(14, Math.max(1, Math.ceil(Math.log2(1 + pop.n) * 1.4)));
        const diet = sp.diet;
        for (let m = 0; m < k && ai < EntityLayer.MAX_ANIMALS; m++) {
          const h = mix32(mix32(pop.sp, pop.r), m);
          const cell = cells[h % cells.length];
          const wx = (h >>> 8) % 1000 / 1000;
          const wy = (h >>> 18) % 1000 / 1000;
          const ph = ((h >>> 3) % 628) / 100;
          const x = (cell % W) + 0.15 + wx * 0.7 + Math.sin(time * 0.05 + ph) * 0.18;
          const y = Math.floor(cell / W) + 0.15 + wy * 0.7 + Math.cos(time * 0.045 + ph) * 0.18;
          this.place(x, y, 0, tmpP, tmpN);
          if (tmpP.distanceToSquared(camPos) > vis * vis) continue;
          tmpQ.setFromUnitVectors(Y, tmpN);
          const yaw = new THREE.Quaternion().setFromAxisAngle(tmpN, ph);
          tmpQ.premultiply(yaw);
          const size = (0.5 + 0.28 * Math.log(1 + pop.t.size * 2)) * personScale * (diet === 'carn' ? 1.1 : 1);
          tmpS.set(size, size, size);
          tmpM.compose(tmpP, tmpQ, tmpS);
          this.animals.setMatrixAt(ai, tmpM);
          hsl(sp.hue, diet === 'carn' ? 0.7 : 0.45, diet === 'carn' ? 0.36 : diet === 'omni' ? 0.45 : 0.55);
          this.animals.setColorAt(ai, tmpC);
          this.animalInfo[ai] = { sp: sp.id, r: pop.r, x: tmpP.x, y: tmpP.y, z: tmpP.z };
          ai++;
        }
      }
    }
    this.animals.count = ai;
    this.animals.instanceMatrix.needsUpdate = true;
    if (this.animals.instanceColor) this.animals.instanceColor.needsUpdate = true;

    this.updateRing(cam, alpha, time);
    this.updatePings(cam);
    void sunDir; void lookDir;
  }

  private buildHouses(cam: CameraRig, camera: THREE.PerspectiveCamera) {
    const w = this.world;
    const alt = cam.alt;
    if (alt > 140) { this.houses.count = 0; this.houseKey = ''; return; }
    const key = `${w.activeSettlements().length}:${Math.floor(cam.lon * 40)}:${Math.floor(cam.lat * 40)}:${Math.floor(w.day / 90)}`;
    const now = performance.now();
    if (key === this.houseKey && now - this.lastHouseBuild < 4000) return;
    this.houseKey = key;
    this.lastHouseBuild = now;
    let hi = 0;
    const camPos = camera.position;
    const range = alt * 6 + 60;
    const scaleUp = Math.max(1, alt * 0.012);
    for (const s of w.activeSettlements()) {
      this.place(s.x, s.y, 0, tmpP, tmpN);
      if (tmpP.distanceToSquared(camPos) > range * range) continue;
      const count = Math.min(220, Math.ceil(s.pop / (s.stage === 'camp' ? 2.2 : 2.6)));
      const rr = new Rng(mix32(s.id, 77));
      const radiusCells = (0.15 + Math.sqrt(s.pop) * 0.05) / 24;
      const cul = w.cultures.get(s.culture);
      const arch = s.tech.has('architecture') ? 1.8 : s.tech.has('tools') ? 1.2 : 0.8;
      const tall = s.stage === 'city' ? 2.2 : s.stage === 'town' ? 1.6 : 1;
      for (let k = 0; k < count && hi < EntityLayer.MAX_HOUSES; k++) {
        const a = rr.next() * Math.PI * 2;
        const d = Math.sqrt(rr.next()) * radiusCells;
        const x = s.x + Math.cos(a) * d;
        const y = s.y + Math.sin(a) * d;
        if (y < 0 || y >= H) continue;
        const cell = idx(((Math.floor(x) % W) + W) % W, Math.floor(y));
        if (w.planet.ocean[cell] || w.planet.lake[cell]) continue;
        this.place(x, y, -0.02, tmpP, tmpN);
        tmpQ.setFromUnitVectors(Y, tmpN);
        tmpQ.premultiply(new THREE.Quaternion().setFromAxisAngle(tmpN, rr.next() * 3.14));
        const base = (s.stage === 'camp' ? 0.045 : 0.06) * scaleUp * (0.8 + rr.next() * 0.6);
        tmpS.set(base, base * arch * tall * (0.7 + rr.next() * 0.7), base * (0.9 + rr.next() * 0.4));
        tmpM.compose(tmpP, tmpQ, tmpS);
        this.houses.setMatrixAt(hi, tmpM);
        hsl((cul ? cul.color : 0.1) + 0.02, 0.28, 0.5 + rr.next() * 0.15);
        this.houses.setColorAt(hi, tmpC);
        hi++;
      }
    }
    this.houses.count = hi;
    this.houses.instanceMatrix.needsUpdate = true;
    if (this.houses.instanceColor) this.houses.instanceColor.needsUpdate = true;
  }

  private updateRing(cam: CameraRig, alpha: number, time: number) {
    const sel = this.selected;
    this.ring.visible = false;
    if (!sel) return;
    let pos: THREE.Vector3 | null = null;
    const n = new THREE.Vector3();
    if (sel.kind === 'person') {
      const p = this.world.people.get(sel.id);
      if (p && p.alive) { pos = new THREE.Vector3(); this.personPos(p, alpha, pos, n); }
    } else if (sel.kind === 'settlement') {
      const s = this.world.settlements[sel.id - 1];
      if (s && s.abandoned < 0) { pos = new THREE.Vector3(); this.place(s.x, s.y, 0.5, pos, n); }
    }
    if (!pos) return;
    this.ring.visible = true;
    this.ring.position.copy(pos);
    this.ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    const base = Math.max(0.15, cam.alt * 0.012) * (sel.kind === 'settlement' ? 2.2 : 1);
    this.ring.scale.setScalar(base * (1 + 0.12 * Math.sin(time * 4)));
  }

  private updatePings(cam: CameraRig) {
    const now = performance.now();
    this.pingState = this.pingState.filter((p) => now - p.t0 < 7000);
    for (let i = 0; i < this.pings.length; i++) {
      const m = this.pings[i];
      const st = this.pingState[i];
      if (!st) { m.visible = false; continue; }
      const t = (now - st.t0) / 7000;
      m.visible = true;
      const n = new THREE.Vector3();
      this.place(st.x, st.y, 0.8, m.position, n);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
      m.scale.setScalar((6 + t * 40) * Math.max(1, cam.alt / 800));
      const mat = m.material as THREE.MeshBasicMaterial;
      mat.color.setHex(st.color);
      mat.opacity = 0.9 * (1 - t);
    }
  }

  /** Nearest entity to a screen position (observer picking; the observer never commands, only inspects). */
  pick(sx: number, sy: number, camera: THREE.PerspectiveCamera, vw: number, vh: number, alpha: number, radiusPx = 16): Pick | null {
    const w = this.world;
    let best: Pick | null = null;
    let bd = radiusPx * radiusPx;
    const v = new THREE.Vector3();
    const n = new THREE.Vector3();
    const proj = (p: THREE.Vector3) => {
      v.copy(p).project(camera);
      if (v.z > 1 || v.z < -1) return null;
      return { x: (v.x * 0.5 + 0.5) * vw, y: (-v.y * 0.5 + 0.5) * vh };
    };
    const camN = camera.position.clone().normalize();
    for (const s of w.activeSettlements()) {
      this.place(s.x, s.y, 0.3, v, n);
      if (n.dot(camN) < 0.05) continue;
      const q = proj(v.clone());
      if (!q) continue;
      const d = (q.x - sx) ** 2 + (q.y - sy) ** 2;
      if (d < bd * 1.8) { bd = d / 1.8; best = { kind: 'settlement', id: s.id, sx: q.x, sy: q.y }; }
    }
    for (let i = 0; i < this.peopleIds.length; i++) {
      const p = w.people.get(this.peopleIds[i]);
      if (!p || !p.alive) continue;
      this.personPos(p, alpha, v, n);
      const q = proj(v.clone().addScaledVector(n, 0.3 * Math.max(0.02, camera.position.length() * 0.0)));
      if (!q) continue;
      const d = (q.x - sx) ** 2 + (q.y - sy) ** 2;
      if (d < bd) { bd = d; best = { kind: 'person', id: p.id, sx: q.x, sy: q.y }; }
    }
    if (!best || best.kind !== 'person') {
      for (const a of this.animalInfo) {
        v.set(a.x, a.y, a.z);
        const q = proj(v);
        if (!q) continue;
        const d = (q.x - sx) ** 2 + (q.y - sy) ** 2;
        if (d < bd) { bd = d; best = { kind: 'animal', id: a.sp, sx: q.x, sy: q.y }; }
      }
    }
    return best;
  }
}
