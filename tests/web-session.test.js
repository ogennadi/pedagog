import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";

const root = resolve(import.meta.dir, "..");
const vendor = resolve(root, "web", "vendor");
const built = await Bun.build({
  entrypoints: [resolve(vendor, "cm-chess", "src", "Chess.js")],
  format: "cjs",
  target: "browser",
  plugins: [{
    name: "vendor-imports",
    setup(build) {
      build.onResolve({ filter: /^(cm-pgn|chess\.mjs)\// }, ({ path }) => ({
        path: resolve(vendor, ...path.split("/")),
      }));
    },
  }],
});
if (!built.success) throw new Error(built.logs.join("\n"));
const chessSource = await built.outputs[0].text();
const source = readFileSync(resolve(root, "web", "app.js"), "utf8").replace(/^import .*;$/gm, "");
const key = "pedagog-session-v1";

function app(storage = new Map(), failure = null) {
  let time = 0;
  const elements = new Map(), events = new Map(), timers = [], commands = [], errors = [];
  const defaults = { mode: "hvb", colour: "white", level: "5", level2: "5", variant: "standard", position: "518" };
  function element(id) {
    if (elements.has(id)) return elements.get(id);
    const classes = new Set();
    const node = {
      value: defaults[id] || "", textContent: "", innerHTML: "", firstChild: {},
      parentElement: {}, appendChild() {}, querySelector() { return null; },
      checkValidity() { return Number.isInteger(Number(this.value)) && Number(this.value) >= 0 && Number(this.value) <= 959; },
      classList: {
        add: (c) => classes.add(c), remove: (c) => classes.delete(c),
        contains: (c) => classes.has(c),
        toggle(c, enabled) { if (enabled ?? !classes.has(c)) classes.add(c); else classes.delete(c); },
      },
      setAttribute() {},
    };
    let value = node.value;
    Object.defineProperty(node, "value", {
      get: () => value,
      set: (next) => { value = String(next); },
    });
    elements.set(id, node);
    return node;
  }
  const context = createContext({
    module: { exports: {} }, exports: {},
    console: { error: (...args) => errors.push(args), warn() {}, log() {} },
    performance: { now: () => time },
    DOMException, URL, Blob,
    setTimeout: () => 1,
    setInterval: (fn) => timers.push(fn),
    localStorage: {
      getItem: (k) => { if (failure) throw failure; return storage.get(k) ?? null; },
      setItem: (k, v) => { if (failure) throw failure; storage.set(k, v); },
    },
    navigator: {},
    location: { protocol: "file:" },
    document: {
      getElementById: element, createElement: () => element(Symbol()),
      addEventListener: (name, fn) => events.set(name, fn),
      visibilityState: "visible",
    },
    window: { addEventListener: (name, fn) => events.set(name, fn) },
    BOOK: [],
    Chessground: () => ({
      state: { orientation: "white" },
      set(props) { if (props.orientation) this.state.orientation = props.orientation; },
      toggleOrientation() { this.state.orientation = this.state.orientation === "white" ? "black" : "white"; },
    }),
    Worker: class {
      postMessage(cmd) {
        commands.push(cmd);
        if (cmd === "uci") queueMicrotask(() => this.onmessage({ data: "uciok" }));
      }
      terminate() {}
    },
  });
  context.exports = context.module.exports;
  runInContext(`(function(module, exports) { ${chessSource}\n })(module, exports);`, context);
  context.Chess = context.module.exports.Chess;
  context.GAME_VARIANT = context.module.exports.GAME_VARIANT;
  runInContext(source, context);
  return {
    storage, elements, events, commands, errors, timers,
    api: context.pedagogApp,
    read: (code) => runInContext(code, context),
    run: (code) => runInContext(code, context),
    clock: (ms) => { time = ms; },
    setting(id, value) { element(id).value = String(value); element(id).oninput(); },
    saved: () => JSON.parse(storage.get(key)),
  };
}

test("settings survive reload before a game, including conditional controls", () => {
  const a = app();
  for (const [id, value] of Object.entries({ mode: "bvb", colour: "random", level: 10, level2: 3, variant: "chess960", position: 123 }))
    a.setting(id, value);
  const b = app(a.storage);
  expect(b.saved().game).toBeNull();
  for (const id of ["mode", "colour", "level", "level2", "variant", "position"])
    expect(b.elements.get(id).value).toBe(a.elements.get(id).value);
  expect(b.elements.get("colour-row").classList.contains("hidden")).toBe(true);
  expect(b.elements.get("position-row").classList.contains("hidden")).toBe(false);
  expect(b.elements.get("level-out").textContent).toStartWith("10 ");
  expect(b.read("running")).toBe(false);
});

test("a live game restores history, actual players, clocks and orientation independently of next-game settings", () => {
  const a = app();
  a.setting("colour", "random");
  a.api.newGame();
  a.clock(1200);
  a.run('playMove("e4"); playMove("e5"); playMove("Nf3")');
  a.elements.get("flip").onclick();
  a.setting("variant", "chess960");
  a.setting("level", 2);
  a.api.viewAt(1);
  a.clock(2500);
  a.events.get("pagehide")();
  const saved = a.saved().game;
  const b = app(a.storage);
  expect(b.api.game.fen()).toBe(a.api.game.fen());
  expect(b.api.game.history().map((m) => m.san)).toEqual(["e4", "e5", "Nf3"]);
  expect(b.read("uciMoves.join(' ')")).toBe("e2e4 e7e5 g1f3");
  expect(JSON.parse(b.read("JSON.stringify(players)"))).toEqual(saved.players);
  expect(JSON.parse(b.read("JSON.stringify(elapsed)"))).toEqual(saved.elapsed);
  expect(b.read("variant")).toBe("standard");
  expect(b.elements.get("variant").value).toBe("chess960");
  expect(b.api.cg.state.orientation).toBe(saved.orientation);
  expect(b.api.shownPly()).toBe(1);
  expect(b.api.pgn()).toBe(a.api.pgn());
  expect(b.read("running")).toBe(true);
});

test("an unpaused bot turn resumes once the engine is ready", async () => {
  const a = app();
  a.setting("colour", "black");
  a.api.newGame();
  const b = app(a.storage);
  await new Promise((resolve) => setImmediate(resolve));
  expect(b.commands.filter((cmd) => cmd.startsWith("go "))).toEqual(["go depth 100"]);
  expect(b.read("thinking")).toBe(true);
});

test("paused Chess960 restores without playing, then resumes with the same position", async () => {
  const a = app();
  a.setting("mode", "bvb");
  a.setting("variant", "chess960");
  a.setting("position", 123);
  a.api.newGame();
  a.clock(4000);
  a.elements.get("pause").onclick();
  a.clock(14000);
  a.events.get("pagehide")();
  const b = app(a.storage);
  await new Promise((resolve) => setImmediate(resolve));
  expect(b.read("paused")).toBe(true);
  expect(b.commands.some((cmd) => cmd.startsWith("go "))).toBe(false);
  expect(b.elements.get("pause").textContent).toBe("Resume");
  expect(b.elements.get("start-fen").textContent).toContain("Position 123:");
  expect(b.api.game.fen()).toBe(a.api.game.fen());
  expect(b.read("elapsed.white")).toBe(4000);
  b.elements.get("pause").onclick();
  await new Promise((resolve) => setImmediate(resolve));
  expect(b.commands).toContain("setoption name UCI_Chess960 value true");
  expect(b.commands.filter((cmd) => cmd.startsWith("go "))).toHaveLength(1);
});

test("completed games retain result, PGN, move browsing and captures without restarting", async () => {
  const a = app();
  a.api.newGame();
  a.run('playMove("f3"); playMove("e5"); playMove("g4"); playMove("Qh4#")');
  const pgn = a.api.pgn();
  a.api.viewAt(2);
  const b = app(a.storage);
  await new Promise((resolve) => setImmediate(resolve));
  expect(b.read("finished")).toBe(true);
  expect(b.read("running")).toBe(false);
  expect(b.api.pgn()).toBe(pgn);
  expect(pgn).toContain('[Result "0-1"]');
  expect(b.elements.get("result").textContent).toContain("Black wins");
  expect(b.api.shownPly()).toBe(2);
  expect(b.commands.some((cmd) => cmd.startsWith("go "))).toBe(false);
  expect(b.elements.get("lichess").href).toContain(encodeURIComponent(pgn));
  b.api.newGame();
  expect(b.saved().game.moves).toEqual([]);
  expect(b.read("finished")).toBe(false);
});

test("replaying the history preserves repetition draws", () => {
  const a = app();
  a.api.newGame();
  a.run('for (const san of ["Nf3", "Nf6", "Ng1", "Ng8", "Nf3", "Nf6", "Ng1", "Ng8"]) playMove(san)');
  const b = app(a.storage);
  expect(b.api.game.inThreefoldRepetition()).toBe(true);
  expect(b.read("finished")).toBe(true);
  expect(b.elements.get("result").textContent).toContain("threefold");
});

test("restored captures and castling reproduce the board and PGN", () => {
  const a = app();
  a.api.newGame();
  a.run('for (const san of ["e4", "d5", "exd5", "Qxd5", "Nc3", "Qd8", "Nf3", "Nf6", "Bc4", "e6", "O-O"]) playMove(san)');
  const b = app(a.storage);
  expect(b.api.game.fen()).toBe(a.api.game.fen());
  expect(b.api.pgn()).toBe(a.api.pgn());
  expect(b.read('capturedBy("white", game.fen()).join("")')).toBe("p");
  expect(b.read('capturedBy("black", game.fen()).join("")')).toBe("p");
  expect(b.read("uciMoves.at(-1)")).toBe("e1g1");
});

test("invalid saved moves are rejected atomically and an unfinished position input does not corrupt the save", () => {
  const a = app();
  a.api.newGame();
  a.setting("position", "");
  a.events.get("pagehide")();
  expect(a.saved().settings.position).toBe("518");
  const state = a.saved();
  state.game.moves = ["e4", "not-a-move"];
  a.storage.set(key, JSON.stringify(state));
  const b = app(a.storage);
  expect(b.read("running")).toBe(false);
  expect(b.api.game.history()).toHaveLength(0);
  expect(b.elements.get("storage-warning").textContent).toContain("Illegal move");
});

test("corrupt or unavailable storage reports an error without blocking a new game", () => {
  for (const raw of ["{", '{"version":99}', '{"version":1,"settings":null}']) {
    const a = app(new Map([[key, raw]]));
    expect(a.errors).toHaveLength(1);
    expect(a.elements.get("storage-warning").textContent).toContain("Could not restore");
    a.api.newGame();
    expect(a.saved().version).toBe(1);
  }
  const a = app(new Map(), new DOMException("Storage disabled", "SecurityError"));
  expect(a.elements.get("storage-warning").textContent).toContain("Could not load");
  a.api.newGame();
  expect(a.read("running")).toBe(true);
  expect(a.elements.get("storage-warning").textContent).toContain("Could not save");
});
