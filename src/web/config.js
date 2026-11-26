/* Settings page (config.html, behind the gear on the game page): the player's name and picture
   and move sounds, light or dark page and the board colours from menus, and the piece set by
   clicking one of the previews, which all show the same position. */
import { Chessground } from "chessground";
import {
  PIECE_SETS, BOARD_THEMES, DEFAULT_PREFS, MAX_NAME, loadPrefs, savePrefs,
  pieceCss, boardCss, applyCss, applyTheme,
} from "./prefs.js";

const PIECES_BASE = "vendor/pieces";
const AVATAR_PX = 96;
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
  if (document.activeElement !== $("player-name")) $("player-name").value = prefs.name;
  $("avatar-preview").src = prefs.avatar || "avatars/human.svg";
  $("avatar-remove").disabled = !prefs.avatar;
  $("sound").checked = prefs.sound;
}

function choose(change) {
  prefs = { ...prefs, ...change };
  try {
    savePrefs(prefs);
  } catch (e) {
    if (!(e instanceof DOMException)) throw e;
    alert(`Could not save the settings: ${e.message}`);
  }
  render();
}

/* The picture in `file`, cropped to a centred square and scaled to AVATAR_PX, as a data URL. */
async function avatarFrom(file) {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = AVATAR_PX;
  canvas.getContext("2d").drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2,
    side, side, 0, 0, AVATAR_PX, AVATAR_PX);
  bitmap.close();
  const webp = canvas.toDataURL("image/webp", 0.85);
  return webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/png");
}

$("player-name").maxLength = MAX_NAME;
$("player-name").oninput = () => choose({ name: $("player-name").value.trim().slice(0, MAX_NAME) || DEFAULT_PREFS.name });
$("player-name").onchange = () => { $("player-name").value = prefs.name; };
$("avatar-file").onchange = async () => {
  const file = $("avatar-file").files[0];
  $("avatar-file").value = "";
  if (!file) return;
  try {
    choose({ avatar: await avatarFrom(file) });
  } catch (e) {
    alert(`Could not use that picture: ${e.message}`);
  }
};
$("avatar-remove").onclick = () => choose({ avatar: "" });
$("sound").onchange = () => choose({ sound: $("sound").checked });

$("board-theme").append(...BOARD_THEMES.map((t) => new Option(t.name, t.name)));
$("board-theme").onchange = () => choose({ board: $("board-theme").value });
$("theme").onchange = () => choose({ theme: $("theme").value });
$("reset").onclick = () => choose({ theme: DEFAULT_PREFS.theme, board: DEFAULT_PREFS.board, pieces: DEFAULT_PREFS.pieces });

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
