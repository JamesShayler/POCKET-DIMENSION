import * as THREE from 'three';
import type { SimClient } from '../client';
import { R_KM, lonOfX, latOfY } from '../sim/grid';
import { DAYS_PER_YEAR } from '../sim/time';
import { AU_KM, MOON, SUN_RADIUS_KM } from '../sim/space';
import { ATMOSPHERE, LOGDEPTH_FRAG, LOGDEPTH_FRAG_PARS, LOGDEPTH_VERT, LOGDEPTH_VERT_PARS, NOISE } from './shaders';
import { Heavens } from './heavens';

/**
 * Everything above the ground, at its true size and distance: the scattering atmosphere, the sun (one astronomical
 * unit away), the moon, the other planets on their orbits, comets, the stars, and what people have put in orbit.
 * Distant bodies that would be smaller than a pixel are still drawn as points of light, as the eye sees them.
 */
export class SkyLayer {
  readonly group = new THREE.Group();
  /** objects positioned in the solar system frame (heliocentric ecliptic km) */
  readonly solar = new THREE.Group();
  readonly heavens = new Heavens();
  private atmo: THREE.Mesh;
  private atmoMat: THREE.ShaderMaterial;
  private stars: THREE.Points;
  private starMat: THREE.ShaderMaterial;
  private sun: THREE.Mesh;
  private glare: THREE.Sprite;
  private moon: THREE.Mesh;
  private moonMat: THREE.ShaderMaterial;
  private planets: { mesh: THREE.Mesh; mat: THREE.ShaderMaterial; ring?: THREE.Mesh; index: number }[] = [];
  private dots: THREE.Points;
  private dotPos: Float32Array;
  private dotCol: Float32Array;
  private orbits: THREE.LineLoop[] = [];
  private comets: { head: THREE.Points; tail: THREE.Line }[] = [];
  private sats: THREE.Points;
  private satPos: Float32Array;
  private lights: THREE.Points;
  private lightsMat: THREE.ShaderMaterial;
  private lightsVersion = -1;
  private asteroid: THREE.Points;
  private m4 = new THREE.Matrix4();
  private tmp: number[] = new Array(16).fill(0);
  /** planet-frame positions (km) of named bodies this frame, for labels and picking */
  bodyPos: { name: string; index: number; p: [number, number, number]; r: number }[] = [];
  sunPos: [number, number, number] = [AU_KM, 0, 0];
  moonPos: [number, number, number] = [MOON.distKm, 0, 0];

  constructor(private c: SimClient) {
    // ---- the atmosphere: a full-screen pass that integrates scattering along every view ray
    this.atmoMat = new THREE.ShaderMaterial({
      depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, transparent: true,
      uniforms: { uInvProj: { value: new THREE.Matrix4() }, uCamRot: { value: new THREE.Matrix4() }, uCamPos: { value: new THREE.Vector3() }, uSun: { value: new THREE.Vector3(1, 0, 0) }, uSunI: { value: 22 }, uFlash: { value: 0 } },
      vertexShader: /* glsl */ `
        uniform mat4 uInvProj; uniform mat4 uCamRot; varying vec3 vRay;
        void main(){ vec4 v = uInvProj * vec4(position.xy, 1.0, 1.0); vRay = (uCamRot * vec4(v.xyz / v.w, 0.0)).xyz; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uCamPos; uniform vec3 uSun; uniform float uSunI; uniform float uFlash; varying vec3 vRay;
        ${ATMOSPHERE}
        void main(){
          vec3 rd = normalize(vRay); vec3 tr;
          vec3 col = scatter(uCamPos, rd, 1e9, normalize(uSun), uSunI, tr);
          col += vec3(0.25, 0.27, 0.35) * uFlash * (1.0 - tr);
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.atmo = new THREE.Mesh(tri, this.atmoMat);
    this.atmo.frustumCulled = false;
    this.atmo.renderOrder = -10;

    // ---- stars
    const n = 7000;
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), size = new Float32Array(n);
    let s = 12345;
    const r = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
    for (let i = 0; i < n; i++) {
      const u = r() * 2 - 1, t = r() * Math.PI * 2, q = Math.sqrt(1 - u * u);
      // a faint galactic band
      const band = Math.exp(-Math.pow(u * 3.2 + Math.sin(t) * 0.4, 2));
      if (r() > 0.45 + 0.55 * band && i > n * 0.35) { i--; continue; }
      pos.set([q * Math.cos(t), u, q * Math.sin(t)], i * 3);
      const b = Math.pow(r(), 3.2) * 1.6 + 0.12;
      const warm = r();
      col.set([b * (0.82 + 0.25 * warm), b * (0.86 + 0.08 * warm), b * (1.05 - 0.25 * warm)], i * 3);
      size[i] = 1.1 + Math.pow(r(), 6) * 2.2;
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    sg.setAttribute('color', new THREE.BufferAttribute(col, 3));
    sg.setAttribute('size', new THREE.BufferAttribute(size, 1));
    this.starMat = new THREE.ShaderMaterial({
      depthTest: false, depthWrite: false, transparent: true, blending: THREE.AdditiveBlending,
      uniforms: { uVis: { value: 1 }, uRot: { value: new THREE.Matrix3() } },
      vertexShader: /* glsl */ `attribute float size; attribute vec3 color; varying vec3 vC; uniform float uVis; uniform mat3 uRot;
        void main(){ vC = color * uVis; vec4 p = viewMatrix * vec4(uRot * position, 0.0); gl_Position = projectionMatrix * vec4(p.xyz * 1e6, 1.0); gl_Position.z = gl_Position.w * 0.999999; gl_PointSize = size; }`,
      fragmentShader: /* glsl */ `varying vec3 vC; void main(){ vec2 q = gl_PointCoord - 0.5; float a = smoothstep(0.5, 0.1, length(q)); gl_FragColor = vec4(vC * a, 1.0); }`,
    });
    this.stars = new THREE.Points(sg, this.starMat);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -20;

    // ---- the sun, at one astronomical unit, 696,000 km across
    this.sun = new THREE.Mesh(new THREE.SphereGeometry(SUN_RADIUS_KM, 48, 32), new THREE.MeshBasicMaterial({ color: new THREE.Color(60, 54, 42), toneMapped: true }));
    this.sun.frustumCulled = false;
    this.glare = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: 0xfff1d6, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    this.glare.frustumCulled = false;
    // ---- the moon
    this.moonMat = bodyMaterial([0.62, 0.61, 0.58], 0);
    this.moon = new THREE.Mesh(new THREE.SphereGeometry(MOON.radiusKm, 64, 48), this.moonMat);
    this.moon.frustumCulled = false;
    // ---- the other planets
    const sphere = new THREE.SphereGeometry(1, 64, 48);
    const bodies = c.space.bodies;
    this.dotPos = new Float32Array((bodies.length + 1) * 3);
    this.dotCol = new Float32Array((bodies.length + 1) * 3);
    bodies.forEach((b, i) => {
      if (b.home) return;
      const mat = bodyMaterial(b.color, b.kind === 'gas' ? 1 : b.kind === 'ice' ? 0.5 : 0);
      const mesh = new THREE.Mesh(sphere, mat);
      mesh.scale.setScalar(b.radiusKm);
      mesh.frustumCulled = false;
      const entry: (typeof this.planets)[number] = { mesh, mat, index: i };
      if (b.rings) {
        const ring = new THREE.Mesh(new THREE.RingGeometry(b.radiusKm * 1.3, b.radiusKm * 2.3, 128, 1), ringMaterial(b.color));
        ring.rotation.x = -Math.PI / 2 + 0.35;
        ring.frustumCulled = false;
        mesh.add(ring);
        ring.scale.setScalar(1 / b.radiusKm);
        entry.ring = ring;
      }
      this.planets.push(entry);
      this.solar.add(mesh);
      // orbit
      const pts: number[] = [];
      for (let k = 0; k <= 256; k++) {
        const E = (k / 256) * Math.PI * 2;
        const x = b.a * (Math.cos(E) - b.e), z = b.a * Math.sqrt(1 - b.e * b.e) * Math.sin(E);
        const cn = Math.cos(b.node), sn = Math.sin(b.node);
        const X = x * cn - z * sn, Z = x * sn + z * cn;
        pts.push(X * AU_KM, Z * Math.sin(b.incl) * AU_KM, Z * Math.cos(b.incl) * AU_KM);
      }
      const og = new THREE.BufferGeometry();
      og.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      const line = new THREE.LineLoop(og, new THREE.LineBasicMaterial({ color: new THREE.Color(b.color[0], b.color[1], b.color[2]).multiplyScalar(0.6), transparent: true, opacity: 0, depthWrite: false }));
      line.frustumCulled = false;
      this.orbits.push(line);
      this.solar.add(line);
    });
    // home orbit too
    {
      const pts: number[] = [];
      for (let k = 0; k <= 256; k++) { const E = (k / 256) * Math.PI * 2; pts.push(Math.cos(E) * AU_KM, 0, Math.sin(E) * AU_KM); }
      const og = new THREE.BufferGeometry();
      og.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      const line = new THREE.LineLoop(og, new THREE.LineBasicMaterial({ color: 0x5e8fd6, transparent: true, opacity: 0, depthWrite: false }));
      line.frustumCulled = false;
      this.orbits.push(line);
      this.solar.add(line);
    }
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.BufferAttribute(this.dotPos, 3));
    dg.setAttribute('color', new THREE.BufferAttribute(this.dotCol, 3));
    this.dots = new THREE.Points(dg, pointMaterial(3.2));
    this.dots.frustumCulled = false;
    // ---- comets
    for (let i = 0; i < c.sky.comets.length; i++) {
      const hg = new THREE.BufferGeometry();
      hg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
      hg.setAttribute('color', new THREE.BufferAttribute(new Float32Array([0.8, 0.92, 1]), 3));
      const head = new THREE.Points(hg, pointMaterial(3));
      head.frustumCulled = false;
      const tg = new THREE.BufferGeometry();
      tg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      tg.setAttribute('color', new THREE.BufferAttribute(new Float32Array([0.7, 0.85, 1, 0, 0, 0]), 3));
      const tail = new THREE.Line(tg, new THREE.LineBasicMaterial({ vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
      tail.frustumCulled = false;
      this.comets.push({ head, tail });
      this.group.add(head, tail);
    }
    // ---- satellites
    this.satPos = new Float32Array(400 * 3);
    const satG = new THREE.BufferGeometry();
    satG.setAttribute('position', new THREE.BufferAttribute(this.satPos, 3));
    satG.setAttribute('color', new THREE.BufferAttribute(new Float32Array(400 * 3), 3));
    this.sats = new THREE.Points(satG, pointMaterial(2));
    this.sats.frustumCulled = false;
    // ---- city lights seen from far away
    this.lightsMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uSun: { value: new THREE.Vector3(1, 0, 0) }, uFade: { value: 1 }, uOrigin: { value: new THREE.Vector3() } },
      vertexShader: /* glsl */ `
        ${LOGDEPTH_VERT_PARS}
        attribute float size; attribute vec3 color; uniform vec3 uSun; uniform float uFade; uniform vec3 uOrigin; varying vec3 vC;
        void main(){
          vec3 wp = position - uOrigin;
          vec3 up = normalize(position);
          float night = 1.0 - smoothstep(-0.12, 0.04, dot(up, uSun));
          vC = color * night * uFade;
          vec4 mv = viewMatrix * vec4(wp, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = size;
          ${LOGDEPTH_VERT}
        }`,
      fragmentShader: /* glsl */ `${LOGDEPTH_FRAG_PARS} varying vec3 vC; void main(){ ${LOGDEPTH_FRAG} vec2 q = gl_PointCoord - 0.5; float a = smoothstep(0.5, 0.0, length(q)); gl_FragColor = vec4(vC * a, 1.0); }`,
    });
    this.lights = new THREE.Points(new THREE.BufferGeometry(), this.lightsMat);
    this.lights.frustumCulled = false;
    this.lights.matrixAutoUpdate = false;
    // ---- a doomed asteroid in its final year
    const ag = new THREE.BufferGeometry();
    ag.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    ag.setAttribute('color', new THREE.BufferAttribute(new Float32Array([1, 0.7, 0.4]), 3));
    this.asteroid = new THREE.Points(ag, pointMaterial(4));
    this.asteroid.frustumCulled = false;
    this.solar.matrixAutoUpdate = false;
    this.group.add(this.stars, this.atmo, this.sun, this.glare, this.moon, this.solar, this.dots, this.sats, this.lights, this.asteroid);
  }

  /** Called every frame with the day shown, the sun's azimuth on the ground, and the camera (planet frame, km). */
  update(camera: THREE.PerspectiveCamera, day: number, sunAz: number, cam: [number, number, number], alt: number, dust: number, flash: number) {
    const h = this.heavens;
    h.update(day, sunAz);
    const sd = h.sunDir;
    const camR = Math.hypot(cam[0], cam[1], cam[2]);
    const camUp: [number, number, number] = [cam[0] / camR, cam[1] / camR, cam[2] / camR];
    const sunUp = sd[0] * camUp[0] + sd[1] * camUp[1] + sd[2] * camUp[2];
    const inAir = Math.max(0, Math.min(1, 1 - (camR - R_KM - 30) / 120));
    // ---- atmosphere
    const u = this.atmoMat.uniforms;
    u.uInvProj.value.copy(camera.projectionMatrixInverse);
    u.uCamRot.value.extractRotation(camera.matrixWorld);
    u.uCamPos.value.set(cam[0], cam[1], cam[2]);
    u.uSun.value.set(sd[0], sd[1], sd[2]);
    u.uSunI.value = 22 * dust;
    u.uFlash.value = flash;
    // ---- stars fade out under a bright sky
    this.starMat.uniforms.uVis.value = 1 - inAir * Math.min(1, Math.max(0, (sunUp + 0.18) / 0.25)) * 0.97;
    const rot = new THREE.Matrix3();
    {
      const m = h.matrix(this.tmp);
      rot.set(m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]);
    }
    this.starMat.uniforms.uRot.value.copy(rot);
    // ---- the solar system frame: heliocentric km → planet frame → camera-relative
    const m = h.matrix(this.tmp);
    this.m4.fromArray(m);
    const shift = new THREE.Matrix4().makeTranslation(-cam[0], -cam[1], -cam[2]);
    this.solar.matrix.multiplyMatrices(shift, this.m4);
    this.solar.matrixWorldNeedsUpdate = true;
    // sun
    this.sunPos = h.place(0, 0, 0);
    this.sun.position.set(this.sunPos[0] - cam[0], this.sunPos[1] - cam[1], this.sunPos[2] - cam[2]);
    this.glare.position.copy(this.sun.position);
    const sunDist = this.sun.position.length();
    const lowSun = inAir > 0 ? Math.max(0.15, Math.min(1, (sunUp + 0.05) / 0.3)) : 1;
    this.glare.scale.setScalar(sunDist * 0.11 * (0.5 + 0.5 * lowSun));
    this.glare.material.color.setRGB(1, 0.85 + 0.15 * lowSun, 0.65 + 0.35 * lowSun);
    this.glare.material.opacity = 0.55 * dust;
    // moon
    this.moonPos = h.moon(day);
    this.moon.position.set(this.moonPos[0] - cam[0], this.moonPos[1] - cam[1], this.moonPos[2] - cam[2]);
    this.moonMat.uniforms.uSun.value.set(sd[0], sd[1], sd[2]);
    // planets
    this.bodyPos = [{ name: 'The moon', index: -1, p: this.moonPos, r: MOON.radiusKm }];
    const bodies = this.c.space.bodies;
    let di = 0;
    for (const pl of this.planets) {
      const b = bodies[pl.index];
      const hp = this.c.space.bodyPos(pl.index, day).map((v) => v * AU_KM) as [number, number, number];
      pl.mesh.position.set(hp[0], hp[1], hp[2]);
      // light comes from the sun at the solar origin
      const sl = new THREE.Vector3(-hp[0], -hp[1], -hp[2]).normalize();
      const sp = h.vec(sl.x, sl.y, sl.z);
      pl.mat.uniforms.uSun.value.set(sp[0], sp[1], sp[2]);
      const pp = h.place(hp[0], hp[1], hp[2]);
      this.bodyPos.push({ name: b.name, index: pl.index, p: pp, r: b.radiusKm });
      this.dotPos[di * 3] = pp[0] - cam[0]; this.dotPos[di * 3 + 1] = pp[1] - cam[1]; this.dotPos[di * 3 + 2] = pp[2] - cam[2];
      const dist = Math.hypot(pp[0] - cam[0], pp[1] - cam[1], pp[2] - cam[2]);
      const bright = Math.min(1.4, (b.radiusKm / 6000) * Math.pow(AU_KM / dist, 0.5) * 1.6 / Math.max(0.6, b.a)) * (1 - inAir * Math.max(0, Math.min(1, (sunUp + 0.15) / 0.2)) * 0.9);
      this.dotCol[di * 3] = b.color[0] * bright + 0.25 * bright; this.dotCol[di * 3 + 1] = b.color[1] * bright + 0.25 * bright; this.dotCol[di * 3 + 2] = b.color[2] * bright + 0.25 * bright;
      di++;
    }
    // the sun as a point too, so it can be found from the outer system
    this.dotPos[di * 3] = this.sunPos[0] - cam[0]; this.dotPos[di * 3 + 1] = this.sunPos[1] - cam[1]; this.dotPos[di * 3 + 2] = this.sunPos[2] - cam[2];
    this.dotCol.set([alt > 1e7 ? 2 : 0, alt > 1e7 ? 1.9 : 0, alt > 1e7 ? 1.6 : 0], di * 3);
    di++;
    this.dots.geometry.setDrawRange(0, di);
    (this.dots.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.dots.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    const orbitVis = Math.max(0, Math.min(0.55, Math.log(Math.max(1, alt / 2e6)) / 4));
    for (const o of this.orbits) (o.material as THREE.LineBasicMaterial).opacity = orbitVis;
    // ---- comets on their orbits; tails point away from the sun and grow near it
    this.c.sky.comets.forEach((ct, i) => {
      const o = this.comets[i];
      const a = Math.pow(ct.period, 2 / 3);
      const M = 2 * Math.PI * (day / DAYS_PER_YEAR / ct.period + ct.phase);
      let E = M;
      for (let k = 0; k < 12; k++) E = M + ct.e * Math.sin(E);
      const x = a * (Math.cos(E) - ct.e), z = a * Math.sqrt(1 - ct.e * ct.e) * Math.sin(E);
      const cn = Math.cos(ct.node), sn = Math.sin(ct.node);
      const X = (x * cn - z * sn) * AU_KM, Z0 = (x * sn + z * cn) * AU_KM;
      const Y = Z0 * Math.sin(ct.incl), Z = Z0 * Math.cos(ct.incl);
      const rAU = Math.hypot(X, Y, Z) / AU_KM;
      const pp = h.place(X, Y, Z);
      const rel: [number, number, number] = [pp[0] - cam[0], pp[1] - cam[1], pp[2] - cam[2]];
      const vis = rAU < 4;
      o.head.visible = o.tail.visible = vis;
      if (!vis) return;
      const hp = o.head.geometry.attributes.position as THREE.BufferAttribute;
      hp.setXYZ(0, rel[0], rel[1], rel[2]);
      hp.needsUpdate = true;
      const glow = Math.min(1.5, 0.6 / (rAU * rAU)) * ct.size;
      (o.head.geometry.attributes.color as THREE.BufferAttribute).setXYZ(0, 0.8 * glow, 0.9 * glow, glow);
      (o.head.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
      const away = h.vec(X, Y, Z);
      const al = Math.hypot(away[0], away[1], away[2]);
      const len = (2.5e7 / Math.max(0.15, rAU * rAU)) * ct.size;
      const tp = o.tail.geometry.attributes.position as THREE.BufferAttribute;
      tp.setXYZ(0, rel[0], rel[1], rel[2]);
      tp.setXYZ(1, rel[0] + (away[0] / al) * len, rel[1] + (away[1] / al) * len, rel[2] + (away[2] / al) * len);
      tp.needsUpdate = true;
      (o.tail.geometry.attributes.color as THREE.BufferAttribute).setXYZ(0, 0.6 * glow, 0.75 * glow, 0.9 * glow);
      (o.tail.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    });
    // ---- satellites: points of reflected sunlight, dark in the planet's shadow
    const sats = this.c.skyState.satellites;
    const sc = this.sats.geometry.attributes.color as THREE.BufferAttribute;
    const p3: [number, number, number] = [0, 0, 0];
    let ns = 0;
    for (const st of sats) {
      if (ns >= 400) break;
      this.c.space.satPos(st, day, p3);
      const along = p3[0] * sd[0] + p3[1] * sd[1] + p3[2] * sd[2];
      const off = Math.hypot(p3[0] - sd[0] * along, p3[1] - sd[1] * along, p3[2] - sd[2] * along);
      const lit = along > 0 || off > R_KM ? 1 : 0;
      this.satPos[ns * 3] = p3[0] - cam[0]; this.satPos[ns * 3 + 1] = p3[1] - cam[1]; this.satPos[ns * 3 + 2] = p3[2] - cam[2];
      const b = lit * (st.kind === 'station' ? 1.6 : 0.75) * (1 - inAir * Math.max(0, Math.min(1, (sunUp + 0.1) / 0.15)));
      sc.setXYZ(ns, b, b * 0.97, b * 0.92);
      ns++;
    }
    this.sats.geometry.setDrawRange(0, ns);
    (this.sats.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    sc.needsUpdate = true;
    // ---- city lights from afar
    if (this.lightsVersion !== this.c.versions.settlements) { this.lightsVersion = this.c.versions.settlements; this.buildLights(); }
    this.lightsMat.uniforms.uSun.value.set(sd[0], sd[1], sd[2]);
    this.lightsMat.uniforms.uOrigin.value.set(cam[0], cam[1], cam[2]);
    this.lightsMat.uniforms.uFade.value = Math.max(0, Math.min(1, (alt - 25) / 150));
    // ---- asteroid
    const ap = this.c.sky.approaching(day);
    this.asteroid.visible = !!ap;
    if (ap) {
      const lon = lonOfX(ap.a.x), lat = latOfY(ap.a.y);
      const r = R_KM + 50 + Math.pow(1 - ap.t, 2) * 4e6;
      const d = [Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)];
      const ag = this.asteroid.geometry.attributes.position as THREE.BufferAttribute;
      ag.setXYZ(0, d[0] * r - cam[0], d[1] * r - cam[1], d[2] * r - cam[2]);
      ag.needsUpdate = true;
    }
  }

  private buildLights() {
    const pos: number[] = [], col: number[] = [], size: number[] = [];
    let seed = 7;
    const r = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    for (const s of this.c.settlements) {
      if (s.pop < 30 || s.lights <= 0) continue;
      const lon = lonOfX(s.x), lat = latOfY(s.y);
      const k = Math.min(14, 1 + Math.floor(Math.sqrt(s.pop) / 6));
      const rad = 0.15 + Math.sqrt(s.pop) * 0.03;
      for (let i = 0; i < k; i++) {
        const a = r() * Math.PI * 2, d = Math.sqrt(r()) * rad;
        const la = lat + (Math.sin(a) * d) / R_KM, lo = lon + (Math.cos(a) * d) / (R_KM * Math.max(0.1, Math.cos(lat)));
        const R = R_KM + 0.05;
        pos.push(Math.cos(la) * Math.cos(lo) * R, Math.sin(la) * R, Math.cos(la) * Math.sin(lo) * R);
        const b = Math.min(1.6, 0.25 + s.lights * 0.9 + Math.log10(s.pop) * 0.1) * (i === 0 ? 1.3 : 0.8);
        col.push(b, b * 0.72, b * 0.4);
        size.push(i === 0 ? 2.4 + Math.min(2, s.pop / 4000) : 1.4);
      }
    }
    const g = this.lights.geometry;
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('size', new THREE.Float32BufferAttribute(size, 1));
    g.computeBoundingSphere();
  }
}

function pointMaterial(size: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uSize: { value: size } },
    vertexShader: /* glsl */ `${LOGDEPTH_VERT_PARS} attribute vec3 color; varying vec3 vC; uniform float uSize;
      void main(){ vC = color; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_PointSize = uSize; ${LOGDEPTH_VERT} }`,
    fragmentShader: /* glsl */ `${LOGDEPTH_FRAG_PARS} varying vec3 vC; void main(){ ${LOGDEPTH_FRAG} vec2 q = gl_PointCoord - 0.5; float a = smoothstep(0.5, 0.05, length(q)); gl_FragColor = vec4(vC * a, 1.0); }`,
  });
}

/** Sunlit sphere: rocky worlds and moons, or banded giants (`bands` > 0). */
function bodyMaterial(color: [number, number, number], bands: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uSun: { value: new THREE.Vector3(1, 0, 0) }, uColor: { value: new THREE.Vector3(...color) }, uBands: { value: bands } },
    vertexShader: /* glsl */ `${LOGDEPTH_VERT_PARS} varying vec3 vN; varying vec3 vP;
      void main(){ vN = normalize((modelMatrix * vec4(normal, 0.0)).xyz); vP = normal; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); ${LOGDEPTH_VERT} }`,
    fragmentShader: /* glsl */ `${LOGDEPTH_FRAG_PARS} uniform vec3 uSun; uniform vec3 uColor; uniform float uBands; varying vec3 vN; varying vec3 vP;
      ${NOISE}
      void main(){
        ${LOGDEPTH_FRAG}
        vec3 c = uColor;
        if (uBands > 0.0) { float b = sin(vP.y * 18.0 + fbm3(vP * 4.0) * 3.0); c *= 0.8 + 0.25 * b * uBands; }
        else c *= 0.75 + 0.5 * fbm5(vP * 6.0);
        float l = max(dot(normalize(vN), normalize(uSun)), 0.0);
        gl_FragColor = vec4(c * (l * 1.2 + 0.015), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

function ringMaterial(color: [number, number, number]): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true, side: THREE.DoubleSide, depthWrite: false,
    uniforms: { uColor: { value: new THREE.Vector3(...color) } },
    vertexShader: /* glsl */ `${LOGDEPTH_VERT_PARS} varying vec2 vUv; varying float vR; void main(){ vR = length(position.xy); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); ${LOGDEPTH_VERT} }`,
    fragmentShader: /* glsl */ `${LOGDEPTH_FRAG_PARS} uniform vec3 uColor; varying float vR; void main(){ ${LOGDEPTH_FRAG} float t = fract(vR * 0.00031); float a = 0.35 + 0.35 * sin(t * 60.0) * sin(t * 23.0); gl_FragColor = vec4(uColor * 0.9, clamp(a, 0.05, 0.75)); }`,
  });
}

function glowTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.03, 'rgba(255,250,235,0.9)');
  grad.addColorStop(0.12, 'rgba(255,230,190,0.25)');
  grad.addColorStop(0.4, 'rgba(255,210,160,0.05)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}
