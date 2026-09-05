from __future__ import annotations

import hashlib
import json
import math
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path

from scripts.identity_registry.schemas import SchemaValidationError, validate_instance
from scripts.player_quality_ratings import (
    BAT_WEIGHTS,
    BOWL_WEIGHTS,
    EXPECTED_CALIBRATION,
    PlayerQualityError,
    batting_evidence,
    bowling_evidence,
    build_player_quality_files,
    build_quality_schemas,
    calculate_batting_primitives,
    calculate_bowling_primitives,
    calculate_quality_dataset,
    rating_from_internal,
    raw_quality_tier,
    season_baseline,
    secondary_bonus,
    write_artifact_tree,
)


def jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line]


class FormulaTests(unittest.TestCase):
    baseline = {
        "battingRunRatePerBall": 1.25,
        "battingAverage": 25.0,
        "batterRunsPerInnings": 150.0,
        "bowlingEconomyPerSixBalls": 7.5,
        "bowlerWicketRatePerBall": 0.05,
        "creditedWicketsPerInnings": 6.0,
    }

    def test_evidence_boundaries_are_exact(self) -> None:
        self.assertEqual(batting_evidence(0, 0, 0), "NONE")
        self.assertEqual(batting_evidence(1, 89, 4), "LIMITED")
        self.assertEqual(batting_evidence(1, 90, 3), "LIMITED")
        self.assertEqual(batting_evidence(1, 90, 4), "ESTABLISHED")
        self.assertEqual(bowling_evidence(0, 0), "NONE")
        self.assertEqual(bowling_evidence(1, 107), "LIMITED")
        self.assertEqual(bowling_evidence(1, 108), "ESTABLISHED")

    def test_b50_m_primitives_recompute_from_the_frozen_formula(self) -> None:
        actual = calculate_batting_primitives(
            runs=240,
            balls=150,
            dismissals=6,
            team_batting_innings=12,
            baseline=self.baseline,
        )
        shrunk_rate = (240 + 90 * 1.25) / (150 + 90)
        shrunk_average = (240 + 4 * 25) / (6 + 4)
        self.assertEqual(actual["production"], (240 / 12) / 150)
        self.assertEqual(actual["scoring"], math.log(shrunk_rate / 1.25))
        self.assertEqual(actual["survival"], math.log(shrunk_average / 25))

    def test_q50_s_primitives_recompute_from_the_frozen_formula(self) -> None:
        actual = calculate_bowling_primitives(
            wickets=18,
            legal_balls=240,
            runs_conceded=270,
            team_bowling_innings=12,
            baseline=self.baseline,
        )
        shrunk_economy = 6 * (270 + 108 * 7.5 / 6) / (240 + 108)
        shrunk_wicket_rate = (18 + 108 * 0.05) / (240 + 108)
        self.assertEqual(actual["production"], (18 / 12) / 6)
        self.assertEqual(actual["economy"], math.log(7.5 / shrunk_economy))
        self.assertEqual(actual["wicketRate"], math.log(shrunk_wicket_rate / 0.05))

    def test_team_opportunity_and_efficiency_primitives_are_monotonic(self) -> None:
        batting = dict(runs=120, balls=90, dismissals=4, team_batting_innings=10, baseline=self.baseline)
        base_bat = calculate_batting_primitives(**batting)
        more_team_innings = calculate_batting_primitives(**{**batting, "team_batting_innings": 20})
        fewer_balls = calculate_batting_primitives(**{**batting, "balls": 60})
        fewer_dismissals = calculate_batting_primitives(**{**batting, "dismissals": 2})
        self.assertLess(more_team_innings["production"], base_bat["production"])
        self.assertEqual(more_team_innings["scoring"], base_bat["scoring"])
        self.assertEqual(more_team_innings["survival"], base_bat["survival"])
        self.assertGreater(fewer_balls["scoring"], base_bat["scoring"])
        self.assertGreater(fewer_dismissals["survival"], base_bat["survival"])

        bowling = dict(wickets=10, legal_balls=120, runs_conceded=150, team_bowling_innings=10, baseline=self.baseline)
        base_bowl = calculate_bowling_primitives(**bowling)
        more_team_innings_bowl = calculate_bowling_primitives(**{**bowling, "team_bowling_innings": 20})
        more_wickets = calculate_bowling_primitives(**{**bowling, "wickets": 12})
        fewer_runs = calculate_bowling_primitives(**{**bowling, "runs_conceded": 120})
        self.assertLess(more_team_innings_bowl["production"], base_bowl["production"])
        self.assertEqual(more_team_innings_bowl["economy"], base_bowl["economy"])
        self.assertEqual(more_team_innings_bowl["wicketRate"], base_bowl["wicketRate"])
        self.assertGreater(more_wickets["production"], base_bowl["production"])
        self.assertGreater(more_wickets["wicketRate"], base_bowl["wicketRate"])
        self.assertGreater(fewer_runs["economy"], base_bowl["economy"])

    def test_rating_tiers_and_secondary_bonus_are_frozen(self) -> None:
        self.assertEqual(rating_from_internal(0), 60)
        self.assertEqual(
            rating_from_internal(1.25),
            60 + 40 * math.tanh(1.25 / 1.8),
        )
        self.assertLess(rating_from_internal(-1), rating_from_internal(0))
        self.assertGreater(rating_from_internal(1), rating_from_internal(0))
        self.assertEqual(raw_quality_tier(0.90), "S")
        self.assertEqual(raw_quality_tier(0.45), "A")
        self.assertEqual(raw_quality_tier(-0.45), "B")
        self.assertEqual(raw_quality_tier(-0.90), "C")
        self.assertEqual(raw_quality_tier(-0.900001), "D")
        self.assertEqual(secondary_bonus(1.5, "ESTABLISHED", 2.0, "ESTABLISHED"), 0.2)
        self.assertEqual(secondary_bonus(0.5, "ESTABLISHED", 1.0, "ESTABLISHED"), 0.1)
        self.assertEqual(secondary_bonus(-0.1, "ESTABLISHED", 1.0, "ESTABLISHED"), 0.0)
        self.assertEqual(secondary_bonus(1.5, "LIMITED", 2.0, "ESTABLISHED"), 0.0)

    def test_invalid_team_and_season_denominators_fail_closed(self) -> None:
        with self.assertRaises(PlayerQualityError):
            calculate_batting_primitives(
                runs=0, balls=0, dismissals=0, team_batting_innings=0, baseline=self.baseline
            )
        with self.assertRaises(PlayerQualityError):
            calculate_bowling_primitives(
                wickets=0, legal_balls=0, runs_conceded=0,
                team_bowling_innings=0, baseline=self.baseline,
            )


class PlayerQualityIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.files, cls.report = build_player_quality_files()
        cls.profiles = [
            json.loads(line)
            for line in cls.files["player_team_season_quality.jsonl"].decode().splitlines()
        ]
        cls.consumers = [
            json.loads(line)
            for line in cls.files["player_quality_consumer.jsonl"].decode().splitlines()
        ]
        cls.model = json.loads(cls.files["quality_model.json"])
        cls.queue = json.loads(cls.files["review_queue.json"])
        cls.manifest = json.loads(cls.files["quality_manifest.json"])
        cls.schemas = build_quality_schemas()

        analytical = Path("data/analytical/cricsheet-ipl/v1")
        eligibility = Path("data/processed/era-draft/v1")
        cls.player_rows = jsonl(analytical / "player_team_seasons.jsonl")
        cls.team_rows = jsonl(analytical / "team_seasons.jsonl")
        cls.environment_rows = jsonl(analytical / "season_environments.jsonl")
        cls.eligible_ids = {
            row["playerTeamSeasonId"]
            for row in jsonl(eligibility / "eligibility.jsonl")
            if row["eligibilityStatus"] == "ELIGIBLE"
        }

    def test_frozen_coverage_evidence_primary_and_tiers(self) -> None:
        self.assertEqual(self.report["status"], "passed")
        self.assertEqual(self.report["counts"], {
            "g2Profiles": 2992,
            "g2Players": 727,
            "battingNone": 216,
            "battingLimited": 1698,
            "battingEstablished": 1078,
            "bowlingNone": 1025,
            "bowlingLimited": 943,
            "bowlingEstablished": 1024,
            "battingPrimary": 1593,
            "bowlingPrimary": 1399,
            "secondaryBonusRecipients": 29,
            "limitedUpperTierCases": 10,
            "limitedDFloorCases": 626,
            "blockingReviewCases": 0,
        })
        self.assertEqual(self.report["qualityTierCounts"], {
            "S": 332, "A": 318, "B": 948, "C": 1243, "D": 151,
        })
        self.assertEqual(len(self.profiles), 2992)
        self.assertEqual(len(self.consumers), 2992)
        self.assertEqual(len({row["playerTeamSeasonId"] for row in self.profiles}), 2992)
        self.assertEqual(len({row["playerId"] for row in self.profiles}), 727)

    def test_calibration_constants_and_component_distributions_are_frozen(self) -> None:
        for discipline, metrics in EXPECTED_CALIBRATION.items():
            for metric, expected in metrics.items():
                actual = self.model[discipline]["calibration"][metric]
                self.assertAlmostEqual(actual["median"], expected[0], places=11)
                self.assertAlmostEqual(actual["mad"], expected[1], places=11)
                self.assertAlmostEqual(actual["robustSpread"], expected[2], places=11)
        self.assertEqual(self.report["componentDistributions"], {
            "B": {
                "count": 2776, "minimum": -2.223641, "p5": -1.610401,
                "p10": -1.479668, "p25": -1.267083, "median": -0.972946,
                "p75": -0.201169, "p90": 0.586407, "p95": 1.087841,
                "maximum": 3.33357, "mad": 0.407068, "robustSpread": 0.603519,
            },
            "Q": {
                "count": 1967, "minimum": -2.201207, "p5": -1.525412,
                "p10": -1.361335, "p25": -1.091386, "median": -0.610482,
                "p75": 0.086189, "p90": 0.723618, "p95": 1.118024,
                "maximum": 2.582798, "mad": 0.540609, "robustSpread": 0.801507,
            },
        })

    def test_every_published_b_and_q_recomputes_from_stage4(self) -> None:
        source_by_id = {row["playerTeamSeasonId"]: row for row in self.player_rows}
        team_by_id = {row["teamSeasonId"]: row for row in self.team_rows}
        environment_by_id = {row["seasonId"]: row for row in self.environment_rows}
        for profile in self.profiles:
            source = source_by_id[profile["playerTeamSeasonId"]]
            team = team_by_id[f"ts:{source['teamId']}:{source['seasonId']}"]
            baseline = season_baseline(environment_by_id[source["seasonId"]])
            if profile["batting"]["evidenceState"] != "NONE":
                totals = source["batting"]["totals"]
                primitives = calculate_batting_primitives(
                    runs=totals["runs"], balls=totals["balls"],
                    dismissals=totals["dismissals"],
                    team_batting_innings=team["batting"]["innings"], baseline=baseline,
                )
                for metric, value in primitives.items():
                    self.assertAlmostEqual(profile["batting"]["primitives"][metric], value, places=5)
                score = sum(
                    BAT_WEIGHTS[metric]
                    * (value - self.model["batting"]["calibration"][metric]["median"])
                    / self.model["batting"]["calibration"][metric]["robustSpread"]
                    for metric, value in primitives.items()
                )
                self.assertAlmostEqual(profile["batting"]["internalScore"], score, places=5)
            if profile["bowling"]["evidenceState"] != "NONE":
                totals = source["bowling"]["totals"]
                primitives = calculate_bowling_primitives(
                    wickets=totals["creditedWickets"], legal_balls=totals["legalBalls"],
                    runs_conceded=totals["runsConceded"],
                    team_bowling_innings=team["bowling"]["innings"], baseline=baseline,
                )
                for metric, value in primitives.items():
                    self.assertAlmostEqual(profile["bowling"]["primitives"][metric], value, places=5)
                score = sum(
                    BOWL_WEIGHTS[metric]
                    * (value - self.model["bowling"]["calibration"][metric]["median"])
                    / self.model["bowling"]["calibration"][metric]["robustSpread"]
                    for metric, value in primitives.items()
                )
                self.assertAlmostEqual(profile["bowling"]["internalScore"], score, places=5)

    def test_nullability_primary_bonus_and_limited_floor_invariants(self) -> None:
        for profile in self.profiles:
            for discipline, rating_field in (
                ("batting", "battingRating"), ("bowling", "bowlingRating")
            ):
                component = profile[discipline]
                values = (
                    component["primitives"], component["standardizedPrimitives"],
                    component["internalScore"], component[rating_field],
                )
                self.assertEqual(component["evidenceState"] == "NONE", all(value is None for value in values))
            overall = profile["overall"]
            primary = profile[overall["primaryComponent"].lower()]
            self.assertEqual(overall["evidenceState"], primary["evidenceState"])
            self.assertEqual(overall["primaryInternalScore"], primary["internalScore"])
            available = [
                component["internalScore"]
                for component in (profile["batting"], profile["bowling"])
                if component["internalScore"] is not None
            ]
            self.assertGreaterEqual(overall["primaryInternalScore"] + 0.000002, max(available))
            both_established = all(
                profile[key]["evidenceState"] == "ESTABLISHED"
                for key in ("batting", "bowling")
            )
            if not both_established:
                self.assertEqual(overall["secondaryBonus"], 0)
            self.assertLessEqual(overall["secondaryBonus"], 0.2)

        bonuses = [row["overall"]["secondaryBonus"] for row in self.profiles if row["overall"]["secondaryBonus"] > 0]
        self.assertEqual(len(bonuses), 29)
        self.assertEqual(self.report["secondaryBonus"], {
            "eligibleProfiles": 183,
            "recipientProfiles": 29,
            "medianAmongRecipients": 0.035984,
            "p90AmongRecipients": 0.143302,
            "maximum": 0.2,
        })
        self.assertEqual(sum(row["overall"]["tierDecision"]["limitedDFloorApplied"] for row in self.profiles), 626)

    def test_review_queue_contains_only_nonblocking_sparse_evidence_diagnostics(self) -> None:
        self.assertEqual(self.queue["summary"], {
            "blockingCases": 0,
            "limitedUpperTierCases": 10,
            "limitedDFloorCases": 626,
        })
        self.assertEqual(self.queue["blockingItems"], [])
        self.assertTrue(all(row["reviewStatus"] == "DIAGNOSTIC_ONLY" for row in self.queue["limitedUpperTierItems"]))
        self.assertTrue(all(row["reviewStatus"] == "DIAGNOSTIC_ONLY" for row in self.queue["limitedDFloorItems"]))

    def test_json_schemas_are_strict_and_validate_every_generated_record(self) -> None:
        for index, row in enumerate(self.profiles):
            validate_instance(row, self.schemas["player_team_season_quality.schema.json"], f"profile[{index}]")
        for index, row in enumerate(self.consumers):
            validate_instance(row, self.schemas["player_quality_consumer.schema.json"], f"consumer[{index}]")
        invalid = deepcopy(self.consumers[0])
        invalid["baseRating"] = 80
        with self.assertRaises(SchemaValidationError):
            validate_instance(invalid, self.schemas["player_quality_consumer.schema.json"], "invalid")
        none_row = deepcopy(next(row for row in self.consumers if row["bowling"]["evidenceState"] == "NONE"))
        none_row["bowling"]["bowlingRating"] = 60
        with self.assertRaises(SchemaValidationError):
            validate_instance(none_row, self.schemas["player_quality_consumer.schema.json"], "invalidNone")

    def test_manifest_pins_only_actual_stage4_and_g2_inputs(self) -> None:
        self.assertEqual(
            [(row["source"], row["path"]) for row in self.manifest["ratingInputs"]],
            [
                ("STAGE_4_ANALYTICAL", "player_team_seasons.jsonl"),
                ("STAGE_4_ANALYTICAL", "team_seasons.jsonl"),
                ("STAGE_4_ANALYTICAL", "season_environments.jsonl"),
                ("G2_ELIGIBILITY", "eligibility.jsonl"),
            ],
        )
        serialized = json.dumps(self.manifest).lower()
        for forbidden in ("role", "keeper", "bowling_family", "country", "overseas", "classic"):
            self.assertNotIn(forbidden, serialized)
        self.assertNotIn("effectiveScore", self.files["player_team_season_quality.jsonl"].decode())
        self.assertFalse(any("adjust" in path.lower() for path in self.files))

    def test_stage5_keeper_bowling_family_and_overseas_fields_cannot_affect_quality(self) -> None:
        mutated_rows = list(self.player_rows)
        index = next(
            index for index, row in enumerate(mutated_rows)
            if row["playerTeamSeasonId"] in self.eligible_ids
        )
        mutated = deepcopy(mutated_rows[index])
        mutated.update({
            "derivedRole": "BOWLER",
            "positionFit": {"1": "NATURAL"},
            "wicketkeeperStatus": "CONFIRMED",
            "bowlingFamily": "SPIN",
            "country": "TEST",
            "isOverseas": True,
        })
        mutated_rows[index] = mutated
        profiles, consumers, _ = calculate_quality_dataset(
            player_rows=mutated_rows,
            team_rows=self.team_rows,
            environment_rows=self.environment_rows,
            eligible_ids=self.eligible_ids,
        )
        self.assertEqual(profiles, self.profiles)
        self.assertEqual(consumers, self.consumers)

    def test_repeated_builds_and_writes_are_byte_identical(self) -> None:
        second_files, second_report = build_player_quality_files()
        self.assertEqual(self.files, second_files)
        self.assertEqual(self.report, second_report)
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "quality"
            write_artifact_tree(output, self.files)
            for path, content in self.files.items():
                self.assertEqual((output / path).read_bytes(), content)

    def test_classic_2016_generated_artifacts_are_unchanged(self) -> None:
        expected = {
            "data/processed/2016/draft_player_seasons.json": "1f37ce41d88896e79597d15c857d130bd52cfce94873d93c8db0e36d057c6a92",
            "data/processed/2016/rated_player_seasons.json": "fa32a8eaf0e91e5640ffe319eeb931d39a91c3e7dee538d13c1ebe10e889444d",
            "data/processed/2016/ratings_review.json": "253c5f9a3ba1c52b57b8e99636bf367bb5f6a9244208b8fb9247b2b393422f08",
        }
        for path, digest in expected.items():
            self.assertEqual(hashlib.sha256(Path(path).read_bytes()).hexdigest(), digest)


if __name__ == "__main__":
    unittest.main()
