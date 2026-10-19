# Draft-Off Cloudflare adapters — M4 backend handoff

Stage E verification and M5 handoff: [results](../stage-e/results/report.md), [client contract](../stage-e/M5_CONTRACT.md), and [local/future staging runbook](../stage-e/RUNBOOK.md). No deployment configuration or remote resources have been created.

One SQLite-backed `DraftOffRoom` DO per canonical public invite code, routed with `ROOMS.idFromName(code)`. The DO ID, invite code, participant ID and reconnect credential are separate identities. Codes grant no participant authority. The Worker invokes typed `publicOperation` for product HTTP; DO `fetch` accepts only the authenticated realtime upgrade. Legacy trusted actor RPCs are internal and never populated from browser actor fields.

## Environment

- `ROOMS`: SQLite DO namespace bound to `DraftOffRoom`.
- `ALLOWED_ORIGINS`: JSON array of exact HTTPS frontend origins. Explicit localhost/loopback HTTP origins are allowed for tests. Missing/invalid configuration fails closed.
- `CREATE_RATE`, `ENROLLMENT_RATE`, `REQUEST_RATE`: native Worker rate-limit bindings with 60-second periods. Derive thresholds using `edgeRateDefinitions(limits(env))` in `limits.ts`; choose namespace identifiers during later deployment setup.
- `STAGE_C_LIMITS`: optional JSON overrides of positive integer defaults in `limits.ts`. Unknown keys/invalid values fail closed. When changing edge thresholds, update bindings and environment together: the native API cannot change its threshold per request. The local harness derives both from the same policy.

All defaults are configurable adapter safeguards, not product contracts. No deployment configuration, external namespace or resource was created. Builds reuse pinned Stage A Miniflare/workerd dependencies and generated content-addressed catalogs.

## `/api/draft-off/v1` HTTP

All routes require an allowed Origin. POST bodies are exact JSON objects; GET has no body. Unknown fields, queries, encoded POST bodies, invalid UTF-8, and oversize bodies (including streamed bodies) are rejected. JSON allows only an optional UTF-8 charset parameter. Credentials use headers, never cookies, invite links or query strings.

| Route | Input/auth | Success |
| --- | --- | --- |
| `POST /rooms` | Enrollment-Key; `{displayName,eraId,draftMinutes?:10\|15}` | 201: `{ok:true,roomCode,participantId,reconnectCredential,settings:{draftMinutes},view}` |
| `POST /rooms/{code}/join` | Enrollment-Key; `{displayName}` | Same enrollment shape, 201 |
| `GET /rooms/{code}` | Authorization: Bearer credential | 200: `{ok:true,roomCode,participantId,settings,view,serverTimeMs}` |
| `POST /rooms/{code}/commands` | Bearer plus envelope below | Original M3 success `{ok:true,changed,roomRevision,view?}` |
| `POST /rooms/{code}/socket-tickets` | Bearer; exact `{}` body | 201: `{ok:true,ticket,expiresAtMs}` |
| `GET /rooms/{code}/realtime` | WebSocket upgrade; subprotocol ticket + approved Origin | 101, negotiated protocol `draft-off.v1`; initial public snapshot |

Lifecycle envelope: `{commandId,expectedRoomRevision,command:{type:"LEAVE"|"REJOIN"|"START"}}`. REJOIN maps to M3 JOIN without a name change. START derives the round ID and deadline from validated state, server time and stored duration. Deadline time is sampled in the serialized handler immediately before M3 execution; M3 independently timestamps execution. No client actor, timestamp, seed, round ID or deadline is accepted.

Participant envelope: `{commandId,expectedDraftRevision,command}`. Commands: `{type:"SPIN"}`, `{type:"RESPIN"}`, `{type:"SUBMIT"}`, or `{type:"LOCK_PLAYER",playerTeamSeasonId,battingPosition}`. Revisions are non-negative safe integers; positions are 1–11. Public IDs are 1–80 ASCII letters/digits/underscore/hyphen, excluding internal colon namespaces. Player-team-season IDs are trimmed, nonempty and at most 160 characters.

Names are trimmed, nonempty, at most 64 Unicode code points, with no control characters. M2 owns name reservation, membership, 2–8 joined participants, host authority and legality. Creation selects 10/15 minutes (default 15); no settings-edit route exists.

Errors: `{ok:false,error:{code,message},roomRevision?,view?}` with fixed safe messages. Statuses: 400 malformed; 401 uniform auth failure; 403 origin/authority; 404 unavailable JOIN/unknown route; 405 method; 409 enrollment, command-ID, revision, phase/capacity/deadline conflicts; 413 bytes; 415 media; 422 incomplete XI/draft legality; 429 limits; 503 configuration/temporary failure. Registered command errors can include only that actor's M3 view. Failed enrollment never supplies a view. Authenticated missing/nonexistent/expired/wrong-room credentials receive the same 401 body.

OPTIONS returns 204 without DO access for approved origin/method/headers. CORS reflects only exact allowed origins, varies on Origin, allows Content-Type/Authorization/Enrollment-Key, and exposes Retry-After/X-Request-Id. It does not enable credentialed CORS. Responses are private/no-store and nosniff.

## Enrollment and credentials

Enrollment-Key contains 32 random client bytes in canonical unpadded base64url. It is pending recovery material. The transport helper in `../client/draftOff.ts` verifies pending storage before sending, retains the key through uncertain failure, and removes it after storing and reading back the reconnect credential or after an allowlisted definitive rejection. Corrected intent then uses a fresh key; explicit `ROOM_CODE_COLLISION` retains its separate CREATE collision retry behavior. See the correction allowlist in the M5 contract. Every response-side storage write first verifies ownership of the exact pending key/input record. Delayed success, rejection and collision responses cannot clear/rotate a newer pending attempt or overwrite its credentials; credential-storage failure leaves the active attempt recoverable. Returned response bodies can still be historical and do not establish ownership of current client state. This helper has no React UI integration.

CREATE derives a 12-character code from the first 60 bits of the full domain-separated digest using `0123456789ABCDEFGHJKMNPQRSTVWXYZ`. Codes normalize lowercase to uppercase. Stored full digests distinguish collisions from input reuse. Only explicit `ROOM_CODE_COLLISION` automatically rotates the key for the same CREATE intent. `ROOM_CODE_UNAVAILABLE` preserves the exact pending key/input: an occupied or retired code is not proof of a digest collision. Starting a different room requires an explicit user decision to abandon that unavailable CREATE attempt; the helper adds no automatic abandonment/reset path. No directory, probing or D1 exists.

Participant IDs are 128 server-random bits in lowercase hex, satisfying the existing M2 locale/byte roster-sort invariant without changing M2. Credentials are 256 independently server-random bits. Room-scoped SHA-256 verifiers map to immutable IDs. Fixed 32-byte comparisons use `crypto.subtle.timingSafeEqual`; equal/unequal/length-error behavior is verified in pinned workerd despite Node's ambient type omitting the extension.

Recovery stores an AES-256-GCM-sealed credential plus verifier, never plaintext tokens or Enrollment-Keys. HKDF-SHA-256 derives the wrapping key from the supplied Enrollment-Key. Authenticated context binds version, operation, room, participant and normalized request fingerprint; each seal uses a random 96-bit nonce. JSON field order does not affect retry fingerprints. Initial JOIN derives its command ID and current global CAS revision under the room queue, because unregistered guests cannot read snapshots.

Successful exact retry returns the original result/view without rejoining or advancing membership; GET synchronizes current state. Credentials survive leave/rejoin, start, submission and completion until room expiry. There is no rotation or name-based recovery. Rejected enrollment/command results replay exactly only while present in the bounded negative-result cache; after eviction they may be evaluated again against current state, and a rejected key/ID has no permanent input reservation. Successful keys/IDs are never evicted and retain their conflict protection until expiry.

## Storage, abuse and privacy

An optional companion callback writes adapter records inside the repository's existing state/receipt/wake/alarm transaction, before fault injection. CREATE commits settings, host auth and recovery; JOIN commits its result and successful auth; command translation/counts commit with receipts. START retries reuse the original expanded envelope/deadline. M1–M3 interfaces, saves and receipts are unchanged.

Adapter keys start with `api:`: create, settings, enrollment digests, verifier-indexed auth, command mappings, counts and buckets. Live canonical validation and expiry precede recovery. Auth verifies credentials before expensive restoration, then uses Stage B recovery. Every view comes from M3's safe projector or receipts. Legacy Stage B fixture rooms receive no retroactive credentials.

Edge limits are permissive/per-location. Durable room token buckets throttle new rejected/invalid/stale attempts; queue admission is bounded. `enrollmentRecords` counts successful CREATE/JOIN commits only, and `participantCommandIds` counts successful command receipts only (including successful no-ops). These lifetime ceilings still bound fresh successful admissions; existing successful exact retries bypass them, while request throttles still apply.

`negativeResultRecords` bounds one shared room-wide FIFO for rejected enrollment and command records (default 64). A rejected attempt never increments a success counter. Its adapter mapping/recovery result and M3 receipt enter the FIFO and are evicted together inside the same state/receipt/wake/alarm transaction. Successful records and deadline receipts never enter that FIFO. Thus rejected traffic cannot consume permanent gameplay/enrollment capacity, even across eviction/restart. Stored receipt/recovery rows are bounded by successful admission ceilings plus the shared negative ceiling; no per-attempt counter/index grows without bound. Canonical accepted history remains unchanged and bounded by successful admissions. Trusted Stage B RPC receipts keep their original semantics. Counters/eviction never alter alarms or retention.

Stage B still owns canonical replay, deadline finalization and atomic scheduling. Retention remains creation +24h, completion +7d, marker until expiry +30d. Expiry deletes all adapter/private/canonical records and receipts, retaining only the original minimal marker. Retry guarantees end at expiry. Scheduling hints remain advisory and cannot bypass canonical validation.

Logs contain only generated request ID, route template, status, stable error code and elapsed time. Raw URLs/headers/bodies, names, addresses, identities, tokens/verifiers, ciphertext, saves, seeds and exception strings are excluded. Production imports no test controls. UI, accounts, deployment and global history remain absent.

## Stage D advisory realtime

HTTP remains authoritative for create/join, private snapshots and all commands. No application message from a socket can execute a command. Socket presence is not membership, and disconnected participants remain rostered. Registered LEFT participants retain the same read access as their existing authenticated GET; there is no spectator role/enrollment.

### Ticket transport and lifecycle

The browser calls `new WebSocket(url, ['draft-off.v1', 'ticket.' + ticket])` with the bare `/realtime` URL. Worker and DO validate exactly this ordered pair and reject all queries, extra/missing protocols, reconnect/enrollment auth headers, bodies and invalid Origins. Both independently check the exact Origin allowlist. The response negotiates **only** `draft-off.v1`, never the ticket-bearing offered value. No query-string transport or silent fallback exists.

The pinned Miniflare `5.20261001.0-alpha` / workerd `1.20261001.1`, compatibility date `2026-10-01`, passed an actual headless Chrome handshake and delivery after forced hibernation. See `../stage-d/protocol-probe.mjs` and its verification evidence. Browser subprotocol negotiation is the standard `WebSocket(url, protocols)` API.

An authenticated ticket request derives identity from Stage C auth, validates the live room, generates 256 random bits and atomically stores a domain-separated room-bound verifier with participant, issuing Origin, issue/expiry times and version. Raw tickets are never stored or sealed. The default validity is 30 seconds, ending at expiry (`now >= expiresAtMs`). Expiry limits redemption, not an established socket's lifetime; sockets remain until disconnection, replacement or room expiry. A lost issuance response is recovered by requesting a new ticket, subject to the same bounds; no M3 receipt is created.

Upgrade first verifies the ticket cheaply before catalog replay/recovery, then validates canonical state and atomically rechecks/deletes the verifier under the existing room queue. Origin binding prevents redemption from another allowed Origin. Constant-time verifier comparison and a separate digest domain prevent using a reconnect credential directly as a ticket. Identity comes only from the stored assertion. Capacity rejection leaves the ticket unconsumed. Once consumed, acceptance/transport failure never refunds it: obtain a fresh ticket. Storage transactions cannot atomically guarantee network delivery.

Ticket headers remain sensitive even though URLs are clean. Application logs never record request/response headers or ticket bodies; the native tests scan enabled structured logs for issued secrets and the ticket prefix. No deployed edge logging/Logpush/observability configuration is enabled or created by this milestone, so local evidence makes no claim about an external account's settings. Before staging, explicitly redact or disable capture of `Authorization`, `Enrollment-Key`, and `Sec-WebSocket-Protocol` ticket values, ticket-response bodies, enrollment responses containing reconnect credentials, and all private request/response/socket payloads. Apply this to Worker observability, traces, Logpush/tails, proxies, error reporters, browser telemetry and session replay; use only the application metadata allowlist (`requestId`, route template, status, safe code, elapsedMs). Verify the effective settings and a secret-canary check before admitting guests. See the [deployment gate](../stage-e/RUNBOOK.md#future-staging-deployment-gates). This implementation has no URL-ticket logging exception to audit.

### Public contract and committed broadcasts

The only application message is `{version:1,type:'ROOM_SNAPSHOT',serverTimeMs,view}`. `view` is `DraftOffPublicRoomView`, explicitly constructed by `projectDraftOffPublicRoom`: room ID/global revision/phase, public participants, current round metadata/times, and the existing safe resolution/leaderboard summary. A resolution means the leaderboard is available; `NO_CONTEST` has an empty leaderboard. No draft, picks, candidates, XI, submission, seeds, hashes, receipts, saved state or simulation details are sent, including after resolution. Host access is identical to member access.

The private projector composes that whitelist with only the caller's `myDraft`, preserving the exact existing `view` field order, fields and optional absence. Regression hashes were captured from the committed Stage C projector across eight fixture states. The new GET `serverTimeMs` is outside `view` and is not inserted into receipts or enrollment retry results.

The repository's optional observer runs after a successful storage transaction, inside repository/room operation ordering, never inside a retryable callback. It fires only for newly changed canonical bytes. With sockets connected, the adapter compares previous and committed public content excluding revision; private draft progress therefore does not broadcast. The next state reuses the commit's mandatory canonical restoration; previous state is restored only when needed for connected recipients. No authoritative/public cache is persisted.

JOIN/LEAVE/REJOIN, START, changed submission and resolution produce one complete snapshot, serialized once for identical recipient bytes. Final submission sends the resolved snapshot without an intermediate submission message. Rejections, no-ops, receipt-only writes, private SPIN/RESPIN/LOCK, presence and exact historical retries produce none. An old receipt's `changed:true` is irrelevant. Recovery triggered by a retry can independently commit a new deadline resolution and broadcast it. Send/observer failures cannot undo state/receipts/alarms or prevent subsequent reconciliation. There is no outbox, replay or exactly-once delivery guarantee across process failure.

### Hibernation, reconnect and convergence

Use `ctx.acceptWebSocket`, `ctx.getWebSockets` and DO WebSocket handlers, with participant tags and versioned `{roomId,participantId,connectionId,connectedAtMs}` attachments. There is no in-memory connection registry. Attachments survive hibernation while the connection survives; process failure/restart can disconnect it. Cold alarms reconstruct M3 exactly as before and broadcast to runtime-owned sockets. Invalid attachments cannot receive updates. Failed/closing sockets are ignored or closed; room expiry closes sockets with code 4004 and preserves the original minimal marker.

`../client/realtime.ts` provides a UI-independent transport helper. Call `start()`, use its separate public and authenticated snapshot callbacks, call `observeCommand(result)` after HTTP commands, and `stop()` on disposal. It obtains GET → ticket/socket → initial snapshot → GET; newer revisions arriving during GET cause another coalesced GET. A monotonic highest-known revision includes validated HTTP snapshots, socket snapshots and HTTP command response revisions. A GET below that floor publishes neither private nor public data and cannot mark the client terminal; reconciliation fetches again until it catches up. Stale receipts/socket messages never lower the floor. Sockets never replace private draft state, historical receipt views are not applied, and superseded callbacks are ignored. Global revision gaps are valid and are not an event-loss counter.

Shared structural validation is independent of transport byte limits. Client `policy.maxMessageBytes` (131,072 bytes) applies only to WebSocket frames. Authenticated HTTP snapshots can exceed it and still reach both snapshot callbacks. HTTP JSON is bounded separately by `policy.maxHttpResponseBytes` (2,097,152 bytes): the transport checks any declared Content-Length and counts actual streamed response bytes before decoding/parsing, cancelling an oversized body even when its length is absent or understated. The HTTP ceiling covers the complete response, including the private draft; changing the socket ceiling cannot disable HTTP fallback.

`DEFAULT_REALTIME_CLIENT_POLICY.reconciliationIntervalMs` centralizes the fallback interval (15,000 ms); override through the helper's `policy`. Polling continues during active rooms even with a healthy socket, and focus/online plus a one-shot deadline timer trigger GET. Polling stops after HTTP-confirmed completion. This is advisory convergence policy, not gameplay authority: canonical state, HTTP revision checks and native alarms remain correct when the helper is absent or the interval changes. Consumers render countdowns locally from deadline/server time; the server sends no periodic countdowns.

Transient reconnects use fresh tickets and jittered exponential backoff (500–30,000 ms), with a 10,000 ms initial-snapshot timeout. Client options centralize those values as well. Code 4001 (replacement) and policy closes disable automatic socket reconnect to avoid tabs fighting for slots; HTTP convergence continues. Credential failure stops transport. Call `resync()` directly for any additional application-driven refresh.

### Configurable limits and cleanup

Stage D extends the existing `STAGE_C_LIMITS` configuration name for compatibility:

| Keys | Defaults |
| --- | --- |
| `socketsPerParticipant`, `socketsPerRoom` | 3, 24 active sockets |
| `ticketLifetimeMs` | 30,000 |
| `ticketsPerMinute`, `ticketBurst` | 10, 3 per participant |
| `roomTicketsPerMinute`, `roomTicketBurst` | 60, 16 |
| `pendingTicketsPerParticipant`, `pendingTicketsPerRoom` | 4, 32 |
| `upgradesPerMinute`, `upgradeBurst` | 120, 32 per room |
| `snapshotBytes`, `socketMessageBytes` | 131,072; 1,024 |

At a participant's cap, a valid new connection replaces their oldest active socket (4001); room capacity never evicts another participant. All inbound application messages close with 1008, or 1009 above the byte bound, without parsing/echo. Outbound oversize/failure closes or refuses realtime; it cannot invalidate HTTP/game state. Existing edge bindings and queue bounds also apply.

Expired ticket rows are pruned on issuance, redemption, validated room access and existing alarms. Consumed rows are deleted immediately. Outstanding caps bound dormant storage until another access or room expiry. Ticket buckets use fixed room/authenticated-participant keys; they never consume successful gameplay/enrollment ceilings. No ticket housekeeping writes a lifecycle alarm, creates timers, or extends retention. Absent/retired-room upgrade attempts create no adapter rows.

See [architecture](../../docs/DRAFT_OFF_ARCHITECTURE.md), [Stage C verification](../stage-c/README.md) and [Stage D verification](../stage-d/README.md).

## Pre-merge remediation

The independent backend CI lane pins Node 24.22.0 and executes `npm run verify:backend`: root/A–D builds and typechecks, all 80 canonical fixture hashes, and sequential Stage A–E correctness including multiplayer smoke. V1 retains its independent Node 20 release gate. Ordinary tests write aggregate output under ignored `.generated/results/` and preserve the committed evidence.

Authenticated durable-bucket exhaustion is checked before canonical recovery, without writes or new authority; normal consumption remains atomic. Budget rejection can precede expiry/corruption recovery, while native alarms and admitted requests retain canonical lifecycle authority. Unsupported socket frames close immediately without the room queue. Targeted native tests cover cold throttling and a frame flood during a held queue.

`catalog.ts`'s Stage A import is a generated, data-only module of the committed content-addressed manifest/artifacts. No fixture/harness/control/runtime code is imported into production. Keep generated bundles server-only. See the [runbook](../stage-e/RUNBOOK.md#pre-merge-transport-and-abuse-safeguards) for client timeout/cooldown/correction behavior and remaining deployment gates.
