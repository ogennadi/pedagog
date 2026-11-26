"""Traps set and sprung, per match.

    python src/variants/engine-trickster/traps.py [--player L10] [--depth 10] [--jobs 8]
        [--no-judge] [--out traps.json] match.pgn ...

For each PGN, the Trickster's trap log is read from the directory log-<pgn stem> beside it
(match.js run with TRICKSTER_LOG set to that directory; see README.md). A log record is joined
to a game move by its position (board, side to move, castling: the en passant field and move
counters are ignored) and the move played. The engine is deterministic, so a position reached
in several games has one record.

Reported per match:
  * traps: the Trickster's logged moves that are not its minimax best (candidates[0]).
  * model top-1: how often the opponent played the model's likeliest reply.
  * falls: replies the Trickster's own search says give away >= 100 cp beyond the move's value.
    Predicted is the model's chance of such a reply, summed over moves; actual is the count of
    such replies the opponent played. Over all logged moves, then over traps only; and the
    actual rate after traps against the rate after the other logged moves.
  * judge (unless --no-judge): Stockfish at --depth judges every move, as src/tools/blunders.py
    does: Lichess's win% from centipawns, a blunder costs >= 20 points, moves where the mover's
    side was already beyond +-600 cp are skipped, mates count as +-1000. Given for the opponent
    (after every Trickster move, after traps, and after the other logged moves) and for the
    Trickster. This needs no log, so it also measures a control run (Trick_Lambda=0).
"""
import argparse, glob, json, math, os, queue
from concurrent.futures import ThreadPoolExecutor
import chess, chess.engine, chess.pgn

FALL = 100      # a reply that gives away this much more (cp) is a fall
DECIDED = 600   # moves made beyond this evaluation are not judged
BLUNDER = 20    # win% points


def position_key(fen):
    return " ".join(fen.split()[:3])


def win_pct(cp):
    return 50 + 50 * (2 / (1 + math.exp(-0.00368208 * cp)) - 1)


def load_log(directory):
    records = {}
    for path in glob.glob(os.path.join(directory, "trick-*.jsonl")):
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                if line.strip():
                    record = json.loads(line)
                    records[(position_key(record["fen"]), record["played"])] = record
    return records


def read_games(path, player):
    """(start FEN, [uci moves], Trickster's colour) for each game the player is in."""
    games = []
    with open(path, encoding="utf-8", errors="replace") as fh:
        while (game := chess.pgn.read_game(fh)) is not None:
            white, black = game.headers.get("White"), game.headers.get("Black")
            if player not in (white, black):
                continue
            moves = [move.uci() for move in game.mainline_moves()]
            games.append((game.board().fen(), moves, chess.WHITE if white == player else chess.BLACK,
                          black if white == player else white))
    return games


def plies(start, moves):
    """(position key before the move, move, side to move) for each move of a game."""
    board = chess.Board(start)
    out = []
    for uci in moves:
        out.append((position_key(board.fen()), uci, board.turn))
        board.push_uci(uci)
    return out


class Judge:
    """Stockfish evaluations of every position of a game, from the side to move's view."""

    def __init__(self, path, depth, jobs):
        self.limit = chess.engine.Limit(depth=depth)
        self.engines = [chess.engine.SimpleEngine.popen_uci(path) for _ in range(jobs)]
        self.free = queue.Queue()
        for engine in self.engines:
            engine.configure({"Threads": 1, "Hash": 16})
            self.free.put(engine)

    def evaluate(self, engine, board):
        if board.is_checkmate():
            return -1000
        if board.is_game_over():
            return 0
        score = engine.analyse(board, self.limit)["score"].pov(board.turn)
        if score.is_mate():
            return 1000 if score.mate() > 0 else -1000
        return max(-1000, min(1000, score.score()))

    def game(self, start, moves):
        engine = self.free.get()
        try:
            board = chess.Board(start)
            evals = [self.evaluate(engine, board)]
            for uci in moves:
                board.push_uci(uci)
                evals.append(self.evaluate(engine, board))
            return evals
        finally:
            self.free.put(engine)

    def close(self):
        for engine in self.engines:
            engine.quit()


def judged_loss(evals, i):
    """The win% the move from position i cost its mover, or None if the game was decided."""
    before, after = evals[i], -evals[i + 1]
    if abs(before) > DECIDED:
        return None
    return win_pct(before) - win_pct(after)


def rate(part, whole):
    return round(100 * part / whole, 2) if whole else None


def summarise(path, player, judge):
    games = read_games(path, player)
    stem = os.path.splitext(os.path.basename(path))[0]
    records = load_log(os.path.join(os.path.dirname(path), "log-" + stem))
    opponents = sorted({opponent for *_, opponent in games})
    evals = (list(ThreadPoolExecutor(len(judge.engines)).map(lambda g: judge.game(g[0], g[1]), games))
             if judge else [None] * len(games))

    moves = logged = traps = replied = top1 = 0
    predicted = {"all": 0.0, "traps": 0.0}
    actual = {"all": 0, "traps": 0}
    trap_replies = 0
    losses = {"opponent": [], "opponent after traps": [], "opponent after other logged moves": [],
              "trickster": []}
    for (start, game_moves, colour, _), game_evals in zip(games, evals):
        line = plies(start, game_moves)
        after_trap = None   # was the Trickster's last move a trap? None: not logged
        for i, (key, uci, turn) in enumerate(line):
            loss = judged_loss(game_evals, i) if game_evals else None
            if turn != colour:
                if loss is not None:
                    losses["opponent"].append(loss)
                    if after_trap is not None:
                        losses["opponent after traps" if after_trap
                               else "opponent after other logged moves"].append(loss)
                continue
            if loss is not None:
                losses["trickster"].append(loss)
            moves += 1
            record = records.get((key, uci))
            after_trap = None
            if record is None:
                continue
            logged += 1
            is_trap = record["candidates"][0][0] != record["played"]
            traps += is_trap
            after_trap = is_trap
            falls = {reply for reply, _, gain in record["replies"] if gain >= FALL}
            chance = sum(c for _, c, gain in record["replies"] if gain >= FALL) / 1000
            predicted["all"] += chance
            if is_trap:
                predicted["traps"] += chance
            if i + 1 < len(line):
                reply = line[i + 1][1]
                replied += 1
                top1 += bool(record["replies"]) and record["replies"][0][0] == reply
                fell = reply in falls
                actual["all"] += fell
                if is_trap:
                    actual["traps"] += fell
                    trap_replies += 1

    summary = {
        "pgn": path, "player": player, "opponents": opponents, "games": len(games),
        "moves": moves, "logged": logged, "traps": traps, "trap_rate": rate(traps, logged),
        "model_top1": rate(top1, replied),
        "falls_predicted": {k: round(v, 1) for k, v in predicted.items()},
        "falls_actual": actual,
        "fall_rate": {"after traps": rate(actual["traps"], trap_replies),
                      "after other logged moves": rate(actual["all"] - actual["traps"], replied - trap_replies)},
    }
    if judge:
        summary["judge"] = {
            who: {"moves": len(xs), "blunder_rate": rate(sum(x >= BLUNDER for x in xs), len(xs)),
                  "mean_loss": round(sum(max(0.0, x) for x in xs) / len(xs), 2) if xs else None}
            for who, xs in losses.items()}
    return summary


def report(s):
    print(f"{os.path.basename(s['pgn'])}: {s['player']} vs {', '.join(s['opponents'])}, {s['games']} games")
    print(f"  moves {s['moves']}, logged {s['logged']}, traps {s['traps']} ({s['trap_rate']} %)")
    if s["logged"]:
        p, a = s["falls_predicted"], s["falls_actual"]
        print(f"  model top-1 on replies {s['model_top1']} %")
        print(f"  falls (>= {FALL} cp): all moves predicted {p['all']} actual {a['all']};"
              f" traps predicted {p['traps']} actual {a['traps']}")
        r = s["fall_rate"]
        print(f"  fall rate after traps {r['after traps']} %, after other logged moves {r['after other logged moves']} %")
    for who, j in s.get("judge", {}).items():
        print(f"  judge, {who}: {j['moves']} moves, blunders {j['blunder_rate']} %, mean loss {j['mean_loss']} pp")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--player", default="L10", help="the Trickster's name in the PGNs (default: L10)")
    ap.add_argument("--engine", default=os.environ.get("STOCKFISH", "stockfish"),
                    help="Stockfish for the judge (default: STOCKFISH or stockfish on PATH)")
    ap.add_argument("--depth", type=int, default=10, help="the judge's depth (default: 10)")
    ap.add_argument("--jobs", type=int, default=8, help="judge engines run at once (default: 8)")
    ap.add_argument("--no-judge", action="store_true", help="skip the Stockfish judge")
    ap.add_argument("--out", help="also write the summaries as JSON here")
    ap.add_argument("pgns", nargs="+")
    a = ap.parse_args()

    judge = None if a.no_judge else Judge(a.engine, a.depth, a.jobs)
    try:
        summaries = []
        for path in a.pgns:
            summaries.append(summarise(path, a.player, judge))
            report(summaries[-1])
    finally:
        if judge:
            judge.close()
    if a.out:
        with open(a.out, "w", encoding="utf-8") as fh:
            json.dump({"fall_cp": FALL, "judge_depth": None if a.no_judge else a.depth,
                       "matches": summaries}, fh, indent=2)


if __name__ == "__main__":
    main()
