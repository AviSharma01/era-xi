from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

from scripts.cricsheet_audit.reporting import canonical_json_bytes
from scripts.identity_registry.schemas import SchemaValidationError, validate_instance


EXPECTED_STAGE1_HASH = "c61f75f3facac0f72e126fd611cdf6afed7da875d628ae62338cba1d5380cbf7"
EXPECTED_STAGE2_VERSION = "ipl-identities-v1"
EXPECTED_STAGE2_HASH = "9b23cafe4c2020b43fec7a3d80a13152270164b216ccd5cea3a1b552428ecac7"
EXPECTED_STAGE3_DATASET_VERSION = "cricsheet-ipl-normalized/v1"
EXPECTED_STAGE3_MANIFEST_HASH = "005da3be0fb64f946c869a8ab97cd9ea7e0c00e2e49f1bfb3d1c07e7726d6cec"
EXPECTED_STAGE3_AGGREGATE_HASH = "fb6a14f439124d57a8a39ff1c58a90ca0e5393e7d0a428b29f785600bea6eaaa"


class AnalyticalInputError(ValueError):
    pass


@dataclass(frozen=True)
class VerifiedNormalizedDataset:
    root: Path
    manifest: dict[str, Any]
    manifest_bytes: bytes
    match_schema: dict[str, Any]

    def iter_matches(self) -> Iterator[tuple[dict[str, Any], dict[str, Any]]]:
        for entry in self.manifest["matchFiles"]:
            path = self.root / entry["path"]
            try:
                document = json.loads(path.read_bytes())
            except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
                raise AnalyticalInputError(f"Could not re-read normalized match {entry['path']}: {error}") from error
            yield entry, document


def _read_json(path: Path, label: str) -> tuple[bytes, dict[str, Any]]:
    try:
        content = path.read_bytes()
        value = json.loads(content)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise AnalyticalInputError(f"Could not read {label} at {path}: {error}") from error
    if not isinstance(value, dict):
        raise AnalyticalInputError(f"{label} must be a JSON object")
    return content, value


def load_verified_normalized_dataset(
    root: Path = Path("data/normalized/cricsheet-ipl/v1"),
    *,
    expected_manifest_hash: str = EXPECTED_STAGE3_MANIFEST_HASH,
) -> VerifiedNormalizedDataset:
    manifest_bytes, manifest = _read_json(root / "normalization_manifest.json", "Stage 3 manifest")
    if manifest.get("datasetVersion") != EXPECTED_STAGE3_DATASET_VERSION:
        raise AnalyticalInputError("Unexpected Stage 3 dataset version")
    if manifest.get("sourceArchiveManifestHash") != EXPECTED_STAGE1_HASH:
        raise AnalyticalInputError("Stage 1 provenance pin drifted")
    if manifest.get("identityRegistryVersion") != EXPECTED_STAGE2_VERSION:
        raise AnalyticalInputError("Stage 2 registry version drifted")
    if manifest.get("identityRegistryAggregateHash") != EXPECTED_STAGE2_HASH:
        raise AnalyticalInputError("Stage 2 registry hash drifted")
    if manifest.get("normalizationManifestHash") != expected_manifest_hash:
        raise AnalyticalInputError("Stage 3 manifest hash does not match the pinned hash")
    payload = dict(manifest)
    recorded_self_hash = payload.pop("normalizationManifestHash", None)
    actual_self_hash = hashlib.sha256(canonical_json_bytes(payload)).hexdigest()
    if recorded_self_hash != actual_self_hash:
        raise AnalyticalInputError("Stage 3 manifest self-hash is invalid")
    if manifest.get("normalizedMatchAggregateHash") != EXPECTED_STAGE3_AGGREGATE_HASH:
        raise AnalyticalInputError("Stage 3 normalized aggregate hash drifted")

    schema_by_path: dict[str, dict[str, Any]] = {}
    for entry in manifest.get("schemaFiles", []):
        path = root / entry["path"]
        content, schema = _read_json(path, f"Stage 3 schema {entry['path']}")
        if len(content) != entry["sizeBytes"] or hashlib.sha256(content).hexdigest() != entry["sha256"]:
            raise AnalyticalInputError(f"Stage 3 schema integrity failure: {entry['path']}")
        schema_by_path[entry["path"]] = schema
    manifest_schema = schema_by_path.get("schemas/normalization_manifest.schema.json")
    match_schema = schema_by_path.get("schemas/normalized_match.schema.json")
    if manifest_schema is None or match_schema is None:
        raise AnalyticalInputError("Stage 3 required schemas are missing")
    try:
        validate_instance(manifest, manifest_schema)
    except SchemaValidationError as error:
        raise AnalyticalInputError(f"Stage 3 manifest schema failure: {error}") from error

    aggregate = hashlib.sha256()
    seen_ids: set[str] = set()
    seen_paths: set[str] = set()
    for entry in manifest.get("matchFiles", []):
        match_id = entry["matchId"]
        relative_path = entry["path"]
        if match_id in seen_ids or relative_path in seen_paths:
            raise AnalyticalInputError(f"Duplicate Stage 3 match identity/path: {match_id} / {relative_path}")
        seen_ids.add(match_id)
        seen_paths.add(relative_path)
        path = root / relative_path
        try:
            content = path.read_bytes()
            document = json.loads(content)
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise AnalyticalInputError(f"Could not read normalized match {relative_path}: {error}") from error
        if len(content) != entry["sizeBytes"] or hashlib.sha256(content).hexdigest() != entry["sha256"]:
            raise AnalyticalInputError(f"Normalized match integrity failure: {relative_path}")
        if document.get("matchId") != match_id or document.get("season", {}).get("seasonId") != entry["seasonId"]:
            raise AnalyticalInputError(f"Normalized match manifest mismatch: {relative_path}")
        try:
            validate_instance(document, match_schema)
        except SchemaValidationError as error:
            raise AnalyticalInputError(f"Normalized match schema failure in {relative_path}: {error}") from error
        aggregate.update(relative_path.encode("utf-8"))
        aggregate.update(b"\0")
        aggregate.update(content)
    if aggregate.hexdigest() != EXPECTED_STAGE3_AGGREGATE_HASH:
        raise AnalyticalInputError("Recomputed Stage 3 normalized aggregate hash differs")
    if len(seen_ids) != manifest.get("counts", {}).get("matches"):
        raise AnalyticalInputError("Stage 3 manifest match count does not match its entries")
    return VerifiedNormalizedDataset(root, manifest, manifest_bytes, match_schema)
