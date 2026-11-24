import type {
  BedType,
  FilamentSlot,
  OrcaSettingsMap,
  Plate,
  ProfileRef,
  SceneObject,
  SubPart,
} from "../types";
import { buildGeometryData } from "./geometry";

const DB_NAME = "orca-cloud-workspace-v1";
const STORE_NAME = "projects";
const RECORD_KEY = "active";

interface SerializedSubPart {
  id: string;
  name: string;
  subtype: SubPart["subtype"];
  positions: ArrayBuffer;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  overrides: OrcaSettingsMap;
  filamentIndex?: number;
}

interface SerializedObject {
  id: string;
  name: string;
  positions: ArrayBuffer;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  visible: boolean;
  filamentIndex: number;
  overrides: OrcaSettingsMap;
  subParts: SerializedSubPart[];
  paintSupport?: ArrayBuffer;
  paintSeam?: ArrayBuffer;
  paintColor?: ArrayBuffer;
  variableLayers?: SceneObject["variableLayers"];
}

interface SerializedPlate {
  id: string;
  name: string;
  locked: boolean;
  objects: SerializedObject[];
}

export interface PersistedWorkspace {
  version: 1;
  savedAt: number;
  printer: ProfileRef;
  printerOverrides: OrcaSettingsMap;
  process: ProfileRef;
  processOverrides: OrcaSettingsMap;
  bedType: BedType;
  filaments: FilamentSlot[];
  flushMatrix: number[][];
  plates: SerializedPlate[];
  activePlateId: string;
  backendUrl?: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) {
        req.result.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function copyBuffer(typed: Float32Array | Uint8Array): ArrayBuffer {
  return typed.buffer.slice(typed.byteOffset, typed.byteOffset + typed.byteLength) as ArrayBuffer;
}

export function serializePlates(plates: Plate[]): SerializedPlate[] {
  return plates.map((p) => ({
    id: p.id,
    name: p.name,
    locked: p.locked,
    objects: p.objects.map((o) => ({
      id: o.id,
      name: o.name,
      positions: copyBuffer(o.geometry.positions),
      position: o.position,
      rotation: o.rotation,
      scale: o.scale,
      visible: o.visible,
      filamentIndex: o.filamentIndex,
      overrides: o.overrides,
      subParts: o.subParts.map((sp) => ({
        id: sp.id,
        name: sp.name,
        subtype: sp.subtype,
        positions: copyBuffer(sp.geometry.positions),
        position: sp.position,
        rotation: sp.rotation,
        scale: sp.scale,
        overrides: sp.overrides,
        filamentIndex: sp.filamentIndex,
      })),
      paintSupport: o.paintSupport ? copyBuffer(o.paintSupport) : undefined,
      paintSeam: o.paintSeam ? copyBuffer(o.paintSeam) : undefined,
      paintColor: o.paintColor ? copyBuffer(o.paintColor) : undefined,
      variableLayers: o.variableLayers,
    })),
  }));
}

export function deserializePlates(raw: SerializedPlate[]): Plate[] {
  return raw.map((p) => ({
    id: p.id,
    name: p.name,
    locked: Boolean(p.locked),
    objects: (p.objects || []).map((o) => ({
      id: o.id,
      name: o.name,
      geometry: buildGeometryData(new Float32Array(o.positions)),
      position: o.position,
      rotation: o.rotation,
      scale: o.scale,
      visible: o.visible !== false,
      filamentIndex: o.filamentIndex ?? 0,
      overrides: o.overrides || {},
      subParts: (o.subParts || []).map((sp) => ({
        id: sp.id,
        name: sp.name,
        subtype: sp.subtype,
        geometry: buildGeometryData(new Float32Array(sp.positions)),
        position: sp.position,
        rotation: sp.rotation,
        scale: sp.scale,
        overrides: sp.overrides || {},
        filamentIndex: sp.filamentIndex,
      })),
      paintSupport: o.paintSupport ? new Uint8Array(o.paintSupport) : undefined,
      paintSeam: o.paintSeam ? new Uint8Array(o.paintSeam) : undefined,
      paintColor: o.paintColor ? new Uint8Array(o.paintColor) : undefined,
      variableLayers: o.variableLayers,
    })),
  }));
}

export async function saveWorkspaceLocal(data: PersistedWorkspace): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(data, RECORD_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Non-fatal in private browsing or quota-limited environments
  }
}

export async function loadWorkspaceLocal(): Promise<PersistedWorkspace | null> {
  if (typeof indexedDB === "undefined") return null;
  try {
    const db = await openDb();
    const result = await new Promise<PersistedWorkspace | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(RECORD_KEY);
      req.onsuccess = () => resolve((req.result as PersistedWorkspace) || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return result;
  } catch {
    return null;
  }
}

export async function clearWorkspaceLocal(): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(RECORD_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // ignore
  }
}
