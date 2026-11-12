# Names in engine.ts and where they come from

Pedagog takes its names from engines a reader is likely to meet next, so
that what is learned here carries over. Five reference engines:

- SF: Stockfish
- Chal: Chal
- Gaia: Gaia
- Pat: Patricia
- TCB: Tiny Chess Bot (Sebastian Lague's Chess-Challenge API)

A name is taken when two or more of them agree. Where they don't, Pedagog
keeps its own. Names are written in engine.ts's camelCase; the references
spell them in their own style (`side_to_move`, `SideToMove`).

Ports keep these names, adjusted only to their language's casing (see
[porting](porting/README.md)).

## Types

engine.ts declares `Move`, `MoveType`, `Square`, `Index64`, `File`,
`Rank`, `Piece`, `PieceType`, `Colour`, `Score`, `Millis`, `Key` and
`Pv` (`readonly Move[]`), all numbers or arrays under the hood.

- `Move`: every reference names the move type (SF `Move`, Chal and Pat
  `typedef uint16_t Move`, Gaia `struct Move(u16)`, TCB `struct Move`).
- `Piece` / `PieceType`: SF, Gaia and TCB all separate the coloured piece
  from its type (pawn…king).
- `Square`: SF `enum Square`, Gaia and TCB `Square`.
- `Score`: SF uses `Value`; the others use plain `int`. "Score" is
  Pedagog's word throughout (`bestScore`, `Line.score`).
- `Colour`: every reference spells it "Color"; Pedagog keeps British
  spelling.
- `Key`: SF and Gaia `key`.
- `Pv`: the line of best play. No reference stores moves as boxed
  integers. A port should use a named move type in a list or array.

## Functions

Taken from the references:

- `qsearch`: SF, Chal, Pat (Gaia `quiescence`).
- `parseFen`: Chal `parse_fen`; also lines up with `parseMove` and
  `parseGo`.
- `parsePosition`: Chal and Gaia `parse_position`.
- `fromSq` / `toSq`: SF and Gaia `from_sq` / `to_sq`.
- `promoType`: Gaia `promo_type`, SF `promotion_type`.
- `moveType`: Gaia `move_type`, SF `type_of(Move)`, Pat `extract_type`.
- `pieceSquareTables` / `psqBonus`: the usual "PST/psq" term (SF, Gaia,
  TCB).
- `isSquareAttacked`: Chal `is_square_attacked`, TCB
  `SquareIsAttackedByOpponent`.
- `printBoard`: Pat and Gaia `print_board`.
- `depthFor`: Gaia `depth_for`.
- Already shared by most references: `think`, `search`, `evaluate`,
  `makeMove`, `inCheck`, `isDraw`, `isCapture`, `generateMoves`,
  `legalMoves`, `parseMove`, `toFen`, `parseGo`, `perft`, `perftDivide`,
  `bench`, `seesMove`, `outermostRook`, `mix32`.

Bit-twiddling sits behind named helpers, as in SF `types.h`, Gaia
`types.rs` and Pat `defs.h`:

- `typeOf`, `colourOf`, `makePiece` (SF `type_of`, `color_of`,
  `make_piece`).
- `fileOf`, `rankOf`, `flipRank` (SF and Gaia).
- `onBoard` (the 0x88 test; nearest is SF `is_ok`), `opponent`,
  `hasRight`, `isKingside`.
- The board layout (0x88) is confined to the geometry block:
  `makeSquare`, `index64`, `BOARD_SIZE`, `SQUARES`, `PAWN_STEP`,
  `KING_DISTANCE`. Zobrist keys, piece-square tables and skill hashes are
  indexed by `index64`, so a port can choose another layout without
  changing any output.

Pedagog's own names, where the references disagree:

- `limitReached` (SF/Chal `check_time` return nothing; Pat
  `out_of_time`), `orderMoves`, `capturesByValue` (MVV-LVA), `infoLine`,
  `uciCommand`, `newSession`, `zobristKeys`, `moveToUci`, `encodeMove`.
- The skill code (`skillFor`, `judge`, `blunder`, `randomMove`,
  `overlookedRootMoves`): only Gaia's `skill.rs` is close, and it shares
  Pedagog's ladder vocabulary (`rung`, `sees_move`).

## Position fields

- Taken: `sideToMove` (SF), `castlingRights` (SF, Gaia),
  `castlingRightsMask` and `castlingRookSquare` (SF), `epSquare` (SF,
  Gaia, Pat), `halfmoveClock` (the FEN field; Gaia), `gamePly` (SF, Pat),
  `capturedPiece` (SF), `previous` (SF `StateInfo.previous`).
- Shared already: `board`, `pieceCount`, `kingSq`, `key`.

## Search and constants

- Universal: `alpha`, `beta`, `depth`, `ply`, `us`/`them`, `from`/`to`,
  `standPat`, `rootMoves`.
- `pvMove`: the textbook term for the move tried first (SF's slot is
  `ttMove`).
- `Limits.softMs` / `hardMs` (Gaia soft/hard), `Result` fields (SF
  `RootMove` and UCI wording), `Line` (Chal `PVLine` plus the score).
- `MATE_IN_MAX_PLY` (SF `VALUE_MATE_IN_MAX_PLY`), `MAX_PLY`, `MATE`,
  `INF`, `DRAW`.
- `EMPTY` (the usual mailbox word; SF `NO_PIECE`), `NO_MOVE`,
  `NO_SQUARE`, `FLAG_EP`, `FLAG_CASTLE` (Chal style), `PIECE_CHARS` (SF
  `PieceToChar`), `zobPiece`/`zobCastle`/`zobEp`/`zobSide` (Chal
  `zobrist_*`).
