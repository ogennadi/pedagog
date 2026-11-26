"""Does Maia-1900 fall for Trickster's traps? Replays sampled positions through Trickster
configs, asks Maia-1900 (lc0 policy, temperature 1) for the reply chances after each
candidate move, and has Stockfish (depth 12) score those replies. Reports, per config:
run-2's and Maia's fall chance after its traps, and its expected score against a
Maia-like opponent next to its best move's; then the same for a Trickster using Maia as
its model (an upper bound: Maia both chooses and judges), next to Stockfish's best move.
usage: python maia_probe.py <trick-joined.jsonl> <n> <out dir> <name=engine.ts:margin:lambda:depth> ...
Env: BUN, STOCKFISH, LC0, MAIA_DIR. Resumable: every result is cached in <out dir>."""
import json, math, os, queue, random, re, subprocess, sys, threading
from concurrent.futures import ThreadPoolExecutor
import chess, chess.engine

BUN = os.environ.get("BUN", "bun")
SF = os.environ.get("STOCKFISH", "stockfish")
LC0 = os.environ.get("LC0", "lc0")
MAIA = os.path.join(os.environ.get("MAIA_DIR", "."), "maia-1900.pb.gz")
FALL, CLAMP, CAP, SF_DEPTH, MIN_P = 100, 1000, 600, 12, 0.01
CHUNKS, JUDGES, MAIAS = 6, 20, 8
E = lambda cp: 1 / (1 + math.exp(-0.00368208 * cp))
ORACLE = [(0, 0), (50, 1000), (150, 1000), (300, 1000), (300, 3000)]


class Cache:
    def __init__(self, path):
        self.d, self.lock = {}, threading.Lock()
        if os.path.exists(path):
            for line in open(path):
                try:
                    k, v = json.loads(line)
                    self.d[k] = v
                except ValueError:
                    pass  # a line cut short by an interruption
        self.f = open(path, "a")

    def put(self, k, v):
        with self.lock:
            self.d[k] = v
            self.f.write(json.dumps([k, v]) + "\n")
            self.f.flush()


def pooled(make, n, keys, work, cache):
    todo = [k for k in dict.fromkeys(keys) if k not in cache.d]
    print(f"  {len(todo)} to do, {len(cache.d)} cached", flush=True)
    if not todo:
        return
    pool = queue.Queue()
    for _ in range(min(n, len(todo))):
        pool.put(make())

    def one(k):
        e = pool.get()
        try:
            cache.put(k, work(e, k))
        finally:
            pool.put(e)
    with ThreadPoolExecutor(n) as ex:
        list(ex.map(one, todo))
    while not pool.empty():
        pool.get().quit()


def trickster(spec, fens, path):
    engine, margin, lam, depth = spec.rsplit(":", 3)
    p = subprocess.Popen([BUN, engine], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         text=True, bufsize=1)
    send = lambda s: (p.stdin.write(s + "\n"), p.stdin.flush())
    send("uci"); send(f"setoption name Trick_Margin value {margin}")
    send(f"setoption name Trick_Lambda value {lam}"); send("isready")
    for line in p.stdout:
        if line.startswith("readyok"):
            break
    out = []
    for fen in fens:
        send(f"position fen {fen}"); send(f"go depth {depth}")
        trick = None
        for line in p.stdout:
            if line.startswith("info string trick "):
                trick = json.loads(line[len("info string trick "):])
            if line.startswith("bestmove"):
                break
        out.append(trick)
    p.stdin.close(); p.wait()
    with open(path + ".tmp", "w") as f:
        json.dump(out, f)
    os.replace(path + ".tmp", path)


def records(configs, fens, out):
    jobs, paths = [], {}
    size = -(-len(fens) // CHUNKS)
    for name, spec in configs:
        paths[name] = []
        for i in range(CHUNKS):
            path = os.path.join(out, f"tricks-{name}-{i}.json")
            paths[name].append(path)
            if not os.path.exists(path):
                jobs.append((spec, fens[i * size:(i + 1) * size], path))
    print(f"trickster: {len(jobs)} chunks to run", flush=True)
    if jobs:
        with ThreadPoolExecutor(len(jobs)) as ex:
            list(ex.map(lambda j: trickster(*j), jobs))
    return {name: [t for p in ps for t in json.load(open(p)) if t] for name, ps in paths.items()}


def after(fen, *moves):
    b = chess.Board(fen)
    for m in moves:
        b.push_uci(m)
    return b.fen()


def maia_engine():
    e = chess.engine.SimpleEngine.popen_uci(LC0, stderr=subprocess.DEVNULL)
    e.configure({"WeightsFile": MAIA, "VerboseMoveStats": True, "PolicyTemperature": "1",
                 "Threads": 1})
    return e


def policy(e, fen):
    """Maia's chance of each reply in fen (moves under 0.01% left out)."""
    b, ps = chess.Board(fen), {}
    if b.is_game_over():
        return ps
    with e.analysis(b, chess.engine.Limit(nodes=1)) as a:
        for info in a:
            m = re.match(r"(\S+)\s+\(.*\(P:\s*([\d.]+)%\)", info.get("string", ""))
            if m and m.group(1) != "node" and float(m.group(2)) > 0:
                ps[b.parse_uci(m.group(1)).uci()] = float(m.group(2)) / 100
    return ps


def sf_engine():
    e = chess.engine.SimpleEngine.popen_uci(SF)
    e.configure({"Threads": 1, "Hash": 16})
    return e


def score(e, fen):
    """Stockfish's score, cp for the side to move, clamped."""
    info = e.analyse(chess.Board(fen), chess.engine.Limit(depth=SF_DEPTH))
    return max(-CLAMP, min(CLAMP, info["score"].relative.score(mate_score=CLAMP)))


def main():
    log, n, out, configs = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4:]
    os.makedirs(out, exist_ok=True)
    configs = [c.split("=", 1) for c in configs]
    fens = random.Random(1).sample([json.loads(l)["fen"] for l in open(log)], n)
    recs = records(configs, fens, out)

    moved = {(t["fen"], c[0]) for ts in recs.values() for t in ts for c in t["candidates"]}
    afters = {k: after(*k) for k in moved}
    print("maia:", flush=True)
    maia = Cache(os.path.join(out, "maia.jsonl"))
    pooled(maia_engine, MAIAS, sorted(afters.values()), policy, maia)

    keys = set(afters.values())
    for a in afters.values():
        keys |= {after(a, r) for r, p in maia.d[a].items() if p >= MIN_P}
    for ts in recs.values():
        for t in ts:
            keys |= {after(t["fen"], t["played"], r[0]) for r in t["replies"]}
    print("stockfish:", flush=True)
    sf = Cache(os.path.join(out, "sf.jsonl"))
    pooled(sf_engine, JUDGES, sorted(keys), score, sf)
    sf = sf.d

    def judged(fen, m):
        """Trickster's value after m (best defence), and Maia's likely replies' (chance, gain)."""
        a = afters[(fen, m)]
        v = -sf[a]
        return v, [(p, sf[after(a, r)] - v) for r, p in maia.d[a].items() if p >= MIN_P]

    def maia_fall(fen, m):
        return sum(p for p, g in judged(fen, m)[1] if g >= FALL)

    def es(fen, m):
        """Expected score of m against Maia; unexamined replies count as best defence."""
        v, rs = judged(fen, m)
        return sum(p * E(v + g) for p, g in rs) + (1 - sum(p for p, _ in rs)) * E(v)

    avg = lambda xs: sum(xs) / max(1, len(xs))
    lines = []
    for name, ts in recs.items():
        traps = [t for t in ts if t["played"] != t["candidates"][0][0]]
        best = lambda t: t["candidates"][0][0]
        cost = [judged(t["fen"], best(t))[0] - judged(t["fen"], t["played"])[0] for t in traps]
        run2 = [sum(r[1] for r in t["replies"]
                    if sf[after(t["fen"], t["played"], r[0])] + sf[afters[(t["fen"], t["played"])]] >= FALL)
                / 1000 for t in traps]
        d_es = [es(t["fen"], t["played"]) - es(t["fen"], best(t)) for t in ts]
        lines.append(
            f"{name:9s} traps {100*len(traps)/len(ts):3.0f}%  SF cost {avg(cost):4.0f}cp  "
            f"fall after trap: run-2 {100*avg(run2):3.0f}% Maia {100*avg([maia_fall(t['fen'], t['played']) for t in traps]):3.0f}%  "
            f"Maia after best {100*avg([maia_fall(t['fen'], best(t)) for t in traps]):3.0f}%  "
            f"expected score vs best: {100*avg(d_es):+5.2f} pts/move")

    ts = recs[max(configs, key=lambda c: int(c[1].rsplit(":", 3)[1]))[0]]
    cover = avg([sum(p for p, _ in judged(t["fen"], c[0])[1]) for t in ts for c in t["candidates"]])
    lines.append(f"Maia as the model (candidates: {len(ts)} positions; Maia chance examined {100*cover:.0f}%):")
    for margin, lam in ORACLE:
        picks, falls, d_es, costs = [], [], [], []
        for t in ts:
            vals = {c[0]: judged(t["fen"], c[0]) for c in t["candidates"]}
            top = max(v for v, _ in vals.values())

            def worth(m):
                v, rs = vals[m]
                return E(v) + lam / 1000 * sum(p * (E(v + min(g, CAP)) - E(v)) for p, g in rs)
            m = max((m for m, (v, _) in vals.items() if v >= top - margin), key=worth)
            top_m = max(vals, key=lambda m: vals[m][0])
            picks.append(vals[m][0] < top)
            costs.append(top - vals[m][0])
            falls.append(maia_fall(t["fen"], m))
            d_es.append(es(t["fen"], m) - es(t["fen"], top_m))
        label = "SF best, no traps" if lam == 0 else f"margin {margin}, lambda {lam}"
        lines.append(f"  {label:24s} traps {100*avg(picks):3.0f}%  SF cost {avg(costs):4.0f}cp  "
                     f"Maia fall {100*avg(falls):3.0f}%  expected score vs SF best: {100*avg(d_es):+5.2f} pts/move")
    text = "\n".join(lines)
    print(text)
    with open(os.path.join(out, "summary.txt"), "w") as f:
        f.write(text + "\n")


main()
