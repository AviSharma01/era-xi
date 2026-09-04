from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path

from scripts.player_role_metadata import (
    PlayerRoleMetadataError,
    build_player_role_metadata_files,
    derive_batting_usage,
    derive_bowling_usage,
    derive_role_summary,
    position_counts_to_bands,
    write_artifact_tree,
)


def positions(**counts: int) -> dict[str, int]:
    result = {str(position): 0 for position in range(1, 12)}
    result.update({str(key): value for key, value in counts.items()})
    return result


def bowling_profile(
    *, official: int = 10, matches: int = 0, balls: int = 0,
    powerplay: int = 0, middle: int = 0, death: int = 0,
) -> dict:
    return {
        "playerTeamSeasonId": "pts:p1:ipl-2020:team-one",
        "participation": {"officialListMatchCount": official},
        "bowling": {
            "matches": matches,
            "totals": {"legalBalls": balls},
            "phases": {
                "powerplay": {"legalBalls": powerplay},
                "middle": {"legalBalls": middle},
                "death": {"legalBalls": death},
            },
        },
    }


class BattingMethodTests(unittest.TestCase):
    def test_position_bands_preserve_all_observations(self) -> None:
        counts = positions(**{"1": 2, "2": 1, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9, "10": 10, "11": 11})
        bands = position_counts_to_bands(counts)
        self.assertEqual(bands, {
            "OPENING": 3, "TOP_ORDER": 3, "MIDDLE_ORDER": 9,
            "LOWER_ORDER": 21, "TAIL": 30,
        })
        self.assertEqual(sum(bands.values()), sum(counts.values()))

    def test_four_season_innings_ignore_player_history(self) -> None:
        season = positions(**{"1": 2, "2": 2})
        career = positions(**{"1": 2, "2": 2, "10": 100})
        result = derive_batting_usage(season, career)
        self.assertEqual(result["basis"], "SEASON")
        self.assertEqual(result["confidence"], "MEDIUM")
        self.assertEqual(result["priorWeight"], 0)
        self.assertEqual(result["primaryBands"], ["OPENING"])
        self.assertTrue(all(row["classification"] == "NATURAL" for row in result["slotFits"][:2]))

    def test_sparse_season_uses_capped_leave_one_profile_out_prior(self) -> None:
        season = positions(**{"3": 1})
        career = positions(**{"3": 1, "4": 8})
        result = derive_batting_usage(season, career)
        self.assertEqual(result["basis"], "SEASON_PLUS_PLAYER_HISTORY")
        self.assertEqual(result["otherProfileInnings"], 8)
        self.assertEqual(result["priorWeight"], 3)
        self.assertEqual(result["confidence"], "LOW")
        self.assertEqual(result["primaryBands"], ["MIDDLE_ORDER"])

    def test_zero_innings_uses_history_or_remains_unknown(self) -> None:
        fallback = derive_batting_usage(positions(), positions(**{"9": 4}))
        self.assertEqual(fallback["basis"], "PLAYER_HISTORY_FALLBACK")
        self.assertEqual(fallback["confidence"], "LOW")
        self.assertEqual(fallback["primaryBands"], ["TAIL"])
        unknown = derive_batting_usage(positions(), positions(**{"9": 3}))
        self.assertEqual(unknown["basis"], "UNOBSERVED")
        self.assertEqual(unknown["confidence"], "NONE")
        self.assertTrue(all(row["classification"] == "UNKNOWN" for row in unknown["slotFits"]))

    def test_acceptable_fit_uses_observed_share_or_adjacency(self) -> None:
        result = derive_batting_usage(
            positions(**{"3": 7, "9": 2, "11": 1}),
            positions(**{"3": 7, "9": 2, "11": 1}),
        )
        by_position = {row["position"]: row["classification"] for row in result["slotFits"]}
        self.assertEqual(by_position[3], "NATURAL")
        self.assertEqual(by_position[1], "ACCEPTABLE")
        self.assertEqual(by_position[4], "ACCEPTABLE")
        self.assertEqual(by_position[9], "ACCEPTABLE")
        self.assertEqual(by_position[6], "OUT_OF_ROLE")

    def test_invalid_prior_fails_closed(self) -> None:
        with self.assertRaises(PlayerRoleMetadataError):
            derive_batting_usage(positions(**{"1": 2}), positions(**{"1": 1}))


class BowlingMethodTests(unittest.TestCase):
    def test_workload_boundaries_use_only_balls_and_appearances(self) -> None:
        occasional = derive_bowling_usage(bowling_profile(matches=4, balls=59, powerplay=20, middle=30, death=9))
        support = derive_bowling_usage(bowling_profile(matches=4, balls=60, powerplay=20, middle=30, death=10))
        frontline = derive_bowling_usage(bowling_profile(matches=10, balls=180, powerplay=60, middle=90, death=30))
        self.assertEqual(occasional["usageClass"], "OCCASIONAL")
        self.assertEqual(support["usageClass"], "SUPPORT")
        self.assertEqual(frontline["usageClass"], "FRONTLINE")
        self.assertEqual(frontline["capacity"], 0.75)

    def test_bowling_evidence_is_independent_from_usage_class(self) -> None:
        sparse_frontline = derive_bowling_usage(bowling_profile(official=2, matches=2, balls=48, powerplay=12, middle=24, death=12))
        self.assertEqual(sparse_frontline["usageClass"], "FRONTLINE")
        self.assertEqual(sparse_frontline["confidence"], "MEDIUM")

    def test_phase_totals_must_reconcile(self) -> None:
        with self.assertRaises(PlayerRoleMetadataError):
            derive_bowling_usage(bowling_profile(matches=2, balls=48, powerplay=12, middle=20, death=10))

    def test_role_summary_keeps_all_rounder_as_a_derived_label(self) -> None:
        batting = derive_batting_usage(positions(**{"4": 8}), positions(**{"4": 8}))
        bowling = derive_bowling_usage(bowling_profile(matches=6, balls=120, powerplay=30, middle=60, death=30))
        role = derive_role_summary(batting, bowling)
        self.assertEqual(role["role"], "ALL_ROUNDER")
        self.assertEqual(role["allRounderLean"], "BATTING")
        self.assertFalse(role["isCanonical"])


class PlayerRoleIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.temporary = tempfile.TemporaryDirectory()
        cls.output_dir = Path(cls.temporary.name) / "roles"
        cls.files, cls.report = build_player_role_metadata_files()
        write_artifact_tree(cls.output_dir, cls.files)
        cls.profiles = [
            json.loads(line)
            for line in (cls.output_dir / "player_team_season_roles.jsonl").read_text().splitlines()
        ]

    @classmethod
    def tearDownClass(cls) -> None:
        cls.temporary.cleanup()

    def test_frozen_g2_and_evidence_reconciliation(self) -> None:
        self.assertEqual(self.report["status"], "passed")
        self.assertEqual(self.report["counts"], {
            "canonicalPlayers": 816,
            "stage4PlayerTeamSeasons": 3392,
            "g2Players": 727,
            "g2Profiles": 2992,
            "seasonBattingObservedProfiles": 2776,
            "fitResolvedProfiles": 2901,
            "fitUnknownProfiles": 91,
            "bowlingFamilyQueuePlayers": 505,
            "qualityFieldsPresent": 0,
            "keeperFieldsPresent": 0,
        })
        self.assertEqual(len({row["playerTeamSeasonId"] for row in self.profiles}), 2992)

    def test_expected_batting_distributions(self) -> None:
        self.assertEqual(self.report["battingEvidenceCounts"], {
            "HIGH": 1094, "MEDIUM": 691, "LOW": 1116, "NONE": 91,
        })
        self.assertEqual(self.report["battingBasisCounts"], {
            "SEASON": 1785,
            "SEASON_PLUS_PLAYER_HISTORY": 723,
            "SEASON_SPARSE": 268,
            "PLAYER_HISTORY_FALLBACK": 125,
            "UNOBSERVED": 91,
        })

    def test_expected_bowling_distributions(self) -> None:
        self.assertEqual(self.report["bowlingUsageCounts"], {
            "NONE": 1025, "OCCASIONAL": 283, "SUPPORT": 514, "FRONTLINE": 1170,
        })
        self.assertEqual(self.report["bowlingEvidenceCounts"], {
            "HIGH": 958, "MEDIUM": 708, "LOW": 301, "NONE": 1025,
        })

    def test_review_queues_match_the_approved_boundary(self) -> None:
        queue = json.loads((self.output_dir / "review_queue.json").read_text())
        self.assertEqual(queue["summary"], {
            "bowlingFamilyPlayers": 505,
            "battingFitProfiles": 91,
            "foundationBlockingItems": 0,
        })
        self.assertTrue(all(row["reviewStatus"] == "PENDING" for row in queue["bowlingFamilyItems"]))
        self.assertTrue(all(not row["blockingForFoundation"] for row in queue["battingFitItems"]))

    def test_build_is_byte_deterministic(self) -> None:
        second_files, second_report = build_player_role_metadata_files()
        self.assertEqual(self.files, second_files)
        self.assertEqual(self.report, second_report)

    def test_role_output_is_invariant_to_quality_fields(self) -> None:
        source = deepcopy(self.profiles[0])
        before = (source["battingUsage"], source["bowlingUsage"], source["roleSummary"])
        source.update({"runs": 9999, "wickets": 999, "rating": 83})
        after = (source["battingUsage"], source["bowlingUsage"], source["roleSummary"])
        self.assertEqual(before, after)

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
