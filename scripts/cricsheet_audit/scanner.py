from __future__ import annotations

import hashlib
import json
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable


AUDIT_SCHEMA_VERSION = "cricsheet-ipl-archive-audit/v1"
SUPPORTED_DATA_VERSIONS = {"1.2.0"}
AUDIT_EDITION_DISPLAY_YEARS = {
    "2007/08": 2008,
    "2009/10": 2010,
    "2020/21": 2020,
}


class AuditError(ValueError):
    """Raised when source data cannot be audited without guessing or repair."""


def infer_edition_display_year(source_season: str) -> int:
    if source_season in AUDIT_EDITION_DISPLAY_YEARS:
        return AUDIT_EDITION_DISPLAY_YEARS[source_season]
    try:
        return int(source_season)
    except ValueError as error:
        raise AuditError(f"No audit-only display-year mapping for source season {source_season!r}") from error


def discover_source_files(raw_dir: Path) -> list[tuple[int, Path, str]]:
    if not raw_dir.is_dir():
        raise AuditError(f"Raw archive directory does not exist: {raw_dir}")

    discovered: list[tuple[int, Path, str]] = []
    ids: dict[int, str] = {}
    paths = sorted(raw_dir.rglob("*"), key=lambda path: path.relative_to(raw_dir).as_posix())
    for path in paths:
        if not path.is_file() or path.suffix.lower() != ".json":
            continue
        relative_path = path.relative_to(raw_dir).as_posix()
        if not path.stem.isascii() or not path.stem.isdigit():
            raise AuditError(f"Cricsheet JSON filename must have a numeric stem: {relative_path}")
        match_id = int(path.stem)
        existing = ids.get(match_id)
        if existing is not None:
            raise AuditError(
                f"Duplicate numeric match ID {match_id}: {existing} and {relative_path}"
            )
        ids[match_id] = relative_path
        discovered.append((match_id, path, relative_path))
    return sorted(discovered, key=lambda item: (item[0], item[2]))


def _shape_key(value: dict[str, Any]) -> tuple[str, ...]:
    return tuple(sorted(value))


def _source_reference(match_id: str, source_path: str, **details: Any) -> dict[str, Any]:
    return {"matchId": match_id, "sourcePath": source_path, **details}


def _require_mapping(value: Any, location: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise AuditError(f"Expected object at {location}")
    return value


def _require_list(value: Any, location: str) -> list[Any]:
    if not isinstance(value, list):
        raise AuditError(f"Expected list at {location}")
    return value


def _require_keys(value: dict[str, Any], keys: Iterable[str], location: str) -> None:
    missing = sorted(set(keys) - set(value))
    if missing:
        raise AuditError(f"Missing required keys at {location}: {', '.join(missing)}")


@dataclass
class ArchiveScan:
    manifest_entries: list[dict[str, Any]] = field(default_factory=list)
    season_coverage: dict[str, dict[str, Any]] = field(default_factory=dict)
    schema: dict[str, Any] = field(default_factory=dict)
    anomalies: dict[str, Any] = field(default_factory=dict)
    identity: dict[str, Any] = field(default_factory=dict)
    inventories: dict[str, Any] = field(default_factory=dict)
    headline: dict[str, int] = field(default_factory=dict)


def scan_archive(raw_dir: Path) -> ArchiveScan:
    files = discover_source_files(raw_dir)
    if not files:
        raise AuditError(f"No numeric Cricsheet JSON files found in {raw_dir}")

    manifest_entries: list[dict[str, Any]] = []
    season_acc: dict[str, dict[str, Any]] = defaultdict(
        lambda: {
            "sourceFiles": 0,
            "matches": 0,
            "normalInnings": 0,
            "superOverInnings": 0,
            "teams": set(),
            "playerIds": set(),
            "venues": set(),
            "dates": [],
        }
    )
    schema_counters: dict[str, Counter[Any]] = {
        "dataVersions": Counter(),
        "revisions": Counter(),
        "topLevelKeyShapes": Counter(),
        "infoKeyShapes": Counter(),
        "inningsKeyShapes": Counter(),
        "eventUsage": Counter(),
    }
    creation_date_present = 0

    anomaly_lists: dict[str, list[dict[str, Any]]] = defaultdict(list)
    outcome_methods: dict[str, list[dict[str, Any]]] = defaultdict(list)
    participant_sizes: dict[int, list[dict[str, Any]]] = defaultdict(list)
    match_replacements: dict[str, list[dict[str, Any]]] = defaultdict(list)
    role_replacements: dict[str, list[dict[str, Any]]] = defaultdict(list)
    extras_counts: Counter[str] = Counter()
    extras_amounts: Counter[str] = Counter()
    extras_sources: dict[str, set[str]] = defaultdict(set)
    dismissal_counts: Counter[str] = Counter()
    dismissal_sources: dict[str, set[str]] = defaultdict(set)

    player_id_names: dict[str, set[str]] = defaultdict(set)
    player_id_sources: dict[str, set[str]] = defaultdict(set)
    player_name_ids: dict[str, set[str]] = defaultdict(set)
    unresolved: list[dict[str, Any]] = []
    delivery_absences: list[dict[str, Any]] = []
    absence_keys: set[tuple[str, str, str, str]] = set()

    inventory_acc: dict[str, dict[str, dict[str, Any]]] = {
        "teams": defaultdict(lambda: {"count": 0, "sources": set()}),
        "venues": defaultdict(lambda: {"count": 0, "sources": set()}),
        "cities": defaultdict(lambda: {"count": 0, "sources": set()}),
    }
    totals: Counter[str] = Counter()

    for _numeric_match_id, path, relative_path in files:
        raw_bytes = path.read_bytes()
        try:
            data = json.loads(raw_bytes)
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            raise AuditError(f"Malformed JSON in {relative_path}: {error}") from error

        data = _require_mapping(data, relative_path)
        _require_keys(data, ("meta", "info", "innings"), relative_path)
        meta = _require_mapping(data["meta"], f"{relative_path}.meta")
        info = _require_mapping(data["info"], f"{relative_path}.info")
        innings = _require_list(data["innings"], f"{relative_path}.innings")
        _require_keys(meta, ("data_version", "revision"), f"{relative_path}.meta")
        _require_keys(
            info,
            ("dates", "event", "outcome", "players", "registry", "season", "teams", "venue"),
            f"{relative_path}.info",
        )

        data_version = str(meta["data_version"])
        if data_version not in SUPPORTED_DATA_VERSIONS:
            raise AuditError(f"Unsupported Cricsheet data version {data_version!r} in {relative_path}")

        match_id = path.stem
        source_season = str(info["season"])
        display_year = infer_edition_display_year(source_season)
        dates = _require_list(info["dates"], f"{relative_path}.info.dates")
        if not dates or any(not isinstance(date, str) for date in dates):
            raise AuditError(f"Match dates must be a non-empty list of strings in {relative_path}")
        teams = _require_list(info["teams"], f"{relative_path}.info.teams")
        if any(not isinstance(team, str) for team in teams):
            raise AuditError(f"Team names must be strings in {relative_path}")
        venue = info["venue"]
        if not isinstance(venue, str):
            raise AuditError(f"Venue must be a string in {relative_path}")
        city = info.get("city")
        if city is not None and not isinstance(city, str):
            raise AuditError(f"City must be a string when supplied in {relative_path}")

        registry_container = _require_mapping(info["registry"], f"{relative_path}.info.registry")
        registry = _require_mapping(
            registry_container.get("people"), f"{relative_path}.info.registry.people"
        )
        if any(not isinstance(name, str) or not isinstance(identifier, str) for name, identifier in registry.items()):
            raise AuditError(f"Registry people must map names to string IDs in {relative_path}")
        players = _require_mapping(info["players"], f"{relative_path}.info.players")

        official_ids: set[str] = set()

        def resolve_reference(name: Any, category: str, location: str) -> str | None:
            if name is None:
                return None
            if not isinstance(name, str):
                unresolved.append(
                    _source_reference(match_id, relative_path, category=category, location=location, name=name)
                )
                return None
            identifier = registry.get(name)
            if identifier is None:
                unresolved.append(
                    _source_reference(match_id, relative_path, category=category, location=location, name=name)
                )
                return None
            return identifier

        for team, names_value in players.items():
            if not isinstance(team, str):
                raise AuditError(f"Player-list team must be a string in {relative_path}")
            names = _require_list(names_value, f"{relative_path}.info.players[{team!r}]")
            participant_sizes[len(names)].append(
                _source_reference(match_id, relative_path, team=team, participantCount=len(names))
            )
            for index, name in enumerate(names):
                identifier = resolve_reference(
                    name, "participant", f"info.players[{team!r}][{index}]"
                )
                if identifier is not None:
                    official_ids.add(identifier)
                    player_id_names[identifier].add(name)
                    player_id_sources[identifier].add(relative_path)
                    player_name_ids[name].add(identifier)

        if set(players) != set(teams):
            raise AuditError(
                f"info.players teams do not match info.teams in {relative_path}: "
                f"{sorted(players)} != {sorted(teams)}"
            )

        player_of_match = info.get("player_of_match")
        if player_of_match is None:
            anomaly_lists["missingPlayerOfMatch"].append(
                _source_reference(match_id, relative_path)
            )
        else:
            for index, name in enumerate(
                _require_list(player_of_match, f"{relative_path}.info.player_of_match")
            ):
                resolve_reference(name, "playerOfMatch", f"info.player_of_match[{index}]")

        for role, names_value in _require_mapping(
            info.get("officials", {}), f"{relative_path}.info.officials"
        ).items():
            for index, name in enumerate(
                _require_list(names_value, f"{relative_path}.info.officials[{role!r}]")
            ):
                resolve_reference(name, "official", f"info.officials[{role!r}][{index}]")

        normal_innings = 0
        super_over_innings = 0
        for innings_index, innings_value in enumerate(innings, start=1):
            innings_data = _require_mapping(
                innings_value, f"{relative_path}.innings[{innings_index - 1}]"
            )
            _require_keys(
                innings_data,
                ("team", "overs"),
                f"{relative_path}.innings[{innings_index - 1}]",
            )
            schema_counters["inningsKeyShapes"][_shape_key(innings_data)] += 1
            if innings_data.get("super_over") is True:
                super_over_innings += 1
            else:
                normal_innings += 1

            absent_hurt = _require_list(
                innings_data.get("absent_hurt", []),
                f"{relative_path}.innings[{innings_index - 1}].absent_hurt",
            )
            for absent_index, name in enumerate(absent_hurt):
                identifier = resolve_reference(
                    name,
                    "absentHurt",
                    f"innings[{innings_index - 1}].absent_hurt[{absent_index}]",
                )
                _record_delivery_absence(
                    identifier,
                    name,
                    "absentHurt",
                    match_id,
                    relative_path,
                    official_ids,
                    absence_keys,
                    delivery_absences,
                )

            miscounted = innings_data.get("miscounted_overs")
            if miscounted is not None:
                miscounted = _require_mapping(
                    miscounted, f"{relative_path}.innings[{innings_index - 1}].miscounted_overs"
                )
                anomaly_lists["miscountedOvers"].append(
                    _source_reference(
                        match_id,
                        relative_path,
                        inningsIndex=innings_index,
                        team=innings_data["team"],
                        miscountedOvers=miscounted,
                    )
                )
                for over_number, detail_value in miscounted.items():
                    detail = _require_mapping(
                        detail_value,
                        f"{relative_path}.innings[{innings_index - 1}].miscounted_overs[{over_number!r}]",
                    )
                    resolve_reference(
                        detail.get("umpire"),
                        "miscountedOverUmpire",
                        f"innings[{innings_index - 1}].miscounted_overs[{over_number!r}].umpire",
                    )

            overs = _require_list(
                innings_data["overs"], f"{relative_path}.innings[{innings_index - 1}].overs"
            )
            for over_index, over_value in enumerate(overs):
                over = _require_mapping(
                    over_value,
                    f"{relative_path}.innings[{innings_index - 1}].overs[{over_index}]",
                )
                _require_keys(
                    over,
                    ("over", "deliveries"),
                    f"{relative_path}.innings[{innings_index - 1}].overs[{over_index}]",
                )
                deliveries = _require_list(
                    over["deliveries"],
                    f"{relative_path}.innings[{innings_index - 1}].overs[{over_index}].deliveries",
                )
                for delivery_index, delivery_value in enumerate(deliveries):
                    delivery = _require_mapping(
                        delivery_value,
                        f"{relative_path}.innings[{innings_index - 1}].overs[{over_index}].deliveries[{delivery_index}]",
                    )
                    _require_keys(
                        delivery,
                        ("batter", "non_striker", "bowler", "runs"),
                        f"{relative_path}.innings[{innings_index - 1}].overs[{over_index}].deliveries[{delivery_index}]",
                    )
                    totals["deliveries"] += 1
                    extras = _require_mapping(
                        delivery.get("extras", {}),
                        f"{relative_path}.innings[{innings_index - 1}].overs[{over_index}].deliveries[{delivery_index}].extras",
                    )
                    if "wides" not in extras and "noballs" not in extras:
                        totals["legalDeliveries"] += 1
                    for extras_type, amount in extras.items():
                        extras_counts[extras_type] += 1
                        extras_amounts[extras_type] += int(amount)
                        extras_sources[extras_type].add(relative_path)

                    base_location = (
                        f"innings[{innings_index - 1}].overs[{over_index}].deliveries[{delivery_index}]"
                    )
                    for role in ("batter", "non_striker", "bowler"):
                        name = delivery[role]
                        identifier = resolve_reference(name, role, f"{base_location}.{role}")
                        _record_delivery_absence(
                            identifier,
                            name,
                            role,
                            match_id,
                            relative_path,
                            official_ids,
                            absence_keys,
                            delivery_absences,
                        )

                    review = delivery.get("review")
                    if review is not None:
                        review = _require_mapping(review, f"{relative_path}.{base_location}.review")
                        resolve_reference(review.get("batter"), "reviewBatter", f"{base_location}.review.batter")
                        resolve_reference(review.get("umpire"), "reviewUmpire", f"{base_location}.review.umpire")

                    wickets = _require_list(
                        delivery.get("wickets", []), f"{relative_path}.{base_location}.wickets"
                    )
                    for wicket_index, wicket_value in enumerate(wickets):
                        wicket = _require_mapping(
                            wicket_value,
                            f"{relative_path}.{base_location}.wickets[{wicket_index}]",
                        )
                        _require_keys(
                            wicket,
                            ("kind", "player_out"),
                            f"{relative_path}.{base_location}.wickets[{wicket_index}]",
                        )
                        kind = str(wicket["kind"])
                        dismissal_counts[kind] += 1
                        dismissal_sources[kind].add(relative_path)
                        totals["wickets"] += 1
                        player_out = wicket["player_out"]
                        identifier = resolve_reference(
                            player_out,
                            "wicketPlayerOut",
                            f"{base_location}.wickets[{wicket_index}].player_out",
                        )
                        _record_delivery_absence(
                            identifier,
                            player_out,
                            "wicketPlayerOut",
                            match_id,
                            relative_path,
                            official_ids,
                            absence_keys,
                            delivery_absences,
                        )
                        fielders = _require_list(
                            wicket.get("fielders", []),
                            f"{relative_path}.{base_location}.wickets[{wicket_index}].fielders",
                        )
                        for fielder_index, fielder_value in enumerate(fielders):
                            fielder = _require_mapping(
                                fielder_value,
                                f"{relative_path}.{base_location}.wickets[{wicket_index}].fielders[{fielder_index}]",
                            )
                            _require_keys(
                                fielder,
                                ("name",),
                                f"{relative_path}.{base_location}.wickets[{wicket_index}].fielders[{fielder_index}]",
                            )
                            name = fielder["name"]
                            identifier = resolve_reference(
                                name,
                                "fielder",
                                f"{base_location}.wickets[{wicket_index}].fielders[{fielder_index}].name",
                            )
                            _record_delivery_absence(
                                identifier,
                                name,
                                "fielder",
                                match_id,
                                relative_path,
                                official_ids,
                                absence_keys,
                                delivery_absences,
                            )
                            if fielder.get("substitute") is True:
                                anomaly_lists["substituteFieldingEvents"].append(
                                    _source_reference(
                                        match_id,
                                        relative_path,
                                        inningsIndex=innings_index,
                                        over=over["over"],
                                        deliveryIndex=delivery_index,
                                        dismissalKind=kind,
                                        fielder=name,
                                        playerId=identifier,
                                    )
                                )

                    replacements = _require_mapping(
                        delivery.get("replacements", {}),
                        f"{relative_path}.{base_location}.replacements",
                    )
                    for replacement_type, replacement_values in replacements.items():
                        items = _require_list(
                            replacement_values,
                            f"{relative_path}.{base_location}.replacements[{replacement_type!r}]",
                        )
                        if replacement_type not in {"match", "role"}:
                            raise AuditError(
                                f"Unsupported replacement type {replacement_type!r} in {relative_path}"
                            )
                        for replacement_index, replacement_value in enumerate(items):
                            replacement = _require_mapping(
                                replacement_value,
                                f"{relative_path}.{base_location}.replacements[{replacement_type!r}][{replacement_index}]",
                            )
                            reason = str(replacement.get("reason", "missing"))
                            detail = _source_reference(
                                match_id,
                                relative_path,
                                inningsIndex=innings_index,
                                over=over["over"],
                                deliveryIndex=delivery_index,
                                replacement=replacement,
                            )
                            target = match_replacements if replacement_type == "match" else role_replacements
                            target[reason].append(detail)
                            for direction in ("in", "out"):
                                if direction not in replacement:
                                    continue
                                name = replacement[direction]
                                identifier = resolve_reference(
                                    name,
                                    f"{replacement_type}Replacement{direction.title()}",
                                    f"{base_location}.replacements[{replacement_type!r}]"
                                    f"[{replacement_index}].{direction}",
                                )
                                _record_delivery_absence(
                                    identifier,
                                    name,
                                    f"{replacement_type}Replacement{direction.title()}",
                                    match_id,
                                    relative_path,
                                    official_ids,
                                    absence_keys,
                                    delivery_absences,
                                )

        outcome = _require_mapping(info["outcome"], f"{relative_path}.info.outcome")
        match_ref = _source_reference(
            match_id,
            relative_path,
            sourceSeason=source_season,
            dates=dates,
            teams=teams,
        )
        if outcome.get("result") == "tie":
            anomaly_lists["tiedMatches"].append({**match_ref, "outcome": outcome})
        if "eliminator" in outcome:
            anomaly_lists["eliminatorOutcomes"].append({**match_ref, "outcome": outcome})
        if outcome.get("result") == "tie" and "eliminator" in outcome:
            anomaly_lists["eliminatorResolvedTies"].append({**match_ref, "outcome": outcome})
        if outcome.get("result") == "no result":
            anomaly_lists["noResults"].append({**match_ref, "outcome": outcome})
        if "method" in outcome:
            method = str(outcome["method"])
            outcome_methods[method].append({**match_ref, "outcome": outcome})
            if method == "D/L":
                anomaly_lists["dlAdjustedOutcomes"].append({**match_ref, "outcome": outcome})
        if normal_innings == 1:
            anomaly_lists["oneNormalInningsMatches"].append(
                {**match_ref, "normalInningsCount": normal_innings, "inningsCount": len(innings)}
            )
        if len(innings) > 2:
            anomaly_lists["moreThanTwoInningsMatches"].append(
                {
                    **match_ref,
                    "inningsCount": len(innings),
                    "normalInningsCount": normal_innings,
                    "superOverInningsCount": super_over_innings,
                }
            )
        if super_over_innings == 4:
            anomaly_lists["doubleSuperOverMatches"].append(
                {
                    **match_ref,
                    "inningsCount": len(innings),
                    "normalInningsCount": normal_innings,
                    "superOverInningsCount": super_over_innings,
                }
            )
        if len(dates) > 1:
            anomaly_lists["multiDateMatches"].append(match_ref)
        if city is None:
            anomaly_lists["missingCity"].append(_source_reference(match_id, relative_path))

        event = _require_mapping(info["event"], f"{relative_path}.info.event")
        has_number = "match_number" in event
        has_stage = "stage" in event
        if has_number and has_stage:
            schema_counters["eventUsage"]["matchNumberAndStage"] += 1
        elif has_number:
            schema_counters["eventUsage"]["matchNumberOnly"] += 1
        elif has_stage:
            schema_counters["eventUsage"]["stageOnly"] += 1
        else:
            schema_counters["eventUsage"]["neither"] += 1

        sha256 = hashlib.sha256(raw_bytes).hexdigest()
        manifest_entries.append(
            {
                "schemaVersion": AUDIT_SCHEMA_VERSION,
                "matchId": match_id,
                "relativeSourcePath": relative_path,
                "fileSha256": sha256,
                "fileSizeBytes": len(raw_bytes),
                "dataVersion": data_version,
                "revision": meta["revision"],
                "created": meta.get("created"),
                "sourceSeason": source_season,
                "inferredEditionDisplayYear": display_year,
                "matchDates": dates,
                "teams": teams,
                "venue": venue,
                "city": city,
                "inningsCount": len(innings),
                "normalInningsCount": normal_innings,
                "superOverInningsCount": super_over_innings,
            }
        )

        coverage = season_acc[source_season]
        coverage["sourceFiles"] += 1
        coverage["matches"] += 1
        coverage["normalInnings"] += normal_innings
        coverage["superOverInnings"] += super_over_innings
        coverage["teams"].update(teams)
        coverage["playerIds"].update(official_ids)
        coverage["venues"].add(venue)
        coverage["dates"].extend(dates)

        schema_counters["dataVersions"][data_version] += 1
        schema_counters["revisions"][str(meta["revision"])] += 1
        schema_counters["topLevelKeyShapes"][_shape_key(data)] += 1
        schema_counters["infoKeyShapes"][_shape_key(info)] += 1
        if meta.get("created") is not None:
            creation_date_present += 1

        for team in teams:
            inventory_acc["teams"][team]["count"] += 1
            inventory_acc["teams"][team]["sources"].add(relative_path)
        inventory_acc["venues"][venue]["count"] += 1
        inventory_acc["venues"][venue]["sources"].add(relative_path)
        if city is not None:
            inventory_acc["cities"][city]["count"] += 1
            inventory_acc["cities"][city]["sources"].add(relative_path)

        totals["matches"] += 1
        totals["normalInnings"] += normal_innings
        totals["superOverInnings"] += super_over_innings

    if unresolved:
        preview = "; ".join(
            f"{item['sourcePath']}:{item['location']}={item.get('name')!r}"
            for item in unresolved[:10]
        )
        suffix = "" if len(unresolved) <= 10 else f"; and {len(unresolved) - 10} more"
        raise AuditError(f"Unresolved registry references ({len(unresolved)}): {preview}{suffix}")

    season_coverage = {
        source_season: {
            "sourceSeason": source_season,
            "inferredEditionDisplayYear": infer_edition_display_year(source_season),
            "sourceFiles": values["sourceFiles"],
            "matches": values["matches"],
            "normalInnings": values["normalInnings"],
            "superOverInnings": values["superOverInnings"],
            "uniqueRawTeamNames": len(values["teams"]),
            "rawTeamNames": sorted(values["teams"]),
            "uniquePlayerRegistryIds": len(values["playerIds"]),
            "uniqueRawVenues": len(values["venues"]),
            "rawVenues": sorted(values["venues"]),
            "dateRange": {"first": min(values["dates"]), "last": max(values["dates"])},
        }
        for source_season, values in sorted(
            season_acc.items(), key=lambda item: (infer_edition_display_year(item[0]), item[0])
        )
    }

    schema_report = {
        "supportedDataVersions": sorted(SUPPORTED_DATA_VERSIONS),
        "observedDataVersions": dict(sorted(schema_counters["dataVersions"].items())),
        "observedRevisions": dict(sorted(schema_counters["revisions"].items(), key=lambda item: int(item[0]))),
        "creationDateAvailability": {
            "present": creation_date_present,
            "missing": totals["matches"] - creation_date_present,
        },
        "keyShapes": {
            "topLevel": _render_shapes(schema_counters["topLevelKeyShapes"]),
            "info": _render_shapes(schema_counters["infoKeyShapes"]),
            "innings": _render_shapes(schema_counters["inningsKeyShapes"]),
        },
        "eventNumberStageUsage": dict(sorted(schema_counters["eventUsage"].items())),
        "structuralFailureCount": 0,
    }

    anomalies = {
        key: {"count": len(items), "items": items}
        for key, items in sorted(anomaly_lists.items())
    }
    for required_key in (
        "tiedMatches",
        "eliminatorOutcomes",
        "eliminatorResolvedTies",
        "noResults",
        "dlAdjustedOutcomes",
        "oneNormalInningsMatches",
        "moreThanTwoInningsMatches",
        "doubleSuperOverMatches",
        "multiDateMatches",
        "miscountedOvers",
        "missingCity",
        "missingPlayerOfMatch",
        "substituteFieldingEvents",
    ):
        anomalies.setdefault(required_key, {"count": 0, "items": []})
    anomalies["outcomeMethods"] = _render_grouped_items(outcome_methods)
    anomalies["participantListSizes"] = {
        str(size): {"count": len(items), "items": items}
        for size, items in sorted(participant_sizes.items())
    }
    anomalies["matchReplacementsByReason"] = _render_grouped_items(match_replacements)
    anomalies["roleReplacementsByReason"] = _render_grouped_items(role_replacements)
    anomalies["observedExtrasTypes"] = {
        extras_type: {
            "deliveryOccurrences": extras_counts[extras_type],
            "totalAmount": extras_amounts[extras_type],
            "sourceFiles": sorted(extras_sources[extras_type]),
        }
        for extras_type in sorted(extras_counts)
    }
    anomalies["observedDismissalKinds"] = {
        kind: {
            "count": dismissal_counts[kind],
            "sourceFiles": sorted(dismissal_sources[kind]),
        }
        for kind in sorted(dismissal_counts)
    }

    identity = {
        "uniquePlayerRegistryIds": len(player_id_names),
        "playerRegistryIds": [
            {
                "playerId": identifier,
                "displayNames": sorted(player_id_names[identifier]),
                "sourceFiles": sorted(player_id_sources[identifier]),
            }
            for identifier in sorted(player_id_names)
        ],
        "displayNamesSharedByMultipleIds": [
            {"displayName": name, "playerIds": sorted(ids)}
            for name, ids in sorted(player_name_ids.items())
            if len(ids) > 1
        ],
        "playerIdsObservedWithMultipleNames": [
            {"playerId": identifier, "displayNames": sorted(names)}
            for identifier, names in sorted(player_id_names.items())
            if len(names) > 1
        ],
        "unresolvedRegistryReferences": [],
        "unresolvedRegistryReferenceCount": 0,
        "deliveryParticipantsAbsentFromOfficialLists": delivery_absences,
        "deliveryParticipantsAbsentFromOfficialListsCount": len(delivery_absences),
    }
    identity["displayNamesSharedByMultipleIdsCount"] = len(
        identity["displayNamesSharedByMultipleIds"]
    )
    identity["playerIdsObservedWithMultipleNamesCount"] = len(
        identity["playerIdsObservedWithMultipleNames"]
    )

    inventory_lists = {
        name: [
            {"value": value, "matchOccurrences": detail["count"], "sourceFiles": sorted(detail["sources"])}
            for value, detail in sorted(values.items())
        ]
        for name, values in inventory_acc.items()
    }
    inventories = {
        "uniqueRawTeamNames": len(inventory_lists["teams"]),
        "uniqueRawVenueStrings": len(inventory_lists["venues"]),
        "uniqueRawCityStrings": len(inventory_lists["cities"]),
        **inventory_lists,
    }

    headline = {
        "numericMatchFiles": totals["matches"],
        "iplEditions": len(season_coverage),
        "normalInnings": totals["normalInnings"],
        "superOverInnings": totals["superOverInnings"],
        "deliveries": totals["deliveries"],
        "legalDeliveries": totals["legalDeliveries"],
        "wicketEvents": totals["wickets"],
        "noResults": anomalies["noResults"]["count"],
        "dlResults": anomalies["dlAdjustedOutcomes"]["count"],
        "tiedMatches": anomalies["tiedMatches"]["count"],
        "eliminatorResolvedTies": anomalies["eliminatorResolvedTies"]["count"],
        "impactPlayerReplacements": len(match_replacements.get("impact_player", [])),
        "concussionSubstitutes": len(match_replacements.get("concussion_substitute", [])),
        "injuryRoleReplacements": len(role_replacements.get("injury", [])),
        "excludedBowlerRoleReplacements": len(
            role_replacements.get("excluded - high full pitched balls", [])
        ),
        "substituteFieldingEvents": anomalies["substituteFieldingEvents"]["count"],
        "uniqueRawVenueStrings": len(inventory_acc["venues"]),
        "uniqueRawCityStrings": len(inventory_acc["cities"]),
        "uniqueRawTeamStrings": len(inventory_acc["teams"]),
        "uniquePlayerRegistryIds": len(player_id_names),
    }

    return ArchiveScan(
        manifest_entries=manifest_entries,
        season_coverage=season_coverage,
        schema=schema_report,
        anomalies=anomalies,
        identity=identity,
        inventories=inventories,
        headline=headline,
    )


def _record_delivery_absence(
    identifier: str | None,
    name: Any,
    category: str,
    match_id: str,
    source_path: str,
    official_ids: set[str],
    seen: set[tuple[str, str, str, str]],
    output: list[dict[str, Any]],
) -> None:
    if identifier is None or identifier in official_ids:
        return
    key = (source_path, category, identifier, str(name))
    if key in seen:
        return
    seen.add(key)
    output.append(
        _source_reference(
            match_id,
            source_path,
            category=category,
            displayName=name,
            playerId=identifier,
        )
    )


def _render_shapes(counter: Counter[tuple[str, ...]]) -> list[dict[str, Any]]:
    return [
        {"keys": list(keys), "count": count}
        for keys, count in sorted(counter.items(), key=lambda item: item[0])
    ]


def _render_grouped_items(groups: dict[str, list[dict[str, Any]]]) -> dict[str, dict[str, Any]]:
    return {
        name: {"count": len(items), "items": items}
        for name, items in sorted(groups.items())
    }
