import * as THREE from 'three';
import type { World } from '../sim/world';
import { R_KM, W, lonOfX, latOfY } from '../sim/grid';
import { declination } from '../sim/time';
import { CameraRig, ALT_MAX, ALT_MIN } from './camera';
import { PlanetView } from './planetView';
import { EntityLayer, Pick } from './entities';
import { glowSprite, starfield } from './materials';
import { RiverLayer } from './rivers';

export const SUN_DIST = 70000;
export const SUN_RADIUS = 5200;
export const MOON_DIST = 5200;
export const MOON_RADIUS = 260;

export type FollowTarget = { kind: 'person'; id: number } | { kind: 'settlement'; id: number } | { kind: 'civ'; id: number } | { kind: 'point'; x: number; y: number };

export interface Bookmark { name: string; lon: number; lat: number; alt: number; yaw: number; pitch: number }

/** Everything that draws. Reads from the World, never writes to it. */
export class ObserverView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1e7);
  readonly rig = new CameraRig();
  planet!: PlanetView;
  entities!: EntityLayer;
  rivers!: RiverLayer;
  private sun!: THREE.Mesh;
  private sunGlow!: THREE.Sprite;
  private moon!: THREE.Mesh;
  private moonLight = new THREE.DirectionalLight(0xffffff, 2.2);
  private cometObjs: { head: THREE.Sprite; tail: THREE.Line }[] = [];
  private rock!: THREE.Sprite;
  private ambient = new THREE.AmbientLight(0x1a2338, 1.4);
  private sunLight = new THREE.DirectionalLight(0xfff2d9, 2.6);
  visualPhase = 0.9;
  private clock = 0;
  sunDir = new THREE.Vector3(1, 0, 0);
  follow: FollowTarget | null = null;
  onPick: ((p: Pick | null) => void) | null = null;
  onUserMove: (() => void) | null = null;
  private keys = new Set<string>();
  private drag: { x: number; y: number; button: number; moved: number } | null = null;
  alpha = 1;
  labelLayer: HTMLElement;
  private labels: HTMLElement[] = [];

  constructor(private world: World, readonly canvas: HTMLCanvasElement, labelLayer: HTMLElement) {
    this.labelLayer = labelLayer;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x02030a);
    this.scene.add(this.ambient, this.sunLight, this.moonLight);
    this.scene.add(starfield());
    this.sun = new THREE.Mesh(new THREE.SphereGeometry(SUN_RADIUS, 32, 24), new THREE.MeshBasicMaterial({ color: 0xfff0c0 }));
    this.sunGlow = glowSprite('rgba(255,230,170,1)');
    this.sunGlow.scale.setScalar(SUN_RADIUS * 9);
    this.moon = new THREE.Mesh(new THREE.SphereGeometry(MOON_RADIUS, 32, 24), new THREE.MeshStandardMaterial({ color: 0xaaa9a4, roughness: 1 }));
    this.scene.add(this.sun, this.sunGlow, this.moon);
    for (let i = 0; i < world.sky.comets.length; i++) {
      const head = glowSprite('rgba(190,230,255,1)');
      head.visible = false;
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, 1)]);
      g.setAttribute('color', new THREE.Float32BufferAttribute([0.7, 0.85, 1, 0, 0, 0], 3));
      const tail = new THREE.Line(g, new THREE.LineBasicMaterial({ vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
      tail.visible = false;
      this.scene.add(head, tail);
      this.cometObjs.push({ head, tail });
    }
    this.rock = glowSprite('rgba(255,170,90,1)');
    this.rock.visible = false;
    this.scene.add(this.rock);
    this.bindInput();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  async init(onProgress?: (f: number) => void) {
    this.planet = new PlanetView(this.world, this.scene);
    await this.planet.build(onProgress);
    this.rivers = new RiverLayer(this.world, this.planet);
    this.scene.add(this.rivers.mesh);
    this.entities = new EntityLayer(this.world, this.planet);
    this.scene.add(this.entities.group);
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ----- camera helpers -----
  flyToCell(x: number, y: number, alt?: number, yaw?: number, pitch?: number) {
    this.follow = null;
    this.rig.flyTo({ lon: lonOfX(x), lat: latOfY(y), alt, yaw, pitch });
  }
  setFollow(t: FollowTarget | null, alt?: number) {
    this.follow = t;
    if (!t) { this.rig.follow = null; return; }
    this.rig.cancelFly();
    if (alt !== undefined) this.rig.flyTo({ lon: this.rig.lon, lat: this.rig.lat, alt });
    this.rig.follow = () => {
      const p = this.followPos();
      return p ? { lon: lonOfX(p.x), lat: latOfY(p.y) } : null;
    };
  }
  followPos(): { x: number; y: number } | null {
    const t = this.follow;
    const w = this.world;
    if (!t) return null;
    if (t.kind === 'person') {
      const p = w.people.get(t.id);
      if (!p) return null;
      let dx = p.x - p.px;
      if (dx > W / 2) dx -= W;
      if (dx < -W / 2) dx += W;
      return { x: p.px + dx * this.alpha, y: p.py + (p.y - p.py) * this.alpha };
    }
    if (t.kind === 'settlement') {
      const s = w.settlements[t.id - 1];
      return s ? { x: s.x, y: s.y } : null;
    }
    if (t.kind === 'civ') {
      const c = w.civs[t.id - 1];
      const s = c ? w.settlements[c.capital - 1] : undefined;
      return s ? { x: s.x, y: s.y } : null;
    }
    return { x: t.x, y: t.y };
  }
  currentBookmark(name: string): Bookmark {
    return { name, lon: this.rig.lon, lat: this.rig.lat, alt: this.rig.alt, yaw: this.rig.yaw, pitch: this.rig.pitch };
  }
  gotoBookmark(b: Bookmark) {
    this.follow = null;
    this.rig.follow = null;
    this.rig.flyTo({ lon: b.lon, lat: b.lat, alt: b.alt, yaw: b.yaw, pitch: b.pitch });
  }

  // ----- input -----
  private bindInput() {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      this.drag = { x: e.clientX, y: e.clientY, button: e.button, moved: 0 };
    });
    c.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      d.x = e.clientX;
      d.y = e.clientY;
      d.moved += Math.abs(dx) + Math.abs(dy);
      if (d.button === 2 || e.shiftKey || e.ctrlKey) {
        this.rig.rotate(dx * 0.006, -dy * 0.005);
      } else if (d.moved > 3) {
        this.rig.panPixels(dx, dy, c.clientHeight, this.camera.fov);
        if (this.follow) { this.follow = null; this.rig.follow = null; }
        this.onUserMove?.();
      }
    });
    c.addEventListener('pointerup', (e) => {
      const d = this.drag;
      this.drag = null;
      if (d && d.moved < 5 && d.button === 0) {
        const r = c.getBoundingClientRect();
        const p = this.entities.pick(e.clientX - r.left, e.clientY - r.top, this.camera, r.width, r.height, this.alpha);
        this.onPick?.(p);
      }
    });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.rig.zoom(Math.exp(e.deltaY * 0.0012));
    }, { passive: false });
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA') return;
      this.keys.add(e.key.toLowerCase());
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
  }

  private keyboard(dt: number) {
    const k = this.keys;
    if (!k.size) return;
    const step = 220 * dt;
    let dx = 0, dy = 0;
    if (k.has('a') || k.has('arrowleft')) dx += step;
    if (k.has('d') || k.has('arrowright')) dx -= step;
    if (k.has('w') || k.has('arrowup')) dy += step;
    if (k.has('s') || k.has('arrowdown')) dy -= step;
    if (dx || dy) { this.rig.panPixels(dx, dy, this.canvas.clientHeight, this.camera.fov); if (this.follow) { this.follow = null; this.rig.follow = null; } this.onUserMove?.(); }
    if (k.has('q')) this.rig.rotate(-1.4 * dt, 0);
    if (k.has('e')) this.rig.rotate(1.4 * dt, 0);
    if (k.has('r')) this.rig.zoom(Math.exp(-1.6 * dt));
    if (k.has('f')) this.rig.zoom(Math.exp(1.6 * dt));
    if (k.has('t')) this.rig.rotate(0, 0.9 * dt);
    if (k.has('g')) this.rig.rotate(0, -0.9 * dt);
  }

  /** Called every frame. `renderDay` is the smoothly advancing simulation day; `daysPerSec` the current speed. */
  frame(dt: number, renderDay: number, daysPerSec: number, alpha: number, paused: boolean) {
    this.alpha = alpha;
    this.clock += paused ? 0 : dt;
    // visual day: real rotation when slow, a calm capped rate when fast
    {
      if (daysPerSec <= 0.5) this.visualPhase = -Math.PI * 2 * (renderDay - Math.floor(renderDay)); // the real sun: it sets in the west, local noon is local noon
      else if (!paused) {
        // too fast for a day/night cycle to be anything but a strobe: hold a pleasant afternoon over whatever the observer is watching
        let d = this.rig.lon - 0.7 - this.visualPhase;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        this.visualPhase += d * (1 - Math.exp(-dt * 1.2));
      }
    }
    const decl = declination(renderDay);
    const sd = this.sunDir.set(Math.cos(decl) * Math.cos(this.visualPhase), Math.sin(decl), Math.cos(decl) * Math.sin(this.visualPhase)).normalize();
    this.sun.position.copy(sd).multiplyScalar(SUN_DIST);
    this.sunGlow.position.copy(this.sun.position);
    this.sunLight.position.copy(sd).multiplyScalar(1000);
    // moon: synodic month of 29.5 days, lagging the sun
    const synodic = ((renderDay % 29.5) / 29.5) * Math.PI * 2;
    const ma = this.visualPhase - synodic;
    const incl = 0.09;
    const md = new THREE.Vector3(Math.cos(ma), Math.sin(ma - 0.4) * incl, Math.sin(ma)).normalize();
    this.moon.position.copy(md).multiplyScalar(MOON_DIST);
    this.moonLight.position.copy(sd).multiplyScalar(1000);
    this.moonLight.target.position.copy(this.moon.position);
    // sky: comets on their orbits, and a doomed asteroid in its last year
    this.world.sky.comets.forEach((c, i) => {
      const st = this.world.sky.cometState(c, renderDay);
      const o = this.cometObjs[i];
      if (!o) return;
      const pos = new THREE.Vector3(...st.dir).multiplyScalar(52000 + st.r * 20000);
      const sunwards = this.sunDir.clone();
      o.head.visible = st.bright > 0.002;
      o.tail.visible = o.head.visible;
      o.head.position.copy(pos);
      o.head.scale.setScalar(900 + 9000 * st.bright);
      (o.head.material as THREE.SpriteMaterial).opacity = Math.min(1, 0.25 + st.bright * 10);
      o.tail.position.copy(pos);
      o.tail.scale.setScalar(1);
      const away = pos.clone().sub(sunwards.multiplyScalar(60000)).normalize();
      const len = 5000 + 60000 * st.bright;
      o.tail.geometry.setFromPoints([new THREE.Vector3(), away.multiplyScalar(len)]);
      o.tail.geometry.setAttribute('color', new THREE.Float32BufferAttribute([0.7, 0.85, 1, 0, 0, 0], 3));
    });
    const ap = this.world.sky.approaching(renderDay);
    this.rock.visible = !!ap;
    if (ap) {
      const d = CameraRig.dir(lonOfX(ap.a.x), latOfY(ap.a.y));
      this.rock.position.copy(d.multiplyScalar(R_KM + 400 + Math.pow(1 - ap.t, 2) * 90000));
      this.rock.scale.setScalar(500 + ap.t * 6000);
    }
    this.keyboard(dt);
    this.rig.update(dt);
    const hgt = this.rig.apply(this.camera, (lon, lat) => this.planet.groundRadiusAt(lon, lat));
    this.planet.setLighting(sd, this.camera.position, this.rig.alt + 0 * hgt, this.clock);
    this.rivers.update(this.rig.alt, sd, this.camera.position);
    this.entities.update(this.rig, this.camera, alpha, this.clock, renderDay);
    this.updateLabels();
    this.renderer.render(this.scene, this.camera);
  }

  private updateLabels() {
    const w = this.world;
    const alt = this.rig.alt;
    const vw = this.canvas.clientWidth;
    const vh = this.canvas.clientHeight;
    const out: { s: string; x: number; y: number; pop: number; sub: string }[] = [];
    if (alt < 60000) {
      const v = new THREE.Vector3();
      const camN = this.camera.position.clone().normalize();
      for (const s of w.activeSettlements()) {
        const lon = lonOfX(s.x);
        const lat = latOfY(s.y);
        CameraRig.dir(lon, lat, v);
        if (v.dot(camN) < 0.12 && alt < R_KM * 1.5) continue;
        v.multiplyScalar(this.planet.groundRadius(s.x, s.y) + 1).project(this.camera);
        if (v.z > 1 || Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05) continue;
        const minPop = alt > 8000 ? 400 : alt > 3000 ? 120 : alt > 900 ? 40 : 0;
        if (s.pop < minPop) continue;
        out.push({ s: s.name, x: (v.x * 0.5 + 0.5) * vw, y: (-v.y * 0.5 + 0.5) * vh, pop: s.pop, sub: s.stage });
      }
      out.sort((a, b) => b.pop - a.pop);
    }
    const show = out.slice(0, 28);
    while (this.labels.length < show.length) {
      const el = document.createElement('div');
      el.className = 'label';
      this.labelLayer.appendChild(el);
      this.labels.push(el);
    }
    for (let i = 0; i < this.labels.length; i++) {
      const el = this.labels[i];
      const l = show[i];
      if (!l) { el.style.display = 'none'; continue; }
      el.style.display = 'block';
      el.style.transform = `translate(${l.x.toFixed(0)}px, ${(l.y - 14).toFixed(0)}px) translate(-50%,-100%)`;
      if (el.dataset.t !== l.s + l.sub) { el.textContent = l.s; el.dataset.t = l.s + l.sub; }
      el.style.opacity = String(Math.min(1, 0.45 + l.pop / 200));
    }
  }
}
void ALT_MAX; void ALT_MIN;
