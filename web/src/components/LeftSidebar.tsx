import { useMemo, useState } from "react";
import {
  Box,
  ChevronDown,
  Code2,
  Eye,
  EyeOff,
  Minus,
  PaintBucket,
  Plus,
  Printer,
  RotateCcw,
  Search,
  Settings2,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import type { WorkspaceAPI } from "../store/useWorkspace";
import { BED_TYPES, type BedType, type SubPartType } from "../types";
import {
  FILAMENT_SWATCH_PALETTE,
  PROCESS_SETTINGS_SCHEMA,
  SETTING_TABS,
  type SettingDef,
} from "../lib/settingsSchema";
import { ProfilePickerModal } from "./ProfilePickerModal";
import {
  AllNativeSettingsModal,
  FilamentEditorModal,
  FlushMatrixModal,
  PrinterEditorModal,
} from "./ProfileEditorModal";

export function LeftSidebar({ ws }: { ws: WorkspaceAPI }) {
  const [picker, setPicker] = useState<
    | { kind: "machine" }
    | { kind: "process" }
    | { kind: "filament"; slotId: string }
    | null
  >(null);
  const [editingPrinter, setEditingPrinter] = useState(false);
  const [editingFilamentId, setEditingFilamentId] = useState<string | null>(null);
  const [flushOpen, setFlushOpen] = useState(false);
  const [allKeysOpen, setAllKeysOpen] = useState(false);
  const [swatchOpenId, setSwatchOpenId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [onlyModified, setOnlyModified] = useState(false);

  const activeOverrides = useMemo(() => {
    if (ws.processScope === "objects" && ws.selectedObject) {
      return ws.selectedSubPart ? ws.selectedSubPart.overrides : ws.selectedObject.overrides;
    }
    return ws.processOverrides;
  }, [ws.processScope, ws.selectedObject, ws.selectedSubPart, ws.processOverrides]);

  const getSettingDisplayValue = (def: SettingDef): string => {
    const ov = activeOverrides[def.key];
    const base =
      ws.processScope === "objects"
        ? ws.processOverrides[def.key] ?? ws.processSettings[def.key]
        : ws.processSettings[def.key];
    const raw = ov ?? base;
    if (Array.isArray(raw)) return raw[0] ?? "";
    if (typeof raw === "string") return raw;
    if (def.type === "boolean") return "0";
    return "";
  };

  const visibleSettings = useMemo(() => {
    const q = search.trim().toLowerCase();
    return PROCESS_SETTINGS_SCHEMA.filter((s) => {
      if (!q && s.tab !== ws.settingTab) return false;
      if (!ws.advancedMode && s.advanced && !q && activeOverrides[s.key] === undefined) return false;
      if (onlyModified && activeOverrides[s.key] === undefined) return false;
      if (q) {
        return (
          s.label.toLowerCase().includes(q) ||
          s.key.toLowerCase().includes(q) ||
          s.group.toLowerCase().includes(q)
        );
      }
      if (s.dependsOn) {
        const depDef = PROCESS_SETTINGS_SCHEMA.find((d) => d.key === s.dependsOn!.key);
        const depVal = depDef ? getSettingDisplayValue(depDef) : String(activeOverrides[s.dependsOn.key] ?? ws.processSettings[s.dependsOn.key] ?? "");
        if (!s.dependsOn.values.includes(depVal)) return false;
      }
      return true;
    });
  }, [search, ws.settingTab, ws.advancedMode, onlyModified, activeOverrides, ws.processSettings, ws.processOverrides, ws.processScope]);

  const grouped = useMemo(() => {
    const map = new Map<string, SettingDef[]>();
    for (const def of visibleSettings) {
      const list = map.get(def.group) || [];
      list.push(def);
      map.set(def.group, list);
    }
    return Array.from(map.entries());
  }, [visibleSettings]);

  const modifiedCount = Object.keys(activeOverrides).length;
  const editingSlotIndex = editingFilamentId
    ? ws.filaments.findIndex((f) => f.id === editingFilamentId)
    : -1;

  return (
    <aside className="left-sidebar" aria-label="Slicer settings">
      {/* PRINTER SECTION */}
      <div className="sidebar-section">
        <div className="section-header">
          <span className="section-title">
            <Printer size={13} /> Printer
          </span>
          <button
            className="icon-btn icon-btn-sm"
            title="Edit printer settings & machine G-code"
            aria-label="Edit printer settings"
            onClick={() => setEditingPrinter(true)}
          >
            <Settings2 size={13} />
          </button>
        </div>

        <button
          className="profile-trigger"
          onClick={() => setPicker({ kind: "machine" })}
          title={`${ws.printer.vendor}: ${ws.printer.name}`}
        >
          <span className="profile-trigger-label">{ws.printer.name}</span>
          <ChevronDown size={13} color="var(--text-muted)" />
        </button>

        <div className="field-row">
          <span className="field-label">Bed type</span>
          <select
            className="select"
            style={{ width: 176 }}
            value={ws.bedType}
            onChange={(e) => ws.setBedType(e.target.value as BedType)}
            aria-label="Build plate bed type"
          >
            {BED_TYPES.map((bt) => (
              <option key={bt} value={bt}>
                {bt}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* FILAMENT SECTION */}
      <div className="sidebar-section">
        <div className="section-header">
          <span className="section-title">
            <PaintBucket size={13} /> Filaments ({ws.filaments.length})
          </span>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
            {ws.filaments.length > 1 && (
              <button
                className="btn btn-sm"
                style={{ height: 22, padding: "0 6px", fontSize: 11 }}
                onClick={() => setFlushOpen(true)}
                title="Configure filament purge/flushing volumes"
              >
                Flush
              </button>
            )}
            <button
              className="icon-btn icon-btn-sm"
              title="Add filament slot (multi-material)"
              aria-label="Add filament slot"
              disabled={ws.filaments.length >= 8}
              onClick={ws.addFilamentSlot}
            >
              <Plus size={13} />
            </button>
          </div>
        </div>

        <div className="filament-list">
          {ws.filaments.map((slot, idx) => (
            <div key={slot.id} className="filament-row" style={{ position: "relative" }}>
              <span className="filament-index">{idx + 1}</span>
              <button
                className="swatch-btn"
                style={{ background: slot.color }}
                title="Change filament color"
                aria-label={`Change filament ${idx + 1} color`}
                onClick={() => setSwatchOpenId(swatchOpenId === slot.id ? null : slot.id)}
              />
              {swatchOpenId === slot.id && (
                <div
                  className="menu-popover"
                  style={{
                    position: "absolute",
                    top: 28,
                    left: 20,
                    width: 172,
                    padding: 8,
                    display: "grid",
                    gridTemplateColumns: "repeat(6, 1fr)",
                    gap: 5,
                  }}
                >
                  {FILAMENT_SWATCH_PALETTE.map((hex) => (
                    <button
                      key={hex}
                      className="swatch-btn"
                      style={{ background: hex, width: 20, height: 20 }}
                      onClick={() => {
                        ws.updateFilamentSlot(slot.id, { color: hex });
                        setSwatchOpenId(null);
                      }}
                    />
                  ))}
                </div>
              )}

              <button
                className="profile-trigger"
                style={{ height: 26, flex: 1, minWidth: 0 }}
                onClick={() => setPicker({ kind: "filament", slotId: slot.id })}
                title={`${slot.profile.vendor}: ${slot.profile.name}`}
              >
                <span className="profile-trigger-label">{slot.profile.name}</span>
                <ChevronDown size={12} color="var(--text-muted)" />
              </button>

              <button
                className="icon-btn icon-btn-sm"
                title="Edit filament temperatures, flow & cooling"
                aria-label={`Edit filament ${idx + 1}`}
                onClick={() => setEditingFilamentId(slot.id)}
              >
                <Settings2 size={12} />
              </button>

              {ws.filaments.length > 1 && (
                <button
                  className="icon-btn icon-btn-sm"
                  title="Remove filament slot"
                  aria-label={`Remove filament ${idx + 1}`}
                  onClick={() => ws.removeFilamentSlot(slot.id)}
                >
                  <Minus size={12} />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* PROCESS SECTION: GLOBAL / OBJECTS + 6 TABS */}
      <div className="sidebar-section" style={{ paddingBottom: 8 }}>
        <div className="section-header">
          <span className="section-title">
            <SlidersHorizontal size={13} /> Process
          </span>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <label
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                fontSize: 11,
                color: "var(--text-secondary)",
                cursor: "pointer",
              }}
            >
              <span>Advanced</span>
              <button
                role="switch"
                aria-checked={ws.advancedMode}
                className="toggle-btn"
                onClick={() => ws.setAdvancedMode((v) => !v)}
              >
                <span className="toggle-thumb" />
              </button>
            </label>
            <button
              className="icon-btn icon-btn-sm"
              title="Browse all 750+ native OrcaSlicer keys"
              aria-label="All native settings"
              onClick={() => setAllKeysOpen(true)}
            >
              <Code2 size={13} />
            </button>
          </div>
        </div>

        <button
          className="profile-trigger"
          onClick={() => setPicker({ kind: "process" })}
          title={`${ws.process.vendor}: ${ws.process.name}`}
        >
          <span className="profile-trigger-label">{ws.process.name}</span>
          <ChevronDown size={13} color="var(--text-muted)" />
        </button>

        {/* Global | Objects Toggle */}
        <div className="segmented" role="tablist" aria-label="Settings scope">
          <button
            role="tab"
            aria-selected={ws.processScope === "global"}
            className={`segmented-btn ${ws.processScope === "global" ? "active" : ""}`}
            onClick={() => ws.setProcessScope("global")}
          >
            Global
          </button>
          <button
            role="tab"
            aria-selected={ws.processScope === "objects"}
            className={`segmented-btn ${ws.processScope === "objects" ? "active" : ""}`}
            onClick={() => ws.setProcessScope("objects")}
          >
            Objects ({ws.activePlate.objects.length})
          </button>
        </div>

        {/* Objects Tree when Objects scope is active */}
        {ws.processScope === "objects" && (
          <div className="object-tree" aria-label="Plate objects">
            {ws.activePlate.objects.length === 0 ? (
              <div style={{ padding: 10, textAlign: "center", fontSize: 11.5, color: "var(--text-muted)" }}>
                No models on {ws.activePlate.name}
              </div>
            ) : (
              ws.activePlate.objects.map((obj) => {
                const isSelected = obj.id === ws.selectedObjectId && !ws.selectedSubPartId;
                const fil = ws.filaments[obj.filamentIndex] || ws.filaments[0];
                return (
                  <div key={obj.id}>
                    <div
                      className={`tree-row ${isSelected ? "selected" : ""}`}
                      onClick={() => {
                        ws.setSelectedObjectId(obj.id);
                        ws.setSelectedSubPartId(null);
                      }}
                    >
                      <Box size={12} />
                      <span
                        className="swatch-btn"
                        style={{ width: 10, height: 10, background: fil?.color || "#22c55e" }}
                      />
                      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {obj.name}
                      </span>
                      {ws.filaments.length > 1 && (
                        <select
                          className="select mono"
                          style={{ height: 20, width: 42, padding: "0 2px", fontSize: 10.5 }}
                          value={obj.filamentIndex}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) =>
                            ws.updateObject(obj.id, { filamentIndex: Number(e.target.value) })
                          }
                          title="Assign filament slot"
                        >
                          {ws.filaments.map((_, idx) => (
                            <option key={idx} value={idx}>
                              #{idx + 1}
                            </option>
                          ))}
                        </select>
                      )}
                      <button
                        className="icon-btn icon-btn-sm"
                        title={obj.visible ? "Hide object" : "Show object"}
                        onClick={(e) => {
                          e.stopPropagation();
                          ws.updateObject(obj.id, { visible: !obj.visible });
                        }}
                      >
                        {obj.visible ? <Eye size={11} /> : <EyeOff size={11} />}
                      </button>
                    </div>

                    {obj.subParts.map((sp) => (
                      <div
                        key={sp.id}
                        className={`tree-row tree-subrow ${
                          obj.id === ws.selectedObjectId && sp.id === ws.selectedSubPartId ? "selected" : ""
                        }`}
                        onClick={() => {
                          ws.setSelectedObjectId(obj.id);
                          ws.setSelectedSubPartId(sp.id);
                        }}
                      >
                        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          ↳ {sp.name}
                        </span>
                        <button
                          className="icon-btn icon-btn-sm"
                          title="Delete part"
                          onClick={(e) => {
                            e.stopPropagation();
                            ws.updateObject(obj.id, {
                              subParts: obj.subParts.filter((s) => s.id !== sp.id),
                            });
                            if (ws.selectedSubPartId === sp.id) ws.setSelectedSubPartId(null);
                          }}
                        >
                          <Trash2 size={11} />
                        </button>
                      </div>
                    ))}
                  </div>
                );
              })
            )}
            {ws.selectedObject && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, padding: "4px 2px 2px", borderTop: "1px solid var(--border-subtle)" }}>
                {(
                  [
                    ["modifier_part", "+ Modifier"],
                    ["negative_part", "+ Negative"],
                    ["support_enforcer", "+ Sup Enforcer"],
                    ["support_blocker", "+ Sup Blocker"],
                  ] as Array<[SubPartType, string]>
                ).map(([st, label]) => (
                  <button
                    key={st}
                    className="btn btn-sm"
                    style={{ height: 22, padding: "0 6px", fontSize: 10.5 }}
                    onClick={() => ws.addSubPartToSelected(st, "cube")}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Search + Modified filter */}
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div style={{ position: "relative", flex: 1, display: "flex", alignItems: "center" }}>
            <Search size={12} style={{ position: "absolute", left: 7, color: "var(--text-muted)", pointerEvents: "none" }} />
            <input
              className="input"
              style={{ width: "100%", paddingLeft: 24 }}
              aria-label="Search settings"
              placeholder="Search settings…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {modifiedCount > 0 && (
            <button
              className={`btn btn-sm ${onlyModified ? "btn-primary" : ""}`}
              style={{ height: 26, fontSize: 11 }}
              onClick={() => setOnlyModified((v) => !v)}
              title="Filter to modified overrides only"
            >
              Mod ({modifiedCount})
            </button>
          )}
        </div>

        {/* 6 OrcaSlicer Process Setting Tabs */}
        {!search.trim() && (
          <div className="setting-tabs" role="tablist" aria-label="Process setting category">
            {SETTING_TABS.map((st) => (
              <button
                key={st.id}
                role="tab"
                aria-selected={ws.settingTab === st.id}
                className={`setting-tab ${ws.settingTab === st.id ? "active" : ""}`}
                onClick={() => ws.setSettingTab(st.id)}
              >
                {st.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* SCROLLABLE SETTINGS BODY */}
      <div className="settings-scroll">
        {ws.processScope === "objects" && !ws.selectedObject ? (
          <div style={{ padding: 16, textAlign: "center", color: "var(--text-muted)", fontSize: 12 }}>
            Select an object or modifier above to edit per-object overrides.
          </div>
        ) : (
          grouped.map(([groupName, defs]) => (
            <div key={groupName} className="setting-group">
              <div className="setting-group-title">{groupName}</div>
              {defs.map((def) => {
                const isModified = activeOverrides[def.key] !== undefined;
                const val = getSettingDisplayValue(def);
                return (
                  <div key={def.key} className="field-row" title={def.description}>
                    <span className={`field-label ${isModified ? "modified" : ""}`}>
                      <span className="field-label-text">{def.label}</span>
                      {isModified && (
                        <button
                          className="icon-btn icon-btn-sm"
                          style={{ width: 18, height: 18 }}
                          title="Reset override to preset value"
                          aria-label={`Reset ${def.label}`}
                          onClick={() => ws.setSettingValue(def.key, undefined)}
                        >
                          <RotateCcw size={10} />
                        </button>
                      )}
                    </span>

                    {def.type === "boolean" && (
                      <button
                        role="switch"
                        aria-label={def.label}
                        aria-checked={val === "1" || val === "true"}
                        className="toggle-btn"
                        onClick={() => ws.setSettingValue(def.key, val === "1" || val === "true" ? "0" : "1")}
                      >
                        <span className="toggle-thumb" />
                      </button>
                    )}

                    {def.type === "select" && (
                      <select
                        className="select"
                        style={{ width: 138 }}
                        aria-label={def.label}
                        value={val}
                        onChange={(e) => ws.setSettingValue(def.key, e.target.value)}
                      >
                        {!def.options?.some((o) => o.value === val) && val && (
                          <option value={val}>{val}</option>
                        )}
                        {def.options?.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    )}

                    {(def.type === "number" || def.type === "percent") && (
                      <div className="input-num-wrap">
                        <input
                          type="number"
                          aria-label={def.label}
                          step={def.step ?? 1}
                          min={def.min}
                          max={def.max}
                          value={def.type === "percent" ? val.replace(/%$/, "") : val}
                          onChange={(e) => {
                            const raw = e.target.value;
                            ws.setSettingValue(def.key, def.type === "percent" ? `${raw}%` : raw);
                          }}
                        />
                        {def.unit && <span className="input-unit">{def.unit}</span>}
                      </div>
                    )}

                    {def.type === "text" && (
                      <input
                        className="input"
                        style={{ width: 138 }}
                        aria-label={def.label}
                        value={val}
                        onChange={(e) => ws.setSettingValue(def.key, e.target.value)}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>

      {/* MODALS */}
      {picker && (
        <ProfilePickerModal
          kind={picker.kind}
          current={
            picker.kind === "machine"
              ? ws.printer
              : picker.kind === "process"
              ? ws.process
              : ws.filaments.find((f) => f.id === picker.slotId)?.profile || ws.filaments[0].profile
          }
          onSelect={(ref) => {
            if (picker.kind === "machine") {
              ws.setPrinter(ref);
              ws.setPrinterOverrides({});
            } else if (picker.kind === "process") {
              ws.setProcess(ref);
              ws.setProcessOverrides({});
            } else {
              ws.updateFilamentSlot(picker.slotId, { profile: ref, overrides: {} });
            }
          }}
          onClose={() => setPicker(null)}
        />
      )}

      {editingPrinter && (
        <PrinterEditorModal
          printerName={ws.printer.name}
          baseSettings={ws.printerSettings}
          overrides={ws.printerOverrides}
          onSave={(next) => ws.setPrinterOverrides(next)}
          onClose={() => setEditingPrinter(false)}
        />
      )}

      {editingFilamentId && editingSlotIndex >= 0 && (
        <FilamentEditorModal
          slot={ws.filaments[editingSlotIndex]}
          slotIndex={editingSlotIndex}
          onSave={(ov) => ws.updateFilamentSlot(editingFilamentId, { overrides: ov })}
          onClose={() => setEditingFilamentId(null)}
        />
      )}

      {flushOpen && (
        <FlushMatrixModal
          filaments={ws.filaments}
          matrix={ws.flushMatrix}
          onSave={(m) => ws.setFlushMatrix(m)}
          onClose={() => setFlushOpen(false)}
        />
      )}

      {allKeysOpen && (
        <AllNativeSettingsModal
          baseProcess={ws.processSettings}
          overrides={activeOverrides}
          onSetOverride={(k, v) => ws.setSettingValue(k, v)}
          onClose={() => setAllKeysOpen(false)}
        />
      )}
    </aside>
  );
}
