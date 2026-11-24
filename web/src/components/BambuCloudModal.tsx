import { useEffect, useState } from "react";
import {
  Check,
  Cloud,
  KeyRound,
  Loader2,
  LogOut,
  PaintBucket,
  Printer,
  RefreshCw,
  ShieldCheck,
  Thermometer,
  X,
} from "lucide-react";
import type { BambuCloudAPI } from "../store/useBambuCloud";
import type { WorkspaceAPI } from "../store/useWorkspace";
import { DEFAULT_BAMBU_API_BASE, mapBambuModelToMachineName, type BambuPrinterSummary } from "../lib/bambuApi";

interface Props {
  open: boolean;
  onClose: () => void;
  bambu: BambuCloudAPI;
  ws: WorkspaceAPI;
}

export function BambuCloudModal({ open, onClose, bambu, ws }: Props) {
  const [authTab, setAuthTab] = useState<"login" | "key">("login");
  const [apiBase, setApiBase] = useState(bambu.state.apiBase || DEFAULT_BAMBU_API_BASE);
  const [showAdvancedEndpoint, setShowAdvancedEndpoint] = useState(false);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mintKey, setMintKey] = useState(true);
  const [emailCode, setEmailCode] = useState("");
  const [tfaCode, setTfaCode] = useState("");
  const [apiKeyInput, setApiKeyInput] = useState("");

  useEffect(() => {
    if (!open) return;
    setApiBase(bambu.state.apiBase || DEFAULT_BAMBU_API_BASE);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, bambu.state.apiBase, onClose]);

  if (!open) return null;

  const applyPrinterToSlicer = (printer: BambuPrinterSummary) => {
    bambu.selectPrinter(printer.serial);
    const live = bambu.state.printerStates[printer.serial];
    const machineName = mapBambuModelToMachineName(printer.model, live?.nozzleDiameter);
    ws.setPrinter({ vendor: "BBL", name: machineName });
    ws.notify(`Switched slicer to ${printer.name} (${machineName})`, "success");
  };

  const handleSyncAms = async (serial: string) => {
    let live = bambu.state.printerStates[serial];
    if (!live || live.amsTrays.length === 0) {
      const fetched = await bambu.refreshPrinterState(serial, true);
      if (fetched) live = fetched;
    }
    if (!live || live.amsTrays.length === 0) {
      ws.notify("No AMS or external spool data reported by this printer yet", "info");
      return;
    }
    ws.syncFilamentsFromAms(live.amsTrays);
  };

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const result = await bambu.signInWithPassword(apiBase, email, password, mintKey);
      if (result === "connected") {
        setPassword("");
        ws.notify("Connected to Bambu Cloud (saved locally in this browser)", "success");
      }
    } catch {
      // error displayed via bambu.error
    }
  };

  const handleCodeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const result = await bambu.submitEmailCode(apiBase, emailCode, mintKey);
      if (result === "connected") {
        setEmailCode("");
        setPassword("");
        ws.notify("Connected to Bambu Cloud (saved locally in this browser)", "success");
      }
    } catch {
      // error displayed via bambu.error
    }
  };

  const handleTfaSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const result = await bambu.submitTfaCode(apiBase, tfaCode, mintKey);
      if (result === "connected") {
        setTfaCode("");
        setPassword("");
        ws.notify("Connected to Bambu Cloud (saved locally in this browser)", "success");
      }
    } catch {
      // error displayed via bambu.error
    }
  };

  const handleKeySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await bambu.connectWithApiKey(apiBase, apiKeyInput);
      setApiKeyInput("");
      ws.notify("Connected via Bambu API key (saved locally in this browser)", "success");
    } catch {
      // error displayed via bambu.error
    }
  };

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Bambu Cloud connection"
      onClick={onClose}
    >
      <div className="modal-panel" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Cloud size={16} color="var(--accent-text)" />
            <span className="modal-title">Bambu Cloud Printers</span>
            <span className="mono" style={{ fontSize: 11, color: "var(--text-muted)" }}>
              bambuapi.raygen.dev
            </span>
          </div>
          <button className="icon-btn icon-btn-sm" onClick={onClose} aria-label="Close Bambu Cloud dialog">
            <X size={15} />
          </button>
        </div>

        <div className="modal-body" style={{ gap: 12 }}>
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 8,
              padding: "8px 10px",
              borderRadius: "var(--radius-md)",
              background: "var(--bg-surface)",
              border: "1px solid var(--border-subtle)",
              fontSize: 11.5,
              color: "var(--text-secondary)",
              lineHeight: 1.45,
            }}
          >
            <ShieldCheck size={14} style={{ flexShrink: 0, marginTop: 1, color: "var(--accent-text)" }} />
            <span>
              Browser-only storage: your Bambu session, API key, and printers are saved exclusively in this browser&apos;s{" "}
              <code className="mono">localStorage</code>. Orca Cloud has no user accounts.
            </span>
          </div>

          {!bambu.isConnected ? (
            <>
              {bambu.challenge.kind === "none" && (
                <div className="segmented" role="tablist" aria-label="Bambu authentication method">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={authTab === "login"}
                    className={`segmented-btn ${authTab === "login" ? "active" : ""}`}
                    onClick={() => setAuthTab("login")}
                  >
                    Bambu Lab Account
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={authTab === "key"}
                    className={`segmented-btn ${authTab === "key" ? "active" : ""}`}
                    onClick={() => setAuthTab("key")}
                  >
                    API Key (bk_…)
                  </button>
                </div>
              )}

              {bambu.challenge.kind === "verifyCode" ? (
                <form onSubmit={handleCodeSubmit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>
                    Bambu sent a verification code to <strong style={{ color: "var(--text-primary)" }}>{bambu.challenge.email}</strong>.
                  </div>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>Email Verification Code</span>
                    <input
                      className="input mono"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      value={emailCode}
                      onChange={(e) => setEmailCode(e.target.value)}
                      placeholder="123456"
                      required
                      autoFocus
                    />
                  </label>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button type="submit" className="btn btn-primary" disabled={bambu.busy}>
                      {bambu.busy && <Loader2 size={13} className="spin" />}
                      Verify &amp; Connect
                    </button>
                    <button
                      type="button"
                      className="btn"
                      disabled={bambu.busy}
                      onClick={() => bambu.resendEmailCode(apiBase)}
                    >
                      Resend Code
                    </button>
                    <button type="button" className="btn btn-ghost" onClick={bambu.resetChallenge}>
                      Back
                    </button>
                  </div>
                </form>
              ) : bambu.challenge.kind === "tfa" ? (
                <form onSubmit={handleTfaSubmit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>
                    Enter the 6-digit authenticator code for <strong style={{ color: "var(--text-primary)" }}>{bambu.challenge.email}</strong>.
                  </div>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>Two-Factor Code</span>
                    <input
                      className="input mono"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      value={tfaCode}
                      onChange={(e) => setTfaCode(e.target.value)}
                      placeholder="000000"
                      required
                      autoFocus
                    />
                  </label>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button type="submit" className="btn btn-primary" disabled={bambu.busy}>
                      {bambu.busy && <Loader2 size={13} className="spin" />}
                      Verify 2FA
                    </button>
                    <button type="button" className="btn btn-ghost" onClick={bambu.resetChallenge}>
                      Back
                    </button>
                  </div>
                </form>
              ) : authTab === "login" ? (
                <form onSubmit={handleLoginSubmit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>Bambu Lab Email</span>
                    <input
                      className="input"
                      type="email"
                      autoComplete="username"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="you@example.com"
                      required
                    />
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>Password</span>
                    <input
                      className="input"
                      type="password"
                      autoComplete="current-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••••••"
                      required
                    />
                  </label>
                  <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--text-secondary)", cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={mintKey}
                      onChange={(e) => setMintKey(e.target.checked)}
                    />
                    Auto-create a browser-only <code className="mono">bk_…</code> API key for longer sessions
                  </label>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 2 }}>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setShowAdvancedEndpoint((v) => !v)}
                    >
                      {showAdvancedEndpoint ? "Hide API URL" : "Custom API URL"}
                    </button>
                    <button type="submit" className="btn btn-primary" disabled={bambu.busy}>
                      {bambu.busy && <Loader2 size={13} className="spin" />}
                      Sign in to Bambu
                    </button>
                  </div>
                </form>
              ) : (
                <form onSubmit={handleKeySubmit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
                      Bambu API Key (<code className="mono">bk_…</code>) or Access Token
                    </span>
                    <input
                      className="input mono"
                      type="password"
                      value={apiKeyInput}
                      onChange={(e) => setApiKeyInput(e.target.value)}
                      placeholder="bk_..."
                      required
                    />
                  </label>
                  <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
                    You can mint an API key anytime at{" "}
                    <a
                      href="https://bambuapi.raygen.dev/login"
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: "var(--accent-text)", textDecoration: "underline" }}
                    >
                      bambuapi.raygen.dev/login
                    </a>
                    .
                  </div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 2 }}>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setShowAdvancedEndpoint((v) => !v)}
                    >
                      {showAdvancedEndpoint ? "Hide API URL" : "Custom API URL"}
                    </button>
                    <button type="submit" className="btn btn-primary" disabled={bambu.busy}>
                      {bambu.busy && <Loader2 size={13} className="spin" />}
                      <KeyRound size={13} />
                      Connect Key
                    </button>
                  </div>
                </form>
              )}

              {showAdvancedEndpoint && (
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                    Bambu API Proxy Base URL (default <code className="mono">/bambu-api</code> → <code className="mono">https://bambuapi.raygen.dev</code>)
                  </span>
                  <input
                    className="input mono"
                    value={apiBase}
                    onChange={(e) => setApiBase(e.target.value)}
                    placeholder={DEFAULT_BAMBU_API_BASE}
                  />
                </label>
              )}
            </>
          ) : (
            <>
              {/* Connected Account Bar */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                  padding: "10px 12px",
                  borderRadius: "var(--radius-md)",
                  background: "var(--bg-surface)",
                  border: "1px solid var(--border-default)",
                }}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span className="status-dot" />
                    <strong style={{ fontSize: 13 }}>
                      {bambu.state.account?.name || bambu.state.account?.email || "Bambu Account"}
                    </strong>
                    <span className="mono" style={{ fontSize: 10.5, color: "var(--text-muted)" }}>
                      ({bambu.state.credentialType === "api_key" ? "API key" : "session token"})
                    </span>
                  </div>
                  {bambu.state.account?.email && bambu.state.account?.name && (
                    <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>{bambu.state.account.email}</span>
                  )}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <button
                    className="btn btn-sm"
                    disabled={bambu.busy}
                    onClick={() => bambu.refreshPrinters()}
                    title="Refresh cloud printers"
                  >
                    <RefreshCw size={12} className={bambu.busy ? "spin" : ""} />
                    Refresh
                  </button>
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={() => {
                      bambu.disconnect();
                      ws.notify("Cleared Bambu credentials & printers from this browser", "info");
                    }}
                    title="Remove saved credentials & printers from browser storage"
                  >
                    <LogOut size={12} />
                    Disconnect
                  </button>
                </div>
              </div>

              {/* Discovered Printers List */}
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text-secondary)" }}>
                  Your Printers ({bambu.state.printers.length})
                </div>

                {bambu.state.printers.length === 0 ? (
                  <div
                    style={{
                      padding: 14,
                      borderRadius: "var(--radius-md)",
                      border: "1px dashed var(--border-default)",
                      color: "var(--text-muted)",
                      fontSize: 12,
                      textAlign: "center",
                    }}
                  >
                    No cloud-bound printers returned for this Bambu account.
                  </div>
                ) : (
                  bambu.state.printers.map((p) => {
                    const isSelected = bambu.selectedPrinter?.serial === p.serial;
                    const live = bambu.state.printerStates[p.serial];
                    const loadedTrays = (live?.amsTrays || []).filter((t) => !t.empty);
                    const isSyncing = bambu.syncingSerial === p.serial;

                    return (
                      <div
                        key={p.serial}
                        style={{
                          padding: "10px 12px",
                          borderRadius: "var(--radius-md)",
                          background: isSelected ? "rgba(34, 197, 94, 0.06)" : "var(--bg-frame)",
                          border: `1px solid ${isSelected ? "rgba(34, 197, 94, 0.45)" : "var(--border-subtle)"}`,
                          display: "flex",
                          flexDirection: "column",
                          gap: 8,
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                            <Printer size={15} color={p.online ? "var(--accent-text)" : "var(--text-muted)"} />
                            <div style={{ minWidth: 0 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                <strong style={{ fontSize: 13 }}>{p.name}</strong>
                                <span
                                  className="mono"
                                  style={{
                                    fontSize: 10.5,
                                    padding: "1px 6px",
                                    borderRadius: 99,
                                    background: p.online ? "var(--accent-tint)" : "var(--bg-surface)",
                                    color: p.online ? "var(--accent-text)" : "var(--text-muted)",
                                  }}
                                >
                                  {p.online ? live?.gcodeState || p.status || "ONLINE" : "OFFLINE"}
                                </span>
                              </div>
                              <div className="mono" style={{ fontSize: 11, color: "var(--text-muted)" }}>
                                {p.model} · {p.serial}
                                {live?.nozzleDiameter ? ` · ${live.nozzleDiameter}mm` : ""}
                              </div>
                            </div>
                          </div>

                          <div style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
                            <button
                              className="btn btn-sm"
                              disabled={isSyncing}
                              onClick={() => bambu.refreshPrinterState(p.serial, true)}
                              title="Fetch live temperatures & AMS trays"
                            >
                              <RefreshCw size={11} className={isSyncing ? "spin" : ""} />
                            </button>
                            <button
                              className={`btn btn-sm ${isSelected ? "btn-primary" : ""}`}
                              onClick={() => applyPrinterToSlicer(p)}
                            >
                              {isSelected && <Check size={12} />}
                              {isSelected ? "Active" : "Use in Slicer"}
                            </button>
                          </div>
                        </div>

                        {live && (
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              flexWrap: "wrap",
                              gap: 10,
                              fontSize: 11,
                              color: "var(--text-secondary)",
                            }}
                          >
                            {live.nozzleTemp !== null && (
                              <span className="mono" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                                <Thermometer size={11} />
                                Nozzle {Math.round(live.nozzleTemp)}°/{Math.round(live.nozzleTarget ?? 0)}°C
                              </span>
                            )}
                            {live.bedTemp !== null && (
                              <span className="mono">
                                Bed {Math.round(live.bedTemp)}°/{Math.round(live.bedTarget ?? 0)}°C
                              </span>
                            )}
                            {live.gcodeState === "RUNNING" && live.progressPct !== null && (
                              <span className="mono" style={{ color: "var(--accent-text)" }}>
                                Printing {Math.round(live.progressPct)}%
                                {live.remainingMin ? ` · ${live.remainingMin}m left` : ""}
                              </span>
                            )}
                          </div>
                        )}

                        {loadedTrays.length > 0 && (
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
                              {loadedTrays.map((t) => (
                                <span
                                  key={`${t.amsUnitId}-${t.trayIndex}-${t.isExternal}`}
                                  style={{
                                    display: "inline-flex",
                                    alignItems: "center",
                                    gap: 5,
                                    padding: "2px 7px",
                                    borderRadius: 99,
                                    fontSize: 10.5,
                                    background: "var(--bg-surface)",
                                    border: "1px solid var(--border-subtle)",
                                  }}
                                  title={`${t.isExternal ? "External Spool" : `AMS Slot ${t.globalSlot + 1}`}: ${t.subBrand} (${t.material})`}
                                >
                                  <span
                                    style={{
                                      width: 9,
                                      height: 9,
                                      borderRadius: "50%",
                                      background: t.colorHex,
                                      border: "1px solid rgba(255,255,255,0.25)",
                                    }}
                                  />
                                  <span className="mono" style={{ color: "var(--text-muted)" }}>
                                    {t.isExternal ? "EXT" : `A${t.globalSlot + 1}`}
                                  </span>
                                  <span>{t.material}</span>
                                </span>
                              ))}
                            </div>
                            <button
                              className="btn btn-sm"
                              style={{ height: 22, fontSize: 11 }}
                              onClick={() => handleSyncAms(p.serial)}
                            >
                              <PaintBucket size={11} />
                              Sync to Slicer
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </>
          )}

          {bambu.error && (
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
              {bambu.error}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
