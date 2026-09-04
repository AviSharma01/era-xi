from __future__ import annotations

import argparse
import sys
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.player_role_metadata import build_player_role_metadata_files, write_artifact_tree


def main() -> None:
    parser = argparse.ArgumentParser(description="Build deterministic Era Draft player-role and position-fit metadata.")
    parser.add_argument("--registry-dir", type=Path, default=Path("data/registries/ipl/v1"))
    parser.add_argument("--registry-policy", type=Path, default=Path("data/manual/identity/v1/registry_policy.json"))
    parser.add_argument("--normalized-dir", type=Path, default=Path("data/normalized/cricsheet-ipl/v1"))
    parser.add_argument("--analytical-dir", type=Path, default=Path("data/analytical/cricsheet-ipl/v1"))
    parser.add_argument("--eligibility-dir", type=Path, default=Path("data/processed/era-draft/v1"))
    parser.add_argument("--wicketkeeper-dir", type=Path, default=Path("data/metadata/ipl/v1"))
    parser.add_argument("--output-dir", type=Path, default=Path("data/processed/era-draft/roles/v1"))
    args = parser.parse_args()
    files, report = build_player_role_metadata_files(
        registry_dir=args.registry_dir,
        registry_policy_path=args.registry_policy,
        normalized_dir=args.normalized_dir,
        analytical_dir=args.analytical_dir,
        eligibility_dir=args.eligibility_dir,
        wicketkeeper_dir=args.wicketkeeper_dir,
    )
    write_artifact_tree(args.output_dir, files)
    print(f"Built player-role metadata with status {report['status']}")
    print(f"G2 profiles: {report['counts']['g2Profiles']}")
    print(f"Resolved batting fit: {report['counts']['fitResolvedProfiles']}")
    print(f"Unknown batting fit: {report['counts']['fitUnknownProfiles']}")


if __name__ == "__main__":
    main()
