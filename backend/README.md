# Native OrcaSlicer job API

Public URL: https://orca.bagelindustries.com. Import https://orca.bagelindustries.com/openapi.json for the complete OpenAPI 3.0 contract.

The API slices models; it never discovers, connects to, uploads to, or operates a printer. It accepts one raw binary or ASCII STL in millimeters with a fixed trusted preset: **Bambu Lab A1 mini / 0.4 mm nozzle / Generic PLA / 0.20mm Standard / Textured PEI Plate**. Model dimensions must be positive and at most 180 × 180 × 180 mm. Arrangement translates objects onto the plate; it does not scale or auto-orient them. Review supports, orientation, material, plate and printer compatibility before printing generated G-code.

## HTTP contract

- Public `GET /healthz`, `GET /openapi.json`, `GET /v1/presets`.
- Authenticated `POST /v1/jobs?preset=bambu-a1-mini-0.4-pla`, raw STL body, `Content-Type: model/stl` or `application/octet-stream`, explicit Content-Length. Returns 202 with `id`, `status`, `status_url`, `output_url`, timestamps and dimensions.
- Authenticated `GET /v1/jobs/{id}`: `queued`, `running`, `succeeded` or `failed`. On success includes `output_bytes`, `output_sha256` and a slice summary. Errors do not contain native logs.
- Authenticated `GET /v1/jobs/{id}/gcode`: complete `text/x.gcode` attachment with Content-Length; 409 until succeeded, 404 after expiry.
- Authenticated `DELETE /v1/jobs/{id}`: 204 for terminal succeeded/failed jobs; removes record/output and releases the slot. Active jobs return 409; this is not cancellation.

Use `Authorization: Bearer <ORCA_API_KEY>` on every job route. The key is newly generated, unrelated to printer credentials, and stored in Infisical project `923d970a-8e38-48f5-8c38-e7197c1ce36c`, environment `prod`, path `/orca-slicer`, secret `ORCA_API_KEY`. Runtime mounts only this key, never Infisical bootstrap credentials. Do not commit keys, jobs, logs, models or output. Key rotation requires updating the private runtime key file and restarting only this Nomad job.

## Bounds and recovery

- Input 20 MiB; output and each native file 64 MiB.
- One running job, four queued/uploading jobs; 300 second wall timeout and CPU-time limit; kills the complete process group on timeout and exit.
- Sixteen retained jobs, expires 24 hours after creation. Admission returns 429 rather than silently evicting unexpired jobs.
- Native scratch and per-job HOME live only on a 256 MiB tmpfs. Successful output is copied into a temporary retained file and atomically renamed before publishing success. Input, scratch and intermediate 3MF are removed on terminalization.
- Retained STL/G-code is bounded by sixteen 64 MiB slots, plus at most one 64 MiB publication copy; native scratch cannot spill into host disk. SQLite stores only these sixteen small records. Gateway temp storage is a separate 32 MiB tmpfs, request buffering disabled.
- Queued jobs resume after restart. Running/partial uploads become failed. Completed downloads remain available until expiry. A host disk loss is not backed up by this service.
- HTTP request timeout 30s, sixteen request handlers; container PID/memory limits apply to native parsing as well as slicing.

## Runtime and deployment

Python 3 standard library only; no pip/npm dependencies. The Ubuntu 24.04 image installs GTK3, WebKitGTK 4.1, OpenGL, libmspack and libsecret shared libraries required by the official AppImage, plus Xvfb tooling for diagnostics. No GUI or browser-port slicer is used.

Upstream native version: **OrcaSlicer 2.5.0**, official Ubuntu2404 x86_64 AppImage, SHA-256 `d13eb0a9cd618ed080ab6b82c64c0a60c4501aac91e88d5ac2c3b526fb141a7c`.

- Release: https://github.com/OrcaSlicer/OrcaSlicer/releases/tag/v2.5.0
- Corresponding source: https://github.com/OrcaSlicer/OrcaSlicer/tree/v2.5.0
- License (AGPL-3.0): https://github.com/OrcaSlicer/OrcaSlicer/blob/v2.5.0/LICENSE.txt
- Binary: https://github.com/OrcaSlicer/OrcaSlicer/releases/download/v2.5.0/OrcaSlicer_Linux_AppImage_Ubuntu2404_V2.5.0.AppImage

`Dockerfile` verifies the official digest before extraction; no FUSE or privileged container is needed. The complete presets in `presets/` are generated from upstream v2.5.0 commit `40ecc66f78ed72dc368e0c1ebe40d77f00cc8a19`, including inherited settings and G-code templates; `python3 generate_presets.py` reproduces them using only the standard library and pinned raw GitHub URLs. Flat presets avoid the CLI requiring a separately installed GUI preset bundle. `server.py` invokes only a fixed argv with a clean environment and no shell; client flags, custom profiles and arbitrary G-code are not accepted.

Hosting: existing Homelab Nomad Docker node `192.168.0.230`, dedicated `orca-job-api` job. The **native container has network_mode=none**, non-root UID 10001, read-only root filesystem, no Linux capabilities, no-new-privileges, 128 PIDs and 2 GiB RAM. It has no Docker socket, printer credentials or access to host services. Nginx runs as a non-root, read-only sidecar and forwards HTTP to `/alloc/orca.sock`. Only the sidecar has a network interface. Native processes share the API's container trust boundary; this is not a hostile multi-tenant compute platform.

Consul registers the new route with existing Traefik; existing Cloudflare wildcard/tunnel supplies public HTTPS. No changes to existing services, tunnel rules, DNS or Nomad daemon are required.

Install source into `/opt/orca-job-api/source` on that node. Prepare `/opt/orca-job-api/data` owned by 10001:10001 mode 0700. Retrieve the Infisical key into `/etc/orca-job-api/api-key`, owned by 10001:10001 mode 0400, parent directory mode 0700. Build `docker build -t orca-job-api:2.5.0-r1 /opt/orca-job-api/source`; submit `nomad job run /opt/orca-job-api/source/orca.nomad.hcl`. The image is local to the constrained node, so deployments must build it there. Use a fresh revision tag for subsequent code deployments and update the job's image name to ensure adoption. This is a standalone Nomad deployment, not a Pulumi state resource; do not run the entire homelab stack to deploy it.

The node has only 164 MHz of unreserved Nomad CPU capacity, despite idle physical CPU. This job reserves 100 MHz for the native task and 50 MHz for the gateway as soft CPU shares; it can use idle CPU but yields to existing reservations under contention. No existing reservation was reduced. Complex models may hit the five-minute runtime limit under load. The existing Cloudflare edge can reject Python urllib's default User-Agent; set a descriptive application User-Agent (for example `OrcaJobClient/1.0`) when using that client.

Inspect with `nomad job status orca-job-api`, `nomad alloc logs <allocation> native`, and `nomad alloc logs <allocation> gateway`. Restart/stop only this job. Stop service with `nomad job stop orca-job-api`; preserve `/opt/orca-job-api/data` for retained jobs. Do not delete the Infisical secret or state as part of a routine stop.
