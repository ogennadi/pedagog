/* Win-animation demo (animations.html): a fixed checkmate on the board and a menu of the
   animations in win-animations.js to play over it. */
import { Chessground } from "chessground";
import { ANIMATIONS, squareCentre, element } from "./win-animations.js";
import { BOARD_THEMES, loadPrefs, pieceCss, boardCss, applyCss, applyTheme } from "./prefs.js";

// A back-rank mate: the rook on d8 mates the king on g8, so White (king on g1) has won.
const FEN = "3R2k1/5ppp/8/8/8/8/5PPP/6K1";
const WINNER_KING = "g1";
const LOSER_KING = "g8";
const LAST_MOVE = ["d1", "d8"];
const $ = (id) => document.getElementById(id);

const prefs = loadPrefs();
applyTheme(prefs.theme);
applyCss("board-theme-css", boardCss(BOARD_THEMES.find((t) => t.name === prefs.board), "html"));
if (prefs.pieces !== "cburnett")
  applyCss("piece-set-css", pieceCss(prefs.pieces, "html .cg-wrap", "vendor/pieces"));

const cg = Chessground($("board"), {
  fen: FEN, orientation: "white", coordinates: true, viewOnly: true, lastMove: LAST_MOVE,
  turnColor: "black", check: true, highlight: { lastMove: true, check: true },
});
const container = $("board").querySelector("cg-container");
const layers = { under: element("fx", container), over: element("fx over", container) };

let running = [];
const restoreBoard = () => cg.set({
  animation: { enabled: true, duration: 200 }, fen: FEN, lastMove: LAST_MOVE, turnColor: "black", check: true,
});
function play() {
  running.forEach((a) => a.cancel());
  Object.values(layers).forEach((layer) => { layer.replaceChildren(); layer.classList.remove("unclipped", "exploding"); });
  const centre = squareCentre(WINNER_KING, cg.state.orientation);
  const loser = squareCentre(LOSER_KING, cg.state.orientation);
  const pieces = [...container.querySelectorAll("cg-board piece")];
  running = ANIMATIONS[$("animation").value].play(layers, {
    centre, loser, pieces, winnerKing: WINNER_KING, loserKing: LOSER_KING,
    orientation: cg.state.orientation, cgBoard: container.querySelector("cg-board"),
    coords: [...container.querySelectorAll("coords")], cg, restoreBoard, boardEl: $("board"),
  });
  if (freezeAt !== null) running.forEach((a) => { a.pause(); a.currentTime = freezeAt; });
}

// animations.html?t=800 holds every animation at 800 ms, to study (or screenshot) one frame.
const freezeParam = new URLSearchParams(location.search).get("t");
const freezeAt = freezeParam === null ? null : Number(freezeParam);

$("animation").append(...Object.entries(ANIMATIONS).map(([id, a]) => new Option(a.name, id)));
// animations.html?a=explode starts on that animation.
const pick = new URLSearchParams(location.search).get("a");
if (pick in ANIMATIONS) $("animation").value = pick;
$("animation").onchange = play;
$("play").onclick = play;
play();
