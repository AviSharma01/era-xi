from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


BOWLER_WICKET_KINDS = {
    "bowled",
    "caught",
    "caught and bowled",
    "hit wicket",
    "lbw",
    "stumped",
}

NON_DISMISSAL_KINDS = {"retired hurt", "retired not out", "retired notout"}


def normalize_season(source_season: str) -> int:
    if "/" in source_season:
        start, end = source_season.split("/", 1)
        if len(end) == 2:
            start_year = int(start)
            candidate = (start_year // 100) * 100 + int(end)
            if candidate < start_year:
                candidate += 100
            return candidate
        return int(end)
    return int(source_season)


def is_legal_delivery(delivery: dict[str, Any]) -> bool:
    extras = delivery.get("extras", {})
    return "wides" not in extras and "noballs" not in extras


def batter_ball_counts(delivery: dict[str, Any]) -> bool:
    return is_legal_delivery(delivery)


def bowler_runs_conceded(delivery: dict[str, Any]) -> int:
    extras = delivery.get("extras", {})
    non_bowler_extras = extras.get("byes", 0) + extras.get("legbyes", 0) + extras.get("penalty", 0)
    return int(delivery["runs"]["total"]) - int(non_bowler_extras)


def stable_player_season_id(player_id: str, season: int, franchise: str) -> str:
    slug = franchise.lower().replace("&", "and")
    slug = "".join(ch if ch.isalnum() else "-" for ch in slug)
    slug = "-".join(part for part in slug.split("-") if part)
    return f"{player_id}-{season}-{slug}"


@dataclass
class PlayerRecord:
    id: str
    name: str
    names: set[str] = field(default_factory=set)


@dataclass
class PlayerSeason:
    player_id: str
    name: str
    franchise: str
    source_season: str
    season: int
    matches_played: int = 0
    innings_batted: int = 0
    runs: int = 0
    balls_faced: int = 0
    dismissals: int = 0
    wickets: int = 0
    legal_balls_bowled: int = 0
    runs_conceded: int = 0
    batting_position_counts: Counter[int] = field(default_factory=Counter)
    stumping_wicketkeeper_dismissals: int = 0

    @property
    def id(self) -> str:
        return stable_player_season_id(self.player_id, self.season, self.franchise)

    def to_json(self) -> dict[str, Any]:
        batting_position_counts = {str(position): self.batting_position_counts.get(position, 0) for position in range(1, 12)}
        max_count = max(batting_position_counts.values(), default=0)
        preferred_positions = [
            int(position)
            for position, count in batting_position_counts.items()
            if count > 0 and count == max_count
        ]
        return {
            "id": self.id,
            "playerId": self.player_id,
            "name": self.name,
            "franchise": self.franchise,
            "sourceSeason": self.source_season,
            "season": self.season,
            "matchesPlayed": self.matches_played,
            "inningsBatted": self.innings_batted,
            "runs": self.runs,
            "ballsFaced": self.balls_faced,
            "dismissals": self.dismissals,
            "wickets": self.wickets,
            "legalBallsBowled": self.legal_balls_bowled,
            "runsConceded": self.runs_conceded,
            "battingPositionCounts": batting_position_counts,
            "naturalOpener": self.batting_position_counts.get(1, 0) + self.batting_position_counts.get(2, 0) > 0,
            "preferredBattingPositions": preferred_positions,
            "stumpingBasedWicketkeeperEvidence": {
                "dismissals": self.stumping_wicketkeeper_dismissals,
                "hasEvidence": self.stumping_wicketkeeper_dismissals > 0,
            },
            "draftEligible": self.matches_played >= 2,
        }


class Aggregator:
    def __init__(self) -> None:
        self.players: dict[str, PlayerRecord] = {}
        self.player_seasons: dict[tuple[str, str, str], PlayerSeason] = {}
        self.franchise_players: dict[tuple[str, str, int], set[str]] = defaultdict(set)
        self.validation: dict[str, Any] = {
            "sourceFiles": [],
            "matchesProcessed": 0,
            "requestedSeason": None,
            "matchesFoundForRequestedSeason": 0,
            "matchesWithMoreThanTwoInnings": [],
            "extraInningsIgnored": 0,
            "missingRegistryEntries": [],
            "observedWicketKinds": {},
            "uncreditedDismissalKinds": {},
            "lowFrequencyBattingPositions": [],
            "playersListedButNeverBattingOrBowling": [],
            "manualOverrides": {
                "supported": True,
                "applied": False,
                "note": "No manual correction files are read by this first sample pipeline.",
            },
        }
        self._observed_wicket_kinds: Counter[str] = Counter()
        self._uncredited_dismissal_kinds: Counter[str] = Counter()
        self._missing_registry_entries: set[tuple[str, str, str]] = set()
        self._listed_without_bat_or_bowl: list[dict[str, Any]] = []

    def player_id_for(self, name: str, registry: dict[str, str], file_name: str, team: str = "") -> str:
        player_id = registry.get(name)
        if player_id is None:
            player_id = f"unregistered:{name}"
            self._missing_registry_entries.add((file_name, team, name))
        record = self.players.setdefault(player_id, PlayerRecord(id=player_id, name=name))
        record.names.add(name)
        if name < record.name:
            record.name = name
        return player_id

    def player_season_for(
        self,
        player_id: str,
        name: str,
        franchise: str,
        source_season: str,
        season: int,
    ) -> PlayerSeason:
        key = (player_id, source_season, franchise)
        if key not in self.player_seasons:
            self.player_seasons[key] = PlayerSeason(
                player_id=player_id,
                name=name,
                franchise=franchise,
                source_season=source_season,
                season=season,
            )
        return self.player_seasons[key]

    def process_match(self, path: Path) -> None:
        data = json.loads(path.read_text())
        self.process_match_data(data, str(path))

    def process_match_data(self, data: dict[str, Any], file_name: str) -> None:
        info = data["info"]
        registry = info.get("registry", {}).get("people", {})
        source_season = str(info["season"])
        season = normalize_season(source_season)

        self.validation["sourceFiles"].append(file_name)
        self.validation["matchesProcessed"] += 1

        innings = data.get("innings", [])
        if len(innings) > 2:
            self.validation["matchesWithMoreThanTwoInnings"].append(
                {"file": file_name, "inningsCount": len(innings)}
            )
            self.validation["extraInningsIgnored"] += len(innings) - 2

        player_team: dict[str, str] = {}
        listed_players: dict[str, tuple[str, str]] = {}
        for franchise, names in info.get("players", {}).items():
            for name in names:
                player_id = self.player_id_for(name, registry, file_name, franchise)
                player_team[player_id] = franchise
                listed_players[player_id] = (name, franchise)
                player_season = self.player_season_for(player_id, name, franchise, source_season, season)
                player_season.matches_played += 1
                self.franchise_players[(franchise, source_season, season)].add(player_season.id)

        active_player_ids: set[str] = set()
        for innings_data in innings[:2]:
            active_player_ids.update(
                self.process_innings(innings_data, registry, file_name, source_season, season, player_team)
            )

        for player_id, (name, franchise) in listed_players.items():
            if player_id not in active_player_ids:
                self._listed_without_bat_or_bowl.append(
                    {
                        "file": file_name,
                        "sourceSeason": source_season,
                        "season": season,
                        "franchise": franchise,
                        "playerId": player_id,
                        "name": name,
                    }
                )

    def process_innings(
        self,
        innings_data: dict[str, Any],
        registry: dict[str, str],
        file_name: str,
        source_season: str,
        season: int,
        player_team: dict[str, str],
    ) -> set[str]:
        batting_team = innings_data["team"]
        batting_order: list[str] = []
        batting_order_seen: set[str] = set()
        active_player_ids: set[str] = set()

        for over in innings_data.get("overs", []):
            for delivery in over.get("deliveries", []):
                for role in ("batter", "non_striker"):
                    name = delivery.get(role)
                    if name:
                        active_player_ids.add(self.player_id_for(name, registry, file_name, batting_team))
                    if name and name not in batting_order_seen:
                        batting_order_seen.add(name)
                        batting_order.append(name)
                        player_id = self.player_id_for(name, registry, file_name, batting_team)
                        player_season = self.player_season_for(player_id, name, batting_team, source_season, season)
                        player_season.innings_batted += 1
                        player_season.batting_position_counts[len(batting_order)] += 1

                batter = delivery["batter"]
                batter_id = self.player_id_for(batter, registry, file_name, batting_team)
                batter_season = self.player_season_for(batter_id, batter, batting_team, source_season, season)
                batter_season.runs += int(delivery["runs"]["batter"])
                if batter_ball_counts(delivery):
                    batter_season.balls_faced += 1

                bowler = delivery["bowler"]
                bowler_id = self.player_id_for(bowler, registry, file_name)
                active_player_ids.add(bowler_id)
                bowling_team = player_team.get(bowler_id)
                if bowling_team is None:
                    bowling_team = next((team for team in player_team.values() if team != batting_team), "")
                bowler_season = self.player_season_for(bowler_id, bowler, bowling_team, source_season, season)
                if is_legal_delivery(delivery):
                    bowler_season.legal_balls_bowled += 1
                bowler_season.runs_conceded += bowler_runs_conceded(delivery)

                for wicket in delivery.get("wickets", []):
                    kind = wicket["kind"]
                    self._observed_wicket_kinds[kind] += 1
                    player_out = wicket.get("player_out")
                    if player_out and kind not in NON_DISMISSAL_KINDS:
                        out_id = self.player_id_for(player_out, registry, file_name, batting_team)
                        out_season = self.player_season_for(out_id, player_out, batting_team, source_season, season)
                        out_season.dismissals += 1
                    if kind in BOWLER_WICKET_KINDS:
                        bowler_season.wickets += 1
                    else:
                        self._uncredited_dismissal_kinds[kind] += 1
                    if kind == "stumped":
                        for fielder in wicket.get("fielders", []):
                            keeper_name = fielder.get("name")
                            if keeper_name:
                                keeper_id = self.player_id_for(keeper_name, registry, file_name)
                                keeper_team = player_team.get(keeper_id, "")
                                keeper_season = self.player_season_for(
                                    keeper_id,
                                    keeper_name,
                                    keeper_team,
                                    source_season,
                                    season,
                                )
                                keeper_season.stumping_wicketkeeper_dismissals += 1
        return active_player_ids

    def build_outputs(self) -> dict[str, Any]:
        players = [
            {
                "id": record.id,
                "name": record.name,
                "names": sorted(record.names),
            }
            for record in self.players.values()
        ]
        players.sort(key=lambda item: (item["name"], item["id"]))

        player_seasons = [player_season.to_json() for player_season in self.player_seasons.values()]
        player_seasons.sort(key=lambda item: (item["season"], item["franchise"], item["name"], item["playerId"]))

        franchise_seasons = []
        by_id = {item["id"]: item for item in player_seasons}
        for (franchise, source_season, season), ids in self.franchise_players.items():
            sorted_ids = sorted(ids, key=lambda player_season_id: by_id[player_season_id]["name"])
            franchise_seasons.append(
                {
                    "id": f"{season}-{franchise.lower().replace(' ', '-')}",
                    "franchise": franchise,
                    "sourceSeason": source_season,
                    "season": season,
                    "playerSeasonIds": sorted_ids,
                    "draftEligiblePlayerSeasonIds": [
                        player_season_id
                        for player_season_id in sorted_ids
                        if by_id[player_season_id]["draftEligible"]
                    ],
                }
            )
        franchise_seasons.sort(key=lambda item: (item["season"], item["franchise"]))

        validation = dict(self.validation)
        validation["sourceFiles"] = sorted(validation["sourceFiles"])
        validation["observedWicketKinds"] = dict(sorted(self._observed_wicket_kinds.items()))
        validation["uncreditedDismissalKinds"] = dict(sorted(self._uncredited_dismissal_kinds.items()))
        validation["missingRegistryEntries"] = [
            {"file": file_name, "team": team, "name": name}
            for file_name, team, name in sorted(self._missing_registry_entries)
        ]
        validation["playersCount"] = len(players)
        validation["uniquePlayersCount"] = len(players)
        validation["playerSeasonsCount"] = len(player_seasons)
        validation["franchiseSeasonsCount"] = len(franchise_seasons)
        validation["draftEligiblePlayerSeasonsCount"] = sum(1 for item in player_seasons if item["draftEligible"])
        validation["playerSeasonsExcludedByTwoMatchThreshold"] = sum(
            1 for item in player_seasons if not item["draftEligible"]
        )
        validation["playersMissingRegistryIdsCount"] = len(
            {entry["name"] for entry in validation["missingRegistryEntries"]}
        )
        validation["matchesFoundForRequestedSeason"] = validation["matchesProcessed"]
        validation["lowFrequencyBattingPositions"] = low_frequency_batting_positions(player_seasons)
        validation["playersListedButNeverBattingOrBowling"] = sorted(
            self._listed_without_bat_or_bowl,
            key=lambda item: (item["season"], item["franchise"], item["name"], item["file"]),
        )
        validation["warnings"] = []
        if validation["matchesWithMoreThanTwoInnings"]:
            validation["warnings"].append("Some matches have more than two innings; extra innings were ignored.")
        if validation["missingRegistryEntries"]:
            validation["warnings"].append("Some player names were missing from info.registry.people.")
        if validation["playersListedButNeverBattingOrBowling"]:
            validation["warnings"].append("Some listed players never batted or bowled in the first two innings.")

        outputs = {
            "players": players,
            "player_seasons": player_seasons,
            "franchise_seasons": franchise_seasons,
            "validation_summary": validation,
        }
        validate_outputs(outputs)
        return outputs


def low_frequency_batting_positions(player_seasons: list[dict[str, Any]]) -> list[dict[str, Any]]:
    entries = []
    for player_season in player_seasons:
        for position, count in player_season["battingPositionCounts"].items():
            if count == 1:
                entries.append(
                    {
                        "playerSeasonId": player_season["id"],
                        "playerId": player_season["playerId"],
                        "name": player_season["name"],
                        "franchise": player_season["franchise"],
                        "sourceSeason": player_season["sourceSeason"],
                        "season": player_season["season"],
                        "position": int(position),
                        "count": count,
                    }
                )
    return sorted(entries, key=lambda item: (item["season"], item["franchise"], item["name"], item["position"]))


def validate_outputs(outputs: dict[str, Any]) -> None:
    player_keys = {"id", "name", "names"}
    player_season_keys = {
        "id",
        "playerId",
        "name",
        "franchise",
        "sourceSeason",
        "season",
        "matchesPlayed",
        "inningsBatted",
        "runs",
        "ballsFaced",
        "dismissals",
        "wickets",
        "legalBallsBowled",
        "runsConceded",
        "battingPositionCounts",
        "naturalOpener",
        "preferredBattingPositions",
        "stumpingBasedWicketkeeperEvidence",
        "draftEligible",
    }
    franchise_season_keys = {
        "id",
        "franchise",
        "sourceSeason",
        "season",
        "playerSeasonIds",
        "draftEligiblePlayerSeasonIds",
    }

    for player in outputs["players"]:
        if set(player) != player_keys:
            raise ValueError(f"Invalid player keys: {player}")
    for player_season in outputs["player_seasons"]:
        if set(player_season) != player_season_keys:
            raise ValueError(f"Invalid player-season keys: {player_season}")
        if set(player_season["battingPositionCounts"]) != {str(position) for position in range(1, 12)}:
            raise ValueError(f"Invalid batting-position keys: {player_season['id']}")
    for franchise_season in outputs["franchise_seasons"]:
        if set(franchise_season) != franchise_season_keys:
            raise ValueError(f"Invalid franchise-season keys: {franchise_season}")


def process_raw_matches(raw_dir: Path, season: int | None = None) -> dict[str, Any]:
    aggregator = Aggregator()
    aggregator.validation["requestedSeason"] = season
    for path in sorted(raw_dir.glob("*.json")):
        data = json.loads(path.read_text())
        source_season = str(data["info"]["season"])
        normalized_season = normalize_season(source_season)
        if season is not None and normalized_season != season:
            continue
        aggregator.process_match_data(data, str(path))
    return aggregator.build_outputs()


def process_raw_sample(raw_dir: Path) -> dict[str, Any]:
    return process_raw_matches(raw_dir)


def resolve_output_dir(output_dir: Path, season: int | None) -> Path:
    if season is None:
        return output_dir
    if output_dir == Path("data/processed"):
        return output_dir / str(season)
    return output_dir


def write_outputs(outputs: dict[str, Any], output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    files = {
        "players.json": outputs["players"],
        "player_seasons.json": outputs["player_seasons"],
        "franchise_seasons.json": outputs["franchise_seasons"],
        "validation_summary.json": outputs["validation_summary"],
    }
    for file_name, data in files.items():
        (output_dir / file_name).write_text(json.dumps(data, indent=2) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser(description="Process Cricsheet IPL JSON into static draft data.")
    parser.add_argument("--raw-dir", type=Path, default=Path("data/raw/sample"))
    parser.add_argument("--output-dir", type=Path, default=Path("data/processed"))
    parser.add_argument("--season", type=int, help="Normalized IPL season year to process, such as 2016.")
    args = parser.parse_args()

    outputs = process_raw_matches(args.raw_dir, season=args.season)
    write_outputs(outputs, resolve_output_dir(args.output_dir, args.season))


if __name__ == "__main__":
    main()
