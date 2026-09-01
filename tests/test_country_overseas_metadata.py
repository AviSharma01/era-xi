from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from scripts.country_overseas_metadata import (
    CountryOverseasMetadataError,
    build_country_overseas_metadata_files,
    resolve_metadata_rows,
    validate_g2_game_input_ready,
    write_artifact_tree,
)


def read_jsonl_bytes(content: bytes) -> list[dict]:
    return [json.loads(line) for line in content.splitlines() if line]


def source(
    source_id: str = "source-one",
    supports: list[str] | None = None,
    source_type: str = "OFFICIAL_IPL",
) -> dict:
    return {
        "sourceId": source_id,
        "batchId": "synthetic-batch",
        "sourceType": source_type,
        "publisher": "Example publisher",
        "title": "Example source",
        "url": "https://example.test/source",
        "accessedDate": "2026-09-01",
        "locator": "Player list",
        "supports": supports or ["CRICKET_NATION", "IPL_ROSTER_STATUS"],
        "notes": None,
    }


def manual() -> dict:
    return {
        "schemaVersion": "ipl-country-overseas-manual/v1",
        "metadataVersion": "ipl-country-overseas-metadata/v1",
        "sources": [],
        "playerDefaults": [],
        "seasonOverrides": [],
        "reviewDispositions": [],
    }


CATALOG = {
    "schemaVersion": "ipl-cricket-nation-catalog/v1",
    "catalogVersion": "ipl-cricket-nations/v1",
    "nations": [
        {"cricketNationId": "india", "displayName": "India", "aliases": [], "notes": []},
        {
            "cricketNationId": "west-indies",
            "displayName": "West Indies",
            "aliases": [],
            "notes": [],
        },
    ],
}

PLAYERS = [
    {"playerId": "player-one", "canonicalDisplayName": "Player One"},
]

ELIGIBILITY = [
    {
        "playerTeamSeasonId": "pts:player-one:ipl-2020:team-one",
        "playerId": "player-one",
        "canonicalDisplayName": "Player One",
        "seasonId": "ipl-2020",
        "teamId": "team-one",
        "eligibilityStatus": "ELIGIBLE",
    },
    {
        "playerTeamSeasonId": "pts:player-one:ipl-2021:team-one",
        "playerId": "player-one",
        "canonicalDisplayName": "Player One",
        "seasonId": "ipl-2021",
        "teamId": "team-one",
        "eligibilityStatus": "ELIGIBLE",
    },
]


class ResolutionTests(unittest.TestCase):
    def test_missing_assertion_expands_to_explicit_unknown(self) -> None:
        players, profiles = resolve_metadata_rows(
            players=PLAYERS,
            eligibility_rows=ELIGIBILITY,
            manual=manual(),
            catalog=CATALOG,
        )
        self.assertEqual(players[0]["cricketNationId"], "UNKNOWN")
        self.assertEqual(players[0]["iplRosterStatus"], "UNKNOWN")
        self.assertEqual(players[0]["resolutionMethod"], "UNRESOLVED")
        self.assertEqual(players[0]["reviewState"], "PENDING")
        self.assertEqual(players[0]["cricketNationEvidenceRefs"], [])
        self.assertEqual(players[0]["rosterStatusEvidenceRefs"], [])
        self.assertTrue(all(row["classificationBasis"] == "PLAYER_DEFAULT" for row in profiles))

    def test_player_default_resolves_without_nation_runtime_inference(self) -> None:
        metadata = manual()
        metadata["sources"] = [source()]
        metadata["playerDefaults"] = [{
            "playerId": "player-one",
            "cricketNationId": "india",
            "iplRosterStatus": "UNKNOWN",
            "resolutionMethod": "UNRESOLVED",
            "cricketNationSourceIds": ["source-one"],
            "rosterStatusSourceIds": [],
            "reviewStatus": "APPROVED",
            "notes": None,
        }]
        players, profiles = resolve_metadata_rows(
            players=PLAYERS,
            eligibility_rows=ELIGIBILITY,
            manual=metadata,
            catalog=CATALOG,
        )
        self.assertEqual(players[0]["cricketNationId"], "india")
        self.assertEqual(players[0]["iplRosterStatus"], "UNKNOWN")
        self.assertTrue(all(row["iplRosterStatus"] == "UNKNOWN" for row in profiles))

    def test_player_default_and_complete_season_override(self) -> None:
        metadata = manual()
        metadata["sources"] = [source(), source("override-source")]
        metadata["playerDefaults"] = [{
            "playerId": "player-one",
            "cricketNationId": "india",
            "iplRosterStatus": "INDIAN",
            "resolutionMethod": "DIRECT_IPL_DESIGNATION",
            "cricketNationSourceIds": ["source-one"],
            "rosterStatusSourceIds": ["source-one"],
            "reviewStatus": "APPROVED",
            "notes": None,
        }]
        metadata["seasonOverrides"] = [{
            "playerId": "player-one",
            "seasonId": "ipl-2021",
            "cricketNationId": "west-indies",
            "iplRosterStatus": "OVERSEAS",
            "resolutionMethod": "MANUAL_REVIEW",
            "cricketNationSourceIds": ["override-source"],
            "rosterStatusSourceIds": ["override-source"],
            "reviewStatus": "APPROVED",
            "notes": "Synthetic temporal exception.",
        }]
        _, profiles = resolve_metadata_rows(
            players=PLAYERS,
            eligibility_rows=ELIGIBILITY,
            manual=metadata,
            catalog=CATALOG,
        )
        by_season = {row["seasonId"]: row for row in profiles}
        self.assertEqual(by_season["ipl-2020"]["classificationBasis"], "PLAYER_DEFAULT")
        self.assertEqual(by_season["ipl-2020"]["resolutionMethod"], "DIRECT_IPL_DESIGNATION")
        self.assertEqual(by_season["ipl-2021"]["classificationBasis"], "SEASON_OVERRIDE")
        self.assertEqual(by_season["ipl-2021"]["resolutionMethod"], "MANUAL_REVIEW")
        self.assertEqual(by_season["ipl-2021"]["iplRosterStatus"], "OVERSEAS")

    def test_roster_can_be_approved_while_nation_is_explicitly_unresolved(self) -> None:
        metadata = manual()
        metadata["sources"] = [source(supports=["IPL_ROSTER_STATUS"])]
        metadata["playerDefaults"] = [{
            "playerId": "player-one",
            "cricketNationId": "UNKNOWN",
            "iplRosterStatus": "OVERSEAS",
            "resolutionMethod": "DIRECT_IPL_DESIGNATION",
            "cricketNationSourceIds": [],
            "rosterStatusSourceIds": ["source-one"],
            "reviewStatus": "APPROVED",
            "notes": None,
        }]
        metadata["reviewDispositions"] = [{
            "dispositionId": "nation-unknown-player-one",
            "scope": "PLAYER_DEFAULT",
            "playerId": "player-one",
            "seasonId": None,
            "status": "NATION_CLOSED_UNKNOWN",
            "sourceIdsReviewed": ["source-one"],
            "reviewStatus": "APPROVED",
            "notes": "Roster status is direct; nation remains unresolved.",
        }]
        players, profiles = resolve_metadata_rows(
            players=PLAYERS,
            eligibility_rows=ELIGIBILITY,
            manual=metadata,
            catalog=CATALOG,
        )
        self.assertEqual(players[0]["reviewState"], "ROSTER_APPROVED_NATION_UNRESOLVED")
        self.assertTrue(all(row["iplRosterStatus"] == "OVERSEAS" for row in profiles))

    def test_duplicate_or_conflicting_defaults_are_rejected(self) -> None:
        metadata = manual()
        first = {
            "playerId": "player-one",
            "cricketNationId": "UNKNOWN",
            "iplRosterStatus": "UNKNOWN",
            "resolutionMethod": "UNRESOLVED",
            "cricketNationSourceIds": [],
            "rosterStatusSourceIds": [],
            "reviewStatus": "APPROVED",
            "notes": None,
        }
        second = {**first, "iplRosterStatus": "INDIAN"}
        metadata["playerDefaults"] = [first, second]
        with self.assertRaisesRegex(CountryOverseasMetadataError, "Duplicate player defaults"):
            resolve_metadata_rows(
                players=PLAYERS,
                eligibility_rows=ELIGIBILITY,
                manual=metadata,
                catalog=CATALOG,
            )

    def test_invalid_source_and_catalog_references_are_rejected(self) -> None:
        for field, value, message in (
            ("cricketNationId", "unknown-catalog-id", "unknown cricket nation"),
            ("cricketNationSourceIds", ["missing-source"], "unknown sources"),
        ):
            metadata = manual()
            assertion = {
                "playerId": "player-one",
                "cricketNationId": "india",
                "iplRosterStatus": "UNKNOWN",
                "resolutionMethod": "UNRESOLVED",
                "cricketNationSourceIds": [],
                "rosterStatusSourceIds": [],
                "reviewStatus": "APPROVED",
                "notes": None,
            }
            assertion[field] = value
            metadata["playerDefaults"] = [assertion]
            with self.assertRaisesRegex(CountryOverseasMetadataError, message):
                resolve_metadata_rows(
                    players=PLAYERS,
                    eligibility_rows=ELIGIBILITY,
                    manual=metadata,
                    catalog=CATALOG,
                )

    def test_resolution_method_requires_matching_evidence_type(self) -> None:
        metadata = manual()
        metadata["sources"] = [source(source_type="SECONDARY_CRICKET_DATABASE")]
        metadata["playerDefaults"] = [{
            "playerId": "player-one",
            "cricketNationId": "india",
            "iplRosterStatus": "INDIAN",
            "resolutionMethod": "DIRECT_IPL_DESIGNATION",
            "cricketNationSourceIds": ["source-one"],
            "rosterStatusSourceIds": ["source-one"],
            "reviewStatus": "APPROVED",
            "notes": None,
        }]
        with self.assertRaisesRegex(CountryOverseasMetadataError, "without an OFFICIAL_IPL source"):
            resolve_metadata_rows(
                players=PLAYERS,
                eligibility_rows=ELIGIBILITY,
                manual=metadata,
                catalog=CATALOG,
            )

    def test_fail_closed_game_input_contract(self) -> None:
        _, profiles = resolve_metadata_rows(
            players=PLAYERS,
            eligibility_rows=ELIGIBILITY,
            manual=manual(),
            catalog=CATALOG,
        )
        with self.assertRaisesRegex(CountryOverseasMetadataError, "UNKNOWN roster status"):
            validate_g2_game_input_ready(ELIGIBILITY, profiles)
        with self.assertRaisesRegex(CountryOverseasMetadataError, "missing profiles"):
            validate_g2_game_input_ready(ELIGIBILITY, profiles[:1])
        with self.assertRaisesRegex(CountryOverseasMetadataError, "duplicate profiles"):
            validate_g2_game_input_ready(ELIGIBILITY, profiles + [profiles[0]])
        resolved = [{**row, "iplRosterStatus": "INDIAN", "reviewState": "APPROVED"} for row in profiles]
        validate_g2_game_input_ready(ELIGIBILITY, resolved)


class RepositoryIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.files, cls.report = build_country_overseas_metadata_files()
        cls.players = read_jsonl_bytes(cls.files["player_metadata.jsonl"])
        cls.profiles = read_jsonl_bytes(cls.files["player_team_season_metadata.jsonl"])
        cls.g2_queue = json.loads(cls.files["g2_review_queue.json"])
        cls.backlog = json.loads(cls.files["non_g2_backlog.json"])
        cls.legacy = json.loads(cls.files["legacy_migration_report.json"])
        cls.manifest = json.loads(cls.files["metadata_manifest.json"])

    def test_exact_population_and_unknown_foundation(self) -> None:
        self.assertEqual(len(self.players), 816)
        self.assertEqual(len(self.profiles), 3392)
        self.assertEqual(len({row["playerId"] for row in self.players}), 816)
        self.assertEqual(len({row["playerTeamSeasonId"] for row in self.profiles}), 3392)
        self.assertTrue(all(row["cricketNationId"] == "UNKNOWN" for row in self.players))
        self.assertTrue(all(row["iplRosterStatus"] == "UNKNOWN" for row in self.players))
        self.assertTrue(all(row["iplRosterStatus"] == "UNKNOWN" for row in self.profiles))
        self.assertTrue(all(row["classificationBasis"] == "PLAYER_DEFAULT" for row in self.profiles))
        self.assertTrue(all(row["resolutionMethod"] == "UNRESOLVED" for row in self.profiles))

    def test_g2_identity_and_queue_separation(self) -> None:
        eligibility = [
            json.loads(line)
            for line in Path("data/processed/era-draft/v1/eligibility.jsonl").read_text().splitlines()
            if line
        ]
        eligible = [row for row in eligibility if row["eligibilityStatus"] == "ELIGIBLE"]
        eligible_ids = {row["playerTeamSeasonId"] for row in eligible}
        eligible_players = {row["playerId"] for row in eligible}
        self.assertEqual(len(eligible_ids), 2992)
        self.assertEqual(len(eligible_players), 727)
        self.assertEqual(self.g2_queue["summary"]["players"], 727)
        self.assertEqual(self.g2_queue["summary"]["playerTeamSeasons"], 2992)
        self.assertEqual(self.backlog["summary"]["players"], 89)
        self.assertEqual(
            {pts_id for item in self.g2_queue["items"] for pts_id in item["playerTeamSeasonIds"]},
            eligible_ids,
        )
        self.assertEqual(
            {item["playerId"] for item in self.g2_queue["items"]}, eligible_players
        )
        self.assertFalse(
            {item["playerId"] for item in self.g2_queue["items"]}
            & {item["playerId"] for item in self.backlog["items"]}
        )
        self.assertEqual(self.report["g2EligibleIdSetSha256"], self.manifest["g2EligibleIdSetSha256"])

    def test_legacy_rows_are_identity_mapped_unverified_leads(self) -> None:
        self.assertEqual(self.legacy["summary"], {
            "rows": 147,
            "identityMatched": 147,
            "unverified": 147,
            "partiallyVerified": 0,
            "supported": 0,
            "conflicting": 0,
            "unmatched": 0,
        })
        self.assertTrue(all(row["identityStatus"] == "MATCHED" for row in self.legacy["rows"]))
        self.assertTrue(all(row["comparisonStatus"] == "UNVERIFIED" for row in self.legacy["rows"]))

    def test_manifest_entries_match_generated_bytes(self) -> None:
        entries = self.manifest["artifacts"] + self.manifest["schemaFiles"]
        for entry in entries:
            content = self.files[entry["path"]]
            self.assertEqual(hashlib.sha256(content).hexdigest(), entry["sha256"])
            self.assertEqual(len(content), entry["sizeBytes"])
        payload = dict(self.manifest)
        recorded = payload.pop("metadataManifestHash")
        from scripts.cricsheet_audit.reporting import canonical_json_bytes

        self.assertEqual(hashlib.sha256(canonical_json_bytes(payload)).hexdigest(), recorded)

    def test_two_builds_and_committed_tree_are_byte_identical(self) -> None:
        second_files, second_report = build_country_overseas_metadata_files()
        self.assertEqual(self.files, second_files)
        self.assertEqual(self.report, second_report)
        output = Path("data/metadata/ipl/country_overseas/v1")
        committed = {
            str(path.relative_to(output)): path.read_bytes()
            for path in output.rglob("*")
            if path.is_file()
        }
        self.assertEqual(self.files, committed)
        with tempfile.TemporaryDirectory() as directory:
            write_artifact_tree(Path(directory), self.files)
            written = {
                str(path.relative_to(directory)): path.read_bytes()
                for path in Path(directory).rglob("*")
                if path.is_file()
            }
            self.assertEqual(self.files, written)

    def test_protected_eligibility_keeper_and_classic_hashes(self) -> None:
        expected = {
            "data/processed/era-draft/v1/eligibility_manifest.json": "6b8cde98ed6c99d99120b558650ce6fbe9523c6f839d84e61d1fabddeeddd50b",
            "data/metadata/ipl/v1/metadata_manifest.json": "f420a3d60bcc154a6a02a33a3d1c887f8dba3ff693fe11c698a3ddc03a2d28f0",
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
