# engine-human

Work on a variant of Pedagog that plays the move a human of a given rating
would play, with a hand-crafted evaluation (no neural network). Its data
tools, training scripts and engine live here, together.

Goal: move-matching accuracy close to Maia's (about 51–53 % in its own rating
bin), measured on Maia's published test set: `maia-chess-testing-set.csv.bz2`
from CSSLab, December 2019 Lichess games, 10,000 games in each of the nine
100-point bins from 1100 to 1900, Bullet and HyperBullet excluded, the first
10 ply and moves made with under 30 seconds left dropped (about 500,000
positions per bin). Train only on games from before December 2019, filtered
the same way.

For now, level 10 only. Level 10 is calibrated to Maia-1900, so it learns from
the 1900 bin and is scored on the test set's 1900 bin against Maia-1900 (lc0,
`nodes=1`) on the same positions. Training data: about 1 million games from the
1900 bin of 2019 Lichess months before December. The other levels and bins
come later.

## Tools

- `testset.ts` turns the CSV into `data/test-<bin>.jsonl`, one game per line.
  The CSV differs from the paper's description: it has bins 1000–2500 (about
  9,800 games each, plus 2,800 games between bins, dropped), and the clock for
  only 6 % of moves, so a move is dropped for time only when its `low_time`
  flag is set. The 1900 bin keeps 9,861 games and 620,454 scored moves (the
  paper: about 500,000).
- `score.ts` asks a UCI engine for its move at every scored position, with the
  moves that led there (Maia reads them), and reports accuracy with a 95 %
  interval from resampling games.
- `games.ts` extracts one bin's games from a Lichess `.pgn.zst` month, as the
  paper cut its training data. It reads about 57 MB/s of decompressed text
  (some 85 GB, 43 million games, per 2019 month): about 30 minutes a month.
  Decompression itself is not the cost (native zstd runs near 1 GB/s); the
  JavaScript work is: decoding and splitting lines, a regex on every header
  line, and replaying the kept games' SAN through the engine. A `.zst` file is
  one stream, so it cannot be split across threads. If this has to run again
  for more bins or months: test headers with plain string checks and skip the
  movetext of unwanted games unsplit, or prefilter with native tools
  (`zstd -dc` into `ripgrep` for the bin's Elo headers), or read in one
  process and convert moves in workers. Bun buffers its output into a pipe,
  so a log of a piped run appears only at the end.

First sample (100 games, 6,568 moves of the 1900 bin): Maia-1900 53.9 %
[52.4, 55.4], full-strength Stockfish at depth 15 41.7 % [40.3, 43.0], Pedagog
level 10 34.0 % [32.4, 35.5].

## Results

Run 1 (`train.ts`, 824 move features: piece type x origin and destination
square, captures, recapture, check, promotion, castling, en prise, rescue;
about 1 million October positions, 6 passes): 34.13 % of all 620,454 positions
of the test bin, **with no search at all** — the top-scoring legal move under
about 800 learned weights. That ties Pedagog level 10, which searches 4–5 plies
(34.0 % on the sample). Validation accuracy equalled training accuracy (33.5 %)
and stopped rising after two passes: the features, not the data, are the limit.

Worth pursuing on its own: a searchless engine (one weighted sum per legal
move, no tree) as strong as Maia-1900, itself a searchless network. Move
matching is not playing strength, so that needs games: play the weighted-sum
mover against Maia-1900 with `match.js`-style cutechess runs.

Run 2 (2,384 features: the square tables split by phase, plus THREAT, FORK,
DEFEND and LEAVE; same data): **36.78 %** of the test bin, +2.65 over run 1 and
now ahead of Pedagog level 10's search. Training and validation still agree
(36.3 %), so the features are still the limit. Leaving another piece en prise
weighs about as much against a move as hanging the moved piece (LEAVE Q −3.9,
HANG Q −6.8); threats and forks add about +0.5 to +1.5.
