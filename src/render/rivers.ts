import * as THREE from 'three';
import type { World } from '../sim/world';
import { N, W, lonOfX, latOfY } from '../sim/grid';
import { mix32 } from '../sim/rng';
import type { PlanetView } from './planetView';
import { CameraRig } from './camera';

/** Rivers are drawn as meandering ribbons laid on the terrain, widened with altitude so they read at every scale. */
export class RiverLayer {
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;

  constructor(world: World, pv: PlanetView) {
    const p = world.planet;
    const pos: number[] = [];
    const side: number[] = [];
    const wid: number[] = [];
    const idxs: number[] = [];
    const SUB = 7;
    const up = new THREE.Vector3();
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    let thr = 1;
    {
      const flows: number[] = [];
      for (let i = 0; i < N; i++) if (p.river[i]) flows.push(p.flow[i]);
      flows.sort((x, y) => x - y);
      thr = flows[0] ?? 1;
    }
    const pt = (x: number, y: number, lift: number) => {
      const lon = lonOfX(x);
      const lat = latOfY(y);
      const d = CameraRig.dir(lon, lat);
      return d.multiplyScalar(pv.groundRadius(((x % W) + W) % W, y) + lift);
    };
    for (let i = 0; i < N; i++) {
      if (!p.river[i]) continue;
      const d = p.drain[i];
      if (d < 0) continue;
      const x0 = (i % W) + 0.5;
      const y0 = Math.floor(i / W) + 0.5;
      let x1 = (d % W) + 0.5;
      const y1 = Math.floor(d / W) + 0.5;
      if (x1 - x0 > W / 2) x1 -= W;
      if (x1 - x0 < -W / 2) x1 += W;
      const w0 = 0.012 + 0.035 * Math.min(2.2, Math.sqrt(p.flow[i] / thr));
      const h = mix32(i, 991);
      const phase = (h % 628) / 100;
      const amp = 0.14 + ((h >>> 12) % 100) / 500;
      const base = pos.length / 3;
      let prev: THREE.Vector3 | null = null;
      for (let k = 0; k <= SUB; k++) {
        const t = k / SUB;
        let x = x0 + (x1 - x0) * t;
        let y = y0 + (y1 - y0) * t;
        // meander perpendicular to the course
        const dx = x1 - x0, dy = y1 - y0;
        const len = Math.hypot(dx, dy) || 1;
        const off = Math.sin(t * Math.PI * 2 + phase) * amp * Math.sin(t * Math.PI) * 1.0;
        x += (-dy / len) * off;
        y += (dx / len) * off;
        const c = pt(x, Math.min(127.9, Math.max(0.1, y)), 0.05);
        up.copy(c).normalize();
        const nxt = pt(x + dx / len * 0.1, Math.min(127.9, Math.max(0.1, y + dy / len * 0.1)), 0.05);
        a.copy(nxt).sub(c).normalize();
        b.crossVectors(a, up).normalize();
        pos.push(c.x, c.y, c.z, c.x, c.y, c.z);
        side.push(b.x, b.y, b.z, -b.x, -b.y, -b.z);
        const taper = k === SUB && p.ocean[d] ? 1.6 : 1;
        wid.push(w0 * taper, w0 * taper);
        if (prev) {
          const j = base + k * 2;
          idxs.push(j - 2, j - 1, j, j - 1, j + 1, j);
        }
        prev = c;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('side', new THREE.Float32BufferAttribute(side, 3));
    g.setAttribute('width', new THREE.Float32BufferAttribute(wid, 1));
    g.setIndex(idxs);
    this.mat = new THREE.ShaderMaterial({
      transparent: false,
      side: THREE.DoubleSide,
      depthWrite: true,
      uniforms: { uScale: { value: 1 }, uSun: { value: new THREE.Vector3(1, 0, 0) }, uCam: { value: new THREE.Vector3() } },
      vertexShader: /* glsl */ `
        attribute vec3 side; attribute float width; uniform float uScale; varying vec3 vN; varying vec3 vP;
        void main(){ vec3 p = position + side*width*uScale; vN = normalize(position); vP = p; gl_Position = projectionMatrix*modelViewMatrix*vec4(p,1.0); }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uSun; uniform vec3 uCam; varying vec3 vN; varying vec3 vP;
        void main(){
          float ndl = dot(normalize(vN), normalize(uSun));
          float day = smoothstep(-0.1, 0.25, ndl);
          vec3 V = normalize(uCam - vP); vec3 H = normalize(normalize(uSun)+V);
          float spec = pow(max(dot(normalize(vN),H),0.0), 80.0) * step(0.0, ndl);
          vec3 col = vec3(0.16,0.42,0.66) * (0.06 + 0.94*max(ndl,0.0)) + vec3(spec)*0.5;
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  update(alt: number, sun: THREE.Vector3, cam: THREE.Vector3) {
    // keep rivers a few pixels wide from orbit, true to scale up close
    this.mat.uniforms.uScale.value = Math.max(1, alt * 0.0035);
    this.mat.uniforms.uSun.value.copy(sun);
    this.mat.uniforms.uCam.value.copy(cam);
    this.mesh.visible = alt < 30000;
  }
}
