/* Sound sampler (sounds.html): every capture sound in game-sounds.js, the game's one marked, each
   alone, after two ordinary moves, with check and after a plain check; then the game's other
   sounds. They play even when move sounds are off in the settings. */
import { audioContext, scheduleSound, CAPTURES, GAME_CAPTURE } from "./game-sounds.js";
import { loadPrefs, applyTheme } from "./prefs.js";

const $ = (id) => document.getElementById(id);
const GAP = 0.45;            // seconds between the moves of "In a game"
const ALL_GAP = 1.1;         // and between the captures of "Play all in turn"
const VS_GAP = 0.8;          // between the plain check and the capture of "vs check"
const LIT_MS = 600;          // how long a row stays lit after its sound starts

applyTheme(loadPrefs().theme);

/* Run schedule(ctx, at) as soon as the audio context runs; the click that calls this unlocks it. */
async function hear(schedule) {
  const ctx = audioContext();
  if (!ctx) return;
  if (ctx.state !== "running") await ctx.resume();
  schedule(ctx, ctx.currentTime + 0.02);
}

function light(li, delaySeconds = 0) {
  setTimeout(() => {
    li.classList.add("playing");
    setTimeout(() => li.classList.remove("playing"), LIT_MS);
  }, delaySeconds * 1000);
}

function button(label, onclick, title = "") {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.title = title;
  b.onclick = onclick;
  return b;
}

/* A list item: name (with a key hint and a tag, if any), a line about it, and its buttons. */
function item({ key, name, tag, about, actions }) {
  const li = document.createElement("li");
  const text = document.createElement("div");
  text.className = "text";
  const title = document.createElement("div");
  title.className = "name";
  if (key) title.append(Object.assign(document.createElement("kbd"), { textContent: key }));
  title.append(name);
  if (tag) title.append(Object.assign(document.createElement("span"), { className: "tag", textContent: tag }));
  text.append(title, Object.assign(document.createElement("div"), { className: "about", textContent: about }));
  const buttons = document.createElement("div");
  buttons.className = "actions";
  buttons.append(...actions(li));
  li.append(text, buttons);
  return li;
}

/* Captures, the game's first. */
const ids = [GAME_CAPTURE, ...Object.keys(CAPTURES).filter((id) => id !== GAME_CAPTURE)];
const playCapture = (id, li) => {
  light(li);
  hear((ctx, at) => scheduleSound(ctx, at, "capture", false, id));
};
const rows = ids.map((id, i) => item({
  key: i < 9 ? String(i + 1) : "",
  name: CAPTURES[id].name,
  tag: id === GAME_CAPTURE ? "in the game" : "",
  about: CAPTURES[id].about,
  actions: (li) => [
    button("▶ Play", () => playCapture(id, li)),
    button("In a game", () => {
      light(li, 2 * GAP);
      hear((ctx, at) => {
        scheduleSound(ctx, at, "move");
        scheduleSound(ctx, at + GAP, "move");
        scheduleSound(ctx, at + 2 * GAP, "capture", false, id);
      });
    }, "Two ordinary moves, then this capture"),
    button("+ check", () => {
      light(li);
      hear((ctx, at) => scheduleSound(ctx, at, "capture", true, id));
    }, "A capture that gives check"),
    button("vs check", () => {
      light(li, VS_GAP);
      hear((ctx, at) => {
        scheduleSound(ctx, at, "check");
        scheduleSound(ctx, at + VS_GAP, "capture", true, id);
      });
    }, "A plain check, then this capture giving check"),
  ],
}));
$("captures").append(...rows);

$("play-all").onclick = () => {
  rows.forEach((li, i) => light(li, i * ALL_GAP));
  hear((ctx, at) => ids.forEach((id, i) => scheduleSound(ctx, at + i * ALL_GAP, "capture", false, id)));
};

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const i = Number(e.key) - 1;
  if (Number.isInteger(i) && i >= 0 && i < Math.min(9, ids.length)) playCapture(ids[i], rows[i]);
});

/* The game's other sounds. */
const OTHERS = [
  { name: "Move", about: "An ordinary move: one soft knock.", kind: "move" },
  { name: "Check", about: "A move that gives check: the knock and a ping.", kind: "check" },
  { name: "Capture with check", about: "The game's capture sound and the ping.", kind: "capture", check: true },
  { name: "Win", about: "The last move, then a rising chime: a human won.", kind: "win" },
  { name: "Loss or draw", about: "The last move, then two falling notes.", kind: "end" },
];
$("others").append(...OTHERS.map(({ name, about, kind, check = kind === "check" }) => item({
  name, about,
  actions: (li) => [button("▶ Play", () => {
    light(li);
    hear((ctx, at) => scheduleSound(ctx, at, kind, check));
  })],
})));
