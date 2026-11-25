"""Score an engine-habits match the way habits_bands.py scores VBKN.

usage: python habits_compare.py starts                  (re)write vbkn-starts.epd
       python habits_compare.py <match.pgn> [...]       compare a match with VBKN at 1550+

vbkn-starts.epd: every opening VBKN's 1550+ opponents chose, cut where he is next to move
(after 1 or 2 of their moves). match.js plays each start twice, colours reversed.

Each match game is rebuilt from the start position (book prefix + game moves), the habits
engine ("L10") renamed VBKN and 2-knob ("prev-L10") its opponent, so habits_bands.column()
applies unchanged: "me" = habits engine, "opp" = 2-knob in the same games.
"""
import collections
import io
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import chess  # noqa: E402
import chess.pgn  # noqa: E402
from habits_bands import column, rating  # noqa: E402
from habits_probe import run_engine  # noqa: E402
from habits_stats import load  # noqa: E402

STARTS = os.path.join(HERE, "vbkn-starts.epd")
TS = open(os.path.join(HERE, "engine-habits.ts")).read()


def vbkn_1550():
    return [g for g in load() if rating(g) >= 1550]


def opening_lines(games):
    """UCI prefixes, most frequent first (two may transpose to the same position)."""
    count = collections.Counter()
    for g in games:
        my = chess.WHITE if g.headers["White"] == "VBKN" else chess.BLACK
        ms = list(g.mainline_moves())
        for n in ((2, 4) if my == chess.WHITE else (1, 3)):
            if len(ms) > n:
                count[" ".join(m.uci() for m in ms[:n])] += 1
    return [line for line, _ in sorted(count.items(), key=lambda kv: (-kv[1], kv[0]))]


def board_after(line):
    b = chess.Board()
    for u in line.split():
        b.push_uci(u)
    return b


def opening_starts(games):
    """EPD -> a UCI prefix that reaches it."""
    return {board_after(line).epd(): line for line in opening_lines(games)}


def write_starts():
    lines = [board_after(line).fen() for line in opening_lines(vbkn_1550())]
    with open(STARTS, "w") as f:
        f.write("\n".join(lines) + "\n")
    print(f"{len(lines)} starts -> {STARTS}")


def repertoire():
    book = {}
    for name, colour in (("WHITE_LINES", chess.WHITE), ("BLACK_LINES", chess.BLACK)):
        body = re.search(name + r"[^=]*=\s*\[(.*?)\];", TS, re.S).group(1)
        for line in re.findall(r'"([^"]+)"', body):
            b = chess.Board()
            for u in line.split():
                if b.turn == colour:
                    book.setdefault(b.epd(), u)
                b.push_uci(u)
    return book


def rebuild(g, tag, i, starts):
    start = g.headers.get("FEN")
    prefix = starts[chess.Board(start).epd()].split() if start else []
    out = chess.pgn.Game()
    node = out
    for u in prefix + [m.uci() for m in g.mainline_moves()]:
        node = node.add_variation(chess.Move.from_uci(u))
    ren = {"L10": "VBKN", "prev-L10": "2KNOB"}
    for k in ("White", "Black"):
        out.headers[k] = ren.get(g.headers[k], g.headers[k])
    out.headers["Result"] = g.headers["Result"]
    out.headers["WhiteElo"] = out.headers["BlackElo"] = "1755"
    out.headers["TimeControl"] = "300"
    out.headers["Termination"] = g.headers.get("Termination", "")
    out.headers["Link"] = f"engine:{tag}:{i}"
    return out, len(prefix)


def main():
    if sys.argv[1:] == ["starts"]:
        write_starts()
        return
    vbkn = vbkn_1550()
    starts = opening_starts(vbkn)
    games, plen = [], []
    for path in sys.argv[1:]:
        tag = os.path.splitext(os.path.basename(path))[0]
        with open(path) as f:
            text = f.read()
        f = io.StringIO(text)
        i = 0
        while (g := chess.pgn.read_game(f)) is not None:
            r, n = rebuild(g, tag, i, starts)
            games.append(r)
            plen.append(n)
            i += 1

    book = repertoire()
    inbook = followed = 0
    for g, n in zip(games, plen):
        me = chess.WHITE if g.headers["White"] == "VBKN" else chess.BLACK
        b = g.board()
        for k, m in enumerate(g.mainline_moves()):
            if k >= n and b.turn == me and b.epd() in book:
                inbook += 1
                followed += m.uci() == book[b.epd()]
            b.push(m)

    cache = run_engine(games + vbkn)
    cols = [column(vbkn, "me", cache), column(games, "me", cache), column(games, "opp", cache)]
    labels = ["VBKN1550+", "habits", "2-knob"]
    width = max(len(k) for k in cols[0])
    print(f"{'':{width}s}" + "".join(f"{lbl:>10s}" for lbl in labels))
    for k in cols[0]:
        print(f"{k:{width}s}" + "".join(f"{c[k]:>10s}" for c in cols))
    print(f"repertoire positions reached by habits: {inbook}, book move played: {followed}")


if __name__ == "__main__":
    main()
