import type {
  BackendHealth,
  BedType,
  CompatibleProfilesResponse,
  MachineModelInfo,
  OrcaSettingsMap,
  ProfileRef,
  ProfileSummary,
  SliceJobRecord,
  VendorSummary,
} from "../types";

export interface ApiClientConfig {
  baseUrl: string;
  bearerToken?: string;
}

let apiConfig: ApiClientConfig = {
  baseUrl: "/api",
};

export function setApiConfig(next: Partial<ApiClientConfig>) {
  apiConfig = { ...apiConfig, ...next };
}

export function getApiConfig(): ApiClientConfig {
  return { ...apiConfig };
}

function buildHeaders(extra?: Record<string, string>): HeadersInit {
  const headers: Record<string, string> = { ...(extra || {}) };
  if (apiConfig.bearerToken?.trim()) {
    headers["Authorization"] = `Bearer ${apiConfig.bearerToken.trim()}`;
  }
  return headers;
}

function urlFor(path: string): string {
  const base = apiConfig.baseUrl.replace(/\/+$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(urlFor(path), {
    ...init,
    headers: buildHeaders(init?.headers as Record<string, string> | undefined),
  });
  const text = await resp.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text || `HTTP ${resp.status}` };
  }
  if (!resp.ok) {
    const errObj = data as { error?: string; issues?: Array<{ message: string; field?: string }> } | null;
    const detail = errObj?.issues?.length
      ? `${errObj.error || "Validation error"}: ${errObj.issues.map((i) => i.message).join("; ")}`
      : errObj?.error || `Request failed (${resp.status})`;
    throw new Error(detail);
  }
  return data as T;
}

export async function getHealth(): Promise<BackendHealth> {
  return fetchJson<BackendHealth>("/healthz");
}

export async function getVendors(): Promise<{ vendors: VendorSummary[] }> {
  return fetchJson<{ vendors: VendorSummary[] }>("/v2/profiles/vendors");
}

export async function searchProfiles(params: {
  kind?: "machine" | "process" | "filament";
  vendor?: string;
  q?: string;
  instantiable?: boolean;
  offset?: number;
  limit?: number;
}): Promise<{ profiles: ProfileSummary[]; total: number; offset: number; limit: number }> {
  const qs = new URLSearchParams();
  if (params.kind) qs.set("kind", params.kind);
  if (params.vendor) qs.set("vendor", params.vendor);
  if (params.q) qs.set("q", params.q);
  if (params.instantiable !== undefined) qs.set("instantiable", String(params.instantiable));
  if (params.offset !== undefined) qs.set("offset", String(params.offset));
  if (params.limit !== undefined) qs.set("limit", String(params.limit));
  return fetchJson(`/v2/profiles?${qs.toString()}`);
}

export async function getProfileDetail(params: {
  vendor: string;
  kind: "machine" | "process" | "filament";
  name: string;
}): Promise<{
  vendor: string;
  kind: string;
  name: string;
  settings: OrcaSettingsMap;
  build_volume_mm?: [number, number, number];
  printable_area_polygon?: [number, number][];
  bed_exclude_area_polygon?: [number, number][];
  machine_model?: MachineModelInfo;
}> {
  const qs = new URLSearchParams({
    vendor: params.vendor,
    kind: params.kind,
    name: params.name,
  });
  return fetchJson(`/v2/profiles/detail?${qs.toString()}`);
}

export async function getCompatibleProfiles(params: {
  vendor: string;
  machine: string;
}): Promise<CompatibleProfilesResponse> {
  const qs = new URLSearchParams({
    vendor: params.vendor,
    machine: params.machine,
  });
  return fetchJson<CompatibleProfilesResponse>(`/v2/profiles/compatible?${qs.toString()}`);
}

export interface NativeSettingsCatalog {
  settings: Record<string, { classification: string; native_default: string | string[] | null }>;
  limitations: string[];
}

let cachedSettingsCatalog: NativeSettingsCatalog | null = null;
export async function getNativeSettingsCatalog(): Promise<NativeSettingsCatalog> {
  if (cachedSettingsCatalog) return cachedSettingsCatalog;
  const res = await fetchJson<NativeSettingsCatalog>("/v2/settings");
  cachedSettingsCatalog = res;
  return res;
}

export interface SliceConfigurationPayload {
  printer: { profile: ProfileRef; overrides?: OrcaSettingsMap };
  process: { profile: ProfileRef; overrides?: OrcaSettingsMap };
  filament?: { profile: ProfileRef; overrides?: OrcaSettingsMap };
  filaments?: Array<{ profile: ProfileRef; overrides?: OrcaSettingsMap }>;
  bed_type: BedType;
  placement?: "arrange" | "preserve_xy";
}

export async function createConfiguration(
  payload: SliceConfigurationPayload
): Promise<{ id: string; build_volume_mm: [number, number, number]; resolved: Record<string, OrcaSettingsMap> }> {
  return fetchJson("/v2/configurations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function submitSliceJob(
  configurationId: string,
  payloadBytes: Uint8Array,
  format: "stl" | "3mf"
): Promise<SliceJobRecord> {
  const contentType = format === "3mf" ? "model/3mf" : "model/stl";
  const body = new Blob([payloadBytes.buffer as ArrayBuffer], { type: contentType });
  return fetchJson<SliceJobRecord>(`/v2/jobs?configuration=${encodeURIComponent(configurationId)}`, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body,
  });
}

export async function getJob(jobId: string): Promise<SliceJobRecord> {
  return fetchJson<SliceJobRecord>(`/v1/jobs/${encodeURIComponent(jobId)}`);
}

export async function downloadGcode(jobId: string, plate = 1): Promise<string> {
  const resp = await fetch(urlFor(`/v1/jobs/${encodeURIComponent(jobId)}/gcode?plate=${plate}`), {
    headers: buildHeaders(),
  });
  if (!resp.ok) {
    throw new Error(`Failed to download G-code (${resp.status})`);
  }
  return resp.text();
}

export async function download3mf(jobId: string): Promise<Blob> {
  const resp = await fetch(urlFor(`/v1/jobs/${encodeURIComponent(jobId)}/3mf`), {
    headers: buildHeaders(),
  });
  if (!resp.ok) {
    throw new Error(`Failed to download 3MF (${resp.status})`);
  }
  return resp.blob();
}

export async function nativeMeshRepair(stlBytes: Uint8Array): Promise<Uint8Array> {
  const resp = await fetch(urlFor("/v2/mesh/repair"), {
    method: "POST",
    headers: buildHeaders({ "Content-Type": "model/stl" }),
    body: new Blob([stlBytes.buffer as ArrayBuffer], { type: "model/stl" }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
    throw new Error(err.error || "Mesh repair failed");
  }
  return new Uint8Array(await resp.arrayBuffer());
}

export async function nativeMeshAutoOrient(stlBytes: Uint8Array): Promise<Uint8Array> {
  const resp = await fetch(urlFor("/v2/mesh/auto-orient"), {
    method: "POST",
    headers: buildHeaders({ "Content-Type": "model/stl" }),
    body: new Blob([stlBytes.buffer as ArrayBuffer], { type: "model/stl" }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
    throw new Error(err.error || "Auto-orient failed");
  }
  return new Uint8Array(await resp.arrayBuffer());
}
