import * as THREE from 'three';
import type { SimClient } from '../client';
import { H, R_KM, W, lonOfX, latOfY } from '../sim/grid';
import { CameraRig, ALT_MAX } from './camera';
import { Terrain, CITY_SLOTS } from './terrain';
import { Fields } from './fields';
import { SkyLayer } from './sky';
import { WeatherFx } from './weatherfx';
import { Entities, type Pickable } from './entities';

export type FollowTarget = { kind: 'person'; id: number } | { kind: 'settlement'; id: number } | { kind: 'civ'; id: number } | { kind: 'point'; x: number; y: number };
export interface Bookmark { name: string; lon: number; lat: number; alt: number; yaw: number; pitch: number }
export type Pick = { kind: 'person' | 'settlement' | 'animal' | 'node' | 'building' | 'body'; id: number; extra?: number };

/**
 * The observer's eye. Reads snapshots from the simulation worker and draws them; it can never change the world.
 * One scale everywhere: a person is 1.7 m tall whether you stand beside them or look down from orbit.
 */
export class ObserverView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(55, 1, 1e-5, 2e12);
  readonly rig = new CameraRig();
  fields!: Fields;
  terrain!: Terrain;
  sky!: SkyLayer;
  weather!: WeatherFx;
  entities!: Entities;
  private sunLight = new THREE.DirectionalLight(0xfff2d9, 2.4);
  private hemi = new THREE.HemisphereLight(0x9ab8e8, 0x3a3428, 0.6);
  visualPhase = 0.9;
  private clock = 0;
  follow: FollowTarget | null = null;
  onPick: ((p: Pick | null) => void) | null = null;
  onUserMove: (() => void) | null = null;
  private keys = new Set<string>();
  private drag: { x: number; y: number; button: number; moved: number } | null = null;
  private labels: HTMLElement[] = [];
  private marker: HTMLElement;
  private pings: { x: number; y: number; t0: number; color: string; el: HTMLElement }[] = [];
  private lastCamSend = 0;
  private terrainVersion = 0;
  private lastDrawn = '';
  selected: { kind: string; id: number; extra?: number } | null = null;
  private dust = 1;
  private lastPhase = 0;
  /** keep a chosen sun position while paused (used for stills) */
  holdPhase = false;

  constructor(private c: SimClient, readonly canvas: HTMLCanvasElement, private labelLayer: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', logarithmicDepthBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.scene.add(this.sunLight, this.sunLight.target, this.hemi);
    this.marker = document.createElement('div');
    this.marker.className = 'selmark';
    labelLayer.appendChild(this.marker);
    this.bindInput();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  init() {
    this.fields = new Fields(this.c);
    this.terrain = new Terrain(this.c, this.fields);
    this.sky = new SkyLayer(this.c);
    this.weather = new WeatherFx(this.c, this.fields);
    this.entities = new Entities(this.c, this.terrain);
    this.scene.add(this.sky.group, this.terrain.group, this.weather.group, this.entities.group);
    this.c.onEvent.push((e) => {
      if (e.weight >= 2 && e.x !== undefined && e.y !== undefined) this.ping(e.x, e.y, ['DISASTER', 'BATTLE', 'REVOLT', 'WAR', 'INVASION'].includes(e.type) ? '#ff6b5a' : e.type === 'TECHNOLOGY_DISCOVERY' || e.type === 'DISCOVERY' ? '#9be8ff' : '#ffd27a');
    });
  }

  get politics() { return this.fields.politicsOn; }
  set politics(v: boolean) { this.fields.politicsOn = v; this.fields.politicalMap(); }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ----- camera helpers
  flyToCell(x: number, y: number, alt?: number, yaw?: number, pitch?: number) {
    this.follow = null;
    this.rig.flyTo({ lon: lonOfX(x), lat: latOfY(y), alt, yaw, pitch });
  }
  setFollow(t: FollowTarget | null, alt?: number) {
    this.follow = t;
    if (!t) { this.rig.follow = null; this.c.follow(null, false); return; }
    this.rig.cancelFly();
    if (alt !== undefined) this.rig.flyTo({ lon: this.rig.lon, lat: this.rig.lat, alt });
    this.rig.follow = () => {
      const p = this.followPos();
      return p ? { lon: lonOfX(p.x), lat: latOfY(p.y) } : null;
    };
  }
  followPos(): { x: number; y: number } | null {
    const t = this.follow;
    if (!t) return null;
    if (t.kind === 'point') return { x: t.x, y: t.y };
    const f = this.c.snap?.follow;
    if (f && f.kind === t.kind && f.id === t.id) {
      const a = this.c.alpha();
      let dx = f.x - f.px;
      if (dx > W / 2) dx -= W;
      if (dx < -W / 2) dx += W;
      return { x: f.px + dx * a, y: f.py + (f.y - f.py) * a };
    }
    if (t.kind === 'settlement') { const s = this.c.settlementById.get(t.id); return s ? { x: s.x, y: s.y } : null; }
    return null;
  }
  currentBookmark(name: string): Bookmark {
    return { name, lon: this.rig.lon, lat: this.rig.lat, alt: this.rig.alt, yaw: this.rig.yaw, pitch: this.rig.pitch };
  }
  gotoBookmark(b: Bookmark) {
    this.follow = null;
    this.rig.follow = null;
    this.rig.flyTo({ lon: b.lon, lat: b.lat, alt: b.alt, yaw: b.yaw, pitch: b.pitch });
  }

  // ----- input
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
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      d.x = e.clientX; d.y = e.clientY;
      d.moved += Math.abs(dx) + Math.abs(dy);
      if (d.button === 2 || e.shiftKey || e.ctrlKey) this.rig.rotate(dx * 0.006, -dy * 0.005);
      else if (d.moved > 3) {
        this.rig.panPixels(dx, dy, c.clientHeight, this.camera.fov);
        if (this.follow) { this.setFollow(null); }
        this.onUserMove?.();
      }
    });
    c.addEventListener('pointerup', (e) => {
      const d = this.drag;
      this.drag = null;
      if (d && d.moved < 5 && d.button === 0) {
        const r = c.getBoundingClientRect();
        this.onPick?.(this.pick(e.clientX - r.left, e.clientY - r.top));
      }
    });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.rig.zoom(Math.exp(e.deltaY * 0.0014));
    }, { passive: false });
    window.addEventListener('keydown', (e) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      this.keys.add(e.key.toLowerCase());
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());
  }
  private keyboard(dt: number) {
    const k = this.keys;
    if (!k.size) return;
    const step = 260 * dt;
    let dx = 0, dy = 0;
    if (k.has('a') || k.has('arrowleft')) dx += step;
    if (k.has('d') || k.has('arrowright')) dx -= step;
    if (k.has('w') || k.has('arrowup')) dy += step;
    if (k.has('s') || k.has('arrowdown')) dy -= step;
    if (dx || dy) { this.rig.panPixels(dx, dy, this.canvas.clientHeight, this.camera.fov); if (this.follow) this.setFollow(null); this.onUserMove?.(); }
    if (k.has('q')) this.rig.rotate(-1.4 * dt, 0);
    if (k.has('e')) this.rig.rotate(1.4 * dt, 0);
    if (k.has('r')) this.rig.zoom(Math.exp(-1.8 * dt));
    if (k.has('f')) this.rig.zoom(Math.exp(1.8 * dt));
    if (k.has('t')) this.rig.rotate(0, 0.9 * dt);
    if (k.has('g')) this.rig.rotate(0, -0.9 * dt);
  }

  /** Called every frame. */
  frame(dt: number) {
    const c = this.c;
    const now = performance.now();
    const day = c.renderDay(now);
    const alpha = c.alpha(now);
    const dps = c.daysPerSec;
    this.clock += c.paused ? dt * 0.15 : dt;
    // the sun: its true position when time runs slowly enough to follow; a held afternoon when days would strobe
    if (dps <= 0.5 && !(c.paused && this.holdPhase)) this.visualPhase = -Math.PI * 2 * (day - Math.floor(day));
    else if (!c.paused) {
      let d = this.rig.lon - 0.7 - this.visualPhase;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.visualPhase += d * (1 - Math.exp(-dt * 1.2));
    }
    // in deep space the camera turns with the stars, not with the spinning planet beneath it
    if (this.rig.alt > 60000 && !this.follow) {
      let d = this.visualPhase - this.lastPhase;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.rig.lon += d;
    }
    this.lastPhase = this.visualPhase;
    this.keyboard(dt);
    this.rig.update(dt);
    this.sky.heavens.update(day, this.visualPhase);
    const sunTarget = this.sky.heavens.place(0, 0, 0);
    this.rig.apply(this.camera, (x, y, z) => this.terrain.heightAt(x, y, z), this.rig.alt > 3e6 ? sunTarget : null);
    this.camera.updateMatrixWorld();
    const cam = this.rig.pos;
    const origin: [number, number, number] = [cam[0], cam[1], cam[2]];
    const camH = this.rig.height;
    // ---- tell the simulation where the observer is looking (for detail and for what it sends back)
    const tgt = this.rig.target;
    const tr = Math.hypot(tgt[0], tgt[1], tgt[2]) || 1;
    const tx = ((Math.atan2(tgt[2], tgt[0]) + Math.PI) / (Math.PI * 2)) * W, ty = ((Math.PI / 2 - Math.asin(tgt[1] / tr)) / Math.PI) * H;
    if (now - this.lastCamSend > 200) {
      this.lastCamSend = now;
      const km = Math.max(3, Math.min(60, this.rig.alt * 2.5 + 3));
      c.camera(this.follow && this.follow.kind === 'person' ? (this.followPos()?.x ?? tx) : tx, this.follow && this.follow.kind === 'person' ? (this.followPos()?.y ?? ty) : ty, km, this.rig.alt);
    }
    // ---- lighting at the observer
    const sd = this.sky.heavens.sunDir;
    const up = [cam[0] / Math.hypot(...cam), cam[1] / Math.hypot(...cam), cam[2] / Math.hypot(...cam)];
    const sunUp = up[0] * sd[0] + up[1] * sd[1] + up[2] * sd[2];
    this.dust = 1; // the worker's dust is folded into weather; keep a gentle constant here
    const sunVis = Math.max(0, Math.min(1, (sunUp + 0.03) / 0.09));
    this.sunLight.position.set(sd[0], sd[1], sd[2]);
    this.sunLight.target.position.set(0, 0, 0);
    this.sunLight.intensity = 2.6 * sunVis * (1 - 0.5 * this.weather.local.cloud * Math.min(1, Math.max(0, 3 - camH)));
    this.sunLight.color.setRGB(1, 0.6 + 0.4 * Math.min(1, Math.max(0, sunUp / 0.3)), 0.4 + 0.55 * Math.min(1, Math.max(0, sunUp / 0.3)));
    const dayAmb = Math.max(0, Math.min(1, (sunUp + 0.12) / 0.3));
    this.hemi.intensity = 0.05 + 0.85 * dayAmb + this.weather.flash * 1.2;
    this.hemi.position.set(up[0], up[1], up[2]);
    // ---- layers
    this.fields.update(day);
    this.setCities(tgt);
    const tu = this.terrain.material.uniforms, wu = this.terrain.waterMaterial.uniforms;
    for (const u of [tu, wu]) { u.uSun.value.set(sd[0], sd[1], sd[2]); u.uTime.value = this.clock; u.uCamH.value = camH; u.uDust.value = this.dust; u.uFlash.value = this.weather.flash; }
    tu.uPolOn.value = this.fields.politicsOn ? 1 : 0;
    this.terrain.update(cam, origin);
    const drawnKey = `${this.terrain.stats.drawn}:${this.terrain.stats.cached}`;
    if (drawnKey !== this.lastDrawn) { this.lastDrawn = drawnKey; this.terrainVersion++; }
    this.sky.update(this.camera, day, this.visualPhase, cam, this.rig.alt, this.dust, this.weather.flash);
    const viewH = this.canvas.clientHeight / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
    this.weather.update(dt, this.clock, day, cam, camH, sd, this.dust, viewH);
    this.entities.selected = this.selected;
    this.entities.update(cam, tgt, origin, day, alpha, this.clock, this.rig.alt, Math.floor(this.terrainVersion / 3));
    this.renderer.render(this.scene, this.camera);
    this.updateLabels(origin);
  }

  /** The nearest towns to the observer, for the ground shader (pavements, roofs, street light). */
  private setCities(tgt: [number, number, number]) {
    const list: { dir: [number, number, number]; r: number; lights: number; hue: number; d: number }[] = [];
    for (const s of this.c.settlements) {
      const lon = lonOfX(s.x), lat = latOfY(s.y), cl = Math.cos(lat);
      const dir: [number, number, number] = [cl * Math.cos(lon), Math.sin(lat), cl * Math.sin(lon)];
      const d = Math.hypot(dir[0] * R_KM - tgt[0], dir[1] * R_KM - tgt[1], dir[2] * R_KM - tgt[2]);
      list.push({ dir, r: 0.05 + Math.sqrt(s.pop) * 0.012 * (s.nomadic ? 0.4 : 1), lights: s.lights * Math.min(1, s.pop / 150), hue: s.hue, d });
    }
    list.sort((a, b) => a.d - b.d);
    this.terrain.setCities(list.slice(0, CITY_SLOTS));
  }

  private project(p: [number, number, number], origin: [number, number, number], out: { x: number; y: number; z: number }): boolean {
    const v = new THREE.Vector3(p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]);
    // behind the planet?
    const toCam = new THREE.Vector3(origin[0] - p[0], origin[1] - p[1], origin[2] - p[2]);
    const r = Math.hypot(p[0], p[1], p[2]);
    if (r < R_KM * 1.5) {
      const upDot = (toCam.x * p[0] + toCam.y * p[1] + toCam.z * p[2]) / (r * toCam.length());
      if (upDot < -0.02 && toCam.length() > 3) return false;
    }
    v.project(this.camera);
    if (v.z > 1 || v.z < -1) return false;
    out.x = (v.x * 0.5 + 0.5) * this.canvas.clientWidth;
    out.y = (-v.y * 0.5 + 0.5) * this.canvas.clientHeight;
    out.z = v.z;
    return Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
  }

  /** Nearest thing to a screen position (the observer inspects; it never commands). */
  pick(sx: number, sy: number): Pick | null {
    const origin = this.rig.pos;
    const o = { x: 0, y: 0, z: 0 };
    let best: Pick | null = null;
    let bd = 22 * 22;
    const weight: Record<string, number> = { person: 1, animal: 0.8, building: 0.9, node: 0.6, settlement: this.rig.alt > 30 ? 2.2 : 0.35 };
    const consider = (pk: Pickable) => {
      if (!this.project(pk.p, origin, o)) return;
      const d = ((o.x - sx) ** 2 + (o.y - sy) ** 2) / (weight[pk.kind] ?? 1);
      if (d < bd) { bd = d; best = { kind: pk.kind, id: pk.id, extra: pk.extra }; }
    };
    for (const pk of this.entities.pickables) consider(pk);
    if (this.rig.alt > 20000) for (const b of this.sky.bodyPos) {
      if (!this.project(b.p, origin, o)) continue;
      const d = (o.x - sx) ** 2 + (o.y - sy) ** 2;
      if (d < bd) { bd = d; best = { kind: 'body', id: b.index }; }
    }
    return best;
  }

  ping(x: number, y: number, color: string) {
    const el = document.createElement('div');
    el.className = 'ping';
    el.style.borderColor = color;
    this.labelLayer.appendChild(el);
    this.pings.push({ x, y, t0: performance.now(), color, el });
    if (this.pings.length > 8) this.pings.shift()!.el.remove();
  }

  private updateLabels(origin: [number, number, number]) {
    const alt = this.rig.alt;
    const vw = this.canvas.clientWidth, vh = this.canvas.clientHeight;
    const out: { s: string; x: number; y: number; w: number; cls: string }[] = [];
    const o = { x: 0, y: 0, z: 0 };
    const g = (x: number, y: number, lift: number) => this.entities.ground(x, y, lift, [0, 0, 0]);
    if (alt < 60000) {
      const minPop = alt > 9000 ? 400 : alt > 3000 ? 120 : alt > 600 ? 30 : alt > 60 ? 8 : 0;
      for (const s of this.c.settlements) {
        if (s.pop < minPop) continue;
        if (!this.project(g(s.x, s.y, 0.03), origin, o)) continue;
        out.push({ s: s.name, x: o.x, y: o.y, w: s.pop + (s.capital ? 5000 : 0), cls: s.capital ? 'label cap' : 'label' });
      }
    }
    if (alt > 30000) {
      for (const b of this.sky.bodyPos) {
        if (!this.project(b.p, origin, o)) continue;
        out.push({ s: b.name, x: o.x, y: o.y + 10, w: 1e6, cls: 'label body' });
      }
      if (alt > 3e6 && this.project(this.sky.heavens.place(0, 0, 0), origin, o)) out.push({ s: 'The sun', x: o.x, y: o.y + 10, w: 2e6, cls: 'label body' });
      if (alt > 3e6 && this.project([0, 0, 0], origin, o)) out.push({ s: 'Home', x: o.x, y: o.y + 10, w: 2e6, cls: 'label body' });
    }
    out.sort((a, b) => b.w - a.w);
    const show = out.slice(0, 30);
    while (this.labels.length < show.length) {
      const el = document.createElement('div');
      this.labelLayer.appendChild(el);
      this.labels.push(el);
    }
    for (let i = 0; i < this.labels.length; i++) {
      const el = this.labels[i];
      const l = show[i];
      if (!l) { el.style.display = 'none'; continue; }
      el.style.display = 'block';
      el.className = l.cls;
      el.style.transform = `translate(${l.x.toFixed(0)}px, ${(l.y - 12).toFixed(0)}px) translate(-50%,-100%)`;
      if (el.textContent !== l.s) el.textContent = l.s;
    }
    // selection marker (a screen-space ring: an interface mark, not part of the world)
    const sel = this.selected;
    let pos: [number, number, number] | null = null;
    if (sel) {
      if (sel.kind === 'person') pos = this.entities.personPos.get(sel.id) ?? null;
      else if (sel.kind === 'settlement') { const s = this.c.settlementById.get(sel.id); if (s) pos = g(s.x, s.y, 0.01); }
      else { const pk = this.entities.pickables.find((p) => p.kind === sel.kind && p.id === sel.id && (p.extra ?? 0) === (sel.extra ?? 0)); if (pk) pos = pk.p; }
      if (!pos && sel.kind === 'person' && this.follow?.kind === 'person' && this.follow.id === sel.id) { const f = this.followPos(); if (f) pos = g(f.x, f.y, 0.001); }
    }
    if (pos && this.project(pos, origin, o)) {
      this.marker.style.display = 'block';
      const size = sel?.kind === 'settlement' ? 46 : 28;
      this.marker.style.transform = `translate(${(o.x - size / 2).toFixed(0)}px, ${(o.y - size / 2 - 6).toFixed(0)}px)`;
      this.marker.style.width = this.marker.style.height = size + 'px';
    } else this.marker.style.display = 'none';
    // event pings
    const now = performance.now();
    this.pings = this.pings.filter((p) => { if (now - p.t0 > 6500) { p.el.remove(); return false; } return true; });
    for (const p of this.pings) {
      const t = (now - p.t0) / 6500;
      if (!this.project(g(p.x, p.y, 0.05), origin, o)) { p.el.style.display = 'none'; continue; }
      const size = 12 + t * 90;
      p.el.style.display = 'block';
      p.el.style.width = p.el.style.height = size + 'px';
      p.el.style.transform = `translate(${(o.x - size / 2).toFixed(0)}px, ${(o.y - size / 2).toFixed(0)}px)`;
      p.el.style.opacity = String(0.9 * (1 - t));
    }
    void vw; void vh;
  }
}
void ALT_MAX;
