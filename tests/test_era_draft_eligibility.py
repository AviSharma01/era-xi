from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from scripts.era_draft_eligibility import build_era_draft_eligibility_files, decide_g2
from scripts.wicketkeeper_metadata import build_wicketkeeper_metadata_files, write_artifact_tree


class EligibilityRuleTests(unittest.TestCase):
    def test_official_appearance_condition_is_absolute(self) -> None:
        status, reasons, exclusions = decide_g2(
            official_appearances=1, batting_balls=100, bowling_legal_balls=100,
            wicketkeeping_usage_status="CONFIRMED",
        )
        self.assertEqual(status, "INELIGIBLE")
        self.assertEqual(exclusions, ["OFFICIAL_APPEARANCES_BELOW_2"])
        self.assertEqual(reasons, ["BATTING_BALLS", "BOWLING_LEGAL_BALLS", "WICKETKEEPING_USAGE"])

    def test_each_g2_threshold_qualifies_independently(self) -> None:
        for batting, bowling, usage, expected_reason in (
            (6, 0, "UNKNOWN", "BATTING_BALLS"),
            (0, 12, "UNKNOWN", "BOWLING_LEGAL_BALLS"),
            (0, 0, "CONFIRMED", "WICKETKEEPING_USAGE"),
        ):
            status, reasons, exclusions = decide_g2(
                official_appearances=2, batting_balls=batting,
                bowling_legal_balls=bowling, wicketkeeping_usage_status=usage,
            )
            self.assertEqual(status, "ELIGIBLE")
            self.assertIn(expected_reason, reasons)
            self.assertEqual(exclusions, [])

    def test_below_threshold_unknown_usage_is_reviewable_not_eligible(self) -> None:
        self.assertEqual(
            decide_g2(
                official_appearances=2, batting_balls=5, bowling_legal_balls=11,
                wicketkeeping_usage_status="UNKNOWN",
            ),
            ("INELIGIBLE", [], ["NO_G2_ACTION_THRESHOLD"]),
        )


class EraDraftEligibilityIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.temporary = tempfile.TemporaryDirectory()
        root = Path(cls.temporary.name)
        cls.metadata_dir = root / "metadata"
        cls.output_dir = root / "eligibility"
        metadata_files, _ = build_wicketkeeper_metadata_files()
        write_artifact_tree(cls.metadata_dir, metadata_files)
        cls.files, cls.report = build_era_draft_eligibility_files(metadata_dir=cls.metadata_dir)
        write_artifact_tree(cls.output_dir, cls.files)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.temporary.cleanup()

    def test_g2_reconciliation(self) -> None:
        self.assertEqual(self.report["status"], "passed")
        self.assertEqual(self.report["counts"]["playerTeamSeasons"], 3392)
        self.assertEqual(self.report["counts"]["battingOrBowlingEligibleProfiles"], 2989)
        self.assertEqual(self.report["counts"]["g2EligibleProfiles"], 2990)
        self.assertEqual(self.report["counts"]["g2EligiblePlayers"], 726)
        self.assertEqual(self.report["counts"]["keeperOnlyAdmissions"], 1)
        self.assertEqual(self.report["keeperOnlyAdmissionIds"], ["pts:0aadc906:ipl-2011:team-rajasthan-royals"])

    def test_eligibility_review_queue_is_exact_and_separate(self) -> None:
        queue = json.loads((self.output_dir / "eligibility_review_queue.json").read_text())
        self.assertEqual(queue["summary"], {
            "reviewCases": 22, "seasonUsageOnly": 3,
            "capabilityThenUsage": 19, "keeperRoleReviewOverlap": 3,
        })
        self.assertIn("does not complete", queue["completionBoundary"])
        self.assertEqual(len({row["playerTeamSeasonId"] for row in queue["items"]}), 22)

    def test_eligibility_build_is_byte_deterministic(self) -> None:
        second_files, second_report = build_era_draft_eligibility_files(metadata_dir=self.metadata_dir)
        self.assertEqual(self.files, second_files)
        self.assertEqual(self.report, second_report)


if __name__ == "__main__":
    unittest.main()
