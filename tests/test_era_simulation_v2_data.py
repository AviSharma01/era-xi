from __future__ import annotations

import json
import unittest
from pathlib import Path

from scripts.era_simulation_v2_data import ROOT, environment_rows, rows


class EraSimulationV2DataTests(unittest.TestCase):
    def setUp(self) -> None:
        self.output = ROOT / "data/processed/era-draft/simulation/v2"
        self.environments = json.loads((self.output / "era_environments.json").read_text())["environments"]
        self.opponents = json.loads((self.output / "foundation_opponents.json").read_text())["opponents"]

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


if __name__ == "__main__":
    unittest.main()
