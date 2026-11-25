"""Habit statistics for VBKN vs his opponents (baseline) from chess.com PGNs (5+0 games only)."""
import os
from collections import Counter, defaultdict

import chess
import chess.pgn

FILES = [os.path.join(os.path.dirname(os.path.abspath(__file__)), f) for f in ("vbkn-white.pgn", "vbkn-black.pgn")]
ME = "VBKN"
VAL = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9, chess.KING: 0}


def is_blitz_5_0(g):
    return g.headers.get("TimeControl") == "300"


def load():
    out = []
    for p in FILES:
        with open(p, encoding="utf-8-sig") as f:
            while (g := chess.pgn.read_game(f)):
                if is_blitz_5_0(g):
                    out.append(g)
    return out


def non_pawn(board, color):
    return sum(VAL[p.piece_type] for p in board.piece_map().values()
               if p.color == color and p.piece_type not in (chess.PAWN, chess.KING))


def phase(board):
    total = non_pawn(board, chess.WHITE) + non_pawn(board, chess.BLACK)
    queens = len(board.pieces(chess.QUEEN, chess.WHITE)) + len(board.pieces(chess.QUEEN, chess.BLACK))
    if total <= 26 or (queens == 0 and total <= 30):
        return "end"
    return "mid"


def file_status(board, f, color):
    own = any(chess.square_file(s) == f for s in board.pieces(chess.PAWN, color))
    opp = any(chess.square_file(s) == f for s in board.pieces(chess.PAWN, not color))
    return "open" if not own and not opp else "half" if not own else "closed"


def attackers_value_min(board, sq, color):
    vals = [VAL[board.piece_type_at(s)] or 100 for s in board.attackers(color, sq)]
    return min(vals) if vals else None


def main():
    games = load()
    S = {who: defaultdict(Counter) for who in ("me", "opp")}
    N = {who: Counter() for who in ("me", "opp")}
    openings = {"white": Counter(), "black_vs": defaultdict(Counter), "w_seq": Counter(), "b_seq": Counter()}
    results = Counter()
    imbal = []
    for g in games:
        h = g.headers
        my = chess.WHITE if h["White"] == ME else chess.BLACK
        res = h["Result"]
        score = 1 if (res == "1-0") == (my == chess.WHITE) and res != "1/2-1/2" else 0.5 if res == "1/2-1/2" else 0
        results[("W" if my else "B", score)] += 1
        results[("term", h.get("Termination", "").replace(ME, "ME").split(" by ")[-1])] += 1
        board = g.board()
        moves = list(g.mainline_moves())
        # opening sequences
        san = []
        b2 = g.board()
        for m in moves[:10]:
            san.append(b2.san(m)); b2.push(m)
        if my == chess.WHITE:
            openings["white"][san[0] if san else "-"] += 1
            openings["w_seq"][" ".join(san[0:6:2])] += 1
        else:
            if san:
                openings["black_vs"][san[0]][" ".join(san[1:6:2])] += 1
            openings["b_seq"][" ".join(san[1:8:2])] += 1
        castled = {chess.WHITE: None, chess.BLACK: None}
        first_king_move = {chess.WHITE: None, chess.BLACK: None}
        seen_imbal = False
        for ply, m in enumerate(moves):
            mover = board.turn
            who = "me" if mover == my else "opp"
            st = S[who]
            n = N[who]
            ph = phase(board)
            piece = board.piece_at(m.from_square)
            pt = piece.piece_type
            fullmove = board.fullmove_number
            n["moves"] += 1
            n["moves_" + ph] += 1
            st["piece_moved_" + ph][chess.piece_name(pt)] += 1
            # exchanges: equal-value capture options available
            legal = list(board.legal_moves)
            eq_opts = [x for x in legal if board.is_capture(x) and not board.is_en_passant(x)
                       and board.piece_type_at(x.to_square) is not None
                       and VAL[board.piece_type_at(x.to_square)] == VAL[board.piece_type_at(x.from_square)]
                       and board.piece_type_at(x.from_square) != chess.PAWN
                       and board.is_attacked_by(not mover, x.to_square)]
            if eq_opts:
                n["eq_trade_opp"] += 1
                if m in eq_opts:
                    n["eq_trade_taken"] += 1
                    st["eq_trade_piece"][chess.piece_name(pt)] += 1
            qtrade = [x for x in eq_opts if board.piece_type_at(x.from_square) == chess.QUEEN]
            if qtrade:
                n["q_trade_opp"] += 1
                if m in qtrade:
                    n["q_trade_taken"] += 1
            # recapture behaviour
            if board.move_stack:
                last = board.peek()
                if board.is_capture(m) and m.to_square == last.to_square:
                    n["recapture"] += 1
            # bishop for knight voluntary trades
            if board.is_capture(m) and not board.is_en_passant(m):
                victim = board.piece_type_at(m.to_square)
                if pt == chess.BISHOP and victim == chess.KNIGHT:
                    n["BxN"] += 1
                if pt == chess.KNIGHT and victim == chess.BISHOP:
                    n["NxB"] += 1
                if pt == chess.ROOK and victim in (chess.KNIGHT, chess.BISHOP) and board.is_attacked_by(not mover, m.to_square):
                    n["exch_sac"] += 1
                    st["exch_sac_detail"][f"{h['Link'][-11:]} {fullmove}"] += 1
            # castling
            if board.is_castling(m):
                side = "O-O" if board.is_kingside_castling(m) else "O-O-O"
                castled[mover] = fullmove
                st["castle"][side] += 1
                st["castle_move"][min(fullmove // 5 * 5, 30)] += 1
            elif pt == chess.KING:
                n["king_moves_" + ph] += 1
                if first_king_move[mover] is None:
                    first_king_move[mover] = fullmove
                    st["first_king_move"][min(fullmove // 5 * 5, 40)] += 1
                    if castled[mover] is None and ph == "mid":
                        n["king_walk_uncastled_mid"] += 1
                rel_rank = chess.square_rank(m.to_square) if mover == chess.WHITE else 7 - chess.square_rank(m.to_square)
                st["king_to_rank_" + ph][rel_rank + 1] += 1
            # rook placement
            if pt == chess.ROOK and not board.is_castling(m):
                to = m.to_square
                rel_rank = chess.square_rank(to) if mover == chess.WHITE else 7 - chess.square_rank(to)
                st["rook_file_status_" + ph][file_status(board, chess.square_file(to), mover)] += 1
                st["rook_rank_" + ph][rel_rank + 1] += 1
                st["rook_sq_" + ph][chess.square_name(to if mover == chess.WHITE else chess.square_mirror(to))] += 1
                if board.is_capture(m):
                    n["rook_captures"] += 1
                if rel_rank in (2, 3, 4) and ph == "mid" and not board.is_capture(m):
                    n["rook_lift"] += 1
                if fullmove <= 15:
                    n["rook_moves_early"] += 1
            # pawn habits
            if pt == chess.PAWN:
                f = chess.square_file(m.from_square)
                if fullmove <= 12:
                    st["early_pawn_file"]["abcdefgh"[f]] += 1
                if f in (0, 7, 6) and ph == "mid" and fullmove <= 20:
                    n["flank_pawn_early"] += 1
            # queen out early
            if pt == chess.QUEEN and fullmove <= 6:
                n["early_queen"] += 1
            # checks
            board.push(m)
            if board.is_check():
                n["checks_" + ph] += 1
            # imbalances: R vs minor
            if not seen_imbal:
                for c in (chess.WHITE, chess.BLACK):
                    r = len(board.pieces(chess.ROOK, c)) - len(board.pieces(chess.ROOK, not c))
                    mnr = (len(board.pieces(chess.KNIGHT, c)) + len(board.pieces(chess.BISHOP, c))
                           - len(board.pieces(chess.KNIGHT, not c)) - len(board.pieces(chess.BISHOP, not c)))
                    q = len(board.pieces(chess.QUEEN, c)) - len(board.pieces(chess.QUEEN, not c))
                    if r == 1 and mnr == -1 and q == 0:
                        # check it persists 4 plies
                        seen_imbal = True
                        minor = "N" if len(board.pieces(chess.KNIGHT, not c)) > len(board.pieces(chess.KNIGHT, c)) else "B"
                        imbal.append(("me" if c == my else "opp", minor, phase(board), score, h["Link"], board.fullmove_number))
        for c in (chess.WHITE, chess.BLACK):
            who = "me" if c == my else "opp"
            N[who]["games"] += 1
            if castled[c] is None:
                N[who]["never_castled"] += 1
        N["me"]["plies_total"] += len(moves)

    print("RESULTS", sorted(results.items(), key=lambda kv: str(kv[0])))
    print("\nWHITE first move", openings["white"].most_common())
    print("WHITE first 3 moves", openings["w_seq"].most_common(12))
    print("\nBLACK replies by White's 1st move")
    for k, v in sorted(openings["black_vs"].items(), key=lambda kv: -sum(kv[1].values())):
        print(f"  1.{k} ({sum(v.values())}):", v.most_common(6))
    print("BLACK first 4 moves", openings["b_seq"].most_common(12))
    for who in ("me", "opp"):
        n, st = N[who], S[who]
        print(f"\n===== {who} =====  games {n['games']} moves {n['moves']} (mid {n['moves_mid']}, end {n['moves_end']})")
        pct = lambda a, b: f"{100 * n[a] / max(1, n[b]):.1f}%"
        print("equal-trade taken when available:", pct("eq_trade_taken", "eq_trade_opp"), n["eq_trade_taken"], "/", n["eq_trade_opp"])
        print("queen trade taken when available:", pct("q_trade_taken", "q_trade_opp"), n["q_trade_taken"], "/", n["q_trade_opp"])
        print("equal trades by piece:", dict(st["eq_trade_piece"]))
        print("BxN", n["BxN"], "NxB", n["NxB"], "exchange sacs (R takes defended minor)", n["exch_sac"])
        print("castle:", dict(st["castle"]), "never castled:", pct("never_castled", "games"), "castle move bucket:", sorted(st["castle_move"].items()))
        print("first non-castle king move bucket:", sorted(st["first_king_move"].items()), "uncastled king walks in mid:", n["king_walk_uncastled_mid"])
        print("king moves per 100 moves: mid", f"{100 * n['king_moves_mid'] / max(1, n['moves_mid']):.1f}", "end", f"{100 * n['king_moves_end'] / max(1, n['moves_end']):.1f}")
        print("king dest rank mid", sorted(st["king_to_rank_mid"].items()), "end", sorted(st["king_to_rank_end"].items()))
        for ph in ("mid", "end"):
            print(f"piece share {ph}:", {k: f"{100 * v / max(1, n['moves_' + ph]):.0f}%" for k, v in st["piece_moved_" + ph].most_common()})
            print(f"rook file status {ph}:", dict(st["rook_file_status_" + ph]), "rank", sorted(st["rook_rank_" + ph].items()))
            print(f"rook squares {ph} (white-relative):", st["rook_sq_" + ph].most_common(10))
            print(f"checks per 100 {ph}:", f"{100 * n['checks_' + ph] / max(1, n['moves_' + ph]):.1f}")
        print("rook lifts (mid, rank 3-5 non-capture):", n["rook_lift"], "rook moves by move 15:", n["rook_moves_early"])
        print("early pawn files (<=12):", sorted(st["early_pawn_file"].items()), "flank pawn (a/g/h by 20):", n["flank_pawn_early"])
        print("early queen moves (<=6):", n["early_queen"])
    print("\nR vs minor imbalances (who has the rook, minor, phase, VBKN score):")
    c = Counter((w, mn) for w, mn, *_ in imbal)
    print(c)
    for w in ("me", "opp"):
        sc = [s for ww, _, _, s, _, _ in imbal if ww == w]
        if sc:
            print(f"  {w} has rook: n={len(sc)} VBKN score {100 * sum(sc) / len(sc):.0f}%")


if __name__ == "__main__":
    main()
