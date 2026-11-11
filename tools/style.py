"""Playing-style statistics per player, from cutechess PGNs.

    python tools/style.py [--stockfish PATH --depth 10] tools/out/some-match.pgn [more.pgn ...]

For each player name found in the PGNs it reports, per 100 of that player's moves:
  * sacrificed: moves after which the mover's material balance (P=1, N=B=3, R=5, Q=9) is
    at least 2 pawns lower once the opponent has replied, and still that low a full move
    later, while the mover's own evaluation of its move (from the PGN comment) was no
    worse than -0.5: it gave the material up knowingly.
  * blundered: the same material loss when its own evaluation already said it was losing
    material, or when there is no evaluation.
  * checks given.
And per game or position:
  * king distance: the average Chebyshev distance from the player's knights, bishops,
    rooks and queens to the enemy king, in positions with at least 20 pieces (the
    middlegame). Lower means the pieces crowd the enemy king.
  * imbalance: the average absolute material difference over the game, in pawns.
  * swings: how often the evaluation crosses from >= +1.5 to <= -1.5 (or back) from the
    player's point of view, and the share of games with at least one such crossing
    ("see-saw games"). By default this uses the player's own evaluations from the PGN;
    with --stockfish, Stockfish judges every position at --depth instead.
  * the player's score, its decisive-game rate, and the average game length.
Only moves in the PGN movetext count; the opening book moves are not in it.
"""
import argparse, collections, re, sys
import chess, chess.engine, chess.pgn

VALUE = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9}
SWING = 1.5


def material(board, colour):
    return sum(VALUE[p.piece_type] for p in board.piece_map().values()
               if p.color == colour and p.piece_type in VALUE)


def balance(board, colour):
    return material(board, colour) - material(board, not colour)


def king_distance(board, colour):
    king = board.king(not colour)
    if king is None:
        return None
    ds = [chess.square_distance(sq, king) for sq, p in board.piece_map().items()
          if p.color == colour and p.piece_type in (chess.KNIGHT, chess.BISHOP, chess.ROOK, chess.QUEEN)]
    return sum(ds) / len(ds) if ds else None


def own_eval(comment):
    """The mover's evaluation in pawns from a cutechess comment such as '+1.33/5 0.49s'."""
    m = re.match(r"\s*([+-]?)(M?)(\d+(?:\.\d+)?)/", comment or "")
    if not m:
        return None
    value = 100.0 if m.group(2) else float(m.group(3))
    return -value if m.group(1) == "-" else value


def crossings(series):
    """How often a series of evaluations swings from >= +SWING to <= -SWING or back."""
    state, count = 0, 0
    for v in series:
        new = 1 if v >= SWING else -1 if v <= -SWING else 0
        if new and state and new != state:
            count += 1
        if new:
            state = new
    return count


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--stockfish", help="judge swings with this UCI engine instead of the PGN evaluations")
    ap.add_argument("--depth", type=int, default=10)
    ap.add_argument("files", nargs="+")
    a = ap.parse_args()
    judge = chess.engine.SimpleEngine.popen_uci(a.stockfish) if a.stockfish else None

    s = collections.defaultdict(collections.Counter)
    dist = collections.defaultdict(list)
    for path in a.files:
        with open(path, encoding="utf-8") as f:
            while (game := chess.pgn.read_game(f)) is not None:
                names = {chess.WHITE: game.headers["White"], chess.BLACK: game.headers["Black"]}
                result = game.headers.get("Result", "*")
                boards, evals = [game.board()], []
                for node in game.mainline():
                    b = boards[-1].copy(stack=False)
                    b.push(node.move)
                    boards.append(b)
                    evals.append(own_eval(node.comment))
                movers = [boards[i].turn for i in range(len(boards) - 1)]
                if judge:
                    white_view = []
                    for b in boards[1:]:
                        info = judge.analyse(b, chess.engine.Limit(depth=a.depth))
                        white_view.append(info["score"].white().score(mate_score=10000) / 100)
                imbalance = sum(abs(balance(b, chess.WHITE)) for b in boards) / len(boards)
                for colour in (chess.WHITE, chess.BLACK):
                    name = names[colour]
                    st = s[name]
                    st["games"] += 1
                    st["plies"] += len(boards) - 1
                    st["imbalance"] += imbalance
                    points = {"1-0": 1.0, "0-1": 0.0}.get(result, 0.5)
                    st["score"] += points if colour == chess.WHITE else 1 - points
                    st["decisive"] += result in ("1-0", "0-1")
                    if judge:
                        series = [v if colour == chess.WHITE else -v for v in white_view]
                    else:
                        series = [e for i, e in enumerate(evals) if movers[i] == colour and e is not None]
                    n = crossings(series)
                    st["swings"] += n
                    st["seesaw"] += n > 0
                    cooldown = 0
                    for i, mover in enumerate(movers):
                        if mover != colour:
                            continue
                        st["moves"] += 1
                        after = boards[i + 1]
                        st["checks"] += after.is_check()
                        if len(after.piece_map()) >= 20:
                            d = king_distance(after, colour)
                            if d is not None:
                                dist[name].append(d)
                        if i < cooldown:
                            continue
                        before = balance(boards[i], colour)
                        reply = boards[min(i + 2, len(boards) - 1)]
                        later = boards[min(i + 4, len(boards) - 1)]
                        if balance(reply, colour) <= before - 2 and balance(later, colour) <= before - 2:
                            knowingly = evals[i] is not None and evals[i] >= -0.5
                            st["sacrificed" if knowingly else "blundered"] += 1
                            cooldown = i + 4
    if judge:
        judge.quit()
    for name, st in sorted(s.items()):
        moves, games = max(1, st["moves"]), max(1, st["games"])
        kd = sum(dist[name]) / len(dist[name]) if dist[name] else float("nan")
        print(f"{name}: {st['games']} games, {st['moves']} moves")
        print(f"  sacrificed:    {100 * st['sacrificed'] / moves:.2f} per 100 moves"
              f" (blundered {100 * st['blundered'] / moves:.2f})")
        print(f"  checks given:  {100 * st['checks'] / moves:.2f} per 100 moves")
        print(f"  king distance: {kd:.2f} squares (middlegame)")
        print(f"  imbalance:     {st['imbalance'] / games:.2f} pawns (game average)")
        print(f"  swings:        {st['swings'] / games:.2f} per game; see-saw games {100 * st['seesaw'] / games:.0f}%"
              f" ({'Stockfish' if judge else 'own evals'})")
        print(f"  score:         {100 * st['score'] / games:.1f}%, decisive {100 * st['decisive'] / games:.0f}%,"
              f" {st['plies'] / games / 2:.0f} moves/game")


if __name__ == "__main__":
    sys.exit(main())
