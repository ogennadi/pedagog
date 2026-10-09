import { expect, test } from "bun:test";
import { engine } from "./engine.js";

const snapshot = (e) => e.read("JSON.stringify({ board: [...board], kings: [...kingSq], counts: [...pieceCount], side, castling, epSq, fifty, keyLo, keyHi, hply })");

for (const [fen, depth, count] of [
  ["rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", 3, 8902],
  ["r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1", 2, 2039],
  ["8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1", 3, 2812],
  ["r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1", 2, 264],
  ["rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8", 2, 1486],
]) {
  test(`perft ${depth}: ${fen}`, () => {
    const e = engine();
    e.command("position fen " + fen);
    const before = snapshot(e);
    expect(e.read(`perft(${depth}, 0)`)).toBe(count);
    expect(snapshot(e)).toBe(before);
    e.command("perft 1");
    expect(e.output.at(-1)).toContain(`nodes ${e.read("legalMoves().length")}`);
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
  test(`make/unmake restores every position field: ${name}`, () => {
    const e = engine();
    e.command("setoption name UCI_Chess960 value true");
    e.command("position fen " + fen);
    const before = snapshot(e);
    e.run(`globalThis.move = parseMove('${move}')`);
    expect(e.read("move")).not.toBe(0);
    expect(e.read("makeMove(move)")).toBe(true);
    expect(snapshot(e)).not.toBe(before);
    e.run("unmakeMove()");
    expect(snapshot(e)).toBe(before);
  });
}

test("illegal pinned move and en passant discovered check restore state", () => {
  const e = engine();
  for (const [fen, from, to, flag] of [
    ["4r2k/8/8/8/8/8/4R3/4K3 w - - 0 1", "e2", "d2", 0],
    ["7k/8/8/r4pPK/8/8/8/8 w - f6 0 1", "g5", "f6", 1],
  ]) {
    e.command("position fen " + fen);
    const before = snapshot(e);
    expect(e.read(`makeMove(encodeMove(parseSquare('${from}'), parseSquare('${to}'), 0, ${flag}))`)).toBe(false);
    expect(snapshot(e)).toBe(before);
    expect(e.read(`parseMove('${from}${to}')`)).toBe(0);
  }
});

test("castling notation accepts either convention and rejects blocked/attacked paths", () => {
  const e = engine();
  e.command("position fen r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
  expect(e.read("parseMove('e1g1')")).toBe(e.read("parseMove('e1h1')"));
  expect(e.read("moveToUci(parseMove('e1h1'))")).toBe("e1g1");
  e.command("setoption name UCI_Chess960 value true");
  expect(e.read("moveToUci(parseMove('e1g1'))")).toBe("e1h1");
  for (const fen of [
    "7k/8/8/8/8/8/8/R3KB1R w KQ - 0 1",
    "5r1k/8/8/8/8/8/8/R3K2R w KQ - 0 1",
    "4r2k/8/8/8/8/8/8/R3K2R w KQ - 0 1",
  ]) {
    e.command("position fen " + fen);
    expect(e.read("parseMove('e1g1')")).toBe(0);
  }
});

test("FEN rights: standard, file letters, missing rook and en passant", () => {
  const e = engine();
  e.command("setoption name UCI_Chess960 value true");
  e.command("position fen 2r1k1r1/8/8/8/8/8/8/1R2K1R1 w GBgc - 0 1");
  expect(e.read("castling")).toBe(15);
  expect(e.read("toFen()")).toBe("2r1k1r1/8/8/8/8/8/8/1R2K1R1 w GBgc - 0 1");
  e.command("position fen 7k/8/8/8/8/8/8/K7 w KQ -");
  expect(e.read("castling")).toBe(0);
  expect(e.read("fifty")).toBe(0);
  e.command("position startpos moves e2e4");
  expect(e.read("toFen()")).toContain(" b KQkq e3 0 ");
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
    e.command("position fen " + fen);
    expect(e.read("isDraw()")).toBe(draw);
  });
}

test("search repetition policy recognizes one earlier occurrence, not official threefold", () => {
  const e = engine();
  e.command("position startpos moves g1f3 g8f6 f3g1 f6g8");
  expect(e.read("isDraw()")).toBe(true);
  e.command("position startpos moves g1f3 g8f6 f3g1 f6g8 e2e4");
  expect(e.read("isDraw()")).toBe(false);
});

test("attacks distinguish piece directions, slider blockers, colors and board edges", () => {
  const e = engine();
  e.command("position fen 7k/8/8/8/8/8/8/K7 w - - 0 1");
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
    e.run(`board.fill(EMPTY); board[parseSquare('${square}')] = ${piece}`);
    expect(e.read(`isAttacked(parseSquare('${target}'), ${color})`)).toBe(expected);
  }
  e.run("board.fill(EMPTY); board[parseSquare('e1')] = ROOK; board[parseSquare('e2')] = PAWN | 8");
  expect(e.read("isAttacked(parseSquare('e4'), WHITE)")).toBe(false);
});

test("black pawn pushes, promotion choices and castling rights after rook capture", () => {
  const e = engine();
  e.command("position fen 7k/8/8/8/8/8/p7/7K b - - 0 1");
  expect(Array.from(e.read("legalMoves().map(moveToUci)")).filter((move) => move.startsWith("a2a1")).sort())
    .toEqual(["a2a1b", "a2a1n", "a2a1q", "a2a1r"]);
  e.command("position startpos moves e2e4 e7e5");
  expect(e.read("squareName(epSq)")).toBe("e6");
  e.command("position fen r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1 moves a1a8");
  expect(e.read("castling")).toBe(5); // both queenside rook rights disappear
});
