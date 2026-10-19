# Stage B small indexed regression check

Sequential matched native workerd runs; unchanged Stage A indexed catalog, fixture bytes, M3 envelopes, and independent HTTP connections.

| Operation | Responses per adapter | Stage A p95 / max (ms) | Stage B p95 / max (ms) | Original gate |
| --- | ---: | ---: | ---: | --- |
| warmSpin | 8 | 81.5 / 81.5 | 247.0 / 247.0 | PASS |
| warmLock | 8 | 112.1 / 112.1 | 244.3 / 244.3 | PASS |
| coldSpin | 5 | 161.6 / 161.6 | 421.5 / 421.5 | PASS |
| finalSubmit | 5 | 195.1 / 195.1 | 384.0 / 384.0 | PASS |
| coldOverdue | 5 | 272.1 / 272.1 | 694.4 / 694.4 | PASS |
| era-modern-pre-impact/burst-spin | 40 | 602.2 / 602.5 | 1200.5 / 1200.7 | PASS |
| era-modern-pre-impact/burst-lock | 40 | 647.7 / 647.9 | 1193.0 / 1193.5 | PASS |
| era-impact/burst-spin | 40 | 887.3 / 887.5 | 1735.6 / 1735.8 | PASS |
| era-impact/burst-lock | 40 | 699.0 / 699.2 | 1257.9 / 1258.0 | PASS |

Small regression sample; p95 is directional and is the maximum for n < 20. Five burst trials produce 40 correlated participant responses per action, not 40 independent room trials. Sequential local workerd/loopback runs; not deployed hardware, Internet RTT, quota or multi-room load measurements. All samples are retained in hint-authority-performance.json; no failures, omitted trials, or automatic retries. All 80 fixture hashes match the committed indexed milestone.

Environment: Apple M5, Node v22.23.3, darwin/arm64, OS 25.5.0. Same pinned Stage A Miniflare/workerd packages and compatibility date. Historical full indexed primary-era p95: warm SPIN 81 ms, LOCK 100 ms, cold SPIN 194 ms, final submission 187 ms, cold overdue 275 ms. The small paired runs are the direct current comparison; the original full baseline remains unchanged.
