from __future__ import annotations

import hashlib
import json
import os
import tempfile
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable

from scripts.cricsheet_audit.reporting import canonical_json_bytes, pretty_json_bytes
from scripts.identity_registry.integrity import RegistryIntegrityError, load_verified_registry
from scripts.identity_registry.schemas import SchemaValidationError, validate_instance


METADATA_VERSION = "ipl-country-overseas-metadata/v1"
MANUAL_SCHEMA_VERSION = "ipl-country-overseas-manual/v3"
CATALOG_SCHEMA_VERSION = "ipl-cricket-nation-catalog/v1"
CATALOG_VERSION = "ipl-cricket-nations/v1"
SOURCE_SCHEMA_VERSION = "ipl-country-overseas-source/v2"
PLAYER_DEFAULT_SCHEMA_VERSION = "ipl-country-overseas-player-default/v3"
SEASON_OVERRIDE_SCHEMA_VERSION = "ipl-country-overseas-season-override/v3"
DISPOSITION_SCHEMA_VERSION = "ipl-country-overseas-review-disposition/v1"
PLAYER_ROW_SCHEMA_VERSION = "ipl-country-overseas-player-row/v3"
PTS_ROW_SCHEMA_VERSION = "ipl-country-overseas-pts-row/v3"
QUEUE_SCHEMA_VERSION = "ipl-country-overseas-review-queue/v1"
LEGACY_REPORT_SCHEMA_VERSION = "ipl-country-overseas-legacy-migration/v3"
MANIFEST_SCHEMA_VERSION = "ipl-country-overseas-manifest/v1"
VALIDATION_SCHEMA_VERSION = "ipl-country-overseas-validation/v2"

ROSTER_STATUSES = ["INDIAN", "OVERSEAS", "UNKNOWN"]
CLASSIFICATION_BASES = ["PLAYER_DEFAULT", "SEASON_OVERRIDE"]
RESOLUTION_METHODS = [
    "UNRESOLVED",
    "DIRECT_IPL_DESIGNATION",
    "POLICY_DERIVED",
    "MANUAL_REVIEW",
]
REVIEW_STATES = ["PENDING", "ROSTER_APPROVED_NATION_UNRESOLVED", "APPROVED"]

EXPECTED_BASELINES = {
    "canonicalPlayers": 816,
    "playerTeamSeasons": 3392,
    "g2Players": 727,
    "g2Profiles": 2992,
    "nonG2Players": 89,
    "legacyRows": 147,
}


class CountryOverseasMetadataError(ValueError):
    pass


def _sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _read_json(path: Path, label: str) -> tuple[bytes, Any]:
    try:
        content = path.read_bytes()
        return content, json.loads(content)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise CountryOverseasMetadataError(f"Could not read {label} at {path}: {error}") from error


def _read_jsonl(path: Path, label: str) -> tuple[bytes, list[dict[str, Any]]]:
    try:
        content = path.read_bytes()
        rows = [json.loads(line) for line in content.splitlines() if line]
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise CountryOverseasMetadataError(f"Could not read {label} at {path}: {error}") from error
    if not all(isinstance(row, dict) for row in rows):
        raise CountryOverseasMetadataError(f"{label} must contain JSON objects")
    return content, rows


def _jsonl_bytes(rows: Iterable[dict[str, Any]]) -> bytes:
    return b"".join(canonical_json_bytes(row) for row in rows)


def _string(*, enum: list[str] | None = None, pattern: str | None = None) -> dict[str, Any]:
    result: dict[str, Any] = {"type": "string", "minLength": 1}
    if enum is not None:
        result["enum"] = enum
    if pattern is not None:
        result["pattern"] = pattern
    return result


def _array(items: dict[str, Any], *, unique: bool = False, minimum: int = 0) -> dict[str, Any]:
    result: dict[str, Any] = {"type": "array", "items": items, "minItems": minimum}
    if unique:
        result["uniqueItems"] = True
    return result


def _object(properties: dict[str, Any], required: list[str] | None = None) -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "required": required or list(properties),
        "properties": properties,
    }


def _document(title: str, body: dict[str, Any]) -> dict[str, Any]:
    return {"$schema": "https://json-schema.org/draft/2020-12/schema", "title": title, **body}


def _assert_unique(values: Iterable[Any], label: str) -> None:
    seen: set[Any] = set()
    duplicates: set[Any] = set()
    for value in values:
        if value in seen:
            duplicates.add(value)
        seen.add(value)
    if duplicates:
        raise CountryOverseasMetadataError(f"Duplicate {label}: {sorted(duplicates)}")


def _artifact_entry(path: str, content: bytes, schema_version: str, rows: int | None) -> dict[str, Any]:
    return {
        "path": path,
        "sha256": _sha256(content),
        "sizeBytes": len(content),
        "rows": rows,
        "schemaVersion": schema_version,
    }


def _aggregate_hash(files: dict[str, bytes]) -> str:
    digest = hashlib.sha256()
    for path in sorted(files):
        digest.update(path.encode("utf-8"))
        digest.update(b"\0")
        digest.update(files[path])
    return digest.hexdigest()


def _id_set_hash(values: Iterable[str]) -> str:
    return _sha256(("\n".join(sorted(values)) + "\n").encode("utf-8"))


def build_schemas() -> dict[str, dict[str, Any]]:
    hash_string = _string(pattern=r"[0-9a-f]{64}")
    nullable_string = {"type": ["string", "null"]}
    integer = {"type": "integer", "minimum": 0}
    string_array = _array(_string(), unique=True)
    nullable_positive_integer = {"type": ["integer", "null"], "minimum": 1}
    evidence_locator = _object({
        "page": nullable_positive_integer,
        "section": nullable_string,
        "table": nullable_string,
        "row": nullable_string,
        "observedValue": nullable_string,
        "text": nullable_string,
    })
    season_scope = _object({
        "type": _string(enum=["SEASON"]),
        "seasonIds": _array(
            _string(pattern=r"ipl-[0-9]{4}"), unique=True, minimum=1
        ),
    })
    multi_season_scope = _object({
        "type": _string(enum=["MULTI_SEASON"]),
        "seasonIds": _array(
            _string(pattern=r"ipl-[0-9]{4}"), unique=True, minimum=2
        ),
    })
    player_default_scope = _object({
        "type": _string(enum=["PLAYER_DEFAULT"]),
        "screenedSeasonIds": _array(
            _string(pattern=r"ipl-[0-9]{4}"), unique=True, minimum=1
        ),
    })
    evidence_temporal_scope = {
        "oneOf": [season_scope, multi_season_scope, player_default_scope]
    }
    evidence_reference = _object({
        "sourceId": _string(pattern=r"[a-z0-9]+(?:[-:][a-z0-9]+)*"),
        "locator": evidence_locator,
        "temporalScope": evidence_temporal_scope,
    })
    evidence_array = _array(evidence_reference, unique=True)

    nation = _object({
        "cricketNationId": _string(pattern=r"[a-z0-9]+(?:-[a-z0-9]+)*"),
        "displayName": _string(),
        "aliases": string_array,
        "notes": string_array,
    })
    catalog = _object({
        "schemaVersion": _string(enum=[CATALOG_SCHEMA_VERSION]),
        "catalogVersion": _string(enum=[CATALOG_VERSION]),
        "nations": _array(nation, minimum=1),
    })
    source = _object({
        "sourceId": _string(pattern=r"[a-z0-9]+(?:[-:][a-z0-9]+)*"),
        "batchId": nullable_string,
        "sourceType": _string(enum=[
            "OFFICIAL_IPL",
            "OFFICIAL_CRICKET_BOARD",
            "SECONDARY_CRICKET_DATABASE",
            "INTERNAL_POLICY",
            "OTHER",
        ]),
        "publisher": _string(),
        "title": _string(),
        "url": nullable_string,
        "publicationDate": {"type": ["string", "null"], "pattern": r"\d{4}-\d{2}-\d{2}"},
        "accessedDate": {"type": ["string", "null"], "pattern": r"\d{4}-\d{2}-\d{2}"},
        "contentSha256": {"type": ["string", "null"], "pattern": r"[0-9a-f]{64}"},
        "locator": _string(),
        "supports": _array(_string(enum=["CRICKET_NATION", "IPL_ROSTER_STATUS"]), unique=True, minimum=1),
        "notes": nullable_string,
    })
    assertion_common = {
        "playerId": _string(),
        "cricketNationId": _string(),
        "iplRosterStatus": _string(enum=ROSTER_STATUSES),
        "nationResolutionMethod": _string(enum=RESOLUTION_METHODS),
        "rosterStatusResolutionMethod": _string(enum=RESOLUTION_METHODS),
        "cricketNationEvidenceRefs": evidence_array,
        "rosterStatusEvidenceRefs": evidence_array,
        "reviewStatus": _string(enum=["APPROVED"]),
        "notes": nullable_string,
    }
    default_promotion = _object({
        "screeningStatus": _string(enum=["FULL_COMMITTED_SPAN_SCREENED"]),
        "screenedSeasonIds": _array(
            _string(pattern=r"ipl-[0-9]{4}"), unique=True, minimum=1
        ),
        "contradictoryEvidenceFound": {"type": "boolean"},
        "unresolvedTemporalChange": {"type": "boolean"},
        "rationale": _string(),
    })
    player_default = _object({
        **assertion_common,
        "temporalScope": player_default_scope,
        "defaultPromotion": default_promotion,
    })
    season_override = _object({
        **assertion_common,
        "seasonId": _string(pattern=r"ipl-[0-9]{4}"),
        "temporalScope": season_scope,
    })
    disposition = _object({
        "dispositionId": _string(),
        "scope": _string(enum=["PLAYER_DEFAULT", "SEASON_OVERRIDE"]),
        "playerId": _string(),
        "seasonId": nullable_string,
        "status": _string(enum=["NATION_CLOSED_UNKNOWN"]),
        "sourceIdsReviewed": _array(_string(), unique=True, minimum=1),
        "reviewStatus": _string(enum=["APPROVED"]),
        "notes": _string(),
    })
    manual = _object({
        "schemaVersion": _string(enum=[MANUAL_SCHEMA_VERSION]),
        "metadataVersion": _string(enum=[METADATA_VERSION]),
        "sources": _array(source),
        "playerDefaults": _array(player_default),
        "seasonOverrides": _array(season_override),
        "reviewDispositions": _array(disposition),
    })
    player_row = _object({
        "schemaVersion": _string(enum=[PLAYER_ROW_SCHEMA_VERSION]),
        "metadataVersion": _string(enum=[METADATA_VERSION]),
        "playerId": _string(),
        "canonicalDisplayName": _string(),
        "cricketNationId": _string(),
        "iplRosterStatus": _string(enum=ROSTER_STATUSES),
        "nationResolutionMethod": _string(enum=RESOLUTION_METHODS),
        "rosterStatusResolutionMethod": _string(enum=RESOLUTION_METHODS),
        "cricketNationEvidenceRefs": evidence_array,
        "rosterStatusEvidenceRefs": evidence_array,
        "reviewState": _string(enum=REVIEW_STATES),
    })
    pts_row = _object({
        "schemaVersion": _string(enum=[PTS_ROW_SCHEMA_VERSION]),
        "metadataVersion": _string(enum=[METADATA_VERSION]),
        "playerTeamSeasonId": _string(pattern=r"pts:[^:]+:[^:]+:[^:]+"),
        "playerId": _string(),
        "canonicalDisplayName": _string(),
        "seasonId": _string(pattern=r"ipl-[0-9]{4}"),
        "teamId": _string(),
        "cricketNationId": _string(),
        "iplRosterStatus": _string(enum=ROSTER_STATUSES),
        "classificationBasis": _string(enum=CLASSIFICATION_BASES),
        "nationResolutionMethod": _string(enum=RESOLUTION_METHODS),
        "rosterStatusResolutionMethod": _string(enum=RESOLUTION_METHODS),
        "cricketNationEvidenceRefs": evidence_array,
        "rosterStatusEvidenceRefs": evidence_array,
        "reviewState": _string(enum=REVIEW_STATES),
    })
    review_item = _object({
        "reviewId": _string(),
        "reviewStatus": _string(enum=["PENDING"]),
        "playerId": _string(),
        "canonicalDisplayName": _string(),
        "playerTeamSeasonIds": _array(_string(), unique=True),
        "seasonIds": _array(_string(), unique=True),
        "legacyLeadAvailable": {"type": "boolean"},
        "unresolvedFields": _array(
            _string(enum=["CRICKET_NATION", "IPL_ROSTER_STATUS"]), unique=True, minimum=1
        ),
    })
    queue = _object({
        "schemaVersion": _string(enum=[QUEUE_SCHEMA_VERSION]),
        "metadataVersion": _string(enum=[METADATA_VERSION]),
        "scope": _string(enum=["G2_BLOCKING", "NON_G2_BACKLOG"]),
        "blocking": {"type": "boolean"},
        "summary": _object({
            "players": integer,
            "playerTeamSeasons": integer,
            "legacyLeadPlayers": integer,
        }),
        "items": _array(review_item),
    })
    legacy_row = _object({
        "playerId": _string(),
        "canonicalDisplayName": _string(),
        "legacyName": _string(),
        "legacyCountry": _string(),
        "legacyIsOverseas": {"type": "boolean"},
        "legacyCricketNationIdLead": _string(),
        "legacyIplRosterStatusLead": _string(enum=["INDIAN", "OVERSEAS"]),
        "identityStatus": _string(enum=["MATCHED"]),
        "comparisonStatus": _string(enum=[
            "UNVERIFIED", "PARTIALLY_VERIFIED", "SUPPORTED", "CONFLICTING"
        ]),
        "canonicalCricketNationId": _string(),
        "canonicalIplRosterStatus": _string(enum=ROSTER_STATUSES),
        "evidenceRefs": evidence_array,
    })
    legacy_report = _object({
        "schemaVersion": _string(enum=[LEGACY_REPORT_SCHEMA_VERSION]),
        "metadataVersion": _string(enum=[METADATA_VERSION]),
        "legacySourcePath": _string(),
        "legacySourceSha256": hash_string,
        "summary": _object({
            "rows": integer,
            "identityMatched": integer,
            "unverified": integer,
            "partiallyVerified": integer,
            "supported": integer,
            "conflicting": integer,
            "unmatched": integer,
        }),
        "rows": _array(legacy_row),
        "pilotComparisonSummary": _object({
            "players": integer,
            "agrees": integer,
            "disagrees": integer,
            "legacyAmbiguous": integer,
            "notLegacyCovered": integer,
        }),
        "pilotComparisons": _array(_object({
            "playerId": _string(),
            "canonicalDisplayName": _string(),
            "seasonIds": _array(_string(pattern=r"ipl-[0-9]{4}"), unique=True, minimum=1),
            "playerTeamSeasonIds": _array(_string(), unique=True, minimum=1),
            "canonicalCricketNationId": _string(),
            "canonicalIplRosterStatus": _string(enum=ROSTER_STATUSES),
            "legacyAvailable": {"type": "boolean"},
            "legacyCricketNationIdLead": nullable_string,
            "legacyIplRosterStatusLead": {
                "type": ["string", "null"],
                "enum": ["INDIAN", "OVERSEAS", None],
            },
            "comparisonStatus": _string(enum=[
                "AGREES", "DISAGREES", "LEGACY_AMBIGUOUS", "NOT_LEGACY_COVERED"
            ]),
            "evidenceRefs": evidence_array,
        })),
    })
    artifact = _object({
        "path": _string(),
        "sha256": hash_string,
        "sizeBytes": integer,
        "rows": {"type": ["integer", "null"], "minimum": 0},
        "schemaVersion": _string(),
    })
    manifest = _object({
        "schemaVersion": _string(enum=[MANIFEST_SCHEMA_VERSION]),
        "metadataVersion": _string(enum=[METADATA_VERSION]),
        "stage2RegistryVersion": _string(),
        "stage2RegistryAggregateHash": hash_string,
        "eligibilityVersion": _string(),
        "eligibilityManifestHash": hash_string,
        "eligibilityManifestFileSha256": hash_string,
        "g2EligibleIdSetSha256": hash_string,
        "manualMetadataSha256": hash_string,
        "cricketNationCatalogSha256": hash_string,
        "legacyMetadataSha256": hash_string,
        "artifacts": _array(artifact),
        "schemaFiles": _array(artifact),
        "metadataAggregateHash": hash_string,
        "metadataManifestHash": hash_string,
    })
    comparison = _object({
        "metric": _string(),
        "expected": integer,
        "actual": integer,
        "matches": {"type": "boolean"},
    })
    validation = _object({
        "schemaVersion": _string(enum=[VALIDATION_SCHEMA_VERSION]),
        "metadataVersion": _string(enum=[METADATA_VERSION]),
        "metadataManifestHash": hash_string,
        "status": _string(enum=["passed"]),
        "foundationStatus": _string(enum=["READY_FOR_RESEARCH", "PARTIALLY_POPULATED"]),
        "g2GameInputReady": {"type": "boolean"},
        "g2EligibleIdSetSha256": hash_string,
        "baselineComparisons": _array(comparison),
        "counts": _object({key: integer for key in (
            "canonicalPlayers", "playerTeamSeasons", "g2Players", "g2Profiles",
            "nonG2Players", "legacyRows", "approvedPlayerDefaults",
            "approvedSeasonOverrides", "unknownPlayerRosterStatuses",
            "unknownPtsRosterStatuses", "blockingG2Players", "blockingG2Profiles",
            "nonG2BacklogItems", "legacyUnverified", "legacyPartiallyVerified",
            "legacySupported", "legacyConflicting", "resolvedG2RosterProfiles",
            "unknownG2RosterProfiles", "fullyResolvedG2Players",
            "activeG2PlayerReviews", "resolvedG2CricketNationProfiles",
            "unknownG2CricketNationProfiles", "directRosterProfiles",
            "policyDerivedRosterProfiles", "manualReviewRosterProfiles",
            "legacyPilotAgrees", "legacyPilotDisagrees",
            "legacyPilotAmbiguous", "legacyPilotNotCovered",
        )}),
        "errors": _array(_string()),
    })
    return {
        "cricket_nation_catalog.schema.json": _document("IPL cricket-nation catalog", catalog),
        "source_evidence.schema.json": _document("Country/overseas source record", source),
        "player_default.schema.json": _document("Country/overseas player default", player_default),
        "season_override.schema.json": _document("Country/overseas season override", season_override),
        "review_disposition.schema.json": _document("Country/overseas review disposition", disposition),
        "manual_metadata.schema.json": _document("Country/overseas manual metadata", manual),
        "player_metadata.schema.json": _document("Resolved player metadata row", player_row),
        "player_team_season_metadata.schema.json": _document("Resolved player-team-season metadata row", pts_row),
        "review_queue.schema.json": _document("Country/overseas review queue", queue),
        "legacy_migration_report.schema.json": _document("Legacy country/overseas comparison", legacy_report),
        "metadata_manifest.schema.json": _document("Country/overseas metadata manifest", manifest),
        "validation_report.schema.json": _document("Country/overseas validation report", validation),
    }


def _load_eligibility(eligibility_dir: Path) -> tuple[bytes, dict[str, Any], list[dict[str, Any]]]:
    manifest_bytes, manifest = _read_json(
        eligibility_dir / "eligibility_manifest.json", "eligibility manifest"
    )
    if not isinstance(manifest, dict):
        raise CountryOverseasMetadataError("Eligibility manifest must be an object")
    _, manifest_schema = _read_json(
        eligibility_dir / "schemas/eligibility_manifest.schema.json",
        "eligibility manifest schema",
    )
    try:
        validate_instance(manifest, manifest_schema)
    except SchemaValidationError as error:
        raise CountryOverseasMetadataError(f"Eligibility manifest schema failure: {error}") from error
    payload = dict(manifest)
    recorded_hash = payload.pop("eligibilityManifestHash", None)
    if recorded_hash != _sha256(canonical_json_bytes(payload)):
        raise CountryOverseasMetadataError("Eligibility manifest self-hash is invalid")
    entry = next(
        (item for item in manifest.get("artifacts", []) if item.get("path") == "eligibility.jsonl"),
        None,
    )
    if entry is None:
        raise CountryOverseasMetadataError("Eligibility manifest does not contain eligibility.jsonl")
    content, rows = _read_jsonl(eligibility_dir / "eligibility.jsonl", "eligibility rows")
    if (
        entry.get("sha256") != _sha256(content)
        or entry.get("sizeBytes") != len(content)
        or entry.get("rows") != len(rows)
    ):
        raise CountryOverseasMetadataError("Eligibility artifact integrity failure")
    _, row_schema = _read_json(
        eligibility_dir / "schemas/eligibility.schema.json", "eligibility row schema"
    )
    try:
        for index, row in enumerate(rows):
            validate_instance(row, row_schema, f"eligibility[{index}]")
    except SchemaValidationError as error:
        raise CountryOverseasMetadataError(f"Eligibility row schema failure: {error}") from error
    _assert_unique((row["playerTeamSeasonId"] for row in rows), "eligibility player-team-season IDs")
    return manifest_bytes, manifest, rows


def _load_inputs(
    *,
    registry_dir: Path,
    registry_policy_path: Path,
    eligibility_dir: Path,
    manual_metadata_path: Path,
    cricket_nations_path: Path,
    legacy_metadata_path: Path,
) -> tuple[
    dict[str, Any], bytes, dict[str, Any], list[dict[str, Any]], bytes, dict[str, Any], bytes,
    dict[str, Any], bytes, list[dict[str, Any]], dict[str, dict[str, Any]],
]:
    try:
        registry = load_verified_registry(registry_dir, policy_path=registry_policy_path)
    except RegistryIntegrityError as error:
        raise CountryOverseasMetadataError(f"Stage 2 registry verification failed: {error}") from error
    eligibility_manifest_bytes, eligibility_manifest, eligibility_rows = _load_eligibility(eligibility_dir)
    manual_bytes, manual = _read_json(manual_metadata_path, "manual country/overseas metadata")
    catalog_bytes, catalog = _read_json(cricket_nations_path, "cricket-nation catalog")
    legacy_bytes, legacy_rows = _read_json(legacy_metadata_path, "legacy player metadata")
    if not isinstance(manual, dict) or not isinstance(catalog, dict) or not isinstance(legacy_rows, list):
        raise CountryOverseasMetadataError("Manual metadata, catalog, or legacy metadata has an invalid envelope")
    schemas = build_schemas()
    try:
        validate_instance(manual, schemas["manual_metadata.schema.json"])
        validate_instance(catalog, schemas["cricket_nation_catalog.schema.json"])
    except SchemaValidationError as error:
        raise CountryOverseasMetadataError(f"Manual input schema failure: {error}") from error
    return (
        registry,
        eligibility_manifest_bytes,
        eligibility_manifest,
        eligibility_rows,
        manual_bytes,
        manual,
        catalog_bytes,
        catalog,
        legacy_bytes,
        legacy_rows,
        schemas,
    )


def _sorted_evidence_refs(refs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(refs, key=canonical_json_bytes)


def _evidence_source_ids(refs: list[dict[str, Any]]) -> set[str]:
    return {row["sourceId"] for row in refs}


def _temporal_scope_seasons(scope: dict[str, Any]) -> list[str]:
    if scope["type"] == "PLAYER_DEFAULT":
        return scope["screenedSeasonIds"]
    return scope["seasonIds"]


def _assert_canonical_seasons(season_ids: list[str], label: str) -> None:
    if season_ids != sorted(set(season_ids)):
        raise CountryOverseasMetadataError(
            f"{label} season IDs must be unique and canonically sorted"
        )


def _validate_manual_cross_references(
    manual: dict[str, Any],
    catalog: dict[str, Any],
    player_by_id: dict[str, dict[str, Any]],
    valid_season_ids: set[str],
    committed_seasons_by_player: dict[str, set[str]],
) -> tuple[
    dict[str, dict[str, Any]],
    dict[tuple[str, str], dict[str, Any]],
    set[tuple[str, str | None]],
]:
    sources = manual["sources"]
    defaults = manual["playerDefaults"]
    overrides = manual["seasonOverrides"]
    dispositions = manual["reviewDispositions"]
    _assert_unique((row["sourceId"] for row in sources), "source IDs")
    _assert_unique((row["playerId"] for row in defaults), "player defaults")
    _assert_unique(((row["playerId"], row["seasonId"]) for row in overrides), "season overrides")
    _assert_unique((row["dispositionId"] for row in dispositions), "review disposition IDs")
    _assert_unique(
        ((row["scope"], row["playerId"], row["seasonId"]) for row in dispositions),
        "review disposition subjects",
    )
    source_ids = {row["sourceId"] for row in sources}
    source_by_id = {row["sourceId"]: row for row in sources}
    nation_ids = {row["cricketNationId"] for row in catalog["nations"]}
    _assert_unique(nation_ids, "cricket-nation IDs")
    _assert_unique((row["displayName"] for row in catalog["nations"]), "cricket-nation display names")

    for source in sources:
        if source["url"] is not None and not source["url"].startswith("https://"):
            raise CountryOverseasMetadataError(f"Source URL must use HTTPS: {source['sourceId']}")
        if (source["url"] is None) != (source["accessedDate"] is None):
            raise CountryOverseasMetadataError(
                f"Source URL and accessedDate must either both be set or both be null: {source['sourceId']}"
            )

    def validate_evidence_refs(
        refs: list[dict[str, Any]], label: str, supported_claim: str
    ) -> set[str]:
        rendered = [canonical_json_bytes(ref) for ref in refs]
        _assert_unique(rendered, f"{label} evidence references")
        referenced_sources: set[str] = set()
        covered_seasons: set[str] = set()
        for index, ref in enumerate(refs):
            ref_label = f"{label} evidence reference {index}"
            source_id = ref["sourceId"]
            referenced_sources.add(source_id)
            if source_id not in source_ids:
                raise CountryOverseasMetadataError(
                    f"{ref_label} references unknown source {source_id}"
                )
            if supported_claim not in source_by_id[source_id]["supports"]:
                raise CountryOverseasMetadataError(
                    f"{ref_label} source does not support {supported_claim}: {source_id}"
                )
            locator = ref["locator"]
            if not any(value is not None for value in locator.values()):
                raise CountryOverseasMetadataError(f"{ref_label} has an empty locator")
            scope = ref["temporalScope"]
            scope_seasons = _temporal_scope_seasons(scope)
            _assert_canonical_seasons(scope_seasons, ref_label)
            unknown_seasons = set(scope_seasons) - valid_season_ids
            if unknown_seasons:
                raise CountryOverseasMetadataError(
                    f"{ref_label} references unknown seasons {sorted(unknown_seasons)}"
                )
            if scope["type"] == "SEASON" and len(scope_seasons) != 1:
                raise CountryOverseasMetadataError(
                    f"{ref_label} SEASON scope must contain exactly one season"
                )
            if scope["type"] == "MULTI_SEASON" and len(scope_seasons) < 2:
                raise CountryOverseasMetadataError(
                    f"{ref_label} MULTI_SEASON scope must contain at least two seasons"
                )
            covered_seasons.update(scope_seasons)
        return covered_seasons

    def validate_assertion(
        row: dict[str, Any], label: str
    ) -> tuple[set[str], set[str]]:
        player_id = row["playerId"]
        if player_id not in player_by_id:
            raise CountryOverseasMetadataError(f"{label} references unknown player {player_id}")
        nation_id = row["cricketNationId"]
        if nation_id != "UNKNOWN" and nation_id not in nation_ids:
            raise CountryOverseasMetadataError(f"{label} references unknown cricket nation {nation_id}")
        nation_refs = row["cricketNationEvidenceRefs"]
        roster_refs = row["rosterStatusEvidenceRefs"]
        nation_coverage = validate_evidence_refs(
            nation_refs, f"{label} cricket-nation", "CRICKET_NATION"
        )
        roster_coverage = validate_evidence_refs(
            roster_refs, f"{label} roster-status", "IPL_ROSTER_STATUS"
        )
        nation_method = row["nationResolutionMethod"]
        roster_method = row["rosterStatusResolutionMethod"]

        def validate_field_method(
            *,
            field_label: str,
            is_unknown: bool,
            method: str,
            refs: list[dict[str, Any]],
            source_ids_for_field: set[str],
        ) -> None:
            if is_unknown:
                if refs:
                    raise CountryOverseasMetadataError(
                        f"{label} gives evidence to an UNKNOWN {field_label}"
                    )
                if method != "UNRESOLVED":
                    raise CountryOverseasMetadataError(
                        f"{label} has UNKNOWN {field_label} with a resolved method"
                    )
                return
            if not refs:
                raise CountryOverseasMetadataError(
                    f"{label} has a known {field_label} without evidence"
                )
            if method == "UNRESOLVED":
                raise CountryOverseasMetadataError(
                    f"{label} has a known {field_label} with UNRESOLVED method"
                )
            source_types = {
                source_by_id[source_id]["sourceType"]
                for source_id in source_ids_for_field
            }
            if method == "DIRECT_IPL_DESIGNATION" and "OFFICIAL_IPL" not in source_types:
                raise CountryOverseasMetadataError(
                    f"{label} uses DIRECT_IPL_DESIGNATION for {field_label} "
                    "without an OFFICIAL_IPL source"
                )
            if method == "POLICY_DERIVED" and "INTERNAL_POLICY" not in source_types:
                raise CountryOverseasMetadataError(
                    f"{label} uses POLICY_DERIVED for {field_label} "
                    "without an INTERNAL_POLICY source"
                )

        validate_field_method(
            field_label="cricket nation",
            is_unknown=nation_id == "UNKNOWN",
            method=nation_method,
            refs=nation_refs,
            source_ids_for_field=_evidence_source_ids(nation_refs),
        )
        roster_status = row["iplRosterStatus"]
        validate_field_method(
            field_label="roster status",
            is_unknown=roster_status == "UNKNOWN",
            method=roster_method,
            refs=roster_refs,
            source_ids_for_field=_evidence_source_ids(roster_refs),
        )
        return nation_coverage, roster_coverage

    for row in defaults:
        label = f"Player default {row['playerId']}"
        nation_coverage, roster_coverage = validate_assertion(row, label)
        player_id = row["playerId"]
        committed_seasons = committed_seasons_by_player.get(player_id, set())
        scope = row["temporalScope"]
        if scope["type"] != "PLAYER_DEFAULT":
            raise CountryOverseasMetadataError(f"{label} must use PLAYER_DEFAULT temporal scope")
        screened_seasons = scope["screenedSeasonIds"]
        _assert_canonical_seasons(screened_seasons, f"{label} temporal scope")
        promotion = row["defaultPromotion"]
        promotion_seasons = promotion["screenedSeasonIds"]
        _assert_canonical_seasons(promotion_seasons, f"{label} promotion")
        if set(screened_seasons) != committed_seasons or set(promotion_seasons) != committed_seasons:
            raise CountryOverseasMetadataError(
                f"{label} must screen the full committed season span {sorted(committed_seasons)}"
            )
        if screened_seasons != promotion_seasons:
            raise CountryOverseasMetadataError(
                f"{label} temporal scope and promotion screening seasons disagree"
            )
        if promotion["contradictoryEvidenceFound"]:
            raise CountryOverseasMetadataError(
                f"{label} cannot be promoted while contradictory evidence exists"
            )
        if promotion["unresolvedTemporalChange"]:
            raise CountryOverseasMetadataError(
                f"{label} cannot be promoted with an unresolved temporal change"
            )
        if row["cricketNationId"] != "UNKNOWN" and nation_coverage != committed_seasons:
            raise CountryOverseasMetadataError(
                f"{label} cricket-nation evidence does not cover the full committed span"
            )
        if row["iplRosterStatus"] != "UNKNOWN" and roster_coverage != committed_seasons:
            raise CountryOverseasMetadataError(
                f"{label} roster-status evidence does not cover the full committed span"
            )
    for row in overrides:
        if row["seasonId"] not in valid_season_ids:
            raise CountryOverseasMetadataError(
                f"Season override references unknown season {row['seasonId']}"
            )
        label = f"Season override {row['playerId']} {row['seasonId']}"
        nation_coverage, roster_coverage = validate_assertion(row, label)
        scope = row["temporalScope"]
        if scope["type"] != "SEASON" or scope["seasonIds"] != [row["seasonId"]]:
            raise CountryOverseasMetadataError(
                f"{label} temporal scope must match exactly its seasonId"
            )
        if row["cricketNationId"] != "UNKNOWN" and row["seasonId"] not in nation_coverage:
            raise CountryOverseasMetadataError(
                f"{label} cricket-nation evidence does not cover its season"
            )
        if row["iplRosterStatus"] != "UNKNOWN" and row["seasonId"] not in roster_coverage:
            raise CountryOverseasMetadataError(
                f"{label} roster-status evidence does not cover its season"
            )

    disposition_subjects: set[tuple[str, str | None]] = set()
    for row in dispositions:
        player_id = row["playerId"]
        if player_id not in player_by_id:
            raise CountryOverseasMetadataError(f"Disposition references unknown player {player_id}")
        season_id = row["seasonId"]
        if row["scope"] == "PLAYER_DEFAULT" and season_id is not None:
            raise CountryOverseasMetadataError("PLAYER_DEFAULT disposition must have null seasonId")
        if row["scope"] == "SEASON_OVERRIDE" and season_id not in valid_season_ids:
            raise CountryOverseasMetadataError("SEASON_OVERRIDE disposition must reference a valid seasonId")
        missing_sources = set(row["sourceIdsReviewed"]) - source_ids
        if missing_sources:
            raise CountryOverseasMetadataError(
                f"Disposition references unknown sources {sorted(missing_sources)}"
            )
        disposition_subjects.add((player_id, season_id))

    default_by_id = {row["playerId"]: row for row in defaults}
    override_by_key = {(row["playerId"], row["seasonId"]): row for row in overrides}
    return default_by_id, override_by_key, disposition_subjects


def _review_state(
    *, cricket_nation_id: str, roster_status: str, has_nation_unknown_disposition: bool
) -> str:
    if roster_status == "UNKNOWN":
        return "PENDING"
    if cricket_nation_id == "UNKNOWN":
        if not has_nation_unknown_disposition:
            raise CountryOverseasMetadataError(
                "Known IPL roster status with UNKNOWN cricket nation requires an approved disposition"
            )
        return "ROSTER_APPROVED_NATION_UNRESOLVED"
    return "APPROVED"


def resolve_metadata_rows(
    *,
    players: list[dict[str, Any]],
    eligibility_rows: list[dict[str, Any]],
    manual: dict[str, Any],
    catalog: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    schemas = build_schemas()
    try:
        validate_instance(manual, schemas["manual_metadata.schema.json"])
        validate_instance(catalog, schemas["cricket_nation_catalog.schema.json"])
    except SchemaValidationError as error:
        raise CountryOverseasMetadataError(f"Manual input schema failure: {error}") from error
    player_by_id = {row["playerId"]: row for row in players}
    if len(player_by_id) != len(players):
        raise CountryOverseasMetadataError("Canonical registry contains duplicate player IDs")
    valid_season_ids = {row["seasonId"] for row in eligibility_rows}
    committed_seasons_by_player: dict[str, set[str]] = defaultdict(set)
    for row in eligibility_rows:
        committed_seasons_by_player[row["playerId"]].add(row["seasonId"])
    default_by_id, override_by_key, disposition_subjects = _validate_manual_cross_references(
        manual, catalog, player_by_id, valid_season_ids, committed_seasons_by_player
    )

    generated_players: list[dict[str, Any]] = []
    for player in sorted(players, key=lambda row: row["playerId"]):
        player_id = player["playerId"]
        assertion = default_by_id.get(player_id)
        if assertion is None:
            nation_id = "UNKNOWN"
            roster_status = "UNKNOWN"
            nation_resolution_method = "UNRESOLVED"
            roster_resolution_method = "UNRESOLVED"
            nation_refs: list[str] = []
            roster_refs: list[str] = []
        else:
            nation_id = assertion["cricketNationId"]
            roster_status = assertion["iplRosterStatus"]
            nation_resolution_method = assertion["nationResolutionMethod"]
            roster_resolution_method = assertion["rosterStatusResolutionMethod"]
            nation_refs = _sorted_evidence_refs(assertion["cricketNationEvidenceRefs"])
            roster_refs = _sorted_evidence_refs(assertion["rosterStatusEvidenceRefs"])
        generated_players.append({
            "schemaVersion": PLAYER_ROW_SCHEMA_VERSION,
            "metadataVersion": METADATA_VERSION,
            "playerId": player_id,
            "canonicalDisplayName": player["canonicalDisplayName"],
            "cricketNationId": nation_id,
            "iplRosterStatus": roster_status,
            "nationResolutionMethod": nation_resolution_method,
            "rosterStatusResolutionMethod": roster_resolution_method,
            "cricketNationEvidenceRefs": nation_refs,
            "rosterStatusEvidenceRefs": roster_refs,
            "reviewState": _review_state(
                cricket_nation_id=nation_id,
                roster_status=roster_status,
                has_nation_unknown_disposition=(player_id, None) in disposition_subjects,
            ),
        })

    generated_player_by_id = {row["playerId"]: row for row in generated_players}
    resolved_pts: list[dict[str, Any]] = []
    for pts in sorted(eligibility_rows, key=lambda row: row["playerTeamSeasonId"]):
        player_id = pts["playerId"]
        if player_id not in generated_player_by_id:
            raise CountryOverseasMetadataError(
                f"Eligibility row references player absent from registry: {player_id}"
            )
        override = override_by_key.get((player_id, pts["seasonId"]))
        if override is None:
            source = generated_player_by_id[player_id]
            basis = "PLAYER_DEFAULT"
            nation_id = source["cricketNationId"]
            roster_status = source["iplRosterStatus"]
            nation_resolution_method = source["nationResolutionMethod"]
            roster_resolution_method = source["rosterStatusResolutionMethod"]
            nation_refs = source["cricketNationEvidenceRefs"]
            roster_refs = source["rosterStatusEvidenceRefs"]
            review_state = source["reviewState"]
        else:
            basis = "SEASON_OVERRIDE"
            nation_id = override["cricketNationId"]
            roster_status = override["iplRosterStatus"]
            nation_resolution_method = override["nationResolutionMethod"]
            roster_resolution_method = override["rosterStatusResolutionMethod"]
            nation_refs = _sorted_evidence_refs(override["cricketNationEvidenceRefs"])
            roster_refs = _sorted_evidence_refs(override["rosterStatusEvidenceRefs"])
            review_state = _review_state(
                cricket_nation_id=nation_id,
                roster_status=roster_status,
                has_nation_unknown_disposition=(player_id, pts["seasonId"]) in disposition_subjects,
            )
        resolved_pts.append({
            "schemaVersion": PTS_ROW_SCHEMA_VERSION,
            "metadataVersion": METADATA_VERSION,
            "playerTeamSeasonId": pts["playerTeamSeasonId"],
            "playerId": player_id,
            "canonicalDisplayName": pts["canonicalDisplayName"],
            "seasonId": pts["seasonId"],
            "teamId": pts["teamId"],
            "cricketNationId": nation_id,
            "iplRosterStatus": roster_status,
            "classificationBasis": basis,
            "nationResolutionMethod": nation_resolution_method,
            "rosterStatusResolutionMethod": roster_resolution_method,
            "cricketNationEvidenceRefs": nation_refs,
            "rosterStatusEvidenceRefs": roster_refs,
            "reviewState": review_state,
        })
    return generated_players, resolved_pts


def validate_g2_game_input_ready(
    eligibility_rows: list[dict[str, Any]], resolved_rows: list[dict[str, Any]]
) -> None:
    resolved_by_id: dict[str, dict[str, Any]] = {}
    duplicates: set[str] = set()
    for row in resolved_rows:
        pts_id = row["playerTeamSeasonId"]
        if pts_id in resolved_by_id:
            duplicates.add(pts_id)
        resolved_by_id[pts_id] = row
    if duplicates:
        raise CountryOverseasMetadataError(
            f"G2 game-input metadata contains duplicate profiles: {sorted(duplicates)}"
        )
    eligible_ids = {
        row["playerTeamSeasonId"]
        for row in eligibility_rows
        if row["eligibilityStatus"] == "ELIGIBLE"
    }
    missing = sorted(eligible_ids - set(resolved_by_id))
    if missing:
        raise CountryOverseasMetadataError(f"G2 game-input metadata is missing profiles: {missing}")
    unknown = sorted(
        pts_id for pts_id in eligible_ids if resolved_by_id[pts_id]["iplRosterStatus"] == "UNKNOWN"
    )
    if unknown:
        raise CountryOverseasMetadataError(
            f"G2 game-input metadata has UNKNOWN roster status for {len(unknown)} profiles"
        )
    conflicting = sorted(
        pts_id for pts_id in eligible_ids if resolved_by_id[pts_id].get("reviewState") == "CONFLICTING"
    )
    if conflicting:
        raise CountryOverseasMetadataError(
            f"G2 game-input metadata has conflicting profiles: {conflicting}"
        )


def _build_queue(
    *,
    scope: str,
    player_ids: set[str],
    relevant_pts: list[dict[str, Any]],
    resolved_by_id: dict[str, dict[str, Any]],
    generated_player_by_id: dict[str, dict[str, Any]],
    legacy_ids: set[str],
) -> dict[str, Any]:
    pts_by_player: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in relevant_pts:
        pts_by_player[row["playerId"]].append(row)
    items = []
    for player_id in sorted(player_ids):
        player = generated_player_by_id[player_id]
        profiles = sorted(pts_by_player.get(player_id, []), key=lambda row: row["playerTeamSeasonId"])
        if scope == "G2_BLOCKING":
            profiles = [
                row
                for row in profiles
                if resolved_by_id[row["playerTeamSeasonId"]]["iplRosterStatus"] == "UNKNOWN"
            ]
        else:
            profiles = [
                row
                for row in profiles
                if (
                    resolved_by_id[row["playerTeamSeasonId"]]["iplRosterStatus"] == "UNKNOWN"
                    or resolved_by_id[row["playerTeamSeasonId"]]["cricketNationId"] == "UNKNOWN"
                )
            ]
        if not profiles:
            continue
        resolved_profiles = [resolved_by_id[row["playerTeamSeasonId"]] for row in profiles]
        unresolved = []
        if any(row["cricketNationId"] == "UNKNOWN" for row in resolved_profiles):
            unresolved.append("CRICKET_NATION")
        if any(row["iplRosterStatus"] == "UNKNOWN" for row in resolved_profiles):
            unresolved.append("IPL_ROSTER_STATUS")
        items.append({
            "reviewId": f"country-overseas:{player_id}",
            "reviewStatus": "PENDING",
            "playerId": player_id,
            "canonicalDisplayName": player["canonicalDisplayName"],
            "playerTeamSeasonIds": [row["playerTeamSeasonId"] for row in profiles],
            "seasonIds": sorted({row["seasonId"] for row in profiles}),
            "legacyLeadAvailable": player_id in legacy_ids,
            "unresolvedFields": unresolved,
        })
    return {
        "schemaVersion": QUEUE_SCHEMA_VERSION,
        "metadataVersion": METADATA_VERSION,
        "scope": scope,
        "blocking": scope == "G2_BLOCKING",
        "summary": {
            "players": len(items),
            "playerTeamSeasons": sum(len(row["playerTeamSeasonIds"]) for row in items),
            "legacyLeadPlayers": sum(row["legacyLeadAvailable"] for row in items),
        },
        "items": items,
    }


def _build_legacy_report(
    *,
    legacy_rows: list[dict[str, Any]],
    legacy_path: Path,
    legacy_bytes: bytes,
    player_by_id: dict[str, dict[str, Any]],
    generated_player_by_id: dict[str, dict[str, Any]],
    resolved_pts: list[dict[str, Any]],
    asserted_player_ids: set[str],
    catalog: dict[str, Any],
) -> dict[str, Any]:
    _assert_unique((row.get("playerId") for row in legacy_rows), "legacy player IDs")
    nation_by_display = {row["displayName"]: row["cricketNationId"] for row in catalog["nations"]}
    legacy_by_id = {row["playerId"]: row for row in legacy_rows}
    populated_by_player: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in resolved_pts:
        if row["cricketNationId"] != "UNKNOWN" or row["iplRosterStatus"] != "UNKNOWN":
            populated_by_player[row["playerId"]].append(row)

    def canonical_values(player_id: str) -> tuple[str, str, list[dict[str, Any]]]:
        profiles = populated_by_player.get(player_id, [])
        nations = {row["cricketNationId"] for row in profiles if row["cricketNationId"] != "UNKNOWN"}
        statuses = {row["iplRosterStatus"] for row in profiles if row["iplRosterStatus"] != "UNKNOWN"}
        nation = next(iter(nations)) if len(nations) == 1 else "UNKNOWN"
        roster = next(iter(statuses)) if len(statuses) == 1 else "UNKNOWN"
        refs = _sorted_evidence_refs([
            json.loads(value)
            for value in sorted({
                canonical_json_bytes(ref).decode("utf-8")
                for profile in profiles
                for ref in (
                    profile["cricketNationEvidenceRefs"]
                    + profile["rosterStatusEvidenceRefs"]
                )
            })
        ])
        return nation, roster, refs

    results = []
    for index, legacy in enumerate(legacy_rows):
        if not isinstance(legacy, dict):
            raise CountryOverseasMetadataError(f"Legacy row {index} must be an object")
        required = {"playerId", "name", "country", "isOverseas"}
        if required - set(legacy):
            raise CountryOverseasMetadataError(f"Legacy row {index} is missing required fields")
        player_id = legacy["playerId"]
        player = player_by_id.get(player_id)
        if player is None:
            raise CountryOverseasMetadataError(f"Legacy row references unknown player {player_id}")
        if legacy["name"] != player["canonicalDisplayName"]:
            raise CountryOverseasMetadataError(
                f"Legacy name disagrees with canonical identity for {player_id}"
            )
        country = legacy["country"]
        is_overseas = legacy["isOverseas"]
        if country not in nation_by_display or not isinstance(is_overseas, bool):
            raise CountryOverseasMetadataError(f"Legacy row has invalid lead values for {player_id}")
        canonical = generated_player_by_id[player_id]
        nation_lead = nation_by_display[country]
        roster_lead = "OVERSEAS" if is_overseas else "INDIAN"
        profile_nation, profile_roster, profile_refs = canonical_values(player_id)
        canonical_nation = (
            canonical["cricketNationId"]
            if canonical["cricketNationId"] != "UNKNOWN"
            else profile_nation
        )
        canonical_roster = (
            canonical["iplRosterStatus"]
            if canonical["iplRosterStatus"] != "UNKNOWN"
            else profile_roster
        )
        known_nation = canonical_nation != "UNKNOWN"
        known_roster = canonical_roster != "UNKNOWN"
        comparisons = []
        if known_nation:
            comparisons.append(canonical_nation == nation_lead)
        if known_roster:
            comparisons.append(canonical_roster == roster_lead)
        if not comparisons:
            status = "UNVERIFIED"
        elif not all(comparisons):
            status = "CONFLICTING"
        elif known_nation and known_roster:
            status = "SUPPORTED"
        else:
            status = "PARTIALLY_VERIFIED"
        results.append({
            "playerId": player_id,
            "canonicalDisplayName": player["canonicalDisplayName"],
            "legacyName": legacy["name"],
            "legacyCountry": country,
            "legacyIsOverseas": is_overseas,
            "legacyCricketNationIdLead": nation_lead,
            "legacyIplRosterStatusLead": roster_lead,
            "identityStatus": "MATCHED",
            "comparisonStatus": status,
            "canonicalCricketNationId": canonical_nation,
            "canonicalIplRosterStatus": canonical_roster,
            "evidenceRefs": _sorted_evidence_refs([
                json.loads(value)
                for value in sorted({
                    canonical_json_bytes(ref).decode("utf-8")
                    for ref in (
                        canonical["cricketNationEvidenceRefs"]
                        + canonical["rosterStatusEvidenceRefs"]
                        + profile_refs
                    )
                })
            ]),
        })
    results.sort(key=lambda row: row["playerId"])
    pilot_comparisons = []
    for player_id in sorted(asserted_player_ids):
        profiles = sorted(
            populated_by_player[player_id], key=lambda row: row["playerTeamSeasonId"]
        )
        nation, roster, refs = canonical_values(player_id)
        legacy = legacy_by_id.get(player_id)
        if legacy is None:
            nation_lead = None
            roster_lead = None
            comparison_status = "NOT_LEGACY_COVERED"
        else:
            nation_lead = nation_by_display[legacy["country"]]
            roster_lead = "OVERSEAS" if legacy["isOverseas"] else "INDIAN"
            disagrees = (
                (nation != "UNKNOWN" and nation != nation_lead)
                or (roster != "UNKNOWN" and roster != roster_lead)
            )
            if disagrees:
                comparison_status = "DISAGREES"
            elif nation != "UNKNOWN" and roster != "UNKNOWN":
                comparison_status = "AGREES"
            else:
                comparison_status = "LEGACY_AMBIGUOUS"
        pilot_comparisons.append({
            "playerId": player_id,
            "canonicalDisplayName": player_by_id[player_id]["canonicalDisplayName"],
            "seasonIds": sorted({row["seasonId"] for row in profiles}),
            "playerTeamSeasonIds": [row["playerTeamSeasonId"] for row in profiles],
            "canonicalCricketNationId": nation,
            "canonicalIplRosterStatus": roster,
            "legacyAvailable": legacy is not None,
            "legacyCricketNationIdLead": nation_lead,
            "legacyIplRosterStatusLead": roster_lead,
            "comparisonStatus": comparison_status,
            "evidenceRefs": refs,
        })
    return {
        "schemaVersion": LEGACY_REPORT_SCHEMA_VERSION,
        "metadataVersion": METADATA_VERSION,
        "legacySourcePath": str(legacy_path),
        "legacySourceSha256": _sha256(legacy_bytes),
        "summary": {
            "rows": len(results),
            "identityMatched": len(results),
            "unverified": sum(row["comparisonStatus"] == "UNVERIFIED" for row in results),
            "partiallyVerified": sum(row["comparisonStatus"] == "PARTIALLY_VERIFIED" for row in results),
            "supported": sum(row["comparisonStatus"] == "SUPPORTED" for row in results),
            "conflicting": sum(row["comparisonStatus"] == "CONFLICTING" for row in results),
            "unmatched": 0,
        },
        "rows": results,
        "pilotComparisonSummary": {
            "players": len(pilot_comparisons),
            "agrees": sum(row["comparisonStatus"] == "AGREES" for row in pilot_comparisons),
            "disagrees": sum(row["comparisonStatus"] == "DISAGREES" for row in pilot_comparisons),
            "legacyAmbiguous": sum(
                row["comparisonStatus"] == "LEGACY_AMBIGUOUS" for row in pilot_comparisons
            ),
            "notLegacyCovered": sum(
                row["comparisonStatus"] == "NOT_LEGACY_COVERED" for row in pilot_comparisons
            ),
        },
        "pilotComparisons": pilot_comparisons,
    }


def build_country_overseas_metadata_files(
    *,
    registry_dir: Path = Path("data/registries/ipl/v1"),
    registry_policy_path: Path = Path("data/manual/identity/v1/registry_policy.json"),
    eligibility_dir: Path = Path("data/processed/era-draft/v1"),
    manual_metadata_path: Path = Path("data/manual/country_overseas_metadata/v1/metadata.json"),
    cricket_nations_path: Path = Path("data/manual/country_overseas_metadata/v1/cricket_nations.json"),
    legacy_metadata_path: Path = Path("data/manual/player_metadata_template.json"),
) -> tuple[dict[str, bytes], dict[str, Any]]:
    (
        registry,
        eligibility_manifest_bytes,
        eligibility_manifest,
        eligibility_rows,
        manual_bytes,
        manual,
        catalog_bytes,
        catalog,
        legacy_bytes,
        legacy_rows,
        schemas,
    ) = _load_inputs(
        registry_dir=registry_dir,
        registry_policy_path=registry_policy_path,
        eligibility_dir=eligibility_dir,
        manual_metadata_path=manual_metadata_path,
        cricket_nations_path=cricket_nations_path,
        legacy_metadata_path=legacy_metadata_path,
    )
    players = registry["players"]
    player_by_id = {row["playerId"]: row for row in players}
    actual_baselines = {
        "canonicalPlayers": len(players),
        "playerTeamSeasons": len(eligibility_rows),
        "g2Players": len({
            row["playerId"] for row in eligibility_rows if row["eligibilityStatus"] == "ELIGIBLE"
        }),
        "g2Profiles": sum(row["eligibilityStatus"] == "ELIGIBLE" for row in eligibility_rows),
        "nonG2Players": len(players) - len({
            row["playerId"] for row in eligibility_rows if row["eligibilityStatus"] == "ELIGIBLE"
        }),
        "legacyRows": len(legacy_rows),
    }
    comparisons = [
        {
            "metric": key,
            "expected": expected,
            "actual": actual_baselines[key],
            "matches": actual_baselines[key] == expected,
        }
        for key, expected in EXPECTED_BASELINES.items()
    ]
    if any(not row["matches"] for row in comparisons):
        raise CountryOverseasMetadataError(
            f"Repository baseline discrepancy; publication stopped: {[row for row in comparisons if not row['matches']]}"
        )

    generated_players, resolved_pts = resolve_metadata_rows(
        players=players,
        eligibility_rows=eligibility_rows,
        manual=manual,
        catalog=catalog,
    )
    generated_player_by_id = {row["playerId"]: row for row in generated_players}
    resolved_by_id = {row["playerTeamSeasonId"]: row for row in resolved_pts}
    if len(generated_player_by_id) != len(generated_players) or len(resolved_by_id) != len(resolved_pts):
        raise CountryOverseasMetadataError("Generated metadata contains duplicate canonical identities")
    if set(generated_player_by_id) != set(player_by_id):
        raise CountryOverseasMetadataError("Generated player coverage differs from Stage 2")
    if set(resolved_by_id) != {row["playerTeamSeasonId"] for row in eligibility_rows}:
        raise CountryOverseasMetadataError("Generated PTS coverage differs from committed eligibility")

    eligible_rows = [row for row in eligibility_rows if row["eligibilityStatus"] == "ELIGIBLE"]
    eligible_ids = {row["playerTeamSeasonId"] for row in eligible_rows}
    eligible_player_ids = {row["playerId"] for row in eligible_rows}
    non_g2_player_ids = set(player_by_id) - eligible_player_ids
    legacy_ids = {row["playerId"] for row in legacy_rows}
    g2_queue = _build_queue(
        scope="G2_BLOCKING",
        player_ids=eligible_player_ids,
        relevant_pts=eligible_rows,
        resolved_by_id=resolved_by_id,
        generated_player_by_id=generated_player_by_id,
        legacy_ids=legacy_ids,
    )
    non_g2_queue = _build_queue(
        scope="NON_G2_BACKLOG",
        player_ids=non_g2_player_ids,
        relevant_pts=[row for row in eligibility_rows if row["playerId"] in non_g2_player_ids],
        resolved_by_id=resolved_by_id,
        generated_player_by_id=generated_player_by_id,
        legacy_ids=legacy_ids,
    )
    legacy_report = _build_legacy_report(
        legacy_rows=legacy_rows,
        legacy_path=legacy_metadata_path,
        legacy_bytes=legacy_bytes,
        player_by_id=player_by_id,
        generated_player_by_id=generated_player_by_id,
        resolved_pts=resolved_pts,
        asserted_player_ids={
            row["playerId"]
            for row in manual["playerDefaults"] + manual["seasonOverrides"]
        },
        catalog=catalog,
    )

    try:
        for index, row in enumerate(generated_players):
            validate_instance(row, schemas["player_metadata.schema.json"], f"players[{index}]")
        for index, row in enumerate(resolved_pts):
            validate_instance(
                row, schemas["player_team_season_metadata.schema.json"], f"pts[{index}]"
            )
        validate_instance(g2_queue, schemas["review_queue.schema.json"])
        validate_instance(non_g2_queue, schemas["review_queue.schema.json"])
        validate_instance(legacy_report, schemas["legacy_migration_report.schema.json"])
    except SchemaValidationError as error:
        raise CountryOverseasMetadataError(f"Generated artifact schema failure: {error}") from error

    files: dict[str, bytes] = {
        "cricket_nations.json": pretty_json_bytes(catalog),
        "player_metadata.jsonl": _jsonl_bytes(generated_players),
        "player_team_season_metadata.jsonl": _jsonl_bytes(resolved_pts),
        "g2_review_queue.json": pretty_json_bytes(g2_queue),
        "non_g2_backlog.json": pretty_json_bytes(non_g2_queue),
        "legacy_migration_report.json": pretty_json_bytes(legacy_report),
    }
    for name, schema in schemas.items():
        files[f"schemas/{name}"] = pretty_json_bytes(schema)
    artifact_entries = [
        _artifact_entry("cricket_nations.json", files["cricket_nations.json"], CATALOG_SCHEMA_VERSION, len(catalog["nations"])),
        _artifact_entry("player_metadata.jsonl", files["player_metadata.jsonl"], PLAYER_ROW_SCHEMA_VERSION, len(generated_players)),
        _artifact_entry("player_team_season_metadata.jsonl", files["player_team_season_metadata.jsonl"], PTS_ROW_SCHEMA_VERSION, len(resolved_pts)),
        _artifact_entry("g2_review_queue.json", files["g2_review_queue.json"], QUEUE_SCHEMA_VERSION, len(g2_queue["items"])),
        _artifact_entry("non_g2_backlog.json", files["non_g2_backlog.json"], QUEUE_SCHEMA_VERSION, len(non_g2_queue["items"])),
        _artifact_entry("legacy_migration_report.json", files["legacy_migration_report.json"], LEGACY_REPORT_SCHEMA_VERSION, len(legacy_report["rows"])),
    ]
    schema_entries = [
        _artifact_entry(path, content, "json-schema/2020-12", None)
        for path, content in sorted(files.items())
        if path.startswith("schemas/")
    ]
    manifest = {
        "schemaVersion": MANIFEST_SCHEMA_VERSION,
        "metadataVersion": METADATA_VERSION,
        "stage2RegistryVersion": registry["manifest"]["registryVersion"],
        "stage2RegistryAggregateHash": registry["manifest"]["registryAggregateHash"],
        "eligibilityVersion": eligibility_manifest["eligibilityVersion"],
        "eligibilityManifestHash": eligibility_manifest["eligibilityManifestHash"],
        "eligibilityManifestFileSha256": _sha256(eligibility_manifest_bytes),
        "g2EligibleIdSetSha256": _id_set_hash(eligible_ids),
        "manualMetadataSha256": _sha256(manual_bytes),
        "cricketNationCatalogSha256": _sha256(catalog_bytes),
        "legacyMetadataSha256": _sha256(legacy_bytes),
        "artifacts": artifact_entries,
        "schemaFiles": schema_entries,
        "metadataAggregateHash": _aggregate_hash(files),
    }
    manifest["metadataManifestHash"] = _sha256(canonical_json_bytes(manifest))
    try:
        validate_instance(manifest, schemas["metadata_manifest.schema.json"])
    except SchemaValidationError as error:
        raise CountryOverseasMetadataError(f"Metadata manifest schema failure: {error}") from error
    files["metadata_manifest.json"] = pretty_json_bytes(manifest)

    resolved_g2_rows = [resolved_by_id[pts_id] for pts_id in sorted(eligible_ids)]
    counts = {
        **actual_baselines,
        "approvedPlayerDefaults": len(manual["playerDefaults"]),
        "approvedSeasonOverrides": len(manual["seasonOverrides"]),
        "unknownPlayerRosterStatuses": sum(
            row["iplRosterStatus"] == "UNKNOWN" for row in generated_players
        ),
        "unknownPtsRosterStatuses": sum(row["iplRosterStatus"] == "UNKNOWN" for row in resolved_pts),
        "blockingG2Players": len(g2_queue["items"]),
        "blockingG2Profiles": sum(
            resolved_by_id[pts_id]["iplRosterStatus"] == "UNKNOWN" for pts_id in eligible_ids
        ),
        "nonG2BacklogItems": len(non_g2_queue["items"]),
        "legacyUnverified": legacy_report["summary"]["unverified"],
        "legacyPartiallyVerified": legacy_report["summary"]["partiallyVerified"],
        "legacySupported": legacy_report["summary"]["supported"],
        "legacyConflicting": legacy_report["summary"]["conflicting"],
        "resolvedG2RosterProfiles": sum(
            row["iplRosterStatus"] != "UNKNOWN" for row in resolved_g2_rows
        ),
        "unknownG2RosterProfiles": sum(
            row["iplRosterStatus"] == "UNKNOWN" for row in resolved_g2_rows
        ),
        "fullyResolvedG2Players": len(eligible_player_ids) - len(g2_queue["items"]),
        "activeG2PlayerReviews": len(g2_queue["items"]),
        "resolvedG2CricketNationProfiles": sum(
            row["cricketNationId"] != "UNKNOWN" for row in resolved_g2_rows
        ),
        "unknownG2CricketNationProfiles": sum(
            row["cricketNationId"] == "UNKNOWN" for row in resolved_g2_rows
        ),
        "directRosterProfiles": sum(
            row["rosterStatusResolutionMethod"] == "DIRECT_IPL_DESIGNATION"
            for row in resolved_g2_rows
        ),
        "policyDerivedRosterProfiles": sum(
            row["rosterStatusResolutionMethod"] == "POLICY_DERIVED"
            for row in resolved_g2_rows
        ),
        "manualReviewRosterProfiles": sum(
            row["rosterStatusResolutionMethod"] == "MANUAL_REVIEW"
            for row in resolved_g2_rows
        ),
        "legacyPilotAgrees": legacy_report["pilotComparisonSummary"]["agrees"],
        "legacyPilotDisagrees": legacy_report["pilotComparisonSummary"]["disagrees"],
        "legacyPilotAmbiguous": legacy_report["pilotComparisonSummary"]["legacyAmbiguous"],
        "legacyPilotNotCovered": legacy_report["pilotComparisonSummary"]["notLegacyCovered"],
    }
    validation_report = {
        "schemaVersion": VALIDATION_SCHEMA_VERSION,
        "metadataVersion": METADATA_VERSION,
        "metadataManifestHash": manifest["metadataManifestHash"],
        "status": "passed",
        "foundationStatus": (
            "PARTIALLY_POPULATED"
            if manual["playerDefaults"] or manual["seasonOverrides"]
            else "READY_FOR_RESEARCH"
        ),
        "g2GameInputReady": counts["blockingG2Profiles"] == 0,
        "g2EligibleIdSetSha256": manifest["g2EligibleIdSetSha256"],
        "baselineComparisons": comparisons,
        "counts": counts,
        "errors": [],
    }
    try:
        validate_instance(validation_report, schemas["validation_report.schema.json"])
    except SchemaValidationError as error:
        raise CountryOverseasMetadataError(f"Validation report schema failure: {error}") from error
    files["validation_report.json"] = pretty_json_bytes(validation_report)
    summary = [
        "# IPL Country / Overseas Metadata v1",
        "",
        f"Metadata manifest SHA-256: `{manifest['metadataManifestHash']}`",
        "",
        "## Coverage",
        "",
        f"- Canonical players: {counts['canonicalPlayers']}",
        f"- Player-team-seasons: {counts['playerTeamSeasons']}",
        f"- G2 players: {counts['g2Players']}",
        f"- G2 profiles: {counts['g2Profiles']}",
        f"- Resolved G2 roster profiles: {counts['resolvedG2RosterProfiles']}",
        f"- UNKNOWN G2 roster profiles: {counts['unknownG2RosterProfiles']}",
        f"- Resolved G2 cricket-nation profiles: {counts['resolvedG2CricketNationProfiles']}",
        f"- UNKNOWN G2 cricket-nation profiles: {counts['unknownG2CricketNationProfiles']}",
        f"- Fully resolved G2 players: {counts['fullyResolvedG2Players']}",
        f"- Blocking G2 review items: {counts['blockingG2Players']}",
        f"- Non-G2 backlog items: {counts['nonG2BacklogItems']}",
        f"- Unverified legacy leads: {counts['legacyUnverified']}",
        "",
        "## Status",
        "",
        "- The approved Stage 2D pilot evidence is populated as season overrides.",
        "- No player default was created; profile evidence retains its season-specific methods.",
        "- Every remaining UNKNOWN G2 roster profile remains fail-closed.",
        "- Classic 2016 and wicketkeeper metadata are outside this artifact family and remain unchanged.",
        "",
    ]
    files["SUMMARY.md"] = "\n".join(summary).encode("utf-8")
    return files, validation_report


def write_artifact_tree(output_dir: Path, files: dict[str, bytes]) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    expected_paths = set(files)
    existing_paths = {
        str(path.relative_to(output_dir))
        for path in output_dir.rglob("*")
        if path.is_file()
    }
    unexpected = existing_paths - expected_paths
    if unexpected:
        raise CountryOverseasMetadataError(
            f"Output directory contains unexpected files: {sorted(unexpected)}"
        )
    for relative_path, content in sorted(files.items()):
        path = output_dir / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary = tempfile.mkstemp(
            dir=path.parent, prefix=f".{path.name}.", suffix=".tmp"
        )
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
        except BaseException:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass
            raise


__all__ = [
    "CountryOverseasMetadataError",
    "build_country_overseas_metadata_files",
    "build_schemas",
    "resolve_metadata_rows",
    "validate_g2_game_input_ready",
    "write_artifact_tree",
]
