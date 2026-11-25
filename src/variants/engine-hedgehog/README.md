# engine-hedgehog

A style variant from `../STYLE-IDEAS.md`: the hedgehog / hippo. It puts its pawns on its 3rd
rank, fianchettoes its bishops, keeps its pieces behind the pawns, and breaks with a pawn once
the opponent has overextended. First, how often the usual players already play like this; then
the engine, `engine-hedgehog.ts`, its tuning and its strength against Maia-1900.

## The style checker

`hedgehog_check.py` (python-chess) reads PGNs and gives, per player and colour, the share of
games showing each sign. "Move N" is the player's own Nth move, and ranks count from its side.

- **shell**: 4+ of its pawns on its 3rd rank after move 15 (the STYLE-IDEAS sign)
- **skeleton**: how many of its a, b, d, e, g and h pawns stand on its 3rd rank then (mean, 0-6)
- **fianchetto**: a bishop on b2 or g2 behind its pawn on b3 or g3 then; **double**: both
- **stays back**: none of its pawns reaches its 5th rank in moves 1-20
- **spring**: of the shell games, those where a pawn then steps from its 3rd rank to its 4th
  (the break, as ...b5 or ...d5) in moves 16-40
- **hedgehog**: shell, stays back and at least one fianchetto (the headline)

Games over before the player's 15th move are left out.

    python src/variants/engine-hedgehog/hedgehog_check.py <pgn> ...

## How often the usual players do it

The book's 8-move starts would decide the move-15 shape, so these games start from the initial
position (`match.js --book none`). Pedagog and Maia play the same moves each time, and
sf1550 (Stockfish at UCI_Elo 1550, equal to Maia-1900) varies the games. That gives about 100
different 6-ply starts per 200 games. Three matches of 200 games, 2026-11-25, with sf1550
counted over all 600:

- R10 (Pedagog, plain) vs sf1550: 84-107-9
- L10 (Pedagog, aggressive) vs sf1550: 83-102-15
- Maia-1900 vs sf1550: 120-73-7 (+83 Elo; with the book it was +6)

| Player | Games | Shell | Skeleton | Fianchetto | Double | Stays back | Spring | Hedgehog |
|---|---|---|---|---|---|---|---|---|
| R10 | 190 | 0 % | 0.64 | 2 % | 0 % | 18 % | - | 0 % |
| L10 | 192 | 0 % | 0.58 | 3 % | 0 % | 17 % | - | 0 % |
| Maia-1900 | 181 | 1.1 % | 1.06 | 18 % | 0 % | 8 % | 2 of 2 | 0 % |
| sf1550 | 565 | 3.5 % | 1.21 | 12 % | 0.2 % | 35 % | 80 % | 0.4 % |

As Black the shell is commoner (sf1550 5.0 %, Maia 2.1 %) than as White (2.1 %, 0 %). Maia's
fianchettoes are mostly as Black (32 %).

With the 8-move book (`r11/verify3`, 300 games), plain L10 showed the shell in 1.1 % of games
and Maia in 2.9 %. STYLE-IDEAS.md reports 1.3 % and 6.0 % for the same games, from a script
that was not kept, so the Maia figure cannot be checked.

- **The hedgehog is almost never played.** Pedagog never builds the shell, and the full
  hedgehog shows in 0 to 0.4 % of games for every player. A variant that does it in most
  games would be recognised from one game.
- **Stays back is common** (8 to 35 %) and does not separate the style alone; the shell and the
  double fianchetto do.

## The engine

`engine-hedgehog.ts` is `../engine-simplehuman/engine-simplehuman-2knob.ts` (commit e4acb54)
with one extra term at the search's leaves, `hedgehogBonus()`, counted only for the side the
engine plays (the side to move at the root), so it does not expect the opponent to play the
same way. Its weights are UCI spin options, in middlegame centipawns:

- `Hedgehog_Shell`: per own skeleton pawn (a, b, d, e, g, h file) on its 3rd rank
- `Hedgehog_Cap`: the most skeleton pawns that earn the shell bonus
- `Hedgehog_Fourth`: charged per own pawn on its 4th rank
- `Hedgehog_Advance`: charged per own pawn past its 4th rank, unless passed
- `Hedgehog_Fianchetto`: per bishop on b2/g2 with its pawn on b3/g3
- `Hedgehog_Fade`: the phase (24 = all pieces, 0 = none) at which the term is gone

The defaults are run H's weights (Shell 40, Cap 5, Advance 80, Fianchetto 20, Fourth 0, Fade 0).
The term is scaled by the phase like the middlegame tables. Bench: about 17 % fewer nodes per
second than 2-knob.

## Tuning

L10 vs sf1550, 100 games each from the initial position (`--book none`), 2026-11-25. The
reference is plain 2-knob L10 (depth 6), which never builds the shell. Stockfish's eval is at
depth 10, from Pedagog's side, median over the games.

| Run | Weights (others default) | Score | Elo | Shell | Fianchetto | Stays back | Hedgehog | SF eval, ply 24 |
|---|---|---|---|---|---|---|---|---|
| 2-knob | - | 54-43-3 | +38 | 0 % | 7 % | 31 % | 0 % | -69 |
| A | Shell 30, Advance 30, Fianchetto 20 | 39-57-4 | -63 | 80 % | 51 % | 46 % | 20 % | -233 |
| B | A, Advance 80 | 38-59-3 | -74 | 78 % | 55 % | 57 % | 26 % | |
| C | B, Shell 40 | 32-65-3 | -119 | 90 % | 53 % | 60 % | 29 % | |
| D | C, passed pawns exempt | 28-69-3 | -151 | 92 % | 55 % | 51 % | 30 % | -324 |
| E | D, Fade 12 | 25-72-3 | -177 | 93 % | 58 % | 55 % | 35 % | |
| F | E, Fianchetto 50, Fourth 20 | 28-70-2 | -156 | 95 % | 77 % | 54 % | 44 % | -300 |
| G | Shell 40, Cap 4, Advance 80 | 39-58-3 | -67 | 70 % | 56 % | 54 % | 25 % | -141 |
| H | Shell 40, Cap 5, Advance 80 | 47-52-1 | -17 | 80 % | 54 % | 62 % | 32 % | -194 |
| I | Shell 25, Cap 4, Advance 80 | 50-48-2 | +7 | 57 % | 57 % | 56 % | 30 % | -103 |

Runs A-F counted every pawn on its 3rd rank, on any file, with no cap; G-I only the skeleton
files, up to the cap. The Elo error is about +-70 per run.

- **The style shows at once.** Even A builds the shell in 80 % of games (2-knob: 0 %), and F is a
  full hedgehog in 44 %.
- **It costs 100 to 200 Elo, and the loss is in the opening.** Pedagog was up material at ply 40
  even in the games it lost, but Stockfish has it 150 to 300 cp down by ply 16-24 (2-knob: about
  -50). Most first fall below -200 by ply 20-24.
- **Root cause: pawn moves outbid development.** With 40 cp for every pawn on its 3rd rank, eight
  pawn moves are worth about 320 cp, against 12 to 36 for developing a piece. So it spends its
  first ten moves on pawns, including ...f6, ...c6, f3, h3 and a3, which open its king and block
  its knights, and leaves its pieces at home. Exempting passed pawns (D) and fading the term
  (E) treated the middlegame and made it worse.
- **Fix:** only the skeleton files earn the shell bonus, and only up to `Hedgehog_Cap` of them,
  so the c- and f-pawns stay at home and, once the shell stands, development pays again.
- **With the fix (G-I) most of the cost is gone.** I (Shell 25, Cap 4) scores 50 % against
  2-knob's 54 %, within the error, and is a full hedgehog in 30 % of games with the shell in 57 %.
  H (Shell 40, Cap 5) has more shell (80 %) for about 55 Elo less than 2-knob. G (Cap 4) scoring
  below H (Cap 5) is within the noise of 100-game runs; more games would tell them apart.

To play it: `bun src/tools/serve.js 8080 --engine src/variants/engine-hedgehog/engine-hedgehog.ts`,
then open `http://localhost:8080/?book=off`, so the bots open on their own rather than from the
app's book.

## Strength against Maia-1900

sf1550 punished the hedgehog's opening less than a human would, so the strength test is
against Maia-1900 (2026-11-25). Pedagog and Maia both play the same moves every time, so
`starts2.epd` gives variety while still leaving the opening to the players. It has 100 starts,
each fixing only the first move of each side: 1. e4/d4/c4/Nf3/g3/b3/e3/d3/c3/Nc3 by
e5/d5/c5/Nf6/e6/d6/c6/g6/b6/Nc6. Each start is played with both colours
(`match.js --book starts2.epd`, in order). All players are L10 at depth 6; only the style
differs.

To save time, the runs were stopped part-way and only H was finished: its unplayed starts
were replayed at higher concurrency. Each run is compared with 2-knob on the games both
played (same start, same colour), so the stopped runs are compared fairly.

| Run | Weights | Games | Score | 2-knob, same games | Difference (95 %) | Shell | Hedgehog |
|---|---|---|---|---|---|---|---|
| 2-knob | - | 151 | 37.1 % | - | - | 3 % | 0 % |
| H | Shell 40, Cap 5, Advance 80 | 200 | 43.5 % | 37.1 % (151) | +7.0 +- 10.1 % | 85 % | 41 % |
| I | Shell 25, Cap 4, Advance 80 | 119 | 44.5 % | 36.1 % | +8.4 +- 9.8 % | 65 % | 35 % |
| J | Shell 15, Cap 4, Advance 50 | 122 | 45.5 % | 36.9 % | +8.6 +- 10.7 % | 33 % | 10 % |

- **Against Maia the hedgehog costs nothing.** All three weightings score as well as plain
  2-knob or better (about +7 points, just within the noise), so the losses against sf1550 do
  not carry over to a human-like opponent. H keeps the most style: shell in 85 % of games,
  full hedgehog in 41 %.
- **It feels weak because 2-knob L10 is weak without a book.** When the players choose their
  own opening, plain 2-knob L10 scores only 37 % (about -90 Elo) against Maia-1900, against
  about 50 % with the 8-move book used to calibrate it. The style is not the cause.
- **It is slow because 2-knob L10 is a full 6-ply search** with no transposition table and
  only captures-first ordering: a median of about 2 s a move in the matches (90th percentile
  7.5 s, worst 50 s), the same as plain 2-knob. The main engine's L10 takes about 0.03 s.