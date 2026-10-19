# Draft-Off M4 Stage A report — HOLD

Completed 2026-10-06T07:13:00.669Z (UTC). Main fixture: **era-impact, eight participants, ten locked picks each**, with distinct deterministic XIs and complete historical receipt ledgers. All product durations remain 10/15 minutes, default 15. Retired-code markers are bounded to 30 days after cleanup; no lifecycle implementation is included in Stage A.

## Decision

**HOLD for Stages B–E.** The Worker/one-Durable-Object architecture remains appropriate, but the unchanged replay path does not meet timed-drafting responsiveness. No deployment or later M4 stage has started. M1–M3 and the root dependency files are unchanged.

Local correctness passes do not override product latency failures. Gate results: warmSnapshot=FAIL, warmCommands=FAIL, cold=FAIL, bursts=FAIL, final=FAIL, deadlineResolution=FAIL.

## Artifact selection and runtime

| Era | Raw bytes | gzip bytes | Profiles | Team-seasons | Opponents | Late snapshot smoke median (s) |
|---|---:|---:|---:|---:|---:|---:|
| era-foundation | 1684668 | 87412 | 451 | 24 | 8 | 0.92 |
| era-expansion | 1942454 | 102209 | 515 | 28 | 11 | 0.85 |
| era-transition | 2105072 | 106215 | 559 | 32 | 10 | 0.82 |
| era-modern-pre-impact | 2724850 | 133754 | 728 | 42 | 10 | 1.67 |
| era-impact | 2763649 | 138305 | 739 | 40 | 10 | 2.32 |

The size leader also had the slowest measured replay. Expanded near-equal eras: none. Each era passed final contested resolution, native object-cold equality, and exact command retry smoke checks. Smoke samples are small and used only for fixture selection.

Machine: Apple M5, 10 cores, 24 GiB RAM, darwin/arm64, OS 25.5.0, Node v22.22.2. Pinned versions: Miniflare 5.20261001.0-alpha / workerd 1.20261001.1 / esbuild 0.28.1; compatibility date 2026-10-01. The alpha Miniflare version is used only by the local harness, not recommended as a production dependency.

Worker bundle: 11454659 bytes raw / 617349 gzip. Only the selected era is parsed and verified per object; the five raw artifact strings are bundled. Late canonical save: 39359 bytes; 168 receipts / 3642333 serialized receipt bytes. No filesystem catalog loader or test-support module enters the bundle.

The run was paused at the user’s request after the warm and cold-snapshot rows, then resumed without repeating completed rows. Resume metadata: 2026-10-06T06:17:54.544Z (User requested pause and later continuation); 2026-10-06T06:49:55.634Z (Resume after recorded local transport failure; client now uses node:http agent:false). New raw samples identify their run segment; hardware, OS, Node, and artifact inventory were checked for equality.

## HTTP latency measurements

Times are seconds, through the loopback Worker → Durable Object → M3 boundary. p95 uses nearest-rank; cold sets are directional, not production-grade confidence.

| Operation | Samples | Median (s) | p95 (s) | Max (s) | Mean restore calls |
|---|---:|---:|---:|---:|---:|
| Late snapshot | 30 | 2.30 | 2.46 | 2.50 | 1.0 |
| spin | 30 | 4.67 | 4.89 | 4.93 | 2.0 |
| respin | 30 | 4.78 | 4.95 | 4.96 | 2.0 |
| lock | 30 | 4.86 | 5.37 | 5.54 | 2.0 |
| submit | 30 | 4.92 | 5.08 | 5.12 | 2.0 |
| final-submit | 30 | 4.94 | 5.04 | 5.09 | 2.0 |
| stale | 30 | 2.34 | 2.44 | 2.53 | 1.0 |
| retry | 30 | 4.61 | 4.88 | 4.98 | 2.0 |
| Cold late snapshot | 20 | 6.93 | 7.06 | 7.57 | 3.0 |
| Cold SPIN | 20 | 9.26 | 9.76 | 9.83 | 4.0 |
| Cold resolved snapshot | 20 | 7.39 | 7.48 | 7.81 | 3.0 |
| Process-cold snapshot | 5 | 7.12 | 7.80 | 7.80 | 3.0 |
| Burst SPIN — all clients | 160 | 37.19 | 38.86 | 39.16 | 2.0 |
| Burst LOCK — all clients | 160 | 43.14 | 49.56 | 50.23 | 2.3 |
| Overdue cold recovery | 20 | 9.87 | 10.28 | 10.59 | 4.0 |
| Post-alarm result read | 20 | 2.55 | 2.68 | 2.79 | 1.0 |

| Room/history | Samples | Median (s) | p95 (s) | Max (s) | Mean restore calls |
|---|---:|---:|---:|---:|---:|
| 2 players / early | 30 | 0.00 | 0.01 | 0.01 | 1.0 |
| 2 players / middle | 30 | 0.13 | 0.15 | 0.16 | 1.0 |
| 2 players / late | 30 | 0.26 | 0.27 | 0.27 | 1.0 |
| 2 players / resolved | 30 | 0.28 | 0.34 | 0.38 | 1.0 |
| 8 players / early | 30 | 0.01 | 0.01 | 0.01 | 1.0 |
| 8 players / middle | 30 | 1.26 | 1.31 | 1.34 | 1.0 |
| 8 players / late | 30 | 2.30 | 2.46 | 2.50 | 1.0 |
| 8 players / resolved | 30 | 2.47 | 2.53 | 2.53 | 1.0 |

## Eight-player queueing and timed drafting

Every one of the 20 trials submits eight independent SPIN requests together, then eight valid LOCK requests together, with each trial starting from the same late fixture. All accepted; no room-revision collision was imposed on independent drafts.

- spin: first-client range 4.48–5.16 s; last-client range 36.38–39.16 s; maximum total drain 39.16 s.
- lock: first-client range 9.26–43.85 s; last-client range 41.97–50.23 s; maximum total drain 50.23 s.

23 measured burst requests included service reconstruction; 20 trials changed object instance between SPIN and LOCK without explicit eviction there. Native instance IDs and resume timings are preserved. These observations reinforce that a warm-only cache would be insufficient; the reason for automatic re-instantiation is not inferred.

The slowest client must await serial authoritative work. This is visible interaction delay, and back-to-back spin/lock bursts consume a meaningful portion of a ten-minute round. Optimistic animations or WebSockets cannot make authoritative selection/legality responses arrive sooner. A command queued near the deadline still receives its execution timestamp under M3, so it can become too late while waiting; that rule remains unchanged.

## HTTP client segments and failed attempt

Both drivers use independent loopback HTTP connections and measure through the full response body. Node built-in HTTP uses agent:false and performs no application retries. They are shown separately because the client implementation changed after a local socket failure.

| Client/action | Successful responses | Median (s) | Directional p95 (s) | Max (s) |
|---|---:|---:|---:|---:|
| fetch/Undici / spin | 96 | 37.77 | 39.16 | 39.16 |
| fetch/Undici / lock | 96 | 43.33 | 50.23 | 50.23 |
| node-http-agent-false / spin | 64 | 37.11 | 37.88 | 37.88 |
| node-http-agent-false / lock | 64 | 42.62 | 43.85 | 43.85 |

One additional partial burst attempt failed with a local socket closing before any response bytes for participant p7. After teardown/restart, all eight SPIN receipts and only LOCK receipts p0–p3 were present; p7 had not committed. Its uncaptured failure duration is excluded from successful-trial percentiles, and the attempt is explicitly retained in transport-incident.json. The cause remains unresolved; this is not evidence of a production Cloudflare failure rate. The client driver was changed, and the remaining trials resumed from clean fixtures. No domain or provider adapter optimization was applied.

## Attribution and resource observations

Warm mean phase timings (ms); service resume is an overlapping aggregate and excluded from this sum.

| Command | Restore/replay | Reduce | Storage read/hydrate | Storage write/alarm | Canonical serialize |
|---|---:|---:|---:|---:|---:|
| spin | 4658 | 9 | 15 | 0 | 2 |
| respin | 4761 | 10 | 16 | 0 | 2 |
| lock | 4861 | 8 | 16 | 0 | 1 |
| submit | 4909 | 1 | 17 | 0 | 2 |
| final-submit | 4880 | 34 | 17 | 1 | 8 |
| stale | 2330 | 4 | 7 | 0 | 0 |
| retry | 4624 | 0 | 14 | 0 | 0 |

A separate inspector diagnostic measured 4663 ms with 3695 CPU samples. evaluateFutureCompletion accounts for approximately 79.7% of sampled elapsed time (3716 ms of self samples). The source rescans all era player variants and, when a keeper is still needed, repeatedly sorts completion costs for each keeper. Replay repeats these checks inside existing invariants and selection validation. Database latency and the new simulation transition are comparatively small.

Inspector live heap observations: 53.9 MiB before / 75.1 MiB after diagnostic SPIN. Allocated heap after: 121.8 MiB. These are samples, not a peak bound, and do not establish production memory headroom or CPU-quota compliance. All requests in the 20 reported successful burst trials completed; an additional failed partial attempt is documented above. Unforced object re-instantiation during bursts is counted above; deliberate eviction and process restart are separate scenarios. The cause and production frequency of automatic eviction are not established by these local samples.

## Deadlines and recovery

20 autonomous alarm trials completed without participant reads triggering resolution; 10 were object-cold. Polling used an inspection endpoint that never initializes M3. Each saved history contained exactly one FINALIZE_ROUND and a contested result. Repeated resume preserved canonical bytes.

Alarm handler elapsed samples (ms): 7710, 4922, 7642, 4954, 7685, 5220, 7901, 4953, 7801, 4981, 8472, 4918, 7263, 5036, 7869, 4905, 7663, 4830, 7723, 5314. Maximum: 8472 ms. Actual deadline-to-completed-handler samples (ms): 7717, 4924, 7646, 4956, 7689, 5223, 7905, 4956, 7820, 4984, 8477, 4920, 7267, 5039, 7872, 4907, 7666, 4832, 7725, 5316. Maximum: 8477 ms. Alarm delivery delays (ms): 7, 2, 4, 2, 4, 3, 4, 3, 19, 3, 5, 2, 4, 3, 3, 2, 3, 2, 2, 2. Inspection-based waits additionally include polling, the one-second remaining deadline, and the subsequent participant result read. 20 overdue-cold requests recovered correctly. Five separate workerd restarts retained the same SQLite room and receipts.

## Underlying cold samples

These values are request-to-full-body milliseconds, not estimates.

- Late object-cold snapshot: 6924, 7028, 7037, 6926, 6929, 6892, 6879, 6896, 6971, 6930, 6869, 6946, 6882, 6966, 7573, 6927, 7060, 6955, 6903, 6962.
- Resolved object-cold snapshot: 7354, 7289, 7375, 7412, 7347, 7310, 7334, 7402, 7298, 7433, 7368, 7386, 7476, 7447, 7471, 7425, 7341, 7422, 7457, 7809.
- Object-cold SPIN: 9649, 9509, 9392, 9605, 9286, 9200, 9203, 9612, 9382, 9762, 9825, 9179, 9102, 9220, 9174, 9258, 9664, 9257, 9227, 9149.
- Process-cold snapshot: 6996, 7803, 7124, 7246, 6995.
- Overdue object-cold recovery: 9892, 10254, 10032, 10187, 10276, 9895, 9940, 9691, 9867, 9726, 9703, 9666, 9679, 9689, 9681, 9619, 10009, 10178, 9692, 10586.

Process startup is excluded from HTTP latency and reported separately (ms): 136, 83, 87, 99, 81.

All per-client burst samples, warm arrays, response sizes, phase counts, and timing metadata remain in full.json.

## Required next action — proposal only

Keep Worker → one room Durable Object → M3 → M2 → M1. No additional infrastructure is indicated. A focused provider-independent performance pass is required before B–E:

1. First replace repeated binary-cost sorting in evaluateFutureCompletion with equivalent domestic/overseas counts. Costs are only zero or one: for each remaining keeper, its cost plus the minimum cost of the other slots can be calculated without rebuilding and sorting all other players. Preserve the existing scan initially, including UNKNOWN fail-closed errors, all fields, and sorted keeper ordering. Prove equivalence across all eras, partial XIs, player/season variants, and keeper/overseas boundaries. Then measure whether catalog-derived canonical-player cost indexes are still needed.
2. If necessary after that change, add carefully bounded memoization of pure feasibility results or validated immutable states keyed by catalog identity and complete inputs. Never cache mutable caller data, trust unvalidated saves, weaken replay verification, or cache an uncommitted transition. Preserve seeded outcomes, canonical bytes, receipts, and error semantics.
3. Rerun this unchanged harness and the existing regression/legality/replay/simulation suites. Only reconsider B–E when both warm interaction and eight-player queueing meet the product gate; warm caching alone does not solve cold restoration.

These optimizations are not implemented. They affect shared Era Draft helpers used by M2 rather than Cloudflare code; they require separate review because solo behavior and frozen contracts must remain identical.

## Limitations and verification

Local Apple M5/workerd measurements do not predict production Cloudflare hardware, internet RTT, or multi-room contention. Twenty cold trials and five process starts provide directional distributions only. Loopback results already fail, so no deployment is needed to justify HOLD. Fixture loading is excluded, the normal ledger is included, and no optimized restore/cache variant was substituted.

Native runtime correctness: six tests passed (all-era restore/receipt replay, participant races, rollback including alarms, process restart, overdue exactly-once recovery, and repeated native alarms after resolution). Final root regression and typecheck results are recorded alongside this report. An initial harness storage-path mismatch was detected and fixed before the completed main matrix. Deadline test controls were corrected before alarm measurements to advance elapsed time without finalizing inline. Neither repair changed domain behavior. See verification.json and the accompanying logs for the final checks.

| Final check | Exit | Tests (where applicable) |
|---|---:|---:|
| Stage A typecheck | 0 | — |
| Root TypeScript build | 0 | — |
| Native workerd/SQLite correctness | 0 | 6 |
| M1–M3 regressions | 0 | 43 |
