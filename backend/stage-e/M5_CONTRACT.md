# M5 client contract — existing `/api/draft-off/v1`

This freezes the existing Stage C/D transport for M5 integration. No M5/UI implementation is included. The executable authorities are `backend/cloudflare/contracts.ts`, `src/draftOffRoomTypes.ts`, `src/eraDraftTypes.ts` (draft views), `backend/client/draftOff.ts` and `backend/client/realtime.ts`. Changes to their transport semantics require a separate review.

## Enrollment and identity

Use `enrollGuest(apiOrigin, 'CREATE' | 'JOIN', roomCode | undefined, input, storage, transport?)`. Storage implements `getItem/setItem/removeItem`. CREATE input is `{displayName, eraId, draftMinutes?:10|15}` (default 15); JOIN input is `{displayName}`. Era IDs are `era-foundation`, `era-expansion`, `era-transition`, `era-modern-pre-impact`, `era-impact`. Names trim to 1–64 Unicode code points without control characters; M2 reserves case-insensitive names even after leave. A room starts with 2–8 joined participants.

The helper persists and reads back a random 32-byte unpadded base64url Enrollment-Key **before sending**. Keep the exact pending input/key through lost responses, storage failures and uncertain errors. Do not create another identity to recover a display name. Only explicit `ROOM_CODE_COLLISION` permits the helper to replace a CREATE key. On success it stores and reads back `{participantId,reconnectCredential}` under `draft-off:credential:{roomCode}`, then removes `draft-off:pending:{CREATE|JOIN}:{roomCode-or-empty}`. Preserve stable input serialization while recovery is pending. Instantiate separate storage contexts when testing multiple guests in one browser; this helper stores one guest credential per room/storage context.

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

For uncertain network/503 outcomes, retry the **same ID, command and expected revision**. Successful exact retries preserve the original receipt through hibernation/restart until expiry and may return `changed:true` with an old view. JSON field order is irrelevant to server fingerprints. Reusing an ID for another actor/input produces `COMMAND_ID_CONFLICT`. After a definitive rejection, GET and use a new ID for corrected intent. Negative-result exactness/conflict reservations last only while the bounded shared negative FIFO retains them (default 64); successful records are not evicted before room expiry. Honor 429 Retry-After (currently 60 seconds); retries still face request throttles.

Host alone starts; the server derives round/deadline from stored duration and execution time. Leave/rejoin are lobby operations; the host cannot leave. Socket disconnect has no membership effect. Draft exactly 11 locked positions, maximum four overseas, a keeper, no duplicate canonical player, one voluntary respin. `SUBMIT` requires `XI_COMPLETE` and freezes the XI. At the deadline complete legal XIs auto-submit, incomplete XIs become ineligible, and the server resolves. All manual submissions resolve early; client countdowns have no authority. Eligibility counts 2–8/1/0 yield CONTESTED/UNCONTESTED/NO_CONTEST.

## Views and realtime

`view` is `DraftOffRoomView`: `{roomId,revision,phase,participants,round,resolution?,myDraft?}`. Each participant row has only `{participantId,displayName,role,membershipStatus,roundStatus?}`. Round fields are `{roundId,roundOrdinal,label,eraId,phase,startedAtMs?,deadlineAtMs?}`. Resolution has `{trigger,contestStatus,resolvedAtMs,eligibleParticipantIds,ineligibleParticipantIds,leaderboard}`; leaderboard rows are `{rank,participantId,displayName,played,won,lost,points,netRunRate}`. Preserve optional absence. Timing is safe integer milliseconds; use `serverTimeMs` to estimate countdown offset.

Only authenticated HTTP includes the caller's optional `myDraft`, typed as `EraDraftPublicView`: SETUP, AWAITING_SPIN, AWAITING_PICK or XI_COMPLETE. Draft phases carry their own revision; active phases expose picks/status/era identity, with spin/candidates only in AWAITING_PICK. The host has no additional private visibility. Ratings, other XIs, submissions, seeds, saves, hashes, histories, receipts, detailed campaigns and evaluation/reveal payloads are outside this contract, including after completion. M5 can consume the shared leaderboard and own existing draft projection; richer final results need a separately approved contract extension.

Obtain a fresh socket ticket by authenticated HTTP, then connect:

```ts
new WebSocket(`${wsOrigin}/api/draft-off/v1/rooms/${roomCode}/realtime`,
  ['draft-off.v1', `ticket.${ticket}`]);
```

`wsOrigin` uses wss in staging/production. No token in the URL/query, Bearer header, Enrollment-Key, cookies or socket messages. Only `draft-off.v1` is negotiated. Default ticket lifetime is 30s; it is single-use, Origin/room/participant-bound and separate from reconnect/recovery credentials. Treat upgrade/acceptance uncertainty as consumed; obtain a fresh ticket. Do not persist tickets or log protocols/ticket bodies. Capacity rejection does not consume a ticket; a fresh ticket is still a safe reconnect choice.

Every server frame is `{version:1,type:'ROOM_SNAPSHOT',serverTimeMs,view:DraftOffPublicRoomView}`. Public view has the HTTP public fields above and **never myDraft**. Use `parseRoomSnapshot` for strict recursive validation. No client application messages are accepted. JOIN/LEAVE/REJOIN, START, submission and resolution may broadcast identical full public snapshots. SPIN/RESPIN/LOCK, old receipts, no-ops, presence and rejected commands do not broadcast. Revision gaps are valid. Delivery is best effort, without event replay or a durable outbox.

Use the existing `createDraftOffRealtimeClient({apiOrigin,roomCode,reconnectCredential,onSnapshot,onPublicSnapshot,onError?,...})`. Call `start()`, `observeCommand(replyBody)` after HTTP commands, `resync()` for caller-driven refresh and `stop()` on disposal/credential changes. Render private state only from authenticated `onSnapshot`; public callbacks must never replace it. The helper does GET → ticket/connect → initial socket snapshot → GET; it withholds stale in-flight reads below its monotonic revision floor and reconciles again. Historical receipt views must not be directly applied. Only current HTTP confirms completion.

Defaults: HTTP fallback 15s; reconnect jitter/backoff 500ms–30s; connect timeout 10s; focus/online and one deadline timer refresh. Realtime frame bound is 131,072 bytes; independent HTTP body bound is 2,097,152 bytes, enforced against declared and streamed bytes. Both are configurable client transport policy. Close 4001 (replaced) stops reconnect in that tab while HTTP fallback continues; 4004 means expired; 1008/1009 mean invalid/oversize client messages; 1011 is temporary realtime failure. Hibernation can preserve sockets; a process restart requires reconnect and GET.

## Errors, retention and privacy

Errors are `{ok:false,error:{code,message},roomRevision?,view?}` with safe fixed messages; registered command failures may include only the caller's view. Statuses: 400 malformed; 401 auth; 403 Origin/authority; 404 unavailable JOIN/unknown route; 405 method; 409 key/ID/revision/phase/capacity/deadline conflict; 413 size; 415 media; 422 incomplete/illegal draft; 429 limits; 503 configuration/temporary failure. Check codes, not message text. Distinguish `STALE_ROOM_REVISION`, `STALE_DRAFT_REVISION`, `COMMAND_ID_CONFLICT`, `ENROLLMENT_KEY_CONFLICT`, `ROOM_CODE_COLLISION` and `ROOM_CODE_UNAVAILABLE`. Authenticated missing/expired/wrong-room/invalid credentials share the same 401 body. The helper reports coarse transport errors through `onError`; never attach private payloads to reporting.

Lobby retention is creation +24h; completed retention is completion +7d. Expiry ends all credential/retry/recovery guarantees, removes private/auth/receipt/ticket state, and leaves a minimal retired-code marker for 30d from the fixed expiry anchor. Access never extends retention. There is no account, credential rotation, name-based recovery, settings edit, directory/list API, presence, socket command channel, spectator API or post-completion private-results endpoint.

M5 observability must redact/disable Authorization, Enrollment-Key, Sec-WebSocket-Protocol ticket values, ticket and enrollment response bodies, and private payloads in fetch wrappers, errors, traces, analytics and session replay. Production configuration remains a separate [deployment gate](RUNBOOK.md#future-staging-deployment-gates).
