# engine-searchless

A variant of Pedagog that plays without searching and tries to be strong, not
human-like: the target is to beat Maia-1900. It depends only on `engine.ts`
and `src/tools/engine-js.js`; its tools and data are its own.

"Searchless" means no game tree: every legal move is scored on its own with a
weighted sum of features, and the best is played. The features may use static
calculations — static exchange evaluation (SEE), and one pass over the
opponent's captures and mates after the move — but no minimax and no
recursion.

The result is `engine-searchless.ts`: about 1550 on the ladder's scale (Maia-1900
is 1755), with 50 learned weights. Static features stopped adding strength
there; see Dead ends.

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

The pipeline, in order:

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
  `data/weights-prune-<name>.json` for each.

And to measure:

- `uci.ts --weights FILE [--book-plies 16]` plays any weights file over UCI,
  for cutechess.
- `analyze.ts` has Stockfish score every position of a match and puts each of
  the engine's blunders down to a cause.
- `weights.ts` prints weight files side by side.
- `score.ts` is a small UCI client (and engine-human's move-matching scorer);
  `testset.ts` reads JSONL files (and extracts Maia's test games).

## Data

`data/` (not in git) holds `sf-train.jsonl` and `sf-valid.jsonl`, 152,312
October 2019 and 19,779 November 2019 positions from games between
1900-rated Lichess players (1900-1999), each labelled with Stockfish's move at depth 10;
the weights files; and the pruning logs. The raw games they were sampled from
(about 500 MB) were deleted: to label more positions, run `games.ts` on the
Lichess database files for those months, then `sflabel.ts`.

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

## Dead ends

Tried, measured and removed (the code is in no commit); each played no
better than `strength2`.

- **Reply checks as absolute bands** (the first `strength`): the material
  after the opponent's best capture, in bands. An even trade looked like a
  3-pawn loss. 32.4 %, −237 ± 36 in 300 games. Replaced by the net swing.
- **A veto** (`uci.ts --veto`): never play a move that allows mate in one or
  nets 3+ pawns worse than the best move, unless every move does. With the
  absolute bands it threw out good trades (−278 ± 40); with the net swing it
  changed nothing (−225 ± 37 against −228 ± 38).
- **Classical evaluation terms, as the change each move makes**, written here
  rather than copied from an engine:
  - `positional`: 15 king-safety and piece-activity terms (shelter, attackers
    and open files near each king, mobility, loose and trapped pieces, rooks
    on the 7th, connected rooks, pawns on our bishops' colour), each an "up"
    and a "down" feature per unit of change. 33.8 %; −216 ± 20.
  - `pawns`: plus isolated, doubled, backward, passed and protected pawns and
    pawn islands for both sides. 34.0 %; −222 ± 20.
  - `tactics`: the strength features plus next-move fork threats for both
    sides, judged statically. 33.1 %; −203 ± 19.
  - `endgame`: king activity and pawn-race terms; written, never run.

  They predict Stockfish's move a little better but do not play better: the
  quiet moves that lose games need more than one-move static terms.
- **Cost-weighted training** (`sfcost.ts`): Stockfish (depth 8, MultiPV 256)
  scored every legal move of 30,207 positions, and training aimed at every
  move weighted e^(−cost / 50) instead of only Stockfish's. With the `tactics`
  features the chosen move cost 95.2 centipawns on average against 96.6, and
  −205 ± 19: the training target was not the limit, the features were.
- **engine-human's features**, copied in at the start and never used here:
  the square tables (piece type × square × phase) and the 2-ply search's LOSS
  bands, which are not searchless.

What could go further is a much larger learned evaluation — piece-on-square
features of the position after each move, or a small neural network —
trained on the same labels.