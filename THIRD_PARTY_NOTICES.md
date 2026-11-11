# Third-party notices

The original Pedagog-authored code is dedicated to the public domain under
CC0 1.0 (see `LICENSE`). These notices apply to the unmodified third-party
dependencies in `web/vendor/`; their licenses and copyright notices are
preserved in their respective `LICENSE` files.

| Component | Version | Copyright / attribution | License text |
|---|---|---|---|
| [chessground](https://github.com/lichess-org/chessground) | 9.2.1 | chessground contributors | GPL-3.0-or-later: [`LICENSE`](web/vendor/chessground/LICENSE) |
| chess.mjs | 2.4.2 | Copyright 2022 Jeff Hlywa | BSD-2-Clause: [`LICENSE`](web/vendor/chess.mjs/LICENSE) |
| [cm-chess](https://github.com/shaack/cm-chess) | 4.0.1 | Copyright 2021 Stefan Haack | MIT: [`LICENSE`](web/vendor/cm-chess/LICENSE) |
| [cm-pgn](https://github.com/shaack/cm-pgn) | 5.0.1 | Copyright 2018 Stefan Haack | MIT: [`LICENSE`](web/vendor/cm-pgn/LICENSE) |
| Piece sets from [Lichess](https://github.com/lichess-org/lila/tree/master/public/piece), [kmar/chess_svg_piece_sets](https://github.com/kmar/chess_svg_piece_sets) and [philatype/kosal](https://github.com/philatype/kosal) | fetched 2026-11-11 | per set; see the list | Per set: CC0, CC BY, CC BY-SA, CC BY-NC-SA, MIT, Apache 2.0, GPL, AGPL: [`LICENSES.md`](web/vendor/pieces/LICENSES.md) |

The web application includes chessground and is distributed as a combined work
under GPL-3.0-or-later terms. The standalone
`engine.js` is independent of these dependencies. No third-party
component is relicensed by the CC0 dedication. The piece sets are shown by the settings page (`web/config.html`,
the gear on the game page) and used by the app when one is chosen there. Only
sets whose terms allow redistribution are included; the CC BY-NC-SA ones may not
be used commercially, so a commercial build must leave them out (see
`web/vendor/pieces/LICENSES.md`).
