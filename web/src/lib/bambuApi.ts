/**
 * Browser-local Bambu Cloud API client (bambuapi.raygen.dev).
 * All account tokens/API keys, discovered printers, and cached AMS filament trays
 * live exclusively in browser localStorage — zero Orca Cloud server-side accounts.
 */

import { unzipSync, zipSync } from "fflate";

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
  opts: { method?: string; credential?: string; body?: unknown; headers?: Record<string, string> } = {}
): Promise<T> {
  const url = `${normalizeBase(apiBase)}${path.startsWith("/") ? path : `/${path}`}`;
  const headers: Record<string, string> = { Accept: "application/json", ...(opts.headers || {}) };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.credential?.trim()) {
    headers["Authorization"] = `Bearer ${opts.credential.trim()}`;
  }
  const resp = await fetch(url, {
    method: opts.method || "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const traceId = resp.headers.get("X-Trace-ID") || resp.headers.get("x-trace-id");
  const text = await resp.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text || `HTTP ${resp.status}` };
  }
  if (!resp.ok) {
    const obj = data as {
      error?: string;
      message?: string;
      reason?: string;
      code?: number | string;
      detail?: { error?: string; message?: string; code?: number | string } | string;
    } | null;
    const baseMsg = obj?.error || obj?.reason || obj?.message || `Bambu API error (${resp.status})`;
    const detailMsg =
      typeof obj?.detail === "string"
        ? obj.detail
        : obj?.detail && typeof obj.detail === "object"
          ? obj.detail.message || obj.detail.error || ""
          : "";
    const parts = [baseMsg];
    if (detailMsg && detailMsg !== baseMsg) parts.push(detailMsg);
    if (obj?.code !== undefined && obj.code !== null && String(obj.code) !== "" && String(obj.code) !== String(resp.status)) {
      parts.push(`code ${obj.code}`);
    }
    if (traceId) parts.push(`trace ${traceId.slice(0, 12)}`);
    throw new Error(parts.join(" · "));
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
  printerModel?: string;
  nozzleDiameter?: string | null;
  job3mfBytes: Uint8Array;
  fileName: string;
  subtaskName: string;
  plateName?: string;
  bedType: string;
  useAms: boolean;
  amsMapping: number[];
  bedLeveling: boolean;
  flowCali: boolean;
  vibrationCali: boolean;
  timelapse: boolean;
  layerInspect: boolean;
  onProgress?: (stage: string) => void;
  /** Override notification poll interval (ms); defaults to 500ms. */
  pollIntervalMs?: number;
}

export interface SendBambuPrintResult {
  taskId?: string;
  projectId?: string;
  modelId?: string;
  profileId?: string;
  sequenceId?: string;
  result?: string;
}

/**
 * Normalizes a Bambu printer model string or product code into Bambu Cloud's
 * canonical `printer_model_id` (e.g. "N1", "N2S", "C12", "BL-P001", "O1D").
 */
export function normalizeBambuModelId(model?: string | null): string | null {
  const raw = (model || "").trim();
  if (!raw) return null;
  const m = raw.toLowerCase();
  if (m === "n1" || m.includes("a1 mini") || m.includes("a1m")) return "N1";
  if (m === "n2s" || m === "a1" || m === "bambu lab a1") return "N2S";
  if (m === "c12" || m.includes("p1s")) return "C12";
  if (m === "c11" || m.includes("p1p")) return "C11";
  if (m === "c13" || m.includes("x1e")) return "C13";
  if (m === "bl-p001" || m.includes("x1c") || m.includes("x1 carbon") || m === "x1") return "BL-P001";
  if (m === "o1d" || m.includes("h2d")) return "O1D";
  if (m === "o1s" || m.includes("h2s")) return "O1S";
  if (m === "o1c2" || m.includes("h2c")) return "O1C2";
  if (/^[A-Za-z0-9][A-Za-z0-9-]{1,11}$/.test(raw)) return raw.toUpperCase();
  return null;
}

/**
 * OrcaSlicer CLI can emit an empty `<metadata key="printer_model_id" value=""/>` in
 * `Metadata/slice_info.config`. Bambu Cloud reads `printer_model_id` during project upload
 * processing to establish printer compatibility, so populate it while preserving every
 * other archive entry (including `Metadata/plate_1.gcode` and its `.md5`) byte-for-byte.
 */
export function ensureBambuPrinterModelId(zipBytes: Uint8Array, printerModel?: string | null): Uint8Array {
  const modelId = normalizeBambuModelId(printerModel);
  if (!modelId) return zipBytes;
  try {
    const entries = unzipSync(zipBytes);
    const sliceInfo = entries["Metadata/slice_info.config"];
    if (!sliceInfo) return zipBytes;
    const xml = new TextDecoder("utf-8").decode(sliceInfo);
    const emptyTagRe = /(<metadata\s+key="printer_model_id"\s+value=")("\s*\/>)/;
    if (!emptyTagRe.test(xml)) return zipBytes;
    const escaped = modelId.replace(/[&"<>\x00-\x1f]/g, "");
    const patchedXml = xml.replace(emptyTagRe, `$1${escaped}$2`);
    entries["Metadata/slice_info.config"] = new TextEncoder().encode(patchedXml);
    return zipSync(entries, { level: 6 });
  } catch {
    return zipBytes;
  }
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

async function putPresigned3MF(uploadUrl: string, bytes: Uint8Array, label: string): Promise<void> {
  const payload = new Uint8Array(bytes.byteLength);
  payload.set(bytes);
  // Omit Content-Type: Bambu S3 SigV2 presigned URLs sign an empty Content-Type ("").
  const putResp = await fetch("/bambu-upload", {
    method: "PUT",
    headers: {
      "X-Upload-Target": uploadUrl,
    },
    body: payload,
  });
  if (!putResp.ok) {
    const errText = await putResp.text().catch(() => "");
    throw new Error(`${label} upload failed (${putResp.status})${errText ? `: ${errText.slice(0, 160)}` : ""}`);
  }
}

function extractProjectPlateMeta(raw: unknown): {
  plateId: number | null;
  cover: string;
  plateName: string | null;
  nozzleDiameter: number | null;
} {
  let plateId: number | null = null;
  let cover = "";
  let plateName: string | null = null;
  let nozzleDiameter: number | null = null;
  if (!raw || typeof raw !== "object") return { plateId, cover, plateName, nozzleDiameter };
  const rec = raw as Record<string, unknown>;
  const profiles = Array.isArray(rec.profiles) ? (rec.profiles as Array<Record<string, unknown>>) : [];
  const profile = profiles[0];
  if (profile && typeof profile === "object") {
    const ctx =
      profile.context && typeof profile.context === "object"
        ? (profile.context as Record<string, unknown>)
        : null;
    const plates = Array.isArray(ctx?.plates) ? (ctx?.plates as Array<Record<string, unknown>>) : [];
    const plate = plates.find((p) => Number(p.index) === 1) || plates[0];
    if (plate) {
      const pid = asNum(plate.id ?? plate.plate_id ?? plate.plateId);
      if (pid !== null && pid > 0) plateId = Math.trunc(pid);
      if (typeof plate.name === "string" && plate.name.trim()) plateName = plate.name.trim();
      const thumb = plate.thumbnail;
      if (typeof thumb === "string" && thumb.startsWith("https://")) {
        cover = thumb;
      } else if (thumb && typeof thumb === "object") {
        const u = (thumb as Record<string, unknown>).url;
        if (typeof u === "string" && u.startsWith("https://")) cover = u;
      }
    }
    const compat =
      ctx?.compatibility && typeof ctx.compatibility === "object"
        ? (ctx.compatibility as Record<string, unknown>)
        : null;
    const nd = asNum(compat?.nozzleDiameter ?? compat?.nozzle_diameter);
    if (nd !== null && nd > 0) nozzleDiameter = nd;
  }
  return { plateId, cover, plateName, nozzleDiameter };
}

/**
 * Uploads a sliced .gcode.3mf to Bambu Cloud using the Bambu Cloud project/upload pipeline
 * (`iot-service/api/user/project` -> S3 PUT -> `notification` -> `iot-service/api/user/upload`
 * -> S3 PUT -> `PATCH project`) and submits a signed cloud print task via `POST user-service/my/task`.
 */
export async function sendSlicedPlateToBambuPrinter(params: SendBambuPrintParams): Promise<SendBambuPrintResult> {
  const safeName = params.fileName.endsWith(".3mf") ? params.fileName : `${params.fileName}.gcode.3mf`;
  const title = (params.subtaskName || safeName.replace(/\.gcode\.3mf$/i, "")).trim() || "Orca Cloud Print";
  const pollDelay = params.pollIntervalMs ?? 500;

  // Step 0: Ensure Metadata/slice_info.config has printer_model_id populated for Bambu Cloud compatibility
  const preparedBytes = ensureBambuPrinterModelId(params.job3mfBytes, params.printerModel);
  const archiveMd5Upper = md5Hex(preparedBytes).toUpperCase();

  // Step 1: Create Bambu Cloud project & profile slot
  params.onProgress?.("Creating Bambu Cloud project…");
  let projectRes: Record<string, unknown>;
  try {
    projectRes = await bambuFetchJson<Record<string, unknown>>(
      params.apiBase,
      "/v1/cloud/iot-service/api/user/project",
      {
        method: "POST",
        credential: params.credential,
        body: { name: title },
      }
    );
  } catch (err) {
    throw new Error(`Create cloud project failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const projectId = projectRes.project_id != null ? String(projectRes.project_id) : "";
  const modelId = typeof projectRes.model_id === "string" ? projectRes.model_id : "";
  const profileId = projectRes.profile_id != null ? String(projectRes.profile_id) : "";
  const profileUploadUrl = typeof projectRes.upload_url === "string" ? projectRes.upload_url : "";
  const uploadTicket = typeof projectRes.upload_ticket === "string" ? projectRes.upload_ticket : "";

  if (!projectId || !modelId || !profileId || !profileUploadUrl || !uploadTicket) {
    throw new Error("Bambu Cloud project creation returned incomplete upload metadata");
  }

  // Step 2: Upload profile .3mf to presigned S3 URL (empty Content-Type for SigV2)
  const sizeKb = (preparedBytes.byteLength / 1024).toFixed(0);
  params.onProgress?.(`Uploading ${safeName} (${sizeKb} KB) to Bambu Cloud (1/2)…`);
  await putPresigned3MF(profileUploadUrl, preparedBytes, "Profile 3MF");

  // Step 3: Notify Bambu Cloud and wait for archive parsing
  params.onProgress?.("Processing 3MF metadata in Bambu Cloud…");
  try {
    await bambuFetchJson<unknown>(params.apiBase, "/v1/cloud/iot-service/api/user/notification", {
      method: "PUT",
      credential: params.credential,
      body: {
        upload: {
          origin_file_name: safeName,
          ticket: uploadTicket,
        },
      },
    });
  } catch (err) {
    throw new Error(`Notify cloud upload failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const pollQs = new URLSearchParams({ action: "upload", ticket: uploadTicket }).toString();
  let processed = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    const statusRes = await bambuFetchJson<Record<string, unknown>>(
      params.apiBase,
      `/v1/cloud/iot-service/api/user/notification?${pollQs}`,
      { credential: params.credential }
    );
    const msg = String(statusRes.message || "").toLowerCase();
    if (msg === "success") {
      processed = true;
      break;
    }
    if (msg !== "running" && msg !== "pending" && msg !== "") {
      throw new Error(`Bambu Cloud upload processing failed (${statusRes.message || "unknown status"})`);
    }
    if (pollDelay > 0) {
      await new Promise((r) => setTimeout(r, pollDelay));
    }
  }
  if (!processed) {
    throw new Error("Timed out waiting for Bambu Cloud to process uploaded 3MF");
  }

  // Step 4: Request print-ready .3mf upload slot and upload the archive
  params.onProgress?.(`Uploading print plate (${sizeKb} KB) to Bambu Cloud (2/2)…`);
  const slotModelName = `${modelId}_${profileId}_1.3mf`;
  let uploadSlotRes: unknown;
  try {
    uploadSlotRes = await bambuFetchJson<unknown>(
      params.apiBase,
      `/v1/cloud/iot-service/api/user/upload?${new URLSearchParams({ models: slotModelName }).toString()}`,
      { credential: params.credential }
    );
  } catch (err) {
    throw new Error(`Request print upload slot failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const print3mfUrl = extractUploadUrls(uploadSlotRes).uploadUrl;
  if (!print3mfUrl) {
    throw new Error("Bambu Cloud did not return a presigned print-plate upload URL");
  }
  await putPresigned3MF(print3mfUrl, preparedBytes, "Print plate 3MF");

  // Step 5: Register the uploaded print-ready .3mf on the project
  params.onProgress?.("Registering print plate on Bambu Cloud…");
  try {
    await bambuFetchJson<unknown>(
      params.apiBase,
      `/v1/cloud/iot-service/api/user/project/${encodeURIComponent(projectId)}`,
      {
        method: "PATCH",
        credential: params.credential,
        body: {
          profile_id: profileId,
          profile_print_3mf: [
            {
              md5: archiveMd5Upper,
              plate_idx: 1,
              url: print3mfUrl,
            },
          ],
        },
      }
    );
  } catch (err) {
    throw new Error(`Register cloud print file failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Best-effort read back of parsed plate metadata (plateId, cover, plateName, nozzleDiameter)
  let parsedMeta = { plateId: null as number | null, cover: "", plateName: null as string | null, nozzleDiameter: null as number | null };
  try {
    const projDetails = await bambuFetchJson<unknown>(
      params.apiBase,
      `/v1/cloud/iot-service/api/user/project/${encodeURIComponent(projectId)}`,
      { credential: params.credential }
    );
    parsedMeta = extractProjectPlateMeta(projDetails);
  } catch {
    // non-fatal: proceed with defaults
  }

  // Step 6: Submit signed cloud print task via POST /v1/cloud/user-service/my/task
  params.onProgress?.("Starting cloud print task on printer…");
  const normalizedMapping = params.useAms
    ? params.amsMapping.length > 0
      ? params.amsMapping
      : [0]
    : [254];
  const amsMapping2 = normalizedMapping.map((slot) =>
    slot === 254 ? { amsId: 255, slotId: 0 } : { amsId: Math.floor(slot / 4), slotId: slot % 4 }
  );
  const nozzleDiameterNum = asNum(params.nozzleDiameter) ?? parsedMeta.nozzleDiameter;
  const profileIdNum = Number(profileId);

  const taskBody: Record<string, unknown> = {
    modelId,
    profileId: Number.isFinite(profileIdNum) ? profileIdNum : profileId,
    deviceId: params.serial,
    title,
    cover: parsedMeta.cover,
    plateIndex: 1,
    plateName: parsedMeta.plateName || params.plateName || "plate_1",
    mode: "cloud_file",
    useAms: params.useAms,
    amsMapping: normalizedMapping,
    amsMapping2,
    amsDetailMapping: [],
    filamentSettingIds: [],
    nozzleInfos: [],
    skipObjects: [],
    bedType: mapBedTypeToBambuParam(params.bedType),
    bedLeveling: params.bedLeveling,
    autoBedLeveling: params.bedLeveling ? 1 : 0,
    flowCali: params.flowCali,
    extrudeCaliFlag: params.flowCali ? 1 : 0,
    nozzleOffsetCali: 0,
    vibrationCali: params.vibrationCali,
    timelapse: params.timelapse,
    cfg: "0",
    isPublicProfile: false,
    repetitions: 1,
    jobType: 1,
    checkPreset: 1,
    enableFilamentDynamicMap: 0,
    hasFilamentSwitcher: 0,
  };
  if (parsedMeta.plateId !== null) {
    taskBody.plateId = parsedMeta.plateId;
  }
  if (nozzleDiameterNum !== null && nozzleDiameterNum > 0) {
    taskBody.nozzleDiameter = nozzleDiameterNum;
  }

  try {
    const taskRes = await bambuFetchJson<Record<string, unknown>>(
      params.apiBase,
      "/v1/cloud/user-service/my/task",
      {
        method: "POST",
        credential: params.credential,
        body: taskBody,
      }
    );
    const taskIdRaw = taskRes.task_id ?? taskRes.taskId ?? taskRes.id;
    return {
      taskId: taskIdRaw != null ? String(taskIdRaw) : undefined,
      projectId,
      modelId,
      profileId,
      result: typeof taskRes.message === "string" ? taskRes.message : "success",
    };
  } catch (err) {
    throw new Error(
      `Start cloud print task failed (uploaded to project #${projectId}): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}
