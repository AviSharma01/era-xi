# M4 Stage B — PASS for committing

Durable persistence and deadline/alarm/retention lifecycle are implemented and verified. Everything remains uncommitted and unpushed. No deployment or Cloudflare resources were created; Stages C–E remain deferred.

The final audit found unchecked scheduling hints could become retention authority. That HOLD is now resolved by canonical replay on every durable scheduling commit and immediately before destructive expiry. The latest verification and latency impact are in [the authority-fix report](hint-authority-report.md); the original measurements below are preserved as the pre-fix baseline.

## Files changed

Existing files modified:

- `docs/DRAFT_OFF_ARCHITECTURE.md`
- `src/draftOffRoomRepository.ts`
- `src/draftOffRoomService.ts`
- `src/draftOffRoomService.test.ts`

New files:

- `src/draftOffRoomLifecycle.ts`
- `backend/cloudflare/README.md`
- `backend/cloudflare/catalog.ts`
- `backend/cloudflare/clock.ts`
- `backend/cloudflare/repository.ts`
- `backend/cloudflare/room.ts`
- `backend/cloudflare/worker.ts`
- `backend/stage-b/.gitignore`
- `backend/stage-b/README.md`
- `backend/stage-b/correctness.test.mjs`
- `backend/stage-b/harness.ts`
- `backend/stage-b/package.json`
- `backend/stage-b/performance.mjs`
- `backend/stage-b/prepare.mjs`
- `backend/stage-b/runtime.mjs`
- `backend/stage-b/tsconfig.json`
- `backend/stage-b/results/performance.json`
- `backend/stage-b/results/performance.md`
- `backend/stage-b/results/startup-incident.json`
- `backend/stage-b/results/verification.json`
- `backend/stage-b/results/report.md`

Generated bundles/fixtures are ignored. Test SQLite directories are temporary. Stage A source, retained baseline reports, catalog/index implementations, game data, ratings, and balance constants remain unchanged.

## Implementation

One SQLite-backed Durable Object per named room runs the existing M3 service. Atomic transactions persist canonical M2 save bytes, durable M3 receipts, the room descriptor, derived lifecycle metadata, and the native alarm. M3 supplies a small optional storage scheduling hint from validated state; older repository implementations still work. The hint is not a new save format and changes no command/result semantics. Every durable commit now restores the exact canonical bytes, including calls with hints. Only matching immutable data-only hints are reused; inconsistent hints are replaced. Every service read/transaction, including exact retries, retains canonical restoration/replay validation. Warm reconciliation and destructive expiry restore canonical phase/timing again within the cleanup transaction, and repair advisory wake/alarm metadata before any deletion.

The production clock uses wall time; native alarms deliver registered M3 callbacks or resume M3 after eviction. M3 remains the sole deadline finalizer and receipt authority. Cold and warm overdue access recover through M3. Early/repeated deliveries are harmless. The final pre-deadline submission resolves through the normal atomic M3 transition and replaces the deadline alarm with retention.

Lobby expiry is creation + 24h; completed expiry is completion + 7d. Expiry atomically removes private state, all receipts, descriptor, and lifecycle wake, retaining only a minimal retired marker until expiry + 30d. Neither late delivery nor repeated access extends those anchors. Native alarms and cold access remove overdue markers; named room recreation is refused during the marker interval. There is no global room-code allocator.

The production entry point and room HTTP handler return 404. Fixture actors, imports, inspection, epoch offsets, corruption, and fault injection exist solely in a separately bundled loopback harness. No enrollment/reconnect authentication, public product API, realtime, rate limiting, UI, or deployment work is included.

## Verification

- Root suite: **279/279 PASS** (all 278 existing tests plus one storage-hint test).
- Native Stage A suite unchanged: **6/6 PASS** against freshly rebuilt shared M3 code.
- Native Stage B suite: **19/19 PASS**, including 18 distinct lifecycle scenarios and the enclosing test.
- Root, Stage A, and Stage B typechecks: **PASS**.
- All 80 fixture SHA-256 hashes match the committed indexed milestone: **PASS**.
- `git diff --check`: **PASS**.

Stage B scenarios cover production bundle isolation; create/persist/evict/restore; all-era exact receipts; transaction and receipt-only rollback; atomic START deadline/alarm; participant concurrency; corrupt-save read/retry rejection; early/repeated/native warm/cold alarms with zero browser clients; failed deadline commit recovery; warm/cold overdue recovery; final pre-deadline submission; early resolution; post-resolution alarms; restart with the same SQLite state; fixed retention anchors; expiry on access; autonomous expiry and marker purge; bounded late-expiry markers; and retired-code reuse after purge.

## Performance

The [small matched check](performance.md) retains every raw sample in [performance.json](performance.json). It reuses the unchanged indexed Stage A fixtures, envelopes, dependencies, and HTTP helper; only the Stage B persistence/lifecycle adapter differs. No expensive Stage A matrix was rerun. All original responsiveness gates passed.

| Operation | Stage A p95/max (ms) | Stage B p95/max (ms) |
| --- | ---: | ---: |
| Warm SPIN | 83.1 / 83.1 | 105.6 / 105.6 |
| Warm LOCK | 153.6 / 153.6 | 82.9 / 82.9 |
| Cold SPIN | 192.6 / 192.6 | 159.3 / 159.3 |
| Final submission | 181.4 / 181.4 | 178.8 / 178.8 |
| Cold overdue recovery | 337.9 / 337.9 | 263.8 / 263.8 |
| Modern eight-player SPIN burst | 622.1 / 622.5 | 572.1 / 572.3 |
| Modern eight-player LOCK burst | 647.1 / 647.2 | 630.7 / 630.9 |
| Impact eight-player SPIN burst | 824.1 / 824.5 | 616.9 / 617.3 |
| Impact eight-player LOCK burst | 951.4 / 951.4 | 636.4 / 636.5 |

Eight warm samples, five cold/final/overdue samples, and five eight-player burst trials per era/adapter make this a directional regression check. Warm SPIN's observed maximum is higher in Stage B's small paired run, but remains well inside the original gate; no multi-second latency returned. Percentiles for fewer than twenty observations equal the sample maximum. Burst client responses share each room queue. Stage B does not instrument restore phase counts; absent counts are omitted, not reported as zero.

## Concerns and deviations

The only M3 boundary extension is the optional validated scheduling hint required to atomically persist START and its alarm without replaying again or interpreting gameplay history in Cloudflare code. Canonical saves, receipts, projections, rules, simulations, and index behavior remain unchanged.

Native test runs required loopback/workerd sandbox permission. Two comparison startup attempts failed before any measurement because Stage A was started outside its normal module root; matching each unchanged harness's package cwd resolved it. [The startup diagnostic](startup-incident.json) is retained. No measured sample was retried or discarded.

Local workerd results do not establish deployed Cloudflare latency, Internet RTT, CPU/memory quota headroom, or multi-room throughput. Guest credentials and global code allocation remain future work. Retention intentionally ends room receipt/retry guarantees at expiry.

**PASS for committing Stage B.** No commit or push performed; stop at this boundary.
