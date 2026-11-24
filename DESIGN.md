# Orca Cloud — Design System

## Mode & Visual Direction
- **Mode:** Operate (precision 3D CAD & slicing instrument). The interface recedes so the 3D build plate, model geometry, and G-code toolpaths dominate.
- **Theme:** Graphite dark mode anchored to precision desktop slicers (OrcaSlicer / Bambu Studio / modern Geist aesthetic). Crisp 1px tonal boundaries, flat layered neutral surfaces, zero decorative drop-shadows or marketing cards.

## Color Tokens
- `--bg-stage`: `#0e1013` (3D WebGL viewport canvas backdrop)
- `--bg-frame`: `#131519` (top navigation bar, status bar, outer frame)
- `--bg-panel`: `#181a1f` (left process sidebar, right object/plate inspector, preview legend)
- `--bg-surface`: `#20232a` (inputs, dropdown triggers, inactive segmented pills, toolbar pills)
- `--bg-hover`: `#282c35` (control hover fill)
- `--bg-active`: `#303540` (active toggle fill, selected tree row)
- `--border-subtle`: `#262a33` (internal section dividers, table rows)
- `--border-default`: `#323742` (panel boundaries, inputs, toolbars)
- `--border-strong`: `#454c5c` (focused/hovered borders)
- `--text-primary`: `#eceff4` (≥13:1 on `--bg-panel`)
- `--text-secondary`: `#a1a8b8` (≥6.8:1 on `--bg-panel`)
- `--text-muted`: `#747c8e` (≥4.5:1 on `--bg-panel` for auxiliary units/shortcuts)
- `--accent`: `#22c55e` (Orca emerald — primary Slice button, active tab indicator, selected gizmo highlight)
- `--accent-hover`: `#16a34a`
- `--accent-fg`: `#041f0e` (high-contrast dark ink on `--accent`, ≥8.5:1)
- `--accent-tint`: `rgba(34, 197, 94, 0.14)` (subtle active/selected tint)
- `--accent-text`: `#4ade80` (≥8.5:1 on `--bg-panel`)
- `--warning`: `#f59e0b` (modified setting indicator, overhang caution, non-fatal warnings)
- `--danger`: `#ef4444` (out-of-bounds warning, collision, support blocker, destructive actions)
- `--info`: `#38bdf8` (selected object highlight, seam/lay-on-face hover, info badges)

## Typography
- **UI Family:** `'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif` (self-hosted via `@fontsource-variable/geist`)
- **Numeric / Code Family:** `'Geist Mono', ui-monospace, SFMono-Regular, monospace` (`font-variant-numeric: tabular-nums` on all numeric fields, coordinates, times, filament stats, layer counters)
- **Fixed Scale:**
  - `11px` (`0.6875rem`): micro units (`mm`, `°`, `%`, `g`), keyboard shortcut keycaps, compact table cells
  - `12px` (`0.75rem`): form labels, toolbar tooltips, tab buttons, tree items
  - `13px` (`0.8125rem`): standard body text, inputs, dropdown values
  - `14px` (`0.875rem`): panel section titles, modal subtitles (weight 600)
  - `16px` (`1rem`): dialog titles, empty-state headers (weight 600, tracking `-0.02em`)

## Layout & Spacing
- **Header:** `46px` fixed height (`--bg-frame`, `1px solid --border-subtle` bottom border).
- **Left Sidebar:** `320px` default (collapsible, resizable `280px`–`420px`) containing Printer, Filaments, and Global/Objects Process settings.
- **Center 3D Viewport:** Flexible (`1fr`), edge-to-edge WebGL canvas with floating top Prepare toolbar (`36px` height), bottom-left ViewCube/camera controls, bottom plate switcher strip, and top-right context/stats HUD.
- **Right Floating / Docked Inspector:** Contextual tool panel (Transform / Cut / Paint / Variable Layer Height / Measure / Object Tree) or Preview Legend & Layer Slider.
- **Control Dimensions:** `28px` compact sidebar inputs/buttons, `32px` primary toolbar buttons, `34px` primary Slice CTA; `6px` control radius, `8px` floating toolbar radius, `10px` modal radius.
- **Focus & Motion:** `2px solid var(--accent)` focus-visible rings with `1px` offset; `120ms` ease-out state transitions disabled under `prefers-reduced-motion`.
