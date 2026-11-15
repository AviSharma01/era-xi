import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { fitDisplay, REJECTION_COPY, rejectionReason, TEAM_ABBREVIATIONS } from "../../copy.js";
import { DraftExperience } from "../../eraDraftApp.js";
import { loadEraDraftCatalog } from "../../eraDraftData.js";
import { createEraDraftGame, reduceEraDraft } from "../../eraDraftEngine.js";
import { projectEraDraftPublicState } from "../../eraDraftProjection.js";
import type { EraDraftState, EraDraftTransitionResult } from "../../eraDraftTypes.js";
import { ERA_IDS } from "../../teamEvaluationV2.js";
import { TEAM_EVALUATION_V3_VERSION } from "../../teamEvaluationV3.js";
import { ERA_REEL_SEASONS, REEL_TRAVEL, reelRest, reelStrip } from "./reel.js";

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

test("the reel shows real franchise-seasons throughout, travels 18 to 28 tiles and uses no engine randomness", () => {
  const travels = new Set<number>();
  for (const eraId of ERA_IDS) {
    const seasons = Object.entries(ERA_REEL_SEASONS[eraId]).flatMap(([year, teams]) => teams.split(" ").map((team) => `${team} ${year}`));
    for (let seed = 0; seed < 40; seed += 1) {
      const [abbreviation, year] = seasons[seed % seasons.length]!.split(" ");
      const input = { eraId, abbreviation: abbreviation!, year: Number(year), seed: `${seed}:${eraId}` };
      const { tiles, startIndex, resultIndex } = reelStrip(input);
      const travel = resultIndex - startIndex;
      travels.add(travel);
      assert.ok(travel >= REEL_TRAVEL.min && travel <= REEL_TRAVEL.max, `travel ${travel}`);
      assert.deepEqual(tiles[resultIndex], { kind: "result", abbreviation: input.abbreviation, year: input.year });
      assert.ok(startIndex >= 3 && tiles.length - resultIndex - 1 >= 3, "real tiles fill the window either side of the start and the stop");
      tiles.forEach((tile, index) => {
        assert.ok(seasons.includes(`${tile.abbreviation} ${tile.year}`), "every tile is a real franchise-season of the era, never a blank");
        if (index !== resultIndex) assert.equal(tile.kind, "season");
        if (index !== resultIndex) assert.ok(!(tile.abbreviation === input.abbreviation && tile.year === input.year), "the result never shows early or as a neighbour");
        if (index > 0) assert.notDeepEqual(tile, tiles[index - 1], "no tile repeats its neighbour");
      });
      assert.deepEqual(reelStrip(input), reelStrip(input), "same seed, same strip");
    }
  }
  assert.ok(travels.size >= 8, "the stop can't be read from the distance");
  const rest = reelRest({ eraId: "era-impact", seed: "rest:3" });
  assert.equal(rest.tiles.length, rest.centerIndex * 2 + 1);
  assert.ok(rest.tiles.every((tile) => tile.kind === "season"), "the reel at rest shows real tiles too");
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
    assert.match(card.textContent!, /Can’t pick · Overseas limit reached/);
    assert.doesNotMatch(card.textContent!, /four overseas/, "the engine's sentence is never shown");
    assert.equal(card.querySelector(".player-card-flash"), null);
    assert.equal(ui.element.querySelector(".drafting-lock"), null);
    assert.equal(ui.element.querySelector(".xi-slot-active"), null, "no slot lights for a player who can't be picked");
    assert.match(card.getAttribute("aria-label")!, /\. Can’t pick · Overseas limit reached$/, "the card's name carries the reason");
    assert.equal(card.querySelector(".player-card-banner")!.textContent, "Can’t pick · Overseas limit reached");
    const name = card.querySelector(".player-card-name")!.textContent!;
    const open = [...ui.element.querySelectorAll<HTMLButtonElement>(".xi-slot-unlit")];
    assert.ok(open.length > 0 && open.every((slot) => !slot.disabled && slot.getAttribute("aria-disabled") === "true"));
    assert.equal(open[0]!.getAttribute("aria-label"), `Position ${open[0]!.closest<HTMLElement>(".xi-slot")!.dataset.position} · Open position · ${name} can’t be placed: Overseas limit reached`);
    const locked = ui.element.querySelectorAll(".xi-slot-locked").length;
    await act(async () => open[0]!.click());
    assert.equal(ui.element.querySelector(".drafting-slot-note")!.textContent, ` ${name} can’t be placed: Overseas limit reached`);
    assert.equal(ui.element.querySelectorAll(".xi-slot-locked").length, locked, "a click changes nothing");
    assert.equal(ui.element.querySelector(".xi-slot-preview"), null);
    await ui.click('.squad-row:not([aria-disabled="true"])');
    assert.ok(ui.element.querySelector(".selected-player-detail .player-card-flash"), "a pickable player flashes");
    assert.equal(ui.element.querySelector(".drafting-slot-note"), null, "the note goes with the blocked player");
  } finally { await ui.close(); }
});

test("lit slots are quiet, with Natural brightest, and S cards on the board take turns with their sweep", async () => {
  let state: EraDraftState = spunGame("batch-3c-lit", TEAM_EVALUATION_V3_VERSION);
  for (let pick = 0; pick < 3; pick += 1) {
    const view = projectEraDraftPublicState(catalog, state as LiveState);
    if (view.phase !== "AWAITING_PICK") assert.fail("Expected roster");
    const player = view.candidates.find((item) => item.available && item.tierAppearance === "violet") ?? view.candidates.find((item) => item.available)!;
    state = accepted(reduceEraDraft(catalog, state, { type: "LOCK_PLAYER", playerTeamSeasonId: player.playerTeamSeasonId, battingPosition: player.positions.find((slot) => slot.available)!.battingPosition }));
    state = accepted(reduceEraDraft(catalog, state, { type: "SPIN" }));
  }
  const view = projectEraDraftPublicState(catalog, state as LiveState);
  if (view.phase !== "AWAITING_PICK") assert.fail("Expected roster");
  const ui = await mount(state as LiveState);
  try {
    const sCards = [...ui.element.querySelectorAll<HTMLElement>(".xi-slot-locked.tier-violet")];
    sCards.forEach((card, index) => {
      assert.equal(card.style.getPropertyValue("--sheen-turn"), String(index));
      assert.equal(card.style.getPropertyValue("--sheen-turns"), String(sCards.length));
    });
    const candidate = view.candidates.find((item) => item.available && item.positions.some((slot) => slot.presentationFit === "NATURAL" && slot.available))!;
    await act(async () => ui.element.querySelectorAll<HTMLButtonElement>(".squad-row")[view.candidates.indexOf(candidate)]!.click());
    for (const slot of candidate.positions.filter((item) => item.available)) {
      const button = ui.element.querySelector(`.xi-slot[data-position="${slot.battingPosition}"] .xi-open-slot`)!;
      assert.ok(button.classList.contains("xi-slot-active"));
      assert.equal(button.classList.contains("xi-slot-natural"), slot.presentationFit === "NATURAL", `slot ${slot.battingPosition}`);
    }
  } finally { await ui.close(); }
});

test("a slot the player can't take says Not available, with the reason on focus or a tap", async () => {
  const { XiBoard } = await import("./XiBoard.js");
  const state = spunGame("batch-3c-slot-level", TEAM_EVALUATION_V3_VERSION);
  const view = projectEraDraftPublicState(catalog, state);
  if (view.phase !== "AWAITING_PICK") assert.fail("Expected roster");
  const player = view.candidates.find((item) => item.available)!;
  const blocked = { ...player, positions: player.positions.map((slot) => slot.battingPosition === 2 ? { ...slot, available: false, reasons: [{ code: "FUTURE_XI_IMPOSSIBLE" as const, message: "x" }] } : slot) };
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const previous = { window: globalThis.window, document: globalThis.document, env: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(dom.window.document.getElementById("root")!);
  const notes: [number, string][] = [];
  const render = (revealed: number | null) => act(async () => root.render(<XiBoard draft={view} selected={blocked} preview={null} pending={null} blocked={false} small={false} arrival={null}
    revealed={revealed} onBlockedSlot={(position, text) => notes.push([position, text])} onPreview={() => assert.fail("never previews")} onConfirm={() => undefined} onInspect={() => undefined} onArrived={() => undefined} />));
  try {
    await render(null);
    const slot = dom.window.document.querySelector<HTMLButtonElement>('.xi-slot[data-position="2"] .xi-open-slot')!;
    assert.ok(slot.classList.contains("xi-slot-blocked") && !slot.classList.contains("xi-slot-active"));
    assert.equal(slot.getAttribute("aria-disabled"), "true");
    assert.match(slot.textContent!, /Not available/);
    assert.match(slot.getAttribute("aria-label")!, /^Position 2 · .* · Would leave no legal XI$/);
    await act(async () => slot.click());
    assert.deepEqual(notes, [[2, "Position 2 is not available: Would leave no legal XI."]]);
    await render(2);
    assert.ok(dom.window.document.querySelector('.xi-slot[data-position="2"] .xi-slot-revealed .xi-open-reason'));
    assert.ok(dom.window.document.querySelector('.xi-slot[data-position="1"] .xi-slot-active'), "legal slots light as normal");
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, { window: previous.window, document: previous.document, IS_REACT_ACT_ENVIRONMENT: previous.env });
    dom.window.close();
  }
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

test("every engine rejection code has a short reason, and the most specific player-level one wins", () => {
  const codes = Object.keys(REJECTION_COPY) as (keyof typeof REJECTION_COPY)[];
  assert.equal(codes.length, 11);
  for (const code of codes) {
    assert.ok(REJECTION_COPY[code].length <= 24, `${code} stays short`);
    assert.equal(rejectionReason([code]), REJECTION_COPY[code]);
  }
  assert.equal(rejectionReason(["S_TIER_LIMIT"]), "S limit reached");
  assert.equal(rejectionReason(["SA_TIER_LIMIT"]), "S+A limit reached");
  assert.equal(rejectionReason(["OVERSEAS_LIMIT"]), "Overseas limit reached");
  assert.equal(rejectionReason(["FUTURE_XI_IMPOSSIBLE"]), "Would leave no legal XI");
  assert.equal(rejectionReason(["POSITION_OCCUPIED", "FUTURE_XI_IMPOSSIBLE"]), "Would leave no legal XI", "a taken slot never explains a player");
  assert.equal(rejectionReason(["POSITION_OCCUPIED", "SA_TIER_LIMIT", "S_TIER_LIMIT"]), "S limit reached");
  assert.equal(rejectionReason(["SA_TIER_LIMIT", "DUPLICATE_CANONICAL_PLAYER"]), "Already in your XI");
  assert.equal(rejectionReason([]), undefined);
});

test("Solo shows only Overseas and WK, and a full cap says so in words", async () => {
  const ui = await mount(spunGame("batch-3b-limits", TEAM_EVALUATION_V3_VERSION));
  try {
    assert.deepEqual([...ui.element.querySelectorAll(".xi-limits .xi-limit-face")].map((face) => face.textContent), ["Overseas 0/4", "WK needed"]);
    assert.equal(ui.element.querySelector(".xi-limit-full"), null);
  } finally { await ui.close(); }
  let state: EraDraftState = spunGame("batch-3b-limits-full", TEAM_EVALUATION_V3_VERSION);
  for (let pick = 0; pick < 4; pick += 1) {
    const view = projectEraDraftPublicState(catalog, state as LiveState);
    if (view.phase !== "AWAITING_PICK") assert.fail("Expected roster");
    const overseas = view.candidates.find((player) => player.available && player.rosterStatus === "OVERSEAS")!;
    state = accepted(reduceEraDraft(catalog, state, { type: "LOCK_PLAYER", playerTeamSeasonId: overseas.playerTeamSeasonId, battingPosition: overseas.positions.find((slot) => slot.available)!.battingPosition }));
    state = accepted(reduceEraDraft(catalog, state, { type: "SPIN" }));
  }
  const full = await mount(state as LiveState);
  try {
    const chip = full.element.querySelector(".xi-limit-overseas.xi-limit-full")!;
    assert.equal(chip.querySelector(".xi-limit-face")!.textContent, "Overseas 4/4 · full");
    assert.equal(chip.querySelector(".sr-status")!.textContent, "Overseas 4 of 4, full");
    const row = full.element.querySelector<HTMLElement>('.squad-row[aria-disabled="true"]')!;
    assert.equal(row.querySelector(".squad-row-reason")!.textContent, "Overseas limit reached");
    assert.equal(full.document.getElementById(row.getAttribute("aria-describedby")!)!.textContent, "Overseas limit reached");
  } finally { await full.close(); }
});
