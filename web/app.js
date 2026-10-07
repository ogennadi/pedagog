/* Pedagog web app: chessground for the board, cm-chess for the rules, the engine in a Web Worker.
   Human vs bot or bot vs bot, standard chess or Chess960, offline once loaded. */
import { Chessground } from "chessground";
import { Chess, GAME_VARIANT } from "cm-chess/src/Chess.js";
import { BOOK } from "./book.js";

const $ = (id) => document.getElementById(id);
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const FULL_STRENGTH = 10;
const FULL_STRENGTH_MOVETIME = 1000;     // ms per move at level 10; lower levels are depth-bounded and ignore the clock
const LEVEL_ELO = [173, 945, 1072, 1195, 1309, 1417, 1553, 1656, 1789, 1894];   // Lichess-classical scale, see COLOPHON.md
const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9 };

/* ---- Engine: UCI over postMessage. Falls back to running the engine on the main
   thread when the page is opened from file:// in a browser that refuses Workers there. */
class Engine {
  constructor() {
    this.lines = [];
    this.waiters = [];
    this.ready = this.start();
  }
  async start() {
    try {
      // Normal path: the engine in a Worker. Give a cold first load (service worker
      // installing, files still downloading) plenty of time before giving up on it.
      const worker = new Worker("pedagog.js");
      worker.onmessage = (e) => this.onLine(e.data);
      const ok = await new Promise((resolve) => {
        worker.onerror = () => resolve(false);
        this.waitFor((l) => l === "uciok").then(() => resolve(true));
        worker.postMessage("uci");
        setTimeout(() => resolve(false), 15000);
      });
      if (!ok) { worker.terminate(); throw new Error("worker did not answer"); }
      this.worker = worker;
      this.mode = "worker";
    } catch (e) {
      // Fallback (e.g. file:// in a browser that refuses Workers there): run the engine on the
      // main thread. The page will pause while the bot thinks.
      this.worker = null;
      await new Promise((resolve, reject) => {
        const s = document.createElement("script"); s.src = "pedagog.js"; s.onload = resolve; s.onerror = () => reject(new Error("could not load pedagog.js"));
        document.head.appendChild(s);
      });
      globalThis.Pedagog.setOutput((line) => this.onLine(line));
      this.mode = "main thread";
    }
  }
  onLine(line) {
    this.lines.push(line);
    for (const w of this.waiters.splice(0)) w(line);
  }
  waitFor(pred) {
    return new Promise((resolve) => {
      const check = (line) => { if (pred(line)) resolve(line); else this.waiters.push(check); };
      this.waiters.push(check);
    });
  }
  send(cmd) {
    if (this.worker) this.worker.postMessage(cmd);
    else setTimeout(() => globalThis.Pedagog.uci(cmd), 0);   // let the UI paint before blocking
  }
  async bestMove({ startFen, moves, level, chess960 }) {
    await this.ready;
    this.send(`setoption name UCI_Chess960 value ${chess960}`);
    this.send(`setoption name Skill_Level value ${level}`);
    this.send(`position fen ${startFen}${moves.length ? " moves " + moves.join(" ") : ""}`);
    const reply = this.waitFor((l) => l.startsWith("bestmove"));
    this.send(level >= FULL_STRENGTH ? `go movetime ${FULL_STRENGTH_MOVETIME}` : "go depth 100");
    return (await reply).split(/\s+/)[1];
  }
}

/* ---- Chess960 start positions, numbered 0..959 after Scharnagl (518 is the standard array). */
function chess960Fen(n) {
  const row = Array(8).fill(null);
  const nth = (k, piece) => { for (let i = 0; i < 8; i++) if (row[i] === null && k-- === 0) { row[i] = piece; return; } };
  row[2 * (n % 4) + 1] = "b"; n = Math.floor(n / 4);     // light-squared bishop
  row[2 * (n % 4)] = "b"; n = Math.floor(n / 4);         // dark-squared bishop
  nth(n % 6, "q"); n = Math.floor(n / 6);
  const knights = [[0, 1], [0, 2], [0, 3], [0, 4], [1, 2], [1, 3], [1, 4], [2, 3], [2, 4], [3, 4]][n];
  nth(knights[1], "n"); nth(knights[0], "n");            // place the higher index first so the lower one keeps its meaning
  nth(0, "r"); nth(0, "k"); nth(0, "r");
  const black = row.join(""), white = black.toUpperCase();
  return `${black}/pppppppp/8/8/8/8/PPPPPPPP/${white} w KQkq - 0 1`;
}

/* ---- Opening book (standard chess only). A line matches when every move played so far is
   its prefix; "+" and "#" are ignored when comparing. */
const plain = (san) => san.replace(/[+#]/g, "");
const bookLines = BOOK.map((o) => ({ ...o, line: o.moves.split(" ") }));

function matchingLines(played) {
  return bookLines.filter((o) => o.line.length >= played.length && played.every((san, i) => plain(san) === plain(o.line[i])));
}

/* The next book move for the side to move, chosen at random among the lines still in play. */
function bookMove() {
  if (variant !== "standard") return null;
  const played = game.history().map((m) => m.san);
  const open = matchingLines(played).filter((o) => o.line.length > played.length);
  if (open.length === 0) return null;
  const pick = open[Math.floor(Math.random() * open.length)];
  return { san: pick.line[played.length], opening: pick };
}

/* The name of the longest book line the game has followed so far, if any. */
function openingName() {
  if (variant !== "standard") return "";
  const played = game.history().map((m) => m.san);
  let best = null;
  for (const o of bookLines) {
    if (o.line.length <= played.length && o.line.every((san, i) => plain(san) === plain(played[i])) && (!best || o.line.length > best.line.length)) best = o;
  }
  return best ? `${best.name} (${best.eco})` : "";
}

/* Plays every book line through cm-chess and reports the ones with an illegal move. */
function validateBook() {
  const errors = [];
  for (const o of bookLines) {
    const c = new Chess();
    for (const san of o.line) if (!c.move(san)) { errors.push(`${o.name}: ${san} after ${c.history().map((m) => m.san).join(" ")}`); break; }
  }
  return { lines: bookLines.length, offbeat: bookLines.filter((o) => o.offbeat).length, errors };
}

/* ---- Game state */
const engine = new Engine();
let game, cg, startFen = START_FEN, variant = "standard";
let players = { white: "human", black: 5 };      // "human" or a level number
let uciMoves = [];                                // the game so far, in UCI notation, for the engine
let elapsed = { white: 0, black: 0 }, tickFrom = 0, running = false, paused = false, finished = false;
let viewPly = null;                               // null = live position, else a ply to display
let thinking = false, gameId = 0;

const colourToMove = () => (game.turn() === "w" ? "white" : "black");
const isBot = (colour) => players[colour] !== "human";
const playerName = (colour) => isBot(colour) ? `Bot · level ${players[colour]}` : "You";

function legalDests() {
  const dests = new Map();
  for (const m of game.moves({ verbose: true })) {
    if (!dests.has(m.from)) dests.set(m.from, []);
    if (!dests.get(m.from).includes(m.to)) dests.get(m.from).push(m.to);
  }
  return dests;
}

function fenAt(ply) { return ply === null ? game.fen() : game.fenOfPly(ply); }

function refreshBoard() {
  const live = viewPly === null;
  const history = game.history();
  const shown = live ? history[history.length - 1] : (viewPly > 0 ? history[viewPly - 1] : null);
  const humanToMove = live && !finished && !isBot(colourToMove());
  cg.set({
    fen: fenAt(viewPly),
    turnColor: colourToMove(),
    check: live ? game.inCheck() : false,
    lastMove: shown ? [shown.from, shown.to] : undefined,
    movable: { color: humanToMove ? colourToMove() : undefined, dests: humanToMove ? legalDests() : new Map() },
  });
}

/* Captured pieces: whatever each side started with and no longer has (promotions excepted). */
function capturedBy(colour, fen) {
  const count = (f, c) => { const out = {}; for (const ch of f.split(" ")[0]) if (/[pnbrq]/i.test(ch) && (ch === ch.toUpperCase()) === (c === "white")) out[ch.toLowerCase()] = (out[ch.toLowerCase()] || 0) + 1; return out; };
  const victim = colour === "white" ? "black" : "white";
  const before = count(startFen, victim), now = count(fen, victim), taken = [];
  for (const p of ["q", "r", "b", "n", "p"]) for (let i = 0; i < Math.max(0, (before[p] || 0) - (now[p] || 0)); i++) taken.push(p);
  return taken;
}

function refreshBars() {
  const fen = fenAt(viewPly), bottom = cg.state.orientation, top = bottom === "white" ? "black" : "white";
  for (const [where, colour] of [["top", top], ["bottom", bottom]]) {
    $(`name-${where}`).textContent = `${playerName(colour)} (${colour})`;
    const mine = capturedBy(colour, fen), theirs = capturedBy(colour === "white" ? "black" : "white", fen);
    const diff = mine.reduce((s, p) => s + VALUE[p], 0) - theirs.reduce((s, p) => s + VALUE[p], 0);
    const names = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen" };
    $(`captured-${where}`).innerHTML = mine.map((p) => `<piece class="${names[p]} ${colour === "white" ? "black" : "white"}"></piece>`).join("") +
      (diff > 0 ? `<span class="diff">+${diff}</span>` : "");
    $(`bar-${where}`).classList.toggle("active", running && !finished && colourToMove() === colour);
  }
  refreshClocks();
}

function refreshClocks() {
  const fmt = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
  const live = { ...elapsed };
  if (running && !paused && !finished) live[colourToMove()] += performance.now() - tickFrom;
  const bottom = cg.state.orientation, top = bottom === "white" ? "black" : "white";
  // Only touch the DOM when the text changes: a write per tick would force layout during drags.
  const setText = (el, text) => { if (el.textContent !== text) el.textContent = text; };
  setText($("clock-top"), fmt(live[top]));
  setText($("clock-bottom"), fmt(live[bottom]));
}

function refreshMoves() {
  const history = game.history(), ol = $("moves");
  ol.innerHTML = "";
  for (let i = 0; i < history.length; i += 2) {
    const li = document.createElement("li");
    const num = document.createElement("span"); num.className = "num"; num.textContent = `${i / 2 + 1}.`;
    li.appendChild(num);
    for (const j of [i, i + 1]) {
      const span = document.createElement("span");
      span.className = "san" + ((viewPly === null ? history.length : viewPly) === j + 1 ? " current" : "");
      if (history[j]) { span.textContent = history[j].san; span.onclick = () => { viewPly = j + 1 === history.length ? null : j + 1; refreshAll(); }; }
      li.appendChild(span);
    }
    ol.appendChild(li);
  }
  $("result").textContent = finished ? resultText() : "";
  if (viewPly === null) ol.parentElement.scrollTop = ol.parentElement.scrollHeight;
  $("opening").textContent = openingName();
  refreshLinks();
}

function resultText() {
  if (game.inCheckmate()) return `Checkmate — ${colourToMove() === "white" ? "Black" : "White"} wins`;
  if (game.inStalemate()) return "Draw by stalemate";
  if (game.insufficientMaterial()) return "Draw — insufficient material";
  if (game.inThreefoldRepetition()) return "Draw by threefold repetition";
  return "Draw by the fifty-move rule";
}

function pgn() {
  const tags = game.header();
  tags.Event = "Pedagog"; tags.Site = "offline"; tags.Date = new Date().toISOString().slice(0, 10).replace(/-/g, ".");
  tags.White = playerName("white"); tags.Black = playerName("black");
  tags.Result = finished ? (game.inCheckmate() ? (colourToMove() === "white" ? "0-1" : "1-0") : "1/2-1/2") : "*";
  if (variant === "chess960") tags.Variant = "Chess960"; else delete tags.Variant;
  return game.renderPgn();
}

function refreshLinks() {
  const text = pgn();
  const a = $("lichess");
  a.href = "https://lichess.org/analysis/pgn/" + encodeURIComponent(text);
  a.setAttribute("aria-disabled", game.history().length === 0 ? "true" : "false");
  $("copy-pgn").onclick = () => navigator.clipboard?.writeText(pgn());
}

function refreshAll() { refreshBoard(); refreshBars(); refreshMoves(); }

function setStatus(text, busy = false) { $("status").textContent = text; $("status").classList.toggle("thinking", busy); }

/* ---- Playing moves */
function playMove(move) {
  const result = game.move(move);
  if (!result) return false;
  uciMoves.push(result.from + result.to + (result.promotion || ""));
  elapsed[result.color === "w" ? "white" : "black"] += performance.now() - tickFrom;
  tickFrom = performance.now();
  if (game.gameOver()) { finished = true; running = false; $("pause").classList.add("hidden"); }
  refreshAll();
  if (finished) setStatus(resultText());
  else scheduleBot();
  return true;
}

async function scheduleBot() {
  const colour = colourToMove();
  if (finished || paused || thinking || !isBot(colour)) { if (!finished && !thinking) setStatus(isBot(colour) ? "paused" : "your move"); return; }
  thinking = true;
  const id = gameId;
  const level = players[colour];
  const book = level > 1 ? bookMove() : null;
  if (book) {
    setStatus(`level ${level} plays from the book: ${book.opening.name}`);
    await new Promise((r) => setTimeout(r, 400));          // a beat, so book moves do not flash by
    if (id !== gameId) return;
    thinking = false;
    if (!playMove(book.san)) { console.error("book move rejected", book); setStatus("book move rejected: " + book.san); }
    return;
  }
  setStatus(`level ${level} is thinking`, true);
  try {
    const uci = await engine.bestMove({ startFen, moves: uciMoves, level, chess960: variant === "chess960" });
    if (id !== gameId) return;                           // a new game was started meanwhile
    thinking = false;
    const move = { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.length > 4 ? uci[4] : undefined };
    if (!playMove(move)) { console.error("engine move rejected", uci); setStatus("engine move rejected: " + uci); }
  } catch (e) { thinking = false; setStatus("engine error: " + e.message); }
}

/* Human move from the board. Promotions ask which piece. */
function onUserMove(from, to) {
  const candidates = game.moves({ square: from, verbose: true }).filter((m) => m.to === to);
  if (candidates.length === 0) { refreshBoard(); return; }
  if (candidates.some((m) => m.promotion)) {
    const colour = colourToMove();
    const box = $("promotion");
    for (const b of box.querySelectorAll("button")) {
      b.querySelector("piece").className = `${{ q: "queen", r: "rook", b: "bishop", n: "knight" }[b.dataset.piece]} ${colour}`;
      b.onclick = () => { box.classList.add("hidden"); playMove({ from, to, promotion: b.dataset.piece }); };
    }
    box.classList.remove("hidden");
    return;
  }
  playMove({ from, to });
}

/* ---- New game */
function newGame() {
  gameId++; thinking = false;
  variant = $("variant").value;
  startFen = variant === "chess960" ? chess960Fen(parseInt($("position").value) || 0) : START_FEN;
  game = new Chess({ fen: startFen, gameVariant: variant === "chess960" ? GAME_VARIANT.chess960 : GAME_VARIANT.standard });
  uciMoves = []; elapsed = { white: 0, black: 0 }; tickFrom = performance.now();
  finished = false; paused = false; viewPly = null; running = true;
  const mode = $("mode").value, level = parseInt($("level").value), level2 = parseInt($("level2").value);
  if (mode === "bvb") players = { white: level, black: level2 };
  else {
    let human = $("colour").value;
    if (human === "random") human = Math.random() < 0.5 ? "white" : "black";
    players = human === "white" ? { white: "human", black: level } : { white: level, black: "human" };
    cg.set({ orientation: human });
  }
  $("pause").classList.toggle("hidden", mode !== "bvb");
  $("pause").textContent = "Pause";
  $("start-fen").classList.toggle("hidden", variant !== "chess960");
  $("start-fen").textContent = variant === "chess960" ? `Position ${$("position").value}: ${startFen}` : "";
  refreshAll();
  scheduleBot();
}

/* ---- Wiring */
cg = Chessground($("board"), {
  fen: START_FEN, orientation: "white", coordinates: true,
  animation: { duration: 200 }, highlight: { lastMove: true, check: true },
  // `movable.events.after` is chessground's hook for a completed user move (the board state is
  // already updated when it fires). Chessground defers both hooks with setTimeout, so refreshing
  // the board from here never fights the drop itself.
  movable: { free: false, color: undefined, dests: new Map(), showDests: true, events: { after: onUserMove } },
  draggable: { showGhost: true }, premovable: { enabled: false },
});
game = new Chess({ fen: START_FEN });

$("mode").onchange = () => {
  const bvb = $("mode").value === "bvb";
  $("colour-row").classList.toggle("hidden", bvb);
  $("level2-row").classList.toggle("hidden", !bvb);
  $("level-row").firstChild.textContent = bvb ? "White bot level " : "Bot level ";
};
$("variant").onchange = () => $("position-row").classList.toggle("hidden", $("variant").value !== "chess960");
$("random-position").onclick = () => { $("position").value = Math.floor(Math.random() * 960); };
for (const id of ["level", "level2"]) { $(id).oninput = () => { const v = parseInt($(id).value); $(`${id}-out`).textContent = `${v} (≈${LEVEL_ELO[v - 1]})`; }; $(id).oninput(); }
$("new-game").onclick = newGame;
$("flip").onclick = () => { cg.toggleOrientation(); refreshBars(); };
$("pause").onclick = () => { paused = !paused; $("pause").textContent = paused ? "Resume" : "Pause"; if (!paused) { tickFrom = performance.now(); scheduleBot(); } else refreshBars(); };
setInterval(refreshClocks, 250);

refreshAll();
engine.ready.then(() => setStatus(`engine ready (${engine.mode}) — press New game`)).catch((e) => setStatus("engine failed to load: " + e.message));
globalThis.pedagogApp = { cg, get game() { return game; }, userMove: onUserMove, pgn, newGame, validateBook, book: bookLines };   // for the console and tests

if ("serviceWorker" in navigator && location.protocol.startsWith("http")) navigator.serviceWorker.register("sw.js").catch(() => {});
