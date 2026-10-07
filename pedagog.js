/*
================================================================
                      P E D A G O G
================================================================
   A single-file UCI chess engine in JavaScript, written to be
   read from top to bottom like a short book on chess programming.
   The most interesting chapter, the search, comes first; the
   plumbing that makes it a program comes last.

   Runs in Bun (`bun pedagog.js`) or in a browser Web Worker
   (`new Worker("pedagog.js")`, post UCI strings, receive lines).

   Supports standard chess and Chess960 (UCI_Chess960), MultiPV,
   a deterministic Skill_Seed (as in Gaia), and the Hash/Threads
   options OpenBench expects. The search is always single-threaded.

   It is deliberately a base engine: iterative deepening, alpha-beta
   and captures-first move ordering, with a plain piece-square
   evaluation, and nothing else. It is written as seven cumulative
   CHAPTERS (random mover, greedy, minimax, alpha-beta, iterative
   deepening, move ordering, piece-square tables): each idea is one
   guarded block, the last chapter is the whole engine, and any
   earlier chapter can be switched on to see -- and measure -- the
   engine as it was before an idea arrived. Measured against
   Maia-1900 the last chapter is about 140 Elo stronger than that
   network, which puts its full strength around 1900 on the Lichess
   classical scale. Below full strength, Skill_Level weakens it the
   way Gaia does: it looks less far ahead, misjudges some positions
   on purpose, and overlooks some moves entirely (see COLOPHON.md
   for the measured ladder).
================================================================

   TABLE OF CONTENTS
   -----------------
   S0  Constants           Pieces, squares, move encoding
   S1  Search              The chapters; iterative deepening, alpha-beta, ordering
   S2  Skill Levels        Depth ceiling, blunders, vision
   S3  Evaluation          A naive piece-square evaluation
   S4  Board               0x88 board, make/unmake, draws, FEN, notation
   S5  Move Generation     Pseudo-legal moves, Chess960 castling
   S6  Attacks             Is a square attacked?
   S7  Zobrist Hashing     Position keys for repetition detection
   S8  UCI                 Options (next to "uciok"), bench, perft, I/O
   COLOPHON                See COLOPHON.md
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
const EMPTY = 0, PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6;
const PIECE_CHARS = ".PNBRQK..pnbrqk";

const MAX_PLY = 100;              // longest line the search will follow
const MAX_MOVES = 256;            // a position never has more moves than this
const INF = 32500;
const MATE = 32000;               // mate in N plies scores MATE - N
const MATE_IN_MAX = MATE - MAX_PLY;
const DRAW = 0;

const FLAG_EP = 1, FLAG_CASTLE = 2;

const moveFrom = (m) => m & 127;
const moveTo = (m) => (m >> 7) & 127;
const movePromo = (m) => (m >> 14) & 7;
const moveFlag = (m) => (m >> 17) & 3;
const encodeMove = (from, to, promo, flag) => from | (to << 7) | (promo << 14) | (flag << 17);

const squareName = (s) => "abcdefgh"[s & 7] + ((s >> 4) + 1);
const parseSquare = (str) => (str.charCodeAt(1) - 49) * 16 + (str.charCodeAt(0) - 97);

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

   The engine was not written in one go, and it is not meant to be
   read in one go either. It grew in CHAPTERS, each adding one idea,
   and the ideas are still visible as such: every one of them is a
   single block guarded by `chapter >= CHAPTER.<name>`. At the last
   chapter every guard is true and nothing is skipped -- this is the
   full engine with no dead code. Set `Chapter` lower (a UCI option,
   or `tools/chapter.js` to write out that chapter's engine as a file
   of its own) and you have the engine as it was before that idea,
   which is how the worth of each one was measured.

   think()     iterative deepening: depth 1, 2, 3, ... until time
               runs out. We always have a complete answer from the
               last finished depth.
   search()    negamax alpha-beta. Alpha is the best score the side
               to move is already assured of, beta the best the
               opponent will allow. A move scoring >= beta is "too
               good": the opponent would never let us get here, so
               the remaining moves need not be looked at (a cutoff).

   Scores are always from the point of view of the side to move
   (negamax): +100 means "the side to move is a pawn up". A child's
   score is negated on the way back up, because what is good for
   one side is bad for the other.
*/

/* The chapters, in the order they were written. Each is cumulative:
   chapter 4 is chapters 1 to 4. The ratings are on the Lichess
   classical scale, measured against the chapter before and against
   Maia (COLOPHON.md has the games). */
const CHAPTER = {
  RANDOM: 1,         // a legal move at random (mating in one when it can)                      ~400
  GREEDY: 2,         // one ply ahead, counting material: take what you can                     ~420  wins material, cannot mate
  MINIMAX: 3,        // look FIXED_DEPTH plies ahead, every line to the end                     1186  200-0 against greedy
  ALPHA_BETA: 4,     // stop looking at a move once it is refuted: same answer, far fewer nodes 1177  same moves; speed is the point
  ITERATIVE: 5,      // depth 1, 2, 3, ... until the clock says stop: the first that plays timed games  1618  the speed cashed in
  ORDERING: 6,       // try captures first, so refutations come early                           1790
  PIECE_SQUARES: 7,  // judge where the pieces stand, not only how many there are              1906
};
const LAST_CHAPTER = CHAPTER.PIECE_SQUARES;
const FIXED_DEPTH = 3;      // how far chapters 3 and 4 look, having no clock sense yet
let chapter = LAST_CHAPTER;

let nodes = 0, stopped = false, rootDepth = 0;
let startTime = 0, timeSoft = 0, timeHard = 0, nodeLimit = 0, depthLimit = MAX_PLY;
let stopFlag = null;        // Int32Array over a SharedArrayBuffer, set to 1 by "stop"

const moveStack = new Int32Array((MAX_PLY + 2) * MAX_MOVES);   // one slice of moves per ply
const pvTable = new Int32Array(MAX_PLY * MAX_PLY);             // triangular PV table
const pvLength = new Int32Array(MAX_PLY);
const rootSkipped = [];                                        // root moves not to search (MultiPV, vision)

let multiPV = 1;

/* Iterative deepening with MultiPV. For each depth, the first line
   is a normal search; the k-th line is the same search with the
   k-1 better moves excluded at the root, so each line is the best
   of what remains. The best move of the last *completed* depth is
   what we play; an interrupted iteration is discarded. */
function think() {
  startTime = now(); nodes = 0; stopped = false; rootDepth = 0;
  if (skillLevel === 1 || chapter === CHAPTER.RANDOM) { playRandomly(); return; }

  const rootMoves = legalMoves();
  if (rootMoves.length === 0) { out("bestmove 0000"); return; }
  const unseen = overlookedRootMoves(rootMoves);
  const lines = Math.min(multiPV, rootMoves.length - unseen.length);

  // Before iterative deepening the search goes straight to one depth: one ply for the greedy
  // chapter, FIXED_DEPTH after that. It cannot tell the time, so it may overstep a clock.
  let maxDepth = Math.min(depthLimit, skillDepth()), depth = 1;
  if (chapter < CHAPTER.ITERATIVE) depth = maxDepth = Math.min(maxDepth, chapter < CHAPTER.MINIMAX ? 1 : FIXED_DEPTH);

  let bestMove = rootMoves.find((m) => !unseen.includes(m)), ponderMove = 0;
  for (; depth <= maxDepth; depth++) {
    rootDepth = depth;
    rootSkipped.length = 0; rootSkipped.push(...unseen);
    for (let line = 0; line < lines; line++) {
      const score = search(-INF, INF, depth, 0);
      if (stopped) break;
      rootSkipped.push(pvTable[0]);
      if (line === 0) { bestMove = pvTable[0]; ponderMove = pvLength[0] > 1 ? pvTable[1] : 0; }
      report(depth, line, score);
    }
    if (stopped || now() - startTime > timeSoft) break;
  }
  out("bestmove " + moveToUci(bestMove) + (ponderMove ? " ponder " + moveToUci(ponderMove) : ""));
}

/* Negamax to a fixed depth; alpha-beta is the single `break` below. */
function search(alpha, beta, depth, ply) {
  pvLength[ply] = ply;
  nodes++;
  if ((nodes & 1023) === 0) checkLimits();
  if (stopped) return 0;
  if (ply > 0 && isDraw()) return DRAW;
  if (depth === 0 || ply >= MAX_PLY - 1) return evaluate();   // a leaf: ask the evaluation

  const first = ply * MAX_MOVES, last = generateMoves(first);
  if (chapter >= CHAPTER.ORDERING) orderMoves(first, last);

  let bestScore = -INF, legal = 0, searched = 0;
  for (let i = first; i < last; i++) {
    const m = moveStack[i];
    if (ply === 0 && rootSkipped.includes(m)) continue;
    if (!makeMove(m)) continue;                  // leaves our king in check
    legal++;
    if (ply > 0 && !seesMove(m, ply)) { unmakeMove(); continue; }   // a weakened player overlooks it
    searched++;
    const score = -search(-beta, -alpha, depth - 1, ply + 1);
    unmakeMove();
    if (stopped) return 0;

    if (score > bestScore) {
      bestScore = score;
      if (score > alpha) {
        alpha = score;
        updatePV(ply, m);
        // The cutoff. Without it the loop visits every move and this is plain minimax;
        // with it, a move the opponent would never allow ends the loop early.
        if (chapter >= CHAPTER.ALPHA_BETA && alpha >= beta) break;
      }
    }
  }

  if (legal === 0) return isAttacked(kingSq[side], side ^ 1) ? -MATE + ply : DRAW;   // mate or stalemate
  if (searched === 0) return evaluate();        // saw no move at all: judge the position as it stands
  return bestScore;
}

/* ---- Move ordering --------------------------------------------
   Alpha-beta prunes most when a good move is tried first, and the
   simplest guess at a good move is a capture. So: captures (and
   promotions) first, then the quiet moves, each group in the order
   it was generated. Ranking the captures themselves (most valuable
   victim first, MVV-LVA) is the next refinement; see COLOPHON.md. */
function orderMoves(first, last) {
  let k = first;                                 // everything before k is a capture
  for (let i = first; i < last; i++) {
    const m = moveStack[i];
    if (board[moveTo(m)] !== EMPTY || moveFlag(m) === FLAG_EP || movePromo(m)) {
      const t = moveStack[k]; moveStack[k] = m; moveStack[i] = t; k++;
    }
  }
}

/* The principal variation of a node is its best move followed by
   the principal variation of the child that move leads to. */
function updatePV(ply, m) {
  pvTable[ply * MAX_PLY + ply] = m;
  for (let i = ply + 1; i < pvLength[ply + 1]; i++) pvTable[ply * MAX_PLY + i] = pvTable[(ply + 1) * MAX_PLY + i];
  pvLength[ply] = pvLength[ply + 1];
}

/* ---- Time management -------------------------------------------
   Two budgets: a soft one (do not start another iteration after it)
   and a hard one (abort the search). The first iteration is never
   aborted so there is always a move to play. Below full strength
   the clock is ignored: a level is a depth, never a time budget, so
   it plays the same on any machine. */
function setLimits(go) {
  depthLimit = go.depth || MAX_PLY;
  nodeLimit = go.nodes || 0;
  timeSoft = timeHard = Infinity;
  if (skillLevel < SKILL_MAX) return;
  const overhead = 20;
  if (go.movetime) {
    timeSoft = timeHard = Math.max(1, go.movetime - overhead);
  } else {
    const time = side === WHITE ? go.wtime : go.btime, inc = (side === WHITE ? go.winc : go.binc) || 0;
    if (time !== undefined) {
      const movesToGo = go.movestogo || 30;
      timeSoft = Math.max(1, time / movesToGo + 0.75 * inc - overhead);
      timeHard = Math.max(1, Math.min(4 * timeSoft, 0.8 * time - overhead));
    }
  }
}

function checkLimits() {
  if (rootDepth <= 1) return;
  if (nodeLimit && nodes >= nodeLimit) stopped = true;
  if (now() - startTime >= timeHard) stopped = true;
  if (stopFlag !== null && Atomics.load(stopFlag, 0) !== 0) stopped = true;
}

function report(depth, line, score) {
  const elapsed = now() - startTime;
  const nps = elapsed > 0 ? Math.round(nodes * 1000 / elapsed) : 0;
  const scoreText = Math.abs(score) >= MATE_IN_MAX
    ? "mate " + (score > 0 ? (MATE - score + 1) >> 1 : -((MATE + score) >> 1))
    : "cp " + score;
  let pv = "";
  for (let i = 0; i < pvLength[0]; i++) pv += " " + moveToUci(pvTable[i]);
  out(`info depth ${depth} multipv ${line + 1} score ${scoreText} nodes ${nodes} nps ${nps} time ${Math.round(elapsed)} pv${pv}`);
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
*/

const SKILL_MAX = 10;
const FULL_VISION = 1024;
const VISION_SLOPE = 16, VISION_FLOOR = 160;   // vision lost per ply, and its minimum

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
  rung(MAX_PLY, 0,       0,      0,    FULL_VISION),   // 10  full strength  1894
];

let skillLevel = SKILL_MAX, skill = LADDER[SKILL_MAX - 1];
let skillSeed = 0, seedKey = 0;

function setSkillLevel(level) {
  skillLevel = Math.min(SKILL_MAX, Math.max(1, level | 0));
  skill = LADDER[skillLevel - 1] || LADDER[SKILL_MAX - 1];
}

/* Skill_Seed: which weakened opponent a level is. 0 means the built-in
   one, so an engine nobody configures still plays the same game twice.
   At full strength nothing is drawn from it, so it has no effect. */
function setSkillSeed(seed) {
  skillSeed = seed | 0;
  seedKey = mix32(skillSeed === 0 ? 0x9E3779B9 : skillSeed);
}

/* Depth ceiling for the position on the board: the rung's depth, and
   one more on the rung's share of positions, decided by the hash. */
function skillDepth() {
  if (skill.deeperPermille === 0) return skill.depth;
  const h = mix32(keyLo ^ seedKey ^ 0xA5A55A5A);
  return skill.depth + (h % 1000 < skill.deeperPermille ? 1 : 0);
}

/* The occasional misjudgement, added to the evaluation of the rung's
   share of positions: up to blunderWindow centipawns either way. Mate
   scores never pass through here, since they come from the search,
   not from evaluate(). */
function blunder() {
  if (skill.blunderWindow === 0) return 0;
  const h = mix32(keyLo ^ Math.imul(keyHi, 0x9E3779B9) ^ seedKey);
  if (h % 1000 >= skill.blunderPermille) return 0;
  return (mix32(h) % (2 * skill.blunderWindow + 1)) - skill.blunderWindow;
}

/* Does the player notice this move at all? Called after makeMove(),
   so the key is the child's and "gives check" is known. */
function seesMove(m, ply) {
  if (skill.vision >= FULL_VISION) return true;
  const chance = Math.max(skill.vision - VISION_SLOPE * ply, VISION_FLOOR);
  const h = mix32(keyLo ^ Math.imul(m, 0x9E3779B9) ^ seedKey);
  if (((h >>> 20) & 1023) < chance) return true;
  const easy = histCaptured[hply - 1] !== EMPTY || moveFlag(m) === FLAG_EP || isAttacked(kingSq[side], side ^ 1);
  return easy && ((h >>> 8) & 1023) < chance;
}

/* Root moves the player overlooks. If it would overlook them all, it
   sees them all: a move has to be played. */
function overlookedRootMoves(rootMoves) {
  if (skill.vision >= FULL_VISION) return [];
  const unseen = [];
  for (const m of rootMoves) { makeMove(m); if (!seesMove(m, 0)) unseen.push(m); unmakeMove(); }
  return unseen.length === rootMoves.length ? [] : unseen;
}

/* Level 1: a random legal move, unless a move mates on the spot. */
function playRandomly() {
  const moves = legalMoves();
  if (moves.length === 0) { out("bestmove 0000"); return; }
  let choice = moves[mix32(keyLo ^ seedKey) % moves.length];
  for (const m of moves) {
    makeMove(m);
    const mate = legalMoves().length === 0 && isAttacked(kingSq[side], side ^ 1);
    unmakeMove();
    if (mate) { choice = m; break; }
  }
  out(`info depth 1 multipv 1 score cp 0 nodes ${moves.length} nps 0 time 0 pv ${moveToUci(choice)}`);
  out("bestmove " + moveToUci(choice));
}

/* A 32-bit integer hash finaliser (two multiply-xorshift rounds). */
function mix32(x) {
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  return (x ^ (x >>> 16)) >>> 0;
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

   evaluate() simply walks the board and adds up material and
   placement. (Real engines keep these sums up to date in make/unmake
   instead, which is faster but spreads the evaluation over three
   functions.) Until the PIECE_SQUARES chapter it is material alone:
   the greedy engine of chapter 2 knows a queen from a pawn and
   nothing else. The skill level's occasional blunder is added at
   the end.
*/

const MG_VALUE = [0, 100, 320, 330, 500, 900, 0];
const EG_VALUE = [0, 120, 320, 330, 520, 920, 0];
const PHASE_INC = [0, 0, 1, 1, 2, 4, 0];    // 24 at the start, 0 when only kings and pawns remain
const placeMg = new Int16Array(16 * 128), placeEg = new Int16Array(16 * 128);   // placement bonuses, signed by colour

/* Bonus for a white piece of `type` on file f, rank r (0 = rank 1). */
function squareBonus(type, f, r) {
  const centre = 3 - ((Math.max(Math.abs(2 * f - 7), Math.abs(2 * r - 7)) - 1) >> 1); // 3 in the centre, 0 at the rim
  const home = r === 0 ? -10 : 0;                                                     // nudge to develop
  switch (type) {
    case PAWN:   return [(r - 1) * 3 + ((f === 3 || f === 4) && (r === 3 || r === 4) ? 15 : 0), (r - 1) * 12];
    case KNIGHT: return [centre * 12 - 24 + home, centre * 12 - 24];
    case BISHOP: return [centre * 6 - 12 + home, centre * 6 - 12];
    case ROOK:   return [(f === 3 || f === 4 ? 5 : 0) + (r === 6 ? 15 : 0), r === 6 ? 15 : 0];
    case QUEEN:  return [centre * 3 - 6, centre * 5 - 10];
    case KING:   return [-Math.min(r, 3) * 25 + (f <= 2 || f >= 5 ? 20 : -10), centre * 15 - 30];
  }
}

function initEvaluation() {
  for (let type = PAWN; type <= KING; type++) {
    for (let s = 0; s < 128; s++) {
      if (s & 0x88) continue;
      const [mg, eg] = squareBonus(type, s & 7, s >> 4);
      placeMg[type * 128 + s] = mg; placeEg[type * 128 + s] = eg;                          // white: as is
      placeMg[(type | 8) * 128 + (s ^ 0x70)] = -mg; placeEg[(type | 8) * 128 + (s ^ 0x70)] = -eg;   // black: mirrored and negated
    }
  }
}

function evaluate() {
  let mg = 0, eg = 0, phase = 0;                 // mg and eg are white minus black
  for (let s = 0; s < 128; s++) {
    if (s & 0x88) { s += 7; continue; }
    const p = board[s];
    if (p === EMPTY) continue;
    const type = p & 7, sign = p < 8 ? 1 : -1;
    mg += sign * MG_VALUE[type]; eg += sign * EG_VALUE[type]; phase += PHASE_INC[type];
    if (chapter >= CHAPTER.PIECE_SQUARES) { mg += placeMg[p * 128 + s]; eg += placeEg[p * 128 + s]; }
  }
  let score = mg;
  if (chapter >= CHAPTER.PIECE_SQUARES) {
    // Taper between the two tables: all middlegame at the start, all endgame when only kings
    // and pawns remain, so that the king can hide first and come out later.
    if (phase > 24) phase = 24;
    score = ((mg * phase + eg * (24 - phase)) / 24) | 0;
  }
  return (side === WHITE ? score : -score) + blunder();
}

/* ================================================================
   S4  BOARD
   ================================================================

   The position is a set of module-level variables rather than an
   object: there is only ever one position, and the search makes
   and unmakes moves on it (make/unmake rather than copy/make).
   Everything a move destroys is saved on the history stack so it
   can be put back exactly.

   Castling rights are four bits: 1 = white kingside, 2 = white
   queenside, 4 = black kingside, 8 = black queenside. For each
   right we remember the rook's square (Chess960 rooks can start on
   any file), and castleMask[sq] holds the rights that survive a
   piece moving from or to that square.
*/

const board = new Int8Array(128);
const kingSq = new Int32Array(2);
const pieceCount = new Int32Array(16);
let side = WHITE, castling = 0, epSq = -1, fifty = 0;
let keyLo = 0, keyHi = 0;                  // 64-bit Zobrist key as two 32-bit halves

const castleRookSq = new Int32Array(4).fill(-1);
const castleKingTo = [6, 2, 118, 114];  // g1 c1 g8 c8
const castleRookTo = [5, 3, 117, 115];  // f1 d1 f8 d8
const castleMask = new Int8Array(128).fill(15);
let chess960 = false;

const HISTORY_SIZE = 2048;             // game moves plus search plies
let hply = 0;
const histMove = new Int32Array(HISTORY_SIZE), histCaptured = new Int8Array(HISTORY_SIZE);
const histCastle = new Int8Array(HISTORY_SIZE), histEp = new Int16Array(HISTORY_SIZE);
const histFifty = new Int16Array(HISTORY_SIZE);
const histKeyLo = new Int32Array(HISTORY_SIZE), histKeyHi = new Int32Array(HISTORY_SIZE);

function addPiece(s, p) {
  board[s] = p; pieceCount[p]++;
  keyLo ^= zobPieceLo[p * 128 + s]; keyHi ^= zobPieceHi[p * 128 + s];
  if ((p & 7) === KING) kingSq[p >> 3] = s;
}

function removePiece(s) {
  const p = board[s];
  board[s] = EMPTY; pieceCount[p]--;
  keyLo ^= zobPieceLo[p * 128 + s]; keyHi ^= zobPieceHi[p * 128 + s];
}

/* Play a move. Returns false (and takes the move back) if it leaves
   our own king in check; legality is checked here rather than in
   the generator, which is simpler and about as fast. */
function makeMove(m) {
  const from = moveFrom(m), to = moveTo(m), promo = movePromo(m), flag = moveFlag(m);
  const us = side, them = side ^ 1, piece = board[from];

  histMove[hply] = m; histCaptured[hply] = flag === FLAG_CASTLE ? EMPTY : board[to];
  histCastle[hply] = castling; histEp[hply] = epSq; histFifty[hply] = fifty;
  histKeyLo[hply] = keyLo; histKeyHi[hply] = keyHi;
  hply++;

  if (epSq >= 0) { keyLo ^= zobEpLo[epSq & 7]; keyHi ^= zobEpHi[epSq & 7]; epSq = -1; }
  fifty++;

  if (flag === FLAG_CASTLE) {
    const c = us * 2 + (to > from ? 0 : 1), rook = board[to];
    removePiece(from); removePiece(to);
    addPiece(castleKingTo[c], piece); addPiece(castleRookTo[c], rook);
  } else {
    if (board[to] !== EMPTY) { removePiece(to); fifty = 0; }
    removePiece(from);
    addPiece(to, promo ? promo | (us << 3) : piece);
    if ((piece & 7) === PAWN) {
      fifty = 0;
      if (flag === FLAG_EP) removePiece(to + (us === WHITE ? -16 : 16));
      else if (to - from === 32 || from - to === 32) {
        epSq = (from + to) >> 1;
        keyLo ^= zobEpLo[epSq & 7]; keyHi ^= zobEpHi[epSq & 7];
      }
    }
  }

  keyLo ^= zobCastleLo[castling]; keyHi ^= zobCastleHi[castling];
  castling &= castleMask[from] & castleMask[to];
  keyLo ^= zobCastleLo[castling]; keyHi ^= zobCastleHi[castling];
  side = them; keyLo ^= zobSideLo; keyHi ^= zobSideHi;

  if (isAttacked(kingSq[us], them)) { unmakeMove(); return false; }
  return true;
}

function unmakeMove() {
  hply--; side ^= 1;
  const m = histMove[hply], from = moveFrom(m), to = moveTo(m), promo = movePromo(m), flag = moveFlag(m);
  const us = side;
  if (flag === FLAG_CASTLE) {
    const c = us * 2 + (to > from ? 0 : 1);
    const king = board[castleKingTo[c]], rook = board[castleRookTo[c]];
    removePiece(castleKingTo[c]); removePiece(castleRookTo[c]);
    addPiece(from, king); addPiece(to, rook);
  } else {
    const piece = board[to];
    removePiece(to);
    addPiece(from, promo ? PAWN | (us << 3) : piece);
    if (flag === FLAG_EP) addPiece(to + (us === WHITE ? -16 : 16), PAWN | ((us ^ 1) << 3));
    else if (histCaptured[hply] !== EMPTY) addPiece(to, histCaptured[hply]);
  }
  castling = histCastle[hply]; epSq = histEp[hply]; fifty = histFifty[hply];
  keyLo = histKeyLo[hply]; keyHi = histKeyHi[hply];
}

/* Draw by the fifty-move rule, by repetition (once is enough inside
   the search), or by insufficient material (bare kings, or a single
   minor piece). */
function isDraw() {
  if (fifty >= 100) return true;
  for (let i = hply - 2; i >= 0 && i >= hply - fifty; i -= 2)
    if (histKeyLo[i] === keyLo && histKeyHi[i] === keyHi) return true;
  if (pieceCount[PAWN] + pieceCount[PAWN | 8] + pieceCount[ROOK] + pieceCount[ROOK | 8] +
      pieceCount[QUEEN] + pieceCount[QUEEN | 8] === 0 &&
      pieceCount[KNIGHT] + pieceCount[KNIGHT | 8] + pieceCount[BISHOP] + pieceCount[BISHOP | 8] <= 1) return true;
  return false;
}

/* ---- FEN ----------------------------------------------------------
   The castling field may be KQkq (standard), file letters as in
   Shredder-FEN (HAha), or a mixture (X-FEN). K/Q mean the outermost
   rook on that side of the king, which covers Chess960 too. */
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function setPosition(fen) {
  board.fill(EMPTY); pieceCount.fill(0); kingSq.fill(0);
  keyLo = keyHi = 0;
  castling = 0; epSq = -1; fifty = 0; hply = 0;
  castleRookSq.fill(-1); castleMask.fill(15);

  const parts = fen.trim().split(/\s+/);
  let rank = 7, file = 0;
  for (const ch of parts[0]) {
    if (ch === "/") { rank--; file = 0; }
    else if (ch >= "1" && ch <= "8") file += ch.charCodeAt(0) - 48;
    else { addPiece(rank * 16 + file, PIECE_CHARS.indexOf(ch)); file++; }
  }
  side = parts[1] === "b" ? BLACK : WHITE;
  if (side === BLACK) { keyLo ^= zobSideLo; keyHi ^= zobSideHi; }

  for (const ch of parts[2] || "-") {
    if (ch === "-") continue;
    const colour = ch === ch.toUpperCase() ? WHITE : BLACK, rankBase = colour === WHITE ? 0 : 112;
    const rook = ROOK | (colour << 3), kingFile = kingSq[colour] & 7, letter = ch.toUpperCase();
    let rookFile = -1;
    if (letter === "K") { for (let f = 7; f > kingFile; f--) if (board[rankBase + f] === rook) { rookFile = f; break; } }
    else if (letter === "Q") { for (let f = 0; f < kingFile; f++) if (board[rankBase + f] === rook) { rookFile = f; break; } }
    else rookFile = letter.charCodeAt(0) - 65;
    if (rookFile < 0 || board[rankBase + rookFile] !== rook) continue;
    const c = colour * 2 + (rookFile > kingFile ? 0 : 1);
    castling |= 1 << c;
    castleRookSq[c] = rankBase + rookFile;
    castleMask[rankBase + rookFile] &= ~(1 << c);
    castleMask[kingSq[colour]] &= ~(3 << (colour * 2));
  }
  keyLo ^= zobCastleLo[castling]; keyHi ^= zobCastleHi[castling];

  if (parts[3] && parts[3] !== "-") {
    epSq = parseSquare(parts[3]);
    keyLo ^= zobEpLo[epSq & 7]; keyHi ^= zobEpHi[epSq & 7];
  }
  fifty = parseInt(parts[4]) || 0;
}

function toFen() {
  let fen = "";
  for (let r = 7; r >= 0; r--) {
    let empty = 0;
    for (let f = 0; f < 8; f++) {
      const p = board[r * 16 + f];
      if (p === EMPTY) empty++;
      else { if (empty) fen += empty; empty = 0; fen += PIECE_CHARS[p]; }
    }
    if (empty) fen += empty;
    if (r) fen += "/";
  }
  let rights = "";
  for (let c = 0; c < 4; c++) {
    if (!(castling & (1 << c))) continue;
    const file = castleRookSq[c] & 7;
    const standard = (c & 1) === 0 ? file === 7 : file === 0;
    const ch = chess960 && !standard ? "abcdefgh"[file] : (c & 1) === 0 ? "k" : "q";
    rights += c < 2 ? ch.toUpperCase() : ch;
  }
  return `${fen} ${side === WHITE ? "w" : "b"} ${rights || "-"} ${epSq >= 0 ? squareName(epSq) : "-"} ${fifty} ${1 + (hply >> 1)}`;
}

/* ---- Move notation -------------------------------------------------
   UCI moves are "e2e4", "e7e8q". Castling is "e1g1" in standard chess
   and king-takes-rook ("e1h1") in Chess960. */
function moveToUci(m) {
  const from = moveFrom(m);
  let to = moveTo(m);
  if (moveFlag(m) === FLAG_CASTLE && !chess960) to = castleKingTo[(from >> 6) * 2 + (to > from ? 0 : 1)];
  return squareName(from) + squareName(to) + (movePromo(m) ? PIECE_CHARS[movePromo(m) | 8] : "");
}

function parseMove(str) {
  for (const m of legalMoves()) {
    if (moveToUci(m) === str) return m;
    if (moveFlag(m) === FLAG_CASTLE) {       // accept the other castling notation too
      const from = moveFrom(m), to = moveTo(m);
      const other = squareName(from) + squareName(chess960 ? castleKingTo[(from >> 6) * 2 + (to > from ? 0 : 1)] : to);
      if (other === str) return m;
    }
  }
  return 0;
}

function legalMoves() {
  const moves = [], last = generateMoves(MAX_PLY * MAX_MOVES);
  for (let i = MAX_PLY * MAX_MOVES; i < last; i++) {
    if (makeMove(moveStack[i])) { unmakeMove(); moves.push(moveStack[i]); }
  }
  return moves;
}

/* ================================================================
   S5  MOVE GENERATION
   ================================================================

   Pseudo-legal generation: moves may leave the king in check, and
   makeMove() rejects those. Pieces move by adding an offset to a
   0x88 square; knights and kings step once, sliders keep stepping
   until they hit something or leave the board. Moves are written
   into moveStack from index `first`; the index after the last one
   is returned.
*/

const KNIGHT_OFFSETS = [-33, -31, -18, -14, 14, 18, 31, 33];
const BISHOP_OFFSETS = [-17, -15, 15, 17];
const ROOK_OFFSETS = [-16, -1, 1, 16];
const KING_OFFSETS = [-17, -16, -15, -1, 1, 15, 16, 17];
const PIECE_OFFSETS = [null, null, KNIGHT_OFFSETS, BISHOP_OFFSETS, ROOK_OFFSETS, KING_OFFSETS, KING_OFFSETS];

function generateMoves(first) {
  let n = first;
  const us = side, them = side ^ 1;
  const up = us === WHITE ? 16 : -16, startRank = us === WHITE ? 1 : 6, promoRank = us === WHITE ? 7 : 0;

  for (let s = 0; s < 128; s++) {
    if (s & 0x88) { s += 7; continue; }
    const p = board[s];
    if (p === EMPTY || (p >> 3) !== us) continue;
    const type = p & 7;

    if (type === PAWN) {
      let to = s + up;
      if (board[to] === EMPTY) {
        if ((to >> 4) === promoRank) for (let pr = QUEEN; pr >= KNIGHT; pr--) moveStack[n++] = encodeMove(s, to, pr, 0);
        else {
          moveStack[n++] = encodeMove(s, to, 0, 0);
          if ((s >> 4) === startRank && board[to + up] === EMPTY) moveStack[n++] = encodeMove(s, to + up, 0, 0);
        }
      }
      for (let d = -1; d <= 1; d += 2) {
        to = s + up + d;
        if (to & 0x88) continue;
        const c = board[to];
        if (c !== EMPTY && (c >> 3) === them) {
          if ((to >> 4) === promoRank) for (let pr = QUEEN; pr >= KNIGHT; pr--) moveStack[n++] = encodeMove(s, to, pr, 0);
          else moveStack[n++] = encodeMove(s, to, 0, 0);
        } else if (to === epSq) moveStack[n++] = encodeMove(s, to, 0, FLAG_EP);
      }
      continue;
    }

    const offsets = PIECE_OFFSETS[type], slides = type >= BISHOP && type <= QUEEN;
    for (let i = 0; i < offsets.length; i++) {
      for (let to = s + offsets[i]; !(to & 0x88); to += offsets[i]) {
        const c = board[to];
        if (c === EMPTY) moveStack[n++] = encodeMove(s, to, 0, 0);
        else { if ((c >> 3) === them) moveStack[n++] = encodeMove(s, to, 0, 0); break; }
        if (!slides) break;
      }
    }
  }

  // Castling (standard and Chess960 alike): every square the king and
  // rook pass over or land on must be empty, apart from the two of
  // them, and the king may not start in, pass through or end in check.
  for (let c = us * 2; c < us * 2 + 2; c++) {
    if (!(castling & (1 << c))) continue;
    const kFrom = kingSq[us], rFrom = castleRookSq[c], kTo = castleKingTo[c], rTo = castleRookTo[c];
    const lo = Math.min(kFrom, kTo, rFrom, rTo), hi = Math.max(kFrom, kTo, rFrom, rTo);
    let ok = true;
    for (let s = lo; s <= hi && ok; s++) if (s !== kFrom && s !== rFrom && board[s] !== EMPTY) ok = false;
    const step = kTo > kFrom ? 1 : -1;
    for (let s = kFrom; ok && s !== kTo + step; s += step) if (isAttacked(s, them)) ok = false;
    if (ok) moveStack[n++] = encodeMove(kFrom, rFrom, 0, FLAG_CASTLE);
  }
  return n;
}

/* ================================================================
   S6  ATTACKS
   ================================================================

   Is square s attacked by colour `by`? We look outward from s: is
   there a pawn/knight/king of that colour at the right offset, and
   along each of the eight rays, is the first piece we meet a slider
   that moves this way?
*/
function isAttacked(s, by) {
  const c = by << 3;
  const pawn = PAWN | c, knight = KNIGHT | c, king = KING | c;
  if (by === WHITE) {
    if (!((s - 15) & 0x88) && board[s - 15] === pawn) return true;
    if (!((s - 17) & 0x88) && board[s - 17] === pawn) return true;
  } else {
    if (!((s + 15) & 0x88) && board[s + 15] === pawn) return true;
    if (!((s + 17) & 0x88) && board[s + 17] === pawn) return true;
  }
  for (let i = 0; i < 8; i++) {
    const t = s + KNIGHT_OFFSETS[i];
    if (!(t & 0x88) && board[t] === knight) return true;
  }
  for (let i = 0; i < 8; i++) {
    const off = KING_OFFSETS[i];
    if (!((s + off) & 0x88) && board[s + off] === king) return true;
    const slider = (off === -16 || off === -1 || off === 1 || off === 16) ? ROOK : BISHOP;
    for (let t = s + off; !(t & 0x88); t += off) {
      const p = board[t];
      if (p === EMPTY) continue;
      if ((p >> 3) === by && ((p & 7) === QUEEN || (p & 7) === slider)) return true;
      break;
    }
  }
  return false;
}

/* ================================================================
   S7  ZOBRIST HASHING
   ================================================================

   Each (piece, square), each castling-rights set, each en passant
   file and the side to move gets a random 64-bit number (two 32-bit
   halves here, because JavaScript's fast integers are 32-bit). The
   position's key is the XOR of the numbers for everything in it, so
   it can be updated incrementally as pieces come and go, and two
   equal positions always have equal keys. The key is used to detect
   repetitions and to seed the Skill_Seed noise; a transposition
   table would be its third customer.
*/
let rngState = 0x2545F491;
function rand32() {
  let x = rngState;
  x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
  rngState = x;
  return x | 0;
}

const zobPieceLo = new Int32Array(16 * 128), zobPieceHi = new Int32Array(16 * 128);
const zobCastleLo = new Int32Array(16), zobCastleHi = new Int32Array(16);
const zobEpLo = new Int32Array(8), zobEpHi = new Int32Array(8);
let zobSideLo = 0, zobSideHi = 0;

function initZobrist() {
  for (let i = 0; i < 16 * 128; i++) { zobPieceLo[i] = rand32(); zobPieceHi[i] = rand32(); }
  for (let i = 0; i < 16; i++) { zobCastleLo[i] = rand32(); zobCastleHi[i] = rand32(); }
  for (let i = 0; i < 8; i++) { zobEpLo[i] = rand32(); zobEpHi[i] = rand32(); }
  zobSideLo = rand32(); zobSideHi = rand32();
}

/* ================================================================
   S8  UCI
   ================================================================

   The Universal Chess Interface: a GUI (or a match manager such as
   cutechess or OpenBench) writes commands on one line each, and we
   answer in kind. uciCommand() handles one line. The surrounding
   I/O code at the end of the file wires it to stdin/stdout in Bun
   or to postMessage in a browser Web Worker.
*/

let out = (line) => console.log(line);

function uciCommand(line) {
  const tokens = line.trim().split(/\s+/);
  switch (tokens[0]) {
    case "uci":
      out(`id name ${NAME} ${VERSION}`);
      out("id author Copilot (Claude Fable 5.1)");
      // ---- UCI options ------------------------------------------------
      out("option name Hash type spin default 16 min 1 max 1024");       // accepted, no effect: there is no transposition table yet
      out("option name Threads type spin default 1 min 1 max 1");        // accepted for OpenBench; always single-threaded
      out("option name MultiPV type spin default 1 min 1 max 256");      // number of best lines to report
      out("option name UCI_Chess960 type check default false");          // castling notation: king-takes-rook
      out(`option name Skill_Level type spin default ${SKILL_MAX} min 1 max ${SKILL_MAX}`); // 1 = random mover, SKILL_MAX = full strength
      out("option name Skill_Seed type spin default 0 min 0 max 2147483647"); // which deterministic opponent; 0 = built-in
      out(`option name Chapter type spin default ${LAST_CHAPTER} min 1 max ${LAST_CHAPTER}`); // the engine as of that chapter (see S1)
      out("uciok");
      break;
    case "setoption": {
      const nameAt = tokens.indexOf("name"), valueAt = tokens.indexOf("value");
      const name = tokens.slice(nameAt + 1, valueAt > 0 ? valueAt : undefined).join(" ").toLowerCase();
      const value = valueAt > 0 ? tokens.slice(valueAt + 1).join(" ") : "";
      if (name === "multipv") multiPV = Math.min(256, Math.max(1, parseInt(value) || 1));
      else if (name === "uci_chess960") chess960 = value.toLowerCase() === "true";
      else if (name === "skill_level") setSkillLevel(parseInt(value) || SKILL_MAX);
      else if (name === "skill_seed") setSkillSeed(parseInt(value) || 0);
      else if (name === "chapter") chapter = Math.min(LAST_CHAPTER, Math.max(1, parseInt(value) || LAST_CHAPTER));
      // "hash" and "threads" are accepted and ignored
      break;
    }
    case "isready": out("readyok"); break;
    case "ucinewgame": setPosition(START_FEN); break;
    case "position": {
      const movesAt = tokens.indexOf("moves");
      if (tokens[1] === "fen") setPosition(tokens.slice(2, movesAt > 0 ? movesAt : undefined).join(" "));
      else setPosition(START_FEN);
      if (movesAt > 0) for (const str of tokens.slice(movesAt + 1)) { const m = parseMove(str); if (m) makeMove(m); }
      break;
    }
    case "go": {
      const go = {};
      for (let i = 1; i < tokens.length; i++) {
        const key = tokens[i], value = parseInt(tokens[i + 1]);
        if (key === "infinite") go.infinite = true;
        else if (!isNaN(value)) { go[key] = value; i++; }
      }
      setLimits(go);
      think();
      break;
    }
    case "stop": break;                       // handled by the I/O layer while searching
    case "quit": out("quit"); break;          // echoed back so the I/O layer knows the queue is drained
    case "bench": bench(parseInt(tokens[1]) || BENCH_DEPTH); break;
    case "perft": perftDivide(parseInt(tokens[1]) || 4); break;
    case "d": display(); break;
    case "eval": out(`eval ${evaluate()} (side to move)`); break;
  }
}

/* ---- Perft: count leaf nodes to a depth; the standard way to test a move generator. */
function perft(depth, ply) {
  if (depth === 0) return 1;
  let count = 0;
  const first = ply * MAX_MOVES, last = generateMoves(first);
  for (let i = first; i < last; i++) {
    if (!makeMove(moveStack[i])) continue;
    count += depth === 1 ? 1 : perft(depth - 1, ply + 1);
    unmakeMove();
  }
  return count;
}

function perftDivide(depth) {
  const t0 = now();
  let total = 0;
  for (const m of legalMoves()) {
    makeMove(m);
    const count = perft(depth - 1, 1);
    unmakeMove();
    total += count;
    out(`${moveToUci(m)}: ${count}`);
  }
  const ms = now() - t0;
  out(`perft ${depth} nodes ${total} time ${Math.round(ms)} nps ${Math.round(total * 1000 / Math.max(1, ms))}`);
}

/* ---- Bench: a fixed set of positions to a fixed depth. OpenBench
   reads the final "N nodes M nps" line and uses the node count as a
   signature of the search. */
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

function bench(depth) {
  const savedOut = out, savedLevel = skillLevel, savedChapter = chapter;
  setSkillLevel(SKILL_MAX); chapter = LAST_CHAPTER;
  let totalNodes = 0, totalMs = 0;
  for (const fen of BENCH_FENS) {
    setPosition(fen);
    setLimits({ depth });
    out = () => {};
    const t0 = now();
    think();
    totalMs += now() - t0;
    out = savedOut;
    totalNodes += nodes;
    out(`info string ${nodes} nodes  ${fen}`);
  }
  setSkillLevel(savedLevel); chapter = savedChapter;
  out(`${totalNodes} nodes ${Math.round(totalNodes * 1000 / Math.max(1, totalMs))} nps`);
}

function display() {
  for (let r = 7; r >= 0; r--) {
    let row = `${r + 1} `;
    for (let f = 0; f < 8; f++) row += " " + PIECE_CHARS[board[r * 16 + f]];
    out(row);
  }
  out("   a b c d e f g h");
  out(`fen ${toFen()}`);
  out(`key ${((keyHi >>> 0).toString(16)).padStart(8, "0")}${((keyLo >>> 0).toString(16)).padStart(8, "0")}`);
  out(`eval ${evaluate()} (side to move)`);
}

/* ---- Start-up and I/O ---------------------------------------------
   The search is synchronous, so while it runs nobody is reading
   input. In Bun the main thread therefore only reads stdin: it
   forwards each line to a Worker running the engine, and raises a
   shared "stop" flag when asked, which the search polls. In a
   browser, the page plays the role of that main thread (see
   index.html). The engine itself is always a single thread. */
initZobrist();
initEvaluation();
setSkillSeed(0);
setPosition(START_FEN);

const isBun = typeof Bun !== "undefined";
const inWorker = isBun ? !Bun.isMainThread
  : typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope;

if (isBun && Bun.isMainThread) {
  if (process.argv[2] === "bench") {              // `bun pedagog.js bench [depth]`, as OpenBench runs it
    uciCommand("bench " + (process.argv[3] || ""));
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
    worker.postMessage("quit");   // stdin closed: let the worker finish its queue, then exit
  })();
} else if (inWorker) {
  out = (line) => self.postMessage(line);
  self.onmessage = (e) => {
    if (typeof e.data === "string") uciCommand(e.data);
    else if (e.data && e.data.stopFlag) stopFlag = e.data.stopFlag;
  };
} else {
  // Browser main thread (or any other host): drive it by hand.
  globalThis.Pedagog = { uci: uciCommand, setOutput: (fn) => { out = fn; } };
}

/*
================================================================
   COLOPHON
================================================================
   Who wrote this, how long it took, how the strength was measured
   against Maia-1900 and the brief it was written to: see
   COLOPHON.md next to this file.
================================================================
*/
