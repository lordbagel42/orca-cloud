import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { ChevronRight } from "lucide-react";
import type { WorkspaceAPI } from "../store/useWorkspace";
import type { BedType, GcodeFeatureType, ParsedGcode, SceneObject, SubPartType } from "../types";
import {
  computeLayOnFaceRotation,
  getObjectWorldBounds,
  groundObjectPosition,
  type PrimitiveKind,
} from "../lib/geometry";
import { INDEX_TO_FEATURE } from "../lib/gcode";
import { loadPrinterAssetSTL, loadPrinterAssetSVG } from "../lib/printerAssets";
import { VGCodeRenderer } from "../lib/vgcodeRenderer";
import {
  createOrcaHotbedMaterial,
  createOrcaModelMaterial,
  hexToSrgbRgb,
  loadViewportRenderConfig,
  OrcaPostPipeline,
  saveViewportRenderConfig,
  type OrcaViewportRenderConfig,
} from "../lib/orcaShaders";
import {
  applySpaceMouseToCamera,
  loadSpaceMousePrefs,
  saveSpaceMousePrefs,
  SpaceMouseController,
  type SpaceMousePrefs,
  type SpaceMouseStatus,
} from "../lib/spacemouse";

function createBedTexture(
  width: number,
  depth: number,
  bedType: BedType,
  logoImg: HTMLImageElement | null,
  excludeArea: [number, number][]
): THREE.CanvasTexture {
  const pxPerMm = 4;
  const cw = Math.min(2048, Math.max(512, Math.round(width * pxPerMm)));
  const ch = Math.min(2048, Math.max(512, Math.round(depth * pxPerMm)));
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d")!;

  // Direct port of OrcaSlicer 2.5.0 printbed.fs radial gradient (#5d5d5d center -> #3c3c3c edge, subtly tinted per plate)
  const palette: Record<BedType, { center: string; edge: string; minor: string; major: string }> = {
    "Textured PEI Plate": { center: "#4e4d49", edge: "#353432", minor: "rgba(232,202,148,0.12)", major: "rgba(232,202,148,0.25)" },
    "Smooth PEI Plate": { center: "#4a4f57", edge: "#32363d", minor: "rgba(210,224,242,0.10)", major: "rgba(210,224,242,0.24)" },
    "Cool Plate": { center: "#464d56", edge: "#2f353d", minor: "rgba(186,210,235,0.10)", major: "rgba(186,210,235,0.24)" },
    "High Temp Plate": { center: "#4c484d", edge: "#343136", minor: "rgba(240,170,170,0.10)", major: "rgba(240,170,170,0.22)" },
    "Engineering Plate": { center: "#4b4f56", edge: "#34373d", minor: "rgba(210,220,234,0.11)", major: "rgba(210,220,234,0.25)" },
    "Textured Cool Plate": { center: "#454f5a", edge: "#2e363f", minor: "rgba(140,210,250,0.11)", major: "rgba(140,210,250,0.25)" },
  };
  const pal = palette[bedType] || palette["Textured PEI Plate"];

  const radGrad = ctx.createRadialGradient(cw * 0.5, ch * 0.5, cw * 0.04, cw * 0.5, ch * 0.5, cw * 0.65);
  radGrad.addColorStop(0, pal.center);
  radGrad.addColorStop(1, pal.edge);
  ctx.fillStyle = radGrad;
  ctx.fillRect(0, 0, cw, ch);

  // Subtle PEI speckle texture
  if (bedType.includes("Textured")) {
    ctx.fillStyle = "rgba(255,246,225,0.036)";
    for (let i = 0; i < 4200; i++) {
      const rx = (((i * 7919) % 10000) / 10000) * cw;
      const ry = (((i * 6271) % 10000) / 10000) * ch;
      ctx.fillRect(rx, ry, 2, 2);
    }
  }

  // Minor 10mm grid + Major 50mm grid
  for (let x = 0; x <= width; x += 10) {
    const px = (x / width) * cw;
    const major = x % 50 === 0;
    ctx.strokeStyle = major ? pal.major : pal.minor;
    ctx.lineWidth = major ? 1.5 : 1;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, ch);
    ctx.stroke();
  }
  for (let y = 0; y <= depth; y += 10) {
    const py = ch - (y / depth) * ch;
    const major = y % 50 === 0;
    ctx.strokeStyle = major ? pal.major : pal.minor;
    ctx.lineWidth = major ? 1.5 : 1;
    ctx.beginPath();
    ctx.moveTo(0, py);
    ctx.lineTo(cw, py);
    ctx.stroke();
  }

  // Official vendor SVG silkscreen texture (e.g. bbl-3dp-logo.svg) drawn cleanly above grid
  if (logoImg) {
    ctx.save();
    ctx.globalAlpha = 0.62;
    ctx.drawImage(logoImg, 0, 0, cw, ch);
    ctx.restore();
  }

  // Official printer bed exclusion area (e.g. Bambu Lab P1S front-left 18x28mm filament cutter zone)
  if (excludeArea.length >= 3) {
    ctx.save();
    ctx.beginPath();
    excludeArea.forEach(([ex, ey], idx) => {
      const px = (ex / width) * cw;
      const py = ch - (ey / depth) * ch;
      if (idx === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.closePath();
    ctx.fillStyle = "rgba(239, 68, 68, 0.22)";
    ctx.fill();
    ctx.clip();
    ctx.strokeStyle = "rgba(248, 113, 113, 0.55)";
    ctx.lineWidth = 2;
    for (let d = -ch; d < cw + ch; d += 12) {
      ctx.beginPath();
      ctx.moveTo(d, 0);
      ctx.lineTo(d + ch, ch);
      ctx.stroke();
    }
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    excludeArea.forEach(([ex, ey], idx) => {
      const px = (ex / width) * cw;
      const py = ch - (ey / depth) * ch;
      if (idx === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.closePath();
    ctx.strokeStyle = "rgba(248, 113, 113, 0.78)";
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.restore();
  }

  // Subtle neutral hairline border matching desktop OrcaSlicer (no heavy colored frame)
  ctx.strokeStyle = "rgba(255, 255, 255, 0.09)";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(1, 1, cw - 2, ch - 2);

  // Coordinate labels along left edge (Y) and top edge (X)
  ctx.fillStyle = "rgba(236,242,250,0.56)";
  ctx.font = `600 ${Math.round(cw * 0.016)}px monospace`;
  ctx.textAlign = "left";
  for (let x = 50; x < width; x += 50) {
    const px = (x / width) * cw;
    ctx.fillText(String(x), px + 4, Math.round(cw * 0.024));
  }
  for (let y = 50; y < depth; y += 50) {
    const py = ch - (y / depth) * ch;
    ctx.fillText(String(y), 8, py - 4);
  }
  // Only draw generic FRONT label when the printer has no official vendor bed SVG (avoids overlapping vendor markings)
  if (!logoImg) {
    ctx.textAlign = "center";
    ctx.font = `600 ${Math.round(cw * 0.019)}px sans-serif`;
    ctx.fillText(`FRONT · ${bedType.toUpperCase()}`, cw / 2, ch - 12);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function buildObjectBufferGeometry(
  obj: SceneObject,
  baseHex: string,
  filamentsHex: string[],
  showOverhangs: boolean,
  activeTool: string
): THREE.BufferGeometry {
  const geom = new THREE.BufferGeometry();
  const pos = obj.geometry.positions;
  const norm = obj.geometry.normals;
  geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geom.setAttribute("normal", new THREE.BufferAttribute(norm, 3));

  const triCount = obj.geometry.triangleCount;
  const colors = new Float32Array(triCount * 9);
  const baseCol = hexToSrgbRgb(baseHex);
  const overhangCol = hexToSrgbRgb("#ef4444");
  const enforceSupCol = hexToSrgbRgb("#22c55e");
  const blockSupCol = hexToSrgbRgb("#ef4444");
  const enforceSeamCol = hexToSrgbRgb("#ffffff");
  const blockSeamCol = hexToSrgbRgb("#f43f5e");
  const slotCols = filamentsHex.map((h) => hexToSrgbRgb(h));

  // World-space rotation for overhang detection
  const rotMat = new THREE.Matrix3().setFromMatrix4(
    new THREE.Matrix4().makeRotationFromEuler(
      new THREE.Euler(
        THREE.MathUtils.degToRad(obj.rotation[0]),
        THREE.MathUtils.degToRad(obj.rotation[1]),
        THREE.MathUtils.degToRad(obj.rotation[2]),
        "XYZ"
      )
    )
  );
  const tmpN = new THREE.Vector3();

  for (let t = 0; t < triCount; t++) {
    let col = baseCol;
    const pColor = obj.paintColor?.[t] || 0;
    if (pColor > 0 && slotCols[pColor - 1]) {
      col = slotCols[pColor - 1];
    }

    if (showOverhangs) {
      tmpN.set(norm[t * 9], norm[t * 9 + 1], norm[t * 9 + 2]).applyMatrix3(rotMat).normalize();
      if (tmpN.z < -0.68) col = overhangCol;
    }

    if (activeTool === "paint_support" || obj.paintSupport) {
      const ps = obj.paintSupport?.[t] || 0;
      if (ps === 1) col = enforceSupCol;
      else if (ps === 2) col = blockSupCol;
    }

    if (activeTool === "paint_seam" || obj.paintSeam) {
      const pm = obj.paintSeam?.[t] || 0;
      if (pm === 1) col = enforceSeamCol;
      else if (pm === 2) col = blockSeamCol;
    }

    const o = t * 9;
    colors[o] = col[0]; colors[o + 1] = col[1]; colors[o + 2] = col[2];
    colors[o + 3] = col[0]; colors[o + 4] = col[1]; colors[o + 5] = col[2];
    colors[o + 6] = col[0]; colors[o + 7] = col[1]; colors[o + 8] = col[2];
  }

  geom.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geom.computeBoundingSphere();
  return geom;
}

type CameraPresetId = "iso" | "top" | "bottom" | "front" | "back" | "left" | "right" | "fit";

interface ContextMenuState {
  x: number;
  y: number;
  objectId: string | null;
}

interface SubmenuState {
  id: string;
  top: number;
  left: number;
}

const CTX_PRIMITIVES: Array<{ kind: PrimitiveKind; label: string }> = [
  { kind: "benchy_test", label: "Overhang Boat Test" },
  { kind: "calibration_cube", label: "Calibration Cube (20 mm)" },
  { kind: "cube", label: "Cube (25 mm)" },
  { kind: "cylinder", label: "Cylinder" },
  { kind: "sphere", label: "Sphere" },
  { kind: "cone", label: "Cone" },
  { kind: "torus", label: "Torus" },
  { kind: "disc", label: "Disc" },
];

function createStudioBackdropTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 512;
  const ctx = c.getContext("2d")!;
  // OrcaSlicer dark-mode vertical viewport gradient (background.fs)
  const grad = ctx.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, "#262930");
  grad.addColorStop(0.55, "#202329");
  grad.addColorStop(1, "#191c21");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 512, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

export function Viewport3D({
  ws,
  onTriggerFileImport,
}: {
  ws: WorkspaceAPI;
  onTriggerFileImport?: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const ctxMenuRef = useRef<HTMLDivElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);
  const [submenu, setSubmenu] = useState<SubmenuState | null>(null);
  const [smStatus, setSmStatus] = useState<SpaceMouseStatus>({
    connected: false,
    source: null,
    deviceName: null,
    webHidSupported: typeof navigator !== "undefined" && "hid" in navigator,
  });
  const [smPrefs, setSmPrefs] = useState<SpaceMousePrefs>(() => loadSpaceMousePrefs());
  const [smPopoverOpen, setSmPopoverOpen] = useState(false);
  const [renderCfg, setRenderCfg] = useState<OrcaViewportRenderConfig>(() => loadViewportRenderConfig());
  const [renderPopOpen, setRenderPopOpen] = useState(false);
  const smControllerRef = useRef<SpaceMouseController | null>(null);
  const smPrefsRef = useRef<SpaceMousePrefs>(smPrefs);
  smPrefsRef.current = smPrefs;
  const renderCfgRef = useRef<OrcaViewportRenderConfig>(renderCfg);
  renderCfgRef.current = renderCfg;
  const smPopRef = useRef<HTMLDivElement>(null);
  const renderPopRef = useRef<HTMLDivElement>(null);
  const postPipelineRef = useRef<OrcaPostPipeline | null>(null);

  // Refs to Three.js scene objects
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const transformRef = useRef<TransformControls | null>(null);
  const bedGroupRef = useRef<THREE.Group | null>(null);
  const keyLightRef = useRef<THREE.DirectionalLight | null>(null);
  const modelsGroupRef = useRef<THREE.Group | null>(null);
  const overlayGroupRef = useRef<THREE.Group | null>(null);
  const gcodeGroupRef = useRef<THREE.Group | null>(null);
  const gcodeExtrasGroupRef = useRef<THREE.Group | null>(null);
  const vgRendererRef = useRef<{ gcode: ParsedGcode; renderer: VGCodeRenderer } | null>(null);
  const hotendGeomRef = useRef<THREE.BufferGeometry | null>(null);
  const objectMeshMapRef = useRef<Map<string, THREE.Mesh>>(new Map());

  // Keep latest ws ref for DOM event handlers
  const wsRef = useRef(ws);
  wsRef.current = ws;

  const isPaintingRef = useRef(false);

  // Initialize Three.js Scene once
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const scene = new THREE.Scene();
    const backdropTex = createStudioBackdropTexture();
    scene.background = backdropTex;
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(42, host.clientWidth / Math.max(1, host.clientHeight), 0.5, 4000);
    camera.up.set(0, 0, 1);
    camera.position.set(220, -190, 175);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(dpr);
    renderer.setSize(host.clientWidth, host.clientHeight);
    // Keep entire pipeline in native sRGB matching OrcaSlicer's OpenGL phong.fs / printbed.fs / libvgcode / ssao.fs
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const postPipeline = new OrcaPostPipeline(host.clientWidth * dpr, host.clientHeight * dpr);
    postPipelineRef.current = postPipeline;

    // Dedicated directional shadow-casting light (matches OrcaSlicer printbed_shadow.fs)
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.0);
    keyLight.position.set(220, -210, 380);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(2048, 2048);
    keyLight.shadow.bias = -0.0004;
    keyLight.shadow.normalBias = 0.02;
    keyLight.shadow.radius = 3.0;
    keyLight.shadow.camera.near = 60;
    keyLight.shadow.camera.far = 1100;
    keyLight.shadow.camera.left = -220;
    keyLight.shadow.camera.right = 220;
    keyLight.shadow.camera.top = 220;
    keyLight.shadow.camera.bottom = -220;
    keyLight.target.position.set(90, 90, 0);
    scene.add(keyLight);
    scene.add(keyLight.target);
    keyLightRef.current = keyLight;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    controls.target.set(90, 90, 15);
    controls.maxDistance = 1600;
    controls.minDistance = 20;
    controls.update();
    controlsRef.current = controls;

    const transform = new TransformControls(camera, renderer.domElement);
    transform.setSize(0.8);
    transform.addEventListener("dragging-changed", (ev) => {
      controls.enabled = !ev.value;
      if (!ev.value) {
        // Commit final transform to React store
        const attached = transform.object as THREE.Mesh | undefined;
        const oid = attached?.userData?.objectId as string | undefined;
        if (attached && oid) {
          const curWs = wsRef.current;
          const pos: [number, number, number] = [
            Number(attached.position.x.toFixed(2)),
            Number(attached.position.y.toFixed(2)),
            Number(Math.max(0, attached.position.z).toFixed(2)),
          ];
          const rot: [number, number, number] = [
            Number(THREE.MathUtils.radToDeg(attached.rotation.x).toFixed(1)),
            Number(THREE.MathUtils.radToDeg(attached.rotation.y).toFixed(1)),
            Number(THREE.MathUtils.radToDeg(attached.rotation.z).toFixed(1)),
          ];
          const scl: [number, number, number] = [
            Number(Math.max(0.05, attached.scale.x).toFixed(3)),
            Number(Math.max(0.05, attached.scale.y).toFixed(3)),
            Number(Math.max(0.05, attached.scale.z).toFixed(3)),
          ];
          curWs.updateObject(oid, { position: pos, rotation: rot, scale: scl });
        }
      }
    });
    scene.add(transform.getHelper());
    transformRef.current = transform;

    const bedGroup = new THREE.Group();
    const modelsGroup = new THREE.Group();
    const overlayGroup = new THREE.Group();
    const gcodeGroup = new THREE.Group();
    const gcodeExtrasGroup = new THREE.Group();
    scene.add(bedGroup, modelsGroup, overlayGroup, gcodeGroup, gcodeExtrasGroup);
    bedGroupRef.current = bedGroup;
    modelsGroupRef.current = modelsGroup;
    overlayGroupRef.current = overlayGroup;
    gcodeGroupRef.current = gcodeGroup;
    gcodeExtrasGroupRef.current = gcodeExtrasGroup;

    // Resize observer
    const ro = new ResizeObserver(() => {
      if (!host) return;
      const w = host.clientWidth;
      const h = Math.max(1, host.clientHeight);
      const curDpr = Math.min(window.devicePixelRatio || 1, 2);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setPixelRatio(curDpr);
      renderer.setSize(w, h);
      postPipeline.setSize(w * curDpr, h * curDpr);
    });
    ro.observe(host);

    // Raycasting for object click, lay-on-face, painting, measure, and context menu
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    const getHit = (e: PointerEvent | MouseEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const meshes = Array.from(objectMeshMapRef.current.values());
      return raycaster.intersectObjects(meshes, false);
    };

    const paintAtHit = (hit: THREE.Intersection) => {
      const curWs = wsRef.current;
      const oid = hit.object.userData?.objectId as string | undefined;
      if (!oid) return;
      const obj = curWs.activePlate.objects.find((o) => o.id === oid);
      if (!obj) return;

      const localPt = hit.object.worldToLocal(hit.point.clone());
      const radiusSq = curWs.paintBrushRadius * curWs.paintBrushRadius;
      const triCount = obj.geometry.triangleCount;
      const pos = obj.geometry.positions;

      const isSupport = curWs.tool === "paint_support";
      const isSeam = curWs.tool === "paint_seam";
      const isColor = curWs.tool === "paint_color";
      if (!isSupport && !isSeam && !isColor) return;

      const srcArr = isSupport ? obj.paintSupport : isSeam ? obj.paintSeam : obj.paintColor;
      const arr = srcArr ? new Uint8Array(srcArr) : new Uint8Array(triCount);
      const val = isColor
        ? curWs.paintFilamentIndex + 1
        : curWs.paintMode === "enforce"
        ? 1
        : curWs.paintMode === "block"
        ? 2
        : 0;

      let changed = false;
      for (let t = 0; t < triCount; t++) {
        const o = t * 9;
        const cx = (pos[o] + pos[o + 3] + pos[o + 6]) / 3;
        const cy = (pos[o + 1] + pos[o + 4] + pos[o + 7]) / 3;
        const cz = (pos[o + 2] + pos[o + 5] + pos[o + 8]) / 3;
        const dx = cx - localPt.x, dy = cy - localPt.y, dz = cz - localPt.z;
        if (dx * dx + dy * dy + dz * dz <= radiusSq) {
          if (arr[t] !== val) {
            arr[t] = val;
            changed = true;
          }
        }
      }
      if (!changed && hit.faceIndex != null && hit.faceIndex < triCount) {
        arr[hit.faceIndex] = val;
        changed = true;
      }
      if (changed) {
        if (isSupport) curWs.updateObject(obj.id, { paintSupport: arr }, false);
        else if (isSeam) curWs.updateObject(obj.id, { paintSeam: arr }, false);
        else curWs.updateObject(obj.id, { paintColor: arr }, false);
      }
    };

    let downXY = { x: 0, y: 0 };
    let rightDownXY = { x: 0, y: 0 };
    let activeTouchPointers = new Set<number>();
    let longPressTimer: number | null = null;
    let longPressTriggered = false;

    const clearLongPress = () => {
      if (longPressTimer !== null) {
        window.clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    };

    const openContextMenuAt = (clientX: number, clientY: number, hitEvent: { clientX: number; clientY: number }) => {
      const curWs = wsRef.current;
      setSubmenu(null);
      if (curWs.tab === "prepare") {
        const hits = getHit(hitEvent as PointerEvent);
        if (hits.length > 0) {
          const oid = hits[0].object.userData?.objectId as string | undefined;
          if (oid) {
            curWs.setSelectedObjectId(oid);
            curWs.setSelectedSubPartId(null);
            setCtxMenu({ x: clientX, y: clientY, objectId: oid });
            return;
          }
        }
      }
      setCtxMenu({ x: clientX, y: clientY, objectId: null });
    };

    const onPointerDown = (e: PointerEvent) => {
      setCtxMenu(null);
      setSubmenu(null);
      clearLongPress();
      longPressTriggered = false;
      downXY = { x: e.clientX, y: e.clientY };

      if (e.pointerType === "touch") {
        activeTouchPointers.add(e.pointerId);
        if (activeTouchPointers.size === 1) {
          const cx = e.clientX;
          const cy = e.clientY;
          longPressTimer = window.setTimeout(() => {
            longPressTimer = null;
            if (activeTouchPointers.size !== 1 || isPaintingRef.current || transform.dragging) return;
            longPressTriggered = true;
            if (typeof navigator !== "undefined" && "vibrate" in navigator) {
              try {
                navigator.vibrate(14);
              } catch {
                // ignore
              }
            }
            openContextMenuAt(cx, cy, { clientX: cx, clientY: cy });
          }, 480);
        }
      }

      if (e.button === 2) {
        rightDownXY = { x: e.clientX, y: e.clientY };
        return;
      }
      const curWs = wsRef.current;
      if (curWs.tab !== "prepare") return;

      const isPaintTool =
        curWs.tool === "paint_support" || curWs.tool === "paint_seam" || curWs.tool === "paint_color";
      if (isPaintTool && e.button === 0 && !e.shiftKey) {
        const hits = getHit(e);
        if (hits.length > 0) {
          clearLongPress();
          isPaintingRef.current = true;
          controls.enabled = false;
          paintAtHit(hits[0]);
        }
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      if (longPressTimer !== null && Math.hypot(e.clientX - downXY.x, e.clientY - downXY.y) > 8) {
        clearLongPress();
      }
      if (!isPaintingRef.current) return;
      const hits = getHit(e);
      if (hits.length > 0) paintAtHit(hits[0]);
    };

    const onPointerCancel = (e: PointerEvent) => {
      activeTouchPointers.delete(e.pointerId);
      clearLongPress();
    };

    const onPointerUp = (e: PointerEvent) => {
      activeTouchPointers.delete(e.pointerId);
      clearLongPress();
      if (longPressTriggered) {
        longPressTriggered = false;
        return;
      }
      if (isPaintingRef.current) {
        isPaintingRef.current = false;
        controls.enabled = true;
        return;
      }
      if (e.button !== 0 && e.pointerType !== "touch") return;
      const moved = Math.hypot(e.clientX - downXY.x, e.clientY - downXY.y);
      if (moved > 8) return;

      const curWs = wsRef.current;
      if (curWs.tab !== "prepare") return;
      if (transform.dragging) return;

      const hits = getHit(e);

      if (curWs.tool === "measure") {
        let pt: THREE.Vector3 | null = hits[0]?.point || null;
        if (!pt) {
          const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
          const targetPt = new THREE.Vector3();
          if (raycaster.ray.intersectPlane(plane, targetPt)) pt = targetPt;
        }
        if (pt) {
          const p: [number, number, number] = [Number(pt.x.toFixed(2)), Number(pt.y.toFixed(2)), Number(pt.z.toFixed(2))];
          curWs.setMeasurePoints((prev) => (prev.length >= 2 ? [p] : [...prev, p]));
        }
        return;
      }

      if (curWs.tool === "lay_on_face" && hits.length > 0 && hits[0].face) {
        const oid = hits[0].object.userData?.objectId as string | undefined;
        const obj = curWs.activePlate.objects.find((o) => o.id === oid);
        if (obj) {
          const normalMatrix = new THREE.Matrix3().getNormalMatrix(hits[0].object.matrixWorld);
          const worldNormal = hits[0].face.normal.clone().applyMatrix3(normalMatrix).normalize();
          const nextRot = computeLayOnFaceRotation(obj, worldNormal);
          const rotatedObj = { ...obj, rotation: nextRot };
          const groundedPos = groundObjectPosition(rotatedObj);
          curWs.updateObject(obj.id, { rotation: nextRot, position: groundedPos });
          curWs.setTool("select");
          curWs.notify("Aligned clicked face flat on build plate", "success");
        }
        return;
      }

      if (hits.length > 0) {
        const oid = hits[0].object.userData?.objectId as string | undefined;
        if (oid) {
          curWs.setSelectedObjectId(oid);
          curWs.setSelectedSubPartId(null);
        }
      } else {
        curWs.setSelectedObjectId(null);
        curWs.setSelectedSubPartId(null);
      }
    };

    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      // Only open context menu on a clean right-click, not after right-drag panning
      const rightMoved = Math.hypot(e.clientX - rightDownXY.x, e.clientY - rightDownXY.y);
      if (rightMoved > 6) return;
      openContextMenuAt(e.clientX, e.clientY, e);
    };

    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    renderer.domElement.addEventListener("contextmenu", onContextMenu);

    // 6-DOF 3Dconnexion SpaceMouse controller (WebHID + automatic Gamepad API fallback)
    const spaceMouse = new SpaceMouseController();
    smControllerRef.current = spaceMouse;
    setSmStatus(spaceMouse.getStatus());
    const unsubSmStatus = spaceMouse.onStatusChange((st) => {
      setSmStatus(st);
      if (st.connected && st.deviceName) {
        wsRef.current.notify(`Connected ${st.deviceName} (${st.source === "webhid" ? "WebHID" : "Gamepad"})`, "success");
      }
    });
    const unsubSmBtn = spaceMouse.onButtonPress((btnIdx) => {
      // Standard 3Dconnexion 2-button layout: Button 0 = Fit view, Button 1 = Isometric reset
      window.dispatchEvent(new CustomEvent("orca-camera-preset", { detail: btnIdx === 0 ? "fit" : "iso" }));
    });

    const worldUpVec = new THREE.Vector3(0, 0, 1);
    const viewRotMat = new THREE.Matrix3();
    const worldUpEyeVec = new THREE.Vector3();

    let rafId = 0;
    let lastTime = performance.now();
    const animate = (now = performance.now()) => {
      rafId = requestAnimationFrame(animate);
      const dt = (now - lastTime) / 1000;
      lastTime = now;
      const smAxes = spaceMouse.readAxes();
      const movedBySm = applySpaceMouseToCamera(smAxes, camera, controls, dt, smPrefsRef.current);
      if (!movedBySm) {
        controls.update();
      }
      camera.updateMatrixWorld();
      viewRotMat.setFromMatrix4(camera.matrixWorldInverse);
      worldUpEyeVec.copy(worldUpVec).applyMatrix3(viewRotMat).normalize();
      const lm = renderCfgRef.current.lightingModel === "studio" ? 1 : 0;
      const syncOrcaUniforms = (n: THREE.Object3D) => {
        const m = (n as THREE.Mesh).material as THREE.ShaderMaterial | undefined;
        if (m && m.uniforms && m.uniforms.uWorldUpEye) {
          m.uniforms.uWorldUpEye.value.copy(worldUpEyeVec);
          m.uniforms.uLightingModel.value = lm;
        }
      };
      modelsGroup.traverse(syncOrcaUniforms);
      overlayGroup.traverse(syncOrcaUniforms);
      postPipeline.render(renderer, scene, camera, renderCfgRef.current.ssaoEnabled);
    };
    animate();

    return () => {
      cancelAnimationFrame(rafId);
      unsubSmStatus();
      unsubSmBtn();
      spaceMouse.dispose();
      smControllerRef.current = null;
      postPipeline.dispose();
      postPipelineRef.current = null;
      ro.disconnect();
      if (vgRendererRef.current) {
        vgRendererRef.current.renderer.dispose();
        vgRendererRef.current = null;
      }
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      clearLongPress();
      renderer.domElement.removeEventListener("contextmenu", onContextMenu);
      controls.dispose();
      transform.dispose();
      backdropTex.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  // Load official 3D hotend STL mesh whenever printer model changes
  useEffect(() => {
    let cancelled = false;
    const url = ws.machineModel?.hotend_model_url;
    if (!url) {
      hotendGeomRef.current = null;
      return;
    }
    loadPrinterAssetSTL(url).then((geom) => {
      if (!cancelled) hotendGeomRef.current = geom;
    });
    return () => {
      cancelled = true;
    };
  }, [ws.machineModel?.hotend_model_url]);

  // Rebuild Printer Build Plate (official STL bed model + official SVG silkscreen + exclusion area + volume cage)
  useEffect(() => {
    const group = bedGroupRef.current;
    if (!group) return;
    let cancelled = false;

    const clearBedGroup = () => {
      while (group.children.length) {
        const c = group.children.pop()!;
        c.traverse((n) => {
          const mesh = n as THREE.Mesh;
          if (mesh.geometry && !mesh.userData?.sharedAsset) mesh.geometry.dispose();
          const m = mesh.material;
          if (Array.isArray(m)) m.forEach((x) => {
            if ((x as THREE.MeshStandardMaterial).map) (x as THREE.MeshStandardMaterial).map!.dispose();
            x.dispose();
          });
          else if (m) {
            if ((m as THREE.MeshStandardMaterial).map) (m as THREE.MeshStandardMaterial).map!.dispose();
            m.dispose();
          }
        });
      }
    };

    const [bw, bd, bh] = ws.buildVolume;
    const bedModelUrl = ws.machineModel?.bed_model_url || null;
    const bedTextureUrl = ws.machineModel?.bed_texture_url || null;
    const excludeArea = ws.bedExcludeArea || [];

    const buildPlate = (bedStlGeom: THREE.BufferGeometry | null, logoImg: HTMLImageElement | null) => {
      if (cancelled) return;
      clearBedGroup();

      // Official 3D printer build plate STL (e.g. bbl-3dp-A1M.stl, bbl-3dp-X1.stl) shaded with OrcaSlicer hotbed.fs
      if (bedStlGeom) {
        const stlMat = createOrcaHotbedMaterial(ws.bedType.includes("Textured") ? "#52504c" : "#4f545e", 0.04, true);
        const stlMesh = new THREE.Mesh(bedStlGeom, stlMat);
        stlMesh.position.set(0, 0, -0.05);
        stlMesh.userData = { sharedAsset: true };
        group.add(stlMesh);

        const chassis = new THREE.Mesh(
          new THREE.BoxGeometry(bw + 2, bd + 2, 2.0),
          createOrcaHotbedMaterial("#2b2f38", 0.02, false)
        );
        chassis.position.set(bw / 2, bd / 2, -1.65);
        group.add(chassis);
      } else {
        const plateBase = new THREE.Mesh(
          new THREE.BoxGeometry(bw + 4, bd + 4, 2.2),
          createOrcaHotbedMaterial("#363a42", 0.03, false)
        );
        plateBase.position.set(bw / 2, bd / 2, -1.25);
        group.add(plateBase);
      }

      // Printable surface overlay (unlit OrcaSlicer printbed.fs radial gradient + grid + official SVG logo + exclusion zone)
      const tex = createBedTexture(bw, bd, ws.bedType, logoImg, excludeArea);
      const bedGeo = new THREE.PlaneGeometry(bw, bd);
      const bedMat = new THREE.MeshBasicMaterial({
        map: tex,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      });
      const bedMesh = new THREE.Mesh(bedGeo, bedMat);
      bedMesh.position.set(bw / 2, bd / 2, -0.02);
      group.add(bedMesh);

      // Unified soft contact shadow receiver directly on the build plate (matches OrcaSlicer printbed_shadow.fs)
      if (renderCfg.shadowsEnabled) {
        const shadowGeo = new THREE.PlaneGeometry(bw, bd);
        const shadowMat = new THREE.ShadowMaterial({
          color: 0x000000,
          opacity: 0.3,
          transparent: true,
          depthWrite: false,
        });
        const shadowMesh = new THREE.Mesh(shadowGeo, shadowMat);
        shadowMesh.position.set(bw / 2, bd / 2, 0.01);
        shadowMesh.receiveShadow = true;
        group.add(shadowMesh);
      }

      // Re-center shadow frustum cleanly on the active build plate
      if (keyLightRef.current) {
        const kl = keyLightRef.current;
        const half = Math.max(bw, bd) * 0.78;
        kl.position.set(bw / 2 + half * 1.2, bd / 2 - half * 1.1, Math.max(360, bh * 1.8));
        kl.target.position.set(bw / 2, bd / 2, 0);
        kl.target.updateMatrixWorld();
        kl.shadow.camera.left = -half;
        kl.shadow.camera.right = half;
        kl.shadow.camera.top = half;
        kl.shadow.camera.bottom = -half;
        kl.shadow.camera.updateProjectionMatrix();
      }

      // Origin XYZ axes triad (24mm)
      const addAxis = (to: [number, number, number], hex: string) => {
        const g = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(0, 0, 0.2),
          new THREE.Vector3(to[0], to[1], to[2] + 0.2),
        ]);
        group.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: hex })));
      };
      addAxis([24, 0, 0], "#ef4444");
      addAxis([0, 24, 0], "#22c55e");
      addAxis([0, 0, 24], "#3b82f6");

      // Re-aim and scale camera distance cleanly when build volume changes
      if (controlsRef.current && cameraRef.current) {
        const cx = bw / 2;
        const cy = bd / 2;
        const dist = Math.max(bw, bd) * 1.48;
        controlsRef.current.target.set(cx, cy, Math.min(20, bh * 0.1));
        cameraRef.current.position.set(cx + dist * 0.72, cy - dist * 0.88, dist * 0.66);
        controlsRef.current.update();
      }
    };

    // Draw immediately with fallback, then upgrade seamlessly once STL/SVG resolve (usually <5ms cached)
    buildPlate(null, null);
    if (bedModelUrl || bedTextureUrl) {
      Promise.all([
        bedModelUrl ? loadPrinterAssetSTL(bedModelUrl) : Promise.resolve(null),
        bedTextureUrl ? loadPrinterAssetSVG(bedTextureUrl) : Promise.resolve(null),
      ]).then(([stlGeom, svgImg]) => {
        buildPlate(stlGeom, svgImg);
      });
    }

    return () => {
      cancelled = true;
    };
  }, [
    ws.buildVolume,
    ws.bedType,
    ws.machineModel?.bed_model_url,
    ws.machineModel?.bed_texture_url,
    ws.bedExcludeArea,
    renderCfg.shadowsEnabled,
  ]);

  // Rebuild Prepare 3D Models + SubParts + TransformControls + Cut Plane + Measure Line
  useEffect(() => {
    const group = modelsGroupRef.current;
    const overlay = overlayGroupRef.current;
    const transform = transformRef.current;
    if (!group || !overlay || !transform) return;

    transform.detach();
    objectMeshMapRef.current.clear();

    const clearGroup = (g: THREE.Group) => {
      while (g.children.length) {
        const c = g.children.pop()!;
        c.traverse((n) => {
          if ((n as THREE.Mesh).geometry) (n as THREE.Mesh).geometry.dispose();
          const m = (n as THREE.Mesh).material;
          if (Array.isArray(m)) m.forEach((x) => x.dispose());
          else if (m) m.dispose();
        });
      }
    };
    clearGroup(group);
    clearGroup(overlay);

    const showPrepareModels = ws.tab === "prepare" || (ws.tab === "preview" && ws.showGhost);
    if (!showPrepareModels) return;

    const filamentColors = ws.filaments.map((f) => f.color);
    const [bw, bd, bh] = ws.buildVolume;

    for (const obj of ws.activePlate.objects) {
      if (!obj.visible) continue;
      const baseHex = filamentColors[obj.filamentIndex] || "#22c55e";
      const geom = buildObjectBufferGeometry(obj, baseHex, filamentColors, ws.showOverhangs, ws.tool);
      const isSelected = ws.tab === "prepare" && obj.id === ws.selectedObjectId;
      const mat =
        ws.tab === "preview"
          ? createOrcaModelMaterial({
              lightingModel: renderCfg.lightingModel,
              buildVolume: ws.buildVolume,
              opacity: 0.18,
              overrideHex: "#94a3b8",
            })
          : createOrcaModelMaterial({
              lightingModel: renderCfg.lightingModel,
              buildVolume: ws.buildVolume,
              selected: isSelected,
              wireframe: ws.wireframe,
            });

      const mesh = new THREE.Mesh(geom, mat);
      if (ws.tab === "prepare") {
        mesh.castShadow = renderCfg.shadowsEnabled;
      }
      mesh.position.set(obj.position[0], obj.position[1], obj.position[2]);
      mesh.rotation.set(
        THREE.MathUtils.degToRad(obj.rotation[0]),
        THREE.MathUtils.degToRad(obj.rotation[1]),
        THREE.MathUtils.degToRad(obj.rotation[2]),
        "XYZ"
      );
      mesh.scale.set(obj.scale[0], obj.scale[1], obj.scale[2]);
      mesh.userData = { objectId: obj.id };
      group.add(mesh);
      objectMeshMapRef.current.set(obj.id, mesh);

      // Selection or out-of-bounds bounding box
      if (ws.tab === "prepare") {
        const wb = getObjectWorldBounds(obj);
        const oob =
          wb.min[0] < -0.5 || wb.max[0] > bw + 0.5 ||
          wb.min[1] < -0.5 || wb.max[1] > bd + 0.5 ||
          wb.max[2] > bh + 0.5;
        if (isSelected || oob) {
          const box = new THREE.BoxGeometry(wb.size[0] + 0.6, wb.size[1] + 0.6, wb.size[2] + 0.6);
          const edges = new THREE.LineSegments(
            new THREE.EdgesGeometry(box),
            new THREE.LineBasicMaterial({ color: oob ? "#ef4444" : "#38bdf8" })
          );
          box.dispose();
          edges.position.set(wb.center[0], wb.center[1], wb.center[2]);
          overlay.add(edges);
        }

        // Render subParts (modifiers / negative parts / support enforcers & blockers)
        const subColors: Record<SubPartType, string> = {
          modifier_part: "#f59e0b",
          negative_part: "#ef4444",
          support_enforcer: "#22c55e",
          support_blocker: "#f43f5e",
        };
        for (const sp of obj.subParts) {
          const spGeom = new THREE.BufferGeometry();
          spGeom.setAttribute("position", new THREE.BufferAttribute(sp.geometry.positions, 3));
          spGeom.setAttribute("normal", new THREE.BufferAttribute(sp.geometry.normals, 3));
          const spMat = createOrcaModelMaterial({
            lightingModel: renderCfg.lightingModel,
            buildVolume: ws.buildVolume,
            opacity: 0.38,
            overrideHex: subColors[sp.subtype],
          });
          const spMesh = new THREE.Mesh(spGeom, spMat);
          spMesh.position.set(
            obj.position[0] + sp.position[0],
            obj.position[1] + sp.position[1],
            obj.position[2] + sp.position[2]
          );
          spMesh.scale.set(sp.scale[0], sp.scale[1], sp.scale[2]);
          overlay.add(spMesh);
        }
      }
    }

    // Attach TransformControls gizmo for move / rotate / scale
    if (ws.tab === "prepare" && ws.selectedObjectId && (ws.tool === "move" || ws.tool === "rotate" || ws.tool === "scale")) {
      const targetMesh = objectMeshMapRef.current.get(ws.selectedObjectId);
      if (targetMesh) {
        transform.setMode(ws.tool === "move" ? "translate" : ws.tool);
        transform.attach(targetMesh);
      }
    }

    // Cut Plane visual indicator
    if (ws.tab === "prepare" && ws.tool === "cut" && ws.selectedObject) {
      const wb = getObjectWorldBounds(ws.selectedObject);
      const pw = Math.max(wb.size[0] + 24, 40);
      const pd = Math.max(wb.size[1] + 24, 40);
      const cutMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(pw, pd),
        new THREE.MeshBasicMaterial({
          color: "#22c55e",
          transparent: true,
          opacity: 0.25,
          side: THREE.DoubleSide,
          depthWrite: false,
        })
      );
      cutMesh.position.set(wb.center[0], wb.center[1], ws.cutHeight);
      overlay.add(cutMesh);

      const border = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.PlaneGeometry(pw, pd)),
        new THREE.LineBasicMaterial({ color: "#4ade80" })
      );
      border.position.set(wb.center[0], wb.center[1], ws.cutHeight);
      overlay.add(border);
    }

    // Measure 3D line + points
    if (ws.tab === "prepare" && ws.measurePoints.length > 0) {
      for (const pt of ws.measurePoints) {
        const dot = new THREE.Mesh(
          new THREE.SphereGeometry(1.1, 14, 14),
          new THREE.MeshBasicMaterial({ color: "#38bdf8" })
        );
        dot.position.set(pt[0], pt[1], pt[2]);
        overlay.add(dot);
      }
      if (ws.measurePoints.length === 2) {
        const [a, b] = ws.measurePoints;
        const lineGeo = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(a[0], a[1], a[2]),
          new THREE.Vector3(b[0], b[1], b[2]),
        ]);
        overlay.add(new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: "#38bdf8" })));
      }
    }
  }, [
    ws.tab,
    ws.activePlate.objects,
    ws.selectedObjectId,
    ws.selectedObject,
    ws.filaments,
    ws.buildVolume,
    ws.tool,
    ws.showOverhangs,
    ws.wireframe,
    ws.cutHeight,
    ws.measurePoints,
    ws.showGhost,
    renderCfg.shadowsEnabled,
  ]);

  // Rebuild Preview G-code Toolpaths via direct WebGL2 port of OrcaSlicer's libvgcode volumetric renderer
  useEffect(() => {
    const group = gcodeGroupRef.current;
    const extras = gcodeExtrasGroupRef.current;
    if (!group || !extras) return;

    // Clear per-update overlays (seams, retractions, nozzle, section cut guide) without touching cached VGCodeRenderer
    while (extras.children.length) {
      const c = extras.children.pop()!;
      c.traverse((n) => {
        const mesh = n as THREE.Mesh;
        if (mesh.geometry && !mesh.userData?.sharedAsset) mesh.geometry.dispose();
        const m = mesh.material;
        if (Array.isArray(m)) m.forEach((x) => x.dispose());
        else if (m) m.dispose();
      });
    }

    if (ws.tab !== "preview" || !ws.parsedGcode) {
      group.visible = false;
      return;
    }

    const g = ws.parsedGcode;
    group.visible = true;

    // Create or reuse GPU VGCodeRenderer for this ParsedGcode (textures stay resident on GPU!)
    if (!vgRendererRef.current || vgRendererRef.current.gcode !== g) {
      if (vgRendererRef.current) {
        group.remove(vgRendererRef.current.renderer.group);
        vgRendererRef.current.renderer.dispose();
      }
      const vg = new VGCodeRenderer(g);
      vgRendererRef.current = { gcode: g, renderer: vg };
      group.add(vg.group);
    }

    const maxSeg = Math.min(g.segmentCount, Math.max(0, ws.moveIndex));
    vgRendererRef.current.renderer.update({
      layerBottom: ws.layerBottom,
      layerTop: ws.layerTop,
      moveIndex: maxSeg,
      hiddenFeatures: ws.hiddenFeatures as Set<GcodeFeatureType>,
      colorScheme: ws.colorScheme,
      filaments: ws.filaments,
      realisticGloss: ws.realisticGloss,
      dimLowerLayers: ws.dimLowerLayers,
      sectionCutEnabled: ws.sectionCutEnabled,
      sectionCutAxis: ws.sectionCutAxis,
      sectionCutPosition: ws.sectionCutPosition,
    });

    if (maxSeg === 0) return;

    const topZ = g.layers[ws.layerTop]?.z ?? Infinity;
    const botZ = g.layers[ws.layerBottom]?.z ?? 0;

    const passesSectionCut = (px: number, py: number, pz: number) => {
      if (!ws.sectionCutEnabled) return true;
      if (ws.sectionCutAxis === "x") return px <= ws.sectionCutPosition + 0.05;
      if (ws.sectionCutAxis === "y") return py >= ws.sectionCutPosition - 0.05;
      return pz <= ws.sectionCutPosition + 0.05;
    };

    // Z-Seam markers
    if (ws.showSeams && g.seams.length >= 3) {
      const pts: number[] = [];
      for (let i = 0; i < g.seams.length; i += 3) {
        const sx = g.seams[i], sy = g.seams[i + 1], sz = g.seams[i + 2];
        if (sz >= botZ - 0.05 && sz <= topZ + 0.05 && passesSectionCut(sx, sy, sz)) {
          pts.push(sx, sy, sz);
        }
      }
      if (pts.length) {
        const pg = new THREE.BufferGeometry();
        pg.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
        extras.add(new THREE.Points(pg, new THREE.PointsMaterial({ color: "#ffffff", size: 2.2, sizeAttenuation: true })));
      }
    }

    // Retraction markers
    if (ws.showRetractions && g.retractions.length >= 3) {
      const pts: number[] = [];
      for (let i = 0; i < g.retractions.length; i += 3) {
        const rx = g.retractions[i], ry = g.retractions[i + 1], rz = g.retractions[i + 2];
        if (rz >= botZ - 0.05 && rz <= topZ + 0.05 && passesSectionCut(rx, ry, rz)) {
          pts.push(rx, ry, rz);
        }
      }
      if (pts.length) {
        const pg = new THREE.BufferGeometry();
        pg.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
        extras.add(new THREE.Points(pg, new THREE.PointsMaterial({ color: "#38bdf8", size: 2.4, sizeAttenuation: true })));
      }
    }

    // Section Cut Plane visual guide
    if (ws.sectionCutEnabled) {
      const bMin = g.bounds.min;
      const bMax = g.bounds.max;
      const pad = 10;
      const sx = Math.max(20, bMax[0] - bMin[0] + pad * 2);
      const sy = Math.max(20, bMax[1] - bMin[1] + pad * 2);
      const sz = Math.max(12, bMax[2] - bMin[2] + pad);
      const cx = (bMin[0] + bMax[0]) * 0.5;
      const cy = (bMin[1] + bMax[1]) * 0.5;
      const cz = Math.max(sz * 0.5, (bMin[2] + bMax[2]) * 0.5);
      const planeW = ws.sectionCutAxis === "x" ? sy : sx;
      const planeH = ws.sectionCutAxis === "z" ? sy : sz;
      const planeGeom = new THREE.PlaneGeometry(planeW, planeH);
      const cutFrame = new THREE.LineSegments(
        new THREE.EdgesGeometry(planeGeom),
        new THREE.LineBasicMaterial({ color: "#38bdf8", transparent: true, opacity: 0.75 })
      );
      planeGeom.dispose();
      if (ws.sectionCutAxis === "x") {
        cutFrame.rotation.set(Math.PI / 2, Math.PI / 2, 0);
        cutFrame.position.set(ws.sectionCutPosition, cy, cz);
      } else if (ws.sectionCutAxis === "y") {
        cutFrame.rotation.set(Math.PI / 2, 0, 0);
        cutFrame.position.set(cx, ws.sectionCutPosition, cz);
      } else {
        cutFrame.position.set(cx, cy, ws.sectionCutPosition);
      }
      extras.add(cutFrame);
    }

    // Animated Extruder Nozzle Head (matches OrcaSlicer desktop: only visible while scrubbing the move slider or playing!)
    const activeLayerEndSeg = g.layers[ws.layerTop]?.endSegment ?? g.segmentCount;
    const isScrubbingMoves = ws.isPlaying || maxSeg < activeLayerEndSeg;
    if (ws.showNozzle && maxSeg > 0 && isScrubbingMoves) {
      const travelIdx = INDEX_TO_FEATURE.indexOf("Travel");
      const customIdx = INDEX_TO_FEATURE.indexOf("Custom");
      let nozzleSeg = maxSeg - 1;
      for (let i = maxSeg - 1; i >= 0; i--) {
        const l = g.layersArr[i];
        if (l < ws.layerBottom || l > ws.layerTop) continue;
        const fi = g.features[i];
        if (fi !== travelIdx && fi !== customIdx) {
          nozzleSeg = i;
          break;
        }
      }
      const last = nozzleSeg * 3;
      const nx = g.ends[last], ny = g.ends[last + 1], nz = g.ends[last + 2];
      const hotendGeom = hotendGeomRef.current;
      if (hotendGeom) {
        const nozzle = new THREE.Mesh(
          hotendGeom,
          createOrcaHotbedMaterial("#b8c2d0", 0.08, false)
        );
        // Official bbl-3dp-hotend.stl has nozzle tip at Z=+12 and heatsink at Z=0; flip so tip points down onto bead
        nozzle.rotation.set(Math.PI, 0, 0);
        nozzle.position.set(nx, ny, nz + 12.15);
        nozzle.userData = { sharedAsset: true };
        extras.add(nozzle);
      } else {
        const cone = new THREE.ConeGeometry(2.6, 8, 16);
        cone.rotateX(-Math.PI / 2);
        const nozzle = new THREE.Mesh(
          cone,
          createOrcaHotbedMaterial("#d97706", 0.14, false)
        );
        nozzle.position.set(nx, ny, nz + 4.1);
        extras.add(nozzle);
      }
    }
  }, [
    ws.tab,
    ws.parsedGcode,
    ws.layerTop,
    ws.layerBottom,
    ws.moveIndex,
    ws.isPlaying,
    ws.colorScheme,
    ws.hiddenFeatures,
    ws.filaments,
    ws.showSeams,
    ws.showRetractions,
    ws.showNozzle,
    ws.realisticGloss,
    ws.dimLowerLayers,
    ws.sectionCutEnabled,
    ws.sectionCutAxis,
    ws.sectionCutPosition,
  ]);

  // Camera presets (OrcaSlicer desktop 0=Iso, 1=Top, 2=Bottom, 3=Front, 4=Back, 5=Left, 6=Right, Shift+F=Fit)
  const setCameraPreset = useCallback((preset: CameraPresetId) => {
    const cam = cameraRef.current;
    const ctrl = controlsRef.current;
    const curWs = wsRef.current;
    if (!cam || !ctrl) return;
    if (preset === "fit" && curWs.tab === "preview" && curWs.parsedGcode) {
      const bMin = curWs.parsedGcode.bounds.min;
      const bMax = curWs.parsedGcode.bounds.max;
      const cx = (bMin[0] + bMax[0]) * 0.5;
      const cy = (bMin[1] + bMax[1]) * 0.5;
      const cz = (bMin[2] + bMax[2]) * 0.5;
      const span = Math.max(18, bMax[0] - bMin[0], bMax[1] - bMin[1], bMax[2] - bMin[2]);
      const dist = span * 1.95;
      ctrl.target.set(cx, cy, cz);
      cam.position.set(cx + dist * 0.62, cy - dist * 0.88, cz + dist * 0.62);
      ctrl.update();
      return;
    }
    if (preset === "fit" && curWs.tab === "prepare" && curWs.selectedObject) {
      const wb = getObjectWorldBounds(curWs.selectedObject);
      const span = Math.max(24, wb.size[0], wb.size[1], wb.size[2]);
      const dist = span * 2.2;
      ctrl.target.set(wb.center[0], wb.center[1], wb.center[2]);
      cam.position.set(wb.center[0] + dist * 0.68, wb.center[1] - dist * 0.85, wb.center[2] + dist * 0.62);
      ctrl.update();
      return;
    }
    const [bw, bd] = curWs.buildVolume;
    const cx = bw / 2, cy = bd / 2;
    const dist = Math.max(bw, bd) * 1.48;
    ctrl.target.set(cx, cy, 18);
    if (preset === "iso" || preset === "fit") cam.position.set(cx + dist * 0.72, cy - dist * 0.88, dist * 0.66);
    else if (preset === "top") cam.position.set(cx, cy - 0.5, dist * 1.35);
    else if (preset === "bottom") cam.position.set(cx, cy - 0.5, -dist * 1.25);
    else if (preset === "front") cam.position.set(cx, cy - dist * 1.2, 42);
    else if (preset === "back") cam.position.set(cx, cy + dist * 1.2, 42);
    else if (preset === "left") cam.position.set(cx - dist * 1.2, cy, 42);
    else if (preset === "right") cam.position.set(cx + dist * 1.2, cy, 42);
    ctrl.update();
  }, []);

  // Listen to global camera preset hotkey events (0-6, Shift+F)
  useEffect(() => {
    const onCam = (ev: Event) => {
      const preset = (ev as CustomEvent<CameraPresetId>).detail;
      if (preset) setCameraPreset(preset);
    };
    window.addEventListener("orca-camera-preset", onCam);
    return () => window.removeEventListener("orca-camera-preset", onCam);
  }, [setCameraPreset]);

  // Dismiss SpaceMouse and Viewport Shading popovers on outside click
  useEffect(() => {
    if (!smPopoverOpen && !renderPopOpen) return;
    const onDown = (e: PointerEvent) => {
      if (smPopoverOpen && smPopRef.current && !smPopRef.current.contains(e.target as Node)) {
        setSmPopoverOpen(false);
      }
      if (renderPopOpen && renderPopRef.current && !renderPopRef.current.contains(e.target as Node)) {
        setRenderPopOpen(false);
      }
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [smPopoverOpen, renderPopOpen]);

  const updateRenderCfg = (patch: Partial<OrcaViewportRenderConfig>) => {
    setRenderCfg((prev) => {
      const next = { ...prev, ...patch };
      saveViewportRenderConfig(next);
      return next;
    });
  };

  const handleSpaceMouseClick = async () => {
    setRenderPopOpen(false);
    if (smStatus.connected) {
      setSmPopoverOpen((v) => !v);
      return;
    }
    const ctrl = smControllerRef.current;
    if (!ctrl) return;
    if (!smStatus.webHidSupported) {
      setSmPopoverOpen((v) => !v);
      return;
    }
    try {
      const next = await ctrl.connect();
      if (!next.connected) {
        ws.notify("No SpaceMouse selected", "info");
      }
    } catch (err) {
      ws.notify(err instanceof Error ? err.message : "Could not connect SpaceMouse", "error");
    }
  };

  const updateSmPrefs = (patch: Partial<SpaceMousePrefs>) => {
    setSmPrefs((prev) => {
      const next = { ...prev, ...patch };
      saveSpaceMousePrefs(next);
      return next;
    });
  };

  // Dismiss context menu on outside click or Escape
  useEffect(() => {
    if (!ctxMenu) return;
    const onDown = (e: MouseEvent) => {
      if (ctxMenuRef.current && !ctxMenuRef.current.contains(e.target as Node)) {
        setCtxMenu(null);
        setSubmenu(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setCtxMenu(null);
        setSubmenu(null);
      }
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [ctxMenu]);

  const closeCtx = () => {
    setCtxMenu(null);
    setSubmenu(null);
  };

  const openSubmenu = (id: string, el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    const subW = 204;
    const openLeft = rect.right + subW + 8 > window.innerWidth;
    const left = openLeft ? Math.max(8, rect.left - subW - 4) : rect.right + 4;
    const top = Math.max(8, Math.min(window.innerHeight - 240, rect.top - 4));
    setSubmenu({ id, top, left });
  };

  const ctxObject = ctxMenu?.objectId
    ? ws.activePlate.objects.find((o) => o.id === ctxMenu.objectId) || null
    : null;
  const ctxLeft = ctxMenu ? Math.max(8, Math.min(ctxMenu.x, window.innerWidth - 238)) : 0;
  const ctxTop = ctxMenu
    ? Math.max(8, Math.min(ctxMenu.y, window.innerHeight - (ctxObject ? 490 : 340)))
    : 0;

  return (
    <div
      className="viewport-canvas-host"
      ref={hostRef}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer.files?.length) ws.importFiles(e.dataTransfer.files);
      }}
    >
      {dragOver && (
        <div
          style={{
            position: "absolute",
            inset: 12,
            border: "2px dashed var(--accent)",
            borderRadius: 12,
            background: "rgba(34, 197, 94, 0.08)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 15,
            fontWeight: 600,
            color: "var(--accent-text)",
            pointerEvents: "none",
            zIndex: 50,
          }}
        >
          Drop STL, OBJ, or 3MF files onto the build plate
        </div>
      )}

      {/* Camera Presets HUD (raised above move scrubber in Preview mode) */}
      <div
        className="camera-hud"
        style={ws.tab === "preview" && ws.parsedGcode ? { bottom: 60 } : undefined}
        role="toolbar"
        aria-label="Camera views"
      >
        {(
          [
            ["iso", "Iso", "0"],
            ["top", "Top", "1"],
            ["front", "Front", "3"],
            ["right", "Right", "6"],
            ["fit", "Fit", "Shift+F"],
          ] as const
        ).map(([id, label, keyHint]) => (
          <button
            key={id}
            className="camera-btn"
            aria-label={`${label} view (${keyHint})`}
            onClick={() => setCameraPreset(id)}
          >
            {label}
          </button>
        ))}
        {ws.tab === "prepare" && (
          <button
            className={`camera-btn ${ws.wireframe ? "active" : ""}`}
            aria-label="Wire — toggle wireframe (W)"
            onClick={() => ws.setWireframe((v) => !v)}
          >
            Wire
          </button>
        )}
        <div ref={renderPopRef} style={{ position: "relative", display: "inline-flex" }}>
          <button
            className={`camera-btn ${renderPopOpen ? "active" : ""}`}
            aria-label="Viewport rendering — shader, SSAO, and shadows"
            title="Viewport rendering settings (Orca Studio / Classic, SSAO, Shadows)"
            onClick={() => {
              setRenderPopOpen((v) => !v);
              setSmPopoverOpen(false);
            }}
          >
            View
          </button>

          {renderPopOpen && (
            <div className="spacemouse-popover" role="dialog" aria-label="Viewport rendering settings">
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <strong style={{ fontSize: 12 }}>Viewport Shading</strong>
                <span className="mono" style={{ fontSize: 10.5, color: "var(--text-muted)" }}>
                  Orca 2.5
                </span>
              </div>
              <div className="segmented" role="group" aria-label="Lighting shader">
                <button
                  type="button"
                  className={`segmented-btn ${renderCfg.lightingModel === "studio" ? "active" : ""}`}
                  onClick={() => updateRenderCfg({ lightingModel: "studio" })}
                >
                  Studio
                </button>
                <button
                  type="button"
                  className={`segmented-btn ${renderCfg.lightingModel === "classic" ? "active" : ""}`}
                  onClick={() => updateRenderCfg({ lightingModel: "classic" })}
                >
                  Orca Classic
                </button>
              </div>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={renderCfg.ssaoEnabled}
                  onChange={(e) => updateRenderCfg({ ssaoEnabled: e.target.checked })}
                />
                Ambient occlusion (SSAO)
              </label>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={renderCfg.shadowsEnabled}
                  onChange={(e) => updateRenderCfg({ shadowsEnabled: e.target.checked })}
                />
                Plate contact shadows
              </label>
            </div>
          )}
        </div>
        <div ref={smPopRef} style={{ position: "relative", display: "inline-flex" }}>
          <button
            className={`camera-btn spacemouse-btn ${smStatus.connected ? "active" : ""}`}
            aria-label={
              smStatus.connected
                ? `3D SpaceMouse connected (${smStatus.deviceName}) — open settings`
                : "3D SpaceMouse — connect 3Dconnexion controller"
            }
            title={
              smStatus.connected
                ? `${smStatus.deviceName} (${smStatus.source === "webhid" ? "WebHID" : "Gamepad"})`
                : "Connect 3Dconnexion SpaceMouse (WebHID / Gamepad)"
            }
            onClick={handleSpaceMouseClick}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setSmPopoverOpen((v) => !v);
            }}
          >
            <span className={`sm-dot ${smStatus.connected ? "connected" : ""}`} aria-hidden="true" />
            3D
          </button>

          {smPopoverOpen && (
            <div className="spacemouse-popover" role="dialog" aria-label="SpaceMouse settings">
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <strong style={{ fontSize: 12 }}>3Dconnexion SpaceMouse</strong>
                <span className="mono" style={{ fontSize: 10.5, color: smStatus.connected ? "var(--accent-text)" : "var(--text-muted)" }}>
                  {smStatus.connected ? (smStatus.source === "webhid" ? "WebHID" : "Gamepad") : "Disconnected"}
                </span>
              </div>
              {smStatus.deviceName && (
                <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>{smStatus.deviceName}</div>
              )}
              {!smStatus.connected && !smStatus.webHidSupported && (
                <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.35 }}>
                  WebHID requires Chrome/Edge. Move your SpaceMouse cap to auto-detect via Gamepad API.
                </div>
              )}
              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11.5 }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "var(--text-secondary)" }}>Sensitivity</span>
                  <span className="mono">{smPrefs.sensitivity.toFixed(2)}×</span>
                </div>
                <input
                  type="range"
                  min={0.25}
                  max={2.5}
                  step={0.05}
                  value={smPrefs.sensitivity}
                  onChange={(e) => updateSmPrefs({ sensitivity: Number(e.target.value) })}
                  style={{ accentColor: "var(--accent)" }}
                />
              </label>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={smPrefs.invertAxes}
                  onChange={(e) => updateSmPrefs({ invertAxes: e.target.checked })}
                />
                <span>Camera-centric mode (invert axes)</span>
              </label>
              <div style={{ display: "flex", gap: 6 }}>
                {smStatus.connected && smStatus.source === "webhid" ? (
                  <button
                    className="btn btn-sm"
                    style={{ flex: 1 }}
                    onClick={async () => {
                      await smControllerRef.current?.disconnect();
                      setSmPopoverOpen(false);
                      ws.notify("Disconnected SpaceMouse", "info");
                    }}
                  >
                    Disconnect
                  </button>
                ) : smStatus.webHidSupported ? (
                  <button
                    className="btn btn-sm btn-primary"
                    style={{ flex: 1 }}
                    onClick={async () => {
                      try {
                        await smControllerRef.current?.connect();
                      } catch (err) {
                        ws.notify(err instanceof Error ? err.message : "Could not connect SpaceMouse", "error");
                      }
                    }}
                  >
                    Connect via WebHID
                  </button>
                ) : null}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Full OrcaSlicer Desktop Right-Click Context Menu (Object & Build Plate) */}
      {ctxMenu && (
        <div ref={ctxMenuRef} className="ctx-menu" role="menu" style={{ top: ctxTop, left: ctxLeft }}>
          {ctxObject ? (
            <>
              <div className="ctx-menu-header">
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {ctxObject.name}
                </span>
              </div>

              <button className="menu-item" onMouseEnter={() => setSubmenu(null)} onClick={() => { ws.cloneSelected(1); closeCtx(); }}>
                <span>Clone</span><span className="kbd">Ctrl+K</span>
              </button>
              <button className="menu-item" onMouseEnter={() => setSubmenu(null)} onClick={() => { ws.cloneSelected(3); closeCtx(); }}>
                <span>Clone ×4 Grid</span>
              </button>
              <button className="menu-item" onMouseEnter={() => setSubmenu(null)} onClick={() => { ws.centerSelected(); closeCtx(); }}>
                <span>Center on Bed</span>
              </button>
              <button className="menu-item" onMouseEnter={() => setSubmenu(null)} onClick={() => { ws.dropSelectedToBed(); closeCtx(); }}>
                <span>Drop to Bed (Z=0)</span>
              </button>
              <button className="menu-item" onMouseEnter={() => setSubmenu(null)} onClick={() => { ws.setTool("lay_on_face"); closeCtx(); }}>
                <span>Lay on Face</span><span className="kbd">F</span>
              </button>
              <button className="menu-item" onMouseEnter={() => setSubmenu(null)} onClick={() => { ws.autoOrientSelectedNative(); closeCtx(); }}>
                <span>Auto-Orient</span><span className="kbd">O</span>
              </button>

              <div className="menu-sep" />

              <button
                className="menu-item"
                onMouseEnter={(e) => openSubmenu("mirror", e.currentTarget)}
                onClick={(e) => openSubmenu("mirror", e.currentTarget)}
              >
                <span>Mirror</span><ChevronRight size={13} />
              </button>
              <button
                className="menu-item"
                onMouseEnter={(e) => openSubmenu("split", e.currentTarget)}
                onClick={(e) => openSubmenu("split", e.currentTarget)}
              >
                <span>Split / Cut</span><ChevronRight size={13} />
              </button>
              <button
                className="menu-item"
                onMouseEnter={(e) => openSubmenu("modifier", e.currentTarget)}
                onClick={(e) => openSubmenu("modifier", e.currentTarget)}
              >
                <span>Add Modifier / Part</span><ChevronRight size={13} />
              </button>
              <button
                className="menu-item"
                onMouseEnter={(e) => openSubmenu("filament", e.currentTarget)}
                onClick={(e) => openSubmenu("filament", e.currentTarget)}
              >
                <span>Change Filament</span><ChevronRight size={13} />
              </button>

              <div className="menu-sep" />

              <button className="menu-item" onMouseEnter={() => setSubmenu(null)} onClick={() => { ws.setTool("variable_layer"); closeCtx(); }}>
                <span>Variable Layer Height</span><span className="kbd">V</span>
              </button>
              <button className="menu-item" onMouseEnter={() => setSubmenu(null)} onClick={() => { ws.repairSelectedNative(); closeCtx(); }}>
                <span>Fix Model (Repair)</span>
              </button>
              <button className="menu-item" onMouseEnter={() => setSubmenu(null)} onClick={() => { ws.exportSelectedObjectSTL(); closeCtx(); }}>
                <span>Export as STL…</span>
              </button>
              <button
                className="menu-item"
                onMouseEnter={() => setSubmenu(null)}
                onClick={() => {
                  ws.updateObject(ctxObject.id, { visible: !ctxObject.visible });
                  closeCtx();
                }}
              >
                <span>{ctxObject.visible ? "Hide Object" : "Show Object"}</span>
              </button>

              <div className="menu-sep" />

              <button className="menu-item danger" onMouseEnter={() => setSubmenu(null)} onClick={() => { ws.deleteSelected(); closeCtx(); }}>
                <span>Delete</span><span className="kbd">Del</span>
              </button>

              {/* Cascading Submenus */}
              {submenu?.id === "mirror" && (
                <div className="ctx-submenu-panel" style={{ top: submenu.top, left: submenu.left }}>
                  {(["x", "y", "z"] as const).map((ax) => (
                    <button key={ax} className="menu-item" onClick={() => { ws.mirrorSelected(ax); closeCtx(); }}>
                      <span>Along {ax.toUpperCase()} Axis</span>
                    </button>
                  ))}
                </div>
              )}

              {submenu?.id === "split" && (
                <div className="ctx-submenu-panel" style={{ top: submenu.top, left: submenu.left }}>
                  <button className="menu-item" onClick={() => { ws.splitSelectedToObjects(); closeCtx(); }}>
                    <span>Split to Objects</span>
                  </button>
                  <button className="menu-item" onClick={() => { ws.setTool("cut"); closeCtx(); }}>
                    <span>Cut at Plane</span><span className="kbd">C</span>
                  </button>
                </div>
              )}

              {submenu?.id === "modifier" && (
                <div className="ctx-submenu-panel" style={{ top: submenu.top, left: submenu.left }}>
                  <button className="menu-item" onClick={() => { ws.addSubPartToSelected("modifier_part", "cube"); closeCtx(); }}>
                    <span>Modifier · Cube</span>
                  </button>
                  <button className="menu-item" onClick={() => { ws.addSubPartToSelected("modifier_part", "cylinder"); closeCtx(); }}>
                    <span>Modifier · Cylinder</span>
                  </button>
                  <div className="menu-sep" />
                  <button className="menu-item" onClick={() => { ws.addSubPartToSelected("negative_part", "cube"); closeCtx(); }}>
                    <span>Negative Part · Cube</span>
                  </button>
                  <button className="menu-item" onClick={() => { ws.addSubPartToSelected("negative_part", "cylinder"); closeCtx(); }}>
                    <span>Negative Part · Cylinder</span>
                  </button>
                  <div className="menu-sep" />
                  <button className="menu-item" onClick={() => { ws.addSubPartToSelected("support_enforcer", "cube"); closeCtx(); }}>
                    <span>Support Enforcer</span>
                  </button>
                  <button className="menu-item" onClick={() => { ws.addSubPartToSelected("support_blocker", "cube"); closeCtx(); }}>
                    <span>Support Blocker</span>
                  </button>
                  <button className="menu-item" onClick={() => { ws.setTool("paint_support"); closeCtx(); }}>
                    <span>Paint Supports</span><span className="kbd">L</span>
                  </button>
                </div>
              )}

              {submenu?.id === "filament" && (
                <div className="ctx-submenu-panel" style={{ top: submenu.top, left: submenu.left }}>
                  {ws.filaments.map((slot, idx) => (
                    <button
                      key={slot.id}
                      className="menu-item"
                      onClick={() => {
                        ws.updateObject(ctxObject.id, { filamentIndex: idx });
                        closeCtx();
                      }}
                    >
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                        <span className="swatch-btn" style={{ width: 10, height: 10, background: slot.color, flexShrink: 0 }} />
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          #{idx + 1} {slot.profile.name}
                        </span>
                      </span>
                      {ctxObject.filamentIndex === idx && <span style={{ color: "var(--accent-text)" }}>✓</span>}
                    </button>
                  ))}
                  {ws.filaments.length < 8 && (
                    <>
                      <div className="menu-sep" />
                      <button className="menu-item" onClick={() => { ws.addFilamentSlot(); closeCtx(); }}>
                        <span>+ Add Filament Slot</span>
                      </button>
                    </>
                  )}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="ctx-menu-header">
                <span>{ws.activePlate.name}</span>
                <span className="mono">{Math.round(ws.buildVolume[0])}×{Math.round(ws.buildVolume[1])}</span>
              </div>

              {ws.tab === "prepare" && (
                <>
                  <button
                    className="menu-item"
                    onMouseEnter={(e) => openSubmenu("add_primitive", e.currentTarget)}
                    onClick={(e) => openSubmenu("add_primitive", e.currentTarget)}
                  >
                    <span>Add Primitive</span><ChevronRight size={13} />
                  </button>
                  {onTriggerFileImport && (
                    <button className="menu-item" onMouseEnter={() => setSubmenu(null)} onClick={() => { closeCtx(); onTriggerFileImport(); }}>
                      <span>Import STL / OBJ / 3MF…</span><span className="kbd">Ctrl+I</span>
                    </button>
                  )}

                  <div className="menu-sep" />

                  <button
                    className="menu-item"
                    disabled={ws.activePlate.objects.length === 0}
                    onMouseEnter={() => setSubmenu(null)}
                    onClick={() => { ws.arrangeActivePlate(); closeCtx(); }}
                  >
                    <span>Arrange All Objects</span><span className="kbd">A</span>
                  </button>
                  <button className="menu-item" onMouseEnter={() => setSubmenu(null)} onClick={() => { ws.addPlate(); closeCtx(); }}>
                    <span>Add New Plate</span>
                  </button>
                  <button className="menu-item" onMouseEnter={() => setSubmenu(null)} onClick={() => { ws.duplicateActivePlate(); closeCtx(); }}>
                    <span>Duplicate Plate</span>
                  </button>

                  <div className="menu-sep" />
                </>
              )}

              <button
                className="menu-item"
                onMouseEnter={(e) => openSubmenu("camera", e.currentTarget)}
                onClick={(e) => openSubmenu("camera", e.currentTarget)}
              >
                <span>Camera View</span><ChevronRight size={13} />
              </button>
              <button
                className="menu-item"
                onMouseEnter={() => setSubmenu(null)}
                onClick={() => { ws.setTab(ws.tab === "preview" ? "prepare" : "preview"); closeCtx(); }}
              >
                <span>Switch to {ws.tab === "preview" ? "Prepare" : "Preview"}</span><span className="kbd">Tab</span>
              </button>
              {ws.tab === "prepare" && (
                <button className="menu-item" onMouseEnter={() => setSubmenu(null)} onClick={() => { ws.setWireframe((v) => !v); closeCtx(); }}>
                  <span>{ws.wireframe ? "Solid Shading" : "Wireframe Shading"}</span><span className="kbd">W</span>
                </button>
              )}

              {ws.tab === "prepare" && ws.activePlate.objects.length > 0 && (
                <>
                  <div className="menu-sep" />
                  <button className="menu-item danger" onMouseEnter={() => setSubmenu(null)} onClick={() => { ws.deleteAllObjectsOnPlate(); closeCtx(); }}>
                    <span>Delete All on Plate</span><span className="kbd">Shift+Del</span>
                  </button>
                </>
              )}

              {submenu?.id === "add_primitive" && (
                <div className="ctx-submenu-panel" style={{ top: submenu.top, left: submenu.left }}>
                  {CTX_PRIMITIVES.map((p) => (
                    <button key={p.kind} className="menu-item" onClick={() => { ws.addPrimitive(p.kind); closeCtx(); }}>
                      <span>{p.label}</span>
                    </button>
                  ))}
                </div>
              )}

              {submenu?.id === "camera" && (
                <div className="ctx-submenu-panel" style={{ top: submenu.top, left: submenu.left }}>
                  {(
                    [
                      ["iso", "Isometric", "0"],
                      ["top", "Top", "1"],
                      ["bottom", "Bottom", "2"],
                      ["front", "Front", "3"],
                      ["back", "Back", "4"],
                      ["left", "Left", "5"],
                      ["right", "Right", "6"],
                      ["fit", "Fit View", "Shift+F"],
                    ] as const
                  ).map(([id, label, keyHint]) => (
                    <button key={id} className="menu-item" onClick={() => { setCameraPreset(id); closeCtx(); }}>
                      <span>{label}</span><span className="kbd">{keyHint}</span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
