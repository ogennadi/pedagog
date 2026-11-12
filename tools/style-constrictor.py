"""Compare space-taking and constriction in PGNs.

    python tools/style-constrictor.py [--json out.json] match.pgn [...]

Sample positions after each player's own movetext moves, while at least 20
pieces remain (the same middlegame proxy as style.py). For each player:

* space: distinct squares in the enemy half attacked by that player's pieces
  or pawns, excluding squares attacked by an enemy pawn. Occupied squares count.
* space edge: the player's space minus the opponent's, in the same position.
* opponent mobility: distinct from/to pairs among the opponent's pseudo-legal
  replies. Checks and pins are ignored; promotions to different pieces count
  once. Castling still follows python-chess's castling rules.
* pawn advance: average ranks advanced from the starting pawn rank, per
  surviving pawn. Promoted pawns no longer count.

Higher space and space edge, and lower opponent mobility, are possible signs of
constriction, not proof of good play. Compare against a baseline with similar
opponents, openings and game lengths: captures, checks and pawn exchanges can
affect these proxies. No composite score or classification is calibrated.
Opening-book moves omitted from PGN movetext are not sampled.
"""
import argparse
import collections
import json

import chess
import chess.pgn


def space(board, colour):
    enemy_pawn_attacks = 0
    for square in board.pieces(chess.PAWN, not colour):
        enemy_pawn_attacks |= board.attacks_mask(square)
    attacks = 0
    for square in chess.scan_forward(board.occupied_co[colour]):
        attacks |= board.attacks_mask(square)
    enemy_half = chess.BB_RANK_5 | chess.BB_RANK_6 | chess.BB_RANK_7 | chess.BB_RANK_8
    if colour == chess.BLACK:
        enemy_half = chess.BB_RANK_1 | chess.BB_RANK_2 | chess.BB_RANK_3 | chess.BB_RANK_4
    return chess.popcount(attacks & enemy_half & ~enemy_pawn_attacks)


def opponent_mobility(board):
    # After the sampled move, the opponent is the side to move.
    return len({(move.from_square, move.to_square) for move in board.generate_pseudo_legal_moves()})


def pawn_advance(board, colour):
    pawns = board.pieces(chess.PAWN, colour)
    if not pawns:
        return None
    ranks = [chess.square_rank(square) for square in pawns]
    return sum(rank - 1 if colour == chess.WHITE else 6 - rank for rank in ranks) / len(ranks)


def analyse(files):
    players = collections.defaultdict(collections.Counter)
    games = 0
    for path in files:
        with open(path, encoding="utf-8-sig") as source:
            while (game := chess.pgn.read_game(source)) is not None:
                if game.errors:
                    raise ValueError(f"{path}: invalid PGN game {games + 1}: {game.errors[0]}")
                games += 1
                names = {chess.WHITE: game.headers["White"], chess.BLACK: game.headers["Black"]}
                for colour in (chess.WHITE, chess.BLACK):
                    players[names[colour]]["games"] += 1
                board = game.board()
                for move in game.mainline_moves():
                    colour = board.turn
                    board.push(move)
                    stats = players[names[colour]]
                    stats["moves"] += 1
                    if len(board.piece_map()) < 20:
                        continue
                    own_space = space(board, colour)
                    stats["positions"] += 1
                    stats["space"] += own_space
                    stats["space_edge"] += own_space - space(board, not colour)
                    stats["opponent_mobility"] += opponent_mobility(board)
                    advance = pawn_advance(board, colour)
                    if advance is not None:
                        stats["pawn_positions"] += 1
                        stats["pawn_advance"] += advance
    if not games:
        raise ValueError("no games found in the supplied PGNs")

    summary = {}
    for name, stats in sorted(players.items()):
        positions = stats["positions"]
        pawn_positions = stats["pawn_positions"]
        summary[name] = {
            "games": stats["games"],
            "moves": stats["moves"],
            "positions": positions,
            "space": round(stats["space"] / positions, 2) if positions else None,
            "space_edge": round(stats["space_edge"] / positions, 2) if positions else None,
            "opponent_mobility": round(stats["opponent_mobility"] / positions, 2) if positions else None,
            "pawn_positions": pawn_positions,
            "pawn_advance": round(stats["pawn_advance"] / pawn_positions, 2) if pawn_positions else None,
        }
    return {"files": len(files), "players": summary}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--json", help="also write the statistics per player to this file")
    parser.add_argument("files", nargs="+", help="PGN files to analyse")
    args = parser.parse_args()
    try:
        summary = analyse(args.files)
    except (OSError, ValueError) as error:
        parser.exit(1, f"{parser.prog}: {error}\n")

    for name, stats in summary["players"].items():
        print(f"{name}: {stats['games']} games, {stats['moves']} moves, {stats['positions']} sampled positions")
        for key, label in (("space", "space"), ("space_edge", "space edge"),
                           ("opponent_mobility", "opponent mobility"), ("pawn_advance", "pawn advance")):
            value = stats[key]
            print(f"  {label + ':':<19} {value:.2f}" if value is not None else f"  {label + ':':<19} n/a")
    if args.json:
        with open(args.json, "w", encoding="utf-8") as output:
            json.dump(summary, output, indent=2)
            output.write("\n")


if __name__ == "__main__":
    main()
