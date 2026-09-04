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

## Sparse evidence and enrichment

Batting and bowling confidence are independent. Sparse data remains visible through evidence counts, derivation basis and review queues instead of being hidden in one score.

Cricsheet does not provide bowling style. A later enrichment phase must research provenance-backed player defaults with explicit season overrides and the values `PACE`, `SPIN`, `MIXED` or `UNKNOWN`. Unresolved players must not count toward either pace or spin coverage.

## Consumer contract

Downstream Era Draft code consumes categorical slot fit, confidence, basis, primary bands and band distance. Stage 5 does not publish rating multipliers. Team construction may aggregate bowling capacity and phase shares, but bowling balance remains a soft evaluation/simulation factor rather than draft legality.
