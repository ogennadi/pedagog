// Fit the move-feature weights (features.ts) to human moves, and measure them.
//
//   bun src/variants/engine-human/train.ts [--rate 0.035] [--valid-rate 0.05] [--max-games N]
//     [--epochs 4] [--test] [--out data/weights-1900.json]
//
// Samples positions from data/train-1900-2019-10.jsonl and data/valid-1900-2019-11.jsonl (see
// games.ts), fits the weights of a softmax over each position's legal moves by maximum
// likelihood (Adam, mini-batches, a little L2), and reports accuracy (the top-scoring move is the
// one played; ties go to the first move generated, as in the engine) and log-loss on the
// validation positions after every epoch. --test also scores every position of Maia's test bin
// (data/test-1900.jsonl). Writes the weights and prints the strongest of them.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { FEATURES, HANG, featureName, loadDataset } from "./features.ts";
import type { Dataset } from "./features.ts";

const dataDir = join(import.meta.dir, "data");

/* The options of a command line. */
function options(argv: readonly string[]) {
  const value = (name: string, fallback: string) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
  };
  return {
    rate: Number(value("--rate", "0.035")),
    validRate: Number(value("--valid-rate", "0.05")),
    maxGames: Number(value("--max-games", "0")),
    epochs: Number(value("--epochs", "4")),
    batch: Number(value("--batch", "512")),
    learningRate: Number(value("--lr", "0.02")),
    l2: Number(value("--l2", "1e-6")),
    test: argv.includes("--test"),
    out: value("--out", join(dataDir, "weights-1900.json")),
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

/* Weights fitted to `data` by Adam over `epochs` passes, reporting on `valid` after each. */
function train(data: Dataset, valid: Dataset, opts: ReturnType<typeof options>): Float64Array {
  const w = new Float64Array(FEATURES), m = new Float64Array(FEATURES), v = new Float64Array(FEATURES);
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
      const g = new Float64Array(FEATURES);
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
      for (let k = 0; k < FEATURES; k++) {
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

/* Load one dataset, printing progress every few seconds. */
async function load(name: string, path: string, rate: number, maxGames: number): Promise<Dataset> {
  const started = Date.now();
  let last = 0;
  const data = await loadDataset(path, rate, maxGames, (games, positions) => {
    if (Date.now() - last < 5000) return;
    last = Date.now();
    console.log(`  ${name}: ${games.toLocaleString()} games, ${positions.toLocaleString()} positions, ` +
      `${((Date.now() - started) / 1000).toFixed(0)} s`);
  });
  console.log(`${name}: ${data.positions.toLocaleString()} positions, ${(data.moveStart[data.positions] / data.positions).toFixed(1)} ` +
    `moves and ${(data.featureIndex.length / data.moveStart[data.positions]).toFixed(1)} features a move, ` +
    `${((Date.now() - started) / 1000).toFixed(0)} s`);
  return data;
}

/* Load, train, evaluate and report. */
async function main(argv: readonly string[]): Promise<void> {
  const opts = options(argv);
  const trainData = await load("training", join(dataDir, "train-1900-2019-10.jsonl"), opts.rate, opts.maxGames);
  const validData = await load("validation", join(dataDir, "valid-1900-2019-11.jsonl"), opts.validRate, opts.maxGames);
  const w = train(trainData, validData, opts);
  if (opts.test) {
    const testData = await load("test (Maia's 1900 bin)", join(dataDir, "test-1900.jsonl"), 1, 0);
    const t = evaluate(testData, w);
    console.log(`test: ${(100 * t.accuracy).toFixed(2)}% of ${testData.positions.toLocaleString()} positions (loss ${t.logLoss.toFixed(4)})`);
  }
  writeFileSync(opts.out, JSON.stringify({ features: FEATURES, weights: Array.from(w, (x) => Math.round(x * 1e4) / 1e4) }) + "\n");
  const ranked = Array.from(w, (x, k) => ({ k, x })).sort((a, b) => Math.abs(b.x) - Math.abs(a.x)).slice(0, 25);
  console.log(`wrote ${opts.out}; strongest weights:`);
  for (const { k, x } of ranked) console.log(`  ${featureName(k).padEnd(24)} ${x >= 0 ? "+" : ""}${x.toFixed(3)}`);
  console.log("safety, threats and replies:");
  for (let k = HANG; k < FEATURES; k++) console.log(`  ${featureName(k).padEnd(24)} ${w[k] >= 0 ? "+" : ""}${w[k].toFixed(3)}`);
}

if (import.meta.main) await main(process.argv.slice(2));
