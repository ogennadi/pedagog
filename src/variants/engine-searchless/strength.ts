// Features for a searchless engine that aims at strength, not at looking human: the 81 concepts of
// concepts.ts (copied from engine-human) plus static checks of what the opponent can do after the move.
//
// "Searchless": no game tree. Each legal move is judged on its own, with static exchange
// evaluation (SEE) and one pass over the opponent's captures and checking moves after it - no
// minimax, no recursion. The added features:
//   NET          the material the move wins, minus what the opponent's best capture then wins
//                (SEE), in pawns: -3 or less, -2 to -1, 0, +1 to +2, +3 or more (5 bands)
//   WORSE_NET    how much worse that net is than the best net among the legal moves: 1-2, 3+
//   ALLOWS_MATE  the opponent can mate in one after the move
//   THREAT_WINS  our best capture, if it were our move again, would win 1-2 or 3+ pawns
// An even trade nets 0, and a piece that already hangs shows in every move's net, so WORSE_NET
// singles out the moves that make things worse.

import { CONCEPTS, cheapestAttackerSquare, conceptFeatures, see } from "./concepts.ts";
import { VALUE, chess } from "./features.ts";
import type { FeatureSet, Sample } from "./features.ts";

export const REPLY_NAMES = [
  "net after their best capture: -3 or less",
  "net after their best capture: -2 to -1",
  "net after their best capture: 0",
  "net after their best capture: +1 to +2",
  "net after their best capture: +3 or more",
  "net 1-2 worse than the best move's",
  "net 3+ worse than the best move's",
  "allows mate in one",
  "our best capture next move would win 1-2 (SEE)",
  "our best capture next move would win 3+ (SEE)",
];
const NET = CONCEPTS.length;
export const WORSE_NET_3 = NET + 6, ALLOWS_MATE = NET + 7;
const WORSE_NET_1 = NET + 5, THREAT_WINS_1 = NET + 8, THREAT_WINS_3 = NET + 9;

/* Our material minus theirs on `board`, in pawns, for colour `us`. */
function material(board: Int8Array, us: number): number {
  let sum = 0;
  for (let s = 0; s < 128; s++) {
    const p = board[s];
    if ((s & 0x88) === 0 && p !== 0 && (p & 7) !== 6) sum += (p >> 3 === us ? 1 : -1) * VALUE[p & 7];
  }
  return sum;
}

/* The most that colour `by` wins by SEE with one capture on `board`, 0 if nothing. A king only
   captures an undefended piece. */
export function bestCaptureGain(board: Int8Array, by: number): number {
  let best = 0;
  for (let s = 0; s < 128; s++) {
    const p = board[s];
    if ((s & 0x88) !== 0 || p === 0 || p >> 3 === by || (p & 7) === 6) continue;
    const from = cheapestAttackerSquare(board, s, by);
    if (from < 0) continue;
    const attacker = board[from] & 7;
    if (attacker === 6 && cheapestAttackerSquare(board, s, 1 - by) >= 0) continue;
    best = Math.max(best, see(board, from, s, attacker, -1));
  }
  return best;
}

/* Can the side to move in `pos` mate in one? */
export function canMateInOne(pos: any): boolean {
  return (chess.legalMoves(pos) as number[]).some((move) => {
    const next = chess.makeLegalMove(pos, move);
    return chess.inCheck(next) && chess.legalMoves(next).length === 0;
  });
}

/* The concepts of the sample's legal moves plus the reply features. */
function strengthFeatures(sample: Sample): { moves: number[]; features: number[][] } {
  const { moves, features } = conceptFeatures(sample);
  const us = sample.pos.sideToMove;
  const before = material(sample.pos.board, us);
  const replies = moves.map((move) => {
    const after = chess.makeLegalMove(sample.pos, move);
    const net = material(after.board, us) - before - bestCaptureGain(after.board, 1 - us);
    const mates = !(chess.inCheck(after) && chess.legalMoves(after).length === 0) && canMateInOne(after);
    return { net, mates, threat: bestCaptureGain(after.board, us) };
  });
  const bestNet = Math.max(...replies.map((r) => r.net));
  return {
    moves,
    features: replies.map(({ net, mates, threat }, i) => {
      const extra = [NET + (net <= -3 ? 0 : net < 0 ? 1 : net === 0 ? 2 : net < 3 ? 3 : 4)];
      if (bestNet - net >= 3) extra.push(WORSE_NET_3);
      else if (bestNet - net >= 1) extra.push(WORSE_NET_1);
      if (mates) extra.push(ALLOWS_MATE);
      if (threat >= 3) extra.push(THREAT_WINS_3);
      else if (threat >= 1) extra.push(THREAT_WINS_1);
      return [...features[i], ...extra];
    }),
  };
}

/** The concepts and the reply features. */
export const STRENGTH_SET: FeatureSet = {
  count: CONCEPTS.length + REPLY_NAMES.length,
  name: (k) => (k < CONCEPTS.length ? CONCEPTS[k].name : REPLY_NAMES[k - CONCEPTS.length]),
  featurize: strengthFeatures,
};
