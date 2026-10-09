# Draft-Off Cloudflare adapters — through Stage C

One SQLite-backed `DraftOffRoom` DO per canonical public invite code, routed with `ROOMS.idFromName(code)`. The DO ID, invite code, participant ID and reconnect credential are separate identities. Codes grant no participant authority. The DO HTTP handler remains closed; the Worker invokes only typed `publicOperation` for product HTTP. Legacy trusted actor RPCs are internal and never populated from browser actor fields.

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
| `GET /rooms/{code}` | Authorization: Bearer credential | 200: `{ok:true,roomCode,participantId,settings,view}` |
| `POST /rooms/{code}/commands` | Bearer plus envelope below | Original M3 success `{ok:true,changed,roomRevision,view?}` |

Lifecycle envelope: `{commandId,expectedRoomRevision,command:{type:"LEAVE"|"REJOIN"|"START"}}`. REJOIN maps to M3 JOIN without a name change. START derives the round ID and deadline from validated state, server time and stored duration. Deadline time is sampled in the serialized handler immediately before M3 execution; M3 independently timestamps execution. No client actor, timestamp, seed, round ID or deadline is accepted.

Participant envelope: `{commandId,expectedDraftRevision,command}`. Commands: `{type:"SPIN"}`, `{type:"RESPIN"}`, `{type:"SUBMIT"}`, or `{type:"LOCK_PLAYER",playerTeamSeasonId,battingPosition}`. Revisions are non-negative safe integers; positions are 1–11. Public IDs are 1–80 ASCII letters/digits/underscore/hyphen, excluding internal colon namespaces. Player-team-season IDs are trimmed, nonempty and at most 160 characters.

Names are trimmed, nonempty, at most 64 Unicode code points, with no control characters. M2 owns name reservation, membership, 2–8 joined participants, host authority and legality. Creation selects 10/15 minutes (default 15); no settings-edit route exists.

Errors: `{ok:false,error:{code,message},roomRevision?,view?}` with fixed safe messages. Statuses: 400 malformed; 401 uniform auth failure; 403 origin/authority; 404 unavailable JOIN/unknown route; 405 method; 409 enrollment, command-ID, revision, phase/capacity/deadline conflicts; 413 bytes; 415 media; 422 incomplete XI/draft legality; 429 limits; 503 configuration/temporary failure. Registered command errors can include only that actor's M3 view. Failed enrollment never supplies a view. Authenticated missing/nonexistent/expired/wrong-room credentials receive the same 401 body.

OPTIONS returns 204 without DO access for approved origin/method/headers. CORS reflects only exact allowed origins, varies on Origin, allows Content-Type/Authorization/Enrollment-Key, and exposes Retry-After/X-Request-Id. It does not enable credentialed CORS. Responses are private/no-store and nosniff.

## Enrollment and credentials

Enrollment-Key contains 32 random client bytes in canonical unpadded base64url. It is pending recovery material. The transport helper in `../client/draftOff.ts` verifies pending storage before sending, retains the key through uncertain failure, and deletes it only after storing and reading back the reconnect credential. A new CREATE key is generated only on explicit `ROOM_CODE_COLLISION`. This helper has no React UI integration.

CREATE derives a 12-character code from the first 60 bits of the full domain-separated digest using `0123456789ABCDEFGHJKMNPQRSTVWXYZ`. Codes normalize lowercase to uppercase. Stored full digests distinguish collisions from input reuse. Collision permits a new key; `ROOM_CODE_UNAVAILABLE` does not. No directory, probing or D1 exists.

Participant IDs are 128 server-random bits in lowercase hex, satisfying the existing M2 locale/byte roster-sort invariant without changing M2. Credentials are 256 independently server-random bits. Room-scoped SHA-256 verifiers map to immutable IDs. Fixed 32-byte comparisons use `crypto.subtle.timingSafeEqual`; equal/unequal/length-error behavior is verified in pinned workerd despite Node's ambient type omitting the extension.

Recovery stores an AES-256-GCM-sealed credential plus verifier, never plaintext tokens or Enrollment-Keys. HKDF-SHA-256 derives the wrapping key from the supplied Enrollment-Key. Authenticated context binds version, operation, room, participant and normalized request fingerprint; each seal uses a random 96-bit nonce. JSON field order does not affect retry fingerprints. Initial JOIN derives its command ID and current global CAS revision under the room queue, because unregistered guests cannot read snapshots.

Successful exact retry returns the original result/view without rejoining or advancing membership; GET synchronizes current state. Credentials survive leave/rejoin, start, submission and completion until room expiry. There is no rotation or name-based recovery. Rejected enrollment/command results replay exactly only while present in the bounded negative-result cache; after eviction they may be evaluated again against current state, and a rejected key/ID has no permanent input reservation. Successful keys/IDs are never evicted and retain their conflict protection until expiry.

## Storage, abuse and privacy

An optional companion callback writes adapter records inside the repository's existing state/receipt/wake/alarm transaction, before fault injection. CREATE commits settings, host auth and recovery; JOIN commits its result and successful auth; command translation/counts commit with receipts. START retries reuse the original expanded envelope/deadline. M1–M3 interfaces, saves and receipts are unchanged.

Adapter keys start with `api:`: create, settings, enrollment digests, verifier-indexed auth, command mappings, counts and buckets. Live canonical validation and expiry precede recovery. Auth verifies credentials before expensive restoration, then uses Stage B recovery. Every view comes from M3's safe projector or receipts. Legacy Stage B fixture rooms receive no retroactive credentials.

Edge limits are permissive/per-location. Durable room token buckets throttle new rejected/invalid/stale attempts; queue admission is bounded. `enrollmentRecords` counts successful CREATE/JOIN commits only, and `participantCommandIds` counts successful command receipts only (including successful no-ops). These lifetime ceilings still bound fresh successful admissions; existing successful exact retries bypass them, while request throttles still apply.

`negativeResultRecords` bounds one shared room-wide FIFO for rejected enrollment and command records (default 64). A rejected attempt never increments a success counter. Its adapter mapping/recovery result and M3 receipt enter the FIFO and are evicted together inside the same state/receipt/wake/alarm transaction. Successful records and deadline receipts never enter that FIFO. Thus rejected traffic cannot consume permanent gameplay/enrollment capacity, even across eviction/restart. Stored receipt/recovery rows are bounded by successful admission ceilings plus the shared negative ceiling; no per-attempt counter/index grows without bound. Canonical accepted history remains unchanged and bounded by successful admissions. Trusted Stage B RPC receipts keep their original semantics. Counters/eviction never alter alarms or retention.

Stage B still owns canonical replay, deadline finalization and atomic scheduling. Retention remains creation +24h, completion +7d, marker until expiry +30d. Expiry deletes all adapter/private/canonical records and receipts, retaining only the original minimal marker. Retry guarantees end at expiry. Scheduling hints remain advisory and cannot bypass canonical validation.

Logs contain only generated request ID, route template, status, stable error code and elapsed time. Raw URLs/headers/bodies, names, addresses, identities, tokens/verifiers, ciphertext, saves, seeds and exception strings are excluded. Production imports no test controls. WebSockets, Stage D, UI, accounts, deployment and global history remain absent.

See [architecture](../../docs/DRAFT_OFF_ARCHITECTURE.md) and [Stage C verification](../stage-c/README.md).
