import { expect, test } from "bun:test";
import { engine } from "./engine.js";

// Each test loads its own position into `globalThis.pos` and passes it to
// the engine's functions explicitly.
const load = (e, spec, chess960 = false) =>
  e.run(`globalThis.pos = positionFromUci(${JSON.stringify(spec)}, ${chess960})`);

// A position's fields as a string, for comparing two positions.
const snapshot = (e, expr = "pos") => e.read(`((p) => JSON.stringify({ board: [...p.board], kings: [...p.kingSq], counts: [...p.pieceCount], side: p.side, castling: p.castling, epSq: p.epSq, fifty: p.fifty, key: String(p.key) }))(${expr})`);

const quietIo = "{ now: () => 0, shouldStop: () => false, onInfo: () => {} }";

for (const [fen, depth, count] of [
  ["rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", 3, 8902],
  ["r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1", 2, 2039],
  ["8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1", 3, 2812],
  ["r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1", 2, 264],
  ["rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8", 2, 1486],
]) {
  test(`perft ${depth}: ${fen}`, () => {
    const e = engine();
    load(e, "fen " + fen);
    const before = snapshot(e);
    expect(e.read(`perft(pos, ${depth})`)).toBe(count);
    expect(snapshot(e)).toBe(before);
    e.command("position fen " + fen);
    e.command("perft 1");
    expect(e.output.at(-1)).toContain(`nodes ${e.read("legalMoves(pos).length")}`);
    expect(snapshot(e)).toBe(before);
  });
}

for (const [name, fen, move] of [
  ["double pawn push", "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", "e2e4"],
  ["capture", "7k/8/8/8/8/1p6/P7/K7 w - - 0 1", "a2b3"],
  ["en passant", "7k/8/8/3pP3/8/8/8/K7 w - d6 0 1", "e5d6"],
  ["black en passant", "7k/8/8/8/3Pp3/8/8/K7 b - d3 0 1", "e4d3"],
  ["promotion", "7k/P7/8/8/8/8/8/K7 w - - 0 1", "a7a8q"],
  ["black promotion", "7k/8/8/8/8/8/p7/7K b - - 0 1", "a2a1q"],
  ["capture promotion", "1r5k/P7/8/8/8/8/8/K7 w - - 0 1", "a7b8n"],
  ["kingside castling", "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1", "e1g1"],
  ["queenside castling", "r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1", "e8c8"],
  ["Chess960 swapped destinations", "7k/8/8/8/8/8/8/5KR1 w G - 0 1", "f1g1"],
  ["Chess960 stationary king", "7k/8/8/8/8/8/8/6KR w H - 0 1", "g1h1"],
]) {
  test(`makeMove returns a consistent new position and leaves the old one unchanged: ${name}`, () => {
    const e = engine();
    load(e, "fen " + fen, true);
    const before = snapshot(e);
    e.run(`globalThis.move = parseMove(pos, '${move}', true); globalThis.after = makeMove(pos, move)`);
    expect(e.read("move")).not.toBe(0);
    expect(e.read("after !== null && after.prev === pos")).toBe(true);
    expect(snapshot(e)).toBe(before);
    expect(snapshot(e, "after")).not.toBe(before);
    // The incremental updates agree with loading the new FEN from scratch.
    expect(snapshot(e, "after")).toBe(snapshot(e, "positionFromFen(toFen(after, true))"));
    expect(e.read("Number.isSafeInteger(after.key)")).toBe(true); // the sum stays exact
  });
}

test("illegal pinned move and en passant discovered check are rejected", () => {
  const e = engine();
  for (const [fen, from, to, flag] of [
    ["4r2k/8/8/8/8/8/4R3/4K3 w - - 0 1", "e2", "d2", 0],
    ["7k/8/8/r4pPK/8/8/8/8 w - f6 0 1", "g5", "f6", 1],
  ]) {
    load(e, "fen " + fen);
    const before = snapshot(e);
    expect(e.read(`makeMove(pos, encodeMove(parseSquare('${from}'), parseSquare('${to}'), 0, ${flag}))`)).toBe(null);
    expect(snapshot(e)).toBe(before);
    expect(e.read(`parseMove(pos, '${from}${to}', false)`)).toBe(0);
  }
});

test("castling notation accepts either convention and rejects blocked/attacked paths", () => {
  const e = engine();
  load(e, "fen r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
  expect(e.read("parseMove(pos, 'e1g1', false)")).toBe(e.read("parseMove(pos, 'e1h1', false)"));
  expect(e.read("moveToUci(parseMove(pos, 'e1h1', false), false)")).toBe("e1g1");
  expect(e.read("moveToUci(parseMove(pos, 'e1g1', true), true)")).toBe("e1h1");
  for (const fen of [
    "7k/8/8/8/8/8/8/R3KB1R w KQ - 0 1",
    "5r1k/8/8/8/8/8/8/R3K2R w KQ - 0 1",
    "4r2k/8/8/8/8/8/8/R3K2R w KQ - 0 1",
  ]) {
    load(e, "fen " + fen, true);
    expect(e.read("parseMove(pos, 'e1g1', true)")).toBe(0);
  }
});

test("FEN rights: standard, file letters, missing rook and en passant", () => {
  const e = engine();
  load(e, "fen 2r1k1r1/8/8/8/8/8/8/1R2K1R1 w GBgc - 0 1", true);
  expect(e.read("pos.castling")).toBe(15);
  expect(e.read("toFen(pos, true)")).toBe("2r1k1r1/8/8/8/8/8/8/1R2K1R1 w GBgc - 0 1");
  load(e, "fen 7k/8/8/8/8/8/8/K7 w KQ -", true);
  expect(e.read("pos.castling")).toBe(0);
  expect(e.read("pos.fifty")).toBe(0);
  load(e, "startpos moves e2e4", true);
  expect(e.read("toFen(pos, true)")).toContain(" b KQkq e3 0 ");
});

for (const [fen, draw] of [
  ["7k/8/8/8/8/8/P7/K7 w - - 100 1", true],
  ["7k/8/8/8/8/8/8/K7 w - - 0 1", true],
  ["7k/8/8/8/8/8/N7/K7 w - - 0 1", true],
  ["7k/8/8/8/8/8/B7/K7 w - - 0 1", true],
  ["7k/8/8/8/8/8/NN6/K7 w - - 0 1", false],
  ["7k/8/8/8/8/8/P7/K7 w - - 0 1", false],
  ["7k/8/8/8/8/8/R7/K7 w - - 0 1", false],
  ["7k/8/8/8/8/8/Q7/K7 w - - 0 1", false],
]) {
  test(`draw detection: ${fen}`, () => {
    const e = engine();
    load(e, "fen " + fen);
    expect(e.read("isDraw(pos)")).toBe(draw);
  });
}

test("search repetition policy recognizes one earlier occurrence, not official threefold", () => {
  const e = engine();
  load(e, "startpos moves g1f3 g8f6 f3g1 f6g8");
  expect(e.read("isDraw(pos)")).toBe(true);
  load(e, "startpos moves g1f3 g8f6 f3g1 f6g8 e2e4");
  expect(e.read("isDraw(pos)")).toBe(false);
});

test("attacks distinguish piece directions, slider blockers, colors and board edges", () => {
  const e = engine();
  for (const [piece, square, target, color, expected] of [
    ["PAWN", "d3", "e4", "WHITE", true],
    ["PAWN", "f3", "e4", "WHITE", true],
    ["PAWN | 8", "d5", "e4", "BLACK", true],
    ["PAWN | 8", "f5", "e4", "BLACK", true],
    ["PAWN", "d5", "e4", "WHITE", false],
    ["KNIGHT", "c3", "e4", "WHITE", true],
    ["KING", "d3", "e4", "WHITE", true],
    ["ROOK", "e2", "e4", "WHITE", true],
    ["BISHOP", "b1", "e4", "WHITE", true],
    ["QUEEN", "b1", "e4", "WHITE", true],
    ["QUEEN", "e2", "e4", "WHITE", true],
    ["ROOK", "b1", "e4", "WHITE", false],
    ["BISHOP", "e2", "e4", "WHITE", false],
    ["ROOK | 8", "e2", "e4", "WHITE", false],
    ["PAWN", "h2", "a4", "WHITE", false],
  ]) {
    e.run(`globalThis.board = new Int8Array(128); board[parseSquare('${square}')] = ${piece}`);
    expect(e.read(`isAttacked(board, parseSquare('${target}'), ${color})`)).toBe(expected);
  }
  e.run("globalThis.board = new Int8Array(128); board[parseSquare('e1')] = ROOK; board[parseSquare('e2')] = PAWN | 8");
  expect(e.read("isAttacked(board, parseSquare('e4'), WHITE)")).toBe(false);
});

test("black pawn pushes, promotion choices and castling rights after rook capture", () => {
  const e = engine();
  load(e, "fen 7k/8/8/8/8/8/p7/7K b - - 0 1");
  expect(Array.from(e.read("legalMoves(pos).map((m) => moveToUci(m, false))")).filter((move) => move.startsWith("a2a1")).sort())
    .toEqual(["a2a1b", "a2a1n", "a2a1q", "a2a1r"]);
  load(e, "startpos moves e2e4 e7e5");
  expect(e.read("squareName(pos.epSq)")).toBe("e6");
  load(e, "fen r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1 moves a1a8");
  expect(e.read("pos.castling")).toBe(5); // both queenside rook rights disappear
});

test("think finds a mate in one, returns its line and leaves the position unchanged", () => {
  const e = engine();
  load(e, "fen 6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1");
  const before = snapshot(e);
  e.run(`globalThis.result = think(pos, limitsFor({ depth: 3 }, pos.side, SKILL_MAX), skillFor(SKILL_MAX, 0, true), ${quietIo})`);
  expect(e.read("moveToUci(result.bestMove, false)")).toBe("d1d8");
  expect(e.read("result.score")).toBe(e.read("MATE - 1"));
  expect(e.read("result.pv.length")).toBe(1);
  expect(e.read("result.depth")).toBe(3);
  expect(snapshot(e)).toBe(before);
});

test("an interrupted search still finishes depth one", () => {
  const e = engine();
  load(e, "startpos");
  const before = snapshot(e);
  e.run(`globalThis.result = think(pos, limitsFor({}, pos.side, SKILL_MAX), skillFor(SKILL_MAX, 0, true), { now: () => 0, shouldStop: () => true, onInfo: () => {} })`);
  expect(e.read("result.depth")).toBeGreaterThanOrEqual(1);
  expect(e.read("result.depth")).toBeLessThan(5);
  expect(e.read("legalMoves(pos).includes(result.bestMove)")).toBe(true);
  expect(snapshot(e)).toBe(before);
});

test("limitsFor is a pure translation of go numbers", () => {
  const e = engine();
  expect(e.read("JSON.stringify(limitsFor({ movetime: 1000 }, WHITE, SKILL_MAX))"))
    .toBe(JSON.stringify({ depth: 100, nodes: 0, softMs: 980, hardMs: 980 }));
  expect(e.read("limitsFor({ movetime: 1000 }, WHITE, 5).hardMs")).toBe(Infinity);
  expect(e.read("limitsFor({ wtime: 60000, btime: 1000 }, BLACK, SKILL_MAX).hardMs"))
    .toBe(e.read("limitsFor({ wtime: 1000 }, WHITE, SKILL_MAX).hardMs"));
  // A search that runs to its hard limit never takes the clock below the
  // one-second reserve, and below the reserve it gains on the increment.
  for (const time of [200, 1000, 1500, 3000, 10000, 60000]) {
    const hard = e.read(`limitsFor({ wtime: ${time}, winc: 100 }, WHITE, SKILL_MAX).hardMs`);
    expect(time + 100 - hard).toBeGreaterThanOrEqual(Math.min(1000, time));
  }
});

test("UCI session: options and positions carry over between commands", () => {
  const e = engine();
  e.command("position fen 6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1");
  e.command("go depth 3");
  expect(e.output.some((line) => line.includes("score mate 1"))).toBe(true);
  expect(e.output.at(-1)).toBe("bestmove d1d8");
  e.command("setoption name Skill_Level value 1"); // the random mover still mates in one
  e.command("go depth 3");
  expect(e.output.at(-1)).toBe("bestmove d1d8");
  e.command("setoption name UCI_Chess960 value true");
  e.command("position fen r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1 moves e1g1");
  e.command("d");
  expect(e.output.find((line) => line.startsWith("fen "))).toBe("fen r3k2r/8/8/8/8/8/8/R4RK1 b kq - 1 1");
});

test("the Aggressive option chooses the style and its ladder", () => {
  const e = engine();
  e.command("uci");
  expect(e.output).toContain("option name Aggressive type check default true");
  expect(e.read("skillFor(SKILL_MAX, 0, true).checkBias")).toBeGreaterThan(0);
  expect(e.read("skillFor(SKILL_MAX, 0, false).checkBias")).toBe(0);
  expect(e.read("skillFor(5, 0, false).kingAttack")).toBe(0);
  expect(e.read("skillFor(5, 0, true).kingAttack")).toBeGreaterThan(0);
  e.command("setoption name Aggressive value false");
  e.command("position fen 6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1");
  e.command("go depth 3");
  expect(e.output.at(-1)).toBe("bestmove d1d8");
});
