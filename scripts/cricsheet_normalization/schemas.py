from __future__ import annotations

from typing import Any


SCHEMA_DRAFT = "https://json-schema.org/draft/2020-12/schema"
MANIFEST_SCHEMA_VERSION = "cricsheet-ipl-normalization-manifest/v1"
REPORT_SCHEMA_VERSION = "cricsheet-ipl-normalization-report/v1"


def _string(*, enum: list[str] | None = None, pattern: str | None = None) -> dict[str, Any]:
    result: dict[str, Any] = {"type": "string", "minLength": 1}
    if enum is not None:
        result["enum"] = enum
    if pattern is not None:
        result["pattern"] = pattern
    return result


def _integer(minimum: int = 0) -> dict[str, Any]:
    return {"type": "integer", "minimum": minimum}


def _number(minimum: int = 0) -> dict[str, Any]:
    return {"type": "number", "minimum": minimum}


def _nullable_string() -> dict[str, Any]:
    return {"type": ["string", "null"]}


def _array(items: dict[str, Any], *, minimum: int = 0, maximum: int | None = None, unique: bool = False) -> dict[str, Any]:
    result: dict[str, Any] = {"type": "array", "items": items, "minItems": minimum}
    if maximum is not None:
        result["maxItems"] = maximum
    if unique:
        result["uniqueItems"] = True
    return result


def _object(properties: dict[str, Any], *, required: list[str] | None = None) -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "required": required if required is not None else list(properties),
        "properties": properties,
    }


def _nullable(schema: dict[str, Any]) -> dict[str, Any]:
    return {"oneOf": [schema, {"type": "null"}]}


def build_normalized_match_schema() -> dict[str, Any]:
    player_ref = _object({"playerId": _string(), "sourceName": _string()})
    source_person = _object({"sourceName": _string(), "sourcePersonRegistryId": _string()})
    delivery_ref = _object({
        "inningsIndex": _integer(1),
        "sourceOverNumber": _integer(),
        "sourceDeliveryIndex": _integer(),
        "itemIndex": _integer(),
    })
    resolution = _object({
        "status": _string(enum=["canonical", "provisional"]),
        "matchedBy": _string(),
        "registryReviewStatus": _string(enum=["approved", "review_required"]),
        "requiresNewReview": {"const": False},
    })
    evidence = _object({
        "battingInningsIndexes": _array(_integer(1), unique=True),
        "bowlingInningsIndexes": _array(_integer(1), unique=True),
        "fieldingInningsIndexes": _array(_integer(1), unique=True),
        "substituteFielding": _array(delivery_ref),
        "absentHurtInningsIndexes": _array(_integer(1), unique=True),
        "reviews": _array(delivery_ref),
        "matchReplacementIn": _array(delivery_ref),
        "matchReplacementOut": _array(delivery_ref),
        "roleReplacementIn": _array(delivery_ref),
        "roleReplacementOut": _array(delivery_ref),
        "playerOfMatch": {"type": "boolean"},
    })
    participant = _object({
        "playerId": _string(),
        "canonicalDisplayName": _string(),
        "teamId": _string(),
        "observedSourceNames": _array(_string(), minimum=1, unique=True),
        "registryParticipationBasis": _string(enum=["official_participant", "event_only"]),
        "resolution": resolution,
        "sourceListStatus": _string(enum=["official_listed", "event_only"]),
        "officialListIndex": {"type": ["integer", "null"], "minimum": 0},
        "evidence": evidence,
    })
    fielder = _object({**player_ref["properties"], "isSubstitute": {"type": "boolean"}})
    wicket = _object({
        "kind": _string(enum=[
            "bowled", "caught", "caught and bowled", "hit wicket", "lbw",
            "obstructing the field", "retired hurt", "retired out", "run out", "stumped",
        ]),
        "playerOut": player_ref,
        "fielders": _array(fielder),
        "countsAsBatterDismissal": {"type": "boolean"},
        "creditedToBowler": {"type": "boolean"},
    })
    review = _object({
        "sourceReviewingTeamName": _string(),
        "reviewingTeamId": _string(),
        "batter": player_ref,
        "decision": _string(enum=["struck down", "upheld"]),
        "type": _nullable_string(),
        "umpire": source_person,
        "umpiresCall": {"type": "boolean"},
    })
    match_replacement = _object({
        "in": player_ref,
        "out": player_ref,
        "sourceTeamName": _string(),
        "teamId": _string(),
        "reason": _string(enum=["impact_player", "concussion_substitute"]),
    })
    role_replacement = _object({
        "in": player_ref,
        "out": _nullable(player_ref),
        "role": _string(enum=["batter", "bowler"]),
        "reason": _string(enum=["injury", "excluded - high full pitched balls"]),
        "teamId": _string(),
        "teamBasis": _string(enum=["innings_batting_team", "innings_bowling_team"]),
    })
    delivery = _object({
        "sourceDeliveryIndex": _integer(),
        "actualDelivery": _string(),
        "batter": player_ref,
        "nonStriker": player_ref,
        "bowler": player_ref,
        "runs": _object({
            "batter": _integer(), "extras": _integer(), "total": _integer(),
            "nonBoundary": {"type": "boolean"},
        }),
        "extras": _object({
            "byes": _integer(), "legByes": _integer(), "noBalls": _integer(),
            "penalty": _integer(), "wides": _integer(),
        }),
        "isBowlerLegalDelivery": {"type": "boolean"},
        "countsAsBatterBall": {"type": "boolean"},
        "wickets": _array(wicket),
        "review": _nullable(review),
        "replacements": _object({
            "match": _array(match_replacement),
            "role": _array(role_replacement),
        }),
    })
    over = _object({
        "sourceOverIndex": _integer(),
        "sourceOverNumber": _integer(),
        "deliveries": _array(delivery),
    })
    target = _object({"overs": _number(), "runs": _integer(1)})
    powerplay = _object({
        "from": _number(), "to": _number(), "type": _string(enum=["mandatory"]),
    })
    miscounted = _object({
        "sourceOverNumber": _integer(),
        "balls": _integer(1),
        "umpire": _nullable(source_person),
    })
    totals = _object({
        "runs": _integer(), "deliveryRecords": _integer(), "bowlerLegalDeliveries": _integer(),
        "batterBallsFaced": _integer(), "wicketEvents": _integer(),
        "batterDismissals": _integer(), "bowlerCreditedWickets": _integer(),
    })
    innings = _object({
        "inningsIndex": _integer(1),
        "sourceBattingTeamName": _string(),
        "battingTeamId": _string(),
        "bowlingTeamId": _string(),
        "inningsKind": _string(enum=["normal", "super_over"]),
        "target": _nullable(target),
        "powerplays": _array(powerplay),
        "absentHurt": _array(player_ref),
        "miscountedOvers": _array(miscounted),
        "overs": _array(over),
        "totals": totals,
    })
    venue_evidence = _object({
        "registry": _string(enum=["venues"]), "recordId": _string(), "sourceAlias": _string(),
    })
    venue_resolution = _object({
        "status": _string(enum=["canonical", "provisional"]),
        "matchedBy": _string(),
        "registryReviewStatus": _string(enum=["approved", "review_required"]),
        "requiresNewReview": {"const": False},
        "evidenceRefs": _array(venue_evidence, minimum=1),
    })
    margin = _object({"kind": _string(enum=["runs", "wickets"]), "value": _integer(1)})
    schema = _object({
        "schemaVersion": {"const": "cricsheet-ipl-normalized-match/v1"},
        "datasetVersion": {"const": "cricsheet-ipl-normalized/v1"},
        "matchId": _string(pattern=r"[0-9]+"),
        "provenance": _object({
            "sourceMatchId": _string(pattern=r"[0-9]+"),
            "relativeSourcePath": _string(pattern=r"[^/]+\.json"),
            "sourceFileSha256": _string(pattern=r"[0-9a-f]{64}"),
            "sourceArchiveSchemaVersion": {"const": "cricsheet-ipl-archive-audit/v1"},
            "sourceArchiveManifestHash": _string(pattern=r"[0-9a-f]{64}"),
            "identityRegistryVersion": _string(),
            "identityRegistryAggregateHash": _string(pattern=r"[0-9a-f]{64}"),
        }),
        "sourceMeta": _object({
            "dataVersion": {"const": "1.2.0"}, "revision": _integer(1), "created": _string(),
        }),
        "competition": _object({
            "matchType": {"const": "T20"}, "gender": {"const": "male"},
            "teamType": {"const": "club"}, "scheduledOvers": {"const": 20},
            "ballsPerOver": {"const": 6},
        }),
        "season": _object({
            "sourceSeason": {"oneOf": [_string(), _integer()]},
            "sourceSeasonKey": _string(), "seasonId": _string(),
        }),
        "dates": _array(_string(pattern=r"\d{4}-\d{2}-\d{2}"), minimum=1),
        "event": _object({
            "name": _string(), "matchNumber": {"type": ["integer", "null"], "minimum": 1},
            "stage": _nullable_string(),
        }),
        "teams": _array(_object({
            "sourceTeamName": _string(), "teamId": _string(), "franchiseId": _string(),
        }), minimum=2, maximum=2),
        "venue": _object({
            "sourceVenue": _string(), "sourceCity": _nullable_string(), "venueId": _string(),
            "venueSiteId": _string(), "canonicalName": _string(), "canonicalCity": _string(),
            "country": _string(), "resolution": venue_resolution,
        }),
        "toss": _object({
            "sourceWinnerTeamName": _string(), "winnerTeamId": _string(),
            "decision": _string(enum=["bat", "field"]),
        }),
        "outcome": _object({
            "resultType": _string(enum=["win", "tie", "no_result"]),
            "sourceResult": _nullable_string(), "sourceWinnerTeamName": _nullable_string(),
            "winnerTeamId": _nullable_string(), "sourceEliminatorWinnerTeamName": _nullable_string(),
            "eliminatorWinnerTeamId": _nullable_string(), "method": _nullable_string(),
            "margin": _nullable(margin),
        }),
        "playerOfMatch": _array(player_ref),
        "officials": _array(_object({
            "role": _string(enum=["match_referees", "reserve_umpires", "tv_umpires", "umpires"]),
            "people": _array(source_person),
        })),
        "participants": _array(participant, minimum=1),
        "innings": _array(innings, minimum=1),
    })
    return {"$schema": SCHEMA_DRAFT, "title": "Canonical normalized IPL match", **schema}


def _issue_schema() -> dict[str, Any]:
    return _object({
        "severity": _string(enum=["warning", "error"]),
        "code": _string(),
        "matchId": _nullable_string(),
        "sourcePath": _nullable_string(),
        "location": _nullable_string(),
        "relatedEntityIds": _array(_string(), unique=True),
        "message": _string(),
    })


def build_manifest_schema() -> dict[str, Any]:
    match_entry = _object({
        "path": _string(), "matchId": _string(pattern=r"[0-9]+"), "seasonId": _string(),
        "sourceFileSha256": _string(pattern=r"[0-9a-f]{64}"),
        "sha256": _string(pattern=r"[0-9a-f]{64}"), "sizeBytes": _integer(),
        "normalInnings": _integer(), "superOverInnings": _integer(), "deliveries": _integer(),
    })
    artifact = _object({
        "path": _string(), "sha256": _string(pattern=r"[0-9a-f]{64}"), "sizeBytes": _integer(),
    })
    count_fields = {
        "matches": _integer(), "normalInnings": _integer(), "superOverInnings": _integer(),
        "deliveries": _integer(), "impactPlayerReplacements": _integer(),
        "concussionSubstitutes": _integer(), "roleReplacements": _integer(),
        "substituteFieldingEvents": _integer(), "reviews": _integer(),
    }
    schema = _object({
        "schemaVersion": {"const": MANIFEST_SCHEMA_VERSION},
        "datasetVersion": {"const": "cricsheet-ipl-normalized/v1"},
        "sourceArchiveManifestHash": _string(pattern=r"[0-9a-f]{64}"),
        "identityRegistryVersion": _string(),
        "identityRegistryAggregateHash": _string(pattern=r"[0-9a-f]{64}"),
        "counts": _object(count_fields),
        "seasonCounts": _array(_object({
            "seasonId": _string(), "matches": _integer(), "normalInnings": _integer(),
            "superOverInnings": _integer(), "deliveries": _integer(),
        })),
        "matchFiles": _array(match_entry, minimum=1),
        "schemaFiles": _array(artifact, minimum=3),
        "normalizedMatchAggregateHash": _string(pattern=r"[0-9a-f]{64}"),
        "normalizationManifestHash": _string(pattern=r"[0-9a-f]{64}"),
    })
    return {"$schema": SCHEMA_DRAFT, "title": "IPL normalization manifest", **schema}


def build_validation_report_schema() -> dict[str, Any]:
    size_report = _object({
        "matchFileCount": _integer(), "matchCorpusLogicalBytes": _integer(),
        "matchCorpusHumanSize": _string(), "minimumMatchBytes": _integer(),
        "medianMatchBytes": _integer(), "averageMatchBytes": _number(),
        "maximumMatchBytes": _integer(), "schemaBundleBytes": _integer(),
        "manifestBytes": _integer(), "validationReportBytes": _integer(),
        "summaryBytes": _integer(), "outputTreeLogicalBytes": _integer(),
        "outputTreeAllocatedBytes": _integer(), "outputTreeAllocatedHumanSize": _string(),
    })
    checks = _object({
        "sourceProvenanceFailures": _integer(), "identityFailures": _integer(),
        "schemaFailures": _integer(), "runReconciliationFailures": _integer(),
        "extrasReconciliationFailures": _integer(), "legalityFailures": _integer(),
        "wicketSemanticFailures": _integer(), "teamConsistencyFailures": _integer(),
        "targetFailures": _integer(), "duplicateMatchIds": _integer(),
    })
    counts = _object({
        "matches": _integer(), "normalInnings": _integer(), "superOverInnings": _integer(),
        "deliveries": _integer(), "impactPlayerReplacements": _integer(),
        "concussionSubstitutes": _integer(), "roleReplacements": _integer(),
        "substituteFieldingEvents": _integer(), "reviews": _integer(),
        "unresolvedIdentities": _integer(), "newIngestionUnsafeReviews": _integer(),
    })
    schema = _object({
        "schemaVersion": {"const": REPORT_SCHEMA_VERSION},
        "datasetVersion": {"const": "cricsheet-ipl-normalized/v1"},
        "normalizationManifestHash": _string(pattern=r"[0-9a-f]{64}"),
        "status": _string(enum=["passed", "passed_with_warnings"]),
        "counts": counts,
        "checks": checks,
        "dismissalKinds": _object({kind: _integer() for kind in [
            "bowled", "caught", "caught and bowled", "hit wicket", "lbw",
            "obstructing the field", "retired hurt", "retired out", "run out", "stumped",
        ]}),
        "extrasOccurrences": _object({key: _integer() for key in ["byes", "legbyes", "noballs", "penalty", "wides"]}),
        "sizeReport": size_report,
        "warningCount": _integer(),
        "warnings": _array(_issue_schema()),
        "errors": _array(_issue_schema()),
    })
    return {"$schema": SCHEMA_DRAFT, "title": "IPL normalization validation report", **schema}


def build_schema_documents() -> dict[str, dict[str, Any]]:
    return {
        "normalized_match.schema.json": build_normalized_match_schema(),
        "normalization_manifest.schema.json": build_manifest_schema(),
        "validation_report.schema.json": build_validation_report_schema(),
    }
