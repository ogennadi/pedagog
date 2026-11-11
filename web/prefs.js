/* Display preferences shared by the app and the settings page (config.html): light or dark
   page, which piece set and which board colours. Saved in local storage, apart from the saved game. Each choice is
   applied by adding a <style> element, so the game code never needs to know about it. */

export const PREFS_KEY = "pedagog-prefs-v1";
export const DEFAULT_PREFS = Object.freeze({ theme: "dark", pieces: "cburnett", board: "brown" });

// The piece sets: Lichess's (lichess-org/lila, public/piece) whose licence lets us redistribute
// them, as recorded in lila's COPYING.md, leaving out those without a licence text (alpha, chess7,
// companion, governor, leipzig, reillycraig, riohacha); plus meridian and meridian_shaded
// (kmar/chess_svg_piece_sets) and kosal (philatype/kosal). Files are in
// web/vendor/pieces/<set>/; see LICENSES.md there. `nonCommercial` sets may not be used
// commercially (CC BY-NC-SA), which the settings page points out.
export const PIECE_SETS = [
  ["anarcandy", "CC BY-NC-SA 4.0"], ["caliente", "CC BY-NC-SA 4.0"],
  ["california", "CC BY-NC-SA 4.0"], ["cardinal", "CC BY-NC-SA 4.0"], ["cburnett", "GPLv2+"],
  ["celtic", "MIT"], ["chessnut", "Apache 2.0"], ["cooke", "CC BY-NC-SA 4.0"],
  ["disguised", "CC BY-NC-SA 4.0"], ["dubrovny", "CC BY-NC-SA 4.0"], ["fantasy", "MIT"],
  ["firi", "CC BY 4.0"], ["fresca", "CC BY-NC-SA 4.0"], ["gioco", "CC BY-NC-SA 4.0"],
  ["horsey", "CC BY-NC-SA 4.0"], ["icpieces", "CC BY-NC-SA 4.0"], ["kiwen-suwi", "CC BY 4.0"],
  ["kosal", "CC BY 4.0"],
  ["letter", "AGPLv3+"], ["maestro", "CC BY-NC-SA 4.0"], ["merida", "GPLv2+"],
  ["meridian", "CC0"], ["meridian_shaded", "CC0"],
  ["minimal-warmth", "CC BY-NC-SA 4.0"], ["monarchy", "CC BY-NC-SA 4.0"], ["mono", "GPLv2+"],
  ["mpchess", "GPLv3+"], ["papercut", "CC BY 4.0"], ["pirouetti", "AGPLv3+"],
  ["pixel", "AGPLv3+"], ["rhosgfx", "CC0 1.0"],
  ["shahi-ivory-brown", "free, unmodified (Şahî font licence)"], ["shapes", "CC BY-SA 4.0"],
  ["spatial", "MIT"], ["staunty", "CC BY-NC-SA 4.0"], ["tatiana", "CC BY-NC-SA 4.0"],
  ["totoy", "CC BY 4.0"], ["xkcd", "CC BY-NC-SA 2.5"],
].map(([name, licence]) => ({ name, licence, nonCommercial: licence.includes("NC") }));

export const THEMES = ["dark", "light", "system"];

// Light and dark squares, after the Lichess board colours of the same names.
export const BOARD_THEMES = [
  { name: "brown", light: "#f0d9b5", dark: "#b58863" },
  { name: "blue", light: "#dee3e6", dark: "#8ca2ad" },
  { name: "green", light: "#ffffdd", dark: "#86a666" },
  { name: "purple", light: "#9f90b0", dark: "#7d4a8d" },
  { name: "olive", light: "#ececec", dark: "#c1c18e" },
  { name: "grey", light: "#dcdcdc", dark: "#a0a0a0" },
  { name: "coral", light: "#f3e4cf", dark: "#d98b75" },
  { name: "night", light: "#8b9aa8", dark: "#4b5967" },
];

const ROLES = { king: "K", queen: "Q", rook: "R", bishop: "B", knight: "N", pawn: "P" };

export function loadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY)) ?? {};
    return {
      theme: THEMES.includes(saved.theme) ? saved.theme : DEFAULT_PREFS.theme,
      pieces: PIECE_SETS.some((s) => s.name === saved.pieces) ? saved.pieces : DEFAULT_PREFS.pieces,
      board: BOARD_THEMES.some((t) => t.name === saved.board) ? saved.board : DEFAULT_PREFS.board,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(prefs) {
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
}

/* CSS that draws the pieces of `set` inside `scope` (a selector), from `base`, the URL of the
   pieces directory. "mono" has one image per piece for both colours; "monarchy" is WebP. */
export function pieceCss(set, scope, base) {
  const rules = [];
  for (const [role, letter] of Object.entries(ROLES)) {
    for (const [colour, prefix] of [["white", "w"], ["black", "b"]]) {
      const file = set === "mono" ? `${letter}.svg` : `${prefix}${letter}.${set === "monarchy" ? "webp" : "svg"}`;
      rules.push(`${scope} piece.${role}.${colour} { background-image: url("${base}/${set}/${file}"); }`);
    }
  }
  return rules.join("\n");
}

/* CSS that colours the squares of every board inside `scope` with `theme`: a checkerboard drawn
   by a conic gradient, two squares to a tile, so a1 (bottom left) is dark. */
export function boardCss(theme, scope) {
  return `${scope} cg-board { background-color: ${theme.light}; background-image: ` +
    `repeating-conic-gradient(${theme.dark} 0 25%, ${theme.light} 0 50%); background-size: 25% 25%; }`;
}

/* Light or dark page colours (app.css), or none to follow the system setting. */
export function applyTheme(theme) {
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.dataset.theme = theme;
}

/* Put `css` into the page in a <style> element with this id, replacing any earlier one. */
export function applyCss(id, css) {
  const style = document.getElementById(id) ?? document.head.appendChild(document.createElement("style"));
  style.id = id;
  style.textContent = css;
}
