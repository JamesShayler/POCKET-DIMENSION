/**
 * Shared GLSL. Distances are in kilometres. Detail noise uses a lattice that repeats every 289 units, so a chunk can pass
 * its centre "mod 289" and add local offsets: high-frequency texture stays seamless across chunks without float32 trouble.
 */
export const NOISE = /* glsl */ `
vec3 mod289(vec3 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
float hash3(vec3 p){ p = mod289(p); p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vnoise(vec3 x){
  vec3 i = floor(x); vec3 f = fract(x); f = f*f*(3.0-2.0*f);
  return mix(mix(mix(hash3(i+vec3(0,0,0)),hash3(i+vec3(1,0,0)),f.x), mix(hash3(i+vec3(0,1,0)),hash3(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(hash3(i+vec3(0,0,1)),hash3(i+vec3(1,0,1)),f.x), mix(hash3(i+vec3(0,1,1)),hash3(i+vec3(1,1,1)),f.x),f.y),f.z);
}
float fbm3(vec3 p){ float a=0.5, s=0.0; for(int i=0;i<3;i++){ s+=a*vnoise(p); p=p*2.0+vec3(17.0,31.0,7.0); a*=0.5; } return s; }
float fbm5(vec3 p){ float a=0.5, s=0.0; for(int i=0;i<5;i++){ s+=a*vnoise(p); p=p*2.0+vec3(17.0,31.0,7.0); a*=0.5; } return s; }
`;

/**
 * Single-scattering atmosphere (Rayleigh + Mie), integrated along the view ray. Earth-like air on a 1000 km world:
 * scale heights 8 km and 1.2 km, top of the atmosphere at 100 km.
 */
export const ATMOSPHERE = /* glsl */ `
const float PR = 1000.0;
const float AR = 1100.0;
const vec3 KR = vec3(5.8e-3, 13.5e-3, 33.1e-3);
const float KM = 21e-3;
const float HR = 8.0;
const float HM = 1.2;
vec2 rsi(vec3 r0, vec3 rd, float sr){
  float b = dot(rd, r0); float c = dot(r0, r0) - sr*sr; float d = b*b - c;
  if (d < 0.0) return vec2(1e9, -1e9);
  d = sqrt(d); return vec2(-b - d, -b + d);
}
vec3 scatter(vec3 r0, vec3 rd, float tMax, vec3 sunDir, float sunI, out vec3 trans){
  vec2 p = rsi(r0, rd, AR);
  trans = vec3(1.0);
  if (p.x > p.y) return vec3(0.0);
  p.x = max(p.x, 0.0);
  p.y = min(p.y, tMax);
  vec2 pg = rsi(r0, rd, PR);
  if (pg.x > 0.0 && pg.x < p.y) p.y = pg.x;
  if (p.y <= p.x) return vec3(0.0);
  const int N = 12; const int M = 5;
  float ds = (p.y - p.x) / float(N);
  float mu = dot(rd, sunDir);
  float pR = 3.0/(16.0*3.14159) * (1.0 + mu*mu);
  float g = 0.76;
  float pM = 3.0/(8.0*3.14159) * ((1.0-g*g)*(1.0+mu*mu)) / ((2.0+g*g)*pow(1.0+g*g-2.0*mu*g, 1.5));
  vec3 tR = vec3(0.0), tM = vec3(0.0);
  float odR = 0.0, odM = 0.0;
  for (int i = 0; i < N; i++) {
    vec3 x = r0 + rd * (p.x + (float(i)+0.5)*ds);
    float h = length(x) - PR;
    float dR = exp(-h/HR)*ds, dM = exp(-h/HM)*ds;
    odR += dR; odM += dM;
    // light reaching this point from the sun: the planet's shadow, softened over the terminator
    vec2 ps = rsi(x, sunDir, AR);
    float tc = dot(x, sunDir);
    float sh = tc < 0.0 ? smoothstep(PR - 2.0, PR + 14.0, length(x - sunDir * tc)) : 1.0;
    if (sh <= 0.0) continue;
    float dsl = ps.y / float(M);
    float lR = 0.0, lM = 0.0;
    for (int j = 0; j < M; j++) {
      vec3 y = x + sunDir * ((float(j)+0.5)*dsl);
      float hl = max(0.0, length(y) - PR);
      lR += exp(-hl/HR)*dsl; lM += exp(-hl/HM)*dsl;
    }
    vec3 att = exp(-(KR*(odR+lR) + KM*1.1*(odM+lM)));
    tR += dR*att*sh; tM += dM*att*sh;
  }
  trans = exp(-(KR*odR + KM*1.1*odM));
  return sunI * (pR*KR*tR + pM*KM*tM);
}
`;

/** Cheap aerial perspective for surfaces: extinction along the ray and an in-scatter colour from the sun's height. */
export const HAZE = /* glsl */ `
vec3 haze(vec3 col, float dist, float camH, float fragH, vec3 up, vec3 viewDir, vec3 sunDir){
  float h = max(0.0, 0.5*(camH + fragH));
  float dR = exp(-h/8.0) * dist, dM = exp(-h/1.2) * dist;
  vec3 ext = exp(-(vec3(5.8e-3, 13.5e-3, 33.1e-3) * dR + 23e-3 * dM));
  float sunUp = dot(up, sunDir);
  float day = smoothstep(-0.12, 0.25, sunUp);
  float mu = dot(viewDir, sunDir);
  // far enough away, the ground fades into the colour of the horizon sky: pale blue by day, orange low in the sun
  vec3 skyCol = mix(vec3(0.85, 0.32, 0.1), vec3(0.4, 0.56, 0.88), smoothstep(0.0, 0.35, sunUp)) * day;
  skyCol += vec3(1.0, 0.85, 0.6) * pow(max(mu, 0.0), 8.0) * 0.6 * day;
  return col * ext + skyCol * (1.0 - ext) * 0.5 + vec3(0.002, 0.003, 0.006) * (1.0 - ext) * (1.0 - day);
}
`;

export const LOGDEPTH_VERT_PARS = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
`;
export const LOGDEPTH_VERT = /* glsl */ `
#include <logdepthbuf_vertex>
`;
export const LOGDEPTH_FRAG_PARS = /* glsl */ `
#include <logdepthbuf_pars_fragment>
`;
export const LOGDEPTH_FRAG = /* glsl */ `
#include <logdepthbuf_fragment>
`;
