import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { engine, stableOutput } from "./engine.js";

const fingerprint = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// Captured from revision 018a779 with Chapter=7 before refactoring.
// Every depth's score, nodes, PV, bestmove and ponder are included;
// only machine-dependent elapsed time and NPS are removed.
const searchFixtures = [
  ["rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", "6b161cd2c3d2ca8f9dc24a1f188953aa723a234ec8a78d84752cc6b731ba664a"],
  ["r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1", "90e3a61dd560d0f6913d8aa03b83d703d70926cf959f0e0e3014543163186c15"],
  ["8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1", "6d889ebf83d387785c841ee46c02f81d5bcc84286b1428ed9238ef86feecbba7"],
  ["r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1", "8b4c59acda9b26cfecb63fbe8933f03e59e4eb0822663868aa9ed5ac38f89eef"],
  ["rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8", "1ff6d3b29f73331de0549ed93e4debd4d78ecac82271a357dccddabd23f615c8"],
  ["r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10", "2249c20db131d75967d58ddcb65e0e13b5196850102dada7176d91a6dd458be6"],
  ["r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4", "ab3d1805393fd344536d961a50c4a8676cd1d362031b34c585638993eefb7bf2"],
  ["2rq1rk1/pp1bppbp/3p1np1/8/3NP3/1BN1BP2/PPPQ2PP/2KR3R w - - 0 12", "51d8ca6b3c56645fc129b195d3c9168ae5914f17ff4c41b0757ff9d38bf3e315"],
  ["8/8/1p1k4/p1p2p2/P1P2P2/1P1K4/8/8 w - - 0 1", "8625a3f07ef6b316cecf2589ad072d48d3795f5b1103c36d8e12feeba6ddd4d8"],
  ["6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1", "a3f7827f3445adf4802bb0867e650a5adabc6dbbb2d8560575cbf41d32bd3688"],
  ["r2q1rk1/ppp2ppp/2n1bn2/2bpp3/3PP3/2P2N2/PP1NBPPP/R1BQ1RK1 b - - 0 9", "7de4754b227c18c4753531d327ad671dd5fb4e6dba880703160a291966e1e67f"],
  ["1k1r4/pp1b1R2/3q2pp/4p3/2B5/4Q3/PPP2B2/2K5 b - - 0 1", "7deadc5dbd40c610ff3534dc5b03aef7f72454175406980c1cb894689817db2c"],
];

for (const [fen, expected] of searchFixtures) {
  test(`original depth-3 transcript: ${fen}`, () => {
    const e = engine();
    e.command("position fen " + fen);
    const before = e.read("toFen()");
    e.command("go depth 3");
    expect(fingerprint(stableOutput(e.output))).toBe(expected);
    expect(e.read("toFen()")).toBe(before);
  });
}

for (const [seed, expected] of [
  [0, "bb30bbd464b92f3003810c82ab4e2cd1407c00cdb87f2b1b1a74fde77b8d1e33"],
  [42, "9b77fd7f2e3c80588472243f638b19bd60f7d8ca9240120e35fe42f07b426c7f"],
]) {
  test(`original transcripts at all ten skill levels, seed ${seed}`, () => {
    const e = engine(), transcripts = [];
    for (let level = 1; level <= 10; level++) {
      e.output.length = 0;
      e.command(`setoption name Skill_Seed value ${seed}`);
      e.command(`setoption name Skill_Level value ${level}`);
      e.command("position startpos moves e2e4 e7e5 g1f3");
      e.command("go depth 3");
      transcripts.push(stableOutput(e.output));
    }
    expect(fingerprint(transcripts)).toBe(expected);
  });
}

test("original three-line MultiPV transcript", () => {
  const e = engine();
  e.command("setoption name MultiPV value 3");
  e.command("go depth 3");
  expect(fingerprint(stableOutput(e.output))).toBe("328aea1c86d514d3d1f5bb5f0d6436c5cb9bcae4c9583fcb3926ef0ec15bd468");
});

test("original depth-5 OpenBench signature", () => {
  const e = engine();
  e.command("setoption name Skill_Level value 3");
  e.command("bench 5");
  expect(e.output.at(-1)).toStartWith("1310439 nodes ");
  expect(e.read("skillLevel")).toBe(3);
});
