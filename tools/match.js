// Match runner for the skill calibration: wraps cutechess-cli.
//
//   bun tools/match.js <A> <B> <games> [--concurrency N] [--tag name]
//
// A and B are player specs:  L<k>      Pedagog at Skill_Level k (k = SKILL_MAX uses the 10+0.1 clock,
//                                      lower levels are depth-bounded and get tc=inf)
//                            maia-1100 | maia-1500 | maia-1900   lc0 at one node
// Games come in pairs from the OpenBench 8moves_v3 book, both colours. The PGN is written to
// tools/out/<tag>.pgn (tag defaults to "<A>-vs-<B>"), and a one-line summary to tools/out/results.txt.

import { resolve, dirname } from "node:path";
import { existsSync, mkdirSync, appendFileSync, rmSync } from "node:fs";

const here = dirname(Bun.main);
const engine = resolve(here, "..", "pedagog.js");
const outDir = resolve(here, "out");
const book = resolve(here, "8moves_v3.epd");
const cutechess = "C:\\Program Files\\cutechess\\cutechess-cli.exe";
const lc0 = "C:\\Program Files\\Maia\\lc0.exe";
const maiaDir = "C:\\Program Files\\Maia";
const SKILL_MAX = 10;

const args = process.argv.slice(2);
const [a, b, gamesArg] = args;
const games = parseInt(gamesArg || "100");
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const concurrency = parseInt(opt("--concurrency", "10"));
const tag = (opt("--tag", `${a}-vs-${b}`)).replace(/[:,]/g, "_");
if (!a || !b) { console.error("usage: bun tools/match.js <A> <B> <games> [--concurrency N] [--tag name]"); process.exit(1); }

function playerArgs(spec) {
  const m = /^L(\d+)(?:@(\d+))?$/.exec(spec);     // L7, or L10@6 for a fixed search depth and no clock
  if (m) {
    const level = parseInt(m[1]), depth = m[2] ? parseInt(m[2]) : 0;
    const tc = level >= SKILL_MAX && !depth ? "tc=10+0.1" : "tc=inf";
    return ["-engine", `name=${spec}`, "cmd=bun", `arg=${engine}`, "proto=uci", tc, `option.Skill_Level=${level}`, ...(depth ? [`depth=${depth}`] : [])];
  }
  if (/^maia-\d+$/.test(spec)) {
    return ["-engine", `name=${spec}`, `cmd=${lc0}`, `arg=--weights=${maiaDir}\\${spec}.pb.gz`, "arg=--backend=blas",
            "proto=uci", "tc=inf", "nodes=1", "option.Threads=1"];
  }
  throw new Error("unknown player spec " + spec);
}

const players = [...playerArgs(a), ...playerArgs(b)];
mkdirSync(outDir, { recursive: true });
const pgn = resolve(outDir, `${tag}.pgn`);
if (existsSync(pgn)) rmSync(pgn);

const cmd = [cutechess, ...players,
  "-each", "timemargin=200",
  "-openings", `file=${book}`, "format=epd", "order=random", "plies=16", "-repeat",
  "-games", "2", "-rounds", String(Math.ceil(games / 2)), "-concurrency", String(concurrency),
  "-draw", "movenumber=40", "movecount=8", "score=10",
  "-resign", "movecount=3", "score=600", "twosided=true",
  "-maxmoves", "250", "-recover", "-ratinginterval", "0", "-pgnout", pgn];

const t0 = Date.now();
const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
const text = await new Response(proc.stdout).text();
const err = await new Response(proc.stderr).text();
await proc.exited;

const score = [...text.matchAll(/Score of (\S+) vs (\S+): (\d+) - (\d+) - (\d+)/g)].pop();
const elo = /Elo difference: (\S+) \+\/- (\S+)/.exec(text);
if (!score) { console.error(text, err); process.exit(1); }
const line = `${tag}\t${score[1]} ${score[3]}-${score[4]}-${score[5]} ${score[2]}\tElo ${elo ? elo[1] + " +/- " + elo[2] : "?"}\t${Math.round((Date.now() - t0) / 1000)}s`;
console.log(line);
appendFileSync(resolve(outDir, "results.txt"), line + "\n");
