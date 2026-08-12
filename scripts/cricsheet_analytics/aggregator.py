from __future__ import annotations

from collections import Counter, defaultdict
from copy import deepcopy
from decimal import Decimal
from statistics import median
from typing import Any, Iterable


ANALYTICS_DATASET_VERSION = "cricsheet-ipl-analytics/v1"
PHASE_DEFINITION_VERSION = "ipl-fixed-phases/v1"
ROW_SCHEMA_VERSIONS = {
    "matchSummaries": "cricsheet-ipl-match-summary/v1",
    "playerTeamSeasons": "cricsheet-ipl-player-team-season/v1",
    "teamSeasons": "cricsheet-ipl-team-season/v1",
    "seasonEnvironments": "cricsheet-ipl-season-environment/v1",
    "venueSeasonEnvironments": "cricsheet-ipl-venue-season-environment/v1",
}
PHASES = ("powerplay", "middle", "death")
COHORTS = ("standard", "adjusted", "incomplete_or_no_result")
BASELINE_COUNTS = {
    "matchSummaries": 1243,
    "playerTeamSeasons": 3392,
    "teamSeasons": 166,
    "seasonEnvironments": 19,
    "venueSeasonEnvironments": 198,
}


class AnalyticalAggregationError(ValueError):
    pass


def player_team_season_id(player_id: str, season_id: str, team_id: str) -> str:
    for value in (player_id, season_id, team_id):
        if not value or ":" in value:
            raise AnalyticalAggregationError(f"Invalid canonical ID component: {value!r}")
    return f"pts:{player_id}:{season_id}:{team_id}"


def team_season_id(team_id: str, season_id: str) -> str:
    if not team_id or not season_id or ":" in team_id or ":" in season_id:
        raise AnalyticalAggregationError("Invalid team-season ID component")
    return f"ts:{team_id}:{season_id}"


def fixed_phase(source_over_number: int) -> str:
    if 0 <= source_over_number <= 5:
        return "powerplay"
    if 6 <= source_over_number <= 15:
        return "middle"
    if 16 <= source_over_number <= 19:
        return "death"
    raise AnalyticalAggregationError(f"Normal IPL over outside fixed phase definition: {source_over_number}")


def cricket_overs_to_balls(value: int | float) -> int:
    decimal = Decimal(str(value))
    whole = int(decimal)
    fractional = (decimal - whole) * 10
    if fractional != fractional.to_integral_value() or not 0 <= fractional <= 5:
        raise AnalyticalAggregationError(f"Invalid cricket overs notation: {value!r}")
    return whole * 6 + int(fractional)


def _bat() -> dict[str, int]:
    return {key: 0 for key in ("runs", "balls", "dismissals", "fours", "sixes", "boundaryBalls", "dotBalls")}


def _bowl() -> dict[str, int]:
    return {key: 0 for key in ("deliveryRecords", "legalBalls", "runsConceded", "creditedWickets", "dotBalls")}


def _team_metric() -> dict[str, Any]:
    return {
        "innings": 0,
        "runs": 0,
        "batterRuns": 0,
        "deliveryRecords": 0,
        "legalBalls": 0,
        "batterBalls": 0,
        "dismissals": 0,
        "creditedWickets": 0,
        "fours": 0,
        "sixes": 0,
        "boundaryBalls": 0,
        "battingDotBalls": 0,
        "bowlingDotBalls": 0,
        "extras": {key: 0 for key in ("byes", "legByes", "noBalls", "penalty", "wides")},
    }


def _phased(factory: Any) -> dict[str, Any]:
    return {phase: factory() for phase in PHASES}


def _add_numbers(target: dict[str, Any], source: dict[str, Any]) -> None:
    for key, value in source.items():
        if isinstance(value, dict):
            _add_numbers(target[key], value)
        elif isinstance(value, int):
            target[key] += value


def _bat_rates(metric: dict[str, int]) -> dict[str, float | None]:
    balls = metric["balls"]
    dismissals = metric["dismissals"]
    return {
        "average": round(metric["runs"] / dismissals, 6) if dismissals else None,
        "strikeRate": round(100 * metric["runs"] / balls, 6) if balls else None,
        "boundaryBallRate": round(metric["boundaryBalls"] / balls, 6) if balls else None,
        "dotBallRate": round(metric["dotBalls"] / balls, 6) if balls else None,
    }


def _bowl_rates(metric: dict[str, int], matches: int) -> dict[str, float | None]:
    balls = metric["legalBalls"]
    wickets = metric["creditedWickets"]
    return {
        "economyPerSixBalls": round(6 * metric["runsConceded"] / balls, 6) if balls else None,
        "strikeRate": round(balls / wickets, 6) if wickets else None,
        "dotBallRate": round(metric["dotBalls"] / balls, 6) if balls else None,
        "legalBallsPerBowlingMatch": round(balls / matches, 6) if matches else None,
    }


def _official_powerplay(delivery_label: str, intervals: list[dict[str, Any]]) -> bool:
    value = Decimal(delivery_label)
    return any(Decimal(str(item["from"])) <= value <= Decimal(str(item["to"])) for item in intervals)


def _cohort(match: dict[str, Any], normal_innings: list[dict[str, Any]]) -> str:
    if match["outcome"]["resultType"] == "no_result" or len(normal_innings) != 2:
        return "incomplete_or_no_result"
    revised = any(
        innings["target"] is not None
        and innings["target"]["overs"] != match["competition"]["scheduledOvers"]
        for innings in normal_innings
    )
    if match["outcome"]["method"] is not None or revised:
        return "adjusted"
    return "standard"


def _new_player(participant: dict[str, Any], season_id: str, franchise_id: str) -> dict[str, Any]:
    return {
        "playerTeamSeasonId": player_team_season_id(participant["playerId"], season_id, participant["teamId"]),
        "playerId": participant["playerId"],
        "canonicalDisplayName": participant["canonicalDisplayName"],
        "observedSourceNames": set(participant["observedSourceNames"]),
        "seasonId": season_id,
        "teamId": participant["teamId"],
        "franchiseId": franchise_id,
        "matchContributions": [],
        "batting": {"innings": 0, "totals": _bat(), "positions": Counter(), "phases": _phased(_bat), "officialPowerplay": _bat(), "inningsObservations": []},
        "bowling": {"matches": set(), "innings": 0, "totals": _bowl(), "phases": _phased(_bowl), "officialPowerplay": _bowl(), "inningsObservations": []},
        "fielding": {key: 0 for key in ("catches", "caughtAndBowled", "stumpings", "runOutInvolvements", "substituteFieldingEvents")},
    }


def _new_team(team: dict[str, Any], season_id: str) -> dict[str, Any]:
    return {
        "teamSeasonId": team_season_id(team["teamId"], season_id),
        "teamId": team["teamId"], "franchiseId": team["franchiseId"], "seasonId": season_id,
        "matchIds": [], "playerTeamSeasonIds": set(), "cohortCounts": Counter(),
        "results": Counter(), "eliminator": Counter(), "stages": Counter(),
        "contexts": Counter(), "chaseOutcomes": Counter(),
        "batting": _team_metric(), "bowling": _team_metric(),
        "battingPhases": _phased(_team_metric), "bowlingPhases": _phased(_team_metric),
        "officialPowerplayBatting": _team_metric(), "officialPowerplayBowling": _team_metric(),
        "inningsRuns": [], "inningsDismissals": [],
    }


def _new_environment(group_id: str, season_id: str) -> dict[str, Any]:
    return {
        "groupId": group_id, "seasonId": season_id, "matchIds": set(),
        "cohorts": {name: _new_context() for name in ("all_normal", *COHORTS)},
    }


def _new_context() -> dict[str, Any]:
    return {
        "matchIds": set(), "totals": _team_metric(), "firstInnings": _team_metric(), "chases": _team_metric(),
        "phases": _phased(_team_metric), "officialPowerplay": _team_metric(),
        "inningsRuns": Counter(), "inningsDismissals": Counter(), "chaseOutcomes": Counter(),
    }


def _delivery_team_metric(delivery: dict[str, Any]) -> dict[str, Any]:
    batter_runs = delivery["runs"]["batter"]
    boundary = batter_runs in {4, 6} and not delivery["runs"]["nonBoundary"]
    metric = _team_metric()
    metric.update({
        "runs": delivery["runs"]["total"], "batterRuns": batter_runs, "deliveryRecords": 1,
        "legalBalls": int(delivery["isBowlerLegalDelivery"]), "batterBalls": int(delivery["countsAsBatterBall"]),
        "dismissals": sum(int(w["countsAsBatterDismissal"]) for w in delivery["wickets"]),
        "creditedWickets": sum(int(w["creditedToBowler"]) for w in delivery["wickets"]),
        "fours": int(boundary and batter_runs == 4), "sixes": int(boundary and batter_runs == 6),
        "boundaryBalls": int(boundary),
        "battingDotBalls": int(delivery["countsAsBatterBall"] and delivery["runs"]["total"] == 0),
        "bowlingDotBalls": int(delivery["isBowlerLegalDelivery"] and delivery["runs"]["total"] == 0),
        "extras": dict(delivery["extras"]),
    })
    return metric


def _summarize_innings(innings: dict[str, Any], order: int, scheduled_overs: int) -> dict[str, Any]:
    totals = _team_metric()
    totals["innings"] = 1
    phases = _phased(_team_metric)
    official = _team_metric()
    official["innings"] = 1
    for over in innings["overs"]:
        phase = fixed_phase(over["sourceOverNumber"])
        phases[phase]["innings"] = 1
        for delivery in over["deliveries"]:
            metric = _delivery_team_metric(delivery)
            _add_numbers(totals, metric)
            _add_numbers(phases[phase], metric)
            if _official_powerplay(delivery["actualDelivery"], innings["powerplays"]):
                _add_numbers(official, metric)
    if totals["runs"] != innings["totals"]["runs"] or totals["legalBalls"] != innings["totals"]["bowlerLegalDeliveries"]:
        raise AnalyticalAggregationError(f"Innings totals did not reconcile: {innings['inningsIndex']}")
    target = innings["target"]
    return {
        "inningsIndex": innings["inningsIndex"], "inningsOrder": "first" if order == 1 else "chase",
        "battingTeamId": innings["battingTeamId"], "bowlingTeamId": innings["bowlingTeamId"],
        "target": target, "scheduledQuotaBalls": scheduled_overs * 6,
        "targetQuotaBalls": cricket_overs_to_balls(target["overs"]) if target is not None else None,
        "absentHurtCount": len(innings["absentHurt"]), "hasMiscountedOvers": bool(innings["miscountedOvers"]),
        "totals": totals, "phases": phases, "officialPowerplay": official,
    }


def _participant_actions(participant: dict[str, Any]) -> list[str]:
    evidence = participant["evidence"]
    mapping = {
        "batting": "battingInningsIndexes", "bowling": "bowlingInningsIndexes", "fielding": "fieldingInningsIndexes",
        "substitute_fielding": "substituteFielding", "absent_hurt": "absentHurtInningsIndexes", "review": "reviews",
        "match_replacement_in": "matchReplacementIn", "match_replacement_out": "matchReplacementOut",
        "role_replacement_in": "roleReplacementIn", "role_replacement_out": "roleReplacementOut",
    }
    actions = [label for label, key in mapping.items() if evidence[key]]
    if evidence["playerOfMatch"]:
        actions.append("player_of_match")
    return sorted(actions)


def _profile_for(players: dict[tuple[str, str, str], dict[str, Any]], participant: dict[str, Any], season_id: str, franchise_id: str) -> dict[str, Any]:
    key = (participant["playerId"], season_id, participant["teamId"])
    profile = players.get(key)
    if profile is None:
        profile = _new_player(participant, season_id, franchise_id)
        players[key] = profile
    if profile["franchiseId"] != franchise_id or profile["canonicalDisplayName"] != participant["canonicalDisplayName"]:
        raise AnalyticalAggregationError(f"Player-team-season identity drift: {key}")
    profile["observedSourceNames"].update(participant["observedSourceNames"])
    return profile


def build_analytical_rows(matches: Iterable[tuple[dict[str, Any], dict[str, Any]]]) -> tuple[dict[str, list[dict[str, Any]]], dict[str, Any]]:
    players: dict[tuple[str, str, str], dict[str, Any]] = {}
    teams: dict[tuple[str, str], dict[str, Any]] = {}
    seasons: dict[str, dict[str, Any]] = {}
    venues: dict[tuple[str, str], dict[str, Any]] = {}
    match_rows: list[dict[str, Any]] = []
    stage3_counts = Counter()

    for manifest_entry, match in matches:
        match_id = match["matchId"]
        season_id = match["season"]["seasonId"]
        team_by_id = {team["teamId"]: team for team in match["teams"]}
        normal_innings = [innings for innings in match["innings"] if innings["inningsKind"] == "normal"]
        super_innings = [innings for innings in match["innings"] if innings["inningsKind"] == "super_over"]
        cohort = _cohort(match, normal_innings)
        innings_rows = [_summarize_innings(innings, index + 1, match["competition"]["scheduledOvers"]) for index, innings in enumerate(normal_innings)]
        revised = any(row["targetQuotaBalls"] is not None and row["targetQuotaBalls"] != row["scheduledQuotaBalls"] for row in innings_rows)
        match_row = {
            "schemaVersion": ROW_SCHEMA_VERSIONS["matchSummaries"], "datasetVersion": ANALYTICS_DATASET_VERSION,
            "matchId": match_id, "normalizedMatchSha256": manifest_entry["sha256"], "seasonId": season_id,
            "dates": list(match["dates"]), "stage": match["event"]["stage"], "cohort": cohort,
            "isDls": match["outcome"]["method"] == "D/L", "hasRevisedTarget": revised,
            "superOverInnings": len(super_innings),
            "venue": {key: match["venue"][key] for key in ("venueId", "venueSiteId", "canonicalName", "canonicalCity", "country")},
            "teams": [{key: team[key] for key in ("teamId", "franchiseId")} for team in match["teams"]],
            "outcome": {key: match["outcome"][key] for key in ("resultType", "winnerTeamId", "eliminatorWinnerTeamId", "method")},
            "normalInnings": innings_rows,
        }
        match_rows.append(match_row)
        stage3_counts["matches"] += 1
        stage3_counts["normalInnings"] += len(normal_innings)
        stage3_counts["superOverInnings"] += len(super_innings)

        contribution_by_player: dict[tuple[str, str], dict[str, Any]] = {}
        for participant in match["participants"]:
            team = team_by_id[participant["teamId"]]
            profile = _profile_for(players, participant, season_id, team["franchiseId"])
            actions = _participant_actions(participant)
            evidence = participant["evidence"]
            contribution = {
                "matchId": match_id, "officialListed": participant["sourceListStatus"] == "official_listed",
                "eventOnly": participant["sourceListStatus"] == "event_only", "recordedActions": actions,
                "recordedFieldingOnly": bool(set(actions) & {"fielding", "substitute_fielding"}) and not bool(set(actions) & {"batting", "bowling"}),
                "normalBattingInnings": 0, "normalBowlingInnings": 0, "superOverAction": any(
                    index in {item["inningsIndex"] for item in super_innings}
                    for index in evidence["battingInningsIndexes"] + evidence["bowlingInningsIndexes"] + evidence["fieldingInningsIndexes"]
                ),
                "replacementEvents": {key: 0 for key in ("impactIn", "impactOut", "concussionIn", "concussionOut", "roleIn", "roleOut")},
                "superOverEvents": {key: 0 for key in ("impactIn", "impactOut", "concussionIn", "concussionOut", "roleIn", "roleOut", "substituteFielding")},
            }
            profile["matchContributions"].append(contribution)
            contribution_by_player[(participant["teamId"], participant["playerId"])] = contribution

        for innings in super_innings:
            for over in innings["overs"]:
                for delivery in over["deliveries"]:
                    for wicket in delivery["wickets"]:
                        for fielder in wicket["fielders"]:
                            if fielder["isSubstitute"]:
                                contribution_by_player[(innings["bowlingTeamId"], fielder["playerId"])]["superOverEvents"]["substituteFielding"] += 1
                    for replacement in delivery["replacements"]["match"]:
                        prefix = "impact" if replacement["reason"] == "impact_player" else "concussion"
                        contribution_by_player[(replacement["teamId"], replacement["in"]["playerId"])]["superOverEvents"][prefix + "In"] += 1
                        contribution_by_player[(replacement["teamId"], replacement["out"]["playerId"])]["superOverEvents"][prefix + "Out"] += 1
                    for replacement in delivery["replacements"]["role"]:
                        contribution_by_player[(replacement["teamId"], replacement["in"]["playerId"])]["superOverEvents"]["roleIn"] += 1
                        if replacement["out"] is not None:
                            contribution_by_player[(replacement["teamId"], replacement["out"]["playerId"])]["superOverEvents"]["roleOut"] += 1

        for innings, innings_row in zip(normal_innings, innings_rows):
            batting_order: list[str] = []
            batting_seen: set[str] = set()
            batting_observations: dict[str, dict[str, Any]] = {}
            bowling_observations: dict[str, dict[str, Any]] = {}
            before_runs = before_dismissals = before_legal = 0
            for over in innings["overs"]:
                phase = fixed_phase(over["sourceOverNumber"])
                for delivery in over["deliveries"]:
                    for ref in (delivery["batter"], delivery["nonStriker"]):
                        player_id = ref["playerId"]
                        if player_id not in batting_seen:
                            batting_seen.add(player_id); batting_order.append(player_id)
                            if len(batting_order) > 11:
                                raise AnalyticalAggregationError(f"Observed batting position exceeds 11 in {match_id}")
                            participant = next(p for p in match["participants"] if p["teamId"] == innings["battingTeamId"] and p["playerId"] == player_id)
                            profile = _profile_for(players, participant, season_id, team_by_id[innings["battingTeamId"]]["franchiseId"])
                            observation = {
                                "matchId": match_id, "inningsIndex": innings["inningsIndex"], "position": len(batting_order),
                                "entry": {"sourceOverNumber": over["sourceOverNumber"], "sourceDeliveryIndex": delivery["sourceDeliveryIndex"], "actualDelivery": delivery["actualDelivery"], "teamRunsBefore": before_runs, "teamDismissalsBefore": before_dismissals, "legalBallsBefore": before_legal},
                                "totals": _bat(), "phases": _phased(_bat), "officialPowerplay": _bat(),
                            }
                            profile["batting"]["innings"] += 1
                            profile["batting"]["positions"][len(batting_order)] += 1
                            profile["batting"]["inningsObservations"].append(observation)
                            batting_observations[player_id] = observation
                            contribution_by_player[(innings["battingTeamId"], player_id)]["normalBattingInnings"] += 1
                    batter_id = delivery["batter"]["playerId"]
                    batter_profile = players[(batter_id, season_id, innings["battingTeamId"])]
                    boundary = delivery["runs"]["batter"] in {4, 6} and not delivery["runs"]["nonBoundary"]
                    bm = _bat()
                    bm.update({
                        "runs": delivery["runs"]["batter"], "balls": int(delivery["countsAsBatterBall"]),
                        "dismissals": 0,
                        "fours": int(boundary and delivery["runs"]["batter"] == 4), "sixes": int(boundary and delivery["runs"]["batter"] == 6),
                        "boundaryBalls": int(boundary), "dotBalls": int(delivery["countsAsBatterBall"] and delivery["runs"]["total"] == 0),
                    })
                    _add_numbers(batter_profile["batting"]["totals"], bm); _add_numbers(batter_profile["batting"]["phases"][phase], bm)
                    _add_numbers(batting_observations[batter_id]["totals"], bm); _add_numbers(batting_observations[batter_id]["phases"][phase], bm)
                    if _official_powerplay(delivery["actualDelivery"], innings["powerplays"]):
                        _add_numbers(batter_profile["batting"]["officialPowerplay"], bm); _add_numbers(batting_observations[batter_id]["officialPowerplay"], bm)

                    for wicket in delivery["wickets"]:
                        if not wicket["countsAsBatterDismissal"]:
                            continue
                        out_id = wicket["playerOut"]["playerId"]
                        if out_id not in batting_observations:
                            raise AnalyticalAggregationError(f"Dismissed player lacks a batting-order observation in {match_id}")
                        out_profile = players[(out_id, season_id, innings["battingTeamId"])]
                        dismissal_metric = _bat(); dismissal_metric["dismissals"] = 1
                        _add_numbers(out_profile["batting"]["totals"], dismissal_metric)
                        _add_numbers(out_profile["batting"]["phases"][phase], dismissal_metric)
                        _add_numbers(batting_observations[out_id]["totals"], dismissal_metric)
                        _add_numbers(batting_observations[out_id]["phases"][phase], dismissal_metric)
                        if _official_powerplay(delivery["actualDelivery"], innings["powerplays"]):
                            _add_numbers(out_profile["batting"]["officialPowerplay"], dismissal_metric)
                            _add_numbers(batting_observations[out_id]["officialPowerplay"], dismissal_metric)

                    bowler_id = delivery["bowler"]["playerId"]
                    bowler_profile = players[(bowler_id, season_id, innings["bowlingTeamId"])]
                    if bowler_id not in bowling_observations:
                        observation = {"matchId": match_id, "inningsIndex": innings["inningsIndex"], "totals": _bowl(), "phases": _phased(_bowl), "officialPowerplay": _bowl()}
                        bowler_profile["bowling"]["innings"] += 1; bowler_profile["bowling"]["matches"].add(match_id)
                        bowler_profile["bowling"]["inningsObservations"].append(observation); bowling_observations[bowler_id] = observation
                        contribution_by_player[(innings["bowlingTeamId"], bowler_id)]["normalBowlingInnings"] += 1
                    conceded = delivery["runs"]["total"] - delivery["extras"]["byes"] - delivery["extras"]["legByes"] - delivery["extras"]["penalty"]
                    bw = _bowl(); bw.update({
                        "deliveryRecords": 1, "legalBalls": int(delivery["isBowlerLegalDelivery"]), "runsConceded": conceded,
                        "creditedWickets": sum(int(w["creditedToBowler"]) for w in delivery["wickets"]),
                        "dotBalls": int(delivery["isBowlerLegalDelivery"] and delivery["runs"]["total"] == 0),
                    })
                    _add_numbers(bowler_profile["bowling"]["totals"], bw); _add_numbers(bowler_profile["bowling"]["phases"][phase], bw)
                    _add_numbers(bowling_observations[bowler_id]["totals"], bw); _add_numbers(bowling_observations[bowler_id]["phases"][phase], bw)
                    if _official_powerplay(delivery["actualDelivery"], innings["powerplays"]):
                        _add_numbers(bowler_profile["bowling"]["officialPowerplay"], bw); _add_numbers(bowling_observations[bowler_id]["officialPowerplay"], bw)

                    for wicket in delivery["wickets"]:
                        for fielder in wicket["fielders"]:
                            fielder_profile = players[(fielder["playerId"], season_id, innings["bowlingTeamId"])]
                            if wicket["kind"] in {"caught", "caught and bowled"}:
                                fielder_profile["fielding"]["catches"] += 1
                            if wicket["kind"] == "caught and bowled": fielder_profile["fielding"]["caughtAndBowled"] += 1
                            if wicket["kind"] == "stumped": fielder_profile["fielding"]["stumpings"] += 1
                            if wicket["kind"] == "run out": fielder_profile["fielding"]["runOutInvolvements"] += 1
                            if fielder["isSubstitute"]: fielder_profile["fielding"]["substituteFieldingEvents"] += 1
                    for replacement in delivery["replacements"]["match"]:
                        prefix = "impact" if replacement["reason"] == "impact_player" else "concussion"
                        contribution_by_player[(replacement["teamId"], replacement["in"]["playerId"])]["replacementEvents"][prefix + "In"] += 1
                        contribution_by_player[(replacement["teamId"], replacement["out"]["playerId"])]["replacementEvents"][prefix + "Out"] += 1
                    for replacement in delivery["replacements"]["role"]:
                        contribution_by_player[(replacement["teamId"], replacement["in"]["playerId"])]["replacementEvents"]["roleIn"] += 1
                        if replacement["out"] is not None:
                            contribution_by_player[(replacement["teamId"], replacement["out"]["playerId"])]["replacementEvents"]["roleOut"] += 1
                    before_runs += delivery["runs"]["total"]
                    before_dismissals += sum(int(w["countsAsBatterDismissal"]) for w in delivery["wickets"])
                    before_legal += int(delivery["isBowlerLegalDelivery"])

        for team in match["teams"]:
            key = (season_id, team["teamId"])
            record = teams.setdefault(key, _new_team(team, season_id))
            record["matchIds"].append(match_id); record["cohortCounts"][cohort] += 1
            record["stages"][match["event"]["stage"] or "unspecified"] += 1
            result_type = match["outcome"]["resultType"]
            if result_type == "win": record["results"]["wins" if match["outcome"]["winnerTeamId"] == team["teamId"] else "losses"] += 1
            else: record["results"]["ties" if result_type == "tie" else "noResults"] += 1
            elim = match["outcome"]["eliminatorWinnerTeamId"]
            if elim is not None: record["eliminator"]["wins" if elim == team["teamId"] else "losses"] += 1
            for participant in match["participants"]:
                if participant["teamId"] == team["teamId"]:
                    record["playerTeamSeasonIds"].add(player_team_season_id(participant["playerId"], season_id, team["teamId"]))
            for row in innings_rows:
                if row["battingTeamId"] == team["teamId"]:
                    context = "battingFirst" if row["inningsOrder"] == "first" else "chasing"
                    record["contexts"][context] += 1; _add_numbers(record["batting"], row["totals"])
                    for phase in PHASES: _add_numbers(record["battingPhases"][phase], row["phases"][phase])
                    _add_numbers(record["officialPowerplayBatting"], row["officialPowerplay"])
                    record["inningsRuns"].append(row["totals"]["runs"]); record["inningsDismissals"].append(row["totals"]["dismissals"])
                    if context == "chasing":
                        if result_type == "win": outcome = "successful" if match["outcome"]["winnerTeamId"] == team["teamId"] else "failed"
                        elif result_type == "tie": outcome = "tie"
                        else: outcome = "no_result"
                        record["chaseOutcomes"][outcome] += 1
                if row["bowlingTeamId"] == team["teamId"]:
                    _add_numbers(record["bowling"], row["totals"])
                    for phase in PHASES: _add_numbers(record["bowlingPhases"][phase], row["phases"][phase])
                    _add_numbers(record["officialPowerplayBowling"], row["officialPowerplay"])

        season_env = seasons.setdefault(season_id, _new_environment(season_id, season_id))
        venue_key = (season_id, match["venue"]["venueSiteId"])
        venue_env = venues.setdefault(venue_key, {**_new_environment(f"vse:{match['venue']['venueSiteId']}:{season_id}", season_id), "venueSiteId": match["venue"]["venueSiteId"], "venueIds": set(), "canonicalNames": set(), "canonicalCities": set(), "countries": set()})
        venue_env["venueIds"].add(match["venue"]["venueId"]); venue_env["canonicalNames"].add(match["venue"]["canonicalName"])
        venue_env["canonicalCities"].add(match["venue"]["canonicalCity"]); venue_env["countries"].add(match["venue"]["country"])
        for environment in (season_env, venue_env):
            environment["matchIds"].add(match_id)
            for name in ("all_normal", cohort):
                context = environment["cohorts"][name]; context["matchIds"].add(match_id)
                for row in innings_rows:
                    _add_numbers(context["totals"], row["totals"])
                    _add_numbers(context["firstInnings" if row["inningsOrder"] == "first" else "chases"], row["totals"])
                    for phase in PHASES: _add_numbers(context["phases"][phase], row["phases"][phase])
                    _add_numbers(context["officialPowerplay"], row["officialPowerplay"])
                    context["inningsRuns"][row["totals"]["runs"]] += 1; context["inningsDismissals"][row["totals"]["dismissals"]] += 1
                if len(innings_rows) == 2:
                    if match["outcome"]["resultType"] == "win": chase = "successful" if match["outcome"]["winnerTeamId"] == innings_rows[1]["battingTeamId"] else "failed"
                    elif match["outcome"]["resultType"] == "tie": chase = "tie"
                    else: chase = "no_result"
                    context["chaseOutcomes"][chase] += 1

    player_rows = [_final_player(item) for item in players.values()]
    team_rows = [_final_team(item) for item in teams.values()]
    season_rows = [_final_environment(item, "season") for item in seasons.values()]
    venue_rows = [_final_environment(item, "venue") for item in venues.values()]
    match_rows.sort(key=lambda row: int(row["matchId"]))
    player_rows.sort(key=lambda row: row["playerTeamSeasonId"])
    team_rows.sort(key=lambda row: row["teamSeasonId"])
    season_rows.sort(key=lambda row: row["seasonId"])
    venue_rows.sort(key=lambda row: (row["seasonId"], row["venueSiteId"]))
    rows = {"matchSummaries": match_rows, "playerTeamSeasons": player_rows, "teamSeasons": team_rows, "seasonEnvironments": season_rows, "venueSeasonEnvironments": venue_rows}
    return rows, {"stage3Counts": dict(stage3_counts), "distributions": build_distributions(rows)}


def _final_player(item: dict[str, Any]) -> dict[str, Any]:
    contributions = sorted(item["matchContributions"], key=lambda row: int(row["matchId"]))
    official = sum(row["officialListed"] for row in contributions)
    recorded = sum(bool(row["recordedActions"]) for row in contributions)
    batting = deepcopy(item["batting"]); bowling = deepcopy(item["bowling"])
    positions = batting.pop("positions")
    batting["positionCounts"] = {str(position): positions[position] for position in range(1, 12)}
    batting["rates"] = _bat_rates(batting["totals"])
    batting["inningsObservations"].sort(key=lambda row: (int(row["matchId"]), row["inningsIndex"]))
    bowling_matches = len(bowling.pop("matches")); bowling["matches"] = bowling_matches
    bowling["rates"] = _bowl_rates(bowling["totals"], bowling_matches)
    bowling["inningsObservations"].sort(key=lambda row: (int(row["matchId"]), row["inningsIndex"]))
    return {
        "schemaVersion": ROW_SCHEMA_VERSIONS["playerTeamSeasons"], "datasetVersion": ANALYTICS_DATASET_VERSION,
        **{key: item[key] for key in ("playerTeamSeasonId", "playerId", "canonicalDisplayName", "seasonId", "teamId", "franchiseId")},
        "observedSourceNames": sorted(item["observedSourceNames"]),
        "participation": {"officialListMatchCount": official, "recordedActionMatchCount": recorded, "documentedInvolvementMatchCount": len(contributions), "matchContributions": contributions},
        "batting": batting, "bowling": bowling, "fielding": item["fielding"],
    }


def _final_team(item: dict[str, Any]) -> dict[str, Any]:
    results = {key: item["results"][key] for key in ("wins", "losses", "ties", "noResults")}
    eliminator = {key: item["eliminator"][key] for key in ("wins", "losses")}
    contexts = {key: item["contexts"][key] for key in ("battingFirst", "chasing")}
    chase = {key: item["chaseOutcomes"][key] for key in ("successful", "failed", "tie", "no_result")}
    return {
        "schemaVersion": ROW_SCHEMA_VERSIONS["teamSeasons"], "datasetVersion": ANALYTICS_DATASET_VERSION,
        **{key: item[key] for key in ("teamSeasonId", "teamId", "franchiseId", "seasonId")},
        "matchIds": sorted(item["matchIds"], key=int), "playerTeamSeasonIds": sorted(item["playerTeamSeasonIds"]),
        "cohortCounts": {key: item["cohortCounts"][key] for key in COHORTS}, "results": results,
        "eliminatorResults": eliminator, "stageCounts": [{"stage": key, "matches": value} for key, value in sorted(item["stages"].items())], "inningsContexts": contexts,
        "chaseOutcomes": chase, "batting": item["batting"], "bowling": item["bowling"],
        "battingPhases": item["battingPhases"], "bowlingPhases": item["bowlingPhases"],
        "officialPowerplayBatting": item["officialPowerplayBatting"], "officialPowerplayBowling": item["officialPowerplayBowling"],
        "inningsRuns": item["inningsRuns"], "inningsDismissals": item["inningsDismissals"],
    }


def _final_context(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "matchIds": sorted(item["matchIds"], key=int), "totals": item["totals"], "firstInnings": item["firstInnings"], "chases": item["chases"],
        "phases": item["phases"], "officialPowerplay": item["officialPowerplay"],
        "inningsRunsHistogram": [{"value": k, "count": v} for k, v in sorted(item["inningsRuns"].items())],
        "inningsDismissalsHistogram": [{"value": k, "count": v} for k, v in sorted(item["inningsDismissals"].items())],
        "chaseOutcomes": {key: item["chaseOutcomes"][key] for key in ("successful", "failed", "tie", "no_result")},
    }


def _final_environment(item: dict[str, Any], kind: str) -> dict[str, Any]:
    base = {
        "schemaVersion": ROW_SCHEMA_VERSIONS["seasonEnvironments" if kind == "season" else "venueSeasonEnvironments"],
        "datasetVersion": ANALYTICS_DATASET_VERSION, "seasonId": item["seasonId"],
        "matchIds": sorted(item["matchIds"], key=int), "cohorts": {name: _final_context(item["cohorts"][name]) for name in ("all_normal", *COHORTS)},
    }
    if kind == "venue":
        count = len(item["matchIds"])
        band = "single_match" if count == 1 else "two_to_four" if count < 5 else "five_to_nine" if count < 10 else "ten_plus"
        base.update({"venueSeasonId": item["groupId"], "venueSiteId": item["venueSiteId"], "venueIds": sorted(item["venueIds"]), "canonicalNames": sorted(item["canonicalNames"]), "canonicalCities": sorted(item["canonicalCities"]), "countries": sorted(item["countries"]), "matchCountBand": band, "smallSample": count < 5})
    return base


def _summary(values: list[int]) -> dict[str, Any]:
    if not values: return {"count": 0, "minimum": None, "median": None, "average": None, "maximum": None, "histogram": []}
    histogram = Counter(values)
    return {"count": len(values), "minimum": min(values), "median": median(values), "average": round(sum(values) / len(values), 6), "maximum": max(values), "histogram": [{"value": value, "count": count} for value, count in sorted(histogram.items())]}


def build_distributions(rows: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    players = rows["playerTeamSeasons"]
    def cohort_summary(selected: list[dict[str, Any]]) -> dict[str, Any]:
        return {key: _summary([p["participation"][key] for p in selected]) for key in ("officialListMatchCount", "recordedActionMatchCount", "documentedInvolvementMatchCount")}
    def intersections(selected: list[dict[str, Any]]) -> dict[str, int]:
        selected_contributions = [c for p in selected for c in p["participation"]["matchContributions"]]
        return {
            "officialAndRecorded": sum(c["officialListed"] and bool(c["recordedActions"]) for c in selected_contributions),
            "officialOnly": sum(c["officialListed"] and not c["recordedActions"] for c in selected_contributions),
            "recordedOnly": sum((not c["officialListed"]) and bool(c["recordedActions"]) for c in selected_contributions),
        }
    per_season = [{"seasonId": season, **cohort_summary([p for p in players if p["seasonId"] == season])} for season in sorted({p["seasonId"] for p in players})]
    pre = [p for p in players if int(p["seasonId"].split("-")[1]) < 2023]; impact = [p for p in players if int(p["seasonId"].split("-")[1]) >= 2023]
    contributions = [c for p in players for c in p["participation"]["matchContributions"]]
    evidence_counts = Counter()
    for p in players:
        replacements = Counter()
        for c in p["participation"]["matchContributions"]:
            replacements.update(c["replacementEvents"]); replacements.update({key: c["superOverEvents"][key] for key in ("impactIn", "impactOut", "concussionIn", "concussionOut", "roleIn", "roleOut")})
        if any(replacements[k] for k in ("impactIn", "impactOut")): evidence_counts["impactProfiles"] += 1
        if any(replacements[k] for k in ("concussionIn", "concussionOut")): evidence_counts["concussionProfiles"] += 1
        if replacements["roleIn"] or replacements["roleOut"]: evidence_counts["roleReplacementProfiles"] += 1
        if p["fielding"]["substituteFieldingEvents"]: evidence_counts["substituteFieldingProfiles"] += 1
        if any("absent_hurt" in c["recordedActions"] for c in p["participation"]["matchContributions"]): evidence_counts["absentHurtProfiles"] += 1
        if any(c["eventOnly"] for c in p["participation"]["matchContributions"]): evidence_counts["eventOnlyProfiles"] += 1
    representatives: dict[str, str | None] = {}
    selectors = {
        "substantialBatting": lambda p: p["batting"]["totals"]["runs"],
        "substantialBowling": lambda p: p["bowling"]["totals"]["legalBalls"],
        "mixedUsage": lambda p: min(p["batting"]["totals"]["balls"], p["bowling"]["totals"]["legalBalls"]),
        "stumpingEvidence": lambda p: p["fielding"]["stumpings"],
        "impactEvidence": lambda p: sum(c["replacementEvents"]["impactIn"] + c["replacementEvents"]["impactOut"] for c in p["participation"]["matchContributions"]),
        "eventOnlyEvidence": lambda p: sum(c["eventOnly"] for c in p["participation"]["matchContributions"]),
    }
    for name, selector in selectors.items():
        chosen = max(players, key=lambda p: (selector(p), p["playerTeamSeasonId"]))
        representatives[name] = chosen["playerTeamSeasonId"] if selector(chosen) else None
    small = [p for p in players if p["participation"]["documentedInvolvementMatchCount"] == 1]
    representatives["smallSample"] = small[0]["playerTeamSeasonId"] if small else None
    return {
        "participation": {
            "allSeasons": cohort_summary(players), "perSeason": per_season, "preImpact": cohort_summary(pre), "impactEra": cohort_summary(impact),
            "matchContributionIntersections": intersections(players), "preImpactIntersections": intersections(pre), "impactEraIntersections": intersections(impact),
            "gapDistributions": {
                "documentedMinusOfficial": _summary([p["participation"]["documentedInvolvementMatchCount"] - p["participation"]["officialListMatchCount"] for p in players]),
                "documentedMinusRecorded": _summary([p["participation"]["documentedInvolvementMatchCount"] - p["participation"]["recordedActionMatchCount"] for p in players]),
                "officialMinusRecorded": _summary([p["participation"]["officialListMatchCount"] - p["participation"]["recordedActionMatchCount"] for p in players]),
            },
        },
        "samples": {
            "battingInnings": _summary([p["batting"]["innings"] for p in players]), "battingBalls": _summary([p["batting"]["totals"]["balls"] for p in players]),
            "bowlingInnings": _summary([p["bowling"]["innings"] for p in players]), "bowlingLegalBalls": _summary([p["bowling"]["totals"]["legalBalls"] for p in players]),
            "battingPositionAppearances": {str(position): sum(p["batting"]["positionCounts"][str(position)] for p in players) for position in range(1, 12)},
        },
        "evidenceProfileCounts": {key: evidence_counts[key] for key in ("impactProfiles", "concussionProfiles", "roleReplacementProfiles", "substituteFieldingProfiles", "absentHurtProfiles", "eventOnlyProfiles")},
        "evidenceEventCounts": {
            "impactReplacements": sum(c["replacementEvents"]["impactIn"] + c["superOverEvents"]["impactIn"] for c in contributions),
            "concussionSubstitutes": sum(c["replacementEvents"]["concussionIn"] + c["superOverEvents"]["concussionIn"] for c in contributions),
            "roleReplacements": sum(c["replacementEvents"]["roleIn"] + c["superOverEvents"]["roleIn"] for c in contributions),
            "substituteFieldingEvents": sum(p["fielding"]["substituteFieldingEvents"] for p in players) + sum(c["superOverEvents"]["substituteFielding"] for c in contributions),
            "absentHurtParticipantMatches": sum("absent_hurt" in c["recordedActions"] for c in contributions),
        },
        "environment": {
            "teamSeasons": len(rows["teamSeasons"]), "venueSeasons": len(rows["venueSeasonEnvironments"]),
            "smallVenueSeasons": sum(v["smallSample"] for v in rows["venueSeasonEnvironments"]),
            "teamSeasonMatchCounts": _summary([len(t["matchIds"]) for t in rows["teamSeasons"]]),
            "venueSeasonMatchCounts": _summary([len(v["matchIds"]) for v in rows["venueSeasonEnvironments"]]),
            "venueSampleBands": {key: Counter(v["matchCountBand"] for v in rows["venueSeasonEnvironments"])[key] for key in ("single_match", "two_to_four", "five_to_nine", "ten_plus")},
            "matchCohorts": {key: Counter(m["cohort"] for m in rows["matchSummaries"])[key] for key in COHORTS},
        },
        "representativeProfileIds": representatives,
    }
