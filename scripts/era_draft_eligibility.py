from __future__ import annotations

from collections import Counter
from pathlib import Path
from typing import Any

from scripts.cricsheet_audit.reporting import canonical_json_bytes, pretty_json_bytes
from scripts.identity_registry.schemas import SchemaValidationError, validate_instance
from scripts.wicketkeeper_metadata import (
    METADATA_VERSION,
    _aggregate_hash,
    _artifact_entry,
    _jsonl_bytes,
    _load_stage4,
    _object,
    _read_json,
    _read_jsonl,
    _sha256,
    _string,
    write_artifact_tree,
)


ELIGIBILITY_VERSION = "ipl-era-draft-eligibility/v1"
ROW_SCHEMA_VERSION = "ipl-era-draft-eligibility-row/v1"
QUEUE_SCHEMA_VERSION = "ipl-era-draft-eligibility-review/v1"
MANIFEST_SCHEMA_VERSION = "ipl-era-draft-eligibility-manifest/v1"
VALIDATION_SCHEMA_VERSION = "ipl-era-draft-eligibility-validation/v1"
EXPECTED_BASELINES = {"g2EligibleProfiles": 2990, "eligibilityCriticalReviewCases": 22}


class EraDraftEligibilityError(ValueError):
    pass


def decide_g2(
    *, official_appearances: int, batting_balls: int, bowling_legal_balls: int,
    wicketkeeping_usage_status: str,
) -> tuple[str, list[str], list[str]]:
    if wicketkeeping_usage_status not in {"CONFIRMED", "UNKNOWN"}:
        raise EraDraftEligibilityError(f"Unsupported wicketkeeping usage status: {wicketkeeping_usage_status}")
    qualifying: list[str] = []
    if batting_balls >= 6: qualifying.append("BATTING_BALLS")
    if bowling_legal_balls >= 12: qualifying.append("BOWLING_LEGAL_BALLS")
    if wicketkeeping_usage_status == "CONFIRMED": qualifying.append("WICKETKEEPING_USAGE")
    eligible = official_appearances >= 2 and bool(qualifying)
    exclusions: list[str] = []
    if official_appearances < 2: exclusions.append("OFFICIAL_APPEARANCES_BELOW_2")
    elif not qualifying: exclusions.append("NO_G2_ACTION_THRESHOLD")
    return ("ELIGIBLE" if eligible else "INELIGIBLE", qualifying, exclusions)


def _load_metadata(root: Path) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
    _, manifest = _read_json(root / "metadata_manifest.json", "wicketkeeper metadata manifest")
    if not isinstance(manifest, dict) or manifest.get("metadataVersion") != METADATA_VERSION:
        raise EraDraftEligibilityError("Unexpected wicketkeeper metadata manifest")
    payload = dict(manifest)
    recorded = payload.pop("metadataManifestHash", None)
    if recorded != _sha256(canonical_json_bytes(payload)):
        raise EraDraftEligibilityError("Wicketkeeper metadata manifest self-hash is invalid")
    entries = {row["path"]: row for row in manifest.get("artifacts", [])}
    loaded: dict[str, list[dict[str, Any]]] = {}
    for path in ("player_capabilities.jsonl", "player_team_season_usage.jsonl"):
        entry = entries.get(path)
        if entry is None:
            raise EraDraftEligibilityError(f"Wicketkeeper metadata artifact missing: {path}")
        content, rows = _read_jsonl(root / path, path)
        if len(content) != entry["sizeBytes"] or _sha256(content) != entry["sha256"] or len(rows) != entry["rows"]:
            raise EraDraftEligibilityError(f"Wicketkeeper metadata artifact integrity failure: {path}")
        loaded[path] = rows
    return manifest, loaded["player_capabilities.jsonl"], loaded["player_team_season_usage.jsonl"]


def build_eligibility_schemas() -> dict[str, dict[str, Any]]:
    integer = {"type": "integer", "minimum": 0}
    hash_string = _string(pattern=r"[0-9a-f]{64}")
    row = _object({
        "schemaVersion": _string(enum=[ROW_SCHEMA_VERSION]),
        "eligibilityVersion": _string(enum=[ELIGIBILITY_VERSION]),
        "playerTeamSeasonId": _string(pattern=r"pts:[^:]+:[^:]+:[^:]+"),
        "playerId": _string(), "canonicalDisplayName": _string(), "seasonId": _string(), "teamId": _string(),
        "officialAppearances": {"type": "integer", "minimum": 0},
        "battingBalls": {"type": "integer", "minimum": 0},
        "bowlingLegalBalls": {"type": "integer", "minimum": 0},
        "wicketkeepingUsageStatus": _string(enum=["CONFIRMED", "UNKNOWN"]),
        "eligibilityStatus": _string(enum=["ELIGIBLE", "INELIGIBLE"]),
        "qualifyingReasons": {"type": "array", "uniqueItems": True, "items": _string(enum=["BATTING_BALLS", "BOWLING_LEGAL_BALLS", "WICKETKEEPING_USAGE"])},
        "exclusionReasons": {"type": "array", "uniqueItems": True, "items": _string(enum=["OFFICIAL_APPEARANCES_BELOW_2", "NO_G2_ACTION_THRESHOLD"])},
    })
    review_item = _object({
        "reviewId": _string(), "reviewStatus": _string(enum=["PENDING"]),
        "playerTeamSeasonId": _string(), "playerId": _string(), "canonicalDisplayName": _string(),
        "seasonId": _string(), "teamId": _string(), "officialAppearances": integer,
        "battingBalls": integer, "bowlingLegalBalls": integer,
        "capabilityStatus": _string(enum=["CONFIRMED", "UNKNOWN"]),
        "reviewPath": _string(enum=["SEASON_USAGE_ONLY", "CAPABILITY_THEN_USAGE"]),
        "overlapsKeeperRoleReview": {"type": "boolean"},
    })
    queue = _object({
        "schemaVersion": _string(enum=[QUEUE_SCHEMA_VERSION]), "eligibilityVersion": _string(enum=[ELIGIBILITY_VERSION]),
        "scope": _string(enum=["G2_ELIGIBILITY_CRITICAL"]),
        "summary": _object({"reviewCases": integer, "seasonUsageOnly": integer, "capabilityThenUsage": integer, "keeperRoleReviewOverlap": integer}),
        "items": {"type": "array", "items": review_item}, "completionBoundary": _string(),
    })
    artifact = _object({
        "path": _string(), "sha256": hash_string, "sizeBytes": integer,
        "rows": {"type": ["integer", "null"], "minimum": 0}, "schemaVersion": _string(),
    })
    manifest = _object({
        "schemaVersion": _string(enum=[MANIFEST_SCHEMA_VERSION]), "eligibilityVersion": _string(enum=[ELIGIBILITY_VERSION]),
        "stage4DatasetVersion": _string(), "stage4AnalyticalManifestHash": hash_string,
        "wicketkeeperMetadataVersion": _string(), "wicketkeeperMetadataManifestHash": hash_string,
        "artifacts": {"type": "array", "items": artifact}, "schemaFiles": {"type": "array", "items": artifact},
        "eligibilityAggregateHash": hash_string, "eligibilityManifestHash": hash_string,
    })
    comparison = _object({"metric": _string(), "expected": integer, "actual": integer, "matches": {"type": "boolean"}})
    validation = _object({
        "schemaVersion": _string(enum=[VALIDATION_SCHEMA_VERSION]), "eligibilityVersion": _string(enum=[ELIGIBILITY_VERSION]),
        "eligibilityManifestHash": hash_string, "status": _string(enum=["passed"]),
        "baselineComparisons": {"type": "array", "items": comparison},
        "counts": _object({key: integer for key in (
            "playerTeamSeasons", "g2EligibleProfiles", "g2EligiblePlayers",
            "battingOrBowlingEligibleProfiles", "keeperOnlyAdmissions", "eligibilityCriticalReviewCases",
        )}),
        "qualifyingReasonCounts": _object({key: integer for key in ("BATTING_BALLS", "BOWLING_LEGAL_BALLS", "WICKETKEEPING_USAGE")}),
        "exclusionReasonCounts": _object({key: integer for key in ("NO_G2_ACTION_THRESHOLD", "OFFICIAL_APPEARANCES_BELOW_2")}),
        "keeperOnlyAdmissionIds": {"type": "array", "items": _string(), "uniqueItems": True},
        "errors": {"type": "array", "items": _string()},
    })
    return {
        "eligibility.schema.json": {"$schema": "https://json-schema.org/draft/2020-12/schema", "title": "Era Draft G2 eligibility row", **row},
        "eligibility_review_queue.schema.json": {"$schema": "https://json-schema.org/draft/2020-12/schema", "title": "Era Draft eligibility review queue", **queue},
        "eligibility_manifest.schema.json": {"$schema": "https://json-schema.org/draft/2020-12/schema", "title": "Era Draft eligibility manifest", **manifest},
        "validation_report.schema.json": {"$schema": "https://json-schema.org/draft/2020-12/schema", "title": "Era Draft eligibility validation", **validation},
    }


def _load_role_review_ids(metadata_dir: Path) -> set[str]:
    _, queue = _read_json(metadata_dir / "keeper_role_review_queue.json", "keeper role review queue")
    if not isinstance(queue, dict):
        raise EraDraftEligibilityError("Keeper role review queue must be an object")
    return {row["playerTeamSeasonId"] for row in queue.get("seasonUsageItems", [])}


def build_era_draft_eligibility_files(
    *,
    analytical_dir: Path = Path("data/analytical/cricsheet-ipl/v1"),
    metadata_dir: Path = Path("data/metadata/ipl/v1"),
) -> tuple[dict[str, bytes], dict[str, Any]]:
    stage4_manifest, pts_rows, _ = _load_stage4(analytical_dir)
    metadata_manifest, capability_rows, usage_rows = _load_metadata(metadata_dir)
    if metadata_manifest["stage4AnalyticalManifestHash"] != stage4_manifest["analyticalManifestHash"]:
        raise EraDraftEligibilityError("Wicketkeeper metadata does not match Stage 4")
    capability_by_id = {row["playerId"]: row for row in capability_rows}
    usage_by_id = {row["playerTeamSeasonId"]: row for row in usage_rows}
    if len(capability_by_id) != len(capability_rows) or len(usage_by_id) != len(usage_rows):
        raise EraDraftEligibilityError("Duplicate wicketkeeper metadata identity")
    role_review_ids = _load_role_review_ids(metadata_dir)

    decisions: list[dict[str, Any]] = []
    review_items: list[dict[str, Any]] = []
    for pts in sorted(pts_rows, key=lambda row: row["playerTeamSeasonId"]):
        pts_id = pts["playerTeamSeasonId"]
        usage = usage_by_id.get(pts_id)
        capability = capability_by_id.get(pts["playerId"])
        if usage is None or capability is None:
            raise EraDraftEligibilityError(f"Missing wicketkeeper metadata for {pts_id}")
        official = pts["participation"]["officialListMatchCount"]
        batting = pts["batting"]["totals"]["balls"]
        bowling = pts["bowling"]["totals"]["legalBalls"]
        eligibility_status, qualifying, exclusions = decide_g2(
            official_appearances=official, batting_balls=batting,
            bowling_legal_balls=bowling, wicketkeeping_usage_status=usage["status"],
        )
        decision = {
            "schemaVersion": ROW_SCHEMA_VERSION, "eligibilityVersion": ELIGIBILITY_VERSION,
            "playerTeamSeasonId": pts_id, "playerId": pts["playerId"],
            "canonicalDisplayName": pts["canonicalDisplayName"], "seasonId": pts["seasonId"],
            "teamId": pts["teamId"], "officialAppearances": official, "battingBalls": batting,
            "bowlingLegalBalls": bowling, "wicketkeepingUsageStatus": usage["status"],
            "eligibilityStatus": eligibility_status,
            "qualifyingReasons": qualifying, "exclusionReasons": exclusions,
        }
        decisions.append(decision)
        if official >= 2 and batting < 6 and bowling < 12 and usage["status"] == "UNKNOWN":
            capability_confirmed = capability["status"] == "CONFIRMED"
            review_items.append({
                "reviewId": f"eligibility:{pts_id}", "reviewStatus": "PENDING",
                "playerTeamSeasonId": pts_id, "playerId": pts["playerId"],
                "canonicalDisplayName": pts["canonicalDisplayName"], "seasonId": pts["seasonId"],
                "teamId": pts["teamId"], "officialAppearances": official,
                "battingBalls": batting, "bowlingLegalBalls": bowling,
                "capabilityStatus": capability["status"],
                "reviewPath": "SEASON_USAGE_ONLY" if capability_confirmed else "CAPABILITY_THEN_USAGE",
                "overlapsKeeperRoleReview": pts_id in role_review_ids,
            })
    review_items.sort(key=lambda row: row["reviewId"])
    eligible_rows = [row for row in decisions if row["eligibilityStatus"] == "ELIGIBLE"]
    base_eligible = [
        row for row in decisions
        if row["officialAppearances"] >= 2 and (
            row["battingBalls"] >= 6 or row["bowlingLegalBalls"] >= 12
        )
    ]
    keeper_only = [
        row for row in eligible_rows
        if row["qualifyingReasons"] == ["WICKETKEEPING_USAGE"]
    ]
    actual = {"g2EligibleProfiles": len(eligible_rows), "eligibilityCriticalReviewCases": len(review_items)}
    comparisons = [
        {"metric": key, "expected": expected, "actual": actual[key], "matches": actual[key] == expected}
        for key, expected in EXPECTED_BASELINES.items()
    ]
    discrepancies = [row for row in comparisons if not row["matches"]]
    if discrepancies:
        raise EraDraftEligibilityError(f"Reconciliation baseline discrepancy; publication stopped: {discrepancies}")

    schemas = build_eligibility_schemas()
    try:
        for index, row in enumerate(decisions):
            validate_instance(row, schemas["eligibility.schema.json"], f"eligibility[{index}]")
    except SchemaValidationError as error:
        raise EraDraftEligibilityError(f"Eligibility schema failure: {error}") from error

    queue = {
        "schemaVersion": QUEUE_SCHEMA_VERSION, "eligibilityVersion": ELIGIBILITY_VERSION,
        "scope": "G2_ELIGIBILITY_CRITICAL", "summary": {
            "reviewCases": len(review_items),
            "seasonUsageOnly": sum(row["reviewPath"] == "SEASON_USAGE_ONLY" for row in review_items),
            "capabilityThenUsage": sum(row["reviewPath"] == "CAPABILITY_THEN_USAGE" for row in review_items),
            "keeperRoleReviewOverlap": sum(row["overlapsKeeperRoleReview"] for row in review_items),
        },
        "items": review_items,
        "completionBoundary": "Resolving this queue finalizes G2 pruning only; it does not complete Era Draft keeper-role coverage.",
    }
    try:
        validate_instance(queue, schemas["eligibility_review_queue.schema.json"])
    except SchemaValidationError as error:
        raise EraDraftEligibilityError(f"Eligibility review queue schema failure: {error}") from error
    files: dict[str, bytes] = {
        "eligibility.jsonl": _jsonl_bytes(decisions),
        "eligibility_review_queue.json": pretty_json_bytes(queue),
    }
    for name, schema in schemas.items():
        files[f"schemas/{name}"] = pretty_json_bytes(schema)
    artifact_entries = [
        _artifact_entry("eligibility.jsonl", files["eligibility.jsonl"], ROW_SCHEMA_VERSION, len(decisions)),
        _artifact_entry("eligibility_review_queue.json", files["eligibility_review_queue.json"], QUEUE_SCHEMA_VERSION, len(review_items)),
    ]
    schema_entries = [
        _artifact_entry(path, content, "json-schema/2020-12", None)
        for path, content in sorted(files.items()) if path.startswith("schemas/")
    ]
    manifest = {
        "schemaVersion": MANIFEST_SCHEMA_VERSION, "eligibilityVersion": ELIGIBILITY_VERSION,
        "stage4DatasetVersion": stage4_manifest["datasetVersion"],
        "stage4AnalyticalManifestHash": stage4_manifest["analyticalManifestHash"],
        "wicketkeeperMetadataVersion": metadata_manifest["metadataVersion"],
        "wicketkeeperMetadataManifestHash": metadata_manifest["metadataManifestHash"],
        "artifacts": artifact_entries, "schemaFiles": schema_entries,
        "eligibilityAggregateHash": _aggregate_hash(files),
    }
    manifest["eligibilityManifestHash"] = _sha256(canonical_json_bytes(manifest))
    try:
        validate_instance(manifest, schemas["eligibility_manifest.schema.json"])
    except SchemaValidationError as error:
        raise EraDraftEligibilityError(f"Eligibility manifest schema failure: {error}") from error
    files["eligibility_manifest.json"] = pretty_json_bytes(manifest)
    reason_counts = Counter(reason for row in eligible_rows for reason in row["qualifyingReasons"])
    exclusion_counts = Counter(reason for row in decisions for reason in row["exclusionReasons"])
    validation = {
        "schemaVersion": VALIDATION_SCHEMA_VERSION, "eligibilityVersion": ELIGIBILITY_VERSION,
        "eligibilityManifestHash": manifest["eligibilityManifestHash"], "status": "passed",
        "baselineComparisons": comparisons,
        "counts": {
            "playerTeamSeasons": len(decisions), "g2EligibleProfiles": len(eligible_rows),
            "g2EligiblePlayers": len({row["playerId"] for row in eligible_rows}),
            "battingOrBowlingEligibleProfiles": len(base_eligible),
            "keeperOnlyAdmissions": len(keeper_only),
            "eligibilityCriticalReviewCases": len(review_items),
        },
        "qualifyingReasonCounts": dict(sorted(reason_counts.items())),
        "exclusionReasonCounts": dict(sorted(exclusion_counts.items())),
        "keeperOnlyAdmissionIds": [row["playerTeamSeasonId"] for row in keeper_only],
        "errors": [],
    }
    try:
        validate_instance(validation, schemas["validation_report.schema.json"])
    except SchemaValidationError as error:
        raise EraDraftEligibilityError(f"Eligibility validation report schema failure: {error}") from error
    files["validation_report.json"] = pretty_json_bytes(validation)
    summary = [
        "# Era Draft G2 Eligibility v1", "",
        f"Eligibility manifest SHA-256: `{manifest['eligibilityManifestHash']}`", "",
        "## Reconciliation", "",
        f"- Player-team-seasons evaluated: {len(decisions)}",
        f"- G2 eligible profiles: {len(eligible_rows)}",
        f"- Batting/bowling qualifiers: {len(base_eligible)}",
        f"- Keeper-only admissions: {len(keeper_only)}",
        f"- Eligibility-critical review cases: {len(review_items)}", "",
        "## Boundary", "",
        "- This output finalizes eligibility decisions only; keeper-role completeness is tracked separately.", "",
    ]
    files["SUMMARY.md"] = "\n".join(summary).encode("utf-8")
    return files, validation


__all__ = ["EraDraftEligibilityError", "build_era_draft_eligibility_files", "write_artifact_tree"]
