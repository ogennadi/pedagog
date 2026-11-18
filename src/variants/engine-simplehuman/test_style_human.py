import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

import chess


SCRIPT = Path(__file__).resolve().parent / "style-human.py"
spec = importlib.util.spec_from_file_location("style_human", SCRIPT)
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


class HumanStyleTests(unittest.TestCase):
    def test_static_exchange(self):
        queen_to_pawn = chess.Board("rnbqkbnr/pppp1ppp/8/4p3/3Q4/8/PPPPPPPP/RNB1KBNR b KQkq - 0 1")
        self.assertEqual(checker.see(queen_to_pawn, chess.D4, chess.BLACK), 9)
        defended_knight = chess.Board("4k3/8/3p4/4N3/3P4/8/8/4K3 b - - 0 1")
        self.assertEqual(checker.see(defended_knight, chess.E5, chess.BLACK), 2)

    def test_en_prise_loss(self):
        board = chess.Board("4k3/8/8/3p4/8/3Q4/8/4K3 w - - 0 1")
        self.assertEqual(checker.en_prise_loss(board, chess.Move.from_uci("d3c4")), 9)
        self.assertEqual(checker.en_prise_loss(board, chess.Move.from_uci("d3d4")), 0)
        petrov = chess.Board("r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3")
        self.assertEqual(checker.en_prise_loss(petrov, chess.Move.from_uci("f3e5")), 2)
        self.assertEqual(petrov.fen(), "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3")

    def test_mate_in_one_allowed_and_missed(self):
        start = chess.Board("6k1/5ppp/8/8/8/8/8/R5K1 b - - 0 1")
        moves = [chess.Move.from_uci("g8h8"), chess.Move.from_uci("a1a2")]
        counts = checker.count_moves(start, moves, lambda ply: True)
        self.assertEqual(counts[chess.BLACK]["mates_allowed"], 1)
        self.assertEqual(counts[chess.WHITE]["mate_chances"], 1)
        self.assertEqual(counts[chess.WHITE]["mates_missed"], 1)
        self.assertEqual(start.fen(), "6k1/5ppp/8/8/8/8/8/R5K1 b - - 0 1")

    def test_people_targets_fall_with_rating_and_extrapolate(self):
        low, mid, high = (checker.people_at(r) for r in (800, 1450, 1900))
        for rate in ("allows_mate", "en_prise", "hung"):
            self.assertGreater(low[rate], mid[rate])
            self.assertGreater(mid[rate], high[rate])
        self.assertLessEqual(checker.people_at(-5000)["misses_mate"], 100.0)
        self.assertGreaterEqual(checker.people_at(9000)["allows_mate"], 0.0)

    def test_performance_rating(self):
        results = [("X", "A", 0.5), ("A", "X", 0.5), ("X", "A", 0.5), ("A", "X", 0.5)]
        self.assertEqual(checker.performance("X", results, {"A": 1500}), 1500)
        self.assertIsNone(checker.performance("X", results, {}))

    def test_cli_with_anchor_matching_and_json(self):
        pgn = """[White "Engine"]
[Black "Anchor"]
[Result "0-1"]
[SetUp "1"]
[FEN "6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1"]

1. Ra2 h6 2. Ra3 Kh7 0-1
"""
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "games.pgn"
            out = Path(directory) / "summary.json"
            tsv = Path(directory) / "score.tsv"
            path.write_text(pgn, encoding="utf-8")
            tsv.write_text("g\t10\te2e4\te2e4\ng\t11\te7e5\tc7c5\n", encoding="utf-8")
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--anchor", "Anchor=1700", "--matching", f"Engine={tsv}",
                 "--json", str(out), str(path)],
                capture_output=True, text=True, check=True,
            )
            summary = json.loads(out.read_text(encoding="utf-8"))
        engine = summary["players"]["Engine"]
        self.assertEqual(engine["moves"], 2)
        self.assertEqual(engine["mate_chances"], 1)
        self.assertEqual(engine["misses_mate"], 100.0)
        self.assertEqual(engine["score"], 0.0)
        self.assertEqual(engine["rating_source"], "performance")
        self.assertEqual(engine["matching"], 50.0)
        self.assertIsNotNone(engine["people"])
        self.assertIn("misses mate in one:", result.stdout)

    def test_invalid_and_empty_input_are_errors(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bad.pgn"
            path.write_text('[White "A"]\n[Black "B"]\n\n1. e4 e5 2. Bh6 *\n', encoding="utf-8")
            result = subprocess.run([sys.executable, str(SCRIPT), str(path)], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("invalid PGN", result.stderr)
            path.write_text("", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "no games"):
                checker.analyse([path])

    def test_free_material(self):
        free = chess.Board("4k3/8/8/3n4/8/8/8/3RK3 w - - 0 1")
        self.assertEqual(checker.capture_gain(free, chess.Move.from_uci("d1d5")), 3)
        self.assertEqual(checker.winning_moves(free), {chess.Move.from_uci("d1d5")})
        defended = chess.Board("4k3/8/4p3/3n4/8/8/8/3RK3 w - - 0 1")
        self.assertEqual(checker.capture_gain(defended, chess.Move.from_uci("d1d5")), -2)
        self.assertEqual(checker.winning_moves(defended), set())
        self.assertEqual(defended.fen(), "4k3/8/4p3/3n4/8/8/8/3RK3 w - - 0 1")

    def test_score_file_names_and_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            good = Path(directory) / "score-pedagog-10-1900.tsv"
            good.write_text("g\t3\te2e4\td2d4\n", encoding="utf-8")
            self.assertEqual(checker.read_score(good), ("pedagog-10", 1900, [("g", 3, "e2e4", "d2d4")]))
            bad = Path(directory) / "predictions.tsv"
            bad.write_text("g\t3\te2e4\td2d4\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "score-<engine>-<bin>"):
                checker.read_score(bad)

    def test_times_off_people(self):
        self.assertEqual(checker.times_off({"blunders": 2.0, "hangs": 0.5}), 2.0)
        self.assertEqual(checker.times_off({"blunders": 1.0}), 1.0)
        none = dict.fromkeys(checker.POSITION_RATES)
        self.assertEqual(checker.factors({**none, "allows_mate": 0.0, "misses_mate": None},
                                         {**none, "allows_mate": 0.04, "misses_mate": 20.0}), {"allows_mate": 0.5})

    @unittest.skipUnless(shutil.which("stockfish"), "Stockfish not on PATH")
    def test_positions_judge_people_and_engine_alike(self):
        game = {"id": "g", "fen": "6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1", "moves": ["a1a2", "g8h8"], "scored": [0]}
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "test-1900.jsonl").write_text(json.dumps(game) + "\n", encoding="utf-8")
            score = Path(directory) / "score-mater-1900.tsv"
            score.write_text("g\t0\ta1a2\ta1a8\n", encoding="utf-8")
            first = checker.positions([score], testset=directory, resamples=10)
            self.assertTrue(Path(directory, checker.CACHE).exists())
            again = checker.positions([score], testset=directory, resamples=10)
        mater = first["engines"]["mater"]
        self.assertEqual(mater["matching"], 0.0)
        self.assertEqual(mater["mate_chances"], 1)
        self.assertEqual(mater["engine"]["misses_mate"], 0.0)
        self.assertEqual(mater["people"]["misses_mate"], 100.0)
        self.assertEqual(again["engines"]["mater"]["engine"], mater["engine"])
        self.assertEqual(again["engines"]["mater"]["people"], mater["people"])


if __name__ == "__main__":
    unittest.main()
