# Catalog minimum-cost index performance milestone — GO

**GO for M4 Stages B–E under the original local product-performance gates.** This milestone stops here: no B–E implementation or deployment, no memoization, no broader caching, no commit or push.

## Scope and exact behavior

Full and scoped immutable catalogs eagerly derive one canonical minimum-cost index per era. The index stores domestic/canonical counts, private read-only minimum-cost lookup, and frozen UNKNOWN identity rows in the original team-season/candidate scan order. evaluateFutureCompletion checks the first undrafted UNKNOWN, subtracts each distinct drafted canonical ID once, then uses the existing keeper/overseas calculation and sorted keeper iteration. UNKNOWN-only canonical players never receive a domestic/overseas classification. Adapters without an index retain the original ordered scan; adapters that alter candidates must omit or rebuild the index. No feasibility result, picks, room state, or command is cached.

The frozen current count-based implementation and earlier sorting implementation are test-only differential oracles. No M1–M3 command, persistence, receipt, seed, simulation, canonical serialization, or catalog fingerprint contract changed. The optional catalog index is derived runtime data and is never persisted or included in game-input artifacts.

## Complete repeated matrices

Prior count-only primary era: era-modern-pre-impact / era-modern-pre-impact. Indexed primary era: era-modern-pre-impact / era-modern-pre-impact. Each run uses the unchanged five-era smoke ranking and existing expansion rule. Expanded eras: era-foundation, era-impact, era-expansion / era-foundation, era-impact. When eras match, the table is a matched fixture comparison; any era difference must be treated as a worst-workload comparison rather than a causal speedup. Fixture hashes are identical throughout.

| Operation | Count-only run 1 p95 / max (s) | Count-only run 2 p95 / max (s) | Indexed run 1 p95 / max (s) | Indexed run 2 p95 / max (s) |
|---|---:|---:|---:|---:|
| Warm SPIN | 0.291 / 0.299 | 0.296 / 0.391 | 0.077 / 0.084 | 0.081 / 0.097 |
| Warm LOCK | 0.326 / 0.377 | 0.303 / 0.316 | 0.092 / 0.120 | 0.100 / 0.128 |
| Cold SPIN | 0.551 / 0.558 | 0.533 / 0.534 | 0.200 / 0.214 | 0.194 / 0.198 |
| Queued SPIN | 2.306 / 2.333 | 2.206 / 2.297 | 0.628 / 0.631 | 0.641 / 0.671 |
| Queued LOCK | 2.486 / 2.539 | 2.299 / 2.443 | 0.679 / 0.707 | 0.685 / 0.696 |
| Final submission | 0.510 / 0.581 | 0.393 / 0.401 | 0.186 / 0.202 | 0.187 / 0.188 |
| Overdue cold recovery | 0.780 / 0.829 | 0.681 / 0.683 | 0.300 / 0.372 | 0.275 / 0.275 |

Warm commands: 30 samples per row; object-cold/overdue: 20 each; queued bursts: 20 trials, eight independently connected clients, 160 responses per action. Process-cold: five full workerd restarts per matrix. Both complete runs are retained; no samples are dropped, no retries, no concurrent builds/tests/profiling during measurement. Cold percentiles are directional, with underlying samples/maxima below.

## Matched Impact bursts

Two additional independent fresh-runtime runs each execute 20 late-draft eight-player SPIN/LOCK burst pairs using the unchanged Stage A runtime, fixtures, transport and command envelopes. The supplemental driver pins only the requested era; original harness files remain unchanged.

| Impact burst | Original Stage A p95 / max (s) | Count-only expanded run 1 p95 / max (s) | Count-only expanded run 2 p95 / max (s) | Indexed matched run 1 p95 / max (s) | Indexed matched run 2 p95 / max (s) |
|---|---:|---:|---:|---:|---:|
| spin | 38.861 / 39.160 | 2.219 / 2.219 | 2.162 / 2.163 | 0.648 / 0.668 | 0.625 / 0.636 |
| lock | 49.556 / 50.228 | 2.452 / 2.452 | 2.327 / 2.327 | 0.688 / 0.815 | 0.669 / 0.670 |

Original Stage A: 160 client responses per action; count-only expanded: 40 per action/run; indexed dedicated matched: 160 per action/run. Participant responses share each trial’s room queue; 160 responses are not 160 independent room trials. All requests must succeed; failures would be preserved and invalidate completion.

## Original gates and repeat consistency

Original report.mjs completeness assertions and performance expressions were executed unchanged against both full matrices. Matched Impact applies the exact original burst gate, without relaxing thresholds.

| Gate | Indexed full run 1 | Indexed full run 2 |
|---|---|---|
| warmSnapshot | PASS | PASS |
| warmCommands | PASS | PASS |
| cold | PASS | PASS |
| bursts | PASS | PASS |
| final | PASS | PASS |
| deadlineResolution | PASS | PASS |

Matched Impact burst gate: PASS / PASS. Overall decision: **GO**. Warm p95/max ≤0.5/1 s; cold ≤1.5/3 s; burst/final/deadline-to-handler completion ≤2/3 s. Provider CPU limits are not gates.

| Operation | Indexed p95 range (s) | Largest max across both full runs (s) |
|---|---:|---:|
| Warm SPIN | 0.077–0.081 | 0.097 |
| Warm LOCK | 0.092–0.100 | 0.128 |
| Cold SPIN | 0.194–0.200 | 0.214 |
| Queued SPIN | 0.628–0.641 | 0.671 |
| Queued LOCK | 0.679–0.685 | 0.707 |
| Final submission | 0.186–0.187 | 0.202 |
| Overdue cold recovery | 0.275–0.300 | 0.372 |

## Updated profiling and attribution

A separate unchanged Impact inspector diagnostic measured 127.0 ms / 75 samples. evaluateFutureCompletion self samples are 24.8 ms (19.6% sampled elapsed), versus count-only 206.3 ms (58.4%). Attribution comes from the complete raw profile, including functions outside the diagnostic’s top-20 list. Short profiles are directional; absence of samples does not prove zero CPU cost.

| Current function | Self sampled ms |
|---|---:|
| (idle) | 39.4 |
| evaluateFutureCompletion | 24.8 |
| load | 18.9 |
| (garbage collector) | 6.3 |
| evaluateSelectionLegality | 5.5 |
| freeze | 5.0 |
| (anonymous) | 4.3 |
| assertEraDraftState | 3.8 |
| canonicalSha256 | 2.9 |
| canonicalValue | 2.5 |
| process | 2.5 |
| update | 1.3 |

| Command, indexed full run 2 | Mean restore (ms) | Reduce (ms) | Storage read (ms) | Storage write (ms) | Serialize (ms) |
|---|---:|---:|---:|---:|---:|
| spin | 46.9 | 0.3 | 14.2 | 0.3 | 1.5 |
| lock | 51.6 | 0.3 | 16.4 | 0.4 | 1.5 |
| final-submit | 109.3 | 33.5 | 16.3 | 0.3 | 7.9 |

RestoreMs overlaps nested storage/resume timings; do not add it to those phases. Heap observations are available in diagnostic.json and are not peak-memory/quota/headroom proofs.

The requested local responsiveness gate is met consistently, including matched Impact queues. No further optimization is required for this milestone. Remaining replay validation/storage/serialization costs are retained; no memoization or broader optimization is proposed or implemented here. Worker → one Durable Object per room → M3 → M2 → M1 remains unchanged.

## Underlying cold and deadline samples

### Full run 1

Started 2026-10-06T09:44:25.513Z, completed 2026-10-06T09:47:27.721Z UTC.

- primary/8/late/cold-spin, HTTP ms: 167.6, 165.6, 173.7, 162.2, 158.6, 162.1, 189.1, 165.1, 166.2, 165.4, 169.6, 164.1, 173.1, 200.1, 162.9, 169.6, 167.0, 213.9, 168.7, 166.9.
- primary/8/late/cold-snapshot, HTTP ms: 123.6, 122.5, 138.8, 120.9, 141.9, 120.3, 123.9, 122.2, 123.6, 123.7, 120.8, 120.6, 127.4, 130.5, 128.2, 121.9, 121.8, 122.6, 121.8, 121.5.
- primary/8/resolved/cold-snapshot, HTTP ms: 284.9, 299.3, 356.4, 285.8, 294.0, 355.6, 289.1, 303.6, 282.0, 281.2, 294.2, 282.3, 278.5, 335.5, 334.1, 304.9, 333.0, 291.0, 284.2, 311.7.
- primary/8/late/process-cold-snapshot, HTTP ms: 157.9, 160.1, 175.6, 159.4, 159.1.
- primary/8/deadline/overdue-cold, HTTP ms: 260.5, 261.5, 263.7, 262.4, 300.3, 262.9, 275.6, 261.4, 255.2, 254.0, 254.6, 275.4, 255.7, 261.9, 266.2, 372.4, 259.2, 257.9, 270.1, 253.6.
- Process startup separately, ms: 111.1, 76.8, 77.8, 81.3, 74.7.
- Deadline-to-handler completion ms, 20 native alarms alternating cold/warm: 229, 167, 209, 173, 200, 167, 195, 169, 183, 167, 188, 167, 193, 175, 209, 171, 205, 177, 195, 174.
- Native alarm delivery delay ms: 7, 2, 2, 3, 3, 2, 3, 2, 2, 2, 3, 1, 2, 2, 3, 1, 2, 2, 2, 2.

### Full run 2

Started 2026-10-06T09:52:38.299Z, completed 2026-10-06T09:55:32.201Z UTC.

- primary/8/late/cold-spin, HTTP ms: 170.3, 168.2, 165.8, 177.8, 176.7, 168.2, 167.7, 194.0, 168.2, 170.6, 168.7, 168.4, 170.7, 169.8, 192.9, 170.6, 197.8, 170.6, 163.8, 171.3.
- primary/8/late/cold-snapshot, HTTP ms: 132.3, 128.3, 172.1, 130.5, 127.2, 125.7, 123.2, 126.3, 123.1, 127.8, 125.5, 149.0, 135.2, 124.7, 122.7, 125.3, 127.3, 127.1, 128.0, 129.3.
- primary/8/resolved/cold-snapshot, HTTP ms: 290.5, 289.7, 320.3, 295.2, 283.9, 287.9, 284.4, 287.0, 290.7, 287.6, 295.2, 288.6, 282.3, 292.8, 289.6, 290.1, 292.4, 312.5, 292.8, 294.4.
- primary/8/late/process-cold-snapshot, HTTP ms: 163.4, 161.5, 177.8, 158.5, 159.5.
- primary/8/deadline/overdue-cold, HTTP ms: 252.9, 252.0, 253.4, 254.1, 270.9, 254.8, 254.1, 256.6, 274.6, 252.1, 253.6, 256.6, 274.9, 270.6, 254.0, 260.8, 272.9, 256.0, 254.1, 257.4.
- Process startup separately, ms: 131.0, 78.3, 74.2, 79.1, 74.1.
- Deadline-to-handler completion ms, 20 native alarms alternating cold/warm: 218, 170, 195, 168, 196, 166, 206, 168, 192, 169, 187, 167, 188, 169, 189, 167, 207, 167, 189, 169.
- Native alarm delivery delay ms: 5, 3, 3, 3, 3, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 2, 4, 3, 4, 3.

## Verification and limits

- 18 focused legality/feasibility/scoped-catalog tests passed: all five eras, first/interior/last player-season variants, partial/near-complete/completed/oversized XIs, keeper-needed/satisfied, overseas boundaries, 16,224 synthetic combination checks against both frozen implementations, UNKNOWN scan order/drafted exclusions, all-UNKNOWN exclusion, duplicate and cross-era picks, immutable index/results, and no candidate rescans on indexed calls.
- Full existing release pipeline: 278 tests passed; production web build and route/artifact/MIME smoke passed; Era Draft smoke validation passed. Root and Stage A typechecks passed.
- Six unchanged native Stage A tests passed: all-era restoration/retries, participant races, atomic rollback, cold/process recovery, exactly-once deadline recovery and repeated alarms.
- All 80 fixture SHA-256 hashes match across the original, count-only, and indexed versions, including canonical bytes, seed-derived simulation outcomes and receipts. Original harness source hashes match.
- Raw complete matrices, all per-client burst samples, matched Impact runs, profile, gate expressions/results and check logs are retained. All runtimes are disposed after each run; no benchmark is left running.

Environment: Apple M5, 10 cores, 24 GiB, darwin/arm64, OS 25.5.0, Node v22.22.2. Same pinned local Miniflare/workerd and compatibility date as Stage A. These are native local loopback measurements, not deployed Cloudflare hardware, Internet RTT or multi-room contention measurements. Twenty cold trials/five process starts give directional percentiles only. Original results and prior milestone results remain preserved.
