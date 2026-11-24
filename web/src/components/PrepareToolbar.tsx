import { useEffect, useRef, useState } from "react";
import {
  AlignVerticalJustifyEnd,
  Box,
  Compass,
  Copy,
  FlipHorizontal2,
  FolderPlus,
  Grid2x2,
  Layers2,
  Maximize2,
  MousePointer2,
  Move,
  Paintbrush,
  Palette,
  PenTool,
  Redo2,
  RotateCw,
  Ruler,
  Scissors,
  Sliders,
  TriangleAlert,
  Type,
  Undo2,
  Ungroup,
  Wrench,
} from "lucide-react";
import type { WorkspaceAPI } from "../store/useWorkspace";
import type { PrimitiveKind } from "../lib/geometry";

interface Props {
  ws: WorkspaceAPI;
  onTriggerFileImport: () => void;
}

const PRIMITIVES: Array<{ kind: PrimitiveKind; label: string }> = [
  { kind: "benchy_test", label: "Overhang Boat Test" },
  { kind: "calibration_cube", label: "Calibration Cube (20 mm)" },
  { kind: "cube", label: "Cube (25 mm)" },
  { kind: "cylinder", label: "Cylinder" },
  { kind: "sphere", label: "Sphere" },
  { kind: "cone", label: "Cone" },
  { kind: "torus", label: "Torus" },
  { kind: "disc", label: "Disc" },
];

export function PrepareToolbar({ ws, onTriggerFileImport }: Props) {
  const [primOpen, setPrimOpen] = useState(false);
  const [mirrorOpen, setMirrorOpen] = useState(false);
  const primRef = useRef<HTMLDivElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (primRef.current && !primRef.current.contains(e.target as Node)) setPrimOpen(false);
      if (mirrorRef.current && !mirrorRef.current.contains(e.target as Node)) setMirrorOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, []);

  const hasSel = Boolean(ws.selectedObject);

  return (
    <div className="prepare-toolbar" role="toolbar" aria-label="Prepare tools">
      {/* Import & Add */}
      <button className="icon-btn" title="Import STL / OBJ / 3MF" aria-label="Import model" onClick={onTriggerFileImport}>
        <FolderPlus size={15} />
      </button>

      <div ref={primRef} style={{ position: "relative" }}>
        <button
          className={`icon-btn ${primOpen ? "active" : ""}`}
          title="Add primitive or test model"
          aria-label="Add primitive"
          onClick={() => setPrimOpen((v) => !v)}
        >
          <Box size={15} />
        </button>
        {primOpen && (
          <div className="menu-popover" style={{ position: "fixed", top: 96, left: "50%", transform: "translateX(-260px)", width: 204 }}>
            {PRIMITIVES.map((p) => (
              <button
                key={p.kind}
                className="menu-item"
                onClick={() => {
                  ws.addPrimitive(p.kind);
                  setPrimOpen(false);
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <button className="icon-btn" title="Add new plate" aria-label="Add plate" onClick={ws.addPlate}>
        <Layers2 size={15} />
      </button>
      <button
        className="icon-btn"
        title="Auto-arrange objects on bed (A)"
        aria-label="Auto-arrange"
        disabled={ws.activePlate.objects.length === 0}
        onClick={ws.arrangeActivePlate}
      >
        <Grid2x2 size={15} />
      </button>
      <button
        className="icon-btn"
        title="Auto-orient selected model (Native OrcaSlicer)"
        aria-label="Auto-orient"
        disabled={!hasSel}
        onClick={ws.autoOrientSelectedNative}
      >
        <Compass size={15} />
      </button>

      <span className="toolbar-sep" />

      {/* Transform Tools */}
      <button
        className={`icon-btn ${ws.tool === "select" ? "active" : ""}`}
        title="Select (Esc)"
        aria-label="Select"
        onClick={() => ws.setTool("select")}
      >
        <MousePointer2 size={15} />
      </button>
      <button
        className={`icon-btn ${ws.tool === "move" ? "active" : ""}`}
        title="Move (M)"
        aria-label="Move"
        disabled={!hasSel}
        onClick={() => ws.setTool(ws.tool === "move" ? "select" : "move")}
      >
        <Move size={15} />
      </button>
      <button
        className={`icon-btn ${ws.tool === "rotate" ? "active" : ""}`}
        title="Rotate (R)"
        aria-label="Rotate"
        disabled={!hasSel}
        onClick={() => ws.setTool(ws.tool === "rotate" ? "select" : "rotate")}
      >
        <RotateCw size={15} />
      </button>
      <button
        className={`icon-btn ${ws.tool === "scale" ? "active" : ""}`}
        title="Scale (S)"
        aria-label="Scale"
        disabled={!hasSel}
        onClick={() => ws.setTool(ws.tool === "scale" ? "select" : "scale")}
      >
        <Maximize2 size={15} />
      </button>
      <button
        className={`icon-btn ${ws.tool === "lay_on_face" ? "active" : ""}`}
        title="Lay on Face — click any face on model (F)"
        aria-label="Lay on face"
        disabled={!hasSel}
        onClick={() => ws.setTool(ws.tool === "lay_on_face" ? "select" : "lay_on_face")}
      >
        <AlignVerticalJustifyEnd size={15} />
      </button>

      <span className="toolbar-sep" />

      {/* Mesh & Orca Painting Tools */}
      <button
        className={`icon-btn ${ws.tool === "cut" ? "active" : ""}`}
        title="Cut plane (C)"
        aria-label="Cut plane"
        disabled={!hasSel}
        onClick={() => ws.setTool(ws.tool === "cut" ? "select" : "cut")}
      >
        <Scissors size={15} />
      </button>
      <button
        className={`icon-btn ${ws.tool === "paint_support" ? "active" : ""}`}
        title="Support Painting — enforce/block supports (L)"
        aria-label="Support painting"
        disabled={!hasSel}
        onClick={() => ws.setTool(ws.tool === "paint_support" ? "select" : "paint_support")}
      >
        <Paintbrush size={15} />
      </button>
      <button
        className={`icon-btn ${ws.tool === "paint_seam" ? "active" : ""}`}
        title="Seam Painting — enforce/block Z-seam (P)"
        aria-label="Seam painting"
        disabled={!hasSel}
        onClick={() => ws.setTool(ws.tool === "paint_seam" ? "select" : "paint_seam")}
      >
        <PenTool size={15} />
      </button>
      <button
        className={`icon-btn ${ws.tool === "paint_color" ? "active" : ""}`}
        title="Color Painting — multi-filament painting (N)"
        aria-label="Color painting"
        disabled={!hasSel}
        onClick={() => ws.setTool(ws.tool === "paint_color" ? "select" : "paint_color")}
      >
        <Palette size={15} />
      </button>
      <button
        className={`icon-btn ${ws.tool === "variable_layer" ? "active" : ""}`}
        title="Variable Layer Height"
        aria-label="Variable layer height"
        disabled={!hasSel}
        onClick={() => ws.setTool(ws.tool === "variable_layer" ? "select" : "variable_layer")}
      >
        <Sliders size={15} />
      </button>
      <button
        className={`icon-btn ${ws.tool === "measure" ? "active" : ""}`}
        title="Measure distance (U)"
        aria-label="Measure"
        onClick={() => {
          ws.setMeasurePoints([]);
          ws.setTool(ws.tool === "measure" ? "select" : "measure");
        }}
      >
        <Ruler size={15} />
      </button>
      <button
        className={`icon-btn ${ws.tool === "text_emboss" ? "active" : ""}`}
        title="Emboss 3D Text"
        aria-label="Emboss text"
        onClick={() => ws.setTool(ws.tool === "text_emboss" ? "select" : "text_emboss")}
      >
        <Type size={15} />
      </button>

      <span className="toolbar-sep" />

      {/* Mesh Operations */}
      <button className="icon-btn" title="Clone selected (Ctrl+K)" aria-label="Clone" disabled={!hasSel} onClick={() => ws.cloneSelected(1)}>
        <Copy size={15} />
      </button>

      <div ref={mirrorRef} style={{ position: "relative" }}>
        <button
          className={`icon-btn ${mirrorOpen ? "active" : ""}`}
          title="Mirror along X / Y / Z"
          aria-label="Mirror"
          disabled={!hasSel}
          onClick={() => setMirrorOpen((v) => !v)}
        >
          <FlipHorizontal2 size={15} />
        </button>
        {mirrorOpen && (
          <div className="menu-popover" style={{ position: "fixed", top: 96, left: "50%", transform: "translateX(120px)", width: 132 }}>
            {(["x", "y", "z"] as const).map((ax) => (
              <button
                key={ax}
                className="menu-item"
                onClick={() => {
                  ws.mirrorSelected(ax);
                  setMirrorOpen(false);
                }}
              >
                Mirror along {ax.toUpperCase()}
              </button>
            ))}
          </div>
        )}
      </div>

      <button
        className="icon-btn"
        title="Split disconnected shells to objects"
        aria-label="Split to objects"
        disabled={!hasSel}
        onClick={ws.splitSelectedToObjects}
      >
        <Ungroup size={15} />
      </button>
      <button
        className="icon-btn"
        title="Fix Model / Native Mesh Repair"
        aria-label="Fix model"
        disabled={!hasSel}
        onClick={ws.repairSelectedNative}
      >
        <Wrench size={15} />
      </button>

      <span className="toolbar-sep" />

      {/* Display & History */}
      <button
        className={`icon-btn ${ws.showOverhangs ? "active" : ""}`}
        title="Highlight overhangs (>45°)"
        aria-label="Highlight overhangs"
        onClick={() => ws.setShowOverhangs((v) => !v)}
      >
        <TriangleAlert size={15} />
      </button>
      <button className="icon-btn" title="Undo (Ctrl+Z)" aria-label="Undo" disabled={!ws.canUndo} onClick={ws.undo}>
        <Undo2 size={15} />
      </button>
      <button className="icon-btn" title="Redo (Ctrl+Y)" aria-label="Redo" disabled={!ws.canRedo} onClick={ws.redo}>
        <Redo2 size={15} />
      </button>
    </div>
  );
}
