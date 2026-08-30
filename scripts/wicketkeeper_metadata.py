from __future__ import annotations

import hashlib
import json
import os
import tempfile
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable

from scripts.cricsheet_analytics.integrity import load_verified_normalized_dataset
from scripts.cricsheet_audit.reporting import canonical_json_bytes, pretty_json_bytes
from scripts.identity_registry.integrity import load_verified_registry
from scripts.identity_registry.schemas import SchemaValidationError, validate_instance


METADATA_VERSION = "ipl-wicketkeeper-metadata/v1"
MANUAL_SCHEMA_VERSION = "ipl-wicketkeeper-manual/v1"
EVIDENCE_SCHEMA_VERSION = "ipl-wicketkeeper-stumping-evidence/v1"
CAPABILITY_SCHEMA_VERSION = "ipl-wicketkeeper-capability/v1"
USAGE_SCHEMA_VERSION = "ipl-wicketkeeper-usage/v1"
LEGACY_REPORT_SCHEMA_VERSION = "ipl-wicketkeeper-legacy-migration/v1"
REVIEW_QUEUE_SCHEMA_VERSION = "ipl-wicketkeeper-review-queue/v1"
MANIFEST_SCHEMA_VERSION = "ipl-wicketkeeper-metadata-manifest/v1"
VALIDATION_SCHEMA_VERSION = "ipl-wicketkeeper-metadata-validation/v1"

EXPECTED_BASELINES = {
    "stumpingEvents": 388,
    "capabilityPlayers": 104,
    "confirmedUsageProfiles": 206,
    "legacySupportedPositives": 16,
    "legacyUnverifiedPositives": 0,
    "legacyConflictingNegatives": 7,
    "legacyUnsupportedNegatives": 124,
}


class WicketkeeperMetadataError(ValueError):
    pass


def _sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _read_json(path: Path, label: str) -> tuple[bytes, Any]:
    try:
        content = path.read_bytes()
        return content, json.loads(content)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise WicketkeeperMetadataError(f"Could not read {label} at {path}: {error}") from error


def _read_jsonl(path: Path, label: str) -> tuple[bytes, list[dict[str, Any]]]:
    try:
        content = path.read_bytes()
        rows = [json.loads(line) for line in content.splitlines() if line]
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise WicketkeeperMetadataError(f"Could not read {label} at {path}: {error}") from error
    if not all(isinstance(row, dict) for row in rows):
        raise WicketkeeperMetadataError(f"{label} must contain JSON objects")
    return content, rows


def _jsonl_bytes(rows: Iterable[dict[str, Any]]) -> bytes:
    return b"".join(canonical_json_bytes(row) for row in rows)


def _array(items: dict[str, Any], *, unique: bool = False) -> dict[str, Any]:
    result: dict[str, Any] = {"type": "array", "items": items}
    if unique:
        result["uniqueItems"] = True
    return result


def _string(*, enum: list[str] | None = None, pattern: str | None = None) -> dict[str, Any]:
    result: dict[str, Any] = {"type": "string", "minLength": 1}
    if enum is not None:
        result["enum"] = enum
    if pattern is not None:
        result["pattern"] = pattern
    return result


def _object(properties: dict[str, Any], required: list[str] | None = None) -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "required": required or list(properties),
        "properties": properties,
    }


def build_manual_schema() -> dict[str, Any]:
    source = _object({
        "sourceId": _string(),
        "publisher": _string(),
        "title": _string(),
        "url": _string(pattern=r"https://.+"),
        "accessedDate": _string(pattern=r"\d{4}-\d{2}-\d{2}"),
        "locator": _string(),
        "supports": _array(_string(enum=["PLAYER_CAPABILITY", "PLAYER_TEAM_SEASON_USAGE"]), unique=True),
        "notes": {"type": ["string", "null"]},
    })
    confirmation = lambda key: _object({
        key: _string(),
        "sourceIds": _array(_string(), unique=True),
        "reviewStatus": _string(enum=["APPROVED"]),
        "notes": {"type": ["string", "null"]},
    })
    disposition = _object({
        "scope": _string(enum=["PLAYER_CAPABILITY", "PLAYER_TEAM_SEASON_USAGE"]),
        "subjectId": _string(),
        "status": _string(enum=["CLOSED_UNKNOWN"]),
        "sourceIdsReviewed": _array(_string(), unique=True),
        "notes": _string(),
    })
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "Positive-only manual wicketkeeper metadata",
        **_object({
            "schemaVersion": _string(enum=[MANUAL_SCHEMA_VERSION]),
            "sources": _array(source),
            "capabilityConfirmations": _array(confirmation("playerId")),
            "usageConfirmations": _array(confirmation("playerTeamSeasonId")),
            "reviewDispositions": _array(disposition),
        }),
    }


def build_output_schemas() -> dict[str, dict[str, Any]]:
    hash_string = _string(pattern=r"[0-9a-f]{64}")
    evidence = _object({
        "schemaVersion": _string(enum=[EVIDENCE_SCHEMA_VERSION]),
        "metadataVersion": _string(enum=[METADATA_VERSION]),
        "evidenceId": _string(),
        "evidenceType": _string(enum=["CRICSHEET_STUMPING"]),
        "normalizationManifestHash": hash_string,
        "normalizedMatchSha256": hash_string,
        "matchId": _string(pattern=r"[0-9]+"),
        "seasonId": _string(),
        "teamId": _string(),
        "playerTeamSeasonId": _string(pattern=r"pts:[^:]+:[^:]+:[^:]+"),
        "playerId": _string(),
        "sourceName": _string(),
        "inningsIndex": {"type": "integer", "minimum": 1},
        "sourceOverNumber": {"type": "integer", "minimum": 0},
        "sourceDeliveryIndex": {"type": "integer", "minimum": 0},
        "wicketIndex": {"type": "integer", "minimum": 0},
        "actualDelivery": _string(),
        "isSubstitute": {"type": "boolean"},
    })
    capability = _object({
        "schemaVersion": _string(enum=[CAPABILITY_SCHEMA_VERSION]),
        "metadataVersion": _string(enum=[METADATA_VERSION]),
        "playerId": _string(),
        "canonicalDisplayName": _string(),
        "status": _string(enum=["CONFIRMED", "UNKNOWN"]),
        "stumpingEvidenceCount": {"type": "integer", "minimum": 0},
        "evidenceRefs": _array(_string(), unique=True),
    })
    usage = _object({
        "schemaVersion": _string(enum=[USAGE_SCHEMA_VERSION]),
        "metadataVersion": _string(enum=[METADATA_VERSION]),
        "playerTeamSeasonId": _string(pattern=r"pts:[^:]+:[^:]+:[^:]+"),
        "playerId": _string(),
        "canonicalDisplayName": _string(),
        "seasonId": _string(),
        "teamId": _string(),
        "status": _string(enum=["CONFIRMED", "UNKNOWN"]),
        "stumpings": {"type": "integer", "minimum": 0},
        "evidenceRefs": _array(_string(), unique=True),
    })
    artifact = _object({
        "path": _string(), "sha256": hash_string, "sizeBytes": {"type": "integer", "minimum": 0},
        "rows": {"type": ["integer", "null"], "minimum": 0}, "schemaVersion": _string(),
    })
    integer = {"type": "integer", "minimum": 0}
    legacy_row = _object({
        "playerId": _string(), "canonicalDisplayName": _string(), "legacyIsWicketkeeper": {"type": "boolean"},
        "classification": _string(enum=["SUPPORTED_POSITIVE", "UNVERIFIED_POSITIVE", "CONFLICTING_NEGATIVE", "UNSUPPORTED_NEGATIVE"]),
        "careerStumpings": integer, "stumpingEvidenceRefs": _array(_string(), unique=True),
        "canonicalCapabilityEvidenceRefs": _array(_string(), unique=True),
        "ipl2016Stumpings": integer, "ipl2016EvidenceRefs": _array(_string(), unique=True),
        "canonicalCapabilityStatus": _string(enum=["CONFIRMED", "UNKNOWN"]),
    })
    legacy_report = _object({
        "schemaVersion": _string(enum=[LEGACY_REPORT_SCHEMA_VERSION]), "metadataVersion": _string(enum=[METADATA_VERSION]),
        "legacySourcePath": _string(), "legacySourceSha256": hash_string,
        "summary": _object({"rows": integer, "supportedPositives": integer, "unverifiedPositives": integer, "conflictingNegatives": integer, "unsupportedNegatives": integer}),
        "rows": _array(legacy_row),
    })
    usage_review = _object({
        "reviewId": _string(), "reviewType": _string(enum=["SEASON_USAGE"]), "reviewStatus": _string(enum=["PENDING"]),
        "playerTeamSeasonId": _string(), "playerId": _string(), "canonicalDisplayName": _string(),
        "seasonId": _string(), "teamId": _string(), "officialAppearances": integer,
        "battingBalls": integer, "bowlingLegalBalls": integer,
        "currentlyG2EligibleByBattingOrBowling": {"type": "boolean"}, "overlapsEligibilityCritical": {"type": "boolean"},
    })
    capability_candidate = _object({
        "reviewId": _string(), "reviewType": _string(enum=["LEGACY_CAPABILITY_CANDIDATE"]),
        "reviewStatus": _string(enum=["PENDING"]), "playerId": _string(), "canonicalDisplayName": _string(),
        "relatedOfficialAppearanceProfileIds": _array(_string(), unique=True),
    })
    closed_usage_review = _object({
        "reviewId": _string(), "reviewType": _string(enum=["SEASON_USAGE"]),
        "reviewStatus": _string(enum=["CLOSED_UNKNOWN"]), "playerTeamSeasonId": _string(),
        "playerId": _string(), "canonicalDisplayName": _string(), "seasonId": _string(),
        "teamId": _string(), "reviewedSourceRefs": _array(_string(), unique=True), "notes": _string(),
    })
    closed_capability_review = _object({
        "reviewId": _string(), "reviewType": _string(enum=["PLAYER_CAPABILITY"]),
        "reviewStatus": _string(enum=["CLOSED_UNKNOWN"]), "playerId": _string(),
        "canonicalDisplayName": _string(), "reviewedSourceRefs": _array(_string(), unique=True),
        "notes": _string(),
    })
    role_queue = _object({
        "schemaVersion": _string(enum=[REVIEW_QUEUE_SCHEMA_VERSION]), "metadataVersion": _string(enum=[METADATA_VERSION]),
        "scope": _string(enum=["FULL_ERA_DRAFT_KEEPER_ROLE"]),
        "summary": _object({
            "seasonUsageReviews": integer, "currentlyG2EligibleUsageReviews": integer,
            "eligibilityCriticalOverlap": integer, "legacyCapabilityCandidates": integer,
            "closedSeasonUsageReviews": integer, "closedCapabilityReviews": integer,
            "positiveDiscoveryComplete": {"type": "boolean"},
        }),
        "seasonUsageItems": _array(usage_review), "legacyCapabilityCandidateItems": _array(capability_candidate),
        "closedSeasonUsageItems": _array(closed_usage_review),
        "closedCapabilityItems": _array(closed_capability_review),
        "positiveDiscoveryScope": _object({
            "status": _string(enum=["FROZEN_WITH_DOCUMENTED_LIMITATIONS"]),
            "description": _string(),
        }),
    })
    comparison = _object({"metric": _string(), "expected": integer, "actual": integer, "matches": {"type": "boolean"}})
    validation_report = _object({
        "schemaVersion": _string(enum=[VALIDATION_SCHEMA_VERSION]), "metadataVersion": _string(enum=[METADATA_VERSION]),
        "metadataManifestHash": hash_string, "status": _string(enum=["passed"]),
        "baselineComparisons": _array(comparison),
        "counts": _object({key: integer for key in (
            "stumpingEvents", "capabilityPlayers", "confirmedUsageProfiles", "legacySupportedPositives",
            "legacyUnverifiedPositives", "legacyConflictingNegatives", "legacyUnsupportedNegatives",
            "canonicalPlayers", "playerTeamSeasons", "confirmedUsageWithAtLeastTwoOfficialAppearances",
            "confirmedUsageBelowTwoOfficialAppearances", "substituteStumpingEvents",
            "automaticallyConfirmedCapabilityPlayers", "automaticallyConfirmedUsageProfiles",
            "keeperRoleSeasonUsageReviews", "legacyCapabilityCandidates",
            "closedSeasonUsageReviews", "closedCapabilityReviews",
        )}),
        "errors": _array(_string()),
    })
    return {
        "stumping_evidence.schema.json": {"$schema": "https://json-schema.org/draft/2020-12/schema", "title": "Stumping evidence row", **evidence},
        "player_capability.schema.json": {"$schema": "https://json-schema.org/draft/2020-12/schema", "title": "Wicketkeeper capability row", **capability},
        "player_team_season_usage.schema.json": {"$schema": "https://json-schema.org/draft/2020-12/schema", "title": "Wicketkeeping usage row", **usage},
        "manual_metadata.schema.json": build_manual_schema(),
        "legacy_migration_report.schema.json": {"$schema": "https://json-schema.org/draft/2020-12/schema", "title": "Legacy keeper migration report", **legacy_report},
        "keeper_role_review_queue.schema.json": {"$schema": "https://json-schema.org/draft/2020-12/schema", "title": "Keeper role review queue", **role_queue},
        "metadata_manifest.schema.json": {"$schema": "https://json-schema.org/draft/2020-12/schema", "title": "Wicketkeeper metadata manifest", **_object({
            "schemaVersion": _string(enum=[MANIFEST_SCHEMA_VERSION]), "metadataVersion": _string(enum=[METADATA_VERSION]),
            "stage2RegistryVersion": _string(), "stage2RegistryAggregateHash": hash_string,
            "stage3DatasetVersion": _string(), "stage3NormalizationManifestHash": hash_string,
            "stage3NormalizedMatchAggregateHash": hash_string, "stage4DatasetVersion": _string(),
            "stage4AnalyticalManifestHash": hash_string, "manualOverlaySha256": hash_string,
            "artifacts": _array(artifact), "schemaFiles": _array(artifact),
            "metadataAggregateHash": hash_string, "metadataManifestHash": hash_string,
        })},
        "validation_report.schema.json": {"$schema": "https://json-schema.org/draft/2020-12/schema", "title": "Wicketkeeper metadata validation", **validation_report},
    }


def _validate_manual_overlay(document: Any, schema: dict[str, Any]) -> dict[str, Any]:
    try:
        validate_instance(document, schema)
    except SchemaValidationError as error:
        raise WicketkeeperMetadataError(f"Manual wicketkeeper overlay schema failure: {error}") from error
    if not isinstance(document, dict):
        raise WicketkeeperMetadataError("Manual wicketkeeper overlay must be an object")
    source_by_id: dict[str, dict[str, Any]] = {}
    for source in document["sources"]:
        if source["sourceId"] in source_by_id:
            raise WicketkeeperMetadataError(f"Duplicate manual source ID: {source['sourceId']}")
        if source["sourceId"].startswith(("stumping:", "manual:")):
            raise WicketkeeperMetadataError(f"Manual source ID uses a reserved prefix: {source['sourceId']}")
        source_by_id[source["sourceId"]] = source
    seen: set[tuple[str, str]] = set()
    for assertion_type, key, collection in (
        ("PLAYER_CAPABILITY", "playerId", document["capabilityConfirmations"]),
        ("PLAYER_TEAM_SEASON_USAGE", "playerTeamSeasonId", document["usageConfirmations"]),
    ):
        for row in collection:
            identity = (assertion_type, row[key])
            if identity in seen:
                raise WicketkeeperMetadataError(f"Duplicate manual confirmation: {identity}")
            seen.add(identity)
            if not row["sourceIds"]:
                raise WicketkeeperMetadataError(f"Manual confirmation requires provenance: {identity}")
            for source_id in row["sourceIds"]:
                source = source_by_id.get(source_id)
                if source is None:
                    raise WicketkeeperMetadataError(f"Unknown manual source ID {source_id} for {identity}")
                if assertion_type not in source["supports"]:
                    raise WicketkeeperMetadataError(f"Manual source {source_id} does not support {assertion_type}")
    disposition_seen: set[tuple[str, str]] = set()
    for disposition in document["reviewDispositions"]:
        identity = (disposition["scope"], disposition["subjectId"])
        if identity in disposition_seen:
            raise WicketkeeperMetadataError(f"Duplicate manual review disposition: {identity}")
        disposition_seen.add(identity)
        if identity in seen:
            raise WicketkeeperMetadataError(f"Manual confirmation conflicts with review disposition: {identity}")
        if not disposition["sourceIdsReviewed"]:
            raise WicketkeeperMetadataError(f"Review disposition requires reviewed provenance: {identity}")
        for source_id in disposition["sourceIdsReviewed"]:
            if source_id not in source_by_id:
                raise WicketkeeperMetadataError(f"Review disposition references unknown source ID: {source_id}")
    return document


def _load_stage4(root: Path) -> tuple[dict[str, Any], list[dict[str, Any]], bytes]:
    manifest_bytes, manifest = _read_json(root / "analytical_manifest.json", "Stage 4 analytical manifest")
    if not isinstance(manifest, dict):
        raise WicketkeeperMetadataError("Stage 4 analytical manifest must be an object")
    payload = dict(manifest)
    recorded_hash = payload.pop("analyticalManifestHash", None)
    if recorded_hash != _sha256(canonical_json_bytes(payload)):
        raise WicketkeeperMetadataError("Stage 4 analytical manifest self-hash is invalid")
    artifact = next((item for item in manifest.get("artifacts", []) if item.get("path") == "player_team_seasons.jsonl"), None)
    if artifact is None:
        raise WicketkeeperMetadataError("Stage 4 player-team-season artifact is missing")
    content, rows = _read_jsonl(root / artifact["path"], "Stage 4 player-team-seasons")
    if len(content) != artifact["sizeBytes"] or _sha256(content) != artifact["sha256"] or len(rows) != artifact["rows"]:
        raise WicketkeeperMetadataError("Stage 4 player-team-season integrity failure")
    ids = [row.get("playerTeamSeasonId") for row in rows]
    if len(ids) != len(set(ids)):
        raise WicketkeeperMetadataError("Duplicate Stage 4 player-team-season ID")
    return manifest, rows, manifest_bytes


def _manual_refs(source_ids: list[str]) -> list[str]:
    return [f"manual:{source_id}" for source_id in sorted(source_ids)]


def _baseline_comparisons(actual: dict[str, int]) -> list[dict[str, Any]]:
    return [
        {"metric": key, "expected": expected, "actual": actual[key], "matches": actual[key] == expected}
        for key, expected in EXPECTED_BASELINES.items()
    ]


def _artifact_entry(path: str, content: bytes, schema_version: str, rows: int | None = None) -> dict[str, Any]:
    return {"path": path, "sha256": _sha256(content), "sizeBytes": len(content), "rows": rows, "schemaVersion": schema_version}


def _aggregate_hash(files: dict[str, bytes]) -> str:
    digest = hashlib.sha256()
    for path, content in sorted(files.items()):
        digest.update(path.encode("utf-8")); digest.update(b"\0"); digest.update(content)
    return digest.hexdigest()


def build_wicketkeeper_metadata_files(
    *,
    registry_dir: Path = Path("data/registries/ipl/v1"),
    registry_policy_path: Path = Path("data/manual/identity/v1/registry_policy.json"),
    normalized_dir: Path = Path("data/normalized/cricsheet-ipl/v1"),
    analytical_dir: Path = Path("data/analytical/cricsheet-ipl/v1"),
    manual_overlay_path: Path = Path("data/manual/wicketkeeper_metadata/v1/metadata.json"),
    legacy_metadata_path: Path = Path("data/manual/player_metadata_template.json"),
) -> tuple[dict[str, bytes], dict[str, Any]]:
    verified_registry = load_verified_registry(registry_dir, policy_path=registry_policy_path)
    players = verified_registry["players"]
    player_by_id = {row["playerId"]: row for row in players}
    registry_manifest = verified_registry["manifest"]
    verified_stage3 = load_verified_normalized_dataset(normalized_dir)
    stage4_manifest, pts_rows, _ = _load_stage4(analytical_dir)
    if stage4_manifest.get("stage2RegistryAggregateHash") != registry_manifest["registryAggregateHash"]:
        raise WicketkeeperMetadataError("Stage 4 registry provenance differs from Stage 2")
    if stage4_manifest.get("stage3NormalizationManifestHash") != verified_stage3.manifest["normalizationManifestHash"]:
        raise WicketkeeperMetadataError("Stage 4 normalization provenance differs from Stage 3")

    manual_bytes, manual_document = _read_json(manual_overlay_path, "manual wicketkeeper overlay")
    manual = _validate_manual_overlay(manual_document, build_manual_schema())
    legacy_bytes, legacy_rows = _read_json(legacy_metadata_path, "legacy player metadata")
    if not isinstance(legacy_rows, list):
        raise WicketkeeperMetadataError("Legacy player metadata must be an array")

    pts_by_id = {row["playerTeamSeasonId"]: row for row in pts_rows}
    manual_capability = {row["playerId"]: row for row in manual["capabilityConfirmations"]}
    manual_usage = {row["playerTeamSeasonId"]: row for row in manual["usageConfirmations"]}
    capability_dispositions = {
        row["subjectId"]: row for row in manual["reviewDispositions"]
        if row["scope"] == "PLAYER_CAPABILITY"
    }
    usage_dispositions = {
        row["subjectId"]: row for row in manual["reviewDispositions"]
        if row["scope"] == "PLAYER_TEAM_SEASON_USAGE"
    }
    unknown_manual_players = sorted(set(manual_capability) - set(player_by_id))
    unknown_manual_usage = sorted(set(manual_usage) - set(pts_by_id))
    unknown_disposition_players = sorted(set(capability_dispositions) - set(player_by_id))
    unknown_disposition_usage = sorted(set(usage_dispositions) - set(pts_by_id))
    if unknown_manual_players or unknown_manual_usage or unknown_disposition_players or unknown_disposition_usage:
        raise WicketkeeperMetadataError(
            "Manual overlay references unknown IDs; "
            f"players={unknown_manual_players}, usage={unknown_manual_usage}, "
            f"dispositionPlayers={unknown_disposition_players}, dispositionUsage={unknown_disposition_usage}"
        )

    evidence: list[dict[str, Any]] = []
    evidence_by_player: dict[str, list[str]] = defaultdict(list)
    evidence_by_pts: dict[str, list[str]] = defaultdict(list)
    for entry, match in verified_stage3.iter_matches():
        season_id = match["season"]["seasonId"]
        for innings in match["innings"]:
            team_id = innings["bowlingTeamId"]
            for over in innings["overs"]:
                for delivery in over["deliveries"]:
                    for wicket_index, wicket in enumerate(delivery["wickets"]):
                        if wicket["kind"] != "stumped":
                            continue
                        if len(wicket["fielders"]) != 1:
                            raise WicketkeeperMetadataError(
                                f"Stumping must have exactly one fielder: {match['matchId']} {delivery['actualDelivery']}"
                            )
                        fielder = wicket["fielders"][0]
                        player_id = fielder["playerId"]
                        pts_id = f"pts:{player_id}:{season_id}:{team_id}"
                        if player_id not in player_by_id or pts_id not in pts_by_id:
                            raise WicketkeeperMetadataError(f"Stumping references unknown canonical identity: {pts_id}")
                        evidence_id = (
                            f"stumping:{match['matchId']}:{innings['inningsIndex']}:"
                            f"{over['sourceOverNumber']}:{delivery['sourceDeliveryIndex']}:{wicket_index}:{player_id}"
                        )
                        row = {
                            "schemaVersion": EVIDENCE_SCHEMA_VERSION,
                            "metadataVersion": METADATA_VERSION,
                            "evidenceId": evidence_id,
                            "evidenceType": "CRICSHEET_STUMPING",
                            "normalizationManifestHash": verified_stage3.manifest["normalizationManifestHash"],
                            "normalizedMatchSha256": entry["sha256"],
                            "matchId": match["matchId"], "seasonId": season_id, "teamId": team_id,
                            "playerTeamSeasonId": pts_id, "playerId": player_id,
                            "sourceName": fielder["sourceName"], "inningsIndex": innings["inningsIndex"],
                            "sourceOverNumber": over["sourceOverNumber"],
                            "sourceDeliveryIndex": delivery["sourceDeliveryIndex"],
                            "wicketIndex": wicket_index, "actualDelivery": delivery["actualDelivery"],
                            "isSubstitute": fielder["isSubstitute"],
                        }
                        evidence.append(row)
                        evidence_by_player[player_id].append(evidence_id)
                        evidence_by_pts[pts_id].append(evidence_id)
    evidence.sort(key=lambda row: row["evidenceId"])
    if len({row["evidenceId"] for row in evidence}) != len(evidence):
        raise WicketkeeperMetadataError("Duplicate stumping evidence ID")

    for player_id in manual_capability:
        if evidence_by_player[player_id]:
            raise WicketkeeperMetadataError(
                f"Manual capability duplicates deterministic Cricsheet evidence: {player_id}"
            )
    for pts_id in manual_usage:
        if evidence_by_pts[pts_id]:
            raise WicketkeeperMetadataError(
                f"Manual usage duplicates deterministic Cricsheet evidence: {pts_id}"
            )

    manual_usage_refs_by_player: dict[str, list[str]] = defaultdict(list)
    for pts_id, confirmation in manual_usage.items():
        manual_usage_refs_by_player[pts_by_id[pts_id]["playerId"]].extend(_manual_refs(confirmation["sourceIds"]))

    capabilities: list[dict[str, Any]] = []
    for player_id, player in sorted(player_by_id.items()):
        refs = sorted(evidence_by_player[player_id])
        if player_id in manual_capability:
            refs.extend(_manual_refs(manual_capability[player_id]["sourceIds"]))
        refs.extend(manual_usage_refs_by_player[player_id])
        refs = sorted(set(refs))
        capabilities.append({
            "schemaVersion": CAPABILITY_SCHEMA_VERSION, "metadataVersion": METADATA_VERSION,
            "playerId": player_id, "canonicalDisplayName": player["canonicalDisplayName"],
            "status": "CONFIRMED" if refs else "UNKNOWN",
            "stumpingEvidenceCount": len(evidence_by_player[player_id]), "evidenceRefs": refs,
        })

    usages: list[dict[str, Any]] = []
    for pts_id, pts in sorted(pts_by_id.items()):
        refs = sorted(evidence_by_pts[pts_id])
        if pts_id in manual_usage:
            refs.extend(_manual_refs(manual_usage[pts_id]["sourceIds"]))
        refs = sorted(set(refs))
        if len(evidence_by_pts[pts_id]) != pts["fielding"]["stumpings"]:
            raise WicketkeeperMetadataError(
                f"Stage 3/4 stumping reconciliation failed for {pts_id}: "
                f"events={len(evidence_by_pts[pts_id])}, aggregate={pts['fielding']['stumpings']}"
            )
        usages.append({
            "schemaVersion": USAGE_SCHEMA_VERSION, "metadataVersion": METADATA_VERSION,
            "playerTeamSeasonId": pts_id, "playerId": pts["playerId"],
            "canonicalDisplayName": pts["canonicalDisplayName"], "seasonId": pts["seasonId"],
            "teamId": pts["teamId"], "status": "CONFIRMED" if refs else "UNKNOWN",
            "stumpings": len(evidence_by_pts[pts_id]), "evidenceRefs": refs,
        })
    capability_by_id = {row["playerId"]: row for row in capabilities}
    for usage in usages:
        if usage["status"] == "CONFIRMED" and capability_by_id[usage["playerId"]]["status"] != "CONFIRMED":
            raise WicketkeeperMetadataError(f"Confirmed usage did not imply capability: {usage['playerTeamSeasonId']}")

    legacy_results: list[dict[str, Any]] = []
    legacy_counts: Counter[str] = Counter()
    for row in sorted(legacy_rows, key=lambda item: item["playerId"]):
        player_id = row["playerId"]
        if player_id not in player_by_id or not isinstance(row.get("isWicketkeeper"), bool):
            raise WicketkeeperMetadataError(f"Invalid legacy keeper row: {row}")
        refs = sorted(evidence_by_player[player_id])
        canonical_refs = capability_by_id[player_id]["evidenceRefs"]
        legacy_value = row["isWicketkeeper"]
        if legacy_value and canonical_refs:
            classification = "SUPPORTED_POSITIVE"
        elif legacy_value:
            classification = "UNVERIFIED_POSITIVE"
        elif canonical_refs:
            classification = "CONFLICTING_NEGATIVE"
        else:
            classification = "UNSUPPORTED_NEGATIVE"
        legacy_counts[classification] += 1
        season_2016_refs = [
            ref for ref in refs
            if next(e for e in evidence if e["evidenceId"] == ref)["seasonId"] == "ipl-2016"
        ]
        legacy_results.append({
            "playerId": player_id, "canonicalDisplayName": player_by_id[player_id]["canonicalDisplayName"],
            "legacyIsWicketkeeper": legacy_value, "classification": classification,
            "careerStumpings": len(refs), "stumpingEvidenceRefs": refs,
            "canonicalCapabilityEvidenceRefs": canonical_refs,
            "ipl2016Stumpings": len(season_2016_refs), "ipl2016EvidenceRefs": season_2016_refs,
            "canonicalCapabilityStatus": capability_by_id[player_id]["status"],
        })
    legacy_summary = {
        "rows": len(legacy_results),
        "supportedPositives": legacy_counts["SUPPORTED_POSITIVE"],
        "unverifiedPositives": legacy_counts["UNVERIFIED_POSITIVE"],
        "conflictingNegatives": legacy_counts["CONFLICTING_NEGATIVE"],
        "unsupportedNegatives": legacy_counts["UNSUPPORTED_NEGATIVE"],
    }
    legacy_report = {
        "schemaVersion": LEGACY_REPORT_SCHEMA_VERSION, "metadataVersion": METADATA_VERSION,
        "legacySourcePath": legacy_metadata_path.as_posix(), "legacySourceSha256": _sha256(legacy_bytes),
        "summary": legacy_summary, "rows": legacy_results,
    }

    usage_by_id = {row["playerTeamSeasonId"]: row for row in usages}
    eligibility_ids: set[str] = set()
    role_items: list[dict[str, Any]] = []
    for pts in pts_rows:
        official = pts["participation"]["officialListMatchCount"]
        batting = pts["batting"]["totals"]["balls"]
        bowling = pts["bowling"]["totals"]["legalBalls"]
        usage = usage_by_id[pts["playerTeamSeasonId"]]
        low_action = official >= 2 and batting < 6 and bowling < 12 and usage["status"] == "UNKNOWN"
        if low_action:
            eligibility_ids.add(pts["playerTeamSeasonId"])
        capability = capability_by_id[pts["playerId"]]
        if (
            official >= 2 and capability["status"] == "CONFIRMED"
            and usage["status"] == "UNKNOWN"
            and pts["playerTeamSeasonId"] not in usage_dispositions
        ):
            base_eligible = batting >= 6 or bowling >= 12
            role_items.append({
                "reviewId": f"usage:{pts['playerTeamSeasonId']}", "reviewType": "SEASON_USAGE",
                "reviewStatus": "PENDING", "playerTeamSeasonId": pts["playerTeamSeasonId"],
                "playerId": pts["playerId"], "canonicalDisplayName": pts["canonicalDisplayName"],
                "seasonId": pts["seasonId"], "teamId": pts["teamId"],
                "officialAppearances": official, "battingBalls": batting, "bowlingLegalBalls": bowling,
                "currentlyG2EligibleByBattingOrBowling": base_eligible,
                "overlapsEligibilityCritical": pts["playerTeamSeasonId"] in eligibility_ids,
            })
    legacy_candidates = []
    for row in legacy_results:
        if row["classification"] != "UNVERIFIED_POSITIVE":
            continue
        related = [
            pts["playerTeamSeasonId"] for pts in pts_rows
            if pts["playerId"] == row["playerId"] and pts["participation"]["officialListMatchCount"] >= 2
        ]
        legacy_candidates.append({
            "reviewId": f"capability:{row['playerId']}", "reviewType": "LEGACY_CAPABILITY_CANDIDATE",
            "reviewStatus": "PENDING", "playerId": row["playerId"],
            "canonicalDisplayName": row["canonicalDisplayName"], "relatedOfficialAppearanceProfileIds": sorted(related),
        })
    role_items.sort(key=lambda row: row["reviewId"])
    legacy_candidates.sort(key=lambda row: row["reviewId"])
    closed_usage_items = []
    for pts_id, disposition in sorted(usage_dispositions.items()):
        pts = pts_by_id[pts_id]
        closed_usage_items.append({
            "reviewId": f"usage:{pts_id}", "reviewType": "SEASON_USAGE",
            "reviewStatus": "CLOSED_UNKNOWN", "playerTeamSeasonId": pts_id,
            "playerId": pts["playerId"], "canonicalDisplayName": pts["canonicalDisplayName"],
            "seasonId": pts["seasonId"], "teamId": pts["teamId"],
            "reviewedSourceRefs": _manual_refs(disposition["sourceIdsReviewed"]),
            "notes": disposition["notes"],
        })
    closed_capability_items = []
    for player_id, disposition in sorted(capability_dispositions.items()):
        closed_capability_items.append({
            "reviewId": f"capability:{player_id}", "reviewType": "PLAYER_CAPABILITY",
            "reviewStatus": "CLOSED_UNKNOWN", "playerId": player_id,
            "canonicalDisplayName": player_by_id[player_id]["canonicalDisplayName"],
            "reviewedSourceRefs": _manual_refs(disposition["sourceIdsReviewed"]),
            "notes": disposition["notes"],
        })
    role_queue = {
        "schemaVersion": REVIEW_QUEUE_SCHEMA_VERSION, "metadataVersion": METADATA_VERSION,
        "scope": "FULL_ERA_DRAFT_KEEPER_ROLE",
        "summary": {
            "seasonUsageReviews": len(role_items),
            "currentlyG2EligibleUsageReviews": sum(row["currentlyG2EligibleByBattingOrBowling"] for row in role_items),
            "eligibilityCriticalOverlap": sum(row["overlapsEligibilityCritical"] for row in role_items),
            "legacyCapabilityCandidates": len(legacy_candidates),
            "closedSeasonUsageReviews": len(closed_usage_items),
            "closedCapabilityReviews": len(closed_capability_items),
            "positiveDiscoveryComplete": True,
        },
        "seasonUsageItems": role_items, "legacyCapabilityCandidateItems": legacy_candidates,
        "closedSeasonUsageItems": closed_usage_items,
        "closedCapabilityItems": closed_capability_items,
        "positiveDiscoveryScope": {
            "status": "FROZEN_WITH_DOCUMENTED_LIMITATIONS",
            "description": (
                "The positive keeper-capability population is frozen for the current 816-player "
                "match-participant registry. Direct official role-labelled archives remain incomplete "
                "for parts of 2008-2015, some historical IPL pages survive only through archived or "
                "staging material, and zero-match contracted squad members are outside this registry. "
                "Sunny Singh remains UNKNOWN because no reliable identity-matched positive evidence "
                "was accepted. Absence of evidence is not canonical negative evidence."
            ),
        },
    }
    try:
        validate_instance(legacy_report, build_output_schemas()["legacy_migration_report.schema.json"])
        validate_instance(role_queue, build_output_schemas()["keeper_role_review_queue.schema.json"])
    except SchemaValidationError as error:
        raise WicketkeeperMetadataError(f"Generated report schema failure: {error}") from error

    actual = {
        "stumpingEvents": len(evidence),
        "capabilityPlayers": sum(row["status"] == "CONFIRMED" for row in capabilities),
        "confirmedUsageProfiles": sum(row["status"] == "CONFIRMED" for row in usages),
        "legacySupportedPositives": legacy_summary["supportedPositives"],
        "legacyUnverifiedPositives": legacy_summary["unverifiedPositives"],
        "legacyConflictingNegatives": legacy_summary["conflictingNegatives"],
        "legacyUnsupportedNegatives": legacy_summary["unsupportedNegatives"],
    }
    comparisons = _baseline_comparisons(actual)
    discrepancies = [row for row in comparisons if not row["matches"]]
    if discrepancies:
        raise WicketkeeperMetadataError(f"Reconciliation baseline discrepancy; publication stopped: {discrepancies}")

    schemas = build_output_schemas()
    row_schemas = {
        "evidence": schemas["stumping_evidence.schema.json"],
        "capabilities": schemas["player_capability.schema.json"],
        "usages": schemas["player_team_season_usage.schema.json"],
    }
    for label, rows, schema in (
        ("evidence", evidence, row_schemas["evidence"]),
        ("capabilities", capabilities, row_schemas["capabilities"]),
        ("usages", usages, row_schemas["usages"]),
    ):
        try:
            for index, row in enumerate(rows):
                validate_instance(row, schema, f"{label}[{index}]")
        except SchemaValidationError as error:
            raise WicketkeeperMetadataError(f"Generated {label} schema failure: {error}") from error

    files: dict[str, bytes] = {
        "stumping_evidence.jsonl": _jsonl_bytes(evidence),
        "player_capabilities.jsonl": _jsonl_bytes(capabilities),
        "player_team_season_usage.jsonl": _jsonl_bytes(usages),
        "legacy_migration_report.json": pretty_json_bytes(legacy_report),
        "keeper_role_review_queue.json": pretty_json_bytes(role_queue),
    }
    for name, schema in schemas.items():
        files[f"schemas/{name}"] = pretty_json_bytes(schema)
    data_entries = [
        _artifact_entry("stumping_evidence.jsonl", files["stumping_evidence.jsonl"], EVIDENCE_SCHEMA_VERSION, len(evidence)),
        _artifact_entry("player_capabilities.jsonl", files["player_capabilities.jsonl"], CAPABILITY_SCHEMA_VERSION, len(capabilities)),
        _artifact_entry("player_team_season_usage.jsonl", files["player_team_season_usage.jsonl"], USAGE_SCHEMA_VERSION, len(usages)),
        _artifact_entry("legacy_migration_report.json", files["legacy_migration_report.json"], LEGACY_REPORT_SCHEMA_VERSION, len(legacy_results)),
        _artifact_entry(
            "keeper_role_review_queue.json", files["keeper_role_review_queue.json"],
            REVIEW_QUEUE_SCHEMA_VERSION,
            len(role_items) + len(legacy_candidates) + len(closed_usage_items) + len(closed_capability_items),
        ),
    ]
    schema_entries = [
        _artifact_entry(path, content, "json-schema/2020-12", None)
        for path, content in sorted(files.items()) if path.startswith("schemas/")
    ]
    aggregate_hash = _aggregate_hash(files)
    manifest = {
        "schemaVersion": MANIFEST_SCHEMA_VERSION, "metadataVersion": METADATA_VERSION,
        "stage2RegistryVersion": registry_manifest["registryVersion"],
        "stage2RegistryAggregateHash": registry_manifest["registryAggregateHash"],
        "stage3DatasetVersion": verified_stage3.manifest["datasetVersion"],
        "stage3NormalizationManifestHash": verified_stage3.manifest["normalizationManifestHash"],
        "stage3NormalizedMatchAggregateHash": verified_stage3.manifest["normalizedMatchAggregateHash"],
        "stage4DatasetVersion": stage4_manifest["datasetVersion"],
        "stage4AnalyticalManifestHash": stage4_manifest["analyticalManifestHash"],
        "manualOverlaySha256": _sha256(manual_bytes), "artifacts": data_entries,
        "schemaFiles": schema_entries, "metadataAggregateHash": aggregate_hash,
    }
    manifest["metadataManifestHash"] = _sha256(canonical_json_bytes(manifest))
    try:
        validate_instance(manifest, schemas["metadata_manifest.schema.json"])
    except SchemaValidationError as error:
        raise WicketkeeperMetadataError(f"Metadata manifest schema failure: {error}") from error
    files["metadata_manifest.json"] = pretty_json_bytes(manifest)
    validation_report = {
        "schemaVersion": VALIDATION_SCHEMA_VERSION, "metadataVersion": METADATA_VERSION,
        "metadataManifestHash": manifest["metadataManifestHash"], "status": "passed",
        "baselineComparisons": comparisons,
        "counts": {
            **actual, "canonicalPlayers": len(capabilities), "playerTeamSeasons": len(usages),
            "confirmedUsageWithAtLeastTwoOfficialAppearances": sum(
                usage_by_id[pts["playerTeamSeasonId"]]["status"] == "CONFIRMED"
                and pts["participation"]["officialListMatchCount"] >= 2 for pts in pts_rows
            ),
            "confirmedUsageBelowTwoOfficialAppearances": sum(
                usage_by_id[pts["playerTeamSeasonId"]]["status"] == "CONFIRMED"
                and pts["participation"]["officialListMatchCount"] < 2 for pts in pts_rows
            ),
            "substituteStumpingEvents": sum(row["isSubstitute"] for row in evidence),
            "automaticallyConfirmedCapabilityPlayers": sum(
                row["stumpingEvidenceCount"] > 0 for row in capabilities
            ),
            "automaticallyConfirmedUsageProfiles": sum(row["stumpings"] > 0 for row in usages),
            "keeperRoleSeasonUsageReviews": len(role_items),
            "legacyCapabilityCandidates": len(legacy_candidates),
            "closedSeasonUsageReviews": len(closed_usage_items),
            "closedCapabilityReviews": len(closed_capability_items),
        },
        "errors": [],
    }
    try:
        validate_instance(validation_report, schemas["validation_report.schema.json"])
    except SchemaValidationError as error:
        raise WicketkeeperMetadataError(f"Metadata validation report schema failure: {error}") from error
    files["validation_report.json"] = pretty_json_bytes(validation_report)
    summary = [
        "# Canonical IPL Wicketkeeper Metadata v1", "",
        f"Metadata manifest SHA-256: `{manifest['metadataManifestHash']}`", "",
        "## Canonical confirmations", "",
        f"- Stumping events: {actual['stumpingEvents']}",
        f"- Confirmed capability players: {actual['capabilityPlayers']}",
        f"- Confirmed usage profiles: {actual['confirmedUsageProfiles']}", "",
        "## Automatic evidence", "",
        f"- Automatically confirmed capability players: {sum(row['stumpingEvidenceCount'] > 0 for row in capabilities)}",
        f"- Automatically confirmed usage profiles: {sum(row['stumpings'] > 0 for row in usages)}", "",
        "## Review boundary", "",
        f"- Season-usage review items: {len(role_items)}",
        f"- Unverified legacy capability candidates: {len(legacy_candidates)}",
        f"- Closed-unknown season-usage reviews: {len(closed_usage_items)}",
        f"- Closed-unknown capability reviews: {len(closed_capability_items)}",
        "- Positive keeper-capability discovery is frozen for the current 816-player match-participant registry.",
        "- Archive limitations: direct official role-labelled coverage is incomplete for parts of 2008-2015; some historical IPL evidence survives only through archived or staging material.",
        "- Registry limitation: zero-match contracted squad members are outside the current canonical population.",
        "- Sunny Singh remains UNKNOWN because no reliable identity-matched positive evidence was accepted; UNKNOWN is not a canonical negative.", "",
        "## Compatibility", "",
        "- No live 2016 game-facing artifact or consumer is produced or modified by this builder.", "",
    ]
    files["SUMMARY.md"] = "\n".join(summary).encode("utf-8")
    return files, validation_report


def write_artifact_tree(output_dir: Path, files: dict[str, bytes]) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    for relative_path, content in sorted(files.items()):
        path = output_dir / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(content); handle.flush(); os.fsync(handle.fileno())
            os.replace(temporary, path)
        except BaseException:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass
            raise
