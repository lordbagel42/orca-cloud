import * as THREE from "three";
import { parseSTL } from "./geometry";
import { getApiConfig } from "./api";

const stlCache = new Map<string, Promise<THREE.BufferGeometry | null>>();
const svgImageCache = new Map<string, Promise<HTMLImageElement | null>>();

function candidateUrls(assetUrl: string): string[] {
  const urls: string[] = [];
  const base = getApiConfig().baseUrl.replace(/\/+$/, "");
  if (assetUrl.startsWith("/v2/assets/")) {
    urls.push(`${base}${assetUrl}`);
    // Static fallback in web/public/assets/<vendor>/<file>
    urls.push(`/assets/${assetUrl.slice("/v2/assets/".length)}`);
  } else {
    urls.push(assetUrl);
  }
  return urls;
}

async function fetchFirstOk(urls: string[]): Promise<Response | null> {
  for (const url of urls) {
    try {
      const resp = await fetch(url);
      if (resp.ok) return resp;
    } catch {
      // try next candidate
    }
  }
  return null;
}

function parseRawSTLToBufferGeometry(buffer: ArrayBuffer): THREE.BufferGeometry | null {
  const view = new DataView(buffer);
  const byteLen = buffer.byteLength;
  const isBinary =
    byteLen >= 84 &&
    (() => {
      const count = view.getUint32(80, true);
      return count > 0 && 84 + count * 50 === byteLen;
    })();

  let positions: Float32Array;
  let normals: Float32Array;

  if (isBinary) {
    const count = view.getUint32(80, true);
    positions = new Float32Array(count * 9);
    normals = new Float32Array(count * 9);
    let offset = 84;
    for (let i = 0; i < count; i++) {
      const nx = view.getFloat32(offset, true);
      const ny = view.getFloat32(offset + 4, true);
      const nz = view.getFloat32(offset + 8, true);
      offset += 12;
      const base = i * 9;
      for (let v = 0; v < 9; v++) {
        positions[base + v] = view.getFloat32(offset, true);
        offset += 4;
      }
      offset += 2;
      // Compute crisp geometric face normal if STL normal is zero
      let fx = nx, fy = ny, fz = nz;
      const nLen = Math.hypot(fx, fy, fz);
      if (nLen < 1e-5) {
        const ax = positions[base + 3] - positions[base];
        const ay = positions[base + 4] - positions[base + 1];
        const az = positions[base + 5] - positions[base + 2];
        const bx = positions[base + 6] - positions[base];
        const by = positions[base + 7] - positions[base + 1];
        const bz = positions[base + 8] - positions[base + 2];
        fx = ay * bz - az * by;
        fy = az * bx - ax * bz;
        fz = ax * by - ay * bx;
      }
      const len = Math.hypot(fx, fy, fz) || 1;
      fx /= len; fy /= len; fz /= len;
      for (let v = 0; v < 3; v++) {
        normals[base + v * 3] = fx;
        normals[base + v * 3 + 1] = fy;
        normals[base + v * 3 + 2] = fz;
      }
    }
  } else {
    const parsed = parseSTL(buffer);
    if (parsed.triangleCount === 0) return null;
    positions = parsed.positions;
    normals = parsed.normals;
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geom.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geom.computeBoundingBox();
  geom.computeBoundingSphere();
  return geom;
}

/**
 * Loads and caches an official printer STL model (e.g. bbl-3dp-A1M.stl, bbl-3dp-X1.stl, bbl-3dp-hotend.stl)
 * preserving its exact native OrcaSlicer bed/nozzle coordinates (no auto-centering).
 * Returns a shared THREE.BufferGeometry — callers should not dispose it.
 */
export function loadPrinterAssetSTL(assetUrl: string): Promise<THREE.BufferGeometry | null> {
  const existing = stlCache.get(assetUrl);
  if (existing) return existing;

  const task = (async () => {
    const resp = await fetchFirstOk(candidateUrls(assetUrl));
    if (!resp) return null;
    const buf = await resp.arrayBuffer();
    return parseRawSTLToBufferGeometry(buf);
  })();

  stlCache.set(assetUrl, task);
  return task;
}

/**
 * Loads and caches an official printer bed SVG texture (e.g. bbl-3dp-logo.svg) as an HTMLImageElement
 * ready to composite onto the bed surface canvas.
 */
export function loadPrinterAssetSVG(assetUrl: string): Promise<HTMLImageElement | null> {
  const existing = svgImageCache.get(assetUrl);
  if (existing) return existing;

  const task = (async () => {
    const resp = await fetchFirstOk(candidateUrls(assetUrl));
    if (!resp) return null;
    const svgText = await resp.text();
    if (!svgText.includes("<svg")) return null;
    const blob = new Blob([svgText], { type: "image/svg+xml;charset=utf-8" });
    const blobUrl = URL.createObjectURL(blob);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("SVG decode failed"));
        el.src = blobUrl;
      });
      return img;
    } catch {
      return null;
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  })();

  svgImageCache.set(assetUrl, task);
  return task;
}
