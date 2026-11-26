/* Pedagog game page (index.html): a setup screen (who plays each
   side, which engine and level, standard chess or a Chess960 position, previewed on the board),
   then the game with player bars, clocks, move list and a win animation when a human wins.
   chessground draws the board, cm-chess keeps the rules, each engine runs in its own Web Worker. */
import { Chessground } from "chessground";
import { Chess, GAME_VARIANT } from "cm-chess/src/Chess.js";
import { OPENINGS, bookMove, plain } from "./book.js";
import { BOOKS } from "./books.js";
import {
  BOARD_THEMES, PREFS_KEY, loadPrefs, savePrefs, pieceCss, boardCss, applyCss, applyTheme,
} from "./prefs.js";
import { chess960Fen, chess960Rank, START_FEN, STANDARD_POSITION } from "./chess960.js";
import { playWin } from "./win-animations.js";

const $ = (id) => document.getElementById(id);
const STORAGE_KEY = "pedagog-play-v2";
const LEVEL_ELO = [173, 945, 1046, 1148, 1249, 1350, 1451, 1553, 1654, 1755];   // Lichess-classical scale, see docs/COLOPHON.md
const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9 };
const PIECE_NAMES = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen" };
const COLOURS = ["white", "black"];
const SEATS = ["top", "bottom"];
const SIDES = ["white", "random", "black"];
const MAX_SEED = 2147483647;
const THINKING_DELAY_MS = 400;   // a bot taking longer than this shows that it is thinking
const MIN_BOT_MS = 250;          // and never answers faster than this, so its move can be seen
const BOOK_MS = 350;
const CELEBRATE_DELAY_MS = 400;  // after the mating move has landed
const DENSE_CAPTURES = 10;       // more captured pieces than this overlap further, to fit a phone
// The win animations (win-animations.js) a human's win over another human picks from at random.
const WIN_ANIMATIONS = ["coronation", "explode", "replay", "tipped", "conga"];

// The bots: engine.ts and its single-file style variants (src/tools/engine-js.js serves and builds
// them). `book` names the bot's opening book in books.js, used in standard chess from level 2;
// a bot without one opens on its own. Only Pedagog's levels are calibrated as ratings. `win` is
// the animation for beating that bot.
const ENGINES = {
  pedagog: {
    name: "Pedagog", url: "engine.js", book: "pedagog", elo: true, win: "coronation",
    blurb: "The plain engine: sound, unhurried, a little materialistic.",
  },
  aggressive: {
    name: "Aggressive", url: "engines/aggressive.js", book: "aggressive", win: "explode",
    blurb: "Goes for checks, sacrifices and the enemy king.",
  },
  constrictor: {
    name: "Constrictor", url: "engines/constrictor.js", book: "constrictor", win: "conga",
    blurb: "Takes space, storms with its pawns and leaves your pieces no squares.",
  },
  hedgehog: {
    name: "Hedgehog", url: "engines/hedgehog.js", book: "hedgehog", win: "tipped",
    blurb: "Curls up behind a Hippo shell of pawns, then breaks out.",
  },
  habits: {
    name: "Habits", url: "engines/habits.js", book: null, win: "explode",
    blurb: "Plays like GM Aman Hambleton's Building Habits speedrun: a small repertoire and fixed habits. Tuned at level 10.",
  },
};

const other = (colour) => (colour === "white" ? "black" : "white");
const capitalised = (s) => s[0].toUpperCase() + s.slice(1);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const newSeed = () => 1 + Math.floor(Math.random() * MAX_SEED);
const today = () => new Date().toISOString().slice(0, 10).replace(/-/g, ".");
const integer = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;

/* ---- Engines: one Worker per engine, made when first needed, speaking UCI over postMessage.
   A search cannot be interrupted by a message (it is synchronous), so cancel() ends the worker
   and the next request starts a fresh one. */
class Cancelled extends Error {}

class EngineWorker {
  constructor(url) {
    this.url = url;
    this.worker = null;
    this.pending = null;
  }
  start() {
    const worker = new Worker(this.url);
    this.worker = worker;
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the engine did not start")), 20000);
      this.rejectReady = (e) => { clearTimeout(timer); reject(e); };
      worker.onmessage = (e) => {
        if (e.data === "uciok") { clearTimeout(timer); resolve(); }
        else if (typeof e.data === "string" && e.data.startsWith("bestmove") && this.pending) {
          const { resolve: answer } = this.pending;
          this.pending = null;
          answer(e.data.split(/\s+/)[1]);
        }
      };
      worker.onerror = (e) => {
        e.preventDefault();
        const error = new Error(e.message || `could not run ${this.url}`);
        this.rejectReady(error);
        this.pending?.reject(error);
        this.pending = null;
        this.stop();
      };
      worker.postMessage("uci");
    });
    this.ready.catch(() => {});
  }
  async bestMove({ startFen, moves, level, chess960, seed }) {
    if (!this.worker) this.start();
    const worker = this.worker;
    this.busy = true;
    try {
      await this.ready;
      if (worker !== this.worker) throw new Cancelled();
      return await new Promise((resolve, reject) => {
        this.pending = { resolve, reject };
        worker.postMessage(`setoption name UCI_Chess960 value ${chess960}`);
        worker.postMessage(`setoption name Skill_Level value ${level}`);
        worker.postMessage(`setoption name Skill_Seed value ${seed}`);
        worker.postMessage(`position fen ${startFen}${moves.length ? " moves " + moves.join(" ") : ""}`);
        worker.postMessage("go depth 100");   // every level is depth-bounded and ignores the clock
      });
    } finally {
      if (worker === this.worker) this.busy = false;
    }
  }
  /* Abandon whatever this engine is doing. */
  stop() {
    if (!this.worker) return;
    this.worker.terminate();
    this.worker = null;
    this.busy = false;
    this.rejectReady?.(new Cancelled());
    this.pending?.reject(new Cancelled());
    this.pending = null;
  }
}

const workers = new Map();
function engineWorker(id) {
  if (!workers.has(id)) workers.set(id, new EngineWorker(ENGINES[id].url));
  return workers.get(id);
}
const stopEngines = () => workers.forEach((w) => { if (w.busy) w.stop(); });

/* ---- Opening books (standard chess only) and opening names. */
const namedLines = OPENINGS.map((o) => ({ ...o, line: o.moves.split(" ") }));

function openingName(sans) {
  const best = namedLines
    .filter((o) => o.line.length <= sans.length && o.line.every((san, i) => plain(san) === plain(sans[i])))
    .reduce((a, o) => (!a || o.line.length > a.line.length ? o : a), null);
  return best ? `${best.name} (${best.eco})` : "";
}

/* ---- Sound: short synthesised knocks, so there are no audio files to load. Browsers only let a
   page make sound after the user has touched it, so the first tap or key unlocks it. */
let audio = null;
let noise = null;

function audioContext() {
  if (!audio) {
    const AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!AudioContextClass) return null;
    audio = new AudioContextClass();
    const length = Math.floor(audio.sampleRate * 0.12);
    noise = audio.createBuffer(1, length, audio.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length);
  }
  if (audio.state === "suspended") audio.resume().catch(() => {});
  return audio;
}

function tone(ctx, { at, freq, to = freq, length, volume, type = "sine" }) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, at);
  osc.frequency.exponentialRampToValueAtTime(to, at + length);
  gain.gain.setValueAtTime(volume, at);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
  osc.connect(gain).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + length + 0.02);
}

/* A burst of the noise through a band-pass filter: wood striking wood. */
function knock(ctx, { at, centre, q = 1.4, length, volume }) {
  const source = ctx.createBufferSource();
  source.buffer = noise;
  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = centre;
  band.Q.value = q;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(volume, at);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
  source.connect(band).connect(gain).connect(ctx.destination);
  source.start(at);
}

/* kind: "move", "capture", "check", "win" or "end"; a move that captures and checks is
   "capture" with check true. A move is one soft knock. A capture is two hits: a bright clack,
   the taking piece striking the taken one, then a deeper thud as it lands. */
function playSound(kind, check = kind === "check") {
  if (!prefs.sound) return;
  const ctx = audioContext();
  if (!ctx || ctx.state !== "running") return;
  const t = ctx.currentTime + 0.005;
  if (kind === "capture") {
    knock(ctx, { at: t, centre: 3200, q: 2.5, length: 0.04, volume: 2.2 });
    tone(ctx, { at: t, freq: 1300, to: 950, length: 0.05, volume: 0.15, type: "triangle" });
    knock(ctx, { at: t + 0.06, centre: 900, length: 0.11, volume: 0.9 });
    tone(ctx, { at: t + 0.06, freq: 140, to: 60, length: 0.13, volume: 0.5 });
  } else {
    knock(ctx, { at: t, centre: 1800, length: 0.07, volume: 0.6 });
    tone(ctx, { at: t, freq: 210, to: 70, length: 0.08, volume: 0.3 });
  }
  if (check) tone(ctx, { at: t + (kind === "capture" ? 0.12 : 0.06), freq: 880, length: 0.25, volume: 0.08, type: "triangle" });
  const chime = { win: [523, 659, 784, 1047], end: [440, 392] }[kind];
  chime?.forEach((freq, i) => tone(ctx, { at: t + 0.15 + i * 0.13, freq, length: 0.45, volume: 0.12, type: "triangle" }));
}

/* ---- State. `setup` is the setup screen's choices; `match` the game being played (or the one
   just finished), null on the setup screen. The setup's players are by seat: the bottom one plays
   `side` (or a random one) from the near side of the board, the top one the other colour. */
const DEFAULT_SETUP = Object.freeze({
  bottom: { type: "human", engine: "pedagog", level: 5 },
  top: { type: "bot", engine: "pedagog", level: 5 },
  side: "white", variant: "standard", position: STANDARD_POSITION,
});

let prefs = loadPrefs();
let setup = DEFAULT_SETUP;
let match = null;
let game = new Chess({ fen: START_FEN });
let cg;
let gameId = 0;
let thinking = false;
let tickFrom = performance.now();
let celebration = null;

const colourToMove = () => (game.turn() === "w" ? "white" : "black");
const sans = () => game.history().map((m) => m.san);
const isBot = (colour) => match.players[colour].type === "bot";
const humans = (players) => COLOURS.filter((c) => players[c].type === "human");
const finished = () => match !== null && match.outcome !== null;
const inProgress = () => match !== null && match.outcome === null;

function outcomeOf(g) {
  if (g.inCheckmate()) return { winner: g.turn() === "w" ? "black" : "white", reason: "checkmate" };
  if (g.inStalemate()) return { winner: null, reason: "stalemate" };
  if (g.insufficientMaterial()) return { winner: null, reason: "insufficient material" };
  if (g.inThreefoldRepetition()) return { winner: null, reason: "threefold repetition" };
  if (g.gameOver()) return { winner: null, reason: "the fifty-move rule" };
  return null;
}

const avatarOf = (p) => (p.type === "human" ? prefs.avatar || "avatars/human.svg" : `avatars/${p.engine}.svg`);

function playerInfo(colour, players) {
  const p = players[colour];
  if (p.type === "human") return { name: prefs.name, sub: capitalised(colour), avatar: avatarOf(p) };
  const engine = ENGINES[p.engine];
  const elo = engine.elo ? ` · ≈${LEVEL_ELO[p.level - 1]}` : "";
  return { name: engine.name, sub: `Level ${p.level}${elo}`, avatar: avatarOf(p) };
}

function pgnName(colour) {
  const p = match.players[colour];
  return p.type === "human" ? prefs.name : `Pedagog ${ENGINES[p.engine].name} · level ${p.level}`;
}

/* ---- Board */
function legalDests() {
  const dests = new Map();
  for (const m of game.moves({ verbose: true })) dests.set(m.from, [...(dests.get(m.from) ?? []), m.to]);
  return dests;
}

const fenAt = (ply) => (ply === null ? game.fen() : game.fenOfPly(ply));

// The board faces the game's near side, or the setup's while choosing; nothing else turns it.
function refreshBoard() {
  if (!match) {
    cg.set({
      orientation: setupOrientation(setup),
      fen: previewFen(), lastMove: undefined, check: false, turnColor: "white",
      movable: { color: undefined, dests: new Map() },
    });
    return;
  }
  const live = match.viewPly === null;
  const history = game.history();
  const shown = live ? history[history.length - 1] : (match.viewPly > 0 ? history[match.viewPly - 1] : null);
  const humanToMove = live && inProgress() && !match.paused && !isBot(colourToMove());
  cg.set({
    orientation: match.orientation,
    fen: fenAt(match.viewPly),
    turnColor: colourToMove(),
    check: live ? game.inCheck() : false,
    lastMove: shown ? [shown.from, shown.to] : undefined,
    movable: { color: humanToMove ? colourToMove() : undefined, dests: humanToMove ? legalDests() : new Map() },
  });
}

/* Captured pieces: what each side started with and no longer has (promotions excepted), as
   [piece, count] for the pieces `colour` has taken, most valuable first. */
function captures(colour, fen, startFen) {
  const victim = other(colour);
  const count = (f) => [...f.split(" ")[0]]
    .filter((ch) => /[pnbrq]/i.test(ch) && (ch === ch.toUpperCase()) === (victim === "white"))
    .reduce((n, ch) => ({ ...n, [ch.toLowerCase()]: (n[ch.toLowerCase()] ?? 0) + 1 }), {});
  const before = count(startFen), now = count(fen);
  return ["q", "r", "b", "n", "p"]
    .map((p) => [p, Math.max(0, (before[p] ?? 0) - (now[p] ?? 0))])
    .filter(([, n]) => n > 0);
}

const material = (groups) => groups.reduce((sum, [p, n]) => sum + VALUE[p] * n, 0);

function formatClock(ms) {
  const s = Math.floor(ms / 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}

function liveElapsed() {
  if (!match) return { white: 0, black: 0 };
  const running = inProgress() && !match.paused;
  const extra = running ? performance.now() - tickFrom : 0;
  return { ...match.elapsed, [colourToMove()]: match.elapsed[colourToMove()] + extra };
}

function barHtml() {
  return `<img class="avatar" alt="">
    <div class="who"><div class="name-line"><span class="name"></span><span class="sub"></span><span class="dots"></span></div>
    <div class="captured cg-wrap"></div></div>
    <span class="clock">00:00:00</span>`;
}

function refreshBars() {
  if (!match) return;
  const fen = fenAt(match.viewPly);
  const bottom = match.orientation;
  for (const [where, colour] of [["top", other(bottom)], ["bottom", bottom]]) {
    const bar = $(`bar-${where}`);
    const info = playerInfo(colour, match.players);
    const avatar = bar.querySelector(".avatar");
    if (avatar.getAttribute("src") !== info.avatar) avatar.src = info.avatar;
    bar.querySelector(".name").textContent = info.name;
    bar.querySelector(".sub").textContent = info.sub;
    bar.dataset.colour = colour;
    const mine = captures(colour, fen, match.startFen);
    const diff = material(mine) - material(captures(other(colour), fen, match.startFen));
    const pieces = mine.flatMap(([p, n]) => Array(n).fill(p));
    const list = bar.querySelector(".captured");
    list.classList.toggle("dense", pieces.length > DENSE_CAPTURES);
    list.innerHTML = pieces.map((p) => `<piece class="${PIECE_NAMES[p]} ${other(colour)}"></piece>`).join("") +
      (diff > 0 ? `<span class="diff" title="Material lead">+${diff}</span>` : "");
    bar.classList.toggle("active", inProgress() && colourToMove() === colour);
    bar.classList.toggle("winner", finished() && match.outcome.winner === colour);
  }
  refreshClocks();
}

function refreshClocks() {
  if (!match) return;
  const times = liveElapsed();
  for (const where of ["top", "bottom"]) {
    const bar = $(`bar-${where}`);
    const clock = bar.querySelector(".clock");
    const text = formatClock(times[bar.dataset.colour]);
    // Only touch the DOM when the text changes: a write per tick would force layout during drags.
    if (clock.textContent !== text) clock.textContent = text;
  }
}

function setThinking(colour, on) {
  for (const bar of [$("bar-top"), $("bar-bottom")])
    bar.classList.toggle("thinking", on && bar.dataset.colour === colour);
  if (on) setStatus(`${playerInfo(colour, match.players).name} is thinking…`);
}

/* ---- Move list and panel */
function refreshMoves() {
  if (!match) return;
  const history = sans(), ol = $("moves");
  const current = match.viewPly === null ? history.length : match.viewPly;
  ol.replaceChildren(...Array.from({ length: Math.ceil(history.length / 2) }, (_, row) => {
    const li = document.createElement("li");
    const num = document.createElement("span");
    num.className = "num";
    num.textContent = `${row + 1}.`;
    const cells = [2 * row, 2 * row + 1].map((j) => {
      const span = document.createElement("span");
      span.className = "san" + (current === j + 1 ? " current" : "");
      if (history[j]) { span.textContent = history[j]; span.onclick = () => viewAt(j + 1); }
      return span;
    });
    li.append(num, ...cells);
    return li;
  }));
  if (match.viewPly === null) ol.parentElement.scrollTop = ol.parentElement.scrollHeight;
  else ol.querySelector(".current")?.scrollIntoView({ block: "nearest" });
  $("opening").textContent = match.variant === "standard" ? openingName(history) : `Chess960 · position ${match.position}`;
  $("nav-first").disabled = $("nav-prev").disabled = current === 0;
  $("nav-next").disabled = $("nav-last").disabled = match.viewPly === null;
  refreshLinks();
}

function resultText() {
  const { winner, reason } = match.outcome;
  if (!winner) return `Draw by ${reason}`;
  const name = (c) => (humans(match.players).length === 2 ? capitalised(c) : playerInfo(c, match.players).name);
  const verb = humans(match.players).length === 2 || match.players[winner].type === "bot" ? "wins" : "win";
  const who = match.players[winner].type === "human" && humans(match.players).length === 1 ? "You" : name(winner);
  return `Checkmate — ${who} ${verb}`;
}

function pgnResult() {
  if (!finished()) return "*";
  return { white: "1-0", black: "0-1" }[match.outcome.winner] ?? "1/2-1/2";
}

function pgn() {
  const tags = game.header();
  tags.Event = "Pedagog"; tags.Site = "offline"; tags.Date = match.date;
  tags.White = pgnName("white"); tags.Black = pgnName("black");
  tags.Result = pgnResult();
  if (match.variant === "chess960") tags.Variant = "Chess960"; else delete tags.Variant;
  tags.SkillSeed = String(match.seed);
  return game.renderPgn();
}

function refreshLinks() {
  const a = $("lichess");
  a.href = "https://lichess.org/analysis/pgn/" + encodeURIComponent(pgn());
  a.setAttribute("aria-disabled", game.history().length === 0 ? "true" : "false");
}

function refreshPanel() {
  const setupMode = !match;
  if ($("app").classList.contains("setup-mode") !== setupMode) {   // a different panel: start it at the top
    document.querySelector(".panel").scrollTop = 0;
    window.scrollTo(0, 0);
  }
  $("app").classList.toggle("setup-mode", setupMode);
  $("app").classList.toggle("game-mode", !setupMode);
  $("setup").classList.toggle("hidden", !setupMode);
  $("game-panel").classList.toggle("hidden", setupMode);
  $("preview-badge").classList.toggle("hidden", !setupMode);
  $("bar-top").classList.toggle("hidden", setupMode);
  $("bar-bottom").classList.toggle("hidden", setupMode);
  $("sound").textContent = prefs.sound ? "🔊" : "🔇";
  $("sound").title = prefs.sound ? "Move sounds on" : "Move sounds off";
  if (setupMode) { refreshSetup(); return; }
  const bvb = humans(match.players).length === 0;
  $("pause").classList.toggle("hidden", !bvb || !inProgress());
  $("pause").textContent = match.paused ? "▶ Resume" : "⏸ Pause";
  $("result-card").classList.toggle("hidden", !finished());
  $("result-card").classList.toggle("won", finished() && match.humanWon);
  if (finished()) $("result-text").textContent = resultText();
  $("celebrate").classList.toggle("hidden", !(finished() && match.humanWon));
  $("start-fen").classList.toggle("hidden", match.variant !== "chess960");
  $("start-fen").textContent = match.variant === "chess960" ? match.startFen : "";
  refreshStatus();
}

function refreshStatus() {
  // A finished game's result is on the result card, above its buttons.
  if (!match || finished()) { setStatus(""); return; }
  if (match.paused) { setStatus("Paused"); return; }
  const colour = colourToMove();
  if (isBot(colour)) { if (!thinking) setStatus(`${playerInfo(colour, match.players).name} to move`); return; }
  setStatus(humans(match.players).length === 2 ? `${capitalised(colour)} to move` : "Your move");
}

function setStatus(text) { $("status").textContent = text; }

function refreshAll() { refreshBoard(); refreshBars(); refreshMoves(); refreshPanel(); }

/* Show the position after `ply` moves; the last ply (or beyond) is the live game again. */
function viewAt(ply) {
  if (!match) return;
  const n = game.history().length;
  const clamped = Math.max(0, Math.min(n, ply));
  match = { ...match, viewPly: clamped === n ? null : clamped };
  refreshBoard(); refreshBars(); refreshMoves();
  save();
}
const shownPly = () => (match.viewPly === null ? game.history().length : match.viewPly);

/* ---- Saving. An unfinished game survives a refresh; a finished one only if a human won it
   (to look at again); after a loss or a draw a refresh starts afresh, at the setup screen. */
function storageError(action, error) {
  console.error(`Could not ${action} the Pedagog game`, error);
  $("storage-warning").textContent = `Could not ${action} your saved game: ${error.message}`;
  $("storage-warning").classList.remove("hidden");
}

function save() {
  const keep = match && (inProgress() || match.humanWon);
  const state = {
    version: 2,
    setup,
    game: keep ? {
      variant: match.variant, position: match.position, startFen: match.startFen, sans: sans(),
      players: match.players, elapsed: liveElapsed(), paused: match.paused,
      orientation: match.orientation, viewPly: match.viewPly, date: match.date, seed: match.seed,
    } : null,
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    if (!(e instanceof DOMException)) throw e;
    storageError("save", e);
  }
}

const validPlayer = (p) => p && (p.type === "human" || p.type === "bot") &&
  Object.hasOwn(ENGINES, p.engine) && integer(p.level, 1, 10);

function validSetup(s) {
  return s && validPlayer(s.bottom) && validPlayer(s.top) && SIDES.includes(s.side) &&
    ["standard", "chess960"].includes(s.variant) && integer(s.position, 0, 959);
}

/* The saved setup and game, or null for a game that cannot be restored (and is dropped). */
function load() {
  let raw;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch (e) {
    if (!(e instanceof DOMException)) throw e;
    storageError("load", e);
    return null;
  }
  if (raw === null) return null;
  try {
    const state = JSON.parse(raw);
    if (state?.version !== 2 || !validSetup(state.setup)) throw new TypeError("Invalid saved setup");
    const saved = state.game;
    if (saved === null) return { setup: state.setup, match: null, game: null };
    if (!saved || !["standard", "chess960"].includes(saved.variant) || !integer(saved.position, 0, 959) ||
        saved.startFen !== (saved.variant === "chess960" ? chess960Fen(saved.position) : START_FEN) ||
        !Array.isArray(saved.sans) || !saved.sans.every((m) => typeof m === "string") ||
        !saved.players || !validPlayer(saved.players.white) || !validPlayer(saved.players.black) ||
        !saved.elapsed || !COLOURS.every((c) => Number.isFinite(saved.elapsed[c]) && saved.elapsed[c] >= 0) ||
        typeof saved.paused !== "boolean" || !COLOURS.includes(saved.orientation) ||
        !(saved.viewPly === null || integer(saved.viewPly, 0, saved.sans.length)) ||
        typeof saved.date !== "string" || !/^\d{4}\.\d{2}\.\d{2}$/.test(saved.date) ||
        !integer(saved.seed, 0, MAX_SEED))
      throw new TypeError("Invalid saved game");
    const restored = new Chess({ fen: saved.startFen, gameVariant: saved.variant });
    for (const san of saved.sans) {
      if (restored.gameOver()) throw new TypeError("Saved moves continue after the game ended");
      if (!restored.move(san)) throw new TypeError("Illegal move in saved game: " + san);
    }
    const outcome = outcomeOf(restored);
    const humanWon = outcome?.winner ? saved.players[outcome.winner].type === "human" : false;
    if (outcome && !humanWon) return { setup: state.setup, match: null, game: null };
    return {
      setup: state.setup,
      game: restored,
      match: {
        variant: saved.variant, position: saved.position, startFen: saved.startFen,
        players: saved.players, elapsed: saved.elapsed, paused: saved.paused, viewPly: saved.viewPly,
        date: saved.date, seed: saved.seed, outcome, humanWon, orientation: saved.orientation,
      },
    };
  } catch (e) {
    if (!(e instanceof SyntaxError || e instanceof TypeError || e instanceof RangeError)) throw e;
    storageError("restore", e);
    return null;
  }
}

/* ---- Playing */
function uciOf(move) { return move.from + move.to + (move.promotion ?? ""); }

function playMove(move) {
  const result = game.move(move);
  if (!result) return false;
  const now = performance.now();
  const mover = result.color === "w" ? "white" : "black";
  const elapsed = match.paused ? match.elapsed : { ...match.elapsed, [mover]: match.elapsed[mover] + now - tickFrom };
  tickFrom = now;
  const outcome = outcomeOf(game, null);
  const humanWon = Boolean(outcome?.winner) && match.players[outcome.winner].type === "human";
  match = { ...match, elapsed, outcome, humanWon };
  refreshAll();
  save();
  if (outcome) endGame();
  else {
    playSound(result.captured ? "capture" : game.inCheck() ? "check" : "move", game.inCheck());
    scheduleBot();
  }
  return true;
}

function endGame() {
  playSound(match.humanWon ? "win" : "end");
  if (match.humanWon) {
    const id = gameId;
    setTimeout(() => { if (id === gameId) celebrate(); }, CELEBRATE_DELAY_MS);
  }
}

function botMove(colour) {
  const p = match.players[colour];
  const tree = p.level > 1 && match.variant === "standard" ? BOOKS[ENGINES[p.engine].book] : undefined;
  const book = tree ? bookMove(tree, sans(), Math.random()) : null;
  if (book) return { book: true, move: sleep(BOOK_MS).then(() => book) };
  const started = performance.now();
  const uci = engineWorker(p.engine).bestMove({
    startFen: match.startFen, moves: game.history().map(uciOf), level: p.level,
    chess960: match.variant === "chess960", seed: match.seed,
  });
  return {
    book: false,
    move: uci.then(async (best) => {
      const wait = MIN_BOT_MS - (performance.now() - started);
      if (wait > 0) await sleep(wait);
      return { from: best.slice(0, 2), to: best.slice(2, 4), promotion: best.length > 4 ? best[4] : undefined };
    }),
  };
}

async function scheduleBot() {
  if (!inProgress() || match.paused || thinking) { refreshStatus(); return; }
  const colour = colourToMove();
  if (!isBot(colour)) { refreshStatus(); return; }
  thinking = true;
  const id = gameId;
  const { book, move } = botMove(colour);
  const indicator = book ? null : setTimeout(() => setThinking(colour, true), THINKING_DELAY_MS);
  if (book) setStatus(`${playerInfo(colour, match.players).name} plays from the book`);
  const answer = await move.catch((e) => e);
  clearTimeout(indicator);
  if (id !== gameId) return;                 // a new game was started meanwhile
  thinking = false;
  setThinking(colour, false);
  if (answer instanceof Error) {
    if (!(answer instanceof Cancelled)) setStatus(`Engine error: ${answer.message}`);
    return;
  }
  if (match.paused) { refreshStatus(); return; }
  if (!playMove(answer)) setStatus(`Engine move rejected: ${JSON.stringify(answer)}`);
}

/* A human move from the board. Promotions ask which piece. */
function onUserMove(from, to) {
  const candidates = game.moves({ square: from, verbose: true }).filter((m) => m.to === to);
  if (candidates.length === 0) { refreshBoard(); return; }
  if (candidates.some((m) => m.promotion)) {
    const colour = colourToMove();
    const box = $("promotion");
    for (const b of box.querySelectorAll("button")) {
      b.querySelector("piece").className = `${PIECE_NAMES[b.dataset.piece]} ${colour}`;
      b.onclick = () => { box.classList.add("hidden"); playMove({ from, to, promotion: b.dataset.piece }); };
    }
    box.classList.remove("hidden");
    return;
  }
  playMove({ from, to });
}

/* Start a game from `fromSetup`: the bottom player takes its side (a coin toss for random) and
   keeps the near side of the board; then the position. */
function startGame(fromSetup) {
  stopCelebration();
  stopEngines();
  gameId++;
  thinking = false;
  const near = fromSetup.side === "random" ? COLOURS[Math.floor(Math.random() * 2)] : fromSetup.side;
  const players = { [near]: fromSetup.bottom, [other(near)]: fromSetup.top };
  const chess960 = fromSetup.variant === "chess960";
  const position = chess960 ? fromSetup.position : STANDARD_POSITION;
  const startFen = chess960 ? chess960Fen(position) : START_FEN;
  game = new Chess({ fen: startFen, gameVariant: chess960 ? GAME_VARIANT.chess960 : GAME_VARIANT.standard });
  match = {
    variant: fromSetup.variant, position, startFen, players, elapsed: { white: 0, black: 0 },
    paused: false, viewPly: null, date: today(), seed: newSeed(), outcome: null, humanWon: false,
    orientation: near,
  };
  tickFrom = performance.now();
  $("promotion").classList.add("hidden");
  audioContext();
  refreshAll();
  save();
  scheduleBot();
}

function toSetup() {
  stopCelebration();
  stopEngines();
  gameId++;
  thinking = false;
  match = null;
  game = new Chess({ fen: START_FEN });
  $("promotion").classList.add("hidden");
  setThinkingOff();
  refreshAll();
  save();
}

function setThinkingOff() {
  for (const bar of [$("bar-top"), $("bar-bottom")]) bar.classList.remove("thinking");
}

function togglePause() {
  if (!inProgress()) return;
  match = { ...match, elapsed: liveElapsed(), paused: !match.paused };
  tickFrom = performance.now();
  refreshAll();
  save();
  scheduleBot();
}

/* ---- Win animation: the beaten bot's own, or a random one for beating a human. A tap or key
   skips it. */
function winAnimation() {
  const loser = match.players[other(match.outcome.winner)];
  return loser.type === "bot"
    ? ENGINES[loser.engine].win
    : WIN_ANIMATIONS[Math.floor(Math.random() * WIN_ANIMATIONS.length)];
}

function celebrate() {
  if (!match?.humanWon) return;
  stopCelebration();
  const id = winAnimation();
  match = { ...match, viewPly: null };
  refreshBoard(); refreshBars(); refreshMoves();
  const fen = game.fen().split(" ")[0];
  const kingSquare = (colour) => {
    const rows = fen.split("/");
    const king = colour === "white" ? "K" : "k";
    const rank = rows.findIndex((row) => row.replace(/\d/g, (d) => ".".repeat(Number(d))).includes(king));
    const file = rows[rank].replace(/\d/g, (d) => ".".repeat(Number(d))).indexOf(king);
    return "abcdefgh"[file] + (8 - rank);
  };
  const winner = match.outcome.winner;
  const run = playWin(id, {
    cg, boardEl: $("board"), winnerKing: kingSquare(winner), loserKing: kingSquare(other(winner)),
    restoreBoard: () => refreshBoard(),
    replay: {
      startFen: match.startFen, variant: match.variant, moves: sans().join(" "),
      white: playerInfo("white", match.players).name, black: playerInfo("black", match.players).name,
      date: match.date.replace(/\./g, "-"), result: pgnResult(),
    },
  });
  const skip = (e) => { if (e.type !== "keydown" || !e.repeat) run.stop(); };
  $("board").addEventListener("pointerdown", skip);
  document.addEventListener("keydown", skip);
  $("app").classList.add("celebrating");
  celebration = run;
  run.finished.then(() => {
    $("board").removeEventListener("pointerdown", skip);
    document.removeEventListener("keydown", skip);
    $("app").classList.remove("celebrating");
    if (celebration === run) celebration = null;
  });
}

function stopCelebration() { celebration?.stop(); }

/* ---- Setup screen */
function previewFen() { return setup.variant === "chess960" ? chess960Fen(setup.position) : START_FEN; }
const setupOrientation = (s) => (s.side === "black" ? "black" : "white");
// The colour `seat` plays: "random" until the game starts.
const seatColour = (s, seat) => (s.side === "random" ? "random" : seat === "bottom" ? s.side : other(s.side));

/* A lone human sits at the bottom, so the board faces them; each player keeps its colour. */
function humanAtBottom(s) {
  if (s.top.type !== "human" || s.bottom.type === "human") return s;
  return { ...s, top: s.bottom, bottom: s.top, side: s.side === "random" ? "random" : other(s.side) };
}

function seatCard(seat) {
  const card = $(`seat-${seat}`);
  card.replaceChildren($("side-template").content.cloneNode(true));
  const select = card.querySelector(".engine");
  select.append(...Object.entries(ENGINES).map(([id, e]) => new Option(e.name, id)));
  for (const b of card.querySelectorAll(".type button"))
    b.onclick = () => changeSeat(seat, { type: b.dataset.value });
  select.onchange = () => changeSeat(seat, { engine: select.value });
  const range = card.querySelector(".level input");
  range.oninput = () => changeSeat(seat, { level: Number(range.value) });
}

const changeSeat = (seat, change) => changeSetup({ [seat]: { ...setup[seat], ...change } });

function changeSetup(change) {
  const changed = { ...setup, ...change };
  setup = humanAtBottom(changed);
  const focused = document.activeElement;
  refreshSetup();
  refreshBoard();
  save();
  if (setup !== changed) followToOtherSeat(focused);
}

/* The players changed seats: the focus goes with the one being edited, to the same control. */
function followToOtherSeat(focused) {
  const card = focused?.closest?.(".side-card");
  if (!card) return;
  const controls = (c) => [...c.querySelectorAll("button, select, input")];
  const twin = $(card.id === "seat-top" ? "seat-bottom" : "seat-top");
  controls(twin)[controls(card).indexOf(focused)]?.focus({ preventScroll: true });
}

function refreshSetup() {
  for (const seat of SEATS) {
    const card = $(`seat-${seat}`), p = setup[seat], colour = seatColour(setup, seat);
    card.querySelector(".swatch").className = `swatch ${colour}`;
    card.querySelector(".side-name").textContent = capitalised(colour);
    card.classList.toggle("bot", p.type === "bot");
    card.classList.toggle("human", p.type === "human");
    for (const b of card.querySelectorAll(".type button")) b.setAttribute("aria-pressed", String(b.dataset.value === p.type));
    const avatar = card.querySelector(".avatar");
    if (avatar.getAttribute("src") !== avatarOf(p)) avatar.src = avatarOf(p);
    card.querySelector(".human-name").textContent = prefs.name;
    card.querySelector(".engine").value = p.engine;
    card.querySelector(".level input").value = p.level;
    card.querySelector(".level output").textContent = ENGINES[p.engine].elo ? `${p.level} (≈${LEVEL_ELO[p.level - 1]})` : String(p.level);
    card.querySelector(".blurb").textContent = p.type === "bot" ? ENGINES[p.engine].blurb : "";
  }
  for (const b of $("side").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.value === setup.side));
  for (const b of $("variant").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.value === setup.variant));
  const chess960 = setup.variant === "chess960";
  $("position-box").classList.toggle("hidden", !chess960);
  if (document.activeElement !== $("position")) $("position").value = setup.position;
  $("position-slider").value = setup.position;
  const rank = chess960Rank(setup.position);
  $("back-rank").textContent = `Position ${setup.position}: ${rank}${setup.position === STANDARD_POSITION ? " (the standard one)" : ""}`;
}

const setPosition = (n) => changeSetup({ position: ((n % 960) + 960) % 960 });

/* ---- Display preferences from the settings page (config.html). */
function applyPrefs() {
  applyTheme(prefs.theme);
  applyCss("board-theme-css", boardCss(BOARD_THEMES.find((t) => t.name === prefs.board), "html"));
  applyCss("piece-set-css", prefs.pieces === "cburnett" ? "" : pieceCss(prefs.pieces, "html .cg-wrap", "vendor/pieces"));
}

/* ---- Wiring */
cg = Chessground($("board"), {
  fen: START_FEN, orientation: "white", coordinates: true,
  animation: { duration: 200 }, highlight: { lastMove: true, check: true },
  // `movable.events.after` is chessground's hook for a completed user move (the board state is
  // already updated when it fires).
  movable: { free: false, color: undefined, dests: new Map(), showDests: true, events: { after: onUserMove } },
  draggable: { showGhost: true }, premovable: { enabled: false },
});
for (const where of ["top", "bottom"]) $(`bar-${where}`).innerHTML = barHtml();
SEATS.forEach(seatCard);

for (const b of $("side").querySelectorAll("button")) b.onclick = () => changeSetup({ side: b.dataset.value });
for (const b of $("variant").querySelectorAll("button")) b.onclick = () => changeSetup({ variant: b.dataset.value });
$("position").oninput = () => {
  const n = Number($("position").value);
  if (integer(n, 0, 959) && $("position").value !== "") changeSetup({ position: n });
};
$("position").onchange = () => refreshSetup();
$("position-slider").oninput = () => changeSetup({ position: Number($("position-slider").value) });
$("position-prev").onclick = () => setPosition(setup.position - 1);
$("position-next").onclick = () => setPosition(setup.position + 1);
$("position-random").onclick = () => setPosition(Math.floor(Math.random() * 960));
// The mouse wheel over the board steps through the Chess960 positions on the setup screen.
$("board").addEventListener("wheel", (e) => {
  if (match || setup.variant !== "chess960") return;
  e.preventDefault();
  setPosition(setup.position + Math.sign(e.deltaY));
}, { passive: false });
$("play").onclick = () => startGame(setup);

$("new-game").onclick = () => {
  if (inProgress() && humans(match.players).length > 0 && game.history().length > 0 &&
      !confirm("Leave this game and set up a new one?")) return;
  toSetup();
};
$("new-setup").onclick = toSetup;
$("play-again").onclick = () => startGame(setup);
$("celebrate").onclick = celebrate;
$("pause").onclick = togglePause;
$("sound").onclick = () => {
  prefs = { ...prefs, sound: !prefs.sound };
  try { savePrefs(prefs); } catch (e) { if (!(e instanceof DOMException)) throw e; }
  audioContext();
  refreshPanel();
};
$("copy-pgn").onclick = () => navigator.clipboard?.writeText(pgn());
$("nav-first").onclick = () => viewAt(0);
$("nav-prev").onclick = () => viewAt(shownPly() - 1);
$("nav-next").onclick = () => viewAt(shownPly() + 1);
$("nav-last").onclick = () => viewAt(game.history().length);

setInterval(refreshClocks, 250);
setInterval(() => { if (inProgress() && !match.paused) save(); }, 5000);
window.addEventListener("pagehide", save);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") save(); });
// Sound needs a first touch; settings changed in another tab apply here too.
document.addEventListener("pointerdown", () => { if (prefs.sound) audioContext(); }, { once: true });
window.addEventListener("storage", (e) => { if (e.key === PREFS_KEY) reloadPrefs(); });
// Coming back from the settings page may restore this page from the back-forward cache.
window.addEventListener("pageshow", (e) => { if (e.persisted) reloadPrefs(); });
function reloadPrefs() {
  prefs = loadPrefs();
  applyPrefs();
  if (match) { refreshBars(); refreshPanel(); } else refreshSetup();
}

// Arrow keys step through the moves; Home/End jump to the start and back to the live game. Keys
// typed into the form controls (the sliders use arrows) are left alone.
document.addEventListener("keydown", (e) => {
  if (!match || celebration || e.target.matches("input, select, textarea") || e.altKey || e.ctrlKey || e.metaKey) return;
  const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
  if (step) viewAt(shownPly() + step);
  else if (e.key === "Home") viewAt(0);
  else if (e.key === "End") viewAt(game.history().length);
  else return;
  e.preventDefault();
});

applyPrefs();
const restored = load();
if (restored) {
  setup = restored.setup;
  if (restored.match) {
    game = restored.game;
    match = restored.match;
  }
}
tickFrom = performance.now();
refreshSetup();
refreshAll();
save();
scheduleBot();

globalThis.pedagogPlay = {   // for the console and tests
  cg, get game() { return game; }, get match() { return match; }, get setup() { return setup; },
  userMove: onUserMove, startGame, toSetup, celebrate, pgn, viewAt, changeSetup,
};

if ("serviceWorker" in navigator && location.protocol.startsWith("http")) navigator.serviceWorker.register("sw.js").catch(() => {});
