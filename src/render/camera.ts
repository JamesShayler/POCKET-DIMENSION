import * as THREE from 'three';
import { R_KM } from '../sim/grid';
import { HS } from './planetView';

const UP_Y = new THREE.Vector3(0, 1, 0);

export interface CamGoal { lon: number; lat: number; alt?: number; yaw?: number; pitch?: number }
export const ALT_MIN = 0.45;
export const ALT_MAX = 260000;

/** A globe-aware map camera: orbits a point on the surface; zoom runs from a person's shoulder to the solar system. */
export class CameraRig {
  lon = 0.6;
  lat = 0.35;
  alt = 4200;
  yaw = 0;
  pitch = 0.4;
  private goal: CamGoal | null = null;
  private vLon = 0;
  private vLat = 0;
  follow: (() => { lon: number; lat: number } | null) | null = null;
  readonly position = new THREE.Vector3();
  readonly target = new THREE.Vector3();

  static dir(lon: number, lat: number, out = new THREE.Vector3()) {
    const c = Math.cos(lat);
    return out.set(c * Math.cos(lon), Math.sin(lat), c * Math.sin(lon));
  }
  frame(lon = this.lon, lat = this.lat) {
    const up = CameraRig.dir(lon, lat);
    let north = UP_Y.clone().sub(up.clone().multiplyScalar(up.dot(UP_Y)));
    if (north.lengthSq() < 1e-8) north.set(-1, 0, 0);
    north.normalize();
    const east = new THREE.Vector3().crossVectors(up, north).normalize();
    return { up, north, east };
  }
  flyTo(g: CamGoal) {
    this.goal = g;
    this.follow = null;
  }
  cancelFly() {
    this.goal = null;
  }
  panPixels(dx: number, dy: number, viewH: number, fov: number) {
    const kmPerPx = (Math.min(this.alt, R_KM * 3) * 2 * Math.tan((fov * Math.PI) / 360)) / viewH;
    const f = this.frame();
    const h = f.north.clone().multiplyScalar(Math.cos(this.yaw)).addScaledVector(f.east, Math.sin(this.yaw));
    const r = new THREE.Vector3().crossVectors(h, f.up).negate();
    // screen right = -cross(h, up)?  right-handed: right = cross(h, up) with up toward viewer
    const right = new THREE.Vector3().crossVectors(f.up, h).negate().negate();
    void r;
    const moveE = (-dx * right.dot(f.east) + dy * h.dot(f.east)) * kmPerPx;
    const moveN = (-dx * right.dot(f.north) + dy * h.dot(f.north)) * kmPerPx;
    this.vLat += (moveN / R_KM) * 0.9;
    this.vLon += (moveE / (R_KM * Math.max(0.12, Math.cos(this.lat)))) * 0.9;
    this.goal = null;
    this.follow = null;
  }
  rotate(dYaw: number, dPitch: number) {
    this.yaw += dYaw;
    this.pitch = Math.min(1.4, Math.max(0, this.pitch + dPitch));
  }
  zoom(factor: number) {
    this.alt = Math.min(ALT_MAX, Math.max(ALT_MIN, this.alt * factor));
    if (this.goal) this.goal.alt = undefined;
  }

  update(dt: number) {
    if (this.follow) {
      const t = this.follow();
      if (t) {
        const k = 1 - Math.exp(-dt * 4);
        let dl = t.lon - this.lon;
        if (dl > Math.PI) dl -= Math.PI * 2;
        if (dl < -Math.PI) dl += Math.PI * 2;
        this.lon += dl * k;
        this.lat += (t.lat - this.lat) * k;
      }
    }
    if (this.goal) {
      const g = this.goal;
      const k = 1 - Math.exp(-dt * 2.4);
      let dl = g.lon - this.lon;
      if (dl > Math.PI) dl -= Math.PI * 2;
      if (dl < -Math.PI) dl += Math.PI * 2;
      this.lon += dl * k;
      this.lat += (g.lat - this.lat) * k;
      if (g.alt !== undefined) this.alt *= Math.pow(g.alt / this.alt, k);
      if (g.yaw !== undefined) this.yaw += (g.yaw - this.yaw) * k;
      if (g.pitch !== undefined) this.pitch += (g.pitch - this.pitch) * k;
      if (Math.abs(dl) < 0.0004 && Math.abs(g.lat - this.lat) < 0.0004 && (g.alt === undefined || Math.abs(Math.log(g.alt / this.alt)) < 0.01)) this.goal = null;
    }
    this.lon += this.vLon;
    this.lat += this.vLat;
    const damp = Math.exp(-dt * 7);
    this.vLon *= damp;
    this.vLat *= damp;
    if (Math.abs(this.vLon) < 1e-7) this.vLon = 0;
    if (Math.abs(this.vLat) < 1e-7) this.vLat = 0;
    this.lat = Math.max(-1.5, Math.min(1.5, this.lat));
    if (this.lon > Math.PI) this.lon -= Math.PI * 2;
    if (this.lon < -Math.PI) this.lon += Math.PI * 2;
  }

  apply(cam: THREE.PerspectiveCamera, groundRadiusAt: (lon: number, lat: number) => number) {
    const { up, north, east } = this.frame();
    const hgt = groundRadiusAt(this.lon, this.lat) - R_KM;
    const T = up.clone().multiplyScalar(R_KM + hgt);
    // flatten the tilt when seen from space for a clean planetary overview
    const spaceBlend = Math.min(1, Math.max(0, (this.alt - 2500) / 18000));
    const pitch = this.pitch * (1 - spaceBlend);
    const h = north.clone().multiplyScalar(Math.cos(this.yaw)).addScaledVector(east, Math.sin(this.yaw));
    const offset = up.clone().multiplyScalar(this.alt * Math.cos(pitch) + 0.08).addScaledVector(h, -this.alt * Math.sin(pitch));
    this.position.copy(T).add(offset);
    // never dip below the terrain beneath the camera
    const pr = this.position.length();
    const pl = Math.atan2(this.position.y, Math.hypot(this.position.x, this.position.z));
    const pn = Math.atan2(this.position.z, this.position.x);
    const gr = groundRadiusAt(pn, pl) + 0.12;
    if (pr < gr) this.position.multiplyScalar(gr / pr);
    this.target.copy(T);
    cam.position.copy(this.position);
    cam.up.copy(h.multiplyScalar(Math.cos(pitch)).addScaledVector(up, Math.sin(pitch)));
    cam.lookAt(T);
    cam.near = Math.max(0.02, this.alt * 0.015);
    cam.far = 2.5e6;
    cam.updateProjectionMatrix();
    return hgt;
  }
}
void HS;
