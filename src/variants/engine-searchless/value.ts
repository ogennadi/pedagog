// A compact learned position value: 955 features of the position after a move, from the mover's
// side, whose weights are fitted so that the value differences between the legal moves of a
// position match how far below the best Stockfish scores each at depth 1 (sfblunders.ts's "loss1",
// capped at CAP). Then measures, on held-out positions, how often the engine's move (the best by a
// weights file) is a depth-1 blunder (150+ below the best) when the moves the value rates MARGIN or
// more below its best are ruled out, with the value alone choosing, and with the two added.
//
//   bun src/variants/engine-searchless/value.ts --data data/blunders-own.jsonl \
//     --weights data/weights-prune-replies-top40.json [--positions 70000] [--epochs 6]
//     [--out data/value.json]
//
// Features of the position after the move, "us" being the side that moved:
//   piece-square    phase (two buckets) x owner x piece type x square folded to files a-d,
//                   ranks counted from our side: 768
//   en prise        our pieces and theirs en prise, by type, one count each: 10
//   their replies   how many legal moves they have, in 8 bands: 8
//   king zones      squares next to each king that the other side attacks, a count each: 2
//   pawn shields    each side's pawns on the three squares in front of its king: 2
//   passed pawns    each side's passed pawns by rank (2nd to 7th, from its own side): 12
//   check           they are in check: 1
//   castling        rights each side still has: 2
// and classical terms generated per side ("our", "their"):
//   threats         each piece type (P-Q) attacked by a pawn, a minor piece, a rook, a queen or the
//                   king, hanging, pinned to its king, in the enemy half, nearly trapped: 90
//   mobility        safe squares of N, B, R, Q (not own pieces, not attacked by enemy pawns): 8
//   king danger     king and zone squares attacked, by attacking piece type: 10; safe checks the
//                   enemy has, by piece type: 8; king on an open or half-open file: 4
//   pawns           isolated, doubled, connected, side by side: 8; free passed pawns by rank: 12
//   pieces          bishop pair, rook on an open / half-open file, rook on the 7th, outpost: 10
// Counts repeat their feature. Every 5th position is held out.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DIAGONALS, KING_STEPS, KNIGHT_STEPS, LINES, VALUE, attacks, cheapestAttacker, chess, enPrise, uciMove,
} from "./features.ts";
import { lines } from "./testset.ts";
import { SETS } from "./train.ts";

const CAP = 600, BLUNDER = 150;
const PHASE_WEIGHT = [0, 0, 1, 1, 2, 4, 0];
const PSQ = 0, EN_PRISE = 768, REPLIES = 778, KING_ZONE = 786, SHIELD = 788, PASSED = 790, CHECK = 802, CASTLING = 803;
const THREAT = 805, MOBILITY = 895, KING_ATTACK = 903, SAFE_CHECK = 913, KING_FILE = 921, PAWNS = 925,
  PASSED_FREE = 933, BISHOP_PAIR = 945, ROOK_OPEN = 947, ROOK_HALF = 949, ROOK_7TH = 951, OUTPOST = 953;
export const VALUE_FEATURES = 955;
const REPLY_BANDS = [5, 10, 15, 20, 25, 30, 40];
const RELATIONS = ["attacked by a pawn", "attacked by a minor piece", "attacked by a rook", "attacked by a queen",
  "attacked by the king", "hanging", "pinned", "in the enemy half", "nearly trapped"];
const STRUCTURE = ["isolated pawns", "doubled pawns", "connected pawns", "pawns side by side"];

/* The rank of `sq` counted from `side`'s side, 0..7. */
const rankOf = (sq: number, side: number) => (side === 0 ? sq >> 4 : 7 - (sq >> 4));

/* The squares that `side`'s pieces attack on `board`: how many attack each square, and which piece
   types (bit t for type t). */
function attackMap(board: Int8Array, side: number): { count: Int8Array; types: Int8Array } {
  const count = new Int8Array(128), types = new Int8Array(128);
  for (let sq = 0; sq < 128; sq++) {
    const p = board[sq];
    if ((sq & 0x88) !== 0 || p === 0 || p >> 3 !== side) continue;
    for (const s of attacks(board, sq, p & 7, side)) {
      count[s]++;
      types[s] |= 1 << (p & 7);
    }
  }
  return { count, types };
}

/* The squares of `side`'s pieces pinned to its king on `board`. */
function pinned(board: Int8Array, side: number, king: number): Set<number> {
  const pins = new Set<number>();
  for (const d of [...DIAGONALS, ...LINES]) {
    let first = -1;
    for (let s = king + d; (s & 0x88) === 0; s += d) {
      if (board[s] === 0) continue;
      if (first < 0) {
        if (board[s] >> 3 !== side) break;
        first = s;
        continue;
      }
      const t = board[s] & 7;
      if (board[s] >> 3 !== side && (t === 5 || (t === 3 && DIAGONALS.includes(d)) || (t === 4 && LINES.includes(d)))) pins.add(first);
      break;
    }
  }
  return pins;
}

/* The classical evaluation terms of `next` (after a move by `us`), as value features: threats to
   each piece type, safe mobility, king danger, pawn structure, free passed pawns and piece placement,
   for both sides ("our" = us, "their" = them). Counts repeat their feature. */
function termFeatures(next: any, us: number): number[] {
  const board: Int8Array = next.board, f: number[] = [];
  const maps = [attackMap(board, 0), attackMap(board, 1)];
  for (const side of [us, 1 - us]) {
    const enemy = 1 - side, offset = side === us ? 0 : 1, king = next.kingSq[side];
    const mine = maps[side], theirs = maps[enemy], pins = pinned(board, side, king);
    const pawn = 1 | (side << 3), enemyPawn = 1 | (enemy << 3);
    const pawnsOn = (file: number, who: number) => {
      let n = 0;
      for (let r = 0; r < 8; r++) if (board[r * 16 + file] === (1 | (who << 3))) n++;
      return n;
    };
    let bishops = 0;
    for (let sq = 0; sq < 128; sq++) {
      const p = board[sq];
      if ((sq & 0x88) !== 0 || p === 0 || p >> 3 !== side) continue;
      const type = p & 7, file = sq & 7, rank = rankOf(sq, side);
      if (type === 6) continue;
      if (type === 3) bishops++;
      const hit = theirs.types[sq], base = THREAT + (offset * 5 + type - 1) * 9;
      if (hit & (1 << 1)) f.push(base);
      if (hit & ((1 << 2) | (1 << 3))) f.push(base + 1);
      if (hit & (1 << 4)) f.push(base + 2);
      if (hit & (1 << 5)) f.push(base + 3);
      if (hit & (1 << 6)) f.push(base + 4);
      if (hit !== 0 && mine.count[sq] === 0) f.push(base + 5);
      if (pins.has(sq)) f.push(base + 6);
      if (rank >= 4) f.push(base + 7);
      if (type >= 2 && type <= 5) {
        const safe = attacks(board, sq, type, side).filter((s) =>
          (board[s] === 0 || board[s] >> 3 !== side) && (theirs.types[s] & (1 << 1)) === 0).length;
        if (safe <= 1) f.push(base + 8);
        for (let i = 0; i < safe; i++) f.push(MOBILITY + offset * 4 + type - 2);
      }
      if (type === 1) {
        const isolated = (file === 0 || pawnsOn(file - 1, side) === 0) && (file === 7 || pawnsOn(file + 1, side) === 0);
        if (isolated) f.push(PAWNS + offset * 4);
        const ahead = side === 0 ? 16 : -16;
        for (let s = sq + ahead; (s & 0x88) === 0; s += ahead) if (board[s] === pawn) { f.push(PAWNS + offset * 4 + 1); break; }
        if ([sq - ahead - 1, sq - ahead + 1].some((s) => (s & 0x88) === 0 && board[s] === pawn)) f.push(PAWNS + offset * 4 + 2);
        if ([sq - 1, sq + 1].some((s) => (s & 0x88) === 0 && (s >> 4) === (sq >> 4) && board[s] === pawn)) f.push(PAWNS + offset * 4 + 3);
        let passed = true;
        for (let s = 0; s < 128 && passed; s++) {
          if ((s & 0x88) === 0 && board[s] === enemyPawn && Math.abs((s & 7) - file) <= 1 && rankOf(s, side) > rank) passed = false;
        }
        const front = sq + ahead;
        if (passed && (front & 0x88) === 0 && board[front] === 0 && theirs.count[front] === 0) {
          f.push(PASSED_FREE + offset * 6 + Math.min(5, Math.max(0, rank - 1)));
        }
      }
      if (type === 4) {
        const own = pawnsOn(file, side), other = pawnsOn(file, enemy);
        if (own === 0 && other === 0) f.push(ROOK_OPEN + offset);
        else if (own === 0) f.push(ROOK_HALF + offset);
        if (rank === 6) f.push(ROOK_7TH + offset);
      }
      if ((type === 2 || type === 3) && rank >= 3 && rank <= 5 && (mine.types[sq] & (1 << 1)) !== 0) {
        let attackable = false;
        for (let s = 0; s < 128 && !attackable; s++) {
          if ((s & 0x88) === 0 && board[s] === enemyPawn && Math.abs((s & 7) - file) === 1 && rankOf(s, side) > rank) attackable = true;
        }
        if (!attackable) f.push(OUTPOST + offset);
      }
    }
    if (bishops >= 2) f.push(BISHOP_PAIR + offset);
    for (const z of [king, ...KING_STEPS.map((d) => king + d)]) {
      if ((z & 0x88) !== 0) continue;
      for (let t = 1; t <= 5; t++) if (theirs.types[z] & (1 << t)) f.push(KING_ATTACK + offset * 5 + t - 1);
    }
    const checkFrom = (type: number, s: number) =>
      (board[s] === 0 || board[s] >> 3 === side) && (theirs.types[s] & (1 << type)) !== 0 && mine.count[s] === 0;
    for (const d of KNIGHT_STEPS) if (((king + d) & 0x88) === 0 && checkFrom(2, king + d)) f.push(SAFE_CHECK + offset * 4);
    for (const [dirs, kinds] of [[DIAGONALS, [3, 5]], [LINES, [4, 5]]] as const) {
      for (const d of dirs) {
        for (let s = king + d; (s & 0x88) === 0; s += d) {
          for (const t of kinds) if (checkFrom(t, s)) f.push(SAFE_CHECK + offset * 4 + t - 2);
          if (board[s] !== 0) break;
        }
      }
    }
    const kingFile = king & 7, own = pawnsOn(kingFile, side), other = pawnsOn(kingFile, enemy);
    if (own === 0 && other === 0) f.push(KING_FILE + offset * 2);
    else if (own === 0) f.push(KING_FILE + offset * 2 + 1);
  }
  return f;
}

/* The value features of `next`, the position after a move by `us`. */
export function valueFeatures(next: any, us: number): number[] {
  const board: Int8Array = next.board, them = 1 - us, f: number[] = [];
  let phase = 0;
  for (let sq = 0; sq < 128; sq++) if ((sq & 0x88) === 0) phase += PHASE_WEIGHT[board[sq] & 7];
  const bucket = phase > 12 ? 0 : 1;
  const rankFor = (sq: number) => (us === 0 ? sq >> 4 : 7 - (sq >> 4));
  const pawnAhead = (sq: number, owner: number) => {
    const enemyPawn = 1 | ((1 - owner) << 3), file = sq & 7;
    for (let s = 0; s < 128; s++) {
      if ((s & 0x88) !== 0 || board[s] !== enemyPawn || Math.abs((s & 7) - file) > 1) continue;
      if (owner === 0 ? s >> 4 > sq >> 4 : s >> 4 < sq >> 4) return true;
    }
    return false;
  };
  for (let sq = 0; sq < 128; sq++) {
    const p = board[sq];
    if ((sq & 0x88) !== 0 || p === 0) continue;
    const owner = p >> 3, type = p & 7, file = sq & 7;
    const folded = rankFor(sq) * 4 + (file < 4 ? file : 7 - file);
    f.push(PSQ + ((bucket * 2 + (owner === us ? 0 : 1)) * 6 + (type - 1)) * 32 + folded);
    if (type !== 6 && enPrise(board, sq, VALUE[type], 1 - owner, owner)) f.push(EN_PRISE + (owner === us ? 0 : 5) + type - 1);
    if (type === 1 && !pawnAhead(sq, owner)) {
      const rank = owner === 0 ? sq >> 4 : 7 - (sq >> 4);
      f.push(PASSED + (owner === us ? 0 : 6) + Math.min(5, Math.max(0, rank - 1)));
    }
  }
  const replies = chess.legalMoves(next).length;
  const band = REPLY_BANDS.findIndex((limit) => replies <= limit);
  f.push(REPLIES + (band < 0 ? REPLY_BANDS.length : band));
  for (const [side, offset] of [[us, 0], [them, 1]] as const) {
    const king = next.kingSq[side];
    for (const d of KING_STEPS) {
      const s = king + d;
      if ((s & 0x88) === 0 && cheapestAttacker(board, s, 1 - side) > 0) f.push(KING_ZONE + offset);
    }
    const ahead = side === 0 ? 16 : -16;
    for (const d of [-1, 0, 1]) {
      const s = king + ahead + d;
      if ((s & 0x88) === 0 && board[s] === (1 | (side << 3))) f.push(SHIELD + offset);
    }
    const rights = (next.castlingRights >> (2 * side)) & 3;
    for (let r = 0; r < ((rights & 1) + ((rights >> 1) & 1)); r++) f.push(CASTLING + offset);
  }
  if (chess.inCheck(next)) f.push(CHECK);
  return [...f, ...termFeatures(next, us)];
}

/* A name for value feature `k`. */
export function valueFeatureName(k: number): string {
  const piece = " PNBRQK";
  if (k < EN_PRISE) {
    const i = k - PSQ, sq = i % 32, rest = Math.floor(i / 32), type = rest % 6 + 1, group = Math.floor(rest / 6);
    return `${["opening/middlegame", "endgame"][Math.floor(group / 2)]} ${group % 2 === 0 ? "our" : "their"} ` +
      `${piece[type]} on ${"abcd"[sq % 4]}${Math.floor(sq / 4) + 1}`;
  }
  if (k < REPLIES) return `${k - EN_PRISE < 5 ? "our" : "their"} ${piece[(k - EN_PRISE) % 5 + 1]} en prise`;
  if (k < KING_ZONE) return `their replies: band ${k - REPLIES}`;
  if (k < SHIELD) return `${k === KING_ZONE ? "our" : "their"} king zone squares attacked`;
  if (k < PASSED) return `${k === SHIELD ? "our" : "their"} king's pawn shield`;
  if (k < CHECK) return `${k - PASSED < 6 ? "our" : "their"} passed pawn on rank ${(k - PASSED) % 6 + 2}`;
  if (k === CHECK) return "they are in check";
  if (k < THREAT) return `${k === CASTLING ? "our" : "their"} castling rights`;
  const side = (i: number) => (i === 0 ? "our" : "their");
  if (k < MOBILITY) {
    const i = k - THREAT, group = Math.floor(i / 9);
    return `${side(Math.floor(group / 5))} ${piece[group % 5 + 1]} ${RELATIONS[i % 9]}`;
  }
  if (k < KING_ATTACK) return `${side(Math.floor((k - MOBILITY) / 4))} ${piece[(k - MOBILITY) % 4 + 2]} safe mobility`;
  if (k < SAFE_CHECK) return `${side(Math.floor((k - KING_ATTACK) / 5))} king zone attacked by ${piece[(k - KING_ATTACK) % 5 + 1]}`;
  if (k < KING_FILE) return `safe ${piece[(k - SAFE_CHECK) % 4 + 2]} checks against ${side(Math.floor((k - SAFE_CHECK) / 4))} king`;
  if (k < PAWNS) return `${side(Math.floor((k - KING_FILE) / 2))} king on ${(k - KING_FILE) % 2 === 0 ? "an open" : "a half-open"} file`;
  if (k < PASSED_FREE) return `${side(Math.floor((k - PAWNS) / 4))} ${STRUCTURE[(k - PAWNS) % 4]}`;
  if (k < BISHOP_PAIR) return `${side(Math.floor((k - PASSED_FREE) / 6))} free passed pawn on rank ${(k - PASSED_FREE) % 6 + 2}`;
  if (k < ROOK_OPEN) return `${side(k - BISHOP_PAIR)} bishop pair`;
  if (k < ROOK_HALF) return `${side(k - ROOK_OPEN)} rook on an open file`;
  if (k < ROOK_7TH) return `${side(k - ROOK_HALF)} rook on a half-open file`;
  if (k < OUTPOST) return `${side(k - ROOK_7TH)} rook on the 7th`;
  return `${side(k - OUTPOST)} outpost`;
}

/** One position: per legal move its value features, Stockfish's depth-1 loss (capped), whether it
    is a blunder, and the weights file's score. */
interface Sample {
  readonly features: number[][];
  readonly loss: number[];
  readonly blunder: boolean[];
  readonly policy: number[];
}

/* The options of a command line. */
function options(argv: readonly string[]) {
  const value = (name: string, fallback: string) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
  };
  const dataDir = join(import.meta.dir, "data");
  return {
    data: value("--data", join(dataDir, "blunders-own.jsonl")),
    weights: value("--weights", join(dataDir, "weights-prune-replies-top40.json")),
    positions: Number(value("--positions", "70000")),
    epochs: Number(value("--epochs", "6")),
    learningRate: Number(value("--lr", "0.01")),
    out: value("--out", join(dataDir, "value.json")),
  };
}

/* The positions of `path`, at most `limit`, scored by `policy` (weights of feature set `policySet`). */
async function load(path: string, limit: number, policy: number[], policySet: string): Promise<Sample[]> {
  const set = SETS[policySet];
  const out: Sample[] = [];
  const started = Date.now();
  for await (const line of lines(Bun.file(path).stream())) {
    if (out.length >= limit) break;
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    const history: string[] = record.moves.slice(0, record.scored[0]);
    const fields = String(record.fen).split(" ");
    const firstPly = (Number(fields[5] ?? 1) - 1) * 2 + (fields[1] === "b" ? 1 : 0);
    let pos = chess.parseFen(record.fen);
    for (const uci of history) pos = chess.makeLegalMove(pos, uciMove(pos, uci));
    const square = (uci: string | undefined) => (uci ? chess.parseSquare(uci.slice(2, 4)) : -1);
    const n = history.length;
    const { moves, features } = set.featurize({ pos, ply: firstPly + n, lastTo: square(history[n - 1]),
      ourLastTo: square(history[n - 2]), played: "" });
    const loss1 = new Map<string, number>(record.loss1);
    const losses = moves.map((m: number) => loss1.get(chess.moveToUci(m, false)) ?? CAP);
    out.push({
      features: moves.map((m: number) => valueFeatures(chess.makeLegalMove(pos, m), pos.sideToMove)),
      loss: losses.map((l: number) => Math.min(CAP, l)),
      blunder: losses.map((l: number) => l >= BLUNDER),
      policy: features.map((f) => f.reduce((sum, k) => sum + (k < policy.length ? policy[k] : 0), 0)),
    });
    if (out.length % 5000 === 0) console.log(`  ${out.length.toLocaleString()} positions, ${((Date.now() - started) / 1000).toFixed(0)} s`);
  }
  return out;
}

/* The value (pawns) of each move of `s`. */
const values = (s: Sample, w: Float64Array) => s.features.map((f) => f.reduce((sum, k) => sum + w[k], 0));

/* `xs` less their mean. */
function centered(xs: number[]): number[] {
  const mean = xs.reduce((a, x) => a + x, 0) / xs.length;
  return xs.map((x) => x - mean);
}

/* Weights fitted by Adam so that, within each position, the values' deviations from their mean
   match the deviations of minus the losses (in pawns) from theirs. */
function fit(train: Sample[], epochs: number, learningRate: number): Float64Array {
  const w = new Float64Array(VALUE_FEATURES), m = new Float64Array(VALUE_FEATURES), v = new Float64Array(VALUE_FEATURES);
  let step = 0;
  for (let epoch = 1; epoch <= epochs; epoch++) {
    let squared = 0, n = 0;
    for (let b = 0; b < train.length; b += 32) {
      const g = new Float64Array(VALUE_FEATURES);
      for (const s of train.slice(b, b + 32)) {
        const aim = centered(s.loss.map((l) => -l / 100));
        centered(values(s, w)).forEach((x, j) => {
          const r = x - aim[j];
          squared += r * r;
          n++;
          for (const k of s.features[j]) g[k] += 2 * r;
        });
      }
      step++;
      for (let k = 0; k < VALUE_FEATURES; k++) {
        const grad = g[k] / 1000;
        m[k] = 0.9 * m[k] + 0.1 * grad;
        v[k] = 0.999 * v[k] + 0.001 * grad * grad;
        w[k] -= (learningRate * m[k] / (1 - 0.9 ** step)) / (Math.sqrt(v[k] / (1 - 0.999 ** step)) + 1e-8);
      }
    }
    console.log(`epoch ${epoch}: root mean square error ${Math.sqrt(squared / n).toFixed(3)} pawns`);
  }
  return w;
}

/* The first index of the largest of `scores` among those `allowed`, or among all if none is. */
function pick(scores: number[], allowed: (j: number) => boolean): number {
  const any = scores.some((_, j) => allowed(j));
  let best = -1;
  scores.forEach((x, j) => {
    if ((!any || allowed(j)) && (best < 0 || x > scores[best])) best = j;
  });
  return best;
}

async function main(argv: readonly string[]): Promise<void> {
  const opts = options(argv);
  const model = JSON.parse(readFileSync(opts.weights, "utf8"));
  const all = await load(opts.data, opts.positions, model.weights, model.set);
  const train = all.filter((_, i) => i % 5 !== 0), held = all.filter((_, i) => i % 5 === 0);
  console.log(`${all.length.toLocaleString()} positions (${held.length.toLocaleString()} held out), ` +
    `${(all.reduce((a, s) => a + s.features.reduce((b, f) => b + f.length, 0), 0) / all.reduce((a, s) => a + s.features.length, 0)).toFixed(1)} features a move`);
  const w = fit(train, opts.epochs, opts.learningRate);
  const rate = (choose: (s: Sample, v: number[]) => number) =>
    held.filter((s) => s.blunder[choose(s, values(s, w))]).length / held.length;
  const base = (s: Sample) => pick(s.policy, () => true);
  console.log(`the engine's move is a depth-1 blunder in ${(100 * rate((s) => base(s))).toFixed(1)}% of the held-out positions`);
  console.log(`the value alone: ${(100 * rate((_, v) => pick(v, () => true))).toFixed(1)}%`);
  for (const margin of [1, 1.5, 2, 3, 4]) {
    const vetoed = (s: Sample, v: number[]) => pick(s.policy, (j) => v[j] > Math.max(...v) - margin);
    const changed = held.filter((s) => vetoed(s, values(s, w)) !== base(s)).length / held.length;
    console.log(`  veto at ${margin} pawns: ${(100 * rate(vetoed)).toFixed(1)}%, move changed in ${(100 * changed).toFixed(1)}%`);
  }
  for (const mix of [0.5, 1, 2, 3, 4, 6, 8]) {
    const mixed = (s: Sample, v: number[]) => pick(s.policy.map((p, j) => p + mix * v[j]), () => true);
    console.log(`  weights + ${mix} x value: ${(100 * rate(mixed)).toFixed(1)}%`);
  }
  writeFileSync(opts.out, JSON.stringify({ features: VALUE_FEATURES,
    names: Array.from({ length: VALUE_FEATURES }, (_, k) => valueFeatureName(k)),
    weights: Array.from(w, (x) => Math.round(x * 1e4) / 1e4) }) + "\n");
  console.log(`wrote ${opts.out}; largest non-piece-square weights:`);
  for (const k of Array.from(w.keys()).filter((k) => k >= EN_PRISE).sort((a, b) => Math.abs(w[b]) - Math.abs(w[a])).slice(0, 12)) {
    console.log(`  ${valueFeatureName(k).padEnd(48)} ${w[k] >= 0 ? "+" : ""}${w[k].toFixed(3)}`);
  }
}

if (import.meta.main) await main(process.argv.slice(2));