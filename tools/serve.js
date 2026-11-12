// Tiny static server for the web app:  bun tools/serve.js [port]   (or: bun run web)
// Serves web/ as the site root, plus the licence files (LICENSE, docs/THIRD_PARTY_NOTICES.md)
// and engine.js (engine.ts without its types, made afresh for each request), which is the same
// layout `bun run build` puts in dist/. Sends the cross-origin isolation headers so
// SharedArrayBuffer is available and "stop" can interrupt a running search.
import { resolve, dirname, extname, normalize } from "node:path";
import { existsSync, statSync } from "node:fs";
import { engineJs } from "./engine-js.js";

const root = resolve(dirname(Bun.main), "..");
const web = resolve(root, "web");
// Site path -> repository file, for the licence files served beside index.html.
const LICENCE_FILES = { "/LICENSE": "LICENSE", "/THIRD_PARTY_NOTICES.md": "docs/THIRD_PARTY_NOTICES.md" };
const port = parseInt(process.argv[2] || "8080");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
                ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp",
                ".md": "text/markdown; charset=utf-8" };

Bun.serve({
  port,
  fetch(req) {
    let path = normalize(decodeURIComponent(new URL(req.url).pathname)).replace(/\\/g, "/");
    if (path === "/") path = "/index.html";
    const headers = (file) => ({
      "Content-Type": types[extname(file)] || "application/octet-stream",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cache-Control": "no-cache",
    });
    if (path === "/engine.js") return new Response(engineJs(), { headers: headers(path) });
    if (Object.hasOwn(LICENCE_FILES, path)) {
      const licence = resolve(root, LICENCE_FILES[path]);
      return new Response(Bun.file(licence), { headers: headers(licence) });
    }
    const file = resolve(web, "." + path);
    if (!file.startsWith(web) || !existsSync(file) || statSync(file).isDirectory()) return new Response("not found", { status: 404 });
    return new Response(Bun.file(file), { headers: headers(file) });
  },
});
console.log(`Pedagog web app: http://localhost:${port}/`);
