// UCI proxy that plays a bot's web-app opening book (src/web/books.js) in front of an engine,
// as the app does: from level 2, in standard chess from the initial position. Everything else
// goes to the engine. Configured by environment, since match.js passes an engine one argument:
//   PEDAGOG_APP_BOOK      pedagog | aggressive | constrictor | hedgehog
//   PEDAGOG_BOOK_ENGINE   the engine's source, relative to the repo root (default: engine.ts);
//                         not to the working directory, which cutechess sets itself
//   PEDAGOG_RANDOM_SEED   if "1", a random Skill_Seed for each game (at ucinewgame), as the app
//                         draws one per game; otherwise the engine keeps its deterministic default,
//                         and the book is the only source of variety between games
// Example: PEDAGOG_APP_BOOK=hedgehog PEDAGOG_BOOK_ENGINE=src/variants/engine-hedgehog/engine-hedgehog.ts
//          bun src/tools/match.js L10 sf1550 200 --book none --engine src/tools/book-engine.js
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Chess } from "../web/vendor/chess.mjs/src/Chess.js";
import { bookMove } from "../web/book.js";
import { BOOKS } from "../web/books.js";

const root = resolve(dirname(Bun.main), "..", "..");
const bookId = process.env.PEDAGOG_APP_BOOK;
if (!Object.hasOwn(BOOKS, bookId ?? "")) throw new Error(`PEDAGOG_APP_BOOK must be one of ${Object.keys(BOOKS).join(", ")}`);
const tree = BOOKS[bookId];
const engine = resolve(root, process.env.PEDAGOG_BOOK_ENGINE ?? "engine.ts");
if (!existsSync(engine)) throw new Error(`engine not found: ${engine}`);
const randomSeed = process.env.PEDAGOG_RANDOM_SEED === "1";
const MAX_SEED = 2147483647;

const child = Bun.spawn([process.execPath, engine], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
let quitting = false;
child.exited.then((code) => { if (!quitting) process.exit(code || 1); });
const send = (line) => { child.stdin.write(`${line}\n`); child.stdin.flush(); };
const relay = (async () => {
  for await (const chunk of child.stdout) process.stdout.write(chunk);
})();

/* SANs of a game given as UCI moves from the standard start, or null if one is not legal. */
function sansOf(ucis) {
  const chess = new Chess();
  const sans = ucis.map((u) => chess.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] })?.san ?? null);
  return sans.includes(null) ? null : sans;
}

/* The book's answer as a UCI move, or null out of book. */
function bookAnswer(sans) {
  const san = bookMove(tree, sans, Math.random());
  if (!san) return null;
  const chess = new Chess();
  sans.forEach((s) => chess.move(s));
  const move = chess.move(san);
  return move.from + move.to + (move.promotion ?? "");
}

let level = null;
let chess960 = false;
let played = null;            // SANs since the standard start, or null for any other position
for await (const line of console) {
  const words = line.trim().split(/\s+/);
  const option = /^setoption\s+name\s+(.+?)\s+value\s+(.*)$/i.exec(line.trim());
  if (option?.[1] === "Skill_Level") level = Number(option[2]);
  if (option?.[1] === "UCI_Chess960") chess960 = option[2] === "true";
  if (words[0] === "position") {
    const moves = words.indexOf("moves");
    played = words[1] === "startpos" ? sansOf(moves === -1 ? [] : words.slice(moves + 1)) : null;
  }
  const answer = words[0] === "go" && level > 1 && !chess960 && played ? bookAnswer(played) : null;
  if (words[0] === "quit") quitting = true;
  if (answer) process.stdout.write(`info string book\nbestmove ${answer}\n`);
  else send(line);
  if (randomSeed && words[0] === "ucinewgame") send(`setoption name Skill_Seed value ${1 + Math.floor(Math.random() * MAX_SEED)}`);
  if (quitting) break;
}
quitting = true;
child.stdin.end();
await child.exited;
await relay;
