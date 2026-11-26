// A match that survives interruption: src/tools/match.js in chunks of --chunk games (default
// 50), each with its own opening seed (1, 2, ...) and trap log. A chunk whose metadata JSON
// exists is finished and skipped, so rerunning the same command resumes where it stopped (an
// unfinished chunk is played again from its start). When every chunk is done, their PGNs are
// joined into <tag>.pgn and their trap logs into log-<tag>/, and the total is printed.
//
//   bun src/variants/engine-trickster/matches.js <tag> <A> <B> <games> [--chunk 50] [--out DIR]
//       [other match.js options, e.g. --engine PATH --option Trick_Lambda=0 --concurrency 22]
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(dirname(Bun.main), "..", "..", "..");
const [tag, a, b, gamesArg, ...options] = process.argv.slice(2);
const valueOf = (name, fallback) => {
  const at = options.indexOf(name);
  return at < 0 ? fallback : options[at + 1];
};
const passed = options.filter((_, i) =>
  !["--chunk", "--out"].includes(options[i]) && !["--chunk", "--out"].includes(options[i - 1]));
const chunk = Number(valueOf("--chunk", "50"));
const out = resolve(valueOf("--out", join(root, "src", "tools", "out", "trickster")));
const games = Number(gamesArg);
if (!tag || !a || !b || !Number.isSafeInteger(games) || chunk % 2 !== 0 || games % chunk !== 0)
  throw new Error("usage: matches.js <tag> <A> <B> <games> [--chunk N] [--out DIR] [match.js options];" +
    " games must be a multiple of an even chunk");
if (passed.some((o) => ["--seed", "--tag", "--force"].includes(o)))
  throw new Error("matches.js sets --seed, --tag and --force itself");

const chunkTag = (i) => `${tag}-c${String(i).padStart(2, "0")}`;
mkdirSync(out, { recursive: true });
for (let i = 1; i <= games / chunk; i++) {
  const t = chunkTag(i);
  if (existsSync(join(out, `${t}.json`))) {
    console.log(`${t}: already done`);
    continue;
  }
  const log = join(out, `log-${t}`);
  rmSync(log, { recursive: true, force: true });
  const run = Bun.spawnSync([process.execPath, join(root, "src", "tools", "match.js"), a, b, String(chunk),
    "--seed", String(i), "--tag", t, "--out", out, "--force", ...passed],
    { env: { ...process.env, TRICKSTER_LOG: log }, stdout: "inherit", stderr: "inherit" });
  if (run.exitCode !== 0) throw new Error(`${t} failed (exit ${run.exitCode}); rerun to resume`);
}

// Join the chunks.
const pgns = Array.from({ length: games / chunk }, (_, i) => readFileSync(join(out, `${chunkTag(i + 1)}.pgn`), "utf8"));
writeFileSync(join(out, `${tag}.pgn`), pgns.map((p) => p.trimEnd() + "\n\n").join(""));
const joinedLog = join(out, `log-${tag}`);
rmSync(joinedLog, { recursive: true, force: true });
mkdirSync(joinedLog, { recursive: true });
for (let i = 1; i <= games / chunk; i++) {
  const log = join(out, `log-${chunkTag(i)}`);
  if (!existsSync(log)) continue;
  for (const file of readdirSync(log))
    appendFileSync(join(joinedLog, "trick-joined.jsonl"), readFileSync(join(log, file), "utf8"));
}

// The total, from the PGNs' results, for player A.
let wins = 0, losses = 0, draws = 0;
for (const game of pgns.join("\n").split(/(?=\[Event )/)) {
  const white = /\[White "([^"]+)"\]/.exec(game)?.[1];
  const result = /\[Result "([^"]+)"\]/.exec(game)?.[1];
  if (!white || !result || result === "*") continue;
  if (result === "1/2-1/2") draws++;
  else if ((result === "1-0") === (white === a)) wins++;
  else losses++;
}
const n = wins + losses + draws;
const score = (wins + draws / 2) / n;
const elo = (s) => -400 * Math.log10(1 / s - 1);
const sd = Math.sqrt((wins * (1 - score) ** 2 + losses * score ** 2 + draws * (0.5 - score) ** 2) / n / n);
const margin = (elo(Math.min(0.999, score + 1.96 * sd)) - elo(Math.max(0.001, score - 1.96 * sd))) / 2;
console.log(`${tag}\t${a} ${wins}-${losses}-${draws} ${b}\tElo ${elo(score).toFixed(1)} +/- ${margin.toFixed(1)}\t(${n} games)`);
console.log(`PGN: ${join(out, `${tag}.pgn`)}\nLog: ${joinedLog}`);
