import { useCallback, useEffect, useId, useRef, useState } from "react";
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

interface TooltipState {
  label: string;
  shortcut?: string;
  x: number;
  y: number;
}

export function PrepareToolbar({ ws, onTriggerFileImport }: Props) {
  const [primOpen, setPrimOpen] = useState(false);
  const [mirrorOpen, setMirrorOpen] = useState(false);
  const [primAnchor, setPrimAnchor] = useState<{ left: number; top: number }>({ left: 0, top: 96 });
  const [mirrorAnchor, setMirrorAnchor] = useState<{ left: number; top: number }>({ left: 0, top: 96 });
  const [tip, setTip] = useState<TooltipState | null>(null);

  const primRef = useRef<HTMLDivElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const showTimerRef = useRef<number | null>(null);
  const warmUntilRef = useRef<number>(0);
  const tipId = useId();

  useEffect(() => {
    const close = (e: PointerEvent) => {
      if (primRef.current && !primRef.current.contains(e.target as Node)) setPrimOpen(false);
      if (mirrorRef.current && !mirrorRef.current.contains(e.target as Node)) setMirrorOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, []);

  useEffect(() => {
    return () => {
      if (showTimerRef.current !== null) window.clearTimeout(showTimerRef.current);
    };
  }, []);

  const showTooltip = useCallback((el: HTMLElement, label: string, shortcut?: string) => {
    if (typeof window !== "undefined" && window.matchMedia("(hover: none)").matches) return;
    if (showTimerRef.current !== null) {
      window.clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
    const rect = el.getBoundingClientRect();
    const x = Math.max(90, Math.min(window.innerWidth - 90, rect.left + rect.width / 2));
    const y = rect.bottom + 8;
    const isWarm = performance.now() < warmUntilRef.current;
    if (isWarm) {
      setTip({ label, shortcut, x, y });
    } else {
      showTimerRef.current = window.setTimeout(() => {
        setTip({ label, shortcut, x, y });
        warmUntilRef.current = performance.now() + 450;
      }, 95);
    }
  }, []);

  const hideTooltip = useCallback(() => {
    if (showTimerRef.current !== null) {
      window.clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
    setTip((prev) => {
      if (prev) warmUntilRef.current = performance.now() + 450;
      return null;
    });
  }, []);

  const tipWrapProps = (label: string, shortcut?: string) => ({
    className: "tip-wrap",
    onMouseEnter: (e: React.MouseEvent<HTMLSpanElement>) => showTooltip(e.currentTarget, label, shortcut),
    onMouseLeave: hideTooltip,
  });

  const tipBtnProps = (label: string, shortcut?: string) => ({
    onFocus: (e: React.FocusEvent<HTMLButtonElement>) => showTooltip(e.currentTarget, label, shortcut),
    onBlur: hideTooltip,
    "aria-label": shortcut ? `${label} (${shortcut})` : label,
    "aria-describedby": tip?.label === label ? tipId : undefined,
  });

  const hasSel = Boolean(ws.selectedObject);

  return (
    <>
      <div className="prepare-toolbar" role="toolbar" aria-label="Prepare tools" onScroll={hideTooltip}>
        {/* Import & Add */}
        <span {...tipWrapProps("Import STL / OBJ / 3MF", "Ctrl+I")}>
          <button
            className="icon-btn"
            {...tipBtnProps("Import STL / OBJ / 3MF", "Ctrl+I")}
            onClick={() => {
              hideTooltip();
              onTriggerFileImport();
            }}
          >
            <FolderPlus size={15} />
          </button>
        </span>

        <div ref={primRef} style={{ position: "relative" }}>
          <span {...tipWrapProps("Add Primitive")}>
            <button
              className={`icon-btn ${primOpen ? "active" : ""}`}
              {...tipBtnProps("Add Primitive")}
              onClick={(e) => {
                hideTooltip();
                const r = e.currentTarget.getBoundingClientRect();
                setPrimAnchor({ left: Math.min(window.innerWidth - 216, Math.max(12, r.left)), top: r.bottom + 8 });
                setPrimOpen((v) => !v);
              }}
            >
              <Box size={15} />
            </button>
          </span>
          {primOpen && (
            <div className="menu-popover" style={{ position: "fixed", top: primAnchor.top, left: primAnchor.left, width: 204 }}>
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

        <span {...tipWrapProps("Add New Plate")}>
          <button className="icon-btn" {...tipBtnProps("Add New Plate")} onClick={ws.addPlate}>
            <Layers2 size={15} />
          </button>
        </span>
        <span {...tipWrapProps("Auto-Arrange Plate", "A")}>
          <button
            className="icon-btn"
            {...tipBtnProps("Auto-Arrange Plate", "A")}
            disabled={ws.activePlate.objects.length === 0}
            onClick={ws.arrangeActivePlate}
          >
            <Grid2x2 size={15} />
          </button>
        </span>
        <span {...tipWrapProps("Auto-Orient Selected", "O")}>
          <button
            className="icon-btn"
            {...tipBtnProps("Auto-Orient Selected", "O")}
            disabled={!hasSel}
            onClick={ws.autoOrientSelectedNative}
          >
            <Compass size={15} />
          </button>
        </span>

        <span className="toolbar-sep" />

        {/* Transform Tools */}
        <span {...tipWrapProps("Select", "Esc")}>
          <button
            className={`icon-btn ${ws.tool === "select" ? "active" : ""}`}
            {...tipBtnProps("Select", "Esc")}
            onClick={() => ws.setTool("select")}
          >
            <MousePointer2 size={15} />
          </button>
        </span>
        <span {...tipWrapProps("Move", "M")}>
          <button
            className={`icon-btn ${ws.tool === "move" ? "active" : ""}`}
            {...tipBtnProps("Move", "M")}
            disabled={!hasSel}
            onClick={() => ws.setTool(ws.tool === "move" ? "select" : "move")}
          >
            <Move size={15} />
          </button>
        </span>
        <span {...tipWrapProps("Rotate", "R")}>
          <button
            className={`icon-btn ${ws.tool === "rotate" ? "active" : ""}`}
            {...tipBtnProps("Rotate", "R")}
            disabled={!hasSel}
            onClick={() => ws.setTool(ws.tool === "rotate" ? "select" : "rotate")}
          >
            <RotateCw size={15} />
          </button>
        </span>
        <span {...tipWrapProps("Scale", "S")}>
          <button
            className={`icon-btn ${ws.tool === "scale" ? "active" : ""}`}
            {...tipBtnProps("Scale", "S")}
            disabled={!hasSel}
            onClick={() => ws.setTool(ws.tool === "scale" ? "select" : "scale")}
          >
            <Maximize2 size={15} />
          </button>
        </span>
        <span {...tipWrapProps("Lay on Face", "F")}>
          <button
            className={`icon-btn ${ws.tool === "lay_on_face" ? "active" : ""}`}
            {...tipBtnProps("Lay on Face", "F")}
            disabled={!hasSel}
            onClick={() => ws.setTool(ws.tool === "lay_on_face" ? "select" : "lay_on_face")}
          >
            <AlignVerticalJustifyEnd size={15} />
          </button>
        </span>

        <span className="toolbar-sep" />

        {/* Mesh & Orca Painting Tools */}
        <span {...tipWrapProps("Cut Plane", "C")}>
          <button
            className={`icon-btn ${ws.tool === "cut" ? "active" : ""}`}
            {...tipBtnProps("Cut Plane", "C")}
            disabled={!hasSel}
            onClick={() => ws.setTool(ws.tool === "cut" ? "select" : "cut")}
          >
            <Scissors size={15} />
          </button>
        </span>
        <span {...tipWrapProps("Support Painting", "L")}>
          <button
            className={`icon-btn ${ws.tool === "paint_support" ? "active" : ""}`}
            {...tipBtnProps("Support Painting", "L")}
            disabled={!hasSel}
            onClick={() => ws.setTool(ws.tool === "paint_support" ? "select" : "paint_support")}
          >
            <Paintbrush size={15} />
          </button>
        </span>
        <span {...tipWrapProps("Seam Painting", "P")}>
          <button
            className={`icon-btn ${ws.tool === "paint_seam" ? "active" : ""}`}
            {...tipBtnProps("Seam Painting", "P")}
            disabled={!hasSel}
            onClick={() => ws.setTool(ws.tool === "paint_seam" ? "select" : "paint_seam")}
          >
            <PenTool size={15} />
          </button>
        </span>
        <span {...tipWrapProps("Color Painting", "N")}>
          <button
            className={`icon-btn ${ws.tool === "paint_color" ? "active" : ""}`}
            {...tipBtnProps("Color Painting", "N")}
            disabled={!hasSel}
            onClick={() => ws.setTool(ws.tool === "paint_color" ? "select" : "paint_color")}
          >
            <Palette size={15} />
          </button>
        </span>
        <span {...tipWrapProps("Variable Layer Height", "V")}>
          <button
            className={`icon-btn ${ws.tool === "variable_layer" ? "active" : ""}`}
            {...tipBtnProps("Variable Layer Height", "V")}
            disabled={!hasSel}
            onClick={() => ws.setTool(ws.tool === "variable_layer" ? "select" : "variable_layer")}
          >
            <Sliders size={15} />
          </button>
        </span>
        <span {...tipWrapProps("Measure Distance", "U")}>
          <button
            className={`icon-btn ${ws.tool === "measure" ? "active" : ""}`}
            {...tipBtnProps("Measure Distance", "U")}
            onClick={() => {
              ws.setMeasurePoints([]);
              ws.setTool(ws.tool === "measure" ? "select" : "measure");
            }}
          >
            <Ruler size={15} />
          </button>
        </span>
        <span {...tipWrapProps("Emboss 3D Text", "T")}>
          <button
            className={`icon-btn ${ws.tool === "text_emboss" ? "active" : ""}`}
            {...tipBtnProps("Emboss 3D Text", "T")}
            onClick={() => ws.setTool(ws.tool === "text_emboss" ? "select" : "text_emboss")}
          >
            <Type size={15} />
          </button>
        </span>

        <span className="toolbar-sep" />

        {/* Mesh Operations */}
        <span {...tipWrapProps("Clone Selected", "Ctrl+K")}>
          <button
            className="icon-btn"
            {...tipBtnProps("Clone Selected", "Ctrl+K")}
            disabled={!hasSel}
            onClick={() => ws.cloneSelected(1)}
          >
            <Copy size={15} />
          </button>
        </span>

        <div ref={mirrorRef} style={{ position: "relative" }}>
          <span {...tipWrapProps("Mirror X / Y / Z")}>
            <button
              className={`icon-btn ${mirrorOpen ? "active" : ""}`}
              {...tipBtnProps("Mirror X / Y / Z")}
              disabled={!hasSel}
              onClick={(e) => {
                hideTooltip();
                const r = e.currentTarget.getBoundingClientRect();
                setMirrorAnchor({ left: Math.min(window.innerWidth - 148, Math.max(12, r.left)), top: r.bottom + 8 });
                setMirrorOpen((v) => !v);
              }}
            >
              <FlipHorizontal2 size={15} />
            </button>
          </span>
          {mirrorOpen && (
            <div className="menu-popover" style={{ position: "fixed", top: mirrorAnchor.top, left: mirrorAnchor.left, width: 138 }}>
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

        <span {...tipWrapProps("Split to Objects")}>
          <button
            className="icon-btn"
            {...tipBtnProps("Split to Objects")}
            disabled={!hasSel}
            onClick={ws.splitSelectedToObjects}
          >
            <Ungroup size={15} />
          </button>
        </span>
        <span {...tipWrapProps("Fix Model (Native Repair)")}>
          <button
            className="icon-btn"
            {...tipBtnProps("Fix Model (Native Repair)")}
            disabled={!hasSel}
            onClick={ws.repairSelectedNative}
          >
            <Wrench size={15} />
          </button>
        </span>

        <span className="toolbar-sep" />

        {/* Display & History */}
        <span {...tipWrapProps("Highlight Overhangs (>45°)", "H")}>
          <button
            className={`icon-btn ${ws.showOverhangs ? "active" : ""}`}
            {...tipBtnProps("Highlight Overhangs (>45°)", "H")}
            onClick={() => ws.setShowOverhangs((v) => !v)}
          >
            <TriangleAlert size={15} />
          </button>
        </span>
        <span {...tipWrapProps("Undo", "Ctrl+Z")}>
          <button className="icon-btn" {...tipBtnProps("Undo", "Ctrl+Z")} disabled={!ws.canUndo} onClick={ws.undo}>
            <Undo2 size={15} />
          </button>
        </span>
        <span {...tipWrapProps("Redo", "Ctrl+Y")}>
          <button className="icon-btn" {...tipBtnProps("Redo", "Ctrl+Y")} disabled={!ws.canRedo} onClick={ws.redo}>
            <Redo2 size={15} />
          </button>
        </span>
      </div>

      {tip && (
        <div
          id={tipId}
          role="tooltip"
          className="toolbar-tooltip"
          style={{ left: tip.x, top: tip.y }}
        >
          <span>{tip.label}</span>
          {tip.shortcut && <span className="toolbar-tooltip-kbd">{tip.shortcut}</span>}
        </div>
      )}
    </>
  );
}
