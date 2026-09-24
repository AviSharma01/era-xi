# Cricsheet Mapping

Canonical interpretation rules for IPL Cricsheet JSON.

Detailed archive counts and edge-case examples belong in the Stage 1 audit outputs.

## Identity and match context

Important source fields:

- `info.season`
- `info.dates`
- `info.event`
- `info.teams`
- `info.players`
- `info.registry.people`
- `info.venue`
- `info.city`
- `info.toss`
- `info.outcome`
- `innings`

The numeric filename is the source match ID.

Resolve seasons, teams, players and venues through the canonical Stage 2 registries while retaining exact source values for provenance.

Use Cricsheet registry IDs as canonical player identities. Never resolve players by display name alone.

## Participation

`info.players.<team>` represents officially involved match participants, not necessarily the starting XI.

Preserve distinct evidence for:

- ordinary participation
- Impact/replacement participation
- concussion/role replacements
- substitute fielding
- absent hurt
- event-only participation

Do not collapse 12/13-player records into assumed XIs.

## Innings and Super Overs

Important fields include:

- `team`
- `super_over`
- `target`
- `powerplays`
- `absent_hurt`
- `miscounted_overs`
- `overs`

Use source `super_over` semantics.

Retain Super Overs in normalized data; exclude them only from later ordinary season statistics.

Preserve D/L, ties, no-results, revised targets, multi-date matches and miscounted overs rather than repairing them.

## Deliveries

Preserve:

- batter
- non-striker
- bowler
- batter/extras/total runs
- extras breakdown
- wickets
- fielders
- reviews
- replacements
- `actual_delivery` where present

`actual_delivery` is source traceability, not a unique legal-ball identifier.

## Ball semantics

Treat bowler legal balls and batter balls faced independently.

| Delivery | Bowler legal ball | Batter ball faced |
| --- | --- | --- |
| Wide | No | No |
| No-ball | No | Yes |
| Ordinary | Yes | Yes |

Known source exceptions should be handled explicitly rather than through shared predicates.

## Batting order

Reconstruct observed batting order by first chronological appearance as batter or non-striker.

Use canonical player IDs.

Do not assign positions to players who never appear in either role.

## Dismissals

Preserve exact dismissal kinds.

Bowler-credit dismissals:

- bowled
- caught
- caught and bowled
- lbw
- stumped
- hit wicket

Do not credit:

- run out
- retired hurt
- retired out
- obstructing the field

Keep batter-dismissal and bowler-credit semantics separate.

## Extras

Preserve wides, no-balls, byes, leg-byes and penalty runs.

Validate:

`runs.total = runs.batter + runs.extras`

and reconcile extras totals with their breakdown.

## Powerplays and phases

Preserve official Cricsheet powerplay information.

Fixed analytical phases such as powerplay/middle/death belong in the derived analytics layer, not raw normalization.

## Wicketkeeping

A stumping is positive wicketkeeping evidence.

An ordinary catch alone does not establish wicketkeeper status.

General wicketkeeper capability requires manual/external metadata.

## Non-derivable metadata

Cricsheet match data alone does not reliably provide:

- Country/overseas status.
- Batting hand.
- Bowling style.
- General role classification.
- General wicketkeeper capability.
- Player images.
- Non-playing registered squad members.

Keep these outside canonical match normalization.

## Layer boundary

Normalized Cricsheet data contains historical facts and provenance.

Ratings, tiers, eligibility, era normalization, team strength, boosters and simulation assumptions belong downstream.