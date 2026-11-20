import assert from "node:assert/strict";
import test from "node:test";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";

import { webcrypto } from "node:crypto";

import { LEAGUE_COPY, TEAM_ABBREVIATIONS } from "../../copy.js";
import { SeasonExperience } from "../../eraDraftApp.js";
import { loadEraDraftCatalog, loadEraDraftCatalogDocuments, type EraDraftCatalog } from "../../eraDraftData.js";
import { createEraDraftWebAssets } from "../../eraDraftWebArtifacts.js";
import { fetchScopedEraDraftCatalog } from "../../eraDraftWebData.js";
import { reduceEraDraft } from "../../eraDraftEngine.js";
import { revealEraXi } from "../../eraDraftPhase4TestSupport.js";
import { projectEraDraftGameCompleteState } from "../../eraDraftProjection.js";
import type { GameCompleteState, SeasonMatchView } from "../../eraDraftTypes.js";
import type { EraDraftPresentationCursor } from "../../eraDraftUiPersistence.js";
import type { MatchResultV2 } from "../../simulationV2.js";
import { ERA_IDS, type EraId } from "../../teamEvaluationV2.js";
import { CLOSE_RUNS_MARGIN, isCloseMatch, LAST_OVER_BALLS, matchMargin } from "./match.js";
import { opponentShortNames } from "./names.js";

const catalog = loadEraDraftCatalog();
const seasons = new Map<string, GameCompleteState>();
function season(eraId: EraId, seed: string): GameCompleteState {
  const key = `${eraId}:${seed}`;
  if (!seasons.has(key)) {
    const result = reduceEraDraft(catalog, revealEraXi(catalog, seed, eraId), { type: "SIMULATE_SEASON" });
    if (!result.ok || result.state.phase !== "GAME_COMPLETE") throw new Error("expected a complete season");
    seasons.set(key, result.state);
  }
  return seasons.get(key)!;
}
function findSeason(predicate: (state: GameCompleteState) => boolean): GameCompleteState {
  for (let index = 0; index < 60; index += 1) {
    const state = season("era-transition", `league-ui-${index}`);
    if (predicate(state)) return state;
  }
  throw new Error("expected a deterministic season fixture");
}
const qualified = (): GameCompleteState => findSeason((state) => state.season.userOutcome.qualified);
const notQualified = (): GameCompleteState => findSeason((state) => !state.season.userOutcome.qualified);
const view = (state: GameCompleteState) => projectEraDraftGameCompleteState(catalog, state);

/** A frozen engine result read the way the presentation reads it: innings and the winner only. */
const asView = (match: MatchResultV2): SeasonMatchView => ({ firstInnings: match.innings[0], secondInnings: match.innings[1], winnerTeamId: match.winnerTeamId } as unknown as SeasonMatchView);
/** The decided rule (B), written out from the engine's own result type and margin, for comparison. */
const engineClose = (match: MatchResultV2): boolean => match.resultType === "super_over"
  || (match.resultType === "runs" && match.margin! <= 6)
  || (match.resultType === "wickets" && match.innings[1].balls >= 115);

test("the close-match thresholds are rule B: 6 runs or fewer, a chase of 115 balls or more", () => {
  assert.equal(CLOSE_RUNS_MARGIN, 6);
  assert.equal(LAST_OVER_BALLS, 115);
});

test("the close-match rule matches the engine's results on real simulated seasons: runs margin, last-over chase, Super Over", () => {
  const matches = ERA_IDS.flatMap((eraId) => [0, 1, 2, 3].flatMap((index) => {
    const league = season(eraId, `close-rule-${index}`).season.league;
    return [...league.leagueMatches, ...league.playoffs];
  }));
  const kinds = { closeRuns: 0, wideRuns: 0, lateChase: 0, earlyChase: 0, superOver: 0, boundaryRuns: 0, boundaryBalls: 0 };
  for (const match of matches) {
    const margin = matchMargin(asView(match));
    if (match.resultType === "super_over") { assert.equal(margin.kind, "SUPER_OVER"); kinds.superOver += 1; }
    else {
      assert.deepEqual(margin, { kind: match.resultType === "runs" ? "RUNS" : "WICKETS", value: match.margin }, match.matchId);
      if (match.resultType === "runs") {
        kinds[match.margin! <= CLOSE_RUNS_MARGIN ? "closeRuns" : "wideRuns"] += 1;
        if (match.margin === CLOSE_RUNS_MARGIN || match.margin === CLOSE_RUNS_MARGIN + 1) kinds.boundaryRuns += 1;
      } else {
        kinds[match.innings[1].balls >= LAST_OVER_BALLS ? "lateChase" : "earlyChase"] += 1;
        if (match.innings[1].balls === LAST_OVER_BALLS || match.innings[1].balls === LAST_OVER_BALLS - 1) kinds.boundaryBalls += 1;
      }
    }
    assert.equal(isCloseMatch(asView(match)), engineClose(match), match.matchId);
  }
  // Every branch of the rule, and both sides of each threshold, occur in this real data.
  for (const [kind, count] of Object.entries(kinds)) assert.ok(count > 0, `no ${kind} match in the sample`);
});

test("a defended total won by 6 runs is close and by 7 is not; a chase that ends on ball 115 is close and on 114 is not; a Super Over is close", () => {
  const base = { firstInnings: { teamId: "a", runs: 160, wickets: 6, balls: 120 }, secondInnings: { teamId: "b", runs: 154, wickets: 9, balls: 120 }, winnerTeamId: "a" };
  const match = (patch: object) => ({ ...base, ...patch }) as unknown as SeasonMatchView;
  assert.deepEqual(matchMargin(match({})), { kind: "RUNS", value: 6 });
  assert.equal(isCloseMatch(match({})), true);
  assert.equal(isCloseMatch(match({ secondInnings: { ...base.secondInnings, runs: 153 } })), false, "7 runs");
  // The same margins when the defending side is the one that lost: a close loss is close too.
  assert.equal(isCloseMatch(match({ firstInnings: { ...base.firstInnings, teamId: "user" }, winnerTeamId: "user" })), true);
  const chase = { winnerTeamId: "b", secondInnings: { teamId: "b", runs: 161, wickets: 4, balls: 115 } };
  assert.equal(isCloseMatch(match(chase)), true, "ball 115");
  assert.equal(isCloseMatch(match({ ...chase, secondInnings: { ...chase.secondInnings, balls: 114 } })), false, "ball 114");
  assert.equal(isCloseMatch(match({ ...chase, secondInnings: { ...chase.secondInnings, balls: 120 } })), true, "last ball");
  const tied = { secondInnings: { ...base.secondInnings, runs: 160 } };
  assert.deepEqual(matchMargin(match(tied)), { kind: "SUPER_OVER" });
  assert.equal(isCloseMatch(match({ ...tied, winnerTeamId: "a" })), true, "Super Over won by the side batting first");
  assert.equal(isCloseMatch(match({ ...tied, winnerTeamId: "b" })), true, "Super Over won by the chasing side");
});

test("only close pips carry the marker, and result lines say Your XI in plain cricket words", () => {
  const state = qualified();
  const matches = view(state).league.userMatches;
  const markup = renderToStaticMarkup(<SeasonExperience session={{ catalog, state, cursor: { phase: "LEAGUE", revealedUserMatches: 14 } }}
    persistenceWarning={null} onCursor={() => undefined} onExit={() => undefined} onSameEra={() => undefined} onNewEra={() => undefined} />);
  const dom = new JSDOM(markup);
  const pips = [...dom.window.document.querySelectorAll(".league-pips button")];
  assert.equal(pips.length, 14);
  assert.deepEqual(pips.map((pip) => pip.classList.contains("league-pip-close")), matches.map((checkpoint) => isCloseMatch(checkpoint.match)));
  assert.deepEqual(pips.map((pip) => pip.querySelector(".league-pip-marker") !== null), matches.map((checkpoint) => isCloseMatch(checkpoint.match)));
  assert.equal(dom.window.document.querySelectorAll(".league-pip-fresh, .league-pip-burst, .league-pip-flash").length, 0, "a resumed league replays nothing");
  assert.doesNotMatch(markup, /Era Draft XI/);
  for (const [index, checkpoint] of matches.entries()) {
    const opponent = checkpoint.match.opponent!.teamName;
    const margin = matchMargin(checkpoint.match);
    const words = margin.kind === "SUPER_OVER" ? "in a Super Over" : `by ${margin.value} ${margin.kind === "RUNS" ? "run" : "wicket"}${margin.value === 1 ? "" : "s"}`;
    const line = checkpoint.match.result === "WIN" ? `Your XI beat ${opponent} ${words}` : `${opponent} beat Your XI ${words}`;
    assert.ok(pips[index]!.getAttribute("aria-label")!.includes(line), `${pips[index]!.getAttribute("aria-label")} has ${line}`);
  }
  const rows = [...dom.window.document.querySelectorAll(".league-table tbody tr")];
  assert.equal(rows.find((row) => row.classList.contains("league-row-user"))?.querySelector("th")?.textContent, "Your XI");
});

test("every opponent's short name is its standard abbreviation plus season, from the catalog, in the full and browser catalogs", async () => {
  const assets = createEraDraftWebAssets(loadEraDraftCatalogDocuments());
  const manifestUrl = new URL("https://example.test/data/era-draft/v1/manifest.json");
  const scoped = async (eraId: EraId): Promise<EraDraftCatalog> => fetchScopedEraDraftCatalog({ manifest: assets.manifest, manifestUrl, eraId,
    fetcher: async () => new Response(assets.artifacts.get(assets.manifest.eras.find((entry) => entry.eraId === eraId)!.path)!.json),
    subtle: webcrypto.subtle as unknown as SubtleCrypto });
  for (const eraId of ERA_IDS) {
    for (const source of [catalog, await scoped(eraId)]) {
      const profiles = source.getOpponentProfiles(eraId);
      const names = opponentShortNames(source, eraId);
      assert.ok(profiles.length > 0);
      for (const profile of profiles) {
        const year = source.getTeamSeasonsForEra(eraId).find((item) => item.teamId === profile.teamId && item.seasonId === profile.seasonId)!.seasonYear;
        assert.equal(names.get(profile.candidateId), `${TEAM_ABBREVIATIONS[profile.teamId]} ${year}`, `${eraId} ${profile.candidateId}`);
      }
    }
  }
});

test("the table shows each opponent's full name and its short name, the short one hidden from screen readers", () => {
  const state = qualified();
  const markup = renderToStaticMarkup(<SeasonExperience session={{ catalog, state, cursor: { phase: "LEAGUE", revealedUserMatches: 3 } }}
    persistenceWarning={null} onCursor={() => undefined} onExit={() => undefined} onSameEra={() => undefined} onNewEra={() => undefined} />);
  const document = new JSDOM(markup).window.document;
  const names = opponentShortNames(catalog, state.eraId);
  for (const row of document.querySelectorAll(".league-table tbody tr[data-team]:not(.league-row-user)")) {
    const teamId = row.getAttribute("data-team")!;
    assert.equal(row.querySelector(".league-name-short")?.textContent, names.get(teamId));
    assert.equal(row.querySelector(".league-name-short")?.getAttribute("aria-hidden"), "true");
    assert.equal(row.querySelector(".league-name-full")?.textContent, view(state).league.finalStandings.find((item) => item.teamId === teamId)!.teamName);
  }
});

async function mount(options: { state: GameCompleteState; cursor: EraDraftPresentationCursor; live: boolean; small?: boolean }) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://example.test/era-draft" });
  dom.window.document.documentElement.style.setProperty("--motion-league-match", "700ms");
  let visibility: DocumentVisibilityState = "visible";
  Object.defineProperty(dom.window.document, "visibilityState", { configurable: true, get: () => visibility });
  const keys = ["window", "document", "HTMLElement", "Element", "Node", "KeyboardEvent", "IS_REACT_ACT_ENVIRONMENT", "matchMedia"];
  const previous = Object.fromEntries(keys.map((key) => [key, (globalThis as Record<string, unknown>)[key]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
    Node: dom.window.Node, KeyboardEvent: dom.window.KeyboardEvent, IS_REACT_ACT_ENVIRONMENT: true,
    matchMedia: options.small ? (query: string) => ({ matches: query.includes("max-width"), addEventListener() {}, removeEventListener() {} }) : undefined });
  const element = dom.window.document.getElementById("root")!;
  const root = createRoot(element);
  const cursors: EraDraftPresentationCursor[] = [];
  const shown = { count: 0 };
  function Harness(): ReturnType<typeof SeasonExperience> {
    const [cursor, setCursor] = useState(options.cursor);
    return <SeasonExperience session={{ catalog, state: options.state, cursor }} persistenceWarning={null} live={options.live}
      onLiveShown={() => { shown.count += 1; }} onCursor={(next) => { cursors.push(next); setCursor(next); }}
      onExit={() => undefined} onSameEra={() => undefined} onNewEra={() => undefined} />;
  }
  await act(async () => root.render(<Harness />));
  const button = (name: string) => [...element.querySelectorAll("button")].find((item) => item.textContent?.trim().startsWith(name)) ?? null;
  return {
    element, document: dom.window.document, cursors, shown, button,
    played: () => element.querySelectorAll(".league-pips button").length,
    status: () => element.querySelector('[aria-live="polite"]')?.textContent ?? "",
    setVisibility: async (next: DocumentVisibilityState) => { visibility = next; await act(async () => { dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange")); }); },
    key: async (target: Element, key: string) => act(async () => { target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true })); }),
    close: async () => { await act(async () => root.unmount()); Object.assign(globalThis, previous); dom.window.close(); },
  };
}

test("after Start league, matches reveal one every 0.7s, each step saved through the cursor, then league complete", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ui = await mount({ state: qualified(), cursor: { phase: "LEAGUE", revealedUserMatches: 1 }, live: true });
  try {
    assert.equal(ui.played(), 1);
    assert.equal(ui.shown.count, 1);
    assert.equal(ui.document.activeElement?.tagName, "H1");
    assert.match(ui.status(), /^Match 1\. /, "the live match is announced");
    assert.ok(ui.element.querySelector(".league-pip-fresh"), "match 1 was revealed live");
    assert.equal(ui.button(LEAGUE_COPY.pause)?.textContent?.trim(), LEAGUE_COPY.pause);
    assert.ok(ui.button(LEAGUE_COPY.skip));
    assert.equal(ui.button("Next match"), null);
    await act(async () => ui.button(LEAGUE_COPY.pause)!.focus());
    await act(async () => t.mock.timers.tick(699));
    assert.equal(ui.played(), 1);
    await act(async () => t.mock.timers.tick(1));
    assert.equal(ui.played(), 2);
    assert.equal(ui.element.querySelectorAll(".league-pip-fresh").length, 1);
    assert.equal(ui.element.querySelectorAll(".league-pips button")[1]!.classList.contains("league-pip-fresh"), true, "only the newest pip fills");
    assert.equal(ui.document.activeElement?.textContent?.trim(), LEAGUE_COPY.pause, "auto-play never moves focus");
    for (let match = 3; match <= 14; match += 1) await act(async () => t.mock.timers.tick(700));
    assert.equal(ui.played(), 14);
    assert.deepEqual(ui.cursors.slice(0, 13), Array.from({ length: 13 }, (_, index) => ({ phase: "LEAGUE", revealedUserMatches: index + 2 })));
    await act(async () => t.mock.timers.tick(700));
    assert.deepEqual(ui.cursors.at(-1), { phase: "LEAGUE_COMPLETE" });
    assert.equal(ui.cursors.length, 14);
    assert.ok(ui.element.querySelector(".league-complete"));
    assert.equal(ui.document.activeElement?.textContent, LEAGUE_COPY.completeTitle);
    assert.match(ui.status(), /^League complete\./);
    await act(async () => t.mock.timers.tick(5000));
    assert.equal(ui.cursors.length, 14, "nothing advances past league complete on its own");
  } finally { await ui.close(); }
});

test("Pause holds the league, Resume continues it, and Skip to end jumps to league complete", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ui = await mount({ state: qualified(), cursor: { phase: "LEAGUE", revealedUserMatches: 1 }, live: true });
  try {
    await act(async () => t.mock.timers.tick(700));
    assert.equal(ui.played(), 2);
    await act(async () => ui.button(LEAGUE_COPY.pause)!.click());
    assert.ok(ui.button(LEAGUE_COPY.resume));
    assert.match(ui.element.textContent ?? "", new RegExp(LEAGUE_COPY.paused));
    await act(async () => t.mock.timers.tick(7000));
    assert.equal(ui.played(), 2);
    await act(async () => ui.button(LEAGUE_COPY.resume)!.click());
    await act(async () => t.mock.timers.tick(700));
    assert.equal(ui.played(), 3);
    await act(async () => ui.button(LEAGUE_COPY.skip)!.click());
    assert.deepEqual(ui.cursors.at(-1), { phase: "LEAGUE_COMPLETE" });
    assert.ok(ui.element.querySelector(".league-complete"));
    assert.equal(ui.button(LEAGUE_COPY.skip), null);
  } finally { await ui.close(); }
});

test("auto-play pauses while the tab is hidden and resumes when it is visible again", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ui = await mount({ state: qualified(), cursor: { phase: "LEAGUE", revealedUserMatches: 3 }, live: true });
  try {
    await ui.setVisibility("hidden");
    await act(async () => t.mock.timers.tick(5000));
    assert.equal(ui.played(), 3);
    assert.ok(ui.button(LEAGUE_COPY.pause), "a hidden tab is not a user pause");
    await ui.setVisibility("visible");
    await act(async () => t.mock.timers.tick(700));
    assert.equal(ui.played(), 4);
    // A user pause survives the tab coming back.
    await act(async () => ui.button(LEAGUE_COPY.pause)!.click());
    await ui.setVisibility("hidden");
    await ui.setVisibility("visible");
    await act(async () => t.mock.timers.tick(5000));
    assert.equal(ui.played(), 4);
  } finally { await ui.close(); }
});

test("a saved mid-league game opens on its revealed matches, paused, with nothing replayed or announced", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const state = qualified();
  const ui = await mount({ state, cursor: { phase: "LEAGUE", revealedUserMatches: 7 }, live: false });
  try {
    assert.equal(ui.played(), 7);
    assert.equal(ui.shown.count, 0);
    assert.equal(ui.element.querySelectorAll(".league-pip-fresh, .league-pip-burst, .league-pip-flash").length, 0);
    assert.equal(ui.status(), "");
    assert.ok(ui.button(LEAGUE_COPY.resume));
    await act(async () => t.mock.timers.tick(7000));
    assert.equal(ui.played(), 7);
    assert.equal(ui.cursors.length, 0);
    await act(async () => ui.button(LEAGUE_COPY.resume)!.click());
    await act(async () => t.mock.timers.tick(700));
    assert.equal(ui.played(), 8);
    const fresh = [...ui.element.querySelectorAll(".league-pips button")].map((pip) => pip.classList.contains("league-pip-fresh"));
    assert.deepEqual(fresh, fresh.map((_, index) => index === 7), "only the match revealed after Resume fills");
    const checkpoint = view(state).league.userMatches[7]!;
    assert.equal(ui.element.querySelectorAll(".league-pips button")[7]!.classList.contains(checkpoint.match.result === "WIN" ? "league-pip-burst" : "league-pip-flash"), isCloseMatch(checkpoint.match));
    assert.match(ui.status(), /^Match 8\. /);
  } finally { await ui.close(); }
});

test("a close match revealed live bursts (win) or flashes (loss) on its pip; others only fill", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const state = findSeason((candidate) => view(candidate).league.userMatches.some((checkpoint) => isCloseMatch(checkpoint.match)));
  const matches = view(state).league.userMatches;
  const ui = await mount({ state, cursor: { phase: "LEAGUE", revealedUserMatches: 1 }, live: true });
  try {
    for (let index = 0; index < 14; index += 1) {
      if (index > 0) await act(async () => t.mock.timers.tick(700));
      const pip = ui.element.querySelectorAll(".league-pips button")[index]!;
      const close = isCloseMatch(matches[index]!.match);
      const win = matches[index]!.match.result === "WIN";
      assert.equal(pip.classList.contains("league-pip-fresh"), true);
      assert.equal(pip.classList.contains("league-pip-burst"), close && win, `match ${index + 1}`);
      assert.equal(pip.classList.contains("league-pip-flash"), close && !win, `match ${index + 1}`);
      assert.equal(ui.element.querySelectorAll(".league-pip-burst, .league-pip-flash").length, close ? 1 : 0, "earlier effects are not replayed");
    }
  } finally { await ui.close(); }
});

test("a played pip opens its scores; Escape closes them and returns focus to the pip; arrow keys move between pips", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const state = qualified();
  const ui = await mount({ state, cursor: { phase: "LEAGUE", revealedUserMatches: 5 }, live: true });
  try {
    const pips = () => [...ui.element.querySelectorAll<HTMLButtonElement>(".league-pips button")];
    assert.deepEqual(pips().map((pip) => pip.tabIndex), [-1, -1, -1, -1, 0], "one tab stop, on the latest pip");
    await act(async () => pips()[4]!.focus());
    await ui.key(pips()[4]!, "ArrowLeft");
    assert.equal(ui.document.activeElement, pips()[3]);
    await ui.key(pips()[3]!, "Home");
    assert.equal(ui.document.activeElement, pips()[0]);
    await act(async () => pips()[2]!.click());
    const dialog = ui.element.querySelector('[role="dialog"]')!;
    const match = view(state).league.userMatches[2]!.match;
    assert.ok(dialog.classList.contains("league-popover"));
    assert.equal(pips()[2]!.getAttribute("aria-expanded"), "true");
    assert.match(dialog.textContent ?? "", new RegExp(`Match 3 · v ${match.opponent!.teamName}`));
    assert.equal(dialog.querySelectorAll(".league-innings").length, 2);
    assert.match(dialog.textContent ?? "", new RegExp(`${match.firstInnings.runs}`));
    assert.equal(ui.document.activeElement?.textContent, LEAGUE_COPY.close);
    // A click on the popover's text keeps it open.
    await act(async () => { (dialog as HTMLElement).focus(); });
    assert.ok(ui.element.querySelector('[role="dialog"]'));
    (ui.element.querySelector(".league-popover button") as HTMLButtonElement).focus();
    await act(async () => t.mock.timers.tick(5000));
    assert.equal(ui.played(), 5, "auto-play holds while the scores are open");
    await ui.key(ui.document.activeElement!, "Escape");
    assert.equal(ui.element.querySelector('[role="dialog"]'), null);
    assert.equal(ui.document.activeElement, pips()[2]);
    await act(async () => t.mock.timers.tick(700));
    assert.equal(ui.played(), 6);
  } finally { await ui.close(); }
});

test("on phones the scores open in a bottom sheet that keeps focus until closed", async () => {
  const ui = await mount({ state: qualified(), cursor: { phase: "LEAGUE", revealedUserMatches: 4 }, live: false, small: true });
  try {
    const pip = ui.element.querySelectorAll<HTMLButtonElement>(".league-pips button")[1]!;
    await act(async () => pip.click());
    const sheet = ui.element.querySelector('[role="dialog"]')!;
    assert.ok(sheet.classList.contains("league-sheet"));
    assert.equal(sheet.getAttribute("aria-modal"), "true");
    assert.equal(ui.document.activeElement?.textContent, LEAGUE_COPY.close);
    await ui.key(ui.document.activeElement!, "Tab");
    assert.equal(ui.document.activeElement?.textContent, LEAGUE_COPY.close);
    await act(async () => (ui.document.activeElement as HTMLButtonElement).click());
    assert.equal(ui.element.querySelector('[role="dialog"]'), null);
    assert.equal(ui.document.activeElement, pip);
  } finally { await ui.close(); }
});

test("league complete: the final table with the playoff line under 4th, then Begin playoffs or See your season", async () => {
  for (const [state, next, label] of [[qualified(), { phase: "PLAYOFFS", revealedPlayoffMatches: 1 }, LEAGUE_COPY.beginPlayoffs],
    [notQualified(), { phase: "COMPLETE" }, LEAGUE_COPY.seeSeason]] as const) {
    const ui = await mount({ state, cursor: { phase: "LEAGUE_COMPLETE" }, live: false });
    try {
      const rows = [...ui.element.querySelectorAll(".league-table tbody tr")];
      assert.equal(rows[4]!.classList.contains("league-playoff-line"), true);
      assert.deepEqual(rows.filter((row) => row.hasAttribute("data-team")).map((row) => row.getAttribute("data-team")),
        view(state).league.finalStandings.map((row) => row.teamId));
      assert.equal(ui.element.querySelectorAll(".league-pips-compact .league-pips button").length, 14);
      assert.equal(ui.element.querySelector(".league-controls"), null);
      assert.equal(ui.status(), "", "a restored league complete is not announced again");
      assert.equal(ui.document.activeElement?.textContent, LEAGUE_COPY.completeTitle);
      await act(async () => ui.button(label)!.click());
      assert.deepEqual(ui.cursors, [next]);
    } finally { await ui.close(); }
  }
});
