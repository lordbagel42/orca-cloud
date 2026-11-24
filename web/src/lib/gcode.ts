import type { GcodeFeatureType, GcodeLayer, GcodeStats, ParsedGcode } from "../types";

export const FEATURE_COLORS: Record<GcodeFeatureType, string> = {
  "Outer wall": "#f97316",
  "Inner wall": "#eab308",
  "Overhang wall": "#2563eb",
  "Sparse infill": "#991b1b",
  "Internal solid infill": "#a855f7",
  "Top surface": "#dc2626",
  "Bottom surface": "#22c55e",
  Support: "#10b981",
  "Support interface": "#14b8a6",
  Bridge: "#38bdf8",
  "Gap infill": "#ec4899",
  Skirt: "#84cc16",
  Brim: "#65a30d",
  "Prime tower": "#f59e0b",
  Custom: "#c084fc",
  Travel: "#38bdf8",
  Unknown: "#94a3b8",
};

export const ALL_FEATURE_TYPES: GcodeFeatureType[] = [
  "Outer wall",
  "Inner wall",
  "Overhang wall",
  "Sparse infill",
  "Internal solid infill",
  "Top surface",
  "Bottom surface",
  "Support",
  "Support interface",
  "Bridge",
  "Gap infill",
  "Skirt",
  "Brim",
  "Prime tower",
  "Custom",
  "Travel",
];

export const FEATURE_TO_INDEX: Record<GcodeFeatureType, number> = Object.fromEntries(
  [...ALL_FEATURE_TYPES, "Unknown" as GcodeFeatureType].map((f, i) => [f, i])
) as Record<GcodeFeatureType, number>;

export const INDEX_TO_FEATURE: GcodeFeatureType[] = [...ALL_FEATURE_TYPES, "Unknown"];

function normalizeFeatureType(raw: string): GcodeFeatureType {
  const s = raw.trim().toLowerCase();
  if (s === "outer wall" || s === "external perimeter") return "Outer wall";
  if (s === "inner wall" || s === "perimeter") return "Inner wall";
  if (s.includes("overhang")) return "Overhang wall";
  if (s === "sparse infill" || s === "internal infill") return "Sparse infill";
  if (s === "internal solid infill" || s === "solid infill") return "Internal solid infill";
  if (s === "top surface" || s === "top solid infill") return "Top surface";
  if (s === "bottom surface") return "Bottom surface";
  if (s === "support interface" || s === "support material interface" || s === "support transition") return "Support interface";
  if (s.startsWith("support")) return "Support";
  if (s.includes("bridge")) return "Bridge";
  if (s.includes("gap")) return "Gap infill";
  if (s.includes("skirt")) return "Skirt";
  if (s.includes("brim")) return "Brim";
  if (s.includes("prime") || s.includes("wipe tower")) return "Prime tower";
  if (s.includes("custom")) return "Custom";
  return "Unknown";
}

const MAX_SEGMENTS = 650_000;

/**
 * Parse real OrcaSlicer G-code into typed segment buffers for interactive 60fps WebGL rendering.
 * Handles G0/G1 linear moves, G2/G3 IJ arcs, M82/M83 extrusion modes, tool changes,
 * feedrates, temperatures, fan speeds, retractions, seams, and feature breakdown.
 */
export function parseGcode(text: string): ParsedGcode {
  const lines = text.split(/\r?\n/);

  // Dynamic growable buffers
  let cap = 32768;
  let segCount = 0;
  let starts = new Float32Array(cap * 3);
  let ends = new Float32Array(cap * 3);
  let features = new Uint8Array(cap);
  let filaments = new Uint8Array(cap);
  let speeds = new Float32Array(cap);
  let flows = new Float32Array(cap);
  let layerHeights = new Float32Array(cap);
  let lineWidths = new Float32Array(cap);
  let fanSpeeds = new Float32Array(cap);
  let temps = new Float32Array(cap);
  let layersArr = new Uint16Array(cap);
  let lineNumbers = new Uint32Array(cap);

  const grow = () => {
    const nextCap = Math.min(MAX_SEGMENTS, cap * 2);
    if (nextCap <= cap) return false;
    const growF32 = (a: Float32Array, stride: number) => {
      const b = new Float32Array(nextCap * stride);
      b.set(a);
      return b;
    };
    const growU8 = (a: Uint8Array) => {
      const b = new Uint8Array(nextCap);
      b.set(a);
      return b;
    };
    const growU16 = (a: Uint16Array) => {
      const b = new Uint16Array(nextCap);
      b.set(a);
      return b;
    };
    const growU32 = (a: Uint32Array) => {
      const b = new Uint32Array(nextCap);
      b.set(a);
      return b;
    };
    starts = growF32(starts, 3);
    ends = growF32(ends, 3);
    features = growU8(features);
    filaments = growU8(filaments);
    speeds = growF32(speeds, 1);
    flows = growF32(flows, 1);
    layerHeights = growF32(layerHeights, 1);
    lineWidths = growF32(lineWidths, 1);
    fanSpeeds = growF32(fanSpeeds, 1);
    temps = growF32(temps, 1);
    layersArr = growU16(layersArr);
    lineNumbers = growU32(lineNumbers);
    cap = nextCap;
    return true;
  };

  const retractions: number[] = [];
  const seams: number[] = [];
  const layers: GcodeLayer[] = [];

  let x = 0;
  let y = 0;
  let z = 0;
  let e = 0;
  let relativeXYZ = false;
  let relativeE = true; // OrcaSlicer defaults to M83 relative extrusion
  let feedrateMmS = 60;
  let currentFeature: GcodeFeatureType = "Unknown";
  let currentFilament = 0;
  let currentLayerHeight = 0.2;
  let currentLineWidth = 0.42;
  let currentFanPct = 0;
  let currentTemp = 210;
  let currentLayerIdx = -1;
  let seenFirstLayerMarker = false;
  let lastWasTravel = true;
  let truncated = false;

  const featureTimeSec = new Map<GcodeFeatureType, number>();
  const featureDistMm = new Map<GcodeFeatureType, number>();
  let totalExtrudedMm = 0;
  let totalTimeSec = 0;

  let minSpeed = Infinity, maxSpeed = 0;
  let minFlow = Infinity, maxFlow = 0;
  let minLH = Infinity, maxLH = 0;
  let minLW = Infinity, maxLW = 0;
  let minTemp = Infinity, maxTemp = 0;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  const filamentArea = Math.PI * (1.75 / 2) * (1.75 / 2); // ~2.4053 mm²

  const startNewLayer = (layerZ: number, lineIdx: number) => {
    if (layers.length > 0) {
      layers[layers.length - 1].endSegment = segCount;
    }
    currentLayerIdx = layers.length;
    layers.push({
      index: currentLayerIdx,
      z: layerZ,
      height: currentLayerHeight,
      startSegment: segCount,
      endSegment: segCount,
      startLine: lineIdx,
    });
  };

  const pushSegment = (
    sx: number, sy: number, sz: number,
    ex: number, ey: number, ez: number,
    de: number,
    lineIdx: number
  ) => {
    const dx = ex - sx;
    const dy = ey - sy;
    const dz = ez - sz;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < 1e-5) return;

    const isExtrude = de > 1e-6;
    const feat: GcodeFeatureType = isExtrude ? currentFeature : "Travel";
    const speed = Math.max(1, feedrateMmS);
    const dt = dist / speed;
    totalTimeSec += dt;
    featureTimeSec.set(feat, (featureTimeSec.get(feat) || 0) + dt);
    featureDistMm.set(feat, (featureDistMm.get(feat) || 0) + dist);

    // Only visualize moves after first layer or inside positive build Z when extruding
    if (currentLayerIdx < 0 && isExtrude) {
      startNewLayer(ez, lineIdx);
    }
    if (currentLayerIdx < 0) return;

    if (isExtrude) {
      totalExtrudedMm += de;
      if (lastWasTravel && (feat === "Outer wall" || feat === "Inner wall")) {
        seams.push(sx, sy, sz);
      }
      lastWasTravel = false;
    } else {
      lastWasTravel = true;
    }

    if (segCount >= cap && !grow()) {
      truncated = true;
      return;
    }

    const volFlow = isExtrude ? (de * filamentArea) / Math.max(dt, 1e-4) : 0;
    const i3 = segCount * 3;
    starts[i3] = sx; starts[i3 + 1] = sy; starts[i3 + 2] = sz;
    ends[i3] = ex; ends[i3 + 1] = ey; ends[i3 + 2] = ez;
    features[segCount] = FEATURE_TO_INDEX[feat] ?? FEATURE_TO_INDEX.Unknown;
    filaments[segCount] = currentFilament;
    speeds[segCount] = speed;
    flows[segCount] = volFlow;
    layerHeights[segCount] = currentLayerHeight;
    lineWidths[segCount] = currentLineWidth;
    fanSpeeds[segCount] = currentFanPct;
    temps[segCount] = currentTemp;
    layersArr[segCount] = Math.max(0, currentLayerIdx);
    lineNumbers[segCount] = lineIdx + 1;
    segCount++;

    if (isExtrude) {
      if (speed < minSpeed) minSpeed = speed;
      if (speed > maxSpeed) maxSpeed = speed;
      if (volFlow < minFlow) minFlow = volFlow;
      if (volFlow > maxFlow) maxFlow = volFlow;
      if (currentLayerHeight < minLH) minLH = currentLayerHeight;
      if (currentLayerHeight > maxLH) maxLH = currentLayerHeight;
      if (currentLineWidth < minLW) minLW = currentLineWidth;
      if (currentLineWidth > maxLW) maxLW = currentLineWidth;
      if (currentTemp < minTemp) minTemp = currentTemp;
      if (currentTemp > maxTemp) maxTemp = currentTemp;
      minX = Math.min(minX, sx, ex);
      minY = Math.min(minY, sy, ey);
      minZ = Math.min(minZ, sz, ez);
      maxX = Math.max(maxX, sx, ex);
      maxY = Math.max(maxY, sy, ey);
      maxZ = Math.max(maxZ, sz, ez);
    }
  };

  let headerTimeStr: string | undefined;
  let headerFilamentGrams: number | undefined;
  let headerFilamentCost: number | undefined;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;

    if (raw.startsWith(";")) {
      const comment = raw.slice(1).trim();
      if (comment.startsWith("TYPE:")) {
        currentFeature = normalizeFeatureType(comment.slice(5));
      } else if (comment.startsWith("FEATURE:")) {
        currentFeature = normalizeFeatureType(comment.slice(8));
      } else if (comment.startsWith("HEIGHT:") || comment.startsWith("LAYER_HEIGHT:")) {
        const valStr = comment.includes("LAYER_HEIGHT:") ? comment.slice(13) : comment.slice(7);
        const h = parseFloat(valStr.trim());
        if (Number.isFinite(h) && h > 0) {
          currentLayerHeight = h;
          if (layers.length > 0) layers[layers.length - 1].height = h;
        }
      } else if (comment.startsWith("WIDTH:") || comment.startsWith("LINE_WIDTH:")) {
        const valStr = comment.includes("LINE_WIDTH:") ? comment.slice(11) : comment.slice(6);
        const w = parseFloat(valStr.trim());
        if (Number.isFinite(w) && w > 0) currentLineWidth = w;
      } else if (comment.startsWith("Z:") || comment.startsWith("Z_HEIGHT:")) {
        const valStr = comment.includes("Z_HEIGHT:") ? comment.slice(9) : comment.slice(2);
        const lz = parseFloat(valStr.trim());
        if (Number.isFinite(lz)) {
          z = lz;
          if (layers.length > 0 && seenFirstLayerMarker) {
            layers[layers.length - 1].z = lz;
          }
        }
      } else if (comment === "LAYER_CHANGE" || comment === "CHANGE_LAYER") {
        seenFirstLayerMarker = true;
        startNewLayer(z, i);
      } else if (comment.includes("estimated printing time") || comment.includes("total estimated time:")) {
        const m = raw.match(/(?:total estimated time: |estimated printing time \(normal mode\) = )([^;\n]+)/);
        if (m) headerTimeStr = m[1].trim();
      } else if (comment.includes("filament used [g]")) {
        const m = raw.match(/filament used \[g\] = ([\d.]+)/);
        if (m) headerFilamentGrams = parseFloat(m[1]);
      } else if (comment.includes("filament cost")) {
        const m = raw.match(/filament cost = ([\d.]+)/);
        if (m) headerFilamentCost = parseFloat(m[1]);
      }
      continue;
    }

    const semi = raw.indexOf(";");
    const code = semi >= 0 ? raw.slice(0, semi).trim() : raw;
    if (!code) continue;

    const parts = code.split(/\s+/);
    const cmd = parts[0].toUpperCase();

    if (cmd === "G90") {
      relativeXYZ = false;
      continue;
    }
    if (cmd === "G91") {
      relativeXYZ = true;
      continue;
    }
    if (cmd === "M82") {
      relativeE = false;
      continue;
    }
    if (cmd === "M83") {
      relativeE = true;
      continue;
    }
    if (cmd === "G92") {
      for (let p = 1; p < parts.length; p++) {
        const c = parts[p][0]?.toUpperCase();
        const val = parseFloat(parts[p].slice(1));
        if (!Number.isFinite(val)) continue;
        if (c === "X") x = val;
        else if (c === "Y") y = val;
        else if (c === "Z") z = val;
        else if (c === "E") e = val;
      }
      continue;
    }
    if (/^T\d+$/.test(cmd)) {
      const tIdx = parseInt(cmd.slice(1), 10);
      if (Number.isFinite(tIdx) && tIdx >= 0 && tIdx < 16) currentFilament = tIdx;
      continue;
    }
    if (cmd === "M104" || cmd === "M109") {
      for (let p = 1; p < parts.length; p++) {
        if (parts[p][0]?.toUpperCase() === "S") {
          const val = parseFloat(parts[p].slice(1));
          if (Number.isFinite(val) && val > 0) currentTemp = val;
        }
      }
      continue;
    }
    if (cmd === "M106") {
      for (let p = 1; p < parts.length; p++) {
        if (parts[p][0]?.toUpperCase() === "S") {
          const val = parseFloat(parts[p].slice(1));
          if (Number.isFinite(val)) currentFanPct = Math.min(100, Math.max(0, (val / 255) * 100));
        }
      }
      continue;
    }
    if (cmd === "M107") {
      currentFanPct = 0;
      continue;
    }

    if (cmd === "G0" || cmd === "G1") {
      let nx = x, ny = y, nz = z, ne = e;
      let hasE = false;
      for (let p = 1; p < parts.length; p++) {
        const c = parts[p][0]?.toUpperCase();
        const val = parseFloat(parts[p].slice(1));
        if (!Number.isFinite(val)) continue;
        if (c === "X") nx = relativeXYZ ? x + val : val;
        else if (c === "Y") ny = relativeXYZ ? y + val : val;
        else if (c === "Z") nz = relativeXYZ ? z + val : val;
        else if (c === "E") {
          ne = relativeE ? e + val : val;
          hasE = true;
        } else if (c === "F") {
          feedrateMmS = val / 60;
        }
      }
      const de = hasE ? ne - e : 0;
      if (de < -0.1 && nx === x && ny === y && nz === z && currentLayerIdx >= 0) {
        retractions.push(x, y, z);
      } else if (nx !== x || ny !== y || nz !== z) {
        pushSegment(x, y, z, nx, ny, nz, de, i);
      }
      x = nx; y = ny; z = nz; e = ne;
      continue;
    }

    if (cmd === "G2" || cmd === "G3") {
      const cw = cmd === "G2";
      let nx = x, ny = y, nz = z, ne = e;
      let oi = 0, oj = 0;
      let hasE = false;
      for (let p = 1; p < parts.length; p++) {
        const c = parts[p][0]?.toUpperCase();
        const val = parseFloat(parts[p].slice(1));
        if (!Number.isFinite(val)) continue;
        if (c === "X") nx = relativeXYZ ? x + val : val;
        else if (c === "Y") ny = relativeXYZ ? y + val : val;
        else if (c === "Z") nz = relativeXYZ ? z + val : val;
        else if (c === "I") oi = val;
        else if (c === "J") oj = val;
        else if (c === "E") {
          ne = relativeE ? e + val : val;
          hasE = true;
        } else if (c === "F") {
          feedrateMmS = val / 60;
        }
      }
      const cx = x + oi;
      const cy = y + oj;
      const r = Math.hypot(oi, oj);
      const de = hasE ? ne - e : 0;
      if (r > 1e-4) {
        const startA = Math.atan2(y - cy, x - cx);
        let endA = Math.atan2(ny - cy, nx - cx);
        let sweep = endA - startA;
        if (cw) {
          if (sweep >= 0) sweep -= Math.PI * 2;
        } else {
          if (sweep <= 0) sweep += Math.PI * 2;
        }
        const steps = Math.max(4, Math.min(36, Math.ceil((Math.abs(sweep) * r) / 0.6)));
        let px = x, py = y, pz = z;
        for (let s = 1; s <= steps; s++) {
          const t = s / steps;
          const a = startA + sweep * t;
          const tx = s === steps ? nx : cx + Math.cos(a) * r;
          const ty = s === steps ? ny : cy + Math.sin(a) * r;
          const tz = z + (nz - z) * t;
          pushSegment(px, py, pz, tx, ty, tz, de / steps, i);
          px = tx; py = ty; pz = tz;
        }
      } else {
        pushSegment(x, y, z, nx, ny, nz, de, i);
      }
      x = nx; y = ny; z = nz; e = ne;
    }
  }

  if (layers.length > 0) {
    layers[layers.length - 1].endSegment = segCount;
  }

  const featureBreakdown = Array.from(featureTimeSec.entries())
    .filter(([, sec]) => sec > 0)
    .map(([feature, timeSeconds]) => ({
      feature,
      timeSeconds,
      distanceMm: featureDistMm.get(feature) || 0,
      percentage: totalTimeSec > 0 ? (timeSeconds / totalTimeSec) * 100 : 0,
    }))
    .sort((a, b) => b.timeSeconds - a.timeSeconds);

  const filamentCm3 = (totalExtrudedMm * filamentArea) / 1000;
  const filamentGrams = headerFilamentGrams ?? filamentCm3 * 1.24;

  const stats: GcodeStats = {
    totalLayers: layers.length,
    totalSegments: segCount,
    estimatedTimeSeconds: totalTimeSec,
    estimatedTimeLabel: headerTimeStr || formatDuration(totalTimeSec),
    filamentLengthMm: totalExtrudedMm,
    filamentVolumeCm3: filamentCm3,
    filamentGrams,
    filamentCost: headerFilamentCost ?? (filamentGrams / 1000) * 20,
    featureBreakdown,
  };

  return {
    rawText: text,
    lineCount: lines.length,
    layers,
    segmentCount: segCount,
    truncated,
    starts: starts.subarray(0, segCount * 3),
    ends: ends.subarray(0, segCount * 3),
    features: features.subarray(0, segCount),
    filaments: filaments.subarray(0, segCount),
    speeds: speeds.subarray(0, segCount),
    flows: flows.subarray(0, segCount),
    layerHeights: layerHeights.subarray(0, segCount),
    lineWidths: lineWidths.subarray(0, segCount),
    fanSpeeds: fanSpeeds.subarray(0, segCount),
    temps: temps.subarray(0, segCount),
    layersArr: layersArr.subarray(0, segCount),
    lineNumbers: lineNumbers.subarray(0, segCount),
    retractions: new Float32Array(retractions),
    seams: new Float32Array(seams),
    ranges: {
      speed: [Number.isFinite(minSpeed) ? minSpeed : 0, Math.max(maxSpeed, 1)],
      flow: [Number.isFinite(minFlow) ? minFlow : 0, Math.max(maxFlow, 1)],
      layerHeight: [Number.isFinite(minLH) ? minLH : 0.1, Math.max(maxLH, 0.4)],
      lineWidth: [Number.isFinite(minLW) ? minLW : 0.3, Math.max(maxLW, 0.8)],
      temp: [Number.isFinite(minTemp) ? minTemp : 180, Math.max(maxTemp, 250)],
    },
    stats,
    bounds: {
      min: [Number.isFinite(minX) ? minX : 0, Number.isFinite(minY) ? minY : 0, Number.isFinite(minZ) ? minZ : 0],
      max: [Number.isFinite(maxX) ? maxX : 20, Number.isFinite(maxY) ? maxY : 20, Number.isFinite(maxZ) ? maxZ : 20],
    },
  };
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${rem}s`;
  return `${rem}s`;
}

/** Turbo-like engineering heatmap from 0..1 (blue -> cyan -> green -> yellow -> red). */
export function sampleHeatmapRGB(t: number): [number, number, number] {
  const c = Math.max(0, Math.min(1, t));
  if (c < 0.25) {
    const u = c / 0.25;
    return [0.12, 0.35 + 0.5 * u, 0.95];
  }
  if (c < 0.5) {
    const u = (c - 0.25) / 0.25;
    return [0.12 + 0.1 * u, 0.85, 0.95 - 0.65 * u];
  }
  if (c < 0.75) {
    const u = (c - 0.5) / 0.25;
    return [0.22 + 0.76 * u, 0.85 - 0.05 * u, 0.3 - 0.2 * u];
  }
  const u = (c - 0.75) / 0.25;
  return [0.98, 0.8 - 0.65 * u, 0.1];
}
