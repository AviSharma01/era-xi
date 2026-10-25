# M5 client contract — existing `/api/draft-off/v1`

This freezes the existing Stage C/D transport for M5 integration. M5.1/M5.2 client integration and the additive M5.3 results endpoint are described below. The original transport remains unchanged. The executable authorities are `backend/cloudflare/contracts.ts`, `src/draftOffRoomTypes.ts`, `src/eraDraftTypes.ts` (draft views), `backend/client/draftOff.ts` and `backend/client/realtime.ts`. Changes to their transport semantics require a separate review.

## Enrollment and identity

Use `enrollGuest(apiOrigin, 'CREATE' | 'JOIN', roomCode | undefined, input, storage, transport?)`. Storage implements `getItem/setItem/removeItem`. CREATE input is `{displayName, eraId, draftMinutes?:10|15}` (default 15); JOIN input is `{displayName}`. Era IDs are `era-foundation`, `era-expansion`, `era-transition`, `era-modern-pre-impact`, `era-impact`. Names trim to 1–64 Unicode code points without control characters; M2 reserves case-insensitive names even after leave. A room starts with 2–8 joined participants.

The helper persists and reads back a random 32-byte unpadded base64url Enrollment-Key **before sending**. Keep the exact pending input/key through lost responses, storage failures and uncertain errors. Do not create another identity to recover a display name. Explicit `ROOM_CODE_COLLISION` replaces a CREATE key for collision recovery. A confirmed rejection (400 INVALID_REQUEST; 409 DISPLAY_NAME_RESERVED/PARTICIPANT_LIMIT/INVALID_PHASE; 413 PAYLOAD_TOO_LARGE; 404 ROOM_UNAVAILABLE) clears pending storage so the next corrected intent uses a fresh key. Unknown errors, key conflicts, ROOM_CODE_UNAVAILABLE, 429/503 and malformed responses preserve pending recovery. Only explicit ROOM_CODE_COLLISION automatically rotates a CREATE key for the same intent; ROOM_CODE_UNAVAILABLE is not collision evidence. An explicit user decision to abandon that unavailable CREATE attempt is required to start a different room. No automatic abandonment or new recovery API is added. On success it stores and reads back `{participantId,reconnectCredential}` under `draft-off:credential:{roomCode}`, then removes `draft-off:pending:{CREATE|JOIN}:{roomCode-or-empty}`. Response-side writes require the same stored pending key/input record; stale success/rejection/collision responses leave newer pending attempts and credentials unchanged. Success cleanup checks ownership again after credential storage/readback. Returned results may be historical; a stale response is returned without storage side effects. Preserve stable input serialization while recovery is pending. Instantiate separate storage contexts when testing multiple guests in one browser; this helper stores one guest credential per room/storage context.

| Route under `/api/draft-off/v1` | Headers/body | Success body |
| --- | --- | --- |
| `POST /rooms` | `Enrollment-Key`; CREATE input | 201 enrollment below |
| `POST /rooms/{code}/join` | `Enrollment-Key`; JOIN input | 201 enrollment below |
| `GET /rooms/{code}` | `Authorization: Bearer {reconnectCredential}`; no body | 200 `{ok:true,roomCode,participantId,settings:{draftMinutes},view,serverTimeMs}` |
| `POST /rooms/{code}/commands` | Bearer; command envelope below | 200 `{ok:true,changed,roomRevision,view?}` |
| `POST /rooms/{code}/socket-tickets` | Bearer; exact `{}` | 201 `{ok:true,ticket,expiresAtMs}` |
| `GET /rooms/{code}/realtime` | WebSocket upgrade, protocols below | 101 with protocol `draft-off.v1` |

Enrollment is `{ok:true,roomCode,participantId,reconnectCredential,settings:{draftMinutes},view}`. Successful exact recovery returns its original historical enrollment view; immediately GET for current state. Only enrollment responses expose the reconnect credential. Codes are 12 characters from `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, accepting lowercase input; use the returned uppercase code. Invite links carry only this code. A code or participant ID grants no authority.

Every product request requires an approved exact Origin. Browser fetch supplies it; use `credentials:'omit'`. POST uses `Content-Type: application/json` (optional UTF-8 charset only). No unknown fields, query strings, Content-Encoding, client timestamps, actor IDs, seeds or deadline overrides. Do not mix Enrollment-Key and Bearer auth. HTTP replies are `private, no-store`; CORS allows Content-Type/Authorization/Enrollment-Key and exposes Retry-After/X-Request-Id. Configure the API base at the origin root; the helpers resolve absolute `/api/draft-off/v1/...` paths.

## Commands and retry discipline

Lifecycle envelope:

```ts
{ commandId, expectedRoomRevision: currentView.revision,
  command: { type: 'LEAVE' | 'REJOIN' | 'START' } }
```

Participant envelope:

```ts
{ commandId, expectedDraftRevision: currentView.myDraft.revision,
  command: { type: 'SPIN' | 'RESPIN' | 'SUBMIT' } }
// or command: { type:'LOCK_PLAYER', playerTeamSeasonId, battingPosition:1 /* 1–11 */ }
```

Do not send `roomId`, participant ID or global revision in participant commands. Lifecycle CAS uses the global revision; private draft CAS uses only the caller's draft revision. Other participants' progress may advance global revision without invalidating a draft command. Serialize one participant's new commands locally. Command IDs are room-wide, 1–80 `[A-Za-z0-9_-]` characters; generate a fresh random ID per new intent to avoid cross-participant collisions. Revisions are nonnegative safe integers. Select canonical player-team-season IDs and available positions from `myDraft.candidates`; never derive identity, overseas status or legality in the client.

For uncertain network/503 outcomes, retry the **same ID, command and expected revision**. Successful exact retries preserve the original receipt through hibernation/restart until expiry and may return `changed:true` with an old view. JSON field order is irrelevant to server fingerprints. Reusing an ID for another actor/input produces `COMMAND_ID_CONFLICT`. After a definitive rejection, GET and use a new ID for corrected intent. Negative-result exactness/conflict reservations last only while the bounded shared negative FIFO retains them (default 64); successful records are not evicted before room expiry. Honor 429 Retry-After (currently 60 seconds); retries still face request throttles. The realtime helper shares that cooldown across polling, ticket acquisition, reconnect and explicit resync, accepts seconds/HTTP-date values, and uses 60 seconds for absent/invalid headers. No new requests start during cooldown; existing sockets remain advisory.

Host alone starts; the server derives round/deadline from stored duration and execution time. Leave/rejoin are lobby operations; the host cannot leave. Socket disconnect has no membership effect. Draft exactly 11 locked positions, maximum four overseas, a keeper, no duplicate canonical player, one voluntary respin. `SUBMIT` requires `XI_COMPLETE` and freezes the XI. At the deadline complete legal XIs auto-submit, incomplete XIs become ineligible, and the server resolves. All manual submissions resolve early; client countdowns have no authority. Eligibility counts 2–8/1/0 yield CONTESTED/UNCONTESTED/NO_CONTEST.

## Views and realtime

`view` is `DraftOffRoomView`: `{roomId,revision,phase,participants,round,resolution?,myDraft?}`. Each participant row has only `{participantId,displayName,role,membershipStatus,roundStatus?}`. Round fields are `{roundId,roundOrdinal,label,eraId,phase,startedAtMs?,deadlineAtMs?}`. Resolution has `{trigger,contestStatus,resolvedAtMs,eligibleParticipantIds,ineligibleParticipantIds,leaderboard}`; leaderboard rows are `{rank,participantId,displayName,played,won,lost,points,netRunRate}`. Preserve optional absence. Timing is safe integer milliseconds; use `serverTimeMs` to estimate countdown offset.

Only authenticated HTTP includes the caller's optional `myDraft`, typed as `EraDraftPublicView`: SETUP, AWAITING_SPIN, AWAITING_PICK or XI_COMPLETE. Draft phases carry their own revision; active phases expose picks/status/era identity, with spin/candidates only in AWAITING_PICK. The host has no additional private visibility. Ratings, other XIs, submissions, seeds, saves, hashes, histories, receipts, detailed campaigns and evaluation/reveal payloads remain outside the existing room/bootstrap/realtime payloads, including after completion. The separately approved M5.3 endpoint below adds only the selected-entry results whitelist.

Obtain a fresh socket ticket by authenticated HTTP, then connect:

```ts
new WebSocket(`${wsOrigin}/api/draft-off/v1/rooms/${roomCode}/realtime`,
  ['draft-off.v1', `ticket.${ticket}`]);
```

`wsOrigin` uses wss in staging/production. No token in the URL/query, Bearer header, Enrollment-Key, cookies or socket messages. Only `draft-off.v1` is negotiated. Default ticket lifetime is 30s; it is single-use, Origin/room/participant-bound and separate from reconnect/recovery credentials. Treat upgrade/acceptance uncertainty as consumed; obtain a fresh ticket. Do not persist tickets or log protocols/ticket bodies. Capacity rejection does not consume a ticket; a fresh ticket is still a safe reconnect choice.

Every server frame is `{version:1,type:'ROOM_SNAPSHOT',serverTimeMs,view:DraftOffPublicRoomView}`. Public view has the HTTP public fields above and **never myDraft**. Use `parseRoomSnapshot` for strict recursive validation. No client application messages are accepted. JOIN/LEAVE/REJOIN, START, submission and resolution may broadcast identical full public snapshots. SPIN/RESPIN/LOCK, old receipts, no-ops, presence and rejected commands do not broadcast. Revision gaps are valid. Delivery is best effort, without event replay or a durable outbox.

Use the existing `createDraftOffRealtimeClient({apiOrigin,roomCode,reconnectCredential,onSnapshot,onPublicSnapshot,onError?,...})`. Call `start()`, `observeCommand(replyBody)` after HTTP commands, `resync()` for caller-driven refresh and `stop()` on disposal/credential changes. Render private state only from authenticated `onSnapshot`; public callbacks must never replace it. The helper does GET → ticket/connect → initial socket snapshot → GET; it withholds stale in-flight reads below its monotonic revision floor and reconciles again. Historical receipt views must not be directly applied. Only current HTTP confirms completion.

Defaults: HTTP request timeout 10s (`policy.requestTimeoutMs`, covering fetch and full body consumption); HTTP fallback 15s; reconnect jitter/backoff 500ms–30s; connect timeout 10s; focus/online and one deadline timer refresh. Realtime frame bound is 131,072 bytes; independent HTTP body bound is 2,097,152 bytes, enforced against declared and streamed bytes. Both are configurable client transport policy. Close 4001 (replaced) stops reconnect in that tab while HTTP fallback continues; 4004 means expired; 1008/1009 mean invalid/oversize client messages; 1011 is temporary realtime failure. Hibernation can preserve sockets; a process restart requires reconnect and GET.

## Errors, retention and privacy

Errors are `{ok:false,error:{code,message},roomRevision?,view?}` with safe fixed messages; registered command failures may include only the caller's view. Statuses: 400 malformed; 401 auth; 403 Origin/authority; 404 unavailable JOIN/unknown route; 405 method; 409 key/ID/revision/phase/capacity/deadline conflict; 413 size; 415 media; 422 incomplete/illegal draft; 429 limits; 503 configuration/temporary failure. Check codes, not message text. Distinguish `STALE_ROOM_REVISION`, `STALE_DRAFT_REVISION`, `COMMAND_ID_CONFLICT`, `ENROLLMENT_KEY_CONFLICT`, `ROOM_CODE_COLLISION` and `ROOM_CODE_UNAVAILABLE`. Authenticated missing/expired/wrong-room/invalid credentials share the same 401 body. The helper reports coarse transport errors through `onError`; never attach private payloads to reporting.

Lobby retention is creation +24h; completed retention is completion +7d. Expiry ends all credential/retry/recovery guarantees, removes private/auth/receipt/ticket state, and leaves a minimal retired-code marker for 30d from the fixed expiry anchor. Access never extends retention. There is no account, credential rotation, name-based recovery, settings edit, directory/list API, presence, socket command channel, spectator API or public/spectator results endpoint. The additive authenticated results endpoint below has narrower locked-round access.

M5 observability must redact/disable Authorization, Enrollment-Key, Sec-WebSocket-Protocol ticket values, ticket and enrollment response bodies, and private payloads in fetch wrappers, errors, traces, analytics and session replay. Production configuration remains a separate [deployment gate](RUNBOOK.md#future-staging-deployment-gates).

## M5.1 client integration note

The original `backend/client/draftOff.ts` and `backend/client/realtime.ts` exports remain compatibility entrypoints. Their M4-compatible implementations now live in `src/draftOffEnrollmentClient.ts` and `src/draftOffRealtimeClient.ts`, with transport-only types shared through `src/draftOffClientTypes.ts`. HTTP routes, envelopes, projections and realtime semantics above are unchanged. The frontend adds a bounded fetch adapter shared by enrollment, reconciliation, tickets and journaled commands, enforcing coordinated Retry-After cooldown without changing the M4 helper defaults. Command replies remain historical receipts: only authenticated reconciliation publishes room/private state. Enrollment offers an optional synchronous UI handoff after verified credential storage and before pending cleanup; it rechecks current persisted ownership before activation, and callers that omit the handoff retain M4 behavior. M5.1 adds no gameplay controls or results contract.

## M5.2 UI integration note

The player-facing room consumes the same M4 HTTP/WebSocket projections and M5.1 session controller. New session fields describe pending action/retry feedback only. The countdown is a presentation estimate anchored to `serverTimeMs` and monotonic browser elapsed time; reaching zero does not resolve or submit locally. Public updates reconcile through authenticated HTTP. The lobby, manual submission, waiting and leaderboard add no routes, envelopes, domain rules or additional private visibility. Reused V1 player presentation is independent of both mode controllers. The historical proposal in [M5.2 handoff](M5_2_HANDOFF.md) is superseded by the approved additive M5.3 extension below; the original room/realtime payloads remain frozen.

## M5.3 authenticated results extension

`GET /api/draft-off/v1/rooms/{code}/results/{participantId}` is the only new route. Its exact version-1 success/error types are in `src/draftOffResultsTypes.ts`; `src/draftOffResultsClient.ts` recursively validates the success allowlist. No changes to any existing endpoint payload, command receipt, public snapshot, WebSocket frame or retry contract are implied.

The request uses the existing room-bound Bearer credential, approved exact Origin, bodyless GET validation and no query/Enrollment-Key. Target participant IDs use `p_[a-f0-9]{32}`. All normal edge limits apply; results and room GET consume the **same** durable participant READ bucket (default 60/minute, burst 10), including pre-replay rejection. Responses remain private/no-store. Logs contain the route template, never concrete participant paths or private bodies.

The success allowlist is `{ok:true,version:1,roomCode,roundId,roundOrdinal,eraId,participantId,displayName,players,evaluation,campaign}`. `players` contains exactly eleven `RevealPlayerView` rows plus existing `historicalStats`, ordered by positions 1–11. `evaluation` is the existing explicit `TeamEvaluationSummaryView`. `campaign.aggregate` copies the nine authoritative fields: played/won/lost/points/runsFor/ballsFacedForNrr/runsAgainst/ballsBowledForNrr/netRunRate. `campaign.matches` contains exactly twenty ordered rows: `{matchId,sequence,opponent:{profileId,teamName,seasonYear},firstInnings,secondInnings,outcome,resultType,margin}`. Each innings is `{side:'ENTRY'|'OPPONENT',runs,wickets,balls,allOut}`. Outcome is WIN/LOSS relative to the inspected entry; runs/wickets margins are positive integers, Super Over margin is null and its scores remain regulation innings. No Super Over scorecard is fabricated.

All keys are required. Nullable existing ratings/statistics and historical era-best summaries are preserved. Roster status is INDIAN/OVERSEAS only. The independent results ceiling is 2,097,152 serialized UTF-8 bytes, matching the existing client HTTP bound; server oversize/inconsistency fails safely with 503 and no truncation. No raw states, seeds, hashes, receipts, auth data, other campaigns or evaluator internals are returned.

| Gate | Result |
| --- | --- |
| Invalid/missing/wrong-room/expired credential or unavailable room | Existing indistinguishable 401 AUTHENTICATION_FAILED |
| Registered viewer, current round not resolved | 409 RESULTS_NOT_READY before any target lookup |
| Resolved, viewer outside locked roster or target not eligible | Identical 404 RESULT_UNAVAILABLE |
| Resolved, locked entrant viewing an eligible submitted XI | 200; includes viewers with an incomplete/ineligible XI |
| Missing eligible campaign/submission, corrupt replay or projection inconsistency | Safe 503 TEMPORARY_UNAVAILABLE |

Host/member access is identical. LEFT-at-start members retain only their existing room/leaderboard access; they cannot inspect details. NO_CONTEST has no inspectable target; UNCONTESTED retains its full single-entry campaign. Errors carry only `{ok:false,error:{code,message}}`, never a room view or revision. New fixed messages are “Results are not ready.” and “Result is unavailable.” Normal Origin/syntax/throttling gates can reject first.

The service projects the frozen submission and the canonical restored resolution. Existing restoration still replays the resolver; no additional evaluation or simulation is invoked by results construction. Existing overdue recovery resolves before the new route checks readiness. Retention anchors, native alarms, saves, hashes and catalog/version validation are unchanged; no migration or result-cache infrastructure was added.

The session lazily fetches selected entries through its existing transport, retaining at most eight validated responses in memory. Identity checks use room/round/era/target and active session ownership, with cancellation on obsolete selections/disposal; immutable resolved results need no room-revision field. Leaderboard metrics are cross-checked, never recalculated. Access failure removes displayed results and clears the session cache. See [M5.3 handoff](M5_3_HANDOFF.md) for implementation and validation evidence.

## M5.4 client recovery hardening

Reconciliation performs at most two immediate GETs per flight, retaining its monotonic revision floor. Repeated stale replies then yield to the existing HTTP fallback; focus/online, command and socket reconciliation remain available. Disposal inside a snapshot callback cannot rearm deadline timers or publish further callbacks.

The browser session verifies its existing persisted credential before requests and private publication, and on storage/focus events. Missing, replaced or unreadable access stops the old session, cancels requests and removes its private snapshot/results cache; the journal and replacement credentials are preserved. Authentication failure also clears private state while retaining an already published final public leaderboard. Recovery after a credential change requires reloading with the current stored access; there is no cross-tab command coordinator or credential-rotation API.

A verified command receipt permits cleanup recovery when storage deleted the journal before throwing. Only that same immutable envelope can be retried; another session's different record is never deleted. The acknowledgment flag is memory-only, with no journal/save schema change. Existing 429 cooldown, 503 uncertainty, exact idempotency, deadlines, results authorization and production route contracts are unchanged. See the [M5.4 matrix and handoff](M5_4_HANDOFF.md).

## M5.5 comparison and usability note

The resolved-room UI now offers individual results or a comparison of two distinct eligible leaderboard entries. Both selections use the existing authenticated `loadResults` session API and its in-memory cache, request cancellation, identity validation, shared cooldown and access invalidation. Only locked round entrants, including incomplete entrants, can open it; fewer than two eligible submissions cannot be compared. Switching result views does not persist private results or add requests for already cached entries.

Comparison preserves server ranks and campaign aggregates. Players align by locked batting position; fixtures align by sequence, match ID and canonical opponent profile, including recurring opponents. A mismatched schedule fails closed. Each XI independently faces the shared historical schedule; comparison introduces no direct match between entrants, local ranking, evaluation or simulation. Regulation innings and winner-relative Super Over verdicts use the same presentation as individual results.

Placement, locked-XI, player-inspection and submission dialogs display the existing presentation countdown. Zero remains a server-checking state, never a local submission/resolution. Sticky modal headers, focus restoration, pending feedback, touch controls, narrow-layout stacking and reduced-motion rules are presentation only. The shared V1 inspector accepts an optional countdown; V1 callers omit it and retain existing behavior. No HTTP, realtime, persistence, authority, deadline or solo contract changes are part of M5.5.
