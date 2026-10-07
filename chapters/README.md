# The chapters

The engine as it was at the end of each chapter, generated from `../pedagog.js`
by `bun run chapters` (`tools/chapter.js all`). Do not edit these files; edit
`pedagog.js` and regenerate. Each is a complete UCI engine: `bun chapters/4-alpha-beta.js`.

| file | adds | rating* | against the chapter before |
|---|---|---|---|
| `1-random.js` | a legal move at random (mating in one when it can) | ~400 | — |
| `2-greedy.js` | one ply ahead, counting material | ~420 | 14-0-186: wins the material, cannot mate |
| `3-minimax.js` | look 3 plies ahead, every line to the end | 1186 | 200-0-0 |
| `4-alpha-beta.js` | stop looking at a refuted move: the same answer, far fewer nodes | 1177 | 98-98-4, the same moves |
| `5-iterative.js` | depth 1, 2, 3, … until the clock says stop | 1618 | +486: alpha-beta's speed, cashed in |
| `6-ordering.js` | captures first, so refutations come early | 1790 | +238 |
| `7-piece-squares.js` | judge where the pieces stand, not only how many | 1906 | +149 — this one is `pedagog.js` itself |

\* Lichess classical scale, Maia-1900 anchored at 1755; 200 games per pairing. See `../COLOPHON.md`.

Chapters 1–4 have no sense of time and search to a fixed depth (`FIXED_DEPTH = 3`),
so they may overstep a clock; from chapter 5 on the engine plays timed games. The
skill levels (`Skill_Level`) are present in every chapter but were calibrated on the last.
