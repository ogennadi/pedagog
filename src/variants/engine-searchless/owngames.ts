// Turn a cutechess PGN of the engine's own games into games for sflabel.ts (testset.ts's format),
// scoring the plies where PLAYER is to move: the positions the engine itself reaches, for
// retraining on them (dataset aggregation, "DAgger": a model trained only on other players'
// positions never learns what to do in the ones its own mistakes lead to).
//
//   bun src/variants/engine-searchless/owngames.ts data/own-vs-maia-1900.pgn engine-searchless \
//     --out data/own-games.jsonl [--book-plies 16]
//
// A book FEN that says move 1 (cutechess drops the EPD's counters) gets the move counters of
// --book-plies, so the ply of each position is right for the opening concepts.

import { readFileSync, writeFileSync } from "node:fs";
import { readPgn } from "./analyze.ts";
import type { TestGame } from "./testset.ts";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/* `fen` with move counters that say `plies` plies were played, if it says move 1 and is not the
   start position. */
function withPly(fen: string, plies: number): string {
  const fields = fen.split(" ");
  if (fen === START || (fields[5] ?? "1") !== "1" || plies === 0) return fen;
  const fullmove = 1 + Math.floor(plies / 2);
  return [...fields.slice(0, 4), fields[4] ?? "0", String(fullmove)].join(" ");
}

function main(argv: readonly string[]): void {
  const value = (name: string, fallback: string) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
  };
  const [pgn, player] = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
  if (!pgn || !player) throw new Error("usage: owngames.ts GAMES.pgn PLAYER --out FILE [--book-plies 16]");
  const out = value("--out", "own-games.jsonl"), bookPlies = Number(value("--book-plies", "0"));
  const games = readPgn(readFileSync(pgn, "utf8"));
  let positions = 0;
  const records = games.flatMap((game, g): TestGame[] => {
    const colour = game.white === player ? 0 : game.black === player ? 1 : -1;
    if (colour < 0) return [];
    const toMove = game.fen.split(" ")[1] === "b" ? 1 : 0;
    const scored = game.moves.map((_, ply) => ply).filter((ply) => (toMove + ply) % 2 === colour);
    positions += scored.length;
    return [{ id: `own${g}`, fen: withPly(game.fen, bookPlies), moves: game.moves, scored, elo: [0, 0] }];
  });
  writeFileSync(out, records.map((r) => JSON.stringify(r) + "\n").join(""));
  console.log(`${records.length} games, ${positions.toLocaleString()} positions with ${player} to move -> ${out}`);
}

if (import.meta.main) main(process.argv.slice(2));
