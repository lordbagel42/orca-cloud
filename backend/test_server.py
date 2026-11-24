"""End-to-end tests for backend/server.py against native OrcaSlicer 2.5.0."""

from __future__ import annotations

import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.parse
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

BACKEND_DIR = Path(__file__).resolve().parent


def make_cube_stl(cx: float, cy: float, size: float = 20.0) -> bytes:
    h = size / 2.0
    v = [
        (cx - h, cy - h, 0.0), (cx + h, cy - h, 0.0), (cx + h, cy + h, 0.0), (cx - h, cy + h, 0.0),
        (cx - h, cy - h, size), (cx + h, cy - h, size), (cx + h, cy + h, size), (cx - h, cy + h, size),
    ]
    tris = [
        (0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7),
        (0, 1, 5), (0, 5, 4), (2, 3, 7), (2, 7, 6),
        (1, 2, 6), (1, 6, 5), (3, 0, 4), (3, 4, 7),
    ]
    buf = bytearray(b"\x00" * 80 + struct.pack("<I", len(tris)))
    for a, b, c in tris:
        buf += struct.pack("<3f", 0.0, 0.0, 0.0)
        for idx in (a, b, c):
            buf += struct.pack("<3f", *v[idx])
        buf += struct.pack("<H", 0)
    return bytes(buf)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def http_json(url: str, method: str = "GET", body: bytes | None = None, content_type: str | None = None):
    headers = {}
    if content_type:
        headers["Content-Type"] = content_type
    if body is not None:
        headers["Content-Length"] = str(len(body))
    req = Request(url, data=body, method=method, headers=headers)
    try:
        with urlopen(req, timeout=60) as resp:
            raw = resp.read()
            ctype = resp.headers.get("Content-Type", "")
            return resp.status, json.loads(raw) if "json" in ctype else raw
    except HTTPError as err:
        raw = err.read()
        try:
            return err.code, json.loads(raw)
        except Exception:
            return err.code, raw


class BackendServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="orca-srv-test-"))
        cls.port = free_port()
        cls.base = f"http://127.0.0.1:{cls.port}"
        env = {
            **os.environ,
            "DATA_DIR": str(cls.tmp / "data"),
            "HTTP_BIND": f"127.0.0.1:{cls.port}",
            "AUTH_MODE": "none",
        }
        cls.proc = subprocess.Popen(
            [sys.executable, str(BACKEND_DIR / "server.py")],
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            try:
                status, data = http_json(f"{cls.base}/healthz")
                if status == 200 and data.get("status") == "ok":
                    return
            except Exception:
                time.sleep(0.2)
        raise RuntimeError("Server did not become healthy")

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        try:
            cls.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            cls.proc.kill()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_health_and_catalog(self):
        status, health = http_json(f"{self.base}/healthz")
        self.assertEqual(status, 200)
        self.assertEqual(health["api_version"], "2.1.0")
        self.assertFalse(health["auth_required"])
        self.assertGreater(health["capabilities"]["profiles_count"], 14000)

        status, vendors = http_json(f"{self.base}/v2/profiles/vendors")
        self.assertEqual(status, 200)
        self.assertGreaterEqual(len(vendors["vendors"]), 50)

        status, res = http_json(f"{self.base}/v2/profiles?kind=machine&vendor=BBL&q=A1+mini&instantiable=true")
        self.assertEqual(status, 200)
        names = [p["name"] for p in res["profiles"]]
        self.assertIn("Bambu Lab A1 mini 0.4 nozzle", names)

        status, detail = http_json(
            f"{self.base}/v2/profiles/detail?vendor=BBL&kind=machine&name=Bambu+Lab+A1+mini+0.4+nozzle"
        )
        self.assertEqual(status, 200)
        self.assertEqual(detail["build_volume_mm"], [180.0, 180.0, 180.0])

    def test_configuration_validation_and_rejection(self):
        bad = {
            "printer": {"profile": {"vendor": "BBL", "name": "Bambu Lab A1 mini 0.4 nozzle"}, "overrides": {"post_process": ["echo bad"]}},
            "process": {"profile": {"vendor": "BBL", "name": "0.20mm Standard @BBL A1M"}},
            "filament": {"profile": {"vendor": "BBL", "name": "Generic PLA @BBL A1M"}},
            "bed_type": "Textured PEI Plate",
        }
        status, err = http_json(f"{self.base}/v2/profiles/resolve", "POST", json.dumps(bad).encode(), "application/json")
        self.assertEqual(status, 422)
        self.assertTrue(any(i["code"] == "restricted_field" for i in err["issues"]))

    def test_v2_slice_preserve_xy_and_mesh_utilities(self):
        cfg = {
            "printer": {"profile": {"vendor": "BBL", "name": "Bambu Lab A1 mini 0.4 nozzle"}},
            "process": {
                "profile": {"vendor": "BBL", "name": "0.20mm Standard @BBL A1M"},
                "overrides": {"sparse_infill_density": "20%", "wall_loops": "3"},
            },
            "filaments": [
                {"profile": {"vendor": "BBL", "name": "Generic PLA @BBL A1M"}},
                {"profile": {"vendor": "BBL", "name": "Generic PLA @BBL A1M"}, "overrides": {"filament_colour": ["#FF5500"]}},
            ],
            "bed_type": "Textured PEI Plate",
            "placement": "preserve_xy",
        }
        status, created = http_json(f"{self.base}/v2/configurations", "POST", json.dumps(cfg).encode(), "application/json")
        self.assertEqual(status, 201)
        cfg_id = created["id"]
        self.assertEqual(len(cfg_id), 64)

        stl = make_cube_stl(cx=90.0, cy=90.0, size=16.0)
        status, job = http_json(f"{self.base}/v2/jobs?configuration={cfg_id}", "POST", stl, "model/stl")
        self.assertEqual(status, 202)
        job_id = job["id"]

        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            status, job = http_json(f"{self.base}/v1/jobs/{job_id}")
            self.assertEqual(status, 200)
            if job["status"] in ("succeeded", "failed"):
                break
            time.sleep(0.25)

        self.assertEqual(job["status"], "succeeded", msg=job.get("error"))
        self.assertGreater(job["output_bytes"], 1000)
        self.assertEqual(job["summary"]["plate_count"], 1)
        self.assertIn("statistics", job["summary"])
        self.assertIn("features", job["summary"]["statistics"])
        self.assertEqual(job["feedback"]["field_evidence"]["explicit_mismatch_count"], 0)

        status, gcode_bytes = http_json(f"{self.base}/v1/jobs/{job_id}/gcode")
        self.assertEqual(status, 200)
        self.assertEqual(len(gcode_bytes), job["output_bytes"])

        status, threemf_bytes = http_json(f"{self.base}/v1/jobs/{job_id}/3mf")
        self.assertEqual(status, 200)
        self.assertTrue(threemf_bytes[:2] == b"PK")

        # Mesh inspect & repair
        status, inspect_data = http_json(f"{self.base}/v2/mesh/inspect", "POST", stl, "model/stl")
        self.assertEqual(status, 200)
        self.assertIsInstance(inspect_data, dict)

        status, repaired = http_json(f"{self.base}/v2/mesh/repair", "POST", stl, "model/stl")
        self.assertEqual(status, 200)
        self.assertGreater(len(repaired), 84)

        status, oriented = http_json(f"{self.base}/v2/mesh/auto-orient", "POST", stl, "model/stl")
        self.assertEqual(status, 200)
        self.assertGreater(len(oriented), 84)

    def test_a1_mini_and_p1s_compatible_profiles_and_assets(self):
        # Bambu Lab A1 mini 0.4 nozzle
        q_a1m = urllib.parse.urlencode({"vendor": "BBL", "machine": "Bambu Lab A1 mini 0.4 nozzle"})
        status, a1m = http_json(f"{self.base}/v2/profiles/compatible?{q_a1m}")
        self.assertEqual(status, 200)
        self.assertEqual(a1m["build_volume_mm"], [180.0, 180.0, 180.0])
        self.assertEqual(a1m["machine_model"]["bed_model"], "bbl-3dp-A1M.stl")
        self.assertEqual(a1m["machine_model"]["bed_model_url"], "/v2/assets/BBL/bbl-3dp-A1M.stl")
        self.assertEqual(a1m["machine_model"]["bed_texture_url"], "/v2/assets/BBL/bbl-3dp-logo.svg")
        self.assertEqual(a1m["machine_model"]["hotend_model_url"], "/v2/assets/BBL/bbl-3dp-hotend.stl")
        self.assertEqual(a1m["default_print_profile"], "0.20mm Standard @BBL A1M")
        self.assertGreaterEqual(len(a1m["processes"]), 10)
        self.assertGreaterEqual(len(a1m["filaments"]), 150)
        self.assertEqual([v["nozzle_diameter"] for v in a1m["nozzle_variants"]], ["0.2", "0.4", "0.6", "0.8"])

        # Bambu Lab P1S 0.4 nozzle
        q_p1s = urllib.parse.urlencode({"vendor": "BBL", "machine": "Bambu Lab P1S 0.4 nozzle"})
        status, p1s = http_json(f"{self.base}/v2/profiles/compatible?{q_p1s}")
        self.assertEqual(status, 200)
        self.assertEqual(p1s["build_volume_mm"], [256.0, 256.0, 250.0])
        self.assertEqual(p1s["machine_model"]["bed_model"], "bbl-3dp-X1.stl")
        self.assertEqual(p1s["machine_model"]["bed_model_url"], "/v2/assets/BBL/bbl-3dp-X1.stl")
        self.assertEqual(p1s["bed_exclude_area_polygon"], [[0.0, 0.0], [18.0, 0.0], [18.0, 28.0], [0.0, 28.0]])
        self.assertEqual(p1s["default_print_profile"], "0.20mm Standard @BBL X1C")
        self.assertGreaterEqual(len(p1s["processes"]), 10)
        self.assertGreaterEqual(len(p1s["filaments"]), 200)
        self.assertEqual([v["nozzle_diameter"] for v in p1s["nozzle_variants"]], ["0.2", "0.4", "0.6", "0.8"])

        # Fetch official STL & SVG assets
        for url in [
            "/v2/assets/BBL/bbl-3dp-A1M.stl",
            "/v2/assets/BBL/bbl-3dp-X1.stl",
            "/v2/assets/BBL/bbl-3dp-hotend.stl",
            "/v2/assets/BBL/bbl-3dp-logo.svg",
        ]:
            status, body = http_json(f"{self.base}{url}")
            self.assertEqual(status, 200)
            self.assertGreater(len(body), 1000)

        # Reject path traversal
        status, _ = http_json(f"{self.base}/v2/assets/BBL/..%2Fserver.py")
        self.assertEqual(status, 404)

    def test_staged_meshes_dedup_and_zero_upload_slice(self):
        stl = make_cube_stl(0.0, 0.0, 20.0)
        # Stage mesh once
        status, staged1 = http_json(f"{self.base}/v2/meshes", "POST", stl, "model/stl")
        self.assertEqual(status, 201, msg=staged1)
        self.assertFalse(staged1["deduplicated"])
        mesh_id = staged1["mesh_id"]
        self.assertEqual(len(mesh_id), 64)
        self.assertEqual(staged1["dimensions_mm"], [20.0, 20.0, 20.0])

        # Second upload deduplicates
        status, staged2 = http_json(f"{self.base}/v2/meshes", "POST", stl, "model/stl")
        self.assertEqual(status, 201)
        self.assertTrue(staged2["deduplicated"])
        self.assertEqual(staged2["mesh_id"], mesh_id)

        # Create configuration
        cfg_req = {
            "printer": {"profile": {"vendor": "BBL", "name": "Bambu Lab A1 mini 0.4 nozzle"}},
            "process": {"profile": {"vendor": "BBL", "name": "0.20mm Standard @BBL A1M"}},
            "filament": {"profile": {"vendor": "BBL", "name": "Generic PLA @BBL A1M"}},
            "bed_type": "Textured PEI Plate",
            "placement": "preserve_xy",
        }
        status, cfg = http_json(
            f"{self.base}/v2/configurations",
            "POST",
            json.dumps(cfg_req).encode(),
            "application/json",
        )
        self.assertEqual(status, 201, msg=cfg)
        cfg_id = cfg["id"]

        # Unknown mesh returns 404 with missing_mesh_id
        missing_id = "0" * 64
        status, err = http_json(
            f"{self.base}/v2/jobs?configuration={cfg_id}",
            "POST",
            json.dumps({"objects": [{"mesh_id": missing_id, "position": [90, 90, 0]}]}).encode(),
            "application/json",
        )
        self.assertEqual(status, 404)
        self.assertEqual(err.get("missing_mesh_id"), missing_id)

        # Zero-upload single-object JSON slice (fast STL transform path)
        status, job = http_json(
            f"{self.base}/v2/jobs?configuration={cfg_id}",
            "POST",
            json.dumps(
                {
                    "objects": [
                        {
                            "mesh_id": mesh_id,
                            "name": "cube",
                            "position": [90.0, 90.0, 0.0],
                            "rotation": [0.0, 0.0, 45.0],
                            "scale": [1.0, 1.0, 1.0],
                            "filament_index": 0,
                        }
                    ]
                }
            ).encode(),
            "application/json",
        )
        self.assertEqual(status, 202, msg=job)
        job_id = job["id"]
        for _ in range(240):
            status, job = http_json(f"{self.base}/v1/jobs/{job_id}")
            if job["status"] in ("succeeded", "failed"):
                break
            time.sleep(0.25)
        self.assertEqual(job["status"], "succeeded", msg=job.get("error"))
        self.assertGreater(job["output_bytes"], 1000)

        # Zero-upload multi-object JSON slice (3MF assembly path)
        status, job2 = http_json(
            f"{self.base}/v2/jobs?configuration={cfg_id}",
            "POST",
            json.dumps(
                {
                    "objects": [
                        {"mesh_id": mesh_id, "name": "cube_a", "position": [65.0, 90.0, 0.0], "rotation": [0, 0, 0], "scale": [1, 1, 1], "filament_index": 0},
                        {"mesh_id": mesh_id, "name": "cube_b", "position": [115.0, 90.0, 0.0], "rotation": [0, 0, 0], "scale": [0.8, 0.8, 1], "filament_index": 0},
                    ]
                }
            ).encode(),
            "application/json",
        )
        self.assertEqual(status, 202, msg=job2)
        job2_id = job2["id"]
        for _ in range(240):
            status, job2 = http_json(f"{self.base}/v1/jobs/{job2_id}")
            if job2["status"] in ("succeeded", "failed"):
                break
            time.sleep(0.25)
        self.assertEqual(job2["status"], "succeeded", msg=job2.get("error"))
        self.assertGreater(job2["output_bytes"], 1000)


if __name__ == "__main__":
    unittest.main()
