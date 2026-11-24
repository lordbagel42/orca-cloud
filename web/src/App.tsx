import { useRef, useState } from "react";
import { Box, FolderOpen } from "lucide-react";
import { useWorkspace } from "./store/useWorkspace";
import { TopBar } from "./components/TopBar";
import { LeftSidebar } from "./components/LeftSidebar";
import { PrepareToolbar } from "./components/PrepareToolbar";
import { Viewport3D } from "./components/Viewport3D";
import { ToolInspector } from "./components/ToolInspector";
import { PreviewOverlay } from "./components/PreviewOverlay";
import { CalibrationView } from "./components/CalibrationView";
import { PlateBar } from "./components/PlateBar";
import { ShortcutsModal } from "./components/ShortcutsModal";

export function App() {
  const ws = useWorkspace();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const triggerFileImport = () => fileInputRef.current?.click();

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
        onOpenShortcuts={() => setShortcutsOpen(true)}
        onTriggerFileImport={triggerFileImport}
      />

      <main className="workspace-body">
        {ws.sidebarOpen && ws.tab !== "calibration" && <LeftSidebar ws={ws} />}

        {ws.tab === "calibration" ? (
          <CalibrationView ws={ws} />
        ) : (
          <div className="stage-wrap">
            {ws.tab === "prepare" && (
              <PrepareToolbar ws={ws} onTriggerFileImport={triggerFileImport} />
            )}

            <Viewport3D ws={ws} />

            {ws.tab === "prepare" && <ToolInspector ws={ws} />}

            {ws.tab === "prepare" && ws.activePlate.objects.length === 0 && (
              <div className="empty-stage-hint">
                <span>Drop an STL, OBJ, or 3MF onto the build plate, or start right away:</span>
                <button className="btn btn-sm btn-primary" onClick={triggerFileImport}>
                  <FolderOpen size={12} /> Import Model
                </button>
                <button className="btn btn-sm" onClick={() => ws.addPrimitive("benchy_test")}>
                  <Box size={12} /> Load Test Boat
                </button>
              </div>
            )}

            {ws.tab === "preview" && <PreviewOverlay ws={ws} />}

            <PlateBar ws={ws} />
          </div>
        )}
      </main>

      {shortcutsOpen && <ShortcutsModal onClose={() => setShortcutsOpen(false)} />}

      {ws.toast && (
        <div className={`toast ${ws.toast.kind}`} role="status" aria-live="polite">
          {ws.toast.message}
        </div>
      )}
    </div>
  );
}
