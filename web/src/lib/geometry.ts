import * as THREE from "three";
import type { BoundingBox, GeometryData, SceneObject } from "../types";

export function uid(prefix = "id"): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

/**
 * Compute smooth vertex normals for curved faces while preserving hard creases above `creaseDeg`
 * (just like OrcaSlicer / Blender Auto-Smooth). Uses a fast quantized spatial hash in O(N).
 */
function computeAutoSmoothNormals(positions: Float32Array, faceNormals: Float32Array, creaseDeg = 38): Float32Array {
  const triCount = Math.floor(positions.length / 9);
  if (triCount === 0) return faceNormals;
  const cosThresh = Math.cos((creaseDeg * Math.PI) / 180);

  // Group triangle corner indices by quantized vertex position (0.001 mm tolerance)
  const buckets = new Map<string, number[]>();
  for (let t = 0; t < triCount; t++) {
    const base = t * 9;
    for (let c = 0; c < 3; c++) {
      const i = base + c * 3;
      const key = `${Math.round(positions[i] * 1000)},${Math.round(positions[i + 1] * 1000)},${Math.round(positions[i + 2] * 1000)}`;
      let list = buckets.get(key);
      if (!list) {
        list = [];
        buckets.set(key, list);
      }
      list.push(t);
    }
  }

  const out = new Float32Array(triCount * 9);
  for (let t = 0; t < triCount; t++) {
    const base = t * 9;
    const fnx = faceNormals[base];
    const fny = faceNormals[base + 1];
    const fnz = faceNormals[base + 2];

    for (let c = 0; c < 3; c++) {
      const i = base + c * 3;
      const key = `${Math.round(positions[i] * 1000)},${Math.round(positions[i + 1] * 1000)},${Math.round(positions[i + 2] * 1000)}`;
      const adj = buckets.get(key);
      if (!adj || adj.length <= 1 || adj.length > 48) {
        out[i] = fnx;
        out[i + 1] = fny;
        out[i + 2] = fnz;
        continue;
      }
      let sx = 0, sy = 0, sz = 0;
      for (let k = 0; k < adj.length; k++) {
        const nb = adj[k] * 9;
        const nx = faceNormals[nb], ny = faceNormals[nb + 1], nz = faceNormals[nb + 2];
        if (fnx * nx + fny * ny + fnz * nz >= cosThresh) {
          sx += nx;
          sy += ny;
          sz += nz;
        }
      }
      const len = Math.hypot(sx, sy, sz);
      if (len > 1e-8) {
        out[i] = sx / len;
        out[i + 1] = sy / len;
        out[i + 2] = sz / len;
      } else {
        out[i] = fnx;
        out[i + 1] = fny;
        out[i + 2] = fnz;
      }
    }
  }
  return out;
}

export function buildGeometryData(positions: Float32Array): GeometryData {
  const triCount = Math.floor(positions.length / 9);
  const faceNormals = new Float32Array(triCount * 9);
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let signedVol6 = 0;
  let areaSum = 0;

  for (let t = 0; t < triCount; t++) {
    const o = t * 9;
    const ax = positions[o], ay = positions[o + 1], az = positions[o + 2];
    const bx = positions[o + 3], by = positions[o + 4], bz = positions[o + 5];
    const cx = positions[o + 6], cy = positions[o + 7], cz = positions[o + 8];

    minX = Math.min(minX, ax, bx, cx);
    minY = Math.min(minY, ay, by, cy);
    minZ = Math.min(minZ, az, bz, cz);
    maxX = Math.max(maxX, ax, bx, cx);
    maxY = Math.max(maxY, ay, by, cy);
    maxZ = Math.max(maxZ, az, bz, cz);

    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    const len = Math.hypot(nx, ny, nz);
    areaSum += len * 0.5;
    const inv = len > 1e-12 ? 1 / len : 0;
    const unx = nx * inv, uny = ny * inv, unz = nz * inv;
    faceNormals[o] = unx; faceNormals[o + 1] = uny; faceNormals[o + 2] = unz;
    faceNormals[o + 3] = unx; faceNormals[o + 4] = uny; faceNormals[o + 5] = unz;
    faceNormals[o + 6] = unx; faceNormals[o + 7] = uny; faceNormals[o + 8] = unz;

    // Signed tetrahedron volume * 6 = a . (b x c)
    const bcx = by * cz - bz * cy;
    const bcy = bz * cx - bx * cz;
    const bcz = bx * cy - by * cx;
    signedVol6 += ax * bcx + ay * bcy + az * bcz;
  }

  if (!Number.isFinite(minX)) {
    minX = minY = minZ = maxX = maxY = maxZ = 0;
  }

  const bounds: BoundingBox = {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
    size: [maxX - minX, maxY - minY, maxZ - minZ],
    center: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
  };

  const posSlice = positions.subarray(0, triCount * 9);
  const normals = triCount <= 150000 ? computeAutoSmoothNormals(posSlice, faceNormals, 38) : faceNormals;

  return {
    positions: posSlice,
    normals,
    triangleCount: triCount,
    bounds,
    volumeMm3: Math.abs(signedVol6 / 6),
    surfaceAreaMm2: areaSum,
  };
}

/** Center XY on origin and ground min Z at 0. */
export function normalizeGeometry(rawPositions: Float32Array): GeometryData {
  const pre = buildGeometryData(rawPositions);
  const cx = pre.bounds.center[0];
  const cy = pre.bounds.center[1];
  const minZ = pre.bounds.min[2];
  const shifted = new Float32Array(pre.positions.length);
  for (let i = 0; i < pre.positions.length; i += 3) {
    shifted[i] = pre.positions[i] - cx;
    shifted[i + 1] = pre.positions[i + 1] - cy;
    shifted[i + 2] = pre.positions[i + 2] - minZ;
  }
  return buildGeometryData(shifted);
}

export function getObjectMatrix(obj: Pick<SceneObject, "position" | "rotation" | "scale">): THREE.Matrix4 {
  const m = new THREE.Matrix4();
  const pos = new THREE.Vector3(obj.position[0], obj.position[1], obj.position[2]);
  const quat = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(
      THREE.MathUtils.degToRad(obj.rotation[0]),
      THREE.MathUtils.degToRad(obj.rotation[1]),
      THREE.MathUtils.degToRad(obj.rotation[2]),
      "XYZ"
    )
  );
  const scl = new THREE.Vector3(obj.scale[0], obj.scale[1], obj.scale[2]);
  m.compose(pos, quat, scl);
  return m;
}

export function transformPositions(positions: Float32Array, matrix: THREE.Matrix4): Float32Array {
  const out = new Float32Array(positions.length);
  const e = matrix.elements;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    out[i] = e[0] * x + e[4] * y + e[8] * z + e[12];
    out[i + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
    out[i + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
  }
  return out;
}

export function getObjectWorldBounds(obj: SceneObject): BoundingBox {
  const worldPos = transformPositions(obj.geometry.positions, getObjectMatrix(obj));
  return buildGeometryData(worldPos).bounds;
}

/** Drop an object so its lowest rotated/scaled vertex rests flush at Z = 0. */
export function groundObjectPosition(obj: SceneObject): [number, number, number] {
  const wb = getObjectWorldBounds(obj);
  return [obj.position[0], obj.position[1], Number((obj.position[2] - wb.min[2]).toFixed(3))];
}

/** Parse binary or ASCII STL into normalized GeometryData. */
export function parseSTL(buffer: ArrayBuffer): GeometryData {
  const view = new DataView(buffer);
  const byteLen = buffer.byteLength;
  const isBinary =
    byteLen >= 84 &&
    (() => {
      const count = view.getUint32(80, true);
      return count > 0 && 84 + count * 50 === byteLen;
    })();

  if (isBinary) {
    const count = view.getUint32(80, true);
    const positions = new Float32Array(count * 9);
    let offset = 84;
    for (let i = 0; i < count; i++) {
      offset += 12; // skip face normal
      for (let v = 0; v < 9; v++) {
        positions[i * 9 + v] = view.getFloat32(offset, true);
        offset += 4;
      }
      offset += 2; // attribute byte count
    }
    return normalizeGeometry(positions);
  }

  const text = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  const verts: number[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("vertex")) {
      const parts = line.split(/\s+/);
      if (parts.length >= 4) {
        const x = parseFloat(parts[1]);
        const y = parseFloat(parts[2]);
        const z = parseFloat(parts[3]);
        if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
          verts.push(x, y, z);
        }
      }
    }
  }
  if (verts.length < 9) {
    throw new Error("STL file contains no valid triangles");
  }
  return normalizeGeometry(new Float32Array(verts));
}

/** Parse Wavefront OBJ into normalized GeometryData. */
export function parseOBJ(text: string): GeometryData {
  const vList: number[] = [];
  const positions: number[] = [];
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === "v" && parts.length >= 4) {
      vList.push(parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3]));
    } else if (parts[0] === "f" && parts.length >= 4) {
      const idx: number[] = [];
      for (let i = 1; i < parts.length; i++) {
        const rawIdx = parseInt(parts[i].split("/")[0], 10);
        if (!Number.isFinite(rawIdx)) continue;
        const resolved = rawIdx < 0 ? vList.length / 3 + rawIdx : rawIdx - 1;
        idx.push(resolved);
      }
      // Fan triangulate polygon faces
      for (let k = 1; k + 1 < idx.length; k++) {
        const a = idx[0] * 3, b = idx[k] * 3, c = idx[k + 1] * 3;
        positions.push(
          vList[a], vList[a + 1], vList[a + 2],
          vList[b], vList[b + 1], vList[b + 2],
          vList[c], vList[c + 1], vList[c + 2]
        );
      }
    }
  }
  if (positions.length < 9) {
    throw new Error("OBJ file contains no valid faces");
  }
  return normalizeGeometry(new Float32Array(positions));
}

/** Export triangle positions to standard Binary STL bytes. */
export function exportBinarySTL(positions: Float32Array): Uint8Array {
  const triCount = Math.floor(positions.length / 9);
  const out = new Uint8Array(84 + triCount * 50);
  const header = new TextEncoder().encode("OrcaCloud Binary STL");
  out.set(header.subarray(0, Math.min(80, header.length)), 0);
  const view = new DataView(out.buffer);
  view.setUint32(80, triCount, true);

  let offset = 84;
  for (let t = 0; t < triCount; t++) {
    const o = t * 9;
    const ax = positions[o], ay = positions[o + 1], az = positions[o + 2];
    const bx = positions[o + 3], by = positions[o + 4], bz = positions[o + 5];
    const cx = positions[o + 6], cy = positions[o + 7], cz = positions[o + 8];
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    const len = Math.hypot(nx, ny, nz) || 1;
    view.setFloat32(offset, nx / len, true);
    view.setFloat32(offset + 4, ny / len, true);
    view.setFloat32(offset + 8, nz / len, true);
    offset += 12;
    for (let k = 0; k < 9; k++) {
      view.setFloat32(offset, positions[o + k], true);
      offset += 4;
    }
    view.setUint16(offset, 0, true);
    offset += 2;
  }
  return out;
}

/** Merge all visible objects on a plate (applying transforms) into one Binary STL. */
export function exportPlateToBinarySTL(objects: SceneObject[]): Uint8Array {
  const visible = objects.filter((o) => o.visible);
  let total = 0;
  const transformed: Float32Array[] = [];
  for (const obj of visible) {
    const pos = transformPositions(obj.geometry.positions, getObjectMatrix(obj));
    transformed.push(pos);
    total += pos.length;
  }
  const merged = new Float32Array(total);
  let off = 0;
  for (const arr of transformed) {
    merged.set(arr, off);
    off += arr.length;
  }
  return exportBinarySTL(merged);
}

export type PrimitiveKind =
  | "cube"
  | "cylinder"
  | "sphere"
  | "cone"
  | "torus"
  | "disc"
  | "calibration_cube"
  | "benchy_test";

function bufferGeomToPositions(geom: THREE.BufferGeometry): Float32Array {
  const ni = geom.index ? geom.toNonIndexed() : geom;
  const arr = new Float32Array(ni.getAttribute("position").array as Float32Array);
  if (ni !== geom) ni.dispose();
  geom.dispose();
  return arr;
}

function mergePositionArrays(arrays: Float32Array[]): Float32Array {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

export function createPrimitiveGeometry(kind: PrimitiveKind, size = 25): GeometryData {
  if (kind === "cube" || kind === "calibration_cube") {
    const s = kind === "calibration_cube" ? 20 : size;
    const g = new THREE.BoxGeometry(s, s, s);
    return normalizeGeometry(bufferGeomToPositions(g));
  }
  if (kind === "cylinder") {
    const g = new THREE.CylinderGeometry(size / 2, size / 2, size, 48);
    g.rotateX(Math.PI / 2);
    return normalizeGeometry(bufferGeomToPositions(g));
  }
  if (kind === "disc") {
    const g = new THREE.CylinderGeometry(size * 0.75, size * 0.75, Math.max(2, size * 0.16), 48);
    g.rotateX(Math.PI / 2);
    return normalizeGeometry(bufferGeomToPositions(g));
  }
  if (kind === "sphere") {
    const g = new THREE.SphereGeometry(size / 2, 36, 24);
    return normalizeGeometry(bufferGeomToPositions(g));
  }
  if (kind === "cone") {
    const g = new THREE.ConeGeometry(size / 2, size * 1.15, 48);
    g.rotateX(Math.PI / 2);
    return normalizeGeometry(bufferGeomToPositions(g));
  }
  if (kind === "torus") {
    const g = new THREE.TorusGeometry(size * 0.42, size * 0.16, 24, 48);
    return normalizeGeometry(bufferGeomToPositions(g));
  }

  // Stylized boat / overhang benchmark model (flat hull base at Z=0 so first layer is always solid)
  const parts: Float32Array[] = [];
  const addBox = (w: number, d: number, h: number, x: number, y: number, z: number, rx = 0, ry = 0) => {
    const g = new THREE.BoxGeometry(w, d, h);
    if (rx) g.rotateX(rx);
    if (ry) g.rotateY(ry);
    g.translate(x, y, z);
    parts.push(bufferGeomToPositions(g));
  };
  const addCyl = (rt: number, rb: number, h: number, x: number, y: number, z: number) => {
    const g = new THREE.CylinderGeometry(rt, rb, h, 28);
    g.rotateX(Math.PI / 2);
    g.translate(x, y, z);
    parts.push(bufferGeomToPositions(g));
  };
  // Solid flat-bottom hull resting cleanly at Z=0..12
  addBox(38, 22, 12, -2, 0, 6);
  // Tapered bow steps that stay strictly above Z=0
  addBox(12, 18, 12, 21, 0, 6);
  addBox(8, 12, 11, 28, 0, 5.5);
  // Deck & cabin pillars
  addBox(22, 16, 2, -2, 0, 13);
  addBox(3.5, 3.5, 13, -10.5, -6.2, 20.5);
  addBox(3.5, 3.5, 13, -10.5, 6.2, 20.5);
  addBox(3.5, 3.5, 13, 6.5, -6.2, 20.5);
  addBox(3.5, 3.5, 13, 6.5, 6.2, 20.5);
  // Roof overhang
  addBox(23, 18, 2.6, -2, 0, 28.3);
  // Chimney stack
  addCyl(3.5, 3.2, 9.5, -6, 0, 34.3);
  return normalizeGeometry(mergePositionArrays(parts));
}

/** Mirror geometry across X, Y, or Z while preserving outward triangle winding. */
export function mirrorGeometry(geom: GeometryData, axis: "x" | "y" | "z"): GeometryData {
  const src = geom.positions;
  const out = new Float32Array(src.length);
  const axisIdx = axis === "x" ? 0 : axis === "y" ? 1 : 2;
  const triCount = geom.triangleCount;
  for (let t = 0; t < triCount; t++) {
    const o = t * 9;
    // Flip winding by swapping vertex 1 and vertex 2
    for (let k = 0; k < 3; k++) {
      const sign = k === axisIdx ? -1 : 1;
      out[o + k] = src[o + k] * sign;
      out[o + 3 + k] = src[o + 6 + k] * sign;
      out[o + 6 + k] = src[o + 3 + k] * sign;
    }
  }
  return normalizeGeometry(out);
}

/** Cut a mesh along horizontal plane Z = zCut in local object coordinates, returning capped upper & lower meshes. */
export function cutGeometryAtZ(
  geom: GeometryData,
  zCut: number
): { upper: GeometryData | null; lower: GeometryData | null } {
  const pos = geom.positions;
  const upperVerts: number[] = [];
  const lowerVerts: number[] = [];
  const capEdges: Array<[number, number, number, number]> = [];

  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

  for (let t = 0; t < geom.triangleCount; t++) {
    const o = t * 9;
    const pts: Array<[number, number, number]> = [
      [pos[o], pos[o + 1], pos[o + 2]],
      [pos[o + 3], pos[o + 4], pos[o + 5]],
      [pos[o + 6], pos[o + 7], pos[o + 8]],
    ];
    const d = pts.map((p) => p[2] - zCut);
    const above = [0, 1, 2].filter((i) => d[i] >= 0);
    const below = [0, 1, 2].filter((i) => d[i] < 0);

    if (above.length === 3) {
      upperVerts.push(...pts[0], ...pts[1], ...pts[2]);
    } else if (below.length === 3) {
      lowerVerts.push(...pts[0], ...pts[1], ...pts[2]);
    } else {
      // One vertex on one side, two on the other
      const loneAbove = above.length === 1;
      const i0 = loneAbove ? above[0] : below[0];
      // Preserve cyclic winding (i0 -> i1 -> i2)
      const i1 = (i0 + 1) % 3;
      const i2 = (i0 + 2) % 3;
      const p0 = pts[i0], p1 = pts[i1], p2 = pts[i2];
      const t01 = d[i0] / (d[i0] - d[i1]);
      const t02 = d[i0] / (d[i0] - d[i2]);
      const q1: [number, number, number] = [lerp(p0[0], p1[0], t01), lerp(p0[1], p1[1], t01), zCut];
      const q2: [number, number, number] = [lerp(p0[0], p2[0], t02), lerp(p0[1], p2[1], t02), zCut];

      if (loneAbove) {
        upperVerts.push(...p0, ...q1, ...q2);
        lowerVerts.push(...q1, ...p1, ...p2, ...q1, ...p2, ...q2);
        capEdges.push([q1[0], q1[1], q2[0], q2[1]]);
      } else {
        lowerVerts.push(...p0, ...q1, ...q2);
        upperVerts.push(...q1, ...p1, ...p2, ...q1, ...p2, ...q2);
        capEdges.push([q2[0], q2[1], q1[0], q1[1]]);
      }
    }
  }

  // Planar fan-cap at zCut using centroid of cut edges so cut faces stay solid & sliceable
  if (capEdges.length >= 3) {
    let cx = 0, cy = 0;
    for (const [x1, y1, x2, y2] of capEdges) {
      cx += x1 + x2;
      cy += y1 + y2;
    }
    cx /= capEdges.length * 2;
    cy /= capEdges.length * 2;
    for (const [x1, y1, x2, y2] of capEdges) {
      // Downward-facing cap for upper half, upward-facing cap for lower half
      upperVerts.push(cx, cy, zCut, x2, y2, zCut, x1, y1, zCut);
      lowerVerts.push(cx, cy, zCut, x1, y1, zCut, x2, y2, zCut);
    }
  }

  return {
    upper: upperVerts.length >= 9 ? normalizeGeometry(new Float32Array(upperVerts)) : null,
    lower: lowerVerts.length >= 9 ? normalizeGeometry(new Float32Array(lowerVerts)) : null,
  };
}

/** Split disconnected triangle shells (Union-Find on quantized shared vertices) into independent objects. */
export function splitDisconnectedShells(
  worldPositions: Float32Array
): Array<{ geometry: GeometryData; centerXY: [number, number]; minZ: number }> {
  const triCount = Math.floor(worldPositions.length / 9);
  if (triCount === 0) return [];

  const parent = new Int32Array(triCount);
  for (let i = 0; i < triCount; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  const vertOwner = new Map<string, number>();
  for (let t = 0; t < triCount; t++) {
    const o = t * 9;
    for (let k = 0; k < 3; k++) {
      const vx = Math.round(worldPositions[o + k * 3] * 1000);
      const vy = Math.round(worldPositions[o + k * 3 + 1] * 1000);
      const vz = Math.round(worldPositions[o + k * 3 + 2] * 1000);
      const key = `${vx},${vy},${vz}`;
      const prev = vertOwner.get(key);
      if (prev !== undefined) union(t, prev);
      else vertOwner.set(key, t);
    }
  }

  const groups = new Map<number, number[]>();
  for (let t = 0; t < triCount; t++) {
    const r = find(t);
    let list = groups.get(r);
    if (!list) {
      list = [];
      groups.set(r, list);
    }
    list.push(t);
  }

  const results: Array<{ geometry: GeometryData; centerXY: [number, number]; minZ: number }> = [];
  for (const tris of groups.values()) {
    const arr = new Float32Array(tris.length * 9);
    for (let i = 0; i < tris.length; i++) {
      const src = tris[i] * 9;
      for (let k = 0; k < 9; k++) arr[i * 9 + k] = worldPositions[src + k];
    }
    const rawBounds = buildGeometryData(arr).bounds;
    results.push({
      geometry: normalizeGeometry(arr),
      centerXY: [rawBounds.center[0], rawBounds.center[1]],
      minZ: Math.max(0, rawBounds.min[2]),
    });
  }
  return results;
}

/** Shelf bin-packing auto-arrange onto the printer bed with spacing. */
export function arrangeObjectsOnBed(
  objects: SceneObject[],
  buildVolume: [number, number, number],
  gapMm = 6
): SceneObject[] {
  const [bedW, bedD] = buildVolume;
  const items = objects.map((obj) => {
    const b = getObjectWorldBounds(obj);
    return { obj, w: b.size[0], d: b.size[1] };
  });
  // Sort tallest depth first for compact shelf packing
  items.sort((a, b) => b.d - a.d || b.w - a.w);

  let curX = 0;
  let curY = 0;
  let rowH = 0;
  const placed: Array<{ obj: SceneObject; x: number; y: number; w: number; d: number }> = [];
  const maxRowW = Math.max(20, bedW - 16);

  for (const item of items) {
    if (curX > 0 && curX + item.w > maxRowW) {
      curX = 0;
      curY += rowH + gapMm;
      rowH = 0;
    }
    placed.push({ obj: item.obj, x: curX + item.w / 2, y: curY + item.d / 2, w: item.w, d: item.d });
    curX += item.w + gapMm;
    rowH = Math.max(rowH, item.d);
  }

  // Center packed cluster on the build plate
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of placed) {
    minX = Math.min(minX, p.x - p.w / 2);
    maxX = Math.max(maxX, p.x + p.w / 2);
    minY = Math.min(minY, p.y - p.d / 2);
    maxY = Math.max(maxY, p.y + p.d / 2);
  }
  const offsetX = bedW / 2 - (minX + maxX) / 2;
  const offsetY = bedD / 2 - (minY + maxY) / 2;

  const byId = new Map<string, [number, number]>();
  for (const p of placed) {
    byId.set(p.obj.id, [Number((p.x + offsetX).toFixed(2)), Number((p.y + offsetY).toFixed(2))]);
  }

  return objects.map((obj) => {
    const xy = byId.get(obj.id);
    if (!xy) return obj;
    const moved: SceneObject = { ...obj, position: [xy[0], xy[1], obj.position[2]] };
    return { ...moved, position: groundObjectPosition(moved) };
  });
}

/** Rotate an object so a clicked world-space face normal points straight down (-Z) onto the bed. */
export function computeLayOnFaceRotation(
  obj: SceneObject,
  worldFaceNormal: THREE.Vector3
): [number, number, number] {
  const currentQuat = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(
      THREE.MathUtils.degToRad(obj.rotation[0]),
      THREE.MathUtils.degToRad(obj.rotation[1]),
      THREE.MathUtils.degToRad(obj.rotation[2]),
      "XYZ"
    )
  );
  const target = new THREE.Vector3(0, 0, -1);
  const n = worldFaceNormal.clone().normalize();
  const delta = new THREE.Quaternion().setFromUnitVectors(n, target);
  const nextQuat = delta.multiply(currentQuat);
  const euler = new THREE.Euler().setFromQuaternion(nextQuat, "XYZ");
  return [
    Number(THREE.MathUtils.radToDeg(euler.x).toFixed(2)),
    Number(THREE.MathUtils.radToDeg(euler.y).toFixed(2)),
    Number(THREE.MathUtils.radToDeg(euler.z).toFixed(2)),
  ];
}

/** Generate extruded 3D text block geometry using a crisp 5x7 vector pixel-font so Emboss Text works offline. */
const FONT_5X7: Record<string, string[]> = {
  A: ["01110","10001","10001","11111","10001","10001","10001"],
  B: ["11110","10001","10001","11110","10001","10001","11110"],
  C: ["01111","10000","10000","10000","10000","10000","01111"],
  D: ["11110","10001","10001","10001","10001","10001","11110"],
  E: ["11111","10000","10000","11110","10000","10000","11111"],
  F: ["11111","10000","10000","11110","10000","10000","10000"],
  G: ["01111","10000","10000","10111","10001","10001","01110"],
  H: ["10001","10001","10001","11111","10001","10001","10001"],
  I: ["11111","00100","00100","00100","00100","00100","11111"],
  J: ["00111","00010","00010","00010","10010","10010","01100"],
  K: ["10001","10010","10100","11000","10100","10010","10001"],
  L: ["10000","10000","10000","10000","10000","10000","11111"],
  M: ["10001","11011","10101","10101","10001","10001","10001"],
  N: ["10001","11001","10101","10011","10001","10001","10001"],
  O: ["01110","10001","10001","10001","10001","10001","01110"],
  P: ["11110","10001","10001","11110","10000","10000","10000"],
  Q: ["01110","10001","10001","10001","10101","10010","01101"],
  R: ["11110","10001","10001","11110","10100","10010","10001"],
  S: ["01111","10000","10000","01110","00001","00001","11110"],
  T: ["11111","00100","00100","00100","00100","00100","00100"],
  U: ["10001","10001","10001","10001","10001","10001","01110"],
  V: ["10001","10001","10001","10001","10001","01010","00100"],
  W: ["10001","10001","10001","10101","10101","11011","10001"],
  X: ["10001","10001","01010","00100","01010","10001","10001"],
  Y: ["10001","10001","01010","00100","00100","00100","00100"],
  Z: ["11111","00001","00010","00100","01000","10000","11111"],
  "0": ["01110","10011","10101","10101","11001","10001","01110"],
  "1": ["00100","01100","00100","00100","00100","00100","01110"],
  "2": ["01110","10001","00001","00110","01000","10000","11111"],
  "3": ["11110","00001","00001","01110","00001","00001","11110"],
  "4": ["00010","00110","01010","10010","11111","00010","00010"],
  "5": ["11111","10000","11110","00001","00001","10001","01110"],
  "6": ["01110","10000","11110","10001","10001","10001","01110"],
  "7": ["11111","00001","00010","00100","01000","01000","01000"],
  "8": ["01110","10001","10001","01110","10001","10001","01110"],
  "9": ["01110","10001","10001","01111","00001","00001","01110"],
  "-": ["00000","00000","00000","11111","00000","00000","00000"],
  ".": ["00000","00000","00000","00000","00000","01100","01100"],
  " ": ["00000","00000","00000","00000","00000","00000","00000"],
};

export function createTextGeometry(text: string, heightMm = 12, depthMm = 2.4): GeometryData {
  const clean = (text.trim().toUpperCase() || "ORCA").slice(0, 24);
  const pixel = heightMm / 7;
  const chunks: Float32Array[] = [];
  let cursorX = 0;

  for (const ch of clean) {
    const glyph = FONT_5X7[ch] || FONT_5X7[" "];
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (glyph[row][col] === "1") {
          const g = new THREE.BoxGeometry(pixel * 1.02, pixel * 1.02, depthMm);
          g.translate(cursorX + col * pixel, (6 - row) * pixel, depthMm / 2);
          chunks.push(bufferGeomToPositions(g));
        }
      }
    }
    cursorX += 6 * pixel;
  }

  if (chunks.length === 0) {
    return createPrimitiveGeometry("cube", 10);
  }
  return normalizeGeometry(mergePositionArrays(chunks));
}
