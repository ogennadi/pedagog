# Pedagog

<img src="docs/logo.png" alt="Pedagog logo" width="160" height="160">

**The engine is one file, [`engine.js`](engine.js): read it top to bottom.**

Pedagog is a small, educational chess engine written in JavaScript. It speaks
UCI and runs under Bun or in the browser. By default it plays an attacking
style: its pieces crowd the enemy king, it gives up material for the attack,
and it likes to give check. A plain reference style, at the same strength per
level, is one option away. The offline-friendly web app supports human-vs-bot
and bot-vs-bot play, standard chess and Chess960, and a built-in opening book.

[Play Pedagog in your browser](https://oge.nnadi.org/64/pedagog/).

## Run and build

Install [Bun](https://bun.sh/) (no npm packages are required), then from the
repository root:

```sh
bun run start                 # UCI engine; interact through stdin/stdout
bun run bench                 # built-in engine benchmark
bun run perft                 # built-in perft command
bun test                      # rules, perft and basic search/UCI tests
bun run web                   # http://localhost:8080
bun run build                 # creates dist/, the deployable web app
bun run bundle                # creates dist/pedagog-app.html
```

The repository is laid out as:

- `engine.js` — the engine, the only code at the top level.
- `web/` — the web app (`index.html`, its scripts and styles, the service
  worker, vendored libraries).
- `tests/` — `bun test`; `tools/` — match runner, Elo fit, style statistics,
  plots, server, build; `docs/` — the COLOPHON (how it was made and measured),
  calibration data and figures.

`bun run web` serves `web/` with the engine beside it, the same layout
`bun run build` writes to `dist/`: deploy the contents of `dist/` as the site
root. The bundled `dist/pedagog-app.html` can be opened directly from disk.
Both are generated and ignored by Git.

### Release build

Run `bun test`, `bun run build` and `bun run bundle` before publishing. Attach
the generated `pedagog-app.html` only with the matching source and license materials; the
bundle embeds the third-party license texts, and the combined app includes
GPL-3.0-or-later chessground. Do not commit the generated HTML as source.

## Engine features

Pedagog deliberately favors readable code over maximum strength. Each
function takes what it needs as arguments and returns what it finds, so it can
be read on its own. Positions are never changed: `makeMove` returns a new one.

| Area | Implementation |
|---|---|
| Board representation | 0x88 mailbox, not bitboards; moves packed into 32-bit integers. |
| Move generation | Pseudo-legal moves, with legality checked by making each move (copy/make); standard chess and Chess960. |
| Search | Single-threaded negamax alpha-beta with iterative deepening; the previous iteration's best move first, then captures by MVV-LVA; a quiescence search of at most four captures past each leaf. |
| Evaluation | Material and formula-based piece-square tables, tapered between middlegame and endgame; recomputed at each leaf. |
| Playing style | Aggressive (default): a bonus for pieces near the enemy king, middlegame material counted at a quarter of its value, and a root bonus for checking moves. Plain: none of these. |
| Position hashing | Zobrist hashing for repetition detection and deterministic skill-level variation, not a transposition table. |
| Playing strength | Ten skill levels, ~100 Elo apart up to about Maia-1900, each with a depth limit, deliberate misjudgments, and reduced move vision; each style has its own calibrated ladder. |

**Deliberately omitted:** transposition tables, principal variation search
(PVS), aspiration windows, null-move and reverse-futility pruning, late move
reductions (LMR), killer and history heuristics, check extensions, delta
pruning, and incremental evaluation.
The evaluation uses neither PeSTO tables nor a neural network. These choices
keep the engine small and educational; see the
[COLOPHON](docs/COLOPHON.md#what-was-deliberately-left-out) for the historical
measurements behind the search simplifications. Quiescence search and MVV-LVA,
once left out, are back: the aggressive style needs them to calculate its
sacrifices, and both styles use them.

The browser app supplies an opening book; the standalone engine has none. In
the app, choose **Pedagog** (aggressive), **Reference** (plain) or **Mystery**
(a hidden coin flip between the two) at any of the ten levels. After a Mystery
game, guess which style it was (or say you don't know); the answer is then
revealed and the verdict kept in a local log, so the style can be judged blind
over many games.

The gear at the top right opens the settings page: light or dark appearance, board
colours, and any of 35 Lichess piece sets, shown side by side on one page. The
single-file build keeps the default pieces.

## UCI options

Send `uci` to list the engine's options, and configure them with
`setoption name <option> value <value>`.

| Option | Default | Allowed values | Effect |
|---|---|---|---|
| `Hash` | `16` | `1`–`1024` | Accepted for GUI compatibility, but ignored: there is no transposition table. |
| `Threads` | `1` | `1` | Accepted for GUI compatibility; the engine is always single-threaded. |
| `UCI_Chess960` | `false` | `true`, `false` | Enables Chess960 castling notation (king moves to the rook's square). Supply the starting position with `position fen`. |
| `Skill_Level` | `10` | `1`–`10` | Sets playing strength: 1 picks a random legal move (taking mate in one when available); 2–10 are ~100 Elo apart, from about 945 to about Maia-1900 (1755) on the Lichess classical scale. Every level is depth-limited, so it plays the same on any machine and answers `go depth`/`go infinite` quickly. |
| `Skill_Seed` | `0` | `0`–`2147483647` | Selects a deterministic weakened opponent; 0 uses the built-in seed. |
| `Aggressive` | `true` | `true`, `false` | Chooses the playing style: attacking (`true`) or the plain reference style (`false`). Each has its own ladder, so a level is about equally strong in either. |

For example, after starting the engine with `bun run start`, send:

```text
uci
setoption name Skill_Level value 5
setoption name Skill_Seed value 42
setoption name Aggressive value true
isready
position startpos
go movetime 1000
```

## Calibration and analysis

See [`tools/README.md`](tools/README.md) for match setup and analysis commands,
the [calibration archive](docs/calibration-baseline/README.md) for reproducing
the published Elo fit, and [`COLOPHON.md`](docs/COLOPHON.md) for the measurement
method and interpretation.

## Licensing

Original Pedagog-authored material is dedicated to the public domain under
CC0 1.0. This does not relicense dependencies: the combined web app and
single-file build include GPL-3.0-or-later chessground; the remaining vendors
retain their MIT and BSD-2-Clause terms. See [`LICENSE`](LICENSE) and
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) before redistributing a
combined web build.
