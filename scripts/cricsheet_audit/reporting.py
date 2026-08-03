from __future__ import annotations

import hashlib
import json
import os
import tempfile
from pathlib import Path
from typing import Any

from .scanner import AUDIT_SCHEMA_VERSION, ArchiveScan


OUTPUT_FILE_NAMES = (
    "source_manifest.jsonl",
    "manifest_metadata.json",
    "season_coverage.json",
    "schema_revision_coverage.json",
    "match_innings_anomalies.json",
    "participant_identity_observations.json",
    "raw_name_inventories.json",
    "legacy_collision_diagnostics.json",
    "global_audit_summary.json",
    "SUMMARY.md",
)

EXPECTED_BASELINE = {
    "numericMatchFiles": 1243,
    "iplEditions": 19,
    "normalInnings": 2480,
    "superOverInnings": 34,
    "noResults": 9,
    "dlResults": 23,
    "eliminatorResolvedTies": 16,
    "impactPlayerReplacements": 557,
    "concussionSubstitutes": 6,
    "injuryRoleReplacements": 51,
    "excludedBowlerRoleReplacements": 10,
    "substituteFieldingEvents": 227,
    "uniqueRawVenueStrings": 60,
    "uniqueRawCityStrings": 37,
    "duplicateLegacyPlayerSeasonIds": 91,
    "duplicateLegacyFranchiseSeasonIds": 7,
}


def canonical_json_bytes(value: Any) -> bytes:
    return (
        json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n"
    ).encode("utf-8")


def pretty_json_bytes(value: Any) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n").encode("utf-8")


def calculate_manifest_hash(entries: list[dict[str, Any]]) -> str:
    digest = hashlib.sha256()
    for entry in sorted(
        entries, key=lambda item: (int(item["matchId"]), item["relativeSourcePath"])
    ):
        digest.update(canonical_json_bytes(entry))
    return digest.hexdigest()


def serialize_manifest(entries: list[dict[str, Any]], manifest_hash: str) -> bytes:
    """Render self-identifying JSONL without making the hash self-referential.

    The archive hash is calculated from canonical entry objects before the
    `archiveManifestHash` envelope field is added to each rendered line.
    """

    return b"".join(
        canonical_json_bytes({**entry, "archiveManifestHash": manifest_hash})
        for entry in sorted(
            entries, key=lambda item: (int(item["matchId"]), item["relativeSourcePath"])
        )
    )


def build_reports(scan: ArchiveScan, legacy_collisions: dict[str, Any]) -> tuple[dict[str, bytes], str]:
    manifest_hash = calculate_manifest_hash(scan.manifest_entries)

    def envelope(report_type: str, payload: dict[str, Any]) -> dict[str, Any]:
        return {
            "schemaVersion": AUDIT_SCHEMA_VERSION,
            "reportType": report_type,
            "archiveManifestHash": manifest_hash,
            **payload,
        }

    actual = dict(scan.headline)
    actual["duplicateLegacyPlayerSeasonIds"] = legacy_collisions[
        "duplicatePlayerSeasonIdCount"
    ]
    actual["duplicateLegacyFranchiseSeasonIds"] = legacy_collisions[
        "duplicateFranchiseSeasonIdCount"
    ]
    comparisons = [
        {
            "metric": metric,
            "expected": expected,
            "actual": actual.get(metric),
            "matches": actual.get(metric) == expected,
            "explanation": (
                None
                if actual.get(metric) == expected
                else "Derived archive value differs from the supplied acceptance baseline; source review required."
            ),
        }
        for metric, expected in EXPECTED_BASELINE.items()
    ]
    discrepancies = [item for item in comparisons if not item["matches"]]

    warning_categories = _warning_categories(scan, discrepancies)
    warning_item_count = _warning_item_count(scan, discrepancies)
    global_summary = envelope(
        "globalAuditSummary",
        {
            "validation": {
                "status": "passed" if not warning_categories else "passed_with_observations",
                "fatalErrorCount": 0,
                "warningCategoryCount": len(warning_categories),
                "warningItemCount": warning_item_count,
                "warningCategories": warning_categories,
            },
            "headlineCounts": actual,
            "expectedBaselineComparisons": comparisons,
            "baselineDiscrepancyCount": len(discrepancies),
        },
    )

    reports = {
        "source_manifest.jsonl": serialize_manifest(scan.manifest_entries, manifest_hash),
        "manifest_metadata.json": pretty_json_bytes(
            envelope(
                "manifestMetadata",
                {
                    "entryCount": len(scan.manifest_entries),
                    "entryOrdering": "parsed numeric matchId, then relativeSourcePath",
                    "entrySerialization": (
                        "UTF-8 JSON with sorted keys, compact separators, ensure_ascii=false, newline terminated"
                    ),
                    "hashAlgorithm": "SHA-256",
                    "hashMaterial": (
                        "Concatenated canonical manifest entry bytes before the self-referential "
                        "archiveManifestHash field is added to rendered JSONL lines"
                    ),
                    "canonicalProvenanceExcludes": [
                        "filesystem modification times",
                        "absolute paths",
                        "generation timestamps",
                    ],
                },
            )
        ),
        "season_coverage.json": pretty_json_bytes(
            envelope(
                "seasonCoverage",
                {
                    "editionCount": len(scan.season_coverage),
                    "seasons": list(scan.season_coverage.values()),
                    "auditOnlyDisplayYearMappings": {
                        "2007/08": 2008,
                        "2009/10": 2010,
                        "2020/21": 2020,
                    },
                },
            )
        ),
        "schema_revision_coverage.json": pretty_json_bytes(
            envelope("schemaRevisionCoverage", scan.schema)
        ),
        "match_innings_anomalies.json": pretty_json_bytes(
            envelope("matchAndInningsAnomalies", scan.anomalies)
        ),
        "participant_identity_observations.json": pretty_json_bytes(
            envelope("participantAndIdentityObservations", scan.identity)
        ),
        "raw_name_inventories.json": pretty_json_bytes(
            envelope("rawNameInventories", scan.inventories)
        ),
        "legacy_collision_diagnostics.json": pretty_json_bytes(
            envelope("legacySeasonNormalizationCollisions", legacy_collisions)
        ),
        "global_audit_summary.json": pretty_json_bytes(global_summary),
    }
    reports["SUMMARY.md"] = _summary_markdown(global_summary, manifest_hash).encode("utf-8")
    return reports, manifest_hash


def write_reports(reports: dict[str, bytes], output_dir: Path) -> dict[str, int]:
    unexpected = sorted(set(reports) - set(OUTPUT_FILE_NAMES))
    missing = sorted(set(OUTPUT_FILE_NAMES) - set(reports))
    if unexpected or missing:
        raise ValueError(f"Audit output set mismatch; unexpected={unexpected}, missing={missing}")

    output_dir.mkdir(parents=True, exist_ok=True)
    for file_name in OUTPUT_FILE_NAMES:
        _atomic_write(output_dir / file_name, reports[file_name])
    return {file_name: len(reports[file_name]) for file_name in OUTPUT_FILE_NAMES}


def _atomic_write(path: Path, content: bytes) -> None:
    file_descriptor, temporary_name = tempfile.mkstemp(
        dir=path.parent, prefix=f".{path.name}.", suffix=".tmp"
    )
    try:
        with os.fdopen(file_descriptor, "wb") as temporary_file:
            temporary_file.write(content)
            temporary_file.flush()
            os.fsync(temporary_file.fileno())
        os.replace(temporary_name, path)
    except BaseException:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def _warning_categories(scan: ArchiveScan, discrepancies: list[dict[str, Any]]) -> list[str]:
    categories = []
    for key, label in (
        ("oneNormalInningsMatches", "one-normal-innings matches"),
        ("moreThanTwoInningsMatches", "matches with more than two innings"),
        ("multiDateMatches", "multi-date matches"),
        ("miscountedOvers", "miscounted overs"),
        ("missingCity", "missing city metadata"),
        ("missingPlayerOfMatch", "missing player-of-match metadata"),
    ):
        if scan.anomalies[key]["count"]:
            categories.append(label)
    if scan.identity["displayNamesSharedByMultipleIds"]:
        categories.append("display names shared by multiple registry IDs")
    if scan.identity["playerIdsObservedWithMultipleNames"]:
        categories.append("registry IDs observed under multiple display names")
    if scan.identity["deliveryParticipantsAbsentFromOfficialLists"]:
        categories.append("delivery participants absent from official participant lists")
    if discrepancies:
        categories.append("acceptance-baseline discrepancies")
    return categories


def _warning_item_count(scan: ArchiveScan, discrepancies: list[dict[str, Any]]) -> int:
    anomaly_keys = (
        "oneNormalInningsMatches",
        "moreThanTwoInningsMatches",
        "multiDateMatches",
        "miscountedOvers",
        "missingCity",
        "missingPlayerOfMatch",
    )
    return (
        sum(scan.anomalies[key]["count"] for key in anomaly_keys)
        + len(scan.identity["displayNamesSharedByMultipleIds"])
        + len(scan.identity["playerIdsObservedWithMultipleNames"])
        + len(scan.identity["deliveryParticipantsAbsentFromOfficialLists"])
        + len(discrepancies)
    )


def _summary_markdown(global_summary: dict[str, Any], manifest_hash: str) -> str:
    counts = global_summary["headlineCounts"]
    lines = [
        "# Cricsheet IPL Archive Audit v1",
        "",
        f"Archive manifest SHA-256: `{manifest_hash}`",
        "",
        "## Coverage",
        "",
        f"- Numeric match files: {counts['numericMatchFiles']:,}",
        f"- IPL editions: {counts['iplEditions']}",
        f"- Normal innings: {counts['normalInnings']:,}",
        f"- Super Over innings: {counts['superOverInnings']:,}",
        f"- Raw venue strings: {counts['uniqueRawVenueStrings']}",
        f"- Raw city strings: {counts['uniqueRawCityStrings']}",
        "",
        "## Headline observations",
        "",
        f"- No-results: {counts['noResults']}",
        f"- D/L results: {counts['dlResults']}",
        f"- Eliminator-resolved ties: {counts['eliminatorResolvedTies']}",
        f"- Impact Player replacements: {counts['impactPlayerReplacements']}",
        f"- Concussion substitutes: {counts['concussionSubstitutes']}",
        f"- Injury role replacements: {counts['injuryRoleReplacements']}",
        f"- Excluded-bowler role replacements: {counts['excludedBowlerRoleReplacements']}",
        f"- Substitute-fielding events: {counts['substituteFieldingEvents']}",
        "",
        "## Legacy collision evidence",
        "",
        f"- Duplicate legacy player-season IDs: {counts['duplicateLegacyPlayerSeasonIds']}",
        f"- Duplicate legacy franchise-season IDs: {counts['duplicateLegacyFranchiseSeasonIds']}",
        "- The current processor normalizes both `2020/21` and `2021` to `2021`.",
        "",
        "## Validation",
        "",
        f"- Status: `{global_summary['validation']['status']}`",
        f"- Fatal errors: {global_summary['validation']['fatalErrorCount']}",
        f"- Baseline discrepancies: {global_summary['baselineDiscrepancyCount']}",
        "",
        "This audit preserves raw source strings and does not normalize, repair, or aggregate canonical data.",
    ]
    return "\n".join(lines) + "\n"
