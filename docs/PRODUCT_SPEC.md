# Product Specification

## Goal

Build a fast, replayable historical IPL drafting and season-simulation game.

Era Draft is the flagship experience: build an XI from specific historical player-seasons within an IPL era, then compete against representative historical opponents from that era.

## Era Draft core loop

1. Choose an IPL era.
2. Spin a specific franchise-season.
3. View its eligible player-seasons.
4. Select one player.
5. Lock that player into batting position 1–11.
6. Repeat until the XI is complete.
7. Reveal ratings, position fit and team construction.
8. Simulate the league stage.
9. Play playoffs if qualified.
10. Show the final outcome.

## Provisional eras

- Foundation: 2008–2010
- Expansion: 2011–2013
- Transition: 2014–2017
- Modern Pre-Impact: 2018–2022
- Impact: 2023–2026

Era membership uses explicit canonical season IDs. Boundaries remain provisional until validated against historical data.

## Draft rules

- Exactly 11 players; no bench.
- Each selection is a specific player-team-season.
- The same real player cannot be drafted twice through different seasons.
- Locked batting positions cannot be changed.
- One voluntary respin.
- Maximum four overseas players.
- At least one wicketkeeper.
- Numeric ratings remain hidden until reveal.
- Bowling depth and phase coverage are normally soft evaluation/simulation factors.

During drafting, useful information may include player name, team/season, role, batting-position fit, overseas/keeper status and relevant season statistics.

## Team reveal

After drafting, reveal:

- Player ratings and tiers.
- Position fit.
- Team batting and bowling strength.
- Team construction.
- Applicable boosts/team effects.

Base player quality remains the primary driver.

The current Boost V1 system is scaffolding. Richer cricket-specific effects will be designed later from actual role and usage data.

## Era opponents

Era Draft uses representative historical franchise-seasons from the selected era.

Representative teams should reflect both normalized team quality and historical performance rather than table finish alone.

Drafting a player does not remove that player from historical opponents.

Opponent player statistics and scorecards do not need to be exposed in the initial experience.

## Simulation

League simulation should remain fast.

Simulation V2 may use:

- Era/season scoring environment.
- Venue context.
- Batting and bowling quality.
- Toss/innings context.
- Player usage.
- Team construction/effects.
- Seeded variance.

The objective is believable results, not a full ball-by-ball cricket recreation.

## Modes

### Era Draft
Flagship multi-season historical mode.

### Classic Season
Secondary mode using one specific IPL season.

### Auction Purse
Later ruleset using visible tiers, tier costs and a fixed purse.

### Tier Cap
Later ruleset limiting elite players and rewarding balanced construction.

## Current state

A working 2016 Classic mode supports:

Draft
→ position locking
→ team reveal
→ league
→ playoffs
→ final outcome

Era Draft now supports all five eras through draft, reveal, deterministic local persistence/replay, league play, playoffs and final outcome. Each era uses era-normalized player-seasons and a frozen representative-opponent pool.

V1 release work is limited to reliability, accessibility, attribution, documentation and deployment verification. It does not include player imagery, Draft-Off V2 or the deferred systems below.

## Deferred

Do not let these block the first complete Era Draft:

- Bench/injury systems.
- User-controlled Impact Player substitutions.
- Captain/coaching systems.
- Full opponent scorecards/statistics.
- Tournament-wide awards simulation.
- Ball-by-ball controls.
- Detailed weather/pitch simulation.
- Multiplayer/accounts.
- Player-card artwork/photos.
- Cross-era Era Shift mode.
- Advanced booster systems.
