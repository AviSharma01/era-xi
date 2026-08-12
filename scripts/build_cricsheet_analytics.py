from __future__ import annotations

import argparse
import sys
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.cricsheet_analytics.builder import build_analytical_archive


def main() -> None:
    parser = argparse.ArgumentParser(description="Build deterministic historical IPL analytical profiles from Stage 3.")
    parser.add_argument("--normalized-dir", type=Path, default=Path("data/normalized/cricsheet-ipl/v1"))
    parser.add_argument("--output-dir", type=Path, default=Path("data/analytical/cricsheet-ipl/v1"))
    args = parser.parse_args()
    report = build_analytical_archive(normalized_dir=args.normalized_dir, output_dir=args.output_dir)
    sizes = report["sizeReport"]
    print(f"Built Stage 4 analytics with status {report['status']}")
    print(f"Manifest SHA-256: {report['analyticalManifestHash']}")
    print(f"Analytical rows: {sizes['analyticalDataBytes']} bytes; complete tree: {sizes['outputTreeLogicalBytes']} bytes")


if __name__ == "__main__":
    main()
