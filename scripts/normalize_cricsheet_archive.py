from __future__ import annotations

import argparse
import sys
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.cricsheet_normalization.builder import build_normalized_archive


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build canonical normalized IPL match facts from the accepted Cricsheet archive."
    )
    parser.add_argument("--raw-dir", type=Path, default=Path("data/raw/cricsheet"))
    parser.add_argument("--audit-dir", type=Path, default=Path("data/audit/cricsheet-ipl/v1"))
    parser.add_argument("--registry-dir", type=Path, default=Path("data/registries/ipl/v1"))
    parser.add_argument("--policy-path", type=Path, default=Path("data/manual/identity/v1/registry_policy.json"))
    parser.add_argument("--output-dir", type=Path, default=Path("data/normalized/cricsheet-ipl/v1"))
    args = parser.parse_args()
    report = build_normalized_archive(
        raw_dir=args.raw_dir,
        audit_dir=args.audit_dir,
        registry_dir=args.registry_dir,
        policy_path=args.policy_path,
        output_dir=args.output_dir,
    )
    sizes = report["sizeReport"]
    print(f"Normalized {report['counts']['matches']} matches with status {report['status']}")
    print(f"Manifest SHA-256: {report['normalizationManifestHash']}")
    print(
        f"Match corpus: {sizes['matchCorpusLogicalBytes']} bytes "
        f"({sizes['matchCorpusHumanSize']}); complete tree: {sizes['outputTreeLogicalBytes']} bytes"
    )


if __name__ == "__main__":
    main()
