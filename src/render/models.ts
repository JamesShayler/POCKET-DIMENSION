import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { BKind } from '../sim/buildings';

/**
 * Low-poly models at real-world dimensions, in metres (instances scale them by 0.001 into kilometres). Vertex colours
 * mark materials (walls, roofs, wood, metal) and the per-instance colour tints them by culture.
 */
type Part = THREE.BufferGeometry;

function paint(g: Part, c: number | [number, number, number]): Part {
  const col = typeof c === 'number' ? new THREE.Color(c) : new THREE.Color(c[0], c[1], c[2]);
  const n = g.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = col.r; a[i * 3 + 1] = col.g; a[i * 3 + 2] = col.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}
function box(w: number, h: number, d: number, x = 0, y = 0, z = 0, c: number = 0xffffff): Part {
  const g = new THREE.BoxGeometry(w, h, d).toNonIndexed();
  g.translate(x, y + h / 2, z);
  return paint(g, c);
}
function cyl(rt: number, rb: number, h: number, seg: number, x = 0, y = 0, z = 0, c: number = 0xffffff): Part {
  const g = new THREE.CylinderGeometry(rt, rb, h, seg).toNonIndexed();
  g.translate(x, y + h / 2, z);
  return paint(g, c);
}
function cone(r: number, h: number, seg: number, x = 0, y = 0, z = 0, c: number = 0xffffff, rotY = 0): Part {
  const g = new THREE.ConeGeometry(r, h, seg).toNonIndexed();
  g.rotateY(rotY);
  g.translate(x, y + h / 2, z);
  return paint(g, c);
}
function sphere(r: number, x = 0, y = 0, z = 0, c: number = 0xffffff, detail = 1): Part {
  const g = new THREE.IcosahedronGeometry(r, detail).toNonIndexed();
  g.translate(x, y, z);
  return paint(g, c);
}
/** A gable roof (triangular prism) over a w × d footprint. */
function gable(w: number, d: number, h: number, y: number, c: number): Part {
  const s = new THREE.Shape();
  s.moveTo(-w / 2 - 0.3, 0); s.lineTo(w / 2 + 0.3, 0); s.lineTo(0, h); s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: d + 0.6, bevelEnabled: false });
  g.translate(0, y, -d / 2 - 0.3);
  return paint(g, c);
}
function merge(parts: Part[]): THREE.BufferGeometry {
  for (const p of parts) { p.deleteAttribute('uv'); if (!p.attributes.normal) p.computeVertexNormals(); }
  const g = mergeGeometries(parts, false)!;
  g.computeBoundingSphere();
  return g;
}

const WALL = 0xd8cbb4, TIMBER = 0x8b6a45, THATCH = 0xb59a5c, TILE = 0x9a4b32, STONE = 0xb7b2a6, DARK = 0x4a4038, METAL = 0x9aa3ad, WHITE = 0xe9e9e6, GLASS = 0x6f8fa8;

export function buildingModel(kind: BKind): THREE.BufferGeometry {
  switch (kind) {
    case 'hut': return merge([cyl(2.1, 2.3, 1.6, 9, 0, 0, 0, TIMBER), cone(2.8, 2.4, 9, 0, 1.6, 0, THATCH)]);
    case 'house': return merge([box(6, 3, 5, 0, 0, 0, TIMBER), gable(6, 5, 2.6, 3, THATCH), box(0.9, 1.9, 0.1, 0, 0, 2.52, DARK)]);
    case 'brickhouse': return merge([box(7, 3.2, 6, 0, 0, 0, 0xc2915e), box(7.2, 0.4, 6.2, 0, 3.2, 0, 0xa87a4c), box(1, 2, 0.1, 0, 0, 3.02, DARK)]);
    case 'stonehouse': return merge([box(8, 5.5, 7, 0, 0, 0, STONE), gable(8, 7, 3.2, 5.5, TILE), box(1.1, 2.2, 0.1, 0, 0, 3.52, DARK), box(0.9, 1, 0.1, -2.5, 2.8, 3.52, GLASS), box(0.9, 1, 0.1, 2.5, 2.8, 3.52, GLASS)]);
    case 'granary': return merge([cyl(3, 3, 5, 12, 0, 0, 0, 0xcdb48a), cone(3.6, 2.5, 12, 0, 5, 0, THATCH)]);
    case 'workshop': return merge([box(10, 4, 7, 0, 0, 0, TIMBER), gable(10, 7, 2.8, 4, TILE), box(3, 2.6, 0.1, 0, 0, 3.52, DARK)]);
    case 'kiln': return merge([sphere(2.6, 0, 1.2, 0, 0xb26a45, 1), cyl(0.5, 0.6, 3.5, 7, 0, 2.5, 0, 0x7a4a35)]);
    case 'smithy': return merge([box(9, 4, 7, 0, 0, 0, STONE), gable(9, 7, 2.5, 4, DARK), cyl(0.7, 0.8, 4, 8, 3, 4, 2, 0x5a5048)]);
    case 'market': {
      const parts: Part[] = [];
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        parts.push(box(3, 0.9, 2, i * 6, 0, j * 6, TIMBER), cone(2.6, 1.6, 4, i * 6, 2.2, j * 6, (i + j) % 2 ? 0xc04a3a : 0xd9c27a, Math.PI / 4));
        parts.push(cyl(0.08, 0.08, 2.2, 4, i * 6 + 1.2, 0, j * 6 + 1, TIMBER), cyl(0.08, 0.08, 2.2, 4, i * 6 - 1.2, 0, j * 6 - 1, TIMBER));
      }
      return merge(parts);
    }
    case 'temple': return merge([box(24, 2, 32, 0, 0, 0, STONE), box(18, 2, 26, 0, 2, 0, STONE), box(12, 9, 18, 0, 4, 0, WHITE), gable(12, 18, 5, 13, TILE),
      ...[-4.5, -1.5, 1.5, 4.5].map((x) => cyl(0.6, 0.6, 9, 10, x, 4, 9.6, WHITE))]);
    case 'hall': return merge([box(16, 6, 10, 0, 0, 0, TIMBER), gable(16, 10, 4.5, 6, TILE), box(2, 3, 0.1, 0, 0, 5.02, DARK)]);
    case 'tower': return merge([cyl(3, 3.4, 15, 10, 0, 0, 0, STONE), cyl(3.8, 3.8, 2, 10, 0, 15, 0, STONE), cone(4, 4, 10, 0, 17, 0, TILE)]);
    case 'well': return merge([cyl(1.1, 1.1, 0.9, 10, 0, 0, 0, STONE), box(0.15, 2.2, 0.15, -1, 0, 0, TIMBER), box(0.15, 2.2, 0.15, 1, 0, 0, TIMBER), gable(2.4, 1.6, 0.8, 2.2, THATCH)]);
    case 'dock': return merge([box(6, 0.6, 40, 0, 0.3, -18, TIMBER), ...[-20, -10, 0].map((z) => cyl(0.25, 0.25, 2, 6, 2.6, -1, z - 18, DARK)), box(8, 4, 6, 0, 0, 4, TIMBER), gable(8, 6, 2.2, 4, TILE)]);
    case 'factory': return merge([box(40, 10, 24, 0, 0, 0, 0x8c6f5e), ...[-12, -4, 4, 12].map((x) => gable(8, 24, 3, 10, 0x5f5a58).translate(x, 0, 0)),
      cyl(1.6, 2, 30, 10, 14, 0, 9, 0x6d4e42), cyl(1.4, 1.8, 26, 10, 8, 0, 9, 0x6d4e42), box(3, 4, 0.2, -8, 0, 12.1, DARK)]);
    case 'powerplant': return merge([cyl(14, 20, 45, 20, -20, 0, 0, 0xc9c6bf), cyl(14, 20, 45, 20, 20, 0, 0, 0xc9c6bf), box(30, 18, 22, 0, 0, 30, 0x9b9a96), cyl(2, 2.4, 60, 10, 12, 0, 34, 0x8b8a86)]);
    case 'airport': return merge([box(45, 0.2, 2400, 0, 0, 0, 0x3a3c40), box(1.2, 0.22, 2400, 0, 0.01, 0, 0xd8d8d0), box(25, 0.2, 900, 60, 0, 0, 0x45474a),
      box(120, 9, 40, 140, 0, 0, 0xb8bcc2), box(118, 3, 38, 140, 9, 0, GLASS), cyl(3, 4, 32, 8, 200, 0, -60, 0xd0d0cc), box(9, 6, 9, 200, 32, -60, GLASS)]);
    case 'launchpad': return merge([box(80, 3, 80, 0, 0, 0, 0x8f8f8a), box(14, 70, 14, 22, 3, 0, 0xb04a32), box(16, 2, 16, 22, 73, 0, 0xb04a32),
      cyl(3, 3, 52, 16, 0, 3, 0, WHITE), cone(3, 9, 16, 0, 55, 0, WHITE), cyl(3.3, 3.3, 6, 16, 0, 3, 0, 0x2a2a2a), box(140, 0.3, 30, 0, 0, -110, 0x55575a)]);
    case 'palisade': case 'wall': case 'field': return merge([box(1, 1, 1)]);
  }
  return merge([box(5, 3, 5, 0, 0, 0, WALL)]);
}

/** One wall segment (1 m long along x); the ring is made of many. */
export function wallSegment(stone: boolean): THREE.BufferGeometry {
  if (!stone) return merge([...[-0.35, 0, 0.35].map((x) => cyl(0.16, 0.18, 4.2, 6, x, 0, 0, TIMBER)), cone(0.18, 0.4, 6, 0, 4.2, 0, TIMBER)]);
  return merge([box(1.02, 7, 2.2, 0, 0, 0, STONE), box(0.45, 1, 2.2, -0.25, 7, 0, STONE)]);
}
export function wallTower(): THREE.BufferGeometry {
  return merge([cyl(3.2, 3.6, 11, 10, 0, 0, 0, STONE), cone(3.8, 3.5, 10, 0, 11, 0, TILE)]);
}

/** A person, 1.7 m tall, facing +z. Clothing colour comes from the instance. */
export function personModel(): THREE.BufferGeometry {
  return merge([
    cyl(0.17, 0.2, 0.62, 7, 0, 0.82, 0, 0xffffff), // torso
    cyl(0.07, 0.07, 0.82, 5, -0.09, 0, 0, 0x6a5440), cyl(0.07, 0.07, 0.82, 5, 0.09, 0, 0, 0x6a5440), // legs
    cyl(0.05, 0.05, 0.6, 5, -0.24, 0.85, 0, 0xffffff), cyl(0.05, 0.05, 0.6, 5, 0.24, 0.85, 0, 0xffffff), // arms
    sphere(0.12, 0, 1.58, 0, 0xc9a07a, 1), // head
  ]);
}
export function cargoModel(): THREE.BufferGeometry {
  return merge([box(0.45, 0.4, 0.3, 0, 1.05, -0.25, 0xffffff)]);
}
export function boatModel(big: boolean): THREE.BufferGeometry {
  if (!big) return merge([box(1.3, 0.5, 5, 0, -0.2, 0, TIMBER), box(1.0, 0.1, 4.4, 0, 0.3, 0, 0x6b5135)]);
  return merge([box(6, 3, 26, 0, -1, 0, TIMBER), box(4.5, 2, 6, 0, 2, -8, TIMBER), cyl(0.2, 0.25, 18, 6, 0, 2, 2, DARK), box(0.1, 11, 8, 0, 6, 2, 0xefe8d8)]);
}
export function steamshipModel(): THREE.BufferGeometry {
  return merge([box(12, 6, 90, 0, -2, 0, 0x2d3036), box(11, 1, 88, 0, 4, 0, 0xb9332b), box(9, 8, 24, 0, 5, -8, WHITE), cyl(2.2, 2.4, 9, 10, 0, 13, -6, 0xc9a23a)]);
}
export function planeModel(): THREE.BufferGeometry {
  const f = new THREE.CylinderGeometry(2, 2, 40, 10).toNonIndexed();
  f.rotateX(Math.PI / 2);
  paint(f, WHITE);
  return merge([f, box(36, 0.5, 6, 0, -0.5, 2, 0xd8dade), box(12, 0.4, 3, 0, 0, -17, 0xd8dade), box(0.4, 6, 4, 0, 0, -18, 0x2a5fa8)]);
}

/** An animal of body length `1`; species colour comes from the instance. Diet changes the shape a little. */
export function animalModel(diet: number): THREE.BufferGeometry {
  if (diet === 2) return merge([box(0.32, 0.32, 1, 0, 0.35, 0), box(0.24, 0.24, 0.3, 0, 0.55, 0.6), ...[-0.11, 0.11].flatMap((x) => [box(0.07, 0.35, 0.07, x, 0, 0.35), box(0.07, 0.35, 0.07, x, 0, -0.35)]), box(0.05, 0.05, 0.45, 0, 0.55, -0.7)]);
  if (diet === 1) return merge([box(0.38, 0.42, 0.9, 0, 0.3, 0), box(0.26, 0.26, 0.3, 0, 0.55, 0.55), ...[-0.13, 0.13].flatMap((x) => [box(0.08, 0.3, 0.08, x, 0, 0.3), box(0.08, 0.3, 0.08, x, 0, -0.3)])]);
  return merge([box(0.36, 0.4, 1, 0, 0.55, 0), box(0.16, 0.45, 0.16, 0, 0.8, 0.5), box(0.2, 0.2, 0.32, 0, 1.2, 0.62), ...[-0.12, 0.12].flatMap((x) => [box(0.07, 0.56, 0.07, x, 0, 0.4), box(0.07, 0.56, 0.07, x, 0, -0.4)])]);
}

/** Tree parts, unit height (trunk + crown separately so crowns can be tinted by species and season). */
export function treeTrunk(): THREE.BufferGeometry { return merge([cyl(0.025, 0.04, 1, 5, 0, 0, 0, 0x5b4330)]); }
export function conifer(): THREE.BufferGeometry { return merge([cone(1, 0.72, 7, 0, 0.26, 0, 0xffffff), cone(0.75, 0.5, 7, 0, 0.52, 0, 0xffffff)]); }
export function broadleaf(): THREE.BufferGeometry { const g = sphere(1, 0, 0.62, 0, 0xffffff, 1); g.scale(1, 0.55, 1); g.translate(0, 0.28, 0); return merge([g]); }
export function palm(): THREE.BufferGeometry { const g = cone(1, 0.18, 7, 0, 0.86, 0, 0xffffff); return merge([g]); }
export function shrub(): THREE.BufferGeometry { const g = sphere(1, 0, 0.45, 0, 0xffffff, 0); g.scale(1, 0.75, 1); return merge([g]); }
export function boulder(): THREE.BufferGeometry { const g = new THREE.DodecahedronGeometry(1, 0).toNonIndexed(); g.scale(1, 0.6, 0.85); g.translate(0, 0.3, 0); return merge([paint(g, 0xffffff)]); }

/** A whale or shark seen at the surface, body length 1 along +z (dark back, pale belly comes from the instance colour). */
export function whaleModel(): THREE.BufferGeometry {
  const body = sphere(0.5, 0, 0, 0, 0xffffff, 1);
  body.scale(0.22, 0.16, 1);
  const fluke = box(0.34, 0.02, 0.1, 0, -0.01, -0.52, 0xffffff);
  const fin = cone(0.05, 0.12, 4, 0, 0.06, 0.05, 0xffffff);
  return merge([body, fluke, fin]);
}
