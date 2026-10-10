# Round 9 calibration input archive

`round-9-pgns.zip` contains the 30 PGNs used for the published
`docs/skill-curve.json` Elo fit: 8,900 games in total. The files are the
round-9 match outputs, not the earlier tuning rounds. `manifest.json` records
the SHA-256 hash and game count of every PGN, plus the archive hash.

Extract the archive to a fresh directory, then pass the resulting files
explicitly to the Elo script. For example, in PowerShell:

```powershell
Expand-Archive -LiteralPath docs\calibration-baseline\round-9-pgns.zip `
  -DestinationPath tools\out\r9-baseline
$pgngames = Get-ChildItem tools\out\r9-baseline -Filter *.pgn
bun tools\elo.js --anchor maia-1900=1755 `
  --anchor-note "Lichess classical rating on 2026-10-06" `
  --json tools\out\r9-baseline\skill-curve.json $pgngames.FullName
```

The extracted files remain in ignored match-output directories. Check their
hashes against `manifest.json` if reproducing or transferring the dataset.
Keep new match sets under distinct tags/directories; do not combine them with
this historical snapshot when reproducing the published curve.

The published `docs/blunders.json` does not record its PGN inputs. This archive
is the verified input set for the published Elo fit; it is not claimed to
reproduce the stored blunder-rate measurements.
