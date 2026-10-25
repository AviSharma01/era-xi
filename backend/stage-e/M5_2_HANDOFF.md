# M5.2 implementation and review handoff

M5.2 adds a playable room experience on top of the committed M5.1 enrollment/session layer and frozen M4 contract. No product backend endpoint, domain rule, data, simulation, dependency or deployment change is required.

## Boundaries

- `src/draftOffApp.tsx` owns enrollment/routing/session lifetime. `src/draftOffRoom.tsx` renders authenticated snapshots and sends commands through that session. It does not import the draft engine, simulation or catalog.
- `src/eraDraftPlayerPresentation.tsx` contains the existing V1 candidate gallery, player detail/inspection and fit presentation. V1 imports the same markup; solo controllers, persistence and styles are unchanged. The compact Draft-Off XI/placement layout is mode-specific.
- Public participant rows show backend membership/submission statuses only. The host has no private access advantage. Candidates, picks, keeper/overseas counts and placement legality come only from the caller's `myDraft`.
- A server-time/monotonic-elapsed countdown is display-only. Zero disables new drafting while the existing M4 deadline reconciliation obtains the server decision. Only authenticated HTTP changes the rendered authoritative phase, including completion. There is no second polling loop.
- UI selection/placement is ephemeral, keyed to the caller's draft revision. Other entrants' room revisions do not reset it. Commands use the existing immutable envelope/journal/retry path. One synchronous UI guard prevents duplicate clicks before React renders pending state.
- Submission requires confirmation; server-submitted players see waiting and their own XI only. The final leaderboard preserves server order, tied ranks and contested/uncontested/no-contest status. Mobile rows expose every metric without horizontal scrolling.
- Storage failures, uncertain outcomes and authentication errors use the existing fail-closed recovery path. UI adds pending-action/retry feedback without changing transport behavior. Browser/profile/device loss still has no name-based recovery.

## Verification and visual checkpoints

Use `npm run verify:release`, then `npm run verify:backend`, then `git diff --check`. Native suites run sequentially. The local command includes both `backend/m5-client.test.mjs` and `backend/m5-gameplay.test.mjs`; permissive test-only budgets and isolated synthetic client IPs accommodate accelerated refresh/drafting, without altering interactive defaults. Socket-failure tests shorten only the existing helper's test reconciliation interval.

Final local gates passed: 306 root tests; production web build and route/data/MIME smoke; V1 all-era gameplay smoke; root and A–D typechecks; A–E backend correctness; 80 unchanged canonical fixtures; four native client integration tests; and `git diff --check`.

Rendered browser coverage uses independent guest storage origins (`127.0.0.1` and `localhost`) in the same browser, at 1440×1000 and 390×844. It covers create/join, lobby leave/rejoin, host start, SPIN/RESPIN, inspection, position preview/confirmation, double-click, drafting reload, both complete XIs, confirmation, submitted/waiting reload and the same final tied leaderboard in both clients. Additional elapsed rounds confirm actual incomplete-deadline/no-contest rendering. Native integration separately covers uncertain committed replies, exact journal retries, socket-unavailable HTTP convergence, submission freezing, deadline auto-submission/exclusion and eight entrants. This is local validation, not external devices, independent browser engines or M6 playtesting.

Review the lobby/invite hierarchy, sticky clock/actions, desktop selection-to-XI placement, mobile placement sheet (including its clock and sticky confirmation), waiting state and compact mobile leaderboard. Detailed comparison/motion polish remains later work; basic responsive drafting is included here.

## M5.3 results endpoint proposal — review required, not implemented

Recommendation: one on-demand `GET /api/draft-off/v1/rooms/{code}/results/{participantId}` for the room's current resolved round. Keep the existing room GET and WebSocket payloads unchanged. The leaderboard already identifies eligible participants, so a second index endpoint is unnecessary. Return one entrant's projection at a time; no all-results bundle or client simulation.

Proposed response, with every nested field explicitly whitelisted:

```ts
{
  ok: true,
  version: 1,
  roomCode: string,
  roundId: string,
  participantId: string,
  displayName: string,
  players: readonly RevealPlayerView[], // exactly 11, batting-position order
  evaluation: TeamEvaluationSummaryView,
  campaign: {
    aggregate: {
      played: number, won: number, lost: number, points: number,
      runsFor: number, ballsFacedForNrr: number,
      runsAgainst: number, ballsBowledForNrr: number, netRunRate: number
    },
    matches: readonly { // exactly 20, existing authoritative fixture order
      sequence: number,
      opponent: { profileId: string, teamName: string, seasonYear: number },
      firstInnings: { side: 'ENTRY' | 'OPPONENT', runs: number, wickets: number, balls: number },
      secondInnings: { side: 'ENTRY' | 'OPPONENT', runs: number, wickets: number, balls: number },
      outcome: 'WIN' | 'LOSS',
      resultType: 'runs' | 'wickets' | 'super_over',
      margin: number | null
    }[]
  }
}
```

`RevealPlayerView` and `TeamEvaluationSummaryView` refer to the existing explicit UI view types in `src/eraDraftTypes.ts`; review their exact fields as part of the M5.3 schema approval. Construct these projections from the frozen submitted XI, canonical player facts and stored campaign evaluation/results. Do not return `TeamEvaluationV2`, raw `XiCompleteState` or `DraftOffChallengeResult`; these contain internals beyond the UI contract. No re-simulation, seeds, histories, receipt/journal/auth fields, internal fingerprints/hashes or incomplete XIs. All ranking/NRR values remain backend authoritative.

Authorization recommendation (requires approval): exact approved Origin plus the existing room-bound Bearer reconnect credential. Mirror room GET's registered-participant scope, including LEFT/ineligible members, while allowing inspection only of eligible submitted entrants after resolution. The invite code or target participant ID alone grants no access. Host permissions are identical. Authenticated access after completion reveals eligible XIs intentionally; no draft-phase detail, spectator access or public caching.

Proposed errors: existing indistinguishable `401 AUTHENTICATION_FAILED` for absent/invalid/wrong-room/expired access; after authentication, `409 RESULTS_NOT_READY` until current authoritative resolution, and `404 RESULT_UNAVAILABLE` for a noneligible/unknown target. Keep normal exact-path/input validation, rate limits, response byte bounds, retention and `private, no-store` headers. Define the response/error allowlists, payload-size fixture and authorization/privacy tests before implementation. Existing lifecycle recovery must reconcile an overdue round before checking result availability; the new route must not create a second resolver.

Viable alternative: return all eligible details in the room GET after resolution. The per-entrant endpoint is preferred because it keeps the M4 bootstrap/realtime contract stable and limits payload size. This proposal is the M5.3 review gate, not authorization to implement it during M5.2.
