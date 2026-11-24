import { useEffect, useMemo, useState } from "react";
import { Cloud, Download, Loader2, Printer, RefreshCw, Send, X } from "lucide-react";
import type { BambuCloudAPI } from "../store/useBambuCloud";
import type { WorkspaceAPI } from "../store/useWorkspace";
import { sendSlicedPlateToBambuPrinter } from "../lib/bambuApi";

interface Props {
  open: boolean;
  onClose: () => void;
  onOpenConnect: () => void;
  bambu: BambuCloudAPI;
  ws: WorkspaceAPI;
}

export function PrintPlateModal({ open, onClose, onOpenConnect, bambu, ws }: Props) {
  const [targetSerial, setTargetSerial] = useState<string>(bambu.selectedPrinter?.serial || "");
  const [useAms, setUseAms] = useState(true);
  const [bedLeveling, setBedLeveling] = useState(true);
  const [flowCali, setFlowCali] = useState(true);
  const [vibrationCali, setVibrationCali] = useState(false);
  const [timelapse, setTimelapse] = useState(false);
  const [layerInspect, setLayerInspect] = useState(false);
  const [amsMapping, setAmsMapping] = useState<number[]>([]);
  const [sending, setSending] = useState(false);
  const [progressMsg, setProgressMsg] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSendError(null);
    setProgressMsg(null);
    const defaultSn = bambu.selectedPrinter?.serial || bambu.state.printers[0]?.serial || "";
    setTargetSerial(defaultSn);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !sending) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, bambu.selectedPrinter?.serial, bambu.state.printers, sending, onClose]);

  const targetPrinter = useMemo(
    () => bambu.state.printers.find((p) => p.serial === targetSerial) || bambu.selectedPrinter,
    [bambu.state.printers, bambu.selectedPrinter, targetSerial]
  );

  const liveState = targetPrinter ? bambu.state.printerStates[targetPrinter.serial] : null;
  const loadedTrays = useMemo(
    () => (liveState?.amsTrays || []).filter((t) => !t.empty),
    [liveState]
  );

  useEffect(() => {
    const hasAmsTrays = loadedTrays.some((t) => !t.isExternal);
    setUseAms(hasAmsTrays || ws.filaments.length > 1);
    setAmsMapping(
      ws.filaments.map((_, idx) => {
        const amsTray = loadedTrays.find((t) => !t.isExternal && t.globalSlot === idx);
        if (amsTray) return amsTray.globalSlot;
        return loadedTrays[idx]?.globalSlot ?? idx;
      })
    );
  }, [ws.filaments, loadedTrays]);

  if (!open) return null;

  const canSend = Boolean(
    bambu.isConnected &&
      targetPrinter &&
      ws.currentJob?.status === "succeeded" &&
      !sending
  );

  const handleSend = async () => {
    if (!targetPrinter) return;
    setSending(true);
    setSendError(null);
    setProgressMsg("Downloading sliced .gcode.3mf…");
    try {
      const bytes = await ws.getSliced3MFBytes();
      const plateSlug = (ws.activePlate.name || "plate_1").replace(/[^a-zA-Z0-9_-]+/g, "_");
      const firstObj = ws.activePlate.objects[0]?.name?.replace(/\.[^.]+$/, "") || plateSlug;
      const fileName = `${firstObj.slice(0, 40).replace(/[^a-zA-Z0-9_-]+/g, "_")}.gcode.3mf`;
      const mapping = useAms ? amsMapping : ws.filaments.map(() => 254);

      const res = await sendSlicedPlateToBambuPrinter({
        apiBase: bambu.state.apiBase,
        credential: bambu.state.credential,
        serial: targetPrinter.serial,
        job3mfBytes: bytes,
        fileName,
        subtaskName: firstObj,
        bedType: ws.bedType,
        useAms,
        amsMapping: mapping,
        bedLeveling,
        flowCali,
        vibrationCali,
        timelapse,
        layerInspect,
        onProgress: setProgressMsg,
      });

      ws.notify(
        `Print sent to ${targetPrinter.name}${res.sequenceId ? ` (seq #${res.sequenceId})` : ""}`,
        "success"
      );
      onClose();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Send print to Bambu printer"
      onClick={() => !sending && onClose()}
    >
      <div className="modal-panel" style={{ maxWidth: 500 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Send size={15} color="var(--accent-text)" />
            <span className="modal-title">Print Plate</span>
          </div>
          <button className="icon-btn icon-btn-sm" disabled={sending} onClick={onClose} aria-label="Close Print Plate">
            <X size={15} />
          </button>
        </div>

        <div className="modal-body" style={{ gap: 12 }}>
          {!bambu.isConnected ? (
            <div
              style={{
                padding: 16,
                borderRadius: "var(--radius-md)",
                background: "var(--bg-surface)",
                border: "1px solid var(--border-default)",
                display: "flex",
                flexDirection: "column",
                gap: 10,
                alignItems: "flex-start",
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 600 }}>Connect Bambu Cloud to send prints directly</div>
              <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.45 }}>
                Sign in with your Bambu Lab account or paste a <code className="mono">bk_…</code> API key from{" "}
                <code className="mono">bambuapi.raygen.dev</code>. Credentials stay strictly in your browser.
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    onClose();
                    onOpenConnect();
                  }}
                >
                  <Cloud size={13} />
                  Connect Bambu Cloud
                </button>
                <button className="btn" onClick={ws.exportSliced3MFFile}>
                  <Download size={13} />
                  Download .gcode.3mf
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* Printer Selector */}
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 11.5, color: "var(--text-secondary)", fontWeight: 600 }}>Target Printer</span>
                  {targetPrinter && (
                    <button
                      className="btn btn-ghost btn-sm"
                      style={{ height: 22, fontSize: 11 }}
                      disabled={bambu.syncingSerial === targetPrinter.serial}
                      onClick={() => bambu.refreshPrinterState(targetPrinter.serial, true)}
                    >
                      <RefreshCw size={11} className={bambu.syncingSerial === targetPrinter.serial ? "spin" : ""} />
                      Refresh AMS
                    </button>
                  )}
                </div>
                <select
                  className="select"
                  value={targetSerial}
                  onChange={(e) => {
                    setTargetSerial(e.target.value);
                    bambu.selectPrinter(e.target.value);
                  }}
                >
                  {bambu.state.printers.map((p) => (
                    <option key={p.serial} value={p.serial}>
                      {p.name} ({p.model}) — {p.online ? p.status || "Online" : "Offline"}
                    </option>
                  ))}
                </select>
                {targetPrinter && !targetPrinter.online && (
                  <div style={{ fontSize: 11.5, color: "var(--warning)" }}>
                    This printer currently reports offline on Bambu Cloud.
                  </div>
                )}
              </div>

              {/* AMS Slot Mapping */}
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 11.5, color: "var(--text-secondary)", fontWeight: 600 }}>
                    Filament / AMS Mapping
                  </span>
                  <label style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, cursor: "pointer" }}>
                    <input type="checkbox" checked={useAms} onChange={(e) => setUseAms(e.target.checked)} />
                    Use AMS
                  </label>
                </div>

                {ws.filaments.map((slot, idx) => (
                  <div
                    key={slot.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 8,
                      padding: "6px 8px",
                      borderRadius: "var(--radius-sm)",
                      background: "var(--bg-surface)",
                      border: "1px solid var(--border-subtle)",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                      <span
                        style={{
                          width: 12,
                          height: 12,
                          borderRadius: 3,
                          background: slot.color,
                          border: "1px solid rgba(255,255,255,0.2)",
                          flexShrink: 0,
                        }}
                      />
                      <span style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        #{idx + 1} {slot.profile.name}
                      </span>
                    </div>
                    {useAms ? (
                      <select
                        className="select"
                        style={{ width: 150, height: 26, fontSize: 11.5 }}
                        value={amsMapping[idx] ?? idx}
                        onChange={(e) => {
                          const val = Number(e.target.value);
                          setAmsMapping((prev) => {
                            const next = [...prev];
                            next[idx] = val;
                            return next;
                          });
                        }}
                      >
                        {loadedTrays.length > 0
                          ? loadedTrays.map((t) => (
                              <option key={`${t.amsUnitId}-${t.trayIndex}-${t.isExternal}`} value={t.globalSlot}>
                                {t.isExternal ? "External Spool" : `AMS A${t.globalSlot + 1}`} · {t.material}
                              </option>
                            ))
                          : [0, 1, 2, 3].map((n) => (
                              <option key={n} value={n}>
                                AMS Slot A{n + 1}
                              </option>
                            ))}
                        <option value={254}>External Spool</option>
                      </select>
                    ) : (
                      <span className="mono" style={{ fontSize: 11, color: "var(--text-muted)" }}>
                        External Spool
                      </span>
                    )}
                  </div>
                ))}
              </div>

              {/* Pre-print Calibration & Timelapse Options */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 8,
                  padding: "10px 12px",
                  borderRadius: "var(--radius-md)",
                  background: "var(--bg-frame)",
                  border: "1px solid var(--border-subtle)",
                  fontSize: 12,
                }}
              >
                <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                  <input type="checkbox" checked={bedLeveling} onChange={(e) => setBedLeveling(e.target.checked)} />
                  Bed leveling
                </label>
                <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                  <input type="checkbox" checked={flowCali} onChange={(e) => setFlowCali(e.target.checked)} />
                  Flow dynamics
                </label>
                <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                  <input type="checkbox" checked={timelapse} onChange={(e) => setTimelapse(e.target.checked)} />
                  Timelapse
                </label>
                <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                  <input type="checkbox" checked={vibrationCali} onChange={(e) => setVibrationCali(e.target.checked)} />
                  Vibration cali
                </label>
                <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                  <input type="checkbox" checked={layerInspect} onChange={(e) => setLayerInspect(e.target.checked)} />
                  First-layer inspect
                </label>
              </div>

              {ws.sliceStale && (
                <div style={{ fontSize: 11.5, color: "var(--warning)" }}>
                  Note: models or settings changed since the last slice. Re-slice first if you want the latest changes printed.
                </div>
              )}

              {progressMsg && sending && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "8px 10px",
                    borderRadius: "var(--radius-md)",
                    background: "var(--accent-tint)",
                    color: "var(--accent-text)",
                    fontSize: 12,
                  }}
                >
                  <Loader2 size={13} className="spin" />
                  <span>{progressMsg}</span>
                </div>
              )}

              {sendError && (
                <div
                  style={{
                    padding: "8px 10px",
                    borderRadius: "var(--radius-md)",
                    background: "var(--danger-tint)",
                    border: "1px solid rgba(239, 68, 68, 0.35)",
                    color: "#fca5a5",
                    fontSize: 12,
                  }}
                >
                  {sendError}
                </div>
              )}
            </>
          )}
        </div>

        <div className="modal-footer" style={{ justifyContent: "space-between" }}>
          <button className="btn btn-sm" disabled={sending} onClick={ws.exportSliced3MFFile}>
            <Download size={12} />
            Download .3mf
          </button>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn" disabled={sending} onClick={onClose}>
              Cancel
            </button>
            {bambu.isConnected && (
              <button className="btn btn-primary" disabled={!canSend} onClick={handleSend}>
                {sending ? <Loader2 size={13} className="spin" /> : <Printer size={13} />}
                {sending ? "Sending…" : "Send & Print"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
