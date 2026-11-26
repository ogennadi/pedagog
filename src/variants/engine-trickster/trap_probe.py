"""Replay sampled positions through Trickster configs; report trickiness and time,
with Stockfish checking each trap.
usage: python trap_probe.py <trick-joined.jsonl> <n> <name=engine.ts:margin[:lambda[:depth]]> ...
A fall: a reply losing >= 100 cp beyond best defence. "real" = Stockfish (depth 12) agrees."""
import json, os, queue, random, subprocess, sys, threading, time
from concurrent.futures import ThreadPoolExecutor
import chess, chess.engine

BUN = os.environ.get("BUN", "bun")
SF = os.environ.get("STOCKFISH", "stockfish")
FALL, CLAMP, SF_DEPTH = 100, 1000, 12


def run(engine, margin, lam, depth, fens, out):
    p = subprocess.Popen([BUN, engine], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         text=True, bufsize=1)
    send = lambda s: (p.stdin.write(s + "\n"), p.stdin.flush())
    send("uci"); send(f"setoption name Trick_Margin value {margin}")
    send(f"setoption name Trick_Lambda value {lam}"); send("isready")
    for line in p.stdout:
        if line.startswith("readyok"):
            break
    for fen in fens:
        send(f"position fen {fen}"); send(f"go depth {depth}")
        t0, trick = time.time(), None
        for line in p.stdout:
            if line.startswith("info string trick "):
                trick = json.loads(line[len("info string trick "):])
            if line.startswith("bestmove"):
                break
        out.append((time.time() - t0, trick))
    p.stdin.close(); p.wait()


def judge(keys):
    """Stockfish's score, cp for the side to move, of each FEN in keys."""
    pool = queue.Queue()
    for _ in range(12):
        e = chess.engine.SimpleEngine.popen_uci(SF)
        e.configure({"Threads": 1, "Hash": 16})
        pool.put(e)

    def one(fen):
        e = pool.get()
        try:
            info = e.analyse(chess.Board(fen), chess.engine.Limit(depth=SF_DEPTH))
            return fen, max(-CLAMP, min(CLAMP, info["score"].relative.score(mate_score=CLAMP)))
        finally:
            pool.put(e)
    with ThreadPoolExecutor(12) as ex:
        scores = dict(ex.map(one, keys))
    while not pool.empty():
        pool.get().quit()
    return scores


def after(fen, *moves):
    b = chess.Board(fen)
    for m in moves:
        b.push_uci(m)
    return b.fen()


def wanted(rows):
    for _, t in rows:
        if not t:
            continue
        yield after(t["fen"], t["candidates"][0][0])
        yield after(t["fen"], t["played"])
        for r in t["replies"]:
            yield after(t["fen"], t["played"], r[0])


def summary(rows, sf):
    n = len(rows)
    tricks = [t for _, t in rows if t]
    traps = [t for t in tricks if t["played"] != t["candidates"][0][0]]
    # Trickster's view, cp: positions after its move are scored for the opponent.
    mine = lambda t, m: -sf[after(t["fen"], m)]
    cost = [mine(t, t["candidates"][0][0]) - mine(t, t["played"]) for t in traps]

    def falls(t):
        base = mine(t, t["played"])
        own = sum(r[1] for r in t["replies"] if r[2] >= FALL) / 1000
        real = sum(r[1] for r in t["replies"] if sf[after(t["fen"], t["played"], r[0])] - base >= FALL) / 1000
        both = sum(r[1] for r in t["replies"]
                   if r[2] >= FALL and sf[after(t["fen"], t["played"], r[0])] - base >= FALL) / 1000
        return own, real, both
    avg = lambda xs: sum(xs) / max(1, len(xs))
    ft, fa = [falls(t) for t in traps], [falls(t) for t in tricks]
    pct = lambda fs, i: 100 * avg([f[i] for f in fs])
    return (f"{avg([r[0] for r in rows]):4.1f}s  traps {100*len(traps)/n:3.0f}%  "
            f"SF cost {avg(cost):4.0f}cp  fall chance after trap: own {pct(ft,0):3.0f}% "
            f"real {pct(ft,1):3.0f}% both {pct(ft,2):3.0f}%  after any move: own {pct(fa,0):3.0f}% "
            f"real {pct(fa,1):3.0f}%")


def main():
    log, n, configs = sys.argv[1], int(sys.argv[2]), sys.argv[3:]
    fens = random.Random(1).sample([json.loads(l)["fen"] for l in open(log)], n)
    results, threads = {}, []
    for c in configs:
        name, spec = c.split("=", 1)
        engine, margin, *rest = spec.split(":")
        results[name] = []
        threads.append(threading.Thread(
            target=run, args=(engine, margin, (rest + ["1000"])[0], (rest[1:] + ["6"])[0], fens, results[name])))
    for t in threads: t.start()
    for t in threads: t.join()
    sf = judge(sorted({k for rows in results.values() for k in wanted(rows)}))
    for name, rows in results.items():
        print(f"{name:9s} {summary(rows, sf)}")


main()
