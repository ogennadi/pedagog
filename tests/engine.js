import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { engineJs } from "../tools/engine-js.js";

// An isolated non-Bun host avoids stdin/workers and keeps test access
// to internals out of the engine's public UCI interface. A .ts engine is
// run as the engine.js the browser gets.
export function engine(path = resolve(import.meta.dir, "..", "engine.ts")) {
  let time = 0;
  const output = [];
  const context = createContext({
    performance: { now: () => time },
    console: { log: (line) => output.push(line) },
  });
  const source = path.endsWith(".ts") ? engineJs(path) : readFileSync(path, "utf8");
  runInContext(source, context, { filename: path });
  return {
    output,
    read: (expression) => runInContext(expression, context),
    run: (code) => runInContext(code, context),
    command: (line) => context.Pedagog.uci(line),
    clock: (milliseconds) => { time = milliseconds; },
  };
}

export function stableOutput(output) {
  return output.map((line) => line
    .replace(/ ponder \S+$/, "")
    .replace(/ nps \d+ time \d+/, "")
    .replace(/ time \d+ nps \d+/, "")
    .replace(/ nodes \d+ nps$/, " nodes"));
}
