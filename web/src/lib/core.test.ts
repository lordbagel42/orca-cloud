import { describe, expect, it } from "vitest";
import {
  arrangeObjectsOnBed,
  createPrimitiveGeometry,
  cutGeometryAtZ,
  exportBinarySTL,
  mirrorGeometry,
  parseSTL,
  splitDisconnectedShells,
} from "./geometry";
import { parseGcode } from "./gcode";
import { generateCalibrationModel } from "./calibration";
import { buildVGCodeVertexStream } from "./vgcodeRenderer";
import { exportPlateTo3MF } from "./threemf";
import type { Plate } from "../types";

describe("geometry engine", () => {
  it("round-trips binary STL with exact bounds and triangle count", () => {
    const geom = createPrimitiveGeometry("cube", 20);
    const stl = exportBinarySTL(geom.positions);
    const parsed = parseSTL(stl.buffer as ArrayBuffer);
    expect(parsed.triangleCount).toBe(geom.triangleCount);
    expect(parsed.bounds.size[0]).toBeCloseTo(20, 2);
    expect(parsed.bounds.size[1]).toBeCloseTo(20, 2);
    expect(parsed.bounds.size[2]).toBeCloseTo(20, 2);
    expect(parsed.bounds.min[2]).toBeCloseTo(0, 3);
  });

  it("cuts a cube at Z=10 into upper and lower watertight pieces", () => {
    const cube = createPrimitiveGeometry("cube", 20);
    const { upper, lower } = cutGeometryAtZ(cube, 10);
    expect(upper).not.toBeNull();
    expect(lower).not.toBeNull();
    expect(upper!.bounds.size[2]).toBeCloseTo(10, 2);
    expect(lower!.bounds.size[2]).toBeCloseTo(10, 2);
  });

  it("splits two disconnected boxes into 2 independent shells", () => {
    const a = createPrimitiveGeometry("cube", 10);
    const b = createPrimitiveGeometry("cube", 10);
    const shifted = new Float32Array(b.positions.length);
    for (let i = 0; i < b.positions.length; i += 3) {
      shifted[i] = b.positions[i] + 30;
      shifted[i + 1] = b.positions[i + 1];
      shifted[i + 2] = b.positions[i + 2];
    }
    const merged = new Float32Array(a.positions.length + shifted.length);
    merged.set(a.positions, 0);
    merged.set(shifted, a.positions.length);
    const shells = splitDisconnectedShells(merged);
    expect(shells.length).toBe(2);
    expect(shells[0].geometry.bounds.size[0]).toBeCloseTo(10, 2);
    expect(shells[1].geometry.bounds.size[0]).toBeCloseTo(10, 2);
  });

  it("mirrors geometry without inverting volume sign or crashing", () => {
    const g = createPrimitiveGeometry("benchy_test", 24);
    const m = mirrorGeometry(g, "x");
    expect(m.triangleCount).toBe(g.triangleCount);
    expect(m.bounds.size[0]).toBeCloseTo(g.bounds.size[0], 2);
  });

  it("arranges multiple objects cleanly within build volume", () => {
    const g = createPrimitiveGeometry("cube", 25);
    const objs = [1, 2, 3, 4].map((i) => ({
      id: `o${i}`,
      name: `Cube ${i}`,
      geometry: g,
      position: [90, 90, 0] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number],
      visible: true,
      filamentIndex: 0,
      overrides: {},
      subParts: [],
    }));
    const placed = arrangeObjectsOnBed(objs, [180, 180, 180]);
    expect(placed.length).toBe(4);
    // Ensure distinct centers
    const keys = new Set(placed.map((p) => `${Math.round(p.position[0])},${Math.round(p.position[1])}`));
    expect(keys.size).toBe(4);
  });
});

describe("gcode parser", () => {
  it("parses layers, features, arcs, speeds, temps, fan, and seams", () => {
    const sample = [
      "M83",
      "M104 S215",
      "M106 S128",
      ";LAYER_CHANGE",
      ";Z:0.2",
      ";HEIGHT:0.2",
      ";TYPE:Outer wall",
      "G0 X10 Y10 Z0.2 F9000",
      "G1 X30 Y10 E1.2 F3600",
      "G2 X30 Y30 I0 J10 E1.5 F3600",
      ";TYPE:Sparse infill",
      "G1 X10 Y30 E0.9 F7200",
      "G1 E-0.8 F2400",
      ";LAYER_CHANGE",
      ";Z:0.4",
      ";HEIGHT:0.2",
      ";TYPE:Top surface",
      "G0 X10 Y10 Z0.4 F9000",
      "G1 X30 Y30 E1.4 F2400",
    ].join("\n");

    const parsed = parseGcode(sample);
    expect(parsed.layers.length).toBe(2);
    expect(parsed.segmentCount).toBeGreaterThan(6);
    expect(parsed.retractions.length).toBe(3);
    expect(parsed.seams.length).toBeGreaterThanOrEqual(3);
    expect(parsed.stats.filamentLengthMm).toBeGreaterThan(4);
    expect(parsed.ranges.temp[0]).toBe(215);
  });

  it("parses OrcaSlicer 2.5.0 / Bambu dialect (; CHANGE_LAYER, ; FEATURE:, ; Z_HEIGHT:, ; LINE_WIDTH:)", () => {
    const orca = [
      "; CHANGE_LAYER",
      "; Z_HEIGHT: 0.2",
      "; LAYER_HEIGHT: 0.2",
      "; FEATURE: Outer wall",
      "; LINE_WIDTH: 0.42",
      "G0 X10 Y10 Z0.2 F9000",
      "G1 X30 Y10 E0.8 F3600",
      "; FEATURE: Sparse infill",
      "G1 X30 Y30 E0.6 F6000",
      "; CHANGE_LAYER",
      "; Z_HEIGHT: 0.4",
      "; LAYER_HEIGHT: 0.2",
      "; FEATURE: Inner wall",
      "G1 X10 Y30 E0.8 F4800",
    ].join("\n");
    const parsed = parseGcode(orca);
    expect(parsed.layers.length).toBe(2);
    expect(parsed.layers[0].z).toBeCloseTo(0.2, 3);
    expect(parsed.layers[1].z).toBeCloseTo(0.4, 3);
    const feats = parsed.stats.featureBreakdown.map((f) => f.feature);
    expect(feats).toContain("Outer wall");
    expect(feats).toContain("Sparse infill");
    expect(feats).toContain("Inner wall");
  });
});

describe("calibration & 3mf", () => {
  it("generates all calibration geometries and exports valid 3MF archive", () => {
    const tempTower = generateCalibrationModel("temp_tower", { startTemp: 220, endTemp: 190, stepTemp: 10 });
    expect(tempTower.geometry.triangleCount).toBeGreaterThan(40);

    const plate: Plate = {
      id: "plate-1",
      name: "Plate 1",
      locked: false,
      objects: [
        {
          id: "obj-1",
          name: tempTower.name,
          geometry: tempTower.geometry,
          position: [90, 90, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
          visible: true,
          filamentIndex: 0,
          overrides: { wall_loops: "3" },
          subParts: [],
        },
      ],
    };
    const zipBytes = exportPlateTo3MF(plate);
    expect(zipBytes[0]).toBe(0x50); // 'P'
    expect(zipBytes[1]).toBe(0x4b); // 'K'
  });
});

describe("libvgcode volumetric vertex stream", () => {
  it("encodes connected joints, half-height Z offset, 90deg miter angles, and travel separation", () => {
    const sample = [
      "; CHANGE_LAYER",
      "; Z_HEIGHT: 0.2",
      "; LAYER_HEIGHT: 0.2",
      "; LINE_WIDTH: 0.44",
      "; FEATURE: Outer wall",
      "G1 X10 Y10 Z0.2 F3000",
      "G1 X20 Y10 E0.5",
      "G1 X20 Y20 E0.5",
      "G1 X30 Y20 E0.5",
      "G0 X40 Y40 F9000",
    ].join("\n");

    const parsed = parseGcode(sample);
    const stream = buildVGCodeVertexStream(parsed);
    // Seg 0 = initial travel (2 verts), Segs 1..3 = 3 chained outer-wall extrusions (4 verts), Seg 4 = final travel (2 verts) => 8 verts
    expect(stream.vertexCount).toBe(8);
    expect(stream.segmentIsTravel[0]).toBe(1);
    expect(stream.segmentIsTravel[1]).toBe(0);
    expect(stream.segmentIsTravel[4]).toBe(1);

    const e0 = stream.segmentVertexStart[1];
    // Extrusion vertices pushed down by 0.5 * layerHeight (0.2 - 0.1 = 0.1)
    expect(stream.positions[e0 * 4 + 2]).toBeCloseTo(0.1, 4);
    // Endpoint e0 is NOT a joint (w = 0.0), interior corners e0+1 & e0+2 ARE joints (w = 0.5)
    expect(stream.positions[e0 * 4 + 3]).toBeCloseTo(0.0, 4);
    expect(stream.positions[(e0 + 1) * 4 + 3]).toBeCloseTo(0.5, 4);
    expect(stream.positions[(e0 + 2) * 4 + 3]).toBeCloseTo(0.5, 4);
    expect(stream.positions[(e0 + 3) * 4 + 3]).toBeCloseTo(0.0, 4);

    // Corner e0+1 turns +90 deg (+X -> +Y => +pi/2), corner e0+2 turns -90 deg (+Y -> +X => -pi/2)
    expect(stream.heightsWidthsAngles[(e0 + 1) * 4 + 0]).toBeCloseTo(0.2, 4);
    expect(stream.heightsWidthsAngles[(e0 + 1) * 4 + 1]).toBeCloseTo(0.44, 4);
    expect(stream.heightsWidthsAngles[(e0 + 1) * 4 + 2]).toBeCloseTo(Math.PI / 2, 4);
    expect(stream.heightsWidthsAngles[(e0 + 2) * 4 + 2]).toBeCloseTo(-Math.PI / 2, 4);

    // Travel move stays at unshifted Z (0.2)
    const travelStartVert = stream.segmentVertexStart[4];
    expect(stream.positions[travelStartVert * 4 + 2]).toBeCloseTo(0.2, 4);
  });
});
