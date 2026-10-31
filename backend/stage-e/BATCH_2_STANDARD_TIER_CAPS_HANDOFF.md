# Batch 2 review handoff: Standard Draft-Off tier caps

Implemented on `feat/draft-off-standard-tier-caps`. No commit, push, merge or deployment.

## Assessment and implementation

The existing v1/v2 genesis determines deterministic nested drafts and canonical
replay. Applying new defaults during restoration would change historical accepted
commands, spin recovery and state hashes. New public CREATE therefore supplies an
explicit immutable `{maxS: 3, maxSA: 6}` from `src/draftOffRules.ts`, selecting a
new competition engine/state/save v3 contract. The stored effective values govern
the room for its lifetime; the preset is never consulted during replay. Historical
v1/v2 constructors and saves retain the uncapped path, including pending lobbies.
Varied and Mirror share the same policy. Public inputs reject customization.

Tier classification uses `player.quality.overall.qualityTier` for the selected
player-team-season. The owning competition passes its stored rules through the
shared Era Draft reducer, invariants and projection, including creation/start,
locking, spin/respin recovery, submission, deadlines and replay. Nested draft state
and Solo save versions remain unchanged; nested diagnostic replay can receive the
owning policy explicitly. No simulation, ratings, positional penalties, boosts,
leaderboard rules or frozen fixtures changed.

The capped feasibility solver chooses actual historical variants of distinct
canonical players under the remaining S, combined S+A and overseas budgets, with
a remaining keeper if required. Its exact resource dynamic program prevents
independent minima from inventing nonexistent variants. An exact zero-cost filler
witness handles ordinary full-era catalogs quickly. Only immutable catalog options
are cached. Current position rules permit any player at any free slot; no new
position-fit restriction is introduced.

Effective rules are whitelisted in public/authenticated `round.tierCaps`. Socket
snapshots use v3 for capped rooms; v1/v2 shapes retain exact field absence. HTTP
paths, settings, invite metadata, credentials and retry envelopes are unchanged.
Existing candidate and placement controls render the new authoritative reasons;
no UI redesign was needed. Opponent progress remains the locked-pick count, with
no player, position, tier-use, rating or seed disclosure.

## Changed files

Paths below are repository-relative.

| Area | Files |
| --- | --- |
| Preset and exact completion | `src/draftOffRules.ts`, `src/eraDraftTierCaps.ts`, `src/eraDraftTierFeasibility.ts` |
| Shared draft boundaries | `src/eraDraftLegality.ts`, `src/eraDraftEngine.ts`, `src/eraDraftInvariants.ts`, `src/eraDraftProjection.ts`, `src/eraDraftReplay.ts`, `src/eraDraftTypes.ts` |
| Versioned competition | `src/draftOffCompetitionTypes.ts`, `src/draftOffCompetition.ts`, `src/draftOffCompetitionInvariants.ts`, `src/draftOffCompetitionPersistence.ts` |
| Room service/projections | `src/draftOffRoomTypes.ts`, `src/draftOffRoomService.ts`, `src/draftOffRoomProjection.ts` |
| Client and public adapter | `src/draftOffRealtimeClient.ts`, `backend/cloudflare/room.ts`, `backend/cloudflare/realtime.ts` |
| Tests and gates | `src/draftOffTierCaps.test.ts`, `backend/m5-tier-caps.test.mjs`, `backend/m5-formats.test.mjs`, `package.json` |
| Documentation | `docs/DRAFT_OFF_ARCHITECTURE.md`, `docs/DRAFT_OFF_GAMEPLAY_VALIDATION.md`, `docs/PRODUCT_SPEC.md`, `backend/stage-e/M5_CONTRACT.md`, this handoff |

The existing native legacy test now explicitly removes both newer genesis fields
when reconstructing v1. No historical fixture baseline was updated.

## Validation

- Focused capped regression suite: all 19 tests passed on the final indexed implementation; the broader focused engine/room/client/legacy run also passed (113 tests).
- Release suite: all 408 tests passed, including the final keeper-reservation and historical uncapped-continuation regressions.
- 240 completed seeded XIs across five eras and both formats, including elite-first/mixed choices and late respins; no impossible completion or cap violation.
- 160 deterministic scarce catalogs matched an independent exhaustive distinct-player oracle, including feasible and impossible cases.
- Boundary combinations, unchanged state on illegal locks, capped dead-spin recovery, exhausted respin preservation, keeper/overseas/variant coupling, immutable effective values and strict version rejection covered.
- Manual submission, deadline auto-submission, incomplete deadline exclusion, persistence/reconnect, exact command retries, canonical replay and public privacy covered in domain/native tests.
- `verify:release`: PASS (408 tests, production build/smoke and Solo validation).
- `verify:backend`: PASS on the final indexed build (130 backend tests; all 80 canonical fixture hashes unchanged). Stage E observe-mode latency checks reported no budget violations on this final run.
- `git diff --check`: PASS.

An initial eight-player production smoke lost a local socket during replay. The
completion fast path now uses indexed catalog counts rather than repeated scans;
both the isolated eight-player regression and the full final backend gate passed
after optimization. No limits, timeouts or latency budgets were changed.

The sandbox initially blocked localhost binding for native tests and the web smoke;
the full verification commands were rerun with approved loopback access.

## Review and remaining limits

Frontend and backend must ship together for new v3 room snapshots; older strict
clients cannot read that shape. This work stops before independent review and
release. Validation is local, with no deployed latency/quota claim. The seeded
sample establishes feasibility rather than balance or equal Varied opportunities.
Existential completion does not promise an equally strong XI or a voluntary respin
when the discarded team is the only viable team-season.
