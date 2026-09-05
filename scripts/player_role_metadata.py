from __future__ import annotations

import hashlib
import json
import re
import unicodedata
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
BOWLING_FAMILY_METADATA_SCHEMA_VERSION = "ipl-era-draft-bowling-family-manual/v1"
PLAYER_BOWLING_FAMILY_SCHEMA_VERSION = "ipl-era-draft-player-bowling-family/v1"
CONSUMER_SCHEMA_VERSION = "ipl-era-draft-player-role-consumer/v1"
WICKETKEEPER_METADATA_VERSION = "ipl-wicketkeeper-metadata/v1"

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

BOWLING_FAMILIES = ("PACE", "SPIN", "MIXED", "UNKNOWN")
DERIVED_ROLES = ("BATTER", "WICKETKEEPER_BATTER", "ALL_ROUNDER", "BOWLER", "UNKNOWN")
ALL_ROUNDER_LEANS = ("BATTING", "BOWLING", "BALANCED")
BOWLING_FAMILY_SOURCE_TYPES = (
    "OFFICIAL_IPL_BCCI",
    "NATIONAL_CRICKET_BOARD",
    "ESPNCRICINFO",
    "STRONG_CRICKET_REFERENCE",
)

# Closed mapping of normalized, explicitly stated bowling styles. New source
# vocabulary must be reviewed and added here; unknown text never falls through
# to a heuristic family guess.
BOWLING_STYLE_FAMILY_MAP = {
    "left arm fast": "PACE",
    "left arm fast medium": "PACE",
    "left arm medium": "PACE",
    "left arm medium fast": "PACE",
    "left arm pace": "PACE",
    "right arm fast": "PACE",
    "right arm fast medium": "PACE",
    "right arm medium": "PACE",
    "right arm medium fast": "PACE",
    "right arm pace": "PACE",
    "fast": "PACE",
    "fast medium": "PACE",
    "medium": "PACE",
    "medium fast": "PACE",
    "pace": "PACE",
    "seam": "PACE",
    "left arm chinaman": "SPIN",
    "left arm orthodox": "SPIN",
    "left arm unorthodox": "SPIN",
    "left arm wrist spin": "SPIN",
    "legbreak": "SPIN",
    "legbreak googly": "SPIN",
    "off break": "SPIN",
    "off spin": "SPIN",
    "offbreak": "SPIN",
    "right arm legbreak": "SPIN",
    "right arm legbreak googly": "SPIN",
    "right arm off break": "SPIN",
    "right arm off spin": "SPIN",
    "right arm offbreak": "SPIN",
    "slow left arm chinaman": "SPIN",
    "slow left arm orthodox": "SPIN",
    "slow left arm wrist spin": "SPIN",
}

EXPECTED_BASELINES = {
    "canonicalPlayers": 816,
    "stage4PlayerTeamSeasons": 3392,
    "g2Players": 727,
    "g2Profiles": 2992,
    "seasonBattingObservedProfiles": 2776,
    "fitResolvedProfiles": 2901,
    "fitUnknownProfiles": 91,
    "bowlingFamilyResearchPlayers": 505,
    "bowlingFamilyQueuePlayers": 0,
    "consumerProfiles": 2992,
    "qualityFieldsPresent": 0,
    "keeperFieldsPresent": 0,
}


class PlayerRoleMetadataError(ValueError):
    pass


def normalize_bowling_style_text(raw_style: str) -> str:
    normalized = unicodedata.normalize("NFKC", raw_style).casefold()
    normalized = normalized.replace("&", " and ")
    normalized = re.sub(r"[\u2010-\u2015_/]+", " ", normalized)
    normalized = re.sub(r"[^a-z0-9 ]+", " ", normalized)
    return " ".join(normalized.split())


def normalize_bowling_family(raw_styles: Iterable[str]) -> str:
    styles = [style for style in raw_styles if isinstance(style, str) and style.strip()]
    if not styles:
        return "UNKNOWN"
    families = {
        BOWLING_STYLE_FAMILY_MAP.get(normalize_bowling_style_text(style))
        for style in styles
    }
    if None in families:
        return "UNKNOWN"
    if families == {"PACE", "SPIN"}:
        return "MIXED"
    if len(families) == 1:
        return next(iter(families))
    return "UNKNOWN"


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
    bowling_family = _string(enum=BOWLING_FAMILIES)
    source_family = _string(enum=BOWLING_FAMILY_SOURCE_TYPES)
    family_evidence_ref = _object({
        "sourceId": _string(),
        "sourceFamily": source_family,
        "url": _string(pattern=r"https://.+"),
        "locator": _string(),
        "observedValues": {**_array(_string(), unique=True), "minItems": 1},
        "contentSha256": hash_string,
    })
    family_assertion = _object({
        "assertionId": _string(),
        "playerId": _string(pattern=r"[0-9a-f]{8}"),
        "canonicalDisplayName": _string(),
        "bowlingFamily": bowling_family,
        "resolutionStatus": _string(enum=["APPROVED", "UNKNOWN", "PENDING", "CONFLICT"]),
        "rawBowlingStyles": _array(_string(), unique=True),
        "identityMatch": _object({
            "method": _string(enum=["CRICSHEET_REGISTER_EXACT_EXTERNAL_ID", "MANUAL_MULTI_FIELD_MATCH"]),
            "cricsheetId": _string(pattern=r"[0-9a-f]{8}"),
            "externalPlayerId": _string(),
            "registerName": _string(),
            "sourcePlayerName": _string(),
            "sourceDateOfBirth": _string(nullable=True),
        }),
        "evidenceRefs": {**_array(family_evidence_ref), "minItems": 1},
        "notes": _string(),
    })
    season_override = _object({
        "overrideId": _string(),
        "playerId": _string(pattern=r"[0-9a-f]{8}"),
        "seasonIds": {**_array(_string(pattern=r"ipl-[0-9]{4}"), unique=True), "minItems": 1},
        "bowlingFamily": bowling_family,
        "resolutionStatus": _string(enum=["APPROVED", "UNKNOWN", "PENDING", "CONFLICT"]),
        "rawBowlingStyles": _array(_string(), unique=True),
        "evidenceRefs": {**_array(family_evidence_ref), "minItems": 1},
        "notes": _string(),
    })
    family_source = _object({
        "sourceId": _string(),
        "sourceFamily": _string(enum=["IDENTITY_REGISTER", *BOWLING_FAMILY_SOURCE_TYPES]),
        "publisher": _string(),
        "title": _string(),
        "url": _string(pattern=r"https://.+"),
        "accessedDate": _string(pattern=r"[0-9]{4}-[0-9]{2}-[0-9]{2}"),
        "contentSha256": hash_string,
        "locator": _string(),
    })
    family_metadata = _object({
        "schemaVersion": _string(enum=[BOWLING_FAMILY_METADATA_SCHEMA_VERSION]),
        "roleMetadataVersion": _string(enum=[ROLE_METADATA_VERSION]),
        "trackingIssue": _string(pattern=r"https://github\.com/.+/issues/[0-9]+"),
        "sources": {**_array(family_source), "minItems": 2},
        "playerDefaults": _array(family_assertion),
        "seasonOverrides": _array(season_override),
        "metadataHash": hash_string,
    })
    resolved_family = _object({
        "schemaVersion": _string(enum=[PLAYER_BOWLING_FAMILY_SCHEMA_VERSION]),
        "roleMetadataVersion": _string(enum=[ROLE_METADATA_VERSION]),
        "assertionId": _string(),
        "playerId": _string(pattern=r"[0-9a-f]{8}"),
        "canonicalDisplayName": _string(),
        "bowlingFamily": bowling_family,
        "resolutionStatus": _string(enum=["APPROVED", "UNKNOWN", "PENDING", "CONFLICT"]),
        "rawBowlingStyles": _array(_string(), unique=True),
        "identityResolutionMethod": _string(enum=["CRICSHEET_REGISTER_EXACT_EXTERNAL_ID", "MANUAL_MULTI_FIELD_MATCH"]),
        "externalPlayerId": _string(),
        "evidenceRefs": {**_array(family_evidence_ref), "minItems": 1},
        "seasonOverrides": _array(season_override),
    })
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
            "role": _string(enum=DERIVED_ROLES),
            "battingResponsibility": _string(enum=["CORE", "LOWER", "TAIL", "UNKNOWN"]),
            "allRounderLean": _string(enum=ALL_ROUNDER_LEANS, nullable=True),
            "isCanonical": {"const": False},
        }),
    })
    consumer_slot_fit = _object({
        "position": {"type": "integer", "minimum": 1, "maximum": 11},
        "slotBand": band,
        "classification": _string(enum=["NATURAL", "ACCEPTABLE", "OUT_OF_ROLE", "UNKNOWN"]),
        "bandDistance": {"type": ["integer", "null"], "minimum": 0, "maximum": 4},
    })
    consumer = _object({
        "schemaVersion": _string(enum=[CONSUMER_SCHEMA_VERSION]),
        "roleMetadataVersion": _string(enum=[ROLE_METADATA_VERSION]),
        "playerTeamSeasonId": _string(pattern=r"pts:[^:]+:[^:]+:[^:]+"),
        "playerId": _string(pattern=r"[0-9a-f]{8}"),
        "canonicalDisplayName": _string(),
        "seasonId": _string(pattern=r"ipl-[0-9]{4}"),
        "teamId": _string(),
        "franchiseId": _string(),
        "derivedRole": _string(enum=DERIVED_ROLES),
        "allRounderLean": _string(enum=ALL_ROUNDER_LEANS, nullable=True),
        "battingFit": _object({
            "confidence": evidence,
            "basis": _string(enum=[
                "SEASON", "SEASON_PLUS_PLAYER_HISTORY", "SEASON_SPARSE",
                "PLAYER_HISTORY_FALLBACK", "UNOBSERVED",
            ]),
            "primaryBands": _array(band, unique=True),
            "slots": {**_array(consumer_slot_fit, unique=True), "minItems": 11, "maxItems": 11},
        }),
        "bowlingCapacity": _number(minimum=0, maximum=1),
        "bowlingWorkloadClass": _string(enum=["NONE", "OCCASIONAL", "SUPPORT", "FRONTLINE"]),
        "bowlingEvidence": evidence,
        "bowlingFamily": bowling_family,
        "phaseBowlingUsage": _object({phase_name: phase for phase_name in ("powerplay", "middle", "death")}),
        "keeperMetadata": _object({
            "metadataVersion": _string(enum=[WICKETKEEPER_METADATA_VERSION]),
            "capabilityStatus": _string(enum=["CONFIRMED", "UNKNOWN"]),
            "capabilityPlayerId": _string(pattern=r"[0-9a-f]{8}"),
            "seasonUsageStatus": _string(enum=["CONFIRMED", "UNKNOWN"]),
            "seasonUsagePlayerTeamSeasonId": _string(pattern=r"pts:[^:]+:[^:]+:[^:]+"),
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
        "derivedRole": _string(enum=DERIVED_ROLES),
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
        "bowlingFamilyMetadataSchemaVersion": _string(enum=[BOWLING_FAMILY_METADATA_SCHEMA_VERSION]),
        "bowlingFamilyMetadataHash": hash_string,
        "artifacts": _array(artifact),
        "schemaFiles": _array(artifact),
        "roleDataAggregateHash": hash_string,
        "roleManifestHash": hash_string,
    })
    summary_counts = _object({key: _integer() for key in (
        "canonicalPlayers", "stage4PlayerTeamSeasons", "g2Players", "g2Profiles",
        "seasonBattingObservedProfiles", "fitResolvedProfiles", "fitUnknownProfiles",
        "bowlingFamilyResearchPlayers", "bowlingFamilyResolvedPlayers",
        "bowlingFamilyQueuePlayers", "consumerProfiles", "qualityFieldsPresent", "keeperFieldsPresent",
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
        "bowlingFamilyCounts": _object({key: _integer() for key in BOWLING_FAMILIES}),
        "bowlingFamilySourceCounts": _object({key: _integer() for key in BOWLING_FAMILY_SOURCE_TYPES}),
        "roleCounts": _object({key: _integer() for key in DERIVED_ROLES}),
        "allRounderLeanCounts": _object({key: _integer() for key in (*ALL_ROUNDER_LEANS, "NONE")}),
        "errors": _array(_string()),
    })
    return {
        "bowling_family_metadata.schema.json": {"$schema": "https://json-schema.org/draft/2020-12/schema", **family_metadata},
        "player_bowling_family.schema.json": {"$schema": "https://json-schema.org/draft/2020-12/schema", **resolved_family},
        "player_role_consumer.schema.json": {"$schema": "https://json-schema.org/draft/2020-12/schema", **consumer},
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


def derive_role_summary(
    batting: dict[str, Any],
    bowling: dict[str, Any],
    keeper_season_usage_status: str = "UNKNOWN",
) -> dict[str, Any]:
    if keeper_season_usage_status not in {"CONFIRMED", "UNKNOWN"}:
        raise PlayerRoleMetadataError(f"Unknown wicketkeeper season-usage status: {keeper_season_usage_status}")
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
    elif keeper_season_usage_status == "CONFIRMED":
        role = "WICKETKEEPER_BATTER"
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


def _resolved_bowling_family(family: dict[str, Any] | None, season_id: str) -> str:
    if family is None:
        return "UNKNOWN"
    resolved = family["bowlingFamily"] if family["resolutionStatus"] == "APPROVED" else "UNKNOWN"
    for override in family["seasonOverrides"]:
        if season_id in override["seasonIds"]:
            return override["bowlingFamily"] if override["resolutionStatus"] == "APPROVED" else "UNKNOWN"
    return resolved


def build_player_role_consumer_row(
    profile: dict[str, Any],
    family: dict[str, Any] | None,
    keeper_capability: dict[str, Any],
    keeper_usage: dict[str, Any],
) -> dict[str, Any]:
    player_id = profile["playerId"]
    pts_id = profile["playerTeamSeasonId"]
    if keeper_capability["playerId"] != player_id:
        raise PlayerRoleMetadataError(f"Keeper capability identity mismatch for {pts_id}")
    if keeper_usage["playerId"] != player_id or keeper_usage["playerTeamSeasonId"] != pts_id:
        raise PlayerRoleMetadataError(f"Keeper usage identity mismatch for {pts_id}")
    if (
        keeper_capability["metadataVersion"] != WICKETKEEPER_METADATA_VERSION
        or keeper_usage["metadataVersion"] != WICKETKEEPER_METADATA_VERSION
    ):
        raise PlayerRoleMetadataError(f"Keeper metadata version mismatch for {pts_id}")
    if family is not None and family["playerId"] != player_id:
        raise PlayerRoleMetadataError(f"Bowling-family identity mismatch for {pts_id}")
    if profile["bowlingUsage"]["legalBalls"] >= 12 and family is None:
        raise PlayerRoleMetadataError(f"Meaningful bowler lacks researched bowling family: {pts_id}")

    batting = profile["battingUsage"]
    bowling = profile["bowlingUsage"]
    role = profile["roleSummary"]
    return {
        "schemaVersion": CONSUMER_SCHEMA_VERSION,
        "roleMetadataVersion": ROLE_METADATA_VERSION,
        **{key: profile[key] for key in (
            "playerTeamSeasonId", "playerId", "canonicalDisplayName", "seasonId", "teamId", "franchiseId",
        )},
        "derivedRole": role["role"],
        "allRounderLean": role["allRounderLean"],
        "battingFit": {
            "confidence": batting["confidence"],
            "basis": batting["basis"],
            "primaryBands": deepcopy(batting["primaryBands"]),
            "slots": [{
                "position": slot["position"],
                "slotBand": slot["band"],
                "classification": slot["classification"],
                "bandDistance": slot["bandDistance"],
            } for slot in batting["slotFits"]],
        },
        "bowlingCapacity": bowling["capacity"],
        "bowlingWorkloadClass": bowling["usageClass"],
        "bowlingEvidence": bowling["confidence"],
        "bowlingFamily": _resolved_bowling_family(family, profile["seasonId"]),
        "phaseBowlingUsage": deepcopy(bowling["phases"]),
        "keeperMetadata": {
            "metadataVersion": keeper_capability["metadataVersion"],
            "capabilityStatus": keeper_capability["status"],
            "capabilityPlayerId": keeper_capability["playerId"],
            "seasonUsageStatus": keeper_usage["status"],
            "seasonUsagePlayerTeamSeasonId": keeper_usage["playerTeamSeasonId"],
        },
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


def _validate_family_resolution(
    assertion: dict[str, Any],
    *,
    label: str,
    sources_by_id: dict[str, dict[str, Any]],
) -> None:
    raw_styles = assertion["rawBowlingStyles"]
    normalized = normalize_bowling_family(raw_styles)
    family = assertion["bowlingFamily"]
    status = assertion["resolutionStatus"]
    evidence_families: set[str] = set()
    has_single_source_mixed_evidence = False
    for evidence in assertion["evidenceRefs"]:
        source = sources_by_id.get(evidence["sourceId"])
        if source is None:
            raise PlayerRoleMetadataError(f"{label} references unknown source {evidence['sourceId']}")
        if evidence["sourceFamily"] != source["sourceFamily"]:
            raise PlayerRoleMetadataError(f"{label} source-family provenance disagrees for {evidence['sourceId']}")
        observed = [value for value in evidence["observedValues"] if value != "<missing>"]
        evidence_family = normalize_bowling_family(observed)
        if evidence_family != "UNKNOWN":
            evidence_families.add(evidence_family)
        if evidence_family == "MIXED":
            has_single_source_mixed_evidence = True

    cross_family_disagreement = {"PACE", "SPIN"}.issubset(evidence_families)
    if cross_family_disagreement and not has_single_source_mixed_evidence and status != "CONFLICT":
        raise PlayerRoleMetadataError(f"{label} contains a cross-family disagreement that is not CONFLICT")
    if status == "APPROVED":
        if family == "UNKNOWN" or normalized != family:
            raise PlayerRoleMetadataError(f"{label} approved family does not match the closed style lookup")
        if family == "MIXED" and not has_single_source_mixed_evidence:
            raise PlayerRoleMetadataError(f"{label} MIXED lacks explicit mixed-family evidence in one source")
    elif family != "UNKNOWN":
        raise PlayerRoleMetadataError(f"{label} unresolved status must retain UNKNOWN family")


def _load_bowling_family_metadata(
    path: Path,
    *,
    schemas: dict[str, dict[str, Any]],
    research_items: list[dict[str, Any]],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    _, metadata = _read_json(path, "bowling-family metadata")
    if not isinstance(metadata, dict):
        raise PlayerRoleMetadataError("Bowling-family metadata must be an object")
    try:
        validate_instance(metadata, schemas["bowling_family_metadata.schema.json"], "bowlingFamilyMetadata")
    except SchemaValidationError as error:
        raise PlayerRoleMetadataError(f"Bowling-family metadata schema failure: {error}") from error
    payload = deepcopy(metadata)
    recorded_hash = payload.pop("metadataHash")
    if recorded_hash != _sha256(canonical_json_bytes(payload)):
        raise PlayerRoleMetadataError("Bowling-family metadata self-hash is invalid")

    sources_by_id = _assert_unique(metadata["sources"], "sourceId", "bowling-family source ID")
    assertions_by_id = _assert_unique(metadata["playerDefaults"], "playerId", "bowling-family player default")
    if len({row["assertionId"] for row in metadata["playerDefaults"]}) != len(metadata["playerDefaults"]):
        raise PlayerRoleMetadataError("Duplicate bowling-family assertion ID")
    expected_players = {item["playerId"]: item for item in research_items}
    if set(assertions_by_id) != set(expected_players):
        missing = sorted(set(expected_players) - set(assertions_by_id))
        extra = sorted(set(assertions_by_id) - set(expected_players))
        raise PlayerRoleMetadataError(
            f"Bowling-family defaults do not exactly cover the 505-player research universe; missing={missing}, extra={extra}"
        )

    for player_id, assertion in assertions_by_id.items():
        expected = expected_players[player_id]
        identity = assertion["identityMatch"]
        if identity["cricsheetId"] != player_id:
            raise PlayerRoleMetadataError(f"Bowling-family identity bridge disagrees for {player_id}")
        if assertion["canonicalDisplayName"] != expected["canonicalDisplayName"]:
            raise PlayerRoleMetadataError(f"Bowling-family canonical name drifted for {player_id}")
        if identity["method"] == "CRICSHEET_REGISTER_EXACT_EXTERNAL_ID" and not identity["externalPlayerId"].isdigit():
            raise PlayerRoleMetadataError(f"Exact external-ID bridge is invalid for {player_id}")
        _validate_family_resolution(assertion, label=f"bowling-family default {player_id}", sources_by_id=sources_by_id)

    overrides_by_player: dict[str, list[dict[str, Any]]] = defaultdict(list)
    override_ids: set[str] = set()
    override_seasons: set[tuple[str, str]] = set()
    for override in metadata["seasonOverrides"]:
        player_id = override["playerId"]
        if player_id not in assertions_by_id:
            raise PlayerRoleMetadataError(f"Bowling-family override references an unscoped player: {player_id}")
        if override["overrideId"] in override_ids:
            raise PlayerRoleMetadataError(f"Duplicate bowling-family override ID: {override['overrideId']}")
        override_ids.add(override["overrideId"])
        for season_id in override["seasonIds"]:
            key = (player_id, season_id)
            if key in override_seasons:
                raise PlayerRoleMetadataError(f"Overlapping bowling-family season override: {player_id} {season_id}")
            override_seasons.add(key)
            if season_id not in {profile_id.split(":")[2] for profile_id in expected_players[player_id]["qualifyingProfileIds"]}:
                raise PlayerRoleMetadataError(f"Bowling-family override is outside qualifying G2 profiles: {player_id} {season_id}")
        _validate_family_resolution(override, label=f"bowling-family override {override['overrideId']}", sources_by_id=sources_by_id)
        overrides_by_player[player_id].append(override)

    resolved_rows: list[dict[str, Any]] = []
    for player_id, assertion in sorted(assertions_by_id.items()):
        resolved_rows.append({
            "schemaVersion": PLAYER_BOWLING_FAMILY_SCHEMA_VERSION,
            "roleMetadataVersion": ROLE_METADATA_VERSION,
            "assertionId": assertion["assertionId"],
            "playerId": player_id,
            "canonicalDisplayName": assertion["canonicalDisplayName"],
            "bowlingFamily": assertion["bowlingFamily"],
            "resolutionStatus": assertion["resolutionStatus"],
            "rawBowlingStyles": assertion["rawBowlingStyles"],
            "identityResolutionMethod": assertion["identityMatch"]["method"],
            "externalPlayerId": assertion["identityMatch"]["externalPlayerId"],
            "evidenceRefs": assertion["evidenceRefs"],
            "seasonOverrides": sorted(overrides_by_player[player_id], key=lambda row: row["overrideId"]),
        })
    return metadata, resolved_rows


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
    if (profile["roleSummary"]["role"] == "ALL_ROUNDER") != (profile["roleSummary"]["allRounderLean"] is not None):
        raise PlayerRoleMetadataError(f"All-rounder lean does not match derived role: {pts_id}")


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
    bowling_family_metadata_path: Path = Path("data/manual/player_role_metadata/v1/bowling_families.json"),
) -> tuple[dict[str, bytes], dict[str, Any]]:
    schemas = build_role_schemas()
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
    if keeper_manifest["metadataVersion"] != WICKETKEEPER_METADATA_VERSION:
        raise PlayerRoleMetadataError("Wicketkeeper metadata version is unsupported by the Stage 5 consumer contract")
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
            "roleSummary": derive_role_summary(
                batting,
                bowling,
                usage_by_id[pts_id]["status"],
            ),
        }
        _validate_profile_invariants(profile, source)
        profile_rows.append(profile)

    profiles_by_player: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in profile_rows:
        profiles_by_player[row["playerId"]].append(row)
    family_research_items = []
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
        family_research_items.append({
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
    bowling_family_metadata, bowling_family_rows = _load_bowling_family_metadata(
        bowling_family_metadata_path,
        schemas=schemas,
        research_items=family_research_items,
    )
    family_by_id = {row["playerId"]: row for row in bowling_family_rows}
    family_items = [
        item for item in family_research_items
        if family_by_id[item["playerId"]]["resolutionStatus"] != "APPROVED"
        or family_by_id[item["playerId"]]["bowlingFamily"] == "UNKNOWN"
    ]
    consumer_rows = [
        build_player_role_consumer_row(
            profile,
            family_by_id.get(profile["playerId"]),
            capability_by_id[profile["playerId"]],
            usage_by_id[profile["playerTeamSeasonId"]],
        )
        for profile in profile_rows
    ]
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
            "Stage 5 role, fit, workload, bowling-family and consumer-contract work is complete. "
            "Optional batting-fit UNKNOWN items remain neutral descriptive evidence and are not blocking."
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
        "bowlingFamilyResearchPlayers": len(family_research_items),
        "bowlingFamilyResolvedPlayers": sum(row["resolutionStatus"] == "APPROVED" for row in bowling_family_rows),
        "bowlingFamilyQueuePlayers": len(family_items),
        "consumerProfiles": len(consumer_rows),
        "qualityFieldsPresent": len(all_profile_fields & quality_fields),
        "keeperFieldsPresent": len(all_profile_fields & keeper_fields),
    }
    comparisons = _baseline_comparisons(actual)
    if any(not comparison["matches"] for comparison in comparisons):
        raise PlayerRoleMetadataError(f"Stage 5 baseline drift: {comparisons}")

    try:
        for index, row in enumerate(prior_rows):
            validate_instance(row, schemas["player_batting_prior.schema.json"], f"prior[{index}]")
        for index, row in enumerate(profile_rows):
            validate_instance(row, schemas["player_team_season_role.schema.json"], f"profile[{index}]")
        for index, row in enumerate(bowling_family_rows):
            validate_instance(row, schemas["player_bowling_family.schema.json"], f"bowlingFamily[{index}]")
        for index, row in enumerate(consumer_rows):
            validate_instance(row, schemas["player_role_consumer.schema.json"], f"consumer[{index}]")
        validate_instance(review_queue, schemas["review_queue.schema.json"], "reviewQueue")
    except SchemaValidationError as error:
        raise PlayerRoleMetadataError(f"Stage 5 output schema failure: {error}") from error

    files: dict[str, bytes] = {
        "player_batting_priors.jsonl": _jsonl_bytes(prior_rows),
        "player_team_season_roles.jsonl": _jsonl_bytes(profile_rows),
        "player_bowling_families.jsonl": _jsonl_bytes(bowling_family_rows),
        "player_role_consumer.jsonl": _jsonl_bytes(consumer_rows),
        "review_queue.json": pretty_json_bytes(review_queue),
    }
    for name, schema in schemas.items():
        files[f"schemas/{name}"] = pretty_json_bytes(schema)
    artifact_entries = [
        _artifact_entry("player_batting_priors.jsonl", files["player_batting_priors.jsonl"], PRIOR_SCHEMA_VERSION, len(prior_rows)),
        _artifact_entry("player_team_season_roles.jsonl", files["player_team_season_roles.jsonl"], PROFILE_SCHEMA_VERSION, len(profile_rows)),
        _artifact_entry("player_bowling_families.jsonl", files["player_bowling_families.jsonl"], PLAYER_BOWLING_FAMILY_SCHEMA_VERSION, len(bowling_family_rows)),
        _artifact_entry("player_role_consumer.jsonl", files["player_role_consumer.jsonl"], CONSUMER_SCHEMA_VERSION, len(consumer_rows)),
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
        "bowlingFamilyMetadataSchemaVersion": bowling_family_metadata["schemaVersion"],
        "bowlingFamilyMetadataHash": bowling_family_metadata["metadataHash"],
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
    bowling_families = Counter(row["bowlingFamily"] for row in bowling_family_rows)
    bowling_sources = Counter()
    for row in bowling_family_rows:
        for source_family in {evidence["sourceFamily"] for evidence in row["evidenceRefs"]}:
            bowling_sources[source_family] += 1
    roles = Counter(row["roleSummary"]["role"] for row in profile_rows)
    all_rounder_leans = Counter(row["roleSummary"]["allRounderLean"] or "NONE" for row in profile_rows)
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
        "bowlingFamilyCounts": {key: bowling_families[key] for key in BOWLING_FAMILIES},
        "bowlingFamilySourceCounts": {key: bowling_sources[key] for key in BOWLING_FAMILY_SOURCE_TYPES},
        "roleCounts": {key: roles[key] for key in DERIVED_ROLES},
        "allRounderLeanCounts": {key: all_rounder_leans[key] for key in (*ALL_ROUNDER_LEANS, "NONE")},
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
        "## Bowling family", "",
        *[f"- {key.title()}: {bowling_families[key]:,}" for key in BOWLING_FAMILIES], "",
        "## Derived presentation roles", "",
        *[f"- {key.replace('_', ' ').title()}: {roles[key]:,}" for key in DERIVED_ROLES], "",
        "## Stable consumer contract", "",
        f"- Player-team-season consumer rows: {len(consumer_rows):,}",
        "- Exposes categorical batting fit, bowling workload/family/phase usage and frozen keeper references.",
        "- Does not expose ratings, multipliers, penalties, boosts or bowling-balance legality.", "",
        "## Review boundary", "",
        f"- Bowling-family research players: {len(family_research_items):,}",
        f"- Approved bowling-family players: {actual['bowlingFamilyResolvedPlayers']:,}",
        f"- Residual bowling-family review players: {len(family_items):,}",
        f"- Optional batting-fit research profiles: {len(fit_items):,}",
        "- Bowling family is stored as player-default metadata with season overrides reserved for explicit temporal evidence.",
        "- Wicketkeeper capability and usage remain owned by the frozen wicketkeeper metadata family.",
        "- Classic 2016 artifacts and consumers are not modified.", "",
    ]).encode("utf-8")
    return files, validation_report


__all__ = [
    "BATTING_BANDS",
    "BOWLING_FAMILY_METADATA_SCHEMA_VERSION",
    "CONSUMER_SCHEMA_VERSION",
    "ISSUE_URL",
    "PlayerRoleMetadataError",
    "ROLE_METADATA_VERSION",
    "build_player_role_metadata_files",
    "build_player_role_consumer_row",
    "build_role_schemas",
    "derive_batting_usage",
    "derive_bowling_usage",
    "derive_role_summary",
    "normalize_bowling_family",
    "normalize_bowling_style_text",
    "position_counts_to_bands",
    "write_artifact_tree",
]
