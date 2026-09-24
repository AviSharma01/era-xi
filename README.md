# IPL Draft Simulator

A historical IPL drafting game inspired by EraBall. Spin a franchise-season, choose one player, lock them into a batting position, and build a complete XI under roster constraints.

## Current Status

- 2016 Classic Mode prototype
- Historical player-season data from Cricsheet
- Position locking, overseas limit, wicketkeeper validation, respin, and franchise cooldown
- Production-buildable web interface and Classic CLI
- Era Draft supports all five eras through draft, reveal, deterministic persistence/replay, and complete league/playoff/champion simulation
- Every era has a curated `REPRESENTATIVE HISTORICAL SEASON XI` opponent pool; pools larger than eight are deterministically shortlisted to eight before Simulation V2 selects seven opponents
- Foundation Stage 8 opponent and simulation behavior remains compatibility-frozen
- Browser catalogs are content-addressed and verified before play; accepted games autosave locally without changing deterministic replay

## Run Locally

```bash
npm ci
npm run dev:web
```

The web app serves Era Draft at `/` and `/era-draft`, with Classic 2016 at
`/classic`. Create the deployable static bundle with `npm run build:web`; the
output is `dist-web/`.

## Era Draft Validation

```bash
npm run validate:era-draft:smoke  # 25 complete games
npm run validate:era-draft        # 500 complete games
npm run validate:era-draft:full   # 5,000 complete games
```

Run the complete release gate with:

```bash
npm run verify:release
```

This checks TypeScript tests, committed web artifacts, the production bundle,
its HTTP routes and data hashes, and a 25-game all-era smoke validation. See
[docs/RELEASE.md](docs/RELEASE.md) for the full host-neutral release checklist.

The CLI also accepts `--seed`, `--count`, `--mode smoke|standard|full`,
`--deterministic-only`, and `--output <path>`. The deterministic report excludes
wall-clock timing; performance metrics are emitted only in the regular report.

## Data Attribution

Historical match data and player identifiers are sourced from Cricsheet. See
[DATA_ATTRIBUTION.md](DATA_ATTRIBUTION.md) for provenance, licensing, and
redistribution notes.
