# Player Roles and Position Fit

Implementation is tracked in [GitHub Issue #1](https://github.com/AviSharma01/draft-simulator/issues/1).

## Boundary

Stage 5 describes how a player-team-season was used. It does not measure how well the player performed.

- Quality owns runs, wickets, efficiency, ratings and tiers.
- Role owns observed batting placement and bowling workload/phase usage.
- Fit compares a drafted batting slot with historical placement.
- Wicketkeeper capability and usage remain in the frozen wicketkeeper metadata family.
- Classic 2016 remains on its existing role, fit and evaluation implementation.

No Stage 5 classification may depend on runs, wickets, batting average, strike rate, bowling economy, player rating or tier.

## Batting fit

Exact observed positions 1–11 remain preserved. Position fit uses five robust bands:

- `OPENING`: 1–2
- `TOP_ORDER`: 3
- `MIDDLE_ORDER`: 4–5
- `LOWER_ORDER`: 6–8
- `TAIL`: 9–11

Four or more season innings use season evidence only. One to three innings use a leave-one-profile-out player-history prior when at least four other innings exist. Zero-innings profiles use that same history as a low-confidence fallback; otherwise fit is explicitly `UNKNOWN`.

The prior contributes `4 - seasonInnings` effective observations. It never raises season confidence. Fit is `NATURAL` in a modal band, `ACCEPTABLE` in a band with at least 15% effective share or adjacent to a modal band, and `OUT_OF_ROLE` otherwise.

## Bowling usage

Bowling capacity is derived without performance statistics:

```text
capacity = min(1, legalBalls / (24 * officialAppearances))
```

- `NONE`: no legal balls
- `OCCASIONAL`: capacity below 0.25
- `SUPPORT`: capacity from 0.25 through below 0.75
- `FRONTLINE`: capacity at least 0.75

Powerplay, middle and death shares describe deployment only. They do not establish pace/spin style or bowling quality.

## Sparse evidence and bowling-family enrichment

Batting and bowling confidence are independent. Sparse data remains visible through evidence counts, derivation basis and review queues instead of being hidden in one score.

Cricsheet does not provide bowling style. The 505-player G2 research universe is therefore resolved through provenance-backed player defaults with explicit season overrides reserved for genuine historical changes. The committed assertion layer preserves the raw source style and maps it through a closed deterministic lookup to `PACE`, `SPIN`, `MIXED` or `UNKNOWN`.

An exact Cricsheet `identifier` to `key_cricinfo` bridge, paired with an explicit ESPNcricinfo `athlete.bowlStyle[].description` value and no conflicting evidence, is sufficient for approval. Missing, ambiguous or unrecognized source text remains `UNKNOWN`. Cross-source disagreement becomes `CONFLICT`; it never becomes `MIXED` automatically. `MIXED` requires one source record to state styles that genuinely span pace and spin.

The research script is networked and records source locators and content hashes. The normal Stage 5 builder is offline: it validates the committed assertions, their self-hash, exact research-universe coverage, identity bridges, closed normalization, conflicts and provenance before emitting player bowling-family rows. No bowling family is inferred from workload, role, phase, wickets, economy, name or reputation.

## Derived presentation roles

The player-team-season presentation role is deterministic and non-canonical. Meaningful bowling means `SUPPORT` or `FRONTLINE`; meaningful batting means a primary `CORE` or `LOWER` responsibility.

1. Meaningful batting plus meaningful bowling produces `ALL_ROUNDER` and preserves the derived `BATTING`, `BOWLING` or `BALANCED` lean.
2. Remaining meaningful bowling produces `BOWLER`.
3. Remaining profiles with frozen player-team-season wicketkeeper usage `CONFIRMED` produce `WICKETKEEPER_BATTER`.
4. Remaining profiles with usable batting-position evidence produce `BATTER`.
5. Anything without one of those signals remains `UNKNOWN`.

Player-level keeper capability remains a separate future draft-eligibility signal and cannot change the historical season role by itself. Both season usage and capability are exposed as direct frozen references rather than re-inferred by Stage 5. Bowling family does not participate in the role or workload derivation.

## Consumer contract

`player_role_consumer.jsonl` is the stable TypeScript-facing Stage 5 boundary. Each G2 player-team-season row exposes:

- `derivedRole` and optional `allRounderLean`
- `battingFit`: confidence, basis, primary bands, and ordered slot 1–11 records containing `slotBand`, categorical classification and nullable band distance
- bowling capacity, workload class, evidence, family and powerplay/middle/death usage
- direct frozen wicketkeeper metadata version, capability status/player reference and season-usage status/profile reference

The contract publishes no ratings, tiers, multipliers, penalties, effective ratings, team boosts or bowling-balance selection rules. `UNKNOWN` batting fit has `NONE` confidence, no primary bands, and `UNKNOWN` slot classifications with null distance; this is neutral descriptive metadata rather than an automatic penalty.

The TypeScript contract module validates the generated shape and enums but is not wired into Classic 2016 or the Era Draft runtime. Later Team Evaluation work may consume this boundary and separately define evaluation effects.
