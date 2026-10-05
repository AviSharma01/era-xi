# Draft-Off Architecture

Implemented through M1/M1.1 (competitive simulation), M2 (competition domain), and M3 (provider-independent authoritative room service). Draft-Off backend transport, realtime integration, UI, and deployment are not implemented yet. The gameplay decision record is [DRAFT_OFF_GAMEPLAY_VALIDATION.md](DRAFT_OFF_GAMEPLAY_VALIDATION.md).

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

Richer post-resolution XI, evaluation, and campaign exposure remains part of the Draft-Off vision and is deferred to a later product/UI milestone. M3's conservative projection is not a removal of that direction.

M3 adds no Cloudflare/Durable Objects, database, HTTP routes, WebSockets, real authentication, UI, or deployment code. These adapters remain outside this milestone.

## Future multi-round compatibility

Competition state stores an ordered round collection. Each round independently owns its seed, era, roster, deadline, private drafts, submissions, and result; participant IDs can persist across rounds while draft states start fresh.

This structure accommodates a future Last XI Standing sequence such as Qualifying → Round 1 → Round 2 → Round 3 → Final. M2 executes one normal Draft-Off round and exposes no next-round/advancement command, elimination rules, advancement set, or Last XI Standing UI. Backend, realtime, and presentation integration belong to later milestones.
