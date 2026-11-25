# engine-habits

A style variant that plays like **VBKN**, GM Aman Hambleton's account in ChessBrah's "Building
Habits" speedrun (chess.com, about 400 to 1900). First, what his games show; then the engine,
`engine-habits.ts` (based on `engine-simplehuman-2knob.ts`), its tuning, and its strength. So
far only level 10, the 1550+ stage, is done.

## The data

`vbkn-white.pgn` and `vbkn-black.pgn` are his chess.com games. Only **5+0** games are used (394
of 1129); bullet and 3+0 are ignored (`habits_stats.load()`). The bands follow the series'
habit list (https://www.chessjournal.com/chessbrah-habits/): 0-700, 700-1100, 1100-1550, 1550+.

Scripts (python-chess; the Stockfish passes use `stockfish` on PATH):

- `habits_stats.py`, `habits_deep.py`: openings, trades, castling, king and rook moves,
  signature moves (his rate vs his opponents').
- `habits_probe.py`: static probes (blockades, BxN, h3, isolanis, g-pawn storms) and a
  Stockfish tactics pass (multipv 2 at 150k nodes; a tactic is a unique best move 150cp+ ahead
  of the second). Results are cached per game link in
  `src/tools/out/habits/tactics-n150000.json`, so overlapping PGNs are analysed once.
- `habits_bands.py`: everything below, per band, with all his opponents as a baseline.
- `habits_compare.py`: the same numbers for an engine match (see "Tuning").

## What his games show

VBKN by band (<700 / 700-1099 / 1100-1549 / 1550+), with his opponents (all bands) in brackets:

- **Score** 69 / 76 / 77 / 74%, against opponents averaging 535 / 894 / 1310 / 1736.
- **Openings**: 1.e4 as White and 1...e5 against 1.e4 in every band. Against 1.d4, 1...d5
  until 1550, then 1...Nf6 (Nimzo-Indian). He enters the Four Knights 59 / 54 / 44 / 5% of
  the times it's offered.
- **Never resigns**: 0% of losses by resignation (38%).
- **Castles short** about 90% (66%). **h3** by move 20 in 74-79% of games (36%), mostly
  after castling.
- **Kicks a minor** on b4/g4 (b5/g5) with the a/h pawn when he can: 55 / 63 / 46 / 47% (15%).
- **Pawn captures towards the centre** when he has a choice: 93 / 69 / 69 / 67% (52%).
- **Rooks**: twice his opponents' rook moves by move 15 (to d1/e1); a rook reaches the 7th in
  21 / 31 / 32 / 38% (19%); rook behind a passed pawn about 30%, then 60% at 1550+ (25%).
- **Trades** (an equal-or-better capture available): taken 76 / 44 / 30 / 30% when level and
  69 / 53 / 25 / 25% when behind. Early on he trades everything; later he trades when ahead.
- **Bishops**: rarely BxN (2-19%); his bishops go to c4, b3 and e3, never fianchettoed.
- **Isolanis** fall from 0.76 to 0.46 per position. He's seldom a pawn down at move 10
  (7 / 6 / 2 / 0%, against 19%): no gambits.
- **Tactics found** (+150cp): 28 / 49 / 64 / 65% (52%); forks 17 / 80 / 94 / 91% (68%).
- No clear pattern: blockading passed pawns, king activity in the endgame (his king makes
  fewer endgame moves than his opponents'), g-pawn storms. Pure R vs N endings are too rare
  to judge.

## The engine

Three layers on top of 2-knob; the search, its depth and vision are unchanged.

- **Repertoire** (`WHITE_LINES`, `BLACK_LINES`): his 1550+ lines, 4-12 plies. The search
  plays the repertoire's move unless another move scores more than `Habits_Book` (100cp)
  better, and never overlooks it. Lookups ignore the en passant square (`bookKey()`), as a FEN
  usually leaves it out where makeMove() records it.
- **Root habits** (`rootHabit()`): +`Habits_Kick` for a/h-pawn kicks of a minor on b4/g4,
  +`Habits_Centre` for a pawn capture towards the centre. The reply is searched with the
  window shifted by the bonus, so cutoffs stay exact.
- **Evaluation habits** (`habitsBonus()`), for the engine's side only, so the search doesn't
  expect the opponent to share them. Middlegame (faded with the phase): castled short, h3 in
  front of it, a penalty once short castling is lost (castled long or walked), fianchettoed
  bishops, an early queen, bishops on c4/b3/e3, rooks on the d/e files. Every phase: rook on
  the 7th, rook behind its passed pawn, isolanis, the bishop pair, and trading when a minor or
  more ahead (avoiding it when behind).

Every weight is a `Habits_*` UCI option (0-500).

## Tuning (level 10)

Level 10 against 2-knob level 10, 2026-11-25. Both are deterministic at level 10 (vision
1024), so every game needs a different start. `vbkn-starts.epd` holds every opening his
1550+ opponents chose, cut where he is next to move (52 starts from 1 to 4 plies; two
transpose), each played with both colours. `habits_compare.py` rebuilds each game from the
initial position and scores it like `habits_bands.py`. In half the games the engine sits on
the side VBKN didn't play, so the opening rows (1.e4 and so on) don't apply.

    python src/variants/engine-habits/habits_compare.py starts
    bun src/tools/match.js L10 prev:L10 104 --book src/variants/engine-habits/vbkn-starts.epd \
      --engine src/variants/engine-habits/engine-habits.ts \
      --previous-engine src/variants/engine-simplehuman/engine-simplehuman-2knob.ts \
      --out src/tools/out/habits --tag h10-starts-v3
    python src/variants/engine-habits/habits_compare.py src/tools/out/habits/h10-starts-v3.pgn

Results (W-L-D for habits):

- v1, first weights, 8-move book: 29-24-47, +17 ± 50 Elo.
- v1 from `vbkn-starts.epd`: 20-31-53, -37 ± 47. Repertoire followed 36 of 46 times; every
  miss came straight after a double pawn step in the book start, the en passant key bug above.
- v2, stronger castling, h3, rook file, isolani and centre weights, plus the bishop pair:
  33-25-46, +27 ± 50. Repertoire followed 45 of 47 times.
- v3, the current defaults (v2 plus the lost-castling penalty, h3 45, rook file 30):
  30-30-44, 0 ± 51.
- v4, v3 plus the contact rule in seesMove(): taking, from the next square, a piece that has
  just landed there is never overlooked (2-knob had 31...Rxb1+ in a blind spot and so played
  31.Rb1 next to Black's rook): 32-32-40, 0 ± 53.

v3 against VBKN at 1550+ and 2-knob in the same games:

- castles short 75% (VBKN 92%, 2-knob 7%); never castles 24% (6%, 77%)
- h3 by move 20: 54% (74%, 24%)
- early queen moves per game: 0.26 (0.08, 0.59)
- rook moves by move 15 per game: 0.74 (1.16, 0.28)
- kicks a minor with the a/h pawn: 60% (47%, 51%)
- pawn captures towards the centre: 55% (67%, 25%)
- rook behind passer: 42% (60%, 39%)
- BxN when available: 20% (7%, 25%)
- isolanis: 0.59 (0.46, 1.01)
- equal trades taken when level / behind: 46 / 56% (30 / 25%, 41 / 54%)

Over 104 games a share moves by about ±10 points from run to run (v2's trade rates were
close to his; v3's aren't, with the same trade weight). The strength cost is nil within the
error bars: 0 ± 51 Elo.

Still unlike him: he trades less, finds more tactics (65% against 41%) and never resigns.
The engine doesn't resign either; match.js adjudicates lost games.

## Not done yet

- Levels 2-9: a stage per level (0-700 at L2-3, 700-1100 at L4-5, 1100-1550 at L6-7, 1550+
  at L8-10) with each stage's repertoire (1...d5 against 1.d4 below 1550, the Four Knights)
  and trade appetite (trading everything early on), and settle() at odd depths as in
  engine-hedgehog.
