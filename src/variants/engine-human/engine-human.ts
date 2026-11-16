/*
================================================================
               P E D A G O G   ( H U M A N )
================================================================
   A variant of engine.ts whose top two levels play like a
   1900-rated Lichess player: they score every legal move with a
   weighted sum of move features learned from human games
   (src/variants/engine-human/train.ts) and play the best one.
   Level 9 does not search at all; level 10 also weighs how much
   worse each move is than the best by a 2-ply search. Levels 1-8
   are engine.ts's. Everything below is engine.ts but for section
   S2b and the call to it at the top of think().

   Runs in Bun, which runs TypeScript directly (`bun engine.ts`), or
   in a browser Web Worker. Browsers cannot run TypeScript, so the
   web app gets engine.js, this file with its types removed
   (src/tools/engine-js.js does that for `bun run web` and
   `bun run build`).
================================================================

   TABLE OF CONTENTS
   -----------------
   S0  Constants           Pieces, squares, board layout, moves
   S1  Search              Iterative deepening, alpha-beta, ordering
   S2  Skill Levels        Depth ceiling, blunders, vision
   S2b Human Move Choice   Move features and their learned weights
   S3  Evaluation          A naive piece-square evaluation
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

/* The other colour. */
function opponent(colour: Colour): Colour {
  return colour === WHITE ? BLACK : WHITE;
}
/* The type of `piece`, PAWN to KING (EMPTY for an empty square). */
function typeOf(piece: Piece): PieceType {
  return piece & 7;
}
/* The colour of `piece`, which must not be EMPTY. */
function colourOf(piece: Piece): Colour {
  return (piece >> 3) as Colour;
}
/* The piece of `pieceType` and `colour`, packed: type | colour << 3. */
function makePiece(pieceType: PieceType, colour: Colour): Piece {
  return pieceType | (colour << 3);
}

// ---- The board layout: the only code that knows squares are 0x88.
const BOARD_SIZE = 128;
/* The file of `sq`, 0 (a) to 7 (h). */
function fileOf(sq: Square): File {
  return sq & 7;
}
/* The rank of `sq`, 0 (rank 1) to 7 (rank 8). */
function rankOf(sq: Square): Rank {
  return sq >> 4;
}
/* The square on `file` and `rank`. */
function makeSquare(file: File, rank: Rank): Square {
  return rank * 16 + file;
}
/* Is `sq` on the board? Off-board 0x88 squares have bit 3 or 7 set. */
function onBoard(sq: Square): boolean {
  return (sq & 0x88) === 0;
}
/* The same square seen from black's side: a1 <-> a8. */
function flipRank(sq: Square): Square {
  return makeSquare(fileOf(sq), 7 - rankOf(sq));
}
/* The index of `sq` from 0 (a1) to 63 (h8), used by the Zobrist keys
   and the piece-square tables so they work with any board layout. */
function index64(sq: Square): Index64 {
  return rankOf(sq) * 8 + fileOf(sq);
}
/** The 64 squares, a1, b1, ... h8: the order every board walk uses. */
const SQUARES: readonly Square[] = Array.from({ length: 64 },
  (_, i) => makeSquare(i % 8, Math.floor(i / 8)));
/** One square forward for a pawn of each colour. */
const PAWN_STEP: readonly [number, number] = [16, -16];

/* The square `move` starts from. */
function fromSq(move: Move): Square {
  return move & 127;
}
/* The square `move` goes to. For castling, the rook's square. */
function toSq(move: Move): Square {
  return (move >> 7) & 127;
}
/* The piece type `move` promotes to, or 0. */
function promoType(move: Move): PieceType {
  return (move >> 14) & 7;
}
/* The kind of `move`: 0 (normal), FLAG_EP or FLAG_CASTLE. */
function moveType(move: Move): MoveType {
  return (move >> 17) & 3;
}
/* The four parts of a move packed into one number: from in bits
   0-6, to in 7-13, promo in 14-16, type in 17-18. */
function encodeMove(
  from: Square, to: Square, promo: PieceType, type: MoveType,
): Move {
  return from | (to << 7) | (promo << 14) | (type << 17);
}

/* The algebraic name of `sq`, such as "e4". */
function squareName(sq: Square): string {
  return FILE_NAMES[fileOf(sq)] + RANK_NAMES[rankOf(sq)];
}
/* The square named by `str`, such as "e4". */
function parseSquare(str: string): Square {
  return makeSquare(FILE_NAMES.indexOf(str[0]), RANK_NAMES.indexOf(str[1]));
}

/* Milliseconds from a high-resolution clock. */
function now(): Millis {
  return performance.now();
}

/* ================================================================
   S1  SEARCH
   ================================================================

   The search answers one question: which move is best? It looks
   ahead a fixed number of plies with negamax alpha-beta, trying
   captures first, and asks the static evaluation about the
   positions at the leaves. That is the whole search: there is no
   quiescence search, no hash table and no pruning beyond alpha-beta
   itself.

   think(pos, limits, skill, io)
               iterative deepening: depth 1, 2, 3, ... until a limit
               is reached. Returns the result of the last finished
               depth, so there is always a complete answer.
   Search.search(pos, alpha, beta, depth, ply)
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
   the Chess Programming Wiki's fail-soft Alpha-Beta, with judge() in
   place of Evaluate.

   Scores are always from the point of view of the side to move
   (negamax): +100 means "the side to move is a pawn up". A child's
   score is negated on the way back up, because what is good for
   one side is bad for the other.
*/

const NO_LINE: Pv = Object.freeze([]);

/** How far and how long to search. After softMs no new depth
    starts; at hardMs the search is cut off. */
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

/** What think() needs from the world: a clock, a stop request and
    a place to report each depth. */
interface SearchIo {
  now(): Millis;
  shouldStop(): boolean;
  onInfo(result: Result): void;
}

const STOPPED: Line = Object.freeze({ score: 0, pv: NO_LINE });

/* Choose a move for `pos` within `limits` (from limitsFor()), playing
   as `skill` (from skillFor()). `io` supplies the clock, `now()`; a
   stop request, `shouldStop()`; and `onInfo(result)`, called after
   every finished depth. Returns the last finished depth's Result (a
   depth cut short by a stop is thrown away); bestMove is NO_MOVE when
   there is no legal move. */
function think(
  pos: Position, limits: Limits, skill: Skill, io: SearchIo,
): Result {
  const startTime = io.now();
  const rootMoves = legalMoves(pos);
  if (rootMoves.length === 0)
    return {
      bestMove: NO_MOVE, depth: 0, score: 0, nodes: 0, elapsed: 0,
      pv: NO_LINE,
    };

  if (skill.level === 1) {
    const move = mateOrRandomMove(pos, skill, rootMoves);
    const result = {
      bestMove: move, depth: 1, score: 0,
      nodes: rootMoves.length, elapsed: 0, pv: [move],
    };
    io.onInfo(result);
    return result;
  }

  if (skill.level >= SKILL_MAX - 1) {
    const withSearch = skill.level === SKILL_MAX;
    const move = humanMove(pos, rootMoves, withSearch);
    const result = {
      bestMove: move, depth: withSearch ? 2 : 1, score: 0,
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
    const { score, pv } = search.root(pos, depth);
    if (search.stopped) break;
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

  /* A search with no nodes counted yet. */
  constructor(
    limits: Limits, skill: Skill, io: SearchIo,
    unseen: Pv, startTime: Millis,
  ) {
    this.limits = limits;
    this.skill = skill;
    this.io = io;
    this.unseen = unseen;
    this.startTime = startTime;
  }

  /* One iteration of think(): the root searched to `depth`. */
  root(pos: Position, depth: number): Line {
    this.rootDepth = depth;
    return this.search(pos, -INF, INF, depth, 0);
  }

  /* Negamax to a fixed depth: terminate, try moves, keep the best line
     (the best move, then its reply line), and stop at a beta cutoff,
     as the opponent would never allow that line. A leaf is judged as
     it stands. makeMove() returns null for a move that leaves our king
     in check. With no legal move, the position is checkmate or
     stalemate.

     The skill may overlook a move (overlooks()). If it overlooks
     every legal move, it judges the position as it stands. */
  search(
    pos: Position, alpha: Score, beta: Score,
    depth: number, ply: number,
  ): Line {
    if (this.countNodeAndCheckStop()) return STOPPED;
    if (ply > 0 && isDraw(pos)) return { score: DRAW, pv: NO_LINE };
    const atLeaf = depth === 0 || ply >= MAX_PLY - 1;
    if (atLeaf) return { score: judge(pos, this.skill), pv: NO_LINE };

    let bestScore = -INF, pv = NO_LINE;
    let raisedAlpha = alpha; // alpha, raised as better moves are found
    let legalMoveCount = 0;
    for (const move of orderMoves(pos, generateMoves(pos))) {
      const next = makeMove(pos, move);
      if (next === null) continue;
      legalMoveCount++;
      if (this.overlooks(next, move, ply)) continue;
      const child = this.search(next, -beta, -raisedAlpha,
        depth - 1, ply + 1);
      if (this.stopped) return STOPPED;

      const score = -child.score;
      if (score > bestScore) {
        bestScore = score;
        if (score > raisedAlpha) {
          raisedAlpha = score;
          pv = [move, ...child.pv];
          if (raisedAlpha >= beta) break;
        }
      }
    }

    if (legalMoveCount === 0)
      return { score: inCheck(pos) ? -MATE + ply : DRAW, pv: NO_LINE };
    const overlookedAll = bestScore === -INF;
    if (overlookedAll)
      return { score: judge(pos, this.skill), pv: NO_LINE };
    return { score: bestScore, pv };
  }

  /* Does the player fail to notice `move`, made at `ply` and leading
     to `next`? At the root the overlooked moves were chosen in
     advance; deeper, seesMove() decides. */
  overlooks(next: Position, move: Move, ply: number): boolean {
    return ply === 0
      ? this.unseen.includes(move)
      : !seesMove(next, this.skill, move, ply);
  }

  /* Count a node and say whether to stop. The limits are checked
     every 1024 nodes from depth 2 on: the first depth always
     finishes, so there is always a move to play. */
  countNodeAndCheckStop(): boolean {
    this.nodes++;
    const checkNow = this.rootDepth > 1 && this.nodes % 1024 === 0;
    if (checkNow && this.limitReached()) this.stopped = true;
    return this.stopped;
  }

  /* Has the node limit or the hard time limit been reached, or a stop
     been asked for? */
  limitReached(): boolean {
    return (this.limits.nodes > 0 && this.nodes >= this.limits.nodes) ||
      this.io.now() - this.startTime >= this.limits.hardMs ||
      this.io.shouldStop();
  }
}

/* Is `score` a mate score rather than an evaluation? */
function isMateScore(score: Score): boolean {
  return Math.abs(score) >= MATE_IN_MAX_PLY;
}

/* ---- Move ordering --------------------------------------------
   Alpha-beta prunes most when a good move is tried first, and the
   simplest guess at a good move is a capture. So: captures (and
   promotions) first, then the quiet moves, each group in the order
   it was generated. Returns a new array. */
function orderMoves(pos: Position, moves: Pv): Move[] {
  return [
    ...moves.filter((move) => isCapture(pos, move)),
    ...moves.filter((move) => !isCapture(pos, move)),
  ];
}

/* Does `move` take a piece or promote? Castling ("king takes own
   rook") does not count. */
function isCapture(pos: Position, move: Move): boolean {
  return moveType(move) !== FLAG_CASTLE &&
    (pos.board[toSq(move)] !== EMPTY || moveType(move) === FLAG_EP ||
      promoType(move) !== 0);
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
const TIME_RESERVE: Millis = 1000;   // the first second is never spent

/* The search limits for a "go" command `go`, with `side` to move,
   playing at `level`. */
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
  const usable = Math.max(0, time - TIME_RESERVE);
  const incShare = Math.floor(3 * inc / 4);
  const softMs = Math.max(1,
    Math.floor(usable / movesToGo) + incShare - MOVE_OVERHEAD);
  const budget = Math.floor(usable / 4) + incShare - MOVE_OVERHEAD;
  const hardMs = Math.max(1, Math.min(2 * softMs, budget));
  return { ...untimed, softMs, hardMs };
}

/* ================================================================
   S2  SKILL LEVELS
   ================================================================

   Deliberately weakened play, for opponents meant to be beatable,
   after Gaia (jromang/gaiachess, src/skill.rs). Every level is
   weakened: the top one only searches less far, to match Maia-1900;
   the full search would be far stronger.

   Searching less far is not enough on its own: a shallow but
   otherwise flawless player is dull, never careless. So a level
   turns three settings at once:

     depth      how far ahead it looks, plus a chance of one extra
                ply on some positions so a level can sit between two
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

   (Gaia has a fourth setting, evaluation fidelity, and a small error
   on every position. Both were measured here and found to be worth
   nothing with this evaluation, so they were left out; see
   docs/COLOPHON.md.)

   Every choice is drawn from the position's key and the Skill_Seed,
   never from the clock or a random generator, so a level misjudges
   the same position the same way every time: stable blind spots, not
   a tremor. Level 1 is apart: it plays a random legal move, but
   always mates in one when it can. Levels 2..SKILL_MAX come from
   LEVEL_SETTINGS below, which also lists their measured ratings.

   A skill is a frozen value made by skillFor(level, seed); the
   functions below take it as an argument.
*/

const SKILL_MAX = 10;
const FULL_VISION = 1024;
const VISION_SLOPE = 16, VISION_FLOOR = 160;
// Vision lost per ply, and its minimum.

/* Hashing constants, here and in zobristKeys(). The two multipliers
   were chosen for how well they scramble bits. The seeds and the
   salt are arbitrary (any distinct nonzero values would do), but
   changing any of them changes which positions each skill level
   misjudges. */
const GOLDEN = 0x9E3779B9;          // 2^32 / golden ratio (Fibonacci hashing)
const MIX_MULTIPLIER = 0x45d9f3b;   // from a well-known 32-bit integer hash
const BUILT_IN_SEED = 0x9E3779B9;   // stands in for Skill_Seed 0
const DEPTH_SALT = 0xA5A55A5A;      // keeps the depth draw apart from others
const ZOBRIST_SEED = 0x2545F491;    // seeds zobristKeys()

/** One level's settings. */
interface LevelSettings {
  readonly depth: number;
  readonly deeperPermille: number;  // share of positions searched a ply deeper
  readonly blunderWindow: Score;    // largest misjudgement, either way
  readonly blunderPermille: number; // share of positions misjudged
  readonly vision: number;          // chance, out of 1024, of noticing a move
}

/* One level's settings; each argument is one setting. */
function settings(depth: number, deeperPermille: number, blunderWindow: Score,
  blunderPermille: number, vision: number): LevelSettings {
  return { depth, deeperPermille, blunderWindow, blunderPermille, vision };
}

/* Settings for each level, from a beginner's opponent up to
   Maia-1900's strength, evenly spaced about 100 Elo apart. The
   ratings are on the Lichess classical scale: Maia-1900's bot (maia9)
   was rated 1755 there, and the fit is anchored on it (see
   docs/COLOPHON.md). Measured in 28 pairings of 300 games: each level
   against the one below and against Maia-1100, -1500 and -1900, fitted
   by src/tools/elo.js. Every level is a depth, never a time budget, so it
   plays the same on any machine. Level n is at index n - 1; level 1,
   the random mover, ignores its settings. */
const LEVEL_SETTINGS: readonly LevelSettings[] = [
  //       depth  deeper  blunder  b/1000  vision           target  measured
  settings(0,       0,       0,      0,       0),    //  1    ~170
  settings(2,      99,     507,     46,     850),    //  2     945      905
  settings(2,     199,     465,     41,     888),    //  3    1046     1026
  settings(2,     370,     414,     35,     931),    //  4    1148     1149
  settings(2,     554,     394,     30,     949),    //  5    1249     1219
  settings(2,     829,     361,     23,     971),    //  6    1350     1351
  settings(3,     164,     311,     17,     989),    //  7    1451     1442
  settings(3,     646,     221,     10,    1004),    //  8    1553     1543
  settings(4,     117,     115,      5,    1015),    //  9    1654     1646
  settings(4,     450,       0,      0,    1024),    // 10    1755     1741
];

/** One seeded opponent: a level's settings. */
interface Skill extends LevelSettings {
  readonly level: number;
  readonly seed: number;
  readonly seedKey: number;        // the seed, hashed
}

/* The skill for a Skill_Level (clamped to 1..SKILL_MAX) and a
   Skill_Seed: its level's settings. The seed picks which weakened
   opponent a level is; 0 means the built-in one, so an engine nobody
   configures still plays the same game twice. */
function skillFor(level: number, seed: number): Skill {
  const clamped = Math.min(SKILL_MAX, Math.max(1, Math.trunc(level)));
  return Object.freeze({
    ...LEVEL_SETTINGS[clamped - 1],
    level: clamped,
    seed,
    seedKey: mix32(seed === 0 ? BUILT_IN_SEED : seed),
  });
}

/* Depth ceiling for `pos`: the level's depth, and one more on the
   level's share of positions, decided by the hash. */
function depthFor(pos: Position, skill: Skill): number {
  if (skill.deeperPermille === 0) return skill.depth;
  const hash = mix32(pos.key ^ skill.seedKey ^ DEPTH_SALT);
  return skill.depth + (hash % 1000 < skill.deeperPermille ? 1 : 0);
}

/* What this skill makes of `pos`: the evaluation and, now and then,
   a misjudgement. This is what the search sees at a leaf. */
function judge(pos: Position, skill: Skill): Score {
  return evaluate(pos) + blunder(pos, skill);
}

/* The occasional misjudgement, added to the evaluation of the level's
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
function seesMove(
  after: Position, skill: Skill, move: Move, ply: number,
): boolean {
  if (skill.vision >= FULL_VISION) return true;
  const chance = Math.max(skill.vision - VISION_SLOPE * ply, VISION_FLOOR);
  const hash = mix32(after.key ^ Math.imul(move, GOLDEN) ^ skill.seedKey);
  if (((hash >>> 20) & 1023) < chance) return true;
  const easy = after.capturedPiece !== EMPTY ||
    moveType(move) === FLAG_EP || inCheck(after);
  return easy && ((hash >>> 8) & 1023) < chance;
}

/* The root moves the player overlooks. If it would overlook them all,
   it sees them all: a move has to be played. */
function overlookedRootMoves(
  pos: Position, skill: Skill, rootMoves: Pv,
): Move[] {
  if (skill.vision >= FULL_VISION) return [];
  const unseen = rootMoves.filter((move) =>
    !seesMove(makeLegalMove(pos, move), skill, move, 0));
  return unseen.length === rootMoves.length ? [] : unseen;
}

/* Level 1: a random legal move from `moves`, unless one mates on the
   spot. */
function mateOrRandomMove(pos: Position, skill: Skill, moves: Pv): Move {
  return moves.find((move) => givesMate(pos, move)) ??
    moves[mix32(pos.key ^ skill.seedKey) % moves.length];
}

/* Does the legal `move` checkmate? */
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
   S2b HUMAN MOVE CHOICE
   ================================================================

   The top two levels do not search the usual way. Every legal move
   gets a few features, all seen from the mover's side of the board
   (black's squares mirrored), and the move whose features' weights
   add up to the most is played; a tie goes to the move generated
   first. The weights were fitted as a softmax over each position's
   legal moves to positions from Lichess games between players rated
   1900-1999 (October 2019). Level 9 uses HUMAN_WEIGHTS (about a
   million positions; 36.8 % of the moves of Maia's 1900 test set,
   December 2019). Level 10 uses HUMAN_SEARCH_WEIGHTS, which add the
   LOSS features below (about 500,000 positions; 37.5 %).

   Features (offsets into HUMAN_WEIGHTS):
     TO        0  phase x piece type x destination square   1152
     FROM   1152  phase x piece type x origin square        1152
     CAPTURE 2304 capturing x captured piece type             36
     RECAPTURE 2340  takes on the square the opponent's last
                  move went to                                  1
     CHECK  2341  gives check                                   1
     PROMO  2342  promotes to knight, bishop, rook, queen       4
     CASTLE 2346  castles kingside, queenside                   2
     HANG   2348  the moved piece lands en prise, by type       6
     RESCUE 2354  the moved piece was en prise and is no
                  longer, by type                               6
     THREAT 2360  the moved piece attacks one enemy piece
                  worth more or undefended, by moved type       6
     FORK   2366  ... two or more of them                       6
     DEFEND 2372  another of our pieces was en prise and is no
                  longer, by the most valuable such piece       6
     LEAVE  2378  another of our pieces is en prise after the
                  move, by the most valuable such piece         6
     LOSS   2384  (level 10 only) how much worse the move is
                  than the best by a 2-ply search at level 10's
                  evaluation: 0 (the best), up to 25, 50, 100,
                  200 or 400 centipawns, or more                7
   Phase: endgame if the material phase (knight and bishop 1, rook
   2, queen 4) is 8 or less, else opening before ply 30, else
   middlegame. "En prise": attacked by a cheaper enemy piece, or
   attacked and not defended (x-rays and pins are ignored).
*/

const F_TO = 0, F_FROM = 1152, F_CAPTURE = 2304, F_RECAPTURE = 2340, F_CHECK = 2341, F_PROMO = 2342;
const F_CASTLE = 2346, F_HANG = 2348, F_RESCUE = 2354, F_THREAT = 2360, F_FORK = 2366;
const F_DEFEND = 2372, F_LEAVE = 2378, F_LOSS = 2384;
const LOSS_LIMITS: readonly Score[] = [0, 25, 50, 100, 200, 400];
const HUMAN_VALUE: readonly number[] = [0, 1, 3, 3, 5, 9, 100];
const HUMAN_PHASE_WEIGHT: readonly number[] = [0, 0, 1, 1, 2, 4, 0];

/* The legal move of `moves` (the legal moves of `pos`) that a 1900
   player is likeliest to play; `withSearch` adds the LOSS
   features and their weights. */
function humanMove(pos: Position, moves: Pv, withSearch: boolean): Move {
  const lastTo = lastMoveTo(pos);
  const weights = withSearch ? HUMAN_SEARCH_WEIGHTS : HUMAN_WEIGHTS;
  const values = withSearch ? moves.map((move) => valueAfter(makeLegalMove(pos, move))) : [];
  const bestValue = Math.max(...values);
  let best = moves[0], bestScore = -Infinity;
  moves.forEach((move, i) => {
    const features = withSearch
      ? [...humanFeatures(pos, move, lastTo), lossFeature(bestValue - values[i])]
      : humanFeatures(pos, move, lastTo);
    const score = features.reduce((sum, k) => sum + weights[k], 0);
    if (score > bestScore) {
      best = move;
      bestScore = score;
    }
  });
  return best;
}

/* The value of `next`, just reached by our move, for us: minus the
   opponent's best reply one ply on, judged at level 10. */
function valueAfter(next: Position): Score {
  const limits: Limits = { depth: MAX_PLY, nodes: 0, softMs: NO_TIME_LIMIT, hardMs: NO_TIME_LIMIT };
  const io: SearchIo = { now: () => 0, shouldStop: () => false, onInfo: () => {} };
  const search = new Search(limits, skillFor(SKILL_MAX, 0), io, NO_LINE, 0);
  return -search.search(next, -INF, INF, 1, 1).score;
}

/* The LOSS feature of a move `loss` centipawns worse than the best. */
function lossFeature(loss: Score): number {
  const band = LOSS_LIMITS.findIndex((limit) => loss <= limit);
  return F_LOSS + (band === -1 ? LOSS_LIMITS.length : band);
}

/* The square the opponent's last move went to (for castling, the
   king's square), or NO_SQUARE at the start. */
function lastMoveTo(pos: Position): Square {
  const before = pos.previous;
  if (before === null) return NO_SQUARE;
  const them = opponent(pos.sideToMove);
  let found = NO_SQUARE;
  for (const sq of SQUARES) {
    const piece = pos.board[sq];
    if (piece !== before.board[sq] && piece !== EMPTY && colourOf(piece) === them &&
      (found === NO_SQUARE || typeOf(piece) === KING)) found = sq;
  }
  return found;
}

/* The value of the cheapest piece of `by` attacking `sq` on `board`,
   or 0. */
function cheapestAttacker(board: Board, sq: Square, by: Colour): number {
  const own = (pieceType: PieceType) => makePiece(pieceType, by);
  for (const s of by === WHITE ? [sq - 15, sq - 17] : [sq + 15, sq + 17]) {
    if (onBoard(s) && board[s] === own(PAWN)) return 1;
  }
  if (KNIGHT_OFFSETS.some((d) => onBoard(sq + d) && board[sq + d] === own(KNIGHT))) return 3;
  let best = 0;
  const slide = (dirs: readonly number[], types: readonly PieceType[]) => {
    for (const d of dirs) {
      for (let s = sq + d; onBoard(s); s += d) {
        const piece = board[s];
        if (piece === EMPTY) continue;
        const v = HUMAN_VALUE[typeOf(piece)];
        if (colourOf(piece) === by && types.includes(typeOf(piece)) && (best === 0 || v < best)) best = v;
        break;
      }
    }
  };
  slide(BISHOP_OFFSETS, [BISHOP, QUEEN]);
  slide(ROOK_OFFSETS, [ROOK, QUEEN]);
  if (best === 0 && KING_OFFSETS.some((d) => onBoard(sq + d) && board[sq + d] === own(KING))) best = 100;
  return best;
}

/* Is a piece worth `value` on `sq` en prise to `by`, defended by
   `defender`? */
function enPrise(board: Board, sq: Square, value: number, by: Colour, defender: Colour): boolean {
  const attacker = cheapestAttacker(board, sq, by);
  return attacker > 0 && (attacker < value || cheapestAttacker(board, sq, defender) === 0);
}

/* The squares a piece of `pieceType` and `colour` on `sq` attacks. */
function attackedSquares(board: Board, sq: Square, pieceType: PieceType, colour: Colour): Square[] {
  const steps = (dirs: readonly number[]) => dirs.map((d) => sq + d).filter(onBoard);
  const rays = (dirs: readonly number[]) => dirs.flatMap((d) => {
    const seen: Square[] = [];
    for (let s = sq + d; onBoard(s); s += d) {
      seen.push(s);
      if (board[s] !== EMPTY) break;
    }
    return seen;
  });
  switch (pieceType) {
    case PAWN: return steps(PAWN_CAPTURE_OFFSETS[colour]);
    case KNIGHT: return steps(KNIGHT_OFFSETS);
    case BISHOP: return rays(BISHOP_OFFSETS);
    case ROOK: return rays(ROOK_OFFSETS);
    case QUEEN: return rays([...BISHOP_OFFSETS, ...ROOK_OFFSETS]);
    default: return steps(KING_OFFSETS);
  }
}

/* The type of the most valuable piece of `us` on `board`, other than
   its king and the piece on `skip`, that is en prise, or EMPTY. */
function worstEnPrise(board: Board, us: Colour, skip: Square): PieceType {
  let worst = EMPTY;
  for (const sq of SQUARES) {
    const piece = board[sq];
    if (sq === skip || piece === EMPTY || colourOf(piece) !== us) continue;
    const pieceType = typeOf(piece);
    if (pieceType === KING || HUMAN_VALUE[pieceType] <= HUMAN_VALUE[worst]) continue;
    if (enPrise(board, sq, HUMAN_VALUE[pieceType], opponent(us), us)) worst = pieceType;
  }
  return worst;
}

/* 0 (opening), 1 (middlegame) or 2 (endgame) for `pos`. */
function humanPhase(pos: Position): number {
  const material = SQUARES.reduce((sum, sq) => sum + HUMAN_PHASE_WEIGHT[typeOf(pos.board[sq])], 0);
  return material <= 8 ? 2 : pos.gamePly < 30 ? 0 : 1;
}

/* The features of the legal `move` of `pos`; `lastTo` is where the
   opponent's last move went. */
function humanFeatures(pos: Position, move: Move, lastTo: Square): number[] {
  const us = pos.sideToMove, them = opponent(us);
  const mirror = us === BLACK ? 56 : 0;
  const board = pos.board, next = makeLegalMove(pos, move);
  const from = fromSq(move), to = toSq(move), pieceType = typeOf(board[from]);
  const phase = humanPhase(pos) * 384;
  const f: number[] = [];
  let moved = to;
  if (moveType(move) === FLAG_CASTLE) {
    f.push(F_CASTLE + (to > from ? 0 : 1));
    moved = next.kingSq[us];
  } else {
    f.push(F_TO + phase + (pieceType - 1) * 64 + (index64(to) ^ mirror),
      F_FROM + phase + (pieceType - 1) * 64 + (index64(from) ^ mirror));
    const captured = moveType(move) === FLAG_EP ? PAWN : typeOf(board[to]);
    if (captured !== EMPTY) {
      f.push(F_CAPTURE + (pieceType - 1) * 6 + (captured - 1));
      if (to === lastTo) f.push(F_RECAPTURE);
    }
    const promotion = promoType(move);
    if (promotion !== 0) f.push(F_PROMO + promotion - 2);
    const becomes = promotion || pieceType;
    if (pieceType !== KING) {
      if (enPrise(next.board, to, HUMAN_VALUE[becomes], them, us)) f.push(F_HANG + pieceType - 1);
      else if (enPrise(board, from, HUMAN_VALUE[pieceType], them, us)) f.push(F_RESCUE + pieceType - 1);
    }
    const targets = attackedSquares(next.board, to, becomes, us).filter((s) => {
      const piece = next.board[s];
      return piece !== EMPTY && colourOf(piece) === them && typeOf(piece) !== KING &&
        (HUMAN_VALUE[typeOf(piece)] > HUMAN_VALUE[becomes] || cheapestAttacker(next.board, s, them) === 0);
    }).length;
    if (targets === 1) f.push(F_THREAT + pieceType - 1);
    else if (targets >= 2) f.push(F_FORK + pieceType - 1);
  }
  const threatenedAfter = worstEnPrise(next.board, us, moved);
  if (threatenedAfter !== EMPTY) f.push(F_LEAVE + threatenedAfter - 1);
  else if (worstEnPrise(board, us, NO_SQUARE) !== EMPTY) {
    const others = worstEnPrise(board, us, from);
    if (others !== EMPTY) f.push(F_DEFEND + others - 1);
  }
  if (inCheck(next)) f.push(F_CHECK);
  return f;
}

/* The learned weights, by feature (see above): level 9's, without
   the LOSS features. */
const HUMAN_WEIGHTS: readonly number[] = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, -1.4824, -0.7179, 0.4956, 0.6969,
  1.139, 0.0489, 0.1639, -0.3442, -2.3772, -0.2233, 0.133, 0.7636, 0.5092, 0.49,
  0.3256, -1.4897, -0.8952, -0.1879, -0.0972, 0.1904, 0.2697, 0.1953, 0.0977, -0.1855,
  -0.276, 0.2142, 0.3639, 0.3111, 0.3366, 0.5879, 1.0296, -0.324, -0.6959, 0.0782,
  0.6115, -0.684, 1.2208, 1.8187, 0.5158, 0.3878, 0.1515, -0.1922, -0.4066, 0.1656,
  -0.4771, -0.7136, -0.1012, 0.2517, -1.9022, -3.1833, -1.9731, -1.5329, -1.2206, -0.1931,
  -2.3735, -1.1874, -1.8054, -0.3196, -0.3534, -0.4024, -0.1399, 0.0359, 0.6949, -0.1555,
  -2.3664, -0.2227, 0.1244, 0.3001, 0.2512, 0.5925, 0.9207, -1.8443, -0.6619, -0.5285,
  0.5393, 0.9743, 0.7495, 0.8475, 0.1461, -0.4871, -0.8065, -0.119, 0.7617, 0.6814,
  0.9659, 1.1517, 0.1371, 0.0713, -1.0217, 0.3327, 0.724, 0.3968, 0.6824, -0.2184,
  1.3745, 0.2782, -0.3901, 0.5628, 0.4106, 0.4215, 0.3318, -0.2295, 0.8479, -0.62,
  -0.7579, 0.1754, -0.2262, 2.061, 0.2461, 1.0725, 0.7742, -0.598, -1.2481, -0.2443,
  -2.6756, -1.6749, -1.3536, -1.8806, -1.5591, -1.4529, 1.2046, 0.678, 0.6855, -1.3137,
  -0.0738, -0.3522, 1.1319, 0.7205, -0.5817, 0.4977, 0.4569, 0.04, -0.4147, 0.2956,
  0.6074, -1.4072, -0.1453, -0.3577, -0.0903, 0.2279, 0.3213, -0.6117, -0.1802, 0.4709,
  -0.2625, -0.8485, -0.1049, -0.5111, -0.3615, 0.3176, -0.1186, -0.8346, -1.5862, -0.1965,
  -0.2844, 0.2347, -0.0371, -0.4574, 0.4239, -0.3659, -0.4939, 1.2163, 0.0398, -1.025,
  0.1728, -0.8312, 1.0995, -0.5136, 0.4874, -0.7436, 0.6559, 0.6457, -0.0373, 1.0283,
  -0.6763, -1.1198, -1.4483, -1.631, -0.4688, -0.1343, -0.0415, -1.6768, -1.2068, -0.6809,
  -2.837, -0.6446, -0.2328, 0.0279, -0.533, -1.4196, 0.2522, -1.9238, -2.0875, -0.2109,
  -0.5613, -0.0168, -0.3157, -0.5507, 0.033, -0.3011, -1.5518, -1.259, -0.001, -0.0004,
  0.2901, -1.2866, -0.2787, -0.8694, -1.3869, -0.5358, 0.9718, 0.4145, 0.7336, 0.2837,
  -0.2577, 0.3773, -1.4657, -1.2802, 1.0053, 0.1642, 0.057, -0.4719, -0.0792, 0.0335,
  -1.2944, 1.2371, 0.9042, 0.1981, -0.5732, -1.1377, 0.0998, 0.0002, 0.5733, -0.2617,
  0.1767, -0.2302, -1.0889, -0.4133, 0.3833, 1.6728, 0.1041, -2.8898, -1.7376, -1.0645,
  -1.687, -1.6477, -1.7211, -0.9438, -1.248, -0.7772, 0.0065, -0.6148, -0.3368, -0.1956,
  -0.1334, -0.8739, -1.4547, -0.4144, -0.6104, -0.7117, -0.7603, 0.1162, 0.4004, -0.4066,
  -1.1366, -0.9409, -0.3996, -0.2749, 0.2137, -0.5136, 0.1433, -0.0271, -1.0333, -0.7788,
  -0.1719, 0.1032, 0.2096, 0.106, -0.166, 0.4098, -0.6082, 0.272, -0.1919, 0.457,
  0.3258, 0.83, 0.9752, 1.2189, -0.0905, 0.1237, 0.1359, -0.5618, -0.3128, -0.0785,
  0.9513, 0.4528, -0.0038, -0.904, 0.0813, 1.1547, -1.443, -1.0251, 0.0257, 0.885,
  -0.4709, 1.0222, -1.2994, -1.5156, -1.1846, -1.0594, 0.2407, -0.0125, -0.2417, 0.5512,
  -0.3611, -1.538, -1.2576, -0.8997, 1.3452, 1.0178, -0.9463, -0.4027, -0.632, -1.6065,
  -1.7457, -1.9299, -1.1626, -1.7241, 0.2966, -0.5855, -0.9533, -0.2105, -0.5615, -0.8451,
  -1.6811, -1.109, 0, 0.3781, -1.0038, -0.6542, -0.1004, -0.2449, -0.7322, -0.2114,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  -1.2473, -0.0691, 0.4906, 0.2229, 0.6549, 0.1799, 0.5224, -0.1997, -1.2901, -0.222,
  0.1836, 0.65, 0.4252, 0.2182, 0.2368, -0.6368, -0.5402, 0.0417, 0.2512, 0.688,
  0.7909, 0.463, 0.3741, -0.1254, -0.4256, 0.14, 0.2806, 0.5989, 0.9455, 0.6533,
  0.6246, 0.4548, 0.4464, 0.4904, 0.4577, 0.5992, 0.9834, 0.9884, 0.9789, 1.0694,
  -0.1342, 0.5285, -0.3271, -0.1345, -0.293, 0.0498, -0.2644, 0.4702, -2.6213, -2.2687,
  -1.4906, -1.6457, -1.2753, -0.822, -1.5882, -2.1158, -2.1278, -0.5475, -0.293, -0.1259,
  0.0294, -0.0096, -0.0424, -0.5261, -1.2005, -0.1991, 0.0935, 0.3344, 0.5203, 0.5163,
  0.4289, -0.2293, -0.5311, 0.1615, 0.537, 0.9794, 1.0538, 0.9054, 0.4998, -0.0509,
  -0.0949, 0.2358, 0.8511, 0.8401, 0.9572, 1.1747, 0.9095, 0.6604, -0.3678, 0.6262,
  0.7529, 0.7374, 0.9181, 0.6569, 1.0942, 1.1114, -0.3732, 0.1886, 0.4347, 0.7595,
  0.4513, 0.7697, 0.3235, -0.0076, 0.073, 0.0022, -0.1027, 0.0795, 0.5847, 1.0183,
  -0.0381, -0.3058, -1.1809, -0.6393, -1.0777, -1.2526, -0.8473, -0.692, -0.8357, -1.9692,
  -0.4703, 0.1014, -0.0042, -0.4728, -0.061, -0.1101, 0.3207, -0.1891, 0.1737, 0.4007,
  0.1206, 0.1779, 0.268, 0.3722, 0.4991, 0.0561, -0.4378, 0.3368, 0.3157, 0.4244,
  0.6925, 0.1032, -0.0646, 0.1185, -0.5289, -0.2126, 0.3304, 0.2208, 0.3916, 0.3374,
  0.3382, -0.2154, -0.2873, 0.2759, -0.0992, 0.4786, 0.2147, 0.1626, 0.6922, 0.6268,
  -0.726, 0.229, -0.1038, -0.814, -0.1989, -0.88, 0.3106, -0.3594, -0.0204, -0.7803,
  0.065, -0.0115, -0.0112, 0.5866, -0.875, -0.6283, -1.2689, -1.2104, -0.6734, -0.1816,
  -0.2707, -0.2686, -0.4862, -0.1382, -2.3053, -0.7855, -0.4007, -0.2668, -0.0018, -0.5193,
  -0.0094, -1.3622, -1.9108, -0.4926, -0.0963, -0.3052, -0.057, 0.1027, 0.6051, 0.009,
  -1.0881, -0.6897, -0.1987, -0.1759, -0.072, -0.0274, 0.6526, -0.2974, -0.832, -0.3652,
  0.0456, 0.0224, 0.3808, 0.217, 0.6219, 0.1762, -0.2973, -0.1788, 0.0811, 0.1856,
  0.1124, 0.3451, 0.7257, 0.4285, 0.2276, 0.5056, 0.4809, 0.5616, 0.6273, -0.4061,
  -0.3014, 0.8175, 0.2782, -0.1104, 0.2557, 0.0071, -0.2938, -0.3688, 0.6443, 0.9748,
  -1.4772, -2.0207, -1.5576, -1.1159, -1.3171, -1.2491, -1.1723, -1.2137, -1.3283, -0.4008,
  -0.4206, -0.6038, -0.2912, -0.1234, 0.2417, -0.507, -1.392, -0.2586, -0.3325, -0.268,
  -0.1872, 0.3319, 0.4852, -0.0414, -0.8372, -0.6096, 0.0296, 0.2823, 0.4458, 0.4191,
  0.4838, 0.4079, -0.7234, -0.2743, 0.1023, 0.3934, 0.6407, 0.5912, 0.3507, 0.6557,
  -0.4214, -0.1033, 0.3144, 0.3048, 0.6856, 0.6929, 0.7441, 1.0965, -0.2781, -0.336,
  0.0932, 0.2369, 0.291, 0.2233, -0.3684, 0.7989, -0.1286, 0.2888, 0.205, 0.695,
  0.6201, 0.0839, 0.9823, 1.1284, -0.215, 0.5024, -0.3057, -0.8307, -1.087, -0.8785,
  -0.3939, -0.7079, 0.397, 0.5664, 0.1034, -0.2822, -0.1044, -0.3032, 0.5462, -0.2342,
  0.2204, 0.3963, 0.272, 0.1527, -0.2259, -0.1035, 0.3751, -0.3718, 0.4344, 0.0551,
  0.7312, 0.4925, -0.7269, -0.0304, -0.06, -0.3379, -0.0535, -0.2213, 0.8319, 0.2356,
  0.2147, -0.6952, -0.3469, -0.8755, -0.2639, -0.2846, 0.3897, 0.5998, 0.5889, 0.3887,
  0.2488, -0.0209, -0.2925, -0.7191, -0.2224, -0.2298, -0.0925, 0.6022, -0.5716, -1.0846,
  -0.7241, 0.0645, -0.6925, -0.9273, -0.6242, -0.9353, 0.1441, -0.0126, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, -0.9481, 0.0773, 0.8105, 1.2865, 1.0865, 0.2353,
  0.2639, -1.026, -0.6278, -0.109, 0.3786, 0.8119, 0.6225, 0.2338, -0.3601, -1.0684,
  0.1917, 0.1866, 0.3624, 0.3736, 0.4841, -0.0791, -0.1829, 0.2632, 0.4836, 0.5957,
  0.7081, 1.0371, 0.7238, 0.0622, 0.4365, 0.4204, 1.28, 0.7855, 1.4849, 0.5133,
  1.0531, 0.9612, 1.082, 0.5406, 0.1236, 0.1283, -0.1234, -0.4805, -0.4891, 0.183,
  -0.1655, 0.1, -1.5745, -1.6114, -0.9854, -0.5615, -0.7587, -0.9454, -1.7749, -2.1253,
  -0.6394, -0.5967, -0.0022, 0.1831, 0.1525, 0.0116, -0.2803, -1.2798, -0.7229, 0.0083,
  0.4097, 0.4084, 0.4913, 0.497, -0.0687, -0.6101, -0.3111, 0.1203, 0.5521, 0.4403,
  1.0051, 0.4631, -0.0135, -0.4054, 0.39, 0.2841, 0.6373, 0.7911, 0.9219, 0.6718,
  0.3952, 0.1689, 0.1614, 0.3279, 0.564, 1.0084, 0.6531, 0.509, 0.4288, -0.3345,
  -0.1196, -0.1812, 0.0978, 0.2036, -0.0584, 0.4139, -0.0869, -0.821, -1.2475, -0.3217,
  -0.3408, -0.3796, -0.5317, -0.2553, -0.9858, -1.5811, -1.5353, -1.4068, -1.1589, -0.2734,
  -0.7805, -0.9296, -1.6075, -2.5837, -0.3478, -0.6158, 0.0295, -0.4902, -0.4893, -0.4098,
  -0.4536, -0.971, -0.371, -0.1645, -0.0482, 0.3641, 0.2038, -0.0249, -0.3321, -0.4051,
  0.2266, 0.1111, 0.1757, 0.48, 0.0624, -0.2068, -0.0615, -0.5696, -0.1796, 0.0724,
  0.3419, 0.3006, 0.2616, 0.084, -0.2606, -0.6401, -0.3016, 0.1194, -0.1578, -0.1715,
  -0.0401, 0.1991, 0.0288, -0.4998, -0.2768, 0.0477, 0.107, -0.2554, -0.1677, -0.1949,
  0.1308, -0.6185, -2.0705, -0.8346, 0.0076, -0.5398, -0.5589, -0.3069, -0.4055, -1.6977,
  -1.2315, -0.8296, -0.4977, -0.1741, -0.7292, -0.7989, -1.157, -1.3496, -0.7184, -0.4995,
  -0.5194, -0.2841, -0.4376, -0.8104, -0.5957, -0.967, -0.6201, -0.4131, -0.3786, -0.5504,
  -0.1145, -0.7547, -0.4128, -0.7261, -0.3326, 0.0529, -0.2704, -0.2112, -0.2373, -0.5238,
  -0.3794, -0.6273, -0.0303, -0.0425, 0.1411, -0.163, -0.2684, -0.0863, -0.1849, -0.3343,
  0.4877, 0.2176, 0.1144, -0.1787, -0.2276, -0.0995, 0.0593, 0.1205, 0.6054, 0.5244,
  0.3724, 0.1978, 0.1067, -0.0789, 0.0271, 0.3219, 0.2028, -0.1425, -0.1491, 0.1785,
  -0.0687, -0.3087, 0.0255, 0.0932, -0.7473, -0.6551, -0.8166, -0.6861, -1.0458, -1.0291,
  -0.3531, -0.8726, -0.9301, -0.4938, -0.3404, -0.2782, -0.4084, -0.2864, -0.8001, -0.7065,
  -1.0287, -0.6537, 0.2849, -0.2854, -0.2653, -0.2183, -0.3933, -0.1846, -0.5725, -0.4192,
  -0.1554, 0.1466, -0.0942, -0.5432, -0.0713, -0.0641, -0.3259, -0.102, -0.1543, 0.0748,
  -0.018, -0.056, 0.0565, -0.0912, -0.648, 0.172, -0.4895, 0.0611, -0.0598, -0.0714,
  0.3246, -0.2847, -0.2681, -0.0444, -0.0563, -0.3661, -0.2239, -0.0997, -0.2122, -0.2039,
  -0.9023, -0.5171, -0.3467, -0.4402, -0.4652, -0.2885, -0.2906, -0.5145, -2.526, -1.7269,
  -1.8288, -1.9688, -1.7921, -2.0668, -2.6527, -4.0828, -1.3488, -0.3238, -0.4643, -0.4257,
  -0.5283, -0.753, -1.1713, -2.1976, -0.7297, 0.138, 0.4777, 0.5352, 0.35, -0.0263,
  -0.4256, -1.3566, -0.0334, 0.6118, 1.0446, 0.8383, 0.812, 0.5965, 0.0119, -0.7111,
  0.5804, 1.4661, 1.5828, 1.0884, 1.437, 1.3258, 0.902, 0.3654, 0.588, 1.2255,
  1.3811, 1.2386, 1.4408, 1.6824, 1.3509, 0.5095, 0.1163, 1.0974, 0.8975, 1.4303,
  0.9578, 1.1209, 0.755, 0.5603, -0.1168, 0.406, -0.0787, 0.0887, 0.0173, 0.4041,
  0.8584, -0.5005, 0, 0, 0, 0, 0, 0, 0, 0,
  1.2077, -0.3249, 0.2673, 0.5302, -0.0749, -0.5656, -1.3248, 0.1364, 0.6048, -0.5297,
  -0.4307, -1.2163, -1.0233, -0.682, -1.269, -0.2791, 1.1379, 0.3653, -0.5929, -0.425,
  -0.3677, -0.1975, 0.374, 1.4141, 1.2181, -0.1793, 0.3652, -0.0184, 0.1007, 0.0469,
  -0.1475, 1.4993, 0.874, -0.3263, 0.5063, 0.8005, 0.6164, 0.3434, 1.3246, -0.411,
  0, 0.0226, -1.0057, 0.173, -0.2749, -0.8698, 0.186, 0.0986, 0, 0,
  0, 0, 0, 0, 0, 0, -0.257, 1.3454, 1.1351, 0.2883,
  0.5246, 0.4553, 1.4602, 0.4715, 0.4953, 0.6758, 0.2611, 0.0246, -0.4569, -0.4234,
  -0.0529, -0.4437, 1.1612, -0.6346, -0.7414, -1.0696, -0.541, -0.8222, -0.9525, 0.9872,
  0.4495, 0.7316, -0.7338, -0.8007, -0.8167, -0.7094, -0.2677, -0.0588, 0.1138, -0.0375,
  -0.2503, -1.0717, -1.2724, -0.8759, -0.3224, -0.8775, 1.0433, -0.0807, -0.1897, -0.5847,
  0.0394, 0.0008, -1.1062, 0.2694, 0.1379, 0.5358, 0.4629, 0.2856, 0.0093, -0.0037,
  0.2948, 0.4413, 0.3257, -0.0211, -0.0976, 0.3285, -0.0165, 0.1809, -0.1033, 0.6864,
  -0.4029, -1.6643, 0.9857, -0.0091, -0.2467, 1.4801, 0.0586, -1.5599, -1.3721, -1.3922,
  -1.1115, 0.0367, -0.3308, -2.0907, -1.5865, -0.7771, -0.59, -0.9224, -0.2611, -1.0946,
  -0.4049, -0.7262, -1.0607, -0.6817, 0.0086, -0.1629, -0.6322, -0.9351, -0.7029, -0.9886,
  -0.1364, -0.3857, 0.5996, -0.6528, -0.9121, -0.5911, -0.5223, -0.1725, -0.4298, -0.1784,
  -0.5833, -1.1411, -0.7625, -0.5407, -1.3165, -0.9212, -0.4986, -0.4055, 1.1171, 0.7563,
  0.0481, -0.2324, 0.1951, -0.0327, -0.2159, 1.1417, 0.6508, -0.2451, -0.0751, 0.448,
  0.7374, -0.9056, -1.044, -0.0459, 0.0916, -1.2156, -1.5017, -1.6196, -1.5786, -0.2936,
  -0.7676, -0.5811, 0.703, -0.1404, -0.6673, -1.6383, -1.2939, -0.4062, -1.0717, 0.2428,
  -0.059, -0.1636, -0.9759, -0.2769, -0.6006, 0.594, -0.6976, -1.2074, 0.5349, -0.5619,
  -0.7765, -0.9904, 0.1079, -0.3819, 0.5317, -0.6475, -0.3781, 0.3185, -1.0721, -0.5318,
  -1.1263, -1.3365, -0.8863, -0.4923, -0.0368, -1.0518, -0.0536, -1.0969, -1.0329, 0.2906,
  -0.6475, -0.3202, 0.4533, 0.116, -0.525, -1.8356, -0.899, -0.5153, -0.7041, -0.0224,
  -0.3672, 0.1626, 0.4761, 0.0787, -0.4841, -0.0528, 0, 1.5602, 0.2467, 0.2076,
  -0.5751, -0.2771, 0.0992, -0.3899, -0.3177, -0.7068, 0.0766, 0.3012, -0.8534, -0.9646,
  -0.9578, -0.6828, -1.3249, -0.3546, 0.34, -0.4118, -0.875, -0.9042, -0.6891, -0.8526,
  -0.8013, -0.8506, -0.056, -0.4511, -0.697, -0.9465, -0.7415, -0.7279, -0.9596, -0.8288,
  -0.2558, 0.2261, 0.176, -0.2026, -0.4678, -0.3102, -0.2197, -0.5207, 0.22, 0.1433,
  -0.3694, -1.0419, -0.5198, -0.5212, 0.2122, -0.5621, 0.1525, 0.25, -0.0517, 0.0699,
  1.3035, -0.2373, -0.5985, -0.1485, 0.6686, 0.2553, 0.7299, 1.182, -1.0452, 0.2015,
  -0.7867, 0.4283, 0.5419, -2.0834, -1.0347, 1.4047, -1.1699, -0.4755, -1.8538, -2.5273,
  -0.167, -1.2271, -1.8483, 0.1062, 0.7333, -0.3694, -1.671, -1.4992, 0, -0.0545,
  0.018, -0.31, 1.0025, -0.4826, -0.381, -0.6338, 0.3877, 0.5809, 0.1129, -0.0253,
  -0.0001, 0.5863, 0, -0.2028, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0.6125, 0.0061, -0.398, 0.0153, -0.1573, -0.2954,
  -0.8576, 0.1668, 0.9125, 0.0908, 0.1195, -0.0846, -0.2262, -0.0395, -0.5746, 0.456,
  1.2002, 0.3458, -0.0391, -0.3395, -0.0331, 0.181, 0.2286, 1.0453, 1.6024, 0.6763,
  0.2982, 0.0428, 0.1033, 0.3977, -0.0795, 1.0111, 1.5293, 1.0578, 0.931, 0.6942,
  0.8398, 0.3535, 0.7024, 0.2548, -0.0204, -0.2846, 0.7652, -0.3778, 0.4125, -0.3344,
  0.0555, -0.0772, 0, 0, 0, 0, 0, 0, 0, 0,
  1.3274, 1.951, 1.2609, 1.2167, 0.8888, 0.7716, 1.4735, 1.3786, 1.3738, 0.9516,
  0.7725, 0.7847, 0.4847, 0.7017, 0.3884, 0.3846, 1.5679, 0.5033, 0.2971, -0.0324,
  -0.0777, -0.0719, -0.2162, 0.6897, 0.6494, 0.1208, 0.0576, -0.3478, -0.35, -0.4922,
  -0.3262, 0.0387, 0.5413, 0.0002, -0.4042, -0.2686, -0.5137, -0.6764, -0.2168, -0.2531,
  0.5411, 0.6864, 0.2187, -0.2924, -0.1257, -0.0832, -0.1949, 0.4172, 0.9381, 0.4817,
  0.333, 0.4738, 0.4738, 0.6182, 0.4828, 0.5813, 1.1366, 0.4486, 0.832, -0.012,
  0.9839, 0.4342, 0.1746, 0.6145, -0.4259, -0.3788, 1.3079, 0.7699, 0.6843, 0.8109,
  0.2579, -0.4768, -0.5427, -0.2225, -0.3165, 0.4397, 0.2494, -0.1665, -0.3984, -0.0522,
  0.1298, -0.1912, -0.2178, -0.2663, -0.0126, -0.3592, -0.4199, -0.0723, 0.2017, -0.1211,
  -0.2895, -0.5314, -0.549, -0.1635, -0.1297, 0.262, 0.4628, -0.1628, -0.4878, -0.6989,
  -0.4005, -0.3058, 0.066, 0.2785, 0.2002, -0.404, -0.369, -0.2355, -0.1137, -0.7648,
  -0.1587, -0.4837, 0.4691, 0.1501, -0.0835, 0.3616, 0.2445, -0.2387, 0.3874, 0.9308,
  0.2453, 0.1965, 0.6699, 0.3578, -0.197, -0.4599, 0.0654, 0.0739, 0.9458, 0.0034,
  -0.3036, -0.1206, -0.3834, 0.054, -0.418, 0.1129, 0.5089, -0.0385, -0.1151, -0.5485,
  -0.5134, -0.6663, -0.7732, -0.4721, 1.0259, 0.2007, -0.2034, -0.2176, 0.0138, -0.1306,
  -0.6566, -0.1132, 0.5752, -0.1858, -0.131, -0.17, -0.5638, -0.1999, -0.8048, -0.0528,
  -0.0636, 0.116, -0.4427, -0.4266, -0.6115, -0.3337, -0.3573, -0.0947, -0.2863, -0.2292,
  -0.7441, -0.7877, -0.6192, -0.751, -0.7313, -1.0415, -0.7327, -0.9792, -1.0461, -0.9285,
  -1.0815, -0.8953, -0.7922, -0.7156, -0.0149, -0.3756, -0.0691, -0.7173, -0.5147, -0.1868,
  -0.7371, -0.1977, 0.8547, 0.6407, 0.6659, 0.7323, 0.5223, 0.4478, 0.5827, 0.7097,
  0.2822, 0.395, 0.1415, 0.079, -0.1463, -0.0953, -0.4725, -0.2686, 0.4463, 0.1054,
  -0.154, -0.342, -0.3124, -0.4806, -0.6711, -0.2237, 0.2877, 0.1371, 0.0738, -0.5604,
  -0.3873, -0.6142, -0.792, -0.4165, 0.7144, -0.1277, -0.3272, -0.3675, -0.5851, -0.6354,
  -0.3547, -0.4211, 0.3919, 0.0454, -0.2427, -0.2241, -0.6439, -0.5456, -0.4016, -0.6317,
  0.5429, 0.0003, -0.2447, -0.4312, -0.3089, -0.3572, -0.2267, 0.0791, 0.5343, 0.1883,
  -0.285, -0.0698, 0.0365, -0.4388, -0.377, 0.0553, -0.9196, -0.4597, -0.2449, 0.9133,
  0.3307, 0.6074, -0.3995, 0.0425, -1.062, -1.1484, -0.5459, -0.0521, 0.2151, -0.2197,
  -0.6115, -0.1999, -0.405, -1.3944, -0.3511, 0.0955, 0.203, -0.3993, -0.2036, 0.1506,
  -0.3546, -0.6925, 0.216, -0.2962, 0.4411, 0.1072, 0.3183, 0.4673, 0.4841, -0.0266,
  0.1755, 0.8867, 0.0539, 0.1369, -0.0107, 0.1654, -0.4389, -1.1778, 0.2776, -0.2751,
  0.0433, 0.3572, 0.5912, -0.219, -1.1055, -0.3402, -1.1868, 0.057, -0.0129, -1.3342,
  -0.2745, -0.0025, 0, -0.7099, -0.3776, -0.0577, -0.8075, -0.3979, 0, -0.3884,
  0, 0, 0, 0, 0, 0, 0, 0, 0.3868, -0.3621,
  -0.7556, -0.9448, -0.8576, -0.2843, -0.2293, 0.6351, 0.6027, 0.0723, -0.4144, -0.7074,
  -0.5761, -0.2635, -0.0466, 0.6431, 0.4829, 0.0956, 0.0959, -0.3461, -0.0018, -0.0164,
  0.1328, 0.6771, 1.2397, 0.7699, 0.2949, -0.0097, -0.098, 0.6434, 0.5416, 1.1049,
  0.9483, 1.3815, 0.3003, 1.3915, 0.1179, 1.0586, 1.0399, 1.5854, -0.1069, 0.0206,
  -0.4352, -0.1956, -0.3138, -0.1593, 0.2776, 0.2235, 0, 0, 0, 0,
  0, 0, 0, 0, 1.1938, 0.7151, 0.7287, 0.7777, 0.803, 0.9481,
  1.8117, 0.9358, 0.5887, 0.3545, -0.3067, 0.1639, 0.0507, 0.2626, 0.3726, 0.8244,
  0.9678, -0.0068, -0.1116, -0.3842, -0.2055, -0.0624, 0.1884, 0.7449, 0.2938, -0.0958,
  -0.5458, -0.711, -0.5638, -0.6439, -0.1658, 0.2975, 0.1931, -0.1256, -0.7172, -0.3807,
  -0.5367, -0.7471, -0.0077, 0.6504, 0.7163, -0.0594, -0.4337, -0.5758, -0.4474, 0.0301,
  -0.4713, 0.436, 1.1881, 0.4508, 0.314, 0.3434, 0.6485, 0.3547, 0.7511, 1.1695,
  1.4966, 0.2766, 0.1872, 0.3538, 0.1603, 1.0265, 0.9042, 0.3575, -0.6247, -0.2692,
  0.4016, 0.495, 0.1638, 0.3787, 0.1966, 0.2431, -0.3125, -0.0899, -0.1441, 0.2907,
  -0.5873, -0.2442, 0.153, 0.285, -0.1372, -0.8539, -0.6594, -0.4219, -0.3594, -0.118,
  -0.6611, 0.1072, -0.4228, -0.5297, -0.7994, -0.7434, -0.7151, -0.3969, -0.0956, 0.3091,
  0.3016, -0.7225, -0.5214, -0.5595, -0.8589, -0.677, -0.2914, 0.2614, -0.125, -0.2066,
  -0.7278, -0.7616, -0.2845, -0.8355, -0.5081, -0.3221, 0.5213, -0.0561, -0.2054, -0.1501,
  0.2773, 0.0008, -0.2013, 0.2347, 0.4558, 0.4587, 0.0457, -0.184, 0.2345, 0.2319,
  0.4748, -0.1583, 0.3656, -0.1495, 0.0537, 0.1193, -0.0141, 0.6863, 0.169, 0.4978,
  -0.2495, -0.4322, -0.0935, -0.3947, -0.1606, -0.0651, 0.0493, 0.1833, -0.2153, -0.2841,
  -0.2941, -0.4189, -0.0187, -0.1228, -0.0749, -0.2259, -0.5369, -0.3112, -0.3584, -0.2736,
  -0.176, 0.0417, -0.2145, 0.2474, -0.3877, -0.7759, -0.4216, -0.5236, -0.0179, -0.0185,
  -0.2638, 0.1942, -0.6506, -0.6238, -0.6501, -0.511, -0.3518, -0.2383, -0.222, 0.1543,
  -0.8348, -1.054, -0.7525, -0.5222, -0.287, -0.4644, -0.5397, -0.0893, -0.418, 0.0384,
  -0.4515, -0.3572, -0.0493, 0.2304, -0.8072, -0.1799, -0.2794, 0.1392, -0.5123, 0.6453,
  0.6806, -0.1149, -1.1093, 0.098, 0.1068, -0.108, -0.153, -0.1713, -0.2868, -0.1609,
  -0.326, 0.8184, 0.618, 0.37, -0.1317, -0.4447, -0.4679, 0.0559, 0.361, 0.1425,
  0.2102, 0.4556, -0.4597, -0.6351, -0.2887, -0.3755, 0.4254, 1.202, 0.2744, -0.6713,
  -0.7039, -0.6808, -1.1377, -0.3329, -0.3707, 0.5595, -0.1595, 0.0335, -0.8912, -0.231,
  0.0609, 0.3042, -0.0918, 0.1938, 0.6855, 0.1434, -0.2908, -0.1122, -0.1446, 0.2602,
  0.6072, 0.0079, 0.6171, 0.5449, 0.0462, 0.701, -0.0177, -0.0082, 0.1229, 0.535,
  1.4962, 1.2147, 1.1488, 1.4107, 1.7681, 2.0529, 1.9325, 2.4641, 0.8752, 0.2008,
  0.1843, 0.2824, 0.6949, 0.4715, 0.8974, 1.3763, 0.2854, 0.1253, -0.5183, -0.45,
  -0.3335, 0.0967, 0.0729, 0.9554, -0.0806, -0.6408, -0.851, -1.0134, -0.7145, -0.8005,
  -0.671, 0.3311, -0.1586, -1.4145, -1.3592, -1.3, -1.187, -0.9761, -0.8829, -0.0153,
  -0.1376, -1.393, -1.0209, -1.2954, -1.6204, -1.6708, -1.2524, -1.0059, -0.5475, -1.6542,
  -1.4409, -1.6007, -1.4363, -2.016, -1.5895, -0.761, 0.4006, -0.386, -0.8488, -0.7533,
  -0.9477, -0.7094, -0.1926, -0.1391, 2.2374, 3.6937, 4.2088, 4.9343, 6.9148, 0,
  1.1799, 4.5492, 4.7067, 5.9046, 7.7783, 0, 1.4834, 4.2976, 5.1876, 6.0517,
  7.7253, 0, 2.3641, 3.7168, 3.8355, 5.7877, 8.559, 0, 2.0043, 3.6385,
  3.8971, 4.1786, 7.9852, 0, 2.6944, 4.2097, 4.1428, 5.228, 7.7773, 0,
  0.8861, 1.5912, -2.3471, -3.1814, -1.8383, 1.8689, 2.4055, 1.8762, -1.6716, -3.4058,
  -3.2756, -4.4914, -6.7704, 0, 0.5912, 1.0474, 1.2829, 1.1374, 1.4769, 0,
  1.0801, 0.7325, 0.5264, 1.0893, 0.4357, 1.1521, 0.9381, 1.1525, 0.5902, 1.0821,
  0.5853, 1.55, 0.2588, 0.339, 0.0023, 0.4032, 0.1012, 0, -1.0695, -2.3472,
  -2.6489, -2.4871, -3.8661, 0,
];

/* Level 10's weights, with the LOSS features. */
const HUMAN_SEARCH_WEIGHTS: readonly number[] = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, -0.984, -0.4403, 0.5289, 0.6628,
  1.053, -0.0657, -0.0435, -0.4302, -1.9801, -0.0418, 0.0927, 0.594, 0.3413, 0.417,
  0.1122, -1.4271, -0.7204, -0.2081, 0.0547, 0.2441, 0.0993, 0.449, 0.0642, 0.0679,
  -0.553, 0.2107, 0.0962, 0.3083, 0.6806, 0.2861, 0.994, -0.4617, -0.5758, -0.2126,
  0.4337, -0.7535, 1.1041, 1.2907, 0.6619, 0.448, 0.1899, -0.2737, -0.9121, -0.441,
  0, -0.7658, 0.338, 0.309, -2.3638, -2.7304, -2.2187, -1.7461, -1.4659, -0.2525,
  -1.9943, -1.7272, -1.7468, -0.0995, -0.3941, -0.3653, -0.254, -0.0583, 0.4843, 0.0845,
  -2.1796, -0.1855, -0.0472, 0.2173, 0.5421, 0.5063, 0.9912, -1.8195, -0.6025, -0.152,
  0.363, 0.9639, 0.7756, 0.6665, 0.1653, -0.5573, -0.5864, -0.1825, 0.5977, 0.9049,
  1.0137, 1.3189, 0.1383, 0.472, -0.6085, 0.867, 0.6969, 0.2352, 0.7726, 0.3881,
  1.0562, 0.9803, -0.7528, 0.6434, 0.6711, 0.4315, 0.2284, 0.0578, 0.8769, -0.1106,
  -0.1432, 0.9967, 0.3513, 1.6003, 0.2844, 1.0022, 1.2925, 0.1407, -0.8996, -0.1996,
  -2.1365, -1.5996, -1.2547, -1.5134, -1.1671, -1.4485, 0.809, 0.5626, 0.7022, -1.2201,
  -0.0824, -0.2176, 1.1709, 0.8643, -0.3108, 0.4376, -0.014, -0.0863, -0.344, 0.3518,
  0.9314, -1.2651, 0.0947, -0.3606, -0.2064, 0.1202, 0.2763, -0.669, -0.4807, 0.4405,
  -1.0296, -0.9835, 0.1239, -0.4394, 0.0455, 0.6149, 0.0957, -0.421, -1.6578, -0.1524,
  -0.156, 0.0648, 0.1586, -0.471, 0.4505, -0.3598, -0.4413, 0.8002, -0.2789, -0.8307,
  0.4274, -0.2735, 1.0358, -0.3301, 0.5789, -1.1178, 0.817, 0.142, 0.3601, 1.0136,
  -0.2587, -0.8039, -1.2214, -1.6023, -0.4055, -0.114, 0.1165, -1.0201, -1.3743, -0.4985,
  -3.0678, -0.8808, 0.1251, 0.1216, -0.4587, -1.7535, 0.8124, -1.7805, -2.0526, 0.1746,
  -0.1151, -0.1738, -0.6508, -0.3113, 0.1457, -0.364, -1.6181, -1.0752, -0.4674, -0.2746,
  0.0088, -0.756, 0.024, -1.0497, -1.5325, -0.7943, 1.3082, 0.0437, 0.8182, -0.161,
  -0.3575, 0.7053, -1.8945, -1.0721, 1.2136, 0.5977, 0.4161, -0.6085, -0.659, -0.0924,
  -0.6156, 0.621, 0.261, -0.0117, 0.0632, -0.7523, -0.4646, -0.2279, 0.3529, -0.0449,
  0.0676, -0.149, -1.2253, -1.0189, 0.6306, 2.2522, 0.0417, -2.8037, -1.9569, -0.8819,
  -1.4653, -1.418, -1.1313, -0.6047, -1.2341, -1.0761, 0.0096, -0.2827, -0.3131, -0.3802,
  0.4148, -0.2608, -1.4134, -0.4953, -0.5308, -0.683, -0.5538, 0.1291, 0.548, -0.4046,
  -1.1127, -1.0202, -0.5617, -0.0651, -0.0127, -0.2692, 0.0855, 0.2627, -1.044, -1.0948,
  -0.3097, -0.0076, -0.1664, -0.0988, -0.2027, 0.3456, -0.6342, 0.2711, 0.1259, 0.2149,
  0.0924, 0.1904, 1.1484, 1.1559, -0.1435, -0.1752, 0.1627, -0.3869, -0.0766, 0.1876,
  0.524, 0.2613, -0.3002, -0.8875, -0.36, 1.0919, -1.0674, -0.3721, -0.5146, 0.345,
  -0.6805, 0.955, -1.315, -1.6066, -0.9721, -1.3269, -0.2304, -0.2401, -0.882, -0.4679,
  -0.6251, -1.3644, -1.166, -0.8011, 1.0839, 0.6206, -1.3577, -0.1081, -0.5681, -1.712,
  -1.3181, -1.5765, -0.7906, -1.9654, 0.2153, -0.2963, -0.6851, -0.0835, -0.7828, -1.0023,
  -1.3821, -1.6612, -0.0789, -0.7325, -0.9194, -0.5583, -0.2492, 0, -0.9034, -0.6478,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  -1.0897, -0.0297, 0.5808, 0.5274, 0.6831, -0.0115, 0.5726, -0.2598, -1.2448, -0.209,
  0.0517, 0.4933, 0.3177, 0.1943, 0.127, -0.6471, -0.5467, 0.0678, 0.3613, 0.4955,
  0.7774, 0.4765, 0.1839, 0.0084, -0.4123, -0.1775, 0.2263, 0.8626, 0.7516, 0.7096,
  0.692, 0.644, 1.0208, 0.1688, 0.6576, 0.7055, 0.7963, 1.0047, 1.3423, 0.848,
  0.1039, 0.5002, -0.1865, 1.0757, -0.2727, 0.6132, -0.9748, 0.2485, -2.3957, -2.7023,
  -1.4116, -1.5873, -1.23, -0.7533, -1.0793, -2.1416, -2.0847, -0.9245, -0.3763, -0.2013,
  -0.1469, -0.1459, -0.0606, -0.5415, -0.8286, -0.1898, -0.0586, 0.4046, 0.664, 0.5027,
  0.4866, -0.5334, -0.629, 0.2457, 0.4429, 0.7778, 0.929, 0.7162, 0.6374, -0.1509,
  -0.1399, 0.1103, 0.8043, 0.8849, 1.1108, 1.1539, 0.793, 0.5773, 0.0167, 0.5357,
  0.9422, 0.9365, 1.028, 0.6926, 1.2069, 1.0794, -0.2929, 0.4723, 0.6883, 0.6955,
  0.3761, 0.7755, 0.5585, -0.2047, 0.3463, 0.256, -0.0139, 0.6217, 0.3468, 0.7136,
  0.1937, -0.3147, -1.2901, -0.4873, -1.183, -1.2354, -0.869, -0.8154, -1.137, -1.8182,
  -0.1745, -0.092, -0.0296, -0.4925, -0.1532, -0.1031, 0.5395, -0.273, -0.1793, 0.4435,
  0.5007, 0.1457, 0.0426, 0.1194, 0.4984, -0.1568, -0.5742, 0.1633, 0.2203, 0.6059,
  0.3419, 0.0553, -0.0614, -0.1217, -0.3592, -0.0454, 0.3309, 0.1088, 0.3147, 0.3527,
  0.1356, -0.5035, -0.4132, 0.0843, 0.1468, 0.2123, 0.4415, 0.1684, 0.5587, 0.6853,
  -0.5654, 0.1099, -0.4535, -0.45, -0.0301, -0.5302, 0.7612, -0.3747, -0.19, -0.6025,
  -0.0617, -0.2511, -0.0495, 0.5338, -1.0672, -0.2511, -0.8657, -1.3028, -0.5602, -0.1633,
  -0.3267, -0.1747, -0.3007, -0.1655, -2.1585, -0.8273, -0.4098, -0.2345, -0.2012, -0.6158,
  0.3771, -0.9448, -1.9307, -0.6908, -0.3497, -0.178, -0.0904, -0.0591, 0.8183, -0.1544,
  -1.5099, -0.2977, -0.0641, 0.0643, 0.0564, 0.0118, 0.3762, -0.2894, -0.8425, -0.2792,
  0.0517, 0.3547, 0.1654, 0.0155, 0.524, -0.0169, -0.1913, -0.131, 0.2606, 0.2541,
  0.4056, 0.4201, 0.3747, 0.3698, -0.2802, 0.2554, 0.3814, 0.5822, 0.5627, -0.2121,
  0.0303, 0.9241, 0.4762, 0.3229, -0.3057, -0.1341, -0.125, -0.1203, 0.5502, 0.5174,
  -1.525, -1.8436, -1.4499, -1.2622, -1.5045, -1.0997, -1.3027, -1.2249, -1.358, -0.6117,
  -0.3406, -0.4843, -0.2731, -0.077, -0.101, -0.4481, -0.8977, -0.4521, -0.4179, -0.0421,
  -0.1583, 0.2715, 0.6007, -0.0255, -0.7752, -0.5598, -0.0797, 0.0577, 0.3126, 0.4269,
  0.4844, 0.1891, -0.6525, -0.2936, -0.1165, 0.3325, 0.5701, 0.6324, 0.4599, 0.4287,
  -0.4523, 0.0325, 0.1278, 0.4929, 0.7053, 0.657, 0.8849, 0.8645, -0.5233, -0.0271,
  0.0626, 0.3686, 0.646, 0.5029, 0.017, 0.235, -0.5533, 0.1303, 0.3787, 0.5837,
  0.4999, 0.1244, 0.3375, 0.8707, -0.0228, 0.4693, -0.635, -1.1044, -0.9698, -1.0548,
  -0.6719, -0.8002, 0.6706, 0.4871, 0.1531, -0.4365, -0.211, -0.4712, 0.4928, -0.218,
  0.3907, 1.0196, -0.0243, -0.0586, -0.0181, -0.0441, 0.3296, -0.1551, 0.1822, 0.5839,
  0.1517, 0.2393, -0.4605, 0.3706, -0.1825, 0.0065, 0.1854, -0.0193, 0.0204, 0.2062,
  0.6974, -0.5884, 0.4524, -1.0417, 0.4327, -0.2556, 1.3279, 0.5364, 1.1431, -0.1306,
  0.1397, 0.4017, -0.617, -1.3304, -0.0487, 0.3433, 0.3201, 0.3431, -1.0643, -0.919,
  -0.9847, 0.6346, -1.4662, -0.1867, 0.205, -1.3723, -0.0508, -0.0741, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, -0.9736, 0.0644, 0.2856, 1.3257, 1.0532, 0.1964,
  -0.1222, -1.1269, -0.7268, 0.0052, 0.1539, 0.6099, 0.5216, 0.1386, -0.2071, -0.7232,
  0.0319, 0.2164, 0.3232, 0.527, 0.3072, 0.252, -0.1165, 0.1278, 0.6193, 0.629,
  0.4366, 0.7913, 0.7574, 0.6616, 0.449, -0.0336, 1.3082, 0.9088, 1.2814, 0.6885,
  0.771, 0.9188, 1.0843, 0.7134, -0.0875, 0.3109, -0.2035, 0.0101, -0.0967, 0.3293,
  -0.2396, 0.0034, -1.8267, -1.2136, -1.0171, -0.9573, -1.0011, -0.8996, -1.5939, -1.6557,
  -0.6893, -0.8105, 0.0342, 0.019, 0.0071, -0.2116, -0.3185, -1.2617, -0.5604, 0.0568,
  0.2493, 0.4659, 0.5718, 0.3011, -0.0126, -0.3905, -0.0789, 0.5773, 0.4413, 0.5967,
  0.4321, 0.6028, 0.0531, -0.4303, 0.0598, 0.1703, 1.0508, 0.8441, 0.5158, 0.4726,
  0.3592, -0.1985, -0.0551, 0.1145, 0.6395, 1.0239, 0.5392, 0.3236, 0.4231, -0.6579,
  -0.129, -0.0421, 0.4104, 0.5901, 0.0144, 0.4193, -0.0924, -0.4831, -1.316, -0.6375,
  -0.2232, -0.1675, -0.1728, -0.3964, -0.2823, -1.4911, -1.6017, -1.3836, -1.3221, -0.6596,
  -0.9376, -0.6968, -1.6508, -2.4703, -0.4474, -0.6181, -0.1131, -0.3983, -0.6725, -0.4777,
  -0.6119, -0.796, -0.4408, -0.1143, -0.2826, 0.1685, 0.1783, -0.0303, -0.1869, -0.694,
  -0.2592, 0.0235, 0.2762, 0.4495, 0.0189, 0.4346, -0.1636, -0.5784, -0.2077, -0.0699,
  -0.1435, 0.1816, 0.4002, 0.0785, -0.4173, -0.5056, -0.2657, -0.0141, 0.0042, 0.212,
  -0.0552, -0.0888, 0.1833, -0.4554, -0.9133, 0.017, -0.3098, -0.1514, -0.2728, -0.5007,
  -0.2047, -0.7539, -2.3089, -0.6388, -0.0409, -0.1335, -0.294, -0.3268, -0.3417, -2.0491,
  -0.8661, -0.7581, -0.5663, -0.2386, -0.6931, -0.774, -1.0989, -1.0118, -0.8262, -0.5538,
  -0.2732, -0.4565, -0.3154, -0.4016, -0.775, -0.8308, -0.9927, -0.2641, -0.2982, -0.5403,
  -0.1266, -0.4811, -0.5419, -0.8103, -0.3992, -0.2384, -0.0822, -0.3033, -0.1734, -0.3526,
  -0.1862, -0.6336, -0.0883, 0.1397, 0.0517, -0.1403, 0.0461, -0.0895, -0.1518, -0.3567,
  0.1205, 0.5132, 0.2621, -0.0326, -0.1989, -0.4707, 0.1742, 0.0054, 0.3587, 0.397,
  0.3024, 0.2676, -0.3008, -0.1354, 0.2199, 0.0939, 0.051, -0.1649, 0.0444, 0.2431,
  0.0202, -0.1261, -0.0001, -0.2193, -1.1708, -0.7234, -0.9307, -0.6575, -1.3452, -1.0175,
  -0.7334, -0.5877, -0.6959, -0.2651, -0.9641, -0.5887, -0.5071, -0.0742, -0.2301, -0.4526,
  -0.9341, -0.4748, -0.0658, -0.1719, 0.0426, -0.0293, -0.5235, -0.4501, -0.6899, -0.3348,
  -0.2866, 0.0283, 0.0673, -0.3224, -0.1907, -0.8669, -0.3203, -0.7162, -0.0592, -0.0934,
  0.1718, -0.2454, 0.0149, -0.4025, -0.2988, -0.6039, -0.4015, -0.0924, -0.1728, -0.2998,
  -0.6236, -0.3644, -0.4625, -0.6742, -0.6998, 0.0355, -0.0577, 0.1086, -0.6072, -0.2291,
  -0.9109, -0.4055, -0.2458, -0.7298, 0.0168, -0.2417, -0.574, -0.777, -2.1618, -1.6456,
  -1.9591, -1.813, -1.8923, -2.0459, -2.795, -3.9101, -1.3364, -0.5308, -0.5436, -0.2667,
  -0.3679, -1.0024, -1.4372, -2.3449, -0.9633, -0.0568, 0.4898, 0.3152, 0.4597, 0.1194,
  -0.3431, -1.2092, 0.4761, 0.7951, 0.8632, 0.9867, 1.0359, 0.7271, 0.3064, -0.4476,
  0.5602, 1.117, 1.2031, 1.0859, 1.2037, 1.1912, 0.9402, 0.5364, 0.8101, 1.1981,
  1.1736, 1.3642, 1.2449, 1.2432, 1.3085, 0.8993, 0.8609, 1.1164, 1.3722, 1.0005,
  1.1801, 1.8446, 0.8653, 1.1812, 0.1873, -0.078, 0.5665, 0.5375, 0.0861, 0.3132,
  0.6026, -0.6511, 0, 0, 0, 0, 0, 0, 0, 0,
  0.7236, -0.395, 0.1651, 0.5549, 0.0575, -0.4061, -1.3855, 0.083, 0.6231, -0.655,
  -0.4785, -1.0439, -0.927, -0.427, -0.9936, -0.1608, 1.3347, 0.3086, -0.5506, -0.474,
  -0.2718, -0.266, 0.3668, 1.08, 1.4455, -0.1295, 0.1493, -0.1911, -0.0257, 0.334,
  -0.1846, 1.624, 1.0037, -0.311, 0.1291, 0.6808, 0.5423, 0.5346, 1.3395, -0.1831,
  0, -0.6283, -0.4599, -0.0313, 0.0619, -0.6319, 0.0274, 0.3305, 0, 0,
  0, 0, 0, 0, 0, 0, -0.3793, 1.3902, 0.6004, 0.3482,
  0.2006, 0.6457, 1.463, -0.5827, 0.8322, 1.1975, 0.6864, -0.093, -0.217, -0.3411,
  -0.115, -0.4949, 0.9459, -0.3759, -0.6537, -0.8982, -0.212, -0.6916, -1.1214, 0.7848,
  0.2848, 0.7972, -0.5598, -0.9499, -0.7669, -0.3354, -0.4452, -0.179, -0.0227, -0.2697,
  -0.2594, -0.6606, -0.907, -1.201, -0.2152, -0.3009, 1.1816, -0.5634, -0.5308, -0.9292,
  -0.0294, -0.3927, -1.0111, 0.2049, 0.3959, 0.5602, 0.4032, 0.2604, 0.3058, 0.2723,
  0.4423, 1.0346, 0.2156, -0.4604, -0.0531, -0.2863, 0, -0.7266, -0.3537, 1.1829,
  -0.5257, -2.392, 0.9331, -0.4501, -0.0844, 1.5564, 0.0929, -2.1559, -1.4405, -1.4092,
  -1.4792, -0.0924, -0.2978, -1.8298, -1.4346, -1.0049, -0.9958, -1.2118, -0.5747, -1.0939,
  -0.4827, -0.7698, -1.3287, -0.779, 0.0258, -0.2128, -0.7865, -0.4013, -1.0237, -0.7318,
  0.1252, -0.5641, 0.1088, -0.5772, -0.828, -0.7983, -0.4176, -0.6032, -0.6444, 0.188,
  -0.9421, -1.531, -0.6444, -0.8417, -1.0032, -0.884, -0.5774, -0.5572, 1.4971, 0.7458,
  0.3052, 0.0704, -0.0998, -0.2017, -0.0957, 1.7215, 0.8128, -0.3866, 0, 0.4345,
  0.206, 0.5257, -1.6194, -0.2511, -0.0035, -1.3224, -1.5548, -1.401, -1.7454, -0.3677,
  -0.7954, -1.0111, 1.019, -0.0366, -0.4475, -2.3273, -1.2646, 0.1643, -1.1785, 0.2178,
  -0.1264, -0.4345, -0.412, -0.8947, -1.2291, 0.6648, -1.4968, -0.5658, 0.4086, -0.052,
  0.0412, -0.4453, 0.112, -0.4192, 0.2231, -0.7486, -0.8433, -0.0055, -0.0817, -0.8991,
  -1.559, -1.5674, -0.494, -1.3016, -0.4099, 0.0391, -0.7874, -1.3212, -1.1771, 0.2528,
  -0.9357, 0.615, 0.5327, 0.0041, -2.305, -1.9096, -1.6352, 0.6081, -0.4883, 0.1576,
  -0.7566, 0, 0.1477, -0.3883, 0, -0.3076, 0, 1.6244, 0.1165, 0.1588,
  -0.2601, -0.3504, 0.0943, -0.243, -0.2157, -1.0183, 0.4664, 0.7096, -1.1172, -0.7802,
  -0.9216, -0.6608, -0.9118, 0.6726, 0.6065, -0.5505, -0.6198, -1.1564, -0.9603, -0.9156,
  -0.996, -0.8503, -0.2291, -0.3169, -0.5521, -0.7395, -0.599, -1.0092, -1.0706, -0.8017,
  0.037, 0.493, 0.0622, -0.4083, -0.8497, -0.8033, -0.2338, -1.2523, -0.2025, -0.1802,
  -0.5646, -1.2625, -0.1932, 0.0366, -0.263, -0.6362, 0.0902, 0.1416, -0.2028, 0.4761,
  0.7446, -0.5405, -0.3961, 0.5028, -0.5428, 0.5087, 0.3901, 1.0995, -0.9286, 0.3934,
  -0.0789, 0.437, 0.134, -1.544, -0.5463, 1.8218, -1.3889, 0.1405, -1.7879, -1.7783,
  -0.0222, -0.5433, -1.4449, 0.2463, 0.773, -0.3517, -1.8527, -1.3608, 0, -0.1069,
  -0.7041, -0.3132, 1.3135, -0.3, 0.2912, -0.8328, -0.2403, 0.6117, 0.506, -0.3306,
  0.0074, 1.1158, 0, -0.1172, 0, 0, 0, -0.1083, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0.3717, -0.0732, -0.3901, 0.3, -0.2977, -0.2698,
  -0.8437, 0.1498, 0.8278, 0.137, 0.0901, -0.1602, -0.176, 0.1265, -0.6544, 0.4048,
  1.236, 0.2021, -0.0586, -0.2558, -0.1544, 0.4113, 0.0688, 1.1157, 1.4499, 0.4325,
  0.2387, 0.2966, -0.0101, 0.4144, 0.2983, 0.9231, 1.068, 1.0428, 1.2944, 0.7492,
  0.8849, 0.7267, 0.768, 0.5139, 0.1477, -0.0406, 1.1113, -0.1917, 0.3089, 0.2774,
  -0.3676, 0.118, 0, 0, 0, 0, 0, 0, 0, 0,
  1.8236, 2.0613, 1.7792, 1.2588, 1.0961, 0.8706, 1.7359, 1.1292, 1.7019, 0.8588,
  1.0653, 0.7906, 0.5652, 0.4515, 0.5898, 0.491, 1.091, 0.5403, 0.2853, 0.222,
  -0.1532, 0.033, -0.076, 0.7424, 0.6576, 0.0893, 0.0744, -0.1903, -0.3161, -0.3333,
  -0.0881, -0.0296, 0.1056, 0.3449, -0.486, -0.1264, -0.4202, -0.6165, -0.3303, -0.1869,
  0.8533, 0.2004, 0.0456, -0.1346, -0.0904, 0.0667, -0.6184, 0.2044, 0.4353, 0.71,
  0.3502, 0.3603, 0.1121, 0.2989, 0.2254, 0.2797, 0.7981, 0.2062, 0.5169, 0.0498,
  0.7634, 0.4457, -0.6733, -0.3427, -0.5552, -0.4513, 1.2491, 0.4265, 0.5555, 0.8074,
  0.0815, -0.7874, -0.6736, -0.4566, -0.303, 0.3405, 0.3699, -0.5048, -0.5946, -0.1655,
  0.1988, -0.4041, -0.381, -0.2288, -0.1472, -0.1369, -0.3713, 0.0817, 0.2081, 0.0294,
  -0.5294, -0.548, -0.0705, -0.2699, -0.0974, 0.1782, 0.4288, -0.1746, -0.0195, -0.2993,
  -0.5563, -0.3288, -0.066, -0.1286, 0.5019, -0.114, -0.6076, -0.3213, -0.0817, -0.3926,
  -0.2396, -0.2872, 0.6406, -0.005, 0.387, -0.0056, -0.0333, 0.2634, 0.0623, 1.2144,
  0.4196, 0.5544, 0.6388, 0.5497, 0.4274, 0.0861, 0.2007, 0.4209, 0.8397, 0.056,
  -0.2355, -0.2311, -0.512, 0.0423, -0.6112, 0.2822, 0.4956, -0.0126, -0.365, -0.3403,
  -0.3292, -0.4132, -0.8926, -0.4792, 0.7795, -0.0794, -0.3553, -0.3852, -0.2168, 0.0235,
  -0.7091, -0.1584, 0.4377, -0.1571, -0.3711, -0.5752, -0.3346, -0.1665, -0.0726, -0.2037,
  0.0182, 0.162, -0.312, -0.3962, -1.061, -0.7404, -0.7464, -0.3214, 0.1014, -0.2202,
  -0.642, -0.7489, -0.9942, -0.9416, -0.623, -0.7593, -0.4938, -0.8059, -0.956, -1.1803,
  -0.8577, -0.7366, -0.8955, -0.2743, -0.3516, -0.0264, -0.1384, -0.595, -0.9766, -0.0065,
  -0.5275, -0.0374, 0.9978, 0.6735, 0.6531, 0.4263, 0.5956, 0.216, 0.2896, 0.493,
  0.3987, 0.251, 0.0984, 0.1643, 0.0725, -0.2256, -0.2667, -0.177, 0.5514, -0.1505,
  -0.141, -0.3081, -0.5632, -0.3412, -0.5569, -0.2636, 0.2776, 0.264, -0.0661, -0.4064,
  -0.4529, -0.5547, -0.7044, -0.485, 0.0478, -0.0777, -0.2357, -0.1414, -0.7026, -0.6029,
  -0.3126, -0.798, 0.5586, 0.0308, -0.2695, -0.6733, -0.3723, -0.6016, -0.7193, -0.6071,
  0.5683, 0.081, -0.3286, -0.1398, -0.5441, -0.3823, -0.8863, 0.1941, 0.2072, -0.0103,
  0.1575, -0.081, -0.0677, -0.3384, -0.1266, -0.0859, -0.5184, -0.7648, -0.291, 0.5151,
  0.1865, 0.5938, -0.215, -0.0958, -0.9868, -1.1785, -0.8665, -0.4245, -0.0032, -0.3257,
  -0.5103, -0.3326, -0.6886, -1.1361, -0.7862, -0.2455, -0.2571, -0.4457, -0.5013, -0.4828,
  -0.3363, -1.2353, 0.0923, 0.185, -0.0104, -0.1307, -0.239, 0.2118, 0.3719, -0.7326,
  0.4037, 0.1452, -0.5965, 0.0876, -0.5015, -0.1333, -0.3778, -0.9614, 0.5855, 0.206,
  -0.7706, 0.6805, 0.7953, 0.4865, -0.7462, -0.5961, -1.0314, -0.5812, -0.3633, -1.445,
  -0.4415, -0.0033, 0, -0.0027, 0.2034, 0, -0.2589, -0.3251, 0, -0.3358,
  0, 0, 0, 0, 0, 0, 0, 0, 0.3729, -0.5842,
  -0.5758, -0.7537, -0.8199, -0.3951, -0.3253, 0.0972, 0.8476, -0.1367, -0.4922, -0.4394,
  -0.2929, -0.0981, -0.2465, 0.3665, 0.6601, -0.1458, -0.0122, 0.0024, -0.0716, 0.1808,
  0.0889, 0.5198, 1.1625, 0.6355, 0.589, 0.1614, 0.1304, 0.3843, 0.2238, 1.1364,
  1.014, 1.6212, 0.4837, 1.1394, 0.5622, 0.6885, 1.2417, 1.0767, 0.0356, 0.0559,
  -0.2796, -0.131, 0.1787, -0.2304, 0.3149, 0.0898, 0, 0, 0, 0,
  0, 0, 0, 0, 1.4742, 0.9949, 0.7834, 0.9013, 0.9835, 0.6622,
  1.55, 0.7229, 0.601, 0.6307, 0.2594, 0.2354, 0.2115, 0.4626, 0.7968, 1.547,
  0.4865, 0.0092, 0.3891, -0.126, -0.266, -0.0503, 0.1852, 0.5586, 0.6626, -0.5604,
  -0.5786, -0.5434, -0.32, -0.5853, -0.1169, 0.3271, -0.0091, -0.2807, -0.6489, -0.6671,
  -0.7453, -0.3282, 0.5767, 0.4063, 0.878, 0.0825, 0.1686, -0.6074, -0.4484, 0.2194,
  0.0744, 0.5942, 0.6704, 0.6709, 0.2953, 0.0584, 0.5233, 0.7592, 0.6207, 0.5814,
  1.2177, -0.0641, 0.6776, 0.1661, 0.6937, 0.8421, 0.5131, 0.2236, 0.0542, 0.2148,
  0.7365, 0.0775, 0.0805, 0.2154, 0.3069, 0.3104, -0.3512, -0.0784, -0.3978, -0.1346,
  -0.3301, -0.3769, 0.2072, 0.1346, 0.1021, -0.8062, -0.7652, -0.4495, -0.5234, -0.4907,
  -0.4046, 0.128, 0.0188, -0.7015, -0.5624, -0.9433, -0.4203, -0.5265, -0.4404, 0.2908,
  0.1221, -0.2401, -0.8315, -0.7802, -0.9555, -0.3755, -0.2908, -0.1453, 0.4885, -0.3656,
  -0.6837, -0.6137, -0.9123, -0.1126, -0.0399, 0.1357, 0.8425, -0.2712, -0.2277, -0.3694,
  0.1894, 0.2558, -0.23, 0.152, 0.4773, 0.3592, 0.2487, -0.4242, 0.2193, 0.1699,
  0.0138, -0.7364, 0.3392, -0.0617, -0.0296, 0.161, 0.0707, 0.3042, 0.2354, 0.5229,
  -0.1801, -0.5271, -0.2307, -0.4449, -0.3091, 0.114, 0.045, 0.1663, -0.1011, -0.1706,
  -0.1812, -0.3016, -0.2776, -0.1292, -0.2355, 0.4121, -0.4934, -0.3899, -0.1236, -0.7124,
  -0.1804, 0.2706, 0.0764, 0.1387, -0.465, -0.5263, -0.6083, -0.2738, -0.2534, -0.1374,
  -0.1854, 0.1933, -0.3726, -0.6846, -0.5256, -0.4944, -0.3235, -0.4185, -0.4229, -0.2595,
  -0.4595, -0.7047, -0.6683, -0.4447, -0.3484, -0.2951, -0.4154, -0.2295, -0.6723, -0.4352,
  -0.4047, -0.0737, -0.3903, -0.2804, -0.3667, -0.1166, 0.4949, 0.4629, 0.3213, 0.2553,
  1.2761, 0.203, -0.528, -0.4548, -0.0588, -0.1705, 0.5095, -0.0236, -0.1576, -0.1594,
  -0.5157, 0.5545, 1.0321, 0.1631, -0.0799, -0.4477, -0.7469, -0.1976, -0.2946, 0.4355,
  1.009, -0.8092, -0.5189, -0.397, -0.3536, -0.8475, 0.3922, 0.9394, -0.1546, -0.5725,
  -0.259, -0.4837, -0.7089, -0.3175, -0.5816, 0.9531, 0.6607, -0.2171, -1.2355, -0.2964,
  -0.4828, 0.1154, 0.2855, 0.2839, 0.5603, -0.1477, 0.2407, 0.211, -0.4291, -0.0528,
  0.9751, 0.4001, 0.3956, -0.0285, 0.7187, 0.3619, 0.069, 0.5926, 0.4813, 0.3291,
  1.6741, 1.0252, 1.1242, 1.6409, 1.4921, 2.0553, 1.9284, 2.5876, 0.545, -0.2769,
  0.2741, 0.1923, 0.4245, 0.4375, 0.8271, 1.1813, 0.3079, -0.4148, -0.3308, -0.4628,
  -0.4639, -0.3782, -0.0497, 0.7395, -0.6728, -0.9062, -0.8835, -1.1323, -0.9939, -0.8496,
  -0.4291, -0.0686, -0.4782, -1.6373, -1.2374, -0.8308, -1.2255, -1.4858, -1.3092, -0.2342,
  -1.0849, -1.479, -0.8751, -1.3085, -1.4014, -1.7253, -1.5879, -1.0173, -1.2231, -1.8017,
  -1.6618, -1.5116, -1.5387, -2.1517, -1.4654, -1.1339, -0.8983, 0.2842, -0.6683, -0.2311,
  -0.5858, -0.564, -0.3153, -0.1971, 1.6094, 2.9166, 3.0454, 3.5922, 4.9512, 0,
  0.9915, 3.2428, 3.5849, 4.6409, 5.9492, 0, 1.3139, 3.3386, 4.1466, 5.102,
  6.3316, 0, 2.0504, 3.0707, 3.2062, 4.3797, 6.332, 0, 1.7653, 3.1431,
  3.2884, 3.2544, 5.8595, 0, 2.0927, 3.0522, 3.1893, 3.7343, 5.8691, 0,
  0.9181, 1.3081, -2.1138, -2.967, -2.0032, 1.611, 2.2209, 1.76, -1.6187, -3.1347,
  -3.0837, -4.0453, -5.6059, 0, 0.4978, 0.9109, 1.1027, 1.0076, 1.305, 0,
  0.9029, 0.6663, 0.62, 1.1748, 0.6354, 1.2352, 0.7823, 1.1358, 0.5662, 1.4257,
  0.8369, 1.5794, 0.4221, 0.3854, -0.0956, 0.2244, 0.1869, 0, -1.014, -2.3474,
  -2.5283, -2.1005, -3.1576, 0, 0.6186, 0.2602, 0.0669, 0.0247, -0.2537, -0.3573,
  -0.5614,
];

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

   evaluate(pos) simply walks the board and adds up material and
   placement. (Real engines keep these sums up to date as each move
   is made, which is faster but spreads the evaluation over more
   than one function.) The skill level's occasional blunder is added
   separately, by judge().
*/

/** Piece-square bonuses, by piece * 64 + index64(sq). */
type PsqTable = Int16Array;

const MG_VALUE: readonly number[] = [0, 100, 320, 330, 500, 900, 0];
const EG_VALUE: readonly number[] = [0, 120, 320, 330, 520, 920, 0];
/* Each piece type's share of the game phase. Summed over the board:
   24 (PHASE_MAX) at the start, 0 when only kings and pawns remain. */
const PHASE_WEIGHT: readonly number[] = [0, 0, 1, 1, 2, 4, 0];
const PHASE_MAX = 24;

/* Bonus for a white piece of `pieceType` on file f, rank r (0 = rank
   1), as [middlegame, endgame]. `centre` runs from 0 on the rim to 3
   on the four centre squares. */
function psqBonus(
  pieceType: PieceType, f: File, r: Rank,
): readonly [mg: Score, eg: Score] {
  const fromCentre = Math.max(Math.abs(2 * f - 7), Math.abs(2 * r - 7));
  const centre = 3 - Math.floor((fromCentre - 1) / 2);
  const undeveloped = r === 0 ? -10 : 0;
  switch (pieceType) {
    case PAWN: {
      const centrePawn = (f === 3 || f === 4) && (r === 3 || r === 4);
      return [(r - 1) * 3 + (centrePawn ? 15 : 0), (r - 1) * 12];
    }
    case KNIGHT: return [centre * 12 - 24 + undeveloped, centre * 12 - 24];
    case BISHOP: return [centre * 6 - 12 + undeveloped, centre * 6 - 12];
    case ROOK: {
      const seventh = r === 6 ? 15 : 0;
      return [(f === 3 || f === 4 ? 5 : 0) + seventh, seventh];
    }
    case QUEEN: return [centre * 3 - 6, centre * 5 - 10];
    case KING:
    default: {
      const shelter = f <= 2 || f >= 5 ? 20 : -10;
      return [-Math.min(r, 3) * 25 + shelter, centre * 15 - 30];
    }
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

/* Static evaluation of `pos`, in centipawns for the side to move:
   material and placement, tapered from the middlegame sum to the
   endgame sum as material (the phase) leaves the board. */
function evaluate(pos: Position): Score {
  const board = pos.board;
  let mg = 0, eg = 0, phase = 0; // mg and eg are white minus black
  for (const sq of SQUARES) {
    const piece = board[sq];
    if (piece === EMPTY) continue;
    const pieceType = typeOf(piece), sign = colourOf(piece) === WHITE ? 1 : -1;
    const at = piece * 64 + index64(sq);
    mg += sign * MG_VALUE[pieceType] + PSQ_MG[at];
    eg += sign * EG_VALUE[pieceType] + PSQ_EG[at];
    phase += PHASE_WEIGHT[pieceType];
  }
  const tapered = Math.min(phase, PHASE_MAX);
  const score =
    Math.trunc((mg * tapered + eg * (PHASE_MAX - tapered)) / PHASE_MAX);
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
     key             Zobrist key (see zobristKeys)
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

/* The kingside or queenside castling Right of `colour`. */
function castlingRight(colour: Colour, kingside: boolean): Right {
  return colour * 2 + (kingside ? 0 : 1);
}
/* Is `right` among `rights`? */
function hasRight(rights: Rights, right: Right): boolean {
  return ((rights >> right) & 1) !== 0;
}
/* Is `right` a kingside right? */
function isKingside(right: Right): boolean {
  return right % 2 === 0;
}

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

  /* A copy of `pos`: its board, piece counts, king squares and key. */
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
  let epSquare = NO_SQUARE, capturedPiece = EMPTY;
  let halfmoveClock = pos.halfmoveClock + 1;

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
    sideToMove: them, castlingRights, castle: pos.castle, epSquare,
    halfmoveClock, key: draft.key, gamePly: pos.gamePly + 1, capturedPiece,
    previous: pos,
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
  const us = pos.sideToMove;
  return isSquareAttacked(pos.board, pos.kingSq[us], opponent(us));
}

/* Draw by the fifty-move rule, by repetition (once is enough inside
   the search), or by insufficient material (bare kings, or a single
   minor piece). Repetitions are looked for among earlier positions
   with the same side to move, 2, 4, 6... plies back, but not past the
   last capture or pawn move, nor past the first position (gamePly
   plies back). */
function isDraw(pos: Position): boolean {
  if (pos.halfmoveClock >= 100) return true;
  const reach = Math.min(pos.halfmoveClock, pos.gamePly);
  for (let back = 2, earlier = pos; back <= reach; back += 2) {
    earlier = earlier.previous!.previous!;
    if (earlier.key === pos.key) return true;
  }
  const n = pos.pieceCount;
  /* How many pieces of `pieceType` both sides have. */
  function count(pieceType: PieceType): number {
    return n[makePiece(pieceType, WHITE)] + n[makePiece(pieceType, BLACK)];
  }
  const minors = count(KNIGHT) + count(BISHOP);
  return count(PAWN) + count(ROOK) + count(QUEEN) === 0 && minors <= 1;
}

/* ---- FEN ----------------------------------------------------------
   The castling field may be KQkq (standard), file letters as in
   Shredder-FEN (HAha), or a mixture (X-FEN). K/Q mean the outermost
   rook on that side of the king, which covers Chess960 too. */
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/* The words of a line, split at runs of whitespace. */
function words(line: string): string[] {
  return line.trim().split(/\s+/);
}

/* `text` as a whole decimal integer, or `fallback` if it is not one. */
function toInteger(text: string | undefined, fallback: number): number {
  return text !== undefined && /^[+-]?\d+$/.test(text)
    ? Number(text) : fallback;
}

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

  const { castlingRights, castle } =
    castlingFromFen(board, kingSq, parts[2] ?? "-");
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
  const outermostRook = (
    rank: Rank, rook: Piece, edge: File, kingFile: File,
  ): File => {
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
    const ch = chess960 && !standard ? FILE_NAMES[file]
      : isKingside(right) ? "k" : "q";
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
  const kingColour: Colour = rankOf(from) === 0 ? WHITE : BLACK;
  const to = moveType(move) === FLAG_CASTLE && !chess960
    ? CASTLE_KING_TO[castlingRight(kingColour, toSq(move) > from)]
    : toSq(move);
  const promo = promoType(move);
  const promotion = promo !== 0 ? PIECE_CHARS[makePiece(promo, BLACK)] : "";
  return squareName(from) + squareName(to) + promotion;
}

/* The legal move of pos written as `str`, or NO_MOVE. Castling is
   accepted in either notation. */
function parseMove(pos: Position, str: string, chess960: boolean): Move {
  for (const move of legalMoves(pos)) {
    if (moveToUci(move, chess960) === str) return move;
    const castles = moveType(move) === FLAG_CASTLE;
    if (castles && moveToUci(move, !chess960) === str) return move;
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
  [], [], KNIGHT_OFFSETS, BISHOP_OFFSETS,
  ROOK_OFFSETS, KING_OFFSETS, KING_OFFSETS,
];
/** By colour: the two diagonal steps of a capturing pawn. */
const PAWN_CAPTURE_OFFSETS: readonly (readonly number[])[] =
  [[15, 17], [-17, -15]];
/** Each slider with the rays it moves along (a queen moves along both). */
const SLIDER_RAYS: readonly (readonly [PieceType, readonly number[]])[] =
  [[BISHOP, BISHOP_OFFSETS], [ROOK, ROOK_OFFSETS]];

/* Does `pieceType` keep stepping along its rays: bishop, rook or queen? */
function isSlider(pieceType: PieceType): boolean {
  return pieceType >= BISHOP && pieceType <= QUEEN;
}

/* The pseudo-legal moves of pos for the side to move, as a new array.
   King safety is checked by makeMove().

   Castling (standard and Chess960 alike): every square the king and
   rook pass over or land on must be empty, apart from the two of
   them, and the king may not start in, pass through or end in check.
   All four squares are on one rank, so the squares between them are
   consecutive numbers. */
function generateMoves(pos: Position): Move[] {
  const board = pos.board, moves: Move[] = [];
  const us = pos.sideToMove, them = opponent(us);
  const up = PAWN_STEP[us];
  const startRank = us === WHITE ? 1 : 6;
  const promoRank = us === WHITE ? 7 : 0;
  // A pawn move, or its four promotions on the last rank.
  function pawnMove(from: Square, to: Square, type: MoveType): void {
    if (rankOf(to) === promoRank) {
      for (let promo = QUEEN; promo >= KNIGHT; promo--)
        moves.push(encodeMove(from, to, promo, 0));
    } else moves.push(encodeMove(from, to, 0, type));
  }

  for (const sq of SQUARES) {
    const piece = board[sq];
    if (piece === EMPTY || colourOf(piece) !== us) continue;
    const pieceType = typeOf(piece);

    if (pieceType === PAWN) {
      const push = sq + up;
      if (board[push] === EMPTY) {
        pawnMove(sq, push, 0);
        if (rankOf(sq) === startRank && board[push + up] === EMPTY)
          pawnMove(sq, push + up, 0);
      }
      for (const offset of PAWN_CAPTURE_OFFSETS[us]) {
        const to = sq + offset;
        if (!onBoard(to)) continue;
        const occupant = board[to];
        if (occupant !== EMPTY && colourOf(occupant) === them)
          pawnMove(sq, to, 0);
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

/* The Zobrist numbers drawn from a xorshift32 generator started at
   `seed`, in the order described above. */
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

const GO_NUMBERS = [
  "wtime", "btime", "winc", "binc",
  "movestogo", "depth", "nodes", "movetime",
] as const;
type GoNumber = typeof GO_NUMBERS[number];
/** A parsed "go" command: whichever of the numbers it gave, plus infinite. */
type Go =
  { readonly [K in GoNumber]?: number } & { readonly infinite?: boolean };
/* Is `word` one of the numbered fields of a "go" command? */
function isGoNumber(word: string): word is GoNumber {
  return (GO_NUMBERS as readonly string[]).includes(word);
}

/* The session a fresh engine starts in: the starting position, at
   SKILL_MAX, not Chess960. */
function newSession(): Session {
  return {
    pos: parseFen(START_FEN),
    skill: skillFor(SKILL_MAX, 0),
    chess960: false,
  };
}

/* Carry out one UCI command, and return the session it leaves.
   "stop" is left to the I/O layer, which handles it while searching;
   "quit" is echoed back so the I/O layer knows the queue is drained.
   Unknown commands are ignored. */
function uciCommand(session: Session, line: string, io: Io): Session {
  const tokens = words(line);
  const { pos, skill, chess960 } = session;
  switch (tokens[0]) {
    case "uci":
      identify(io);
      return session;
    case "setoption":
      return setOption(session, tokens);
    case "isready":
      io.out("readyok");
      return session;
    case "ucinewgame":
      return { ...session, pos: parseFen(START_FEN) };
    case "position": {
      const args = tokens.slice(1).join(" ");
      return { ...session, pos: parsePosition(args, chess960) };
    }
    case "go":
      go(session, tokens, io);
      return session;
    case "stop":
      return session;
    case "quit":
      io.out("quit");
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

/* Answer "uci": the engine's name and author, then its options:
     Hash          accepted, no effect: there is no transposition table
     Threads       accepted for OpenBench; always single-threaded
     UCI_Chess960  castling is written king-takes-rook
     Skill_Level   1 = random mover, SKILL_MAX = strongest
     Skill_Seed    which deterministic opponent; 0 = built-in */
function identify(io: Io): void {
  io.out("id name Pedagog 1.0");
  io.out("id author Copilot (Claude Fable 5.1)");
  io.out("option name Hash type spin default 16 min 1 max 1024");
  io.out("option name Threads type spin default 1 min 1 max 1");
  io.out("option name UCI_Chess960 type check default false");
  io.out("option name Skill_Level type spin" +
    ` default ${SKILL_MAX} min 1 max ${SKILL_MAX}`);
  io.out("option name Skill_Seed type spin default 0 min 0 max 2147483647");
  io.out("uciok");
}

/* The session after "setoption name <name> value <value>". Hash,
   Threads and unknown options leave it as it is. */
function setOption(session: Session, tokens: readonly string[]): Session {
  const nameAt = tokens.indexOf("name"), valueAt = tokens.indexOf("value");
  const name = tokens
    .slice(nameAt + 1, valueAt > 0 ? valueAt : tokens.length)
    .join(" ")
    .toLowerCase();
  const value = valueAt > 0 ? tokens.slice(valueAt + 1).join(" ") : "";
  const { skill } = session;
  if (name === "uci_chess960")
    return { ...session, chess960: value.toLowerCase() === "true" };
  if (name === "skill_level") {
    const level = toInteger(value, SKILL_MAX);
    return { ...session, skill: skillFor(level, skill.seed) };
  }
  if (name === "skill_seed") {
    const seed = toInteger(value, 0);
    return { ...session, skill: skillFor(skill.level, seed) };
  }
  return session;
}

/* Answer "go ...": search the session's position within the limits
   the command gives, report each depth, then the best move ("0000"
   when there is no legal move). */
function go(session: Session, tokens: readonly string[], io: Io): void {
  const { pos, skill, chess960 } = session;
  const limits = limitsFor(parseGo(tokens), pos.sideToMove, skill.level);
  const result = think(pos, limits, skill, {
    now: io.now,
    shouldStop: io.shouldStop,
    onInfo: (info) => io.out(infoLine(info, chess960)),
  });
  const best = result.bestMove !== NO_MOVE
    ? moveToUci(result.bestMove, chess960) : "0000";
  io.out("bestmove " + best);
}

/* A new position from the arguments of a UCI "position" command:
   "startpos" or "fen <FEN>", optionally followed by "moves ...".
   An unknown move is skipped. */
function parsePosition(spec: string, chess960: boolean): Position {
  const tokens = words(spec);
  const movesAt = tokens.indexOf("moves");
  const end = movesAt >= 0 ? movesAt : tokens.length;
  const fen = tokens[0] === "fen" ? tokens.slice(1, end).join(" ") : START_FEN;
  const moves = tokens.slice(end + 1);
  return moves.reduce((pos, str) => {
    const move = parseMove(pos, str, chess960);
    return move !== NO_MOVE ? makeLegalMove(pos, move) : pos;
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

/* Print the perft count under each legal move of `pos` to `depth`,
   then the total, the time and the speed. */
function perftDivide(
  pos: Position, depth: number, chess960: boolean, io: Io,
): void {
  const t0 = io.now();
  let total = 0;
  for (const move of legalMoves(pos)) {
    const count = perft(makeLegalMove(pos, move), depth - 1);
    total += count;
    io.out(`${moveToUci(move, chess960)}: ${count}`);
  }
  const ms = Math.max(1, Math.round(io.now() - t0));
  const nps = Math.floor(total * 1000 / ms);
  io.out(`perft ${depth} nodes ${total} time ${ms} nps ${nps}`);
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

/* Search every BENCH_FENS position to `depth` at SKILL_MAX and print
   the node count of each, then the totals OpenBench reads. */
function bench(depth: number, io: Io): void {
  const skill = skillFor(SKILL_MAX, 0);
  let totalNodes = 0, totalMs = 0;
  for (const fen of BENCH_FENS) {
    const pos = parseFen(fen);
    const t0 = io.now();
    const limits = limitsFor({ depth }, pos.sideToMove, SKILL_MAX);
    const { nodes } = think(pos, limits, skill, {
      now: io.now, shouldStop: () => false, onInfo: () => {},
    });
    totalMs += io.now() - t0;
    totalNodes += nodes;
    io.out(`info string ${nodes} nodes  ${fen}`);
  }
  const nps = Math.floor(totalNodes * 1000 / Math.max(1, totalMs));
  io.out(`${totalNodes} nodes ${nps} nps`);
}

/* The "d" command: the board, its FEN, key and evaluation. */
function printBoard(
  pos: Position, skill: Skill, chess960: boolean,
  out: (line: string) => void,
): void {
  for (let rank = 7; rank >= 0; rank--) {
    let row = `${rank + 1} `;
    for (let file = 0; file < 8; file++)
      row += " " + PIECE_CHARS[pos.board[makeSquare(file, rank)]];
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
   In a browser, the page is the main thread (see src/web/index.html).
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
declare const process: {
  readonly argv: readonly string[];
  exit(code: number): never;
};
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
declare var Pedagog: {
  uci(line: string): void;
  setOutput(fn: (line: string) => void): void;
};

const isBun = typeof Bun !== "undefined";
const inWorker = isBun ? !Bun.isMainThread
  : typeof WorkerGlobalScope !== "undefined" &&
    self instanceof WorkerGlobalScope;

/* Start-up, in one of three hosts:
   - Bun's main thread. `bun engine.ts bench [depth]` runs the bench,
     as OpenBench does. Otherwise it reads stdin and passes commands
     to a worker, but answers "stop", "quit" and (while searching)
     "isready" itself, so they work mid-search. When stdin closes,
     the worker finishes its queue, then exits.
   - The worker, which runs uciCommand(). Until the main thread's
     shared stop flag arrives, it uses one of its own that is never
     set.
   - Anything else (a browser page): drive it by hand through
     globalThis.Pedagog. */
if (isBun && Bun.isMainThread) {
  if (process.argv[2] === "bench") {
    const io: Io = {
      out: (line) => console.log(line), now, shouldStop: () => false,
    };
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
  })();
} else if (inWorker) {
  let session = newSession();
  let stopFlag: Int32Array = new Int32Array(new SharedArrayBuffer(4));
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
  let session = newSession(), output = (line: string) => console.log(line);
  const io: Io = { out: (line) => output(line), now, shouldStop: () => false };
  globalThis.Pedagog = {
    uci: (line) => { session = uciCommand(session, line, io); },
    setOutput: (fn) => { output = fn; },
  };
}
