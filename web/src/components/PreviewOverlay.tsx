import { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Code,
  Download,
  Eye,
  EyeOff,
  FileCode2,
  Pause,
  Play,
  Terminal,
  X,
} from "lucide-react";
import type { WorkspaceAPI } from "../store/useWorkspace";
import type { PreviewColorScheme } from "../types";
import { FEATURE_COLORS, formatDuration } from "../lib/gcode";

const COLOR_SCHEMES: Array<{ id: PreviewColorScheme; label: string }> = [
  { id: "line_type", label: "Line Type" },
  { id: "filament", label: "Filament" },
  { id: "speed", label: "Speed (mm/s)" },
  { id: "flow", label: "Flow (mm³/s)" },
  { id: "layer_height", label: "Layer Height (mm)" },
  { id: "line_width", label: "Line Width (mm)" },
  { id: "fan_speed", label: "Fan Speed (%)" },
  { id: "temperature", label: "Temperature (°C)" },
];

export function PreviewOverlay({ ws }: { ws: WorkspaceAPI }) {
  const [inspectorOpen, setInspectorOpen] = useState<"none" | "gcode" | "diagnostics">("none");
  const [gcodeFilter, setGcodeFilter] = useState("");

  const gcode = ws.parsedGcode;
  const maxLayer = gcode ? Math.max(0, gcode.layers.length - 1) : 0;
  const activeLayer = gcode?.layers[ws.layerTop];

  const gcodeSnippet = useMemo(() => {
    if (!gcode || inspectorOpen !== "gcode") return [];
    const lines = gcode.rawText.split(/\r?\n/);
    if (gcodeFilter.trim()) {
      const q = gcodeFilter.trim().toLowerCase();
      const hits: Array<{ num: number; text: string }> = [];
      for (let i = 0; i < lines.length && hits.length < 250; i++) {
        if (lines[i].toLowerCase().includes(q)) hits.push({ num: i + 1, text: lines[i] });
      }
      return hits;
    }
    const start = activeLayer?.startLine ?? 0;
    return lines.slice(start, start + 220).map((text, idx) => ({ num: start + idx + 1, text }));
  }, [gcode, inspectorOpen, gcodeFilter, activeLayer?.startLine]);

  if (!gcode) {
    return (
      <div
        className="empty-stage-hint"
        style={{
          top: "50%",
          bottom: "auto",
          transform: "translate(-50%, -50%)",
          flexDirection: "column",
          whiteSpace: "normal",
          padding: 20,
          gap: 12,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>No Sliced Toolpath Yet</div>
        <div style={{ fontSize: 12, color: "var(--text-secondary)", textAlign: "center", maxWidth: 300 }}>
          Arrange your models in Prepare and click <strong>Slice Plate</strong> to inspect layers, speeds, flows, and G-code.
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn" onClick={() => ws.setTab("prepare")}>Back to Prepare</button>
          <button
            className="btn btn-primary"
            disabled={ws.slicing || !ws.activePlate.objects.some((o) => o.visible)}
            onClick={ws.sliceActivePlate}
          >
            Slice Plate Now
          </button>
        </div>
      </div>
    );
  }

  const nativeStats = ws.currentJob?.summary?.statistics;
  const displayTime =
    ws.currentJob?.summary?.estimated_print_time ||
    (nativeStats?.time ? formatDuration(nativeStats.time) : gcode.stats.estimatedTimeLabel);
  const displayGrams =
    ws.currentJob?.summary?.filament_used_grams ||
    (nativeStats?.weight !== undefined ? nativeStats.weight.toFixed(2) : gcode.stats.filamentGrams.toFixed(2));
  const displayCost =
    ws.currentJob?.summary?.filament_cost ||
    (nativeStats?.filament_cost !== undefined ? nativeStats.filament_cost.toFixed(2) : gcode.stats.filamentCost.toFixed(2));

  const heatmapRange: [string, string] | null =
    ws.colorScheme === "speed"
      ? [`${gcode.ranges.speed[0].toFixed(0)} mm/s`, `${gcode.ranges.speed[1].toFixed(0)} mm/s`]
      : ws.colorScheme === "flow"
      ? [`${gcode.ranges.flow[0].toFixed(1)} mm³/s`, `${gcode.ranges.flow[1].toFixed(1)} mm³/s`]
      : ws.colorScheme === "layer_height"
      ? [`${gcode.ranges.layerHeight[0].toFixed(2)} mm`, `${gcode.ranges.layerHeight[1].toFixed(2)} mm`]
      : ws.colorScheme === "line_width"
      ? [`${gcode.ranges.lineWidth[0].toFixed(2)} mm`, `${gcode.ranges.lineWidth[1].toFixed(2)} mm`]
      : ws.colorScheme === "fan_speed"
      ? ["0%", "100%"]
      : ws.colorScheme === "temperature"
      ? [`${gcode.ranges.temp[0].toFixed(0)}°C`, `${gcode.ranges.temp[1].toFixed(0)}°C`]
      : null;

  const layerStartSeg = activeLayer?.startSegment ?? 0;
  const layerEndSeg = activeLayer?.endSegment ?? gcode.segmentCount;

  return (
    <>
      {/* TOP-RIGHT PREVIEW LEGEND & SLICE SUMMARY HUD */}
      <aside className="preview-hud" aria-label="Slice preview summary">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600 }}>Color Scheme</span>
          <select
            className="select"
            style={{ width: 158 }}
            value={ws.colorScheme}
            onChange={(e) => ws.setColorScheme(e.target.value as PreviewColorScheme)}
            aria-label="Toolpath color scheme"
          >
            {COLOR_SCHEMES.map((c) => (
              <option key={c.id} value={c.id}>{c.label}</option>
            ))}
          </select>
        </div>

        {heatmapRange && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div className="heatmap-bar" />
            <div className="mono" style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5, color: "var(--text-secondary)" }}>
              <span>{heatmapRange[0]}</span>
              <span>{heatmapRange[1]}</span>
            </div>
          </div>
        )}

        {/* Slice Summary Metrics */}
        <div className="stat-grid">
          <div className="stat-cell">
            <span className="stat-cell-label">Estimated Time</span>
            <span className="stat-cell-value" style={{ color: "var(--accent-text)" }}>{displayTime}</span>
          </div>
          <div className="stat-cell">
            <span className="stat-cell-label">Filament Used</span>
            <span className="stat-cell-value">{displayGrams} g</span>
          </div>
          <div className="stat-cell">
            <span className="stat-cell-label">Layers</span>
            <span className="stat-cell-value">{gcode.layers.length}</span>
          </div>
          <div className="stat-cell">
            <span className="stat-cell-label">Est. Cost / Length</span>
            <span className="stat-cell-value">${displayCost} · {(gcode.stats.filamentLengthMm / 1000).toFixed(2)}m</span>
          </div>
        </div>

        {/* Display Options */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5, fontSize: 11.5 }}>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 5, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={ws.realisticGloss}
              onChange={(e) => ws.setRealisticGloss(e.target.checked)}
            />
            <span>Realistic Gloss</span>
          </label>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 5, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={ws.dimLowerLayers}
              onChange={(e) => ws.setDimLowerLayers(e.target.checked)}
            />
            <span>Dim Lower</span>
          </label>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 5, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={!ws.hiddenFeatures.has("Travel")}
              onChange={() => ws.toggleFeatureVisibility("Travel")}
            />
            <span>Travel</span>
          </label>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 5, cursor: "pointer" }}>
            <input type="checkbox" checked={ws.showSeams} onChange={(e) => ws.setShowSeams(e.target.checked)} />
            <span>Seams</span>
          </label>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 5, cursor: "pointer" }}>
            <input type="checkbox" checked={ws.showRetractions} onChange={(e) => ws.setShowRetractions(e.target.checked)} />
            <span>Retractions</span>
          </label>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 5, cursor: "pointer" }}>
            <input type="checkbox" checked={ws.showNozzle} onChange={(e) => ws.setShowNozzle(e.target.checked)} />
            <span>Nozzle Head</span>
          </label>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 5, cursor: "pointer" }}>
            <input type="checkbox" checked={ws.showGhost} onChange={(e) => ws.setShowGhost(e.target.checked)} />
            <span>Ghost Model</span>
          </label>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 5, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={ws.sectionCutEnabled}
              onChange={(e) => ws.setSectionCutEnabled(e.target.checked)}
            />
            <span>Section Cut</span>
          </label>
        </div>

        {/* Section Cut Plane Controls (libvgcode ray-cast cut face) */}
        {ws.sectionCutEnabled && (
          <div style={{ display: "flex", flexDirection: "column", gap: 5, padding: "6px 8px", borderRadius: 6, background: "var(--bg-stage)", border: "1px solid var(--border-subtle)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
              <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>Cut Axis</span>
              <div style={{ display: "inline-flex", gap: 3 }}>
                {(["x", "y", "z"] as const).map((ax) => (
                  <button
                    key={ax}
                    className={`btn btn-sm ${ws.sectionCutAxis === ax ? "btn-primary" : ""}`}
                    style={{ height: 20, padding: "0 7px", fontSize: 10.5 }}
                    onClick={() => {
                      ws.setSectionCutAxis(ax);
                      const idx = ax === "x" ? 0 : ax === "y" ? 1 : 2;
                      ws.setSectionCutPosition(Number(((gcode.bounds.min[idx] + gcode.bounds.max[idx]) * 0.5).toFixed(1)));
                    }}
                  >
                    {ax.toUpperCase()}
                  </button>
                ))}
              </div>
              <span className="mono" style={{ fontSize: 10.5, color: "var(--text-primary)" }}>
                {ws.sectionCutPosition.toFixed(1)} mm
              </span>
            </div>
            <input
              type="range"
              min={ws.sectionCutAxis === "x" ? gcode.bounds.min[0] - 2 : ws.sectionCutAxis === "y" ? gcode.bounds.min[1] - 2 : 0}
              max={ws.sectionCutAxis === "x" ? gcode.bounds.max[0] + 2 : ws.sectionCutAxis === "y" ? gcode.bounds.max[1] + 2 : gcode.bounds.max[2] + 2}
              step={0.5}
              value={ws.sectionCutPosition}
              aria-label="Section cut plane position"
              onChange={(e) => ws.setSectionCutPosition(Number(e.target.value))}
            />
          </div>
        )}

        {/* Feature Type Breakdown */}
        <div className="setting-group">
          <div className="setting-group-title">
            <span>Line Type Breakdown</span>
            <span className="mono">{gcode.segmentCount.toLocaleString()} segs</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {gcode.stats.featureBreakdown.map((item) => {
              const hidden = ws.hiddenFeatures.has(item.feature);
              return (
                <div key={item.feature} className="feature-row" style={{ opacity: hidden ? 0.42 : 1 }}>
                  <button
                    className="icon-btn icon-btn-sm"
                    style={{ width: 16, height: 16 }}
                    onClick={() => ws.toggleFeatureVisibility(item.feature)}
                    aria-label={`Toggle ${item.feature}`}
                  >
                    {hidden ? <EyeOff size={11} /> : <Eye size={11} />}
                  </button>
                  <span className="feature-swatch" style={{ background: FEATURE_COLORS[item.feature] }} />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.feature}</span>
                  <span className="mono" style={{ fontSize: 10.5, color: "var(--text-secondary)" }}>{formatDuration(item.timeSeconds)}</span>
                  <span className="mono" style={{ fontSize: 10.5, color: "var(--text-muted)", minWidth: 34, textAlign: "right" }}>
                    {item.percentage.toFixed(0)}%
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Actions: G-code Inspector, Diagnostics, Export */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
          <button
            className={`btn btn-sm ${inspectorOpen === "gcode" ? "btn-primary" : ""}`}
            onClick={() => setInspectorOpen(inspectorOpen === "gcode" ? "none" : "gcode")}
          >
            <FileCode2 size={12} /> G-code
          </button>
          <button
            className={`btn btn-sm ${inspectorOpen === "diagnostics" ? "btn-primary" : ""}`}
            onClick={() => setInspectorOpen(inspectorOpen === "diagnostics" ? "none" : "diagnostics")}
          >
            <Terminal size={12} /> Engine Log
          </button>
        </div>

        <button className="btn btn-primary btn-sm" onClick={ws.exportSlicedGcodeFile}>
          <Download size={12} /> Download G-code ({(gcode.rawText.length / 1024).toFixed(0)} KiB)
        </button>
      </aside>

      {/* VERTICAL LAYER SLIDER (RIGHT EDGE) */}
      <div className="layer-slider-rail" aria-label="Layer slider">
        <button
          className="icon-btn icon-btn-sm"
          title="Step up one layer (↑)"
          aria-label="Next layer"
          onClick={() => {
            const next = Math.min(maxLayer, ws.layerTop + 1);
            ws.setLayerTop(next);
            ws.setMoveIndex(gcode.layers[next]?.endSegment ?? gcode.segmentCount);
          }}
        >
          <ChevronUp size={14} />
        </button>

        <span className="mono" style={{ fontSize: 10.5, fontWeight: 600, color: "var(--accent-text)" }}>
          {ws.layerTop + 1}
        </span>

        <input
          className="layer-slider-vertical"
          type="range"
          min={0}
          max={maxLayer}
          value={ws.layerTop}
          aria-label="Top visible layer"
          onChange={(e) => {
            const val = Number(e.target.value);
            ws.setLayerTop(val);
            if (val < ws.layerBottom) ws.setLayerBottom(val);
            ws.setMoveIndex(gcode.layers[val]?.endSegment ?? gcode.segmentCount);
          }}
        />

        <span className="mono" style={{ fontSize: 10, color: "var(--text-muted)" }}>
          {activeLayer ? `${activeLayer.z.toFixed(1)}` : "0"}
        </span>

        <button
          className="icon-btn icon-btn-sm"
          title="Step down one layer (↓)"
          aria-label="Previous layer"
          onClick={() => {
            const next = Math.max(ws.layerBottom, ws.layerTop - 1);
            ws.setLayerTop(next);
            ws.setMoveIndex(gcode.layers[next]?.endSegment ?? gcode.segmentCount);
          }}
        >
          <ChevronDown size={14} />
        </button>
      </div>

      {/* BOTTOM HORIZONTAL MOVE SCRUBBER + PLAYBACK */}
      <div className="move-scrubber" aria-label="Toolpath move scrubber">
        <button
          className={`icon-btn ${ws.isPlaying ? "active" : ""}`}
          title={ws.isPlaying ? "Pause toolpath playback" : "Play toolpath simulation"}
          aria-label={ws.isPlaying ? "Pause" : "Play"}
          onClick={() => {
            if (!ws.isPlaying && ws.moveIndex >= layerEndSeg) {
              ws.setMoveIndex(layerStartSeg);
            }
            ws.setIsPlaying((v) => !v);
          }}
        >
          {ws.isPlaying ? <Pause size={14} /> : <Play size={14} />}
        </button>

        <select
          className="select mono"
          style={{ width: 62, height: 24, fontSize: 11 }}
          value={ws.playSpeed}
          onChange={(e) => ws.setPlaySpeed(Number(e.target.value))}
          aria-label="Playback speed"
        >
          <option value={2}>1×</option>
          <option value={8}>4×</option>
          <option value={24}>12×</option>
          <option value={80}>40×</option>
        </select>

        <span className="mono" style={{ fontSize: 11, color: "var(--text-secondary)", minWidth: 96 }}>
          L{ws.layerTop + 1}/{gcode.layers.length} · Z {activeLayer?.z.toFixed(2) ?? "0.00"}
        </span>

        <input
          type="range"
          min={layerStartSeg}
          max={Math.max(layerStartSeg + 1, layerEndSeg)}
          value={Math.max(layerStartSeg, Math.min(ws.moveIndex, layerEndSeg))}
          aria-label="Scrub extrusion moves in active layer"
          onChange={(e) => {
            ws.setIsPlaying(false);
            ws.setMoveIndex(Number(e.target.value));
          }}
        />

        <span className="mono" style={{ fontSize: 11, color: "var(--text-muted)", minWidth: 74, textAlign: "right" }}>
          {Math.max(0, ws.moveIndex - layerStartSeg)}/{Math.max(0, layerEndSeg - layerStartSeg)}
        </span>
      </div>

      {/* G-CODE / NATIVE DIAGNOSTICS MODAL DRAWER */}
      {inspectorOpen !== "none" && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setInspectorOpen("none")}>
          <div className="modal-panel" style={{ maxWidth: 780 }}>
            <div className="modal-header">
              <span className="modal-title" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                <Code size={15} />
                {inspectorOpen === "gcode"
                  ? `G-code Inspector — Layer ${ws.layerTop + 1} (${gcode.lineCount.toLocaleString()} lines)`
                  : "Native OrcaSlicer 2.5.0 Feedback & Engine Log"}
              </span>
              <button className="icon-btn" onClick={() => setInspectorOpen("none")} aria-label="Close"><X size={16} /></button>
            </div>

            <div className="modal-body">
              {inspectorOpen === "gcode" ? (
                <>
                  <input
                    className="input mono"
                    placeholder="Filter G-code lines (e.g. M104, ;TYPE:, G2, E-)…"
                    value={gcodeFilter}
                    onChange={(e) => setGcodeFilter(e.target.value)}
                  />
                  <pre
                    className="mono"
                    style={{
                      margin: 0,
                      padding: 12,
                      background: "var(--bg-stage)",
                      border: "1px solid var(--border-subtle)",
                      borderRadius: "var(--radius-md)",
                      fontSize: 11.5,
                      lineHeight: 1.5,
                      overflow: "auto",
                      maxHeight: 420,
                    }}
                  >
                    {gcodeSnippet.map((l) => `${String(l.num).padStart(6, " ")} │ ${l.text}`).join("\n")}
                  </pre>
                </>
              ) : (
                <>
                  {ws.currentJob?.feedback?.native_result?.warnings?.length ? (
                    <div style={{ padding: 10, borderRadius: 6, background: "var(--warning-tint)", border: "1px solid rgba(245,158,11,0.4)", fontSize: 12 }}>
                      <strong>Native Warnings:</strong>
                      <ul style={{ margin: "6px 0 0 18px", padding: 0 }}>
                        {ws.currentJob.feedback.native_result.warnings.map((w, i) => (
                          <li key={i}>{typeof w === "string" ? w : w.message || w.code}</li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <div style={{ fontSize: 12, color: "var(--accent-text)" }}>
                      No native slicing warnings reported by OrcaSlicer 2.5.0.
                    </div>
                  )}

                  {ws.currentJob?.feedback?.field_evidence && (
                    <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                      Explicit overrides verified:{" "}
                      <strong className="mono">
                        {ws.currentJob.feedback.field_evidence.explicit_mismatch_count === 0
                          ? "All matched native export"
                          : `${ws.currentJob.feedback.field_evidence.explicit_mismatch_count} normalized by engine`}
                      </strong>
                    </div>
                  )}

                  <pre
                    className="mono"
                    style={{
                      margin: 0,
                      padding: 12,
                      background: "var(--bg-stage)",
                      border: "1px solid var(--border-subtle)",
                      borderRadius: "var(--radius-md)",
                      fontSize: 11,
                      lineHeight: 1.45,
                      overflow: "auto",
                      maxHeight: 360,
                      color: "var(--text-secondary)",
                    }}
                  >
                    {ws.currentJob?.feedback?.native_log_tail || "No engine log captured."}
                  </pre>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
