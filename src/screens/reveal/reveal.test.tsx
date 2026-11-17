import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";

import { REVEAL_COPY } from "../../copy.js";
import { RevealedExperience } from "../../eraDraftApp.js";
import { loadEraDraftCatalog } from "../../eraDraftData.js";
import { createEraDraftGame, reduceEraDraft } from "../../eraDraftEngine.js";
import { projectEraDraftPublicState, projectEraDraftRevealState } from "../../eraDraftProjection.js";
import type { EraDraftState, EraDraftTransitionResult, RevealedState } from "../../eraDraftTypes.js";
import { ERA_IDS, type EraId } from "../../teamEvaluationV2.js";
import { TEAM_EVALUATION_V3_VERSION, type TeamEvaluationV3 } from "../../teamEvaluationV3.js";
import { bowlingCoverage, formatRating, ratingBuild } from "./build.js";

const catalog = loadEraDraftCatalog();

function accepted(result: EraDraftTransitionResult): EraDraftState {
  if (!result.ok) throw new Error(result.error.message);
  return result.state;
}

/** A full draft through the public projection. "natural" takes Natural slots where it can; "worst" the biggest loss. */
function revealed(seed: string, eraId: EraId, strategy: "natural" | "worst", v3 = true): RevealedState {
  let state = accepted(reduceEraDraft(catalog, createEraDraftGame({ catalog, rootSeed: seed, ...(v3 ? { teamEvaluationVersion: TEAM_EVALUATION_V3_VERSION } : {}) }),
    { type: "CHOOSE_ERA", eraId }));
  while (state.phase === "AWAITING_SPIN") {
    const spun = accepted(reduceEraDraft(catalog, state, { type: "SPIN" }));
    if (spun.phase !== "AWAITING_PICK") assert.fail("Expected a squad");
    state = spun;
    const view = projectEraDraftPublicState(catalog, spun);
    if (view.phase !== "AWAITING_PICK") assert.fail("Expected a squad");
    const options = view.candidates.filter((candidate) => candidate.available)
      .flatMap((candidate) => candidate.positions.filter((position) => position.available).map((position) => ({ candidate, position })));
    const score = (option: (typeof options)[number]): number => {
      const loss = option.position.nominalDeductionPercent ?? (option.position.presentationFit === "NATURAL" ? 0 : 10);
      return strategy === "natural" ? -loss : loss;
    };
    const choice = options.reduce((best, option) => (score(option) > score(best) ? option : best));
    state = accepted(reduceEraDraft(catalog, state, { type: "LOCK_PLAYER", playerTeamSeasonId: choice.candidate.playerTeamSeasonId, battingPosition: choice.position.battingPosition }));
  }
  state = accepted(reduceEraDraft(catalog, state, { type: "REVEAL_XI" }));
  if (state.phase !== "REVEALED") assert.fail("Expected reveal");
  return state;
}

const document = (html: string) => new JSDOM(html).window.document;
const sheet = (state: RevealedState) => document(renderToStaticMarkup(<RevealedExperience session={{ catalog, state }} persistenceWarning={null}
  onBeginSeason={() => undefined} onExit={() => undefined} />));

test("the build reconciles to the final team rating, which is the simulation's own number", () => {
  let withLoss = 0;
  for (const eraId of ERA_IDS) for (const strategy of ["worst", "natural"] as const) {
    const state = revealed(`reveal-build-${strategy}`, eraId, strategy);
    const evaluation = state.evaluation as TeamEvaluationV3;
    const view = projectEraDraftRevealState(catalog, state);
    assert.equal(view.evaluation.strength.overall, evaluation.adjustedStrength.overall, "the panel reads the simulation's number");
    const build = ratingBuild(view.evaluation);
    const loss = evaluation.baseStrength.overall - evaluation.adjustedStrength.overall;
    if (!build) {
      assert.equal(formatRating(evaluation.baseStrength.overall), formatRating(evaluation.adjustedStrength.overall), `${eraId} ${strategy}: no build only when nothing shows`);
      continue;
    }
    withLoss += 1;
    assert.ok(Math.abs(build.baseValue - evaluation.baseStrength.overall) < 1e-9, "base is the evaluation's own base overall");
    assert.equal(build.final, formatRating(evaluation.adjustedStrength.overall));
    assert.equal(Math.round(Number(build.base) * 10) - Math.round(Number(build.loss) * 10), Math.round(Number(build.final) * 10), "base − loss = final");
    assert.ok(Math.abs(Number(build.loss) - loss) <= 0.1 + 1e-9);
    const html = sheet(state);
    assert.equal(html.querySelector(".reveal-rating .sr-status")?.textContent, formatRating(evaluation.adjustedStrength.overall));
    assert.match(html.querySelector(".reveal-build-line")?.textContent ?? "", new RegExp(`^Base ${build.base} · Batting order −${build.loss}$`));
  }
  assert.ok(withLoss >= 5, "the worst-fit drafts lose rating");
});

test("a team with no losses shows only the rating; historical games show no build and no percentages", () => {
  const natural = revealed("reveal-natural", "era-transition", "natural");
  const view = projectEraDraftRevealState(catalog, natural);
  assert.equal(ratingBuild(view.evaluation), null);
  const html = sheet(natural);
  assert.equal(html.querySelector(".reveal-build-line"), null);
  assert.equal(html.querySelector(".reveal-rating .sr-status")?.textContent, formatRating(view.evaluation.strength.overall));
  assert.equal(html.querySelectorAll(".team-sheet .fit-percent-loss").length, 0);

  for (const eraId of ERA_IDS) {
    const state = revealed("reveal-historical", eraId, "worst", false);
    const projected = projectEraDraftRevealState(catalog, state);
    assert.equal(projected.evaluation.battingAdjustment, undefined);
    assert.equal(ratingBuild(projected.evaluation), null);
    const markup = sheet(state);
    assert.equal(markup.querySelector(".reveal-build-line"), null);
    assert.equal(markup.querySelector(".reveal-rating .sr-status")?.textContent, formatRating(projected.evaluation.strength.overall));
    assert.doesNotMatch(markup.querySelector(".team-sheet")!.textContent!, /%/);
  }
});

test("the team sheet is a real table with every number as projected", () => {
  const state = revealed("reveal-table", "era-impact", "worst");
  const view = projectEraDraftRevealState(catalog, state);
  const html = sheet(state);
  const table = html.querySelector("table.team-sheet")!;
  assert.equal(table.querySelector("caption")?.textContent, REVEAL_COPY.sheetCaption);
  assert.deepEqual([...table.querySelectorAll("thead th")].map((th) => th.getAttribute("scope")), Array(7).fill("col"));
  const rows = [...table.querySelectorAll("tbody tr")];
  assert.equal(rows.length, 11);
  const players = [...view.players].sort((a, b) => a.battingPosition - b.battingPosition);
  rows.forEach((row, index) => {
    const player = players[index]!;
    assert.equal(row.querySelector("th[scope=row] strong")?.textContent, player.playerName);
    assert.equal(row.querySelector(".revealed-overall")?.textContent, formatRating(player.overallRating));
    assert.match(row.querySelector(".team-sheet-tier")!.textContent!, new RegExp(`^${player.qualityTier}${player.qualityTier} tier$`));
    const fit = row.querySelector(".team-sheet-fit")!.textContent!;
    const percent = player.battingAdjustment!.penaltyPercent;
    if (percent > 0) assert.match(fit, new RegExp(`−${percent}%$`));
    else assert.doesNotMatch(fit, /%/);
    if (player.presentationFit === "UNKNOWN") assert.match(fit, /^Untested/);
  });
  // The old assessment is gone: no verdict, no totals, no rank.
  assert.doesNotMatch(html.body.textContent!, /Team Assessment|Quality mix|Bowling balance|on paper/i);
  assert.equal(html.querySelectorAll("tfoot").length, 0);
});

test("bowling coverage shows only when the deployment is short, and never rounds up to covered", () => {
  const base = { overseasCount: 3, overseasLimit: 4, hasWicketkeeper: true, frontlineBowlers: 4, supportBowlers: 1, requiredBowlingUnits: 5 } as const;
  assert.equal(bowlingCoverage({ ...base, deployedBowlingUnits: 5 }), null);
  assert.equal(bowlingCoverage({ ...base, deployedBowlingUnits: 4 }), "4 of 5 bowling slots covered");
  assert.equal(bowlingCoverage({ ...base, deployedBowlingUnits: 4.5 }), "4.5 of 5 bowling slots covered");
  assert.equal(bowlingCoverage({ ...base, deployedBowlingUnits: 4.96 }), "4.9 of 5 bowling slots covered");
});

async function mount(state: RevealedState, flip: boolean, motion = false) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://example.test/era-draft" });
  // The motion tokens, as the stylesheet sets them; without them the flip ends on the next tick.
  if (motion) for (const [token, value] of [["--motion-reveal-flip", "280ms"], ["--motion-reveal-stagger", "100ms"], ["--motion-reveal-hold", "600ms"]]) dom.window.document.documentElement.style.setProperty(token!, value!);
  const keys = ["window", "document", "HTMLElement", "KeyboardEvent", "IS_REACT_ACT_ENVIRONMENT", "requestAnimationFrame"];
  const previous = Object.fromEntries(keys.map((key) => [key, (globalThis as Record<string, unknown>)[key]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, KeyboardEvent: dom.window.KeyboardEvent,
    IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) });
  const element = dom.window.document.getElementById("root")!;
  const root = createRoot(element);
  const calls = { starts: 0, flipped: 0 };
  await act(async () => root.render(<RevealedExperience session={{ catalog, state }} persistenceWarning={null} flip={flip}
    onFlipDone={() => { calls.flipped += 1; }} onBeginSeason={() => { calls.starts += 1; }} onExit={() => undefined} />));
  return { element, document: dom.window.document, calls,
    close: async () => { await act(async () => root.unmount()); Object.assign(globalThis, previous); dom.window.close(); } };
}

test("after Reveal team the board flips in batting order; a click skips, and focus lands on the team rating", async () => {
  const state = revealed("reveal-flip", "era-foundation", "worst");
  const ui = await mount(state, true, true);
  try {
    const slots = [...ui.element.querySelectorAll<HTMLElement>(".reveal-flip .reveal-slot")];
    assert.equal(slots.length, 11);
    assert.deepEqual(slots.map((slot) => slot.dataset.position), ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"]);
    assert.deepEqual(slots.map((slot) => slot.style.getPropertyValue("--reveal-order")), slots.map((_, index) => String(index)));
    assert.equal(slots.every((slot) => slot.querySelector(".reveal-front") && slot.querySelector(".reveal-back .player-card-overall")), true);
    assert.equal(ui.document.activeElement?.classList.contains("reveal-skip"), true, "Skip is ready for the keyboard");
    assert.equal(ui.element.querySelector(".team-sheet"), null, "nothing else is shown during the flip");
    await act(async () => ui.element.querySelector<HTMLElement>(".reveal-board")!.click());
    assert.equal(ui.element.querySelector(".reveal-flip"), null);
    assert.equal(ui.element.querySelectorAll(".team-sheet tbody tr").length, 11);
    assert.equal(ui.document.activeElement?.textContent, REVEAL_COPY.teamRating);
    assert.equal(ui.calls.flipped, 1);
  } finally { await ui.close(); }
});

test("the revealed XI holds for 600ms after the last flip before the sheet", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ui = await mount(revealed("reveal-hold", "era-transition", "worst"), true, true);
  try {
    await act(async () => t.mock.timers.tick(10 * 100 + 280));
    assert.ok(ui.element.querySelector(".reveal-flip"), "the last card has turned; all eleven stay on the board");
    await act(async () => t.mock.timers.tick(599));
    assert.ok(ui.element.querySelector(".reveal-flip"));
    await act(async () => t.mock.timers.tick(1));
    assert.equal(ui.element.querySelector(".reveal-flip"), null);
    assert.equal(ui.calls.flipped, 1);
  } finally { await ui.close(); }
});

test("without a click the flip ends on its own; a restored reveal opens on the sheet", async () => {
  const state = revealed("reveal-timer", "era-expansion", "worst");
  const flipping = await mount(state, true);
  try {
    // No stylesheet in JSDOM, so the motion tokens read 0 and the flip ends on the next tick.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    assert.equal(flipping.element.querySelector(".reveal-flip"), null);
    assert.equal(flipping.calls.flipped, 1);
  } finally { await flipping.close(); }
  const restored = await mount(state, false);
  try {
    assert.equal(restored.element.querySelector(".reveal-flip"), null);
    assert.equal(restored.element.querySelectorAll(".team-sheet tbody tr").length, 11);
    assert.equal(restored.document.activeElement?.textContent, REVEAL_COPY.teamRating);
  } finally { await restored.close(); }
});

test("focusing the build line highlights the players whose fit cost something, and Start league fires once", async () => {
  const state = revealed("reveal-highlight", "era-modern-pre-impact", "worst");
  const view = projectEraDraftRevealState(catalog, state);
  const costly = [...view.players].filter((player) => (player.battingAdjustment?.deduction ?? 0) > 0).map((player) => player.playerName).sort();
  assert.ok(ratingBuild(view.evaluation) && costly.length > 0);
  const ui = await mount(state, false);
  try {
    const line = ui.element.querySelector<HTMLButtonElement>(".reveal-build-line")!;
    assert.equal(ui.element.querySelectorAll(".team-sheet-highlight").length, 0);
    await act(async () => line.focus());
    const highlighted = [...ui.element.querySelectorAll(".team-sheet-highlight th strong")].map((node) => node.textContent).sort();
    assert.deepEqual(highlighted, costly);
    assert.match(ui.document.getElementById(line.getAttribute("aria-describedby")!)!.textContent!, new RegExp(costly[0]!));
    await act(async () => line.blur());
    assert.equal(ui.element.querySelectorAll(".team-sheet-highlight").length, 0);
    await act(async () => line.click());
    assert.equal(line.getAttribute("aria-pressed"), "true");
    assert.equal(ui.element.querySelectorAll(".team-sheet-highlight").length, costly.length, "a tap keeps them lit");

    const start = ui.element.querySelector<HTMLButtonElement>(".reveal-start")!;
    assert.equal(start.textContent?.trim(), `${REVEAL_COPY.startLeague} →`);
    await act(async () => { start.click(); start.click(); });
    assert.equal(ui.calls.starts, 1);
    assert.equal(start.disabled, true);
    assert.match(start.textContent!, /Starting league…/);
  } finally { await ui.close(); }
});
