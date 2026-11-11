"""Plot the skill ladders: rating per level and the Elo gained over the previous level, for
both styles; and, in a second figure, how aggressively each style plays at each level.

    python tools/plot.py [--elo docs/skill-curve.json] [--style docs/style.json]
                         [--out docs/skill-curve.png] [--style-out docs/style.png]

--elo is the output of tools/elo.js --json, --style that of tools/style.py --json. Players
L2..L10 are the aggressive style (Pedagog's default), R2..R10 the plain reference style.
Level 1, the random mover, is left out: it is ~800 Elo below level 2 and would flatten the rest.
"""
import argparse, json, os
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

HERE = os.path.dirname(os.path.abspath(__file__))
DOCS = os.path.join(HERE, "..", "docs")
BG, INK, GREY, GRID = "#fcfcfb", "#3a3a38", "#8a8a86", "#e8e8e5"
STYLES = [("L", "Pedagog (aggressive)", "#d6452a"), ("R", "Reference (plain)", "#2a78d6")]
LEVELS = range(2, 11)


def setup():
    plt.rcParams.update({"font.size": 10, "text.color": INK, "axes.edgecolor": GREY,
                         "axes.labelcolor": GREY, "xtick.color": GREY, "ytick.color": GREY})


def clean(ax):
    ax.set_facecolor(BG); ax.grid(axis="y", color=GRID, lw=0.6); ax.set_axisbelow(True)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)


def ladder(elo, letter):
    by_name = {r["player"]: r for r in elo["ratings"]}
    rows = [by_name[f"{letter}{k}"] for k in LEVELS if f"{letter}{k}" in by_name]
    lv = np.array([int(r["player"][1:]) for r in rows])
    return lv, np.array([r["elo"] for r in rows]), np.array([r["lo"] for r in rows]), \
        np.array([r["hi"] for r in rows])


def skill_curve(elo, path):
    fig, (a1, a2) = plt.subplots(2, 1, figsize=(10, 8), sharex=True, facecolor=BG,
                                 gridspec_kw={"height_ratios": [3, 2], "hspace": 0.08})
    for ax in (a1, a2):
        clean(ax)
    for m in sorted((r for r in elo["ratings"] if r["player"].startswith("maia")),
                    key=lambda r: r["elo"]):
        a1.axhline(m["elo"], color=GREY, lw=0.7, ls=":")
        a1.text(1.75, m["elo"] + 6, f"{m['player']} {m['elo']}", color=GREY, fontsize=8)
    labels = []
    for letter, label, colour in STYLES:
        lv, r, lo, hi = ladder(elo, letter)
        if len(lv) < 2:
            continue
        slope, icpt = np.polyfit(lv, r, 1)
        line = slope * lv + icpt
        r2 = 1 - np.sum((r - line) ** 2) / np.sum((r - r.mean()) ** 2)
        a1.fill_between(lv, lo, hi, color=colour, alpha=0.14, lw=0)
        a1.plot(lv, line, color=colour, lw=0.9, alpha=0.6, ls=(0, (4, 3)))
        a1.plot(lv, r, color=colour, lw=1.8, marker="o", ms=4, mfc=BG, mew=1.4)
        labels.append((r[-1], f"{label}\n{slope:.0f} Elo/level\nR\u00b2 = {r2:.3f}", colour))
        gaps = [g for g in elo["gaps"] if g["to"][:1] == letter and g["from"][:1] == letter
                and int(g["from"][1:]) in LEVELS]
        gx = np.array([int(g["to"][1:]) for g in gaps])
        gap = np.array([g["fitted"] for g in gaps])
        glo, ghi = np.array([g["lo"] for g in gaps]), np.array([g["hi"] for g in gaps])
        shift = -0.07 if letter == "L" else 0.07
        a2.errorbar(gx + shift, gap, yerr=[gap - glo, ghi - gap], fmt="none", ecolor=colour,
                    elinewidth=0.9, alpha=0.5)
        a2.plot(gx + shift, gap, color=colour, lw=1.2, marker="o", ms=4, mfc=BG, mew=1.4)
        a2.text(1.01, 0.92 if letter == "L" else 0.80, f"mean {gap.mean():.0f}", color=colour,
                va="center", fontsize=9, transform=a2.transAxes)
    for y, (_, text, colour) in zip((0.85, 0.55), sorted(labels, reverse=True)):
        a1.text(1.01, y, text, color=colour, va="center", fontsize=9, transform=a1.transAxes)
    a1.text(1.01, 0.25, "shaded: 95%\ninterval\ndashed: straight\nline fit", color=GREY,
            va="center", fontsize=8.5, transform=a1.transAxes)
    a2.axhline(100, color=INK, lw=0.9, ls=(0, (4, 3)))
    a2.text(1.01, 100, "target 100", color=INK, va="center", fontsize=9,
            transform=a2.get_yaxis_transform())
    anchor_name, anchor_elo = next(iter(elo["anchor"].items()))
    a1.set_ylabel(f"Elo (Lichess classical; {anchor_name} = {anchor_elo:.0f})")
    a1.set_title("Pedagog Skill_Level: rating by level, both styles (joint fit vs Maia)",
                 loc="left", fontsize=11.5)
    a2.set_ylabel("Elo gained over previous level"); a2.set_xlabel("Skill level")
    a2.set_xticks(list(LEVELS)); a2.tick_params(axis="x", length=0)
    a1.set_xlim(1.6, 10.4)
    fig.savefig(path, dpi=140, facecolor=BG, bbox_inches="tight")
    print("wrote", path)


def style_curve(style, path):
    fig, ax = plt.subplots(figsize=(10, 4.5), facecolor=BG)
    clean(ax)
    for letter, label, colour in STYLES:
        levels = [k for k in LEVELS if f"{letter}{k}" in style]
        if not levels:
            continue
        aggression = [style[f"{letter}{k}"]["aggression"] for k in levels]
        checks = [style[f"{letter}{k}"]["checks"] for k in levels]
        ax.plot(levels, aggression, color=colour, lw=1.8, marker="o", ms=4, mfc=BG, mew=1.4)
        ax.plot(levels, checks, color=colour, lw=0.9, alpha=0.6, ls=(0, (4, 3)))
        ax.text(1.01, aggression[-1], f"{label}\n{np.mean(aggression):.0f} on average",
                color=colour, va="center", fontsize=9, transform=ax.get_yaxis_transform())
    ax.set_title("Aggression by level: 3 \u00d7 knowing sacrifices + checks, per 100 moves "
                 "(dashed: checks alone)", loc="left", fontsize=11.5)
    ax.set_ylabel("per 100 of its own moves"); ax.set_xlabel("Skill level")
    ax.set_xticks(list(LEVELS)); ax.tick_params(axis="x", length=0); ax.set_ylim(bottom=0)
    fig.savefig(path, dpi=140, facecolor=BG, bbox_inches="tight")
    print("wrote", path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--elo", default=os.path.join(DOCS, "skill-curve.json"))
    ap.add_argument("--style", default=os.path.join(DOCS, "style.json"))
    ap.add_argument("--out", default=os.path.join(DOCS, "skill-curve.png"))
    ap.add_argument("--style-out", default=os.path.join(DOCS, "style.png"))
    a = ap.parse_args()
    setup()
    with open(a.elo) as fh:
        skill_curve(json.load(fh), a.out)
    if os.path.exists(a.style):
        with open(a.style) as fh:
            style_curve(json.load(fh)["players"], a.style_out)


if __name__ == "__main__":
    main()
