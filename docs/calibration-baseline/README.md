# Calibration input archive

`round-10-pgns.zip` and `manifest-round-10.json` (the SHA-256 hash and game count of every
PGN): the 61 PGNs (18,300 games) behind the published `docs/skill-curve.json`,
`docs/skill-curve.png` and `docs/style.json` (Part III), played by the engine of commit
`bebea84` (both ladders, both styles). The round-9 archive (Part II), which no longer
matches the engine, is in Git history (commit `2a3789f`).

Extract the archive to a fresh directory, then pass the files explicitly to the tools. In
PowerShell:

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
