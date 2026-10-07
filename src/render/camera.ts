import * as THREE from 'three';
import { R_KM } from '../sim/grid';

const UP_Y = new THREE.Vector3(0, 1, 0);

export interface CamGoal { lon: number; lat: number; alt?: number; yaw?: number; pitch?: number }
/** From eye level (1.6 m) to the edge of the solar system (≈30 AU), one continuous zoom at one fixed scale. */
export const ALT_MIN = 0.0016;
export const ALT_MAX = 4.5e9;

/**
 * A globe-aware camera that orbits a point on the ground. All positions are double precision in the planet frame (km);
 * the renderer subtracts the camera position (floating origin) before anything reaches the GPU.
 */
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
  /** planet-frame camera position and look target (km) */
  readonly pos: [number, number, number] = [0, 0, 0];
  readonly target: [number, number, number] = [0, 0, 0];
  groundH = 0;

  static dir(lon: number, lat: number, out = new THREE.Vector3()) {
    const c = Math.cos(lat);
    return out.set(c * Math.cos(lon), Math.sin(lat), c * Math.sin(lon));
  }
  frame(lon = this.lon, lat = this.lat) {
    const up = CameraRig.dir(lon, lat);
    const north = UP_Y.clone().sub(up.clone().multiplyScalar(up.dot(UP_Y)));
    if (north.lengthSq() < 1e-10) north.set(-1, 0, 0);
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
  /** km covered by one pixel at the look target */
  private kmPerPx(viewH: number, fov: number) {
    return (Math.min(this.alt + 0.002, R_KM * 3) * 2 * Math.tan((fov * Math.PI) / 360)) / viewH;
  }
  panPixels(dx: number, dy: number, viewH: number, fov: number) {
    const k = this.kmPerPx(viewH, fov);
    const f = this.frame();
    const h = f.north.clone().multiplyScalar(Math.cos(this.yaw)).addScaledVector(f.east, Math.sin(this.yaw));
    const right = new THREE.Vector3().crossVectors(h, f.up);
    const moveE = (dx * right.dot(f.east) * -1 + dy * h.dot(f.east)) * k;
    const moveN = (dx * right.dot(f.north) * -1 + dy * h.dot(f.north)) * k;
    this.vLat += (moveN / R_KM) * 0.9;
    this.vLon += (moveE / (R_KM * Math.max(0.12, Math.cos(this.lat)))) * 0.9;
    this.goal = null;
    this.follow = null;
  }
  rotate(dYaw: number, dPitch: number) {
    this.yaw += dYaw;
    this.pitch = Math.min(1.5, Math.max(0, this.pitch + dPitch));
  }
  zoom(factor: number) {
    this.alt = Math.min(ALT_MAX, Math.max(ALT_MIN, this.alt * factor));
    if (this.goal) this.goal.alt = undefined;
  }

  update(dt: number) {
    if (this.follow) {
      const t = this.follow();
      if (t) {
        const k = 1 - Math.exp(-dt * 5);
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
      if (Math.abs(dl) < 1e-6 && Math.abs(g.lat - this.lat) < 1e-6 && (g.alt === undefined || Math.abs(Math.log(g.alt / this.alt)) < 0.01)) this.goal = null;
    }
    this.lon += this.vLon;
    this.lat += this.vLat;
    const damp = Math.exp(-dt * 7);
    this.vLon *= damp;
    this.vLat *= damp;
    if (Math.abs(this.vLon) < 1e-12) this.vLon = 0;
    if (Math.abs(this.vLat) < 1e-12) this.vLat = 0;
    this.lat = Math.max(-1.55, Math.min(1.55, this.lat));
    if (this.lon > Math.PI) this.lon -= Math.PI * 2;
    if (this.lon < -Math.PI) this.lon += Math.PI * 2;
  }

  /**
   * Place the camera. `groundAt(dir)` returns the drawn ground height (km) under a direction, or null when unknown.
   * Returns the camera's orientation basis for a camera sitting at the origin.
   */
  apply(cam: THREE.PerspectiveCamera, groundAt: (x: number, y: number, z: number) => number | null, sunTarget: [number, number, number] | null) {
    const { up, north, east } = this.frame();
    const g = groundAt(up.x, up.y, up.z);
    if (g !== null) this.groundH += (g - this.groundH) * (Math.abs(g - this.groundH) > 0.5 ? 1 : 0.35);
    // near the ground: orbit a point on the surface; far out: the planet's centre; farther still: the sun
    const planetBlend = Math.min(1, Math.max(0, (this.alt - R_KM * 2) / (R_KM * 6)));
    const tR = (R_KM + this.groundH) * (1 - planetBlend);
    let tx = up.x * tR, ty = up.y * tR, tz = up.z * tR;
    const spaceBlend = Math.min(1, Math.max(0, (this.alt - 2500) / 18000));
    const pitch = this.pitch * (1 - spaceBlend);
    const h = north.clone().multiplyScalar(Math.cos(this.yaw)).addScaledVector(east, Math.sin(this.yaw));
    const dist = this.alt + (R_KM + this.groundH) * planetBlend;
    let px = tx + up.x * dist * Math.cos(pitch) - h.x * dist * Math.sin(pitch);
    let py = ty + up.y * dist * Math.cos(pitch) - h.y * dist * Math.sin(pitch);
    let pz = tz + up.z * dist * Math.cos(pitch) - h.z * dist * Math.sin(pitch);
    if (sunTarget) {
      const sb = Math.min(1, Math.max(0, Math.log(this.alt / 3e6) / Math.log(30)));
      if (sb > 0) {
        const s = sb * sb * (3 - 2 * sb);
        tx += (sunTarget[0] - tx) * s; ty += (sunTarget[1] - ty) * s; tz += (sunTarget[2] - tz) * s;
        px += sunTarget[0] * s; py += sunTarget[1] * s; pz += sunTarget[2] * s;
      }
    }
    // never below the ground under the camera
    const pr = Math.hypot(px, py, pz);
    const gd = groundAt(px / pr, py / pr, pz / pr);
    const minR = R_KM + (gd ?? this.groundH) + 0.0012;
    if (pr < minR) { px *= minR / pr; py *= minR / pr; pz *= minR / pr; }
    this.pos[0] = px; this.pos[1] = py; this.pos[2] = pz;
    this.target[0] = tx; this.target[1] = ty; this.target[2] = tz;
    cam.position.set(0, 0, 0);
    cam.up.copy(h.multiplyScalar(Math.cos(pitch)).addScaledVector(up, Math.sin(pitch)));
    cam.lookAt(tx - px, ty - py, tz - pz);
    cam.near = 1e-5; // 1 cm: the logarithmic depth buffer keeps precision from here to the outer planets
    cam.far = 2e12;
    cam.updateProjectionMatrix();
  }

  get height() {
    return Math.hypot(this.pos[0], this.pos[1], this.pos[2]) - R_KM;
  }
}
