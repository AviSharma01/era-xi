from __future__ import annotations

import json
import re
from typing import Any


SCHEMA_DRAFT = "https://json-schema.org/draft/2020-12/schema"
REGISTRY_DOCUMENT_FILES = (
    "eras.json",
    "franchises.json",
    "players.jsonl",
    "resolution_report.json",
    "review_queue.json",
    "seasons.json",
    "teams.json",
    "venues.json",
)
SCHEMA_FILE_NAMES = (
    "eras.schema.json",
    "franchises.schema.json",
    "players.schema.json",
    "registry_manifest.schema.json",
    "resolution_report.schema.json",
    "review_queue.schema.json",
    "seasons.schema.json",
    "teams.schema.json",
    "venues.schema.json",
)
MANIFEST_ARTIFACT_PATHS = tuple(sorted(REGISTRY_DOCUMENT_FILES + tuple(f"schemas/{name}" for name in SCHEMA_FILE_NAMES)))


class SchemaValidationError(ValueError):
    pass


def _string(enum: list[str] | None = None, pattern: str | None = None) -> dict[str, Any]:
    schema: dict[str, Any] = {"type": "string", "minLength": 1}
    if enum is not None:
        schema["enum"] = enum
    if pattern is not None:
        schema["pattern"] = pattern
    return schema


def _nullable_string() -> dict[str, Any]:
    return {"type": ["string", "null"]}


def _integer() -> dict[str, Any]:
    return {"type": "integer", "minimum": 0}


def _array(items: dict[str, Any], *, min_items: int = 0, unique: bool = False) -> dict[str, Any]:
    schema: dict[str, Any] = {"type": "array", "items": items, "minItems": min_items}
    if unique:
        schema["uniqueItems"] = True
    return schema


def _object(required: list[str], properties: dict[str, Any], *, title: str | None = None) -> dict[str, Any]:
    schema: dict[str, Any] = {
        "type": "object",
        "additionalProperties": False,
        "required": required,
        "properties": properties,
    }
    if title is not None:
        schema["title"] = title
    return schema


def _record(title: str, required: list[str], properties: dict[str, Any]) -> dict[str, Any]:
    return {"$schema": SCHEMA_DRAFT, **_object(required, properties, title=title)}


def _envelope_schema(title: str, collection_key: str, item_schema: dict[str, Any]) -> dict[str, Any]:
    properties = {
        "schemaVersion": _string(),
        "registryVersion": _string(),
        "sourceArchiveManifestHash": _string(pattern=r"[0-9a-f]{64}"),
        collection_key: _array(item_schema),
    }
    return _record(title, list(properties), properties)


def _source_match_evidence(*, event: bool) -> dict[str, Any]:
    properties = {
        "matchId": _string(),
        "seasonId": _string(),
        "sourcePath": _string(pattern=r"[^/]+\.json"),
    }
    if event:
        properties["category"] = _string(["fielder"])
    return _object(list(properties), properties)


def build_schema_documents() -> dict[str, dict[str, Any]]:
    string_array = _array(_string(), unique=True)
    team_relationship = _object(
        ["relatedTeamId", "relationshipType"],
        {
            "relatedTeamId": _string(),
            "relationshipType": _string(["rename", "renamed_from", "competition_successor", "competition_predecessor"]),
        },
    )
    franchise_relationship = _object(
        ["relatedFranchiseId", "relationshipType"],
        {
            "relatedFranchiseId": _string(),
            "relationshipType": _string(["competition_successor", "competition_predecessor"]),
        },
    )
    venue_relationship = _object(
        ["relatedVenueId", "relationshipType"],
        {
            "relatedVenueId": _string(),
            "relationshipType": _string(["rebuilt_as", "rebuilt_from"]),
        },
    )
    team_alias = _object(
        ["sourceTeamName", "seasonIds"],
        {"sourceTeamName": _string(), "seasonIds": _array(_string(), min_items=1, unique=True)},
    )
    venue_alias = _object(
        ["sourceVenue", "observedCities", "hasMissingCityObservations", "seasonIds", "sourceMatchIds", "sourcePaths"],
        {
            "sourceVenue": _string(),
            "observedCities": string_array,
            "hasMissingCityObservations": {"type": "boolean"},
            "seasonIds": _array(_string(), min_items=1, unique=True),
            "sourceMatchIds": _array(_string(), min_items=1, unique=True),
            "sourcePaths": _array(_string(pattern=r"[^/]+\.json"), min_items=1, unique=True),
        },
    )
    official_evidence = _source_match_evidence(event=False)
    event_evidence = _source_match_evidence(event=True)
    provenance = _object(
        ["officialParticipantObservations", "eventObservationsOutsideOfficialLists"],
        {
            "officialParticipantObservations": _array(official_evidence),
            "eventObservationsOutsideOfficialLists": _array(event_evidence),
        },
    )
    observed_alias = _object(
        ["name", "provenance"],
        {"name": _string(), "provenance": provenance},
    )
    metadata_reference = _object(
        ["overlayId", "path", "playerId", "confidence", "supportedFields"],
        {
            "overlayId": _string(),
            "path": _string(),
            "playerId": _string(),
            "confidence": _string(),
            "supportedFields": _array(
                _string(["country", "isOverseas", "isWicketkeeper", "battingHand", "bowlingStyle"]),
                min_items=1,
                unique=True,
            ),
        },
    )

    season = _object(
        [
            "seasonId", "displayYear", "sourceSeasons", "startDate", "endDate",
            "editionOrder", "archiveCoverageStatus", "sourceArchiveManifestHash",
            "eraIds", "notes", "status",
        ],
        {
            "seasonId": _string(), "displayYear": _integer(),
            "sourceSeasons": _array(_string(), min_items=1, unique=True),
            "startDate": _string(pattern=r"\d{4}-\d{2}-\d{2}"),
            "endDate": _string(pattern=r"\d{4}-\d{2}-\d{2}"),
            "editionOrder": {"type": "integer", "minimum": 1},
            "archiveCoverageStatus": _string(["accepted_baseline"]),
            "sourceArchiveManifestHash": _string(pattern=r"[0-9a-f]{64}"),
            "eraIds": _array(_string(), min_items=1, unique=True),
            "notes": string_array,
            "status": _string(["canonical"]),
        },
    )
    team = _object(
        ["teamId", "canonicalName", "franchiseId", "sourceAliases", "activeSeasonIds", "relationships", "status"],
        {
            "teamId": _string(), "canonicalName": _string(), "franchiseId": _string(),
            "sourceAliases": _array(team_alias, min_items=1),
            "activeSeasonIds": _array(_string(), min_items=1, unique=True),
            "relationships": _array(team_relationship), "status": _string(["canonical"]),
        },
    )
    franchise = _object(
        ["franchiseId", "canonicalName", "activeSeasonIds", "teamIds", "relationships", "status"],
        {
            "franchiseId": _string(), "canonicalName": _string(),
            "activeSeasonIds": _array(_string(), min_items=1, unique=True),
            "teamIds": _array(_string(), min_items=1, unique=True),
            "relationships": _array(franchise_relationship), "status": _string(["canonical"]),
        },
    )
    player = _record(
        "Canonical IPL player JSONL row",
        [
            "schemaVersion", "registryVersion", "sourceArchiveManifestHash", "playerId",
            "canonicalDisplayName", "observedAliases", "firstObservedSeasonId",
            "lastObservedSeasonId", "participationBasis", "identityStatus", "reviewStatus",
            "duplicateDisplayName", "metadataOverlayRefs", "notes",
        ],
        {
            "schemaVersion": _string(), "registryVersion": _string(),
            "sourceArchiveManifestHash": _string(pattern=r"[0-9a-f]{64}"), "playerId": _string(),
            "canonicalDisplayName": _string(), "observedAliases": _array(observed_alias, min_items=1),
            "firstObservedSeasonId": _string(), "lastObservedSeasonId": _string(),
            "participationBasis": _string(["official_participant", "event_only"]),
            "identityStatus": _string(["canonical"]),
            "reviewStatus": _string(["approved", "review_required"]),
            "duplicateDisplayName": {"type": "boolean"},
            "metadataOverlayRefs": _array(metadata_reference), "notes": string_array,
        },
    )
    venue = _object(
        [
            "venueId", "venueSiteId", "canonicalName", "canonicalCity", "country",
            "sourceAliases", "activeSeasonIds", "sourceMatchIds", "status", "reviewStatus",
            "relationships", "notes",
        ],
        {
            "venueId": _string(), "venueSiteId": _string(), "canonicalName": _string(),
            "canonicalCity": _string(), "country": _string(),
            "sourceAliases": _array(venue_alias, min_items=1),
            "activeSeasonIds": _array(_string(), min_items=1, unique=True),
            "sourceMatchIds": _array(_string(), min_items=1, unique=True),
            "status": _string(["canonical", "provisional"]),
            "reviewStatus": _string(["approved", "review_required"]),
            "relationships": _array(venue_relationship), "notes": string_array,
        },
    )
    era = _object(
        ["eraId", "label", "seasonIds", "status", "description", "notes"],
        {
            "eraId": _string(), "label": _string(),
            "seasonIds": _array(_string(), min_items=1, unique=True),
            "status": _string(["provisional", "approved"]), "description": _string(),
            "notes": string_array,
        },
    )

    report_summary_properties = {
        "fatalResolutionErrors": _integer(),
        "archiveMatchObservationsResolved": _integer(),
        "seasonObservationsResolved": _integer(),
        "teamSeasonObservationsResolved": _integer(),
        "playerAliasObservationsResolved": _integer(),
        "officialParticipantPlayerIdsResolved": _integer(),
        "eventOnlyPlayerIdsResolved": _integer(),
        "eventObservationsOutsideOfficialListsResolved": _integer(),
        "unresolvedRegistryReferences": _integer(),
        "venueContextObservationsResolved": _integer(),
        "rawVenueStringsResolved": _integer(),
    }
    season_observation = _object(
        ["sourceSeason", "seasonId", "status", "matchedBy"],
        {
            "sourceSeason": _string(), "seasonId": _string(), "status": _string(["canonical"]),
            "matchedBy": _string(["exact_source_season"]),
        },
    )
    team_observation = _object(
        ["sourceTeamName", "seasonId", "teamId", "franchiseId", "status", "matchedBy"],
        {
            "sourceTeamName": _string(), "seasonId": _string(), "teamId": _string(),
            "franchiseId": _string(), "status": _string(["canonical"]),
            "matchedBy": _string(["exact_source_team_alias_and_season"]),
        },
    )
    player_observation = _object(
        [
            "playerId", "observedName", "officialParticipantObservations",
            "eventObservationsOutsideOfficialLists", "status", "matchedBy",
        ],
        {
            "playerId": _string(), "observedName": _string(),
            "officialParticipantObservations": _integer(),
            "eventObservationsOutsideOfficialLists": _integer(),
            "status": _string(["canonical", "review_required"]),
            "matchedBy": _string(["exact_player_id_and_alias"]),
        },
    )
    venue_observation = _object(
        ["sourceVenue", "city", "seasonId", "venueId", "venueSiteId", "status", "matchedBy"],
        {
            "sourceVenue": _string(), "city": _nullable_string(), "seasonId": _string(),
            "venueId": _string(), "venueSiteId": _string(),
            "status": _string(["canonical", "provisional", "review_required"]),
            "matchedBy": _string(["exact_source_venue_alias_with_observed_context"]),
        },
    )
    report = _record(
        "Identity resolution coverage report",
        [
            "schemaVersion", "registryVersion", "sourceArchiveManifestHash", "summary",
            "seasonObservations", "teamObservations", "playerObservations", "venueObservations",
        ],
        {
            "schemaVersion": _string(), "registryVersion": _string(),
            "sourceArchiveManifestHash": _string(pattern=r"[0-9a-f]{64}"),
            "summary": _object(list(report_summary_properties), report_summary_properties),
            "seasonObservations": _array(season_observation),
            "teamObservations": _array(team_observation),
            "playerObservations": _array(player_observation),
            "venueObservations": _array(venue_observation),
        },
    )

    duplicate_review = _object(
        ["itemId", "category", "entityIds", "reviewStatus", "details"],
        {
            "itemId": _string(), "category": {"const": "duplicate_player_display_name"},
            "entityIds": _array(_string(), min_items=2, unique=True),
            "reviewStatus": _string(["review_required"]),
            "details": _object(
                ["displayName", "notes"], {"displayName": _string(), "notes": _string()}
            ),
        },
    )
    event_only_review = _object(
        ["itemId", "category", "entityId", "reviewStatus", "details"],
        {
            "itemId": _string(), "category": {"const": "event_only_player_participation"},
            "entityId": _string(), "reviewStatus": _string(["review_required"]),
            "details": _object(
                ["canonicalDisplayName", "eventObservations"],
                {"canonicalDisplayName": _string(), "eventObservations": {"type": "integer", "minimum": 1}},
            ),
        },
    )
    venue_review = _object(
        ["itemId", "category", "entityId", "reviewStatus", "details"],
        {
            "itemId": _string(), "category": {"const": "provisional_venue_mapping"},
            "entityId": _string(), "reviewStatus": _string(["review_required"]),
            "details": _object(
                ["sourceAliases", "notes"],
                {"sourceAliases": _array(_string(), min_items=1, unique=True), "notes": string_array},
            ),
        },
    )
    review_item = {"oneOf": [duplicate_review, event_only_review, venue_review]}
    queue = _record(
        "Identity review queue",
        ["schemaVersion", "registryVersion", "sourceArchiveManifestHash", "items"],
        {
            "schemaVersion": _string(), "registryVersion": _string(),
            "sourceArchiveManifestHash": _string(pattern=r"[0-9a-f]{64}"),
            "items": _array(review_item),
        },
    )

    count_properties = {
        "seasons": _integer(), "rawTeamNames": _integer(), "teams": _integer(),
        "franchises": _integer(), "officialParticipantPlayerIds": _integer(),
        "eventOnlyPlayerIds": _integer(), "players": _integer(), "rawVenueStrings": _integer(),
        "venueVersions": _integer(), "venueSites": _integer(), "eras": _integer(),
        "reviewQueueItems": _integer(),
    }
    manifest_entry = _object(
        ["path", "sha256", "sizeBytes"],
        {
            "path": _string(list(MANIFEST_ARTIFACT_PATHS)),
            "sha256": _string(pattern=r"[0-9a-f]{64}"),
            "sizeBytes": _integer(),
        },
    )
    manifest = _record(
        "Identity registry manifest",
        [
            "schemaVersion", "registryVersion", "sourceArchiveManifestHash", "counts",
            "generatedFiles", "registryAggregateHash",
        ],
        {
            "schemaVersion": _string(), "registryVersion": _string(),
            "sourceArchiveManifestHash": _string(pattern=r"[0-9a-f]{64}"),
            "counts": _object(list(count_properties), count_properties),
            "generatedFiles": {
                **_array(manifest_entry, min_items=len(MANIFEST_ARTIFACT_PATHS), unique=True),
                "maxItems": len(MANIFEST_ARTIFACT_PATHS),
            },
            "registryAggregateHash": _string(pattern=r"[0-9a-f]{64}"),
        },
    )
    return {
        "eras.schema.json": _envelope_schema("IPL eras registry", "eras", era),
        "franchises.schema.json": _envelope_schema("IPL franchises registry", "franchises", franchise),
        "players.schema.json": player,
        "registry_manifest.schema.json": manifest,
        "resolution_report.schema.json": report,
        "review_queue.schema.json": queue,
        "seasons.schema.json": _envelope_schema("IPL seasons registry", "seasons", season),
        "teams.schema.json": _envelope_schema("IPL teams registry", "teams", team),
        "venues.schema.json": _envelope_schema("IPL venues registry", "venues", venue),
    }


def _resolution_common(source: dict[str, Any], evidence: dict[str, Any], extra: dict[str, Any]) -> dict[str, Any]:
    properties = {
        "id": _string(),
        "status": _string(["canonical", "provisional", "review_required"]),
        "matchedBy": _string(),
        "source": source,
        "registryVersion": _string(),
        "registryReviewStatus": _string(["approved", "review_required"]),
        "requiresNewReview": {"type": "boolean"},
        "evidenceRefs": _array(evidence, min_items=1),
        "notes": _array(_string(), unique=True),
        "warnings": _array(_string(), unique=True),
        **extra,
    }
    return _object(list(properties), properties)


def build_resolution_result_schema() -> dict[str, Any]:
    source_alias_evidence = _object(
        ["registry", "recordId", "sourceAlias"],
        {"registry": _string(["seasons", "teams", "venues"]), "recordId": _string(), "sourceAlias": _string()},
    )
    player_evidence = _object(
        ["registry", "recordId"],
        {
            "registry": _string(["players"]), "recordId": _string(),
            "sourceAlias": _string(),
            "provenance": _object(
                ["officialParticipantObservations", "eventObservationsOutsideOfficialLists"],
                {
                    "officialParticipantObservations": _array(_source_match_evidence(event=False)),
                    "eventObservationsOutsideOfficialLists": _array(_source_match_evidence(event=True)),
                },
            ),
        },
    )
    season = _resolution_common(
        _object(["sourceSeason"], {"sourceSeason": _string()}),
        source_alias_evidence,
        {},
    )
    team = _resolution_common(
        _object(["sourceTeamName", "seasonId"], {"sourceTeamName": _string(), "seasonId": _string()}),
        source_alias_evidence,
        {"teamId": _string(), "franchiseId": _string()},
    )
    player = _resolution_common(
        _object(["playerId", "observedName"], {"playerId": _string(), "observedName": _string()}),
        player_evidence,
        {"canonicalDisplayName": _string(), "participationBasis": _string(["official_participant", "event_only"])},
    )
    venue = _resolution_common(
        _object(
            ["sourceVenue", "city", "seasonId"],
            {"sourceVenue": _string(), "city": _nullable_string(), "seasonId": _string()},
        ),
        source_alias_evidence,
        {"venueId": _string(), "venueSiteId": _string()},
    )
    return {"$schema": SCHEMA_DRAFT, "title": "Identity resolver result", "oneOf": [season, team, player, venue]}


def build_resolution_error_schema() -> dict[str, Any]:
    source = {
        "oneOf": [
            _object(["sourceSeason"], {"sourceSeason": _string()}),
            _object(["sourceTeamName", "seasonId"], {"sourceTeamName": _string(), "seasonId": _string()}),
            _object(["playerId", "observedName"], {"playerId": _string(), "observedName": _string()}),
            _object(
                ["sourceVenue", "city", "seasonId"],
                {"sourceVenue": _string(), "city": _nullable_string(), "seasonId": _string()},
            ),
        ]
    }
    return _record(
        "Identity resolution error",
        ["code", "source", "message"],
        {
            "code": _string(
                [
                    "unknown_source_season", "unknown_season_id", "invalid_team_season",
                    "unknown_source_team", "unknown_player_id", "unknown_source_venue",
                ]
            ),
            "source": source,
            "message": _string(),
        },
    )


def validate_instance(instance: Any, schema: dict[str, Any], path: str = "$") -> None:
    if "oneOf" in schema:
        errors = []
        matches = 0
        for candidate in schema["oneOf"]:
            try:
                validate_instance(instance, candidate, path)
                matches += 1
            except SchemaValidationError as error:
                errors.append(str(error))
        if matches != 1:
            detail = errors[0] if errors else "multiple alternatives matched"
            raise SchemaValidationError(f"{path} must match exactly one allowed shape: {detail}")
        return

    expected_type = schema.get("type")
    type_checks = {
        "object": lambda value: isinstance(value, dict),
        "array": lambda value: isinstance(value, list),
        "string": lambda value: isinstance(value, str),
        "integer": lambda value: isinstance(value, int) and not isinstance(value, bool),
        "boolean": lambda value: isinstance(value, bool),
        "null": lambda value: value is None,
    }
    if isinstance(expected_type, list):
        if not any(type_checks[item](instance) for item in expected_type):
            raise SchemaValidationError(f"{path} must be one of the types {expected_type}")
    elif expected_type in type_checks and not type_checks[expected_type](instance):
        raise SchemaValidationError(f"{path} must be {expected_type}")
    if "const" in schema and instance != schema["const"]:
        raise SchemaValidationError(f"{path} must equal {schema['const']!r}")
    if "enum" in schema and instance not in schema["enum"]:
        raise SchemaValidationError(f"{path} must be one of {schema['enum']}, got {instance!r}")
    if isinstance(instance, str):
        if len(instance) < schema.get("minLength", 0):
            raise SchemaValidationError(f"{path} is shorter than minLength")
        if "pattern" in schema and re.fullmatch(schema["pattern"], instance) is None:
            raise SchemaValidationError(f"{path} does not match {schema['pattern']!r}")
    if isinstance(instance, int) and not isinstance(instance, bool) and instance < schema.get("minimum", instance):
        raise SchemaValidationError(f"{path} is below minimum {schema['minimum']}")
    if expected_type == "array":
        if len(instance) < schema.get("minItems", 0):
            raise SchemaValidationError(f"{path} has fewer than {schema['minItems']} items")
        if "maxItems" in schema and len(instance) > schema["maxItems"]:
            raise SchemaValidationError(f"{path} has more than {schema['maxItems']} items")
        if schema.get("uniqueItems"):
            rendered = [json.dumps(value, sort_keys=True, ensure_ascii=False) for value in instance]
            if len(rendered) != len(set(rendered)):
                raise SchemaValidationError(f"{path} contains duplicate items")
        for index, value in enumerate(instance):
            validate_instance(value, schema.get("items", {}), f"{path}[{index}]")
    if expected_type == "object":
        required = set(schema.get("required", []))
        missing = required - set(instance)
        if missing:
            raise SchemaValidationError(f"{path} is missing required fields {sorted(missing)}")
        properties = schema.get("properties", {})
        if schema.get("additionalProperties") is False:
            unexpected = set(instance) - set(properties)
            if unexpected:
                raise SchemaValidationError(f"{path} has unexpected fields {sorted(unexpected)}")
        for key, value in instance.items():
            if key in properties:
                validate_instance(value, properties[key], f"{path}.{key}")
