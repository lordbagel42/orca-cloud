import { Copy, Layers, Plus, Trash2 } from "lucide-react";
import type { WorkspaceAPI } from "../store/useWorkspace";

export function PlateBar({ ws }: { ws: WorkspaceAPI }) {
  const [bw, bd, bh] = ws.buildVolume;
  const totalTris = ws.activePlate.objects.reduce((s, o) => s + o.geometry.triangleCount, 0);

  return (
    <footer className="plate-bar">
      <div className="plate-tabs">
        {ws.plates.map((p) => {
          const active = p.id === ws.activePlateId;
          return (
            <div key={p.id} style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
              <button
                className={`plate-pill ${active ? "active" : ""}`}
                onClick={() => {
                  ws.setActivePlateId(p.id);
                  ws.setSelectedObjectId(p.objects[0]?.id ?? null);
                  ws.setSelectedSubPartId(null);
                }}
              >
                <Layers size={11} />
                <span>{p.name}</span>
                <span className="mono" style={{ fontSize: 10.5, color: "var(--text-muted)" }}>
                  {p.objects.length}
                </span>
              </button>
              {active && ws.plates.length > 1 && (
                <button
                  className="icon-btn icon-btn-sm"
                  title={`Delete ${p.name}`}
                  aria-label={`Delete ${p.name}`}
                  onClick={() => ws.deletePlate(p.id)}
                >
                  <Trash2 size={11} />
                </button>
              )}
            </div>
          );
        })}

        <button className="icon-btn icon-btn-sm" title="Add new plate" aria-label="Add new plate" onClick={ws.addPlate}>
          <Plus size={13} />
        </button>
        <button
          className="icon-btn icon-btn-sm"
          title="Duplicate active plate"
          aria-label="Duplicate active plate"
          onClick={ws.duplicateActivePlate}
        >
          <Copy size={12} />
        </button>
      </div>

      <div className="plate-bar-meta">
        <span className="mono">
          Bed: {bw}×{bd}×{bh} mm
        </span>
        <span className="mono">{ws.activePlate.objects.length} objects · {totalTris.toLocaleString()} tris</span>
        {ws.selectedObject && (
          <span style={{ color: "var(--text-secondary)" }}>
            Selected: <strong>{ws.selectedObject.name}</strong>
          </span>
        )}
      </div>
    </footer>
  );
}
