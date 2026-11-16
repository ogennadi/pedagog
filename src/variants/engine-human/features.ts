// Move features for predicting human moves, computed with the engine's own rules.
//
// Each legal move gets a few active features (indices into one weight vector), all seen from the
// mover's side of the board (black's squares are mirrored):
//   TO       phase x moved piece type x destination square     1152
//   FROM     phase x moved piece type x origin square          1152
//   CAPTURE  capturing piece type x captured piece type          36
//   RECAPTURE  captures on the square the opponent just moved to    1
//   CHECK    gives check                                           1
//   PROMO    promotes to knight, bishop, rook or queen             4
//   CASTLE   castles kingside or queenside                         2
//   HANG     the moved piece lands en prise, by piece type         6
//   RESCUE   the moved piece was en prise and no longer is,
//            by piece type                                         6
//   THREAT   the moved piece attacks one enemy piece that is worth
//            more or undefended, by moved piece type               6
//   FORK     ... two or more of them, by moved piece type          6
//   DEFEND   another of our pieces was en prise and no longer is,
//            by the most valuable such piece                       6
//   LEAVE    another of our pieces is en prise after the move,
//            by the most valuable such piece                       6
// Phase: endgame if the material phase (knight and bishop 1, rook 2, queen 4; 24 at the start)
// is 8 or less, else opening before ply 30, else middlegame.
// "En prise": attacked by a cheaper enemy piece, or attacked and not defended (x-rays and pins
// are ignored). A move's score is the sum of its features' weights; a softmax over the legal
// moves gives each one's probability.

import { engine } from "../../tests/engine.js";
import { lines } from "./testset.ts";
import type { TestGame } from "./testset.ts";

const e = engine();
export const chess = e.read(`({ parseFen, generateMoves, makeMove, legalMoves, makeLegalMove, fromSq, toSq,
  promoType, moveType, typeOf, index64, inCheck, parseSquare, moveToUci, FLAG_CASTLE, FLAG_EP })`);

export const TO = 0, FROM = 1152, CAPTURE = 2304, RECAPTURE = 2340, CHECK = 2341, PROMO = 2342, CASTLE = 2346,
  HANG = 2348, RESCUE = 2354, THREAT = 2360, FORK = 2366, DEFEND = 2372, LEAVE = 2378, FEATURES = 2384;
const PHASES = ["opening", "middlegame", "endgame"];
const PHASE_WEIGHT = [0, 0, 1, 1, 2, 4, 0];
const VALUE = [0, 1, 3, 3, 5, 9, 100];
const KNIGHT_STEPS = [-33, -31, -18, -14, 14, 18, 31, 33];
const KING_STEPS = [-17, -16, -15, -1, 1, 15, 16, 17];
const DIAGONALS = [-17, -15, 15, 17];
const LINES = [-16, -1, 1, 16];

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
function enPrise(board: Int8Array, sq: number, value: number, by: number, defender: number): boolean {
  const attacker = cheapestAttacker(board, sq, by);
  return attacker > 0 && (attacker < value || cheapestAttacker(board, sq, defender) === 0);
}

/* The squares that a piece of `type` and colour `colour` on `sq` attacks on `board`. */
function attacks(board: Int8Array, sq: number, type: number, colour: number): number[] {
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
function worstEnPrise(board: Int8Array, us: number, skip: number): number {
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

/* The legal moves of `pos`, reached at `ply`, and each one's active features. `lastTo` is the
   square the opponent's last move went to (0x88), or -1. */
export function moveFeatures(pos: any, lastTo: number, ply: number): { moves: number[]; features: number[][] } {
  const us = pos.sideToMove, them = 1 - us, mirror = us === 1 ? 56 : 0;
  const board: Int8Array = pos.board;
  const phase = phaseOf(pos, ply) * 384;
  const threatenedBefore = worstEnPrise(board, us, -1);
  const moves: number[] = [];
  const features: number[][] = [];
  for (const move of chess.generateMoves(pos) as number[]) {
    const next = chess.makeMove(pos, move);
    if (next === null) continue;
    const from = chess.fromSq(move), to = chess.toSq(move), type = board[from] & 7;
    const f: number[] = [];
    let moved = to;
    if (chess.moveType(move) === chess.FLAG_CASTLE) {
      f.push(CASTLE + (to > from ? 0 : 1));
      moved = next.kingSq[us];
    } else {
      f.push(TO + phase + (type - 1) * 64 + (chess.index64(to) ^ mirror),
        FROM + phase + (type - 1) * 64 + (chess.index64(from) ^ mirror));
      const captured = chess.moveType(move) === chess.FLAG_EP ? 1 : board[to] & 7;
      if (captured !== 0) {
        f.push(CAPTURE + (type - 1) * 6 + (captured - 1));
        if (to === lastTo) f.push(RECAPTURE);
      }
      const promo = chess.promoType(move);
      if (promo !== 0) f.push(PROMO + promo - 2);
      if (type !== 6) {
        const landed = enPrise(next.board, to, VALUE[promo || type], them, us);
        if (landed) f.push(HANG + type - 1);
        else if (enPrise(board, from, VALUE[type], them, us)) f.push(RESCUE + type - 1);
      }
      const value = VALUE[promo || type];
      const targets = attacks(next.board, to, promo || type, us).filter((s) => {
        const piece = next.board[s];
        return piece !== 0 && piece >> 3 === them && (piece & 7) !== 6 &&
          (VALUE[piece & 7] > value || cheapestAttacker(next.board, s, them) === 0);
      }).length;
      if (targets === 1) f.push(THREAT + type - 1);
      else if (targets >= 2) f.push(FORK + type - 1);
    }
    const threatenedAfter = worstEnPrise(next.board, us, moved);
    if (threatenedAfter !== 0) f.push(LEAVE + threatenedAfter - 1);
    else if (threatenedBefore !== 0) {
      const others = worstEnPrise(board, us, from);
      if (others !== 0) f.push(DEFEND + others - 1);
    }
    if (chess.inCheck(next)) f.push(CHECK);
    moves.push(move);
    features.push(f);
  }
  return { moves, features };
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

/* The scored positions of the games in the JSONL file `path` (testset.ts's format), each kept
   with probability `rate` (chosen by a hash, so the same every time), from at most `maxGames`
   games (0: all). `progress` is called now and then with the games read and positions kept. */
export async function loadDataset(path: string, rate: number, maxGames: number,
  progress: (games: number, positions: number) => void): Promise<Dataset> {
  const moveStart = new Growing((n) => new Int32Array(n));
  const featureStart = new Growing((n) => new Int32Array(n));
  const featureIndex = new Growing((n) => new Int16Array(n));
  const played = new Growing((n) => new Int16Array(n));
  let games = 0, skipped = 0;
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
        const { moves, features } = moveFeatures(pos, lastTo, ply);
        const index = moves.findIndex((m) => chess.moveToUci(m, false) === game.moves[ply]);
        if (index < 0) { skipped++; break; }
        moveStart.push(featureStart.length);
        for (const f of features) {
          featureStart.push(featureIndex.length);
          for (const k of f) featureIndex.push(k);
        }
        played.push(index);
      }
      const move = uciMove(pos, game.moves[ply]);
      if (move === null) { skipped++; break; }
      pos = chess.makeLegalMove(pos, move);
    }
    if (games % 2000 === 0) progress(games, played.length);
  }
  progress(games, played.length);
  if (skipped > 0) console.log(`skipped the rest of ${skipped} games with an unreadable move`);
  moveStart.push(featureStart.length);
  featureStart.push(featureIndex.length);
  return { positions: played.length, moveStart: moveStart.done(), featureStart: featureStart.done(),
    featureIndex: featureIndex.done(), played: played.done() };
}

/* A name for feature `k`, such as "TO opening N f3" or "HANG Q". */
export function featureName(k: number): string {
  const piece = (t: number) => " PNBRQK"[t];
  const square = (i: number) => "abcdefgh"[i % 8] + String(Math.floor(i / 8) + 1);
  const table = (name: string, i: number) =>
    `${name} ${PHASES[Math.floor(i / 384)]} ${piece(Math.floor((i % 384) / 64) + 1)} ${square(i % 64)}`;
  if (k < FROM) return table("TO", k - TO);
  if (k < CAPTURE) return table("FROM", k - FROM);
  if (k < RECAPTURE) return `CAPTURE ${piece(Math.floor((k - CAPTURE) / 6) + 1)}x${piece(((k - CAPTURE) % 6) + 1)}`;
  if (k === RECAPTURE) return "RECAPTURE";
  if (k === CHECK) return "CHECK";
  if (k < CASTLE) return `PROMO =${piece(k - PROMO + 2)}`;
  if (k < HANG) return k === CASTLE ? "CASTLE O-O" : "CASTLE O-O-O";
  if (k < RESCUE) return `HANG ${piece(k - HANG + 1)}`;
  if (k < THREAT) return `RESCUE ${piece(k - RESCUE + 1)}`;
  if (k < FORK) return `THREAT by ${piece(k - THREAT + 1)}`;
  if (k < DEFEND) return `FORK by ${piece(k - FORK + 1)}`;
  if (k < LEAVE) return `DEFEND ${piece(k - DEFEND + 1)}`;
  return `LEAVE ${piece(k - LEAVE + 1)}`;
}
