from __future__ import annotations

from typing import Any

from .aggregator import ANALYTICS_DATASET_VERSION, COHORTS, PHASES, ROW_SCHEMA_VERSIONS


SCHEMA_DRAFT = "https://json-schema.org/draft/2020-12/schema"
MANIFEST_SCHEMA_VERSION = "cricsheet-ipl-analytics-manifest/v1"
REPORT_SCHEMA_VERSION = "cricsheet-ipl-analytics-report/v1"


def _str(*, enum: list[str] | None = None, pattern: str | None = None, nullable: bool = False) -> dict[str, Any]:
    result: dict[str, Any] = {"type": ["string", "null"] if nullable else "string"}
    if not nullable: result["minLength"] = 1
    if enum is not None: result["enum"] = enum
    if pattern is not None: result["pattern"] = pattern
    return result


def _int(minimum: int = 0, *, nullable: bool = False) -> dict[str, Any]:
    result: dict[str, Any] = {"type": ["integer", "null"] if nullable else "integer"}
    if not nullable: result["minimum"] = minimum
    return result


def _num(*, nullable: bool = False) -> dict[str, Any]:
    return {"type": ["number", "null"] if nullable else "number"}


def _arr(items: dict[str, Any], *, unique: bool = False) -> dict[str, Any]:
    result: dict[str, Any] = {"type": "array", "items": items}
    if unique: result["uniqueItems"] = True
    return result


def _obj(properties: dict[str, Any]) -> dict[str, Any]:
    return {"type": "object", "additionalProperties": False, "required": list(properties), "properties": properties}


def _ref() -> dict[str, Any]:
    return _str()


def _extras() -> dict[str, Any]:
    return _obj({key: _int() for key in ("byes", "legByes", "noBalls", "penalty", "wides")})


def _bat() -> dict[str, Any]:
    return _obj({key: _int() for key in ("runs", "balls", "dismissals", "fours", "sixes", "boundaryBalls", "dotBalls")})


def _bowl() -> dict[str, Any]:
    return _obj({key: _int() for key in ("deliveryRecords", "legalBalls", "runsConceded", "creditedWickets", "dotBalls")})


def _team_metric() -> dict[str, Any]:
    return _obj({
        "innings": _int(), "runs": _int(), "batterRuns": _int(), "deliveryRecords": _int(), "legalBalls": _int(),
        "batterBalls": _int(), "dismissals": _int(), "creditedWickets": _int(), "fours": _int(), "sixes": _int(),
        "boundaryBalls": _int(), "battingDotBalls": _int(), "bowlingDotBalls": _int(), "extras": _extras(),
    })


def _phases(metric: dict[str, Any]) -> dict[str, Any]:
    return _obj({phase: metric for phase in PHASES})


def _base(schema_key: str, properties: dict[str, Any]) -> dict[str, Any]:
    return {"$schema": SCHEMA_DRAFT, **_obj({"schemaVersion": {"const": ROW_SCHEMA_VERSIONS[schema_key]}, "datasetVersion": {"const": ANALYTICS_DATASET_VERSION}, **properties})}


def build_match_summary_schema() -> dict[str, Any]:
    target = {"oneOf": [_obj({"overs": _num(), "runs": _int(1)}), {"type": "null"}]}
    innings = _obj({
        "inningsIndex": _int(1), "inningsOrder": _str(enum=["first", "chase"]), "battingTeamId": _ref(), "bowlingTeamId": _ref(),
        "target": target, "scheduledQuotaBalls": _int(1), "targetQuotaBalls": _int(nullable=True), "absentHurtCount": _int(),
        "hasMiscountedOvers": {"type": "boolean"}, "totals": _team_metric(), "phases": _phases(_team_metric()), "officialPowerplay": _team_metric(),
    })
    return _base("matchSummaries", {
        "matchId": _str(pattern=r"[0-9]+"), "normalizedMatchSha256": _str(pattern=r"[0-9a-f]{64}"), "seasonId": _ref(),
        "dates": _arr(_str(pattern=r"\d{4}-\d{2}-\d{2}")), "stage": _str(nullable=True),
        "cohort": _str(enum=list(COHORTS)), "isDls": {"type": "boolean"}, "hasRevisedTarget": {"type": "boolean"},
        "superOverInnings": _int(),
        "venue": _obj({key: _ref() for key in ("venueId", "venueSiteId", "canonicalName", "canonicalCity", "country")}),
        "teams": _arr(_obj({"teamId": _ref(), "franchiseId": _ref()}), unique=True),
        "outcome": _obj({"resultType": _str(enum=["win", "tie", "no_result"]), "winnerTeamId": _str(nullable=True), "eliminatorWinnerTeamId": _str(nullable=True), "method": _str(nullable=True)}),
        "normalInnings": _arr(innings),
    })


def build_player_schema() -> dict[str, Any]:
    delivery_entry = _obj({"sourceOverNumber": _int(), "sourceDeliveryIndex": _int(), "actualDelivery": _str(), "teamRunsBefore": _int(), "teamDismissalsBefore": _int(), "legalBallsBefore": _int()})
    bat_observation = _obj({"matchId": _str(pattern=r"[0-9]+"), "inningsIndex": _int(1), "position": {"type": "integer", "minimum": 1, "maximum": 11}, "entry": delivery_entry, "totals": _bat(), "phases": _phases(_bat()), "officialPowerplay": _bat()})
    bowl_observation = _obj({"matchId": _str(pattern=r"[0-9]+"), "inningsIndex": _int(1), "totals": _bowl(), "phases": _phases(_bowl()), "officialPowerplay": _bowl()})
    contribution = _obj({
        "matchId": _str(pattern=r"[0-9]+"), "officialListed": {"type": "boolean"}, "eventOnly": {"type": "boolean"},
        "recordedActions": _arr(_str(enum=["batting", "bowling", "fielding", "substitute_fielding", "absent_hurt", "review", "match_replacement_in", "match_replacement_out", "role_replacement_in", "role_replacement_out", "player_of_match"]), unique=True),
        "recordedFieldingOnly": {"type": "boolean"}, "normalBattingInnings": _int(), "normalBowlingInnings": _int(), "superOverAction": {"type": "boolean"},
        "replacementEvents": _obj({key: _int() for key in ("impactIn", "impactOut", "concussionIn", "concussionOut", "roleIn", "roleOut")}),
        "superOverEvents": _obj({key: _int() for key in ("impactIn", "impactOut", "concussionIn", "concussionOut", "roleIn", "roleOut", "substituteFielding")}),
    })
    rates_bat = _obj({key: _num(nullable=True) for key in ("average", "strikeRate", "boundaryBallRate", "dotBallRate")})
    rates_bowl = _obj({key: _num(nullable=True) for key in ("economyPerSixBalls", "strikeRate", "dotBallRate", "legalBallsPerBowlingMatch")})
    return _base("playerTeamSeasons", {
        "playerTeamSeasonId": _str(pattern=r"pts:[^:]+:[^:]+:[^:]+"), "playerId": _ref(), "canonicalDisplayName": _ref(),
        "seasonId": _ref(), "teamId": _ref(), "franchiseId": _ref(), "observedSourceNames": _arr(_ref(), unique=True),
        "participation": _obj({"officialListMatchCount": _int(), "recordedActionMatchCount": _int(), "documentedInvolvementMatchCount": _int(), "matchContributions": _arr(contribution)}),
        "batting": _obj({"innings": _int(), "totals": _bat(), "phases": _phases(_bat()), "officialPowerplay": _bat(), "inningsObservations": _arr(bat_observation), "positionCounts": _obj({str(i): _int() for i in range(1, 12)}), "rates": rates_bat}),
        "bowling": _obj({"innings": _int(), "totals": _bowl(), "phases": _phases(_bowl()), "officialPowerplay": _bowl(), "inningsObservations": _arr(bowl_observation), "matches": _int(), "rates": rates_bowl}),
        "fielding": _obj({key: _int() for key in ("catches", "caughtAndBowled", "stumpings", "runOutInvolvements", "substituteFieldingEvents")}),
    })


def build_team_schema() -> dict[str, Any]:
    return _base("teamSeasons", {
        "teamSeasonId": _str(pattern=r"ts:[^:]+:[^:]+"), "teamId": _ref(), "franchiseId": _ref(), "seasonId": _ref(),
        "matchIds": _arr(_str(pattern=r"[0-9]+"), unique=True), "playerTeamSeasonIds": _arr(_ref(), unique=True),
        "cohortCounts": _obj({key: _int() for key in COHORTS}), "results": _obj({key: _int() for key in ("wins", "losses", "ties", "noResults")}),
        "eliminatorResults": _obj({key: _int() for key in ("wins", "losses")}), "stageCounts": _arr(_obj({"stage": _ref(), "matches": _int()})),
        "inningsContexts": _obj({"battingFirst": _int(), "chasing": _int()}), "chaseOutcomes": _obj({key: _int() for key in ("successful", "failed", "tie", "no_result")}),
        "batting": _team_metric(), "bowling": _team_metric(), "battingPhases": _phases(_team_metric()), "bowlingPhases": _phases(_team_metric()),
        "officialPowerplayBatting": _team_metric(), "officialPowerplayBowling": _team_metric(), "inningsRuns": _arr(_int()), "inningsDismissals": _arr(_int()),
    })


def _context_schema() -> dict[str, Any]:
    histogram = _arr(_obj({"value": _int(), "count": _int(1)}))
    return _obj({
        "matchIds": _arr(_str(pattern=r"[0-9]+"), unique=True), "totals": _team_metric(), "firstInnings": _team_metric(), "chases": _team_metric(),
        "phases": _phases(_team_metric()), "officialPowerplay": _team_metric(), "inningsRunsHistogram": histogram,
        "inningsDismissalsHistogram": histogram, "chaseOutcomes": _obj({key: _int() for key in ("successful", "failed", "tie", "no_result")}),
    })


def _environment_properties() -> dict[str, Any]:
    return {"seasonId": _ref(), "matchIds": _arr(_str(pattern=r"[0-9]+"), unique=True), "cohorts": _obj({name: _context_schema() for name in ("all_normal", *COHORTS)})}


def build_season_schema() -> dict[str, Any]:
    return _base("seasonEnvironments", _environment_properties())


def build_venue_schema() -> dict[str, Any]:
    return _base("venueSeasonEnvironments", {**_environment_properties(), "venueSeasonId": _str(pattern=r"vse:[^:]+:[^:]+"), "venueSiteId": _ref(), "venueIds": _arr(_ref(), unique=True), "canonicalNames": _arr(_ref(), unique=True), "canonicalCities": _arr(_ref(), unique=True), "countries": _arr(_ref(), unique=True), "matchCountBand": _str(enum=["single_match", "two_to_four", "five_to_nine", "ten_plus"]), "smallSample": {"type": "boolean"}})


def build_manifest_schema() -> dict[str, Any]:
    artifact = _obj({"path": _ref(), "schemaVersion": _ref(), "rows": _int(), "sizeBytes": _int(), "sha256": _str(pattern=r"[0-9a-f]{64}")})
    schema_file = _obj({"path": _ref(), "sizeBytes": _int(), "sha256": _str(pattern=r"[0-9a-f]{64}")})
    return {"$schema": SCHEMA_DRAFT, **_obj({
        "schemaVersion": {"const": MANIFEST_SCHEMA_VERSION}, "datasetVersion": {"const": ANALYTICS_DATASET_VERSION},
        "phaseDefinitionVersion": {"const": "ipl-fixed-phases/v1"}, "stage1ArchiveManifestHash": _str(pattern=r"[0-9a-f]{64}"),
        "stage2RegistryVersion": _ref(), "stage2RegistryAggregateHash": _str(pattern=r"[0-9a-f]{64}"), "stage3DatasetVersion": _ref(),
        "stage3NormalizationManifestHash": _str(pattern=r"[0-9a-f]{64}"), "stage3NormalizedMatchAggregateHash": _str(pattern=r"[0-9a-f]{64}"),
        "artifacts": _arr(artifact), "schemaFiles": _arr(schema_file), "analyticalDataAggregateHash": _str(pattern=r"[0-9a-f]{64}"), "analyticalManifestHash": _str(pattern=r"[0-9a-f]{64}"),
    })}


def build_report_schema() -> dict[str, Any]:
    comparison = _obj({"dataset": _ref(), "baseline": _int(), "actual": _int(), "matches": {"type": "boolean"}, "explanation": _str(nullable=True)})
    histogram = _arr(_obj({"value": _num(), "count": _int(1)}))
    numeric_summary = _obj({"count": _int(), "minimum": _num(nullable=True), "median": _num(nullable=True), "average": _num(nullable=True), "maximum": _num(nullable=True), "histogram": histogram})
    participation_summary = _obj({key: numeric_summary for key in ("officialListMatchCount", "recordedActionMatchCount", "documentedInvolvementMatchCount")})
    per_season = _obj({"seasonId": _ref(), **{key: numeric_summary for key in ("officialListMatchCount", "recordedActionMatchCount", "documentedInvolvementMatchCount")}})
    distributions = _obj({
        "participation": _obj({
            "allSeasons": participation_summary, "perSeason": _arr(per_season), "preImpact": participation_summary, "impactEra": participation_summary,
            "matchContributionIntersections": _obj({key: _int() for key in ("officialAndRecorded", "officialOnly", "recordedOnly")}),
            "preImpactIntersections": _obj({key: _int() for key in ("officialAndRecorded", "officialOnly", "recordedOnly")}),
            "impactEraIntersections": _obj({key: _int() for key in ("officialAndRecorded", "officialOnly", "recordedOnly")}),
            "gapDistributions": _obj({key: numeric_summary for key in ("documentedMinusOfficial", "documentedMinusRecorded", "officialMinusRecorded")}),
        }),
        "samples": _obj({**{key: numeric_summary for key in ("battingInnings", "battingBalls", "bowlingInnings", "bowlingLegalBalls")}, "battingPositionAppearances": _obj({str(position): _int() for position in range(1, 12)})}),
        "evidenceProfileCounts": _obj({key: _int() for key in ("impactProfiles", "concussionProfiles", "roleReplacementProfiles", "substituteFieldingProfiles", "absentHurtProfiles", "eventOnlyProfiles")}),
        "evidenceEventCounts": _obj({key: _int() for key in ("impactReplacements", "concussionSubstitutes", "roleReplacements", "substituteFieldingEvents", "absentHurtParticipantMatches")}),
        "environment": _obj({
            "teamSeasons": _int(), "venueSeasons": _int(), "smallVenueSeasons": _int(), "teamSeasonMatchCounts": numeric_summary, "venueSeasonMatchCounts": numeric_summary,
            "venueSampleBands": _obj({key: _int() for key in ("single_match", "two_to_four", "five_to_nine", "ten_plus")}),
            "matchCohorts": _obj({key: _int() for key in COHORTS}),
        }),
        "representativeProfileIds": _obj({key: _str(nullable=True) for key in ("substantialBatting", "substantialBowling", "mixedUsage", "stumpingEvidence", "impactEvidence", "eventOnlyEvidence", "smallSample")}),
    })
    return {"$schema": SCHEMA_DRAFT, **_obj({
        "schemaVersion": {"const": REPORT_SCHEMA_VERSION}, "datasetVersion": {"const": ANALYTICS_DATASET_VERSION}, "analyticalManifestHash": _str(pattern=r"[0-9a-f]{64}"),
        "status": _str(enum=["passed", "passed_with_observations"]), "baselineComparisons": _arr(comparison),
        "counts": _obj({"normalInnings": _int(), "superOverInningsExcluded": _int(), "schemaFailures": _int(), "reconciliationFailures": _int(), "provenanceFailures": _int()}),
        "distributions": distributions,
        "sizeReport": _obj({"analyticalDataBytes": _int(), "schemaBundleBytes": _int(), "manifestBytes": _int(), "validationReportBytes": _int(), "summaryBytes": _int(), "outputTreeLogicalBytes": _int(), "outputTreeAllocatedBytes": _int(), "outputTreeAllocatedHumanSize": _ref()}),
        "errors": _arr(_str()), "observations": _arr(_str()),
    })}


def build_schema_documents() -> dict[str, dict[str, Any]]:
    return {
        "match_summary.schema.json": build_match_summary_schema(),
        "player_team_season.schema.json": build_player_schema(),
        "team_season.schema.json": build_team_schema(),
        "season_environment.schema.json": build_season_schema(),
        "venue_season_environment.schema.json": build_venue_schema(),
        "analytical_manifest.schema.json": build_manifest_schema(),
        "validation_report.schema.json": build_report_schema(),
    }
