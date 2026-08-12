from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any

from scripts.cricsheet_audit.reporting import canonical_json_bytes, pretty_json_bytes
from scripts.identity_registry.schemas import SchemaValidationError, validate_instance

from .aggregator import (
    ANALYTICS_DATASET_VERSION,
    BASELINE_COUNTS,
    PHASES,
    PHASE_DEFINITION_VERSION,
    ROW_SCHEMA_VERSIONS,
    AnalyticalAggregationError,
    build_analytical_rows,
)
from .integrity import (
    EXPECTED_STAGE1_HASH,
    EXPECTED_STAGE2_HASH,
    EXPECTED_STAGE2_VERSION,
    EXPECTED_STAGE3_AGGREGATE_HASH,
    EXPECTED_STAGE3_DATASET_VERSION,
    EXPECTED_STAGE3_MANIFEST_HASH,
    AnalyticalInputError,
    load_verified_normalized_dataset,
)
from .schemas import MANIFEST_SCHEMA_VERSION, REPORT_SCHEMA_VERSION, build_schema_documents


DATA_FILES = {
    "matchSummaries": "match_summaries.jsonl",
    "playerTeamSeasons": "player_team_seasons.jsonl",
    "teamSeasons": "team_seasons.jsonl",
    "seasonEnvironments": "season_environments.jsonl",
    "venueSeasonEnvironments": "venue_season_environments.jsonl",
}
SCHEMA_FOR_DATASET = {
    "matchSummaries": "match_summary.schema.json",
    "playerTeamSeasons": "player_team_season.schema.json",
    "teamSeasons": "team_season.schema.json",
    "seasonEnvironments": "season_environment.schema.json",
    "venueSeasonEnvironments": "venue_season_environment.schema.json",
}


class AnalyticalBuildError(ValueError):
    pass


def _write(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)


def _tree_files(root: Path) -> dict[str, bytes]:
    return {path.relative_to(root).as_posix(): path.read_bytes() for path in sorted(root.rglob("*")) if path.is_file()}


def _tree_allocated_bytes(root: Path) -> int:
    total = root.stat().st_blocks * 512
    for path in root.rglob("*"):
        total += path.stat().st_blocks * 512
    return total


def _human_size(value: int) -> str:
    amount = float(value)
    for unit in ("B", "KiB", "MiB", "GiB"):
        if amount < 1024 or unit == "GiB":
            return f"{int(amount)} B" if unit == "B" else f"{amount:.2f} {unit}"
        amount /= 1024
    raise AssertionError("unreachable")


def _sum_metric(left: dict[str, Any], right: dict[str, Any]) -> dict[str, Any]:
    result = json.loads(json.dumps(left))
    for key, value in right.items():
        if isinstance(value, dict):
            result[key] = _sum_metric(result[key], value)
        elif isinstance(value, int):
            result[key] += value
    return result


def _zero_like(metric: dict[str, Any]) -> dict[str, Any]:
    return {key: _zero_like(value) if isinstance(value, dict) else 0 for key, value in metric.items()}


def _validate_rows(rows: dict[str, list[dict[str, Any]]], schemas: dict[str, dict[str, Any]], stage3_counts: dict[str, int]) -> None:
    ids: dict[str, set[str]] = {key: set() for key in rows}
    match_ids = {row["matchId"] for row in rows["matchSummaries"]}
    if len(match_ids) != len(rows["matchSummaries"]):
        raise AnalyticalBuildError("Duplicate analytical match IDs")
    id_fields = {"playerTeamSeasons": "playerTeamSeasonId", "teamSeasons": "teamSeasonId", "seasonEnvironments": "seasonId", "venueSeasonEnvironments": "venueSeasonId"}
    for dataset, dataset_rows in rows.items():
        schema = schemas[SCHEMA_FOR_DATASET[dataset]]
        for index, row in enumerate(dataset_rows):
            try:
                validate_instance(row, schema)
            except SchemaValidationError as error:
                raise AnalyticalBuildError(f"{dataset}[{index}] schema failure: {error}") from error
            if dataset in id_fields:
                value = row[id_fields[dataset]]
                if value in ids[dataset]: raise AnalyticalBuildError(f"Duplicate {dataset} ID: {value}")
                ids[dataset].add(value)

    normal_innings = sum(len(row["normalInnings"]) for row in rows["matchSummaries"])
    excluded_super = sum(row["superOverInnings"] for row in rows["matchSummaries"])
    if normal_innings != stage3_counts["normalInnings"] or excluded_super != stage3_counts["superOverInnings"]:
        raise AnalyticalBuildError("Stage 3 innings coverage did not reconcile")
    source_match_ids = set(match_ids)
    for dataset in ("playerTeamSeasons", "teamSeasons", "seasonEnvironments", "venueSeasonEnvironments"):
        for row in rows[dataset]:
            lineage = row["participation"]["matchContributions"] if dataset == "playerTeamSeasons" else [{"matchId": value} for value in row["matchIds"]]
            if any(item["matchId"] not in source_match_ids for item in lineage):
                raise AnalyticalBuildError(f"Unknown contributing match in {dataset}")

    for player in rows["playerTeamSeasons"]:
        participation = player["participation"]; contributions = participation["matchContributions"]
        if participation["officialListMatchCount"] != sum(c["officialListed"] for c in contributions): raise AnalyticalBuildError("Official participation mismatch")
        if participation["recordedActionMatchCount"] != sum(bool(c["recordedActions"]) for c in contributions): raise AnalyticalBuildError("Recorded participation mismatch")
        if participation["documentedInvolvementMatchCount"] != len(contributions): raise AnalyticalBuildError("Documented participation mismatch")
        batting = player["batting"]
        if batting["innings"] != len(batting["inningsObservations"]) or batting["innings"] != sum(batting["positionCounts"].values()): raise AnalyticalBuildError("Batting innings/position mismatch")
        summed_bat = _zero_like(batting["totals"])
        for phase in PHASES: summed_bat = _sum_metric(summed_bat, batting["phases"][phase])
        if summed_bat != batting["totals"]: raise AnalyticalBuildError("Player batting phase mismatch")
        bowling = player["bowling"]
        if bowling["innings"] != len(bowling["inningsObservations"]): raise AnalyticalBuildError("Bowling innings mismatch")
        summed_bowl = _zero_like(bowling["totals"])
        for phase in PHASES: summed_bowl = _sum_metric(summed_bowl, bowling["phases"][phase])
        if summed_bowl != bowling["totals"]: raise AnalyticalBuildError("Player bowling phase mismatch")
        expected_bat_rates = {
            "average": round(batting["totals"]["runs"] / batting["totals"]["dismissals"], 6) if batting["totals"]["dismissals"] else None,
            "strikeRate": round(100 * batting["totals"]["runs"] / batting["totals"]["balls"], 6) if batting["totals"]["balls"] else None,
            "boundaryBallRate": round(batting["totals"]["boundaryBalls"] / batting["totals"]["balls"], 6) if batting["totals"]["balls"] else None,
            "dotBallRate": round(batting["totals"]["dotBalls"] / batting["totals"]["balls"], 6) if batting["totals"]["balls"] else None,
        }
        expected_bowl_rates = {
            "economyPerSixBalls": round(6 * bowling["totals"]["runsConceded"] / bowling["totals"]["legalBalls"], 6) if bowling["totals"]["legalBalls"] else None,
            "strikeRate": round(bowling["totals"]["legalBalls"] / bowling["totals"]["creditedWickets"], 6) if bowling["totals"]["creditedWickets"] else None,
            "dotBallRate": round(bowling["totals"]["dotBalls"] / bowling["totals"]["legalBalls"], 6) if bowling["totals"]["legalBalls"] else None,
            "legalBallsPerBowlingMatch": round(bowling["totals"]["legalBalls"] / bowling["matches"], 6) if bowling["matches"] else None,
        }
        if batting["rates"] != expected_bat_rates or bowling["rates"] != expected_bowl_rates: raise AnalyticalBuildError("Player convenience-rate mismatch")

    match_totals: dict[str, dict[str, Any]] = {}
    for match in rows["matchSummaries"]:
        for innings in match["normalInnings"]:
            key = f"{match['matchId']}:{innings['inningsIndex']}"
            summed = _zero_like(innings["totals"])
            for phase in PHASES: summed = _sum_metric(summed, innings["phases"][phase])
            summed["innings"] = innings["totals"]["innings"]
            if summed != innings["totals"]: raise AnalyticalBuildError(f"Match phase mismatch: {key}")
            match_totals[key] = innings["totals"]

    player_batter_runs = sum(p["batting"]["totals"]["runs"] for p in rows["playerTeamSeasons"])
    player_balls = sum(p["batting"]["totals"]["balls"] for p in rows["playerTeamSeasons"])
    player_dismissals = sum(p["batting"]["totals"]["dismissals"] for p in rows["playerTeamSeasons"])
    player_bowl_balls = sum(p["bowling"]["totals"]["legalBalls"] for p in rows["playerTeamSeasons"])
    player_wickets = sum(p["bowling"]["totals"]["creditedWickets"] for p in rows["playerTeamSeasons"])
    match_batter_runs = sum(x["batterRuns"] for x in match_totals.values())
    match_batter_balls = sum(x["batterBalls"] for x in match_totals.values())
    match_dismissals = sum(x["dismissals"] for x in match_totals.values())
    match_legal = sum(x["legalBalls"] for x in match_totals.values())
    match_wickets = sum(x["creditedWickets"] for x in match_totals.values())
    if (player_batter_runs, player_balls, player_dismissals, player_bowl_balls, player_wickets) != (match_batter_runs, match_batter_balls, match_dismissals, match_legal, match_wickets):
        raise AnalyticalBuildError("Archive-wide player totals do not reconcile to match summaries")
    player_conceded = sum(p["bowling"]["totals"]["runsConceded"] for p in rows["playerTeamSeasons"])
    match_conceded = sum(x["runs"] - x["extras"]["byes"] - x["extras"]["legByes"] - x["extras"]["penalty"] for x in match_totals.values())
    if player_conceded != match_conceded: raise AnalyticalBuildError("Bowler conceded runs do not reconcile")
    season_all = next(iter(rows["seasonEnvironments"]))["cohorts"]["all_normal"]["totals"]
    total_seasons = _zero_like(season_all)
    for row in rows["seasonEnvironments"]: total_seasons = _sum_metric(total_seasons, row["cohorts"]["all_normal"]["totals"])
    total_matches = _zero_like(season_all)
    for value in match_totals.values(): total_matches = _sum_metric(total_matches, value)
    if total_seasons != total_matches: raise AnalyticalBuildError("Season totals do not reconcile to matches")
    total_venues = _zero_like(season_all)
    for row in rows["venueSeasonEnvironments"]: total_venues = _sum_metric(total_venues, row["cohorts"]["all_normal"]["totals"])
    if total_venues != total_matches: raise AnalyticalBuildError("Venue totals do not reconcile to matches")
    total_teams = _zero_like(season_all)
    for row in rows["teamSeasons"]: total_teams = _sum_metric(total_teams, row["batting"])
    if total_teams != total_matches: raise AnalyticalBuildError("Team-season totals do not reconcile to matches")


def _baseline_comparisons(rows: dict[str, list[dict[str, Any]]]) -> list[dict[str, Any]]:
    comparisons = []
    for dataset, baseline in BASELINE_COUNTS.items():
        actual = len(rows[dataset]); matches = actual == baseline
        comparisons.append({"dataset": dataset, "baseline": baseline, "actual": actual, "matches": matches, "explanation": None if matches else "Definition-derived output differs from the pinned-corpus baseline; publication requires evidence-based review."})
    return comparisons


def _summary_markdown(report: dict[str, Any]) -> str:
    comparisons = report["baselineComparisons"]
    d = report["distributions"]
    lines = [
        "# Historical IPL Analytical Profiles v1", "", f"Analytical manifest SHA-256: `{report['analyticalManifestHash']}`", "",
        "## Coverage", "",
        *(f"- {item['dataset']}: {item['actual']:,} (baseline {item['baseline']:,}, {'matched' if item['matches'] else 'review required'})" for item in comparisons),
        f"- Normal innings aggregated: {report['counts']['normalInnings']:,}", f"- Super Over innings excluded from ordinary statistics: {report['counts']['superOverInningsExcluded']:,}", "",
        "## Participation observations", "",
        f"- Official-list and recorded-action match rows: {d['participation']['matchContributionIntersections']['officialAndRecorded']:,}",
        f"- Official-list-only match rows: {d['participation']['matchContributionIntersections']['officialOnly']:,}",
        f"- Recorded-action-only match rows: {d['participation']['matchContributionIntersections']['recordedOnly']:,}",
        f"- Impact-evidence profiles: {d['evidenceProfileCounts'].get('impactProfiles', 0):,}",
        f"- Event-only profiles: {d['evidenceProfileCounts'].get('eventOnlyProfiles', 0):,}", "",
        "## Generated size", "",
        f"- Analytical data: {report['sizeReport']['analyticalDataBytes']:,} bytes",
        f"- Schema bundle: {report['sizeReport']['schemaBundleBytes']:,} bytes",
        f"- Complete tree logical: {report['sizeReport']['outputTreeLogicalBytes']:,} bytes",
        f"- Complete tree allocated: {report['sizeReport']['outputTreeAllocatedBytes']:,} bytes ({report['sizeReport']['outputTreeAllocatedHumanSize']})", "",
        "## Boundary", "", "- No ratings, roles, eligibility, era normalization, opponent selection, simulation inputs, or TypeScript integration are included.", "",
    ]
    return "\n".join(lines)


def _render_report(staging: Path, *, manifest_hash: str, comparisons: list[dict[str, Any]], metadata: dict[str, Any], data_bytes: int, schema_bytes: int, manifest_bytes: int, report_schema: dict[str, Any]) -> tuple[dict[str, Any], bytes, bytes]:
    sizes = {"analyticalDataBytes": data_bytes, "schemaBundleBytes": schema_bytes, "manifestBytes": manifest_bytes, "validationReportBytes": 0, "summaryBytes": 0, "outputTreeLogicalBytes": 0, "outputTreeAllocatedBytes": 0, "outputTreeAllocatedHumanSize": "0 B"}
    report_bytes = summary_bytes = b""
    for _ in range(16):
        report = {
            "schemaVersion": REPORT_SCHEMA_VERSION, "datasetVersion": ANALYTICS_DATASET_VERSION, "analyticalManifestHash": manifest_hash,
            "status": "passed" if all(item["matches"] for item in comparisons) else "passed_with_observations",
            "baselineComparisons": comparisons,
            "counts": {"normalInnings": metadata["stage3Counts"]["normalInnings"], "superOverInningsExcluded": metadata["stage3Counts"]["superOverInnings"], "schemaFailures": 0, "reconciliationFailures": 0, "provenanceFailures": 0},
            "distributions": metadata["distributions"], "sizeReport": sizes, "errors": [],
            "observations": [] if all(item["matches"] for item in comparisons) else ["One or more reconciliation baselines differ; inspect baselineComparisons before publication."],
        }
        report_bytes = pretty_json_bytes(report); summary_bytes = _summary_markdown(report).encode("utf-8")
        _write(staging / "validation_report.json", report_bytes); _write(staging / "SUMMARY.md", summary_bytes)
        logical = sum(len(content) for content in _tree_files(staging).values())
        allocated = _tree_allocated_bytes(staging)
        updated = {**sizes, "validationReportBytes": len(report_bytes), "summaryBytes": len(summary_bytes), "outputTreeLogicalBytes": logical, "outputTreeAllocatedBytes": allocated, "outputTreeAllocatedHumanSize": _human_size(allocated)}
        if updated == sizes:
            try: validate_instance(report, report_schema)
            except SchemaValidationError as error: raise AnalyticalBuildError(f"Validation report schema failure: {error}") from error
            return report, report_bytes, summary_bytes
        sizes = updated
    raise AnalyticalBuildError("Size report did not converge")


def build_analytical_archive(
    *,
    normalized_dir: Path = Path("data/normalized/cricsheet-ipl/v1"),
    output_dir: Path = Path("data/analytical/cricsheet-ipl/v1"),
) -> dict[str, Any]:
    try:
        verified = load_verified_normalized_dataset(normalized_dir)
        rows, metadata = build_analytical_rows(verified.iter_matches())
    except (AnalyticalInputError, AnalyticalAggregationError) as error:
        raise AnalyticalBuildError(str(error)) from error
    schemas = build_schema_documents()
    _validate_rows(rows, schemas, verified.manifest["counts"])
    expected_events = {
        "impactReplacements": verified.manifest["counts"]["impactPlayerReplacements"],
        "concussionSubstitutes": verified.manifest["counts"]["concussionSubstitutes"],
        "roleReplacements": verified.manifest["counts"]["roleReplacements"],
        "substituteFieldingEvents": verified.manifest["counts"]["substituteFieldingEvents"],
    }
    actual_events = metadata["distributions"]["evidenceEventCounts"]
    if any(actual_events[key] != value for key, value in expected_events.items()):
        raise AnalyticalBuildError(f"Stage 3 event retention mismatch: expected={expected_events}, actual={actual_events}")
    comparisons = _baseline_comparisons(rows)
    if any(not item["matches"] for item in comparisons):
        raise AnalyticalBuildError(f"Unexplained analytical baseline drift: {[item for item in comparisons if not item['matches']]}")

    output_dir.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(dir=output_dir.parent, prefix=f".{output_dir.name}.", suffix=".tmp"))
    try:
        schema_entries = []
        for name, schema in sorted(schemas.items()):
            content = pretty_json_bytes(schema); path = f"schemas/{name}"; _write(staging / path, content)
            schema_entries.append({"path": path, "sizeBytes": len(content), "sha256": hashlib.sha256(content).hexdigest()})
        artifact_entries = []; aggregate = hashlib.sha256()
        for dataset, name in DATA_FILES.items():
            content = b"".join(canonical_json_bytes(row) for row in rows[dataset]); _write(staging / name, content)
            artifact_entries.append({"path": name, "schemaVersion": ROW_SCHEMA_VERSIONS[dataset], "rows": len(rows[dataset]), "sizeBytes": len(content), "sha256": hashlib.sha256(content).hexdigest()})
            aggregate.update(name.encode("utf-8")); aggregate.update(b"\0"); aggregate.update(content)
        manifest_payload = {
            "schemaVersion": MANIFEST_SCHEMA_VERSION, "datasetVersion": ANALYTICS_DATASET_VERSION, "phaseDefinitionVersion": PHASE_DEFINITION_VERSION,
            "stage1ArchiveManifestHash": EXPECTED_STAGE1_HASH, "stage2RegistryVersion": EXPECTED_STAGE2_VERSION, "stage2RegistryAggregateHash": EXPECTED_STAGE2_HASH,
            "stage3DatasetVersion": EXPECTED_STAGE3_DATASET_VERSION, "stage3NormalizationManifestHash": EXPECTED_STAGE3_MANIFEST_HASH,
            "stage3NormalizedMatchAggregateHash": EXPECTED_STAGE3_AGGREGATE_HASH, "artifacts": artifact_entries, "schemaFiles": schema_entries,
            "analyticalDataAggregateHash": aggregate.hexdigest(),
        }
        manifest_hash = hashlib.sha256(canonical_json_bytes(manifest_payload)).hexdigest(); manifest = {**manifest_payload, "analyticalManifestHash": manifest_hash}
        try: validate_instance(manifest, schemas["analytical_manifest.schema.json"])
        except SchemaValidationError as error: raise AnalyticalBuildError(f"Manifest schema failure: {error}") from error
        manifest_content = pretty_json_bytes(manifest); _write(staging / "analytical_manifest.json", manifest_content)
        report, report_bytes, summary_bytes = _render_report(
            staging, manifest_hash=manifest_hash, comparisons=comparisons, metadata=metadata,
            data_bytes=sum(entry["sizeBytes"] for entry in artifact_entries), schema_bytes=sum(entry["sizeBytes"] for entry in schema_entries),
            manifest_bytes=len(manifest_content), report_schema=schemas["validation_report.schema.json"],
        )
        expected = {*(entry["path"] for entry in artifact_entries), *(entry["path"] for entry in schema_entries), "analytical_manifest.json", "validation_report.json", "SUMMARY.md"}
        actual = set(_tree_files(staging))
        if actual != expected: raise AnalyticalBuildError(f"Staged artifact set mismatch: missing={sorted(expected-actual)}, unexpected={sorted(actual-expected)}")
        for entry in artifact_entries + schema_entries:
            content = (staging / entry["path"]).read_bytes()
            if len(content) != entry["sizeBytes"] or hashlib.sha256(content).hexdigest() != entry["sha256"]: raise AnalyticalBuildError(f"Staged artifact integrity failure: {entry['path']}")
        if len(report_bytes) != report["sizeReport"]["validationReportBytes"] or len(summary_bytes) != report["sizeReport"]["summaryBytes"]: raise AnalyticalBuildError("Rendered report sizes do not reconcile")
        if output_dir.exists():
            if _tree_files(output_dir) != _tree_files(staging): raise AnalyticalBuildError(f"Immutable dataset differs at {output_dir}; use a new version")
            shutil.rmtree(staging); return report
        os.replace(staging, output_dir); return report
    except BaseException:
        if staging.exists(): shutil.rmtree(staging)
        raise
