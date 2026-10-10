"""Blunder rate per skill level, judged by Stockfish.

    python tools/blunders.py [--engine PATH] [--depth 12] [--games-per-level 60] [--out docs/blunders.json] [pgn files...]

Assumptions (stated so they can be argued with):
  * The judge is Stockfish at a fixed depth (default 12), evaluating the position before and
    after each move from the mover's point of view.
  * Centipawns are turned into a win probability with Lichess's formula
        win% = 50 + 50 * (2 / (1 + exp(-0.00368208 * cp)) - 1)
    and a move is a *blunder* if it costs >= 20 percentage points, a *mistake* if it costs
    >= 10 (and < 20). Mate scores count as +-1000 cp.
  * Moves in positions already decided (|eval| > 600 cp before the move) are not counted:
    a losing side's "blunders" there are meaningless, and a winning side's are harmless.
  * Only moves by the Pedagog side (players named L<k>) are judged; its opponent's moves are
    not. Book moves are not in the PGN movetext (cutechess records the post-book FEN), so
    every judged move is one the engine chose.
"""
import argparse, glob, json, math, os, sys
import chess, chess.engine, chess.pgn

HERE = os.path.dirname(os.path.abspath(__file__))

def win_pct(cp):
    return 50 + 50 * (2 / (1 + math.exp(-0.00368208 * cp)) - 1)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", default=os.environ.get("STOCKFISH", "stockfish"),
                    help="Stockfish UCI executable (default: STOCKFISH or stockfish on PATH)")
    ap.add_argument("--depth", type=int, default=12)
    ap.add_argument("--games-per-level", type=int, default=60)
    ap.add_argument("--levels", default="", help="comma-separated levels to judge (default: all found)")
    ap.add_argument("--merge", nargs="*", help="merge these per-level JSON files into --out instead of judging")
    ap.add_argument("--out", default=os.path.join(HERE, "..", "docs", "blunders.json"))
    ap.add_argument("files", nargs="*")
    a = ap.parse_args()

    if a.merge:
        merged = None
        for f in a.merge:
            with open(f) as fh:
                part = json.load(fh)
            if merged is None:
                merged = part
            else:
                merged["levels"].update(part["levels"])
        merged["levels"] = dict(sorted(merged["levels"].items(), key=lambda kv: int(kv[0])))
        with open(a.out, "w") as fh:
            json.dump(merged, fh, indent=2)
        print("merged", len(merged["levels"]), "levels into", a.out)
        return

    files = a.files or sorted(glob.glob(os.path.join(HERE, "out", "*.pgn")))
    wanted = {int(x) for x in a.levels.split(",") if x}

    # Gather games per level, spreading over files so one opponent does not dominate.
    per_level = {}
    for f in files:
        with open(f, encoding="utf-8", errors="replace") as fh:
            while True:
                game = chess.pgn.read_game(fh)
                if game is None:
                    break
                for colour in ("White", "Black"):
                    name = game.headers.get(colour, "")
                    if name.startswith("L") and name[1:].isdigit() and (not wanted or int(name[1:]) in wanted):
                        per_level.setdefault(int(name[1:]), []).append((game, colour == "White"))

    engine = chess.engine.SimpleEngine.popen_uci(a.engine)
    engine.configure({"Threads": 1, "Hash": 64})
    limit = chess.engine.Limit(depth=a.depth)

    def evaluate(board):
        info = engine.analyse(board, limit)
        score = info["score"].pov(board.turn)
        if score.is_mate():
            return 1000 if score.mate() > 0 else -1000
        return max(-1000, min(1000, score.score()))

    results = {}
    for level in sorted(per_level):
        games = per_level[level]
        # Take an even spread of games across the list.
        step = max(1, len(games) // a.games_per_level)
        chosen = games[::step][: a.games_per_level]
        moves = blunders = mistakes = 0
        total_loss = 0.0
        for game, white in chosen:
            board = game.board()
            for mv in game.mainline_moves():
                mover_is_level = board.turn == (chess.WHITE if white else chess.BLACK)
                if mover_is_level:
                    before = evaluate(board)
                    if abs(before) <= 600:
                        board.push(mv)
                        after = -evaluate(board)          # back to the mover's point of view
                        board.pop()
                        loss = win_pct(before) - win_pct(after)
                        moves += 1
                        total_loss += max(0.0, loss)
                        if loss >= 20: blunders += 1
                        elif loss >= 10: mistakes += 1
                board.push(mv)
        results[level] = {
            "games": len(chosen), "moves": moves,
            "blunder_rate": blunders / moves if moves else None,
            "mistake_rate": mistakes / moves if moves else None,
            "mean_loss_pct": total_loss / moves if moves else None,
        }
        r = results[level]
        print(f"L{level:<3} games {r['games']:>3}  moves {moves:>5}  blunders {100*r['blunder_rate']:5.1f}%  "
              f"mistakes {100*r['mistake_rate']:5.1f}%  mean loss {r['mean_loss_pct']:4.1f} pp", flush=True)
    engine.quit()

    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "w") as fh:
        json.dump({"judge": f"Stockfish depth {a.depth}", "blunder": ">= 20 pp win-probability loss",
                   "mistake": ">= 10 pp", "excluded": "|eval| > 600 cp before the move",
                   "levels": results}, fh, indent=2)

if __name__ == "__main__":
    main()
