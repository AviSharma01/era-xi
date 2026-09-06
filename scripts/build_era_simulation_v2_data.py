#!/usr/bin/env python3
import sys
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.era_simulation_v2_data import main


if __name__ == "__main__":
    main()
