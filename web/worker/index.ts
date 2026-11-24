/**
 * Cloudflare Worker reverse proxy for Orca Cloud Web.
 * Injects optional server-side ORCA_API_KEY secret so browser users never need accounts or API keys.
 */

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  ORCA_ORIGIN?: string;
  ORCA_API_KEY?: string;
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

function isApiPath(pathname: string): boolean {
  return ALLOWED_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = (env.ORCA_ORIGIN || "https://orca.bagelindustries.com").replace(/\/+$/, "");
    const originHost = new URL(origin).hostname;

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
