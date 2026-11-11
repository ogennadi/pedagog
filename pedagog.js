/*
================================================================
                      P E D A G O G
================================================================
   A single-file UCI chess engine in JavaScript, written to be
   read from top to bottom like a short book on chess programming.
   The most interesting part, the search, comes first; the
   plumbing that makes it a program comes last.

   Runs in Bun (`bun pedagog.js`) or in a browser Web Worker
   (`new Worker("pedagog.js")`, post UCI strings, receive lines).

   Supports standard chess and Chess960 (UCI_Chess960),
   a deterministic Skill_Seed (as in Gaia), and the Hash/Threads
   options OpenBench expects. Search uses one thread; a separate
   main thread handles input and interruption, not parallel search.

   It is deliberately a base engine: iterative deepening, alpha-beta
   and captures-first move ordering, with a plain piece-square
   evaluation, and nothing else. Measured against
   Maia-1900 the engine is about 140 Elo stronger than that
   network, which puts its full strength around 1900 on the Lichess
   classical scale. Below full strength, Skill_Level weakens it the
   way Gaia does: it looks less far ahead, misjudges some positions
   on purpose, and overlooks some moves entirely (see COLOPHON.md
   for the measured ladder).

   HOW TO READ IT
   Every function names what it needs in its parameters and hands
   back what it found as its return value, so each one can be read
   on its own page. No function changes anything it is given, and
   there are no module-level variables that change while the engine
   runs; the only `let`s outside a function belong to the I/O code
   at the very end.

   Positions (S4) are values too: makeMove() returns a new position
   rather than changing the old one. That costs some speed, since
   every move copies a board, but nothing ever has to be undone.
================================================================

   TABLE OF CONTENTS
   -----------------
   S0  Constants           Pieces, squares, move encoding
   S1  Search              Iterative deepening, alpha-beta, ordering
   S2  Skill Levels        Depth ceiling, blunders, vision
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
   is  type | colour << 3,  so white pieces are 1..6, black 9..14,
   and  piece & 7  is the type,  piece >> 3  the colour.

   Squares use the 0x88 layout: square = rank * 16 + file. Only
   the low nibble (file) and bits 4..6 (rank) are meaningful, so a
   square is off the board exactly when  (sq & 0x88) !== 0.  This
   makes "is this square on the board?" a single AND.

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

   A move is one 32-bit integer:

     bits  0.. 6   from square
     bits  7..13   to square (for castling: the rook's square)
     bits 14..16   promotion piece type (0 = none)
     bits 17..18   flag: 0 = normal, 1 = en passant, 2 = castling

   Castling is encoded as "king captures own rook", which is the
   only representation that works for both standard chess and
   Chess960. It is converted to e1g1 notation on output when
   UCI_Chess960 is off.
*/

const NAME = "Pedagog", VERSION = "1.0";

const WHITE = 0, BLACK = 1;
const EMPTY = 0, PAWN = 1, KNIGHT = 2, BISHOP = 3;
const ROOK = 4, QUEEN = 5, KING = 6;
const PIECE_CHARS = ".PNBRQK..pnbrqk";

const MAX_PLY = 100;              // longest line the search will follow
const INF = 32500;
const MATE = 32000;               // mate in N plies scores MATE - N
const MATE_IN_MAX = MATE - MAX_PLY;

const FLAG_EP = 1, FLAG_CASTLE = 2;

const moveFrom = (move) => move & 127;
const moveTo = (move) => (move >> 7) & 127;
const movePromo = (move) => (move >> 14) & 7;
const moveFlag = (move) => (move >> 17) & 3;
const encodeMove = (from, to, promo, flag) =>
  from | (to << 7) | (promo << 14) | (flag << 17);

const squareName = (sq) => "abcdefgh"[sq & 7] + ((sq >> 4) + 1);
const parseSquare = (str) =>
  (str.charCodeAt(1) - 49) * 16 + (str.charCodeAt(0) - 97);

const now = () => performance.now();

/* ================================================================
   S1  SEARCH
   ================================================================

   The search answers one question: which move is best? It looks
   ahead a fixed number of plies with negamax alpha-beta, trying
   captures first, and asks the static evaluation about the
   positions at the leaves. That is the whole search: there is no
   quiescence search, no hash table and no pruning beyond alpha-beta
   itself. (The missing quiescence search shows: a leaf in the middle
   of an exchange is judged as if the exchange were over, the
   "horizon effect", and the score swings between odd and even
   depths.)

   think(pos, limits, skill, io)
               iterative deepening: depth 1, 2, 3, ... until a limit
               is reached. Returns the result of the last finished
               depth, so there is always a complete answer.
   search(pos, alpha, beta, depth, ply)
               negamax alpha-beta. Alpha is the best score the side
               to move is already assured of, beta the best the
               opponent will allow. A move scoring >= beta is "too
               good": the opponent would never let us get here, so
               the remaining moves need not be looked at (a cutoff).
               Returns { score, pv }: the score and the line of best
               play (principal variation) that produces it.

   search() is written inside think(): everything it uses besides
   its arguments (the skill, the overlooked root moves, the node
   count and the stop flag) is declared a few lines above it, in
   think().

   Scores are always from the point of view of the side to move
   (negamax): +100 means "the side to move is a pawn up". A child's
   score is negated on the way back up, because what is good for
   one side is bad for the other.
*/

const NO_LINE = Object.freeze([]);

/* Choose a move for `pos` within `limits` (from limitsFor()), playing
   as `skill` (from skillFor()). `io` supplies the clock, `now()`; a
   stop request, `shouldStop()`; and `onInfo(result)`, called after
   every finished depth. Returns { bestMove, depth, score, nodes,
   elapsed, pv }; bestMove is 0 when there is no legal move. */
function think(pos, limits, skill, io) {
  const startTime = io.now();
  const rootMoves = legalMoves(pos);
  if (rootMoves.length === 0)
    return { bestMove: 0, depth: 0, score: 0, nodes: 0, elapsed: 0, pv: [] };

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
  const maxDepth = Math.min(limits.depth, skillDepth(pos, skill));
  // A draw is worth -contempt to the side we play, +contempt to the other.
  const rootSide = pos.side;
  const drawFor = (side) => (side === rootSide ? -skill.contempt : skill.contempt);
  let nodes = 0, stopped = false, rootDepth = 0;
  let best = {
    bestMove: rootMoves.find((move) => !unseen.includes(move)),
    depth: 0, score: 0, nodes: 0, elapsed: 0, pv: [],
  };

  for (let depth = 1; depth <= maxDepth; depth++) {
    rootDepth = depth;
    const { score, pv } = search(pos, -INF, INF, depth, 0);
    if (stopped) break; // an interrupted depth cannot replace `best`
    best = { bestMove: pv[0], depth, score, nodes, elapsed: io.now() - startTime, pv };
    io.onInfo(best);
    if (best.elapsed > limits.softMs) break;
  }
  return { ...best, nodes };

  /* Checked every 1024 nodes from depth 2 on: the first depth always
     finishes, so there is always a move to play. */
  function limitReached() {
    return (limits.nodes > 0 && nodes >= limits.nodes) ||
      io.now() - startTime >= limits.hardMs || io.shouldStop();
  }

  /* Negamax to a fixed depth: terminate, try moves, keep the best line,
     and stop at a beta cutoff. */
  function search(pos, alpha, beta, depth, ply) {
    nodes++;
    if (rootDepth > 1 && (nodes & 1023) === 0 && limitReached()) stopped = true;
    if (stopped) return { score: 0, pv: NO_LINE };
    if (ply > 0 && isDraw(pos)) return { score: drawFor(pos.side), pv: NO_LINE };
    if (depth === 0 || ply >= MAX_PLY - 1) { // a leaf
      const score = skill.quiescence ? quiesce(pos, alpha, beta, ply) : judge(pos, skill);
      return { score, pv: NO_LINE };
    }

    let bestScore = -INF, pv = NO_LINE;
    let raisedAlpha = alpha; // alpha, raised as better moves are found
    let legalMoveCount = 0, searchedMoveCount = 0;
    const moves = generateMoves(pos);
    for (const move of skill.captureOrder ? orderByValue(pos, moves) : orderMoves(pos, moves)) {
      if (ply === 0 && unseen.includes(move)) continue;
      const next = makeMove(pos, move);
      if (next === null) continue;              // leaves our king in check
      legalMoveCount++;
      if (ply > 0 && !seesMove(next, skill, move, ply)) continue;
      searchedMoveCount++;
      const child = search(next, -beta, -raisedAlpha, depth - 1, ply + 1);
      if (stopped) return { score: 0, pv: NO_LINE };

      const score = -child.score;
      if (score > bestScore) {
        bestScore = score;
        if (score > raisedAlpha) {
          raisedAlpha = score;
          pv = [move, ...child.pv]; // this move, then the best reply line
          if (raisedAlpha >= beta) break; // opponent would never allow it
        }
      }
    }

    if (legalMoveCount === 0)
      return { score: inCheck(pos) ? -MATE + ply : drawFor(pos.side), pv: NO_LINE };
    if (searchedMoveCount === 0) // overlooked every legal move
      return { score: judge(pos, skill), pv: NO_LINE };
    return { score: bestScore, pv };
  }

  /* Quiescence: at a leaf, keep trying captures (and promotions) until
     the position is quiet, so a leaf is not judged in the middle of an
     exchange. The side to move may always "stand pat" instead: decline
     every capture and take the leaf's own judgement. Returns a score. */
  function quiesce(pos, alpha, beta, ply) {
    nodes++;
    if (rootDepth > 1 && (nodes & 1023) === 0 && limitReached()) stopped = true;
    if (stopped) return 0;
    const standPat = judge(pos, skill);
    if (standPat >= beta || ply >= MAX_PLY - 1) return standPat;
    let bestScore = standPat, raisedAlpha = Math.max(alpha, standPat);
    for (const move of capturesByValue(pos, generateMoves(pos))) {
      const next = makeMove(pos, move);
      if (next === null) continue;
      const score = -quiesce(next, -beta, -raisedAlpha, ply + 1);
      if (stopped) return 0;
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
}

/* ---- Move ordering --------------------------------------------
   Alpha-beta prunes most when a good move is tried first, and the
   simplest guess at a good move is a capture. So: captures (and
   en passant and promotions) first, then the quiet moves, each group
   in the order it was generated. Castling is encoded as "king takes
   own rook", so it lands in the first group too. Ranking the
   captures themselves (most valuable victim first, MVV-LVA) is the
   next refinement: orderByValue() below, used at full strength.
   Returns a new array. */
function orderMoves(pos, moves) {
  const board = pos.board, early = [], late = [];
  for (const move of moves) {
    if (board[moveTo(move)] !== EMPTY || moveFlag(move) === FLAG_EP || movePromo(move) !== 0)
      early.push(move);
    else late.push(move);
  }
  return early.concat(late);
}

/* Does `move` take a piece or promote? Castling ("king takes own
   rook") does not count. */
function isCapture(pos, move) {
  return moveFlag(move) !== FLAG_CASTLE &&
    (pos.board[moveTo(move)] !== EMPTY || moveFlag(move) === FLAG_EP || movePromo(move) !== 0);
}

/* The captures (and promotions) among `moves`, as a new array: the
   most valuable victim first and, among equal victims, the least
   valuable attacker first (MVV-LVA). */
function capturesByValue(pos, moves) {
  const victim = (move) => (moveFlag(move) === FLAG_EP ? PAWN : pos.board[moveTo(move)] & 7);
  const gain = (move) => 10 * MG_VALUE[victim(move)] + MG_VALUE[movePromo(move)] -
    MG_VALUE[pos.board[moveFrom(move)] & 7];
  return moves.filter((move) => isCapture(pos, move)).sort((a, b) => gain(b) - gain(a));
}

/* `moves` with the captures ranked by value first, then the rest in
   the order they were generated. Returns a new array. */
function orderByValue(pos, moves) {
  return capturesByValue(pos, moves).concat(moves.filter((move) => !isCapture(pos, move)));
}

/* ---- Time management -------------------------------------------
   Turn the numbers of a UCI "go" command into search limits for the
   side to move: { depth, nodes, softMs, hardMs }. Two time budgets:
   a soft one (do not start another depth after it) and a hard one
   (abort the search). The first second of the clock is a reserve
   that is never planned for: the GUI's clock also counts delays the
   search cannot see (passing messages, other programs, garbage
   collection), and a player that lives on its increment loses on
   time to the first such hiccup. Below the reserve only part of the
   increment is spent, so the clock climbs back. Below full strength
   the clock is ignored: a level is a depth, never a time budget, so
   it plays the same on any machine. */
function limitsFor(go, side, level) {
  const untimed = {
    depth: go.depth || MAX_PLY, nodes: go.nodes || 0,
    softMs: Infinity, hardMs: Infinity,
  };
  if (level < SKILL_MAX) return untimed;
  const overhead = 20;
  if (go.movetime) {
    const ms = Math.max(1, go.movetime - overhead);
    return { ...untimed, softMs: ms, hardMs: ms };
  }
  const time = side === WHITE ? go.wtime : go.btime;
  if (time === undefined) return untimed;
  const inc = (side === WHITE ? go.winc : go.binc) || 0;
  const movesToGo = go.movestogo || 30;
  const usable = Math.max(0, time - 1000); // the first second is the reserve
  const softMs = Math.max(1, usable / movesToGo + 0.75 * inc - overhead);
  const hardMs = Math.max(1, Math.min(2 * softMs, usable / 4 + 0.75 * inc - overhead));
  return { ...untimed, softMs, hardMs };
}

/* ================================================================
   S2  SKILL LEVELS
   ================================================================

   Deliberately weakened play, for opponents meant to be beatable,
   after Gaia (jromang/gaiachess, src/skill.rs). At full strength
   every function here is inert and the search is exactly S1.

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
   COLOPHON.md.)

   Every choice is drawn from the position's hash and the Skill_Seed,
   never from the clock or a random generator, so a level misjudges
   the same position the same way every time: stable blind spots, not
   a tremor. Level 1 is apart: it plays a random legal move, but
   always mates in one when it can. Levels 2..SKILL_MAX-1 come from
   the LADDER below; their ratings were measured against Maia and
   are recorded in COLOPHON.md.

   A skill is a frozen value made by skillFor(level, seed); the
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

const rung = (depth, deeperPermille, blunderWindow, blunderPermille, vision) =>
  ({ depth, deeperPermille, blunderWindow, blunderPermille, vision });

/* The ladder, from a beginner's opponent to full strength, about 125 Elo a
   rung as measured against Maia. The ratings are on the Lichess classical
   scale: Maia-1900's bot (maia9) was rated 1755 there when this was
   measured, and the fit is anchored on it (see COLOPHON.md). */
const LADDER = [
  //   depth  deeper  blunder  b/1000  vision             measured Elo
  null,                                          //  1  random mover    ~170
  rung(2,     100,     500,     45,     860),    //  2                  945
  rung(2,     200,     450,     40,     910),    //  3                 1072
  rung(2,     400,     400,     35,     945),    //  4                 1195
  rung(2,     650,     400,     25,     967),    //  5                 1309
  rung(3,       0,     350,     20,     980),    //  6                 1417
  rung(3,     650,     300,     15,    1000),    //  7                 1553
  rung(4,      50,       0,      0,    FULL_VISION),   //  8           1656
  rung(4,     600,       0,      0,    FULL_VISION),   //  9           1789
  rung(MAX_PLY, 0,       0,      0,    FULL_VISION), // 10 full strength 1894
];

/* Full strength's playing style: eager to attack, unwilling to draw.
     contempt    a draw counts as this many centipawns lost for the side
                 the engine plays, so it avoids repetitions and dead
                 simplifications;
     kingAttack  middlegame bonus, per square, for each knight, bishop,
                 rook or queen standing closer to the enemy king (queens
                 count twice), so the pieces gather around the king;
     materialMg  middlegame material counts this many permille of its
                 value, so giving it up for an attack costs less.
   The weakened levels keep the plain style: their ratings were
   measured without it. */
const AGGRESSIVE = {
  contempt: 0, kingAttack: 120, materialMg: 150, quiescence: true, captureOrder: false,
};
const PLAIN = {
  contempt: 0, kingAttack: 0, materialMg: 1000, quiescence: false, captureOrder: false,
};

/* The skill for a Skill_Level (clamped to 1..SKILL_MAX) and a
   Skill_Seed. The seed picks which weakened opponent a level is; 0
   means the built-in one, so an engine nobody configures still plays
   the same game twice. At full strength nothing is drawn from it.
   Level 1 has no rung; it borrows full strength's (unused) knobs. */
function skillFor(level, seed) {
  const clamped = Math.min(SKILL_MAX, Math.max(1, level | 0));
  const seedInt = seed | 0;
  return Object.freeze({
    ...(LADDER[clamped - 1] || LADDER[SKILL_MAX - 1]),
    ...(clamped === SKILL_MAX ? AGGRESSIVE : PLAIN),
    level: clamped,
    seed: seedInt,
    seedKey: mix32(seedInt === 0 ? BUILT_IN_SEED : seedInt),
  });
}

/* Depth ceiling for `pos`: the rung's depth, and one more on the
   rung's share of positions, decided by the hash. */
function skillDepth(pos, skill) {
  if (skill.deeperPermille === 0) return skill.depth;
  const hash = mix32(keyLow(pos.key) ^ skill.seedKey ^ DEPTH_SALT);
  return skill.depth + (hash % 1000 < skill.deeperPermille ? 1 : 0);
}

/* What this skill makes of `pos`: the evaluation, its style's view of
   the position and, now and then, a misjudgement. This is what the
   search sees at a leaf. */
function judge(pos, skill) {
  return evaluate(pos) + styleBonus(pos, skill) + blunder(pos, skill);
}

/* The style's adjustment to the evaluation, in centipawns for the side
   to move: kingAttack per square that each side's pieces stand closer
   to the enemy king, less the discounted share of middlegame material.
   Both fade out, like the middlegame tables, as material leaves. */
function styleBonus(pos, skill) {
  if (skill.kingAttack === 0 && skill.materialMg === 1000) return 0;
  const board = pos.board;
  let closeness = 0, material = 0, phase = 0; // white minus black
  for (let sq = 0; sq < 128; sq++) {
    if (sq & 0x88) { sq += 7; continue; }
    const piece = board[sq];
    if (piece === EMPTY) continue;
    const type = piece & 7, sign = piece < 8 ? 1 : -1;
    phase += PHASE_INC[type];
    material += sign * MG_VALUE[type];
    if (type >= KNIGHT && type <= QUEEN) {
      const distance = KING_DISTANCE[sq - pos.kingSq[(piece >> 3) ^ 1] + 0x77];
      closeness += sign * (7 - distance) * (type === QUEEN ? 2 : 1);
    }
  }
  const mg = closeness * skill.kingAttack - material * (1000 - skill.materialMg) / 1000;
  const score = (mg * Math.min(phase, 24) / 24) | 0;
  return pos.side === WHITE ? score : -score;
}

/* King moves between two squares, looked up by their 0x88 difference:
   KING_DISTANCE[a - b + 0x77]. The difference identifies the file and
   rank offsets, which is a classic convenience of the 0x88 board. */
const KING_DISTANCE = (() => {
  const table = new Int8Array(239);
  for (let df = -7; df <= 7; df++) {
    for (let dr = -7; dr <= 7; dr++)
      table[dr * 16 + df + 0x77] = Math.max(Math.abs(df), Math.abs(dr));
  }
  return table;
})();

/* The occasional misjudgement, added to the evaluation of the rung's
   share of positions: up to blunderWindow centipawns either way. Mate
   scores never pass through here, since they come from the search,
   not from evaluate(). */
function blunder(pos, skill) {
  if (skill.blunderWindow === 0) return 0;
  const hash = mix32(keyLow(pos.key) ^ Math.imul(keyHigh(pos.key), GOLDEN) ^ skill.seedKey);
  if (hash % 1000 >= skill.blunderPermille) return 0;
  return (mix32(hash) % (2 * skill.blunderWindow + 1)) - skill.blunderWindow;
}

/* Does the player notice `move`, made `ply` plies below the root?
   `after` is the position the move leads to, so its key and whether
   the move gives check are known. */
function seesMove(after, skill, move, ply) {
  if (skill.vision >= FULL_VISION) return true;
  const chance = Math.max(skill.vision - VISION_SLOPE * ply, VISION_FLOOR);
  const hash = mix32(keyLow(after.key) ^ Math.imul(move, GOLDEN) ^ skill.seedKey);
  if (((hash >>> 20) & 1023) < chance) return true;
  const easy = after.captured !== EMPTY || moveFlag(move) === FLAG_EP || inCheck(after);
  return easy && ((hash >>> 8) & 1023) < chance;
}

/* The root moves the player overlooks. If it would overlook them all,
   it sees them all: a move has to be played. */
function overlookedRootMoves(pos, skill, rootMoves) {
  if (skill.vision >= FULL_VISION) return [];
  const unseen = rootMoves.filter((move) => !seesMove(makeMove(pos, move), skill, move, 0));
  return unseen.length === rootMoves.length ? [] : unseen;
}

/* Level 1: a random legal move from `moves`, unless one mates on the
   spot. */
function randomMove(pos, skill, moves) {
  return moves.find((move) => givesMate(pos, move)) ??
    moves[mix32(keyLow(pos.key) ^ skill.seedKey) % moves.length];
}

function givesMate(pos, move) {
  const after = makeMove(pos, move);
  return legalMoves(after).length === 0 && inCheck(after);
}

/* A 32-bit integer hash finaliser (two multiply-xorshift rounds). */
function mix32(x) {
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

   evaluate(pos) simply walks the board and adds up material and
   placement. (Real engines keep these sums up to date as each move
   is made, which is faster but spreads the evaluation over more
   than one function.) The skill level's occasional blunder is added
   separately, by judge() in S2.
*/

const MG_VALUE = [0, 100, 320, 330, 500, 900, 0];
const EG_VALUE = [0, 120, 320, 330, 520, 920, 0];
// 24 at the start, 0 when only kings and pawns remain.
const PHASE_INC = [0, 0, 1, 1, 2, 4, 0];

/* Bonus for a white piece of `type` on file f, rank r (0 = rank 1),
   as [middlegame, endgame]. */
function squareBonus(type, f, r) {
  const centre = 3 - ((Math.max(Math.abs(2 * f - 7), Math.abs(2 * r - 7)) - 1) >> 1);
  const home = r === 0 ? -10 : 0; // nudge to develop
  switch (type) {
    case PAWN:
      return [(r - 1) * 3 + ((f === 3 || f === 4) && (r === 3 || r === 4) ? 15 : 0), (r - 1) * 12];
    case KNIGHT: return [centre * 12 - 24 + home, centre * 12 - 24];
    case BISHOP: return [centre * 6 - 12 + home, centre * 6 - 12];
    case ROOK: return [(f === 3 || f === 4 ? 5 : 0) + (r === 6 ? 15 : 0), r === 6 ? 15 : 0];
    case QUEEN:  return [centre * 3 - 6, centre * 5 - 10];
    case KING: return [-Math.min(r, 3) * 25 + (f <= 2 || f >= 5 ? 20 : -10), centre * 15 - 30];
  }
}

/* squareBonus() for every packed piece and square, looked up as
   [piece * 128 + square] and signed by colour: white as is, black
   mirrored and negated. */
function placementTables() {
  const mgTable = new Int16Array(16 * 128), egTable = new Int16Array(16 * 128);
  for (let type = PAWN; type <= KING; type++) {
    for (let sq = 0; sq < 128; sq++) {
      if (sq & 0x88) continue;
      const [mg, eg] = squareBonus(type, sq & 7, sq >> 4);
      mgTable[type * 128 + sq] = mg;
      egTable[type * 128 + sq] = eg;
      mgTable[(type | 8) * 128 + (sq ^ 0x70)] = -mg;
      egTable[(type | 8) * 128 + (sq ^ 0x70)] = -eg;
    }
  }
  return [mgTable, egTable];
}

const [PLACE_MG, PLACE_EG] = placementTables();

/* Static evaluation of `pos`, in centipawns for the side to move. */
function evaluate(pos) {
  const board = pos.board;
  let mg = 0, eg = 0, phase = 0; // mg and eg are white minus black
  for (let sq = 0; sq < 128; sq++) {
    if (sq & 0x88) { sq += 7; continue; }
    const piece = board[sq];
    if (piece === EMPTY) continue;
    const type = piece & 7, sign = piece < 8 ? 1 : -1;
    mg += sign * MG_VALUE[type] + PLACE_MG[piece * 128 + sq];
    eg += sign * EG_VALUE[type] + PLACE_EG[piece * 128 + sq];
    phase += PHASE_INC[type];
  }
  // Taper from middlegame to endgame as material leaves the board.
  const tapered = Math.min(phase, 24);
  const score = ((mg * tapered + eg * (24 - tapered)) / 24) | 0;
  return pos.side === WHITE ? score : -score;
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
   before it (`prev`), which is all that repetition detection needs.

   Position contract (what search needs to know):
   - generateMoves(pos) returns a new array of packed pseudo-legal
     moves; legalMoves(pos) keeps the ones makeMove() accepts.
   - makeMove(pos, move) accepts one of those moves, not arbitrary
     packed input. It returns the position after the move, with the
     opponent to move, or null if our king would be left in check.

   Castling rights are four bits: 1 = white kingside, 2 = white
   queenside, 4 = black kingside, 8 = black queenside. For each
   right we remember the rook's square (Chess960 rooks can start on
   any file), and mask[sq] holds the rights that survive a piece
   moving from or to that square. Both are fixed for a whole game,
   so all of its positions share one `castle` object.

   The fields of a position:
     board        Int8Array(128): EMPTY or a packed piece per square
     kingSq       [white king's square, black king's square]
     pieceCount   Int8Array(16): how many of each packed piece
     side         the colour to move
     castling     the castling rights still held, four bits
     castle       { rookSq, mask } for this game (see above)
     epSq         en passant target square, or -1
     fifty        plies since the last capture or pawn move
     key          Zobrist key, a 46-bit sum (S5)
     plies        moves played since the FEN was loaded
     captured     the piece the last move took from its destination
                  square (EMPTY if none, and for en passant)
     prev         the position before the last move, or null
*/

const castleKingTo = [6, 2, 118, 114];  // g1 c1 g8 c8
const castleRookTo = [5, 3, 117, 115];  // f1 d1 f8 d8

/* The position after `move`, or null if the move leaves our king in
   check. `pos` itself is not changed. Movement rules are the
   generator's responsibility, not validated here. */
function makeMove(pos, move) {
  const from = moveFrom(move), to = moveTo(move);
  const promotion = movePromo(move), flag = moveFlag(move);
  const us = pos.side, them = us ^ 1;

  // The new position starts as a copy of the old; only the copy is
  // changed below.
  const board = pos.board.slice(), pieceCount = pos.pieceCount.slice();
  const kingSq = [pos.kingSq[0], pos.kingSq[1]];
  let key = pos.key + (us === WHITE ? zobSide : -zobSide);
  let epSq = -1, fifty = pos.fifty + 1, captured = EMPTY;

  // Take the piece off square `sq`, or put `piece` on it, keeping
  // the piece counts, king squares and key in step with the board.
  const lift = (sq) => {
    const piece = board[sq];
    board[sq] = EMPTY;
    pieceCount[piece]--;
    key -= zobPiece[piece * 128 + sq];
    return piece;
  };
  const put = (sq, piece) => {
    board[sq] = piece;
    pieceCount[piece]++;
    key += zobPiece[piece * 128 + sq];
    if ((piece & 7) === KING) kingSq[piece >> 3] = sq;
  };

  if (pos.epSq >= 0) key -= zobEp[pos.epSq & 7];

  if (flag === FLAG_CASTLE) {
    const castle = us * 2 + (to > from ? 0 : 1);
    const king = lift(from), rook = lift(to);
    put(castleKingTo[castle], king);
    put(castleRookTo[castle], rook);
  } else {
    if (board[to] !== EMPTY) {
      captured = lift(to);
      fifty = 0;
    }
    const piece = lift(from);
    put(to, promotion ? promotion | (us << 3) : piece);
    if ((piece & 7) === PAWN) {
      fifty = 0;
      if (flag === FLAG_EP) lift(to + (us === WHITE ? -16 : 16));
      else if (to - from === 32 || from - to === 32) {
        epSq = (from + to) >> 1;
        key += zobEp[epSq & 7];
      }
    }
  }

  if (isAttacked(board, kingSq[us], them)) return null;

  const castling = pos.castling & pos.castle.mask[from] & pos.castle.mask[to];
  key += zobCastle[castling] - zobCastle[pos.castling];
  return {
    board, kingSq, pieceCount, side: them, castling, castle: pos.castle,
    epSq, fifty, key, plies: pos.plies + 1, captured, prev: pos,
  };
}

/* Is the side to move in check? */
function inCheck(pos) {
  return isAttacked(pos.board, pos.kingSq[pos.side], pos.side ^ 1);
}

/* Draw by the fifty-move rule, by repetition (once is enough inside
   the search), or by insufficient material (bare kings, or a single
   minor piece). */
function isDraw(pos) {
  if (pos.fifty >= 100) return true;
  // Earlier positions with the same side to move: 2, 4, 6... plies
  // back, but not past the last capture or pawn move.
  for (let back = 2, earlier = pos.prev?.prev; earlier && back <= pos.fifty;
    back += 2, earlier = earlier.prev?.prev)
    if (earlier.key === pos.key) return true;
  const n = pos.pieceCount;
  return n[PAWN] + n[PAWN | 8] + n[ROOK] + n[ROOK | 8] + n[QUEEN] + n[QUEEN | 8] === 0 &&
    n[KNIGHT] + n[KNIGHT | 8] + n[BISHOP] + n[BISHOP | 8] <= 1;
}

/* ---- FEN ----------------------------------------------------------
   The castling field may be KQkq (standard), file letters as in
   Shredder-FEN (HAha), or a mixture (X-FEN). K/Q mean the outermost
   rook on that side of the king, which covers Chess960 too. */
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/* A new position from a FEN string, with no earlier positions. */
function positionFromFen(fen) {
  const parts = fen.trim().split(/\s+/);
  const board = new Int8Array(128), pieceCount = new Int8Array(16);
  const kingSq = [0, 0];
  let key = 0;
  let rank = 7, file = 0;
  for (const ch of parts[0]) {
    if (ch === "/") {
      rank--;
      file = 0;
    } else if (ch >= "1" && ch <= "8") {
      file += ch.charCodeAt(0) - 48;
    } else {
      const sq = rank * 16 + file, piece = PIECE_CHARS.indexOf(ch);
      board[sq] = piece;
      pieceCount[piece]++;
      key += zobPiece[piece * 128 + sq];
      if ((piece & 7) === KING) kingSq[piece >> 3] = sq;
      file++;
    }
  }
  const side = parts[1] === "b" ? BLACK : WHITE;
  if (side === BLACK) key += zobSide;

  const { castling, castle } = castlingFromFen(board, kingSq, parts[2] || "-");
  key += zobCastle[castling];

  const epSq = parts[3] && parts[3] !== "-" ? parseSquare(parts[3]) : -1;
  if (epSq >= 0) key += zobEp[epSq & 7];
  return {
    board, kingSq, pieceCount, side, castling, castle,
    epSq, fifty: parseInt(parts[4]) || 0, key,
    plies: 0, captured: EMPTY, prev: null,
  };
}

/* Interpret the FEN castling field for a loaded board and king
   squares. Returns { castling, castle: { rookSq, mask } }. */
function castlingFromFen(board, kingSq, field) {
  // The first file, walking from `edge` towards `kingFile`, that holds
  // `rook` on the rank starting at `rankBase`; -1 if there is none.
  const outermostRook = (rankBase, rook, edge, kingFile) => {
    const step = edge < kingFile ? 1 : -1;
    for (let file = edge; file !== kingFile; file += step)
      if (board[rankBase + file] === rook) return file;
    return -1;
  };

  let castling = 0;
  const rookSq = new Int32Array(4).fill(-1);
  const mask = new Int8Array(128).fill(15);
  for (const ch of field) {
    if (ch === "-") continue;
    const colour = ch === ch.toUpperCase() ? WHITE : BLACK;
    const rankBase = colour === WHITE ? 0 : 112;
    const rook = ROOK | (colour << 3);
    const kingFile = kingSq[colour] & 7, letter = ch.toUpperCase();
    const rookFile = letter === "K" ? outermostRook(rankBase, rook, 7, kingFile)
      : letter === "Q" ? outermostRook(rankBase, rook, 0, kingFile)
      : letter.charCodeAt(0) - 65;
    if (rookFile < 0 || board[rankBase + rookFile] !== rook) continue;
    const right = colour * 2 + (rookFile > kingFile ? 0 : 1);
    castling |= 1 << right;
    rookSq[right] = rankBase + rookFile;
    mask[rankBase + rookFile] &= ~(1 << right);
    mask[kingSq[colour]] &= ~(3 << (colour * 2));
  }
  return { castling, castle: { rookSq, mask } };
}

/* The FEN string for pos. Castling rights are written as file letters
   only for Chess960 rooks that are not in the corners. */
function toFen(pos, chess960) {
  let fen = "";
  for (let rank = 7; rank >= 0; rank--) {
    let empty = 0;
    for (let file = 0; file < 8; file++) {
      const piece = pos.board[rank * 16 + file];
      if (piece === EMPTY) empty++;
      else { if (empty) fen += empty; empty = 0; fen += PIECE_CHARS[piece]; }
    }
    if (empty) fen += empty;
    if (rank) fen += "/";
  }
  let rights = "";
  for (let right = 0; right < 4; right++) {
    if (!(pos.castling & (1 << right))) continue;
    const file = pos.castle.rookSq[right] & 7;
    const standard = (right & 1) === 0 ? file === 7 : file === 0;
    const ch = chess960 && !standard
      ? "abcdefgh"[file]
      : (right & 1) === 0 ? "k" : "q";
    rights += right < 2 ? ch.toUpperCase() : ch;
  }
  return `${fen} ${pos.side === WHITE ? "w" : "b"} ${rights || "-"} ` +
    `${pos.epSq >= 0 ? squareName(pos.epSq) : "-"} ${pos.fifty} ${1 + (pos.plies >> 1)}`;
}

/* ---- Move notation -------------------------------------------------
   UCI moves are "e2e4", "e7e8q". Castling is "e1g1" in standard chess
   and king-takes-rook ("e1h1") in Chess960. */
function moveToUci(move, chess960) {
  const from = moveFrom(move);
  const to = moveFlag(move) === FLAG_CASTLE && !chess960
    ? castleKingTo[(from >> 6) * 2 + (moveTo(move) > from ? 0 : 1)]
    : moveTo(move);
  const promotion = movePromo(move) ? PIECE_CHARS[movePromo(move) | 8] : "";
  return squareName(from) + squareName(to) + promotion;
}

/* The legal move of pos written as `str`, or 0. Castling is accepted
   in either notation. */
function parseMove(pos, str, chess960) {
  for (const move of legalMoves(pos)) {
    if (moveToUci(move, chess960) === str) return move;
    if (moveFlag(move) === FLAG_CASTLE && moveToUci(move, !chess960) === str) return move;
  }
  return 0;
}

/* The legal moves of pos, as a new array. */
function legalMoves(pos) {
  return generateMoves(pos).filter((move) => makeMove(pos, move) !== null);
}

/* ---- Move generation ---------------------------------------------

   Pseudo-legal generation: moves may leave the king in check, and
   makeMove() rejects those. Pieces move by adding an offset to a
   0x88 square; knights and kings step once, sliders keep stepping
   until they hit something or leave the board.
*/

const KNIGHT_OFFSETS = [-33, -31, -18, -14, 14, 18, 31, 33];
const BISHOP_OFFSETS = [-17, -15, 15, 17];
const ROOK_OFFSETS = [-16, -1, 1, 16];
const KING_OFFSETS = [-17, -16, -15, -1, 1, 15, 16, 17];
const PIECE_OFFSETS = [
  null, null, KNIGHT_OFFSETS, BISHOP_OFFSETS, ROOK_OFFSETS, KING_OFFSETS, KING_OFFSETS,
];

/* The pseudo-legal moves of pos for the side to move, as a new array.
   King safety is checked by makeMove(). */
function generateMoves(pos) {
  const board = pos.board, moves = [];
  const us = pos.side, them = us ^ 1;
  const up = us === WHITE ? 16 : -16;
  const startRank = us === WHITE ? 1 : 6;
  const promoRank = us === WHITE ? 7 : 0;
  const pawnMove = (from, to, flag) => {
    if ((to >> 4) === promoRank) {
      for (let pr = QUEEN; pr >= KNIGHT; pr--) moves.push(encodeMove(from, to, pr, 0));
    } else moves.push(encodeMove(from, to, 0, flag));
  };

  for (let sq = 0; sq < 128; sq++) {
    if (sq & 0x88) { sq += 7; continue; }
    const piece = board[sq];
    if (piece === EMPTY || (piece >> 3) !== us) continue;
    const type = piece & 7;

    if (type === PAWN) {
      const push = sq + up;
      if (board[push] === EMPTY) {
        pawnMove(sq, push, 0);
        if ((sq >> 4) === startRank && board[push + up] === EMPTY) pawnMove(sq, push + up, 0);
      }
      for (let to = push - 1; to <= push + 1; to += 2) { // the two captures
        if (to & 0x88) continue;
        const occupant = board[to];
        if (occupant !== EMPTY && (occupant >> 3) === them) pawnMove(sq, to, 0);
        else if (to === pos.epSq) pawnMove(sq, to, FLAG_EP);
      }
      continue;
    }

    const slides = type >= BISHOP && type <= QUEEN;
    for (const offset of PIECE_OFFSETS[type]) {
      for (let to = sq + offset; !(to & 0x88); to += offset) {
        const occupant = board[to];
        if (occupant === EMPTY) moves.push(encodeMove(sq, to, 0, 0));
        else {
          if ((occupant >> 3) === them) moves.push(encodeMove(sq, to, 0, 0));
          break;
        }
        if (!slides) break;
      }
    }
  }

  // Castling (standard and Chess960 alike): every square the king and
  // rook pass over or land on must be empty, apart from the two of
  // them, and the king may not start in, pass through or end in check.
  for (let right = us * 2; right < us * 2 + 2; right++) {
    if (!(pos.castling & (1 << right))) continue;
    const kFrom = pos.kingSq[us], rFrom = pos.castle.rookSq[right];
    const kTo = castleKingTo[right], rTo = castleRookTo[right];
    const lo = Math.min(kFrom, kTo, rFrom, rTo);
    const hi = Math.max(kFrom, kTo, rFrom, rTo);
    let ok = true;
    for (let sq = lo; sq <= hi && ok; sq++) {
      if (sq !== kFrom && sq !== rFrom && board[sq] !== EMPTY) ok = false;
    }
    const step = kTo > kFrom ? 1 : -1;
    for (let sq = kFrom; ok && sq !== kTo + step; sq += step) {
      if (isAttacked(board, sq, them)) ok = false;
    }
    if (ok) moves.push(encodeMove(kFrom, rFrom, 0, FLAG_CASTLE));
  }
  return moves;
}

/* ---- Attacks -----------------------------------------------------

   Is square `sq` of `board` attacked by colour `by`? We look outward
   from it: is there a pawn/knight/king of that colour at the right
   offset, and along each of the eight rays, is the first piece we
   meet a slider that moves this way? Only the board matters, so
   makeMove() can ask before it has made a whole position.
*/
function isAttacked(board, sq, by) {
  const colourBits = by << 3;
  const pawn = PAWN | colourBits, knight = KNIGHT | colourBits, king = KING | colourBits;
  if (by === WHITE) {
    if (!((sq - 15) & 0x88) && board[sq - 15] === pawn) return true;
    if (!((sq - 17) & 0x88) && board[sq - 17] === pawn) return true;
  } else {
    if (!((sq + 15) & 0x88) && board[sq + 15] === pawn) return true;
    if (!((sq + 17) & 0x88) && board[sq + 17] === pawn) return true;
  }
  for (let i = 0; i < 8; i++) {
    const to = sq + KNIGHT_OFFSETS[i];
    if (!(to & 0x88) && board[to] === knight) return true;
  }
  for (let i = 0; i < 8; i++) {
    const off = KING_OFFSETS[i];
    if (!((sq + off) & 0x88) && board[sq + off] === king) return true;
    const slider = (off === -16 || off === -1 || off === 1 || off === 16)
      ? ROOK
      : BISHOP;
    for (let to = sq + off; !(to & 0x88); to += off) {
      const piece = board[to];
      if (piece === EMPTY) continue;
      if ((piece >> 3) === by && ((piece & 7) === QUEEN || (piece & 7) === slider)) return true;
      break;
    }
  }
  return false;
}

/* ================================================================
   S5  ZOBRIST HASHING
   ================================================================

   Each (piece, square), each castling-rights set, each en passant
   file and the side to move gets a random 46-bit number. The
   position's key is the sum of the numbers for everything in it, so
   it can be updated incrementally: add a piece's number when it
   arrives on a square, subtract it when it leaves. Two equal
   positions always have equal keys. The key is used to detect
   repetitions and to seed the Skill_Seed noise; a transposition
   table would be its third customer.

   (Most engines combine 64-bit numbers with XOR instead. JavaScript's
   ordinary numbers are exact only up to 2^53, but a position adds up
   at most 35 of these 46-bit numbers, so the sum is always exact and
   one plain number holds the whole key.)

   The numbers come from a fixed-seed xorshift generator, so every
   machine gets the same keys (and so the same skill-level choices).
*/
function zobristKeys(seed) {
  let state = seed;
  const rand32 = () => {
    let x = state;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    state = x;
    return x | 0;
  };
  // 46 random bits: 32 low bits, then 14 high bits from the next draw.
  const rand46 = () => {
    const lo = rand32(), hi = rand32();
    return (hi >>> 18) * 2 ** 32 + (lo >>> 0);
  };
  const zobPiece = new Float64Array(16 * 128).map(rand46);
  const zobCastle = new Float64Array(16).map(rand46);
  const zobEp = new Float64Array(8).map(rand46);
  const zobSide = rand46();
  return { zobPiece, zobCastle, zobEp, zobSide };
}

const { zobPiece, zobCastle, zobEp, zobSide } = zobristKeys(ZOBRIST_SEED);

/* A key's low 32 bits and the bits above them, as 32-bit integers,
   for the skill levels' hashing (S2). */
function keyLow(key) { return (key % 2 ** 32) | 0; }
function keyHigh(key) { return Math.floor(key / 2 ** 32) | 0; }

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

function newSession() {
  return { pos: positionFromFen(START_FEN), skill: skillFor(SKILL_MAX, 0), chess960: false };
}

function uciCommand(session, line, io) {
  const tokens = line.trim().split(/\s+/);
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

      // 1 = random mover, SKILL_MAX = full strength
      io.out(`option name Skill_Level type spin default ${SKILL_MAX} min 1 max ${SKILL_MAX}`);

      // Which deterministic opponent; 0 = built-in.
      io.out("option name Skill_Seed type spin default 0 min 0 max 2147483647");

      io.out("uciok");
      return session;
    case "setoption": {
      const nameAt = tokens.indexOf("name"), valueAt = tokens.indexOf("value");
      const name = tokens
        .slice(nameAt + 1, valueAt > 0 ? valueAt : undefined)
        .join(" ")
        .toLowerCase();
      const value = valueAt > 0 ? tokens.slice(valueAt + 1).join(" ") : "";
      if (name === "uci_chess960")
        return { ...session, chess960: value.toLowerCase() === "true" };
      if (name === "skill_level")
        return { ...session, skill: skillFor(parseInt(value) || SKILL_MAX, skill.seed) };
      if (name === "skill_seed")
        return { ...session, skill: skillFor(skill.level, parseInt(value) || 0) };
      return session; // "hash" and "threads" are accepted and ignored
    }
    case "isready":
      io.out("readyok");
      return session;
    case "ucinewgame":
      return { ...session, pos: positionFromFen(START_FEN) };
    case "position":
      return { ...session, pos: positionFromUci(tokens.slice(1).join(" "), chess960) };
    case "go": {
      const result = think(pos, limitsFor(parseGo(tokens), pos.side, skill.level), skill, {
        now: io.now,
        shouldStop: io.shouldStop,
        onInfo: (info) => io.out(infoLine(info, chess960)),
      });
      io.out("bestmove " + (result.bestMove ? moveToUci(result.bestMove, chess960) : "0000"));
      return session;
    }
    case "stop":
      return session; // handled by the I/O layer while searching
    case "quit":
      io.out("quit"); // echoed back so the I/O layer knows the queue is drained
      return session;
    case "bench":
      bench(parseInt(tokens[1]) || BENCH_DEPTH, io);
      return session;
    case "perft":
      perftDivide(pos, parseInt(tokens[1]) || 4, chess960, io);
      return session;
    case "d":
      display(pos, skill, chess960, io.out);
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
function positionFromUci(spec, chess960) {
  const tokens = spec.trim().split(/\s+/);
  const movesAt = tokens.indexOf("moves");
  const fen = tokens[0] === "fen"
    ? tokens.slice(1, movesAt >= 0 ? movesAt : undefined).join(" ")
    : START_FEN;
  const moves = movesAt >= 0 ? tokens.slice(movesAt + 1) : [];
  return moves.reduce((pos, str) => {
    const move = parseMove(pos, str, chess960);
    return move ? makeMove(pos, move) : pos; // an unknown move is skipped
  }, positionFromFen(fen));
}

/* The numbers of a "go" command, e.g. { wtime: 60000, winc: 1000 }. */
function parseGo(tokens) {
  const go = {};
  for (let i = 1; i < tokens.length; i++) {
    const key = tokens[i], value = parseInt(tokens[i + 1]);
    if (key === "infinite") go.infinite = true;
    else if (!isNaN(value)) { go[key] = value; i++; }
  }
  return go;
}

/* The UCI "info" line for one finished depth of think(). */
function infoLine(result, chess960) {
  const { depth, score, nodes, elapsed, pv } = result;
  const nps = elapsed > 0 ? Math.round(nodes * 1000 / elapsed) : 0;
  const scoreText = Math.abs(score) >= MATE_IN_MAX
    ? "mate " + (score > 0 ? (MATE - score + 1) >> 1 : -((MATE + score) >> 1))
    : "cp " + score;
  const line = pv.map((move) => " " + moveToUci(move, chess960)).join("");
  return `info depth ${depth} multipv 1 score ${scoreText} nodes ${nodes} ` +
    `nps ${nps} time ${Math.round(elapsed)} pv${line}`;
}

/* ---- Perft: count leaf nodes to a depth; the standard way to test a
   move generator. */
function perft(pos, depth) {
  if (depth === 0) return 1;
  let count = 0;
  for (const move of generateMoves(pos)) {
    const next = makeMove(pos, move);
    if (next !== null) count += perft(next, depth - 1);
  }
  return count;
}

function perftDivide(pos, depth, chess960, io) {
  const t0 = io.now();
  let total = 0;
  for (const move of legalMoves(pos)) {
    const count = perft(makeMove(pos, move), depth - 1);
    total += count;
    io.out(`${moveToUci(move, chess960)}: ${count}`);
  }
  const ms = io.now() - t0;
  io.out(`perft ${depth} nodes ${total} time ${Math.round(ms)} ` +
    `nps ${Math.round(total * 1000 / Math.max(1, ms))}`);
}

/* ---- Bench: a fixed set of positions to a fixed depth, at full
   strength. OpenBench reads the final "N nodes M nps" line and uses
   the node count as a signature of the search. */
const BENCH_DEPTH = 5;
const BENCH_FENS = [
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

function bench(depth, io) {
  const skill = skillFor(SKILL_MAX, 0);
  let totalNodes = 0, totalMs = 0;
  for (const fen of BENCH_FENS) {
    const pos = positionFromFen(fen);
    const t0 = io.now();
    const { nodes } = think(pos, limitsFor({ depth }, pos.side, SKILL_MAX), skill, {
      now: io.now, shouldStop: () => false, onInfo: () => {},
    });
    totalMs += io.now() - t0;
    totalNodes += nodes;
    io.out(`info string ${nodes} nodes  ${fen}`);
  }
  io.out(`${totalNodes} nodes ${Math.round(totalNodes * 1000 / Math.max(1, totalMs))} nps`);
}

function display(pos, skill, chess960, out) {
  for (let rank = 7; rank >= 0; rank--) {
    let row = `${rank + 1} `;
    for (let file = 0; file < 8; file++) row += " " + PIECE_CHARS[pos.board[rank * 16 + file]];
    out(row);
  }
  out("   a b c d e f g h");
  out(`fen ${toFen(pos, chess960)}`);
  out(`key ${pos.key.toString(16).padStart(13, "0")}`);
  out(`eval ${judge(pos, skill)} (side to move)`);
}

/* ---- Start-up and I/O ---------------------------------------------
   Search is single-threaded, but normal UCI operation uses two
   threads: the main thread reads input and the worker searches.
   In a browser, the page is the main thread (see index.html).
   The direct Bun bench command below runs without a worker.

   Search is synchronous: the worker cannot process another message
   until think() returns. A posted "stop" message would therefore
   arrive too late. Instead, the main thread sets a stop flag in a
   SharedArrayBuffer and the worker's shouldStop() polls it during
   search. Atomics.store/load synchronize that shared flag across
   threads; they do not make the search parallel. Ordinary commands
   and results still travel through worker messages.

   Each host below keeps the current session in its own `let session`
   and replaces it with whatever uciCommand() returns. */
const isBun = typeof Bun !== "undefined";
const inWorker = isBun ? !Bun.isMainThread
  : typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope;

if (isBun && Bun.isMainThread) {
  if (process.argv[2] === "bench") {
    // `bun pedagog.js bench [depth]`, as OpenBench runs it.
    const io = { out: (line) => console.log(line), now, shouldStop: () => false };
    uciCommand(newSession(), "bench " + (process.argv[3] || ""), io);
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
      const cmd = line.trim().split(/\s+/)[0];
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
  let session = newSession(), stopFlag = null;
  const io = {
    out: (line) => self.postMessage(line),
    now,
    shouldStop: () => stopFlag !== null && Atomics.load(stopFlag, 0) !== 0,
  };
  self.onmessage = (e) => {
    if (typeof e.data === "string") session = uciCommand(session, e.data, io);
    else if (e.data && e.data.stopFlag) stopFlag = e.data.stopFlag;
  };
} else {
  // Browser main thread (or any other host): drive it by hand.
  let session = newSession(), output = (line) => console.log(line);
  const io = { out: (line) => output(line), now, shouldStop: () => false };
  globalThis.Pedagog = {
    uci: (line) => { session = uciCommand(session, line, io); },
    setOutput: (fn) => { output = fn; },
  };
}
