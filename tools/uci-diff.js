// Differential test: feed the same UCI scripts to engine.ts and to another engine
// (a port, or an older engine.ts), and compare the output.
// Usage (from the repo root):  bun run diff <command> [args...]
//   e.g.  bun run diff dotnet ports/csharp/bin/Engine.dll
//         bun run diff bun path/to/old/engine.ts
// Timing (nps/time) is ignored; everything else must match line for line.
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";

const root = resolve(dirname(import.meta.path), "..");
const [cmd, ...args] = process.argv.slice(2);
if (!cmd) { console.log("usage: bun run diff <command> [args...]"); process.exit(2); }

const strip = (text) => text.split(/\r?\n/).filter((l) => l !== "").map((l) => l
  .replace(/ nps \d+ time \d+/, "")
  .replace(/ time \d+ nps \d+/, "")
  .replace(/ nodes \d+ time \d+ nps \d+/, (m) => m.replace(/ time \d+ nps \d+/, ""))
  .replace(/ \d+ nps$/, " nps"));

const kiwi = "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1";
const c960 = "bqnb1rkr/pp3ppp/3ppn2/2p5/5P2/P2P4/NPP1P1PP/BQ1BNRKR w HFhf - 2 9";
const scripts = [
  ["uci", "isready", "d", "eval", "perft 4"],
  [`position fen ${kiwi}`, "d", "perft 3", "go depth 4"],
  ["setoption name UCI_Chess960 value true", `position fen ${c960}`, "d", "perft 4", "go depth 4"],
  [`position fen ${c960} moves g1h1`, "d", "setoption name UCI_Chess960 value false",
    `position fen ${c960} moves e2e4 a7a6 g1g1`, "d"],
  ["position startpos moves e2e4 e7e5 g1f3 b8c6 f1c4 g8f6 e1g1", "d", "go depth 5"],
  ["position fen 8/P7/8/8/8/8/6k1/4K3 w - - 0 1", "go depth 5",
    "position fen 4k3/8/8/2pP4/8/8/8/4K3 w - c6 0 1", "d", "perft 3"],
  ["position startpos moves g1f3 g8f6 f3g1 f6g8 g1f3 g8f6 f3g1 f6g8", "d", "go depth 3"],
  ["position fen 7k/8/8/8/8/8/8/K7 w - - 0 1", "go depth 3", "position fen 7k/5Q2/6K1/8/8/8/8/8 b - - 0 1", "go depth 2"],
];
for (const level of [1, 2, 3, 5, 7, 9, 10]) {
  for (const seed of [0, 12345]) {
    for (const aggr of ["true", "false"]) {
      scripts.push([
        `setoption name Skill_Level value ${level}`,
        `setoption name Skill_Seed value ${seed}`,
        `setoption name Aggressive value ${aggr}`,
        "position startpos moves e2e4 c7c5 g1f3 d7d6", "eval", "go depth 6",
        `position fen ${kiwi}`, "go wtime 600000 btime 600000 depth 5",
        "position fen 6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1", "go depth 4",
      ]);
    }
  }
}
scripts.push(["position startpos moves e2e4 e7e5 d1h5 b8c6 f1c4 g8f6", "setoption name Skill_Level value 1", "go"]);
scripts.push(["bench 4"]);

let failures = 0;
for (const [i, script] of scripts.entries()) {
  const input = script.join("\n") + "\n";
  const run = (c, a) => strip(spawnSync(c, a, { cwd: root, input, encoding: "utf8", maxBuffer: 1 << 26 }).stdout ?? "");
  const want = run("bun", ["engine.ts"]);
  const got = run(cmd, args);
  const same = want.length === got.length && want.every((l, j) => l === got[j]);
  if (same) { console.log(`script ${i}: ${want.length} lines identical`); continue; }
  failures++;
  console.log(`SCRIPT ${i} DIFFERS: ${script.join(" | ")}`);
  let shown = 0;
  for (let j = 0; j < Math.max(want.length, got.length) && shown < 4; j++) {
    if (want[j] !== got[j]) { console.log(`  ts  : ${want[j]}\n  port: ${got[j]}`); shown++; }
  }
}
console.log(failures ? `${failures} FAILURES of ${scripts.length}` : `ALL ${scripts.length} IDENTICAL`);
process.exit(failures ? 1 : 0);
