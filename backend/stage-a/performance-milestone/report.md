# Focused legality performance milestone — HOLD

Only evaluateFutureCompletion was optimized: canonical minimum costs are still discovered by the original ordered variant scan; a domestic count replaces repeated binary-cost sorting. Keeper ordering, UNKNOWN errors, fields, freezes, and overseas accounting remain unchanged. No caching, indexing, M1–M3 protocol/persistence change, simulation change, deployment, commit, or push.

## Measurements and comparison

The original baseline used **era-impact**. Both complete optimized runs automatically selected **era-modern-pre-impact**, with Impact included in the existing near-equal-era expansion. These main-table rows compare the baseline workload with the newly selected worst fixture; they are **not matched-era causal speedups**. All five eras passed the unchanged smoke/correctness checks in both runs. Both complete runs are retained; no faster run was selected or samples dropped.

| Operation | Baseline Impact p95 / max (s) | Optimized Modern run 1 p95 / max (s) | Optimized Modern run 2 p95 / max (s) |
|---|---:|---:|---:|
| Warm SPIN | 4.893 / 4.928 | 0.291 / 0.299 | 0.296 / 0.391 |
| Warm LOCK | 5.371 / 5.543 | 0.326 / 0.377 | 0.303 / 0.316 |
| Cold SPIN | 9.762 / 9.825 | 0.551 / 0.558 | 0.533 / 0.534 |
| Final submission | 5.041 / 5.085 | 0.510 / 0.581 | 0.393 / 0.401 |
| Eight-player queued SPIN | 38.861 / 39.160 | 2.306 / 2.333 | 2.206 / 2.297 |
| Eight-player queued LOCK | 49.556 / 50.228 | 2.486 / 2.539 | 2.299 / 2.443 |
| Overdue cold recovery | 10.276 / 10.586 | 0.780 / 0.829 | 0.681 / 0.683 |

Warm rows have 30 samples, cold rows 20, bursts 20 trials / 160 client responses per action. Process-cold has five samples. Cold p95 is directional; underlying samples/maxima follow.

### Matched Impact comparison

The unchanged harness performs five expanded Impact burst/final trials per optimized run, and one Impact smoke SPIN. It does not perform a full Impact cold-SPIN/overdue matrix after selecting Modern. **A full matched-era comparison for those two operations is therefore unavailable**, rather than inferred from Modern data.

| Impact operation | Baseline p95 / max (s) | Optimized run 1 p95 / max (s) | Optimized run 2 p95 / max (s) | Optimized sample count per run |
|---|---:|---:|---:|---:|
| Queued SPIN | 38.861 / 39.160 | 2.219 / 2.219 | 2.162 / 2.163 | 40 |
| Queued LOCK | 49.556 / 50.228 | 2.452 / 2.452 | 2.327 / 2.327 | 40 |
| Final submission | 5.041 / 5.085 | 0.440 / 0.440 | 0.397 / 0.397 | 5 |

Impact smoke SPIN (one sample each): baseline 5.140 s; optimized 0.261 / 0.262 s. These single samples have no meaningful p95.

## Original responsiveness gates

Original report.mjs completeness assertions and gate expressions were executed unchanged against both complete runs; harness file hashes are verified.

| Gate | Run 1 | Run 2 |
|---|---|---|
| warmSnapshot | PASS | PASS |
| warmCommands | PASS | PASS |
| cold | PASS | PASS |
| bursts | FAIL | FAIL |
| final | PASS | PASS |
| deadlineResolution | PASS | PASS |

Budgets: warm p95/max 0.5/1 s; cold 1.5/3 s; per-client burst, final submission, and deadline-to-handler completion 2/3 s. A provider CPU quota was not substituted for a product gate. Timed drafting still exceeds the burst responsiveness budget.

## Profiling and remaining bottleneck

The separate unchanged Impact inspector diagnostic measured 353 ms / 259 samples. evaluateFutureCompletion self samples: 206 ms (58.4% sampled elapsed), versus 3716 ms / 79.7% before. The shorter optimized profile has less attribution precision; this is a diagnostic, not an independent latency distribution or CPU-quota measurement.

Top optimized self samples:

| Function | Self sampled ms |
|---|---:|
| evaluateFutureCompletion | 206.3 |
| (idle) | 36.9 |
| assertEraDraftState | 22.7 |
| load | 16.2 |
| (program) | 12.6 |
| (garbage collector) | 11.3 |
| freeze | 6.3 |
| process | 6.3 |
| evaluateSelectionLegality | 5.9 |
| (anonymous) | 4.6 |
| canonicalValue | 3.8 |
| update | 3.8 |

| Command, run 2 | Mean restore (ms) | Reduce (ms) | Storage read (ms) | Storage write (ms) | Serialize (ms) |
|---|---:|---:|---:|---:|---:|
| spin | 235.4 | 0.9 | 14.3 | 0.4 | 1.5 |
| lock | 244.8 | 1.4 | 15.2 | 0.5 | 1.4 |
| final-submit | 318.8 | 32.9 | 16.3 | 0.4 | 8.0 |

The original variant scan and per-call canonical-cost Map construction remain in the shared feasibility path, and repeated replay work queues inside one room. The next smallest proposal is a catalog-derived canonical minimum-cost index used by this helper, with explicit equivalence coverage preserving drafted-player exclusion and the original first UNKNOWN error in scan order. It must not weaken restore validation or cache command results. **This proposal requires review and is not implemented.** No memoization or broader optimization was added.

## Underlying cold and deadline samples

### Run 1

Started 2026-10-06T09:05:52.971Z; completed 2026-10-06T09:12:34.369Z UTC.

- primary/8/late/cold-spin, HTTP ms: 538.4, 524.0, 520.9, 523.9, 525.8, 524.3, 530.3, 525.5, 527.3, 524.0, 530.2, 527.2, 530.4, 530.0, 529.9, 527.2, 518.3, 550.7, 539.9, 558.0.
- primary/8/late/cold-snapshot, HTTP ms: 394.7, 395.5, 390.9, 388.3, 391.2, 391.0, 392.8, 437.3, 418.2, 421.9, 419.8, 406.9, 423.7, 430.5, 424.7, 478.6, 431.3, 418.6, 407.6, 416.6.
- primary/8/resolved/cold-snapshot, HTTP ms: 590.4, 636.5, 612.1, 605.0, 651.2, 631.2, 697.5, 627.0, 617.1, 603.0, 636.5, 639.1, 625.4, 621.3, 636.5, 615.9, 650.6, 643.3, 638.9, 621.2.
- primary/8/late/process-cold-snapshot, HTTP ms: 451.2, 451.6, 448.6, 450.6, 460.5.
- primary/8/deadline/overdue-cold, HTTP ms: 724.4, 779.5, 709.1, 774.2, 704.4, 751.3, 662.4, 680.0, 673.5, 829.1, 731.9, 727.4, 740.1, 775.5, 668.4, 697.9, 654.9, 735.9, 686.2, 713.5.
- Deadline-to-handler completion ms (20 native alarms, alternating cold/warm): 524, 400, 519, 393, 522, 402, 524, 396, 516, 410, 498, 433, 491, 382, 512, 357, 523, 399, 552, 399.
- Alarm delivery delay ms: 8, 2, 5, 1, 4, 3, 4, 1, 4, 3, 3, 3, 3, 3, 3, 3, 4, 2, 3, 2.

### Run 2

Started 2026-10-06T09:18:30.124Z; completed 2026-10-06T09:25:04.086Z UTC.

- primary/8/late/cold-spin, HTTP ms: 528.6, 525.7, 528.9, 530.9, 528.6, 533.7, 528.8, 530.7, 529.5, 530.3, 533.3, 532.9, 528.6, 530.8, 530.0, 532.3, 527.8, 522.7, 523.9, 522.7.
- primary/8/late/cold-snapshot, HTTP ms: 393.7, 389.1, 394.4, 389.6, 386.9, 395.3, 393.1, 398.1, 395.3, 389.8, 393.7, 395.2, 394.5, 442.5, 394.4, 395.8, 393.5, 394.8, 394.0, 393.4.
- primary/8/resolved/cold-snapshot, HTTP ms: 630.4, 589.8, 597.4, 600.0, 591.9, 600.8, 597.2, 601.7, 601.5, 599.6, 597.0, 598.9, 594.9, 599.3, 601.6, 603.2, 602.0, 599.4, 598.4, 600.1.
- primary/8/late/process-cold-snapshot, HTTP ms: 457.9, 451.2, 465.7, 449.7, 453.2.
- primary/8/deadline/overdue-cold, HTTP ms: 680.5, 678.8, 683.4, 673.5, 671.7, 671.7, 672.5, 666.5, 674.6, 667.5, 676.1, 666.5, 672.4, 676.8, 673.3, 673.8, 660.5, 665.1, 676.3, 676.1.
- Deadline-to-handler completion ms (20 native alarms, alternating cold/warm): 527, 401, 520, 396, 538, 405, 519, 409, 520, 399, 584, 404, 530, 396, 522, 403, 533, 405, 523, 404.
- Alarm delivery delay ms: 8, 2, 4, 3, 5, 3, 5, 2, 5, 2, 3, 2, 3, 2, 3, 2, 4, 2, 5, 2.

## Verification and boundaries

- Focused legality/equivalence: 14 passed. Frozen sorting implementation serves as a test-only oracle; five real eras, first/interior/last variants, partial/near-complete/completed/oversized XIs, keeper-needed/satisfied, overseas 0/1/3/4/5, more than 16,000 synthetic domestic/overseas/keeper/variant combinations, ordered fail-closed errors, and immutable fields.
- Full existing release pipeline: 276 tests passed; production web build and route/artifact/MIME smoke passed; Era Draft smoke validation passed. Root typecheck passed.
- Native Stage A correctness: six tests passed; Stage A typecheck passed.
- All 80 pre/post generated fixture SHA-256 hashes match, including canonical bytes and receipt payloads. Harness hashes match. Runtime exact retries, cold restores, transactions/rollback, native alarms, and exactly-once deadline recovery retain their checks.
- No optimized benchmark transport failures, retries, or omitted failed attempts were recorded. Original baseline transport incident remains part of the preserved baseline evidence.

Local Apple M5/workerd loopback measurements do not predict deployed Cloudflare hardware, Internet RTT, or multi-room load. Twenty cold samples and small expanded-era sets provide directional percentiles only. The original baseline results remain in ../results/; optimized complete raw matrices, profile, gates, and check logs are in this directory. Changes remain uncommitted and unpushed. **HOLD for M4 Stages B–E; stop after this milestone.**
