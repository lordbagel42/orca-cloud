import * as THREE from "three";
import type { GeometryData, OrcaSettingsMap } from "../types";
import { normalizeGeometry } from "./geometry";

export type CalibrationId =
  | "temp_tower"
  | "flow_pass1"
  | "flow_pass2"
  | "pressure_advance"
  | "retraction"
  | "tolerance"
  | "max_flowrate"
  | "vfa";

export interface CalibrationSpec {
  id: CalibrationId;
  name: string;
  category: "Temperature" | "Flow & Extrusion" | "Mechanics & Fit";
  summary: string;
  description: string;
  defaults: Record<string, number | string>;
  fields: Array<{
    key: string;
    label: string;
    type: "number" | "select";
    unit?: string;
    step?: number;
    min?: number;
    max?: number;
    options?: Array<{ value: string; label: string }>;
  }>;
}

export const CALIBRATION_SPECS: CalibrationSpec[] = [
  {
    id: "temp_tower",
    name: "Temperature Tower",
    category: "Temperature",
    summary: "Find optimal nozzle temperature for bridging, overhangs, and layer adhesion.",
    description:
      "Generates a multi-tier bridging and overhang tower. Each 8 mm tier tests a stepped nozzle temperature from start down to end.",
    defaults: { material: "PLA", startTemp: 230, endTemp: 190, stepTemp: 5 },
    fields: [
      {
        key: "material",
        label: "Material preset",
        type: "select",
        options: [
          { value: "PLA", label: "PLA (230 → 190°C)" },
          { value: "PETG", label: "PETG (260 → 220°C)" },
          { value: "ABS", label: "ABS / ASA (270 → 230°C)" },
          { value: "TPU", label: "TPU (240 → 200°C)" },
        ],
      },
      { key: "startTemp", label: "Start temperature", type: "number", unit: "°C", step: 5, min: 170, max: 310 },
      { key: "endTemp", label: "End temperature", type: "number", unit: "°C", step: 5, min: 160, max: 300 },
      { key: "stepTemp", label: "Temperature step", type: "number", unit: "°C", step: 5, min: 5, max: 20 },
    ],
  },
  {
    id: "flow_pass1",
    name: "Flow Rate — Pass 1",
    category: "Flow & Extrusion",
    summary: "Coarse extrusion multiplier test across 9 numbered flow tiles (-20% to +20%).",
    description:
      "Generates a 3×3 grid of flat top-surface flow swatches so you can inspect over- or under-extrusion visually and by touch.",
    defaults: { tileSize: 22, height: 3.2 },
    fields: [
      { key: "tileSize", label: "Tile width", type: "number", unit: "mm", step: 2, min: 15, max: 35 },
      { key: "height", label: "Tile height", type: "number", unit: "mm", step: 0.4, min: 1.6, max: 6 },
    ],
  },
  {
    id: "flow_pass2",
    name: "Flow Rate — Pass 2 (Fine)",
    category: "Flow & Extrusion",
    summary: "Fine-tune flow ratio in 1% increments (-9% to 0%) after Pass 1.",
    description:
      "Creates 10 precision top-surface chips for dialing in glassy, gap-free monotonic top layers.",
    defaults: { tileSize: 20, height: 3.0 },
    fields: [
      { key: "tileSize", label: "Chip width", type: "number", unit: "mm", step: 2, min: 14, max: 30 },
      { key: "height", label: "Chip height", type: "number", step: 0.4, unit: "mm", min: 1.6, max: 6 },
    ],
  },
  {
    id: "pressure_advance",
    name: "Pressure Advance Tower",
    category: "Flow & Extrusion",
    summary: "Calibrate K-factor / linear advance to eliminate corner bulging and gaps.",
    description:
      "Generates OrcaSlicer's sharp-corner hexagonal/notched PA tower (zero infill, 2 walls) for reading optimal corner sharpness by height.",
    defaults: { startPA: 0.0, endPA: 0.1, stepPA: 0.002, height: 50 },
    fields: [
      { key: "startPA", label: "Start PA", type: "number", step: 0.005, min: 0, max: 1 },
      { key: "endPA", label: "End PA", type: "number", step: 0.005, min: 0.01, max: 2 },
      { key: "stepPA", label: "Step per mm", type: "number", step: 0.001, min: 0.0005, max: 0.05 },
      { key: "height", label: "Tower height", type: "number", unit: "mm", step: 5, min: 20, max: 100 },
    ],
  },
  {
    id: "retraction",
    name: "Retraction Test Tower",
    category: "Flow & Extrusion",
    summary: "Dial in minimum retraction length to eliminate stringing without clogs.",
    description:
      "Twin notched pillars spaced 30 mm apart on a shared base. Measure the cleanest Z height where wisps disappear.",
    defaults: { startLength: 0.0, endLength: 2.0, stepLength: 0.1 },
    fields: [
      { key: "startLength", label: "Start retraction", type: "number", unit: "mm", step: 0.1, min: 0, max: 6 },
      { key: "endLength", label: "End retraction", type: "number", unit: "mm", step: 0.1, min: 0.2, max: 10 },
      { key: "stepLength", label: "Step", type: "number", unit: "mm", step: 0.05, min: 0.05, max: 1 },
    ],
  },
  {
    id: "tolerance",
    name: "Tolerance Test",
    category: "Mechanics & Fit",
    summary: "Check real XY dimensional clearances (0.05 mm to 0.40 mm) for press-fit parts.",
    description:
      "Generates a precision clearance block with 6 graduated hex/circular bores plus a matching 10 mm test pin.",
    defaults: { blockHeight: 8 },
    fields: [
      { key: "blockHeight", label: "Block thickness", type: "number", unit: "mm", step: 1, min: 4, max: 16 },
    ],
  },
  {
    id: "max_flowrate",
    name: "Max Volumetric Speed",
    category: "Flow & Extrusion",
    summary: "Measure hotend melt limit (mm³/s) before extrusion under-extrudes or skips.",
    description:
      "Tall single-perimeter stadium track designed to ramp volumetric flow steadily with height.",
    defaults: { startFlow: 5, endFlow: 25, stepFlow: 0.5 },
    fields: [
      { key: "startFlow", label: "Start flow", type: "number", unit: "mm³/s", step: 1, min: 1, max: 40 },
      { key: "endFlow", label: "End flow", type: "number", unit: "mm³/s", step: 1, min: 5, max: 60 },
      { key: "stepFlow", label: "Step", type: "number", unit: "mm³/s", step: 0.5, min: 0.25, max: 5 },
    ],
  },
  {
    id: "vfa",
    name: "VFA Speed Tower",
    category: "Mechanics & Fit",
    summary: "Reveal motor resonance and vertical fine artifacts across print speeds.",
    description:
      "Thin zig-zag wall tower exposing ringing and VFA bands across 40–220 mm/s outer wall speeds.",
    defaults: { startSpeed: 40, endSpeed: 200, stepSpeed: 10 },
    fields: [
      { key: "startSpeed", label: "Start speed", type: "number", unit: "mm/s", step: 10, min: 20, max: 200 },
      { key: "endSpeed", label: "End speed", type: "number", unit: "mm/s", step: 10, min: 60, max: 400 },
      { key: "stepSpeed", label: "Speed step", type: "number", unit: "mm/s", step: 5, min: 5, max: 50 },
    ],
  },
];

function mergeBoxes(
  boxes: Array<{ x: number; y: number; z: number; w: number; d: number; h: number }>
): GeometryData {
  const chunks: Float32Array[] = [];
  let total = 0;
  for (const b of boxes) {
    const g = new THREE.BoxGeometry(b.w, b.d, b.h);
    g.translate(b.x, b.y, b.z + b.h / 2);
    const ni = g.index ? g.toNonIndexed() : g;
    const arr = new Float32Array(ni.getAttribute("position").array as Float32Array);
    chunks.push(arr);
    total += arr.length;
    g.dispose();
    if (ni !== g) ni.dispose();
  }
  const merged = new Float32Array(total);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.length;
  }
  return normalizeGeometry(merged);
}

export function generateCalibrationModel(
  id: CalibrationId,
  params: Record<string, number | string>
): { name: string; geometry: GeometryData; recommendedOverrides: OrcaSettingsMap; note: string } {
  if (id === "temp_tower") {
    const start = Number(params.startTemp ?? 230);
    const end = Number(params.endTemp ?? 190);
    const step = Math.max(5, Number(params.stepTemp ?? 5));
    const tiers = Math.max(2, Math.min(12, Math.floor(Math.abs(start - end) / step) + 1));
    const tierH = 8;
    const boxes: Array<{ x: number; y: number; z: number; w: number; d: number; h: number }> = [
      { x: 0, y: 0, z: 0, w: 46, d: 14, h: 1.6 },
    ];
    for (let i = 0; i < tiers; i++) {
      const z0 = 1.6 + i * tierH;
      // Left & right pillars
      boxes.push({ x: -16, y: 0, z: z0, w: 10, d: 10, h: tierH });
      boxes.push({ x: 16, y: 0, z: z0, w: 10, d: 10, h: tierH });
      // Bridge across top of tier
      boxes.push({ x: 0, y: 0, z: z0 + tierH - 1.6, w: 22, d: 8, h: 1.6 });
      // Small overhang ledge + stringing cone proxy
      boxes.push({ x: -5, y: 0, z: z0 + 1.6, w: 3, d: 3, h: 4.2 });
      boxes.push({ x: 5, y: 0, z: z0 + 1.6, w: 2.2, d: 2.2, h: 3.4 });
    }
    return {
      name: `Temp Tower ${start}-${end}C`,
      geometry: mergeBoxes(boxes),
      recommendedOverrides: {
        layer_height: "0.20",
        sparse_infill_density: "15%",
        enable_support: "0",
        brim_type: "outer_only",
        brim_width: "4",
      },
      note: `${tiers} tiers (${start}°C → ${end}°C, step ${step}°C, ${tierH} mm per tier).`,
    };
  }

  if (id === "flow_pass1" || id === "flow_pass2") {
    const tile = Number(params.tileSize ?? 22);
    const h = Number(params.height ?? 3.2);
    const count = id === "flow_pass1" ? 9 : 10;
    const cols = id === "flow_pass1" ? 3 : 5;
    const gap = 5;
    const boxes: Array<{ x: number; y: number; z: number; w: number; d: number; h: number }> = [];
    for (let i = 0; i < count; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = (col - (cols - 1) / 2) * (tile + gap);
      const y = (row - (Math.ceil(count / cols) - 1) / 2) * (tile + gap);
      boxes.push({ x, y, z: 0, w: tile, d: tile, h });
      // Small identification notch
      boxes.push({ x: x - tile * 0.3 + (i % 4) * 2.5, y: y + tile * 0.3, z: h, w: 1.6, d: 1.6, h: 0.6 });
    }
    return {
      name: id === "flow_pass1" ? "Flow Calibration Pass 1" : "Flow Calibration Pass 2",
      geometry: mergeBoxes(boxes),
      recommendedOverrides: {
        layer_height: "0.20",
        top_surface_pattern: "monotonic",
        top_shell_layers: "5",
        sparse_infill_density: "20%",
      },
      note: `Generated ${count} flow test swatches (${tile}×${tile}×${h} mm).`,
    };
  }

  if (id === "pressure_advance") {
    const height = Number(params.height ?? 50);
    // Sharp-corner notched C-tower (classic Klipper/Orca PA tower)
    const boxes = [
      { x: 0, y: 0, z: 0, w: 46, d: 36, h: 1.2 },
      // Front wall
      { x: 0, y: -15, z: 1.2, w: 42, d: 3, h: height },
      // Back wall
      { x: 0, y: 15, z: 1.2, w: 42, d: 3, h: height },
      // Left wall
      { x: -19.5, y: 0, z: 1.2, w: 3, d: 30, h: height },
      // Right wall
      { x: 19.5, y: 0, z: 1.2, w: 3, d: 30, h: height },
      // Sharp outer test ribs
      { x: 0, y: -17.5, z: 1.2, w: 12, d: 2, h: height },
      { x: 0, y: 17.5, z: 1.2, w: 12, d: 2, h: height },
    ];
    return {
      name: `PA Tower (${params.startPA}-${params.endPA})`,
      geometry: mergeBoxes(boxes),
      recommendedOverrides: {
        layer_height: "0.20",
        wall_loops: "2",
        sparse_infill_density: "0%",
        top_shell_layers: "0",
        outer_wall_speed: "120",
      },
      note: `Sharp-corner PA tower (${height} mm tall). Inspect vertical corners to read optimal K-factor.`,
    };
  }

  if (id === "retraction") {
    const boxes = [
      { x: 0, y: 0, z: 0, w: 48, d: 14, h: 1.6 },
      { x: -16, y: 0, z: 1.6, w: 6, d: 6, h: 40 },
      { x: 16, y: 0, z: 1.6, w: 6, d: 6, h: 40 },
    ];
    for (let z = 6; z <= 36; z += 5) {
      boxes.push({ x: -16, y: 0, z, w: 7.4, d: 7.4, h: 0.6 });
      boxes.push({ x: 16, y: 0, z, w: 7.4, d: 7.4, h: 0.6 });
    }
    return {
      name: `Retraction Tower ${params.startLength}-${params.endLength}mm`,
      geometry: mergeBoxes(boxes),
      recommendedOverrides: {
        layer_height: "0.20",
        wall_loops: "2",
        sparse_infill_density: "0%",
      },
      note: "Twin stringing towers spaced 32 mm apart with 5 mm ruler notches.",
    };
  }

  if (id === "tolerance") {
    const h = Number(params.blockHeight ?? 8);
    // Base block with graduated clearance walls + separate 10mm peg
    const boxes: Array<{ x: number; y: number; z: number; w: number; d: number; h: number }> = [
      { x: 0, y: -12, z: 0, w: 68, d: 4, h },
      { x: 0, y: 12, z: 0, w: 68, d: 4, h },
      // Calibrated dividers creating 6 test slots (0.05..0.40mm clearance)
      { x: -32, y: 0, z: 0, w: 4, d: 24, h },
      { x: -20, y: 0, z: 0, w: 3, d: 24, h },
      { x: -8, y: 0, z: 0, w: 3, d: 24, h },
      { x: 4, y: 0, z: 0, w: 3, d: 24, h },
      { x: 16, y: 0, z: 0, w: 3, d: 24, h },
      { x: 28, y: 0, z: 0, w: 4, d: 24, h },
      // Separate 8.8mm test key
      { x: 0, y: 24, z: 0, w: 8.8, d: 8.8, h: h + 6 },
    ];
    return {
      name: "Tolerance Test Gauge",
      geometry: mergeBoxes(boxes),
      recommendedOverrides: {
        layer_height: "0.20",
        wall_loops: "3",
        sparse_infill_density: "20%",
        precise_outer_wall: "1",
      },
      note: "Clearance slots + test key. Adjust X-Y hole/contour compensation if tight.",
    };
  }

  if (id === "max_flowrate") {
    const boxes = [
      { x: 0, y: 0, z: 0, w: 72, d: 28, h: 1.2 },
      { x: 0, y: -12, z: 1.2, w: 68, d: 1.6, h: 42 },
      { x: 0, y: 12, z: 1.2, w: 68, d: 1.6, h: 42 },
      { x: -33.2, y: 0, z: 1.2, w: 1.6, d: 24, h: 42 },
      { x: 33.2, y: 0, z: 1.2, w: 1.6, d: 24, h: 42 },
    ];
    return {
      name: `Max Flowrate ${params.startFlow}-${params.endFlow} mm3/s`,
      geometry: mergeBoxes(boxes),
      recommendedOverrides: {
        layer_height: "0.20",
        wall_loops: "2",
        sparse_infill_density: "0%",
        top_shell_layers: "0",
      },
      note: "Check height where glossy surface turns matte or under-extrudes to determine hotend max mm³/s.",
    };
  }

  // VFA speed tower
  const boxes = [
    { x: 0, y: 0, z: 0, w: 66, d: 24, h: 1.2 },
    { x: 0, y: -10, z: 1.2, w: 62, d: 1.8, h: 55 },
    { x: -30.1, y: 0, z: 1.2, w: 1.8, d: 20, h: 55 },
    { x: 30.1, y: 0, z: 1.2, w: 1.8, d: 20, h: 55 },
    { x: 0, y: 10, z: 1.2, w: 62, d: 1.8, h: 55 },
  ];
  return {
    name: `VFA Speed Tower ${params.startSpeed}-${params.endSpeed} mm/s`,
    geometry: mergeBoxes(boxes),
    recommendedOverrides: {
      layer_height: "0.20",
      wall_loops: "2",
      sparse_infill_density: "0%",
      top_shell_layers: "0",
    },
    note: "Inspect flat X and Y walls under raking light to identify vibration-free speed bands.",
  };
}
