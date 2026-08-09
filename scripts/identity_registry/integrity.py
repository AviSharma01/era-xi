from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Iterable

from .schemas import (
    MANIFEST_ARTIFACT_PATHS,
    SchemaValidationError,
    build_schema_documents,
    validate_instance,
)


class RegistryIntegrityError(ValueError):
    pass


def _load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RegistryIntegrityError(f"Could not parse registry JSON {path}: {error}") from error


def _load_players(path: Path) -> list[dict[str, Any]]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
        if not lines or any(not line for line in lines):
            raise RegistryIntegrityError("players.jsonl must contain non-empty JSON objects without blank lines")
        rows = [json.loads(line) for line in lines]
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RegistryIntegrityError(f"Could not parse registry JSONL {path}: {error}") from error
    if not all(isinstance(row, dict) for row in rows):
        raise RegistryIntegrityError("Every players.jsonl row must be an object")
    return rows


def _assert_unique(values: Iterable[Any], label: str) -> None:
    seen: set[Any] = set()
    duplicates: set[Any] = set()
    for value in values:
        if value in seen:
            duplicates.add(value)
        seen.add(value)
    if duplicates:
        raise RegistryIntegrityError(f"Duplicate {label}: {sorted(duplicates)}")


def _insert_unique(index: dict[Any, Any], key: Any, value: Any, label: str) -> None:
    if key in index:
        raise RegistryIntegrityError(f"Duplicate {label}: {key!r}")
    index[key] = value


def _verify_envelopes(data: dict[str, Any], manifest: dict[str, Any]) -> None:
    expected_version = manifest["registryVersion"]
    expected_source_hash = manifest["sourceArchiveManifestHash"]
    for name in ("seasons", "teams", "franchises", "venues", "eras", "resolution_report", "review_queue"):
        document = data[name]
        if document["registryVersion"] != expected_version:
            raise RegistryIntegrityError(f"Mixed registry version in {name}.json")
        if document["sourceArchiveManifestHash"] != expected_source_hash:
            raise RegistryIntegrityError(f"Mixed Stage 1 source-manifest linkage in {name}.json")
    for player in data["players"]:
        if player["registryVersion"] != expected_version:
            raise RegistryIntegrityError(f"Mixed registry version in player {player['playerId']}")
        if player["sourceArchiveManifestHash"] != expected_source_hash:
            raise RegistryIntegrityError(f"Mixed Stage 1 source-manifest linkage in player {player['playerId']}")


def _validate_cross_file_invariants(data: dict[str, Any], manifest: dict[str, Any]) -> None:
    seasons = data["seasons"]["seasons"]
    teams = data["teams"]["teams"]
    franchises = data["franchises"]["franchises"]
    players = data["players"]
    venues = data["venues"]["venues"]
    eras = data["eras"]["eras"]
    queue = data["review_queue"]["items"]
    report = data["resolution_report"]

    _assert_unique((row["seasonId"] for row in seasons), "season IDs")
    if len(seasons) != 19:
        raise RegistryIntegrityError(f"IPL identity registry v1 must contain 19 seasons, found {len(seasons)}")
    season_by_id = {row["seasonId"]: row for row in seasons}
    source_season_index: dict[str, str] = {}
    for season in seasons:
        for source in season["sourceSeasons"]:
            _insert_unique(source_season_index, source, season["seasonId"], "source season alias")
    edition_order = {row["seasonId"]: row["editionOrder"] for row in seasons}
    if sorted(edition_order.values()) != list(range(1, len(seasons) + 1)):
        raise RegistryIntegrityError("Season editionOrder values must be contiguous and unique")

    _assert_unique((row["teamId"] for row in teams), "team IDs")
    _assert_unique((row["franchiseId"] for row in franchises), "franchise IDs")
    team_by_id = {row["teamId"]: row for row in teams}
    franchise_by_id = {row["franchiseId"]: row for row in franchises}
    team_alias_index: dict[tuple[str, str], str] = {}
    raw_team_aliases: set[str] = set()
    for team in teams:
        if team["franchiseId"] not in franchise_by_id:
            raise RegistryIntegrityError(f"Team {team['teamId']} references unknown franchise {team['franchiseId']}")
        alias_seasons: set[str] = set()
        for alias in team["sourceAliases"]:
            raw_team_aliases.add(alias["sourceTeamName"])
            for season_id in alias["seasonIds"]:
                if season_id not in season_by_id:
                    raise RegistryIntegrityError(f"Team alias references unknown season {season_id}")
                _insert_unique(
                    team_alias_index,
                    (alias["sourceTeamName"], season_id),
                    team["teamId"],
                    "team alias and season combination",
                )
                alias_seasons.add(season_id)
        if alias_seasons != set(team["activeSeasonIds"]):
            raise RegistryIntegrityError(f"Team active seasons disagree with aliases for {team['teamId']}")
        for relationship in team["relationships"]:
            if relationship["relatedTeamId"] not in team_by_id:
                raise RegistryIntegrityError(f"Team relationship references unknown ID {relationship['relatedTeamId']}")
    for franchise in franchises:
        for team_id in franchise["teamIds"]:
            if team_id not in team_by_id:
                raise RegistryIntegrityError(f"Franchise {franchise['franchiseId']} references unknown team {team_id}")
            if team_by_id[team_id]["franchiseId"] != franchise["franchiseId"]:
                raise RegistryIntegrityError(f"Team/franchise linkage disagrees for {team_id}")
        expected_team_ids = {row["teamId"] for row in teams if row["franchiseId"] == franchise["franchiseId"]}
        if set(franchise["teamIds"]) != expected_team_ids:
            raise RegistryIntegrityError(f"Franchise team list is incomplete for {franchise['franchiseId']}")
        expected_seasons = {season for team_id in expected_team_ids for season in team_by_id[team_id]["activeSeasonIds"]}
        if set(franchise["activeSeasonIds"]) != expected_seasons:
            raise RegistryIntegrityError(f"Franchise active seasons disagree with teams for {franchise['franchiseId']}")
        for relationship in franchise["relationships"]:
            if relationship["relatedFranchiseId"] not in franchise_by_id:
                raise RegistryIntegrityError(
                    f"Franchise relationship references unknown ID {relationship['relatedFranchiseId']}"
                )

    _assert_unique((row["playerId"] for row in players), "player IDs")
    player_by_id = {row["playerId"]: row for row in players}
    shared_aliases: dict[str, list[str]] = {}
    alias_owners: dict[str, set[str]] = {}
    for player in players:
        _assert_unique((alias["name"] for alias in player["observedAliases"]), f"aliases for player {player['playerId']}")
        for alias in player["observedAliases"]:
            alias_owners.setdefault(alias["name"], set()).add(player["playerId"])
            for provenance_group in alias["provenance"].values():
                for observation in provenance_group:
                    if observation["seasonId"] not in season_by_id:
                        raise RegistryIntegrityError(f"Player evidence references unknown season {observation['seasonId']}")
        if player["firstObservedSeasonId"] not in season_by_id or player["lastObservedSeasonId"] not in season_by_id:
            raise RegistryIntegrityError(f"Player {player['playerId']} references unknown observed season")
        if edition_order[player["firstObservedSeasonId"]] > edition_order[player["lastObservedSeasonId"]]:
            raise RegistryIntegrityError(f"Player {player['playerId']} has reversed observed season bounds")
        for reference in player["metadataOverlayRefs"]:
            if reference["playerId"] != player["playerId"]:
                raise RegistryIntegrityError(f"Metadata reference is attached to the wrong player {player['playerId']}")
            reference_path = Path(reference["path"])
            if reference_path.is_absolute() or ".." in reference_path.parts:
                raise RegistryIntegrityError(f"Unsafe metadata overlay path for {player['playerId']}")
    for alias, owners in alias_owners.items():
        if len(owners) > 1:
            shared_aliases[alias] = sorted(owners)

    _assert_unique((row["venueId"] for row in venues), "venue IDs")
    venue_by_id = {row["venueId"]: row for row in venues}
    venue_alias_index: dict[str, str] = {}
    venue_sites: set[str] = set()
    for venue in venues:
        venue_sites.add(venue["venueSiteId"])
        alias_seasons: set[str] = set()
        alias_matches: set[str] = set()
        for alias in venue["sourceAliases"]:
            _insert_unique(venue_alias_index, alias["sourceVenue"], venue["venueId"], "venue source alias")
            for season_id in alias["seasonIds"]:
                if season_id not in season_by_id:
                    raise RegistryIntegrityError(f"Venue alias references unknown season {season_id}")
                alias_seasons.add(season_id)
            alias_matches.update(alias["sourceMatchIds"])
        if alias_seasons != set(venue["activeSeasonIds"]):
            raise RegistryIntegrityError(f"Venue active seasons disagree with aliases for {venue['venueId']}")
        if alias_matches != set(venue["sourceMatchIds"]):
            raise RegistryIntegrityError(f"Venue source matches disagree with aliases for {venue['venueId']}")
        for relationship in venue["relationships"]:
            related = venue_by_id.get(relationship["relatedVenueId"])
            if related is None:
                raise RegistryIntegrityError(f"Venue relationship references unknown ID {relationship['relatedVenueId']}")
            if related["venueSiteId"] != venue["venueSiteId"]:
                raise RegistryIntegrityError(f"Rebuilt venue relationship crosses sites for {venue['venueId']}")

    _assert_unique((row["eraId"] for row in eras), "era IDs")
    era_by_id = {row["eraId"]: row for row in eras}
    configured_seasons: list[str] = []
    for era in eras:
        if any(season_id not in season_by_id for season_id in era["seasonIds"]):
            raise RegistryIntegrityError(f"Era {era['eraId']} references an unknown season")
        if era["seasonIds"] != sorted(era["seasonIds"], key=edition_order.__getitem__):
            raise RegistryIntegrityError(f"Era {era['eraId']} season ordering is not explicit chronological order")
        configured_seasons.extend(era["seasonIds"])
    if len(configured_seasons) != len(set(configured_seasons)) or set(configured_seasons) != set(season_by_id):
        raise RegistryIntegrityError("Era definitions must cover every season exactly once")
    for season in seasons:
        if set(season["eraIds"]) != {era_id for era_id, era in era_by_id.items() if season["seasonId"] in era["seasonIds"]}:
            raise RegistryIntegrityError(f"Season/era linkage disagrees for {season['seasonId']}")

    _assert_unique((item["itemId"] for item in queue), "review queue item IDs")
    duplicate_review_aliases: dict[str, list[str]] = {}
    for item in queue:
        if item["category"] == "duplicate_player_display_name":
            if any(player_id not in player_by_id for player_id in item["entityIds"]):
                raise RegistryIntegrityError(f"Review item {item['itemId']} references an unknown player")
            _insert_unique(
                duplicate_review_aliases,
                item["details"]["displayName"],
                sorted(item["entityIds"]),
                "duplicate-display-name review alias",
            )
        elif item["category"] == "event_only_player_participation":
            player = player_by_id.get(item["entityId"])
            if player is None or player["participationBasis"] != "event_only":
                raise RegistryIntegrityError(f"Review item {item['itemId']} does not reference an event-only player")
        elif item["category"] == "provisional_venue_mapping":
            if item["entityId"] not in venue_by_id:
                raise RegistryIntegrityError(f"Review item {item['itemId']} references an unknown venue")
    if shared_aliases != duplicate_review_aliases:
        raise RegistryIntegrityError("Shared player aliases disagree with duplicate-display-name review decisions")

    for observation in report["seasonObservations"]:
        if source_season_index.get(observation["sourceSeason"]) != observation["seasonId"]:
            raise RegistryIntegrityError("Resolution report contains an invalid season observation")
    for observation in report["teamObservations"]:
        team_id = team_alias_index.get((observation["sourceTeamName"], observation["seasonId"]))
        if (
            team_id is None
            or team_id != observation["teamId"]
            or team_by_id[team_id]["franchiseId"] != observation["franchiseId"]
        ):
            raise RegistryIntegrityError("Resolution report contains an invalid team observation")
    for observation in report["playerObservations"]:
        player = player_by_id.get(observation["playerId"])
        if player is None or observation["observedName"] not in {alias["name"] for alias in player["observedAliases"]}:
            raise RegistryIntegrityError("Resolution report contains an invalid player observation")
    for observation in report["venueObservations"]:
        venue_id = venue_alias_index.get(observation["sourceVenue"])
        if (
            venue_id is None
            or venue_id != observation["venueId"]
            or venue_by_id[venue_id]["venueSiteId"] != observation["venueSiteId"]
        ):
            raise RegistryIntegrityError("Resolution report contains an invalid venue observation")

    counts = manifest["counts"]
    expected_counts = {
        "seasons": len(seasons),
        "rawTeamNames": len(raw_team_aliases),
        "teams": len(teams),
        "franchises": len(franchises),
        "officialParticipantPlayerIds": sum(p["participationBasis"] == "official_participant" for p in players),
        "eventOnlyPlayerIds": sum(p["participationBasis"] == "event_only" for p in players),
        "players": len(players),
        "rawVenueStrings": len(venue_alias_index),
        "venueVersions": len(venues),
        "venueSites": len(venue_sites),
        "eras": len(eras),
        "reviewQueueItems": len(queue),
    }
    if counts != expected_counts:
        raise RegistryIntegrityError(f"Registry manifest counts disagree with loaded artifacts: {counts} != {expected_counts}")
    if counts["rawVenueStrings"] != 60:
        raise RegistryIntegrityError("IPL identity registry v1 must resolve all 60 raw venue strings")
    if report["summary"]["fatalResolutionErrors"] != 0 or report["summary"]["unresolvedRegistryReferences"] != 0:
        raise RegistryIntegrityError("Resolution report contains fatal or unresolved identity references")


def load_verified_registry(
    registry_dir: Path,
    *,
    policy_path: Path,
    expected_registry_version: str | None = None,
    expected_registry_aggregate_hash: str | None = None,
    expected_source_archive_manifest_hash: str | None = None,
) -> dict[str, Any]:
    registry_dir = Path(registry_dir)
    policy_path = Path(policy_path)
    if not registry_dir.is_dir():
        raise RegistryIntegrityError(f"Registry directory does not exist: {registry_dir}")
    for path in registry_dir.rglob("*"):
        if path.is_symlink():
            raise RegistryIntegrityError(f"Registry artifacts must not be symlinks: {path}")

    manifest_path = registry_dir / "registry_manifest.json"
    if not manifest_path.is_file():
        raise RegistryIntegrityError("Missing required registry_manifest.json")
    manifest = _load_json(manifest_path)
    schemas = build_schema_documents()
    try:
        validate_instance(manifest, schemas["registry_manifest.schema.json"])
    except SchemaValidationError as error:
        raise RegistryIntegrityError(f"Registry manifest failed strict schema validation: {error}") from error

    policy = _load_json(policy_path)
    required_policy = {"schemaVersion", "registryVersion", "acceptedArchiveManifestHash", "ingestionSafetyPolicy"}
    if not isinstance(policy, dict) or required_policy - set(policy):
        raise RegistryIntegrityError("Registry policy is missing required integrity or ingestion-safety fields")
    if manifest["registryVersion"] != policy["registryVersion"]:
        raise RegistryIntegrityError("Registry version is incompatible with the approved policy")
    if manifest["schemaVersion"] != policy["schemaVersion"]:
        raise RegistryIntegrityError("Registry schema version is incompatible with the approved policy")
    if manifest["sourceArchiveManifestHash"] != policy["acceptedArchiveManifestHash"]:
        raise RegistryIntegrityError("Registry Stage 1 provenance is incompatible with the approved policy")
    expected_ingestion_policy = {
        "knownRegistryReviewMetadata": "non_blocking_for_exact_overlay_backed_resolution",
        "runtimeReviewRequired": "reject_before_ingestion",
        "safeResolutionStatuses": ["canonical", "provisional"],
    }
    if policy["ingestionSafetyPolicy"] != expected_ingestion_policy:
        raise RegistryIntegrityError("Registry ingestion-safety policy is unsupported or malformed")
    if expected_registry_version is not None and manifest["registryVersion"] != expected_registry_version:
        raise RegistryIntegrityError("Registry version does not match the caller's pinned version")
    if expected_registry_aggregate_hash is not None and manifest["registryAggregateHash"] != expected_registry_aggregate_hash:
        raise RegistryIntegrityError("Registry aggregate hash does not match the caller's pinned hash")
    if (
        expected_source_archive_manifest_hash is not None
        and manifest["sourceArchiveManifestHash"] != expected_source_archive_manifest_hash
    ):
        raise RegistryIntegrityError("Stage 1 source-manifest hash does not match the caller's pinned hash")

    manifest_entries = manifest["generatedFiles"]
    _assert_unique((entry["path"] for entry in manifest_entries), "registry manifest paths")
    entry_by_path = {entry["path"]: entry for entry in manifest_entries}
    expected_artifacts = set(MANIFEST_ARTIFACT_PATHS)
    if set(entry_by_path) != expected_artifacts:
        raise RegistryIntegrityError("Registry manifest artifact set is incomplete or unexpected")
    actual_files = {
        str(path.relative_to(registry_dir))
        for path in registry_dir.rglob("*")
        if path.is_file()
    }
    if actual_files != expected_artifacts | {"registry_manifest.json"}:
        missing = sorted((expected_artifacts | {"registry_manifest.json"}) - actual_files)
        unexpected = sorted(actual_files - (expected_artifacts | {"registry_manifest.json"}))
        raise RegistryIntegrityError(f"Registry artifact set mismatch; missing={missing}, unexpected={unexpected}")

    artifact_bytes: dict[str, bytes] = {}
    aggregate = hashlib.sha256()
    for relative_path in sorted(expected_artifacts):
        content = (registry_dir / relative_path).read_bytes()
        artifact_bytes[relative_path] = content
        entry = entry_by_path[relative_path]
        if len(content) != entry["sizeBytes"]:
            raise RegistryIntegrityError(f"Registry artifact size mismatch: {relative_path}")
        if hashlib.sha256(content).hexdigest() != entry["sha256"]:
            raise RegistryIntegrityError(f"Registry artifact hash mismatch: {relative_path}")
        aggregate.update(relative_path.encode("utf-8"))
        aggregate.update(b"\0")
        aggregate.update(content)
    if aggregate.hexdigest() != manifest["registryAggregateHash"]:
        raise RegistryIntegrityError("Registry aggregate hash mismatch")

    for schema_name, expected_schema in schemas.items():
        loaded_schema = _load_json(registry_dir / "schemas" / schema_name)
        if loaded_schema != expected_schema:
            raise RegistryIntegrityError(f"Generated schema differs from executable schema: {schema_name}")

    data = {
        "seasons": _load_json(registry_dir / "seasons.json"),
        "teams": _load_json(registry_dir / "teams.json"),
        "franchises": _load_json(registry_dir / "franchises.json"),
        "players": _load_players(registry_dir / "players.jsonl"),
        "venues": _load_json(registry_dir / "venues.json"),
        "eras": _load_json(registry_dir / "eras.json"),
        "resolution_report": _load_json(registry_dir / "resolution_report.json"),
        "review_queue": _load_json(registry_dir / "review_queue.json"),
    }
    schema_instances = {
        "seasons.schema.json": data["seasons"],
        "teams.schema.json": data["teams"],
        "franchises.schema.json": data["franchises"],
        "venues.schema.json": data["venues"],
        "eras.schema.json": data["eras"],
        "resolution_report.schema.json": data["resolution_report"],
        "review_queue.schema.json": data["review_queue"],
    }
    try:
        for schema_name, instance in schema_instances.items():
            validate_instance(instance, schemas[schema_name])
        for index, player in enumerate(data["players"]):
            validate_instance(player, schemas["players.schema.json"], f"players[{index}]")
    except SchemaValidationError as error:
        raise RegistryIntegrityError(f"Registry artifact failed strict schema validation: {error}") from error
    _verify_envelopes(data, manifest)
    _validate_cross_file_invariants(data, manifest)
    return {**data, "manifest": manifest, "policy": policy}
