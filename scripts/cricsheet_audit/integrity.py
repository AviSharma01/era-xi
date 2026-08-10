from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .reporting import calculate_manifest_hash
from .scanner import ArchiveScan, scan_archive


class ArchiveIntegrityError(ValueError):
    """Raised when the local raw archive disagrees with the accepted Stage 1 baseline."""


@dataclass(frozen=True)
class VerifiedArchive:
    scan: ArchiveScan
    manifest_hash: str
    manifest_metadata: dict[str, Any]
    season_report: dict[str, Any]
    identity_report: dict[str, Any]
    inventory_report: dict[str, Any]


def _load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ArchiveIntegrityError(f"Could not load Stage 1 JSON {path}: {error}") from error
    if not isinstance(value, dict):
        raise ArchiveIntegrityError(f"Stage 1 JSON must contain an object: {path}")
    return value


def _without_envelope(report: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in report.items()
        if key not in {"schemaVersion", "reportType", "archiveManifestHash"}
    }


def load_verified_archive(
    raw_dir: Path = Path("data/raw/cricsheet"),
    audit_dir: Path = Path("data/audit/cricsheet-ipl/v1"),
    *,
    expected_archive_manifest_hash: str,
) -> VerifiedArchive:
    """Recompute and verify the immutable Stage 1 archive before downstream ingestion."""

    manifest_metadata = _load_json(audit_dir / "manifest_metadata.json")
    season_report = _load_json(audit_dir / "season_coverage.json")
    identity_report = _load_json(audit_dir / "participant_identity_observations.json")
    inventory_report = _load_json(audit_dir / "raw_name_inventories.json")

    observed_hashes = {
        manifest_metadata.get("archiveManifestHash"),
        season_report.get("archiveManifestHash"),
        identity_report.get("archiveManifestHash"),
        inventory_report.get("archiveManifestHash"),
    }
    if observed_hashes != {expected_archive_manifest_hash}:
        raise ArchiveIntegrityError(
            "Stage 1 manifest hash disagreement: "
            f"expected={expected_archive_manifest_hash}, observed={sorted(str(value) for value in observed_hashes)}"
        )

    scan = scan_archive(raw_dir)
    actual_hash = calculate_manifest_hash(scan.manifest_entries)
    if actual_hash != expected_archive_manifest_hash:
        raise ArchiveIntegrityError(
            f"Archive manifest drift: expected {expected_archive_manifest_hash}, recomputed {actual_hash}"
        )
    if list(scan.season_coverage.values()) != season_report.get("seasons"):
        raise ArchiveIntegrityError("Recomputed season coverage differs from the committed Stage 1 report")
    if scan.identity != _without_envelope(identity_report):
        raise ArchiveIntegrityError("Recomputed participant identities differ from the committed Stage 1 report")
    if scan.inventories != _without_envelope(inventory_report):
        raise ArchiveIntegrityError("Recomputed raw identity inventories differ from the committed Stage 1 report")

    return VerifiedArchive(
        scan=scan,
        manifest_hash=actual_hash,
        manifest_metadata=manifest_metadata,
        season_report=season_report,
        identity_report=identity_report,
        inventory_report=inventory_report,
    )
