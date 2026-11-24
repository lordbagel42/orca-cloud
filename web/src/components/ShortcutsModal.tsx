import { X } from "lucide-react";

const SHORTCUTS: Array<[string, string]> = [
  ["M", "Move tool"],
  ["R", "Rotate tool"],
  ["S", "Scale tool"],
  ["F", "Lay on Face"],
  ["C", "Cut plane tool"],
  ["L", "Support painting"],
  ["P", "Seam painting"],
  ["N", "Color / multi-filament painting"],
  ["U", "Measure tool"],
  ["A", "Auto-arrange active plate"],
  ["Ctrl + K", "Clone selected object"],
  ["Delete / Backspace", "Delete selected object or modifier"],
  ["Ctrl + Z / Ctrl + Y", "Undo / Redo"],
  ["Ctrl + R", "Slice active plate"],
  ["↑ / ↓", "Step layers in Preview"],
  ["Esc", "Return to Select tool"],
];

export function ShortcutsModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-panel" style={{ maxWidth: 460 }} role="dialog" aria-modal="true" aria-label="Keyboard Shortcuts">
        <div className="modal-header">
          <span className="modal-title">Keyboard Shortcuts</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <div className="modal-body" style={{ gap: 6 }}>
          {SHORTCUTS.map(([keys, desc]) => (
            <div key={keys} className="field-row" style={{ borderBottom: "1px solid var(--border-subtle)", paddingBottom: 5 }}>
              <span style={{ color: "var(--text-secondary)", fontSize: 12.5 }}>{desc}</span>
              <span className="kbd">{keys}</span>
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
