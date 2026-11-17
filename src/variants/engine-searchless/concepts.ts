// Named move concepts: yes/no questions about one legal move whose weights read as rules of
// thumb. strength.ts adds its reply checks to them.
//
// Every concept is a yes/no question about one legal move, answered from the mover's side of the
// board. CONCEPTS lists them. SEE is a static
// exchange evaluation: the material, in pawns, that the sequence of captures on one square wins,
// each side capturing with its cheapest piece and stopping when that pays.

import {
  DIAGONALS, KING_STEPS, KNIGHT_STEPS, LINES, VALUE, attacks, chess, enPrise, phaseOf, worstEnPrise,
} from "./features.ts";
import type { Sample } from "./features.ts";

/** Everything a concept may look at: one legal move of a position. */
export interface MoveContext {
  readonly pos: any;
  readonly after: any;
  readonly board: Int8Array;
  readonly next: Int8Array;
  readonly from: number;
  readonly to: number;
  readonly type: number;          // moved piece type, 1..6
  readonly piece: number;         // its type after the move (promotion)
  readonly captured: number;      // captured piece type, or 0
  readonly castle: boolean;
  readonly us: number;
  readonly them: number;
  readonly ply: number;
  readonly phase: number;         // 0 opening, 1 middlegame, 2 endgame
  readonly lastTo: number;        // where the opponent's last move went, or -1
  readonly ourLastTo: number;     // where our last move went, or -1
  readonly enemyKing: number;     // after the move
  readonly ownKing: number;       // after the move
  readonly see: number;           // SEE of the move's destination, in pawns
  readonly enemyEnPriseBefore: number;
  readonly enemyEnPriseAfter: number;
  readonly threats: number;       // enemy pieces the moved piece attacks that are worth more or loose
  readonly mobility: number;      // squares the moved piece attacks after the move, minus before
  readonly leftEnPrise: number;   // type of our worst other piece en prise after the move, or 0
  readonly otherEnPriseBefore: number;  // ... before the move (not the moved piece), or 0
  readonly movedWasEnPrise: boolean;
}

/* Chebyshev distance between two 0x88 squares. */
export const distance = (a: number, b: number) => Math.max(Math.abs((a & 7) - (b & 7)), Math.abs((a >> 4) - (b >> 4)));
/* The rank of `sq` from the side of colour `colour`, 0..7. */
export const rankFor = (sq: number, colour: number) => (colour === 0 ? sq >> 4 : 7 - (sq >> 4));
/* How far `sq` is from the centre: 0 (d4, d5, e4, e5) to 3 (the edge). */
const offCentre = (sq: number) => Math.max(Math.abs((sq & 7) - 3.5), Math.abs((sq >> 4) - 3.5)) - 0.5;

/* The first occupied square from `sq` (not included) in direction `d`, or -1. */
export function firstPiece(board: Int8Array, sq: number, d: number): number {
  for (let s = sq + d; (s & 0x88) === 0; s += d) if (board[s] !== 0) return s;
  return -1;
}

/* The square of the cheapest piece of colour `by` attacking `sq`, or -1. */
export function cheapestAttackerSquare(board: Int8Array, sq: number, by: number): number {
  const own = (type: number) => type | (by << 3);
  for (const s of by === 0 ? [sq - 15, sq - 17] : [sq + 15, sq + 17]) {
    if ((s & 0x88) === 0 && board[s] === own(1)) return s;
  }
  for (const d of KNIGHT_STEPS) if (((sq + d) & 0x88) === 0 && board[sq + d] === own(2)) return sq + d;
  let best = -1;
  for (const [dirs, types] of [[DIAGONALS, [3, 5]], [LINES, [4, 5]]] as const) {
    for (const d of dirs) {
      const s = firstPiece(board, sq, d);
      if (s >= 0 && board[s] >> 3 === by && (types as readonly number[]).includes(board[s] & 7) &&
        (best < 0 || VALUE[board[s] & 7] < VALUE[board[best] & 7])) best = s;
    }
  }
  if (best >= 0) return best;
  for (const d of KING_STEPS) if (((sq + d) & 0x88) === 0 && board[sq + d] === own(6)) return sq + d;
  return -1;
}

/* SEE of moving the piece on `from` (becoming a `piece`) to `to` on `board`: the material won,
   in pawns, once the captures on `to` are over. `epVictim` is the square of a pawn taken en
   passant, or -1. */
export function see(board: Int8Array, from: number, to: number, piece: number, epVictim: number): number {
  const b = board.slice();
  const gains: number[] = [epVictim >= 0 ? 1 : b[to] === 0 ? 0 : VALUE[b[to] & 7]];
  if (epVictim >= 0) b[epVictim] = 0;
  let side = 1 - (b[from] >> 3);
  let onSquare = VALUE[piece];
  b[to] = piece | ((1 - side) << 3);
  b[from] = 0;
  for (;;) {
    const s = cheapestAttackerSquare(b, to, side);
    if (s < 0 || onSquare === 100) break;
    gains.push(onSquare - gains[gains.length - 1]);
    onSquare = VALUE[b[s] & 7];
    b[to] = b[s];
    b[s] = 0;
    side = 1 - side;
  }
  for (let d = gains.length - 1; d > 0; d--) gains[d - 1] = -Math.max(-gains[d - 1], gains[d]);
  return gains[0];
}

/* How many pieces of colour `colour` (not kings) are en prise on `board`. */
export function enPriseCount(board: Int8Array, colour: number): number {
  let count = 0;
  for (let s = 0; s < 128; s++) {
    const p = board[s];
    if ((s & 0x88) === 0 && p !== 0 && p >> 3 === colour && (p & 7) !== 6 &&
      enPrise(board, s, VALUE[p & 7], 1 - colour, colour)) count++;
  }
  return count;
}

/* How many pieces of colour `by` attack `sq`. */
function attackerCount(board: Int8Array, sq: number, by: number): number {
  let count = 0;
  for (let s = 0; s < 128; s++) {
    if ((s & 0x88) === 0 && board[s] !== 0 && board[s] >> 3 === by && attacks(board, s, board[s] & 7, by).includes(sq)) count++;
  }
  return count;
}

/* Do the moved slider's lines from `to` hit an enemy piece `a` and then an enemy piece `b` such
   that `ok(a, b)`? */
export function throughLine(m: MoveContext, ok: (a: number, b: number) => boolean): boolean {
  const dirs = m.piece === 3 ? DIAGONALS : m.piece === 4 ? LINES : m.piece === 5 ? [...DIAGONALS, ...LINES] : [];
  return dirs.some((d) => {
    const a = firstPiece(m.next, m.to, d);
    if (a < 0 || m.next[a] >> 3 !== m.them) return false;
    const b = firstPiece(m.next, a, d);
    return b >= 0 && m.next[b] >> 3 === m.them && ok(m.next[a] & 7, m.next[b] & 7);
  });
}

/* Does moving off `from` open a line of one of our sliders onto an enemy piece worth more than
   it, or undefended? */
export function discoveredAttack(m: MoveContext): boolean {
  return [...DIAGONALS, ...LINES].some((d) => {
    const back = firstPiece(m.next, m.from, -d);
    if (back < 0 || m.next[back] >> 3 !== m.us) return false;
    const slider = m.next[back] & 7;
    if (!(slider === 5 || (slider === 3 && DIAGONALS.includes(d)) || (slider === 4 && LINES.includes(d)))) return false;
    const target = firstPiece(m.next, m.from, d);
    if (target < 0 || target === m.to || m.next[target] >> 3 !== m.them || (m.next[target] & 7) === 6) return false;
    return VALUE[m.next[target] & 7] > VALUE[slider] || cheapestAttackerSquare(m.next, target, m.them) < 0;
  });
}

/* Is there an enemy pawn on a file next to `sq` (or its own file, with `sameFile`), ahead of it
   for colour `us`? */
export function enemyPawnAhead(board: Int8Array, sq: number, us: number, sameFile: boolean): boolean {
  for (let s = 0; s < 128; s++) {
    if ((s & 0x88) !== 0 || board[s] !== (1 | ((1 - us) << 3))) continue;
    const df = Math.abs((s & 7) - (sq & 7));
    if ((df === 1 || (sameFile && df === 0)) && rankFor(s, us) > rankFor(sq, us)) return true;
  }
  return false;
}

/* Is there a pawn of colour `colour` on file `file` of `board`, other than on `skip`? */
function pawnOnFile(board: Int8Array, file: number, colour: number, skip = -1): boolean {
  if (file < 0 || file > 7) return false;
  for (let r = 0; r < 8; r++) {
    const s = r * 16 + file;
    if (s !== skip && board[s] === (1 | (colour << 3))) return true;
  }
  return false;
}

/* How many squares the moved piece attacks after the move, minus before. */
function mobilityGain(next: Int8Array, board: Int8Array, from: number, to: number, piece: number, type: number, us: number): number {
  return attacks(next, to, piece, us).length - attacks(board, from, type, us).length;
}
/* Is the king of colour `colour` castled, on its back rank and on a wing? */
const castled = (king: number, colour: number) => rankFor(king, colour) === 0 && ((king & 7) <= 2 || (king & 7) >= 5);
const quiet = (m: MoveContext) => !m.castle && m.captured === 0;
const isPawn = (m: MoveContext) => !m.castle && m.type === 1;
const isPiece = (m: MoveContext) => !m.castle && m.type !== 1 && m.type !== 6;
const PIECES = ["P", "N", "B", "R", "Q"];

/** One concept: a name and a yes/no question about a move. */
export interface Concept {
  readonly name: string;
  readonly test: (m: MoveContext) => boolean;
}

/* The concepts, grouped as in the README. */
export const CONCEPTS: readonly Concept[] = [
  // Material and tactics
  { name: "capture wins 3+ (SEE)", test: (m) => m.captured !== 0 && m.see >= 3 },
  { name: "capture wins 1-2 (SEE)", test: (m) => m.captured !== 0 && m.see >= 1 && m.see < 3 },
  { name: "capture is even (SEE)", test: (m) => m.captured !== 0 && m.see === 0 },
  { name: "capture loses 1-2 (SEE)", test: (m) => m.captured !== 0 && m.see <= -1 && m.see > -3 },
  { name: "capture loses 3+ (SEE)", test: (m) => m.captured !== 0 && m.see <= -3 },
  ...PIECES.map((p, i) => ({ name: `quiet move drops the ${p} (SEE < 0)`, test: (m: MoveContext) => quiet(m) && m.type === i + 1 && m.see < 0 })),
  ...PIECES.map((p, i) => ({ name: `leaves another ${p} en prise`, test: (m: MoveContext) => m.leftEnPrise === i + 1 })),
  ...PIECES.map((p, i) => ({ name: `rescues the ${p}`, test: (m: MoveContext) => !m.castle && m.type === i + 1 &&
    m.movedWasEnPrise && m.see >= 0 })),
  ...PIECES.map((p, i) => ({ name: `defends another ${p}`, test: (m: MoveContext) =>
    m.leftEnPrise === 0 && m.otherEnPriseBefore === i + 1 })),
  { name: "pawn threatens a piece", test: (m) => isPawn(m) && m.threats === 1 },
  { name: "minor piece threatens a piece", test: (m) => (m.type === 2 || m.type === 3) && !m.castle && m.threats === 1 },
  { name: "rook, queen or king threatens a piece", test: (m) => m.type >= 4 && !m.castle && m.threats === 1 },
  { name: "fork (threatens two or more)", test: (m) => !m.castle && m.threats >= 2 },
  { name: "gives check", test: (m) => chess.inCheck(m.after) },
  { name: "gives mate", test: (m) => chess.inCheck(m.after) && chess.legalMoves(m.after).length === 0 },
  { name: "double check", test: (m) => chess.inCheck(m.after) && attackerCount(m.next, m.enemyKing, m.us) >= 2 },
  { name: "discovered check", test: (m) => !m.castle && chess.inCheck(m.after) && !attacks(m.next, m.to, m.piece, m.us).includes(m.enemyKing) },
  { name: "discovered attack", test: (m) => !m.castle && discoveredAttack(m) },
  { name: "absolute pin", test: (m) => !m.castle && throughLine(m, (a, b) => a !== 6 && b === 6) },
  { name: "relative pin", test: (m) => !m.castle && throughLine(m, (a, b) => a !== 6 && b !== 6 && VALUE[b] > VALUE[a]) },
  { name: "skewer", test: (m) => !m.castle && throughLine(m, (a, b) => b !== 6 && (a === 6 || VALUE[a] > VALUE[b])) },
  { name: "recapture (takes on the last move's square)", test: (m) => m.captured !== 0 && m.to === m.lastTo },
  { name: "takes a loose piece", test: (m) => m.captured !== 0 && cheapestAttackerSquare(m.board, m.to, m.them) < 0 },
  { name: "promotes to a queen", test: (m) => !m.castle && m.piece === 5 && m.type === 1 },
  { name: "underpromotes", test: (m) => !m.castle && m.type === 1 && m.piece !== 1 && m.piece !== 5 },
  { name: "creates a new enemy target", test: (m) => m.enemyEnPriseAfter > m.enemyEnPriseBefore },
  // King safety
  { name: "castles kingside", test: (m) => m.castle && m.to > m.from },
  { name: "castles queenside", test: (m) => m.castle && m.to < m.from },
  { name: "gives up castling rights", test: (m) => !m.castle &&
    (m.pos.castlingRights & (3 << (2 * m.us))) !== (m.after.castlingRights & (3 << (2 * m.us))) },
  { name: "pawn move in front of our castled king", test: (m) => isPawn(m) && castled(m.ownKing, m.us) &&
    Math.abs((m.from & 7) - (m.ownKing & 7)) <= 1 },
  { name: "king move before the endgame", test: (m) => !m.castle && m.type === 6 && m.phase < 2 },
  { name: "king move in the endgame", test: (m) => !m.castle && m.type === 6 && m.phase === 2 },
  { name: "attacks the enemy king's zone", test: (m) => !m.castle && m.type !== 6 &&
    KING_STEPS.some((d) => attacks(m.next, m.to, m.piece, m.us).includes(m.enemyKing + d)) &&
    !KING_STEPS.some((d) => attacks(m.board, m.from, m.type, m.us).includes(m.pos.kingSq[m.them] + d)) },
  { name: "towards the enemy king", test: (m) => isPiece(m) && distance(m.to, m.enemyKing) < distance(m.from, m.enemyKing) },
  // Development
  { name: "develops a knight or bishop", test: (m) => (m.type === 2 || m.type === 3) && !m.castle && rankFor(m.from, m.us) === 0 },
  { name: "queen move before ply 20", test: (m) => !m.castle && m.type === 5 && m.ply < 20 },
  { name: "moves the same piece again (opening)", test: (m) => m.phase === 0 && !m.castle && m.from === m.ourLastTo },
  { name: "rook to an open file", test: (m) => !m.castle && m.type === 4 && (m.to & 7) !== (m.from & 7) &&
    !pawnOnFile(m.next, m.to & 7, m.us) && !pawnOnFile(m.next, m.to & 7, m.them) },
  { name: "rook to a half-open file", test: (m) => !m.castle && m.type === 4 && (m.to & 7) !== (m.from & 7) &&
    !pawnOnFile(m.next, m.to & 7, m.us) && pawnOnFile(m.next, m.to & 7, m.them) },
  // Activity
  { name: "more central", test: (m) => isPiece(m) && offCentre(m.to) < offCentre(m.from) },
  { name: "less central", test: (m) => isPiece(m) && offCentre(m.to) > offCentre(m.from) },
  { name: "mobility +3 or more", test: (m) => isPiece(m) && m.mobility >= 3 },
  { name: "mobility -3 or less", test: (m) => isPiece(m) && m.mobility <= -3 },
  { name: "piece advances", test: (m) => isPiece(m) && rankFor(m.to, m.us) > rankFor(m.from, m.us) },
  { name: "piece retreats", test: (m) => isPiece(m) && rankFor(m.to, m.us) < rankFor(m.from, m.us) },
  { name: "outpost (knight or bishop)", test: (m) => (m.type === 2 || m.type === 3) && quiet(m) &&
    attacks(m.next, m.to, 1, m.them).some((s) => m.next[s] === (1 | (m.us << 3))) && !enemyPawnAhead(m.next, m.to, m.us, false) },
  { name: "long move (4+ squares)", test: (m) => !m.castle && distance(m.from, m.to) >= 4 },
  // Pawns
  ...[2, 3, 4, 5, 6].map((r) => ({ name: `pawn to rank ${r + 1}`, test: (m: MoveContext) => isPawn(m) && rankFor(m.to, m.us) === r })),
  { name: "double pawn push", test: (m) => isPawn(m) && Math.abs((m.to >> 4) - (m.from >> 4)) === 2 },
  { name: "creates a passed pawn", test: (m) => isPawn(m) && !enemyPawnAhead(m.next, m.to, m.us, true) &&
    enemyPawnAhead(m.board, m.from, m.us, true) },
  { name: "pushes a passed pawn", test: (m) => isPawn(m) && !enemyPawnAhead(m.board, m.from, m.us, true) },
  { name: "creates doubled pawns", test: (m) => isPawn(m) && (m.to & 7) !== (m.from & 7) && pawnOnFile(m.next, m.to & 7, m.us, m.to) },
  { name: "creates an isolated pawn", test: (m) => isPawn(m) &&
    !pawnOnFile(m.next, (m.to & 7) - 1, m.us) && !pawnOnFile(m.next, (m.to & 7) + 1, m.us) &&
    (pawnOnFile(m.board, (m.from & 7) - 1, m.us) || pawnOnFile(m.board, (m.from & 7) + 1, m.us)) },
  { name: "pawn break (attacks a pawn)", test: (m) => isPawn(m) && m.captured === 0 &&
    attacks(m.next, m.to, 1, m.us).some((s) => m.next[s] === (1 | (m.them << 3))) },
  { name: "pawn captures towards the centre", test: (m) => isPawn(m) && m.captured !== 0 &&
    Math.abs((m.to & 7) - 3.5) < Math.abs((m.from & 7) - 3.5) },
  { name: "pawn storm (towards the enemy king)", test: (m) => isPawn(m) && m.captured === 0 &&
    Math.abs((m.to & 7) - (m.enemyKing & 7)) <= 1 && Math.abs((m.to & 7) - (m.ownKing & 7)) >= 2 },
  // Replies
  { name: "next to the opponent's last move", test: (m) => m.lastTo >= 0 && m.captured === 0 && distance(m.to, m.lastTo) <= 1 },
  { name: "moves the piece the last move attacked", test: (m) => !m.castle && m.lastTo >= 0 && m.board[m.lastTo] !== 0 &&
    attacks(m.board, m.lastTo, m.board[m.lastTo] & 7, m.them).includes(m.from) },
  { name: "out of check: king move", test: (m) => chess.inCheck(m.pos) && m.type === 6 && m.captured === 0 },
  { name: "out of check: capture", test: (m) => chess.inCheck(m.pos) && m.captured !== 0 },
  { name: "out of check: block", test: (m) => chess.inCheck(m.pos) && m.type !== 6 && m.captured === 0 },
];

/* How many enemy pieces (not the king) a `piece` of colour `us` on `to` attacks on `next` that
   are worth more than it or undefended. */
function threatCount(next: Int8Array, to: number, piece: number, us: number): number {
  return attacks(next, to, piece, us).filter((s) => {
    const p = next[s];
    return p !== 0 && p >> 3 === 1 - us && (p & 7) !== 6 &&
      (VALUE[p & 7] > VALUE[piece] || cheapestAttackerSquare(next, s, 1 - us) < 0);
  }).length;
}

/* Our pieces (not the king) en prise on `board`, most valuable first: [square, type] pairs. */
function enPriseList(board: Int8Array, us: number): [number, number][] {
  const list: [number, number][] = [];
  for (let s = 0; s < 128; s++) {
    const p = board[s];
    if ((s & 0x88) === 0 && p !== 0 && p >> 3 === us && (p & 7) !== 6 && enPrise(board, s, VALUE[p & 7], 1 - us, us)) {
      list.push([s, p & 7]);
    }
  }
  return list.sort((a, b) => VALUE[b[1]] - VALUE[a[1]]);
}

/* The legal moves of the sample's position and each one's active concepts. */
export function conceptFeatures(sample: Sample): { moves: number[]; features: number[][] } {
  const pos = sample.pos, us = pos.sideToMove, them = 1 - us, board: Int8Array = pos.board;
  const phase = phaseOf(pos, sample.ply);
  const enemyEnPriseBefore = enPriseCount(board, them);
  const ownEnPrise = enPriseList(board, us);
  const moves: number[] = [], features: number[][] = [];
  for (const move of chess.legalMoves(pos) as number[]) {
    const after = chess.makeLegalMove(pos, move);
    const from = chess.fromSq(move), to = chess.toSq(move), type = board[from] & 7;
    const castle = chess.moveType(move) === chess.FLAG_CASTLE;
    const ep = chess.moveType(move) === chess.FLAG_EP;
    const captured = castle ? 0 : ep ? 1 : board[to] & 7;
    const piece = chess.promoType(move) || type;
    const next: Int8Array = after.board;
    const moved = castle ? after.kingSq[us] : to;
    const m: MoveContext = { pos, after, board, next, from, to, type, piece, captured, castle, us, them,
      ply: sample.ply, phase, lastTo: sample.lastTo, ourLastTo: sample.ourLastTo, enemyKing: after.kingSq[them],
      ownKing: after.kingSq[us], see: castle ? 0 : see(board, from, to, piece, ep ? to + (us === 0 ? -16 : 16) : -1),
      enemyEnPriseBefore, enemyEnPriseAfter: enPriseCount(next, them),
      threats: castle ? 0 : threatCount(next, to, piece, us),
      mobility: castle || type === 1 || type === 6 ? 0 : mobilityGain(next, board, from, to, piece, type, us),
      leftEnPrise: worstEnPrise(next, us, moved),
      otherEnPriseBefore: ownEnPrise.find(([s]) => s !== from)?.[1] ?? 0,
      movedWasEnPrise: ownEnPrise.some(([s]) => s === from) };
    features.push(CONCEPTS.flatMap((c, k) => (c.test(m) ? [k] : [])));
    moves.push(move);
  }
  return { moves, features };
}
