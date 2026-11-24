import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import type { WorkspaceAPI } from "../store/useWorkspace";
import type { BedType, GcodeFeatureType, ParsedGcode, SceneObject, SubPartType } from "../types";
import {
  computeLayOnFaceRotation,
  getObjectWorldBounds,
  groundObjectPosition,
} from "../lib/geometry";
import { INDEX_TO_FEATURE } from "../lib/gcode";
import { loadPrinterAssetSTL, loadPrinterAssetSVG } from "../lib/printerAssets";
import { VGCodeRenderer } from "../lib/vgcodeRenderer";

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

  const palette: Record<BedType, { bg: string; minor: string; major: string; accent: string }> = {
    "Textured PEI Plate": { bg: "#1c1a17", minor: "rgba(218,175,105,0.08)", major: "rgba(218,175,105,0.22)", accent: "rgba(234,179,8,0.45)" },
    "Smooth PEI Plate": { bg: "#181b20", minor: "rgba(200,212,230,0.07)", major: "rgba(200,212,230,0.20)", accent: "rgba(56,189,248,0.45)" },
    "Cool Plate": { bg: "#161a1f", minor: "rgba(148,163,184,0.07)", major: "rgba(148,163,184,0.20)", accent: "rgba(34,197,94,0.45)" },
    "High Temp Plate": { bg: "#17171a", minor: "rgba(248,113,113,0.07)", major: "rgba(248,113,113,0.18)", accent: "rgba(248,113,113,0.4)" },
    "Engineering Plate": { bg: "#1b1d21", minor: "rgba(203,213,225,0.08)", major: "rgba(203,213,225,0.22)", accent: "rgba(148,163,184,0.45)" },
    "Textured Cool Plate": { bg: "#171c22", minor: "rgba(56,189,248,0.08)", major: "rgba(56,189,248,0.22)", accent: "rgba(56,189,248,0.45)" },
  };
  const pal = palette[bedType] || palette["Textured PEI Plate"];

  ctx.fillStyle = pal.bg;
  ctx.fillRect(0, 0, cw, ch);

  // Subtle PEI speckle texture
  if (bedType.includes("Textured")) {
    ctx.fillStyle = "rgba(255,255,255,0.028)";
    for (let i = 0; i < 3600; i++) {
      const rx = (((i * 7919) % 10000) / 10000) * cw;
      const ry = (((i * 6271) % 10000) / 10000) * ch;
      ctx.fillRect(rx, ry, 2, 2);
    }
  }

  // Official vendor SVG silkscreen texture (e.g. bbl-3dp-logo.svg)
  if (logoImg) {
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.drawImage(logoImg, 0, 0, cw, ch);
    ctx.restore();
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

  // Outer border
  ctx.strokeStyle = pal.accent;
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, cw - 4, ch - 4);

  // Coordinate labels along left edge (Y) and top edge (X), keeping front edge clean for plate name
  ctx.fillStyle = "rgba(226,232,240,0.42)";
  ctx.font = `600 ${Math.round(cw * 0.017)}px monospace`;
  ctx.textAlign = "left";
  for (let x = 50; x < width; x += 50) {
    const px = (x / width) * cw;
    ctx.fillText(String(x), px + 4, Math.round(cw * 0.025));
  }
  for (let y = 50; y < depth; y += 50) {
    const py = ch - (y / depth) * ch;
    ctx.fillText(String(y), 8, py - 4);
  }
  ctx.textAlign = "center";
  ctx.font = `600 ${Math.round(cw * 0.02)}px sans-serif`;
  ctx.fillText(`FRONT · ${bedType.toUpperCase()}`, cw / 2, ch - 12);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
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
  const baseCol = new THREE.Color(baseHex);
  const overhangCol = new THREE.Color("#ef4444");
  const enforceSupCol = new THREE.Color("#22c55e");
  const blockSupCol = new THREE.Color("#ef4444");
  const enforceSeamCol = new THREE.Color("#ffffff");
  const blockSeamCol = new THREE.Color("#f43f5e");
  const slotCols = filamentsHex.map((h) => new THREE.Color(h));

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
    colors[o] = col.r; colors[o + 1] = col.g; colors[o + 2] = col.b;
    colors[o + 3] = col.r; colors[o + 4] = col.g; colors[o + 5] = col.b;
    colors[o + 6] = col.r; colors[o + 7] = col.g; colors[o + 8] = col.b;
  }

  geom.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geom.computeBoundingSphere();
  return geom;
}

interface ContextMenuState {
  x: number;
  y: number;
  objectId: string;
}

export function Viewport3D({ ws }: { ws: WorkspaceAPI }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);

  // Refs to Three.js scene objects
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const transformRef = useRef<TransformControls | null>(null);
  const bedGroupRef = useRef<THREE.Group | null>(null);
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
    scene.background = new THREE.Color("#0e1013");
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(42, host.clientWidth / Math.max(1, host.clientHeight), 0.5, 4000);
    camera.up.set(0, 0, 1);
    camera.position.set(220, -190, 175);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(host.clientWidth, host.clientHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    host.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // Studio CAD 3-point lighting
    const hemi = new THREE.HemisphereLight(0xdce6f5, 0x262a33, 0.9);
    hemi.position.set(0, 0, 400);
    scene.add(hemi);

    const keyLight = new THREE.DirectionalLight(0xffffff, 1.05);
    keyLight.position.set(220, -240, 360);
    scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0x9ec5fe, 0.55);
    rimLight.position.set(-220, 260, 180);
    scene.add(rimLight);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
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
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
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

    const onPointerDown = (e: PointerEvent) => {
      setCtxMenu(null);
      downXY = { x: e.clientX, y: e.clientY };
      const curWs = wsRef.current;
      if (curWs.tab !== "prepare") return;

      const isPaintTool =
        curWs.tool === "paint_support" || curWs.tool === "paint_seam" || curWs.tool === "paint_color";
      if (isPaintTool && e.button === 0 && !e.shiftKey) {
        const hits = getHit(e);
        if (hits.length > 0) {
          isPaintingRef.current = true;
          controls.enabled = false;
          paintAtHit(hits[0]);
        }
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!isPaintingRef.current) return;
      const hits = getHit(e);
      if (hits.length > 0) paintAtHit(hits[0]);
    };

    const onPointerUp = (e: PointerEvent) => {
      if (isPaintingRef.current) {
        isPaintingRef.current = false;
        controls.enabled = true;
        return;
      }
      if (e.button !== 0) return;
      const moved = Math.hypot(e.clientX - downXY.x, e.clientY - downXY.y);
      if (moved > 5) return;

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
      const curWs = wsRef.current;
      if (curWs.tab !== "prepare") return;
      const hits = getHit(e);
      if (hits.length > 0) {
        const oid = hits[0].object.userData?.objectId as string | undefined;
        if (oid) {
          curWs.setSelectedObjectId(oid);
          setCtxMenu({ x: e.clientX, y: e.clientY, objectId: oid });
        }
      }
    };

    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    renderer.domElement.addEventListener("contextmenu", onContextMenu);

    let rafId = 0;
    const animate = () => {
      rafId = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
      if (vgRendererRef.current) {
        vgRendererRef.current.renderer.dispose();
        vgRendererRef.current = null;
      }
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      renderer.domElement.removeEventListener("contextmenu", onContextMenu);
      controls.dispose();
      transform.dispose();
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

      // Official 3D printer build plate STL (e.g. bbl-3dp-A1M.stl, bbl-3dp-X1.stl) with real front tab & rear alignment ears
      if (bedStlGeom) {
        const stlMat = new THREE.MeshStandardMaterial({
          color: ws.bedType.includes("Textured") ? "#302a22" : "#252a34",
          roughness: ws.bedType.includes("Textured") ? 0.68 : 0.38,
          metalness: 0.38,
          polygonOffset: true,
          polygonOffsetFactor: 2,
          polygonOffsetUnits: 2,
        });
        const stlMesh = new THREE.Mesh(bedStlGeom, stlMat);
        stlMesh.position.set(0, 0, -0.05);
        stlMesh.userData = { sharedAsset: true };
        group.add(stlMesh);

        // Subtle metallic chassis underside rim below the spring-steel PEI sheet
        const chassis = new THREE.Mesh(
          new THREE.BoxGeometry(bw + 2, bd + 2, 2.0),
          new THREE.MeshStandardMaterial({ color: "#12141a", roughness: 0.75, metalness: 0.35 })
        );
        chassis.position.set(bw / 2, bd / 2, -1.65);
        group.add(chassis);
      } else {
        const plateBase = new THREE.Mesh(
          new THREE.BoxGeometry(bw + 4, bd + 4, 2.2),
          new THREE.MeshStandardMaterial({ color: "#15171c", roughness: 0.7, metalness: 0.3 })
        );
        plateBase.position.set(bw / 2, bd / 2, -1.25);
        group.add(plateBase);
      }

      // Printable surface overlay (grid + official vendor SVG logo + bed type texture + exclusion zone)
      const tex = createBedTexture(bw, bd, ws.bedType, logoImg, excludeArea);
      const bedGeo = new THREE.PlaneGeometry(bw, bd);
      const bedMat = new THREE.MeshStandardMaterial({
        map: tex,
        roughness: ws.bedType.includes("Textured") ? 0.84 : 0.44,
        metalness: 0.14,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      });
      const bedMesh = new THREE.Mesh(bedGeo, bedMat);
      bedMesh.position.set(bw / 2, bd / 2, -0.02);
      group.add(bedMesh);

      // Build volume wireframe cage
      const boxEdges = new THREE.EdgesGeometry(new THREE.BoxGeometry(bw, bd, bh));
      const cage = new THREE.LineSegments(
        boxEdges,
        new THREE.LineBasicMaterial({ color: "#323846", transparent: true, opacity: 0.55 })
      );
      cage.position.set(bw / 2, bd / 2, bh / 2);
      group.add(cage);

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
  }, [ws.buildVolume, ws.bedType, ws.machineModel?.bed_model_url, ws.machineModel?.bed_texture_url, ws.bedExcludeArea]);

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
          ? new THREE.MeshStandardMaterial({
              color: "#94a3b8",
              transparent: true,
              opacity: 0.16,
              depthWrite: false,
            })
          : new THREE.MeshStandardMaterial({
              vertexColors: true,
              roughness: 0.42,
              metalness: 0.08,
              wireframe: ws.wireframe,
              emissive: new THREE.Color(isSelected ? "#1d4ed8" : "#000000"),
              emissiveIntensity: isSelected ? 0.14 : 0,
            });

      const mesh = new THREE.Mesh(geom, mat);
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
          const spMat = new THREE.MeshStandardMaterial({
            color: subColors[sp.subtype],
            transparent: true,
            opacity: 0.38,
            depthWrite: false,
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

    // Animated Extruder Nozzle Head (official Bambu Lab bbl-3dp-hotend.stl when available)
    if (ws.showNozzle && maxSeg > 0) {
      // Find last extruded (non-Travel, non-Custom) move within active layer range so end-G-code park doesn't lift nozzle to Z=100
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
          new THREE.MeshStandardMaterial({ color: "#e2e8f0", metalness: 0.72, roughness: 0.22 })
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
          new THREE.MeshStandardMaterial({ color: "#d97706", metalness: 0.75, roughness: 0.25 })
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

  // Camera presets
  const setCameraPreset = (preset: "iso" | "top" | "front" | "right" | "fit") => {
    const cam = cameraRef.current;
    const ctrl = controlsRef.current;
    if (!cam || !ctrl) return;
    if (preset === "fit" && ws.tab === "preview" && ws.parsedGcode) {
      const bMin = ws.parsedGcode.bounds.min;
      const bMax = ws.parsedGcode.bounds.max;
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
    const [bw, bd] = ws.buildVolume;
    const cx = bw / 2, cy = bd / 2;
    const dist = Math.max(bw, bd) * 1.48;
    ctrl.target.set(cx, cy, 18);
    if (preset === "iso" || preset === "fit") cam.position.set(cx + dist * 0.72, cy - dist * 0.88, dist * 0.66);
    else if (preset === "top") cam.position.set(cx, cy - 0.5, dist * 1.35);
    else if (preset === "front") cam.position.set(cx, cy - dist * 1.2, 42);
    else if (preset === "right") cam.position.set(cx + dist * 1.2, cy, 42);
    ctrl.update();
  };

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
            ["iso", "Iso"],
            ["top", "Top"],
            ["front", "Front"],
            ["right", "Right"],
            ["fit", "Fit"],
          ] as const
        ).map(([id, label]) => (
          <button key={id} className="camera-btn" onClick={() => setCameraPreset(id)}>
            {label}
          </button>
        ))}
        {ws.tab === "prepare" && (
          <button
            className={`camera-btn ${ws.wireframe ? "active" : ""}`}
            onClick={() => ws.setWireframe((v) => !v)}
            title="Toggle wireframe shading"
          >
            Wire
          </button>
        )}
      </div>

      {/* Right-click Object Context Menu */}
      {ctxMenu && (
        <div
          className="menu-popover"
          style={{ top: Math.min(ctxMenu.y, window.innerHeight - 290), left: Math.min(ctxMenu.x, window.innerWidth - 220), width: 210 }}
          onMouseLeave={() => setCtxMenu(null)}
        >
          <button className="menu-item" onClick={() => { ws.cloneSelected(1); setCtxMenu(null); }}>
            <span>Clone</span><span className="kbd">Ctrl+K</span>
          </button>
          <button className="menu-item" onClick={() => { ws.centerSelected(); setCtxMenu(null); }}>
            <span>Center on Bed</span>
          </button>
          <button className="menu-item" onClick={() => { ws.dropSelectedToBed(); setCtxMenu(null); }}>
            <span>Drop to Bed (Z=0)</span>
          </button>
          <button className="menu-item" onClick={() => { ws.mirrorSelected("x"); setCtxMenu(null); }}>
            <span>Mirror X</span>
          </button>
          <button className="menu-item" onClick={() => { ws.splitSelectedToObjects(); setCtxMenu(null); }}>
            <span>Split to Objects</span>
          </button>
          <div className="menu-sep" />
          <button className="menu-item" onClick={() => { ws.addSubPartToSelected("modifier_part", "cube"); setCtxMenu(null); }}>
            <span>Add Modifier Mesh</span>
          </button>
          <button className="menu-item" onClick={() => { ws.addSubPartToSelected("negative_part", "cube"); setCtxMenu(null); }}>
            <span>Add Negative Part</span>
          </button>
          <button className="menu-item" onClick={() => { ws.addSubPartToSelected("support_enforcer", "cube"); setCtxMenu(null); }}>
            <span>Add Support Enforcer</span>
          </button>
          <button className="menu-item" onClick={() => { ws.addSubPartToSelected("support_blocker", "cube"); setCtxMenu(null); }}>
            <span>Add Support Blocker</span>
          </button>
          <div className="menu-sep" />
          <button className="menu-item" onClick={() => { ws.repairSelectedNative(); setCtxMenu(null); }}>
            <span>Fix Model (Native Repair)</span>
          </button>
          <button className="menu-item danger" onClick={() => { ws.deleteSelected(); setCtxMenu(null); }}>
            <span>Delete</span><span className="kbd">Del</span>
          </button>
        </div>
      )}
    </div>
  );
}
