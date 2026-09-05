from __future__ import annotations

import hashlib
import json
import math
import os
import statistics
import tempfile
from collections import Counter
from pathlib import Path
from typing import Any, Iterable

from scripts.cricsheet_audit.reporting import canonical_json_bytes, pretty_json_bytes
from scripts.identity_registry.schemas import SchemaValidationError, validate_instance


QUALITY_MODEL_VERSION = "ipl-era-draft-player-quality/v1"
PROFILE_SCHEMA_VERSION = "ipl-era-draft-player-team-season-quality/v1"
CONSUMER_SCHEMA_VERSION = "ipl-era-draft-player-quality-consumer/v1"
MODEL_SCHEMA_VERSION = "ipl-era-draft-player-quality-model/v1"
QUEUE_SCHEMA_VERSION = "ipl-era-draft-player-quality-review/v1"
MANIFEST_SCHEMA_VERSION = "ipl-era-draft-player-quality-manifest/v1"
VALIDATION_SCHEMA_VERSION = "ipl-era-draft-player-quality-validation/v1"
ISSUE_URL = "https://github.com/AviSharma01/draft-simulator/issues/3"

EVIDENCE_STATES = ("NONE", "LIMITED", "ESTABLISHED")
COMPONENTS = ("BATTING", "BOWLING")
TIERS = ("S", "A", "B", "C", "D")
BAT_WEIGHTS = {"production": 0.5, "scoring": 0.275, "survival": 0.225}
BOWL_WEIGHTS = {"production": 0.5, "economy": 0.275, "wicketRate": 0.225}
BAT_SCORING_PRIOR_BALLS = 90
BAT_SURVIVAL_PRIOR_DISMISSALS = 4
BOWL_PRIOR_BALLS = 108
TIER_THRESHOLDS = {"S": 0.90, "A": 0.45, "B": -0.45, "C": -0.90}
SECONDARY_BONUS_RATE = 0.20
SECONDARY_BONUS_CAP = 0.20

EXPECTED_CALIBRATION = {
    "batting": {
        "production": (0.1209705695741947, 0.04395081018108699, 0.06516147117447957),
        "scoring": (0.002711403191950305, 0.05739287925904738, 0.08509068278946365),
        "survival": (0.08321863489545511, 0.17168632252883098, 0.2545421417812448),
    },
    "bowling": {
        "production": (0.13052936910804933, 0.045802501772486334, 0.06790678912788824),
        "economy": (0.010098153644045106, 0.055271184996534314, 0.08194505887586177),
        "wicketRate": (0.007345474303599251, 0.13569900861218298, 0.20118735016842249),
    },
}

EXPECTED_COUNTS = {
    "g2Profiles": 2992,
    "g2Players": 727,
    "battingNone": 216,
    "battingLimited": 1698,
    "battingEstablished": 1078,
    "bowlingNone": 1025,
    "bowlingLimited": 943,
    "bowlingEstablished": 1024,
    "battingPrimary": 1593,
    "bowlingPrimary": 1399,
    "secondaryBonusRecipients": 29,
    "limitedUpperTierCases": 10,
    "limitedDFloorCases": 626,
    "blockingReviewCases": 0,
}
EXPECTED_TIER_COUNTS = {"S": 332, "A": 318, "B": 948, "C": 1243, "D": 151}


class PlayerQualityError(ValueError):
    pass


def _sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _read_json(path: Path, label: str) -> tuple[bytes, dict[str, Any]]:
    try:
        content = path.read_bytes()
        value = json.loads(content)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise PlayerQualityError(f"Could not read {label} at {path}: {error}") from error
    if not isinstance(value, dict):
        raise PlayerQualityError(f"{label} must be an object")
    return content, value


def _read_jsonl(path: Path, label: str) -> tuple[bytes, list[dict[str, Any]]]:
    try:
        content = path.read_bytes()
        rows = [json.loads(line) for line in content.splitlines() if line]
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise PlayerQualityError(f"Could not read {label} at {path}: {error}") from error
    if not all(isinstance(row, dict) for row in rows):
        raise PlayerQualityError(f"{label} must contain JSON objects")
    return content, rows


def _jsonl_bytes(rows: Iterable[dict[str, Any]]) -> bytes:
    return b"".join(canonical_json_bytes(row) for row in rows)


def _artifact_entry(
    path: str,
    content: bytes,
    schema_version: str,
    rows: int | None,
) -> dict[str, Any]:
    return {
        "path": path,
        "sha256": _sha256(content),
        "sizeBytes": len(content),
        "rows": rows,
        "schemaVersion": schema_version,
    }


def _aggregate_hash(files: dict[str, bytes]) -> str:
    digest = hashlib.sha256()
    for path, content in sorted(files.items()):
        digest.update(path.encode("utf-8"))
        digest.update(b"\0")
        digest.update(content)
    return digest.hexdigest()


def _assert_unique(
    rows: list[dict[str, Any]], key: str, label: str
) -> dict[str, dict[str, Any]]:
    indexed = {row[key]: row for row in rows}
    if len(indexed) != len(rows):
        raise PlayerQualityError(f"Duplicate {label}")
    return indexed


def _verify_self_hash(
    manifest: dict[str, Any], hash_field: str, label: str
) -> None:
    payload = dict(manifest)
    recorded = payload.pop(hash_field, None)
    if recorded != _sha256(canonical_json_bytes(payload)):
        raise PlayerQualityError(f"{label} self-hash is invalid")


def _load_stage4(
    root: Path,
) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    _, manifest = _read_json(root / "analytical_manifest.json", "Stage 4 analytical manifest")
    _verify_self_hash(manifest, "analyticalManifestHash", "Stage 4 analytical manifest")
    entries = {row["path"]: row for row in manifest.get("artifacts", [])}
    loaded: dict[str, list[dict[str, Any]]] = {}
    for path in (
        "player_team_seasons.jsonl",
        "team_seasons.jsonl",
        "season_environments.jsonl",
    ):
        entry = entries.get(path)
        if entry is None:
            raise PlayerQualityError(f"Stage 4 rating input is missing: {path}")
        content, rows = _read_jsonl(root / path, f"Stage 4 {path}")
        if (
            len(content) != entry["sizeBytes"]
            or _sha256(content) != entry["sha256"]
            or len(rows) != entry["rows"]
        ):
            raise PlayerQualityError(f"Stage 4 rating-input integrity failure: {path}")
        loaded[path] = rows
    return (
        manifest,
        loaded["player_team_seasons.jsonl"],
        loaded["team_seasons.jsonl"],
        loaded["season_environments.jsonl"],
    )


def _load_eligibility(root: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    _, manifest = _read_json(root / "eligibility_manifest.json", "G2 eligibility manifest")
    _verify_self_hash(manifest, "eligibilityManifestHash", "G2 eligibility manifest")
    entry = next(
        (row for row in manifest.get("artifacts", []) if row.get("path") == "eligibility.jsonl"),
        None,
    )
    if entry is None:
        raise PlayerQualityError("G2 eligibility rows are missing")
    content, rows = _read_jsonl(root / "eligibility.jsonl", "G2 eligibility rows")
    if (
        len(content) != entry["sizeBytes"]
        or _sha256(content) != entry["sha256"]
        or len(rows) != entry["rows"]
    ):
        raise PlayerQualityError("G2 eligibility integrity failure")
    return manifest, rows


def batting_evidence(innings: int, balls: int, dismissals: int) -> str:
    if innings == 0:
        return "NONE"
    if balls >= BAT_SCORING_PRIOR_BALLS and dismissals >= BAT_SURVIVAL_PRIOR_DISMISSALS:
        return "ESTABLISHED"
    return "LIMITED"


def bowling_evidence(delivery_records: int, legal_balls: int) -> str:
    if delivery_records == 0:
        return "NONE"
    if legal_balls >= BOWL_PRIOR_BALLS:
        return "ESTABLISHED"
    return "LIMITED"


def season_baseline(environment: dict[str, Any]) -> dict[str, float]:
    totals = environment["cohorts"]["all_normal"]["totals"]
    required_positive = {
        "innings": totals["innings"],
        "batterBalls": totals["batterBalls"],
        "dismissals": totals["dismissals"],
        "legalBalls": totals["legalBalls"],
        "creditedWickets": totals["creditedWickets"],
    }
    if any(value <= 0 for value in required_positive.values()):
        raise PlayerQualityError(
            f"Season {environment['seasonId']} has an invalid rating denominator: {required_positive}"
        )
    chargeable_runs = (
        totals["runs"]
        - totals["extras"]["byes"]
        - totals["extras"]["legByes"]
        - totals["extras"]["penalty"]
    )
    if chargeable_runs <= 0:
        raise PlayerQualityError(f"Season {environment['seasonId']} has no chargeable runs")
    return {
        "battingRunRatePerBall": totals["batterRuns"] / totals["batterBalls"],
        "battingAverage": totals["batterRuns"] / totals["dismissals"],
        "batterRunsPerInnings": totals["batterRuns"] / totals["innings"],
        "bowlingEconomyPerSixBalls": 6 * chargeable_runs / totals["legalBalls"],
        "bowlerWicketRatePerBall": totals["creditedWickets"] / totals["legalBalls"],
        "creditedWicketsPerInnings": totals["creditedWickets"] / totals["innings"],
    }


def calculate_batting_primitives(
    *,
    runs: int,
    balls: int,
    dismissals: int,
    team_batting_innings: int,
    baseline: dict[str, float],
) -> dict[str, float]:
    if team_batting_innings <= 0:
        raise PlayerQualityError("Team batting innings must be positive")
    scoring = (
        runs + BAT_SCORING_PRIOR_BALLS * baseline["battingRunRatePerBall"]
    ) / (balls + BAT_SCORING_PRIOR_BALLS)
    survival = (
        runs + BAT_SURVIVAL_PRIOR_DISMISSALS * baseline["battingAverage"]
    ) / (dismissals + BAT_SURVIVAL_PRIOR_DISMISSALS)
    return {
        "production": (runs / team_batting_innings) / baseline["batterRunsPerInnings"],
        "scoring": math.log(scoring / baseline["battingRunRatePerBall"]),
        "survival": math.log(survival / baseline["battingAverage"]),
    }


def calculate_bowling_primitives(
    *,
    wickets: int,
    legal_balls: int,
    runs_conceded: int,
    team_bowling_innings: int,
    baseline: dict[str, float],
) -> dict[str, float]:
    if team_bowling_innings <= 0:
        raise PlayerQualityError("Team bowling innings must be positive")
    economy = 6 * (
        runs_conceded
        + BOWL_PRIOR_BALLS * baseline["bowlingEconomyPerSixBalls"] / 6
    ) / (legal_balls + BOWL_PRIOR_BALLS)
    wicket_rate = (
        wickets + BOWL_PRIOR_BALLS * baseline["bowlerWicketRatePerBall"]
    ) / (legal_balls + BOWL_PRIOR_BALLS)
    return {
        "production": (wickets / team_bowling_innings)
        / baseline["creditedWicketsPerInnings"],
        "economy": math.log(baseline["bowlingEconomyPerSixBalls"] / economy),
        "wicketRate": math.log(wicket_rate / baseline["bowlerWicketRatePerBall"]),
    }


def robust_context(values: list[float]) -> dict[str, float]:
    if not values:
        raise PlayerQualityError("Cannot calibrate an empty primitive population")
    median = statistics.median(values)
    mad = statistics.median(abs(value - median) for value in values)
    spread = 1.4826 * mad
    if spread <= 0:
        raise PlayerQualityError("Primitive calibration has zero robust spread")
    return {"median": median, "mad": mad, "robustSpread": spread}


def _standardize(value: float, context: dict[str, float]) -> float:
    return (value - context["median"]) / context["robustSpread"]


def rating_from_internal(internal_score: float) -> float:
    return 60 + 40 * math.tanh(internal_score / 1.8)


def raw_quality_tier(internal_score: float) -> str:
    if internal_score >= TIER_THRESHOLDS["S"]:
        return "S"
    if internal_score >= TIER_THRESHOLDS["A"]:
        return "A"
    if internal_score >= TIER_THRESHOLDS["B"]:
        return "B"
    if internal_score >= TIER_THRESHOLDS["C"]:
        return "C"
    return "D"


def secondary_bonus(
    batting_score: float | None,
    batting_state: str,
    bowling_score: float | None,
    bowling_state: str,
) -> float:
    if (
        batting_state != "ESTABLISHED"
        or bowling_state != "ESTABLISHED"
        or batting_score is None
        or bowling_score is None
    ):
        return 0.0
    return min(
        SECONDARY_BONUS_CAP,
        SECONDARY_BONUS_RATE * max(0.0, min(batting_score, bowling_score)),
    )


def _published(value: float | None, digits: int = 6) -> float | None:
    if value is None:
        return None
    result = round(value, digits)
    return 0.0 if result == 0 else result


def _rating(value: float | None) -> float | None:
    return _published(rating_from_internal(value), 1) if value is not None else None


def _calibration(
    prepared: list[dict[str, Any]], discipline: str, primitive_names: tuple[str, ...]
) -> dict[str, dict[str, float]]:
    evidence_key = "battingEvidence" if discipline == "batting" else "bowlingEvidence"
    primitive_key = "battingPrimitives" if discipline == "batting" else "bowlingPrimitives"
    established = [row for row in prepared if row[evidence_key] == "ESTABLISHED"]
    contexts = {
        name: robust_context([row[primitive_key][name] for row in established])
        for name in primitive_names
    }
    for name, expected in EXPECTED_CALIBRATION[discipline].items():
        actual = contexts[name]
        values = (actual["median"], actual["mad"], actual["robustSpread"])
        if any(round(value, 12) != round(target, 12) for value, target in zip(values, expected)):
            raise PlayerQualityError(
                f"Frozen {discipline} {name} calibration drift: expected={expected}, actual={values}"
            )
    return contexts


def _component_record(
    *,
    state: str,
    inputs: dict[str, int],
    baseline: dict[str, float],
    primitives: dict[str, float] | None,
    calibration: dict[str, dict[str, float]],
    weights: dict[str, float],
    rating_field: str,
) -> tuple[dict[str, Any], float | None]:
    if state == "NONE":
        return {
            "evidenceState": state,
            "inputs": inputs,
            "seasonBaseline": {key: _published(value) for key, value in baseline.items()},
            "primitives": None,
            "standardizedPrimitives": None,
            "internalScore": None,
            rating_field: None,
        }, None
    if primitives is None:
        raise PlayerQualityError("Observed component lacks primitives")
    standardized = {
        key: _standardize(primitives[key], calibration[key]) for key in weights
    }
    internal = sum(weights[key] * standardized[key] for key in weights)
    return {
        "evidenceState": state,
        "inputs": inputs,
        "seasonBaseline": {key: _published(value) for key, value in baseline.items()},
        "primitives": {key: _published(value) for key, value in primitives.items()},
        "standardizedPrimitives": {
            key: _published(value) for key, value in standardized.items()
        },
        "internalScore": _published(internal),
        rating_field: _rating(internal),
    }, internal


def _percentile(values: list[float], percentile: int) -> float:
    ordered = sorted(values)
    position = (len(ordered) - 1) * percentile / 100
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def score_distribution(values: list[float]) -> dict[str, Any]:
    context = robust_context(values)
    return {
        "count": len(values),
        "minimum": _published(min(values)),
        "p5": _published(_percentile(values, 5)),
        "p10": _published(_percentile(values, 10)),
        "p25": _published(_percentile(values, 25)),
        "median": _published(context["median"]),
        "p75": _published(_percentile(values, 75)),
        "p90": _published(_percentile(values, 90)),
        "p95": _published(_percentile(values, 95)),
        "maximum": _published(max(values)),
        "mad": _published(context["mad"]),
        "robustSpread": _published(context["robustSpread"]),
    }


def calculate_quality_dataset(
    *,
    player_rows: list[dict[str, Any]],
    team_rows: list[dict[str, Any]],
    environment_rows: list[dict[str, Any]],
    eligible_ids: set[str],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    player_by_id = _assert_unique(player_rows, "playerTeamSeasonId", "Stage 4 profile ID")
    team_by_id = _assert_unique(team_rows, "teamSeasonId", "Stage 4 team-season ID")
    environment_by_id = _assert_unique(
        environment_rows, "seasonId", "Stage 4 season-environment ID"
    )
    if eligible_ids - set(player_by_id):
        raise PlayerQualityError("G2 eligibility references profiles absent from Stage 4")

    prepared: list[dict[str, Any]] = []
    baselines = {season_id: season_baseline(row) for season_id, row in environment_by_id.items()}
    for pts_id in sorted(eligible_ids):
        source = player_by_id[pts_id]
        team_id = f"ts:{source['teamId']}:{source['seasonId']}"
        team = team_by_id.get(team_id)
        baseline = baselines.get(source["seasonId"])
        if team is None or baseline is None:
            raise PlayerQualityError(f"Missing team/environment rating input for {pts_id}")
        batting = source["batting"]
        bowling = source["bowling"]
        bat_totals = batting["totals"]
        bowl_totals = bowling["totals"]
        bat_state = batting_evidence(
            batting["innings"], bat_totals["balls"], bat_totals["dismissals"]
        )
        bowl_state = bowling_evidence(
            bowl_totals["deliveryRecords"], bowl_totals["legalBalls"]
        )
        prepared.append({
            "source": source,
            "baseline": baseline,
            "battingEvidence": bat_state,
            "bowlingEvidence": bowl_state,
            "battingInputs": {
                "innings": batting["innings"],
                "runs": bat_totals["runs"],
                "balls": bat_totals["balls"],
                "dismissals": bat_totals["dismissals"],
                "teamBattingInnings": team["batting"]["innings"],
            },
            "bowlingInputs": {
                "innings": bowling["innings"],
                "deliveryRecords": bowl_totals["deliveryRecords"],
                "legalBalls": bowl_totals["legalBalls"],
                "runsConceded": bowl_totals["runsConceded"],
                "creditedWickets": bowl_totals["creditedWickets"],
                "teamBowlingInnings": team["bowling"]["innings"],
            },
            "battingPrimitives": None if bat_state == "NONE" else calculate_batting_primitives(
                runs=bat_totals["runs"],
                balls=bat_totals["balls"],
                dismissals=bat_totals["dismissals"],
                team_batting_innings=team["batting"]["innings"],
                baseline=baseline,
            ),
            "bowlingPrimitives": None if bowl_state == "NONE" else calculate_bowling_primitives(
                wickets=bowl_totals["creditedWickets"],
                legal_balls=bowl_totals["legalBalls"],
                runs_conceded=bowl_totals["runsConceded"],
                team_bowling_innings=team["bowling"]["innings"],
                baseline=baseline,
            ),
        })

    batting_calibration = _calibration(
        prepared, "batting", ("production", "scoring", "survival")
    )
    bowling_calibration = _calibration(
        prepared, "bowling", ("production", "economy", "wicketRate")
    )

    profiles: list[dict[str, Any]] = []
    consumers: list[dict[str, Any]] = []
    for item in prepared:
        source = item["source"]
        baseline = item["baseline"]
        batting_baseline = {
            "runRatePerBall": baseline["battingRunRatePerBall"],
            "average": baseline["battingAverage"],
            "batterRunsPerInnings": baseline["batterRunsPerInnings"],
        }
        bowling_baseline = {
            "economyPerSixBalls": baseline["bowlingEconomyPerSixBalls"],
            "wicketRatePerBall": baseline["bowlerWicketRatePerBall"],
            "creditedWicketsPerInnings": baseline["creditedWicketsPerInnings"],
        }
        batting, batting_score = _component_record(
            state=item["battingEvidence"],
            inputs=item["battingInputs"],
            baseline=batting_baseline,
            primitives=item["battingPrimitives"],
            calibration=batting_calibration,
            weights=BAT_WEIGHTS,
            rating_field="battingRating",
        )
        bowling, bowling_score = _component_record(
            state=item["bowlingEvidence"],
            inputs=item["bowlingInputs"],
            baseline=bowling_baseline,
            primitives=item["bowlingPrimitives"],
            calibration=bowling_calibration,
            weights=BOWL_WEIGHTS,
            rating_field="bowlingRating",
        )
        candidates = []
        if batting_score is not None:
            candidates.append((batting_score, "BATTING", item["battingEvidence"]))
        if bowling_score is not None:
            candidates.append((bowling_score, "BOWLING", item["bowlingEvidence"]))
        if not candidates:
            raise PlayerQualityError(f"G2 profile has no defensible quality component: {source['playerTeamSeasonId']}")
        primary_score, primary_component, primary_evidence = max(
            candidates, key=lambda value: (value[0], value[1] == "BATTING")
        )
        bonus = secondary_bonus(
            batting_score,
            item["battingEvidence"],
            bowling_score,
            item["bowlingEvidence"],
        )
        overall_score = primary_score + bonus
        raw_tier = raw_quality_tier(overall_score)
        has_established = "ESTABLISHED" in {
            item["battingEvidence"], item["bowlingEvidence"]
        }
        floor_applied = raw_tier == "D" and not has_established
        quality_tier = "C" if floor_applied else raw_tier
        tier_decision = {
            "rawTier": raw_tier,
            "qualityTier": quality_tier,
            "limitedDFloorApplied": floor_applied,
            "establishedEvidenceSupportsD": raw_tier == "D" and has_established,
        }
        overall = {
            "primaryComponent": primary_component,
            "evidenceState": primary_evidence,
            "primaryInternalScore": _published(primary_score),
            "secondaryBonus": _published(bonus),
            "internalScore": _published(overall_score),
            "overallRating": _rating(overall_score),
            "tierDecision": tier_decision,
        }
        identity = {
            key: source[key] for key in (
                "playerTeamSeasonId", "playerId", "canonicalDisplayName",
                "seasonId", "teamId", "franchiseId",
            )
        }
        profile = {
            "schemaVersion": PROFILE_SCHEMA_VERSION,
            "qualityModelVersion": QUALITY_MODEL_VERSION,
            **identity,
            "batting": batting,
            "bowling": bowling,
            "overall": overall,
        }
        consumer = {
            "schemaVersion": CONSUMER_SCHEMA_VERSION,
            "qualityModelVersion": QUALITY_MODEL_VERSION,
            **identity,
            "batting": {
                key: batting[key]
                for key in ("evidenceState", "internalScore", "battingRating")
            },
            "bowling": {
                key: bowling[key]
                for key in ("evidenceState", "internalScore", "bowlingRating")
            },
            "overall": {
                "primaryComponent": primary_component,
                "evidenceState": primary_evidence,
                "primaryInternalScore": _published(primary_score),
                "secondaryBonus": _published(bonus),
                "internalScore": _published(overall_score),
                "overallRating": _rating(overall_score),
                "qualityTier": quality_tier,
                "limitedDFloorApplied": floor_applied,
            },
        }
        profiles.append(profile)
        consumers.append(consumer)

    calibration = {
        "batting": {
            key: {name: _published(value, 12) for name, value in context.items()}
            for key, context in batting_calibration.items()
        },
        "bowling": {
            key: {name: _published(value, 12) for name, value in context.items()}
            for key, context in bowling_calibration.items()
        },
    }
    return profiles, consumers, calibration


def _string(enum: Iterable[str] | None = None, pattern: str | None = None) -> dict[str, Any]:
    result: dict[str, Any] = {"type": "string", "minLength": 1}
    if enum is not None:
        result["enum"] = list(enum)
    if pattern is not None:
        result["pattern"] = pattern
    return result


def _integer() -> dict[str, Any]:
    return {"type": "integer", "minimum": 0}


def _number(nullable: bool = False, minimum: float | None = None, maximum: float | None = None) -> dict[str, Any]:
    result: dict[str, Any] = {"type": ["number", "null"] if nullable else "number"}
    if minimum is not None:
        result["minimum"] = minimum
    if maximum is not None:
        result["maximum"] = maximum
    return result


def _array(items: dict[str, Any], unique: bool = False) -> dict[str, Any]:
    result: dict[str, Any] = {"type": "array", "items": items}
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


def build_quality_schemas() -> dict[str, dict[str, Any]]:
    identity = {
        "playerTeamSeasonId": _string(pattern=r"pts:[^:]+:ipl-[0-9]{4}:[^:]+"),
        "playerId": _string(pattern=r"[0-9a-f]{8}"),
        "canonicalDisplayName": _string(),
        "seasonId": _string(pattern=r"ipl-[0-9]{4}"),
        "teamId": _string(),
        "franchiseId": _string(),
    }
    def compact_component(rating_field: str) -> dict[str, Any]:
        return {"oneOf": [
            _object({
                "evidenceState": _string(("NONE",)),
                "internalScore": {"type": "null"},
                rating_field: {"type": "null"},
            }),
            _object({
                "evidenceState": _string(("LIMITED", "ESTABLISHED")),
                "internalScore": _number(),
                rating_field: _number(minimum=20, maximum=100),
            }),
        ]}
    batting_inputs = _object({key: _integer() for key in (
        "innings", "runs", "balls", "dismissals", "teamBattingInnings"
    )})
    bowling_inputs = _object({key: _integer() for key in (
        "innings", "deliveryRecords", "legalBalls", "runsConceded",
        "creditedWickets", "teamBowlingInnings",
    )})
    batting_baseline = _object({key: _number(minimum=0) for key in (
        "runRatePerBall", "average", "batterRunsPerInnings"
    )})
    bowling_baseline = _object({key: _number(minimum=0) for key in (
        "economyPerSixBalls", "wicketRatePerBall", "creditedWicketsPerInnings"
    )})
    bat_metrics = _object({key: _number() for key in ("production", "scoring", "survival")})
    bowl_metrics = _object({key: _number() for key in ("production", "economy", "wicketRate")})
    def full_component(
        inputs: dict[str, Any],
        baseline: dict[str, Any],
        metrics: dict[str, Any],
        rating_field: str,
    ) -> dict[str, Any]:
        return {"oneOf": [
            _object({
                "evidenceState": _string(("NONE",)),
                "inputs": inputs,
                "seasonBaseline": baseline,
                "primitives": {"type": "null"},
                "standardizedPrimitives": {"type": "null"},
                "internalScore": {"type": "null"},
                rating_field: {"type": "null"},
            }),
            _object({
                "evidenceState": _string(("LIMITED", "ESTABLISHED")),
                "inputs": inputs,
                "seasonBaseline": baseline,
                "primitives": metrics,
                "standardizedPrimitives": metrics,
                "internalScore": _number(),
                rating_field: _number(minimum=20, maximum=100),
            }),
        ]}
    tier_decision = _object({
        "rawTier": _string(TIERS),
        "qualityTier": _string(TIERS),
        "limitedDFloorApplied": {"type": "boolean"},
        "establishedEvidenceSupportsD": {"type": "boolean"},
    })
    full_overall = _object({
        "primaryComponent": _string(COMPONENTS),
        "evidenceState": _string(("LIMITED", "ESTABLISHED")),
        "primaryInternalScore": _number(),
        "secondaryBonus": _number(minimum=0, maximum=SECONDARY_BONUS_CAP),
        "internalScore": _number(),
        "overallRating": _number(minimum=20, maximum=100),
        "tierDecision": tier_decision,
    })
    compact_overall = _object({
        "primaryComponent": _string(COMPONENTS),
        "evidenceState": _string(("LIMITED", "ESTABLISHED")),
        "primaryInternalScore": _number(),
        "secondaryBonus": _number(minimum=0, maximum=SECONDARY_BONUS_CAP),
        "internalScore": _number(),
        "overallRating": _number(minimum=20, maximum=100),
        "qualityTier": _string(TIERS),
        "limitedDFloorApplied": {"type": "boolean"},
    })
    profile = _object({
        "schemaVersion": _string((PROFILE_SCHEMA_VERSION,)),
        "qualityModelVersion": _string((QUALITY_MODEL_VERSION,)),
        **identity,
        "batting": full_component(
            batting_inputs, batting_baseline, bat_metrics, "battingRating"
        ),
        "bowling": full_component(
            bowling_inputs, bowling_baseline, bowl_metrics, "bowlingRating"
        ),
        "overall": full_overall,
    })
    consumer = _object({
        "schemaVersion": _string((CONSUMER_SCHEMA_VERSION,)),
        "qualityModelVersion": _string((QUALITY_MODEL_VERSION,)),
        **identity,
        "batting": compact_component("battingRating"),
        "bowling": compact_component("bowlingRating"),
        "overall": compact_overall,
    })
    calibration_value = _object({
        "median": _number(), "mad": _number(minimum=0), "robustSpread": _number(minimum=0),
    })
    model = _object({
        "schemaVersion": _string((MODEL_SCHEMA_VERSION,)),
        "qualityModelVersion": _string((QUALITY_MODEL_VERSION,)),
        "trackingIssue": _string(pattern=r"https://github\.com/.+/issues/[0-9]+"),
        "inputPolicy": _object({
            "teamOpportunityDenominator": _string(("FULL_TEAM_NORMAL_INNINGS",)),
            "seasonEnvironmentCohort": _string(("all_normal",)),
            "calibrationPopulation": _string(("G2_ESTABLISHED_PER_COMPONENT",)),
            "calibrationMethod": _string(("MEDIAN_MAD_TIMES_1_4826",)),
        }),
        "batting": _object({
            "modelId": _string(("B50-M",)),
            "productionFormula": _string((
                "(runs / fullTeamBattingInnings) / allNormalBatterRunsPerInnings",
            )),
            "scoringFormula": _string((
                "ln(((runs + 90 * allNormalRunRatePerBall) / (balls + 90)) / allNormalRunRatePerBall)",
            )),
            "survivalFormula": _string((
                "ln(((runs + 4 * allNormalBattingAverage) / (dismissals + 4)) / allNormalBattingAverage)",
            )),
            "internalScoreFormula": _string((
                "0.50 * zProduction + 0.275 * zScoring + 0.225 * zSurvival",
            )),
            "weights": _object({key: _number(minimum=0, maximum=1) for key in BAT_WEIGHTS}),
            "scoringPriorBalls": _integer(),
            "survivalPriorDismissals": _integer(),
            "establishedMinimumBalls": _integer(),
            "establishedMinimumDismissals": _integer(),
            "calibration": _object({key: calibration_value for key in BAT_WEIGHTS}),
        }),
        "bowling": _object({
            "modelId": _string(("Q50-S",)),
            "productionFormula": _string((
                "(creditedWickets / fullTeamBowlingInnings) / allNormalCreditedWicketsPerInnings",
            )),
            "economyFormula": _string((
                "ln(allNormalEconomyPerSixBalls / (6 * (runsConceded + 108 * allNormalEconomyPerSixBalls / 6) / (legalBalls + 108)))",
            )),
            "wicketRateFormula": _string((
                "ln(((creditedWickets + 108 * allNormalWicketRatePerBall) / (legalBalls + 108)) / allNormalWicketRatePerBall)",
            )),
            "internalScoreFormula": _string((
                "0.50 * zProduction + 0.275 * zEconomy + 0.225 * zWicketRate",
            )),
            "weights": _object({key: _number(minimum=0, maximum=1) for key in BOWL_WEIGHTS}),
            "priorBalls": _integer(),
            "establishedMinimumLegalBalls": _integer(),
            "wicketDefinition": _string(("CREDITED_BOWLER_WICKETS_ONLY",)),
            "calibration": _object({key: calibration_value for key in BOWL_WEIGHTS}),
        }),
        "ratingMapping": _object({
            "formula": _string(("60 + 40 * tanh(internalScore / 1.8)",)),
            "internalScorePublishedDecimalPlaces": _integer(),
            "ratingPublishedDecimalPlaces": _integer(),
            "tierDecisionInput": _string(("UNROUNDED_INTERNAL_SCORE",)),
        }),
        "evidencePolicy": _object({
            "battingNone": _string(("innings == 0",)),
            "battingLimited": _string((
                "innings > 0 AND (balls < 90 OR dismissals < 4)",
            )),
            "battingEstablished": _string(("balls >= 90 AND dismissals >= 4",)),
            "bowlingNone": _string(("deliveryRecords == 0",)),
            "bowlingLimited": _string(("deliveryRecords > 0 AND legalBalls < 108",)),
            "bowlingEstablished": _string(("legalBalls >= 108",)),
            "noneComponentOutput": _string(("NULL_INTERNAL_SCORE_AND_RATING",)),
        }),
        "overall": _object({
            "primarySelection": _string(("HIGHEST_AVAILABLE_COMPONENT",)),
            "secondaryBonusEligibility": _string(("BOTH_COMPONENTS_ESTABLISHED",)),
            "secondaryBonusFormula": _string(("min(0.20, 0.20 * max(0, min(B, Q)))",)),
            "secondaryBonusCap": _number(minimum=0, maximum=1),
        }),
        "tiers": _object({
            "thresholds": _object({key: _number() for key in ("S", "A", "B", "C")}),
            "limitedDFloor": _string(("D_REQUIRES_ANY_ESTABLISHED_COMPONENT",)),
            "limitedUpperTierCeiling": {"type": "null"},
        }),
        "forbiddenInputs": _array(_string(), unique=True),
    })
    review_item = _object({
        "reviewId": _string(),
        "reviewStatus": _string(("DIAGNOSTIC_ONLY",)),
        "playerTeamSeasonId": _string(),
        "primaryComponent": _string(COMPONENTS),
        "primaryEvidenceState": _string(("LIMITED",)),
        "overallInternalScore": _number(),
        "overallRating": _number(minimum=20, maximum=100),
        "qualityTier": _string(TIERS),
        "reason": _string(("LIMITED_UPPER_TIER", "LIMITED_D_FLOOR")),
    })
    queue = _object({
        "schemaVersion": _string((QUEUE_SCHEMA_VERSION,)),
        "qualityModelVersion": _string((QUALITY_MODEL_VERSION,)),
        "scope": _string(("G2_PLAYER_QUALITY",)),
        "summary": _object({
            "blockingCases": _integer(),
            "limitedUpperTierCases": _integer(),
            "limitedDFloorCases": _integer(),
        }),
        "blockingItems": _array(_object({"reviewId": _string(), "reason": _string()})),
        "limitedUpperTierItems": _array(review_item),
        "limitedDFloorItems": _array(review_item),
        "completionBoundary": _string(),
    })
    artifact = _object({
        "path": _string(), "sha256": _string(pattern=r"[0-9a-f]{64}"),
        "sizeBytes": _integer(), "rows": {"type": ["integer", "null"], "minimum": 0},
        "schemaVersion": _string(),
    })
    rating_input = _object({
        "source": _string(("STAGE_4_ANALYTICAL", "G2_ELIGIBILITY")),
        "path": _string(),
        "sha256": _string(pattern=r"[0-9a-f]{64}"),
        "sizeBytes": _integer(),
        "rows": _integer(),
        "schemaVersion": _string(),
    })
    manifest = _object({
        "schemaVersion": _string((MANIFEST_SCHEMA_VERSION,)),
        "qualityModelVersion": _string((QUALITY_MODEL_VERSION,)),
        "trackingIssue": _string(pattern=r"https://github\.com/.+/issues/[0-9]+"),
        "stage4DatasetVersion": _string(),
        "stage4AnalyticalManifestHash": _string(pattern=r"[0-9a-f]{64}"),
        "eligibilityVersion": _string(),
        "eligibilityManifestHash": _string(pattern=r"[0-9a-f]{64}"),
        "ratingInputs": _array(rating_input),
        "artifacts": _array(artifact),
        "schemaFiles": _array(artifact),
        "qualityDataAggregateHash": _string(pattern=r"[0-9a-f]{64}"),
        "qualityManifestHash": _string(pattern=r"[0-9a-f]{64}"),
    })
    stats = _object({
        "count": _integer(), "minimum": _number(), "p5": _number(), "p10": _number(),
        "p25": _number(), "median": _number(), "p75": _number(), "p90": _number(),
        "p95": _number(), "maximum": _number(), "mad": _number(minimum=0),
        "robustSpread": _number(minimum=0),
    })
    validation = _object({
        "schemaVersion": _string((VALIDATION_SCHEMA_VERSION,)),
        "qualityModelVersion": _string((QUALITY_MODEL_VERSION,)),
        "qualityManifestHash": _string(pattern=r"[0-9a-f]{64}"),
        "status": _string(("passed",)),
        "baselineComparisons": _array(_object({
            "metric": _string(), "expected": _integer(), "actual": _integer(),
            "matches": {"type": "boolean"},
        })),
        "counts": _object({key: _integer() for key in EXPECTED_COUNTS}),
        "battingEvidenceCounts": _object({key: _integer() for key in EVIDENCE_STATES}),
        "bowlingEvidenceCounts": _object({key: _integer() for key in EVIDENCE_STATES}),
        "componentDistributions": _object({"B": stats, "Q": stats}),
        "overallPrimaryCounts": _object({key: _integer() for key in COMPONENTS}),
        "secondaryBonus": _object({
            "eligibleProfiles": _integer(), "recipientProfiles": _integer(),
            "medianAmongRecipients": _number(minimum=0), "p90AmongRecipients": _number(minimum=0),
            "maximum": _number(minimum=0, maximum=SECONDARY_BONUS_CAP),
        }),
        "qualityTierCounts": _object({key: _integer() for key in TIERS}),
        "limitedPrimaryTierCounts": _object({key: _integer() for key in TIERS}),
        "errors": _array(_string()),
    })
    return {
        "player_team_season_quality.schema.json": {"$schema": "https://json-schema.org/draft/2020-12/schema", **profile},
        "player_quality_consumer.schema.json": {"$schema": "https://json-schema.org/draft/2020-12/schema", **consumer},
        "quality_model.schema.json": {"$schema": "https://json-schema.org/draft/2020-12/schema", **model},
        "review_queue.schema.json": {"$schema": "https://json-schema.org/draft/2020-12/schema", **queue},
        "quality_manifest.schema.json": {"$schema": "https://json-schema.org/draft/2020-12/schema", **manifest},
        "validation_report.schema.json": {"$schema": "https://json-schema.org/draft/2020-12/schema", **validation},
    }


def _validate_profile_invariants(profile: dict[str, Any]) -> None:
    for component_name in ("batting", "bowling"):
        component = profile[component_name]
        is_none = component["evidenceState"] == "NONE"
        nullable = (
            component["primitives"], component["standardizedPrimitives"],
            component["internalScore"], component[f"{component_name}Rating"],
        )
        if is_none != all(value is None for value in nullable):
            raise PlayerQualityError(f"{component_name} NONE/nullability invariant failed")
        if not is_none and any(value is None for value in nullable):
            raise PlayerQualityError(f"{component_name} observed/nullability invariant failed")
    overall = profile["overall"]
    selected = profile[overall["primaryComponent"].lower()]
    if overall["evidenceState"] != selected["evidenceState"]:
        raise PlayerQualityError("Overall evidence does not match primary component")
    if abs(overall["primaryInternalScore"] - selected["internalScore"]) > 0.000002:
        raise PlayerQualityError("Overall primary score does not match primary component")
    available_scores = [
        component["internalScore"]
        for component in (profile["batting"], profile["bowling"])
        if component["internalScore"] is not None
    ]
    if overall["primaryInternalScore"] < max(available_scores) - 0.000002:
        raise PlayerQualityError("Overall primary is not the highest available component")
    if abs(overall["internalScore"] - (overall["primaryInternalScore"] + overall["secondaryBonus"])) > 0.000002:
        raise PlayerQualityError("Overall score does not reconcile after publication rounding")
    both_established = (
        profile["batting"]["evidenceState"] == "ESTABLISHED"
        and profile["bowling"]["evidenceState"] == "ESTABLISHED"
    )
    if not both_established and overall["secondaryBonus"] != 0:
        raise PlayerQualityError("Secondary bonus requires two ESTABLISHED components")
    if overall["secondaryBonus"] < 0 or overall["secondaryBonus"] > SECONDARY_BONUS_CAP:
        raise PlayerQualityError("Secondary bonus is outside its frozen bounds")
    decision = overall["tierDecision"]
    if decision["limitedDFloorApplied"] != (
        decision["rawTier"] == "D"
        and profile["batting"]["evidenceState"] != "ESTABLISHED"
        and profile["bowling"]["evidenceState"] != "ESTABLISHED"
    ):
        raise PlayerQualityError("LIMITED D-floor invariant failed")
    if decision["qualityTier"] != ("C" if decision["limitedDFloorApplied"] else decision["rawTier"]):
        raise PlayerQualityError("Published quality tier does not match the tier decision")
    if decision["establishedEvidenceSupportsD"] != (
        decision["rawTier"] == "D"
        and (
            profile["batting"]["evidenceState"] == "ESTABLISHED"
            or profile["bowling"]["evidenceState"] == "ESTABLISHED"
        )
    ):
        raise PlayerQualityError("ESTABLISHED D-support diagnostic is invalid")


def build_player_quality_files(
    *,
    analytical_dir: Path = Path("data/analytical/cricsheet-ipl/v1"),
    eligibility_dir: Path = Path("data/processed/era-draft/v1"),
) -> tuple[dict[str, bytes], dict[str, Any]]:
    stage4_manifest, player_rows, team_rows, environment_rows = _load_stage4(analytical_dir)
    eligibility_manifest, eligibility_rows = _load_eligibility(eligibility_dir)
    if eligibility_manifest["stage4AnalyticalManifestHash"] != stage4_manifest["analyticalManifestHash"]:
        raise PlayerQualityError("G2 eligibility provenance differs from Stage 4")
    _assert_unique(eligibility_rows, "playerTeamSeasonId", "eligibility profile ID")
    eligible_ids = {
        row["playerTeamSeasonId"]
        for row in eligibility_rows
        if row["eligibilityStatus"] == "ELIGIBLE"
    }
    profiles, consumers, calibration = calculate_quality_dataset(
        player_rows=player_rows,
        team_rows=team_rows,
        environment_rows=environment_rows,
        eligible_ids=eligible_ids,
    )
    schemas = build_quality_schemas()
    for profile in profiles:
        _validate_profile_invariants(profile)
    try:
        for index, profile in enumerate(profiles):
            validate_instance(profile, schemas["player_team_season_quality.schema.json"], f"quality[{index}]")
        for index, consumer in enumerate(consumers):
            validate_instance(consumer, schemas["player_quality_consumer.schema.json"], f"consumer[{index}]")
    except SchemaValidationError as error:
        raise PlayerQualityError(f"Stage 6 row schema failure: {error}") from error

    model = {
        "schemaVersion": MODEL_SCHEMA_VERSION,
        "qualityModelVersion": QUALITY_MODEL_VERSION,
        "trackingIssue": ISSUE_URL,
        "inputPolicy": {
            "teamOpportunityDenominator": "FULL_TEAM_NORMAL_INNINGS",
            "seasonEnvironmentCohort": "all_normal",
            "calibrationPopulation": "G2_ESTABLISHED_PER_COMPONENT",
            "calibrationMethod": "MEDIAN_MAD_TIMES_1_4826",
        },
        "batting": {
            "modelId": "B50-M",
            "productionFormula": (
                "(runs / fullTeamBattingInnings) / allNormalBatterRunsPerInnings"
            ),
            "scoringFormula": (
                "ln(((runs + 90 * allNormalRunRatePerBall) / (balls + 90)) / "
                "allNormalRunRatePerBall)"
            ),
            "survivalFormula": (
                "ln(((runs + 4 * allNormalBattingAverage) / (dismissals + 4)) / "
                "allNormalBattingAverage)"
            ),
            "internalScoreFormula": (
                "0.50 * zProduction + 0.275 * zScoring + 0.225 * zSurvival"
            ),
            "weights": BAT_WEIGHTS,
            "scoringPriorBalls": BAT_SCORING_PRIOR_BALLS,
            "survivalPriorDismissals": BAT_SURVIVAL_PRIOR_DISMISSALS,
            "establishedMinimumBalls": BAT_SCORING_PRIOR_BALLS,
            "establishedMinimumDismissals": BAT_SURVIVAL_PRIOR_DISMISSALS,
            "calibration": calibration["batting"],
        },
        "bowling": {
            "modelId": "Q50-S",
            "productionFormula": (
                "(creditedWickets / fullTeamBowlingInnings) / "
                "allNormalCreditedWicketsPerInnings"
            ),
            "economyFormula": (
                "ln(allNormalEconomyPerSixBalls / (6 * (runsConceded + 108 * "
                "allNormalEconomyPerSixBalls / 6) / (legalBalls + 108)))"
            ),
            "wicketRateFormula": (
                "ln(((creditedWickets + 108 * allNormalWicketRatePerBall) / "
                "(legalBalls + 108)) / allNormalWicketRatePerBall)"
            ),
            "internalScoreFormula": (
                "0.50 * zProduction + 0.275 * zEconomy + 0.225 * zWicketRate"
            ),
            "weights": BOWL_WEIGHTS,
            "priorBalls": BOWL_PRIOR_BALLS,
            "establishedMinimumLegalBalls": BOWL_PRIOR_BALLS,
            "wicketDefinition": "CREDITED_BOWLER_WICKETS_ONLY",
            "calibration": calibration["bowling"],
        },
        "ratingMapping": {
            "formula": "60 + 40 * tanh(internalScore / 1.8)",
            "internalScorePublishedDecimalPlaces": 6,
            "ratingPublishedDecimalPlaces": 1,
            "tierDecisionInput": "UNROUNDED_INTERNAL_SCORE",
        },
        "evidencePolicy": {
            "battingNone": "innings == 0",
            "battingLimited": "innings > 0 AND (balls < 90 OR dismissals < 4)",
            "battingEstablished": "balls >= 90 AND dismissals >= 4",
            "bowlingNone": "deliveryRecords == 0",
            "bowlingLimited": "deliveryRecords > 0 AND legalBalls < 108",
            "bowlingEstablished": "legalBalls >= 108",
            "noneComponentOutput": "NULL_INTERNAL_SCORE_AND_RATING",
        },
        "overall": {
            "primarySelection": "HIGHEST_AVAILABLE_COMPONENT",
            "secondaryBonusEligibility": "BOTH_COMPONENTS_ESTABLISHED",
            "secondaryBonusFormula": "min(0.20, 0.20 * max(0, min(B, Q)))",
            "secondaryBonusCap": SECONDARY_BONUS_CAP,
        },
        "tiers": {
            "thresholds": TIER_THRESHOLDS,
            "limitedDFloor": "D_REQUIRES_ANY_ESTABLISHED_COMPONENT",
            "limitedUpperTierCeiling": None,
        },
        "forbiddenInputs": [
            "bowlingFamily", "country", "derivedRole", "isOverseas",
            "positionFit", "wicketkeeperStatus",
        ],
    }
    try:
        validate_instance(model, schemas["quality_model.schema.json"], "qualityModel")
    except SchemaValidationError as error:
        raise PlayerQualityError(f"Stage 6 model schema failure: {error}") from error

    limited_upper = []
    limited_floor = []
    for profile in profiles:
        overall = profile["overall"]
        diagnostic = {
            "reviewId": "quality:" + profile["playerTeamSeasonId"],
            "reviewStatus": "DIAGNOSTIC_ONLY",
            "playerTeamSeasonId": profile["playerTeamSeasonId"],
            "primaryComponent": overall["primaryComponent"],
            "primaryEvidenceState": "LIMITED",
            "overallInternalScore": overall["internalScore"],
            "overallRating": overall["overallRating"],
            "qualityTier": overall["tierDecision"]["qualityTier"],
            "reason": "LIMITED_D_FLOOR" if overall["tierDecision"]["limitedDFloorApplied"] else "LIMITED_UPPER_TIER",
        }
        if overall["evidenceState"] == "LIMITED" and overall["tierDecision"]["qualityTier"] in {"S", "A"}:
            limited_upper.append(diagnostic)
        if overall["tierDecision"]["limitedDFloorApplied"]:
            limited_floor.append(diagnostic)
    review_queue = {
        "schemaVersion": QUEUE_SCHEMA_VERSION,
        "qualityModelVersion": QUALITY_MODEL_VERSION,
        "scope": "G2_PLAYER_QUALITY",
        "summary": {
            "blockingCases": 0,
            "limitedUpperTierCases": len(limited_upper),
            "limitedDFloorCases": len(limited_floor),
        },
        "blockingItems": [],
        "limitedUpperTierItems": limited_upper,
        "limitedDFloorItems": limited_floor,
        "completionBoundary": (
            "Stage 6 quality ratings and tiers are complete for the frozen G2 universe. "
            "LIMITED upper tiers and D floors are diagnostic policy outcomes, not manual adjustments."
        ),
    }
    try:
        validate_instance(review_queue, schemas["review_queue.schema.json"], "reviewQueue")
    except SchemaValidationError as error:
        raise PlayerQualityError(f"Stage 6 review schema failure: {error}") from error

    files: dict[str, bytes] = {
        "player_team_season_quality.jsonl": _jsonl_bytes(profiles),
        "player_quality_consumer.jsonl": _jsonl_bytes(consumers),
        "quality_model.json": pretty_json_bytes(model),
        "review_queue.json": pretty_json_bytes(review_queue),
    }
    for name, schema in schemas.items():
        files[f"schemas/{name}"] = pretty_json_bytes(schema)
    artifact_entries = [
        _artifact_entry("player_team_season_quality.jsonl", files["player_team_season_quality.jsonl"], PROFILE_SCHEMA_VERSION, len(profiles)),
        _artifact_entry("player_quality_consumer.jsonl", files["player_quality_consumer.jsonl"], CONSUMER_SCHEMA_VERSION, len(consumers)),
        _artifact_entry("quality_model.json", files["quality_model.json"], MODEL_SCHEMA_VERSION, None),
        _artifact_entry("review_queue.json", files["review_queue.json"], QUEUE_SCHEMA_VERSION, len(limited_upper) + len(limited_floor)),
    ]
    schema_entries = [
        _artifact_entry(path, content, "json-schema/2020-12", None)
        for path, content in sorted(files.items()) if path.startswith("schemas/")
    ]
    stage4_entries = {entry["path"]: entry for entry in stage4_manifest["artifacts"]}
    eligibility_entry = next(
        entry for entry in eligibility_manifest["artifacts"]
        if entry["path"] == "eligibility.jsonl"
    )
    rating_inputs = [
        {"source": "STAGE_4_ANALYTICAL", **{
            key: stage4_entries[path][key]
            for key in ("path", "sha256", "sizeBytes", "rows", "schemaVersion")
        }}
        for path in (
            "player_team_seasons.jsonl",
            "team_seasons.jsonl",
            "season_environments.jsonl",
        )
    ] + [{"source": "G2_ELIGIBILITY", **{
        key: eligibility_entry[key]
        for key in ("path", "sha256", "sizeBytes", "rows", "schemaVersion")
    }}]
    manifest = {
        "schemaVersion": MANIFEST_SCHEMA_VERSION,
        "qualityModelVersion": QUALITY_MODEL_VERSION,
        "trackingIssue": ISSUE_URL,
        "stage4DatasetVersion": stage4_manifest["datasetVersion"],
        "stage4AnalyticalManifestHash": stage4_manifest["analyticalManifestHash"],
        "eligibilityVersion": eligibility_manifest["eligibilityVersion"],
        "eligibilityManifestHash": eligibility_manifest["eligibilityManifestHash"],
        "ratingInputs": rating_inputs,
        "artifacts": artifact_entries,
        "schemaFiles": schema_entries,
        "qualityDataAggregateHash": _aggregate_hash(files),
    }
    manifest["qualityManifestHash"] = _sha256(canonical_json_bytes(manifest))
    try:
        validate_instance(manifest, schemas["quality_manifest.schema.json"], "qualityManifest")
    except SchemaValidationError as error:
        raise PlayerQualityError(f"Stage 6 manifest schema failure: {error}") from error
    files["quality_manifest.json"] = pretty_json_bytes(manifest)

    batting_counts = Counter(profile["batting"]["evidenceState"] for profile in profiles)
    bowling_counts = Counter(profile["bowling"]["evidenceState"] for profile in profiles)
    primary_counts = Counter(profile["overall"]["primaryComponent"] for profile in profiles)
    tier_counts = Counter(profile["overall"]["tierDecision"]["qualityTier"] for profile in profiles)
    limited_primary_tiers = Counter(
        profile["overall"]["tierDecision"]["qualityTier"]
        for profile in profiles if profile["overall"]["evidenceState"] == "LIMITED"
    )
    bonuses = [profile["overall"]["secondaryBonus"] for profile in profiles if profile["overall"]["secondaryBonus"] > 0]
    actual = {
        "g2Profiles": len(profiles),
        "g2Players": len({profile["playerId"] for profile in profiles}),
        "battingNone": batting_counts["NONE"],
        "battingLimited": batting_counts["LIMITED"],
        "battingEstablished": batting_counts["ESTABLISHED"],
        "bowlingNone": bowling_counts["NONE"],
        "bowlingLimited": bowling_counts["LIMITED"],
        "bowlingEstablished": bowling_counts["ESTABLISHED"],
        "battingPrimary": primary_counts["BATTING"],
        "bowlingPrimary": primary_counts["BOWLING"],
        "secondaryBonusRecipients": len(bonuses),
        "limitedUpperTierCases": len(limited_upper),
        "limitedDFloorCases": len(limited_floor),
        "blockingReviewCases": 0,
    }
    comparisons = [
        {"metric": key, "expected": expected, "actual": actual[key], "matches": actual[key] == expected}
        for key, expected in EXPECTED_COUNTS.items()
    ] + [
        {"metric": f"tier{tier}", "expected": expected, "actual": tier_counts[tier], "matches": tier_counts[tier] == expected}
        for tier, expected in EXPECTED_TIER_COUNTS.items()
    ]
    if any(not row["matches"] for row in comparisons):
        raise PlayerQualityError(f"Stage 6 frozen baseline drift: {comparisons}")
    report = {
        "schemaVersion": VALIDATION_SCHEMA_VERSION,
        "qualityModelVersion": QUALITY_MODEL_VERSION,
        "qualityManifestHash": manifest["qualityManifestHash"],
        "status": "passed",
        "baselineComparisons": comparisons,
        "counts": actual,
        "battingEvidenceCounts": {key: batting_counts[key] for key in EVIDENCE_STATES},
        "bowlingEvidenceCounts": {key: bowling_counts[key] for key in EVIDENCE_STATES},
        "componentDistributions": {
            "B": score_distribution([profile["batting"]["internalScore"] for profile in profiles if profile["batting"]["internalScore"] is not None]),
            "Q": score_distribution([profile["bowling"]["internalScore"] for profile in profiles if profile["bowling"]["internalScore"] is not None]),
        },
        "overallPrimaryCounts": {key: primary_counts[key] for key in COMPONENTS},
        "secondaryBonus": {
            "eligibleProfiles": sum(
                profile["batting"]["evidenceState"] == "ESTABLISHED"
                and profile["bowling"]["evidenceState"] == "ESTABLISHED"
                for profile in profiles
            ),
            "recipientProfiles": len(bonuses),
            "medianAmongRecipients": _published(statistics.median(bonuses)) if bonuses else 0.0,
            "p90AmongRecipients": _published(_percentile(bonuses, 90)) if bonuses else 0.0,
            "maximum": max(bonuses, default=0.0),
        },
        "qualityTierCounts": {key: tier_counts[key] for key in TIERS},
        "limitedPrimaryTierCounts": {key: limited_primary_tiers[key] for key in TIERS},
        "errors": [],
    }
    try:
        validate_instance(report, schemas["validation_report.schema.json"], "validationReport")
    except SchemaValidationError as error:
        raise PlayerQualityError(f"Stage 6 validation-report schema failure: {error}") from error
    files["validation_report.json"] = pretty_json_bytes(report)
    summary = [
        "# Era Draft Player Quality v1", "",
        f"Quality manifest SHA-256: `{manifest['qualityManifestHash']}`", "",
        "## Coverage", "",
        f"- G2 player-team-season profiles: {actual['g2Profiles']:,}",
        f"- G2 canonical players: {actual['g2Players']:,}", "",
        "## Evidence", "",
        f"- Batting: NONE {batting_counts['NONE']:,}, LIMITED {batting_counts['LIMITED']:,}, ESTABLISHED {batting_counts['ESTABLISHED']:,}",
        f"- Bowling: NONE {bowling_counts['NONE']:,}, LIMITED {bowling_counts['LIMITED']:,}, ESTABLISHED {bowling_counts['ESTABLISHED']:,}", "",
        "## Overall quality", "",
        f"- Batting-primary profiles: {primary_counts['BATTING']:,}",
        f"- Bowling-primary profiles: {primary_counts['BOWLING']:,}",
        f"- Secondary-bonus recipients: {len(bonuses):,}",
        "- Quality tiers: " + ", ".join(f"{tier} {tier_counts[tier]:,}" for tier in TIERS), "",
        "## Sparse evidence", "",
        f"- LIMITED S/A diagnostic cases: {len(limited_upper):,}",
        f"- LIMITED-only D floors: {len(limited_floor):,}",
        "- Blocking review cases: 0", "",
        "## Boundary", "",
        "- Ratings use Stage 4 analytical facts and the frozen G2 eligibility universe only.",
        "- Stage 5 roles/fit, wicketkeeper metadata, bowling family, country/overseas metadata and Classic 2016 are not rating inputs.",
        "- The Stage 6 consumer is not wired into Classic or the Era Draft runtime.", "",
    ]
    files["SUMMARY.md"] = "\n".join(summary).encode("utf-8")
    return files, report


def write_artifact_tree(output_dir: Path, files: dict[str, bytes]) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    expected = set(files)
    existing = {
        path.relative_to(output_dir).as_posix()
        for path in output_dir.rglob("*") if path.is_file()
    }
    unexpected = existing - expected
    if unexpected:
        raise PlayerQualityError(f"Unexpected existing Stage 6 artifacts: {sorted(unexpected)}")
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
    "PlayerQualityError",
    "batting_evidence",
    "bowling_evidence",
    "build_player_quality_files",
    "build_quality_schemas",
    "calculate_batting_primitives",
    "calculate_bowling_primitives",
    "calculate_quality_dataset",
    "rating_from_internal",
    "raw_quality_tier",
    "robust_context",
    "score_distribution",
    "season_baseline",
    "secondary_bonus",
    "write_artifact_tree",
]
