from __future__ import annotations

import argparse
import sys
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.country_overseas_metadata import (
    build_country_overseas_metadata_files,
    write_artifact_tree,
)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build deterministic IPL cricket-nation and overseas-status metadata."
    )
    parser.add_argument("--registry-dir", type=Path, default=Path("data/registries/ipl/v1"))
    parser.add_argument(
        "--registry-policy",
        type=Path,
        default=Path("data/manual/identity/v1/registry_policy.json"),
    )
    parser.add_argument(
        "--eligibility-dir",
        type=Path,
        default=Path("data/processed/era-draft/v1"),
    )
    parser.add_argument(
        "--manual-metadata",
        type=Path,
        default=Path("data/manual/country_overseas_metadata/v1/metadata.json"),
    )
    parser.add_argument(
        "--cricket-nations",
        type=Path,
        default=Path("data/manual/country_overseas_metadata/v1/cricket_nations.json"),
    )
    parser.add_argument(
        "--legacy-metadata",
        type=Path,
        default=Path("data/manual/player_metadata_template.json"),
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("data/metadata/ipl/country_overseas/v1"),
    )
    args = parser.parse_args()

    files, report = build_country_overseas_metadata_files(
        registry_dir=args.registry_dir,
        registry_policy_path=args.registry_policy,
        eligibility_dir=args.eligibility_dir,
        manual_metadata_path=args.manual_metadata,
        cricket_nations_path=args.cricket_nations,
        legacy_metadata_path=args.legacy_metadata,
    )
    write_artifact_tree(args.output_dir, files)
    counts = report["counts"]
    print(f"Built country/overseas metadata with status {report['status']}")
    print(f"Canonical players: {counts['canonicalPlayers']}")
    print(f"Player-team-seasons: {counts['playerTeamSeasons']}")
    print(f"Blocking G2 players: {counts['blockingG2Players']}")
    print(f"Blocking G2 profiles: {counts['blockingG2Profiles']}")


if __name__ == "__main__":
    main()
