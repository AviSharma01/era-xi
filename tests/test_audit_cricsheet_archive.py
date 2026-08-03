from __future__ import annotations

import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from scripts.cricsheet_audit.legacy_collision import build_legacy_collision_diagnostics
from scripts.cricsheet_audit.reporting import build_reports, calculate_manifest_hash
from scripts.cricsheet_audit.scanner import (
    AuditError,
    discover_source_files,
    infer_edition_display_year,
    scan_archive,
)


def empty_innings(team: str = "Team A", *, super_over: bool = False) -> dict:
    innings = {"team": team, "overs": []}
    if super_over:
        innings["super_over"] = True
    return innings


def delivery(
    batter: str = "A1",
    non_striker: str = "A2",
    bowler: str = "B1",
    **extra_fields: object,
) -> dict:
    return {
        "batter": batter,
        "non_striker": non_striker,
        "bowler": bowler,
        "runs": {"batter": 0, "extras": 0, "total": 0},
        **extra_fields,
    }


def make_match(
    *,
    season: str = "2024",
    dates: list[str] | None = None,
    players: dict[str, list[str]] | None = None,
    registry: dict[str, str] | None = None,
    innings: list[dict] | None = None,
    outcome: dict | None = None,
    city: str | None = "Test City",
    player_of_match: list[str] | None = None,
    data_version: str = "1.2.0",
) -> dict:
    players = players or {"Team A": ["A1", "A2"], "Team B": ["B1", "B2"]}
    all_names = {name for names in players.values() for name in names}
    registry = registry or {name: f"id-{name.lower()}" for name in all_names}
    info = {
        "dates": dates or ["2024-04-01"],
        "event": {"name": "Indian Premier League", "match_number": 1},
        "outcome": outcome or {"winner": "Team A", "by": {"runs": 1}},
        "players": players,
        "registry": {"people": registry},
        "season": season,
        "teams": list(players),
        "venue": "Test Ground",
        "officials": {},
    }
    if city is not None:
        info["city"] = city
    if player_of_match is not None:
        info["player_of_match"] = player_of_match
    return {
        "meta": {"data_version": data_version, "created": "2024-04-02", "revision": 1},
        "info": info,
        "innings": innings if innings is not None else [empty_innings(), empty_innings("Team B")],
    }


def write_match(root: Path, file_name: str, data: dict) -> Path:
    path = root / file_name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, sort_keys=True), encoding="utf-8")
    return path


class SourceDiscoveryTests(unittest.TestCase):
    def test_ignores_non_json_and_sorts_numeric_ids(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_dir:
            root = Path(temporary_dir)
            (root / "README.txt").write_text("ignored", encoding="utf-8")
            write_match(root, "10.json", make_match())
            write_match(root, "2.json", make_match())
            discovered = discover_source_files(root)
            self.assertEqual([item[0] for item in discovered], [2, 10])
            self.assertEqual([item[2] for item in discovered], ["2.json", "10.json"])

    def test_rejects_non_numeric_json_stem(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_dir:
            root = Path(temporary_dir)
            write_match(root, "metadata.json", make_match())
            with self.assertRaisesRegex(AuditError, "numeric stem"):
                discover_source_files(root)

    def test_rejects_duplicate_parsed_numeric_ids(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_dir:
            root = Path(temporary_dir)
            write_match(root, "1.json", make_match())
            write_match(root, "nested/01.json", make_match())
            with self.assertRaisesRegex(AuditError, "Duplicate numeric match ID 1"):
                discover_source_files(root)


class ScannerValidationTests(unittest.TestCase):
    def test_supported_schema_and_optional_metadata_observations(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_dir:
            root = Path(temporary_dir)
            write_match(root, "1.json", make_match(city=None, player_of_match=None))
            scan = scan_archive(root)
            self.assertEqual(scan.schema["observedDataVersions"], {"1.2.0": 1})
            self.assertEqual(scan.anomalies["missingCity"]["count"], 1)
            self.assertEqual(scan.anomalies["missingPlayerOfMatch"]["count"], 1)

    def test_rejects_unsupported_or_missing_schema_version(self) -> None:
        for version in ("1.1.0", None):
            with self.subTest(version=version), tempfile.TemporaryDirectory() as temporary_dir:
                root = Path(temporary_dir)
                data = make_match(data_version="1.1.0")
                if version is None:
                    del data["meta"]["data_version"]
                write_match(root, "1.json", data)
                with self.assertRaises(AuditError):
                    scan_archive(root)

    def test_rejects_malformed_json(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_dir:
            root = Path(temporary_dir)
            (root / "1.json").write_text("{", encoding="utf-8")
            with self.assertRaisesRegex(AuditError, "Malformed JSON"):
                scan_archive(root)

    def test_rejects_unresolved_official_participant(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_dir:
            root = Path(temporary_dir)
            data = make_match()
            del data["info"]["registry"]["people"]["A1"]
            write_match(root, "1.json", data)
            with self.assertRaisesRegex(AuditError, "Unresolved registry references"):
                scan_archive(root)

    def test_delivery_participant_absent_from_official_list_is_observed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_dir:
            root = Path(temporary_dir)
            data = make_match(
                innings=[
                    {
                        "team": "Team A",
                        "overs": [{"over": 0, "deliveries": [delivery(bowler="Sub Bowler")]}],
                    }
                ]
            )
            data["info"]["registry"]["people"]["Sub Bowler"] = "id-sub-bowler"
            write_match(root, "1.json", data)
            scan = scan_archive(root)
            absent = scan.identity["deliveryParticipantsAbsentFromOfficialLists"]
            self.assertEqual(len(absent), 1)
            self.assertEqual(absent[0]["displayName"], "Sub Bowler")


class ManifestDeterminismTests(unittest.TestCase):
    def test_file_and_manifest_hashes_and_rendered_reports_are_deterministic(self) -> None:
        with tempfile.TemporaryDirectory() as first_dir, tempfile.TemporaryDirectory() as second_dir:
            first = Path(first_dir)
            second = Path(second_dir)
            data = make_match(player_of_match=["A1"])
            first_path = write_match(first, "7.json", data)
            write_match(second, "7.json", data)

            first_scan = scan_archive(first)
            second_scan = scan_archive(second)
            expected_file_hash = hashlib.sha256(first_path.read_bytes()).hexdigest()
            self.assertEqual(first_scan.manifest_entries[0]["fileSha256"], expected_file_hash)
            self.assertEqual(first_scan.manifest_entries, second_scan.manifest_entries)
            self.assertEqual(
                calculate_manifest_hash(first_scan.manifest_entries),
                calculate_manifest_hash(second_scan.manifest_entries),
            )

            legacy = build_legacy_collision_diagnostics(first)
            first_reports, first_hash = build_reports(first_scan, legacy)
            second_reports, second_hash = build_reports(second_scan, legacy)
            self.assertEqual(first_hash, second_hash)
            self.assertEqual(first_reports, second_reports)


class MatchAndInningsObservationTests(unittest.TestCase):
    def test_classifies_one_two_four_and_six_innings_fixtures(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_dir:
            root = Path(temporary_dir)
            fixtures = {
                "1.json": [empty_innings()],
                "2.json": [empty_innings(), empty_innings("Team B")],
                "3.json": [
                    empty_innings(),
                    empty_innings("Team B"),
                    empty_innings(super_over=True),
                    empty_innings("Team B", super_over=True),
                ],
                "4.json": [
                    empty_innings(),
                    empty_innings("Team B"),
                    empty_innings(super_over=True),
                    empty_innings("Team B", super_over=True),
                    empty_innings(super_over=True),
                    empty_innings("Team B", super_over=True),
                ],
            }
            for file_name, innings in fixtures.items():
                write_match(root, file_name, make_match(innings=innings))
            scan = scan_archive(root)
            self.assertEqual(scan.headline["normalInnings"], 7)
            self.assertEqual(scan.headline["superOverInnings"], 6)
            self.assertEqual(scan.anomalies["oneNormalInningsMatches"]["count"], 1)
            self.assertEqual(scan.anomalies["moreThanTwoInningsMatches"]["count"], 2)
            self.assertEqual(scan.anomalies["doubleSuperOverMatches"]["count"], 1)

    def test_outcomes_multi_date_and_miscounted_overs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_dir:
            root = Path(temporary_dir)
            tied = make_match(outcome={"result": "tie", "eliminator": "Team A"})
            no_result = make_match(outcome={"result": "no result"})
            adjusted = make_match(outcome={"winner": "Team A", "method": "D/L", "by": {"runs": 2}})
            adjusted["info"]["dates"] = ["2024-04-01", "2024-04-02"]
            adjusted["info"]["registry"]["people"]["Test Umpire"] = "umpire-id"
            adjusted["innings"][0]["miscounted_overs"] = {
                "7": {"balls": 5, "umpire": "Test Umpire"}
            }
            write_match(root, "1.json", tied)
            write_match(root, "2.json", no_result)
            write_match(root, "3.json", adjusted)
            scan = scan_archive(root)
            self.assertEqual(scan.anomalies["tiedMatches"]["count"], 1)
            self.assertEqual(scan.anomalies["eliminatorOutcomes"]["count"], 1)
            self.assertEqual(scan.anomalies["eliminatorResolvedTies"]["count"], 1)
            self.assertEqual(scan.anomalies["noResults"]["count"], 1)
            self.assertEqual(scan.anomalies["dlAdjustedOutcomes"]["count"], 1)
            self.assertEqual(scan.anomalies["multiDateMatches"]["count"], 1)
            self.assertEqual(scan.anomalies["miscountedOvers"]["count"], 1)

    def test_participant_sizes_replacements_and_substitute_fielding(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_dir:
            root = Path(temporary_dir)
            players = {
                "Team A": [f"A{number}" for number in range(1, 12)],
                "Team B": [f"B{number}" for number in range(1, 13)],
            }
            names = {name for values in players.values() for name in values}
            names.add("C13")
            registry = {name: f"id-{name.lower()}" for name in names}
            event_delivery = delivery(
                wickets=[
                    {
                        "kind": "caught",
                        "player_out": "A1",
                        "fielders": [{"name": "B2", "substitute": True}],
                    }
                ],
                replacements={
                    "match": [
                        {"in": "B12", "out": "B11", "team": "Team B", "reason": "impact_player"},
                        {
                            "in": "B11",
                            "out": "B12",
                            "team": "Team B",
                            "reason": "concussion_substitute",
                        },
                    ],
                    "role": [
                        {"in": "B2", "out": "B1", "role": "bowler", "reason": "injury"},
                        {
                            "in": "B1",
                            "role": "bowler",
                            "reason": "excluded - high full pitched balls",
                        },
                    ],
                },
            )
            data = make_match(
                players=players,
                registry=registry,
                innings=[{"team": "Team A", "overs": [{"over": 0, "deliveries": [event_delivery]}]}],
            )
            write_match(root, "1.json", data)

            thirteen_players = copy.deepcopy(players)
            thirteen_players["Team B"].append("C13")
            write_match(
                root,
                "2.json",
                make_match(players=thirteen_players, registry=registry, innings=[]),
            )
            scan = scan_archive(root)
            self.assertEqual(scan.anomalies["participantListSizes"]["11"]["count"], 2)
            self.assertEqual(scan.anomalies["participantListSizes"]["12"]["count"], 1)
            self.assertEqual(scan.anomalies["participantListSizes"]["13"]["count"], 1)
            self.assertEqual(scan.anomalies["matchReplacementsByReason"]["impact_player"]["count"], 1)
            self.assertEqual(scan.anomalies["matchReplacementsByReason"]["concussion_substitute"]["count"], 1)
            self.assertEqual(scan.anomalies["roleReplacementsByReason"]["injury"]["count"], 1)
            self.assertEqual(
                scan.anomalies["roleReplacementsByReason"]["excluded - high full pitched balls"]["count"],
                1,
            )
            self.assertEqual(scan.anomalies["substituteFieldingEvents"]["count"], 1)
            self.assertEqual(scan.anomalies["observedDismissalKinds"]["caught"]["count"], 1)


class IdentityAndSeasonTests(unittest.TestCase):
    def test_duplicate_display_names_and_aliases_for_one_id(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_dir:
            root = Path(temporary_dir)
            first_players = {"Team A": ["Shared Name", "First Alias"], "Team B": ["B1"]}
            first_registry = {
                "Shared Name": "shared-id-one",
                "First Alias": "alias-id",
                "B1": "b1-id",
            }
            second_players = {"Team A": ["Shared Name", "Second Alias"], "Team B": ["B1"]}
            second_registry = {
                "Shared Name": "shared-id-two",
                "Second Alias": "alias-id",
                "B1": "b1-id",
            }
            write_match(root, "1.json", make_match(players=first_players, registry=first_registry, innings=[]))
            write_match(root, "2.json", make_match(players=second_players, registry=second_registry, innings=[]))
            scan = scan_archive(root)
            self.assertEqual(
                scan.identity["displayNamesSharedByMultipleIds"],
                [{"displayName": "Shared Name", "playerIds": ["shared-id-one", "shared-id-two"]}],
            )
            self.assertEqual(
                scan.identity["playerIdsObservedWithMultipleNames"],
                [{"playerId": "alias-id", "displayNames": ["First Alias", "Second Alias"]}],
            )

    def test_audit_only_edition_inference(self) -> None:
        self.assertEqual(infer_edition_display_year("2007/08"), 2008)
        self.assertEqual(infer_edition_display_year("2009/10"), 2010)
        self.assertEqual(infer_edition_display_year("2020/21"), 2020)
        self.assertEqual(infer_edition_display_year("2021"), 2021)
        with self.assertRaises(AuditError):
            infer_edition_display_year("unknown")


class LegacyCollisionTests(unittest.TestCase):
    def test_uses_exact_legacy_aggregate_rows_and_ids(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_dir:
            root = Path(temporary_dir)
            shared_players = {"Team A": ["A1"], "Team B": ["B1"]}
            registry = {"A1": "a1-id", "B1": "b1-id"}
            write_match(
                root,
                "1.json",
                make_match(season="2020/21", players=shared_players, registry=registry, innings=[]),
            )
            write_match(
                root,
                "2.json",
                make_match(season="2021", players=shared_players, registry=registry, innings=[]),
            )
            diagnostics = build_legacy_collision_diagnostics(root)
            self.assertEqual(
                diagnostics["normalizationExamples"],
                [
                    {"sourceSeason": "2020/21", "legacyNormalizedSeason": 2021},
                    {"sourceSeason": "2021", "legacyNormalizedSeason": 2021},
                ],
            )
            self.assertEqual(diagnostics["duplicatePlayerSeasonIdCount"], 2)
            self.assertEqual(diagnostics["duplicateFranchiseSeasonIdCount"], 2)
            self.assertEqual(
                {row["sourceSeason"] for row in diagnostics["duplicatePlayerSeasonIds"][0]["rows"]},
                {"2020/21", "2021"},
            )


class FullArchiveRegressionTests(unittest.TestCase):
    @unittest.skipUnless(Path("data/raw/cricsheet").is_dir(), "local Cricsheet archive unavailable")
    def test_full_archive_headline_counts_and_exact_collisions(self) -> None:
        raw_dir = Path("data/raw/cricsheet")
        scan = scan_archive(raw_dir)
        self.assertEqual(scan.headline["numericMatchFiles"], 1243)
        self.assertEqual(scan.headline["iplEditions"], 19)
        self.assertEqual(scan.headline["normalInnings"], 2480)
        self.assertEqual(scan.headline["superOverInnings"], 34)
        self.assertEqual(scan.headline["noResults"], 9)
        self.assertEqual(scan.headline["dlResults"], 23)
        self.assertEqual(scan.headline["eliminatorResolvedTies"], 16)
        self.assertEqual(scan.headline["impactPlayerReplacements"], 557)
        self.assertEqual(scan.headline["concussionSubstitutes"], 6)
        self.assertEqual(scan.headline["injuryRoleReplacements"], 51)
        self.assertEqual(scan.headline["excludedBowlerRoleReplacements"], 10)
        self.assertEqual(scan.headline["substituteFieldingEvents"], 227)
        self.assertEqual(scan.headline["uniqueRawVenueStrings"], 60)
        self.assertEqual(scan.headline["uniqueRawCityStrings"], 37)

        collisions = build_legacy_collision_diagnostics(raw_dir)
        self.assertEqual(collisions["duplicatePlayerSeasonIdCount"], 91)
        self.assertEqual(collisions["duplicateFranchiseSeasonIdCount"], 7)


if __name__ == "__main__":
    unittest.main()
