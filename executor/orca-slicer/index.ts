import {
  defineApp,
  defineProvider,
  json,
  jsonSchema,
  mutation,
  number,
  object,
  plain,
  query,
  router,
  secrets,
  string,
  type Infer,
  type MutationContext,
  type QueryContext,
} from "apps";

// Matches the existing Infisical provider so its managed account can be linked.
const infisical = defineProvider({
  name: "Infisical",
  hosts: ["*.infisical.com"],
  auth: {
    universalAuth: secrets({
      label: "Universal Auth machine identity",
      fields: object({
        clientId: plain(string({ minLength: 1 })),
        clientSecret: string({ minLength: 1 }),
        siteUrl: plain(string()).optional(),
      }),
    }),
  },
});
const requirements = { user: { accounts: { infisical } } };
type Context =
  | QueryContext<typeof requirements>
  | MutationContext<typeof requirements>;
const ORIGIN = "https://orca.bagelindustries.com";
const PROJECT = "923d970a-8e38-48f5-8c38-e7197c1ce36c";

async function apiKey(ctx: Context): Promise<string> {
  const account = ctx.user.accounts.infisical;
  const site = new URL(
    account.fields.siteUrl?.trim() || "https://app.infisical.com",
  );
  if (
    site.protocol !== "https:" ||
    site.username ||
    site.password ||
    !site.hostname.endsWith(".infisical.com")
  ) {
    throw new Error("Expected an Infisical Cloud HTTPS account.");
  }
  const login = await ctx.fetch(
    `${site.origin}/api/v1/auth/universal-auth/login`,
    {
      method: "POST",
      redirect: "manual",
      signal: ctx.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: account.fields.clientId,
        clientSecret: account.fields.clientSecret,
      }),
    },
  );
  if (!login.ok)
    throw new Error(`Infisical authentication failed (HTTP ${login.status}).`);
  const auth = (await login.json()) as { accessToken?: string };
  if (!auth.accessToken) throw new Error("Infisical returned no access token.");
  const url = new URL("/api/v4/secrets/ORCA_API_KEY", site.origin);
  url.search = new URLSearchParams({
    projectId: PROJECT,
    environment: "prod",
    secretPath: "/orca-slicer",
    type: "shared",
    viewSecretValue: "true",
  }).toString();
  const response = await ctx.fetch(url.href, {
    redirect: "manual",
    signal: ctx.signal,
    headers: { Authorization: `Bearer ${auth.accessToken}` },
  });
  if (!response.ok)
    throw new Error(
      `Cannot read the slicing service key (HTTP ${response.status}).`,
    );
  const body = (await response.json()) as { secret?: { secretValue?: string } };
  if (!body.secret?.secretValue)
    throw new Error("The slicing service key is missing.");
  return body.secret.secretValue;
}

async function apiResponse(
  ctx: Context,
  path: string,
  init: RequestInit = {},
  authenticated = true,
) {
  return ctx.fetch(`${ORIGIN}${path}`, {
    ...init,
    redirect: "manual",
    signal: ctx.signal,
    headers: {
      ...init.headers,
      ...(authenticated
        ? { Authorization: `Bearer ${await apiKey(ctx)}` }
        : {}),
    },
  });
}

async function request(ctx: Context, path: string, init: RequestInit = {}) {
  const response = await apiResponse(ctx, path, init);
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `Orca API returned HTTP ${response.status}. Do not retry a submitted upload blindly.`,
    );
  }
  return response;
}

async function jsonRequest(
  ctx: Context,
  path: string,
  init: RequestInit = {},
  authenticated = true,
) {
  const response = await apiResponse(ctx, path, init, authenticated);
  if (response.status === 204)
    return { ok: true, http_status: 204, data: null };
  if (!response.headers.get("content-type")?.startsWith("application/json")) {
    await response.body?.cancel();
    throw new Error(`Orca API returned non-JSON HTTP ${response.status}.`);
  }
  // Validation failures are data, not an opaque tool exception: preserve every issue.
  return {
    ok: response.ok,
    http_status: response.status,
    data: await response.json(),
  };
}

async function readBounded(
  response: Response,
  limit: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (
    !response.body ||
    Number(response.headers.get("content-length")) > limit
  ) {
    await response.body?.cancel();
    throw new Error(
      `File exceeds the ${limit} byte tool limit or has no body; use the native HTTP API for larger files.`,
    );
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit)
        throw new Error(`File exceeds the ${limit} byte tool limit.`);
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  if (!size) throw new Error("Empty file.");
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

const ModelInput = object({
  sourceUrl: string().optional(),
  stlBase64: string().optional(),
});

const ModelProperties = {
  sourceUrl: { type: "string", minLength: 1, maxLength: 8192 },
  stlBase64: { type: "string", minLength: 1, maxLength: 5592408 },
} as const;
const ModelChoice = [{ required: ["sourceUrl"] }, { required: ["stlBase64"] }];
const LegacyJobInput = jsonSchema({
  type: "object",
  properties: {
    ...ModelProperties,
    preset: { type: "string", default: "bambu-a1-mini-0.4-pla" },
  },
  oneOf: ModelChoice,
  additionalProperties: false,
});

function modelInput(input: Json): Infer<typeof ModelInput> {
  const values = jsonObject(input);
  return {
    sourceUrl: values.sourceUrl as string | undefined,
    stlBase64: values.stlBase64 as string | undefined,
  };
}

async function loadStl(ctx: Context, input: Infer<typeof ModelInput>) {
  if (Boolean(input.sourceUrl) === Boolean(input.stlBase64))
    throw new Error("Supply exactly one of sourceUrl or stlBase64.");
  if (input.sourceUrl) {
    if (input.sourceUrl.length > 8192)
      throw new Error("sourceUrl is too long.");
    const source = new URL(input.sourceUrl);
    if (source.protocol !== "https:" || source.username || source.password)
      throw new Error("sourceUrl must be HTTPS without URL credentials.");
    const response = await ctx.fetch(source.href, {
      signal: ctx.signal,
      redirect: "manual",
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error(
        `STL fetch failed (HTTP ${response.status}); redirects are not followed.`,
      );
    }
    return readBounded(response, 20 * 1024 * 1024);
  }
  const encoded = input.stlBase64!;
  if (
    encoded.length > 5592408 ||
    encoded.length % 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
  )
    throw new Error("Invalid or oversized standard base64 STL.");
  const decoded = atob(encoded);
  if (!decoded.length || decoded.length > 4 * 1024 * 1024)
    throw new Error("Inline STL must be nonempty and at most 4 MiB.");
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}

type Json = Infer<ReturnType<typeof json>>;
function jsonObject(value: Json): Record<string, Json> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a JSON object.");
  return value as Record<string, Json>;
}

const ConfigurationInput = jsonSchema({
  type: "object",
  properties: { configuration: { type: "object" } },
  required: ["configuration"],
  additionalProperties: false,
});
const ConfigurationIdInput = jsonSchema({
  type: "object",
  properties: {
    configurationId: { type: "string", pattern: "^[a-f0-9]{64}$" },
  },
  required: ["configurationId"],
  additionalProperties: false,
});
const ConfiguredJobInput = jsonSchema({
  type: "object",
  properties: {
    configurationId: { type: "string", pattern: "^[a-f0-9]{64}$" },
    ...ModelProperties,
  },
  required: ["configurationId"],
  oneOf: ModelChoice,
  additionalProperties: false,
});

function configurationId(input: Json) {
  const id = jsonObject(input).configurationId;
  if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id))
    throw new Error("Invalid configuration ID.");
  return id;
}

function configurationBody(input: Json) {
  const configuration = jsonObject(input).configuration;
  const body = JSON.stringify(jsonObject(configuration));
  if (new TextEncoder().encode(body).length > 1024 * 1024)
    throw new Error("Configuration JSON must be at most 1 MiB.");
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  };
}

const JobInput = object({ jobId: string({ minLength: 1 }) });
function jobPath(jobId: string) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(jobId)) throw new Error("Invalid job ID.");
  return `/v1/jobs/${jobId}`;
}

export default defineApp(requirements, {
  tools: router(
    {
      health: query(
        {
          description: "Check the native OrcaSlicer service and its limits.",
          input: object({}),
          output: json(),
        },
        async (ctx: QueryContext<typeof requirements>) => {
          const response = await ctx.fetch(`${ORIGIN}/healthz`, {
            signal: ctx.signal,
            redirect: "manual",
          });
          if (!response.ok)
            throw new Error(`Orca health failed (HTTP ${response.status}).`);
          return response.json();
        },
      ),
      presets: query(
        {
          description:
            "List supported printer, nozzle, material, and process presets. Select a matching preset before slicing.",
          input: object({}),
          output: json(),
        },
        async (ctx: QueryContext<typeof requirements>) => {
          const response = await ctx.fetch(`${ORIGIN}/v1/presets`, {
            signal: ctx.signal,
            redirect: "manual",
          });
          if (!response.ok)
            throw new Error(`Preset lookup failed (HTTP ${response.status}).`);
          return response.json();
        },
      ),
      createJob: mutation(
        {
          description:
            "Slice using the legacy fixed 0.4 mm preset. For configurable printer/nozzle/material/process settings, use createConfiguration then createConfiguredJob. Supply exactly one of sourceUrl (HTTPS, max 20 MiB) or stlBase64 (max 4 MiB decoded). Never starts a print.",
          input: LegacyJobInput,
          output: json(),
        },
        async (ctx: MutationContext<typeof requirements>, input) => {
          const data = await loadStl(ctx, modelInput(input));
          const preset = jsonObject(input).preset ?? "bambu-a1-mini-0.4-pla";
          return (
            await request(
              ctx,
              `/v1/jobs?preset=${encodeURIComponent(String(preset))}`,
              {
                method: "POST",
                headers: { "Content-Type": "model/stl" },
                body: data,
              },
            )
          ).json();
        },
      ),
      profiles: query(
        {
          description:
            "Search the pinned official Orca profile catalog by kind, vendor, and name query. Read the matching printer/nozzle, process, and filament names before resolving a configuration. Returns {ok,http_status,data}.",
          input: jsonSchema({
            type: "object",
            properties: {
              kind: {
                type: "string",
                enum: ["machine", "process", "filament"],
              },
              vendor: { type: "string", minLength: 1, maxLength: 128 },
              q: { type: "string", maxLength: 256 },
              offset: { type: "integer", minimum: 0 },
              limit: { type: "integer", minimum: 1, maximum: 100 },
            },
            required: ["kind"],
            additionalProperties: false,
          }),
          output: json(),
        },
        async (ctx: QueryContext<typeof requirements>, input) => {
          const params = new URLSearchParams();
          for (const [key, value] of Object.entries(jsonObject(input)))
            params.set(key, String(value));
          return jsonRequest(ctx, `/v2/profiles?${params}`, {}, false);
        },
      ),
      settings: query(
        {
          description:
            "Read native Orca setting definitions and service restrictions before constructing complete profiles or overrides. This describes configuration, not physical printer safety. Returns {ok,http_status,data}.",
          input: jsonSchema({ type: "object", additionalProperties: false }),
          output: json(),
        },
        async (ctx: QueryContext<typeof requirements>) =>
          jsonRequest(ctx, "/v2/settings", {}, false),
      ),
      resolveConfiguration: query(
        {
          description:
            "Resolve configuration JSON without retaining a handle. configuration contains printer, process, filament, and bed_type; each profile is {profile:{vendor,name},overrides:{...}} or {settings:{...}}. Returns {ok,http_status,data} with flattened settings, provenance, and validation issues. Static validation is not a native slice.",
          input: ConfigurationInput,
          output: json(),
        },
        async (ctx: QueryContext<typeof requirements>, input) =>
          jsonRequest(ctx, "/v2/profiles/resolve", configurationBody(input)),
      ),
      createConfiguration: mutation(
        {
          description:
            "Retain an immutable configuration for later raw-STL jobs. Pass the same configuration object as resolveConfiguration, up to 1 MiB. Returns {ok,http_status,data}; only HTTP 201 creates a handle at data.id. Inspect validation/provenance: creation does not prove Orca applied the settings or that printing is safe.",
          input: ConfigurationInput,
          output: json(),
        },
        async (ctx: MutationContext<typeof requirements>, input) =>
          jsonRequest(ctx, "/v2/configurations", configurationBody(input)),
      ),
      getConfiguration: query(
        {
          description:
            "Read an immutable configuration handle, its expiry, requested/resolved settings, and static validation. Returns {ok,http_status,data}; a missing or expired handle is an error, never a fallback to the fixed preset.",
          input: ConfigurationIdInput,
          output: json(),
        },
        async (ctx: QueryContext<typeof requirements>, input) =>
          jsonRequest(ctx, `/v2/configurations/${configurationId(input)}`),
      ),
      deleteConfiguration: mutation(
        {
          description:
            "Delete a retained configuration handle. Already-admitted jobs keep their copied configuration. Returns {ok,http_status,data}; HTTP 204 confirms deletion.",
          input: ConfigurationIdInput,
          output: json(),
        },
        async (ctx: MutationContext<typeof requirements>, input) =>
          jsonRequest(ctx, `/v2/configurations/${configurationId(input)}`, {
            method: "DELETE",
          }),
      ),
      createConfiguredJob: mutation(
        {
          description:
            "Slice an STL using an immutable configurationId from createConfiguration. Supply exactly one HTTPS sourceUrl (20 MiB maximum, no redirects) or stlBase64 (4 MiB decoded maximum). Returns {ok,http_status,data}; HTTP 202 accepts data.id. Poll getJob and inspect native/field/output evidence, not only status. Never retry an ambiguous upload or start a print.",
          input: ConfiguredJobInput,
          output: json(),
        },
        async (ctx: MutationContext<typeof requirements>, input) => {
          const id = configurationId(input);
          const data = await loadStl(ctx, modelInput(input));
          return jsonRequest(ctx, `/v2/jobs?configuration=${id}`, {
            method: "POST",
            headers: { "Content-Type": "model/stl" },
            body: data,
          });
        },
      ),
      getJob: query(
        {
          description:
            "Read a legacy or configured job, including failure diagnostics and configuration/output evidence. Wait for succeeded or failed. For configured jobs compare requested/resolved/exported settings and reported checks; neither succeeded nor exported settings proves physical safety. output_bytes/output_sha256 identify G-code.",
          input: JobInput,
          output: json(),
        },
        async (ctx: QueryContext<typeof requirements>, { jobId }) =>
          (await request(ctx, jobPath(jobId))).json(),
      ),
      deleteJob: mutation(
        {
          description:
            "Delete a succeeded or failed job and its retained output to free capacity. Download any needed output first. Active jobs cannot be deleted.",
          input: JobInput,
          output: json(),
        },
        async (ctx: MutationContext<typeof requirements>, { jobId }) => {
          const response = await request(ctx, jobPath(jobId), {
            method: "DELETE",
          });
          return response.status === 204
            ? { id: jobId, deleted: true }
            : response.json();
        },
      ),
      getGcode: query(
        {
          description:
            "Read completed G-code as text (maximum 1 MiB). For larger output, use the native authenticated download URL from getJob. This does not send G-code to a printer.",
          input: JobInput,
          output: object({ jobId: string(), bytes: number(), text: string() }),
        },
        async (ctx: QueryContext<typeof requirements>, { jobId }) => {
          const response = await request(ctx, `${jobPath(jobId)}/gcode`);
          if (
            response.status !== 200 ||
            response.headers.get("content-type")?.split(";")[0].trim() !==
              "text/x.gcode"
          ) {
            await response.body?.cancel();
            throw new Error("Unexpected G-code response.");
          }
          const bytes = await readBounded(response, 1024 * 1024);
          const length = response.headers.get("content-length");
          const encoding = response.headers.get("content-encoding");
          if (
            length !== null &&
            (!encoding || encoding === "identity") &&
            Number(length) !== bytes.length
          ) {
            throw new Error("Incomplete G-code download.");
          }
          return {
            jobId,
            bytes: bytes.length,
            text: new TextDecoder().decode(bytes),
          };
        },
      ),
    },
    {
      title: "OrcaSlicer",
      description:
        "Native OrcaSlicer jobs on the homelab, with credentials resolved server-side from Infisical.",
      instructions:
        "For configurable slicing, use profiles and settings, then resolveConfiguration or createConfiguration with printer/process/filament/bed_type. Check ok and http_status on v2 tool results; detailed backend data, including validation failures, is preserved in data. Static configuration acceptance is not native validation. Use the immutable configurationId with createConfiguredJob; sourceUrl accepts public HTTPS STL up to 20 MiB and stlBase64 accepts up to 4 MiB decoded. STL units are millimeters. Keep data.id and poll getJob in later calls. Examine requested/resolved/exported values, native diagnostics, field comparisons and output checks; distinguish loaded settings from observed toolpath behavior, and never infer physical safety. Unknown or unverified settings are not proof of correctness. createJob/presets are the legacy fixed-preset path. Never retry an upload after an ambiguous network failure. getGcode returns at most 1 MiB; larger files use authenticated native HTTP. Jobs and configuration handles expire after 24 hours. Delete retained terminal jobs/unused handles to free capacity. These tools never print, move axes, or connect to a printer.",
    },
  ),
});
