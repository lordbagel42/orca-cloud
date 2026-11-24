import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BackendHealth,
  BedType,
  CompatibleProfilesResponse,
  FilamentSlot,
  GeometryData,
  MachineModelInfo,
  OrcaSettingsMap,
  OrcaValue,
  ParsedGcode,
  Plate,
  PrepareTool,
  PreviewColorScheme,
  ProfileRef,
  SceneObject,
  SettingTabId,
  SliceJobRecord,
  SubPart,
  SubPartType,
  WorkspaceTab,
} from "../types";
import {
  createConfiguration,
  download3mf,
  downloadGcode,
  getApiConfig,
  getCompatibleProfiles,
  getHealth,
  getJob,
  getProfileDetail,
  nativeMeshAutoOrient,
  nativeMeshRepair,
  setApiConfig,
  stageMeshSTL,
  submitSliceJob,
  submitStagedSliceJob,
} from "../lib/api";
import {
  arrangeObjectsOnBed,
  createPrimitiveGeometry,
  createTextGeometry,
  cutGeometryAtZ,
  exportBinarySTL,
  exportPlateToBinarySTL,
  getObjectMatrix,
  groundObjectPosition,
  mirrorGeometry,
  parseOBJ,
  parseSTL,
  type PrimitiveKind,
  splitDisconnectedShells,
  transformPositions,
  uid,
} from "../lib/geometry";
import { createSubPart, exportPlateTo3MF, parse3MF } from "../lib/threemf";
import { ALL_FEATURE_TYPES, parseGcode } from "../lib/gcode";
import {
  deserializePlates,
  loadWorkspaceLocal,
  saveWorkspaceLocal,
  serializePlates,
} from "../lib/storage";
import { FILAMENT_SWATCH_PALETTE } from "../lib/settingsSchema";
import { generateCalibrationModel, type CalibrationId } from "../lib/calibration";

const DEFAULT_PRINTER: ProfileRef = {
  vendor: "BBL",
  name: "Bambu Lab A1 mini 0.4 nozzle",
};
const DEFAULT_PROCESS: ProfileRef = {
  vendor: "BBL",
  name: "0.20mm Standard @BBL A1M",
};
const DEFAULT_FILAMENT: ProfileRef = {
  vendor: "BBL",
  name: "Bambu PLA Basic @BBL A1M",
};
const DEFAULT_A1M_MODEL: MachineModelInfo = {
  name: "Bambu Lab A1 mini",
  vendor: "BBL",
  family: "BBL-3DP",
  model_id: "N1",
  bed_model: "bbl-3dp-A1M.stl",
  bed_texture: "bbl-3dp-logo.svg",
  hotend_model: "bbl-3dp-hotend.stl",
  bed_model_url: "/v2/assets/BBL/bbl-3dp-A1M.stl",
  bed_texture_url: "/v2/assets/BBL/bbl-3dp-logo.svg",
  hotend_model_url: "/v2/assets/BBL/bbl-3dp-hotend.stl",
  default_bed_type: "Textured PEI Plate",
  not_support_bed_types: ["Cool Plate", "Engineering Plate"],
  nozzle_diameters: ["0.4", "0.2", "0.6", "0.8"],
  default_materials: [],
};

interface HistorySnapshot {
  plates: Plate[];
  activePlateId: string;
  selectedObjectId: string | null;
  selectedSubPartId: string | null;
}

export interface ToastNotice {
  id: number;
  message: string;
  kind: "info" | "error" | "success";
}

function makeDefaultPlate(): Plate {
  return {
    id: "plate-1",
    name: "Plate 1",
    locked: false,
    objects: [],
  };
}

function makeDefaultFilaments(): FilamentSlot[] {
  return [
    {
      id: "fil-1",
      profile: { ...DEFAULT_FILAMENT },
      color: "#22c55e",
      overrides: {},
    },
  ];
}

export function useWorkspace() {
  const [tab, setTab] = useState<WorkspaceTab>("prepare");
  const [sidebarOpen, setSidebarOpen] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth >= 960 : true
  );
  useEffect(() => {
    const onResize = () => {
      if (window.innerWidth < 960) setSidebarOpen(false);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const [processScope, setProcessScope] = useState<"global" | "objects">("global");
  const [settingTab, setSettingTab] = useState<SettingTabId>("quality");
  const [advancedMode, setAdvancedMode] = useState(false);

  // Profiles & Settings
  const [printer, setPrinter] = useState<ProfileRef>(DEFAULT_PRINTER);
  const [printerSettings, setPrinterSettings] = useState<OrcaSettingsMap>({});
  const [printerOverrides, setPrinterOverrides] = useState<OrcaSettingsMap>({});
  const [buildVolume, setBuildVolume] = useState<[number, number, number]>([180, 180, 180]);
  const [bedExcludeArea, setBedExcludeArea] = useState<[number, number][]>([]);
  const [machineModel, setMachineModel] = useState<MachineModelInfo | null>(DEFAULT_A1M_MODEL);
  const [compatibleProfiles, setCompatibleProfiles] = useState<CompatibleProfilesResponse | null>(null);
  const autoApplyDefaultsRef = useRef(false);

  const [process, setProcess] = useState<ProfileRef>(DEFAULT_PROCESS);
  const [processSettings, setProcessSettings] = useState<OrcaSettingsMap>({});
  const [processOverrides, setProcessOverrides] = useState<OrcaSettingsMap>({});

  const [bedType, setBedType] = useState<BedType>("Textured PEI Plate");
  const [filaments, setFilaments] = useState<FilamentSlot[]>(makeDefaultFilaments);
  const [flushMatrix, setFlushMatrix] = useState<number[][]>([[0]]);

  // Plates & Objects
  const [plates, setPlates] = useState<Plate[]>([makeDefaultPlate()]);
  const [activePlateId, setActivePlateId] = useState<string>("plate-1");
  const [selectedObjectId, setSelectedObjectId] = useState<string | null>(null);
  const [selectedSubPartId, setSelectedSubPartId] = useState<string | null>(null);

  // Prepare Tools
  const [tool, setTool] = useState<PrepareTool>("select");
  const [showOverhangs, setShowOverhangs] = useState(false);
  const [wireframe, setWireframe] = useState(false);
  const [cutHeight, setCutHeight] = useState<number>(10);
  const [paintMode, setPaintMode] = useState<"enforce" | "block" | "erase">("enforce");
  const [paintBrushRadius, setPaintBrushRadius] = useState<number>(3.5);
  const [paintFilamentIndex, setPaintFilamentIndex] = useState<number>(0);
  const [measurePoints, setMeasurePoints] = useState<Array<[number, number, number]>>([]);

  // Undo / Redo (up to 50 snapshots)
  const undoStack = useRef<HistorySnapshot[]>([]);
  const redoStack = useRef<HistorySnapshot[]>([]);
  const [historyVersion, setHistoryVersion] = useState(0);

  // Backend & Slicing State
  const [health, setHealth] = useState<BackendHealth | null>(null);
  const [backendOnline, setBackendOnline] = useState(false);
  const [backendUrl, setBackendUrl] = useState(getApiConfig().baseUrl);
  const [bearerToken, setBearerToken] = useState("");
  const [slicing, setSlicing] = useState(false);
  const [sliceStatusText, setSliceStatusText] = useState("");
  const [currentJob, setCurrentJob] = useState<SliceJobRecord | null>(null);
  const [parsedGcode, setParsedGcode] = useState<ParsedGcode | null>(null);
  const [sliceStale, setSliceStale] = useState(false);

  // Preview Controls
  const [colorScheme, setColorScheme] = useState<PreviewColorScheme>("line_type");
  const [layerTop, setLayerTop] = useState<number>(0);
  const [layerBottom, setLayerBottom] = useState<number>(0);
  const [moveIndex, setMoveIndex] = useState<number>(0);
  const [hiddenFeatures, setHiddenFeatures] = useState<Set<string>>(() => new Set(["Travel"]));
  const [showRetractions, setShowRetractions] = useState(false);
  const [showSeams, setShowSeams] = useState(true);
  const [showNozzle, setShowNozzle] = useState(true);
  const [showGhost, setShowGhost] = useState(false);
  const [realisticGloss, setRealisticGloss] = useState(true);
  const [dimLowerLayers, setDimLowerLayers] = useState(false);
  const [sectionCutEnabled, setSectionCutEnabled] = useState(false);
  const [sectionCutAxis, setSectionCutAxis] = useState<"x" | "y" | "z">("y");
  const [sectionCutPosition, setSectionCutPosition] = useState<number>(90);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playSpeed, setPlaySpeed] = useState<number>(8);

  // Toast
  const [toast, setToast] = useState<ToastNotice | null>(null);
  const toastTimer = useRef<number | null>(null);
  const hydrated = useRef(false);

  const notify = useCallback((message: string, kind: ToastNotice["kind"] = "info") => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    setToast({ id: Date.now(), message, kind });
    toastTimer.current = window.setTimeout(() => setToast(null), kind === "error" ? 9000 : 4200);
  }, []);

  const activePlate = plates.find((p) => p.id === activePlateId) || plates[0];
  const selectedObject = activePlate?.objects.find((o) => o.id === selectedObjectId) || null;
  const selectedSubPart = selectedObject?.subParts.find((s) => s.id === selectedSubPartId) || null;

  const pushHistory = useCallback(() => {
    undoStack.current.push({
      plates,
      activePlateId,
      selectedObjectId,
      selectedSubPartId,
    });
    if (undoStack.current.length > 50) undoStack.current.shift();
    redoStack.current = [];
    setHistoryVersion((v) => v + 1);
    setSliceStale(true);
  }, [plates, activePlateId, selectedObjectId, selectedSubPartId]);

  const undo = useCallback(() => {
    const prev = undoStack.current.pop();
    if (!prev) return;
    redoStack.current.push({ plates, activePlateId, selectedObjectId, selectedSubPartId });
    setPlates(prev.plates);
    setActivePlateId(prev.activePlateId);
    setSelectedObjectId(prev.selectedObjectId);
    setSelectedSubPartId(prev.selectedSubPartId);
    setHistoryVersion((v) => v + 1);
    setSliceStale(true);
  }, [plates, activePlateId, selectedObjectId, selectedSubPartId]);

  const redo = useCallback(() => {
    const next = redoStack.current.pop();
    if (!next) return;
    undoStack.current.push({ plates, activePlateId, selectedObjectId, selectedSubPartId });
    setPlates(next.plates);
    setActivePlateId(next.activePlateId);
    setSelectedObjectId(next.selectedObjectId);
    setSelectedSubPartId(next.selectedSubPartId);
    setHistoryVersion((v) => v + 1);
    setSliceStale(true);
  }, [plates, activePlateId, selectedObjectId, selectedSubPartId]);

  // Health polling & profile hydration
  const refreshHealth = useCallback(async () => {
    try {
      const h = await getHealth();
      setHealth(h);
      setBackendOnline(h.status === "ok");
    } catch {
      setBackendOnline(false);
    }
  }, []);

  useEffect(() => {
    refreshHealth();
    const id = window.setInterval(refreshHealth, 20000);
    return () => window.clearInterval(id);
  }, [refreshHealth]);

  // Hydrate persisted IndexedDB project on mount
  useEffect(() => {
    (async () => {
      const saved = await loadWorkspaceLocal();
      if (saved && saved.plates?.length) {
        setPrinter(saved.printer || DEFAULT_PRINTER);
        setPrinterOverrides(saved.printerOverrides || {});
        setProcess(saved.process || DEFAULT_PROCESS);
        setProcessOverrides(saved.processOverrides || {});
        setBedType(saved.bedType || "Textured PEI Plate");
        if (saved.filaments?.length) setFilaments(saved.filaments);
        if (saved.flushMatrix?.length) setFlushMatrix(saved.flushMatrix);
        const restoredPlates = deserializePlates(saved.plates);
        setPlates(restoredPlates);
        setActivePlateId(saved.activePlateId || restoredPlates[0].id);
        if (saved.backendUrl) {
          setBackendUrl(saved.backendUrl);
          setApiConfig({ baseUrl: saved.backendUrl });
        }
      }
      hydrated.current = true;
    })();
  }, []);

  // Autosave to IndexedDB (debounced)
  useEffect(() => {
    if (!hydrated.current) return;
    const t = window.setTimeout(() => {
      saveWorkspaceLocal({
        version: 1,
        savedAt: Date.now(),
        printer,
        printerOverrides,
        process,
        processOverrides,
        bedType,
        filaments: filaments.map((f) => ({ ...f, resolvedSettings: undefined })),
        flushMatrix,
        plates: serializePlates(plates),
        activePlateId,
        backendUrl,
      });
    }, 600);
    return () => window.clearTimeout(t);
  }, [printer, printerOverrides, process, processOverrides, bedType, filaments, flushMatrix, plates, activePlateId, backendUrl]);

  // Load compatible profiles, machine model assets, build volume, and exclusion area whenever printer changes
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const compat = await getCompatibleProfiles({ vendor: printer.vendor, machine: printer.name });
        if (cancelled) return;
        setCompatibleProfiles(compat);
        setPrinterSettings(compat.settings);
        setBuildVolume(compat.build_volume_mm);
        setBedExcludeArea(compat.bed_exclude_area_polygon || []);
        setMachineModel(compat.machine_model || null);

        if (autoApplyDefaultsRef.current) {
          autoApplyDefaultsRef.current = false;
          if (compat.default_print_profile) {
            setProcess({ vendor: compat.vendor, name: compat.default_print_profile });
            setProcessOverrides({});
          } else if (compat.processes.length > 0) {
            setProcess({ vendor: compat.processes[0].vendor, name: compat.processes[0].name });
            setProcessOverrides({});
          }
          const defFil = compat.default_filament_profile || compat.filaments[0]?.name;
          if (defFil) {
            const filMatch = compat.filaments.find((f) => f.name === defFil);
            const filVendor = filMatch?.vendor || compat.vendor;
            setFilaments((prev) =>
              prev.map((slot) => ({
                ...slot,
                profile: { vendor: filVendor, name: defFil },
                overrides: {},
              }))
            );
          }
          const defBed = compat.machine_model?.default_bed_type as BedType | undefined;
          if (defBed) setBedType(defBed);
          setSliceStale(true);
        }
      } catch {
        // Fallback to getProfileDetail if compatible endpoint unavailable
        try {
          const detail = await getProfileDetail({ vendor: printer.vendor, kind: "machine", name: printer.name });
          if (cancelled) return;
          setPrinterSettings(detail.settings);
          if (detail.build_volume_mm) setBuildVolume(detail.build_volume_mm);
          if (detail.bed_exclude_area_polygon) setBedExcludeArea(detail.bed_exclude_area_polygon);
          if (detail.machine_model) setMachineModel(detail.machine_model);
        } catch {
          // Keep current defaults if offline
        }
      }
    })();
    return () => { cancelled = true; };
  }, [printer]);

  const selectPrinter = useCallback((next: ProfileRef) => {
    autoApplyDefaultsRef.current = true;
    setPrinter(next);
    setPrinterOverrides({});
  }, []);

  // Load flattened process profile detail whenever process changes
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const detail = await getProfileDetail({ vendor: process.vendor, kind: "process", name: process.name });
        if (cancelled) return;
        setProcessSettings(detail.settings);
      } catch {
        // Keep current
      }
    })();
    return () => { cancelled = true; };
  }, [process]);

  // Eager background STL staging into native OrcaSlicer (/v2/meshes) keyed by geometry positions array
  const stagedMeshPromisesRef = useRef<WeakMap<Float32Array, Promise<string | null>>>(new WeakMap());
  const stagedMeshIdsRef = useRef<WeakMap<Float32Array, string>>(new WeakMap());

  const ensureGeometryStaged = useCallback(
    (geometry: GeometryData): Promise<string | null> => {
      if (!health?.capabilities?.staged_meshes) return Promise.resolve(null);
      const pos = geometry.positions;
      const existingId = stagedMeshIdsRef.current.get(pos);
      if (existingId) return Promise.resolve(existingId);
      const inFlight = stagedMeshPromisesRef.current.get(pos);
      if (inFlight) return inFlight;

      setPlates((prev) =>
        prev.map((p) =>
          p.objects.some((o) => o.geometry.positions === pos && o.meshSyncState !== "syncing")
            ? {
                ...p,
                objects: p.objects.map((o) =>
                  o.geometry.positions === pos ? { ...o, meshSyncState: "syncing" } : o
                ),
              }
            : p
        )
      );

      const promise = (async (): Promise<string | null> => {
        try {
          const stlBytes = exportBinarySTL(pos);
          const res = await stageMeshSTL(stlBytes);
          stagedMeshIdsRef.current.set(pos, res.mesh_id);
          setPlates((prev) =>
            prev.map((p) =>
              p.objects.some((o) => o.geometry.positions === pos)
                ? {
                    ...p,
                    objects: p.objects.map((o) =>
                      o.geometry.positions === pos
                        ? { ...o, remoteMeshId: res.mesh_id, meshSyncState: "synced" }
                        : o
                    ),
                  }
                : p
            )
          );
          return res.mesh_id;
        } catch {
          stagedMeshPromisesRef.current.delete(pos);
          setPlates((prev) =>
            prev.map((p) =>
              p.objects.some((o) => o.geometry.positions === pos)
                ? {
                    ...p,
                    objects: p.objects.map((o) =>
                      o.geometry.positions === pos ? { ...o, meshSyncState: "local" } : o
                    ),
                  }
                : p
            )
          );
          return null;
        }
      })();

      stagedMeshPromisesRef.current.set(pos, promise);
      return promise;
    },
    [health?.capabilities?.staged_meshes]
  );

  // Automatically stage any newly imported, added, repaired, split, or restored geometry in the background
  useEffect(() => {
    if (!health?.capabilities?.staged_meshes) return;
    for (const plate of plates) {
      for (const obj of plate.objects) {
        const pos = obj.geometry.positions;
        if (!stagedMeshIdsRef.current.has(pos) && !stagedMeshPromisesRef.current.has(pos)) {
          void ensureGeometryStaged(obj.geometry);
        } else {
          const knownId = stagedMeshIdsRef.current.get(pos);
          if (knownId && obj.remoteMeshId !== knownId) {
            setPlates((prev) =>
              prev.map((p) => ({
                ...p,
                objects: p.objects.map((o) =>
                  o.geometry.positions === pos
                    ? { ...o, remoteMeshId: knownId, meshSyncState: "synced" }
                    : o
                ),
              }))
            );
          }
        }
      }
    }
  }, [plates, health?.capabilities?.staged_meshes, ensureGeometryStaged]);

  // Update backend connection settings
  const updateBackendConnection = useCallback((url: string, token: string) => {
    const clean = url.trim() || "/api";
    setBackendUrl(clean);
    setBearerToken(token);
    setApiConfig({ baseUrl: clean, bearerToken: token });
    stagedMeshIdsRef.current = new WeakMap();
    stagedMeshPromisesRef.current = new WeakMap();
    setTimeout(() => refreshHealth(), 50);
  }, [refreshHealth]);

  // Helper to update objects on active plate
  const updateActivePlateObjects = useCallback(
    (updater: (objs: SceneObject[]) => SceneObject[], recordHistory = true) => {
      if (recordHistory) pushHistory();
      else setSliceStale(true);
      setPlates((prev) =>
        prev.map((p) => (p.id === activePlate.id ? { ...p, objects: updater(p.objects) } : p))
      );
    },
    [activePlate?.id, pushHistory]
  );

  // Add a GeometryData as a new SceneObject on the active plate
  const addObjectFromGeometry = useCallback(
    (name: string, geometry: GeometryData, preferredXY?: [number, number], filamentIdx = 0) => {
      const cx = preferredXY ? preferredXY[0] : buildVolume[0] / 2;
      const cy = preferredXY ? preferredXY[1] : buildVolume[1] / 2;
      const newObj: SceneObject = {
        id: uid("obj"),
        name,
        geometry,
        position: [Number(cx.toFixed(2)), Number(cy.toFixed(2)), 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        visible: true,
        filamentIndex: Math.min(filamentIdx, Math.max(0, filaments.length - 1)),
        overrides: {},
        subParts: [],
      };
      updateActivePlateObjects((objs) => [...objs, newObj]);
      setSelectedObjectId(newObj.id);
      setSelectedSubPartId(null);
      setCutHeight(Number((geometry.bounds.size[2] / 2).toFixed(2)));
      return newObj;
    },
    [buildVolume, filaments.length, updateActivePlateObjects]
  );

  const addPrimitive = useCallback(
    (kind: PrimitiveKind, size = 25) => {
      const names: Record<PrimitiveKind, string> = {
        cube: "Cube",
        cylinder: "Cylinder",
        sphere: "Sphere",
        cone: "Cone",
        torus: "Torus",
        disc: "Disc",
        calibration_cube: "Calibration Cube 20mm",
        benchy_test: "Overhang Boat Test",
      };
      const geom = createPrimitiveGeometry(kind, size);
      addObjectFromGeometry(names[kind], geom);
      notify(`Added ${names[kind]} to ${activePlate.name}`, "success");
    },
    [activePlate?.name, addObjectFromGeometry, notify]
  );

  const addTextEmboss = useCallback(
    (text: string, heightMm: number, depthMm: number) => {
      const geom = createTextGeometry(text, heightMm, depthMm);
      addObjectFromGeometry(`Text "${text.trim() || "ORCA"}"`, geom);
      notify(`Added embossed text "${text.trim() || "ORCA"}"`, "success");
    },
    [addObjectFromGeometry, notify]
  );

  const importFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files);
      let imported = 0;
      for (const file of list) {
        const lower = file.name.toLowerCase();
        try {
          if (lower.endsWith(".stl")) {
            const buf = await file.arrayBuffer();
            const geom = parseSTL(buf);
            addObjectFromGeometry(file.name.replace(/\.stl$/i, ""), geom);
            imported++;
          } else if (lower.endsWith(".obj")) {
            const txt = await file.text();
            const geom = parseOBJ(txt);
            addObjectFromGeometry(file.name.replace(/\.obj$/i, ""), geom);
            imported++;
          } else if (lower.endsWith(".3mf")) {
            const buf = await file.arrayBuffer();
            const items = parse3MF(buf, file.name.replace(/\.3mf$/i, ""));
            for (const item of items) {
              const withinBed =
                item.worldCenterXY[0] >= 5 &&
                item.worldCenterXY[0] <= buildVolume[0] - 5 &&
                item.worldCenterXY[1] >= 5 &&
                item.worldCenterXY[1] <= buildVolume[1] - 5;
              addObjectFromGeometry(
                item.name,
                item.geometry,
                withinBed ? item.worldCenterXY : undefined,
                item.filamentIndex
              );
              imported++;
            }
          } else {
            notify(`Unsupported file format: ${file.name} (use STL, OBJ, or 3MF)`, "error");
          }
        } catch (err) {
          notify(`Failed to import ${file.name}: ${err instanceof Error ? err.message : String(err)}`, "error");
        }
      }
      if (imported > 0) {
        setTab("prepare");
        notify(`Imported ${imported} model${imported > 1 ? "s" : ""}`, "success");
      }
    },
    [addObjectFromGeometry, buildVolume, notify]
  );

  const updateObject = useCallback(
    (objectId: string, patch: Partial<SceneObject>, recordHistory = true) => {
      updateActivePlateObjects(
        (objs) => objs.map((o) => (o.id === objectId ? { ...o, ...patch } : o)),
        recordHistory
      );
    },
    [updateActivePlateObjects]
  );

  const deleteSelected = useCallback(() => {
    if (!selectedObjectId) return;
    if (selectedSubPartId) {
      updateActivePlateObjects((objs) =>
        objs.map((o) =>
          o.id === selectedObjectId
            ? { ...o, subParts: o.subParts.filter((s) => s.id !== selectedSubPartId) }
            : o
        )
      );
      setSelectedSubPartId(null);
      return;
    }
    updateActivePlateObjects((objs) => objs.filter((o) => o.id !== selectedObjectId));
    setSelectedObjectId(null);
  }, [selectedObjectId, selectedSubPartId, updateActivePlateObjects]);

  const deleteAllObjectsOnPlate = useCallback(() => {
    if (activePlate.objects.length === 0) return;
    updateActivePlateObjects(() => []);
    setSelectedObjectId(null);
    setSelectedSubPartId(null);
    notify(`Cleared all objects from ${activePlate.name}`, "info");
  }, [activePlate, updateActivePlateObjects, notify]);

  const cloneSelected = useCallback(
    (copies = 1) => {
      if (!selectedObject) return;
      const newObjs: SceneObject[] = [];
      for (let i = 0; i < copies; i++) {
        const offset = (selectedObject.geometry.bounds.size[0] + 8) * (i + 1);
        newObjs.push({
          ...selectedObject,
          id: uid("obj"),
          name: `${selectedObject.name} (${i + 2})`,
          position: [
            Math.min(buildVolume[0] - 10, selectedObject.position[0] + offset),
            selectedObject.position[1],
            selectedObject.position[2],
          ],
          overrides: { ...selectedObject.overrides },
          subParts: selectedObject.subParts.map((sp) => ({ ...sp, id: uid("sub"), overrides: { ...sp.overrides } })),
          paintSupport: selectedObject.paintSupport ? new Uint8Array(selectedObject.paintSupport) : undefined,
          paintSeam: selectedObject.paintSeam ? new Uint8Array(selectedObject.paintSeam) : undefined,
          paintColor: selectedObject.paintColor ? new Uint8Array(selectedObject.paintColor) : undefined,
        });
      }
      updateActivePlateObjects((objs) => [...objs, ...newObjs]);
      setSelectedObjectId(newObjs[newObjs.length - 1].id);
      notify(`Cloned ${selectedObject.name}`, "success");
    },
    [selectedObject, buildVolume, updateActivePlateObjects, notify]
  );

  const mirrorSelected = useCallback(
    (axis: "x" | "y" | "z") => {
      if (!selectedObject) return;
      const mirrored = mirrorGeometry(selectedObject.geometry, axis);
      updateObject(selectedObject.id, { geometry: mirrored });
      notify(`Mirrored ${selectedObject.name} along ${axis.toUpperCase()}`, "info");
    },
    [selectedObject, updateObject, notify]
  );

  const splitSelectedToObjects = useCallback(() => {
    if (!selectedObject) return;
    const worldPos = transformPositions(selectedObject.geometry.positions, getObjectMatrix(selectedObject));
    const shells = splitDisconnectedShells(worldPos);
    if (shells.length <= 1) {
      notify("Selected model is a single connected shell", "info");
      return;
    }
    const created: SceneObject[] = shells.map((sh, i) => ({
      id: uid("obj"),
      name: `${selectedObject.name} part ${i + 1}`,
      geometry: sh.geometry,
      position: [Number(sh.centerXY[0].toFixed(2)), Number(sh.centerXY[1].toFixed(2)), 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      visible: true,
      filamentIndex: selectedObject.filamentIndex,
      overrides: { ...selectedObject.overrides },
      subParts: [],
    }));
    updateActivePlateObjects((objs) => [
      ...objs.filter((o) => o.id !== selectedObject.id),
      ...created,
    ]);
    setSelectedObjectId(created[0].id);
    notify(`Split into ${created.length} separate objects`, "success");
  }, [selectedObject, updateActivePlateObjects, notify]);

  const cutSelectedAtZ = useCallback(
    (zMm: number, mode: "both" | "upper" | "lower") => {
      if (!selectedObject) return;
      // Bake current rotation/scale into world coordinates centered at object XY
      const worldPos = transformPositions(selectedObject.geometry.positions, getObjectMatrix(selectedObject));
      const shifted = new Float32Array(worldPos.length);
      for (let i = 0; i < worldPos.length; i += 3) {
        shifted[i] = worldPos[i] - selectedObject.position[0];
        shifted[i + 1] = worldPos[i + 1] - selectedObject.position[1];
        shifted[i + 2] = worldPos[i + 2];
      }
      const { upper, lower } = cutGeometryAtZ({ ...selectedObject.geometry, positions: shifted, triangleCount: Math.floor(shifted.length / 9) }, zMm);
      const next: SceneObject[] = [];
      if ((mode === "both" || mode === "lower") && lower) {
        next.push({
          ...selectedObject,
          id: uid("obj"),
          name: `${selectedObject.name} (Lower)`,
          geometry: lower,
          position: [selectedObject.position[0] - (mode === "both" ? lower.bounds.size[0] * 0.55 + 4 : 0), selectedObject.position[1], 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
          subParts: [],
          paintSupport: undefined,
          paintSeam: undefined,
          paintColor: undefined,
        });
      }
      if ((mode === "both" || mode === "upper") && upper) {
        next.push({
          ...selectedObject,
          id: uid("obj"),
          name: `${selectedObject.name} (Upper)`,
          geometry: upper,
          position: [selectedObject.position[0] + (mode === "both" ? upper.bounds.size[0] * 0.55 + 4 : 0), selectedObject.position[1], 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
          subParts: [],
          paintSupport: undefined,
          paintSeam: undefined,
          paintColor: undefined,
        });
      }
      if (next.length === 0) {
        notify("Cut plane did not intersect the model", "error");
        return;
      }
      updateActivePlateObjects((objs) => [
        ...objs.filter((o) => o.id !== selectedObject.id),
        ...next,
      ]);
      setSelectedObjectId(next[0].id);
      setTool("select");
      notify(`Cut complete (${next.length} part${next.length > 1 ? "s" : ""})`, "success");
    },
    [selectedObject, updateActivePlateObjects, notify]
  );

  const arrangeActivePlate = useCallback(() => {
    if (!activePlate.objects.length) return;
    updateActivePlateObjects((objs) => arrangeObjectsOnBed(objs, buildVolume, 6));
    notify(`Auto-arranged ${activePlate.objects.length} objects`, "success");
  }, [activePlate?.objects.length, buildVolume, updateActivePlateObjects, notify]);

  const centerSelected = useCallback(() => {
    if (!selectedObject) return;
    const moved = { ...selectedObject, position: [buildVolume[0] / 2, buildVolume[1] / 2, selectedObject.position[2]] as [number, number, number] };
    updateObject(selectedObject.id, { position: groundObjectPosition(moved) });
  }, [selectedObject, buildVolume, updateObject]);

  const dropSelectedToBed = useCallback(() => {
    if (!selectedObject) return;
    updateObject(selectedObject.id, { position: groundObjectPosition(selectedObject) });
  }, [selectedObject, updateObject]);

  const repairSelectedNative = useCallback(async () => {
    if (!selectedObject) return;
    try {
      notify("Repairing mesh with native OrcaSlicer...", "info");
      const stl = exportBinarySTL(selectedObject.geometry.positions);
      const fixed = await nativeMeshRepair(stl);
      const geom = parseSTL(fixed.buffer as ArrayBuffer);
      updateObject(selectedObject.id, { geometry: geom });
      notify(`Mesh repaired (${geom.triangleCount.toLocaleString()} triangles)`, "success");
    } catch (err) {
      notify(`Repair failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  }, [selectedObject, updateObject, notify]);

  const autoOrientSelectedNative = useCallback(async () => {
    if (!selectedObject) return;
    try {
      notify("Running native OrcaSlicer auto-orient...", "info");
      const stl = exportBinarySTL(selectedObject.geometry.positions);
      const oriented = await nativeMeshAutoOrient(stl);
      const geom = parseSTL(oriented.buffer as ArrayBuffer);
      updateObject(selectedObject.id, { geometry: geom, rotation: [0, 0, 0] });
      notify("Auto-oriented for optimal printing", "success");
    } catch (err) {
      notify(`Auto-orient failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  }, [selectedObject, updateObject, notify]);

  const addSubPartToSelected = useCallback(
    (subtype: SubPartType, shape: "cube" | "cylinder" | "sphere" = "cube") => {
      if (!selectedObject) return;
      const sub = createSubPart(subtype, shape, 16);
      updateObject(selectedObject.id, { subParts: [...selectedObject.subParts, sub] });
      setSelectedSubPartId(sub.id);
      setProcessScope("objects");
      notify(`Added ${sub.name} to ${selectedObject.name}`, "success");
    },
    [selectedObject, updateObject, notify]
  );

  const updateSubPart = useCallback(
    (objectId: string, subPartId: string, patch: Partial<SubPart>) => {
      updateActivePlateObjects((objs) =>
        objs.map((o) =>
          o.id === objectId
            ? { ...o, subParts: o.subParts.map((s) => (s.id === subPartId ? { ...s, ...patch } : s)) }
            : o
        )
      );
    },
    [updateActivePlateObjects]
  );

  // Plate management
  const addPlate = useCallback(() => {
    const num = plates.length + 1;
    const p: Plate = { id: uid("plate"), name: `Plate ${num}`, locked: false, objects: [] };
    setPlates((prev) => [...prev, p]);
    setActivePlateId(p.id);
    setSelectedObjectId(null);
    setSelectedSubPartId(null);
  }, [plates.length]);

  const duplicateActivePlate = useCallback(() => {
    const copy: Plate = {
      id: uid("plate"),
      name: `${activePlate.name} Copy`,
      locked: false,
      objects: activePlate.objects.map((o) => ({
        ...o,
        id: uid("obj"),
        overrides: { ...o.overrides },
        subParts: o.subParts.map((sp) => ({ ...sp, id: uid("sub"), overrides: { ...sp.overrides } })),
      })),
    };
    setPlates((prev) => [...prev, copy]);
    setActivePlateId(copy.id);
  }, [activePlate]);

  const deletePlate = useCallback(
    (plateId: string) => {
      if (plates.length <= 1) return;
      const next = plates.filter((p) => p.id !== plateId);
      setPlates(next);
      if (activePlateId === plateId) {
        setActivePlateId(next[0].id);
        setSelectedObjectId(null);
        setSelectedSubPartId(null);
      }
    },
    [plates, activePlateId]
  );

  const newProject = useCallback(() => {
    pushHistory();
    const p = makeDefaultPlate();
    setPlates([p]);
    setActivePlateId(p.id);
    setSelectedObjectId(null);
    setSelectedSubPartId(null);
    setParsedGcode(null);
    setCurrentJob(null);
    setProcessOverrides({});
    setTab("prepare");
    notify("Started a new empty project", "info");
  }, [pushHistory, notify]);

  // Filament management
  const addFilamentSlot = useCallback(() => {
    if (filaments.length >= 8) return;
    const idx = filaments.length;
    const slot: FilamentSlot = {
      id: uid("fil"),
      profile: { ...filaments[0].profile },
      color: FILAMENT_SWATCH_PALETTE[idx % FILAMENT_SWATCH_PALETTE.length],
      overrides: {},
    };
    setFilaments((prev) => [...prev, slot]);
    setFlushMatrix((prev) => {
      const n = prev.length + 1;
      return Array.from({ length: n }, (_, r) =>
        Array.from({ length: n }, (_, c) => (r === c ? 0 : prev[r]?.[c] ?? 280))
      );
    });
  }, [filaments]);

  const removeFilamentSlot = useCallback((slotId: string) => {
    if (filaments.length <= 1) return;
    const idx = filaments.findIndex((f) => f.id === slotId);
    setFilaments((prev) => prev.filter((f) => f.id !== slotId));
    setFlushMatrix((prev) =>
      prev.filter((_, r) => r !== idx).map((row) => row.filter((_, c) => c !== idx))
    );
  }, [filaments]);

  const updateFilamentSlot = useCallback((slotId: string, patch: Partial<FilamentSlot>) => {
    setFilaments((prev) => prev.map((f) => (f.id === slotId ? { ...f, ...patch } : f)));
    setSliceStale(true);
  }, []);

  // Process override helpers (Global or Selected Object / SubPart)
  const setSettingValue = useCallback(
    (key: string, value: OrcaValue | undefined) => {
      setSliceStale(true);
      if (processScope === "objects" && selectedObject) {
        if (selectedSubPart) {
          const next = { ...selectedSubPart.overrides };
          if (value === undefined) delete next[key];
          else next[key] = value;
          updateSubPart(selectedObject.id, selectedSubPart.id, { overrides: next });
        } else {
          const next = { ...selectedObject.overrides };
          if (value === undefined) delete next[key];
          else next[key] = value;
          updateObject(selectedObject.id, { overrides: next }, false);
        }
        return;
      }
      setProcessOverrides((prev) => {
        const next = { ...prev };
        if (value === undefined) delete next[key];
        else next[key] = value;
        return next;
      });
    },
    [processScope, selectedObject, selectedSubPart, updateObject, updateSubPart]
  );

  // Calibration runner
  const applyCalibration = useCallback(
    (id: CalibrationId, params: Record<string, number | string>) => {
      const generated = generateCalibrationModel(id, params);
      setProcessOverrides((prev) => ({ ...prev, ...generated.recommendedOverrides }));
      addObjectFromGeometry(generated.name, generated.geometry);
      setTab("prepare");
      notify(generated.note, "success");
    },
    [addObjectFromGeometry, notify]
  );

  // Export downloads
  const exportPlateSTLFile = useCallback(() => {
    if (!activePlate.objects.some((o) => o.visible)) {
      notify("Add a visible model before exporting STL", "error");
      return;
    }
    const bytes = exportPlateToBinarySTL(activePlate.objects);
    triggerBlobDownload(new Blob([bytes.buffer as ArrayBuffer], { type: "model/stl" }), `${activePlate.name.replace(/\s+/g, "_")}.stl`);
  }, [activePlate, notify]);

  const exportSelectedObjectSTL = useCallback(() => {
    if (!selectedObject) {
      notify("Select an object first", "error");
      return;
    }
    const mat = getObjectMatrix(selectedObject);
    const transformed = transformPositions(selectedObject.geometry.positions, mat);
    const bytes = exportBinarySTL(transformed);
    const safeName = selectedObject.name.replace(/[^a-zA-Z0-9._-]+/g, "_") || "object";
    triggerBlobDownload(new Blob([bytes.buffer as ArrayBuffer], { type: "model/stl" }), `${safeName}.stl`);
  }, [selectedObject, notify]);

  const exportProject3MFFile = useCallback(() => {
    if (!activePlate.objects.some((o) => o.visible)) {
      notify("Add a visible model before saving 3MF", "error");
      return;
    }
    const bytes = exportPlateTo3MF(activePlate);
    triggerBlobDownload(new Blob([bytes.buffer as ArrayBuffer], { type: "model/3mf" }), `${activePlate.name.replace(/\s+/g, "_")}.3mf`);
    notify("Exported OrcaSlicer .3mf project", "success");
  }, [activePlate, notify]);

  const exportSlicedGcodeFile = useCallback(() => {
    if (!parsedGcode) return;
    triggerBlobDownload(
      new Blob([parsedGcode.rawText], { type: "text/x.gcode" }),
      `${activePlate.name.replace(/\s+/g, "_")}_${printer.name.replace(/\s+/g, "_")}.gcode`
    );
  }, [parsedGcode, activePlate?.name, printer.name]);

  const exportSliced3MFFile = useCallback(async () => {
    if (!currentJob || currentJob.status !== "succeeded") return;
    try {
      const blob = await download3mf(currentJob.id);
      triggerBlobDownload(blob, `${activePlate.name.replace(/\s+/g, "_")}.gcode.3mf`);
    } catch (err) {
      notify(`Failed to download sliced 3MF: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  }, [currentJob, activePlate?.name, notify]);

  // REAL NATIVE ORCASLICER 2.5.0 SLICING!
  const sliceActivePlate = useCallback(async () => {
    const visible = activePlate.objects.filter((o) => o.visible);
    if (visible.length === 0) {
      notify("Add at least one visible model to the build plate before slicing", "error");
      return;
    }
    if (typeof window !== "undefined" && window.innerWidth < 960) {
      setSidebarOpen(false);
    }
    setSlicing(true);
    setSliceStatusText("Configuring OrcaSlicer 2.5.0...");
    try {
      // Build full configuration payload
      const hasMultiFilament = filaments.length > 1;
      const hasPerObjectFeatures =
        visible.length > 1 ||
        visible.some(
          (o) =>
            o.subParts.length > 0 ||
            Object.keys(o.overrides).length > 0 ||
            o.filamentIndex > 0 ||
            Boolean(o.paintSupport) ||
            Boolean(o.paintSeam) ||
            Boolean(o.paintColor)
        );

      const filamentSpecs = filaments.map((f) => ({
        profile: f.profile,
        overrides: {
          ...f.overrides,
          filament_colour: [f.color],
        },
      }));

      const configPayload = {
        printer: {
          profile: printer,
          ...(Object.keys(printerOverrides).length ? { overrides: printerOverrides } : {}),
        },
        process: {
          profile: process,
          ...(Object.keys(processOverrides).length ? { overrides: processOverrides } : {}),
        },
        ...(hasMultiFilament ? { filaments: filamentSpecs } : { filament: filamentSpecs[0] }),
        bed_type: bedType,
        placement: "preserve_xy" as const,
      };

      const cfg = await createConfiguration(configPayload);

      // Zero-upload fast path: if meshes were already eagerly staged on import/add and there are no
      // painted faces or sub-parts requiring custom 3MF attributes, submit a tiny JSON job referencing
      // the pre-staged mesh IDs (automatically falling back to direct STL/3MF upload on 404 cache miss).
      const hasComplex3mfOnly = visible.some(
        (o) =>
          o.subParts.length > 0 ||
          Boolean(o.paintSupport) ||
          Boolean(o.paintSeam) ||
          Boolean(o.paintColor)
      );

      let job: SliceJobRecord | null = null;
      if (health?.capabilities?.staged_meshes && !hasComplex3mfOnly) {
        const needsAwait = visible.some((o) => !stagedMeshIdsRef.current.has(o.geometry.positions));
        if (needsAwait) {
          setSliceStatusText("Finishing background sync...");
        }
        const meshIds = await Promise.all(visible.map((o) => ensureGeometryStaged(o.geometry)));
        if (meshIds.every((id): id is string => Boolean(id))) {
          setSliceStatusText("Starting native OrcaSlicer...");
          job = await submitStagedSliceJob(
            cfg.id,
            visible.map((o, idx) => ({
              mesh_id: meshIds[idx],
              name: o.name,
              position: o.position,
              rotation: o.rotation,
              scale: o.scale,
              filament_index: o.filamentIndex,
              ...(Object.keys(o.overrides).length ? { overrides: o.overrides } : {}),
            }))
          );
          if (!job) {
            // Backend cache evicted or restarted; clear stale IDs and fall back cleanly
            for (const o of visible) {
              stagedMeshIdsRef.current.delete(o.geometry.positions);
              stagedMeshPromisesRef.current.delete(o.geometry.positions);
            }
          }
        }
      }

      if (!job) {
        const use3mf = Boolean(health?.capabilities?.threemf) && hasPerObjectFeatures;
        setSliceStatusText(use3mf ? "Packaging 3MF plate..." : "Exporting plate geometry...");
        const payloadBytes = use3mf ? exportPlateTo3MF(activePlate) : exportPlateToBinarySTL(visible);

        setSliceStatusText("Uploading to native OrcaSlicer...");
        job = await submitSliceJob(cfg.id, payloadBytes, use3mf ? "3mf" : "stl");
      }
      setCurrentJob(job);

      setSliceStatusText("Slicing toolpaths...");
      const deadline = Date.now() + 240_000;
      while ((job.status === "queued" || job.status === "running" || job.status === "uploading") && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 350));
        job = await getJob(job.id);
        setCurrentJob(job);
        if (job.status === "queued") setSliceStatusText("Queued in OrcaSlicer...");
        else if (job.status === "running") setSliceStatusText("Slicing with OrcaSlicer 2.5.0...");
      }

      if (job.status !== "succeeded") {
        throw new Error(job.error || `Slicing ended with status: ${job.status}`);
      }

      setSliceStatusText("Parsing G-code preview...");
      const gcodeText = await downloadGcode(job.id, 1);
      const parsed = parseGcode(gcodeText);
      setParsedGcode(parsed);
      const maxL = Math.max(0, parsed.layers.length - 1);
      setLayerBottom(0);
      setLayerTop(maxL);
      setMoveIndex(parsed.layers[maxL]?.endSegment ?? parsed.segmentCount);
      setSectionCutEnabled(false);
      setSectionCutPosition(Number(((parsed.bounds.min[1] + parsed.bounds.max[1]) * 0.5).toFixed(1)));
      setIsPlaying(false);
      setSliceStale(false);
      setTab("preview");

      const timeStr = job.summary?.estimated_print_time || parsed.stats.estimatedTimeLabel;
      const gramsStr = job.summary?.filament_used_grams || parsed.stats.filamentGrams.toFixed(2);
      notify(`Sliced ${parsed.layers.length} layers · ${timeStr} · ${gramsStr} g`, "success");
    } catch (err) {
      notify(`Slice failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      setSlicing(false);
      setSliceStatusText("");
    }
  }, [
    activePlate,
    filaments,
    printer,
    printerOverrides,
    process,
    processOverrides,
    bedType,
    health?.capabilities?.threemf,
    health?.capabilities?.staged_meshes,
    ensureGeometryStaged,
    notify,
  ]);

  // Preview playback loop
  useEffect(() => {
    if (!isPlaying || !parsedGcode) return;
    const layer = parsedGcode.layers[layerTop];
    if (!layer) {
      setIsPlaying(false);
      return;
    }
    const raf = window.setInterval(() => {
      setMoveIndex((prev) => {
        const next = prev + playSpeed;
        if (next >= layer.endSegment) {
          if (layerTop < parsedGcode.layers.length - 1) {
            const nextL = layerTop + 1;
            setLayerTop(nextL);
            return parsedGcode.layers[nextL].startSegment;
          }
          setIsPlaying(false);
          return layer.endSegment;
        }
        return next;
      });
    }, 33);
    return () => window.clearInterval(raf);
  }, [isPlaying, parsedGcode, layerTop, playSpeed]);

  const toggleFeatureVisibility = useCallback((feature: string) => {
    setHiddenFeatures((prev) => {
      const next = new Set(prev);
      if (next.has(feature)) next.delete(feature);
      else next.add(feature);
      return next;
    });
  }, []);

  // OrcaSlicer desktop keyboard shortcuts
  useEffect(() => {
    const emitCamera = (preset: string) => {
      window.dispatchEvent(new CustomEvent("orca-camera-preset", { detail: preset }));
    };

    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const editing =
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
      if (editing) return;

      const mod = e.metaKey || e.ctrlKey;
      const key = e.key;
      const k = key.toLowerCase();

      // OrcaSlicer desktop Tab: toggle Prepare <-> Preview (auto-slices if unsliced/stale with models loaded)
      if (key === "Tab" && !mod && !e.altKey) {
        e.preventDefault();
        if (tab === "preview") {
          setTab("prepare");
        } else {
          const hasVisible = activePlate.objects.some((o) => o.visible);
          if (hasVisible && (!parsedGcode || sliceStale)) {
            if (!slicing) void sliceActivePlate();
          } else {
            setTab("preview");
          }
        }
        return;
      }

      if (key === "?" || (e.shiftKey && key === "/")) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("orca-open-shortcuts"));
        return;
      }

      if (mod && k === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && k === "y") {
        e.preventDefault();
        redo();
        return;
      }
      if (mod && k === "k") {
        e.preventDefault();
        cloneSelected(1);
        return;
      }
      if (mod && k === "i") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("orca-trigger-import"));
        return;
      }
      if (mod && k === "g") {
        e.preventDefault();
        if (parsedGcode) exportSlicedGcodeFile();
        return;
      }
      if (mod && k === "b") {
        e.preventDefault();
        setSidebarOpen((v) => !v);
        return;
      }
      if (mod && (k === "r" || (e.shiftKey && k === "s"))) {
        e.preventDefault();
        if (!slicing) sliceActivePlate();
        return;
      }

      if (mod || e.altKey) return;

      // OrcaSlicer desktop camera view number keys (0=Iso, 1=Top, 2=Bottom, 3=Front, 4=Back, 5=Left, 6=Right)
      if (tab !== "calibration") {
        if (key === "0") { emitCamera("iso"); return; }
        if (key === "1") { emitCamera("top"); return; }
        if (key === "2") { emitCamera("bottom"); return; }
        if (key === "3") { emitCamera("front"); return; }
        if (key === "4") { emitCamera("back"); return; }
        if (key === "5") { emitCamera("left"); return; }
        if (key === "6") { emitCamera("right"); return; }
        if (e.shiftKey && k === "f") { e.preventDefault(); emitCamera("fit"); return; }
      }

      if (tab === "prepare") {
        if (k === "escape") { setTool("select"); setMeasurePoints([]); }
        else if (k === "m" && selectedObject) setTool((t) => (t === "move" ? "select" : "move"));
        else if (k === "r" && selectedObject) setTool((t) => (t === "rotate" ? "select" : "rotate"));
        else if (k === "s" && selectedObject) setTool((t) => (t === "scale" ? "select" : "scale"));
        else if (k === "f" && selectedObject) setTool((t) => (t === "lay_on_face" ? "select" : "lay_on_face"));
        else if (k === "c" && selectedObject) setTool((t) => (t === "cut" ? "select" : "cut"));
        else if (k === "l" && selectedObject) setTool((t) => (t === "paint_support" ? "select" : "paint_support"));
        else if (k === "p" && selectedObject) setTool((t) => (t === "paint_seam" ? "select" : "paint_seam"));
        else if (k === "n" && selectedObject) setTool((t) => (t === "paint_color" ? "select" : "paint_color"));
        else if (k === "v" && selectedObject) setTool((t) => (t === "variable_layer" ? "select" : "variable_layer"));
        else if (k === "t") setTool((t) => (t === "text_emboss" ? "select" : "text_emboss"));
        else if (k === "u") { setMeasurePoints([]); setTool((t) => (t === "measure" ? "select" : "measure")); }
        else if (k === "a") arrangeActivePlate();
        else if (k === "o" && selectedObject) autoOrientSelectedNative();
        else if (k === "w") setWireframe((v) => !v);
        else if (k === "h") setShowOverhangs((v) => !v);
        else if (e.shiftKey && (key === "Delete" || key === "Backspace")) deleteAllObjectsOnPlate();
        else if (key === "Delete" || key === "Backspace") deleteSelected();
      } else if (tab === "preview" && parsedGcode) {
        const activeLayer = parsedGcode.layers[layerTop];
        const lStart = activeLayer?.startSegment ?? 0;
        const lEnd = activeLayer?.endSegment ?? parsedGcode.segmentCount;

        if (key === " ") {
          e.preventDefault();
          if (!isPlaying && moveIndex >= lEnd) setMoveIndex(lStart);
          setIsPlaying((v) => !v);
        } else if (key === "ArrowUp") {
          e.preventDefault();
          const step = e.shiftKey ? 10 : 1;
          setLayerTop((l) => {
            const next = Math.min(parsedGcode.layers.length - 1, l + step);
            setMoveIndex(parsedGcode.layers[next]?.endSegment ?? parsedGcode.segmentCount);
            return next;
          });
        } else if (key === "ArrowDown") {
          e.preventDefault();
          const step = e.shiftKey ? 10 : 1;
          setLayerTop((l) => {
            const next = Math.max(layerBottom, l - step);
            setMoveIndex(parsedGcode.layers[next]?.endSegment ?? parsedGcode.segmentCount);
            return next;
          });
        } else if (key === "ArrowRight") {
          e.preventDefault();
          setIsPlaying(false);
          const step = e.shiftKey ? 100 : 10;
          setMoveIndex((m) => Math.min(lEnd, Math.max(lStart, m) + step));
        } else if (key === "ArrowLeft") {
          e.preventDefault();
          setIsPlaying(false);
          const step = e.shiftKey ? 100 : 10;
          setMoveIndex((m) => Math.max(lStart, Math.min(lEnd, m) - step));
        } else if (key === "Home") {
          e.preventDefault();
          setLayerTop(layerBottom);
          setMoveIndex(parsedGcode.layers[layerBottom]?.endSegment ?? 0);
        } else if (key === "End") {
          e.preventDefault();
          const top = Math.max(0, parsedGcode.layers.length - 1);
          setLayerTop(top);
          setMoveIndex(parsedGcode.layers[top]?.endSegment ?? parsedGcode.segmentCount);
        } else if (k === "t") {
          toggleFeatureVisibility("Travel");
        } else if (k === "g") {
          setShowGhost((v) => !v);
        } else if (k === "x") {
          setSectionCutEnabled((v) => !v);
        } else if (k === "h") {
          setShowNozzle((v) => !v);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    tab,
    activePlate,
    sliceStale,
    undo,
    redo,
    cloneSelected,
    slicing,
    sliceActivePlate,
    arrangeActivePlate,
    autoOrientSelectedNative,
    deleteSelected,
    deleteAllObjectsOnPlate,
    exportSlicedGcodeFile,
    selectedObject,
    parsedGcode,
    layerBottom,
    layerTop,
    isPlaying,
    moveIndex,
    toggleFeatureVisibility,
  ]);

  return {
    tab, setTab,
    sidebarOpen, setSidebarOpen,
    processScope, setProcessScope,
    settingTab, setSettingTab,
    advancedMode, setAdvancedMode,
    printer, setPrinter: selectPrinter,
    printerSettings,
    printerOverrides, setPrinterOverrides,
    buildVolume, setBuildVolume,
    bedExcludeArea,
    machineModel,
    compatibleProfiles,
    process, setProcess,
    processSettings,
    processOverrides, setProcessOverrides,
    bedType, setBedType,
    filaments, addFilamentSlot, removeFilamentSlot, updateFilamentSlot,
    flushMatrix, setFlushMatrix,
    plates, activePlate, activePlateId, setActivePlateId,
    addPlate, duplicateActivePlate, deletePlate, newProject,
    selectedObject, selectedObjectId, setSelectedObjectId,
    selectedSubPart, selectedSubPartId, setSelectedSubPartId,
    tool, setTool,
    showOverhangs, setShowOverhangs,
    wireframe, setWireframe,
    cutHeight, setCutHeight,
    paintMode, setPaintMode,
    paintBrushRadius, setPaintBrushRadius,
    paintFilamentIndex, setPaintFilamentIndex,
    measurePoints, setMeasurePoints,
    canUndo: undoStack.current.length > 0 && historyVersion >= 0,
    canRedo: redoStack.current.length > 0 && historyVersion >= 0,
    undo, redo,
    addPrimitive, addTextEmboss, importFiles,
    updateObject, deleteSelected, deleteAllObjectsOnPlate, cloneSelected, mirrorSelected,
    splitSelectedToObjects, cutSelectedAtZ,
    arrangeActivePlate, centerSelected, dropSelectedToBed,
    repairSelectedNative, autoOrientSelectedNative,
    addSubPartToSelected, updateSubPart,
    setSettingValue,
    applyCalibration,
    exportPlateSTLFile, exportSelectedObjectSTL, exportProject3MFFile, exportSlicedGcodeFile, exportSliced3MFFile,
    health, backendOnline, backendUrl, bearerToken, updateBackendConnection, refreshHealth,
    slicing, sliceStatusText, sliceActivePlate, currentJob, parsedGcode, sliceStale,
    colorScheme, setColorScheme,
    layerTop, setLayerTop, layerBottom, setLayerBottom,
    moveIndex, setMoveIndex,
    hiddenFeatures, toggleFeatureVisibility,
    showRetractions, setShowRetractions,
    showSeams, setShowSeams,
    showNozzle, setShowNozzle,
    showGhost, setShowGhost,
    realisticGloss, setRealisticGloss,
    dimLowerLayers, setDimLowerLayers,
    sectionCutEnabled, setSectionCutEnabled,
    sectionCutAxis, setSectionCutAxis,
    sectionCutPosition, setSectionCutPosition,
    isPlaying, setIsPlaying, playSpeed, setPlaySpeed,
    toast, notify,
    allFeatureTypes: ALL_FEATURE_TYPES,
  };
}

export type WorkspaceAPI = ReturnType<typeof useWorkspace>;

function triggerBlobDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
}
