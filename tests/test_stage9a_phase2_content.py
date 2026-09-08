from __future__ import annotations

import hashlib
import json
import unittest

from scripts.cricsheet_audit.reporting import canonical_json_bytes
from scripts.era_simulation_v2_data import FOUNDATION_OPPONENT_SHA256, ROOT, aggregate_hash, rows
from scripts.stage9a_phase2_content import (
    EXPECTED_APPROVED_CANDIDATE_IDS,
    EXPECTED_IMPACT_MEMBERSHIP_CHANGES,
    EXPECTED_LATER_COUNTS,
    EXPECTED_OVERRIDE_COUNTS,
    EXPECTED_REVIEWED_XIS,
    FROZEN_PROFILE_FILES,
    MANUAL_REVIEW_FILES,
    OUTPUT,
    build_phase2_files,
    phase2_schema_documents,
)
from scripts.identity_registry.schemas import validate_instance


class Stage9APhase2ContentTests(unittest.TestCase):
    def setUp(self) -> None:
        self.phase1 = json.loads((OUTPUT / "all_era_opponent_candidates.json").read_text())
        self.phase1_by_id = {item["candidateId"]: item for item in self.phase1["candidates"]}
        self.documents = {
            era_id: json.loads((OUTPUT / file_name).read_text())
            for era_id, file_name in FROZEN_PROFILE_FILES.items()
        }
        self.profiles = [
            profile for document in self.documents.values() for profile in document["opponents"]
        ]
        self.by_id = {item["candidateId"]: item for item in self.profiles}
        self.manifest = json.loads((OUTPUT / "stage9a_phase2_manifest.json").read_text())
        self.validation = json.loads((OUTPUT / "stage9a_phase2_validation_report.json").read_text())

    def test_four_manual_approval_documents_are_strict_and_complete(self) -> None:
        schema = phase2_schema_documents()["stage9a_phase2_manual_review.schema.json"]
        approved = []
        for era_id, path in MANUAL_REVIEW_FILES.items():
            document = json.loads(path.read_text())
            validate_instance(document, schema)
            self.assertEqual(document["eraId"], era_id)
            self.assertEqual(document["reviewStatus"], "APPROVED")
            self.assertEqual(document["reviewedOn"], "2026-09-08")
            self.assertEqual(len(document["opponents"]), EXPECTED_LATER_COUNTS[era_id])
            approved.extend(document["opponents"])
        self.assertEqual(len(approved), 41)
        self.assertEqual({item["candidateId"] for item in approved}, EXPECTED_APPROVED_CANDIDATE_IDS)
        self.assertTrue(all(item["approvalStatus"] == "APPROVED" for item in approved))
        self.assertTrue(all(item["rationale"] for item in approved))

    def test_all_approved_seasons_and_reviewed_xis_are_exact(self) -> None:
        self.assertEqual(set(self.by_id), EXPECTED_APPROVED_CANDIDATE_IDS)
        reviewed = {
            candidate_id: [item["playerTeamSeasonId"] for item in self.by_id[candidate_id]["xi"]]
            for candidate_id in EXPECTED_REVIEWED_XIS
        }
        self.assertEqual(reviewed, EXPECTED_REVIEWED_XIS)
        provenance_counts = {
            key: sum(profile["review"]["xiProvenance"] == key for profile in self.profiles)
            for key in EXPECTED_OVERRIDE_COUNTS
        }
        self.assertEqual(provenance_counts, EXPECTED_OVERRIDE_COUNTS)

    def test_all_31_baseline_approvals_match_phase1_exactly(self) -> None:
        baseline_profiles = [
            profile for profile in self.profiles
            if profile["review"]["xiProvenance"] == "BASELINE_ACCEPTED"
        ]
        self.assertEqual(len(baseline_profiles), 31)
        for profile in baseline_profiles:
            phase1 = self.phase1_by_id[profile["candidateId"]]
            self.assertEqual(profile["xi"], phase1["xi"], profile["candidateId"])
            self.assertEqual(profile["evaluation"], phase1["evaluation"], profile["candidateId"])
            self.assertEqual(profile["diagnostics"], phase1["diagnostics"], profile["candidateId"])

    def test_all_41_profiles_are_strictly_joined_g2_eligible_and_legal(self) -> None:
        roles = {item["playerTeamSeasonId"]: item for item in rows(ROOT / "data/processed/era-draft/roles/v1/player_role_consumer.jsonl")}
        quality = {item["playerTeamSeasonId"]: item for item in rows(ROOT / "data/processed/era-draft/quality/v1/player_quality_consumer.jsonl")}
        roster = {item["playerTeamSeasonId"]: item for item in rows(ROOT / "data/metadata/ipl/country_overseas/v1/player_team_season_metadata.jsonl")}
        eligibility = {item["playerTeamSeasonId"]: item for item in rows(ROOT / "data/processed/era-draft/v1/eligibility.jsonl")}
        self.assertEqual(len(self.profiles), 41)
        self.assertEqual(len({(item["eraId"], item["franchiseId"]) for item in self.profiles}), 41)
        for profile in self.profiles:
            xi = profile["xi"]
            self.assertEqual([item["position"] for item in xi], list(range(1, 12)))
            self.assertEqual(len({item["playerId"] for item in xi}), 11)
            self.assertLessEqual(sum(item["rosterStatus"] == "OVERSEAS" for item in xi), 4)
            self.assertGreaterEqual(profile["diagnostics"]["legality"]["confirmedKeeperCount"], 1)
            for player in xi:
                pts_id = player["playerTeamSeasonId"]
                identity = (player["playerId"], profile["seasonId"], profile["teamId"], profile["franchiseId"])
                self.assertEqual((roles[pts_id]["playerId"], roles[pts_id]["seasonId"], roles[pts_id]["teamId"], roles[pts_id]["franchiseId"]), identity)
                self.assertEqual((quality[pts_id]["playerId"], quality[pts_id]["seasonId"], quality[pts_id]["teamId"], quality[pts_id]["franchiseId"]), identity)
                self.assertEqual((roster[pts_id]["playerId"], roster[pts_id]["seasonId"], roster[pts_id]["teamId"]), identity[:3])
                self.assertIn(roster[pts_id]["iplRosterStatus"], {"INDIAN", "OVERSEAS"})
                self.assertEqual(roster[pts_id]["iplRosterStatus"], player["rosterStatus"])
                self.assertEqual(eligibility[pts_id]["eligibilityStatus"], "ELIGIBLE")

    def test_reviewed_evaluations_match_approved_values(self) -> None:
        expected = {
            "opponent:team-chennai-super-kings:ipl-2015": (55.453929, 73.805912, 64.62992),
            "opponent:team-gujarat-lions:ipl-2016": (54.873214, 62.871259, 58.872237),
            "opponent:team-sunrisers-hyderabad:ipl-2016": (51.347143, 71.18, 61.263571),
            "opponent:team-gujarat-titans:ipl-2022": (59.609643, 62.61633, 61.112986),
            "opponent:team-kolkata-knight-riders:ipl-2021": (57.137143, 63.989256, 60.563199),
            "opponent:team-lucknow-super-giants:ipl-2022": (58.088929, 67.526665, 62.807797),
            "opponent:team-chennai-super-kings:ipl-2023": (62.548571, 71.24, 66.894286),
            "opponent:team-kolkata-knight-riders:ipl-2024": (62.053214, 78.022866, 70.03804),
            "opponent:team-punjab-kings:ipl-2025": (60.232857, 64.569406, 62.401131),
            "opponent:team-royal-challengers-bengaluru:ipl-2025": (57.973929, 69.36, 63.666964),
        }
        self.assertEqual(set(expected), set(EXPECTED_REVIEWED_XIS))
        for candidate_id, values in expected.items():
            evaluation = self.by_id[candidate_id]["evaluation"]
            self.assertEqual((evaluation["batting"], evaluation["bowling"], evaluation["overall"]), values)

    def test_impact_membership_changes_and_rationales_are_preserved(self) -> None:
        actual = {
            item["candidateId"]: item["review"]["membershipChanges"]
            for item in self.profiles if item["review"]["overrideType"] == "MEMBERSHIP_AND_ORDER"
        }
        self.assertEqual(actual, EXPECTED_IMPACT_MEMBERSHIP_CHANGES)
        self.assertTrue(all(self.by_id[candidate_id]["review"]["overrideRationale"] for candidate_id in actual))
        self.assertIn("structural consequence", self.by_id["opponent:team-punjab-kings:ipl-2025"]["review"]["overrideRationale"])

    def test_profile_coverage_foundation_parity_and_runtime_boundary(self) -> None:
        self.assertEqual({era_id: len(document["opponents"]) for era_id, document in self.documents.items()}, EXPECTED_LATER_COUNTS)
        foundation = json.loads((OUTPUT / "foundation_opponents.json").read_text())
        self.assertEqual(len(foundation["opponents"]), 8)
        self.assertEqual(len(self.profiles) + len(foundation["opponents"]), 49)
        self.assertEqual(hashlib.sha256((OUTPUT / "foundation_opponents.json").read_bytes()).hexdigest(), FOUNDATION_OPPONENT_SHA256)
        self.assertTrue(all(document["runtimeIntegrationStatus"] == "NOT_INTEGRATED" for document in self.documents.values()))

    def test_phase2_provenance_hashes_and_validation_report_are_complete(self) -> None:
        without_hash = dict(self.manifest)
        recorded_hash = without_hash.pop("phase2ManifestHash")
        self.assertEqual(hashlib.sha256(canonical_json_bytes(without_hash)).hexdigest(), recorded_hash)
        self.assertEqual(self.validation["phase2ManifestHash"], recorded_hash)
        for entry in self.manifest["inputs"]:
            path = ROOT / entry["path"]
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), entry["sha256"])
            self.assertEqual(path.stat().st_size, entry["sizeBytes"])
        covered = self.manifest["artifacts"] + self.manifest["schemaFiles"]
        aggregate_inputs = {}
        for entry in covered:
            content = (OUTPUT / entry["path"]).read_bytes()
            self.assertEqual(hashlib.sha256(content).hexdigest(), entry["sha256"])
            self.assertEqual(len(content), entry["sizeBytes"])
            aggregate_inputs[entry["path"]] = content
        self.assertEqual(aggregate_hash(aggregate_inputs), self.manifest["opponentContentDataAggregateHash"])
        self.assertEqual(self.validation["status"], "PASSED")
        self.assertEqual(self.validation["unresolvedReviewCount"], 0)
        self.assertTrue(self.validation["phase1EvidencePreserved"])

    def test_phase2_generation_is_byte_deterministic(self) -> None:
        first, _ = build_phase2_files()
        second, _ = build_phase2_files()
        self.assertEqual(first, second)
        for relative_path, content in first.items():
            self.assertEqual((OUTPUT / relative_path).read_bytes(), content, relative_path)


if __name__ == "__main__":
    unittest.main()
