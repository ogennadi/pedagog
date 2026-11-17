// Engine access and training data for the searchless move model.
//
// `chess` is engine.ts's own rules, run in a sandbox (engine-vm.js), so the features see exactly
// the moves the engine generates. The helpers below (VALUE, attacks, en prise, phase) are shared
// by the feature sets: concepts.ts and strength.ts.
//
// samples() reads a games file (testset.ts's format: sflabel.ts's Stockfish-labelled positions)
// and yields the scored positions; loadDataset() turns them into flat arrays of each legal move's
// active features under a FeatureSet, for train.ts and prune.ts.
// "En prise": attacked by a cheaper enemy piece, or attacked and not defended (x-rays and pins
// are ignored).

import { engine } from "./engine-vm.js";
import { lines } from "./testset.ts";
import type { TestGame } from "./testset.ts";

const e = engine();
export const chess = e.read(`({ parseFen, generateMoves, makeMove, legalMoves, makeLegalMove, fromSq, toSq,
  promoType, moveType, inCheck, parseSquare, moveToUci, FLAG_CASTLE, FLAG_EP })`);

const PHASE_WEIGHT = [0, 0, 1, 1, 2, 4, 0];
export const VALUE = [0, 1, 3, 3, 5, 9, 100];
export const KNIGHT_STEPS = [-33, -31, -18, -14, 14, 18, 31, 33];
export const KING_STEPS = [-17, -16, -15, -1, 1, 15, 16, 17];
export const DIAGONALS = [-17, -15, 15, 17];
export const LINES = [-16, -1, 1, 16];

/* The value of the cheapest piece of colour `by` attacking square `sq` of the 0x88 `board`, or 0. */
export function cheapestAttacker(board: Int8Array, sq: number, by: number): number {
  const own = (type: number) => type | (by << 3);
  for (const s of by === 0 ? [sq - 15, sq - 17] : [sq + 15, sq + 17]) {
    if ((s & 0x88) === 0 && board[s] === own(1)) return 1;
  }
  if (KNIGHT_STEPS.some((d) => ((sq + d) & 0x88) === 0 && board[sq + d] === own(2))) return 3;
  let best = 0;
  /* The first piece along each direction of `dirs`, if it is one of `types`. */
  const slide = (dirs: number[], types: number[]) => {
    for (const d of dirs) {
      for (let s = sq + d; (s & 0x88) === 0; s += d) {
        const piece = board[s];
        if (piece === 0) continue;
        if (piece >> 3 === by && types.includes(piece & 7) && (best === 0 || VALUE[piece & 7] < best)) best = VALUE[piece & 7];
        break;
      }
    }
  };
  slide(DIAGONALS, [3, 5]);
  slide(LINES, [4, 5]);
  if (best === 0 && KING_STEPS.some((d) => ((sq + d) & 0x88) === 0 && board[sq + d] === own(6))) best = 100;
  return best;
}

/* Is a piece worth `value` on `sq` en prise to colour `by`, defended by colour `defender`? */
export function enPrise(board: Int8Array, sq: number, value: number, by: number, defender: number): boolean {
  const attacker = cheapestAttacker(board, sq, by);
  return attacker > 0 && (attacker < value || cheapestAttacker(board, sq, defender) === 0);
}

/* The squares that a piece of `type` and colour `colour` on `sq` attacks on `board`. */
export function attacks(board: Int8Array, sq: number, type: number, colour: number): number[] {
  const steps = (dirs: number[]) => dirs.map((d) => sq + d).filter((s) => (s & 0x88) === 0);
  const rays = (dirs: number[]) => dirs.flatMap((d) => {
    const seen: number[] = [];
    for (let s = sq + d; (s & 0x88) === 0; s += d) {
      seen.push(s);
      if (board[s] !== 0) break;
    }
    return seen;
  });
  switch (type) {
    case 1: return steps(colour === 0 ? [15, 17] : [-15, -17]);
    case 2: return steps(KNIGHT_STEPS);
    case 3: return rays(DIAGONALS);
    case 4: return rays(LINES);
    case 5: return rays([...DIAGONALS, ...LINES]);
    default: return steps(KING_STEPS);
  }
}

/* The type of the most valuable piece of colour `us` on `board`, other than its king and the
   piece on `skip`, that is en prise, or 0. */
export function worstEnPrise(board: Int8Array, us: number, skip: number): number {
  let worst = 0;
  for (let sq = 0; sq < 128; sq++) {
    if ((sq & 0x88) !== 0 || sq === skip) continue;
    const piece = board[sq];
    const type = piece & 7;
    if (piece === 0 || piece >> 3 !== us || type === 6 || VALUE[type] <= VALUE[worst]) continue;
    if (enPrise(board, sq, VALUE[type], 1 - us, us)) worst = type;
  }
  return worst;
}

/* The phase of `pos`, reached at `ply`: 0 opening, 1 middlegame, 2 endgame. */
export function phaseOf(pos: any, ply: number): number {
  let material = 0;
  for (let sq = 0; sq < 128; sq++) if ((sq & 0x88) === 0) material += PHASE_WEIGHT[pos.board[sq] & 7];
  return material <= 8 ? 2 : ply < 30 ? 0 : 1;
}

/* The legal move of `pos` written `uci` ("e1g1" for castling), or null. */
export function uciMove(pos: any, uci: string): number | null {
  const from = chess.parseSquare(uci.slice(0, 2));
  for (const move of chess.generateMoves(pos) as number[]) {
    if (chess.fromSq(move) === from && chess.moveToUci(move, false) === uci && chess.makeMove(pos, move) !== null) return move;
  }
  return null;
}

/** Sampled positions as flat arrays: position p's moves are moveStart[p] .. moveStart[p + 1] - 1,
    move m's features are featureStart[m] .. featureStart[m + 1] - 1, played[p] is the index (within
    the position) of the move played. */
export interface Dataset {
  positions: number;
  moveStart: Int32Array;
  featureStart: Int32Array;
  featureIndex: Int16Array;
  played: Int16Array;
}

/** A typed array that grows as values are added. */
class Growing<T extends Int32Array | Int16Array> {
  data: T;
  length = 0;
  constructor(readonly make: (n: number) => T) { this.data = make(1 << 16); }
  push(value: number): void {
    if (this.length === this.data.length) {
      const bigger = this.make(this.data.length * 2);
      bigger.set(this.data);
      this.data = bigger;
    }
    this.data[this.length++] = value;
  }
  done(): T { return this.data.slice(0, this.length) as T; }
}

/* A 32-bit integer hash finaliser, as in engine.ts. */
function mix32(x: number): number {
  const a = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  const b = Math.imul(a ^ (a >>> 16), 0x45d9f3b);
  return (b ^ (b >>> 16)) >>> 0;
}

/** One sampled position: the position, its ply, where the opponent's last move and our own last
    move went (0x88, -1 if none), and the move played. */
export interface Sample {
  readonly pos: any;
  readonly ply: number;
  readonly lastTo: number;
  readonly ourLastTo: number;
  readonly played: string;
}

/* The scored positions of the games in the JSONL file `path` (testset.ts's format), each kept
   with probability `rate` (chosen by a hash, so the same every time), from at most `maxGames`
   games (0: all). `progress` is called now and then with the games read and positions kept. */
export async function* samples(path: string, rate: number, maxGames: number,
  progress: (games: number, positions: number) => void): AsyncGenerator<Sample> {
  let games = 0, kept = 0, skipped = 0;
  for await (const line of lines(Bun.file(path).stream())) {
    if (!line.trim()) continue;
    if (maxGames > 0 && games >= maxGames) break;
    const game = JSON.parse(line) as TestGame;
    const chosen = game.scored.filter((ply) => mix32(Math.imul(games + 1, 0x9e3779b9) ^ ply) % 1_000_000 < rate * 1_000_000);
    games++;
    if (chosen.length === 0) continue;
    let pos = chess.parseFen(game.fen);
    const wanted = new Set(chosen);
    for (let ply = 0; ply <= chosen[chosen.length - 1]; ply++) {
      if (wanted.has(ply)) {
        const lastTo = ply > 0 ? chess.parseSquare(game.moves[ply - 1].slice(2, 4)) : -1;
        const ourLastTo = ply > 1 ? chess.parseSquare(game.moves[ply - 2].slice(2, 4)) : -1;
        kept++;
        yield { pos, ply, lastTo, ourLastTo, played: game.moves[ply] };
      }
      const move = uciMove(pos, game.moves[ply]);
      if (move === null) { skipped++; break; }
      pos = chess.makeLegalMove(pos, move);
    }
    if (games % 2000 === 0) progress(games, kept);
  }
  progress(games, kept);
  if (skipped > 0) console.log(`skipped the rest of ${skipped} games with an unreadable move`);
}

/** A feature set: how many features, their names, and each legal move's active features. */
export interface FeatureSet {
  readonly count: number;
  readonly name: (k: number) => string;
  readonly featurize: (sample: Sample) => { moves: number[]; features: number[][] };
}

/* The sampled positions of `path` (see samples()) with their moves' features under `set`, as
   flat arrays. */
export async function loadDataset(path: string, rate: number, maxGames: number,
  progress: (games: number, positions: number) => void, set: FeatureSet): Promise<Dataset> {
  const moveStart = new Growing((n) => new Int32Array(n));
  const featureStart = new Growing((n) => new Int32Array(n));
  const featureIndex = new Growing((n) => new Int16Array(n));
  const played = new Growing((n) => new Int16Array(n));
  for await (const sample of samples(path, rate, maxGames, progress)) {
    const { moves, features } = set.featurize(sample);
    const index = moves.findIndex((m) => chess.moveToUci(m, false) === sample.played);
    if (index < 0) continue;
    moveStart.push(featureStart.length);
    for (const f of features) {
      featureStart.push(featureIndex.length);
      for (const k of f) featureIndex.push(k);
    }
    played.push(index);
  }
  moveStart.push(featureStart.length);
  featureStart.push(featureIndex.length);
  return { positions: played.length, moveStart: moveStart.done(), featureStart: featureStart.done(),
    featureIndex: featureIndex.done(), played: played.done() };
}