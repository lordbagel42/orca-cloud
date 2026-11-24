"""Flatten the three trusted v2.5.0 presets from pinned upstream JSON sources."""

import functools
import json
from pathlib import Path
from urllib.parse import quote
from urllib.request import urlopen

COMMIT = "40ecc66f78ed72dc368e0c1ebe40d77f00cc8a19"
BASE = f"https://raw.githubusercontent.com/OrcaSlicer/OrcaSlicer/{COMMIT}/resources/profiles/"


@functools.cache
def read(path):
    with urlopen(BASE + quote(path, safe="/"), timeout=30) as response:
        return json.load(response)


manifest = {}
for vendor in ("OrcaFilamentLibrary", "BBL"):
    data = read(vendor + ".json")
    for kind in ("machine", "process", "filament"):
        for entry in data.get(kind + "_list", []):
            manifest[(kind, entry["name"])] = vendor + "/" + entry["sub_path"]


@functools.cache
def flatten(kind, name):
    data = read(manifest[(kind, name)])
    result = {}
    if data.get("inherits"):
        result.update(flatten(kind, data["inherits"]))
    for include in data.get("include", []):
        result.update(flatten(kind, include))
    result.update(data)
    result.pop("inherits", None)
    result.pop("include", None)
    return result


for filename, kind, name in (
    ("printer", "machine", "Bambu Lab A1 mini 0.4 nozzle"),
    ("process", "process", "0.20mm Standard @BBL A1M"),
    ("filament", "filament", "Generic PLA @BBL A1M"),
):
    result = flatten(kind, name)
    (Path(__file__).parent / "presets" / (filename + ".json")).write_text(
        json.dumps(result, indent=2) + "\n"
    )
    print(f"Generated {filename}: {name} ({len(result)} keys)")
