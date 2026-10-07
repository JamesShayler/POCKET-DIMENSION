import * as THREE from 'three';

const NOISE = /* glsl */ `
float hash31(vec3 p){ p = fract(p*0.3183099+.1); p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
float vnoise(vec3 x){
  vec3 i = floor(x); vec3 f = fract(x); f = f*f*(3.0-2.0*f);
  return mix(mix(mix(hash31(i+vec3(0,0,0)),hash31(i+vec3(1,0,0)),f.x),
                 mix(hash31(i+vec3(0,1,0)),hash31(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(hash31(i+vec3(0,0,1)),hash31(i+vec3(1,0,1)),f.x),
                 mix(hash31(i+vec3(0,1,1)),hash31(i+vec3(1,1,1)),f.x),f.y),f.z);
}
float fbm(vec3 p){ float a=0.5, s=0.0; for(int i=0;i<5;i++){ s+=a*vnoise(p); p=p*2.03+vec3(7.1,3.7,1.3); a*=0.5; } return s; }
`;

export function planetMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uSun: { value: new THREE.Vector3(1, 0, 0) },
      uCam: { value: new THREE.Vector3() },
      uTime: { value: 0 },
      uAlt: { value: 5000 },
    },
    vertexShader: /* glsl */ `
      attribute vec3 color; attribute vec4 aux;
      varying vec3 vN; varying vec3 vP; varying vec3 vC; varying vec4 vA;
      void main(){ vN = normal; vP = position; vC = color; vA = aux; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSun; uniform vec3 uCam; uniform float uTime; uniform float uAlt;
      varying vec3 vN; varying vec3 vP; varying vec3 vC; varying vec4 vA;
      ${NOISE}
      void main(){
        vec3 N = normalize(vN); vec3 V = normalize(uCam - vP); vec3 L = normalize(uSun);
        vec3 albedo = vC; float water = vA.x;
        float near = 1.0 - smoothstep(60.0, 1500.0, uAlt);
        if (water < 0.5) {
          float d = vnoise(vP*0.35)*0.5 + vnoise(vP*2.2)*0.3 + vnoise(vP*11.0)*0.2;
          albedo *= mix(1.0, 0.8 + 0.4*d, 0.35 + 0.65*near);
        } else {
          float lat = asin(clamp(N.y,-1.0,1.0));
          float flow = sin(lat*5.0);
          vec3 q = vP*0.05 + vec3(uTime*0.012*flow, 0.0, uTime*0.006);
          float n = fbm(q*3.0);
          N = normalize(N + (vec3(n, fbm(q*3.0+4.0), fbm(q*3.0+9.0)) - 0.5)*0.07);
          albedo *= 0.9 + 0.2*n;
          // faint current streaks
          float streak = smoothstep(0.62, 0.75, fbm(vec3(vP.x*0.02 + uTime*0.004*flow, vP.y*0.02, vP.z*0.02)*4.0));
          albedo += vec3(0.02,0.05,0.07)*streak*0.6;
        }
        float ndl = dot(N, L);
        float day = smoothstep(-0.10, 0.28, ndl);
        float diff = max(ndl, 0.0);
        vec3 col = albedo * (0.045 + 0.955*diff*(0.55+0.45*smoothstep(0.0,0.5,ndl)));
        vec3 H = normalize(L+V);
        float spec = pow(max(dot(N,H),0.0), 110.0) * water * step(0.0, ndl) * 0.9;
        float twilight = smoothstep(-0.18, 0.0, ndl) * (1.0 - smoothstep(0.0, 0.2, ndl));
        col += vec3(0.9,0.35,0.12) * twilight * 0.10 * (water*0.5+0.5);
        vec3 lights = vec3(1.0,0.72,0.38) * vA.y * pow(1.0-day, 1.4) * (1.4 + 0.6*vnoise(vP*30.0));
        float rim = pow(1.0 - max(dot(N,V),0.0), 3.2);
        vec3 sky = mix(vec3(0.03,0.06,0.14), vec3(0.35,0.62,1.0), day);
        col += sky*rim*0.6;
        gl_FragColor = vec4(col + vec3(spec) + lights, 1.0);
      }`,
  });
}

export function cloudMaterial(humid: THREE.Texture) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uSun: { value: new THREE.Vector3(1, 0, 0) },
      uTime: { value: 0 },
      uHumid: { value: humid },
    },
    vertexShader: /* glsl */ `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSun; uniform float uTime; uniform sampler2D uHumid;
      varying vec3 vP;
      ${NOISE}
      void main(){
        vec3 n = normalize(vP);
        float lat = asin(clamp(n.y,-1.0,1.0));
        float lon = atan(n.z, n.x);
        // zonal winds shear the cloud decks: trades, westerlies, polar easterlies
        float a = abs(lat)*57.2958;
        float u = a < 60.0 ? -cos(6.28318*a/60.0) : -1.0;
        float ang = uTime*0.0035*u;
        float c = cos(ang), s = sin(ang);
        vec3 p = vec3(n.x*c - n.z*s, n.y, n.x*s + n.z*c);
        float cover = texture2D(uHumid, vec2(lon/6.28318+0.5, 0.5 - lat/3.14159)).r;
        float d = fbm(p*3.2 + vec3(0.0, uTime*0.0005, 0.0));
        d += 0.35*fbm(p*9.0 + 3.0);
        float thr = 1.0 - cover*0.62;
        float alpha = smoothstep(thr, thr+0.2, d) * 0.85;
        float ndl = dot(n, normalize(uSun));
        float lit = 0.12 + 0.88*smoothstep(-0.15, 0.35, ndl);
        gl_FragColor = vec4(vec3(lit), alpha);
      }`,
  });
}

export function atmosphereMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    side: THREE.BackSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uSun: { value: new THREE.Vector3(1, 0, 0) }, uCam: { value: new THREE.Vector3() } },
    vertexShader: /* glsl */ `varying vec3 vN; varying vec3 vP; void main(){ vN = normalize(position); vP = position; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSun; uniform vec3 uCam; varying vec3 vN; varying vec3 vP;
      void main(){
        vec3 V = normalize(uCam - vP);
        float f = pow(max(0.0, dot(normalize(vN), V)), 5.0) ;
        float sunAmt = smoothstep(-0.35, 0.4, dot(vN, normalize(uSun)));
        vec3 col = mix(vec3(0.7,0.35,0.2), vec3(0.28,0.55,1.0), smoothstep(0.0,0.7,dot(vN, normalize(uSun))+0.2));
        gl_FragColor = vec4(col * f * sunAmt * 1.4, f * sunAmt);
      }`,
  });
}

export function starfield(): THREE.Points {
  const n = 5000;
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  let s = 12345;
  const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < n; i++) {
    const u = r() * 2 - 1;
    const t = r() * Math.PI * 2;
    const q = Math.sqrt(1 - u * u);
    pos.set([q * Math.cos(t) * 1.6e6, u * 1.6e6, q * Math.sin(t) * 1.6e6], i * 3);
    const b = 0.35 + r() * 0.65;
    const warm = r();
    col.set([b * (0.85 + 0.15 * warm), b * 0.9, b * (1 - 0.15 * warm)], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const m = new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true, depthWrite: false, transparent: true });
  const p = new THREE.Points(g, m);
  p.frustumCulled = false;
  return p;
}

export function glowSprite(color: string): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, color);
  grad.addColorStop(0.25, color.replace('1)', '0.35)'));
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  const m = new THREE.SpriteMaterial({ map: tex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
  return new THREE.Sprite(m);
}
