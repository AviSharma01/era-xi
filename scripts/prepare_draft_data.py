from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any


POSITION_GROUPS: dict[str, tuple[int, ...]] = {
    "opener": (1, 2),
    "3": (3,),
    "4": (4,),
    "5": (5,),
    "6": (6,),
    "7": (7,),
    "8": (8,),
    "9": (9,),
    "10": (10,),
    "11": (11,),
}

# Provisional game-fit thresholds. Tune only after reviewing full-season outputs.
LOW_CONFIDENCE_BATTING_INNINGS = 4
NATURAL_POSITION_MIN_COUNT = 2
NATURAL_POSITION_MIN_SHARE = 0.35
ACCEPTABLE_POSITION_MIN_COUNT = 1
ACCEPTABLE_POSITION_MIN_SHARE = 0.15
FRONTLINE_BOWLER_MIN_BALLS = 180
FRONTLINE_BOWLER_MIN_WICKETS = 8
SECONDARY_BOWLER_MIN_BALLS = 60
SECONDARY_BOWLER_MIN_WICKETS = 3
BATTER_MIN_RUNS = 180
BATTER_MIN_INNINGS = 8
ALL_ROUNDER_MIN_RUNS = 120
AMBIGUOUS_BATTING_INNINGS_MAX = 3
AMBIGUOUS_BOWLING_BALLS_MAX = 36


@dataclass(frozen=True)
class ManualOverride:
    country: str | None = None
    wicketkeeper: bool | None = None
    overseas: bool | None = None


@dataclass(frozen=True)
class LoadedPlayerMetadata:
    overrides: dict[str, ManualOverride]
    rows_loaded: int
    invalid_rows: list[dict[str, Any]]
    duplicate_player_ids: list[dict[str, Any]]


def load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text())


def load_manual_overrides(path: Path) -> dict[str, ManualOverride]:
    raw = load_json(path, {})
    players = raw.get("players", raw) if isinstance(raw, dict) else {}
    overrides: dict[str, ManualOverride] = {}
    for player_id, values in players.items():
        if not isinstance(values, dict):
            continue
        overrides[player_id] = ManualOverride(
            country=values.get("country"),
            wicketkeeper=values.get("wicketkeeper"),
            overseas=values.get("overseas"),
        )
    return overrides


def load_player_metadata(path: Path) -> dict[str, ManualOverride]:
    return load_player_metadata_with_validation(path).overrides


def load_player_metadata_with_validation(path: Path) -> LoadedPlayerMetadata:
    raw = load_json(path, [])
    rows = raw.get("players", raw) if isinstance(raw, dict) else raw
    if not isinstance(rows, list):
        rows = []
    overrides: dict[str, ManualOverride] = {}
    invalid_rows: list[dict[str, Any]] = []
    duplicate_player_ids: list[dict[str, Any]] = []
    seen_player_ids: set[str] = set()
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            invalid_rows.append({"rowIndex": index, "field": "row", "value": row, "reason": "row must be an object"})
            continue
        player_id = row.get("playerId")
        if not isinstance(player_id, str) or not player_id:
            invalid_rows.append(
                {"rowIndex": index, "field": "playerId", "value": player_id, "reason": "playerId must be a string"}
            )
            continue
        if player_id in seen_player_ids:
            duplicate_player_ids.append({"rowIndex": index, "playerId": player_id, "name": row.get("name")})
            continue
        seen_player_ids.add(player_id)
        country = row.get("country")
        is_wicketkeeper = row.get("isWicketkeeper")
        is_overseas = row.get("isOverseas")
        if country is not None and (not isinstance(country, str) or not country.strip()):
            invalid_rows.append(
                {"rowIndex": index, "playerId": player_id, "field": "country", "value": country, "reason": "country must be a non-empty string or null"}
            )
            country = None
        if is_wicketkeeper is not None and not isinstance(is_wicketkeeper, bool):
            invalid_rows.append(
                {"rowIndex": index, "playerId": player_id, "field": "isWicketkeeper", "value": is_wicketkeeper, "reason": "isWicketkeeper must be true, false, or null"}
            )
            is_wicketkeeper = None
        if is_overseas is not None and not isinstance(is_overseas, bool):
            invalid_rows.append(
                {"rowIndex": index, "playerId": player_id, "field": "isOverseas", "value": is_overseas, "reason": "isOverseas must be true, false, or null"}
            )
            is_overseas = None
        overrides[player_id] = ManualOverride(
            country=country,
            wicketkeeper=is_wicketkeeper,
            overseas=is_overseas,
        )
    return LoadedPlayerMetadata(
        overrides=overrides,
        rows_loaded=len(rows),
        invalid_rows=invalid_rows,
        duplicate_player_ids=duplicate_player_ids,
    )


def merge_manual_overrides(*sources: dict[str, ManualOverride]) -> dict[str, ManualOverride]:
    merged: dict[str, ManualOverride] = {}
    for source in sources:
        for player_id, override in source.items():
            current = merged.get(player_id, ManualOverride())
            merged[player_id] = ManualOverride(
                country=override.country if override.country is not None else current.country,
                wicketkeeper=override.wicketkeeper if override.wicketkeeper is not None else current.wicketkeeper,
                overseas=override.overseas if override.overseas is not None else current.overseas,
            )
    return merged


def group_counts(position_counts: dict[str, int]) -> dict[str, int]:
    return {
        group: sum(int(position_counts.get(str(position), 0)) for position in positions)
        for group, positions in POSITION_GROUPS.items()
    }


def positions_for_groups(groups: list[str]) -> list[int]:
    positions: list[int] = []
    for group in groups:
        positions.extend(POSITION_GROUPS[group])
    return sorted(set(positions))


def natural_groups(grouped_counts: dict[str, int], innings_batted: int) -> list[str]:
    if innings_batted == 0:
        return []
    max_count = max(grouped_counts.values(), default=0)
    groups = [
        group
        for group, count in grouped_counts.items()
        if count > 0
        and count == max_count
        and count >= NATURAL_POSITION_MIN_COUNT
        and count / innings_batted >= NATURAL_POSITION_MIN_SHARE
    ]
    if groups:
        return groups
    return [group for group, count in grouped_counts.items() if count > 0 and count == max_count]


def acceptable_groups(grouped_counts: dict[str, int], innings_batted: int, natural: list[str]) -> list[str]:
    if innings_batted == 0:
        return []
    groups = [
        group
        for group, count in grouped_counts.items()
        if count >= ACCEPTABLE_POSITION_MIN_COUNT and count / innings_batted >= ACCEPTABLE_POSITION_MIN_SHARE
    ]
    return sorted(set(groups + natural), key=lambda group: list(POSITION_GROUPS).index(group))


def derive_positions(
    grouped_counts: dict[str, int],
    innings_batted: int,
    role: str,
    bowling_strength: str,
) -> tuple[list[int], list[int], str]:
    if innings_batted > 0:
        natural = natural_groups(grouped_counts, innings_batted)
        acceptable = acceptable_groups(grouped_counts, innings_batted, natural)
        return positions_for_groups(natural), positions_for_groups(acceptable), "observed"
    if role == "bowler":
        return [9, 10, 11], [8, 9, 10, 11], "role_fallback"
    if role == "bowling_all_rounder":
        return [7, 8, 9], [7, 8, 9], "role_fallback"
    return [], [], "role_fallback"


def position_confidence(player_season: dict[str, Any]) -> str:
    return "low" if player_season["inningsBatted"] < LOW_CONFIDENCE_BATTING_INNINGS else "medium"


def bowling_option_strength(player_season: dict[str, Any]) -> str:
    balls = player_season["legalBallsBowled"]
    wickets = player_season["wickets"]
    if balls >= FRONTLINE_BOWLER_MIN_BALLS or wickets >= FRONTLINE_BOWLER_MIN_WICKETS:
        return "frontline"
    if balls >= SECONDARY_BOWLER_MIN_BALLS or wickets >= SECONDARY_BOWLER_MIN_WICKETS:
        return "secondary"
    if balls > 0:
        return "part_time"
    return "none"


def is_batting_contributor(player_season: dict[str, Any]) -> bool:
    return player_season["runs"] >= BATTER_MIN_RUNS or player_season["inningsBatted"] >= BATTER_MIN_INNINGS


def season_role(player_season: dict[str, Any], is_wicketkeeper: bool, bowling_strength: str) -> str:
    batting = is_batting_contributor(player_season)
    all_round_batting = player_season["runs"] >= ALL_ROUNDER_MIN_RUNS
    if is_wicketkeeper and batting:
        return "wicketkeeper_batter"
    if bowling_strength == "frontline":
        if all_round_batting:
            return "bowling_all_rounder"
        return "bowler"
    if bowling_strength in {"secondary", "part_time"} and batting:
        return "batting_all_rounder"
    if batting or player_season["runs"] > 0:
        return "batter"
    return "bowler"


def displayed_stats(player_season: dict[str, Any]) -> dict[str, Any]:
    dismissals = player_season["dismissals"]
    balls_faced = player_season["ballsFaced"]
    legal_balls_bowled = player_season["legalBallsBowled"]
    return {
        "matches": player_season["matchesPlayed"],
        "inningsBatted": player_season["inningsBatted"],
        "runs": player_season["runs"],
        "ballsFaced": balls_faced,
        "battingAverage": round(player_season["runs"] / dismissals, 2) if dismissals else None,
        "strikeRate": round(player_season["runs"] * 100 / balls_faced, 2) if balls_faced else None,
        "wickets": player_season["wickets"],
        "legalBallsBowled": legal_balls_bowled,
        "runsConceded": player_season["runsConceded"],
        "economy": round(player_season["runsConceded"] * 6 / legal_balls_bowled, 2) if legal_balls_bowled else None,
    }


def is_ambiguous_role(player_season: dict[str, Any], role: str, bowling_strength: str) -> bool:
    if role == "bowler":
        return bowling_strength == "none"
    return (
        player_season["inningsBatted"] <= AMBIGUOUS_BATTING_INNINGS_MAX
        and player_season["legalBallsBowled"] <= AMBIGUOUS_BOWLING_BALLS_MAX
    )


def build_draft_dataset(
    player_seasons: list[dict[str, Any]],
    overrides: dict[str, ManualOverride],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    eligible = [item for item in player_seasons if item["draftEligible"]]
    draft_players: list[dict[str, Any]] = []
    review = {
        "playersMissingCountry": [],
        "playersMissingOverseasStatus": [],
        "playersMissingWicketkeeperConfirmationWhereRelevant": [],
        "lowConfidencePositions": [],
        "ambiguousSeasonRoles": [],
        "twoMatchEligiblePlayerSeasons": [],
    }

    for player_season in eligible:
        override = overrides.get(player_season["playerId"], ManualOverride())
        grouped_counts = group_counts(player_season["battingPositionCounts"])
        confidence = position_confidence(player_season)
        stumping_evidence = player_season["stumpingBasedWicketkeeperEvidence"]["hasEvidence"]
        wicketkeeper_status = override.wicketkeeper if override.wicketkeeper is not None else (True if stumping_evidence else None)
        wicketkeeper_source = (
            "manual"
            if override.wicketkeeper is not None
            else ("stumping_evidence" if stumping_evidence else "unknown")
        )
        overseas_status = override.overseas
        overseas_source = "manual" if override.overseas is not None else "unknown"
        country = override.country
        country_source = "manual" if override.country is not None else "unknown"
        bowling_strength = bowling_option_strength(player_season)
        role = season_role(player_season, wicketkeeper_status is True, bowling_strength)
        natural_positions, acceptable_positions, position_basis = derive_positions(
            grouped_counts,
            player_season["inningsBatted"],
            role,
            bowling_strength,
        )
        draft_item = {
            **player_season,
            "battingPositionGroupCounts": grouped_counts,
            "naturalPositions": natural_positions,
            "acceptablePositions": acceptable_positions,
            "positionBasis": position_basis,
            "positionConfidence": confidence,
            "seasonRole": role,
            "bowlingOptionStrength": bowling_strength,
            "displayedStats": displayed_stats(player_season),
            "country": country,
            "countrySource": country_source,
            "isWicketkeeper": wicketkeeper_status,
            "wicketkeeperStatus": wicketkeeper_status,
            "wicketkeeperStatusSource": wicketkeeper_source,
            "isOverseas": overseas_status,
            "overseasStatus": overseas_status,
            "overseasStatusSource": overseas_source,
        }
        draft_players.append(draft_item)

        if country is None:
            review["playersMissingCountry"].append(review_entry(player_season))
        if overseas_status is None:
            review["playersMissingOverseasStatus"].append(review_entry(player_season))
        if stumping_evidence and override.wicketkeeper is None:
            review["playersMissingWicketkeeperConfirmationWhereRelevant"].append(review_entry(player_season))
        if confidence == "low":
            review["lowConfidencePositions"].append(
                {**review_entry(player_season), "inningsBatted": player_season["inningsBatted"]}
            )
        if is_ambiguous_role(player_season, role, bowling_strength):
            review["ambiguousSeasonRoles"].append(
                {
                    **review_entry(player_season),
                    "seasonRole": role,
                    "bowlingOptionStrength": bowling_strength,
                    "inningsBatted": player_season["inningsBatted"],
                    "legalBallsBowled": player_season["legalBallsBowled"],
                }
            )
        if player_season["matchesPlayed"] == 2:
            review["twoMatchEligiblePlayerSeasons"].append(review_entry(player_season))

    draft_players.sort(key=lambda item: (item["season"], item["franchise"], item["name"], item["playerId"]))
    for key, values in review.items():
        values.sort(key=lambda item: (item["season"], item["franchise"], item["name"], item["playerId"]))
    return draft_players, review


def review_entry(player_season: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": player_season["id"],
        "playerId": player_season["playerId"],
        "name": player_season["name"],
        "franchise": player_season["franchise"],
        "sourceSeason": player_season["sourceSeason"],
        "season": player_season["season"],
        "matchesPlayed": player_season["matchesPlayed"],
    }


def prepare_draft_outputs(
    processed_dir: Path,
    manual_overrides_path: Path,
    metadata_template_path: Path = Path("data/manual/player_metadata_template.json"),
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    player_seasons = load_json(processed_dir / "player_seasons.json", [])
    player_metadata = load_player_metadata_with_validation(metadata_template_path)
    overrides = merge_manual_overrides(
        load_manual_overrides(manual_overrides_path),
        player_metadata.overrides,
    )
    draft_players, review = build_draft_dataset(player_seasons, overrides)
    eligible_player_ids = {player["playerId"] for player in draft_players}
    unmatched_metadata_rows = [
        {"playerId": player_id}
        for player_id in sorted(player_metadata.overrides)
        if player_id not in eligible_player_ids
    ]
    matched_metadata_rows = len(player_metadata.overrides) - len(unmatched_metadata_rows)
    review_summary = {
        "eligiblePlayerSeasons": len(draft_players),
        "playersMissingCountry": len(review["playersMissingCountry"]),
        "playersMissingOverseasStatus": len(review["playersMissingOverseasStatus"]),
        "playersMissingWicketkeeperConfirmationWhereRelevant": len(
            review["playersMissingWicketkeeperConfirmationWhereRelevant"]
        ),
        "lowConfidencePositions": len(review["lowConfidencePositions"]),
        "ambiguousSeasonRoles": len(review["ambiguousSeasonRoles"]),
        "twoMatchEligiblePlayerSeasons": len(review["twoMatchEligiblePlayerSeasons"]),
        "manualMetadataRowsLoaded": player_metadata.rows_loaded,
        "manualMetadataRowsMatched": matched_metadata_rows,
        "manualMetadataUnmatchedRows": len(unmatched_metadata_rows),
        "manualMetadataDuplicatePlayerIds": len(player_metadata.duplicate_player_ids),
        "manualMetadataInvalidValues": len(player_metadata.invalid_rows),
        "draftPlayerSeasonsMissingCountry": len(review["playersMissingCountry"]),
        "draftPlayerSeasonsMissingIsOverseas": len(review["playersMissingOverseasStatus"]),
        "draftPlayerSeasonsMissingIsWicketkeeper": sum(1 for player in draft_players if player["isWicketkeeper"] is None),
    }
    metadata_validation = {
        "path": str(metadata_template_path),
        "rowsLoaded": player_metadata.rows_loaded,
        "rowsMatched": matched_metadata_rows,
        "unmatchedRows": unmatched_metadata_rows,
        "duplicatePlayerIds": player_metadata.duplicate_player_ids,
        "invalidValues": player_metadata.invalid_rows,
        "unresolvedMetadata": {
            "country": review["playersMissingCountry"],
            "isOverseas": review["playersMissingOverseasStatus"],
            "isWicketkeeper": [review_entry(player) for player in draft_players if player["isWicketkeeper"] is None],
        },
    }
    return draft_players, {"summary": review_summary, "manualMetadata": metadata_validation, **review}


def build_player_metadata_template(
    draft_players: list[dict[str, Any]],
    existing_template: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    by_player_id: dict[str, str] = {}
    for player in draft_players:
        by_player_id.setdefault(player["playerId"], player["name"])
    existing = {
        row["playerId"]: row
        for row in existing_template or []
        if isinstance(row, dict) and row.get("playerId")
    }
    return [
        {
            "playerId": player_id,
            "name": by_player_id[player_id],
            "country": existing.get(player_id, {}).get("country"),
            "isOverseas": existing.get(player_id, {}).get("isOverseas"),
            "isWicketkeeper": existing.get(player_id, {}).get("isWicketkeeper"),
        }
        for player_id in sorted(by_player_id, key=lambda item: by_player_id[item])
    ]


def write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, indent=2) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser(description="Prepare game-ready draft player-season data.")
    parser.add_argument("--processed-dir", type=Path, default=Path("data/processed/2016"))
    parser.add_argument("--manual-overrides", type=Path, default=Path("data/manual/player_overrides.json"))
    parser.add_argument("--metadata-template", type=Path, default=Path("data/manual/player_metadata_template.json"))
    args = parser.parse_args()

    draft_players, review = prepare_draft_outputs(args.processed_dir, args.manual_overrides, args.metadata_template)
    write_json(args.processed_dir / "draft_player_seasons.json", draft_players)
    write_json(args.processed_dir / "draft_player_seasons_review.json", review)


if __name__ == "__main__":
    main()
