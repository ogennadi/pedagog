// Fit Elo ratings to all games in tools/out/*.pgn (or the PGNs given on the command line).
//
//   bun tools/elo.js [--anchor maia-1900=1755] [--anchor-note "..."] [--only L,maia] [--json docs/skill-curve.json] [files...]
//
// Model: Elo's logistic expectation E = 1 / (1 + 10^(-(Ra - Rb) / 400)); a draw counts half.
// Ratings are found by iterating each player's rating so its expected total score matches its
// actual total (a fixed-point Bradley-Terry fit), with the anchor held fixed. Uncertainty comes
// from a bootstrap over games. The default anchor is Maia-1900 at 1755, the Lichess classical
// rating of the bot that runs that network (maia9, RD 45 over 141,012 games) on 2026-10-06.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";

const here = dirname(Bun.main);
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const [anchorName, anchorElo] = opt("--anchor", "maia-1900=1755").split("=");   // maia9's Lichess classical rating, 2026-10-06
const anchorNote = opt("--anchor-note", "its Lichess classical rating on 2026-10-06");
const only = opt("--only", "").split(",").filter(Boolean);
const jsonOut = opt("--json", "");
let files = args.filter((x, i) => !x.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
if (files.length === 0) files = readdirSync(resolve(here, "out")).filter((f) => f.endsWith(".pgn")).map((f) => resolve(here, "out", f));

// ---- Collect games: [white, black, score for white]
const games = [];
for (const f of files) {
  const text = readFileSync(f, "utf8");
  for (const m of text.matchAll(/\[White "([^"]+)"\]\s*\[Black "([^"]+)"\]\s*\[Result "([^"]+)"\]/g)) {
    const s = m[3] === "1-0" ? 1 : m[3] === "0-1" ? 0 : m[3] === "1/2-1/2" ? 0.5 : null;
    if (s === null) continue;
    if (only.length && !only.some((p) => m[1].startsWith(p)) && !only.some((p) => m[2].startsWith(p))) continue;
    games.push([m[1], m[2], s]);
  }
}
const players = [...new Set(games.flatMap((g) => [g[0], g[1]]))].sort(sortPlayers);
if (!players.includes(anchorName)) { console.error(`anchor ${anchorName} not found among`, players); process.exit(1); }

function sortPlayers(a, b) {
  const la = /^L(\d+)$/.exec(a), lb = /^L(\d+)$/.exec(b);
  if (la && lb) return parseInt(la[1]) - parseInt(lb[1]);
  if (la) return -1; if (lb) return 1;
  return a.localeCompare(b);
}

function fit(gs) {
  const idx = new Map(players.map((p, i) => [p, i]));
  const n = players.length, R = new Float64Array(n).fill(parseFloat(anchorElo));
  const actual = new Float64Array(n), count = new Float64Array(n);
  for (const [w, b, s] of gs) { actual[idx.get(w)] += s; actual[idx.get(b)] += 1 - s; count[idx.get(w)]++; count[idx.get(b)]++; }
  for (let iter = 0; iter < 200; iter++) {
    const expected = new Float64Array(n);
    for (const [w, b] of gs) {
      const e = 1 / (1 + Math.pow(10, (R[idx.get(b)] - R[idx.get(w)]) / 400));
      expected[idx.get(w)] += e; expected[idx.get(b)] += 1 - e;
    }
    let delta = 0;
    for (let i = 0; i < n; i++) {
      if (players[i] === anchorName || count[i] === 0) continue;
      // Clamp the per-game score so a perfect record stays finite.
      const a = Math.min(Math.max(actual[i] / count[i], 0.005), 0.995), e = Math.min(Math.max(expected[i] / count[i], 0.005), 0.995);
      const step = 400 * (Math.log10(a / (1 - a)) - Math.log10(e / (1 - e))) * 0.5;
      R[i] += step; delta = Math.max(delta, Math.abs(step));
    }
    if (delta < 0.01) break;
  }
  return R;
}

const R = fit(games);
const B = 200, boots = Array.from({ length: players.length }, () => []);
let seed = 12345;
const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;
for (let b = 0; b < B; b++) {
  const sample = Array.from({ length: games.length }, () => games[Math.floor(rnd() * games.length)]);
  const Rb = fit(sample);
  Rb.forEach((r, i) => boots[i].push(r));
}
const ci = (arr) => { const s = [...arr].sort((x, y) => x - y); return [s[Math.floor(0.025 * s.length)], s[Math.floor(0.975 * s.length)]]; };

// ---- Report
const games_of = (p) => games.filter((g) => g[0] === p || g[1] === p).length;
const rows = players.map((p, i) => ({ player: p, elo: Math.round(R[i]), lo: Math.round(ci(boots[i])[0]), hi: Math.round(ci(boots[i])[1]), games: games_of(p) }));
console.log("player        elo   95% interval   games");
for (const r of rows) console.log(`${r.player.padEnd(12)} ${String(r.elo).padStart(5)}   [${r.lo}, ${r.hi}]`.padEnd(38) + String(r.games).padStart(6));

// Adjacent levels: difference from the joint fit, and from head-to-head games alone.
const levels = rows.filter((r) => /^L\d+$/.test(r.player));
const gaps = [];
for (let i = 1; i < levels.length; i++) {
  const a = levels[i].player, b = levels[i - 1].player;
  const h2h = games.filter((g) => (g[0] === a && g[1] === b) || (g[0] === b && g[1] === a));
  let direct = null;
  if (h2h.length) {
    const score = h2h.reduce((s, g) => s + (g[0] === a ? g[2] : 1 - g[2]), 0) / h2h.length;
    const p = Math.min(Math.max(score, 0.005), 0.995);
    direct = Math.round(-400 * Math.log10(1 / p - 1));
  }
  const iA = players.indexOf(a), iB = players.indexOf(b);
  const diffs = boots[iA].map((r, k) => r - boots[iB][k]);
  gaps.push({ from: b, to: a, fitted: Math.round(R[iA] - R[iB]), lo: Math.round(ci(diffs)[0]), hi: Math.round(ci(diffs)[1]), direct, h2hGames: h2h.length });
}
if (gaps.length) {
  console.log("\nadjacent gap          fitted   95% interval   head-to-head (games)");
  for (const g of gaps) console.log(`${(g.from + " -> " + g.to).padEnd(20)} ${String(g.fitted).padStart(6)}   [${g.lo}, ${g.hi}]`.padEnd(44) + `${g.direct ?? "-"} (${g.h2hGames})`);
}
if (jsonOut) writeFileSync(resolve(jsonOut), JSON.stringify({ anchor: { [anchorName]: parseFloat(anchorElo) }, anchor_note: anchorNote, ratings: rows, gaps, games: games.length }, null, 2));
