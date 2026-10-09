import { expect, test } from "bun:test";
import { engine } from "./engine.js";

test("search terminates on stop, draw, depth zero and maximum ply", () => {
  const e = engine();
  e.run("stopped = true");
  expect(e.read("search(-INF, INF, 2, 0)")).toBe(0);
  e.run("stopped = false; evaluate = () => 123");
  expect(e.read("search(-INF, INF, 0, 0)")).toBe(123);
  expect(e.read("search(-INF, INF, 2, MAX_PLY - 1)")).toBe(123);
  e.command("position fen 7k/8/8/8/8/8/8/K7 w - - 0 1");
  expect(e.read("search(-INF, INF, 2, 1)")).toBe(0);
  e.run("rootDepth = 2; nodes = 1023; nodeLimit = 1024");
  expect(e.read("search(-INF, INF, 2, 0)")).toBe(0);
  expect(e.read("stopped")).toBe(true);
});

for (const [name, fen, score] of [
  ["checkmate", "7k/6Q1/5K2/8/8/8/8/8 b - - 0 1", -32000],
  ["stalemate", "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1", 0],
]) {
  test(`search and think handle ${name}`, () => {
    const e = engine();
    e.command("position fen " + fen);
    expect(e.read("search(-INF, INF, 2, 0)")).toBe(score);
    e.command("go depth 2");
    expect(e.output).toEqual(["bestmove 0000"]);
    e.command("setoption name Skill_Level value 1");
    e.command("go depth 2");
    expect(e.output.at(-1)).toBe("bestmove 0000");
  });
}

test("overlooked moves are undone, with static evaluation when none are seen", () => {
  const e = engine();
  const before = e.read("toFen()");
  e.run("seesMove = () => false; evaluate = () => 77");
  expect(e.read("search(-INF, INF, 1, 1)")).toBe(77);
  expect(e.read("toFen()")).toBe(before);
  expect(e.read("hply")).toBe(0);
});

test("root exclusions, alpha improvements and beta cutoffs", () => {
  const e = engine();
  e.run("rootSkipped.push(parseMove('b1c3')); nodes = 0");
  e.read("search(-INF, INF, 1, 0)");
  expect(e.read("nodes")).toBe(20); // root plus 19 remaining moves
  expect(e.read("moveToUci(pvTable[0])")).not.toBe("b1c3");
  e.run("rootSkipped.length = 0; nodes = 0");
  e.read("search(-INF, -INF + 1, 1, 0)");
  expect(e.read("nodes")).toBe(2);
  e.run("pvLength[0] = 0; nodes = 0");
  e.read("search(INF - 1, INF, 1, 0)");
  expect(e.read("pvLength[0]")).toBe(0); // no move improves alpha
});

test("interrupted recursion restores the board and discards that result", () => {
  const e = engine();
  const before = e.read("toFen()");
  e.run("evaluate = () => { stopped = true; return 100; }");
  expect(e.read("search(-INF, INF, 1, 0)")).toBe(0);
  expect(e.read("toFen()")).toBe(before);
  expect(e.read("hply")).toBe(0);
});

test("think preserves the last completed line on interruption and honors soft time", () => {
  const e = engine();
  e.run(`
    setLimits({ depth: 3 });
    globalThis.realSearch = search;
    search = (...args) => {
      if (rootDepth > 1) { stopped = true; return 0; }
      return realSearch(...args);
    };
    think();
  `);
  expect(e.output.filter((line) => line.startsWith("info depth"))).toHaveLength(1);
  expect(e.output.at(-1)).toBe("bestmove b1c3");
  e.output.length = 0;
  e.run("search = realSearch; timeSoft = -1; think()");
  expect(e.output.filter((line) => line.startsWith("info depth"))).toHaveLength(1);
  expect(e.output.at(-1)).toBe("bestmove b1c3");
});

test("MultiPV never exceeds the number of visible root moves", () => {
  const e = engine();
  e.run("overlookedRootMoves = (moves) => moves.slice(1)");
  e.command("setoption name MultiPV value 256");
  e.command("go depth 2");
  expect(e.output.filter((line) => line.startsWith("info depth"))).toHaveLength(2);
  expect(e.output.at(-1)).toMatch(/^bestmove \w{4} ponder \w{4}$/);
});

test("PV update appends the child's line", () => {
  const e = engine();
  e.run("pvTable[MAX_PLY + 1] = 42; pvTable[MAX_PLY + 2] = 43; pvLength[1] = 3; updatePV(0, 41)");
  expect(Array.from(e.read("pvTable.slice(0, 3)"))).toEqual([41, 42, 43]);
  expect(e.read("pvLength[0]")).toBe(3);
});

test("move ordering partitions captures/promotions without changing the move set", () => {
  const e = engine();
  e.command("position fen 1r5k/P7/8/3pP3/8/8/8/K7 w - d6 0 1");
  e.run("globalThis.last = generateMoves(0); globalThis.before = [...moveStack.slice(0, last)]; orderMoves(0, last)");
  const moves = Array.from(e.read("moveStack.slice(0, last)"));
  expect([...moves].sort()).toEqual(Array.from(e.read("before")).sort());
  expect(e.read(`
    (() => {
      let quietSeen = false;
      for (const move of moveStack.slice(0, last)) {
        const tactical = board[moveTo(move)] !== EMPTY || moveFlag(move) === FLAG_EP || movePromo(move);
        if (!tactical) quietSeen = true;
        else if (quietSeen) return false;
      }
      return true;
    })()
  `)).toBe(true);
});

test("skill depth: fixed rung, deeper position, and ordinary position", () => {
  const e = engine();
  expect(e.read("skillDepth()")).toBe(100);
  e.run("skill = { ...skill, depth: 2, deeperPermille: 1000 }");
  expect(e.read("skillDepth()")).toBe(3);
  e.run("skill.deeperPermille = 1; mix32 = () => 999");
  expect(e.read("skillDepth()")).toBe(2);
});

test("blunders: disabled, absent and bounded deterministic error", () => {
  const e = engine();
  expect(e.read("blunder()")).toBe(0);
  e.run("skill = { ...skill, blunderWindow: 50, blunderPermille: 1 }; mix32 = () => 999");
  expect(e.read("blunder()")).toBe(0);
  e.run("skill.blunderPermille = 1000; mix32 = () => 0");
  expect(e.read("blunder()")).toBe(-50);
});

test("vision: full, first chance, second chance for captures/EP/check, and missed quiet moves", () => {
  const e = engine();
  expect(e.read("seesMove(0, 1)")).toBe(true);
  e.run("skill = { ...skill, vision: 160 }; mix32 = () => 0");
  expect(e.read("seesMove(0, 1)")).toBe(true);
  e.run("mix32 = () => 1023 << 20; hply = 1; histCaptured[0] = PAWN");
  expect(e.read("seesMove(0, 1)")).toBe(true);
  e.run("histCaptured[0] = EMPTY");
  expect(e.read("seesMove(encodeMove(0, 1, 0, FLAG_EP), 1)")).toBe(true);
  e.run("isAttacked = () => true");
  expect(e.read("seesMove(0, 1)")).toBe(true);
  e.run("isAttacked = () => false");
  expect(e.read("seesMove(0, 1)")).toBe(false);
  e.run("mix32 = () => (1023 << 20) | (1023 << 8); histCaptured[0] = PAWN");
  expect(e.read("seesMove(0, 100)")).toBe(false);
});

test("root vision restores position and falls back if every move is missed", () => {
  const e = engine();
  expect(Array.from(e.read("overlookedRootMoves(legalMoves())"))).toEqual([]);
  const before = e.read("toFen()");
  e.run("skill = { ...skill, vision: 160 }; seesMove = () => false");
  expect(Array.from(e.read("overlookedRootMoves(legalMoves())"))).toEqual([]);
  e.run("seesMove = (move) => moveFrom(move) === parseSquare('b1')");
  expect(e.read("overlookedRootMoves(legalMoves()).length")).toBe(18);
  expect(e.read("toFen()")).toBe(before);
});

test("random skill always takes a mate in one and otherwise is seed-deterministic", () => {
  const e = engine();
  e.command("setoption name Skill_Level value 1");
  e.command("position fen 7k/8/5KQ1/8/8/8/8/8 w - - 0 1");
  e.command("go depth 1");
  e.run(`makeMove(parseMove('${e.output.at(-1).split(" ")[1]}'))`);
  expect(e.read("legalMoves().length")).toBe(0);
  expect(e.read("isAttacked(kingSq[side], side ^ 1)")).toBe(true);
  e.command("position startpos");
  e.output.length = 0;
  e.command("go depth 1");
  const first = [...e.output];
  e.output.length = 0;
  e.command("go depth 1");
  expect(e.output).toEqual(first);
});
