# Pedagog

<img src="logo.png" alt="Pedagog logo" width="160" height="160">

Pedagog is a small, educational chess engine written in JavaScript. It speaks
UCI and runs under Bun or in the browser. The offline-friendly web app supports
human-vs-bot and bot-vs-bot play, standard chess and Chess960, and a built-in
opening book.

[Play Pedagog in your browser](https://oge.nnadi.org/64/pedagog/).

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

## Engine features

Pedagog deliberately favors readable code over maximum strength.

| Area | Implementation |
|---|---|
| Board representation | 0x88 mailbox, not bitboards; moves packed into 32-bit integers. |
| Move generation | Pseudo-legal moves, with legality checked by make/unmake; standard chess and Chess960. |
| Search | Single-threaded negamax alpha-beta with iterative deepening and captures-first move ordering. |
| Evaluation | Material and formula-based piece-square tables, tapered between middlegame and endgame; recomputed at each leaf. |
| Position hashing | Zobrist hashing for repetition detection and deterministic skill-level variation, not a transposition table. |
| Playing strength | Ten skill levels, with depth limits, deliberate misjudgments, and reduced move vision below full strength. |

**Deliberately omitted:** transposition tables, principal variation search
(PVS), aspiration windows, null-move and reverse-futility pruning, late move
reductions (LMR), killer and history heuristics, check extensions, quiescence
search, delta pruning, MVV-LVA capture ranking, and incremental evaluation.
The evaluation uses neither PeSTO tables nor a neural network. These choices
keep the engine small and educational; see the
[COLOPHON](COLOPHON.md#what-was-deliberately-left-out) for the historical
measurements behind the search simplifications.

The browser app supplies an opening book; the standalone engine has none.

## UCI options

Send `uci` to list the engine's options, and configure them with
`setoption name <option> value <value>`.

| Option | Default | Allowed values | Effect |
|---|---|---|---|
| `Hash` | `16` | `1`–`1024` | Accepted for GUI compatibility, but ignored: there is no transposition table. |
| `Threads` | `1` | `1` | Accepted for GUI compatibility; the engine is always single-threaded. |
| `UCI_Chess960` | `false` | `true`, `false` | Enables Chess960 castling notation (king moves to the rook's square). Supply the starting position with `position fen`. |
| `Skill_Level` | `10` | `1`–`10` | Sets playing strength: 1 picks a random legal move (taking mate in one when available), 2–9 use progressively stronger weakened play, and 10 is full strength. |
| `Skill_Seed` | `0` | `0`–`2147483647` | Selects a deterministic weakened opponent; 0 uses the built-in seed. Has no effect at full strength. |

For example, after starting the engine with `bun run start`, send:

```text
uci
setoption name Skill_Level value 5
setoption name Skill_Seed value 42
isready
position startpos
go movetime 1000
```

## Calibration and analysis

See [`tools/README.md`](tools/README.md) for match setup and analysis commands,
the [calibration archive](docs/calibration-baseline/README.md) for reproducing
the published Elo fit, and [`COLOPHON.md`](COLOPHON.md) for the measurement
method and interpretation.

## Licensing

Original Pedagog-authored material is dedicated to the public domain under
CC0 1.0. This does not relicense dependencies: the combined web app and
single-file build include GPL-3.0-or-later chessground; the remaining vendors
retain their MIT and BSD-2-Clause terms. See [`LICENSE`](LICENSE) and
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) before redistributing a
combined web build.
