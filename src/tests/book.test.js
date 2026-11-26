import { expect, test } from "bun:test";
import { Chess } from "../web/vendor/chess.mjs/src/Chess.js";
import { MAX_PLIES, OPENINGS, TREE, bookCandidates, bookChildren, bookMove, parseTree, pickWeighted, plain, treePaths } from "../web/book.js";
import { BOOKS } from "../web/books.js";

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

test("rook-pawn rim thrusts are not book lines for either colour", () => {
  const sans = (played) => bookChildren(tree, played).map((n) => n.san);
  expect(sans([])).toContain("Na3");
  expect(sans([])).not.toEqual(expect.arrayContaining(["h4"]));
  expect(sans([])).not.toEqual(expect.arrayContaining(["a4"]));
  for (const first of ["e4", "d4"]) {
    expect(sans([first])).not.toContain("h5");
    expect(sans([first])).not.toContain("a5");
  }
});

test("bookChildren ignores check marks and ends off book", () => {
  expect(bookChildren(tree, ["e4", "c5", "Nf3", "d6", "Bb5"]).map((n) => n.san)).toContain("Bd7");
  expect(bookChildren(tree, ["e4", "e5", "Ke2"])).toEqual([]);
});

test("rim and Grob-type first moves get at least 12% for each colour", () => {
  const WHITE = ["a3", "a4", "h3", "h4", "Na3", "Nh3", "g4", "b4"];
  const BLACK = ["a6", "a5", "h6", "h5", "Na6", "Nh6", "g5", "b5"];
  const total = (nodes) => nodes.reduce((s, n) => s + n.weight, 0);
  const share = (nodes, set) => nodes.filter((n) => set.includes(n.san)).reduce((s, n) => s + n.weight, 0) / total(nodes);
  const white = share(tree, WHITE);
  const black = tree.reduce((s, n) => s + (n.weight / total(tree)) * share(n.children, BLACK), 0);
  expect(white).toBeGreaterThanOrEqual(0.12);
  expect(black).toBeGreaterThanOrEqual(0.12);
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

/* ---- The bots' books (books.js) ---- */

/* The same position with the other side to move: stands in for "any opponent move". */
const nullMove = (chess) => {
  const fields = chess.fen().split(" ");
  return new Chess([fields[0], fields[1] === "w" ? "b" : "w", fields[2], "-", ...fields.slice(4)].join(" "));
};

/* Illegal moves anywhere in a book: "*" becomes a null move, and each later move of a system
   is played after a null move, so a system must be legal whatever the opponent does quietly. */
const bookErrors = (nodes, fen = new Chess().fen(), path = []) =>
  nodes.flatMap((n) => {
    if (n.san === "*") return bookErrors(n.children, nullMove(new Chess(fen)).fen(), [...path, "*"]);
    const chess = new Chess(fen);
    if (!chess.move(n.san)) return [`${n.san} after ${path.join(" ")}`];
    const system = n.then.reduce(
      (acc, step) => {
        if (acc.error) return acc;
        const next = nullMove(acc.chess);
        return next.move(step.san) ? { chess: next } : { error: `${step.san} of ${[n.san, ...n.then.map((s) => s.san)].join(" ")} after ${path.join(" ")}` };
      },
      { chess: new Chess(chess.fen()) },
    );
    return [...(system.error ? [system.error] : []), ...bookErrors(n.children, chess.fen(), [...path, n.san])];
  });

const sansOf = (candidates) => candidates.map((c) => plain(c.san));
const weightOf = (candidates, set) => candidates.filter((c) => set.includes(plain(c.san))).reduce((s, c) => s + c.weight, 0);
const totalOf = (candidates) => candidates.reduce((s, c) => s + c.weight, 0);

test("every move of every bot's book is legal", () => {
  for (const [id, book] of Object.entries(BOOKS)) expect([id, bookErrors(book)]).toEqual([id, []]);
});

test("siblings in the bots' books are distinct", () => {
  const key = (n) => [n.san, ...n.then.map((s) => s.san)].join(" ");
  const dupes = (nodes, path) => [
    ...nodes.filter((n, i) => nodes.findIndex((m) => key(m) === key(n)) !== i).map((n) => [...path, key(n)].join(" ")),
    ...nodes.flatMap((n) => dupes(n.children, [...path, n.san])),
  ];
  for (const [id, book] of Object.entries(BOOKS)) expect([id, dupes(book, [])]).toEqual([id, []]);
});

test("the Pedagog book offers the same moves as before", () => {
  const prefixes = [...new Set(treePaths(tree).flatMap((p) => p.map((_, i) => p.slice(0, i).join(" "))))];
  for (const prefix of prefixes) {
    const played = prefix ? prefix.split(" ") : [];
    const before = bookChildren(tree, played).filter((n) => n.weight > 0).map((n) => [plain(n.san), n.weight]);
    expect([prefix, bookCandidates(BOOKS.pedagog, played).map((c) => [plain(c.san), c.weight])]).toEqual([prefix, before]);
  }
});

test("Aggressive: flank systems are 20% of the first move, and of the reply to 1.e4, 1.d4 and 1.f4", () => {
  const WHITE = ["h4", "a4", "g4", "b4"];
  const BLACK = ["h5", "a5", "g5", "b5"];
  const root = bookCandidates(BOOKS.aggressive, []);
  expect(weightOf(root, WHITE) / totalOf(root)).toBeCloseTo(0.2, 5);
  for (const first of ["e4", "d4", "f4"]) {
    const replies = bookCandidates(BOOKS.aggressive, [first]);
    expect([first, weightOf(replies, BLACK) / totalOf(replies)]).toEqual([first, expect.closeTo(0.2, 5)]);
  }
  expect(sansOf(bookCandidates(BOOKS.aggressive, ["Nf3"])).sort()).toEqual(["a5", "a5", "b5", "g5", "h5"]);
});

test("Aggressive answers 1.e4 and 1.d4 only with gambits or flank systems", () => {
  expect(sansOf(bookCandidates(BOOKS.aggressive, ["e4"])).sort()).toEqual(["a5", "a5", "b5", "d5", "e5", "g5", "h5"]);
  expect(sansOf(bookCandidates(BOOKS.aggressive, ["d4"])).sort()).toEqual(["Nf6", "a5", "a5", "b5", "d5", "e5", "g5", "h5"]);
  expect(sansOf(bookCandidates(BOOKS.aggressive, ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"]))).toEqual(["b4"]);
  expect(bookCandidates(BOOKS.aggressive, ["e4", "e5", "Nf3", "Nc6", "Bc4", "Be7"])).toEqual([]);
});

test("a system continues by its own moves, whatever quiet moves the opponent makes", () => {
  expect(sansOf(bookCandidates(BOOKS.hedgehog, ["g3", "e5"]))).toEqual(["Bg2"]);
  expect(sansOf(bookCandidates(BOOKS.hedgehog, ["g3", "e5", "Bg2", "d5"]))).toEqual(["d3"]);
  expect(sansOf(bookCandidates(BOOKS.aggressive, ["h4", "e5"]))).toEqual(["h5"]);
  expect(sansOf(bookCandidates(BOOKS.aggressive, ["e4", "a5", "d4"])).sort()).toEqual(["Ra6", "a4"]);
  expect(bookCandidates(BOOKS.hedgehog, ["e4", "g6", "d4", "Bg7", "Nf3", "d6", "Bc4", "e6", "O-O"])).toEqual([{ san: "b6", weight: 35 }]);
});

test("a system stops after a capture or a check, and once the bot leaves it", () => {
  expect(bookCandidates(BOOKS.hedgehog, ["e4", "g6", "d4", "Bg7", "Nf3", "d6", "Bc4", "e6", "Bxe6"])).toEqual([]);
  expect(bookCandidates(BOOKS.hedgehog, ["g3", "e5", "Bg2", "d5", "d3", "Bb4+"])).toEqual([]);
  expect(bookCandidates(BOOKS.hedgehog, ["g3", "e5", "Bg2", "d5", "d3", "Bb4+", "c3", "Ba5"])).toEqual([]);
  expect(bookCandidates(BOOKS.hedgehog, ["g3", "e5", "Nf3", "d5"])).toEqual([]);
});

test("a system never allows mate in one, and hangs material only where marked !", () => {
  expect(bookCandidates(parseTree("10 f3 g4"), ["f3", "e5"])).toEqual([]);
  expect(bookCandidates(parseTree("10 f3 g4!"), ["f3", "e5"])).toEqual([]);
  expect(bookCandidates(parseTree("10 e4 Bc4"), ["e4", "d5"])).toEqual([]);
  expect(bookCandidates(parseTree("10 e4 Bc4!"), ["e4", "d5"])).toEqual([{ san: "Bc4", weight: 10 }]);
  expect(bookCandidates(parseTree("10 e4 Nf3"), ["e4", "e5"])).toEqual([{ san: "Nf3", weight: 10 }]);
});

test("'*' answers any move, weight-0 moves are never played, and SANs come back as the rules write them", () => {
  const anything = bookCandidates(BOOKS.hedgehog, ["a3"]);
  expect(anything.map((c) => [c.san, c.weight])).toEqual([["g6", 35], ["e6", 15], ["g6", 15]]);
  expect(sansOf(bookCandidates(BOOKS.constrictor, ["e4", "c6"]))).toEqual(["d4"]);
  expect(bookCandidates(BOOKS.constrictor, ["a3"])).toEqual([]);
  expect(bookCandidates(parseTree("10 e4\n  0 f6\n    10 Qh5"), ["e4", "f6"])).toEqual([{ san: "Qh5+", weight: 10 }]);
  expect(bookMove(parseTree("10 e4"), [], 0.5)).toBe("e4");
  expect(bookMove(parseTree("10 e4"), ["e4"], 0.5)).toBeNull();
});

test("parseTree reads systems, '*' and weight 0, and rejects their misuse", () => {
  const book = parseTree("0 *\n  10 g6 Bg7! d6\n0 e4\n  5 c5");
  expect(book).toEqual([
    { san: "*", weight: 0, then: [], children: [{ san: "g6", weight: 10, then: [{ san: "Bg7", sacrifice: true }, { san: "d6", sacrifice: false }], children: [] }] },
    { san: "e4", weight: 0, then: [], children: [{ san: "c5", weight: 5, then: [], children: [] }] },
  ]);
  expect(() => parseTree("10 g3 Bg2\n  10 e5")).toThrow();
  expect(() => parseTree("10 *")).toThrow();
  expect(() => parseTree("0 * e4")).toThrow();
  expect(() => parseTree("10 g4! Bg2")).toThrow();
});
