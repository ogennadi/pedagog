import { expect, test } from "bun:test";
import { engine } from "./engine.js";

test("UCI handshake, readiness, ignored commands, stop and quit", () => {
  const e = engine();
  e.command("  uci  ");
  expect(e.output[0]).toBe("id name Pedagog 1.0");
  expect(e.output.at(-1)).toBe("uciok");
  expect(e.output.filter((line) => line.startsWith("option name "))).toHaveLength(5);
  expect(e.output.some((line) => line.startsWith("option name MultiPV"))).toBe(false);
  expect(e.output.some((line) => line.includes("Chapter"))).toBe(false);
  e.output.length = 0;
  for (const command of ["", "unknown", "stop", "setoption", "setoption name Unknown value 3", "setoption name Hash value 64", "setoption name Threads value 1"]) e.command(command);
  expect(e.output).toEqual([]);
  e.command("isready");
  e.command("quit");
  expect(e.output).toEqual(["readyok", "quit"]);
});

for (const [name, variable, cases] of [
  ["Skill_Level", "skillLevel", [["-9", 1], ["999", 10], ["4", 4], ["invalid", 10], ["", 10]]],
  ["Skill_Seed", "skillSeed", [["0", 0], ["42", 42], ["invalid", 0], ["", 0]]],
  ["UCI_Chess960", "chess960", [["TRUE", true], ["false", false], ["invalid", false], ["", false]]],
]) {
  test(`setoption ${name}: values, limits and defaults`, () => {
    const e = engine();
    for (const [value, expected] of cases) {
      e.command(`setoption name ${name} value ${value}`);
      expect(e.read(variable)).toBe(expected);
    }
    e.command(`setoption name ${name}`);
    expect(e.read(variable)).toBe(cases.at(-1)[1]);
  });
}

test("position startpos/FEN, valid/invalid moves and new game", () => {
  const e = engine();
  e.command("position startpos moves e2e4 invalid e7e5");
  expect(e.read("hply")).toBe(2);
  expect(e.read("squareName(epSq)")).toBe("e6");
  e.command("ucinewgame");
  expect(e.read("toFen()")).toBe(e.read("START_FEN"));
  e.command("position fen 7k/8/8/8/8/8/8/K7 b - - 17 1");
  expect(e.read("side")).toBe(1);
  expect(e.read("fifty")).toBe(17);
  e.command("position fen 7k/8/8/8/8/8/8/K7 w - - 0 1 moves a1a2");
  expect(e.read("kingSq[WHITE]")).toBe(16);
  e.command("position startpos");
  expect(e.read("hply")).toBe(0);
});

test("go parses infinite, numeric options and unrecognized tokens", () => {
  const e = engine();
  e.run("globalThis.received = null; setLimits = (go) => { received = go; }; think = () => out('searched');");
  e.command("go infinite depth 3 nodes 2048 movetime 100 junk");
  expect({ ...e.read("received") }).toEqual({ infinite: true, depth: 3, nodes: 2048, movetime: 100 });
  expect(e.output).toEqual(["searched"]);
});

test("diagnostic command routing and depth defaults", () => {
  const e = engine();
  e.run("bench = (depth) => out('bench ' + depth); perftDivide = (depth) => out('perft ' + depth);");
  for (const command of ["bench", "bench 2", "bench invalid", "perft", "perft 2", "perft invalid"]) e.command(command);
  expect(e.output).toEqual(["bench 5", "bench 2", "bench 5", "perft 4", "perft 2", "perft 4"]);
  e.output.length = 0;
  e.command("d");
  expect(e.output).toContain("fen " + e.read("START_FEN"));
  expect(e.output.some((line) => /^key [0-9a-f]{16}$/.test(line))).toBe(true);
  e.command("eval");
  expect(e.output.at(-1)).toBe("eval 0 (side to move)");
});

test("time limits: defaults, explicit budgets, clocks, increments and weakened play", () => {
  const e = engine();
  const limits = () => Array.from(e.read("[depthLimit, nodeLimit, timeSoft, timeHard]"));
  e.run("setLimits({})");
  expect(limits()).toEqual([100, 0, Infinity, Infinity]);
  e.run("setLimits({ depth: 3, nodes: 99, movetime: 120 })");
  expect(limits()).toEqual([3, 99, 100, 100]);
  e.run("setLimits({ movetime: 1 })");
  expect(limits().slice(2)).toEqual([1, 1]);
  e.run("setLimits({ wtime: 3000 })");
  expect(limits().slice(2)).toEqual([80, 320]);
  e.run("setLimits({ wtime: 1000, winc: 40, movestogo: 10 })");
  expect(limits().slice(2)).toEqual([110, 440]);
  e.run("side = BLACK; setLimits({ btime: 1000, binc: 40, movestogo: 10 })");
  expect(limits().slice(2)).toEqual([110, 440]);
  e.run("setLimits({ btime: 10 })");
  expect(limits().slice(2)).toEqual([1, 1]);
  e.run("setSkillLevel(4); setLimits({ depth: 2, nodes: 10, movetime: 1 })");
  expect(limits()).toEqual([2, 10, Infinity, Infinity]);
});

test("hard limits: first iteration, node count, clock and shared stop flag", () => {
  const e = engine();
  e.run("rootDepth = 1; nodeLimit = 1; nodes = 10; timeHard = 0; checkLimits()");
  expect(e.read("stopped")).toBe(false);
  e.run("rootDepth = 2; timeHard = Infinity; checkLimits()");
  expect(e.read("stopped")).toBe(true);
  e.run("stopped = false; nodeLimit = 0; timeHard = 100");
  e.clock(99);
  e.run("checkLimits()");
  expect(e.read("stopped")).toBe(false);
  e.clock(100);
  e.run("checkLimits()");
  expect(e.read("stopped")).toBe(true);
  e.run("stopped = false; timeHard = Infinity; stopFlag = new Int32Array(new SharedArrayBuffer(4)); checkLimits()");
  expect(e.read("stopped")).toBe(false);
  e.run("Atomics.store(stopFlag, 0, 1); checkLimits()");
  expect(e.read("stopped")).toBe(true);
});

test("report formats centipawns, winning/losing mate, PV and elapsed time", () => {
  const e = engine();
  e.run("nodes = 100; pvTable[0] = parseMove('e2e4'); pvLength[0] = 1; report(1, 25)");
  expect(e.output.at(-1)).toBe("info depth 1 multipv 1 score cp 25 nodes 100 nps 0 time 0 pv e2e4");
  e.clock(50);
  e.run("report(3, MATE - 3); report(3, -MATE + 4)");
  expect(e.output.at(-2)).toContain("score mate 2 nodes 100 nps 2000 time 50");
  expect(e.output.at(-1)).toContain("score mate -2");
});
