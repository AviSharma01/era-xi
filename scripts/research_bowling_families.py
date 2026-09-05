from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.cricsheet_audit.reporting import canonical_json_bytes, pretty_json_bytes
from scripts.player_role_metadata import (
    BOWLING_FAMILY_METADATA_SCHEMA_VERSION,
    ISSUE_URL,
    ROLE_METADATA_VERSION,
    normalize_bowling_family,
    write_artifact_tree,
)


REGISTER_URL = "https://cricsheet.org/register/people.csv"
ESPN_API_TEMPLATE = "https://site.web.api.espn.com/apis/common/v3/sports/cricket/athletes/{player_id}"
USER_AGENT = "draft-simulator-stage5-research/1.0 (+https://github.com/AviSharma01/draft-simulator/issues/1)"


class BowlingFamilyResearchError(ValueError):
    pass


def _sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _download(url: str, *, attempts: int = 4) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json,text/csv"})
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return response.read()
        except (OSError, urllib.error.URLError) as error:
            last_error = error
            if attempt + 1 < attempts:
                time.sleep(2 ** attempt)
    raise BowlingFamilyResearchError(f"Could not retrieve {url}: {last_error}")


def _load_queue(path: Path) -> list[dict[str, Any]]:
    try:
        queue = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise BowlingFamilyResearchError(f"Could not read review queue {path}: {error}") from error
    items = queue.get("bowlingFamilyItems")
    if not isinstance(items, list) or len(items) != 505:
        raise BowlingFamilyResearchError("Expected the frozen 505-player bowling-family queue")
    player_ids = [item.get("playerId") for item in items]
    if len(set(player_ids)) != len(player_ids):
        raise BowlingFamilyResearchError("Bowling-family queue contains duplicate player IDs")
    return sorted(items, key=lambda item: item["playerId"])


def _parse_register(content: bytes) -> dict[str, dict[str, str]]:
    try:
        rows = list(csv.DictReader(io.StringIO(content.decode("utf-8-sig"))))
    except UnicodeDecodeError as error:
        raise BowlingFamilyResearchError(f"Cricsheet register is not UTF-8: {error}") from error
    by_id = {row.get("identifier", ""): row for row in rows}
    if "" in by_id:
        del by_id[""]
    if len(by_id) != len(rows):
        raise BowlingFamilyResearchError("Cricsheet register contains duplicate or blank identifiers")
    return by_id


def _fetch_espn(cricinfo_id: str) -> tuple[dict[str, Any], bytes]:
    url = ESPN_API_TEMPLATE.format(player_id=cricinfo_id)
    content = _download(url)
    try:
        payload = json.loads(content)
    except json.JSONDecodeError as error:
        raise BowlingFamilyResearchError(f"ESPN response for {cricinfo_id} is not JSON: {error}") from error
    athlete = payload.get("athlete")
    if not isinstance(athlete, dict) or str(athlete.get("id")) != cricinfo_id:
        raise BowlingFamilyResearchError(f"ESPN athlete identity mismatch for {cricinfo_id}")
    return athlete, content


def _raw_styles(athlete: dict[str, Any]) -> list[str]:
    values: list[str] = []
    for style in athlete.get("bowlStyle") or []:
        description = style.get("description") if isinstance(style, dict) else None
        if isinstance(description, str) and description.strip() and description not in values:
            values.append(description)
    return values


def build_research_metadata(*, queue_path: Path, accessed_date: str, workers: int) -> dict[str, Any]:
    queue_items = _load_queue(queue_path)
    register_content = _download(REGISTER_URL)
    register = _parse_register(register_content)
    missing = [item["playerId"] for item in queue_items if not register.get(item["playerId"], {}).get("key_cricinfo")]
    if missing:
        raise BowlingFamilyResearchError(f"Cricsheet register lacks ESPN IDs for: {', '.join(missing)}")

    fetched: dict[str, tuple[dict[str, Any], bytes]] = {}
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {
            executor.submit(_fetch_espn, register[item["playerId"]]["key_cricinfo"]): item["playerId"]
            for item in queue_items
        }
        for future in as_completed(futures):
            player_id = futures[future]
            try:
                fetched[player_id] = future.result()
            except Exception as error:
                raise BowlingFamilyResearchError(f"ESPN research failed for Cricsheet {player_id}: {error}") from error

    response_hashes: dict[str, str] = {}
    assertions: list[dict[str, Any]] = []
    for item in queue_items:
        player_id = item["playerId"]
        register_row = register[player_id]
        cricinfo_id = register_row["key_cricinfo"]
        athlete, response_content = fetched[player_id]
        raw_styles = _raw_styles(athlete)
        family = normalize_bowling_family(raw_styles)
        response_hash = _sha256(response_content)
        response_hashes[player_id] = response_hash
        source_name = athlete.get("fullName") or athlete.get("displayName") or ""
        source_dob = athlete.get("displayDOB") or athlete.get("dateOfBirth")
        profile_url = f"https://www.espncricinfo.com/ci/content/player/{cricinfo_id}.html"
        assertions.append({
            "assertionId": f"bowling-family:{player_id}:default",
            "playerId": player_id,
            "canonicalDisplayName": item["canonicalDisplayName"],
            "bowlingFamily": family,
            "resolutionStatus": "APPROVED" if family != "UNKNOWN" else "UNKNOWN",
            "rawBowlingStyles": raw_styles,
            "identityMatch": {
                "method": "CRICSHEET_REGISTER_EXACT_EXTERNAL_ID",
                "cricsheetId": player_id,
                "externalPlayerId": cricinfo_id,
                "registerName": register_row.get("name") or register_row.get("unique_name") or "",
                "sourcePlayerName": str(source_name),
                "sourceDateOfBirth": str(source_dob) if source_dob else None,
            },
            "evidenceRefs": [{
                "sourceId": "espncricinfo-player-api",
                "sourceFamily": "ESPNCRICINFO",
                "url": profile_url,
                "locator": "athlete.bowlStyle[].description",
                "observedValues": raw_styles or ["<missing>"],
                "contentSha256": response_hash,
            }],
            "notes": "Exact Cricsheet key_cricinfo bridge; explicit ESPN profile bowling-style field.",
        })

    metadata = {
        "schemaVersion": BOWLING_FAMILY_METADATA_SCHEMA_VERSION,
        "roleMetadataVersion": ROLE_METADATA_VERSION,
        "trackingIssue": ISSUE_URL,
        "sources": [
            {
                "sourceId": "cricsheet-people-register",
                "sourceFamily": "IDENTITY_REGISTER",
                "publisher": "Cricsheet",
                "title": "Cricsheet Register people.csv",
                "url": REGISTER_URL,
                "accessedDate": accessed_date,
                "contentSha256": _sha256(register_content),
                "locator": "identifier -> key_cricinfo",
            },
            {
                "sourceId": "espncricinfo-player-api",
                "sourceFamily": "ESPNCRICINFO",
                "publisher": "ESPNcricinfo",
                "title": "ESPN cricket athlete profile API",
                "url": "https://site.web.api.espn.com/apis/common/v3/sports/cricket/athletes/",
                "accessedDate": accessed_date,
                "contentSha256": _sha256(canonical_json_bytes(response_hashes)),
                "locator": "athlete.id; athlete.fullName; athlete.displayDOB; athlete.bowlStyle[].description",
            },
        ],
        "playerDefaults": assertions,
        "seasonOverrides": [],
    }
    metadata["metadataHash"] = _sha256(canonical_json_bytes(metadata))
    return metadata


def main() -> None:
    parser = argparse.ArgumentParser(description="Research Stage 5 bowling families through exact Cricsheet-to-ESPN IDs.")
    parser.add_argument("--queue", type=Path, default=Path("data/processed/era-draft/roles/v1/review_queue.json"))
    parser.add_argument("--output", type=Path, default=Path("data/manual/player_role_metadata/v1/bowling_families.json"))
    parser.add_argument("--accessed-date", required=True)
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()
    if not 1 <= args.workers <= 16:
        raise SystemExit("--workers must be between 1 and 16")
    metadata = build_research_metadata(queue_path=args.queue, accessed_date=args.accessed_date, workers=args.workers)
    write_artifact_tree(args.output.parent, {args.output.name: pretty_json_bytes(metadata)})
    counts: dict[str, int] = {}
    for assertion in metadata["playerDefaults"]:
        family = assertion["bowlingFamily"]
        counts[family] = counts.get(family, 0) + 1
    print(f"Wrote {len(metadata['playerDefaults'])} bowling-family assertions to {args.output}")
    print("Family counts: " + ", ".join(f"{family}={counts.get(family, 0)}" for family in ("PACE", "SPIN", "MIXED", "UNKNOWN")))


if __name__ == "__main__":
    main()
