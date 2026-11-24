#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, open, readFile, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

export const DEFAULT_URL = "https://orca.bagelindustries.com";
export const DEFAULT_PRESET = "bambu-a1-mini-0.4-pla";

async function readBoundedFile(path, limit, label, signal) {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || !info.size || info.size > limit)
      throw new Error(
        `${label} must be a nonempty file of at most ${limit} bytes.`,
      );
    const chunks = [];
    let size = 0;
    while (size <= limit) {
      signal.throwIfAborted();
      const buffer = Buffer.allocUnsafe(Math.min(65536, limit + 1 - size));
      const { bytesRead } = await file.read(buffer);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > limit) throw new Error(`${label} exceeds ${limit} bytes.`);
      chunks.push(buffer.subarray(0, bytesRead));
    }
    if (!size) throw new Error(`${label} is empty.`);
    return Buffer.concat(chunks, size);
  } finally {
    await file.close();
  }
}

/** Upload an STL, await slicing, and save G-code without overwriting a file. */
export async function slice({
  inputPath,
  outputPath,
  tokenFile,
  baseUrl = DEFAULT_URL,
  preset,
  configurationPath,
  configurationId,
  signal = AbortSignal.timeout(30 * 60_000),
  onStatus = () => {},
  ...unknown
}) {
  if (Object.keys(unknown).length)
    throw new Error(
      `Unknown slice options: ${Object.keys(unknown).join(", ")}.`,
    );
  if (
    [preset, configurationPath, configurationId].filter(
      (value) => value !== undefined,
    ).length > 1
  )
    throw new Error(
      "Choose one preset, configuration JSON file, or configuration ID.",
    );
  if (configurationId !== undefined && !/^[a-f0-9]{64}$/.test(configurationId))
    throw new Error("Invalid configuration ID.");
  const base = new URL(baseUrl);
  if (base.protocol !== "https:" || base.username || base.password) {
    throw new Error("The API URL must use HTTPS without URL credentials.");
  }
  base.pathname = "/";
  base.search = "";
  base.hash = "";
  if (!tokenFile)
    throw new Error("Set ORCA_API_TOKEN_FILE to your API key file.");
  const token = (await readFile(tokenFile, "utf8")).trim();
  if (!token || /\s/.test(token)) throw new Error("Invalid API key file.");
  const model = await readBoundedFile(
    inputPath,
    20 * 1024 * 1024,
    "STL",
    signal,
  );

  async function request(path, options = {}, expectedStatus) {
    const response = await fetch(new URL(path, base), {
      ...options,
      headers: { ...options.headers, Authorization: `Bearer ${token}` },
      redirect: "manual",
      signal,
    });
    if (
      !response.ok ||
      (expectedStatus && response.status !== expectedStatus)
    ) {
      const details = response.headers
        .get("content-type")
        ?.startsWith("application/json")
        ? await response.json().catch(() => null)
        : null;
      await response.body?.cancel().catch(() => {});
      throw Object.assign(
        new Error(
          `Slicing API returned HTTP ${response.status} for ${path}.${expectedStatus ? ` Expected HTTP ${expectedStatus}; do not retry submission blindly.` : ""}`,
        ),
        { httpStatus: response.status, details },
      );
    }
    return response;
  }

  let resolvedConfigurationId = configurationId;
  if (configurationPath !== undefined) {
    const body = (
      await readBoundedFile(
        configurationPath,
        1024 * 1024,
        "Configuration JSON",
        signal,
      )
    ).toString("utf8");
    const configuration = JSON.parse(body);
    if (
      !configuration ||
      typeof configuration !== "object" ||
      Array.isArray(configuration)
    )
      throw new Error("Configuration JSON must be an object.");
    const created = await (
      await request(
        "/v2/configurations",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        },
        201,
      )
    ).json();
    if (typeof created.id !== "string" || !/^[a-f0-9]{64}$/.test(created.id))
      throw new Error("The API returned an invalid configuration ID.");
    resolvedConfigurationId = created.id;
  }

  // Do not retry creation: an interrupted response may still have queued a job.
  let job;
  try {
    const response = await request(
      resolvedConfigurationId
        ? `/v2/jobs?configuration=${resolvedConfigurationId}`
        : `/v1/jobs?preset=${encodeURIComponent(preset ?? DEFAULT_PRESET)}`,
      {
        method: "POST",
        headers: { "Content-Type": "model/stl" },
        body: model,
      },
      202,
    );
    job = await response.json();
    if (typeof job.id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(job.id))
      throw new Error("The API returned an invalid job ID.");
  } catch (error) {
    if (resolvedConfigurationId)
      error.configurationId = resolvedConfigurationId;
    throw error;
  }
  const jobId = job.id;
  const jobPath = `/v1/jobs/${jobId}`;
  try {
    onStatus(job);
    while (job.status === "queued" || job.status === "running") {
      await delay(1000, undefined, { signal });
      const previousStatus = job.status;
      const next = await (await request(jobPath)).json();
      if (next.id !== undefined && next.id !== jobId) {
        throw new Error("The API returned a mismatched job ID.");
      }
      job = { ...next, id: jobId };
      if (job.status !== previousStatus) onStatus(job);
    }
    if (job.status !== "succeeded") {
      throw Object.assign(
        new Error(`Job ${jobId} did not succeed (${job.status}).`),
        { job },
      );
    }

    const gcode = await request(`${jobPath}/gcode`);
    const mediaType = gcode.headers.get("content-type")?.split(";")[0].trim();
    if (gcode.status !== 200 || mediaType !== "text/x.gcode" || !gcode.body) {
      await gcode.body?.cancel();
      throw new Error("The API returned an invalid G-code response.");
    }
    const temporary = join(
      dirname(outputPath),
      `.${basename(outputPath)}.${randomUUID()}.part`,
    );
    let file;
    try {
      file = await open(temporary, "wx", 0o600);
    } catch (error) {
      await gcode.body.cancel();
      throw error;
    }
    try {
      const digest = createHash("sha256");
      const checksum = new Transform({
        transform(chunk, _encoding, callback) {
          digest.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(gcode.body),
        checksum,
        file.createWriteStream(),
        { signal },
      );
      const bytes = (await stat(temporary)).size;
      const length = gcode.headers.get("content-length");
      if (!bytes || (length !== null && Number(length) !== bytes)) {
        throw new Error("The G-code download was empty or incomplete.");
      }
      const sha256 = digest.digest("hex");
      if (
        (job.output_bytes !== undefined && job.output_bytes !== bytes) ||
        (job.output_sha256 !== undefined && job.output_sha256 !== sha256)
      ) {
        throw new Error(
          "The G-code download does not match the completed job.",
        );
      }
      // A hard link publishes the complete file atomically and never overwrites.
      await link(temporary, outputPath);
      return { ...job, output: outputPath, bytes, sha256 };
    } finally {
      await file.close();
      await unlink(temporary);
    }
  } catch (error) {
    throw Object.assign(
      new Error(error instanceof Error ? error.message : "Slicing failed.", {
        cause: error,
      }),
      {
        jobId,
        statusUrl: new URL(jobPath, base).href,
        ...(error?.code ? { code: error.code } : {}),
        ...(error?.httpStatus ? { httpStatus: error.httpStatus } : {}),
        ...(error?.details ? { details: error.details } : {}),
        ...(error?.job ? { job: error.job } : {}),
        ...(resolvedConfigurationId
          ? { configurationId: resolvedConfigurationId }
          : {}),
      },
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const args = process.argv.slice(2);
  const [inputPath, outputPath, mode = DEFAULT_PRESET, value] = args;
  const configured =
    mode === "--configuration" || mode === "--configuration-id";
  if (
    !inputPath ||
    !outputPath ||
    (configured ? args.length !== 4 : args.length > 3)
  ) {
    console.error(
      "Usage: ORCA_API_TOKEN_FILE=/path/to/key node client/slice.mjs model.stl output.gcode [preset | --configuration settings.json | --configuration-id ID]",
    );
    process.exitCode = 1;
  } else {
    try {
      const result = await slice({
        inputPath,
        outputPath,
        ...(mode === "--configuration"
          ? { configurationPath: value }
          : mode === "--configuration-id"
            ? { configurationId: value }
            : { preset: mode }),
        tokenFile: process.env.ORCA_API_TOKEN_FILE,
        baseUrl: process.env.ORCA_API_URL || DEFAULT_URL,
        onStatus: ({ id, status }) =>
          console.error(JSON.stringify({ id, status })),
      });
      console.log(JSON.stringify(result));
    } catch (error) {
      console.error(
        JSON.stringify({
          error: error instanceof Error ? error.message : "Slicing failed.",
          jobId: error?.jobId,
          statusUrl: error?.statusUrl,
          httpStatus: error?.httpStatus,
          details: error?.details,
          job: error?.job,
          configurationId: error?.configurationId,
        }),
      );
      process.exitCode = 1;
    }
  }
}
