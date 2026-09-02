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
        "publicationDate": "2020-01-01",
        "accessedDate": "2026-09-01",
        "contentSha256": "0" * 64,
        "locator": "Player list",
        "supports": supports or ["CRICKET_NATION", "IPL_ROSTER_STATUS"],
        "notes": None,
    }


def manual() -> dict:
    return {
        "schemaVersion": "ipl-country-overseas-manual/v3",
        "metadataVersion": "ipl-country-overseas-metadata/v1",
        "sources": [],
        "playerDefaults": [],
        "seasonOverrides": [],
        "reviewDispositions": [],
    }


def evidence(
    source_id: str = "source-one",
    season_ids: list[str] | None = None,
    *,
    scope_type: str | None = None,
    page: int | None = 1,
    row: str | None = "Player One",
) -> dict:
    seasons = season_ids or ["ipl-2020", "ipl-2021"]
    if scope_type is None:
        scope_type = "SEASON" if len(seasons) == 1 else "MULTI_SEASON"
    temporal_scope = (
        {"type": "PLAYER_DEFAULT", "screenedSeasonIds": seasons}
        if scope_type == "PLAYER_DEFAULT"
        else {"type": scope_type, "seasonIds": seasons}
    )
    return {
        "sourceId": source_id,
        "locator": {
            "page": page,
            "section": "Synthetic squad",
            "table": "Players",
            "row": row,
            "observedValue": "*",
            "text": "* = Overseas player",
        },
        "temporalScope": temporal_scope,
    }


def promotion(season_ids: list[str] | None = None) -> dict:
    seasons = season_ids or ["ipl-2020", "ipl-2021"]
    return {
        "screeningStatus": "FULL_COMMITTED_SPAN_SCREENED",
        "screenedSeasonIds": seasons,
        "contradictoryEvidenceFound": False,
        "unresolvedTemporalChange": False,
        "rationale": "All committed synthetic seasons were screened.",
    }


def player_default(
    *,
    nation: str,
    roster_status: str,
    resolution_method: str | None = None,
    nation_resolution_method: str | None = None,
    roster_resolution_method: str | None = None,
    nation_refs: list[dict] | None = None,
    roster_refs: list[dict] | None = None,
    season_ids: list[str] | None = None,
) -> dict:
    seasons = season_ids or ["ipl-2020", "ipl-2021"]
    common_method = resolution_method or "UNRESOLVED"
    return {
        "playerId": "player-one",
        "cricketNationId": nation,
        "iplRosterStatus": roster_status,
        "nationResolutionMethod": nation_resolution_method or common_method,
        "rosterStatusResolutionMethod": roster_resolution_method or common_method,
        "cricketNationEvidenceRefs": nation_refs or [],
        "rosterStatusEvidenceRefs": roster_refs or [],
        "reviewStatus": "APPROVED",
        "notes": None,
        "temporalScope": {
            "type": "PLAYER_DEFAULT",
            "screenedSeasonIds": seasons,
        },
        "defaultPromotion": promotion(seasons),
    }


def season_override(
    *,
    season_id: str,
    nation: str,
    roster_status: str,
    resolution_method: str | None = None,
    nation_resolution_method: str | None = None,
    roster_resolution_method: str | None = None,
    nation_refs: list[dict] | None = None,
    roster_refs: list[dict] | None = None,
) -> dict:
    common_method = resolution_method or "UNRESOLVED"
    return {
        "playerId": "player-one",
        "seasonId": season_id,
        "cricketNationId": nation,
        "iplRosterStatus": roster_status,
        "nationResolutionMethod": nation_resolution_method or common_method,
        "rosterStatusResolutionMethod": roster_resolution_method or common_method,
        "cricketNationEvidenceRefs": nation_refs or [],
        "rosterStatusEvidenceRefs": roster_refs or [],
        "reviewStatus": "APPROVED",
        "notes": None,
        "temporalScope": {"type": "SEASON", "seasonIds": [season_id]},
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
        self.assertEqual(players[0]["nationResolutionMethod"], "UNRESOLVED")
        self.assertEqual(players[0]["rosterStatusResolutionMethod"], "UNRESOLVED")
        self.assertEqual(players[0]["reviewState"], "PENDING")
        self.assertEqual(players[0]["cricketNationEvidenceRefs"], [])
        self.assertEqual(players[0]["rosterStatusEvidenceRefs"], [])
        self.assertTrue(all(row["classificationBasis"] == "PLAYER_DEFAULT" for row in profiles))

    def test_player_default_resolves_without_nation_runtime_inference(self) -> None:
        metadata = manual()
        metadata["sources"] = [source()]
        metadata["playerDefaults"] = [player_default(
            nation="india",
            roster_status="UNKNOWN",
            nation_resolution_method="DIRECT_IPL_DESIGNATION",
            roster_resolution_method="UNRESOLVED",
            nation_refs=[evidence()],
        )]
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
        metadata["playerDefaults"] = [player_default(
            nation="india",
            roster_status="INDIAN",
            resolution_method="DIRECT_IPL_DESIGNATION",
            nation_refs=[evidence()],
            roster_refs=[evidence()],
        )]
        override_ref = evidence("override-source", ["ipl-2021"])
        metadata["seasonOverrides"] = [season_override(
            season_id="ipl-2021",
            nation="west-indies",
            roster_status="OVERSEAS",
            resolution_method="MANUAL_REVIEW",
            nation_refs=[override_ref],
            roster_refs=[override_ref],
        )]
        _, profiles = resolve_metadata_rows(
            players=PLAYERS,
            eligibility_rows=ELIGIBILITY,
            manual=metadata,
            catalog=CATALOG,
        )
        by_season = {row["seasonId"]: row for row in profiles}
        self.assertEqual(by_season["ipl-2020"]["classificationBasis"], "PLAYER_DEFAULT")
        self.assertEqual(
            by_season["ipl-2020"]["nationResolutionMethod"],
            "DIRECT_IPL_DESIGNATION",
        )
        self.assertEqual(
            by_season["ipl-2020"]["rosterStatusResolutionMethod"],
            "DIRECT_IPL_DESIGNATION",
        )
        self.assertEqual(by_season["ipl-2021"]["classificationBasis"], "SEASON_OVERRIDE")
        self.assertEqual(by_season["ipl-2021"]["nationResolutionMethod"], "MANUAL_REVIEW")
        self.assertEqual(
            by_season["ipl-2021"]["rosterStatusResolutionMethod"], "MANUAL_REVIEW"
        )
        self.assertEqual(by_season["ipl-2021"]["iplRosterStatus"], "OVERSEAS")

    def test_roster_can_be_approved_while_nation_is_explicitly_unresolved(self) -> None:
        metadata = manual()
        metadata["sources"] = [source(supports=["IPL_ROSTER_STATUS"])]
        metadata["playerDefaults"] = [player_default(
            nation="UNKNOWN",
            roster_status="OVERSEAS",
            nation_resolution_method="UNRESOLVED",
            roster_resolution_method="DIRECT_IPL_DESIGNATION",
            roster_refs=[evidence()],
        )]
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
        self.assertEqual(players[0]["nationResolutionMethod"], "UNRESOLVED")
        self.assertEqual(
            players[0]["rosterStatusResolutionMethod"], "DIRECT_IPL_DESIGNATION"
        )
        self.assertTrue(all(row["iplRosterStatus"] == "OVERSEAS" for row in profiles))

    def test_direct_nation_and_policy_derived_roster_are_independent(self) -> None:
        metadata = manual()
        metadata["sources"] = [
            source("auction-register"),
            source(
                "closed-country-policy",
                supports=["IPL_ROSTER_STATUS"],
                source_type="INTERNAL_POLICY",
            ),
        ]
        official_ref = evidence("auction-register")
        policy_ref = evidence("closed-country-policy")
        metadata["playerDefaults"] = [player_default(
            nation="west-indies",
            roster_status="OVERSEAS",
            nation_resolution_method="DIRECT_IPL_DESIGNATION",
            roster_resolution_method="POLICY_DERIVED",
            nation_refs=[official_ref],
            roster_refs=[official_ref, policy_ref],
        )]
        players, profiles = resolve_metadata_rows(
            players=PLAYERS,
            eligibility_rows=ELIGIBILITY,
            manual=metadata,
            catalog=CATALOG,
        )
        self.assertEqual(players[0]["nationResolutionMethod"], "DIRECT_IPL_DESIGNATION")
        self.assertEqual(players[0]["rosterStatusResolutionMethod"], "POLICY_DERIVED")
        self.assertTrue(all(
            row["nationResolutionMethod"] == "DIRECT_IPL_DESIGNATION"
            and row["rosterStatusResolutionMethod"] == "POLICY_DERIVED"
            for row in profiles
        ))

    def test_duplicate_or_conflicting_defaults_are_rejected(self) -> None:
        metadata = manual()
        first = player_default(
            nation="UNKNOWN", roster_status="UNKNOWN", resolution_method="UNRESOLVED"
        )
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
            (
                "cricketNationEvidenceRefs",
                [evidence("missing-source")],
                "unknown source",
            ),
        ):
            metadata = manual()
            assertion = player_default(
                nation="india",
                roster_status="UNKNOWN",
                nation_resolution_method="DIRECT_IPL_DESIGNATION",
                roster_resolution_method="UNRESOLVED",
                nation_refs=[evidence()],
            )
            assertion[field] = value
            metadata["playerDefaults"] = [assertion]
            with self.assertRaisesRegex(CountryOverseasMetadataError, message):
                resolve_metadata_rows(
                    players=PLAYERS,
                    eligibility_rows=ELIGIBILITY,
                    manual=metadata,
                    catalog=CATALOG,
                )

    def test_each_field_method_requires_matching_evidence_type(self) -> None:
        cases = []

        invalid_nation = manual()
        invalid_nation["sources"] = [
            source(source_type="SECONDARY_CRICKET_DATABASE", supports=["CRICKET_NATION"])
        ]
        invalid_nation["playerDefaults"] = [player_default(
            nation="india",
            roster_status="UNKNOWN",
            nation_resolution_method="DIRECT_IPL_DESIGNATION",
            roster_resolution_method="UNRESOLVED",
            nation_refs=[evidence()],
        )]
        cases.append((invalid_nation, "DIRECT_IPL_DESIGNATION for cricket nation"))

        invalid_roster = manual()
        invalid_roster["sources"] = [source(supports=["IPL_ROSTER_STATUS"])]
        invalid_roster["playerDefaults"] = [player_default(
            nation="UNKNOWN",
            roster_status="INDIAN",
            nation_resolution_method="UNRESOLVED",
            roster_resolution_method="POLICY_DERIVED",
            roster_refs=[evidence()],
        )]
        cases.append((invalid_roster, "POLICY_DERIVED for roster status"))

        for metadata, message in cases:
            with self.subTest(message=message), self.assertRaisesRegex(
                CountryOverseasMetadataError, message
            ):
                resolve_metadata_rows(
                    players=PLAYERS,
                    eligibility_rows=ELIGIBILITY,
                    manual=metadata,
                    catalog=CATALOG,
                )

    def test_evidence_locator_is_required_and_nonempty(self) -> None:
        for mutation, message in (
            (lambda ref: ref.pop("locator"), "missing required fields"),
            (
                lambda ref: ref.update({
                    "locator": {
                        "page": None,
                        "section": None,
                        "table": None,
                        "row": None,
                        "observedValue": None,
                        "text": None,
                    }
                }),
                "empty locator",
            ),
            (lambda ref: ref["locator"].update({"page": 0}), "below minimum"),
        ):
            metadata = manual()
            metadata["sources"] = [source()]
            ref = evidence()
            mutation(ref)
            metadata["playerDefaults"] = [player_default(
                nation="india",
                roster_status="UNKNOWN",
                nation_resolution_method="DIRECT_IPL_DESIGNATION",
                roster_resolution_method="UNRESOLVED",
                nation_refs=[ref],
            )]
            with self.subTest(message=message), self.assertRaisesRegex(
                CountryOverseasMetadataError, message
            ):
                resolve_metadata_rows(
                    players=PLAYERS,
                    eligibility_rows=ELIGIBILITY,
                    manual=metadata,
                    catalog=CATALOG,
                )

    def test_season_scoped_evidence_resolves_only_intended_season(self) -> None:
        metadata = manual()
        metadata["sources"] = [source()]
        ref = evidence(season_ids=["ipl-2021"])
        metadata["seasonOverrides"] = [season_override(
            season_id="ipl-2021",
            nation="india",
            roster_status="INDIAN",
            resolution_method="DIRECT_IPL_DESIGNATION",
            nation_refs=[ref],
            roster_refs=[ref],
        )]
        players, profiles = resolve_metadata_rows(
            players=PLAYERS,
            eligibility_rows=ELIGIBILITY,
            manual=metadata,
            catalog=CATALOG,
        )
        self.assertEqual(players[0]["iplRosterStatus"], "UNKNOWN")
        by_season = {row["seasonId"]: row for row in profiles}
        self.assertEqual(by_season["ipl-2020"]["iplRosterStatus"], "UNKNOWN")
        self.assertEqual(by_season["ipl-2021"]["iplRosterStatus"], "INDIAN")
        self.assertEqual(by_season["ipl-2021"]["classificationBasis"], "SEASON_OVERRIDE")

    def test_player_default_requires_full_span_promotion_screening(self) -> None:
        metadata = manual()
        metadata["sources"] = [source()]
        assertion = player_default(
            nation="india",
            roster_status="INDIAN",
            resolution_method="DIRECT_IPL_DESIGNATION",
            nation_refs=[evidence()],
            roster_refs=[evidence()],
        )
        assertion["defaultPromotion"]["screenedSeasonIds"] = ["ipl-2021"]
        metadata["playerDefaults"] = [assertion]
        with self.assertRaisesRegex(CountryOverseasMetadataError, "full committed season span"):
            resolve_metadata_rows(
                players=PLAYERS,
                eligibility_rows=ELIGIBILITY,
                manual=metadata,
                catalog=CATALOG,
            )

    def test_single_season_evidence_cannot_be_promoted_to_player_default(self) -> None:
        metadata = manual()
        metadata["sources"] = [source()]
        one_season_ref = evidence(season_ids=["ipl-2021"])
        metadata["playerDefaults"] = [player_default(
            nation="india",
            roster_status="INDIAN",
            resolution_method="DIRECT_IPL_DESIGNATION",
            nation_refs=[one_season_ref],
            roster_refs=[one_season_ref],
        )]
        with self.assertRaisesRegex(CountryOverseasMetadataError, "full committed span"):
            resolve_metadata_rows(
                players=PLAYERS,
                eligibility_rows=ELIGIBILITY,
                manual=metadata,
                catalog=CATALOG,
            )

    def test_source_reuse_and_evidence_ordering_are_deterministic(self) -> None:
        metadata = manual()
        metadata["sources"] = [source()]
        ref_2020 = evidence(season_ids=["ipl-2020"], row="2020 row")
        ref_2021 = evidence(season_ids=["ipl-2021"], row="2021 row")
        metadata["seasonOverrides"] = [
            season_override(
                season_id="ipl-2021",
                nation="india",
                roster_status="INDIAN",
                resolution_method="DIRECT_IPL_DESIGNATION",
                nation_refs=[ref_2021],
                roster_refs=[ref_2021],
            ),
            season_override(
                season_id="ipl-2020",
                nation="india",
                roster_status="INDIAN",
                resolution_method="DIRECT_IPL_DESIGNATION",
                nation_refs=[ref_2020],
                roster_refs=[ref_2020],
            ),
        ]
        first = resolve_metadata_rows(
            players=PLAYERS,
            eligibility_rows=ELIGIBILITY,
            manual=metadata,
            catalog=CATALOG,
        )
        second = resolve_metadata_rows(
            players=PLAYERS,
            eligibility_rows=ELIGIBILITY,
            manual=metadata,
            catalog=CATALOG,
        )
        self.assertEqual(first, second)
        self.assertTrue(all(
            row["rosterStatusEvidenceRefs"][0]["sourceId"] == "source-one"
            for row in first[1]
        ))

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

    def test_exact_population_and_complete_2025_g2_coverage(self) -> None:
        self.assertEqual(len(self.players), 816)
        self.assertEqual(len(self.profiles), 3392)
        self.assertEqual(len({row["playerId"] for row in self.players}), 816)
        self.assertEqual(len({row["playerTeamSeasonId"] for row in self.profiles}), 3392)
        # Population intentionally uses season overrides only; no player default is implied.
        self.assertTrue(all(row["cricketNationId"] == "UNKNOWN" for row in self.players))
        self.assertTrue(all(row["iplRosterStatus"] == "UNKNOWN" for row in self.players))
        resolved = [row for row in self.profiles if row["iplRosterStatus"] != "UNKNOWN"]
        self.assertEqual(len(resolved), 205)
        self.assertTrue(all(row["classificationBasis"] == "SEASON_OVERRIDE" for row in resolved))
        self.assertEqual(sum(row["cricketNationId"] != "UNKNOWN" for row in resolved), 169)
        self.assertEqual(
            sum(row["rosterStatusResolutionMethod"] == "DIRECT_IPL_DESIGNATION" for row in resolved),
            12,
        )
        self.assertEqual(
            sum(row["rosterStatusResolutionMethod"] == "POLICY_DERIVED" for row in resolved),
            193,
        )
        self.assertEqual(
            sum(row["reviewState"] == "ROSTER_APPROVED_NATION_UNRESOLVED" for row in resolved),
            36,
        )

        full_spans = {
            "b1ad996b": {"ipl-2024", "ipl-2025", "ipl-2026"},
            "85b3fab2": {"ipl-2023", "ipl-2024", "ipl-2025", "ipl-2026"},
            "ad3b6e95": {"ipl-2023", "ipl-2024", "ipl-2025", "ipl-2026"},
            "bcf325d2": {"ipl-2023", "ipl-2024", "ipl-2025", "ipl-2026"},
            "aad0c365": {"ipl-2023", "ipl-2024", "ipl-2025", "ipl-2026"},
            "3d284ca3": {"ipl-2023", "ipl-2024", "ipl-2025", "ipl-2026"},
            "64839cb3": {"ipl-2022", "ipl-2023", "ipl-2024", "ipl-2025"},
            "77b1aa15": {"ipl-2022", "ipl-2023", "ipl-2024", "ipl-2025"},
            "7210d461": {"ipl-2022", "ipl-2023", "ipl-2024", "ipl-2025"},
            "be24ead0": {"ipl-2022", "ipl-2024", "ipl-2025", "ipl-2026"},
        }
        eligible_2025_ids = {
            row["playerTeamSeasonId"]
            for row in (
                json.loads(line)
                for line in Path("data/processed/era-draft/v1/eligibility.jsonl").read_text().splitlines()
                if line
            )
            if row["eligibilityStatus"] == "ELIGIBLE" and row["seasonId"] == "ipl-2025"
        }
        actual_ids = {row["playerTeamSeasonId"] for row in resolved}
        expected_ids = {
            row["playerTeamSeasonId"]
            for row in self.profiles
            if row["playerTeamSeasonId"] in eligible_2025_ids
            or row["seasonId"] in full_spans.get(row["playerId"], set())
        }
        self.assertEqual(actual_ids, expected_ids)
        resolved_2025 = [row for row in resolved if row["seasonId"] == "ipl-2025"]
        self.assertEqual(len(resolved_2025), 176)
        self.assertNotIn("UNKNOWN", {row["iplRosterStatus"] for row in resolved_2025})

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
        self.assertEqual(self.g2_queue["summary"]["players"], 710)
        self.assertEqual(self.g2_queue["summary"]["playerTeamSeasons"], 2787)
        self.assertEqual(self.backlog["summary"]["players"], 89)
        self.assertEqual(
            {pts_id for item in self.g2_queue["items"] for pts_id in item["playerTeamSeasonIds"]},
            {
                pts_id for pts_id in eligible_ids
                if next(
                    row for row in self.profiles
                    if row["playerTeamSeasonId"] == pts_id
                )["iplRosterStatus"] == "UNKNOWN"
            },
        )
        closed_players = {
            "b1ad996b", "85b3fab2", "ad3b6e95", "bcf325d2", "aad0c365",
            "3d284ca3", "64839cb3", "77b1aa15", "7210d461", "be24ead0",
            "08548b13", "1e030637", "36619795", "bafd0398", "c27b5a0e",
            "cb9b8664", "cbf58a86",
        }
        self.assertEqual(
            {item["playerId"] for item in self.g2_queue["items"]},
            eligible_players - closed_players,
        )
        self.assertFalse(
            {item["playerId"] for item in self.g2_queue["items"]}
            & {item["playerId"] for item in self.backlog["items"]}
        )
        self.assertEqual(self.report["g2EligibleIdSetSha256"], self.manifest["g2EligibleIdSetSha256"])

    def test_legacy_rows_and_pilot_comparison(self) -> None:
        self.assertEqual(self.legacy["summary"], {
            "rows": 147,
            "identityMatched": 147,
            "unverified": 104,
            "partiallyVerified": 14,
            "supported": 29,
            "conflicting": 0,
            "unmatched": 0,
        })
        self.assertTrue(all(row["identityStatus"] == "MATCHED" for row in self.legacy["rows"]))
        self.assertEqual(self.legacy["pilotComparisonSummary"], {
            "players": 176,
            "agrees": 29,
            "disagrees": 0,
            "legacyAmbiguous": 14,
            "notLegacyCovered": 133,
        })
        self.assertEqual(len(self.legacy["pilotComparisons"]), 176)

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
