# Draft-Off Varied / Mirror implementation handoff

Branch: `feat/draft-off-varied-seeding`.
Base: verified `main` / `origin/main` at `da390d43ec90289cbc5f17197d4cabd0d142bcfb`.
No commit, push, merge, deployment, dependency addition or database migration.

## Gameplay and authority

- New API rooms default to Varied; creation may explicitly choose Mirror.
- Room format is immutable canonical genesis configuration. There is no edit command.
- Varied roots use canonical SHA-256 with `ipl-draft-off-participant-seeds/v1`,
  `participant-draft-opportunities`, the existing room draft seed and server-issued
  immutable participant ID. Names, ordering, roster size, timestamps and clients
  cannot select the root. Chance overlaps are allowed.
- Mirror passes the existing room root through unchanged. The existing normal,
  respin, feasibility and recovery engine remains unchanged in both formats.
- Shared twenty-fixture schedule, authoritative evaluation, XI-specific match
  variance, NRR, leaderboard and all simulation/seed-bundle versions are unchanged.

## Exact compatibility decisions

- Explicit format in genesis selects competition engine/state/save v2. The current
  canonical-genesis constructor still recognizes absent format as historical v1;
  the public API applies the Varied default before constructing new rooms.
- V1 saves remain v1, with no added keys or hash rewrite. Pending v1 rooms start
  Mirror. V2 parsers require format and reject mixed versions and unknown fields.
- Historical omitted-format CREATE fingerprints remain unchanged. Lost historical
  replies recover their original identity, credentials, settings and v1 view.
- New HTTP settings and `round` carry format; legacy shapes retain field absence.
  Socket frames are version 2 with format for new rooms, version 1 without format
  for legacy rooms. Paths and ticket subprotocol remain v1. Results and command
  envelopes are unchanged. Updated clients strictly validate both room shapes.
- Frontend/backend should ship together: older clients need not understand new
  format-aware rooms, because Draft-Off has not been publicly released. No API
  migration router or SQL migration was introduced.
- The additive public `GET /rooms/{code}/invite` exposes only version, code, era,
  draft time and format. Approved-Origin checks, existing edge limits, a durable
  pre-replay rate bucket, strict credential/body/query rejection and no-store
  headers apply. Unknown codes leave no durable bucket records. Private drafts,
  seeds, roster and results are excluded.

## Functional UI

The existing creation form defaults to Varied and explains the selected option.
The join screen validates server invitation metadata before a fresh JOIN. Lobby
copy and the room bar identify format through results. Varied explicitly warns
that opportunities can be unequal. Saved enrollment and command recovery retain
exact input. Historical saved CREATE requests without a format show a recovery
placeholder until the server confirms their original format. No visual redesign or design-discovery artifact was changed.

## Verification

- Focused final root run: 73 tests passed (format/identity/replay, exact Mirror-v1
  result parity, client validation, UI, persistence, spin/recovery and simulation).
- Focused final native run: 3 tests passed, including default/explicit formats,
  invite privacy/validation, authorization, retries, restart and legacy pending
  room/CREATE recovery, plus persisted invite throttling before replay.
- `npm run verify:release`: PASS; includes the full 383-test root suite, production
  build, production preview smoke and all-era validation smoke.
- `npm run verify:backend`: PASS; includes root/A–D builds/typechecks, A–E native
  correctness, frontend transport/recovery suites and all 80 canonical fixture
  hash comparisons. The gameplay matrix covers all five eras with default Varied,
  plus complete two- and eight-entrant Mirror games. Existing default Varied
  two/eight-player, concurrent, deadline, socket, hibernation, results and restart
  suites remain active.
- Final gates are rerun after invite hardening; their logs are
  `/private/tmp/varied-release-final.log` and `/private/tmp/varied-backend-final.log`.
- Root and Stage D typechecks and the production Worker build also passed in a
  focused final run. `git diff --check`: PASS.
- Targeted real Chrome production-build walkthrough: PASS for Varied/Foundation
  and Mirror/Impact, each with independent 1440px desktop and 390px mobile guests.
  44 UI picks, four respins, create/join format identification, fixed settings,
  lobby/active/results reload, manual submission, XI comparison and twenty aligned
  fixtures. Zero page errors, unexpected error responses or horizontal overflow.
  Screenshots were inspected. Evidence stays outside the repository at
  `/private/tmp/era-xi-formats-browser/summary.json` and sibling PNGs.
- New v2 seed and state vectors are assertions in `src/draftOffFormat.test.ts`;
  historical fixture and evidence files were neither edited nor replaced.

The sandbox initially blocked loopback tests; approved local execution reran them
successfully. The first browser attempt used an overly exact selector for wrapped
labels; the corrected semantic combobox selector passed the full journey.

## Remaining limits and review status

PASS for code review; this is not deployment approval. Varied deliberately allows
unequal realized opportunities. Local Chrome/loopback checks do not replace the
existing M6 deployed-origin, quota, observability, autonomous-alarm and device/network
gates. No Balanced Draft, accounts or simulation/balance changes were added.
The concurrent `.gitignore` edit that excludes `docs/design/` is unrelated and was
left untouched; exclude it from this change. All design files remain untouched.

Suggested commit message:
`feat(draft-off): add deterministic Varied and Mirror formats with v1 replay compatibility`

## Files in this implementation

- `backend/cloudflare/contracts.ts`
- `backend/cloudflare/http.ts`
- `backend/cloudflare/realtime.ts`
- `backend/cloudflare/room.ts`
- `backend/m5-formats.test.mjs`
- `backend/m5-gameplay.test.mjs`
- `backend/stage-e/FORMATS_HANDOFF.md`
- `backend/stage-e/M5_CONTRACT.md`
- `docs/DRAFT_OFF_ARCHITECTURE.md`
- `package.json`
- `scripts/draft_off_formats_browser_validation.mjs`
- `scripts/m5_premerge_regressions.test.mjs`
- `src/draftOffApp.tsx`
- `src/draftOffClient.test.ts`
- `src/draftOffClientTypes.ts`
- `src/draftOffCompetition.ts`
- `src/draftOffCompetitionInvariants.ts`
- `src/draftOffCompetitionPersistence.ts`
- `src/draftOffCompetitionTypes.ts`
- `src/draftOffFormat.test.ts`
- `src/draftOffFormat.ts`
- `src/draftOffInviteClient.ts`
- `src/draftOffRealtimeClient.ts`
- `src/draftOffRoom.test.tsx`
- `src/draftOffRoom.tsx`
- `src/draftOffRoomProjection.ts`
- `src/draftOffRoomService.ts`
- `src/draftOffRoomTypes.ts`
