import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { engine, stableOutput } from "./engine.js";

const fingerprint = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// Originally captured from 018a779 with Chapter=7; normalized without
// ponder from equivalent committed baseline be39b8d.
// Every depth's score, nodes, PV and bestmove are included;
// elapsed time, NPS and the retired ponder output hint are removed.
const searchFixtures = [
  ["rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", "b216cf05d8dd2271931d64800b742288b64faacfc564869b444359ca6f35834e"],
  ["r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1", "52330429569d7d97f2986a68b9fc9d463607a38875772665b0dfc5f5e686bdc0"],
  ["8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1", "db8d43b2b51ffb5ca79add96137766113d8e59e24e5508fb44289016030fc042"],
  ["r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1", "c7f984ca142f6bee3f25cb4321693d6be6882be38f4aea9f21308e1e773827a8"],
  ["rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8", "3e9281c22361441db6e57692273acb1e4b0fbe12924cae65cefc5fe62a58b155"],
  ["r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10", "d266cb22bedc44d7c87dda3662f83c6d65d1805b4da031f416ada9e524076baa"],
  ["r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4", "52778e44bbc7030419487ddb458f2457137e7ad11a216a2b06a15c5745dfa77b"],
  ["2rq1rk1/pp1bppbp/3p1np1/8/3NP3/1BN1BP2/PPPQ2PP/2KR3R w - - 0 12", "f4a4e5629f339627a0a1a1c70df84442611059e435eebafa86d64a96fa84ffbe"],
  ["8/8/1p1k4/p1p2p2/P1P2P2/1P1K4/8/8 w - - 0 1", "88ed5025f162b5b2113e381bedc57ee3c87034e79c5bfc33f82224e32976e33c"],
  ["6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1", "a3f7827f3445adf4802bb0867e650a5adabc6dbbb2d8560575cbf41d32bd3688"],
  ["r2q1rk1/ppp2ppp/2n1bn2/2bpp3/3PP3/2P2N2/PP1NBPPP/R1BQ1RK1 b - - 0 9", "6e34d30292bde54db8c13bccbacefca6d3073c192ec1fb703a9c9820ac29895e"],
  ["1k1r4/pp1b1R2/3q2pp/4p3/2B5/4Q3/PPP2B2/2K5 b - - 0 1", "6b68a795e8f369fed60fda0f794ffdddbf9c3d3544741fa5be4486bf8450e564"],
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
  [0, "63c8f1d96e4051c3c1dbffebf7febf4d9b4d6368ff69d798e3aa2285c6be5be2"],
  [42, "63567b9ae379212800a5317e6f2c3915edb3f9d4532887e5efd332371511654d"],
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

test("removed MultiPV option cannot change the original single-line search", () => {
  const e = engine();
  e.command("setoption name MultiPV value 3");
  e.command("go depth 3");
  expect(fingerprint(stableOutput(e.output))).toBe(searchFixtures[0][1]);
});

test("original depth-5 OpenBench signature", () => {
  const e = engine();
  e.command("setoption name Skill_Level value 3");
  e.command("bench 5");
  expect(e.output.at(-1)).toStartWith("1310439 nodes ");
  expect(e.read("skillLevel")).toBe(3);
});
