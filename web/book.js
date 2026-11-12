/* The web app's opening book: shallow and wide, so the bots start games many different ways
   and the engine's own style takes over early. Standard chess only. Levels 2 and up use it;
   level 1 stays a random mover.

   TREE is a weighted move tree in plain text, one move per line:

       weight SAN

   Indentation (two spaces per ply) gives the depth, so a line's children are the replies to
   it. Weights are relative among siblings (they need not sum to 100). A bot in book picks one
   child of the current position at random by weight; once the game leaves the tree, or reaches
   its last ply (at most MAX_PLIES), the engine plays. "//" starts a comment.

   OPENINGS only names openings: the longest line the game has followed in full is shown. */
export const MAX_PLIES = 6;

export const TREE = `
30 e4
  26 e5
    55 Nf3
      60 Nc6
        30 Bb5
          40 a6
          30 Nf6
          10 d6
          10 f5           // Schliemann
          10 Nd4          // Bird's Defence
        30 Bc4
          50 Bc5
          40 Nf6
          10 Be7          // Hungarian
        12 d4
          100 exd4
        8 Nc3
          100 Nf6
        6 c3              // Ponziani
          60 Nf6
          40 d5
      15 Nf6              // Petrov
        70 Nxe5
          100 d6
        30 d4
          60 Nxe4
          40 exd4
      10 d6               // Philidor
        100 d4
          60 exd4
          40 Nf6
      4 f5                // Latvian
        100 Nxe5
          100 Qf6
      4 d5                // Elephant
        100 exd5
          100 e4
    12 f4                 // King's Gambit
      65 exf4
        60 Nf3
          70 g5
          30 d6
        40 Bc4
          100 Nf6
      20 d5               // Falkbeer
        100 exd5
          100 e4
      15 Bc5
        100 Nf3
          100 d6
    10 Nc3                // Vienna
      60 Nf6
        50 Bc4
          100 Nxe4
        30 f4
          100 d5
        20 g3
          100 d5
      40 Nc6
        50 Bc4
          100 Nf6
        50 f4
          100 exf4
    8 Bc4
      70 Nf6
        100 d3
          100 c6
      30 Bc5
        100 Nf3
          100 d6
    6 d4
      100 exd4
        50 c3             // Danish
          100 dxc3
        50 Qxd4
          100 Nc6
    3 Qh5                 // Parham
      100 Nc6
        100 Bc4
          100 g6
  21 c5
    60 Nf3
      40 d6
        80 d4
          100 cxd4
        20 Bb5+
          70 Bd7
          30 Nd7
      30 Nc6
        65 d4
          100 cxd4
        35 Bb5
          60 g6
          40 e6
      30 e6
        100 d4
          100 cxd4
    12 Nc3
      100 Nc6
        100 g3
          100 g6
    10 c3                 // Alapin
      60 Nf6
        100 e5
          100 Nd5
      40 d5
        100 exd5
          100 Qxd5
    10 d4                 // Smith-Morra
      100 cxd4
        100 c3
          60 dxc3
          40 Nf6
    5 f4                  // Grand Prix
      100 Nc6
        100 Nf3
          100 g6
    3 b4                  // Wing Gambit
      100 cxb4
        100 a3
          100 bxa3
  9 e6
    85 d4
      100 d5
        45 Nc3
          50 Bb4
          30 Nf6
          20 dxe4
        25 e5
          100 c5
        20 Nd2
          60 Nf6
          40 c5
        10 exd5
          100 exd5
    15 d3
      100 d5
        100 Nd2
          100 Nf6
  8 c6
    80 d4
      100 d5
        40 Nc3
          100 dxe4
        30 e5
          100 Bf5
        15 exd5
          100 cxd5
        15 f3             // Fantasy
          100 e6
    20 Nc3
      100 d5
        100 Nf3
          100 Bg4
  4 d5
    100 exd5
      65 Qxd5
        100 Nc3
          70 Qa5
          30 Qd6
      35 Nf6
        100 d4
          100 Nxd5
  3 Nf6                   // Alekhine
    80 e5
      100 Nd5
        100 d4
          100 d6
    20 Nc3
      100 d5
        100 exd5
          100 Nxd5
  3 d6
    100 d4
      100 Nf6
        100 Nc3
          100 g6
  3 g6
    100 d4
      100 Bg7
        100 Nc3
          100 d6
  1 Nc6
    60 d4
      100 d5
        100 Nc3
          100 dxe4
    40 Nf3
      100 d6
        100 d4
          100 Nf6
  1 b6
    100 d4
      100 Bb7
        100 Bd3
          100 e6
  2 a6
    100 d4
      100 b5
        100 Nf3
          100 Bb7
  5 h5                    // rim: ...h5, ...h4
    100 d4
      100 h4
        60 Nf3
          60 d6
          40 Rh6
        40 h3
          100 d5
  4 a5                    // rim: ...a5, ...a4
    100 d4
      100 a4
        60 Nf3
          50 Ra5
          50 e6
        40 Nc3
          100 e6
  4 g5                    // Borg
    100 d4
      100 Bg7
        100 Bxg5
          100 c5
  3 b5                    // Polish Defence
    100 Bxb5
      100 Bb7
        100 Nc3
          100 e6
  1 Na6
    100 d4
      100 c6
  2 Nh6
    100 d4
      100 g6
25 d4
  30 Nf6
    55 c4
      35 e6
        50 Nf3
          45 d5
          35 b6
          20 Bb4+
        40 Nc3
          100 Bb4
        10 g3
          100 d5
      35 g6
        75 Nc3
          60 Bg7
          40 d5
        25 Nf3
          100 Bg7
      12 c5
        100 d5
          60 e6
          40 b5
      8 e5                // Budapest
        100 dxe5
          80 Ng4
          20 Ne4
      5 d6
        100 Nc3
          100 Nbd7
    25 Nf3
      50 g6
        100 Bf4
          100 Bg7
      30 e6
        60 Bg5
          100 c5
        40 e3
          100 b6
      20 d5
        100 Bf4
          100 c5
    12 Bg5                // Trompowsky
      60 Ne4
        100 Bf4
          100 c5
      40 e6
        100 e4
          100 h6
    8 Bf4
      100 d5
        100 e3
          100 c5
  29 d5
    65 c4
      40 e6
        70 Nc3
          100 Nf6
        30 Nf3
          100 Nf6
      30 c6
        100 Nf3
          70 Nf6
          30 dxc4
      15 dxc4
        100 Nf3
          100 Nf6
      8 e5                // Albin
        100 dxe5
          100 d4
      7 Nc6               // Chigorin
        100 Nc3
          100 dxc4
    20 Nf3
      100 Nf6
        60 Bf4
          100 e6
        40 e3
          100 e6
    10 Bf4
      100 Nf6
        100 e3
          100 c5
    5 e4                  // Blackmar-Diemer
      100 dxe4
        100 Nc3
          100 Nf6
  7 f5                    // Dutch
    60 c4
      100 Nf6
        100 g3
          60 g6
          40 e6
    25 g3
      100 Nf6
        100 Bg2
          100 g6
    15 e4                 // Staunton
      100 fxe4
        100 Nc3
          100 Nf6
  4 e6
    100 c4
      70 Nf6
        100 Nc3
          100 Bb4
      30 b6
        100 e4
          100 Bb7
  4 g6
    100 c4
      100 Bg7
        100 Nc3
          100 d6
  3 e5                    // Englund
    100 dxe5
      100 Nc6
        100 Nf3
          100 Qe7
  2 c5
    100 d5
      100 e5
        100 e4
          100 d6
  1 Nc6
    100 d5
      100 Ne5
        100 e4
          100 Ng6
  4 a5                    // rim: ...a5, ...a4
    100 c4
      100 a4
        100 Nc3
          50 Ra5
          50 e6
  5 h5                    // rim: ...h5, ...h4
    100 c4
      100 h4
        100 Nc3
          100 Rh5
  4 g5                    // Borg
    100 Bxg5
      100 c5
  3 b5                    // Polish Defence
    100 e4
      100 Bb7
        100 Bd3
          100 e6
  2 Na6
    100 e4
      100 c6
  2 Nh6
    100 e4
      100 g6
8 Nf3
  35 d5
    40 g3
      100 Nf6
        100 Bg2
          100 e6
    35 c4
      60 e6
      25 d4
      15 c6
    25 d4
      100 Nf6
  32 Nf6
    50 c4
      50 g6
      50 e6
    50 g3
      100 g6
  12 c5
    100 c4
      100 Nc6
  6 g5
    100 Nxg5
      100 e5
  5 b5
    100 e4
      100 a6
  5 a5
    100 d4
      100 a4
  5 h5
    100 d4
      100 h4
8 c4
  28 e5
    100 Nc3
      60 Nf6
        100 Nf3
          100 Nc6
      40 Nc6
        100 g3
          100 g6
  24 Nf6
    100 Nc3
      50 e5
      30 g6
      20 e6
  20 c5
    100 Nc3
      100 Nc6
        100 g3
          100 g6
  8 e6
    100 Nf3
      100 d5
  6 g5
    100 d4
      100 Bg7
  5 b5                    // Jaenisch Gambit
    100 cxb5
      100 Bb7
  5 a5
    100 Nc3
      100 a4
  5 h5
    100 Nc3
      100 h4
2 g3
  100 d5
    100 Bg2
      100 Nf6
  15 g5
  13 h5
2 b3
  100 e5
    100 Bb2
      100 Nc6
  15 a5
  13 h5
2 f4                      // Bird
  70 d5
    100 Nf3
      100 Nf6
  30 e5                   // From's Gambit
    100 fxe5
      100 d6
  15 g5
  13 h5
2 Nc3
  100 d5
    100 e4
      100 d4
        100 Nce2
          100 e5
  15 a5
  13 h5
3 b4
  100 e5
    100 Bb2
      100 Bxb4
        100 Bxe5
          100 Nf6
  15 a5
  13 h5
1 e3
  100 d5
    100 d4
      100 Nf6
  15 g5
  13 h5
5 g4
  70 d5
    100 Bg2
      100 Bxg4
        100 c4
          100 c6
  30 e5
    100 Bg2
      100 d5
  15 h5
  13 a5
5 h4                      // rim: h4, h5
  50 e5
    100 h5
      60 d5
        100 h6
          60 gxh6
          40 g6
      40 Nf6
  30 d5
    100 h5
      100 Nf6
  20 Nf6
    100 h5
      100 d5
  15 g5
  13 a5
4 a4                      // rim: a4, a5
  50 e5
    100 a5
      100 d5
        100 a6
          50 Nxa6
          50 bxa6
  30 d5
    100 a5
      100 e5
  20 Nf6
    100 a5
      100 d5
  15 b5
  13 h5
3 Na3
  60 e5
    100 Nc4
      100 Nc6
  40 d5
    100 c4
      100 e6
  15 h5
  13 a5
2 Nh3                     // Amar
  60 d5
    100 g3
      100 e5
  40 e5
    100 g3
      100 d5
  15 g5
  13 a5
`;

export const OPENINGS = [
  // ---- Families, named as soon as they are reached
  { eco: "B00", name: "King's Pawn Opening", moves: "e4" },
  { eco: "A40", name: "Queen's Pawn Opening", moves: "d4" },
  { eco: "C20", name: "King's Pawn Game", moves: "e4 e5" },
  { eco: "C40", name: "King's Knight Opening", moves: "e4 e5 Nf3" },
  { eco: "C44", name: "King's Pawn Game", moves: "e4 e5 Nf3 Nc6" },
  { eco: "C50", name: "Italian Game", moves: "e4 e5 Nf3 Nc6 Bc4" },
  { eco: "C60", name: "Ruy Lopez, Schliemann Defence", moves: "e4 e5 Nf3 Nc6 Bb5 f5" },
  { eco: "C61", name: "Ruy Lopez, Bird's Defence", moves: "e4 e5 Nf3 Nc6 Bb5 Nd4" },
  { eco: "C50", name: "Italian Game, Hungarian Defence", moves: "e4 e5 Nf3 Nc6 Bc4 Be7" },
  { eco: "C44", name: "Scotch Game", moves: "e4 e5 Nf3 Nc6 d4" },
  { eco: "C42", name: "Petrov Defence", moves: "e4 e5 Nf3 Nf6" },
  { eco: "C41", name: "Philidor Defence", moves: "e4 e5 Nf3 d6" },
  { eco: "C30", name: "King's Gambit", moves: "e4 e5 f4" },
  { eco: "C33", name: "King's Gambit Accepted", moves: "e4 e5 f4 exf4" },
  { eco: "C30", name: "King's Gambit Declined, Classical", moves: "e4 e5 f4 Bc5" },
  { eco: "C25", name: "Vienna Game", moves: "e4 e5 Nc3" },
  { eco: "C23", name: "Bishop's Opening", moves: "e4 e5 Bc4" },
  { eco: "C21", name: "Centre Game", moves: "e4 e5 d4 exd4" },
  { eco: "C20", name: "Parham Attack", moves: "e4 e5 Qh5" },
  { eco: "B20", name: "Sicilian Defence", moves: "e4 c5" },
  { eco: "B23", name: "Sicilian Defence, Closed", moves: "e4 c5 Nc3" },
  { eco: "B22", name: "Sicilian Defence, Alapin", moves: "e4 c5 c3" },
  { eco: "B21", name: "Sicilian Defence, Grand Prix Attack", moves: "e4 c5 f4" },
  { eco: "B20", name: "Sicilian Defence, Wing Gambit", moves: "e4 c5 b4" },
  { eco: "C00", name: "French Defence", moves: "e4 e6" },
  { eco: "B10", name: "Caro-Kann Defence", moves: "e4 c6" },
  { eco: "B01", name: "Scandinavian Defence", moves: "e4 d5" },
  { eco: "B02", name: "Alekhine's Defence", moves: "e4 Nf6" },
  { eco: "B07", name: "Pirc Defence", moves: "e4 d6" },
  { eco: "B06", name: "Modern Defence", moves: "e4 g6" },
  { eco: "B00", name: "Nimzowitsch Defence", moves: "e4 Nc6" },
  { eco: "B00", name: "Owen's Defence", moves: "e4 b6" },
  { eco: "B00", name: "St. George Defence", moves: "e4 a6" },
  { eco: "B00", name: "Goldsmith Defence", moves: "e4 h5" },
  { eco: "B00", name: "Corn Stalk Defence", moves: "e4 a5" },
  { eco: "A45", name: "Indian Defence", moves: "d4 Nf6" },
  { eco: "E00", name: "Indian Defence, East Indian", moves: "d4 Nf6 c4 e6" },
  { eco: "E60", name: "King's Indian Defence", moves: "d4 Nf6 c4 g6" },
  { eco: "D80", name: "Grünfeld Defence", moves: "d4 Nf6 c4 g6 Nc3 d5" },
  { eco: "E20", name: "Nimzo-Indian Defence", moves: "d4 Nf6 c4 e6 Nc3 Bb4" },
  { eco: "E12", name: "Queen's Indian Defence", moves: "d4 Nf6 c4 e6 Nf3 b6" },
  { eco: "E11", name: "Bogo-Indian Defence", moves: "d4 Nf6 c4 e6 Nf3 Bb4+" },
  { eco: "A56", name: "Benoni Defence", moves: "d4 Nf6 c4 c5" },
  { eco: "A51", name: "Budapest Gambit", moves: "d4 Nf6 c4 e5" },
  { eco: "A53", name: "Old Indian Defence", moves: "d4 Nf6 c4 d6" },
  { eco: "A45", name: "Trompowsky Attack", moves: "d4 Nf6 Bg5" },
  { eco: "A45", name: "London System", moves: "d4 Nf6 Bf4" },
  { eco: "D00", name: "Queen's Pawn Game", moves: "d4 d5" },
  { eco: "D06", name: "Queen's Gambit", moves: "d4 d5 c4" },
  { eco: "D30", name: "Queen's Gambit Declined", moves: "d4 d5 c4 e6" },
  { eco: "D10", name: "Slav Defence", moves: "d4 d5 c4 c6" },
  { eco: "D20", name: "Queen's Gambit Accepted", moves: "d4 d5 c4 dxc4" },
  { eco: "D02", name: "London System", moves: "d4 d5 Bf4" },
  { eco: "A80", name: "Dutch Defence", moves: "d4 f5" },
  { eco: "A82", name: "Dutch Defence, Staunton Gambit", moves: "d4 f5 e4" },
  { eco: "A40", name: "Horwitz Defence", moves: "d4 e6" },
  { eco: "A40", name: "English Defence", moves: "d4 e6 c4 b6" },
  { eco: "A40", name: "Modern Defence", moves: "d4 g6" },
  { eco: "A43", name: "Old Benoni Defence", moves: "d4 c5" },
  { eco: "A40", name: "Mikenas Defence", moves: "d4 Nc6" },
  { eco: "A04", name: "Zukertort Opening", moves: "Nf3" },
  { eco: "A10", name: "English Opening", moves: "c4" },
  { eco: "A20", name: "English Opening, King's English", moves: "c4 e5" },
  { eco: "A30", name: "English Opening, Symmetrical", moves: "c4 c5" },
  { eco: "A00", name: "Hungarian Opening", moves: "g3" },
  { eco: "A01", name: "Nimzo-Larsen Attack", moves: "b3" },
  { eco: "A02", name: "Bird's Opening", moves: "f4" },
  { eco: "A02", name: "Bird's Opening, From's Gambit", moves: "f4 e5" },
  { eco: "A00", name: "Dunst Opening", moves: "Nc3" },
  { eco: "A00", name: "Kádas Opening", moves: "h4" },
  { eco: "A00", name: "Ware Opening", moves: "a4" },
  { eco: "A00", name: "Sodium Attack", moves: "Na3" },
  { eco: "A00", name: "Amar Opening", moves: "Nh3" },
  { eco: "A00", name: "Grob Opening", moves: "g4" },
  { eco: "A00", name: "Polish Opening", moves: "b4" },
  { eco: "B00", name: "Borg Defence", moves: "e4 g5" },
  { eco: "B00", name: "Polish Defence", moves: "e4 b5" },
  { eco: "B00", name: "Lemming Defence", moves: "e4 Na6" },
  { eco: "A40", name: "Polish Defence", moves: "d4 b5" },
  { eco: "A10", name: "English Opening, Jaenisch Gambit", moves: "c4 b5" },
  // ---- 1.e4 e5
  { eco: "C60", name: "Ruy Lopez", moves: "e4 e5 Nf3 Nc6 Bb5" },
  { eco: "C65", name: "Ruy Lopez, Berlin Defence", moves: "e4 e5 Nf3 Nc6 Bb5 Nf6 O-O Nxe4 d4 Nd6 Bxc6 dxc6 dxe5 Nf5" },
  { eco: "C68", name: "Ruy Lopez, Exchange Variation", moves: "e4 e5 Nf3 Nc6 Bb5 a6 Bxc6 dxc6 O-O" },
  { eco: "C84", name: "Ruy Lopez, Closed", moves: "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O" },
  { eco: "C50", name: "Italian Game, Giuoco Piano", moves: "e4 e5 Nf3 Nc6 Bc4 Bc5 d3 Nf6 c3 d6" },
  { eco: "C53", name: "Italian Game, Giuoco Piano, Centre Attack", moves: "e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d4 exd4 cxd4 Bb4+" },
  { eco: "C55", name: "Two Knights Defence", moves: "e4 e5 Nf3 Nc6 Bc4 Nf6 d3 Be7 O-O O-O" },
  { eco: "C58", name: "Two Knights Defence, Main Line", moves: "e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5 d5 exd5 Na5 Bb5+ c6 dxc6 bxc6 Be2" },
  { eco: "C45", name: "Scotch Game", moves: "e4 e5 Nf3 Nc6 d4 exd4 Nxd4 Bc5 Be3 Qf6 c3 Nge7" },
  { eco: "C44", name: "Scotch Gambit", moves: "e4 e5 Nf3 Nc6 d4 exd4 Bc4 Nf6 e5 d5" },
  { eco: "C42", name: "Petrov Defence", moves: "e4 e5 Nf3 Nf6 Nxe5 d6 Nf3 Nxe4 d4 d5 Bd3" },
  { eco: "C46", name: "Four Knights Game", moves: "e4 e5 Nf3 Nc6 Nc3 Nf6 Bb5 Bb4 O-O O-O d3 d6" },
  { eco: "C47", name: "Four Knights, Scotch Variation", moves: "e4 e5 Nf3 Nc6 Nc3 Nf6 d4 exd4 Nxd4 Bb4 Nxc6 bxc6" },
  { eco: "C26", name: "Vienna Game", moves: "e4 e5 Nc3 Nf6 Bc4 Nxe4 Qh5 Nd6 Bb3 Nc6" },
  { eco: "C41", name: "Philidor Defence", moves: "e4 e5 Nf3 d6 d4 Nf6 Nc3 Nbd7 Bc4 Be7 O-O O-O" },
  { eco: "C24", name: "Bishop's Opening", moves: "e4 e5 Bc4 Nf6 d3 c6 Nf3 d5" },
  // ---- Sicilian
  { eco: "B90", name: "Sicilian Defence, Najdorf", moves: "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Be3 e5 Nb3 Be6" },
  { eco: "B97", name: "Sicilian Defence, Najdorf, Poisoned Pawn", moves: "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Bg5 e6 f4 Qb6" },
  { eco: "B33", name: "Sicilian Defence, Sveshnikov", moves: "e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 Nf6 Nc3 e5 Ndb5 d6 Bg5 a6 Na3 b5" },
  { eco: "B76", name: "Sicilian Defence, Dragon, Yugoslav Attack", moves: "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 g6 Be3 Bg7 f3 O-O Qd2 Nc6" },
  { eco: "B35", name: "Sicilian Defence, Accelerated Dragon", moves: "e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 g6 Nc3 Bg7 Be3 Nf6 Bc4" },
  { eco: "B47", name: "Sicilian Defence, Taimanov", moves: "e4 c5 Nf3 e6 d4 cxd4 Nxd4 Nc6 Nc3 Qc7 Be3 a6" },
  { eco: "B42", name: "Sicilian Defence, Kan", moves: "e4 c5 Nf3 e6 d4 cxd4 Nxd4 a6 Bd3 Nf6 O-O" },
  { eco: "B80", name: "Sicilian Defence, Scheveningen", moves: "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 e6 Be2 Be7 O-O O-O" },
  { eco: "B57", name: "Sicilian Defence, Classical", moves: "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 Nc6 Bc4 e6" },
  { eco: "B22", name: "Sicilian Defence, Alapin", moves: "e4 c5 c3 Nf6 e5 Nd5 d4 cxd4 Nf3 Nc6 cxd4 d6" },
  { eco: "B23", name: "Sicilian Defence, Closed", moves: "e4 c5 Nc3 Nc6 g3 g6 Bg2 Bg7 d3 d6" },
  { eco: "B51", name: "Sicilian Defence, Moscow Variation", moves: "e4 c5 Nf3 d6 Bb5+ Bd7 Bxd7+ Qxd7 O-O Nc6" },
  { eco: "B31", name: "Sicilian Defence, Rossolimo", moves: "e4 c5 Nf3 Nc6 Bb5 g6 O-O Bg7 Re1 e5" },
  // ---- French
  { eco: "C11", name: "French Defence, Classical", moves: "e4 e6 d4 d5 Nc3 Nf6 Bg5 Be7 e5 Nfd7 Bxe7 Qxe7" },
  { eco: "C18", name: "French Defence, Winawer", moves: "e4 e6 d4 d5 Nc3 Bb4 e5 c5 a3 Bxc3+ bxc3 Ne7" },
  { eco: "C02", name: "French Defence, Advance Variation", moves: "e4 e6 d4 d5 e5 c5 c3 Nc6 Nf3 Qb6" },
  { eco: "C05", name: "French Defence, Tarrasch", moves: "e4 e6 d4 d5 Nd2 Nf6 e5 Nfd7 Bd3 c5 c3 Nc6" },
  { eco: "C10", name: "French Defence, Rubinstein", moves: "e4 e6 d4 d5 Nc3 dxe4 Nxe4 Nd7 Nf3 Ngf6" },
  { eco: "C01", name: "French Defence, Exchange Variation", moves: "e4 e6 d4 d5 exd5 exd5 Nf3 Nf6 Bd3 Bd6" },
  // ---- Caro-Kann
  { eco: "B18", name: "Caro-Kann Defence, Classical", moves: "e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5 Ng3 Bg6 h4 h6 Nf3 Nd7" },
  { eco: "B12", name: "Caro-Kann Defence, Advance Variation", moves: "e4 c6 d4 d5 e5 Bf5 Nf3 e6 Be2 c5" },
  { eco: "B13", name: "Caro-Kann Defence, Exchange Variation", moves: "e4 c6 d4 d5 exd5 cxd5 Bd3 Nc6 c3 Nf6 Bf4" },
  { eco: "B14", name: "Caro-Kann Defence, Panov Attack", moves: "e4 c6 d4 d5 exd5 cxd5 c4 Nf6 Nc3 e6 Nf3" },
  // ---- Other replies to 1.e4
  { eco: "B01", name: "Scandinavian Defence", moves: "e4 d5 exd5 Qxd5 Nc3 Qa5 d4 Nf6 Nf3 c6 Bc4 Bf5" },
  { eco: "B01", name: "Scandinavian Defence, Modern", moves: "e4 d5 exd5 Nf6 d4 Nxd5 Nf3 Bg4 Be2 e6" },
  { eco: "B04", name: "Alekhine's Defence, Modern", moves: "e4 Nf6 e5 Nd5 d4 d6 Nf3 Bg4 Be2 e6" },
  { eco: "B07", name: "Pirc Defence", moves: "e4 d6 d4 Nf6 Nc3 g6 Nf3 Bg7 Be2 O-O O-O" },
  { eco: "B06", name: "Modern Defence", moves: "e4 g6 d4 Bg7 Nc3 d6 f4 Nf6 Nf3 O-O" },
  // ---- 1.d4 d5
  { eco: "D37", name: "Queen's Gambit Declined", moves: "d4 d5 c4 e6 Nc3 Nf6 Nf3 Be7 Bf4 O-O e3 c5" },
  { eco: "D35", name: "Queen's Gambit Declined, Exchange Variation", moves: "d4 d5 c4 e6 Nc3 Nf6 cxd5 exd5 Bg5 c6 e3 Be7 Bd3" },
  { eco: "D27", name: "Queen's Gambit Accepted, Classical", moves: "d4 d5 c4 dxc4 Nf3 Nf6 e3 e6 Bxc4 c5 O-O a6" },
  { eco: "D15", name: "Slav Defence", moves: "d4 d5 c4 c6 Nf3 Nf6 Nc3 dxc4 a4 Bf5 e3 e6 Bxc4 Bb4" },
  { eco: "D45", name: "Semi-Slav Defence", moves: "d4 d5 c4 c6 Nf3 Nf6 Nc3 e6 e3 Nbd7 Bd3 dxc4 Bxc4 b5" },
  { eco: "D44", name: "Semi-Slav Defence, Botvinnik", moves: "d4 d5 c4 c6 Nf3 Nf6 Nc3 e6 Bg5 dxc4 e4 b5 e5 h6" },
  { eco: "D34", name: "Tarrasch Defence", moves: "d4 d5 c4 e6 Nc3 c5 cxd5 exd5 Nf3 Nc6 g3 Nf6 Bg2 Be7 O-O O-O" },
  { eco: "D02", name: "London System", moves: "d4 d5 Nf3 Nf6 Bf4 e6 e3 c5 c3 Nc6 Nbd2 Bd6 Bg3" },
  { eco: "A46", name: "London System vs the Indian set-up", moves: "d4 Nf6 Nf3 g6 Bf4 Bg7 e3 O-O Be2 d6 h3" },
  { eco: "D04", name: "Colle System", moves: "d4 d5 Nf3 Nf6 e3 e6 Bd3 c5 c3 Nc6 Nbd2 Bd6 O-O O-O" },
  { eco: "D03", name: "Torre Attack", moves: "d4 Nf6 Nf3 e6 Bg5 c5 e3 Be7 Nbd2 b6 c3 Bb7 Bd3" },
  // ---- Indian defences and flank
  { eco: "E97", name: "King's Indian Defence, Classical, Mar del Plata", moves: "d4 Nf6 c4 g6 Nc3 Bg7 e4 d6 Nf3 O-O Be2 e5 O-O Nc6 d5 Ne7" },
  { eco: "E76", name: "King's Indian Defence, Four Pawns Attack", moves: "d4 Nf6 c4 g6 Nc3 Bg7 e4 d6 f4 O-O Nf3 c5" },
  { eco: "E62", name: "King's Indian Defence, Fianchetto Variation", moves: "d4 Nf6 c4 g6 Nf3 Bg7 g3 O-O Bg2 d6 O-O Nc6" },
  { eco: "D85", name: "Grünfeld Defence, Exchange Variation", moves: "d4 Nf6 c4 g6 Nc3 d5 cxd5 Nxd5 e4 Nxc3 bxc3 Bg7 Nf3 c5" },
  { eco: "E32", name: "Nimzo-Indian Defence, Classical", moves: "d4 Nf6 c4 e6 Nc3 Bb4 Qc2 O-O a3 Bxc3+ Qxc3 b6" },
  { eco: "E41", name: "Nimzo-Indian Defence, Rubinstein", moves: "d4 Nf6 c4 e6 Nc3 Bb4 e3 O-O Bd3 d5 Nf3 c5 O-O Nc6" },
  { eco: "E12", name: "Queen's Indian Defence", moves: "d4 Nf6 c4 e6 Nf3 b6 g3 Ba6 b3 Bb4+ Bd2 Be7" },
  { eco: "E11", name: "Bogo-Indian Defence", moves: "d4 Nf6 c4 e6 Nf3 Bb4+ Bd2 Qe7 g3 Nc6 Nc3 Bxc3 Bxc3 Ne4" },
  { eco: "E04", name: "Catalan Opening, Open", moves: "d4 Nf6 c4 e6 g3 d5 Bg2 dxc4 Nf3 Be7 O-O O-O Qc2 a6" },
  { eco: "E06", name: "Catalan Opening, Closed", moves: "d4 Nf6 c4 e6 g3 d5 Bg2 Be7 Nf3 O-O O-O dxc4 Qc2 a6" },
  { eco: "A70", name: "Modern Benoni", moves: "d4 Nf6 c4 c5 d5 e6 Nc3 exd5 cxd5 d6 e4 g6 Nf3 Bg7 h3 O-O Bd3" },
  { eco: "A58", name: "Benko Gambit, Accepted", moves: "d4 Nf6 c4 c5 d5 b5 cxb5 a6 bxa6 g6 Nc3 Bxa6" },
  { eco: "A87", name: "Dutch Defence, Leningrad", moves: "d4 f5 c4 Nf6 g3 g6 Bg2 Bg7 Nf3 O-O O-O d6" },
  { eco: "A90", name: "Dutch Defence, Stonewall", moves: "d4 f5 c4 Nf6 g3 e6 Bg2 d5 Nf3 c6 O-O Bd6" },
  { eco: "A29", name: "English Opening, Four Knights", moves: "c4 e5 Nc3 Nf6 Nf3 Nc6 g3 d5 cxd5 Nxd5 Bg2 Nb6 O-O Be7" },
  { eco: "A36", name: "English Opening, Symmetrical, Botvinnik System", moves: "c4 c5 Nc3 Nc6 g3 g6 Bg2 Bg7 e4 d6 Nge2" },
  { eco: "A34", name: "English Opening, Symmetrical", moves: "c4 c5 Nf3 Nf6 Nc3 d5 cxd5 Nxd5 g3 Nc6 Bg2 Nc7" },
  { eco: "A13", name: "English Opening, Agincourt", moves: "c4 e6 Nf3 d5 g3 Nf6 Bg2 Be7 O-O O-O" },
  { eco: "A09", name: "Réti Opening", moves: "Nf3 d5 c4 d4 b4 g5 Bb2 Bg7 e3" },
  { eco: "A07", name: "King's Indian Attack", moves: "Nf3 d5 g3 Nf6 Bg2 e6 O-O Be7 d3 O-O Nbd2 c5 e4" },
  // ---- Offbeat: gambits, sidelines and the first moves nobody expects
  { eco: "C33", name: "King's Gambit Accepted, Bishop's Gambit", moves: "e4 e5 f4 exf4 Bc4 Nf6 Nc3 c6" },
  { eco: "C39", name: "King's Gambit Accepted, Kieseritzky", moves: "e4 e5 f4 exf4 Nf3 g5 h4 g4 Ne5 Nf6" },
  { eco: "C31", name: "King's Gambit Declined, Falkbeer Counter-Gambit", moves: "e4 e5 f4 d5 exd5 e4 d3 Nf6" },
  { eco: "C51", name: "Evans Gambit", moves: "e4 e5 Nf3 Nc6 Bc4 Bc5 b4 Bxb4 c3 Ba5 d4 exd4 O-O" },
  { eco: "C21", name: "Danish Gambit", moves: "e4 e5 d4 exd4 c3 dxc3 Bc4 cxb2 Bxb2" },
  { eco: "C44", name: "Ponziani Opening", moves: "e4 e5 Nf3 Nc6 c3 Nf6 d4 Nxe4 d5 Ne7" },
  { eco: "C40", name: "Latvian Gambit", moves: "e4 e5 Nf3 f5 Nxe5 Qf6 d4 d6 Nc4 fxe4" },
  { eco: "C40", name: "Elephant Gambit", moves: "e4 e5 Nf3 d5 exd5 e4 Qe2 Nf6 d3" },
  { eco: "C20", name: "Alapin's Opening", moves: "e4 e5 Ne2 Nf6 f4" },
  { eco: "B21", name: "Sicilian Defence, Smith-Morra Gambit", moves: "e4 c5 d4 cxd4 c3 dxc3 Nxc3 Nc6 Nf3 d6 Bc4 e6 O-O" },
  { eco: "B12", name: "Caro-Kann Defence, Fantasy Variation", moves: "e4 c6 d4 d5 f3 dxe4 fxe4 e5 Nf3 exd4 Bc4" },
  { eco: "B00", name: "Nimzowitsch Defence", moves: "e4 Nc6 d4 d5 Nc3 dxe4 d5 Ne5" },
  { eco: "B00", name: "Owen's Defence", moves: "e4 b6 d4 Bb7 Bd3 e6 Nf3 c5 c3 Nf6" },
  { eco: "B00", name: "St. George Defence", moves: "e4 a6 d4 b5 Nf3 Bb7 Bd3 e6" },
  { eco: "D08", name: "Albin Counter-Gambit", moves: "d4 d5 c4 e5 dxe5 d4 Nf3 Nc6 g3 Bg4" },
  { eco: "D00", name: "Blackmar-Diemer Gambit", moves: "d4 d5 e4 dxe4 Nc3 Nf6 f3 exf3 Nxf3 g6" },
  { eco: "D07", name: "Chigorin Defence", moves: "d4 d5 c4 Nc6 Nc3 dxc4 Nf3 Nf6 e4 Bg4 d5 Ne5" },
  { eco: "A40", name: "Englund Gambit", moves: "d4 e5 dxe5 Nc6 Nf3 Qe7 Bf4 Qb4+ Bd2 Qxb2 Nc3" },
  { eco: "A45", name: "Trompowsky Attack", moves: "d4 Nf6 Bg5 Ne4 Bf4 c5 f3 Qa5+ c3 Nf6 d5" },
  { eco: "A01", name: "Nimzo-Larsen Attack", moves: "b3 e5 Bb2 Nc6 e3 d5 Bb5 Bd6 f4" },
  { eco: "A02", name: "Bird's Opening", moves: "f4 d5 Nf3 Nf6 e3 g6 Be2 Bg7 O-O O-O d3" },
  { eco: "A00", name: "Grob's Attack", moves: "g4 d5 Bg2 Bxg4 c4 c6 cxd5 cxd5 Qb3" },
  { eco: "A00", name: "Polish Opening (Sokolsky)", moves: "b4 e5 Bb2 Bxb4 Bxe5 Nf6 c3 Be7" },
  { eco: "A00", name: "Van 't Kruijs Opening", moves: "e3 d5 d4 Nf6 Bd3 c5 c3" },
  { eco: "A00", name: "Dunst Opening", moves: "Nc3 d5 e4 d4 Nce2 e5 Ng3" },
];

/* Comparison ignores check and mate marks. */
export const plain = (san) => san.replace(/[+#]/g, "");

/* Parses TREE text into nodes { san, weight, children }. Throws on a malformed line. */
export function parseTree(text) {
  const items = text.split("\n").flatMap((raw, i) => {
    const line = raw.replace(/\/\/.*$/, "").trimEnd();
    if (!line.trim()) return [];
    const indent = line.length - line.trimStart().length;
    const m = line.trim().match(/^(\d+)\s+(\S+)$/);
    if (indent % 2 !== 0 || !m || Number(m[1]) <= 0) throw new SyntaxError(`book line ${i + 1}: ${raw}`);
    const depth = indent / 2 + 1;
    if (depth > MAX_PLIES) throw new RangeError(`book line ${i + 1} is deeper than ${MAX_PLIES} plies`);
    return [{ depth, weight: Number(m[1]), san: m[2], line: i + 1 }];
  });
  const nest = (list, depth) => {
    if (list.length === 0) return [];
    if (list[0].depth !== depth) throw new SyntaxError(`book line ${list[0].line} is indented too far`);
    const starts = list.flatMap((it, i) => (it.depth === depth ? [i] : []));
    return starts.map((s, k) => ({
      san: list[s].san, weight: list[s].weight,
      children: nest(list.slice(s + 1, starts[k + 1] ?? list.length), depth + 1),
    }));
  };
  return nest(items, 1);
}

/* The book's replies to a game so far (SAN list), or [] once the game has left the book. */
export function bookChildren(tree, played) {
  return played.reduce((nodes, san) => nodes.find((n) => plain(n.san) === plain(san))?.children ?? [], tree);
}

/* Picks a node by weight; r is a random number in [0, 1). */
export function pickWeighted(nodes, r) {
  const total = nodes.reduce((sum, n) => sum + n.weight, 0);
  const target = r * total;
  const index = nodes.findIndex((_, i) => nodes.slice(0, i + 1).reduce((sum, n) => sum + n.weight, 0) > target);
  return nodes[index === -1 ? nodes.length - 1 : index];
}

/* Every root-to-leaf path of the tree as a SAN list. */
export function treePaths(tree) {
  return tree.flatMap((n) => (n.children.length ? treePaths(n.children).map((p) => [n.san, ...p]) : [[n.san]]));
}
