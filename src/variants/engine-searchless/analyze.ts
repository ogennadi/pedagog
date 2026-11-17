// Where does a searchless engine lose its games? Stockfish scores every position of a match's
// games; each of the engine's moves that loses 150+ centipawns (from a position not already
// decided, |score| <= 600) is a blunder, and is put down to a cause, using the engine's own
// strength features for its move and for Stockfish's move.
//
//   bun src/variants/engine-searchless/analyze.ts data/strength2-vs-maia-1900.pgn searchless-strength2 \
//     [--depth 10] [--workers 26] [--examples 12] [--book-plies 16]
//
// --book-plies: games from an opening book whose FENs say move 1 start at that ply (as in uci.ts).
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
import { chess, phaseOf } from "./features.ts";
import { engineSpec, Uci } from "./score.ts";
import { ALLOWS_MATE, STRENGTH_SET, WORSE_NET_3 } from "./strength.ts";

const BLUNDER = 150, DECIDED = 600, MATE = 10000;

/** One game of the PGN, as positions. */
interface Game {
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
function readPgn(text: string): Game[] {
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
  if (!pgn || !player) throw new Error("usage: analyze.ts GAMES.pgn PLAYER [--depth 10] [--workers N] [--examples 12]");
  return { pgn, player, depth: Number(value("--depth", "10")),
    workers: Number(value("--workers", String(Math.max(1, availableParallelism() - 2)))),
    examples: Number(value("--examples", "12")), bookPlies: Number(value("--book-plies", "0")) };
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
          for (const key of [cause, `${cause} / ${phase}`]) {
            const c = causes.get(key) ?? { count: 0, lost: 0 };
            causes.set(key, { count: c.count + 1, lost: c.lost + loss });
          }
          if (examples.length < opts.examples * 4) {
            examples.push(`${cause.padEnd(16)} ${phase.padEnd(10)} -${loss} cp  played ${game.moves[ply]}, Stockfish ${scores[g][ply].best}  ` +
              `position fen ${game.fen}${ply > 0 ? ` moves ${game.moves.slice(0, ply).join(" ")}` : ""}`);
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
}

if (import.meta.main) await main(process.argv.slice(2));
