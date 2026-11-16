// Extract Maia's test games (McIlroy-Young et al., KDD 2020, section 4.1) from CSSLab's
// maia-chess-testing-set.csv.bz2, one file per rating bin.
//
//   bun src/variants/engine-human/testset.ts [data/maia-chess-testing-set.csv.bz2]
//
// The CSV holds every ply of about 9,800 December 2019 Lichess games per 100-point bin from
// 1000 to 2500 (both players in the bin), plus some games between bins, which are dropped. As
// in the paper, a move is scored from ply 10 on, unless the mover was short of time: the CSV
// has the clock for only some 6 % of moves, so that means its low_time flag. Whole games are
// kept, because Maia reads the moves before a position as well as the position.
//
// Writes data/test-<bin>.jsonl, one game per line:
//   { id, fen (the position before ply 0), moves (UCI), scored (plies to score), elo [white, black] }
// and prints the games and scored moves per bin. Needs bzip2 (Git for Windows has one).

import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const dataDir = resolve(import.meta.dir, "data");
const FIRST_PLY = 10;

/** One test game. */
export interface TestGame {
  readonly id: string;
  readonly fen: string;
  readonly moves: readonly string[];
  readonly scored: readonly number[];
  readonly elo: readonly [number, number];
}

/* The bzip2 program: BZIP2, bzip2 on PATH, or Git for Windows' copy. */
function bzip2(): string {
  const found = process.env.BZIP2 ?? Bun.which("bzip2") ??
    ["C:\\Program Files\\Git\\usr\\bin\\bzip2.exe"].find((path) => existsSync(path));
  if (!found) throw new Error("bzip2 not found (set BZIP2)");
  return found;
}

/* The lines of `stream`, as they arrive. */
export async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let partial = "";
  for await (const bytes of stream) {
    const parts = (partial + decoder.decode(bytes, { stream: true })).split("\n");
    partial = parts.pop() ?? "";
    yield* parts;
  }
  if (partial) yield partial;
}

/* The bin of a game whose players are rated `white` and `black`: the 100-point range both are
   in, or null if they are in different ranges. */
export function binOf(white: number, black: number): number | null {
  const bin = Math.floor(white / 100) * 100;
  return bin === Math.floor(black / 100) * 100 ? bin : null;
}

/* Is the move made at `ply` scored? `lowTime` is the CSV's low_time flag. */
export function scored(ply: number, lowTime: string): boolean {
  return ply >= FIRST_PLY && lowTime !== "True";
}

/** The rows of one game so far. */
interface Draft {
  readonly id: string;
  readonly fen: string;
  readonly moves: string[];
  readonly scored: number[];
  readonly elo: [number, number];
  broken: boolean;
}

/* Read the CSV at `path`, write the games of each bin and print what was kept. */
async function main(path: string): Promise<void> {
  const proc = Bun.spawn([bzip2(), "-dc", path], { stdout: "pipe", stderr: "inherit" });
  const byBin = new Map<number, string[]>();
  const positions = new Map<number, number>();
  let col: Record<string, number> | null = null;
  let draft: Draft | null = null;
  let mixed = 0, broken = 0;

  /* File the finished `game`. */
  function close(game: Draft | null): void {
    if (game === null) return;
    const bin = binOf(game.elo[0], game.elo[1]);
    if (bin === null) { mixed++; return; }
    if (game.broken) { broken++; return; }
    const record: TestGame = { id: game.id, fen: game.fen, moves: game.moves, scored: game.scored, elo: game.elo };
    const games = byBin.get(bin) ?? [];
    games.push(JSON.stringify(record));
    byBin.set(bin, games);
    positions.set(bin, (positions.get(bin) ?? 0) + game.scored.length);
  }

  for await (const line of lines(proc.stdout)) {
    const fields = line.replace(/\r$/, "").split(",");
    if (col === null) {
      col = Object.fromEntries(fields.map((name, i) => [name, i]));
      continue;
    }
    if (fields.length !== Object.keys(col).length) continue;
    const id = fields[col.game_id], ply = Number(fields[col.move_ply]);
    if (draft === null || draft.id !== id) {
      close(draft);
      draft = { id, fen: fields[col.board], moves: [], scored: [],
        elo: [Number(fields[col.white_elo]), Number(fields[col.black_elo])], broken: ply !== 0 };
    }
    if (ply !== draft.moves.length) draft.broken = true;
    draft.moves.push(fields[col.move]);
    if (scored(ply, fields[col.low_time])) draft.scored.push(ply);
  }
  close(draft);
  if ((await proc.exited) !== 0) throw new Error("bzip2 failed");
  console.log(`dropped ${mixed.toLocaleString()} games between bins and ${broken} with missing plies`);
  for (const bin of [...byBin.keys()].sort((a, b) => a - b)) {
    const file = join(dataDir, `test-${bin}.jsonl`);
    writeFileSync(file, byBin.get(bin)!.map((line) => line + "\n").join(""));
    console.log(`bin ${bin}: ${byBin.get(bin)!.length.toLocaleString()} games, ` +
      `${positions.get(bin)!.toLocaleString()} scored moves`);
  }
}

if (import.meta.main) await main(resolve(process.argv[2] ?? join(dataDir, "maia-chess-testing-set.csv.bz2")));
