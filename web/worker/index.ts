/**
 * Cloudflare Worker reverse proxy for Orca Cloud Web.
 * Injects optional server-side ORCA_API_KEY secret so browser users never need accounts or API keys.
 */

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  ORCA_ORIGIN?: string;
  ORCA_API_KEY?: string;
  BAMBU_API_ORIGIN?: string;
}

const ALLOWED_PREFIXES = [
  "/healthz",
  "/openapi.json",
  "/v1/presets",
  "/v1/jobs",
  "/v2/profiles",
  "/v2/settings",
  "/v2/configurations",
  "/v2/jobs",
  "/v2/meshes",
  "/v2/mesh/",
  "/v2/assets/",
];

const ALLOWED_BAMBU_PREFIXES = [
  "/v1/healthz",
  "/v1/auth/",
  "/v1/me",
  "/v1/keys",
  "/v1/printers",
  "/v1/devices",
  "/v1/cloud/",
];

function isApiPath(pathname: string): boolean {
  return ALLOWED_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));
}

function isBambuPath(pathname: string): boolean {
  return ALLOWED_BAMBU_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));
}

function isAllowedUploadHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h.endsWith(".amazonaws.com") ||
    h.endsWith(".aliyuncs.com") ||
    h.endsWith(".bambulab.com") ||
    h.endsWith(".bambulab.net")
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = (env.ORCA_ORIGIN || "https://orca.bagelindustries.com").replace(/\/+$/, "");
    const originHost = new URL(origin).hostname;

    // Stateless CORS-free proxy for user's browser-stored bambuapi.raygen.dev credentials (zero server-side accounts)
    if (url.pathname.startsWith("/bambu-api/")) {
      const bambuPath = url.pathname.slice(10) || "/";
      if (!isBambuPath(bambuPath)) {
        return new Response(JSON.stringify({ error: "Bambu route not allowed" }), {
          status: 404,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
      const bambuOrigin = (env.BAMBU_API_ORIGIN || "https://bambuapi.raygen.dev").replace(/\/+$/, "");
      const targetUrl = `${bambuOrigin}${bambuPath}${url.search}`;
      const headers = new Headers();
      for (const name of ["Content-Type", "Accept", "Authorization", "X-API-Key", "X-Bambu-Signed"]) {
        const val = request.headers.get(name);
        if (val) headers.set(name, val);
      }
      request.headers.forEach((val, key) => {
        if (key.toLowerCase().startsWith("x-bbl-")) headers.set(key, val);
      });
      headers.set("User-Agent", "OrcaCloudWebProxy/1.0");
      const upstream = await fetch(targetUrl, {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
        redirect: "manual",
      });
      const respHeaders = new Headers(upstream.headers);
      respHeaders.set("Cache-Control", "no-store");
      respHeaders.delete("Set-Cookie");
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: respHeaders,
      });
    }

    // Stateless presigned S3 PUT forwarder so sliced .3mf uploads to Bambu Cloud avoid browser S3 CORS blocks
    if (url.pathname === "/bambu-upload" && request.method === "PUT") {
      const target = request.headers.get("X-Upload-Target") || "";
      let parsedTarget: URL;
      try {
        parsedTarget = new URL(target);
      } catch {
        return new Response(JSON.stringify({ error: "Invalid X-Upload-Target URL" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (parsedTarget.protocol !== "https:" || !isAllowedUploadHost(parsedTarget.hostname)) {
        return new Response(JSON.stringify({ error: "Upload host not allowed" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }
      // Bambu S3 SigV2 presigned PUT URLs sign an empty Content-Type; forwarding any Content-Type causes 403 SignatureDoesNotMatch
      const putHeaders = new Headers();
      const cl = request.headers.get("Content-Length");
      if (cl) putHeaders.set("Content-Length", cl);
      const upstream = await fetch(parsedTarget.toString(), {
        method: "PUT",
        headers: putHeaders,
        body: request.body,
        redirect: "manual",
      });
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: { "Cache-Control": "no-store" },
      });
    }

    // Pass direct native API routes (/healthz, /openapi.json, /v1/*, /v2/*) straight to the origin backend
    // so existing CLI/Executor clients on orca.bagelindustries.com keep working with their own Bearer auth.
    if (isApiPath(url.pathname)) {
      if (url.hostname === originHost) {
        return fetch(request);
      }
      return fetch(`${origin}${url.pathname}${url.search}`, request);
    }

    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    const upstreamPath = url.pathname.slice(4) || "/";
    if (!isApiPath(upstreamPath)) {
      return new Response(JSON.stringify({ error: "Route not allowed" }), {
        status: 404,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }

    const targetUrl = `${origin}${upstreamPath}${url.search}`;

    const headers = new Headers();
    const contentType = request.headers.get("Content-Type");
    if (contentType) headers.set("Content-Type", contentType);
    const contentLength = request.headers.get("Content-Length");
    if (contentLength) headers.set("Content-Length", contentLength);
    headers.set("User-Agent", "OrcaCloudWebProxy/1.0");

    // Prefer server-side secret so end users need no account or token; pass through explicit Bearer if supplied.
    const authHeader = request.headers.get("Authorization");
    if (env.ORCA_API_KEY) {
      headers.set("Authorization", `Bearer ${env.ORCA_API_KEY}`);
    } else if (authHeader) {
      headers.set("Authorization", authHeader);
    }

    const upstream = await fetch(targetUrl, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual",
    });

    const respHeaders = new Headers(upstream.headers);
    respHeaders.set("Cache-Control", "no-store");
    respHeaders.delete("Set-Cookie");
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: respHeaders,
    });
  },
};
