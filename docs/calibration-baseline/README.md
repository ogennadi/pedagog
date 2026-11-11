# Calibration input archives

Two archived match sets, each with the SHA-256 hash and game count of every PGN:

- **Round 10** (current, Part III): `round-10-pgns.zip` and `manifest-round-10.json` — the
  61 PGNs (18,300 games) behind the published `docs/skill-curve.json`, `docs/skill-curve.png`
  and `docs/style.json`, played by the engine of commit `bebea84` (both ladders, both styles).
- **Round 9** (historical, Part II): `round-9-pgns.zip` and `manifest.json` — the 30 PGNs
  (8,900 games) behind the round-9 ladder table in `COLOPHON.md`. It no longer matches the
  engine.

Extract an archive to a fresh directory, then pass the files explicitly to the tools. For
round 10, in PowerShell:

```powershell
Expand-Archive -LiteralPath docs\calibration-baseline\round-10-pgns.zip `
  -DestinationPath tools\out\r10-baseline
$pgns = Get-ChildItem tools\out\r10-baseline -Filter *.pgn
bun tools\elo.js --anchor maia-1900=1755 `
  --anchor-note "its Lichess classical rating on 2026-10-06" `
  --json tools\out\r10-baseline\skill-curve.json $pgns.FullName
python tools\style.py --json tools\out\r10-baseline\style.json `
  (Get-ChildItem tools\out\r10-baseline -Filter "r10-L*-vs-R*.pgn").FullName
python tools\plot.py --elo tools\out\r10-baseline\skill-curve.json `
  --style tools\out\r10-baseline\style.json --out tools\out\r10-baseline\skill-curve.png `
  --style-out tools\out\r10-baseline\style.png
```

Every Pedagog level is depth-bounded and Maia plays one node per move, so rerunning a pairing
with the same seed replays the same games. The extracted files stay in ignored match-output
directories. Keep new match sets under distinct tags and directories; do not combine them with
these snapshots when reproducing a published fit.

The published `docs/blunders.json` was measured on the round-9 ladder and does not record its
PGN inputs; it has not been re-measured for round 10.
