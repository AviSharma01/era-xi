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
        self.assertEqual(self.report["counts"]["capabilityPlayers"], 104)
        self.assertEqual(self.report["counts"]["confirmedUsageProfiles"], 257)
        self.assertEqual(self.report["counts"]["automaticallyConfirmedCapabilityPlayers"], 49)
        self.assertEqual(self.report["counts"]["automaticallyConfirmedUsageProfiles"], 166)
        self.assertEqual(self.report["counts"]["confirmedUsageWithAtLeastTwoOfficialAppearances"], 254)
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
        capability_freeze_additions = {
            "0404d43c", "0bacade8", "0c94f480", "0ed0cdbf", "0fa5042b", "1fc6ef83",
            "25f7b7d6", "272d796e", "2eeb4370", "35f173a0", "39086549", "3a02626a",
            "3d284ca3", "548516a6", "5748e866", "57ca01b3", "5bdcdb72", "5d1e7582",
            "60aa2db3", "69d03465", "7050a1e7", "710dd98c", "75de770f", "7b679de5",
            "8ac93ca2", "95a2ea61", "9a46c4e5", "9e7225b0", "ad3b6e95", "ada15e88",
            "b0c772ee", "b63e358a", "bd54eef5", "bf74b130", "c2dd89ea", "cf59b3f0",
            "d7423da1", "df5a6881", "e3851766", "eaa90ab4", "f0af99a7", "f12fe2a1",
            "f21043a5", "f48cf4da", "f836b33d", "ff154ecd", "ff1e68fa",
        }
        self.assertEqual(len(capability_freeze_additions), 47)
        self.assertTrue(capability_freeze_additions.issubset({
            row["playerId"] for row in manual["capabilityConfirmations"]
        }))
        self.assertTrue(all(capabilities[player_id]["status"] == "CONFIRMED" for player_id in capability_freeze_additions))
        self.assertEqual(len(manual["usageConfirmations"]), 91)
        for player_id in {"1399b39c", "6c882e9a"}:
            self.assertEqual(capabilities[player_id]["status"], "CONFIRMED")
            self.assertIn(player_id, {
                row["playerId"] for row in manual["capabilityConfirmations"]
            })
        self.assertEqual(capabilities["30e37810"]["status"], "UNKNOWN")
        self.assertNotIn(
            "541f85c9", {row["playerId"] for row in manual["capabilityConfirmations"]},
        )
        for pts_id in {
            "pts:541f85c9:ipl-2020:team-sunrisers-hyderabad",
            "pts:622cc511:ipl-2008:team-kings-xi-punjab",
            "pts:aedc3b7c:ipl-2016:team-kings-xi-punjab",
            "pts:0bacade8:ipl-2024:team-kolkata-knight-riders",
            "pts:372455c4:ipl-2024:team-lucknow-super-giants",
            "pts:3d284ca3:ipl-2024:team-kolkata-knight-riders",
            "pts:4a8a2e3b:ipl-2024:team-chennai-super-kings",
            "pts:752f7486:ipl-2024:team-mumbai-indians",
            "pts:800d2d97:ipl-2024:team-punjab-kings",
            "pts:abb83e27:ipl-2024:team-punjab-kings",
            "pts:ad3b6e95:ipl-2024:team-delhi-capitals",
            "pts:afa7e784:ipl-2024:team-gujarat-titans",
            "pts:c8f5f961:ipl-2024:team-royal-challengers-bengaluru",
            "pts:0bacade8:ipl-2025:team-kolkata-knight-riders",
            "pts:235c2bb6:ipl-2025:team-sunrisers-hyderabad",
            "pts:372455c4:ipl-2025:team-kolkata-knight-riders",
            "pts:752f7486:ipl-2025:team-sunrisers-hyderabad",
            "pts:abb83e27:ipl-2025:team-mumbai-indians",
            "pts:ad3b6e95:ipl-2025:team-delhi-capitals",
            "pts:b17e2f24:ipl-2025:team-delhi-capitals",
            "pts:bcf325d2:ipl-2025:team-rajasthan-royals",
            "pts:919a3be2:ipl-2026:team-lucknow-super-giants",
            "pts:ad3b6e95:ipl-2026:team-delhi-capitals",
            "pts:d7423da1:ipl-2026:team-sunrisers-hyderabad",
            "pts:e66732f8:ipl-2026:team-mumbai-indians",
            "pts:f12fe2a1:ipl-2026:team-kolkata-knight-riders",
            "pts:4a8a2e3b:ipl-2022:team-chennai-super-kings",
            "pts:752f7486:ipl-2022:team-mumbai-indians",
            "pts:abb83e27:ipl-2022:team-punjab-kings",
            "pts:ff1e68fa:ipl-2022:team-kolkata-knight-riders",
            "pts:6c882e9a:ipl-2022:team-punjab-kings",
            "pts:0bacade8:ipl-2023:team-kolkata-knight-riders",
            "pts:0494fa6e:ipl-2023:team-mumbai-indians",
            "pts:1399b39c:ipl-2023:team-sunrisers-hyderabad",
            "pts:3d284ca3:ipl-2023:team-delhi-capitals",
            "pts:9a46c4e5:ipl-2023:team-sunrisers-hyderabad",
            "pts:ad3b6e95:ipl-2023:team-delhi-capitals",
            "pts:bd54eef5:ipl-2023:team-kolkata-knight-riders",
            "pts:c8f5f961:ipl-2023:team-royal-challengers-bangalore",
            "pts:f088b960:ipl-2023:team-delhi-capitals",
        }:
            self.assertEqual(usages[pts_id]["status"], "CONFIRMED")
        for pts_id in {
            "pts:6eb146d2:ipl-2017:team-kings-xi-punjab",
            "pts:85b3fab2:ipl-2022:team-mumbai-indians",
            "pts:bafd0398:ipl-2026:team-mumbai-indians",
            "pts:c8f5f961:ipl-2021:team-rajasthan-royals",
            "pts:f088b960:ipl-2021:team-punjab-kings",
            "pts:b274dbbd:ipl-2016:team-gujarat-lions",
            "pts:1fc6ef83:ipl-2024:team-delhi-capitals",
            "pts:3241e3fd:ipl-2024:team-lucknow-super-giants",
            "pts:57ca01b3:ipl-2024:team-delhi-capitals",
            "pts:85b3fab2:ipl-2024:team-delhi-capitals",
            "pts:9418198b:ipl-2024:team-punjab-kings",
            "pts:99b75528:ipl-2024:team-rajasthan-royals",
            "pts:9e7225b0:ipl-2024:team-royal-challengers-bengaluru",
            "pts:b63e358a:ipl-2024:team-delhi-capitals",
            "pts:bcf325d2:ipl-2024:team-rajasthan-royals",
            "pts:d7017798:ipl-2024:team-kolkata-knight-riders",
            "pts:f0af99a7:ipl-2024:team-rajasthan-royals",
            "pts:f836b33d:ipl-2024:team-rajasthan-royals",
            "pts:3241e3fd:ipl-2025:team-lucknow-super-giants",
            "pts:3d284ca3:ipl-2025:team-royal-challengers-bengaluru",
            "pts:bafd0398:ipl-2025:team-mumbai-indians",
            "pts:cf59b3f0:ipl-2025:team-chennai-super-kings",
            "pts:d7017798:ipl-2025:team-kolkata-knight-riders",
            "pts:df5a6881:ipl-2025:team-chennai-super-kings",
            "pts:235c2bb6:ipl-2026:team-sunrisers-hyderabad",
            "pts:3241e3fd:ipl-2026:team-lucknow-super-giants",
            "pts:3d284ca3:ipl-2026:team-royal-challengers-bengaluru",
            "pts:60aa2db3:ipl-2026:team-rajasthan-royals",
            "pts:7b679de5:ipl-2026:team-chennai-super-kings",
            "pts:85b3fab2:ipl-2026:team-delhi-capitals",
            "pts:989889ff:ipl-2026:team-lucknow-super-giants",
            "pts:9a46c4e5:ipl-2026:team-gujarat-titans",
            "pts:bf74b130:ipl-2026:team-kolkata-knight-riders",
            "pts:cf59b3f0:ipl-2026:team-chennai-super-kings",
            "pts:f088b960:ipl-2026:team-chennai-super-kings",
            "pts:f0af99a7:ipl-2026:team-rajasthan-royals",
            "pts:1399b39c:ipl-2022:team-mumbai-indians",
            "pts:6c882e9a:ipl-2023:team-punjab-kings",
            "pts:1399b39c:ipl-2024:team-sunrisers-hyderabad",
        }:
            self.assertEqual(usages[pts_id]["status"], "UNKNOWN")

    def test_2024_research_batch_ledger_is_complete_and_workflow_only(self) -> None:
        ledger = json.loads(Path(
            "data/manual/wicketkeeper_metadata/v1/research_batches/usage-2024-v1.json"
        ).read_text())
        self.assertEqual(ledger["schemaVersion"], "ipl-wicketkeeper-usage-research-batch/v1")
        self.assertEqual(ledger["batchId"], "usage-2024-v1")
        self.assertEqual(
            ledger["snapshotMetadataManifestHash"],
            "13940e0db4059fca2a12fba17b3046255cf9984f52be935766592b09814882d8",
        )
        self.assertEqual(len(ledger["scopePlayerTeamSeasonIds"]), 22)
        self.assertEqual(len(set(ledger["scopePlayerTeamSeasonIds"])), 22)
        self.assertEqual(len(ledger["caseResults"]), 22)
        self.assertEqual(len(ledger["matchSources"]), 57)
        self.assertEqual(
            {row["playerTeamSeasonId"] for row in ledger["caseResults"]},
            set(ledger["scopePlayerTeamSeasonIds"]),
        )
        match_source_ids = {row["matchSourceId"] for row in ledger["matchSources"]}
        self.assertEqual(len(match_source_ids), 57)
        self.assertTrue(all(
            set(row["sourceIds"]).issubset(match_source_ids)
            for row in ledger["caseResults"]
        ))
        self.assertEqual(
            {row["result"] for row in ledger["caseResults"]},
            {"POSITIVE_USAGE_FOUND", "REVIEWED_UNKNOWN"},
        )
        self.assertEqual(
            sum(row["result"] == "POSITIVE_USAGE_FOUND" for row in ledger["caseResults"]), 10,
        )
        self.assertEqual(
            sum(row["result"] == "REVIEWED_UNKNOWN" for row in ledger["caseResults"]), 12,
        )
        self.assertTrue(all(
            row["proposedCanonicalAction"] == "REMAIN_UNKNOWN"
            and row["proposedReviewDisposition"] == "CLOSED_UNKNOWN"
            and row["closureCriterionSatisfied"] is True
            and len(row["appearancesReviewed"]) == row["officialAppearances"]
            for row in ledger["caseResults"] if row["result"] == "REVIEWED_UNKNOWN"
        ))
        self.assertTrue(all(
            row["proposedCanonicalAction"] == "CONFIRMED"
            and row["proposedReviewDisposition"] is None
            and row["positiveLocator"]["observedMarker"] == "†"
            for row in ledger["caseResults"] if row["result"] == "POSITIVE_USAGE_FOUND"
        ))
        self.assertEqual(ledger["summary"], {
            "scopeCases": 22, "positiveUsageFound": 10, "reviewedUnknown": 12,
            "sourceGaps": 0, "capabilityFreezeExceptions": 0,
            "targetScorecardsInspected": 55, "controlOnlyScorecardsInspected": 1,
            "totalScorecardsInspected": 56, "officialRouteAvailabilityFailures": 1,
            "targetUpperBound": 67, "reusedTargetScorecards": 54,
        })

    def test_2025_2026_research_batch_ledgers_are_complete_and_workflow_only(self) -> None:
        expected = {
            "2025": {
                "scope": 14, "positives": 8, "unknowns": 6,
                "matchSources": 55, "targetScorecards": 54,
                "reused": 35, "appearances": 135, "covered": 113, "skipped": 22,
            },
            "2026": {
                "scope": 17, "positives": 5, "unknowns": 12,
                "matchSources": 66, "targetScorecards": 65,
                "reused": 54, "appearances": 160, "covered": 157, "skipped": 3,
            },
        }
        for year, counts in expected.items():
            ledger = json.loads(Path(
                f"data/manual/wicketkeeper_metadata/v1/research_batches/usage-{year}-v1.json"
            ).read_text())
            self.assertEqual(ledger["schemaVersion"], "ipl-wicketkeeper-usage-research-batch/v1")
            self.assertEqual(ledger["batchId"], f"usage-{year}-v1")
            self.assertEqual(ledger["seasonId"], f"ipl-{year}")
            self.assertEqual(
                ledger["snapshotMetadataManifestHash"],
                "94407c268467b33f14597d3c9167c5ce33e08b26b5a32861818969ce618a9962",
            )
            self.assertEqual(len(ledger["scopePlayerTeamSeasonIds"]), counts["scope"])
            self.assertEqual(len(set(ledger["scopePlayerTeamSeasonIds"])), counts["scope"])
            self.assertEqual(len(ledger["caseResults"]), counts["scope"])
            self.assertEqual(len(ledger["matchSources"]), counts["matchSources"])
            match_source_ids = {row["matchSourceId"] for row in ledger["matchSources"]}
            self.assertEqual(len(match_source_ids), counts["matchSources"])
            self.assertTrue(all(
                set(row["sourceIds"]).issubset(match_source_ids)
                for row in ledger["caseResults"]
            ))
            self.assertEqual(
                sum(row["result"] == "POSITIVE_USAGE_FOUND" for row in ledger["caseResults"]),
                counts["positives"],
            )
            self.assertEqual(
                sum(row["result"] == "REVIEWED_UNKNOWN" for row in ledger["caseResults"]),
                counts["unknowns"],
            )
            self.assertTrue(all(
                row["proposedCanonicalAction"] == "REMAIN_UNKNOWN"
                and row["proposedReviewDisposition"] == "CLOSED_UNKNOWN"
                and row["closureCriterionSatisfied"] is True
                and len(row["appearancesReviewed"]) == row["officialAppearances"]
                for row in ledger["caseResults"] if row["result"] == "REVIEWED_UNKNOWN"
            ))
            self.assertTrue(all(
                row["proposedCanonicalAction"] == "CONFIRMED"
                and row["proposedReviewDisposition"] is None
                and row["positiveLocator"]["observedMarker"] == "†"
                for row in ledger["caseResults"] if row["result"] == "POSITIVE_USAGE_FOUND"
            ))
            self.assertEqual(ledger["summary"], {
                "scopeCases": counts["scope"],
                "positiveUsageFound": counts["positives"],
                "reviewedUnknown": counts["unknowns"],
                "sourceGaps": 0,
                "capabilityFreezeExceptions": 0,
                "targetScorecardsInspected": counts["targetScorecards"],
                "controlOnlyScorecardsInspected": 0,
                "totalScorecardsInspected": counts["targetScorecards"],
                "officialRouteAvailabilityFailures": 1,
                "targetUpperBound": 68,
                "reusedTargetScorecards": counts["reused"],
                "canonicalCandidateAppearances": counts["appearances"],
                "candidateAppearancesCoveredByInspectedScorecards": counts["covered"],
                "candidateAppearancesSkippedAfterPositive": counts["skipped"],
                "uninspectedAppearancesOnlyBelongedToPositiveCases": True,
            })
        ledger_2026 = json.loads(Path(
            "data/manual/wicketkeeper_metadata/v1/research_batches/usage-2026-v1.json"
        ).read_text())
        sn_khan = next(
            row for row in ledger_2026["caseResults"]
            if row["playerTeamSeasonId"] == "pts:f088b960:ipl-2026:team-chennai-super-kings"
        )
        self.assertEqual(sn_khan["officialAppearances"], 8)
        self.assertIn("1529287", sn_khan["notes"])
        self.assertIn("1529296", sn_khan["notes"])
        self.assertIn("event-only", sn_khan["notes"])

    def test_2022_2023_research_ledgers_preserve_original_scope_and_exceptions(self) -> None:
        expected = {
            "2022": {"scope": 14, "positives": 4, "unknowns": 10, "sources": 63},
            "2023": {"scope": 16, "positives": 8, "unknowns": 8, "sources": 61},
        }
        for year, counts in expected.items():
            ledger = json.loads(Path(
                f"data/manual/wicketkeeper_metadata/v1/research_batches/usage-{year}-v1.json"
            ).read_text())
            self.assertEqual(ledger["schemaVersion"], "ipl-wicketkeeper-usage-research-batch/v1")
            self.assertEqual(ledger["batchId"], f"usage-{year}-v1")
            self.assertEqual(
                ledger["snapshotMetadataManifestHash"],
                "774b8a0c7b65bf8464d854884c0ff2086fdefaaef0bfa6fa2134b28a4712f99f",
            )
            self.assertEqual(len(ledger["scopePlayerTeamSeasonIds"]), counts["scope"])
            self.assertEqual(len(ledger["caseResults"]), counts["scope"])
            self.assertEqual(len(ledger["matchSources"]), counts["sources"])
            self.assertTrue(ledger["scopeAudit"]["originalQueueScopePreserved"])
            self.assertEqual(len(ledger["capabilityFreezeExceptions"]), 1)
            self.assertEqual(len(ledger["supplementalCaseResults"]), 1)
            self.assertEqual(
                sum(row["result"] == "POSITIVE_USAGE_FOUND" for row in ledger["caseResults"]),
                counts["positives"],
            )
            self.assertEqual(
                sum(row["result"] == "REVIEWED_UNKNOWN" for row in ledger["caseResults"]),
                counts["unknowns"],
            )
            supplemental = ledger["supplementalCaseResults"][0]
            self.assertEqual(supplemental["result"], "REVIEWED_UNKNOWN")
            self.assertTrue(supplemental["closureCriterionSatisfied"])
            self.assertEqual(
                len(supplemental["appearancesReviewed"]), supplemental["officialAppearances"],
            )

    def test_2019_2021_research_ledgers_and_population_are_exact(self) -> None:
        expected = {
            "2019": {"scope": 12, "positives": 5, "unknowns": 7, "sources": 52},
            "2020": {"scope": 16, "positives": 8, "unknowns": 8, "sources": 60},
            "2021": {"scope": 12, "positives": 6, "unknowns": 6, "sources": 58},
        }
        positive_ids = {
            "pts:3241e3fd:ipl-2019:team-kings-xi-punjab",
            "pts:70d205c9:ipl-2019:team-chennai-super-kings",
            "pts:99b75528:ipl-2019:team-rajasthan-royals",
            "pts:b17e2f24:ipl-2019:team-kings-xi-punjab",
            "pts:c03f1114:ipl-2019:team-kolkata-knight-riders",
            "pts:3241e3fd:ipl-2020:team-kings-xi-punjab",
            "pts:39086549:ipl-2020:team-royal-challengers-bangalore",
            "pts:69d03465:ipl-2020:team-delhi-capitals",
            "pts:919a3be2:ipl-2020:team-delhi-capitals",
            "pts:9418198b:ipl-2020:team-kings-xi-punjab",
            "pts:99b75528:ipl-2020:team-rajasthan-royals",
            "pts:b17e2f24:ipl-2020:team-kings-xi-punjab",
            "pts:c03f1114:ipl-2020:team-kolkata-knight-riders",
            "pts:4a8a2e3b:ipl-2021:team-chennai-super-kings",
            "pts:752f7486:ipl-2021:team-mumbai-indians",
            "pts:9418198b:ipl-2021:team-punjab-kings",
            "pts:b17e2f24:ipl-2021:team-punjab-kings",
            "pts:c4487b84:ipl-2021:team-royal-challengers-bangalore",
            "pts:fe11caa6:ipl-2021:team-sunrisers-hyderabad",
        }
        closed_ids = {
            "pts:1c17e270:ipl-2019:team-kolkata-knight-riders",
            "pts:235c2bb6:ipl-2019:team-royal-challengers-bangalore",
            "pts:6eb146d2:ipl-2019:team-royal-challengers-bangalore",
            "pts:752f7486:ipl-2019:team-mumbai-indians",
            "pts:99d63244:ipl-2019:team-chennai-super-kings",
            "pts:c4487b84:ipl-2019:team-royal-challengers-bangalore",
            "pts:f088b960:ipl-2019:team-kings-xi-punjab",
            "pts:1c17e270:ipl-2020:team-rajasthan-royals",
            "pts:25f7b7d6:ipl-2020:team-kolkata-knight-riders",
            "pts:6eb146d2:ipl-2020:team-royal-challengers-bangalore",
            "pts:70d205c9:ipl-2020:team-chennai-super-kings",
            "pts:752f7486:ipl-2020:team-mumbai-indians",
            "pts:99d63244:ipl-2020:team-chennai-super-kings",
            "pts:bd54eef5:ipl-2020:team-chennai-super-kings",
            "pts:f088b960:ipl-2020:team-kings-xi-punjab",
            "pts:1c17e270:ipl-2021:team-chennai-super-kings",
            "pts:3241e3fd:ipl-2021:team-punjab-kings",
            "pts:70d205c9:ipl-2021:team-chennai-super-kings",
            "pts:99b75528:ipl-2021:team-rajasthan-royals",
            "pts:99d63244:ipl-2021:team-sunrisers-hyderabad",
            "pts:9a46c4e5:ipl-2021:team-rajasthan-royals",
        }
        ledger_positive_ids: set[str] = set()
        ledger_closed_ids: set[str] = set()
        for year, counts in expected.items():
            ledger = json.loads(Path(
                f"data/manual/wicketkeeper_metadata/v1/research_batches/usage-{year}-v1.json"
            ).read_text())
            self.assertEqual(ledger["schemaVersion"], "ipl-wicketkeeper-usage-research-batch/v1")
            self.assertEqual(ledger["batchId"], f"usage-{year}-v1")
            self.assertEqual(ledger["seasonId"], f"ipl-{year}")
            self.assertEqual(
                ledger["snapshotMetadataManifestHash"],
                "5689383fd7b2a9487c45a27f674db62b53784d635213970ce6f87e8ba7793d38",
            )
            self.assertEqual(len(ledger["scopePlayerTeamSeasonIds"]), counts["scope"])
            self.assertEqual(len(set(ledger["scopePlayerTeamSeasonIds"])), counts["scope"])
            self.assertEqual(len(ledger["caseResults"]), counts["scope"])
            self.assertEqual(len(ledger["matchSources"]), counts["sources"])
            self.assertEqual(ledger["capabilityFreezeExceptions"], [])
            match_source_ids = {row["matchSourceId"] for row in ledger["matchSources"]}
            self.assertEqual(len(match_source_ids), counts["sources"])
            self.assertTrue(all(
                set(row["sourceIds"]).issubset(match_source_ids)
                for row in ledger["caseResults"]
            ))
            positives = {
                row["playerTeamSeasonId"] for row in ledger["caseResults"]
                if row["result"] == "POSITIVE_USAGE_FOUND"
            }
            unknowns = {
                row["playerTeamSeasonId"] for row in ledger["caseResults"]
                if row["result"] == "REVIEWED_UNKNOWN"
            }
            self.assertEqual(len(positives), counts["positives"])
            self.assertEqual(len(unknowns), counts["unknowns"])
            ledger_positive_ids.update(positives)
            ledger_closed_ids.update(unknowns)
            self.assertTrue(all(
                row["proposedCanonicalAction"] == "CONFIRMED"
                and row["proposedReviewDisposition"] is None
                and row["positiveLocator"]["observedMarker"] == "†"
                for row in ledger["caseResults"] if row["result"] == "POSITIVE_USAGE_FOUND"
            ))
            self.assertTrue(all(
                row["proposedCanonicalAction"] == "REMAIN_UNKNOWN"
                and row["proposedReviewDisposition"] == "CLOSED_UNKNOWN"
                and row["closureCriterionSatisfied"] is True
                and len(row["appearancesReviewed"]) == row["officialAppearances"]
                for row in ledger["caseResults"] if row["result"] == "REVIEWED_UNKNOWN"
            ))
            self.assertEqual(ledger["summary"]["sourceGaps"], 0)
            self.assertEqual(ledger["summary"]["capabilityFreezeExceptions"], 0)
        self.assertEqual(ledger_positive_ids, positive_ids)
        self.assertEqual(ledger_closed_ids, closed_ids)

        usage_rows = {
            row["playerTeamSeasonId"]: row
            for row in read_jsonl(self.output / "player_team_season_usage.jsonl")
        }
        self.assertTrue(all(usage_rows[row_id]["status"] == "CONFIRMED" for row_id in positive_ids))
        self.assertTrue(all(usage_rows[row_id]["status"] == "UNKNOWN" for row_id in closed_ids))

        queue = json.loads((self.output / "keeper_role_review_queue.json").read_text())
        active_ids = {row["playerTeamSeasonId"] for row in queue["seasonUsageItems"]}
        closed_queue_ids = {row["playerTeamSeasonId"] for row in queue["closedSeasonUsageItems"]}
        self.assertTrue((positive_ids | closed_ids).isdisjoint(active_ids))
        self.assertTrue(closed_ids.issubset(closed_queue_ids))

        ledger_2019 = json.loads(Path(
            "data/manual/wicketkeeper_metadata/v1/research_batches/usage-2019-v1.json"
        ).read_text())
        klaasen = next(
            row for row in ledger_2019["caseResults"]
            if row["playerTeamSeasonId"]
            == "pts:235c2bb6:ipl-2019:team-royal-challengers-bangalore"
        )
        self.assertEqual(klaasen["officialAppearances"], 3)
        self.assertEqual(klaasen["eventOnlyObservations"][0]["matchId"], "1175372")
        self.assertFalse(klaasen["eventOnlyObservations"][0]["includedInOfficialAppearanceDenominator"])

        ledger_2021 = json.loads(Path(
            "data/manual/wicketkeeper_metadata/v1/research_batches/usage-2021-v1.json"
        ).read_text())
        source_by_id = {row["matchSourceId"]: row for row in ledger_2021["matchSources"]}
        for match_id in {"1254107", "1254115"}:
            self.assertEqual(
                source_by_id[f"espn-shortcut-ipl-2021-{match_id}"]["availability"],
                "UNAVAILABLE_PAGE_ERROR",
            )
            self.assertEqual(
                source_by_id[f"espncricinfo-ipl-2021-{match_id}-full"]["availability"],
                "AVAILABLE",
            )
        self.assertEqual(
            {row["playerId"] for row in ledger_2021["identityNormalizations"]},
            {"9418198b"},
        )

    def test_2016_2018_research_ledgers_and_population_are_exact(self) -> None:
        expected = {
            "2016": {"scope": 13, "positives": 3, "unknowns": 10, "sources": 57},
            "2017": {"scope": 11, "positives": 4, "unknowns": 7, "sources": 54},
            "2018": {"scope": 9, "positives": 2, "unknowns": 7, "sources": 50},
        }
        positive_ids = {
            "pts:99b75528:ipl-2016:team-mumbai-indians",
            "pts:99d63244:ipl-2016:team-royal-challengers-bangalore",
            "pts:890946a0:ipl-2016:team-sunrisers-hyderabad",
            "pts:890946a0:ipl-2017:team-sunrisers-hyderabad",
            "pts:c03f1114:ipl-2017:team-gujarat-lions",
            "pts:acc1aeda:ipl-2017:team-kolkata-knight-riders",
            "pts:70d205c9:ipl-2017:team-mumbai-indians",
            "pts:b5da6c24:ipl-2018:team-royal-challengers-bangalore",
            "pts:541f85c9:ipl-2018:team-sunrisers-hyderabad",
        }
        closed_ids = {
            "pts:6eb146d2:ipl-2016:team-kings-xi-punjab",
            "pts:70d205c9:ipl-2016:team-mumbai-indians",
            "pts:752f7486:ipl-2016:team-gujarat-lions",
            "pts:855a210c:ipl-2016:team-sunrisers-hyderabad",
            "pts:919a3be2:ipl-2016:team-delhi-daredevils",
            "pts:ada15e88:ipl-2016:team-rising-pune-supergiant",
            "pts:b8a55852:ipl-2016:team-gujarat-lions",
            "pts:c16d4035:ipl-2016:team-delhi-daredevils",
            "pts:c4487b84:ipl-2016:team-royal-challengers-bangalore",
            "pts:f088b960:ipl-2016:team-royal-challengers-bangalore",
            "pts:752f7486:ipl-2017:team-gujarat-lions",
            "pts:855a210c:ipl-2017:team-delhi-daredevils",
            "pts:99b75528:ipl-2017:team-mumbai-indians",
            "pts:a4cc73aa:ipl-2017:team-delhi-daredevils",
            "pts:b8a55852:ipl-2017:team-gujarat-lions",
            "pts:c16d4035:ipl-2017:team-delhi-daredevils",
            "pts:c4487b84:ipl-2017:team-royal-challengers-bangalore",
            "pts:1c17e270:ipl-2018:team-kolkata-knight-riders",
            "pts:70d205c9:ipl-2018:team-chennai-super-kings",
            "pts:a4cc73aa:ipl-2018:team-rajasthan-royals",
            "pts:b8a55852:ipl-2018:team-royal-challengers-bangalore",
            "pts:c16d4035:ipl-2018:team-chennai-super-kings",
            "pts:c4487b84:ipl-2018:team-royal-challengers-bangalore",
            "pts:f088b960:ipl-2018:team-royal-challengers-bangalore",
        }
        ledger_positive_ids: set[str] = set()
        ledger_closed_ids: set[str] = set()
        for year, counts in expected.items():
            ledger = json.loads(Path(
                f"data/manual/wicketkeeper_metadata/v1/research_batches/usage-{year}-v1.json"
            ).read_text())
            self.assertEqual(ledger["batchId"], f"usage-{year}-v1")
            self.assertEqual(ledger["seasonId"], f"ipl-{year}")
            self.assertEqual(
                ledger["snapshotMetadataManifestHash"],
                "47af32b00c4d584f6d7ff87151391807fc2a19678948321bafdad5544997ca87",
            )
            self.assertEqual(len(ledger["scopePlayerTeamSeasonIds"]), counts["scope"])
            self.assertEqual(len(ledger["caseResults"]), counts["scope"])
            self.assertEqual(len(ledger["matchSources"]), counts["sources"])
            self.assertEqual(ledger["capabilityFreezeExceptions"], [])
            match_source_ids = {row["matchSourceId"] for row in ledger["matchSources"]}
            self.assertTrue(all(
                set(row["sourceIds"]).issubset(match_source_ids)
                for row in ledger["caseResults"]
            ))
            positives = {
                row["playerTeamSeasonId"] for row in ledger["caseResults"]
                if row["result"] == "POSITIVE_USAGE_FOUND"
            }
            unknowns = {
                row["playerTeamSeasonId"] for row in ledger["caseResults"]
                if row["result"] == "REVIEWED_UNKNOWN"
            }
            self.assertEqual(len(positives), counts["positives"])
            self.assertEqual(len(unknowns), counts["unknowns"])
            ledger_positive_ids.update(positives)
            ledger_closed_ids.update(unknowns)
            self.assertTrue(all(
                row["proposedCanonicalAction"] == "CONFIRMED"
                and row["positiveLocator"]["observedMarker"] == "†"
                for row in ledger["caseResults"] if row["result"] == "POSITIVE_USAGE_FOUND"
            ))
            self.assertTrue(all(
                row["proposedCanonicalAction"] == "REMAIN_UNKNOWN"
                and row["proposedReviewDisposition"] == "CLOSED_UNKNOWN"
                and row["closureCriterionSatisfied"] is True
                and len(row["appearancesReviewed"]) == row["officialAppearances"]
                for row in ledger["caseResults"] if row["result"] == "REVIEWED_UNKNOWN"
            ))
            self.assertEqual(ledger["summary"]["sourceGaps"], 0)
            self.assertEqual(ledger["summary"]["capabilityFreezeExceptions"], 0)
        self.assertEqual(ledger_positive_ids, positive_ids)
        self.assertEqual(ledger_closed_ids, closed_ids)

        usages = {
            row["playerTeamSeasonId"]: row
            for row in read_jsonl(self.output / "player_team_season_usage.jsonl")
        }
        self.assertTrue(all(usages[row_id]["status"] == "CONFIRMED" for row_id in positive_ids))
        self.assertTrue(all(usages[row_id]["status"] == "UNKNOWN" for row_id in closed_ids))
        queue = json.loads((self.output / "keeper_role_review_queue.json").read_text())
        active_ids = {row["playerTeamSeasonId"] for row in queue["seasonUsageItems"]}
        closed_queue_ids = {row["playerTeamSeasonId"] for row in queue["closedSeasonUsageItems"]}
        self.assertTrue((positive_ids | closed_ids).isdisjoint(active_ids))
        self.assertTrue(closed_ids.issubset(closed_queue_ids))

        ledger_2016 = json.loads(Path(
            "data/manual/wicketkeeper_metadata/v1/research_batches/usage-2016-v1.json"
        ).read_text())
        self.assertEqual({row["matchId"] for row in ledger_2016["routeRecoveries"]}, {
            "980959", "980993",
        })
        self.assertEqual(ledger_2016["legacyCompatibilityFindings"][0]["playerId"], "99d63244")
        self.assertFalse(ledger_2016["legacyCompatibilityFindings"][0]["legacyIsWicketkeeper"])
        self.assertEqual(ledger_2016["legacyCompatibilityFindings"][0]["canonicalUsageResult"], "CONFIRMED")

    def test_2024_followup_ledger_is_supplemental_and_parent_is_unchanged(self) -> None:
        followup = json.loads(Path(
            "data/manual/wicketkeeper_metadata/v1/research_batches/usage-2024-followup-v1.json"
        ).read_text())
        self.assertEqual(followup["batchId"], "usage-2024-followup-v1")
        self.assertEqual(followup["parentBatchId"], "usage-2024-v1")
        self.assertEqual(followup["scopeOrigin"], "SUPPLEMENTAL_CAPABILITY_FREEZE_FOLLOWUP")
        self.assertEqual(followup["scopePlayerTeamSeasonIds"], [
            "pts:1399b39c:ipl-2024:team-sunrisers-hyderabad",
        ])
        self.assertTrue(followup["scopeAudit"]["originalUsage2024LedgerUnchanged"])
        self.assertEqual(followup["summary"]["reviewedUnknown"], 1)
        self.assertEqual(followup["summary"]["sourceGaps"], 0)

    def test_2013_2015_research_ledgers_and_population_are_exact(self) -> None:
        expected = {
            "2013": {"scope": 15, "positives": 10, "unknowns": 5, "sources": 73},
            "2014": {"scope": 7, "positives": 2, "unknowns": 5, "sources": 52},
            "2015": {"scope": 11, "positives": 3, "unknowns": 8, "sources": 56},
        }
        positive_ids = {
            "pts:1c17e270:ipl-2013:team-pune-warriors",
            "pts:2b6e6dec:ipl-2013:team-kings-xi-punjab",
            "pts:30a2649b:ipl-2013:team-delhi-daredevils",
            "pts:6b71e6cf:ipl-2013:team-sunrisers-hyderabad",
            "pts:7050a1e7:ipl-2013:team-kolkata-knight-riders",
            "pts:890946a0:ipl-2013:team-delhi-daredevils",
            "pts:a4cc73aa:ipl-2013:team-rajasthan-royals",
            "pts:b17e2f24:ipl-2013:team-royal-challengers-bangalore",
            "pts:c4487b84:ipl-2013:team-royal-challengers-bangalore",
            "pts:f21043a5:ipl-2013:team-rajasthan-royals",
            "pts:372455c4:ipl-2014:team-delhi-daredevils",
            "pts:b17e2f24:ipl-2014:team-sunrisers-hyderabad",
            "pts:372455c4:ipl-2015:team-delhi-daredevils",
            "pts:855a210c:ipl-2015:team-mumbai-indians",
            "pts:a4cc73aa:ipl-2015:team-rajasthan-royals",
        }
        closed_ids = {
            "pts:0c94f480:ipl-2013:team-delhi-daredevils",
            "pts:5bdcdb72:ipl-2013:team-royal-challengers-bangalore",
            "pts:70d205c9:ipl-2013:team-mumbai-indians",
            "pts:855a210c:ipl-2013:team-mumbai-indians",
            "pts:fe11caa6:ipl-2013:team-chennai-super-kings",
            "pts:272d796e:ipl-2014:team-mumbai-indians",
            "pts:70d205c9:ipl-2014:team-mumbai-indians",
            "pts:99d63244:ipl-2014:team-delhi-daredevils",
            "pts:b8a55852:ipl-2014:team-chennai-super-kings",
            "pts:c4487b84:ipl-2014:team-royal-challengers-bangalore",
            "pts:0c94f480:ipl-2015:team-mumbai-indians",
            "pts:5afd4539:ipl-2015:team-royal-challengers-bangalore",
            "pts:6eb146d2:ipl-2015:team-kings-xi-punjab",
            "pts:70d205c9:ipl-2015:team-mumbai-indians",
            "pts:b17e2f24:ipl-2015:team-sunrisers-hyderabad",
            "pts:b8a55852:ipl-2015:team-chennai-super-kings",
            "pts:c4487b84:ipl-2015:team-royal-challengers-bangalore",
            "pts:f088b960:ipl-2015:team-royal-challengers-bangalore",
        }
        ledger_positive_ids: set[str] = set()
        ledger_closed_ids: set[str] = set()
        for year, counts in expected.items():
            ledger = json.loads(Path(
                f"data/manual/wicketkeeper_metadata/v1/research_batches/usage-{year}-v1.json"
            ).read_text())
            self.assertEqual(ledger["batchId"], f"usage-{year}-v1")
            self.assertEqual(ledger["seasonId"], f"ipl-{year}")
            self.assertEqual(
                ledger["snapshotMetadataManifestHash"],
                "74ab0b8eb27afda9d2cad1c441df2277bc77ee112ae2d69d4e0bec2a4b4565d7",
            )
            self.assertEqual(len(ledger["scopePlayerTeamSeasonIds"]), counts["scope"])
            self.assertEqual(len(ledger["caseResults"]), counts["scope"])
            self.assertEqual(len(ledger["matchSources"]), counts["sources"])
            self.assertEqual(ledger["capabilityFreezeExceptions"], [])
            match_source_ids = {row["matchSourceId"] for row in ledger["matchSources"]}
            self.assertTrue(all(
                set(row["sourceIds"]).issubset(match_source_ids)
                for row in ledger["caseResults"]
            ))
            positives = {
                row["playerTeamSeasonId"] for row in ledger["caseResults"]
                if row["result"] == "POSITIVE_USAGE_FOUND"
            }
            unknowns = {
                row["playerTeamSeasonId"] for row in ledger["caseResults"]
                if row["result"] == "REVIEWED_UNKNOWN"
            }
            self.assertEqual(len(positives), counts["positives"])
            self.assertEqual(len(unknowns), counts["unknowns"])
            ledger_positive_ids.update(positives)
            ledger_closed_ids.update(unknowns)
            self.assertTrue(all(
                row["proposedCanonicalAction"] == "CONFIRMED"
                and row["positiveLocator"]["observedMarker"] == "†"
                for row in ledger["caseResults"] if row["result"] == "POSITIVE_USAGE_FOUND"
            ))
            self.assertTrue(all(
                row["proposedCanonicalAction"] == "REMAIN_UNKNOWN"
                and row["proposedReviewDisposition"] == "CLOSED_UNKNOWN"
                and row["closureCriterionSatisfied"] is True
                and len(row["appearancesReviewed"]) == row["officialAppearances"]
                for row in ledger["caseResults"] if row["result"] == "REVIEWED_UNKNOWN"
            ))
            self.assertEqual(ledger["summary"]["sourceGaps"], 0)
            self.assertEqual(ledger["summary"]["capabilityFreezeExceptions"], 0)
        self.assertEqual(ledger_positive_ids, positive_ids)
        self.assertEqual(ledger_closed_ids, closed_ids)

        usages = {
            row["playerTeamSeasonId"]: row
            for row in read_jsonl(self.output / "player_team_season_usage.jsonl")
        }
        self.assertTrue(all(usages[row_id]["status"] == "CONFIRMED" for row_id in positive_ids))
        self.assertTrue(all(usages[row_id]["status"] == "UNKNOWN" for row_id in closed_ids))
        queue = json.loads((self.output / "keeper_role_review_queue.json").read_text())
        active_ids = {row["playerTeamSeasonId"] for row in queue["seasonUsageItems"]}
        closed_queue_ids = {row["playerTeamSeasonId"] for row in queue["closedSeasonUsageItems"]}
        self.assertTrue((positive_ids | closed_ids).isdisjoint(active_ids))
        self.assertTrue(closed_ids.issubset(closed_queue_ids))

        ledger_2014 = json.loads(Path(
            "data/manual/wicketkeeper_metadata/v1/research_batches/usage-2014-v1.json"
        ).read_text())
        dunk = next(
            row for row in ledger_2014["caseResults"]
            if row["playerTeamSeasonId"] == "pts:272d796e:ipl-2014:team-mumbai-indians"
        )
        self.assertEqual(dunk["officialAppearances"], 3)
        self.assertEqual(dunk["eventOnlyObservations"][0]["matchId"], "734045")
        self.assertFalse(dunk["eventOnlyObservations"][0]["includedInOfficialAppearanceDenominator"])

        ledger_2015 = json.loads(Path(
            "data/manual/wicketkeeper_metadata/v1/research_batches/usage-2015-v1.json"
        ).read_text())
        chand = next(
            row for row in ledger_2015["caseResults"]
            if row["playerTeamSeasonId"] == "pts:0c94f480:ipl-2015:team-mumbai-indians"
        )
        self.assertEqual(chand["officialAppearances"], 6)
        self.assertEqual(chand["eventOnlyObservations"][0]["matchId"], "829817")
        self.assertFalse(chand["eventOnlyObservations"][0]["includedInOfficialAppearanceDenominator"])
        recovered_match_ids = {
            row["matchId"]
            for year in ("2013", "2014", "2015")
            for row in json.loads(Path(
                f"data/manual/wicketkeeper_metadata/v1/research_batches/usage-{year}-v1.json"
            ).read_text())["routeRecoveries"]
        }
        self.assertEqual(recovered_match_ids, {"597998", "733999", "734011", "829705", "829799"})

    def test_2011_2012_research_ledgers_and_population_are_exact(self) -> None:
        expected = {
            "2011": {"scope": 13, "positives": 5, "unknowns": 8, "sources": 67},
            "2012": {"scope": 10, "positives": 3, "unknowns": 7, "sources": 58},
        }
        positive_ids = {
            "pts:3a02626a:ipl-2011:team-rajasthan-royals",
            "pts:5748e866:ipl-2011:team-pune-warriors",
            "pts:7daedf2f:ipl-2011:team-royal-challengers-bangalore",
            "pts:890946a0:ipl-2011:team-delhi-daredevils",
            "pts:f3cb53a1:ipl-2011:team-kolkata-knight-riders",
            "pts:063b3673:ipl-2012:team-rajasthan-royals",
            "pts:2b6e6dec:ipl-2012:team-kings-xi-punjab",
            "pts:6b71e6cf:ipl-2012:team-deccan-chargers",
        }
        closed_ids = {
            "pts:0c94f480:ipl-2011:team-delhi-daredevils",
            "pts:5bdcdb72:ipl-2011:team-royal-challengers-bangalore",
            "pts:95a2ea61:ipl-2011:team-chennai-super-kings",
            "pts:99d63244:ipl-2011:team-kochi-tuskers-kerala",
            "pts:afa7e784:ipl-2011:team-delhi-daredevils",
            "pts:b8a55852:ipl-2011:team-kochi-tuskers-kerala",
            "pts:c03f1114:ipl-2011:team-kings-xi-punjab",
            "pts:fe11caa6:ipl-2011:team-chennai-super-kings",
            "pts:0c94f480:ipl-2012:team-delhi-daredevils",
            "pts:5bdcdb72:ipl-2012:team-royal-challengers-bangalore",
            "pts:6eb146d2:ipl-2012:team-kings-xi-punjab",
            "pts:7050a1e7:ipl-2012:team-kolkata-knight-riders",
            "pts:70d205c9:ipl-2012:team-mumbai-indians",
            "pts:95a2ea61:ipl-2012:team-chennai-super-kings",
            "pts:fe11caa6:ipl-2012:team-chennai-super-kings",
        }
        ledger_positive_ids: set[str] = set()
        ledger_closed_ids: set[str] = set()
        for year, counts in expected.items():
            ledger = json.loads(Path(
                f"data/manual/wicketkeeper_metadata/v1/research_batches/usage-{year}-v1.json"
            ).read_text())
            self.assertEqual(ledger["batchId"], f"usage-{year}-v1")
            self.assertEqual(ledger["seasonId"], f"ipl-{year}")
            self.assertEqual(
                ledger["snapshotMetadataManifestHash"],
                "369bbe3e7248010786668cf5541aec1f00a92da95066b7a86c31c4b4a195314a",
            )
            self.assertEqual(len(ledger["scopePlayerTeamSeasonIds"]), counts["scope"])
            self.assertEqual(len(ledger["caseResults"]), counts["scope"])
            self.assertEqual(len(ledger["matchSources"]), counts["sources"])
            self.assertEqual(ledger["capabilityFreezeExceptions"], [])
            source_ids = {row["matchSourceId"] for row in ledger["matchSources"]}
            self.assertTrue(all(
                set(row["sourceIds"]).issubset(source_ids)
                for row in ledger["caseResults"]
            ))
            positives = {
                row["playerTeamSeasonId"] for row in ledger["caseResults"]
                if row["result"] == "POSITIVE_USAGE_FOUND"
            }
            unknowns = {
                row["playerTeamSeasonId"] for row in ledger["caseResults"]
                if row["result"] == "REVIEWED_UNKNOWN"
            }
            self.assertEqual(len(positives), counts["positives"])
            self.assertEqual(len(unknowns), counts["unknowns"])
            ledger_positive_ids.update(positives)
            ledger_closed_ids.update(unknowns)
            self.assertTrue(all(
                row["proposedCanonicalAction"] == "CONFIRMED"
                and row["positiveLocator"]["observedMarker"] == "†"
                for row in ledger["caseResults"] if row["result"] == "POSITIVE_USAGE_FOUND"
            ))
            self.assertTrue(all(
                row["proposedCanonicalAction"] == "REMAIN_UNKNOWN"
                and row["proposedReviewDisposition"] == "CLOSED_UNKNOWN"
                and row["closureCriterionSatisfied"] is True
                and len(row["appearancesReviewed"]) == row["officialAppearances"]
                for row in ledger["caseResults"] if row["result"] == "REVIEWED_UNKNOWN"
            ))
            self.assertEqual(ledger["summary"]["sourceGaps"], 0)
            self.assertEqual(ledger["summary"]["capabilityFreezeExceptions"], 0)
        self.assertEqual(ledger_positive_ids, positive_ids)
        self.assertEqual(ledger_closed_ids, closed_ids)

        usages = {
            row["playerTeamSeasonId"]: row
            for row in read_jsonl(self.output / "player_team_season_usage.jsonl")
        }
        self.assertTrue(all(usages[row_id]["status"] == "CONFIRMED" for row_id in positive_ids))
        self.assertTrue(all(usages[row_id]["status"] == "UNKNOWN" for row_id in closed_ids))
        queue = json.loads((self.output / "keeper_role_review_queue.json").read_text())
        active_ids = {row["playerTeamSeasonId"] for row in queue["seasonUsageItems"]}
        closed_queue_ids = {row["playerTeamSeasonId"] for row in queue["closedSeasonUsageItems"]}
        self.assertTrue((positive_ids | closed_ids).isdisjoint(active_ids))
        self.assertTrue(closed_ids.issubset(closed_queue_ids))

        ledger_2011 = json.loads(Path(
            "data/manual/wicketkeeper_metadata/v1/research_batches/usage-2011-v1.json"
        ).read_text())
        self.assertEqual(
            {row["matchId"] for row in ledger_2011["routeRecoveries"]},
            {"501210", "501246", "501247", "501251", "501252", "501257"},
        )
        arun = next(
            row for row in ledger_2011["caseResults"]
            if row["playerTeamSeasonId"]
            == "pts:7daedf2f:ipl-2011:team-royal-challengers-bangalore"
        )
        self.assertEqual(arun["officialAppearances"], 3)
        self.assertEqual(arun["eventOnlyObservations"][0]["matchId"], "501247")
        self.assertFalse(arun["eventOnlyObservations"][0]["includedInOfficialAppearanceDenominator"])
        self.assertEqual(ledger_2011["identityNormalizations"][0]["playerId"], "1c17e270")

        ledger_2012 = json.loads(Path(
            "data/manual/wicketkeeper_metadata/v1/research_batches/usage-2012-v1.json"
        ).read_text())
        event_only = {
            row["playerTeamSeasonId"]: row["eventOnlyObservations"][0]["matchId"]
            for row in ledger_2012["caseResults"] if "eventOnlyObservations" in row
        }
        self.assertEqual(event_only, {
            "pts:5bdcdb72:ipl-2012:team-royal-challengers-bangalore": "548318",
            "pts:fe11caa6:ipl-2012:team-chennai-super-kings": "548355",
        })

    def test_legacy_migration_and_conflicts(self) -> None:
        report = json.loads((self.output / "legacy_migration_report.json").read_text())
        self.assertEqual(report["summary"], {
            "rows": 147, "supportedPositives": 16, "unverifiedPositives": 0,
            "conflictingNegatives": 7, "unsupportedNegatives": 124,
            "seasonSpecific2016UsageConflicts": 2,
        })
        conflicts = {row["canonicalDisplayName"]: row for row in report["rows"] if row["classification"] == "CONFLICTING_NEGATIVE"}
        self.assertEqual(set(conflicts), {"AP Tare", "AT Rayudu", "Gurkeerat Singh", "KD Karthik", "KM Jadhav", "PSP Handscomb", "SN Khan"})
        self.assertEqual(conflicts["KD Karthik"]["ipl2016Stumpings"], 3)
        self.assertTrue(conflicts["KM Jadhav"]["legacy2016UsageConflict"])
        self.assertEqual(conflicts["KM Jadhav"]["ipl2016UsageStatus"], "CONFIRMED")
        self.assertEqual(
            conflicts["KM Jadhav"]["ipl2016UsageEvidenceRefs"],
            ["manual:espn-ipl-2016-980907"],
        )
        supported = {row["canonicalDisplayName"] for row in report["rows"] if row["classification"] == "SUPPORTED_POSITIVE"}
        self.assertTrue({"ER Dwivedi", "NS Naik"}.issubset(supported))

    def test_keeper_role_queue_is_separate_and_auditable(self) -> None:
        queue = json.loads((self.output / "keeper_role_review_queue.json").read_text())
        self.assertEqual(queue["summary"]["seasonUsageReviews"], 27)
        self.assertEqual(queue["summary"]["currentlyG2EligibleUsageReviews"], 27)
        self.assertEqual(queue["summary"]["eligibilityCriticalOverlap"], 0)
        self.assertEqual(queue["summary"]["legacyCapabilityCandidates"], 0)
        self.assertEqual(queue["summary"]["closedSeasonUsageReviews"], 137)
        self.assertEqual(queue["summary"]["closedCapabilityReviews"], 15)
        self.assertTrue(all(row["reviewStatus"] == "CLOSED_UNKNOWN" for row in queue["closedSeasonUsageItems"]))
        self.assertTrue(all(row["reviewStatus"] == "CLOSED_UNKNOWN" for row in queue["closedCapabilityItems"]))
        self.assertTrue(queue["summary"]["positiveDiscoveryComplete"])
        self.assertEqual(
            queue["positiveDiscoveryScope"]["status"],
            "FROZEN_WITH_DOCUMENTED_LIMITATIONS",
        )
        self.assertIn("2008-2015", queue["positiveDiscoveryScope"]["description"])
        self.assertIn("Sunny Singh remains UNKNOWN", queue["positiveDiscoveryScope"]["description"])

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
