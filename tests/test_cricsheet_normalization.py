from __future__ import annotations

import copy
import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path

from scripts.cricsheet_normalization.builder import (
    EXPECTED_ARCHIVE_MANIFEST_HASH,
    EXPECTED_REGISTRY_AGGREGATE_HASH,
    EXPECTED_REGISTRY_VERSION,
    build_normalized_archive,
)
from scripts.cricsheet_normalization.normalizer import MatchNormalizationError, normalize_match
from scripts.cricsheet_normalization.schemas import build_schema_documents
from scripts.identity_registry.resolver import IdentityResolver
from scripts.identity_registry.schemas import SchemaValidationError, validate_instance


RAW_DIR = Path("data/raw/cricsheet")
REGISTRY_DIR = Path("data/registries/ipl/v1")
POLICY_PATH = Path("data/manual/identity/v1/registry_policy.json")


@unittest.skipUnless(RAW_DIR.is_dir(), "local Cricsheet archive unavailable")
class NormalizedMatchFixtureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.resolver = IdentityResolver.load(
            REGISTRY_DIR,
            policy_path=POLICY_PATH,
            expected_registry_version=EXPECTED_REGISTRY_VERSION,
            expected_registry_aggregate_hash=EXPECTED_REGISTRY_AGGREGATE_HASH,
            expected_source_archive_manifest_hash=EXPECTED_ARCHIVE_MANIFEST_HASH,
        )
        cls.schema = build_schema_documents()["normalized_match.schema.json"]

    def normalize(self, match_id: str, data: dict | None = None):
        path = RAW_DIR / f"{match_id}.json"
        raw_bytes = path.read_bytes()
        source = json.loads(raw_bytes) if data is None else data
        result = normalize_match(
            source,
            match_id=match_id,
            relative_source_path=f"{match_id}.json",
            source_file_sha256=hashlib.sha256(raw_bytes).hexdigest(),
            source_archive_manifest_hash=EXPECTED_ARCHIVE_MANIFEST_HASH,
            identity_registry_version=EXPECTED_REGISTRY_VERSION,
            identity_registry_aggregate_hash=EXPECTED_REGISTRY_AGGREGATE_HASH,
            resolver=self.resolver,
        )
        validate_instance(result.document, self.schema)
        return result

    def test_representative_match_shapes(self) -> None:
        ordinary = self.normalize("335982")
        self.assertEqual(ordinary.counts["normalInnings"], 2)
        self.assertEqual(ordinary.counts["superOverInnings"], 0)

        adjusted = self.normalize("336022")
        self.assertEqual(adjusted.document["outcome"]["method"], "D/L")

        no_result = self.normalize("501265")
        self.assertEqual(no_result.document["outcome"]["resultType"], "no_result")
        self.assertEqual(no_result.counts["normalInnings"], 1)

        super_over = self.normalize("392190")
        self.assertEqual(super_over.counts["superOverInnings"], 2)

        double_super_over = self.normalize("1216517")
        self.assertEqual(double_super_over.counts["superOverInnings"], 4)

        multi_date = self.normalize("734043")
        self.assertEqual(len(multi_date.document["dates"]), 2)

    def test_replacement_and_exception_evidence(self) -> None:
        miscounted = self.normalize("335987")
        self.assertTrue(any(innings["miscountedOvers"] for innings in miscounted.document["innings"]))

        impact = self.normalize("1359507")
        self.assertGreater(impact.counts["impactPlayerReplacements"], 0)

        concussion = self.normalize("1370352")
        self.assertGreater(concussion.counts["concussionSubstitutes"], 0)
        self.assertIn(13, [
            sum(
                participant["teamId"] == team["teamId"] and participant["sourceListStatus"] == "official_listed"
                for participant in concussion.document["participants"]
            )
            for team in concussion.document["teams"]
        ])

        role = self.normalize("1082622")
        self.assertGreater(role.counts["roleReplacements"], 0)

        event_only = self.normalize("335991")
        self.assertTrue(any(
            participant["sourceListStatus"] == "event_only"
            for participant in event_only.document["participants"]
        ))

    def test_independent_ball_semantics_and_actual_delivery_trace(self) -> None:
        result = self.normalize("335983")
        deliveries = [
            delivery
            for innings in result.document["innings"]
            for over in innings["overs"]
            for delivery in over["deliveries"]
        ]
        wide = next(delivery for delivery in deliveries if delivery["extras"]["wides"])
        no_ball = next(delivery for delivery in deliveries if delivery["extras"]["noBalls"])
        ordinary = next(
            delivery for delivery in deliveries
            if not delivery["extras"]["wides"] and not delivery["extras"]["noBalls"]
        )
        self.assertEqual((wide["isBowlerLegalDelivery"], wide["countsAsBatterBall"]), (False, False))
        self.assertEqual((no_ball["isBowlerLegalDelivery"], no_ball["countsAsBatterBall"]), (False, True))
        self.assertEqual((ordinary["isBowlerLegalDelivery"], ordinary["countsAsBatterBall"]), (True, True))
        actual_values = [delivery["actualDelivery"] for delivery in deliveries]
        self.assertLess(len(set(actual_values)), len(actual_values))

    def test_unseen_alias_and_unknown_source_field_are_fatal(self) -> None:
        source = json.loads((RAW_DIR / "335982.json").read_text(encoding="utf-8"))
        delivery = source["innings"][0]["overs"][0]["deliveries"][0]
        registered_name = delivery["batter"]
        player_id = source["info"]["registry"]["people"][registered_name]
        delivery["batter"] = "Unseen Runtime Alias"
        source["info"]["registry"]["people"]["Unseen Runtime Alias"] = player_id
        with self.assertRaisesRegex(MatchNormalizationError, "Unsafe player identity"):
            self.normalize("335982", source)

        source = json.loads((RAW_DIR / "335982.json").read_text(encoding="utf-8"))
        source["info"]["unexpected"] = True
        with self.assertRaisesRegex(MatchNormalizationError, "Invalid source shape"):
            self.normalize("335982", source)

    def test_normalization_is_deterministic_and_schema_is_strict(self) -> None:
        first = self.normalize("335982").document
        second = self.normalize("335982").document
        self.assertEqual(first, second)
        broken = copy.deepcopy(first)
        broken["innings"][0]["overs"][0]["deliveries"][0]["unexpected"] = True
        with self.assertRaises(SchemaValidationError):
            validate_instance(broken, self.schema)


@unittest.skipUnless(
    RAW_DIR.is_dir() and os.environ.get("RUN_FULL_NORMALIZATION_TESTS") == "1",
    "set RUN_FULL_NORMALIZATION_TESTS=1 for full archive build regression",
)
class FullArchiveNormalizationTests(unittest.TestCase):
    def test_two_complete_builds_are_byte_identical(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "v1"
            first = build_normalized_archive(output_dir=output)
            first_files = {
                path.relative_to(output).as_posix(): path.read_bytes()
                for path in output.rglob("*")
                if path.is_file()
            }
            second = build_normalized_archive(output_dir=output)
            second_files = {
                path.relative_to(output).as_posix(): path.read_bytes()
                for path in output.rglob("*")
                if path.is_file()
            }
            self.assertEqual(first, second)
            self.assertEqual(first_files, second_files)


if __name__ == "__main__":
    unittest.main()
