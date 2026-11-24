import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import * as THREE from "three";
import type { GeometryData, Plate, SceneObject, SubPart } from "../types";
import { buildGeometryData, getObjectMatrix, normalizeGeometry, transformPositions, uid } from "./geometry";

function xmlEscape(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildObjectModelXml(
  objectId: number,
  positions: Float32Array,
  paintSupport?: Uint8Array,
  paintSeam?: Uint8Array,
  paintColor?: Uint8Array
): string {
  // Deduplicate vertices by quantized coords for clean compact 3MF
  const vertMap = new Map<string, number>();
  const verts: Array<[number, number, number]> = [];
  const tris: Array<[number, number, number, number]> = [];

  const getVert = (x: number, y: number, z: number): number => {
    const k = `${Math.round(x * 10000)},${Math.round(y * 10000)},${Math.round(z * 10000)}`;
    const existing = vertMap.get(k);
    if (existing !== undefined) return existing;
    const idx = verts.length;
    vertMap.set(k, idx);
    verts.push([x, y, z]);
    return idx;
  };

  const triCount = Math.floor(positions.length / 9);
  for (let t = 0; t < triCount; t++) {
    const b = t * 9;
    const v1 = getVert(positions[b], positions[b + 1], positions[b + 2]);
    const v2 = getVert(positions[b + 3], positions[b + 4], positions[b + 5]);
    const v3 = getVert(positions[b + 6], positions[b + 7], positions[b + 8]);
    if (v1 !== v2 && v2 !== v3 && v3 !== v1) {
      tris.push([v1, v2, v3, t]);
    }
  }

  const vLines = verts.map(
    ([x, y, z]) => `     <vertex x="${x.toFixed(4)}" y="${y.toFixed(4)}" z="${z.toFixed(4)}"/>`
  );
  const tLines = tris.map(([v1, v2, v3, origIdx]) => {
    const attrs: string[] = [];
    const sup = paintSupport?.[origIdx] || 0;
    if (sup === 1) attrs.push('paint_supports="4"'); // enforce
    else if (sup === 2) attrs.push('paint_supports="8"'); // block
    const seam = paintSeam?.[origIdx] || 0;
    if (seam === 1) attrs.push('paint_seam="4"');
    else if (seam === 2) attrs.push('paint_seam="8"');
    const col = paintColor?.[origIdx] || 0;
    if (col > 0) {
      // Bambu/Orca mmu segmentation nibble encoding for single-state face
      const code = col === 1 ? "4" : col === 2 ? "8" : col === 3 ? "0C" : col === 4 ? "1C" : "2C";
      attrs.push(`paint_color="${code}"`);
    }
    const extra = attrs.length ? " " + attrs.join(" ") : "";
    return `     <triangle v1="${v1}" v2="${v2}" v3="${v3}"${extra}/>`;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">
 <resources>
  <object id="${objectId}" type="model">
   <mesh>
    <vertices>
${vLines.join("\n")}
    </vertices>
    <triangles>
${tLines.join("\n")}
    </triangles>
   </mesh>
  </object>
 </resources>
</model>`;
}

/**
 * Export a plate into a genuine OrcaSlicer 2.5.0 compatible `.3mf` archive.
 * Preserves multiple objects, exact XY/Z bed positions, per-object filament slots,
 * per-object process overrides, modifier/negative/support sub-parts, and painted triangles.
 */
export function exportPlateTo3MF(plate: Plate): Uint8Array {
  const visible = plate.objects.filter((o) => o.visible);
  if (visible.length === 0) {
    throw new Error("No visible objects on plate to export");
  }

  const files: Record<string, Uint8Array> = {};
  const rootObjectsXml: string[] = [];
  const buildItemsXml: string[] = [];
  const modelSettingsObjectsXml: string[] = [];

  let nextTopObjId = 100;
  let nextPartId = 1;

  for (const obj of visible) {
    const topObjId = nextTopObjId++;
    const mat = getObjectMatrix(obj);
    const mainWorldPos = transformPositions(obj.geometry.positions, mat);
    const mainPartId = nextPartId++;
    const mainFilePath = `3D/Objects/obj_${mainPartId}.model`;

    files[mainFilePath] = strToU8(
      buildObjectModelXml(
        mainPartId,
        mainWorldPos,
        obj.paintSupport,
        obj.paintSeam,
        obj.paintColor
      )
    );

    const componentLines: string[] = [
      `    <component p:path="/${mainFilePath}" objectid="${mainPartId}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>`,
    ];
    const partSettingsLines: string[] = [
      `    <part id="${mainPartId}" subtype="normal_part">
      <metadata key="name" value="${xmlEscape(obj.name)}"/>
      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>
      <metadata key="extruder" value="${obj.filamentIndex + 1}"/>
    </part>`,
    ];

    for (const sub of obj.subParts) {
      const subId = nextPartId++;
      const subFilePath = `3D/Objects/part_${subId}.model`;
      // SubPart local position is relative to object center in world space
      const subMat = new THREE.Matrix4().compose(
        new THREE.Vector3(
          obj.position[0] + sub.position[0],
          obj.position[1] + sub.position[1],
          obj.position[2] + sub.position[2]
        ),
        new THREE.Quaternion().setFromEuler(
          new THREE.Euler(
            THREE.MathUtils.degToRad(sub.rotation[0]),
            THREE.MathUtils.degToRad(sub.rotation[1]),
            THREE.MathUtils.degToRad(sub.rotation[2]),
            "XYZ"
          )
        ),
        new THREE.Vector3(sub.scale[0], sub.scale[1], sub.scale[2])
      );
      const subWorldPos = transformPositions(sub.geometry.positions, subMat);
      files[subFilePath] = strToU8(buildObjectModelXml(subId, subWorldPos));
      componentLines.push(
        `    <component p:path="/${subFilePath}" objectid="${subId}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>`
      );

      const subOverridesXml = Object.entries(sub.overrides)
        .map(([k, v]) => {
          const sv = Array.isArray(v) ? v.join(",") : v;
          return `      <metadata key="${xmlEscape(k)}" value="${xmlEscape(sv)}"/>`;
        })
        .join("\n");

      const subFilamentLine =
        sub.filamentIndex !== undefined
          ? `\n      <metadata key="extruder" value="${sub.filamentIndex + 1}"/>`
          : "";

      partSettingsLines.push(
        `    <part id="${subId}" subtype="${sub.subtype}">
      <metadata key="name" value="${xmlEscape(sub.name)}"/>
      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>${subFilamentLine}
${subOverridesXml}
    </part>`
      );
    }

    rootObjectsXml.push(
      `  <object id="${topObjId}" type="model">
   <components>
${componentLines.join("\n")}
   </components>
  </object>`
    );
    buildItemsXml.push(`  <item objectid="${topObjId}" transform="1 0 0 0 1 0 0 0 1 0 0 0" printable="1"/>`);

    const objOverridesXml = Object.entries(obj.overrides)
      .map(([k, v]) => {
        const sv = Array.isArray(v) ? v.join(",") : v;
        return `    <metadata key="${xmlEscape(k)}" value="${xmlEscape(sv)}"/>`;
      })
      .join("\n");

    modelSettingsObjectsXml.push(
      `  <object id="${topObjId}">
    <metadata key="name" value="${xmlEscape(obj.name)}"/>
    <metadata key="extruder" value="${obj.filamentIndex + 1}"/>
${objOverridesXml}
${partSettingsLines.join("\n")}
  </object>`
    );
  }

  files["[Content_Types].xml"] = strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Default Extension="config" ContentType="text/xml"/>
</Types>`);

  files["_rels/.rels"] = strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`);

  files["3D/3dmodel.model"] = strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">
 <metadata name="Application">OrcaCloud</metadata>
 <metadata name="OrcaSlicer">2.5.0</metadata>
 <metadata name="BambuStudio:3mfVersion">1</metadata>
 <resources>
${rootObjectsXml.join("\n")}
 </resources>
 <build>
${buildItemsXml.join("\n")}
 </build>
</model>`);

  files["Metadata/model_settings.config"] = strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<config>
${modelSettingsObjectsXml.join("\n")}
  <plate>
    <metadata key="plater_id" value="1"/>
    <metadata key="plater_name" value="${xmlEscape(plate.name)}"/>
    <metadata key="locked" value="false"/>
  </plate>
  <assemble/>
</config>`);

  return zipSync(files, { level: 6 });
}

function parse3mfTransform(str: string | null): THREE.Matrix4 {
  if (!str) return new THREE.Matrix4();
  const nums = str.trim().split(/\s+/).map(Number);
  if (nums.length !== 12 || nums.some((n) => !Number.isFinite(n))) {
    return new THREE.Matrix4();
  }
  // 3MF 4x3 row-major affine matrix -> Three.js Matrix4.set (row-major args)
  const m = new THREE.Matrix4();
  m.set(
    nums[0], nums[3], nums[6], nums[9],
    nums[1], nums[4], nums[7], nums[10],
    nums[2], nums[5], nums[8], nums[11],
    0, 0, 0, 1
  );
  return m;
}

function extractMeshFromObjectNode(objEl: Element): Float32Array | null {
  const verticesEl = objEl.getElementsByTagName("vertices")[0];
  const trianglesEl = objEl.getElementsByTagName("triangles")[0];
  if (!verticesEl || !trianglesEl) return null;

  const vNodes = verticesEl.getElementsByTagName("vertex");
  const verts = new Float32Array(vNodes.length * 3);
  for (let i = 0; i < vNodes.length; i++) {
    verts[i * 3] = parseFloat(vNodes[i].getAttribute("x") || "0");
    verts[i * 3 + 1] = parseFloat(vNodes[i].getAttribute("y") || "0");
    verts[i * 3 + 2] = parseFloat(vNodes[i].getAttribute("z") || "0");
  }

  const tNodes = trianglesEl.getElementsByTagName("triangle");
  const pos = new Float32Array(tNodes.length * 9);
  for (let i = 0; i < tNodes.length; i++) {
    const v1 = parseInt(tNodes[i].getAttribute("v1") || "0", 10);
    const v2 = parseInt(tNodes[i].getAttribute("v2") || "0", 10);
    const v3 = parseInt(tNodes[i].getAttribute("v3") || "0", 10);
    pos[i * 9] = verts[v1 * 3]; pos[i * 9 + 1] = verts[v1 * 3 + 1]; pos[i * 9 + 2] = verts[v1 * 3 + 2];
    pos[i * 9 + 3] = verts[v2 * 3]; pos[i * 9 + 4] = verts[v2 * 3 + 1]; pos[i * 9 + 5] = verts[v2 * 3 + 2];
    pos[i * 9 + 6] = verts[v3 * 3]; pos[i * 9 + 7] = verts[v3 * 3 + 1]; pos[i * 9 + 8] = verts[v3 * 3 + 2];
  }
  return pos.length >= 9 ? pos : null;
}

/** Import standard or OrcaSlicer/Bambu `.3mf` archive into SceneObjects. */
export function parse3MF(buffer: ArrayBuffer, fallbackName = "Imported 3MF"): Array<{
  name: string;
  geometry: GeometryData;
  worldCenterXY: [number, number];
  filamentIndex: number;
  subParts: SubPart[];
}> {
  const archive = unzipSync(new Uint8Array(buffer));
  const parser = new DOMParser();

  // Index all .model files in archive
  const modelDocs = new Map<string, Document>();
  for (const [path, bytes] of Object.entries(archive)) {
    if (path.toLowerCase().endsWith(".model")) {
      const normalized = path.replace(/^\/+/, "");
      const doc = parser.parseFromString(strFromU8(bytes), "application/xml");
      modelDocs.set(normalized, doc);
    }
  }

  const rootDoc = modelDocs.get("3D/3dmodel.model") || Array.from(modelDocs.values())[0];
  if (!rootDoc) {
    throw new Error("3MF archive contains no 3D model XML");
  }

  // Helper to resolve an object ID from a given model file
  const findObjectPositions = (doc: Document, objectId: string, parentMatrix: THREE.Matrix4): Float32Array[] => {
    const objEls = Array.from(doc.getElementsByTagName("object"));
    const target = objEls.find((el) => el.getAttribute("id") === objectId);
    if (!target) return [];

    const meshes: Float32Array[] = [];
    const direct = extractMeshFromObjectNode(target);
    if (direct) {
      meshes.push(transformPositions(direct, parentMatrix));
    }

    const comps = Array.from(target.getElementsByTagName("component"));
    for (const comp of comps) {
      const compId = comp.getAttribute("objectid") || "";
      const compPathRaw = comp.getAttribute("p:path") || comp.getAttributeNS("*", "path") || "";
      const compMat = parentMatrix.clone().multiply(parse3mfTransform(comp.getAttribute("transform")));
      const targetDoc = compPathRaw ? modelDocs.get(compPathRaw.replace(/^\/+/, "")) || doc : doc;
      meshes.push(...findObjectPositions(targetDoc, compId, compMat));
    }
    return meshes;
  };

  // Optional Metadata/model_settings.config for names & extruders
  const nameById = new Map<string, string>();
  const extruderById = new Map<string, number>();
  const settingsBytes = archive["Metadata/model_settings.config"];
  if (settingsBytes) {
    try {
      const sdoc = parser.parseFromString(strFromU8(settingsBytes), "application/xml");
      for (const oel of Array.from(sdoc.getElementsByTagName("object"))) {
        const oid = oel.getAttribute("id") || "";
        for (const mel of Array.from(oel.children)) {
          if (mel.tagName === "metadata") {
            const k = mel.getAttribute("key");
            const v = mel.getAttribute("value") || "";
            if (k === "name" && v) nameById.set(oid, v);
            if (k === "extruder") {
              const ext = parseInt(v, 10);
              if (Number.isFinite(ext) && ext >= 1) extruderById.set(oid, ext - 1);
            }
          }
        }
      }
    } catch {
      // Ignore optional metadata errors
    }
  }

  const results: Array<{
    name: string;
    geometry: GeometryData;
    worldCenterXY: [number, number];
    filamentIndex: number;
    subParts: SubPart[];
  }> = [];

  const buildItems = Array.from(rootDoc.getElementsByTagName("item"));
  if (buildItems.length > 0) {
    buildItems.forEach((item, idx) => {
      const oid = item.getAttribute("objectid") || "";
      const mat = parse3mfTransform(item.getAttribute("transform"));
      const chunks = findObjectPositions(rootDoc, oid, mat);
      const total = chunks.reduce((s, c) => s + c.length, 0);
      if (total < 9) return;
      const merged = new Float32Array(total);
      let off = 0;
      for (const c of chunks) {
        merged.set(c, off);
        off += c.length;
      }
      const rawBounds = buildGeometryData(merged).bounds;
      const norm = normalizeGeometry(merged);
      results.push({
        name: nameById.get(oid) || `${fallbackName}${buildItems.length > 1 ? ` #${idx + 1}` : ""}`,
        geometry: norm,
        worldCenterXY: [rawBounds.center[0], rawBounds.center[1]],
        filamentIndex: extruderById.get(oid) ?? 0,
        subParts: [],
      });
    });
  } else {
    // Fallback: import all mesh objects directly
    for (const [, doc] of modelDocs) {
      for (const objEl of Array.from(doc.getElementsByTagName("object"))) {
        const direct = extractMeshFromObjectNode(objEl);
        if (!direct) continue;
        const rawBounds = buildGeometryData(direct).bounds;
        results.push({
          name: objEl.getAttribute("name") || `${fallbackName} #${results.length + 1}`,
          geometry: normalizeGeometry(direct),
          worldCenterXY: [rawBounds.center[0], rawBounds.center[1]],
          filamentIndex: 0,
          subParts: [],
        });
      }
    }
  }

  if (results.length === 0) {
    throw new Error("No valid 3D meshes found inside 3MF archive");
  }
  return results;
}

export function createSubPart(
  subtype: SubPart["subtype"],
  shape: "cube" | "cylinder" | "sphere",
  sizeMm = 16
): SubPart {
  let geom: THREE.BufferGeometry;
  if (shape === "cylinder") {
    geom = new THREE.CylinderGeometry(sizeMm / 2, sizeMm / 2, sizeMm, 32);
    geom.rotateX(Math.PI / 2);
  } else if (shape === "sphere") {
    geom = new THREE.SphereGeometry(sizeMm / 2, 24, 16);
  } else {
    geom = new THREE.BoxGeometry(sizeMm, sizeMm, sizeMm);
  }
  const ni = geom.index ? geom.toNonIndexed() : geom;
  const arr = new Float32Array(ni.getAttribute("position").array as Float32Array);
  geom.dispose();
  if (ni !== geom) ni.dispose();

  const labels: Record<SubPart["subtype"], string> = {
    modifier_part: "Modifier",
    negative_part: "Negative Part",
    support_enforcer: "Support Enforcer",
    support_blocker: "Support Blocker",
  };
  return {
    id: uid("sub"),
    name: `${labels[subtype]} (${shape})`,
    subtype,
    geometry: normalizeGeometry(arr),
    position: [0, 0, 2],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    overrides: subtype === "modifier_part" ? { sparse_infill_density: "40%", wall_loops: "4" } : {},
  };
}
