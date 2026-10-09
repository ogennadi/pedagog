import { expect, test } from "bun:test";
import { engine } from "./engine.js";

test("evaluation is side-relative, tapered, integer-valued and adds skill noise", () => {
  const e = engine();
  expect(e.read("evaluate()")).toBe(0);
  e.command("position fen 7k/8/8/8/8/8/P7/K7 w - - 0 1");
  const white = e.read("evaluate()");
  expect(white).toBeGreaterThan(0);
  e.run("side = BLACK");
  expect(e.read("evaluate()")).toBe(-white);
  e.run("blunder = () => 17");
  expect(e.read("evaluate()")).toBe(-white + 17);
  e.run("blunder = () => 0");
  e.command("position fen qqqqqqqk/8/8/8/8/8/8/KQQQQQQQ w - - 0 1");
  expect(Number.isInteger(e.read("evaluate()"))).toBe(true); // phase above 24 is clamped
});

test("piece-square formulas cover each piece, development, centers, files and ranks", () => {
  const e = engine();
  expect(Array.from(e.read("squareBonus(PAWN, 3, 3)"))).toEqual([21, 24]);
  expect(Array.from(e.read("squareBonus(PAWN, 0, 1)"))).toEqual([0, 0]);
  expect(Array.from(e.read("squareBonus(KNIGHT, 3, 3)"))).toEqual([12, 12]);
  expect(Array.from(e.read("squareBonus(KNIGHT, 0, 0)"))).toEqual([-34, -24]);
  expect(Array.from(e.read("squareBonus(BISHOP, 3, 3)"))).toEqual([6, 6]);
  expect(Array.from(e.read("squareBonus(ROOK, 3, 6)"))).toEqual([20, 15]);
  expect(Array.from(e.read("squareBonus(ROOK, 0, 0)"))).toEqual([0, 0]);
  expect(Array.from(e.read("squareBonus(QUEEN, 3, 3)"))).toEqual([3, 5]);
  expect(Array.from(e.read("squareBonus(KING, 0, 0)"))).toEqual([20, -30]);
  expect(Array.from(e.read("squareBonus(KING, 3, 3)"))).toEqual([-85, 15]);
  expect(e.read("squareBonus(EMPTY, 0, 0)")).toBeUndefined();
  expect(e.read(`
    (() => {
      for (let type = PAWN; type <= KING; type++)
        for (let square = 0; square < 128; square++)
          if (!(square & 0x88) &&
              (placeMg[type * 128 + square] !== -placeMg[(type | 8) * 128 + (square ^ 0x70)] ||
               placeEg[type * 128 + square] !== -placeEg[(type | 8) * 128 + (square ^ 0x70)])) return false;
      return true;
    })()
  `)).toBe(true);
});
