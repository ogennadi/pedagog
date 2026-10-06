"""Plot the skill curve: global Elo per level, adjacent-level gaps, blunder rate.

    python tools/plot.py [--elo docs/skill-curve.json] [--blunders docs/blunders.json] [--out docs/skill-curve.png]
"""
import argparse, json, os
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

HERE = os.path.dirname(os.path.abspath(__file__))
DOCS = os.path.join(HERE, "..", "docs")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--elo", default=os.path.join(DOCS, "skill-curve.json"))
    ap.add_argument("--blunders", default=os.path.join(DOCS, "blunders.json"))
    ap.add_argument("--out", default=os.path.join(DOCS, "skill-curve.png"))
    a = ap.parse_args()

    with open(a.elo) as fh:
        elo = json.load(fh)
    blunders = None
    if os.path.exists(a.blunders):
        with open(a.blunders) as fh:
            blunders = json.load(fh)

    levels = [r for r in elo["ratings"] if r["player"].startswith("L") and r["player"][1:].isdigit()]
    levels.sort(key=lambda r: int(r["player"][1:]))
    xs = [int(r["player"][1:]) for r in levels]
    ys = [r["elo"] for r in levels]
    err = [[r["elo"] - r["lo"] for r in levels], [r["hi"] - r["elo"] for r in levels]]
    maias = [r for r in elo["ratings"] if r["player"].startswith("maia")]

    fig, axes = plt.subplots(1, 3, figsize=(16, 5.2))
    anchor_name, anchor_elo = next(iter(elo["anchor"].items()))
    note = elo.get("anchor_note", "")
    fig.suptitle(f"Pedagog Skill_Level calibration (vs Maia at one node; {anchor_name} anchored at {anchor_elo:.0f}{', ' + note if note else ''})", fontsize=12)

    # --- Panel 1: global Elo per level
    ax = axes[0]
    ax.errorbar(xs, ys, yerr=err, fmt="o-", color="#1f77b4", capsize=3, label="Skill_Level (fitted, 95% CI)")
    for m in maias:
        ax.axhline(m["elo"], color="#999", ls="--", lw=0.8)
        ax.text(xs[0] - 0.4, m["elo"] + 8, m["player"], fontsize=8, color="#666")
    for x, y in zip(xs, ys):
        ax.annotate(str(y), (x, y), textcoords="offset points", xytext=(0, 8), ha="center", fontsize=8)
    ax.set_xlabel("Skill_Level"); ax.set_ylabel("Elo"); ax.set_title("Global rating per level")
    ax.set_xticks(xs); ax.grid(alpha=0.3); ax.legend(loc="lower right", fontsize=8)

    # --- Panel 2: adjacent gaps
    ax = axes[1]
    gaps = elo["gaps"]
    gx = [int(g["to"][1:]) for g in gaps]
    fitted = [g["fitted"] for g in gaps]
    gerr = [[g["fitted"] - g["lo"] for g in gaps], [g["hi"] - g["fitted"] for g in gaps]]
    direct = [g["direct"] if g["direct"] is not None else float("nan") for g in gaps]
    ax.bar([x - 0.18 for x in gx], fitted, width=0.36, color="#1f77b4", label="from joint fit (95% CI)")
    ax.errorbar([x - 0.18 for x in gx], fitted, yerr=gerr, fmt="none", ecolor="#333", capsize=3)
    ax.bar([x + 0.18 for x in gx], direct, width=0.36, color="#ff7f0e", label="head-to-head only")
    ax.axhspan(100, 150, color="#2ca02c", alpha=0.12, label="target 100-150")
    ax.set_xlabel("Skill_Level (gap to the level below)"); ax.set_ylabel("Elo difference")
    ax.set_title("Local gap between adjacent levels")
    ax.set_xticks(gx); ax.set_xticklabels([f"{x-1}→{x}" for x in gx], fontsize=8); ax.grid(alpha=0.3, axis="y")
    ax.legend(fontsize=8, loc="upper right")
    inner = [v for g, v in zip(gaps, fitted) if g["from"] != "L1"] + [d for g, d in zip(gaps, direct) if g["from"] != "L1" and d == d]
    ymax = max(inner + [200]) * 1.25
    ax.set_ylim(0, ymax)
    for x, v, d in zip(gx, fitted, direct):
        ax.annotate(str(v), (x - 0.18, min(v, ymax * 0.93)), textcoords="offset points", xytext=(0, 4), ha="center", fontsize=7)
        if d == d and d > ymax:
            ax.annotate(f"↑{d}", (x + 0.18, ymax * 0.93), textcoords="offset points", xytext=(0, 4), ha="center", fontsize=7, color="#ff7f0e")

    # --- Panel 3: blunder rate
    ax = axes[2]
    if blunders:
        bl = {int(k): v for k, v in blunders["levels"].items()}
        bx = sorted(bl)
        br = [100 * (bl[x]["blunder_rate"] or 0) for x in bx]
        mr = [100 * (bl[x]["mistake_rate"] or 0) for x in bx]
        ax.plot(bx, br, "o-", color="#d62728", label="blunders (≥20 pp win-prob. loss)")
        ax.plot(bx, mr, "s--", color="#ff7f0e", label="mistakes (10-20 pp)")
        for x, y in zip(bx, br):
            ax.annotate(f"{y:.1f}", (x, y), textcoords="offset points", xytext=(0, 7), ha="center", fontsize=8)
        ax.set_xticks(bx)
        ax.set_title(f"Blunder rate per level (judge: {blunders['judge']})")
    else:
        ax.set_title("Blunder rate per level (no data yet)")
    ax.set_xlabel("Skill_Level"); ax.set_ylabel("% of moves"); ax.grid(alpha=0.3); ax.legend(fontsize=8)

    fig.tight_layout(rect=(0, 0, 1, 0.95))
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    fig.savefig(a.out, dpi=130)
    print("wrote", a.out)

if __name__ == "__main__":
    main()
