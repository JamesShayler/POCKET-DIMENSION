import * as THREE from 'three';
import type { SimClient } from '../client';
import { H, R_KM, W, lonOfX, latOfY } from '../sim/grid';
import { WW } from '../sim/weather';
import type { Fields } from './fields';
import { HAZE, LOGDEPTH_FRAG, LOGDEPTH_FRAG_PARS, LOGDEPTH_VERT, LOGDEPTH_VERT_PARS, NOISE } from './shaders';

/**
 * The simulated weather made visible: two cloud decks (cumulus at ~2 km, cirrus at ~9 km) whose cover is the
 * simulation's cloud field, spun into spirals around its storms; rain or snow falling around the observer when it falls
 * there in the simulation; lightning where it strikes; and wildfire flames and smoke over burning land.
 */
const STORMS = 16;

export class WeatherFx {
  readonly group = new THREE.Group();
  private low: THREE.Mesh;
  private high: THREE.Mesh;
  private lowMat: THREE.ShaderMaterial;
  private highMat: THREE.ShaderMaterial;
  private rain: THREE.LineSegments;
  private rainMat: THREE.ShaderMaterial;
  private bolt: THREE.Line;
  private boltLife = 0;
  flash = 0;
  private fire: THREE.Points;
  private fireMat: THREE.ShaderMaterial;
  private smoke: THREE.Points;
  private smokeMat: THREE.ShaderMaterial;
  private fireVersion = -1;
  private nextBolt = 0;
  /** what the weather is doing where the camera is */
  local = { precip: 0, temp: 15, cloud: 0, lightning: 0, windU: 0, windV: 0 };

  constructor(private c: SimClient, fields: Fields) {
    this.lowMat = cloudMaterial(fields, 2.2, 0);
    this.highMat = cloudMaterial(fields, 9.0, 1);
    this.low = new THREE.Mesh(new THREE.SphereGeometry(R_KM + 2.2, 720, 360), this.lowMat);
    this.high = new THREE.Mesh(new THREE.SphereGeometry(R_KM + 9.0, 360, 180), this.highMat);
    for (const m of [this.low, this.high]) { m.frustumCulled = false; m.renderOrder = 5; }
    // precipitation: streaks (rain) or slow flakes (snow) in a box around the observer
    const n = 9000;
    const p = new Float32Array(n * 2 * 3), seed = new Float32Array(n * 2 * 4);
    let s = 1;
    const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < n; i++) {
      const x = r(), y = r(), z = r(), ph = r();
      for (let e = 0; e < 2; e++) {
        p.set([x, y, z], (i * 2 + e) * 3);
        seed.set([x, y, z, e], (i * 2 + e) * 4);
      }
      void ph;
    }
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(p, 3));
    rg.setAttribute('seed', new THREE.BufferAttribute(seed, 4));
    this.rainMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { uTime: { value: 0 }, uUp: { value: new THREE.Vector3(0, 1, 0) }, uE: { value: new THREE.Vector3(1, 0, 0) }, uN: { value: new THREE.Vector3(0, 0, 1) }, uAmount: { value: 0 }, uSnow: { value: 0 }, uWind: { value: new THREE.Vector2() }, uLight: { value: 1 } },
      vertexShader: /* glsl */ `
        ${LOGDEPTH_VERT_PARS}
        attribute vec4 seed; uniform float uTime; uniform vec3 uUp; uniform vec3 uE; uniform vec3 uN; uniform float uAmount; uniform float uSnow; uniform vec2 uWind; varying float vA;
        void main(){
          float box = 0.06; // 60 m around the eye
          float speed = mix(0.009, 0.0012, uSnow); // km/s
          float fall = fract(seed.y - uTime * speed / box);
          vec3 p = (seed.x - 0.5) * box * uE + (seed.z - 0.5) * box * uN + (fall - 0.5) * box * uUp;
          p += (uE * uWind.x + uN * uWind.y) * 0.0006 * (fall - 0.5);
          if (uSnow > 0.5) p += (sin(uTime * 1.3 + seed.x * 40.0) * uE + cos(uTime * 1.1 + seed.z * 40.0) * uN) * 0.0005;
          float len = mix(0.0012, 0.00008, uSnow);
          p -= uUp * len * seed.w;
          vA = step(seed.x * 0.97 + seed.z * 0.03, uAmount) * (1.0 - abs(fall - 0.5) * 1.6);
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
          ${LOGDEPTH_VERT}
        }`,
      fragmentShader: /* glsl */ `${LOGDEPTH_FRAG_PARS} uniform float uSnow; uniform float uLight; varying float vA;
        void main(){ ${LOGDEPTH_FRAG} if (vA <= 0.0) discard; vec3 c = mix(vec3(0.62, 0.66, 0.72), vec3(0.95), uSnow) * uLight; gl_FragColor = vec4(c, vA * mix(0.35, 0.9, uSnow)); }`,
    });
    this.rain = new THREE.LineSegments(rg, this.rainMat);
    this.rain.frustumCulled = false;
    this.rain.renderOrder = 8;
    // a lightning bolt
    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(24 * 3), 3));
    this.bolt = new THREE.Line(bg, new THREE.LineBasicMaterial({ color: new THREE.Color(3, 3, 4), transparent: true, depthWrite: false }));
    this.bolt.frustumCulled = false;
    this.bolt.visible = false;
    // wildfire flames and smoke
    this.fireMat = particleMaterial(true);
    this.smokeMat = particleMaterial(false);
    this.fire = new THREE.Points(new THREE.BufferGeometry(), this.fireMat);
    this.smoke = new THREE.Points(new THREE.BufferGeometry(), this.smokeMat);
    for (const m of [this.fire, this.smoke]) { m.frustumCulled = false; m.renderOrder = 6; }
    this.group.add(this.low, this.high, this.rain, this.bolt, this.fire, this.smoke);
  }

  update(dt: number, time: number, day: number, cam: [number, number, number], camH: number, sun: [number, number, number], dust: number, viewH: number) {
    const c = this.c;
    // clouds sit around the planet centre, placed relative to the camera
    for (const m of [this.low, this.high]) m.position.set(-cam[0], -cam[1], -cam[2]);
    const storms = c.skyState.storms;
    for (const mat of [this.lowMat, this.highMat]) {
      const u = mat.uniforms;
      u.uSun.value.set(sun[0], sun[1], sun[2]);
      u.uTime.value = time;
      u.uDay.value = day;
      u.uCamH.value = camH;
      u.uDust.value = dust;
      u.uFlash.value = this.flash;
      const sv = u.uStorm.value as THREE.Vector4[];
      for (let k = 0; k < STORMS; k++) {
        const s = storms[k];
        if (!s) { sv[k].set(0, 0, 0, 0); continue; }
        const lon = lonOfX(s.x * 2 + 1), lat = latOfY(s.y * 2 + 1);
        const r = s.radius * 49; // weather cells → km
        sv[k].set(Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon), r * (lat >= 0 ? 1 : -1) + 0.0001 * Math.min(1, s.depth / 60));
      }
      const si = u.uStormDepth.value as number[];
      for (let k = 0; k < STORMS; k++) si[k] = storms[k] ? Math.min(1, storms[k].depth / 50) * (storms[k].tropical ? 1 : 0.6) : 0;
    }
    // ---- local weather
    const camR = Math.hypot(cam[0], cam[1], cam[2]);
    const up = new THREE.Vector3(cam[0] / camR, cam[1] / camR, cam[2] / camR);
    const lon = Math.atan2(up.z, up.x), lat = Math.asin(up.y);
    const mx = ((lon + Math.PI) / (Math.PI * 2)) * W, my = ((Math.PI / 2 - lat) / Math.PI) * H;
    const wx = c.weather;
    if (wx) {
      const k = Math.min(63, Math.max(0, Math.floor(my / 2))) * WW + (Math.floor(mx / 2) % WW);
      this.local = { precip: wx.precip[k] / 8, temp: wx.temp[k] / 2, cloud: wx.cloud[k] / 255, lightning: wx.lightning[k] / 40, windU: wx.u[k] / 4, windV: wx.v[k] / 4 };
    }
    const L = this.local;
    const below = camH < 2.4;
    const amount = below ? Math.min(1, L.precip / 12) : 0;
    const north = new THREE.Vector3(0, 1, 0).sub(up.clone().multiplyScalar(up.y)).normalize();
    const east = new THREE.Vector3().crossVectors(up, north).normalize();
    const ru = this.rainMat.uniforms;
    ru.uTime.value = time;
    ru.uUp.value.copy(up);
    ru.uE.value.copy(east);
    ru.uN.value.copy(north);
    ru.uAmount.value = amount;
    ru.uSnow.value = L.temp < 0.5 ? 1 : 0;
    ru.uWind.value.set(L.windU, L.windV);
    const sunUp = up.x * sun[0] + up.y * sun[1] + up.z * sun[2];
    ru.uLight.value = 0.15 + 0.85 * Math.max(0, Math.min(1, (sunUp + 0.1) / 0.3));
    this.rain.visible = amount > 0.01;
    // ---- lightning: flashes and bolts where the simulation has strikes
    this.flash = Math.max(0, this.flash - dt * 6);
    this.boltLife -= dt;
    if (this.boltLife <= 0) this.bolt.visible = false;
    if (L.lightning > 0.05 && camH < 30 && time > this.nextBolt) {
      this.nextBolt = time + 0.4 + Math.random() * 6 / Math.min(4, L.lightning + 0.2);
      this.flash = 0.6 + Math.random() * 0.6;
      this.strike(up, east, north, camH);
    }
    // ---- fires near the camera
    if (this.fireVersion !== c.versions.env) { this.fireVersion = c.versions.env; this.buildFires(); }
    for (const mat of [this.fireMat, this.smokeMat]) {
      mat.uniforms.uTime.value = time;
      mat.uniforms.uOrigin.value.set(cam[0], cam[1], cam[2]);
      mat.uniforms.uViewH.value = viewH;
      mat.uniforms.uSun.value.set(sun[0], sun[1], sun[2]);
    }
  }

  private strike(up: THREE.Vector3, east: THREE.Vector3, north: THREE.Vector3, camH: number) {
    const a = Math.random() * Math.PI * 2, d = 1 + Math.random() * 6;
    const base = east.clone().multiplyScalar(Math.cos(a) * d).addScaledVector(north, Math.sin(a) * d).addScaledVector(up, -camH);
    const pos = this.bolt.geometry.attributes.position as THREE.BufferAttribute;
    let p = base.clone().addScaledVector(up, 2.2);
    for (let i = 0; i < 24; i++) {
      pos.setXYZ(i, p.x, p.y, p.z);
      p = p.clone().addScaledVector(up, -2.2 / 23).addScaledVector(east, (Math.random() - 0.5) * 0.18).addScaledVector(north, (Math.random() - 0.5) * 0.18);
    }
    pos.needsUpdate = true;
    this.bolt.visible = true;
    this.boltLife = 0.12;
  }

  /** Flames and smoke columns over every burning cell (positions are deterministic within the cell). */
  private buildFires() {
    const env = this.c.env;
    const fp: number[] = [], fs: number[] = [], sp: number[] = [], ss: number[] = [];
    if (env) {
      let seed = 3;
      const r = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
      for (let i = 0; i < env.burn.length; i++) {
        if (env.burn[i] < 128) continue;
        const cx = (i % W) + 0.5, cy = Math.floor(i / W) + 0.5;
        for (let k = 0; k < 140; k++) {
          const x = cx + (r() - 0.5), y = cy + (r() - 0.5);
          const lon = lonOfX(x), lat = latOfY(y);
          const R = R_KM + 0.02;
          const d = [Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)];
          fp.push(d[0] * R, d[1] * R, d[2] * R);
          fs.push(0.02 + r() * 0.04, r());
          if (k % 7 === 0) { sp.push(d[0] * R, d[1] * R, d[2] * R); ss.push(1.2 + r() * 2.5, r()); }
        }
      }
    }
    const set = (pts: THREE.Points, p: number[], s: number[]) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
      g.setAttribute('info', new THREE.Float32BufferAttribute(s, 2));
      pts.geometry.dispose();
      pts.geometry = g;
    };
    set(this.fire, fp, fs);
    set(this.smoke, sp, ss);
  }
}

function cloudMaterial(f: Fields, altKm: number, layer: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: {
      uWeather: { value: f.weather }, uSun: { value: new THREE.Vector3(1, 0, 0) }, uTime: { value: 0 }, uDay: { value: 0 }, uCamH: { value: 1 }, uDust: { value: 1 }, uFlash: { value: 0 },
      uStorm: { value: Array.from({ length: STORMS }, () => new THREE.Vector4()) }, uStormDepth: { value: new Array(STORMS).fill(0) },
    },
    vertexShader: /* glsl */ `
      ${LOGDEPTH_VERT_PARS}
      varying vec3 vDir; varying vec3 vView;
      void main(){ vDir = normalize(position); vView = (modelMatrix * vec4(position, 1.0)).xyz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); ${LOGDEPTH_VERT} }`,
    fragmentShader: /* glsl */ `
      ${LOGDEPTH_FRAG_PARS}
      uniform sampler2D uWeather; uniform vec3 uSun; uniform float uTime; uniform float uDay; uniform float uCamH; uniform float uDust; uniform float uFlash;
      uniform vec4 uStorm[${STORMS}]; uniform float uStormDepth[${STORMS}];
      varying vec3 vDir; varying vec3 vView;
      ${NOISE}
      ${HAZE}
      vec2 uvOf(vec3 d){ return vec2(atan(d.z, d.x) * 0.15915494 + 0.5, 0.5 - asin(clamp(d.y, -1.0, 1.0)) * 0.31830989); }
      void main(){
        ${LOGDEPTH_FRAG}
        vec3 d = normalize(vDir);
        vec2 uv = uvOf(d);
        vec4 wx = texture2D(uWeather, uv);
        float cover = ${layer === 0 ? 'wx.r' : 'smoothstep(0.25, 0.9, wx.r) * 0.8 + 0.12'};
        // storms: a swirling spiral with a clear eye
        vec3 p = d;
        float swirl = 0.0;
        for (int k = 0; k < ${STORMS}; k++) {
          vec4 s = uStorm[k];
          if (s.w == 0.0) continue;
          float r = abs(s.w) * 0.001;
          float ang = acos(clamp(dot(d, s.xyz), -1.0, 1.0));
          float dk = ang / r;
          if (dk > 3.5) continue;
          float strength = uStormDepth[k];
          float rot = sign(s.w) * (2.4 / (0.35 + dk)) * strength * 2.0;
          vec3 axis = s.xyz;
          p = p * cos(rot) + cross(axis, p) * sin(rot) + axis * dot(axis, p) * (1.0 - cos(rot));
          float band = exp(-pow(dk - 1.0, 2.0) * 1.4) * strength;
          swirl = max(swirl, band);
          cover *= mix(1.0, smoothstep(0.08, 0.35, dk), strength); // the eye
        }
        float t = uDay * ${layer === 0 ? '6.0' : '14.0'};
        vec3 q = p * ${layer === 0 ? '420.0' : '160.0'} + vec3(t * 0.7, t * 0.13, -t * 0.3);
        float n = fbm5(q) + 0.35 * fbm3(q * 3.7 + 5.0) - 0.1 + swirl * 0.35;
        float thr = 1.0 - cover * 0.95 - swirl * 0.4;
        float dens = smoothstep(thr, thr + ${layer === 0 ? '0.18' : '0.35'}, n) * ${layer === 0 ? '0.97' : '0.55'};
        if (dens < 0.004) discard;
        vec3 L = normalize(uSun);
        float sunUp = dot(d, L);
        float day = smoothstep(-0.12, 0.2, sunUp);
        float thick = clamp(cover + wx.g * 0.004, 0.0, 1.0);
        vec3 lit = mix(vec3(1.0, 0.62, 0.42), vec3(1.0, 0.99, 0.97), smoothstep(0.0, 0.3, sunUp)) * uDust;
        // from below, thick cloud is dark grey; from above, bright
        float above = step(${altKm.toFixed(1)}, uCamH);
        float shade = mix(mix(0.85, 0.32, thick * dens), 1.0 - 0.15 * n, above);
        vec3 col = lit * shade * day + vec3(0.02, 0.025, 0.04) * (1.0 - day) + vec3(0.7, 0.75, 0.9) * uFlash * 0.6;
        float dist = length(vView);
        col = haze(col, dist, uCamH, ${altKm.toFixed(1)}, d, normalize(vView), L);
        gl_FragColor = vec4(col, dens * (1.0 - smoothstep(600.0, 3000.0, dist) * 0.2));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

function particleMaterial(flame: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: flame ? THREE.AdditiveBlending : THREE.NormalBlending,
    uniforms: { uTime: { value: 0 }, uOrigin: { value: new THREE.Vector3() }, uViewH: { value: 800 }, uSun: { value: new THREE.Vector3(1, 0, 0) } },
    vertexShader: /* glsl */ `
      ${LOGDEPTH_VERT_PARS}
      attribute vec2 info; uniform float uTime; uniform vec3 uOrigin; uniform float uViewH; varying float vA; varying float vH; varying float vSun; uniform vec3 uSun;
      void main(){
        vec3 up = normalize(position);
        float life = fract(uTime * ${flame ? '0.9' : '0.05'} + info.y);
        vec3 p = position + up * life * ${flame ? '0.03' : '4.0'} * info.x * ${flame ? '1.0' : '1.0'};
        vec4 mv = viewMatrix * vec4(p - uOrigin, 1.0);
        gl_Position = projectionMatrix * mv;
        float sizeKm = info.x * ${flame ? '(1.0 - life) * 0.8' : '(0.6 + life * 1.8)'};
        gl_PointSize = clamp(sizeKm / max(-mv.z, 1e-4) * uViewH, 0.0, 400.0);
        vA = ${flame ? '(1.0 - life)' : '(1.0 - life) * smoothstep(0.0, 0.1, life) * 0.5'};
        vH = life;
        vSun = max(dot(up, normalize(uSun)), 0.0);
        ${LOGDEPTH_VERT}
      }`,
    fragmentShader: /* glsl */ `${LOGDEPTH_FRAG_PARS} varying float vA; varying float vH; varying float vSun;
      void main(){ ${LOGDEPTH_FRAG} vec2 q = gl_PointCoord - 0.5; float a = smoothstep(0.5, 0.0, length(q)) * vA;
        ${flame ? 'gl_FragColor = vec4(mix(vec3(1.8, 0.9, 0.2), vec3(1.2, 0.25, 0.05), vH) * a, 1.0);' : 'gl_FragColor = vec4(vec3(0.25, 0.23, 0.22) * (0.3 + 0.7 * vSun), a);'} }`,
  });
}
