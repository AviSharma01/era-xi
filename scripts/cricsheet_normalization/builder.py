from __future__ import annotations

import hashlib
import json
import os
import shutil
import statistics
import tempfile
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from scripts.cricsheet_audit.integrity import ArchiveIntegrityError, load_verified_archive
from scripts.cricsheet_audit.reporting import canonical_json_bytes, pretty_json_bytes
from scripts.identity_registry.resolver import IdentityResolver
from scripts.identity_registry.schemas import SchemaValidationError, validate_instance

from .normalizer import DATASET_VERSION, MatchNormalizationError, normalize_match
from .schemas import (
    MANIFEST_SCHEMA_VERSION,
    REPORT_SCHEMA_VERSION,
    build_schema_documents,
)


EXPECTED_ARCHIVE_MANIFEST_HASH = "c61f75f3facac0f72e126fd611cdf6afed7da875d628ae62338cba1d5380cbf7"
EXPECTED_REGISTRY_VERSION = "ipl-identities-v1"
EXPECTED_REGISTRY_AGGREGATE_HASH = "9b23cafe4c2020b43fec7a3d80a13152270164b216ccd5cea3a1b552428ecac7"

EXPECTED_COUNTS = {
    "matches": 1243,
    "normalInnings": 2480,
    "superOverInnings": 34,
    "deliveries": 295732,
    "impactPlayerReplacements": 557,
    "concussionSubstitutes": 6,
    "roleReplacements": 61,
    "substituteFieldingEvents": 227,
    "reviews": 990,
}
EXPECTED_DISMISSALS = {
    "bowled": 2460,
    "caught": 9321,
    "caught and bowled": 410,
    "hit wicket": 20,
    "lbw": 883,
    "obstructing the field": 4,
    "retired hurt": 19,
    "retired out": 6,
    "run out": 1194,
    "stumped": 388,
}
EXPECTED_EXTRAS_OCCURRENCES = {
    "byes": 745,
    "legbyes": 4406,
    "noballs": 1226,
    "penalty": 2,
    "wides": 9876,
}


class NormalizationBuildError(ValueError):
    pass


def _human_size(value: int) -> str:
    amount = float(value)
    units = ["B", "KiB", "MiB", "GiB"]
    for unit in units:
        if amount < 1024 or unit == units[-1]:
            return f"{amount:.2f} {unit}" if unit != "B" else f"{int(amount)} B"
        amount /= 1024
    raise AssertionError("unreachable")


def _write(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)


def _tree_allocated_bytes(root: Path) -> int:
    total = root.stat().st_blocks * 512
    for path in root.rglob("*"):
        total += path.stat().st_blocks * 512
    return total


def _tree_files(root: Path) -> dict[str, bytes]:
    return {
        path.relative_to(root).as_posix(): path.read_bytes()
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


def _summary_markdown(report: dict[str, Any]) -> str:
    counts = report["counts"]
    sizes = report["sizeReport"]
    return "\n".join([
        "# Canonical Normalized IPL Matches v1",
        "",
        f"Normalization manifest SHA-256: `{report['normalizationManifestHash']}`",
        "",
        "## Coverage",
        "",
        f"- Matches: {counts['matches']:,}",
        f"- Normal innings: {counts['normalInnings']:,}",
        f"- Super Over innings: {counts['superOverInnings']:,}",
        f"- Deliveries: {counts['deliveries']:,}",
        f"- Impact Player replacements: {counts['impactPlayerReplacements']:,}",
        f"- Concussion substitutes: {counts['concussionSubstitutes']:,}",
        f"- Role replacements: {counts['roleReplacements']:,}",
        f"- Substitute-fielding events: {counts['substituteFieldingEvents']:,}",
        "",
        "## Generated size",
        "",
        f"- Match corpus logical size: {sizes['matchCorpusLogicalBytes']:,} bytes ({sizes['matchCorpusHumanSize']})",
        f"- Match file min / median / average / max: {sizes['minimumMatchBytes']:,} / {sizes['medianMatchBytes']:,} / {sizes['averageMatchBytes']:,.2f} / {sizes['maximumMatchBytes']:,} bytes",
        f"- Schema bundle: {sizes['schemaBundleBytes']:,} bytes",
        f"- Manifest: {sizes['manifestBytes']:,} bytes",
        f"- Validation report: {sizes['validationReportBytes']:,} bytes",
        f"- Summary: {sizes['summaryBytes']:,} bytes",
        f"- Complete tree logical size: {sizes['outputTreeLogicalBytes']:,} bytes",
        f"- Complete tree allocated size: {sizes['outputTreeAllocatedBytes']:,} bytes ({sizes['outputTreeAllocatedHumanSize']})",
        "",
        "## Validation",
        "",
        f"- Status: `{report['status']}`",
        f"- Fatal errors: {len(report['errors'])}",
        f"- Deterministic warnings: {report['warningCount']:,}",
        "- Stage 1 source provenance and Stage 2 registry integrity verified.",
        "- Match files are reproducible generated corpus data and are intentionally ignored by Git.",
        "",
    ])


def _base_report(
    *,
    manifest_hash: str,
    counts: dict[str, int],
    dismissals: dict[str, int],
    extras: dict[str, int],
    warnings: list[dict[str, Any]],
    sizes: dict[str, Any],
) -> dict[str, Any]:
    return {
        "schemaVersion": REPORT_SCHEMA_VERSION,
        "datasetVersion": DATASET_VERSION,
        "normalizationManifestHash": manifest_hash,
        "status": "passed_with_warnings" if warnings else "passed",
        "counts": {
            **counts,
            "unresolvedIdentities": 0,
            "newIngestionUnsafeReviews": 0,
        },
        "checks": {
            "sourceProvenanceFailures": 0,
            "identityFailures": 0,
            "schemaFailures": 0,
            "runReconciliationFailures": 0,
            "extrasReconciliationFailures": 0,
            "legalityFailures": 0,
            "wicketSemanticFailures": 0,
            "teamConsistencyFailures": 0,
            "targetFailures": 0,
            "duplicateMatchIds": 0,
        },
        "dismissalKinds": dismissals,
        "extrasOccurrences": extras,
        "sizeReport": sizes,
        "warningCount": len(warnings),
        "warnings": warnings,
        "errors": [],
    }


def _render_report_and_summary(
    staging_dir: Path,
    *,
    manifest_hash: str,
    counts: dict[str, int],
    dismissals: dict[str, int],
    extras: dict[str, int],
    warnings: list[dict[str, Any]],
    match_sizes: list[int],
    schema_bytes: int,
    manifest_bytes: int,
    report_schema: dict[str, Any],
) -> tuple[bytes, bytes, dict[str, Any]]:
    corpus_bytes = sum(match_sizes)
    sizes: dict[str, Any] = {
        "matchFileCount": len(match_sizes),
        "matchCorpusLogicalBytes": corpus_bytes,
        "matchCorpusHumanSize": _human_size(corpus_bytes),
        "minimumMatchBytes": min(match_sizes),
        "medianMatchBytes": int(statistics.median(match_sizes)),
        "averageMatchBytes": round(statistics.mean(match_sizes), 2),
        "maximumMatchBytes": max(match_sizes),
        "schemaBundleBytes": schema_bytes,
        "manifestBytes": manifest_bytes,
        "validationReportBytes": 0,
        "summaryBytes": 0,
        "outputTreeLogicalBytes": 0,
        "outputTreeAllocatedBytes": 0,
        "outputTreeAllocatedHumanSize": "0 B",
    }
    report_bytes = b""
    summary_bytes = b""
    for _attempt in range(12):
        report = _base_report(
            manifest_hash=manifest_hash,
            counts=counts,
            dismissals=dismissals,
            extras=extras,
            warnings=warnings,
            sizes=sizes,
        )
        report_bytes = pretty_json_bytes(report)
        summary_bytes = _summary_markdown(report).encode("utf-8")
        _write(staging_dir / "validation_report.json", report_bytes)
        _write(staging_dir / "SUMMARY.md", summary_bytes)
        updated = dict(sizes)
        updated["validationReportBytes"] = len(report_bytes)
        updated["summaryBytes"] = len(summary_bytes)
        updated["outputTreeLogicalBytes"] = corpus_bytes + schema_bytes + manifest_bytes + len(report_bytes) + len(summary_bytes)
        updated["outputTreeAllocatedBytes"] = _tree_allocated_bytes(staging_dir)
        updated["outputTreeAllocatedHumanSize"] = _human_size(updated["outputTreeAllocatedBytes"])
        if updated == sizes:
            validate_instance(report, report_schema)
            return report_bytes, summary_bytes, report
        sizes = updated
    raise NormalizationBuildError("Generated size report did not reach a deterministic fixed point")


def build_normalized_archive(
    *,
    raw_dir: Path = Path("data/raw/cricsheet"),
    audit_dir: Path = Path("data/audit/cricsheet-ipl/v1"),
    registry_dir: Path = Path("data/registries/ipl/v1"),
    policy_path: Path = Path("data/manual/identity/v1/registry_policy.json"),
    output_dir: Path = Path("data/normalized/cricsheet-ipl/v1"),
) -> dict[str, Any]:
    try:
        resolver = IdentityResolver.load(
            registry_dir,
            policy_path=policy_path,
            expected_registry_version=EXPECTED_REGISTRY_VERSION,
            expected_registry_aggregate_hash=EXPECTED_REGISTRY_AGGREGATE_HASH,
            expected_source_archive_manifest_hash=EXPECTED_ARCHIVE_MANIFEST_HASH,
        )
        verified = load_verified_archive(
            raw_dir,
            audit_dir,
            expected_archive_manifest_hash=EXPECTED_ARCHIVE_MANIFEST_HASH,
        )
    except (ValueError, ArchiveIntegrityError) as error:
        raise NormalizationBuildError(str(error)) from error
    if getattr(resolver, "registry_aggregate_hash", None) != EXPECTED_REGISTRY_AGGREGATE_HASH:
        raise NormalizationBuildError("Loaded resolver did not expose the pinned registry aggregate hash")
    if getattr(resolver, "source_archive_manifest_hash", None) != EXPECTED_ARCHIVE_MANIFEST_HASH:
        raise NormalizationBuildError("Loaded resolver did not expose the pinned Stage 1 hash")

    schemas = build_schema_documents()
    output_parent = output_dir.parent
    output_parent.mkdir(parents=True, exist_ok=True)
    staging_dir = Path(tempfile.mkdtemp(dir=output_parent, prefix=f".{output_dir.name}.", suffix=".tmp"))
    try:
        schema_files: list[dict[str, Any]] = []
        schema_bytes_total = 0
        for name, schema in sorted(schemas.items()):
            content = pretty_json_bytes(schema)
            path = f"schemas/{name}"
            _write(staging_dir / path, content)
            schema_bytes_total += len(content)
            schema_files.append({
                "path": path,
                "sha256": hashlib.sha256(content).hexdigest(),
                "sizeBytes": len(content),
            })

        counts: Counter[str] = Counter()
        dismissal_counts: Counter[str] = Counter()
        extras_counts: Counter[str] = Counter()
        season_counts: dict[str, Counter[str]] = defaultdict(Counter)
        warnings: list[dict[str, Any]] = []
        match_entries: list[dict[str, Any]] = []
        match_sizes: list[int] = []
        aggregate = hashlib.sha256()
        seen_match_ids: set[str] = set()

        for source_entry in verified.scan.manifest_entries:
            match_id = source_entry["matchId"]
            source_path = source_entry["relativeSourcePath"]
            if match_id in seen_match_ids:
                raise NormalizationBuildError(f"Duplicate match ID during normalization: {match_id}")
            seen_match_ids.add(match_id)
            raw_bytes = (raw_dir / source_path).read_bytes()
            actual_source_hash = hashlib.sha256(raw_bytes).hexdigest()
            if actual_source_hash != source_entry["fileSha256"]:
                raise NormalizationBuildError(f"Source file changed after Stage 1 verification: {source_path}")
            try:
                source_data = json.loads(raw_bytes)
                normalized = normalize_match(
                    source_data,
                    match_id=match_id,
                    relative_source_path=source_path,
                    source_file_sha256=actual_source_hash,
                    source_archive_manifest_hash=verified.manifest_hash,
                    identity_registry_version=EXPECTED_REGISTRY_VERSION,
                    identity_registry_aggregate_hash=EXPECTED_REGISTRY_AGGREGATE_HASH,
                    resolver=resolver,
                )
                validate_instance(normalized.document, schemas["normalized_match.schema.json"])
            except (UnicodeDecodeError, json.JSONDecodeError, MatchNormalizationError, SchemaValidationError) as error:
                raise NormalizationBuildError(f"Could not normalize {source_path}: {error}") from error

            season_id = normalized.document["season"]["seasonId"]
            relative_output = f"{season_id}/{match_id}.json"
            content = pretty_json_bytes(normalized.document)
            _write(staging_dir / relative_output, content)
            match_sizes.append(len(content))
            aggregate.update(relative_output.encode("utf-8"))
            aggregate.update(b"\0")
            aggregate.update(content)
            match_entry = {
                "path": relative_output,
                "matchId": match_id,
                "seasonId": season_id,
                "sourceFileSha256": actual_source_hash,
                "sha256": hashlib.sha256(content).hexdigest(),
                "sizeBytes": len(content),
                "normalInnings": normalized.counts["normalInnings"],
                "superOverInnings": normalized.counts["superOverInnings"],
                "deliveries": normalized.counts["deliveries"],
            }
            match_entries.append(match_entry)
            counts["matches"] += 1
            for key in EXPECTED_COUNTS:
                if key != "matches":
                    counts[key] += normalized.counts[key]
            for key in ("normalInnings", "superOverInnings", "deliveries"):
                season_counts[season_id][key] += normalized.counts[key]
            season_counts[season_id]["matches"] += 1
            dismissal_counts.update(normalized.counts["dismissalKinds"])
            extras_counts.update(normalized.counts["extrasOccurrences"])
            warnings.extend(normalized.warnings)

        actual_counts = {key: counts[key] for key in EXPECTED_COUNTS}
        if actual_counts != EXPECTED_COUNTS:
            raise NormalizationBuildError(f"Archive-wide count mismatch: {actual_counts} != {EXPECTED_COUNTS}")
        actual_dismissals = {key: dismissal_counts[key] for key in EXPECTED_DISMISSALS}
        if actual_dismissals != EXPECTED_DISMISSALS or set(dismissal_counts) != set(EXPECTED_DISMISSALS):
            raise NormalizationBuildError(f"Dismissal coverage mismatch: {dict(dismissal_counts)}")
        actual_extras = {key: extras_counts[key] for key in EXPECTED_EXTRAS_OCCURRENCES}
        if actual_extras != EXPECTED_EXTRAS_OCCURRENCES or set(extras_counts) != set(EXPECTED_EXTRAS_OCCURRENCES):
            raise NormalizationBuildError(f"Extras coverage mismatch: {dict(extras_counts)}")

        match_entries.sort(key=lambda item: (int(item["matchId"]), item["path"]))
        season_count_rows = [
            {"seasonId": season_id, **{key: values[key] for key in ("matches", "normalInnings", "superOverInnings", "deliveries")}}
            for season_id, values in sorted(season_counts.items())
        ]
        manifest_payload = {
            "schemaVersion": MANIFEST_SCHEMA_VERSION,
            "datasetVersion": DATASET_VERSION,
            "sourceArchiveManifestHash": verified.manifest_hash,
            "identityRegistryVersion": EXPECTED_REGISTRY_VERSION,
            "identityRegistryAggregateHash": EXPECTED_REGISTRY_AGGREGATE_HASH,
            "counts": actual_counts,
            "seasonCounts": season_count_rows,
            "matchFiles": match_entries,
            "schemaFiles": schema_files,
            "normalizedMatchAggregateHash": aggregate.hexdigest(),
        }
        manifest_hash = hashlib.sha256(canonical_json_bytes(manifest_payload)).hexdigest()
        manifest = {**manifest_payload, "normalizationManifestHash": manifest_hash}
        try:
            validate_instance(manifest, schemas["normalization_manifest.schema.json"])
        except SchemaValidationError as error:
            raise NormalizationBuildError(f"Normalization manifest schema failure: {error}") from error
        manifest_bytes = pretty_json_bytes(manifest)
        _write(staging_dir / "normalization_manifest.json", manifest_bytes)

        warnings.sort(key=lambda item: (item["code"], int(item["matchId"] or 0), item["sourcePath"] or ""))
        report_bytes, summary_bytes, report = _render_report_and_summary(
            staging_dir,
            manifest_hash=manifest_hash,
            counts=actual_counts,
            dismissals=actual_dismissals,
            extras=actual_extras,
            warnings=warnings,
            match_sizes=match_sizes,
            schema_bytes=schema_bytes_total,
            manifest_bytes=len(manifest_bytes),
            report_schema=schemas["validation_report.schema.json"],
        )

        expected_files = {
            *(entry["path"] for entry in match_entries),
            *(entry["path"] for entry in schema_files),
            "normalization_manifest.json", "validation_report.json", "SUMMARY.md",
        }
        actual_files = set(_tree_files(staging_dir))
        if actual_files != expected_files:
            raise NormalizationBuildError(
                f"Staged artifact set mismatch; missing={sorted(expected_files - actual_files)}, "
                f"unexpected={sorted(actual_files - expected_files)}"
            )
        for entry in match_entries + schema_files:
            content = (staging_dir / entry["path"]).read_bytes()
            if len(content) != entry["sizeBytes"] or hashlib.sha256(content).hexdigest() != entry["sha256"]:
                raise NormalizationBuildError(f"Staged artifact hash mismatch: {entry['path']}")
        if len(report_bytes) != report["sizeReport"]["validationReportBytes"]:
            raise NormalizationBuildError("Validation report size disagrees with its recorded size")
        if len(summary_bytes) != report["sizeReport"]["summaryBytes"]:
            raise NormalizationBuildError("Summary size disagrees with its recorded size")

        if output_dir.exists():
            if _tree_files(output_dir) != _tree_files(staging_dir):
                raise NormalizationBuildError(
                    f"Immutable dataset already exists with different bytes: {output_dir}; publish a new version"
                )
            shutil.rmtree(staging_dir)
            return report
        os.replace(staging_dir, output_dir)
        return report
    except BaseException:
        if staging_dir.exists():
            shutil.rmtree(staging_dir)
        raise
