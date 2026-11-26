# engine-trickster

engine-simplehuman-2knob.ts plus traps. The brief: play at about Maia-1900's strength, or at
the strength of the Stockfish setting that equals it, by setting traps a 1900 player would fall
into. It may well score more against Maia than against engines of the same strength.

**Status: stopped.** The aim became making it as tricky as possible before calibrating it,
and that failed (see "Conclusion" at the end). Its traps are mostly the run-2 model's
illusions. Sound tricks would need a much better opponent model, such as Maia itself. Level
10 is not calibrated.

`engine-trickster.ts` is a single file:

- **Base**: the 2-knob engine, with its depth and vision per level, plus a quiescence search:
  at the leaves it follows captures (those it notices) until the position is quiet, trying the
  most valuable victim first, with delta pruning. Without it, traps were mostly exchanges
  misread at the leaves (see Results). Level 10 is provisionally depth 5, which with quiescence
  is about as fast as the 2-knob's depth 6; it is not yet calibrated. Levels 2-9 also set
  traps and search captures to the end, so they are stronger than the 2-knob levels and are
  not calibrated.
- **Opponent model** (S2b): engine-human.ts's run-2 linear move model, which matches 36.8 % of
  moves on Maia's 1900 test set. It is a softmax over hand-made features of each legal reply.
- **Tricks** (S2c): on the last iteration, every root move within `Trick_Margin` centipawns of
  the best gets an exact value. These are the candidates, at most 16. For each candidate, the
  model's likeliest replies (at most 6, or fewer once they cover 90 % of the chance) are
  searched two plies shallower. A reply's gain is what it gives away beyond the candidate's
  value, capped at 600. A candidate's worth is

      E(value) + Trick_Lambda/1000 * sum of chance * (E(value + gain) - E(value))

  where E converts centipawns to expected score (Lichess's logistic curve). The candidate worth
  most is played. Replies the Trickster itself overlooks, and replies not examined, gain
  nothing. No traps are set when the best move mates or is mated.
- **UCI options**: `Trick_Margin` (default 50, up to 1000) and `Trick_Lambda` (permille trust
  in the model, default 1000, up to 10000; 0 sets no traps, and above 1000 it trusts the model
  more than it deserves, and hustles).
- **Trap log**: with the environment variable `TRICKSTER_LOG` set to a directory, each move's
  candidates and the played move's replies (with chance and gain) are appended to
  `trick-<pid>.jsonl` there, also sent as `info string trick {...}`.

Tools beside it:

- `traps.py`: the traps set and sprung in a match (see "How it was measured").
- `trap_probe.py`: without playing games, how tricky some settings are. It replays positions
  from a trap log under each setting and has Stockfish check every trap (see Results).
- `maia_probe.py`: whether Maia-1900 falls for those traps. It needs lc0 and the Maia
  weights (`LC0`, `MAIA_DIR`), and also shows what a Trickster using Maia as its model would
  do. It caches every result, so a rerun resumes.
- `matches.js`: a match that survives interruption, played in chunks of 50 games with
  `src/tools/match.js`. Rerunning the same command skips the finished chunks. At the end the
  chunks' PGNs and trap logs are joined under the match's tag.

## Why this design

- **Opponent-model search, cut to one ply.** Opponent-model search (Iida et al., 1993; Carmel
  and Markovitch, 1996) plays against a model of the opponent instead of a perfect one. Here the
  model gives move chances, not an evaluation, so the natural form is an expectation over the
  opponent's next move, then ordinary minimax. One ply keeps the cost bounded: at most 16
  candidates times 6 replies, each searched two plies shallower than the root. It also keeps
  every move near minimax.
- **The margin is the insurance.** A trap may cost at most `Trick_Margin` against the best
  defence, so a player who never falls loses little. Stockfish does not move like a 1900
  human. Against it the traps gained about 23 Elo at depth 5 and may cost a little at depth 6
  (see Results).
- **Expected score, not centipawns.** Winning a piece matters more in a level position than in
  a won one, so a trap counts most where the game is still open.
- **A human move model, not a hand-made bait test.** STYLE-IDEAS.md suggested scoring bait with
  static exchange. The model finds bait that static exchange cannot: a pawn that only looks
  free, a natural recapture, a check a 1900 player plays on sight. Trappy minimax (Gordon and
  Reda, 2006) instead finds traps from the search alone: replies that look better at a shallow
  depth than at the full one.
- **Why engine-human's run 2.** It is already single-file TypeScript on the same 0x88 board,
  and it is the best of the repo's small move models (36.8 % on Maia's 1900 test set). The
  81-concept model would need porting first. Using Maia itself as the model would only measure
  how well Maia exploits Maia. Run 2 was still trained on the same kind of games as Maia
  (Lichess, near 1900), so it should know Maia best of the three opponents, as it did.
- **The Trickster sets only traps it can see.** A reply it overlooks (by its vision) gains
  nothing, consistent with how the 2-knob engine models its own blind spots.
- **Only on the last iteration.** Earlier depths are only move ordering. Positions where the
  best move mates or is mated have nothing to gain from a trap.

Known weaknesses:

- Without quiescence, the gains came from a search five plies from the root, and many "falls"
  were misread exchanges (the Stockfish judge did not confirm them, see Results). The
  quiescence search fixes most of this. Falls are still judged by the Trickster's own shallow
  search.
- The model is overconfident. It predicts about 1.5 times as many falls as Maia makes, and twice
  as many as Stockfish makes. `Trick_Lambda` below 1000 discounts it.
- The model caps how tricky the engine can be: it names the reply a human actually plays only
  about 40 % of the time, so even a sound trap springs less often than that.
- Levels 2-9 are not calibrated.

## How it was measured

- `src/tools/match.js` (cutechess, 8-move book, both colours, untimed), now with three more
  kinds of player:
  - `sf<elo>`: Stockfish 19 with `UCI_LimitStrength` and `UCI_Elo`, one thread, 16 MB hash.
    Stockfish's Skill picks its move when iterative deepening reaches depth `1 + int(level)`
    (search.h, Skill), so it searches exactly that deep. Same moves as any longer search, and
    nothing to lose on time. Its pick is random, seeded from the clock, so its games do not
    repeat.
  - `gaia<N>`: Gaia 4.3.2 (`GAIA`) at Skill Level N, Skill Seed 1, no book, one thread. Below
    level 20 Gaia caps its own depth, so it is untimed too.
  - `--option NAME=VALUE`: a UCI option for the current-engine Pedagog players, e.g.
    `--option Trick_Lambda=0`.
- Maia-1900 is lc0 at 1 node, as elsewhere in the repo (1755 on the ladder's scale).
- Scores are wins-losses-draws of the first player, Elo with its 95 % interval. Played on
  2026-11-24, at concurrency 24. Outputs are in `src/tools/out/trickster/`.

## Results

### The Stockfish anchor

A first ladder at 0.1 s a move was thrown away. Stockfish lost 7-114 games of 200 on time,
even with a 200 ms margin, on a busy machine; sf2100 even scored below sf1700. With the depth
limit there were no forfeits:

| Stockfish | vs Maia-1900 | Elo |
|---|---|---|
| sf1320 (200 g) | 40-153-7 | -222 ± 58 |
| sf1450 (200 g) | 75-118-7 | -76 ± 49 |
| sf1500 (1000 g) | 428-504-68 | -27 ± 21 |
| sf1525 (1000 g) | 438-504-58 | -23 ± 21 |
| sf1550 (1000 g) | 468-452-80 | +6 ± 21 |
| sf1600 (200 g) | 112-66-22 | +81 ± 47 |
| sf1750 (200 g) | 123-58-19 | +117 ± 49 |
| sf1900 (200 g) | 150-36-14 | +225 ± 56 |

**sf1550** (Skill level 1.88, depth 2, MultiPV 4) is the anchor: Maia-1900's equal. COLOPHON's
"Stockfish `UCI_Elo` 1500 ≈ 1900" was never measured before; it is close.

### Gaia 4.3.2 against the anchor

| Gaia | vs sf1550 (200 g) | Elo |
|---|---|---|
| gaia8 | 59-128-13 | -125 ± 50 |
| gaia9 | 111-79-10 | +56 ± 48 |
| gaia10 | 147-42-11 | +203 ± 55 |
| gaia11 | 170-25-5 | +319 ± 70 |

**gaia9** is the nearest level. Placements for Gaia 4.4.1 (in engine-simplehuman's README) do
not carry over to 4.3.2.

### Trickster probes

Level 10 at depth 5, `Trick_Margin` 50. The control is the same engine with `Trick_Lambda=0`,
which is exactly the 2-knob search at depth 5, so the difference is the traps alone. 300 games
each:

| Opponent | Traps (λ 1000) | Control (λ 0) | Traps add |
|---|---|---|---|
| sf1550 | 119-164-17, -53 ± 39 | 111-175-14, -75 ± 39 | about +23 |
| maia-1900 | 130-122-48, +9 ± 36 | 114-150-36, -42 ± 37 | about +51 |

Traps took about 1.75 times as long as the control (258 s against 144 s for 300 games against
sf1550).

What `traps.py` found in the λ 1000 logs:

| | vs sf1550 | vs maia-1900 |
|---|---|---|
| Logged moves | 12,712 | 7,743 |
| Traps (not the minimax best) | 32 % | 27 % |
| Model's likeliest reply played | 21 % | 43 % |
| Falls, all moves: predicted / actual | 3,859 / 2,040 | 2,159 / 1,487 |
| Falls after traps: predicted / actual | 1,619 / 821 | 775 / 532 |

A fall is a reply that gives away 100 cp or more beyond the move's value, by the Trickster's
own search. The model knows Maia twice as well as it knows Stockfish. Both fall less often than
the model predicts, Maia at 69 % of the predicted rate after traps and Stockfish at 51 %. The
model and Maia were both trained on Lichess games of players near 1900, which is why the traps
pay off more against Maia. After a trap, Maia fell 26 % of the time against 17 % after the
Trickster's other moves; Stockfish fell 20 % against 14 %.

Stockfish 19 at depth 10 as judge (`traps.py`, as `src/tools/blunders.py`; a blunder costs 20
points of win%), in % of judged moves:

| | vs sf1550, traps | vs sf1550, control | vs maia-1900, traps | vs maia-1900, control |
|---|---|---|---|---|
| Opponent blunders | 5.8 | 6.4 | 7.2 | 5.8 |
| ... right after a trap | 4.1 | | 5.8 | |
| Trickster blunders | 6.3 | 7.2 | 8.4 | 7.0 |

Against Maia the traps make games sharper: both sides blunder more, and the Trickster gains
on balance. Against Stockfish the rates barely move. The Stockfish judge does not back the
Trickster's own view of its traps: right after a trap the opponent blunders *less* than on
average. Traps are possible only where several moves are close to the best, which are quiet
positions, and blunders come mostly in sharp ones. The "falls" above are also judged by a
5-ply search without quiescence, which misreads some exchanges.

### Level 10 at depth 6 (before the quiescence search)

Depth 5 was 53 Elo short of sf1550, so the next probe was depth 6, the 2-knob's own setting.
Traps on (λ 1000), 300 games each:

| Opponent | Trickster, depth 6 |
|---|---|
| sf1550 | 149-138-13, +13 ± 39 |
| maia-1900 | 144-96-60, +56 ± 36 |

+13 against sf1550 was on target, so level 10 became depth 6, vision 1024. With traps off,
that is exactly 2-knob level 10. The probes were played by a copy of the engine that differs
only in a comment. The first 300 games of 2-knob level 10 itself against sf1550 (a control run,
stopped there) went 164-126-10, about +44: at this depth the traps may cost a little against
Stockfish.

### Bolder and smarter traps (offline probe)

The brief then became: as tricky as possible, at level 10's strength. Matches were stopped
(only level 10's calibration is wanted until then), and settings were compared offline.

First, wider margins alone, without quiescence (80 positions, the Trickster's own view):
from `Trick_Margin` 50 to 300, traps went only from 35 % to 40 % of moves, at an average own
cost of 7 to 31 cp. The worth (expected score) already refuses costly traps, because the model
rarely gives a bold trap enough chance. Being bolder needs `Trick_Lambda` above 1000.

Then `trap_probe.py` on 120 positions where the Trickster was to move against Maia (depth-6
games), with Stockfish 19 at depth 12 checking every trap. Real cost: what the trap gives up
against the best defence, by Stockfish. Fall chance: the model's chance of a reply that gives
away 100 cp or more, by the Trickster's own search ("own") or by Stockfish ("real"). Seconds
per move with 7 engines running at once. "No quiescence" is the engine before the quiescence
search, with 16 candidates.

| Search, depth | Margin, λ | s/move | Traps | Real cost | After a trap, own / real | After any move, own / real |
|---|---|---|---|---|---|---|
| no quiescence, 6 | 50, 1000 | 1.7 | 35 % | 74 cp | 32 / 40 % | 21 / 28 % |
| no quiescence, 6 | 300, 3000 | 2.9 | 68 % | 94 cp | 46 / 36 % | 37 / 31 % |
| quiescence, 4 | 50, 1000 | 0.3 | 33 % | 39 cp | 28 / 38 % | 17 / 29 % |
| quiescence, 5 | 50, 1000 | 1.7 | 32 % | 15 cp | 31 / 38 % | 18 / 28 % |
| quiescence, 4 | 150, 2000 | 0.4 | 45 % | 75 cp | 36 / 40 % | 23 / 30 % |
| quiescence, 4 | 300, 3000 | 0.4 | 60 % | 102 cp | 39 / 40 % | 29 / 32 % |
| quiescence, 5 | 300, 3000 | 2.4 | 58 % | 86 cp | 43 / 39 % | 31 / 33 % |

- **Bolder alone chases illusions.** Without quiescence, margin 300 and λ 3000 double the
  traps, and the engine's own fall chance after any move goes from 21 % to 37 %. Stockfish's
  only goes from 28 % to 31 %, and a trap's real cost rises to 94 cp.
- **Quiescence makes the traps honest.** At depth 5 a trap really costs 15 cp, not 74, at the
  speed of depth 6 without it.
- **The model is the limit.** Whatever the setting, the real fall chance after any move stays
  between 28 % and 33 %. Most of it is there anyway: positions where a likely 1900 reply loses
  a pawn are common. A trap can only raise the chance of the reply the model expects, and the
  model names the human's move only about 40 % of the time.

Since quiescence makes every level stronger, level 10 is depth 5 for now, about as fast as
depth 6 was without it, until it is calibrated again.

### Does Maia fall for them? (offline probe)

Played by hand in the web app, the bold setting (margin 300, λ 3000, level 10) felt
aggressive, but its sacrifices were unsound. The "real" column above still trusts the run-2
model's chances; only the gains were checked. So `maia_probe.py` asked Maia-1900 instead.
- **Positions:** the same 120, at depth 5.
- **Maia:** lc0 0.32.1, policy only, temperature 1, from the FEN without move history. It
  gave the chance of every reply after every candidate. Replies of 1 % or more (97 % of
  Maia's chance) were scored by Stockfish at depth 12; the rest count as best defence.
- **Expected score:** after the opponent's reply, by the Lichess curve. It is reported per
  move, against the Trickster's own best move. Near equality, 1 point is about 11 cp.
- **Cost:** a few huge errors in the Trickster's own best move skew the mean, so the median
  is given as well.

| Setting | Traps | Trap cost, mean / median | Fall chance after a trap, run-2 / Maia | Maia, after the best move instead | Expected score vs Maia |
|---|---|---|---|---|---|
| default (50, 1000) | 32 % | −32 / 1 cp | 36 / 26 % | 24 % | +0.33 pts/move |
| bold (300, 3000) | 58 % | 62 / 12 cp | 38 / 27 % | 22 % | −2.01 pts/move |

Then a Trickster using Maia as its model, with Stockfish's values. Its candidates were the
bold run's 16 per position, and its expected score is against Stockfish's best of them.
It is an upper bound, since Maia both chooses the traps and judges them.

| Margin, λ | Traps | Cost per move | Maia's fall chance | Expected score vs Maia |
|---|---|---|---|---|
| Stockfish's best, no traps | 0 % | 0 cp | 16 % | 0 |
| 50, 1000 | 31 % | 5 cp | 22 % | +1.04 pts/move |
| 150, 1000 | 40 % | 15 cp | 25 % | +1.31 pts/move |
| 300, 1000 | 40 % | 16 cp | 26 % | +1.45 pts/move |
| 300, 3000 | 68 % | 60 cp | 39 % | +0.29 pts/move |

- **Run-2's traps are mostly illusions.** Run-2 expects 36–38 % of replies to fall for them;
  Maia, 26–27 %. Maia would fall 22–24 % of the time after the best move anyway, so the
  traps add only 2 to 5 points.
- **The bold setting loses.** Even against Maia it gives up 2 points of expected score a
  move: the unsound sacrifices seen in play.
- **A good model makes quiet tricks pay.** With Maia's chances, λ 1000 sets a trap on 40 %
  of moves for 16 cp. It raises the fall chance from 16 % to 26 %, worth about 16 cp a move
  against a Maia-like player.
- **Boldness does not pay even then.** λ 3000 raises Maia's fall chance to 39 %, but gives
  most of the gain back. Against 1900 players, sound tricks beat sacrifices.

## Conclusion

The goal of a "super tricky" Trickster at level 10's strength was called a failure, and
level 10 was not calibrated.

- **Boldness cannot be bought.** Turning up `Trick_Margin` and `Trick_Lambda` gives more
  traps and more sacrifices. A Maia-like opponent falls for them hardly more often than after
  the best move, so the bold setting loses expected score (−2 points a move against Maia),
  and its sacrifices felt unsound in play.
- **The opponent model is the root cause.** Run-2 names the human's move only about 40 % of
  the time, and it overrates how often a 1900 player gives material away (36–38 % against
  Maia's 26–27 %). Search fixes (quiescence, more candidates) made the traps cheaper, but not
  more likely to work.
- **Even a perfect model would only give quiet tricks.** With Maia's own chances, the best
  trade was traps on 40 % of moves at 16 cp each, worth about 16 cp a move. Boldness lost
  that gain again.

Possible next steps, if it is revived:
- Use Maia as the model through lc0. That works for UCI only, not in the web app.
- Distil Maia into run-2's weights, which keeps it a single file.

Either way, aim for sound tricks at λ 1000, then calibrate level 10 against sf1550.
