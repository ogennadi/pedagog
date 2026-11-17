/*
================================================================
            P E D A G O G   ( S E A R C H L E S S )
================================================================
   A variant of engine.ts that does not search. It scores every
   legal move with 50 weighted yes/no questions, learned from
   Stockfish's moves, and plays the best one (S1). The rules (S2),
   the Zobrist keys (S3) and the UCI plumbing (S4) are engine.ts's;
   engine.ts's search, skill levels and evaluation are gone.

   Runs in Bun, which runs TypeScript directly
   (`bun src/variants/engine-searchless/engine-searchless.ts`), or
   in a browser Web Worker, which gets this file with its types
   removed (src/tools/engine-js.js; `bun run web --engine` this
   file).
================================================================

   TABLE OF CONTENTS
   -----------------
   S0  Constants           Pieces, squares, board layout, moves
   S1  Move Choice         50 questions and their learned weights
   S2  Chess Rules         Position, copy/make, draws, moves, attacks
   S3  Zobrist Hashing     Position keys for repetition detection
   S4  UCI                 Sessions, options, perft, I/O
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


const WHITE = 0, BLACK = 1;
const EMPTY = 0, PAWN = 1, KNIGHT = 2, BISHOP = 3;
const ROOK = 4, QUEEN = 5, KING = 6;
const PIECE_CHARS = ".PNBRQK..pnbrqk";
const FILE_NAMES = "abcdefgh";
const RANK_NAMES = "12345678";

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
   S1  MOVE CHOICE
   ================================================================

   There is no search. Every legal move is asked the 50 yes/no
   questions of FEATURES below, such as "does it give check?", "does
   it push a pawn to the 5th rank?" and "after it, what can the
   opponent's best capture win back?". Each question has a weight,
   and the move whose "yes" weights add up to the most is played.
   Ties go to the move generated first.

   The weights were fitted to Stockfish's moves in 152,312 positions
   from 1900-rated Lichess games: a softmax over each position's
   legal moves, whose probabilities come from these sums. Then
   src/variants/engine-searchless/prune.ts kept the 50 questions
   that matter most. In 1,000 games this plays like the full set of
   91: about 210 Elo below Maia-1900, about 1550 on the ladder.

   chooseMove(pos, ply, lastTo)
               the move to play, or NO_MOVE when there is none
   moveScores(pos, ply, lastTo)
               every legal move with its score and its "yes" answers

   The questions only look at one move and the opponent's immediate
   replies: their best single capture (by SEE) and whether they can
   mate at once. Nothing is looked at any further: there is no
   tree.

   Material is counted in pawns (VALUE). A piece is en prise when a
   cheaper enemy piece attacks it, or when it is attacked and not
   defended. SEE (static exchange evaluation) is the material that
   the captures on one square win, each side capturing with its
   cheapest piece and stopping when that no longer pays. Neither
   sees pins or x-rays.
*/

/** Material in pawns, by piece type. The king's 100 only matters
    in SEE. */
const VALUE: readonly number[] = [0, 1, 3, 3, 5, 9, 100];
/** The endgame starts when the pieces' phase weights (knight and
    bishop 1, rook 2, queen 4: 24 at the start) add up to 8 or less. */
const PHASE_WEIGHT: readonly number[] = [0, 0, 1, 1, 2, 4, 0];
const ENDGAME_PHASE = 8;

/* The rank of `sq` counted from `colour`'s side, 0..7. */
function relativeRank(sq: Square, colour: Colour): Rank {
  return colour === WHITE ? rankOf(sq) : 7 - rankOf(sq);
}

/* How far `sq` is from the centre: 0 (d4, e4, d5, e5) to 3 (the
   edge). */
function offCentre(sq: Square): number {
  return Math.max(Math.abs(fileOf(sq) - 3.5), Math.abs(rankOf(sq) - 3.5)) - 0.5;
}

/* The first occupied square beyond `sq` in direction `step`, or
   NO_SQUARE. */
function firstPiece(board: Board, sq: Square, step: number): Square {
  for (let s = sq + step; onBoard(s); s += step)
    if (board[s] !== EMPTY) return s;
  return NO_SQUARE;
}

/* The squares that a `pieceType` of `colour` on `sq` attacks. */
function attacks(
  board: Board, sq: Square, pieceType: PieceType, colour: Colour,
): Square[] {
  const steps = (offsets: readonly number[]) =>
    offsets.map((d) => sq + d).filter(onBoard);
  const rays = (offsets: readonly number[]) => offsets.flatMap((d) => {
    const seen: Square[] = [];
    for (let s = sq + d; onBoard(s); s += d) {
      seen.push(s);
      if (board[s] !== EMPTY) break;
    }
    return seen;
  });
  switch (pieceType) {
    case PAWN: return steps(colour === WHITE ? [15, 17] : [-15, -17]);
    case KNIGHT: return steps(KNIGHT_OFFSETS);
    case BISHOP: return rays(BISHOP_OFFSETS);
    case ROOK: return rays(ROOK_OFFSETS);
    case QUEEN: return rays([...BISHOP_OFFSETS, ...ROOK_OFFSETS]);
    default: return steps(KING_OFFSETS);
  }
}

/* The square of the cheapest piece of colour `by` that attacks
   `sq`, or NO_SQUARE: pawns first, then knights, then the cheapest
   slider, and the king last. */
function cheapestAttacker(board: Board, sq: Square, by: Colour): Square {
  const pawn = makePiece(PAWN, by), knight = makePiece(KNIGHT, by);
  for (const s of by === WHITE ? [sq - 15, sq - 17] : [sq + 15, sq + 17])
    if (onBoard(s) && board[s] === pawn) return s;
  for (const d of KNIGHT_OFFSETS)
    if (onBoard(sq + d) && board[sq + d] === knight) return sq + d;
  let best = NO_SQUARE;
  for (const [offsets, types] of [
    [BISHOP_OFFSETS, [BISHOP, QUEEN]], [ROOK_OFFSETS, [ROOK, QUEEN]],
  ] as const) {
    for (const d of offsets) {
      const s = firstPiece(board, sq, d);
      if (s !== NO_SQUARE && colourOf(board[s]) === by &&
        (types as readonly number[]).includes(typeOf(board[s])) &&
        (best === NO_SQUARE ||
          VALUE[typeOf(board[s])] < VALUE[typeOf(board[best])])) best = s;
    }
  }
  if (best !== NO_SQUARE) return best;
  const king = makePiece(KING, by);
  for (const d of KING_OFFSETS)
    if (onBoard(sq + d) && board[sq + d] === king) return sq + d;
  return NO_SQUARE;
}

/* Is the piece on `sq` en prise to colour `by`? */
function enPrise(board: Board, sq: Square, by: Colour): boolean {
  const attacker = cheapestAttacker(board, sq, by);
  return attacker !== NO_SQUARE &&
    (VALUE[typeOf(board[attacker])] < VALUE[typeOf(board[sq])] ||
      cheapestAttacker(board, sq, opponent(by)) === NO_SQUARE);
}

/* How many pieces of `colour`, not counting the king, are en prise. */
function enPriseCount(board: Board, colour: Colour): number {
  return SQUARES.filter((sq) => board[sq] !== EMPTY &&
    colourOf(board[sq]) === colour && typeOf(board[sq]) !== KING &&
    enPrise(board, sq, opponent(colour))).length;
}

/* SEE of moving the piece on `from`, which becomes a `pieceType`
   (it may promote), to `to`: the material won, in pawns, once the
   captures on `to` are over. `epVictim` is the square of a pawn
   taken en passant, or NO_SQUARE. */
function see(
  board: Board, from: Square, to: Square, pieceType: PieceType,
  epVictim: Square,
): number {
  const b = board.slice();
  const gains = [epVictim !== NO_SQUARE ? 1 : VALUE[typeOf(b[to])]];
  if (epVictim !== NO_SQUARE) b[epVictim] = EMPTY;
  let side = opponent(colourOf(b[from]));
  let onSquare = VALUE[pieceType];
  b[to] = makePiece(pieceType, opponent(side));
  b[from] = EMPTY;
  for (;;) {
    const s = cheapestAttacker(b, to, side);
    if (s === NO_SQUARE || onSquare === VALUE[KING]) break;
    gains.push(onSquare - gains[gains.length - 1]);
    onSquare = VALUE[typeOf(b[s])];
    b[to] = b[s];
    b[s] = EMPTY;
    side = opponent(side);
  }
  for (let d = gains.length - 1; d > 0; d--)
    gains[d - 1] = -Math.max(-gains[d - 1], gains[d]);
  return gains[0];
}

/* How many enemy pieces, not counting the king, a `pieceType` of
   `us` on `to` attacks that are worth more than it or undefended. */
function threatCount(
  board: Board, to: Square, pieceType: PieceType, us: Colour,
): number {
  const them = opponent(us);
  return attacks(board, to, pieceType, us).filter((s) =>
    board[s] !== EMPTY && colourOf(board[s]) === them &&
    typeOf(board[s]) !== KING &&
    (VALUE[typeOf(board[s])] > VALUE[pieceType] ||
      cheapestAttacker(board, s, them) === NO_SQUARE)).length;
}

/* Is there a pawn of `colour` on `file`? */
function pawnOnFile(board: Board, file: File, colour: Colour): boolean {
  const pawn = makePiece(PAWN, colour);
  for (let rank = 0; rank < 8; rank++)
    if (board[makeSquare(file, rank)] === pawn) return true;
  return false;
}

/* Is there an enemy pawn ahead of `sq` (from `us`'s side) on a file
   next to it, or on its own file with `sameFile`? */
function enemyPawnAhead(
  board: Board, sq: Square, us: Colour, sameFile: boolean,
): boolean {
  const pawn = makePiece(PAWN, opponent(us));
  return SQUARES.some((s) => {
    const df = Math.abs(fileOf(s) - fileOf(sq));
    return board[s] === pawn && (df === 1 || (sameFile && df === 0)) &&
      relativeRank(s, us) > relativeRank(sq, us);
  });
}

/* Is a king of `colour` on `sq` castled: on its back rank, on a
   wing? */
function isCastled(sq: Square, colour: Colour): boolean {
  return relativeRank(sq, colour) === 0 &&
    (fileOf(sq) <= 2 || fileOf(sq) >= 5);
}

/* Our material minus theirs, in pawns, for `us`. */
function material(board: Board, us: Colour): number {
  let sum = 0;
  for (const sq of SQUARES) {
    const piece = board[sq];
    if (piece !== EMPTY && typeOf(piece) !== KING)
      sum += (colourOf(piece) === us ? 1 : -1) * VALUE[typeOf(piece)];
  }
  return sum;
}

/* The most that colour `by` wins, by SEE, with its best single
   capture, or 0. A king only takes an undefended piece. */
function bestCaptureGain(board: Board, by: Colour): number {
  let best = 0;
  for (const sq of SQUARES) {
    const piece = board[sq];
    if (piece === EMPTY || colourOf(piece) === by || typeOf(piece) === KING)
      continue;
    const from = cheapestAttacker(board, sq, by);
    if (from === NO_SQUARE) continue;
    const attacker = typeOf(board[from]);
    if (attacker === KING &&
      cheapestAttacker(board, sq, opponent(by)) !== NO_SQUARE) continue;
    best = Math.max(best, see(board, from, sq, attacker, NO_SQUARE));
  }
  return best;
}

/* Is the side to move checkmated? */
function isMate(pos: Position): boolean {
  return inCheck(pos) && legalMoves(pos).length === 0;
}

/* Can the side to move mate in one? */
function canMateInOne(pos: Position): boolean {
  return legalMoves(pos).some((move) => isMate(makeLegalMove(pos, move)));
}

/** What the questions know about one legal move. */
interface MoveFacts {
  readonly pos: Position;
  readonly next: Position;          // the position after the move
  readonly from: Square;
  readonly to: Square;              // for castling, the rook's square
  readonly type: PieceType;         // the piece that moves
  readonly piece: PieceType;        // what it is after the move
  readonly captured: PieceType;     // EMPTY if nothing
  readonly castle: boolean;
  readonly us: Colour;
  readonly them: Colour;
  readonly ply: number;             // plies since the start of the game
  readonly endgame: boolean;
  readonly lastTo: Square;          // where the opponent's last move went
  readonly see: number;             // SEE of the move, in pawns
  readonly threats: number;         // see threatCount()
  readonly mobility: number;        // squares attacked after, minus before
  readonly wasEnPrise: boolean;     // the moving piece was en prise
  readonly newTarget: boolean;      // more enemy pieces en prise after it
  readonly check: boolean;
  readonly mate: boolean;
  readonly net: number;             // material won, less their best capture
  readonly behindBest: number;      // how much less net than the best move's
  readonly allowsMate: boolean;     // they can mate in one after it
  readonly nextCapture: number;     // our best capture, if it were our turn
}

const quiet = (m: MoveFacts) => !m.castle && m.captured === EMPTY;
const isPawnMove = (m: MoveFacts) => !m.castle && m.type === PAWN;
const isPieceMove = (m: MoveFacts) =>
  !m.castle && m.type !== PAWN && m.type !== KING;
const isMinor = (m: MoveFacts) =>
  !m.castle && (m.type === KNIGHT || m.type === BISHOP);

/** A question about a move, and what a "yes" adds to its score. */
interface Feature {
  readonly name: string;
  readonly weight: number;
  readonly test: (m: MoveFacts) => boolean;
}

/* The questions, in the order they were trained in. */
const FEATURES: readonly Feature[] = [
  // Material: what the move's captures win or lose (SEE).
  { name: "capture wins 3+", weight: 1.6063,
    test: (m) => m.captured !== EMPTY && m.see >= 3 },
  { name: "capture wins 1-2", weight: 1.1992,
    test: (m) => m.captured !== EMPTY && m.see >= 1 && m.see < 3 },
  { name: "capture is even", weight: 0.6217,
    test: (m) => m.captured !== EMPTY && m.see === 0 },
  { name: "capture loses 1-2", weight: -0.4096,
    test: (m) => m.captured !== EMPTY && m.see <= -1 && m.see > -3 },
  { name: "capture loses 3+", weight: -0.3584,
    test: (m) => m.captured !== EMPTY && m.see <= -3 },
  { name: "quiet move drops a pawn", weight: -0.548,
    test: (m) => quiet(m) && m.type === PAWN && m.see < 0 },
  { name: "quiet move drops a knight", weight: -0.7733,
    test: (m) => quiet(m) && m.type === KNIGHT && m.see < 0 },
  { name: "quiet move drops a bishop", weight: -1.3424,
    test: (m) => quiet(m) && m.type === BISHOP && m.see < 0 },
  { name: "quiet move drops a rook", weight: -0.9626,
    test: (m) => quiet(m) && m.type === ROOK && m.see < 0 },
  { name: "quiet move drops the queen", weight: -1.4728,
    test: (m) => quiet(m) && m.type === QUEEN && m.see < 0 },
  { name: "rescues a knight", weight: 0.9408,
    test: (m) => !m.castle && m.type === KNIGHT && m.wasEnPrise && m.see >= 0 },
  { name: "rescues a bishop", weight: 0.8274,
    test: (m) => !m.castle && m.type === BISHOP && m.wasEnPrise && m.see >= 0 },
  { name: "rescues the queen", weight: 0.7076,
    test: (m) => !m.castle && m.type === QUEEN && m.wasEnPrise && m.see >= 0 },
  // Tactics
  { name: "pawn threatens a piece", weight: 0.1384,
    test: (m) => isPawnMove(m) && m.threats === 1 },
  { name: "gives check", weight: 1.7061, test: (m) => m.check },
  { name: "gives mate", weight: 8.5012, test: (m) => m.mate },
  { name: "recaptures", weight: 0.4738,
    test: (m) => m.captured !== EMPTY && m.to === m.lastTo },
  { name: "creates a new enemy target", weight: 0.5603,
    test: (m) => m.newTarget },
  // King safety
  { name: "castles kingside", weight: 2.7919,
    test: (m) => m.castle && m.to > m.from },
  { name: "castles queenside", weight: 2.1504,
    test: (m) => m.castle && m.to < m.from },
  { name: "gives up castling rights", weight: -0.9605,
    test: (m) => !m.castle && (m.pos.castlingRights & (3 << (2 * m.us))) !==
      (m.next.castlingRights & (3 << (2 * m.us))) },
  { name: "pawn move in front of our castled king", weight: -0.362,
    test: (m) => isPawnMove(m) && isCastled(m.next.kingSq[m.us], m.us) &&
      Math.abs(fileOf(m.from) - fileOf(m.next.kingSq[m.us])) <= 1 },
  { name: "king move in the endgame", weight: 0.6438,
    test: (m) => !m.castle && m.type === KING && m.endgame },
  // Development and activity
  { name: "develops a knight or bishop", weight: 0.7911,
    test: (m) => isMinor(m) && relativeRank(m.from, m.us) === 0 },
  { name: "queen move before ply 20", weight: -0.7095,
    test: (m) => !m.castle && m.type === QUEEN && m.ply < 20 },
  { name: "rook to an open file", weight: 1.0645,
    test: (m) => !m.castle && m.type === ROOK &&
      fileOf(m.to) !== fileOf(m.from) &&
      !pawnOnFile(m.next.board, fileOf(m.to), m.us) &&
      !pawnOnFile(m.next.board, fileOf(m.to), m.them) },
  { name: "rook to a half-open file", weight: 0.9721,
    test: (m) => !m.castle && m.type === ROOK &&
      fileOf(m.to) !== fileOf(m.from) &&
      !pawnOnFile(m.next.board, fileOf(m.to), m.us) &&
      pawnOnFile(m.next.board, fileOf(m.to), m.them) },
  { name: "more central", weight: 0.2911,
    test: (m) => isPieceMove(m) && offCentre(m.to) < offCentre(m.from) },
  { name: "mobility +3 or more", weight: 0.3947,
    test: (m) => isPieceMove(m) && m.mobility >= 3 },
  { name: "mobility -3 or less", weight: -0.4244,
    test: (m) => isPieceMove(m) && m.mobility <= -3 },
  { name: "piece advances", weight: 0.5198,
    test: (m) => isPieceMove(m) &&
      relativeRank(m.to, m.us) > relativeRank(m.from, m.us) },
  { name: "piece retreats", weight: 0.2876,
    test: (m) => isPieceMove(m) &&
      relativeRank(m.to, m.us) < relativeRank(m.from, m.us) },
  { name: "outpost for a knight or bishop", weight: 0.6056,
    test: (m) => isMinor(m) && m.captured === EMPTY &&
      attacks(m.next.board, m.to, PAWN, m.them)
        .some((s) => m.next.board[s] === makePiece(PAWN, m.us)) &&
      !enemyPawnAhead(m.next.board, m.to, m.us, false) },
  // Pawns
  { name: "pawn to rank 3", weight: 0.5424,
    test: (m) => isPawnMove(m) && relativeRank(m.to, m.us) === 2 },
  { name: "pawn to rank 4", weight: 0.7706,
    test: (m) => isPawnMove(m) && relativeRank(m.to, m.us) === 3 },
  { name: "pawn to rank 5", weight: 1.1718,
    test: (m) => isPawnMove(m) && relativeRank(m.to, m.us) === 4 },
  { name: "pawn to rank 6", weight: 1.3964,
    test: (m) => isPawnMove(m) && relativeRank(m.to, m.us) === 5 },
  { name: "pawn to rank 7", weight: 2.2679,
    test: (m) => isPawnMove(m) && relativeRank(m.to, m.us) === 6 },
  { name: "pawn break (attacks a pawn)", weight: 0.4925,
    test: (m) => isPawnMove(m) && m.captured === EMPTY &&
      attacks(m.next.board, m.to, PAWN, m.us)
        .some((s) => m.next.board[s] === makePiece(PAWN, m.them)) },
  // Replies to the opponent's last move
  { name: "moves the piece the last move attacked", weight: 0.4802,
    test: (m) => !m.castle && m.lastTo !== NO_SQUARE &&
      m.pos.board[m.lastTo] !== EMPTY &&
      attacks(m.pos.board, m.lastTo, typeOf(m.pos.board[m.lastTo]), m.them)
        .includes(m.from) },
  // The opponent's replies: material won, less their best capture
  { name: "net -3 or less", weight: -0.999, test: (m) => m.net <= -3 },
  { name: "net -2 to -1", weight: -0.2162,
    test: (m) => m.net > -3 && m.net < 0 },
  { name: "net 0", weight: 0.3176, test: (m) => m.net === 0 },
  { name: "net +1 to +2", weight: 1.0113,
    test: (m) => m.net > 0 && m.net < 3 },
  { name: "net +3 or more", weight: 1.8192, test: (m) => m.net >= 3 },
  { name: "net 1-2 behind the best move's", weight: -0.9727,
    test: (m) => m.behindBest >= 1 && m.behindBest < 3 },
  { name: "net 3+ behind the best move's", weight: -1.8729,
    test: (m) => m.behindBest >= 3 },
  { name: "allows mate in one", weight: -7.1413, test: (m) => m.allowsMate },
  { name: "our next capture would win 1-2", weight: 0.4135,
    test: (m) => m.nextCapture >= 1 && m.nextCapture < 3 },
  { name: "our next capture would win 3+", weight: 0.6705,
    test: (m) => m.nextCapture >= 3 },
];

/* The facts about each of `moves`, the legal moves of `pos`, reached
   at `ply` after the opponent's last move went to `lastTo`: all but
   behindBest, which needs them all. */
function factsOf(
  pos: Position, moves: readonly Move[], ply: number, lastTo: Square,
): Omit<MoveFacts, "behindBest">[] {
  const board = pos.board, us = pos.sideToMove, them = opponent(us);
  const phase = SQUARES.reduce(
    (sum, sq) => sum + PHASE_WEIGHT[typeOf(board[sq])], 0);
  const targetsBefore = enPriseCount(board, them);
  const materialBefore = material(board, us);
  return moves.map((move) => {
    const next = makeLegalMove(pos, move);
    const from = fromSq(move), to = toSq(move), type = typeOf(board[from]);
    const castle = moveType(move) === FLAG_CASTLE;
    const ep = moveType(move) === FLAG_EP;
    const captured = castle ? EMPTY : ep ? PAWN : typeOf(board[to]);
    const piece = promoType(move) || type;
    const check = inCheck(next), mate = check && isMate(next);
    return {
      pos, next, from, to, type, piece, captured, castle, us, them, ply,
      endgame: phase <= ENDGAME_PHASE, lastTo,
      see: castle ? 0
        : see(board, from, to, piece, ep ? to - PAWN_STEP[us] : NO_SQUARE),
      threats: castle ? 0 : threatCount(next.board, to, piece, us),
      mobility: castle || type === PAWN || type === KING ? 0
        : attacks(next.board, to, piece, us).length -
          attacks(board, from, type, us).length,
      wasEnPrise: type !== KING && enPrise(board, from, them),
      newTarget: enPriseCount(next.board, them) > targetsBefore,
      check, mate,
      net: material(next.board, us) - materialBefore -
        bestCaptureGain(next.board, them),
      allowsMate: !mate && canMateInOne(next),
      nextCapture: bestCaptureGain(next.board, us),
    };
  });
}

/** One legal move, its score and the features that make it up. */
interface Scored {
  readonly move: Move;
  readonly score: number;
  readonly features: readonly Feature[];
}

/* Every legal move of `pos` with its score: the sum of the weights
   of its "yes" answers. In generation order. */
function moveScores(pos: Position, ply: number, lastTo: Square): Scored[] {
  const moves = legalMoves(pos);
  const facts = factsOf(pos, moves, ply, lastTo);
  const bestNet = Math.max(...facts.map((f) => f.net));
  return facts.map((f, i) => {
    const m: MoveFacts = { ...f, behindBest: bestNet - f.net };
    const features = FEATURES.filter((feature) => feature.test(m));
    const score = features.reduce((sum, feature) => sum + feature.weight, 0);
    return { move: moves[i], score, features };
  });
}

/* The move to play in `pos`: the first of the best-scoring moves, or
   NO_MOVE when there is no legal move. */
function chooseMove(pos: Position, ply: number, lastTo: Square): Move {
  const best = moveScores(pos, ply, lastTo).reduce<Scored | null>(
    (top, scored) => (top === null || scored.score > top.score ? scored : top),
    null);
  return best === null ? NO_MOVE : best.move;
}

/* ================================================================
   S2  CHESS RULES AND POSITION
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
   S3  ZOBRIST HASHING
   ================================================================

   Each (piece, square), each castling-rights set, each en passant
   file and the side to move gets a random 32-bit number. The
   position's key is the XOR of the numbers for everything in it, so
   it can be updated incrementally: XOR a piece's number in when it
   arrives on a square, and XOR it again (out) when it leaves. Two
   equal positions always have equal keys. The key is used to detect
   repetitions.

   The numbers come from a fixed-seed xorshift generator, so every
   machine gets the same keys.
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

const ZOBRIST_SEED = 0x2545F491;    // seeds zobristKeys(), as in engine.ts
const { zobPiece, zobCastle, zobEp, zobSide } = zobristKeys(ZOBRIST_SEED);

/* ================================================================
   S4  UCI
   ================================================================

   The Universal Chess Interface: a GUI (or a match manager such as
   cutechess) writes commands on one line each, and we answer in
   kind.

   Everything the engine remembers between commands is one session
   value: { pos, firstPly, lastTo, bookPlies, chess960 }. Besides
   the position, the questions want the ply (for "queen move before
   ply 20") and where the opponent's last move went, so "position"
   keeps those too. uciCommand(session, line, io) handles one line
   and returns the session for the next one. `io` is how it talks to
   the world: { out(line), now(), shouldStop() }. The I/O code at
   the end of the file wires it to stdin/stdout in Bun or to
   postMessage in a browser Web Worker.

   Opening books often give positions as FENs that say "move 1"
   (8moves_v3.epd: 8 moves in). Book_Plies is the ply such a FEN
   stands for, so the opening questions are not asked as if the
   game had just begun; cutechess matches use Book_Plies 16.
*/

/** Everything the engine remembers between UCI commands. */
interface Session {
  readonly pos: Position;
  readonly firstPly: number;      // the ply of the position's FEN
  readonly lastTo: Square;        // where the last move went, or NO_SQUARE
  readonly bookPlies: number;
  readonly chess960: boolean;
}

/** How uciCommand talks to the world: output, a clock and a stop request. */
interface Io {
  out(line: string): void;
  now(): Millis;
  shouldStop(): boolean;
}

/* The session a fresh engine starts in: the starting position, not
   Chess960. */
function newSession(): Session {
  return {
    pos: parseFen(START_FEN), firstPly: 0, lastTo: NO_SQUARE,
    bookPlies: 0, chess960: false,
  };
}

/* Carry out one UCI command, and return the session it leaves.
   "quit" is echoed back so the I/O layer knows the queue is
   drained. Unknown commands are ignored. */
function uciCommand(session: Session, line: string, io: Io): Session {
  const tokens = words(line);
  const { pos, chess960 } = session;
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
      return { ...session, pos: parseFen(START_FEN), firstPly: 0, lastTo: NO_SQUARE };
    case "position": {
      const args = tokens.slice(1).join(" ");
      return { ...session, ...parsePosition(args, chess960, session.bookPlies) };
    }
    case "go":
      go(session, io);
      return session;
    case "stop":
      return session;
    case "quit":
      io.out("quit");
      return session;
    case "perft":
      perftDivide(pos, toInteger(tokens[1], 4), chess960, io);
      return session;
    case "d":
      printBoard(pos, chess960, io.out);
      return session;
    case "eval":
      explain(session, io);
      return session;
    default:
      return session;
  }
}

/* Answer "uci": the engine's name and author, then its options:
     UCI_Chess960  castling is written king-takes-rook
     Book_Plies    the ply of a book FEN that says move 1 */
function identify(io: Io): void {
  io.out("id name Pedagog Searchless 1.0");
  io.out("id author Copilot");
  io.out("option name UCI_Chess960 type check default false");
  io.out("option name Book_Plies type spin default 0 min 0 max 1000");
  io.out("uciok");
}

/* The session after "setoption name <name> value <value>". Unknown
   options leave it as it is. */
function setOption(session: Session, tokens: readonly string[]): Session {
  const nameAt = tokens.indexOf("name"), valueAt = tokens.indexOf("value");
  const name = tokens
    .slice(nameAt + 1, valueAt > 0 ? valueAt : tokens.length)
    .join(" ")
    .toLowerCase();
  const value = valueAt > 0 ? tokens.slice(valueAt + 1).join(" ") : "";
  if (name === "uci_chess960")
    return { ...session, chess960: value.toLowerCase() === "true" };
  if (name === "book_plies")
    return { ...session, bookPlies: Math.max(0, toInteger(value, 0)) };
  return session;
}

/* The ply of the session's position: its FEN's, plus the moves
   played since. */
function plyOf(session: Session): number {
  return session.firstPly + session.pos.gamePly;
}

/* Answer "go ...": choose a move at once, whatever the limits, and
   report it ("0000" when there is no legal move). */
function go(session: Session, io: Io): void {
  const { pos, lastTo, chess960 } = session;
  const move = chooseMove(pos, plyOf(session), lastTo);
  io.out("bestmove " + (move !== NO_MOVE ? moveToUci(move, chess960) : "0000"));
}

/* The "eval" command: every legal move, best first, with its score
   and the questions it answers "yes". */
function explain(session: Session, io: Io): void {
  const { pos, lastTo, chess960 } = session;
  const scored = moveScores(pos, plyOf(session), lastTo)
    .map((s, order) => ({ ...s, order }))
    .sort((a, b) => b.score - a.score || a.order - b.order);
  for (const { move, score, features } of scored) {
    const why = features
      .map((f) => `${f.name} ${f.weight > 0 ? "+" : ""}${f.weight}`)
      .join(", ");
    io.out(`${moveToUci(move, chess960).padEnd(6)} ${score.toFixed(2).padStart(6)}  ${why}`);
  }
}

/* A new position from the arguments of a UCI "position" command:
   "startpos" or "fen <FEN>", optionally followed by "moves ...". An
   unknown move is skipped. Also returns the ply of the FEN (a book
   FEN that says move 1 stands for `bookPlies`) and the square the
   last move went to. */
function parsePosition(
  spec: string, chess960: boolean, bookPlies: number,
): { pos: Position; firstPly: number; lastTo: Square } {
  const tokens = words(spec);
  const movesAt = tokens.indexOf("moves");
  const end = movesAt >= 0 ? movesAt : tokens.length;
  const fen = tokens[0] === "fen" ? tokens.slice(1, end).join(" ") : START_FEN;
  const moves = tokens.slice(end + 1);
  const pos = moves.reduce((pos, str) => {
    const move = parseMove(pos, str, chess960);
    return move !== NO_MOVE ? makeLegalMove(pos, move) : pos;
  }, parseFen(fen));
  const fields = words(fen);
  const counted = (toInteger(fields[5], 1) - 1) * 2 + (fields[1] === "b" ? 1 : 0);
  const fromBook = counted === 0 && fields[0] !== words(START_FEN)[0];
  const last = moves[moves.length - 1];
  return {
    pos, firstPly: fromBook ? bookPlies : counted,
    lastTo: last !== undefined ? parseSquare(last.slice(2, 4)) : NO_SQUARE,
  };
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

/* The "d" command: the board, its FEN and key. */
function printBoard(
  pos: Position, chess960: boolean, out: (line: string) => void,
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
}

/* ---- Start-up and I/O ---------------------------------------------
   engine.ts's, less its bench command. Choosing a move takes
   milliseconds, but the hosts are kept as they are, so this file
   runs wherever engine.ts does: the main thread reads input and a
   worker answers it. In a browser, the page is the main thread (see
   src/web/index.html).

   The stop flag in a SharedArrayBuffer is how engine.ts stops a
   search from the main thread; here nothing reads it, as there is
   no search to stop. Ordinary commands and results travel through
   worker messages.

   Each host below keeps the current session in its own `let session`
   and replaces it with whatever uciCommand() returns. */

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
   - Bun's main thread. It reads stdin and passes commands to a
     worker, but answers "stop", "quit" and (while choosing)
     "isready" itself. When stdin closes, the worker finishes its
     queue, then exits.
   - The worker, which runs uciCommand().
   - Anything else (a browser page): drive it by hand through
     globalThis.Pedagog. */
if (isBun && Bun.isMainThread) {
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
