from __future__ import annotations

from pathlib import Path
from typing import Any

from .integrity import RegistryIntegrityError, load_verified_registry
from .schemas import SchemaValidationError, build_resolution_result_schema, validate_instance


class IdentityResolutionError(ValueError):
    def __init__(self, code: str, source: dict[str, Any], message: str) -> None:
        super().__init__(message)
        self.code = code
        self.source = source

    def to_json(self) -> dict[str, Any]:
        return {"code": self.code, "source": self.source, "message": str(self)}


class IngestionSafetyError(ValueError):
    def __init__(self, resolution: Any, message: str) -> None:
        super().__init__(message)
        self.resolution = resolution


def _insert_unique(index: dict[Any, Any], key: Any, value: Any, label: str) -> None:
    if key in index:
        raise RegistryIntegrityError(f"Duplicate {label}: {key!r}")
    index[key] = value


def require_ingestion_safe_resolution(resolution: dict[str, Any]) -> dict[str, Any]:
    """Return a reviewed mapping or reject runtime uncertainty before Stage 3 ingestion.

    Registry-level review metadata is non-blocking when an exact overlay-backed mapping
    resolves. A result requiring new review is always rejected.
    """
    try:
        validate_instance(resolution, build_resolution_result_schema())
    except SchemaValidationError as error:
        raise IngestionSafetyError(resolution, f"Malformed identity resolution: {error}") from error
    if resolution["requiresNewReview"] or resolution["status"] == "review_required":
        raise IngestionSafetyError(resolution, "Identity resolution requires new human review before ingestion")
    if resolution["status"] not in {"canonical", "provisional"}:
        raise IngestionSafetyError(resolution, f"Identity resolution is not ingestion-safe: {resolution['status']}")
    return resolution


class IdentityResolver:
    def __init__(
        self,
        seasons: dict[str, Any],
        teams: dict[str, Any],
        players: list[dict[str, Any]],
        venues: dict[str, Any],
    ) -> None:
        versions = {
            seasons["registryVersion"],
            teams["registryVersion"],
            venues["registryVersion"],
            *(player["registryVersion"] for player in players),
        }
        if len(versions) != 1:
            raise ValueError(f"Registry version mismatch: {sorted(versions)}")
        self.registry_version = next(iter(versions))
        self._season_by_source: dict[str, dict[str, Any]] = {}
        self._season_by_id: dict[str, dict[str, Any]] = {}
        for season in seasons["seasons"]:
            _insert_unique(self._season_by_id, season["seasonId"], season, "season ID")
            for source in season["sourceSeasons"]:
                _insert_unique(self._season_by_source, source, season, "source season alias")
        self._team_by_alias_and_season: dict[tuple[str, str], dict[str, Any]] = {}
        for team in teams["teams"]:
            for alias in team["sourceAliases"]:
                for season_id in alias["seasonIds"]:
                    _insert_unique(
                        self._team_by_alias_and_season,
                        (alias["sourceTeamName"], season_id),
                        team,
                        "team alias and season combination",
                    )
        self._known_team_aliases = {
            alias["sourceTeamName"]
            for team in teams["teams"]
            for alias in team["sourceAliases"]
        }
        self._player_by_id: dict[str, dict[str, Any]] = {}
        self._player_aliases_by_id: dict[str, dict[str, dict[str, Any]]] = {}
        for player in players:
            _insert_unique(self._player_by_id, player["playerId"], player, "player ID")
            aliases: dict[str, dict[str, Any]] = {}
            for alias in player["observedAliases"]:
                _insert_unique(aliases, alias["name"], alias, f"alias for player {player['playerId']}")
            self._player_aliases_by_id[player["playerId"]] = aliases
        self._venue_by_alias: dict[str, tuple[dict[str, Any], dict[str, Any]]] = {}
        for venue in venues["venues"]:
            for alias in venue["sourceAliases"]:
                _insert_unique(self._venue_by_alias, alias["sourceVenue"], (venue, alias), "venue source alias")

    @classmethod
    def load(
        cls,
        registry_dir: Path = Path("data/registries/ipl/v1"),
        *,
        policy_path: Path = Path("data/manual/identity/v1/registry_policy.json"),
        expected_registry_version: str | None = None,
        expected_registry_aggregate_hash: str | None = None,
        expected_source_archive_manifest_hash: str | None = None,
    ) -> "IdentityResolver":
        verified = load_verified_registry(
            registry_dir,
            policy_path=policy_path,
            expected_registry_version=expected_registry_version,
            expected_registry_aggregate_hash=expected_registry_aggregate_hash,
            expected_source_archive_manifest_hash=expected_source_archive_manifest_hash,
        )
        resolver = cls(
            seasons=verified["seasons"],
            teams=verified["teams"],
            players=verified["players"],
            venues=verified["venues"],
        )
        resolver.registry_aggregate_hash = verified["manifest"]["registryAggregateHash"]
        resolver.source_archive_manifest_hash = verified["manifest"]["sourceArchiveManifestHash"]
        return resolver

    def resolve_source_season(self, source_season: str) -> dict[str, Any]:
        source = {"sourceSeason": source_season}
        season = self._season_by_source.get(source_season)
        if season is None:
            raise IdentityResolutionError("unknown_source_season", source, f"Unknown exact source season: {source_season!r}")
        return {
            "id": season["seasonId"],
            "status": "canonical",
            "matchedBy": "exact_source_season",
            "source": source,
            "registryVersion": self.registry_version,
            "registryReviewStatus": "approved",
            "requiresNewReview": False,
            "evidenceRefs": [{"registry": "seasons", "recordId": season["seasonId"], "sourceAlias": source_season}],
            "notes": [],
            "warnings": [],
        }

    def resolve_team(self, source_team_name: str, season_id: str) -> dict[str, Any]:
        source = {"sourceTeamName": source_team_name, "seasonId": season_id}
        if season_id not in self._season_by_id:
            raise IdentityResolutionError("unknown_season_id", source, f"Unknown canonical season ID: {season_id!r}")
        team = self._team_by_alias_and_season.get((source_team_name, season_id))
        if team is None:
            code = "invalid_team_season" if source_team_name in self._known_team_aliases else "unknown_source_team"
            raise IdentityResolutionError(code, source, f"No approved team mapping for {source_team_name!r} in {season_id}")
        return {
            "id": team["teamId"],
            "teamId": team["teamId"],
            "franchiseId": team["franchiseId"],
            "status": "canonical",
            "matchedBy": "exact_source_team_alias_and_season",
            "source": source,
            "registryVersion": self.registry_version,
            "registryReviewStatus": "approved",
            "requiresNewReview": False,
            "evidenceRefs": [{"registry": "teams", "recordId": team["teamId"], "sourceAlias": source_team_name}],
            "notes": [],
            "warnings": [],
        }

    def resolve_player(self, player_id: str, observed_name: str) -> dict[str, Any]:
        source = {"playerId": player_id, "observedName": observed_name}
        player = self._player_by_id.get(player_id)
        if player is None:
            raise IdentityResolutionError("unknown_player_id", source, f"Unknown Cricsheet player ID: {player_id!r}")
        alias = self._player_aliases_by_id[player_id].get(observed_name)
        warnings: list[str] = []
        status = "canonical"
        matched_by = "exact_player_id_and_alias"
        evidence_refs: list[dict[str, Any]] = [{"registry": "players", "recordId": player_id}]
        requires_new_review = alias is None
        if requires_new_review:
            status = "review_required"
            matched_by = "exact_player_id_unregistered_alias"
            warnings.append("The canonical player ID is known, but the observed name is not a registered alias.")
        else:
            evidence_refs[0]["sourceAlias"] = observed_name
            evidence_refs[0]["provenance"] = alias["provenance"]
            if player["reviewStatus"] == "review_required":
                warnings.append("This exact canonical identity has non-blocking registry-level review metadata.")
        return {
            "id": player_id,
            "status": status,
            "matchedBy": matched_by,
            "source": source,
            "registryVersion": self.registry_version,
            "registryReviewStatus": player["reviewStatus"],
            "requiresNewReview": requires_new_review,
            "canonicalDisplayName": player["canonicalDisplayName"],
            "participationBasis": player["participationBasis"],
            "evidenceRefs": evidence_refs,
            "notes": list(player["notes"]),
            "warnings": warnings,
        }

    def resolve_venue(self, source_venue: str, city: str | None, season_id: str) -> dict[str, Any]:
        source = {"sourceVenue": source_venue, "city": city, "seasonId": season_id}
        if season_id not in self._season_by_id:
            raise IdentityResolutionError("unknown_season_id", source, f"Unknown canonical season ID: {season_id!r}")
        mapping = self._venue_by_alias.get(source_venue)
        if mapping is None:
            raise IdentityResolutionError("unknown_source_venue", source, f"Unknown exact source venue: {source_venue!r}")
        venue, alias = mapping
        warnings: list[str] = []
        status = venue["status"]
        matched_by = "exact_source_venue_alias"
        requires_new_review = False
        if city is None:
            matched_by = "exact_source_venue_alias_without_city"
        elif city not in alias["observedCities"]:
            status = "review_required"
            requires_new_review = True
            warnings.append("The supplied city was not observed with this exact venue alias in Stage 1.")
        if season_id not in alias["seasonIds"]:
            status = "review_required"
            requires_new_review = True
            warnings.append("The supplied season was not observed with this exact venue alias in Stage 1.")
        if venue["reviewStatus"] == "review_required":
            warnings.append("This exact venue mapping has non-blocking registry-level review metadata.")
        return {
            "id": venue["venueId"],
            "venueId": venue["venueId"],
            "venueSiteId": venue["venueSiteId"],
            "canonicalName": venue.get("canonicalName", source_venue),
            "canonicalCity": venue.get("canonicalCity", city or "Unknown"),
            "country": venue.get("country", "Unknown"),
            "status": status,
            "matchedBy": matched_by,
            "source": source,
            "registryVersion": self.registry_version,
            "registryReviewStatus": venue["reviewStatus"],
            "requiresNewReview": requires_new_review,
            "evidenceRefs": [{"registry": "venues", "recordId": venue["venueId"], "sourceAlias": source_venue}],
            "notes": list(venue["notes"]),
            "warnings": warnings,
        }
