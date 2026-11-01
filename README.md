# Era XI

A historical IPL drafting and simulation game inspired by EraBall. Build your XI from real player-seasons, balance your team under roster constraints, and see how it performs against historical opposition.

## Game Modes

### Era XI (Solo)

Draft across five IPL eras, from 2008 through 2026.

- Spin historical franchise-seasons and select players for your XI.
- Build an 11-player team with position, overseas, and wicketkeeper constraints.
- Reveal player ratings and team evaluation.
- Simulate a league campaign, progress through the playoffs, and compete for the title.
- Resume saved games locally, with deterministic simulation and replay.

### Draft-Off

A timed challenge mode for friends.

Create a room, share an invite link, and independently draft an XI within a shared 10–15-minute countdown. Each completed team then plays the same number of simulated matches against common historical opposition.

Compare results on a shared leaderboard using points and net run rate. Participants compete through their season performances rather than playing direct head-to-head matches.

Draft-Off runs against its own server, so builds include it only when explicitly enabled; see [Run Locally](#run-locally).

## Legacy Route: Classic 2016

The original season-specific drafting experience is kept at `/classic` for compatibility. It is not a game mode and is not linked from the home page.

## Run Locally

```bash
npm ci
npm run dev:web
```

Era XI (Solo) is available at `/` and `/era-draft`, with the legacy Classic 2016 route at `/classic`.

To run Draft-Off locally, prepare the local runtime once with `npm run verify:backend`, then use two terminals:

```bash
npm run dev:draft-off
```

```bash
VITE_DRAFT_OFF_ENABLED=true VITE_DRAFT_OFF_API_ORIGIN=http://127.0.0.1:8787 npm run dev:web -- --port 5173 --strictPort
```

See the [local runbook](backend/stage-e/RUNBOOK.md) for details.

To build the production web application:

```bash
npm run build:web
```

The static output is generated in `dist-web/`.

## Validation

Run the complete V1 release gate:

```bash
npm run verify:release
```

For additional simulation validation:

```bash
npm run validate:era-draft:smoke
npm run validate:era-draft
npm run validate:era-draft:full
```

See [Release Documentation](docs/RELEASE.md) for validation details and deployment requirements.

## Data & Attribution

Historical match data and player identifiers are sourced from [Cricsheet](https://cricsheet.org/).

See [DATA_ATTRIBUTION.md](DATA_ATTRIBUTION.md) for provenance, licensing, and redistribution information.
