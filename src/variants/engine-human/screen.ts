// Screen candidate move features before adding them to features.ts: which ones would improve
// the model, and by how much, without retraining.
//
//   bun src/variants/engine-human/screen.ts [--weights data/weights-1900-run3.json]
//     [--data data/valid-1900-2019-11.jsonl] [--rate 0.004] [--max-games N]
//
// For each sampled position, the trained model (features.ts and its weights) gives every legal
// move a probability. For a candidate feature x (0 or 1 per move), the score test compares the
// human's move with the model's expectation: g = x(played) - E[x], I = E[x^2] - E[x]^2. Summed
// over n positions, G = sum g and I = sum I estimate the log-likelihood the feature would add
// if it were given its best weight: about G^2 / (2 I) in total, reported per 1,000 positions,
// with z = G / sqrt(I) for its significance and the sign of the weight it would get. Candidates
// come from the motifs of A Field Guide to Chess Tactics (chesstactics.org) - the double attack,
// the loose piece, discovered attacks, pins and skewers, removing the guard, mate - and from
// other phase-independent ideas: exchanges by material balance, answers to check, the move's
// shape, the last move, pawn structure.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DIAGONALS, FEATURES, KING_STEPS, LINES, VALUE, attacks, cheapestAttacker, chess, enPrise, moveFeatures, samples,
} from "./features.ts";

const dataDir = join(import.meta.dir, "data");

/** What a candidate may look at: one legal move of a position. */
interface Move {
  readonly pos: any;
  readonly after: any;
  readonly board: Int8Array;
  readonly next: Int8Array;
  readonly from: number;
  readonly to: number;
  readonly type: number;        // moved piece type, 1..6
  readonly piece: number;       // its type after the move (promotion)
  readonly captured: number;    // captured piece type, or 0
  readonly castle: boolean;
  readonly us: number;
  readonly them: number;
  readonly lastTo: number;
  readonly enemyKing: number;   // after the move
  readonly material: number;    // our material minus theirs before the move, in pawns
  readonly enemyEnPriseBefore: number;
}

/** A candidate feature. */
interface Candidate {
  readonly name: string;
  readonly test: (m: Move) => boolean;
}

/* Chebyshev distance between two 0x88 squares. */
const distance = (a: number, b: number) => Math.max(Math.abs((a & 7) - (b & 7)), Math.abs((a >> 4) - (b >> 4)));
/* The rank of `sq` from the side of colour `colour`, 0..7. */
const rankFor = (sq: number, colour: number) => (colour === 0 ? sq >> 4 : 7 - (sq >> 4));

/* The first occupied square from `sq` (not included) in direction `d`, or -1. */
function firstPiece(board: Int8Array, sq: number, d: number): number {
  for (let s = sq + d; (s & 0x88) === 0; s += d) if (board[s] !== 0) return s;
  return -1;
}

/* How many pieces of colour `by` attack `sq`. */
function attackerCount(board: Int8Array, sq: number, by: number): number {
  let count = 0;
  for (let s = 0; s < 128; s++) {
    if ((s & 0x88) !== 0 || board[s] === 0 || board[s] >> 3 !== by) continue;
    if (attacks(board, s, board[s] & 7, by).includes(sq)) count++;
  }
  return count;
}

/* Our material minus theirs on `board`, in pawns. */
function materialBalance(board: Int8Array, us: number): number {
  let sum = 0;
  for (let s = 0; s < 128; s++) {
    const p = board[s];
    if ((s & 0x88) === 0 && p !== 0 && (p & 7) !== 6) sum += (p >> 3 === us ? 1 : -1) * VALUE[p & 7];
  }
  return sum;
}

/* How many pieces of colour `colour` (not kings) are en prise on `board`. */
function enPriseCount(board: Int8Array, colour: number): number {
  let count = 0;
  for (let s = 0; s < 128; s++) {
    const p = board[s];
    if ((s & 0x88) === 0 && p !== 0 && p >> 3 === colour && (p & 7) !== 6 &&
      enPrise(board, s, VALUE[p & 7], 1 - colour, colour)) count++;
  }
  return count;
}

/* Do the moved slider's lines from `to` hit an enemy piece `a` and then an enemy piece `b` such
   that `ok(a, b)`? */
function throughLine(m: Move, ok: (a: number, b: number) => boolean): boolean {
  const dirs = m.piece === 3 ? DIAGONALS : m.piece === 4 ? LINES : m.piece === 5 ? [...DIAGONALS, ...LINES] : [];
  return dirs.some((d) => {
    const a = firstPiece(m.next, m.to, d);
    if (a < 0 || m.next[a] >> 3 !== m.them) return false;
    const b = firstPiece(m.next, a, d);
    return b >= 0 && m.next[b] >> 3 === m.them && ok(m.next[a] & 7, m.next[b] & 7);
  });
}

/* Does moving off `from` open a line of one of our sliders onto an enemy piece worth more than
   it, or undefended? */
function discoveredAttack(m: Move): boolean {
  return [...DIAGONALS, ...LINES].some((d) => {
    const back = firstPiece(m.next, m.from, -d);
    if (back < 0 || m.next[back] >> 3 !== m.us) return false;
    const slider = m.next[back] & 7;
    if (!(slider === 5 || (slider === 3 && DIAGONALS.includes(d)) || (slider === 4 && LINES.includes(d)))) return false;
    const target = firstPiece(m.next, m.from, d);
    if (target < 0 || target === m.to || m.next[target] >> 3 !== m.them || (m.next[target] & 7) === 6) return false;
    return VALUE[m.next[target] & 7] > VALUE[slider] || cheapestAttacker(m.next, target, m.them) === 0;
  });
}

/* Is there an enemy pawn able to attack squares on files next to `sq`, ahead of it for colour `us`? */
function enemyPawnAhead(board: Int8Array, sq: number, us: number, sameFile: boolean): boolean {
  for (let s = 0; s < 128; s++) {
    if ((s & 0x88) !== 0 || board[s] !== (1 | ((1 - us) << 3))) continue;
    const df = Math.abs((s & 7) - (sq & 7));
    if ((df === 1 || (sameFile && df === 0)) && rankFor(s, us) > rankFor(sq, us)) return true;
  }
  return false;
}

/* The candidates. */
const CANDIDATES: readonly Candidate[] = [
  { name: "gives mate", test: (m) => chess.inCheck(m.after) && chess.legalMoves(m.after).length === 0 },
  { name: "double check", test: (m) => chess.inCheck(m.after) && attackerCount(m.next, m.enemyKing, m.us) >= 2 },
  { name: "discovered check", test: (m) => !m.castle && chess.inCheck(m.after) &&
    !attacks(m.next, m.to, m.piece, m.us).includes(m.enemyKing) },
  { name: "discovered attack", test: (m) => !m.castle && discoveredAttack(m) },
  { name: "absolute pin", test: (m) => !m.castle && throughLine(m, (a, b) => a !== 6 && b === 6) },
  { name: "relative pin", test: (m) => !m.castle && throughLine(m, (a, b) => a !== 6 && b !== 6 && VALUE[b] > VALUE[a]) },
  { name: "skewer", test: (m) => !m.castle && throughLine(m, (a, b) => b !== 6 && (a === 6 || VALUE[a] > VALUE[b])) },
  { name: "creates a new enemy target", test: (m) => enPriseCount(m.next, m.them) > m.enemyEnPriseBefore },
  { name: "removes a guard (capture)", test: (m) => m.captured !== 0 && enPriseCount(m.next, m.them) > Math.max(0, m.enemyEnPriseBefore - 1) },
  { name: "takes a loose piece", test: (m) => m.captured !== 0 && cheapestAttacker(m.board, m.to, m.them) === 0 },
  { name: "winning capture", test: (m) => m.captured !== 0 && VALUE[m.captured] > VALUE[m.type] },
  { name: "even trade", test: (m) => m.captured !== 0 && VALUE[m.captured] === VALUE[m.type] },
  { name: "even trade when ahead", test: (m) => m.captured !== 0 && VALUE[m.captured] === VALUE[m.type] && m.material >= 2 },
  { name: "even trade when behind", test: (m) => m.captured !== 0 && VALUE[m.captured] === VALUE[m.type] && m.material <= -2 },
  { name: "out of check: king move", test: (m) => chess.inCheck(m.pos) && m.type === 6 && m.captured === 0 },
  { name: "out of check: capture", test: (m) => chess.inCheck(m.pos) && m.captured !== 0 },
  { name: "out of check: block", test: (m) => chess.inCheck(m.pos) && m.type !== 6 && m.captured === 0 },
  { name: "attacks the king's zone", test: (m) => !m.castle && m.type !== 6 &&
    KING_STEPS.some((d) => attacks(m.next, m.to, m.piece, m.us).includes(m.enemyKing + d)) &&
    !KING_STEPS.some((d) => attacks(m.board, m.from, m.type, m.us).includes(m.pos.kingSq[m.them] + d)) },
  { name: "towards the enemy king", test: (m) => !m.castle && m.type !== 1 && m.type !== 6 &&
    distance(m.to, m.enemyKing) < distance(m.from, m.enemyKing) },
  { name: "long move (4+ squares)", test: (m) => !m.castle && distance(m.from, m.to) >= 4 },
  { name: "mobility +3 or more", test: (m) => !m.castle && m.type !== 1 &&
    attacks(m.next, m.to, m.piece, m.us).length - attacks(m.board, m.from, m.type, m.us).length >= 3 },
  { name: "next to the last move", test: (m) => m.lastTo >= 0 && m.captured === 0 && distance(m.to, m.lastTo) <= 1 },
  { name: "passed pawn", test: (m) => m.type === 1 && !enemyPawnAhead(m.next, m.to, m.us, true) },
  { name: "pawn attacks a pawn", test: (m) => m.type === 1 && m.captured === 0 &&
    attacks(m.next, m.to, 1, m.us).some((s) => m.next[s] === (1 | (m.them << 3))) },
  { name: "outpost (N or B)", test: (m) => (m.type === 2 || m.type === 3) && m.captured === 0 &&
    attacks(m.next, m.to, 1, m.them).some((s) => m.next[s] === (1 | (m.us << 3))) &&
    !enemyPawnAhead(m.next, m.to, m.us, false) },
];

/* The options of a command line. */
function options(argv: readonly string[]) {
  const value = (name: string, fallback: string) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
  };
  return {
    weights: value("--weights", join(dataDir, "weights-1900-run3.json")),
    data: value("--data", join(dataDir, "valid-1900-2019-11.jsonl")),
    rate: Number(value("--rate", "0.004")),
    maxGames: Number(value("--max-games", "0")),
  };
}

/* Screen the candidates and print them, most promising first. */
async function main(argv: readonly string[]): Promise<void> {
  const opts = options(argv);
  const w: number[] = JSON.parse(readFileSync(opts.weights, "utf8")).weights;
  if (w.length !== FEATURES) throw new Error(`${opts.weights} has ${w.length} weights; features.ts has ${FEATURES}`);
  const stats = CANDIDATES.map(() => ({ g: 0, info: 0, human: 0, model: 0, present: 0 }));
  const started = Date.now();
  let n = 0, last = 0;
  for await (const s of samples(opts.data, opts.rate, opts.maxGames, () => {})) {
    const { moves, features } = moveFeatures(s.pos, s.lastTo, s.ply);
    const played = moves.findIndex((mv) => chess.moveToUci(mv, false) === s.played);
    if (played < 0) continue;
    const scores = features.map((f) => f.reduce((sum, k) => sum + w[k], 0));
    const max = Math.max(...scores);
    const exp = scores.map((x) => Math.exp(x - max));
    const z = exp.reduce((a, b) => a + b, 0);
    const p = exp.map((x) => x / z);
    const us = s.pos.sideToMove, them = 1 - us;
    const board: Int8Array = s.pos.board;
    const shared = { material: materialBalance(board, us), enemyEnPriseBefore: enPriseCount(board, them) };
    const values = moves.map((move) => {
      const after = chess.makeLegalMove(s.pos, move);
      const from = chess.fromSq(move), to = chess.toSq(move), type = board[from] & 7;
      const castle = chess.moveType(move) === chess.FLAG_CASTLE;
      const captured = castle ? 0 : chess.moveType(move) === chess.FLAG_EP ? 1 : board[to] & 7;
      const m: Move = { pos: s.pos, after, board, next: after.board, from, to, type,
        piece: chess.promoType(move) || type, captured, castle, us, them, lastTo: s.lastTo,
        enemyKing: after.kingSq[them], ...shared };
      return CANDIDATES.map((c) => (c.test(m) ? 1 : 0));
    });
    CANDIDATES.forEach((_, c) => {
      let expect = 0, any = 0;
      values.forEach((v, i) => { expect += p[i] * v[c]; any |= v[c]; });
      const st = stats[c];
      st.g += values[played][c] - expect;
      st.info += expect - expect * expect;
      st.human += values[played][c];
      st.model += expect;
      st.present += any;
    });
    n++;
    if (Date.now() - last > 10000) {
      last = Date.now();
      console.log(`  ${n.toLocaleString()} positions, ${((Date.now() - started) / 1000).toFixed(0)} s`);
    }
  }
  const rows = CANDIDATES.map((c, i) => {
    const { g, info, human, model, present } = stats[i];
    return { name: c.name, gain: info > 0 ? (1000 * g * g) / (2 * info) / n : 0, z: info > 0 ? g / Math.sqrt(info) : 0,
      human: human / n, model: model / n, present: present / n };
  }).sort((a, b) => b.gain - a.gain);
  console.log(`${n.toLocaleString()} positions in ${((Date.now() - started) / 1000).toFixed(0)} s; ` +
    "gain = log-likelihood added per 1,000 positions; human/model = how often the played/expected move has it");
  console.log(`${"candidate".padEnd(28)} ${"gain".padStart(6)} ${"z".padStart(6)} ${"human".padStart(7)} ${"model".padStart(7)} ${"present".padStart(8)}`);
  for (const r of rows) {
    console.log(`${r.name.padEnd(28)} ${r.gain.toFixed(2).padStart(6)} ${r.z.toFixed(1).padStart(6)} ` +
      `${(100 * r.human).toFixed(2).padStart(6)}% ${(100 * r.model).toFixed(2).padStart(6)}% ${(100 * r.present).toFixed(1).padStart(7)}%`);
  }
}

if (import.meta.main) await main(process.argv.slice(2));
