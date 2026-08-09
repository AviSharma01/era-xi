from __future__ import annotations

import hashlib
import json
import shutil
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path

from scripts.identity_registry.builder import RegistryBuildError, build_registry_bytes, pretty_json_bytes
from scripts.identity_registry.integrity import RegistryIntegrityError
from scripts.identity_registry.resolver import (
    IdentityResolutionError,
    IdentityResolver,
    IngestionSafetyError,
    require_ingestion_safe_resolution,
)
from scripts.identity_registry.schemas import (
    SchemaValidationError,
    build_resolution_error_schema,
    build_schema_documents,
    validate_instance,
)


REGISTRY_DIR = Path("data/registries/ipl/v1")
AUDIT_DIR = Path("data/audit/cricsheet-ipl/v1")
RAW_DIR = Path("data/raw/cricsheet")


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def load_players(path: Path = REGISTRY_DIR / "players.jsonl") -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def compact_jsonl_bytes(rows: list[dict]) -> bytes:
    return b"".join(
        (json.dumps(row, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")
        for row in rows
    )


def refresh_manifest(registry_dir: Path, changed_path: str) -> None:
    manifest_path = registry_dir / "registry_manifest.json"
    manifest = load_json(manifest_path)
    content = (registry_dir / changed_path).read_bytes()
    entry = next(row for row in manifest["generatedFiles"] if row["path"] == changed_path)
    entry["sha256"] = hashlib.sha256(content).hexdigest()
    entry["sizeBytes"] = len(content)
    aggregate = hashlib.sha256()
    for artifact in sorted(manifest["generatedFiles"], key=lambda row: row["path"]):
        artifact_content = (registry_dir / artifact["path"]).read_bytes()
        aggregate.update(artifact["path"].encode("utf-8"))
        aggregate.update(b"\0")
        aggregate.update(artifact_content)
    manifest["registryAggregateHash"] = aggregate.hexdigest()
    manifest_path.write_bytes(pretty_json_bytes(manifest))


class CanonicalRegistryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.resolver = IdentityResolver.load(REGISTRY_DIR)
        cls.seasons = load_json(REGISTRY_DIR / "seasons.json")
        cls.teams = load_json(REGISTRY_DIR / "teams.json")
        cls.franchises = load_json(REGISTRY_DIR / "franchises.json")
        cls.players = load_players()
        cls.venues = load_json(REGISTRY_DIR / "venues.json")
        cls.eras = load_json(REGISTRY_DIR / "eras.json")
        cls.manifest = load_json(REGISTRY_DIR / "registry_manifest.json")

    def test_registry_counts_are_derived_and_player_union_is_complete(self) -> None:
        counts = self.manifest["counts"]
        self.assertEqual(counts["seasons"], len(self.seasons["seasons"]))
        self.assertEqual(counts["teams"], len(self.teams["teams"]))
        self.assertEqual(counts["franchises"], len(self.franchises["franchises"]))
        self.assertEqual(counts["players"], len(self.players))
        self.assertEqual(counts["venueVersions"], len(self.venues["venues"]))
        self.assertEqual(counts["venueSites"], len({row["venueSiteId"] for row in self.venues["venues"]}))
        self.assertEqual(counts["officialParticipantPlayerIds"], 809)
        self.assertEqual(counts["eventOnlyPlayerIds"], 7)
        self.assertEqual(counts["players"], 816)
        self.assertEqual(counts["rawVenueStrings"], 60)

    def test_explicit_season_mappings_prevent_legacy_collision(self) -> None:
        self.assertEqual(self.resolver.resolve_source_season("2007/08")["id"], "ipl-2008")
        self.assertEqual(self.resolver.resolve_source_season("2009/10")["id"], "ipl-2010")
        self.assertEqual(self.resolver.resolve_source_season("2020/21")["id"], "ipl-2020")
        self.assertEqual(self.resolver.resolve_source_season("2021")["id"], "ipl-2021")
        self.assertNotEqual(
            self.resolver.resolve_source_season("2020/21")["id"],
            self.resolver.resolve_source_season("2021")["id"],
        )
        self.assertTrue(
            all(row["archiveCoverageStatus"] == "accepted_baseline" for row in self.seasons["seasons"])
        )
        with self.assertRaises(IdentityResolutionError) as context:
            self.resolver.resolve_source_season("2021/22")
        self.assertEqual(context.exception.code, "unknown_source_season")

    def test_every_audited_team_season_pair_resolves(self) -> None:
        coverage = load_json(AUDIT_DIR / "season_coverage.json")
        for season in coverage["seasons"]:
            season_id = self.resolver.resolve_source_season(season["sourceSeason"])["id"]
            for source_team in season["rawTeamNames"]:
                result = self.resolver.resolve_team(source_team, season_id)
                self.assertEqual(result["status"], "canonical")
        delhi_old = self.resolver.resolve_team("Delhi Daredevils", "ipl-2018")
        delhi_new = self.resolver.resolve_team("Delhi Capitals", "ipl-2019")
        self.assertNotEqual(delhi_old["teamId"], delhi_new["teamId"])
        self.assertEqual(delhi_old["franchiseId"], delhi_new["franchiseId"])
        with self.assertRaises(IdentityResolutionError) as context:
            self.resolver.resolve_team("Delhi Daredevils", "ipl-2019")
        self.assertEqual(context.exception.code, "invalid_team_season")

    def test_franchise_relationships_preserve_lineage_semantics(self) -> None:
        by_id = {row["franchiseId"]: row for row in self.franchises["franchises"]}
        deccan = by_id["franchise-deccan-chargers"]
        sunrisers = by_id["franchise-sunrisers-hyderabad"]
        self.assertNotEqual(deccan["franchiseId"], sunrisers["franchiseId"])
        self.assertIn(
            {"relatedFranchiseId": sunrisers["franchiseId"], "relationshipType": "competition_successor"},
            deccan["relationships"],
        )
        rising = self.resolver.resolve_team("Rising Pune Supergiants", "ipl-2016")
        singular = self.resolver.resolve_team("Rising Pune Supergiant", "ipl-2017")
        self.assertEqual(rising["teamId"], singular["teamId"])

    def test_every_audited_player_id_name_pair_resolves(self) -> None:
        audit = load_json(AUDIT_DIR / "participant_identity_observations.json")
        for row in audit["playerRegistryIds"]:
            for name in row["displayNames"]:
                result = self.resolver.resolve_player(row["playerId"], name)
                self.assertEqual(result["id"], row["playerId"])
        for row in audit["deliveryParticipantsAbsentFromOfficialLists"]:
            result = self.resolver.resolve_player(row["playerId"], row["displayName"])
            self.assertEqual(result["id"], row["playerId"])

    def test_player_alias_decisions_and_no_name_fallback(self) -> None:
        expected = {
            "12314277": "Arshad Khan",
            "21d4e29b": "Navdeep Saini",
            "d7423da1": "Salil Arora",
        }
        for player_id, canonical_name in expected.items():
            player = next(row for row in self.players if row["playerId"] == player_id)
            self.assertEqual(player["canonicalDisplayName"], canonical_name)
            self.assertGreaterEqual(len(player["observedAliases"]), 2)
        harmeet = [row for row in self.players if row["canonicalDisplayName"] == "Harmeet Singh"]
        self.assertEqual({row["playerId"] for row in harmeet}, {"0bf15e52", "2a72fd4f"})
        self.assertTrue(all(row["duplicateDisplayName"] for row in harmeet))
        with self.assertRaises(IdentityResolutionError) as context:
            self.resolver.resolve_player("not-a-registry-id", "Harmeet Singh")
        self.assertEqual(context.exception.code, "unknown_player_id")
        unseen = self.resolver.resolve_player("21d4e29b", "N Saini")
        self.assertEqual(unseen["status"], "review_required")
        self.assertEqual(unseen["matchedBy"], "exact_player_id_unregistered_alias")
        self.assertTrue(unseen["requiresNewReview"])
        with self.assertRaises(IngestionSafetyError):
            require_ingestion_safe_resolution(unseen)

    def test_event_only_players_are_canonical_identities_with_reviewable_evidence(self) -> None:
        event_only = [row for row in self.players if row["participationBasis"] == "event_only"]
        self.assertEqual(len(event_only), 7)
        for player in event_only:
            self.assertEqual(player["identityStatus"], "canonical")
            self.assertEqual(player["reviewStatus"], "review_required")
            result = self.resolver.resolve_player(player["playerId"], player["canonicalDisplayName"])
            self.assertEqual(result["status"], "canonical")
            self.assertEqual(result["registryReviewStatus"], "review_required")
            self.assertFalse(result["requiresNewReview"])
            self.assertIs(require_ingestion_safe_resolution(result), result)

    def test_every_audited_venue_context_resolves_and_missing_city_is_allowed(self) -> None:
        for venue in self.venues["venues"]:
            for alias in venue["sourceAliases"]:
                for season_id in alias["seasonIds"]:
                    if alias["observedCities"]:
                        for city in alias["observedCities"]:
                            result = self.resolver.resolve_venue(alias["sourceVenue"], city, season_id)
                            self.assertEqual(result["venueId"], venue["venueId"])
                    missing_city = self.resolver.resolve_venue(alias["sourceVenue"], None, season_id)
                    self.assertEqual(missing_city["venueId"], venue["venueId"])
        motera_old = self.resolver.resolve_venue("Sardar Patel Stadium, Motera", "Ahmedabad", "ipl-2015")
        motera_new = self.resolver.resolve_venue("Narendra Modi Stadium, Ahmedabad", "Ahmedabad", "ipl-2021")
        self.assertNotEqual(motera_old["venueId"], motera_new["venueId"])
        self.assertEqual(motera_old["venueSiteId"], motera_new["venueSiteId"])
        conflict = self.resolver.resolve_venue("Wankhede Stadium", "Delhi", "ipl-2019")
        self.assertEqual(conflict["status"], "review_required")
        with self.assertRaises(IngestionSafetyError):
            require_ingestion_safe_resolution(conflict)
        with self.assertRaises(IdentityResolutionError):
            self.resolver.resolve_venue("Unknown Stadium", None, "ipl-2019")

    def test_provisional_venue_identity_remains_distinct(self) -> None:
        seasons = {
            "registryVersion": "test", "seasons": [{"seasonId": "ipl-test", "sourceSeasons": ["test"]}]
        }
        teams = {"registryVersion": "test", "teams": []}
        venues = {
            "registryVersion": "test",
            "venues": [
                {
                    "venueId": "venue-provisional-a", "venueSiteId": "site-a", "status": "provisional",
                    "reviewStatus": "review_required", "notes": [],
                    "sourceAliases": [{"sourceVenue": "Similar Ground A", "observedCities": [], "seasonIds": ["ipl-test"]}],
                },
                {
                    "venueId": "venue-provisional-b", "venueSiteId": "site-b", "status": "provisional",
                    "reviewStatus": "review_required", "notes": [],
                    "sourceAliases": [{"sourceVenue": "Similar Ground B", "observedCities": [], "seasonIds": ["ipl-test"]}],
                },
            ],
        }
        resolver = IdentityResolver(seasons, teams, [], venues)
        first = resolver.resolve_venue("Similar Ground A", None, "ipl-test")
        second = resolver.resolve_venue("Similar Ground B", None, "ipl-test")
        self.assertNotEqual(first["id"], second["id"])
        self.assertEqual(first["status"], "provisional")
        self.assertEqual(first["registryReviewStatus"], "review_required")
        self.assertFalse(first["requiresNewReview"])
        self.assertIs(require_ingestion_safe_resolution(first), first)

    def test_known_duplicate_display_names_remain_distinct_and_ingestion_safe(self) -> None:
        first = self.resolver.resolve_player("0bf15e52", "Harmeet Singh")
        second = self.resolver.resolve_player("2a72fd4f", "Harmeet Singh")
        self.assertNotEqual(first["id"], second["id"])
        self.assertEqual(first["registryReviewStatus"], "review_required")
        self.assertEqual(second["registryReviewStatus"], "review_required")
        self.assertIs(require_ingestion_safe_resolution(first), first)
        self.assertIs(require_ingestion_safe_resolution(second), second)

    def test_canonical_resolutions_pass_the_ingestion_gate_and_fatal_ones_do_not_resolve(self) -> None:
        resolutions = [
            self.resolver.resolve_source_season("2021"),
            self.resolver.resolve_team("Delhi Capitals", "ipl-2021"),
            self.resolver.resolve_player("21d4e29b", "Navdeep Saini"),
            self.resolver.resolve_venue("Wankhede Stadium", "Mumbai", "ipl-2019"),
        ]
        for resolution in resolutions:
            self.assertIs(require_ingestion_safe_resolution(resolution), resolution)
        with self.assertRaises(IdentityResolutionError):
            self.resolver.resolve_player("unknown-id", "Unknown Player")
        with self.assertRaises(IdentityResolutionError):
            self.resolver.resolve_team("Delhi Daredevils", "ipl-2021")
        with self.assertRaises(IngestionSafetyError):
            require_ingestion_safe_resolution({"status": "canonical"})

    def test_eras_are_explicit_and_cover_approved_seasons_once(self) -> None:
        configured = [season for era in self.eras["eras"] for season in era["seasonIds"]]
        canonical = [season["seasonId"] for season in self.seasons["seasons"]]
        self.assertEqual(sorted(configured), sorted(canonical))
        self.assertEqual(len(configured), len(set(configured)))
        impact = next(era for era in self.eras["eras"] if era["eraId"] == "era-impact")
        self.assertEqual(impact["seasonIds"], ["ipl-2023", "ipl-2024", "ipl-2025", "ipl-2026"])

    def test_review_queue_contains_only_expected_open_categories(self) -> None:
        queue = load_json(REGISTRY_DIR / "review_queue.json")["items"]
        categories = {row["category"] for row in queue}
        self.assertEqual(categories, {"duplicate_player_display_name", "event_only_player_participation"})
        self.assertEqual(sum(row["category"] == "event_only_player_participation" for row in queue), 7)
        self.assertEqual(sum(row["category"] == "duplicate_player_display_name" for row in queue), 1)

    def test_resolution_report_covers_all_stage_one_identity_evidence(self) -> None:
        summary = load_json(REGISTRY_DIR / "resolution_report.json")["summary"]
        self.assertEqual(summary["fatalResolutionErrors"], 0)
        self.assertEqual(summary["archiveMatchObservationsResolved"], 1243)
        self.assertEqual(summary["officialParticipantPlayerIdsResolved"], 809)
        self.assertEqual(summary["eventOnlyPlayerIdsResolved"], 7)
        self.assertEqual(summary["eventObservationsOutsideOfficialListsResolved"], 197)
        self.assertEqual(summary["unresolvedRegistryReferences"], 0)
        self.assertEqual(summary["rawVenueStringsResolved"], 60)

    def test_generated_documents_validate_against_executable_schemas(self) -> None:
        schemas = build_schema_documents()
        instances = {
            "seasons.schema.json": self.seasons,
            "teams.schema.json": self.teams,
            "franchises.schema.json": self.franchises,
            "venues.schema.json": self.venues,
            "eras.schema.json": self.eras,
            "resolution_report.schema.json": load_json(REGISTRY_DIR / "resolution_report.json"),
            "review_queue.schema.json": load_json(REGISTRY_DIR / "review_queue.json"),
            "registry_manifest.schema.json": self.manifest,
        }
        for name, instance in instances.items():
            validate_instance(instance, schemas[name])
        for player in self.players:
            validate_instance(player, schemas["players.schema.json"])

    def test_manifest_hashes_match_generated_files(self) -> None:
        for entry in self.manifest["generatedFiles"]:
            content = (REGISTRY_DIR / entry["path"]).read_bytes()
            self.assertEqual(hashlib.sha256(content).hexdigest(), entry["sha256"])
            self.assertEqual(len(content), entry["sizeBytes"])


class StrictSchemaAdversarialTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.schemas = build_schema_documents()
        cls.teams = load_json(REGISTRY_DIR / "teams.json")
        cls.players = load_players()
        cls.queue = load_json(REGISTRY_DIR / "review_queue.json")
        cls.manifest = load_json(REGISTRY_DIR / "registry_manifest.json")

    def assert_schema_rejects(self, instance: dict, schema_name: str) -> None:
        with self.assertRaises(SchemaValidationError):
            validate_instance(instance, self.schemas[schema_name])

    def test_missing_required_nested_property_is_rejected(self) -> None:
        broken = deepcopy(self.teams)
        del broken["teams"][0]["sourceAliases"][0]["sourceTeamName"]
        self.assert_schema_rejects(broken, "teams.schema.json")

    def test_unexpected_nested_property_is_rejected(self) -> None:
        broken = deepcopy(self.teams)
        broken["teams"][0]["sourceAliases"][0]["trimmedName"] = "unsafe fallback"
        self.assert_schema_rejects(broken, "teams.schema.json")

    def test_wrong_nested_type_is_rejected(self) -> None:
        broken = deepcopy(self.teams)
        broken["teams"][0]["sourceAliases"][0]["seasonIds"] = "ipl-2008"
        self.assert_schema_rejects(broken, "teams.schema.json")

    def test_invalid_nested_enum_is_rejected(self) -> None:
        broken = deepcopy(self.teams)
        related = next(team for team in broken["teams"] if team["relationships"])
        related["relationships"][0]["relationshipType"] = "replacement"
        self.assert_schema_rejects(broken, "teams.schema.json")

    def test_malformed_relationship_is_rejected(self) -> None:
        broken = deepcopy(self.teams)
        related = next(team for team in broken["teams"] if team["relationships"])
        del related["relationships"][0]["relatedTeamId"]
        self.assert_schema_rejects(broken, "teams.schema.json")

    def test_malformed_player_provenance_is_rejected(self) -> None:
        broken = deepcopy(self.players[0])
        evidence = broken["observedAliases"][0]["provenance"]["officialParticipantObservations"][0]
        evidence["unexpectedField"] = "not permitted"
        with self.assertRaises(SchemaValidationError):
            validate_instance(broken, self.schemas["players.schema.json"])

    def test_malformed_review_item_is_rejected(self) -> None:
        broken = deepcopy(self.queue)
        del broken["items"][0]["details"]["displayName"]
        self.assert_schema_rejects(broken, "review_queue.schema.json")

    def test_malformed_manifest_entry_is_rejected(self) -> None:
        broken = deepcopy(self.manifest)
        broken["generatedFiles"][0] = {"unexpected": "value"}
        self.assert_schema_rejects(broken, "registry_manifest.schema.json")

    def test_manifest_entry_with_wrong_hash_type_is_rejected(self) -> None:
        broken = deepcopy(self.manifest)
        broken["generatedFiles"][0]["sha256"] = 123
        self.assert_schema_rejects(broken, "registry_manifest.schema.json")

    def test_resolution_error_source_is_strictly_validated(self) -> None:
        error = IdentityResolutionError(
            "unknown_player_id",
            {"playerId": "unknown", "observedName": "Unknown"},
            "Unknown player",
        ).to_json()
        validate_instance(error, build_resolution_error_schema())
        error["source"]["fallbackNameMatch"] = True
        with self.assertRaises(SchemaValidationError):
            validate_instance(error, build_resolution_error_schema())


class ResolverIntegrityAdversarialTests(unittest.TestCase):
    def copy_registry(self, directory: str, name: str = "registry") -> Path:
        destination = Path(directory) / name
        shutil.copytree(REGISTRY_DIR, destination)
        return destination

    def test_untouched_registry_loads_with_optional_pins(self) -> None:
        manifest = load_json(REGISTRY_DIR / "registry_manifest.json")
        resolver = IdentityResolver.load(
            REGISTRY_DIR,
            expected_registry_version=manifest["registryVersion"],
            expected_registry_aggregate_hash=manifest["registryAggregateHash"],
            expected_source_archive_manifest_hash=manifest["sourceArchiveManifestHash"],
        )
        self.assertEqual(resolver.resolve_source_season("2021")["id"], "ipl-2021")
        with self.assertRaises(RegistryIntegrityError):
            IdentityResolver.load(REGISTRY_DIR, expected_registry_aggregate_hash="0" * 64)

    def test_one_byte_change_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            registry = self.copy_registry(directory)
            path = registry / "seasons.json"
            path.write_bytes(path.read_bytes() + b" ")
            with self.assertRaisesRegex(RegistryIntegrityError, "size mismatch"):
                IdentityResolver.load(registry)

    def test_valid_file_from_another_build_is_rejected_when_mixed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            target = self.copy_registry(directory, "target")
            other = self.copy_registry(directory, "other")
            seasons = load_json(other / "seasons.json")
            seasons["seasons"][0]["notes"].append("Schema-valid alternate build marker.")
            (other / "seasons.json").write_bytes(pretty_json_bytes(seasons))
            refresh_manifest(other, "seasons.json")
            IdentityResolver.load(other)
            shutil.copyfile(other / "seasons.json", target / "seasons.json")
            with self.assertRaisesRegex(RegistryIntegrityError, "size mismatch|hash mismatch"):
                IdentityResolver.load(target)

    def test_stale_per_file_hash_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            registry = self.copy_registry(directory)
            manifest_path = registry / "registry_manifest.json"
            manifest = load_json(manifest_path)
            manifest["generatedFiles"][0]["sha256"] = "0" * 64
            manifest_path.write_bytes(pretty_json_bytes(manifest))
            with self.assertRaisesRegex(RegistryIntegrityError, "hash mismatch"):
                IdentityResolver.load(registry)

    def test_missing_and_unexpected_files_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            missing = self.copy_registry(directory, "missing")
            (missing / "teams.json").unlink()
            with self.assertRaisesRegex(RegistryIntegrityError, "artifact set mismatch"):
                IdentityResolver.load(missing)
            unexpected = self.copy_registry(directory, "unexpected")
            (unexpected / "teams-copy.json").write_text("{}", encoding="utf-8")
            with self.assertRaisesRegex(RegistryIntegrityError, "artifact set mismatch"):
                IdentityResolver.load(unexpected)

    def test_malformed_manifest_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            registry = self.copy_registry(directory)
            (registry / "registry_manifest.json").write_text("{}", encoding="utf-8")
            with self.assertRaisesRegex(RegistryIntegrityError, "strict schema"):
                IdentityResolver.load(registry)

    def test_wrong_registry_version_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            registry = self.copy_registry(directory)
            manifest_path = registry / "registry_manifest.json"
            manifest = load_json(manifest_path)
            manifest["registryVersion"] = "ipl-identities-other"
            manifest_path.write_bytes(pretty_json_bytes(manifest))
            with self.assertRaisesRegex(RegistryIntegrityError, "approved policy"):
                IdentityResolver.load(registry)

    def test_wrong_stage_one_source_linkage_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            registry = self.copy_registry(directory)
            manifest_path = registry / "registry_manifest.json"
            manifest = load_json(manifest_path)
            manifest["sourceArchiveManifestHash"] = "0" * 64
            manifest_path.write_bytes(pretty_json_bytes(manifest))
            with self.assertRaisesRegex(RegistryIntegrityError, "provenance"):
                IdentityResolver.load(registry)

    def test_mixed_artifact_registry_version_and_source_linkage_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            mixed_version = self.copy_registry(directory, "mixed-version")
            teams = load_json(mixed_version / "teams.json")
            teams["registryVersion"] = "ipl-identities-other"
            (mixed_version / "teams.json").write_bytes(pretty_json_bytes(teams))
            refresh_manifest(mixed_version, "teams.json")
            with self.assertRaisesRegex(RegistryIntegrityError, "Mixed registry version"):
                IdentityResolver.load(mixed_version)

            mixed_source = self.copy_registry(directory, "mixed-source")
            seasons = load_json(mixed_source / "seasons.json")
            seasons["sourceArchiveManifestHash"] = "0" * 64
            (mixed_source / "seasons.json").write_bytes(pretty_json_bytes(seasons))
            refresh_manifest(mixed_source, "seasons.json")
            with self.assertRaisesRegex(RegistryIntegrityError, "Mixed Stage 1"):
                IdentityResolver.load(mixed_source)

    def test_duplicate_source_season_alias_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            registry = self.copy_registry(directory)
            seasons = load_json(registry / "seasons.json")
            seasons["seasons"][1]["sourceSeasons"] = deepcopy(seasons["seasons"][0]["sourceSeasons"])
            (registry / "seasons.json").write_bytes(pretty_json_bytes(seasons))
            refresh_manifest(registry, "seasons.json")
            with self.assertRaisesRegex(RegistryIntegrityError, "source season alias"):
                IdentityResolver.load(registry)

    def test_duplicate_team_alias_is_rejected_without_last_write_wins(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            registry = self.copy_registry(directory)
            teams = load_json(registry / "teams.json")
            teams["teams"][1]["sourceAliases"][0] = deepcopy(teams["teams"][0]["sourceAliases"][0])
            (registry / "teams.json").write_bytes(pretty_json_bytes(teams))
            refresh_manifest(registry, "teams.json")
            with self.assertRaisesRegex(RegistryIntegrityError, "team alias and season"):
                IdentityResolver.load(registry)

    def test_duplicate_venue_alias_is_rejected_without_last_write_wins(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            registry = self.copy_registry(directory)
            venues = load_json(registry / "venues.json")
            venues["venues"][1]["sourceAliases"][0] = deepcopy(venues["venues"][0]["sourceAliases"][0])
            (registry / "venues.json").write_bytes(pretty_json_bytes(venues))
            refresh_manifest(registry, "venues.json")
            with self.assertRaisesRegex(RegistryIntegrityError, "venue source alias"):
                IdentityResolver.load(registry)

    def test_duplicate_player_id_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            registry = self.copy_registry(directory)
            players = load_players(registry / "players.jsonl")
            players[1]["playerId"] = players[0]["playerId"]
            (registry / "players.jsonl").write_bytes(compact_jsonl_bytes(players))
            refresh_manifest(registry, "players.jsonl")
            with self.assertRaisesRegex(RegistryIntegrityError, "player IDs"):
                IdentityResolver.load(registry)

    def test_duplicate_frozen_team_id_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            registry = self.copy_registry(directory)
            teams = load_json(registry / "teams.json")
            teams["teams"][1]["teamId"] = teams["teams"][0]["teamId"]
            (registry / "teams.json").write_bytes(pretty_json_bytes(teams))
            refresh_manifest(registry, "teams.json")
            with self.assertRaisesRegex(RegistryIntegrityError, "team IDs"):
                IdentityResolver.load(registry)

    def test_broken_relationship_reference_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            registry = self.copy_registry(directory)
            teams = load_json(registry / "teams.json")
            related = next(team for team in teams["teams"] if team["relationships"])
            related["relationships"][0]["relatedTeamId"] = "team-unknown"
            (registry / "teams.json").write_bytes(pretty_json_bytes(teams))
            refresh_manifest(registry, "teams.json")
            with self.assertRaisesRegex(RegistryIntegrityError, "relationship references unknown"):
                IdentityResolver.load(registry)

    def test_schema_valid_but_cross_file_invalid_data_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            registry = self.copy_registry(directory)
            teams = load_json(registry / "teams.json")
            franchises = load_json(registry / "franchises.json")["franchises"]
            teams["teams"][0]["franchiseId"] = next(
                row["franchiseId"] for row in franchises if row["franchiseId"] != teams["teams"][0]["franchiseId"]
            )
            (registry / "teams.json").write_bytes(pretty_json_bytes(teams))
            refresh_manifest(registry, "teams.json")
            with self.assertRaisesRegex(RegistryIntegrityError, "linkage disagrees|team list is incomplete"):
                IdentityResolver.load(registry)

    def test_review_queue_reference_to_unknown_entity_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            registry = self.copy_registry(directory)
            queue = load_json(registry / "review_queue.json")
            event_item = next(item for item in queue["items"] if item["category"] == "event_only_player_participation")
            event_item["entityId"] = "unknown-player"
            (registry / "review_queue.json").write_bytes(pretty_json_bytes(queue))
            refresh_manifest(registry, "review_queue.json")
            with self.assertRaisesRegex(RegistryIntegrityError, "event-only player"):
                IdentityResolver.load(registry)

    def test_hash_consistent_but_schema_invalid_artifact_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            registry = self.copy_registry(directory)
            teams = load_json(registry / "teams.json")
            del teams["teams"][0]["sourceAliases"][0]["sourceTeamName"]
            (registry / "teams.json").write_bytes(pretty_json_bytes(teams))
            refresh_manifest(registry, "teams.json")
            with self.assertRaisesRegex(RegistryIntegrityError, "strict schema"):
                IdentityResolver.load(registry)


@unittest.skipUnless(RAW_DIR.is_dir(), "local Cricsheet archive unavailable")
class FullArchiveRegistryTests(unittest.TestCase):
    def test_two_full_builds_are_byte_identical_and_match_committed_outputs(self) -> None:
        first = build_registry_bytes()
        second = build_registry_bytes()
        self.assertEqual(first, second)
        committed = {
            str(path.relative_to(REGISTRY_DIR)): path.read_bytes()
            for path in REGISTRY_DIR.rglob("*")
            if path.is_file()
        }
        self.assertEqual(first, committed)

    def test_manifest_policy_disagreement_fails_before_generation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            manual_dir = Path(directory)
            for source in Path("data/manual/identity/v1").glob("*.json"):
                (manual_dir / source.name).write_bytes(source.read_bytes())
            policy_path = manual_dir / "registry_policy.json"
            policy = load_json(policy_path)
            policy["acceptedArchiveManifestHash"] = "0" * 64
            policy_path.write_text(json.dumps(policy), encoding="utf-8")
            with self.assertRaisesRegex(RegistryBuildError, "manifest hash disagreement"):
                build_registry_bytes(manual_dir=manual_dir)


class LegacyCompatibilityTests(unittest.TestCase):
    def test_tracked_2016_artifact_hashes_are_unchanged(self) -> None:
        expected = {
            "data/processed/2016/draft_player_seasons.json": "1f37ce41d88896e79597d15c857d130bd52cfce94873d93c8db0e36d057c6a92",
            "data/processed/2016/rated_player_seasons.json": "fa32a8eaf0e91e5640ffe319eeb931d39a91c3e7dee538d13c1ebe10e889444d",
            "data/processed/2016/ratings_review.json": "253c5f9a3ba1c52b57b8e99636bf367bb5f6a9244208b8fb9247b2b393422f08",
        }
        for path, digest in expected.items():
            self.assertEqual(hashlib.sha256(Path(path).read_bytes()).hexdigest(), digest)


if __name__ == "__main__":
    unittest.main()
