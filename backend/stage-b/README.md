# M4 Stage B local verification

Uses the existing Stage A dependencies and exact generated catalogs/fixtures. No new dependency, backend deployment, or Cloudflare resource is needed.

From the repository root:

```sh
npm run build
node backend/stage-a/prepare.mjs
node backend/stage-b/prepare.mjs
npm run typecheck --prefix backend/stage-b
npm run test --prefix backend/stage-b
npm run performance --prefix backend/stage-b
```

The Stage A package must already have its pinned dependencies installed. The Stage B build emits separate production and test Worker bundles. Generated bundles are ignored; test SQLite directories are created under the system temporary directory. Native tests need permission to bind loopback sockets and spawn workerd when running inside a sandbox.

The test entry point requires `STAGE_B_ONLY=local-workerd-fixtures-only`, limits requests to loopback, and uses `p0`–`p7` fixture actors. Epoch offsets, fixture import/inspection, transaction failure injection, and deliberate corruption are integration controls only. The production bundle does not import this module and has no HTTP product API. The harness retains a test clock key through marker tests; production retirement stores only the marker.

The performance script starts each adapter from its normal package directory because pinned Miniflare V5 derives module names relative to cwd. It runs two sequential small matched checks with unchanged indexed Stage A fixtures, envelopes, and separate HTTP connections: eight warm SPIN/LOCK samples, five cold SPIN/final-submission/overdue samples, and five eight-participant SPIN/LOCK bursts in each of Modern Pre-Impact and Impact. No build, test, profile, or other measurement runs concurrently. It retains all raw samples, checks the original responsiveness gates, and compares all 80 fixture hashes to the committed indexed milestone. This is a regression check, not the expensive full matrix or a production Cloudflare performance claim.

Retained evidence is in `results/`. The initial outside-root module startup failures are recorded separately from measured operations. No response payloads, canonical room saves, private fixture state, or credentials are retained in measurement results.

The scheduling-authority follow-up is covered by `hint-authority.test.mjs` in the normal test command. It injects missing/stale/wrong-phase/wrong-time hints at creation and commit, corrupts stored wakes on warm/cold/restart paths, verifies canonical state before direct destructive cleanup, checks atomic repair rollback, and observes native overdue resolution with no participant requests. A matching immutable data-only hint may be reused only after strict canonical replay.

Because the follow-up adds replay work, reproduce its small latency check with `npm run performance --prefix backend/stage-b -- --hint-authority` from the repository root. The separate `hint-authority-performance.json` / `.md` outputs preserve the earlier Stage B measurements.
