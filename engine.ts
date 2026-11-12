/*
================================================================
                      P E D A G O G
================================================================
   A single-file UCI chess engine in TypeScript, written to be
   read from top to bottom like a short book on chess programming.
   The most interesting part, the search, comes first; the
   plumbing that makes it a program comes last.

   Runs in Bun, which runs TypeScript directly (`bun engine.ts`), or
   in a browser Web Worker. Browsers cannot run TypeScript, so the
   web app gets engine.js, this file with its types removed
   (tools/engine-js.js does that for `bun run web` and
   `bun run build`). Type-check it with `bun run check`.

   Supports standard chess and Chess960 (UCI_Chess960),
   a deterministic Skill_Seed (as in Gaia), and the Hash/Threads
   options OpenBench expects. Search uses one thread; a separate
   main thread handles input and interruption, not parallel search.

   It is deliberately a base engine: iterative deepening, alpha-beta
   with simple move ordering and a short quiescence search, and a
   plain piece-square evaluation, and nothing else. It has two
   playing styles (the Aggressive option): an attacking one, on by
   default, that gathers its pieces around the enemy king, gives up
   material readily and likes to give check; and a plain reference
   style. Skill_Level picks one of ten levels, from a random mover to
   about Maia-1900 (1755 on the Lichess classical scale), weakened
   the way Gaia does it: the engine looks less far ahead, misjudges
   some positions on purpose, and overlooks some moves entirely. Each
   style has its own ladder, so a level is equally strong in either
   (see docs/COLOPHON.md for the measurements).

   HOW TO READ IT
   Every function names what it needs in its parameters and hands
   back what it found as its return value, so each one can be read
   on its own page. No function changes anything it is given. Only
   two kinds of object change after they are made, and each belongs
   to the one call that creates it: a Search (think()'s node count
   and stop flag) and a Draft (makeMove()'s scratch copy of the
   board). The only `let`s outside a function belong to the I/O code
   at the very end.

   Positions (S4) are values too: makeMove() returns a new position
   rather than changing the old one. That costs some speed, since
   every move copies a board, but nothing ever has to be undone.

   FOR PORTERS
   The file is written so that it translates line by line into most
   languages:
   - Every number is an integer. Where a division can meet a
     negative number it rounds toward zero (Math.trunc), as C, Go,
     Java, Rust and most CPUs do; Python's // and Haskell's `div`
     round down instead, so use `quot` / a truncating helper there.
   - Hashing is unsigned 32-bit arithmetic: Math.imul is a 32-bit
     multiply that wraps, `>>>` is the logical shift and `>>> 0`
     reads the bits as unsigned. Zobrist keys are combined with XOR.
   - The board layout (0x88) is reached only through the helpers in
     S0 (fileOf, rankOf, onBoard, index64, ...), so a port may use
     another layout and still produce the same keys and choices.
   - Captures are sorted with an explicit tie-break, so any sort
     algorithm, stable or not, gives the same order.
   - The changing state of a search is one small object (Search),
     not variables captured by nested functions.
================================================================

   TABLE OF CONTENTS
   -----------------
   S0  Constants           Pieces, squares, board layout, moves
   S1  Search              Iterative deepening, alpha-beta, ordering
   S2  Skill Levels        Styles, depth ceiling, blunders, vision
   S3  Evaluation          A naive piece-square evaluation, styled
   S4  Chess Rules         Position, copy/make, draws, moves, attacks
   S5  Zobrist Hashing     Position keys for repetition detection
   S6  UCI                 Sessions, options, bench, perft, I/O
================================================================
*/

"use strict";

/* ================================================================
   S0  CONSTANTS
   ================================================================

   Colours are 0 and 1. Piece types are 1..6. A piece on the board
   is  makePiece(pieceType, colour) = pieceType | colour << 3,  so
   white pieces are 1..6, black 9..14; typeOf() and colourOf() take
   them apart again.

   Squares use the 0x88 layout: square = rank * 16 + file. Only
   the low nibble (file) and bits 4..6 (rank) are meaningful, so a
   square is off the board exactly when  (sq & 0x88) !== 0.  This
   makes "is this square on the board?" (onBoard) a single AND, and
   it stays true for a square reached by stepping off any edge.

     8 | 112 113 114 115 116 117 118 119
     7 |  96  97  98  99 100 101 102 103
     6 |  80  81  82  83  84  85  86  87
     5 |  64  65  66  67  68  69  70  71
     4 |  48  49  50  51  52  53  54  55
     3 |  32  33  34  35  36  37  38  39
     2 |  16  17  18  19  20  21  22  23
     1 |   0   1   2   3   4   5   6   7
       +--------------------------------
           a   b   c   d   e   f   g   h

   Everything that depends on the layout is in the helpers below.
   Tables that should not depend on it (Zobrist keys, piece-square
   tables, king distances) are indexed by index64(sq): 0 = a1 ...
   63 = h8.

   A move is one integer:

     bits  0.. 6   from square
     bits  7..13   to square (for castling: the rook's square)
     bits 14..16   promotion piece type (0 = none)
     bits 17..18   move type: 0 = normal, 1 = en passant, 2 = castling

   Castling is encoded as "king captures own rook", which is the
   only representation that works for both standard chess and
   Chess960. It is converted to e1g1 notation on output when
   UCI_Chess960 is off.
*/

/** A packed move (see above). No move encodes as 0: NO_MOVE. */
type Move = number;
/** How a move is made: normal, FLAG_EP or FLAG_CASTLE. */
type MoveType = number;
/** A 0x88 square (0..127), or NO_SQUARE. */
type Square = number;
/** A square from 0 (a1) to 63 (h8), whatever the board layout. */
type Index64 = number;
/** A square's file (a = 0) or rank (1 = 0), 0..7. */
type File = number;
type Rank = number;
/** Pawn (PAWN 1) to king (KING 6). */
type PieceType = number;
/** A piece type plus colour << 3, or EMPTY. */
type Piece = number;
type Colour = typeof WHITE | typeof BLACK;
/** Centipawns, for the side to move. */
type Score = number;
/** Milliseconds. */
type Millis = number;
/** A line of moves, best play first. */
type Pv = readonly Move[];

const NAME = "Pedagog", VERSION = "1.0";

const WHITE = 0, BLACK = 1;
const EMPTY = 0, PAWN = 1, KNIGHT = 2, BISHOP = 3;
const ROOK = 4, QUEEN = 5, KING = 6;
const PIECE_CHARS = ".PNBRQK..pnbrqk";
const FILE_NAMES = "abcdefgh";
const RANK_NAMES = "12345678";

const MAX_PLY = 100;              // longest line the search will follow
const INF = 32500;
const MATE = 32000;               // mate in N plies scores MATE - N
const MATE_IN_MAX_PLY = MATE - MAX_PLY;
const DRAW = 0;

const NO_MOVE: Move = 0;
const NO_SQUARE: Square = -1;
const FLAG_EP: MoveType = 1, FLAG_CASTLE: MoveType = 2;

const opponent = (colour: Colour): Colour => (colour === WHITE ? BLACK : WHITE);
const typeOf = (piece: Piece): PieceType => piece & 7;
const colourOf = (piece: Piece): Colour => (piece >> 3) as Colour;
const makePiece = (pieceType: PieceType, colour: Colour): Piece => pieceType | (colour << 3);

// ---- The board layout: the only code that knows squares are 0x88.
const BOARD_SIZE = 128;
const fileOf = (sq: Square): File => sq & 7;
const rankOf = (sq: Square): Rank => sq >> 4;
const makeSquare = (file: File, rank: Rank): Square => rank * 16 + file;
const onBoard = (sq: Square): boolean => (sq & 0x88) === 0;
const flipRank = (sq: Square): Square => makeSquare(fileOf(sq), 7 - rankOf(sq));
const index64 = (sq: Square): Index64 => rankOf(sq) * 8 + fileOf(sq);
/** The 64 squares, a1, b1, ... h8: the order every board walk uses. */
const SQUARES: readonly Square[] = Array.from({ length: 64 }, (_, i) => makeSquare(i % 8, Math.floor(i / 8)));
/** One square forward for a pawn of each colour. */
const PAWN_STEP: readonly [number, number] = [16, -16];

const fromSq = (move: Move): Square => move & 127;
const toSq = (move: Move): Square => (move >> 7) & 127;
const promoType = (move: Move): PieceType => (move >> 14) & 7;
const moveType = (move: Move): MoveType => (move >> 17) & 3;
const encodeMove = (from: Square, to: Square, promo: PieceType, type: MoveType): Move =>
  from | (to << 7) | (promo << 14) | (type << 17);

const squareName = (sq: Square): string => FILE_NAMES[fileOf(sq)] + RANK_NAMES[rankOf(sq)];
const parseSquare = (str: string): Square =>
  makeSquare(FILE_NAMES.indexOf(str[0]), RANK_NAMES.indexOf(str[1]));

const now = (): Millis => performance.now();

/* ================================================================
   S1  SEARCH
   ================================================================

   The search answers one question: which move is best? It looks
   ahead a fixed number of plies with negamax alpha-beta, trying
   the previous best move and then captures first, and asks the
   static evaluation about the positions at the leaves, after a
   short quiescence search has played out the captures pending there
   (a leaf in the middle of an exchange is otherwise judged as if the
   exchange were over, the "horizon effect"). That is the whole
   search: there is no hash table and no pruning beyond alpha-beta
   itself.

   think(pos, limits, skill, io)
               iterative deepening: depth 1, 2, 3, ... until a limit
               is reached. Returns the result of the last finished
               depth, so there is always a complete answer.
   Search.search(pos, alpha, beta, depth, ply, hint)
               negamax alpha-beta. Alpha is the best score the side
               to move is already assured of, beta the best the
               opponent will allow. A move scoring >= beta is "too
               good": the opponent would never let us get here, so
               the remaining moves need not be looked at (a cutoff).
               Returns { score, pv }: the score and the line of best
               play (principal variation) that produces it.

   One Search object is made per think() call. It holds what the
   search reads besides its arguments (the limits, the skill, the
   overlooked root moves) and the only things it changes: the node
   count, the stop flag and the depth being searched.

   Without the skill (the three calls marked "skill"), search() is
   the Chess Programming Wiki's fail-soft Alpha-Beta and qsearch() its
   Quiescence Search, with judge() in place of Evaluate.

   Scores are always from the point of view of the side to move
   (negamax): +100 means "the side to move is a pawn up". A child's
   score is negated on the way back up, because what is good for
   one side is bad for the other.
*/

const NO_LINE: Pv = Object.freeze([]);
const QSEARCH_PLIES = 4; // captures followed past a leaf

/** How far and how long to search. After softMs no new depth starts; at hardMs the search is cut off. */
interface Limits {
  readonly depth: number;
  readonly nodes: number;          // 0 = no limit
  readonly softMs: Millis;
  readonly hardMs: Millis;
}

/** One finished depth: the move to play, its score and the line behind it. */
interface Result {
  readonly bestMove: Move;
  readonly depth: number;
  readonly score: Score;
  readonly nodes: number;
  readonly elapsed: Millis;
  readonly pv: Pv;
}

/** A score and the line of best play that produces it. */
interface Line {
  readonly score: Score;
  readonly pv: Pv;
}

/** What think() needs from the world: a clock, a stop request and a place to report each depth. */
interface SearchIo {
  now(): Millis;
  shouldStop(): boolean;
  onInfo(result: Result): void;
}

const STOPPED: Line = Object.freeze({ score: 0, pv: NO_LINE });

/* Choose a move for `pos` within `limits` (from limitsFor()), playing
   as `skill` (from skillFor()). `io` supplies the clock, `now()`; a
   stop request, `shouldStop()`; and `onInfo(result)`, called after
   every finished depth. Returns the last finished depth's Result;
   bestMove is NO_MOVE when there is no legal move. */
function think(pos: Position, limits: Limits, skill: Skill, io: SearchIo): Result {
  const startTime = io.now();
  const rootMoves = legalMoves(pos);
  if (rootMoves.length === 0)
    return { bestMove: NO_MOVE, depth: 0, score: 0, nodes: 0, elapsed: 0, pv: NO_LINE };

  if (skill.level === 1) {
    const move = randomMove(pos, skill, rootMoves);
    const result = {
      bestMove: move, depth: 1, score: 0,
      nodes: rootMoves.length, elapsed: 0, pv: [move],
    };
    io.onInfo(result);
    return result;
  }

  const unseen = overlookedRootMoves(pos, skill, rootMoves);
  const maxDepth = Math.min(limits.depth, depthFor(pos, skill));
  const search = new Search(limits, skill, io, unseen, startTime);
  let best: Result = {
    bestMove: rootMoves.find((move) => !unseen.includes(move)) ?? rootMoves[0],
    depth: 0, score: 0, nodes: 0, elapsed: 0, pv: NO_LINE,
  };

  for (let depth = 1; depth <= maxDepth; depth++) {
    const { score, pv } = search.root(pos, depth, best.pv);
    if (search.stopped) break; // an interrupted depth cannot replace `best`
    best = {
      bestMove: pv[0], depth, score, nodes: search.nodes,
      elapsed: Math.round(io.now() - startTime), pv,
    };
    io.onInfo(best);
    if (best.elapsed > limits.softMs) break;
  }
  return { ...best, nodes: search.nodes };
}

/* The working state of one think() call. */
class Search {
  readonly limits: Limits;
  readonly skill: Skill;
  readonly io: SearchIo;
  readonly unseen: Pv;             // root moves the skill overlooks
  readonly startTime: Millis;
  nodes = 0;
  stopped = false;
  rootDepth = 0;

  constructor(limits: Limits, skill: Skill, io: SearchIo, unseen: Pv, startTime: Millis) {
    this.limits = limits;
    this.skill = skill;
    this.io = io;
    this.unseen = unseen;
    this.startTime = startTime;
  }

  /* One iteration of think(): the root searched to `depth`, trying
     `hint`, the previous depth's best line, first. */
  root(pos: Position, depth: number, hint: Pv): Line {
    this.rootDepth = depth;
    return this.search(pos, -INF, INF, depth, 0, hint);
  }

  /* Negamax to a fixed depth: terminate, try moves, keep the best line,
     and stop at a beta cutoff. `hint` is what remains of the previous
     depth's best line along this path (or NO_LINE): its first move is
     tried first, as it is likely the best again. */
  search(pos: Position, alpha: Score, beta: Score, depth: number, ply: number, hint: Pv): Line {
    if (this.countNodeAndCheckStop()) return STOPPED;
    if (ply > 0 && isDraw(pos)) return { score: DRAW, pv: NO_LINE };
    if (depth === 0 || ply >= MAX_PLY - 1) // a leaf
      return { score: this.qsearch(pos, alpha, beta, ply, QSEARCH_PLIES), pv: NO_LINE };

    let bestScore = -INF, pv = NO_LINE;
    let raisedAlpha = alpha; // alpha, raised as better moves are found
    let legalMoveCount = 0;
    for (const move of orderMoves(pos, generateMoves(pos), hint[0] ?? NO_MOVE)) {
      const next = makeMove(pos, move);
      if (next === null) continue;              // leaves our king in check
      legalMoveCount++;
      if (this.overlooks(next, move, ply)) continue;                 // skill
      const bias = this.checkBias(next, ply);                         // skill
      const childHint = move === hint[0] ? hint.slice(1) : NO_LINE;
      const child = this.search(next, bias - beta, bias - raisedAlpha, depth - 1, ply + 1, childHint);
      if (this.stopped) return STOPPED;

      // A mate score is exact and keeps no bias.
      const score = isMateScore(child.score) ? -child.score : bias - child.score;
      if (score > bestScore) {
        bestScore = score;
        if (score > raisedAlpha) {
          raisedAlpha = score;
          pv = [move, ...child.pv]; // this move, then the best reply line
          if (raisedAlpha >= beta) break; // opponent would never allow it
        }
      }
    }

    if (legalMoveCount === 0) return { score: inCheck(pos) ? -MATE + ply : DRAW, pv: NO_LINE };
    if (bestScore === -INF) // overlooked every legal move                    skill
      return { score: judge(pos, this.skill), pv: NO_LINE };
    return { score: bestScore, pv };
  }

  /* Quiescence: at a leaf, keep trying captures (and promotions) until
     the position is quiet, so a leaf is not judged in the middle of an
     exchange. The side to move may always "stand pat" instead: decline
     every capture and take the leaf's own judgement. Only `pliesLeft`
     more captures are followed, as long sequences cost much and change
     little. Returns a score. */
  qsearch(pos: Position, alpha: Score, beta: Score, ply: number, pliesLeft: number): Score {
    if (this.countNodeAndCheckStop()) return 0;
    const standPat = judge(pos, this.skill);
    if (standPat >= beta || pliesLeft === 0 || ply >= MAX_PLY - 1) return standPat;
    let bestScore = standPat, raisedAlpha = Math.max(alpha, standPat);
    for (const move of capturesByValue(pos, generateMoves(pos))) {
      const next = makeMove(pos, move);
      if (next === null) continue;
      const score = -this.qsearch(next, -beta, -raisedAlpha, ply + 1, pliesLeft - 1);
      if (this.stopped) return 0;
      if (score > bestScore) {
        bestScore = score;
        if (score > raisedAlpha) {
          raisedAlpha = score;
          if (raisedAlpha >= beta) break;
        }
      }
    }
    return bestScore;
  }

  /* Does the player fail to notice `move`, made at `ply` and leading
     to `next`? At the root the overlooked moves were chosen in
     advance; deeper, seesMove() decides. */
  overlooks(next: Position, move: Move, ply: number): boolean {
    return ply === 0 ? this.unseen.includes(move) : !seesMove(next, this.skill, move, ply);
  }

  /* At the root the style may favour checks: a move into `next` that
     gives check counts this much better, so the child's window is
     shifted by the same amount. */
  checkBias(next: Position, ply: number): Score {
    return ply === 0 && inCheck(next) ? this.skill.checkBias : 0;
  }

  /* Count a node and say whether to stop. The limits are checked
     every 1024 nodes from depth 2 on: the first depth always
     finishes, so there is always a move to play. */
  countNodeAndCheckStop(): boolean {
    this.nodes++;
    if (this.rootDepth > 1 && this.nodes % 1024 === 0 && this.limitReached()) this.stopped = true;
    return this.stopped;
  }

  limitReached(): boolean {
    return (this.limits.nodes > 0 && this.nodes >= this.limits.nodes) ||
      this.io.now() - this.startTime >= this.limits.hardMs || this.io.shouldStop();
  }
}

const isMateScore = (score: Score): boolean => Math.abs(score) >= MATE_IN_MAX_PLY;

/* ---- Move ordering --------------------------------------------
   Alpha-beta prunes most when a good move is tried first. The best
   guess is the move that was best at the previous depth (`pvMove`,
   if any); after it come the captures (and promotions), the most
   valuable victim first and, among equal victims, the least valuable
   attacker first (MVV-LVA); then the quiet moves, in the order they
   were generated. Returns a new array. */
function orderMoves(pos: Position, moves: Pv, pvMove: Move): Move[] {
  const rest = moves.filter((move) => move !== pvMove);
  const ordered = [...capturesByValue(pos, rest), ...rest.filter((move) => !isCapture(pos, move))];
  return rest.length < moves.length ? [pvMove, ...ordered] : ordered;
}

/* Does `move` take a piece or promote? Castling ("king takes own
   rook") does not count. */
function isCapture(pos: Position, move: Move): boolean {
  return moveType(move) !== FLAG_CASTLE &&
    (pos.board[toSq(move)] !== EMPTY || moveType(move) === FLAG_EP || promoType(move) !== 0);
}

/* The captures (and promotions) among `moves`, as a new array, by
   captureScore(), highest first; equal scores keep the order of
   `moves`. */
function capturesByValue(pos: Position, moves: Pv): Move[] {
  const captures = moves.filter((move) => isCapture(pos, move));
  const scores = captures.map((move) => captureScore(pos, move));
  const order = captures.map((_, i) => i).sort((a, b) => scores[b] - scores[a] || a - b);
  return order.map((i) => captures[i]);
}

/* MVV-LVA (most valuable victim, least valuable attacker): ten
   times the victim's value, plus the value of a promotion, minus the
   attacker's value. */
function captureScore(pos: Position, move: Move): number {
  const victim = moveType(move) === FLAG_EP ? PAWN : typeOf(pos.board[toSq(move)]);
  return 10 * MG_VALUE[victim] + MG_VALUE[promoType(move)] -
    MG_VALUE[typeOf(pos.board[fromSq(move)])];
}

/* ---- Time management -------------------------------------------
   Turn the numbers of a UCI "go" command into search limits for the
   side to move. Two time budgets: a soft one (do not start another
   depth after it) and a hard one (abort the search). The first
   second of the clock is a reserve that is never planned for: the
   GUI's clock also counts delays the search cannot see (passing
   messages, other programs, garbage collection), and a player that
   lives on its increment loses on time to the first such hiccup.
   Below the reserve only part of the increment is spent, so the
   clock climbs back. Every level is a depth, never a time budget, so
   it plays the same on any machine; below SKILL_MAX the clock is
   ignored altogether, and at SKILL_MAX it only cuts a search short
   so that a fast game is never lost on time. */
const NO_TIME_LIMIT: Millis = 2 ** 31 - 1; // about 25 days
const MOVE_OVERHEAD: Millis = 20;

function limitsFor(go: Go, side: Colour, level: number): Limits {
  const untimed: Limits = {
    depth: go.depth || MAX_PLY, nodes: go.nodes ?? 0,
    softMs: NO_TIME_LIMIT, hardMs: NO_TIME_LIMIT,
  };
  if (level < SKILL_MAX) return untimed;
  if (go.movetime !== undefined) {
    const ms = Math.max(1, go.movetime - MOVE_OVERHEAD);
    return { ...untimed, softMs: ms, hardMs: ms };
  }
  const time = side === WHITE ? go.wtime : go.btime;
  if (time === undefined) return untimed;
  const inc = (side === WHITE ? go.winc : go.binc) ?? 0;
  const movesToGo = go.movestogo || 30;
  const usable = Math.max(0, time - 1000); // the first second is the reserve
  const incShare = Math.floor(3 * inc / 4);
  const softMs = Math.max(1, Math.floor(usable / movesToGo) + incShare - MOVE_OVERHEAD);
  const hardMs = Math.max(1, Math.min(2 * softMs, Math.floor(usable / 4) + incShare - MOVE_OVERHEAD));
  return { ...untimed, softMs, hardMs };
}

/* ================================================================
   S2  SKILL LEVELS
   ================================================================

   Deliberately weakened play, for opponents meant to be beatable,
   after Gaia (jromang/gaiachess, src/skill.rs). Every level, SKILL_MAX
   included, is weakened this way: the top level is meant to match
   Maia-1900, and the full search would be far stronger.

   Searching less far is not enough on its own: a shallow but
   otherwise flawless player is dull, never careless. So a level
   turns three knobs at once:

     depth      how far ahead it looks, plus a chance of one extra
                ply on some positions so a rung can sit between two
                whole depths (a ply is a very coarse unit);
     blunder    now and then it misjudges a position by a lot, which
                is how human mistakes are actually distributed: the
                odd catastrophe rather than a constant drizzle;
     vision     the chance that it so much as considers a move. This
                is what makes the low levels leave pieces hanging,
                and miss mates in one. Captures and checks are hard
                to miss, so they get two chances. Vision fades with
                distance from the root: a move six plies away is
                harder to picture than one two plies away.

   (Gaia has a fourth knob, evaluation fidelity, and a small error
   on every position. Both were measured here and found to be worth
   nothing with this evaluation, so they were left out; see
   docs/COLOPHON.md.)

   Every choice is drawn from the position's key and the Skill_Seed,
   never from the clock or a random generator, so a level misjudges
   the same position the same way every time: stable blind spots, not
   a tremor. Level 1 is apart: it plays a random legal move, but
   always mates in one when it can. Levels 2..SKILL_MAX come from
   the style's ladder below (LADDER or AGGRESSIVE_LADDER); their
   ratings were measured against Maia and are recorded in docs/COLOPHON.md.

   A skill is a frozen value made by skillFor(level, seed, aggressive); the
   functions below take it as an argument.
*/

const SKILL_MAX = 10;
const FULL_VISION = 1024;
const VISION_SLOPE = 16, VISION_FLOOR = 160;
// Vision lost per ply, and its minimum.

/* Hashing constants, here and in S5. The two multipliers were chosen
   for how well they scramble bits. The seeds and the salt are
   arbitrary (any distinct nonzero values would do), but changing any
   of them changes which positions each skill level misjudges. */
const GOLDEN = 0x9E3779B9;          // 2^32 / golden ratio (Fibonacci hashing)
const MIX_MULTIPLIER = 0x45d9f3b;   // from a well-known 32-bit integer hash
const BUILT_IN_SEED = 0x9E3779B9;   // stands in for Skill_Seed 0
const DEPTH_SALT = 0xA5A55A5A;      // keeps the depth draw apart from the others
const ZOBRIST_SEED = 0x2545F491;    // starts the key generator in S5

/** One level's knobs. */
interface Rung {
  readonly depth: number;
  readonly deeperPermille: number;  // share of positions searched one ply deeper
  readonly blunderWindow: Score;    // largest misjudgement, either way
  readonly blunderPermille: number; // share of positions misjudged
  readonly vision: number;          // chance, out of 1024, of noticing a move
}

const rung = (depth: number, deeperPermille: number, blunderWindow: Score,
  blunderPermille: number, vision: number): Rung =>
  ({ depth, deeperPermille, blunderWindow, blunderPermille, vision });

/* The ladder, from a beginner's opponent up to Maia-1900's strength,
   evenly spaced about 100 Elo apart. The ratings are on the Lichess
   classical scale: Maia-1900's bot (maia9) was rated 1755 there, and
   the fit is anchored on it (see docs/COLOPHON.md). Every level is a depth,
   never a time budget, so it plays the same on any machine. This is the
   plain style's ladder (UCI option Aggressive off). Level n is at
   index n - 1; level 1, the random mover, ignores its knobs. */
const LADDER: readonly Rung[] = [
  //   depth  deeper  blunder  b/1000  vision           target  measured
  rung(0,       0,       0,      0,       0),    //  1    ~170
  rung(1,       0,     800,     76,     560),    //  2     945      940
  rung(1,       0,     700,     66,     670),    //  3    1046     1038
  rung(1,     400,     660,     61,     710),    //  4    1148     1168
  rung(1,     780,     615,     57,     745),    //  5    1249     1225
  rung(2,       5,     555,     51,     805),    //  6    1350     1329
  rung(2,     150,     480,     43,     875),    //  7    1451     1430
  rung(2,     360,     415,     35,     930),    //  8    1553     1547
  rung(2,     690,     380,     26,     962),    //  9    1654     1666
  rung(3,      60,     330,     19,     985),    // 10    1755     1795
];

/* The aggressive style's ladder (UCI option Aggressive on, the default),
   to the same targets. Its style costs strength (at equal knobs the
   plain style wins by about 200 Elo), so each rung looks further ahead
   and errs less than the plain rung with the same number. */
const AGGRESSIVE_LADDER: readonly Rung[] = [
  //   depth  deeper  blunder  b/1000  vision           target  measured
  rung(0,       0,       0,      0,       0),    //  1    ~170
  rung(1,     200,     720,     68,     640),    //  2     945      990
  rung(1,     550,     655,     62,     705),    //  3    1046     1077
  rung(2,       5,     575,     52,     785),    //  4    1148     1170
  rung(2,      90,     475,     44,     868),    //  5    1249     1287
  rung(2,     300,     425,     37,     925),    //  6    1350     1377
  rung(2,     570,     393,     28,     956),    //  7    1451     1474
  rung(2,     950,     355,     22,     975),    //  8    1553     1557
  rung(3,     640,     260,     14,     996),    //  9    1654     1649
  rung(4,     420,       0,      0,    FULL_VISION),   // 10  1755     1771
];

/* The two playing styles. The aggressive one is eager to attack:
     kingAttack  middlegame bonus, per square, for each knight, bishop,
                 rook or queen standing closer to the enemy king (queens
                 count twice), so the pieces gather around the king;
     materialMg  middlegame material counts this many permille of its
                 value, so giving it up for an attack costs less;
     checkBias   at the root, a move that gives check counts this many
                 centipawns better, so it is chosen over equal moves.
   The plain style turns all of that off. evaluate() in S3 applies the
   first two. */
interface Style {
  readonly kingAttack: Score;
  readonly materialMg: number;
  readonly checkBias: Score;
}

const AGGRESSIVE: Style = { kingAttack: 60, materialMg: 250, checkBias: 60 };
const PLAIN: Style = { kingAttack: 0, materialMg: 1000, checkBias: 0 };

/** One seeded opponent: a level's rung combined with a style. */
interface Skill extends Rung, Style {
  readonly level: number;
  readonly seed: number;
  readonly aggressive: boolean;
  readonly seedKey: number;        // the seed, hashed
}

/* The skill for a Skill_Level (clamped to 1..SKILL_MAX), a Skill_Seed
   and the Aggressive option: its style, and its rung of that style's
   ladder. The seed picks which weakened opponent a level is; 0 means
   the built-in one, so an engine nobody configures still plays the same
   game twice. */
function skillFor(level: number, seed: number, aggressive: boolean): Skill {
  const clamped = Math.min(SKILL_MAX, Math.max(1, Math.trunc(level)));
  const ladder = aggressive ? AGGRESSIVE_LADDER : LADDER;
  return Object.freeze({
    ...ladder[clamped - 1],
    ...(aggressive ? AGGRESSIVE : PLAIN),
    level: clamped,
    seed,
    aggressive,
    seedKey: mix32(seed === 0 ? BUILT_IN_SEED : seed),
  });
}

/* Depth ceiling for `pos`: the rung's depth, and one more on the
   rung's share of positions, decided by the hash. */
function depthFor(pos: Position, skill: Skill): number {
  if (skill.deeperPermille === 0) return skill.depth;
  const hash = mix32(pos.key ^ skill.seedKey ^ DEPTH_SALT);
  return skill.depth + (hash % 1000 < skill.deeperPermille ? 1 : 0);
}

/* What this skill makes of `pos`: the evaluation in its style and,
   now and then, a misjudgement. This is what the search sees at a
   leaf. */
function judge(pos: Position, skill: Skill): Score {
  return evaluate(pos, skill) + blunder(pos, skill);
}

/* The occasional misjudgement, added to the evaluation of the rung's
   share of positions: up to blunderWindow centipawns either way. Mate
   scores never pass through here, since they come from the search,
   not from evaluate(). */
function blunder(pos: Position, skill: Skill): Score {
  if (skill.blunderWindow === 0) return 0;
  const hash = mix32(pos.key ^ skill.seedKey);
  if (hash % 1000 >= skill.blunderPermille) return 0;
  return (mix32(hash) % (2 * skill.blunderWindow + 1)) - skill.blunderWindow;
}

/* Does the player notice `move`, made `ply` plies below the root?
   `after` is the position the move leads to, so its key and whether
   the move gives check are known. Two independent 10-bit draws from
   one hash: the first chance, and the second one that captures and
   checks get. */
function seesMove(after: Position, skill: Skill, move: Move, ply: number): boolean {
  if (skill.vision >= FULL_VISION) return true;
  const chance = Math.max(skill.vision - VISION_SLOPE * ply, VISION_FLOOR);
  const hash = mix32(after.key ^ Math.imul(move, GOLDEN) ^ skill.seedKey);
  if (((hash >>> 20) & 1023) < chance) return true;
  const easy = after.capturedPiece !== EMPTY || moveType(move) === FLAG_EP || inCheck(after);
  return easy && ((hash >>> 8) & 1023) < chance;
}

/* The root moves the player overlooks. If it would overlook them all,
   it sees them all: a move has to be played. */
function overlookedRootMoves(pos: Position, skill: Skill, rootMoves: Pv): Move[] {
  if (skill.vision >= FULL_VISION) return [];
  const unseen = rootMoves.filter((move) => !seesMove(makeLegalMove(pos, move), skill, move, 0));
  return unseen.length === rootMoves.length ? [] : unseen;
}

/* Level 1: a random legal move from `moves`, unless one mates on the
   spot. */
function randomMove(pos: Position, skill: Skill, moves: Pv): Move {
  return moves.find((move) => givesMate(pos, move)) ??
    moves[mix32(pos.key ^ skill.seedKey) % moves.length];
}

function givesMate(pos: Position, move: Move): boolean {
  const after = makeLegalMove(pos, move);
  return legalMoves(after).length === 0 && inCheck(after);
}

/* A 32-bit integer hash finaliser (two multiply-xorshift rounds).
   Returns an unsigned 32-bit number. */
function mix32(x: number): number {
  const a = Math.imul(x ^ (x >>> 16), MIX_MULTIPLIER);
  const b = Math.imul(a ^ (a >>> 16), MIX_MULTIPLIER);
  return (b ^ (b >>> 16)) >>> 0;
}

/* ================================================================
   S3  EVALUATION
   ================================================================

   A deliberately naive evaluation: material plus piece-square
   tables, tapered between a middlegame and an endgame set by the
   amount of material left. The tables are not hand-tuned numbers
   but small formulas that say what every beginner is taught:
   knights and bishops like the centre, pawns like to advance,
   rooks like the seventh rank, the king hides in the middlegame
   and comes out in the endgame.

   evaluate(pos, style) simply walks the board and adds up material
   and placement, and the playing style's two terms (see S2): a
   discount on middlegame material and a bonus for pieces near the
   enemy king. (Real engines keep these sums up to date as each move
   is made, which is faster but spreads the evaluation over more
   than one function.) The skill level's occasional blunder is added
   separately, by judge() in S2.
*/

/** Piece-square bonuses, by piece * 64 + index64(sq). */
type PsqTable = Int16Array;

const MG_VALUE: readonly number[] = [0, 100, 320, 330, 500, 900, 0];
const EG_VALUE: readonly number[] = [0, 120, 320, 330, 520, 920, 0];
// 24 at the start, 0 when only kings and pawns remain.
const PHASE_INC: readonly number[] = [0, 0, 1, 1, 2, 4, 0];
const PHASE_MAX = 24;

/* Bonus for a white piece of `pieceType` on file f, rank r (0 = rank
   1), as [middlegame, endgame]. */
function psqBonus(pieceType: PieceType, f: File, r: Rank): readonly [mg: Score, eg: Score] {
  // 0 on the rim .. 3 in the four centre squares
  const centre = 3 - Math.floor((Math.max(Math.abs(2 * f - 7), Math.abs(2 * r - 7)) - 1) / 2);
  const home = r === 0 ? -10 : 0; // nudge to develop
  switch (pieceType) {
    case PAWN:
      return [(r - 1) * 3 + ((f === 3 || f === 4) && (r === 3 || r === 4) ? 15 : 0), (r - 1) * 12];
    case KNIGHT: return [centre * 12 - 24 + home, centre * 12 - 24];
    case BISHOP: return [centre * 6 - 12 + home, centre * 6 - 12];
    case ROOK: return [(f === 3 || f === 4 ? 5 : 0) + (r === 6 ? 15 : 0), r === 6 ? 15 : 0];
    case QUEEN: return [centre * 3 - 6, centre * 5 - 10];
    default: return [-Math.min(r, 3) * 25 + (f <= 2 || f >= 5 ? 20 : -10), centre * 15 - 30]; // KING
  }
}

/* psqBonus() for every piece and square, looked up as
   [piece * 64 + index64(sq)] and signed by colour: white as is,
   black mirrored and negated. */
function pieceSquareTables(): readonly [mg: PsqTable, eg: PsqTable] {
  const mgTable = new Int16Array(16 * 64), egTable = new Int16Array(16 * 64);
  for (let pieceType = PAWN; pieceType <= KING; pieceType++) {
    for (const sq of SQUARES) {
      const [mg, eg] = psqBonus(pieceType, fileOf(sq), rankOf(sq));
      const white = makePiece(pieceType, WHITE) * 64 + index64(sq);
      const black = makePiece(pieceType, BLACK) * 64 + index64(flipRank(sq));
      mgTable[white] = mg;
      egTable[white] = eg;
      mgTable[black] = -mg;
      egTable[black] = -eg;
    }
  }
  return [mgTable, egTable];
}

const [PSQ_MG, PSQ_EG] = pieceSquareTables();

/* King moves between two squares: KING_DISTANCE[index64(a) * 64 + index64(b)]. */
function kingDistances(): Int8Array {
  const table = new Int8Array(64 * 64);
  for (const a of SQUARES) {
    for (const b of SQUARES) {
      table[index64(a) * 64 + index64(b)] =
        Math.max(Math.abs(fileOf(a) - fileOf(b)), Math.abs(rankOf(a) - rankOf(b)));
    }
  }
  return table;
}

const KING_DISTANCE = kingDistances();

/* Static evaluation of `pos` in `style`, in centipawns for the side
   to move. Middlegame material counts style.materialMg permille of its
   value, and each knight, bishop, rook or queen earns style.kingAttack
   in the middlegame for every square it stands closer to the enemy
   king than the far side of the board (queens count twice). */
function evaluate(pos: Position, style: Style): Score {
  const board = pos.board;
  let mg = 0, eg = 0, phase = 0; // mg and eg are white minus black
  for (const sq of SQUARES) {
    const piece = board[sq];
    if (piece === EMPTY) continue;
    const pieceType = typeOf(piece), sign = colourOf(piece) === WHITE ? 1 : -1;
    const at = piece * 64 + index64(sq);
    mg += sign * Math.floor(MG_VALUE[pieceType] * style.materialMg / 1000) + PSQ_MG[at];
    eg += sign * EG_VALUE[pieceType] + PSQ_EG[at];
    phase += PHASE_INC[pieceType];
    if (pieceType >= KNIGHT && pieceType <= QUEEN) {
      const enemyKing = pos.kingSq[opponent(colourOf(piece))];
      const distance = KING_DISTANCE[index64(sq) * 64 + index64(enemyKing)];
      mg += sign * (7 - distance) * (pieceType === QUEEN ? 2 : 1) * style.kingAttack;
    }
  }
  // Taper from middlegame to endgame as material leaves the board.
  const tapered = Math.min(phase, PHASE_MAX);
  const score = Math.trunc((mg * tapered + eg * (PHASE_MAX - tapered)) / PHASE_MAX);
  return pos.sideToMove === WHITE ? score : -score;
}

/* ================================================================
   S4  CHESS RULES AND POSITION
   ================================================================

   This section owns movement, king safety, castling, promotion,
   en passant and draw detection, with FEN and UCI move notation
   alongside the position they describe. Evaluation and search
   policy live outside it.

   A position is a value: once made, it never changes. makeMove()
   does not alter the position it is given; it returns a new one
   (copy/make rather than make/unmake), or null if the move would
   leave the mover's king in check. Each position links to the one
   before it (`previous`), which is all that repetition detection
   needs.

   Position contract (what search needs to know):
   - generateMoves(pos) returns a new array of packed pseudo-legal
     moves; legalMoves(pos) keeps the ones makeMove() accepts.
   - makeMove(pos, move) accepts one of those moves, not arbitrary
     packed input. It returns the position after the move, with the
     opponent to move, or null if our king would be left in check.

   Castling rights are four bits, one per Right: 0 = white kingside,
   1 = white queenside, 2 = black kingside, 3 = black queenside. For
   each right we remember the rook's square (Chess960 rooks can start
   on any file), and castlingRightsMask[sq] holds the rights that
   survive a piece moving from or to that square. Both are fixed for
   a whole game, so all of its positions share one `castle` object.

   The fields of a position:
     board           a Piece per Square (BOARD_SIZE entries)
     kingSq          [white king's square, black king's square]
     pieceCount      how many of each Piece (16 entries)
     sideToMove      the colour to move
     castlingRights  the castling rights still held, four bits
     castle          { castlingRookSquare, castlingRightsMask }
     epSquare        en passant target square, or NO_SQUARE
     halfmoveClock   plies since the last capture or pawn move
     key             Zobrist key (S5)
     gamePly         plies played since the FEN was loaded
     capturedPiece   the piece the last move took from its destination
                     square (EMPTY if none, and for en passant)
     previous        the position before the last move, or null
*/

/** A Piece per Square, BOARD_SIZE entries. */
type Board = Int8Array;
/** How many of each Piece, 16 entries. */
type PieceCounts = Int8Array;
type KingSquares = readonly [Square, Square];
/** A 32-bit Zobrist key. */
type Key = number;
/** One castling right, 0..3, and a 4-bit set of them. */
type Right = number;
type Rights = number;

/** The castling geometry of one game, shared by all its positions. */
interface Castle {
  readonly castlingRookSquare: Int32Array;  // by Right
  readonly castlingRightsMask: Int8Array;   // Rights per Square
}

interface Position {
  readonly board: Board;
  readonly kingSq: KingSquares;
  readonly pieceCount: PieceCounts;
  readonly sideToMove: Colour;
  readonly castlingRights: Rights;
  readonly castle: Castle;
  readonly epSquare: Square;
  readonly halfmoveClock: number;
  readonly key: Key;
  readonly gamePly: number;
  readonly capturedPiece: Piece;
  readonly previous: Position | null;
}

const castlingRight = (colour: Colour, kingside: boolean): Right => colour * 2 + (kingside ? 0 : 1);
const hasRight = (rights: Rights, right: Right): boolean => ((rights >> right) & 1) !== 0;
const isKingside = (right: Right): boolean => right % 2 === 0;

// Where king and rook land, by Right: g1 c1 g8 c8, f1 d1 f8 d8.
const CASTLE_KING_TO: readonly Square[] =
  [makeSquare(6, 0), makeSquare(2, 0), makeSquare(6, 7), makeSquare(2, 7)];
const CASTLE_ROOK_TO: readonly Square[] =
  [makeSquare(5, 0), makeSquare(3, 0), makeSquare(5, 7), makeSquare(3, 7)];

/* The scratch copy of a position that makeMove() turns into the next
   one. Its board, piece counts, king squares and key change together:
   lift() and put() keep them in step. */
class Draft {
  readonly board: Board;
  readonly pieceCount: PieceCounts;
  readonly kingSq: [Square, Square];
  key: Key;

  constructor(pos: Position) {
    this.board = pos.board.slice();
    this.pieceCount = pos.pieceCount.slice();
    this.kingSq = [pos.kingSq[0], pos.kingSq[1]];
    this.key = pos.key;
  }

  /* Take the piece off square `sq` and return it. */
  lift(sq: Square): Piece {
    const piece = this.board[sq];
    this.board[sq] = EMPTY;
    this.pieceCount[piece]--;
    this.key ^= zobPiece[piece * 64 + index64(sq)];
    return piece;
  }

  /* Put `piece` on the empty square `sq`. */
  put(sq: Square, piece: Piece): void {
    this.board[sq] = piece;
    this.pieceCount[piece]++;
    this.key ^= zobPiece[piece * 64 + index64(sq)];
    if (typeOf(piece) === KING) this.kingSq[colourOf(piece)] = sq;
  }
}

/* The position after `move`, or null if the move leaves our king in
   check. `pos` itself is not changed. Movement rules are the
   generator's responsibility, not validated here. */
function makeMove(pos: Position, move: Move): Position | null {
  const from = fromSq(move), to = toSq(move);
  const promotion = promoType(move), type = moveType(move);
  const us = pos.sideToMove, them = opponent(us);

  const draft = new Draft(pos);
  draft.key ^= zobSide;
  if (pos.epSquare !== NO_SQUARE) draft.key ^= zobEp[fileOf(pos.epSquare)];
  let epSquare = NO_SQUARE, halfmoveClock = pos.halfmoveClock + 1, capturedPiece = EMPTY;

  if (type === FLAG_CASTLE) {
    const right = castlingRight(us, to > from);
    const king = draft.lift(from), rook = draft.lift(to);
    draft.put(CASTLE_KING_TO[right], king);
    draft.put(CASTLE_ROOK_TO[right], rook);
  } else {
    if (draft.board[to] !== EMPTY) {
      capturedPiece = draft.lift(to);
      halfmoveClock = 0;
    }
    const piece = draft.lift(from);
    draft.put(to, promotion !== 0 ? makePiece(promotion, us) : piece);
    if (typeOf(piece) === PAWN) {
      halfmoveClock = 0;
      if (type === FLAG_EP) draft.lift(to - PAWN_STEP[us]);
      else if (Math.abs(rankOf(to) - rankOf(from)) === 2) {
        epSquare = from + PAWN_STEP[us];
        draft.key ^= zobEp[fileOf(epSquare)];
      }
    }
  }

  if (isSquareAttacked(draft.board, draft.kingSq[us], them)) return null;

  const mask = pos.castle.castlingRightsMask;
  const castlingRights = pos.castlingRights & mask[from] & mask[to];
  draft.key ^= zobCastle[pos.castlingRights] ^ zobCastle[castlingRights];
  return {
    board: draft.board, kingSq: draft.kingSq, pieceCount: draft.pieceCount,
    sideToMove: them, castlingRights, castle: pos.castle, epSquare, halfmoveClock,
    key: draft.key, gamePly: pos.gamePly + 1, capturedPiece, previous: pos,
  };
}

/* makeMove() for a move the caller already knows is legal. */
function makeLegalMove(pos: Position, move: Move): Position {
  const next = makeMove(pos, move);
  if (next === null) throw new Error("illegal move " + move);
  return next;
}

/* Is the side to move in check? */
function inCheck(pos: Position): boolean {
  return isSquareAttacked(pos.board, pos.kingSq[pos.sideToMove], opponent(pos.sideToMove));
}

/* Draw by the fifty-move rule, by repetition (once is enough inside
   the search), or by insufficient material (bare kings, or a single
   minor piece). */
function isDraw(pos: Position): boolean {
  if (pos.halfmoveClock >= 100) return true;
  // Earlier positions with the same side to move: 2, 4, 6... plies
  // back, but not past the last capture or pawn move, nor past the
  // first position (gamePly plies back).
  const reach = Math.min(pos.halfmoveClock, pos.gamePly);
  for (let back = 2, earlier = pos; back <= reach; back += 2) {
    earlier = earlier.previous!.previous!;
    if (earlier.key === pos.key) return true;
  }
  const n = pos.pieceCount;
  const count = (pieceType: PieceType) => n[makePiece(pieceType, WHITE)] + n[makePiece(pieceType, BLACK)];
  return count(PAWN) + count(ROOK) + count(QUEEN) === 0 && count(KNIGHT) + count(BISHOP) <= 1;
}

/* ---- FEN ----------------------------------------------------------
   The castling field may be KQkq (standard), file letters as in
   Shredder-FEN (HAha), or a mixture (X-FEN). K/Q mean the outermost
   rook on that side of the king, which covers Chess960 too. */
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/* The words of a line, split at runs of whitespace. */
const words = (line: string): string[] => line.trim().split(/\s+/);

/* `text` as a whole decimal integer, or `fallback` if it is not one. */
const toInteger = (text: string | undefined, fallback: number): number =>
  text !== undefined && /^[+-]?\d+$/.test(text) ? Number(text) : fallback;

/* A new position from a FEN string, with no earlier positions. */
function parseFen(fen: string): Position {
  const parts = words(fen);
  const board = new Int8Array(BOARD_SIZE), pieceCount = new Int8Array(16);
  const kingSq: [Square, Square] = [0, 0];
  let key = 0;
  let rank = 7, file = 0;
  for (const ch of parts[0]) {
    if (ch === "/") {
      rank--;
      file = 0;
    } else if (ch >= "1" && ch <= "8") {
      file += Number(ch);
    } else {
      const sq = makeSquare(file, rank), piece = PIECE_CHARS.indexOf(ch);
      board[sq] = piece;
      pieceCount[piece]++;
      key ^= zobPiece[piece * 64 + index64(sq)];
      if (typeOf(piece) === KING) kingSq[colourOf(piece)] = sq;
      file++;
    }
  }
  const sideToMove = parts[1] === "b" ? BLACK : WHITE;
  if (sideToMove === BLACK) key ^= zobSide;

  const { castlingRights, castle } = castlingFromFen(board, kingSq, parts[2] ?? "-");
  key ^= zobCastle[castlingRights];

  const epField = parts[3] ?? "-";
  const epSquare = epField !== "-" ? parseSquare(epField) : NO_SQUARE;
  if (epSquare !== NO_SQUARE) key ^= zobEp[fileOf(epSquare)];
  return {
    board, kingSq, pieceCount, sideToMove, castlingRights, castle,
    epSquare, halfmoveClock: toInteger(parts[4], 0), key,
    gamePly: 0, capturedPiece: EMPTY, previous: null,
  };
}

/* Interpret the FEN castling field for a loaded board and king
   squares. */
function castlingFromFen(board: Board, kingSq: KingSquares, field: string):
  { castlingRights: Rights; castle: Castle } {
  // The first file, walking from `edge` towards `kingFile`, that holds
  // `rook` on `rank`; -1 if there is none.
  const outermostRook = (rank: Rank, rook: Piece, edge: File, kingFile: File): File => {
    const step = edge < kingFile ? 1 : -1;
    for (let file = edge; file !== kingFile; file += step)
      if (board[makeSquare(file, rank)] === rook) return file;
    return -1;
  };

  let castlingRights = 0;
  const castlingRookSquare = new Int32Array(4).fill(NO_SQUARE);
  const castlingRightsMask = new Int8Array(BOARD_SIZE).fill(15);
  for (const ch of field) {
    if (ch === "-") continue;
    const letter = ch.toUpperCase();
    const colour = ch === letter ? WHITE : BLACK;
    const rank = colour === WHITE ? 0 : 7;
    const rook = makePiece(ROOK, colour);
    const kingFile = fileOf(kingSq[colour]);
    const rookFile = letter === "K" ? outermostRook(rank, rook, 7, kingFile)
      : letter === "Q" ? outermostRook(rank, rook, 0, kingFile)
      : FILE_NAMES.indexOf(letter.toLowerCase());
    if (rookFile < 0 || board[makeSquare(rookFile, rank)] !== rook) continue;
    const right = castlingRight(colour, rookFile > kingFile);
    castlingRights |= 1 << right;
    castlingRookSquare[right] = makeSquare(rookFile, rank);
    castlingRightsMask[makeSquare(rookFile, rank)] &= ~(1 << right);
    castlingRightsMask[kingSq[colour]] &= ~(3 << (colour * 2));
  }
  return { castlingRights, castle: { castlingRookSquare, castlingRightsMask } };
}

/* The FEN string for pos. Castling rights are written as file letters
   only for Chess960 rooks that are not in the corners. */
function toFen(pos: Position, chess960: boolean): string {
  let fen = "";
  for (let rank = 7; rank >= 0; rank--) {
    let empty = 0;
    for (let file = 0; file < 8; file++) {
      const piece = pos.board[makeSquare(file, rank)];
      if (piece === EMPTY) empty++;
      else {
        if (empty > 0) fen += empty;
        empty = 0;
        fen += PIECE_CHARS[piece];
      }
    }
    if (empty > 0) fen += empty;
    if (rank > 0) fen += "/";
  }
  let rights = "";
  for (let right = 0; right < 4; right++) {
    if (!hasRight(pos.castlingRights, right)) continue;
    const file = fileOf(pos.castle.castlingRookSquare[right]);
    const standard = isKingside(right) ? file === 7 : file === 0;
    const ch = chess960 && !standard ? FILE_NAMES[file] : isKingside(right) ? "k" : "q";
    rights += right < 2 ? ch.toUpperCase() : ch;
  }
  return `${fen} ${pos.sideToMove === WHITE ? "w" : "b"} ${rights || "-"} ` +
    `${pos.epSquare !== NO_SQUARE ? squareName(pos.epSquare) : "-"} ` +
    `${pos.halfmoveClock} ${1 + Math.floor(pos.gamePly / 2)}`;
}

/* ---- Move notation -------------------------------------------------
   UCI moves are "e2e4", "e7e8q". Castling is "e1g1" in standard chess
   and king-takes-rook ("e1h1") in Chess960. */
function moveToUci(move: Move, chess960: boolean): string {
  const from = fromSq(move);
  const colour: Colour = rankOf(from) === 0 ? WHITE : BLACK; // of a castling king
  const to = moveType(move) === FLAG_CASTLE && !chess960
    ? CASTLE_KING_TO[castlingRight(colour, toSq(move) > from)]
    : toSq(move);
  const promotion = promoType(move) !== 0 ? PIECE_CHARS[makePiece(promoType(move), BLACK)] : "";
  return squareName(from) + squareName(to) + promotion;
}

/* The legal move of pos written as `str`, or NO_MOVE. Castling is
   accepted in either notation. */
function parseMove(pos: Position, str: string, chess960: boolean): Move {
  for (const move of legalMoves(pos)) {
    if (moveToUci(move, chess960) === str) return move;
    if (moveType(move) === FLAG_CASTLE && moveToUci(move, !chess960) === str) return move;
  }
  return NO_MOVE;
}

/* The legal moves of pos, as a new array. */
function legalMoves(pos: Position): Move[] {
  return generateMoves(pos).filter((move) => makeMove(pos, move) !== null);
}

/* ---- Move generation ---------------------------------------------

   Pseudo-legal generation: moves may leave the king in check, and
   makeMove() rejects those. Pieces move by adding an offset to a
   0x88 square; knights and kings step once, sliders keep stepping
   until they hit something or leave the board.
*/

const KNIGHT_OFFSETS: readonly number[] = [-33, -31, -18, -14, 14, 18, 31, 33];
const BISHOP_OFFSETS: readonly number[] = [-17, -15, 15, 17];
const ROOK_OFFSETS: readonly number[] = [-16, -1, 1, 16];
const KING_OFFSETS: readonly number[] = [-17, -16, -15, -1, 1, 15, 16, 17];
/** By piece type; pawns are generated separately. */
const PIECE_OFFSETS: readonly (readonly number[])[] = [
  [], [], KNIGHT_OFFSETS, BISHOP_OFFSETS, ROOK_OFFSETS, KING_OFFSETS, KING_OFFSETS,
];
/** By colour: the two diagonal steps of a capturing pawn. */
const PAWN_CAPTURE_OFFSETS: readonly (readonly number[])[] = [[15, 17], [-17, -15]];
/** The sliders, each with the rays it moves along (a queen moves along both). */
const SLIDER_RAYS: readonly (readonly [PieceType, readonly number[]])[] =
  [[BISHOP, BISHOP_OFFSETS], [ROOK, ROOK_OFFSETS]];

const isSlider = (pieceType: PieceType): boolean => pieceType >= BISHOP && pieceType <= QUEEN;

/* The pseudo-legal moves of pos for the side to move, as a new array.
   King safety is checked by makeMove(). */
function generateMoves(pos: Position): Move[] {
  const board = pos.board, moves: Move[] = [];
  const us = pos.sideToMove, them = opponent(us);
  const up = PAWN_STEP[us];
  const startRank = us === WHITE ? 1 : 6;
  const promoRank = us === WHITE ? 7 : 0;
  // A pawn move, or its four promotions on the last rank.
  const pawnMove = (from: Square, to: Square, type: MoveType): void => {
    if (rankOf(to) === promoRank) {
      for (let promo = QUEEN; promo >= KNIGHT; promo--) moves.push(encodeMove(from, to, promo, 0));
    } else moves.push(encodeMove(from, to, 0, type));
  };

  for (const sq of SQUARES) {
    const piece = board[sq];
    if (piece === EMPTY || colourOf(piece) !== us) continue;
    const pieceType = typeOf(piece);

    if (pieceType === PAWN) {
      const push = sq + up;
      if (board[push] === EMPTY) {
        pawnMove(sq, push, 0);
        if (rankOf(sq) === startRank && board[push + up] === EMPTY) pawnMove(sq, push + up, 0);
      }
      for (const offset of PAWN_CAPTURE_OFFSETS[us]) {
        const to = sq + offset;
        if (!onBoard(to)) continue;
        const occupant = board[to];
        if (occupant !== EMPTY && colourOf(occupant) === them) pawnMove(sq, to, 0);
        else if (to === pos.epSquare) pawnMove(sq, to, FLAG_EP);
      }
      continue;
    }

    const slides = isSlider(pieceType);
    for (const offset of PIECE_OFFSETS[pieceType]) {
      for (let to = sq + offset; onBoard(to); to += offset) {
        const occupant = board[to];
        if (occupant === EMPTY) moves.push(encodeMove(sq, to, 0, 0));
        else {
          if (colourOf(occupant) === them) moves.push(encodeMove(sq, to, 0, 0));
          break;
        }
        if (!slides) break;
      }
    }
  }

  // Castling (standard and Chess960 alike): every square the king and
  // rook pass over or land on must be empty, apart from the two of
  // them, and the king may not start in, pass through or end in check.
  // All four squares are on one rank, so the squares between them are
  // consecutive numbers.
  for (const right of [castlingRight(us, true), castlingRight(us, false)]) {
    if (!hasRight(pos.castlingRights, right)) continue;
    const kFrom = pos.kingSq[us], rFrom = pos.castle.castlingRookSquare[right];
    const kTo = CASTLE_KING_TO[right], rTo = CASTLE_ROOK_TO[right];
    const lo = Math.min(kFrom, kTo, rFrom, rTo);
    const hi = Math.max(kFrom, kTo, rFrom, rTo);
    let ok = true;
    for (let sq = lo; sq <= hi && ok; sq++) {
      if (sq !== kFrom && sq !== rFrom && board[sq] !== EMPTY) ok = false;
    }
    const step = kTo > kFrom ? 1 : -1;
    for (let sq = kFrom; ok && sq !== kTo + step; sq += step) {
      if (isSquareAttacked(board, sq, them)) ok = false;
    }
    if (ok) moves.push(encodeMove(kFrom, rFrom, 0, FLAG_CASTLE));
  }
  return moves;
}

/* ---- Attacks -----------------------------------------------------

   Is square `sq` of `board` attacked by colour `by`? We look outward
   from it: is there a pawn/knight/king of that colour at the right
   offset, and along each ray, is the first piece we meet a slider
   that moves this way (or a queen)? Only the board matters, so
   makeMove() can ask before it has made a whole position.
*/
function isSquareAttacked(board: Board, sq: Square, by: Colour): boolean {
  const pawn = makePiece(PAWN, by), knight = makePiece(KNIGHT, by);
  const king = makePiece(KING, by), queen = makePiece(QUEEN, by);
  for (const offset of PAWN_CAPTURE_OFFSETS[by]) {
    const from = sq - offset;
    if (onBoard(from) && board[from] === pawn) return true;
  }
  for (const offset of KNIGHT_OFFSETS) {
    if (onBoard(sq + offset) && board[sq + offset] === knight) return true;
  }
  for (const offset of KING_OFFSETS) {
    if (onBoard(sq + offset) && board[sq + offset] === king) return true;
  }
  for (const [slider, offsets] of SLIDER_RAYS) {
    const attacker = makePiece(slider, by);
    for (const offset of offsets) {
      for (let from = sq + offset; onBoard(from); from += offset) {
        const piece = board[from];
        if (piece === EMPTY) continue;
        if (piece === attacker || piece === queen) return true;
        break;
      }
    }
  }
  return false;
}

/* ================================================================
   S5  ZOBRIST HASHING
   ================================================================

   Each (piece, square), each castling-rights set, each en passant
   file and the side to move gets a random 32-bit number. The
   position's key is the XOR of the numbers for everything in it, so
   it can be updated incrementally: XOR a piece's number in when it
   arrives on a square, and XOR it again (out) when it leaves. Two
   equal positions always have equal keys. The key is used to detect
   repetitions and to seed the skill levels' choices; a
   transposition table would be its third customer, and would want
   64 bits.

   The numbers come from a fixed-seed xorshift generator, so every
   machine gets the same keys (and so the same skill-level choices).
   They are drawn in a fixed order: 16 * 64 piece-square numbers (by
   piece * 64 + index64(sq)), 16 castling, 8 en passant, then the side.

   JavaScript's bitwise operators work on signed 32-bit integers, so
   a key is held as one (the same 32 bits as an unsigned key).
*/

/* The next state of a 32-bit xorshift generator. */
function xorshift32(x: number): number {
  const a = x ^ (x << 13);
  const b = a ^ (a >>> 17);
  return (b ^ (b << 5)) | 0;
}

function zobristKeys(seed: number) {
  const draws = new Int32Array(16 * 64 + 16 + 8 + 1);
  for (let i = 0, state = seed; i < draws.length; i++) {
    state = xorshift32(state);
    draws[i] = state;
  }
  return {
    zobPiece: draws.subarray(0, 1024),
    zobCastle: draws.subarray(1024, 1040),
    zobEp: draws.subarray(1040, 1048),
    zobSide: draws[1048],
  };
}

const { zobPiece, zobCastle, zobEp, zobSide } = zobristKeys(ZOBRIST_SEED);

/* ================================================================
   S6  UCI
   ================================================================

   The Universal Chess Interface: a GUI (or a match manager such as
   cutechess or OpenBench) writes commands on one line each, and we
   answer in kind.

   Everything the engine remembers between commands is one session
   value: { pos, skill, chess960 }. uciCommand(session, line, io)
   handles one line and returns the session for the next one. `io`
   is how it talks to the world: { out(line), now(), shouldStop() }.
   The I/O code at the end of the file wires it to stdin/stdout in
   Bun or to postMessage in a browser Web Worker.
*/

/** Everything the engine remembers between UCI commands. */
interface Session {
  readonly pos: Position;
  readonly skill: Skill;
  readonly chess960: boolean;
}

/** How uciCommand talks to the world: output, a clock and a stop request. */
interface Io {
  out(line: string): void;
  now(): Millis;
  shouldStop(): boolean;
}

const GO_NUMBERS = ["wtime", "btime", "winc", "binc", "movestogo", "depth", "nodes", "movetime"] as const;
type GoNumber = typeof GO_NUMBERS[number];
/** A parsed "go" command: whichever of the numbers it gave, plus infinite. */
type Go = { readonly [K in GoNumber]?: number } & { readonly infinite?: boolean };
const isGoNumber = (word: string): word is GoNumber => (GO_NUMBERS as readonly string[]).includes(word);

function newSession(): Session {
  return { pos: parseFen(START_FEN), skill: skillFor(SKILL_MAX, 0, true), chess960: false };
}

function uciCommand(session: Session, line: string, io: Io): Session {
  const tokens = words(line);
  const { pos, skill, chess960 } = session;
  switch (tokens[0]) {
    case "uci":
      io.out(`id name ${NAME} ${VERSION}`);
      io.out("id author Copilot (Claude Fable 5.1)");
      // ---- UCI options ------------------------------------------------
      // Accepted, no effect: there is no transposition table yet.
      io.out("option name Hash type spin default 16 min 1 max 1024");

      // Accepted for OpenBench; always single-threaded.
      io.out("option name Threads type spin default 1 min 1 max 1");

      // Castling notation: king-takes-rook.
      io.out("option name UCI_Chess960 type check default false");

      // 1 = random mover, SKILL_MAX = strongest
      io.out(`option name Skill_Level type spin default ${SKILL_MAX} min 1 max ${SKILL_MAX}`);

      // Which deterministic opponent; 0 = built-in.
      io.out("option name Skill_Seed type spin default 0 min 0 max 2147483647");

      // Playing style: aggressive (the default) or plain, each with its own ladder.
      io.out("option name Aggressive type check default true");

      io.out("uciok");
      return session;
    case "setoption": {
      const nameAt = tokens.indexOf("name"), valueAt = tokens.indexOf("value");
      const name = tokens
        .slice(nameAt + 1, valueAt > 0 ? valueAt : tokens.length)
        .join(" ")
        .toLowerCase();
      const value = valueAt > 0 ? tokens.slice(valueAt + 1).join(" ") : "";
      if (name === "uci_chess960")
        return { ...session, chess960: value.toLowerCase() === "true" };
      if (name === "skill_level") {
        const level = toInteger(value, SKILL_MAX);
        return { ...session, skill: skillFor(level, skill.seed, skill.aggressive) };
      }
      if (name === "skill_seed")
        return { ...session, skill: skillFor(skill.level, toInteger(value, 0), skill.aggressive) };
      if (name === "aggressive") {
        const aggressive = value.toLowerCase() !== "false";
        return { ...session, skill: skillFor(skill.level, skill.seed, aggressive) };
      }
      return session; // "hash" and "threads" are accepted and ignored
    }
    case "isready":
      io.out("readyok");
      return session;
    case "ucinewgame":
      return { ...session, pos: parseFen(START_FEN) };
    case "position":
      return { ...session, pos: parsePosition(tokens.slice(1).join(" "), chess960) };
    case "go": {
      const result = think(pos, limitsFor(parseGo(tokens), pos.sideToMove, skill.level), skill, {
        now: io.now,
        shouldStop: io.shouldStop,
        onInfo: (info) => io.out(infoLine(info, chess960)),
      });
      io.out("bestmove " + (result.bestMove !== NO_MOVE ? moveToUci(result.bestMove, chess960) : "0000"));
      return session;
    }
    case "stop":
      return session; // handled by the I/O layer while searching
    case "quit":
      io.out("quit"); // echoed back so the I/O layer knows the queue is drained
      return session;
    case "bench":
      bench(toInteger(tokens[1], BENCH_DEPTH), io);
      return session;
    case "perft":
      perftDivide(pos, toInteger(tokens[1], 4), chess960, io);
      return session;
    case "d":
      printBoard(pos, skill, chess960, io.out);
      return session;
    case "eval":
      io.out(`eval ${judge(pos, skill)} (side to move)`);
      return session;
    default:
      return session;
  }
}

/* A new position from the arguments of a UCI "position" command:
   "startpos" or "fen <FEN>", optionally followed by "moves ...". */
function parsePosition(spec: string, chess960: boolean): Position {
  const tokens = words(spec);
  const movesAt = tokens.indexOf("moves");
  const end = movesAt >= 0 ? movesAt : tokens.length;
  const fen = tokens[0] === "fen" ? tokens.slice(1, end).join(" ") : START_FEN;
  const moves = tokens.slice(end + 1);
  return moves.reduce((pos, str) => {
    const move = parseMove(pos, str, chess960);
    return move !== NO_MOVE ? makeLegalMove(pos, move) : pos; // an unknown move is skipped
  }, parseFen(fen));
}

/* The numbers of a "go" command, e.g. { wtime: 60000, winc: 1000 }.
   Unknown words are skipped. */
function parseGo(tokens: readonly string[]): Go {
  let go: Go = {};
  for (let i = 1; i < tokens.length; i++) {
    const word = tokens[i], value = toInteger(tokens[i + 1], NaN);
    if (word === "infinite") go = { ...go, infinite: true };
    else if (isGoNumber(word) && !Number.isNaN(value)) {
      go = { ...go, [word]: value };
      i++;
    }
  }
  return go;
}

/* The UCI "info" line for one finished depth of think(). */
function infoLine(result: Result, chess960: boolean): string {
  const { depth, score, nodes, elapsed, pv } = result;
  const nps = elapsed > 0 ? Math.floor(nodes * 1000 / elapsed) : 0;
  const scoreText = isMateScore(score)
    ? "mate " + (score > 0 ? (MATE - score + 1) >> 1 : -((MATE + score) >> 1))
    : "cp " + score;
  const line = pv.map((move) => " " + moveToUci(move, chess960)).join("");
  return `info depth ${depth} multipv 1 score ${scoreText} nodes ${nodes} ` +
    `nps ${nps} time ${elapsed} pv${line}`;
}

/* ---- Perft: count leaf nodes to a depth; the standard way to test a
   move generator. */
function perft(pos: Position, depth: number): number {
  if (depth === 0) return 1;
  let count = 0;
  for (const move of generateMoves(pos)) {
    const next = makeMove(pos, move);
    if (next !== null) count += perft(next, depth - 1);
  }
  return count;
}

function perftDivide(pos: Position, depth: number, chess960: boolean, io: Io): void {
  const t0 = io.now();
  let total = 0;
  for (const move of legalMoves(pos)) {
    const count = perft(makeLegalMove(pos, move), depth - 1);
    total += count;
    io.out(`${moveToUci(move, chess960)}: ${count}`);
  }
  const ms = Math.max(1, Math.round(io.now() - t0));
  io.out(`perft ${depth} nodes ${total} time ${ms} nps ${Math.floor(total * 1000 / ms)}`);
}

/* ---- Bench: a fixed set of positions to a fixed depth, at the top
   level. OpenBench reads the final "N nodes M nps" line and uses
   the node count as a signature of the search. */
const BENCH_DEPTH = 5;
const BENCH_FENS: readonly string[] = [
  START_FEN,
  "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
  "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
  "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1",
  "rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8",
  "r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10",
  "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4",
  "2rq1rk1/pp1bppbp/3p1np1/8/3NP3/1BN1BP2/PPPQ2PP/2KR3R w - - 0 12",
  "8/8/1p1k4/p1p2p2/P1P2P2/1P1K4/8/8 w - - 0 1",
  "6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1",
  "r2q1rk1/ppp2ppp/2n1bn2/2bpp3/3PP3/2P2N2/PP1NBPPP/R1BQ1RK1 b - - 0 9",
  "1k1r4/pp1b1R2/3q2pp/4p3/2B5/4Q3/PPP2B2/2K5 b - - 0 1",
];

function bench(depth: number, io: Io): void {
  const skill = skillFor(SKILL_MAX, 0, true);
  let totalNodes = 0, totalMs = 0;
  for (const fen of BENCH_FENS) {
    const pos = parseFen(fen);
    const t0 = io.now();
    const { nodes } = think(pos, limitsFor({ depth }, pos.sideToMove, SKILL_MAX), skill, {
      now: io.now, shouldStop: () => false, onInfo: () => {},
    });
    totalMs += io.now() - t0;
    totalNodes += nodes;
    io.out(`info string ${nodes} nodes  ${fen}`);
  }
  io.out(`${totalNodes} nodes ${Math.floor(totalNodes * 1000 / Math.max(1, totalMs))} nps`);
}

/* The "d" command: the board, its FEN, key and evaluation. */
function printBoard(pos: Position, skill: Skill, chess960: boolean, out: (line: string) => void): void {
  for (let rank = 7; rank >= 0; rank--) {
    let row = `${rank + 1} `;
    for (let file = 0; file < 8; file++) row += " " + PIECE_CHARS[pos.board[makeSquare(file, rank)]];
    out(row);
  }
  out("   a b c d e f g h");
  out(`fen ${toFen(pos, chess960)}`);
  out(`key ${(pos.key >>> 0).toString(16).padStart(8, "0")}`);
  out(`eval ${judge(pos, skill)} (side to move)`);
}

/* ---- Start-up and I/O ---------------------------------------------
   Search is single-threaded, but normal UCI operation uses two
   threads: the main thread reads input and the worker searches.
   In a browser, the page is the main thread (see web/index.html).
   The direct Bun bench command below runs without a worker.

   Search is synchronous: the worker cannot process another message
   until think() returns. A posted "stop" message would therefore
   arrive too late. Instead, the main thread sets a stop flag in a
   SharedArrayBuffer and the worker's shouldStop() polls it during
   search. Atomics.store/load synchronize that shared flag across
   threads; they do not make the search parallel. Ordinary commands
   and results still travel through worker messages.

   Each host below keeps the current session in its own `let session`
   and replaces it with whatever uciCommand() returns. A port to a
   language with threads needs only the first host: a thread that
   searches, and a shared flag the input loop sets. */

// Just enough of the hosts' APIs for the type checker: Bun, a worker
// and the page. (Declarations only; they vanish with the types.)
declare const Bun: { readonly isMainThread: boolean; readonly main: string };
declare const process: { readonly argv: readonly string[]; exit(code: number): never };
declare const console: { log(line: string): void } & AsyncIterable<string>;
declare const performance: { now(): number };
declare const WorkerGlobalScope: abstract new () => object;
declare const self: {
  postMessage(message: string): void;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
};
declare class Worker {
  constructor(url: string);
  postMessage(message: unknown): void;
  onmessage: ((event: { readonly data: string }) => void) | null;
}
declare var Pedagog: { uci(line: string): void; setOutput(fn: (line: string) => void): void };

const isBun = typeof Bun !== "undefined";
const inWorker = isBun ? !Bun.isMainThread
  : typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope;

if (isBun && Bun.isMainThread) {
  if (process.argv[2] === "bench") {
    // `bun engine.ts bench [depth]`, as OpenBench runs it.
    const io: Io = { out: (line) => console.log(line), now, shouldStop: () => false };
    uciCommand(newSession(), "bench " + (process.argv[3] ?? ""), io);
    process.exit(0);
  }
  const flag = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(Bun.main);
  worker.postMessage({ stopFlag: flag });
  let searching = false;
  worker.onmessage = (e) => {
    if (e.data === "quit") process.exit(0);
    if (e.data.startsWith("bestmove")) searching = false;
    console.log(e.data);
  };
  (async () => {
    for await (const line of console) {
      const cmd = words(line)[0];
      if (cmd === "quit") { Atomics.store(flag, 0, 1); process.exit(0); }
      else if (cmd === "stop") Atomics.store(flag, 0, 1);
      else if (cmd === "isready" && searching) console.log("readyok");
      else {
        if (cmd === "go") { Atomics.store(flag, 0, 0); searching = true; }
        worker.postMessage(line);
      }
    }
    worker.postMessage("quit");
    // Stdin closed: let the worker finish its queue, then exit.
  })();
} else if (inWorker) {
  // Until the main thread's shared flag arrives, a flag of our own
  // that is never set.
  let session = newSession(), stopFlag: Int32Array = new Int32Array(new SharedArrayBuffer(4));
  const io: Io = {
    out: (line) => self.postMessage(line),
    now,
    shouldStop: () => Atomics.load(stopFlag, 0) !== 0,
  };
  self.onmessage = (e) => {
    const data = e.data;
    if (typeof data === "string") session = uciCommand(session, data, io);
    else if (typeof data === "object" && data !== null && "stopFlag" in data)
      stopFlag = data.stopFlag as Int32Array;
  };
} else {
  // Browser main thread (or any other host): drive it by hand.
  let session = newSession(), output = (line: string) => console.log(line);
  const io: Io = { out: (line) => output(line), now, shouldStop: () => false };
  globalThis.Pedagog = {
    uci: (line) => { session = uciCommand(session, line, io); },
    setOutput: (fn) => { output = fn; },
  };
}
