// engine.js for browsers: engine.ts with its types removed. Comments are kept, so the file the
// web app loads still reads as the engine. Used by src/tools/serve.js, src/tools/build.js and the tests.
import { readFileSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import ts from "typescript";

export const engineTs = resolve(dirname(import.meta.path), "..", "..", "engine.ts");
const variant = (name) => resolve(dirname(import.meta.path), "..", "variants", `engine-${name}`, `engine-${name}.ts`);

// The style variants the game page (index.html) offers, by site path. Each is one TypeScript file
// with engine.ts's UCI interface, so it runs in the same Worker wrapper.
export const ENGINE_SOURCES = {
  "engines/aggressive.js": variant("aggressive"),
  "engines/constrictor.js": variant("constrictor"),
  "engines/hedgehog.js": variant("hedgehog"),
  "engines/habits.js": variant("habits"),
};

export function engineJs(path = engineTs) {
  const header = `// Generated from ${basename(path)} by src/tools/engine-js.js; edit ${basename(path)} instead.\n`;
  const { outputText } = ts.transpileModule(readFileSync(path, "utf8"), {
    fileName: path,
    compilerOptions: { target: ts.ScriptTarget.ES2022, removeComments: false },
  });
  return header + outputText;
}
