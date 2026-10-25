# M5.5 — Two-XI comparison and usability refinement

Status: **PASS for local M5.5 review**. Implementation is uncommitted. No commit, push, merge, deployment, M5.6 acceptance or M6 staging was performed.

## Delivered behavior

- Resolved round entrants choose Individual results or Compare two XIs. Comparison selectors contain only eligible submitted entries, require distinct participants and support swapping sides. Incomplete locked entrants retain results access; left-before-start viewers do not gain it. An uncontested round explains why comparison is unavailable; no-contest rounds expose no private results.
- Eleven rows pair players by locked batting position, with identity/team/season, role, roster/keeper status, overall/tier, relevant batting/bowling ratings, fit and player inspection. Shared player-seasons, different versions of the same player and different players are distinguished.
- Assessment pairs overall/batting/bowling strength, quality mix, position-fit counts, bowling units/frontline/support and overseas/keeper construction. These are existing result projections; there is no local evaluation or additional bonus.
- Campaign results preserve authoritative ranks (including exact ties), played/wins/losses/points and NRR. Twenty fixture pairs align by sequence, match ID and canonical opponent profile; repeated opponents remain separate. Each pair includes winner-relative outcome, both regulation innings, overs/all-out status, margin or Super Over verdict. Schedule mismatch fails closed. The interface explains that entrants independently face the same historical fixtures and do not play each other.
- Desktop rows align A and B side by side; narrow layouts stack each pair under its shared metric, position or fixture. Participant names remain attached to values. Section navigation and return-to-selection links make long campaigns navigable.
- Existing placement clocks now also appear in locked-XI review, candidate/locked-player inspection, submission confirmation and waiting-state inspection. Sticky modal headers keep the clock visible while scrolling; zero announces server checking. Pending placement explains server confirmation, keeps a waiting label in the sticky confirmation control and disables replacement actions. Touch controls are at least 44px high, the mobile placement sheet fills its intended width, long names wrap, and reduced-motion/short-height layouts are scoped to Draft-Off. Escape does not inadvertently clear a selection beneath XI review or confirmation.

## Preserved boundaries

The existing M5.3 endpoint and M5.4 authenticated session own authorization, request validation, cancellation, cooldown and the eight-entry memory cache. Comparison shares the existing loading/retry presentation; it adds no private persistence, endpoint, simulation, ranking, dependency or recovery protocol. Both modes reuse the same match renderer. The V1 inspector's new countdown is optional; solo callers and solo behavior are unchanged. Backend/domain/data files and historical evidence were not changed.

## Significant files

| File | Change |
| --- | --- |
| `src/draftOffResults.tsx` | Shared result-loading hook/status and two-XI comparison; existing match renderer reused |
| `src/draftOffRoom.tsx` | Eligible selection/view controls, modal clocks and pending feedback |
| `src/draftOff.css` | Paired responsive layout, modal/header/clock/touch/reflow refinements |
| `src/eraDraftPlayerPresentation.tsx` | Optional inspection countdown, including the deadline-checking announcement |
| `src/draftOffResults.test.tsx` | Comparison alignment, participant switching, real session caching, stale responses, access loss, incomplete viewer and mismatch coverage |
| `src/draftOffRoom.test.tsx` | Modal clocks/focus, pending placement and deadline behavior |
| `scripts/draft_off_m55_browser_validation.mjs` | Reproducible local production-entrypoint browser walkthrough and screenshots |
| `backend/stage-e/M5_CONTRACT.md`, `docs/DRAFT_OFF_ARCHITECTURE.md` | Presentation integration notes; no wire-contract changes |

## Validation

Validated on 2026-10-25 (Asia/Kolkata), Node 24.22.0, local Chrome 156.0.8078.47.

| Gate | Result |
| --- | --- |
| Focused UI/client/results and V1 presentation suites | PASS; final UI suites 23 tests, plus existing client/cache/V1 compatibility coverage |
| `npm run verify:release` | PASS: 342 root tests, production build, route/data/hash/MIME smoke, five-era complete-game validation; all correctness counters zero |
| `npm run verify:backend` | PASS: root/A–D builds and typechecks, 113 A–E/native tests; all 80 canonical fixtures match the original baseline |
| Root `npm run typecheck` | PASS |
| `git diff --check`; browser-script syntax | PASS |
| Real browser, built frontend + production Worker/SQLite | PASS; details below |

The sandbox initially blocked loopback binds. The permitted local-server reruns passed. The frontend retains its existing large-chunk advisory. No independent benchmark sweep or comprehensive M1–M4 audit was run; the required backend gate retains its existing small correctness/latency smokes. Historical committed results and canonical hashes are unchanged.

Browser checks use two isolated guest contexts, deliberately different legal XIs and accelerated test-only request budgets. All 22 picks and both submissions use the UI. Checks cover keyboard selection, native modal focus/Tab/Escape/restoration, clocks during inspection and submission, held authoritative command responses/pending feedback, exact production result/position/outcome/rank alignment, eleven paired positions and twenty paired fixtures, selection navigation, two authenticated reads followed by cache reuse across swaps/mode changes, authenticated reload, real storage-event invalidation from another tab and the existing solo entry route. Console page errors and horizontal overflow are checked. Viewports: 1440×1000 desktop, 390×844 touch, 320×640 narrow touch and 720×500 desktop reflow; reduced motion is enabled. The viewport metadata permits user zoom. The 720px check is reflow coverage, not a claim of native browser/OS zoom testing.

The fixed canonical `m53-super-over-50` regression compares a Super Over win and loss through restored authoritative state, checks every fixture's original innings/balls/outcome, and verifies the correct winner/null-margin handling. No score injection, runtime seed search or canonical fixture modification was introduced. Three-entry selection tests include a fourth, incomplete viewer. Exact-tie tests use identical canonical XIs; other alignment tests use distinct submissions independently checked against canonical domain state.

Local logs: `/private/tmp/draft-off-m55-release.log`, `/private/tmp/draft-off-m55-backend.log`, `/private/tmp/draft-off-m55-browser.log`. Browser evidence: `/private/tmp/draft-off-m55-browser-evidence/summary.json` and adjacent PNGs. These are local scratch artifacts; no credentials are saved in the evidence. Runtime private state is removed after the walkthrough.

To repeat browser validation after the existing backend build, set `DRAFT_OFF_PLAYWRIGHT_MODULE` to a locally installed Playwright module and `CHROME_BIN` to Chrome, optionally set `DRAFT_OFF_BROWSER_OUTPUT`, then run `node scripts/draft_off_m55_browser_validation.mjs`. It builds a separate frontend, starts the production Worker locally and requires loopback/browser execution permission. No package installation is performed.

## Recommended visual review

Inspect these files under `/private/tmp/draft-off-m55-browser-evidence/`:

- `desktop-comparison-selection.png`, `desktop-comparison-order.png`, `desktop-comparison-assessment.png`: control hierarchy, paired-row scanability, ratings and long participant labels.
- `mobile-comparison-order.png`, `narrow-comparison-order.png`, `mobile-comparison-fixtures.png`: paired stacking, participant identity, recurring-opponent fixture context and vertical navigation.
- `mobile-placement-scrolled.png`, `mobile-pending.png`, `mobile-locked-inspection.png`, `mobile-submit.png`: clock visibility, sticky confirmation, pending feedback, nested inspection and touch layout.
- `desktop-reflow-comparison.png`, `narrow-individual-results.png`: constrained-height reflow and existing individual-results compatibility.

Broader typography, branding, artwork and aesthetic redesign remain deferred as requested.

## Limits and acceptance

No unresolved local correctness issue remains. Browser coverage is local Chrome with touch/viewport emulation; physical mobile devices, other engines, actual assistive-technology sessions, native zoom, browser suspension and deployed network/CPU/quota behavior remain external validation boundaries. Super Overs and exact-tie edge cases have deterministic canonical/DOM coverage; the production browser walkthrough uses naturally generated campaigns and does not force those outcomes. This is M5.5 acceptance only.

Suggested commit: `feat(draft-off): compare two XIs and refine playability`

## Narrow pre-commit usability follow-up

Completed after screenshot review, with no broader redesign or backend/simulation change.

- **Placement context:** scrolling the original placement sheet could hide the selected player's identity. The sheet now has a fixed header and confirmation footer with an independently scrolling body. The footer always includes the selected player's full name and team-season alongside the confirmation/pending control. The original season detail and inspection remain in the scrollable body. Browser geometry and hit-testing brought all eleven rows fully into view at both 320×640 and 390×844, before and during a held authoritative lock response; no row was covered by the header/footer.
- **A/B identity:** no mapping defect was found. Assertions now verify participant labels and associated XI, evaluation, aggregate and all twenty fixture values after selection changes and swaps. Canonical distinct submissions cover swapped values; the three-entry test covers changing participants, long names and an incomplete viewer. The real browser checks all four sections against authenticated production results before and after swapping.
- **Fixture verbosity:** the comparison defaults to twenty compact opponent/sequence rows with paired A/B WIN/LOSS outcomes and explicit Super Over labels where applicable. Native `details`/`summary` controls reveal both existing innings cards and verdicts on demand. A section legend identifies A/B, and expanded cards repeat full participant names. Disclosure does not fetch additional data or run simulation. Individual results retain their existing presentation.

Follow-up validation: **PASS for commit**. The relevant room/results/client/cache and V1 presentation suites passed **63 tests**, including canonical Super Overs, independent disclosure toggling, selection/swap identity and pending context. Root build/typecheck, browser-script syntax and `git diff --check` passed. The production frontend build and production Worker/SQLite browser walkthrough passed in Chrome 156.0.8078.47, including focused 320px/390px touch checks, native keyboard disclosure, cache/reload/access-loss regressions and no horizontal overflow/page errors. The full release/backend gate evidence above is the earlier M5.5 baseline; this presentation-only follow-up reran focused validation as requested, not those full gates.

New evidence preserves the earlier screenshots in their original directory. Follow-up artifacts are under `/private/tmp/draft-off-m55-followup-browser-evidence/`, with browser log `/private/tmp/draft-off-m55-followup-browser.log`:

- `placement-320.png`, `placement-320-pending.png`, `placement-390.png`, `placement-390-pending.png`: selected identity, accessible last position and pinned confirmation/pending feedback.
- `fixtures-320-overview.png`, `fixtures-390-overview.png`: compact paired outcomes.
- `fixtures-320-expanded.png`, `fixtures-390-expanded.png`: on-demand original innings and verdicts.
- `summary.json`: browser validation summary. Checks use local touch/viewport emulation, not physical devices.

No commit, push, merge or deployment was performed.
