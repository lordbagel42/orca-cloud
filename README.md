# Orca Cloud — Native OrcaSlicer Web UI & HTTP API

Full-parity browser workspace (**Prepare**, **Preview**, and **Calibration** — no Device tab, no accounts) backed by the unmodified official **OrcaSlicer v2.5.0** engine behind a bounded Python HTTP API.

- Web UI (`web/`): React 19, TypeScript, Vite, Three.js, self-hosted Geist & Geist Mono, Cloudflare Worker reverse proxy (`web/worker/index.ts`), IndexedDB local autosave.
- Native Engine API (`backend/`): Python 3 standard-library-only service (`backend/server.py`, `backend/configuration.py`, `backend/catalog.json.gz`) bundling all **72 vendors & 14,275 official OrcaSlicer 2.5.0 profiles**, STL & 3MF multi-object/multi-filament slicing, native mesh repair/auto-orient/inspect, and optional no-account mode (`AUTH_MODE=none`).
- Live API: https://orca.bagelindustries.com (`/healthz`, `/openapi.json`, `/v1/presets`, `/v2/profiles`, `/v2/settings`).

## Run locally (Web UI + Native Backend)

Start the native backend (no accounts or API key needed in local mode):

```sh
DATA_DIR=/tmp/orca-data AUTH_MODE=none HTTP_BIND=127.0.0.1:8080 python3 backend/server.py
```

Start the browser workspace:

```sh
pnpm --dir web install
pnpm web:dev
```

Or serve the production bundle directly from the backend (`STATIC_DIR=web/dist`):

```sh
pnpm web:build
STATIC_DIR=web/dist DATA_DIR=/tmp/orca-data AUTH_MODE=none HTTP_BIND=0.0.0.0:8080 python3 backend/server.py
```

The engine is the unmodified official [OrcaSlicer v2.5.0 release](https://github.com/OrcaSlicer/OrcaSlicer/releases/tag/v2.5.0). Its [source](https://github.com/OrcaSlicer/OrcaSlicer/tree/v2.5.0) and [AGPL-3.0 license](https://github.com/OrcaSlicer/OrcaSlicer/blob/v2.5.0/LICENSE.txt) remain upstream; this wrapper does not claim ownership of OrcaSlicer or its printer profiles.

## Slice a model

Use Node.js 22 or newer. No package installation is required. Save the service's API key in a private file, then run:

```sh
ORCA_API_TOKEN_FILE=/path/to/orca-api.token \
  node client/slice.mjs model.stl output.gcode
```

The client uploads the model, prints job state changes to stderr, waits for completion, and downloads the G-code. Its last stdout line is JSON with the job, output size, and SHA-256. It checks the completed artifact's size and digest before atomically publishing the output file, never overwrites an existing file, and does not retry job creation after an ambiguous network failure. Errors after acceptance retain the job ID and status URL. Its 30-minute total deadline includes queue time; cancelling the client does not cancel a server job.

Without configuration arguments, the client uses the legacy `bambu-a1-mini-0.4-pla` preset: **Bambu Lab A1 mini, 0.4 mm nozzle, Generic PLA**. STL coordinates are millimeters. For another nozzle, printer, material or process, use the configurable path below rather than relabeling the fixed preset's output.

An explicit preset is the third argument. `ORCA_API_URL` overrides the HTTPS origin:

```sh
ORCA_API_TOKEN_FILE=/path/to/orca-api.token \
  node client/slice.mjs model.stl output.gcode bambu-a1-mini-0.4-pla
```

## Configurable slicing for agents

Discover official profiles with `GET /v2/profiles?kind=machine&vendor=BBL&q=0.6&limit=50`. Kinds are `machine`, `process`, and `filament`; paginate with `offset` and `limit` (1–100). The catalog includes inherited base profiles and templates, not only directly usable printer presets. `GET /v2/settings` classifies native-exportable, official-but-unexported, metadata, and restricted settings.

The request has four keys: `printer`, `process`, `filament`, and `bed_type`. Each profile section is either `{ "profile": { "vendor": "BBL", "name": "…" }, "overrides": { … } }` or `{ "settings": { … } }`, not both. Overrides win over flattened official inheritance. Values use Orca's JSON representation: strings and arrays of strings, including numbers such as `"0.30"` and percentages such as `"20%"`. Native defaults supply unspecified fields in the settings form; they are disclosed, not silently borrowed from the A1 mini preset. Unknown, restricted and explicitly nonexportable fields are rejected.

The [0.6 mm A1 mini example](examples/a1-mini-0.6-pla.json) selects the matching printer **and process**, Generic PLA, 0.30 mm layers and 20% infill. Changing only the nozzle number is not a substitute for compatible profiles.

```sh
ORCA_API_TOKEN_FILE=/path/to/orca-api.token \
  node client/slice.mjs model.stl output.gcode \
  --configuration examples/a1-mini-0.6-pla.json
```

The client first creates an immutable configuration, then uploads raw STL against its handle. To reuse a handle, pass `--configuration-id <64-hex-id>`. Configuration files are at most 1 MiB; models remain raw uploads up to 20 MiB. Creation, upload and native failures retain structured JSON details in stderr; a failed native job includes its complete feedback and does not produce a local G-code file.

The native HTTP workflow is:

1. `POST /v2/profiles/resolve` with the configuration JSON to inspect flattened values, provenance and static validation without retaining anything.
2. `POST /v2/configurations` with the same JSON. HTTP 201 returns an immutable `id` and expiry. This proves **static validation only**, not native acceptance.
3. `POST /v2/jobs?configuration=<id>` with the raw STL body. HTTP 202 returns a job ID. The job snapshots its configuration at admission; deleting or expiring the handle cannot change it.
4. Poll `GET /v1/jobs/{id}` and inspect feedback. Status/output/delete paths are shared with v1.
5. Download `GET /v1/jobs/{id}/gcode` only after success. Delete terminal jobs and unused handles when finished. `GET` and `DELETE /v2/configurations/{id}` inspect/remove handles; up to 64 handles are retained for 24 hours.

All resolution, configuration and job operations require the same bearer key. Profile/settings discovery is public. Neither API accepts caller shell arguments, postprocessors, output paths or printer commands. Models are single-object STL and slicing is single-extruder FFF; this is broad native configuration, not every GUI feature, AMS or multi-material support.

## Read the evidence, not just `succeeded`

A configured job retains `configuration.requested`, `resolved`, `explicit_fields`, `validation`, `defaults_policy`, `build_volume_mm` and versioned `provenance`. Native feedback includes effective exported settings and hashes, native results/statistics, bounded logs with a truncation flag, and G-code inspection. Missing statistics are unknown, not zero.

`feedback.field_evidence.fields` reports each resolved field as `loaded_value_matches`, `native_value_changed`, `not_exported`, or `metadata_not_toolpath`, with exported values when available and whether the caller explicitly supplied it. Numerically equivalent formatting is normalized for comparison. Inherited official defaults can be normalized or unsupported by the pinned engine; those discrepancies remain visible rather than being declared applied. An explicit override or settings value that does not round-trip fails the job and blocks output download.

Matching an export establishes that Orca loaded a value, **not that it affected toolpaths**. `activation` identifies recognized inactive gates (for example support speed while support is disabled); otherwise activation is `not_assessed`. G-code comments, extrusion-command counts and native statistics provide additional evidence, but do not measure installed hardware. `physical_safety` remains `not_assessed`. Agents must not turn any of these claims into a blanket assurance that a physical print is safe.

## HTTP contract

Health, OpenAPI, preset, profile and setting discovery are public. All job requests require `Authorization: Bearer <key>`. Treat the key as full access to this single-owner service, including its retained models/results. Never put it in URLs or commit it to source control.

Create a job with a **raw STL body**, not JSON or multipart form data:

```sh
curl --fail-with-body \
  -H "Authorization: Bearer $(cat /path/to/orca-api.token)" \
  -H 'Content-Type: model/stl' \
  --data-binary @model.stl \
  'https://orca.bagelindustries.com/v1/jobs?preset=bambu-a1-mini-0.4-pla'
```

A successful upload returns HTTP 202 with `id`, `status`, `status_url`, and `output_url`. Poll `GET /v1/jobs/{id}` until the status is `succeeded` or `failed`. Then download `GET /v1/jobs/{id}/gcode` with the same bearer header. Download before success returns HTTP 409. Keep the returned job ID if a later request fails; repeat reads, not the original upload.

Limits: 20 MiB per upload, 64 MiB per output, one running job, four waiting jobs, five minutes per slicing process, and 24-hour result retention. At most sixteen jobs are retained; queue or retained-job saturation returns HTTP 429 rather than unbounded background work. Download results before expiry, then use authenticated `DELETE /v1/jobs/{id}` to remove terminal jobs and free capacity. These are single-host jobs, not a highly available distributed queue.

The homelab is nearly fully reserved in Nomad. This service uses low-priority CPU shares without reducing existing reservations; complex models may reach the runtime limit under contention. The existing Cloudflare edge rejects Python urllib's default user agent; use a descriptive application user agent such as `OrcaJobClient/1.0`. The included Node client and Executor tools work through that edge unchanged.

## Executor and other agents

The **Orca Slicer** Executor app is installed as `orca-slicer`, with the existing managed Infisical account linked. It resolves only the dedicated slicing key server-side from project `923d970a-8e38-48f5-8c38-e7197c1ce36c`, environment `prod`, path `/orca-slicer`, secret `ORCA_API_KEY`. The key is never a tool argument, result, or source-code literal. The linked machine identity retains its existing secret-store permissions; the app code fixes the one secret it reads.

Configurable tools are `profiles`, `settings`, `resolveConfiguration`, `createConfiguration`, `getConfiguration`, `deleteConfiguration`, and `createConfiguredJob`. They return `{ok,http_status,data}`, preserving structured backend validation errors such as HTTP 422. `resolveConfiguration` and `createConfiguration` take `{configuration: <the native configuration object>}`; use `data.id` as `configurationId` for `createConfiguredJob`.

Existing `health`, `presets`, `createJob`, `getJob`, `getGcode`, and `deleteJob` remain compatible and return their original unwrapped shapes. `getJob` also exposes the full configured-job feedback. In Executor code mode, this is the legacy fixed-preset path:

```js
return await tools["orca-slicer"].createJob({
  sourceUrl:
    "https://raw.githubusercontent.com/OrcaSlicer/OrcaSlicer/40ecc66f78ed72dc368e0c1ebe40d77f00cc8a19/tests/data/test_stl/ASCII/20mmbox-LF.stl",
  preset: "bambu-a1-mini-0.4-pla",
});
```

This example slices Orca's pinned upstream 20 mm test cube. Replace its URL with your model. Supply exactly one of a public HTTPS `sourceUrl` (20 MiB maximum; redirects are rejected) or standard `stlBase64` (4 MiB decoded maximum). Poll `getJob({jobId})` in subsequent calls. `getGcode({jobId})` returns text for results up to 1 MiB; larger outputs use the native HTTP download with the dedicated service key. The complete native OpenAPI document is also available for other HTTP clients.

Native Orca cannot run inside an Executor app: Executor app code runs in workerd and cannot spawn native processes. The native engine stays on the homelab; Executor is its authenticated client. No browser UI or full Orca GUI feature parity is included in this API-first release.

## Verified live

On November 10, 2026, the public Node client sliced a 23 × 17 × 9 mm STL into 211,840 bytes of G-code: 45 layers, 1.87 g PLA, 0.827 seconds of native slicing. Its downloaded SHA-256 matched completed-job metadata, and the G-code identified OrcaSlicer 2.5.0, the A1 mini, a 0.4 mm nozzle, and PLA. Executor independently sliced an 11 × 7 × 3 mm model through its managed Infisical account and returned 105,881 bytes, 15 layers, and 0.29 g PLA.

Both retained jobs remained readable after the final native deployment was replaced; Executor deletion removed its test job, and a subsequent status request returned 404. A fresh post-redeployment Node slice also succeeded. Public checks covered authentication, invalid STL, unsupported presets/media types, and the actual oversized-upload rejection. No physical printer or print was tested.

The URL-based Executor example above also passed after redeployment: 364,709 bytes, 100 layers, and 3.65 g PLA. Its native download matched the completed byte count and SHA-256. Verification jobs were deleted after their outputs were checked.

## Local checks

```sh
node --check client/slice.mjs
node --test client/*.test.mjs
```

The client tests exercise its HTTP contract with fake responses. They do not prove the native slicer or the deployed host works; that needs a real STL upload and inspection of downloaded G-code.
