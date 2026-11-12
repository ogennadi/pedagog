// engine.js for browsers: engine.ts with its types removed. Comments are kept, so the file the
// web app loads still reads as the engine. Used by tools/serve.js, tools/build.js and the tests.
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import ts from "typescript";

export const engineTs = resolve(dirname(import.meta.path), "..", "engine.ts");

export function engineJs(path = engineTs) {
  const header = "// Generated from engine.ts by tools/engine-js.js; edit engine.ts instead.\n";
  const { outputText } = ts.transpileModule(readFileSync(path, "utf8"), {
    fileName: path,
    compilerOptions: { target: ts.ScriptTarget.ES2022, removeComments: false },
  });
  return header + outputText;
}
