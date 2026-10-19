# M4 Stage E — PASS; ready to begin M5

Verified 18 October 2026 against committed A–D base `17086e0`. Stage E adds verification and handoff documentation only. No backend/domain/gameplay implementation, architecture, dependencies, historical data, balance, UI or deployment configuration changed. No deployment, remote resources, commit or push.

## Final gates

| Gate, freshly run | Result |
| --- | --- |
| `npm run verify:release` | PASS: 281/281 root tests, production build, route/catalog/MIME/notices smoke, 25-game all-era validation |
| `npm run validate:era-draft:full` | PASS: 5,000 completed games, 1,000 per era; all correctness counters zero |
| Root + Stage A/B/C/D typechecks | PASS, all five |
| Stage A native correctness | 6/6 PASS; no expensive benchmark matrix |
| Stage B lifecycle + canonical hint authority | 29/29 PASS |
| Stage C HTTP/auth/enrollment/client/privacy/limits | 24/24 PASS |
| Stage D realtime + client reconciliation | 19/19 PASS |
| New Stage E combined flow + production smoke | 2/2 PASS |
| Canonical fixture SHA-256 comparison | 80/80 identical to committed indexed Stage A baseline |
| Stage E JavaScript syntax + diff whitespace | PASS |

Runtime: Node 24.22.0, pinned Miniflare 5.20261001.0-alpha / workerd 1.20261001.1, compatibility date 2026-10-01, local SQLite Durable Objects. Production backend bundle: 11,501,543 raw bytes / 628,548 gzip bytes; these are artifact observations, not deployed plan/quota approval. The existing Vite large-chunk advisory remains non-blocking; no web code changed.

The first release attempt passed tests/build but its preview server was blocked by sandbox loopback permissions. The entire gate then passed with local process/socket permission. This was an environment restriction, not a product failure. A first combined-flow rehearsal passed while full validation was running; the final two Stage E checks and retained latency samples ran sequentially after full validation completed, without concurrent build/test workloads. All final checks passed without product fixes. Current Stage C smoke output is copied into Stage E; committed A–D evidence remains byte-for-byte unchanged.

## End-to-end results

The three-entrant Impact flow uses real CREATE/JOIN/commands/GET HTTP and ticket-authenticated WebSocket upgrades, with no imported canonical saves or trusted actor shortcuts. Concurrent duplicate enrollment requests return exactly one identity per key. START fixes a server-derived ten-minute deadline. Independent drafts succeed from the same private revision despite changing global revision; two commands racing one participant produce one success and one stale rejection. An ID reused by another participant conflicts without exposing the original actor's receipt. A host-only respin leaves another entrant's draft unchanged.

Concurrent drafting continues through forced DO hibernation/re-instantiation (new instance ID, same three sockets/attachments), a dropped socket/fresh-ticket reconnect, and a full runtime restart over the same SQLite directory. Drafts, original START/SPIN receipts and exact CREATE/JOIN recovery survive. One entrant manually submits; a complete second XI auto-submits at the native deadline; the third incomplete XI is ineligible. Following another hibernation, the native alarm resolves without a product GET/command and all surviving sockets receive identical final CONTESTED snapshots with two leaderboard entries. Repeated alarms, historical receipts and GET do not resolve again or broadcast again; exactly one deadline receipt persists.

The separate **production-bundle** flow has eight entrants complete all 11 picks concurrently and manually submit. It yields eight leaderboard entries with `ALL_SUBMITTED`, identical public frames and no private-progress broadcasts. Fixture routes return 404. This also verifies the non-deadline resolution path at room capacity.

Stage B behavior remains intact: 24h lobby anchor, completion +7d expiry, expiry +30d retired marker; canonical replay remains scheduling authority. In the combined flow, expiry closes sockets and deletes all private state, credentials, enrollment recovery, tickets and receipts. Only the anchored minimal marker remains, and an enrollment retry cannot extend it. Broader early/late/absent-client/rollback/corruption/marker-purge cases pass in the unchanged Stage B–D suites.

## Representative latency

| Final local sample | n | p95 / max ms |
| --- | ---: | ---: |
| Eight-player late SPIN responses | 16 | 1214.29 / 1214.29 |
| Eight-player late LOCK responses | 16 | 1280.49 / 1280.49 |
| Eight-player SPIN batch drain | 2 | 1214.69 / 1214.69 |
| Eight-player LOCK batch drain | 2 | 1280.88 / 1280.88 |
| Final eighth submission/resolution | 1 | 383.20 / 383.20 |
| Three-player persisted-restart snapshot | 1 | 94.06 / 94.06 |
| Native deadline to public snapshot timestamp | 1 | 105 / 105 |

Original burst/final responsiveness limits (2s p95 / 3s max) pass. This is a small directional smoke with declared permissive local rate overrides. Eight response samples share each room queue; they are not independent trials. Deadline timing uses the fixture clock and server snapshot time; it is not Internet delivery latency. No Stage A benchmark matrix was repeated. [Combined raw numeric samples](multiplayer-smoke.json), [production samples](production-smoke.json), [Stage C rerun smoke](stage-c-http-smoke.json).

## Security/privacy findings

No blocker found in local application boundaries. Fresh regressions cover origins, wrong-room/invalid/expired auth, actor/seed/time spoofing, declared/streamed byte limits, safe errors, atomic rollback, storage corruption, rate/admission bounds and production isolation. HTTP exposes only public state plus the authenticated caller's safe draft; even the host cannot read another XI. WebSockets validate a recursive public whitelist and never expose drafts, candidates, picks, submissions, canonical saves, hashes, seeds, receipts or auth records. Private progress/old receipts emit no broadcast. New combined checks scan 123 application events across both runtime instances against the strict metadata allowlist and secret/name/identity/seed sentinels; no leak found. Existing C/D negative/error/socket cases also pass.

Enrollment-Key recovery, reconnect credentials and socket tickets remain separate: recovery material is client-persisted pending input; reconnect credentials alone authorize room HTTP; ticket verifiers authorize one Origin/room/participant-bound upgrade. Neither Enrollment-Key nor reconnect credential can be used as a socket ticket, and neither recovery key nor ticket can authenticate room GET. Mixed auth is rejected. Ticket replay fails; unconsumed tickets survive restart; durable storage holds verifiers/sealed recovery rather than plaintext credentials/keys. No secrets or private payloads are retained in Stage E evidence.

**External capture is unverified and remains a deployment gate.** The updated adapter documentation and [runbook](../RUNBOOK.md#future-staging-deployment-gates) explicitly require redaction or disabled capture for Authorization, Enrollment-Key, Sec-WebSocket-Protocol ticket values, ticket-response bodies, enrollment credential responses, and private payloads at every enabled observability/proxy/client layer. Application logs allow only requestId, route template, status, safe code and elapsedMs. No external account observability setting was inspected or changed; local PASS does not authorize staging/public launch.

## Handoff and outstanding configuration

[M5_CONTRACT.md](../M5_CONTRACT.md) records exact routes/headers/bodies, command revisions and retry guarantees, enrollment-storage recovery, socket construction/message fields, synchronization/close behavior, default bounds/errors and retention. M5 should reuse `enrollGuest` and `createDraftOffRealtimeClient`, keep private HTTP/public socket callbacks separate, call `observeCommand` after commands and GET to reconcile historical receipts. Existing completion output is public standings plus the caller's safe draft; richer XI/reveal/campaign results are outside this stable contract.

Before a separately authorized staging deployment: choose API/frontend origins and routes/account/environment; create the SQLite `ROOMS` binding/class migration; assign CREATE_RATE/ENROLLMENT_RATE/REQUEST_RATE namespace IDs and matching 60s thresholds; set ALLOWED_ORIGINS and any STAGE_C_LIMITS consistently; review packaging/runtime/plan limits; configure and verify all redaction/capture settings; wire the Node >=22 backend gate into the chosen release process. Current root CI only runs the solo release gate on Node 20. None of these resources/configurations was created.

**M4 completion: PASS. Blockers before beginning M5 against this contract: none.** Deployment configuration, deployed latency/quotas and external observability evidence remain requirements before staging/launch, not local UI implementation blockers. Work remains uncommitted and unpushed.

## Files changed

- Updated `backend/cloudflare/README.md` and `docs/DRAFT_OFF_ARCHITECTURE.md` to link the handoff and state complete redaction requirements.
- Added `backend/stage-e/package.json`, `verification.test.mjs`, `M5_CONTRACT.md`, `RUNBOOK.md`.
- Added `backend/stage-e/results/report.md`, `verification.json`, `multiplayer-smoke.json`, `production-smoke.json`, `stage-c-http-smoke.json`.
