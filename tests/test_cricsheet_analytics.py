from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.cricsheet_analytics.aggregator import (
    AnalyticalAggregationError,
    _delivery_team_metric,
    _official_powerplay,
    build_analytical_rows,
    cricket_overs_to_balls,
    fixed_phase,
    player_team_season_id,
)
from scripts.cricsheet_analytics.builder import AnalyticalBuildError, build_analytical_archive
from scripts.cricsheet_analytics.integrity import EXPECTED_STAGE3_MANIFEST_HASH, load_verified_normalized_dataset
from scripts.cricsheet_analytics.schemas import build_schema_documents
from scripts.identity_registry.schemas import SchemaValidationError, validate_instance


ROOT = Path(__file__).resolve().parents[1]
NORMALIZED = ROOT / "data/normalized/cricsheet-ipl/v1"


class AnalyticsUnitTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.manifest = json.loads((NORMALIZED / "normalization_manifest.json").read_text())
        cls.entries = {entry["matchId"]: entry for entry in cls.manifest["matchFiles"]}

    def build_matches(self, *match_ids: str):
        values = []
        for match_id in match_ids:
            entry = self.entries[match_id]
            values.append((entry, json.loads((NORMALIZED / entry["path"]).read_text())))
        return build_analytical_rows(values)

    def test_fixed_phase_boundaries(self) -> None:
        self.assertEqual(fixed_phase(0), "powerplay")
        self.assertEqual(fixed_phase(5), "powerplay")
        self.assertEqual(fixed_phase(6), "middle")
        self.assertEqual(fixed_phase(15), "middle")
        self.assertEqual(fixed_phase(16), "death")
        self.assertEqual(fixed_phase(19), "death")
        with self.assertRaises(AnalyticalAggregationError):
            fixed_phase(20)

    def test_cricket_overs_notation_converts_to_exact_balls(self) -> None:
        self.assertEqual(cricket_overs_to_balls(9.2), 56)
        self.assertEqual(cricket_overs_to_balls(20), 120)
        with self.assertRaises(AnalyticalAggregationError):
            cricket_overs_to_balls(9.6)

    def test_canonical_player_team_season_id(self) -> None:
        self.assertEqual(player_team_season_id("player", "ipl-2016", "team-mumbai"), "pts:player:ipl-2016:team-mumbai")
        with self.assertRaises(AnalyticalAggregationError):
            player_team_season_id("bad:id", "ipl-2016", "team-mumbai")

    def test_delivery_metrics_keep_ball_predicates_independent(self) -> None:
        delivery = {
            "runs": {"batter": 0, "extras": 1, "total": 1, "nonBoundary": False},
            "extras": {"byes": 0, "legByes": 0, "noBalls": 1, "penalty": 0, "wides": 0},
            "isBowlerLegalDelivery": False, "countsAsBatterBall": True, "wickets": [],
        }
        metric = _delivery_team_metric(delivery)
        self.assertEqual(metric["legalBalls"], 0)
        self.assertEqual(metric["batterBalls"], 1)
        self.assertEqual(metric["battingDotBalls"], 0)

    def test_non_boundary_four_is_not_a_boundary(self) -> None:
        delivery = {
            "runs": {"batter": 4, "extras": 0, "total": 4, "nonBoundary": True},
            "extras": {"byes": 0, "legByes": 0, "noBalls": 0, "penalty": 0, "wides": 0},
            "isBowlerLegalDelivery": True, "countsAsBatterBall": True, "wickets": [],
        }
        self.assertEqual(_delivery_team_metric(delivery)["boundaryBalls"], 0)

    def test_official_powerplay_membership_is_inclusive_and_duplicate_safe(self) -> None:
        intervals = [{"from": 0.1, "to": 5.6, "type": "mandatory"}]
        self.assertTrue(_official_powerplay("0.1", intervals))
        self.assertTrue(_official_powerplay("5.6", intervals))
        self.assertFalse(_official_powerplay("6.1", intervals))

    def test_double_super_over_is_retained_but_excluded(self) -> None:
        rows, metadata = self.build_matches("1216517")
        match = rows["matchSummaries"][0]
        self.assertEqual(match["superOverInnings"], 4)
        self.assertEqual(len(match["normalInnings"]), 2)
        self.assertEqual(metadata["stage3Counts"]["superOverInnings"], 4)

    def test_event_only_participant_has_separate_counts(self) -> None:
        rows, _ = self.build_matches("335991")
        profiles = [p for p in rows["playerTeamSeasons"] if any(c["eventOnly"] for c in p["participation"]["matchContributions"])]
        self.assertTrue(profiles)
        for profile in profiles:
            self.assertEqual(profile["participation"]["officialListMatchCount"], 0)
            self.assertEqual(profile["participation"]["documentedInvolvementMatchCount"], 1)

    def test_impact_replacements_are_reason_specific(self) -> None:
        rows, metadata = self.build_matches("1359507")
        self.assertGreater(metadata["distributions"]["evidenceEventCounts"]["impactReplacements"], 0)
        self.assertTrue(any(
            c["replacementEvents"]["impactIn"] or c["replacementEvents"]["impactOut"]
            for p in rows["playerTeamSeasons"] for c in p["participation"]["matchContributions"]
        ))

    def test_dls_match_has_adjusted_cohort(self) -> None:
        rows, _ = self.build_matches("336022")
        self.assertEqual(rows["matchSummaries"][0]["cohort"], "adjusted")

    def test_generated_schemas_reject_extra_properties(self) -> None:
        rows, _ = self.build_matches("335982")
        schema = build_schema_documents()["match_summary.schema.json"]
        adversary = dict(rows["matchSummaries"][0]); adversary["unexpected"] = True
        with self.assertRaises(SchemaValidationError):
            validate_instance(adversary, schema)

    def test_small_build_is_deterministic(self) -> None:
        first, _ = self.build_matches("335982", "335991")
        second, _ = self.build_matches("335982", "335991")
        self.assertEqual(json.dumps(first, sort_keys=True), json.dumps(second, sort_keys=True))

    def test_input_failure_publishes_nothing(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "v1"
            with patch("scripts.cricsheet_analytics.builder.load_verified_normalized_dataset", side_effect=ValueError("interrupted")):
                with self.assertRaises(ValueError):
                    build_analytical_archive(output_dir=output)
            self.assertFalse(output.exists())


class AnalyticsArchiveIntegrityTests(unittest.TestCase):
    def test_stage3_loader_verifies_pinned_manifest(self) -> None:
        verified = load_verified_normalized_dataset(NORMALIZED)
        self.assertEqual(verified.manifest["normalizationManifestHash"], EXPECTED_STAGE3_MANIFEST_HASH)
        self.assertEqual(len(verified.manifest["matchFiles"]), 1243)


if __name__ == "__main__":
    unittest.main()
