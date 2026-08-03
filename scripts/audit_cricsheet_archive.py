from __future__ import annotations

import argparse
from pathlib import Path

from scripts.cricsheet_audit.legacy_collision import build_legacy_collision_diagnostics
from scripts.cricsheet_audit.reporting import build_reports, write_reports
from scripts.cricsheet_audit.scanner import scan_archive


def audit_archive(raw_dir: Path, output_dir: Path) -> tuple[str, dict[str, int]]:
    scan = scan_archive(raw_dir)
    legacy_collisions = build_legacy_collision_diagnostics(raw_dir)
    reports, manifest_hash = build_reports(scan, legacy_collisions)
    sizes = write_reports(reports, output_dir)
    return manifest_hash, sizes


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Audit a local Cricsheet IPL JSON archive without normalizing or repairing it."
    )
    parser.add_argument("--raw-dir", type=Path, default=Path("data/raw/cricsheet"))
    parser.add_argument(
        "--output-dir", type=Path, default=Path("data/audit/cricsheet-ipl/v1")
    )
    args = parser.parse_args()

    manifest_hash, sizes = audit_archive(args.raw_dir, args.output_dir)
    print(f"Archive manifest SHA-256: {manifest_hash}")
    print(f"Wrote {len(sizes)} audit files ({sum(sizes.values())} bytes) to {args.output_dir}")


if __name__ == "__main__":
    main()
