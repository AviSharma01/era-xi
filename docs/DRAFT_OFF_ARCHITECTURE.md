# Draft-Off Architecture

Implemented through M1/M1.1 (competitive simulation), M2 (competition domain), M3 (provider-independent authoritative room service), and M4 Stages A–E (local backend verification and M5 handoff). Stage D supplies advisory realtime through hibernating WebSockets, on Stage C's guest HTTP authentication and Stage B's durable persistence/alarm lifecycle. Stage A and its indexed feasibility optimizations remain the runtime baseline. M5.1 supplies room entry, authenticated bootstrap and journaled commands; M5.2 supplies playable timed drafting and the leaderboard; M5.3 adds selected-entry authenticated results browsing. Deployment remains deferred. See the [Stage E report](../backend/stage-e/results/report.md), [M5 client contract](../backend/stage-e/M5_CONTRACT.md), and [local/future staging runbook](../backend/stage-e/RUNBOOK.md). The gameplay decision record is [DRAFT_OFF_GAMEPLAY_VALIDATION.md](DRAFT_OFF_GAMEPLAY_VALIDATION.md).

## Frozen simulation contract

`src/draftOffSimulation.ts` and `src/draftOffTypes.ts` own the competitive simulation contract:

- A round's explicit challenge seed, catalog fingerprint, era, and ordinal derive one shared draft-opportunity seed and one shared schedule seed.
- Every eligible XI faces the same deterministic 20-match schedule in the same order. Scheduling uses the selected era's full frozen opponent pool, shuffled in complete cycles with a possible final partial cycle and no immediate opponent repeats.
- Approved Model B gives each distinct XI deterministic match variance. Gameplay XI identity uses historical selections in batting-position order, catalog fingerprint, era, and simulation/evaluation versions; each fixture's scenario seed combines with that identity to derive its simulation seed.
- The same XI and fixture reproduce the same result. Participant identity, display name, timestamps, lifecycle metadata, and draft history do not influence simulation randomness or performance outcomes.
- Standings reuse existing points and authoritative NRR calculation, rank by points then full-precision NRR, and share rank for exact ties. Participant ID only stabilizes row order within a tie.

Venue effects, bowling-family/phase penalties, tuning, ratings, historical data, and solo Era Draft behavior remain outside this contract change. `simulateDraftOffChallenge` retains its 2–8-entry contract; `simulateDraftOffEntries` shares the same implementation and permits M2's single eligible entry.

## Domain model and lifecycle

`Competition → Round → Participant → Submission → Resolution`

`src/draftOffCompetitionTypes.ts`, `src/draftOffCompetition.ts`, and `src/draftOffCompetitionInvariants.ts` define readonly, versioned state and the pure `createDraftOffCompetition` / `reduceDraftOffCompetition` API.

| Entity | States and ownership |
| --- | --- |
| Competition | `LOBBY → IN_PROGRESS → COMPLETE`; owns participant registry, ordered rounds, revision, genesis, and accepted history. |
| Round | `PENDING → DRAFTING → RESOLVED`; owns era, challenge seed, derived seeds, locked roster, start/deadline, private drafts, and resolution. |
| Membership | `JOINED ↔ LEFT` for members during the lobby; immutable participant IDs and fixed `HOST` / `MEMBER` roles. |
| Round participant | `DRAFTING → SUBMITTED` or, at deadline, `DRAFTING → INELIGIBLE`; terminal states cannot modify their XI. |

Lobby members may join, leave, and rejoin using the same ID. Display names are trimmed, non-empty, and unique across the entire registry using `trimmedName.toLowerCase()`. Leaving reserves the name; rejoining restores the stored identity and name. The host cannot leave. Only the host can start, with 2–8 joined participants; start locks the roster.

Each entrant receives a separate private Era Draft state initialized from the same round `draftRootSeed` with the era already chosen. `APPLY_DRAFT_COMMAND` delegates only `SPIN`, `RESPIN`, and `LOCK_PLAYER` to the existing Era Draft reducer, requires the expected private draft revision, and preserves authoritative legality/invariants. Membership and round state have no connection/presence dependency.

## Submission and deadline semantics

Commands receive explicit non-negative safe-integer millisecond timestamps. Accepted timestamps are nondecreasing; M2 has no wall-clock scheduler. Draft commands and new manual submissions are allowed during `startAtMs ≤ atMs < deadlineAtMs`.

- `SUBMIT_XI` accepts only the participant's complete legal `XI_COMPLETE` state. It freezes that state with submission source/time, canonical draft-state hash, and the shared M1 submission hash. There is no replacement, withdrawal, or post-submission editing.
- The last manual submission resolves the round atomically with trigger `ALL_SUBMITTED`.
- `FINALIZE_ROUND` rejects before the deadline. At or after it, existing submissions remain intact, complete legal XIs auto-submit with effective time `deadlineAtMs`, and incomplete drafts become `INELIGIBLE / INCOMPLETE_AT_DEADLINE`.
- Repeated submission/finalization returns unchanged success once submitted/resolved, subject to the common timestamp validation. Rejected commands and unchanged retries do not enter accepted history or increment revision.
- Simulation completes before the next authoritative state is published, so failures leave the previous state intact. Submitted XIs and resolutions are deeply frozen.

| Eligible XIs | Resolution |
| --- | --- |
| 2–8 | `CONTESTED`: normal M1/M1.1 campaigns and leaderboard. |
| 1 | `UNCONTESTED`: full 20-match campaign and rank 1, explicitly marked uncontested. |
| 0 | `NO_CONTEST`: null challenge result and empty leaderboard. |

Resolution records its trigger/time, eligible and ineligible IDs, immutable challenge result where applicable, leaderboard, and canonical resolution hash. Metadata-bearing artifact hashes may change with identity/presentation data; gameplay seeds and outcomes do not.

## Domain persistence and replay

`src/draftOffCompetitionPersistence.ts` exposes `serializeDraftOffCompetition`, `restoreDraftOffCompetition`, `replayDraftOffCompetition`, and `canonicalDraftOffCompetitionStateHash`.

The canonical save contains version fields, genesis, accepted command events, and the expected state hash. Restoration strictly parses the format, rejects catalog/version drift, and replays through the same reducer. Replay reconstructs private drafts, submissions, and results, validates recorded events, and checks the final canonical hash. Derived campaign results are recomputed rather than trusted from a saved snapshot. Restored state is deeply frozen.

The M2 save format remains provider-independent and domain-only. M3 adds the separate repository and service boundary below without changing that format.

## M3 authoritative room service

`src/draftOffRoomService.ts` wraps M2 without modifying its lifecycle or simulation. `src/draftOffRoomTypes.ts` defines trusted caller identities, service command envelopes, safe views, receipts, and the injected clock contract. `src/draftOffRoomRepository.ts` supplies the atomic repository contract, an in-memory implementation, and a deterministic fake clock. `src/draftOffRoomProjection.ts` owns participant-facing projections.

### Repository and canonical restoration

Each room record stores only canonical M2 serialization and an idempotency receipt ledger. Every service repository read or transaction restores through `restoreDraftOffCompetition`, including reads of duplicate-command receipts. Room IDs must match the restored competition ID. There is no authoritative mutable state cache; canonical restore/replay correctness takes precedence over optimization.

In-memory transactions serialize operations for one room and permit independent rooms to proceed concurrently. State and receipts commit together only after the transaction callback succeeds. Exceptions leave the prior record unchanged and release the queue. Rejected commands and no-ops can add receipts without advancing M2's revision. Repository records and service responses are deeply frozen. The repository is an internal trusted boundary and must never be exposed to participants.

### Commands and revisions

| Service command | Required concurrency check | Authority |
| --- | --- | --- |
| `JOIN`, `LEAVE`, `START` | `expectedRoomRevision` equals current M2 revision | Self join/rejoin/leave; host start |
| `SPIN`, `RESPIN`, `LOCK_PLAYER`, `SUBMIT` | `expectedDraftRevision`, checked by M2 | Caller’s own rostered participant |
| Deadline finalization | Current state inside the transaction | Internal system only |

All public commands include `roomId` and `commandId`. Participant-local envelopes have no room-revision field: unrelated entrants can draft concurrently from the same observed room version. Same-participant races remain protected by M2's nested draft revision. Global M2 revision still versions persistence and appears in reads and responses for synchronization.

Service envelopes are validated for exact fields and copied before entering the asynchronous queue. Caller-supplied target participant IDs, actor IDs, timestamps, finalization commands, or extra revision fields are rejected. The service derives actor identity from a trusted `PARTICIPANT` context; authenticating that context belongs to a future adapter. Host/member permission checks happen at the service boundary, while phase, roster locking, draft legality, nested revision, submission, and deadline behavior remain M2's responsibility.

Within a transaction, the service restores M2, checks command receipts, applies lifecycle CAS when appropriate, authorizes, and reduces through M2. `atMs` comes from the clock at execution, after restoration. If a clock predates the latest accepted timestamp (including a restored save), the effective timestamp is clamped to that timestamp to preserve M2's nondecreasing-time contract. Clock values must be non-negative safe-integer milliseconds.

### Retries and failures

Command IDs are unique across a room. A canonical fingerprint includes actor identity and the entire envelope, including the relevant expected revision. Identical retries return the original receipt, even when its view is older than the current room. Clients use a fresh read to synchronize and a new command ID after correcting rejected input. Reusing an ID for different input returns `COMMAND_ID_CONFLICT` and never reveals another actor's receipt.

Accepted, unchanged, domain-rejected, authorization-rejected, and stale-revision outcomes receive receipts. Structurally invalid envelopes and invalid actors are rejected before transaction execution. Exceptions before transaction commit do not create a success receipt. A response lost after commit, including a failure in subsequent scheduling reconciliation, is recovered by exact retry. Receipts remain unbounded for M3; retention belongs to later storage integration. The `deadline:` command-ID namespace is reserved for internal finalization.

Simulation remains synchronous inside M2's atomic transition. A failure during final submission or deadline resolution publishes no partial submission or result. The optional runtime dependency exists for deterministic fault injection in tests; the default runtime is the unmodified M2 implementation.

### Clock and service restoration

`DraftOffClock` supplies `nowMs()` and cancellable `scheduleAt()`. The fake clock advances explicitly, delivers due callbacks in deadline/registration order, awaits callback completion, and propagates failures. Advancing to a later time means callbacks observe that actual later execution time. No sleeps or wall-clock timers are used in tests.

`createRoom` constructs a lobby through M2. `restoreRoom` imports a validated canonical M2 save into a new record with an empty receipt ledger. `resumeRoom` restores an existing record, preserving its receipts. A restarted service retains retry guarantees only when using the same repository; importing the M2 save alone cannot recover M3 command IDs.

Scheduling reconciliation runs under the room transaction lock. Active future deadlines arm one callback per service instance; overdue restoration finalizes immediately. Early all-submitted resolution cancels the timer after commit. A deterministic internal command ID prevents duplicate finalization. At the exact deadline, M2 closes manual submission and draft commands, even if their execution precedes timer delivery. Early/spurious callbacks do not reserve the internal command ID.

Call `dispose()` to release an old service instance's timers before replacing it, then `resumeRoom` for each known room. A failed timer callback leaves state and receipt unchanged and surfaces the failure to the clock caller; `resumeRoom` safely retries overdue finalization. There is no retry loop or provider-specific scheduler in M3.

### Privacy and deferred presentation

Registered participants can read public membership/round status, timing, global revision, and only their own draft through `projectEraDraftPublicState`. Host privileges do not grant access to other private drafts. Shared resolution exposes contest status and a leaderboard summary without submission/campaign hashes or simulation internals. Canonical competition state, accepted history, save data, seeds, other entrants' picks/candidates, frozen submissions, XIs, evaluations, and detailed campaigns never leave participant-facing service methods.

M3's conservative room projection remains unchanged. M5.3 below adds post-resolution XI, evaluation and campaign exposure through a separate authenticated endpoint restricted to locked-round entrants.

M3 remains provider-independent. Its Cloudflare persistence and clock adapters are implemented in M4 Stage B below; public HTTP routes, WebSockets, real authentication, UI, and deployment remain deferred.

## M4 Stage B: durable persistence and alarm lifecycle

`backend/cloudflare/room.ts` provides one SQLite-backed `DraftOffRoom` Durable Object per room, addressed with `ROOMS.idFromName(roomId)`. Room creation verifies the object identity. The object's operation queue serializes commands, reads, recovery, creation, and alarms. `backend/cloudflare/repository.ts` implements the existing M3 atomic repository contract using the SQLite-backed storage KV API, with its own transaction queue for direct trusted repository callers. At the Stage B boundary the Worker and object's HTTP handlers returned 404. Trusted actor RPCs remain internal; they are not authentication. Stage C adds a separate adapter boundary below; the object's HTTP handler remains closed.

### Storage and the atomic scheduling boundary

| Stored key | Contents |
| --- | --- |
| `descriptor` | Versioned canonical room ID and selected era; persisted with room creation. |
| `competition` | Unmodified canonical M2 save bytes; no derived authoritative snapshot. |
| `receipt:<commandId>` | Exact M3 fingerprint and original result, including original participant view. |
| `wake` | Derived scheduling metadata: deadline, lobby expiry, or completed-room expiry, with authoritative logical time. |
| `retired` | After expiry only: room ID, expiry time, and bounded marker purge time. |

`src/draftOffRoomLifecycle.ts` projects phase and timing facts from validated M2 state. M3 supplies this optional advisory hint on repository creation and transaction results, including receipts, rejected commands, no-ops, restoration, and deadline reconciliation. It is separate from the repository record and canonical save format. Older repositories may ignore it. Every durable commit strictly restores/replays the exact canonical bytes being committed, whether a hint is supplied or not. The shared projector reuses only an immutable data-only hint whose exact fields, phase, and time match that restored state; missing, stale, wrong-phase, wrong-time, malformed, and accessor-bearing hints are ignored and replaced. Hint reuse saves projection allocation only; it never skips canonical validation or grants the hint scheduling authority.

One storage transaction commits changed canonical bytes, receipt changes, the lifecycle wake derived from restored state, and the native alarm. START therefore cannot publish a deadline without its receipt and durable alarm. The adapter never parses accepted history to infer lifecycle, applies a domain command, or decides who submits/resolves. Failed callbacks or writes roll back the whole transaction; exact retries recover committed receipts through M3. The scheduling hint on an old receipt retry reflects the current validated room, not the historical view in that receipt; a mismatching hint supplied by another trusted caller is repaired before the alarm is committed.

The adapter uses Cloudflare's [SQLite transaction API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#transaction); [alarms](https://developers.cloudflare.com/durable-objects/api/alarms/) share that storage boundary. Native storage remains the source of canonical bytes and receipts. Every M3 read/transaction, even an exact retry, still restores through the canonical replay validator. Corrupt saves, room-ID mismatch, catalog drift, and version mismatch fail closed. No restored state, command results, or feasibility results are cached. The catalog loader reuses Stage A's verified content-addressed era artifacts and eagerly built minimum-cost index.

### Clock, eviction, overdue recovery, and alarm delivery

`backend/cloudflare/clock.ts` bridges real `Date.now()` to M3's cancellable callback registration. Callback registration is in memory; the repository persists the native alarm independently in the state transaction. Constructors do not overwrite an alarm. A cold request or alarm loads the descriptor, verifies/builds the scoped catalog, reconstructs M3, and calls `resumeRoom`; this strictly restores canonical state, retains receipts, and resolves an overdue deadline through M3. Warm access also resumes an overdue room if native delivery was missed. Restart requires neither a browser connection nor an imported save.

A warm native alarm delivers M3's due callback. Cold, early, duplicate, or repeated delivery resumes M3 instead. M3's reserved deterministic deadline receipt and canonical reducer remain responsible for idempotency and exact deadline behavior. An early alarm never reserves that receipt; the repository re-arms the authoritative future wake. Failures propagate to the native handler for provider retry; there is no adapter retry loop. A repeated delivery after resolution only reconciles retention, with no new submission, resolution, or deadline receipt.

The final pre-deadline submission continues to resolve atomically with `ALL_SUBMITTED`. Its commit replaces the obsolete deadline alarm with completed-room expiry; M3 then cancels its in-memory deadline callback. At/after the deadline, overdue recovery runs M3 before participant access, so late manual submissions cannot become pre-deadline submissions.

### Retention and retired markers

The approved storage policy is fixed: lobby expiry is creation + 24 hours; completed-room expiry is authoritative completion + 7 days. Reads, retries, membership changes, and repeated alarms do not extend either anchor. Drafting rooms use their deadline as the wake; completed expiry replaces it. Retention is storage housekeeping, not a new M2 phase or gameplay transition. Every warm access and every destructive room expiry transaction restores canonical state again, derives phase/time through the shared projector, and repairs wake/alarm metadata before deciding whether expiry is due. A premature stored wake cannot delete a live room; a later/wrong-kind wake cannot extend retention or postpone overdue recovery. Corrupt canonical bytes fail closed before cleanup. After verified expiry removes the canonical payload, the minimal retired marker retains the verified expiry anchor for its final bounded purge.

At expiry, one transaction removes canonical/private payloads, all receipts, descriptor, and wake, and retains only a minimal retired marker with purge time expiry + 30 days. The same named room object refuses recreation during that interval. A native alarm deletes the marker at its bound; cold access also prunes overdue markers. Late expiry delivery does not extend the bound and creates no marker if that bound already passed. Repeated expiry/purge delivery is harmless. This is local lifecycle storage only: no global code allocator, enrollment, reconnect credentials, or future Stage C directory has been added. Exact-retry guarantees end when the room expires.

### Verification and implemented boundary

`backend/stage-b/` is a separate local-only integration entry point. Its explicit fixture binding, loopback guard, fixture actors, imports, epoch offsets, inspection, corruption, and fault injection never enter the production Worker bundle. It reuses Stage A's exact pinned Miniflare/workerd dependencies, SQLite configuration, compatibility date, fixtures, and independent-connection HTTP measurement helper. Generated bundles and SQLite state remain ignored/temporary. No Cloudflare resource or deployment configuration is created.

Native tests cover creation/eviction, all-era canonical restoration and exact receipts, state/receipt/alarm rollback, atomic START, participant races, restore-first corruption failures, client-free warm/cold deadlines, early/duplicate/repeated alarms, failed deadline commit recovery, warm/cold overdue recovery, final pre-deadline submission, early resolution, alarms after resolution, process restart with the same SQLite directory, retention anchors, expiry-on-access, autonomous expiry/purge, and bounded retired-code reuse. Existing M1–M3 and Stage A tests remain authoritative. A small sequential matched latency check is retained in `backend/stage-b/results/`; it does not rerun the full Stage A matrix.

Stage B stops here. Stages C–E, public authentication/enrollment, HTTP product API, WebSockets/realtime, rate limiting, UI, and deployment remain outside the implemented boundary.

## M4 Stage C: guest enrollment and HTTP authentication

The Worker exposes four strict `/api/draft-off/v1` routes for CREATE, JOIN, authenticated GET and commands. The DO validates room-scoped reconnect verifiers before constructing M3 participant actors. Enrollment generates identities internally; browsers never supply actors, participant IDs, seeds, timestamps or deadline/finalization commands. GET reconnects without changing membership; authenticated REJOIN delegates to M3 JOIN with the stored identity/name.

CREATE maps the first 60 bits of a secret Enrollment-Key digest to a 12-character unambiguous base32 invite code and directly to the named DO. Stored full digests distinguish true collisions and conflicting input. A collision explicitly permits a new key; uncertainty retries the same key. No directory, D1 or automatic probing exists. IDs are 128 server-random bits in lowercase hex (compatible with existing roster sorting); credentials are 256 server-random bits.

Enrollment-Key is pending recovery material, not routine auth. The transport helper verifies its storage before sending and removes it after verified reconnect-credential storage or an allowlisted definitive rejection; uncertain failures preserve the original key/input. The server persists a verifier plus AES-GCM-sealed recovery copy, with an HKDF wrapping key derived from the supplied Enrollment-Key and room/operation/participant/input-bound context. Plaintext tokens and Enrollment-Keys are not stored. Exact retry returns the original enrollment result/view, surviving eviction/restart; it does not rejoin a LEFT participant. Credentials remain valid until room expiry.

A Cloudflare-only companion callback writes settings, enrollment/auth and command mappings inside the existing canonical-state/receipt/wake/alarm transaction. START's server-derived envelope/deadline commits with its receipt and is reused on retry. JOIN derives its internal command ID and current global CAS revision under the room queue. Lifecycle commands retain global revisions; drafting/submission retains private revisions. M1–M3 and Stage B scheduling/retention semantics remain unchanged. Expiry deletes all adapter records, leaving the original bounded minimal marker. Retry guarantees end at expiry.

Origin checks use exact configured frontend origins; requests have strict schemas/media/streamed byte limits. Limits are centralized/configurable adapter safeguards. Native edge controls are permissive/per-location; durable room buckets throttle rejected/stale attempts, while lifetime ceilings count only successful commits. Successful retries survive those ceilings and remain durable until expiry. Rejected enrollment/command mappings and receipts share one bounded FIFO, evicted atomically through the adapter companion; their exact replay/conflict guarantee lasts only while cached, after which they may be re-evaluated. Rejections cannot permanently consume successful admission capacity. M3 source and trusted Stage B receipt semantics remain unchanged. Failures expose fixed safe codes/messages. Views come only from M3's safe projections/receipts; host authority grants no opponent-private access. Logs allow only generated request IDs, route templates, status/code and elapsed time.

`backend/stage-c/` verifies production HTTP, response-loss/client-storage recovery, spoofing/wrong-room/expired auth, native constant-time comparison, privacy, atomic rollback, restart, corruption, lifecycle/revision contracts, configurable limits, all eras and a small eight-player HTTP smoke. Test controls remain in the separate loopback bundle. Full contracts/configuration are in [the adapter README](../backend/cloudflare/README.md). Stage C stops before WebSockets, realtime, UI, accounts or deployment.

## M4 Stage D: advisory hibernating WebSockets

HTTP remains authoritative for enrollment, authenticated private snapshots and all commands. `POST /rooms/{code}/socket-tickets` authenticates the existing reconnect credential and issues a random, single-use ticket, valid for 30 seconds by default. The room persists only a separately domain-separated verifier, room, authenticated participant, issuing Origin and bounded expiry. A storage transaction consumes that verifier under the existing room queue; no browser participant ID is accepted. Tickets do not create M3 receipts or gameplay history. Invalid/wrong-room/expired/reused tickets fail uniformly.

The browser offers `['draft-off.v1', 'ticket.' + ticket]` to the bare `/rooms/{code}/realtime` URL. Worker and DO independently validate exact Origin, route and protocol structure. Only `draft-off.v1` is negotiated; credentials and tickets never appear in URLs, and the offered ticket value is not echoed. This passed in the pinned workerd with actual headless Chrome, including delivery over the same socket after forced hibernation. There is no query-string fallback. Ticket headers are excluded from application logs and must remain excluded from any later deployment header/body capture; no deployed observability settings or resources were created.

`projectDraftOffPublicRoom` explicitly constructs the common public whitelist: room phase/revision, public membership/round status, round timing, and the existing conservative resolution/leaderboard summary. `ROOM_SNAPSHOT` wraps it with `version:1` and server time. The private projector composes the same fields with only the caller's `myDraft`; regression hashes captured from the committed Stage C implementation preserve private JSON across eight fixture states after excluding only the additive pick count, including other optional fields and field order. A fresh server timestamp is added outside `view` on GET, never to stored enrollment results or command receipts. Neither sockets nor the public projector expose any draft, picks/candidates, XIs, submissions, seeds, hashes, receipts or simulation internals.

The Cloudflare repository's optional observer runs after successful transaction completion, never inside its retryable callback. It receives the already-validated next state only when canonical bytes changed. With open sockets, public-content comparison excludes revision and timestamp: JOIN/LEAVE/REJOIN, START, changed submission and resolution broadcast once; SPIN/RESPIN, rejected/no-op commands and old receipt retries do not. Committed LOCK_PLAYER commands now broadcast the additive numerical pick count described below. One serialized snapshot gives every connected participant identical bytes. Deadline/alarm and overdue-access commits use the same observer. A final submission emits one resolved snapshot. Send failures cannot roll back authoritative commits or interrupt scheduling reconciliation. A crash can lose a notification; no durable outbox or event replay exists.

Sockets use `ctx.acceptWebSocket`, runtime enumeration and versioned identity/connection attachments. No in-memory connection registry is needed. Hibernation discards the service and its callback registrations; existing descriptor/catalog/canonical replay and native alarms reconstruct them, including client-free overdue resolution. Runtime-held sockets and their attachments can survive hibernation; process restart requires reconnect. Closure never changes M2/M3 membership. Default limits permit three sockets per participant and 24 per room, replacing only that participant's oldest socket at their cap. Replacement code 4001 disables automatic reconnect in that tab, preventing replacement loops while retaining HTTP convergence. Expiry closes sockets and removes tickets with all other adapter state, retaining the original minimal retired marker.

The UI-independent client helper uses GET → ticket/connect → initial snapshot → GET, keeps public and private revisions separate, discards stale callbacks/messages and fetches again when revisions race. Global revision gaps are valid. Only HTTP supplies private state, and historical receipt views never replace newer state. `DEFAULT_REALTIME_CLIENT_POLICY` centralizes the configurable 15-second fallback HTTP reconciliation interval, reconnect/backoff and initial-snapshot timeout. Focus/online and a one-shot deadline timer also resync. This is convergence policy, not gameplay authority; game correctness does not depend on polling or socket delivery. Countdown rendering uses authoritative timing locally; no server countdown stream is added.

Ticket issuance/upgrade buckets, pending ticket caps and message bounds are configurable adapter safeguards. Expired tickets are opportunistically removed on validated room access, issuance, redemption and existing alarms; consumed tickets are deleted immediately. Dormant rows remain bounded and disappear at room expiry. No ticket cleanup, socket lifecycle or polling policy can create/replace a native lifecycle alarm or extend retention. Absent/retired-room upgrade attempts write no new adapter records. All inbound application messages close the socket without command dispatch or echo; no chat or spectator path exists.

`backend/stage-d/` contains native workerd/SQLite/WebSocket tests, deterministic client synchronization tests, a production-isolation/eight-player smoke and a separate optional Chrome protocol probe. It reuses Stage A's exact runtime/tool pins. Test clocks, storage controls and probe servers never enter production. Full contracts and limits are in [the adapter README](../backend/cloudflare/README.md); verification is in [Stage D](../backend/stage-d/README.md). Stage D stops before Stage E, M5/UI, accounts or deployment; historical data, game rules, simulation and Stage B scheduling/retention semantics remain unchanged.

## Batch 1 public pick progress

The shared public whitelist includes only `lockedPickCount` beside each round entrant's existing status. The count is `draftState.picks.length`, never a mutable counter or a draft-revision/spin estimate. A new round begins at zero; completed submissions remain eleven; incomplete deadline entries retain their actual count. Non-entrants and pending lobbies have no count. The existing participant list renders the count beside status without a layout change.

Because `samePublicContent` compares this shared projection after commit, each successful LOCK_PLAYER sends one identical snapshot to all connected participants. Private SPIN/RESPIN and rejected, stale, duplicate or replayed commands produce no progress notification. The normal observer also handles submission and deadline recovery. HTTP and initial/reconnected socket snapshots use the same projector after validated canonical restoration, covering hibernation and restarts without new stored state or polling.

The session consumes validated public snapshots directly into `publicSnapshot`, independently of its authenticated `snapshot`. The roster uses the newest matching-round public view; `myDraft`, private controls, results transitions and pending-command confirmation use only HTTP. The realtime helper tracks a public revision and a required private HTTP floor separately. Only increasing counts for known opponents with otherwise identical public metadata bypass GETs. Own-entry changes, lifecycle/roster/timing changes, missing legacy counts, initial/reconnected sockets and local command receipts still require HTTP. Older HTTP can refresh or confirm private state without overwriting newer public information. Receipt reconciliation is awaited once, rather than issuing a second GET. The bounded 15-second fallback and production read/admission limits are unchanged. The independent eight-session native regression uses all default policies; the earlier 64-admission test override has been removed.

This is an additive HTTP/public-frame extension for both historical v1 Mirror and v2 rooms. Canonical engine/state/save versions, deterministic replay, RNG, simulations, fixture hashes and idempotent receipts are unchanged. The Stage A fixture builder explicitly omits the additive field from its frozen historical receipt views; all 80 original fixture hashes remain the verification gate. The strict client validates counts as integers 0–11 and tolerates absence in older responses/receipts; it never infers progress from private state or treats historical receipt views as current. Frontend and backend must ship together because older strict clients reject unknown fields. The socket subprotocol and frame version's existing format distinction remain unchanged. Delivery remains advisory: a crash can lose a notification, and existing GET/reconnect/fallback reconciliation restores progress.

## Future multi-round compatibility

Competition state stores an ordered round collection. Each round independently owns its seed, era, roster, deadline, private drafts, submissions, and result; participant IDs can persist across rounds while draft states start fresh.

This structure accommodates a future Last XI Standing sequence such as Qualifying → Round 1 → Round 2 → Round 3 → Final. M2 executes one normal Draft-Off round and exposes no next-round/advancement command, elimination rules, advancement set, or Last XI Standing UI. Backend, realtime, and presentation integration belong to later milestones.

## Pre-merge transport remediation

M4's transport helpers now bound HTTP fetch/body consumption and share Retry-After cooldowns across reconciliation and reconnection. Definitive enrollment rejection permits corrected input without sacrificing uncertain-outcome recovery. Exhausted authenticated durable buckets reject before canonical recovery through a read-only check, and unsupported socket frames bypass the gameplay queue to close immediately. These safeguards add no game authority or save-format change. The [runbook](../backend/stage-e/RUNBOOK.md) specifies precedence and remaining deployment limits. A separate pinned backend CI lane runs A–E correctness, retaining the independent V1 release gate and immutable historical evidence.

## M5.3 selected-entry results

The additive authenticated `GET /api/draft-off/v1/rooms/{code}/results/{participantId}` projects one eligible frozen submission and its authoritative twenty-match campaign after canonical resolution. Every locked-round entrant may inspect eligible entries, including entrants whose own XI was incomplete. Members LEFT at START receive no detailed access. Existing room views, socket frames and receipts are unchanged; there is no spectator endpoint or bulk results bundle.

`draftOffResultsProjection.ts` consumes restored state and the verified room catalog; it never invokes evaluation or simulation. A small shared whitelist in `eraDraftProjection.ts` maps an already authoritative evaluation to existing reveal/player/strength summaries. Solo reveal output remains identical. Canonical restoration continues to reconstruct campaigns by replay and check the full state hash; the save format, durable lifecycle, retention and version compatibility are unchanged.

`draftOffResultsClient.ts` validates the exact response recursively. The existing session shares its transport, READ quota/cooldown and credentials, deduplicates selected-entry requests and keeps at most eight results in memory. Active-session plus room/round/participant identity rejects stale replies without a room revision. The room displays the existing final leaderboard, selected submitted XI/player inspector, team evaluation and twenty regulation score summaries with authoritative outcomes. No two-XI comparison, M5.4 recovery changes or local simulation was added.

The reviewed endpoint types and matrix are in [M5 contract](../backend/stage-e/M5_CONTRACT.md#m53-authenticated-results-extension), with verification evidence in [M5.3 handoff](../backend/stage-e/M5_3_HANDOFF.md).

## M5.4 recovery hardening

The existing session invalidates private state when authenticated access is lost or its persisted credential changes. Browser storage/focus events and checks at request/publication boundaries stop the obsolete session without changing another tab's credentials or command journal. An already published final public leaderboard remains visible on authentication failure. A verified receipt allows retry/cleanup recovery after an interrupted journal deletion, preserving the original command envelope and ownership checks.

The realtime helper bounds each immediate reconciliation flight to two GETs, yielding repeated stale responses to its existing fallback timer. Snapshot callbacks that dispose the session cannot rearm timers. These are client reliability changes; backend authority, routes, receipts, canonical persistence, rate limits and simulation remain unchanged. The [M5.4 handoff](../backend/stage-e/M5_4_HANDOFF.md) records the failure matrix, native recovery tests and validation boundaries.

### M5.5 comparison and interaction refinement

Resolved round entrants can compare two eligible submitted XIs through the same authenticated results loader and eight-entry session cache. The result browser's selection/session-scoped loading hook is shared with comparison; each selection cancels obsolete work and suppresses late responses. Session invalidation still removes all private detail and stops requests. Existing cooldown subscriptions govern retries; comparison adds no polling, endpoint or persisted cache.

The view pairs locked batting positions and the twenty ordered fixture identities, preserving exact server ranks, full authoritative campaign aggregates, evaluations and Super Over semantics. Mobile layouts stack A and B within each position/fixture rather than separating whole teams. It explicitly explains that entries play independent campaigns against the same opponents. Section links return to participant selection after inspecting long campaigns. An unexpected schedule mismatch blocks the comparison.

The room's presentation clock is also visible in player inspection, XI review and submission dialogs. Modal headers retain the clock when scrolling; native dialog focus/inertness and focus restoration are preserved. Pending placement feedback, minimum touch controls, long-name wrapping, reduced motion and short-height/narrow-screen reflow remain scoped to Draft-Off. The V1 inspector's optional countdown is omitted by solo callers. See [M5.5 handoff](../backend/stage-e/M5_5_HANDOFF.md) for validation and review evidence.

## Varied and Mirror formats (competition v2)

This section records the v2 format contract. New public rooms now use the v4
Evaluation V3 contract below, retaining the Standard caps introduced in Batch 2.

New public CREATE requests default to `VARIED`; hosts may explicitly select `MIRROR`.
The selected format is immutable room configuration in `genesis.format`, not a draft
command or an editable setting. It is exposed in new rooms' `round.format` and
`settings.format` from creation through results. The existing room/results UI adds
only a creation selector, explanatory copy, invite details and a room-bar label.
Varied opportunities can be unequal in an individual round; no quality balancing,
forced uniqueness or compensation is applied.

The existing seed bundle remains `ipl-draft-off-seeds/v1`, byte-for-byte. Mirror
uses its shared `draftRootSeed`. Varied derives each actual root with canonical
SHA-256 over `{version: "ipl-draft-off-participant-seeds/v1", domain:
"participant-draft-opportunities", roomDraftSeed, participantId}`. Only the existing
room draft seed and immutable server-issued participant ID enter this derivation.
Names, roster order/size, timestamps and transport activity do not. The unchanged
Era Draft engine owns normal spins, respins, legality, recovery and nested replay.
The format policy is pinned by competition engine v2; changing its derivation
requires a new engine contract, not silently changing the v2 implementation.

Format-aware competitions use engine/state/save `/v2`. The constructor consumes
canonical genesis: missing format explicitly denotes historical v1, not the public
CREATE default. Restoration validates matching version triples and requires format
in v2 genesis; v1 forbids it. Every existing v1 state, including pending lobbies,
continues through the original mirrored path with no inserted keys or rewritten
hashes. New explicit Mirror rooms have v2 metadata but reproduce the historical
private drafts and gameplay outcomes for equivalent inputs. No database or Durable
Object descriptor migration is required. The 80 Stage A fixtures and historical
Stage A–E evidence remain unchanged; new seed/state vectors live separately in
`src/draftOffFormat.test.ts`.

HTTP paths stay under `/api/draft-off/v1`. Their format-aware extension requires
`format: VARIED | MIRROR` in both settings and projected round metadata for new
rooms; legacy responses retain exact field absence. Strict updated clients accept
both shapes and reject unknown formats, extra fields and inconsistent settings.
`ROOM_SNAPSHOT.version` is 2 for new rooms (requires `round.format`) and remains 1
for legacy rooms (forbids that field). The ticket/authentication subprotocol remains
`draft-off.v1`; no credential or socket-attachment version changes are needed.
Old clients are not expected to understand new rooms; deploy frontend and backend
together before public activation rather than adding unused API migration routes.

An omitted CREATE format remains omitted in the enrollment fingerprint. This
preserves exact recovery of historical lost CREATE replies; only genuinely new
room creation applies the Varied default. Explicit format is part of request
identity, so changing it while retrying an enrollment key is a conflict.

`GET /rooms/{code}/invite` is an additive, unauthenticated metadata-only endpoint
for the pre-enrollment join screen. It returns exactly `{ok:true, version:2,
roomCode, eraId, draftMinutes, format}`; historical rooms explicitly report Mirror
here without changing their saved state. It requires the approved Origin, rejects
credentials/query/body/content encoding, uses existing edge request/enrollment
limits plus a bounded durable invite bucket before replay, and returns private,
no-store responses. Unknown/expired rooms return the existing 404 unavailable
error. It exposes no roster, phase, deadline, seed, draft, result or credential.
Existing authenticated room/results authorization and privacy remain intact.

The shared twenty-fixture schedule, XI evaluation, XI-specific residual variance,
submission/result hashing, leaderboard rules, retention and exact command retry
semantics retain their existing versions. Identical ordered XIs still receive the
same match outputs regardless of format, identity or draft history.

## Batch 2 Standard tier caps (competition v3)

Every new public Draft-Off room uses the fixed Standard preset in
`src/draftOffRules.ts`: at most three S-tier picks and six S+A picks combined.
B/C/D have no caps. Varied and Mirror share this policy; CREATE, JOIN and commands
accept no cap or preset customization. Existing keeper, four-overseas, canonical
uniqueness and locked-position requirements still apply.

The public CREATE adapter copies the effective `{maxS, maxSA}` values into
`genesis.tierCaps` through the provider-independent room service. Genesis with
format plus caps selects competition engine/state/save `/v3`. The canonical
constructor remains an explicit-genesis API: absence of caps selects the original
v1/v2 behavior, including historical lobbies that start after this release. It
never supplies today's defaults during construction or restoration. Stored cap
values are validated structurally rather than compared with the current preset,
so changing the preset affects only subsequently created public rooms. There is
no edit-rules command or storage migration. v3 requires both format and effective
caps; v1/v2 saves forbid caps. Mixed version triples, missing/extra fields and
changed genesis hashes fail restoration.

The owning competition passes its stored caps to Era Draft legality, reducer,
invariants and private projection at every boundary. This includes initialization,
LOCK_PLAYER, SPIN/RESPIN, deterministic dead-spin recovery, manual submission,
deadline auto-submission and canonical replay. Rejected locks do not advance
picks, revisions, history or RNG; normal immutable rejection receipts still apply.
`S_TIER_LIMIT` and `SA_TIER_LIMIT` distinguish direct limits from
`FUTURE_XI_IMPOSSIBLE` when a currently affordable pick would prevent completion.

The capped completion solver selects actual variants of distinct canonical players
under the remaining S, S+A and overseas budgets, reserving a confirmed canonical
keeper when needed. Its multiple-choice dynamic program keeps those costs coupled;
independently minimizing tier and overseas costs could invent a historical variant
that never existed. An exact zero-cost filler witness avoids the dynamic program
for ordinary full-era catalogs. Catalog-only option indexes are weakly cached;
no draft state or player selections are cached. Existing positional rules permit
any undrafted player in any open slot; fit remains a soft factor. Future completion
is existential across the era, with spin recovery guaranteeing access to a viable
team-season. It does not guarantee an equally strong XI or an available voluntary
respin when the discarded team is the sole viable team.

The nested Era Draft state shape/version and RNG domains remain unchanged: it is
owned and replayed under the v3 competition policy. Standalone Solo saves retain
the original uncapped contract. `replayEraDraftState` accepts an explicit policy
for diagnostics of nested drafts; authoritative room restoration always replays
the competition genesis and accepted commands. No simulation, rating, fit penalty,
boost, submission identity, leaderboard or fixture contract changes are included.

Both public and authenticated room views expose only the effective values in
`round.tierCaps`, from lobby through results. HTTP routes and settings stay the
same; socket `ROOM_SNAPSHOT.version` is 3 for capped rooms, 2 for historical
format-aware rooms and 1 for legacy Mirror. Updated strict clients validate all
three shapes and reject cross-version fields or malformed caps. Frontend/backend
must ship together for new rooms. Invite metadata remains its existing version-2
whitelist. Private candidates receive the same authoritative availability/reasons
as LOCK_PLAYER; the existing candidate gallery and placement controls already
render these messages accessibly, so no visual redesign is required. Opponent
progress remains only `lockedPickCount`; tier usage, identities, candidates,
positions, ratings, seeds and private drafts remain absent from public snapshots.

Batch 2 evidence lives in `src/draftOffTierCaps.test.ts` and
`backend/m5-tier-caps.test.mjs`: cap combinations, independent exhaustive scarcity
checks, keeper/overseas/variant coupling, capped recovery, 240 seeded legal XIs
across five eras and both formats, v1/v2 uncapped continuation, v3 replay, retries,
restart/reconnect, strict socket privacy and deadlines. The existing 80 frozen
Stage A fixtures and Solo release checks remain independent verification gates.

The [Batch 2 review handoff](../backend/stage-e/BATCH_2_STANDARD_TIER_CAPS_HANDOFF.md)
lists changed files, verification outcomes and remaining integration limits.

## Batch 3 Evaluation V3 (competition v4)

New public Standard rooms pin `teamEvaluationVersion: "ipl-era-draft-team-evaluation/v3"`
in genesis alongside format and effective tier caps. This selects matching
competition engine/state/save v4 and nested Solo engine v2/state v3. Historical
v1/v2/v3 rooms retain V2 evaluation through continuation and canonical replay,
including pending lobbies and deadline resolution. Constructor field absence
always selects the historical contract; restore never fills current defaults.

V3 applies 0/5/12/20/30% individual batting deductions with a 20 contribution
floor and no team-wide cap. Bowling, quality tiers, legality, Standard caps,
frozen opponents and simulation coefficients are unchanged. Structural boosts
remain deferred. Gameplay XI identity uses the pinned evaluator version;
round/draft/schedule seeds and submission identity keep their existing contracts.

New public frames use version 4 with the evaluation identifier. Authorized
resolved results use envelope v2 and whitelisted batting-adjustment diagnostics;
historical result responses remain byte-identical v1. There are no new routes,
credentials, host options or UI layouts. Strict clients support both generations.
See [Evaluation V3](EVALUATION_V3.md) for formulas, calibration, compatibility,
fixtures, verification and the release/rollback procedure.
