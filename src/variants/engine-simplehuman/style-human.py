"""How human a player's mistakes are, from cutechess PGNs: the goals engine-simplehuman was
measured against, beside the rates of people of the same rating.

    python src/variants/engine-simplehuman/style-human.py [options] match.pgn [...]

Per player, over the moves it chose (an EPD opening book leaves no book moves in the movetext):

  allows mate in one  after its move the opponent can mate at once, though another legal move
                      would have prevented that; per 100 moves
  misses mate in one  it could mate at once and played something else; per chance
  piece en prise      after its move (not a check) the opponent's best capture wins 3+ points
                      (P=1, N=B=3, R=5, Q=9), by static exchange; per 100 moves
  material hung       3+ points worse after the reply than before its move, and still after the
                      next pair of moves; per 100 moves
The last two are counted while material is within 5 points before the move, so a game already
decided does not count, and sacrifices count as hung: the engines here have no reason to make
them. The rates depend on the opponent and the positions it leads to (engine.ts level 4 leaves a
piece en prise 3.8 times per 100 moves against Gaia level 6, 5.9 against simplehuman level 4), so
compare players in games against the same opponents, or in self-play.

Options:
  --anchor NAME=ELO    a player of known rating (repeatable); every other player gets a
                       performance rating from its games against anchors
  --rating NAME=ELO    the rating at which to compare a player with people (default: its anchor
                       or performance rating)
  --matching NAME=TSV  a score file of src/variants/engine-human/score.ts, shown as that player's
                       move-matching accuracy (repeatable)
  --json OUT           also write the summary to OUT
  --workers N          PGN files read in parallel (default 1)
  --reference DIR      print PEOPLE afresh from Maia's test games, DIR/test-<bin>.jsonl
                       (--reference-games per bin, default 400), and exit

PEOPLE holds the same four rates for Lichess players of each 100-point bin, 1000 to 1900,
measured with --reference on Maia's December 2019 test games: 400 games per bin, the moves Maia
scores (not in time trouble), from ply 16 on, as the engines' games begin after a 16-ply book.
A player's targets are each rate's least-squares line over the bins, so ratings outside
1000-1900 are extrapolated. The bins are Lichess blitz and rapid ratings; the ladder's ratings
are on the Lichess classical scale (Maia-1900 = 1755), so which bin matches which level is a
choice, not a measurement. Strength comes from the games; move matching needs score.ts.

Same positions (--positions): the files are score.ts files, score-<engine>-<bin>.tsv. In every
position scored there, the move the person played and the move the engine chose are judged
alike, so engine and people meet the same positions and no opponent or rating scale comes
between them:

    python src/variants/engine-simplehuman/style-human.py --positions --workers 12 \\
        --baseline pedagog-10 src/variants/engine-human/data/score-*-1900.tsv

  allows mate in one    as above; per 100 moves
  misses mate in one    as above; per chance
  blunders              the mover's winning chances (Lichess's, -1 to 1, from Stockfish) fall
                        by 0.3 or more; per 100 moves
  hangs material        a blunder that leaves 3+ points en prise, as above; per 100 moves
  misses free material  a capture or promotion won 3+ points at once (by static exchange,
                        allowing no mate in one) and lost at most 0.1 to Stockfish's best, and
                        the move was a blunder; per chance
A move's loss is the winning chances after Stockfish's best move, searched to --depth (12) from
a fresh game, less those after the move, searched one ply less. The last two are counted while
material is within 5 points. Per engine it prints each rate beside people's, the factor between
them, and "times off people", the geometric mean of the factors each turned to at least 1 (1 is
people exactly), all with 95 % intervals from resampling games; with --baseline, the paired
differences from that engine. Mean loss, in Lichess win-percentage points per move, stands in
for strength on these positions. Stockfish's verdicts are kept in style-human-stockfish.tsv beside
the test set (git-ignored), so the people's moves are searched once. Needs Stockfish on PATH (or
--stockfish).
"""
import argparse
import collections
import json
import math
from multiprocessing import Pool
from pathlib import Path
import random
import re

import chess
import chess.pgn

VALUE = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9,
         chess.KING: 0}
SEE_VALUE = {**VALUE, chess.KING: 100}
LOSS = 3              # points a piece en prise or hung material must be worth
DECIDED = 5           # material lead beyond which a position counts as decided
REFERENCE_FROM_PLY = 16

# rating: (allows mate in one per 100 moves, misses mate in one %, en prise per 100, hung per 100)
PEOPLE = {
    1000: (0.87, 44.7, 4.04, 2.83),
    1100: (0.78, 45.3, 4.02, 2.74),
    1200: (0.80, 38.3, 3.83, 2.47),
    1300: (0.64, 37.7, 3.19, 2.13),
    1400: (0.60, 33.0, 3.33, 2.20),
    1500: (0.51, 30.1, 2.81, 1.95),
    1600: (0.42, 30.2, 2.54, 1.82),
    1700: (0.34, 34.4, 2.51, 1.67),
    1800: (0.33, 24.3, 2.11, 1.60),
    1900: (0.32, 26.9, 2.23, 1.48),
}
RATES = ("allows_mate", "misses_mate", "en_prise", "hung")


def balance(board, colour):
    """Material of `colour` minus its opponent's, in points."""
    return sum(VALUE[p.piece_type] * (1 if p.color == colour else -1)
               for p in board.piece_map().values())


def mating_moves(board):
    """The legal moves of `board` that mate at once."""
    probe = board.copy(stack=False)
    found = []
    for move in board.legal_moves:
        probe.push(move)
        if probe.is_checkmate():
            found.append(move)
        probe.pop()
    return found


def allows_mate(board, move):
    """Can the opponent mate at once after `move`?"""
    after = board.copy(stack=False)
    after.push(move)
    return bool(mating_moves(after))


def see(board, square, side):
    """What `side` wins by capturing on `square` if both sides go on recapturing with their
    least valuable piece, each free to stop (a static exchange: x-rays seen, pins not)."""
    target = board.piece_at(square)
    if target is None or target.color == side or not board.attackers(side, square):
        return 0
    scratch = board.copy(stack=False)
    gains, on_square, to_move = [], SEE_VALUE[target.piece_type], side
    while True:
        attackers = scratch.attackers(to_move, square)
        if not attackers:
            break
        attacker = min(attackers, key=lambda s: SEE_VALUE[scratch.piece_type_at(s)])
        if scratch.piece_type_at(attacker) == chess.KING and scratch.attackers(not to_move, square):
            break
        gains.append(on_square)
        on_square = SEE_VALUE[scratch.piece_type_at(attacker)]
        scratch.set_piece_at(square, scratch.remove_piece_at(attacker))
        to_move = not to_move
    result = 0
    for gain in reversed(gains):
        result = max(0, gain - result)
    return result


def capture_gain(board, move):
    """Points the mover is up at once after `move` and the opponent's best capture by static
    exchange: its material then minus its material before (negative when material is left en
    prise)."""
    mover = board.turn
    after = board.copy(stack=False)
    after.push(move)
    squares = [sq for sq, p in after.piece_map().items()
               if p.color == mover and p.piece_type != chess.KING]
    best = max((see(after, sq, not mover) for sq in squares), default=0)
    return balance(after, mover) - best - balance(board, mover)


def en_prise_loss(board, move):
    """Points the mover can lose at once after `move`: its material before the move minus its
    material after the opponent's best capture (0 after a check)."""
    return 0 if board.gives_check(move) else -capture_gain(board, move)


def winning_moves(board):
    """The captures and promotions of `board` that win LOSS or more points at once, by
    capture_gain(), and do not allow mate in one."""
    return {m for m in board.legal_moves
            if (board.is_capture(m) or m.promotion) and capture_gain(board, m) >= LOSS
            and not allows_mate(board, m)}


def count_moves(start, moves, counted):
    """Counters per colour for one game from `start` (not changed): only plies for which
    `counted(ply)` holds are judged."""
    boards = [start.copy(stack=False)]
    for move in moves:
        board = boards[-1].copy(stack=False)
        board.push(move)
        boards.append(board)
    white = [balance(b, chess.WHITE) for b in boards]
    counts = {chess.WHITE: collections.Counter(), chess.BLACK: collections.Counter()}
    for ply, move in enumerate(moves):
        if not counted(ply):
            continue
        board = boards[ply]
        c = counts[board.turn]
        c["moves"] += 1
        mates = mating_moves(board)
        if mates:
            c["mate_chances"] += 1
            c["mates_missed"] += move not in mates
        if allows_mate(board, move) and any(not allows_mate(board, m) for m in board.legal_moves):
            c["mates_allowed"] += 1
        sign = 1 if board.turn == chess.WHITE else -1
        before = sign * white[ply]
        if abs(before) > DECIDED:
            continue
        c["en_prise"] += en_prise_loss(board, move) >= LOSS
        if ply + 4 <= len(moves):
            c["hung"] += (sign * white[ply + 2] <= before - LOSS and
                          sign * white[ply + 4] <= before - LOSS)
    return counts


def read_file(path):
    """Per player, its counters and its results: (name -> Counter, list of (name, opponent,
    score)). Raises ValueError for an unreadable game."""
    counts = collections.defaultdict(collections.Counter)
    results = []
    with open(path, encoding="utf-8-sig") as source:
        while (game := chess.pgn.read_game(source)) is not None:
            if game.errors:
                raise ValueError(f"{path}: invalid PGN game: {game.errors[0]}")
            names = {chess.WHITE: game.headers["White"], chess.BLACK: game.headers["Black"]}
            per_colour = count_moves(game.board(), list(game.mainline_moves()), lambda ply: True)
            for colour, name in names.items():
                counts[name] += per_colour[colour]
                counts[name]["games"] += 1
            white_score = {"1-0": 1.0, "0-1": 0.0, "1/2-1/2": 0.5}.get(game.headers.get("Result"))
            if white_score is not None:
                results.append((names[chess.WHITE], names[chess.BLACK], white_score))
                results.append((names[chess.BLACK], names[chess.WHITE], 1 - white_score))
    return dict(counts), results


def rates(counter):
    """The four rates of one player's counters (None where there was nothing to count)."""
    moves = counter["moves"]
    chances = counter["mate_chances"]
    per_100 = lambda key: round(100 * counter[key] / moves, 2) if moves else None
    return {
        "allows_mate": per_100("mates_allowed"),
        "misses_mate": round(100 * counter["mates_missed"] / chances, 1) if chances else None,
        "en_prise": per_100("en_prise"),
        "hung": per_100("hung"),
    }


def performance(name, results, anchors):
    """`name`'s rating from its games against anchored players: their mean rating plus the
    Elo difference of its score there (None without such games)."""
    games = [(anchors[opponent], score) for player, opponent, score in results
             if player == name and opponent in anchors and opponent != name]
    if not games:
        return None
    n = len(games)
    score = min(max(sum(s for _, s in games), 0.5), n - 0.5)
    return round(sum(r for r, _ in games) / n + 400 * math.log10(score / (n - score)))


def people_line(table=PEOPLE):
    """Each rate's least-squares line over the bins of `table`: rate -> (slope, intercept)."""
    xs = sorted(table)
    mean_x = sum(xs) / len(xs)
    lines = {}
    for i, rate in enumerate(RATES):
        ys = [table[x][i] for x in xs]
        mean_y = sum(ys) / len(ys)
        slope = (sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys)) /
                 sum((x - mean_x) ** 2 for x in xs))
        lines[rate] = (slope, mean_y - slope * mean_x)
    return lines


def people_at(rating, table=PEOPLE):
    """People's four rates at `rating`, from people_line(), none below 0 nor a share above 100."""
    targets = {}
    for rate, (slope, intercept) in people_line(table).items():
        value = max(0.0, slope * rating + intercept)
        targets[rate] = round(min(value, 100.0) if rate == "misses_mate" else value, 2)
    return targets


def matching_accuracy(path):
    """Accuracy, in %, of a score.ts file: game, ply, move played, move predicted."""
    rows = [line.split("\t") for line in Path(path).read_text(encoding="utf-8").splitlines() if line]
    return round(100 * sum(row[2] == row[3] for row in rows) / len(rows), 2) if rows else None


def pairs(values, what):
    """NAME=VALUE options as a dict."""
    out = {}
    for value in values or []:
        name, sep, rest = value.rpartition("=")
        if not sep or not name:
            raise ValueError(f"{what} must look like NAME=VALUE: {value}")
        out[name] = rest
    return out


def analyse(files, anchors=None, ratings=None, matching=None, workers=1):
    """The summary of `files`: per player its games, moves, score, rating and the rates, with
    people's rates at its rating."""
    anchors = {name: int(elo) for name, elo in (anchors or {}).items()}
    ratings = {name: int(elo) for name, elo in (ratings or {}).items()}
    if workers > 1:
        with Pool(workers) as pool:
            parts = pool.map(read_file, files)
    else:
        parts = [read_file(path) for path in files]
    counts = collections.defaultdict(collections.Counter)
    results = []
    for part_counts, part_results in parts:
        for name, counter in part_counts.items():
            counts[name] += counter
        results.extend(part_results)
    if not counts:
        raise ValueError("no games found in the supplied PGNs")
    players = {}
    for name, counter in sorted(counts.items()):
        scores = [s for player, _, s in results if player == name]
        rating = ratings.get(name, anchors.get(name, performance(name, results, anchors)))
        players[name] = {
            "games": counter["games"],
            "moves": counter["moves"],
            "mate_chances": counter["mate_chances"],
            "score": round(100 * sum(scores) / len(scores), 1) if scores else None,
            "rating": rating,
            "rating_source": ("given" if name in ratings else "anchor" if name in anchors
                              else "performance" if rating is not None else None),
            **rates(counter),
            "people": people_at(rating) if rating is not None else None,
            "matching": matching_accuracy(matching[name]) if matching and name in matching else None,
        }
    return {"files": len(files), "players": players}


def reference_bin(directory, bin_, games_per_bin):
    """People's rates in one bin, from DIR/test-<bin>.jsonl."""
    lines = (Path(directory) / f"test-{bin_}.jsonl").read_text(encoding="utf-8").splitlines()
    games = [json.loads(line) for line in lines if line]
    picked = [games[(i * len(games)) // games_per_bin] for i in range(min(games_per_bin, len(games)))]
    total = collections.Counter()
    for game in picked:
        scored = {ply for ply in game["scored"] if ply >= REFERENCE_FROM_PLY}
        per_colour = count_moves(chess.Board(game["fen"]),
                                 [chess.Move.from_uci(m) for m in game["moves"]],
                                 lambda ply, scored=scored: ply in scored)
        total += per_colour[chess.WHITE] + per_colour[chess.BLACK]
    return rates(total)


def reference(directory, games_per_bin, workers=1):
    """PEOPLE measured afresh from DIR/test-<bin>.jsonl: bin -> rates."""
    jobs = [(directory, bin_, games_per_bin) for bin_ in sorted(PEOPLE)]
    if workers > 1:
        with Pool(workers) as pool:
            measured = pool.starmap(reference_bin, jobs)
    else:
        measured = [reference_bin(*job) for job in jobs]
    return dict(zip(sorted(PEOPLE), measured))


POSITION_RATES = ("allows_mate", "misses_mate", "blunders", "hangs", "misses_free")
POSITION_LABELS = {"allows_mate": "allows mate in one", "misses_mate": "misses mate in one",
                   "blunders": "blunders", "hangs": "hangs material", "misses_free": "misses free material"}
# A rate below its floor counts as the floor, so that 0 is a finite factor off people.
FLOOR = {"allows_mate": 0.02, "misses_mate": 1.0, "blunders": 0.1, "hangs": 0.05, "misses_free": 1.0}
FIELDS = ("moves", "mate_chances", "mates_missed", "mates_allowed", "blunders", "hangs",
          "free_chances", "free_missed", "loss_milli")
TESTSET = Path(__file__).resolve().parent.parent / "engine-human" / "data"
RESAMPLES = 1000
DEPTH = 12            # Stockfish's depth for each search, by default
BLUNDER = 0.3         # loss of winning chances (from -1 to 1) that makes a blunder, as on Lichess
GOOD = 0.1            # most a capture may lose to the best move and still count as free material
CACHE = "style-human-stockfish.tsv"   # Stockfish's verdicts, kept in the test set's directory
_stockfish = None     # this process's Stockfish, its depth and its verdicts: start_stockfish()
_depth = DEPTH
_known = {}           # (FEN, depth) -> (best move in UCI or "", the mover's winning chances)
_new = {}             # the part of _known this process searched and has not yet handed back


def read_cache(path):
    """The verdicts kept in `path`, if it exists: (FEN, depth) -> (best move, winning chances)."""
    known = {}
    if Path(path).exists():
        for line in Path(path).read_text(encoding="utf-8").splitlines():
            fen, depth, best, chances = line.split("\t")
            known[(fen, int(depth))] = (best, float(chances))
    return known


def start_stockfish(command="stockfish", depth=DEPTH, cache=None):
    """Start this process's Stockfish (one thread, 16 MB hash, searching to `depth`) with the
    verdicts kept in `cache`."""
    global _stockfish, _depth, _known
    import chess.engine
    _stockfish = chess.engine.SimpleEngine.popen_uci(command)
    _stockfish.configure({"Threads": 1, "Hash": 16})
    _depth = depth
    _known = read_cache(cache) if cache else {}
    _new.clear()


def winning_chances(score):
    """Lichess's winning chances, from -1 to 1, of a python-chess score (centipawns capped at
    1000, a mate as 1000)."""
    cp = max(-1000, min(1000, score.score(mate_score=100_000)))
    return round(2 / (1 + math.exp(-0.00368208 * cp)) - 1, 6)


def verdict(board, depth):
    """(Stockfish's best move in UCI, or "" when the game is over; the mover's winning chances)
    in `board`, searched to `depth` from a fresh game so that no search depends on another."""
    import chess.engine
    key = (board.fen(), depth)
    if key not in _known:
        if board.is_checkmate():
            _known[key] = ("", -1.0)
        elif board.is_game_over():
            _known[key] = ("", 0.0)
        else:
            info = _stockfish.analyse(board, chess.engine.Limit(depth=depth), game=object())
            _known[key] = (info["pv"][0].uci(), winning_chances(info["score"].pov(board.turn)))
        _new[key] = _known[key]
    return _known[key]


def judge_position(board, moves):
    """Counters for each of `moves` played in `board` (not changed): move -> Counter of FIELDS.
    A move's loss is the mover's winning chances with Stockfish's best move (searched to the
    depth) less those after the move (searched one ply less). Needs start_stockfish(). Raises
    ValueError for an illegal move."""
    for move in moves:
        if not board.is_legal(move):
            raise ValueError(f"illegal move {move.uci()} in {board.fen()}")
    mates = set(mating_moves(board))
    decided = abs(balance(board, board.turn)) > DECIDED
    best_move, best = verdict(board, _depth)
    losses = {}

    def loss(move):
        if move not in losses:
            after = board.copy(stack=False)
            after.push(move)
            losses[move] = 0.0 if move.uci() == best_move else max(0.0, best + verdict(after, _depth - 1)[1])
        return losses[move]

    free = not decided and any(loss(m) < GOOD for m in sorted(winning_moves(board), key=chess.Move.uci))
    can_avoid_mate = None
    judged = {}
    for move in sorted(set(moves), key=chess.Move.uci):
        c = collections.Counter(moves=1)
        blunder = loss(move) >= BLUNDER
        c["blunders"] = int(blunder)
        c["loss_milli"] = round(1000 * loss(move))
        if mates:
            c["mate_chances"] = 1
            c["mates_missed"] = int(move not in mates)
        if allows_mate(board, move):
            if can_avoid_mate is None:
                can_avoid_mate = any(not allows_mate(board, m) for m in board.legal_moves)
            c["mates_allowed"] = int(can_avoid_mate)
        if not decided:
            c["hangs"] = int(blunder and en_prise_loss(board, move) >= LOSS)
            if free:
                c["free_chances"] = 1
                c["free_missed"] = int(blunder)
        judged[move] = c
    return judged


def judge_game(job):
    """judge_position() at the wanted plies of one game: job = (fen, moves, ply -> moves in UCI);
    returns (ply -> UCI -> tuple of FIELDS, the verdicts searched for it)."""
    fen, moves, wanted = job
    board = chess.Board(fen)
    judged = {}
    for ply in range(max(wanted) + 1):
        if ply in wanted:
            per_move = judge_position(board, [chess.Move.from_uci(uci) for uci in wanted[ply]])
            judged[ply] = {m.uci(): tuple(c[f] for f in FIELDS) for m, c in per_move.items()}
        board.push_uci(moves[ply])
    searched = dict(_new)
    _new.clear()
    return judged, searched


def read_score(path):
    """A score.ts file, score-<engine>-<bin>.tsv: (engine, bin, rows of (game id, ply, move
    played, engine move))."""
    match = re.fullmatch(r"score-(.+)-(\d+)\.tsv", Path(path).name)
    if not match:
        raise ValueError(f"{path}: want a score.ts file named score-<engine>-<bin>.tsv")
    rows = []
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if line:
            fields = line.split("\t")
            if len(fields) != 4:
                raise ValueError(f"{path}: want 4 tab-separated fields: {line}")
            rows.append((fields[0], int(fields[1]), fields[2], fields[3]))
    if not rows:
        raise ValueError(f"{path}: no predictions")
    return match.group(1), int(match.group(2)), rows


def position_rates(totals):
    """The four rates of summed FIELDS (None where there was nothing to count)."""
    t = dict(zip(FIELDS, totals))
    share = lambda part, whole: 100 * t[part] / t[whole] if t[whole] else None
    return {"allows_mate": share("mates_allowed", "moves"), "misses_mate": share("mates_missed", "mate_chances"),
            "blunders": share("blunders", "moves"), "hangs": share("hangs", "moves"),
            "misses_free": share("free_missed", "free_chances")}


def factors(engine, people):
    """Per rate, the engine's rate over people's, each at least its FLOOR."""
    return {r: max(engine[r], FLOOR[r]) / max(people[r], FLOOR[r])
            for r in POSITION_RATES if engine[r] is not None and people[r] is not None}


def times_off(ratios):
    """How many times off people the engine is on average (the geometric mean of the factors,
    each turned to at least 1): 1 is people's rates exactly."""
    logs = [abs(math.log2(f)) for f in ratios.values()]
    return 2 ** (sum(logs) / len(logs)) if logs else None


def sample(per_game, picks):
    """Matching, both players' rates and the factors over the games `picks` (indexes, repeats
    allowed) of `per_game`: a list of (people FIELDS, engine FIELDS, hits, positions)."""
    people, engine, hits, total = [0] * len(FIELDS), [0] * len(FIELDS), 0, 0
    for i in picks:
        p, e, h, n = per_game[i]
        people = [a + b for a, b in zip(people, p)]
        engine = [a + b for a, b in zip(engine, e)]
        hits += h
        total += n
    rates_people, rates_engine = position_rates(people), position_rates(engine)
    ratios = factors(rates_engine, rates_people)
    loss_at = FIELDS.index("loss_milli")
    return {"matching": 100 * hits / total, "people": rates_people, "engine": rates_engine,
            "factors": ratios, "off": times_off(ratios), "totals": dict(zip(FIELDS, engine)),
            "loss": engine[loss_at] / total * 0.05, "people_loss": people[loss_at] / total * 0.05}


def interval(values):
    """The 2.5 and 97.5 percentiles of `values` (None left out)."""
    values = sorted(v for v in values if v is not None)
    if not values:
        return None
    return [values[int(0.025 * len(values))], values[min(len(values) - 1, int(0.975 * len(values)))]]


def positions(files, testset=TESTSET, baseline=None, workers=1, resamples=RESAMPLES,
              stockfish="stockfish", depth=DEPTH):
    """Per score.ts file, the engine's mistakes and people's in the same positions, with 95 %
    intervals from resampling games; and, with `baseline` (an engine name), each engine's
    paired difference from it where both scored the same positions."""
    engines = [read_score(path) for path in files]
    names = [name for name, _, _ in engines]
    if len(set(names)) != len(names):
        raise ValueError("two score files of the same engine")
    if baseline is not None and baseline not in names:
        raise ValueError(f"baseline {baseline} is not among the score files")
    games = {}
    for bin_ in sorted({b for _, b, _ in engines}):
        needed = {row[0] for _, b, rows in engines if b == bin_ for row in rows}
        path = Path(testset) / f"test-{bin_}.jsonl"
        for line in path.read_text(encoding="utf-8").splitlines():
            game = json.loads(line) if line else None
            if game and game["id"] in needed:
                games[(bin_, game["id"])] = game
        missing = needed - {gid for b, gid in games if b == bin_}
        if missing:
            raise ValueError(f"{path}: no game {sorted(missing)[0]}")
    wanted = collections.defaultdict(lambda: collections.defaultdict(set))
    for name, bin_, rows in engines:
        for gid, ply, played, predicted in rows:
            game_moves = games[(bin_, gid)]["moves"]
            if ply >= len(game_moves) or game_moves[ply] != played:
                raise ValueError(f"{name}: game {gid} ply {ply} is not {played}")
            wanted[(bin_, gid)][ply].update((played, predicted))
    keys = sorted(wanted)
    jobs = [(games[k]["fen"], games[k]["moves"], {p: sorted(m) for p, m in wanted[k].items()}) for k in keys]
    cache = Path(testset) / CACHE
    if workers > 1:
        # Leaving the block terminates the workers (letting them exit hangs on Windows); each
        # Stockfish then reads the end of its input and quits.
        with Pool(workers, initializer=start_stockfish, initargs=(stockfish, depth, cache)) as pool:
            results = pool.map(judge_game, jobs, chunksize=1)
    else:
        start_stockfish(stockfish, depth, cache)
        try:
            results = list(map(judge_game, jobs))
        finally:
            _stockfish.quit()
    judged = {key: verdicts for key, (verdicts, _) in zip(keys, results)}
    searched = {k: v for _, found in results for k, v in found.items()}
    if searched:
        with open(cache, "a", encoding="utf-8") as out:
            out.writelines(f"{fen}\t{d}\t{best}\t{chances:.6f}\n"
                           for (fen, d), (best, chances) in sorted(searched.items()))

    per_engine = {}
    for name, bin_, rows in engines:
        by_game = collections.defaultdict(list)
        for gid, ply, played, predicted in rows:
            by_game[gid].append((ply, played, predicted))
        per_game = []
        for gid in sorted(by_game):
            verdicts = judged[(bin_, gid)]
            people = [sum(col) for col in zip(*(verdicts[p][pl] for p, pl, _ in by_game[gid]))]
            engine = [sum(col) for col in zip(*(verdicts[p][pr] for p, _, pr in by_game[gid]))]
            hits = sum(pl == pr for _, pl, pr in by_game[gid])
            per_game.append((people, engine, hits, len(by_game[gid])))
        positions_scored = frozenset((bin_, gid, ply) for gid, ply, _, _ in rows)
        per_engine[name] = (bin_, per_game, positions_scored)

    rng = random.Random(12345)
    count = {name: len(per_game) for name, (_, per_game, _) in per_engine.items()}
    picks = {n: [[rng.randrange(n) for _ in range(n)] for _ in range(resamples)] for n in sorted(set(count.values()))}
    summary = {}
    for name, (bin_, per_game, scored) in per_engine.items():
        whole = sample(per_game, range(len(per_game)))
        draws = [sample(per_game, p) for p in picks[len(per_game)]]
        entry = {
            "bin": bin_, "games": len(per_game), "positions": len(scored),
            "matching": whole["matching"], "matching_95": interval(d["matching"] for d in draws),
            "loss": whole["loss"], "loss_95": interval(d["loss"] for d in draws), "people_loss": whole["people_loss"],
            "mate_chances": whole["totals"]["mate_chances"], "free_chances": whole["totals"]["free_chances"],
            "engine": whole["engine"], "people": whole["people"], "factors": whole["factors"],
            "factors_95": {r: interval(d["factors"].get(r) for d in draws) for r in whole["factors"]},
            "off": whole["off"], "off_95": interval(d["off"] for d in draws),
        }
        if baseline is not None and name != baseline:
            _, base_games, base_scored = per_engine[baseline]
            if base_scored == scored:
                base_draws = [sample(base_games, p) for p in picks[len(per_game)]]
                base_whole = sample(base_games, range(len(base_games)))
                entry["vs_baseline"] = {
                    "matching": whole["matching"] - base_whole["matching"],
                    "matching_95": interval(d["matching"] - b["matching"] for d, b in zip(draws, base_draws)),
                    "loss": whole["loss"] - base_whole["loss"],
                    "loss_95": interval(d["loss"] - b["loss"] for d, b in zip(draws, base_draws)),
                    "off_ratio": whole["off"] / base_whole["off"],
                    "off_ratio_95": interval(d["off"] / b["off"] for d, b in zip(draws, base_draws)
                                             if d["off"] and b["off"]),
                }
            else:
                entry["vs_baseline"] = None
        summary[name] = entry
    return {"baseline": baseline, "engines": summary}


def show_positions(summary):
    """The positions summary as text, one block per engine."""
    out = []
    for name, e in summary["engines"].items():
        out.append(f"{name} on bin {e['bin']}: {e['games']} games, {e['positions']:,} positions")
        lo, hi = e["matching_95"]
        out.append(f"  {'move matching':21} {e['matching']:.2f}% [{lo:.2f}, {hi:.2f}]")
        lo, hi = e["loss_95"]
        out.append(f"  {'mean loss':21} {e['loss']:.2f} win% per move [{lo:.2f}, {hi:.2f}], people {e['people_loss']:.2f}")
        for rate in POSITION_RATES:
            mine, theirs = e["engine"][rate], e["people"][rate]
            if mine is None or theirs is None:
                out.append(f"  {POSITION_LABELS[rate]:21} no chances")
                continue
            if rate in ("misses_mate", "misses_free"):
                chances = e["mate_chances" if rate == "misses_mate" else "free_chances"]
                text = f"{mine:.1f}% of {chances}, people {theirs:.1f}%"
            else:
                text = f"{mine:.2f} per 100, people {theirs:.2f}"
            factor_lo, factor_hi = e["factors_95"][rate] or (math.nan, math.nan)
            out.append(f"  {POSITION_LABELS[rate]:21} {text:28} x{e['factors'][rate]:.2f} "
                       f"[{factor_lo:.2f}, {factor_hi:.2f}]")
        off_lo, off_hi = e["off_95"]
        out.append(f"  {'times off people':21} x{e['off']:.2f} [{off_lo:.2f}, {off_hi:.2f}]")
        versus = e.get("vs_baseline", False)
        if versus:
            m_lo, m_hi = versus["matching_95"]
            l_lo, l_hi = versus["loss_95"]
            r_lo, r_hi = versus["off_ratio_95"]
            out.append(f"  vs {summary['baseline']}: matching {versus['matching']:+.2f} [{m_lo:+.2f}, {m_hi:+.2f}],"
                       f" mean loss {versus['loss']:+.2f} [{l_lo:+.2f}, {l_hi:+.2f}],"
                       f" times off x{versus['off_ratio']:.2f} [{r_lo:.2f}, {r_hi:.2f}]")
        elif versus is None:
            out.append(f"  vs {summary['baseline']}: not the same positions")
    return "\n".join(out)


def show(summary):
    """The summary as text, one block per player."""
    labels = {"allows_mate": "allows mate in one", "misses_mate": "misses mate in one",
              "en_prise": "piece en prise", "hung": "material hung"}
    out = []
    for name, p in summary["players"].items():
        head = f"{name}: {p['games']} games, {p['moves']} moves"
        if p["score"] is not None:
            head += f", score {p['score']:.1f}%"
        if p["rating"] is not None:
            head += f", rating {p['rating']} ({p['rating_source']})"
        out.append(head)
        for rate, label in labels.items():
            value = p[rate]
            target = p["people"][rate] if p["people"] is not None else None
            if rate == "misses_mate":
                text = "n/a" if value is None else f"{value:.1f}% of {p['mate_chances']} chances"
                people = None if target is None else f"{target:.1f}%"
            else:
                text = "n/a" if value is None else f"{value:.2f} per 100 moves"
                people = None if target is None else f"{target:.2f}"
            out.append(f"  {label + ':':21} {text:24}" + (f" people: {people}" if people else ""))
        if p["matching"] is not None:
            out.append(f"  {'move matching:':21} {p['matching']:.2f}%")
    return "\n".join(out)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--anchor", action="append", help="NAME=ELO")
    parser.add_argument("--rating", action="append", help="NAME=ELO")
    parser.add_argument("--matching", action="append", help="NAME=score.tsv")
    parser.add_argument("--json", help="also write the summary to this file")
    parser.add_argument("--workers", type=int, default=1)
    parser.add_argument("--reference", help="directory of Maia's test-<bin>.jsonl files")
    parser.add_argument("--reference-games", type=int, default=400)
    parser.add_argument("--positions", action="store_true",
                        help="the files are score.ts files: judge each engine's moves beside people's")
    parser.add_argument("--testset", default=str(TESTSET), help="directory of test-<bin>.jsonl (--positions)")
    parser.add_argument("--baseline", help="engine to compare the others with, by name (--positions)")
    parser.add_argument("--stockfish", default="stockfish", help="Stockfish command (--positions)")
    parser.add_argument("--depth", type=int, default=DEPTH, help="Stockfish's depth (--positions)")
    parser.add_argument("files", nargs="*", help="PGN files to analyse (score.ts files with --positions)")
    args = parser.parse_args()
    try:
        if args.reference:
            for bin_, values in reference(args.reference, args.reference_games, args.workers).items():
                print(bin_, values)
            return
        if not args.files:
            parser.error("no files given")
        if args.positions:
            summary = positions(args.files, args.testset, args.baseline, args.workers,
                                stockfish=args.stockfish, depth=args.depth)
            text = show_positions(summary)
        else:
            summary = analyse(args.files, pairs(args.anchor, "--anchor"), pairs(args.rating, "--rating"),
                              pairs(args.matching, "--matching"), args.workers)
            text = show(summary)
    except (OSError, ValueError) as error:
        parser.exit(1, f"{parser.prog}: {error}\n")
    print(text)
    if args.json:
        with open(args.json, "w", encoding="utf-8") as output:
            json.dump(summary, output, indent=2)
            output.write("\n")


if __name__ == "__main__":
    main()
