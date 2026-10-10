// Reproducible match runner for cutechess-cli. See README.md for setup and examples.
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const here = dirname(Bun.main);
const root = resolve(here, "..");
const defaultEngine = resolve(root, "pedagog.js");
const book = resolve(here, "8moves_v3.epd");
const help = `Usage: bun tools/match.js <A> <B> <even-games> [options]

Players: L1..L10, L10@<depth>, prev:L1..L10, maia-1100|maia-1500|maia-1900
Options:
  --engine PATH             Current Pedagog source (default: PEDAGOG_ENGINE or repo engine)
  --previous-engine PATH    Source for prev:<level> (default: PEDAGOG_PREVIOUS_ENGINE)
  --time SECONDS            Fixed per-move time for Pedagog (cutechess st=N)
  --seed INTEGER            cutechess opening RNG seed (default: 1)
  --concurrency N           Parallel games (default: min(10, CPU count))
  --tag NAME                Output basename (must be new unless --force)
  --out DIR                 Output directory (default: tools/out)
  --force                   Replace only this run's PGN and metadata files
  --help                    Show this help

Environment: CUTECHESS_CLI, LC0, MAIA_DIR, PEDAGOG_ENGINE,
PEDAGOG_PREVIOUS_ENGINE, PEDAGOG_OUTPUT_DIR, PEDAGOG_CONCURRENCY.`;

const values = new Map();
const positional = [];
let force = false;
const valuedOptions = new Set(["--engine", "--previous-engine", "--time", "--seed", "--concurrency", "--tag", "--out"]);
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === "--help" || arg === "-h") {
    console.log(help);
    process.exit(0);
  } else if (arg === "--force") {
    force = true;
  } else if (valuedOptions.has(arg)) {
    const value = process.argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${arg}`);
    values.set(arg, value);
  } else if (arg.startsWith("-")) {
    throw new Error(`unknown option: ${arg}\n\n${help}`);
  } else {
    positional.push(arg);
  }
}

const [a, b, gamesArg] = positional;
if (!a || !b || !gamesArg || positional.length !== 3) throw new Error(`expected two players and an even game count\n\n${help}`);
const games = Number(gamesArg);
if (!Number.isSafeInteger(games) || games < 2 || games % 2 !== 0) throw new Error("game count must be a positive even integer");
const seed = Number(values.get("--seed") ?? 1);
if (!Number.isSafeInteger(seed) || seed < 0) throw new Error("--seed must be a non-negative integer");
const concurrency = Number(values.get("--concurrency") ?? process.env.PEDAGOG_CONCURRENCY ?? Math.min(10, availableParallelism()));
if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error("--concurrency must be a positive integer");
const fixedTime = values.get("--time") === undefined ? undefined : Number(values.get("--time"));
if (fixedTime !== undefined && (!Number.isFinite(fixedTime) || fixedTime <= 0)) throw new Error("--time must be a positive number of seconds");

const enginePath = resolve(values.get("--engine") ?? process.env.PEDAGOG_ENGINE ?? defaultEngine);
const previousEngineValue = values.get("--previous-engine") ?? process.env.PEDAGOG_PREVIOUS_ENGINE;
const previousEnginePath = previousEngineValue ? resolve(previousEngineValue) : undefined;
const maiaDir = resolve(process.env.MAIA_DIR ?? join(here, "models"));
const lc0 = process.env.LC0 ?? "lc0";
const cutechessSetting = process.env.CUTECHESS_CLI ?? "cutechess-cli";
function executablePath(command) {
  const path = isAbsolute(command) || command.includes("/") || command.includes("\\")
    ? resolve(command)
    : Bun.which(command);
  return path && existsSync(path) ? path : undefined;
}
const cutechess = executablePath(cutechessSetting);
if (!cutechess) throw new Error(`cutechess-cli not found: ${cutechessSetting} (set CUTECHESS_CLI or add it to PATH)`);
const tag = (values.get("--tag") ?? `${a}-vs-${b}`).replace(/[:,]/g, "-");
if (!/^[A-Za-z0-9_.-]+$/.test(tag)) throw new Error("--tag may contain only letters, numbers, dots, underscores, and hyphens");
const outDir = resolve(values.get("--out") ?? process.env.PEDAGOG_OUTPUT_DIR ?? join(here, "out"));
const pgn = resolve(outDir, `${tag}.pgn`);
const metadataPath = resolve(outDir, `${tag}.json`);
const outputExists = existsSync(pgn) || existsSync(metadataPath);
if (outputExists && !force) throw new Error(`refusing to overwrite ${tag}; choose a new --tag or pass --force`);
if (!existsSync(enginePath)) throw new Error(`Pedagog engine not found: ${enginePath}`);
if (!existsSync(book)) throw new Error(`opening book not found: ${book}`);

const players = [];
const usedArtifacts = new Map();
usedArtifacts.set(cutechess, { kind: "cutechess-cli executable", path: cutechess });
usedArtifacts.set(process.execPath, { kind: "Bun runtime", path: process.execPath });
function engineArgs(spec) {
  const previous = spec.startsWith("prev:");
  const playerSpec = previous ? spec.slice(5) : spec;
  const levelMatch = /^L(\d+)(?:@(\d+))?$/.exec(playerSpec);
  if (levelMatch) {
    const level = Number(levelMatch[1]);
    const depth = levelMatch[2] === undefined ? undefined : Number(levelMatch[2]);
    if (level < 1 || level > 10 || (depth !== undefined && (!Number.isSafeInteger(depth) || depth < 1))) {
      throw new Error(`invalid Pedagog level or depth: ${spec}`);
    }
    if (previous && !previousEnginePath) throw new Error("prev:<level> requires --previous-engine or PEDAGOG_PREVIOUS_ENGINE");
    const source = previous ? previousEnginePath : enginePath;
    if (!existsSync(source)) throw new Error(`Pedagog engine not found: ${source}`);
    if (fixedTime !== undefined && depth !== undefined) throw new Error("--time cannot be combined with a fixed-depth player such as L10@6");
    const name = `${previous ? "prev-" : ""}${playerSpec}`;
    usedArtifacts.set(source, { kind: "Pedagog source", path: source });
    const limit = depth !== undefined ? ["tc=inf", `depth=${depth}`]
      : fixedTime !== undefined ? [`st=${fixedTime}`]
        : [level === 10 ? "tc=10+0.1" : "tc=inf"];
    return ["-engine", `name=${name}`, `cmd=${process.execPath}`, `arg=${source}`, "proto=uci", ...limit, `option.Skill_Level=${level}`];
  }
  if (/^maia-(1100|1500|1900)$/.test(spec)) {
    const weights = resolve(maiaDir, `${spec}.pb.gz`);
    if (!existsSync(weights)) throw new Error(`Maia weights not found: ${weights} (set MAIA_DIR)`);
    const lc0Executable = executablePath(lc0);
    if (!lc0Executable) throw new Error(`lc0 not found: ${lc0} (set LC0 or add it to PATH)`);
    usedArtifacts.set(lc0Executable, { kind: "Lc0 executable", path: lc0Executable });
    usedArtifacts.set(weights, { kind: "Maia network weights", path: weights });
    return ["-engine", `name=${spec}`, `cmd=${lc0Executable}`, `arg=--weights=${weights}`, "arg=--backend=blas",
      "proto=uci", "tc=inf", "nodes=1", "option.Threads=1"];
  }
  throw new Error(`unknown player spec: ${spec}`);
}

players.push(...engineArgs(a), ...engineArgs(b));
mkdirSync(outDir, { recursive: true });
if (outputExists) {
  if (existsSync(pgn)) rmSync(pgn);
  if (existsSync(metadataPath)) rmSync(metadataPath);
}
const cmd = [cutechess, ...players,
  "-each", "timemargin=200",
  "-openings", `file=${book}`, "format=epd", "order=random", "plies=16", "-repeat",
  "-games", "2", "-rounds", String(games / 2), "-concurrency", String(concurrency), "-srand", String(seed),
  "-draw", "movenumber=40", "movecount=8", "score=10",
  "-resign", "movecount=3", "score=600", "twosided=true",
  "-maxmoves", "250", "-recover", "-ratinginterval", "0", "-pgnout", pgn];

const started = Date.now();
const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
const [text, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
const exitCode = await proc.exited;
const score = [...text.matchAll(/Score of (\S+) vs (\S+): (\d+) - (\d+) - (\d+)/g)].pop();
if (exitCode !== 0 || !score) {
  console.error(text);
  console.error(err);
  throw new Error(`cutechess failed (exit ${exitCode})${score ? "" : " or did not report a match score"}`);
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
const artifacts = await Promise.all([...usedArtifacts.values()].map(async (artifact) => ({
  ...artifact, sha256: await sha256(artifact.path),
})));
const git = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root });
const revision = git.exitCode === 0 ? git.stdout.toString().trim() : null;
const status = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: root });
const metadata = {
  schema: 1,
  invocation: process.argv,
  command: cmd,
  players: [a, b],
  result: {
    firstPlayer: score[1], secondPlayer: score[2],
    firstWins: Number(score[3]), draws: Number(score[4]), secondWins: Number(score[5]),
    eloDifference: /Elo difference: (\S+) \+\/- (\S+)/.exec(text)?.slice(1) ?? null,
  },
  seed,
  openingBook: { path: book, sha256: await sha256(book) },
  artifacts,
  git: { revision, dirty: status.exitCode !== 0 || status.stdout.toString().trim().length > 0 },
  runtime: { bun: Bun.version, platform: process.platform, architecture: process.arch, hardwareConcurrency: availableParallelism() },
  configuration: { games, concurrency, fixedMoveTimeSeconds: fixedTime ?? null },
  durationSeconds: Math.round((Date.now() - started) / 1000),
};
writeFileSync(metadataPath, JSON.stringify(metadata, null, 2) + "\n", { flag: "wx" });
const elo = metadata.result.eloDifference;
console.log(`${tag}\t${score[1]} ${score[3]}-${score[4]}-${score[5]} ${score[2]}\tElo ${elo ? `${elo[0]} +/- ${elo[1]}` : "?"}\t${metadata.durationSeconds}s`);
console.log(`PGN: ${pgn}\nMetadata: ${metadataPath}`);
