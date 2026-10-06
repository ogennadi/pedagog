// Tiny static server for the web app:  bun tools/serve.js [port]   (or: bun run web)
// Serves the repository root. Sends the cross-origin isolation headers so SharedArrayBuffer
// is available and "stop" can interrupt a running search.
import { resolve, dirname, extname, normalize } from "node:path";
import { existsSync, statSync } from "node:fs";

const root = resolve(dirname(Bun.main), "..");
const port = parseInt(process.argv[2] || "8080");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
                ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".md": "text/markdown; charset=utf-8" };

Bun.serve({
  port,
  fetch(req) {
    let path = decodeURIComponent(new URL(req.url).pathname);
    if (path === "/") path = "/index.html";
    const file = resolve(root, "." + normalize(path));
    if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) return new Response("not found", { status: 404 });
    return new Response(Bun.file(file), { headers: {
      "Content-Type": types[extname(file)] || "application/octet-stream",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cache-Control": "no-cache",
    } });
  },
});
console.log(`Pedagog web app: http://localhost:${port}/`);
