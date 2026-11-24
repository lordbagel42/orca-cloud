<!-- impeccable:product-schema 1 -->
# Orca Cloud — Product Context

## Platform & Purpose
- **Platform:** Web (desktop-primary interactive 3D CAD/slicer application with responsive tablet/narrow support).
- **Purpose:** A modern browser-based recreation of OrcaSlicer desktop (Prepare, Preview, and Calibration workspaces) backed by the unmodified native **OrcaSlicer 2.5.0** engine.
- **Explicit Exclusions:**
  - **No Device tab** — never discovers, connects to, monitors, or operates physical printers.
  - **No accounts or login walls** — works immediately in the browser with local IndexedDB project persistence and optional self-hosted/proxied backend connectivity.

## Audience & Usage Scene
- **Primary users:** 3D printing enthusiasts, engineers, and makers preparing single- or multi-plate FDM/FFF models in the browser, plus AI agents sharing the native v1/v2 HTTP slicing API.
- **Usage scene:** High-density precision CAD/slicing workspace used for extended sessions in dim or studio lighting. Users expect instant visual feedback, accurate millimeter measurements, keyboard shortcuts, and desktop-grade control density without web marketing fluff.

## Core Capabilities
1. **Prepare Workspace:** Multi-plate 3D build plate matching the selected printer's real build volume and bed type; STL/OBJ/3MF import and export; built-in primitives; 3D Move/Rotate/Scale gizmos and numeric transforms; Lay-on-Face; interactive Z-Plane Cut; Support Painting (enforce/block); Seam Painting (enforce/block); Multi-Filament Color Painting; Variable Layer Height; Modifier/Negative/Support Enforcer & Blocker sub-parts; Split to Objects; Clone; Mirror; Measure; Native Mesh Repair & Auto-Orient; Auto-Arrange; 50-step Undo/Redo.
2. **Full OrcaSlicer Settings Parity:** Offline catalog of 72 vendors and 14,275 official OrcaSlicer 2.5.0 profiles (Printer, Process, Filament); multi-filament slot management + purge/flush matrix; Global vs Per-Object process overrides; all 6 OrcaSlicer setting tabs (Quality, Strength, Speed, Support, Multimaterial, Others) with search, Basic/Advanced toggle, modified-setting indicators, per-field reset, and full native key JSON override access.
3. **Preview Workspace:** Real parsed G-code 3D toolpath visualization with color schemes (Line Type, Filament, Speed, Flow, Layer Height, Line Width, Fan Speed, Temperature), dual-handle vertical layer slider, horizontal move/step scrubber with animated nozzle head, visibility toggles (travel, retractions, seams, ghost model), interactive feature breakdown with print time and filament usage (g / m / cm³ / cost), G-code line inspector, and native slicing diagnostics.
4. **Calibration Workspace:** OrcaSlicer's built-in calibration test generators (Temperature Tower, Flow Rate Pass 1 & 2, Pressure Advance, Retraction Test, Tolerance Test, Max Volumetric Speed, VFA Speed Tower) that generate real printable meshes with matched process overrides directly onto the build plate.

## Technical Stack
- **Backend:** Python 3 standard-library-only HTTP service wrapping native OrcaSlicer 2.5.0 (`backend/server.py`, `backend/configuration.py`, `backend/catalog.json.gz`), supporting v1 legacy presets, v2 configurable profiles/handles, 3MF multi-object/multi-filament slicing, native mesh repair/inspect/auto-orient, and optional zero-account local mode.
- **Frontend:** React 19, TypeScript, Vite, Three.js, Radix UI, Lucide icons, self-hosted Geist & Geist Mono (`web/`), plus Cloudflare Worker reverse proxy (`web/worker/index.ts`).
