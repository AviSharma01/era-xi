# IPL Country / Overseas Metadata

## Purpose and boundary

`ipl-country-overseas-metadata/v1` is the canonical enrichment family for player cricket jurisdiction and historical IPL roster-rule status. It is independent from the identity registry, match-derived datasets, wicketkeeper metadata, eligibility, ratings and Classic 2016.

Stage 1 establishes schemas, provenance contracts, deterministic resolution and research queues. Current coverage and state are represented by the versioned artifacts, manifest and SUMMARY.

## Canonical concepts

`cricketNationId` identifies a controlled cricket jurisdiction for descriptive use. It is not birthplace, citizenship or an ISO-only country field. `UNKNOWN` is an explicit unresolved sentinel and is not a catalog entry.

`iplRosterStatus` is `INDIAN`, `OVERSEAS` or `UNKNOWN`. It is the only metadata field authorized to drive the IPL maximum-four-overseas rule. Runtime code must never infer it from `cricketNationId`.

`classificationBasis` describes structural resolution:

- `PLAYER_DEFAULT`: the player-level default was used, including a generated unresolved default.
- `SEASON_OVERRIDE`: a complete approved `(playerId, seasonId)` override replaced the default.

`nationResolutionMethod` and `rosterStatusResolutionMethod` independently describe how the corresponding field was established:

- `UNRESOLVED`
- `DIRECT_IPL_DESIGNATION`
- `POLICY_DERIVED`
- `MANUAL_REVIEW`

These field methods must not be collapsed into one row-level method, and both remain separate from `classificationBasis`. For example, an official auction row may directly designate `cricketNationId = england` while the roster status is derived through policy: `nationResolutionMethod = DIRECT_IPL_DESIGNATION` and `rosterStatusResolutionMethod = POLICY_DERIVED` on a `PLAYER_DEFAULT` or `SEASON_OVERRIDE` assertion.

## Manual evidence contract

Manual inputs live in `data/manual/country_overseas_metadata/v1/` and contain reusable sources, player defaults, season overrides and dispositions. Sources may carry a reusable `batchId`, and one source may support many assertions, enabling source-first squad, auction or registration research.

Evidence references are field-specific:

- `cricketNationEvidenceRefs`
- `rosterStatusEvidenceRefs`

Each evidence reference contains a `sourceId`, a strict locator and a temporal scope. The locator has nullable `page`, `section`, `table`, `row`, `observedValue` and `text` fields; at least one must be populated. This keeps the reusable source record separate while allowing every assertion to point to its exact rendered evidence. Generated rows preserve the complete structured references.

Evidence-reference temporal scopes are:

- `SEASON`, with exactly one `seasonId`;
- `MULTI_SEASON`, with two or more explicitly listed season IDs;
- `PLAYER_DEFAULT`, with the exact screened committed season IDs.

Season overrides must have an assertion-level `SEASON` scope matching their `(playerId, seasonId)` key. A player default must have assertion-level `PLAYER_DEFAULT` scope and a `defaultPromotion` record containing:

- `FULL_COMMITTED_SPAN_SCREENED`;
- the complete committed player-season span;
- `contradictoryEvidenceFound: false`;
- `unresolvedTemporalChange: false`;
- a non-empty promotion rationale.

Known field evidence on a player default must cover that complete span. A single-season source therefore cannot silently become a player default. Season overrides remain sufficient when a default cannot be justified.

Known values require approved supporting sources and a non-`UNRESOLVED` method for that field. Unknown values cannot carry positive evidence and require that field's method to be `UNRESOLVED`. Direct designation requires field-specific official IPL evidence; policy derivation requires the applicable approved policy source in that field's evidence references. Duplicate defaults, duplicate season keys, unknown identities, unknown catalog IDs, missing or empty locators, unknown seasons, incomplete temporal coverage, missing sources, source-purpose mismatches and contradictory records stop publication.

A known roster status may coexist with an unknown cricket nation only when an approved `NATION_CLOSED_UNKNOWN` disposition documents the unresolved descriptive field. The resolved review state is then `ROSTER_APPROVED_NATION_UNRESOLVED`.

## Resolution and generated artifacts

The builder verifies the Stage 2 registry and committed eligibility manifest. It generates one player row for every canonical player and one resolved row for every committed player-team-season.

Resolution order is:

1. Use an approved player default when present; otherwise create an explicit all-`UNKNOWN` default.
2. Replace the complete default for a season when an approved `(playerId, seasonId)` override exists.
3. Materialize the result onto each canonical `playerTeamSeasonId` without changing eligibility.

Generated artifacts are stored under `data/metadata/ipl/country_overseas/v1/` with strict schemas, content hashes, an aggregate hash and a self-hashed manifest. The G2 queue is blocking; the non-G2 backlog is not.

Legacy `data/manual/player_metadata_template.json` rows are identity-mapped into a comparison report as leads. They remain `UNVERIFIED` until new provenance-backed assertions support or contradict them.

## UNKNOWN and fail-closed behavior

An unresolved Stage 1 row has:

```text
cricketNationId = UNKNOWN
iplRosterStatus = UNKNOWN
classificationBasis = PLAYER_DEFAULT
nationResolutionMethod = UNRESOLVED
rosterStatusResolutionMethod = UNRESOLVED
reviewState = PENDING
```

Future Era Draft game-input generation must reject any G2 profile with missing metadata, duplicate metadata, conflicting metadata or `iplRosterStatus == UNKNOWN`. Only after all checks pass may a downstream artifact map `INDIAN` to `isOverseas: false` and `OVERSEAS` to `isOverseas: true`.

Cricket nation is descriptive and is not itself a roster-rule blocker. It may remain explicitly unresolved under the reviewed exception described above.

## Compatibility boundaries

- The country/overseas builder consumes eligibility but never changes eligibility status, reasons, membership or admissions.
- Wicketkeeper capability, usage, review ledgers, manifests and generated artifacts are frozen and are neither inputs nor outputs of this family.
- Classic 2016 continues to consume its legacy prepared/rated artifacts. The new metadata family does not modify or feed Classic code or data.
- Era Draft runtime integration is approved and fail-closed for every G2 profile. Classic migration remains separate and requires explicit approval.
