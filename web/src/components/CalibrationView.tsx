import { useState } from "react";
import { ArrowRight, Gauge } from "lucide-react";
import type { WorkspaceAPI } from "../store/useWorkspace";
import { CALIBRATION_SPECS, type CalibrationId } from "../lib/calibration";

export function CalibrationView({ ws }: { ws: WorkspaceAPI }) {
  const [selectedId, setSelectedId] = useState<CalibrationId>("temp_tower");
  const spec = CALIBRATION_SPECS.find((s) => s.id === selectedId) || CALIBRATION_SPECS[0];
  const [paramsByTest, setParamsByTest] = useState<Record<string, Record<string, number | string>>>(() =>
    Object.fromEntries(CALIBRATION_SPECS.map((s) => [s.id, { ...s.defaults }]))
  );

  const curParams = paramsByTest[spec.id] || spec.defaults;

  const updateParam = (key: string, value: number | string) => {
    setParamsByTest((prev) => {
      const next = { ...(prev[spec.id] || spec.defaults), [key]: value };
      if (spec.id === "temp_tower" && key === "material") {
        if (value === "PLA") { next.startTemp = 230; next.endTemp = 190; }
        else if (value === "PETG") { next.startTemp = 260; next.endTemp = 220; }
        else if (value === "ABS") { next.startTemp = 270; next.endTemp = 230; }
        else if (value === "TPU") { next.startTemp = 240; next.endTemp = 200; }
      }
      return { ...prev, [spec.id]: next };
    });
  };

  return (
    <div className="calibration-view">
      <div className="calibration-inner">
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600, letterSpacing: "-0.02em", display: "inline-flex", alignItems: "center", gap: 8 }}>
              <Gauge size={18} color="var(--accent-text)" /> OrcaSlicer Calibration Suite
            </h1>
            <p style={{ margin: "4px 0 0", color: "var(--text-secondary)", fontSize: 12.5 }}>
              Generate calibrated test prints directly onto your active build plate with recommended OrcaSlicer process overrides.
            </p>
          </div>
          <span className="mono" style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
            Active printer: {ws.printer.name}
          </span>
        </div>

        <div className="calibration-grid">
          <div className="calibration-list" role="listbox" aria-label="Calibration tests">
            {CALIBRATION_SPECS.map((item) => {
              const active = item.id === spec.id;
              return (
                <button
                  key={item.id}
                  role="option"
                  aria-selected={active}
                  className={`calibration-item ${active ? "active" : ""}`}
                  onClick={() => setSelectedId(item.id)}
                >
                  <span style={{ fontWeight: 600, fontSize: 12.5, color: active ? "var(--accent-text)" : "var(--text-primary)" }}>
                    {item.name}
                  </span>
                  <span style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
                    {item.summary}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="calibration-detail">
            <div>
              <div style={{ fontSize: 11, color: "var(--accent-text)", fontWeight: 600, marginBottom: 4 }}>
                {spec.category}
              </div>
              <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{spec.name}</h2>
              <p style={{ margin: "6px 0 0", color: "var(--text-secondary)", fontSize: 12.5, lineHeight: 1.55 }}>
                {spec.description}
              </p>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 6, borderTop: "1px solid var(--border-subtle)" }}>
              {spec.fields.map((field) => (
                <div key={field.key} className="field-row">
                  <span className="field-label">{field.label}</span>
                  {field.type === "select" ? (
                    <select
                      className="select"
                      style={{ width: 196 }}
                      value={String(curParams[field.key] ?? "")}
                      onChange={(e) => updateParam(field.key, e.target.value)}
                    >
                      {field.options?.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  ) : (
                    <div className="input-num-wrap" style={{ width: 130 }}>
                      <input
                        type="number"
                        step={field.step ?? 1}
                        min={field.min}
                        max={field.max}
                        value={Number(curParams[field.key] ?? 0)}
                        onChange={(e) => updateParam(field.key, Number(e.target.value))}
                      />
                      {field.unit && <span className="input-unit">{field.unit}</span>}
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingTop: 10, borderTop: "1px solid var(--border-subtle)" }}>
              <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
                Places geometry on <strong>{ws.activePlate.name}</strong> and switches to Prepare
              </span>
              <button
                className="btn btn-primary"
                style={{ height: 34, padding: "0 14px" }}
                onClick={() => ws.applyCalibration(spec.id, curParams)}
              >
                <span>Generate on Build Plate</span>
                <ArrowRight size={14} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
