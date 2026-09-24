# V1 release checklist

## Supported artifact

`npm run build:web` creates the static production bundle in `dist-web/`. Era Draft is the default route and is also available at `/era-draft`; Classic 2016 is available at `/classic`.

The browser requires HTTPS in production because Era Draft verifies catalog SHA-256 hashes with Web Crypto. V1 supports current evergreen Chrome, Edge, Firefox and Safari releases with JavaScript, Web Crypto and local storage enabled. The game remains playable in the current tab when local storage is unavailable, with an explicit warning.

## Automated gate

Run from a clean checkout with Node 20:

```bash
npm ci
npm run verify:release
```

The gate runs the TypeScript suite, compares committed browser artifacts with a deterministic in-memory rebuild, creates the production bundle, serves that bundle locally, verifies all three application routes and every catalog hash, and completes the 25-game all-era validation.

Offline data-pipeline tests are intentionally separate because several require the exact local Cricsheet archive and regenerated Stage 3/4 corpora described in `docs/DATA_NOTES.md`:

```bash
python3 -m unittest discover -s tests
npm run validate:era-draft:full
```

Neither command should be used to replace committed artifacts during release review. Compare the working tree before and after validation.

## Browser inspection

Before release, inspect `/`, `/era-draft` and `/classic` from the production bundle in a real browser. Cover:

- 320, 375, 768, 1024 and 1440 CSS-pixel widths, plus a short landscape viewport;
- keyboard-only era selection, drafting, dialogs, reveal and season progression;
- visible focus, 200% zoom, reduced motion and screen-reader status announcements;
- unavailable-player reasons, dialog focus return and the mobile confirmation bar;
- refresh/Continue at draft, reveal, league, playoff and complete checkpoints;
- offline Continue followed by a successful retry without discarding the save;
- Classic draft, reveal and season completion;
- the data-attribution and font-license link in both modes.

## Host configuration

Keep hosting configuration provider-specific and out of the repository until a provider is selected. The selected host must:

- serve the site over HTTPS;
- rewrite extensionless application routes to `index.html` while preserving real asset and JSON 404 responses;
- serve JSON with an appropriate content type;
- enable Brotli or gzip compression;
- revalidate `index.html` and `data/era-draft/v1/manifest.json`;
- cache content-hashed JavaScript, CSS and era JSON immutably;
- deploy `dist-web/` atomically and retain the previous bundle for rollback.

Verify direct navigation and refresh for `/`, `/era-draft` and `/classic` under the final root or configured Vite base path.

## Compatibility boundaries

Do not change the Era Draft save envelope, engine/state versions, catalog fingerprint inputs, seed derivation or canonical serialization as release housekeeping. A catalog change may deliberately make an old save incompatible; that requires an explicit product decision and a user-facing migration or invalid-save policy.

Classic 2016 data and consumers, the Foundation compatibility fingerprint and fixture, eligibility, wicketkeeper metadata, country/overseas assertions, ratings and opponent pools remain frozen unless a separately reviewed change requires them.

## Release evidence

Record the commit, Node version, `verify:release` result, full-validation result, browser/viewport matrix and production-bundle size. Confirm the working tree contains no regenerated data or credentials. Publishing, DNS changes and deployment require a separate explicit action after the bundle is reviewed.
