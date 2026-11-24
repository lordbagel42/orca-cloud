"""Build offline OrcaSlicer 2.5.0 profile catalog and native settings metadata.

Uses only the Python standard library. Produces:
- backend/catalog.json.gz: all official vendor manifests and profiles pinned to
  OrcaSlicer v2.5.0 commit 40ecc66f78ed72dc368e0c1ebe40d77f00cc8a19.
- backend/native_defaults.json: native defaults exported by /opt/orca/AppRun
  alongside key classifications (native_exportable, official_not_native_exportable,
  metadata_not_toolpath, restricted).
"""

import argparse
import gzip
import json
import pathlib
import shutil
import subprocess
import tempfile

ORCA_VERSION = "2.5.0"
PROFILES_COMMIT = "40ecc66f78ed72dc368e0c1ebe40d77f00cc8a19"
BINARY_SHA256 = "d13eb0a9cd618ed080ab6b82c64c0a60c4501aac91e88d5ac2c3b526fb141a7c"
SOURCE_URL = f"https://github.com/OrcaSlicer/OrcaSlicer/tree/{PROFILES_COMMIT}"

RESTRICTED_KEYS = frozenset({
    "bbl_use_printhost",
    "bed_custom_model",
    "bed_custom_texture",
    "filename_format",
    "host_type",
    "output_filename_format",
    "post_process",
    "print_host",
    "print_host_webui",
    "printer_model_path",
    "printhost_apikey",
    "printhost_authorization_type",
    "printhost_cafile",
    "printhost_password",
    "printhost_port",
    "printhost_ssl_ignore_revoke",
    "printhost_user",
})

METADATA_KEYS = frozenset({
    "compatible_printers",
    "compatible_printers_condition",
    "compatible_prints",
    "compatible_prints_condition",
    "description",
    "filament_id",
    "filament_settings_id",
    "from",
    "instantiation",
    "name",
    "print_settings_id",
    "printer_settings_id",
    "setting_id",
    "type",
    "version",
})


def clone_profiles(target_dir: pathlib.Path) -> pathlib.Path:
    subprocess.run(["git", "init", "-q"], cwd=target_dir, check=True)
    subprocess.run(
        ["git", "remote", "add", "origin", "https://github.com/OrcaSlicer/OrcaSlicer.git"],
        cwd=target_dir,
        check=True,
    )
    subprocess.run(["git", "config", "core.sparseCheckout", "true"], cwd=target_dir, check=True)
    (target_dir / ".git" / "info" / "sparse-checkout").write_text("resources/profiles/\n", encoding="utf-8")
    subprocess.run(
        ["git", "fetch", "--depth=1", "-q", "origin", PROFILES_COMMIT],
        cwd=target_dir,
        check=True,
    )
    subprocess.run(["git", "checkout", "-q", "FETCH_HEAD"], cwd=target_dir, check=True)
    return target_dir / "resources" / "profiles"


def export_native_defaults(orca_bin: str) -> dict:
    with tempfile.TemporaryDirectory(prefix="orca-export-") as td:
        out = pathlib.Path(td) / "native.json"
        home = pathlib.Path(td) / "home"
        home.mkdir()
        env = {"PATH": "/usr/bin:/bin", "HOME": str(home), "LC_ALL": "C"}
        proc = subprocess.run(
            [orca_bin, "--export-settings", str(out)],
            cwd=td,
            env=env,
            capture_output=True,
            text=True,
            timeout=60,
        )
        if proc.returncode != 0 or not out.is_file():
            raise RuntimeError(f"Failed to export native settings ({proc.returncode}): {proc.stderr[:400]}")
        return json.loads(out.read_text(encoding="utf-8"))


def build_catalog(profiles_root: pathlib.Path, out_dir: pathlib.Path, orca_bin: str):
    vendors = {}
    profiles = {}
    official_keys: set[str] = set()

    for manifest_file in sorted(profiles_root.glob("*.json")):
        vendor_id = manifest_file.stem
        vendor_dir = profiles_root / vendor_id
        if not vendor_dir.is_dir():
            continue
        try:
            manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue

        vendor_counts = {"machine": 0, "process": 0, "filament": 0}
        for kind in ("machine", "process", "filament"):
            for entry in manifest.get(f"{kind}_list", []):
                name = entry.get("name")
                sub_path = entry.get("sub_path")
                if not name or not sub_path:
                    continue
                profile_file = vendor_dir / sub_path
                if not profile_file.is_file():
                    continue
                try:
                    data = json.loads(profile_file.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    continue
                official_keys.update(data.keys())
                inst = str(data.get("instantiation", "")).lower() == "true"
                key = f"{vendor_id}/{kind}/{name}"
                profiles[key] = {
                    "vendor": vendor_id,
                    "kind": kind,
                    "name": name,
                    "path": f"{vendor_id}/{sub_path}",
                    "instantiation": inst,
                    "data": data,
                }
                vendor_counts[kind] += 1

        if sum(vendor_counts.values()) > 0:
            vendors[vendor_id] = {
                "id": vendor_id,
                "name": manifest.get("name", vendor_id),
                "version": manifest.get("version", ""),
                "counts": vendor_counts,
            }

    provenance = {
        "slicer": "OrcaSlicer",
        "version": ORCA_VERSION,
        "binary_sha256": BINARY_SHA256,
        "profiles_commit": PROFILES_COMMIT,
        "source_url": SOURCE_URL,
    }

    catalog = {
        "provenance": provenance,
        "vendors": vendors,
        "profiles": profiles,
    }
    raw = json.dumps(catalog, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    gz_path = out_dir / "catalog.json.gz"
    with gzip.open(gz_path, "wb", compresslevel=9) as fh:
        fh.write(raw)

    native_defaults = export_native_defaults(orca_bin)
    all_keys = sorted(official_keys | set(native_defaults.keys()) | RESTRICTED_KEYS | METADATA_KEYS)
    settings_map = {}
    for key in all_keys:
        if key in RESTRICTED_KEYS:
            classification = "restricted"
            default_val = None
        elif key in METADATA_KEYS:
            classification = "metadata_not_toolpath"
            default_val = native_defaults.get(key)
        elif key in native_defaults:
            classification = "native_exportable"
            default_val = native_defaults[key]
        else:
            classification = "official_not_native_exportable"
            default_val = None
        settings_map[key] = {
            "classification": classification,
            "native_default": default_val,
        }

    settings_doc = {
        "provenance": provenance,
        "value_format": "Orca JSON string or array of strings (e.g. '0.20', '15%', ['220'])",
        "limitations": [
            "Exported settings prove values loaded by Orca, not activation of conditional settings, physical nozzle/material identity or print safety.",
            "Official profiles can contain legacy/unsupported fields and native normalization; each is reported, not assumed applied.",
            "Custom G-code is output text only; no post-processing, filesystem routing or network/printer connectivity.",
            "Geometry is bounded by the resolved printer area/height and a 1000 mm service safety ceiling; native validation checks actual bed fit.",
            "Unspecified fields use pinned native defaults, never an implicit A1 preset; exported defaults and all effective values are reported.",
        ],
        "settings": settings_map,
    }
    defaults_path = out_dir / "native_defaults.json"
    defaults_path.write_text(json.dumps(settings_doc, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")

    print(
        f"Built catalog: {len(vendors)} vendors, {len(profiles)} profiles "
        f"({gz_path.stat().st_size / 1024:.1f} KiB gzipped), "
        f"{len(settings_map)} settings ({len(native_defaults)} native defaults)"
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--profiles-dir", type=pathlib.Path, default=None)
    parser.add_argument("--orca-bin", default="/opt/orca/AppRun")
    parser.add_argument("--out-dir", type=pathlib.Path, default=pathlib.Path(__file__).resolve().parent)
    args = parser.parse_args()

    temp_dir = None
    try:
        if args.profiles_dir:
            profiles_root = args.profiles_dir
        else:
            temp_dir = pathlib.Path(tempfile.mkdtemp(prefix="orca-profiles-"))
            profiles_root = clone_profiles(temp_dir)
        build_catalog(profiles_root, args.out_dir, args.orca_bin)
    finally:
        if temp_dir and temp_dir.exists():
            shutil.rmtree(temp_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
