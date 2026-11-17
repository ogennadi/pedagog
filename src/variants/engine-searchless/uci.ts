// A UCI engine that plays a trained weights file (train.ts's or prune.ts's) without search: every
// legal move gets strength.ts's features, and the move whose weights add up to the most is played.
//
//   bun src/variants/engine-searchless/uci.ts --weights data/weights-strength2.json [--book-plies 16]
//     [--value data/value.json --value-mix 2] [--repetition 2]
//     [--oracle-depth D [--oracle-kind material|positional]]
//
// The features are computed by the same code that trained the weights. The ply used by the phase
// concepts comes from the FEN's move counters, so it is right after a book opening (see
// --book-plies). For matches (cutechess) and checks; engine-searchless.ts is the same engine as
// one file, with the 50 weights of weights-prune-replies-top40.json built in.
//
// --value adds value.ts's learned value of the position after each move, times --value-mix, to the
// move's score. --repetition N: a move that draws by rule (repeats a position since the last
// capture or pawn move, the fifty-move rule, too little material) loses DRAW_BIAS when we are N or
// more pawns ahead in material, and gains it when we are N or more behind.
//
// --oracle-depth measures a ceiling and is not searchless: before each move Stockfish scores every
// legal move to depth D (MultiPV, from an empty hash), and the moves it scores ORACLE_MARGIN or
// more below its best are ruled out; the weights choose among the rest. That is the engine with
// perfect knowledge of the blunders visible at depth D. --oracle-kind material rules out only the
// ones whose Stockfish line ends a pawn or more down on the best move's line (or is mated);
// --oracle-kind positional only the others.

import { readFileSync } from "node:fs";
import { chess, materialOf } from "./features.ts";
import { lines } from "./testset.ts";
import { STRENGTH_SET } from "./strength.ts";
import { Uci, engineSpec } from "./score.ts";
import { VALUE_FEATURES, valueFeatures } from "./value.ts";

const set = STRENGTH_SET;
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const ORACLE_MARGIN = 150, MATE = 10000;
const argument = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const bookPlies = Number(argument("--book-plies") ?? 0);
const oracleDepth = Number(argument("--oracle-depth") ?? 0);
const oracleKind = argument("--oracle-kind") ?? "all";
const valueFile = argument("--value");
const valueMix = Number(argument("--value-mix") ?? 1);
const repetition = Number(argument("--repetition") ?? 0);
const DRAW_BIAS = 5;
const valueModel = valueFile ? JSON.parse(readFileSync(valueFile, "utf8")) : null;
const valueWeights: number[] | null = valueModel ? valueModel.weights : null;
if (valueWeights && valueWeights.length !== VALUE_FEATURES) throw new Error(`${valueFile} is not a value.ts model`);

const at = process.argv.indexOf("--weights");
if (at < 0) throw new Error("usage: uci.ts --weights FILE");
const model = JSON.parse(readFileSync(process.argv[at + 1], "utf8"));
if (model.set !== "strength" || model.weights.length !== set.count) throw new Error("weights do not fit the strength features");
const weights: number[] = model.weights;

/* The position and history of a "position" command's arguments. A FEN other than the start
   position whose counters say move 1 came from an opening book without counters, so its ply is
   taken to be `bookPlies` (--book-plies). */
function parsePosition(args: string[]): { pos: any; ply: number; moves: string[] } {
  const movesAt = args.indexOf("moves");
  const moves = movesAt >= 0 ? args.slice(movesAt + 1) : [];
  const fen = args[0] === "fen" ? args.slice(1, movesAt >= 0 ? movesAt : undefined).join(" ") : START_FEN;
  const fields = fen.split(" ");
  const counted = (Number(fields[5] ?? 1) - 1) * 2 + (fields[1] === "b" ? 1 : 0);
  const firstPly = counted === 0 && fields[0] !== START_FEN.split(" ")[0] ? bookPlies : counted;
  let pos = chess.parseFen(fen);
  for (const uci of moves) {
    const move = chess.legalMoves(pos).find((m: number) => chess.moveToUci(m, false) === uci);
    if (move === undefined) throw new Error(`illegal move ${uci}`);
    pos = chess.makeLegalMove(pos, move);
  }
  return { pos, ply: firstPly + moves.length, moves };
}

/** Stockfish's score of one move and its line, which starts with the move. */
interface OracleLine {
  readonly cp: number;
  readonly pv: readonly string[];
}

/* Stockfish's score and line for every legal move of the position that the UCI command
   `position` sets up, searched to `depth` from an empty hash, by UCI move. */
async function oracleScores(oracle: Uci, position: string, depth: number): Promise<Map<string, OracleLine>> {
  oracle.send("ucinewgame");
  oracle.send(position);
  oracle.send(`go depth ${depth}`);
  const scores = new Map<string, OracleLine>();
  for (;;) {
    const { value, done } = await oracle.out.next();
    if (done) throw new Error("Stockfish exited");
    const line = value.trim();
    if (line.startsWith("bestmove")) return scores;
    const m = /^info depth (\d+) .*?score (cp|mate) (-?\d+).* pv (.+)$/.exec(line);
    if (m && Number(m[1]) === depth) {
      const pv = m[4].trim().split(/\s+/);
      scores.set(pv[0], { cp: m[2] === "cp" ? Number(m[3]) : Number(m[3]) > 0 ? MATE : -MATE, pv });
    }
  }
}

/* The material of the side to move in `pos` (pawns, kings left out), minus the other side's, at
   the end of `line` (UCI moves played from `pos`, up to the first one that is not legal). */
function materialAfter(pos: any, line: readonly string[]): number {
  let end = pos;
  for (const uci of line) {
    const move = chess.legalMoves(end).find((m: number) => chess.moveToUci(m, false) === uci);
    if (move === undefined) break;
    end = chess.makeLegalMove(end, move);
  }
  return materialOf(end.board, pos.sideToMove);
}

/* The model's move in `state`, in UCI notation, or "0000" with no legal move. With `oracle`
   lines, only among the moves not ruled out: scored ORACLE_MARGIN or more below the best of them,
   and of the --oracle-kind being ruled out. */
function bestMove(state: { pos: any; ply: number; moves: string[] }, oracle: Map<string, OracleLine> | null): string {
  const square = (uci: string | undefined) => (uci ? chess.parseSquare(uci.slice(2, 4)) : -1);
  const n = state.moves.length;
  const { moves, features } = set.featurize({ pos: state.pos, ply: state.ply, lastTo: square(state.moves[n - 1]),
    ourLastTo: square(state.moves[n - 2]), played: "" });
  if (moves.length === 0) return "0000";
  const top = oracle ? [...oracle.values()].reduce<OracleLine | null>((a, b) => (a === null || b.cp > a.cp ? b : a), null) : null;
  const ruledOut = (uci: string) => {
    if (oracle === null || top === null) return false;
    const line = oracle.get(uci);
    if (line === undefined) return true;
    if (line.cp > top.cp - ORACLE_MARGIN) return false;
    if (oracleKind === "all") return true;
    const material = line.cp <= -MATE || materialAfter(state.pos, top.pv) - materialAfter(state.pos, line.pv) >= 1;
    return oracleKind === "material" ? material : !material;
  };
  let best = -1, bestScore = -Infinity;
  const balance = repetition > 0 ? materialOf(state.pos.board, state.pos.sideToMove) : 0;
  const drawBias = balance >= repetition ? -DRAW_BIAS : balance <= -repetition ? DRAW_BIAS : 0;
  features.forEach((f, i) => {
    if (ruledOut(chess.moveToUci(moves[i], false))) return;
    const after = chess.makeLegalMove(state.pos, moves[i]);
    const value = valueWeights === null ? 0
      : valueFeatures(after, state.pos.sideToMove).reduce((sum, k) => sum + valueWeights[k], 0);
    const draw = repetition > 0 && drawBias !== 0 && chess.isDraw(after) ? drawBias : 0;
    const score = f.reduce((sum, k) => sum + weights[k], 0) + valueMix * value + draw;
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  });
  return chess.moveToUci(moves[best >= 0 ? best : 0], false);
}

const oracle = oracleDepth > 0 ? await Uci.start(engineSpec("stockfish:d1")) : null;
oracle?.send("setoption name MultiPV value 256");
let state = parsePosition(["startpos"]), position = "position startpos";
for await (const line of lines(Bun.stdin.stream())) {
  const words = line.trim().split(/\s+/);
  switch (words[0]) {
    case "uci":
      console.log(`id name Pedagog searchless (${model.set})\nid author Copilot\nuciok`);
      break;
    case "isready":
      console.log("readyok");
      break;
    case "position":
      state = parsePosition(words.slice(1));
      position = words.join(" ");
      break;
    case "go": {
      const scores = oracle ? await oracleScores(oracle, position, oracleDepth) : null;
      console.log(`bestmove ${bestMove(state, scores)}`);
      break;
    }
    case "quit":
      oracle?.quit();
      process.exit(0);
  }
}
