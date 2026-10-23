# M5.4 recovery and reliability

Scope: the approved M5.4 request and existing M4/M5 contracts. No route, save, game rule, authority, authentication scheme or canonical fixture changes are planned. A browser refresh reconstructs the authenticated session; ephemeral player selection is intentionally discarded, while an already-sent command retains its exact journal.

## Failure/recovery matrix

| Area | Evidence / regression lane | Required outcome |
| --- | --- | --- |
| Enrollment loss, interrupted credential writes, stale success/rejection, missing storage | Stage C HTTP/client tests; root enrollment tests | Persist original key/input before sending; no replacement identity; stale replies cannot overwrite newer recovery |
| Lost/duplicated committed command, timeout/stalled body, 503, disposal | Root client tests; native M5 client/recovery tests | Exact ID, payload and expected revision survive; one authoritative mutation; obsolete session cannot publish or clean storage |
| Repeated stale HTTP / out-of-order socket and command revisions | Stage D client tests | Publication never regresses; immediate reconciliation is bounded; existing fallback eventually converges |
| Multiple tabs with one credential, simultaneous private commands | Native M5 recovery tests | Participant-local revision rejects one conflicting intent; retry does not duplicate accepted work; both tabs converge |
| Credential removal/replacement, access failure, late results | Root session/results tests; room DOM tests | Clear private snapshot/cache, abort requests, prevent further old-credential actions; preserve journal and unrelated credentials |
| Lobby, drafting, pending placement, submission/waiting, results refresh | Native M5 client/gameplay/results tests | Recover identity and authoritative state; replay only an unresolved exact journal |
| 429 seconds/date/default/extended cooldown, temporary 503 | Root transport/results and Stage D client tests | Shared maximum deadline gates all request types; retry resumes; 503 preserves command intent |
| Disconnect, replacement, silent socket, missed updates | Stage D client/native tests; native M5 gameplay tests | HTTP convergence; fresh single-use tickets; no replacement reconnect loop or private broadcast |
| Hibernation/eviction, rollback, process restart, canonical result restoration | Stage B–D and native M5 results/recovery tests | Exact receipts and canonical bytes survive; no partial commit; results remain authorized and consistent |
| Deadline boundary, local zero, late receipts, complete/incomplete XIs | Room DOM, service, Stage B and native M5 gameplay/recovery tests | Server alone submits/resolves; correct exclusion and CONTESTED/UNCONTESTED/NO_CONTEST; old receipt cannot restore active drafting |
| Production isolation and V1 preservation | Native production-route tests; backend gate; release gate | Test controls unavailable from production bundle; 80 fixtures unchanged; existing V1 routes/build/gameplay pass |

## Reproduced defects and changes

1. **Unbounded stale-response reconciliation.** A newer socket/command revision followed by repeatedly older GETs caused an immediate request storm. The deterministic regression bounded the failing implementation with a sentinel after twelve reads and failed its two-read limit. A reconciliation flight now makes at most two immediate reads, preserving the publication floor and yielding to the existing fallback. No timer, poll loop or authority was added.
2. **Obsolete private session state.** Authentication failure retained `myDraft`; removing/replacing the persisted credential left an old session usable. Failing regressions covered 401 plus removed, replaced and unreadable credential storage. The session now checks credential ownership before requests/private publication and the browser invokes the same check on storage/focus events. Invalidation aborts requests and clears private snapshots/results, preserving journals and replacement credentials. A published final public leaderboard remains visible on 401, as in M5.3. Reentrant disposal cannot rearm a deadline timer or publish a subsequent public callback.
3. **Interrupted journal cleanup.** If removal deleted a journal and then threw, every retry was blocked by its missing record. The regression failed before the change. A memory-only verified-receipt flag now permits the same exact envelope to complete cleanup with an already absent slot. The normal exact retry still obtains a verified receipt and fresh GET. A different stored record remains protected. No persisted format or uncertain-command recovery contract changed.

No backend/domain defect or contract change was demonstrated. Existing canonical recovery, submission/deadline rules, results authorization, enrollment recovery and shared rate limiting were retained.

## Added regression evidence

- Root tests: authentication/private-state loss; removed/replaced/unreadable credential storage; cleanup interrupted after deletion; refusal to delete a foreign journal; 503 then stalled-body timeout then exact retry; cached plus in-flight results invalidation; removal of the private workspace/placement dialog. Existing tests continue to cover enrollment races, selection/session races and extended shared cooldowns.
- Stage D deterministic client tests: repeated stale HTTP replies yield after two reads and subsequently converge through the existing fallback; disposal during snapshot validation leaves no deadline timer, public callback or ticket request.
- `backend/m5-recovery.test.mjs`, registered in the existing native/CI lane: two independent sessions sharing one credential race on the same draft revision. A successful SPIN is duplicated over real production HTTP with an identical receipt, its first response body stalls until timeout, and the other tab receives STALE_DRAFT_REVISION. After a full process restart the saved envelope replays byte-for-byte, returning the original receipt and one authoritative draft mutation. Another test holds a pre-deadline SPIN receipt until NO_CONTEST resolution; delivery cannot restore drafting, and restart preserves the resolution.

Native tests use the existing production Worker entrypoint and SQLite/workerd. The second native test uses the existing separate loopback harness solely to advance the deadline. The production test verifies fixture-control routes still return 404. Accelerated synthetic sessions receive isolated permissive test-only ticket/request budgets, including pending tickets for deliberately unavailable sockets. Production limits and test harness implementations are unchanged.

## Validation

Validated on 2026-10-24 (Asia/Kolkata), Node 24.22.0:

| Gate | Result |
| --- | --- |
| Focused root client/results/room suites | 41 passed |
| Stage D deterministic realtime client suite | 19 passed |
| New native recovery suite | 2 passed |
| `npm run verify:release` | PASS: 334 root tests, production web build, route/data/hash/MIME smoke, five-era complete-game validation with all correctness counters zero |
| `npm run verify:backend` | PASS: root and A–D builds/typechecks; 113 A–E/native tests, including all 10 native M5 tests |
| Canonical fixtures | All 80 match the original committed hashes |
| `git diff --check`; new native test syntax | PASS |

Nine root, two Stage D and two native regressions were added. Existing correctness evidence under the historical Stage A–E results directories is unchanged; fresh gate logs are local scratch artifacts at `/private/tmp/draft-off-m54-release.log` and `/private/tmp/draft-off-m54-backend.log`. The first sandboxed gate attempts could not bind loopback servers; the permitted local-server reruns passed. The web build retains its existing large-chunk advisory; no new runtime/build error occurred.

## Acceptance

**PASS for M5.4 review.** Demonstrated client defects have regressions and focused fixes. The matrix covers uncertain commands/identity, revision isolation, shared cooldowns, privacy/access loss, realtime fallback/replacement, canonical restart and all terminal outcomes through the existing domain and native lanes. Backend contracts, production limits, canonical saves/data, deterministic simulation and V1 behavior are preserved. No outstanding local correctness failure remains; the M6 limits below are unchanged deployment/browser validation boundaries.

Significant implementation files: `src/draftOffSession.ts`, `src/draftOffRealtimeClient.ts`, `src/draftOffApp.tsx`. Regressions extend the existing root and Stage D suites and add `backend/m5-recovery.test.mjs` to `package.json`'s native verification lane. The M5 contract and architecture documentation describe the client guarantees without changing the wire contract.

Proposed commit: `fix(draft-off): harden session recovery and bounded reconciliation`.

## Limits and M6 risks

This milestone uses deterministic client/domain/DOM tests and real local workerd HTTP/WebSocket/persistence tests. It does not add an interactive browser walkthrough, independent browser-engine/device validation, or deployed Cloudflare evidence. Independent native sessions/storage model tab races; real storage-event delivery and browser suspension/throttling remain M6 checks. Ephemeral unsent player selection intentionally resets on refresh; a persisted command intent retains its exact envelope.

Losing the browser profile/credential still has no name-based recovery. If storage becomes unreadable, the old session fails closed and asks for reload after storage is restored. Replaced socket tabs continue HTTP fallback. Missed notifications have no durable outbox; existing fallback reconciles them. Cold resolved-room restoration still replays the entire competition. Internet latency, deployed CPU/quota headroom, mobile suspension, external devices and production observability remain M6/deployment risks.

No M5.5 comparison, redesign, new gameplay/authentication/infrastructure, staging or deployment work was performed. No commit, push or merge is part of this handoff.
