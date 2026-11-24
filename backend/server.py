"""Bounded, network-isolated OrcaSlicer job service. Python standard library only."""

import hashlib
import hmac
import json
import math
import os
import re
import shutil
import signal
import socketserver
import sqlite3
import struct
import subprocess
import sys
import threading
import time
import uuid
import zipfile
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get("DATA_DIR", "/data"))
SOCKET = os.environ.get("HTTP_SOCKET", "/alloc/orca.sock")
TOKEN = Path(os.environ.get("TOKEN_FILE", "/run/secrets/api-key")).read_text().strip()
if len(TOKEN) < 32:
    raise RuntimeError("API key must be at least 32 characters")
MAX_INPUT = 20 * 1024 * 1024
MAX_OUTPUT = 64 * 1024 * 1024
MAX_PENDING = 5  # one running and four queued/uploading
MAX_RETAINED = 16
TTL = 86400
TIMEOUT = 300
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
    "max_upload_bytes": MAX_INPUT,
    "max_output_bytes": MAX_OUTPUT,
    "max_running": 1,
    "max_queued": 4,
    "runtime_seconds": TIMEOUT,
    "retention_seconds": TTL,
    "max_retained_jobs": MAX_RETAINED,
}
DATA.mkdir(parents=True, exist_ok=True)
DB = sqlite3.connect(DATA / "jobs.sqlite3", check_same_thread=False)
DB.execute("PRAGMA journal_mode=WAL")
DB.execute(
    "CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, record TEXT NOT NULL)"
)
LOCK = threading.RLock()
JOBS = {
    key: json.loads(record) for key, record in DB.execute("SELECT id, record FROM jobs")
}


def save(job):
    try:
        DB.execute(
            "INSERT OR REPLACE INTO jobs VALUES (?, ?)", (job["id"], json.dumps(job))
        )
        DB.commit()
    except sqlite3.Error:
        DB.rollback()
        raise
    JOBS[job["id"]] = job


def clean_workspace(job):
    directory = DATA / job["id"]
    if directory.exists():
        for path in directory.iterdir():
            if job["status"] == "succeeded" and path.name == "output.gcode":
                continue
            if path.is_dir():
                shutil.rmtree(path)
            else:
                path.unlink()


def delete_job(key):
    job = JOBS[key]
    job["status"] = "deleting"
    save(job)
    if (DATA / key).exists():
        shutil.rmtree(DATA / key)
    DB.execute("DELETE FROM jobs WHERE id=?", (key,))
    DB.commit()
    del JOBS[key]


def expire():
    now = time.time()
    for key, job in list(JOBS.items()):
        if now >= job["expires_at"] and job["status"] not in ("running", "uploading"):
            delete_job(key)


with LOCK:
    for job in list(JOBS.values()):
        if job["status"] == "deleting":
            delete_job(job["id"])
            continue
        if job["status"] in ("running", "uploading"):
            job.update(status="failed", error="Service restarted before job completed")
            save(job)
        if job["status"] in ("failed", "succeeded"):
            clean_workspace(job)
    for directory in DATA.iterdir():
        if (
            directory.is_dir()
            and re.fullmatch(r"[a-f0-9]{32}", directory.name)
            and directory.name not in JOBS
        ):
            shutil.rmtree(directory)
    expire()


def validate_stl(path):
    """Reject non-STL, nonfinite or oversized geometry before native parsing."""
    blob = path.read_bytes()
    points = []
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
    dimensions = [max(points[axis::3]) - min(points[axis::3]) for axis in range(3)]
    if any(size <= 0 or size > 180 for size in dimensions):
        raise ValueError(
            "Model must have positive dimensions and fit within 180x180x180 mm"
        )
    return [round(size, 4) for size in dimensions]


def slice_job(job):
    retained = DATA / job["id"]
    directory = Path("/tmp/work")
    shutil.rmtree(directory, ignore_errors=True)
    directory.mkdir()
    shutil.copyfile(retained / "input.stl", directory / "input.stl")
    command = [
        "/usr/bin/prlimit",
        f"--fsize={MAX_OUTPUT}",
        f"--cpu={TIMEOUT}",
        "--core=0",
        "--",
        "/opt/orca/AppRun",
        "--load-settings",
        f"{ROOT}/presets/process.json;{ROOT}/presets/printer.json",
        "--load-filaments",
        f"{ROOT}/presets/filament.json",
        "--curr-bed-type",
        "Textured PEI Plate",
        "--arrange",
        "1",
        "--slice",
        "0",
        "--export-3mf",
        "output.3mf",
        "--outputdir",
        str(directory),
        str(directory / "input.stl"),
    ]
    environment = {
        "PATH": "/usr/bin:/bin",
        "HOME": str(directory / "home"),
        "LC_ALL": "C",
        "OMP_NUM_THREADS": "2",
    }
    (directory / "home").mkdir(exist_ok=True)
    started = time.monotonic()
    with (directory / "native.log").open("wb") as log:
        process = subprocess.Popen(
            command,
            cwd=directory,
            env=environment,
            stdout=log,
            stderr=log,
            start_new_session=True,
        )
        try:
            result = process.wait(timeout=TIMEOUT)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            raise RuntimeError("Slicing exceeded 300 second runtime limit") from None
        finally:
            # Reap any native helper descendants, including on normal exits.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    if result:
        raise RuntimeError(f"OrcaSlicer rejected the model or preset (exit {result})")
    output = directory / "output.gcode"
    with zipfile.ZipFile(directory / "output.3mf") as archive:
        files = [
            entry
            for entry in archive.infolist()
            if re.fullmatch(r"Metadata/plate_\d+\.gcode", entry.filename)
        ]
        if len(files) != 1 or not 0 < files[0].file_size <= MAX_OUTPUT:
            raise RuntimeError("Expected one G-code plate within 64 MiB output limit")
        with archive.open(files[0]) as source, output.open("wb") as destination:
            shutil.copyfileobj(source, destination)
    summary = {
        "gcode_bytes": output.stat().st_size,
        "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
        "slice_duration_seconds": round(time.monotonic() - started, 3),
    }
    with output.open("rb") as stream:
        header = stream.read(32768).decode(errors="replace")
        stream.seek(max(0, output.stat().st_size - 32768))
        header += "\n" + stream.read(32768).decode(errors="replace")
    for key, pattern in {
        "estimated_print_time": r"(?:total estimated time: |estimated printing time \(normal mode\) = )([^;\n]+)",
        "filament_used_grams": r"^; (?:total )?filament used \[g\] = (.+)$",
        "layer_count": r"^; (?:total layer number|total layers count)[:=] ?(.+)$",
    }.items():
        match = re.search(pattern, header, re.MULTILINE)
        if match:
            summary[key] = match.group(1).strip()
    shutil.copyfile(output, retained / "output.partial")
    os.replace(retained / "output.partial", retained / "output.gcode")
    return summary


def worker_loop():
    while True:
        with LOCK:
            expire()
            job = next(
                (job for job in JOBS.values() if job["status"] == "queued"), None
            )
            if job:
                job.update(status="running", started_at=time.time())
                save(job)
        if not job:
            time.sleep(0.5)
            continue
        terminal = dict(job)
        try:
            summary = slice_job(job)
            terminal.update(
                status="succeeded",
                summary=summary,
                output_bytes=summary["gcode_bytes"],
                output_sha256=summary["sha256"],
            )
        except Exception as exc:  # noqa: BLE001 - one failed native job must not stop the queue
            print(f"job {job['id']} failed: {exc}", flush=True)
            terminal.update(
                status="failed",
                error=str(exc) if isinstance(exc, RuntimeError) else "Slicing failed",
            )
        with LOCK:
            terminal["finished_at"] = time.time()
            shutil.rmtree("/tmp/work", ignore_errors=True)
            clean_workspace(terminal)
            save(terminal)


def worker():
    try:
        worker_loop()
    except BaseException:  # noqa: BLE001 - all worker death must fail the container
        # Bookkeeping failure must restart the whole container, not leave green HTTP.
        print("Fatal job worker bookkeeping failure; restarting service", flush=True)
        os._exit(1)


WORKER = threading.Thread(target=worker, daemon=True)


class Handler(BaseHTTPRequestHandler):
    server_version = "OrcaJobAPI/1"

    def setup(self):
        super().setup()
        self.connection.settimeout(30)

    def log_message(self, fmt, *args):
        pass  # Never log auth headers, user filenames, or model contents.

    def parse_request(self):
        if not super().parse_request():
            return False
        if not self.path.startswith("/") or self.path.startswith("//"):
            self.reply(400, {"error": "Use an origin-relative request path"})
            return False
        return True

    def reply(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if status == 401:
            self.send_header("WWW-Authenticate", "Bearer")
        if status == 429:
            self.send_header("Retry-After", "30")
        self.end_headers()
        self.wfile.write(body)

    def authenticated(self):
        if not hmac.compare_digest(
            self.headers.get("Authorization", "").encode(), ("Bearer " + TOKEN).encode()
        ):
            self.reply(401, {"error": "Bearer authentication required"})
            return False
        return True

    def do_GET(self):
        path = urlsplit(self.path).path
        if path in ("/", "/healthz"):
            if not WORKER.is_alive():
                return self.reply(503, {"status": "unavailable"})
            return self.reply(
                200,
                {
                    "status": "ok",
                    "slicer": "OrcaSlicer",
                    "version": "2.5.0",
                    "openapi_url": "/openapi.json",
                    "limits": LIMITS,
                },
            )
        if path == "/openapi.json":
            return self.reply(200, json.loads((ROOT / "openapi.json").read_text()))
        if path == "/v1/presets":
            return self.reply(200, {"presets": [PRESET], "limits": LIMITS})
        if not self.authenticated():
            return
        match = re.fullmatch(r"/v1/jobs/([a-f0-9]{32})(/gcode)?", path)
        if not match:
            return self.reply(404, {"error": "Not found"})
        with LOCK:
            expire()
            job = JOBS.get(match[1])
            if not job:
                return self.reply(404, {"error": "Job not found or expired"})
            if not match[2]:
                return self.reply(200, job)
            if job["status"] != "succeeded":
                return self.reply(
                    409, {"error": "Job has not succeeded", "status": job["status"]}
                )
            # Open under lock so expiry cannot race the download.
            output = (DATA / job["id"] / "output.gcode").open("rb")
            length = os.fstat(output.fileno()).st_size
        with output:
            self.send_response(200)
            self.send_header("Content-Type", "text/x.gcode")
            self.send_header("Content-Length", str(length))
            self.send_header(
                "Content-Disposition", f'attachment; filename="{job["id"]}.gcode"'
            )
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            shutil.copyfileobj(output, self.wfile)

    def do_DELETE(self):
        if not self.authenticated():
            return
        match = re.fullmatch(r"/v1/jobs/([a-f0-9]{32})", urlsplit(self.path).path)
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
                    {
                        "error": "Only terminal jobs can be deleted",
                        "status": job["status"],
                    },
                )
            delete_job(job["id"])
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        if not self.authenticated():
            return
        if not WORKER.is_alive():
            return self.reply(503, {"error": "Job worker unavailable"})
        parsed = urlsplit(self.path)
        query = parse_qs(parsed.query, keep_blank_values=True)
        if parsed.path != "/v1/jobs":
            return self.reply(404, {"error": "Not found"})
        if query != {"preset": [PRESET["id"]]}:
            return self.reply(
                400,
                {"error": "Exactly one supported preset query parameter is required"},
            )
        if self.headers.get("Content-Type", "").split(";")[0].lower() not in (
            "model/stl",
            "application/octet-stream",
        ):
            return self.reply(
                415, {"error": "Send raw STL as model/stl or application/octet-stream"}
            )
        if self.headers.get("Transfer-Encoding"):
            return self.reply(400, {"error": "Transfer-Encoding is not supported"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return self.reply(400, {"error": "Invalid Content-Length"})
        if not 0 < length <= MAX_INPUT:
            return self.reply(413, {"error": "STL body must be 1 byte to 20 MiB"})
        with LOCK:
            expire()
            pending = sum(
                job["status"] in ("queued", "running", "uploading")
                for job in JOBS.values()
            )
            if pending >= MAX_PENDING or len(JOBS) >= MAX_RETAINED:
                return self.reply(
                    429,
                    {
                        "error": "Queue or retained job capacity reached; retry after jobs expire"
                    },
                )
            if shutil.disk_usage(DATA).free < 256 * 1024 * 1024:
                return self.reply(503, {"error": "Insufficient job storage"})
            key = uuid.uuid4().hex
            now = time.time()
            job = {
                "id": key,
                "status": "uploading",
                "preset": PRESET["id"],
                "created_at": now,
                "expires_at": now + TTL,
                "status_url": f"/v1/jobs/{key}",
                "output_url": f"/v1/jobs/{key}/gcode",
            }
            directory = DATA / key
            directory.mkdir()
            try:
                save(job)
            except BaseException:
                shutil.rmtree(directory, ignore_errors=True)
                raise
        try:
            deadline = time.monotonic() + 30
            with (directory / "input.stl").open("wb") as upload:
                remaining = length
                while remaining:
                    left = deadline - time.monotonic()
                    if left <= 0:
                        raise ValueError("Upload exceeded 30 second deadline")
                    self.connection.settimeout(left)
                    chunk = self.rfile.read1(min(65536, remaining))
                    if not chunk:
                        raise ValueError("Incomplete upload")
                    upload.write(chunk)
                    remaining -= len(chunk)
            self.connection.settimeout(30)
            dimensions = validate_stl(directory / "input.stl")
            with LOCK:
                queued = dict(job, status="queued", model_dimensions_mm=dimensions)
                save(queued)
                job = queued
        except sqlite3.Error:
            # Restart recovery terminalizes the still-uploading durable record.
            raise
        except Exception as exc:  # noqa: BLE001 - release reservations for every pre-queued failure
            with LOCK:
                shutil.rmtree(directory)
                DB.execute("DELETE FROM jobs WHERE id=?", (key,))
                DB.commit()
                JOBS.pop(key, None)
            return self.reply(
                422,
                {
                    "error": str(exc)
                    if isinstance(exc, ValueError)
                    else "Upload failed or exceeded 30 second deadline"
                },
            )
        with LOCK:
            self.reply(202, job)


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    request_queue_size = 32

    def __init__(self, *args, **kwargs):
        self.slots = threading.BoundedSemaphore(16)
        super().__init__(*args, **kwargs)

    def process_request(self, request, client_address):
        self.slots.acquire()
        try:
            super().process_request(request, client_address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()

    def handle_error(self, request, client_address):
        if isinstance(
            sys.exception(), (BrokenPipeError, ConnectionResetError, TimeoutError)
        ):
            return
        print("Fatal HTTP request bookkeeping failure; restarting service", flush=True)
        os._exit(1)


if __name__ == "__main__":
    WORKER.start()
    Path(SOCKET).unlink(missing_ok=True)
    with Server(SOCKET, Handler) as server:
        os.chmod(SOCKET, 0o666)
        print("OrcaSlicer 2.5.0 API ready on Unix socket", flush=True)
        server.serve_forever()
