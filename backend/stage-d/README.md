# M4 Stage D local verification

Advisory public snapshots over Cloudflare hibernating WebSockets. HTTP remains authoritative for private snapshots and commands. No deployment, remote resources, new dependencies, UI, Stage E, commit or push.

Use Node **22 or newer**. The system login-shell Node may differ from the supported runtime; the verification run used bundled Node 24.22.0. Workerd needs local loopback/process permissions. Run each native harness from its own directory: pinned Miniflare derives module names relative to cwd.

```sh
npm run build
node backend/stage-a/prepare.mjs
npm run build --prefix backend/stage-b
npm run build --prefix backend/stage-c
npm run build --prefix backend/stage-d
npm run typecheck --prefix backend/stage-d
npm run test --prefix backend/stage-d
```

Regression checks: root `npm test`, Stage A `npm test`, and Stage B/C `npm test`, each from its package directory. The Stage B package test includes hint-authority regressions. Typecheck root and Stage A–D. Generated bundles are ignored and SQLite state is temporary; retained evidence contains aggregate checks only.

## Browser protocol prerequisite

`protocol-probe.worker.mjs` is an isolated local server, not production auth. `protocol-probe.mjs` uses the exact pinned Miniflare/workerd and an existing Playwright/browser installation to test the standard browser API, selected protocol, clean URL and delivery after native hibernation. It needs no project dependency. To repeat:

```sh
cd backend/stage-d
PLAYWRIGHT_MODULE=/absolute/path/to/playwright \
CHROME_EXECUTABLE=/absolute/path/to/chrome \
node protocol-probe.mjs
```

The prerequisite passed before implementation: Chrome 155.0.8059.80 negotiated only `draft-off.v1` when offered the fixed protocol plus `ticket.<secret>`. The ticket was absent from the URL, and the same socket received a message after forced hibernation. Native product tests separately verify actual authenticated ticket issuance, consumption and replay rejection. No query-ticket route exists.

## Coverage

- Strict nested public message whitelist; frozen pre-Stage-D private projector hashes across eight states after excluding only the additive pick count.
- Authenticated, single-use, expiring, Origin/room-bound tickets; reconnect credential rejection; concurrent redemption; consumption rollback; verifier persistence across eviction/process restart; secrets absent from enabled structured logs and storage.
- Identical public broadcasts across participants; JOIN/LEAVE/REJOIN, START, locked-pick counts, submission and final contest; private SPIN/RESPIN, old receipts, no-ops and early/repeated alarms do not broadcast.
- Failed public commit emits nothing and preserves sockets; canonical corruption fails closed. Oversize realtime cannot roll back HTTP commits or prevent deadline resolution.
- Native deadline resolution with/without sockets; forced `webSockets:'hibernate'` eviction proves a new DO instance and surviving attachments/connection; dropped connection and final snapshot on reconnect.
- Multiple sockets, oldest replacement, room caps, malformed/oversize frames, ticket caps and durable rate refill/eviction; presence never changes canonical state, membership or lifecycle anchors. Expired-room traffic cannot create adapter rows after the minimal marker.
- Deterministic client GET/connect/GET races, including a newer HTTP command response arriving before an older pending GET; the private callback withholds that GET below its required confirmation floor and public data remains independently monotonic. Historical receipts/stale sockets cannot lower the publication floor. HTTP snapshots larger than the realtime frame limit still reconcile; independent HTTP body bounds reject/cancel declared, streamed or understated oversize bodies. Superseded callbacks, configurable polling with zero socket messages, focus/online/deadline resync, replacement-loop suppression, stop/abort and terminal behavior remain covered.
- Production bundle excludes controls/probe fixtures; eight participants receive identical START updates.

The harness extends the existing Stage C loopback fixtures only in its isolated bundle. `STAGE_D_ONLY=local-workerd-fixtures-only`, clock offsets, inspection/tampering and commit faults are never included in production. Native edge bindings and configuration use the existing shared policy; no binding is provisioned.

The fallback interval is `DEFAULT_REALTIME_CLIENT_POLICY.reconciliationIntervalMs` (15,000 ms), overridable through client `policy`. It supplies eventual convergence, not game authority. Caller-driven HTTP refresh and command responses remain available, and native alarms resolve independently. There are no socket commands, server countdown timers, replay history, chat, spectators or accounts.

The test-only 64-admission override has been removed from `../m5-gameplay.test.mjs`; it retains its existing accelerated command/rate budgets and production admission limit of 16. The independent `../m5-public-progress.test.mjs` uses eight actual sessions with no server or client policy overrides: READ burst 10, 60 READs/minute, admission 16 and fallback 15 seconds. Fourteen opponent locks produce zero idle private GETs and preserve the authenticated private draft. The idle entrant can still SPIN/LOCK, recover an exact lost receipt without public confirmation, reconnect, and converge through default HTTP fallback after disconnection. Public frames are recursively checked for private fields. This test is included in the backend verification gate and cannot inherit the accelerated fixture overrides.

Public revision and the required private HTTP floor advance independently. Only known opponents’ increasing pick counts can bypass private reconciliation; own-entry, lifecycle, roster, timing, legacy/missing-count and reconnect changes retain GET confirmation. Pending GETs below the private floor are withheld; HTTP at that floor can publish private state without chasing newer public progress. Stale HTTP never lowers the public roster. Only authenticated HTTP clears private pending confirmation or confirms completion. Realtime frames use `policy.maxMessageBytes` (131,072 bytes); HTTP JSON uses the independent transport limit `policy.maxHttpResponseBytes` (2,097,152 bytes), enforced against declared and actual streamed bytes before parsing. HTTP structural validation never applies the realtime frame ceiling.

Future deployment observability/logging must explicitly redact or disable capture of `Sec-WebSocket-Protocol` request headers, Authorization headers, and ticket-response bodies. No external observability configuration was audited or changed.

See [adapter contract](../cloudflare/README.md), [architecture](../../docs/DRAFT_OFF_ARCHITECTURE.md), and [verification evidence](results/verification.json). Local tests do not establish deployed latency, edge quotas, multi-room throughput or external observability configuration.
