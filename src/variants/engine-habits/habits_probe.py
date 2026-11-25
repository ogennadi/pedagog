"""VBKN habit probes (5+0 games only): blockades, BxN, h3 timing, isolani, g-pawn storms, tactics.

Tactics use Stockfish (STOCKFISH env or PATH) at a fixed node count; per-ply results are cached in
src/tools/out/habits/tactics-n<NODES>.json keyed by game link, so overlapping or added PGNs only
analyse new games. A position "has a tactic" when the best move is at least TACTIC_GAP cp better
than the second best and leaves the mover at least TACTIC_MIN cp up.
"""
import json
import os
import shutil
import sys
from collections import Counter, defaultdict
from concurrent.futures import ProcessPoolExecutor

import chess
import chess.engine

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from habits_stats import ME, VAL, load  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
NODES = 150_000
CACHE = os.path.join(ROOT, "src", "tools", "out", "habits", f"tactics-n{NODES}.json")
TACTIC_GAP = 150
TACTIC_MIN = 100
MATE = 10_000


def rel_rank(sq, c):
    r = chess.square_rank(sq)
    return r if c == chess.WHITE else 7 - r


def isolated(board, c):
    files = {chess.square_file(s) for s in board.pieces(chess.PAWN, c)}
    return sum(1 for s in board.pieces(chess.PAWN, c)
               if chess.square_file(s) - 1 not in files and chess.square_file(s) + 1 not in files)


def passed(board, sq, c):
    f, r = chess.square_file(sq), chess.square_rank(sq)
    for s in board.pieces(chess.PAWN, not c):
        if abs(chess.square_file(s) - f) <= 1 and (chess.square_rank(s) > r if c == chess.WHITE else chess.square_rank(s) < r):
            return False
    return True


def front(sq, c):
    r = chess.square_rank(sq) + (1 if c == chess.WHITE else -1)
    return chess.square(chess.square_file(sq), r) if 0 <= r <= 7 else None


def is_isolated_pawn(board, sq, c):
    f = chess.square_file(sq)
    return not any(abs(chess.square_file(s) - f) == 1 for s in board.pieces(chess.PAWN, c))


# ---------------------------------------------------------------- static probes
def static(games):
    S = {w: Counter() for w in ("me", "opp")}
    bxn_sq = {w: Counter() for w in ("me", "opp")}
    for g in games:
        my = chess.WHITE if g.headers["White"] == ME else chess.BLACK
        board = g.board()
        castle_mv = {chess.WHITE: None, chess.BLACK: None}
        h3_mv = {chess.WHITE: None, chess.BLACK: None}
        g4_after_castle = {chess.WHITE: False, chess.BLACK: False}
        g4_with_h = {chess.WHITE: False, chess.BLACK: False}
        for m in g.mainline_moves():
            c = board.turn
            who = "me" if c == my else "opp"
            s = S[who]
            pt = board.piece_type_at(m.from_square)
            fm = board.fullmove_number
            prev = board.peek() if board.move_stack else None
            queens_on = bool(board.pieces(chess.QUEEN, chess.WHITE) or board.pieces(chess.QUEEN, chess.BLACK))
            # BxN opportunities: bishop can take a defended knight (an even trade, not a win)
            opps = [x for x in board.legal_moves if board.piece_type_at(x.from_square) == chess.BISHOP
                    and board.piece_type_at(x.to_square) == chess.KNIGHT and board.is_attacked_by(not c, x.to_square)]
            recapture = prev is not None and board.is_capture(m) and m.to_square == prev.to_square
            if opps and not (prev and board.is_capture(prev) and any(x.to_square == prev.to_square for x in opps)):
                s["bxn_opp"] += 1
                if m in opps:
                    s["bxn_taken"] += 1
                    bxn_sq[who][chess.square_name(m.to_square if c == chess.WHITE else chess.square_mirror(m.to_square))] += 1
                    if fm <= 15:
                        s["bxn_early"] += 1
            # blockade: non-pawn, non-king piece moves (non-capture) onto the square in front of an enemy pawn
            if pt not in (chess.PAWN, chess.KING) and not board.is_capture(m):
                s["piece_moves"] += 1
                for ps in board.pieces(chess.PAWN, not c):
                    if front(ps, not c) == m.to_square:
                        s["blockade"] += 1
                        s["blockade_" + chess.piece_name(pt)] += 1
                        if passed(board, ps, not c):
                            s["blockade_passed"] += 1
                        if is_isolated_pawn(board, ps, not c):
                            s["blockade_isolani"] += 1
            # passed-pawn blockade opportunities: enemy passer whose front square is empty and reachable by a piece
            for ps in board.pieces(chess.PAWN, not c):
                fsq = front(ps, not c)
                if fsq is not None and board.piece_at(fsq) is None and passed(board, ps, not c) and rel_rank(ps, not c) >= 3:
                    if any(x.to_square == fsq and board.piece_type_at(x.from_square) not in (chess.PAWN,) for x in board.legal_moves):
                        s["passer_block_opp"] += 1
                        if m.to_square == fsq and pt != chess.PAWN:
                            s["passer_block_taken"] += 1
            # isolani
            iso_before = isolated(board, c)
            iso_opp_before = isolated(board, not c)
            if board.is_castling(m):
                castle_mv[c] = fm
            if pt == chess.PAWN and chess.square_file(m.from_square) == 7 and h3_mv[c] is None:
                h3_mv[c] = (fm, rel_rank(m.to_square, c))
            if (pt == chess.PAWN and chess.square_file(m.from_square) == 6 and rel_rank(m.to_square, c) == 3
                    and castle_mv[c] is not None and queens_on):
                k = board.king(c)
                if chess.square_file(k) >= 5:
                    g4_after_castle[c] = True
                    h = [s2 for s2 in board.pieces(chess.PAWN, c) if chess.square_file(s2) == 7]
                    if h and rel_rank(h[0], c) >= 2:
                        g4_with_h[c] = True
            board.push(m)
            if 10 <= fm <= 40:
                s["iso_pos"] += 1
                s["iso_sum"] += isolated(board, c)
            if isolated(board, c) > iso_before:
                s["iso_created_own"] += 1
            if isolated(board, not c) > iso_opp_before:
                s["iso_inflicted"] += 1
            s["moves"] += 1
        for c in (chess.WHITE, chess.BLACK):
            s = S["me" if c == my else "opp"]
            s["games"] += 1
            cm, hm = castle_mv[c], h3_mv[c]
            h3 = hm is not None and hm[1] == 2 and hm[0] <= 20
            key = ("h3_before_castle" if h3 and cm and hm[0] < cm else
                   "h3_after_castle" if h3 and cm else
                   "h3_no_castle" if h3 else "no_h3_by_20")
            s[key] += 1
            if h3 and cm and hm[0] >= cm:
                s["h3_after_gap"] += hm[0] - cm
            if cm:
                s["castled"] += 1
            s["g4_storm"] += g4_after_castle[c]
            s["g4_storm_with_h"] += g4_with_h[c]
    return S, bxn_sq


# ---------------------------------------------------------------- tactics
def score_cp(info, pov):
    sc = info["score"].pov(pov)
    return MATE if sc.is_mate() and sc.mate() > 0 else -MATE if sc.is_mate() else sc.score()


def analyse_game(args):
    link, fen, moves = args
    sf = os.environ.get("STOCKFISH") or shutil.which("stockfish")
    out = []
    with chess.engine.SimpleEngine.popen_uci(sf) as eng:
        eng.configure({"Threads": 1, "Hash": 16})
        board = chess.Board(fen)
        for uci in moves:
            m = chess.Move.from_uci(uci)
            if board.fullmove_number >= 4 and board.legal_moves.count() > 1:
                infos = eng.analyse(board, chess.engine.Limit(nodes=NODES), multipv=2)
                best = infos[0]["pv"][0]
                b1, b2 = score_cp(infos[0], board.turn), score_cp(infos[1], board.turn)
                played = b1 if m == best else b2 if m == infos[1]["pv"][0] else None
                if b1 - b2 >= TACTIC_GAP and b1 >= TACTIC_MIN and played is None:
                    played = score_cp(eng.analyse(board, chess.engine.Limit(nodes=NODES), root_moves=[m]), board.turn)
                out.append([board.ply(), best.uci(), b1, b2, played])
            board.push(m)
    return link, out


def run_engine(games):
    cache = json.load(open(CACHE)) if os.path.exists(CACHE) else {}
    todo = [(g.headers["Link"], g.board().fen(), [m.uci() for m in g.mainline_moves()])
            for g in games if g.headers["Link"] not in cache]
    if todo:
        print(f"analysing {len(todo)} games with Stockfish at {NODES} nodes...", flush=True)
        with ProcessPoolExecutor(max_workers=max(1, (os.cpu_count() or 2) - 4)) as ex:
            for i, (link, out) in enumerate(ex.map(analyse_game, todo), 1):
                cache[link] = out
                if i % 25 == 0:
                    print(f"  {i}/{len(todo)}", flush=True)
                    os.makedirs(os.path.dirname(CACHE), exist_ok=True)
                    json.dump(cache, open(CACHE, "w"))
        os.makedirs(os.path.dirname(CACHE), exist_ok=True)
        json.dump(cache, open(CACHE, "w"))
    return cache


def motif(board, move, b1):
    if b1 >= MATE:
        return "mate"
    c = board.turn
    after = board.copy()
    after.push(move)
    mover = board.piece_type_at(move.from_square)
    if board.is_capture(move) and not board.is_en_passant(move):
        victim = board.piece_type_at(move.to_square)
        if not board.is_attacked_by(not c, move.to_square) or VAL[victim] > VAL[mover]:
            return "free/winning capture"
    targets = [s for s in after.attacks(move.to_square)
               if after.piece_at(s) and after.piece_at(s).color != c
               and (after.piece_type_at(s) == chess.KING or (VAL[after.piece_type_at(s)] >= 3
                    and (VAL[after.piece_type_at(s)] > VAL[mover] or not after.is_attacked_by(not c, s))))]
    if len(targets) >= 2:
        return "fork"
    pinned_before = sum(board.is_pinned(not c, s) for s in chess.SQUARES if board.piece_at(s) and board.piece_at(s).color != c)
    pinned_after = sum(after.is_pinned(not c, s) for s in chess.SQUARES if after.piece_at(s) and after.piece_at(s).color != c)
    if pinned_after > pinned_before:
        return "pin"
    disc = [s for s in chess.SQUARES if after.piece_at(s) and after.piece_at(s).color != c
            and VAL[after.piece_type_at(s)] >= 3 and s not in board.attacks(move.from_square)
            and any(a != move.to_square for a in after.attackers(c, s))
            and not any(a != move.from_square for a in board.attackers(c, s))]
    if disc:
        return "discovered attack"
    if after.is_check():
        return "check"
    if board.is_capture(move):
        return "capture (combination)"
    return "quiet move"


def tactics(games, cache):
    T = {w: defaultdict(Counter) for w in ("me", "opp")}
    for g in games:
        my = chess.WHITE if g.headers["White"] == ME else chess.BLACK
        rows = {r[0]: r for r in cache.get(g.headers["Link"], [])}
        board = g.board()
        for m in g.mainline_moves():
            r = rows.get(board.ply())
            if r:
                _, best, b1, b2, played = r
                who = "me" if board.turn == my else "opp"
                prev = board.peek() if board.move_stack else None
                bm = chess.Move.from_uci(best)
                trivial = prev is not None and board.is_capture(prev) and bm.to_square == prev.to_square
                if b1 - b2 >= TACTIC_GAP and b1 >= TACTIC_MIN and not trivial and not board.is_check():
                    kind = motif(board, bm, b1)
                    T[who][kind]["n"] += 1
                    found = m == bm or (played is not None and played >= b1 - 50)
                    T[who][kind]["found"] += found
            board.push(m)
    return T


def main():
    games = load()
    S, bxn_sq = static(games)
    for who in ("me", "opp"):
        s = S[who]
        p = lambda a, b: f"{100 * s[a] / max(1, s[b]):.1f}%"
        print(f"\n===== {who} ({s['games']} games)")
        print("BLOCKADE: piece moves onto the square in front of an enemy pawn:", p("blockade", "piece_moves"),
              f"({s['blockade']}/{s['piece_moves']}); by N {s['blockade_knight']} B {s['blockade_bishop']}"
              f" R {s['blockade_rook']} Q {s['blockade_queen']}; of passers {s['blockade_passed']}, of isolani {s['blockade_isolani']}")
        print("  blocks an advanced enemy passer when a piece can:", p("passer_block_taken", "passer_block_opp"),
              f"({s['passer_block_taken']}/{s['passer_block_opp']})")
        print("BxN (bishop takes defended knight, not a recapture) when available:", p("bxn_taken", "bxn_opp"),
              f"({s['bxn_taken']}/{s['bxn_opp']}), by move 15: {s['bxn_early']}; squares {bxn_sq[who].most_common(6)}")
        print(f"H3 (h-pawn one step by move 20): before castling {s['h3_before_castle']}, after castling {s['h3_after_castle']}"
              f" (avg {s['h3_after_gap'] / max(1, s['h3_after_castle']):.1f} moves later), uncastled {s['h3_no_castle']},"
              f" none {s['no_h3_by_20']} of {s['games']}")
        print("ISOLANI: avg own isolated pawns (moves 10-40):", f"{s['iso_sum'] / max(1, s['iso_pos']):.2f}",
              "| moves creating own isolani:", p("iso_created_own", "moves"), "| inflicting on opponent:", p("iso_inflicted", "moves"))
        print(f"G-PAWN STORM (g4/g5 after castling short, queens on): {s['g4_storm']} games of {s['castled']} castled;"
              f" with h-pawn already advanced: {s['g4_storm_with_h']}")
    cache = run_engine(games)
    T = tactics(games, cache)
    print("\nTACTICS (best move >= +150cp over 2nd best, not a plain recapture, not in check)")
    kinds = sorted({k for w in T.values() for k in w}, key=lambda k: -T["me"][k]["n"])
    for who in ("me", "opp"):
        tot_n = sum(v["n"] for v in T[who].values())
        tot_f = sum(v["found"] for v in T[who].values())
        print(f"  {who}: found {tot_f}/{tot_n} = {100 * tot_f / max(1, tot_n):.0f}%")
        for k in kinds:
            v = T[who][k]
            if v["n"]:
                print(f"    {k:22s} {v['found']:4d}/{v['n']:<4d} {100 * v['found'] / v['n']:.0f}%")


if __name__ == "__main__":
    main()
