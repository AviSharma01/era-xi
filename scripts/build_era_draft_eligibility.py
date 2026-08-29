from __future__ import annotations

import argparse
import sys
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.era_draft_eligibility import build_era_draft_eligibility_files, write_artifact_tree


def main() -> None:
    parser = argparse.ArgumentParser(description="Build deterministic Era Draft G2 eligibility decisions.")
    parser.add_argument("--analytical-dir", type=Path, default=Path("data/analytical/cricsheet-ipl/v1"))
    parser.add_argument("--metadata-dir", type=Path, default=Path("data/metadata/ipl/v1"))
    parser.add_argument("--output-dir", type=Path, default=Path("data/processed/era-draft/v1"))
    args = parser.parse_args()
    files, report = build_era_draft_eligibility_files(
        analytical_dir=args.analytical_dir, metadata_dir=args.metadata_dir,
    )
    write_artifact_tree(args.output_dir, files)
    print(f"Built Era Draft eligibility with status {report['status']}")
    print(f"G2 eligible profiles: {report['counts']['g2EligibleProfiles']}")
    print(f"Eligibility-critical review cases: {report['counts']['eligibilityCriticalReviewCases']}")


if __name__ == "__main__":
    main()
