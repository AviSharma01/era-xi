import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { fitDisplay, TEAM_ABBREVIATIONS } from "../../copy.js";
import { DraftExperience } from "../../eraDraftApp.js";
import { loadEraDraftCatalog } from "../../eraDraftData.js";
import { createEraDraftGame, reduceEraDraft } from "../../eraDraftEngine.js";
import { projectEraDraftPublicState } from "../../eraDraftProjection.js";
import type { EraDraftState, EraDraftTransitionResult } from "../../eraDraftTypes.js";
import { ERA_IDS } from "../../teamEvaluationV2.js";
import { TEAM_EVALUATION_V3_VERSION } from "../../teamEvaluationV3.js";
import { ERA_REEL_SEASONS, reelStrip } from "./reel.js";

const catalog = loadEraDraftCatalog();
type LiveState = Exclude<EraDraftState, { phase: "SETUP" | "REVEALED" | "GAME_COMPLETE" }>;

function accepted(result: EraDraftTransitionResult): EraDraftState {
  if (!result.ok) throw new Error(result.error.message);
  return result.state;
}
function spunGame(seed: string, version?: typeof TEAM_EVALUATION_V3_VERSION): LiveState {
  const game = createEraDraftGame({ catalog, rootSeed: seed, ...(version ? { teamEvaluationVersion: version } : {}) });
  const chosen = accepted(reduceEraDraft(catalog, game, { type: "CHOOSE_ERA", eraId: "era-foundation" }));
  return accepted(reduceEraDraft(catalog, chosen, { type: "SPIN" })) as LiveState;
}
async function mount(state: LiveState) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://example.test/era-draft" });
  const keys = ["window", "document", "HTMLElement", "KeyboardEvent", "IS_REACT_ACT_ENVIRONMENT"];
  const previous = Object.fromEntries(keys.map((key) => [key, (globalThis as Record<string, unknown>)[key]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, KeyboardEvent: dom.window.KeyboardEvent, IS_REACT_ACT_ENVIRONMENT: true });
  const element = dom.window.document.getElementById("root")!;
  const root = createRoot(element);
  await act(async () => root.render(<DraftExperience session={{ catalog, state }} persistenceWarning={null} onAccepted={() => null} onExit={() => undefined} />));
  return {
    element, document: dom.window.document,
    click: async (selector: string) => { const target = element.querySelector<HTMLElement>(selector); assert.ok(target, selector); await act(async () => target.click()); },
    close: async () => { await act(async () => root.unmount()); Object.assign(globalThis, previous); dom.window.close(); },
  };
}

test("fit labels and percentages follow the v3 field; historical games have no percentage", () => {
  assert.deepEqual(fitDisplay("NATURAL", 0), { label: "Natural", percent: null, loss: false, text: "Natural, no loss" });
  assert.deepEqual(fitDisplay("ACCEPTABLE", 5), { label: "Acceptable", percent: "−5%", loss: true, text: "Acceptable −5%" });
  assert.deepEqual(fitDisplay("STRETCH", 12), { label: "Stretch", percent: "−12%", loss: true, text: "Stretch −12%" });
  assert.deepEqual(fitDisplay("MAJOR_STRETCH", 20), { label: "Major stretch", percent: "−20%", loss: true, text: "Major stretch −20%" });
  assert.deepEqual(fitDisplay("MAJOR_STRETCH", 30), { label: "Out of position", percent: "−30%", loss: true, text: "Out of position −30%" });
  assert.deepEqual(fitDisplay("UNKNOWN", 0), { label: "Untested", percent: null, loss: false, text: "Untested, no loss" });
  for (const fit of ["NATURAL", "ACCEPTABLE", "STRETCH", "MAJOR_STRETCH", "UNKNOWN"] as const) {
    const historical = fitDisplay(fit, undefined);
    assert.equal(historical.percent, null);
    assert.doesNotMatch(historical.text, /%/);
  }
  assert.equal(fitDisplay("UNKNOWN", undefined).label, "Acceptable", "historical games keep their current label");
  assert.equal(fitDisplay("MAJOR_STRETCH", undefined).label, "Major Stretch");
});

test("the reel's franchise-seasons are exactly the catalog's", () => {
  for (const eraId of ERA_IDS) {
    const expected: Record<string, string[]> = {};
    for (const teamSeason of catalog.getTeamSeasonsForEra(eraId)) {
      assert.ok(TEAM_ABBREVIATIONS[teamSeason.teamId], teamSeason.teamId);
      (expected[teamSeason.seasonYear] ??= []).push(TEAM_ABBREVIATIONS[teamSeason.teamId]!);
    }
    const actual = Object.fromEntries(Object.entries(ERA_REEL_SEASONS[eraId]).map(([year, teams]) => [year, teams.split(" ").sort()]));
    assert.deepEqual(actual, Object.fromEntries(Object.entries(expected).map(([year, teams]) => [year, teams.sort()])), eraId);
  }
});

test("the reel lands between blanks, shows the result only at the end, and uses no engine randomness", () => {
  for (const kind of ["SPIN", "RESPIN"] as const) {
    const input = { eraId: "era-transition" as const, abbreviation: "MI", year: 2015, kind, seed: "7:ts:team-mumbai-indians:ipl-2015" };
    const { tiles, resultIndex } = reelStrip(input);
    assert.deepEqual(tiles[resultIndex], { kind: "result", abbreviation: "MI", year: 2015 });
    for (const offset of [-2, -1, 1, 2]) assert.deepEqual(tiles[resultIndex + offset], { kind: "blank" }, "nothing else is near the result");
    assert.equal(tiles.length, resultIndex + 3);
    assert.ok(tiles.slice(0, resultIndex - 2).every((tile) => tile.kind === "season"));
    assert.ok(tiles.every((tile) => tile.kind !== "season" || !(tile.abbreviation === "MI" && tile.year === 2015)), "the result never passes early");
    assert.deepEqual(reelStrip(input), reelStrip(input), "same seed, same strip");
    assert.notDeepEqual(reelStrip(input).tiles, reelStrip({ ...input, seed: "8:other" }).tiles);
  }
  assert.ok(reelStrip({ eraId: "era-impact", abbreviation: "CSK", year: 2023, kind: "RESPIN", seed: "s" }).resultIndex
    < reelStrip({ eraId: "era-impact", abbreviation: "CSK", year: 2023, kind: "SPIN", seed: "s" }).resultIndex, "a respin is the same reel, shorter");
});

test("v3 slots name their number, fit and percentage; −20% and −30% differ; losses are coral", async () => {
  const state = spunGame("batch-3a-fit", TEAM_EVALUATION_V3_VERSION);
  const view = projectEraDraftPublicState(catalog, state);
  if (view.phase !== "AWAITING_PICK") assert.fail("Expected roster");
  const ui = await mount(state);
  try {
    const rows = [...ui.element.querySelectorAll<HTMLButtonElement>(".squad-row")];
    const candidate = view.candidates.find((player) => player.available && player.positions.some((slot) => slot.nominalDeductionPercent === 30) && player.positions.some((slot) => slot.nominalDeductionPercent === 20))!;
    assert.ok(candidate, "a batter with both extremes");
    await act(async () => rows[view.candidates.indexOf(candidate)]!.click());
    for (const slot of candidate.positions) {
      const button = ui.element.querySelector<HTMLButtonElement>(`.xi-slot[data-position="${slot.battingPosition}"] .xi-slot-active`)!;
      const expected = fitDisplay(slot.presentationFit, slot.nominalDeductionPercent);
      assert.equal(button.getAttribute("aria-label"), `Position ${slot.battingPosition} · ${expected.text} · Available for preview`);
      assert.match(button.textContent!, new RegExp(`${String(slot.battingPosition).padStart(2, "0")}.*${expected.label}${expected.loss ? `.*${expected.percent}` : ", no loss"}`));
      assert.equal(button.querySelector(".fit-percent-loss")?.textContent ?? null, expected.percent, "only a loss shows a number");
      assert.doesNotMatch(button.querySelector(".fit-badge")!.textContent!, /(^|[^0-9])0%/);
    }
    const labelAt = (percent: number) => ui.element.querySelector(`.xi-slot[data-position="${candidate.positions.find((slot) => slot.nominalDeductionPercent === percent)!.battingPosition}"] .fit-badge`)!.textContent;
    assert.equal(labelAt(20), "Major stretch −20%");
    assert.equal(labelAt(30), "Out of position −30%");
    const stretch = candidate.positions.find((slot) => slot.nominalDeductionPercent === 30)!;
    await ui.click(`.xi-slot[data-position="${stretch.battingPosition}"] .xi-slot-active`);
    assert.match(ui.element.querySelector(".xi-slot-preview")!.getAttribute("aria-label")!, new RegExp(`position ${stretch.battingPosition}, preview, Out of position −30%$`));
    assert.match(ui.element.querySelector(".xi-slot-preview")!.textContent!, /Click again to lock/);
    assert.equal(ui.element.querySelector(".drafting-lock")!.textContent, `Lock in ${String(stretch.battingPosition).padStart(2, "0")}`);
    assert.equal(ui.document.activeElement, ui.element.querySelector(".drafting-lock"), "focus moves to Lock");
  } finally { await ui.close(); }
});

test("historical v2 games keep their labels with no percentage anywhere in the XI", async () => {
  const state = spunGame("batch-3a-historical");
  const view = projectEraDraftPublicState(catalog, state);
  if (view.phase !== "AWAITING_PICK") assert.fail("Expected roster");
  assert.ok(view.candidates.every((player) => player.positions.every((slot) => !Object.hasOwn(slot, "nominalDeductionPercent"))));
  const ui = await mount(state);
  try {
    await ui.click('.squad-row:not([aria-disabled="true"])');
    assert.doesNotMatch(ui.element.querySelector(".xi-board")!.textContent!, /%/);
    assert.ok(ui.element.querySelector(".xi-slot-active")!.getAttribute("aria-label")!.startsWith("Position 1 · "));
    assert.doesNotMatch(ui.element.querySelector(".xi-slot-active")!.getAttribute("aria-label")!, /%/);
    assert.equal(ui.element.querySelector(".fit-percent, .fit-percent-loss"), null);
  } finally { await ui.close(); }
});

test("an unavailable player opens with a visible reason, no flash and no way to place them", async () => {
  let state: EraDraftState = spunGame("batch-3a-overseas", TEAM_EVALUATION_V3_VERSION);
  for (let pick = 0; pick < 4; pick += 1) {
    const view = projectEraDraftPublicState(catalog, state as LiveState);
    if (view.phase !== "AWAITING_PICK") assert.fail("Expected roster");
    const overseas = view.candidates.find((player) => player.available && player.rosterStatus === "OVERSEAS")!;
    state = accepted(reduceEraDraft(catalog, state, { type: "LOCK_PLAYER", playerTeamSeasonId: overseas.playerTeamSeasonId, battingPosition: overseas.positions.find((slot) => slot.available)!.battingPosition }));
    state = accepted(reduceEraDraft(catalog, state, { type: "SPIN" }));
  }
  const ui = await mount(state as LiveState);
  try {
    await ui.click('.squad-row[aria-disabled="true"]');
    const card = ui.element.querySelector(".selected-player-detail")!;
    assert.ok(card.classList.contains("player-card-state-unavailable"));
    assert.match(card.textContent!, /four overseas/);
    assert.equal(card.querySelector(".player-card-flash"), null);
    assert.equal(ui.element.querySelector(".drafting-lock"), null);
    assert.equal(ui.element.querySelector(".xi-slot-active"), null, "no slot lights for a player who can't be picked");
    await ui.click('.squad-row:not([aria-disabled="true"])');
    assert.ok(ui.element.querySelector(".selected-player-detail .player-card-flash"), "a pickable player flashes");
  } finally { await ui.close(); }
});

test("selecting, clearing and locking move focus between the card, the row and Lock", async () => {
  const ui = await mount(spunGame("batch-3a-focus", TEAM_EVALUATION_V3_VERSION));
  try {
    assert.equal(ui.document.activeElement, ui.element.querySelector("#draft-stage-title"));
    await ui.click('.squad-row:not([aria-disabled="true"])');
    const row = ui.element.querySelector(".squad-row-selected")!;
    assert.equal(ui.document.activeElement, ui.element.querySelector(".drafting-dock-card"));
    await ui.click(".drafting-clear");
    assert.equal(ui.element.querySelector(".selected-player-detail"), null);
    assert.equal(ui.document.activeElement, row, "Clear returns to the row");
    await act(async () => (row as HTMLElement).click());
    await act(async () => ui.document.defaultView!.dispatchEvent(new ui.document.defaultView!.KeyboardEvent("keydown", { key: "Escape" })));
    assert.equal(ui.element.querySelector(".selected-player-detail"), null);
    assert.equal(ui.document.activeElement, row, "Escape returns to the row");
  } finally { await ui.close(); }
});
