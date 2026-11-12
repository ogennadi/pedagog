# Constrictor tuning log

Goal: a variant of Pedagog (`variants/engine-constrictor.ts`) whose space-taking,
constricting style you can *feel within a single game*, as with the Aggressive
campaign (COLOPHON, Part III). `engine.ts` stays untouched.

## Setup

- **Yardstick:** Maia-1900 (lc0, nodes=1).
- **Subject:** the variant at Skill_Level 10.
- **Openings:** the 198 lines of the web book (`tools/out/tune/book6.pgn`, ≤ 6 plies),
  `-repeat`, `-srand 7`.
- **Adjudication:** the same as `tools/match.js`.
- **Runner:** session file `tune.js` (cutechess, 12 concurrent games), which passes the
  `Constrictor_*` UCI spin options. It appends one line per run to
  `tools/out/tune-results.jsonl`.
- **Metrics:**
  - `tools/style-constrictor.py`: space, space edge, opponent mobility, pawn advance.
  - Session file `feel.py`, which reads own moves 10–35:
    - `adv`: own pawns in the enemy half
    - `ram`: own pawns in the enemy half blocked by an enemy pawn
    - `ctl`: squares on the enemy's 4th/3rd ranks (our 5th/6th) that our pawns attack
    - `oppSafe`: enemy N/B/R/Q moves to squares our pawns don't attack
    - `oppHome`: enemy minors still on their first two ranks
    - `pieces`: N/B/R/Q left on the board

## Phase 1: tune the original terms (plain ladder, depth 3 at L10)

The terms were `space`, `pawnAdvance`, `cramp`, `keepPieces` and `pushBias`, all
UCI options. All runs were 100 games vs Maia-1900 unless noted.

| run | change | score | space | edge |
|---|---|---|---|---|
| base | engine.ts L10 (aggressive) | 40% | 6.08 | 0.62 |
| v0 | untuned weights | 49.5% | 6.66 | 1.77 |
| s80 | Space 80 | 43% | 7.34 | 3.36 |
| a20 | PawnAdvance 20 | 51% | 6.40 | 1.30 |
| c75 | Cramp 75 | 41.5% | 6.42 | 1.34 |
| k25 | KeepPieces 25 | 47% | 6.95 | 2.40 |
| p60 | PushBias 60 | 52% | 6.72 | 1.61 |
| x6 | all weights ×6 | 26% | 6.93 | 2.78 |

**Finding:** absolute space hardly moves. A strong `space` weight caused queen raids
(for example 3.Qh5), not binds. Reference binds such as the French Advance, the KID
Mar del Plata and the Maroczy only score 3–6 on the checker, so absolute space is
the wrong target.

## Phase 2: new terms

- **`wedge`:** a bonus for a pawn in the enemy half that another pawn defends.
- **`territory`:** after Stockfish's space term. No effect; left at 0.
- **Stable space:** the space term now ignores queen and king attacks.

| run | change | score | edge | adv (feel) |
|---|---|---|---|---|
| E1 (200 g) | Space 40, Wedge 50, PawnAdvance 15 | 53% | 1.80 | 0.81 |
| E2 (200 g) | Space 40 | 55% | 1.91 | 0.58 |
| D3 | Space 30, Wedge 100, PawnAdvance 30 | 57% | 0.69 | 1.18 |
| C4 | Space 150, … | 15.5% | 2.29 | — |

I baked E1 in as the defaults, but the **user didn't feel it**. Using `feel.py`:

| | base | E1 |
|---|---|---|
| adv | 0.27 | 0.81 |
| oppSafe | 22.3 | 20.0 |
| oppHome | 1.15 | 0.86 |

Less than one advanced pawn on average, and the opponent's pieces are barely
restricted.

## Phase 3: go drastic, buy the strength back with depth (in progress)

Lesson from Aggressive: the style became felt only when it was drastic (material
counted at 25%, costing about 210 Elo), and a deeper ladder bought the strength back.

Plan:
1. The constrictor plays on the deeper aggressive ladder (L10 = depth 4 + 42%,
   no blunders).
2. New `restrict` term: our safe piece mobility minus theirs (moves to squares the
   other side's pawns don't attack).
3. Sweep drastic weights for `pawnAdvance`, `wedge`, `restrict` and `keepPieces`.
   Targets:
   - `adv` ≥ 2 and `oppSafe` well below 20
   - score vs Maia-1900 ≥ about 45%
   - speed acceptable in the browser
4. Eyeball sample games; the bind should be obvious on the board at move 20–25.
5. Bake in the weights, restart the 8081 server, and let the user playtest
   (ideally with Mystery-style blind games).

Results so far:

- **Deeper ladder.** The constrictor now plays on AGGRESSIVE_LADDER: L10 is depth 4 + 42%
  with no blunders, at about 1 s per move. With the E1 weights (G0) it scored 72% vs
  Maia-1900, so there is roughly 150 Elo of strength to spend on style.
- **Bind rate.** Averages hide the feel, so `feel.py` now reports **bind%**: the share of
  games with at least 2 own pawns in the enemy half, at least 1 of them locked, for at
  least 6 own moves in a row (moves 10–35). This is the metric that separates styles:

| run | weights (deep ladder unless noted) | score | bind% |
|---|---|---|---|
| base | engine.ts L10 | 40% | 1 |
| E1 (plain ladder) | the version the user played | 53% | 17 |
| G0 | E1 | 72% | 18 |
| G1 | + Restrict 5 | 73% | — (oppSafe unchanged) |
| G2 | PawnAdvance 40, Wedge 120, Restrict 6, Keep 20 | 62.5% | 29 |
| G3 | PawnAdvance 60, Wedge 150, Restrict 10, Keep 30, Push 60 | 50% | 33 |
| H1–H4 | + `lock` (rams), with pawns counted in keep | 35–69.5% | 16–21 |
| I1 | centre-only PawnAdvance 40, Wedge 100, Lock 60, Push 40 | 67.5% | 26 |
| I2 | centre-only PawnAdvance 60, Wedge 150, Lock 100, Push 60 | 57% | 28 |
| I3 | centre-only PawnAdvance 80, Wedge 150, Lock 150, Push 80, Space 20 | 44.5% | 50 (edge −0.64: overextended) |
| I4 | I2 + Keep 30 | 60.5% | 30 |

Lessons:
- **Restrict is useless as a zero-sum eval term.** Reducing the enemy's safe mobility is
  the same as raising our own, so it opens lines instead of closing them.
- **Counting pawns in `keepPieces` made the eval jump ±375 cp** whenever the space lead
  flipped, which caused chaos. It is now continuous: space lead × pieces on board ×
  keep / 8.
- **Big pawn bonuses don't squeeze; they make the engine sacrifice pieces for pawn
  pushes** (for example Bxe5 Nxe5 f4, or …b4 giving up a knight).
- **The bind rate is fairly even across openings and stays around 30%** at sound weights.
  It is higher as White (38%) than as Black (22%).

### Phase 4: root bias (in progress)

Following the Aggressive style's `checkBias`: keep the eval sound and, at the root, prefer
among near-equal moves the most constricting quiet one. **`squareBias`** gives cp per point
of (space gained + safe moves taken from the enemy pieces). Swept on top of I1:

| run | squareBias | score | bind% | oppSafe |
|---|---|---|---|---|
| I1 | 0 | 67.5% | 26 | 19.7 |
| J1 | 8 | 66.5% | 29 | 19.3 |
| J2 | 15 | 61% | 21 | 20.1 |
| J3 | 25 | 62% | 28 | 19.6 |
| J4 | 40 | 50% | 26 | 18.8 |

Result: within noise (about ±9%) the bind rate does not move, and the score falls
as the bias grows. The root bias alone doesn't produce the feel.

### Phase 5: one-sided style

The user's target at L10: "its pawns rolling up the board and my pieces stuck with
no squares". The idea is that a colour-symmetric eval makes the engine fear the
opponent's space, so it plays breaks that undo its own bind. **`oneSided`**
(Constrictor_OneSided=1) changes this: think() tags the skill with the side to move,
and the constriction and pawn terms count only for that side. Space and territory
use our own count, cramp counts the enemy's cramped minors, keep applies only while
we lead, and restrict is a penalty on the enemy's safe mobility. That makes
`restrict` a real, non-zero-sum term for the first time.

| run | weights | score | bind% | oppSafe | edge |
|---|---|---|---|---|---|
| K1 | I1 + OneSided | 68.5% | 31 | 23.6 | −0.53 |
| K2 | K1 + Space 80, Cramp 60 | 66% | 20 | 23.8 | 0.10 |

Result: one-sided alone makes the engine ignore Maia's counterplay, so Maia gains
space (oppSafe goes up). The next step is to pair it with a one-sided `restrict`.

| run | weights | score | bind% | oppSafe | edge |
|---|---|---|---|---|---|
| K3 | K1 + Restrict 8 | 66% | 38 | 21.6 | 0.50 |
| K4 | K1 + Restrict 20 | 73% | 43 | 18.2 | 0.75 |
| X1 (60 games) | **baked in (extreme)**: PawnAdvance 60, Cramp 60, Push 60, Wedge 150, Restrict 40, Lock 100, SquareBias 15, OneSided | 39% | 27 | **14.9** | 1.13 |

The user asked to "go more extreme", so X1 was baked into `CONSTRICTOR`. It squeezes
the opponent's pieces far harder than any other run (oppSafe 14.9 vs about 20), at
about baseline strength (39% vs 40%). K4 is the fallback if the playtest finds it too
weak.

Confirmed over 200 games (X2): +69 −104 =27, 41.3%, which is about −61 Elo vs Maia-1900
(95% CI roughly −108 to −17). That matches plain Level 10 (40%). Bind rate 33.5%,
oppSafe 15.0. The user played it and liked the style ("I beat it with some effort").

### Speed

The user found the baked-in style noticeably slower than regular Pedagog in the browser.
Benchmark: 60 positions from X2, `go depth 100` at L10 (the web app's command).

- engine.ts (Aggressive, the default): mean 282 ms, median 92 ms, 754 knps
- constrictor before: mean 526 ms, median 218 ms, 260 knps
- constrictor after: mean 313 ms, median 143 ms, 438 knps

The fix: `gripOf()` computes the attack maps, space, cramped minors, safe moves and
piece count in two passes. It uses module-level scratch maps, so nothing is allocated
per leaf and there are no filter/reduce closures. The rewrite plays identically: best
moves and node counts on all 60 positions match the old code (fingerprint check), for
both the one-sided and the two-sided (+Territory) styles.

### Phase 6: safe pawns and storms

The user felt the pawn-storming most and saw pawn sacs in the opening. Two changes:

- **Safe pawns.** pawnAdvance, wedge and lock (and the new storm) count only safe pawns:
  defended by a pawn, or attacked by no enemy pawn and by no more enemy men than defend
  them. The root biases skip pawn moves that leave the pawn unsafe.
- **storm.** cp per rank for pawns on the enemy king's wing (a-c or f-h), halved when our
  king is there too.

New metrics: sac% = own material at least 1 down for 6+ plies by move 15; storm% = a pawn
reaching the 5th rank on the enemy king's wing, moves 10-40.

| run | change | score | bind% | storm% | sac% |
|---|---|---|---|---|---|
| X2 | before (200 games) | 41.3% | 33.5 | 29 | 43 |
| S0 | safe pawns | 39.5% | 46 | 37 | 27 |
| S1 | + Storm 30 | 42.5% | 52 | 46 | 32 |
| S2 | + Storm 60 | 42.5% | 47 | 44 | 31 |
| S3 | + Storm 100 | 45.5% | 50 | 44 | 30 |

S3 is baked in for the user to try. Speed: about 355 ms per move (bench mean).

| run | change | score | bind% | storm% |
|---|---|---|---|---|
| S4 | Storm 160 | 35.5% | 48 | 44 |
| S5 | Storm 250 | 29% | 39 | 44 |

Storm above 100 costs strength without storming more often, so S3 stays.

### Ablation (S3 with one term off, 100 games each)

S3 reference: score 45.5%, bind 50, storm 44, oppSafe 16.3. Noise on the rates is about +/-10.

| off | score | bind% | storm% | oppSafe |
|---|---|---|---|---|
| oneSided | 45.5% | 30 | 33 | 20.1 |
| restrict | 53.5% | 41 | 44 | 23.0 |
| wedge | 47% | 34 | 38 | 15.8 |
| pawnAdvance | 42.5% | 43 | 36 | 15.3 |
| storm | 39.5% | 46 | 37 | 15.6 |
| space | 44% | 40 | 38 | 15.5 |
| lock | 45% | 42 | 41 | 16.5 |
| push+squareBias | 43% | 45 | 39 | 16.8 |
| keepPieces | 46% | 54 | 40 | 16.4 |
| cramp | 43.5% | 58 | 45 | 17.3 |

Plain ladder (P3, S3 weights on Reference's L10 rung): 18.5%, bind 49, storm 34.
The style survives on the plain ladder, but it loses badly there; the deeper ladder
pays for the style.

What makes the feel: oneSided (all three feel metrics), restrict (squares, at a strength
cost), wedge (bind), and pawnAdvance plus storm (storms). cramp, keepPieces and the root
biases show no effect and are candidates to drop.


## Phase 7: trimmed (user request)

Dropped cramp, keepPieces, pushBias, squareBias and territory from the code, which also removed
the hangsPawn root bias. Set space=0 and lock=0 per the user. Defaults are now pawnAdvance 60,
wedge 150, restrict 40, oneSided 1 and storm 100.

T1 (100 games vs Maia-1900): 45.5% (+38 -47 =15), bind 35%, oppSafe 15.8. Speed bench mean
was 454 ms (median 196). The search trees differ, so it does not match the old fingerprint.

T2 (space 40, lock 100 re-enabled; user preference): 48.5% (+39 -42 =19), bind 49%, oppSafe 16.9.
Bind is back at S3 level, which confirms space and lock carry part of the squeeze. These are the defaults now.

## Phase 8: outposts and guard (sac reduction)

New terms: outpost (a knight or bishop in the enemy half, defended by a pawn, that no enemy pawn can ever attack) and guard
(a permille of any material deficit charged again, which removes the reason to sac a pawn for style bonuses). Both
default to 0. Session sacs.py measures sac% (down 1+ for 6+ plies before ply 30), storm%, and outpost plies per game.

- T2 baseline: 48.5%, bind 49, sac 25, storm 46, outpost plies 3.9
- O1 outpost 80: 52%, bind 49, sac 25, storm 46, outpost 3.7
- O2 outpost 160: 52.5%, bind 49, sac 27, storm 46, outpost 4.0
- O3 outpost 400: 52%, bind 51, sac 26, storm 42, outpost 5.9
- G1 guard 500: 54.5%, bind 48, sac 24, storm 46
- G2 guard 1000: 65.5% (+57 -26 =17), bind 39, sac 19, storm 46

Outposts barely register, even at 400. Guard 1000 is much stronger and cuts sacs, but bind drops by 10 points.

## Phase 9: Snaky ideas (guard 500 baseline)

Guard 500 is now the default (G1: 54.5%, bind 48, sac 24, storm 46). New terms (all default to 0): trapped (enemy N/B/Q off
its first rank with 1 or fewer safe moves), worstPiece (4 minus the safe moves of the least mobile such piece), pawnThreat
(enemy pieces our pawns attack), and kingZone (stable, pawn-free attacks on the enemy king's 8 neighbours).

- N1 trapped 100: 55%, bind 48, sac 25, storm 43
- N2 trapped 250: 58.5%, bind 47, sac 27, storm 48
- W1 worstPiece 40: 58.5%, bind 43, sac 28, storm 45
- W2 worstPiece 100: 51%, bind 52, sac 28, storm 48
- P1 pawnThreat 40: 59%, bind 48, sac 24, storm 49
- P2 pawnThreat 100: 56.5%, bind 45, sac 23, storm 46
- Z1 kingZone 20: 60%, bind 48, sac 24, storm 51
- Z2 kingZone 50: 60%, bind 47, sac 26, storm 45

None of these moves the feel metrics beyond noise (about 10 points). Scores lean slightly up (55-60%), which is within noise of 54.5%.