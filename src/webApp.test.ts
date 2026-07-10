import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  type BattingPosition,
  type ClassicDraftState,
  type DraftPlayerSeason,
  createClassicDraftState,
  loadDraftPool,
} from "./draftClassic.js";
import { createClassicDraftApp } from "./webApp.js";

test("renders ready state from a loaded draft pool", () => {
  const { root } = setupDom();
  createClassicDraftApp({ root, pool: loadDraftPool(players()), seed: "ready" });

  assert.match(root.textContent ?? "", /Ready to start/);
  assert.equal(button(root, "Spin").disabled, false);
});

test("spin renders the current squad", () => {
  const { root } = setupDom();
  createClassicDraftApp({ root, pool: loadDraftPool(players()), seed: "spin" });

  click(button(root, "Spin"));

  assert.match(root.textContent ?? "", /Current Squad/);
  assert.match(root.textContent ?? "", /WK Batter/);
});

test("selecting a player and open slot creates provisional placement before confirmation", () => {
  const { root } = setupDom();
  const app = createClassicDraftApp({ root, pool: loadDraftPool(players()), seed: "pick" });
  click(button(root, "Spin"));

  click(squadRow(root, "WK Batter"));
  click(slotButton(root, 4));

  assert.equal(app.getState().slots.length, 0);
  assert.match(slotButton(root, 4).textContent ?? "", /Pending WK Batter/);

  click(button(root, "Confirm Pick"));

  assert.equal(app.getState().slots[0]?.position, 4);
  assert.match(slotButton(root, 4).textContent ?? "", /4\. WK Batter/);
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
  assert.match(root.textContent ?? "", /Respinused/);
});

test("start new draft resets completed UI without a page refresh", () => {
  const { root } = setupDom();
  const pool = loadDraftPool(players());
  const completed = createCompletedState(pool.players);
  const app = createClassicDraftApp({ root, pool, seed: "restart", initialState: completed });

  assert.match(root.textContent ?? "", /Completed XI/);
  click(button(root, "Start New Draft"));

  assert.equal(app.getState().slots.length, 0);
  assert.equal(app.getState().currentSquadKey, null);
  assert.match(root.textContent ?? "", /Ready to start/);
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
  assertNoRatedLeakage(root);
  assert.equal(root.querySelector(".tier-s"), null);
});

test("reveal exposes draft tier and base rating with draft-tier styling", () => {
  const { root } = setupDom();
  const pool = loadDraftPool([promotedPlayer(), ...players()]);
  createClassicDraftApp({ root, pool, seed: "reveal", initialState: createCompletedState(pool.players) });

  click(button(root, "Reveal Team"));

  assert.match(slotButton(root, 1).textContent ?? "", /S Tier · Base 69\.6 · Effective 69\.6/);
  assert.ok(slotButton(root, 1).classList.contains("tier-s"));
  assert.equal(slotButton(root, 1).classList.contains("tier-a"), false);
});

test("absolute tier and coverage promotion are available in details after reveal without changing base rating", () => {
  const { root } = setupDom();
  const pool = loadDraftPool([promotedPlayer(), ...players()]);
  createClassicDraftApp({ root, pool, seed: "coverage-details", initialState: createCompletedState(pool.players) });

  click(slotButton(root, 1));
  assert.doesNotMatch(detailsText(root), /Base rating|Draft tier|Absolute tier|Coverage promotion|Rating confidence|69\.6/);

  click(button(root, "Reveal Team"));

  assert.match(detailsText(root), /Base rating: 69\.6/);
  assert.match(detailsText(root), /Draft tier: S/);
  assert.match(detailsText(root), /Absolute tier: A/);
  assert.match(detailsText(root), /Tier adjustment: Coverage promotion/);
  assert.match(detailsText(root), /Rating note: Base rating remains unchanged/);
  assert.match(detailsText(root), /Position distance: 0/);
  assert.match(detailsText(root), /Fit multiplier: 1\.00/);
  assert.match(detailsText(root), /Effective batting rating: 75\.7/);
  assert.match(detailsText(root), /Bowling rating: -/);
  assert.match(detailsText(root), /Batting position penalty: 0\.0/);
  assert.match(detailsText(root), /Effective player rating: 69\.6/);
  assert.match(detailsText(root), /Generated batting rating: 75\.7/);
  assert.match(detailsText(root), /Rating confidence: high/);
  assert.doesNotMatch(detailsText(root), /boost/i);
});

test("team summary uses only confirmed XI facts", () => {
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
  const text = root.textContent ?? "";

  assert.match(text, /Overall team rating: 39\.7/);
  assert.match(text, /Batting composite: 49\.4/);
  assert.match(text, /Bowling composite: 30\.0/);
  assert.match(text, /Batting strength: 50\.0/);
  assert.match(text, /Bowling strength: 30\.0/);
  assert.match(text, /Batting depth: 47\.0/);
  assert.match(text, /Bowling depth: 30\.0/);
  assert.match(text, /Average base rating: 58\.2/);
  assert.match(text, /Average effective player rating: 57\.3/);
  assert.match(text, /Fit rating: 78\.2/);
  assert.match(text, /Tiers: 2 S · 2 A · 2 B · 2 C · 3 D/);
  assert.match(text, /Position fit: 10 natural · 0 acceptable · 1 out of position/);
  assert.match(text, /Overseas: 3\/4/);
  assert.match(text, /Wicketkeeper: Yes/);
  assert.match(text, /Bowling options: 3/);
  assert.match(text, /Bowling breakdown: 1 frontline · 1 secondary · 1 part-time/);
  assert.doesNotMatch(text, /out_of_position|part_time/);
});

test("start new draft clears reveal and transient UI state", () => {
  const { root } = setupDom();
  const pool = loadDraftPool([promotedPlayer(), ...players()]);
  const app = createClassicDraftApp({ root, pool, seed: "restart-reveal", initialState: createCompletedState(pool.players) });

  click(slotButton(root, 1));
  click(button(root, "Reveal Team"));
  assert.match(detailsText(root), /Base rating: 69\.6/);

  click(button(root, "Start New Draft"));

  assert.equal(app.getState().slots.length, 0);
  assert.equal(app.getState().currentSquadKey, null);
  assert.match(root.textContent ?? "", /Ready to start/);
  assert.doesNotMatch(root.textContent ?? "", /Reveal Team|Base rating|Draft tier|69\.6/);
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

  assert.equal(button(root, "Confirm Pick").disabled, true);

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
  assert.match(slotButton(root, 4).textContent ?? "", /Pending WK Batter/);
  assert.equal(button(root, "Confirm Pick").disabled, false);

  click(squadRow(root, "Frontline Bowler"));
  assert.match(detailsText(root), /Frontline Bowler/);
  assert.doesNotMatch(slotButton(root, 4).textContent ?? "", /Pending/);
  assert.equal(button(root, "Confirm Pick").disabled, true);

  click(slotButton(root, 10));
  assert.match(slotButton(root, 10).textContent ?? "", /Pending Frontline Bowler/);
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
  assert.doesNotMatch(slotButton(root, 4).textContent ?? "", /Pending/);
  assert.match(slotButton(root, 5).textContent ?? "", /Pending WK Batter/);
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

function setupDom(): { root: HTMLElement } {
  const dom = new JSDOM("<!doctype html><main id=\"app\"></main>");
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.HTMLButtonElement = dom.window.HTMLButtonElement;
  return { root: dom.window.document.querySelector<HTMLElement>("#app")! };
}

function click(node: HTMLButtonElement): void {
  node.click();
}

function button(root: HTMLElement, label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll("button")].find((node) => node.textContent === label);
  assert.ok(found, `Expected button ${label}`);
  return found as HTMLButtonElement;
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
