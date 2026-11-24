import { useEffect, useRef, useState } from "react";
import { Box, FolderOpen } from "lucide-react";
import { useWorkspace } from "./store/useWorkspace";
import { useBambuCloud } from "./store/useBambuCloud";
import { TopBar } from "./components/TopBar";
import { LeftSidebar } from "./components/LeftSidebar";
import { PrepareToolbar } from "./components/PrepareToolbar";
import { Viewport3D } from "./components/Viewport3D";
import { ToolInspector } from "./components/ToolInspector";
import { PreviewOverlay } from "./components/PreviewOverlay";
import { CalibrationView } from "./components/CalibrationView";
import { PlateBar } from "./components/PlateBar";
import { ShortcutsModal } from "./components/ShortcutsModal";
import { BambuCloudModal } from "./components/BambuCloudModal";
import { PrintPlateModal } from "./components/PrintPlateModal";

export function App() {
  const ws = useWorkspace();
  const bambu = useBambuCloud();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [bambuOpen, setBambuOpen] = useState(false);
  const [printOpen, setPrintOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const triggerFileImport = () => fileInputRef.current?.click();

  useEffect(() => {
    const onImport = () => fileInputRef.current?.click();
    const onShortcuts = () => setShortcutsOpen((v) => !v);
    window.addEventListener("orca-trigger-import", onImport);
    window.addEventListener("orca-open-shortcuts", onShortcuts);
    return () => {
      window.removeEventListener("orca-trigger-import", onImport);
      window.removeEventListener("orca-open-shortcuts", onShortcuts);
    };
  }, []);

  return (
    <div className="app-shell">
      <input
        ref={fileInputRef}
        type="file"
        accept=".stl,.obj,.3mf"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          if (e.target.files?.length) {
            ws.importFiles(e.target.files);
            e.target.value = "";
          }
        }}
      />

      <TopBar
        ws={ws}
        bambu={bambu}
        onOpenShortcuts={() => setShortcutsOpen(true)}
        onOpenBambuCloud={() => setBambuOpen(true)}
        onOpenPrintPlate={() => setPrintOpen(true)}
        onTriggerFileImport={triggerFileImport}
      />

      <main className="workspace-body">
        {ws.sidebarOpen && ws.tab !== "calibration" && (
          <>
            <div
              className="mobile-backdrop"
              aria-hidden="true"
              onClick={() => ws.setSidebarOpen(false)}
            />
            <LeftSidebar ws={ws} bambu={bambu} onOpenBambuCloud={() => setBambuOpen(true)} />
          </>
        )}

        {ws.tab === "calibration" ? (
          <CalibrationView ws={ws} />
        ) : (
          <div className="stage-wrap">
            {ws.tab === "prepare" && (
              <PrepareToolbar ws={ws} onTriggerFileImport={triggerFileImport} />
            )}

            <Viewport3D ws={ws} onTriggerFileImport={triggerFileImport} />

            {ws.tab === "prepare" && <ToolInspector ws={ws} />}

            {ws.tab === "prepare" && ws.activePlate.objects.length === 0 && (
              <div className="empty-stage-hint">
                <span className="empty-stage-label">Drop STL, OBJ, or 3MF</span>
                <button className="btn btn-sm btn-primary" onClick={triggerFileImport}>
                  <FolderOpen size={12} /> Import Model
                </button>
                <button className="btn btn-sm" onClick={() => ws.addPrimitive("benchy_test")}>
                  <Box size={12} /> Load Test Boat
                </button>
              </div>
            )}

            {ws.tab === "preview" && <PreviewOverlay ws={ws} />}

            {ws.toast && (
              <div
                className={`toast ${ws.toast.kind} ${ws.tab === "preview" ? "toast-preview" : ""}`}
                role="status"
                aria-live="polite"
              >
                {ws.toast.message}
              </div>
            )}

            <PlateBar ws={ws} />
          </div>
        )}
      </main>

      {shortcutsOpen && <ShortcutsModal onClose={() => setShortcutsOpen(false)} />}

      <BambuCloudModal open={bambuOpen} onClose={() => setBambuOpen(false)} bambu={bambu} ws={ws} />
      <PrintPlateModal
        open={printOpen}
        onClose={() => setPrintOpen(false)}
        onOpenConnect={() => setBambuOpen(true)}
        bambu={bambu}
        ws={ws}
      />

      {ws.tab === "calibration" && ws.toast && (
        <div className={`toast toast-fixed ${ws.toast.kind}`} role="status" aria-live="polite">
          {ws.toast.message}
        </div>
      )}
    </div>
  );
}
