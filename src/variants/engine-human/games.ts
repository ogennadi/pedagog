// Extract one rating bin's games from a Lichess database file, as Maia's training data was cut
// (McIlroy-Young et al., KDD 2020, section 7.1), in testset.ts's format.
//
//   bun src/variants/engine-human/games.ts data/raw/lichess_db_standard_rated_2019-10.pgn.zst \
//     data/train-1900-2019-10.jsonl [--bin 1900] [--max-games N]
//
// Keeps rated standard games whose players are both in the bin (bin to bin + 99), except Bullet
// and UltraBullet (the paper's HyperBullet), with a result and at least 11 plies. Moves are
// scored from ply 10 on, until either player's clock first shows under 30 seconds. Moves are
// converted from SAN with the engine's own move generator. --max-games stops after reading that
// many games of any kind, to measure speed on a slice. Prints progress every 10 seconds.

import { appendFileSync, createReadStream, writeFileSync } from "node:fs";
import { createZstdDecompress } from "node:zlib";
import { resolve } from "node:path";
import { engine } from "../../tests/engine.js";
import type { TestGame } from "./testset.ts";

const FIRST_PLY = 10;
const MIN_CLOCK = 30;
const SLOW = new Set(["Blitz", "Rapid", "Classical", "Correspondence"]);
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const e = engine();
const chess = e.read(`({ parseFen, legalMoves, makeLegalMove, fromSq, toSq, promoType, moveType,
  typeOf, fileOf, rankOf, squareName, moveToUci, FLAG_CASTLE, PIECE_CHARS })`);

/* The legal move of `pos` written as `san`, or null. */
export function sanToMove(pos: any, san: string): number | null {
  const text = san.replace(/[+#!?]+$/, "");
  const moves: number[] = chess.legalMoves(pos);
  if (text === "O-O" || text === "O-O-O") {
    const kingside = text === "O-O";
    return moves.find((m) => chess.moveType(m) === chess.FLAG_CASTLE &&
      (chess.toSq(m) > chess.fromSq(m)) === kingside) ?? null;
  }
  const m = /^([KQRBN])?([a-h])?([1-8])?x?([a-h][1-8])(?:=?([QRBN]))?$/.exec(text);
  if (!m) return null;
  const [, piece, file, rank, to, promo] = m;
  const type = " PNBRQK".indexOf(piece ?? "P");
  const promoType = promo ? " PNBRQK".indexOf(promo) : 0;
  const found = moves.filter((move) => chess.moveType(move) !== chess.FLAG_CASTLE &&
    chess.squareName(chess.toSq(move)) === to &&
    chess.typeOf(pos.board[chess.fromSq(move)]) === type &&
    chess.promoType(move) === promoType &&
    (!file || "abcdefgh"[chess.fileOf(chess.fromSq(move))] === file) &&
    (!rank || "12345678"[chess.rankOf(chess.fromSq(move))] === rank));
  return found.length === 1 ? found[0] : null;
}

/* Seconds in a %clk value such as 0:02:57. */
function seconds(clock: string): number {
  const [h, m, s] = clock.split(":").map(Number);
  return 3600 * h + 60 * m + s;
}

/* The game written as `movetext` (SAN with %clk comments), from the starting position: its UCI
   moves and the plies scored, or null if a move cannot be read. */
export function readGame(movetext: string): { moves: string[]; scored: number[] } | null {
  let pos = chess.parseFen(START_FEN);
  const moves: string[] = [];
  const scored: number[] = [];
  let lowClock = false;
  for (const token of movetext.matchAll(/\{([^}]*)\}|(\d+\.(?:\.\.)?)|([^\s{}]+)/g)) {
    const [, comment, number, word] = token;
    if (comment !== undefined) {
      const clock = /\[%clk (\d+:\d+:\d+)\]/.exec(comment);
      if (clock && seconds(clock[1]) < MIN_CLOCK) lowClock = true;
      continue;
    }
    if (number !== undefined || word === undefined || /^(1-0|0-1|1\/2-1\/2|\*)$/.test(word)) continue;
    const move = sanToMove(pos, word);
    if (move === null) return null;
    if (moves.length >= FIRST_PLY && !lowClock) scored.push(moves.length);
    moves.push(chess.moveToUci(move, false));
    pos = chess.makeLegalMove(pos, move);
  }
  return { moves, scored };
}

/* Should a game with these headers be kept for `bin`? */
export function wanted(headers: Record<string, string>, bin: number): boolean {
  const speed = /^Rated (\w+) /.exec(headers.Event ?? "")?.[1];
  const inBin = (elo: string | undefined) => Math.floor(Number(elo) / 100) * 100 === bin;
  return speed !== undefined && SLOW.has(speed) && inBin(headers.WhiteElo) && inBin(headers.BlackElo) &&
    ["1-0", "0-1", "1/2-1/2"].includes(headers.Result ?? "") && headers.Termination !== "Abandoned";
}

/* Read `input`, write the bin's games to `output`, report as it goes. */
async function main(argv: readonly string[]): Promise<void> {
  const value = (name: string, fallback: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : fallback;
  };
  const [input, output] = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
  if (!input || !output) throw new Error("usage: games.ts INPUT.pgn.zst OUTPUT.jsonl [--bin 1900] [--max-games N]");
  const bin = Number(value("--bin", "1900"));
  const maxGames = Number(value("--max-games", "0"));
  const stream = createReadStream(resolve(input)).pipe(createZstdDecompress());
  const out = resolve(output);
  writeFileSync(out, "");
  let pending: string[] = [];
  let keptCount = 0;
  let headers: Record<string, string> = {};
  let read = 0, positions = 0, unreadable = 0, bytes = 0, partial = "";
  const started = Date.now();
  let lastReport = started;

  /* Append the games found since the last flush to the output file. */
  const flush = () => {
    if (pending.length > 0) appendFileSync(out, pending.join(""));
    pending = [];
  };

  /* Print how far the file has been read. */
  const report = () => {
    const s = (Date.now() - started) / 1000;
    console.log(`${(bytes / 1e9).toFixed(1)} GB read, ${read.toLocaleString()} games, ${keptCount.toLocaleString()} kept ` +
      `(${positions.toLocaleString()} scored moves), ${unreadable} unreadable, ${(bytes / 1e6 / s).toFixed(0)} MB/s, ${s.toFixed(0)} s`);
  };

  /* Handle one line of PGN. */
  const line = (text: string) => {
    if (text.startsWith("[")) {
      const m = /^\[(\w+) "(.*)"\]$/.exec(text);
      if (m) headers[m[1]] = m[2];
      return;
    }
    if (text === "" || Object.keys(headers).length === 0) return;
    read++;
    if (wanted(headers, bin)) {
      const game = readGame(text);
      if (game === null) unreadable++;
      else if (game.moves.length > FIRST_PLY) {
        const record: TestGame = { id: (headers.Site ?? "").split("/").pop() ?? "", fen: START_FEN,
          moves: game.moves, scored: game.scored, elo: [Number(headers.WhiteElo), Number(headers.BlackElo)] };
        pending.push(JSON.stringify(record) + "\n");
        keptCount++;
        positions += game.scored.length;
      }
    }
    headers = {};
  };

  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    bytes += chunk.length;
    const parts = (partial + decoder.decode(chunk, { stream: true })).split("\n");
    partial = parts.pop() ?? "";
    for (const text of parts) line(text.replace(/\r$/, ""));
    if (pending.length >= 1000) flush();
    if (Date.now() - lastReport > 10000) {
      lastReport = Date.now();
      report();
    }
    if (maxGames > 0 && read >= maxGames) {
      stream.destroy();
      break;
    }
  }
  flush();
  report();
  console.log(`wrote ${keptCount.toLocaleString()} games to ${output}`);
}

if (import.meta.main) await main(process.argv.slice(2));
