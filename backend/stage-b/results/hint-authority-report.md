# Stage B scheduling authority fix — PASS

The audit HOLD is resolved. Canonical restored M2 state is the sole source of scheduling phase and timing. No Stage C work was started; all changes remain uncommitted and unpushed.

## Exact files changed for this follow-up

- `src/draftOffRoomLifecycle.ts`
- `src/draftOffRoomRepository.ts`
- `src/draftOffRoomService.test.ts`
- `backend/cloudflare/repository.ts`
- `backend/cloudflare/room.ts`
- `backend/cloudflare/README.md`
- `backend/stage-b/harness.ts`
- `backend/stage-b/hint-authority.test.mjs` (new)
- `backend/stage-b/package.json`
- `backend/stage-b/performance.mjs`
- `backend/stage-b/README.md`
- `docs/DRAFT_OFF_ARCHITECTURE.md`
- `backend/stage-b/results/hint-authority-performance.json` (new)
- `backend/stage-b/results/hint-authority-performance.md` (new)
- `backend/stage-b/results/verification.json`
- `backend/stage-b/results/report.md`
- `backend/stage-b/results/hint-authority-report.md` (new)

No M2 canonical persistence/replay code, room-record/receipt format, M1 simulation, catalog/index implementation, game rules, data artifacts, or Stage A sources were changed by this follow-up. The earlier uncommitted Stage B service changes remain as implemented; this fix does not add further service command behavior.

## Canonical authority and hint handling

Each durable commit restores/replays the exact canonical save bytes being committed and checks the room ID. The existing shared lifecycle projector derives the authoritative phase and timestamp from restored M2 state. It reuses a supplied hint only when the hint is immutable, has precisely the expected fields, uses data properties rather than accessors, and matches both phase and timestamp. All other hints are replaced. Hint reuse avoids allocating a new projection object; it never skips replay. Missing hints continue to work.

The adapter's single storage-policy mapping translates the validated projection to deadline, creation + 24h, or completion + 7d. Canonical bytes, receipts, wake metadata, and the native alarm still commit atomically. An incorrect hint cannot publish a later deadline or a premature retention wake.

Warm access and every destructive room expiry transaction now restore canonical state again before making decisions. That same transaction derives and repairs the wake/alarm metadata, then either preserves the room or expires it using canonical phase/time. Corrupt canonical state aborts cleanup. Warm overdue recovery consults only the newly repaired wake and delegates finalization to M3; cold recovery continues to use M3 resume. Gameplay lifecycle and resolution rules remain in M2/M3. Once verified expiry removes canonical data, the minimal marker retains the verified expiry anchor for its bounded 30-day purge.

## Tests and checks

- Native Stage B: **29/29 PASS**, including all 18 existing scenarios plus nine focused hint-authority scenarios (and two enclosing tests).
- Relevant M3 repository/service/projection and canonical persistence regressions: **32/32 PASS**.
- Root, Stage A, and Stage B typechecks: **PASS**.
- `git diff --check`: **PASS**.
- All 80 fixture SHA-256 hashes still match the committed indexed baseline.

Focused cases cover missing, stale lobby, wrong phase, early/late deadline, missing/extra fields, wrong lobby/completed retention anchors, warm reconciliation, cold eviction and process restart, direct premature-expiry prevention, corruption blocking cleanup, repair rollback, canonical expiry despite a later/wrong-kind wake, autonomous warm/cold native deadline resolution, and already-overdue native resolution with no participant request. The shared projector's regression also verifies mutable/NaN/accessor-bearing hints cannot be reused or executed.

## Latency impact

Strict replay on scheduling commits and warm cleanup checks adds work. The [small matched latency check](hint-authority-performance.md), using the same indexed fixtures and pinned workerd harness, passed every original gate. Earlier Stage B measurements are preserved separately in `performance.json` / `.md`. No expensive full performance matrix was rerun.

| Operation | Pre-fix Stage B p95/max (ms) | Authority-fix check p95/max (ms) |
| --- | ---: | ---: |
| Warm SPIN | 105.6 / 105.6 | 247.0 / 247.0 |
| Warm LOCK | 82.9 / 82.9 | 244.3 / 244.3 |
| Cold SPIN | 159.3 / 159.3 | 421.5 / 421.5 |
| Final submission | 178.8 / 178.8 | 384.0 / 384.0 |
| Cold overdue recovery | 263.8 / 263.8 | 694.4 / 694.4 |
| Modern eight-player SPIN burst | 572.1 / 572.3 | 1200.5 / 1200.7 |
| Modern eight-player LOCK burst | 630.7 / 630.9 | 1193.0 / 1193.5 |
| Impact eight-player SPIN burst | 616.9 / 617.3 | 1735.6 / 1735.8 |
| Impact eight-player LOCK burst | 636.4 / 636.5 | 1257.9 / 1258.0 |

These are separate small local runs, not a precise causal estimate or deployed Cloudflare measurements. Eight warm samples, five cold/final/overdue samples, and five eight-player burst trials per era are directional; percentiles under twenty samples equal the maximum. Burst participant responses share room queues. The fix trades extra replay for enforced canonical authority while remaining within the original responsiveness budgets. No restored-state cache or index optimization was changed. All runtimes were disposed.

**PASS for committing Stage B.** No remaining scheduling-authority blocker found. No commit or push performed.
