/* Chess960 start positions, numbered 0..959 after Scharnagl (518 is the standard array). */
export const STANDARD_POSITION = 518;
export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/* White's back rank for position `n`, e.g. "RNBQKBNR" for 518. */
export function chess960Rank(n) {
  const row = Array(8).fill(null);
  const nth = (k, piece) => {
    const free = row.flatMap((p, i) => (p === null ? [i] : []));
    row[free[k]] = piece;
  };
  row[2 * (n % 4) + 1] = "B";                                    // light-squared bishop
  row[2 * (Math.floor(n / 4) % 4)] = "B";                        // dark-squared bishop
  const rest = Math.floor(n / 16);
  nth(rest % 6, "Q");
  const knights = [[0, 1], [0, 2], [0, 3], [0, 4], [1, 2], [1, 3], [1, 4], [2, 3], [2, 4], [3, 4]][Math.floor(rest / 6)];
  nth(knights[1], "N"); nth(knights[0], "N");    // place the higher index first so the lower one keeps its meaning
  nth(0, "R"); nth(0, "K"); nth(0, "R");
  return row.join("");
}

export function chess960Fen(n) {
  const white = chess960Rank(n);
  return `${white.toLowerCase()}/pppppppp/8/8/8/8/PPPPPPPP/${white} w KQkq - 0 1`;
}
