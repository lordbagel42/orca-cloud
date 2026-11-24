import { useEffect } from "react";
import { X } from "lucide-react";

const SHORTCUT_GROUPS: Array<{ title: string; items: Array<[string, string]> }> = [
  {
    title: "Workspace & Camera",
    items: [
      ["Tab", "Toggle Prepare ↔ Preview (auto-slices if unsliced)"],
      ["0", "Isometric camera view"],
      ["1 / 2", "Top / Bottom view"],
      ["3 / 4", "Front / Back view"],
      ["5 / 6", "Left / Right view"],
      ["Shift + F", "Fit print / build plate"],
      ["Ctrl + R", "Slice active plate"],
      ["Ctrl + I", "Import STL / OBJ / 3MF"],
      ["Ctrl + G", "Export sliced G-code"],
      ["Ctrl + B", "Toggle settings sidebar"],
      ["?", "Open keyboard shortcuts"],
    ],
  },
  {
    title: "Prepare Tools",
    items: [
      ["M / R / S", "Move / Rotate / Scale gizmo"],
      ["F", "Lay on Face"],
      ["C", "Cut plane tool"],
      ["L / P / N", "Support / Seam / Color painting"],
      ["V", "Variable layer height"],
      ["T / U", "Emboss 3D text / Measure"],
      ["A / O", "Auto-arrange plate / Auto-orient"],
      ["W / H", "Toggle wireframe / Overhangs"],
      ["Ctrl + K", "Clone selected object"],
      ["Del / Shift+Del", "Delete selected / Clear plate"],
      ["Ctrl + Z / Y", "Undo / Redo"],
      ["Esc", "Return to Select / Close menu"],
    ],
  },
  {
    title: "Preview Playback",
    items: [
      ["Space", "Play / Pause toolpath simulation"],
      ["↑ / ↓", "Step ±1 layer (Shift: ±10)"],
      ["← / →", "Step ±10 moves (Shift: ±100)"],
      ["Home / End", "Jump to Layer 1 / Top layer"],
      ["T", "Toggle Travel moves"],
      ["G", "Toggle Ghost model"],
      ["X", "Toggle Section Cut plane"],
      ["H", "Toggle Nozzle head"],
    ],
  },
];

export function ShortcutsModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-panel" style={{ maxWidth: 520 }} role="dialog" aria-modal="true" aria-label="Keyboard Shortcuts">
        <div className="modal-header">
          <span className="modal-title">Keyboard Shortcuts</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <div className="modal-body" style={{ gap: 14, maxHeight: "68vh", overflowY: "auto" }}>
          {SHORTCUT_GROUPS.map((grp) => (
            <div key={grp.title} style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--accent-text)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                {grp.title}
              </div>
              {grp.items.map(([keys, desc]) => (
                <div key={keys} className="field-row" style={{ borderBottom: "1px solid var(--border-subtle)", paddingBottom: 4, minHeight: 24 }}>
                  <span style={{ color: "var(--text-secondary)", fontSize: 12 }}>{desc}</span>
                  <span className="kbd">{keys}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="modal-footer">
          <button className="btn btn-primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
