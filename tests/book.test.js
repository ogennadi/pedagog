import { expect, test } from "bun:test";
import { Chess } from "../web/vendor/chess.mjs/src/Chess.js";
import { MAX_PLIES, OPENINGS, TREE, bookChildren, parseTree, pickWeighted, treePaths } from "../web/book.js";

const tree = parseTree(TREE);

const illegal = (line) => {
  const c = new Chess();
  const bad = line.findIndex((san) => !c.move(san));
  return bad === -1 ? null : `${line[bad]} after ${line.slice(0, bad).join(" ")}`;
};

test("every book path is legal and at most MAX_PLIES deep", () => {
  const paths = treePaths(tree);
  expect(paths.length).toBeGreaterThan(100);
  expect(paths.filter((p) => p.length > MAX_PLIES)).toEqual([]);
  expect(paths.map(illegal).filter(Boolean)).toEqual([]);
});

test("siblings are distinct moves", () => {
  const dupes = (nodes, path) => [
    ...nodes.filter((n, i) => nodes.findIndex((m) => m.san === n.san) !== i).map((n) => [...path, n.san].join(" ")),
    ...nodes.flatMap((n) => dupes(n.children, [...path, n.san])),
  ];
  expect(dupes(tree, [])).toEqual([]);
});

test("every naming line is legal", () => {
  expect(OPENINGS.map((o) => illegal(o.moves.split(" "))).filter(Boolean)).toEqual([]);
});

test("rim lines are in the book for both colours", () => {
  const sans = (played) => bookChildren(tree, played).map((n) => n.san);
  expect(sans([])).toEqual(expect.arrayContaining(["h4", "a4", "Na3"]));
  expect(sans(["h4", "e5"])).toContain("h5");
  expect(sans(["a4", "e5"])).toContain("a5");
  expect(sans(["e4"])).toEqual(expect.arrayContaining(["h5", "a5"]));
  expect(sans(["d4"])).toEqual(expect.arrayContaining(["h5", "a5"]));
});

test("bookChildren ignores check marks and ends off book", () => {
  expect(bookChildren(tree, ["e4", "c5", "Nf3", "d6", "Bb5"]).map((n) => n.san)).toContain("Bd7");
  expect(bookChildren(tree, ["e4", "e5", "Ke2"])).toEqual([]);
});

test("rim and Grob-type first moves get at least 20% for each colour", () => {
  const WHITE = ["a3", "a4", "h3", "h4", "Na3", "Nh3", "g4", "b4"];
  const BLACK = ["a6", "a5", "h6", "h5", "Na6", "Nh6", "g5", "b5"];
  const total = (nodes) => nodes.reduce((s, n) => s + n.weight, 0);
  const share = (nodes, set) => nodes.filter((n) => set.includes(n.san)).reduce((s, n) => s + n.weight, 0) / total(nodes);
  const white = share(tree, WHITE);
  const black = tree.reduce((s, n) => s + (n.weight / total(tree)) * share(n.children, BLACK), 0);
  expect(white).toBeGreaterThanOrEqual(0.2);
  expect(black).toBeGreaterThanOrEqual(0.2);
});

test("pickWeighted follows the weights", () => {
  const nodes = [{ san: "a", weight: 1 }, { san: "b", weight: 3 }];
  expect(pickWeighted(nodes, 0).san).toBe("a");
  expect(pickWeighted(nodes, 0.24).san).toBe("a");
  expect(pickWeighted(nodes, 0.25).san).toBe("b");
  expect(pickWeighted(nodes, 0.999).san).toBe("b");
});

test("parseTree rejects malformed text", () => {
  expect(() => parseTree("10 e4\n      5 e5")).toThrow();
  expect(() => parseTree("e4")).toThrow();
  expect(() => parseTree(" 10 e4")).toThrow();
  expect(() => parseTree(Array.from({ length: MAX_PLIES + 1 }, (_, i) => `${" ".repeat(2 * i)}1 a`).join("\n"))).toThrow();
});
