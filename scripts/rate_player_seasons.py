from __future__ import annotations

import argparse
import json
import math
import statistics
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any


RATING_MIN = 30.0
RATING_MAX = 83.0
RATING_SPAN = RATING_MAX - RATING_MIN
SOFT_CAP_START_RAW_SCORE = 0.95
SOFT_CAP_SHARPNESS = 0.45

BAT_AVG_PRIOR_DISMISSALS = 4.0
BAT_SR_PRIOR_BALLS = 90.0
BOWL_PRIOR_BALLS = 72.0

BAT_PRODUCTION_WEIGHT = 0.58
BAT_EFFICIENCY_WEIGHT = 0.42
BAT_RUNS_PRODUCTION_WEIGHT = 0.82
BAT_INNINGS_PRODUCTION_WEIGHT = 0.18
BAT_AVERAGE_EFFICIENCY_WEIGHT = 0.45
BAT_STRIKE_RATE_EFFICIENCY_WEIGHT = 0.55

BOWL_PRODUCTION_WEIGHT = 0.52
BOWL_EFFICIENCY_WEIGHT = 0.48
BOWL_WICKET_VOLUME_WEIGHT = 0.72
BOWL_WORKLOAD_WEIGHT = 0.28
BOWL_WICKET_EFFICIENCY_WEIGHT = 0.52
BOWL_ECONOMY_EFFICIENCY_WEIGHT = 0.48

RUNS_SCORE_POWER = 0.62
INNINGS_SCORE_POWER = 0.45
WICKET_VOLUME_POWER = 0.62
BOWLING_WORKLOAD_POWER = 0.50

AVERAGE_SCORE_OFFSET = 0.55
AVERAGE_SCORE_SPAN = 1.35
STRIKE_RATE_SCORE_OFFSET = 0.68
STRIKE_RATE_SCORE_SPAN = 0.78
WICKET_EFFICIENCY_OFFSET = 0.55
WICKET_EFFICIENCY_SPAN = 1.05
ECONOMY_EFFICIENCY_OFFSET = 0.72
ECONOMY_EFFICIENCY_SPAN = 0.62

WICKET_VOLUME_TARGET = 18.0
BOWLING_WORKLOAD_TARGET_BALLS = 300.0
BOWLER_BATTING_BONUS_BASELINE = 45.0
BOWLER_BATTING_BONUS_SPAN = 25.0
BOWLER_BATTING_BONUS_MAX = 4.0
BATTER_ALL_ROUNDER_BOWLING_RAW_BONUS_CAP = 0.12
BOWLING_ALL_ROUNDER_BATTING_RAW_BONUS_CAP = 0.12
BOWLER_BATTING_RAW_BONUS_CAP = 0.07
BOWLING_SECONDARY_FULL_RELIABILITY_BALLS = 180.0
BOWLING_SECONDARY_FULL_RELIABILITY_WICKETS = 8.0
BATTING_SECONDARY_FULL_RELIABILITY_BALLS = 120.0
BATTING_SECONDARY_FULL_RELIABILITY_INNINGS = 10.0
BATTING_SECONDARY_FULL_RELIABILITY_RUNS = 180.0

MEANINGFUL_BOWLING_MIN_BALLS = 60
MEANINGFUL_BOWLING_MIN_WICKETS = 3
MEANINGFUL_BATTING_MIN_BALLS = 20
MEANINGFUL_BATTING_MIN_RUNS = 20
MEANINGFUL_BATTING_MIN_INNINGS = 3

HIGH_BATTING_CONFIDENCE_MIN_INNINGS = 10
HIGH_BATTING_CONFIDENCE_MIN_BALLS = 120
MEDIUM_BATTING_CONFIDENCE_MIN_INNINGS = 4
MEDIUM_BATTING_CONFIDENCE_MIN_BALLS = 40
HIGH_BOWLING_CONFIDENCE_MIN_BALLS = 180
MEDIUM_BOWLING_CONFIDENCE_MIN_BALLS = 60

TIER_THRESHOLDS = {
    "S": 72.0,
    "A": 64.0,
    "B": 56.0,
    "C": 47.0,
}

ROLE_WEIGHTS = {
    "batter": {"batting": 1.0, "bowling": 0.0},
    "wicketkeeper_batter": {"batting": 1.0, "bowling": 0.0},
    "batting_all_rounder": {"batting": 0.70, "bowling": 0.30},
    "bowling_all_rounder": {"batting": 0.35, "bowling": 0.65},
    "bowler": {"batting": 0.0, "bowling": 1.0},
}

OPPORTUNITY_GROUPS = {
    "top_order": {"groups": ("opener", "3"), "runsTarget": 420.0, "inningsTarget": 13.0},
    "middle_order": {"groups": ("4", "5"), "runsTarget": 320.0, "inningsTarget": 11.0},
    "finisher": {"groups": ("6", "7"), "runsTarget": 210.0, "inningsTarget": 9.0},
    "lower_order": {"groups": ("8", "9", "10", "11"), "runsTarget": 90.0, "inningsTarget": 5.0},
}
NEUTRAL_OPPORTUNITY = {"runsTarget": 260.0, "inningsTarget": 9.0}
POSITION_EVIDENCE_WEIGHTS = [
    {"minInnings": 8, "observedWeight": 1.0, "label": "high"},
    {"minInnings": 4, "observedWeight": 0.75, "label": "medium"},
    {"minInnings": 1, "observedWeight": 0.40, "label": "low"},
    {"minInnings": 0, "observedWeight": 0.0, "label": "none"},
]

SANITY_REVIEW_PLAYERS = [
    "V Kohli",
    "DA Warner",
    "AB de Villiers",
    "B Kumar",
    "YS Chahal",
    "SR Watson",
    "RA Jadeja",
    "JJ Bumrah",
    "MS Dhoni",
]


@dataclass(frozen=True)
class Baselines:
    league_batting_average: float
    league_strike_rate: float
    league_economy: float
    league_bowling_strike_rate: float
    total_runs: int
    total_dismissals: int
    total_balls_faced: int
    total_runs_conceded: int
    total_legal_balls_bowled: int
    total_wickets: int


def clamp(value: float, lower: float = 0.0, upper: float = 1.0) -> float:
    return max(lower, min(upper, value))


def rounded(value: float | None, digits: int = 4) -> float | None:
    if value is None:
        return None
    return round(value, digits)


def previous_clamped_rating_from_raw(raw_score: float) -> tuple[float, float]:
    clamped = clamp(raw_score)
    return round(RATING_MIN + RATING_SPAN * clamped, 1), clamped


def soft_capped_raw_score(raw_score: float) -> float:
    if raw_score <= SOFT_CAP_START_RAW_SCORE:
        return raw_score
    remaining = 1 - SOFT_CAP_START_RAW_SCORE
    return 1 - remaining * math.exp(
        -SOFT_CAP_SHARPNESS * (raw_score - SOFT_CAP_START_RAW_SCORE) / remaining
    )


def rating_from_raw(raw_score: float) -> tuple[float, dict[str, Any]]:
    previous_rating, previous_clamped = previous_clamped_rating_from_raw(raw_score)
    converted = clamp(soft_capped_raw_score(raw_score))
    return round(RATING_MIN + RATING_SPAN * converted, 1), {
        "unclampedRawScore": rounded(raw_score),
        "softCappedRawScore": rounded(converted),
        "previousClampedRawScore": rounded(previous_clamped),
        "previousClampedRating": previous_rating,
        "softCapStartRawScore": SOFT_CAP_START_RAW_SCORE,
        "softCapSharpness": SOFT_CAP_SHARPNESS,
        "clippedLow": raw_score < 0.0,
        "abovePreviousHardCap": raw_score > 1.0,
        "softCapApplied": raw_score > SOFT_CAP_START_RAW_SCORE,
        "saturatedAtTop": converted >= 1.0,
        "saturatedAtBottom": converted <= 0.0,
    }


def load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text())


def write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, indent=2) + "\n")


def calculate_baselines(players: list[dict[str, Any]]) -> Baselines:
    total_runs = sum(int(player["runs"]) for player in players)
    total_dismissals = sum(int(player["dismissals"]) for player in players)
    total_balls_faced = sum(int(player["ballsFaced"]) for player in players)
    total_runs_conceded = sum(int(player["runsConceded"]) for player in players)
    total_legal_balls_bowled = sum(int(player["legalBallsBowled"]) for player in players)
    total_wickets = sum(int(player["wickets"]) for player in players)
    return Baselines(
        league_batting_average=total_runs / total_dismissals,
        league_strike_rate=total_runs / total_balls_faced * 100,
        league_economy=total_runs_conceded / total_legal_balls_bowled * 6,
        league_bowling_strike_rate=total_legal_balls_bowled / total_wickets,
        total_runs=total_runs,
        total_dismissals=total_dismissals,
        total_balls_faced=total_balls_faced,
        total_runs_conceded=total_runs_conceded,
        total_legal_balls_bowled=total_legal_balls_bowled,
        total_wickets=total_wickets,
    )


def observed_position_mix(player: dict[str, Any]) -> dict[str, float]:
    counts = player.get("battingPositionGroupCounts", {})
    total = sum(int(counts.get(group, 0)) for group in counts)
    if total <= 0:
        return {}
    mix = {}
    for name, config in OPPORTUNITY_GROUPS.items():
        count = sum(int(counts.get(group, 0)) for group in config["groups"])
        if count:
            mix[name] = count / total
    return mix


def position_evidence_weight(innings_batted: int) -> dict[str, Any]:
    for item in POSITION_EVIDENCE_WEIGHTS:
        if innings_batted >= item["minInnings"]:
            return item
    return POSITION_EVIDENCE_WEIGHTS[-1]


def batting_opportunity(player: dict[str, Any]) -> dict[str, Any]:
    innings_batted = int(player["inningsBatted"])
    observed_mix = observed_position_mix(player)
    evidence = position_evidence_weight(innings_batted)
    observed_weight = float(evidence["observedWeight"])
    if not observed_mix:
        observed_weight = 0.0

    observed_runs_target = sum(OPPORTUNITY_GROUPS[group]["runsTarget"] * share for group, share in observed_mix.items())
    observed_innings_target = sum(
        OPPORTUNITY_GROUPS[group]["inningsTarget"] * share for group, share in observed_mix.items()
    )
    runs_target = observed_weight * observed_runs_target + (1 - observed_weight) * NEUTRAL_OPPORTUNITY["runsTarget"]
    innings_target = (
        observed_weight * observed_innings_target + (1 - observed_weight) * NEUTRAL_OPPORTUNITY["inningsTarget"]
    )
    return {
        "observedMix": {group: rounded(share) for group, share in observed_mix.items()},
        "observedWeight": observed_weight,
        "neutralWeight": 1 - observed_weight,
        "evidenceLabel": evidence["label"],
        "runsTarget": rounded(runs_target),
        "inningsTarget": rounded(innings_target),
    }


def batting_component(player: dict[str, Any], baselines: Baselines) -> dict[str, Any] | None:
    if int(player["inningsBatted"]) == 0 and int(player["ballsFaced"]) == 0:
        return None

    runs = float(player["runs"])
    innings = float(player["inningsBatted"])
    balls = float(player["ballsFaced"])
    dismissals = float(player["dismissals"])
    opportunity = batting_opportunity(player)

    runs_score_raw = (runs / opportunity["runsTarget"]) ** RUNS_SCORE_POWER if opportunity["runsTarget"] else 0.0
    innings_score_raw = (
        (innings / opportunity["inningsTarget"]) ** INNINGS_SCORE_POWER if opportunity["inningsTarget"] else 0.0
    )
    production_raw = BAT_RUNS_PRODUCTION_WEIGHT * runs_score_raw + BAT_INNINGS_PRODUCTION_WEIGHT * innings_score_raw

    shrunk_average = (runs + baselines.league_batting_average * BAT_AVG_PRIOR_DISMISSALS) / (
        dismissals + BAT_AVG_PRIOR_DISMISSALS
    )
    average_score_raw = (shrunk_average / baselines.league_batting_average - AVERAGE_SCORE_OFFSET) / AVERAGE_SCORE_SPAN
    shrunk_strike_rate = (runs + baselines.league_strike_rate * BAT_SR_PRIOR_BALLS / 100) * 100 / (
        balls + BAT_SR_PRIOR_BALLS
    )
    strike_rate_score_raw = (
        shrunk_strike_rate / baselines.league_strike_rate - STRIKE_RATE_SCORE_OFFSET
    ) / STRIKE_RATE_SCORE_SPAN
    efficiency_raw = (
        BAT_AVERAGE_EFFICIENCY_WEIGHT * average_score_raw
        + BAT_STRIKE_RATE_EFFICIENCY_WEIGHT * strike_rate_score_raw
    )

    final_raw = BAT_PRODUCTION_WEIGHT * production_raw + BAT_EFFICIENCY_WEIGHT * efficiency_raw
    rating, flags = rating_from_raw(final_raw)
    return {
        "rating": rating,
        "opportunity": opportunity,
        "metrics": {
            "runsScoreRaw": rounded(runs_score_raw),
            "inningsScoreRaw": rounded(innings_score_raw),
            "productionRaw": rounded(production_raw),
            "shrunkAverage": rounded(shrunk_average),
            "averageScoreRaw": rounded(average_score_raw),
            "shrunkStrikeRate": rounded(shrunk_strike_rate),
            "strikeRateScoreRaw": rounded(strike_rate_score_raw),
            "efficiencyRaw": rounded(efficiency_raw),
            "finalRawScore": rounded(final_raw),
        },
        "flags": flags,
    }


def bowling_component(player: dict[str, Any], baselines: Baselines) -> dict[str, Any] | None:
    if int(player["legalBallsBowled"]) == 0:
        return None

    wickets = float(player["wickets"])
    balls = float(player["legalBallsBowled"])
    runs_conceded = float(player["runsConceded"])
    prior_wickets = BOWL_PRIOR_BALLS / baselines.league_bowling_strike_rate
    prior_runs = baselines.league_economy * BOWL_PRIOR_BALLS / 6

    wicket_volume_raw = (wickets / WICKET_VOLUME_TARGET) ** WICKET_VOLUME_POWER if wickets else 0.0
    workload_raw = (balls / BOWLING_WORKLOAD_TARGET_BALLS) ** BOWLING_WORKLOAD_POWER
    production_raw = BOWL_WICKET_VOLUME_WEIGHT * wicket_volume_raw + BOWL_WORKLOAD_WEIGHT * workload_raw

    shrunk_bowling_strike_rate = (balls + BOWL_PRIOR_BALLS) / (wickets + prior_wickets)
    wicket_efficiency_raw = (
        baselines.league_bowling_strike_rate / shrunk_bowling_strike_rate - WICKET_EFFICIENCY_OFFSET
    ) / WICKET_EFFICIENCY_SPAN
    shrunk_economy = (runs_conceded + prior_runs) * 6 / (balls + BOWL_PRIOR_BALLS)
    economy_efficiency_raw = (baselines.league_economy / shrunk_economy - ECONOMY_EFFICIENCY_OFFSET) / (
        ECONOMY_EFFICIENCY_SPAN
    )
    efficiency_raw = (
        BOWL_WICKET_EFFICIENCY_WEIGHT * wicket_efficiency_raw
        + BOWL_ECONOMY_EFFICIENCY_WEIGHT * economy_efficiency_raw
    )

    final_raw = BOWL_PRODUCTION_WEIGHT * production_raw + BOWL_EFFICIENCY_WEIGHT * efficiency_raw
    rating, flags = rating_from_raw(final_raw)
    return {
        "rating": rating,
        "metrics": {
            "wicketVolumeRaw": rounded(wicket_volume_raw),
            "workloadRaw": rounded(workload_raw),
            "productionRaw": rounded(production_raw),
            "priorWickets": rounded(prior_wickets),
            "priorRuns": rounded(prior_runs),
            "shrunkBowlingStrikeRate": rounded(shrunk_bowling_strike_rate),
            "wicketEfficiencyRaw": rounded(wicket_efficiency_raw),
            "shrunkEconomy": rounded(shrunk_economy),
            "economyEfficiencyRaw": rounded(economy_efficiency_raw),
            "efficiencyRaw": rounded(efficiency_raw),
            "finalRawScore": rounded(final_raw),
        },
        "flags": flags,
    }


def has_meaningful_bowling(player: dict[str, Any]) -> bool:
    return (
        int(player["legalBallsBowled"]) >= MEANINGFUL_BOWLING_MIN_BALLS
        or int(player["wickets"]) >= MEANINGFUL_BOWLING_MIN_WICKETS
    )


def has_meaningful_batting(player: dict[str, Any]) -> bool:
    return (
        int(player["ballsFaced"]) >= MEANINGFUL_BATTING_MIN_BALLS
        or int(player["runs"]) >= MEANINGFUL_BATTING_MIN_RUNS
        or int(player["inningsBatted"]) >= MEANINGFUL_BATTING_MIN_INNINGS
    )


def batting_evidence_confidence(player: dict[str, Any]) -> str:
    if (
        int(player["inningsBatted"]) >= HIGH_BATTING_CONFIDENCE_MIN_INNINGS
        and int(player["ballsFaced"]) >= HIGH_BATTING_CONFIDENCE_MIN_BALLS
    ):
        return "high"
    if (
        int(player["inningsBatted"]) >= MEDIUM_BATTING_CONFIDENCE_MIN_INNINGS
        and int(player["ballsFaced"]) >= MEDIUM_BATTING_CONFIDENCE_MIN_BALLS
    ):
        return "medium"
    return "low"


def bowling_evidence_confidence(player: dict[str, Any]) -> str:
    if int(player["legalBallsBowled"]) >= HIGH_BOWLING_CONFIDENCE_MIN_BALLS:
        return "high"
    if int(player["legalBallsBowled"]) >= MEDIUM_BOWLING_CONFIDENCE_MIN_BALLS:
        return "medium"
    return "low"


def overall_confidence(player: dict[str, Any], applied_weights: dict[str, float]) -> str:
    if int(player["matchesPlayed"]) == 2:
        return "low"
    included = []
    if applied_weights.get("batting", 0) > 0:
        included.append(batting_evidence_confidence(player))
    if applied_weights.get("bowling", 0) > 0:
        included.append(bowling_evidence_confidence(player))
    if not included:
        return "low"
    if all(item == "high" for item in included):
        return "high"
    if any(item in {"high", "medium"} for item in included):
        return "medium"
    return "low"


def provisional_tier(base_rating: float) -> str:
    if base_rating >= TIER_THRESHOLDS["S"]:
        return "S"
    if base_rating >= TIER_THRESHOLDS["A"]:
        return "A"
    if base_rating >= TIER_THRESHOLDS["B"]:
        return "B"
    if base_rating >= TIER_THRESHOLDS["C"]:
        return "C"
    return "D"


def draft_tier_coverage_target(franchises_count: int) -> int:
    return math.floor(franchises_count / 2) + 1


def initialize_tiers(player: dict[str, Any]) -> None:
    absolute_tier = provisional_tier(player["baseRating"])
    player["absoluteTier"] = absolute_tier
    player["draftTier"] = absolute_tier
    player["provisionalTier"] = absolute_tier
    player["tierAdjustment"] = None


def apply_draft_tier_coverage(rated: list[dict[str, Any]]) -> dict[str, Any]:
    for player in rated:
        initialize_tiers(player)

    franchises = sorted({player["franchise"] for player in rated})
    target = draft_tier_coverage_target(len(franchises))
    absolute_s_franchises = sorted({player["franchise"] for player in rated if player["absoluteTier"] == "S"})
    draft_s_franchises = set(absolute_s_franchises)
    promoted_players: list[dict[str, Any]] = []

    if len(draft_s_franchises) < target:
        eligible_franchises = set(franchises) - draft_s_franchises
        best_a_by_franchise: dict[str, dict[str, Any]] = {}
        for franchise in sorted(eligible_franchises):
            franchise_candidates = [
                player
                for player in rated
                if player["franchise"] == franchise and player["absoluteTier"] == "A"
            ]
            if franchise_candidates:
                best_a_by_franchise[franchise] = sorted(
                    franchise_candidates,
                    key=lambda player: (-player["baseRating"], player["name"], player["playerId"]),
                )[0]

        candidates = sorted(
            best_a_by_franchise.values(),
            key=lambda player: (-player["baseRating"], player["name"], player["playerId"]),
        )
        for player in candidates:
            if len(draft_s_franchises) >= target:
                break
            player["draftTier"] = "S"
            player["provisionalTier"] = "S"
            player["tierAdjustment"] = "franchise_coverage"
            draft_s_franchises.add(player["franchise"])
            promoted_players.append(player)

    return {
        "franchisesCount": len(franchises),
        "coverageTarget": target,
        "absoluteSFranchises": absolute_s_franchises,
        "draftSFranchises": sorted(draft_s_franchises),
        "promotedPlayers": promoted_players,
        "franchisesRemainingWithoutS": sorted(set(franchises) - draft_s_franchises),
    }


def applied_role_weights(
    player: dict[str, Any],
    batting: dict[str, Any] | None,
    bowling: dict[str, Any] | None,
) -> tuple[dict[str, float], list[dict[str, Any]]]:
    role = player["seasonRole"]
    defaults = ROLE_WEIGHTS[role]
    review_flags: list[dict[str, Any]] = []

    if role == "bowler":
        return {"batting": 0.0, "bowling": 1.0 if bowling else 0.0}, review_flags

    weighted_components: dict[str, float] = {}
    if defaults["batting"] > 0 and batting is not None:
        if role == "bowling_all_rounder" and not has_meaningful_batting(player):
            review_flags.append({"type": "secondary_batting_below_threshold", "defaultWeight": defaults["batting"]})
        else:
            weighted_components["batting"] = defaults["batting"]
    if defaults["bowling"] > 0 and bowling is not None:
        if not has_meaningful_bowling(player):
            review_flags.append({"type": "secondary_bowling_below_threshold", "defaultWeight": defaults["bowling"]})
        else:
            weighted_components["bowling"] = defaults["bowling"]

    total = sum(weighted_components.values())
    if total == 0:
        return {"batting": 0.0, "bowling": 0.0}, review_flags
    return {
        "batting": round(weighted_components.get("batting", 0.0) / total, 4),
        "bowling": round(weighted_components.get("bowling", 0.0) / total, 4),
    }, review_flags


def bowler_batting_bonus(player: dict[str, Any], batting: dict[str, Any] | None) -> dict[str, Any]:
    if batting is None or not has_meaningful_batting(player):
        return {
            "eligible": False,
            "battingRating": batting["rating"] if batting else None,
            "bonus": 0.0,
        }
    raw_bonus = ((batting["rating"] - BOWLER_BATTING_BONUS_BASELINE) / BOWLER_BATTING_BONUS_SPAN) * (
        BOWLER_BATTING_BONUS_MAX
    )
    bonus = max(0.0, min(BOWLER_BATTING_BONUS_MAX, raw_bonus))
    return {
        "eligible": True,
        "battingRating": batting["rating"],
        "baseline": BOWLER_BATTING_BONUS_BASELINE,
        "span": BOWLER_BATTING_BONUS_SPAN,
        "maxBonus": BOWLER_BATTING_BONUS_MAX,
        "rawBonus": rounded(raw_bonus),
        "bonus": round(bonus, 1),
    }


def component_previous_rating(component: dict[str, Any] | None) -> float | None:
    if component is None:
        return None
    return component["flags"]["previousClampedRating"]


def component_raw_score(component: dict[str, Any] | None) -> float | None:
    if component is None:
        return None
    return float(component["metrics"]["finalRawScore"])


def bowling_secondary_reliability(player: dict[str, Any]) -> float:
    return clamp(
        max(
            int(player["legalBallsBowled"]) / BOWLING_SECONDARY_FULL_RELIABILITY_BALLS,
            int(player["wickets"]) / BOWLING_SECONDARY_FULL_RELIABILITY_WICKETS,
        )
    )


def batting_secondary_reliability(player: dict[str, Any]) -> float:
    return clamp(
        max(
            int(player["ballsFaced"]) / BATTING_SECONDARY_FULL_RELIABILITY_BALLS,
            int(player["inningsBatted"]) / BATTING_SECONDARY_FULL_RELIABILITY_INNINGS,
            int(player["runs"]) / BATTING_SECONDARY_FULL_RELIABILITY_RUNS,
        )
    )


def secondary_bonus(
    *,
    secondary_raw_score: float | None,
    typical_raw_score: float,
    evidence_multiplier: float,
    cap: float,
    meaningful_evidence: bool,
    component: str,
) -> dict[str, Any]:
    if secondary_raw_score is None:
        above_typical = None
        uncapped = 0.0
    else:
        above_typical = secondary_raw_score - typical_raw_score
        uncapped = max(0.0, above_typical) * evidence_multiplier if meaningful_evidence else 0.0
    applied = min(cap, uncapped)
    return {
        "component": component,
        "meaningfulEvidence": meaningful_evidence,
        "secondaryRawScore": rounded(secondary_raw_score),
        "typicalRawScoreBaseline": rounded(typical_raw_score),
        "aboveTypicalRawScore": rounded(above_typical),
        "evidenceMultiplier": rounded(evidence_multiplier),
        "uncappedBonus": rounded(uncapped),
        "cap": cap,
        "appliedBonus": rounded(applied),
    }


def previous_bowler_batting_bonus(player: dict[str, Any], batting: dict[str, Any] | None) -> float:
    previous_batting_rating = component_previous_rating(batting)
    if previous_batting_rating is None or not has_meaningful_batting(player):
        return 0.0
    raw_bonus = ((previous_batting_rating - BOWLER_BATTING_BONUS_BASELINE) / BOWLER_BATTING_BONUS_SPAN) * (
        BOWLER_BATTING_BONUS_MAX
    )
    return round(max(0.0, min(BOWLER_BATTING_BONUS_MAX, raw_bonus)), 1)


def source_statistics(player: dict[str, Any]) -> dict[str, Any]:
    return {
        "matchesPlayed": player["matchesPlayed"],
        "inningsBatted": player["inningsBatted"],
        "runs": player["runs"],
        "ballsFaced": player["ballsFaced"],
        "dismissals": player["dismissals"],
        "wickets": player["wickets"],
        "legalBallsBowled": player["legalBallsBowled"],
        "runsConceded": player["runsConceded"],
        "battingPositionGroupCounts": player.get("battingPositionGroupCounts"),
        "seasonRole": player["seasonRole"],
        "bowlingOptionStrength": player.get("bowlingOptionStrength"),
    }


def rate_player(
    player: dict[str, Any],
    baselines: Baselines,
    component_typical_raw_scores: dict[str, float] | None = None,
) -> dict[str, Any]:
    component_typical_raw_scores = component_typical_raw_scores or {"batting": 0.0, "bowling": 0.0}
    batting = batting_component(player, baselines)
    bowling = bowling_component(player, baselines)
    applied_weights, role_review_flags = applied_role_weights(player, batting, bowling)
    batting_raw = component_raw_score(batting)
    bowling_raw = component_raw_score(bowling)

    base_calculation: dict[str, Any]
    if player["seasonRole"] == "bowler":
        bowling_rating = bowling["rating"] if bowling else RATING_MIN
        previous_bowling_rating = component_previous_rating(bowling) or RATING_MIN
        bonus = bowler_batting_bonus(player, batting)
        previous_bonus = previous_bowler_batting_bonus(player, batting)
        base_rating = round(min(RATING_MAX, bowling_rating + bonus["bonus"]), 1)
        previous_base_rating = round(min(RATING_MAX, previous_bowling_rating + previous_bonus), 1)
        base_calculation = {
            "previousActiveMethod": "bowling_plus_capped_batting_bonus",
            "bowlingRating": bowling_rating,
            "battingBonus": bonus,
            "previousClampedBowlingRating": previous_bowling_rating,
            "previousClampedBattingBonus": previous_bonus,
            "previousClampedBaseRating": previous_base_rating,
            "previousActiveBaseRating": base_rating,
            "baseRatingChangeFromPreviousClamp": round(base_rating - previous_base_rating, 1),
        }
    else:
        weighted_values = []
        previous_weighted_values = []
        if batting and applied_weights.get("batting", 0) > 0:
            weighted_values.append({"component": "batting", "weight": applied_weights["batting"], "rating": batting["rating"]})
            previous_weighted_values.append(
                {
                    "component": "batting",
                    "weight": applied_weights["batting"],
                    "rating": component_previous_rating(batting),
                }
            )
        if bowling and applied_weights.get("bowling", 0) > 0:
            weighted_values.append({"component": "bowling", "weight": applied_weights["bowling"], "rating": bowling["rating"]})
            previous_weighted_values.append(
                {
                    "component": "bowling",
                    "weight": applied_weights["bowling"],
                    "rating": component_previous_rating(bowling),
                }
            )
        if weighted_values:
            base_rating = round(sum(item["weight"] * item["rating"] for item in weighted_values), 1)
            previous_base_rating = round(
                sum(item["weight"] * item["rating"] for item in previous_weighted_values if item["rating"] is not None),
                1,
            )
        else:
            base_rating = RATING_MIN
            previous_base_rating = RATING_MIN
        base_calculation = {
            "previousActiveMethod": "weighted_components",
            "weightedValues": weighted_values,
            "previousClampedWeightedValues": previous_weighted_values,
            "previousClampedBaseRating": previous_base_rating,
            "previousActiveBaseRating": base_rating,
            "baseRatingChangeFromPreviousClamp": round(base_rating - previous_base_rating, 1),
        }

    role = player["seasonRole"]
    secondary_bonus_detail = None
    if role in {"batter", "wicketkeeper_batter"}:
        raw_base_score = batting_raw if batting_raw is not None else 0.0
        primary_component = "batting"
    elif role == "batting_all_rounder":
        primary_component = "batting"
        secondary_bonus_detail = secondary_bonus(
            secondary_raw_score=bowling_raw,
            typical_raw_score=component_typical_raw_scores["bowling"],
            evidence_multiplier=bowling_secondary_reliability(player),
            cap=BATTER_ALL_ROUNDER_BOWLING_RAW_BONUS_CAP,
            meaningful_evidence=has_meaningful_bowling(player),
            component="bowling",
        )
        raw_base_score = (batting_raw if batting_raw is not None else 0.0) + secondary_bonus_detail["appliedBonus"]
    elif role == "bowling_all_rounder":
        primary_component = "bowling"
        secondary_bonus_detail = secondary_bonus(
            secondary_raw_score=batting_raw,
            typical_raw_score=component_typical_raw_scores["batting"],
            evidence_multiplier=batting_secondary_reliability(player),
            cap=BOWLING_ALL_ROUNDER_BATTING_RAW_BONUS_CAP,
            meaningful_evidence=has_meaningful_batting(player),
            component="batting",
        )
        raw_base_score = (bowling_raw if bowling_raw is not None else 0.0) + secondary_bonus_detail["appliedBonus"]
    else:
        primary_component = "bowling"
        secondary_bonus_detail = secondary_bonus(
            secondary_raw_score=batting_raw,
            typical_raw_score=component_typical_raw_scores["batting"],
            evidence_multiplier=batting_secondary_reliability(player),
            cap=BOWLER_BATTING_RAW_BONUS_CAP,
            meaningful_evidence=has_meaningful_batting(player),
            component="batting",
        )
        raw_base_score = (bowling_raw if bowling_raw is not None else 0.0) + secondary_bonus_detail["appliedBonus"]
    base_calculation["consolidatedRawBaseScore"] = {
        "method": "primary_component_plus_capped_evidence_adjusted_secondary_bonus",
        "primaryComponent": primary_component,
        "primaryRawScore": rounded(batting_raw if primary_component == "batting" else bowling_raw),
        "secondaryBonus": secondary_bonus_detail,
        "rawBaseScore": rounded(raw_base_score),
    }

    rating_confidence = overall_confidence(player, applied_weights)
    rated = {
        **player,
        "battingRating": batting["rating"] if batting else None,
        "bowlingRating": bowling["rating"] if bowling else None,
        "baseRating": base_rating,
        "previousActiveBaseRating": base_rating,
        "previousClampedBaseRating": base_calculation["previousClampedBaseRating"],
        "provisionalTier": provisional_tier(base_rating),
        "ratingConfidence": rating_confidence,
        "ratingBreakdown": {
            "inputs": source_statistics(player),
            "batting": batting,
            "bowling": bowling,
            "defaultRoleWeights": ROLE_WEIGHTS[player["seasonRole"]],
            "appliedRoleWeights": applied_weights,
            "roleReviewFlags": role_review_flags,
            "baseRatingCalculation": base_calculation,
            "rawBaseScore": rounded(raw_base_score),
            "robustZScore": None,
        },
        "sourceStatistics": source_statistics(player),
    }
    return rated


def distribution(values: list[float]) -> dict[str, Any]:
    if not values:
        return {}
    sorted_values = sorted(values)
    percentiles = {}
    for percentile in (0, 10, 25, 50, 75, 90, 95, 99, 100):
        index = round((len(sorted_values) - 1) * percentile / 100)
        percentiles[str(percentile)] = sorted_values[index]
    ranges = Counter()
    for value in values:
        if value >= 73:
            ranges["73-83"] += 1
        elif value >= 62:
            ranges["62-72"] += 1
        elif value >= 54:
            ranges["54-61"] += 1
        elif value >= 45:
            ranges["45-53"] += 1
        else:
            ranges["30-44"] += 1
    return {
        "count": len(values),
        "min": min(values),
        "max": max(values),
        "mean": round(sum(values) / len(values), 2),
        "percentiles": percentiles,
        "descriptiveRanges": dict(sorted(ranges.items())),
    }


def quantiles(values: list[float], percentiles: tuple[int, ...] = (0, 10, 25, 50, 75, 90, 95, 99, 100)) -> dict[str, float]:
    sorted_values = sorted(values)
    return {
        str(percentile): rounded(sorted_values[round((len(sorted_values) - 1) * percentile / 100)])
        for percentile in percentiles
    }


def population_standard_deviation(values: list[float]) -> float:
    mean = sum(values) / len(values)
    return math.sqrt(sum((value - mean) ** 2 for value in values) / len(values))


def population_skewness(values: list[float]) -> float | None:
    standard_deviation = population_standard_deviation(values)
    if standard_deviation == 0:
        return None
    mean = sum(values) / len(values)
    return sum(((value - mean) / standard_deviation) ** 3 for value in values) / len(values)


def comparison_rating_from_z(standardized_score: float) -> float:
    return round(clamp(56 + 10 * standardized_score, RATING_MIN, RATING_MAX), 1)


def robust_context(raw_scores: list[float]) -> dict[str, float]:
    median = statistics.median(raw_scores)
    mad = statistics.median([abs(value - median) for value in raw_scores])
    robust_scale = mad * 1.4826
    return {"median": median, "medianAbsoluteDeviation": mad, "robustScale": robust_scale}


def robust_rating(raw_score: float, context: dict[str, float]) -> tuple[float, float]:
    robust_scale = context["robustScale"]
    robust_z = (raw_score - context["median"]) / robust_scale if robust_scale else 0.0
    return comparison_rating_from_z(robust_z), robust_z


def component_typical_raw_scores(rated: list[dict[str, Any]]) -> dict[str, float]:
    batting_scores = [
        float(player["ratingBreakdown"]["batting"]["metrics"]["finalRawScore"])
        for player in rated
        if player["ratingBreakdown"]["batting"] is not None
    ]
    bowling_scores = [
        float(player["ratingBreakdown"]["bowling"]["metrics"]["finalRawScore"])
        for player in rated
        if player["ratingBreakdown"]["bowling"] is not None
    ]
    return {
        "batting": statistics.median(batting_scores) if batting_scores else 0.0,
        "bowling": statistics.median(bowling_scores) if bowling_scores else 0.0,
    }


def raw_base_score(player: dict[str, Any]) -> float:
    return float(player["ratingBreakdown"]["rawBaseScore"])


def compact_player(player: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": player["id"],
        "playerId": player["playerId"],
        "name": player["name"],
        "franchise": player["franchise"],
        "season": player["season"],
        "seasonRole": player["seasonRole"],
        "matchesPlayed": player["matchesPlayed"],
        "battingRating": player["battingRating"],
        "bowlingRating": player["bowlingRating"],
        "baseRating": player["baseRating"],
        "absoluteTier": player.get("absoluteTier"),
        "draftTier": player.get("draftTier"),
        "tierAdjustment": player.get("tierAdjustment"),
        "ratingConfidence": player["ratingConfidence"],
        "sourceStatistics": player["sourceStatistics"],
    }


def comparison_entry(player: dict[str, Any], comparison: dict[str, Any]) -> dict[str, Any]:
    return {
        **compact_player(player),
        "rawBaseScore": comparison["rawBaseScore"],
        "ordinaryZScore": comparison["ordinaryZScore"],
        "ordinaryZComparisonRating": comparison["ordinaryZComparisonRating"],
        "robustZScore": comparison["robustZScore"],
        "robustZComparisonRating": comparison["robustZComparisonRating"],
        "currentRank": comparison["currentRank"],
        "ordinaryZRank": comparison["ordinaryZRank"],
        "robustZRank": comparison["robustZRank"],
        "ordinaryZRankChangeFromCurrent": comparison["ordinaryZRankChangeFromCurrent"],
        "robustZRankChangeFromCurrent": comparison["robustZRankChangeFromCurrent"],
    }


def by_role_top(rated: list[dict[str, Any]], limit: int = 15) -> dict[str, list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for player in rated:
        grouped[player["seasonRole"]].append(player)
    return {
        role: [compact_player(player) for player in sorted(players, key=rating_sort_key)[:limit]]
        for role, players in sorted(grouped.items())
    }


def rating_sort_key(player: dict[str, Any]) -> tuple[float, str, str]:
    return (-player["baseRating"], player["name"], player["playerId"])


def tier_counts(players: list[dict[str, Any]], field: str = "draftTier") -> dict[str, int]:
    counts = Counter(player.get(field, player["provisionalTier"]) for player in players)
    return {tier: counts.get(tier, 0) for tier in ("S", "A", "B", "C", "D")}


def tier_counts_by_role(players: list[dict[str, Any]], field: str = "draftTier") -> dict[str, dict[str, int]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for player in players:
        grouped[player["seasonRole"]].append(player)
    return {role: tier_counts(group, field) for role, group in sorted(grouped.items())}


def tier_for_thresholds(base_rating: float, thresholds: dict[str, float]) -> str:
    if base_rating >= thresholds["S"]:
        return "S"
    if base_rating >= thresholds["A"]:
        return "A"
    if base_rating >= thresholds["B"]:
        return "B"
    if base_rating >= thresholds["C"]:
        return "C"
    return "D"


def tier_counts_for_thresholds(players: list[dict[str, Any]], thresholds: dict[str, float]) -> dict[str, int]:
    counts = Counter(tier_for_thresholds(player["baseRating"], thresholds) for player in players)
    return {tier: counts.get(tier, 0) for tier in ("S", "A", "B", "C", "D")}


def tier_counts_by_role_for_thresholds(
    players: list[dict[str, Any]],
    thresholds: dict[str, float],
) -> dict[str, dict[str, int]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for player in players:
        grouped[player["seasonRole"]].append(player)
    return {role: tier_counts_for_thresholds(group, thresholds) for role, group in sorted(grouped.items())}


def players_near_tier_boundaries(rated: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    results = {}
    for tier, threshold in TIER_THRESHOLDS.items():
        results[f"{tier}_boundary_{threshold:g}"] = [
            compact_player(player)
            for player in sorted(rated, key=lambda item: (abs(item["baseRating"] - threshold), item["name"]))
            if abs(player["baseRating"] - threshold) <= 1.0
        ]
    return results


def alternative_tier_counts(rated: list[dict[str, Any]]) -> list[dict[str, Any]]:
    threshold_sets = [
        {"label": "current", "S": 72.0, "A": 64.0, "B": 56.0, "C": 47.0},
        {"label": "s_threshold_73", "S": 73.0, "A": 64.0, "B": 56.0, "C": 47.0},
        {"label": "s_threshold_74", "S": 74.0, "A": 64.0, "B": 56.0, "C": 47.0},
        {"label": "s_threshold_75", "S": 75.0, "A": 64.0, "B": 56.0, "C": 47.0},
        {"label": "stricter_all_boundaries", "S": 74.0, "A": 66.0, "B": 57.0, "C": 48.0},
    ]
    outputs = []
    for thresholds in threshold_sets:
        s_players = [
            compact_player(player)
            for player in sorted(rated, key=rating_sort_key)
            if tier_for_thresholds(player["baseRating"], thresholds) == "S"
        ]
        medium_or_low_confidence_s = [
            player for player in s_players if player["ratingConfidence"] in {"medium", "low"}
        ]
        counts = tier_counts_for_thresholds(rated, thresholds)
        outputs.append(
            {
                "thresholds": thresholds,
                "tierCounts": counts,
                "sAndACombinedCount": counts["S"] + counts["A"],
                "sTierPlayers": s_players,
                "tierCountsByRole": tier_counts_by_role_for_thresholds(rated, thresholds),
                "mediumOrLowConfidenceSPlayers": medium_or_low_confidence_s,
            }
        )
    return outputs


def component_clipping_cases(rated: list[dict[str, Any]]) -> list[dict[str, Any]]:
    cases = []
    for player in rated:
        for component_name in ("batting", "bowling"):
            component = player["ratingBreakdown"].get(component_name)
            if not component:
                continue
            flags = component["flags"]
            if flags["clippedLow"] or flags["abovePreviousHardCap"] or flags["softCapApplied"] or flags["saturatedAtBottom"]:
                cases.append(
                    {
                        **compact_player(player),
                        "component": component_name,
                        "flags": flags,
                        "metrics": component["metrics"],
                    }
                )
    return sorted(cases, key=lambda item: (item["component"], -item["baseRating"], item["name"]))


def applied_weight_deviations(rated: list[dict[str, Any]]) -> list[dict[str, Any]]:
    deviations = []
    for player in rated:
        breakdown = player["ratingBreakdown"]
        if breakdown["appliedRoleWeights"] != breakdown["defaultRoleWeights"]:
            deviations.append(
                {
                    **compact_player(player),
                    "defaultRoleWeights": breakdown["defaultRoleWeights"],
                    "appliedRoleWeights": breakdown["appliedRoleWeights"],
                    "roleReviewFlags": breakdown["roleReviewFlags"],
                }
            )
    return sorted(deviations, key=rating_sort_key)


def role_review_flags(rated: list[dict[str, Any]]) -> list[dict[str, Any]]:
    flags = []
    for player in rated:
        player_flags = player["ratingBreakdown"]["roleReviewFlags"]
        if player_flags:
            flags.append({**compact_player(player), "roleReviewFlags": player_flags})
    return sorted(flags, key=rating_sort_key)


def component_gap_cases(rated: list[dict[str, Any]], limit: int = 25) -> list[dict[str, Any]]:
    cases = []
    for player in rated:
        if player["battingRating"] is None or player["bowlingRating"] is None:
            continue
        cases.append({**compact_player(player), "componentGap": round(abs(player["battingRating"] - player["bowlingRating"]), 1)})
    return sorted(cases, key=lambda item: (-item["componentGap"], item["name"]))[:limit]


def production_rank_gaps(rated: list[dict[str, Any]], limit: int = 20) -> dict[str, list[dict[str, Any]]]:
    rating_rank = {player["id"]: index + 1 for index, player in enumerate(sorted(rated, key=rating_sort_key))}
    run_rank = {
        player["id"]: index + 1
        for index, player in enumerate(sorted(rated, key=lambda item: (-item["runs"], item["name"], item["playerId"])))
    }
    wicket_rank = {
        player["id"]: index + 1
        for index, player in enumerate(sorted(rated, key=lambda item: (-item["wickets"], item["name"], item["playerId"])))
    }

    batter_roles = {"batter", "wicketkeeper_batter"}
    bowler_roles = {"bowler"}
    all_rounder_roles = {"batting_all_rounder", "bowling_all_rounder"}
    outputs: dict[str, list[dict[str, Any]]] = {}
    groups = {
        "batters_run_rank_gap": [player for player in rated if player["seasonRole"] in batter_roles],
        "bowlers_wicket_rank_gap": [player for player in rated if player["seasonRole"] in bowler_roles],
        "all_rounders_run_rank_gap": [player for player in rated if player["seasonRole"] in all_rounder_roles],
        "all_rounders_wicket_rank_gap": [player for player in rated if player["seasonRole"] in all_rounder_roles],
    }
    for name, players in groups.items():
        rank_source = wicket_rank if "wicket" in name else run_rank
        rows = []
        for player in players:
            gap = rank_source[player["id"]] - rating_rank[player["id"]]
            rows.append(
                {
                    **compact_player(player),
                    "ratingRank": rating_rank[player["id"]],
                    "productionRank": rank_source[player["id"]],
                    "productionRankMetric": "wickets" if "wicket" in name else "runs",
                    "rankGap": gap,
                }
            )
        outputs[name] = sorted(rows, key=lambda item: (-abs(item["rankGap"]), item["name"]))[:limit]
    return outputs


def named_sanity_players(rated: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    output = {}
    by_name = {player["name"]: player for player in rated}
    for name in SANITY_REVIEW_PLAYERS:
        if name in by_name:
            output[name] = sanity_breakdown(by_name[name])
    fringe = next((player for player in sorted(rated, key=rating_sort_key) if player["matchesPlayed"] == 2), None)
    if fringe:
        output[f"fringe_two_match_{fringe['name']}"] = sanity_breakdown(fringe)
    return output


def sanity_breakdown(player: dict[str, Any]) -> dict[str, Any]:
    return {
        **compact_player(player),
        "ratingBreakdown": canonical_rating_breakdown(player["ratingBreakdown"]),
    }


def top_end_compression(rated: list[dict[str, Any]]) -> dict[str, Any]:
    names = ["V Kohli", "DA Warner", "AB de Villiers"]
    players = [player for player in rated if player["name"] in names]
    players.sort(key=lambda player: player["baseRating"], reverse=True)
    ratings = [player["baseRating"] for player in players]
    clipping = {
        player["name"]: {
            "baseRating": player["baseRating"],
            "previousClampedBaseRating": player["previousClampedBaseRating"],
            "battingFlags": player["ratingBreakdown"]["batting"]["flags"] if player["ratingBreakdown"]["batting"] else None,
            "battingMetrics": player["ratingBreakdown"]["batting"]["metrics"] if player["ratingBreakdown"]["batting"] else None,
        }
        for player in players
    }
    return {
        "players": [sanity_breakdown(player) for player in players],
        "ratingSpread": round(max(ratings) - min(ratings), 1) if ratings else None,
        "inspection": (
            "Review battingMetrics.finalRawScore and battingFlags. The soft cap preserves ordering above the previous "
            "hard cap; any remaining close grouping should be compared against finalRawScore and component formulas."
        ),
        "clippingSummary": clipping,
    }


def elite_player_separation(rated: list[dict[str, Any]]) -> dict[str, Any]:
    names = ["V Kohli", "DA Warner", "AB de Villiers", "B Kumar", "YS Chahal", "MS Dhoni"]
    by_name = {player["name"]: player for player in rated}
    players = []
    for name in names:
        player = by_name.get(name)
        if not player:
            continue
        batting = player["ratingBreakdown"]["batting"]
        bowling = player["ratingBreakdown"]["bowling"]
        players.append(
            {
                **compact_player(player),
                "battingRawScore": batting["metrics"]["finalRawScore"] if batting else None,
                "battingRatingRawScore": batting["flags"]["softCappedRawScore"] if batting else None,
                "bowlingRawScore": bowling["metrics"]["finalRawScore"] if bowling else None,
                "bowlingRatingRawScore": bowling["flags"]["softCappedRawScore"] if bowling else None,
            }
        )
    return {
        "players": sorted(players, key=lambda item: (-item["baseRating"], item["name"])),
        "inspection": (
            "If players remain close without equal component raw scores, the closeness comes from component formula "
            "inputs, role treatment, and robust standardization rather than draft-tier adjustment."
        ),
    }


def comparison_tier_counts(entries: list[dict[str, Any]], rating_key: str) -> dict[str, int]:
    counts = Counter(provisional_tier(entry[rating_key]) for entry in entries)
    return {tier: counts.get(tier, 0) for tier in ("S", "A", "B", "C", "D")}


def comparison_tier_counts_by_role(entries: list[dict[str, Any]], rating_key: str) -> dict[str, dict[str, int]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for entry in entries:
        grouped[entry["seasonRole"]].append(entry)
    return {role: comparison_tier_counts(group, rating_key) for role, group in sorted(grouped.items())}


def rank_players_by_key(players: list[dict[str, Any]], key: str) -> dict[str, int]:
    return {
        player["id"]: index + 1
        for index, player in enumerate(sorted(players, key=lambda item: (-item[key], item["name"], item["playerId"])))
    }


def comparison_role_summary(entries: list[dict[str, Any]]) -> dict[str, Any]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for entry in entries:
        grouped[entry["seasonRole"]].append(entry)
    output = {}
    for role, role_entries in sorted(grouped.items()):
        output[role] = {
            "count": len(role_entries),
            "rawBaseScore": distribution([entry["rawBaseScore"] for entry in role_entries]),
            "currentRating": distribution([entry["baseRating"] for entry in role_entries]),
            "ordinaryZComparisonRating": distribution([entry["ordinaryZComparisonRating"] for entry in role_entries]),
            "robustZComparisonRating": distribution([entry["robustZComparisonRating"] for entry in role_entries]),
            "tierCounts": {
                "current": comparison_tier_counts(role_entries, "baseRating"),
                "ordinaryZ": comparison_tier_counts(role_entries, "ordinaryZComparisonRating"),
                "robustZ": comparison_tier_counts(role_entries, "robustZComparisonRating"),
            },
        }
    return output


def raw_score_standardization_comparison(rated: list[dict[str, Any]]) -> dict[str, Any]:
    working = [{**player, "rawBaseScore": raw_base_score(player)} for player in rated]
    raw_scores = [player["rawBaseScore"] for player in working]
    mean = sum(raw_scores) / len(raw_scores)
    median = statistics.median(raw_scores)
    standard_deviation = population_standard_deviation(raw_scores)
    median_absolute_deviation = statistics.median([abs(value - median) for value in raw_scores])
    robust_scale = median_absolute_deviation * 1.4826

    for player in working:
        ordinary_z = (player["rawBaseScore"] - mean) / standard_deviation if standard_deviation else 0.0
        robust_z = (player["rawBaseScore"] - median) / robust_scale if robust_scale else 0.0
        player["ordinaryZScore"] = rounded(ordinary_z)
        player["ordinaryZComparisonRating"] = comparison_rating_from_z(ordinary_z)
        player["robustZScore"] = rounded(robust_z)
        player["robustZComparisonRating"] = comparison_rating_from_z(robust_z)

    current_ranks = rank_players_by_key(working, "baseRating")
    ordinary_ranks = rank_players_by_key(working, "ordinaryZComparisonRating")
    robust_ranks = rank_players_by_key(working, "robustZComparisonRating")
    entries = []
    for player in working:
        comparison = {
            "rawBaseScore": rounded(player["rawBaseScore"]),
            "ordinaryZScore": player["ordinaryZScore"],
            "ordinaryZComparisonRating": player["ordinaryZComparisonRating"],
            "robustZScore": player["robustZScore"],
            "robustZComparisonRating": player["robustZComparisonRating"],
            "currentRank": current_ranks[player["id"]],
            "ordinaryZRank": ordinary_ranks[player["id"]],
            "robustZRank": robust_ranks[player["id"]],
            "ordinaryZRankChangeFromCurrent": current_ranks[player["id"]] - ordinary_ranks[player["id"]],
            "robustZRankChangeFromCurrent": current_ranks[player["id"]] - robust_ranks[player["id"]],
        }
        entries.append(comparison_entry(player, comparison))

    by_name = {entry["name"]: entry for entry in entries}
    ordinary_top = sorted(entries, key=lambda item: (-item["ordinaryZComparisonRating"], item["name"], item["playerId"]))
    robust_top = sorted(entries, key=lambda item: (-item["robustZComparisonRating"], item["name"], item["playerId"]))
    current_top = sorted(entries, key=lambda item: (-item["baseRating"], item["name"], item["playerId"]))
    rank_changes = sorted(
        entries,
        key=lambda item: (
            -max(abs(item["ordinaryZRankChangeFromCurrent"]), abs(item["robustZRankChangeFromCurrent"])),
            item["name"],
        ),
    )
    top_tail_distance = (max(raw_scores) - mean) / standard_deviation if standard_deviation else 0.0
    bottom_tail_distance = (mean - min(raw_scores)) / standard_deviation if standard_deviation else 0.0
    mean_median_gap_in_std = abs(mean - median) / standard_deviation if standard_deviation else 0.0
    std_to_robust_scale_ratio = standard_deviation / robust_scale if robust_scale else None
    ordinary_distorted = (
        mean_median_gap_in_std >= 0.15
        or top_tail_distance >= 2.5
        or bottom_tail_distance >= 2.5
        or (std_to_robust_scale_ratio is not None and std_to_robust_scale_ratio >= 1.25)
    )
    robust_more_credible = ordinary_distorted and robust_scale > 0

    return {
        "status": "robust_z_active_ordinary_z_comparison_only",
        "formula": {
            "ordinaryZScore": "(rawBaseScore - meanRawBaseScore) / populationStandardDeviation",
            "robustZScore": "(rawBaseScore - medianRawBaseScore) / (medianAbsoluteDeviation * 1.4826)",
            "comparisonRating": "clamp(56 + 10 * standardizedScore, 30, 83)",
            "rawBaseScore": (
                "For weighted roles, appliedRoleWeights over component finalRawScore. For bowlers, bowling "
                "finalRawScore plus batting bonus converted to raw-score units. This is the active V1-candidate raw score."
            ),
        },
        "rawScoreStatistics": {
            "mean": rounded(mean),
            "median": rounded(median),
            "standardDeviation": rounded(standard_deviation),
            "medianAbsoluteDeviation": rounded(median_absolute_deviation),
            "robustScaleMADTimes1_4826": rounded(robust_scale),
            "quantiles": quantiles(raw_scores),
            "skewness": rounded(population_skewness(raw_scores)),
            "topTailDistanceInStandardDeviations": rounded(top_tail_distance),
            "bottomTailDistanceInStandardDeviations": rounded(bottom_tail_distance),
            "meanMedianGapInStandardDeviations": rounded(mean_median_gap_in_std),
            "standardDeviationToRobustScaleRatio": rounded(std_to_robust_scale_ratio),
        },
        "assessment": {
            "ordinaryZScoresMateriallyDistortedByOutliers": ordinary_distorted,
            "robustStandardizationGivesMoreCredibleSeparation": robust_more_credible,
            "notes": [
                "Ordinary z-scores use the mean and standard deviation, so elite and fringe tails can widen the scale.",
                "Robust z-scores use median and MAD*1.4826, making them less sensitive to tails.",
                "Robust z is active in this V1 candidate; ordinary z is retained for calibration comparison.",
            ],
        },
        "top25": {
            "current": current_top[:25],
            "ordinaryZ": ordinary_top[:25],
            "robustZ": robust_top[:25],
        },
        "rankChangesBetweenMethods": rank_changes[:50],
        "bySeasonRole": comparison_role_summary(entries),
        "tierCountsUnderExistingThresholds": {
            "current": comparison_tier_counts(entries, "baseRating"),
            "ordinaryZ": comparison_tier_counts(entries, "ordinaryZComparisonRating"),
            "robustZ": comparison_tier_counts(entries, "robustZComparisonRating"),
        },
        "tierCountsByRoleUnderExistingThresholds": {
            "current": comparison_tier_counts_by_role(entries, "baseRating"),
            "ordinaryZ": comparison_tier_counts_by_role(entries, "ordinaryZComparisonRating"),
            "robustZ": comparison_tier_counts_by_role(entries, "robustZComparisonRating"),
        },
        "sanityReviewPlayers": {name: by_name[name] for name in SANITY_REVIEW_PLAYERS if name in by_name},
    }


def calibration_history() -> dict[str, Any]:
    return {
        "selectedMethod": "robust_mad_standardization",
        "methodsEvaluated": [
            {
                "method": "linear_hard_clamp",
                "status": "rejected",
                "reason": "Raw scores above 1.0 collapsed to the same 83 rating and erased elite-season separation.",
            },
            {
                "method": "soft_cap_component_mapping",
                "status": "rejected_for_base_rating",
                "reason": "Improved top-end ordering but still anchored base ratings to component-space calibration rather than the season distribution.",
            },
            {
                "method": "ordinary_z_standardization",
                "status": "comparison_only",
                "reason": "Mean and standard deviation are more sensitive to elite and fringe tails in this 147-player distribution.",
            },
            {
                "method": "robust_mad_standardization",
                "status": "selected",
                "reason": "Centers the rating scale on a typical player-season while reducing distortion from tail seasons.",
            },
        ],
    }


def formulas_and_constants(baselines: Baselines) -> dict[str, Any]:
    return {
        "status": "v1_candidate_final_rating_and_tier_model",
        "baselines": {
            "leagueBattingAverage": rounded(baselines.league_batting_average),
            "leagueStrikeRate": rounded(baselines.league_strike_rate),
            "leagueEconomy": rounded(baselines.league_economy),
            "leagueBowlingStrikeRate": rounded(baselines.league_bowling_strike_rate),
            "aggregateTotals": {
                "runs": baselines.total_runs,
                "dismissals": baselines.total_dismissals,
                "ballsFaced": baselines.total_balls_faced,
                "runsConceded": baselines.total_runs_conceded,
                "legalBallsBowled": baselines.total_legal_balls_bowled,
                "wickets": baselines.total_wickets,
            },
        },
        "constants": {
            "ratingMin": RATING_MIN,
            "ratingMax": RATING_MAX,
            "softCapStartRawScore": SOFT_CAP_START_RAW_SCORE,
            "softCapSharpness": SOFT_CAP_SHARPNESS,
            "batAveragePriorDismissals": BAT_AVG_PRIOR_DISMISSALS,
            "batStrikeRatePriorBalls": BAT_SR_PRIOR_BALLS,
            "bowlPriorBalls": BOWL_PRIOR_BALLS,
            "opportunityGroups": OPPORTUNITY_GROUPS,
            "neutralOpportunity": NEUTRAL_OPPORTUNITY,
            "positionEvidenceWeights": POSITION_EVIDENCE_WEIGHTS,
            "roleWeights": ROLE_WEIGHTS,
            "tierThresholds": TIER_THRESHOLDS,
            "secondaryRawBonusCaps": {
                "battingAllRounderBowling": BATTER_ALL_ROUNDER_BOWLING_RAW_BONUS_CAP,
                "bowlingAllRounderBatting": BOWLING_ALL_ROUNDER_BATTING_RAW_BONUS_CAP,
                "bowlerBatting": BOWLER_BATTING_RAW_BONUS_CAP,
            },
            "secondaryReliabilityTargets": {
                "bowlingFullReliabilityBalls": BOWLING_SECONDARY_FULL_RELIABILITY_BALLS,
                "bowlingFullReliabilityWickets": BOWLING_SECONDARY_FULL_RELIABILITY_WICKETS,
                "battingFullReliabilityBalls": BATTING_SECONDARY_FULL_RELIABILITY_BALLS,
                "battingFullReliabilityInnings": BATTING_SECONDARY_FULL_RELIABILITY_INNINGS,
                "battingFullReliabilityRuns": BATTING_SECONDARY_FULL_RELIABILITY_RUNS,
            },
            "meaningfulSecondaryEvidence": {
                "bowling": {
                    "legalBallsBowledAtLeast": MEANINGFUL_BOWLING_MIN_BALLS,
                    "orWicketsAtLeast": MEANINGFUL_BOWLING_MIN_WICKETS,
                },
                "batting": {
                    "ballsFacedAtLeast": MEANINGFUL_BATTING_MIN_BALLS,
                    "orRunsAtLeast": MEANINGFUL_BATTING_MIN_RUNS,
                    "orInningsAtLeast": MEANINGFUL_BATTING_MIN_INNINGS,
                },
            },
        },
        "formulas": {
            "softCappedRawScore": (
                "finalRawScore when finalRawScore <= 0.95; otherwise "
                "1 - (1 - 0.95) * exp(-0.45 * (finalRawScore - 0.95) / (1 - 0.95))"
            ),
            "componentRating": "30 + 53 * clamp(softCappedRawScore, 0, 1)",
            "runsScoreRaw": "(runs / opportunityRunsTarget) ** 0.62",
            "inningsScoreRaw": "(inningsBatted / opportunityInningsTarget) ** 0.45",
            "battingProductionRaw": "0.82 * runsScoreRaw + 0.18 * inningsScoreRaw",
            "shrunkAverage": "(runs + leagueBattingAverage * 4.0) / (dismissals + 4.0)",
            "averageScoreRaw": "(shrunkAverage / leagueBattingAverage - 0.55) / 1.35",
            "shrunkStrikeRate": "(runs + leagueStrikeRate * 90.0 / 100) * 100 / (ballsFaced + 90.0)",
            "strikeRateScoreRaw": "(shrunkStrikeRate / leagueStrikeRate - 0.68) / 0.78",
            "battingEfficiencyRaw": "0.45 * averageScoreRaw + 0.55 * strikeRateScoreRaw",
            "battingFinalRawScore": "0.58 * battingProductionRaw + 0.42 * battingEfficiencyRaw",
            "wicketVolumeRaw": "(wickets / 18) ** 0.62",
            "bowlingWorkloadRaw": "(legalBallsBowled / 300) ** 0.50",
            "priorWickets": "72.0 / leagueBowlingStrikeRate",
            "priorRuns": "leagueEconomy * 72.0 / 6",
            "shrunkBowlingStrikeRate": "(legalBallsBowled + priorBowlingBalls) / (wickets + priorWickets)",
            "wicketEfficiencyRaw": "(leagueBowlingStrikeRate / shrunkBowlingStrikeRate - 0.55) / 1.05",
            "shrunkEconomy": "(runsConceded + priorRuns) * 6 / (legalBallsBowled + priorBowlingBalls)",
            "economyEfficiencyRaw": "(leagueEconomy / shrunkEconomy - 0.72) / 0.62",
            "bowlingProductionRaw": "0.72 * wicketVolumeRaw + 0.28 * bowlingWorkloadRaw",
            "bowlingEfficiencyRaw": "0.52 * wicketEfficiencyRaw + 0.48 * economyEfficiencyRaw",
            "bowlingFinalRawScore": "0.52 * bowlingProductionRaw + 0.48 * bowlingEfficiencyRaw",
            "secondaryRawBonus": (
                "min(cap, max(0, secondaryRawScore - typicalComponentRawScore) * evidenceMultiplier), "
                "after meaningful-evidence gate; zero below typical level"
            ),
            "bowlingSecondaryEvidenceMultiplier": "min(1, max(legalBallsBowled / 180, wickets / 8))",
            "battingSecondaryEvidenceMultiplier": "min(1, max(ballsFaced / 120, inningsBatted / 10, runs / 180))",
            "rawBaseScore": "primaryRawScore + cappedEvidenceAdjustedSecondaryRawBonus",
            "activeBaseRating": (
                "common-distribution robust standardization: robustZ = "
                "(rawBaseScore - medianRawBaseScore) / (MAD * 1.4826); "
                "baseRating = clamp(56 + 10 * robustZ, 30, 83)"
            ),
        },
    }


def build_review(rated: list[dict[str, Any]], baselines: Baselines) -> dict[str, Any]:
    ratings = [player["baseRating"] for player in rated]
    low_confidence_high_tiers = [
        compact_player(player)
        for player in sorted(rated, key=rating_sort_key)
        if player["ratingConfidence"] == "low" and player["draftTier"] in {"S", "A"}
    ]
    two_match_high_tiers = [
        compact_player(player)
        for player in sorted(rated, key=rating_sort_key)
        if player["matchesPlayed"] == 2 and player["draftTier"] in {"S", "A", "B"}
    ]
    return {
        "methodology": formulas_and_constants(baselines),
        "summary": {
            "playerSeasonsRated": len(rated),
            "ratingDistribution": distribution(ratings),
            "tierCounts": tier_counts(rated, "draftTier"),
            "absoluteTierCounts": tier_counts(rated, "absoluteTier"),
            "draftTierCounts": tier_counts(rated, "draftTier"),
            "tierCountsByRole": tier_counts_by_role(rated, "draftTier"),
            "absoluteTierCountsByRole": tier_counts_by_role(rated, "absoluteTier"),
            "draftTierCountsByRole": tier_counts_by_role(rated, "draftTier"),
            "confidenceCounts": dict(Counter(player["ratingConfidence"] for player in rated)),
            "note": "Final 2016 V1 candidate; absolute thresholds are fixed and draft-tier coverage affects only draftTier.",
        },
        "calibrationHistory": calibration_history(),
        "draftTierAdjustment": draft_tier_adjustment_review(rated),
        "top25Overall": [compact_player(player) for player in sorted(rated, key=rating_sort_key)[:25]],
        "top15ByRole": by_role_top(rated, 15),
        "completeSTierList": players_in_tier(rated, "S", "draftTier"),
        "completeATierList": players_in_tier(rated, "A", "draftTier"),
        "completeAbsoluteSTierList": players_in_tier(rated, "S", "absoluteTier"),
        "completeDraftSTierList": players_in_tier(rated, "S", "draftTier"),
        "aTierListAfterAdjustment": players_in_tier(rated, "A", "draftTier"),
        "lowOrMediumConfidenceSPlayers": [
            compact_player(player)
            for player in sorted(rated, key=rating_sort_key)
            if player["draftTier"] == "S" and player["ratingConfidence"] in {"low", "medium"}
        ],
        "twoMatchPlayersRatedBOrHigher": two_match_players_b_or_higher(rated),
        "playersReceivingSecondaryBonuses": secondary_bonus_players(rated),
        "allRoundersWithoutSecondaryBonus": all_rounders_without_secondary_bonus(rated),
        "sanityReviewPlayers": named_sanity_players(rated),
        "elitePlayerSeparation": elite_player_separation(rated),
        "rawScoreStandardizationComparison": raw_score_standardization_comparison(rated),
        "playersNearTierBoundaries": players_near_tier_boundaries(rated),
        "lowConfidencePlayersInSOrA": low_confidence_high_tiers,
        "twoMatchPlayersInSAB": two_match_high_tiers,
        "appliedRoleWeightDeviations": applied_weight_deviations(rated),
        "roleReviewFlags": role_review_flags(rated),
        "largeBattingBowlingComponentGaps": component_gap_cases(rated),
        "productionRankGaps": production_rank_gaps(rated),
        "suspiciousCalibrationCases": suspicious_cases(rated),
        "missingOrLimitedData": [
            "No wicketkeeping quality metric is available; no keeping bonus is applied.",
            "No phase, venue, opposition, match-context, entry-over, or pressure adjustment is available in the draft file.",
            "Bowling average is reported only indirectly through wicket rate and economy; it is not scored independently.",
            "This analysis does not include era adjustment, position fit, traits, boosts, team analysis, or simulation.",
        ],
    }


def suspicious_cases(rated: list[dict[str, Any]]) -> list[dict[str, Any]]:
    cases = []
    for player in rated:
        reasons = []
        if player["draftTier"] in {"S", "A"} and player["ratingConfidence"] != "high":
            reasons.append("high_tier_without_high_confidence")
        if player["matchesPlayed"] <= 5 and player["baseRating"] >= 64:
            reasons.append("high_rating_with_small_match_sample")
        if player["ratingBreakdown"]["roleReviewFlags"]:
            reasons.append("role_weights_recomputed_from_evidence")
        if player["battingRating"] is not None and player["bowlingRating"] is not None:
            if abs(player["battingRating"] - player["bowlingRating"]) >= 25:
                reasons.append("large_component_gap")
        if reasons:
            cases.append({**compact_player(player), "reasons": reasons, "ratingBreakdown": player["ratingBreakdown"]})
    return sorted(cases, key=rating_sort_key)


def players_in_tier(rated: list[dict[str, Any]], tier: str, field: str = "draftTier") -> list[dict[str, Any]]:
    return [
        compact_player(player)
        for player in sorted(rated, key=rating_sort_key)
        if player.get(field, player["provisionalTier"]) == tier
    ]


def two_match_players_b_or_higher(rated: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        compact_player(player)
        for player in sorted(rated, key=rating_sort_key)
        if player["matchesPlayed"] == 2 and player.get("draftTier", player["provisionalTier"]) in {"S", "A", "B"}
    ]


def secondary_bonus_players(rated: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows = []
    for player in rated:
        bonus = player["ratingBreakdown"]["baseRatingCalculation"]["consolidatedRawBaseScore"].get("secondaryBonus")
        if bonus and bonus["appliedBonus"] > 0:
            rows.append({**compact_player(player), "secondaryBonus": bonus})
    return sorted(rows, key=lambda item: (-item["secondaryBonus"]["appliedBonus"], item["name"]))


def all_rounders_without_secondary_bonus(rated: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows = []
    for player in rated:
        if player["seasonRole"] not in {"batting_all_rounder", "bowling_all_rounder"}:
            continue
        bonus = player["ratingBreakdown"]["baseRatingCalculation"]["consolidatedRawBaseScore"].get("secondaryBonus")
        if bonus is None or bonus["appliedBonus"] == 0:
            rows.append({**compact_player(player), "secondaryBonus": bonus})
    return sorted(rows, key=rating_sort_key)


def draft_tier_adjustment_review(rated: list[dict[str, Any]]) -> dict[str, Any]:
    franchises = sorted({player["franchise"] for player in rated})
    absolute_s_franchises = sorted({player["franchise"] for player in rated if player["absoluteTier"] == "S"})
    draft_s_franchises = sorted({player["franchise"] for player in rated if player["draftTier"] == "S"})
    promoted = [
        compact_player(player)
        for player in sorted(rated, key=rating_sort_key)
        if player.get("tierAdjustment") == "franchise_coverage"
    ]
    return {
        "coverageTarget": draft_tier_coverage_target(len(franchises)),
        "numberOfFranchises": len(franchises),
        "absoluteSFranchisesBeforeAdjustment": absolute_s_franchises,
        "draftSFranchisesAfterAdjustment": draft_s_franchises,
        "franchisesRemainingWithoutS": sorted(set(franchises) - set(draft_s_franchises)),
        "promotedPlayers": promoted,
        "absoluteTierCounts": tier_counts(rated, "absoluteTier"),
        "draftTierCounts": tier_counts(rated, "draftTier"),
        "absoluteTierCountsByRole": tier_counts_by_role(rated, "absoluteTier"),
        "draftTierCountsByRole": tier_counts_by_role(rated, "draftTier"),
        "completeAbsoluteSList": players_in_tier(rated, "S", "absoluteTier"),
        "completeDraftSList": players_in_tier(rated, "S", "draftTier"),
        "aTierListAfterAdjustment": players_in_tier(rated, "A", "draftTier"),
    }


def previous_vs_consolidated_sanity_players(rated: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    by_name = {player["name"]: player for player in rated}
    output = {}
    for name in SANITY_REVIEW_PLAYERS:
        player = by_name.get(name)
        if not player:
            continue
        output[name] = {
            **compact_player(player),
            "previousActiveBaseRating": player["previousActiveBaseRating"],
            "consolidatedBaseRating": player["baseRating"],
            "ratingChange": round(player["baseRating"] - player["previousActiveBaseRating"], 1),
            "rawBaseScore": player["ratingBreakdown"]["rawBaseScore"],
            "robustZScore": player["ratingBreakdown"]["robustZScore"],
            "secondaryBonus": player["ratingBreakdown"]["baseRatingCalculation"]["consolidatedRawBaseScore"].get(
                "secondaryBonus"
            ),
        }
    return output


def rate_player_seasons(players: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    baselines = calculate_baselines(players)
    preliminary = [rate_player(player, baselines) for player in players]
    typical_raw_scores = component_typical_raw_scores(preliminary)
    rated = [rate_player(player, baselines, typical_raw_scores) for player in players]
    context = robust_context([raw_base_score(player) for player in rated])
    for player in rated:
        raw_score = raw_base_score(player)
        base_rating, robust_z = robust_rating(raw_score, context)
        player["baseRating"] = base_rating
        player["ratingBreakdown"]["robustZScore"] = rounded(robust_z)
        player["ratingBreakdown"]["baseRatingCalculation"]["activeMethod"] = "common_distribution_robust_z"
        player["ratingBreakdown"]["baseRatingCalculation"]["robustStandardization"] = {
            "medianRawBaseScore": rounded(context["median"]),
            "medianAbsoluteDeviation": rounded(context["medianAbsoluteDeviation"]),
            "robustScaleMADTimes1_4826": rounded(context["robustScale"]),
            "rawBaseScore": rounded(raw_score),
            "robustZScore": rounded(robust_z),
            "baseRatingFormula": "clamp(56 + 10 * robustZ, 30, 83)",
            "baseRating": base_rating,
        }
    apply_draft_tier_coverage(rated)
    rated.sort(key=lambda item: (item["season"], item["franchise"], item["name"], item["playerId"]))
    return rated, build_review(rated, baselines)


def canonical_component_breakdown(component: dict[str, Any] | None) -> dict[str, Any] | None:
    if component is None:
        return None
    flags = component["flags"]
    return {
        "rating": component["rating"],
        "metrics": component["metrics"],
        "flags": {
            "unclampedRawScore": flags["unclampedRawScore"],
            "ratingRawScore": flags["softCappedRawScore"],
            "clippedLow": flags["clippedLow"],
            "aboveRatingRange": flags["abovePreviousHardCap"],
            "saturatedAtTop": flags["saturatedAtTop"],
            "saturatedAtBottom": flags["saturatedAtBottom"],
        },
    }


def canonical_base_rating_calculation(calculation: dict[str, Any]) -> dict[str, Any]:
    return {
        "consolidatedRawBaseScore": calculation["consolidatedRawBaseScore"],
        "activeMethod": calculation["activeMethod"],
        "robustStandardization": calculation["robustStandardization"],
    }


def canonical_rating_breakdown(breakdown: dict[str, Any]) -> dict[str, Any]:
    return {
        "inputs": breakdown["inputs"],
        "batting": canonical_component_breakdown(breakdown["batting"]),
        "bowling": canonical_component_breakdown(breakdown["bowling"]),
        "defaultRoleWeights": breakdown["defaultRoleWeights"],
        "appliedRoleWeights": breakdown["appliedRoleWeights"],
        "roleReviewFlags": breakdown["roleReviewFlags"],
        "baseRatingCalculation": canonical_base_rating_calculation(breakdown["baseRatingCalculation"]),
        "rawBaseScore": breakdown["rawBaseScore"],
        "robustZScore": breakdown["robustZScore"],
    }


def canonical_rated_player(player: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in {
            **player,
            "ratingBreakdown": canonical_rating_breakdown(player["ratingBreakdown"]),
        }.items()
        if key
        not in {
            "previousActiveBaseRating",
            "previousClampedBaseRating",
            "provisionalTier",
            "ordinaryZScore",
            "ordinaryZComparisonRating",
            "robustZComparisonRating",
        }
    }


def canonical_rated_players(rated: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [canonical_rated_player(player) for player in rated]


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate provisional player-season base ratings.")
    parser.add_argument("--processed-dir", type=Path, default=Path("data/processed/2016"))
    args = parser.parse_args()

    draft_players = load_json(args.processed_dir / "draft_player_seasons.json", [])
    rated, review = rate_player_seasons(draft_players)
    write_json(args.processed_dir / "rated_player_seasons.json", canonical_rated_players(rated))
    write_json(args.processed_dir / "ratings_review.json", review)


if __name__ == "__main__":
    main()
