# Stage B small indexed regression check

Sequential matched native workerd runs; unchanged Stage A indexed catalog, fixture bytes, M3 envelopes, and independent HTTP connections.

| Operation | Responses per adapter | Stage A p95 / max (ms) | Stage B p95 / max (ms) | Original gate |
| --- | ---: | ---: | ---: | --- |
| warmSpin | 8 | 83.1 / 83.1 | 105.6 / 105.6 | PASS |
| warmLock | 8 | 153.6 / 153.6 | 82.9 / 82.9 | PASS |
| coldSpin | 5 | 192.6 / 192.6 | 159.3 / 159.3 | PASS |
| finalSubmit | 5 | 181.4 / 181.4 | 178.8 / 178.8 | PASS |
| coldOverdue | 5 | 337.9 / 337.9 | 263.8 / 263.8 | PASS |
| era-modern-pre-impact/burst-spin | 40 | 622.1 / 622.5 | 572.1 / 572.3 | PASS |
| era-modern-pre-impact/burst-lock | 40 | 647.1 / 647.2 | 630.7 / 630.9 | PASS |
| era-impact/burst-spin | 40 | 824.1 / 824.5 | 616.9 / 617.3 | PASS |
| era-impact/burst-lock | 40 | 951.4 / 951.4 | 636.4 / 636.5 | PASS |

Small regression sample; p95 is directional and is the maximum for n < 20. Five burst trials produce 40 correlated participant responses per action, not 40 independent room trials. Sequential local workerd/loopback runs; not deployed hardware, Internet RTT, quota or multi-room load measurements. All samples are retained in performance.json; no failures, omitted trials, or automatic retries. All 80 fixture hashes match the committed indexed milestone.

Environment: Apple M5, Node v22.23.3, darwin/arm64, OS 25.5.0. Same pinned Stage A Miniflare/workerd packages and compatibility date. Historical full indexed primary-era p95: warm SPIN 81 ms, LOCK 100 ms, cold SPIN 194 ms, final submission 187 ms, cold overdue 275 ms. The small paired runs are the direct current comparison; the original full baseline remains unchanged.
