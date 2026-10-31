# Evaluation V3 — implementation and review record

## Behavior

New Solo games use `ipl-era-draft-team-evaluation/v3`. New Standard Draft-Off rooms use competition v4 and the same evaluator. Contributions use the unchanged catalog's specific player-team-season, locked slot, classification and band distance.

| Classification | Band distance | Diagnostic severity | Nominal deduction |
| --- | --- | --- | --- |
| NATURAL | 0 | NATURAL | 0% |
| ACCEPTABLE | 1–4 | ACCEPTABLE | 5% |
| OUT_OF_ROLE | 2 | MODERATE | 12% |
| OUT_OF_ROLE | 3 | MAJOR | 20% |
| OUT_OF_ROLE | 4 | EXTREME | 30% |
| UNKNOWN | null | UNKNOWN | 0% |

Classification takes precedence over distance. There are 539 committed acceptable slot assertions at distances greater than one. Adjacent bands are acceptable; inconsistent combinations such as distance-one OUT_OF_ROLE are rejected by V3. No role metadata is rewritten.

For raw contribution `r = battingRating ?? 20`, effective contribution is `max(20, r × (1 − percentage / 100))`. The floor is retained by explicit product decision. Diagnostics distinguish nominal and actual deductions: 25 with a nominal 30% penalty becomes 20, an actual 20% loss. Imputed contributions remain at 20.

Team batting remains `0.9 × mean(slots 1–7) + 0.1 × mean(slots 8–11)`, now calculated from effective contributions without a team-wide cap. Team overall remains the mean of adjusted batting and bowling. V3 reuses frozen V2 validation, base aggregation and bowling deployment; it never consumes V2's fitted/capped batting outputs. Player quality ratings, overall ratings and tiers do not change.

Batting bands remain 1–2 / 3 / 4–5 / 6–8 / 9–11. Opening positions are equivalent for fit. An opener at eight receives a 20% mismatch, while nine through eleven receive 30%, unless historical acceptable evidence takes precedence. The existing aggregation-weight boundary between seven and eight remains.

No structural boost, construction bonus, bowling penalty, simulation coefficient, legality, tier-cap or historical-data change is included. Approved opponent XIs and their frozen V2 strengths remain unchanged in all games.

## Compatibility contracts

| Owner | Engine / state / save | Evaluation |
| --- | --- | --- |
| Historical Solo | v1 / v2 / v2 | V2 |
| New Solo | v2 / v3 / v3 | V3, explicitly pinned before drafting |
| Historical Draft-Off | v1, v2 or v3 matching triples | V2 |
| New Draft-Off | v4 / v4 / v4 | V3, explicitly pinned in genesis |

Low-level constructors with no evaluation field preserve their historical behavior. Public Solo initialization explicitly passes V3. The public room adapter explicitly passes V3 plus format and copied effective Standard caps. V4 requires all three; old genesis shapes forbid the evaluation field. There is no host policy option or migration command.

Every restoration/replay/invariant path validates the version combination. Unfinished historical Solo drafts and pending historical room lobbies retain V2, including when they reveal, start or resolve after release. New nested room drafts use the new Solo state contract and must match the owning competition's policy. No restore path supplies today's creation defaults.

Catalog hashes, manifests and runtime provenance stay frozen. The catalog's V2 evaluator identifier describes the frozen input/opponent verification contract, not the active drafted-XI evaluator. Active policy comes from persisted state/genesis and the resulting evaluation's own version.

Solo seed identity already includes engine and evaluation versions. Draft-Off gameplay XI identity now hashes the selected evaluation version in its existing version field. Round/draft/schedule seed derivations, submission identity, simulation algorithm and ranking are unchanged. Identical ordered XIs under the same policy receive identical gameplay outcomes regardless of participant identity. A V3 XI cannot enter a V2 campaign through a missing or mismatched policy argument.

New room frames use version 4 with `round.teamEvaluationVersion`; historical frames retain versions 1–3 and their existing shapes. Results use envelope version 2 only for V3 diagnostics; historical results retain exact version-1 output. HTTP routes, invites, socket subprotocol and credentials remain unchanged. Strict readers accept both generations and reject cross-version fields.

## Diagnostics and presentation boundary

The authoritative V3 result contains each player's fit classification, band distance, severity, nominal percentage, actual percentage, raw/effective contribution, nominal/actual deduction, floor and imputation flags, aggregation weight and weighted deduction. Team diagnostics expose nominal and applied weighted deductions; adjusted strengths contain batting, bowling and final overall. Values retain full precision; there is no intermediate display rounding.

The shared reveal projection whitelists these fields as `players[].battingAdjustment`, `evaluation.teamEvaluationVersion` and `evaluation.battingAdjustment`. The team adjustment contains base batting, nominal deduction, applied deduction and adjusted batting. Existing `evaluation.strength` remains the final simulation strength. Weighted player deductions reconcile with the team difference within floating-point tolerance.

These additions are available after Solo reveal or through the existing authorized resolved-room results endpoint. Projection does not evaluate or simulate. Candidate/private draft views and public progress frames carry no player penalty diagnostics. Room-wide evaluation version is public rules metadata. Existing fit badges, layout and player quality values are unchanged; the later UI can distinguish major versus extreme using diagnostic severity.

## Calibration evidence

The planning comparison was read-only against 2,992 eligible player-seasons and all 49 representative XIs. Natural XIs in every era remain unchanged. Across representative XIs, mean overall changes versus V2 were −0.110 Foundation, −0.091 Expansion, −0.036 Transition, −0.046 Modern Pre-Impact and −0.092 Impact.

| Controlled opener ↔ No. 4 swap | Team batting V2 → V3 | Overall V2 → V3 |
| --- | --- | --- |
| Marsh, Punjab 2008 | 60.25 → 58.72 | 63.21 → 62.45 |
| Hussey, CSK 2013 | 61.60 → 60.62 | 66.85 → 66.36 |
| Kohli, RCB 2016 | 61.97 → 60.82 | 65.65 → 65.08 |
| Buttler, Rajasthan 2022 | 60.77 → 59.59 | 63.85 → 63.27 |
| Gill, Gujarat 2023 | 58.01 → 56.56 | 67.43 → 66.70 |

Kohli 2016 at eleven contributes 98.10 → 68.67. Existing slot weighting lowers raw team batting by 8.09 points for that exchange; V3 adds 0.74 points of weighted positional loss. Final batting is 54.17 and overall 61.75. At eight, his contribution is 78.48.

For reversed Rajasthan 2022, V3 batting/overall is 41.79/54.37. Retaining a four-point cap would produce 44.08/55.51; a 10%-of-base cap would produce 43.27/55.11 despite identical individual deductions. Removing the cap keeps team aggregation reconcilable with individual adjustments.

The planning sample of 200 legal fit-first drafted XIs (half Standard-capped) had per-era/configuration mean V3 batting deductions of 0.00–0.06. Reversal produced means of 6.44–6.89. Of 4,900 deterministic permutations, 66.4–75.5% per era exceeded four points; the largest observed loss was 9.69. These are controlled sensitivity scenarios, not player-behavior estimates. The 20 floor limits 1,013 of 32,912 player-slot combinations.

Paired 2,000-match representative scenarios holding randomness fixed showed V2→V3 win-rate changes of −1.05 to −1.30 percentage points for moderate swaps and −2.25 to −3.30 for reversals. Actual versioned V3 seeds differ, so this isolates strength sensitivity rather than forecasting room leaderboards.

`npm run validate:evaluation-v3` reproduces representative strength comparisons and observes evaluator microbenchmark latency without modifying source data. Stage E's existing controlled workerd gate remains p95 ≤2 seconds and maximum ≤3 seconds; shared-host observe runs are not deployed latency claims.

## Verification and release procedure

The legacy fixture file was captured from the compiled pre-integration runtime: 30 Solo lifecycle saves across all eras and 21 v1/v2/v3 room lifecycle saves. Tests preserve serialized bytes, accepted-command replay, historical result hashes and projection hashes. The original 80 backend fixtures and their manifest remain untouched.

Separate V3 goldens cover 15 Solo states and 20 resolved rooms (five eras × two formats × two/eight entrants). The one-time capture script uses exclusive creation; do not recapture a changed policy to accept drift. Bump the contract for intentional future changes. Arithmetic/calibration tests independently check the agreed percentage table, floor, band behavior, unchanged bowling and the cap-removal examples.

Run `npm run verify:release`, `npm run verify:backend` and `npm run validate:evaluation-v3`. Backend checks require permission to bind local loopback ports. Controlled performance hosts may additionally set `DRAFT_OFF_PERFORMANCE_MODE=enforce` for Stage E; ordinary correctness keeps its existing observe policy.

Ship readers for both contract generations before enabling V3 creation in a deployment. Frontend/backend must support room frames v4 and results v2 together. This source revision explicitly opts new public games into V3; historical creation is still available through the explicit legacy constructor contract. A rollback must retain V3/v4 readers for already-created games, and may disable new V3 creation rather than downgrade stored state. There is no automatic conversion of historical or new saves.

Implementation is prepared for independent review. No commit, push, merge or deployment is part of this batch.

## Review evidence — 1 November 2026

All three implementation stages are complete on `feat/era-evaluation-v3`, with changes left uncommitted for independent review.

- `npm run verify:release`: PASS, 441 tests; production web build/smoke; all-era draft validation with all correctness counters zero. Browser-facing coverage fetches the original content-addressed artifacts and round-trips both V2 and V3 saves without catalog migration.
- `npm run verify:backend`: PASS, 132 checks across the backend lanes; all 80 original canonical fixture hashes unchanged. Live HTTP checks cover historical v1/v2/v3 lost CREATE replies and lobby continuation, plus new v4 sockets, restart, deadline auto-submission and envelope-v2 results diagnostics.
- V3-focused coverage: six evaluator tests and 27 compatibility/integration cases, including the 20 new room goldens. Separate immutable legacy fixtures preserve 30 Solo and 21 room lifecycle saves. The existing reveal test received only a type annotation; the format fixture builder now explicitly removes the new policy field when reconstructing historical contracts and additionally covers v2/v3.
- Representative calibration reproduces the planning figures. A local 10,000-call microbenchmark observed V3 mean 0.007018 ms / p95 0.007917 ms, compared with V2 mean 0.006143 ms / p95 0.007000 ms. These measurements are observational, not a controlled performance gate.
- The final Stage E eight-player production smoke passed its observe-mode budget check: spin p95 1,850.63 ms, lock p95 1,959.40 ms, lock-batch p95 1,959.86 ms and final submission 485.24 ms. An earlier run warned at lock p95 2,076.95 ms / lock-batch 2,077.45 ms. The 2,000 ms p95 / 3,000 ms maximum budgets were not changed; limited latency headroom remains an independent-review/release consideration. Controlled performance mode was not run.
- Eight-player resolved-result reads observed warm p95 197.54 ms, cold p95 508.31 ms and maximum response size 26,573 bytes, within the unchanged 2 MiB limit.
- `git diff --check`: clean. The V2 evaluator, Classic evaluator, Simulation V2 algorithm, all historical data, original frozen fixtures and their hash manifest remain unchanged. No dependencies, UI layout, tier caps or drafting legality changed.

No commit, push, merge or deployment was performed. Independent review has not been performed as part of this implementation run.
