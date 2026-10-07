import * as THREE from 'three';
import type { World } from '../sim/world';
import { H, NR, R_KM, RF, RW, W, idx, kmPerCellX, lonOfX, latOfY } from '../sim/grid';
import { mix32, Rng } from '../sim/rng';
import { BDEFS, HOUSING } from '../sim/buildings';
import { GROW_DAYS } from '../sim/jobs';
import type { NodeKind } from '../sim/resources';
import { PlanetView } from './planetView';
import { CameraRig } from './camera';

const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);
const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpQ2 = new THREE.Quaternion();
const tmpP = new THREE.Vector3();
const tmpS = new THREE.Vector3();
const tmpN = new THREE.Vector3();
const tmpC = new THREE.Color();

export type Pick = { kind: 'person' | 'settlement' | 'animal' | 'node' | 'building'; id: number; sx: number; sy: number; extra?: number };

const hsl = (h: number, s: number, l: number) => tmpC.setHSL(h, s, l);

const ORE_COLOR: Partial<Record<NodeKind, number>> = { copper: 0xc86f3a, iron: 0x7a4a3a, coal: 0x1c1c20, gold: 0xf0c53a };

/** Instanced markers for the physical world. Everything is read from the simulation; nothing is written back. */
export class EntityLayer {
  readonly group = new THREE.Group();
  private people: THREE.InstancedMesh;
  private cargo: THREE.InstancedMesh;
  private animals: THREE.InstancedMesh;
  private markers: THREE.InstancedMesh;
  private trunks: THREE.InstancedMesh;
  private crowns: THREE.InstancedMesh;
  private bushes: THREE.InstancedMesh;
  private rocks: THREE.InstancedMesh;
  private ores: THREE.InstancedMesh;
  private walls: THREE.InstancedMesh;
  private roofs: THREE.InstancedMesh;
  private fields: THREE.InstancedMesh;
  private ring: THREE.Mesh;
  private pings: THREE.Mesh[] = [];
  private pingState: { x: number; y: number; t0: number; color: number }[] = [];
  private peopleIds: number[] = [];
  private animalInfo: { sp: number; x: number; y: number; z: number }[] = [];
  private nodeInfo: { kind: NodeKind; cell: number; slot: number; x: number; y: number; z: number }[] = [];
  private bldInfo: { id: number; x: number; y: number; z: number }[] = [];
  private staticKey = '';
  private lastStatic = -1e9;
  selected: { kind: string; id: number; extra?: number } | null = null;
  static readonly MAX_PEOPLE = 9000;
  static readonly MAX_ANIMALS = 6000;

  constructor(private world: World, private pv: PlanetView) {
    const mk = (g: THREE.BufferGeometry, mat: THREE.Material, n: number) => {
      const m = new THREE.InstancedMesh(g, mat, n);
      m.frustumCulled = false;
      m.count = 0;
      this.group.add(m);
      return m;
    };
    const lam = () => new THREE.MeshLambertMaterial({ color: 0xffffff });
    const capsule = new THREE.CapsuleGeometry(0.28, 0.9, 2, 5);
    capsule.translate(0, 0.7, 0);
    this.people = mk(capsule, lam(), EntityLayer.MAX_PEOPLE);
    const cargoG = new THREE.BoxGeometry(0.6, 0.45, 0.6);
    cargoG.translate(0, 1.95, 0);
    this.cargo = mk(cargoG, lam(), EntityLayer.MAX_PEOPLE);
    const cone = new THREE.ConeGeometry(0.5, 1.2, 5);
    cone.translate(0, 0.6, 0);
    this.animals = mk(cone, lam(), EntityLayer.MAX_ANIMALS);
    const marker = new THREE.ConeGeometry(0.6, 2, 6);
    marker.translate(0, 1, 0);
    this.markers = mk(marker, new THREE.MeshBasicMaterial({ color: 0xffffff }), 2000);
    const trunk = new THREE.CylinderGeometry(0.07, 0.1, 0.7, 5);
    trunk.translate(0, 0.35, 0);
    this.trunks = mk(trunk, new THREE.MeshLambertMaterial({ color: 0x5b4330 }), 14000);
    const crown = new THREE.ConeGeometry(0.42, 1.3, 6);
    crown.translate(0, 1.15, 0);
    this.crowns = mk(crown, lam(), 14000);
    const bush = new THREE.IcosahedronGeometry(0.5, 0);
    bush.translate(0, 0.3, 0);
    this.bushes = mk(bush, lam(), 3000);
    const rock = new THREE.DodecahedronGeometry(0.5, 0);
    rock.scale(1, 0.6, 1);
    rock.translate(0, 0.25, 0);
    this.rocks = mk(rock, lam(), 2500);
    const ore = new THREE.OctahedronGeometry(0.5, 0);
    ore.translate(0, 0.4, 0);
    this.ores = mk(ore, new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x111111 }), 1500);
    const wall = new THREE.BoxGeometry(1, 1, 1);
    wall.translate(0, 0.5, 0);
    this.walls = mk(wall, lam(), 7000);
    const roof = new THREE.ConeGeometry(0.78, 0.55, 4);
    roof.rotateY(Math.PI / 4);
    roof.translate(0, 1.27, 0);
    this.roofs = mk(roof, lam(), 7000);
    const field = new THREE.PlaneGeometry(1, 1);
    field.rotateX(-Math.PI / 2);
    this.fields = mk(field, lam(), 5000);
    (this.fields.material as THREE.MeshLambertMaterial).side = THREE.DoubleSide;
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
    world.bus.on('*', (e) => {
      if (e.weight >= 2 && e.x !== undefined && e.y !== undefined) this.ping(e.x, e.y, ['DISASTER', 'BATTLE', 'REVOLT', 'WAR', 'INVASION'].includes(e.type) ? 0xff6b5a : e.type === 'TECHNOLOGY_DISCOVERY' ? 0x9be8ff : 0xffd27a);
    });
  }

  ping(x: number, y: number, color: number) {
    this.pingState.push({ x, y, t0: performance.now(), color });
    if (this.pingState.length > 6) this.pingState.shift();
  }

  private place(x: number, y: number, lift: number, out: THREE.Vector3, n: THREE.Vector3) {
    CameraRig.dir(lonOfX(x), latOfY(y), n);
    out.copy(n).multiplyScalar(this.pv.groundRadius(x, y) + lift + 0.002);
  }

  personPos(p: { x: number; y: number; px: number; py: number }, alpha: number, out: THREE.Vector3, n: THREE.Vector3) {
    let dx = p.x - p.px;
    if (dx > W / 2) dx -= W;
    if (dx < -W / 2) dx += W;
    this.place(p.px + dx * alpha, p.py + (p.y - p.py) * alpha, 0, out, n);
  }

  update(cam: CameraRig, camera: THREE.PerspectiveCamera, alpha: number, time: number, renderDay: number) {
    const w = this.world;
    const alt = cam.alt;
    const camPos = camera.position;
    // ---- settlement markers (visible from orbit) ----
    let mi = 0;
    const markScale = Math.max(0.35, alt * 0.0042);
    if (alt > 18) {
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

    this.staticLayer(cam, camera, renderDay);

    // ---- people (with what they are carrying) ----
    let pi = 0;
    this.peopleIds.length = 0;
    const personScale = Math.min(6, Math.max(0.0105, alt * 0.0075));
    const maxDist = alt * 4 + 40;
    let ci = 0;
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
        if (p.cargoAmt > 0.5 && ci < EntityLayer.MAX_PEOPLE) {
          const col = p.cargo === 'food' ? 0xd9b45a : p.cargo === 'wood' ? 0x8a5a2b : p.cargo === 'stone' ? 0x8b8b8b : p.cargo === 'clay' ? 0xb85a3a : p.cargo === 'gold' ? 0xf0c53a : p.cargo === 'metal' ? 0xb0b8c4 : 0x555566;
          tmpC.setHex(col);
          tmpS.setScalar(s * (0.7 + Math.min(1, p.cargoAmt / 24) * 0.8));
          tmpM.compose(tmpP, tmpQ, tmpS);
          this.cargo.setMatrixAt(ci, tmpM);
          this.cargo.setColorAt(ci, tmpC);
          ci++;
        }
      }
    }
    this.people.count = pi;
    this.cargo.count = ci;
    for (const m of [this.people, this.cargo]) { m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; }

    // ---- wildlife: the very same animals the hunters chase ----
    let ai = 0;
    this.animalInfo.length = 0;
    if (alt < 1400) {
      const eco = w.eco;
      const vis = alt * 5 + 80;
      for (const pop of eco.pops.values()) {
        if (ai >= EntityLayer.MAX_ANIMALS) break;
        const cells = eco.regionCells[pop.r];
        if (!cells.length) continue;
        const rx = (pop.r % RW) * RF + RF / 2;
        const ry = Math.floor(pop.r / RW) * RF + RF / 2;
        this.place(rx, ry, 0, tmpP, tmpN);
        if (tmpP.distanceToSquared(camPos) > (vis + 80) * (vis + 80)) continue;
        const sp = eco.speciesById(pop.sp);
        const k = eco.markerCount(pop);
        for (let m = 0; m < k && ai < EntityLayer.MAX_ANIMALS; m++) {
          const pos = eco.markerPos(pop, m, renderDay);
          if (!pos) continue;
          this.place(pos.x, pos.y, 0, tmpP, tmpN);
          if (tmpP.distanceToSquared(camPos) > vis * vis) continue;
          const ph = ((mix32(mix32(pop.sp, pop.r), m) >>> 3) % 628) / 100;
          tmpQ.setFromUnitVectors(Y, tmpN);
          tmpQ2.setFromAxisAngle(tmpN, ph + Math.sin(renderDay * 40 + ph) * 0.2);
          tmpQ.premultiply(tmpQ2);
          const size = (0.5 + 0.28 * Math.log(1 + pop.t.size * 2)) * personScale * (sp.diet === 'carn' ? 1.1 : 1);
          tmpS.set(size, size, size);
          tmpM.compose(tmpP, tmpQ, tmpS);
          this.animals.setMatrixAt(ai, tmpM);
          hsl(sp.hue, sp.diet === 'carn' ? 0.7 : 0.45, sp.diet === 'carn' ? 0.36 : sp.diet === 'omni' ? 0.45 : 0.55);
          this.animals.setColorAt(ai, tmpC);
          this.animalInfo[ai] = { sp: sp.id, x: tmpP.x, y: tmpP.y, z: tmpP.z };
          ai++;
        }
      }
    }
    this.animals.count = ai;
    this.animals.instanceMatrix.needsUpdate = true;
    if (this.animals.instanceColor) this.animals.instanceColor.needsUpdate = true;

    this.updateRing(cam, alpha, time);
    this.updatePings(cam);
  }

  /** Trees, bushes, rocks, ore, buildings and fields near the camera. Rebuilt a few times a second, not every frame. */
  private staticLayer(cam: CameraRig, camera: THREE.PerspectiveCamera, renderDay: number) {
    const w = this.world;
    const alt = cam.alt;
    const clear = () => { for (const m of [this.trunks, this.crowns, this.bushes, this.rocks, this.ores, this.walls, this.roofs, this.fields]) m.count = 0; this.nodeInfo.length = 0; this.bldInfo.length = 0; };
    if (alt > 90) { clear(); this.staticKey = ''; return; }
    const now = performance.now();
    const key = `${Math.round(cam.lon * 400)}:${Math.round(cam.lat * 400)}:${Math.round(Math.log(alt) * 3)}`;
    if (key === this.staticKey && now - this.lastStatic < 1800) return;
    this.staticKey = key;
    this.lastStatic = now;
    const rangeKm = Math.max(7, Math.min(60, alt * 3 + 6));
    const scaleUp = Math.max(1, alt / 5);
    const camX = ((cam.lon + Math.PI) / (Math.PI * 2)) * W;
    const camY = ((Math.PI / 2 - cam.lat) / Math.PI) * H;
    const kx = kmPerCellX(camY);
    const cr = Math.ceil(rangeKm / 24) + 1;
    const counts = { tree: 0, crown: 0, bush: 0, rock: 0, ore: 0 };
    this.nodeInfo.length = 0;
    this.bldInfo.length = 0;
    const cells: { cell: number; d: number; dx: number; cy: number }[] = [];
    for (let dy = -cr; dy <= cr; dy++) {
      const cy = Math.floor(camY) + dy;
      if (cy < 0 || cy >= H) continue;
      for (let dx = -Math.ceil(cr * (24 / Math.max(6, kx))); dx <= Math.ceil(cr * (24 / Math.max(6, kx))); dx++) {
        const cx = ((Math.floor(camX) + dx) % W + W) % W;
        const cell = idx(cx, cy);
        if (w.planet.ocean[cell]) continue;
        cells.push({ cell, d: Math.hypot(dx * kx, dy * 24.5), dx, cy });
      }
    }
    cells.sort((a, b) => a.d - b.d);
    const day = renderDay;
    for (const c of cells) {
      if (c.d > rangeKm + 20) break;
      const list = w.res.nodes(c.cell);
      for (const n of list) {
        const nx = Math.floor(camX) + c.dx + (n.x - Math.floor(n.x));
        const dKm = Math.hypot((nx - camX) * kx, (n.y - camY) * 24.5);
        if (dKm > rangeKm) continue;
        const amt = w.res.amount(c.cell, n.slot, day);
        const frac = amt / n.max;
        this.place(n.x, n.y, 0, tmpP, tmpN);
        tmpQ.setFromUnitVectors(Y, tmpN);
        if (n.kind === 'tree') {
          const sp = w.flora.at(Math.floor(c.cy / RF) * RW + Math.floor((c.cell % W) / RF));
          const k = Math.min(48, Math.ceil(frac * n.max / 4));
          const rr = new Rng(mix32(c.cell, n.slot + 91));
          for (let i = 0; i < k && counts.tree < 13500; i++) {
            const a = rr.next() * Math.PI * 2;
            const d = Math.sqrt(rr.next()) * (0.25 + 0.004 * n.max);
            const tx = n.x + (Math.cos(a) * d) / kx;
            const ty = n.y + (Math.sin(a) * d) / 24.5;
            this.place(tx, ty, 0, tmpP, tmpN);
            tmpQ.setFromUnitVectors(Y, tmpN);
            const h = (0.011 + rr.next() * 0.007) * Math.min(scaleUp, 6) * (0.6 + 0.4 * (sp.growYears / 60));
            tmpS.set(h, h, h);
            tmpM.compose(tmpP, tmpQ, tmpS);
            this.trunks.setMatrixAt(counts.tree, tmpM);
            hsl(sp.hue + (rr.next() - 0.5) * 0.03, 0.5, 0.2 + rr.next() * 0.1);
            this.crowns.setMatrixAt(counts.tree, tmpM);
            this.crowns.setColorAt(counts.tree, tmpC);
            counts.tree++;
          }
          this.nodeInfo.push({ kind: 'tree', cell: c.cell, slot: n.slot, x: tmpP.x, y: tmpP.y, z: tmpP.z });
          continue;
        }
        const s0 = Math.min(scaleUp, 6);
        if (n.kind === 'bush' && counts.bush < 2900) {
          const k = frac > 0.1 ? 1 : 0;
          if (!k) continue;
          tmpS.set(0.006 * s0, 0.005 * s0 * (0.4 + frac * 0.6), 0.006 * s0);
          tmpM.compose(tmpP, tmpQ, tmpS);
          this.bushes.setMatrixAt(counts.bush, tmpM);
          tmpC.setHSL(0.33, 0.45, 0.25).lerp(new THREE.Color(0xb5203a), frac > 0.5 ? (frac - 0.5) : 0);
          this.bushes.setColorAt(counts.bush, tmpC);
          counts.bush++;
        } else if ((n.kind === 'stone' || n.kind === 'clay') && counts.rock < 2400) {
          const size = (n.kind === 'stone' ? 0.012 : 0.008) * s0 * (0.5 + frac * 0.5);
          tmpS.set(size, size * (n.kind === 'clay' ? 0.35 : 1), size);
          tmpM.compose(tmpP, tmpQ, tmpS);
          this.rocks.setMatrixAt(counts.rock, tmpM);
          tmpC.setHex(n.kind === 'stone' ? 0x8d8d92 : 0xa8553a);
          this.rocks.setColorAt(counts.rock, tmpC);
          counts.rock++;
        } else if (ORE_COLOR[n.kind] !== undefined && counts.ore < 1400) {
          if (!w.res.known.size || ![...w.res.known.values()].some((set) => set.has(c.cell * 64 + n.slot))) continue;
          const size = 0.008 * s0 * (0.5 + frac * 0.5);
          tmpS.set(size, size * 1.2, size);
          tmpM.compose(tmpP, tmpQ, tmpS);
          this.ores.setMatrixAt(counts.ore, tmpM);
          tmpC.setHex(ORE_COLOR[n.kind]!);
          this.ores.setColorAt(counts.ore, tmpC);
          counts.ore++;
        } else continue;
        this.nodeInfo.push({ kind: n.kind, cell: c.cell, slot: n.slot, x: tmpP.x, y: tmpP.y, z: tmpP.z });
      }
    }
    // ---- buildings & fields ----
    let wi = 0, fi = 0;
    for (const s of w.activeSettlements()) {
      const dK = Math.hypot((((s.x - camX + W * 1.5) % W) - W / 2) * kx, (s.y - camY) * 24.5);
      if (dK > rangeKm + 4) continue;
      const cul = w.cultures.get(s.culture);
      for (const b of w.buildings.of(s.id)) {
        if (b.done === -2) continue;
        const def = BDEFS[b.kind];
        this.place(b.x, b.y, -0.002, tmpP, tmpN);
        tmpQ.setFromUnitVectors(Y, tmpN);
        tmpQ2.setFromAxisAngle(tmpN, b.rot);
        tmpQ.premultiply(tmpQ2);
        if (b.kind === 'field') {
          if (fi >= 4900) continue;
          const g = b.fstate === 0 ? 0 : b.fstate === 2 ? 1 : Math.min(0.95, (w.day - b.planted) / GROW_DAYS);
          const sz = def.size * Math.min(scaleUp, 2.5) * (b.done < 0 ? 0.35 + 0.65 * b.progress : 1);
          tmpS.set(sz, 1, sz);
          tmpM.compose(tmpP, tmpQ, tmpS);
          this.fields.setMatrixAt(fi, tmpM);
          if (b.fstate === 0) tmpC.setHex(0x6b5233);
          else if (b.fstate === 2) tmpC.setHSL(0.13, 0.75, 0.52);
          else tmpC.setHSL(0.28, 0.6, 0.25 + 0.2 * g).lerp(new THREE.Color(0x8a5a2b), b.weeds > 0.5 ? (b.weeds - 0.5) * 0.6 : 0);
          this.fields.setColorAt(fi, tmpC);
          fi++;
          continue;
        }
        if (wi >= 6900) continue;
        const sz = def.size * scaleUp;
        const tall = b.kind === 'temple' ? 1.7 : b.kind === 'tower' ? 2.8 : b.kind === 'stonehouse' ? 0.78 : b.kind === 'hall' ? 0.9 : b.kind === 'well' ? 0.5 : 0.6;
        const prog = b.done < 0 ? 0.15 + 0.85 * b.progress : 1;
        tmpS.set(sz, sz * tall * prog, sz);
        tmpM.compose(tmpP, tmpQ, tmpS);
        this.walls.setMatrixAt(wi, tmpM);
        const base = b.kind === 'stonehouse' || b.kind === 'temple' || b.kind === 'tower' || b.kind === 'well' || b.kind === 'smithy' ? [0.1, 0.05, 0.62] : b.kind === 'brickhouse' || b.kind === 'kiln' ? [0.04, 0.45, 0.5] : [0.09, 0.35, 0.4];
        hsl(((cul ? cul.color : 0.1) * 0.15 + base[0]) % 1, base[1], base[2]);
        this.walls.setColorAt(wi, b.done < 0 ? tmpC.clone().multiplyScalar(0.7) : tmpC);
        const roofy = HOUSING.includes(b.kind) || ['granary', 'workshop', 'market', 'hall'].includes(b.kind);
        if (roofy && b.done >= 0) {
          tmpS.set(sz, sz * tall, sz);
          tmpM.compose(tmpP, tmpQ, tmpS);
          this.roofs.setMatrixAt(wi, tmpM);
          tmpC.setHSL(b.kind === 'hut' ? 0.1 : b.kind === 'house' ? 0.06 : 0.02, 0.5, b.kind === 'hut' ? 0.38 : 0.34);
          this.roofs.setColorAt(wi, tmpC);
        } else {
          tmpS.set(0, 0, 0);
          tmpM.compose(tmpP, tmpQ, tmpS);
          this.roofs.setMatrixAt(wi, tmpM);
          this.roofs.setColorAt(wi, tmpC);
        }
        this.bldInfo.push({ id: b.id, x: tmpP.x, y: tmpP.y, z: tmpP.z });
        wi++;
      }
    }
    this.trunks.count = this.crowns.count = counts.tree;
    this.bushes.count = counts.bush;
    this.rocks.count = counts.rock;
    this.ores.count = counts.ore;
    this.walls.count = this.roofs.count = wi;
    this.fields.count = fi;
    for (const m of [this.trunks, this.crowns, this.bushes, this.rocks, this.ores, this.walls, this.roofs, this.fields]) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
    void camera;
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
    } else if (sel.kind === 'building') {
      const b = this.world.buildings.get(sel.id);
      if (b) { pos = new THREE.Vector3(); this.place(b.x, b.y, 0.05, pos, n); }
    } else if (sel.kind === 'node' && sel.extra !== undefined) {
      const node = this.world.res.nodes(sel.id)[sel.extra];
      if (node) { pos = new THREE.Vector3(); this.place(node.x, node.y, 0.05, pos, n); }
    }
    if (!pos) return;
    this.ring.visible = true;
    this.ring.position.copy(pos);
    this.ring.quaternion.setFromUnitVectors(Z, n);
    const base = Math.max(0.05, cam.alt * 0.012) * (sel.kind === 'settlement' ? 2.2 : sel.kind === 'person' ? 1 : 1.6);
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
      m.quaternion.setFromUnitVectors(Z, n);
      m.scale.setScalar((6 + t * 40) * Math.max(1, cam.alt / 800));
      const mat = m.material as THREE.MeshBasicMaterial;
      mat.color.setHex(st.color);
      mat.opacity = 0.9 * (1 - t);
    }
  }

  /** Nearest thing to a screen position (the observer never commands, only inspects). */
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
    const consider = (kind: Pick['kind'], id: number, p: THREE.Vector3, k: number, extra?: number) => {
      const q = proj(p.clone());
      if (!q) return;
      const d = (q.x - sx) ** 2 + (q.y - sy) ** 2;
      if (d < bd * k) { bd = d / k; best = { kind, id, sx: q.x, sy: q.y, extra }; }
    };
    for (const s of w.activeSettlements()) {
      this.place(s.x, s.y, 0.3, v, n);
      if (n.dot(camN) < 0.05) continue;
      consider('settlement', s.id, v, 1.8);
    }
    for (const nd of this.nodeInfo) consider('node', nd.cell, v.set(nd.x, nd.y, nd.z), 0.55, nd.slot);
    for (const b of this.bldInfo) consider('building', b.id, v.set(b.x, b.y, b.z), 0.8);
    for (let i = 0; i < this.peopleIds.length; i++) {
      const p = w.people.get(this.peopleIds[i]);
      if (!p || !p.alive) continue;
      this.personPos(p, alpha, v, n);
      consider('person', p.id, v, 1);
    }
    const cur = best as Pick | null;
    if (!cur || cur.kind !== 'person') for (const a of this.animalInfo) consider('animal', a.sp, v.set(a.x, a.y, a.z), 0.9);
    return best;
  }
}
void NR;
