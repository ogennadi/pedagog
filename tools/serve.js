// Tiny static server for the web app:  bun tools/serve.js [port]   (or: bun run web)
// Serves web/ as the site root, plus the engine and the licence files from the repository root,
// which is the same layout `bun run build` puts in dist/. Sends the cross-origin isolation
// headers so SharedArrayBuffer is available and "stop" can interrupt a running search.
import { resolve, dirname, extname, normalize } from "node:path";
import { existsSync, statSync } from "node:fs";

const root = resolve(dirname(Bun.main), "..");
const web = resolve(root, "web");
const FROM_ROOT = new Set(["/engine.js", "/LICENSE", "/THIRD_PARTY_NOTICES.md"]);
const port = parseInt(process.argv[2] || "8080");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
                ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp",
                ".md": "text/markdown; charset=utf-8" };

Bun.serve({
  port,
  fetch(req) {
    let path = normalize(decodeURIComponent(new URL(req.url).pathname)).replace(/\\/g, "/");
    if (path === "/") path = "/index.html";
    const base = FROM_ROOT.has(path) ? root : web;
    const file = resolve(base, "." + path);
    if (!file.startsWith(base) || !existsSync(file) || statSync(file).isDirectory()) return new Response("not found", { status: 404 });
    return new Response(Bun.file(file), { headers: {
      "Content-Type": types[extname(file)] || "application/octet-stream",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cache-Control": "no-cache",
    } });
  },
});
console.log(`Pedagog web app: http://localhost:${port}/`);
