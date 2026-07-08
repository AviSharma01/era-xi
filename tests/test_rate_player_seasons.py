from __future__ import annotations

import copy
import json
import tempfile
import unittest
from pathlib import Path

from scripts.rate_player_seasons import (
    RATING_MAX,
    RATING_MIN,
    SOFT_CAP_START_RAW_SCORE,
    calculate_baselines,
    canonical_rated_players,
    has_meaningful_bowling,
    apply_draft_tier_coverage,
    draft_tier_coverage_target,
    rating_from_raw,
    rate_player,
    rate_player_seasons,
    secondary_bonus,
    soft_capped_raw_score,
    provisional_tier,
    write_json,
)


def player(**overrides):
    base = {
        "id": "player-2016-team",
        "playerId": "player",
        "name": "Player",
        "franchise": "Team",
        "sourceSeason": "2016",
        "season": 2016,
        "matchesPlayed": 10,
        "inningsBatted": 10,
        "runs": 260,
        "ballsFaced": 200,
        "dismissals": 8,
        "wickets": 0,
        "legalBallsBowled": 0,
        "runsConceded": 0,
        "battingPositionCounts": {str(position): 0 for position in range(1, 12)},
        "battingPositionGroupCounts": {
            "opener": 0,
            "3": 0,
            "4": 5,
            "5": 5,
            "6": 0,
            "7": 0,
            "8": 0,
            "9": 0,
            "10": 0,
            "11": 0,
        },
        "naturalOpener": False,
        "preferredBattingPositions": [4],
        "stumpingBasedWicketkeeperEvidence": {"dismissals": 0, "hasEvidence": False},
        "draftEligible": True,
        "naturalPositions": [4, 5],
        "acceptablePositions": [4, 5],
        "positionBasis": "observed",
        "positionConfidence": "high",
        "seasonRole": "batter",
        "bowlingOptionStrength": "none",
        "displayedStats": {},
        "country": "India",
        "countrySource": "manual",
        "isWicketkeeper": False,
        "wicketkeeperStatus": False,
        "wicketkeeperStatusSource": "manual",
        "isOverseas": False,
        "overseasStatus": False,
        "overseasStatusSource": "manual",
    }
    base.update(overrides)
    return base


def bowling_player(**overrides):
    base = player(
        seasonRole="bowler",
        inningsBatted=1,
        runs=5,
        ballsFaced=8,
        dismissals=1,
        wickets=10,
        legalBallsBowled=180,
        runsConceded=240,
        battingPositionGroupCounts={
            "opener": 0,
            "3": 0,
            "4": 0,
            "5": 0,
            "6": 0,
            "7": 0,
            "8": 0,
            "9": 1,
            "10": 0,
            "11": 0,
        },
        bowlingOptionStrength="frontline",
    )
    base.update(overrides)
    return base


def baselines():
    sample = [
        player(runs=500, ballsFaced=360, dismissals=12, wickets=0, legalBallsBowled=0, runsConceded=0),
        player(runs=260, ballsFaced=200, dismissals=8, wickets=0, legalBallsBowled=0, runsConceded=0),
        bowling_player(runs=20, ballsFaced=20, dismissals=2, wickets=16, legalBallsBowled=300, runsConceded=390),
        bowling_player(runs=10, ballsFaced=10, dismissals=1, wickets=8, legalBallsBowled=240, runsConceded=300),
    ]
    return calculate_baselines(sample)


class RatingModelTests(unittest.TestCase):
    def setUp(self) -> None:
        self.baselines = baselines()

    def rate(self, item):
        return rate_player(item, self.baselines)

    def test_batting_production_affects_rating(self) -> None:
        low = self.rate(player(runs=150, ballsFaced=120, dismissals=5))
        high = self.rate(player(runs=300, ballsFaced=240, dismissals=10))
        self.assertGreater(high["battingRating"], low["battingRating"])

    def test_batting_efficiency_affects_rating(self) -> None:
        ordinary = self.rate(player(runs=260, ballsFaced=220, dismissals=8))
        efficient = self.rate(player(runs=260, ballsFaced=160, dismissals=6))
        self.assertGreater(efficient["battingRating"], ordinary["battingRating"])

    def test_bowling_production_affects_rating(self) -> None:
        low = self.rate(bowling_player(wickets=6, legalBallsBowled=180, runsConceded=230))
        high = self.rate(bowling_player(wickets=14, legalBallsBowled=180, runsConceded=230))
        self.assertGreater(high["bowlingRating"], low["bowlingRating"])

    def test_bowling_efficiency_affects_rating(self) -> None:
        expensive = self.rate(bowling_player(wickets=10, legalBallsBowled=180, runsConceded=270))
        economical = self.rate(bowling_player(wickets=10, legalBallsBowled=180, runsConceded=210))
        self.assertGreater(economical["bowlingRating"], expensive["bowlingRating"])

    def test_small_sample_shrinkage_limits_extreme_batting(self) -> None:
        tiny = self.rate(player(matchesPlayed=2, inningsBatted=2, runs=45, ballsFaced=15, dismissals=0))
        full = self.rate(player(inningsBatted=12, runs=360, ballsFaced=270, dismissals=9))
        self.assertLess(tiny["battingRating"], full["battingRating"])
        self.assertEqual(tiny["ratingConfidence"], "low")

    def test_zero_dismissal_batting_is_finite(self) -> None:
        rated = self.rate(player(runs=80, ballsFaced=55, dismissals=0))
        self.assertIsNotNone(rated["battingRating"])
        self.assertGreaterEqual(rated["battingRating"], RATING_MIN)
        self.assertLessEqual(rated["battingRating"], RATING_MAX)

    def test_zero_wicket_bowling_is_finite(self) -> None:
        rated = self.rate(bowling_player(wickets=0, legalBallsBowled=120, runsConceded=140))
        self.assertIsNotNone(rated["bowlingRating"])
        self.assertGreaterEqual(rated["bowlingRating"], RATING_MIN)
        self.assertLessEqual(rated["bowlingRating"], RATING_MAX)

    def test_role_weighted_overall_and_secondary_reweighting(self) -> None:
        all_rounder = self.rate(
            player(
                seasonRole="batting_all_rounder",
                runs=300,
                ballsFaced=220,
                dismissals=8,
                wickets=1,
                legalBallsBowled=24,
                runsConceded=40,
            )
        )
        self.assertEqual(all_rounder["ratingBreakdown"]["appliedRoleWeights"], {"batting": 1.0, "bowling": 0.0})
        self.assertEqual(all_rounder["baseRating"], all_rounder["battingRating"])
        self.assertTrue(all_rounder["ratingBreakdown"]["roleReviewFlags"])

    def test_bowling_all_rounder_requires_meaningful_batting_for_batting_weight(self) -> None:
        item = bowling_player(
            seasonRole="bowling_all_rounder",
            inningsBatted=1,
            runs=8,
            ballsFaced=9,
            dismissals=1,
            wickets=12,
            legalBallsBowled=220,
            runsConceded=260,
        )
        rated = self.rate(item)
        self.assertEqual(rated["ratingBreakdown"]["appliedRoleWeights"], {"batting": 0.0, "bowling": 1.0})
        self.assertTrue(rated["ratingBreakdown"]["roleReviewFlags"])

    def test_bowler_batting_bonus_is_capped_and_non_negative(self) -> None:
        rated = self.rate(bowling_player(runs=160, ballsFaced=90, dismissals=4, wickets=12, legalBallsBowled=240))
        bonus = rated["ratingBreakdown"]["baseRatingCalculation"]["battingBonus"]["bonus"]
        self.assertGreaterEqual(bonus, 0)
        self.assertLessEqual(bonus, 4)
        self.assertGreaterEqual(rated["baseRating"], rated["bowlingRating"])

    def test_rating_bounds(self) -> None:
        rated_players, _ = rate_player_seasons(
            [
                player(runs=900, ballsFaced=450, dismissals=4),
                player(runs=1, ballsFaced=40, dismissals=10),
                bowling_player(wickets=30, legalBallsBowled=360, runsConceded=250),
                bowling_player(wickets=0, legalBallsBowled=180, runsConceded=300),
            ]
        )
        for item in rated_players:
            self.assertGreaterEqual(item["baseRating"], RATING_MIN)
            self.assertLessEqual(item["baseRating"], RATING_MAX)
            if item["battingRating"] is not None:
                self.assertGreaterEqual(item["battingRating"], RATING_MIN)
                self.assertLessEqual(item["battingRating"], RATING_MAX)
            if item["bowlingRating"] is not None:
                self.assertGreaterEqual(item["bowlingRating"], RATING_MIN)
                self.assertLessEqual(item["bowlingRating"], RATING_MAX)

    def test_deterministic_outputs(self) -> None:
        rows = [player(name="B", playerId="b"), bowling_player(name="A", playerId="a")]
        first, first_review = rate_player_seasons(copy.deepcopy(rows))
        second, second_review = rate_player_seasons(copy.deepcopy(rows))
        self.assertEqual(json.dumps(first, sort_keys=True), json.dumps(second, sort_keys=True))
        self.assertEqual(json.dumps(first_review, sort_keys=True), json.dumps(second_review, sort_keys=True))

    def test_write_json_is_deterministic_with_sorted_keys_not_required(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "out.json"
            write_json(path, {"items": [1, 2]})
            self.assertEqual(json.loads(path.read_text()), {"items": [1, 2]})

    def test_tier_assignment_is_separate_from_descriptive_ranges(self) -> None:
        self.assertEqual(provisional_tier(72.0), "S")
        self.assertEqual(provisional_tier(73.0), "S")
        self.assertEqual(provisional_tier(62.5), "B")

    def test_more_runs_same_average_and_strike_rate_does_not_lower_batting_rating(self) -> None:
        lower = self.rate(player(runs=180, ballsFaced=120, dismissals=6, inningsBatted=6))
        higher = self.rate(player(runs=300, ballsFaced=200, dismissals=10, inningsBatted=10))
        self.assertGreaterEqual(higher["battingRating"], lower["battingRating"])

    def test_better_strike_rate_equal_production_does_not_lower_batting_rating(self) -> None:
        slower = self.rate(player(runs=240, ballsFaced=210, dismissals=8))
        faster = self.rate(player(runs=240, ballsFaced=160, dismissals=8))
        self.assertGreaterEqual(faster["battingRating"], slower["battingRating"])

    def test_more_wickets_same_economy_and_workload_rate_does_not_lower_bowling_rating(self) -> None:
        lower = self.rate(bowling_player(wickets=6, legalBallsBowled=120, runsConceded=150))
        higher = self.rate(bowling_player(wickets=12, legalBallsBowled=240, runsConceded=300))
        self.assertGreaterEqual(higher["bowlingRating"], lower["bowlingRating"])

    def test_better_economy_equal_wicket_production_does_not_lower_bowling_rating(self) -> None:
        expensive = self.rate(bowling_player(wickets=10, legalBallsBowled=180, runsConceded=260))
        economical = self.rate(bowling_player(wickets=10, legalBallsBowled=180, runsConceded=210))
        self.assertGreaterEqual(economical["bowlingRating"], expensive["bowlingRating"])

    def test_increased_workload_equal_efficiency_does_not_lower_bowling_rating(self) -> None:
        lower = self.rate(bowling_player(wickets=5, legalBallsBowled=120, runsConceded=150))
        higher = self.rate(bowling_player(wickets=10, legalBallsBowled=240, runsConceded=300))
        self.assertGreaterEqual(higher["bowlingRating"], lower["bowlingRating"])

    def test_meaningful_bowling_threshold(self) -> None:
        self.assertFalse(has_meaningful_bowling(player(wickets=2, legalBallsBowled=54)))
        self.assertTrue(has_meaningful_bowling(player(wickets=3, legalBallsBowled=18)))
        self.assertTrue(has_meaningful_bowling(player(wickets=0, legalBallsBowled=60)))

    def test_standardization_comparison_is_review_only(self) -> None:
        rows = [
            player(id="elite-2016-team", name="Elite Batter", playerId="elite", runs=650, ballsFaced=420, dismissals=10),
            player(id="regular-2016-team", name="Regular Batter", playerId="regular", runs=260, ballsFaced=200, dismissals=8),
            bowling_player(id="bowler-2016-team", name="Bowler", playerId="bowler", wickets=14, legalBallsBowled=240, runsConceded=300),
            bowling_player(id="sparse-2016-team", name="Sparse Bowler", playerId="sparse", wickets=1, legalBallsBowled=60, runsConceded=90),
        ]
        rated, review = rate_player_seasons(rows)
        comparison = review["rawScoreStandardizationComparison"]
        self.assertEqual(comparison["status"], "robust_z_active_ordinary_z_comparison_only")
        self.assertNotIn("ratingsSideBySide", comparison)
        self.assertIn("ordinaryZ", comparison["top25"])
        self.assertIn("robustZ", comparison["top25"])
        self.assertIn("ordinaryZComparisonRating", comparison["top25"]["ordinaryZ"][0])
        self.assertIn("robustZComparisonRating", comparison["top25"]["robustZ"][0])

    def test_standardization_comparison_reports_robust_scale(self) -> None:
        _, review = rate_player_seasons(
            [
                player(name="A", playerId="a", runs=500, ballsFaced=330, dismissals=9),
                player(name="B", playerId="b", runs=260, ballsFaced=210, dismissals=8),
                bowling_player(name="C", playerId="c", wickets=12, legalBallsBowled=240, runsConceded=290),
                bowling_player(name="D", playerId="d", wickets=2, legalBallsBowled=80, runsConceded=120),
            ]
        )
        stats = review["rawScoreStandardizationComparison"]["rawScoreStatistics"]
        self.assertIn("medianAbsoluteDeviation", stats)
        self.assertIn("robustScaleMADTimes1_4826", stats)
        self.assertGreater(stats["robustScaleMADTimes1_4826"], 0)

    def test_canonical_output_omits_obsolete_comparison_fields(self) -> None:
        rated, _ = rate_player_seasons(
            [
                player(name="A", playerId="a", runs=500, ballsFaced=330, dismissals=9),
                player(name="B", playerId="b", runs=260, ballsFaced=210, dismissals=8),
                bowling_player(name="C", playerId="c", wickets=12, legalBallsBowled=240, runsConceded=290),
                bowling_player(name="D", playerId="d", wickets=2, legalBallsBowled=80, runsConceded=120),
            ]
        )
        canonical = canonical_rated_players(rated)
        for item in canonical:
            self.assertIn("absoluteTier", item)
            self.assertIn("draftTier", item)
            self.assertNotIn("previousActiveBaseRating", item)
            self.assertNotIn("previousClampedBaseRating", item)
            self.assertNotIn("provisionalTier", item)
            calculation = item["ratingBreakdown"]["baseRatingCalculation"]
            self.assertNotIn("previousActiveBaseRating", calculation)
            self.assertNotIn("previousClampedBaseRating", calculation)
            for component_name in ("batting", "bowling"):
                component = item["ratingBreakdown"][component_name]
                if component is None:
                    continue
                flags = component["flags"]
                self.assertIn("ratingRawScore", flags)
                self.assertNotIn("softCappedRawScore", flags)
                self.assertNotIn("previousClampedRating", flags)

    def test_secondary_skill_never_reduces_primary_raw_value(self) -> None:
        rated = rate_player(
            player(
                seasonRole="batting_all_rounder",
                runs=300,
                ballsFaced=220,
                dismissals=8,
                wickets=4,
                legalBallsBowled=90,
                runsConceded=110,
            ),
            self.baselines,
            {"batting": 0.5, "bowling": 0.4},
        )
        calc = rated["ratingBreakdown"]["baseRatingCalculation"]["consolidatedRawBaseScore"]
        self.assertGreaterEqual(calc["rawBaseScore"], calc["primaryRawScore"])

    def test_no_secondary_bonus_below_typical_baseline(self) -> None:
        rated = rate_player(
            player(
                seasonRole="batting_all_rounder",
                wickets=3,
                legalBallsBowled=90,
                runsConceded=150,
            ),
            self.baselines,
            {"batting": 0.5, "bowling": 0.95},
        )
        bonus = rated["ratingBreakdown"]["baseRatingCalculation"]["consolidatedRawBaseScore"]["secondaryBonus"]
        self.assertEqual(bonus["appliedBonus"], 0.0)

    def test_evidence_reliability_reduces_sparse_secondary_bonus(self) -> None:
        sparse = secondary_bonus(
            secondary_raw_score=0.7,
            typical_raw_score=0.6,
            evidence_multiplier=0.4,
            cap=0.12,
            meaningful_evidence=True,
            component="bowling",
        )
        reliable = secondary_bonus(
            secondary_raw_score=0.7,
            typical_raw_score=0.6,
            evidence_multiplier=1.0,
            cap=0.12,
            meaningful_evidence=True,
            component="bowling",
        )
        self.assertLess(sparse["appliedBonus"], reliable["appliedBonus"])

    def test_secondary_bonus_cap(self) -> None:
        bonus = secondary_bonus(
            secondary_raw_score=2.0,
            typical_raw_score=0.1,
            evidence_multiplier=1.0,
            cap=0.12,
            meaningful_evidence=True,
            component="batting",
        )
        self.assertEqual(bonus["appliedBonus"], 0.12)

    def test_batter_and_wicketkeeper_remain_batting_only(self) -> None:
        batter = rate_player(
            player(seasonRole="batter", wickets=10, legalBallsBowled=180, runsConceded=210),
            self.baselines,
            {"batting": 0.5, "bowling": 0.1},
        )
        keeper = rate_player(
            player(seasonRole="wicketkeeper_batter", wickets=10, legalBallsBowled=180, runsConceded=210),
            self.baselines,
            {"batting": 0.5, "bowling": 0.1},
        )
        self.assertIsNone(batter["ratingBreakdown"]["baseRatingCalculation"]["consolidatedRawBaseScore"]["secondaryBonus"])
        self.assertIsNone(keeper["ratingBreakdown"]["baseRatingCalculation"]["consolidatedRawBaseScore"]["secondaryBonus"])

    def test_active_rating_uses_common_distribution_robust_standardization(self) -> None:
        rows = [
            player(id="a", name="A", playerId="a", runs=500, ballsFaced=330, dismissals=9),
            player(id="b", name="B", playerId="b", runs=260, ballsFaced=210, dismissals=8),
            bowling_player(id="c", name="C", playerId="c", wickets=12, legalBallsBowled=240, runsConceded=290),
            bowling_player(id="d", name="D", playerId="d", wickets=2, legalBallsBowled=80, runsConceded=120),
        ]
        rated, _ = rate_player_seasons(rows)
        medians = {
            item["ratingBreakdown"]["baseRatingCalculation"]["robustStandardization"]["medianRawBaseScore"]
            for item in rated
        }
        self.assertEqual(len(medians), 1)
        self.assertTrue(all(item["ratingBreakdown"]["baseRatingCalculation"]["activeMethod"] == "common_distribution_robust_z" for item in rated))

    def test_deterministic_median_mad_output(self) -> None:
        rows = [
            player(id="a", name="A", playerId="a", runs=500, ballsFaced=330, dismissals=9),
            player(id="b", name="B", playerId="b", runs=260, ballsFaced=210, dismissals=8),
            bowling_player(id="c", name="C", playerId="c", wickets=12, legalBallsBowled=240, runsConceded=290),
            bowling_player(id="d", name="D", playerId="d", wickets=2, legalBallsBowled=80, runsConceded=120),
        ]
        _, first = rate_player_seasons(copy.deepcopy(rows))
        _, second = rate_player_seasons(copy.deepcopy(rows))
        self.assertEqual(
            first["rawScoreStandardizationComparison"]["rawScoreStatistics"],
            second["rawScoreStandardizationComparison"]["rawScoreStatistics"],
        )

    def test_role_changes_flow_into_rating_calculation(self) -> None:
        batting_only = rate_player(
            player(seasonRole="batter", wickets=4, legalBallsBowled=90, runsConceded=100),
            self.baselines,
            {"batting": 0.5, "bowling": 0.4},
        )
        batting_all_rounder = rate_player(
            player(seasonRole="batting_all_rounder", wickets=4, legalBallsBowled=90, runsConceded=100),
            self.baselines,
            {"batting": 0.5, "bowling": 0.4},
        )
        batter_calc = batting_only["ratingBreakdown"]["baseRatingCalculation"]["consolidatedRawBaseScore"]
        all_rounder_calc = batting_all_rounder["ratingBreakdown"]["baseRatingCalculation"]["consolidatedRawBaseScore"]
        self.assertIsNone(batter_calc["secondaryBonus"])
        self.assertIsNotNone(all_rounder_calc["secondaryBonus"])
        self.assertGreaterEqual(all_rounder_calc["rawBaseScore"], batter_calc["rawBaseScore"])

    def test_bowler_can_receive_batting_bonus_while_remaining_bowler(self) -> None:
        rated = rate_player(
            bowling_player(
                seasonRole="bowler",
                runs=50,
                ballsFaced=40,
                inningsBatted=5,
                wickets=12,
                legalBallsBowled=240,
                runsConceded=290,
            ),
            self.baselines,
            {"batting": 0.4, "bowling": 0.4},
        )
        calc = rated["ratingBreakdown"]["baseRatingCalculation"]["consolidatedRawBaseScore"]
        self.assertEqual(rated["seasonRole"], "bowler")
        self.assertEqual(calc["secondaryBonus"]["component"], "batting")
        self.assertGreater(calc["secondaryBonus"]["appliedBonus"], 0)

    def test_draft_tier_coverage_promotes_best_a_from_s_less_franchises(self) -> None:
        rows = [
            {"id": "s-a", "playerId": "s-a", "name": "Already S", "franchise": "A", "baseRating": 80.0},
            {"id": "a-b", "playerId": "a-b", "name": "Best B", "franchise": "B", "baseRating": 70.0},
            {"id": "a-c", "playerId": "a-c", "name": "Best C", "franchise": "C", "baseRating": 69.0},
            {"id": "a-d", "playerId": "a-d", "name": "Best D", "franchise": "D", "baseRating": 68.0},
            {"id": "a-e", "playerId": "a-e", "name": "Best E", "franchise": "E", "baseRating": 67.0},
            {"id": "a-f", "playerId": "a-f", "name": "Best F", "franchise": "F", "baseRating": 66.0},
            {"id": "b-g", "playerId": "b-g", "name": "Only B", "franchise": "G", "baseRating": 60.0},
            {"id": "b-h", "playerId": "b-h", "name": "Only H", "franchise": "H", "baseRating": 58.0},
        ]
        summary = apply_draft_tier_coverage(rows)
        promoted = [row["name"] for row in rows if row["tierAdjustment"] == "franchise_coverage"]
        self.assertEqual(summary["coverageTarget"], 5)
        self.assertEqual(promoted, ["Best B", "Best C", "Best D", "Best E"])
        self.assertEqual(len(summary["draftSFranchises"]), 5)
        self.assertEqual(rows[-1]["draftTier"], "B")

    def test_draft_tier_coverage_tie_breaks_by_name_then_player_id(self) -> None:
        rows = [
            {"id": "s-a", "playerId": "s-a", "name": "Already S", "franchise": "A", "baseRating": 80.0},
            {"id": "z-b", "playerId": "z-b", "name": "Zed", "franchise": "B", "baseRating": 70.0},
            {"id": "a-b", "playerId": "a-b", "name": "Alpha", "franchise": "B", "baseRating": 70.0},
            {"id": "a-c", "playerId": "a-c", "name": "Best C", "franchise": "C", "baseRating": 69.0},
        ]
        apply_draft_tier_coverage(rows)
        promoted = [row["playerId"] for row in rows if row["tierAdjustment"] == "franchise_coverage"]
        self.assertIn("a-b", promoted)
        self.assertNotIn("z-b", promoted)

    def test_draft_tier_coverage_target_formula(self) -> None:
        self.assertEqual(draft_tier_coverage_target(8), 5)
        self.assertEqual(draft_tier_coverage_target(10), 6)

    def test_soft_cap_is_monotonic(self) -> None:
        raw_scores = [-0.2, 0.0, 0.5, SOFT_CAP_START_RAW_SCORE, 1.0, 1.1, 1.4, 2.0]
        converted = [soft_capped_raw_score(raw) for raw in raw_scores]
        self.assertEqual(converted, sorted(converted))

    def test_soft_cap_is_continuous_at_start(self) -> None:
        before = soft_capped_raw_score(SOFT_CAP_START_RAW_SCORE - 0.000001)
        at_start = soft_capped_raw_score(SOFT_CAP_START_RAW_SCORE)
        after = soft_capped_raw_score(SOFT_CAP_START_RAW_SCORE + 0.000001)
        self.assertLess(abs(before - at_start), 0.00001)
        self.assertLess(abs(after - at_start), 0.00001)

    def test_soft_cap_rating_bounds(self) -> None:
        for raw_score in (-5.0, 0.0, 0.5, 1.0, 2.0, 10.0):
            rating, _ = rating_from_raw(raw_score)
            self.assertGreaterEqual(rating, RATING_MIN)
            self.assertLessEqual(rating, RATING_MAX)

    def test_soft_cap_preserves_ordering_above_previous_hard_cap(self) -> None:
        lower_rating, lower_flags = rating_from_raw(1.05)
        higher_rating, higher_flags = rating_from_raw(1.25)
        self.assertGreater(higher_rating, lower_rating)
        self.assertTrue(lower_flags["abovePreviousHardCap"])
        self.assertTrue(higher_flags["abovePreviousHardCap"])
        self.assertEqual(lower_flags["previousClampedRating"], RATING_MAX)
        self.assertEqual(higher_flags["previousClampedRating"], RATING_MAX)


if __name__ == "__main__":
    unittest.main()
