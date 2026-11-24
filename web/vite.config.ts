import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import type { ServerResponse } from "node:http";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const backendTarget = process.env.ORCA_BACKEND_URL || "http://127.0.0.1:8080";
const bambuApiTarget = process.env.BAMBU_API_URL || "https://bambuapi.raygen.dev";

interface BundledAsset {
  raw: Buffer;
  gz: Buffer | null;
  contentType: string;
  immutable: boolean;
}

function contentTypeFor(filePath: string): string {
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".map")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".woff2")) return "font/woff2";
  if (filePath.endsWith(".woff")) return "font/woff";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

function isCompressible(filePath: string): boolean {
  return (
    filePath.endsWith(".js") ||
    filePath.endsWith(".css") ||
    filePath.endsWith(".map") ||
    filePath.endsWith(".svg")
  );
}

/**
 * Dev-only bundled server mode (apply: "serve", zero effect on `vite build`).
 * Collapses Vite's 40+ unbundled ESM dev requests and multi-wave import waterfall
 * into a single gzipped JS bundle + CSS bundle with fast incremental esbuild rebuilds
 * and automatic SSE live-reload on file changes. Set ORCA_UNBUNDLED_DEV=1 to disable.
 */
function orcaBundledDevPlugin(): Plugin {
  const prefix = "/@dev-bundle";
  let assets = new Map<string, BundledAsset>();
  let buildId = String(Date.now());
  let buildError: string | null = null;
  const sseClients = new Set<ServerResponse>();

  return {
    name: "orca-bundled-dev",
    apply: "serve",
    config() {
      return {
        optimizeDeps: {
          noDiscovery: true,
        },
      };
    },
    async configureServer(server) {
      const rootDir = server.config.root;
      const publicDir = path.resolve(rootDir, "public");
      const req = createRequire(import.meta.url);
      const viteReq = createRequire(req.resolve("vite/package.json"));
      const esbuild = viteReq("esbuild") as {
        context: (opts: Record<string, unknown>) => Promise<{
          rebuild: () => Promise<{ outputFiles: Array<{ path: string; contents: Uint8Array }> }>;
          dispose: () => Promise<void>;
        }>;
      };

      const virtualOutDir = path.resolve(rootDir, ".dev-bundle-out");
      const ctx = await esbuild.context({
        entryPoints: { app: path.resolve(rootDir, "src/main.tsx") },
        bundle: true,
        format: "esm",
        target: "es2022",
        jsx: "automatic",
        write: false,
        outdir: virtualOutDir,
        publicPath: `${prefix}/`,
        sourcemap: "linked",
        minifySyntax: true,
        minifyWhitespace: true,
        assetNames: "assets/[name]-[hash]",
        loader: {
          ".woff2": "file",
          ".woff": "file",
          ".png": "file",
          ".svg": "file",
        },
        define: {
          "process.env.NODE_ENV": '"development"',
          "import.meta.env.DEV": "true",
          "import.meta.env.PROD": "false",
          "import.meta.env.MODE": '"development"',
          "import.meta.env.BASE_URL": '"/"',
        },
      });

      const runRebuild = async (notify: boolean) => {
        try {
          const result = await ctx.rebuild();
          const next = new Map<string, BundledAsset>();
          for (const out of result.outputFiles) {
            const rel = path.relative(virtualOutDir, out.path).split(path.sep).join("/");
            const urlPath = `${prefix}/${rel}`;
            const raw = Buffer.from(out.contents);
            const gz = isCompressible(rel) ? zlib.gzipSync(raw, { level: 6 }) : null;
            next.set(urlPath, {
              raw,
              gz,
              contentType: contentTypeFor(rel),
              immutable: rel.startsWith("assets/"),
            });
          }
          assets = next;
          buildId = String(Date.now());
          buildError = null;
          if (notify) {
            for (const client of sseClients) {
              try {
                client.write(`data: reload:${buildId}\n\n`);
              } catch {
                sseClients.delete(client);
              }
            }
          }
        } catch (err) {
          buildError = err instanceof Error ? err.message : String(err);
          server.config.logger.error(`[orca-bundled-dev] rebuild failed: ${buildError}`);
        }
      };

      let pendingBuild: Promise<void> = runRebuild(false);
      await pendingBuild;

      let debounceTimer: ReturnType<typeof setTimeout> | null = null;
      const scheduleRebuild = (changedPath: string) => {
        const normalized = path.resolve(changedPath);
        if (!normalized.startsWith(path.resolve(rootDir, "src")) && normalized !== path.resolve(rootDir, "index.html")) {
          return;
        }
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          pendingBuild = runRebuild(true);
        }, 40);
      };

      server.watcher.on("change", scheduleRebuild);
      server.watcher.on("add", scheduleRebuild);
      server.watcher.on("unlink", scheduleRebuild);

      server.httpServer?.once("close", () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        for (const client of sseClients) {
          try {
            client.end();
          } catch {
            // ignore
          }
        }
        sseClients.clear();
        void ctx.dispose();
      });

      const reloadSnippet = `<script>window.addEventListener("load",function(){try{var es=new EventSource("${prefix}/events");es.onmessage=function(){location.reload();};}catch(e){}});</script>`;

      server.middlewares.use(async (reqNode, res, next) => {
        const rawUrl = reqNode.url || "/";
        const pathname = rawUrl.split("?")[0];

        if (pathname === `${prefix}/events`) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
          });
          res.write(": connected\n\n");
          sseClients.add(res);
          reqNode.on("close", () => sseClients.delete(res));
          return;
        }

        if (pathname.startsWith(`${prefix}/`)) {
          await pendingBuild;
          const asset = assets.get(pathname);
          if (!asset) {
            res.statusCode = 404;
            res.end("Not found");
            return;
          }
          const acceptEncoding = String(reqNode.headers["accept-encoding"] || "");
          const useGzip = asset.gz !== null && acceptEncoding.includes("gzip");
          const body = useGzip ? asset.gz! : asset.raw;
          res.setHeader("Content-Type", asset.contentType);
          res.setHeader(
            "Cache-Control",
            asset.immutable ? "public, max-age=31536000, immutable" : "no-cache"
          );
          if (useGzip) {
            res.setHeader("Content-Encoding", "gzip");
            res.setHeader("Vary", "Accept-Encoding");
          }
          res.setHeader("Content-Length", String(body.byteLength));
          res.end(body);
          return;
        }

        // Stateless presigned S3 PUT forwarder matching web/worker/index.ts for local dev
        if (pathname === "/bambu-upload" && reqNode.method === "PUT") {
          const target = String(reqNode.headers["x-upload-target"] || "");
          let parsed: URL;
          try {
            parsed = new URL(target);
          } catch {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "Invalid X-Upload-Target URL" }));
            return;
          }
          const h = parsed.hostname.toLowerCase();
          const okHost =
            h.endsWith(".amazonaws.com") ||
            h.endsWith(".aliyuncs.com") ||
            h.endsWith(".bambulab.com") ||
            h.endsWith(".bambulab.net");
          if (parsed.protocol !== "https:" || !okHost) {
            res.statusCode = 403;
            res.end(JSON.stringify({ error: "Upload host not allowed" }));
            return;
          }
          const chunks: Buffer[] = [];
          reqNode.on("data", (c: Buffer) => chunks.push(c));
          reqNode.on("end", async () => {
            try {
              const bodyBuf = Buffer.concat(chunks);
              const headers: Record<string, string> = {};
              if (reqNode.headers["content-type"]) headers["Content-Type"] = String(reqNode.headers["content-type"]);
              const upstream = await fetch(parsed.toString(), {
                method: "PUT",
                headers,
                body: bodyBuf,
              });
              const out = Buffer.from(await upstream.arrayBuffer());
              res.statusCode = upstream.status;
              res.end(out);
            } catch (err) {
              res.statusCode = 502;
              res.end(String(err));
            }
          });
          return;
        }

        // Serve bundled HTML for `/` and SPA routes (skip /api, /bambu-api, and real static files in public/)
        const isGet = (reqNode.method || "GET") === "GET";
        const accept = String(reqNode.headers.accept || "");
        const hasExt = path.extname(pathname) !== "" && pathname !== "/index.html";
        if (
          isGet &&
          !pathname.startsWith("/api") &&
          !pathname.startsWith("/bambu-api") &&
          !hasExt &&
          (pathname === "/" || pathname === "/index.html" || accept.includes("text/html"))
        ) {
          if (pathname !== "/" && pathname !== "/index.html") {
            const candidate = path.resolve(publicDir, pathname.replace(/^\/+/, ""));
            if (candidate.startsWith(publicDir) && fs.existsSync(candidate)) {
              next();
              return;
            }
          }
          await pendingBuild;
          const template = fs.readFileSync(path.resolve(rootDir, "index.html"), "utf8");
          let html: string;
          if (buildError) {
            html = template.replace(
              /<script\s+type="module"\s+src="\/src\/main\.tsx"\s*><\/script>/,
              `<pre style="padding:16px;color:#fca5a5;background:#181a1f;white-space:pre-wrap;font-family:monospace">${buildError.replace(/</g, "&lt;")}</pre>${reloadSnippet}`
            );
          } else {
            const fontPreloads = [...assets.keys()]
              .filter((p) => /\/assets\/geist(?:-mono)?-latin-wght-normal-[^/]+\.woff2$/.test(p))
              .map((p) => `<link rel="preload" as="font" type="font/woff2" crossorigin href="${p}" />`)
              .join("\n    ");
            const headTags = `${fontPreloads ? `${fontPreloads}\n    ` : ""}<link rel="stylesheet" href="${prefix}/app.css?v=${buildId}" />`;
            html = template
              .replace("</head>", `    ${headTags}\n  </head>`)
              .replace(
                /<script\s+type="module"\s+src="\/src\/main\.tsx"\s*><\/script>/,
                `<script type="module" src="${prefix}/app.js?v=${buildId}"></script>\n    ${reloadSnippet}`
              );
          }
          const buf = Buffer.from(html, "utf8");
          res.statusCode = buildError ? 500 : 200;
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.setHeader("Cache-Control", "no-cache");
          res.setHeader("Content-Length", String(buf.byteLength));
          res.end(buf);
          return;
        }

        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [
    ...(!process.env.VITEST && process.env.ORCA_UNBUNDLED_DEV !== "1" ? [orcaBundledDevPlugin()] : []),
    react(),
  ],
  server: {
    host: "127.0.0.1",
    port: 5173,
    allowedHosts: true,
    proxy: {
      "/api": {
        target: backendTarget,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
      "/bambu-api": {
        target: bambuApiTarget,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/bambu-api/, ""),
      },
    },
  },
  build: {
    target: "es2022",
    rollupOptions: {
      output: {
        manualChunks: {
          three: ["three"],
          react: ["react", "react-dom"],
          icons: ["lucide-react"],
        },
      },
    },
  },
});
