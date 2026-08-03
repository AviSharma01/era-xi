from __future__ import annotations

from collections import defaultdict
from pathlib import Path
from typing import Any

from scripts.process_cricsheet import normalize_season, process_raw_matches


def build_legacy_collision_diagnostics(raw_dir: Path) -> dict[str, Any]:
    """Run the current processor and group its exact emitted aggregate IDs.

    This intentionally calls the legacy implementation instead of recreating its
    membership, aggregation, season normalization, or ID-generation rules.
    """

    legacy_outputs = process_raw_matches(raw_dir)
    player_collisions = _collisions_by_id(legacy_outputs["player_seasons"])
    franchise_collisions = _collisions_by_id(legacy_outputs["franchise_seasons"])

    return {
        "diagnosticMethod": (
            "Executed scripts.process_cricsheet.process_raw_matches in memory and grouped "
            "the exact emitted player_seasons and franchise_seasons rows by their emitted id."
        ),
        "normalizationExamples": [
            {"sourceSeason": "2020/21", "legacyNormalizedSeason": normalize_season("2020/21")},
            {"sourceSeason": "2021", "legacyNormalizedSeason": normalize_season("2021")},
        ],
        "legacyOutputCounts": {
            "players": len(legacy_outputs["players"]),
            "playerSeasonRows": len(legacy_outputs["player_seasons"]),
            "franchiseSeasonRows": len(legacy_outputs["franchise_seasons"]),
        },
        "duplicatePlayerSeasonIdCount": len(player_collisions),
        "duplicatePlayerSeasonIds": player_collisions,
        "representativePlayerSeasonCollisions": player_collisions[:10],
        "duplicateFranchiseSeasonIdCount": len(franchise_collisions),
        "duplicateFranchiseSeasonIds": franchise_collisions,
        "representativeFranchiseSeasonCollisions": franchise_collisions[:10],
    }


def _collisions_by_id(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[row["id"]].append(row)
    return [
        {"id": identifier, "rowCount": len(grouped[identifier]), "rows": grouped[identifier]}
        for identifier in sorted(grouped)
        if len(grouped[identifier]) > 1
    ]
