import { useEffect, useState } from "react";
import {
  AlignVerticalJustifyEnd,
  Box,
  ChevronDown,
  ChevronUp,
  Crosshair,
  Move,
  Paintbrush,
  Palette,
  PenTool,
  RotateCw,
  Ruler,
  Scissors,
  Sliders,
  Trash2,
  Type,
  X,
} from "lucide-react";
import type { WorkspaceAPI } from "../store/useWorkspace";
import { getObjectWorldBounds } from "../lib/geometry";

export function ToolInspector({ ws }: { ws: WorkspaceAPI }) {
  const [uniformScale, setUniformScale] = useState(true);
  const [embossText, setEmbossText] = useState("ORCA");
  const [embossHeight, setEmbossHeight] = useState(14);
  const [embossDepth, setEmbossDepth] = useState(2.4);
  const [mobileExpanded, setMobileExpanded] = useState(false);

  // Auto-expand mobile bottom sheet when switching into an interactive tool, collapse when returning to plain select
  useEffect(() => {
    setMobileExpanded(ws.tool !== "select");
  }, [ws.tool]);

  const obj = ws.selectedObject;

  // Show inspector when a dedicated tool is active OR an object is selected
  if (!obj && ws.tool !== "measure" && ws.tool !== "text_emboss") {
    return null;
  }

  const worldBounds = obj ? getObjectWorldBounds(obj) : null;
  const mobileSummaryTitle =
    ws.tool === "text_emboss"
      ? "Emboss 3D Text"
      : ws.tool === "measure"
      ? "Measure Tool"
      : ws.tool === "lay_on_face"
      ? "Lay on Face"
      : ws.tool === "cut"
      ? "Cut Plane"
      : ws.tool === "paint_support"
      ? "Support Painting"
      : ws.tool === "paint_seam"
      ? "Seam Painting"
      : ws.tool === "paint_color"
      ? "Color Painting"
      : ws.tool === "variable_layer"
      ? "Variable Layer Height"
      : obj?.name || "Inspector";

  return (
    <aside
      className={`tool-inspector ${mobileExpanded ? "mobile-expanded" : "mobile-collapsed"}`}
      aria-label="Tool inspector"
    >
      <div className="mobile-sheet-bar">
        <button
          className="mobile-sheet-toggle"
          onClick={() => setMobileExpanded((v) => !v)}
          aria-expanded={mobileExpanded}
        >
          <span className="mobile-sheet-pill" aria-hidden="true" />
          <span className="mobile-sheet-summary">
            <strong>{mobileSummaryTitle}</strong>
            {worldBounds && (
              <span className="mono" style={{ fontSize: 10.5, color: "var(--text-muted)" }}>
                {worldBounds.size[0].toFixed(0)}×{worldBounds.size[1].toFixed(0)}×{worldBounds.size[2].toFixed(0)} mm
              </span>
            )}
          </span>
          {mobileExpanded ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
        </button>
        {obj && ws.tool === "select" && (
          <button
            className="icon-btn icon-btn-sm"
            onClick={ws.deleteSelected}
            aria-label="Delete selected object"
          >
            <Trash2 size={13} color="#fca5a5" />
          </button>
        )}
      </div>

      <div className="tool-inspector-body">
      {ws.tool === "text_emboss" && (
        <>
          <div className="inspector-header">
            <span className="inspector-title"><Type size={14} /> Emboss 3D Text</span>
            <button className="icon-btn icon-btn-sm" onClick={() => ws.setTool("select")} aria-label="Close"><X size={13} /></button>
          </div>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span className="field-label">Text</span>
            <input className="input mono" value={embossText} onChange={(e) => setEmbossText(e.target.value)} maxLength={24} />
          </label>
          <div className="field-row">
            <span className="field-label">Letter height</span>
            <div className="input-num-wrap">
              <input type="number" min={4} max={60} step={1} value={embossHeight} onChange={(e) => setEmbossHeight(Number(e.target.value) || 12)} />
              <span className="input-unit">mm</span>
            </div>
          </div>
          <div className="field-row">
            <span className="field-label">Extrude depth</span>
            <div className="input-num-wrap">
              <input type="number" min={0.4} max={20} step={0.4} value={embossDepth} onChange={(e) => setEmbossDepth(Number(e.target.value) || 2)} />
              <span className="input-unit">mm</span>
            </div>
          </div>
          <button
            className="btn btn-primary"
            onClick={() => {
              ws.addTextEmboss(embossText, embossHeight, embossDepth);
              ws.setTool("select");
            }}
          >
            Add Text to Plate
          </button>
        </>
      )}

      {ws.tool === "measure" && (
        <>
          <div className="inspector-header">
            <span className="inspector-title"><Ruler size={14} /> Measure Tool</span>
            <button className="icon-btn icon-btn-sm" onClick={() => { ws.setMeasurePoints([]); ws.setTool("select"); }} aria-label="Close"><X size={13} /></button>
          </div>
          <p style={{ margin: 0, fontSize: 11.5, color: "var(--text-secondary)" }}>
            Click two points on any model or the build plate to measure exact 3D distance.
          </p>
          {ws.measurePoints.length === 2 ? (() => {
            const [a, b] = ws.measurePoints;
            const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
            const dist = Math.hypot(dx, dy, dz);
            return (
              <div className="stat-grid">
                <div className="stat-cell" style={{ gridColumn: "1 / -1" }}>
                  <span className="stat-cell-label">3D Distance</span>
                  <span className="stat-cell-value" style={{ color: "var(--accent-text)" }}>{dist.toFixed(2)} mm</span>
                </div>
                <div className="stat-cell"><span className="stat-cell-label">ΔX</span><span className="stat-cell-value">{Math.abs(dx).toFixed(2)}</span></div>
                <div className="stat-cell"><span className="stat-cell-label">ΔY</span><span className="stat-cell-value">{Math.abs(dy).toFixed(2)}</span></div>
                <div className="stat-cell"><span className="stat-cell-label">ΔZ</span><span className="stat-cell-value">{Math.abs(dz).toFixed(2)}</span></div>
                <div className="stat-cell"><span className="stat-cell-label">XY</span><span className="stat-cell-value">{Math.hypot(dx, dy).toFixed(2)}</span></div>
              </div>
            );
          })() : (
            <div className="mono" style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
              {ws.measurePoints.length === 0 ? "Waiting for Point A…" : "Point A locked. Click Point B…"}
            </div>
          )}
          <button className="btn btn-sm" onClick={() => ws.setMeasurePoints([])}>Clear Measurement</button>
        </>
      )}

      {obj && ws.tool === "lay_on_face" && (
        <>
          <div className="inspector-header">
            <span className="inspector-title"><AlignVerticalJustifyEnd size={14} /> Lay on Face</span>
            <button className="icon-btn icon-btn-sm" onClick={() => ws.setTool("select")} aria-label="Close"><X size={13} /></button>
          </div>
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-secondary)" }}>
            Hover over any flat face on <strong>{obj.name}</strong> and click to align that face flush with the build plate.
          </p>
          <button className="btn btn-sm" onClick={ws.autoOrientSelectedNative}>
            Use Native Auto-Orient Instead
          </button>
        </>
      )}

      {obj && ws.tool === "cut" && worldBounds && (
        <>
          <div className="inspector-header">
            <span className="inspector-title"><Scissors size={14} /> Cut Plane</span>
            <button className="icon-btn icon-btn-sm" onClick={() => ws.setTool("select")} aria-label="Close"><X size={13} /></button>
          </div>
          <div className="field-row">
            <span className="field-label">Cut Z height</span>
            <div className="input-num-wrap">
              <input
                type="number"
                step={0.5}
                min={0.2}
                max={Number((worldBounds.max[2] - 0.2).toFixed(2))}
                value={ws.cutHeight}
                onChange={(e) => ws.setCutHeight(Number(e.target.value) || 1)}
              />
              <span className="input-unit">mm</span>
            </div>
          </div>
          <input
            type="range"
            min={0.2}
            max={Math.max(1, worldBounds.max[2] - 0.2)}
            step={0.2}
            value={Math.min(ws.cutHeight, Math.max(0.2, worldBounds.max[2] - 0.2))}
            onChange={(e) => ws.setCutHeight(Number(e.target.value))}
            style={{ width: "100%", accentColor: "var(--accent)" }}
          />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            <button className="btn btn-sm" onClick={() => ws.cutSelectedAtZ(ws.cutHeight, "lower")}>Keep Lower</button>
            <button className="btn btn-sm" onClick={() => ws.cutSelectedAtZ(ws.cutHeight, "upper")}>Keep Upper</button>
          </div>
          <button className="btn btn-primary" onClick={() => ws.cutSelectedAtZ(ws.cutHeight, "both")}>
            Split Into Two Parts
          </button>
        </>
      )}

      {obj && (ws.tool === "paint_support" || ws.tool === "paint_seam" || ws.tool === "paint_color") && (
        <>
          <div className="inspector-header">
            <span className="inspector-title">
              {ws.tool === "paint_support" ? <><Paintbrush size={14} /> Support Painting</> :
               ws.tool === "paint_seam" ? <><PenTool size={14} /> Seam Painting</> :
               <><Palette size={14} /> Color Painting</>}
            </span>
            <button className="icon-btn icon-btn-sm" onClick={() => ws.setTool("select")} aria-label="Close"><X size={13} /></button>
          </div>

          <p style={{ margin: 0, fontSize: 11.5, color: "var(--text-secondary)" }}>
            Drag directly on <strong>{obj.name}</strong> to paint triangles. Hold Shift+Drag to orbit.
          </p>

          {ws.tool === "paint_color" ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="field-label">Active Filament Brush</span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {ws.filaments.map((f, idx) => (
                  <button
                    key={f.id}
                    className={`btn btn-sm ${ws.paintFilamentIndex === idx ? "btn-primary" : ""}`}
                    onClick={() => ws.setPaintFilamentIndex(idx)}
                  >
                    <span className="swatch-btn" style={{ width: 12, height: 12, background: f.color }} />
                    #{idx + 1}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="segmented" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
              {(["enforce", "block", "erase"] as const).map((m) => (
                <button
                  key={m}
                  className={`segmented-btn ${ws.paintMode === m ? "active" : ""}`}
                  onClick={() => ws.setPaintMode(m)}
                >
                  {m === "enforce" ? "Enforce" : m === "block" ? "Block" : "Erase"}
                </button>
              ))}
            </div>
          )}

          <div className="field-row">
            <span className="field-label">Brush radius</span>
            <div className="input-num-wrap">
              <input
                type="number"
                min={0.5}
                max={25}
                step={0.5}
                value={ws.paintBrushRadius}
                onChange={(e) => ws.setPaintBrushRadius(Math.max(0.5, Number(e.target.value) || 2))}
              />
              <span className="input-unit">mm</span>
            </div>
          </div>

          <button
            className="btn btn-sm btn-danger"
            onClick={() => {
              if (ws.tool === "paint_support") ws.updateObject(obj.id, { paintSupport: undefined });
              else if (ws.tool === "paint_seam") ws.updateObject(obj.id, { paintSeam: undefined });
              else ws.updateObject(obj.id, { paintColor: undefined });
            }}
          >
            Clear All Painted Faces
          </button>
        </>
      )}

      {obj && ws.tool === "variable_layer" && worldBounds && (
        <>
          <div className="inspector-header">
            <span className="inspector-title"><Sliders size={14} /> Variable Layer Height</span>
            <button className="icon-btn icon-btn-sm" onClick={() => ws.setTool("select")} aria-label="Close"><X size={13} /></button>
          </div>
          <p style={{ margin: 0, fontSize: 11.5, color: "var(--text-secondary)" }}>
            Adapt layer height across Z (0 – {worldBounds.size[2].toFixed(1)} mm) for fine curved tops and fast vertical walls.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            <button
              className="btn btn-sm"
              onClick={() => {
                const h = worldBounds.size[2];
                ws.updateObject(obj.id, {
                  variableLayers: [
                    { z: 0, layerHeight: 0.24 },
                    { z: h * 0.5, layerHeight: 0.2 },
                    { z: h * 0.85, layerHeight: 0.12 },
                    { z: h, layerHeight: 0.08 },
                  ],
                  overrides: { ...obj.overrides, adaptive_layer_height: "1" },
                });
                ws.notify("Applied adaptive variable layer curve", "success");
              }}
            >
              Adaptive Quality
            </button>
            <button
              className="btn btn-sm"
              onClick={() => {
                ws.updateObject(obj.id, { variableLayers: undefined });
                ws.notify("Reset variable layer height", "info");
              }}
            >
              Reset
            </button>
          </div>
          {obj.variableLayers && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {obj.variableLayers.map((pt, i) => (
                <div key={i} className="field-row">
                  <span className="mono" style={{ fontSize: 11, color: "var(--text-muted)" }}>Z = {pt.z.toFixed(1)} mm</span>
                  <div className="input-num-wrap" style={{ width: 96 }}>
                    <input
                      type="number"
                      step={0.02}
                      min={0.06}
                      max={0.36}
                      value={pt.layerHeight}
                      onChange={(e) => {
                        const next = [...(obj.variableLayers || [])];
                        next[i] = { ...pt, layerHeight: Number(e.target.value) || 0.2 };
                        ws.updateObject(obj.id, { variableLayers: next }, false);
                      }}
                    />
                    <span className="input-unit">mm</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* DEFAULT / MOVE / ROTATE / SCALE OBJECT INSPECTOR */}
      {obj && (ws.tool === "select" || ws.tool === "move" || ws.tool === "rotate" || ws.tool === "scale") && worldBounds && (
        <>
          <div className="inspector-header">
            <span className="inspector-title">
              {ws.tool === "move" ? <><Move size={14} /> Move</> :
               ws.tool === "rotate" ? <><RotateCw size={14} /> Rotate</> :
               ws.tool === "scale" ? <><Box size={14} /> Scale</> :
               <><Box size={14} /> {obj.name}</>}
            </span>
            <button className="icon-btn icon-btn-sm" title="Delete object" onClick={ws.deleteSelected} aria-label="Delete object">
              <Trash2 size={13} color="#fca5a5" />
            </button>
          </div>

          <div className="stat-grid">
            <div className="stat-cell">
              <span className="stat-cell-label">Dimensions (mm)</span>
              <span className="stat-cell-value" style={{ fontSize: 11.5 }}>
                {worldBounds.size[0].toFixed(1)} × {worldBounds.size[1].toFixed(1)} × {worldBounds.size[2].toFixed(1)}
              </span>
            </div>
            <div className="stat-cell">
              <span className="stat-cell-label">Volume / Mesh</span>
              <span className="stat-cell-value" style={{ fontSize: 11.5 }}>
                {(obj.geometry.volumeMm3 / 1000).toFixed(1)} cm³
              </span>
            </div>
          </div>

          {/* Position */}
          <div className="setting-group">
            <div className="setting-group-title">
              <span>Position (mm)</span>
              <div style={{ display: "inline-flex", gap: 4 }}>
                <button className="btn btn-sm" style={{ height: 20, padding: "0 5px", fontSize: 10.5 }} onClick={ws.centerSelected}>
                  <Crosshair size={10} /> Center
                </button>
                <button className="btn btn-sm" style={{ height: 20, padding: "0 5px", fontSize: 10.5 }} onClick={ws.dropSelectedToBed}>
                  Drop Z
                </button>
              </div>
            </div>
            {(["X", "Y", "Z"] as const).map((axis, idx) => (
              <div key={axis} className="field-row">
                <span className="field-label mono" style={{ color: idx === 0 ? "#f87171" : idx === 1 ? "#4ade80" : "#60a5fa" }}>{axis}</span>
                <div className="input-num-wrap">
                  <input
                    type="number"
                    step={1}
                    value={Number(obj.position[idx].toFixed(2))}
                    onChange={(e) => {
                      const next: [number, number, number] = [...obj.position];
                      next[idx] = Number(e.target.value) || 0;
                      ws.updateObject(obj.id, { position: next });
                    }}
                  />
                  <span className="input-unit">mm</span>
                </div>
              </div>
            ))}
          </div>

          {/* Rotation */}
          <div className="setting-group">
            <div className="setting-group-title">Rotation (°)</div>
            {(["X", "Y", "Z"] as const).map((axis, idx) => (
              <div key={axis} className="field-row">
                <span className="field-label mono" style={{ color: idx === 0 ? "#f87171" : idx === 1 ? "#4ade80" : "#60a5fa" }}>{axis}</span>
                <div style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                  <button
                    className="btn btn-sm mono"
                    style={{ height: 24, padding: "0 5px", fontSize: 10.5 }}
                    onClick={() => {
                      const next: [number, number, number] = [...obj.rotation];
                      next[idx] = (next[idx] + 90) % 360;
                      ws.updateObject(obj.id, { rotation: next });
                    }}
                  >
                    +90°
                  </button>
                  <div className="input-num-wrap" style={{ width: 88 }}>
                    <input
                      type="number"
                      step={5}
                      value={Number(obj.rotation[idx].toFixed(1))}
                      onChange={(e) => {
                        const next: [number, number, number] = [...obj.rotation];
                        next[idx] = Number(e.target.value) || 0;
                        ws.updateObject(obj.id, { rotation: next });
                      }}
                    />
                    <span className="input-unit">°</span>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Scale */}
          <div className="setting-group">
            <div className="setting-group-title">
              <span>Scale (%)</span>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10.5, cursor: "pointer" }}>
                <input type="checkbox" checked={uniformScale} onChange={(e) => setUniformScale(e.target.checked)} />
                <span>Uniform</span>
              </label>
            </div>
            {(["X", "Y", "Z"] as const).map((axis, idx) => (
              <div key={axis} className="field-row">
                <span className="field-label mono" style={{ color: idx === 0 ? "#f87171" : idx === 1 ? "#4ade80" : "#60a5fa" }}>{axis}</span>
                <div className="input-num-wrap">
                  <input
                    type="number"
                    step={5}
                    min={5}
                    max={1000}
                    value={Number((obj.scale[idx] * 100).toFixed(1))}
                    onChange={(e) => {
                      const factor = Math.max(0.05, (Number(e.target.value) || 100) / 100);
                      const next: [number, number, number] = uniformScale
                        ? [factor, factor, factor]
                        : ([...obj.scale] as [number, number, number]);
                      if (!uniformScale) next[idx] = factor;
                      ws.updateObject(obj.id, { scale: next });
                    }}
                  />
                  <span className="input-unit">%</span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      </div>
    </aside>
  );
}
