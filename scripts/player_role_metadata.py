from __future__ import annotations

import hashlib
import json
from collections import Counter, defaultdict
from copy import deepcopy
from fractions import Fraction
from pathlib import Path
from typing import Any, Iterable

from scripts.cricsheet_analytics.integrity import load_verified_normalized_dataset
from scripts.cricsheet_audit.reporting import canonical_json_bytes, pretty_json_bytes
from scripts.identity_registry.integrity import load_verified_registry
from scripts.identity_registry.schemas import SchemaValidationError, validate_instance
from scripts.wicketkeeper_metadata import (
    _aggregate_hash,
    _artifact_entry,
    _jsonl_bytes,
    _load_stage4,
    _read_json,
    _read_jsonl,
    _sha256,
    write_artifact_tree,
)


ROLE_METADATA_VERSION = "ipl-era-draft-player-roles/v1"
PRIOR_SCHEMA_VERSION = "ipl-era-draft-player-batting-prior/v1"
PROFILE_SCHEMA_VERSION = "ipl-era-draft-player-team-season-role/v1"
QUEUE_SCHEMA_VERSION = "ipl-era-draft-player-role-review/v1"
MANIFEST_SCHEMA_VERSION = "ipl-era-draft-player-role-manifest/v1"
VALIDATION_SCHEMA_VERSION = "ipl-era-draft-player-role-validation/v1"

ISSUE_URL = "https://github.com/AviSharma01/draft-simulator/issues/1"

BATTING_BANDS: dict[str, tuple[int, ...]] = {
    "OPENING": (1, 2),
    "TOP_ORDER": (3,),
    "MIDDLE_ORDER": (4, 5),
    "LOWER_ORDER": (6, 7, 8),
    "TAIL": (9, 10, 11),
}
BAND_ORDER = tuple(BATTING_BANDS)
POSITION_TO_BAND = {
    position: band
    for band, positions in BATTING_BANDS.items()
    for position in positions
}

CAREER_PRIOR_MIN_INNINGS = 4
SEASON_ONLY_MIN_INNINGS = 4
ACCEPTABLE_BAND_SHARE = Fraction(3, 20)
FULL_BOWLING_QUOTA_BALLS = 24
SUPPORT_BOWLING_CAPACITY = Fraction(1, 4)
FRONTLINE_BOWLING_CAPACITY = Fraction(3, 4)

EXPECTED_BASELINES = {
    "canonicalPlayers": 816,
    "stage4PlayerTeamSeasons": 3392,
    "g2Players": 727,
    "g2Profiles": 2992,
    "seasonBattingObservedProfiles": 2776,
    "fitResolvedProfiles": 2901,
    "fitUnknownProfiles": 91,
    "bowlingFamilyQueuePlayers": 505,
    "qualityFieldsPresent": 0,
    "keeperFieldsPresent": 0,
}


class PlayerRoleMetadataError(ValueError):
    pass


def _string(*, enum: Iterable[str] | None = None, pattern: str | None = None, nullable: bool = False) -> dict[str, Any]:
    schema: dict[str, Any] = {"type": ["string", "null"] if nullable else "string"}
    if not nullable:
        schema["minLength"] = 1
    if enum is not None:
        schema["enum"] = [*enum, None] if nullable else list(enum)
    if pattern is not None:
        schema["pattern"] = pattern
    return schema


def _integer(minimum: int = 0) -> dict[str, Any]:
    return {"type": "integer", "minimum": minimum}


def _number(*, minimum: float | None = None, maximum: float | None = None, nullable: bool = False) -> dict[str, Any]:
    schema: dict[str, Any] = {"type": ["number", "null"] if nullable else "number"}
    if minimum is not None:
        schema["minimum"] = minimum
    if maximum is not None:
        schema["maximum"] = maximum
    return schema


def _array(items: dict[str, Any], *, unique: bool = False) -> dict[str, Any]:
    schema: dict[str, Any] = {"type": "array", "items": items}
    if unique:
        schema["uniqueItems"] = True
    return schema


def _object(properties: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "required": list(properties),
        "properties": properties,
    }


def _position_counts_schema() -> dict[str, Any]:
    return _object({str(position): _integer() for position in range(1, 12)})


def _band_counts_schema() -> dict[str, Any]:
    return _object({band: _integer() for band in BAND_ORDER})


def _band_shares_schema(*, nullable: bool) -> dict[str, Any]:
    return _object({band: _number(minimum=0, maximum=1, nullable=nullable) for band in BAND_ORDER})


def build_role_schemas() -> dict[str, dict[str, Any]]:
    hash_string = _string(pattern=r"[0-9a-f]{64}")
    band = _string(enum=BAND_ORDER)
    evidence = _string(enum=["HIGH", "MEDIUM", "LOW", "NONE"])
    slot_fit = _object({
        "position": {"type": "integer", "minimum": 1, "maximum": 11},
        "band": band,
        "classification": _string(enum=["NATURAL", "ACCEPTABLE", "OUT_OF_ROLE", "UNKNOWN"]),
        "bandDistance": {"type": ["integer", "null"], "minimum": 0, "maximum": 4},
    })
    phase = _object({
        "legalBalls": _integer(),
        "share": _number(minimum=0, maximum=1, nullable=True),
    })
    prior = _object({
        "schemaVersion": _string(enum=[PRIOR_SCHEMA_VERSION]),
        "roleMetadataVersion": _string(enum=[ROLE_METADATA_VERSION]),
        "playerId": _string(),
        "canonicalDisplayName": _string(),
        "profileCount": _integer(),
        "battingInnings": _integer(),
        "positionCounts": _position_counts_schema(),
        "bandCounts": _band_counts_schema(),
        "bandShares": _band_shares_schema(nullable=True),
    })
    profile = _object({
        "schemaVersion": _string(enum=[PROFILE_SCHEMA_VERSION]),
        "roleMetadataVersion": _string(enum=[ROLE_METADATA_VERSION]),
        "playerTeamSeasonId": _string(pattern=r"pts:[^:]+:[^:]+:[^:]+"),
        "playerId": _string(),
        "canonicalDisplayName": _string(),
        "seasonId": _string(),
        "teamId": _string(),
        "franchiseId": _string(),
        "battingUsage": _object({
            "seasonInnings": _integer(),
            "seasonPositionCounts": _position_counts_schema(),
            "seasonBandCounts": _band_counts_schema(),
            "otherProfileInnings": _integer(),
            "otherProfileBandCounts": _band_counts_schema(),
            "careerPriorEligible": {"type": "boolean"},
            "priorWeight": _number(minimum=0, maximum=4),
            "effectiveBandShares": _band_shares_schema(nullable=True),
            "basis": _string(enum=[
                "SEASON", "SEASON_PLUS_PLAYER_HISTORY", "SEASON_SPARSE",
                "PLAYER_HISTORY_FALLBACK", "UNOBSERVED",
            ]),
            "confidence": evidence,
            "primaryBands": _array(band, unique=True),
            "slotFits": {**_array(slot_fit, unique=True), "minItems": 11, "maxItems": 11},
        }),
        "bowlingUsage": _object({
            "officialAppearances": _integer(),
            "bowlingMatches": _integer(),
            "legalBalls": _integer(),
            "ballsPerOfficialAppearance": _number(minimum=0, maximum=24),
            "ballsPerBowlingMatch": _number(minimum=0, maximum=24, nullable=True),
            "capacity": _number(minimum=0, maximum=1),
            "usageClass": _string(enum=["NONE", "OCCASIONAL", "SUPPORT", "FRONTLINE"]),
            "confidence": evidence,
            "phases": _object({phase_name: phase for phase_name in ("powerplay", "middle", "death")}),
        }),
        "roleSummary": _object({
            "role": _string(enum=["BATTER", "ALL_ROUNDER", "BOWLER", "UNKNOWN"]),
            "battingResponsibility": _string(enum=["CORE", "LOWER", "TAIL", "UNKNOWN"]),
            "allRounderLean": _string(enum=["BATTING", "BALANCED", "BOWLING"], nullable=True),
            "isCanonical": {"const": False},
        }),
    })
    family_review = _object({
        "reviewId": _string(),
        "reviewType": _string(enum=["BOWLING_FAMILY"]),
        "reviewStatus": _string(enum=["PENDING"]),
        "playerId": _string(),
        "canonicalDisplayName": _string(),
        "qualifyingProfileIds": _array(_string(), unique=True),
        "qualifyingProfileCount": _integer(1),
        "maximumProfileLegalBalls": _integer(12),
        "blockingForBowlingFamilyCoverage": {"const": True},
    })
    fit_review = _object({
        "reviewId": _string(),
        "reviewType": _string(enum=["BATTING_FIT"]),
        "reviewStatus": _string(enum=["PENDING"]),
        "playerTeamSeasonId": _string(),
        "playerId": _string(),
        "canonicalDisplayName": _string(),
        "seasonId": _string(),
        "teamId": _string(),
        "seasonBattingInnings": _integer(),
        "otherProfileBattingInnings": _integer(),
        "derivedRole": _string(enum=["BATTER", "ALL_ROUNDER", "BOWLER", "UNKNOWN"]),
        "blockingForFoundation": {"const": False},
    })
    queue = _object({
        "schemaVersion": _string(enum=[QUEUE_SCHEMA_VERSION]),
        "roleMetadataVersion": _string(enum=[ROLE_METADATA_VERSION]),
        "scope": _string(enum=["G2_PLAYER_ROLES_AND_POSITION_FIT"]),
        "summary": _object({
            "bowlingFamilyPlayers": _integer(),
            "battingFitProfiles": _integer(),
            "foundationBlockingItems": _integer(),
        }),
        "bowlingFamilyItems": _array(family_review),
        "battingFitItems": _array(fit_review),
        "completionBoundary": _string(),
    })
    artifact = _object({
        "path": _string(), "sha256": hash_string, "sizeBytes": _integer(),
        "rows": {"type": ["integer", "null"], "minimum": 0}, "schemaVersion": _string(),
    })
    manifest = _object({
        "schemaVersion": _string(enum=[MANIFEST_SCHEMA_VERSION]),
        "roleMetadataVersion": _string(enum=[ROLE_METADATA_VERSION]),
        "trackingIssue": _string(pattern=r"https://github\.com/.+/issues/[0-9]+"),
        "stage2RegistryVersion": _string(),
        "stage2RegistryAggregateHash": hash_string,
        "stage3DatasetVersion": _string(),
        "stage3NormalizationManifestHash": hash_string,
        "stage3NormalizedMatchAggregateHash": hash_string,
        "stage4DatasetVersion": _string(),
        "stage4AnalyticalManifestHash": hash_string,
        "eligibilityVersion": _string(),
        "eligibilityManifestHash": hash_string,
        "wicketkeeperMetadataVersion": _string(),
        "wicketkeeperMetadataManifestHash": hash_string,
        "artifacts": _array(artifact),
        "schemaFiles": _array(artifact),
        "roleDataAggregateHash": hash_string,
        "roleManifestHash": hash_string,
    })
    summary_counts = _object({key: _integer() for key in (
        "canonicalPlayers", "stage4PlayerTeamSeasons", "g2Players", "g2Profiles",
        "seasonBattingObservedProfiles", "fitResolvedProfiles", "fitUnknownProfiles",
        "bowlingFamilyQueuePlayers", "qualityFieldsPresent", "keeperFieldsPresent",
    )})
    numeric_counts = _object({key: _integer() for key in (
        "HIGH", "MEDIUM", "LOW", "NONE",
    )})
    validation = _object({
        "schemaVersion": _string(enum=[VALIDATION_SCHEMA_VERSION]),
        "roleMetadataVersion": _string(enum=[ROLE_METADATA_VERSION]),
        "roleManifestHash": hash_string,
        "status": _string(enum=["passed"]),
        "baselineComparisons": _array(_object({
            "metric": _string(), "expected": _integer(), "actual": _integer(), "matches": {"type": "boolean"},
        })),
        "counts": summary_counts,
        "battingEvidenceCounts": numeric_counts,
        "battingBasisCounts": _object({key: _integer() for key in (
            "SEASON", "SEASON_PLUS_PLAYER_HISTORY", "SEASON_SPARSE",
            "PLAYER_HISTORY_FALLBACK", "UNOBSERVED",
        )}),
        "bowlingUsageCounts": _object({key: _integer() for key in (
            "NONE", "OCCASIONAL", "SUPPORT", "FRONTLINE",
        )}),
        "bowlingEvidenceCounts": numeric_counts,
        "roleCounts": _object({key: _integer() for key in (
            "BATTER", "ALL_ROUNDER", "BOWLER", "UNKNOWN",
        )}),
        "errors": _array(_string()),
    })
    return {
        "player_batting_prior.schema.json": {"$schema": "https://json-schema.org/draft/2020-12/schema", **prior},
        "player_team_season_role.schema.json": {"$schema": "https://json-schema.org/draft/2020-12/schema", **profile},
        "review_queue.schema.json": {"$schema": "https://json-schema.org/draft/2020-12/schema", **queue},
        "role_manifest.schema.json": {"$schema": "https://json-schema.org/draft/2020-12/schema", **manifest},
        "validation_report.schema.json": {"$schema": "https://json-schema.org/draft/2020-12/schema", **validation},
    }


def position_counts_to_bands(position_counts: dict[str, int]) -> dict[str, int]:
    return {
        band: sum(int(position_counts[str(position)]) for position in positions)
        for band, positions in BATTING_BANDS.items()
    }


def _rounded_fraction(value: Fraction) -> float:
    return round(float(value), 6)


def _shares(counts: dict[str, int]) -> dict[str, float | None]:
    total = sum(counts.values())
    if total == 0:
        return {band: None for band in BAND_ORDER}
    return {band: _rounded_fraction(Fraction(counts[band], total)) for band in BAND_ORDER}


def derive_batting_usage(
    season_position_counts: dict[str, int],
    career_position_counts: dict[str, int],
) -> dict[str, Any]:
    season_counts = position_counts_to_bands(season_position_counts)
    career_counts = position_counts_to_bands(career_position_counts)
    season_innings = sum(season_counts.values())
    other_counts = {band: career_counts[band] - season_counts[band] for band in BAND_ORDER}
    if any(value < 0 for value in other_counts.values()):
        raise PlayerRoleMetadataError("Season batting counts exceed the player batting prior")
    other_innings = sum(other_counts.values())
    prior_eligible = other_innings >= CAREER_PRIOR_MIN_INNINGS

    effective: dict[str, Fraction]
    if season_innings >= SEASON_ONLY_MIN_INNINGS:
        basis = "SEASON"
        prior_weight = 0
        effective = {band: Fraction(season_counts[band]) for band in BAND_ORDER}
    elif season_innings > 0 and prior_eligible:
        basis = "SEASON_PLUS_PLAYER_HISTORY"
        prior_weight = SEASON_ONLY_MIN_INNINGS - season_innings
        effective = {
            band: Fraction(season_counts[band]) + Fraction(prior_weight * other_counts[band], other_innings)
            for band in BAND_ORDER
        }
    elif season_innings > 0:
        basis = "SEASON_SPARSE"
        prior_weight = 0
        effective = {band: Fraction(season_counts[band]) for band in BAND_ORDER}
    elif prior_eligible:
        basis = "PLAYER_HISTORY_FALLBACK"
        prior_weight = SEASON_ONLY_MIN_INNINGS
        effective = {
            band: Fraction(prior_weight * other_counts[band], other_innings)
            for band in BAND_ORDER
        }
    else:
        basis = "UNOBSERVED"
        prior_weight = 0
        effective = {band: Fraction(0) for band in BAND_ORDER}

    if basis == "UNOBSERVED":
        confidence = "NONE"
        effective_shares = {band: None for band in BAND_ORDER}
        primary_bands: list[str] = []
    else:
        confidence = "HIGH" if season_innings >= 8 else "MEDIUM" if season_innings >= 4 else "LOW"
        effective_total = sum(effective.values(), Fraction(0))
        exact_shares = {band: effective[band] / effective_total for band in BAND_ORDER}
        effective_shares = {band: _rounded_fraction(exact_shares[band]) for band in BAND_ORDER}
        maximum = max(exact_shares.values())
        primary_bands = [band for band in BAND_ORDER if exact_shares[band] == maximum]

    slot_fits = []
    for position in range(1, 12):
        target_band = POSITION_TO_BAND[position]
        if not primary_bands:
            classification = "UNKNOWN"
            distance = None
        else:
            distance = min(abs(BAND_ORDER.index(target_band) - BAND_ORDER.index(primary)) for primary in primary_bands)
            if target_band in primary_bands:
                classification = "NATURAL"
            elif effective_shares[target_band] is not None and (
                effective_shares[target_band] >= float(ACCEPTABLE_BAND_SHARE) or distance == 1
            ):
                classification = "ACCEPTABLE"
            else:
                classification = "OUT_OF_ROLE"
        slot_fits.append({
            "position": position,
            "band": target_band,
            "classification": classification,
            "bandDistance": distance,
        })

    return {
        "seasonInnings": season_innings,
        "seasonPositionCounts": {str(position): int(season_position_counts[str(position)]) for position in range(1, 12)},
        "seasonBandCounts": season_counts,
        "otherProfileInnings": other_innings,
        "otherProfileBandCounts": other_counts,
        "careerPriorEligible": prior_eligible,
        "priorWeight": prior_weight,
        "effectiveBandShares": effective_shares,
        "basis": basis,
        "confidence": confidence,
        "primaryBands": primary_bands,
        "slotFits": slot_fits,
    }


def derive_bowling_usage(profile: dict[str, Any]) -> dict[str, Any]:
    official = int(profile["participation"]["officialListMatchCount"])
    matches = int(profile["bowling"]["matches"])
    legal_balls = int(profile["bowling"]["totals"]["legalBalls"])
    if official <= 0:
        raise PlayerRoleMetadataError(f"G2 profile lacks official appearances: {profile['playerTeamSeasonId']}")
    if matches > official:
        raise PlayerRoleMetadataError(f"Bowling matches exceed official appearances: {profile['playerTeamSeasonId']}")
    per_official = Fraction(legal_balls, official)
    if per_official > FULL_BOWLING_QUOTA_BALLS:
        raise PlayerRoleMetadataError(f"Bowling workload exceeds four overs per appearance: {profile['playerTeamSeasonId']}")
    capacity = per_official / FULL_BOWLING_QUOTA_BALLS
    if legal_balls == 0:
        usage_class = "NONE"
        confidence = "NONE"
    else:
        usage_class = (
            "FRONTLINE" if capacity >= FRONTLINE_BOWLING_CAPACITY
            else "SUPPORT" if capacity >= SUPPORT_BOWLING_CAPACITY
            else "OCCASIONAL"
        )
        confidence = (
            "HIGH" if legal_balls >= 120 and matches >= 5
            else "MEDIUM" if legal_balls >= 36 and matches >= 2
            else "LOW"
        )
    phases: dict[str, dict[str, Any]] = {}
    phase_total = 0
    for phase_name in ("powerplay", "middle", "death"):
        phase_balls = int(profile["bowling"]["phases"][phase_name]["legalBalls"])
        phase_total += phase_balls
        phases[phase_name] = {
            "legalBalls": phase_balls,
            "share": round(phase_balls / legal_balls, 6) if legal_balls else None,
        }
    if phase_total != legal_balls:
        raise PlayerRoleMetadataError(f"Bowling phases do not reconcile: {profile['playerTeamSeasonId']}")
    return {
        "officialAppearances": official,
        "bowlingMatches": matches,
        "legalBalls": legal_balls,
        "ballsPerOfficialAppearance": _rounded_fraction(per_official),
        "ballsPerBowlingMatch": round(legal_balls / matches, 6) if matches else None,
        "capacity": _rounded_fraction(capacity),
        "usageClass": usage_class,
        "confidence": confidence,
        "phases": phases,
    }


def derive_role_summary(batting: dict[str, Any], bowling: dict[str, Any]) -> dict[str, Any]:
    primary = set(batting["primaryBands"])
    if primary & {"OPENING", "TOP_ORDER", "MIDDLE_ORDER"}:
        responsibility = "CORE"
    elif "LOWER_ORDER" in primary:
        responsibility = "LOWER"
    elif "TAIL" in primary:
        responsibility = "TAIL"
    else:
        responsibility = "UNKNOWN"
    meaningful_bowling = bowling["usageClass"] in {"SUPPORT", "FRONTLINE"}
    meaningful_non_tail_batting = responsibility in {"CORE", "LOWER"}
    all_rounder_lean: str | None = None
    if meaningful_bowling and meaningful_non_tail_batting:
        role = "ALL_ROUNDER"
        if responsibility == "CORE" and bowling["usageClass"] == "SUPPORT":
            all_rounder_lean = "BATTING"
        elif responsibility == "LOWER" and bowling["usageClass"] == "FRONTLINE":
            all_rounder_lean = "BOWLING"
        else:
            all_rounder_lean = "BALANCED"
    elif meaningful_bowling:
        role = "BOWLER"
    elif batting["basis"] != "UNOBSERVED":
        role = "BATTER"
    else:
        role = "UNKNOWN"
    return {
        "role": role,
        "battingResponsibility": responsibility,
        "allRounderLean": all_rounder_lean,
        "isCanonical": False,
    }


def _verify_manifest_bundle(
    root: Path,
    *,
    manifest_name: str,
    manifest_hash_field: str,
    aggregate_hash_field: str,
    label: str,
) -> tuple[dict[str, Any], dict[str, bytes]]:
    _, manifest = _read_json(root / manifest_name, f"{label} manifest")
    if not isinstance(manifest, dict):
        raise PlayerRoleMetadataError(f"{label} manifest must be an object")
    payload = dict(manifest)
    recorded_hash = payload.pop(manifest_hash_field, None)
    if recorded_hash != _sha256(canonical_json_bytes(payload)):
        raise PlayerRoleMetadataError(f"{label} manifest self-hash is invalid")
    contents: dict[str, bytes] = {}
    for entry in [*manifest.get("artifacts", []), *manifest.get("schemaFiles", [])]:
        path = root / entry["path"]
        try:
            content = path.read_bytes()
        except OSError as error:
            raise PlayerRoleMetadataError(f"Could not read {label} artifact {path}: {error}") from error
        if len(content) != entry["sizeBytes"] or _sha256(content) != entry["sha256"]:
            raise PlayerRoleMetadataError(f"{label} artifact integrity failure: {entry['path']}")
        contents[entry["path"]] = content
    if _aggregate_hash(contents) != manifest.get(aggregate_hash_field):
        raise PlayerRoleMetadataError(f"{label} aggregate hash is invalid")
    return manifest, contents


def _jsonl_from_bytes(content: bytes, label: str) -> list[dict[str, Any]]:
    try:
        rows = [json.loads(line) for line in content.splitlines() if line]
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise PlayerRoleMetadataError(f"Could not parse {label}: {error}") from error
    if not all(isinstance(row, dict) for row in rows):
        raise PlayerRoleMetadataError(f"{label} must contain JSON objects")
    return rows


def _assert_unique(rows: list[dict[str, Any]], key: str, label: str) -> dict[str, dict[str, Any]]:
    indexed = {row[key]: row for row in rows}
    if len(indexed) != len(rows):
        raise PlayerRoleMetadataError(f"Duplicate {label}")
    return indexed


def _sum_position_counts(target: dict[str, int], source: dict[str, int]) -> None:
    for position in range(1, 12):
        target[str(position)] += int(source[str(position)])


def _field_names(value: Any) -> set[str]:
    if isinstance(value, dict):
        return set(value) | {field for nested in value.values() for field in _field_names(nested)}
    if isinstance(value, list):
        return {field for nested in value for field in _field_names(nested)}
    return set()


def _validate_profile_invariants(profile: dict[str, Any], source: dict[str, Any]) -> None:
    pts_id = profile["playerTeamSeasonId"]
    batting = profile["battingUsage"]
    bowling = profile["bowlingUsage"]
    if batting["seasonInnings"] != source["batting"]["innings"]:
        raise PlayerRoleMetadataError(f"Batting innings do not reconcile: {pts_id}")
    if batting["seasonPositionCounts"] != source["batting"]["positionCounts"]:
        raise PlayerRoleMetadataError(f"Batting position counts do not reconcile: {pts_id}")
    if sum(batting["seasonBandCounts"].values()) != batting["seasonInnings"]:
        raise PlayerRoleMetadataError(f"Batting band counts do not reconcile: {pts_id}")
    slot_positions = [row["position"] for row in batting["slotFits"]]
    if slot_positions != list(range(1, 12)):
        raise PlayerRoleMetadataError(f"Batting slot-fit coverage is incomplete or unordered: {pts_id}")
    if batting["slotFits"][0]["classification"] != batting["slotFits"][1]["classification"]:
        raise PlayerRoleMetadataError(f"Opening positions are not symmetric: {pts_id}")
    shares = list(batting["effectiveBandShares"].values())
    if batting["basis"] == "UNOBSERVED":
        if any(value is not None for value in shares) or batting["primaryBands"]:
            raise PlayerRoleMetadataError(f"Unobserved batting fit contains inferred evidence: {pts_id}")
    elif any(value is None for value in shares) or abs(sum(shares) - 1) > 0.000005:
        raise PlayerRoleMetadataError(f"Effective batting shares do not reconcile: {pts_id}")
    if bowling["legalBalls"] != source["bowling"]["totals"]["legalBalls"]:
        raise PlayerRoleMetadataError(f"Bowling legal balls do not reconcile: {pts_id}")
    if bowling["bowlingMatches"] != source["bowling"]["matches"]:
        raise PlayerRoleMetadataError(f"Bowling match counts do not reconcile: {pts_id}")
    if sum(row["legalBalls"] for row in bowling["phases"].values()) != bowling["legalBalls"]:
        raise PlayerRoleMetadataError(f"Bowling phase counts do not reconcile: {pts_id}")
    if profile["roleSummary"]["isCanonical"] is not False:
        raise PlayerRoleMetadataError(f"Derived role label became canonical: {pts_id}")


def _build_prior_rows(players: list[dict[str, Any]], stage4_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    counts_by_player = {
        row["playerId"]: {str(position): 0 for position in range(1, 12)}
        for row in players
    }
    profile_counts = Counter(row["playerId"] for row in stage4_rows)
    for row in stage4_rows:
        _sum_position_counts(counts_by_player[row["playerId"]], row["batting"]["positionCounts"])
    priors = []
    for player in sorted(players, key=lambda row: row["playerId"]):
        position_counts = counts_by_player[player["playerId"]]
        band_counts = position_counts_to_bands(position_counts)
        priors.append({
            "schemaVersion": PRIOR_SCHEMA_VERSION,
            "roleMetadataVersion": ROLE_METADATA_VERSION,
            "playerId": player["playerId"],
            "canonicalDisplayName": player["canonicalDisplayName"],
            "profileCount": profile_counts[player["playerId"]],
            "battingInnings": sum(position_counts.values()),
            "positionCounts": position_counts,
            "bandCounts": band_counts,
            "bandShares": _shares(band_counts),
        })
    return priors


def _baseline_comparisons(actual: dict[str, int]) -> list[dict[str, Any]]:
    return [
        {"metric": key, "expected": expected, "actual": actual[key], "matches": actual[key] == expected}
        for key, expected in EXPECTED_BASELINES.items()
    ]


def build_player_role_metadata_files(
    *,
    registry_dir: Path = Path("data/registries/ipl/v1"),
    registry_policy_path: Path = Path("data/manual/identity/v1/registry_policy.json"),
    normalized_dir: Path = Path("data/normalized/cricsheet-ipl/v1"),
    analytical_dir: Path = Path("data/analytical/cricsheet-ipl/v1"),
    eligibility_dir: Path = Path("data/processed/era-draft/v1"),
    wicketkeeper_dir: Path = Path("data/metadata/ipl/v1"),
) -> tuple[dict[str, bytes], dict[str, Any]]:
    verified_registry = load_verified_registry(registry_dir, policy_path=registry_policy_path)
    registry_manifest = verified_registry["manifest"]
    players = verified_registry["players"]
    player_by_id = _assert_unique(players, "playerId", "registry player ID")

    verified_stage3 = load_verified_normalized_dataset(normalized_dir)
    stage4_manifest, stage4_rows, _ = _load_stage4(analytical_dir)
    stage4_by_id = _assert_unique(stage4_rows, "playerTeamSeasonId", "Stage 4 profile ID")
    if stage4_manifest["stage2RegistryAggregateHash"] != registry_manifest["registryAggregateHash"]:
        raise PlayerRoleMetadataError("Stage 4 registry provenance differs from Stage 2")
    if stage4_manifest["stage3NormalizationManifestHash"] != verified_stage3.manifest["normalizationManifestHash"]:
        raise PlayerRoleMetadataError("Stage 4 normalization provenance differs from Stage 3")

    eligibility_manifest, eligibility_files = _verify_manifest_bundle(
        eligibility_dir,
        manifest_name="eligibility_manifest.json",
        manifest_hash_field="eligibilityManifestHash",
        aggregate_hash_field="eligibilityAggregateHash",
        label="eligibility",
    )
    eligibility_rows = _jsonl_from_bytes(eligibility_files["eligibility.jsonl"], "eligibility rows")
    _assert_unique(eligibility_rows, "playerTeamSeasonId", "eligibility profile ID")
    if eligibility_manifest["stage4AnalyticalManifestHash"] != stage4_manifest["analyticalManifestHash"]:
        raise PlayerRoleMetadataError("Eligibility provenance differs from Stage 4")
    g2_decisions = [row for row in eligibility_rows if row["eligibilityStatus"] == "ELIGIBLE"]
    g2_ids = {row["playerTeamSeasonId"] for row in g2_decisions}

    keeper_manifest, keeper_files = _verify_manifest_bundle(
        wicketkeeper_dir,
        manifest_name="metadata_manifest.json",
        manifest_hash_field="metadataManifestHash",
        aggregate_hash_field="metadataAggregateHash",
        label="wicketkeeper metadata",
    )
    keeper_capabilities = _jsonl_from_bytes(keeper_files["player_capabilities.jsonl"], "keeper capabilities")
    keeper_usages = _jsonl_from_bytes(keeper_files["player_team_season_usage.jsonl"], "keeper usages")
    capability_by_id = _assert_unique(keeper_capabilities, "playerId", "keeper capability player ID")
    usage_by_id = _assert_unique(keeper_usages, "playerTeamSeasonId", "keeper usage profile ID")
    if keeper_manifest["stage4AnalyticalManifestHash"] != stage4_manifest["analyticalManifestHash"]:
        raise PlayerRoleMetadataError("Wicketkeeper metadata provenance differs from Stage 4")
    if eligibility_manifest["wicketkeeperMetadataManifestHash"] != keeper_manifest["metadataManifestHash"]:
        raise PlayerRoleMetadataError("Eligibility and wicketkeeper metadata manifests differ")
    if set(capability_by_id) != set(player_by_id) or set(usage_by_id) != set(stage4_by_id):
        raise PlayerRoleMetadataError("Wicketkeeper metadata identity coverage drifted")
    if g2_ids - set(stage4_by_id):
        raise PlayerRoleMetadataError("G2 references profiles absent from Stage 4")

    prior_rows = _build_prior_rows(players, stage4_rows)
    prior_by_id = _assert_unique(prior_rows, "playerId", "batting prior player ID")
    profile_rows: list[dict[str, Any]] = []
    for pts_id in sorted(g2_ids):
        source = stage4_by_id[pts_id]
        prior = prior_by_id[source["playerId"]]
        batting = derive_batting_usage(source["batting"]["positionCounts"], prior["positionCounts"])
        bowling = derive_bowling_usage(source)
        profile = {
            "schemaVersion": PROFILE_SCHEMA_VERSION,
            "roleMetadataVersion": ROLE_METADATA_VERSION,
            **{key: source[key] for key in (
                "playerTeamSeasonId", "playerId", "canonicalDisplayName", "seasonId", "teamId", "franchiseId",
            )},
            "battingUsage": batting,
            "bowlingUsage": bowling,
            "roleSummary": derive_role_summary(batting, bowling),
        }
        _validate_profile_invariants(profile, source)
        profile_rows.append(profile)

    profiles_by_player: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in profile_rows:
        profiles_by_player[row["playerId"]].append(row)
    family_items = []
    for player_id, player_profiles in sorted(profiles_by_player.items()):
        qualifying = sorted(
            row["playerTeamSeasonId"]
            for row in player_profiles
            if row["bowlingUsage"]["legalBalls"] >= 12
        )
        if not qualifying:
            continue
        maximum = max(
            profile["bowlingUsage"]["legalBalls"]
            for profile in player_profiles
            if profile["playerTeamSeasonId"] in qualifying
        )
        family_items.append({
            "reviewId": f"bowling-family:{player_id}",
            "reviewType": "BOWLING_FAMILY",
            "reviewStatus": "PENDING",
            "playerId": player_id,
            "canonicalDisplayName": player_by_id[player_id]["canonicalDisplayName"],
            "qualifyingProfileIds": qualifying,
            "qualifyingProfileCount": len(qualifying),
            "maximumProfileLegalBalls": maximum,
            "blockingForBowlingFamilyCoverage": True,
        })
    fit_items = [{
        "reviewId": f"batting-fit:{row['playerTeamSeasonId']}",
        "reviewType": "BATTING_FIT",
        "reviewStatus": "PENDING",
        "playerTeamSeasonId": row["playerTeamSeasonId"],
        "playerId": row["playerId"],
        "canonicalDisplayName": row["canonicalDisplayName"],
        "seasonId": row["seasonId"],
        "teamId": row["teamId"],
        "seasonBattingInnings": row["battingUsage"]["seasonInnings"],
        "otherProfileBattingInnings": row["battingUsage"]["otherProfileInnings"],
        "derivedRole": row["roleSummary"]["role"],
        "blockingForFoundation": False,
    } for row in profile_rows if row["battingUsage"]["basis"] == "UNOBSERVED"]
    review_queue = {
        "schemaVersion": QUEUE_SCHEMA_VERSION,
        "roleMetadataVersion": ROLE_METADATA_VERSION,
        "scope": "G2_PLAYER_ROLES_AND_POSITION_FIT",
        "summary": {
            "bowlingFamilyPlayers": len(family_items),
            "battingFitProfiles": len(fit_items),
            "foundationBlockingItems": 0,
        },
        "bowlingFamilyItems": family_items,
        "battingFitItems": fit_items,
        "completionBoundary": (
            "The deterministic Stage 5 foundation is complete with explicit unknowns. "
            "Bowling-family assertions and optional sourced batting-fit assertions are separate enrichment work."
        ),
    }

    all_profile_fields = set().union(*(_field_names(row) for row in profile_rows))
    quality_fields = {
        "runs", "wickets", "creditedWickets", "average", "strikeRate",
        "economyPerSixBalls", "baseRating", "battingRating", "bowlingRating", "tier",
    }
    keeper_fields = {
        "isWicketkeeper", "wicketkeeperStatus", "wicketkeepingUsageStatus",
        "wicketkeepingCapabilityStatus",
    }
    actual = {
        "canonicalPlayers": len(players),
        "stage4PlayerTeamSeasons": len(stage4_rows),
        "g2Players": len({row["playerId"] for row in profile_rows}),
        "g2Profiles": len(profile_rows),
        "seasonBattingObservedProfiles": sum(row["battingUsage"]["seasonInnings"] > 0 for row in profile_rows),
        "fitResolvedProfiles": sum(row["battingUsage"]["basis"] != "UNOBSERVED" for row in profile_rows),
        "fitUnknownProfiles": len(fit_items),
        "bowlingFamilyQueuePlayers": len(family_items),
        "qualityFieldsPresent": len(all_profile_fields & quality_fields),
        "keeperFieldsPresent": len(all_profile_fields & keeper_fields),
    }
    comparisons = _baseline_comparisons(actual)
    if any(not comparison["matches"] for comparison in comparisons):
        raise PlayerRoleMetadataError(f"Stage 5 baseline drift: {comparisons}")

    schemas = build_role_schemas()
    try:
        for index, row in enumerate(prior_rows):
            validate_instance(row, schemas["player_batting_prior.schema.json"], f"prior[{index}]")
        for index, row in enumerate(profile_rows):
            validate_instance(row, schemas["player_team_season_role.schema.json"], f"profile[{index}]")
        validate_instance(review_queue, schemas["review_queue.schema.json"], "reviewQueue")
    except SchemaValidationError as error:
        raise PlayerRoleMetadataError(f"Stage 5 output schema failure: {error}") from error

    files: dict[str, bytes] = {
        "player_batting_priors.jsonl": _jsonl_bytes(prior_rows),
        "player_team_season_roles.jsonl": _jsonl_bytes(profile_rows),
        "review_queue.json": pretty_json_bytes(review_queue),
    }
    for name, schema in schemas.items():
        files[f"schemas/{name}"] = pretty_json_bytes(schema)
    artifact_entries = [
        _artifact_entry("player_batting_priors.jsonl", files["player_batting_priors.jsonl"], PRIOR_SCHEMA_VERSION, len(prior_rows)),
        _artifact_entry("player_team_season_roles.jsonl", files["player_team_season_roles.jsonl"], PROFILE_SCHEMA_VERSION, len(profile_rows)),
        _artifact_entry("review_queue.json", files["review_queue.json"], QUEUE_SCHEMA_VERSION, len(family_items) + len(fit_items)),
    ]
    schema_entries = [
        _artifact_entry(path, content, "json-schema/2020-12", None)
        for path, content in sorted(files.items()) if path.startswith("schemas/")
    ]
    manifest = {
        "schemaVersion": MANIFEST_SCHEMA_VERSION,
        "roleMetadataVersion": ROLE_METADATA_VERSION,
        "trackingIssue": ISSUE_URL,
        "stage2RegistryVersion": registry_manifest["registryVersion"],
        "stage2RegistryAggregateHash": registry_manifest["registryAggregateHash"],
        "stage3DatasetVersion": verified_stage3.manifest["datasetVersion"],
        "stage3NormalizationManifestHash": verified_stage3.manifest["normalizationManifestHash"],
        "stage3NormalizedMatchAggregateHash": verified_stage3.manifest["normalizedMatchAggregateHash"],
        "stage4DatasetVersion": stage4_manifest["datasetVersion"],
        "stage4AnalyticalManifestHash": stage4_manifest["analyticalManifestHash"],
        "eligibilityVersion": eligibility_manifest["eligibilityVersion"],
        "eligibilityManifestHash": eligibility_manifest["eligibilityManifestHash"],
        "wicketkeeperMetadataVersion": keeper_manifest["metadataVersion"],
        "wicketkeeperMetadataManifestHash": keeper_manifest["metadataManifestHash"],
        "artifacts": artifact_entries,
        "schemaFiles": schema_entries,
        "roleDataAggregateHash": _aggregate_hash(files),
    }
    manifest["roleManifestHash"] = _sha256(canonical_json_bytes(manifest))
    try:
        validate_instance(manifest, schemas["role_manifest.schema.json"], "roleManifest")
    except SchemaValidationError as error:
        raise PlayerRoleMetadataError(f"Stage 5 manifest schema failure: {error}") from error
    files["role_manifest.json"] = pretty_json_bytes(manifest)

    batting_evidence = Counter(row["battingUsage"]["confidence"] for row in profile_rows)
    batting_basis = Counter(row["battingUsage"]["basis"] for row in profile_rows)
    bowling_usage = Counter(row["bowlingUsage"]["usageClass"] for row in profile_rows)
    bowling_evidence = Counter(row["bowlingUsage"]["confidence"] for row in profile_rows)
    roles = Counter(row["roleSummary"]["role"] for row in profile_rows)
    validation_report = {
        "schemaVersion": VALIDATION_SCHEMA_VERSION,
        "roleMetadataVersion": ROLE_METADATA_VERSION,
        "roleManifestHash": manifest["roleManifestHash"],
        "status": "passed",
        "baselineComparisons": comparisons,
        "counts": actual,
        "battingEvidenceCounts": {key: batting_evidence[key] for key in ("HIGH", "MEDIUM", "LOW", "NONE")},
        "battingBasisCounts": {key: batting_basis[key] for key in (
            "SEASON", "SEASON_PLUS_PLAYER_HISTORY", "SEASON_SPARSE", "PLAYER_HISTORY_FALLBACK", "UNOBSERVED",
        )},
        "bowlingUsageCounts": {key: bowling_usage[key] for key in ("NONE", "OCCASIONAL", "SUPPORT", "FRONTLINE")},
        "bowlingEvidenceCounts": {key: bowling_evidence[key] for key in ("HIGH", "MEDIUM", "LOW", "NONE")},
        "roleCounts": {key: roles[key] for key in ("BATTER", "ALL_ROUNDER", "BOWLER", "UNKNOWN")},
        "errors": [],
    }
    try:
        validate_instance(validation_report, schemas["validation_report.schema.json"], "validationReport")
    except SchemaValidationError as error:
        raise PlayerRoleMetadataError(f"Stage 5 validation-report schema failure: {error}") from error
    files["validation_report.json"] = pretty_json_bytes(validation_report)
    files["SUMMARY.md"] = "\n".join([
        "# Era Draft Player Roles and Position Fit v1", "",
        f"Tracking issue: [#1]({ISSUE_URL})", "",
        f"Role manifest SHA-256: `{manifest['roleManifestHash']}`", "",
        "## Coverage", "",
        f"- G2 player-team-season profiles: {actual['g2Profiles']:,}",
        f"- G2 canonical players: {actual['g2Players']:,}",
        f"- Profiles with observed season batting positions: {actual['seasonBattingObservedProfiles']:,}",
        f"- Profiles with resolved position fit: {actual['fitResolvedProfiles']:,}",
        f"- Profiles with unknown position fit: {actual['fitUnknownProfiles']:,}", "",
        "## Bowling usage", "",
        *[f"- {key.title()}: {bowling_usage[key]:,}" for key in ("FRONTLINE", "SUPPORT", "OCCASIONAL", "NONE")], "",
        "## Review boundary", "",
        f"- Bowling-family research players: {len(family_items):,}",
        f"- Optional batting-fit research profiles: {len(fit_items):,}",
        "- No bowling-family assertions are included in this deterministic foundation.",
        "- Wicketkeeper capability and usage remain owned by the frozen wicketkeeper metadata family.",
        "- Classic 2016 artifacts and consumers are not modified.", "",
    ]).encode("utf-8")
    return files, validation_report


__all__ = [
    "BATTING_BANDS",
    "PlayerRoleMetadataError",
    "build_player_role_metadata_files",
    "build_role_schemas",
    "derive_batting_usage",
    "derive_bowling_usage",
    "derive_role_summary",
    "position_counts_to_bands",
    "write_artifact_tree",
]
