/**
 * Browser-local Bambu Cloud API client (bambuapi.raygen.dev).
 * All account tokens/API keys, discovered printers, and cached AMS filament trays
 * live exclusively in browser localStorage — zero Orca Cloud server-side accounts.
 */

export const BAMBU_STORAGE_KEY = "orca_cloud_bambu_v1";
export const DEFAULT_BAMBU_API_BASE = "/bambu-api";

export interface BambuAccountProfile {
  uid?: string;
  name?: string;
  email?: string;
  avatar?: string;
}

export interface BambuPrinterSummary {
  serial: string;
  name: string;
  model: string;
  online: boolean;
  status: string;
}

export interface BambuAmsTray {
  /** Global slot index 0..15 for AMS trays, or 254 for External Spool (vt_tray) */
  globalSlot: number;
  amsUnitId: number;
  trayIndex: number;
  isExternal: boolean;
  material: string;
  subBrand: string;
  colorHex: string;
  remainPct: number | null;
  nozzleTempMin: number | null;
  nozzleTempMax: number | null;
  trayUuid?: string;
  empty: boolean;
}

export interface BambuPrinterLiveState {
  gcodeState: string;
  subtaskName: string | null;
  progressPct: number | null;
  remainingMin: number | null;
  nozzleTemp: number | null;
  nozzleTarget: number | null;
  bedTemp: number | null;
  bedTarget: number | null;
  nozzleDiameter: string | null;
  amsTrays: BambuAmsTray[];
  updatedAt: number;
}

export interface BambuStoredState {
  apiBase: string;
  credential: string;
  credentialType: "api_key" | "token";
  account: BambuAccountProfile | null;
  printers: BambuPrinterSummary[];
  selectedSerial: string | null;
  printerStates: Record<string, BambuPrinterLiveState>;
  lastSyncedAt: number | null;
}

export const EMPTY_BAMBU_STATE: BambuStoredState = {
  apiBase: DEFAULT_BAMBU_API_BASE,
  credential: "",
  credentialType: "api_key",
  account: null,
  printers: [],
  selectedSerial: null,
  printerStates: {},
  lastSyncedAt: null,
};

export function loadBambuState(): BambuStoredState {
  try {
    const raw = localStorage.getItem(BAMBU_STORAGE_KEY);
    if (!raw) return { ...EMPTY_BAMBU_STATE };
    const parsed = JSON.parse(raw) as Partial<BambuStoredState>;
    return {
      apiBase: typeof parsed.apiBase === "string" && parsed.apiBase.trim() ? parsed.apiBase.trim() : DEFAULT_BAMBU_API_BASE,
      credential: typeof parsed.credential === "string" ? parsed.credential : "",
      credentialType: parsed.credentialType === "token" ? "token" : "api_key",
      account: parsed.account || null,
      printers: Array.isArray(parsed.printers) ? parsed.printers : [],
      selectedSerial: typeof parsed.selectedSerial === "string" ? parsed.selectedSerial : null,
      printerStates: parsed.printerStates && typeof parsed.printerStates === "object" ? parsed.printerStates : {},
      lastSyncedAt: typeof parsed.lastSyncedAt === "number" ? parsed.lastSyncedAt : null,
    };
  } catch {
    return { ...EMPTY_BAMBU_STATE };
  }
}

export function saveBambuState(state: BambuStoredState): void {
  try {
    localStorage.setItem(BAMBU_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore storage quota errors
  }
}

export function clearBambuState(): void {
  try {
    localStorage.removeItem(BAMBU_STORAGE_KEY);
  } catch {
    // ignore
  }
}

function normalizeBase(apiBase: string): string {
  const b = (apiBase || DEFAULT_BAMBU_API_BASE).trim().replace(/\/+$/, "");
  return b || DEFAULT_BAMBU_API_BASE;
}

async function bambuFetchJson<T>(
  apiBase: string,
  path: string,
  opts: { method?: string; credential?: string; body?: unknown } = {}
): Promise<T> {
  const url = `${normalizeBase(apiBase)}${path.startsWith("/") ? path : `/${path}`}`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.credential?.trim()) {
    headers["Authorization"] = `Bearer ${opts.credential.trim()}`;
  }
  const resp = await fetch(url, {
    method: opts.method || "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await resp.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text || `HTTP ${resp.status}` };
  }
  if (!resp.ok) {
    const obj = data as { error?: string; message?: string; reason?: string } | null;
    throw new Error(obj?.error || obj?.reason || obj?.message || `Bambu API error (${resp.status})`);
  }
  return data as T;
}

export interface BambuLoginResponse {
  accessToken?: string;
  refreshToken?: string;
  loginType?: string;
  tfaKey?: string;
  message?: string;
}

export async function bambuLogin(
  apiBase: string,
  payload: { account: string; password?: string; code?: string }
): Promise<BambuLoginResponse> {
  return bambuFetchJson<BambuLoginResponse>(apiBase, "/v1/auth/login", {
    method: "POST",
    body: payload,
  });
}

export async function bambuRequestEmailCode(apiBase: string, email: string): Promise<void> {
  await bambuFetchJson(apiBase, "/v1/auth/email-code", {
    method: "POST",
    body: { email, type: "codeLogin" },
  });
}

export async function bambuVerifyTfa(
  apiBase: string,
  tfaKey: string,
  tfaCode: string
): Promise<BambuLoginResponse> {
  return bambuFetchJson<BambuLoginResponse>(apiBase, "/v1/auth/tfa", {
    method: "POST",
    body: { tfaKey, tfaCode },
  });
}

export async function bambuCreateApiKey(
  apiBase: string,
  bambuToken: string,
  name: string
): Promise<{ id: string; key: string; name: string; prefix: string }> {
  return bambuFetchJson(apiBase, "/v1/keys", {
    method: "POST",
    credential: bambuToken,
    body: { name },
  });
}

export async function bambuGetMe(apiBase: string, credential: string): Promise<BambuAccountProfile> {
  const raw = await bambuFetchJson<Record<string, unknown>>(apiBase, "/v1/me", { credential });
  const user = (raw.user as Record<string, unknown> | undefined) || raw;
  return {
    uid: user.uid != null ? String(user.uid) : user.uidStr ? String(user.uidStr) : undefined,
    name: typeof user.name === "string" ? user.name : typeof user.handle === "string" ? user.handle : undefined,
    email: typeof user.email === "string" ? user.email : typeof user.account === "string" ? user.account : undefined,
    avatar: typeof user.avatar === "string" ? user.avatar : undefined,
  };
}

export async function bambuListPrinters(apiBase: string, credential: string): Promise<BambuPrinterSummary[]> {
  const res = await bambuFetchJson<{ printers?: BambuPrinterSummary[] }>(apiBase, "/v1/printers", { credential });
  return Array.isArray(res.printers) ? res.printers : [];
}

export function normalizeBambuColorHex(raw: unknown): string {
  if (typeof raw !== "string") return "#94a3b8";
  const cleaned = raw.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{6,8}$/.test(cleaned)) {
    return `#${cleaned.slice(0, 6).toLowerCase()}`;
  }
  return "#94a3b8";
}

function asNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function parseSingleTray(
  tray: Record<string, unknown>,
  amsUnitId: number,
  trayIndex: number,
  isExternal: boolean
): BambuAmsTray {
  const material = typeof tray.tray_type === "string" ? tray.tray_type.trim() : "";
  const subBrand = typeof tray.tray_sub_brands === "string" ? tray.tray_sub_brands.trim() : "";
  const empty = !material && !subBrand && (!tray.tray_color || String(tray.tray_color).replace(/^#/, "") === "00000000");
  const remainRaw = asNum(tray.remain);
  return {
    globalSlot: isExternal ? 254 : amsUnitId * 4 + trayIndex,
    amsUnitId,
    trayIndex,
    isExternal,
    material: material || "PLA",
    subBrand: subBrand || (material ? `Generic ${material}` : "Empty"),
    colorHex: normalizeBambuColorHex(tray.tray_color),
    remainPct: remainRaw !== null && remainRaw >= 0 && remainRaw <= 100 ? Math.round(remainRaw) : null,
    nozzleTempMin: asNum(tray.nozzle_temp_min),
    nozzleTempMax: asNum(tray.nozzle_temp_max),
    trayUuid: typeof tray.tray_uuid === "string" ? tray.tray_uuid : undefined,
    empty,
  };
}

/**
 * Parses a merged Bambu MQTT DeviceState snapshot (from GET /v1/printers/{sn})
 * into live temperatures, print job progress, nozzle diameter, and loaded AMS / external spool trays.
 */
export function parseBambuDeviceState(raw: Record<string, unknown>): BambuPrinterLiveState {
  const root =
    (raw.print && typeof raw.print === "object" ? (raw.print as Record<string, unknown>) : null) ||
    (raw.state && typeof raw.state === "object" ? (raw.state as Record<string, unknown>) : null) ||
    raw;

  const amsTrays: BambuAmsTray[] = [];
  const amsRoot = root.ams as Record<string, unknown> | undefined;
  const amsUnits = Array.isArray(amsRoot?.ams) ? (amsRoot.ams as Array<Record<string, unknown>>) : [];
  for (const unit of amsUnits) {
    const unitId = Number(unit.id ?? 0) || 0;
    const trays = Array.isArray(unit.tray) ? (unit.tray as Array<Record<string, unknown>>) : [];
    for (let i = 0; i < trays.length; i++) {
      const t = trays[i];
      const idx = Number(t.id ?? i);
      amsTrays.push(parseSingleTray(t, unitId, Number.isFinite(idx) ? idx : i, false));
    }
  }
  if (root.vt_tray && typeof root.vt_tray === "object") {
    const ext = parseSingleTray(root.vt_tray as Record<string, unknown>, 255, 0, true);
    if (!ext.empty || amsTrays.length === 0) {
      amsTrays.push(ext);
    }
  }

  const nozzleDiamRaw = root.nozzle_diameter ?? (root.device as Record<string, unknown> | undefined)?.nozzle_diameter;
  const nozzleDiameter =
    nozzleDiamRaw != null && String(nozzleDiamRaw).trim() ? String(nozzleDiamRaw).trim() : null;

  return {
    gcodeState: typeof root.gcode_state === "string" ? root.gcode_state : "IDLE",
    subtaskName: typeof root.subtask_name === "string" && root.subtask_name.trim() ? root.subtask_name.trim() : null,
    progressPct: asNum(root.mc_percent),
    remainingMin: asNum(root.mc_remaining_time),
    nozzleTemp: asNum(root.nozzle_temper),
    nozzleTarget: asNum(root.nozzle_target_temper),
    bedTemp: asNum(root.bed_temper),
    bedTarget: asNum(root.bed_target_temper),
    nozzleDiameter,
    amsTrays,
    updatedAt: Date.now(),
  };
}

export async function bambuGetPrinterState(
  apiBase: string,
  credential: string,
  serial: string,
  refresh = true
): Promise<BambuPrinterLiveState> {
  const qs = refresh ? "?refresh=1" : "";
  const raw = await bambuFetchJson<Record<string, unknown>>(
    apiBase,
    `/v1/printers/${encodeURIComponent(serial)}${qs}`,
    { credential }
  );
  return parseBambuDeviceState(raw);
}

/**
 * Maps a Bambu Cloud model string or product code (e.g. "N1", "A1 mini", "C12", "P1S", "X1C")
 * plus optional nozzle diameter to the official OrcaSlicer BBL machine profile name.
 */
export function mapBambuModelToMachineName(model: string, nozzleDiameter?: string | null): string {
  const m = (model || "").trim().toLowerCase();
  const nozzle =
    nozzleDiameter && /^(0\.2|0\.4|0\.6|0\.8)$/.test(nozzleDiameter.trim())
      ? nozzleDiameter.trim()
      : "0.4";

  if (m === "n1" || m.includes("a1 mini") || m.includes("a1m")) {
    return `Bambu Lab A1 mini ${nozzle} nozzle`;
  }
  if (m === "n2s" || m === "a1" || m === "bambu lab a1") {
    return `Bambu Lab A1 ${nozzle} nozzle`;
  }
  if (m === "c12" || m.includes("p1s")) {
    return `Bambu Lab P1S ${nozzle} nozzle`;
  }
  if (m === "c11" || m.includes("p1p")) {
    return `Bambu Lab P1P ${nozzle} nozzle`;
  }
  if (m === "c13" || m.includes("x1e")) {
    return `Bambu Lab X1E ${nozzle} nozzle`;
  }
  if (m === "bl-p001" || m.includes("x1c") || m.includes("x1 carbon") || m === "x1") {
    return `Bambu Lab X1 Carbon ${nozzle} nozzle`;
  }
  if (m === "o1d" || m.includes("h2d")) {
    return `Bambu Lab H2D ${nozzle} nozzle`;
  }
  return `Bambu Lab A1 mini ${nozzle} nozzle`;
}

/**
 * Maps Orca Cloud bedType to Bambu MQTT project_file bed_type identifier.
 */
export function mapBedTypeToBambuParam(bedType: string): string {
  const b = bedType.toLowerCase();
  if (b.includes("textured") && b.includes("cool")) return "supertack_plate";
  if (b.includes("textured")) return "textured_plate";
  if (b.includes("cool")) return "cool_plate";
  if (b.includes("engineering")) return "eng_plate";
  if (b.includes("high temp") || b.includes("smooth")) return "hot_plate";
  return "auto";
}

/**
 * Minimal RFC 1321 MD5 hex digest in pure JS (Web Crypto SubtleCrypto does not provide MD5).
 * Used to pass the exact 3MF checksum required by Bambu printer `project_file` MQTT commands.
 */
export function md5Hex(input: Uint8Array): string {
  const s = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) {
    K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;
  }

  const bitLen = input.length * 8;
  const padLen = ((56 - ((input.length + 1) % 64)) + 64) % 64;
  const padded = new Uint8Array(input.length + 1 + padLen + 8);
  padded.set(input);
  padded[input.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, bitLen >>> 0, true);
  dv.setUint32(padded.length - 4, Math.floor(bitLen / 0x100000000) >>> 0, true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const M = new Uint32Array(16);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let j = 0; j < 16; j++) M[j] = dv.getUint32(offset + j * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number;
      let g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      const sum = (A + F + K[i] + M[g]) >>> 0;
      const rot = ((sum << s[i]) | (sum >>> (32 - s[i]))) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + rot) >>> 0;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  const out = new Uint8Array(16);
  const outDv = new DataView(out.buffer);
  outDv.setUint32(0, a0, true);
  outDv.setUint32(4, b0, true);
  outDv.setUint32(8, c0, true);
  outDv.setUint32(12, d0, true);
  return Array.from(out)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface SendBambuPrintParams {
  apiBase: string;
  credential: string;
  serial: string;
  job3mfBytes: Uint8Array;
  fileName: string;
  subtaskName: string;
  bedType: string;
  useAms: boolean;
  amsMapping: number[];
  bedLeveling: boolean;
  flowCali: boolean;
  vibrationCali: boolean;
  timelapse: boolean;
  layerInspect: boolean;
  onProgress?: (stage: string) => void;
}

function extractUploadUrls(raw: unknown): { uploadUrl: string | null; downloadUrl: string | null } {
  const walk = (obj: unknown): { uploadUrl: string | null; downloadUrl: string | null } => {
    if (!obj || typeof obj !== "object") return { uploadUrl: null, downloadUrl: null };
    const rec = obj as Record<string, unknown>;
    const candidatesUpload = [rec.upload_url, rec.uploadUrl, rec.put_url, rec.oss_url, rec.url];
    const candidatesDownload = [rec.download_url, rec.downloadUrl, rec.file_url, rec.fileUrl, rec.url];
    let uploadUrl = candidatesUpload.find((v): v is string => typeof v === "string" && v.startsWith("https://")) || null;
    let downloadUrl = candidatesDownload.find((v): v is string => typeof v === "string" && v.startsWith("https://")) || null;
    if (!uploadUrl && rec.data) {
      const nested = walk(rec.data);
      uploadUrl = nested.uploadUrl;
      downloadUrl = downloadUrl || nested.downloadUrl;
    }
    if (!uploadUrl && Array.isArray(rec.urls)) {
      for (const entry of rec.urls) {
        const nested = walk(entry);
        if (nested.uploadUrl) {
          uploadUrl = nested.uploadUrl;
          downloadUrl = downloadUrl || nested.downloadUrl;
          break;
        }
      }
    }
    return { uploadUrl, downloadUrl };
  };
  return walk(raw);
}

/**
 * Uploads a sliced .gcode.3mf to Bambu Cloud storage and dispatches a cloud MQTT
 * `project_file` print command via bambuapi.raygen.dev.
 */
export async function sendSlicedPlateToBambuPrinter(params: SendBambuPrintParams): Promise<{
  sequenceId?: string;
  result?: string;
}> {
  const safeName = params.fileName.endsWith(".3mf") ? params.fileName : `${params.fileName}.gcode.3mf`;
  params.onProgress?.("Requesting Bambu Cloud upload URL…");

  let uploadUrl: string | null = null;
  let downloadUrl: string | null = null;
  try {
    const qs = new URLSearchParams({
      dev_id: params.serial,
      type: "3mf",
      name: safeName,
    });
    const res = await bambuFetchJson<unknown>(
      params.apiBase,
      `/v1/cloud/iot-service2/api/user/upload/v2?${qs.toString()}`,
      { credential: params.credential }
    );
    const extracted = extractUploadUrls(res);
    uploadUrl = extracted.uploadUrl;
    downloadUrl = extracted.downloadUrl;
  } catch {
    // fallback below
  }

  if (!uploadUrl) {
    const res = await bambuFetchJson<unknown>(params.apiBase, "/v1/cloud/user-service/my/upload", {
      method: "POST",
      credential: params.credential,
      body: {
        filename: safeName,
        size: params.job3mfBytes.byteLength,
      },
    });
    const extracted = extractUploadUrls(res);
    uploadUrl = extracted.uploadUrl;
    downloadUrl = extracted.downloadUrl;
  }

  if (!uploadUrl) {
    throw new Error("Bambu Cloud did not return a presigned 3MF upload URL for this account/printer");
  }

  params.onProgress?.(`Uploading ${safeName} (${(params.job3mfBytes.byteLength / 1024).toFixed(0)} KB) to Bambu Cloud…`);
  const uploadPayload = new Uint8Array(params.job3mfBytes.byteLength);
  uploadPayload.set(params.job3mfBytes);
  const putResp = await fetch("/bambu-upload", {
    method: "PUT",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Upload-Target": uploadUrl,
    },
    body: uploadPayload,
  });
  if (!putResp.ok) {
    const errText = await putResp.text().catch(() => "");
    throw new Error(`3MF upload failed (${putResp.status})${errText ? `: ${errText.slice(0, 140)}` : ""}`);
  }

  const md5 = md5Hex(params.job3mfBytes);
  const fileUrl = downloadUrl || uploadUrl;

  params.onProgress?.("Sending print command to printer…");
  return bambuFetchJson<{ sequenceId?: string; result?: string }>(
    params.apiBase,
    `/v1/printers/${encodeURIComponent(params.serial)}/job/project`,
    {
      method: "POST",
      credential: params.credential,
      body: {
        url: fileUrl,
        param: "Metadata/plate_1.gcode",
        subtask_name: params.subtaskName || safeName.replace(/\.gcode\.3mf$/i, ""),
        md5,
        use_ams: params.useAms,
        ams_mapping: params.amsMapping,
        bed_type: mapBedTypeToBambuParam(params.bedType),
        bed_leveling: params.bedLeveling,
        flow_cali: params.flowCali,
        vibration_cali: params.vibrationCali,
        timelapse: params.timelapse,
        layer_inspect: params.layerInspect,
        profile_id: "0",
        project_id: "0",
        subtask_id: "0",
        task_id: "0",
      },
    }
  );
}
