// Fit the weights of strength.ts's features (81 concepts plus 10 reply checks) to Stockfish's
// moves, and measure them.
//
//   bun src/variants/engine-searchless/train.ts [--train-file data/sf-train.jsonl]
//     [--valid-file data/sf-valid.jsonl] [--rate 1] [--valid-rate 1] [--max-games N]
//     [--epochs 6] [--out data/weights-strength.json]
//
// Samples positions from the training and validation files (sflabel.ts's Stockfish-labelled
// positions; --rate keeps that share of them), fits the weights of a softmax over each position's
// legal moves by maximum likelihood (Adam, mini-batches, a little L2), and reports accuracy (the
// top-scoring move is Stockfish's; ties go to the first move generated, as in the engine) and
// log-loss on the validation positions after every epoch. Writes the weights and prints them
// all, largest first. prune.ts uses train() to refit with fewer features.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadDataset } from "./features.ts";
import type { Dataset, FeatureSet } from "./features.ts";
import { STRENGTH_SET } from "./strength.ts";

const dataDir = join(import.meta.dir, "data");
/** The feature sets, by the name weights files give them. */
export const SETS: Record<string, FeatureSet> = { strength: STRENGTH_SET };

/* The options of a command line. */
export function options(argv: readonly string[]) {
  const value = (name: string, fallback: string) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
  };
  return {
    set: value("--features", "strength"),
    trainFile: value("--train-file", join(dataDir, "sf-train.jsonl")),
    validFile: value("--valid-file", join(dataDir, "sf-valid.jsonl")),
    rate: Number(value("--rate", "1")),
    validRate: Number(value("--valid-rate", "1")),
    maxGames: Number(value("--max-games", "0")),
    epochs: Number(value("--epochs", "6")),
    batch: Number(value("--batch", "512")),
    learningRate: Number(value("--lr", "0.02")),
    l2: Number(value("--l2", "1e-6")),
    out: value("--out", join(dataDir, "weights-strength.json")),
  };
}

/* The scores of position p's moves under `w`. */
function scores(data: Dataset, w: Float64Array, p: number): Float64Array {
  const first = data.moveStart[p], count = data.moveStart[p + 1] - first;
  const s = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    let sum = 0;
    for (let k = data.featureStart[first + i]; k < data.featureStart[first + i + 1]; k++) sum += w[data.featureIndex[k]];
    s[i] = sum;
  }
  return s;
}

/* Accuracy and mean log-loss of `w` on `data`. */
export function evaluate(data: Dataset, w: Float64Array): { accuracy: number; logLoss: number } {
  let hits = 0, loss = 0;
  for (let p = 0; p < data.positions; p++) {
    const s = scores(data, w, p);
    let best = 0;
    for (let i = 1; i < s.length; i++) if (s[i] > s[best]) best = i;
    if (best === data.played[p]) hits++;
    const max = s[best];
    let z = 0;
    for (const v of s) z += Math.exp(v - max);
    loss += Math.log(z) - (s[data.played[p]] - max);
  }
  return { accuracy: hits / data.positions, logLoss: loss / data.positions };
}

/* Weights fitted to `data` by Adam over `epochs` passes, reporting on `valid` after each. With a
   `mask`, only the features where it is 1 are fitted; the others stay 0. */
export function train(data: Dataset, valid: Dataset, count: number, opts: ReturnType<typeof options>,
  mask: Uint8Array | null = null): Float64Array {
  const w = new Float64Array(count), m = new Float64Array(count), v = new Float64Array(count);
  const order = Int32Array.from({ length: data.positions }, (_, i) => i);
  let step = 0, seed = 1;
  for (let epoch = 1; epoch <= opts.epochs; epoch++) {
    for (let i = order.length - 1; i > 0; i--) {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      const j = seed % (i + 1);
      [order[i], order[j]] = [order[j], order[i]];
    }
    const started = Date.now();
    for (let b = 0; b < order.length; b += opts.batch) {
      const g = new Float64Array(count);
      const end = Math.min(order.length, b + opts.batch);
      for (let o = b; o < end; o++) {
        const p = order[o];
        const s = scores(data, w, p);
        let max = -Infinity;
        for (const x of s) if (x > max) max = x;
        let z = 0;
        for (let i = 0; i < s.length; i++) z += (s[i] = Math.exp(s[i] - max));
        const first = data.moveStart[p];
        for (let i = 0; i < s.length; i++) {
          const delta = s[i] / z - (i === data.played[p] ? 1 : 0);
          for (let k = data.featureStart[first + i]; k < data.featureStart[first + i + 1]; k++) g[data.featureIndex[k]] += delta;
        }
      }
      step++;
      const n = end - b;
      for (let k = 0; k < count; k++) {
        if (mask && !mask[k]) continue;
        const grad = g[k] / n + opts.l2 * w[k];
        m[k] = 0.9 * m[k] + 0.1 * grad;
        v[k] = 0.999 * v[k] + 0.001 * grad * grad;
        w[k] -= (opts.learningRate * m[k] / (1 - 0.9 ** step)) / (Math.sqrt(v[k] / (1 - 0.999 ** step)) + 1e-8);
      }
    }
    const t = evaluate(data, w), va = evaluate(valid, w);
    console.log(`epoch ${epoch}: train ${(100 * t.accuracy).toFixed(2)}% (loss ${t.logLoss.toFixed(4)}), ` +
      `validation ${(100 * va.accuracy).toFixed(2)}% (loss ${va.logLoss.toFixed(4)}), ${((Date.now() - started) / 1000).toFixed(0)} s`);
  }
  return w;
}

/* Load one dataset under `set`, printing progress every few seconds. */
async function load(name: string, path: string, rate: number, maxGames: number, set: FeatureSet): Promise<Dataset> {
  const started = Date.now();
  let last = 0;
  const data = await loadDataset(path, rate, maxGames, (games, positions) => {
    if (Date.now() - last < 5000) return;
    last = Date.now();
    console.log(`  ${name}: ${games.toLocaleString()} games, ${positions.toLocaleString()} positions, ` +
      `${((Date.now() - started) / 1000).toFixed(0)} s`);
  }, set);
  console.log(`${name}: ${data.positions.toLocaleString()} positions, ${(data.moveStart[data.positions] / data.positions).toFixed(1)} ` +
    `moves and ${(data.featureIndex.length / data.moveStart[data.positions]).toFixed(1)} features a move, ` +
    `${((Date.now() - started) / 1000).toFixed(0)} s`);
  return data;
}

/* Load, train, evaluate and report. */
async function main(argv: readonly string[]): Promise<void> {
  const opts = options(argv);
  const set = SETS[opts.set];
  if (!set) throw new Error(`unknown --features ${opts.set} (want ${Object.keys(SETS).join(" or ")})`);
  console.log(`feature set ${opts.set}: ${set.count} features`);
  const trainData = await load("training", opts.trainFile, opts.rate, opts.maxGames, set);
  const validData = await load("validation", opts.validFile, opts.validRate, opts.maxGames, set);
  const w = train(trainData, validData, set.count, opts);
  writeFileSync(opts.out, JSON.stringify({ set: opts.set, features: set.count,
    names: Array.from({ length: set.count }, (_, k) => set.name(k)),
    weights: Array.from(w, (x) => Math.round(x * 1e4) / 1e4) }) + "\n");
  console.log(`wrote ${opts.out}; every weight, largest first:`);
  for (const k of Array.from(w.keys()).sort((a, b) => w[b] - w[a])) {
    console.log(`  ${set.name(k).padEnd(44)} ${w[k] >= 0 ? "+" : ""}${w[k].toFixed(3)}`);
  }
}

if (import.meta.main) await main(process.argv.slice(2));