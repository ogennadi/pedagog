# Calibration and analysis

Run the commands below from the repository root.

Match tools require Bun. `tools/match.js` wraps
[cutechess-cli](https://github.com/cutechess/cutechess), and Maia matches also
require `lc0` plus Maia network files. `tools/blunders.py` and `tools/style.py`
need `python-chess`; `tools/plot.py` needs Matplotlib. Set executable
locations using `CUTECHESS_CLI`, `LC0`, `MAIA_DIR`, and `STOCKFISH`, or pass
paths on the command line where supported. Maia weights default to
`tools/models/`.

## Running matches

```sh
bun run match L10 L10 2 --time 0.02 --seed 42 --concurrency 1 --tag release-smoke-20261009
bun run match L7 maia-1900 20 --seed 42 --tag l7-vs-maia-r1
bun run match L5 R5 300 --tag l5-vs-r5
```

The first command is a short plumbing smoke test, not a strength measurement.
`L1`..`L10` play Pedagog's default aggressive style; `R1`..`R10` play the
plain reference style (`Aggressive=false`) at the same level. Every level is
depth-limited and played without a clock, as the browser app plays it, so
results do not depend on machine load. `--time 1` instead imposes
cutechess's fixed per-move `st=1` limit, and `L10@3` caps the search at
depth 3 (a level's own depth ceiling still applies, so a cap above it does nothing). `--engine PATH` chooses the
current source. Compare an earlier engine explicitly with e.g.
`bun run match prev:L10 L10 20 --previous-engine path/to/old/engine.js
--time 1 --seed 42 --tag old-vs-current-20261009`.

Every match writes a PGN and a same-tag JSON metadata file under `tools/out/`.
Metadata records the wrapper invocation and exact cutechess argument vector,
result, seed, opening-book hash, engine/tool/runtime hashes, Git revision/dirty
status, runtime, and available CPU concurrency. Opening selection uses
cutechess's seeded random order (`-srand`); use `--concurrency 1` when
repeatable scheduling matters. Outputs are never replaced unless `--force`
is explicitly supplied; use a new tag for each run. Match summaries are no
longer appended to a shared history file.

## Analyzing results

`tools/style.py` summarises how each player in a set of PGNs plays: an
aggression score (3 × knowing sacrifices + checks, per 100 moves), sacrifices
versus blunders, checks, how close its pieces stand to the enemy king, material
imbalance, evaluation swings, score and game length:

```sh
python tools/style.py tools/out/l5-vs-r5.pgn
```

Fit Elo only against an explicitly chosen PGN set. The tool intentionally does
not glob all historical matches:

```sh
bun tools/elo.js --anchor maia-1900=1755 --json tools/out/elo-preview.json \
  tools/out/r10/r10-L2-vs-maia-1100.pgn tools/out/r10/r10-L3-vs-L2.pgn
python tools/blunders.py --out tools/out/blunders-preview.json \
  tools/out/r10/r10-L2-vs-L1.pgn
python tools/style.py --json tools/out/style-preview.json tools/out/r10/r10-L5-vs-R5.pgn
python tools/plot.py --elo tools/out/elo-preview.json --style tools/out/style-preview.json \
  --out tools/out/skill-curve-preview.png
```

For the published Elo dataset and reproduction instructions, see the
[calibration archive](../docs/calibration-baseline/README.md). See
[`COLOPHON.md`](../docs/COLOPHON.md) for the measurement method and interpretation.
