# Draft-Off Gameplay Validation

This document records the conclusions from the exploratory gameplay validation completed before Draft-Off M2. It is a decision record, not a new simulation specification.

## Draft depth

- Shared draft opportunities produced strong XI diversity.
- Different drafting strategies produced meaningfully different legal teams.
- Drafting quality materially affected campaign results.

## Model A: rejected

Fully shared match randomness was rejected for Draft-Off because it made paired leaderboard ordering too deterministic. In the initial exploratory sample, the highest-evaluated XI finished first in every challenge.

## Model B: approved

- All contestants face the same 20 opponents in the same order.
- Each distinct XI receives its own deterministic match variance.
- The same XI and fixture always reproduce the same simulation.
- Different XIs in the same fixture receive distinct deterministic variance.
- Participant identity and metadata do not affect simulation randomness.
- Model B retained a strong team-quality signal while allowing close-quality XIs to trade leaderboard positions.

## Venue effects: deferred

Existing venue-season samples were too sparse and unstable, and reliable pace-versus-spin venue outcome data was unavailable. No venue coefficients were added to gameplay.

## Bowling family and phase coverage: deferred

Pace/spin and phase-usage diagnostics remain useful descriptively. Experimental penalties did not show a stable independent performance signal and risked double-counting weaknesses already represented by bowling quality and capacity. No new bowling-construction penalty was added.

## 20-match format

The 20-match Draft-Off campaign behaved reasonably in exploratory validation. No evidence justified changing the match count at this stage.

## Frozen Draft-Off simulation contract

M1 and M1.1 establish:

- a shared deterministic opponent schedule;
- the full frozen opponent pool for the selected era;
- XI-specific deterministic residual variance;
- the existing authoritative NRR calculation;
- ranking by points, then full-precision NRR; and
- shared rank for exact ties.

Venue effects and bowling-construction effects remain explicitly deferred.

## Standard Draft-Off rules (Batch 2)

New Draft-Off rooms use a fixed Standard preset for both Varied and Mirror:
maximum three S-tier players and maximum six S+A players combined, with no B/C/D
limits. Tier classification is the catalog's authoritative quality tier for the
selected player-team-season. Hosts cannot customize caps. Keeper, maximum-four
overseas, canonical uniqueness and locked batting positions remain required.
Room creation freezes effective values; existing v1/v2 rooms remain uncapped.
Solo Era Draft is unchanged. These restrictions change legal team construction,
not ratings, simulation, position penalties, boosts or leaderboard calculations.

Completion checks preserve an existential legal XI under the remaining tier and
overseas budgets with a keeper. Tier and roster costs stay coupled to actual
historical variants, and a canonical player can be selected once. The tests cover
240 seeded XIs across all eras and both formats with elite-first and mixed choices
and late respins, plus 160 deterministic scarce catalogs checked against an
independent exhaustive search. This is feasibility validation, not a balance study
or a claim that Varied opportunities are equal.

## Evaluation V3 (Batch 3)

New Solo games and Draft-Off competition v4 apply the agreed percentage penalties
to batting contributions, retain the 20 floor and remove the four-point team
cap. Historical games retain V2; approved opponents keep frozen strengths.
Structural boosts remain deferred. The all-era calibration, version boundaries,
post-reveal diagnostics and verification evidence are recorded in
[Evaluation V3](EVALUATION_V3.md).
