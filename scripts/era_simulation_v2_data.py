#!/usr/bin/env python3
"""Build deterministic Stage 7 era environments and reviewed opponent profiles."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import statistics
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable

from scripts.identity_registry.schemas import SCHEMA_DRAFT, validate_instance

ROOT = Path(__file__).resolve().parents[1]
ANALYTICS = ROOT / "data/analytical/cricsheet-ipl/v1"
ROLES_PATH = ROOT / "data/processed/era-draft/roles/v1/player_role_consumer.jsonl"
QUALITY_PATH = ROOT / "data/processed/era-draft/quality/v1/player_quality_consumer.jsonl"
ROSTER_PATH = ROOT / "data/metadata/ipl/country_overseas/v1/player_team_season_metadata.jsonl"
REVIEW_PATH = ROOT / "data/manual/era-simulation/v2/foundation_opponents.json"
OUTPUT = ROOT / "data/processed/era-draft/simulation/v2"
VERSION = "ipl-era-simulation/v2"
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


def candidate_rows(
    roles: list[dict[str, Any]], quality: list[dict[str, Any]], roster: list[dict[str, Any]],
    analytics_players: list[dict[str, Any]], team_seasons: list[dict[str, Any]], matches: list[dict[str, Any]],
    teams: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    quality_by_id = {item["playerTeamSeasonId"]: item for item in quality}
    roster_by_id = {item["playerTeamSeasonId"]: item for item in roster}
    analytics_by_id = {item["playerTeamSeasonId"]: item for item in analytics_players}
    team_names = {item["teamId"]: item["canonicalName"] for item in teams}
    pools: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for role in roles:
        if role["seasonId"] not in {"ipl-2008", "ipl-2009", "ipl-2010"}:
            continue
        pts_id = role["playerTeamSeasonId"]
        q = quality_by_id[pts_id]
        r = roster_by_id[pts_id]
        a = analytics_by_id[pts_id]
        pools[(role["teamId"], role["seasonId"])].append({
            "playerTeamSeasonId": pts_id, "playerId": role["playerId"],
            "canonicalDisplayName": role["canonicalDisplayName"], "role": role, "quality": q,
            "rosterStatus": r["iplRosterStatus"],
            "officialListMatchCount": a["participation"]["officialListMatchCount"],
            "overallRating": q["overall"]["overallRating"],
            "keeper": role["keeperMetadata"]["capabilityStatus"] == "CONFIRMED",
        })
    season_by_key = {(item["teamId"], item["seasonId"]): item for item in team_seasons}
    candidates = []
    for (team_id, season_id), pool in sorted(pools.items()):
        chosen = order_eleven(choose_eleven(pool))
        team = season_by_key[(team_id, season_id)]
        games = team["results"]["wins"] + team["results"]["losses"] + team["results"]["ties"] + team["results"]["noResults"]
        points_pct = (2 * team["results"]["wins"] + team["results"]["ties"] + team["results"]["noResults"]) / (2 * games)
        candidates.append({
            "candidateId": f"opponent:{team_id}:{season_id}", "eraId": "era-foundation", "franchiseId": pool[0]["role"]["franchiseId"],
            "teamId": team_id, "teamName": team_names[team_id], "seasonId": season_id,
            "historical": {"pointsPercentage": rounded(points_pct), "netRunRate": rounded(nrr_for_team(team_id, season_id, matches))},
            "xi": [{
                "position": position, "playerTeamSeasonId": player["playerTeamSeasonId"],
                "playerId": player["playerId"], "displayName": player["canonicalDisplayName"],
                "rosterStatus": player["rosterStatus"], "officialListMatchCount": player["officialListMatchCount"],
            } for position, player in enumerate(chosen, 1)],
            "evaluation": evaluation(chosen),
        })
    quality_z = zscores([candidate["evaluation"]["overall"] for candidate in candidates])
    performance_z: dict[str, float] = {}
    for season_id in {candidate["seasonId"] for candidate in candidates}:
        group = [candidate for candidate in candidates if candidate["seasonId"] == season_id]
        points_z = zscores([candidate["historical"]["pointsPercentage"] for candidate in group])
        nrr_z = zscores([candidate["historical"]["netRunRate"] for candidate in group])
        for candidate, pz, nz in zip(group, points_z, nrr_z):
            performance_z[candidate["candidateId"]] = 0.7 * pz + 0.3 * nz
    for candidate, qz in zip(candidates, quality_z):
        pz = performance_z[candidate["candidateId"]]
        candidate["selectionHeuristic"] = {
            "qualityZ": rounded(qz), "historicalPerformanceZ": rounded(pz),
            "candidateScore": rounded(0.7 * qz + 0.3 * pz), "weights": {"v2Quality": 0.7, "historicalPerformance": 0.3},
        }
    return candidates


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


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--propose", action="store_true", help="Print the highest heuristic candidate per Foundation lineage")
    args = parser.parse_args()
    era_doc = document(ROOT / "data/registries/ipl/v1/eras.json")
    team_doc = document(ROOT / "data/registries/ipl/v1/teams.json")
    matches = rows(ANALYTICS / "match_summaries.jsonl")
    candidates = candidate_rows(
        rows(ROLES_PATH), rows(QUALITY_PATH), rows(ROSTER_PATH),
        rows(ANALYTICS / "player_team_seasons.jsonl"), rows(ANALYTICS / "team_seasons.jsonl"), matches,
        team_doc["teams"],
    )
    if args.propose:
        best = {}
        for candidate in candidates:
            prior = best.get(candidate["franchiseId"])
            if prior is None or candidate["selectionHeuristic"]["candidateScore"] > prior["selectionHeuristic"]["candidateScore"]:
                best[candidate["franchiseId"]] = candidate
        print(json.dumps([best[key] for key in sorted(best)], indent=2, sort_keys=True))
        return
    environments = environment_rows(era_doc["eras"], matches)
    profiles = reviewed_profiles(candidates)
    artifacts = {
        "era_environments.json": {"schemaVersion": VERSION, "environments": environments},
        "foundation_opponent_candidates.json": {"schemaVersion": VERSION, "selectionPolicy": "advisory-70-30", "candidates": candidates},
        "foundation_opponents.json": {"schemaVersion": VERSION, "eraId": "era-foundation", "opponents": profiles},
    }
    inputs = [ROOT / "data/registries/ipl/v1/eras.json", ANALYTICS / "match_summaries.jsonl", ANALYTICS / "team_seasons.jsonl", ANALYTICS / "player_team_seasons.jsonl", ROLES_PATH, QUALITY_PATH, ROSTER_PATH, REVIEW_PATH]
    artifacts["manifest.json"] = {
        "schemaVersion": VERSION, "opponentContentEraIds": ["era-foundation"],
        "inputHashes": {str(path.relative_to(ROOT)): sha256(path) for path in inputs},
        "outputCounts": {"environments": len(environments), "foundationCandidates": len(candidates), "foundationOpponents": len(profiles)},
    }
    schemas = schema_documents()
    for file_name, artifact in artifacts.items():
        validate_instance(artifact, schemas[file_name.replace(".json", ".schema.json")])
        write_json(OUTPUT / file_name, artifact)
    for file_name, schema in schemas.items():
        write_json(OUTPUT / "schemas" / file_name, schema)


if __name__ == "__main__":
    main()
