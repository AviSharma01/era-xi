from __future__ import annotations

import hashlib
import json
import os
import tempfile
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable

from scripts.cricsheet_audit.reporting import calculate_manifest_hash
from scripts.cricsheet_audit.scanner import ArchiveScan, scan_archive

from .schemas import SchemaValidationError, build_schema_documents, validate_instance


SCHEMA_VERSION = "1.0.0"
JSON_OUTPUT_NAMES = (
    "seasons.json",
    "teams.json",
    "franchises.json",
    "venues.json",
    "eras.json",
    "resolution_report.json",
    "review_queue.json",
)


class RegistryBuildError(ValueError):
    pass


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RegistryBuildError(f"Could not load JSON from {path}: {error}") from error


def pretty_json_bytes(value: Any) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n").encode("utf-8")


def compact_json_bytes(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")


def _without_envelope(report: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in report.items()
        if key not in {"schemaVersion", "reportType", "archiveManifestHash"}
    }


def _assert_unique(values: Iterable[str], label: str) -> None:
    values = list(values)
    duplicates = sorted({value for value in values if values.count(value) > 1})
    if duplicates:
        raise RegistryBuildError(f"Duplicate {label}: {duplicates}")


def _envelope(registry_version: str, manifest_hash: str, key: str, records: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "registryVersion": registry_version,
        "sourceArchiveManifestHash": manifest_hash,
        key: records,
    }


def _load_and_verify_archive(
    raw_dir: Path,
    audit_dir: Path,
    policy: dict[str, Any],
) -> tuple[ArchiveScan, str, dict[str, Any], dict[str, Any], dict[str, Any]]:
    manifest_metadata = load_json(audit_dir / "manifest_metadata.json")
    season_report = load_json(audit_dir / "season_coverage.json")
    identity_report = load_json(audit_dir / "participant_identity_observations.json")
    inventory_report = load_json(audit_dir / "raw_name_inventories.json")

    expected_hashes = {
        policy.get("acceptedArchiveManifestHash"),
        manifest_metadata.get("archiveManifestHash"),
        season_report.get("archiveManifestHash"),
        identity_report.get("archiveManifestHash"),
        inventory_report.get("archiveManifestHash"),
    }
    if len(expected_hashes) != 1 or None in expected_hashes:
        raise RegistryBuildError(f"Stage 1 manifest hash disagreement: {sorted(str(value) for value in expected_hashes)}")
    expected_hash = next(iter(expected_hashes))

    scan = scan_archive(raw_dir)
    actual_hash = calculate_manifest_hash(scan.manifest_entries)
    if actual_hash != expected_hash:
        raise RegistryBuildError(
            f"Archive manifest drift: expected {expected_hash}, recomputed {actual_hash}"
        )

    if list(scan.season_coverage.values()) != season_report.get("seasons"):
        raise RegistryBuildError("Recomputed season coverage differs from the committed Stage 1 report")
    if scan.identity != _without_envelope(identity_report):
        raise RegistryBuildError("Recomputed participant identities differ from the committed Stage 1 report")
    if scan.inventories != _without_envelope(inventory_report):
        raise RegistryBuildError("Recomputed raw identity inventories differ from the committed Stage 1 report")
    return scan, actual_hash, season_report, identity_report, inventory_report


def _season_maps(
    manual_seasons: list[dict[str, Any]],
    manual_eras: list[dict[str, Any]],
    season_report: dict[str, Any],
    manifest_hash: str,
) -> tuple[list[dict[str, Any]], dict[str, str], dict[str, int]]:
    _assert_unique((row["seasonId"] for row in manual_seasons), "season IDs")
    _assert_unique((alias for row in manual_seasons for alias in row["sourceSeasons"]), "source seasons")
    source_to_manual = {
        source: row
        for row in manual_seasons
        for source in row["sourceSeasons"]
    }
    audited = {row["sourceSeason"]: row for row in season_report["seasons"]}
    if set(source_to_manual) != set(audited):
        raise RegistryBuildError(
            f"Season overlay coverage mismatch; missing={sorted(set(audited) - set(source_to_manual))}, "
            f"unexpected={sorted(set(source_to_manual) - set(audited))}"
        )
    era_by_season: dict[str, list[str]] = defaultdict(list)
    for era in manual_eras:
        for season_id in era["seasonIds"]:
            era_by_season[season_id].append(era["eraId"])
    if set(era_by_season) != {row["seasonId"] for row in manual_seasons}:
        raise RegistryBuildError("Era definitions must cover every canonical season exactly once")
    if any(len(values) != 1 for values in era_by_season.values()):
        raise RegistryBuildError("A season cannot belong to multiple Stage 2 eras")

    records = []
    for edition_order, manual in enumerate(manual_seasons, start=1):
        if len(manual["sourceSeasons"]) != 1:
            raise RegistryBuildError(f"Stage 2 expects one exact source value for {manual['seasonId']}")
        source = manual["sourceSeasons"][0]
        evidence = audited[source]
        if manual["displayYear"] != evidence["inferredEditionDisplayYear"]:
            raise RegistryBuildError(f"Display year mismatch for {source}")
        records.append(
            {
                "seasonId": manual["seasonId"],
                "displayYear": manual["displayYear"],
                "sourceSeasons": list(manual["sourceSeasons"]),
                "startDate": evidence["dateRange"]["first"],
                "endDate": evidence["dateRange"]["last"],
                "editionOrder": edition_order,
                "archiveCoverageStatus": "accepted_baseline",
                "sourceArchiveManifestHash": manifest_hash,
                "eraIds": sorted(era_by_season[manual["seasonId"]]),
                "notes": list(manual["notes"]),
                "status": "canonical",
            }
        )
    source_to_id = {
        source: row["seasonId"]
        for row in records
        for source in row["sourceSeasons"]
    }
    order_by_id = {row["seasonId"]: row["editionOrder"] for row in records}
    return records, source_to_id, order_by_id


def _build_teams_and_franchises(
    manual: dict[str, Any],
    season_report: dict[str, Any],
    source_to_season_id: dict[str, str],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[tuple[str, str], dict[str, str]]]:
    teams = manual["teams"]
    franchises = manual["franchises"]
    team_ids = {row["teamId"] for row in teams}
    franchise_ids = {row["franchiseId"] for row in franchises}
    _assert_unique((row["teamId"] for row in teams), "team IDs")
    _assert_unique((row["franchiseId"] for row in franchises), "franchise IDs")
    for team in teams:
        if team["franchiseId"] not in franchise_ids:
            raise RegistryBuildError(f"Unknown franchise {team['franchiseId']} for {team['teamId']}")
        for relationship in team["relationships"]:
            if relationship["relatedTeamId"] not in team_ids:
                raise RegistryBuildError(f"Unknown related team in {team['teamId']}: {relationship}")
    for franchise in franchises:
        for relationship in franchise["relationships"]:
            if relationship["relatedFranchiseId"] not in franchise_ids:
                raise RegistryBuildError(f"Unknown related franchise in {franchise['franchiseId']}: {relationship}")

    observed_pairs = {
        (team_name, source_to_season_id[season["sourceSeason"]])
        for season in season_report["seasons"]
        for team_name in season["rawTeamNames"]
    }
    alias_pairs: dict[tuple[str, str], dict[str, str]] = {}
    for team in teams:
        for alias in team["sourceAliases"]:
            for season_id in alias["seasonIds"]:
                key = (alias["sourceTeamName"], season_id)
                if key in alias_pairs:
                    raise RegistryBuildError(f"Ambiguous team alias-season pair: {key}")
                alias_pairs[key] = {"teamId": team["teamId"], "franchiseId": team["franchiseId"]}
    if set(alias_pairs) != observed_pairs:
        raise RegistryBuildError(
            f"Team observation coverage mismatch; missing={sorted(observed_pairs - set(alias_pairs))}, "
            f"unexpected={sorted(set(alias_pairs) - observed_pairs)}"
        )

    team_records = []
    for team in sorted(teams, key=lambda item: item["teamId"]):
        active = sorted(
            {season_id for alias in team["sourceAliases"] for season_id in alias["seasonIds"]}
        )
        team_records.append({**team, "activeSeasonIds": active, "status": "canonical"})

    franchise_records = []
    for franchise in sorted(franchises, key=lambda item: item["franchiseId"]):
        members = [team for team in team_records if team["franchiseId"] == franchise["franchiseId"]]
        franchise_records.append(
            {
                **franchise,
                "activeSeasonIds": sorted({season for team in members for season in team["activeSeasonIds"]}),
                "teamIds": sorted(team["teamId"] for team in members),
                "status": "canonical",
            }
        )
    return team_records, franchise_records, alias_pairs


def _player_alias_evidence(
    raw_dir: Path,
    manifest_entries: list[dict[str, Any]],
    source_to_season_id: dict[str, str],
) -> dict[str, dict[str, list[dict[str, str]]]]:
    evidence: dict[str, dict[str, list[dict[str, str]]]] = defaultdict(lambda: defaultdict(list))
    for entry in manifest_entries:
        source_path = entry["relativeSourcePath"]
        data = load_json(raw_dir / source_path)
        info = data["info"]
        registry = info["registry"]["people"]
        season_id = source_to_season_id[str(info["season"])]
        for names in info["players"].values():
            for name in names:
                player_id = registry[name]
                evidence[player_id][name].append(
                    {
                        "matchId": entry["matchId"],
                        "seasonId": season_id,
                        "sourcePath": source_path,
                    }
                )
    return evidence


def _build_players(
    raw_dir: Path,
    manifest_entries: list[dict[str, Any]],
    identity_report: dict[str, Any],
    manual_players: dict[str, Any],
    source_to_season_id: dict[str, str],
    season_order: dict[str, int],
    manifest_hash: str,
    registry_version: str,
    legacy_metadata_path: Path,
    legacy_metadata_config: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    official_rows = {row["playerId"]: row for row in identity_report["playerRegistryIds"]}
    event_rows: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in identity_report["deliveryParticipantsAbsentFromOfficialLists"]:
        event_rows[row["playerId"]].append(row)
    player_ids = sorted(set(official_rows) | set(event_rows))
    official_evidence = _player_alias_evidence(raw_dir, manifest_entries, source_to_season_id)
    if set(official_evidence) != set(official_rows):
        raise RegistryBuildError("Raw official participant IDs differ from the committed identity audit")
    for player_id, row in official_rows.items():
        if set(official_evidence[player_id]) != set(row["displayNames"]):
            raise RegistryBuildError(f"Alias evidence differs from Stage 1 for {player_id}")

    overrides = manual_players["canonicalNameOverrides"]
    multi_name_ids = {
        player_id for player_id in player_ids
        if len(set(official_evidence.get(player_id, {})) | {row["displayName"] for row in event_rows[player_id]}) > 1
    }
    if set(overrides) != multi_name_ids:
        raise RegistryBuildError(
            f"Canonical-name overrides must exactly cover multi-name IDs; expected={sorted(multi_name_ids)}, "
            f"actual={sorted(overrides)}"
        )
    duplicate_reviews = manual_players["duplicateDisplayNameReviews"]
    duplicate_ids = {player_id for review in duplicate_reviews for player_id in review["playerIds"]}
    audited_duplicate_ids = {
        player_id
        for group in identity_report["displayNamesSharedByMultipleIds"]
        for player_id in group["playerIds"]
    }
    if duplicate_ids != audited_duplicate_ids:
        raise RegistryBuildError("Duplicate display-name overlay differs from the Stage 1 audit")

    legacy_rows = load_json(legacy_metadata_path)
    legacy_ids = {row["playerId"] for row in legacy_rows}
    if not legacy_ids <= set(player_ids):
        raise RegistryBuildError(f"Legacy metadata references unknown players: {sorted(legacy_ids - set(player_ids))}")

    manifest_by_path = {entry["relativeSourcePath"]: entry for entry in manifest_entries}
    records: list[dict[str, Any]] = []
    review_items: list[dict[str, Any]] = []
    for player_id in player_ids:
        alias_names = set(official_evidence.get(player_id, {})) | {
            row["displayName"] for row in event_rows[player_id]
        }
        canonical_name = overrides.get(player_id)
        if canonical_name is None:
            if len(alias_names) != 1:
                raise RegistryBuildError(f"Cannot choose canonical name without a reviewed override: {player_id}")
            canonical_name = next(iter(alias_names))
        if canonical_name not in alias_names:
            raise RegistryBuildError(f"Canonical name for {player_id} is not an observed alias")

        aliases = []
        observed_seasons: set[str] = set()
        for name in sorted(alias_names):
            official = sorted(
                official_evidence.get(player_id, {}).get(name, []),
                key=lambda item: (season_order[item["seasonId"]], int(item["matchId"]), item["sourcePath"]),
            )
            event = sorted(
                [
                    {
                        "category": row["category"],
                        "matchId": row["matchId"],
                        "seasonId": source_to_season_id[manifest_by_path[row["sourcePath"]]["sourceSeason"]],
                        "sourcePath": row["sourcePath"],
                    }
                    for row in event_rows[player_id]
                    if row["displayName"] == name
                ],
                key=lambda item: (season_order[item["seasonId"]], int(item["matchId"]), item["category"]),
            )
            observed_seasons.update(item["seasonId"] for item in official)
            observed_seasons.update(item["seasonId"] for item in event)
            aliases.append(
                {
                    "name": name,
                    "provenance": {
                        "officialParticipantObservations": official,
                        "eventObservationsOutsideOfficialLists": event,
                    },
                }
            )
        ordered_seasons = sorted(observed_seasons, key=season_order.__getitem__)
        participation_basis = "official_participant" if player_id in official_rows else "event_only"
        review_status = "review_required" if participation_basis == "event_only" or player_id in duplicate_ids else "approved"
        notes = []
        if player_id in duplicate_ids:
            notes.append("Another canonical player identity has the same display name.")
        if participation_basis == "event_only":
            notes.append("Identity is canonical; participation evidence is limited to events outside official participant lists.")
            review_items.append(
                {
                    "itemId": f"player-event-only-{player_id}",
                    "category": "event_only_player_participation",
                    "entityId": player_id,
                    "reviewStatus": "review_required",
                    "details": {
                        "canonicalDisplayName": canonical_name,
                        "eventObservations": sum(
                            len(alias["provenance"]["eventObservationsOutsideOfficialLists"])
                            for alias in aliases
                        ),
                    },
                }
            )
        metadata_refs = []
        if player_id in legacy_ids:
            metadata_refs.append(
                {
                    "overlayId": legacy_metadata_config["overlayId"],
                    "path": legacy_metadata_config["path"],
                    "playerId": player_id,
                    "confidence": legacy_metadata_config["confidence"],
                    "supportedFields": legacy_metadata_config["supportedFields"],
                }
            )
        records.append(
            {
                "schemaVersion": SCHEMA_VERSION,
                "registryVersion": registry_version,
                "sourceArchiveManifestHash": manifest_hash,
                "playerId": player_id,
                "canonicalDisplayName": canonical_name,
                "observedAliases": aliases,
                "firstObservedSeasonId": ordered_seasons[0],
                "lastObservedSeasonId": ordered_seasons[-1],
                "participationBasis": participation_basis,
                "identityStatus": "canonical",
                "reviewStatus": review_status,
                "duplicateDisplayName": player_id in duplicate_ids,
                "metadataOverlayRefs": metadata_refs,
                "notes": notes,
            }
        )

    for review in duplicate_reviews:
        review_items.append(
            {
                "itemId": "player-duplicate-display-name-" + "-".join(review["playerIds"]),
                "category": "duplicate_player_display_name",
                "entityIds": review["playerIds"],
                "reviewStatus": review["reviewStatus"],
                "details": {"displayName": review["displayName"], "notes": review["notes"]},
            }
        )
    return records, review_items


def _build_venues(
    manual_venues: list[dict[str, Any]],
    manifest_entries: list[dict[str, Any]],
    source_to_season_id: dict[str, str],
    season_order: dict[str, int],
    inventory_report: dict[str, Any],
) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]], list[dict[str, Any]]]:
    _assert_unique((row["venueId"] for row in manual_venues), "venue IDs")
    _assert_unique((alias for row in manual_venues for alias in row["sourceAliases"]), "venue source aliases")
    audited_aliases = {row["value"] for row in inventory_report["venues"]}
    manual_aliases = {alias for row in manual_venues for alias in row["sourceAliases"]}
    if manual_aliases != audited_aliases:
        raise RegistryBuildError(
            f"Venue overlay coverage mismatch; missing={sorted(audited_aliases - manual_aliases)}, "
            f"unexpected={sorted(manual_aliases - audited_aliases)}"
        )
    venue_ids = {row["venueId"] for row in manual_venues}
    for venue in manual_venues:
        for relationship in venue["relationships"]:
            if relationship["relatedVenueId"] not in venue_ids:
                raise RegistryBuildError(f"Unknown related venue in {venue['venueId']}: {relationship}")

    evidence: dict[str, dict[str, Any]] = defaultdict(
        lambda: {"cities": set(), "missingCity": False, "seasonIds": set(), "matchIds": set(), "sourcePaths": set()}
    )
    for entry in manifest_entries:
        item = evidence[entry["venue"]]
        if entry["city"] is None:
            item["missingCity"] = True
        else:
            item["cities"].add(entry["city"])
        item["seasonIds"].add(source_to_season_id[entry["sourceSeason"]])
        item["matchIds"].add(entry["matchId"])
        item["sourcePaths"].add(entry["relativeSourcePath"])

    alias_index: dict[str, dict[str, Any]] = {}
    review_items: list[dict[str, Any]] = []
    records = []
    for manual in sorted(manual_venues, key=lambda item: item["venueId"]):
        rendered_aliases = []
        all_seasons: set[str] = set()
        all_match_ids: set[str] = set()
        for alias in sorted(manual["sourceAliases"]):
            detail = evidence[alias]
            season_ids = sorted(detail["seasonIds"], key=season_order.__getitem__)
            match_ids = sorted(detail["matchIds"], key=int)
            rendered = {
                "sourceVenue": alias,
                "observedCities": sorted(detail["cities"]),
                "hasMissingCityObservations": detail["missingCity"],
                "seasonIds": season_ids,
                "sourceMatchIds": match_ids,
                "sourcePaths": sorted(detail["sourcePaths"], key=lambda value: int(Path(value).stem)),
            }
            rendered_aliases.append(rendered)
            all_seasons.update(season_ids)
            all_match_ids.update(match_ids)
            alias_index[alias] = {
                "venueId": manual["venueId"],
                "venueSiteId": manual["venueSiteId"],
                "status": manual["status"],
                "reviewStatus": manual["reviewStatus"],
                "alias": rendered,
            }
        record = {
            **{key: value for key, value in manual.items() if key != "sourceAliases"},
            "sourceAliases": rendered_aliases,
            "activeSeasonIds": sorted(all_seasons, key=season_order.__getitem__),
            "sourceMatchIds": sorted(all_match_ids, key=int),
        }
        records.append(record)
        if manual["status"] == "provisional" or manual["reviewStatus"] == "review_required":
            review_items.append(
                {
                    "itemId": f"venue-{manual['venueId']}",
                    "category": "provisional_venue_mapping",
                    "entityId": manual["venueId"],
                    "reviewStatus": manual["reviewStatus"],
                    "details": {"sourceAliases": sorted(manual["sourceAliases"]), "notes": manual["notes"]},
                }
            )
    return records, alias_index, review_items


def _build_resolution_report(
    registry_version: str,
    manifest_hash: str,
    season_report: dict[str, Any],
    identity_report: dict[str, Any],
    manifest_entries: list[dict[str, Any]],
    source_to_season_id: dict[str, str],
    team_alias_pairs: dict[tuple[str, str], dict[str, str]],
    players: list[dict[str, Any]],
    venue_alias_index: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    season_observations = [
        {
            "sourceSeason": row["sourceSeason"],
            "seasonId": source_to_season_id[row["sourceSeason"]],
            "status": "canonical",
            "matchedBy": "exact_source_season",
        }
        for row in season_report["seasons"]
    ]
    team_observations = []
    for season in season_report["seasons"]:
        season_id = source_to_season_id[season["sourceSeason"]]
        for source_name in season["rawTeamNames"]:
            ids = team_alias_pairs[(source_name, season_id)]
            team_observations.append(
                {
                    "sourceTeamName": source_name,
                    "seasonId": season_id,
                    **ids,
                    "status": "canonical",
                    "matchedBy": "exact_source_team_alias_and_season",
                }
            )
    team_observations.sort(key=lambda item: (item["seasonId"], item["sourceTeamName"]))

    player_observations = []
    for player in players:
        for alias in player["observedAliases"]:
            official_count = len(alias["provenance"]["officialParticipantObservations"])
            event_count = len(alias["provenance"]["eventObservationsOutsideOfficialLists"])
            player_observations.append(
                {
                    "playerId": player["playerId"],
                    "observedName": alias["name"],
                    "officialParticipantObservations": official_count,
                    "eventObservationsOutsideOfficialLists": event_count,
                    "status": player["reviewStatus"] if player["reviewStatus"] == "review_required" else "canonical",
                    "matchedBy": "exact_player_id_and_alias",
                }
            )

    venue_observation_keys = sorted(
        {
            (entry["venue"], entry["city"], source_to_season_id[entry["sourceSeason"]])
            for entry in manifest_entries
        },
        key=lambda item: (item[2], item[0], item[1] or ""),
    )
    venue_observations = []
    for source_venue, city, season_id in venue_observation_keys:
        mapping = venue_alias_index[source_venue]
        status = mapping["status"]
        if mapping["reviewStatus"] == "review_required":
            status = "review_required"
        venue_observations.append(
            {
                "sourceVenue": source_venue,
                "city": city,
                "seasonId": season_id,
                "venueId": mapping["venueId"],
                "venueSiteId": mapping["venueSiteId"],
                "status": status,
                "matchedBy": "exact_source_venue_alias_with_observed_context",
            }
        )

    event_only_count = sum(1 for player in players if player["participationBasis"] == "event_only")
    return {
        "schemaVersion": SCHEMA_VERSION,
        "registryVersion": registry_version,
        "sourceArchiveManifestHash": manifest_hash,
        "summary": {
            "fatalResolutionErrors": 0,
            "archiveMatchObservationsResolved": len(manifest_entries),
            "seasonObservationsResolved": len(season_observations),
            "teamSeasonObservationsResolved": len(team_observations),
            "playerAliasObservationsResolved": len(player_observations),
            "officialParticipantPlayerIdsResolved": identity_report["uniquePlayerRegistryIds"],
            "eventOnlyPlayerIdsResolved": event_only_count,
            "eventObservationsOutsideOfficialListsResolved": identity_report[
                "deliveryParticipantsAbsentFromOfficialListsCount"
            ],
            "unresolvedRegistryReferences": identity_report["unresolvedRegistryReferenceCount"],
            "venueContextObservationsResolved": len(venue_observations),
            "rawVenueStringsResolved": len(venue_alias_index),
        },
        "seasonObservations": season_observations,
        "teamObservations": team_observations,
        "playerObservations": player_observations,
        "venueObservations": venue_observations,
    }


def _validate_generated_data(data: dict[str, Any]) -> None:
    required_envelopes = {
        "seasons": ("seasonId", "displayYear", "sourceSeasons", "archiveCoverageStatus"),
        "teams": ("teamId", "franchiseId", "sourceAliases", "activeSeasonIds"),
        "franchises": ("franchiseId", "teamIds", "activeSeasonIds"),
        "venues": ("venueId", "venueSiteId", "sourceAliases", "status", "reviewStatus"),
        "eras": ("eraId", "seasonIds", "status"),
    }
    for key, required in required_envelopes.items():
        envelope = data[key]
        if set(("schemaVersion", "registryVersion", "sourceArchiveManifestHash", key)) - set(envelope):
            raise RegistryBuildError(f"Invalid {key} envelope")
        for record in envelope[key]:
            missing = set(required) - set(record)
            if missing:
                raise RegistryBuildError(f"Invalid {key} record missing {sorted(missing)}: {record}")
    for player in data["players"]:
        required = {
            "playerId", "canonicalDisplayName", "observedAliases", "participationBasis",
            "identityStatus", "reviewStatus", "firstObservedSeasonId", "lastObservedSeasonId",
        }
        if required - set(player):
            raise RegistryBuildError(f"Invalid player record: {player}")
        if player["identityStatus"] != "canonical":
            raise RegistryBuildError(f"Player identity must be canonical: {player['playerId']}")
    if data["resolution_report"]["summary"]["fatalResolutionErrors"] != 0:
        raise RegistryBuildError("Resolution report contains fatal errors")


def build_registry_bytes(
    raw_dir: Path = Path("data/raw/cricsheet"),
    audit_dir: Path = Path("data/audit/cricsheet-ipl/v1"),
    manual_dir: Path = Path("data/manual/identity/v1"),
    legacy_metadata_path: Path = Path("data/manual/player_metadata_template.json"),
) -> dict[str, bytes]:
    policy = load_json(manual_dir / "registry_policy.json")
    manual_seasons = load_json(manual_dir / "seasons.json")
    manual_eras = load_json(manual_dir / "eras.json")
    manual_teams = load_json(manual_dir / "teams_and_franchises.json")
    manual_players = load_json(manual_dir / "players.json")
    manual_venues = load_json(manual_dir / "venues.json")
    registry_version = policy["registryVersion"]

    scan, manifest_hash, season_report, identity_report, inventory_report = _load_and_verify_archive(
        raw_dir, audit_dir, policy
    )
    seasons, source_to_season_id, season_order = _season_maps(
        manual_seasons, manual_eras, season_report, manifest_hash
    )
    teams, franchises, team_alias_pairs = _build_teams_and_franchises(
        manual_teams, season_report, source_to_season_id
    )
    players, player_review_items = _build_players(
        raw_dir,
        scan.manifest_entries,
        identity_report,
        manual_players,
        source_to_season_id,
        season_order,
        manifest_hash,
        registry_version,
        legacy_metadata_path,
        policy["legacyMetadataOverlay"],
    )
    venues, venue_alias_index, venue_review_items = _build_venues(
        manual_venues,
        scan.manifest_entries,
        source_to_season_id,
        season_order,
        inventory_report,
    )
    eras = sorted(manual_eras, key=lambda item: item["seasonIds"][0])
    resolution_report = _build_resolution_report(
        registry_version,
        manifest_hash,
        season_report,
        identity_report,
        scan.manifest_entries,
        source_to_season_id,
        team_alias_pairs,
        players,
        venue_alias_index,
    )
    review_items = sorted(
        player_review_items + venue_review_items,
        key=lambda item: (item["category"], item["itemId"]),
    )
    review_queue = {
        "schemaVersion": SCHEMA_VERSION,
        "registryVersion": registry_version,
        "sourceArchiveManifestHash": manifest_hash,
        "items": review_items,
    }
    data = {
        "seasons": _envelope(registry_version, manifest_hash, "seasons", seasons),
        "teams": _envelope(registry_version, manifest_hash, "teams", teams),
        "franchises": _envelope(registry_version, manifest_hash, "franchises", franchises),
        "players": players,
        "venues": _envelope(registry_version, manifest_hash, "venues", venues),
        "eras": _envelope(registry_version, manifest_hash, "eras", eras),
        "resolution_report": resolution_report,
        "review_queue": review_queue,
    }
    _validate_generated_data(data)

    schemas = build_schema_documents()
    schema_instances = {
        "seasons.schema.json": data["seasons"],
        "teams.schema.json": data["teams"],
        "franchises.schema.json": data["franchises"],
        "venues.schema.json": data["venues"],
        "eras.schema.json": data["eras"],
        "resolution_report.schema.json": resolution_report,
        "review_queue.schema.json": review_queue,
    }
    try:
        for schema_name, instance in schema_instances.items():
            validate_instance(instance, schemas[schema_name])
        for index, player in enumerate(players):
            validate_instance(player, schemas["players.schema.json"], f"players[{index}]")
    except SchemaValidationError as error:
        raise RegistryBuildError(f"Generated registry schema validation failed: {error}") from error

    outputs = {
        "seasons.json": pretty_json_bytes(data["seasons"]),
        "teams.json": pretty_json_bytes(data["teams"]),
        "franchises.json": pretty_json_bytes(data["franchises"]),
        "players.jsonl": b"".join(compact_json_bytes(row) for row in players),
        "venues.json": pretty_json_bytes(data["venues"]),
        "eras.json": pretty_json_bytes(data["eras"]),
        "resolution_report.json": pretty_json_bytes(resolution_report),
        "review_queue.json": pretty_json_bytes(review_queue),
    }
    for name, schema in schemas.items():
        outputs[f"schemas/{name}"] = pretty_json_bytes(schema)

    generated_files = [
        {"path": name, "sha256": hashlib.sha256(content).hexdigest(), "sizeBytes": len(content)}
        for name, content in sorted(outputs.items())
    ]
    aggregate = hashlib.sha256()
    for name, content in sorted(outputs.items()):
        aggregate.update(name.encode("utf-8"))
        aggregate.update(b"\0")
        aggregate.update(content)
    manifest = {
        "schemaVersion": SCHEMA_VERSION,
        "registryVersion": registry_version,
        "sourceArchiveManifestHash": manifest_hash,
        "counts": {
            "seasons": len(seasons),
            "rawTeamNames": inventory_report["uniqueRawTeamNames"],
            "teams": len(teams),
            "franchises": len(franchises),
            "officialParticipantPlayerIds": identity_report["uniquePlayerRegistryIds"],
            "eventOnlyPlayerIds": sum(1 for player in players if player["participationBasis"] == "event_only"),
            "players": len(players),
            "rawVenueStrings": inventory_report["uniqueRawVenueStrings"],
            "venueVersions": len(venues),
            "venueSites": len({venue["venueSiteId"] for venue in venues}),
            "eras": len(eras),
            "reviewQueueItems": len(review_items),
        },
        "generatedFiles": generated_files,
        "registryAggregateHash": aggregate.hexdigest(),
    }
    try:
        validate_instance(manifest, schemas["registry_manifest.schema.json"])
    except SchemaValidationError as error:
        raise RegistryBuildError(f"Generated manifest schema validation failed: {error}") from error
    outputs["registry_manifest.json"] = pretty_json_bytes(manifest)
    return outputs


def _atomic_write(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(descriptor, "wb") as temporary_file:
            temporary_file.write(content)
            temporary_file.flush()
            os.fsync(temporary_file.fileno())
        os.replace(temporary_name, path)
    except BaseException:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def generate_registries(
    output_dir: Path = Path("data/registries/ipl/v1"),
    **build_args: Any,
) -> dict[str, bytes]:
    outputs = build_registry_bytes(**build_args)
    for relative_path, content in sorted(outputs.items()):
        _atomic_write(output_dir / relative_path, content)
    return outputs
