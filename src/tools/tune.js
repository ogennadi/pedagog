// Auto-tune LEVEL_SETTINGS: move each skill level onto its target rating. See README.md.
//
//   bun src/tools/tune.js [--tag NAME] [--levels 2-10] [--write] [--simulate] ...   (--help)
//
// A candidate is a point s on one strength path (PATH: weakest to strongest, every setting
// moving one way), so tuning a level means finding one number. The tool rates the path's
// nodes against each other and Maia, places each level where the fitted curve meets its
// target, plays each placed level against the rated players nearest it, and re-places the
// levels that miss until every level is within the tolerance or the rounds run out. A
// candidate is a copy of the engine with one LEVEL_SETTINGS row replaced, so the engine needs
// no tuning option. Each side of a match gets its own Skill_Seed: two levels with one seed
// share their blind spots, which widens the gap measured between them. Stop it at any time;
// the same command resumes it.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const here = import.meta.dir;
const root = resolve(here, "..", "..");
const book = resolve(here, "8moves_v3.epd");
const SKILL_MAX = 10;
const NODE_SLOT = 9; // path nodes play as level 9 of their copy, as round 11's grid did
const C = Math.LN10 / 400; // slope of Elo's logistic curve, per Elo
const SCORE_LINE = /^Score of (\S+) vs (\S+): (\d+) - (\d+) - (\d+)\s+\[[^\]]*\]\s+(\d+)/;
const TABLE_ROW = /^(\s*)settings\(\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+)\s*\),\s*\/\/\s*(\d+)\b(.*)$/;

/* Planning ratings of the Maia networks on this scale (round 11's fits). */
export const MAIA = { "maia-1100": 1520, "maia-1500": 1690, "maia-1900": 1755 };

/* The strength path, weakest first: each node's [depth, deeperPermille, blunderWindow,
   blunderPermille, vision] and a planning rating. All nodes but P12 are round 11's grid
   (G0-G13) with its fitted ratings; P12, depth 4 unweakened, lets the top level reach its
   target without blunders or blind spots. */
export const PATH = [
  { settings: [1, 0, 900, 85, 450], prior: 240 },
  { settings: [1, 0, 800, 76, 560], prior: 288 },
  { settings: [1, 0, 700, 66, 670], prior: 312 },
  { settings: [1, 400, 660, 61, 710], prior: 446 },
  { settings: [1, 780, 615, 57, 745], prior: 649 },
  { settings: [2, 5, 555, 51, 805], prior: 872 },
  { settings: [2, 150, 480, 43, 875], prior: 985 },
  { settings: [2, 360, 415, 35, 930], prior: 1144 },
  { settings: [2, 690, 380, 26, 962], prior: 1281 },
  { settings: [3, 60, 330, 19, 985], prior: 1421 },
  { settings: [3, 500, 250, 12, 1000], prior: 1548 },
  { settings: [4, 0, 150, 6, 1012], prior: 1640 },
  { settings: [4, 0, 0, 0, 1024], prior: 1700 },
  { settings: [4, 500, 0, 0, 1024], prior: 1769 },
  { settings: [5, 0, 0, 0, 1024], prior: 1957 },
];

const HELP = `Usage: bun src/tools/tune.js [options]

Tunes the LEVEL_SETTINGS rows of engine.ts so that each level lands on its target rating.
Run the same command again to resume an interrupted (or finished) run.

Options:
  --tag NAME          Run name (default: date and time); files go to <out>/NAME
  --out DIR           Directory of runs (default: src/tools/out/tune)
  --engine PATH       Engine source to tune (default: engine.ts)
  --levels LIST       Levels to tune, e.g. 2-10 or 4,6-8 (default: 2-10)
  --targets LIST      Target ratings, e.g. 5=1250,6=1350 (default: the table's targets)
  --anchor NAME=ELO   Player held at a fixed rating: maia-1100|1500|1900 or a path
                      node P0..P${PATH.length - 1} (default: maia-1900=1755)
  --tolerance ELO     A level passes within this of its target (default: 30)
  --map-games N       Games per pairing while rating the path (default: 200)
  --games N           Games per pairing while verifying a level (default: 300)
  --opponents N       Rated opponents per candidate and round (default: 2)
  --rounds N          Most verification rounds (default: 4)
  --concurrency N     Games played at once (default: CPU count - 2)
  --seed N            Seeds the opening order and the Skill_Seeds (default: 1)
  --write             At the end, write the tuned rows into the engine's LEVEL_SETTINGS
  --simulate          Play no games: draw results from a made-up strength curve
  --help              Show this help

A resumed run keeps its settings, except --concurrency, --rounds and --write.
Environment: CUTECHESS_CLI, LC0, MAIA_DIR (as for match.js). Progress: a status line on
the console, and progress.json and log.txt in the run directory.`;

let child = null; // the cutechess-cli process of the match being played

/* ---- Options ------------------------------------------------------------------------------ */

/* The options of a command line; `given` lists the options it set. */
export function parseOptions(argv) {
  const valued = new Set(["--tag", "--out", "--engine", "--levels", "--targets", "--anchor", "--tolerance",
    "--map-games", "--games", "--opponents", "--rounds", "--concurrency", "--seed"]);
  const flags = new Set(["--write", "--simulate", "--help"]);
  const entries = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] === "-h" ? "--help" : argv[i];
    if (flags.has(arg)) {
      entries.push([arg, true]);
    } else if (valued.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`missing value for ${arg}`);
      entries.push([arg, value]);
      i++;
    } else {
      throw new Error(`unknown argument: ${arg}\n\n${HELP}`);
    }
  }
  const values = Object.fromEntries(entries);
  const integer = (name, fallback, min) => {
    const n = Number(values[name] ?? fallback);
    if (!Number.isSafeInteger(n) || n < min) throw new Error(`${name} must be an integer of at least ${min}`);
    return n;
  };
  const even = (name, fallback) => {
    const n = integer(name, fallback, 2);
    if (n % 2 !== 0) throw new Error(`${name} must be even: each opening is played with both colours`);
    return n;
  };
  const tag = values["--tag"] ?? defaultTag(new Date());
  if (!/^[A-Za-z0-9_.-]+$/.test(tag)) throw new Error("--tag may contain only letters, digits, dots, underscores and hyphens");
  return {
    help: values["--help"] === true,
    tag,
    out: resolve(values["--out"] ?? join(here, "out", "tune")),
    engine: resolve(values["--engine"] ?? join(root, "engine.ts")),
    levels: parseLevels(values["--levels"] ?? `2-${SKILL_MAX}`),
    targets: parseTargets(values["--targets"] ?? ""),
    anchor: parseAnchor(values["--anchor"] ?? "maia-1900=1755"),
    tolerance: integer("--tolerance", 30, 1),
    mapGames: even("--map-games", 200),
    games: even("--games", 300),
    opponents: integer("--opponents", 2, 1),
    rounds: integer("--rounds", 4, 1),
    concurrency: integer("--concurrency", Math.max(1, availableParallelism() - 2), 1),
    seed: integer("--seed", 1, 1),
    write: values["--write"] === true,
    simulate: values["--simulate"] === true,
    given: Object.keys(values),
  };
}

/* A run name from the date and time, such as 2026-11-16-0958. */
function defaultTag(date) {
  const two = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}-` +
    `${two(date.getHours())}${two(date.getMinutes())}`;
}

/* The levels of a list such as "2-10" or "4,6-8", sorted. */
export function parseLevels(text) {
  const levels = text.split(",").filter((item) => item.trim()).flatMap((item) => {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(item);
    if (!m) throw new Error(`bad --levels item: ${item}`);
    const [from, to] = [Number(m[1]), Number(m[2] ?? m[1])];
    return Array.from({ length: Math.max(0, to - from + 1) }, (_, k) => from + k);
  });
  if (levels.length === 0 || levels.some((level) => level < 2 || level > SKILL_MAX)) {
    throw new Error(`--levels must name levels from 2 to ${SKILL_MAX}`);
  }
  return [...new Set(levels)].sort((a, b) => a - b);
}

/* The targets of a list such as "5=1250,6=1350", by level. */
export function parseTargets(text) {
  return Object.fromEntries(text.split(",").filter((item) => item.trim()).map((item) => {
    const m = /^\s*(\d+)\s*=\s*(-?\d+)\s*$/.exec(item);
    if (!m) throw new Error(`bad --targets item: ${item} (want LEVEL=ELO)`);
    return [Number(m[1]), Number(m[2])];
  }));
}

/* The anchor of "maia-1900=1755" or "P13=1769": { name, elo }. */
export function parseAnchor(text) {
  const m = /^\s*(maia-(?:1100|1500|1900)|P\d+)\s*=\s*(-?\d+)\s*$/.exec(text);
  if (!m) throw new Error(`bad --anchor: ${text} (want maia-1900=1755, or a path node such as P13=1769)`);
  if (m[1].startsWith("P") && Number(m[1].slice(1)) >= PATH.length) {
    throw new Error(`no path node ${m[1]}: the nodes are P0..P${PATH.length - 1}`);
  }
  return { name: m[1], elo: Number(m[2]) };
}

/* ---- The path and the LEVEL_SETTINGS table ---------------------------------------------------- */

/* The settings at position `s` on `path` (0 = its first node): every setting interpolated
   linearly between the nodes either side, depth and deeper share as one number. */
export function settingsAt(path, s) {
  const x = Math.min(Math.max(s, 0), path.length - 1);
  const i = Math.min(Math.floor(x), path.length - 2), t = x - i;
  const [a, b] = [path[i].settings, path[i + 1].settings];
  const lerp = (u, v) => Math.round(u + t * (v - u));
  const depth = lerp(1000 * a[0] + a[1], 1000 * b[0] + b[1]);
  return [Math.floor(depth / 1000), depth % 1000, lerp(a[2], b[2]), lerp(a[3], b[3]), lerp(a[4], b[4])];
}

/* The planning rating at position `s` on `path`. */
export function priorAt(path, s) {
  const x = Math.min(Math.max(s, 0), path.length - 1);
  const i = Math.min(Math.floor(x), path.length - 2), t = x - i;
  return path[i].prior + t * (path[i + 1].prior - path[i].prior);
}

/* The LEVEL_SETTINGS rows of an engine source: { level: { settings, target, measured } }. */
export function parseTable(source) {
  return Object.fromEntries(source.split("\n")
    .map((line) => TABLE_ROW.exec(line.replace(/\r$/, "")))
    .filter(Boolean)
    .map((m) => {
      const [target, measured] = (m[8].match(/\d+/g) ?? []).map(Number);
      return [Number(m[7]), { settings: m.slice(2, 7).map(Number), target, measured }];
    }));
}

/* One LEVEL_SETTINGS row, laid out like the table in engine.ts. */
export function formatRow(level, settings, target, measured) {
  const pad = (value, width) => String(value ?? "").padStart(width);
  const [depth, deeper, blunderWindow, blunderPermille, vision] = settings;
  return (`  settings(${depth},${pad(deeper, 8)},${pad(blunderWindow, 8)},${pad(blunderPermille, 7)},` +
    `${pad(vision, 8)}),    // ${pad(level, 2)}${pad(target, 8)}${pad(measured, 9)}`).trimEnd();
}

/* `source` with the LEVEL_SETTINGS row of `level` rewritten to hold `settings`, keeping the
   row's line ending. */
export function withRow(source, level, settings, target, measured) {
  const lines = source.split("\n");
  const at = lines.findIndex((line) => Number(TABLE_ROW.exec(line.replace(/\r$/, ""))?.[7]) === level);
  if (at === -1) throw new Error(`no LEVEL_SETTINGS row for level ${level}`);
  const ending = lines[at].endsWith("\r") ? "\r" : "";
  return [...lines.slice(0, at), formatRow(level, settings, target, measured) + ending, ...lines.slice(at + 1)]
    .join("\n");
}

/* ---- Ratings ---------------------------------------------------------------------------------- */

/* Ratings for `results` ([{ a, b, aScore, games }]) under Elo's logistic curve, a draw counting
   half, with `anchor` held at `anchorElo`: the maximum-likelihood fit by Newton's method, with one
   virtual draw per pairing so that a 100 % score stays finite. The standard errors come from the
   inverse of the information matrix. Players with no chain of games to the anchor are left out.
   Returns { elo, se }, each by player name. */
export function fitRatings(results, anchor, anchorElo) {
  const merged = new Map();
  for (const { a, b, aScore, games } of results) {
    const [x, y, score] = a < b ? [a, b, aScore] : [b, a, games - aScore];
    const key = `${x}\t${y}`;
    const sum = merged.get(key) ?? { a: x, b: y, score: 0.5, games: 1 };
    merged.set(key, { ...sum, score: sum.score + score, games: sum.games + games });
  }
  const pairs = [...merged.values()];
  const reached = new Set([anchor]);
  for (let size = 0; size !== reached.size;) {
    size = reached.size;
    for (const { a, b } of pairs) {
      if (reached.has(a) || reached.has(b)) {
        reached.add(a);
        reached.add(b);
      }
    }
  }
  const linked = pairs.filter(({ a }) => reached.has(a));
  const free = [...reached].filter((name) => name !== anchor).sort();
  const index = new Map(free.map((name, i) => [name, i]));
  const elo = newton(linked, Object.fromEntries([...reached].map((name) => [name, anchorElo])), free, index);
  const covariance = free.length > 0 ? inverse(derivatives(linked, elo, index).information) : [];
  const se = (name) => (name === anchor ? 0 : Math.sqrt(covariance[index.get(name)][index.get(name)]));
  return { elo, se: Object.fromEntries([...reached].map((name) => [name, se(name)])) };
}

/* The ratings that maximise the likelihood of `pairs`, starting from `start` and moving only the
   players in `free`. */
function newton(pairs, start, free, index) {
  let elo = start;
  for (let iteration = 0; iteration < 100 && free.length > 0; iteration++) {
    const { gradient, information } = derivatives(pairs, elo, index);
    const step = solve(information, gradient).map((d) => Math.max(-300, Math.min(300, d)));
    elo = { ...elo, ...Object.fromEntries(free.map((name, i) => [name, elo[name] + step[i]])) };
    if (Math.max(...step.map(Math.abs)) < 1e-7) break;
  }
  return elo;
}

/* The gradient of the log-likelihood of `pairs` at `elo`, and its information matrix (minus its
   Hessian), over the players in `index`. */
function derivatives(pairs, elo, index) {
  const n = index.size;
  const gradient = new Array(n).fill(0);
  const information = Array.from({ length: n }, () => new Array(n).fill(0));
  for (const { a, b, score, games } of pairs) {
    const p = 1 / (1 + 10 ** ((elo[b] - elo[a]) / 400));
    const g = C * (score - games * p), w = C * C * games * p * (1 - p);
    const i = index.get(a), j = index.get(b);
    if (i !== undefined) {
      gradient[i] += g;
      information[i][i] += w;
    }
    if (j !== undefined) {
      gradient[j] -= g;
      information[j][j] += w;
    }
    if (i !== undefined && j !== undefined) {
      information[i][j] -= w;
      information[j][i] -= w;
    }
  }
  return { gradient, information };
}

/* m⁻¹·r for a square matrix m and a matrix r with as many rows, by Gauss-Jordan elimination with
   partial pivoting. */
function gaussJordan(m, r) {
  const n = m.length;
  const rows = m.map((row, i) => [...row, ...r[i]]);
  for (let col = 0; col < n; col++) {
    const pivot = rows.reduce((best, row, i) => (i > col && Math.abs(row[col]) > Math.abs(rows[best][col]) ? i : best), col);
    [rows[col], rows[pivot]] = [rows[pivot], rows[col]];
    const lead = rows[col][col];
    rows[col] = rows[col].map((v) => v / lead);
    for (let i = 0; i < n; i++) {
      const f = rows[i][col];
      if (i !== col && f !== 0) rows[i] = rows[i].map((v, j) => v - f * rows[col][j]);
    }
  }
  return rows.map((row) => row.slice(n));
}

/* The x with m·x = v. */
function solve(m, v) {
  return gaussJordan(m, v.map((x) => [x])).map(([x]) => x);
}

/* The inverse of the square matrix m. */
function inverse(m) {
  return gaussJordan(m, m.map((_, i) => m.map((__, j) => (i === j ? 1 : 0))));
}

/* ---- The strength curve ----------------------------------------------------------------------- */

/* Weighted isotonic regression (pool adjacent violators): the non-decreasing values nearest to
   `points` ([{ x, y, w }] sorted by x). Returns [{ x, y }] with the fitted y. */
export function isotonic(points) {
  const blocks = [];
  for (const { y, w } of points) {
    let block = { y, w, count: 1 };
    while (blocks.length > 0 && blocks[blocks.length - 1].y >= block.y) {
      const prev = blocks.pop();
      const weight = prev.w + block.w;
      block = { y: (prev.y * prev.w + block.y * block.w) / weight, w: weight, count: prev.count + block.count };
    }
    blocks.push(block);
  }
  const fitted = blocks.flatMap(({ y, count }) => new Array(count).fill(y));
  return points.map(({ x }, i) => ({ x, y: fitted[i] }));
}

/* The x at which the non-decreasing curve `fitted` ([{ x, y }]) reaches `y`: linear between its
   knots (one per distinct y, at the mean x of its points) and along the end segments beyond
   them. Null for a flat curve. */
export function invertCurve(fitted, y) {
  const knots = [];
  for (const point of fitted) {
    const last = knots[knots.length - 1];
    if (last !== undefined && last.y === point.y) knots[knots.length - 1] = { y: last.y, xs: [...last.xs, point.x] };
    else knots.push({ y: point.y, xs: [point.x] });
  }
  const at = knots.map(({ y: value, xs }) => ({ x: xs.reduce((sum, x) => sum + x, 0) / xs.length, y: value }));
  if (at.length < 2) return null;
  const above = at.findIndex((knot) => knot.y > y);
  const i = above === -1 ? at.length - 2 : Math.max(0, above - 1);
  return at[i].x + ((y - at[i].y) * (at[i + 1].x - at[i].x)) / (at[i + 1].y - at[i].y);
}

/* The strength curve along the path: every rated node and candidate as (s, rating), weighted by
   its precision and made non-decreasing; the planning ratings until two are rated. */
export function strengthCurve(state, fit) {
  const points = Object.entries(state.players)
    .filter(([name, player]) => player.kind !== "maia" && fit.elo[name] !== undefined)
    .map(([name, player]) => ({ x: player.s, y: fit.elo[name], w: 1 / Math.max(fit.se[name], 5) ** 2 }))
    .sort((p, q) => p.x - q.x);
  return points.length >= 2 ? isotonic(points) : PATH.map((node, i) => ({ x: i, y: node.prior }));
}

/* Where on the path `curve` puts `target`: kept on the path, rounded to a thousandth of a node. */
function placement(curve, target) {
  const s = invertCurve(curve, target) ?? invertCurve(PATH.map((node, i) => ({ x: i, y: node.prior })), target);
  return Math.round(1000 * Math.min(Math.max(s, 0), PATH.length - 1)) / 1000;
}

/* ---- Planning --------------------------------------------------------------------------------- */

/* The path nodes to rate for the ratings `wanted` (every node from 300 below the lowest to 250
   above the highest, plus one beyond each end) and the pairings that rate them: each node against
   the next two, and against the two nearest Maia networks within 300 Elo. */
export function mapPlan(path, wanted, maias) {
  const lo = Math.min(...wanted), hi = Math.max(...wanted);
  const inside = path.flatMap((node, i) => (node.prior >= lo - 300 && node.prior <= hi + 250 ? [i] : []));
  const below = path.findLastIndex((node) => node.prior < lo);
  const above = path.findIndex((node) => node.prior > hi);
  const nodes = [...new Set([below, ...inside, above].filter((i) => i >= 0))].sort((a, b) => a - b);
  const ladder = nodes.flatMap((n, k) => nodes.slice(k + 1, k + 3).map((m) => [`P${n}`, `P${m}`]));
  const maia = nodes.flatMap((n) => maias
    .map((name) => ({ name, gap: Math.abs(MAIA[name] - path[n].prior) }))
    .filter(({ gap }) => gap <= 300)
    .sort((x, y) => x.gap - y.gap)
    .slice(0, 2)
    .map(({ name }) => [`P${n}`, name]));
  return { nodes, pairs: [...ladder, ...maia] };
}

/* A 32-bit integer hash finaliser, as in engine.ts. */
function mix32(x) {
  const a = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  const b = Math.imul(a ^ (a >>> 16), 0x45d9f3b);
  return (b ^ (b >>> 16)) >>> 0;
}

/* Two different Skill_Seeds, from 1 to 2^31 - 1, for match `id` of a run seeded `seed`. */
export function matchSeeds(seed, id) {
  const draw = (k) => 1 + (mix32(mix32(seed) ^ Math.imul(2 * id + k + 1, 0x9e3779b9)) % 2147483646);
  const [a, b] = [draw(0), draw(1)];
  return [a, b === a ? (a % 2147483646) + 1 : b];
}

/* Match `id` of `games` games between `a` and `b`, not played yet. */
function newMatch(state, id, phase, a, b, games) {
  const pgn = `pgn/${String(id).padStart(3, "0")}-${a}-vs-${b}.pgn`;
  return { id, phase, a, b, games, seeds: matchSeeds(state.config.seed, id), pgn, done: false };
}

/* Up to `count` opponents ([{ name, elo }]) for a player expected at `elo`: the nearest rated
   below it and above it first, then the next nearest. */
export function pickOpponents(references, elo, count) {
  const distance = (r) => Math.abs(r.elo - elo);
  const byDistance = [...references].sort((x, y) => distance(x) - distance(y));
  const sides = [byDistance.find((r) => r.elo <= elo), byDistance.find((r) => r.elo > elo)]
    .filter(Boolean)
    .sort((x, y) => distance(x) - distance(y));
  return [...new Set([...sides, ...byDistance].map((r) => r.name))].slice(0, count);
}

/* ---- The run ---------------------------------------------------------------------------------- */

/* A new run's state: its settings, the path nodes and Maia networks it rates, and the matches
   that rate them. `source` is the engine to tune, `tools` what findTools() found. */
export function newRun(opts, source, tools) {
  const table = parseTable(source);
  const missing = opts.levels.find((level) => table[level] === undefined);
  if (missing !== undefined) throw new Error(`${opts.engine} has no LEVEL_SETTINGS row for level ${missing}`);
  const targets = Object.fromEntries(opts.levels.map((level) => [level, opts.targets[level] ?? table[level].target]));
  const untargeted = opts.levels.filter((level) => !Number.isFinite(targets[level]));
  if (untargeted.length > 0) throw new Error(`no target for level ${untargeted.join(", ")}: pass --targets`);
  const { anchor } = opts;
  const anchorIsMaia = anchor.name in MAIA;
  if (anchorIsMaia && !tools.maias.includes(anchor.name)) {
    throw new Error(`no ${anchor.name} network or no lc0 (set LC0 and MAIA_DIR); ` +
      "anchor on a path node instead, such as --anchor P13=1769");
  }
  const anchorRating = anchorIsMaia ? MAIA[anchor.name] : PATH[Number(anchor.name.slice(1))].prior;
  const plan = mapPlan(PATH, [...Object.values(targets), anchorRating], tools.maias);
  const maiasPlayed = [...new Set(plan.pairs.flat().filter((name) => name in MAIA))];
  const players = Object.fromEntries([
    ...plan.nodes.map((i) => [`P${i}`, { kind: "node", s: i, settings: PATH[i].settings, slot: NODE_SLOT, file: `engines/P${i}.ts` }]),
    ...maiasPlayed.map((name) => [name, { kind: "maia", weights: tools.maiaDir && join(tools.maiaDir, `${name}.pb.gz`) }]),
  ]);
  if (!(anchor.name in players)) throw new Error(`the anchor ${anchor.name} would play no games: choose one nearer the targets`);
  const config = {
    tag: opts.tag, engine: opts.engine, levels: opts.levels, targets, anchor, tolerance: opts.tolerance,
    mapGames: opts.mapGames, games: opts.games, opponents: opts.opponents, rounds: opts.rounds,
    concurrency: opts.concurrency, seed: opts.seed, simulate: opts.simulate, ...tools,
  };
  const draft = { version: 1, created: new Date().toISOString(), config, base: { sha256: sha256(source) },
    nodes: plan.nodes, players, matches: [], rounds: [] };
  return { ...draft, matches: plan.pairs.map(([a, b], id) => newMatch(draft, id, "map", a, b, opts.mapGames)) };
}

/* The ratings fitted to every finished match of the run. */
function fitState(state) {
  const results = state.matches.filter((m) => m.done)
    .map((m) => ({ a: m.a, b: m.b, aScore: m.result.aWins + m.result.draws / 2, games: m.result.games }));
  return fitRatings(results, state.config.anchor.name, state.config.anchor.elo);
}

/* The games of every finished match. */
function playedGames(state) {
  return state.matches.filter((m) => m.done).reduce((sum, m) => sum + m.result.games, 0);
}

/* Each tuned level under `fit`: its target; its best candidate so far, the one rated closest to
   the target; whether that is within the tolerance; and whether the target lies beyond the end of
   the path. */
export function levelReport(state, fit) {
  const { levels, targets, tolerance } = state.config;
  const last = PATH.length - 1;
  const games = (name) => state.matches.filter((m) => m.done && (m.a === name || m.b === name))
    .reduce((sum, m) => sum + m.result.games, 0);
  return Object.fromEntries(levels.map((level) => {
    const target = targets[level];
    const best = Object.entries(state.players)
      .filter(([name, player]) => player.kind === "candidate" && player.level === level && fit.elo[name] !== undefined)
      .map(([name, player]) => ({ name, s: player.s, settings: player.settings, elo: fit.elo[name], se: fit.se[name],
        error: fit.elo[name] - target, games: games(name) }))
      .sort((x, y) => Math.abs(x.error) - Math.abs(y.error) || x.se - y.se)[0];
    const ok = best !== undefined && Math.abs(best.error) <= tolerance;
    const beyond = best !== undefined && !ok && ((best.s >= last && best.error < 0) || (best.s <= 0 && best.error > 0));
    return [level, { target, best, ok, beyond }];
  }));
}

/* The state with the next round added: each of `levels` gets a candidate where the strength curve
   meets its target (an earlier candidate with the same settings is reused) and a match against
   each of the rated players nearest the target. */
export function withNewRound(state, fit, levels) {
  const number = state.rounds.length + 1;
  const curve = strengthCurve(state, fit);
  const references = Object.entries(state.players)
    .filter(([name, player]) => player.kind !== "candidate" && fit.elo[name] !== undefined)
    .map(([name]) => ({ name, elo: fit.elo[name] }));
  const placed = levels.map((level) => {
    const target = state.config.targets[level];
    const s = placement(curve, target);
    const settings = settingsAt(PATH, s);
    const twin = Object.entries(state.players).find(([, player]) =>
      player.kind === "candidate" && player.level === level && player.settings.join() === settings.join());
    const name = twin ? twin[0] : `L${level}r${number}`;
    const player = twin ? twin[1] : { kind: "candidate", level, s, settings, slot: level, file: `engines/${name}.ts` };
    return { level, name, player, opponents: pickOpponents(references, target, state.config.opponents) };
  });
  const first = state.matches.length;
  const matches = placed.flatMap(({ name, opponents }) => opponents.map((opponent) => [name, opponent]))
    .map(([a, b], k) => newMatch(state, first + k, `round ${number}`, a, b, state.config.games));
  return {
    ...state,
    players: { ...state.players, ...Object.fromEntries(placed.map(({ name, player }) => [name, player])) },
    matches: [...state.matches, ...matches],
    rounds: [...state.rounds, { number, candidates: Object.fromEntries(placed.map(({ level, name }) => [level, name])) }],
  };
}

/* ---- Playing matches -------------------------------------------------------------------------- */

/* The made-up true rating of a player in a --simulate run: Maia at its planning rating, the path at
   its planning ratings squeezed towards the middle, so that the tuner has something to correct. */
export function simulatedRating(name, player) {
  return player.kind === "maia" ? MAIA[name] : 0.85 * priorAt(PATH, player.s) + 200 + 15 * Math.sin(1.7 * player.s);
}

/* The next state of a 32-bit xorshift generator. */
function xorshift32(x) {
  const a = x ^ (x << 13);
  const b = a ^ (a >>> 17);
  return (b ^ (b << 5)) | 0;
}

/* `match` played by dice from the simulated ratings, with draws likelier between equals; each game
   is reported to `onGame` as cutechess-cli would. */
function simulateMatch(state, match, onGame) {
  const [ra, rb] = [match.a, match.b].map((name) => simulatedRating(name, state.players[name]));
  const p = 1 / (1 + 10 ** ((rb - ra) / 400));
  const draw = 0.4 * p * (1 - p);
  let random = (match.seeds[0] ^ match.seeds[1]) | 1;
  let wins = 0, losses = 0, draws = 0;
  for (let game = 1; game <= match.games; game++) {
    random = xorshift32(random);
    const u = (random >>> 0) / 2 ** 32;
    if (u < p - draw / 2) wins++;
    else if (u < p + draw / 2) draws++;
    else losses++;
    onGame(game, wins, losses, draws);
  }
  return { aWins: wins, draws, bWins: losses, games: match.games };
}

/* The tools a --simulate run pretends to have. */
function simulatedTools() {
  return { cutechess: null, lc0: null, maiaDir: null, maias: Object.keys(MAIA) };
}

/* cutechess-cli, lc0, the directory of the Maia networks and the networks found there. */
function findTools() {
  const cutechess = executablePath(process.env.CUTECHESS_CLI ?? "cutechess-cli");
  if (!cutechess) throw new Error("cutechess-cli not found (set CUTECHESS_CLI or add it to PATH)");
  const lc0 = executablePath(process.env.LC0 ?? "lc0") ?? null;
  const names = Object.keys(MAIA);
  const dirs = [process.env.MAIA_DIR, join(here, "models"), lc0 && dirname(lc0)].filter(Boolean);
  const maiaDir = lc0 === null ? null : dirs.find((dir) => names.some((name) => existsSync(join(dir, `${name}.pb.gz`)))) ?? null;
  const maias = maiaDir === null ? [] : names.filter((name) => existsSync(join(maiaDir, `${name}.pb.gz`)));
  return { cutechess, lc0, maiaDir, maias };
}

/* The full path of the program `command`, or undefined if there is none. */
function executablePath(command) {
  const path = isAbsolute(command) || command.includes("/") || command.includes("\\") ? resolve(command) : Bun.which(command);
  return path && existsSync(path) ? path : undefined;
}

/* Write the engine copy of every Pedagog player that has none yet: base.ts with the player's
   settings in the LEVEL_SETTINGS row it plays as. */
function writeEngines(state, runDir) {
  const base = readFileSync(join(runDir, "base.ts"), "utf8");
  for (const player of Object.values(state.players)) {
    if (player.kind !== "maia" && !existsSync(join(runDir, player.file))) {
      writeFileSync(join(runDir, player.file), withRow(base, player.slot, player.settings));
    }
  }
}

/* The cutechess-cli command for `match`, under the same conditions as match.js. */
function cutechessCommand(state, match, runDir) {
  const { config } = state;
  const engine = (name, seed) => {
    const player = state.players[name];
    return player.kind === "maia"
      ? ["-engine", `name=${name}`, `cmd=${config.lc0}`, `arg=--weights=${player.weights}`, "arg=--backend=blas",
        "proto=uci", "tc=inf", "nodes=1", "option.Threads=1"]
      : ["-engine", `name=${name}`, `cmd=${process.execPath}`, `arg=${join(runDir, player.file)}`, "proto=uci",
        "tc=inf", `option.Skill_Level=${player.slot}`, `option.Skill_Seed=${seed}`];
  };
  return [config.cutechess, ...engine(match.a, match.seeds[0]), ...engine(match.b, match.seeds[1]),
    "-each", "timemargin=200",
    "-openings", `file=${book}`, "format=epd", "order=random", "plies=16", "-repeat",
    "-games", "2", "-rounds", String(match.games / 2), "-concurrency", String(config.concurrency),
    "-srand", String(config.seed),
    "-draw", "movenumber=40", "movecount=8", "score=10",
    "-resign", "movecount=3", "score=600", "twosided=true",
    "-maxmoves", "250", "-recover", "-ratinginterval", "0", "-pgnout", join(runDir, match.pgn)];
}

/* `match` played by cutechess-cli, each finished game reported to `progress`; the result is
   counted from the PGN. */
async function playMatch(state, match, runDir, progress) {
  const pgn = join(runDir, match.pgn);
  rmSync(pgn, { force: true }); // a partial file left by an interrupted run
  const proc = Bun.spawn(cutechessCommand(state, match, runDir), { stdout: "pipe", stderr: "pipe" });
  child = proc;
  const errors = new Response(proc.stderr).text();
  const decoder = new TextDecoder();
  let output = "";
  let partial = "";
  for await (const bytes of proc.stdout) {
    const text = decoder.decode(bytes, { stream: true });
    output += text;
    const lines = (partial + text).split("\n");
    partial = lines.pop();
    for (const line of lines) {
      const score = SCORE_LINE.exec(line.trim());
      if (score) progress.game(Number(score[6]), Number(score[3]), Number(score[4]), Number(score[5]));
    }
  }
  const exitCode = await proc.exited;
  child = null;
  const result = existsSync(pgn) ? pgnResult(readFileSync(pgn, "utf8"), match.a, match.b) : { games: 0 };
  if (exitCode !== 0 || result.games === 0) {
    throw new Error(`cutechess-cli failed (exit ${exitCode}) in ${match.a} vs ${match.b}:\n${output.slice(-2000)}${await errors}`);
  }
  return result;
}

/* The result of `a` against `b` in a cutechess PGN: { aWins, draws, bWins, games }. */
export function pgnResult(text, a, b) {
  const pairing = [a, b].sort().join("\t");
  const outcomes = [...text.matchAll(/\[White "([^"]+)"\]\s*\[Black "([^"]+)"\]\s*\[Result "([^"]+)"\]/g)]
    .filter(([, white, black, result]) => [white, black].sort().join("\t") === pairing && result !== "*")
    .map(([, white, , result]) => (result === "1/2-1/2" ? 0 : (result === "1-0") === (white === a) ? 1 : -1));
  const count = (outcome) => outcomes.filter((o) => o === outcome).length;
  return { aWins: count(1), draws: count(0), bWins: count(-1), games: outcomes.length };
}

/* The SHA-256 of a string, in hex. */
function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/* Write `value` to `path` as JSON, through a temporary file so that a reader never sees half of
   it. On Windows a virus scanner or an editor may hold the file for a moment: retry then. */
function writeJson(path, value) {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(temporary, path);
      return;
    } catch (error) {
      if (attempt >= 20 || !["EPERM", "EBUSY", "EACCES"].includes(error.code)) throw error;
      Bun.sleepSync(50);
    }
  }
}

/* ---- Progress --------------------------------------------------------------------------------- */

/* Progress on the console and on disk. A status line (how far the phase is, its ETA, the match
   being played and its score, games per second) is redrawn in place on a terminal and printed
   every 30 seconds elsewhere. Finished matches and decisions get lines of their own, which are
   also appended to log.txt; progress.json holds the latest status for other programs. */
export class Progress {
  constructor(runDir, out = process.stdout, now = Date.now) {
    this.runDir = runDir;
    this.out = out;
    this.now = now;
    this.tty = Boolean(out.isTTY);
    this.started = now();
    this.games = 0; // games finished in this session
    this.phaseName = "";
    this.phaseGames = 0;
    this.phaseDone = 0;
    this.matchCount = 0;
    this.matchIndex = 0;
    this.matchLabel = "";
    this.matchGames = 0;
    this.live = { done: 0, wins: 0, losses: 0, draws: 0 };
    this.shown = 0; // length of the status line on screen
    this.lastDraw = 0;
    this.lastPrint = now();
    this.lastSave = 0;
  }

  /* Print `text` as a line of its own and append it to log.txt. */
  log(text) {
    this.clear();
    this.out.write(`${text}\n`);
    appendFileSync(join(this.runDir, "log.txt"), `${new Date(this.now()).toISOString()} ${text}\n`);
  }

  /* A phase of `matches` matches and `games` games begins, `played` of them already played. */
  phase(name, games, played, matches) {
    this.phaseName = name;
    this.phaseGames = games;
    this.phaseDone = played;
    this.matchCount = matches;
    this.log(`== ${name}: ${matches} matches, ${fmtInt(games)} games` +
      (played > 0 ? `, ${fmtInt(played)} of them played before` : ""));
  }

  /* Match `index` of the phase begins. */
  match(index, label, games) {
    this.matchIndex = index;
    this.matchLabel = label;
    this.matchGames = games;
    this.live = { done: 0, wins: 0, losses: 0, draws: 0 };
    this.draw(true);
  }

  /* The match's `done`th game has finished; the score so far is for its first player. */
  game(done, wins, losses, draws) {
    this.live = { done, wins, losses, draws };
    this.draw(false);
  }

  /* The match has finished after `games` games; `text` describes it. */
  matchDone(text, games) {
    this.phaseDone += games;
    this.games += games;
    this.matchLabel = "";
    this.live = { done: 0, wins: 0, losses: 0, draws: 0 };
    this.log(text);
    this.save();
  }

  /* The run has finished. */
  finish() {
    this.clear();
    this.phaseName = "finished";
    this.save();
  }

  /* Games per second in this session. */
  rate() {
    const seconds = (this.now() - this.started) / 1000;
    return seconds > 0 ? (this.games + this.live.done) / seconds : 0;
  }

  /* Seconds until the phase is over at the current rate, or null before the first game. */
  eta() {
    const rate = this.rate();
    return rate > 0 ? (this.phaseGames - this.phaseDone - this.live.done) / rate : null;
  }

  /* The status line. */
  status() {
    const done = this.phaseDone + this.live.done;
    const percent = this.phaseGames > 0 ? Math.floor((100 * done) / this.phaseGames) : 100;
    const eta = this.eta();
    const { wins, losses, draws } = this.live;
    return `[${this.phaseName}] ${percent}% of ${fmtInt(this.phaseGames)} games, ETA ${eta === null ? "?" : fmtDuration(eta)}` +
      ` | match ${this.matchIndex}/${this.matchCount} ${this.matchLabel} ${this.live.done}/${this.matchGames}` +
      ` +${wins} -${losses} =${draws} | ${this.rate().toFixed(1)} games/s` +
      ` | ${fmtDuration((this.now() - this.started) / 1000)} elapsed`;
  }

  /* Show the status line (at most four times a second on a terminal, every 30 seconds elsewhere)
     and save progress.json (every two seconds); `force` shows and saves it now. */
  draw(force) {
    const t = this.now();
    if (this.tty && (force || t - this.lastDraw >= 250)) {
      const line = this.status().slice(0, (this.out.columns || 120) - 1);
      this.out.write(`\r${line.padEnd(this.shown)}`);
      this.shown = line.length;
      this.lastDraw = t;
    } else if (!this.tty && t - this.lastPrint >= 30000) {
      this.out.write(`${this.status()}\n`);
      this.lastPrint = t;
    }
    if (force || t - this.lastSave >= 2000) this.save();
  }

  /* Wipe the status line off the screen. */
  clear() {
    if (this.shown > 0) this.out.write(`\r${" ".repeat(this.shown)}\r`);
    this.shown = 0;
  }

  /* Write progress.json. */
  save() {
    const done = this.phaseDone + this.live.done;
    const eta = this.eta();
    try {
      writeJson(join(this.runDir, "progress.json"), {
        phase: this.phaseName,
        phaseGames: this.phaseGames,
        phaseGamesDone: done,
        percent: this.phaseGames > 0 ? Math.floor((100 * done) / this.phaseGames) : 100,
        etaSeconds: eta === null ? null : Math.round(eta),
        match: this.matchIndex,
        matches: this.matchCount,
        playing: this.matchLabel || null,
        matchGames: this.matchGames,
        matchGamesDone: this.live.done,
        matchScore: { wins: this.live.wins, losses: this.live.losses, draws: this.live.draws },
        gamesPerSecond: Math.round(this.rate() * 100) / 100,
        elapsedSeconds: Math.round((this.now() - this.started) / 1000),
        updated: new Date(this.now()).toISOString(),
      });
    } catch {
      // progress.json is a convenience; it must never stop a run
    }
    this.lastSave = this.now();
  }
}

/* A whole number with thousands separators. */
function fmtInt(n) {
  return Math.round(n).toLocaleString("en-US");
}

/* A number with its sign. */
function signed(n) {
  return n > 0 ? `+${n}` : `${n}`;
}

/* A duration such as 45s, 3m09s or 1h02m. */
export function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

/* The Elo difference that `score` (0..1) implies. */
function eloFromScore(score) {
  return -400 * Math.log10(1 / Math.min(Math.max(score, 0.005), 0.995) - 1);
}

/* `items` in runs of `size`. */
function chunks(items, size) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));
}

/* ---- Reports ---------------------------------------------------------------------------------- */

/* What the run is about to do. */
function headerLines(state, resumed, runDir) {
  const { config } = state;
  const map = state.matches.filter((m) => m.phase === "map");
  return [
    `tune ${config.tag}: ${resumed ? "resuming" : "new run"} in ${relative(root, runDir)}`,
    `  engine   ${relative(root, config.engine)} (sha256 ${state.base.sha256.slice(0, 12)}, copied to base.ts)`,
    `  targets  ${config.levels.map((level) => `L${level} ${config.targets[level]}`).join(", ")}; tolerance ±${config.tolerance}`,
    `  anchor   ${config.anchor.name} = ${config.anchor.elo}; Maia networks: ${config.maias.join(", ") || "none"}`,
    `  plan     rate ${state.nodes.length} path nodes in ${map.length} matches of ${config.mapGames} games, then up to` +
      ` ${config.rounds} rounds of ${config.opponents} x ${config.games} games per level still off target`,
    config.simulate
      ? "  play     simulated: no games are played"
      : `  play     ${config.cutechess}, ${config.concurrency} games at once, seed ${config.seed}`,
    "  progress the status line below, and progress.json and log.txt in the run directory",
  ];
}

/* The ratings of the path nodes and Maia networks. */
function ratingLines(state, fit) {
  const items = Object.keys(state.players)
    .filter((name) => state.players[name].kind !== "candidate")
    .map((name) => (fit.elo[name] === undefined
      ? `${name} unrated`
      : `${name} ${Math.round(fit.elo[name])}${fit.se[name] > 0 ? `±${Math.round(1.96 * fit.se[name])}` : ""}`));
  return chunks(items, 6).map((part, i) => `${i === 0 ? "rated   " : "        "}${part.join(", ")}`);
}

/* Where the last round placed each level, and its opponents. */
function placementLines(state) {
  const round = state.rounds[state.rounds.length - 1];
  return Object.entries(round.candidates).map(([level, name]) => {
    const { s, settings } = state.players[name];
    const opponents = state.matches.filter((m) => m.phase === `round ${round.number}` && m.a === name).map((m) => m.b);
    return `  level ${level}: ${name} at s ${s.toFixed(3)} (${settings.join(" ")}), against ${opponents.join(" and ")}`;
  });
}

/* The table of tuned levels and their best candidates. */
function reportLines(state, fit, report, title) {
  const { config } = state;
  const columns = (level, target, name, s, settings, elo, ci, error, games, status) =>
    `${String(level).padStart(5)} ${String(target).padStart(6)}  ${name.padEnd(6)} ${s.padStart(6)}  ${settings.padEnd(18)}` +
    ` ${elo.padStart(5)} ${ci.padStart(4)} ${error.padStart(5)} ${games.padStart(6)}  ${status}`;
  const rows = config.levels.map((level) => {
    const { target, best, ok, beyond } = report[level];
    if (best === undefined) return columns(level, target, "-", "", "", "", "", "", "", "not rated yet");
    return columns(level, target, best.name, best.s.toFixed(3), best.settings.join(" "), String(Math.round(best.elo)),
      `±${Math.round(1.96 * best.se)}`, signed(Math.round(best.error)), String(best.games),
      ok ? "ok" : beyond ? "beyond the path" : "off target");
  });
  return [
    `${title}: ${fmtInt(playedGames(state))} games, ${config.anchor.name} = ${config.anchor.elo}`,
    columns("level", "target", "best", "s", "settings", "Elo", "95%", "error", "games", "status"),
    ...rows,
  ];
}

/* One finished match. */
function matchLine(phase, index, count, match, result, seconds) {
  const score = (result.aWins + result.draws / 2) / result.games;
  const short = result.games === match.games ? "" : ` (${result.games} of ${match.games} games recorded)`;
  return `[${phase} ${index}/${count}] ${match.a} vs ${match.b}: +${result.aWins} -${result.bWins} =${result.draws}` +
    ` (${(100 * score).toFixed(1)}%, ${signed(Math.round(eloFromScore(score)))} Elo) in ${fmtDuration(seconds)}${short}`;
}

/* ---- Main ------------------------------------------------------------------------------------- */

/* The state after playing the unfinished matches of `phase`, saving it after each one. */
async function playPhase(state, phase, runDir, progress, save) {
  const matches = state.matches.filter((m) => m.phase === phase);
  const pending = matches.filter((m) => !m.done);
  if (pending.length === 0) return state;
  if (!state.config.simulate) writeEngines(state, runDir);
  const games = (list) => list.reduce((sum, m) => sum + (m.done ? m.result.games : m.games), 0);
  progress.phase(phase, games(matches), games(matches.filter((m) => m.done)), matches.length);
  let current = state;
  for (const match of pending) {
    const index = matches.indexOf(match) + 1;
    progress.match(index, `${match.a} vs ${match.b}`, match.games);
    const started = Date.now();
    const result = current.config.simulate
      ? simulateMatch(current, match, (...live) => progress.game(...live))
      : await playMatch(current, match, runDir, progress);
    const seconds = Math.round((Date.now() - started) / 1000);
    current = { ...current, matches: current.matches.map((m) => (m.id === match.id ? { ...m, done: true, result, seconds } : m)) };
    save(current);
    progress.matchDone(matchLine(phase, index, matches.length, match, result, seconds), result.games);
  }
  return current;
}

/* Report each level's best candidate, save result.json and table.txt, and with --write put the
   rows into the engine. Returns the result. */
function finish(state, fit, opts, runDir, progress) {
  const { config } = state;
  const report = levelReport(state, fit);
  const chosen = config.levels.filter((level) => report[level].best !== undefined);
  const row = (level) => formatRow(level, report[level].best.settings, report[level].target, Math.round(report[level].best.elo));
  const rows = chosen.map(row);
  const result = {
    tag: config.tag,
    finished: new Date().toISOString(),
    anchor: config.anchor,
    tolerance: config.tolerance,
    games: playedGames(state),
    rounds: state.rounds.length,
    levels: Object.fromEntries(chosen.map((level) => {
      const { target, best, ok } = report[level];
      return [level, { target, candidate: best.name, s: best.s, settings: best.settings, elo: Math.round(best.elo),
        ci95: Math.round(1.96 * best.se), error: Math.round(best.error), games: best.games, ok }];
    })),
    ratings: Object.fromEntries(Object.keys(fit.elo).sort()
      .map((name) => [name, { elo: Math.round(fit.elo[name]), se: Math.round(fit.se[name]) }])),
  };
  writeJson(join(runDir, "result.json"), result);
  writeFileSync(join(runDir, "table.txt"), rows.map((line) => `${line}\n`).join(""));
  for (const line of reportLines(state, fit, report, "final")) progress.log(line);
  const missed = [
    ...chosen.filter((level) => !report[level].ok).map((level) => `level ${level} (${signed(Math.round(report[level].best.error))})`),
    ...config.levels.filter((level) => !chosen.includes(level)).map((level) => `level ${level} (not rated)`),
  ];
  progress.log(missed.length === 0
    ? `every level is within ±${config.tolerance} of its target`
    : `off target: ${missed.join(", ")}` +
      (state.rounds.length >= config.rounds ? `; run the same command with --rounds ${config.rounds + 2} to keep going` : ""));
  progress.log("LEVEL_SETTINGS rows (also in table.txt):");
  for (const line of rows) progress.log(line);
  if (opts.write && rows.length > 0) {
    const source = readFileSync(config.engine, "utf8");
    const before = parseTable(source);
    const updated = chosen.reduce((text, level) => withRow(text, level, report[level].best.settings,
      report[level].target, Math.round(report[level].best.elo)), source);
    writeFileSync(config.engine, updated);
    const topChanged = chosen.includes(SKILL_MAX) && before[SKILL_MAX].settings.join() !== report[SKILL_MAX].best.settings.join();
    progress.log(`wrote ${rows.length} rows into ${relative(root, config.engine)}; update the comment above the table` +
      ` and the docs by hand${topChanged ? `, and the bench signature: level ${SKILL_MAX} changed` : ""}`);
  } else {
    progress.log(`${relative(root, config.engine)} is unchanged; run the same command with --write to put these rows in`);
  }
  progress.finish();
  return result;
}

/* Run the tuner with the command-line arguments `argv`; returns the result, or null for --help. */
export async function main(argv) {
  const opts = parseOptions(argv);
  if (opts.help) {
    console.log(HELP);
    return null;
  }
  const runDir = join(opts.out, opts.tag);
  const statePath = join(runDir, "state.json");
  const resumed = existsSync(statePath);
  const source = resumed ? null : readFileSync(opts.engine, "utf8");
  const saved = resumed
    ? JSON.parse(readFileSync(statePath, "utf8"))
    : newRun(opts, source, opts.simulate ? simulatedTools() : findTools());
  const overrides = Object.fromEntries(["concurrency", "rounds"]
    .filter((key) => opts.given.includes(`--${key}`))
    .map((key) => [key, opts[key]]));
  const start = { ...saved, config: { ...saved.config, ...overrides } };
  mkdirSync(join(runDir, "engines"), { recursive: true });
  mkdirSync(join(runDir, "pgn"), { recursive: true });
  if (!resumed) writeFileSync(join(runDir, "base.ts"), source);
  const save = (state) => writeJson(statePath, state);
  save(start);
  const progress = new Progress(runDir);
  process.on("SIGINT", () => {
    child?.kill();
    progress.log("interrupted; run the same command again to resume");
    process.exit(130);
  });
  for (const line of headerLines(start, resumed, runDir)) progress.log(line);
  const mapped = await playPhase(start, "map", runDir, progress, save);
  const unfinished = mapped.rounds[mapped.rounds.length - 1];
  let state = unfinished ? await playPhase(mapped, `round ${unfinished.number}`, runDir, progress, save) : mapped;
  let fit = fitState(state);
  for (const line of ratingLines(state, fit)) progress.log(line);
  for (;;) {
    const report = levelReport(state, fit);
    const open = state.config.levels.filter((level) => !report[level].ok && !report[level].beyond);
    if (open.length === 0 || state.rounds.length >= state.config.rounds) break;
    if (state.rounds.length > 0) {
      for (const line of reportLines(state, fit, report, `after round ${state.rounds.length}`)) progress.log(line);
    }
    state = withNewRound(state, fit, open);
    save(state);
    progress.log(`round ${state.rounds.length} of at most ${state.config.rounds}: placing ${open.length} level` +
      `${open.length === 1 ? "" : "s"}`);
    for (const line of placementLines(state)) progress.log(line);
    state = await playPhase(state, `round ${state.rounds.length}`, runDir, progress, save);
    fit = fitState(state);
  }
  return finish(state, fit, opts, runDir, progress);
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(`\n${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
