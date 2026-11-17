# Calibration and analysis

Run the commands below from the repository root.

Match tools require Bun. `src/tools/match.js` wraps
[cutechess-cli](https://github.com/cutechess/cutechess), and Maia matches also
require `lc0` plus Maia network files. `src/tools/blunders.py` and the variants' style
checkers (`src/variants/engine-aggressive/style.py`,
`src/variants/engine-constrictor/style-constrictor.py`) need `python-chess`;
`src/tools/plot.py` needs Matplotlib. Set executable
locations using `CUTECHESS_CLI`, `LC0`, `MAIA_DIR`, and `STOCKFISH`, or pass
paths on the command line where supported. Maia weights default to
`src/tools/models/`.

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
`bun run match prev:L10 L10 20 --previous-engine path/to/old/engine.ts
--time 1 --seed 42 --tag old-vs-current-20261009`.

Every match writes a PGN and a same-tag JSON metadata file under `src/tools/out/`.
Metadata records the wrapper invocation and exact cutechess argument vector,
result, seed, opening-book hash, engine/tool/runtime hashes, Git revision/dirty
status, runtime, and available CPU concurrency. Opening selection uses
cutechess's seeded random order (`-srand`); use `--concurrency 1` when
repeatable scheduling matters. Outputs are never replaced unless `--force`
is explicitly supplied; use a new tag for each run. Match summaries are no
longer appended to a shared history file.

## Analyzing results

`src/variants/engine-aggressive/style.py` summarises how each player in a set of PGNs plays: an
aggression score (3 × knowing sacrifices + checks, per 100 moves), sacrifices
versus blunders, checks, how close its pieces stand to the enemy king, material
imbalance, evaluation swings, score and game length:

```sh
python src/variants/engine-aggressive/style.py src/tools/out/l5-vs-r5.pgn
```

For a draft comparison of space-taking and constriction, use
`python src/variants/engine-constrictor/style-constrictor.py --json src/tools/out/constrictor.json match.pgn`.
It reports enemy-half squares attacked outside enemy pawn control, the space
edge over the opponent, the opponent's pseudo-legal mobility, and pawn advance.
It samples positions after each player's own moves with at least 20 pieces.
The numbers are uncalibrated proxies, not a style classification: compare
against a baseline with similar opponents, openings, and game lengths.

Fit Elo only against an explicitly chosen PGN set. The tool intentionally does
not glob all historical matches:

```sh
bun src/tools/elo.js --anchor maia-1900=1755 --json src/tools/out/elo-preview.json \
  src/tools/out/r10/r10-L2-vs-maia-1100.pgn src/tools/out/r10/r10-L3-vs-L2.pgn
python src/tools/blunders.py --out src/tools/out/blunders-preview.json \
  src/tools/out/r10/r10-L2-vs-L1.pgn
python src/variants/engine-aggressive/style.py --json src/tools/out/style-preview.json \
  src/tools/out/r10/r10-L5-vs-R5.pgn
python src/tools/plot.py --elo src/tools/out/elo-preview.json --style src/tools/out/style-preview.json \
  --out src/tools/out/skill-curve-preview.png
```

The round-10 calibration archive (the PGNs behind the published figures, played by
the engine of commit `bebea84`, which has changed since) is only in Git history:
`git show 3d87460:docs/calibration-baseline/README.md`. See
[`COLOPHON.md`](../docs/COLOPHON.md) for the measurement method and interpretation.

## Comparing UCI output

`src/tools/uci-diff.js` feeds the same UCI scripts (perft, searches at every
skill level and style, Chess960, bench) to `engine.ts` and to another engine,
and compares the output line by line, ignoring timing. Use it to check a port,
or that a refactor plays exactly as before:

```sh
bun run diff bun path/to/old/engine.ts
bun run diff java -jar ports/kotlin/engine.jar
```

It prints `ALL 38 IDENTICAL` and exits 0 when everything matches.
