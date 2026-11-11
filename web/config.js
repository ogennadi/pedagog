/* Settings page (config.html, behind the gear on the game page): light or dark page and the board
   colours from menus, and the piece set by clicking one of the previews, which all show the same
   position. */
import { Chessground } from "chessground";
import {
  PIECE_SETS, BOARD_THEMES, DEFAULT_PREFS, loadPrefs, savePrefs, pieceCss, boardCss, applyCss,
  applyTheme,
} from "./prefs.js";

const PIECES_BASE = "vendor/lichess-pieces";
// An open game, so every piece of both colours is on the board.
const PREVIEW_FEN = "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R";
const $ = (id) => document.getElementById(id);

let prefs = loadPrefs();

function render() {
  applyTheme(prefs.theme);
  $("theme").value = prefs.theme;
  const theme = BOARD_THEMES.find((t) => t.name === prefs.board);
  applyCss("board-theme-css", boardCss(theme, ".sets"));
  $("board-theme").value = prefs.board;
  $("current-pieces").textContent = prefs.pieces;
  for (const card of document.querySelectorAll(".set"))
    card.classList.toggle("selected", card.dataset.set === prefs.pieces);
}

function choose(change) {
  prefs = { ...prefs, ...change };
  savePrefs(prefs);
  render();
}

$("board-theme").append(...BOARD_THEMES.map((t) => new Option(t.name, t.name)));
$("board-theme").onchange = () => choose({ board: $("board-theme").value });
$("theme").onchange = () => choose({ theme: $("theme").value });
$("reset").onclick = () => choose(DEFAULT_PREFS);

// One stylesheet scopes every set to its own preview.
applyCss("piece-sets-css",
  PIECE_SETS.map((s) => pieceCss(s.name, `.set[data-set="${s.name}"]`, PIECES_BASE)).join("\n"));
for (const set of PIECE_SETS) {
  const card = document.createElement("div");
  card.className = "set";
  card.dataset.set = set.name;
  card.title = `${set.name} (${set.licence})`;
  const nc = set.nonCommercial ? `<br><span class="nc">non-commercial</span>` : "";
  card.innerHTML = `<div class="preview"></div>
    <div class="caption"><span>${set.name}</span><span class="licence">${set.licence}${nc}</span></div>`;
  card.onclick = () => choose({ pieces: set.name });
  $("sets").append(card);
  Chessground(card.querySelector(".preview"), {
    fen: PREVIEW_FEN, viewOnly: true, coordinates: false, animation: { enabled: false },
  });
}
render();
