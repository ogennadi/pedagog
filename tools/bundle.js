// Build a single self-contained HTML file for the web app:  bun tools/bundle.js  (or: bun run bundle)
//
// Browsers refuse ES modules and Workers from file:// (each local file is a unique origin), so
// the app as served cannot be opened by double-clicking index.html. This bundles everything —
// CSS, chessground, cm-chess and its dependencies, the app, the opening book, and the engine
// source itself — into pedagog-app.html. The engine is started from a Blob URL, which browsers
// do allow from file://, so the bot still runs off the main thread and the page stays smooth.
import { resolve, dirname } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";

const root = resolve(dirname(Bun.main), "..");
const vendor = resolve(root, "web", "vendor");
const aliases = {   // the import map from index.html, for the bundler
  chessground: resolve(vendor, "chessground", "chessground.min.js"),
  "cm-chess/": resolve(vendor, "cm-chess") + "/",
  "cm-pgn/": resolve(vendor, "cm-pgn") + "/",
  "chess.mjs/": resolve(vendor, "chess.mjs") + "/",
};

const result = await Bun.build({
  entrypoints: [resolve(root, "web", "app.js")],
  format: "iife",
  target: "browser",
  minify: false,
  plugins: [{
    name: "import-map",
    setup(build) {
      build.onResolve({ filter: /^(chessground|cm-chess\/|cm-pgn\/|chess\.mjs\/)/ }, (args) => {
        for (const [prefix, target] of Object.entries(aliases)) {
          if (args.path === prefix) return { path: target };
          if (args.path.startsWith(prefix) && prefix.endsWith("/")) return { path: target + args.path.slice(prefix.length) };
        }
        return undefined;
      });
    },
  }],
});
if (!result.success) { for (const log of result.logs) console.error(log); process.exit(1); }
const appJs = await result.outputs[0].text();

const css = ["chessground/chessground.base.css", "chessground/chessground.brown.css", "chessground/chessground.cburnett.css"]
  .map((f) => readFileSync(resolve(vendor, f), "utf8")).join("\n") + "\n" + readFileSync(resolve(root, "web", "app.css"), "utf8");
const engine = readFileSync(resolve(root, "pedagog.js"), "utf8");
const thirdPartyLicenses = [
  ["chessground", "web/vendor/chessground/LICENSE"],
  ["chess.mjs", "web/vendor/chess.mjs/LICENSE"],
  ["cm-chess", "web/vendor/cm-chess/LICENSE"],
  ["cm-pgn", "web/vendor/cm-pgn/LICENSE"],
].map(([name, path]) => {
  const license = readFileSync(resolve(root, path), "utf8");
  const escaped = license.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<section><h3>${name}</h3><pre>${escaped}</pre></section>`;
}).join("\n");
const licensePanel = `<details id="third-party-licenses"><summary>Third-party license texts</summary>${thirdPartyLicenses}</details>`;

let html = readFileSync(resolve(root, "index.html"), "utf8");
html = html.replace(/<link rel="manifest"[^>]*>\s*/g, "");
html = html.replace(/<link rel="stylesheet"[^>]*>\s*/g, "");
html = html.replace(/<script type="importmap">[\s\S]*?<\/script>\s*/, "");
html = html.replace("</head>", `<style>\n${css}\n</style>\n</head>`);
html = html.replace(/<script type="module" src="web\/app.js"><\/script>/,
  `<script>globalThis.PEDAGOG_ENGINE_SOURCE = ${JSON.stringify(engine)};</script>\n<script>\n${appJs}\n</script>`);
html = html.replace('<a href="THIRD_PARTY_NOTICES.md">Third-party license notices</a>',
  '<a href="#third-party-licenses">Third-party license notices</a>');
html = html.replace("</body>", `${licensePanel}\n</body>`);
html = html.replace("Works offline once loaded.", "This is the single-file build: it works from a local file, no server needed.");

const out = resolve(root, "pedagog-app.html");
writeFileSync(out, html);
console.log(`wrote ${out} (${(html.length / 1024).toFixed(0)} KB)`);
