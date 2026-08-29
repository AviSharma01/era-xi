from __future__ import annotations

import argparse
import sys
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.wicketkeeper_metadata import build_wicketkeeper_metadata_files, write_artifact_tree


def main() -> None:
    parser = argparse.ArgumentParser(description="Build canonical IPL wicketkeeper metadata from verified Stage 2-4 data.")
    parser.add_argument("--registry-dir", type=Path, default=Path("data/registries/ipl/v1"))
    parser.add_argument("--registry-policy", type=Path, default=Path("data/manual/identity/v1/registry_policy.json"))
    parser.add_argument("--normalized-dir", type=Path, default=Path("data/normalized/cricsheet-ipl/v1"))
    parser.add_argument("--analytical-dir", type=Path, default=Path("data/analytical/cricsheet-ipl/v1"))
    parser.add_argument("--manual-overlay", type=Path, default=Path("data/manual/wicketkeeper_metadata/v1/metadata.json"))
    parser.add_argument("--legacy-metadata", type=Path, default=Path("data/manual/player_metadata_template.json"))
    parser.add_argument("--output-dir", type=Path, default=Path("data/metadata/ipl/v1"))
    args = parser.parse_args()
    files, report = build_wicketkeeper_metadata_files(
        registry_dir=args.registry_dir, registry_policy_path=args.registry_policy,
        normalized_dir=args.normalized_dir,
        analytical_dir=args.analytical_dir, manual_overlay_path=args.manual_overlay,
        legacy_metadata_path=args.legacy_metadata,
    )
    write_artifact_tree(args.output_dir, files)
    print(f"Built wicketkeeper metadata with status {report['status']}")
    print(f"Stumping events: {report['counts']['stumpingEvents']}")
    print(f"Confirmed capability players: {report['counts']['capabilityPlayers']}")
    print(f"Confirmed usage profiles: {report['counts']['confirmedUsageProfiles']}")


if __name__ == "__main__":
    main()
