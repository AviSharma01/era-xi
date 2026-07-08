from __future__ import annotations

import unittest
from pathlib import Path

from scripts.prepare_draft_data import (
    ManualOverride,
    bowling_option_strength,
    build_player_metadata_template,
    build_draft_dataset,
    group_counts,
    load_player_metadata,
    load_player_metadata_with_validation,
    merge_manual_overrides,
)


def player_season(**overrides):
    base = {
        "id": "player-2016-team",
        "playerId": "player",
        "name": "Player",
        "franchise": "Team",
        "sourceSeason": "2016",
        "season": 2016,
        "matchesPlayed": 5,
        "inningsBatted": 5,
        "runs": 100,
        "ballsFaced": 80,
        "dismissals": 4,
        "wickets": 0,
        "legalBallsBowled": 0,
        "runsConceded": 0,
        "battingPositionCounts": {str(position): 0 for position in range(1, 12)},
        "naturalOpener": False,
        "preferredBattingPositions": [],
        "stumpingBasedWicketkeeperEvidence": {"dismissals": 0, "hasEvidence": False},
        "draftEligible": True,
    }
    base.update(overrides)
    return base


class DraftDataTests(unittest.TestCase):
    def test_opener_position_grouping(self) -> None:
        counts = {str(position): 0 for position in range(1, 12)}
        counts["1"] = 3
        counts["2"] = 2
        counts["3"] = 1
        grouped = group_counts(counts)
        self.assertEqual(grouped["opener"], 5)
        self.assertEqual(grouped["3"], 1)

    def test_natural_and_acceptable_positions_expand_opener_group(self) -> None:
        item = player_season(
            inningsBatted=6,
            battingPositionCounts={
                "1": 3,
                "2": 2,
                "3": 1,
                "4": 0,
                "5": 0,
                "6": 0,
                "7": 0,
                "8": 0,
                "9": 0,
                "10": 0,
                "11": 0,
            },
        )
        draft, _ = build_draft_dataset([item], {})
        self.assertEqual(draft[0]["naturalPositions"], [1, 2])
        self.assertEqual(draft[0]["acceptablePositions"], [1, 2, 3])

    def test_low_confidence_batting_samples(self) -> None:
        item = player_season(inningsBatted=3)
        draft, review = build_draft_dataset([item], {})
        self.assertEqual(draft[0]["positionConfidence"], "low")
        self.assertEqual(len(review["lowConfidencePositions"]), 1)

    def test_bowling_option_classification(self) -> None:
        self.assertEqual(bowling_option_strength(player_season(legalBallsBowled=190)), "frontline")
        self.assertEqual(bowling_option_strength(player_season(legalBallsBowled=80)), "secondary")
        self.assertEqual(bowling_option_strength(player_season(legalBallsBowled=12)), "part_time")
        self.assertEqual(bowling_option_strength(player_season(legalBallsBowled=0)), "none")

    def test_displayed_batting_average_uses_two_decimal_precision(self) -> None:
        draft, _ = build_draft_dataset([player_season(runs=100, dismissals=3)], {})
        self.assertAlmostEqual(draft[0]["displayedStats"]["battingAverage"], 33.33)

    def test_displayed_batting_average_is_null_for_zero_dismissals(self) -> None:
        draft, _ = build_draft_dataset([player_season(runs=75, dismissals=0)], {})
        self.assertIsNone(draft[0]["displayedStats"]["battingAverage"])

    def test_manual_override_precedence(self) -> None:
        item = player_season(
            stumpingBasedWicketkeeperEvidence={"dismissals": 2, "hasEvidence": True},
            runs=250,
            inningsBatted=8,
        )
        draft, review = build_draft_dataset(
            [item],
            {"player": ManualOverride(wicketkeeper=False, overseas=True)},
        )
        self.assertFalse(draft[0]["wicketkeeperStatus"])
        self.assertEqual(draft[0]["wicketkeeperStatusSource"], "manual")
        self.assertTrue(draft[0]["overseasStatus"])
        self.assertEqual(draft[0]["overseasStatusSource"], "manual")
        self.assertEqual(review["playersMissingWicketkeeperConfirmationWhereRelevant"], [])
        self.assertEqual(review["playersMissingOverseasStatus"], [])

    def test_player_metadata_takes_precedence_when_sources_are_merged(self) -> None:
        merged = merge_manual_overrides(
            {"player": ManualOverride(country="Australia", wicketkeeper=True, overseas=True)},
            {"player": ManualOverride(country="India", wicketkeeper=False, overseas=False)},
        )
        item = player_season(
            stumpingBasedWicketkeeperEvidence={"dismissals": 2, "hasEvidence": True},
            runs=250,
            inningsBatted=8,
        )
        draft, _ = build_draft_dataset([item], merged)
        self.assertEqual(draft[0]["country"], "India")
        self.assertFalse(draft[0]["isOverseas"])
        self.assertFalse(draft[0]["isWicketkeeper"])

    def test_no_batting_specialist_bowler_position_fallback(self) -> None:
        item = player_season(
            inningsBatted=0,
            runs=0,
            ballsFaced=0,
            wickets=10,
            legalBallsBowled=200,
            runsConceded=250,
        )
        draft, _ = build_draft_dataset([item], {})
        self.assertEqual(draft[0]["seasonRole"], "bowler")
        self.assertEqual(draft[0]["positionBasis"], "role_fallback")
        self.assertEqual(draft[0]["naturalPositions"], [9, 10, 11])
        self.assertEqual(draft[0]["acceptablePositions"], [8, 9, 10, 11])

    def test_no_batting_other_role_positions_remain_unresolved(self) -> None:
        item = player_season(inningsBatted=0, runs=200, ballsFaced=0)
        draft, _ = build_draft_dataset([item], {})
        self.assertEqual(draft[0]["seasonRole"], "batter")
        self.assertEqual(draft[0]["positionBasis"], "role_fallback")
        self.assertEqual(draft[0]["naturalPositions"], [])
        self.assertEqual(draft[0]["acceptablePositions"], [])

    def test_small_bowling_usage_does_not_turn_batter_into_all_rounder(self) -> None:
        item = player_season(
            runs=240,
            inningsBatted=10,
            ballsFaced=180,
            wickets=2,
            legalBallsBowled=42,
            runsConceded=60,
        )
        draft, _ = build_draft_dataset([item], {})
        self.assertEqual(draft[0]["seasonRole"], "batter")
        self.assertEqual(draft[0]["bowlingOptionStrength"], "part_time")

    def test_meaningful_bowling_can_make_batting_all_rounder(self) -> None:
        item = player_season(
            runs=240,
            inningsBatted=10,
            ballsFaced=180,
            wickets=3,
            legalBallsBowled=72,
            runsConceded=70,
        )
        draft, _ = build_draft_dataset([item], {})
        self.assertEqual(draft[0]["seasonRole"], "batting_all_rounder")

    def test_limited_batting_does_not_turn_bowler_into_all_rounder(self) -> None:
        item = player_season(
            inningsBatted=2,
            runs=12,
            ballsFaced=18,
            wickets=10,
            legalBallsBowled=200,
            runsConceded=240,
        )
        draft, _ = build_draft_dataset([item], {})
        self.assertEqual(draft[0]["seasonRole"], "bowler")

    def test_meaningful_batting_can_make_bowling_all_rounder(self) -> None:
        item = player_season(
            inningsBatted=4,
            runs=75,
            ballsFaced=50,
            wickets=10,
            legalBallsBowled=200,
            runsConceded=240,
        )
        draft, _ = build_draft_dataset([item], {})
        self.assertEqual(draft[0]["seasonRole"], "bowling_all_rounder")

    def test_repeated_lower_order_batting_alone_does_not_make_bowling_all_rounder(self) -> None:
        item = player_season(
            inningsBatted=5,
            runs=30,
            ballsFaced=35,
            wickets=10,
            legalBallsBowled=200,
            runsConceded=240,
        )
        draft, _ = build_draft_dataset([item], {})
        self.assertEqual(draft[0]["seasonRole"], "bowler")

    def test_wicketkeeper_status_remains_preserved_with_bowling_usage(self) -> None:
        item = player_season(
            runs=260,
            inningsBatted=10,
            ballsFaced=190,
            wickets=3,
            legalBallsBowled=60,
            runsConceded=80,
        )
        draft, _ = build_draft_dataset([item], {"player": ManualOverride(wicketkeeper=True)})
        self.assertEqual(draft[0]["seasonRole"], "wicketkeeper_batter")
        self.assertTrue(draft[0]["isWicketkeeper"])

    def test_manual_season_role_override_takes_precedence(self) -> None:
        item = player_season(
            runs=260,
            inningsBatted=10,
            ballsFaced=190,
            wickets=0,
            legalBallsBowled=0,
            runsConceded=0,
        )
        draft, review = build_draft_dataset([item], {"player": ManualOverride(season_role="bowler")})
        self.assertEqual(draft[0]["seasonRole"], "bowler")
        self.assertEqual(draft[0]["derivedSeasonRole"], "batter")
        self.assertEqual(draft[0]["seasonRoleSource"], "manual")
        self.assertEqual(len(review["manualSeasonRoleOverrides"]), 1)

    def test_observed_positions_get_observed_basis(self) -> None:
        item = player_season(
            inningsBatted=4,
            battingPositionCounts={
                "1": 0,
                "2": 0,
                "3": 4,
                "4": 0,
                "5": 0,
                "6": 0,
                "7": 0,
                "8": 0,
                "9": 0,
                "10": 0,
                "11": 0,
            },
        )
        draft, _ = build_draft_dataset([item], {})
        self.assertEqual(draft[0]["positionBasis"], "observed")

    def test_metadata_template_preserves_existing_manual_values(self) -> None:
        item = {
            "playerId": "player",
            "name": "Player",
        }
        template = build_player_metadata_template(
            [item],
            [{"playerId": "player", "name": "Old Name", "country": "India", "isOverseas": False, "isWicketkeeper": True}],
        )
        self.assertEqual(
            template,
            [{"playerId": "player", "name": "Player", "country": "India", "isOverseas": False, "isWicketkeeper": True}],
        )

    def test_player_metadata_template_loads_as_manual_override(self) -> None:
        overrides = load_player_metadata_from_rows(
            [{"playerId": "player", "country": "India", "isOverseas": False, "isWicketkeeper": True}]
        )
        item = player_season(runs=250, inningsBatted=8)
        draft, review = build_draft_dataset([item], overrides)
        self.assertEqual(draft[0]["country"], "India")
        self.assertFalse(draft[0]["overseasStatus"])
        self.assertTrue(draft[0]["wicketkeeperStatus"])
        self.assertEqual(review["playersMissingCountry"], [])
        self.assertEqual(review["playersMissingOverseasStatus"], [])

    def test_player_metadata_loader_reports_unknown_null_values_without_guessing(self) -> None:
        metadata = load_player_metadata_result_from_rows(
            [{"playerId": "player", "country": None, "isOverseas": None, "isWicketkeeper": None}]
        )
        self.assertEqual(metadata.invalid_rows, [])
        item = player_season()
        draft, review = build_draft_dataset([item], metadata.overrides)
        self.assertIsNone(draft[0]["country"])
        self.assertIsNone(draft[0]["isOverseas"])
        self.assertIsNone(draft[0]["isWicketkeeper"])
        self.assertEqual(len(review["playersMissingCountry"]), 1)
        self.assertEqual(len(review["playersMissingOverseasStatus"]), 1)

    def test_player_metadata_loader_reports_invalid_values(self) -> None:
        metadata = load_player_metadata_result_from_rows(
            [{"playerId": "player", "country": "", "isOverseas": "yes", "isWicketkeeper": 1}]
        )
        self.assertEqual([row["field"] for row in metadata.invalid_rows], ["country", "isWicketkeeper", "isOverseas"])
        self.assertEqual(metadata.overrides["player"], ManualOverride())

    def test_player_metadata_loader_reports_duplicate_ids(self) -> None:
        metadata = load_player_metadata_result_from_rows(
            [
                {"playerId": "player", "country": "India", "isOverseas": False, "isWicketkeeper": False},
                {"playerId": "player", "country": "Australia", "isOverseas": True, "isWicketkeeper": True},
            ]
        )
        self.assertEqual(metadata.duplicate_player_ids, [{"rowIndex": 1, "playerId": "player", "name": None}])
        self.assertEqual(metadata.overrides["player"].country, "India")

    def test_prepare_review_reports_unmatched_metadata_rows(self) -> None:
        import json
        import tempfile
        from pathlib import Path

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            processed_dir = root / "processed"
            manual_dir = root / "manual"
            processed_dir.mkdir()
            manual_dir.mkdir()
            (processed_dir / "player_seasons.json").write_text(json.dumps([player_season()]))
            metadata_path = manual_dir / "metadata.json"
            metadata_path.write_text(
                json.dumps(
                    [
                        {"playerId": "player", "country": "India", "isOverseas": False, "isWicketkeeper": False},
                        {"playerId": "unknown", "country": "India", "isOverseas": False, "isWicketkeeper": False},
                    ]
                )
            )
            _, review = prepare_outputs_for_test(processed_dir, metadata_path)
        self.assertEqual(review["summary"]["manualMetadataRowsLoaded"], 2)
        self.assertEqual(review["summary"]["manualMetadataRowsMatched"], 1)
        self.assertEqual(review["summary"]["manualMetadataUnmatchedRows"], 1)
        self.assertEqual(review["manualMetadata"]["unmatchedRows"], [{"playerId": "unknown"}])

    def test_processed_game_ready_rows_keep_metadata_fields(self) -> None:
        import json

        path = Path("data/processed/2016/draft_player_seasons.json")
        players = json.loads(path.read_text())
        self.assertGreater(len(players), 0)
        self.assertTrue(all("country" in player for player in players))
        self.assertTrue(all("isOverseas" in player for player in players))
        self.assertTrue(all("isWicketkeeper" in player for player in players))


def load_player_metadata_from_rows(rows):
    # Keep the public file-loader covered without coupling the test to repo data.
    import json
    import tempfile
    from pathlib import Path

    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "metadata.json"
        path.write_text(json.dumps(rows))
        return load_player_metadata(path)


def load_player_metadata_result_from_rows(rows):
    import json
    import tempfile
    from pathlib import Path

    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "metadata.json"
        path.write_text(json.dumps(rows))
        return load_player_metadata_with_validation(path)


def prepare_outputs_for_test(processed_dir, metadata_path):
    from pathlib import Path

    from scripts.prepare_draft_data import prepare_draft_outputs

    return prepare_draft_outputs(processed_dir, Path("missing-overrides.json"), metadata_path)


if __name__ == "__main__":
    unittest.main()
