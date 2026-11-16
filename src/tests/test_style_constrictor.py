import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import chess


SCRIPT = Path(__file__).resolve().parents[1] / "tools" / "style-constrictor.py"
spec = importlib.util.spec_from_file_location("style_constrictor", SCRIPT)
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


class ConstrictorTests(unittest.TestCase):
    def test_space_is_symmetric_and_excludes_enemy_pawn_attacks(self):
        board = chess.Board("4k3/8/8/3p4/8/4N3/8/4K3 w - - 0 1")
        # The knight attacks c4 and e4, but the pawn on d5 controls both.
        self.assertEqual(checker.space(board, chess.WHITE), 2)
        mirrored = board.mirror()
        self.assertEqual(checker.space(board, chess.WHITE), checker.space(mirrored, chess.BLACK))
        self.assertEqual(checker.space(board, chess.BLACK), checker.space(mirrored, chess.WHITE))

    def test_pawn_advance_and_no_pawns(self):
        board = chess.Board("4k3/6p1/8/1P6/8/8/8/4K3 w - - 0 1")
        self.assertEqual(checker.pawn_advance(board, chess.WHITE), 3)
        self.assertEqual(checker.pawn_advance(board, chess.BLACK), 0)
        board.remove_piece_at(chess.B5)
        self.assertIsNone(checker.pawn_advance(board, chess.WHITE))

    def test_mobility_collapses_promotion_choices(self):
        board = chess.Board("7k/P7/8/8/8/8/8/7K w - - 0 1")
        moves = list(board.generate_pseudo_legal_moves())
        self.assertEqual(len(moves) - checker.opponent_mobility(board), 3)

    def test_cli_and_json_include_both_sides_and_exclude_endgames(self):
        pgn = """[White "Alice"]
[Black "Bob"]
[Result "*"]

1. e4 e5 2. Nf3 *

[White "Alice"]
[Black "Bob"]
[SetUp "1"]
[FEN "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1"]
[Result "*"]

1. e4 *
"""
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "games.pgn"
            out = Path(directory) / "summary.json"
            path.write_text(pgn, encoding="utf-8")
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--json", str(out), str(path)],
                capture_output=True, text=True, check=True,
            )
            summary = json.loads(out.read_text(encoding="utf-8"))
        self.assertIn("Alice: 2 games, 3 moves, 2 sampled positions", result.stdout)
        self.assertEqual(summary["files"], 1)
        self.assertEqual(summary["players"]["Alice"]["positions"], 2)
        self.assertEqual(summary["players"]["Bob"]["positions"], 1)
        self.assertIsInstance(summary["players"]["Bob"]["space_edge"], (int, float))

    def test_no_samples_are_null_and_empty_input_is_an_error(self):
        pgn = """[White "A"]
[Black "B"]
[SetUp "1"]
[FEN "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1"]

1. e4 *
"""
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "game.pgn"
            path.write_text(pgn, encoding="utf-8")
            player = checker.analyse([path])["players"]["A"]
            self.assertEqual(player["moves"], 1)
            self.assertIsNone(player["space"])
            self.assertIsNone(player["pawn_advance"])
            path.write_text("", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "no games"):
                checker.analyse([path])

    def test_illegal_move_is_reported_instead_of_silently_truncating(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bad.pgn"
            path.write_text('[White "A"]\n[Black "B"]\n\n1. e4 e5 2. Bh6 *\n', encoding="utf-8")
            result = subprocess.run(
                [sys.executable, str(SCRIPT), str(path)],
                capture_output=True, text=True,
            )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("invalid PGN", result.stderr)


if __name__ == "__main__":
    unittest.main()
