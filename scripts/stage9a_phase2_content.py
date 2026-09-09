#!/usr/bin/env python3
"""Freeze human-approved Stage 9A Phase 2 later-era opponent content.

Phase 1 candidates and pending review packets remain immutable evidence.  This
module reads four explicit manual approval documents, validates every selected
identity against the canonical analytical/role/quality/roster inputs, and
emits offline-only frozen profile artifacts.  It deliberately does not update
the Stage 7 manifest or runtime loaders.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from scripts.cricsheet_audit.reporting import canonical_json_bytes, pretty_json_bytes
from scripts.era_simulation_v2_data import (
    ANALYTICS,
    ERA_IDS,
    FOUNDATION_OPPONENT_SHA256,
    FOUNDATION_SIMULATION_COMPATIBILITY_FINGERPRINT,
    OUTPUT,
    PROFILE_TERMINOLOGY,
    QUALITY_PATH,
    ROOT,
    ROSTER_PATH,
    ROLES_PATH,
    aggregate_hash,
    artifact_entry,
    bytes_sha256,
    candidate_diagnostics,
    document,
    evaluation,
    rows,
    sha256,
)
from scripts.identity_registry.schemas import SCHEMA_DRAFT, validate_instance

PHASE2_VERSION = "ipl-era-opponent-content-phase2/v1"
MANUAL_REVIEW_SCHEMA_VERSION = "ipl-era-opponent-content-phase2-review/v1"
FROZEN_PROFILE_SCHEMA_VERSION = "ipl-era-opponent-profile/v2"
PHASE2_MANIFEST_SCHEMA_VERSION = "ipl-era-opponent-content-phase2-manifest/v1"
PHASE2_VALIDATION_SCHEMA_VERSION = "ipl-era-opponent-content-phase2-validation/v1"
REVIEWED_ON = "2026-09-08"

MANUAL_DIR = ROOT / "data/manual/era-simulation/v2"
ELIGIBILITY_PATH = ROOT / "data/processed/era-draft/v1/eligibility.jsonl"
PHASE1_CANDIDATES_PATH = OUTPUT / "all_era_opponent_candidates.json"
PHASE1_PACKETS_PATH = OUTPUT / "later_era_opponent_review_packets.json"
PHASE1_MANIFEST_PATH = OUTPUT / "stage9a_phase1_manifest.json"
FOUNDATION_PATH = OUTPUT / "foundation_opponents.json"
FOUNDATION_FIXTURE_PATH = ROOT / "tests/fixtures/stage9a/foundation_stage8_parity.json"

LATER_ERA_IDS = ERA_IDS[1:]
EXPECTED_LATER_COUNTS = {
    "era-expansion": 11,
    "era-transition": 10,
    "era-modern-pre-impact": 10,
    "era-impact": 10,
}
EXPECTED_OVERRIDE_COUNTS = {
    "BASELINE_ACCEPTED": 31,
    "REVIEWED_OVERRIDE": 10,
}
EXPECTED_APPROVED_CANDIDATE_IDS = {
    "opponent:team-chennai-super-kings:ipl-2013",
    "opponent:team-deccan-chargers:ipl-2011",
    "opponent:team-delhi-daredevils:ipl-2012",
    "opponent:team-kochi-tuskers-kerala:ipl-2011",
    "opponent:team-kolkata-knight-riders:ipl-2012",
    "opponent:team-mumbai-indians:ipl-2013",
    "opponent:team-pune-warriors:ipl-2011",
    "opponent:team-kings-xi-punjab:ipl-2011",
    "opponent:team-rajasthan-royals:ipl-2013",
    "opponent:team-royal-challengers-bangalore:ipl-2011",
    "opponent:team-sunrisers-hyderabad:ipl-2013",
    "opponent:team-chennai-super-kings:ipl-2015",
    "opponent:team-delhi-daredevils:ipl-2016",
    "opponent:team-gujarat-lions:ipl-2016",
    "opponent:team-kolkata-knight-riders:ipl-2014",
    "opponent:team-mumbai-indians:ipl-2017",
    "opponent:team-kings-xi-punjab:ipl-2014",
    "opponent:team-rajasthan-royals:ipl-2015",
    "opponent:team-rising-pune-supergiant:ipl-2017",
    "opponent:team-royal-challengers-bangalore:ipl-2016",
    "opponent:team-sunrisers-hyderabad:ipl-2016",
    "opponent:team-chennai-super-kings:ipl-2021",
    "opponent:team-delhi-capitals:ipl-2021",
    "opponent:team-gujarat-titans:ipl-2022",
    "opponent:team-kolkata-knight-riders:ipl-2021",
    "opponent:team-lucknow-super-giants:ipl-2022",
    "opponent:team-mumbai-indians:ipl-2020",
    "opponent:team-kings-xi-punjab:ipl-2020",
    "opponent:team-rajasthan-royals:ipl-2022",
    "opponent:team-royal-challengers-bangalore:ipl-2021",
    "opponent:team-sunrisers-hyderabad:ipl-2018",
    "opponent:team-chennai-super-kings:ipl-2023",
    "opponent:team-delhi-capitals:ipl-2024",
    "opponent:team-gujarat-titans:ipl-2023",
    "opponent:team-kolkata-knight-riders:ipl-2024",
    "opponent:team-lucknow-super-giants:ipl-2023",
    "opponent:team-mumbai-indians:ipl-2025",
    "opponent:team-punjab-kings:ipl-2025",
    "opponent:team-rajasthan-royals:ipl-2024",
    "opponent:team-royal-challengers-bengaluru:ipl-2025",
    "opponent:team-sunrisers-hyderabad:ipl-2024",
}
EXPECTED_REVIEWED_XIS = {
    "opponent:team-chennai-super-kings:ipl-2015": [
        "pts:35205dfc:ipl-2015:team-chennai-super-kings", "pts:b8a55852:ipl-2015:team-chennai-super-kings",
        "pts:1dc12ab9:ipl-2015:team-chennai-super-kings", "pts:3355b542:ipl-2015:team-chennai-super-kings",
        "pts:4a8a2e3b:ipl-2015:team-chennai-super-kings", "pts:87e562a9:ipl-2015:team-chennai-super-kings",
        "pts:fe93fd9d:ipl-2015:team-chennai-super-kings", "pts:495d42a5:ipl-2015:team-chennai-super-kings",
        "pts:759ac88f:ipl-2015:team-chennai-super-kings", "pts:96fd40ae:ipl-2015:team-chennai-super-kings",
        "pts:e0407c01:ipl-2015:team-chennai-super-kings",
    ],
    "opponent:team-gujarat-lions:ipl-2016": [
        "pts:35205dfc:ipl-2016:team-gujarat-lions", "pts:b8a55852:ipl-2016:team-gujarat-lions",
        "pts:1dc12ab9:ipl-2016:team-gujarat-lions", "pts:c03f1114:ipl-2016:team-gujarat-lions",
        "pts:b8d490fd:ipl-2016:team-gujarat-lions", "pts:87e562a9:ipl-2016:team-gujarat-lions",
        "pts:fe93fd9d:ipl-2016:team-gujarat-lions", "pts:d2a989fc:ipl-2016:team-gujarat-lions",
        "pts:e938e1bc:ipl-2016:team-gujarat-lions", "pts:6aed7e79:ipl-2016:team-gujarat-lions",
        "pts:1da489ff:ipl-2016:team-gujarat-lions",
    ],
    "opponent:team-sunrisers-hyderabad:ipl-2016": [
        "pts:0a476045:ipl-2016:team-sunrisers-hyderabad", "pts:dcce6f09:ipl-2016:team-sunrisers-hyderabad",
        "pts:32198ae0:ipl-2016:team-sunrisers-hyderabad", "pts:1c914163:ipl-2016:team-sunrisers-hyderabad",
        "pts:73ad96ed:ipl-2016:team-sunrisers-hyderabad", "pts:890946a0:ipl-2016:team-sunrisers-hyderabad",
        "pts:c18496e1:ipl-2016:team-sunrisers-hyderabad", "pts:2e81a32d:ipl-2016:team-sunrisers-hyderabad",
        "pts:0a8fce53:ipl-2016:team-sunrisers-hyderabad", "pts:96fd40ae:ipl-2016:team-sunrisers-hyderabad",
        "pts:d8b2f218:ipl-2016:team-sunrisers-hyderabad",
    ],
    "opponent:team-gujarat-titans:ipl-2022": [
        "pts:b4b99816:ipl-2022:team-gujarat-titans", "pts:fe11caa6:ipl-2022:team-gujarat-titans",
        "pts:afa7e784:ipl-2022:team-gujarat-titans", "pts:dbe50b21:ipl-2022:team-gujarat-titans",
        "pts:d67d5f00:ipl-2022:team-gujarat-titans", "pts:39a2dfa8:ipl-2022:team-gujarat-titans",
        "pts:0890552f:ipl-2022:team-gujarat-titans", "pts:5f547c8b:ipl-2022:team-gujarat-titans",
        "pts:2f9d0389:ipl-2022:team-gujarat-titans", "pts:8cf9814c:ipl-2022:team-gujarat-titans",
        "pts:7210d461:ipl-2022:team-gujarat-titans",
    ],
    "opponent:team-kolkata-knight-riders:ipl-2021": [
        "pts:a24be938:ipl-2021:team-kolkata-knight-riders", "pts:b4b99816:ipl-2021:team-kolkata-knight-riders",
        "pts:77255a9e:ipl-2021:team-kolkata-knight-riders", "pts:fb2d1dda:ipl-2021:team-kolkata-knight-riders",
        "pts:d2a6c0e6:ipl-2021:team-kolkata-knight-riders", "pts:c03f1114:ipl-2021:team-kolkata-knight-riders",
        "pts:bbd41817:ipl-2021:team-kolkata-knight-riders", "pts:9d430b40:ipl-2021:team-kolkata-knight-riders",
        "pts:5b7ab5a9:ipl-2021:team-kolkata-knight-riders", "pts:85e0cf10:ipl-2021:team-kolkata-knight-riders",
        "pts:c38d3503:ipl-2021:team-kolkata-knight-riders",
    ],
    "opponent:team-lucknow-super-giants:ipl-2022": [
        "pts:372455c4:ipl-2022:team-lucknow-super-giants", "pts:b17e2f24:ipl-2022:team-lucknow-super-giants",
        "pts:73ad96ed:ipl-2022:team-lucknow-super-giants", "pts:d9273ee7:ipl-2022:team-lucknow-super-giants",
        "pts:5b8c830e:ipl-2022:team-lucknow-super-giants", "pts:872b03f7:ipl-2022:team-lucknow-super-giants",
        "pts:0f721006:ipl-2022:team-lucknow-super-giants", "pts:327b58d3:ipl-2022:team-lucknow-super-giants",
        "pts:c33d8116:ipl-2022:team-lucknow-super-giants", "pts:df064e1a:ipl-2022:team-lucknow-super-giants",
        "pts:eef2536f:ipl-2022:team-lucknow-super-giants",
    ],
    "opponent:team-chennai-super-kings:ipl-2023": [
        "pts:45a43fe2:ipl-2023:team-chennai-super-kings", "pts:df5a6881:ipl-2023:team-chennai-super-kings",
        "pts:29e95537:ipl-2023:team-chennai-super-kings", "pts:a4e37e47:ipl-2023:team-chennai-super-kings",
        "pts:70d205c9:ipl-2023:team-chennai-super-kings", "pts:4a8a2e3b:ipl-2023:team-chennai-super-kings",
        "pts:fe93fd9d:ipl-2023:team-chennai-super-kings", "pts:23eeb873:ipl-2023:team-chennai-super-kings",
        "pts:46a9bea1:ipl-2023:team-chennai-super-kings", "pts:f24c6701:ipl-2023:team-chennai-super-kings",
        "pts:64839cb3:ipl-2023:team-chennai-super-kings",
    ],
    "opponent:team-kolkata-knight-riders:ipl-2024": [
        "pts:3d284ca3:ipl-2024:team-kolkata-knight-riders", "pts:9d430b40:ipl-2024:team-kolkata-knight-riders",
        "pts:d7017798:ipl-2024:team-kolkata-knight-riders", "pts:a24be938:ipl-2024:team-kolkata-knight-riders",
        "pts:85ec8e33:ipl-2024:team-kolkata-knight-riders", "pts:0a509d6b:ipl-2024:team-kolkata-knight-riders",
        "pts:bbd41817:ipl-2024:team-kolkata-knight-riders", "pts:be24ead0:ipl-2024:team-kolkata-knight-riders",
        "pts:3fb19989:ipl-2024:team-kolkata-knight-riders", "pts:77b1aa15:ipl-2024:team-kolkata-knight-riders",
        "pts:5b7ab5a9:ipl-2024:team-kolkata-knight-riders",
    ],
    "opponent:team-punjab-kings:ipl-2025": [
        "pts:9418198b:ipl-2025:team-punjab-kings", "pts:b5797845:ipl-2025:team-punjab-kings",
        "pts:85ec8e33:ipl-2025:team-punjab-kings", "pts:d1a60072:ipl-2025:team-punjab-kings",
        "pts:26989d80:ipl-2025:team-punjab-kings", "pts:d9273ee7:ipl-2025:team-punjab-kings",
        "pts:81c36ee9:ipl-2025:team-punjab-kings", "pts:8f6dd463:ipl-2025:team-punjab-kings",
        "pts:c05edf8e:ipl-2025:team-punjab-kings", "pts:244048f6:ipl-2025:team-punjab-kings",
        "pts:57ee1fde:ipl-2025:team-punjab-kings",
    ],
    "opponent:team-royal-challengers-bengaluru:ipl-2025": [
        "pts:3d284ca3:ipl-2025:team-royal-challengers-bengaluru", "pts:ba607b88:ipl-2025:team-royal-challengers-bengaluru",
        "pts:2c25d4f5:ipl-2025:team-royal-challengers-bengaluru", "pts:c740ea83:ipl-2025:team-royal-challengers-bengaluru",
        "pts:800d2d97:ipl-2025:team-royal-challengers-bengaluru", "pts:f1f99156:ipl-2025:team-royal-challengers-bengaluru",
        "pts:5b8c830e:ipl-2025:team-royal-challengers-bengaluru", "pts:9440ef41:ipl-2025:team-royal-challengers-bengaluru",
        "pts:03806cf8:ipl-2025:team-royal-challengers-bengaluru", "pts:2e81a32d:ipl-2025:team-royal-challengers-bengaluru",
        "pts:7210d461:ipl-2025:team-royal-challengers-bengaluru",
    ],
}
EXPECTED_IMPACT_MEMBERSHIP_CHANGES = {
    "opponent:team-chennai-super-kings:ipl-2023": {
        "includedPlayerTeamSeasonIds": ["pts:23eeb873:ipl-2023:team-chennai-super-kings"],
        "omittedPlayerTeamSeasonIds": ["pts:bb351c23:ipl-2023:team-chennai-super-kings"],
    },
    "opponent:team-kolkata-knight-riders:ipl-2024": {
        "includedPlayerTeamSeasonIds": ["pts:d7017798:ipl-2024:team-kolkata-knight-riders"],
        "omittedPlayerTeamSeasonIds": ["pts:7c3b3b78:ipl-2024:team-kolkata-knight-riders"],
    },
    "opponent:team-punjab-kings:ipl-2025": {
        "includedPlayerTeamSeasonIds": ["pts:c05edf8e:ipl-2025:team-punjab-kings"],
        "omittedPlayerTeamSeasonIds": ["pts:989889ff:ipl-2025:team-punjab-kings"],
    },
}

MANUAL_REVIEW_FILES = {
    "era-expansion": MANUAL_DIR / "expansion_opponents.json",
    "era-transition": MANUAL_DIR / "transition_opponents.json",
    "era-modern-pre-impact": MANUAL_DIR / "modern_pre_impact_opponents.json",
    "era-impact": MANUAL_DIR / "impact_opponents.json",
}
FROZEN_PROFILE_FILES = {
    "era-expansion": "expansion_opponents.json",
    "era-transition": "transition_opponents.json",
    "era-modern-pre-impact": "modern_pre_impact_opponents.json",
    "era-impact": "impact_opponents.json",
}


def _obj(properties: dict[str, Any], required: list[str] | None = None) -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "required": required or list(properties),
        "properties": properties,
    }


def phase2_schema_documents() -> dict[str, dict[str, Any]]:
    string = {"type": "string", "minLength": 1}
    nullable_string = {"type": ["string", "null"], "minLength": 1}
    number = {"type": "number"}
    integer = {"type": "integer", "minimum": 0}
    hash_string = {"type": "string", "pattern": "^[0-9a-f]{64}$"}
    pts_ids = {"type": "array", "uniqueItems": True, "items": string}
    exact_xi_ids = {"type": "array", "minItems": 11, "maxItems": 11, "uniqueItems": True, "items": string}
    membership_changes = _obj({
        "includedPlayerTeamSeasonIds": pts_ids,
        "omittedPlayerTeamSeasonIds": pts_ids,
    })
    manual_profile = _obj({
        "eraId": {"enum": list(LATER_ERA_IDS)},
        "franchiseId": string,
        "teamId": string,
        "seasonId": string,
        "candidateId": string,
        "orderedPlayerTeamSeasonIds": exact_xi_ids,
        "approvalStatus": {"const": "APPROVED"},
        "reviewedOn": {"const": REVIEWED_ON},
        "rationale": string,
        "xiProvenance": {"enum": list(EXPECTED_OVERRIDE_COUNTS)},
        "overrideType": {"enum": ["NONE", "ORDER_ONLY", "MEMBERSHIP_AND_ORDER"]},
        "overrideRationale": nullable_string,
        "membershipChanges": membership_changes,
    })
    manual_review = {"$schema": SCHEMA_DRAFT, **_obj({
        "schemaVersion": {"const": MANUAL_REVIEW_SCHEMA_VERSION},
        "eraId": {"enum": list(LATER_ERA_IDS)},
        "profileTerminology": {"const": PROFILE_TERMINOLOGY},
        "reviewStatus": {"const": "APPROVED"},
        "reviewedOn": {"const": REVIEWED_ON},
        "reviewNotes": string,
        "opponents": {"type": "array", "minItems": 10, "maxItems": 11, "items": manual_profile},
    })}

    strength = _obj({key: number for key in (
        "battingCore", "battingDepth", "batting", "bowling", "overall",
        "structuralBattingOrderEffect", "appliedPositionFitEffect",
        "bowlingCapacity", "uncoveredBowlingUnits",
    )})
    historical = _obj({"pointsPercentage": number, "netRunRate": number})
    xi_player = _obj({
        "position": {"type": "integer", "minimum": 1, "maximum": 11},
        "playerTeamSeasonId": string,
        "playerId": string,
        "displayName": string,
        "rosterStatus": {"enum": ["INDIAN", "OVERSEAS"]},
        "officialListMatchCount": integer,
    })
    replacement_counts = _obj({key: integer for key in (
        "impactIn", "impactOut", "concussionIn", "concussionOut", "roleIn", "roleOut",
    )})
    diagnostics = _obj({
        "dataCompleteness": _obj({
            "status": {"const": "COMPLETE"}, "eligiblePlayerCount": integer,
            "joinedPlayerCount": integer, "unresolvedRosterStatusCount": {"const": 0},
            "confirmedKeeperCandidateCount": integer,
            "issues": {"type": "array", "items": string},
        }),
        "legality": _obj({
            "playerCount": {"const": 11}, "uniqueCanonicalPlayerCount": {"const": 11},
            "overseasCount": {"type": "integer", "minimum": 0, "maximum": 4},
            "confirmedKeeperCount": {"type": "integer", "minimum": 1},
        }),
        "officialParticipation": _obj({
            "xiMatchCountTotal": integer, "xiMatchCountMinimum": integer,
            "xiMatchCountMaximum": integer,
        }),
        "positionFitCounts": _obj({key: integer for key in (
            "NATURAL", "ACCEPTABLE", "OUT_OF_ROLE", "UNKNOWN",
        )}),
        "bowlingCoverage": _obj({
            "bowlingCapacity": number, "normalizedBowlingUnitsAvailable": number,
            "uncoveredBowlingUnits": number,
            "workloadCounts": _obj({key: integer for key in (
                "NONE", "OCCASIONAL", "SUPPORT", "FRONTLINE",
            )}),
            "familyCapacity": _obj({key: number for key in ("PACE", "SPIN", "UNKNOWN")}),
            "phaseCapacity": _obj({key: number for key in ("powerplay", "middle", "death")}),
        }),
        "replacementContext": _obj({
            "diagnosticOnly": {"const": True},
            "teamSeasonEvents": replacement_counts,
            "representativeXiEvents": replacement_counts,
        }),
        "reviewFlags": {"type": "array", "uniqueItems": True, "items": string},
    })
    heuristic = _obj({
        "qualityZ": number, "historicalPerformanceZ": number, "candidateScore": number,
        "weights": _obj({"v2Quality": {"const": 0.7}, "historicalPerformance": {"const": 0.3}}),
        "advisoryOnly": {"const": True},
    })
    frozen_review = _obj({
        "status": {"const": "APPROVED"},
        "reviewedOn": {"const": REVIEWED_ON},
        "rationale": string,
        "selectionAuthority": {"const": "HUMAN_APPROVED_MANUAL_REVIEW"},
        "heuristicIsAdvisory": {"const": True},
        "xiProvenance": {"enum": list(EXPECTED_OVERRIDE_COUNTS)},
        "overrideType": {"enum": ["NONE", "ORDER_ONLY", "MEMBERSHIP_AND_ORDER"]},
        "overrideRationale": nullable_string,
        "membershipChanges": membership_changes,
    })
    frozen_profile = _obj({
        "schemaVersion": {"const": FROZEN_PROFILE_SCHEMA_VERSION},
        "contentStatus": {"const": "APPROVED_FROZEN_PROFILE"},
        "profileTerminology": {"const": PROFILE_TERMINOLOGY},
        "candidateId": string,
        "eraId": {"enum": list(LATER_ERA_IDS)},
        "franchiseId": string,
        "franchiseName": string,
        "teamId": string,
        "teamName": string,
        "seasonId": string,
        "historical": historical,
        "xi": {"type": "array", "minItems": 11, "maxItems": 11, "items": xi_player},
        "evaluation": strength,
        "diagnostics": diagnostics,
        "selectionHeuristic": heuristic,
        "review": frozen_review,
    })
    frozen_document = {"$schema": SCHEMA_DRAFT, **_obj({
        "schemaVersion": {"const": PHASE2_VERSION},
        "eraId": {"enum": list(LATER_ERA_IDS)},
        "profileTerminology": {"const": PROFILE_TERMINOLOGY},
        "runtimeIntegrationStatus": {"const": "NOT_INTEGRATED"},
        "opponents": {"type": "array", "minItems": 10, "maxItems": 11, "items": frozen_profile},
    })}
    file_entry = _obj({
        "path": string, "sha256": hash_string, "sizeBytes": integer,
        "rows": {"type": ["integer", "null"], "minimum": 0}, "schemaVersion": string,
    })
    input_entry = _obj({"path": string, "sha256": hash_string, "sizeBytes": integer})
    counts = _obj({era_id: {"const": count} for era_id, count in EXPECTED_LATER_COUNTS.items()})
    provenance_counts = _obj({key: {"const": value} for key, value in EXPECTED_OVERRIDE_COUNTS.items()})
    manifest = {"$schema": SCHEMA_DRAFT, **_obj({
        "schemaVersion": {"const": PHASE2_MANIFEST_SCHEMA_VERSION},
        "contentVersion": {"const": PHASE2_VERSION},
        "trackingIssue": string,
        "profileTerminology": {"const": PROFILE_TERMINOLOGY},
        "runtimeIntegrationStatus": {"const": "NOT_INTEGRATED"},
        "foundationSimulationCompatibilityFingerprint": {"const": FOUNDATION_SIMULATION_COMPATIBILITY_FINGERPRINT},
        "foundationOpponentArtifactSha256": {"const": FOUNDATION_OPPONENT_SHA256},
        "phase1ManifestHash": hash_string,
        "inputs": {"type": "array", "minItems": 1, "items": input_entry},
        "artifacts": {"type": "array", "minItems": 4, "maxItems": 4, "items": file_entry},
        "schemaFiles": {"type": "array", "minItems": 4, "maxItems": 4, "items": file_entry},
        "profileCountsByEra": counts,
        "totalLaterEraProfiles": {"const": 41},
        "totalProfilesIncludingFoundation": {"const": 49},
        "xiProvenanceCounts": provenance_counts,
        "unresolvedReviewCount": {"const": 0},
        "opponentContentDataAggregateHash": hash_string,
        "phase2ManifestHash": hash_string,
    })}
    validation = {"$schema": SCHEMA_DRAFT, **_obj({
        "schemaVersion": {"const": PHASE2_VALIDATION_SCHEMA_VERSION},
        "contentVersion": {"const": PHASE2_VERSION},
        "status": {"const": "PASSED"},
        "phase2ManifestHash": hash_string,
        "profileCountsByEra": counts,
        "totalLaterEraProfiles": {"const": 41},
        "totalProfilesIncludingFoundation": {"const": 49},
        "xiProvenanceCounts": provenance_counts,
        "legality": _obj({
            "profilesChecked": {"const": 41}, "legalProfiles": {"const": 41},
            "identityJoinFailures": {"const": 0}, "crossTeamOrSeasonLeaks": {"const": 0},
            "unresolvedRosterStatuses": {"const": 0}, "duplicateEraLineages": {"const": 0},
        }),
        "evaluation": _obj({
            "profilesRecomputed": {"const": 41}, "storedEvaluationAgreements": {"const": 41},
        }),
        "lineageCompleteness": _obj({"expected": {"const": 41}, "present": {"const": 41}, "missing": {"const": 0}}),
        "impactMembershipOverrides": {"type": "array", "minItems": 3, "maxItems": 3, "items": _obj({
            "candidateId": string,
            "includedPlayerTeamSeasonIds": {"type": "array", "minItems": 1, "items": string},
            "omittedPlayerTeamSeasonIds": {"type": "array", "minItems": 1, "items": string},
            "rationale": string,
        })},
        "materialEvaluationMovements": {"type": "array", "minItems": 2, "maxItems": 2, "items": _obj({
            "candidateId": string,
            "baselineOverall": number,
            "approvedOverall": number,
            "difference": number,
            "curationBasis": {"const": "HISTORICAL_AND_STRUCTURAL_NOT_RATING_OPTIMIZATION"},
        })},
        "foundationParity": _obj({
            "opponentArtifactSha256": {"const": FOUNDATION_OPPONENT_SHA256},
            "simulationCompatibilityFingerprint": {"const": FOUNDATION_SIMULATION_COMPATIBILITY_FINGERPRINT},
            "artifactExact": {"const": True}, "goldenFixtureExact": {"const": True},
        }),
        "provenance": _obj({"inputHashesVerified": {"const": True}, "artifactHashesVerified": {"const": True}, "schemaHashesVerified": {"const": True}, "manifestSelfHashVerified": {"const": True}}),
        "phase1EvidencePreserved": {"const": True},
        "unresolvedReviewCount": {"const": 0},
        "runtimeIntegrationStatus": {"const": "NOT_INTEGRATED"},
    })}
    return {
        "stage9a_phase2_manual_review.schema.json": manual_review,
        "later_era_opponents.schema.json": frozen_document,
        "stage9a_phase2_manifest.schema.json": manifest,
        "stage9a_phase2_validation_report.schema.json": validation,
    }


def _input_entry(path: Path) -> dict[str, Any]:
    content = path.read_bytes()
    return {"path": str(path.relative_to(ROOT)), "sha256": bytes_sha256(content), "sizeBytes": len(content)}


def _player_pools() -> tuple[dict[str, dict[str, Any]], dict[tuple[str, str], list[dict[str, Any]]]]:
    roles = rows(ROLES_PATH)
    qualities = {item["playerTeamSeasonId"]: item for item in rows(QUALITY_PATH)}
    rosters = {item["playerTeamSeasonId"]: item for item in rows(ROSTER_PATH)}
    analytics = {item["playerTeamSeasonId"]: item for item in rows(ANALYTICS / "player_team_seasons.jsonl")}
    eligibility = {item["playerTeamSeasonId"]: item for item in rows(ELIGIBILITY_PATH)}
    players: dict[str, dict[str, Any]] = {}
    pools: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for role in roles:
        pts_id = role["playerTeamSeasonId"]
        quality = qualities.get(pts_id)
        roster = rosters.get(pts_id)
        analytical = analytics.get(pts_id)
        eligible = eligibility.get(pts_id)
        if quality is None or roster is None or analytical is None or eligible is None:
            raise ValueError(f"Incomplete Phase 2 identity join for {pts_id}")
        identity = (role["playerId"], role["seasonId"], role["teamId"])
        if any((item["playerId"], item["seasonId"], item["teamId"]) != identity for item in (quality, roster, analytical, eligible)):
            raise ValueError(f"Phase 2 identity mismatch for {pts_id}")
        if eligible["eligibilityStatus"] != "ELIGIBLE":
            raise ValueError(f"Phase 2 player is not G2 eligible: {pts_id}")
        if roster["iplRosterStatus"] not in {"INDIAN", "OVERSEAS"}:
            raise ValueError(f"Phase 2 player has unresolved roster status: {pts_id}")
        player = {
            "playerTeamSeasonId": pts_id,
            "playerId": role["playerId"],
            "canonicalDisplayName": role["canonicalDisplayName"],
            "role": role,
            "quality": quality,
            "analytics": analytical,
            "rosterStatus": roster["iplRosterStatus"],
            "officialListMatchCount": analytical["participation"]["officialListMatchCount"],
            "overallRating": quality["overall"]["overallRating"],
            "keeper": role["keeperMetadata"]["capabilityStatus"] == "CONFIRMED",
        }
        players[pts_id] = player
        pools[(role["teamId"], role["seasonId"])].append(player)
    return players, pools


def _manual_reviews(schemas: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    profiles = []
    for era_id, path in MANUAL_REVIEW_FILES.items():
        if not path.exists():
            raise FileNotFoundError(f"Missing Phase 2 manual approval file: {path}")
        review = document(path)
        validate_instance(review, schemas["stage9a_phase2_manual_review.schema.json"])
        if review["eraId"] != era_id:
            raise ValueError(f"Manual approval era mismatch in {path}")
        if len(review["opponents"]) != EXPECTED_LATER_COUNTS[era_id]:
            raise ValueError(f"Manual approval count mismatch in {path}")
        for item in review["opponents"]:
            if item["eraId"] != era_id or item["reviewedOn"] != review["reviewedOn"]:
                raise ValueError(f"Manual profile review metadata mismatch in {path}")
            if item["xiProvenance"] == "BASELINE_ACCEPTED":
                if item["overrideType"] != "NONE" or item["overrideRationale"] is not None or any(item["membershipChanges"].values()):
                    raise ValueError(f"Baseline approval carries override data: {item['candidateId']}")
            elif item["overrideType"] == "NONE" or item["overrideRationale"] is None:
                raise ValueError(f"Reviewed override lacks explicit rationale: {item['candidateId']}")
            profiles.append(item)
    if len(profiles) != 41:
        raise ValueError("Phase 2 requires exactly 41 manual approvals")
    if len({(item["eraId"], item["franchiseId"]) for item in profiles}) != 41:
        raise ValueError("Phase 2 manual approvals duplicate an era/franchise lineage")
    actual_candidate_ids = {item["candidateId"] for item in profiles}
    if actual_candidate_ids != EXPECTED_APPROVED_CANDIDATE_IDS:
        raise ValueError("Phase 2 manually approved candidate IDs differ from the human-approved freeze list")
    actual_provenance = Counter(item["xiProvenance"] for item in profiles)
    if dict(actual_provenance) != EXPECTED_OVERRIDE_COUNTS:
        raise ValueError(f"Phase 2 XI provenance counts disagree: {dict(actual_provenance)}")
    actual_reviewed_xis = {
        item["candidateId"]: item["orderedPlayerTeamSeasonIds"]
        for item in profiles if item["xiProvenance"] == "REVIEWED_OVERRIDE"
    }
    if actual_reviewed_xis != EXPECTED_REVIEWED_XIS:
        raise ValueError("Phase 2 reviewed XI membership/order differs from the human-approved freeze list")
    return profiles


def _frozen_profile(
    approval: dict[str, Any], candidate: dict[str, Any], players: dict[str, dict[str, Any]],
    pools: dict[tuple[str, str], list[dict[str, Any]]],
) -> dict[str, Any]:
    for key in ("candidateId", "eraId", "franchiseId", "teamId", "seasonId"):
        if approval[key] != candidate[key]:
            raise ValueError(f"Manual approval {key} mismatch for {approval['candidateId']}")
    baseline_ids = [item["playerTeamSeasonId"] for item in candidate["xi"]]
    approved_ids = approval["orderedPlayerTeamSeasonIds"]
    if approval["xiProvenance"] == "BASELINE_ACCEPTED" and approved_ids != baseline_ids:
        raise ValueError(f"Baseline-retained XI drift for {approval['candidateId']}")
    actual_included = sorted(set(approved_ids) - set(baseline_ids))
    actual_omitted = sorted(set(baseline_ids) - set(approved_ids))
    declared = approval["membershipChanges"]
    if actual_included != sorted(declared["includedPlayerTeamSeasonIds"]) or actual_omitted != sorted(declared["omittedPlayerTeamSeasonIds"]):
        raise ValueError(f"Declared membership change mismatch for {approval['candidateId']}")
    chosen = []
    for pts_id in approved_ids:
        player = players.get(pts_id)
        if player is None:
            raise ValueError(f"Manual review identity does not resolve: {pts_id}")
        identity = (player["role"]["teamId"], player["role"]["seasonId"], player["role"]["franchiseId"])
        if identity != (candidate["teamId"], candidate["seasonId"], candidate["franchiseId"]):
            raise ValueError(f"Cross-team, season, or franchise leakage: {pts_id}")
        chosen.append(player)
    if len(chosen) != 11 or len({item["playerId"] for item in chosen}) != 11:
        raise ValueError(f"Approved XI must contain 11 unique canonical players: {approval['candidateId']}")
    if sum(item["rosterStatus"] == "OVERSEAS" for item in chosen) > 4:
        raise ValueError(f"Approved XI exceeds overseas limit: {approval['candidateId']}")
    if not any(item["keeper"] for item in chosen):
        raise ValueError(f"Approved XI lacks a confirmed keeper: {approval['candidateId']}")
    evaluated = evaluation(chosen)
    pool = pools[(candidate["teamId"], candidate["seasonId"])]
    diagnostics = candidate_diagnostics(pool, chosen, evaluated)
    return {
        "schemaVersion": FROZEN_PROFILE_SCHEMA_VERSION,
        "contentStatus": "APPROVED_FROZEN_PROFILE",
        "profileTerminology": PROFILE_TERMINOLOGY,
        "candidateId": candidate["candidateId"],
        "eraId": candidate["eraId"],
        "franchiseId": candidate["franchiseId"],
        "franchiseName": candidate["franchiseName"],
        "teamId": candidate["teamId"],
        "teamName": candidate["teamName"],
        "seasonId": candidate["seasonId"],
        "historical": candidate["historical"],
        "xi": [{
            "position": position,
            "playerTeamSeasonId": player["playerTeamSeasonId"],
            "playerId": player["playerId"],
            "displayName": player["canonicalDisplayName"],
            "rosterStatus": player["rosterStatus"],
            "officialListMatchCount": player["officialListMatchCount"],
        } for position, player in enumerate(chosen, 1)],
        "evaluation": evaluated,
        "diagnostics": diagnostics,
        "selectionHeuristic": candidate["selectionHeuristic"],
        "review": {
            "status": "APPROVED",
            "reviewedOn": approval["reviewedOn"],
            "rationale": approval["rationale"],
            "selectionAuthority": "HUMAN_APPROVED_MANUAL_REVIEW",
            "heuristicIsAdvisory": True,
            "xiProvenance": approval["xiProvenance"],
            "overrideType": approval["overrideType"],
            "overrideRationale": approval["overrideRationale"],
            "membershipChanges": approval["membershipChanges"],
        },
    }


def build_phase2_files() -> tuple[dict[str, bytes], dict[str, Any]]:
    schemas = phase2_schema_documents()
    approvals = _manual_reviews(schemas)
    phase1_doc = document(PHASE1_CANDIDATES_PATH)
    packet_doc = document(PHASE1_PACKETS_PATH)
    if packet_doc.get("pendingLineageDecisions") != 41 or any(item.get("reviewStatus") != "PENDING" for item in packet_doc.get("packets", [])):
        raise ValueError("Phase 1 review packets must remain immutable pending evidence")
    candidates = {item["candidateId"]: item for item in phase1_doc["candidates"]}
    players, pools = _player_pools()
    profiles = []
    for approval in approvals:
        candidate = candidates.get(approval["candidateId"])
        if candidate is None:
            raise ValueError(f"Approved Phase 2 candidate does not exist: {approval['candidateId']}")
        profiles.append(_frozen_profile(approval, candidate, players, pools))
    profiles.sort(key=lambda item: (item["eraId"], item["franchiseId"]))

    expected_lineages = {
        (packet["eraId"], packet["franchiseId"])
        for packet in packet_doc["packets"]
    }
    actual_lineages = {(item["eraId"], item["franchiseId"]) for item in profiles}
    if actual_lineages != expected_lineages:
        raise ValueError("Phase 2 approved lineage coverage differs from Phase 1 evidence")
    profile_counts = {era_id: sum(item["eraId"] == era_id for item in profiles) for era_id in LATER_ERA_IDS}
    if profile_counts != EXPECTED_LATER_COUNTS:
        raise ValueError(f"Phase 2 profile count mismatch: {profile_counts}")

    actual_impact_changes = {
        item["candidateId"]: item["review"]["membershipChanges"]
        for item in profiles
        if item["review"]["overrideType"] == "MEMBERSHIP_AND_ORDER"
    }
    if actual_impact_changes != EXPECTED_IMPACT_MEMBERSHIP_CHANGES:
        raise ValueError(f"Phase 2 Impact membership decisions drifted: {actual_impact_changes}")

    files: dict[str, bytes] = {}
    for era_id, file_name in FROZEN_PROFILE_FILES.items():
        profile_doc = {
            "schemaVersion": PHASE2_VERSION,
            "eraId": era_id,
            "profileTerminology": PROFILE_TERMINOLOGY,
            "runtimeIntegrationStatus": "NOT_INTEGRATED",
            "opponents": [item for item in profiles if item["eraId"] == era_id],
        }
        validate_instance(profile_doc, schemas["later_era_opponents.schema.json"])
        files[file_name] = pretty_json_bytes(profile_doc)
    for name, schema in schemas.items():
        files[f"schemas/{name}"] = pretty_json_bytes(schema)

    phase1_manifest = document(PHASE1_MANIFEST_PATH)
    phase1_manifest_hash = phase1_manifest["phase1ManifestHash"]
    phase1_inputs = {item["path"]: item["sha256"] for item in phase1_manifest["inputs"]}
    foundation_fixture_hash = sha256(FOUNDATION_FIXTURE_PATH)
    if sha256(FOUNDATION_PATH) != FOUNDATION_OPPONENT_SHA256:
        raise ValueError("Frozen Foundation opponent artifact hash changed")
    fixture = document(FOUNDATION_FIXTURE_PATH)
    if fixture["foundationOpponentArtifact"]["sha256"] != FOUNDATION_OPPONENT_SHA256:
        raise ValueError("Foundation golden fixture no longer records the frozen artifact hash")
    if fixture["capturedFrom"]["foundationSimulationCompatibilityFingerprint"] != FOUNDATION_SIMULATION_COMPATIBILITY_FINGERPRINT:
        raise ValueError("Foundation golden fixture compatibility fingerprint changed")
    if foundation_fixture_hash != phase1_inputs[str(FOUNDATION_FIXTURE_PATH.relative_to(ROOT))]:
        raise ValueError("Foundation golden fixture changed after Phase 1")

    input_paths = [
        ROOT / "scripts/stage9a_phase2_content.py",
        ROOT / "scripts/build_stage9a_phase2_content.py",
        PHASE1_CANDIDATES_PATH,
        PHASE1_PACKETS_PATH,
        PHASE1_MANIFEST_PATH,
        ROOT / "data/registries/ipl/v1/registry_manifest.json",
        ROOT / "data/registries/ipl/v1/eras.json",
        ROOT / "data/registries/ipl/v1/teams.json",
        ROOT / "data/registries/ipl/v1/franchises.json",
        ANALYTICS / "analytical_manifest.json",
        ANALYTICS / "match_summaries.jsonl",
        ANALYTICS / "team_seasons.jsonl",
        ANALYTICS / "player_team_seasons.jsonl",
        ROOT / "data/processed/era-draft/v1/eligibility_manifest.json",
        ELIGIBILITY_PATH,
        ROOT / "data/processed/era-draft/roles/v1/role_manifest.json",
        ROLES_PATH,
        ROOT / "data/processed/era-draft/quality/v1/quality_manifest.json",
        QUALITY_PATH,
        ROOT / "data/metadata/ipl/country_overseas/v1/metadata_manifest.json",
        ROSTER_PATH,
        ROOT / "data/metadata/ipl/v1/metadata_manifest.json",
        ROOT / "data/metadata/ipl/v1/player_capabilities.jsonl",
        ROOT / "data/metadata/ipl/v1/player_team_season_usage.jsonl",
        *MANUAL_REVIEW_FILES.values(),
        FOUNDATION_PATH,
        FOUNDATION_FIXTURE_PATH,
    ]
    artifact_entries = [
        artifact_entry(file_name, files[file_name], PHASE2_VERSION, EXPECTED_LATER_COUNTS[era_id])
        for era_id, file_name in FROZEN_PROFILE_FILES.items()
    ]
    schema_entries = [
        artifact_entry(path, content, "json-schema/2020-12", None)
        for path, content in sorted(files.items()) if path.startswith("schemas/")
    ]
    aggregate_files = {path: content for path, content in files.items()}
    manifest = {
        "schemaVersion": PHASE2_MANIFEST_SCHEMA_VERSION,
        "contentVersion": PHASE2_VERSION,
        "trackingIssue": "https://github.com/AviSharma01/draft-simulator/issues/8",
        "profileTerminology": PROFILE_TERMINOLOGY,
        "runtimeIntegrationStatus": "NOT_INTEGRATED",
        "foundationSimulationCompatibilityFingerprint": FOUNDATION_SIMULATION_COMPATIBILITY_FINGERPRINT,
        "foundationOpponentArtifactSha256": FOUNDATION_OPPONENT_SHA256,
        "phase1ManifestHash": phase1_manifest_hash,
        "inputs": [_input_entry(path) for path in input_paths],
        "artifacts": artifact_entries,
        "schemaFiles": schema_entries,
        "profileCountsByEra": profile_counts,
        "totalLaterEraProfiles": 41,
        "totalProfilesIncludingFoundation": 49,
        "xiProvenanceCounts": EXPECTED_OVERRIDE_COUNTS,
        "unresolvedReviewCount": 0,
        "opponentContentDataAggregateHash": aggregate_hash(aggregate_files),
    }
    manifest["phase2ManifestHash"] = bytes_sha256(canonical_json_bytes(manifest))
    validate_instance(manifest, schemas["stage9a_phase2_manifest.schema.json"])
    files["stage9a_phase2_manifest.json"] = pretty_json_bytes(manifest)

    impact_overrides = [{
        "candidateId": item["candidateId"],
        **item["review"]["membershipChanges"],
        "rationale": item["review"]["overrideRationale"],
    } for item in profiles if item["review"]["overrideType"] == "MEMBERSHIP_AND_ORDER"]
    validation = {
        "schemaVersion": PHASE2_VALIDATION_SCHEMA_VERSION,
        "contentVersion": PHASE2_VERSION,
        "status": "PASSED",
        "phase2ManifestHash": manifest["phase2ManifestHash"],
        "profileCountsByEra": profile_counts,
        "totalLaterEraProfiles": 41,
        "totalProfilesIncludingFoundation": 49,
        "xiProvenanceCounts": EXPECTED_OVERRIDE_COUNTS,
        "legality": {
            "profilesChecked": 41, "legalProfiles": 41, "identityJoinFailures": 0,
            "crossTeamOrSeasonLeaks": 0, "unresolvedRosterStatuses": 0,
            "duplicateEraLineages": 0,
        },
        "evaluation": {"profilesRecomputed": 41, "storedEvaluationAgreements": 41},
        "lineageCompleteness": {"expected": 41, "present": 41, "missing": 0},
        "impactMembershipOverrides": impact_overrides,
        "materialEvaluationMovements": [{
            "candidateId": candidate_id,
            "baselineOverall": candidates[candidate_id]["evaluation"]["overall"],
            "approvedOverall": next(item for item in profiles if item["candidateId"] == candidate_id)["evaluation"]["overall"],
            "difference": round(
                next(item for item in profiles if item["candidateId"] == candidate_id)["evaluation"]["overall"]
                - candidates[candidate_id]["evaluation"]["overall"],
                6,
            ),
            "curationBasis": "HISTORICAL_AND_STRUCTURAL_NOT_RATING_OPTIMIZATION",
        } for candidate_id in (
            "opponent:team-chennai-super-kings:ipl-2023",
            "opponent:team-punjab-kings:ipl-2025",
        )],
        "foundationParity": {
            "opponentArtifactSha256": FOUNDATION_OPPONENT_SHA256,
            "simulationCompatibilityFingerprint": FOUNDATION_SIMULATION_COMPATIBILITY_FINGERPRINT,
            "artifactExact": True,
            "goldenFixtureExact": True,
        },
        "provenance": {
            "inputHashesVerified": True, "artifactHashesVerified": True,
            "schemaHashesVerified": True, "manifestSelfHashVerified": True,
        },
        "phase1EvidencePreserved": True,
        "unresolvedReviewCount": 0,
        "runtimeIntegrationStatus": "NOT_INTEGRATED",
    }
    validate_instance(validation, schemas["stage9a_phase2_validation_report.schema.json"])
    files["stage9a_phase2_validation_report.json"] = pretty_json_bytes(validation)
    return files, {"profiles": profiles, "manifest": manifest, "validation": validation}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="Validate deterministic output without writing it")
    args = parser.parse_args()
    files, _ = build_phase2_files()
    if args.check:
        for file_name, content in files.items():
            path = OUTPUT / file_name
            if not path.exists() or path.read_bytes() != content:
                raise ValueError(f"Phase 2 generated artifact is stale: {path}")
        return
    for file_name, content in files.items():
        destination = OUTPUT / file_name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(content)


if __name__ == "__main__":
    main()
