"""How much each player in some PGNs plays like a hedgehog / hippo.
usage: python hedgehog_check.py <pgn> ...

Per player and colour, the share of games showing each sign. Ranks are counted from the
player's own side, and "move N" is the player's own Nth move.
- shell: 4+ of its pawns on its 3rd rank after move 15
- skeleton: how many of its a, b, d, e, g and h pawns stand on its 3rd rank after move 15 (mean)
- fianchetto: a bishop on b2 or g2 (b7, g7 for Black) with its pawn on b3 or g3, after
  move 15; "double" needs both
- stays back: none of its pawns reaches its 5th rank during moves 1-20
- spring: of the shell games, those where a pawn of its then moves from its 3rd rank to its
  4th (the break, as ...b5 or ...d5) in moves 16-40
- hedgehog: shell, stays back and at least one fianchetto
Games over before the player's 15th move are left out."""
import sys
from collections import defaultdict
import chess, chess.pgn

SNAP, BACK, SPRING_END = 15, 20, 40
SKELETON_FILES = [0, 1, 3, 4, 6, 7]


def rel_rank(sq, colour):
    r = chess.square_rank(sq)
    return r + 1 if colour == chess.WHITE else 8 - r


def rel_sq(file, rank, colour):
    return chess.square(file, rank - 1 if colour == chess.WHITE else 8 - rank)


def pawns(board, colour):
    return board.pieces(chess.PAWN, colour)


def fianchettos(board, colour):
    return sum(board.piece_at(rel_sq(f, 2, colour)) == chess.Piece(chess.BISHOP, colour)
               and board.piece_at(rel_sq(f, 3, colour)) == chess.Piece(chess.PAWN, colour)
               for f in (1, 6))


def signs(game, colour):
    board, move_no, snap, advanced, spring = game.board(), 0, None, False, False
    for move in game.mainline_moves():
        mover = board.turn
        piece = board.piece_type_at(move.from_square)
        from_rank = rel_rank(move.from_square, mover)
        board.push(move)
        if mover != colour:
            continue
        move_no += 1
        if move_no <= BACK and any(rel_rank(sq, colour) >= 5 for sq in pawns(board, colour)):
            advanced = True
        if move_no == SNAP:
            third = [sq for sq in pawns(board, colour) if rel_rank(sq, colour) == 3]
            snap = {
                "shell": len(third) >= 4,
                "skeleton": sum(chess.square_file(sq) in SKELETON_FILES for sq in third),
                "fianchettos": fianchettos(board, colour),
            }
        if snap and snap["shell"] and SNAP < move_no <= SPRING_END and piece == chess.PAWN \
                and from_rank == 3 and rel_rank(move.to_square, colour) == 4:
            spring = True
    if not snap:
        return None
    return {
        "shell": snap["shell"], "skeleton": snap["skeleton"],
        "fianchetto": snap["fianchettos"] >= 1, "double": snap["fianchettos"] == 2,
        "stays back": not advanced, "spring": spring,
        "hedgehog": snap["shell"] and not advanced and snap["fianchettos"] >= 1,
    }


def main():
    rows = defaultdict(list)
    for path in sys.argv[1:]:
        with open(path, encoding="utf-8", errors="replace") as f:
            while (game := chess.pgn.read_game(f)) is not None:
                for colour, name in ((chess.WHITE, game.headers["White"]), (chess.BLACK, game.headers["Black"])):
                    s = signs(game, colour)
                    if s:
                        rows[(name, "white" if colour else "black")].append(s)
                        rows[(name, "both")].append(s)
    pct = lambda ss, k: 100 * sum(s[k] for s in ss) / len(ss)
    print(f"{'player':14s} {'colour':6s} {'games':>5s} {'shell':>6s} {'skel':>5s} {'fian':>5s} "
          f"{'double':>6s} {'back':>5s} {'spring':>6s} {'HEDGEHOG':>8s}")
    for (name, colour), ss in sorted(rows.items()):
        shells = [s for s in ss if s["shell"]]
        spring = f"{pct(shells, 'spring'):5.0f}%" if shells else "     -"
        print(f"{name:14s} {colour:6s} {len(ss):5d} {pct(ss, 'shell'):5.1f}% "
              f"{sum(s['skeleton'] for s in ss) / len(ss):5.2f} {pct(ss, 'fianchetto'):4.0f}% "
              f"{pct(ss, 'double'):5.1f}% {pct(ss, 'stays back'):4.0f}% {spring} {pct(ss, 'hedgehog'):7.1f}%")


main()
