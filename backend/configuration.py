"""OrcaSlicer 2.5.0 profile catalog, inheritance resolver, and configuration validator."""

from __future__ import annotations

import gzip
import hashlib
import json
import math
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent

ALLOWED_BED_TYPES = frozenset({
    "Cool Plate",
    "Engineering Plate",
    "High Temp Plate",
    "Textured PEI Plate",
    "Smooth PEI Plate",
    "Textured Cool Plate",
    "Supertack Plate",
})

ALLOWED_PLACEMENTS = frozenset({"arrange", "preserve_xy"})

MAX_CONFIG_REQUEST_BYTES = 1024 * 1024
MAX_EXPANDED_CONFIG_BYTES = 2 * 1024 * 1024
MAX_BUILD_DIMENSION_MM = 1000.0


def canonical_json(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False)


def canonical_sha256(obj: Any) -> str:
    return hashlib.sha256(canonical_json(obj).encode("utf-8")).hexdigest()


def _is_orca_value(value: Any) -> bool:
    if isinstance(value, str):
        return True
    if isinstance(value, list):
        return all(isinstance(item, str) for item in value)
    return False


def _normalize_scalar(value: str) -> str:
    stripped = value.strip()
    if stripped.endswith("%"):
        inner = stripped[:-1].strip()
        try:
            num = float(inner)
            if math.isfinite(num):
                return f"{num:g}%"
        except ValueError:
            pass
        return stripped
    try:
        num = float(stripped)
        if math.isfinite(num):
            return f"{num:g}"
    except ValueError:
        pass
    return stripped


def values_equivalent(a: Any, b: Any) -> bool:
    if a == b:
        return True
    if isinstance(a, str) and isinstance(b, str):
        return _normalize_scalar(a) == _normalize_scalar(b)
    if isinstance(a, list) and isinstance(b, list) and len(a) == len(b):
        return all(values_equivalent(x, y) for x, y in zip(a, b))
    if isinstance(a, str) and isinstance(b, list) and len(b) == 1:
        return values_equivalent(a, b[0])
    if isinstance(b, str) and isinstance(a, list) and len(a) == 1:
        return values_equivalent(a[0], b)
    return False


def parse_polygon_list(raw_area: Any) -> list[list[float]]:
    polygon: list[list[float]] = []
    if isinstance(raw_area, list):
        for point in raw_area:
            if isinstance(point, str) and "x" in point:
                parts = point.split("x", 1)
                try:
                    x, y = float(parts[0]), float(parts[1])
                    if math.isfinite(x) and math.isfinite(y):
                        polygon.append([round(x, 3), round(y, 3)])
                except ValueError:
                    pass
    return polygon


def parse_build_volume(printer_settings: dict[str, Any]) -> tuple[list[float], list[list[float]]]:
    """Extract [width, depth, height] in mm and bed polygon from printable_area & printable_height."""
    polygon = parse_polygon_list(printer_settings.get("printable_area"))
    if len(polygon) >= 3:
        xs = [p[0] for p in polygon]
        ys = [p[1] for p in polygon]
        width = max(xs) - min(xs)
        depth = max(ys) - min(ys)
    else:
        width, depth = 256.0, 256.0
        polygon = [[0.0, 0.0], [width, 0.0], [width, depth], [0.0, depth]]

    raw_height = printer_settings.get("printable_height", "256")
    try:
        height = float(raw_height[0] if isinstance(raw_height, list) else raw_height)
        if not math.isfinite(height) or height <= 0:
            height = 256.0
    except (ValueError, TypeError, IndexError):
        height = 256.0

    width = min(max(width, 10.0), MAX_BUILD_DIMENSION_MM)
    depth = min(max(depth, 10.0), MAX_BUILD_DIMENSION_MM)
    height = min(max(height, 10.0), MAX_BUILD_DIMENSION_MM)
    return [round(width, 3), round(depth, 3), round(height, 3)], polygon


class ProfileCatalog:
    def __init__(self, root: Path = ROOT):
        self.root = root
        self.assets_dir = root / "assets"
        gz_path = root / "catalog.json.gz"
        defaults_path = root / "native_defaults.json"
        if gz_path.is_file():
            with gzip.open(gz_path, "rb") as fh:
                raw = json.loads(fh.read().decode("utf-8"))
        else:
            raw = {"provenance": {}, "vendors": {}, "machine_models": {}, "profiles": {}}

        self.provenance: dict[str, Any] = raw.get("provenance", {})
        self.vendors: dict[str, dict[str, Any]] = raw.get("vendors", {})
        self.machine_models: dict[str, dict[str, Any]] = raw.get("machine_models", {})
        self.profiles: dict[str, dict[str, Any]] = raw.get("profiles", {})

        # Secondary index by (kind, name) for cross-vendor inheritance fallback
        self._by_kind_name: dict[tuple[str, str], list[dict[str, Any]]] = {}
        self._list_by_kind: dict[str, list[dict[str, Any]]] = {
            "machine": [],
            "process": [],
            "filament": [],
        }
        for entry in self.profiles.values():
            kind = entry["kind"]
            self._by_kind_name.setdefault((kind, entry["name"]), []).append(entry)
            if kind in self._list_by_kind:
                self._list_by_kind[kind].append(entry)

        if defaults_path.is_file():
            self.settings_doc: dict[str, Any] = json.loads(defaults_path.read_text(encoding="utf-8"))
        else:
            self.settings_doc = {"provenance": self.provenance, "settings": {}, "limitations": []}

        self.settings_meta: dict[str, dict[str, Any]] = self.settings_doc.get("settings", {})
        self.restricted_keys = frozenset(
            k for k, v in self.settings_meta.items() if v.get("classification") == "restricted"
        )
        self.metadata_keys = frozenset(
            k for k, v in self.settings_meta.items() if v.get("classification") == "metadata_not_toolpath"
        )
        self.native_defaults = {
            k: v["native_default"]
            for k, v in self.settings_meta.items()
            if v.get("classification") == "native_exportable" and v.get("native_default") is not None
        }
        self._flatten_cache: dict[tuple[str, str, str], dict[str, Any]] = {}
        self._compatible_cache: dict[tuple[str, str], dict[str, Any]] = {}

    def list_vendors(self) -> list[dict[str, Any]]:
        return sorted(self.vendors.values(), key=lambda v: v["id"].lower())

    def search_profiles(
        self,
        *,
        kind: str | None = None,
        vendor: str | None = None,
        q: str | None = None,
        instantiable_only: bool = False,
        offset: int = 0,
        limit: int = 50,
    ) -> dict[str, Any]:
        if kind is not None and kind not in ("machine", "process", "filament"):
            raise ValueError("kind must be machine, process, or filament")
        if offset < 0:
            raise ValueError("offset must be >= 0")
        if not 1 <= limit <= 100:
            raise ValueError("limit must be between 1 and 100")

        source = (
            self._list_by_kind[kind]
            if kind
            else [e for k in ("machine", "process", "filament") for e in self._list_by_kind[k]]
        )
        q_tokens = [tok.lower() for tok in (q or "").split() if tok]
        vendor_norm = vendor.strip() if vendor else None

        matched = []
        for entry in source:
            if vendor_norm and entry["vendor"].lower() != vendor_norm.lower():
                continue
            if instantiable_only and not entry.get("instantiation", False):
                continue
            if q_tokens:
                hay = f"{entry['vendor']} {entry['name']}".lower()
                if not all(tok in hay for tok in q_tokens):
                    continue
            matched.append(entry)

        total = len(matched)
        page = matched[offset : offset + limit]
        return {
            "profiles": [
                {
                    "vendor": e["vendor"],
                    "kind": e["kind"],
                    "name": e["name"],
                    "path": e["path"],
                    "instantiation": e.get("instantiation", False),
                }
                for e in page
            ],
            "total": total,
            "offset": offset,
            "limit": limit,
            "provenance": self.provenance,
        }

    def _find_entry(self, vendor: str, kind: str, name: str) -> dict[str, Any] | None:
        direct = self.profiles.get(f"{vendor}/{kind}/{name}")
        if direct:
            return direct
        # Fallback: OrcaFilamentLibrary (shared across vendors for filaments)
        if kind == "filament":
            shared = self.profiles.get(f"OrcaFilamentLibrary/filament/{name}")
            if shared:
                return shared
        candidates = self._by_kind_name.get((kind, name))
        if candidates:
            return candidates[0]
        return None

    def flatten_profile(self, vendor: str, kind: str, name: str, _seen: set[tuple[str, str, str]] | None = None) -> dict[str, Any]:
        cache_key = (vendor, kind, name)
        if cache_key in self._flatten_cache:
            return dict(self._flatten_cache[cache_key])

        seen = set() if _seen is None else set(_seen)
        if cache_key in seen:
            raise ValueError(f"Circular inheritance detected at {vendor}/{kind}/{name}")
        seen.add(cache_key)

        entry = self._find_entry(vendor, kind, name)
        if not entry:
            raise KeyError(f"Profile not found: {vendor}/{kind}/{name}")

        data = entry["data"]
        merged: dict[str, Any] = {}
        parent_vendor = entry["vendor"]

        inherits = data.get("inherits")
        if inherits:
            if isinstance(inherits, str):
                merged.update(self.flatten_profile(parent_vendor, kind, inherits, seen))
            elif isinstance(inherits, list):
                for parent_name in inherits:
                    if isinstance(parent_name, str) and parent_name:
                        merged.update(self.flatten_profile(parent_vendor, kind, parent_name, seen))

        includes = data.get("include")
        if isinstance(includes, list):
            for inc in includes:
                if isinstance(inc, str) and inc:
                    merged.update(self.flatten_profile(parent_vendor, kind, inc, seen))

        merged.update(data)
        merged.pop("inherits", None)
        merged.pop("include", None)
        # Ensure required Orca metadata fields exist for CLI --load-settings / --load-filaments
        merged.setdefault("type", kind)
        merged.setdefault("name", entry["name"])
        merged.setdefault("from", data.get("from", "system"))
        merged["instantiation"] = "true"

        # Strip any restricted keys that might exist in upstream profile definitions
        for rk in list(merged.keys()):
            if rk in self.restricted_keys:
                merged.pop(rk, None)

        self._flatten_cache[cache_key] = merged
        return dict(merged)

    def _asset_url(self, vendor: str, filename: str) -> str | None:
        if not filename:
            return None
        safe_name = Path(filename).name
        if not safe_name or safe_name != filename:
            return None
        candidate = self.assets_dir / vendor / safe_name
        if candidate.is_file():
            return f"/v2/assets/{vendor}/{safe_name}"
        return None

    def get_machine_model_info(
        self, vendor: str, printer_model: str | None, flattened_machine: dict[str, Any]
    ) -> dict[str, Any]:
        model_name = printer_model or str(flattened_machine.get("printer_model") or "")
        raw_model = self.machine_models.get(f"{vendor}/{model_name}", {})
        bed_model = str(raw_model.get("bed_model") or "")
        bed_texture = str(raw_model.get("bed_texture") or "")
        hotend_model = str(raw_model.get("hotend_model") or "")
        if not hotend_model and vendor == "BBL":
            hotend_model = "bbl-3dp-hotend.stl"

        nozzles = [n.strip() for n in str(raw_model.get("nozzle_diameter") or "").split(";") if n.strip()]
        default_materials = [m.strip() for m in str(raw_model.get("default_materials") or "").split(";") if m.strip()]
        not_supported = [b.strip() for b in str(raw_model.get("not_support_bed_type") or "").split(";") if b.strip()]

        return {
            "name": model_name,
            "vendor": vendor,
            "family": str(raw_model.get("family") or ""),
            "model_id": str(raw_model.get("model_id") or ""),
            "bed_model": bed_model or None,
            "bed_texture": bed_texture or None,
            "hotend_model": hotend_model or None,
            "bed_model_url": self._asset_url(vendor, bed_model),
            "bed_texture_url": self._asset_url(vendor, bed_texture),
            "hotend_model_url": self._asset_url(vendor, hotend_model),
            "default_bed_type": str(raw_model.get("default_bed_type") or "Textured PEI Plate"),
            "not_support_bed_types": not_supported,
            "nozzle_diameters": nozzles,
            "default_materials": default_materials,
        }

    def get_profile_detail(self, vendor: str, kind: str, name: str) -> dict[str, Any]:
        entry = self._find_entry(vendor, kind, name)
        if not entry:
            raise KeyError(f"Profile not found: {vendor}/{kind}/{name}")
        flattened = self.flatten_profile(entry["vendor"], kind, entry["name"])
        info: dict[str, Any] = {
            "vendor": entry["vendor"],
            "kind": kind,
            "name": entry["name"],
            "path": entry["path"],
            "instantiation": entry.get("instantiation", False),
            "settings": flattened,
        }
        if kind == "machine":
            bv, poly = parse_build_volume(flattened)
            info["build_volume_mm"] = bv
            info["printable_area_polygon"] = poly
            info["bed_exclude_area_polygon"] = parse_polygon_list(flattened.get("bed_exclude_area"))
            info["machine_model"] = self.get_machine_model_info(
                entry["vendor"], flattened.get("printer_model"), flattened
            )
        return info

    def get_compatible_profiles(self, vendor: str, machine_name: str) -> dict[str, Any]:
        entry = self._find_entry(vendor, "machine", machine_name)
        if not entry:
            raise KeyError(f"Machine profile not found: {vendor}/{machine_name}")
        real_vendor = entry["vendor"]
        real_name = entry["name"]
        cache_key = (real_vendor, real_name)
        if cache_key in self._compatible_cache:
            return self._compatible_cache[cache_key]

        flattened = self.flatten_profile(real_vendor, "machine", real_name)
        bv, poly = parse_build_volume(flattened)
        exclude_poly = parse_polygon_list(flattened.get("bed_exclude_area"))
        printer_model = str(flattened.get("printer_model") or "")
        printer_variant = str(flattened.get("printer_variant") or "")
        machine_model = self.get_machine_model_info(real_vendor, printer_model, flattened)
        recommended_materials = set(machine_model.get("default_materials", []))

        raw_default_print = flattened.get("default_print_profile")
        default_print = (
            raw_default_print[0] if isinstance(raw_default_print, list) and raw_default_print
            else (raw_default_print if isinstance(raw_default_print, str) else "")
        )
        raw_default_fil = flattened.get("default_filament_profile")
        default_filament = (
            raw_default_fil[0] if isinstance(raw_default_fil, list) and raw_default_fil
            else (raw_default_fil if isinstance(raw_default_fil, str) else "")
        )

        # Find all nozzle variants belonging to the same printer_model
        nozzle_variants: list[dict[str, Any]] = []
        if printer_model:
            for m in self._list_by_kind["machine"]:
                if m["vendor"] != real_vendor or not m.get("instantiation"):
                    continue
                try:
                    mf = self.flatten_profile(m["vendor"], "machine", m["name"])
                except KeyError:
                    continue
                if str(mf.get("printer_model") or "") == printer_model:
                    nd_raw = mf.get("nozzle_diameter", ["0.4"])
                    nd = str(nd_raw[0] if isinstance(nd_raw, list) and nd_raw else nd_raw)
                    nozzle_variants.append({
                        "vendor": m["vendor"],
                        "name": m["name"],
                        "nozzle_diameter": nd,
                    })
            nozzle_variants.sort(key=lambda x: (float(x["nozzle_diameter"]) if x["nozzle_diameter"].replace(".", "", 1).isdigit() else 99.0, x["name"]))

        # Compatible processes (same vendor)
        processes: list[dict[str, Any]] = []
        for p in self._list_by_kind["process"]:
            if p["vendor"] != real_vendor or not p.get("instantiation"):
                continue
            try:
                pf = self.flatten_profile(p["vendor"], "process", p["name"])
            except KeyError:
                continue
            cp = pf.get("compatible_printers")
            if isinstance(cp, list) and cp:
                if real_name not in cp:
                    continue
            else:
                # Some vendors leave compatible_printers empty; match only if printer_model appears or no explicit filter exists
                if cp is not None:
                    continue
            lh_raw = pf.get("layer_height", "0.2")
            try:
                lh = float(lh_raw[0] if isinstance(lh_raw, list) else lh_raw)
            except (ValueError, TypeError):
                lh = 0.2
            processes.append({
                "vendor": p["vendor"],
                "name": p["name"],
                "layer_height": lh,
                "is_default": p["name"] == default_print,
            })
        processes.sort(key=lambda x: (x["layer_height"], x["name"]))

        # Compatible filaments (same vendor + OrcaFilamentLibrary)
        filaments: list[dict[str, Any]] = []
        for fl in self._list_by_kind["filament"]:
            if fl["vendor"] not in (real_vendor, "OrcaFilamentLibrary") or not fl.get("instantiation"):
                continue
            try:
                ff = self.flatten_profile(fl["vendor"], "filament", fl["name"])
            except KeyError:
                continue
            cp = ff.get("compatible_printers")
            if isinstance(cp, list) and cp:
                if real_name not in cp:
                    continue
            elif fl["vendor"] != real_vendor:
                continue
            elif cp is not None:
                continue

            def _first_str(val: Any, fallback: str = "") -> str:
                if isinstance(val, list) and val:
                    return str(val[0])
                return str(val) if val is not None else fallback

            filaments.append({
                "vendor": fl["vendor"],
                "name": fl["name"],
                "filament_type": _first_str(ff.get("filament_type"), "PLA"),
                "filament_vendor": _first_str(ff.get("filament_vendor"), fl["vendor"]),
                "nozzle_temp": _first_str(ff.get("nozzle_temperature"), "220"),
                "bed_temp": _first_str(
                    ff.get("textured_plate_temp") or ff.get("hot_plate_temp") or ff.get("cool_plate_temp"),
                    "55",
                ),
                "is_default": fl["name"] == default_filament,
                "is_recommended": fl["name"] in recommended_materials or fl["name"] == default_filament,
            })
        filaments.sort(key=lambda x: (0 if x["is_default"] else (1 if x["is_recommended"] else 2), x["filament_type"], x["name"]))

        result = {
            "vendor": real_vendor,
            "machine": real_name,
            "printer_model": printer_model,
            "printer_variant": printer_variant,
            "build_volume_mm": bv,
            "printable_area_polygon": poly,
            "bed_exclude_area_polygon": exclude_poly,
            "machine_model": machine_model,
            "nozzle_variants": nozzle_variants,
            "default_print_profile": default_print,
            "default_filament_profile": default_filament,
            "settings": flattened,
            "processes": processes,
            "filaments": filaments,
            "provenance": self.provenance,
        }
        self._compatible_cache[cache_key] = result
        return result

    def _validate_section(
        self,
        section_name: str,
        kind: str,
        spec: Any,
        issues: list[dict[str, Any]],
    ) -> tuple[dict[str, Any], list[str]]:
        if not isinstance(spec, dict):
            issues.append({"section": section_name, "code": "invalid_section", "message": f"{section_name} must be an object"})
            return {}, []

        has_profile = "profile" in spec
        has_settings = "settings" in spec
        if has_profile == has_settings:
            issues.append({
                "section": section_name,
                "code": "mutually_exclusive_source",
                "message": f"{section_name} must provide either 'profile' or 'settings', not both",
            })
            return {}, []

        allowed_keys = {"profile", "overrides"} if has_profile else {"settings"}
        extra = set(spec.keys()) - allowed_keys
        if extra:
            issues.append({
                "section": section_name,
                "code": "unknown_section_keys",
                "message": f"Unexpected keys in {section_name}: {sorted(extra)}",
            })
            return {}, []

        explicit_fields: list[str] = []

        if has_profile:
            prof = spec["profile"]
            if not isinstance(prof, dict) or not isinstance(prof.get("vendor"), str) or not isinstance(prof.get("name"), str):
                issues.append({
                    "section": section_name,
                    "code": "invalid_profile_ref",
                    "message": f"{section_name}.profile requires string 'vendor' and 'name'",
                })
                return {}, []
            try:
                resolved = self.flatten_profile(prof["vendor"], kind, prof["name"])
            except (KeyError, ValueError) as exc:
                issues.append({"section": section_name, "code": "profile_not_found", "message": str(exc)})
                return {}, []

            overrides = spec.get("overrides") or {}
            if not isinstance(overrides, dict):
                issues.append({"section": section_name, "code": "invalid_overrides", "message": "overrides must be an object"})
                return {}, []

            for key, val in overrides.items():
                if not isinstance(key, str):
                    issues.append({"section": section_name, "code": "invalid_key", "message": "Override keys must be strings"})
                    continue
                if key in ("inherits", "include"):
                    issues.append({"section": section_name, "field": key, "code": "disallowed_inheritance", "message": f"Cannot override '{key}'"})
                    continue
                if key in self.restricted_keys:
                    issues.append({"section": section_name, "field": key, "code": "restricted_field", "message": f"Setting '{key}' is restricted"})
                    continue
                if self.settings_meta and key not in self.settings_meta:
                    issues.append({"section": section_name, "field": key, "code": "unknown_field", "message": f"Unknown Orca setting '{key}'"})
                    continue
                meta = self.settings_meta.get(key)
                if meta and meta.get("classification") == "official_not_native_exportable":
                    issues.append({
                        "section": section_name,
                        "field": key,
                        "code": "not_native_exportable",
                        "message": f"Setting '{key}' is not supported by native OrcaSlicer CLI",
                    })
                    continue
                if not _is_orca_value(val):
                    issues.append({
                        "section": section_name,
                        "field": key,
                        "code": "invalid_value_type",
                        "message": f"Setting '{key}' must be a string or list of strings",
                    })
                    continue
                resolved[key] = val
                explicit_fields.append(key)
            return resolved, explicit_fields

        # Full settings mode
        raw_settings = spec["settings"]
        if not isinstance(raw_settings, dict) or not raw_settings:
            issues.append({"section": section_name, "code": "invalid_settings", "message": "settings must be a non-empty object"})
            return {}, []

        resolved = {}
        for key, val in raw_settings.items():
            if not isinstance(key, str):
                issues.append({"section": section_name, "code": "invalid_key", "message": "Setting keys must be strings"})
                continue
            if key in ("inherits", "include"):
                issues.append({"section": section_name, "field": key, "code": "unresolved_inheritance", "message": f"settings cannot contain '{key}'"})
                continue
            if key in self.restricted_keys:
                issues.append({"section": section_name, "field": key, "code": "restricted_field", "message": f"Setting '{key}' is restricted"})
                continue
            if self.settings_meta and key not in self.settings_meta:
                issues.append({"section": section_name, "field": key, "code": "unknown_field", "message": f"Unknown Orca setting '{key}'"})
                continue
            if not _is_orca_value(val):
                issues.append({
                    "section": section_name,
                    "field": key,
                    "code": "invalid_value_type",
                    "message": f"Setting '{key}' must be a string or list of strings",
                })
                continue
            resolved[key] = val
            explicit_fields.append(key)

        resolved.setdefault("type", kind)
        resolved.setdefault("name", f"Custom {kind}")
        resolved.setdefault("from", "user")
        resolved["instantiation"] = "true"
        return resolved, explicit_fields

    def resolve_configuration(self, payload: Any) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
        issues: list[dict[str, Any]] = []
        if not isinstance(payload, dict):
            return None, [{"code": "invalid_payload", "message": "Configuration body must be a JSON object"}]

        allowed_top = {"printer", "process", "filament", "filaments", "bed_type", "placement"}
        unknown_top = set(payload.keys()) - allowed_top
        if unknown_top:
            issues.append({"code": "unknown_top_keys", "message": f"Unexpected top-level keys: {sorted(unknown_top)}"})

        for req in ("printer", "process", "bed_type"):
            if req not in payload:
                issues.append({"field": req, "code": "missing_required", "message": f"Missing required field '{req}'"})
        if "filament" not in payload and "filaments" not in payload:
            issues.append({"field": "filament", "code": "missing_required", "message": "Provide 'filament' or 'filaments'"})

        bed_type = payload.get("bed_type")
        if not isinstance(bed_type, str) or bed_type not in ALLOWED_BED_TYPES:
            issues.append({
                "field": "bed_type",
                "code": "invalid_bed_type",
                "message": f"bed_type must be one of: {sorted(ALLOWED_BED_TYPES)}",
            })

        placement = payload.get("placement", "arrange")
        if not isinstance(placement, str) or placement not in ALLOWED_PLACEMENTS:
            issues.append({
                "field": "placement",
                "code": "invalid_placement",
                "message": f"placement must be one of: {sorted(ALLOWED_PLACEMENTS)}",
            })

        printer_res, printer_explicit = (
            self._validate_section("printer", "machine", payload.get("printer"), issues)
            if "printer" in payload
            else ({}, [])
        )
        process_res, process_explicit = (
            self._validate_section("process", "process", payload.get("process"), issues)
            if "process" in payload
            else ({}, [])
        )

        # Support single `filament` (v2) and multi-filament `filaments` (up to 16 slots)
        filament_res: dict[str, Any] = {}
        filament_explicit: list[str] = []
        filaments_list: list[dict[str, Any]] = []
        filaments_explicit: list[list[str]] = []

        if "filaments" in payload:
            raw_flist = payload["filaments"]
            if not isinstance(raw_flist, list) or not (1 <= len(raw_flist) <= 16):
                issues.append({"field": "filaments", "code": "invalid_filaments", "message": "filaments must be a list of 1 to 16 filament specs"})
            else:
                for idx, fspec in enumerate(raw_flist):
                    fres, fexp = self._validate_section(f"filaments[{idx}]", "filament", fspec, issues)
                    filaments_list.append(fres)
                    filaments_explicit.append(fexp)
                if filaments_list:
                    filament_res = filaments_list[0]
                    filament_explicit = filaments_explicit[0]
        elif "filament" in payload:
            filament_res, filament_explicit = self._validate_section("filament", "filament", payload["filament"], issues)
            if filament_res:
                filaments_list = [filament_res]
                filaments_explicit = [filament_explicit]

        if issues:
            return None, issues

        build_volume_mm, bed_polygon = parse_build_volume(printer_res)

        resolved_bundle: dict[str, Any] = {
            "printer": printer_res,
            "process": process_res,
            "filament": filament_res,
            "filaments": filaments_list,
            "bed_type": bed_type,
        }
        expanded_bytes = len(canonical_json(resolved_bundle).encode("utf-8"))
        if expanded_bytes > MAX_EXPANDED_CONFIG_BYTES:
            return None, [{
                "code": "expanded_too_large",
                "message": f"Resolved configuration ({expanded_bytes} bytes) exceeds 2 MiB limit",
            }]

        config_id = canonical_sha256(payload)
        resolved_sha256 = canonical_sha256(resolved_bundle)

        result = {
            "id": config_id,
            "requested": payload,
            "resolved": resolved_bundle,
            "resolved_sha256": resolved_sha256,
            "explicit_fields": {
                "printer": sorted(set(printer_explicit)),
                "process": sorted(set(process_explicit)),
                "filament": sorted(set(filament_explicit)),
                "filaments": [sorted(set(x)) for x in filaments_explicit],
            },
            "placement": placement,
            "build_volume_mm": build_volume_mm,
            "printable_area_polygon": bed_polygon,
            "validation": {
                "valid": True,
                "stage": "static",
                "issues": [],
            },
            "defaults_policy": "pinned_native_defaults",
            "provenance": self.provenance,
            "limitations": self.settings_doc.get("limitations", []),
        }
        return result, []

    def compare_effective_settings(
        self,
        resolved_bundle: dict[str, Any],
        explicit_fields: dict[str, Any],
        exported: dict[str, Any],
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        """Build field_evidence comparing resolved/explicit settings against Orca's exported settings."""
        fields_report: dict[str, Any] = {}
        explicit_mismatches: list[dict[str, Any]] = []

        for section in ("printer", "process", "filament"):
            section_resolved = resolved_bundle.get(section) or {}
            section_explicit = set(explicit_fields.get(section) or [])
            for key, expected in section_resolved.items():
                is_explicit = key in section_explicit
                meta = self.settings_meta.get(key, {})
                classification = meta.get("classification", "unknown")

                if classification == "metadata_not_toolpath" or key in self.metadata_keys:
                    status = "metadata_not_toolpath"
                    actual = exported.get(key)
                elif key not in exported:
                    status = "not_exported"
                    actual = None
                else:
                    actual = exported[key]
                    if values_equivalent(expected, actual):
                        status = "loaded_value_matches"
                    else:
                        status = "native_value_changed"

                fields_report[f"{section}.{key}"] = {
                    "section": section,
                    "key": key,
                    "explicit": is_explicit,
                    "expected": expected,
                    "exported": actual,
                    "status": status,
                }
                if is_explicit and status in ("not_exported", "native_value_changed"):
                    explicit_mismatches.append({
                        "section": section,
                        "key": key,
                        "expected": expected,
                        "exported": actual,
                        "status": status,
                    })

        return {"fields": fields_report, "explicit_mismatch_count": len(explicit_mismatches)}, explicit_mismatches
