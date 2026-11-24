import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  bambuCreateApiKey,
  bambuGetMe,
  bambuGetPrinterState,
  bambuListPrinters,
  bambuLogin,
  bambuRequestEmailCode,
  bambuVerifyTfa,
  clearBambuState,
  EMPTY_BAMBU_STATE,
  loadBambuState,
  saveBambuState,
  type BambuLoginResponse,
  type BambuPrinterLiveState,
  type BambuPrinterSummary,
  type BambuStoredState,
} from "../lib/bambuApi";

export type BambuAuthChallenge =
  | { kind: "none" }
  | { kind: "verifyCode"; email: string }
  | { kind: "tfa"; email: string; tfaKey: string };

export function useBambuCloud() {
  const [state, setState] = useState<BambuStoredState>(() => loadBambuState());
  const [busy, setBusy] = useState(false);
  const [syncingSerial, setSyncingSerial] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<BambuAuthChallenge>({ kind: "none" });
  const stateRef = useRef(state);
  stateRef.current = state;

  const commit = useCallback((updater: (prev: BambuStoredState) => BambuStoredState) => {
    setState((prev) => {
      const next = updater(prev);
      saveBambuState(next);
      return next;
    });
  }, []);

  const isConnected = Boolean(state.credential.trim());

  const selectedPrinter: BambuPrinterSummary | null = useMemo(() => {
    if (!state.printers.length) return null;
    if (state.selectedSerial) {
      const found = state.printers.find((p) => p.serial === state.selectedSerial);
      if (found) return found;
    }
    return state.printers[0];
  }, [state.printers, state.selectedSerial]);

  const selectedPrinterState: BambuPrinterLiveState | null = selectedPrinter
    ? state.printerStates[selectedPrinter.serial] || null
    : null;

  const refreshPrinters = useCallback(
    async (opts?: { credential?: string; apiBase?: string; credentialType?: "api_key" | "token"; silent?: boolean }) => {
      const cur = stateRef.current;
      const apiBase = opts?.apiBase ?? cur.apiBase;
      const credential = (opts?.credential ?? cur.credential).trim();
      const credentialType = opts?.credentialType ?? cur.credentialType;
      if (!credential) return null;

      if (!opts?.silent) setBusy(true);
      setError(null);
      try {
        const [account, printers] = await Promise.all([
          bambuGetMe(apiBase, credential).catch(() => cur.account),
          bambuListPrinters(apiBase, credential),
        ]);
        const nextSelected =
          cur.selectedSerial && printers.some((p) => p.serial === cur.selectedSerial)
            ? cur.selectedSerial
            : printers[0]?.serial || null;

        commit((prev) => ({
          ...prev,
          apiBase,
          credential,
          credentialType,
          account,
          printers,
          selectedSerial: nextSelected,
          lastSyncedAt: Date.now(),
        }));

        // Eagerly fetch live state (temps + AMS trays) for the active online printer in the background
        const active = printers.find((p) => p.serial === nextSelected) || printers[0];
        if (active) {
          bambuGetPrinterState(apiBase, credential, active.serial, false)
            .then((live) => {
              commit((prev) => ({
                ...prev,
                printerStates: { ...prev.printerStates, [active.serial]: live },
              }));
            })
            .catch(() => {
              // printer may be offline or not yet reporting; keep list intact
            });
        }

        return { account, printers, selectedSerial: nextSelected };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!opts?.silent) setError(msg);
        throw err;
      } finally {
        if (!opts?.silent) setBusy(false);
      }
    },
    [commit]
  );

  const refreshPrinterState = useCallback(
    async (serial: string, forcePushAll = true): Promise<BambuPrinterLiveState | null> => {
      const cur = stateRef.current;
      if (!cur.credential.trim()) return null;
      setSyncingSerial(serial);
      setError(null);
      try {
        const live = await bambuGetPrinterState(cur.apiBase, cur.credential, serial, forcePushAll);
        commit((prev) => ({
          ...prev,
          printerStates: { ...prev.printerStates, [serial]: live },
        }));
        return live;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        return null;
      } finally {
        setSyncingSerial(null);
      }
    },
    [commit]
  );

  // Silent background refresh on mount if browser already has saved Bambu credentials
  useEffect(() => {
    if (!state.credential.trim()) return;
    refreshPrinters({ silent: true }).catch(() => {
      // keep cached printers available offline
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finalizeBambuTokenLogin = useCallback(
    async (apiBase: string, accessToken: string, mintApiKey: boolean) => {
      let credential = accessToken;
      let credentialType: "api_key" | "token" = "token";
      if (mintApiKey) {
        try {
          const created = await bambuCreateApiKey(
            apiBase,
            accessToken,
            `Orca Cloud (${new Date().toISOString().slice(0, 10)})`
          );
          if (created?.key) {
            credential = created.key;
            credentialType = "api_key";
          }
        } catch {
          // Fall back to direct Bambu access token in browser localStorage
        }
      }
      setChallenge({ kind: "none" });
      await refreshPrinters({ apiBase, credential, credentialType });
    },
    [refreshPrinters]
  );

  const handleLoginResult = useCallback(
    async (apiBase: string, email: string, res: BambuLoginResponse, mintApiKey: boolean) => {
      if (res.accessToken) {
        await finalizeBambuTokenLogin(apiBase, res.accessToken, mintApiKey);
        return "connected" as const;
      }
      if (res.loginType === "verifyCode") {
        await bambuRequestEmailCode(apiBase, email);
        setChallenge({ kind: "verifyCode", email });
        return "verifyCode" as const;
      }
      if (res.loginType === "tfa" && res.tfaKey) {
        setChallenge({ kind: "tfa", email, tfaKey: res.tfaKey });
        return "tfa" as const;
      }
      throw new Error(res.message || `Unexpected Bambu login response (${res.loginType || "unknown"})`);
    },
    [finalizeBambuTokenLogin]
  );

  const signInWithPassword = useCallback(
    async (apiBase: string, email: string, password: string, mintApiKey = true) => {
      setBusy(true);
      setError(null);
      try {
        const res = await bambuLogin(apiBase, { account: email.trim(), password });
        return await handleLoginResult(apiBase, email.trim(), res, mintApiKey);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        throw err;
      } finally {
        setBusy(false);
      }
    },
    [handleLoginResult]
  );

  const submitEmailCode = useCallback(
    async (apiBase: string, code: string, mintApiKey = true) => {
      if (challenge.kind !== "verifyCode") return;
      setBusy(true);
      setError(null);
      try {
        const res = await bambuLogin(apiBase, { account: challenge.email, code: code.trim() });
        return await handleLoginResult(apiBase, challenge.email, res, mintApiKey);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        throw err;
      } finally {
        setBusy(false);
      }
    },
    [challenge, handleLoginResult]
  );

  const resendEmailCode = useCallback(
    async (apiBase: string) => {
      if (challenge.kind !== "verifyCode") return;
      setBusy(true);
      setError(null);
      try {
        await bambuRequestEmailCode(apiBase, challenge.email);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        throw err;
      } finally {
        setBusy(false);
      }
    },
    [challenge]
  );

  const submitTfaCode = useCallback(
    async (apiBase: string, tfaCode: string, mintApiKey = true) => {
      if (challenge.kind !== "tfa") return;
      setBusy(true);
      setError(null);
      try {
        const res = await bambuVerifyTfa(apiBase, challenge.tfaKey, tfaCode.trim());
        return await handleLoginResult(apiBase, challenge.email, res, mintApiKey);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        throw err;
      } finally {
        setBusy(false);
      }
    },
    [challenge, handleLoginResult]
  );

  const connectWithApiKey = useCallback(
    async (apiBase: string, apiKey: string) => {
      const trimmed = apiKey.trim();
      if (!trimmed) throw new Error("Enter a Bambu API key (bk_…) or access token");
      setChallenge({ kind: "none" });
      return refreshPrinters({
        apiBase,
        credential: trimmed,
        credentialType: trimmed.startsWith("bk_") ? "api_key" : "token",
      });
    },
    [refreshPrinters]
  );

  const selectPrinter = useCallback(
    (serial: string) => {
      commit((prev) => ({ ...prev, selectedSerial: serial }));
      const cur = stateRef.current;
      if (cur.credential.trim() && !cur.printerStates[serial]) {
        void refreshPrinterState(serial, false);
      }
    },
    [commit, refreshPrinterState]
  );

  const disconnect = useCallback(() => {
    clearBambuState();
    setChallenge({ kind: "none" });
    setError(null);
    setState({ ...EMPTY_BAMBU_STATE });
  }, []);

  const resetChallenge = useCallback(() => {
    setChallenge({ kind: "none" });
    setError(null);
  }, []);

  return {
    state,
    isConnected,
    busy,
    syncingSerial,
    error,
    challenge,
    selectedPrinter,
    selectedPrinterState,
    signInWithPassword,
    submitEmailCode,
    resendEmailCode,
    submitTfaCode,
    connectWithApiKey,
    refreshPrinters,
    refreshPrinterState,
    selectPrinter,
    disconnect,
    resetChallenge,
  };
}

export type BambuCloudAPI = ReturnType<typeof useBambuCloud>;
