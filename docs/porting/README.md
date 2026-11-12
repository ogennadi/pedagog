# Porting Pedagog to another language

The brief given to each port. Ports live in `ports\<lang>\`, which Git ignores:
they are exercises, not part of the engine.

Repo root: C:\Users\D5DXKYX\WebstormProjects\pedagog (Windows, PowerShell 5: no `&&`; use `;` and `if ($?) {}`).

## Goal
Port the chess engine `engine.ts` (repo root, ~1,700 lines, the single source of truth) to ONE
idiomatic single source file in the target language, under `ports\<lang>\`, and write its
names/types report `ports\<lang>\engine-api.html` plus `engine-api.pdf`.
The user is learning the language through this port, so the code must be what an experienced
programmer in that language would write (its own naming conventions, idioms, type system,
standard library), while keeping the engine's structure, algorithms and domain names.

## Read first
- `engine.ts` - read ALL of it. Keep its section layout (S0 Constants ... S6 UCI), its
  explanatory block comments (this is a pedagogical engine: adapt the prose, do not drop it),
  and its domain names (Square, Piece, Move, Pv, Position, Draft, Search, Skill, Style, Rung,
  Limits, ...), adjusted only to the language's casing conventions.
- `docs\naming.md` - why the engine's names are what they are, and which reference
  engines share them. Keep these names in the port.
- `docs\porting\report-template.html` - THE REPORT TEMPLATE (the TypeScript report).
  Copy its CSS and structure.

## Hard requirements
1. Output must be byte-identical to engine.ts on everything except timing. Verify with
   `bun run diff <command> [args...]` from the repo root (e.g.
   `bun run diff java -jar ports\kotlin\engine.jar`; the script is `tools\uci-diff.js`). It must print `ALL 38 IDENTICAL`.
   engine.ts is integer-only with 32-bit Zobrist keys (signed int32, xorshift32, mix32,
   Math.imul semantics), so exact agreement is achievable: reproduce 32-bit wrap-around,
   `>>>`/`>>` semantics, Math.floor vs Math.trunc, and sort stability/tie-breaks exactly.
   Note JS `%` and integer division of negatives; `Math.round` in output; string formats.
2. UCI over stdin/stdout, same commands as engine.ts (uci, setoption, isready, ucinewgame,
   position, go, stop, quit, bench, perft, d, eval) and `<program> bench [depth]` from argv.
   `stop` must interrupt a running search (search on a worker thread/task + an atomic stop
   flag, or equivalent), and `isready` must answer while searching. When stdin hits EOF the
   engine must finish queued commands, including a running depth-limited search and its
   `bestmove`, before exiting (the diff pipes a script then closes stdin).
3. Check: `perft 5` from startpos = 4865609 nodes. Report bench nps vs `bun engine.ts bench`.
   Check `stop` really interrupts: every level is depth-capped, so use the slow position
   `position fen r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10`,
   `go infinite`, then after ~0.5 s `isready` (expect `readyok` mid-search) and `stop` (expect
   `bestmove` within ~0.1 s). Drive it with a small Python script using subprocess + a reader thread.
4. Single source file. A minimal build file is allowed only if the toolchain cannot build a
   lone source file (e.g. a .csproj). Put build output inside `ports\<lang>\`.
5. Never mutate incoming parameters (functions return new values; local mutation inside a
   function, and the engine's own Draft/Search mutable objects, are fine, as in engine.ts).
6. Comments only where they explain; keep engine.ts's teaching comments.

## Report (engine-api.html, then PDF)
- Same CSS/structure as `docs\porting\report-template.html`: intro, types sorted
  alphabetically (not grouped), then functions, each with a domain-named signature in the
  target language (the declared name in `<b>`, so the list scans), a short description,
  and a grey "stored as" line (CSS class `.s`) wherever the concrete representation matters.
- For classes/records/structs show their fields/properties.
- Describe the code as it IS (no "was"/history/proposal language).
- State which domain names are real types in the code and which exist only in the report.
- Render the PDF with Edge (adjust $h/$o):
  `$h="...\engine-api.html"; $o="...\engine-api.pdf"; & "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --headless --disable-gpu --no-pdf-header-footer "--print-to-pdf=$o" ("file:///"+($h -replace '\\','/'))`

## Rules
- Use ONLY toolchains already installed (paths below). Do NOT download or install anything:
  no binaries, no compilers, no NuGet/Maven/opam/pkg packages. If something is missing, stop
  and say so.
- Do not touch files outside `ports\<lang>\` (you may read anything). Do not commit.
- Do not use web_fetch. If you truly need the web, use `curl.exe`.
- Finish with a SHORT report: file sizes/line counts, diff result, perft 5 result and
  time, bench nps vs engine.ts, run/build commands, and any place where the language forced
  a deviation from engine.ts (with why).

## Installed toolchains (on the machine the ports were written on)
- .NET SDK 8.0.428 (`dotnet`; C# 12, F# 8; `dotnet fsi` runs .fsx scripts)
- Kotlin 2.3.20: `C:\Program Files\JetBrains\IntelliJ IDEA 2026.1.3\plugins\Kotlin\kotlinc\bin\kotlinc.bat`
  (not on PATH); Java 25 (`java`, Amazon Corretto) on PATH
- GCC/G++ 13.1 (MinGW, from CLion): `C:\Program Files\JetBrains\CLion 2024.3.3\bin\mingw\bin\`
  (gcc.exe, g++.exe; not on PATH: prepend it to $env:PATH within the command)
- Julia 1.13.3 (`julia` on PATH)
- Racket: `C:\Program Files\Racket\Racket.exe` and `raco.exe` (not on PATH)
- Python 3.13 (`python` on PATH)
- Go 1.24 (`go` on PATH)
- Bun 1.4 (`bun`) runs engine.ts and tools/uci-diff.js
