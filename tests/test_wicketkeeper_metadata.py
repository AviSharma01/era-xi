from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from scripts.wicketkeeper_metadata import (
    WicketkeeperMetadataError,
    _validate_manual_overlay,
    build_manual_schema,
    build_wicketkeeper_metadata_files,
    write_artifact_tree,
)


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line]


class ManualWicketkeeperOverlayTests(unittest.TestCase):
    def test_overlay_is_positive_only_and_rejects_unmodelled_false(self) -> None:
        document = {
            "schemaVersion": "ipl-wicketkeeper-manual/v1",
            "sources": [],
            "capabilityConfirmations": [{
                "playerId": "player", "sourceIds": [], "reviewStatus": "APPROVED",
                "notes": None, "isWicketkeeper": False,
            }],
            "usageConfirmations": [], "reviewDispositions": [],
        }
        with self.assertRaisesRegex(WicketkeeperMetadataError, "schema failure"):
            _validate_manual_overlay(document, build_manual_schema())

    def test_confirmation_requires_provenance(self) -> None:
        document = {
            "schemaVersion": "ipl-wicketkeeper-manual/v1", "sources": [],
            "capabilityConfirmations": [{
                "playerId": "player", "sourceIds": [], "reviewStatus": "APPROVED", "notes": None,
            }],
            "usageConfirmations": [], "reviewDispositions": [],
        }
        with self.assertRaisesRegex(WicketkeeperMetadataError, "requires provenance"):
            _validate_manual_overlay(document, build_manual_schema())

    def test_closed_unknown_disposition_requires_reviewed_provenance(self) -> None:
        document = {
            "schemaVersion": "ipl-wicketkeeper-manual/v1", "sources": [],
            "capabilityConfirmations": [], "usageConfirmations": [],
            "reviewDispositions": [{
                "scope": "PLAYER_CAPABILITY", "subjectId": "player",
                "status": "CLOSED_UNKNOWN", "sourceIdsReviewed": [], "notes": "Reviewed.",
            }],
        }
        with self.assertRaisesRegex(WicketkeeperMetadataError, "requires reviewed provenance"):
            _validate_manual_overlay(document, build_manual_schema())


class WicketkeeperMetadataIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.temporary = tempfile.TemporaryDirectory()
        cls.output = Path(cls.temporary.name) / "metadata"
        cls.files, cls.report = build_wicketkeeper_metadata_files()
        write_artifact_tree(cls.output, cls.files)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.temporary.cleanup()

    def test_reconciliation_counts(self) -> None:
        self.assertEqual(self.report["status"], "passed")
        self.assertEqual(self.report["counts"]["stumpingEvents"], 388)
        self.assertEqual(self.report["counts"]["capabilityPlayers"], 55)
        self.assertEqual(self.report["counts"]["confirmedUsageProfiles"], 169)
        self.assertEqual(self.report["counts"]["automaticallyConfirmedCapabilityPlayers"], 49)
        self.assertEqual(self.report["counts"]["automaticallyConfirmedUsageProfiles"], 166)
        self.assertEqual(self.report["counts"]["confirmedUsageWithAtLeastTwoOfficialAppearances"], 166)
        self.assertEqual(self.report["counts"]["confirmedUsageBelowTwoOfficialAppearances"], 3)
        self.assertEqual(self.report["counts"]["substituteStumpingEvents"], 1)
        self.assertTrue(all(row["matches"] for row in self.report["baselineComparisons"]))

    def test_only_stumpings_seed_automatic_evidence(self) -> None:
        evidence = read_jsonl(self.output / "stumping_evidence.jsonl")
        self.assertEqual(len(evidence), 388)
        self.assertEqual({row["evidenceType"] for row in evidence}, {"CRICSHEET_STUMPING"})
        self.assertEqual(sum(row["isSubstitute"] for row in evidence), 1)

    def test_capability_does_not_imply_season_usage(self) -> None:
        capabilities = {row["playerId"]: row for row in read_jsonl(self.output / "player_capabilities.jsonl")}
        usages = read_jsonl(self.output / "player_team_season_usage.jsonl")
        examples = [
            row for row in usages
            if capabilities[row["playerId"]]["status"] == "CONFIRMED" and row["status"] == "UNKNOWN"
        ]
        self.assertGreater(len(examples), 0)
        for row in usages:
            if row["status"] == "CONFIRMED":
                self.assertEqual(capabilities[row["playerId"]]["status"], "CONFIRMED")

    def test_approved_manual_assertions_and_unknown_boundaries(self) -> None:
        capabilities = {row["playerId"]: row for row in read_jsonl(self.output / "player_capabilities.jsonl")}
        usages = {row["playerTeamSeasonId"]: row for row in read_jsonl(self.output / "player_team_season_usage.jsonl")}
        for player_id in {"622cc511", "bafd0398", "c8f5f961", "f088b960", "b274dbbd", "aedc3b7c"}:
            self.assertEqual(capabilities[player_id]["status"], "CONFIRMED")
            self.assertTrue(any(ref.startswith("manual:") for ref in capabilities[player_id]["evidenceRefs"]))
        manual = json.loads(Path("data/manual/wicketkeeper_metadata/v1/metadata.json").read_text())
        self.assertNotIn(
            "541f85c9", {row["playerId"] for row in manual["capabilityConfirmations"]},
        )
        for pts_id in {
            "pts:541f85c9:ipl-2020:team-sunrisers-hyderabad",
            "pts:622cc511:ipl-2008:team-kings-xi-punjab",
            "pts:aedc3b7c:ipl-2016:team-kings-xi-punjab",
        }:
            self.assertEqual(usages[pts_id]["status"], "CONFIRMED")
        for pts_id in {
            "pts:6eb146d2:ipl-2017:team-kings-xi-punjab",
            "pts:85b3fab2:ipl-2022:team-mumbai-indians",
            "pts:bafd0398:ipl-2026:team-mumbai-indians",
            "pts:c8f5f961:ipl-2021:team-rajasthan-royals",
            "pts:f088b960:ipl-2021:team-punjab-kings",
            "pts:b274dbbd:ipl-2016:team-gujarat-lions",
        }:
            self.assertEqual(usages[pts_id]["status"], "UNKNOWN")

    def test_legacy_migration_and_conflicts(self) -> None:
        report = json.loads((self.output / "legacy_migration_report.json").read_text())
        self.assertEqual(report["summary"], {
            "rows": 147, "supportedPositives": 16, "unverifiedPositives": 0,
            "conflictingNegatives": 6, "unsupportedNegatives": 125,
        })
        conflicts = {row["canonicalDisplayName"]: row for row in report["rows"] if row["classification"] == "CONFLICTING_NEGATIVE"}
        self.assertEqual(set(conflicts), {"AP Tare", "AT Rayudu", "Gurkeerat Singh", "KD Karthik", "KM Jadhav", "SN Khan"})
        self.assertEqual(conflicts["KD Karthik"]["ipl2016Stumpings"], 3)
        supported = {row["canonicalDisplayName"] for row in report["rows"] if row["classification"] == "SUPPORTED_POSITIVE"}
        self.assertTrue({"ER Dwivedi", "NS Naik"}.issubset(supported))

    def test_keeper_role_queue_is_separate_and_auditable(self) -> None:
        queue = json.loads((self.output / "keeper_role_review_queue.json").read_text())
        self.assertEqual(queue["summary"]["seasonUsageReviews"], 176)
        self.assertEqual(queue["summary"]["currentlyG2EligibleUsageReviews"], 176)
        self.assertEqual(queue["summary"]["eligibilityCriticalOverlap"], 0)
        self.assertEqual(queue["summary"]["legacyCapabilityCandidates"], 0)
        self.assertEqual(queue["summary"]["closedSeasonUsageReviews"], 8)
        self.assertEqual(queue["summary"]["closedCapabilityReviews"], 15)
        self.assertTrue(all(row["reviewStatus"] == "CLOSED_UNKNOWN" for row in queue["closedSeasonUsageItems"]))
        self.assertTrue(all(row["reviewStatus"] == "CLOSED_UNKNOWN" for row in queue["closedCapabilityItems"]))
        self.assertFalse(queue["summary"]["positiveDiscoveryComplete"])

    def test_build_is_byte_deterministic(self) -> None:
        second_files, second_report = build_wicketkeeper_metadata_files()
        self.assertEqual(self.files, second_files)
        self.assertEqual(self.report, second_report)

    def test_live_2016_compatibility_baseline_is_unchanged(self) -> None:
        expected = {
            "data/manual/player_metadata_template.json": "8612b75cfbd40d99be6754f06fc867cc8e00b54d21874775f13c945e3c4c6405",
            "scripts/prepare_draft_data.py": "6de0f348c63420c341bc435114def6ec573eac8e938e8006d31061249165964c",
            "src/draftClassic.ts": "f9381873033295b5d77721fc2393687d26e5dfa6163f570bd285e12bdb72bf3d",
            "data/processed/2016/draft_player_seasons.json": "1f37ce41d88896e79597d15c857d130bd52cfce94873d93c8db0e36d057c6a92",
            "data/processed/2016/rated_player_seasons.json": "fa32a8eaf0e91e5640ffe319eeb931d39a91c3e7dee538d13c1ebe10e889444d",
            "data/processed/2016/ratings_review.json": "253c5f9a3ba1c52b57b8e99636bf367bb5f6a9244208b8fb9247b2b393422f08",
        }
        for path, digest in expected.items():
            self.assertEqual(hashlib.sha256(Path(path).read_bytes()).hexdigest(), digest, path)


if __name__ == "__main__":
    unittest.main()
