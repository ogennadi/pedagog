// A UCI engine that plays a trained move model (train.ts's weights) without further search:
// every legal move gets its features, and the move whose weights add up to the most is played.
//
//   bun src/variants/engine-human/uci.ts --weights data/weights-1900-concepts.json
//
// The feature set is the one named in the weights file (squares, concepts or concepts-search),
// computed by the same code that trained it. The ply used by the phase concepts comes from the
// FEN's move counters, so it is right after a book opening. For matches (cutechess), not the web
// app; engine-human.ts is the web app's copy of the square-table models.

import { readFileSync } from "node:fs";
import { SQUARES, chess } from "./features.ts";
import type { FeatureSet } from "./features.ts";
import { CONCEPT_SEARCH_SET, CONCEPT_SET } from "./concepts.ts";
import { lines } from "./testset.ts";

const SETS: Record<string, FeatureSet> = { squares: SQUARES, concepts: CONCEPT_SET, "concepts-search": CONCEPT_SEARCH_SET };
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const at = process.argv.indexOf("--weights");
if (at < 0) throw new Error("usage: uci.ts --weights FILE");
const model = JSON.parse(readFileSync(process.argv[at + 1], "utf8"));
const set = SETS[model.set ?? "squares"];
if (!set || model.weights.length !== set.count) throw new Error(`weights do not fit feature set ${model.set}`);
const weights: number[] = model.weights;

/* The position and history of a "position" command's arguments. */
function parsePosition(args: string[]): { pos: any; ply: number; moves: string[] } {
  const movesAt = args.indexOf("moves");
  const moves = movesAt >= 0 ? args.slice(movesAt + 1) : [];
  const fen = args[0] === "fen" ? args.slice(1, movesAt >= 0 ? movesAt : undefined).join(" ") : START_FEN;
  const fields = fen.split(" ");
  const firstPly = (Number(fields[5] ?? 1) - 1) * 2 + (fields[1] === "b" ? 1 : 0);
  let pos = chess.parseFen(fen);
  for (const uci of moves) {
    const move = chess.legalMoves(pos).find((m: number) => chess.moveToUci(m, false) === uci);
    if (move === undefined) throw new Error(`illegal move ${uci}`);
    pos = chess.makeLegalMove(pos, move);
  }
  return { pos, ply: firstPly + moves.length, moves };
}

/* The model's move in `state`, in UCI notation, or "0000" with no legal move. */
function bestMove(state: { pos: any; ply: number; moves: string[] }): string {
  const square = (uci: string | undefined) => (uci ? chess.parseSquare(uci.slice(2, 4)) : -1);
  const n = state.moves.length;
  const { moves, features } = set.featurize({ pos: state.pos, ply: state.ply, lastTo: square(state.moves[n - 1]),
    ourLastTo: square(state.moves[n - 2]), played: "" });
  if (moves.length === 0) return "0000";
  let best = 0, bestScore = -Infinity;
  features.forEach((f, i) => {
    const score = f.reduce((sum, k) => sum + weights[k], 0);
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  });
  return chess.moveToUci(moves[best], false);
}

let state = parsePosition(["startpos"]);
for await (const line of lines(Bun.stdin.stream())) {
  const words = line.trim().split(/\s+/);
  switch (words[0]) {
    case "uci":
      console.log(`id name Pedagog human (${model.set ?? "squares"})\nid author Copilot\nuciok`);
      break;
    case "isready":
      console.log("readyok");
      break;
    case "position":
      state = parsePosition(words.slice(1));
      break;
    case "go":
      console.log(`bestmove ${bestMove(state)}`);
      break;
    case "quit":
      process.exit(0);
  }
}
