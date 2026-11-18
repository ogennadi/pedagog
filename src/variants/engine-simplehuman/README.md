# engine-simplehuman

engine.ts with one skill knob instead of five. The brief: fewer knobs to tune, all of them acting
in one place, while level 10 keeps (or beats) engine.ts's move-matching score and stays about as
strong as Maia-1900; levels 2-9 only roughly spaced.

The one knob is **vision**: the chance, out of 1024, that the player notices a move. It is used
in one place, the move loops of the search (root, deeper plies and, where there is one, the
quiescence search), for both sides. A move it fails to notice is not tried. There are no
misjudged positions in the evaluation and no per-level depth. Choices come from the position's
key, the move and the seed, so blind spots are stable.

Two files, both based on engine.ts at commit 6ff3255:

- `engine-simplehuman.ts`: depth 3 for every level, then a quiescence search (captures only, in
  generated order, at most 4 plies). Captures and checks get a second chance to be noticed.
- `engine-simplehuman-noq.ts`: depth 5 for every level and engine.ts's own search (no
  quiescence). Captures get a second chance to be noticed; checks do not.

Two later experiments, built from the depth-5 version (see Tried 12-14):

- `engine-simplehuman-knobs.ts`: one vision per kind of move (check, capture, retreat, other),
  all in `seesMove()`; used only to screen settings at level 10.
- `engine-simplehuman-2knob.ts`: two knobs per level, depth and vision; checks are noticed at
  0.85 of the vision. **Much slower at the top**: level 10 searches 6 plies, 1.9-3.3 s a move in
  Bun where the depth-5 version takes 0.1-0.25 s (8-15 times slower), and 1000 games against
  Maia-1900 took about 45 minutes instead of about 12. Slower still in a browser.

| | engine.ts | simplehuman | simplehuman-noq |
|---|---|---|---|
| Code lines (no comments) | 1086 | 1078 | 1047 |
| Tuned numbers | 5 per level + 2 | 1 per level + depth + cap | 1 per level + depth |
| Level 10 move matching | 33.95 % | 36.18 % | 33.80 % |
| Level 10 vs Maia-1900 | -41 (300 g) | +14 ± 19 (1000 g) | +12 ± 20 (1000 g) |
| Bench nodes | 1.19 M | 155 k | 1.09 M |

Play either in the web app with
`bun src/tools/serve.js 8092 --engine src/variants/engine-simplehuman/engine-simplehuman.ts`.

## How it was measured

- **Move matching**: `src/variants/engine-human/score.ts --engine pedagog:10:<file> --bin 1900
  --games 100` (Maia's test set, 1900 bin, 100 games, 6,568 moves). Differences between engines
  are paired on the same moves, with a 95 % interval from resampling games. engine.ts level 10
  was re-measured at 33.95 % [32.42, 35.45] (the old `score-pedagog-10-1900.tsv` was a mislabelled
  copy of engine-human level 9).
- **Strength**: `src/tools/match.js` (cutechess, 8-move book, both colours) against Maia-1900
  (lc0, 1 node), whose rating is 1755 on the ladder's scale, and against engine.ts at the same
  level, read off that level's measured rating. Adjacent levels were also played against each
  other directly, each side with its own Skill_Seed (one seed would give both sides the same blind
  spots and widen the gap).
- **Blunders and strength**: `style-human.py` beside this file (`python
  src/variants/engine-simplehuman/style-human.py --anchor maia-1900=1755 match.pgn`). Per 100 of a
  player's moves: walking into a mate in one that another move avoided; missing its own mate in
  one (per chance); leaving a piece en prise, a net loss of 3+ by static exchange after its move;
  and hung material, 3+ down after the reply and still after the next move pair. Beside each, the
  rate of people at the player's rating (given, anchored, or its performance rating against the
  anchors), from Maia's test games; `--reference` measures that table afresh, and `--matching`
  adds a score.ts file's accuracy. Tests: `python -m unittest
  src/variants/engine-simplehuman/test_style_human.py`.
- **Mistakes in the same positions**: `style-human.py --positions` reads score.ts files
  instead of games. In every scored position it judges the move the person played and the move
  the engine chose alike, so no opponent or rating scale comes between them: allows and misses
  mate in one; blunders (Lichess's winning chances, from Stockfish at depth 12, fall by 0.3 or
  more); hangs material (a blunder leaving 3+ points en prise); misses free material (a capture
  winning 3+ points that Stockfish rates near-best was there, and the move was a blunder). Each
  rate beside people's, the factor between them, and "times off people" (the geometric mean of
  the factors, each turned to at least 1; 1 is people exactly), with 95 % intervals from
  resampling games and, with `--baseline`, paired differences. Stockfish's verdicts are cached
  beside the test set. The static checks alone (en prise, a free capture available) flagged
  Stockfish d15 as often as people, which is why the Stockfish verdict is required.
- match.js's JSON summary swaps two fields (`draws` holds the second player's wins, `secondWins`
  the draws), so results here are counted from the PGNs.

## Tried

1. **Depth alone, engine.ts's search** (level 10 at full vision): depth 3 / 4 / 5 match 30.36 /
   33.39 / 34.58 %. Depth 4 is weaker than Maia-1900 and matches less than engine.ts; depth 5 is
   +113 ± 38 against Maia-1900.
2. **A quiescence search** (captures, 4 plies): depth 1 / 2 / 3 / 4 match 31.97 / 35.49 / 37.06 /
   37.97 %. Depth 2 is -165 ± 39 against Maia-1900, depth 3 +91 ± 35. Resolving captures is what
   raises the matching score; a deeper search without it barely does.
3. **Vision as the only knob, depth 3 + quiescence** (`engine-simplehuman.ts`). Level 10's vision
   sweep (300 games each against Maia-1900): 1024 +91, 1000 +54, 976 +42, 952 -44, 928 -86;
   matching 37.06 / 36.75 / 36.65 / 36.11 / 35.49 %. Vision 953 gives +14 ± 19 over 1000 games
   and 36.18 %, +2.22 points [+0.93, +3.49] over engine.ts. Levels 2-9 were placed by fitting
   rating against vision (quadratic) and inverting, in three rounds; they land within about 50
   Elo of engine.ts's targets.
4. **No MVV-LVA in the quiescence search**: the same moves at levels 2, 6 and 10, and the same 1000
   games against Maia-1900, for 44 % more nodes. Without the 4-ply cap as well, one middlegame
   move cost 126 times the nodes, so the cap stays.
5. **No quiescence, depth 5 + vision** (`engine-simplehuman-noq.ts`). Level 10's sweep: 1024
   +113, 990 +68, 960 +28, 930 -22; matching 34.58 / 34.47 / 33.95 / 33.40 %. Vision 950: +29 ±
   20 and 33.83 %, -0.12 points [-0.87, +0.69] against engine.ts: as strong, no better at
   matching. Adjacent levels 84-110 Elo apart (levels 9 to 10: 142), 825 Elo from level 2 to 10
   (engine.ts's targets span 810).
6. **Blunders of the depth-5 version against engine.ts** (each level against engine.ts at the
   same level, 200 games): it leaves pieces en prise about as often or a little less (5.3-5.9 per
   100 moves at levels 2-5, engine.ts 5.9-8.1), but walks into mate in one 5-8 times less often
   (0.07-0.14 against 0.35-0.68). engine.ts's low levels search 2 plies and never test a leaf for
   mate, so the mating reply is past their horizon; at depth 5 the mate is seen unless the
   mating check is overlooked.
7. **Human players for reference** (Maia's test games, Lichess blitz and rapid ratings, plies 16+
   without time trouble): at 1000-1300 they walk into mate in one 0.64-0.87 times per 100 moves,
   miss 38-45 % of their own mates in one and leave a piece en prise 3.2-4.0 times; at 1900, 0.32,
   27 % and 2.2. Both engines miss far fewer of their own mates and hang more pieces than people.
8. **Checks lose their second chance** (depth-5 version; the code also gets simpler): level 10 at
   vision 950 matches 33.80 % and is +12 ± 20 against Maia-1900 over 1000 games. Levels 6-9 became
   24-91 Elo weaker than engine.ts at the same level, so levels 2-9 were placed again (Tried 11).
9. **Maia and Gaia as references.** Maia-1100/1500/1900 and Gaia 4.4.1 levels 2-11 (built from
   source with its network; own book off, one thread, depth-limited by its levels) each played
   200 self-play games from the 8-move book; Gaia's two sides had different Skill Seeds. Each Gaia
   level also played 200 games against the engine.ts level nearest its nominal rating, which put
   it on the ladder's scale (± 45-57). Move matching is on 100 games of the 1100 and 1900 bins.
   engine.ts's blunder rates are from its games against the depth-5 version (level 10: against
   Maia-1900). Gaia levels 2-9 are the ones at or below Pedagog level 10.

   | Player | Rating | Allows M1 | Misses M1 | En prise | Hung | Match 1100 | Match 1900 |
   |---|---|---|---|---|---|---|---|
   | Gaia 2 | 863 | 0.50 | 28 % | 3.6 | 2.2 | 20.6 | 16.6 |
   | engine.ts 2 | 905 | 0.68 | 0 / 7 | 8.1 | 4.7 | 28.8 | |
   | Gaia 3 | 947 | 0.38 | 20 % | 3.2 | 2.2 | 22.3 | 19.1 |
   | Gaia 4 | 988 | 0.36 | 9 % | 3.1 | 2.2 | 25.0 | 20.5 |
   | engine.ts 4 | 1149 | 0.58 | 0 / 8 | 5.9 | 4.2 | 31.1 | |
   | Gaia 5 | 1184 | 0.28 | 10 % | 3.0 | 2.3 | 25.7 | 22.8 |
   | Gaia 6 | 1240 | 0.15 | 2 % | 2.4 | 2.1 | 27.6 | 25.4 |
   | engine.ts 6 | 1351 | 0.16 | 0 / 3 | 5.6 | 4.0 | 31.9 | |
   | Gaia 7 | 1402 | 0.08 | 3 % | 2.1 | 1.9 | 29.5 | 28.0 |
   | Maia-1100 | 1520 | 0.54 | 25 % | 2.3 | 2.5 | 50.6 | 48.4 |
   | engine.ts 8 | 1543 | 0.02 | 0 / 9 | 3.9 | 2.6 | 33.0 | |
   | Gaia 8 | 1557 | 0.04 | 2 % | 1.8 | 1.6 | 31.6 | 31.0 |
   | Gaia 9 | 1690 | 0.02 | 0 % | 1.6 | 1.4 | 32.8 | 33.8 |
   | Maia-1500 | 1690 | 0.22 | 21 % | 1.5 | 1.9 | 48.7 | 52.8 |
   | engine.ts 10 | 1741 | 0.00 | 0 / 56 | 2.5 | 1.8 | 34.6 | 34.0 |
   | Maia-1900 | 1755 | 0.42 | 32 % | 1.4 | 1.6 | 46.0 | 53.9 |
   | Gaia 10 | 1846 | 0.03 | 1 % | 1.7 | 1.4 | 33.9 | 36.2 |
   | Gaia 11 | 2013 | 0.00 | 0 % | 1.6 | 1.2 | 34.5 | 38.1 |
   | People 1000 | | 0.87 | 45 % | 4.0 | 2.8 | | |
   | People 1500 | | 0.51 | 30 % | 2.8 | 2.0 | | |
   | People 1900 | | 0.32 | 27 % | 2.2 | 1.5 | | |

   Rates are per 100 moves, except Misses M1 (per chance); en prise and hung are 3+ points. Maia
   and Gaia rates are from self-play, engine.ts's from games against the depth-5 version (level
   10: against Maia-1900), people's against people; the rates depend on the opponent (engine.ts
   level 4 leaves a piece en prise 5.9 times per 100 moves against the depth-5 version, 3.8
   against Gaia level 6), so engine.ts's rows are only rough.
   - Matching rises with strength for engine.ts and Gaia on both bins; only Maia is matched to its
     bin. Matching cannot place the lower levels; blunder rates can.
   - Maia's rates barely move from 1900 to 1100, and all three are about as clean as people at
     1500-1900 (Maia-1100 is 1520 on this scale). Its trend gives nothing to extrapolate below
     1100; the human bins are the better target.
   - Gaia leaves pieces en prise a little less often than people of about its rating (3.0-3.6
     at levels 2-5; people at 1000-1200: 3.8-4.0), engine.ts more often in these games (5.6-8.1
     at levels 2-6). From level 6 up Gaia almost never walks into or misses a mate in one (people
     at 1900: 0.32 and 27 %); engine.ts almost never misses one at any level.
   - At equal rating Gaia matches fewer human moves than engine.ts below about 1500 (level 5:
     25.7 % on the 1100 bin, engine.ts level 4: 31.1 %) and 0-2 points fewer above.
   - Gaia's levels use four knobs: a depth of 1-2 with an extra ply on a share of positions,
     an evaluation that fades from material to piece-square tables to the network, an error on
     every evaluation with an occasional large one, and vision (fading with depth) in the search
     and the quiescence search.
10. **The same positions for everyone** (`style-human.py --positions`, 100 games of the 1900 bin,
    37 mates in one to find). Times off people: Maia-1900 1.41, depth-5 version (checks rule)
    2.03, depth-3 + quiescence 3.42, Gaia 9 3.73, Gaia 10 4.12, engine.ts 4.39, Stockfish d15
    16.96. Paired, the depth-5 version is 0.49 [0.34, 0.86] of Gaia 10's distance; the depth-3
    version and Gaia are not told apart. Missing and allowing mates in one decides it: only Maia
    and the depth-5 version do either. Gaia blunders about as often as people (1.04 at level 9),
    the Pedagog versions 1.2-1.3 times as often. Mean loss of winning chances per move does not
    stand in for strength across engines: it ranks Gaia 10 best and the depth-5 version worst,
    unlike their games.
11. **Levels 2-9 of the depth-5 version placed again** (after Tried 8; against engine.ts at the
    same level, 300-400 games per round, three rounds, a quadratic through the corrected visions):
    611, 648, 678, 727, 768, 811, 856, 902, each within about 30 Elo of its target. Played against
    each other (300 games, own seeds), levels 2-5 are 60-80 Elo apart (± 40); 5-10 not played.
12. **Vision by kind of move** (`engine-simplehuman-knobs.ts`, level 10, one knob changed at a
    time from the depth-5 version's settings, 150 games of the 1900 bin, 43 mates in one, not
    tuned for strength). Times off people / matching: unchanged 2.00 / 32.77 %; checks seen at
    850: 1.49 / 32.03 % (paired 0.74 [0.55, 1.00]; allows mate 0.38 to 1.24 of people's rate,
    misses 0.36 to 0.71; hangs 1.29 to 1.77); checks at 750 and 650 overshoot the mates allowed
    and hang more; captures at 980 and 940 hang 3-4.5 times as often as people (2.08 and 2.46);
    retreats at 750: 1.68 / 32.54 % at no cost in strength (paired 0.84 [0.73, 0.95]); quiet
    moves at 990: 1.84 / 33.01 %. Checks are the lever, retreats a small extra, captures not.
13. **Vision plus a vision for checks, depth 5** (level 10, other moves at 1000). Checks at 850:
    1.47 times off people, 32.94 % (paired against the unchanged settings 0.73 [0.54, 1.00]), but
    -85 ± 22 against Maia-1900; other moves at 975 instead: -92. Checks at 910: -54; at 940: -31.
    Overlooking the opponent's checks costs strength that seeing more of the other moves does not
    win back, so at depth 5 level 10 cannot be both as strong as Maia-1900 and much more human.
14. **Depth and vision as the two knobs** (`engine-simplehuman-2knob.ts`; checks at 0.85 of the
    vision, no second chance; captures keep theirs). Level 10 at full vision: depth 5 -63 ± 22,
    depth 6 -11 ± 22 against Maia-1900 (1000 games each), so level 10 searches 6 plies: 1.9-3.3
    s a move in Bun, 8-15 times the depth-5 version's time, so it is much the slowest file here.
    Below it, each level takes the shallowest depth that reaches its target
    and vision brings it down: rating rises about 1.1 Elo per unit of vision at depth 2, 1.3 at
    depth 3 and 1.8 at depth 5, while depth 4 stayed near 1440 at 918-959. Placed in three
    rounds against engine.ts at the same level (400 games), every level is within 30 Elo:

        level  depth  vision  target  measured
          2      2      931     945      958
          3      2     1024    1046     1052
          4      3      830    1148     1165
          5      3      905    1249     1253
          6      3      980    1350     1379
          7      4      935    1451     1436
          8      5      915    1553     1523
          9      5      969    1654     1645
         10      6     1024    1755     1744

    Played against each other (300 games, own seeds), levels of the same depth are 64-119 Elo
    apart, but where the depth grows the deeper side wins more: 3 to 4 +86, 6 to 7 +166, 7 to 8
    +170, 9 to 10 +250. Each side is the other's exact blind spot there, so these gaps are wider
    than against other opponents. Its mistakes in the same positions are not measured yet.

## Verdict

- **The brief was met.** One knob per level, used in one place, replaced engine.ts's five
  settings per level. With a quiescence search, level 10 matches more human moves than engine.ts
  (+2.2 points) and is as strong as Maia-1900; without one, the code is smaller and level 10
  matches as many. Levels 2-9 of the quiescence version were placed within about 50 Elo of their
  targets; those of the depth-5 version need placing again after the checks rule.
- **People's mistakes were not.** At no level does either version walk into or miss mates in one
  as often as people do, and the depth-5 version leaves pieces en prise more often than people of
  its rating. But engine.ts misses almost no mates in one either, and neither does Gaia, with four
  knobs, from level 6 up. That goal came later and no engine measured here meets it, so it is
  not a cost of having one knob; whether one knob can meet it is still open.
- What remains is `style-human.py`, which measures every goal tried here for any engine, and
  these notes.
- **Later: checks are the lever for people's mistakes, at a price in strength.** Noticing checks
  less often brings mates in one closest to people (1.47-1.49 times off people against 2.0), but
  at depth 5 that leaves level 10 85 Elo short of Maia-1900. Depth as a second knob wins it back
  (depth 6, -11 ± 22) and places every level within 30 Elo, at 8-15 times the time per move at
  level 10.

## Not tried yet

- **The 2-knob file's mistakes**: `style-human.py --positions` at each level, against the human
  bin of its rating.
- **Checks split by side**: the player's own checks (missing its mates) and the opponent's
  (walking into them) want different chances; `overlooks()` knows the ply, so this stays in one
  place.
- **Depth as vision**: overlook every move from the level's depth on, in `overlooks()`, so both
  knobs act on one line; costs about 30 times the work at the last ply unless checked before the
  move is made.
- **A faster level 10**: depth 5 with checks noticed more often (about 980 by interpolation;
  little of the gain in mates left), or depth 6 only where the position is quiet.

- **Lower levels from people's rates**: set each level to the blunder rates of the human bin of
  its rating (1000-1900, extrapolated below 1000), alongside its strength target. The bins are
  Lichess blitz and rapid ratings and the ladder is classical (Maia-1900 = 1755), so which bin
  each level targets has to be chosen. One knob cannot meet three rates and a rating at once;
  against engine.ts the depth-5 version leaves pieces en prise 3.5-5.9 times per 100 moves at
  levels 2-9 and walks into 0.02-0.14 mates in one. The conflicts are to be shown first, in
  self-play.
- **No second chance at all** (captures too): the simplest `seesMove()`.
- **The checks rule in the depth-3 + quiescence version**.
- **Vision fading with distance from the root**, as in engine.ts (two constants).
- **Smoother depth steps**: a fractional depth (one more ply on a share of positions, as in
  engine.ts) where a level changes depth, since in self-play the deeper level wins more than its
  rating says (Tried 14) and a person may feel those steps too.
- **Other single knobs**: fractional depth alone (engine.ts's level 10 is depth 4.45), a node
  budget, noise in the evaluation (Gaia's evaluation fidelity; worth nothing in engine.ts's
  measurements), or a temperature over the root moves.
- **A human prior**: engine-human's move model as a tie-break among near-best moves.
