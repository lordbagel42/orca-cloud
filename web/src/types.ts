export type WorkspaceTab = "prepare" | "preview" | "calibration";

export type SettingTabId =
  | "quality"
  | "strength"
  | "speed"
  | "support"
  | "multimaterial"
  | "others";

export type PrepareTool =
  | "select"
  | "move"
  | "rotate"
  | "scale"
  | "lay_on_face"
  | "cut"
  | "paint_support"
  | "paint_seam"
  | "paint_color"
  | "variable_layer"
  | "measure"
  | "text_emboss";

export type BedType =
  | "Textured PEI Plate"
  | "Cool Plate"
  | "Engineering Plate"
  | "High Temp Plate"
  | "Smooth PEI Plate"
  | "Textured Cool Plate";

export const BED_TYPES: BedType[] = [
  "Textured PEI Plate",
  "Smooth PEI Plate",
  "Cool Plate",
  "High Temp Plate",
  "Engineering Plate",
  "Textured Cool Plate",
];

export type OrcaValue = string | string[];
export type OrcaSettingsMap = Record<string, OrcaValue>;

export interface ProfileRef {
  vendor: string;
  name: string;
}

export interface ProfileSummary {
  vendor: string;
  kind: "machine" | "process" | "filament";
  name: string;
  path: string;
  instantiation: boolean;
}

export interface VendorSummary {
  id: string;
  name: string;
  version: string;
  counts: { machine: number; process: number; filament: number };
}

export interface FilamentSlot {
  id: string;
  profile: ProfileRef;
  color: string;
  overrides: OrcaSettingsMap;
  resolvedSettings?: OrcaSettingsMap;
}

export interface BoundingBox {
  min: [number, number, number];
  max: [number, number, number];
  size: [number, number, number];
  center: [number, number, number];
}

export interface GeometryData {
  positions: Float32Array;
  normals: Float32Array;
  triangleCount: number;
  bounds: BoundingBox;
  volumeMm3: number;
  surfaceAreaMm2: number;
}

export type SubPartType =
  | "modifier_part"
  | "negative_part"
  | "support_enforcer"
  | "support_blocker";

export interface SubPart {
  id: string;
  name: string;
  subtype: SubPartType;
  geometry: GeometryData;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  overrides: OrcaSettingsMap;
  filamentIndex?: number;
}

export interface VariableLayerPoint {
  z: number;
  layerHeight: number;
}

export interface SceneObject {
  id: string;
  name: string;
  geometry: GeometryData;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  visible: boolean;
  filamentIndex: number;
  overrides: OrcaSettingsMap;
  subParts: SubPart[];
  /** Per-triangle paint state: 0 = none, 1 = enforce, 2 = block */
  paintSupport?: Uint8Array;
  /** Per-triangle paint state: 0 = none, 1 = enforce, 2 = block */
  paintSeam?: Uint8Array;
  /** Per-triangle filament slot override: 0 = object default, 1..N = slot index+1 */
  paintColor?: Uint8Array;
  variableLayers?: VariableLayerPoint[];
}

export interface Plate {
  id: string;
  name: string;
  locked: boolean;
  objects: SceneObject[];
}

export type GcodeFeatureType =
  | "Outer wall"
  | "Inner wall"
  | "Overhang wall"
  | "Sparse infill"
  | "Internal solid infill"
  | "Top surface"
  | "Bottom surface"
  | "Support"
  | "Support interface"
  | "Bridge"
  | "Gap infill"
  | "Skirt"
  | "Brim"
  | "Prime tower"
  | "Custom"
  | "Travel"
  | "Unknown";

export type PreviewColorScheme =
  | "line_type"
  | "filament"
  | "speed"
  | "flow"
  | "layer_height"
  | "line_width"
  | "fan_speed"
  | "temperature";

export interface GcodeLayer {
  index: number;
  z: number;
  height: number;
  startSegment: number;
  endSegment: number;
  startLine: number;
}

export interface GcodeStats {
  totalLayers: number;
  totalSegments: number;
  estimatedTimeSeconds: number;
  estimatedTimeLabel: string;
  filamentLengthMm: number;
  filamentVolumeCm3: number;
  filamentGrams: number;
  filamentCost: number;
  featureBreakdown: Array<{
    feature: GcodeFeatureType;
    timeSeconds: number;
    distanceMm: number;
    percentage: number;
  }>;
}

export interface ParsedGcode {
  rawText: string;
  lineCount: number;
  layers: GcodeLayer[];
  segmentCount: number;
  truncated: boolean;
  starts: Float32Array;
  ends: Float32Array;
  features: Uint8Array;
  filaments: Uint8Array;
  speeds: Float32Array;
  flows: Float32Array;
  layerHeights: Float32Array;
  lineWidths: Float32Array;
  fanSpeeds: Float32Array;
  temps: Float32Array;
  layersArr: Uint16Array;
  lineNumbers: Uint32Array;
  retractions: Float32Array;
  seams: Float32Array;
  ranges: {
    speed: [number, number];
    flow: [number, number];
    layerHeight: [number, number];
    lineWidth: [number, number];
    temp: [number, number];
  };
  stats: GcodeStats;
  bounds: { min: [number, number, number]; max: [number, number, number] };
}

export interface NativePlateStats {
  time?: number;
  prepare_time?: number;
  travel_time?: number;
  travel_distance?: number;
  layer_count?: number;
  volume?: number;
  weight?: number;
  filament_cost?: number;
  filament_changes?: number;
  filaments?: Array<{
    id: number;
    length: number;
    volume: number;
    weight: number;
    cost?: number;
  }>;
  features?: Record<string, { time: number; volume: number; weight: number }>;
}

export interface SliceJobRecord {
  id: string;
  status: "uploading" | "queued" | "running" | "succeeded" | "failed";
  created_at: number;
  started_at?: number;
  finished_at?: number;
  error?: string;
  output_bytes?: number;
  output_sha256?: string;
  output_url?: string;
  output_3mf_url?: string;
  summary?: {
    gcode_bytes: number;
    sha256: string;
    slice_duration_seconds: number;
    plate_count?: number;
    has_3mf?: boolean;
    estimated_print_time?: string;
    filament_used_grams?: string;
    filament_used_mm?: string;
    filament_used_cm3?: string;
    filament_cost?: string;
    layer_count?: string;
    statistics?: NativePlateStats;
  };
  plates?: Array<{
    plate_index: number;
    gcode_url: string;
    gcode_bytes: number;
    sha256: string;
    statistics?: NativePlateStats;
    estimated_print_time?: string;
    filament_used_grams?: string;
    layer_count?: string;
  }>;
  feedback?: {
    native_log_tail?: string;
    native_log_truncated?: boolean;
    native_result?: {
      error_string?: string;
      warnings?: Array<{ message?: string; code?: string } | string>;
    };
    field_evidence?: {
      explicit_mismatch_count: number;
      fields: Record<string, { status: string; expected: unknown; exported: unknown; explicit: boolean }>;
    };
  };
}

export interface MachineModelInfo {
  name: string;
  vendor: string;
  family: string;
  model_id: string;
  bed_model: string | null;
  bed_texture: string | null;
  hotend_model: string | null;
  bed_model_url: string | null;
  bed_texture_url: string | null;
  hotend_model_url: string | null;
  default_bed_type: string;
  not_support_bed_types: string[];
  nozzle_diameters: string[];
  default_materials: string[];
}

export interface NozzleVariantItem {
  vendor: string;
  name: string;
  nozzle_diameter: string;
}

export interface CompatibleProcessItem {
  vendor: string;
  name: string;
  layer_height: number;
  is_default: boolean;
}

export interface CompatibleFilamentItem {
  vendor: string;
  name: string;
  filament_type: string;
  filament_vendor: string;
  nozzle_temp: string;
  bed_temp: string;
  is_default: boolean;
  is_recommended: boolean;
}

export interface CompatibleProfilesResponse {
  vendor: string;
  machine: string;
  printer_model: string;
  printer_variant: string;
  build_volume_mm: [number, number, number];
  printable_area_polygon: [number, number][];
  bed_exclude_area_polygon: [number, number][];
  machine_model: MachineModelInfo;
  nozzle_variants: NozzleVariantItem[];
  default_print_profile: string;
  default_filament_profile: string;
  settings: OrcaSettingsMap;
  processes: CompatibleProcessItem[];
  filaments: CompatibleFilamentItem[];
}

export interface BackendHealth {
  status: string;
  slicer: string;
  version: string;
  api_version: string;
  auth_required?: boolean;
  capabilities?: {
    stl?: boolean;
    threemf?: boolean;
    multi_filament?: boolean;
    multi_plate?: boolean;
    preserve_xy?: boolean;
    mesh_repair?: boolean;
    mesh_auto_orient?: boolean;
    mesh_inspect?: boolean;
    profiles_count?: number;
    vendors_count?: number;
  };
}
