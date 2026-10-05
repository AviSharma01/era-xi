# Draft-Off Architecture

Implemented through M1/M1.1 (competitive simulation) and M2 (competition domain). Draft-Off backend, realtime rooms, UI, and deployment are not implemented yet. The gameplay decision record is [DRAFT_OFF_GAMEPLAY_VALIDATION.md](DRAFT_OFF_GAMEPLAY_VALIDATION.md).

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

This is provider-independent serialization/replay only: no repository/database abstraction, storage adapter, HTTP API, WebSocket, authentication, or realtime infrastructure is present.

## Future multi-round compatibility

Competition state stores an ordered round collection. Each round independently owns its seed, era, roster, deadline, private drafts, submissions, and result; participant IDs can persist across rounds while draft states start fresh.

This structure accommodates a future Last XI Standing sequence such as Qualifying → Round 1 → Round 2 → Round 3 → Final. M2 executes one normal Draft-Off round and exposes no next-round/advancement command, elimination rules, advancement set, or Last XI Standing UI. Backend, realtime, and presentation integration belong to later milestones.
