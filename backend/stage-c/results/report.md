# M4 Stage C — verified, uncommitted

Guest enrollment, room-scoped reconnect credentials and the strict HTTP API are implemented locally. No Stage D/realtime, React UI, account system, D1/directory, deployment, remote resource, commit or push was performed.

## Result

- CREATE/JOIN generate immutable participant IDs and independent secure random reconnect credentials. Only validated verifiers produce existing-participant M3 actors.
- CREATE routes a 12-character digest-derived invite code directly to one named DO. Full digests distinguish collisions; only explicit collision permits a fresh Enrollment-Key.
- Enrollment recovery persists verifier plus AES-GCM ciphertext, not plaintext credentials or Enrollment-Keys. Exact retries recover the same identity/credential/result across eviction/restart and never duplicate/rejoin participants.
- The transport helper stores/verifies pending Enrollment-Key material before sending and deletes it only after reconnect-credential storage/readback succeeds. Real HTTP response-loss tests exercise both CREATE and JOIN.
- Four `/api/draft-off/v1` routes expose create, guest join, authenticated snapshot and commands. START uses a persisted server-derived envelope/deadline; lifecycle/private revisions remain M3-owned. All participant state is projected through M3.
- Strict origin, schema/media/byte validation, centralized configurable limits, bounded admission/records and allowlisted logs protect the public boundary. Lifetime counters count successful commits only; rejected command/JOIN records share a bounded FIFO with atomic receipt/mapping eviction, so rejected traffic cannot consume permanent capacity. Native edge thresholds must be configured together with their environment policy during later deployment setup.
- Companion records commit in the existing room-state/receipt/wake/alarm transaction and disappear under unchanged Stage B expiry. There is no independent credential timer or retention extension.

## Verification

| Check | Result |
| --- | --- |
| Root suite (retained earlier evidence) | 280/280 PASS |
| Stage A native suite (retained earlier evidence) | 6/6 PASS |
| Focused M2/M3 competition/persistence/repository/projection/service regressions | 40/40 PASS |
| Stage B native lifecycle + hint-authority suites, unchanged | 29/29 PASS |
| Stage C native HTTP/client/privacy/quota suites | 24/24 PASS |
| Root / Stage B / Stage C typechecks | PASS |
| Original indexed fixture SHA-256 values (retained earlier evidence; no data/fixture changes) | 80/80 unchanged |
| Diff whitespace check | PASS |

The runtime is the existing pinned Miniflare `5.20261001.0-alpha` / workerd `1.20261001.1`, compatibility date `2026-10-01`, SQLite DO storage, Node `22.23.3`. `crypto.subtle.timingSafeEqual` was tested in this runtime: equal buffers return true, unequal buffers return false, unequal lengths throw. Verification does not rely on a JavaScript equality fallback or only a type declaration.

Stage C checks cover concurrent/restarted enrollment recovery, conflicting keys, real lost responses/client storage failure, wrong-room/invalid/expired credentials and uniform errors, actor/timestamp/seed/system spoofing, origin/preflight/schema/media/declared and streamed byte limits, immutable membership/rejoin/start, command fingerprints and JSON field-order normalization, private revisions, atomic rollback, digest collision/recovery corruption, canonical corruption, expiry/privacy, configurable native/room budgets and record ceilings, all five eras, safe logs and production/test isolation.

The quota correction exhausts stale/rejected command and reserved-name JOIN attempts beyond the negative ceiling, refills the limiter, and proves valid REJOIN, START, SPIN/RESPIN/LOCK, SUBMIT and available-slot JOIN across eviction/process restart. Tests inspect bounded mixed negative rows/receipts and verify rollback restores eviction victims. Successful retries remain exact at positive ceilings. Explicit legacy Stage B fixture tests prove CREATE cannot take over the room, JOIN cannot mint credentials, and public GET/commands cannot authenticate, including after eviction/restart. No M1–M3 source or Stage B scheduling/retention change was made.

Rejected-result retry semantics are deliberately narrower: exact replay and conflicting key/ID reservation last only while the shared FIFO retains the result. After eviction a rejected operation may be evaluated again; it never committed an identity or game transition. Successful operations retain exact durable recovery and conflict protection until room expiry. Positive admission ceilings remain configured storage bounds; refillable buckets handle abuse traffic.

The small eight-participant Impact smoke in `http-smoke.json` records only aggregate elapsed time and outcome booleans. It opens concurrent drafts through HTTP, completes a legal XI using only safe projections, submits it and recovers deadline resolution. It is not a deployed Cloudflare performance claim, a multi-room benchmark, or a replacement for the retained Stage A/B gates. No expensive matrix was rerun.

## Scope and implementation notes

Changes are limited to `backend/cloudflare/`, the transport-only `backend/client/` helper, the separate `backend/stage-c/` verification package, and architecture documentation. M1–M3 source/types/projections/persistence, Stage A/B source/tests/evidence, data, game rules, balance constants and catalog/index code remain unchanged. There are no new package dependencies or deployment configuration.

Native tests required loopback/workerd sandbox permission. Development checks caught and corrected two integration issues: mixed-case base64 participant IDs did not satisfy M2's existing locale/byte roster-order agreement, so IDs now use random lowercase hex; a trailing slash in the API origin produced a doubled path separator in the client helper, now fixed by URL resolution. Additional test syntax/initial-private-revision corrections were resolved before the passing final runs. No domain changes were used to accommodate these issues.

Abuse thresholds are defaults in one configurable policy, not permanent product rules. Worker rate bindings remain permissive/per-location. Production still requires explicit origin/rate-binding setup as part of a later, separately authorized deployment. Legacy trusted Stage B fixture rooms receive no public credentials. Browser UI/realtime integration remains deferred.

**Stage C complete for review. Working changes remain uncommitted and unpushed.**
