# IPL Draft Simulator

A historical IPL drafting game inspired by EraBall. Spin a franchise-season, choose one player, lock them into a batting position, and build a complete XI under roster constraints.

## Current Status

- 2016 Classic Mode prototype
- Historical player-season data from Cricsheet
- Position locking, overseas limit, wicketkeeper validation, respin, and franchise cooldown
- CLI and localhost web interface
- Ratings, tiers, reveal, and simulation planned

## Run Locally

```bash
npm install
npm run dev:web
```

## Data Attribution

Historical match data and player identifiers are sourced from Cricsheet. See
[DATA_ATTRIBUTION.md](DATA_ATTRIBUTION.md) for provenance, licensing, and
redistribution notes.
