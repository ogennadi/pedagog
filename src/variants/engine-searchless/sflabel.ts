// Label positions with Stockfish's best move, for training a model that plays strong moves.
//
//   bun src/variants/engine-searchless/sflabel.ts --in data/train-1900-2019-10.jsonl \
//     --out data/sf-train.jsonl [--rate 0.01] [--depth 12] [--workers 26] [--max-games N]
//
// Samples scored positions from a games file (testset.ts's format, made by games.ts) with the same
// hash as features.ts, asks Stockfish (full strength, one thread, "go depth D") for
// its move in each, with the moves that led there, and writes one record per position in the same
// format: the game's moves up to the position followed by Stockfish's move, scored at that ply.
// train.ts reads such a file like any other (--train-file, rate 1). Prints progress
// with an ETA every 10 seconds.

import { appendFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";
import { Uci, engineSpec } from "./score.ts";
import { lines } from "./testset.ts";
import type { TestGame } from "./testset.ts";

/* The options of a command line. */
function options(argv: readonly string[]) {
  const value = (name: string, fallback: string) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
  };
  return {
    input: resolve(value("--in", join(import.meta.dir, "data", "train-1900-2019-10.jsonl"))),
    out: resolve(value("--out", join(import.meta.dir, "data", "sf-train.jsonl"))),
    rate: Number(value("--rate", "0.01")),
    depth: Number(value("--depth", "12")),
    workers: Number(value("--workers", String(Math.max(1, availableParallelism() - 2)))),
    maxGames: Number(value("--max-games", "0")),
  };
}

/* A 32-bit integer hash finaliser, as in engine.ts. */
function mix32(x: number): number {
  const a = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  const b = Math.imul(a ^ (a >>> 16), 0x45d9f3b);
  return (b ^ (b >>> 16)) >>> 0;
}

/* Label the sampled positions and write them. */
async function main(argv: readonly string[]): Promise<void> {
  const opts = options(argv);
  const jobs: { game: TestGame; ply: number }[] = [];
  let games = 0;
  for await (const line of lines(Bun.file(opts.input).stream())) {
    if (!line.trim()) continue;
    if (opts.maxGames > 0 && games >= opts.maxGames) break;
    const game = JSON.parse(line) as TestGame;
    games++;
    for (const ply of game.scored) {
      if (mix32(Math.imul(games, 0x9e3779b9) ^ ply) % 1_000_000 < opts.rate * 1_000_000) jobs.push({ game, ply });
    }
  }
  console.log(`${jobs.length.toLocaleString()} positions from ${games.toLocaleString()} games; Stockfish depth ` +
    `${opts.depth}, ${opts.workers} engines -> ${opts.out}`);
  writeFileSync(opts.out, "");
  const spec = { ...engineSpec("stockfish:d1"), go: `go depth ${opts.depth}` };
  const started = Date.now();
  let next = 0, done = 0, lastReport = started, pending: string[] = [];

  /* Report progress and write what is pending. */
  const report = (force: boolean) => {
    if (!force && Date.now() - lastReport < 10000) return;
    lastReport = Date.now();
    if (pending.length > 0) appendFileSync(opts.out, pending.join(""));
    pending = [];
    const rate = done / Math.max(0.001, (Date.now() - started) / 1000);
    console.log(`${done.toLocaleString()}/${jobs.length.toLocaleString()} (${Math.floor((100 * done) / jobs.length)}%), ` +
      `${rate.toFixed(0)}/s, ETA ${Math.round((jobs.length - done) / Math.max(rate, 0.001))} s`);
  };

  /* One Stockfish working through the shared queue. */
  const worker = async () => {
    const engine = await Uci.start(spec);
    for (let i = next++; i < jobs.length; i = next++) {
      const { game, ply } = jobs[i];
      const history = game.moves.slice(0, ply);
      const best = await engine.move(game.fen, history, spec.go);
      const record: TestGame = { id: `${game.id}:${ply}`, fen: game.fen, moves: [...history, best], scored: [ply], elo: game.elo };
      pending.push(JSON.stringify(record) + "\n");
      done++;
      report(false);
    }
    engine.quit();
  };
  await Promise.all(Array.from({ length: opts.workers }, worker));
  report(true);
  console.log(`wrote ${done.toLocaleString()} labelled positions in ${Math.round((Date.now() - started) / 1000)} s`);
}

if (import.meta.main) await main(process.argv.slice(2));
