// How few features does the strength set need? Fits the full `strength` set (81 concepts plus the
// 10 reply checks of strength.ts) on Stockfish-labelled positions, ranks the concepts by how much
// the validation loss rises when each one's weight alone is zeroed, then refits smaller sets:
// the reply checks alone, the reply checks plus the N most useful concepts, and the concepts
// without the reply checks. Writes weights-prune-<name>.json for each (playable by uci.ts) to --out-dir
// (data/ by default: give a scratch directory for a trial run).
//
//   bun src/variants/engine-searchless/prune.ts [--train-file data/sf-train.jsonl]
//     [--valid-file data/sf-valid.jsonl] [--epochs 6] [--tops 5,10,20,40] [--out-dir data]

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONCEPTS } from "./concepts.ts";
import { loadDataset } from "./features.ts";
import type { Dataset } from "./features.ts";
import { STRENGTH_SET } from "./strength.ts";
import { evaluate, options, train } from "./train.ts";

const dataDir = join(import.meta.dir, "data");
const set = STRENGTH_SET;
const name = (k: number) => set.name(k);

/* Load one dataset, printing progress. */
async function load(label: string, path: string): Promise<Dataset> {
  const started = Date.now();
  let last = 0;
  const data = await loadDataset(path, 1, 0, (games) => {
    if (Date.now() - last < 15000) return;
    last = Date.now();
    console.log(`  ${label}: ${games.toLocaleString()} positions, ${((Date.now() - started) / 1000).toFixed(0)} s`);
  }, set);
  console.log(`${label}: ${data.positions.toLocaleString()} positions, ${((Date.now() - started) / 1000).toFixed(0)} s`);
  return data;
}

/* A mask with the given features on. */
function maskOf(keep: Iterable<number>): Uint8Array {
  const mask = new Uint8Array(set.count);
  for (const k of keep) mask[k] = 1;
  return mask;
}

/* Fit under `mask`, report, and write the weights file. */
function fit(label: string, mask: Uint8Array, trainData: Dataset, valid: Dataset, opts: ReturnType<typeof options>,
  outDir: string): Float64Array {
  const quiet = console.log;
  console.log = () => {};
  const w = train(trainData, valid, set.count, opts, mask);
  console.log = quiet;
  const v = evaluate(valid, w);
  const used = mask.reduce((a, b) => a + b, 0);
  console.log(`${label.padEnd(18)} ${String(used).padStart(3)} features: validation ${(100 * v.accuracy).toFixed(2)}% ` +
    `(loss ${v.logLoss.toFixed(4)})`);
  writeFileSync(join(outDir, `weights-prune-${label}.json`), JSON.stringify({ set: "strength", features: set.count,
    names: Array.from({ length: set.count }, (_, k) => name(k)),
    weights: Array.from(w, (x) => Math.round(x * 1e4) / 1e4) }) + "\n");
  return w;
}

async function main(argv: readonly string[]): Promise<void> {
  const value = (flag: string, fallback: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
  };
  const trainFile = value("--train-file", join(dataDir, "sf-train.jsonl"));
  const validFile = value("--valid-file", join(dataDir, "sf-valid.jsonl"));
  const tops = value("--tops", "5,10,20,40").split(",").map(Number);
  const outDir = value("--out-dir", dataDir);
  const opts = { ...options([]), epochs: Number(value("--epochs", "6")) };
  const trainData = await load("training", trainFile);
  const valid = await load("validation", validFile);

  const concepts = Array.from({ length: CONCEPTS.length }, (_, k) => k);
  const replies = Array.from({ length: set.count - CONCEPTS.length }, (_, i) => CONCEPTS.length + i);
  const full = fit("full", maskOf([...concepts, ...replies]), trainData, valid, opts, outDir);

  const base = evaluate(valid, full).logLoss;
  const rise = concepts.map((k) => {
    const w = Float64Array.from(full, (x, j) => (j === k ? 0 : x));
    return { k, rise: evaluate(valid, w).logLoss - base };
  }).sort((a, b) => b.rise - a.rise);
  console.log("concepts by validation loss rise when zeroed:");
  for (const { k, rise: r } of rise.slice(0, Math.max(...tops))) console.log(`  ${name(k).padEnd(44)} +${r.toFixed(5)}`);

  fit("replies", maskOf(replies), trainData, valid, opts, outDir);
  for (const n of tops) fit(`replies-top${n}`, maskOf([...replies, ...rise.slice(0, n).map((r) => r.k)]), trainData, valid, opts, outDir);
  fit("concepts", maskOf(concepts), trainData, valid, opts, outDir);
}

if (import.meta.main) await main(process.argv.slice(2));
