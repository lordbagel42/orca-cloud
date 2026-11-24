import { useEffect, useState } from "react";
import { RotateCcw, Search, X } from "lucide-react";
import type { FilamentSlot, OrcaSettingsMap } from "../types";
import { getNativeSettingsCatalog, getProfileDetail, type NativeSettingsCatalog } from "../lib/api";
import { FILAMENT_EDIT_FIELDS } from "../lib/settingsSchema";

export function FilamentEditorModal({
  slot,
  slotIndex,
  onSave,
  onClose,
}: {
  slot: FilamentSlot;
  slotIndex: number;
  onSave: (overrides: OrcaSettingsMap) => void;
  onClose: () => void;
}) {
  const [baseSettings, setBaseSettings] = useState<OrcaSettingsMap>({});
  const [draft, setDraft] = useState<OrcaSettingsMap>({ ...slot.overrides });

  useEffect(() => {
    getProfileDetail({ vendor: slot.profile.vendor, kind: "filament", name: slot.profile.name })
      .then((d) => setBaseSettings(d.settings))
      .catch(() => {});
  }, [slot.profile]);

  const getVal = (key: string): string => {
    const v = draft[key] ?? baseSettings[key];
    if (Array.isArray(v)) return v[0] ?? "";
    return typeof v === "string" ? v : "";
  };

  const setVal = (key: string, val: string, isArray?: boolean) => {
    setDraft((prev) => ({ ...prev, [key]: isArray ? [val] : val }));
  };

  const groups = Array.from(new Set(FILAMENT_EDIT_FIELDS.map((f) => f.group)));

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-panel" role="dialog" aria-modal="true" aria-label="Edit Filament Settings">
        <div className="modal-header">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="swatch-btn" style={{ background: slot.color }} />
            <div>
              <div className="modal-title">Filament #{slotIndex + 1} — {slot.profile.name}</div>
              <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{slot.profile.vendor}</div>
            </div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>

        <div className="modal-body">
          {groups.map((grp) => (
            <div key={grp} className="setting-group">
              <div className="setting-group-title">{grp}</div>
              {FILAMENT_EDIT_FIELDS.filter((f) => f.group === grp).map((field) => {
                const modified = draft[field.key] !== undefined;
                const cur = getVal(field.key);
                return (
                  <div key={field.key} className="field-row">
                    <span className={`field-label ${modified ? "modified" : ""}`}>
                      <span>{field.label}</span>
                      {modified && (
                        <button
                          className="icon-btn icon-btn-sm"
                          title="Reset to profile default"
                          onClick={() => {
                            const next = { ...draft };
                            delete next[field.key];
                            setDraft(next);
                          }}
                        >
                          <RotateCcw size={11} />
                        </button>
                      )}
                    </span>
                    {field.type === "boolean" ? (
                      <button
                        role="switch"
                        aria-checked={cur === "1" || cur === "true"}
                        className="toggle-btn"
                        onClick={() => setVal(field.key, cur === "1" ? "0" : "1", field.arrayVal)}
                      >
                        <span className="toggle-thumb" />
                      </button>
                    ) : (
                      <div className="input-num-wrap">
                        <input
                          type="number"
                          step={field.step ?? 1}
                          value={cur}
                          onChange={(e) => setVal(field.key, e.target.value, field.arrayVal)}
                        />
                        {field.unit && <span className="input-unit">{field.unit}</span>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        <div className="modal-footer">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => { onSave(draft); onClose(); }}>
            Apply Filament Overrides
          </button>
        </div>
      </div>
    </div>
  );
}

export function PrinterEditorModal({
  printerName,
  baseSettings,
  overrides,
  onSave,
  onClose,
}: {
  printerName: string;
  baseSettings: OrcaSettingsMap;
  overrides: OrcaSettingsMap;
  onSave: (next: OrcaSettingsMap) => void;
  onClose: () => void;
}) {
  const [subTab, setSubTab] = useState<"basic" | "extruder" | "gcode">("basic");
  const [draft, setDraft] = useState<OrcaSettingsMap>({ ...overrides });

  const getStr = (k: string) => {
    const v = draft[k] ?? baseSettings[k];
    return Array.isArray(v) ? v[0] ?? "" : typeof v === "string" ? v : "";
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-panel" role="dialog" aria-modal="true" aria-label="Printer Settings">
        <div className="modal-header">
          <span className="modal-title">Printer Settings — {printerName}</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>

        <div style={{ padding: "8px 18px", borderBottom: "1px solid var(--border-subtle)", display: "flex", gap: 6 }}>
          {(["basic", "extruder", "gcode"] as const).map((t) => (
            <button
              key={t}
              className={`btn btn-sm ${subTab === t ? "btn-primary" : ""}`}
              onClick={() => setSubTab(t)}
            >
              {t === "basic" ? "Basic & Motion" : t === "extruder" ? "Extruder" : "Machine G-code"}
            </button>
          ))}
        </div>

        <div className="modal-body">
          {subTab === "basic" && (
            <>
              {[
                { key: "printable_height", label: "Printable height (Z)", unit: "mm", arr: false },
                { key: "machine_max_speed_x", label: "Max speed X", unit: "mm/s", arr: true },
                { key: "machine_max_speed_y", label: "Max speed Y", unit: "mm/s", arr: true },
                { key: "machine_max_speed_z", label: "Max speed Z", unit: "mm/s", arr: true },
                { key: "machine_max_acceleration_x", label: "Max acceleration X", unit: "mm/s²", arr: true },
                { key: "machine_max_acceleration_y", label: "Max acceleration Y", unit: "mm/s²", arr: true },
                { key: "machine_max_acceleration_extruding", label: "Max accel extruding", unit: "mm/s²", arr: true },
                { key: "machine_max_acceleration_travel", label: "Max accel travel", unit: "mm/s²", arr: true },
              ].map((f) => (
                <div key={f.key} className="field-row">
                  <span className={`field-label ${draft[f.key] !== undefined ? "modified" : ""}`}>{f.label}</span>
                  <div className="input-num-wrap" style={{ width: 130 }}>
                    <input
                      type="number"
                      value={getStr(f.key)}
                      onChange={(e) => setDraft({ ...draft, [f.key]: f.arr ? [e.target.value] : e.target.value })}
                    />
                    <span className="input-unit">{f.unit}</span>
                  </div>
                </div>
              ))}
            </>
          )}

          {subTab === "extruder" && (
            <>
              {[
                { key: "nozzle_diameter", label: "Nozzle diameter", unit: "mm", arr: true },
                { key: "retraction_length", label: "Retraction length", unit: "mm", arr: true },
                { key: "retraction_speed", label: "Retraction speed", unit: "mm/s", arr: true },
                { key: "deretraction_speed", label: "Deretraction speed", unit: "mm/s", arr: true },
                { key: "z_hop", label: "Z hop when retracting", unit: "mm", arr: true },
                { key: "retraction_minimum_travel", label: "Travel distance threshold", unit: "mm", arr: true },
                { key: "wipe_distance", label: "Wipe distance", unit: "mm", arr: true },
              ].map((f) => (
                <div key={f.key} className="field-row">
                  <span className={`field-label ${draft[f.key] !== undefined ? "modified" : ""}`}>{f.label}</span>
                  <div className="input-num-wrap" style={{ width: 130 }}>
                    <input
                      type="number"
                      step={0.1}
                      value={getStr(f.key)}
                      onChange={(e) => setDraft({ ...draft, [f.key]: f.arr ? [e.target.value] : e.target.value })}
                    />
                    <span className="input-unit">{f.unit}</span>
                  </div>
                </div>
              ))}
            </>
          )}

          {subTab === "gcode" && (
            <>
              {[
                { key: "machine_start_gcode", label: "Machine start G-code" },
                { key: "machine_end_gcode", label: "Machine end G-code" },
                { key: "before_layer_change_gcode", label: "Before layer change G-code" },
                { key: "layer_change_gcode", label: "Layer change G-code" },
              ].map((g) => (
                <label key={g.key} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span className={`field-label ${draft[g.key] !== undefined ? "modified" : ""}`}>{g.label}</span>
                  <textarea
                    className="input mono"
                    style={{ height: 96, padding: 8, resize: "vertical", lineHeight: 1.45 }}
                    value={getStr(g.key)}
                    onChange={(e) => setDraft({ ...draft, [g.key]: e.target.value })}
                  />
                </label>
              ))}
            </>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn" onClick={() => setDraft({})}>Reset All</button>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => { onSave(draft); onClose(); }}>
            Save Printer Overrides
          </button>
        </div>
      </div>
    </div>
  );
}

export function FlushMatrixModal({
  filaments,
  matrix,
  onSave,
  onClose,
}: {
  filaments: FilamentSlot[];
  matrix: number[][];
  onSave: (next: number[][]) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<number[][]>(() =>
    filaments.map((_, r) => filaments.map((__, c) => (r === c ? 0 : matrix[r]?.[c] ?? 280)))
  );

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-panel" style={{ maxWidth: 560 }} role="dialog" aria-modal="true" aria-label="Flushing Volumes">
        <div className="modal-header">
          <span className="modal-title">Flushing Volumes (mm³)</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <div className="modal-body">
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-secondary)" }}>
            Purge volume in mm³ when switching from row filament (From) to column filament (To).
          </p>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr>
                  <th style={{ padding: 6, textAlign: "left", color: "var(--text-muted)" }}>From \ To</th>
                  {filaments.map((f, idx) => (
                    <th key={f.id} style={{ padding: 6, textAlign: "center" }}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <span className="swatch-btn" style={{ width: 12, height: 12, background: f.color }} />
                        #{idx + 1}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filaments.map((f, r) => (
                  <tr key={f.id}>
                    <td style={{ padding: 6 }}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                        <span className="swatch-btn" style={{ width: 12, height: 12, background: f.color }} />
                        #{r + 1}
                      </span>
                    </td>
                    {filaments.map((fc, c) => (
                      <td key={fc.id} style={{ padding: 4, textAlign: "center" }}>
                        {r === c ? (
                          <span className="mono" style={{ color: "var(--text-muted)" }}>—</span>
                        ) : (
                          <input
                            className="input mono"
                            type="number"
                            style={{ width: 64, textAlign: "right" }}
                            value={draft[r][c]}
                            onChange={(e) => {
                              const next = draft.map((row) => [...row]);
                              next[r][c] = Math.max(0, Number(e.target.value) || 0);
                              setDraft(next);
                            }}
                          />
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => { onSave(draft); onClose(); }}>
            Apply Flush Matrix
          </button>
        </div>
      </div>
    </div>
  );
}

export function AllNativeSettingsModal({
  baseProcess,
  overrides,
  onSetOverride,
  onClose,
}: {
  baseProcess: OrcaSettingsMap;
  overrides: OrcaSettingsMap;
  onSetOverride: (key: string, val: string | undefined) => void;
  onClose: () => void;
}) {
  const [catalog, setCatalog] = useState<NativeSettingsCatalog | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    getNativeSettingsCatalog().then(setCatalog).catch(() => {});
  }, []);

  const keys = catalog
    ? Object.entries(catalog.settings)
        .filter(([k, meta]) => {
          if (meta.classification !== "native_exportable") return false;
          if (!q.trim()) return true;
          return k.toLowerCase().includes(q.trim().toLowerCase());
        })
        .slice(0, 120)
    : [];

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-panel" style={{ maxWidth: 740 }} role="dialog" aria-modal="true" aria-label="All Native OrcaSlicer Settings">
        <div className="modal-header">
          <span className="modal-title">All Native OrcaSlicer 2.5.0 Keys</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <div className="modal-body">
          <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
            <Search size={14} style={{ position: "absolute", left: 9, color: "var(--text-muted)" }} />
            <input
              className="input"
              style={{ width: "100%", height: 32, paddingLeft: 30 }}
              placeholder="Search all 750+ native OrcaSlicer CLI keys (e.g. scarf, overhang, tree, bridge)…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              autoFocus
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 420, overflowY: "auto" }}>
            {keys.map(([key, meta]) => {
              const rawCur = overrides[key] ?? baseProcess[key] ?? meta.native_default ?? "";
              const cur = Array.isArray(rawCur) ? rawCur.join(",") : String(rawCur);
              const isMod = overrides[key] !== undefined;
              return (
                <div key={key} className="field-row" style={{ padding: "3px 4px", borderBottom: "1px solid var(--border-subtle)" }}>
                  <span className={`mono ${isMod ? "field-label modified" : "field-label"}`} style={{ fontSize: 11.5 }}>
                    {key}
                  </span>
                  <div style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                    <input
                      className="input mono"
                      style={{ width: 170 }}
                      value={cur}
                      onChange={(e) => onSetOverride(key, e.target.value)}
                    />
                    {isMod && (
                      <button className="icon-btn icon-btn-sm" title="Reset" onClick={() => onSetOverride(key, undefined)}>
                        <RotateCcw size={11} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
