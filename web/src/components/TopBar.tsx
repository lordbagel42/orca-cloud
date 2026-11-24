import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  Download,
  FilePlus,
  FolderOpen,
  Gauge,
  HelpCircle,
  Layers,
  Loader2,
  Menu,
  PanelLeft,
  Play,
  Save,
  Server,
  SlidersHorizontal,
} from "lucide-react";
import type { WorkspaceAPI } from "../store/useWorkspace";

interface Props {
  ws: WorkspaceAPI;
  onOpenShortcuts: () => void;
  onTriggerFileImport: () => void;
}

export function TopBar({ ws, onOpenShortcuts, onTriggerFileImport }: Props) {
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [serverPopOpen, setServerPopOpen] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [urlDraft, setUrlDraft] = useState(ws.backendUrl);
  const [tokenDraft, setTokenDraft] = useState(ws.bearerToken);

  const fileRef = useRef<HTMLDivElement>(null);
  const serverRef = useRef<HTMLDivElement>(null);
  const exportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: PointerEvent) => {
      if (fileRef.current && !fileRef.current.contains(e.target as Node)) setFileMenuOpen(false);
      if (serverRef.current && !serverRef.current.contains(e.target as Node)) setServerPopOpen(false);
      if (exportRef.current && !exportRef.current.contains(e.target as Node)) setExportMenuOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, []);

  return (
    <header className="topbar">
      <div className="topbar-left">
        <button
          className="icon-btn"
          title={ws.sidebarOpen ? "Hide sidebar" : "Show sidebar"}
          aria-label={ws.sidebarOpen ? "Hide sidebar" : "Show sidebar"}
          onClick={() => ws.setSidebarOpen((v) => !v)}
        >
          <PanelLeft size={16} />
        </button>

        <div className="brand-mark">
          <span className="brand-logo" aria-hidden="true">
            <Layers size={14} strokeWidth={2.4} />
          </span>
          <span>Orca Cloud</span>
        </div>

        <div ref={fileRef} style={{ position: "relative" }}>
          <button
            className="btn btn-ghost"
            onClick={() => setFileMenuOpen((v) => !v)}
            aria-expanded={fileMenuOpen}
            aria-label="File menu"
          >
            <Menu size={14} />
            <span className="topbar-file-label">File</span>
            <ChevronDown size={12} className="topbar-file-label" />
          </button>
          {fileMenuOpen && (
            <div className="menu-popover" style={{ top: 42, left: 10, width: 236 }}>
              <button
                className="menu-item"
                onClick={() => {
                  ws.newProject();
                  setFileMenuOpen(false);
                }}
              >
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  <FilePlus size={14} /> New Project
                </span>
              </button>
              <button
                className="menu-item"
                onClick={() => {
                  onTriggerFileImport();
                  setFileMenuOpen(false);
                }}
              >
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  <FolderOpen size={14} /> Import STL / OBJ / 3MF…
                </span>
              </button>
              <div className="menu-sep" />
              <button
                className="menu-item"
                onClick={() => {
                  ws.exportProject3MFFile();
                  setFileMenuOpen(false);
                }}
              >
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  <Save size={14} /> Save Project (.3mf)
                </span>
              </button>
              <button
                className="menu-item"
                onClick={() => {
                  ws.exportPlateSTLFile();
                  setFileMenuOpen(false);
                }}
              >
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  <Download size={14} /> Export Plate as STL
                </span>
              </button>
              {ws.parsedGcode && (
                <>
                  <div className="menu-sep" />
                  <button
                    className="menu-item"
                    onClick={() => {
                      ws.exportSlicedGcodeFile();
                      setFileMenuOpen(false);
                    }}
                  >
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                      <Download size={14} /> Export G-code (.gcode)
                    </span>
                  </button>
                  <button
                    className="menu-item"
                    onClick={() => {
                      ws.exportSliced3MFFile();
                      setFileMenuOpen(false);
                    }}
                  >
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                      <Download size={14} /> Export Sliced 3MF (.gcode.3mf)
                    </span>
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Center OrcaSlicer Workspace Tabs — Prepare, Preview, Calibration (NO Device tab) */}
      <nav className="workspace-tabs" aria-label="Workspace mode">
        <button
          className={`workspace-tab ${ws.tab === "prepare" ? "active" : ""}`}
          onClick={() => ws.setTab("prepare")}
        >
          <SlidersHorizontal size={13} />
          <span>Prepare</span>
        </button>
        <button
          className={`workspace-tab ${ws.tab === "preview" ? "active" : ""}`}
          onClick={() => ws.setTab("preview")}
        >
          <Layers size={13} />
          <span>Preview</span>
          {ws.parsedGcode && <span className={`tab-dot ${ws.sliceStale ? "stale" : ""}`} title={ws.sliceStale ? "Model or settings changed since last slice" : "Up to date"} />}
        </button>
        <button
          className={`workspace-tab ${ws.tab === "calibration" ? "active" : ""}`}
          onClick={() => ws.setTab("calibration")}
        >
          <Gauge size={13} />
          <span>Calibration</span>
        </button>
      </nav>

      {/* Right Action Cluster: Engine Status + Slice CTA + Export */}
      <div className="topbar-right">
        <div ref={serverRef} style={{ position: "relative" }}>
          <button
            className="status-pill"
            onClick={() => {
              setUrlDraft(ws.backendUrl);
              setTokenDraft(ws.bearerToken);
              setServerPopOpen((v) => !v);
            }}
            title="Slicing engine status & endpoint"
          >
            <span className={`status-dot ${ws.backendOnline ? "" : "offline"}`} />
            <span className="mono">
              {ws.backendOnline ? `Orca ${ws.health?.version || "2.5.0"}` : "Engine Offline"}
            </span>
          </button>

          {serverPopOpen && (
            <div className="menu-popover" style={{ top: 42, right: 120, width: 310, padding: 12, gap: 10 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ fontWeight: 600, fontSize: 12.5, display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <Server size={14} /> Native Engine Endpoint
                </span>
                <span className="mono" style={{ fontSize: 11, color: ws.backendOnline ? "var(--accent-text)" : "var(--danger)" }}>
                  {ws.backendOnline ? "Connected" : "Unreachable"}
                </span>
              </div>
              {ws.health?.capabilities && (
                <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  {ws.health.capabilities.profiles_count?.toLocaleString()} official profiles · {ws.health.capabilities.vendors_count} vendors · {ws.health.auth_required ? "Bearer key required" : "No account required"}
                </div>
              )}
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>API Base URL</span>
                <input
                  className="input mono"
                  value={urlDraft}
                  onChange={(e) => setUrlDraft(e.target.value)}
                  placeholder="/api"
                />
              </label>
              {ws.health?.auth_required && (
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>Optional Bearer Token (in-memory only)</span>
                  <input
                    className="input mono"
                    type="password"
                    value={tokenDraft}
                    onChange={(e) => setTokenDraft(e.target.value)}
                    placeholder="Optional service key"
                  />
                </label>
              )}
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
                <button className="btn btn-sm" onClick={() => setServerPopOpen(false)}>
                  Cancel
                </button>
                <button
                  className="btn btn-sm btn-primary"
                  onClick={() => {
                    ws.updateBackendConnection(urlDraft, tokenDraft);
                    setServerPopOpen(false);
                  }}
                >
                  Apply
                </button>
              </div>
            </div>
          )}
        </div>

        <button
          className="icon-btn topbar-help-btn"
          title="Keyboard shortcuts (?)"
          aria-label="Keyboard shortcuts"
          onClick={onOpenShortcuts}
        >
          <HelpCircle size={15} />
        </button>

        {ws.parsedGcode && (
          <div ref={exportRef} className="topbar-export-btn" style={{ position: "relative" }}>
            <button
              className="btn"
              onClick={() => setExportMenuOpen((v) => !v)}
              title="Export sliced files"
            >
              <Download size={14} />
              <span>Export</span>
              <ChevronDown size={12} />
            </button>
            {exportMenuOpen && (
              <div className="menu-popover" style={{ top: 42, right: 112, width: 220 }}>
                <button
                  className="menu-item"
                  onClick={() => {
                    ws.exportSlicedGcodeFile();
                    setExportMenuOpen(false);
                  }}
                >
                  Export G-code (.gcode)
                </button>
                <button
                  className="menu-item"
                  onClick={() => {
                    ws.exportSliced3MFFile();
                    setExportMenuOpen(false);
                  }}
                >
                  Export Sliced 3MF (.gcode.3mf)
                </button>
                <div className="menu-sep" />
                <button
                  className="menu-item"
                  onClick={() => {
                    ws.exportProject3MFFile();
                    setExportMenuOpen(false);
                  }}
                >
                  Save Project (.3mf)
                </button>
              </div>
            )}
          </div>
        )}

        <button
          className="btn btn-primary topbar-slice-btn"
          style={{ height: 32, padding: "0 14px" }}
          disabled={ws.slicing || !ws.activePlate.objects.some((o) => o.visible)}
          onClick={ws.sliceActivePlate}
          title="Slice active plate with native OrcaSlicer 2.5.0 (Ctrl+R)"
        >
          {ws.slicing ? (
            <>
              <Loader2 size={14} className="spin" />
              <span>{ws.sliceStatusText || "Slicing…"}</span>
            </>
          ) : (
            <>
              <Play size={13} fill="currentColor" />
              <span>Slice<span className="topbar-slice-suffix"> Plate</span></span>
            </>
          )}
        </button>
      </div>
    </header>
  );
}
