"""Bounded OrcaSlicer 2.5.0 HTTP service (v1 + v2 + 3MF + native mesh ops). Python stdlib only."""

from __future__ import annotations

import hashlib
import hmac
import json
import math
import mimetypes
import os
import re
import shutil
import signal
import socketserver
import sqlite3
import struct
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import zipfile
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from configuration import (
    MAX_CONFIG_REQUEST_BYTES,
    MAX_EXPANDED_CONFIG_BYTES,
    ProfileCatalog,
    canonical_sha256,
)

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get("DATA_DIR", "/data"))
ORCA_BIN = os.environ.get("ORCA_BIN", "/opt/orca/AppRun")
SOCKET = os.environ.get("HTTP_SOCKET", "/alloc/orca.sock")
HTTP_BIND = os.environ.get("HTTP_BIND", "").strip()
STATIC_DIR = Path(os.environ["STATIC_DIR"]).resolve() if os.environ.get("STATIC_DIR") else None
CORS_ORIGIN = os.environ.get("CORS_ORIGIN", "*")


def _load_token() -> str | None:
    auth_mode = os.environ.get("AUTH_MODE", "").strip().lower()
    if auth_mode == "none":
        return None
    env_key = os.environ.get("ORCA_API_KEY", "").strip()
    if env_key:
        if len(env_key) < 32:
            raise RuntimeError("ORCA_API_KEY must be at least 32 characters")
        return env_key
    token_file = os.environ.get("TOKEN_FILE")
    if token_file:
        token = Path(token_file).read_text(encoding="utf-8").strip()
        if len(token) < 32:
            raise RuntimeError("API key must be at least 32 characters")
        return token
    default_secret = Path("/run/secrets/api-key")
    if default_secret.is_file():
        token = default_secret.read_text(encoding="utf-8").strip()
        if len(token) < 32:
            raise RuntimeError("API key must be at least 32 characters")
        return token
    if auth_mode == "required":
        raise RuntimeError("AUTH_MODE=required but no ORCA_API_KEY or TOKEN_FILE provided")
    return None


TOKEN = _load_token()
AUTH_REQUIRED = TOKEN is not None

MAX_INPUT = 50 * 1024 * 1024  # 50 MiB (supports rich 3MF & high-poly STL)
MAX_STL_V1 = 20 * 1024 * 1024
MAX_OUTPUT = 64 * 1024 * 1024
MAX_PENDING = 5  # one running and four queued/uploading
MAX_RETAINED = 16
MAX_CONFIG_HANDLES = 64
TTL = 86400
TIMEOUT = 300
LOG_TAIL_BYTES = 65536

API_VERSION = "2.1.0"

PRESET = {
    "id": "bambu-a1-mini-0.4-pla",
    "printer": "Bambu Lab A1 mini",
    "nozzle_mm": 0.4,
    "material": "Generic PLA",
    "process": "0.20mm Standard @BBL A1M",
    "bed": "Textured PEI Plate",
    "build_volume_mm": [180, 180, 180],
    "units": "millimeters",
}

LIMITS = {
    "max_upload_bytes": MAX_STL_V1,
    "max_3mf_upload_bytes": MAX_INPUT,
    "max_output_bytes": MAX_OUTPUT,
    "max_running": 1,
    "max_queued": 4,
    "runtime_seconds": TIMEOUT,
    "retention_seconds": TTL,
    "max_retained_jobs": MAX_RETAINED,
    "max_configuration_request_bytes": MAX_CONFIG_REQUEST_BYTES,
    "max_expanded_configuration_bytes": MAX_EXPANDED_CONFIG_BYTES,
    "max_configuration_handles": MAX_CONFIG_HANDLES,
    "configuration_retention_seconds": TTL,
}

CATALOG = ProfileCatalog(ROOT)

DATA.mkdir(parents=True, exist_ok=True)
MESHES_DIR = DATA / "meshes"
MESHES_DIR.mkdir(parents=True, exist_ok=True)
MESH_CACHE_TTL = 4 * 3600
MESH_CACHE_MAX_BYTES = 256 * 1024 * 1024
DB = sqlite3.connect(DATA / "jobs.sqlite3", check_same_thread=False)
DB.execute("PRAGMA journal_mode=WAL")
DB.execute("CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, record TEXT NOT NULL)")
DB.execute("CREATE TABLE IF NOT EXISTS configurations (id TEXT PRIMARY KEY, record TEXT NOT NULL)")
DB.commit()

LOCK = threading.RLock()
JOBS: dict[str, dict] = {
    key: json.loads(record) for key, record in DB.execute("SELECT id, record FROM jobs")
}
CONFIGS: dict[str, dict] = {
    key: json.loads(record) for key, record in DB.execute("SELECT id, record FROM configurations")
}


def save_job(job: dict):
    try:
        DB.execute("INSERT OR REPLACE INTO jobs VALUES (?, ?)", (job["id"], json.dumps(job)))
        DB.commit()
    except sqlite3.Error:
        DB.rollback()
        raise
    JOBS[job["id"]] = job


def save_config(cfg: dict):
    try:
        DB.execute("INSERT OR REPLACE INTO configurations VALUES (?, ?)", (cfg["id"], json.dumps(cfg)))
        DB.commit()
    except sqlite3.Error:
        DB.rollback()
        raise
    CONFIGS[cfg["id"]] = cfg


def delete_config(key: str):
    DB.execute("DELETE FROM configurations WHERE id=?", (key,))
    DB.commit()
    CONFIGS.pop(key, None)


def clean_workspace(job: dict):
    directory = DATA / job["id"]
    if not directory.exists():
        return
    keep_names = set()
    if job["status"] == "succeeded":
        keep_names.add("output.gcode")
        keep_names.add("output.3mf")
        for plate in job.get("plates", []):
            if plate.get("gcode_file"):
                keep_names.add(plate["gcode_file"])
    for path in directory.iterdir():
        if path.name in keep_names:
            continue
        if path.is_dir():
            shutil.rmtree(path, ignore_errors=True)
        else:
            path.unlink(missing_ok=True)


def delete_job(key: str):
    job = JOBS[key]
    job["status"] = "deleting"
    save_job(job)
    if (DATA / key).exists():
        shutil.rmtree(DATA / key, ignore_errors=True)
    DB.execute("DELETE FROM jobs WHERE id=?", (key,))
    DB.commit()
    del JOBS[key]


def expire():
    now = time.time()
    for key, job in list(JOBS.items()):
        if now >= job["expires_at"] and job["status"] not in ("running", "uploading"):
            delete_job(key)
    for key, cfg in list(CONFIGS.items()):
        if now >= cfg.get("expires_at", 0):
            delete_config(key)


with LOCK:
    for job in list(JOBS.values()):
        if job["status"] == "deleting":
            delete_job(job["id"])
            continue
        if job["status"] in ("running", "uploading"):
            job.update(status="failed", error="Service restarted before job completed")
            save_job(job)
        if job["status"] in ("failed", "succeeded"):
            clean_workspace(job)
    for directory in DATA.iterdir():
        if (
            directory.is_dir()
            and re.fullmatch(r"[a-f0-9]{32}", directory.name)
            and directory.name not in JOBS
        ):
            shutil.rmtree(directory, ignore_errors=True)
    expire()


def _prune_staged_meshes():
    now = time.time()
    entries: list[tuple[float, int, Path]] = []
    total = 0
    for p in MESHES_DIR.glob("*.stl"):
        try:
            st = p.stat()
        except OSError:
            continue
        if now - st.st_mtime > MESH_CACHE_TTL:
            p.unlink(missing_ok=True)
            continue
        entries.append((st.st_mtime, st.st_size, p))
        total += st.st_size
    if total > MESH_CACHE_MAX_BYTES:
        entries.sort(key=lambda x: x[0])
        for _, sz, p in entries:
            if total <= MESH_CACHE_MAX_BYTES:
                break
            p.unlink(missing_ok=True)
            total -= sz


def _euler_xyz_scale_matrix(
    pos: list[float], rot_deg: list[float], scale: list[float]
) -> tuple[float, float, float, float, float, float, float, float, float, float, float, float]:
    """3x4 affine matrix matching Three.js Euler('XYZ') + Scale + Position."""
    rx, ry, rz = (math.radians(float(a)) for a in rot_deg)
    cx, sx = math.cos(rx), math.sin(rx)
    cy, sy = math.cos(ry), math.sin(ry)
    cz, sz = math.cos(rz), math.sin(rz)
    scx, scy, scz = (float(s) for s in scale)
    tx, ty, tz = (float(p) for p in pos)

    # Rotation matrix R = Rx * Ry * Rz (matches Three.js makeRotationFromEuler order 'XYZ')
    r00 = cy * cz
    r01 = -cy * sz
    r02 = sy
    r10 = cx * sz + sx * sy * cz
    r11 = cx * cz - sx * sy * sz
    r12 = -sx * cy
    r20 = sx * sz - cx * sy * cz
    r21 = sx * cz + cx * sy * sz
    r22 = cx * cy

    return (
        r00 * scx, r01 * scy, r02 * scz, tx,
        r10 * scx, r11 * scy, r12 * scz, ty,
        r20 * scx, r21 * scy, r22 * scz, tz,
    )


def _read_stl_triangles(path: Path) -> list[tuple[float, float, float, float, float, float, float, float, float]]:
    blob = path.read_bytes()
    if len(blob) >= 84:
        count = struct.unpack_from("<I", blob, 80)[0]
        if count > 0 and len(blob) == 84 + 50 * count:
            tris = []
            offset = 84
            for _ in range(count):
                _, _, _, x1, y1, z1, x2, y2, z2, x3, y3, z3 = struct.unpack_from("<12f", blob, offset)
                tris.append((x1, y1, z1, x2, y2, z2, x3, y3, z3))
                offset += 50
            return tris
    # ASCII STL fallback
    tris = []
    verts: list[tuple[float, float, float]] = []
    for line in blob.decode("utf-8", errors="ignore").splitlines():
        parts = line.strip().split()
        if len(parts) >= 4 and parts[0].lower() == "vertex":
            verts.append((float(parts[1]), float(parts[2]), float(parts[3])))
            if len(verts) == 3:
                tris.append((*verts[0], *verts[1], *verts[2]))
                verts.clear()
    return tris


def _write_transformed_stl(mesh_path: Path, obj_spec: dict, out_path: Path):
    tris = _read_stl_triangles(mesh_path)
    pos = obj_spec.get("position") or [0.0, 0.0, 0.0]
    rot = obj_spec.get("rotation") or [0.0, 0.0, 0.0]
    scl = obj_spec.get("scale") or [1.0, 1.0, 1.0]
    m00, m01, m02, tx, m10, m11, m12, ty, m20, m21, m22, tz = _euler_xyz_scale_matrix(pos, rot, scl)

    header = b"OrcaCloud staged STL".ljust(80, b"\x00")
    out = bytearray(84 + len(tris) * 50)
    out[0:80] = header
    struct.pack_into("<I", out, 80, len(tris))
    off = 84
    for x1, y1, z1, x2, y2, z2, x3, y3, z3 in tris:
        ax = m00 * x1 + m01 * y1 + m02 * z1 + tx
        ay = m10 * x1 + m11 * y1 + m12 * z1 + ty
        az = m20 * x1 + m21 * y1 + m22 * z1 + tz
        bx = m00 * x2 + m01 * y2 + m02 * z2 + tx
        by = m10 * x2 + m11 * y2 + m12 * z2 + ty
        bz = m20 * x2 + m21 * y2 + m22 * z2 + tz
        cx = m00 * x3 + m01 * y3 + m02 * z3 + tx
        cy = m10 * x3 + m11 * y3 + m12 * z3 + ty
        cz = m20 * x3 + m21 * y3 + m22 * z3 + tz
        ux, uy, uz = bx - ax, by - ay, bz - az
        vx, vy, vz = cx - ax, cy - ay, cz - az
        nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
        nl = math.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
        struct.pack_into("<12fH", out, off, nx / nl, ny / nl, nz / nl, ax, ay, az, bx, by, bz, cx, cy, cz, 0)
        off += 50
    out_path.write_bytes(bytes(out))


def _xml_esc(val: str) -> str:
    return (
        val.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&apos;")
    )


def _assemble_3mf_from_staged_meshes(objects_spec: list[dict], out_path: Path):
    """Assemble a native OrcaSlicer .3mf directly from server-staged STL files (zero re-upload!)."""
    obj_xml_parts: list[str] = []
    build_items: list[str] = []
    cfg_objects: list[str] = []

    for idx, spec in enumerate(objects_spec, start=1):
        mesh_id = spec["mesh_id"]
        mesh_path = MESHES_DIR / f"{mesh_id}.stl"
        tris = _read_stl_triangles(mesh_path)
        pos = spec.get("position") or [0.0, 0.0, 0.0]
        rot = spec.get("rotation") or [0.0, 0.0, 0.0]
        scl = spec.get("scale") or [1.0, 1.0, 1.0]
        m00, m01, m02, tx, m10, m11, m12, ty, m20, m21, m22, tz = _euler_xyz_scale_matrix(pos, rot, scl)

        vert_map: dict[tuple[float, float, float], int] = {}
        verts_out: list[str] = []
        tris_out: list[str] = []

        def _add_v(x: float, y: float, z: float) -> int:
            ax = round(m00 * x + m01 * y + m02 * z + tx, 4)
            ay = round(m10 * x + m11 * y + m12 * z + ty, 4)
            az = round(m20 * x + m21 * y + m22 * z + tz, 4)
            key = (ax, ay, az)
            vid = vert_map.get(key)
            if vid is None:
                vid = len(verts_out)
                vert_map[key] = vid
                verts_out.append(f'<vertex x="{ax}" y="{ay}" z="{az}"/>')
            return vid

        for x1, y1, z1, x2, y2, z2, x3, y3, z3 in tris:
            v1 = _add_v(x1, y1, z1)
            v2 = _add_v(x2, y2, z2)
            v3 = _add_v(x3, y3, z3)
            tris_out.append(f'<triangle v1="{v1}" v2="{v2}" v3="{v3}"/>')

        name = _xml_esc(str(spec.get("name") or f"object_{idx}"))
        obj_xml_parts.append(
            f'<object id="{idx}" name="{name}" type="model"><mesh>'
            f'<vertices>{"".join(verts_out)}</vertices>'
            f'<triangles>{"".join(tris_out)}</triangles>'
            f'</mesh></object>'
        )
        build_items.append(f'<item objectid="{idx}" printable="1"/>')

        extruder = int(spec.get("filament_index") or 0) + 1
        meta_lines = [
            f'<metadata key="name" value="{name}"/>',
            f'<metadata key="extruder" value="{extruder}"/>',
        ]
        overrides = spec.get("overrides") or {}
        if isinstance(overrides, dict):
            for ok, ov in overrides.items():
                if not isinstance(ok, str) or ok in CATALOG.restricted_keys:
                    continue
                ov_str = ov[0] if isinstance(ov, list) and ov else (ov if isinstance(ov, str) else None)
                if ov_str is not None:
                    meta_lines.append(f'<metadata key="{_xml_esc(ok)}" value="{_xml_esc(ov_str)}"/>')
        cfg_objects.append(f'<object id="{idx}">{"".join(meta_lines)}</object>')

    content_types = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>'
        '<Default Extension="config" ContentType="text/xml"/>'
        '</Types>'
    )
    rels = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>'
        '</Relationships>'
    )
    model_xml = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">'
        f'<resources>{"".join(obj_xml_parts)}</resources>'
        f'<build>{"".join(build_items)}</build>'
        '</model>'
    )
    settings_xml = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        f'<config>{"".join(cfg_objects)}</config>'
    )

    with zipfile.ZipFile(out_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", content_types)
        zf.writestr("_rels/.rels", rels)
        zf.writestr("3D/3dmodel.model", model_xml)
        zf.writestr("Metadata/model_settings.config", settings_xml)


def validate_stl(path: Path, build_volume: list[float], preserve_xy: bool = False) -> list[float]:
    """Validate binary or ASCII STL coordinates and bounds before native slicing."""
    blob = path.read_bytes()
    points: list[float] = []
    if len(blob) >= 84:
        count = struct.unpack_from("<I", blob, 80)[0]
        binary = count > 0 and len(blob) == 84 + 50 * count
    else:
        binary = False

    if binary:
        for offset in range(84, len(blob), 50):
            values = struct.unpack_from("<12f", blob, offset)
            points.extend(values[3:])
    else:
        try:
            text = blob.decode("ascii")
        except UnicodeDecodeError as exc:
            raise ValueError("Upload must be a binary or ASCII STL") from exc
        if not text.lstrip().startswith("solid") or "endsolid" not in text:
            raise ValueError("Upload must be a binary or ASCII STL")
        for line in text.splitlines():
            fields = line.split()
            if fields and fields[0] == "vertex":
                if len(fields) != 4:
                    raise ValueError("Malformed STL vertex")
                points.extend(float(value) for value in fields[1:])
        if len(points) < 9 or len(points) % 9:
            raise ValueError("STL must contain complete triangles")

    if not all(math.isfinite(value) and abs(value) <= 10000 for value in points):
        raise ValueError("STL coordinates must be finite and within 10000 mm of origin")

    xs = points[0::3]
    ys = points[1::3]
    zs = points[2::3]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    min_z, max_z = min(zs), max(zs)
    dimensions = [max_x - min_x, max_y - min_y, max_z - min_z]

    max_x_vol, max_y_vol, max_z_vol = build_volume
    if any(size <= 0 for size in dimensions):
        raise ValueError("Model must have positive dimensions along all axes")
    if dimensions[0] > max_x_vol + 0.5 or dimensions[1] > max_y_vol + 0.5 or dimensions[2] > max_z_vol + 0.5:
        raise ValueError(
            f"Model ({dimensions[0]:.1f}x{dimensions[1]:.1f}x{dimensions[2]:.1f} mm) "
            f"exceeds build volume ({max_x_vol:.0f}x{max_y_vol:.0f}x{max_z_vol:.0f} mm)"
        )
    if preserve_xy:
        margin = 1.0
        if min_x < -margin or max_x > max_x_vol + margin or min_y < -margin or max_y > max_y_vol + margin:
            raise ValueError(
                f"Positioned model XY [{min_x:.1f}..{max_x:.1f}, {min_y:.1f}..{max_y:.1f}] mm "
                f"lies outside printable bed [0..{max_x_vol:.0f}, 0..{max_y_vol:.0f}] mm"
            )
    return [round(size, 4) for size in dimensions]


def validate_3mf(path: Path) -> list[float] | None:
    """Validate that an uploaded 3MF is a well-formed zip archive with 3D model XML."""
    try:
        with zipfile.ZipFile(path, "r") as zf:
            names = zf.namelist()
            if len(names) > 512:
                raise ValueError("3MF archive contains too many entries")
            total_uncompressed = sum(info.file_size for info in zf.infolist())
            if total_uncompressed > 256 * 1024 * 1024:
                raise ValueError("3MF uncompressed size exceeds 256 MiB safety limit")
            if not any(n.lower().endswith(".model") for n in names):
                raise ValueError("3MF archive contains no .model geometry")
    except zipfile.BadZipFile as exc:
        raise ValueError("Upload is not a valid 3MF zip archive") from exc
    return None


def _run_orca(command: list[str], cwd: Path, timeout: int = TIMEOUT) -> tuple[int, str, bool]:
    home = cwd / "home"
    home.mkdir(exist_ok=True)
    environment = {
        "PATH": "/usr/bin:/bin",
        "HOME": str(home),
        "LC_ALL": "C",
        "OMP_NUM_THREADS": os.environ.get("OMP_NUM_THREADS", "2"),
    }
    log_path = cwd / "native.log"
    with log_path.open("wb") as log:
        process = subprocess.Popen(
            command,
            cwd=cwd,
            env=environment,
            stdout=log,
            stderr=log,
            start_new_session=True,
        )
        try:
            rc = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
            raise RuntimeError(f"OrcaSlicer exceeded {timeout} second runtime limit") from None
        finally:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    raw_log = log_path.read_bytes() if log_path.is_file() else b""
    truncated = len(raw_log) > LOG_TAIL_BYTES
    tail = raw_log[-LOG_TAIL_BYTES:].decode("utf-8", errors="replace")
    return rc, tail, truncated


def _inspect_gcode_header_footer(gcode_path: Path) -> dict:
    size = gcode_path.stat().st_size
    with gcode_path.open("rb") as stream:
        head = stream.read(65536).decode("utf-8", errors="replace")
        stream.seek(max(0, size - 65536))
        tail = stream.read(65536).decode("utf-8", errors="replace")
    combined = head + "\n" + tail
    info: dict = {}
    for key, pattern in {
        "estimated_print_time": r"(?:total estimated time: |estimated printing time \(normal mode\) = )([^;\n]+)",
        "filament_used_grams": r"^; (?:total )?filament used \[g\] = (.+)$",
        "filament_used_mm": r"^; (?:total )?filament used \[mm\] = (.+)$",
        "filament_used_cm3": r"^; (?:total )?filament used \[cm3\] = (.+)$",
        "filament_cost": r"^; (?:total )?filament cost = (.+)$",
        "layer_count": r"^; (?:total layer number|total layers count)[:=] ?(.+)$",
    }.items():
        match = re.search(pattern, combined, re.MULTILINE)
        if match:
            info[key] = match.group(1).strip()
    return info


def slice_job(job: dict) -> tuple[dict, dict, list[dict]]:
    retained = DATA / job["id"]
    work = Path(tempfile.mkdtemp(prefix=f"orca-work-{job['id'][:8]}-", dir="/tmp"))
    try:
        input_format = job.get("input_format", "stl")
        input_name = "input.3mf" if input_format == "3mf" else "input.stl"
        shutil.copyfile(retained / input_name, work / input_name)

        cfg = job.get("configuration")
        if cfg:
            resolved = cfg["resolved"]
            proc_path = work / "process.json"
            printer_path = work / "printer.json"
            proc_path.write_text(json.dumps(resolved["process"], indent=2), encoding="utf-8")
            printer_path.write_text(json.dumps(resolved["printer"], indent=2), encoding="utf-8")

            filaments_list = resolved.get("filaments") or [resolved["filament"]]
            fil_paths: list[str] = []
            for idx, fdata in enumerate(filaments_list):
                fp = work / f"filament_{idx}.json"
                fp.write_text(json.dumps(fdata, indent=2), encoding="utf-8")
                fil_paths.append(str(fp))

            settings_arg = f"{proc_path};{printer_path}"
            filaments_arg = ";".join(fil_paths)
            bed_type = resolved["bed_type"]
            placement = cfg.get("placement", "arrange")
        else:
            settings_arg = f"{ROOT}/presets/process.json;{ROOT}/presets/printer.json"
            filaments_arg = f"{ROOT}/presets/filament.json"
            bed_type = "Textured PEI Plate"
            placement = "arrange"

        effective_path = work / "effective.json"
        orca_args = [
            ORCA_BIN,
            "--load-settings",
            settings_arg,
            "--load-filaments",
            filaments_arg,
            "--curr-bed-type",
            bed_type,
        ]
        if placement == "preserve_xy":
            orca_args.extend(["--arrange", "0", "--orient", "0"])
        else:
            orca_args.extend(["--arrange", "1"])

        orca_args.extend([
            "--slice",
            "0",
            "--export-statistics",
            "--export-settings",
            str(effective_path),
            "--export-3mf",
            "output.3mf",
            "--outputdir",
            str(work),
            str(work / input_name),
        ])

        prlimit = shutil.which("prlimit")
        if prlimit:
            command = [
                prlimit,
                f"--fsize={MAX_OUTPUT}",
                f"--cpu={TIMEOUT}",
                "--core=0",
                "--",
                *orca_args,
            ]
        else:
            command = orca_args

        started = time.monotonic()
        rc, log_tail, log_truncated = _run_orca(command, work, timeout=TIMEOUT)
        duration = round(time.monotonic() - started, 3)

        native_result = None
        result_json = work / "result.json"
        if result_json.is_file():
            try:
                native_result = json.loads(result_json.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                native_result = None

        exported_settings: dict = {}
        if effective_path.is_file():
            try:
                exported_settings = json.loads(effective_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                exported_settings = {}

        # Read plate statistics
        native_statistics: dict[str, dict] = {}
        for stat_file in sorted(work.glob("plate_*.statistics.json")):
            try:
                st = json.loads(stat_file.read_text(encoding="utf-8"))
                native_statistics[stat_file.stem.replace(".statistics", "")] = st.get("summary", st)
            except (OSError, json.JSONDecodeError):
                pass

        feedback: dict = {
            "stage": "native_slice",
            "physical_safety": "not_assessed",
            "model_sha256": job.get("model_sha256"),
            "effective_sha256": canonical_sha256(exported_settings) if exported_settings else None,
            "effective_settings": exported_settings,
            "native_result": native_result,
            "native_statistics": native_statistics.get("plate_1") if len(native_statistics) == 1 else native_statistics,
            "native_statistics_by_plate": native_statistics,
            "native_statistics_status": "available" if native_statistics else "unavailable",
            "native_log_tail": log_tail,
            "native_log_truncated": log_truncated,
            "provenance": CATALOG.provenance,
        }

        if cfg and exported_settings:
            field_evidence, explicit_mismatches = CATALOG.compare_effective_settings(
                cfg["resolved"], cfg.get("explicit_fields", {}), exported_settings
            )
            feedback["field_evidence"] = field_evidence
        else:
            explicit_mismatches = []

        if rc != 0:
            err_msg = (
                native_result.get("error_string")
                if isinstance(native_result, dict) and native_result.get("error_string")
                else f"OrcaSlicer exited with status {rc}"
            )
            raise RuntimeError(err_msg)

        output_3mf = work / "output.3mf"
        if not output_3mf.is_file():
            raise RuntimeError("OrcaSlicer did not produce output.3mf")

        plates: list[dict] = []
        with zipfile.ZipFile(output_3mf, "r") as archive:
            gcode_entries = sorted(
                [
                    entry
                    for entry in archive.infolist()
                    if re.fullmatch(r"Metadata/plate_\d+\.gcode", entry.filename)
                ],
                key=lambda e: int(re.search(r"plate_(\d+)\.gcode", e.filename).group(1)),  # type: ignore[union-attr]
            )
            if not gcode_entries:
                raise RuntimeError("No sliced G-code plates produced")

            for entry in gcode_entries:
                plate_num = int(re.search(r"plate_(\d+)\.gcode", entry.filename).group(1))  # type: ignore[union-attr]
                if not 0 < entry.file_size <= MAX_OUTPUT:
                    raise RuntimeError(f"Plate {plate_num} G-code exceeds 64 MiB output limit")
                local_name = f"plate_{plate_num}.gcode"
                dest = work / local_name
                with archive.open(entry) as src, dest.open("wb") as dst:
                    shutil.copyfileobj(src, dst)
                plate_bytes = dest.stat().st_size
                plate_sha = hashlib.sha256(dest.read_bytes()).hexdigest()
                meta = _inspect_gcode_header_footer(dest)
                plate_stats = native_statistics.get(f"plate_{plate_num}")

                shutil.copyfile(dest, retained / f"{local_name}.partial")
                os.replace(retained / f"{local_name}.partial", retained / local_name)
                if plate_num == 1:
                    shutil.copyfile(dest, retained / "output.partial")
                    os.replace(retained / "output.partial", retained / "output.gcode")

                plates.append({
                    "plate_index": plate_num,
                    "gcode_file": local_name,
                    "gcode_url": f"/v1/jobs/{job['id']}/gcode?plate={plate_num}",
                    "gcode_bytes": plate_bytes,
                    "sha256": plate_sha,
                    "statistics": plate_stats,
                    **meta,
                })

        # Retain sliced 3MF for download
        if output_3mf.stat().st_size <= MAX_OUTPUT:
            shutil.copyfile(output_3mf, retained / "output.3mf.partial")
            os.replace(retained / "output.3mf.partial", retained / "output.3mf")

        primary = plates[0]
        summary = {
            "gcode_bytes": primary["gcode_bytes"],
            "sha256": primary["sha256"],
            "slice_duration_seconds": duration,
            "plate_count": len(plates),
            "has_3mf": (retained / "output.3mf").is_file(),
        }
        for field in (
            "estimated_print_time",
            "filament_used_grams",
            "filament_used_mm",
            "filament_used_cm3",
            "filament_cost",
            "layer_count",
        ):
            if field in primary:
                summary[field] = primary[field]
        if primary.get("statistics"):
            summary["statistics"] = primary["statistics"]

        if explicit_mismatches:
            feedback["explicit_mismatches"] = explicit_mismatches

        return summary, feedback, plates
    finally:
        shutil.rmtree(work, ignore_errors=True)


def run_mesh_utility(action: str, stl_bytes: bytes) -> tuple[bytes | dict, str]:
    """Run native OrcaSlicer mesh utility (--repair, --orient 1, --inspect-mesh)."""
    work = Path(tempfile.mkdtemp(prefix=f"orca-mesh-{action}-", dir="/tmp"))
    try:
        inp = work / "input.stl"
        inp.write_bytes(stl_bytes)
        if action == "inspect":
            cmd = [ORCA_BIN, "--inspect-mesh", str(inp)]
            rc, log_tail, _ = _run_orca(cmd, work, timeout=60)
            if rc != 0:
                raise RuntimeError(f"OrcaSlicer --inspect-mesh failed ({rc}): {log_tail[-300:]}")
            # Parse JSON object from output (Orca may print non-JSON warning lines before JSON)
            start = log_tail.find("{")
            end = log_tail.rfind("}")
            if start == -1 or end == -1 or end <= start:
                raise RuntimeError("OrcaSlicer --inspect-mesh produced no JSON")
            return json.loads(log_tail[start : end + 1]), "application/json"

        out_dir = work / "out"
        out_dir.mkdir()
        if action == "repair":
            cmd = [ORCA_BIN, "--repair", "--export-stl", "--outputdir", str(out_dir), str(inp)]
        elif action == "auto-orient":
            cmd = [ORCA_BIN, "--orient", "1", "--ensure-on-bed", "--export-stl", "--outputdir", str(out_dir), str(inp)]
        else:
            raise ValueError(f"Unknown mesh action: {action}")

        rc, log_tail, _ = _run_orca(cmd, work, timeout=90)
        if rc != 0:
            raise RuntimeError(f"OrcaSlicer {action} failed ({rc}): {log_tail[-300:]}")
        stls = sorted(out_dir.rglob("*.stl"))
        if not stls:
            raise RuntimeError(f"OrcaSlicer {action} produced no output STL")
        return stls[0].read_bytes(), "model/stl"
    finally:
        shutil.rmtree(work, ignore_errors=True)


def worker_loop():
    while True:
        with LOCK:
            expire()
            job = next((j for j in JOBS.values() if j["status"] == "queued"), None)
            if job:
                job.update(status="running", started_at=time.time())
                save_job(job)
        if not job:
            time.sleep(0.25)
            continue
        terminal = dict(job)
        try:
            summary, feedback, plates = slice_job(job)
            terminal.update(
                status="succeeded",
                summary=summary,
                feedback=feedback,
                plates=plates,
                output_bytes=summary["gcode_bytes"],
                output_sha256=summary["sha256"],
                output_3mf_url=f"/v1/jobs/{job['id']}/3mf" if summary.get("has_3mf") else None,
            )
        except Exception as exc:  # noqa: BLE001
            print(f"job {job['id']} failed: {exc}", flush=True)
            terminal.update(
                status="failed",
                error=str(exc) if isinstance(exc, RuntimeError) else f"Slicing failed: {exc}",
            )
        with LOCK:
            terminal["finished_at"] = time.time()
            clean_workspace(terminal)
            save_job(terminal)


def worker():
    try:
        worker_loop()
    except BaseException:  # noqa: BLE001
        print("Fatal job worker bookkeeping failure; restarting service", flush=True)
        os._exit(1)


WORKER = threading.Thread(target=worker, daemon=True)


class Handler(BaseHTTPRequestHandler):
    server_version = "OrcaJobAPI/2"

    def setup(self):
        super().setup()
        self.connection.settimeout(60)

    def log_message(self, fmt, *args):
        pass

    def _add_cors_headers(self):
        if CORS_ORIGIN:
            self.send_header("Access-Control-Allow-Origin", CORS_ORIGIN)
            self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
            self.send_header("Access-Control-Expose-Headers", "Content-Disposition, Content-Length")

    def parse_request(self):
        if not super().parse_request():
            return False
        if not self.path.startswith("/") or self.path.startswith("//"):
            self.reply(400, {"error": "Use an origin-relative request path"})
            return False
        return True

    def do_OPTIONS(self):
        self.send_response(204)
        self._add_cors_headers()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def reply(self, status: int, payload: dict):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self._add_cors_headers()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if status == 401:
            self.send_header("WWW-Authenticate", "Bearer")
        if status == 429:
            self.send_header("Retry-After", "30")
        self.end_headers()
        self.wfile.write(body)

    def reply_bytes(self, status: int, data: bytes, content_type: str, filename: str | None = None):
        self.send_response(status)
        self._add_cors_headers()
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        if filename:
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.end_headers()
        self.wfile.write(data)

    def authenticated(self) -> bool:
        if not AUTH_REQUIRED:
            return True
        if not hmac.compare_digest(
            self.headers.get("Authorization", "").encode("utf-8"),
            ("Bearer " + (TOKEN or "")).encode("utf-8"),
        ):
            self.reply(401, {"error": "Bearer authentication required"})
            return False
        return True

    def _read_body_bytes(self, max_bytes: int, deadline_secs: float = 45.0) -> bytes:
        if self.headers.get("Transfer-Encoding"):
            raise ValueError("Transfer-Encoding is not supported")
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise ValueError("Invalid Content-Length") from exc
        if length <= 0 or length > max_bytes:
            raise OverflowError(f"Body must be 1 byte to {max_bytes} bytes")
        chunks = []
        remaining = length
        deadline = time.monotonic() + deadline_secs
        while remaining:
            left = deadline - time.monotonic()
            if left <= 0:
                raise ValueError("Upload exceeded deadline")
            self.connection.settimeout(left)
            chunk = self.rfile.read1(min(65536, remaining))
            if not chunk:
                raise ValueError("Incomplete upload")
            chunks.append(chunk)
            remaining -= len(chunk)
        self.connection.settimeout(60)
        return b"".join(chunks)

    def _serve_static(self, req_path: str) -> bool:
        if not STATIC_DIR or not STATIC_DIR.is_dir():
            return False
        rel = req_path.lstrip("/") or "index.html"
        candidate = (STATIC_DIR / rel).resolve()
        if not str(candidate).startswith(str(STATIC_DIR)):
            return False
        if not candidate.is_file():
            candidate = STATIC_DIR / "index.html"
        if not candidate.is_file():
            return False
        ctype, _ = mimetypes.guess_type(str(candidate))
        data = candidate.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        if rel.startswith("assets/"):
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        else:
            self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)
        return True

    def do_GET(self):
        parsed = urlsplit(self.path)
        path = parsed.path
        query = parse_qs(parsed.query, keep_blank_values=True)

        if path == "/healthz" or (path == "/" and STATIC_DIR is None):
            if not WORKER.is_alive():
                return self.reply(503, {"status": "unavailable"})
            return self.reply(
                200,
                {
                    "status": "ok",
                    "slicer": "OrcaSlicer",
                    "version": "2.5.0",
                    "api_version": API_VERSION,
                    "auth_required": AUTH_REQUIRED,
                    "openapi_url": "/openapi.json",
                    "limits": LIMITS,
                    "capabilities": {
                        "stl": True,
                        "threemf": True,
                        "multi_filament": True,
                        "multi_plate": True,
                        "preserve_xy": True,
                        "staged_meshes": True,
                        "mesh_repair": True,
                        "mesh_auto_orient": True,
                        "mesh_inspect": True,
                        "profiles_count": len(CATALOG.profiles),
                        "vendors_count": len(CATALOG.vendors),
                    },
                },
            )

        if path == "/openapi.json":
            return self.reply(200, json.loads((ROOT / "openapi.json").read_text(encoding="utf-8")))

        if path == "/v1/presets":
            return self.reply(200, {"presets": [PRESET], "limits": LIMITS})

        if path == "/v2/profiles/vendors":
            return self.reply(200, {"vendors": CATALOG.list_vendors(), "provenance": CATALOG.provenance})

        if path == "/v2/profiles/detail":
            vendor = (query.get("vendor") or [""])[0]
            kind = (query.get("kind") or [""])[0]
            name = (query.get("name") or [""])[0]
            if not vendor or kind not in ("machine", "process", "filament") or not name:
                return self.reply(400, {"error": "vendor, kind (machine|process|filament), and name are required"})
            try:
                detail = CATALOG.get_profile_detail(vendor, kind, name)
            except KeyError as exc:
                return self.reply(404, {"error": str(exc)})
            except ValueError as exc:
                return self.reply(422, {"error": str(exc)})
            return self.reply(200, detail)

        if path == "/v2/profiles/compatible":
            vendor = (query.get("vendor") or [""])[0]
            machine = (query.get("machine") or [""])[0]
            if not vendor or not machine:
                return self.reply(400, {"error": "vendor and machine are required"})
            try:
                compat = CATALOG.get_compatible_profiles(vendor, machine)
            except KeyError as exc:
                return self.reply(404, {"error": str(exc)})
            except ValueError as exc:
                return self.reply(422, {"error": str(exc)})
            return self.reply(200, compat)

        asset_match = re.fullmatch(r"/v2/assets/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)", path)
        if asset_match:
            vendor_id, filename = asset_match[1], asset_match[2]
            assets_root = (ROOT / "assets").resolve()
            candidate = (assets_root / vendor_id / filename).resolve()
            if not str(candidate).startswith(str(assets_root) + "/") or not candidate.is_file():
                return self.reply(404, {"error": "Asset not found"})
            ext = candidate.suffix.lower()
            ctype = (
                "model/stl" if ext == ".stl"
                else "image/svg+xml" if ext == ".svg"
                else "image/png" if ext == ".png"
                else "application/octet-stream"
            )
            return self.reply_bytes(200, candidate.read_bytes(), ctype)

        if path == "/v2/profiles":
            kind = (query.get("kind") or [None])[0] or None
            vendor = (query.get("vendor") or [None])[0] or None
            q = (query.get("q") or [None])[0] or None
            inst_raw = (query.get("instantiable") or ["false"])[0].lower()
            inst_only = inst_raw in ("1", "true", "yes")
            try:
                offset = int((query.get("offset") or ["0"])[0])
                limit = int((query.get("limit") or ["50"])[0])
                result = CATALOG.search_profiles(
                    kind=kind,
                    vendor=vendor,
                    q=q,
                    instantiable_only=inst_only,
                    offset=offset,
                    limit=limit,
                )
            except ValueError as exc:
                return self.reply(400, {"error": str(exc)})
            return self.reply(200, result)

        if path == "/v2/settings":
            return self.reply(200, CATALOG.settings_doc)

        # Authenticated routes (open when AUTH_REQUIRED is False)
        if path.startswith(("/v1/jobs", "/v2/configurations")):
            if not self.authenticated():
                return

        cfg_match = re.fullmatch(r"/v2/configurations/([a-f0-9]{64})", path)
        if cfg_match:
            with LOCK:
                expire()
                cfg = CONFIGS.get(cfg_match[1])
                if not cfg:
                    return self.reply(404, {"error": "Configuration not found or expired"})
                return self.reply(200, cfg)

        if path == "/v1/jobs":
            with LOCK:
                expire()
                items = sorted(JOBS.values(), key=lambda j: j.get("created_at", 0), reverse=True)
                brief = [
                    {
                        "id": j["id"],
                        "status": j["status"],
                        "preset": j.get("preset"),
                        "configuration_id": j.get("configuration_id"),
                        "created_at": j.get("created_at"),
                        "finished_at": j.get("finished_at"),
                        "summary": j.get("summary"),
                        "error": j.get("error"),
                    }
                    for j in items
                ]
                return self.reply(200, {"jobs": brief})

        job_match = re.fullmatch(r"/v1/jobs/([a-f0-9]{32})(/(gcode|3mf))?", path)
        if job_match:
            with LOCK:
                expire()
                job = JOBS.get(job_match[1])
                if not job:
                    return self.reply(404, {"error": "Job not found or expired"})
                sub = job_match[3]
                if not sub:
                    return self.reply(200, job)
                if job["status"] != "succeeded":
                    return self.reply(409, {"error": "Job has not succeeded", "status": job["status"]})

                if sub == "3mf":
                    path_3mf = DATA / job["id"] / "output.3mf"
                    if not path_3mf.is_file():
                        return self.reply(404, {"error": "Sliced 3MF not available for this job"})
                    fh = path_3mf.open("rb")
                    length = os.fstat(fh.fileno()).st_size
                    ctype = "model/3mf"
                    fname = f"{job['id']}.3mf"
                else:
                    plate_param = (query.get("plate") or ["1"])[0]
                    try:
                        plate_num = int(plate_param)
                    except ValueError:
                        return self.reply(400, {"error": "Invalid plate index"})
                    target = DATA / job["id"] / (f"plate_{plate_num}.gcode" if plate_num > 1 else "output.gcode")
                    if not target.is_file():
                        target = DATA / job["id"] / f"plate_{plate_num}.gcode"
                    if not target.is_file():
                        return self.reply(404, {"error": f"Plate {plate_num} G-code not found"})
                    fh = target.open("rb")
                    length = os.fstat(fh.fileno()).st_size
                    ctype = "text/x.gcode"
                    fname = f"{job['id']}_plate_{plate_num}.gcode" if plate_num > 1 else f"{job['id']}.gcode"

            with fh:
                self.send_response(200)
                self._add_cors_headers()
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(length))
                self.send_header("Content-Disposition", f'attachment; filename="{fname}"')
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                shutil.copyfileobj(fh, self.wfile)
            return

        if STATIC_DIR and self._serve_static(path):
            return

        return self.reply(404, {"error": "Not found"})

    def do_DELETE(self):
        if not self.authenticated():
            return
        path = urlsplit(self.path).path

        cfg_match = re.fullmatch(r"/v2/configurations/([a-f0-9]{64})", path)
        if cfg_match:
            with LOCK:
                expire()
                if cfg_match[1] not in CONFIGS:
                    return self.reply(404, {"error": "Configuration not found or expired"})
                delete_config(cfg_match[1])
            self.send_response(204)
            self._add_cors_headers()
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        match = re.fullmatch(r"/v1/jobs/([a-f0-9]{32})", path)
        if not match:
            return self.reply(404, {"error": "Not found"})
        with LOCK:
            expire()
            job = JOBS.get(match[1])
            if not job:
                return self.reply(404, {"error": "Job not found or expired"})
            if job["status"] not in ("succeeded", "failed"):
                return self.reply(
                    409,
                    {"error": "Only terminal jobs can be deleted", "status": job["status"]},
                )
            delete_job(job["id"])
        self.send_response(204)
        self._add_cors_headers()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _handle_configuration_post(self, persist: bool):
        ctype = self.headers.get("Content-Type", "").split(";")[0].strip().lower()
        if ctype != "application/json":
            return self.reply(415, {"error": "Content-Type must be application/json"})
        try:
            raw = self._read_body_bytes(MAX_CONFIG_REQUEST_BYTES, deadline_secs=30.0)
        except OverflowError:
            return self.reply(413, {"error": "Configuration JSON must be 1 byte to 1 MiB"})
        except ValueError as exc:
            return self.reply(400, {"error": str(exc)})
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            return self.reply(422, {"error": f"Invalid JSON: {exc}", "stage": "static", "issues": []})

        resolved, issues = CATALOG.resolve_configuration(payload)
        if issues or resolved is None:
            return self.reply(422, {
                "error": issues[0]["message"] if issues else "Invalid configuration",
                "stage": "static",
                "issues": issues,
            })

        if not persist:
            return self.reply(200, resolved)

        with LOCK:
            expire()
            existing = CONFIGS.get(resolved["id"])
            if existing:
                return self.reply(201, existing)
            if len(CONFIGS) >= MAX_CONFIG_HANDLES:
                # Evict oldest configuration handle when no auth / browser session churn, else 429
                if not AUTH_REQUIRED:
                    oldest_id = min(CONFIGS, key=lambda k: CONFIGS[k].get("created_at", 0))
                    delete_config(oldest_id)
                else:
                    return self.reply(429, {"error": "Configuration handle capacity reached"})
            now = time.time()
            record = dict(resolved, created_at=now, expires_at=now + TTL)
            save_config(record)
            return self.reply(201, record)

    def _handle_mesh_post(self, action: str):
        ctype = self.headers.get("Content-Type", "").split(";")[0].strip().lower()
        if ctype not in ("model/stl", "application/octet-stream"):
            return self.reply(415, {"error": "Send raw STL as model/stl or application/octet-stream"})
        try:
            data = self._read_body_bytes(MAX_STL_V1, deadline_secs=30.0)
        except OverflowError:
            return self.reply(413, {"error": "STL body must be 1 byte to 20 MiB"})
        except ValueError as exc:
            return self.reply(400, {"error": str(exc)})
        try:
            result, out_type = run_mesh_utility(action, data)
        except Exception as exc:  # noqa: BLE001
            return self.reply(422, {"error": str(exc)})
        if isinstance(result, dict):
            return self.reply(200, result)
        return self.reply_bytes(200, result, out_type)

    def _handle_job_post(self, version: int, query: dict):
        if not WORKER.is_alive():
            return self.reply(503, {"error": "Job worker unavailable"})

        config_snapshot = None
        config_id = None
        preset_id = None

        if version == 1:
            if query != {"preset": [PRESET["id"]]}:
                return self.reply(400, {"error": "Exactly one supported preset query parameter is required"})
            preset_id = PRESET["id"]
            build_volume = PRESET["build_volume_mm"]
            preserve_xy = False
            max_body = MAX_STL_V1
        else:
            cfg_ids = query.get("configuration") or []
            if len(cfg_ids) != 1 or not re.fullmatch(r"[a-f0-9]{64}", cfg_ids[0]):
                return self.reply(400, {"error": "Exactly one 64-hex configuration query parameter is required"})
            config_id = cfg_ids[0]
            with LOCK:
                expire()
                cfg = CONFIGS.get(config_id)
                if not cfg:
                    return self.reply(404, {"error": "Configuration not found or expired"})
                config_snapshot = json.loads(json.dumps(cfg))
            build_volume = config_snapshot["build_volume_mm"]
            preserve_xy = config_snapshot.get("placement") == "preserve_xy"
            max_body = MAX_INPUT

        ctype = self.headers.get("Content-Type", "").split(";")[0].strip().lower()
        is_json = ctype == "application/json"
        is_3mf = ctype in (
            "model/3mf",
            "application/vnd.ms-package.3dmanufacturing-3dmodel+xml",
            "application/zip",
        )
        is_stl = ctype in ("model/stl", "application/octet-stream")
        if version == 1 and not is_stl:
            return self.reply(415, {"error": "Send raw STL as model/stl or application/octet-stream"})
        if version == 2 and not (is_stl or is_3mf or is_json):
            return self.reply(415, {"error": "Send raw STL (model/stl), 3MF (model/3mf), or staged mesh JSON (application/json)"})

        if self.headers.get("Transfer-Encoding"):
            return self.reply(400, {"error": "Transfer-Encoding is not supported"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return self.reply(400, {"error": "Invalid Content-Length"})
        if not 0 < length <= max_body:
            limit_mb = max_body // (1024 * 1024)
            return self.reply(413, {"error": f"Model body must be 1 byte to {limit_mb} MiB"})

        staged_objects: list[dict] | None = None
        if is_json:
            try:
                raw_json = self._read_body_bytes(min(max_body, 512 * 1024))
                payload = json.loads(raw_json.decode("utf-8"))
            except (ValueError, OverflowError, json.JSONDecodeError) as exc:
                return self.reply(400, {"error": f"Invalid JSON job request: {exc}"})
            objs = payload.get("objects")
            if not isinstance(objs, list) or not objs:
                return self.reply(400, {"error": "JSON job request requires a non-empty objects array"})
            for obj in objs:
                mid = obj.get("mesh_id") if isinstance(obj, dict) else None
                if not isinstance(mid, str) or not re.fullmatch(r"[a-f0-9]{64}", mid):
                    return self.reply(400, {"error": "Each object requires a 64-hex mesh_id"})
                mpath = MESHES_DIR / f"{mid}.stl"
                if not mpath.is_file():
                    return self.reply(404, {"error": f"Staged mesh {mid} not found", "missing_mesh_id": mid})
                try:
                    os.utime(mpath, None)
                except OSError:
                    pass
            staged_objects = objs
            # Single simple object with no per-object overrides & default filament -> fast binary STL, else 3MF
            first = staged_objects[0]
            use_staged_3mf = (
                len(staged_objects) > 1
                or int(first.get("filament_index") or 0) != 0
                or bool(first.get("overrides"))
            )
            is_3mf = use_staged_3mf
            is_stl = not use_staged_3mf

        with LOCK:
            expire()
            pending = sum(j["status"] in ("queued", "running", "uploading") for j in JOBS.values())
            if pending >= MAX_PENDING:
                return self.reply(429, {"error": "Queue capacity reached; retry shortly"})
            if len(JOBS) >= MAX_RETAINED:
                # In browser no-auth mode, auto-evict oldest terminal job so users never hit dead capacity
                terminal_jobs = [j for j in JOBS.values() if j["status"] in ("succeeded", "failed")]
                if not AUTH_REQUIRED and terminal_jobs:
                    oldest = min(terminal_jobs, key=lambda j: j.get("created_at", 0))
                    delete_job(oldest["id"])
                else:
                    return self.reply(429, {"error": "Retained job capacity reached; delete terminal jobs or retry later"})
            if shutil.disk_usage(DATA).free < 256 * 1024 * 1024:
                return self.reply(503, {"error": "Insufficient job storage"})

            key = uuid.uuid4().hex
            now = time.time()
            job = {
                "id": key,
                "status": "uploading",
                "preset": preset_id,
                "configuration_id": config_id,
                "configuration": config_snapshot,
                "input_format": "3mf" if is_3mf else "stl",
                "created_at": now,
                "expires_at": now + TTL,
                "status_url": f"/v1/jobs/{key}",
                "output_url": f"/v1/jobs/{key}/gcode",
            }
            directory = DATA / key
            directory.mkdir()
            try:
                save_job(job)
            except BaseException:
                shutil.rmtree(directory, ignore_errors=True)
                raise

        input_path = directory / ("input.3mf" if is_3mf else "input.stl")
        try:
            if staged_objects is not None:
                if is_3mf:
                    _assemble_3mf_from_staged_meshes(staged_objects, input_path)
                else:
                    first = staged_objects[0]
                    _write_transformed_stl(MESHES_DIR / f"{first['mesh_id']}.stl", first, input_path)
                model_sha = hashlib.sha256(input_path.read_bytes()).hexdigest()
            else:
                deadline = time.monotonic() + 45
                hasher = hashlib.sha256()
                with input_path.open("wb") as upload:
                    remaining = length
                    while remaining:
                        left = deadline - time.monotonic()
                        if left <= 0:
                            raise ValueError("Upload exceeded 45 second deadline")
                        self.connection.settimeout(left)
                        chunk = self.rfile.read1(min(65536, remaining))
                        if not chunk:
                            raise ValueError("Incomplete upload")
                        hasher.update(chunk)
                        upload.write(chunk)
                        remaining -= len(chunk)
                self.connection.settimeout(60)
                model_sha = hasher.hexdigest()
            dimensions = validate_3mf(input_path) if is_3mf else validate_stl(input_path, build_volume, preserve_xy=preserve_xy)
            with LOCK:
                queued = dict(job, status="queued", model_sha256=model_sha)
                if dimensions is not None:
                    queued["model_dimensions_mm"] = dimensions
                save_job(queued)
                job = queued
        except sqlite3.Error:
            raise
        except Exception as exc:  # noqa: BLE001
            with LOCK:
                shutil.rmtree(directory, ignore_errors=True)
                DB.execute("DELETE FROM jobs WHERE id=?", (key,))
                DB.commit()
                JOBS.pop(key, None)
            return self.reply(
                422,
                {"error": str(exc) if isinstance(exc, ValueError) else "Upload failed or exceeded deadline"},
            )
        with LOCK:
            self.reply(202, job)

    def _handle_staged_mesh_post(self):
        ctype = self.headers.get("Content-Type", "").split(";")[0].strip().lower()
        if ctype not in ("model/stl", "application/octet-stream"):
            return self.reply(415, {"error": "Send raw STL as model/stl or application/octet-stream"})
        try:
            raw = self._read_body_bytes(MAX_INPUT, deadline_secs=45.0)
        except OverflowError as exc:
            return self.reply(413, {"error": str(exc)})
        except ValueError as exc:
            return self.reply(400, {"error": str(exc)})

        sha = hashlib.sha256(raw).hexdigest()
        target = MESHES_DIR / f"{sha}.stl"
        dedup = target.is_file()
        tmp_path = MESHES_DIR / f".tmp-{uuid.uuid4().hex}.stl"
        try:
            if not dedup:
                tmp_path.write_bytes(raw)
                dims = validate_stl(tmp_path, [1000.0, 1000.0, 1000.0], preserve_xy=False)
                tmp_path.replace(target)
            else:
                os.utime(target, None)
                dims = validate_stl(target, [1000.0, 1000.0, 1000.0], preserve_xy=False)
        except Exception as exc:  # noqa: BLE001
            tmp_path.unlink(missing_ok=True)
            return self.reply(422, {"error": str(exc)})

        with LOCK:
            _prune_staged_meshes()

        return self.reply(
            201,
            {
                "mesh_id": sha,
                "format": "stl",
                "size_bytes": len(raw),
                "dimensions_mm": dims,
                "deduplicated": dedup,
            },
        )

    def do_POST(self):
        if not self.authenticated():
            return
        parsed = urlsplit(self.path)
        query = parse_qs(parsed.query, keep_blank_values=True)
        path = parsed.path

        if path == "/v2/profiles/resolve":
            return self._handle_configuration_post(persist=False)
        if path == "/v2/configurations":
            return self._handle_configuration_post(persist=True)
        if path == "/v2/meshes":
            return self._handle_staged_mesh_post()
        if path == "/v1/jobs":
            return self._handle_job_post(version=1, query=query)
        if path == "/v2/jobs":
            return self._handle_job_post(version=2, query=query)
        if path == "/v2/mesh/repair":
            return self._handle_mesh_post("repair")
        if path == "/v2/mesh/auto-orient":
            return self._handle_mesh_post("auto-orient")
        if path == "/v2/mesh/inspect":
            return self._handle_mesh_post("inspect")
        return self.reply(404, {"error": "Not found"})


class _SlotMixin:
    daemon_threads = True
    request_queue_size = 32

    def __init__(self, *args, **kwargs):
        self.slots = threading.BoundedSemaphore(16)
        super().__init__(*args, **kwargs)

    def process_request(self, request, client_address):
        self.slots.acquire()
        try:
            super().process_request(request, client_address)  # type: ignore[misc]
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)  # type: ignore[misc]
        finally:
            self.slots.release()

    def handle_error(self, request, client_address):
        if isinstance(sys.exception(), (BrokenPipeError, ConnectionResetError, TimeoutError)):
            return
        print(f"HTTP request error: {sys.exception()}", flush=True)


class UnixServer(_SlotMixin, socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    pass


class TcpServer(_SlotMixin, socketserver.ThreadingMixIn, HTTPServer):
    allow_reuse_address = True


if __name__ == "__main__":
    WORKER.start()
    if HTTP_BIND:
        host, _, port_str = HTTP_BIND.rpartition(":")
        host = host or "127.0.0.1"
        port = int(port_str or "8080")
        with TcpServer((host, port), Handler) as server:
            print(
                f"OrcaSlicer 2.5.0 API v{API_VERSION} ready on http://{host}:{port} "
                f"(auth={'required' if AUTH_REQUIRED else 'none'}, profiles={len(CATALOG.profiles)})",
                flush=True,
            )
            server.serve_forever()
    else:
        Path(SOCKET).unlink(missing_ok=True)
        with UnixServer(SOCKET, Handler) as server:
            os.chmod(SOCKET, 0o666)
            print(
                f"OrcaSlicer 2.5.0 API v{API_VERSION} ready on Unix socket {SOCKET} "
                f"(auth={'required' if AUTH_REQUIRED else 'none'}, profiles={len(CATALOG.profiles)})",
                flush=True,
            )
            server.serve_forever()
