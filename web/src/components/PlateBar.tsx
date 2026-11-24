import { Copy, Layers, Plus, Trash2 } from "lucide-react";
import type { WorkspaceAPI } from "../store/useWorkspace";

export function PlateBar({ ws }: { ws: WorkspaceAPI }) {
  const [bw, bd, bh] = ws.buildVolume;
  const totalTris = ws.activePlate.objects.reduce((s, o) => s + o.geometry.triangleCount, 0);
  const visibleObjs = ws.activePlate.objects.filter((o) => o.visible);
  const syncingCount = visibleObjs.filter((o) => o.meshSyncState === "syncing").length;
  const syncedCount = visibleObjs.filter((o) => o.meshSyncState === "synced").length;
  const allSynced = visibleObjs.length > 0 && syncedCount === visibleObjs.length;

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
        {ws.health?.capabilities?.staged_meshes && visibleObjs.length > 0 && (
          <span
            className={`mesh-sync-badge ${syncingCount > 0 ? "syncing" : allSynced ? "synced" : ""}`}
            title={
              syncingCount > 0
                ? "Pre-uploading meshes to native OrcaSlicer in the background"
                : allSynced
                ? "All models pre-staged in native OrcaSlicer (zero upload wait on Slice)"
                : "Models stored locally"
            }
          >
            <span className="mesh-sync-dot" />
            {syncingCount > 0 ? "Syncing…" : allSynced ? "Pre-staged" : "Local"}
          </span>
        )}
        <span className="mono plate-meta-bed">
          Bed: {bw}×{bd}×{bh} mm
        </span>
        <span className="mono plate-meta-tris">{ws.activePlate.objects.length} obj · {totalTris.toLocaleString()} tris</span>
        {ws.selectedObject && (
          <span className="plate-meta-selected" style={{ color: "var(--text-secondary)" }}>
            Selected: <strong>{ws.selectedObject.name}</strong>
          </span>
        )}
      </div>
    </footer>
  );
}
