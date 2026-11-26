/* Each bot's opening book, in book.js's format (see its header for weight 0, "*" and
   systems). In every tree the bot picks by weight only among its own moves; the opponent's
   moves just lead to the bot's answers. Habits has no book here: its repertoire is inside
   engine-habits.ts. Tree moves and system moves on offer in the same position are weighed
   together, so their weights share a scale there. */
import { TREE, parseTree } from "./book.js";

/* Aggressive: only gambits and flank systems; a normal move appears only as the way into a
   gambit. Out of book as soon as the opponent's reply has no gambit.
   White (weights out of 200): gambits 112 (1.e4 76, 1.d4 36), English 24, Bird 24, flank
   systems 40 (20 %). Black: gambits 160 against 1.e4, 1.d4 and 1.f4, and the flank systems
   (40, "*") against everything, so 20 % against those three and all of it against the rest. */
export const AGGRESSIVE_TREE = `
76 e4
  120 e5
    40 Nf3
      30 f5                       // Latvian Gambit
      30 d5                       // Elephant Gambit
      40 Nc6
        0 Bb5
          100 f5                  // Schliemann
        45 Bc4
          0 Bc5
            100 b4                // Evans Gambit
          100 Nf6
            0 Ng5
              100 Bc5             // Traxler
            100 d4                // Two Knights, Modern Attack
              0 exd4
                100 O-O
        35 d4
          0 exd4
            100 Bc4               // Scotch Gambit
        20 Nc3
          0 Nf6
            100 Nxe5              // Halloween Gambit
      0 Nf6
        100 Bc4
          0 Nxe4
            100 Nc3               // Boden-Kieseritzky Gambit
    0 Bc4
      100 f5                      // Calabrian Countergambit
    25 f4                         // King's Gambit
      100 d5                      // Falkbeer
    20 d4
      0 exd4
        100 c3                    // Danish Gambit
    15 Nc3
      0 Nf6
        100 f4                    // Vienna Gambit
      0 Nc6
        100 f4
  40 d5
    0 exd5
      100 Nf6
        0 c4
          100 e6                  // Icelandic-Palme Gambit
        0 d4
          100 Bg4                 // Portuguese Gambit
    100 d4
      0 dxe4
        100 Nc3                   // Blackmar-Diemer, by transposition
          0 Nf6
            100 f3
  0 c5
    60 d4
      0 cxd4
        100 c3                    // Smith-Morra Gambit
    40 b4                         // Wing Gambit
  0 e6
    100 d4
      0 d5
        100 c4                    // Diemer-Duhm Gambit
  0 c6
    100 d4
      0 d5
        100 Nc3
          0 dxe4
            80 f3                 // Rasa-Studier Gambit
            20 Nxe4
              0 Nf6
                100 Ng5
                  0 h6
                    100 Nxf7      // Alien Gambit
36 d4
  40 e5                           // Englund Gambit
  60 d5
    0 c4
      100 e5                      // Albin Counter-Gambit
    100 e4                        // Blackmar-Diemer Gambit
      0 dxe4
        100 Nc3
          0 Nf6
            100 f3
  60 Nf6
    0 c4
      50 e5                       // Budapest Gambit
      50 c5
        0 d5
          100 b5                  // Benko Gambit
    50 e4                         // Omega Gambit
    50 g4                         // Gibbins-Wiedenhofer Gambit
  0 f5
    100 e4                        // Staunton Gambit
24 c4                             // English
24 f4                             // Bird
  160 e5                          // From's Gambit
    0 fxe5
      100 d6
    100 e4                        // King's Gambit, by transposition
10 h4 h5                          // Kadas, the h-pawn runs on
5 a4 a5                           // Ware, the a-pawn runs on
5 a4 Ra3!                         // Viih_Sou: the rook lift, offered to the bishop
10 g4 Bg2!                        // Grob
10 b4 Bb2!                        // Orangutan
0 *
  10 h5 h4
  5 a5 a4
  5 a5 Ra6!                       // Viih_Sou
  10 g5 Bg7!                      // Borg
  10 b5 Bb7!                      // Polish
`;

/* Constrictor: openings that lock the centre, so the game turns on space and pawn storms.
   White: French and Caro-Kann Advance, the Austrian Attack against the Pirc and the Modern,
   the Four Pawns against Alekhine's, Benonis and the King's Indian with d5. Black: the French,
   the King's Indian (Mar del Plata and Petrosian), the Czech Benoni, the Old Indian and the
   Stonewall Dutch, with closed set-ups against the flank openings. */
export const CONSTRICTOR_TREE = `
50 e4
  100 e6
    100 d4
      100 d5
        100 e5                    // French, Advance
          100 c5
            100 c3
              100 Nc6
        0 Nc3
          100 Nf6
            0 e5
              100 Nfd7
            0 Bg5
              100 Be7
                0 e5
                  100 Nfd7
        0 Nd2
          100 Nf6
            0 e5
              100 Nfd7
  0 c6
    100 d4
      0 d5
        100 e5                    // Caro-Kann, Advance
  0 d6
    100 d4
      0 Nf6
        100 Nc3
          0 g6
            100 f4                // Pirc, Austrian Attack
  0 g6
    100 d4
      0 Bg7
        100 Nc3
          0 d6
            100 f4
  0 Nf6
    100 e5
      0 Nd5
        100 d4
          0 d6
            100 c4
              0 Nb6
                100 f4            // Alekhine's, Four Pawns Attack
  0 Nc6
    100 d4
      0 d5
        100 e5
  0 c5
    100 c3
      0 Nf6
        100 e5
      0 e6
        100 d4
          0 d5
            100 e5                // a French Advance
  0 e5
    100 Nf3
      0 Nc6
        100 Bb5                   // Ruy Lopez
50 d4
  70 Nf6
    100 c4
      40 g6
        100 Nc3
          100 Bg7
            100 e4
              100 d6
                100 Nf3
                  100 O-O
                    100 Be2
                      100 e5
                        100 d5    // King's Indian, Petrosian
                          100 a5
                        0 O-O
                          100 Nc6
                            0 d5
                              100 Ne7   // King's Indian, Mar del Plata
      35 c5
        100 d5
          100 e5                  // Czech Benoni
            100 Nc3
              100 d6
                100 e4
          0 e6
            100 Nc3
      25 d6
        100 Nc3
          100 e5
            100 d5                // Old Indian, closed
              100 Be7
            0 Nf3
              100 Nbd7
    0 Nf3
      100 g6 Bg7 O-O d6
  30 f5 Nf6 e6 d5 c6 Bd6          // Stonewall Dutch
  0 d5
    100 c4
  0 c5
    100 d5
      0 e5
        100 e4                    // Czech Benoni structure
      0 e6
        100 c4
      0 d6
        100 e4
      0 Nf6
        100 c4
  0 e6
    100 e4
      0 d5
        100 e5                    // a French Advance
  0 g6
    100 e4
      0 Bg7
        100 Nc3
          0 d6
            100 f4
  0 d6
    100 e4
      0 Nf6
        100 Nc3
          0 g6
            100 f4
0 c4
  100 e5 Nc6 g6 Bg7 d6            // Closed English set-up
0 Nf3
  100 Nf6 g6 Bg7 O-O d6           // King's Indian set-up
`;

/* Hedgehog: set-ups more than lines. White: the Hippopotamus, the Cow, the Nimzo-Larsen and
   the King's Indian Attack. Black, against anything: the Hippopotamus, the Cow and the Modern;
   against 1.e4 also Owen's, St. George, the Pirc and the Norwegian Rat; against 1.c4 and
   1.Nf3 the Hedgehog itself. */
export const HEDGEHOG_TREE = `
35 g3 Bg2 d3 e3 b3 Bb2 Nd2 Ne2   // Hippopotamus
15 e3 d3 Ne2 Nd2 Ng3 Nb3         // the Cow
20 b3 Bb2 e3 Nf3 Be2 O-O         // Nimzo-Larsen
30 Nf3 g3 Bg2 O-O d3 Nbd2        // King's Indian Attack
0 *
  35 g6 Bg7 d6 e6 b6 Bb7 Nd7 Ne7  // Hippopotamus
  15 e6 d6 Ne7 Nd7 Ng6 Nb6        // the Cow
  15 g6 Bg7 d6 Nf6 O-O            // Modern
0 e4
  15 b6 Bb7 e6 c5 Nf6             // Owen's
  10 a6 b5 Bb7 e6                 // St. George
  10 d6 Nf6 g6 Bg7 O-O            // Pirc
  10 g6
    0 d4
      10 Nf6
        0 e5
          100 Nh5                 // Norwegian Rat
0 c4
  40 c5 Nf6 e6 b6 Bb7 Be7 d6 a6   // Hedgehog
0 Nf3
  40 c5 Nf6 e6 b6 Bb7 Be7 d6 a6
`;

/* Each book by id, parsed, with its depth limit; play.js's ENGINES name these. */
export const BOOKS = {
  pedagog: parseTree(TREE),
  aggressive: parseTree(AGGRESSIVE_TREE, 11),
  constrictor: parseTree(CONSTRICTOR_TREE, 16),
  hedgehog: parseTree(HEDGEHOG_TREE, 8),
};
