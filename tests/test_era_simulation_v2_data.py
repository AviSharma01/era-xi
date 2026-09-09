from __future__ import annotations

import json
import hashlib
import unittest
from pathlib import Path

from scripts.cricsheet_audit.reporting import canonical_json_bytes
from scripts.era_simulation_v2_data import (
    ERA_IDS,
    EXPECTED_CANDIDATES,
    EXPECTED_LINEAGES,
    FOUNDATION_OPPONENT_SHA256,
    FOUNDATION_SIMULATION_COMPATIBILITY_FINGERPRINT,
    ROOT,
    build_phase1_files,
    environment_rows,
    rows,
)


class EraSimulationV2DataTests(unittest.TestCase):
    def setUp(self) -> None:
        self.output = ROOT / "data/processed/era-draft/simulation/v2"
        self.environments = json.loads((self.output / "era_environments.json").read_text())["environments"]
        self.opponents = json.loads((self.output / "foundation_opponents.json").read_text())["opponents"]
        self.candidate_document = json.loads((self.output / "all_era_opponent_candidates.json").read_text())
        self.review_document = json.loads((self.output / "later_era_opponent_review_packets.json").read_text())
        self.phase1_manifest = json.loads((self.output / "stage9a_phase1_manifest.json").read_text())
        self.phase1_validation = json.loads((self.output / "stage9a_phase1_validation_report.json").read_text())

    def test_all_five_era_environments_recompute_from_all_normal_stage_4_matches(self) -> None:
        eras = json.loads((ROOT / "data/registries/ipl/v1/eras.json").read_text())["eras"]
        matches = rows(ROOT / "data/analytical/cricsheet-ipl/v1/match_summaries.jsonl")
        self.assertEqual(environment_rows(eras, matches), self.environments)
        self.assertEqual(len(self.environments), 5)
        self.assertTrue(all(item["sourceCohort"] == "all_normal" for item in self.environments))
        self.assertTrue(all(item["sample"]["matches"] > 0 for item in self.environments))

    def test_foundation_opponents_are_explicitly_reviewed_and_legal(self) -> None:
        self.assertEqual(len(self.opponents), 8)
        self.assertEqual(len({item["franchiseId"] for item in self.opponents}), 8)
        for opponent in self.opponents:
            self.assertEqual(opponent["review"]["status"], "APPROVED")
            self.assertTrue(opponent["review"]["heuristicIsAdvisory"])
            self.assertEqual(len(opponent["xi"]), 11)
            self.assertEqual([item["position"] for item in opponent["xi"]], list(range(1, 12)))
            self.assertEqual(len({item["playerId"] for item in opponent["xi"]}), 11)
            self.assertLessEqual(sum(item["rosterStatus"] == "OVERSEAS" for item in opponent["xi"]), 4)

    def test_manifest_hashes_cover_every_frozen_and_reviewed_input(self) -> None:
        manifest = json.loads((self.output / "manifest.json").read_text())
        self.assertEqual(manifest["outputCounts"], {
            "environments": 5,
            "foundationCandidates": 24,
            "foundationOpponents": 8,
        })
        self.assertIn("data/manual/era-simulation/v2/foundation_opponents.json", manifest["inputHashes"])
        self.assertIn("data/processed/era-draft/roles/v1/player_role_consumer.jsonl", manifest["inputHashes"])
        self.assertIn("data/processed/era-draft/quality/v1/player_quality_consumer.jsonl", manifest["inputHashes"])

    def test_all_era_candidate_and_lineage_baselines_are_exact(self) -> None:
        candidates = self.candidate_document["candidates"]
        self.assertEqual(len(candidates), 166)
        self.assertEqual(self.candidate_document["candidateCountsByEra"], EXPECTED_CANDIDATES)
        actual_counts = {
            era_id: sum(candidate["eraId"] == era_id for candidate in candidates)
            for era_id in ERA_IDS
        }
        actual_lineages = {
            era_id: len({
                candidate["franchiseId"] for candidate in candidates
                if candidate["eraId"] == era_id
            })
            for era_id in ERA_IDS
        }
        self.assertEqual(actual_counts, EXPECTED_CANDIDATES)
        self.assertEqual(actual_lineages, EXPECTED_LINEAGES)
        self.assertEqual(
            [(candidate["teamId"], candidate["seasonId"]) for candidate in candidates],
            sorted((candidate["teamId"], candidate["seasonId"]) for candidate in candidates),
        )
        self.assertEqual(len({(candidate["teamId"], candidate["seasonId"]) for candidate in candidates}), 166)

    def test_every_candidate_xi_is_legal_and_strictly_joined(self) -> None:
        role_by_id = {
            row["playerTeamSeasonId"]: row
            for row in rows(ROOT / "data/processed/era-draft/roles/v1/player_role_consumer.jsonl")
        }
        quality_by_id = {
            row["playerTeamSeasonId"]: row
            for row in rows(ROOT / "data/processed/era-draft/quality/v1/player_quality_consumer.jsonl")
        }
        roster_by_id = {
            row["playerTeamSeasonId"]: row
            for row in rows(ROOT / "data/metadata/ipl/country_overseas/v1/player_team_season_metadata.jsonl")
        }
        for candidate in self.candidate_document["candidates"]:
            xi = candidate["xi"]
            self.assertEqual(len(xi), 11, candidate["candidateId"])
            self.assertEqual([player["position"] for player in xi], list(range(1, 12)))
            self.assertEqual(len({player["playerId"] for player in xi}), 11)
            self.assertLessEqual(sum(player["rosterStatus"] == "OVERSEAS" for player in xi), 4)
            self.assertGreaterEqual(candidate["diagnostics"]["legality"]["confirmedKeeperCount"], 1)
            self.assertTrue(candidate["diagnostics"]["replacementContext"]["diagnosticOnly"])
            self.assertTrue(candidate["selectionHeuristic"]["advisoryOnly"])
            for player in xi:
                identity = (
                    player["playerId"], candidate["seasonId"], candidate["teamId"], candidate["franchiseId"],
                )
                role = role_by_id[player["playerTeamSeasonId"]]
                quality = quality_by_id[player["playerTeamSeasonId"]]
                roster = roster_by_id[player["playerTeamSeasonId"]]
                self.assertEqual((role["playerId"], role["seasonId"], role["teamId"], role["franchiseId"]), identity)
                self.assertEqual((quality["playerId"], quality["seasonId"], quality["teamId"], quality["franchiseId"]), identity)
                self.assertEqual((roster["playerId"], roster["seasonId"], roster["teamId"]), identity[:3])
                self.assertEqual(roster["iplRosterStatus"], player["rosterStatus"])

    def test_all_later_era_review_packets_are_pending_and_unselected(self) -> None:
        packets = self.review_document["packets"]
        self.assertEqual(len(packets), 41)
        self.assertEqual(self.review_document["pendingLineageDecisions"], 41)
        self.assertEqual(self.review_document["lineageCountsByEra"], EXPECTED_LINEAGES)
        self.assertEqual(len({(packet["eraId"], packet["franchiseId"]) for packet in packets}), 41)
        self.assertNotIn("era-foundation", {packet["eraId"] for packet in packets})
        for packet in packets:
            self.assertEqual(packet["reviewStatus"], "PENDING")
            self.assertIsNone(packet["selectedCandidateId"])
            self.assertIsNone(packet["reviewerRationale"])
            self.assertIsNone(packet["reviewedOn"])
            self.assertEqual(packet["candidateCount"], len(packet["candidatesInAdvisoryOrder"]))
            ranked = packet["candidatesInAdvisoryOrder"]
            self.assertEqual([candidate["advisoryRank"] for candidate in ranked], list(range(1, len(ranked) + 1)))
            self.assertEqual(len({candidate["candidateId"] for candidate in ranked}), len(ranked))
            self.assertTrue(all(candidate["selectionHeuristic"]["advisoryOnly"] for candidate in ranked))
            self.assertEqual(
                [(candidate["selectionHeuristic"]["candidateScore"], candidate["candidateId"]) for candidate in ranked],
                sorted(
                    ((candidate["selectionHeuristic"]["candidateScore"], candidate["candidateId"]) for candidate in ranked),
                    key=lambda item: (-item[0], item[1]),
                ),
            )

    def test_phase1_provenance_and_foundation_contract_are_explicit(self) -> None:
        manifest = self.phase1_manifest
        validation = self.phase1_validation
        required_inputs = {
            "data/registries/ipl/v1/registry_manifest.json",
            "data/registries/ipl/v1/eras.json",
            "data/registries/ipl/v1/teams.json",
            "data/registries/ipl/v1/franchises.json",
            "data/analytical/cricsheet-ipl/v1/analytical_manifest.json",
            "data/processed/era-draft/roles/v1/role_manifest.json",
            "data/processed/era-draft/quality/v1/quality_manifest.json",
            "data/metadata/ipl/country_overseas/v1/metadata_manifest.json",
            "data/metadata/ipl/v1/metadata_manifest.json",
            "data/metadata/ipl/v1/player_capabilities.jsonl",
            "data/metadata/ipl/v1/player_team_season_usage.jsonl",
            "data/manual/era-simulation/v2/foundation_opponents.json",
            "data/processed/era-draft/simulation/v2/foundation_opponents.json",
            "tests/fixtures/stage9a/foundation_stage8_parity.json",
        }
        self.assertTrue(required_inputs <= {item["path"] for item in manifest["inputs"]})
        self.assertEqual(manifest["foundationSimulationCompatibilityFingerprint"], FOUNDATION_SIMULATION_COMPATIBILITY_FINGERPRINT)
        without_hash = dict(manifest)
        recorded_hash = without_hash.pop("phase1ManifestHash")
        self.assertEqual(hashlib.sha256(canonical_json_bytes(without_hash)).hexdigest(), recorded_hash)
        self.assertEqual(validation["phase1ManifestHash"], recorded_hash)
        self.assertEqual(validation["foundationParity"]["opponentArtifactSha256"], FOUNDATION_OPPONENT_SHA256)
        self.assertEqual(validation["foundationParity"]["simulationCompatibilityFingerprint"], FOUNDATION_SIMULATION_COMPATIBILITY_FINGERPRINT)
        self.assertTrue(validation["foundationParity"]["candidateRepresentationExact"])
        self.assertTrue(validation["foundationParity"]["approvedProfilesExact"])
        self.assertTrue(validation["foundationParity"]["eraEnvironmentsExact"])
        for entry in manifest["inputs"]:
            path = ROOT / entry["path"]
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), entry["sha256"])
            self.assertEqual(path.stat().st_size, entry["sizeBytes"])

    def test_phase1_generation_is_byte_deterministic(self) -> None:
        first, _ = build_phase1_files()
        second, _ = build_phase1_files()
        self.assertEqual(first, second)
        for relative_path, content in first.items():
            self.assertEqual((self.output / relative_path).read_bytes(), content, relative_path)


if __name__ == "__main__":
    unittest.main()
