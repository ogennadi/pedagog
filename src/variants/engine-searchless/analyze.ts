// Where does a searchless engine lose its games? Stockfish scores every position of a match's
// games; each of the engine's moves that loses 150+ centipawns (from a position not already
// decided, |score| <= 600) is a blunder, and is put down to a cause, using the engine's own
// strength features for its move and for Stockfish's move.
//
//   bun src/variants/engine-searchless/analyze.ts data/top40-vs-maia-1900.pgn engine-searchless \
//     [--depth 10] [--workers 26] [--examples 12] [--book-plies 16] [--horizon]
//
// --book-plies: games from an opening book whose FENs say move 1 start at that ply (as in uci.ts).
// --horizon: also find how deep Stockfish must look to see each blunder: the lowest depth, 1 to
// --depth, at which the move played scores 150+ below the best (both searched from an empty hash;
// depth 1 is one ply plus Stockfish's capture search). Blunders seen at depth 1-2 are within reach
// of a static evaluation; ones that need depth 3+ are tactics or plans beyond one move.
//
// Causes, first that applies:
//   allowed mate       our move allows mate in one (the static check sees it)
//   saw the loss       our move nets 3+ pawns worse than the best move (strength.ts's WORSE_NET):
//                      the static checks saw it, the weights chose it anyway
//   missed a win       Stockfish's move nets at least two bands more by the static checks
//   deeper: capture/check/quiet
//                      the static checks see no difference; by the kind of move Stockfish played
// Each cause is split by phase (opening before ply 30, endgame with little material, else
// middlegame). Prints counts and centipawns lost per cause, and example positions.

import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { VALUE, chess, phaseOf } from "./features.ts";
import { engineSpec, Uci } from "./score.ts";
import { ALLOWS_MATE, STRENGTH_SET, WORSE_NET_3 } from "./strength.ts";

const BLUNDER = 150, DECIDED = 600, MATE = 10000;

/** One game of the PGN, as positions. */
export interface Game {
  readonly white: string;
  readonly black: string;
  readonly fen: string;
  readonly moves: string[];   // UCI
}

/* The legal move of `pos` written as `san`, or null. */
function sanToMove(pos: any, san: string): number | null {
  const text = san.replace(/[+#!?]+$/, "");
  const moves: number[] = chess.legalMoves(pos);
  if (text === "O-O" || text === "O-O-O") {
    return moves.find((m) => chess.moveType(m) === chess.FLAG_CASTLE && (chess.toSq(m) > chess.fromSq(m)) === (text === "O-O")) ?? null;
  }
  const m = /^([KQRBN])?([a-h])?([1-8])?x?([a-h][1-8])(?:=?([QRBN]))?$/.exec(text);
  if (!m) return null;
  const [, piece, file, rank, to, promo] = m;
  const found = moves.filter((move) => chess.moveType(move) !== chess.FLAG_CASTLE &&
    "abcdefgh"[chess.toSq(move) & 7] + "12345678"[chess.toSq(move) >> 4] === to &&
    (pos.board[chess.fromSq(move)] & 7) === " PNBRQK".indexOf(piece ?? "P") &&
    chess.promoType(move) === (promo ? " PNBRQK".indexOf(promo) : 0) &&
    (!file || "abcdefgh"[chess.fromSq(move) & 7] === file) && (!rank || "12345678"[chess.fromSq(move) >> 4] === rank));
  return found.length === 1 ? found[0] : null;
}

/* The games of a cutechess PGN. */
export function readPgn(text: string): Game[] {
  return text.split(/\n(?=\[Event )/).filter((g) => g.includes("[White ")).map((g) => {
    const tag = (name: string) => new RegExp(`\\[${name} "([^"]*)"\\]`).exec(g)?.[1];
    const fen = tag("FEN") ?? "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    const movetext = g.split(/\n\s*\n/).slice(1).join(" ").replace(/\{[^}]*\}/g, " ").replace(/\d+\.(\.\.)?/g, " ");
    let pos = chess.parseFen(fen);
    const moves: string[] = [];
    for (const san of movetext.split(/\s+/).filter((w) => w && !/^(1-0|0-1|1\/2-1\/2|\*)$/.test(w))) {
      const move = sanToMove(pos, san);
      if (move === null) break;
      moves.push(chess.moveToUci(move, false));
      pos = chess.makeLegalMove(pos, move);
    }
    return { white: tag("White") ?? "", black: tag("Black") ?? "", fen, moves };
  });
}

/* The options of a command line. */
function options(argv: readonly string[]) {
  const value = (name: string, fallback: string) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
  };
  const [pgn, player] = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
  if (!pgn || !player) throw new Error("usage: analyze.ts GAMES.pgn PLAYER [--depth 10] [--workers N] [--examples 12] [--book-plies 0] [--horizon]");
  return { pgn, player, depth: Number(value("--depth", "10")),
    workers: Number(value("--workers", String(Math.max(1, availableParallelism() - 2)))),
    examples: Number(value("--examples", "12")), bookPlies: Number(value("--book-plies", "0")),
    horizon: argv.includes("--horizon") };
}

/** One of the engine's blunders: the position before it (and as a "position" command), the
    move, its cause and phase, and the centipawns it lost. */
interface Blunder {
  readonly pos: any;
  readonly position: string;
  readonly played: string;
  readonly best: string;      // Stockfish's move
  readonly cause: string;
  readonly phase: string;
  readonly loss: number;
  readonly netGap: number;    // net band of Stockfish's move minus ours (strength.ts's static check)
}

/* Stockfish's score (centipawns for the side to move) and line of `position` searched to `depth`
   from an empty hash, over every move or only over `move`. */
async function search(engine: Uci, position: string, depth: number, move?: string): Promise<{ cp: number; pv: string[] }> {
  engine.send("ucinewgame");
  engine.send(position);
  engine.send(`go depth ${depth}${move ? ` searchmoves ${move}` : ""}`);
  let cp = 0, pv: string[] = [];
  for (;;) {
    const { value, done } = await engine.out.next();
    if (done) throw new Error("Stockfish exited");
    const line = value.trim();
    const score = / score (cp|mate) (-?\d+)/.exec(line);
    if (score) cp = score[1] === "cp" ? Number(score[2]) : Math.sign(Number(score[2]) || -1) * MATE;
    const at = line.indexOf(" pv ");
    if (at >= 0) pv = line.slice(at + 4).trim().split(/\s+/);
    if (line.startsWith("bestmove")) return { cp, pv };
  }
}

/* The material (pawns, kings left out) of the side to move in `pos`, minus the other side's,
   after the moves of `line` (UCI) are played from `pos`. */
function materialAfter(pos: any, line: readonly string[]): number {
  const us = pos.sideToMove;
  let end = pos;
  for (const uci of line) {
    const move = chess.legalMoves(end).find((m: number) => chess.moveToUci(m, false) === uci);
    if (move === undefined) break;
    end = chess.makeLegalMove(end, move);
  }
  let sum = 0;
  for (let sq = 0; sq < 128; sq++) {
    const piece = end.board[sq];
    if ((sq & 0x88) === 0 && piece !== 0 && (piece & 7) !== 6) sum += (piece >> 3 === us ? 1 : -1) * VALUE[piece & 7];
  }
  return sum;
}

/** How deep Stockfish must look to see a blunder, and what it then sees: mate, lost material
    (its line after our move ends a pawn or more down on its line after the best move), or neither
    (a positional loss). */
interface Horizon {
  readonly depth: number;
  readonly kind: "mate" | "material" | "positional";
  readonly ourLine: readonly string[];    // Stockfish's line after our move, at that depth
}

/* What the opponent's reply in `line` (our move, then theirs, ...) from `pos` is: a capture (and
   whether it checks), a quiet check, a promotion, a quiet move, or none (the line stops at our
   move: Stockfish's evaluation sees the loss). */
function replyKind(pos: any, line: readonly string[]): string {
  const find = (p: any, uci: string | undefined) =>
    uci === undefined ? undefined : chess.legalMoves(p).find((m: number) => chess.moveToUci(m, false) === uci);
  const ours = find(pos, line[0]);
  if (ours === undefined) return "none";
  const after = chess.makeLegalMove(pos, ours);
  const reply = find(after, line[1]);
  if (reply === undefined) return "none";
  const next = chess.makeLegalMove(after, reply);
  const check = chess.inCheck(next);
  const capture = chess.moveType(reply) === chess.FLAG_EP ||
    (chess.moveType(reply) !== chess.FLAG_CASTLE && after.board[chess.toSq(reply)] !== 0);
  if (capture) return check ? "capture with check" : "capture";
  if (chess.promoType(reply) !== 0) return "promotion";
  return check ? "quiet check" : "quiet";
}

/* For each blunder, the lowest depth from 1 to `maxDepth` at which Stockfish sees it (its move
   scores BLUNDER or more below the best move at that depth; maxDepth + 1 if no depth does), and
   what it sees there (at maxDepth if it never does). */
async function horizons(blunders: readonly Blunder[], maxDepth: number, workers: number): Promise<Horizon[]> {
  const found = new Array<Horizon>(blunders.length);
  const spec = engineSpec("stockfish:d1");
  const capped = (cp: number) => Math.max(Math.min(cp, 1000), -1000);
  let next = 0, done = 0;
  const started = Date.now();
  const worker = async () => {
    const engine = await Uci.start(spec);
    for (let i = next++; i < blunders.length; i = next++) {
      const { pos, position, played } = blunders[i];
      for (let depth = 1; depth <= maxDepth; depth++) {
        const best = await search(engine, position, depth);
        const ours = await search(engine, position, depth, played);
        const seen = capped(best.cp) - capped(ours.cp) >= BLUNDER;
        if (!seen && depth < maxDepth) continue;
        const kind = ours.cp <= -MATE ? "mate" : materialAfter(pos, best.pv) - materialAfter(pos, ours.pv) >= 1 ? "material" : "positional";
        found[i] = { depth: seen ? depth : maxDepth + 1, kind, ourLine: ours.pv };
        break;
      }
      if (++done % 500 === 0) console.log(`  horizon: ${done.toLocaleString()}/${blunders.length.toLocaleString()} blunders, ${((Date.now() - started) / 1000).toFixed(0)} s`);
    }
    engine.quit();
  };
  await Promise.all(Array.from({ length: workers }, worker));
  return found;
}

/* Print how deep Stockfish must look to see the blunders and what it sees: the share of them, and
   of the centipawns they lost, by the depth that first sees them, overall and by cause. */
function reportHorizons(blunders: readonly Blunder[], found: readonly Horizon[], maxDepth: number, examples: number): void {
  const bands: [string, (d: number) => boolean][] = [
    ["1", (d) => d === 1], ["2", (d) => d === 2], ["3-4", (d) => d >= 3 && d <= 4],
    ["5-6", (d) => d >= 5 && d <= 6], [`7-${maxDepth}`, (d) => d >= 7 && d <= maxDepth], [`>${maxDepth}`, (d) => d > maxDepth],
  ];
  const lostBy = (keep: (i: number) => boolean) => blunders.reduce((sum, b, i) => sum + (keep(i) ? b.loss : 0), 0);
  const total = lostBy(() => true);
  const pct = (part: number, whole: number) => `${(100 * part / whole).toFixed(0).padStart(2)}%`;
  console.log(`\nfirst depth at which Stockfish sees the blunder (1 = one ply plus captures), and the cp lost by`);
  console.log(`what its line shows: mate / material lost / neither (positional):`);
  for (const [name, inBand] of bands) {
    const count = found.filter((h) => inBand(h.depth)).length;
    const lost = (kind?: string) => lostBy((i) => inBand(found[i].depth) && (kind === undefined || found[i].kind === kind));
    console.log(`  depth ${name.padEnd(5)} ${String(count).padStart(5)} blunders (${pct(count, blunders.length)}), ${pct(lost(), total)} of the cp lost:` +
      ` ${pct(lost("mate"), total)} mate, ${pct(lost("material"), total)} material, ${pct(lost("positional"), total)} positional`);
  }
  const kinds = ["mate", "material", "positional"];
  console.log(`  all          ${kinds.map((k) => `${pct(lostBy((i) => found[i].kind === k), total)} ${k}`).join(", ")}`);
  const material = (i: number) => found[i].kind === "material";
  console.log(`material losses (cp lost): ${pct(lostBy((i) => material(i) && blunders[i].netGap <= 0), total)} where our static` +
    ` net check rates our move no worse than Stockfish's, ${pct(lostBy((i) => material(i) && blunders[i].netGap > 0), total)} where it rates it worse`);
  const blind = blunders.map((_, i) => i).filter((i) => material(i) && blunders[i].netGap <= 0 && found[i].depth === 1);
  for (const i of blind.slice(0, examples)) {
    console.log(`  blind: played ${blunders[i].played} (line ${found[i].ourLine.join(" ")}), Stockfish ${blunders[i].best}, ` +
      `-${blunders[i].loss} cp  ${blunders[i].position}`);
  }
  const replies = new Map<string, number>();
  const shallow = blunders.map((_, i) => i).filter((i) => found[i].depth <= 2);
  for (const i of shallow) {
    const key = `depth ${found[i].depth} ${found[i].kind.padEnd(10)} reply: ${replyKind(blunders[i].pos, found[i].ourLine)}`;
    replies.set(key, (replies.get(key) ?? 0) + blunders[i].loss);
  }
  console.log(`blunders seen by depth 2, by the opponent's reply in Stockfish's line (share of all cp lost):`);
  for (const [key, lost] of [...replies].sort((a, b) => b[1] - a[1])) {
    if (lost >= total * 0.005) console.log(`  ${key.padEnd(48)} ${pct(lost, total)}`);
  }
  console.log(`share of each cause's cp lost, by depth band (${bands.map(([name]) => name).join(" / ")}):`);
  const causes = [...new Set(blunders.map((b) => b.cause))];
  for (const key of [...causes, ...causes.flatMap((c) => ["opening", "middlegame", "endgame"].map((p) => `${c} / ${p}`))]) {
    const ofKey = (i: number) => blunders[i].cause === key || `${blunders[i].cause} / ${blunders[i].phase}` === key;
    const lost = lostBy(ofKey);
    if (lost < total * 0.02) continue;
    const shares = bands.map(([, inBand]) => (100 * lostBy((i) => ofKey(i) && inBand(found[i].depth)) / lost).toFixed(0).padStart(3));
    console.log(`  ${key.padEnd(30)} ${shares.join(" ")}  (${(100 * lost / total).toFixed(0)}% of all)`);
  }
}

/* Stockfish's score (centipawns for the side to move) and move for every position of `games`. */
async function scoreAll(games: Game[], depth: number, workers: number) {
  const jobs = games.flatMap((game, g) => Array.from({ length: game.moves.length + 1 }, (_, ply) => ({ g, ply })));
  const results: { cp: number; best: string }[][] = games.map((game) => new Array(game.moves.length + 1));
  const spec = engineSpec("stockfish:d1");
  let next = 0, done = 0;
  const started = Date.now();
  const worker = async () => {
    const engine = await Uci.start(spec);
    for (let i = next++; i < jobs.length; i = next++) {
      const { g, ply } = jobs[i];
      engine.send(`position fen ${games[g].fen}${ply > 0 ? ` moves ${games[g].moves.slice(0, ply).join(" ")}` : ""}`);
      engine.send(`go depth ${depth}`);
      let cp = 0, best = "0000";
      for (;;) {
        const { value, done: ended } = await engine.out.next();
        if (ended) throw new Error("Stockfish exited");
        const line = value.trim();
        const score = / score (cp|mate) (-?\d+)/.exec(line);
        if (score) cp = score[1] === "cp" ? Number(score[2]) : Math.sign(Number(score[2]) || -1) * MATE;
        if (line.startsWith("bestmove")) { best = line.split(/\s+/)[1]; break; }
      }
      results[g][ply] = { cp, best };
      if (++done % 2000 === 0) console.log(`  ${done.toLocaleString()}/${jobs.length.toLocaleString()} positions, ${((Date.now() - started) / 1000).toFixed(0)} s`);
    }
    engine.quit();
  };
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}

/* Find the blunders, sort them by cause and report. */
async function main(argv: readonly string[]): Promise<void> {
  const opts = options(argv);
  const games = readPgn(readFileSync(opts.pgn, "utf8"));
  console.log(`${games.length} games; Stockfish depth ${opts.depth} scores every position (${opts.workers} engines)`);
  const scores = await scoreAll(games, opts.depth, opts.workers);
  const causes = new Map<string, { count: number; lost: number }>();
  const examples: string[] = [];
  const found: Blunder[] = [];
  let ourMoves = 0, blunders = 0, totalLost = 0;
  for (const [g, game] of games.entries()) {
    const ourColour = game.white === opts.player ? 0 : game.black === opts.player ? 1 : -1;
    if (ourColour < 0) continue;
    let pos = chess.parseFen(game.fen);
    const fields = game.fen.split(" ");
    const counted = (Number(fields[5] ?? 1) - 1) * 2 + (fields[1] === "b" ? 1 : 0);
    const firstPly = counted === 0 && !game.fen.startsWith("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR ") ? opts.bookPlies : counted;
    for (let ply = 0; ply < game.moves.length; ply++) {
      const move = chess.legalMoves(pos).find((m: number) => chess.moveToUci(m, false) === game.moves[ply]);
      if (pos.sideToMove === ourColour) {
        ourMoves++;
        const before = scores[g][ply].cp, after = -scores[g][ply + 1].cp;
        const loss = Math.min(before, 1000) - Math.max(Math.min(after, 1000), -1000);
        if (Math.abs(before) <= DECIDED && loss >= BLUNDER) {
          blunders++;
          totalLost += loss;
          const square = (uci: string | undefined) => (uci ? chess.parseSquare(uci.slice(2, 4)) : -1);
          const sample = { pos, ply: firstPly + ply, lastTo: square(game.moves[ply - 1]), ourLastTo: square(game.moves[ply - 2]), played: "" };
          const { moves, features } = STRENGTH_SET.featurize(sample);
          const mine = moves.findIndex((m) => chess.moveToUci(m, false) === game.moves[ply]);
          const sf = moves.findIndex((m) => chess.moveToUci(m, false) === scores[g][ply].best);
          const net = (i: number) => {
            const band = features[i].find((k) => k >= STRENGTH_SET.count - 10 && k < STRENGTH_SET.count - 5);
            return band === undefined ? 0 : band - (STRENGTH_SET.count - 8);
          };
          const sfMove = sf >= 0 ? moves[sf] : move;
          const sfAfter = chess.makeLegalMove(pos, sfMove);
          const kind = chess.inCheck(sfAfter) ? "check" : (pos.board[chess.toSq(sfMove)] !== 0 && chess.moveType(sfMove) !== chess.FLAG_CASTLE) || chess.moveType(sfMove) === chess.FLAG_EP ? "capture" : "quiet";
          const cause = features[mine].includes(ALLOWS_MATE) ? "allowed mate"
            : features[mine].includes(WORSE_NET_3) ? "saw the loss"
            : sf >= 0 && net(sf) - net(mine) >= 2 ? "missed a win"
            : `deeper: ${kind}`;
          const phase = ["opening", "middlegame", "endgame"][phaseOf(pos, firstPly + ply)];
          const position = `position fen ${game.fen}${ply > 0 ? ` moves ${game.moves.slice(0, ply).join(" ")}` : ""}`;
          found.push({ pos, position, played: game.moves[ply], best: scores[g][ply].best, cause, phase, loss,
            netGap: sf >= 0 ? net(sf) - net(mine) : 0 });
          for (const key of [cause, `${cause} / ${phase}`]) {
            const c = causes.get(key) ?? { count: 0, lost: 0 };
            causes.set(key, { count: c.count + 1, lost: c.lost + loss });
          }
          if (examples.length < opts.examples * 4) {
            examples.push(`${cause.padEnd(16)} ${phase.padEnd(10)} -${loss} cp  played ${game.moves[ply]}, Stockfish ${scores[g][ply].best}  ${position}`);
          }
        }
      }
      if (move === undefined) break;
      pos = chess.makeLegalMove(pos, move);
    }
  }
  console.log(`\n${opts.player}: ${ourMoves.toLocaleString()} moves, ${blunders} blunders (${(100 * blunders / ourMoves).toFixed(1)}%), ` +
    `${totalLost.toLocaleString()} cp lost in them`);
  console.log(`${"cause".padEnd(30)} ${"blunders".padStart(8)} ${"share".padStart(6)} ${"cp lost".padStart(8)}`);
  for (const [key, { count, lost }] of [...causes].sort((a, b) =>
    (a[0].includes("/") ? 1 : 0) - (b[0].includes("/") ? 1 : 0) || b[1].lost - a[1].lost)) {
    console.log(`${key.padEnd(30)} ${String(count).padStart(8)} ${(100 * lost / totalLost).toFixed(0).padStart(5)}% ${lost.toLocaleString().padStart(8)}`);
  }
  console.log("\nexamples:");
  for (const line of examples.filter((_, i) => i % 4 === 0).slice(0, opts.examples)) console.log(line);
  if (opts.horizon) {
    console.log(`\nhorizon: Stockfish searches each blunder at depth 1, 2, ... ${opts.depth}, each from an empty hash`);
    reportHorizons(found, await horizons(found, opts.depth, opts.workers), opts.depth, opts.examples);
  }
}

if (import.meta.main) await main(process.argv.slice(2));
