# M5.3 implementation and review handoff

M5.3 adds authenticated selected-entry results to the completed Draft-Off journey. The approved contract is the [M5.3 extension](M5_CONTRACT.md#m53-authenticated-results-extension), with exact DTOs in `src/draftOffResultsTypes.ts`. No commit, push, merge or deployment is part of this milestone.

## Implementation and boundaries

- Added `GET /api/draft-off/v1/rooms/{code}/results/{participantId}` through the existing Worker/room queue, Bearer verification, exact Origin, response headers, lifecycle recovery and shared participant READ budget. Existing room GET, WebSocket and receipt payloads are unchanged.
- Readiness is checked before target lookup. After resolution, only locked-round entrants may inspect eligible submitted XIs. This includes viewers with incomplete XIs, but excludes members LEFT at START. Unknown/ineligible/foreign targets and excluded viewers share the same safe 404; unavailable room/credentials retain indistinguishable 401. Unresolved results return safe 409.
- The projector consumes the frozen submitted XI and matching canonical restored campaign. It explicitly whitelists player reveal/historical facts, existing team assessment, authoritative aggregate and twenty ordered fixture/innings/outcome summaries. It neither evaluates nor simulates a team. Existing canonical restore/replay, hashes, atomic resolution, alarms, retention and failure behavior are unchanged.
- A minimal extraction shares the existing evaluation-to-reveal whitelist. Five-era hashes captured before extraction prove identical solo reveal JSON and rendered markup. PlayerInspector's input type was narrowed to the existing presentation fields; its markup and interaction behavior are unchanged.
- The strict client validates every nested key, identity, enum, nullable value, order/count and numeric bound. It cross-checks leaderboard metrics without reconstructing NRR. Results use the existing session transport, timeout/cancellation and shared Retry-After cooldown; command journals/pending state remain independent.
- Successful results are deduplicated and cached only in the authenticated session's memory, at most eight entries. Obsolete requests are aborted and late callbacks discarded. Access failure/disposal clears private result state. No server cache, new persistence structure, migration, dependency or recovery mechanism was added.
- Retry presentation subscribes to the existing shared transport deadline, including cooldowns introduced or extended by another request. Its countdown schedules bounded display updates only while an error and active cooldown exist, ending exactly at expiry. There is no request polling, automatic retry or independent cooldown authority; transport gating and Retry-After parsing are unchanged.

## Stale-response identity

The active session owns the room and reconnect credential. Each request validates room code, round ID/ordinal, era and target participant ID; the UI also checks current selection/session ownership. The server's resolved submission and campaign are immutable for that identity. Room revision is therefore unnecessary and is absent from both success and error payloads. A newer room revision alone does not invalidate a resolved result.

## Presentation

The final leaderboard remains first and preserves server order, ties and contest status. Locked entrants can choose an eligible row's View results control. Own eligible results load by default; an incomplete viewer defaults to the first eligible row. NO_CONTEST and LEFT viewers start no detail fetch.

The selected entry displays eleven locked batting positions, player inspection, revealed ratings/tiers/fit, team assessment and all twenty ordered matches. Campaign cards retain both regulation innings, legal-ball overs, all-out flags, authoritative outcomes and margins/Super Over labels. No scorecard or standings are invented. Desktop uses XI/assessment columns and a two-column campaign; mobile stacks both with no horizontal overflow. Loading, unavailable, retry, shared cooldown and access-loss states retain the existing leaderboard. Selecting an entry focuses and scrolls its heading below the sticky room bar.

M5.4 recovery hardening, M5.5 comparison, game balance, multiplayer lifecycle changes, accounts, staging and unrelated visual work remain outside this implementation.

## Validation

Latest focused follow-up gates passed on Node 24.22.0 (2026-10-24):

- `npm run verify:release`: 325 root tests; production web build; routes/catalog hashes/MIME/notices smoke; five-era complete-game validation with all correctness counters zero.
- Focused results/client/room/solo reveal lane: 50 passing tests. Root and A–D typechecks and the Stage D production/test bundle build passed.
- `npm run test:draft-off-client:local`: all eight native M5 client/gameplay/results tests passed, including real SQLite/workerd authorization, restoration and production fixture isolation.
- The earlier implementation gate `npm run verify:backend` passed root and A–D builds/typechecks and 109 A–E/native tests, with all 80 canonical fixture hashes unchanged. This follow-up did not repeat the comprehensive M1–M4 audit; the fixture hashes were rechecked independently.
- `git diff --check` and syntax checks passed. New tests are registered in the existing root/backend verification lanes.

Focused tests cover resolution/submission gating, locked/incomplete/LEFT access, safe 401/404/409 responses, Origin/input validation, recursive allowlists, canonical joins in all five eras, nullable statistics, Super Over semantics, authoritative aggregates, unchanged snapshots/receipts, quota rejection before cold replay, restart/expiry/corruption and production fixture isolation. UI/client tests cover lazy loading, deduplication, caching, selection/session races, cancellation, inspection, retry/cooldown and removal on access loss.

### Pre-commit findings resolved

- **P2 shared cooldown:** a deterministic fake-clock regression begins with an unrelated results failure and no cooldown, introduces a deadline via a room request's 429, extends it via another already-in-flight request, and verifies Retry remains disabled through the old deadline and enables exactly at the extended deadline without unrelated rendering or interaction. It uses the actual shared transport and confirms there is no automatic results request.
- **Participant correctness:** the two-entry fixtures deliberately choose opposite legal selections/orders; the native eight-entry room has eight distinct submitted XIs and distinguishable evaluations/aggregates. Expected identity, frozen picks, ratings, construction, aggregate and every ordered fixture/innings/outcome are derived independently from canonical domain state or restored persisted submission history. Responses under test are never their own identity oracle. Tests cover selection changes, both participant caches, a shape-valid swapped campaign rejected against the authoritative leaderboard, cold object restoration and full restart.
- **Super Over:** fixed test seed `m53-super-over-50` naturally produces a host win (match 3, regulation 169/4 and 169/6) and member loss (match 1, regulation 129/5 and 129/5). The regression serializes/restores canonical state, reads through the room service and renders both selections. It verifies winner-relative WIN/LOSS, null margin, original two regulation innings/balls and the correct winner's Super Over verdict. There is no runtime seed search, score injection, new test infrastructure, canonical fixture modification or production simulation/persistence change. The native HTTP parser/projection path is covered separately; this deterministic test does not manufacture a Super Over over native HTTP.

Native M5.3 tests run through the production HTTP boundary and real SQLite/workerd, including an eight-player resolved room. Existing socket frames are scanned for private fields and results reads emit no additional broadcast. Existing room/receipt regression hashes and canonical fixture checks remain required.

Earlier implementation rendered checks used the built production frontend, the actual production backend bundle and Chrome 156.0.8078.47. Independent guest contexts passed at 1440×1000 and 390×844, covering final leaderboard, eleven player rows, inspection modal, team assessment, twenty matches, lazy participant selection, in-memory cache reuse and authenticated reload. Screenshots of desktop/mobile XI, inspection and campaign were visually inspected. This focused follow-up reran deterministic DOM tests, not the browser walkthrough. These are local checks, not external devices or M6 playtesting.

## Eight-player read cost

Latest native regression measurements with eight distinct XIs (permissive test-only rate budgets; interactive defaults unchanged):

| Operation | Samples | Median | p95/max |
| --- | ---: | ---: | ---: |
| Repeated authenticated results GET | 16 | 155.51 ms | 167.26 ms |
| Results GET after forced object eviction | 8 | 406.44 ms | 412.00 ms |
| Ordinary resolved room GET | 8 | 153.92 ms | 166.83 ms |
| Results GET after full process restart | 1 | 447.29 ms | 447.29 ms |

Every repeated/restored response matched its independently derived authoritative selected campaign. Largest response was 21,771 UTF-8 bytes, below the 2,097,152-byte ceiling. The earlier implementation run measured 152 ms warm and 395 ms cold median. Reads preserved canonical bytes, command records and expiry alarm. These samples are emitted by the existing correctness regression; no additional benchmark sweep was introduced.

Warm results cost is close to the unchanged room GET cost. Cold recovery still reconstructs the entire eight-entry resolved competition through canonical replay; fetching one result does not make restoration participant-local. The measured sub-second local reads support retaining the existing design. No persistence/cache infrastructure was introduced. The serialized room queue and full-round replay remain relevant to eventual deployment CPU limits and concurrent load; these local wall-clock samples do not establish provider CPU/quota headroom or Internet latency.

## Review status

**PASS for committing M5.3.** All three pre-commit findings are resolved. Staging/runtime quotas, real network/device testing and deployed observability remain the existing deployment gates; no deployment approval is implied. Work is uncommitted, unpushed and unmerged. Recommended commit message: `feat(draft-off): add authenticated post-resolution results browsing`.
