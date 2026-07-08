from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from scripts.process_cricsheet import (
    Aggregator,
    BOWLER_WICKET_KINDS,
    is_legal_delivery,
    normalize_season,
    process_raw_matches,
    process_raw_sample,
    resolve_output_dir,
)


def delivery(
    batter: str,
    non_striker: str,
    bowler: str,
    batter_runs: int = 0,
    extras: dict[str, int] | None = None,
    wickets: list[dict] | None = None,
) -> dict:
    extras = extras or {}
    item = {
        "actual_delivery": "0.1",
        "batter": batter,
        "non_striker": non_striker,
        "bowler": bowler,
        "runs": {
            "batter": batter_runs,
            "extras": sum(extras.values()),
            "total": batter_runs + sum(extras.values()),
        },
    }
    if extras:
        item["extras"] = extras
    if wickets:
        item["wickets"] = wickets
    return item


def match(players: dict[str, list[str]], innings: list[dict], season: str = "2024") -> dict:
    registry_names = {name for names in players.values() for name in names}
    for innings_data in innings:
        for over in innings_data.get("overs", []):
            for item in over.get("deliveries", []):
                registry_names.add(item["batter"])
                registry_names.add(item["non_striker"])
                registry_names.add(item["bowler"])
                for wicket in item.get("wickets", []):
                    registry_names.add(wicket["player_out"])
                    for fielder in wicket.get("fielders", []):
                        registry_names.add(fielder["name"])
    return {
        "meta": {"data_version": "1.2.0", "created": "2026-01-01", "revision": 1},
        "info": {
            "dates": ["2024-01-01"],
            "event": {"name": "Indian Premier League", "match_number": 1},
            "season": season,
            "teams": list(players),
            "players": players,
            "registry": {"people": {name: name.lower().replace(" ", "-") for name in registry_names}},
            "match_type": "T20",
            "gender": "male",
            "team_type": "club",
            "overs": 20,
            "balls_per_over": 6,
        },
        "innings": innings,
    }


class PipelineUnitTests(unittest.TestCase):
    def process(self, data: dict) -> dict:
        aggregator = Aggregator()
        aggregator.process_match_data_for_test = None
        path = Path("synthetic.json")
        # Use the public methods below the file-reading boundary to keep tests small.
        info = data["info"]
        registry = info["registry"]["people"]
        source_season = info["season"]
        season = normalize_season(source_season)
        player_team = {}
        for franchise, names in info["players"].items():
            for name in names:
                player_id = aggregator.player_id_for(name, registry, str(path), franchise)
                player_team[player_id] = franchise
                player_season = aggregator.player_season_for(player_id, name, franchise, source_season, season)
                player_season.matches_played += 1
                aggregator.franchise_players[(franchise, source_season, season)].add(player_season.id)
        innings = data["innings"]
        if len(innings) > 2:
            aggregator.validation["matchesWithMoreThanTwoInnings"].append({"file": str(path), "inningsCount": len(innings)})
            aggregator.validation["extraInningsIgnored"] += len(innings) - 2
        for innings_data in innings[:2]:
            aggregator.process_innings(innings_data, registry, str(path), source_season, season, player_team)
        return aggregator.build_outputs()

    def player_season(self, outputs: dict, name: str) -> dict:
        matches = [item for item in outputs["player_seasons"] if item["name"] == name]
        self.assertEqual(len(matches), 1)
        return matches[0]

    def test_appearance_counting_uses_info_players(self) -> None:
        data = match(
            {"Team A": ["Alice", "Bea"], "Team B": ["Cara", "Dia"]},
            [
                {"team": "Team A", "overs": []},
                {"team": "Team B", "overs": []},
            ],
        )
        outputs = self.process(data)
        self.assertEqual(self.player_season(outputs, "Alice")["matchesPlayed"], 1)
        self.assertEqual(self.player_season(outputs, "Alice")["inningsBatted"], 0)

    def test_season_normalization(self) -> None:
        data = match({"Team A": ["Alice"], "Team B": ["Cara"]}, [], season="2007/08")
        outputs = self.process(data)
        alice = self.player_season(outputs, "Alice")
        self.assertEqual(alice["sourceSeason"], "2007/08")
        self.assertEqual(alice["season"], 2008)

    def test_opener_reconstruction_and_natural_opener(self) -> None:
        data = match(
            {"Team A": ["Alice", "Bea", "Nia"], "Team B": ["Cara", "Dia", "Bowler"]},
            [
                {
                    "team": "Team A",
                    "overs": [
                        {
                            "over": 0,
                            "deliveries": [
                                delivery("Alice", "Bea", "Bowler"),
                                delivery("Nia", "Alice", "Bowler"),
                            ],
                        }
                    ],
                }
            ],
        )
        outputs = self.process(data)
        alice = self.player_season(outputs, "Alice")
        bea = self.player_season(outputs, "Bea")
        nia = self.player_season(outputs, "Nia")
        self.assertEqual(alice["battingPositionCounts"]["1"], 1)
        self.assertEqual(bea["battingPositionCounts"]["2"], 1)
        self.assertEqual(nia["battingPositionCounts"]["3"], 1)
        self.assertTrue(alice["naturalOpener"])
        self.assertTrue(bea["naturalOpener"])
        self.assertFalse(nia["naturalOpener"])

    def test_new_batter_ordering_after_wicket(self) -> None:
        data = match(
            {"Team A": ["Alice", "Bea", "Nia"], "Team B": ["Bowler"]},
            [
                {
                    "team": "Team A",
                    "overs": [
                        {
                            "over": 0,
                            "deliveries": [
                                delivery(
                                    "Alice",
                                    "Bea",
                                    "Bowler",
                                    wickets=[{"kind": "bowled", "player_out": "Alice"}],
                                ),
                                delivery("Nia", "Bea", "Bowler"),
                            ],
                        }
                    ],
                }
            ],
        )
        nia = self.player_season(self.process(data), "Nia")
        self.assertEqual(nia["battingPositionCounts"]["3"], 1)

    def test_run_out_excluded_from_bowler_wickets(self) -> None:
        data = match(
            {"Team A": ["Alice", "Bea"], "Team B": ["Bowler", "Fielder"]},
            [
                {
                    "team": "Team A",
                    "overs": [
                        {
                            "over": 0,
                            "deliveries": [
                                delivery(
                                    "Alice",
                                    "Bea",
                                    "Bowler",
                                    wickets=[{"kind": "run out", "player_out": "Alice", "fielders": [{"name": "Fielder"}]}],
                                )
                            ],
                        }
                    ],
                }
            ],
        )
        outputs = self.process(data)
        self.assertEqual(self.player_season(outputs, "Bowler")["wickets"], 0)
        self.assertEqual(self.player_season(outputs, "Alice")["dismissals"], 1)

    def test_retired_hurt_does_not_count_as_batting_dismissal(self) -> None:
        data = match(
            {"Team A": ["Alice", "Bea"], "Team B": ["Bowler"]},
            [
                {
                    "team": "Team A",
                    "overs": [
                        {
                            "over": 0,
                            "deliveries": [
                                delivery(
                                    "Alice",
                                    "Bea",
                                    "Bowler",
                                    wickets=[{"kind": "retired hurt", "player_out": "Alice"}],
                                )
                            ],
                        }
                    ],
                }
            ],
        )
        outputs = self.process(data)
        self.assertEqual(self.player_season(outputs, "Alice")["dismissals"], 0)
        self.assertEqual(self.player_season(outputs, "Bowler")["wickets"], 0)

    def test_hit_wicket_attribution(self) -> None:
        self.assertIn("hit wicket", BOWLER_WICKET_KINDS)
        data = match(
            {"Team A": ["Alice", "Bea"], "Team B": ["Bowler"]},
            [
                {
                    "team": "Team A",
                    "overs": [
                        {
                            "over": 0,
                            "deliveries": [
                                delivery(
                                    "Alice",
                                    "Bea",
                                    "Bowler",
                                    wickets=[{"kind": "hit wicket", "player_out": "Alice"}],
                                )
                            ],
                        }
                    ],
                }
            ],
        )
        self.assertEqual(self.player_season(self.process(data), "Bowler")["wickets"], 1)

    def test_legal_ball_counting_for_wides_and_no_balls(self) -> None:
        self.assertFalse(is_legal_delivery(delivery("Alice", "Bea", "Bowler", extras={"wides": 1})))
        self.assertFalse(is_legal_delivery(delivery("Alice", "Bea", "Bowler", extras={"noballs": 1})))
        data = match(
            {"Team A": ["Alice", "Bea"], "Team B": ["Bowler"]},
            [
                {
                    "team": "Team A",
                    "overs": [
                        {
                            "over": 0,
                            "deliveries": [
                                delivery("Alice", "Bea", "Bowler", extras={"wides": 1}),
                                delivery("Alice", "Bea", "Bowler", batter_runs=2, extras={"noballs": 1}),
                                delivery("Alice", "Bea", "Bowler", batter_runs=4),
                            ],
                        }
                    ],
                }
            ],
        )
        outputs = self.process(data)
        self.assertEqual(self.player_season(outputs, "Bowler")["legalBallsBowled"], 1)
        self.assertEqual(self.player_season(outputs, "Alice")["ballsFaced"], 1)
        self.assertEqual(self.player_season(outputs, "Bowler")["runsConceded"], 8)

    def test_first_two_innings_aggregation(self) -> None:
        data = match(
            {"Team A": ["Alice", "Bea"], "Team B": ["Cara", "Dia"], "Team C": ["Extra", "Bowler"]},
            [
                {"team": "Team A", "overs": [{"over": 0, "deliveries": [delivery("Alice", "Bea", "Cara", batter_runs=1)]}]},
                {"team": "Team B", "overs": [{"over": 0, "deliveries": [delivery("Cara", "Dia", "Alice", batter_runs=2)]}]},
                {"team": "Team C", "overs": [{"over": 0, "deliveries": [delivery("Extra", "Bowler", "Alice", batter_runs=6)]}]},
            ],
        )
        outputs = self.process(data)
        self.assertEqual(self.player_season(outputs, "Extra")["runs"], 0)
        self.assertEqual(outputs["validation_summary"]["extraInningsIgnored"], 1)

    def test_two_match_draft_eligibility_threshold(self) -> None:
        aggregator = Aggregator()
        for file_name in ("one.json", "two.json"):
            data = match({"Team A": ["Alice"], "Team B": ["Cara"]}, [], season="2024")
            info = data["info"]
            registry = info["registry"]["people"]
            for franchise, names in info["players"].items():
                for name in names:
                    player_id = aggregator.player_id_for(name, registry, file_name, franchise)
                    player_season = aggregator.player_season_for(player_id, name, franchise, "2024", 2024)
                    player_season.matches_played += 1
                    aggregator.franchise_players[(franchise, "2024", 2024)].add(player_season.id)
        outputs = aggregator.build_outputs()
        self.assertTrue(self.player_season(outputs, "Alice")["draftEligible"])


class PipelineSampleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.outputs = process_raw_sample(Path("data/raw/sample"))

    def player_seasons(self, name: str) -> list[dict]:
        return [item for item in self.outputs["player_seasons"] if item["name"] == name]

    def test_impact_player_appearance_counting_from_sample(self) -> None:
        tripathi_2024 = [
            item for item in self.player_seasons("RA Tripathi")
            if item["season"] == 2024 and item["franchise"] == "Sunrisers Hyderabad"
        ][0]
        self.assertEqual(tripathi_2024["matchesPlayed"], 1)
        self.assertEqual(tripathi_2024["battingPositionCounts"]["5"], 1)

    def test_sample_two_match_draft_threshold(self) -> None:
        dhawan_2008 = [
            item for item in self.player_seasons("S Dhawan")
            if item["season"] == 2008 and item["franchise"] == "Delhi Daredevils"
        ][0]
        self.assertFalse(dhawan_2008["draftEligible"])


class PipelineSeasonFilteringTests(unittest.TestCase):
    def test_season_filter_uses_metadata_not_filename(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            raw_dir = Path(directory)
            (raw_dir / "looks-like-2016.json").write_text(
                json.dumps(match({"Old Team": ["Old Player"], "Other": ["Other Player"]}, [], season="2015"))
            )
            (raw_dir / "not-a-season-name.json").write_text(
                json.dumps(match({"New Team": ["New Player"], "Other": ["Other Player"]}, [], season="2016"))
            )

            outputs = process_raw_matches(raw_dir, season=2016)

        self.assertEqual(outputs["validation_summary"]["requestedSeason"], 2016)
        self.assertEqual(outputs["validation_summary"]["matchesFoundForRequestedSeason"], 1)
        self.assertEqual([item["name"] for item in outputs["players"]], ["New Player", "Other Player"])

    def test_default_season_output_dir_appends_season(self) -> None:
        self.assertEqual(resolve_output_dir(Path("data/processed"), 2016), Path("data/processed/2016"))
        self.assertEqual(resolve_output_dir(Path("custom-output"), 2016), Path("custom-output"))


if __name__ == "__main__":
    unittest.main()
