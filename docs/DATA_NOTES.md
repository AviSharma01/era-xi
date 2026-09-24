# Data Notes

## Source and identity

Use Cricsheet IPL JSON as the primary historical match source.

Treat `data/raw/` as immutable.

The game uses specific player-team-season versions, with identity resolved through the canonical registries.

Data flow:

Raw Cricsheet
→ audit
→ canonical identities
→ normalized matches
→ analytical datasets
→ ratings
→ game/simulation inputs

Keep generated data separate from manual corrections.

## Local data bootstrap

Restore the exact raw Cricsheet archive at `data/raw/ipl_json.zip` and verify SHA-256 `841b98290a08bdf2a063a9f4d6342fb2363ff246491ed3db4c571bddb6ea2a79`. Do not automatically download or substitute a newer archive.

Stage 1, Stage 2 and Stage 3 implementations are committed, as are the Stage 2 canonical registry artifacts. The large Stage 3 normalized-match corpus and Stage 4 analytical JSONL corpus are intentionally regenerated locally.

Stage 5 role/fit and Stage 6 quality are versioned downstream outputs.

Fresh-clone flow: verify raw archive → regenerate/verify required Stage 1 audit artifacts → use committed Stage 2 registries → run Stage 3 normalization → run Stage 4 analytics. Stage 2 does not normally need to be regenerated.

## Derived data

### Player-team-season

Derive:

- Match participation.
- Runs, balls faced and dismissals.
- Strike rate, boundaries and dot rate.
- Batting-position distribution.
- Batting phase usage.
- Wickets and legal balls.
- Economy/strike rate.
- Bowling workload and phase usage.
- Wicketkeeping/bowling-option evidence.
- Sample/reliability information.

### Team/season/environment

Stage 4 derives:

- Team-season batting and bowling profiles.
- Season scoring environments.
- Venue-season environments.
- First-innings/chase context.
- Phase-level scoring and wicket patterns.

## Statistical rules

- Preserve stable Cricsheet player IDs and canonical team/season/venue identities.
- Do not credit run-outs to bowlers.
- Batter balls faced and bowler legal balls are separate concepts.
- Preserve Super Overs in normalized data but exclude them from ordinary season aggregates.
- Preserve D/L, ties, no-results, replacements and other unusual-match context.
- Keep source lineage for every derived player-season value.
- Treat uncertain derivations as review items instead of guessing.

`info.players` represents officially involved participants, not necessarily an original starting XI.

Historical Impact Player/replacement information must be preserved even though user-controlled substitutions are not part of the initial game.

## Manual metadata

Manual/external enrichment may be required for:

- Cricket nation and IPL roster status.
- Role corrections.
- Wicketkeeper capability.
- Batting hand.
- Bowling style.
- Player images.

Allow season-specific overrides where necessary.

### Cricket nation and IPL roster status

Country/overseas enrichment is maintained under the independent `ipl-country-overseas-metadata/v1` family. It consumes canonical Stage 2 identities and the committed eligibility universe; it does not modify raw, normalized, analytical or eligibility data.

- `cricketNationId` is a descriptive cricket jurisdiction, not birthplace and not necessarily an ISO country.
- `iplRosterStatus` is `INDIAN`, `OVERSEAS` or `UNKNOWN`. It alone controls the Era Draft maximum-four-overseas rule.
- Player defaults may be replaced by an explicit `(playerId, seasonId)` override.
- `classificationBasis` records whether a resolved row used the player default or a season override.
- `nationResolutionMethod` and `rosterStatusResolutionMethod` independently record whether each field came from a direct IPL designation, an approved policy derivation or manual review. They may differ on one assertion; `classificationBasis` remains the separate default-versus-override dimension.
- Manual sources are reusable across assertions and must carry provenance. Legacy 2016 values are research leads only.
- Missing evidence produces explicit `UNKNOWN`; it must never produce an Indian/default classification.
- Era Draft game-input generation must fail for missing, duplicate, conflicting or `UNKNOWN` G2 roster metadata.

The committed V1 browser artifacts apply this fail-closed rule and are content-addressed in `data/processed/era-draft/web/v1/public/data/era-draft/v1/manifest.json`. Release verification compares those committed bytes with a deterministic in-memory rebuild; it does not regenerate them.

See `docs/COUNTRY_OVERSEAS_METADATA.md` for the complete contract. Classic 2016 remains on its protected legacy metadata until a separately approved migration.

## Eligibility

G2 player-team-season eligibility is frozen in the versioned eligibility artifacts.

Insufficient player-seasons are excluded rather than assigned E/F tiers.

## Era normalization

Raw statistics across IPL seasons are not directly comparable.

Stage 5 role/fit is separate from Stage 6 season-normalized base quality and does not alter it.
