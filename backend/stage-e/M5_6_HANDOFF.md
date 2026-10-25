# M5.6 — Final local acceptance and M6 handoff

Recommendation: **PASS for M5 completion and review**, subject to the separately authorized M6 staging gates below. No local functional/security blocker was identified. No product implementation, frozen contract, gameplay, authentication, simulation, data or infrastructure change was required. No commit, push, merge, deployment or external playtesting was performed.

Scope: `feat/draft-off-ui`, reviewed baseline `cd0135e` (M5.5). Executed 2026-10-25, Node 24.22.0, local Chrome 156.0.8078.47. This accepts the M5.1–M5.5 experience locally; it does not certify production deployment or physical devices.

## Requirements matrix

PASS means verified within the named local lane. Browser means actual Chrome and a built frontend against the production Worker/SQLite/HTTP/WebSockets. DOM means simulated DOM tests; native means workerd with SQLite and real transport. Only the separate fixture harness exposes accelerated clocks/eviction/failure controls.

| Requirement | Status | Executed evidence |
| --- | --- | --- |
| Create, code-only invite sharing/copy, join, identity on reload | PASS | Two browser journeys use UI enrollment and clipboard; lobby/drafting/results reload. Native M5.1 and Stage C cover response loss, exact enrollment and restart. |
| Host/member authority, fixed era/duration, leave/rejoin | PASS | Browser host-only START/disabled single-player START, member leave/rejoin, no settings selectors after creation. New production matrix rejects member START and verifies stored era/duration/shared deadline; Stage C rejects extra fields/spoofing. |
| Two- and eight-entrant competitions; five eras and both durations | PASS | Combined matrix below, existing production eight-player HTTP/WebSocket full drafts, plus two isolated browser contexts per walkthrough. Eight simultaneous browser contexts were not run. |
| Independent legal drafts, one respin, fixed positions, complete XI and submit | PASS | 44 UI picks, four respins and four confirmed submissions across two browser rooms; native matrix deliberately selects opposite legal player/position strategies. Existing engine/legality/respin/room tests cover duplicates, overseas, keeper, unavailable positions and illegal/repeated commands. |
| Shared deadline, auto-submit, incomplete exclusion, all terminal outcomes | PASS | Native M5 gameplay/recovery, Stage B/D/E and domain boundary tests: legal complete auto-submit, incomplete exclusion, CONTESTED/UNCONTESTED/NO_CONTEST, autonomous native alarms, delayed receipt after resolution. Browser clocks checked in drafting, inspection, pending placement, confirmation and waiting; no ten/fifteen-minute wall-clock wait. |
| Accurate ranks, points, NRR and exact ties | PASS | Matrix cross-checks wins/losses/points and NRR formula against campaign aggregates and leaderboard. M1 canonical tests independently validate aggregation/fixtures and exact tied ranks; room/results DOM tests preserve ties. Browser reads/rendered values match production results. Exact ties/Super Overs are deterministic canonical/DOM checks, not forced browser outcomes. |
| Authenticated XI, evaluation and campaign browsing | PASS | Native M5 results checks readiness, Origin/auth, locked/incomplete/LEFT viewer scope, foreign/ineligible targets, expiry, safe errors and cold replay. Browser inspects players, assessment and campaign after resolution and reload. |
| Distinct two-XI comparison and aligned fixtures | PASS | Opposite strategies produce distinct submitted XIs and campaigns in all five matrix cases. Browser verifies 11 paired positions, evaluations/aggregates/ranks and all 20 ordered fixture outcomes before/after swap. Canonical/DOM tests independently validate participant identity, third-entry selection, recurring opponents and mismatch fail-closed behavior. |
| Refresh, lost responses, exact retry and concurrent tabs/commands | PASS | Native M5 client/gameplay/recovery + Stage C/E; real persisted restart and identical receipts, one accepted mutation, private-revision conflicts. Browser reload plus held authoritative lock replies exercises real pending feedback. |
| Session/credential replacement and private-state removal | PASS | Browser second-tab storage removal clears displayed comparison/access. Root session/results tests cover replacement, removal, unreadable storage, in-flight/cached results and access failure. New journal ownership regressions below. |
| WebSocket loss, replacement, hibernation, restart, stale replies | PASS | Stage D/E native sockets/forced hibernation/process restart; M5 native HTTP-only fallback; deterministic realtime monotonic/bounded reconciliation tests. No claim of OS/browser suspension testing. |
| Shared cooldowns and request limits | PASS | Root shared transport/results cooldown tests; Stage C/D native default/exhausted buckets, edge bindings, refill, pre-replay rejection and socket/ticket bounds. Accelerated full-draft/browser runs override budgets explicitly and are not default-rate or deployed-load tests. |
| No private picks/ratings before resolution; results limited to locked entrants | PASS | Stage C/D/E public HTTP/frame allowlists and private-drafting/no-broadcast tests; native M5 result authorization. Existing room/realtime/receipt payloads remain unchanged. No spectator result route or production fixture controls. |
| Desktop/mobile interaction, focus, reduced motion and reflow | PASS | Real Chrome: 1440×1000, 390×844 touch, 320×640 touch, 720×500 reflow; keyboard Enter/Tab/Shift+Tab/Escape/Space, native dialog focus/restoration, fixture disclosures, sticky selected identity/clock/confirmation, all 11 placement rows unobstructed, long names and no horizontal overflow. Selected screenshots visually inspected. |
| App console errors/unexpected failed requests | PASS | Both browser journeys assert none. The confirmed optional `/favicon.ico` 404 is recorded separately as a cosmetic deferral, not suppressed as an app error. Expected navigation-cancelled requests are excluded. |
| V1 routes, saves, gameplay, reveal and simulation | PASS | Release gate's Classic/Era Draft, persistence/replay, reveal, league/playoff/final-outcome and five-era complete-game tests; built `/`, `/classic`, `/era-draft` smoke; browser solo-era entry smoke. A fresh full solo game was not manually drafted in Chrome. |
| Frozen M1–M4 contracts, catalog and 80 fixture hashes | PASS | Complete backend gate, root canonical/projection/replay suites and release deterministic catalog rebuild/hash checks; tracked data, fixtures and historical evidence have no diff. |
| Production isolation, release hygiene and CI suitability | PASS | Existing production bundle/route-isolation tests; root/backend builds/typechecks, diff check and scoped file review. New tests live in existing CI lanes; optional browser module is not a CI dependency. |
| Deployed runtime/CPU/quota/HTTPS/WSS/observability/alarms | NOT VERIFIED | M6; no resources provisioned or external settings audited. |
| Physical devices, other browser engines, real networks, assistive technology, native zoom/suspension | NOT VERIFIED | Explicit M6/device boundaries. Touch/reflow emulation and keyboard checks do not establish these. |

## Complete journeys and gates executed

The new matrix extends `backend/m5-gameplay.test.mjs` through its existing production fixture/session helpers, with actual HTTP/WebSockets and temporary SQLite state. Each case completes and submits every XI, converges on one leaderboard, loads every entrant's own authenticated result, verifies legal construction and distinct opposite-strategy campaigns, and aligns all fixtures. It is a combined matrix, not an exhaustive era × duration × player-count product.

| Era | Minutes | Entrants | Lane |
| --- | ---: | ---: | --- |
| Foundation | 10 | 2 and 8 | Existing production M5 gameplay journeys |
| Foundation | 15 | 2 | New production acceptance matrix |
| Expansion | 10 | 2 | New production acceptance matrix |
| Transition | 15 | 2 | New production acceptance matrix |
| Modern Pre-Impact | 10 | 2 | New production acceptance matrix |
| Impact | 15 | 8 | New production acceptance matrix |
| Transition | 10 | 2 | Real desktop/mobile browser journey |
| Impact | 15 | 2 | Real desktop/mobile browser journey |

Native journeys additionally execute lost enrollment/command replies, exact journal recovery through refresh and process restart, conflicting same-credential sessions, frozen submission/waiting reload, HTTP fallback without sockets, deadline auto-submit/incomplete/no-contest, locked-roster results access, eight distinct result projections, eviction/restart/expiry and no fixture routes in production. Stage E adds concurrent eight-player production HTTP/WebSocket drafting and hibernating native deadline resolution. Existing canonical tie/Super Over fixtures are reused; no seed search, score injection, fixture regeneration change or historical benchmark sweep was added.

Each real-browser journey uses two separate Playwright contexts, UI create/join and code-only invite copy, fixed settings, member leave/rejoin, lobby reload, host START, opposite candidate/position strategies, one respin each, drafting reload, held lock responses, all 22 UI picks, confirmation/submitted waiting, final results and two-XI comparison. It exercises inspection, section navigation, fixture disclosure, swap/cache reuse, authenticated reload, second-tab storage invalidation and solo entry. Backend deadline edges and restart use native fixtures; they are not represented as browser tests.

| Gate | Final result |
| --- | --- |
| `npm run verify:release` | PASS: 345 root tests, production build, route/catalog hash/MIME/notices smoke, five-era full-cycle smoke; correctness counters zero |
| `npm run verify:backend` | PASS: 118 A–E/native tests, including 15 M5 tests; all 80 canonical fixture hashes unchanged |
| Relevant builds/typechecks | PASS: root build/typecheck and A–D builds/typechecks in backend gate; browser builds also use production Vite output with explicit API origin |
| Targeted journal suite | PASS: 27 tests, including both new P3 regressions |
| Real-browser Transition/10 and Impact/15 | PASS: two complete independent-context journeys; Chrome 156.0.8078.47 |
| `node --check` on edited native/browser scripts; `git diff --check` | PASS |

Stage E retains observe-mode directional latency reporting and unchanged controlled 2s/3s budgets. It ran without concurrent browser/build workloads during its final timing lane. Both final Stage E reports had zero timing violations. The eight-entry production smoke measured spin/lock p95 at 1,259/1,315 ms and final submission at 497 ms. Native eight-entry results reads measured warm median 155 ms, cold median 404 ms and restart 449 ms, with a largest response of 21,881 bytes. These small local samples do not establish deployed performance. No broad 5,000-game/benchmark/historical-data validation was repeated.

## Findings and scoped changes

No product defect requiring a gameplay, UI, backend or contract fix was demonstrated.

- Added the five-case production matrix and distinct strategy/campaign checks using existing M5 test infrastructure.
- Added the two previously suggested P3 regressions: a verified-receipt cleanup exception cannot carry into the next uncertain command; a journal replaced while an exact retry is in flight survives its delayed successful receipt, without publishing that receipt's stale view or sending another retry. Existing implementation passes both.
- Extended the existing browser script with actual UI enrollment/invite/leave/rejoin, respins, active-draft reload, era/duration parameters and explicit console/request checks. Bounded clipboard verification and failure screenshots aid diagnostics. No new framework/dependency was introduced.
- Initial sandboxed gates failed to bind loopback and were rerun with execution permission. The first matrix attempt used exact START duration equality and failed on an observed 1 ms difference: HTTP derives the deadline immediately before the domain timestamps START. The assertion now matches Stage E's established <1s tolerance and also requires identical entrant deadlines; product timing is unchanged. The initial browser enrollment locator was corrected to use the select's role/name.
- Browser console inspection exposed the pre-existing optional favicon 404. It has no gameplay/accessibility effect and is deferred to the design pass, recorded explicitly in browser evidence. All other app errors/unexpected failed requests remain failures. The existing large Classic build chunk advisory is unchanged.
- Updated current runbook/contract acceptance links and corrected obsolete M5.2-only results guidance. Earlier M5 handoffs remain historical evidence.

## V1, contracts, hygiene and CI

No source implementation, package/lockfile, workflow, catalog, schema, simulation constant, save format or raw/processed data was changed. Root tests preserve Classic and all-era solo persistence, deterministic replay, reveal and full season outcomes; the backend gate preserves M1–M4 native persistence/HTTP/WebSocket behavior and all 80 frozen fixture hashes. The current contract already includes the approved M5.3 results addition; M5.6 changes no transport semantics.

Both GitHub jobs remain suitable: independent V1 Node 20 release lane and backend Node 24.22.0 lane, sequential native suites, observe-mode timing with sanitized artifact allowlist. The two root regressions and five native cases run automatically through existing commands, adding no dependency or hosted-browser requirement. Hosted CI was inspected, not dispatched in this milestone. Browser acceptance remains an explicit local prerequisite; CI does not claim real-browser coverage.

Temporary backend state was disposed and removed by the harnesses. Only the six intended text files listed below are proposed for commit; no credentials, profiles, generated databases/catalogs, logs, screenshots, build output or local artifacts are included. Historical Stage A–E reports/baselines were retained.

## M6 prerequisites and operational risks

Local blockers: **none identified**. Nonblocking local observations are the optional favicon and existing bundle-size advisory. Full resolved-room replay and the serialized room queue remain technical performance risks to measure on the chosen platform; local warm/cold results evidence does not establish CPU limits or quota headroom. Lost browser-profile credentials have no name/account recovery by design; missed socket updates rely on authenticated HTTP fallback.

Before separately authorized staging, follow [all runbook deployment gates](RUNBOOK.md#future-staging-deployment-gates): select isolated account/environment/routes and exact frontend/API HTTPS origins; package only `backend/cloudflare/worker.ts` with verified catalogs; preserve compatibility date/runtime identifiers; bind `ROOMS` to SQLite `DraftOffRoom` with the initial class migration; provision native rate bindings consistent with policy; configure frontend API origin and WSS; keep server catalogs/source maps/test controls/private state out of public assets and caching. No staging identifiers, namespace or migration were invented here.

Audit effective logging/proxy/analytics/session-replay capture and execute enrollment/ticket/error/reconnect canaries to establish redaction of credentials, keys, ticket protocols and private payloads. Repeat deployed two/eight-player create-to-results journeys, results authorization/privacy, retry/reconnect and default-limit behavior; measure cold eight-entry replay, concurrent responsiveness, Worker CPU/memory/bundle limits and quotas. Verify native deadline/expiry/cleanup while browsers are closed and after restart with unchanged 24h lobby / 7d completed / 30d marker anchors, without exposing fixture-clock APIs. Validate physical mobile devices, additional engines, native zoom/assistive technology, network loss and suspension. Keep staging/production namespaces separate and preserve compatible state on rollback; do not delete a namespace as routine rollback.

## Evidence, changed files and review handoff

Final local logs (scratch, not committed):

- `/private/tmp/draft-off-m56-release-final.log`
- `/private/tmp/draft-off-m56-backend-final.log`
- `/private/tmp/draft-off-m56-focused.log`
- `/private/tmp/draft-off-m56-transition-browser-r4.log`
- `/private/tmp/draft-off-m56-impact-browser.log`

Browser `summary.json` and adjacent screenshots are under `/private/tmp/draft-off-m56-transition-browser-evidence-r4/` and `/private/tmp/draft-off-m56-impact-browser-evidence/`. Earlier attempts remain separate, as do all M5.5 evidence directories. Visual spot review included narrow pending placement, desktop comparison and mobile expanded fixtures. The runbook gives repeatable commands; use fresh output paths. No private SQLite state or credentials are retained in these reports.

Changed files:

1. `backend/m5-gameplay.test.mjs` — combined production acceptance matrix and opposite drafting strategies.
2. `src/draftOffClient.test.ts` — verified-receipt reset and mid-retry replacement regressions.
3. `scripts/draft_off_m55_browser_validation.mjs` — extended existing real-browser acceptance.
4. `backend/stage-e/M5_CONTRACT.md` — acceptance boundary/link; no wire change.
5. `backend/stage-e/RUNBOOK.md` — current behavior, repeatable browser checks and M6 prerequisites.
6. `backend/stage-e/M5_6_HANDOFF.md` — this acceptance report.

Proposed commit: `test(draft-off): complete M5 local acceptance and handoff`

Stop at M5.6 for review. M6 provisioning/deployment and broader design work require their separate planned phase.
