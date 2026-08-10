from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from typing import Any

from scripts.identity_registry.resolver import (
    IdentityResolver,
    IdentityResolutionError,
    IngestionSafetyError,
    require_ingestion_safe_resolution,
)


MATCH_SCHEMA_VERSION = "cricsheet-ipl-normalized-match/v1"
DATASET_VERSION = "cricsheet-ipl-normalized/v1"
SOURCE_AUDIT_SCHEMA_VERSION = "cricsheet-ipl-archive-audit/v1"

BOWLER_WICKET_KINDS = {
    "bowled", "caught", "caught and bowled", "hit wicket", "lbw", "stumped",
}
OBSERVED_WICKET_KINDS = BOWLER_WICKET_KINDS | {
    "obstructing the field", "retired hurt", "retired out", "run out",
}
EXTRAS_KEYS = {"byes", "legbyes", "noballs", "penalty", "wides"}


class MatchNormalizationError(ValueError):
    pass


@dataclass(frozen=True)
class NormalizedMatch:
    document: dict[str, Any]
    warnings: list[dict[str, Any]]
    counts: dict[str, Any]


def _object(value: Any, location: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise MatchNormalizationError(f"Expected object at {location}")
    return value


def _array(value: Any, location: str) -> list[Any]:
    if not isinstance(value, list):
        raise MatchNormalizationError(f"Expected array at {location}")
    return value


def _shape(value: dict[str, Any], required: set[str], allowed: set[str], location: str) -> None:
    missing = required - set(value)
    unexpected = set(value) - allowed
    if missing or unexpected:
        raise MatchNormalizationError(
            f"Invalid source shape at {location}; missing={sorted(missing)}, unexpected={sorted(unexpected)}"
        )


def _integer(value: Any, location: str, *, minimum: int = 0) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < minimum:
        raise MatchNormalizationError(f"Expected integer >= {minimum} at {location}")
    return value


def _number(value: Any, location: str) -> int | float:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise MatchNormalizationError(f"Expected number at {location}")
    return value


def _string(value: Any, location: str) -> str:
    if not isinstance(value, str) or not value:
        raise MatchNormalizationError(f"Expected non-empty string at {location}")
    return value


def _unique_append(values: list[Any], value: Any) -> None:
    if value not in values:
        values.append(value)


def _delivery_ref(
    innings_index: int,
    source_over_number: int,
    source_delivery_index: int,
    item_index: int,
) -> dict[str, int]:
    return {
        "inningsIndex": innings_index,
        "sourceOverNumber": source_over_number,
        "sourceDeliveryIndex": source_delivery_index,
        "itemIndex": item_index,
    }


def _warning(code: str, match_id: str, source_path: str, message: str) -> dict[str, Any]:
    return {
        "severity": "warning",
        "code": code,
        "matchId": match_id,
        "sourcePath": source_path,
        "location": None,
        "relatedEntityIds": [],
        "message": message,
    }


class _MatchContext:
    def __init__(
        self,
        *,
        match_id: str,
        source_path: str,
        registry: dict[str, str],
        resolver: IdentityResolver,
        teams_by_source: dict[str, dict[str, str]],
    ) -> None:
        self.match_id = match_id
        self.source_path = source_path
        self.registry = registry
        self.resolver = resolver
        self.teams_by_source = teams_by_source
        self.player_cache: dict[tuple[str, str], dict[str, Any]] = {}
        self.participants: dict[tuple[str, str], dict[str, Any]] = {}

    def source_person(self, name: Any, location: str) -> dict[str, str]:
        source_name = _string(name, location)
        person_id = self.registry.get(source_name)
        if not isinstance(person_id, str) or not person_id:
            raise MatchNormalizationError(f"Missing info.registry.people entry for {source_name!r} at {location}")
        return {"sourceName": source_name, "sourcePersonRegistryId": person_id}

    def resolve_player(self, name: Any, location: str) -> tuple[dict[str, str], dict[str, Any]]:
        source = self.source_person(name, location)
        key = (source["sourcePersonRegistryId"], source["sourceName"])
        resolution = self.player_cache.get(key)
        if resolution is None:
            try:
                resolution = require_ingestion_safe_resolution(
                    self.resolver.resolve_player(key[0], key[1])
                )
            except (IdentityResolutionError, IngestionSafetyError) as error:
                raise MatchNormalizationError(f"Unsafe player identity at {location}: {error}") from error
            self.player_cache[key] = resolution
        return {"playerId": resolution["id"], "sourceName": source["sourceName"]}, resolution

    def participant(
        self,
        team_id: str,
        name: Any,
        location: str,
        *,
        official_index: int | None = None,
    ) -> tuple[dict[str, str], dict[str, Any]]:
        player_ref, resolution = self.resolve_player(name, location)
        key = (team_id, player_ref["playerId"])
        existing_other_team = [item for item in self.participants if item[1] == key[1] and item[0] != team_id]
        if existing_other_team:
            raise MatchNormalizationError(
                f"Player {key[1]} is attributed to both match teams in {self.source_path}"
            )
        participant = self.participants.get(key)
        if participant is None:
            participant = {
                "playerId": player_ref["playerId"],
                "canonicalDisplayName": resolution["canonicalDisplayName"],
                "teamId": team_id,
                "observedSourceNames": [],
                "registryParticipationBasis": resolution["participationBasis"],
                "resolution": {
                    "status": resolution["status"],
                    "matchedBy": resolution["matchedBy"],
                    "registryReviewStatus": resolution["registryReviewStatus"],
                    "requiresNewReview": resolution["requiresNewReview"],
                },
                "sourceListStatus": "event_only",
                "officialListIndex": None,
                "evidence": {
                    "battingInningsIndexes": [],
                    "bowlingInningsIndexes": [],
                    "fieldingInningsIndexes": [],
                    "substituteFielding": [],
                    "absentHurtInningsIndexes": [],
                    "reviews": [],
                    "matchReplacementIn": [],
                    "matchReplacementOut": [],
                    "roleReplacementIn": [],
                    "roleReplacementOut": [],
                    "playerOfMatch": False,
                },
            }
            self.participants[key] = participant
        _unique_append(participant["observedSourceNames"], player_ref["sourceName"])
        if official_index is not None:
            if participant["officialListIndex"] not in {None, official_index}:
                raise MatchNormalizationError(f"Conflicting official participant indexes for {key[1]}")
            participant["sourceListStatus"] = "official_listed"
            participant["officialListIndex"] = official_index
        return player_ref, participant


def normalize_match(
    data: dict[str, Any],
    *,
    match_id: str,
    relative_source_path: str,
    source_file_sha256: str,
    source_archive_manifest_hash: str,
    identity_registry_version: str,
    identity_registry_aggregate_hash: str,
    resolver: IdentityResolver,
) -> NormalizedMatch:
    _shape(data, {"meta", "info", "innings"}, {"meta", "info", "innings"}, relative_source_path)
    meta = _object(data["meta"], f"{relative_source_path}.meta")
    _shape(meta, {"data_version", "revision", "created"}, {"data_version", "revision", "created"}, "meta")
    if meta["data_version"] != "1.2.0":
        raise MatchNormalizationError(f"Unsupported Cricsheet data version {meta['data_version']!r}")

    info = _object(data["info"], f"{relative_source_path}.info")
    allowed_info = {
        "balls_per_over", "city", "dates", "event", "gender", "match_type", "officials",
        "outcome", "overs", "player_of_match", "players", "registry", "season", "team_type",
        "teams", "toss", "venue",
    }
    required_info = allowed_info - {"city", "player_of_match"}
    _shape(info, required_info, allowed_info, "info")
    source_season = info["season"]
    if not isinstance(source_season, (str, int)) or isinstance(source_season, bool):
        raise MatchNormalizationError("info.season must be a string or integer")
    source_season_key = str(source_season)
    try:
        season_resolution = require_ingestion_safe_resolution(
            resolver.resolve_source_season(source_season_key)
        )
    except (IdentityResolutionError, IngestionSafetyError) as error:
        raise MatchNormalizationError(f"Unsafe season identity: {error}") from error
    season_id = season_resolution["id"]

    source_teams = _array(info["teams"], "info.teams")
    if len(source_teams) != 2 or len(set(source_teams)) != 2:
        raise MatchNormalizationError("info.teams must contain exactly two unique source teams")
    normalized_teams: list[dict[str, str]] = []
    teams_by_source: dict[str, dict[str, str]] = {}
    for index, source_team_value in enumerate(source_teams):
        source_team = _string(source_team_value, f"info.teams[{index}]")
        try:
            resolution = require_ingestion_safe_resolution(resolver.resolve_team(source_team, season_id))
        except (IdentityResolutionError, IngestionSafetyError) as error:
            raise MatchNormalizationError(f"Unsafe team identity at info.teams[{index}]: {error}") from error
        record = {
            "sourceTeamName": source_team,
            "teamId": resolution["teamId"],
            "franchiseId": resolution["franchiseId"],
        }
        normalized_teams.append(record)
        teams_by_source[source_team] = record

    source_registry = _object(info["registry"], "info.registry")
    _shape(source_registry, {"people"}, {"people"}, "info.registry")
    people_registry = _object(source_registry["people"], "info.registry.people")
    if any(not isinstance(name, str) or not isinstance(identifier, str) for name, identifier in people_registry.items()):
        raise MatchNormalizationError("info.registry.people must map strings to strings")
    context = _MatchContext(
        match_id=match_id,
        source_path=relative_source_path,
        registry=people_registry,
        resolver=resolver,
        teams_by_source=teams_by_source,
    )

    source_players = _object(info["players"], "info.players")
    if set(source_players) != set(source_teams):
        raise MatchNormalizationError("info.players keys must equal info.teams")
    participant_sizes: list[int] = []
    for source_team in source_teams:
        names = _array(source_players[source_team], f"info.players[{source_team!r}]")
        participant_sizes.append(len(names))
        team_id = teams_by_source[source_team]["teamId"]
        for official_index, name in enumerate(names):
            context.participant(
                team_id,
                name,
                f"info.players[{source_team!r}][{official_index}]",
                official_index=official_index,
            )

    city = info.get("city")
    if city is not None:
        city = _string(city, "info.city")
    source_venue = _string(info["venue"], "info.venue")
    try:
        venue_resolution = require_ingestion_safe_resolution(
            resolver.resolve_venue(source_venue, city, season_id)
        )
    except (IdentityResolutionError, IngestionSafetyError) as error:
        raise MatchNormalizationError(f"Unsafe venue identity: {error}") from error
    venue = {
        "sourceVenue": source_venue,
        "sourceCity": city,
        "venueId": venue_resolution["venueId"],
        "venueSiteId": venue_resolution["venueSiteId"],
        "canonicalName": venue_resolution["canonicalName"],
        "canonicalCity": venue_resolution["canonicalCity"],
        "country": venue_resolution["country"],
        "resolution": {
            "status": venue_resolution["status"],
            "matchedBy": venue_resolution["matchedBy"],
            "registryReviewStatus": venue_resolution["registryReviewStatus"],
            "requiresNewReview": venue_resolution["requiresNewReview"],
            "evidenceRefs": venue_resolution["evidenceRefs"],
        },
    }

    event = _object(info["event"], "info.event")
    _shape(event, {"name"}, {"name", "match_number", "stage"}, "info.event")
    match_number = event.get("match_number")
    stage = event.get("stage")
    if (match_number is None) == (stage is None):
        raise MatchNormalizationError("info.event must contain exactly one of match_number or stage")
    if match_number is not None:
        match_number = _integer(match_number, "info.event.match_number", minimum=1)
    if stage is not None:
        stage = _string(stage, "info.event.stage")

    toss_source = _object(info["toss"], "info.toss")
    _shape(toss_source, {"winner", "decision"}, {"winner", "decision"}, "info.toss")
    toss_team_name = _string(toss_source["winner"], "info.toss.winner")
    if toss_team_name not in teams_by_source or toss_source["decision"] not in {"bat", "field"}:
        raise MatchNormalizationError("Invalid toss team or decision")
    toss = {
        "sourceWinnerTeamName": toss_team_name,
        "winnerTeamId": teams_by_source[toss_team_name]["teamId"],
        "decision": toss_source["decision"],
    }

    outcome_source = _object(info["outcome"], "info.outcome")
    _shape(outcome_source, set(), {"winner", "by", "result", "eliminator", "method"}, "info.outcome")
    winner_name = outcome_source.get("winner")
    result_value = outcome_source.get("result")
    if winner_name is not None:
        winner_name = _string(winner_name, "info.outcome.winner")
        if winner_name not in teams_by_source:
            raise MatchNormalizationError("Outcome winner is not a match team")
        result_type = "win"
    elif result_value == "tie":
        result_type = "tie"
    elif result_value == "no result":
        result_type = "no_result"
    else:
        raise MatchNormalizationError("Unsupported outcome shape")
    if result_value not in {None, "tie", "no result"}:
        raise MatchNormalizationError(f"Unsupported outcome result {result_value!r}")
    method = outcome_source.get("method")
    if method not in {None, "D/L"}:
        raise MatchNormalizationError(f"Unsupported outcome method {method!r}")
    eliminator_name = outcome_source.get("eliminator")
    if eliminator_name is not None:
        eliminator_name = _string(eliminator_name, "info.outcome.eliminator")
        if eliminator_name not in teams_by_source:
            raise MatchNormalizationError("Eliminator winner is not a match team")
    by = outcome_source.get("by")
    margin = None
    if by is not None:
        by = _object(by, "info.outcome.by")
        if len(by) != 1 or next(iter(by)) not in {"runs", "wickets"}:
            raise MatchNormalizationError("Outcome margin must contain exactly runs or wickets")
        kind, value = next(iter(by.items()))
        margin = {"kind": kind, "value": _integer(value, f"info.outcome.by.{kind}", minimum=1)}
    outcome = {
        "resultType": result_type,
        "sourceResult": result_value,
        "sourceWinnerTeamName": winner_name,
        "winnerTeamId": teams_by_source[winner_name]["teamId"] if winner_name else None,
        "sourceEliminatorWinnerTeamName": eliminator_name,
        "eliminatorWinnerTeamId": teams_by_source[eliminator_name]["teamId"] if eliminator_name else None,
        "method": method,
        "margin": margin,
    }

    officials_source = _object(info["officials"], "info.officials")
    allowed_official_roles = {"match_referees", "reserve_umpires", "tv_umpires", "umpires"}
    if set(officials_source) - allowed_official_roles:
        raise MatchNormalizationError("Unsupported source official role")
    officials = []
    for role in sorted(officials_source):
        names = _array(officials_source[role], f"info.officials.{role}")
        officials.append({
            "role": role,
            "people": [context.source_person(name, f"info.officials.{role}[{index}]") for index, name in enumerate(names)],
        })

    warnings: list[dict[str, Any]] = []
    warning_codes: set[str] = set()

    def add_warning(code: str, message: str) -> None:
        if code not in warning_codes:
            warning_codes.add(code)
            warnings.append(_warning(code, match_id, relative_source_path, message))

    if city is None:
        add_warning("missing_city", "Source match has no city metadata.")
    if "player_of_match" not in info:
        add_warning("missing_player_of_match", "Source match has no player-of-match metadata.")
    if any(size in {12, 13} for size in participant_sizes):
        add_warning("expanded_official_participants", "A source team lists 12 or 13 official participants.")
    if len(info["dates"]) > 1:
        add_warning("multi_date_match", "Source match spans multiple dates.")
    if method == "D/L":
        add_warning("dl_method", "Source outcome uses D/L.")
    if result_type == "tie":
        add_warning("tie", "Source normal innings ended tied.")
    if result_type == "no_result":
        add_warning("no_result", "Source outcome is no result.")

    counters: Counter[str] = Counter()
    dismissal_counts: Counter[str] = Counter()
    extras_occurrences: Counter[str] = Counter()
    normalized_innings: list[dict[str, Any]] = []
    innings_source = _array(data["innings"], "innings")
    normal_ordinal = 0
    for innings_zero_index, innings_value in enumerate(innings_source):
        innings_index = innings_zero_index + 1
        innings = _object(innings_value, f"innings[{innings_zero_index}]")
        _shape(
            innings,
            {"team", "overs"},
            {"team", "overs", "super_over", "target", "powerplays", "absent_hurt", "miscounted_overs"},
            f"innings[{innings_zero_index}]",
        )
        batting_source_team = _string(innings["team"], f"innings[{innings_zero_index}].team")
        if batting_source_team not in teams_by_source:
            raise MatchNormalizationError("Innings batting team is not a match team")
        batting_team_id = teams_by_source[batting_source_team]["teamId"]
        bowling_record = next(team for team in normalized_teams if team["teamId"] != batting_team_id)
        bowling_team_id = bowling_record["teamId"]
        innings_kind = "super_over" if innings.get("super_over") is True else "normal"
        if "super_over" in innings and innings.get("super_over") is not True:
            raise MatchNormalizationError("Source super_over flag must be true when present")
        counters[f"{innings_kind}Innings"] += 1
        if innings_kind == "normal":
            normal_ordinal += 1
        else:
            add_warning("super_over", "Source match contains Super Over innings.")

        target_source = innings.get("target")
        target = None
        if target_source is not None:
            target_source = _object(target_source, f"innings[{innings_zero_index}].target")
            _shape(target_source, {"overs", "runs"}, {"overs", "runs"}, "target")
            target = {
                "overs": _number(target_source["overs"], "target.overs"),
                "runs": _integer(target_source["runs"], "target.runs", minimum=1),
            }
        if innings_kind == "super_over" and target is not None:
            raise MatchNormalizationError("Super Over innings must not contain a source target")
        if innings_kind == "normal" and ((normal_ordinal == 1 and target is not None) or (normal_ordinal == 2 and target is None)):
            raise MatchNormalizationError("Source target placement is inconsistent with normal innings order")
        if innings_kind == "normal" and normal_ordinal > 2:
            raise MatchNormalizationError("More than two normal innings are unsupported for IPL normalization")

        powerplays = []
        for powerplay_index, powerplay_value in enumerate(_array(innings.get("powerplays", []), "powerplays")):
            powerplay = _object(powerplay_value, f"powerplays[{powerplay_index}]")
            _shape(powerplay, {"from", "to", "type"}, {"from", "to", "type"}, "powerplay")
            if powerplay["type"] != "mandatory":
                raise MatchNormalizationError(f"Unsupported powerplay type {powerplay['type']!r}")
            powerplays.append({
                "from": _number(powerplay["from"], "powerplay.from"),
                "to": _number(powerplay["to"], "powerplay.to"),
                "type": "mandatory",
            })

        absent_hurt = []
        for absent_index, name in enumerate(_array(innings.get("absent_hurt", []), "absent_hurt")):
            player_ref, participant = context.participant(
                batting_team_id, name, f"innings[{innings_zero_index}].absent_hurt[{absent_index}]"
            )
            _unique_append(participant["evidence"]["absentHurtInningsIndexes"], innings_index)
            absent_hurt.append(player_ref)
        if absent_hurt:
            add_warning("absent_hurt", "Source innings contains absent-hurt evidence.")

        miscounted_overs = []
        miscounted_source = innings.get("miscounted_overs", {})
        miscounted_source = _object(miscounted_source, "miscounted_overs")
        for source_over_key in sorted(miscounted_source, key=lambda value: int(value)):
            detail = _object(miscounted_source[source_over_key], f"miscounted_overs.{source_over_key}")
            _shape(detail, {"balls"}, {"balls", "umpire"}, "miscounted_over")
            miscounted_overs.append({
                "sourceOverNumber": int(source_over_key),
                "balls": _integer(detail["balls"], "miscounted_over.balls", minimum=1),
                "umpire": context.source_person(detail["umpire"], "miscounted_over.umpire") if "umpire" in detail else None,
            })
        if miscounted_overs:
            add_warning("miscounted_over", "Source innings records a miscounted over.")

        totals: Counter[str] = Counter()
        normalized_overs = []
        for source_over_index, over_value in enumerate(_array(innings["overs"], "overs")):
            over = _object(over_value, f"overs[{source_over_index}]")
            _shape(over, {"over", "deliveries"}, {"over", "deliveries"}, "over")
            source_over_number = _integer(over["over"], "over.over")
            normalized_deliveries = []
            for delivery_index, delivery_value in enumerate(_array(over["deliveries"], "deliveries")):
                delivery = _object(delivery_value, "delivery")
                _shape(
                    delivery,
                    {"actual_delivery", "batter", "non_striker", "bowler", "runs"},
                    {"actual_delivery", "batter", "non_striker", "bowler", "runs", "extras", "wickets", "review", "replacements"},
                    "delivery",
                )
                actual_delivery = _string(delivery["actual_delivery"], "delivery.actual_delivery")
                batter_ref, batter_participant = context.participant(batting_team_id, delivery["batter"], "delivery.batter")
                non_striker_ref, non_striker_participant = context.participant(
                    batting_team_id, delivery["non_striker"], "delivery.non_striker"
                )
                bowler_ref, bowler_participant = context.participant(bowling_team_id, delivery["bowler"], "delivery.bowler")
                for participant in (batter_participant, non_striker_participant):
                    _unique_append(participant["evidence"]["battingInningsIndexes"], innings_index)
                _unique_append(bowler_participant["evidence"]["bowlingInningsIndexes"], innings_index)

                runs_source = _object(delivery["runs"], "delivery.runs")
                _shape(runs_source, {"batter", "extras", "total"}, {"batter", "extras", "total", "non_boundary"}, "runs")
                batter_runs = _integer(runs_source["batter"], "runs.batter")
                extras_total = _integer(runs_source["extras"], "runs.extras")
                total_runs = _integer(runs_source["total"], "runs.total")
                if total_runs != batter_runs + extras_total:
                    raise MatchNormalizationError("runs.total does not equal batter plus extras")
                if runs_source.get("non_boundary") not in {None, True}:
                    raise MatchNormalizationError("runs.non_boundary must be true when present")

                extras_source = _object(delivery.get("extras", {}), "delivery.extras")
                if set(extras_source) - EXTRAS_KEYS:
                    raise MatchNormalizationError(f"Unsupported extras keys: {sorted(set(extras_source) - EXTRAS_KEYS)}")
                extras = {
                    "byes": _integer(extras_source.get("byes", 0), "extras.byes"),
                    "legByes": _integer(extras_source.get("legbyes", 0), "extras.legbyes"),
                    "noBalls": _integer(extras_source.get("noballs", 0), "extras.noballs"),
                    "penalty": _integer(extras_source.get("penalty", 0), "extras.penalty"),
                    "wides": _integer(extras_source.get("wides", 0), "extras.wides"),
                }
                if extras_total != sum(extras.values()):
                    raise MatchNormalizationError("runs.extras does not reconcile with extras breakdown")
                for key, amount in extras_source.items():
                    if amount:
                        extras_occurrences[key] += 1
                if extras["wides"] and extras["noBalls"]:
                    raise MatchNormalizationError("A delivery cannot be both a wide and a no-ball")
                legal_delivery = not extras["wides"] and not extras["noBalls"]
                batter_ball = not extras["wides"]

                normalized_wickets = []
                for wicket_index, wicket_value in enumerate(_array(delivery.get("wickets", []), "wickets")):
                    wicket = _object(wicket_value, f"wickets[{wicket_index}]")
                    _shape(wicket, {"kind", "player_out"}, {"kind", "player_out", "fielders"}, "wicket")
                    kind = _string(wicket["kind"], "wicket.kind")
                    if kind not in OBSERVED_WICKET_KINDS:
                        raise MatchNormalizationError(f"Unsupported dismissal kind {kind!r}")
                    dismissal_counts[kind] += 1
                    player_out_ref, _ = context.participant(batting_team_id, wicket["player_out"], "wicket.player_out")
                    fielders = []
                    for fielder_index, fielder_value in enumerate(_array(wicket.get("fielders", []), "fielders")):
                        fielder = _object(fielder_value, f"fielders[{fielder_index}]")
                        _shape(fielder, {"name"}, {"name", "substitute"}, "fielder")
                        if fielder.get("substitute") not in {None, True}:
                            raise MatchNormalizationError("fielder.substitute must be true when present")
                        fielder_ref, fielder_participant = context.participant(bowling_team_id, fielder["name"], "fielder.name")
                        _unique_append(fielder_participant["evidence"]["fieldingInningsIndexes"], innings_index)
                        if fielder.get("substitute") is True:
                            counters["substituteFieldingEvents"] += 1
                            fielder_participant["evidence"]["substituteFielding"].append(
                                _delivery_ref(innings_index, source_over_number, delivery_index, fielder_index)
                            )
                            add_warning("substitute_fielding", "Source match contains substitute-fielding evidence.")
                        fielders.append({**fielder_ref, "isSubstitute": fielder.get("substitute") is True})
                    counts_as_dismissal = kind != "retired hurt"
                    credited_to_bowler = kind in BOWLER_WICKET_KINDS
                    normalized_wickets.append({
                        "kind": kind,
                        "playerOut": player_out_ref,
                        "fielders": fielders,
                        "countsAsBatterDismissal": counts_as_dismissal,
                        "creditedToBowler": credited_to_bowler,
                    })
                    totals["wicketEvents"] += 1
                    totals["batterDismissals"] += int(counts_as_dismissal)
                    totals["bowlerCreditedWickets"] += int(credited_to_bowler)

                review = None
                if "review" in delivery:
                    review_source = _object(delivery["review"], "delivery.review")
                    _shape(review_source, {"by", "batter", "decision", "umpire"}, {"by", "batter", "decision", "umpire", "type", "umpires_call"}, "review")
                    review_team = _string(review_source["by"], "review.by")
                    if review_team not in teams_by_source or review_source["decision"] not in {"upheld", "struck down"}:
                        raise MatchNormalizationError("Invalid review team or decision")
                    if review_source.get("type") not in {None, "wicket"} or review_source.get("umpires_call") not in {None, True}:
                        raise MatchNormalizationError("Unsupported review shape")
                    review_batter_ref, review_participant = context.participant(batting_team_id, review_source["batter"], "review.batter")
                    review_participant["evidence"]["reviews"].append(
                        _delivery_ref(innings_index, source_over_number, delivery_index, 0)
                    )
                    review = {
                        "sourceReviewingTeamName": review_team,
                        "reviewingTeamId": teams_by_source[review_team]["teamId"],
                        "batter": review_batter_ref,
                        "decision": review_source["decision"],
                        "type": review_source.get("type"),
                        "umpire": context.source_person(review_source["umpire"], "review.umpire"),
                        "umpiresCall": review_source.get("umpires_call") is True,
                    }
                    counters["reviews"] += 1

                replacements = {"match": [], "role": []}
                replacements_source = _object(delivery.get("replacements", {}), "delivery.replacements")
                if set(replacements_source) - {"match", "role"}:
                    raise MatchNormalizationError("Unsupported delivery replacement scope")
                for replacement_index, replacement_value in enumerate(_array(replacements_source.get("match", []), "replacements.match")):
                    replacement = _object(replacement_value, "match_replacement")
                    _shape(replacement, {"in", "out", "team", "reason"}, {"in", "out", "team", "reason"}, "match_replacement")
                    replacement_team = _string(replacement["team"], "match_replacement.team")
                    reason = replacement["reason"]
                    if replacement_team not in teams_by_source or reason not in {"impact_player", "concussion_substitute"}:
                        raise MatchNormalizationError("Unsupported match replacement team or reason")
                    replacement_team_id = teams_by_source[replacement_team]["teamId"]
                    in_ref, in_participant = context.participant(replacement_team_id, replacement["in"], "match_replacement.in")
                    out_ref, out_participant = context.participant(replacement_team_id, replacement["out"], "match_replacement.out")
                    event_ref = _delivery_ref(innings_index, source_over_number, delivery_index, replacement_index)
                    in_participant["evidence"]["matchReplacementIn"].append(event_ref)
                    out_participant["evidence"]["matchReplacementOut"].append(event_ref)
                    replacements["match"].append({
                        "in": in_ref,
                        "out": out_ref,
                        "sourceTeamName": replacement_team,
                        "teamId": replacement_team_id,
                        "reason": reason,
                    })
                    counters["impactPlayerReplacements" if reason == "impact_player" else "concussionSubstitutes"] += 1
                    add_warning("match_replacement", "Source match contains an Impact Player or concussion replacement.")

                for replacement_index, replacement_value in enumerate(_array(replacements_source.get("role", []), "replacements.role")):
                    replacement = _object(replacement_value, "role_replacement")
                    _shape(replacement, {"in", "role", "reason"}, {"in", "out", "role", "reason"}, "role_replacement")
                    role = replacement["role"]
                    reason = replacement["reason"]
                    if role not in {"batter", "bowler"} or reason not in {"injury", "excluded - high full pitched balls"}:
                        raise MatchNormalizationError("Unsupported role replacement role or reason")
                    replacement_team_id = batting_team_id if role == "batter" else bowling_team_id
                    in_ref, in_participant = context.participant(replacement_team_id, replacement["in"], "role_replacement.in")
                    out_ref = None
                    event_ref = _delivery_ref(innings_index, source_over_number, delivery_index, replacement_index)
                    in_participant["evidence"]["roleReplacementIn"].append(event_ref)
                    if "out" in replacement:
                        out_ref, out_participant = context.participant(replacement_team_id, replacement["out"], "role_replacement.out")
                        out_participant["evidence"]["roleReplacementOut"].append(event_ref)
                    replacements["role"].append({
                        "in": in_ref,
                        "out": out_ref,
                        "role": role,
                        "reason": reason,
                        "teamId": replacement_team_id,
                        "teamBasis": "innings_batting_team" if role == "batter" else "innings_bowling_team",
                    })
                    counters["roleReplacements"] += 1
                    add_warning("role_replacement", "Source match contains a role replacement.")

                normalized_deliveries.append({
                    "sourceDeliveryIndex": delivery_index,
                    "actualDelivery": actual_delivery,
                    "batter": batter_ref,
                    "nonStriker": non_striker_ref,
                    "bowler": bowler_ref,
                    "runs": {
                        "batter": batter_runs,
                        "extras": extras_total,
                        "total": total_runs,
                        "nonBoundary": runs_source.get("non_boundary") is True,
                    },
                    "extras": extras,
                    "isBowlerLegalDelivery": legal_delivery,
                    "countsAsBatterBall": batter_ball,
                    "wickets": normalized_wickets,
                    "review": review,
                    "replacements": replacements,
                })
                counters["deliveries"] += 1
                totals["deliveryRecords"] += 1
                totals["runs"] += total_runs
                totals["bowlerLegalDeliveries"] += int(legal_delivery)
                totals["batterBallsFaced"] += int(batter_ball)
            normalized_overs.append({
                "sourceOverIndex": source_over_index,
                "sourceOverNumber": source_over_number,
                "deliveries": normalized_deliveries,
            })
        normalized_innings.append({
            "inningsIndex": innings_index,
            "sourceBattingTeamName": batting_source_team,
            "battingTeamId": batting_team_id,
            "bowlingTeamId": bowling_team_id,
            "inningsKind": innings_kind,
            "target": target,
            "powerplays": powerplays,
            "absentHurt": absent_hurt,
            "miscountedOvers": miscounted_overs,
            "overs": normalized_overs,
            "totals": {
                "runs": totals["runs"],
                "deliveryRecords": totals["deliveryRecords"],
                "bowlerLegalDeliveries": totals["bowlerLegalDeliveries"],
                "batterBallsFaced": totals["batterBallsFaced"],
                "wicketEvents": totals["wicketEvents"],
                "batterDismissals": totals["batterDismissals"],
                "bowlerCreditedWickets": totals["bowlerCreditedWickets"],
            },
        })

    if normal_ordinal == 1:
        add_warning("one_normal_innings", "Source match contains only one normal innings.")
    if counters["super_overInnings"] >= 4:
        add_warning("double_super_over", "Source match contains a double Super Over.")

    player_of_match = []
    for pom_index, name in enumerate(_array(info.get("player_of_match", []), "info.player_of_match")):
        player_ref, _ = context.resolve_player(name, f"info.player_of_match[{pom_index}]")
        matching = [participant for key, participant in context.participants.items() if key[1] == player_ref["playerId"]]
        if len(matching) != 1:
            raise MatchNormalizationError("Player of match cannot be attributed to exactly one match team")
        matching[0]["evidence"]["playerOfMatch"] = True
        player_of_match.append(player_ref)

    participants = []
    for participant in context.participants.values():
        participant["observedSourceNames"] = sorted(participant["observedSourceNames"])
        for key, values in participant["evidence"].items():
            if isinstance(values, list) and key.endswith("InningsIndexes"):
                participant["evidence"][key] = sorted(values)
        participants.append(participant)
        if participant["sourceListStatus"] == "event_only":
            add_warning("event_only_participation", "Source event references a player outside official participant lists.")
        if participant["resolution"]["registryReviewStatus"] == "review_required":
            add_warning("known_registry_review_metadata", "An exact ingestion-safe identity has registry review metadata.")
    participants.sort(key=lambda item: (item["teamId"], item["officialListIndex"] is None, item["officialListIndex"] or -1, item["playerId"]))

    dates = _array(info["dates"], "info.dates")
    if not dates or any(not isinstance(value, str) or not value for value in dates):
        raise MatchNormalizationError("info.dates must be a non-empty array of strings")
    if info["match_type"] != "T20" or info["gender"] != "male" or info["team_type"] != "club":
        raise MatchNormalizationError("Unsupported match configuration")
    if info["overs"] != 20 or info["balls_per_over"] != 6:
        raise MatchNormalizationError("Unsupported scheduled overs or balls per over")

    document = {
        "schemaVersion": MATCH_SCHEMA_VERSION,
        "datasetVersion": DATASET_VERSION,
        "matchId": match_id,
        "provenance": {
            "sourceMatchId": match_id,
            "relativeSourcePath": relative_source_path,
            "sourceFileSha256": source_file_sha256,
            "sourceArchiveSchemaVersion": SOURCE_AUDIT_SCHEMA_VERSION,
            "sourceArchiveManifestHash": source_archive_manifest_hash,
            "identityRegistryVersion": identity_registry_version,
            "identityRegistryAggregateHash": identity_registry_aggregate_hash,
        },
        "sourceMeta": {
            "dataVersion": meta["data_version"],
            "revision": _integer(meta["revision"], "meta.revision", minimum=1),
            "created": _string(meta["created"], "meta.created"),
        },
        "competition": {
            "matchType": info["match_type"],
            "gender": info["gender"],
            "teamType": info["team_type"],
            "scheduledOvers": info["overs"],
            "ballsPerOver": info["balls_per_over"],
        },
        "season": {
            "sourceSeason": source_season,
            "sourceSeasonKey": source_season_key,
            "seasonId": season_id,
        },
        "dates": dates,
        "event": {
            "name": _string(event["name"], "info.event.name"),
            "matchNumber": match_number,
            "stage": stage,
        },
        "teams": normalized_teams,
        "venue": venue,
        "toss": toss,
        "outcome": outcome,
        "playerOfMatch": player_of_match,
        "officials": officials,
        "participants": participants,
        "innings": normalized_innings,
    }
    counts = {
        "normalInnings": counters["normalInnings"],
        "superOverInnings": counters["super_overInnings"],
        "deliveries": counters["deliveries"],
        "impactPlayerReplacements": counters["impactPlayerReplacements"],
        "concussionSubstitutes": counters["concussionSubstitutes"],
        "roleReplacements": counters["roleReplacements"],
        "substituteFieldingEvents": counters["substituteFieldingEvents"],
        "reviews": counters["reviews"],
        "dismissalKinds": dict(sorted(dismissal_counts.items())),
        "extrasOccurrences": dict(sorted(extras_occurrences.items())),
    }
    warnings.sort(key=lambda item: item["code"])
    return NormalizedMatch(document=document, warnings=warnings, counts=counts)
