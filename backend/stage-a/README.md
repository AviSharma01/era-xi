# Draft-Off M4 — Stage A, local runtime feasibility only

This directory measures the M1/M1.1 simulation, M2 domain, and M3 room service inside real workerd Workers and SQLite-backed Durable Objects. Their behavior and persistence contracts remain unchanged; the shared legality helper now uses count-based completion costs and a catalog-derived canonical cost index. This is a local feasibility harness, **not the M4 product backend**.

The completed [indexed performance report](index-milestone/report.md) returns **GO under the original local responsiveness gates**, with two full matrices and two dedicated matched Impact burst runs. The [original Stage A report](results/report.md) and [count-only report](performance-milestone/report.md) retain the earlier HOLD measurements. No deployment or Stage B–E implementation is included.

The V2.0 product decisions remain: 10 or 15 minutes, default 15; lobby expiry after 24 hours; results retained seven days; retired-code markers retained 30 days after cleanup. Enrollment/reconnect stays adapter-local. None of that product API, authentication, retention, or UI is implemented here.

## Reproduce

Use Node 22 (the measured installation is 22.22.2). Build the existing TypeScript project from the repository root:

```sh
npm run build
cd backend/stage-a
npm ci --legacy-peer-deps
npm run build
npm run typecheck
npm test
```

To regenerate the two retained comparison reports from their archived measurements:

```sh
node performance-milestone/summarize.mjs
node index-milestone/summarize.mjs
```

To collect new measurements, use a separate disposable copy of the checkout: the unchanged benchmark writes to `results/`, which contains the original archived baseline in this checkout. From that copy's `backend/stage-a/` directory after the build above:

```sh
npm run benchmark -- smoke
npm run benchmark -- full
npm run benchmark -- profile
node index-milestone/matched-impact.mjs
```

Retain each newly completed `results/full.json` before another full run overwrites it. The milestone summarizers reproduce the retained historical reports; they do not automatically ingest new runs. `report.mjs` is the original Stage A report template and unchanged gate definition, not the current performance-milestone narrative.

The full run can take minutes to tens of minutes depending on the implementation being measured. Do not run correctness tests, builds, or another benchmark simultaneously with it. The inspector profile is a separate diagnostic run, excluded from the latency gate. There is no deployment script, Cloudflare account connection, Wrangler deployment configuration, or production resource creation. Miniflare/workerd binds loopback only. All three development dependencies are isolated from the root application package.

If interrupted, use `npm run benchmark -- full --resume`. It verifies the environment and artifact inventory, backs up the checkpoint, and skips completed rows/trials. New samples retain a run-segment marker. Cold SPIN, process-cold, alarm, and overdue trials checkpoint individually; each eight-player burst checkpoints after its SPIN and LOCK pair.

`prepare.mjs` verifies the committed artifact sizes/hashes, creates scoped catalogs, and builds deterministic 2/8-player fixtures via the existing domain reducer. Fixtures cover lobby, zero/five/ten/eleven picks, the current final spin, seven submissions, and resolution. Historical receipt fingerprints/results use the exact M3 shapes; the runtime correctness tests verify original results through M3 retry handling. Participants follow deterministic varied legal selections. No data/rating artifacts are regenerated or modified.

Generated fixtures, the bundle, local SQLite stores, logs, checkpoint backups, and temporary result files are ignored. Retained results contain measurements and reports, never canonical room saves, credentials, or private fixture payloads. Complete raw matrices and CPU profiles are intentional evidence; failed-run/incident evidence is not hidden by the ignore rules.

## Runtime and measurement boundary

- Requests travel over actual loopback HTTP through a Worker into a Durable Object, then through `DraftOffRoomService`.
- The repository loads frozen canonical state and complete receipts; it commits canonical bytes, new receipts, and alarm scheduling atomically. It adds no restored-state cache.
- Per-room requests/alarms share an operation queue. Repository transactions realize M3's existing serialized, atomic contract.
- Wake metadata is extracted from M3's canonical accepted-event format. Gameplay remains in M2/M3. Warm alarms deliver M3's registered callback; cold alarms recover with `resumeRoom()`.
- Native `unsafeEvictDurableObject()` demonstrates constructor re-instantiation; the instance IDs must change. Process-cold tests dispose/restart workerd with the same persistent SQLite directory and verify state and receipt equality.
- Fixture timestamps use a persisted offset from real `Date.now()`. A round still lasts 900,000 logical milliseconds. Deadline tests advance the server epoch to one second before the stored deadline, letting **real Durable Object alarms** run autonomously without waiting 15 minutes per trial. This offset/fixture control is local-only and is not a product endpoint.
- Snapshot and command results are JSON-serialized before returning. Client monotonic time includes connection, queueing, computation, storage, and reading the response body. Requests use independent HTTP connections, not a single pipelined socket.
- The recorded run initially used fetch/Undici with `Connection: close`. A socket closed during an additional partial burst attempt; its incident record is retained. Remaining trials use Node built-in HTTP with `agent: false` and no retries. Raw samples identify the driver/run segment, and the report separates burst results by driver. Both measure the same loopback HTTP/full-body boundary.
- Body encoding/preparation is excluded for tiny command requests; setup/import of large fixtures is never timed as a participant operation. Warm imports resume M3 before timing starts. Cold samples include catalog verification/loading and service recovery.

Only Impact gets the full matrix if the all-era smoke ranks it heaviest. All five eras get late-draft correctness/retry, cold restore, and final-resolution smoke checks. A materially slower different era becomes primary; near-equal alternatives receive additional checks. The full matrix uses 30 warm samples per row, 20 cold trials and 20 eight-participant burst trials; process-cold has five samples.

The native Node test runner controls Miniflare over HTTP; a separate Vitest abstraction is unnecessary for this harness. This still tests actual workerd, SQLite transactions, process persistence, object eviction, and alarms.

## Interpretation

Local workerd uses the same execution/storage primitives, but these are **not deployed Cloudflare latency or CPU-quota measurements**. Internet RTT would add to these numbers. The hardware is recorded with the samples.

Worker phase clocks have millisecond resolution in the pinned local runtime. `resumeMs` overlaps restore/storage timings and must not be added to them. Queue/transport estimates subtract service time from client time; they include native runtime gating and transport, not just the explicit JavaScript queue. Inspector heap samples are observations, not a measured peak or proof of production memory headroom.

Cold p95 values from 20 trials are directional; inspect the underlying arrays and maxima in the report. Smoke rows have only three warm or one command/cold sample and are fixture selection evidence, not statistical confidence.

The initial product gate is warm p95 ≤500 ms / max ≤1 s; cold p95 ≤1.5 s / max ≤3 s; eight-player burst per-client p95 ≤2 s / max ≤3 s; final submission p95 ≤2 s / max ≤3 s. Provider CPU limits alone never establish GO.

Deadline-to-completed-handler uses the same p95 ≤2 s / max ≤3 s budget as final submission. Delivery delay and handler cost are recorded separately; inspection waits additionally include polling and the subsequent participant read.

## Outputs

- `results/artifact-inventory.json`: verified sizes, compression, and era counts.
- `results/full.json`: raw measured samples, summaries, individual burst clients, deadline trials, and process-cold samples.
- `results/diagnostic.json` and `diagnostic.cpuprofile`: separate CPU/heap diagnostic.
- `results/report.md`: findings, gate decision, limitations, and proposed next action.
- `results/transport-incident.json` and `verification.json`: original incident evidence and verification summary; commands use portable executable names.
- `baseline-before-counts/harness-hashes.json`: hashes proving the native harness and gate implementation stayed unchanged; duplicate baseline measurements have been removed.
- `performance-milestone/`: two count-only raw matrices, CPU profile, fixture hashes, verification, gate results, report, and report generator.
- `index-milestone/`: two indexed raw matrices, two dedicated matched Impact burst runs, CPU profile, fixture hashes, verification, gate results, report, and reproduction scripts.

Fixture inspection, import, fault injection, and participant selection are intentionally testing controls. The local Worker requires its explicit harness binding; they must never become public authentication or restore APIs.
