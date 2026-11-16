// Move-matching accuracy of a UCI engine on Maia's test games (see testset.ts).
//
//   bun src/variants/engine-human/score.ts --engine maia-1900 [--bin 1900] [--games N] [--workers 8]
//   bun src/variants/engine-human/score.ts --engine pedagog:10 --bin 1900 --games 500
//
// Engines: maia-<rating> (lc0 with that Maia network, "go nodes 1", as in the paper), or
// pedagog:<level> (engine.ts at that Skill_Level, "go depth 100": the level sets its own depth),
// or pedagog:<level>:<path.ts> for another Pedagog source, or stockfish:d<depth> (full-strength
// Stockfish to a fixed depth; the paper's best was depth 15). Every scored position is sent with
// the moves that led to it, from the game's first position, as CSSLab's evaluation script does.
// --games takes that many games spread evenly over the bin (default: all). Prints accuracy with
// a 95 % interval (games resampled, as moves within a game are not independent) and writes
// every prediction to data/score-<engine>-<bin>.tsv: game id, ply, move played, engine move.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { TestGame } from "./testset.ts";
import { lines } from "./testset.ts";

const here = import.meta.dir;
const dataDir = join(here, "data");
const root = resolve(here, "..", "..", "..");

/** How to start an engine and ask it for a move. */
interface EngineSpec {
  readonly name: string;
  readonly cmd: readonly string[];
  readonly setup: readonly string[];
  readonly go: string;
}

/** One scored position and the engine's answer. */
interface Prediction {
  readonly game: number;
  readonly ply: number;
  readonly played: string;
  readonly predicted: string;
}

/* The options of a command line. */
function options(argv: readonly string[]) {
  const value = (name: string, fallback: string) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
  };
  return {
    engine: value("--engine", "maia-1900"),
    bin: Number(value("--bin", "1900")),
    games: Number(value("--games", "0")),
    workers: Number(value("--workers", String(Math.max(1, Math.floor(availableParallelism() / 3))))),
  };
}

/* The engine named `spec`. */
export function engineSpec(spec: string): EngineSpec {
  const maia = /^maia-(\d{4})$/.exec(spec);
  if (maia) {
    const lc0 = process.env.LC0 ?? Bun.which("lc0");
    if (!lc0) throw new Error("lc0 not found (set LC0)");
    const dirs = [process.env.MAIA_DIR, dirname(lc0)].filter((dir): dir is string => Boolean(dir));
    const weights = dirs.map((dir) => join(dir, `${spec}.pb.gz`)).find((path) => existsSync(path));
    if (!weights) throw new Error(`${spec}.pb.gz not found (set MAIA_DIR)`);
    return { name: spec, cmd: [lc0, `--weights=${weights}`, "--backend=blas", "--threads=1"], setup: [], go: "go nodes 1" };
  }
  const pedagog = /^pedagog:(\d+)(?::(.+))?$/.exec(spec);
  if (pedagog) {
    const source = resolve(pedagog[2] ?? join(root, "engine.ts"));
    const variant = pedagog[2] ? `-${basename(source).replace(/\.[jt]s$/, "")}` : "";
    return { name: `pedagog-${pedagog[1]}${variant}`, cmd: [process.execPath, source],
      setup: [`setoption name Skill_Level value ${pedagog[1]}`], go: "go depth 100" };
  }
  const stockfish = /^stockfish:d(\d+)$/.exec(spec);
  if (stockfish) {
    const exe = process.env.STOCKFISH ?? Bun.which("stockfish");
    if (!exe) throw new Error("stockfish not found (set STOCKFISH)");
    return { name: `stockfish-d${stockfish[1]}`, cmd: [exe],
      setup: ["setoption name Threads value 1", "setoption name Hash value 16"], go: `go depth ${stockfish[1]}` };
  }
  const human = /^human:(.+)$/.exec(spec);
  if (human) {
    const weights = resolve(human[1]);
    return { name: `human-${basename(weights).replace(/\.json$/, "")}`, cmd: [process.execPath, join(here, "uci.ts"), "--weights", weights],
      setup: [], go: "go" };
  }
  throw new Error(`unknown engine ${spec} (want maia-<rating>, pedagog:<level>[:<path>], stockfish:d<depth> or human:<weights.json>)`);
}

/** A running UCI engine. */
class Uci {
  readonly proc: ReturnType<typeof Bun.spawn>;
  readonly out: AsyncGenerator<string>;

  /* Start `spec` and wait until it is ready. */
  static async start(spec: EngineSpec): Promise<Uci> {
    const engine = new Uci(spec);
    for (const line of ["uci", ...spec.setup]) engine.send(line);
    await engine.waitFor("readyok", "isready");
    return engine;
  }

  /* An engine process for `spec`, not yet set up. */
  constructor(spec: EngineSpec) {
    this.proc = Bun.spawn([...spec.cmd], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    this.out = lines(this.proc.stdout as ReadableStream<Uint8Array>);
  }

  /* Send one command. */
  send(line: string): void {
    const stdin = this.proc.stdin as import("bun").FileSink;
    stdin.write(line + "\n");
    stdin.flush();
  }

  /* Send `command` and read until a line starting with `prefix`; return that line. */
  async waitFor(prefix: string, command: string): Promise<string> {
    this.send(command);
    for (;;) {
      const { value, done } = await this.out.next();
      if (done) throw new Error(`engine exited while waiting for ${prefix}`);
      if (value.trim().startsWith(prefix)) return value.trim();
    }
  }

  /* The engine's move after `moves` from `fen`. */
  async move(fen: string, moves: readonly string[], go: string): Promise<string> {
    this.send(`position fen ${fen}${moves.length > 0 ? ` moves ${moves.join(" ")}` : ""}`);
    return (await this.waitFor("bestmove", go)).split(/\s+/)[1];
  }

  /* Stop the engine. */
  quit(): void {
    this.send("quit");
    setTimeout(() => this.proc.kill(), 1000).unref();
  }
}

/* `count` games spread evenly over `games` (all of them for 0). */
export function spread<T>(games: readonly T[], count: number): T[] {
  if (count <= 0 || count >= games.length) return [...games];
  return Array.from({ length: count }, (_, i) => games[Math.floor((i * games.length) / count)]);
}

/* Accuracy and its 95 % interval from resampling games: `hits` and `totals` per game. */
export function accuracy(hits: readonly number[], totals: readonly number[], resamples = 1000) {
  const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
  const mean = sum(hits) / sum(totals);
  let seed = 12345;
  const random = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;
  const means = Array.from({ length: resamples }, () => {
    const picks = hits.map(() => Math.floor(random() * hits.length));
    return sum(picks.map((i) => hits[i])) / sum(picks.map((i) => totals[i]));
  }).sort((a, b) => a - b);
  return { mean, lo: means[Math.floor(0.025 * resamples)], hi: means[Math.floor(0.975 * resamples)] };
}

/* A duration such as 45s or 3m09s. */
function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`
    : `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

/* Score the engine and report. */
async function main(argv: readonly string[]): Promise<void> {
  const opts = options(argv);
  const spec = engineSpec(opts.engine);
  const file = join(dataDir, `test-${opts.bin}.jsonl`);
  if (!existsSync(file)) throw new Error(`${file} not found: run testset.ts first`);
  const all = readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as TestGame);
  const games = spread(all, opts.games);
  const jobs = games.flatMap((game, g) => game.scored.map((ply) => ({ g, ply })));
  console.log(`${spec.name} on bin ${opts.bin}: ${games.length.toLocaleString()} of ${all.length.toLocaleString()} games, ` +
    `${jobs.length.toLocaleString()} positions, ${opts.workers} engines`);

  const predictions: Prediction[] = new Array(jobs.length);
  const started = Date.now();
  let next = 0, done = 0, correct = 0, lastPrint = 0;
  const tty = Boolean(process.stdout.isTTY);

  /* Print progress: on a terminal in place every half second, elsewhere every 15 seconds. */
  const report = (force: boolean) => {
    const now = Date.now();
    if (!force && now - lastPrint < (tty ? 500 : 15000)) return;
    lastPrint = now;
    const rate = done / Math.max(0.001, (now - started) / 1000);
    const line = `${done.toLocaleString()}/${jobs.length.toLocaleString()} ` +
      `(${Math.floor((100 * done) / jobs.length)}%) accuracy ${((100 * correct) / Math.max(1, done)).toFixed(2)}% ` +
      `${rate.toFixed(0)}/s ETA ${duration((jobs.length - done) / Math.max(rate, 0.001))}`;
    process.stdout.write(tty ? `\r${line}   ` : `${line}\n`);
  };

  /* One engine working through the shared queue of positions. */
  const worker = async () => {
    const engine = await Uci.start(spec);
    for (let i = next++; i < jobs.length; i = next++) {
      const { g, ply } = jobs[i];
      const game = games[g];
      const predicted = await engine.move(game.fen, game.moves.slice(0, ply), spec.go);
      predictions[i] = { game: g, ply, played: game.moves[ply], predicted };
      done++;
      if (predicted === game.moves[ply]) correct++;
      report(false);
    }
    engine.quit();
  };
  await Promise.all(Array.from({ length: opts.workers }, worker));
  report(true);
  if (tty) process.stdout.write("\n");

  const hits = games.map(() => 0), totals = games.map(() => 0);
  for (const p of predictions) {
    totals[p.game]++;
    if (p.played === p.predicted) hits[p.game]++;
  }
  const { mean, lo, hi } = accuracy(hits, totals);
  const out = join(dataDir, `score-${spec.name}-${opts.bin}.tsv`);
  writeFileSync(out, predictions.map((p) => [games[p.game].id, p.ply, p.played, p.predicted].join("\t") + "\n").join(""));
  console.log(`${spec.name} bin ${opts.bin}: ${(100 * mean).toFixed(2)}% [${(100 * lo).toFixed(2)}, ${(100 * hi).toFixed(2)}] ` +
    `of ${jobs.length.toLocaleString()} moves in ${duration((Date.now() - started) / 1000)} -> ${out}`);
}

if (import.meta.main) await main(process.argv.slice(2));
