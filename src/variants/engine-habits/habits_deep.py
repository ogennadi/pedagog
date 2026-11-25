"""Deeper VBKN habit probes (5+0 games only): trades vs material, king squares, R-vs-minor, rook 7th, signature moves."""
import os
from collections import Counter, defaultdict

import chess
import chess.pgn

FILES = [os.path.join(os.path.dirname(os.path.abspath(__file__)), f) for f in ("vbkn-white.pgn", "vbkn-black.pgn")]
ME = "VBKN"
VAL = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9, chess.KING: 0}


def is_blitz_5_0(g):
    return g.headers.get("TimeControl") == "300"


def material(board, c):
    return sum(VAL[p.piece_type] for p in board.piece_map().values() if p.color == c)


def non_pawn(board):
    return sum(VAL[p.piece_type] for p in board.piece_map().values() if p.piece_type not in (chess.PAWN, chess.KING))


def rel(sq, c):
    return sq if c == chess.WHITE else chess.square_mirror(sq)


def main():
    games = []
    for p in FILES:
        with open(p, encoding="utf-8-sig") as f:
            while (g := chess.pgn.read_game(f)):
                if is_blitz_5_0(g):
                    games.append(g)
    T = {w: Counter() for w in ("me", "opp")}
    Ksq = {w: Counter() for w in ("me", "opp")}
    sig = {w: Counter() for w in ("me", "opp")}
    sig_first = {w: Counter() for w in ("me", "opp")}
    rvm = []
    white_lines = defaultdict(Counter)
    for g in games:
        my = chess.WHITE if g.headers["White"] == ME else chess.BLACK
        res = g.headers["Result"]
        score = 0.5 if res == "1/2-1/2" else 1.0 if (res == "1-0") == (my == chess.WHITE) else 0.0
        board = g.board()
        moves = list(g.mainline_moves())
        b = g.board(); sans = []
        for m in moves[:12]:
            sans.append(b.san(m)); b.push(m)
        if my == chess.WHITE and len(sans) >= 2:
            white_lines[sans[0] + " " + sans[1]][" ".join(sans[2:8:2])] += 1
        imb_run = 0; imb_key = None; recorded = False
        reached7 = {chess.WHITE: None, chess.BLACK: None}
        seen_sig = {w: set() for w in ("me", "opp")}
        for ply, m in enumerate(moves):
            mover = board.turn; who = "me" if mover == my else "opp"
            t = T[who]
            diff = material(board, mover) - material(board, not mover)
            bucket = "ahead" if diff >= 2 else "behind" if diff <= -2 else "level"
            npm = non_pawn(board)
            ph = "end" if npm <= 26 else "mid"
            pt = board.piece_type_at(m.from_square)
            # equal-trade propensity by material state
            eq = [x for x in board.legal_moves if board.is_capture(x) and not board.is_en_passant(x)
                  and board.piece_type_at(x.from_square) != chess.PAWN
                  and VAL[board.piece_type_at(x.to_square)] == VAL[board.piece_type_at(x.from_square)]
                  and board.is_attacked_by(not mover, x.to_square)]
            if eq:
                t["opp_" + bucket] += 1
                if m in eq:
                    t["take_" + bucket] += 1
            # signature move per piece/square (relative to own side), first 15 moves
            if board.fullmove_number <= 15 and not board.is_castling(m):
                key = chess.piece_symbol(pt).upper() + chess.square_name(rel(m.to_square, mover))
                if key not in seen_sig[who]:
                    seen_sig[who].add(key); sig[who][key] += 1
            if pt == chess.KING and not board.is_castling(m):
                Ksq[who][(ph, chess.square_name(rel(m.to_square, mover)))] += 1
            # rook on 7th first reached
            if pt == chess.ROOK and chess.square_rank(rel(m.to_square, mover)) == 6 and reached7[mover] is None:
                reached7[mover] = board.fullmove_number
            # escape luft timing: first h/a pawn single push
            board.push(m)
            # persistent R vs minor, queens off or on
            key = None
            for c in (chess.WHITE, chess.BLACK):
                r = len(board.pieces(chess.ROOK, c)) - len(board.pieces(chess.ROOK, not c))
                n = len(board.pieces(chess.KNIGHT, c)) - len(board.pieces(chess.KNIGHT, not c))
                bb = len(board.pieces(chess.BISHOP, c)) - len(board.pieces(chess.BISHOP, not c))
                q = len(board.pieces(chess.QUEEN, c)) - len(board.pieces(chess.QUEEN, not c))
                if r == 1 and q == 0 and n + bb == -1:
                    key = ("me" if c == my else "opp", "N" if n == -1 else "B",
                           material(board, c) - material(board, not c),
                           len(board.pieces(chess.QUEEN, c)) == 0 and len(board.pieces(chess.ROOK, c)) == 1)
            if key == imb_key and key is not None:
                imb_run += 1
            else:
                imb_key, imb_run = key, 1 if key else 0
            if imb_run == 6 and not recorded:
                recorded = True
                rvm.append((*key, score, g.headers["Link"], board.fullmove_number))
        for c in (chess.WHITE, chess.BLACK):
            who = "me" if c == my else "opp"
            T[who]["games"] += 1
            if reached7[c] is not None:
                T[who]["rook7"] += 1
                T[who]["rook7_move_sum"] += reached7[c]
    for who in ("me", "opp"):
        t = T[who]
        print(f"=== {who}")
        for bk in ("ahead", "level", "behind"):
            print(f"  equal trade taken when {bk}: {100 * t['take_' + bk] / max(1, t['opp_' + bk]):.1f}% ({t['take_' + bk]}/{t['opp_' + bk]})")
        print(f"  rook reached 7th in {100 * t['rook7'] / t['games']:.0f}% of games, avg move {t['rook7_move_sum'] / max(1, t['rook7']):.1f}")
        print("  top early moves (first 15, own-relative):", sig[who].most_common(40))
        print("  king squares mid:", [(s, n) for (ph, s), n in Ksq[who].most_common() if ph == "mid"][:10])
        print("  king squares end:", [(s, n) for (ph, s), n in Ksq[who].most_common() if ph == "end"][:12])
    print("\n=== signature: moves where me rate / opp rate is high (count>=25)")
    rows = []
    for k, v in sig["me"].items():
        o = sig["opp"].get(k, 0)
        if v >= 25:
            rows.append((v / max(1, o), k, v, o))
    for r, k, v, o in sorted(rows, reverse=True)[:25]:
        print(f"  {k}: me {v} opp {o} ratio {r:.2f}")
    print("  ...and lowest ratio:")
    rows2 = [(sig['me'].get(k, 0) / v, k, sig['me'].get(k, 0), v) for k, v in sig["opp"].items() if v >= 25]
    for r, k, v, o in sorted(rows2)[:15]:
        print(f"  {k}: me {v} opp {o} ratio {r:.2f}")
    print("\n=== WHITE lines (1st+2nd ply -> his moves 2-4)")
    for k, v in sorted(white_lines.items(), key=lambda kv: -sum(kv[1].values()))[:12]:
        print(f"  {k} ({sum(v.values())}):", v.most_common(4))
    print("\n=== persistent (6+ plies) R vs minor")
    agg = defaultdict(list)
    for who, mn, mat, pure, sc, link, mv in rvm:
        agg[(who, mn)].append(sc)
    for k, v in agg.items():
        print(f"  {k}: n={len(v)} VBKN score {100 * sum(v) / len(v):.0f}%")
    for r in rvm:
        if r[1] == "N":
            print("   ", r)


if __name__ == "__main__":
    main()
