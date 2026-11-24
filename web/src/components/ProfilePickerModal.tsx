import { useEffect, useState } from "react";
import { Check, Search, X } from "lucide-react";
import type { ProfileRef, ProfileSummary, VendorSummary } from "../types";
import { getVendors, searchProfiles } from "../lib/api";

interface Props {
  kind: "machine" | "process" | "filament";
  current: ProfileRef;
  onSelect: (ref: ProfileRef) => void;
  onClose: () => void;
}

const QUICK_PRINTERS: ProfileRef[] = [
  { vendor: "BBL", name: "Bambu Lab A1 mini 0.4 nozzle" },
  { vendor: "BBL", name: "Bambu Lab A1 mini 0.6 nozzle" },
  { vendor: "BBL", name: "Bambu Lab A1 0.4 nozzle" },
  { vendor: "BBL", name: "Bambu Lab P1S 0.4 nozzle" },
  { vendor: "BBL", name: "Bambu Lab X1 Carbon 0.4 nozzle" },
  { vendor: "Prusa", name: "Prusa MK4S 0.4 nozzle" },
  { vendor: "Voron", name: "Voron 2.4 350 0.4 nozzle" },
  { vendor: "Creality", name: "Creality K1C 0.4 nozzle" },
];

export function ProfilePickerModal({ kind, current, onSelect, onClose }: Props) {
  const [vendors, setVendors] = useState<VendorSummary[]>([]);
  const [vendor, setVendor] = useState<string>(kind === "filament" ? "" : current.vendor);
  const [query, setQuery] = useState("");
  const [instantiableOnly, setInstantiableOnly] = useState(true);
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    getVendors()
      .then((res) => setVendors(res.vendors))
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const t = window.setTimeout(() => {
      searchProfiles({
        kind,
        vendor: vendor || undefined,
        q: query.trim() || undefined,
        instantiable: instantiableOnly,
        limit: 80,
      })
        .then((res) => {
          if (cancelled) return;
          setProfiles(res.profiles);
          setTotal(res.total);
        })
        .catch(() => {
          if (!cancelled) setProfiles([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [kind, vendor, query, instantiableOnly]);

  const title =
    kind === "machine" ? "Select Printer Profile" : kind === "process" ? "Select Process Preset" : "Select Filament Profile";

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-panel" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-header">
          <span className="modal-title">{title}</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="modal-body">
          {kind === "machine" && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
              {QUICK_PRINTERS.map((qp) => {
                const isCur = qp.vendor === current.vendor && qp.name === current.name;
                return (
                  <button
                    key={`${qp.vendor}/${qp.name}`}
                    className={`btn btn-sm ${isCur ? "btn-primary" : ""}`}
                    onClick={() => {
                      onSelect(qp);
                      onClose();
                    }}
                  >
                    {qp.name.replace(" 0.4 nozzle", " 0.4").replace(" 0.6 nozzle", " 0.6")}
                  </button>
                );
              })}
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: 8 }}>
            <select
              className="select"
              style={{ height: 32 }}
              value={vendor}
              onChange={(e) => setVendor(e.target.value)}
              aria-label="Filter by vendor"
            >
              <option value="">All Vendors ({vendors.length})</option>
              {vendors
                .filter((v) => v.counts[kind] > 0)
                .map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name} ({v.counts[kind]})
                  </option>
                ))}
            </select>

            <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
              <Search size={14} style={{ position: "absolute", left: 9, color: "var(--text-muted)", pointerEvents: "none" }} />
              <input
                className="input"
                style={{ width: "100%", height: 32, paddingLeft: 30 }}
                placeholder={`Search ${kind} profiles (e.g. A1, MK4, 0.20mm, PLA, PETG)…`}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoFocus
              />
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 11.5, color: "var(--text-muted)" }}>
            <span>
              {loading ? "Searching official OrcaSlicer 2.5.0 catalog…" : `${total.toLocaleString()} matching profiles`}
            </span>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={instantiableOnly}
                onChange={(e) => setInstantiableOnly(e.target.checked)}
              />
              <span>Ready-to-use presets only</span>
            </label>
          </div>

          <div
            style={{
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius-md)",
              background: "var(--bg-frame)",
              maxHeight: 380,
              overflowY: "auto",
            }}
          >
            {profiles.map((p) => {
              const selected = p.vendor === current.vendor && p.name === current.name;
              return (
                <button
                  key={`${p.vendor}/${p.kind}/${p.name}`}
                  className="menu-item"
                  style={{
                    height: 34,
                    padding: "0 10px",
                    borderBottom: "1px solid var(--border-subtle)",
                    borderRadius: 0,
                    background: selected ? "var(--accent-tint)" : undefined,
                  }}
                  onClick={() => {
                    onSelect({ vendor: p.vendor, name: p.name });
                    onClose();
                  }}
                >
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                    <span className="kbd" style={{ fontSize: 10 }}>{p.vendor}</span>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {p.name}
                    </span>
                  </span>
                  {selected && <Check size={14} color="var(--accent-text)" />}
                </button>
              );
            })}
            {!loading && profiles.length === 0 && (
              <div style={{ padding: 24, textAlign: "center", color: "var(--text-muted)" }}>
                No official profiles match that filter.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
