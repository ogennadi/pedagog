# engine-searchless

A variant of Pedagog that plays without searching and tries to be strong, not
human-like: the target is to beat Maia-1900. It depends only on `engine.ts`
and `src/tools/engine-js.js`; its tools and data are its own.

"Searchless" means no game tree: every legal move is scored on its own with a
weighted sum of features, and the best is played. The features may use static
calculations — static exchange evaluation (SEE), and one pass over the
opponent's captures and mates after the move — but no minimax and no
recursion.

The best version so far is `uci.ts` with the 50 weights of
`engine-searchless.ts`, a learned position value added to their scores, and a
rule against repeating positions when ahead: −192 Elo against Maia-1900, about
1565 on the ladder's scale (Maia-1900 is 1755). `engine-searchless.ts` itself
(the 50 weights alone) is about 1540. See Approaches for everything tried.

## The engine

`engine-searchless.ts` is a single-file engine like `engine.ts`: its rules,
Zobrist keys and UCI code, with the search, skill levels and evaluation
replaced by 50 yes/no questions about each move and their weights (those of
`data/weights-prune-replies-top40.json`). `go` answers at once; `eval` lists
every move's score and the questions it answers yes. Set the `Book_Plies`
option to 16 with an opening book whose FENs say move 1 (`8moves_v3.epd`), so
the opening questions know how far into the game the position is. It picks
the same move as `uci.ts` with that weights file (2,000 of 2,000 validation
positions) and repeats its match exactly: 64–612–324 against Maia-1900,
−214 ± 19 Elo.

## Tools

The move weights, in order:

- `games.ts` extracts one rating bin's games from a Lichess month, in
  `testset.ts`'s format.
- `sflabel.ts` labels positions sampled from those games with Stockfish's move
  (full strength, fixed depth), in the same format.
- `concepts.ts` (81 named move concepts) and `strength.ts` (10 static reply
  checks) define the `strength` feature set; `features.ts` samples positions
  and loads them; `engine-vm.js` runs `engine.ts` for its rules.
- `train.ts` fits the 91 weights (a softmax over the legal moves, Adam).
- `prune.ts` refits with fewer features (the reply checks alone, plus the N
  most useful concepts, or the concepts alone) and writes
  `weights-prune-<name>.json` for each to `--out-dir` (`data/` by default).

The position value:

- `owngames.ts` turns a cutechess PGN of the engine's own games into games in
  `testset.ts`'s format, scoring the positions where the engine is to move.
- `sfblunders.ts` labels every legal move of those positions with how far
  below the best Stockfish scores it at depths 1 and 2.
- `value.ts` fits a position value (955 features of the position after each
  move) to the depth-1 losses, and measures offline how often the engine's
  move is a depth-1 blunder with it.

To play and measure:

- `uci.ts --weights FILE [--book-plies 16] [--value FILE --value-mix 2]
  [--repetition 2]` plays a weights file over UCI, for cutechess; `--value`
  adds the position value, `--repetition` the rule against repeating when
  ahead. `--oracle-depth D` rules out the moves Stockfish's depth D calls
  blunders: a ceiling, not searchless.
- `analyze.ts` has Stockfish score every position of a match and puts each of
  the engine's blunders down to a cause; `--horizon` also finds the lowest
  depth at which Stockfish sees each blunder, whether its line then loses
  material, and what the opponent's reply in it is.
- `weights.ts` prints weight files side by side.
- `score.ts` is a small UCI client (and engine-human's move-matching scorer);
  `testset.ts` reads JSONL files (and extracts Maia's test games).

## Data

`data/` (not in git) holds `sf-train.jsonl` and `sf-valid.jsonl`, 152,312
October 2019 and 19,779 November 2019 positions from games between
1900-rated Lichess players (1900-1999), each labelled with Stockfish's move at
depth 10; `sf-own.jsonl` and `blunders-own.jsonl`, 67,006 positions from the
engine's own games against Maia-1900 with every legal move's depth-1 and
depth-2 loss; the weights files, `value.json`, and logs. The raw games were
deleted: to label more positions, run `games.ts` on the Lichess database files
for those months, then `sflabel.ts`.

## Results

Matches are against Maia-1900 (lc0, one node) with `match.js`'s cutechess
settings, the 8-move book and `--book-plies 16`, over 1,000 games with
`-srand 2`. A 300-game match with one seed can be off by ±50 Elo.

- `strength2` (91 features: the concepts plus the reply checks, net swing
  version): picks Stockfish's move 32.9 % of the time; −208 ± 20 Elo, about
  1550.

Where the games are lost (`analyze.ts`, Stockfish depth 10 on every
position): about 11 % of the engine's moves lose 150+ centipawns. 87–88 % of
the centipawns lost are moves where Stockfish played a quiet move and the
static checks see no material difference between the two (middlegame 45 %,
opening 22 %, endgame 20 %); captures it missed or got wrong 8–9 %, checks
3–4 %; blunders the static checks saw (allowing mate in one, netting 3+ pawns
worse) about 1 %. The material checks have done their job; what is missing is
judgement of quiet moves and tactics more than one move deep.

How deep is that? `analyze.ts --horizon` on the 1,000 games of
`engine-searchless.ts` against Maia-1900 (3,585 blunders): for each, the
lowest Stockfish depth, searched from an empty hash, at which the move played
scores 150+ below the best. Depth 1 is one ply plus Stockfish's capture
search, judged by its evaluation. Shares of the centipawns lost:

- depth 1: 53 % (24 % material lost in Stockfish's line, 29 % no material:
  positional, 1 % mate)
- depth 2: 13 % (4 % material, 7 % positional, 2 % mate)
- depth 3-4: 17 % (7 % material, 9 % positional, 1 % mate)
- depth 5-10: 11 %; deeper than 10: 5 %
- overall: 42 % material, 54 % positional, 4 % mate

Most of the losses are shallow. In 38 of the 42 % that lose material, the
static net check rates the move no worse than Stockfish's: it is blind to
them, not outvoted. Half of the loss (depth 1) is within reach of a static
judgement that sees what one ply and the captures after it do: exchanges on
more than one square, overloaded and pinned defenders, and positional
judgement of the position after the move. Two thirds is by depth 2.

Settling the exchanges of the whole board (`exchange.ts`, since removed): the captures after a
move play out one at a time, each side making its legal capture with the best
SEE or stopping when none wins anything — one line, not a tree. It sees
overloaded defenders, pinned recapturers and a capture answered elsewhere.
It rates our move worse than Stockfish's in only 16 % of the centipawns of
the material losses the net check is blind to (24 % of those Stockfish sees at
depth 1). The rest come from what Stockfish's depth 1 adds to captures:
checks (a capture with check, then another capture; a quiet check that
skewers), promotions and passed pawns, and recaptures that lose to a mate
threat. As 7 more features (the settled net in bands, and how far behind the
best move's), trained on 61,191 positions: 33.3 % (loss 2.242, against 2.280),
but −210 ± 20 Elo, the same as `strength2`.

Retraining on its own positions (dataset aggregation, "DAgger";
`owngames.ts`): 2,000 games of `engine-searchless.ts` against Maia-1900 on
other opening seeds gave 67,006 positions with the engine to move, labelled
like the others (Stockfish depth 10). Trained on them and the 152,312 human
positions together: 32.7 % on the human validation positions, −214 ± 20 Elo,
no change. The positions it learns from are not the limit either.

Tuning the 50 weights on match results (`tune.ts`, since removed; SPSA): 80 rounds, each
moving every weight by ±c (0.3, shrinking to 0.19) at random and playing both
versions against Maia-1900 on 120 fresh openings (240 games each; 38,400 games
in 45 minutes). Over 1,000 games on each of two opening seeds the tuned
weights scored −229 ± 20 (seed 2; the starting weights −214 ± 19) and
−222 ± 19 (seed 3; the starting weights −228 ± 20): 21.5 % against 21.9 % over
the 2,000 games, no gain. Weighting these features differently does not make
the engine stronger; what they can see is the limit.

A ceiling, measured with Stockfish as an oracle (`uci.ts --oracle-depth`, not
searchless): before each move Stockfish scores every legal move to depth D
from an empty hash, the moves 150+ centipawns below its best are ruled out, and
the 50 weights choose among the rest. 1,000 games each against Maia-1900
(seed 2; the engine alone −214): depth 1 −29 ± 18, depth 2 +67 ± 18, depth 3
+143 ± 19, depth 5 +202 ± 20. Ruling out only the blunders whose Stockfish
line loses material, or only the others: depth 1 −154 and −178, depth 2 −134
and −151 — far less than both together, as the engine slips from one kind into
the other. The engine chooses well among sound moves; its losses come from the
few moves a short look rules out.

Static vetoes, measured offline: `sfblunders.ts` labelled every legal move of
67,006 positions from the engine's own games with its loss at depths 1 and 2.
`veto.ts` (since removed) measured how often the engine's move is a depth-1 blunder on the
held-out fifth (15.1 %; each point is roughly 12 Elo by the oracle). A logistic
veto on the strength features: 14.8–15.2 %. Ruling out the moves whose settled
or forcing-line net (`exchange.ts`; the forcing line also plays checks and
promotions) is 1–6 pawns behind the best move's: 15.3–17.6 %, worse — when
they say a move loses material, the alternatives are often worse still.

A learned position value (`value.ts`): 955 features of the position after each
move, fitted to the depth-1 losses (the value differences within a position
against the loss differences): piece-square tables, pieces en prise, the
opponent's number of replies, king zones and pawn shields, passed pawns, and
classical terms generated per side — each piece type attacked by each kind of
attacker, hanging, pinned or nearly trapped; safe mobility; king zone attacks
and safe checks; pawn structure; free passed pawns; rooks; outposts. Alone it
leaves 14.8 % blunders; added (×2) to the 50 weights' scores, 12.3 %. In play,
4 seeds × 1,000 games: 23.3 % against 21.7 %, **+17 ± 8 Elo** (−207), the first
static change that helps. 879 of its weights are non-zero, 929 with the 50.
Without the piece-square tables: 12.9 %; fitted jointly with the move
features: 12.9 % alone; with a softmax objective: 12.8–14.2 %; with 34 more
static tactical terms (loose pieces, enemy pieces attacking two of ours,
x-rays at the king and queen, overloaded and trapped pieces, king escape
squares, back rank, pawn-push threats, unstoppable passed pawns, rooks behind
passers, queen next to the king, checks that also attack): 12.4 %. None kept.

Draws by repetition: of the 324 draws in 1,000 games against Maia-1900, 240
were repetitions, 69 of them with the engine 2+ pawns ahead in material.
`uci.ts --repetition 2` makes a move that draws by rule (repeats a position, or
the fifty-move rule, or too little material) lose 5 when the engine is 2+ pawns
ahead and gain 5 when it is 2+ behind. With the value: repetitions while ahead
fell to 14 and those while behind rose from 97 to 131; over 4 seeds × 1,000
games 24.9 % against 23.3 %, **+15 ± 8 Elo more: −192**, about 1,565 on the
ladder's scale and 31 Elo above the 50 weights alone.

A shallower teacher: the 91 weights trained on the engine's own positions
labelled with Stockfish's depth-1 or depth-2 move, which the static features
predict far better (41 % and 37 % of the training positions), play far worse:
−360 and −262 (seeds 2 and 3), −269 and −239 with the value. Stockfish's
shallow choices are easier to learn and worse to play; the depth-10 labels
stay.

How few features does it need? `prune.ts` refits the `strength` set on the
same positions, ranking the concepts by how much the validation loss rises
when each weight alone is zeroed (most useful: gives check, castles kingside,
pawn to rank 4 and 5, capture wins 1-2, piece advances, capture wins 3+, even
capture, develops a minor piece, creates a new target):

- reply checks alone, 10 features: 28.0 %, −288 ± 20 Elo (about 1465)
- plus the 5 most useful concepts, 15 features: 30.2 %, −268 ± 20
- plus 10, 20 features: 30.9 %, −254 ± 19
- plus 20, 30 features: 31.8 %, −239 ± 20
- plus 40, 50 features: 32.3 %, −214 ± 19 (`engine-searchless.ts`)
- all 91 (refit): 32.9 %, −208 ± 20
- the 81 concepts without the reply checks: 31.8 %, −297 ± 24

The 50-feature set plays as well as the whole set. The 10 reply checks alone
come within about 80 Elo of it; the concepts without them are the weakest of
all.

Against other opponents (the 95-feature `tactics` model below, which plays like
`strength2`): Maia-1100 −88 ± 17; P4wn at its default level (depth 3)
−93 ± 15; Toledo Nanochess at its website's setting −20 ± 13. Many of the
draws are threefold repetitions.

## Approaches

What decides this engine's strength is a minority of moves that a short look
would rule out: Stockfish's depth 1 sees half of what the engine loses, and
ruling out only the blunders it sees at depth 2 would beat Maia-1900 (+67).
Predicting Stockfish's move better never made the engine stronger by itself;
seeing more of those blunders, statically, did — a little.

### Tried and kept

- Move features: 81 named concepts plus 10 static reply checks (the net swing
  after the opponent's best capture, mate in one), weights fitted to
  Stockfish's depth-10 moves in 1900-rated games: −208. Pruned to 50 features:
  −214, `engine-searchless.ts`.
- The book's ply (`--book-plies 16`, `Book_Plies`), so opening concepts know
  how far into the game the position is.
- A learned position value (`value.ts`, 955 features, 879 non-zero), fitted to
  Stockfish's depth-1 losses on the engine's own positions, added twice to the
  move scores: +17 ± 8.
- The repetition rule (`--repetition 2`): +15 ± 8 more, −192.
- Measuring: the loss analysis and horizon (`analyze.ts`), and the oracle
  ceiling (`uci.ts --oracle-depth`).

### Tried and dropped

Measured, then removed (the code is in no commit unless said):

- Reply checks as absolute material bands: an even trade looked like a 3-pawn
  loss; −237 ± 36 (300 games).
- A hand veto of moves that allow mate in one or net 3+ pawns worse than the
  best: −278 with the bands, no change with the net swing.
- Classical evaluation terms as the change each move makes (`positional`
  −216, `pawns` −222, `tactics` −203; `endgame` written, never run): better
  prediction, no strength.
- Cost-weighted training (every move's Stockfish cost, MultiPV): −205.
- engine-human's features (square tables, the 2-ply search's loss bands):
  never used here, and the search bands are not searchless.
- Settling the exchanges of the whole board (`exchange.ts`): caught 16 % of
  the material losses the net check misses; as features −210.
- Retraining on the engine's own positions (dataset aggregation;
  `owngames.ts` stays, for the value): −214.
- Tuning the 50 weights on match results (SPSA, 38,400 games): no gain.
- A shallower teacher (Stockfish's depth-1 or depth-2 move as the label):
  −360 and −262.
- Vetoes measured offline: a logistic veto on the move features (no change),
  ruling out moves by settled or forcing-line material (worse).
- Value variants: without piece-square tables, fitted jointly with the move
  features, with a softmax objective, with 34 more static tactical terms —
  none better offline than the value kept.

### Not tried

Within the rules (no search, no neural network, under 1,000 features):

- Grammar-of-features discovery with automatic selection: generate thousands
  of relational terms from a small grammar and keep the 50–100 that cut
  blunders most (only hand-chosen term families were tried).
- The value and the repetition rule built into the single-file
  `engine-searchless.ts`, which still has only the 50 weights.
- Tuning the value mix (2, chosen offline) and the repetition margin and bias
  in play.
- More data for the value: own games of the improved engine, and the human
  positions labelled with `sfblunders.ts`.
- One phase of piece-square tables instead of two, to free about 350 of the
  1,000 features for other terms.
- The forcing line (captures, checks, promotions) as value features rather
  than a veto; mate threats beyond mate in one.
- Plans as distances: shortest routes of each piece to outposts, weak pawns,
  the king zone and promotion squares.
- Small endgame tables: king and pawn against king, the rule of the square,
  rook-endgame recipes.
- Pairs of existing features as features (conjunctions, as in Othello's
  Logistello).
- Playing on Maia's habits: preferring positions where Maia-1900 tends to
  blunder.

Outside the rules: a small neural network, or more than 1,000 features (the
value is at 929 with the move weights); and any search — the oracle says
two plies would be enough to beat Maia-1900.