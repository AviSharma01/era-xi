from __future__ import annotations

import argparse
import sys
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.identity_registry.builder import generate_registries


def main() -> None:
    parser = argparse.ArgumentParser(description="Build canonical IPL identity registries from the accepted Stage 1 archive.")
    parser.add_argument("--raw-dir", type=Path, default=Path("data/raw/cricsheet"))
    parser.add_argument("--audit-dir", type=Path, default=Path("data/audit/cricsheet-ipl/v1"))
    parser.add_argument("--manual-dir", type=Path, default=Path("data/manual/identity/v1"))
    parser.add_argument("--legacy-metadata", type=Path, default=Path("data/manual/player_metadata_template.json"))
    parser.add_argument("--output-dir", type=Path, default=Path("data/registries/ipl/v1"))
    args = parser.parse_args()
    outputs = generate_registries(
        output_dir=args.output_dir,
        raw_dir=args.raw_dir,
        audit_dir=args.audit_dir,
        manual_dir=args.manual_dir,
        legacy_metadata_path=args.legacy_metadata,
    )
    print(f"Wrote {len(outputs)} deterministic registry files to {args.output_dir}")


if __name__ == "__main__":
    main()
