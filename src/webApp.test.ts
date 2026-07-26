import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import {
  type BattingPosition,
  type ClassicDraftState,
  type DraftPlayerSeason,
  createClassicDraftState,
  loadDraftPool,
} from "./draftClassic.js";
import { createClassicDraftApp } from "./webApp.js";
import {
  CURATED_OPPONENT_XIS_2016,
  buildCuratedOpponentState2016,
  buildOpponentStrengthProfiles2016,
} from "./opponentProfiles2016.js";
import {
  type LeagueSimulationResult,
  simulateLeagueV1,
  simulatePlayoffsV1,
} from "./simulationV1.js";

test("renders ready state from a loaded draft pool", () => {
  const { root } = setupDom();
  createClassicDraftApp({ root, pool: loadDraftPool(players()), seed: "ready" });

  assert.match(root.textContent ?? "", /Ready to start/);
  assert.equal(button(root, "Spin").disabled, false);
  assert.equal(root.querySelector(".available-players"), null);
  assert.equal(root.querySelector(".selected-player-detail"), null);
  assert.match(root.querySelector(".page-header p")?.textContent ?? "", /^Pick 1 of 11$/);
  assert.doesNotMatch(root.textContent ?? "", /Ratings and tiers hidden/i);
});

test("renders the approved left and right Draft Room structure", () => {
  const { root } = setupDom();
  createClassicDraftApp({ root, pool: loadDraftPool(players()), seed: "structure" });

  const leftHeadings = [...root.querySelectorAll(".draft-room-left > section > h2")]
    .map((heading) => heading.textContent);
  const rightHeadings = [...root.querySelectorAll(".draft-room-right > section > h2")]
    .map((heading) => heading.textContent);

  assert.deepEqual(leftHeadings, [
    "Current Franchise",
    "Spin / Respin",
  ]);
  assert.deepEqual(rightHeadings, ["Playing XI", "Team Building Guide"]);
});

test("transient Draft Room panels follow the spin, selection, preview, and confirm flow", () => {
  const { root } = setupDom();
  createClassicDraftApp({ root, pool: loadDraftPool(players()), seed: "spin" });

  assert.equal(root.querySelector(".available-players"), null);
  assert.equal(root.querySelector(".selected-player-detail"), null);

  click(button(root, "Spin"));

  assert.notEqual(root.querySelector(".available-players"), null);
  assert.equal(root.querySelector(".selected-player-detail"), null);
  assert.match(root.textContent ?? "", /WK Batter/);

  click(squadRow(root, "WK Batter"));
  assert.notEqual(root.querySelector(".selected-player-detail"), null);

  click(slotButton(root, 4));
  assert.match(root.querySelector(".selected-player-detail")?.textContent ?? "", /Preview position:\s*4/);

  click(button(root, "Confirm Pick"));
  assert.equal(root.querySelector(".available-players"), null);
  assert.equal(root.querySelector(".selected-player-detail"), null);
  assert.match(root.querySelector(".current-spin")?.textContent ?? "", /Ready for next spin/);

  click(button(root, "Spin"));
  assert.notEqual(root.querySelector(".available-players"), null);
  assert.equal(root.querySelector(".selected-player-detail"), null);
});

test("selecting a player and open slot creates provisional placement before confirmation", () => {
  const { root } = setupDom();
  const app = createClassicDraftApp({ root, pool: loadDraftPool(players()), seed: "pick" });
  click(button(root, "Spin"));

  click(squadRow(root, "WK Batter"));
  click(slotButton(root, 4));

  assert.equal(app.getState().slots.length, 0);
  assert.match(slotButton(root, 4).textContent ?? "", /Preview WK Batter/);

  click(button(root, "Confirm Pick"));

  assert.equal(app.getState().slots[0]?.position, 4);
  assert.equal(app.getState().currentSquadKey, null);
  assert.match(slotButton(root, 4).textContent ?? "", /4\. WK Batter/);
  assert.equal(root.querySelectorAll(".squad-row").length, 0);
  assert.equal(button(root, "Spin").disabled, false);
});

test("selected players expose all approved fit labels on open slots", () => {
  const { root } = setupDom();
  createClassicDraftApp({ root, pool: loadDraftPool(players()), seed: "fit-labels" });
  click(button(root, "Spin"));
  click(squadRow(root, "WK Batter"));

  assert.match(slotButton(root, 4).textContent ?? "", /Natural/);
  assert.match(slotButton(root, 3).textContent ?? "", /Acceptable/);
  assert.match(slotButton(root, 2).textContent ?? "", /Out of Position/);
  assert.match(slotButton(root, 11).textContent ?? "", /Severely Out of Position/);
});

test("illegal players are disabled with concise visible reasons", () => {
  const { root } = setupDom();
  const pool = loadDraftPool(players());
  const initialState = createClassicDraftState();
  initialState.currentSquadKey = "2016 Team A";
  initialState.slots = [1, 2, 3, 4].map((position) => ({
    position: position as 1 | 2 | 3 | 4,
    player: player({
      id: `locked-overseas-${position}`,
      playerId: `locked-overseas-${position}`,
      isOverseas: true,
    }),
  }));
  createClassicDraftApp({ root, pool, seed: "illegal-row", initialState });

  const illegal = squadRow(root, "Overseas Batter");
  assert.equal(illegal.disabled, true);
  assert.match(illegal.textContent ?? "", /Overseas limit reached/);
});

test("Team Building Guide exposes draft-visible facts without rated results", () => {
  const { root } = setupDom();
  createClassicDraftApp({
    root,
    pool: loadDraftPool([promotedPlayer(), ...players()]),
    seed: "guide-hidden",
  });
  click(button(root, "Spin"));

  const guide = root.querySelector(".team-building-guide")?.textContent ?? "";
  assert.match(guide, /Overseas|Wicketkeeper|Position fit|Bowling coverage/);
  assert.match(guide, /may unlock team boosts after ratings are revealed/i);
  assert.doesNotMatch(guide, /Base rating|Draft tier|Overall team rating|69\.6|75\.7/);
});

test("respin clears selected and error state while consuming the engine respin", () => {
  const { root } = setupDom();
  const app = createClassicDraftApp({ root, pool: loadDraftPool(players()), seed: "respin" });
  click(button(root, "Spin"));
  click(squadRow(root, "WK Batter"));
  click(slotButton(root, 4));
  assert.match(root.textContent ?? "", /Previewing WK Batter/);

  click(button(root, "Respin"));

  assert.equal(app.getState().respinsRemaining, 0);
  assert.doesNotMatch(root.textContent ?? "", /Previewing WK Batter/);
  assert.match(root.textContent ?? "", /0 respin remaining/);
});

test("completed reveal screen has Begin Season as its only action", () => {
  const { root } = setupDom();
  const pool = loadDraftPool(players());
  const completed = createCompletedState(pool.players);
  createClassicDraftApp({ root, pool, seed: "reveal-action", initialState: completed });

  click(button(root, "Reveal Team"));

  assert.deepEqual(
    [...root.querySelectorAll<HTMLButtonElement>(".completed-team-screen button")]
      .map((node) => node.textContent),
    ["Begin Season"],
  );
  assert.equal(findButton(root, "Start New Draft"), null);
});

test("ratings and tiers stay hidden during drafting", () => {
  const { root } = setupDom();
  createClassicDraftApp({ root, pool: loadDraftPool([promotedPlayer()]), seed: "hidden-draft" });
  click(button(root, "Spin"));
  click(squadRow(root, "Promoted Star"));

  assertNoRatedLeakage(root);
  assert.equal(root.querySelector(".tier-s"), null);
});

test("completed XI starts unrevealed with neutral cards", () => {
  const { root } = setupDom();
  const pool = loadDraftPool([promotedPlayer(), ...players()]);
  createClassicDraftApp({ root, pool, seed: "completed-hidden", initialState: createCompletedState(pool.players) });

  assert.match(root.textContent ?? "", /Completed XI/);
  assert.doesNotMatch(root.textContent ?? "", /Choose a player from the spun squad/);
  assert.equal(button(root, "Reveal Team").disabled, false);
  assert.deepEqual(
    [...root.querySelectorAll<HTMLButtonElement>(".controls button")].map((node) => node.textContent),
    ["Reveal Team"],
  );
  assert.equal(root.querySelector(".available-players"), null);
  assert.equal(root.querySelector(".selected-player-detail"), null);
  assert.match(root.querySelector(".page-header p")?.textContent ?? "", /^Pick 11 of 11$/);
  assertNoRatedLeakage(root);
  assert.equal(root.querySelector(".tier-s"), null);
});

test("reveal renders a separate ordered XI with stored rating and tier values", () => {
  const { root } = setupDom();
  const pool = loadDraftPool([promotedPlayer(), ...players()]);
  createClassicDraftApp({ root, pool, seed: "reveal", initialState: createCompletedState(pool.players) });

  click(button(root, "Reveal Team"));

  assert.equal(root.querySelector(".draft-room"), null);
  assert.notEqual(root.querySelector(".completed-team-screen"), null);
  const rows = [...root.querySelectorAll<HTMLElement>(".completed-xi-row")];
  assert.equal(rows.length, 11);
  assert.deepEqual(
    rows.map((row) => row.dataset.position),
    Array.from({ length: 11 }, (_, index) => String(index + 1)),
  );
  assert.match(revealRow(root, 1).textContent ?? "", /Promoted Star.*1.*Batter.*Natural.*69\.6 · S/);
});

test("reveal omits internal player and evaluation detail", () => {
  const { root } = setupDom();
  const pool = loadDraftPool([promotedPlayer(), ...players()]);
  createClassicDraftApp({ root, pool, seed: "coverage-details", initialState: createCompletedState(pool.players) });

  click(button(root, "Reveal Team"));

  const text = root.textContent ?? "";
  assert.doesNotMatch(text, /Effective|Absolute tier|Coverage promotion|Rating confidence|Position distance|Fit multiplier|Penalty/);
  assert.doesNotMatch(text, /Batting strength|Bowling strength|Batting depth|Bowling depth|Average base rating|Fit rating/);
  assert.equal(root.querySelector(".active-details"), null);
});

test("team rating is compact and uses adjusted overall, batting, and bowling values", () => {
  const { root } = setupDom();
  const summaryPlayers = [
    player({ id: "s", playerId: "s", name: "S Player", draftTier: "S", absoluteTier: "S", baseRating: 80, naturalPositions: [1], acceptablePositions: [1], bowlingOptionStrength: "frontline", isWicketkeeper: true }),
    player({ id: "a", playerId: "a", name: "A Player", draftTier: "A", absoluteTier: "A", baseRating: 70, naturalPositions: [2], acceptablePositions: [2], bowlingOptionStrength: "secondary", isOverseas: true }),
    player({ id: "b", playerId: "b", name: "B Player", draftTier: "B", absoluteTier: "B", baseRating: 60, naturalPositions: [3], acceptablePositions: [4], bowlingOptionStrength: "part_time" }),
    player({ id: "c", playerId: "c", name: "C Player", draftTier: "C", absoluteTier: "C", baseRating: 50, naturalPositions: [4], acceptablePositions: [5] }),
    player({ id: "d", playerId: "d", name: "D Player", draftTier: "D", absoluteTier: "D", baseRating: 40, naturalPositions: [5], acceptablePositions: [6] }),
    player({ id: "c2", playerId: "c2", name: "C Two", draftTier: "C", absoluteTier: "C", baseRating: 50, naturalPositions: [6], acceptablePositions: [6] }),
    player({ id: "d2", playerId: "d2", name: "D Two", draftTier: "D", absoluteTier: "D", baseRating: 40, naturalPositions: [7], acceptablePositions: [7] }),
    player({ id: "b2", playerId: "b2", name: "B Two", draftTier: "B", absoluteTier: "B", baseRating: 60, naturalPositions: [8], acceptablePositions: [8] }),
    player({ id: "a2", playerId: "a2", name: "A Two", draftTier: "A", absoluteTier: "A", baseRating: 70, naturalPositions: [9], acceptablePositions: [9], isOverseas: true }),
    player({ id: "s2", playerId: "s2", name: "S Two", draftTier: "S", absoluteTier: "S", baseRating: 80, naturalPositions: [10], acceptablePositions: [10] }),
    player({ id: "d3", playerId: "d3", name: "D Three", draftTier: "D", absoluteTier: "D", baseRating: 40, naturalPositions: [1], acceptablePositions: [2], isOverseas: true }),
  ];
  const pool = loadDraftPool(summaryPlayers);
  createClassicDraftApp({ root, pool, seed: "summary", initialState: createCompletedState(summaryPlayers) });

  click(button(root, "Reveal Team"));
  const text = root.querySelector(".completed-team-rating")?.textContent ?? "";

  assert.equal(root.querySelectorAll(".team-rating-metrics .team-rating-metric").length, 3);
  assert.notEqual(root.querySelector(".team-rating-metric-overall"), null);
  assert.match(text, /Team Rating/);
  assert.match(text, /Overall Team Rating39\.7/);
  assert.match(text, /Batting49\.4/);
  assert.match(text, /Bowling30\.0/);
  assert.doesNotMatch(text, /strength|depth|average|fit|tier|overseas|wicketkeeper|option/i);
});

test("begin season failure keeps the reveal visible with a retry action", () => {
  const { root } = setupDom();
  const pool = loadDraftPool([promotedPlayer(), ...players()]);
  let setupAttempts = 0;
  createClassicDraftApp({
    root,
    pool,
    seed: "failed-season",
    initialState: createCompletedState(pool.players),
    simulationServices: {
      buildProfiles: () => {
        setupAttempts += 1;
        throw new Error("Season setup failed.");
      },
      simulateLeague: simulateLeagueV1,
      simulatePlayoffs: simulatePlayoffsV1,
    },
  });
  click(button(root, "Reveal Team"));
  click(button(root, "Begin Season"));

  assert.notEqual(root.querySelector(".completed-team-screen"), null);
  assert.equal(root.querySelector('[role="alert"]')?.textContent, "Season setup failed.");
  assert.equal(button(root, "Begin Season").disabled, false);
  const cachedRating = root.querySelector(".team-rating-metrics")?.textContent;
  click(button(root, "Begin Season"));
  assert.equal(setupAttempts, 2);
  assert.equal(root.querySelector(".team-rating-metrics")?.textContent, cachedRating);
  assert.equal(root.querySelectorAll(".completed-xi-row").length, 11);
});

test("squad row selection opens and replaces active details without changing confirmed state", () => {
  const { root } = setupDom();
  const app = createClassicDraftApp({ root, pool: loadDraftPool(players()), seed: "details" });
  click(button(root, "Spin"));

  click(squadRow(root, "WK Batter"));
  assert.match(detailsText(root), /WK Batter/);
  assert.equal(app.getState().slots.length, 0);

  click(squadRow(root, "Frontline Bowler"));
  assert.match(detailsText(root), /Frontline Bowler/);
  assert.doesNotMatch(detailsText(root), /WK Batter/);
  assert.equal(app.getState().slots.length, 0);
});

test("confirm pick is disabled until selectable player and open position are chosen", () => {
  const { root } = setupDom();
  createClassicDraftApp({ root, pool: loadDraftPool(players()), seed: "confirm-disabled" });
  click(button(root, "Spin"));

  assert.equal(root.querySelector(".confirm-button"), null);

  click(squadRow(root, "WK Batter"));
  assert.equal(button(root, "Confirm Pick").disabled, true);

  click(slotButton(root, 4));
  assert.equal(button(root, "Confirm Pick").disabled, false);
});

test("changing active player clears pending placement and disables confirmation", () => {
  const { root } = setupDom();
  createClassicDraftApp({ root, pool: loadDraftPool(players()), seed: "replace-pending" });
  click(button(root, "Spin"));

  click(squadRow(root, "WK Batter"));
  click(slotButton(root, 4));
  assert.match(slotButton(root, 4).textContent ?? "", /Preview WK Batter/);
  assert.equal(button(root, "Confirm Pick").disabled, false);

  click(squadRow(root, "Frontline Bowler"));
  assert.match(detailsText(root), /Frontline Bowler/);
  assert.doesNotMatch(slotButton(root, 4).textContent ?? "", /Preview/);
  assert.equal(button(root, "Confirm Pick").disabled, true);

  click(slotButton(root, 10));
  assert.match(slotButton(root, 10).textContent ?? "", /Preview Frontline Bowler/);
  assert.equal(button(root, "Confirm Pick").disabled, false);
});

test("changing pending position for the same player moves provisional placement only", () => {
  const { root } = setupDom();
  const app = createClassicDraftApp({ root, pool: loadDraftPool(players()), seed: "move-pending" });
  click(button(root, "Spin"));

  click(squadRow(root, "WK Batter"));
  click(slotButton(root, 4));
  click(slotButton(root, 5));

  assert.equal(app.getState().slots.length, 0);
  assert.doesNotMatch(slotButton(root, 4).textContent ?? "", /Preview/);
  assert.match(slotButton(root, 5).textContent ?? "", /Preview WK Batter/);
  assert.equal(button(root, "Confirm Pick").disabled, false);
});

test("drafted mini-card opens read-only details and does not allow rearrangement", () => {
  const { root } = setupDom();
  const app = createClassicDraftApp({ root, pool: loadDraftPool(players()), seed: "drafted-details" });
  click(button(root, "Spin"));
  click(squadRow(root, "WK Batter"));
  click(slotButton(root, 4));
  click(button(root, "Confirm Pick"));
  const lockedState = app.getState();

  click(slotButton(root, 4));

  assert.deepEqual(app.getState(), lockedState);
  assert.match(detailsText(root), /Confirmed position: 4/);
  assert.match(detailsText(root), /Position fit:/);
  assert.equal(button(root, "Confirm Pick").disabled, true);
});

test("role filters show only matching squad card families", () => {
  const { root } = setupDom();
  createClassicDraftApp({ root, pool: loadDraftPool(rolePlayers()), seed: "filters" });
  click(button(root, "Spin"));

  click(button(root, "Batters"));
  assert.deepEqual(playerRowNames(root), ["Alpha Batter", "Beta Batter", "Overseas Batter"]);

  click(button(root, "Wicketkeepers"));
  assert.deepEqual(playerRowNames(root), ["Keeper One"]);

  click(button(root, "All-Rounders"));
  assert.deepEqual(playerRowNames(root), ["All Round Two", "All Round One"]);

  click(button(root, "Bowlers"));
  assert.deepEqual(playerRowNames(root), ["Bowler A", "Bowler B"]);
});

test("all view groups and orders players by role-aware metrics with name tie-breaks", () => {
  const { root } = setupDom();
  createClassicDraftApp({ root, pool: loadDraftPool(rolePlayers()), seed: "ordering" });
  click(button(root, "Spin"));

  assert.deepEqual(groupedPlayerRowNames(root), {
    Batters: ["Alpha Batter", "Beta Batter", "Overseas Batter"],
    Wicketkeepers: ["Keeper One"],
    "All-Rounders": ["All Round Two", "All Round One"],
    Bowlers: ["Bowler A", "Bowler B"],
  });
});

test("compact squad rows omit repeated and irrelevant metadata", () => {
  const { root } = setupDom();
  createClassicDraftApp({ root, pool: loadDraftPool(rolePlayers()), seed: "compact" });
  click(button(root, "Spin"));

  const compactCardText = squadRowsText(root);
  assert.doesNotMatch(compactCardText, /Team A/);
  assert.doesNotMatch(compactCardText, /2016/);
  assert.doesNotMatch(compactCardText, /Domestic/);
  assert.doesNotMatch(compactCardText, /India/);
  assert.doesNotMatch(compactCardText, /Not WK/);
  assert.doesNotMatch(compactCardText, /Bowling: none/);
  assert.doesNotMatch(compactCardText, /Acceptable:/);
  assert.doesNotMatch(compactCardText, /positionConfidence|medium/);
  assert.doesNotMatch(compactCardText, /0 wickets|Wkts 0|Econ -/);
  assert.match(squadRow(root, "Keeper One").textContent ?? "", /BAT · WK/);
  assert.doesNotMatch(squadRow(root, "Keeper One").textContent ?? "", /WK · WK/);
  assert.match(squadRow(root, "Overseas Batter").textContent ?? "", /BAT · OVERSEAS/);
});

test("batting average renders to one decimal place on compact cards", () => {
  const { root } = setupDom();
  createClassicDraftApp({ root, pool: loadDraftPool(rolePlayers()), seed: "average" });
  click(button(root, "Spin"));

  assert.match(squadRow(root, "Beta Batter").textContent ?? "", /Avg 17\.3/);
  assert.match(squadRow(root, "Beta Batter").textContent ?? "", /SR 120\.6/);
});

test("all-rounder squad rows show zero wickets", () => {
  const { root } = setupDom();
  createClassicDraftApp({ root, pool: loadDraftPool(rolePlayers()), seed: "ar-zero" });
  click(button(root, "Spin"));

  assert.match(squadRow(root, "All Round One").textContent ?? "", /Bowl 0 wkts/);
});

test("reveal shows every Boost V1 state and offers Begin Season without a replacement selector", () => {
  const { root } = setupDom();
  const pool = loadDraftPool([promotedPlayer(), ...players()]);
  createClassicDraftApp({ root, pool, seed: "web-season-setup", initialState: createCompletedState(pool.players) });

  click(button(root, "Reveal Team"));

  assert.equal(root.querySelector(".completed-team-boosts h2")?.textContent, "Boosts");
  assert.deepEqual(
    [...root.querySelectorAll<HTMLElement>(".boost-state")].map((node) => ({
      id: node.dataset.boostId,
      state: node.querySelector(".boost-state-value")?.textContent,
    })),
    [
      { id: "strong_opening_pair", state: "Inactive" },
      { id: "sufficient_bowling_coverage", state: "Inactive" },
      { id: "balanced_construction", state: "Inactive" },
    ],
  );
  assert.equal(root.querySelector("#replacement-franchise"), null);
  assert.equal(button(root, "Begin Season").disabled, false);
});

test("Boosts presentation supports partial and fully active states", () => {
  assert.deepEqual(renderedBoostStates(effectPlayers(false)), ["Active", "Inactive", "Inactive"]);
  assert.deepEqual(renderedBoostStates(effectPlayers(true)), ["Active", "Active", "Active"]);
});

test("season is precomputed once and progress reveals stored W-L results without score totals", () => {
  const { root } = setupDom();
  const fixture = canonicalWebFixture();
  const callbacks: (() => void)[] = [];
  let leagueCalls = 0;
  let playoffCalls = 0;
  let replacedFranchiseId: string | null = null;
  const scrollTargets: string[] = [];
  createClassicDraftApp({
    root,
    pool: fixture.pool,
    seed: "web-progress",
    initialState: fixture.state,
    scheduleProgressStep: (callback) => callbacks.push(callback),
    scrollToSection: (id) => scrollTargets.push(id),
    simulationServices: {
      buildProfiles: buildOpponentStrengthProfiles2016,
      simulateLeague: (input) => {
        leagueCalls += 1;
        replacedFranchiseId = input.teams.find((team) => team.teamId === "user")?.replacedFranchiseId ?? null;
        return simulateLeagueV1(input);
      },
      simulatePlayoffs: (input) => { playoffCalls += 1; return simulatePlayoffsV1(input); },
    },
  });
  click(button(root, "Reveal Team"));
  click(button(root, "Begin Season"));

  assert.equal(leagueCalls, 1);
  assert.equal(playoffCalls, 1);
  assert.equal(replacedFranchiseId, "delhi-daredevils");
  assert.deepEqual(scrollTargets, ["league-stage"]);
  assert.notEqual(root.querySelector(".completed-team-screen"), null);
  assert.equal(findButton(root, "Begin Season"), null);
  assert.equal(root.querySelectorAll(".league-progress-segment").length, 14);
  assert.ok([...root.querySelectorAll(".league-progress-segment")].every((segment) => segment.textContent === ""));
  assert.match(root.textContent ?? "", /0 of 14 matches complete/);
  assert.match(root.textContent ?? "", /Record0–0/);

  callbacks.shift()!();
  assert.match(root.querySelector(".league-progress-segment")?.textContent ?? "", /^[WL]$/);
  assert.ok([...root.querySelectorAll(".league-progress-segment")].every((segment) => ["", "W", "L"].includes(segment.textContent ?? "")));
  assert.equal(leagueCalls, 1);
  assert.equal(playoffCalls, 1);
  assert.deepEqual(scrollTargets, ["league-stage"]);

  flushCallbacks(callbacks);
  assert.match(root.textContent ?? "", /Final Standings/);
  assert.equal(root.querySelectorAll(".final-table tbody tr").length, 8);
  assert.match(root.textContent ?? "", /Top Run Scorers/);
  assert.match(root.textContent ?? "", /Top Wicket Takers/);
  assert.equal(leagueCalls, 1);
  assert.equal(playoffCalls, 1);
  assert.match(root.textContent ?? "", /14 of 14 matches complete/);
  assert.match(root.querySelector('[data-team-id="user"]')?.textContent ?? "", /Your XI/);
  assert.doesNotMatch(root.querySelector(".league-progress-segments")?.textContent ?? "", /\d+\/\d+/);
  assert.doesNotMatch(root.textContent ?? "", /DA Warner|V Kohli|BB McCullum/);
});

test("internal replacement slot is deterministic for the same app seed", () => {
  const captureReplacement = (): string | null => {
    const { root } = setupDom();
    const fixture = canonicalWebFixture();
    let replacement: string | null = null;
    createClassicDraftApp({
      root,
      pool: fixture.pool,
      seed: "same-internal-slot",
      initialState: fixture.state,
      scheduleProgressStep: () => undefined,
      simulationServices: {
        buildProfiles: buildOpponentStrengthProfiles2016,
        simulateLeague: (input) => {
          replacement = input.teams.find((team) => team.teamId === "user")?.replacedFranchiseId ?? null;
          return simulateLeagueV1(input);
        },
        simulatePlayoffs: simulatePlayoffsV1,
      },
    });
    click(button(root, "Reveal Team"));
    click(button(root, "Begin Season"));
    return replacement;
  };
  assert.equal(captureReplacement(), "delhi-daredevils");
  assert.equal(captureReplacement(), "delhi-daredevils");
});

test("non-qualified and qualified season endings render only the permitted playoff detail", () => {
  const nonQualified = runControlledSeason(false);
  assert.match(nonQualified.root.textContent ?? "", /Missed Playoffs/);
  assert.notEqual(findButton(nonQualified.root, "Start New Draft"), null);
  assert.equal(findButton(nonQualified.root, "Begin Playoffs"), null);
  assert.equal(nonQualified.root.querySelector(".playoffs-stage"), null);
  assert.equal(nonQualified.root.querySelector(".awards"), null);

  const qualified = runControlledSeason(true);
  assert.deepEqual(qualified.scrollTargets, ["league-stage"]);
  assert.notEqual(findButton(qualified.root, "Begin Playoffs"), null);
  assert.equal(qualified.root.querySelector(".playoffs-stage"), null);
  click(button(qualified.root, "Begin Playoffs"));
  assert.deepEqual(qualified.scrollTargets, ["league-stage", "playoffs"]);
  assert.equal(findButton(qualified.root, "Begin Playoffs"), null);
  assert.equal(findButton(qualified.root, "Start New Draft"), null);
  assert.doesNotMatch(qualified.root.querySelector(".league-stage")?.textContent ?? "", /Missed Playoffs/);
  assert.equal(qualified.root.querySelectorAll(".playoff-match").length, 0);
  assert.match(qualified.root.querySelector(".playoff-current-match")?.textContent ?? "", /Qualifier 1.*Opponent:/);
  const playoffControls = [...qualified.root.querySelectorAll<HTMLButtonElement>(".playoff-actions button")];
  assert.deepEqual(playoffControls.map((control) => control.textContent), ["Progress to End", "Simulate Next Match"]);
  assert.ok(playoffControls[0]?.classList.contains("season-secondary-action"));
  assert.ok(playoffControls[1]?.classList.contains("season-primary-action"));
  click(button(qualified.root, "Simulate Next Match"));
  assert.equal(qualified.root.querySelectorAll(".playoff-match").length, 1);
  assert.match(qualified.root.querySelector(".playoff-toss")?.textContent ?? "", /Toss: .* won the toss and chose to (bat|bowl)\./);
  assert.match(qualified.root.querySelector(".playoff-current-match")?.textContent ?? "", /(Qualifier 2|Final).*Opponent:/);
  click(button(qualified.root, "Progress to End"));
  assert.match(qualified.root.textContent ?? "", /Qualifier 1/);
  assert.notEqual(qualified.root.querySelector(".season-terminal-outcome"), null);
  assert.ok(qualified.root.querySelectorAll(".playoff-match").length >= 2);
  assert.ok([...qualified.root.querySelectorAll(".playoff-match")].every((match) => match.textContent?.includes("Opponent:")));
  assert.doesNotMatch(qualified.root.querySelector(".playoffs-stage")?.textContent ?? "", /\d+\/\d+|\(\d+\.\d+\)/);
  assert.doesNotMatch(qualified.root.textContent ?? "", /DA Warner|V Kohli|BB McCullum/);
  assert.equal(qualified.root.querySelector(".awards"), null);
});

test("cosmetic playoff toss is deterministic for the same stored season", () => {
  const first = runControlledSeason(true);
  const second = runControlledSeason(true);
  click(button(first.root, "Begin Playoffs"));
  click(button(second.root, "Begin Playoffs"));
  click(button(first.root, "Simulate Next Match"));
  click(button(second.root, "Simulate Next Match"));
  assert.equal(
    first.root.querySelector(".playoff-toss")?.textContent,
    second.root.querySelector(".playoff-toss")?.textContent,
  );
});

test("an Eliminator loss ends the visible playoff path immediately", () => {
  const { root } = runPlayoffRoute(0, 3);
  assert.match(root.querySelector(".playoff-current-match")?.textContent ?? "", /Eliminator.*Opponent:/);
  click(button(root, "Simulate Next Match"));
  assert.equal(root.querySelectorAll(".playoff-match").length, 1);
  assert.match(root.textContent ?? "", /Eliminated in Eliminator/);
  assert.deepEqual(playoffStageHeadings(root), ["Eliminator"]);
  assert.equal(findButton(root, "Simulate Next Match"), null);
  assert.notEqual(findButton(root, "Start New Draft"), null);
});

test("a Qualifier 1 loss continues to Qualifier 2 and stops after elimination", () => {
  const { root } = runPlayoffRoute(0, 1);
  assert.match(root.querySelector(".playoff-current-match")?.textContent ?? "", /Qualifier 1/);
  click(button(root, "Simulate Next Match"));
  assert.match(root.querySelector(".playoff-current-match")?.textContent ?? "", /Qualifier 2/);
  click(button(root, "Simulate Next Match"));
  assert.equal(root.querySelectorAll(".playoff-match").length, 2);
  assert.match(root.textContent ?? "", /Eliminated in Qualifier 2/);
  assert.deepEqual(playoffStageHeadings(root), ["Qualifier 1", "Qualifier 2"]);
});

test("a Final loss shows the Runner-up terminal outcome", () => {
  const { root } = runPlayoffRoute(2, 1);
  click(button(root, "Simulate Next Match"));
  assert.match(root.querySelector(".playoff-current-match")?.textContent ?? "", /Final/);
  click(button(root, "Simulate Next Match"));
  assert.equal(root.querySelectorAll(".playoff-match").length, 2);
  assert.match(root.textContent ?? "", /Runner-up/);
  assert.doesNotMatch(root.textContent ?? "", /Eliminator|Qualifier 2/);
});

test("a title-winning route ends as Champion with terminal restart", () => {
  const { root } = runPlayoffRoute(7, 1);
  click(button(root, "Progress to End"));

  assert.equal(root.querySelector(".season-outcome")?.textContent, "Champion");
  assert.notEqual(findButton(root, "Start New Draft"), null);
  assert.equal(findButton(root, "Simulate Next Match"), null);
});

test("resetting during progress prevents queued callbacks from restoring season results", () => {
  const { root } = setupDom();
  const fixture = canonicalWebFixture();
  const callbacks: (() => void)[] = [];
  const app = createClassicDraftApp({
    root, pool: fixture.pool, seed: "restart-progress", initialState: fixture.state,
    scheduleProgressStep: (callback) => callbacks.push(callback),
  });
  click(button(root, "Reveal Team"));
  click(button(root, "Begin Season"));
  app.setStateForTest(createClassicDraftState());
  flushCallbacks(callbacks);

  assert.match(root.textContent ?? "", /Ready to start/);
  assert.equal(root.querySelector(".league-progress"), null);
  assert.equal(root.querySelector(".season-results"), null);
});

function setupDom(): { root: HTMLElement } {
  const dom = new JSDOM("<!doctype html><main id=\"app\"></main>");
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.HTMLButtonElement = dom.window.HTMLButtonElement;
  return { root: dom.window.document.querySelector<HTMLElement>("#app")! };
}

function canonicalWebFixture() {
  const pool = loadDraftPool(
    JSON.parse(readFileSync("data/processed/2016/rated_player_seasons.json", "utf8")) as unknown,
  );
  return {
    pool,
    state: buildCuratedOpponentState2016(pool, CURATED_OPPONENT_XIS_2016[0]),
  };
}

function flushCallbacks(callbacks: (() => void)[]): void {
  while (callbacks.length > 0) callbacks.shift()!();
}

function runControlledSeason(qualified: boolean): { root: HTMLElement; scrollTargets: string[] } {
  const { root } = setupDom();
  const fixture = canonicalWebFixture();
  const callbacks: (() => void)[] = [];
  const scrollTargets: string[] = [];
  createClassicDraftApp({
    root,
    pool: fixture.pool,
    seed: qualified ? "qualified-web" : "non-qualified-web",
    initialState: fixture.state,
    scheduleProgressStep: (callback) => callbacks.push(callback),
    scrollToSection: (id) => scrollTargets.push(id),
    simulationServices: {
      buildProfiles: buildOpponentStrengthProfiles2016,
      simulateLeague: (input) => moveUserInTable(simulateLeagueV1(input), qualified ? 1 : 8),
      simulatePlayoffs: simulatePlayoffsV1,
    },
  });
  click(button(root, "Reveal Team"));
  click(button(root, "Begin Season"));
  flushCallbacks(callbacks);
  return { root, scrollTargets };
}

function runPlayoffRoute(seedIndex: number, position: 1 | 3): { root: HTMLElement } {
  const { root } = setupDom();
  const fixture = canonicalWebFixture();
  const callbacks: (() => void)[] = [];
  createClassicDraftApp({
    root,
    pool: fixture.pool,
    seed: `route-web-${seedIndex}-${position}`,
    initialState: fixture.state,
    scheduleProgressStep: (callback) => callbacks.push(callback),
    simulationServices: {
      buildProfiles: buildOpponentStrengthProfiles2016,
      simulateLeague: (input) => moveUserInTable(
        simulateLeagueV1({ ...input, seed: `route-find-${seedIndex}` }),
        position,
      ),
      simulatePlayoffs: simulatePlayoffsV1,
    },
  });
  click(button(root, "Reveal Team"));
  click(button(root, "Begin Season"));
  flushCallbacks(callbacks);
  click(button(root, "Begin Playoffs"));
  return { root };
}

function moveUserInTable(result: LeagueSimulationResult, position: number): LeagueSimulationResult {
  const previousPosition = result.userRecord.tablePosition;
  const pointsTable = result.pointsTable.map((row) => {
    let nextPosition = row.position;
    if (row.teamId === "user") nextPosition = position;
    else if (row.position === position) nextPosition = previousPosition;
    return { ...row, position: nextPosition, qualified: nextPosition <= 4 };
  }).sort((left, right) => left.position - right.position);
  return {
    ...result,
    pointsTable,
    userRecord: { ...result.userRecord, tablePosition: position },
    userQualified: position <= 4,
  };
}

function click(node: HTMLButtonElement): void {
  node.click();
}

function button(root: HTMLElement, label: string): HTMLButtonElement {
  const found = findButton(root, label);
  assert.ok(found, `Expected button ${label}`);
  return found;
}

function findButton(root: HTMLElement, label: string): HTMLButtonElement | null {
  return [...root.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === label) ?? null;
}

function playoffStageHeadings(root: HTMLElement): string[] {
  return [...root.querySelectorAll<HTMLElement>(".playoff-match h3")].map((heading) => heading.textContent ?? "");
}

function squadRow(root: HTMLElement, name: string): HTMLButtonElement {
  const found = [...root.querySelectorAll<HTMLButtonElement>(".squad-row")].find((node) => node.textContent?.includes(name));
  assert.ok(found, `Expected squad row ${name}`);
  return found;
}

function slotButton(root: HTMLElement, position: BattingPosition): HTMLButtonElement {
  const found = root.querySelector<HTMLButtonElement>(`.slot[data-position="${position}"]`);
  assert.ok(found, `Expected slot ${position}`);
  return found;
}

function revealRow(root: HTMLElement, position: BattingPosition): HTMLElement {
  const found = root.querySelector<HTMLElement>(`.completed-xi-row[data-position="${position}"]`);
  assert.ok(found, `Expected revealed row ${position}`);
  return found;
}

function playerRowNames(root: HTMLElement): string[] {
  return [...root.querySelectorAll<HTMLElement>(".player-name")].map((node) => node.textContent ?? "");
}

function squadRowsText(root: HTMLElement): string {
  return [...root.querySelectorAll<HTMLElement>(".squad-row")].map((node) => node.textContent ?? "").join("\n");
}

function groupedPlayerRowNames(root: HTMLElement): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  for (const group of root.querySelectorAll<HTMLElement>(".squad-group")) {
    const heading = group.querySelector("h3")?.textContent ?? "";
    groups[heading] = [...group.querySelectorAll<HTMLElement>(".player-name")].map((node) => node.textContent ?? "");
  }
  return groups;
}

function detailsText(root: HTMLElement): string {
  return root.querySelector(".active-details")?.textContent ?? "";
}

function assertNoRatedLeakage(root: HTMLElement): void {
  const text = root.textContent ?? "";
  assert.doesNotMatch(text, /Base rating|Draft tier|Absolute tier|Coverage promotion|Rating confidence|Effective player rating|Overall team rating|69\.6|75\.7/);
}

function createCompletedState(playerPool: DraftPlayerSeason[]): ClassicDraftState {
  return {
    ...createClassicDraftState(),
    slots: Array.from({ length: 11 }, (_, index) => ({
      position: (index + 1) as BattingPosition,
      player: playerPool[index % playerPool.length]!,
    })),
    currentSquadKey: "2016 Team A",
    completed: true,
  };
}

function renderedBoostStates(playerPool: DraftPlayerSeason[]): string[] {
  const { root } = setupDom();
  const pool = loadDraftPool(playerPool);
  createClassicDraftApp({
    root,
    pool,
    seed: "boost-presentation",
    initialState: createCompletedState(playerPool),
  });
  click(button(root, "Reveal Team"));
  return [...root.querySelectorAll<HTMLElement>(".boost-state-value")]
    .map((node) => node.textContent ?? "");
}

function effectPlayers(withBowlingCoverage: boolean): DraftPlayerSeason[] {
  return Array.from({ length: 11 }, (_, index) => {
    const position = (index + 1) as BattingPosition;
    const frontline = withBowlingCoverage && position >= 3 && position <= 6;
    const secondary = withBowlingCoverage && position >= 7 && position <= 8;
    return player({
      id: `effect-${position}`,
      playerId: `effect-${position}`,
      name: `Effect Player ${position}`,
      seasonRole: frontline || secondary ? "batting_all_rounder" : "batter",
      preferredBattingPositions: [position],
      naturalPositions: [position],
      acceptablePositions: [position],
      bowlingOptionStrength: frontline ? "frontline" : secondary ? "secondary" : "none",
      battingRating: 70,
      bowlingRating: frontline || secondary ? 70 : null,
      baseRating: 70,
      absoluteTier: "A",
      draftTier: "A",
      isWicketkeeper: position === 1,
    });
  });
}

function players(): DraftPlayerSeason[] {
  return [
    player({
      id: "wk",
      playerId: "wk",
      name: "WK Batter",
      isWicketkeeper: true,
      preferredBattingPositions: [4],
      naturalPositions: [4],
      acceptablePositions: [3, 4, 5],
    }),
    player({
      id: "bowler",
      playerId: "bowler",
      name: "Frontline Bowler",
      seasonRole: "bowler",
      bowlingOptionStrength: "frontline",
      preferredBattingPositions: [10],
      naturalPositions: [10],
      acceptablePositions: [9, 10, 11],
    }),
    player({
      id: "overseas",
      playerId: "overseas",
      name: "Overseas Batter",
      isOverseas: true,
      country: "Australia",
    }),
  ];
}

function rolePlayers(): DraftPlayerSeason[] {
  return [
    player({
      id: "beta-batter",
      playerId: "beta-batter",
      name: "Beta Batter",
      seasonRole: "batter",
      displayedStats: stats({ runs: 210, battingAverage: 17.34, strikeRate: 120.56, wickets: 0, economy: null }),
    }),
    player({
      id: "alpha-batter",
      playerId: "alpha-batter",
      name: "Alpha Batter",
      seasonRole: "batter",
      displayedStats: stats({ runs: 210, battingAverage: 42, strikeRate: 130, wickets: 0, economy: null }),
    }),
    player({
      id: "keeper",
      playerId: "keeper",
      name: "Keeper One",
      seasonRole: "wicketkeeper_batter",
      isWicketkeeper: true,
      displayedStats: stats({ runs: 180, battingAverage: 30, strikeRate: 125, wickets: 0, economy: null }),
    }),
    player({
      id: "ar-one",
      playerId: "ar-one",
      name: "All Round One",
      seasonRole: "batting_all_rounder",
      bowlingOptionStrength: "secondary",
      displayedStats: stats({ runs: 90, battingAverage: 22, strikeRate: 135, wickets: 0, economy: null }),
    }),
    player({
      id: "ar-two",
      playerId: "ar-two",
      name: "All Round Two",
      seasonRole: "bowling_all_rounder",
      bowlingOptionStrength: "frontline",
      displayedStats: stats({ runs: 120, battingAverage: 20, strikeRate: 140, wickets: 7, economy: 7.95 }),
    }),
    player({
      id: "bowler-b",
      playerId: "bowler-b",
      name: "Bowler B",
      seasonRole: "bowler",
      bowlingOptionStrength: "frontline",
      displayedStats: stats({ runs: 4, battingAverage: 4, strikeRate: 50, wickets: 11, economy: 7.01 }),
    }),
    player({
      id: "bowler-a",
      playerId: "bowler-a",
      name: "Bowler A",
      seasonRole: "bowler",
      bowlingOptionStrength: "frontline",
      displayedStats: stats({ runs: 2, battingAverage: 2, strikeRate: 40, wickets: 11, economy: 6.99 }),
    }),
    player({
      id: "overseas-batter",
      playerId: "overseas-batter",
      name: "Overseas Batter",
      seasonRole: "batter",
      isOverseas: true,
      country: "Australia",
      displayedStats: stats({ runs: 75, battingAverage: 25, strikeRate: 150, wickets: 0, economy: null }),
    }),
  ];
}

function promotedPlayer(): DraftPlayerSeason {
  return player({
    id: "promoted",
    playerId: "promoted",
    name: "Promoted Star",
    battingRating: 75.7,
    bowlingRating: null,
    baseRating: 69.6,
    ratingConfidence: "high",
    absoluteTier: "A",
    draftTier: "S",
    tierAdjustment: "franchise_coverage",
  });
}

function stats(overrides: Partial<DraftPlayerSeason["displayedStats"]>): DraftPlayerSeason["displayedStats"] {
  return {
    matches: 1,
    inningsBatted: 1,
    runs: 10,
    ballsFaced: 8,
    battingAverage: 10,
    strikeRate: 125,
    wickets: 0,
    legalBallsBowled: 0,
    runsConceded: 0,
    economy: null,
    ...overrides,
  };
}

function player(overrides: Partial<DraftPlayerSeason>): DraftPlayerSeason {
  return {
    id: "id",
    playerId: "player-id",
    name: "Player",
    franchise: "Team A",
    season: 2016,
    sourceSeason: "2016",
    matchesPlayed: 1,
    seasonRole: "batter",
    preferredBattingPositions: [1],
    naturalPositions: [1],
    acceptablePositions: [1, 2],
    positionConfidence: "medium",
    bowlingOptionStrength: "none",
    displayedStats: {
      matches: 1,
      inningsBatted: 1,
      runs: 10,
      ballsFaced: 8,
      battingAverage: 10,
      strikeRate: 125,
      wickets: 0,
      legalBallsBowled: 0,
      runsConceded: 0,
      economy: null,
    },
    draftEligible: true,
    country: "India",
    isOverseas: false,
    isWicketkeeper: false,
    battingRating: 50,
    bowlingRating: null,
    baseRating: 50,
    ratingConfidence: "medium",
    absoluteTier: "C",
    draftTier: "C",
    tierAdjustment: null,
    ...overrides,
  };
}
