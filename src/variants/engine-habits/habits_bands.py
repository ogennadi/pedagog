"""How VBKN's habits change as the Habits series climbs from ~400 to ~1900 (5+0 games only).

Bands follow the Habits playlist (https://www.chessjournal.com/chessbrah-habits/): 0-700, 700-1100,
1100-1550, 1550+. Columns are VBKN by rating band, then all his opponents as a baseline. Reuses the
probes in habits_probe.py; Stockfish results come from its per-game cache.
"""
import os
import sys
from collections import Counter

import chess

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from habits_probe import TACTIC_GAP, passed, run_engine, static, tactics  # noqa: E402
from habits_stats import ME, VAL, load  # noqa: E402

BANDS = [(0, 700, "<700"), (700, 1100, "700-1099"), (1100, 1550, "1100-1549"), (1550, 9999, "1550+")]
CENTER_DIST = [3, 2, 1, 0, 0, 1, 2, 3]
FOUR_KNIGHTS = ["e2e4", "e7e5", "g1f3", "b8c6", "b1c3", "g8f6"]


def my_color(g):
    return chess.WHITE if g.headers["White"] == ME else chess.BLACK


def rating(g):
    return int(g.headers["WhiteElo" if my_color(g) == chess.WHITE else "BlackElo"])


def material(board, c):
    return sum(VAL[p.piece_type] for p in board.piece_map().values() if p.color == c)


def rel_sq(sq, c):
    return sq if c == chess.WHITE else chess.square_mirror(sq)


def basics(games, who):
    """Counters for one side: who='me' (VBKN) or 'opp' (his opponents)."""
    s = Counter()
    for g in games:
        side = my_color(g) if who == "me" else not my_color(g)
        res = g.headers["Result"]
        s["score"] += 0.5 if res == "1/2-1/2" else 1.0 if (res == "1-0") == (side == chess.WHITE) else 0.0
        if res != "1/2-1/2" and (res == "1-0") != (side == chess.WHITE):
            s["losses"] += 1
            s["resigned"] += "resignation" in g.headers.get("Termination", "")
        s["opp_elo"] += int(g.headers["BlackElo" if side == chess.WHITE else "WhiteElo"])
        moves = list(g.mainline_moves())
        ucis = [m.uci() for m in moves]
        if ucis[:4] == FOUR_KNIGHTS[:4] and len(ucis) >= 6:
            s["4n_chance"] += 1
            mine = ucis[4] if side == chess.WHITE else ucis[5]
            s["4n"] += mine == (FOUR_KNIGHTS[4] if side == chess.WHITE else FOUR_KNIGHTS[5])
        if side == chess.WHITE:
            s["white"] += 1
            s["w_e4"] += ucis[:1] == ["e2e4"]
        elif len(ucis) > 1:
            if ucis[0] == "e2e4":
                s["vs_e4"] += 1
                s["vs_e4_e5"] += ucis[1] == "e7e5"
            if ucis[0] == "d2d4":
                s["vs_d4"] += 1
                s["vs_d4_nf6"] += ucis[1] == "g8f6"
        board = g.board()
        rook7 = castled = False
        for i, m in enumerate(moves):
            c = board.turn
            pt = board.piece_type_at(m.from_square)
            fm = board.fullmove_number
            if c != side:
                board.push(m)
                # did the opponent just put a minor on our b4/g4 (relative) that an a/h pawn can hit?
                if pt in (chess.KNIGHT, chess.BISHOP) and chess.square_name(rel_sq(m.to_square, side)) in ("b4", "g4") \
                        and i + 1 < len(moves):
                    hit = [x for x in board.legal_moves if board.piece_type_at(x.from_square) == chess.PAWN
                           and chess.square_file(x.from_square) in (0, 7) and not board.is_capture(x)
                           and m.to_square in chess.SquareSet(chess.BB_PAWN_ATTACKS[side][x.to_square])]
                    if hit:
                        s["kick_chance"] += 1
                        s["kick"] += moves[i + 1] in hit
                continue
            if board.is_castling(m):
                castled = True
                s["castle_short"] += board.is_kingside_castling(m)
            elif pt == chess.ROOK:
                if fm <= 15:
                    s["early_rook"] += 1
                if chess.square_rank(rel_sq(m.to_square, side)) == 6:
                    rook7 = True
                # rook move onto a file with a passed pawn, behind it (own passer: behind = own side)
                f = chess.square_file(m.to_square)
                for pc in (side, not side):
                    for ps in board.pieces(chess.PAWN, pc):
                        if chess.square_file(ps) == f and passed(board, ps, pc) and ps != m.to_square:
                            behind = (chess.square_rank(m.to_square) < chess.square_rank(ps)) == (pc == chess.WHITE)
                            s["rook_to_passer_file"] += 1
                            s["rook_behind_passer"] += behind
            if fm <= 6 and pt == chess.QUEEN:
                s["early_queen"] += 1
            # pawn captures: towards the centre when another pawn could take the same target
            if pt == chess.PAWN and board.is_capture(m):
                alt = [x for x in board.legal_moves if x.to_square == m.to_square and x.from_square != m.from_square
                       and board.piece_type_at(x.from_square) == chess.PAWN]
                if alt:
                    s["pawn_choice"] += 1
                    s["pawn_to_center"] += all(
                        CENTER_DIST[chess.square_file(m.to_square)] - CENTER_DIST[chess.square_file(m.from_square)]
                        <= CENTER_DIST[chess.square_file(x.to_square)] - CENTER_DIST[chess.square_file(x.from_square)]
                        for x in alt) and CENTER_DIST[chess.square_file(m.from_square)] > CENTER_DIST[chess.square_file(m.to_square)]
            diff = material(board, c) - material(board, not c)
            bucket = "ahead" if diff >= 2 else "behind" if diff <= -2 else "level"
            eq = [x for x in board.legal_moves if board.is_capture(x) and not board.is_en_passant(x)
                  and board.piece_type_at(x.from_square) != chess.PAWN
                  and VAL[board.piece_type_at(x.to_square)] >= VAL[board.piece_type_at(x.from_square)]
                  and board.is_attacked_by(not c, x.to_square)]
            if eq:
                s["eq_opp_" + bucket] += 1
                s["eq_take_" + bucket] += m in eq
            npm = sum(VAL[p.piece_type] for p in board.piece_map().values() if p.piece_type not in (chess.PAWN, chess.KING))
            if npm <= 26:
                s["end_moves"] += 1
                s["end_king"] += pt == chess.KING and not board.is_castling(m)
            s["moves"] += 1
            board.push(m)
            s["checks"] += board.is_check()
            if fm == 10 and c == side:
                s["pawn_down_m10"] += material(board, c) - material(board, not c) <= -1
        s["rook7"] += rook7
        s["never_castled"] += not castled
        s["plies"] += len(moves)
    return s


def column(gs, who, cache):
    b = basics(gs, who)
    st, _ = static(gs)
    me = st[who]
    t = tactics(gs, cache)[who]
    n = len(gs)
    pc = lambda a, d: f"{100 * a / d:.0f}%" if d else "-"
    tf = sum(v["found"] for v in t.values())
    tn = sum(v["n"] for v in t.values())
    return {
        "games": str(n),
        "score": pc(b["score"], n),
        "avg opponent rating": f"{b['opp_elo'] / n:.0f}",
        "losses by resignation": pc(b["resigned"], b["losses"]),
        "White plays 1.e4": pc(b["w_e4"], b["white"]),
        "Black 1.e4 e5": pc(b["vs_e4_e5"], b["vs_e4"]),
        "Black 1.d4 Nf6": pc(b["vs_d4_nf6"], b["vs_d4"]),
        "Four Knights when offered": pc(b["4n"], b["4n_chance"]),
        "early queen moves/game": f"{b['early_queen'] / n:.2f}",
        "pawn down at move 10": pc(b["pawn_down_m10"], n),
        "castles short": pc(b["castle_short"], n),
        "never castles": pc(b["never_castled"], n),
        "h3 by move 20": pc(n - me["no_h3_by_20"], n),
        "  ...of which after castling": pc(me["h3_after_castle"], n - me["no_h3_by_20"]),
        "kicks minor on b4/g4 with a/h pawn": pc(b["kick"], b["kick_chance"]),
        "pawn captures towards centre": pc(b["pawn_to_center"], b["pawn_choice"]),
        "g-pawn storm after O-O": pc(me["g4_storm"], me["castled"]),
        "rook moves by move 15/game": f"{b['early_rook'] / n:.2f}",
        "rook reaches 7th": pc(b["rook7"], n),
        "rook behind passer (on its file)": pc(b["rook_behind_passer"], b["rook_to_passer_file"]),
        "king share of endgame moves": pc(b["end_king"], b["end_moves"]),
        "checks per 100 moves": f"{100 * b['checks'] / b['moves']:.1f}",
        "takes equal+ trade when ahead": pc(b["eq_take_ahead"], b["eq_opp_ahead"]),
        "takes equal+ trade when level": pc(b["eq_take_level"], b["eq_opp_level"]),
        "takes equal+ trade when behind": pc(b["eq_take_behind"], b["eq_opp_behind"]),
        "BxN when available": pc(me["bxn_taken"], me["bxn_opp"]),
        "blocks enemy passer": pc(me["passer_block_taken"], me["passer_block_opp"]),
        "own isolani (avg)": f"{me['iso_sum'] / max(1, me['iso_pos']):.2f}",
        f"tactics found (+{TACTIC_GAP}cp)": pc(tf, tn),
        "  forks": pc(t["fork"]["found"], t["fork"]["n"]),
        "  free/winning captures": pc(t["free/winning capture"]["found"], t["free/winning capture"]["n"]),
        "  mates": pc(t["mate"]["found"], t["mate"]["n"]),
        "  quiet winning moves": pc(t["quiet move"]["found"], t["quiet move"]["n"]),
        "tactics per game": f"{tn / n:.1f}",
    }


def main():
    games = load()
    cache = run_engine(games)
    cols = [column([g for g in games if lo <= rating(g) < hi], "me", cache) for lo, hi, _ in BANDS]
    cols.append(column(games, "opp", cache))
    labels = [lbl for _, _, lbl in BANDS] + ["opps(all)"]
    width = max(len(k) for k in cols[0])
    print(f"{'VBKN rating':{width}s}" + "".join(f"{lbl:>10s}" for lbl in labels))
    for k in cols[0]:
        print(f"{k:{width}s}" + "".join(f"{c[k]:>10s}" for c in cols))


if __name__ == "__main__":
    main()
