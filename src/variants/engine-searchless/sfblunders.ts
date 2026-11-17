// Label every legal move of sampled positions with how far below the best Stockfish scores it at
// depths 1 and 2: the blunders a static veto should rule out. (uci.ts --oracle-depth showed that
// ruling out the moves 150+ centipawns below the best at depth 1 is worth about 185 Elo against
// Maia-1900, and at depth 2 about 280.)
//
//   bun src/variants/engine-searchless/sfblunders.ts --in data/sf-own.jsonl --out data/blunders-own.jsonl \
//     [--rate 1] [--workers 26] [--max-games N]
//
// Reads games in testset.ts's format and labels each scored position (kept with probability
// --rate, by the same hash as sflabel.ts). Stockfish searches it to depth 2 from an empty hash
// with MultiPV 256, so it reports every legal move at depth 1 and then at depth 2. Writes one
// record per position: the game's moves up to it followed by Stockfish's depth-2 move, "scored":
// [ply], and "loss1" and "loss2", [uci, centipawns below the best] for every legal move, least
// first (mates count as 10,000; capped at 1,000).

import { appendFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";
import { Uci, engineSpec } from "./score.ts";
import { lines } from "./testset.ts";
import type { TestGame } from "./testset.ts";

const MATE = 10000, CAP = 1000;

/* The options of a command line. */
function options(argv: readonly string[]) {
  const value = (name: string, fallback: string) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
  };
  return {
    input: resolve(value("--in", join(import.meta.dir, "data", "sf-own.jsonl"))),
    out: resolve(value("--out", join(import.meta.dir, "data", "blunders-own.jsonl"))),
    rate: Number(value("--rate", "1")),
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

/* Every legal move's loss below the best at depths 1 and 2 of `position` (a UCI "position"
   command), searched from an empty hash. */
async function losses(engine: Uci, position: string): Promise<{ loss1: [string, number][]; loss2: [string, number][] }> {
  engine.send("ucinewgame");
  engine.send(position);
  engine.send("go depth 2");
  const scores: Map<string, number>[] = [new Map(), new Map()];
  for (;;) {
    const { value, done } = await engine.out.next();
    if (done) throw new Error("Stockfish exited");
    const line = value.trim();
    if (line.startsWith("bestmove")) break;
    const m = /^info depth ([12]) .*?score (cp|mate) (-?\d+).* pv (\S+)/.exec(line);
    if (m) scores[Number(m[1]) - 1].set(m[4], m[2] === "cp" ? Number(m[3]) : Number(m[3]) > 0 ? MATE : -MATE);
  }
  const below = (s: Map<string, number>): [string, number][] => {
    const best = Math.max(...s.values());
    return [...s].map(([uci, cp]): [string, number] => [uci, Math.min(CAP, best - cp)]).sort((a, b) => a[1] - b[1]);
  };
  return { loss1: below(scores[0]), loss2: below(scores[1]) };
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
  console.log(`${jobs.length.toLocaleString()} positions from ${games.toLocaleString()} games; Stockfish depth 2, ` +
    `MultiPV 256, ${opts.workers} engines -> ${opts.out}`);
  writeFileSync(opts.out, "");
  const started = Date.now();
  let next = 0, done = 0, lastReport = started, pending: string[] = [];
  const report = (force: boolean) => {
    if (!force && Date.now() - lastReport < 10000) return;
    lastReport = Date.now();
    if (pending.length > 0) appendFileSync(opts.out, pending.join(""));
    pending = [];
    const rate = done / Math.max(0.001, (Date.now() - started) / 1000);
    console.log(`${done.toLocaleString()}/${jobs.length.toLocaleString()} (${Math.floor((100 * done) / jobs.length)}%), ` +
      `${rate.toFixed(0)}/s, ETA ${Math.round((jobs.length - done) / Math.max(rate, 0.001))} s`);
  };
  const worker = async () => {
    const engine = await Uci.start(engineSpec("stockfish:d1"));
    engine.send("setoption name MultiPV value 256");
    for (let i = next++; i < jobs.length; i = next++) {
      const { game, ply } = jobs[i];
      const history = game.moves.slice(0, ply);
      const position = `position fen ${game.fen}${history.length > 0 ? ` moves ${history.join(" ")}` : ""}`;
      const { loss1, loss2 } = await losses(engine, position);
      const record = { id: game.id, fen: game.fen, moves: [...history, loss2[0][0]], scored: [ply], elo: game.elo, loss1, loss2 };
      pending.push(JSON.stringify(record) + "\n");
      done++;
      report(false);
    }
    engine.quit();
  };
  await Promise.all(Array.from({ length: opts.workers }, worker));
  report(true);
  console.log(`wrote ${done.toLocaleString()} positions in ${Math.round((Date.now() - started) / 1000)} s`);
}

if (import.meta.main) await main(process.argv.slice(2));
