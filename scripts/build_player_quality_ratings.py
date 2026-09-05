from __future__ import annotations

import argparse
import sys
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.player_quality_ratings import build_player_quality_files, write_artifact_tree


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build deterministic Era Draft player-quality ratings and tiers."
    )
    parser.add_argument(
        "--analytical-dir",
        type=Path,
        default=Path("data/analytical/cricsheet-ipl/v1"),
    )
    parser.add_argument(
        "--eligibility-dir",
        type=Path,
        default=Path("data/processed/era-draft/v1"),
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("data/processed/era-draft/quality/v1"),
    )
    args = parser.parse_args()
    files, report = build_player_quality_files(
        analytical_dir=args.analytical_dir,
        eligibility_dir=args.eligibility_dir,
    )
    write_artifact_tree(args.output_dir, files)
    print(f"Built Stage 6 quality metadata with status {report['status']}")
    print(f"G2 profiles: {report['counts']['g2Profiles']}")
    print(f"G2 players: {report['counts']['g2Players']}")
    print("Quality tiers: " + ", ".join(
        f"{tier}={count}" for tier, count in report["qualityTierCounts"].items()
    ))
    print(f"Blocking review cases: {report['counts']['blockingReviewCases']}")


if __name__ == "__main__":
    main()
