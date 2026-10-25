# Independent M5 pre-merge remediation

2026-10-25 · baseline `cd0135e` on `feat/draft-off-ui` · Node 24.22.0 · Chrome 156.0.8078.47

**PASS for committing the remediation for review.** No commit, push, merge, deployment, dependency installation or infrastructure provisioning was performed. Draft-Off remains disabled by default. Historical M5.2–M5.6 handoff/evidence files remain preserved; the original M5.6 acceptance additions are included in this working tree. This record addresses the later independent audit findings and supersedes its HOLD only for the fixes and local checks listed here.

## Fixed findings

- **P1: stale/concurrent JOIN identity replacement.** Browser enrollment uses Web Locks across pending-key selection, bounded HTTP and verified credential handoff/cleanup. Queued JOINs re-read credentials and pending ownership; an established identity is resumed with no new key/request. Storage/focus events refresh open forms. A conflicting or wrong-room response cannot replace stored identity, remove its exact pending recovery or activate the obsolete attempt. Lost responses retain the original serialized input and Enrollment-Key. Unsupported locking fails closed; there is no unsafe localStorage mutex fallback.
- **P2: outstanding solo Start/Continue crossing navigation.** Route changes synchronously invalidate operation generations, release the old pending UI and record the new route owner. Async publication requires both current generation and route ownership. Leaving and returning cannot revive an obsolete operation or let it clear another generation's pending state. Existing V1 engine, persistence and state formats are unchanged.
- **P2: premature production exposure.** Only exact `VITE_DRAFT_OFF_ENABLED=true` enables navigation and landing/room routing. The default is off in all builds, including when an API origin is configured. Disabled direct routes use the existing not-found screen. The flag is independent of `VITE_DRAFT_OFF_API_ORIGIN`; M6 activation requires a separate reviewed build/deployment decision as documented in the release guide/runbook.

## Deterministic verification

Final focused P3 follow-up: storage/focus adoption of a verified pending enrollment now synchronizes the form operation and room field. Other fields continue to display the exact pending input; events without a relevant pending attempt preserve the selected mode. New CREATE-adoption regressions failed before this fix and now recover without reload on both storage and focus. The inverse regression preserves the landing CREATE form for an unrelated room's pending JOIN and recovers that JOIN on its matching room route. Follow-up checks: **18/18** focused UI/enrollment tests, **34/34** existing root/Stage C client tests, typecheck and diff checks passed. Web Locks, pending keys/input and credential ownership are unchanged. The comprehensive gates and browser runs below were not repeated for this small follow-up.

The new regression suite was run before implementation and reproduced concurrent identity replacement, conflicting credential writes, delayed Start/Continue publication, ungated navigation and stale entry-form behavior. Final focused suite: **15/15 PASS**. It runs automatically in the root `npm test` / V1 CI lane using existing Vite/React/JSDOM dependencies.

Coverage includes concurrent same/different-name JOINs, an existing credential arriving during a response, lost-response exact-key recovery, changed pending ownership, disposed queued owners, wrong-room replies, unreadable existing identity, storage/focus and submit-time stale-form recovery, delayed Start/Continue across navigation away/back, and enabled/default-disabled root/nested builds.

Two older client assertions expected identity replacement; they now assert preservation and recovery. The native CREATE/JOIN response-loss fixture now uses distinct host/member profile stores and explicitly asserts the host credential survives. All server response-loss, receipt, authorization and retry assertions remain.

| Verification | Result |
| --- | --- |
| `npm run test:m5-premerge` | PASS, 15 tests |
| `npm run verify:release` | PASS, 361 tests; default production build; route/hash/MIME/notices smoke; 25 complete all-era games; zero correctness counters |
| `npm run verify:backend` | PASS, 118 A–E/M5 tests; root/A–D builds/typechecks; all 80 canonical fixture hashes unchanged |
| Stage E latency | Observe mode, zero recorded budget violations; no deployed quota/performance claim |
| Script syntax and `git diff --check` | PASS |
| Canonical data, lockfiles and historical result directories | No diff |

The full backend gate initially found the shared host/member storage fixture described above; its focused native regression and the complete gate passed after correcting the fixture. No assertions were removed to bypass a product defect. Browser automation ran after the native gate, avoiding competing workloads during Stage E measurements.

## Real-browser evidence

Executed both scripts with an existing Playwright installation and local Chrome, against temporary production bundles and the production Worker/SQLite/HTTP/WebSocket entrypoint. No fixture controls were enabled in the browser runtime.

- **Release/configuration matrix:** actual production builds with the flag absent or explicitly enabled, each under `/` and `/games/`, with a configured API origin. Disabled builds hide navigation and direct landing/room activation. No activation API requests occur. Classic remains usable in every case.
- **V1 recovery:** delayed Start canceled after Draft-Off navigation and history-back; delayed Continue canceled while on Draft-Off; original save unchanged. New Start, spin and saved Continue still work after visiting Draft-Off, including reload, under both bases.
- **Same-profile tabs:** two pre-opened invitation tabs, sequential and genuinely concurrent submissions with different names. Concurrent evidence observes one held and one queued native browser lock. Each case sends exactly one JOIN, stores one guest identity, survives reload and yields a two-person backend roster (host plus one guest).
- **Full enabled journey:** Transition/10-minute desktop/mobile flow, UI create/join/invite/leave/rejoin, 22 legal picks, one respin each, held responses, active-draft and waiting reload, submission, results, eleven-position/twenty-fixture comparison, swaps, cache reuse, disclosures and credential invalidation. Distinct XIs are compared with authenticated server results. Viewports: 1440×1000, 390×844 touch, 320×640 touch and 720×500; reduced motion.
- Zero page errors in the remediation matrix; zero application console errors or unexpected failed requests in the full journey. The previously recorded optional favicon 404 remains a design deferral. Disabled-route and concurrent-lobby screenshots were visually inspected.

Local evidence (not staged/committed):

- `/private/tmp/m5-premerge-browser-remediation/summary.json` plus screenshots.
- `/private/tmp/m5-full-browser-remediation/summary.json` plus screenshots.
- `/private/tmp/m5-remediation-focused-final.log`
- `/private/tmp/m5-remediation-release.log`
- `/private/tmp/m5-remediation-backend-final.log`
- `/private/tmp/m5-remediation-browser.log`
- `/private/tmp/m5-remediation-full-browser.log`

Browser scripts remove their private temporary SQLite state. Reports/screenshots contain synthetic test participants and safe aggregate assertions; no credentials, raw traces or private persistence artifacts enter the repository.

## Exact proposed commit scope

Proposed message: **Fix M5 enrollment recovery and gate Draft-Off release**

Exactly these 20 files, including the six pre-existing M5.6 acceptance files (marked `M5.6`):

| File | Purpose |
| --- | --- |
| `src/draftOffEnrollmentClient.ts` | Browser lock adapter and conflicting credential/room guards |
| `src/draftOffSession.ts` | Locked enrollment orchestration, credential resume, owner checks |
| `src/draftOffApp.tsx` | Storage/focus refresh and guarded form submission |
| `src/eraDraftApp.tsx` | Solo generation/route ownership and gated navigation |
| `src/webRoutes.ts` | Default-off flag and route gating |
| `backend/dev.mjs` | Explicit local opt-in in printed launcher instructions |
| `src/draftOffClient.test.ts` | Existing client regressions plus M5.6 journal cases (**M5.6**) |
| `src/webRoutes.test.ts` | Exact opt-in, direct routes and base-path regressions |
| `backend/stage-c/client.test.mjs` | Conflicting reply/recovery regression |
| `backend/stage-c/correctness.test.mjs` | Separate-profile native response-loss coverage |
| `backend/m5-gameplay.test.mjs` | Retained five-era/duration acceptance additions (**M5.6**) |
| `scripts/m5_premerge_regressions.test.mjs` | New deterministic UI/build/concurrency suite |
| `scripts/draft_off_premerge_browser_validation.mjs` | New real production-build/browser regression checks |
| `scripts/draft_off_m55_browser_validation.mjs` | Retained M5.6 browser acceptance and explicit temporary opt-in (**M5.6**) |
| `package.json` | Focused command and inclusion in the existing root test gate |
| `docs/RELEASE.md` | Default-off flag and separate M6 activation process |
| `backend/stage-e/M5_CONTRACT.md` | Preserved M5.6 note plus client remediation contract (**M5.6**) |
| `backend/stage-e/RUNBOOK.md` | Preserved M5.6 instructions, flag/locking requirements and repeatable checks (**M5.6**) |
| `backend/stage-e/M5_6_HANDOFF.md` | Previously completed acceptance record, preserved (**M5.6**) |
| `backend/stage-e/M5_PREMERGE_REMEDIATION.md` | This remediation/evidence/scope record |

Exclude all generated bundles, dependency directories, screenshots, logs, SQLite state and historical evidence changes.

## Remaining limits and M6 boundary

No known local blocker remains for committing these fixes. Fresh hosted CI must run against the eventual committed SHA; this uncommitted working tree has no new hosted check run. Real-browser verification here uses Chrome with desktop/mobile emulation, not physical devices or additional browser engines. New enrollment requires Web Locks in a secure context and fails closed otherwise.

External hosting branch triggers/environment variables/rewrites/cache behavior, deployed Cloudflare configuration, actual quotas/CPU/memory, real-network recovery and effective telemetry redaction remain separate M6 gates. Keep public production opt-in absent until those gates and the separate production decision are complete. No gameplay, simulation, canonical data, results authorization, command journal schema, credential wire format or deployment architecture was changed.
