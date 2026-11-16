# engine-human

Work on a variant of Pedagog that plays the move a human of a given rating
would play, with a hand-crafted evaluation (no neural network). Its data
tools, training scripts and engine live here, together.

Goal: move-matching accuracy close to Maia's (about 51–53 % in its own rating
bin), measured on Maia's published test set: `maia-chess-testing-set.csv.bz2`
from CSSLab, December 2019 Lichess games, 10,000 games in each of the nine
100-point bins from 1100 to 1900, Bullet and HyperBullet excluded, the first
10 ply and moves made with under 30 seconds left dropped (about 500,000
positions per bin). Train only on games from before December 2019, filtered
the same way.
