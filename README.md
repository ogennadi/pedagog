# Pedagog

Pedagog is a small, educational chess engine written in JavaScript. It speaks
UCI and runs under Bun or in the browser. The offline-friendly web app supports
human-vs-bot and bot-vs-bot play, standard chess and Chess960, and a built-in
opening book.

## Run and build

Install [Bun](https://bun.sh/) (no npm packages are required), then from the
repository root:

```sh
bun run start                 # UCI engine; interact through stdin/stdout
bun run bench                 # built-in engine benchmark
bun run perft                 # built-in perft command
bun test                      # retained rules and perft tests
bun run web                   # http://localhost:8080
bun run bundle                # creates pedagog-app.html
```

The multi-file app is served from `index.html` by `bun run web`; the bundled
`pedagog-app.html` can be opened directly from disk. The bundle is generated
and ignored by Git. The engine itself is `pedagog.js`.

### Release build

Run `bun test` and `bun run bundle` before publishing. Attach the generated
`pedagog-app.html` only with the matching source and license materials; the
bundle embeds the third-party license texts, and the combined app includes
GPL-3.0-or-later chessground. Do not commit the generated HTML as source.

## Calibration and analysis

Match tools require Bun. `tools/match.js` wraps
[cutechess-cli](https://github.com/cutechess/cutechess), and Maia matches also
require `lc0` plus Maia network files. `tools/blunders.py` needs
`python-chess`; `tools/plot.py` needs Matplotlib. Set executable locations
using `CUTECHESS_CLI`, `LC0`, `MAIA_DIR`, and `STOCKFISH`, or pass paths on the
command line where supported. Maia weights default to `tools/models/`.

```sh
bun run match L10 L10 2 --time 0.02 --seed 42 --concurrency 1 --tag release-smoke-20261009
bun run match L7 maia-1900 20 --seed 42 --tag l7-vs-maia-r1
```

The first command is a short plumbing smoke test, not a strength measurement.
`--time 1` uses cutechess's fixed per-move `st=1` limit for Pedagog, matching
the browser's full-strength one-second move budget; without it L10 uses
10+0.1 and lower levels use the existing infinite-clock/depth-limited setup.
`L10@6` remains available for fixed-depth tests. `--engine PATH` chooses the
current source. Compare an earlier engine explicitly with e.g.
`bun run match prev:L10 L10 20 --previous-engine path/to/old/pedagog.js
--time 1 --seed 42 --tag old-vs-current-20261009`.

Every match writes a PGN and a same-tag JSON metadata file under `tools/out/`.
Metadata records the wrapper invocation and exact cutechess argument vector,
result, seed, opening-book hash, engine/tool/runtime hashes, Git revision/dirty
status, runtime, and available CPU concurrency. Opening selection uses
cutechess's seeded random order (`-srand`); use `--concurrency 1` when
repeatable scheduling matters. Outputs
are never replaced unless `--force` is explicitly supplied; use a new tag for
each run. Match summaries are no longer appended to a shared history file.

Fit Elo only against an explicitly chosen PGN set. The tool intentionally does
not glob all historical matches:

```sh
bun tools/elo.js --anchor maia-1900=1755 --json tools/out/elo-preview.json \
  tools/out/r9-L2-vs-maia-1900.pgn tools/out/r9-L3-vs-maia-1900.pgn
python tools/blunders.py --out tools/out/blunders-preview.json \
  tools/out/r9-L2-vs-L1.pgn
python tools/plot.py --elo tools/out/elo-preview.json --blunders tools/out/blunders-preview.json \
  --out tools/out/skill-curve-preview.png
```

The published Elo ratings use exactly the 30 round-9 PGNs archived in
[`docs/calibration-baseline/`](docs/calibration-baseline/). Extract those files
and pass them explicitly to reproduce the fit; the archive manifest lists
every input hash and the dataset's 8,900 games. The plot also includes
`docs/blunders.json`, which does not record its source PGN list, so this archive
is not asserted to reproduce those blunder-rate values. Historical tuning PGNs
are not mixed into the published Elo baseline. See
[`COLOPHON.md`](COLOPHON.md) for the measurement method and interpretation.

## Licensing

Original Pedagog-authored material is dedicated to the public domain under
CC0 1.0. This does not relicense dependencies: the combined web app and
single-file build include GPL-3.0-or-later chessground; the remaining vendors
retain their MIT and BSD-2-Clause terms. See [`LICENSE`](LICENSE) and
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) before redistributing a
combined web build.
