#!/usr/bin/env python3
"""Build deterministic Stage 9A all-era opponent candidates and review packets.

The approved Foundation profiles and era environments remain immutable Stage 7
runtime artifacts. This builder recomputes them only for parity verification and
writes separate Phase 1 evidence for later human curation.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import statistics
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable

from scripts.cricsheet_audit.reporting import canonical_json_bytes, pretty_json_bytes
from scripts.identity_registry.schemas import SCHEMA_DRAFT, validate_instance

ROOT = Path(__file__).resolve().parents[1]
ANALYTICS = ROOT / "data/analytical/cricsheet-ipl/v1"
ROLES_PATH = ROOT / "data/processed/era-draft/roles/v1/player_role_consumer.jsonl"
QUALITY_PATH = ROOT / "data/processed/era-draft/quality/v1/player_quality_consumer.jsonl"
ROSTER_PATH = ROOT / "data/metadata/ipl/country_overseas/v1/player_team_season_metadata.jsonl"
REVIEW_PATH = ROOT / "data/manual/era-simulation/v2/foundation_opponents.json"
OUTPUT = ROOT / "data/processed/era-draft/simulation/v2"
VERSION = "ipl-era-simulation/v2"
PHASE1_VERSION = "ipl-era-opponent-content-phase1/v1"
CANDIDATE_SCHEMA_VERSION = "ipl-era-opponent-candidate/v2"
REVIEW_PACKET_SCHEMA_VERSION = "ipl-era-opponent-review-packets/v1"
PHASE1_MANIFEST_SCHEMA_VERSION = "ipl-era-opponent-content-phase1-manifest/v1"
PHASE1_VALIDATION_SCHEMA_VERSION = "ipl-era-opponent-content-phase1-validation/v1"
FOUNDATION_SIMULATION_COMPATIBILITY_FINGERPRINT = "03054faff39520da6a835e0aaecb1a9887ca82291d9ba0a5923540c862793808"
FOUNDATION_OPPONENT_SHA256 = "c904df120bf8920f6967c13f04bd1725826e5e20cfa31291a49934187c373a0c"
PROFILE_TERMINOLOGY = "representative historical season XI"
ERA_IDS = (
    "era-foundation",
    "era-expansion",
    "era-transition",
    "era-modern-pre-impact",
    "era-impact",
)
EXPECTED_CANDIDATES = {
    "era-foundation": 24,
    "era-expansion": 28,
    "era-transition": 32,
    "era-modern-pre-impact": 42,
    "era-impact": 40,
}
EXPECTED_LINEAGES = {
    "era-foundation": 8,
    "era-expansion": 11,
    "era-transition": 10,
    "era-modern-pre-impact": 10,
    "era-impact": 10,
}
FLOOR = 20.0


def rows(path: Path) -> list[dict[str, Any]]:
    with path.open(encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def document(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def rounded(value: float) -> float:
    return round(value + 0.0, 6)


def mean(values: Iterable[float]) -> float:
    values = list(values)
    return sum(values) / len(values)


def pstdev(values: Iterable[float]) -> float:
    values = list(values)
    return statistics.pstdev(values) if len(values) > 1 else 0.0


def zscores(values: list[float]) -> list[float]:
    spread = pstdev(values)
    center = mean(values)
    return [(value - center) / spread if spread else 0.0 for value in values]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def bytes_sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def aggregate_hash(files: dict[str, bytes]) -> str:
    digest = hashlib.sha256()
    for path, content in sorted(files.items()):
        digest.update(path.encode("utf-8"))
        digest.update(b"\0")
        digest.update(content)
    return digest.hexdigest()


def artifact_entry(path: str, content: bytes, schema_version: str, rows_count: int | None) -> dict[str, Any]:
    return {
        "path": path,
        "sha256": bytes_sha256(content),
        "sizeBytes": len(content),
        "rows": rows_count,
        "schemaVersion": schema_version,
    }


def environment_rows(eras: list[dict[str, Any]], matches: list[dict[str, Any]]) -> list[dict[str, Any]]:
    output = []
    for era in eras:
        season_ids = set(era["seasonIds"])
        eligible_matches = [
            match for match in matches
            if match["seasonId"] in season_ids
            and match["cohort"] in {"standard", "adjusted"}
            and len(match["normalInnings"]) == 2
        ]
        innings = [item for match in eligible_matches for item in match["normalInnings"]]
        first = [item for item in innings if item["inningsOrder"] == "first"]
        chase = [item for item in innings if item["inningsOrder"] == "chase"]
        runs = [float(item["totals"]["runs"]) for item in innings]
        wickets = [float(item["totals"]["dismissals"]) for item in innings]
        first_runs = [float(item["totals"]["runs"]) for item in first]
        chase_runs = [float(item["totals"]["runs"]) for item in chase]
        run_center = mean(runs)
        wicket_center = mean(wickets)
        variance = sum((run - run_center) ** 2 for run in runs)
        slope = sum((run - run_center) * (wicket - wicket_center) for run, wicket in zip(runs, wickets)) / variance
        residuals = [wicket - wicket_center - slope * (run - run_center) for run, wicket in zip(runs, wickets)]
        chase_counts = Counter()
        for first_item, chase_item in zip(first, chase):
            first_total = first_item["totals"]["runs"]
            chase_total = chase_item["totals"]["runs"]
            chase_counts["successful" if chase_total > first_total else "tie" if chase_total == first_total else "failed"] += 1
        decided = chase_counts["successful"] + chase_counts["failed"]
        chase_rate = chase_counts["successful"] / decided if decided else 0.5
        chase_rate_for_logit = min(0.99, max(0.01, chase_rate))
        chase_bias = math.sqrt(2) * pstdev(first_runs) * statistics.NormalDist().inv_cdf(chase_rate_for_logit)
        all_out_balls = Counter(
            item["totals"]["legalBalls"] for item in innings
            if item["totals"]["dismissals"] >= 10
        )
        output.append({
            "schemaVersion": VERSION,
            "eraId": era["eraId"],
            "label": era["label"],
            "seasonIds": era["seasonIds"],
            "sourceCohort": "all_normal",
            "sample": {"matches": len(eligible_matches), "innings": len(innings)},
            "runs": {
                "firstInningsMean": rounded(mean(first_runs)),
                "chaseInningsMean": rounded(mean(chase_runs)),
                "allInningsMean": rounded(run_center),
                "standardDeviation": rounded(pstdev(runs)),
                "observedMinimum": int(min(runs)),
                "observedMaximum": int(max(runs)),
                "simulationMinimum": max(0, int(min(runs)) - 20),
                "simulationMaximum": min(350, int(max(runs)) + 30),
            },
            "wickets": {
                "mean": rounded(wicket_center),
                "standardDeviation": rounded(pstdev(wickets)),
                "runSlope": rounded(slope),
                "residualStandardDeviation": rounded(pstdev(residuals)),
            },
            "chase": {
                "successful": chase_counts["successful"],
                "failed": chase_counts["failed"],
                "tied": chase_counts["tie"],
                "successRateExcludingTies": rounded(chase_rate),
                "initialBiasRuns": rounded(chase_bias),
            },
            "regulationTieRate": rounded(chase_counts["tie"] / len(eligible_matches)),
            "allOutBallsHistogram": [
                {"balls": balls, "count": count} for balls, count in sorted(all_out_balls.items())
            ],
        })
    return output


def choose_eleven(pool: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Maximize official-list seasons, then quality, under XI legality constraints."""
    states: dict[tuple[int, int, bool], tuple[tuple[float, float, str], list[dict[str, Any]]]] = {
        (0, 0, False): ((0.0, 0.0, ""), [])
    }
    for player in sorted(pool, key=lambda item: item["playerTeamSeasonId"]):
        next_states = dict(states)
        for (count, overseas, keeper), (score, selected) in states.items():
            next_count = count + 1
            next_overseas = overseas + (player["rosterStatus"] == "OVERSEAS")
            if next_count > 11 or next_overseas > 4:
                continue
            next_keeper = keeper or player["keeper"]
            ids = score[2] + "|" + player["playerTeamSeasonId"]
            next_score = (
                score[0] + player["officialListMatchCount"],
                score[1] + player["overallRating"],
                ids,
            )
            key = (next_count, next_overseas, next_keeper)
            prior = next_states.get(key)
            if prior is None or next_score[:2] > prior[0][:2] or (next_score[:2] == prior[0][:2] and ids < prior[0][2]):
                next_states[key] = (next_score, selected + [player])
        states = next_states
    chosen = states.get((11, 0, True))
    for overseas in range(1, 5):
        candidate = states.get((11, overseas, True))
        if candidate and (chosen is None or candidate[0][:2] > chosen[0][:2]):
            chosen = candidate
    if chosen is None:
        raise ValueError("No legal reviewed-opponent XI can be selected from pool")
    return chosen[1]


def fit_cost(player: dict[str, Any], position: int) -> int:
    slot = player["role"]["battingFit"]["slots"][position - 1]
    classification = slot["classification"]
    return {"NATURAL": 0, "ACCEPTABLE": 10, "UNKNOWN": 30}.get(classification, 100 + (slot["bandDistance"] or 0))


def order_eleven(players: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Assign all eleven batting slots with exact subset DP and stable tie-breaking."""
    ordered_players = sorted(players, key=lambda item: item["playerTeamSeasonId"])
    states: dict[int, tuple[int, float, tuple[int, ...]]] = {0: (0, 0.0, ())}
    for position in range(1, 12):
        weight = 0.9 / 7 if position <= 7 else 0.1 / 4
        next_states: dict[int, tuple[int, float, tuple[int, ...]]] = {}
        for mask, (cost, batting_score, indices) in states.items():
            for index, player in enumerate(ordered_players):
                if mask & (1 << index):
                    continue
                rating = player["quality"]["batting"]["battingRating"] or FLOOR
                value = (cost + fit_cost(player, position), batting_score + weight * rating, indices + (index,))
                next_mask = mask | (1 << index)
                prior = next_states.get(next_mask)
                if prior is None or value[0] < prior[0] or (value[0] == prior[0] and value[1] > prior[1]) or (value[:2] == prior[:2] and value[2] < prior[2]):
                    next_states[next_mask] = value
        states = next_states
    indices = states[(1 << 11) - 1][2]
    return [ordered_players[index] for index in indices]


def evaluation(players: list[dict[str, Any]]) -> dict[str, Any]:
    batting = [player["quality"]["batting"]["battingRating"] or FLOOR for player in players]
    core = mean(batting[:7])
    depth = mean(batting[7:])
    base_batting = 0.9 * core + 0.1 * depth
    deductions = []
    for position, player in enumerate(players, 1):
        slot = player["role"]["battingFit"]["slots"][position - 1]
        deduction = 0 if slot["classification"] in {"NATURAL", "UNKNOWN"} else 1 if slot["classification"] == "ACCEPTABLE" else min(6, 2 + slot["bandDistance"])
        deductions.append(max(FLOOR, batting[position - 1] - deduction))
    fitted = 0.9 * mean(deductions[:7]) + 0.1 * mean(deductions[7:])
    adjusted_batting = base_batting + max(-4, fitted - base_batting)
    bowlers = sorted([
        (player["quality"]["bowling"]["bowlingRating"], min(1, player["role"]["bowlingCapacity"] / 0.75), player["playerId"])
        for player in players if player["quality"]["bowling"]["bowlingRating"] is not None
    ], key=lambda value: (-value[0], value[2]))
    remaining = 5.0
    contribution = 0.0
    for rating, capacity, _ in bowlers:
        deployed = min(remaining, capacity)
        contribution += rating * deployed
        remaining -= deployed
        if remaining <= 0:
            break
    bowling = (contribution + max(0, remaining) * FLOOR) / 5
    return {
        "battingCore": rounded(core), "battingDepth": rounded(depth),
        "batting": rounded(adjusted_batting), "bowling": rounded(bowling),
        "overall": rounded((adjusted_batting + bowling) / 2),
        "structuralBattingOrderEffect": rounded(base_batting - mean(sorted(batting, reverse=True)[:7])),
        "appliedPositionFitEffect": rounded(max(-4, fitted - base_batting)),
        "bowlingCapacity": rounded(sum(player["role"]["bowlingCapacity"] for player in players)),
        "uncoveredBowlingUnits": rounded(max(0, remaining)),
    }


def nrr_for_team(team_id: str, season_id: str, matches: list[dict[str, Any]]) -> float:
    for_runs = for_balls = against_runs = against_balls = 0
    for match in matches:
        if match["seasonId"] != season_id or match["cohort"] not in {"standard", "adjusted"}:
            continue
        for innings in match["normalInnings"]:
            total = innings["totals"]
            balls = innings["scheduledQuotaBalls"] if total["dismissals"] >= 10 else total["legalBalls"]
            if innings["battingTeamId"] == team_id:
                for_runs += total["runs"]
                for_balls += balls
            elif innings["bowlingTeamId"] == team_id:
                against_runs += total["runs"]
                against_balls += balls
    return (for_runs / (for_balls / 6)) - (against_runs / (against_balls / 6)) if for_balls and against_balls else 0.0


def replacement_counts(players: Iterable[dict[str, Any]]) -> dict[str, int]:
    keys = ("impactIn", "impactOut", "concussionIn", "concussionOut", "roleIn", "roleOut")
    totals = Counter({key: 0 for key in keys})
    for player in players:
        for contribution in player["analytics"]["participation"]["matchContributions"]:
            totals.update(contribution["replacementEvents"])
    return {key: totals[key] for key in keys}


def candidate_diagnostics(pool: list[dict[str, Any]], chosen: list[dict[str, Any]], evaluated: dict[str, Any]) -> dict[str, Any]:
    fit_counts = Counter({key: 0 for key in ("NATURAL", "ACCEPTABLE", "OUT_OF_ROLE", "UNKNOWN")})
    for position, player in enumerate(chosen, 1):
        fit_counts[player["role"]["battingFit"]["slots"][position - 1]["classification"]] += 1
    workload_counts = Counter({key: 0 for key in ("NONE", "OCCASIONAL", "SUPPORT", "FRONTLINE")})
    family_capacity = {"PACE": 0.0, "SPIN": 0.0, "UNKNOWN": 0.0}
    phase_capacity = {"powerplay": 0.0, "middle": 0.0, "death": 0.0}
    normalized_units = 0.0
    for player in chosen:
        role = player["role"]
        workload_counts[role["bowlingWorkloadClass"]] += 1
        capacity = role["bowlingCapacity"]
        family = role["bowlingFamily"]
        if family == "MIXED":
            family_capacity["PACE"] += capacity / 2
            family_capacity["SPIN"] += capacity / 2
        else:
            family_capacity[family] += capacity
        for phase in phase_capacity:
            phase_capacity[phase] += capacity * (role["phaseBowlingUsage"][phase]["share"] or 0)
        if player["quality"]["bowling"]["bowlingRating"] is not None:
            normalized_units += min(1, capacity / 0.75)
    overseas_count = sum(player["rosterStatus"] == "OVERSEAS" for player in chosen)
    keeper_count = sum(player["keeper"] for player in chosen)
    team_replacements = replacement_counts(pool)
    xi_replacements = replacement_counts(chosen)
    flags = []
    if evaluated["uncoveredBowlingUnits"] > 0:
        flags.append("BOWLING_UNITS_UNCOVERED")
    if fit_counts["UNKNOWN"]:
        flags.append("UNKNOWN_POSITION_FIT_PRESENT")
    if sum(team_replacements.values()):
        flags.append("REPLACEMENT_PARTICIPATION_PRESENT")
    return {
        "dataCompleteness": {
            "status": "COMPLETE",
            "eligiblePlayerCount": len(pool),
            "joinedPlayerCount": len(pool),
            "unresolvedRosterStatusCount": 0,
            "confirmedKeeperCandidateCount": sum(player["keeper"] for player in pool),
            "issues": [],
        },
        "legality": {
            "playerCount": len(chosen),
            "uniqueCanonicalPlayerCount": len({player["playerId"] for player in chosen}),
            "overseasCount": overseas_count,
            "confirmedKeeperCount": keeper_count,
        },
        "officialParticipation": {
            "xiMatchCountTotal": sum(player["officialListMatchCount"] for player in chosen),
            "xiMatchCountMinimum": min(player["officialListMatchCount"] for player in chosen),
            "xiMatchCountMaximum": max(player["officialListMatchCount"] for player in chosen),
        },
        "positionFitCounts": {key: fit_counts[key] for key in ("NATURAL", "ACCEPTABLE", "OUT_OF_ROLE", "UNKNOWN")},
        "bowlingCoverage": {
            "bowlingCapacity": evaluated["bowlingCapacity"],
            "normalizedBowlingUnitsAvailable": rounded(normalized_units),
            "uncoveredBowlingUnits": evaluated["uncoveredBowlingUnits"],
            "workloadCounts": {key: workload_counts[key] for key in ("NONE", "OCCASIONAL", "SUPPORT", "FRONTLINE")},
            "familyCapacity": {key: rounded(value) for key, value in family_capacity.items()},
            "phaseCapacity": {key: rounded(value) for key, value in phase_capacity.items()},
        },
        "replacementContext": {
            "diagnosticOnly": True,
            "teamSeasonEvents": team_replacements,
            "representativeXiEvents": xi_replacements,
        },
        "reviewFlags": flags,
    }


def candidate_rows(
    roles: list[dict[str, Any]], quality: list[dict[str, Any]], roster: list[dict[str, Any]],
    analytics_players: list[dict[str, Any]], team_seasons: list[dict[str, Any]], matches: list[dict[str, Any]],
    eras: list[dict[str, Any]], teams: list[dict[str, Any]], franchises: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    quality_by_id = {item["playerTeamSeasonId"]: item for item in quality}
    roster_by_id = {item["playerTeamSeasonId"]: item for item in roster}
    analytics_by_id = {item["playerTeamSeasonId"]: item for item in analytics_players}
    if len(quality_by_id) != len(quality) or len(analytics_by_id) != len(analytics_players):
        raise ValueError("Duplicate Stage 6 or Stage 4 player-team-season identity")
    team_by_id = {item["teamId"]: item for item in teams}
    franchise_by_id = {item["franchiseId"]: item for item in franchises}
    era_by_season = {
        season_id: era["eraId"]
        for era in eras
        for season_id in era["seasonIds"]
    }
    if set(era["eraId"] for era in eras) != set(ERA_IDS):
        raise ValueError("Stage 9A requires the five frozen canonical eras")
    pools: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for role in roles:
        pts_id = role["playerTeamSeasonId"]
        quality_row = quality_by_id.get(pts_id)
        roster_row = roster_by_id.get(pts_id)
        analytics_row = analytics_by_id.get(pts_id)
        if quality_row is None or roster_row is None or analytics_row is None:
            raise ValueError(f"Incomplete candidate input join for {pts_id}")
        identity = (role["playerId"], role["seasonId"], role["teamId"])
        for label, value in (("quality", quality_row), ("roster", roster_row), ("analytics", analytics_row)):
            if (value["playerId"], value["seasonId"], value["teamId"]) != identity:
                raise ValueError(f"{label} identity mismatch for {pts_id}")
        if role["seasonId"] not in era_by_season:
            raise ValueError(f"No era membership for {pts_id}")
        if roster_row["iplRosterStatus"] not in {"INDIAN", "OVERSEAS"}:
            raise ValueError(f"Unresolved roster status for {pts_id}")
        pools[(role["teamId"], role["seasonId"])].append({
            "playerTeamSeasonId": pts_id,
            "playerId": role["playerId"],
            "canonicalDisplayName": role["canonicalDisplayName"],
            "role": role,
            "quality": quality_row,
            "analytics": analytics_row,
            "rosterStatus": roster_row["iplRosterStatus"],
            "officialListMatchCount": analytics_row["participation"]["officialListMatchCount"],
            "overallRating": quality_row["overall"]["overallRating"],
            "keeper": role["keeperMetadata"]["capabilityStatus"] == "CONFIRMED",
        })
    expected_team_seasons = {
        (team["teamId"], season_id)
        for team in teams
        for season_id in team["activeSeasonIds"]
        if season_id in era_by_season
    }
    if set(pools) != expected_team_seasons:
        missing = sorted(expected_team_seasons - set(pools))
        extra = sorted(set(pools) - expected_team_seasons)
        raise ValueError(f"Candidate team-season coverage mismatch; missing={missing}, extra={extra}")
    season_by_key = {(item["teamId"], item["seasonId"]): item for item in team_seasons}
    if set(season_by_key) != expected_team_seasons:
        raise ValueError("Stage 4 team-season identities disagree with canonical active team-seasons")
    candidates = []
    for (team_id, season_id), pool in sorted(pools.items()):
        team_identity = team_by_id[team_id]
        franchise_id = team_identity["franchiseId"]
        if any(player["role"]["franchiseId"] != franchise_id for player in pool):
            raise ValueError(f"Franchise identity mismatch in {team_id} {season_id}")
        chosen = order_eleven(choose_eleven(pool))
        team = season_by_key[(team_id, season_id)]
        games = sum(team["results"][key] for key in ("wins", "losses", "ties", "noResults"))
        points_pct = (2 * team["results"]["wins"] + team["results"]["ties"] + team["results"]["noResults"]) / (2 * games)
        evaluated = evaluation(chosen)
        candidates.append({
            "schemaVersion": CANDIDATE_SCHEMA_VERSION,
            "contentStatus": "GENERATED_CANDIDATE",
            "profileTerminology": PROFILE_TERMINOLOGY,
            "candidateId": f"opponent:{team_id}:{season_id}",
            "eraId": era_by_season[season_id],
            "franchiseId": franchise_id,
            "franchiseName": franchise_by_id[franchise_id]["canonicalName"],
            "teamId": team_id,
            "teamName": team_identity["canonicalName"],
            "seasonId": season_id,
            "historical": {
                "pointsPercentage": rounded(points_pct),
                "netRunRate": rounded(nrr_for_team(team_id, season_id, matches)),
            },
            "xi": [{
                "position": position,
                "playerTeamSeasonId": player["playerTeamSeasonId"],
                "playerId": player["playerId"],
                "displayName": player["canonicalDisplayName"],
                "rosterStatus": player["rosterStatus"],
                "officialListMatchCount": player["officialListMatchCount"],
            } for position, player in enumerate(chosen, 1)],
            "evaluation": evaluated,
            "diagnostics": candidate_diagnostics(pool, chosen, evaluated),
        })
    for era_id in ERA_IDS:
        era_candidates = [candidate for candidate in candidates if candidate["eraId"] == era_id]
        quality_z = zscores([candidate["evaluation"]["overall"] for candidate in era_candidates])
        performance_z: dict[str, float] = {}
        for season_id in sorted({candidate["seasonId"] for candidate in era_candidates}):
            group = [candidate for candidate in era_candidates if candidate["seasonId"] == season_id]
            points_z = zscores([candidate["historical"]["pointsPercentage"] for candidate in group])
            nrr_z = zscores([candidate["historical"]["netRunRate"] for candidate in group])
            for candidate, points_value, nrr_value in zip(group, points_z, nrr_z):
                performance_z[candidate["candidateId"]] = 0.7 * points_value + 0.3 * nrr_value
        for candidate, quality_value in zip(era_candidates, quality_z):
            performance_value = performance_z[candidate["candidateId"]]
            candidate["selectionHeuristic"] = {
                "qualityZ": rounded(quality_value),
                "historicalPerformanceZ": rounded(performance_value),
                "candidateScore": rounded(0.7 * quality_value + 0.3 * performance_value),
                "weights": {"v2Quality": 0.7, "historicalPerformance": 0.3},
                "advisoryOnly": True,
            }
    return candidates


def legacy_candidate_view(candidate: dict[str, Any]) -> dict[str, Any]:
    return {
        key: candidate[key]
        for key in (
            "candidateId", "eraId", "evaluation", "franchiseId", "historical",
            "seasonId", "selectionHeuristic", "teamId", "teamName", "xi",
        )
    } | {
        "selectionHeuristic": {
            key: candidate["selectionHeuristic"][key]
            for key in ("candidateScore", "historicalPerformanceZ", "qualityZ", "weights")
        }
    }


def reviewed_profiles(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not REVIEW_PATH.exists():
        raise FileNotFoundError(f"Missing explicit review file: {REVIEW_PATH}")
    review = document(REVIEW_PATH)
    if review.get("reviewStatus") != "APPROVED" or len(review.get("opponents", [])) != 8:
        raise ValueError("Foundation opponent review must be APPROVED and enumerate exactly eight opponents")
    by_id = {candidate["candidateId"]: candidate for candidate in candidates}
    profiles = []
    seen_franchises = set()
    for item in review["opponents"]:
        candidate = by_id[item["candidateId"]]
        expected_ids = [player["playerTeamSeasonId"] for player in candidate["xi"]]
        if item["orderedPlayerTeamSeasonIds"] != expected_ids:
            raise ValueError(f"Reviewed XI no longer matches deterministic candidate {item['candidateId']}")
        if candidate["franchiseId"] in seen_franchises:
            raise ValueError("Reviewed opponents must contain one team per original franchise lineage")
        seen_franchises.add(candidate["franchiseId"])
        profiles.append({**candidate, "review": {
            "status": "APPROVED", "reviewedOn": review["reviewedOn"], "rationale": item["rationale"],
            "heuristicIsAdvisory": True,
        }})
    if len(seen_franchises) != 8:
        raise ValueError("Reviewed opponent set must contain eight distinct franchise lineages")
    return profiles


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def schema_documents() -> dict[str, dict[str, Any]]:
    string = {"type": "string", "minLength": 1}
    number = {"type": "number"}
    integer = {"type": "integer", "minimum": 0}

    def obj(properties: dict[str, Any], required: list[str] | None = None) -> dict[str, Any]:
        return {"type": "object", "additionalProperties": False, "required": required or list(properties), "properties": properties}

    strength = obj({key: number for key in [
        "battingCore", "battingDepth", "batting", "bowling", "overall", "structuralBattingOrderEffect",
        "appliedPositionFitEffect", "bowlingCapacity", "uncoveredBowlingUnits",
    ]})
    historical = obj({"pointsPercentage": number, "netRunRate": number})
    heuristic = obj({
        "candidateScore": number, "historicalPerformanceZ": number, "qualityZ": number,
        "weights": obj({"historicalPerformance": {"const": 0.3}, "v2Quality": {"const": 0.7}}),
    })
    xi_player = obj({
        "displayName": string, "officialListMatchCount": integer, "playerId": string,
        "playerTeamSeasonId": string, "position": {"type": "integer", "minimum": 1, "maximum": 11},
        "rosterStatus": {"type": "string", "enum": ["INDIAN", "OVERSEAS"]},
    })
    candidate_properties = {
        "candidateId": string, "eraId": {"const": "era-foundation"}, "evaluation": strength, "franchiseId": string, "historical": historical,
        "seasonId": string, "selectionHeuristic": heuristic, "teamId": string, "teamName": string,
        "xi": {"type": "array", "minItems": 11, "maxItems": 11, "items": xi_player},
    }
    candidate = obj(candidate_properties)
    review = obj({
        "heuristicIsAdvisory": {"const": True}, "rationale": string, "reviewedOn": string,
        "status": {"const": "APPROVED"},
    })
    opponent = obj({**candidate_properties, "review": review})
    environment = obj({
        "allOutBallsHistogram": {"type": "array", "items": obj({"balls": integer, "count": integer})},
        "chase": obj({"failed": integer, "initialBiasRuns": number, "successRateExcludingTies": number, "successful": integer, "tied": integer}),
        "eraId": {"type": "string", "enum": [item for item in [
            "era-foundation", "era-expansion", "era-transition", "era-modern-pre-impact", "era-impact",
        ]]},
        "label": string, "regulationTieRate": number,
        "runs": obj({key: (integer if key in {"observedMaximum", "observedMinimum", "simulationMaximum", "simulationMinimum"} else number) for key in [
            "allInningsMean", "chaseInningsMean", "firstInningsMean", "observedMaximum", "observedMinimum",
            "simulationMaximum", "simulationMinimum", "standardDeviation",
        ]}),
        "sample": obj({"innings": integer, "matches": integer}), "schemaVersion": {"const": VERSION},
        "seasonIds": {"type": "array", "minItems": 1, "uniqueItems": True, "items": string},
        "sourceCohort": {"const": "all_normal"},
        "wickets": obj({"mean": number, "residualStandardDeviation": number, "runSlope": number, "standardDeviation": number}),
    })
    return {
        "era_environments.schema.json": {"$schema": SCHEMA_DRAFT, **obj({
            "environments": {"type": "array", "minItems": 5, "maxItems": 5, "items": environment}, "schemaVersion": {"const": VERSION},
        })},
        "foundation_opponent_candidates.schema.json": {"$schema": SCHEMA_DRAFT, **obj({
            "candidates": {"type": "array", "minItems": 24, "items": candidate}, "schemaVersion": {"const": VERSION},
            "selectionPolicy": {"const": "advisory-70-30"},
        })},
        "foundation_opponents.schema.json": {"$schema": SCHEMA_DRAFT, **obj({
            "eraId": {"const": "era-foundation"}, "opponents": {"type": "array", "minItems": 8, "maxItems": 8, "items": opponent},
            "schemaVersion": {"const": VERSION},
        })},
        "manifest.schema.json": {"$schema": SCHEMA_DRAFT, **obj({
            "inputHashes": {"type": "object", "additionalProperties": {"type": "string", "pattern": "[0-9a-f]{64}"}},
            "opponentContentEraIds": {"type": "array", "items": string},
            "outputCounts": obj({"environments": integer, "foundationCandidates": integer, "foundationOpponents": integer}),
            "schemaVersion": {"const": VERSION},
        })},
    }


def phase1_schema_documents() -> dict[str, dict[str, Any]]:
    string = {"type": "string", "minLength": 1}
    number = {"type": "number"}
    integer = {"type": "integer", "minimum": 0}
    hash_string = {"type": "string", "pattern": "^[0-9a-f]{64}$"}

    def obj(properties: dict[str, Any], required: list[str] | None = None) -> dict[str, Any]:
        return {
            "type": "object", "additionalProperties": False,
            "required": required or list(properties), "properties": properties,
        }

    counts = obj({era_id: integer for era_id in ERA_IDS})
    strength = obj({key: number for key in (
        "battingCore", "battingDepth", "batting", "bowling", "overall",
        "structuralBattingOrderEffect", "appliedPositionFitEffect", "bowlingCapacity",
        "uncoveredBowlingUnits",
    )})
    historical = obj({"pointsPercentage": number, "netRunRate": number})
    xi_player = obj({
        "position": {"type": "integer", "minimum": 1, "maximum": 11},
        "playerTeamSeasonId": string, "playerId": string, "displayName": string,
        "rosterStatus": {"enum": ["INDIAN", "OVERSEAS"]}, "officialListMatchCount": integer,
    })
    xi = {"type": "array", "minItems": 11, "maxItems": 11, "items": xi_player}
    replacement_counts_schema = obj({key: integer for key in (
        "impactIn", "impactOut", "concussionIn", "concussionOut", "roleIn", "roleOut",
    )})
    diagnostics = obj({
        "dataCompleteness": obj({
            "status": {"const": "COMPLETE"}, "eligiblePlayerCount": integer,
            "joinedPlayerCount": integer, "unresolvedRosterStatusCount": {"const": 0},
            "confirmedKeeperCandidateCount": integer,
            "issues": {"type": "array", "items": string},
        }),
        "legality": obj({
            "playerCount": {"const": 11}, "uniqueCanonicalPlayerCount": {"const": 11},
            "overseasCount": {"type": "integer", "minimum": 0, "maximum": 4},
            "confirmedKeeperCount": {"type": "integer", "minimum": 1},
        }),
        "officialParticipation": obj({
            "xiMatchCountTotal": integer, "xiMatchCountMinimum": integer,
            "xiMatchCountMaximum": integer,
        }),
        "positionFitCounts": obj({
            key: integer for key in ("NATURAL", "ACCEPTABLE", "OUT_OF_ROLE", "UNKNOWN")
        }),
        "bowlingCoverage": obj({
            "bowlingCapacity": number, "normalizedBowlingUnitsAvailable": number,
            "uncoveredBowlingUnits": number,
            "workloadCounts": obj({
                key: integer for key in ("NONE", "OCCASIONAL", "SUPPORT", "FRONTLINE")
            }),
            "familyCapacity": obj({key: number for key in ("PACE", "SPIN", "UNKNOWN")}),
            "phaseCapacity": obj({key: number for key in ("powerplay", "middle", "death")}),
        }),
        "replacementContext": obj({
            "diagnosticOnly": {"const": True},
            "teamSeasonEvents": replacement_counts_schema,
            "representativeXiEvents": replacement_counts_schema,
        }),
        "reviewFlags": {"type": "array", "uniqueItems": True, "items": string},
    })
    heuristic = obj({
        "qualityZ": number, "historicalPerformanceZ": number, "candidateScore": number,
        "weights": obj({"v2Quality": {"const": 0.7}, "historicalPerformance": {"const": 0.3}}),
        "advisoryOnly": {"const": True},
    })
    candidate_properties = {
        "schemaVersion": {"const": CANDIDATE_SCHEMA_VERSION},
        "contentStatus": {"const": "GENERATED_CANDIDATE"},
        "profileTerminology": {"const": PROFILE_TERMINOLOGY},
        "candidateId": string, "eraId": {"enum": list(ERA_IDS)}, "franchiseId": string,
        "franchiseName": string, "teamId": string, "teamName": string, "seasonId": string,
        "historical": historical, "xi": xi, "evaluation": strength,
        "diagnostics": diagnostics, "selectionHeuristic": heuristic,
    }
    candidate = obj(candidate_properties)
    review_candidate = obj({
        "advisoryRank": {"type": "integer", "minimum": 1},
        "candidateId": string, "teamId": string, "teamName": string, "seasonId": string,
        "historical": historical, "evaluation": strength, "selectionHeuristic": heuristic,
        "diagnostics": diagnostics, "xi": xi,
    })
    packet = obj({
        "eraId": {"enum": list(ERA_IDS[1:])}, "franchiseId": string, "franchiseName": string,
        "profileTerminology": {"const": PROFILE_TERMINOLOGY}, "reviewStatus": {"const": "PENDING"},
        "selectedCandidateId": {"type": "null"}, "reviewerRationale": {"type": "null"},
        "reviewedOn": {"type": "null"}, "candidateCount": {"type": "integer", "minimum": 1},
        "candidatesInAdvisoryOrder": {"type": "array", "minItems": 1, "items": review_candidate},
    })
    file_entry = obj({
        "path": string, "sha256": hash_string, "sizeBytes": integer,
        "rows": {"type": ["integer", "null"], "minimum": 0}, "schemaVersion": string,
    })
    input_entry = obj({"path": string, "sha256": hash_string, "sizeBytes": integer})
    foundation_parity = obj({
        "fixturePath": string, "fixtureSha256": hash_string,
        "opponentArtifactSha256": {"const": FOUNDATION_OPPONENT_SHA256},
        "simulationCompatibilityFingerprint": {"const": FOUNDATION_SIMULATION_COMPATIBILITY_FINGERPRINT},
        "candidateRepresentationExact": {"const": True}, "approvedProfilesExact": {"const": True},
        "eraEnvironmentsExact": {"const": True},
    })
    review_counts = obj({
        "foundationApproved": {"const": 8}, "laterEraPending": {"const": 41},
        "laterEraApproved": {"const": 0},
    })
    return {
        "all_era_opponent_candidates.schema.json": {"$schema": SCHEMA_DRAFT, **obj({
            "schemaVersion": {"const": PHASE1_VERSION},
            "selectionPolicy": {"const": "advisory-70-30-human-freeze-required"},
            "profileTerminology": {"const": PROFILE_TERMINOLOGY},
            "candidateCountsByEra": counts,
            "candidates": {"type": "array", "minItems": 166, "maxItems": 166, "items": candidate},
        })},
        "later_era_opponent_review_packets.schema.json": {"$schema": SCHEMA_DRAFT, **obj({
            "schemaVersion": {"const": REVIEW_PACKET_SCHEMA_VERSION},
            "profileTerminology": {"const": PROFILE_TERMINOLOGY},
            "reviewPolicy": {"const": "human-selection-required-no-generated-approval"},
            "pendingLineageDecisions": {"const": 41},
            "lineageCountsByEra": counts,
            "packets": {"type": "array", "minItems": 41, "maxItems": 41, "items": packet},
        })},
        "stage9a_phase1_manifest.schema.json": {"$schema": SCHEMA_DRAFT, **obj({
            "schemaVersion": {"const": PHASE1_MANIFEST_SCHEMA_VERSION},
            "contentVersion": {"const": PHASE1_VERSION}, "trackingIssue": string,
            "profileTerminology": {"const": PROFILE_TERMINOLOGY},
            "foundationSimulationCompatibilityFingerprint": {"const": FOUNDATION_SIMULATION_COMPATIBILITY_FINGERPRINT},
            "inputs": {"type": "array", "minItems": 1, "items": input_entry},
            "artifacts": {"type": "array", "minItems": 2, "items": file_entry},
            "schemaFiles": {"type": "array", "minItems": 4, "items": file_entry},
            "candidateCountsByEra": counts, "lineageCountsByEra": counts,
            "reviewStatusCounts": review_counts, "opponentContentDataAggregateHash": hash_string,
            "phase1ManifestHash": hash_string,
        })},
        "stage9a_phase1_validation_report.schema.json": {"$schema": SCHEMA_DRAFT, **obj({
            "schemaVersion": {"const": PHASE1_VALIDATION_SCHEMA_VERSION},
            "contentVersion": {"const": PHASE1_VERSION}, "status": {"const": "PASSED"},
            "phase1ManifestHash": hash_string, "candidateCountsByEra": counts,
            "lineageCountsByEra": counts, "totalCandidates": {"const": 166},
            "totalLineages": {"const": 49}, "reviewStatusCounts": review_counts,
            "foundationParity": foundation_parity,
            "deterministicContracts": obj({
                "candidateOrdering": {"const": "teamId-seasonId"},
                "xiSelectionTieBreak": {"const": "playerTeamSeasonId"},
                "reviewPacketOrdering": {"const": "eraId-franchiseId"},
                "advisoryCandidateOrdering": {"const": "score-desc-candidateId"},
            }),
        })},
    }


def _input_entry(path: Path) -> dict[str, Any]:
    content = path.read_bytes()
    return {"path": str(path.relative_to(ROOT)), "sha256": bytes_sha256(content), "sizeBytes": len(content)}


def _expected_lineages(eras: list[dict[str, Any]], franchises: list[dict[str, Any]]) -> dict[str, set[str]]:
    return {
        era["eraId"]: {
            franchise["franchiseId"] for franchise in franchises
            if set(franchise["activeSeasonIds"]) & set(era["seasonIds"])
        }
        for era in eras
    }


def _review_packets(candidates: list[dict[str, Any]], franchises: list[dict[str, Any]]) -> list[dict[str, Any]]:
    franchise_by_id = {item["franchiseId"]: item for item in franchises}
    groups: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for candidate in candidates:
        if candidate["eraId"] != "era-foundation":
            groups[(candidate["eraId"], candidate["franchiseId"])].append(candidate)
    packets = []
    for (era_id, franchise_id), group in sorted(groups.items()):
        ordered = sorted(group, key=lambda item: (-item["selectionHeuristic"]["candidateScore"], item["candidateId"]))
        packets.append({
            "eraId": era_id, "franchiseId": franchise_id,
            "franchiseName": franchise_by_id[franchise_id]["canonicalName"],
            "profileTerminology": PROFILE_TERMINOLOGY, "reviewStatus": "PENDING",
            "selectedCandidateId": None, "reviewerRationale": None, "reviewedOn": None,
            "candidateCount": len(ordered),
            "candidatesInAdvisoryOrder": [{
                "advisoryRank": rank, "candidateId": candidate["candidateId"],
                "teamId": candidate["teamId"], "teamName": candidate["teamName"],
                "seasonId": candidate["seasonId"], "historical": candidate["historical"],
                "evaluation": candidate["evaluation"], "selectionHeuristic": candidate["selectionHeuristic"],
                "diagnostics": candidate["diagnostics"],
                "xi": candidate["xi"],
            } for rank, candidate in enumerate(ordered, 1)],
        })
    return packets


def build_phase1_files() -> tuple[dict[str, bytes], dict[str, Any]]:
    era_path = ROOT / "data/registries/ipl/v1/eras.json"
    team_path = ROOT / "data/registries/ipl/v1/teams.json"
    franchise_path = ROOT / "data/registries/ipl/v1/franchises.json"
    era_doc, team_doc, franchise_doc = document(era_path), document(team_path), document(franchise_path)
    roles, quality, roster = rows(ROLES_PATH), rows(QUALITY_PATH), rows(ROSTER_PATH)
    analytics_players = rows(ANALYTICS / "player_team_seasons.jsonl")
    team_seasons, matches = rows(ANALYTICS / "team_seasons.jsonl"), rows(ANALYTICS / "match_summaries.jsonl")
    candidates = candidate_rows(
        roles, quality, roster, analytics_players, team_seasons, matches,
        era_doc["eras"], team_doc["teams"], franchise_doc["franchises"],
    )
    candidate_counts = {era_id: sum(item["eraId"] == era_id for item in candidates) for era_id in ERA_IDS}
    if candidate_counts != EXPECTED_CANDIDATES:
        raise ValueError(f"Stage 9A candidate baseline drift: {candidate_counts}")
    expected_lineages = _expected_lineages(era_doc["eras"], franchise_doc["franchises"])
    actual_lineages = {
        era_id: {item["franchiseId"] for item in candidates if item["eraId"] == era_id}
        for era_id in ERA_IDS
    }
    if actual_lineages != expected_lineages:
        raise ValueError("Candidate lineage coverage differs from the canonical franchise registry")
    lineage_counts = {era_id: len(actual_lineages[era_id]) for era_id in ERA_IDS}
    if lineage_counts != EXPECTED_LINEAGES:
        raise ValueError(f"Stage 9A lineage baseline drift: {lineage_counts}")

    foundation_candidates = [legacy_candidate_view(item) for item in candidates if item["eraId"] == "era-foundation"]
    frozen_candidate_doc = document(OUTPUT / "foundation_opponent_candidates.json")
    recomputed_candidate_doc = {
        "schemaVersion": VERSION, "selectionPolicy": "advisory-70-30", "candidates": foundation_candidates,
    }
    if recomputed_candidate_doc != frozen_candidate_doc:
        raise ValueError("Generic candidate generation changed the frozen Foundation representation")
    frozen_profile_doc = document(OUTPUT / "foundation_opponents.json")
    recomputed_profile_doc = {
        "schemaVersion": VERSION, "eraId": "era-foundation",
        "opponents": reviewed_profiles(foundation_candidates),
    }
    if recomputed_profile_doc != frozen_profile_doc:
        raise ValueError("Generic candidate generation changed frozen Foundation approved content")
    recomputed_environments = {"schemaVersion": VERSION, "environments": environment_rows(era_doc["eras"], matches)}
    if recomputed_environments != document(OUTPUT / "era_environments.json"):
        raise ValueError("Stage 9A changed frozen era environments")
    if sha256(OUTPUT / "foundation_opponents.json") != FOUNDATION_OPPONENT_SHA256:
        raise ValueError("Frozen Foundation opponent artifact hash changed")

    fixture_path = ROOT / "tests/fixtures/stage9a/foundation_stage8_parity.json"
    fixture = document(fixture_path)
    if fixture["foundationOpponentArtifact"]["sha256"] != FOUNDATION_OPPONENT_SHA256:
        raise ValueError("Foundation parity fixture records the wrong artifact hash")
    if fixture["capturedFrom"]["foundationSimulationCompatibilityFingerprint"] != FOUNDATION_SIMULATION_COMPATIBILITY_FINGERPRINT:
        raise ValueError("Foundation parity fixture records the wrong simulation compatibility fingerprint")
    runtime_profiles = sorted(frozen_profile_doc["opponents"], key=lambda item: item["candidateId"])
    if [item["candidateId"] for item in runtime_profiles] != fixture["runtimeProfileIds"]:
        raise ValueError("Foundation runtime profile ordering changed from the golden fixture")

    packets = _review_packets(candidates, franchise_doc["franchises"])
    if len(packets) != 41 or any(packet["reviewStatus"] != "PENDING" for packet in packets):
        raise ValueError("All 41 later-era lineage decisions must remain PENDING")
    candidate_doc = {
        "schemaVersion": PHASE1_VERSION,
        "selectionPolicy": "advisory-70-30-human-freeze-required",
        "profileTerminology": PROFILE_TERMINOLOGY,
        "candidateCountsByEra": candidate_counts, "candidates": candidates,
    }
    packet_doc = {
        "schemaVersion": REVIEW_PACKET_SCHEMA_VERSION, "profileTerminology": PROFILE_TERMINOLOGY,
        "reviewPolicy": "human-selection-required-no-generated-approval",
        "pendingLineageDecisions": 41, "lineageCountsByEra": lineage_counts,
        "packets": packets,
    }
    schemas = phase1_schema_documents()
    validate_instance(candidate_doc, schemas["all_era_opponent_candidates.schema.json"])
    validate_instance(packet_doc, schemas["later_era_opponent_review_packets.schema.json"])
    files: dict[str, bytes] = {
        "all_era_opponent_candidates.json": pretty_json_bytes(candidate_doc),
        "later_era_opponent_review_packets.json": pretty_json_bytes(packet_doc),
    }
    for name, schema in schemas.items():
        files[f"schemas/{name}"] = pretty_json_bytes(schema)
    artifact_entries = [
        artifact_entry("all_era_opponent_candidates.json", files["all_era_opponent_candidates.json"], PHASE1_VERSION, 166),
        artifact_entry("later_era_opponent_review_packets.json", files["later_era_opponent_review_packets.json"], REVIEW_PACKET_SCHEMA_VERSION, 41),
    ]
    schema_entries = [
        artifact_entry(path, content, "json-schema/2020-12", None)
        for path, content in sorted(files.items()) if path.startswith("schemas/")
    ]
    input_paths = [
        ROOT / "data/registries/ipl/v1/registry_manifest.json", era_path, team_path, franchise_path,
        ANALYTICS / "analytical_manifest.json", ANALYTICS / "match_summaries.jsonl",
        ANALYTICS / "team_seasons.jsonl", ANALYTICS / "player_team_seasons.jsonl",
        ROOT / "data/processed/era-draft/roles/v1/role_manifest.json", ROLES_PATH,
        ROOT / "data/processed/era-draft/quality/v1/quality_manifest.json", QUALITY_PATH,
        ROOT / "data/metadata/ipl/country_overseas/v1/metadata_manifest.json", ROSTER_PATH,
        ROOT / "data/metadata/ipl/v1/metadata_manifest.json",
        ROOT / "data/metadata/ipl/v1/player_capabilities.jsonl",
        ROOT / "data/metadata/ipl/v1/player_team_season_usage.jsonl", REVIEW_PATH,
        OUTPUT / "foundation_opponent_candidates.json", OUTPUT / "foundation_opponents.json",
        OUTPUT / "era_environments.json", fixture_path,
    ]
    review_counts = {"foundationApproved": 8, "laterEraPending": 41, "laterEraApproved": 0}
    manifest = {
        "schemaVersion": PHASE1_MANIFEST_SCHEMA_VERSION, "contentVersion": PHASE1_VERSION,
        "trackingIssue": "https://github.com/AviSharma01/draft-simulator/issues/8",
        "profileTerminology": PROFILE_TERMINOLOGY,
        "foundationSimulationCompatibilityFingerprint": FOUNDATION_SIMULATION_COMPATIBILITY_FINGERPRINT,
        "inputs": [_input_entry(path) for path in input_paths],
        "artifacts": artifact_entries, "schemaFiles": schema_entries,
        "candidateCountsByEra": candidate_counts, "lineageCountsByEra": lineage_counts,
        "reviewStatusCounts": review_counts, "opponentContentDataAggregateHash": aggregate_hash(files),
    }
    manifest["phase1ManifestHash"] = bytes_sha256(canonical_json_bytes(manifest))
    validate_instance(manifest, schemas["stage9a_phase1_manifest.schema.json"])
    files["stage9a_phase1_manifest.json"] = pretty_json_bytes(manifest)
    validation = {
        "schemaVersion": PHASE1_VALIDATION_SCHEMA_VERSION, "contentVersion": PHASE1_VERSION,
        "status": "PASSED", "phase1ManifestHash": manifest["phase1ManifestHash"],
        "candidateCountsByEra": candidate_counts, "lineageCountsByEra": lineage_counts,
        "totalCandidates": 166, "totalLineages": 49, "reviewStatusCounts": review_counts,
        "foundationParity": {
            "fixturePath": str(fixture_path.relative_to(ROOT)), "fixtureSha256": sha256(fixture_path),
            "opponentArtifactSha256": FOUNDATION_OPPONENT_SHA256,
            "simulationCompatibilityFingerprint": FOUNDATION_SIMULATION_COMPATIBILITY_FINGERPRINT,
            "candidateRepresentationExact": True, "approvedProfilesExact": True,
            "eraEnvironmentsExact": True,
        },
        "deterministicContracts": {
            "candidateOrdering": "teamId-seasonId", "xiSelectionTieBreak": "playerTeamSeasonId",
            "reviewPacketOrdering": "eraId-franchiseId",
            "advisoryCandidateOrdering": "score-desc-candidateId",
        },
    }
    validate_instance(validation, schemas["stage9a_phase1_validation_report.schema.json"])
    files["stage9a_phase1_validation_report.json"] = pretty_json_bytes(validation)
    return files, {"candidates": candidates, "packets": packets, "manifest": manifest, "validation": validation}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--propose", action="store_true", help="Print advisory-ranked candidates without approving them")
    parser.add_argument("--era", choices=ERA_IDS, help="Limit --propose output to one era")
    args = parser.parse_args()
    files, result = build_phase1_files()
    if args.propose:
        candidates = [item for item in result["candidates"] if not args.era or item["eraId"] == args.era]
        groups: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
        for candidate in candidates:
            groups[(candidate["eraId"], candidate["franchiseId"])].append(candidate)
        print(json.dumps({
            "notice": "Advisory generated evidence only; no candidate is selected or approved.",
            "lineages": [{
                "eraId": key[0], "franchiseId": key[1],
                "candidates": sorted(value, key=lambda item: (-item["selectionHeuristic"]["candidateScore"], item["candidateId"])),
            } for key, value in sorted(groups.items())],
        }, indent=2, sort_keys=True))
        return
    for file_name, content in files.items():
        destination = OUTPUT / file_name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(content)


if __name__ == "__main__":
    main()
