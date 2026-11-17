// Show trained weight files side by side, one row per feature name, sorted by the first file's
// weights; a feature that a file lacks shows as "-". The column "diff" is the second file's
// weight minus the first's, for seeing where two models disagree.
//
//   bun src/variants/engine-searchless/weights.ts data/weights-strength2.json [OTHER.json ...]
//
// Weight files are train.ts's output: { set, names, weights }.

import { readFileSync } from "node:fs";
import { basename } from "node:path";

const files = process.argv.slice(2);
if (files.length === 0) throw new Error("usage: weights.ts FILE.json [FILE.json ...]");
const models = files.map((path) => {
  const { names, weights } = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(names)) throw new Error(`${path} has no feature names (an old weights file?)`);
  return { label: basename(path).replace(/\.json$/, ""), byName: new Map<string, number>(names.map((n: string, i: number) => [n, weights[i]])) };
});
const names = [...new Set(models.flatMap((m) => [...m.byName.keys()]))];
const first = models[0].byName;
names.sort((a, b) => (first.get(b) ?? -Infinity) - (first.get(a) ?? -Infinity));
const width = Math.max(...names.map((n) => n.length), 7);
const cell = (x: number | undefined) => (x === undefined ? "-" : (x >= 0 ? "+" : "") + x.toFixed(2)).padStart(8);
const labels = models.map((m) => m.label.slice(0, 22).padStart(Math.max(8, Math.min(22, m.label.length))));
console.log(`${"feature".padEnd(width)} ${labels.join(" ")}${models.length === 2 ? "     diff" : ""}`);
for (const name of names) {
  const values = models.map((m) => m.byName.get(name));
  const cells = values.map((v, i) => cell(v).padStart(labels[i].length));
  const diff = models.length === 2 && values[0] !== undefined && values[1] !== undefined ? cell(values[1] - values[0]) : "";
  console.log(`${name.padEnd(width)} ${cells.join(" ")} ${diff}`);
}
