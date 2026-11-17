/*
================================================================
                      P E D A G O G
================================================================
   A single-file UCI chess engine in TypeScript, written to be
   read from top to bottom like a short book on chess programming.

   RANDOM VARIANT: engine.ts with the search, the skill ladder and
   the evaluation taken out. It plays a random legal move, and
   nothing else: it does not even take a mate in one. The choice is
   drawn from the position's key and the Seed option, so the same
   position and seed always get the same move.

   Based on engine.ts at commit c9f1d5e (2026-11-12, "Return
   engine.ts to one plain style").

   Runs in Bun, which runs TypeScript directly
   (`bun variants/engine-random.ts`), or in a browser Web Worker
   once its types are removed (tools/engine-js.js).

   Supports standard chess and Chess960 (UCI_Chess960), a
   deterministic Seed, and the Hash/Threads options OpenBench
   expects. Choosing a move is instant, so there is nothing to
   interrupt and no search thread.

   HOW TO READ IT
   Every function names what it needs in its parameters and hands
   back what it found as its return value, so each one can be read
   on its own page. No function changes anything it is given. Only
   one kind of object changes after it is made, and it belongs to
   the one call that creates it: a Draft (makeMove()'s scratch copy
   of the board). The only `let`s outside a function belong to the
   I/O code at the very end.

   Positions are values too: makeMove() returns a new position
   rather than changing the old one. That costs some speed, since
   every move copies a board, but nothing ever has to be undone.
================================================================

   TABLE OF CONTENTS
   -----------------
   S0  Constants           Pieces, squares, board layout, moves
   S1  Random Move         The whole of the engine's play
   S2  Chess Rules         Position, copy/make, moves, attacks
   S3  Zobrist Hashing     Position keys that seed the choice
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
   Tables that should not depend on it (the Zobrist keys) are
   indexed by index64(sq): 0 = a1 ... 63 = h8.

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
/** Milliseconds. */
type Millis = number;

const NAME = "Pedagog Random", VERSION = "1.0";

const WHITE = 0, BLACK = 1;
const EMPTY = 0, PAWN = 1, KNIGHT = 2, BISHOP = 3;
const ROOK = 4, QUEEN = 5, KING = 6;
const PIECE_CHARS = ".PNBRQK..pnbrqk";
const FILE_NAMES = "abcdefgh";
const RANK_NAMES = "12345678";

const NO_MOVE: Move = 0;
const NO_SQUARE: Square = -1;
const FLAG_EP: MoveType = 1, FLAG_CASTLE: MoveType = 2;

const opponent = (colour: Colour): Colour => (colour === WHITE ? BLACK : WHITE);
const typeOf = (piece: Piece): PieceType => piece & 7;
const colourOf = (piece: Piece): Colour => (piece >> 3) as Colour;
const makePiece = (pieceType: PieceType, colour: Colour): Piece =>
  pieceType | (colour << 3);

// ---- The board layout: the only code that knows squares are 0x88.
const BOARD_SIZE = 128;
const fileOf = (sq: Square): File => sq & 7;
const rankOf = (sq: Square): Rank => sq >> 4;
const makeSquare = (file: File, rank: Rank): Square => rank * 16 + file;
const onBoard = (sq: Square): boolean => (sq & 0x88) === 0;
const index64 = (sq: Square): Index64 => rankOf(sq) * 8 + fileOf(sq);
/** The 64 squares, a1, b1, ... h8: the order every board walk uses. */
const SQUARES: readonly Square[] = Array.from({ length: 64 },
  (_, i) => makeSquare(i % 8, Math.floor(i / 8)));
/** One square forward for a pawn of each colour. */
const PAWN_STEP: readonly [number, number] = [16, -16];

const fromSq = (move: Move): Square => move & 127;
const toSq = (move: Move): Square => (move >> 7) & 127;
const promoType = (move: Move): PieceType => (move >> 14) & 7;
const moveType = (move: Move): MoveType => (move >> 17) & 3;
const encodeMove = (
  from: Square, to: Square, promo: PieceType, type: MoveType,
): Move =>
  from | (to << 7) | (promo << 14) | (type << 17);

const squareName = (sq: Square): string =>
  FILE_NAMES[fileOf(sq)] + RANK_NAMES[rankOf(sq)];
const parseSquare = (str: string): Square =>
  makeSquare(FILE_NAMES.indexOf(str[0]), RANK_NAMES.indexOf(str[1]));

const now = (): Millis => performance.now();

/* ================================================================
   S1  RANDOM MOVE
   ================================================================

   The engine's whole idea of chess: pick one of the legal moves at
   random. Not from the clock or a random generator, but from the
   position's key and the seed, so the same position and seed always
   get the same move and a game can be played again.
*/

/* The two multipliers were chosen for how well they scramble bits.
   The seeds are arbitrary (any distinct nonzero values would do),
   but changing either changes every move the engine picks. */
const MIX_MULTIPLIER = 0x45d9f3b;   // from a well-known 32-bit integer hash
const BUILT_IN_SEED = 0x9E3779B9;   // stands in for Seed 0
const ZOBRIST_SEED = 0x2545F491;    // seeds zobristKeys()

/* The Seed option, hashed. 0 means the built-in seed, so an engine
   nobody configures still plays the same game twice. */
const seedKeyFor = (seed: number): number =>
  mix32(seed === 0 ? BUILT_IN_SEED : seed);

/* A legal move for `pos`, chosen by `seedKey`, or NO_MOVE if there is
   none. */
function randomMove(pos: Position, seedKey: number): Move {
  const moves = legalMoves(pos);
  if (moves.length === 0) return NO_MOVE;
  return moves[mix32(pos.key ^ seedKey) % moves.length];
}

/* A 32-bit integer hash finaliser (two multiply-xorshift rounds).
   Returns an unsigned 32-bit number. */
function mix32(x: number): number {
  const a = Math.imul(x ^ (x >>> 16), MIX_MULTIPLIER);
  const b = Math.imul(a ^ (a >>> 16), MIX_MULTIPLIER);
  return (b ^ (b >>> 16)) >>> 0;
}

/* ================================================================
   S2  CHESS RULES AND POSITION
   ================================================================

   This section owns movement, king safety, castling, promotion and
   en passant, with FEN and UCI move notation alongside the position
   they describe.

   A position is a value: once made, it never changes. makeMove()
   does not alter the position it is given; it returns a new one
   (copy/make rather than make/unmake), or null if the move would
   leave the mover's king in check.

   Position contract:
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
     sideToMove      the colour to move
     castlingRights  the castling rights still held, four bits
     castle          { castlingRookSquare, castlingRightsMask }
     epSquare        en passant target square, or NO_SQUARE
     halfmoveClock   plies since the last capture or pawn move
     key             Zobrist key (see zobristKeys)
     gamePly         plies played since the FEN was loaded
*/

/** A Piece per Square, BOARD_SIZE entries. */
type Board = Int8Array;
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
  readonly sideToMove: Colour;
  readonly castlingRights: Rights;
  readonly castle: Castle;
  readonly epSquare: Square;
  readonly halfmoveClock: number;
  readonly key: Key;
  readonly gamePly: number;
}

const castlingRight = (colour: Colour, kingside: boolean): Right =>
  colour * 2 + (kingside ? 0 : 1);
const hasRight = (rights: Rights, right: Right): boolean =>
  ((rights >> right) & 1) !== 0;
const isKingside = (right: Right): boolean => right % 2 === 0;

// Where king and rook land, by Right: g1 c1 g8 c8, f1 d1 f8 d8.
const CASTLE_KING_TO: readonly Square[] =
  [makeSquare(6, 0), makeSquare(2, 0), makeSquare(6, 7), makeSquare(2, 7)];
const CASTLE_ROOK_TO: readonly Square[] =
  [makeSquare(5, 0), makeSquare(3, 0), makeSquare(5, 7), makeSquare(3, 7)];

/* The scratch copy of a position that makeMove() turns into the next
   one. Its board, king squares and key change together: lift() and
   put() keep them in step. */
class Draft {
  readonly board: Board;
  readonly kingSq: [Square, Square];
  key: Key;

  constructor(pos: Position) {
    this.board = pos.board.slice();
    this.kingSq = [pos.kingSq[0], pos.kingSq[1]];
    this.key = pos.key;
  }

  /* Take the piece off square `sq` and return it. */
  lift(sq: Square): Piece {
    const piece = this.board[sq];
    this.board[sq] = EMPTY;
    this.key ^= zobPiece[piece * 64 + index64(sq)];
    return piece;
  }

  /* Put `piece` on the empty square `sq`. */
  put(sq: Square, piece: Piece): void {
    this.board[sq] = piece;
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
  let epSquare = NO_SQUARE;
  let halfmoveClock = pos.halfmoveClock + 1;

  if (type === FLAG_CASTLE) {
    const right = castlingRight(us, to > from);
    const king = draft.lift(from), rook = draft.lift(to);
    draft.put(CASTLE_KING_TO[right], king);
    draft.put(CASTLE_ROOK_TO[right], rook);
  } else {
    if (draft.board[to] !== EMPTY) {
      draft.lift(to);
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
    board: draft.board, kingSq: draft.kingSq,
    sideToMove: them, castlingRights, castle: pos.castle, epSquare,
    halfmoveClock, key: draft.key, gamePly: pos.gamePly + 1,
  };
}

/* makeMove() for a move the caller already knows is legal. */
function makeLegalMove(pos: Position, move: Move): Position {
  const next = makeMove(pos, move);
  if (next === null) throw new Error("illegal move " + move);
  return next;
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
  const board = new Int8Array(BOARD_SIZE);
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
    board, kingSq, sideToMove, castlingRights, castle,
    epSquare, halfmoveClock: toInteger(parts[4], 0), key, gamePly: 0,
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

const isSlider = (pieceType: PieceType): boolean =>
  pieceType >= BISHOP && pieceType <= QUEEN;

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
  const pawnMove = (from: Square, to: Square, type: MoveType): void => {
    if (rankOf(to) === promoRank) {
      for (let promo = QUEEN; promo >= KNIGHT; promo--)
        moves.push(encodeMove(from, to, promo, 0));
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
   equal positions always have equal keys. Here the key's one job is
   to seed the random move choice.

   The numbers come from a fixed-seed xorshift generator, so every
   machine gets the same keys (and so the same moves).
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
   S4  UCI
   ================================================================

   The Universal Chess Interface: a GUI (or a match manager such as
   cutechess or OpenBench) writes commands on one line each, and we
   answer in kind.

   Everything the engine remembers between commands is one session
   value: { pos, seed, seedKey, chess960 }. uciCommand(session, line,
   io) handles one line and returns the session for the next one.
   `io` is how it talks to the world: { out(line), now() }. The I/O
   code at the end of the file wires it to stdin/stdout in Bun or to
   postMessage in a browser Web Worker.
*/

/** Everything the engine remembers between UCI commands. */
interface Session {
  readonly pos: Position;
  readonly seed: number;
  readonly seedKey: number;        // the seed, hashed
  readonly chess960: boolean;
}

/** How uciCommand talks to the world: output and a clock. */
interface Io {
  out(line: string): void;
  now(): Millis;
}

function newSession(): Session {
  return {
    pos: parseFen(START_FEN),
    seed: 0,
    seedKey: seedKeyFor(0),
    chess960: false,
  };
}

/* Carry out one UCI command, and return the session it leaves.
   "uci" lists the options:
     Hash          accepted, no effect: there is no transposition table
     Threads       accepted for OpenBench; always single-threaded
     UCI_Chess960  castling is written king-takes-rook
     Seed          which deterministic random mover; 0 = built-in
   "setoption" ignores Hash and Threads. "go" ignores its limits and
   answers at once, so "stop" has nothing to stop; "quit" is echoed
   back so the I/O layer knows the queue is drained. */
function uciCommand(session: Session, line: string, io: Io): Session {
  const tokens = words(line);
  const { pos, seedKey, chess960 } = session;
  switch (tokens[0]) {
    case "uci":
      io.out(`id name ${NAME} ${VERSION}`);
      io.out("id author Copilot (Claude Fable 5.1)");
      io.out("option name Hash type spin default 16 min 1 max 1024");
      io.out("option name Threads type spin default 1 min 1 max 1");
      io.out("option name UCI_Chess960 type check default false");
      io.out("option name Seed type spin default 0 min 0 max 2147483647");
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
      if (name === "seed") {
        const seed = toInteger(value, 0);
        return { ...session, seed, seedKey: seedKeyFor(seed) };
      }
      return session;
    }
    case "isready":
      io.out("readyok");
      return session;
    case "ucinewgame":
      return { ...session, pos: parseFen(START_FEN) };
    case "position": {
      const args = tokens.slice(1).join(" ");
      return { ...session, pos: parsePosition(args, chess960) };
    }
    case "go": {
      const move = randomMove(pos, seedKey);
      io.out("bestmove " +
        (move !== NO_MOVE ? moveToUci(move, chess960) : "0000"));
      return session;
    }
    case "quit":
      io.out("quit");
      return session;
    case "perft":
      perftDivide(pos, toInteger(tokens[1], 4), chess960, io);
      return session;
    case "d":
      printBoard(pos, chess960, io.out);
      return session;
    default:
      return session;
  }
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
   Every command, "go" included, finishes at once, so one thread
   reads the commands and carries them out in turn. Each host below
   keeps the current session in its own `let session` and replaces
   it with whatever uciCommand() returns. */

// Just enough of the hosts' APIs for the type checker: Bun, a worker
// and the page. (Declarations only; they vanish with the types.)
declare const Bun: { readonly isMainThread: boolean };
declare const process: { exit(code: number): never };
declare const console: { log(line: string): void } & AsyncIterable<string>;
declare const performance: { now(): number };
declare const WorkerGlobalScope: abstract new () => object;
declare const self: {
  postMessage(message: string): void;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
};
declare var Pedagog: {
  uci(line: string): void;
  setOutput(fn: (line: string) => void): void;
};

const isBun = typeof Bun !== "undefined";
const inWorker = isBun ? !Bun.isMainThread
  : typeof WorkerGlobalScope !== "undefined" &&
    self instanceof WorkerGlobalScope;

/* Start-up, in one of three hosts:
   - Bun's main thread reads stdin and exits on "quit" or when stdin
     closes.
   - A Web Worker answers each posted command line.
   - Anything else (a browser page): drive it by hand through
     globalThis.Pedagog. */
if (isBun && Bun.isMainThread) {
  let session = newSession();
  const io: Io = { out: (line) => console.log(line), now };
  (async () => {
    for await (const line of console) {
      if (words(line)[0] === "quit") process.exit(0);
      session = uciCommand(session, line, io);
    }
    process.exit(0);
  })();
} else if (inWorker) {
  let session = newSession();
  const io: Io = { out: (line) => self.postMessage(line), now };
  self.onmessage = (e) => {
    if (typeof e.data === "string")
      session = uciCommand(session, e.data, io);
  };
} else {
  let session = newSession(), output = (line: string) => console.log(line);
  const io: Io = { out: (line) => output(line), now };
  globalThis.Pedagog = {
    uci: (line) => { session = uciCommand(session, line, io); },
    setOutput: (fn) => { output = fn; },
  };
}
