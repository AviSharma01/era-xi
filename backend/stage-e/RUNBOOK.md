# Draft-Off local development and future staging runbook

M4 ends at local backend verification. These instructions provision nothing. M5 consumes the [frozen contract](M5_CONTRACT.md); existing solo web release instructions remain in `docs/RELEASE.md`.

## Local prerequisites and verification

Use Node >=22 (Stage E verified Node 24.22.0); the independent V1 CI job uses Node 20, while the backend job pins Node 24.22.0. Use the committed root lockfile and `backend/stage-a/package-lock.json`; Stage B–E share Stage A's pinned Miniflare 5.20261001.0-alpha, workerd 1.20261001.1, esbuild 0.28.1 and Workers types. Install with `npm ci` at root and `npm ci --prefix backend/stage-a` only if dependencies are absent. Do not upgrade runtime pins or fetch/regenerate cricket data to verify this milestone.

From the repository root:

```sh
set -eu
npm run verify:release
npm run verify:backend
git diff --check
git status --short
```

`verify:backend` fails immediately on any failed child command. It builds the root and A–D packages, runs root/A–D typechecks, compares all 80 canonical fixture hashes, then runs A–E correctness sequentially. It includes the representative combined multiplayer and eight-player production smoke; it runs no expensive benchmark matrix. Run native suites sequentially, allowing local workerd child processes and loopback sockets. Each package runs from its own cwd because Miniflare module names depend on cwd. Stage E's command selects Stage D's cwd deliberately. The Stage A prepare command rebuilds content-hash-verified catalogs and 80 deterministic fixtures; it is **not** the expensive Stage A benchmark. Run no benchmark matrix unless a regression calls for investigation. Keep latency smoke separate from builds/full-validation/other runtime workloads. Ordinary runs preserve committed Stage A–E evidence. Fresh Stage C/E aggregate smoke results go under each package's ignored `.generated/results/`; Stage A preparation writes its current inventory to `.generated/artifact-inventory.json`. Retained `results/` and milestone directories are historical evidence and are never ordinary test output. Full 5,000-game validation and benchmark tools remain separate investigation commands, to run only when a relevant change justifies them.

Stage E uses real HTTP commands and WebSocket upgrades. Its reused Stage D isolated controls only inspect storage, shift a test clock, inject failures or force hibernation/restart. They are never a development/product API. Temporary SQLite state includes credentials and private drafts: do not publish it or raw request traces. Stage E removes its own temporary state on completion. Persist only aggregate checks and numeric timing samples. Native regression packages create temporary directories per their existing harnesses; remove any retained local fixture state when no longer needed.

## Local interactive backend

Build as above. To run the **production entrypoint locally**, from `backend/stage-d`, execute:

```sh
node
```

Then in the Node REPL:

```js
const { mkdtempSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { startRuntime } = await import('./runtime.mjs');
const localState = mkdtempSync(join(tmpdir(), 'draft-off-dev-'));
const localOptions = { production: true,
  bindings: { ALLOWED_ORIGINS: JSON.stringify(['http://127.0.0.1:5173']) } };
let local = await startRuntime(localState, localOptions);
console.log(local.url.origin); // Only the local URL; never print tokens or replies.
```

This serves Stage C/D HTTP + WebSockets with local native rate bindings and no test-control routes. Use the printed API origin, send the exact allowed Origin (browsers supply it), and use `enrollGuest`/`createDraftOffRealtimeClient`. A local non-browser HTTP client must also set `CF-Connecting-IP: 127.0.0.1` because the production edge normally supplies it. Use separate browser storage contexts for different guests. Default durable command budgets apply; do not send a synthetic full XI at machine speed against defaults. Tests declare permissive overrides explicitly; these are not a staging policy recommendation.

For a **persisted local restart**, `await local.mf.dispose()` then `local = await startRuntime(localState, localOptions)`; reconnect sockets and GET. Preserve the same state/runtime/class/namespace configuration. Hibernation/re-instantiation controls belong only to the verification harness. To finish, dispose the active runtime and remove only the temporary directory you created:

```js
await local.mf.dispose();
rmSync(localState, { recursive: true, force: true });
```

No M5 UI route exists yet. `npm run dev:web` serves the existing solo application, not a Draft-Off client. The production backend bundle is `.generated/worker.js`, never `.generated/harness.js`; it exports `DraftOffRoom` and the Worker handler. Generated source maps and embedded catalogs are server-only; do not serve them as web assets.

## Future staging deployment gates

Requires a separate deployment instruction. No account resources, namespace IDs, migrations, routes, domains or Wrangler configuration have been chosen or created here.

| Configuration | Required before staging |
| --- | --- |
| Target and routing | Select account/environment, Worker name, HTTPS API origin/domain/route and frontend HTTPS origin. WebSockets use wss. Decide provider-specific packaging; use only the production entrypoint `backend/cloudflare/worker.ts` with content-hash-verified generated catalogs available at build time. |
| Compatibility/runtime | Preserve tested compatibility date `2026-10-01`; validate any chosen deployment CLI/runtime separately. Miniflare alpha is a local harness dependency. Verify deployed worker bundle limits, CPU/memory limits and synchronous replay/simulation workload under the selected plan; local tests prove no quota headroom. |
| Durable Object binding | Bind `ROOMS` to exported `DraftOffRoom` with SQLite storage. Assign an initial unique SQLite class migration (`new_sqlite_classes: ["DraftOffRoom"]`) and actual namespace/environment identifiers through the chosen deployment tool. No D1, KV directory, database or global code allocator is needed. Never point staging at another environment's room namespace. |
| Origins | Set `ALLOWED_ORIGINS` to a JSON array of exact approved HTTPS origins (no paths/wildcards). Missing/invalid config fails closed. Configure local HTTP origins only for local development. |
| Rate bindings | Provision native `CREATE_RATE`, `ENROLLMENT_RATE`, `REQUEST_RATE` namespaces with 60s periods and thresholds from `edgeRateDefinitions(limits(env))`: defaults 10/120/600. Assign namespace identifiers and verify isolation/scope with the deployment tool. Missing bindings fail closed. |
| Limits | Optional `STAGE_C_LIMITS` positive-integer JSON overrides. Unknown/invalid keys fail closed. Change native thresholds and this policy together; the API cannot change edge thresholds per request. Defaults live in `backend/cloudflare/limits.ts`. |
| Logging/observability | **Explicitly redact or disable capture** of `Authorization`, `Enrollment-Key`, `Sec-WebSocket-Protocol` ticket values, socket-ticket response bodies, enrollment credential responses, and private request/response/WebSocket payloads. Apply to Worker observability, request logs, traces, Logpush/tails, proxies, exception reporters, browser network instrumentation, analytics and session replay. Disable header/body/frame capture where selective redaction is unavailable. |
| Logging evidence | Review effective settings at every enabled layer; use only application metadata `requestId`, route template, status, safe error code, elapsedMs. Run canary enrollment/ticket/command/error/reconnect flows and search enabled sinks for the canary secrets/private markers without copying them into reports. Record configuration evidence and aggregate pass/fail. This is an outstanding deployment gate; external account settings were not audited locally. |
| Asset/privacy boundary | Keep bundled full catalogs, source maps, SQLite saves, receipts, auth/recovery records and fixture controls out of public assets/artifacts. Disable caching for the API; preserve no-store responses, CORS/preflight and strict Origin forwarding through any proxy. Do not introduce URL credentials. No additional application secret is required by the existing Enrollment-Key wrapping scheme. |
| CI/release | Run this full backend gate on Node >=22 in a suitable CI runner before promoting; the independent `backend-gate` job runs `npm run verify:backend` with Node 24.22.0, alongside the unchanged V1 release job. Separate staging and production configs. Retain tested build/source/runtime identifiers and safe aggregate evidence; do not upload raw fixture/storage/log payloads. |

After separately authorized staging provisioning, repeat create/multiple joins/start/concurrent drafts/reconnect/retry/submit/deadline/final snapshot using real browsers on approved origins. Verify an unapproved origin fails, ticket replay fails, no private fields reach another entrant, HTTP recovers when sockets are unavailable, and deadline alarms work after all browsers close. Check cleanup against the unchanged 24h lobby / 7d completed / 30d retired-marker anchors with an isolated staging verification plan; never expose test-clock controls. Measure real network responsiveness and platform resource limits before public launch.

Rollback means restoring a reviewed compatible production Worker bundle/config while preserving the same room namespace and class. Never delete/migrate the namespace as routine rollback or import fixture saves. Re-run authenticated snapshot/exact retry/deadline checks; canonical catalog/version mismatch fails closed and requires a separately reviewed compatibility decision. Stop admission if observability cannot guarantee redaction or private data capture is found. No deployment or rollback was executed by Stage E.

## Pre-merge transport and abuse safeguards

The realtime client bounds each HTTP fetch plus complete response-body consumption with `policy.requestTimeoutMs` (default 10,000 ms). Timeout releases synchronization for a future resync; disposal cancels active requests immediately. A 429 applies one shared cooldown to GET, ticket acquisition, reconnect and explicit resync. Retry-After seconds and HTTP dates are supported; absent/invalid values use 60 seconds. Timers wait in bounded chunks for long cooldowns.

Definitive enrollment rejections allow correction with a fresh pending key: 400 INVALID_REQUEST; 409 DISPLAY_NAME_RESERVED/PARTICIPANT_LIMIT/INVALID_PHASE; 413 PAYLOAD_TOO_LARGE; 404 ROOM_UNAVAILABLE. Uncertain failures, lost responses, malformed responses, key conflicts, ROOM_CODE_UNAVAILABLE, 429/503 and failed credential storage retain the exact pending key/input. Only explicit ROOM_CODE_COLLISION automatically rotates a CREATE key for the same intent; ROOM_CODE_UNAVAILABLE requires a separate explicit user decision to abandon the unavailable attempt before creating a different room. The helper deliberately adds no automatic reset/abandonment path. All response-side writes verify the exact pending key/input record first, including credential writes, rejection cleanup and collision rotation. Success cleanup rechecks ownership after verified credential storage. Stale responses are returned without storage side effects, so callers must not apply a historical result to a newer intent. CREATE collision recovery remains explicit.

Authenticated GET/command/ticket requests check exhausted durable buckets before catalog/replay recovery. The preflight is read-only; normal consumption still occurs in its original transaction and no state access is authorized by a bucket check. Throttled requests can receive 429 before expiry/corruption recovery; native alarms and subsequent admitted access remain responsible for canonical recovery and cleanup. Invalid credentials still fail before bucket inspection. Unsupported socket frames and close/error handling do not enter the gameplay queue, so a held queue cannot retain a frame flood. None of these safeguards changes membership, receipts, deadlines or retention anchors.

Production `catalog.ts` imports only the generated data module from Stage A preparation: the manifest and exact committed V1 artifact strings. It imports no harness, fixtures, test controls, Miniflare or Node runtime. Production-bundle isolation and catalog hash checks remain in the correctness suites. Extracting this data-only build step from Stage A can wait until deployment packaging; no runtime separation fix is necessary now. These local safeguards do not establish Internet-scale abuse resistance, platform quota headroom or external capture/redaction settings; those remain staging gates above.
