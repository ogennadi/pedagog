// Assemble the deployable web app in dist/:  bun tools/build.js  (or: bun run build)
// dist/ is the site root: the contents of web/ plus the engine and the licence files beside
// index.html, the same layout tools/serve.js serves. dist/ is generated and ignored by Git.
import { resolve, dirname } from "node:path";
import { cpSync, rmSync, mkdirSync, readdirSync } from "node:fs";

const root = resolve(dirname(Bun.main), "..");
const dist = resolve(root, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);
cpSync(resolve(root, "web"), dist, { recursive: true });
for (const file of ["engine.js", "LICENSE", "THIRD_PARTY_NOTICES.md"]) cpSync(resolve(root, file), resolve(dist, file));
console.log(`wrote ${dist} (${readdirSync(dist).length} entries); deploy its contents as the site root`);
