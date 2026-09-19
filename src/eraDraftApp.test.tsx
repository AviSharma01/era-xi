import assert from "node:assert/strict";
import test from "node:test";
import { act, StrictMode, useState } from "react";

import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { DraftExperience, Landing, LoadingSession, RevealedExperience } from "./eraDraftApp.js";
import { loadEraDraftCatalog } from "./eraDraftData.js";
import { createEraDraftGame, reduceEraDraft } from "./eraDraftEngine.js";
import { projectEraDraftPublicState } from "./eraDraftProjection.js";
import type { AwaitingPickState, EraDraftState, EraDraftTransitionResult } from "./eraDraftTypes.js";
import type { EraDraftUiSaveCandidate, EraDraftUiSaveReadResult } from "./eraDraftUiPersistence.js";
import type { EraDraftWebManifest } from "./eraDraftWebData.js";
import type { EraId } from "./teamEvaluationV2.js";
import { matchAppRoute } from "./webRoutes.js";

const manifest = {} as EraDraftWebManifest;
const candidate: EraDraftUiSaveCandidate = {
  envelope: {
    uiSaveVersion: "era-draft-ui-save/v1",
    serializedEngineState: "authoritative-engine-state",
    presentationCursor: null,
  },
  summary: { eraId: "era-transition", phase: "AWAITING_PICK", pickCount: 4, revision: 10 },
  raw: "opaque-save",
};

test("landing presents an explicit safe Continue summary without reveal data", () => {
  const html = renderLanding({ kind: "CANDIDATE", save: candidate });
  assert.match(html, /Continue Transition/);
  assert.match(html, /Player selection open · 4\/11 locked/);
  assert.match(html, /Continue Game/);
  const document = new JSDOM(html).window.document;
  assert.ok(document.querySelector("header .landing-continue"));
  assert.equal(document.querySelector("header .landing-header-actions")?.lastElementChild?.textContent, "Continue Game→");
  assert.doesNotMatch(html, /rating|quality tier|serializedEngineState/i);
});

test("landing presents invalid-save recovery without crashing era selection", () => {
  const html = renderLanding({ kind: "INVALID", message: "The local save uses an unsupported version." });
  assert.match(html, /Saved game unavailable/);
  assert.match(html, /Nothing was silently changed or repaired/);
  assert.match(html, /Discard unusable save/);
  assert.match(html, /Choose your chapter/);
});

test("starting over a valid save requires the lightweight overwrite decision", () => {
  const html = renderLanding({ kind: "CANDIDATE", save: candidate }, "era-impact");
  assert.match(html, /Starting a new draft will replace your current saved draft/);
  assert.match(html, />Cancel</);
  assert.match(html, /Start new draft/);
});

test("landing presents honest manifest, era-verification, and restore waiting states", () => {
  const initial = renderLanding({ kind: "EMPTY" }, null, { manifest: null, manifestLoading: true });
  assert.match(initial, /aria-busy="true"/);
  assert.match(initial, /Loading era index/);
  assert.match(initial, /Preparing the verified era catalog/);

  const eraLoading = renderLanding({ kind: "EMPTY" }, null, {
    selectedEra: "era-foundation",
    loadingEra: "era-foundation",
  });
  assert.match(eraLoading, /Loading and verifying/);
  assert.match(eraLoading, /Downloading Foundation data and checking its integrity/);

  const restoring = renderLanding({ kind: "CANDIDATE", save: candidate }, null, { loadingContinue: true });
  assert.match(restoring, /Restoring verified game/);
  assert.match(restoring, /validating its authoritative state/);
});

test("manifest failure offers a working retry action", async () => {
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>", { url: "https://example.test/" });
  const restoreGlobals = installDomGlobals(dom);
  let attempts = 0;
  const rootElement = dom.window.document.querySelector<HTMLElement>("#root")!;
  const root = createRoot(rootElement);
  try {
    await act(async () => root.render(<Landing manifest={null} manifestLoading={false}
      error="Era Draft manifest request failed with 503." loadingEra={null} selectedEra={null}
      savedGame={{ kind: "EMPTY" }} loadingContinue={false} overwriteEra={null} notice={null} basePath="/"
      onContinue={() => undefined} onDiscardSave={() => true} onRetryManifest={() => { attempts += 1; }}
      onCancelOverwrite={() => undefined} onConfirmOverwrite={() => undefined}
      onSelect={() => undefined} onStart={() => undefined} />));
    assert.match(rootElement.textContent ?? "", /Era Draft manifest request failed with 503/);
    const retry = [...rootElement.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Retry")!;
    assert.ok(retry);
    await act(async () => retry.click());
    assert.equal(attempts, 1);
  } finally {
    await act(async () => root.unmount());
    restoreGlobals();
    dom.window.close();
  }
});

test("direct era-draft route without a session has a deliberate recovery state", () => {
  assert.equal(matchAppRoute("/era-draft", "/"), "ERA_DRAFT");
  const html = renderToStaticMarkup(<LoadingSession />);
  assert.match(html, /No active game loaded/);
  assert.match(html, /Returning to era selection/);
  assert.match(html, /continue a verified local save/);
});

test("autosave warning is visible without replacing the playable in-memory draft", () => {
  const catalog = loadEraDraftCatalog();
  const setup = createEraDraftGame({ catalog, rootSeed: "storage-warning-ui" });
  const state = accepted(reduceEraDraft(catalog, setup, { type: "CHOOSE_ERA", eraId: "era-foundation" }));
  if (state.phase === "REVEALED" || state.phase === "GAME_COMPLETE") assert.fail("Expected hidden draft.");
  const html = renderToStaticMarkup(<DraftExperience session={{ catalog, state }}
    persistenceWarning="The game remains playable in this tab, but progress may be lost if you refresh or close it."
    onAccepted={() => null} onExit={() => undefined} />);
  assert.match(html, /Autosave unavailable/);
  assert.match(html, /progress may be lost if you refresh or close it/);
  assert.match(html, /Spin franchise/);
});

test("draft player selection toggles, switches, escapes, stays ephemeral, and clears after lock", async () => {
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>", { url: "https://example.test/era-draft" });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousKeyboardEvent = globalThis.KeyboardEvent;
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    KeyboardEvent: dom.window.KeyboardEvent,
    requestAnimationFrame: (callback: FrameRequestCallback) => { callback(0); return 1; },
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const catalog = loadEraDraftCatalog();
  let state = accepted(reduceEraDraft(catalog, createEraDraftGame({ catalog, rootSeed: "selection-usability" }),
    { type: "CHOOSE_ERA", eraId: "era-foundation" }));
  state = accepted(reduceEraDraft(catalog, state, { type: "SPIN" }));
  if (state.phase !== "AWAITING_PICK") assert.fail("expected awaiting-pick state");
  const awaitingPick = state as AwaitingPickState;
  const view = projectEraDraftPublicState(catalog, awaitingPick);
  if (view.phase !== "AWAITING_PICK") assert.fail("expected candidate projection");
  let acceptedTransitions: EraDraftTransitionResult[] = [];
  const rootElement = dom.window.document.querySelector<HTMLElement>("#root")!;
  const root = createRoot(rootElement);

  try {
    await act(async () => root.render(<DraftExperience session={{ catalog, state: awaitingPick }}
      persistenceWarning={null} onAccepted={(result) => { acceptedTransitions.push(result); return null; }}
      onExit={() => undefined} />));
    const candidateButtons = (): HTMLButtonElement[] => [...rootElement.querySelectorAll<HTMLButtonElement>(".candidate-card")];
    const rosterOrder = (): string[] => candidateButtons().map((button) => button.querySelector("strong")!.textContent!);
    const initialOrder = rosterOrder();
    const firstIndex = view.candidates.findIndex((candidate) => candidate.available
      && candidate.derivedRole !== "BOWLER" && candidate.historicalStats.currentSeason.batting.strikeRate !== null);
    const allRounderIndex = view.candidates.findIndex((candidate) => candidate.available
      && candidate.displayRole === "ALL_ROUNDER" && candidate.historicalStats.currentSeason.batting.strikeRate !== null
      && candidate.historicalStats.currentSeason.bowling.economy !== null);
    const bowlerIndex = view.candidates.findIndex((candidate) => candidate.available
      && candidate.derivedRole === "BOWLER" && candidate.historicalStats.currentSeason.bowling.economy !== null);
    assert.ok(firstIndex >= 0 && allRounderIndex >= 0 && bowlerIndex >= 0);
    const first = view.candidates[firstIndex]!;
    const allRounder = view.candidates[allRounderIndex]!;
    const bowler = view.candidates[bowlerIndex]!;
    assert.match(candidateButtons()[firstIndex]!.textContent ?? "", new RegExp(`${first.historicalStats.currentSeason.batting.runs} runs`, "i"));
    assert.match(candidateButtons()[firstIndex]!.textContent ?? "",
      new RegExp(`${first.historicalStats.currentSeason.batting.strikeRate!.toFixed(1)} SR`, "i"));
    assert.match(candidateButtons()[allRounderIndex]!.textContent ?? "", new RegExp(`${allRounder.historicalStats.currentSeason.batting.runs} runs`, "i"));
    assert.match(candidateButtons()[allRounderIndex]!.textContent ?? "", new RegExp(`${allRounder.historicalStats.currentSeason.bowling.wickets} wkts?`, "i"));
    assert.match(candidateButtons()[bowlerIndex]!.textContent ?? "", new RegExp(`${bowler.historicalStats.currentSeason.bowling.wickets} wkts?`, "i"));
    assert.match(candidateButtons()[bowlerIndex]!.textContent ?? "",
      new RegExp(`${bowler.historicalStats.currentSeason.bowling.economy!.toFixed(2)} econ`, "i"));

    await act(async () => candidateButtons()[firstIndex]!.click());
    assert.equal(candidateButtons()[firstIndex]!.getAttribute("aria-pressed"), "true");
    assert.equal(rootElement.querySelectorAll(".xi-slot-active").length, 11);
    assert.match(rootElement.querySelector(".selected-player-detail")?.textContent ?? "", new RegExp(`${first.seasonYear} SEASON`, "i"));
    assert.match(rootElement.querySelector(".selected-player-detail")?.textContent ?? "", new RegExp(`${first.historicalStats.currentSeason.batting.runs} runs`, "i"));
    assert.doesNotMatch(rootElement.querySelector(".candidate-section")?.textContent ?? "", /best season in this era/i);
    assert.equal(acceptedTransitions.length, 0);

    await act(async () => candidateButtons()[firstIndex]!.click());
    assert.equal(rootElement.querySelector(".selected-player-detail"), null);
    assert.equal(rootElement.querySelectorAll(".xi-slot-active").length, 0);
    assert.deepEqual(rosterOrder(), initialOrder);
    assert.equal(acceptedTransitions.length, 0);
    assert.equal(awaitingPick.revision, state.revision);

    await act(async () => candidateButtons()[bowlerIndex]!.click());
    assert.match(rootElement.querySelector(".selected-player-detail")?.textContent ?? "",
      new RegExp(`${bowler.historicalStats.currentSeason.bowling.wickets} wickets`, "i"));
    await act(async () => dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape" })));
    assert.equal(rootElement.querySelector(".selected-player-detail"), null);
    assert.equal(rootElement.querySelectorAll(".xi-slot-active").length, 0);
    assert.deepEqual(rosterOrder(), initialOrder);
    assert.equal(acceptedTransitions.length, 0);

    await act(async () => candidateButtons()[firstIndex]!.click());
    await act(async () => candidateButtons()[allRounderIndex]!.click());
    assert.equal(rootElement.querySelector(".selected-player-detail h3")?.textContent, allRounder.playerName);
    assert.match(rootElement.querySelector(".selected-player-detail")?.textContent ?? "",
      new RegExp(`${allRounder.historicalStats.currentSeason.batting.runs} runs`, "i"));
    assert.match(rootElement.querySelector(".selected-player-detail")?.textContent ?? "",
      new RegExp(`${allRounder.historicalStats.currentSeason.bowling.wickets} wickets`, "i"));
    assert.equal(candidateButtons()[firstIndex]!.getAttribute("aria-pressed"), "false");
    assert.equal(candidateButtons()[allRounderIndex]!.getAttribute("aria-pressed"), "true");
    assert.deepEqual(rosterOrder(), initialOrder);

    const lockTarget = rootElement.querySelector<HTMLButtonElement>(".xi-slot-active:not(:disabled)")!;
    await act(async () => lockTarget.click());
    assert.equal(acceptedTransitions.length, 0, "preview must not dispatch an engine transition");
    assert.ok(rootElement.querySelector(".xi-slot-preview"));
    const movedTarget = rootElement.querySelector<HTMLButtonElement>(".xi-slot-active:not(:disabled)")!;
    await act(async () => movedTarget.click());
    assert.equal(acceptedTransitions.length, 0);
    assert.equal(rootElement.querySelectorAll(".xi-slot-preview").length, 1);
    const previewCard = rootElement.querySelector<HTMLButtonElement>(".xi-slot-preview")!;
    assert.match(previewCard.textContent ?? "", /↑ Click slot to confirm/);
    assert.equal(previewCard.querySelector(".xi-card-rail"), null);
    assert.match(previewCard.querySelector(".collectible-card > .xi-fit-caption")?.textContent ?? "", /Position fit/);
    assert.ok(previewCard.querySelector(".collectible-card > .slot-confirm-hint"));
    await act(async () => { previewCard.click(); previewCard.click(); });
    assert.equal(rootElement.querySelector(".selected-player-detail"), null);
    assert.equal(rootElement.querySelectorAll(".xi-slot-active").length, 0);
    assert.equal(acceptedTransitions.length, 1);
    assert.equal(acceptedTransitions[0]!.ok, true);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, {
      window: previousWindow,
      document: previousDocument,
      HTMLElement: previousHTMLElement,
      KeyboardEvent: previousKeyboardEvent,
      requestAnimationFrame: previousRequestAnimationFrame,
      IS_REACT_ACT_ENVIRONMENT: false,
    });
    dom.window.close();
  }
});

test("confirm commits pending candidate and preview, never the inspected confirmed player", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://example.test/era-draft" });
  const restoreGlobals = installDomGlobals(dom);
  const previousAnimationFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => { callback(0); return 1; };
  const catalog = loadEraDraftCatalog();
  let state = accepted(reduceEraDraft(catalog, createEraDraftGame({ catalog, rootSeed: "pending-versus-inspected" }), { type: "CHOOSE_ERA", eraId: "era-foundation" }));
  state = accepted(reduceEraDraft(catalog, state, { type: "SPIN" }));
  if (state.phase !== "AWAITING_PICK") assert.fail("Expected pick");
  const firstView = projectEraDraftPublicState(catalog, state);
  if (firstView.phase !== "AWAITING_PICK") assert.fail("Expected roster");
  const first = firstView.candidates.find((candidate) => candidate.available)!;
  state = accepted(reduceEraDraft(catalog, state, { type: "LOCK_PLAYER", playerTeamSeasonId: first.playerTeamSeasonId, battingPosition: first.positions.find((position) => position.available)!.battingPosition }));
  state = accepted(reduceEraDraft(catalog, state, { type: "SPIN" }));
  if (state.phase !== "AWAITING_PICK") assert.fail("Expected second pick");
  const initial = state;
  const snapshot = JSON.stringify(initial);
  const view = projectEraDraftPublicState(catalog, initial);
  if (view.phase !== "AWAITING_PICK") assert.fail("Expected roster");
  const pending = view.candidates.find((candidate) => candidate.available)!;
  const position = pending.positions.find((position) => position.available)!;
  let transitions = 0;
  let resultState: EraDraftState = initial;
  function Harness() {
    const [live, setLive] = useState(initial as Exclude<EraDraftState, { phase: "SETUP" | "REVEALED" | "GAME_COMPLETE" }>);
    return <DraftExperience session={{ catalog, state: live }} persistenceWarning={null} onExit={() => undefined}
      onAccepted={(result) => { resultState = accepted(result); transitions += 1; setLive(resultState as typeof live); return null; }} />;
  }
  const element = dom.window.document.getElementById("root")!;
  const root = createRoot(element);
  try {
    await act(async () => root.render(<StrictMode><Harness /></StrictMode>));
    const candidateButton = [...element.querySelectorAll<HTMLButtonElement>(".candidate-card")].find((button) => button.querySelector("strong")?.textContent === pending.playerName)!;
    await act(async () => candidateButton.click());
    const slot = element.querySelector<HTMLButtonElement>(`[aria-label^="Position ${position.battingPosition} ·"]`)!;
    await act(async () => slot.click());
    assert.equal(transitions, 0);
    assert.equal(JSON.stringify(initial), snapshot);
    await act(async () => { const locked = element.querySelector<HTMLButtonElement>(".xi-slot-locked")!; locked.focus(); locked.click(); });
    assert.equal(element.querySelector(".player-inspector h3")?.textContent, first.playerName);
    assert.ok(element.querySelector("dialog.inspector-modal[open]"));
    const close = element.querySelector<HTMLButtonElement>("[aria-label='Close player details']")!;
    assert.equal(dom.window.document.activeElement, close);
    await act(async () => close.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
    assert.equal(dom.window.document.activeElement, close);
    assert.match(element.querySelector(".pending-pick-label")?.textContent ?? "", new RegExp(pending.playerName));
    assert.ok(element.querySelector(".xi-slot-preview"));
    await act(async () => dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape" })));
    assert.equal(element.querySelector(".player-inspector"), null);
    assert.ok(element.querySelector(".xi-slot-preview"), "Escape closes inspection without clearing preview");
    await act(async () => element.querySelector<HTMLButtonElement>(".xi-slot-locked")!.click());
    await act(async () => element.querySelector("dialog")!.dispatchEvent(new dom.window.Event("cancel", { cancelable: true })));
    assert.equal(element.querySelector("dialog"), null);
    assert.equal(dom.window.document.activeElement, element.querySelector(".xi-slot-locked"));
    await act(async () => {
      const confirm = element.querySelector<HTMLButtonElement>(".desktop-confirm .confirm-pick")!;
      confirm.click(); confirm.click();
    });
    assert.equal(transitions, 1);
    assert.equal(resultState.picks.length, 2);
    assert.equal(resultState.picks[1]!.playerTeamSeasonId, pending.playerTeamSeasonId);
    assert.equal(resultState.picks[1]!.battingPosition, position.battingPosition);
    assert.deepEqual(resultState.picks[0], initial.picks[0]);
    assert.equal(element.querySelector(".xi-slot-preview"), null);
    assert.equal(element.querySelector(".player-inspector"), null);
  } finally {
    await act(async () => root.unmount());
    globalThis.requestAnimationFrame = previousAnimationFrame;
    restoreGlobals(); dom.window.close();
  }
});

test("Unknown fit uses Acceptable only in UI, with four labels and unchanged authoritative fit", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://example.test/era-draft" });
  const restoreGlobals = installDomGlobals(dom);
  const catalog = loadEraDraftCatalog();
  let state = accepted(reduceEraDraft(catalog, createEraDraftGame({ catalog, rootSeed: "fit-fallback-3" }), { type: "CHOOSE_ERA", eraId: "era-foundation" }));
  state = accepted(reduceEraDraft(catalog, state, { type: "SPIN" }));
  if (state.phase !== "AWAITING_PICK") assert.fail("Expected roster");
  const view = projectEraDraftPublicState(catalog, state);
  if (view.phase !== "AWAITING_PICK") assert.fail("Expected roster view");
  const unknown = view.candidates.find((player) => player.available && player.positions.every((position) => position.presentationFit === "UNKNOWN"))!;
  assert.ok(unknown);
  const snapshot = JSON.stringify(state);
  const element = dom.window.document.getElementById("root")!;
  const root = createRoot(element);
  try {
    await act(async () => root.render(<DraftExperience session={{ catalog, state: state as AwaitingPickState }} persistenceWarning={null} onExit={() => undefined} onAccepted={() => null} />));
    const buttons = [...element.querySelectorAll<HTMLButtonElement>(".candidate-card")];
    const keeper = view.candidates.find((player) => player.available && player.displayRole === "WICKETKEEPER_BATTER")!;
    assert.ok(keeper);
    await act(async () => buttons.find((button) => button.querySelector("strong")?.textContent === keeper.playerName)!.click());
    assert.equal((element.querySelector(".selected-player-meta")!.textContent!.match(/Wicketkeeper/g) ?? []).length, 1);
    await act(async () => buttons.find((button) => button.querySelector("strong")?.textContent === unknown.playerName)!.click());
    assert.equal(element.querySelectorAll(".fit-legend .fit-badge").length, 4);
    assert.equal(element.querySelectorAll(".xi-target-acceptable").length, 11);
    assert.doesNotMatch(element.querySelector(".xi-panel")!.textContent!, /Unknown|[△⚠○✓?]/);
    await act(async () => element.querySelector<HTMLButtonElement>(".xi-slot-active")!.click());
    assert.match(element.querySelector(".xi-fit-caption")!.textContent!, /Position fit · Acceptable/);
    assert.equal(JSON.stringify(state), snapshot);
    assert.ok(unknown.positions.every((position) => position.presentationFit === "UNKNOWN"));
  } finally {
    await act(async () => root.unmount());
    restoreGlobals(); dom.window.close();
  }
});

test("unavailable roster rows retain accessible reasons without visible warning copy", () => {
  const catalog = loadEraDraftCatalog();
  let state = accepted(reduceEraDraft(catalog, createEraDraftGame({ catalog, rootSeed: "unavailable-row-ui" }), { type: "CHOOSE_ERA", eraId: "era-foundation" }));
  for (let pick = 0; pick < 4; pick += 1) {
    state = accepted(reduceEraDraft(catalog, state, { type: "SPIN" }));
    if (state.phase !== "AWAITING_PICK") assert.fail("Expected pick state");
    const view = projectEraDraftPublicState(catalog, state);
    if (view.phase !== "AWAITING_PICK") assert.fail("Expected roster");
    const player = view.candidates.find((candidate) => candidate.available && candidate.rosterStatus === "OVERSEAS")!;
    assert.ok(player);
    state = accepted(reduceEraDraft(catalog, state, { type: "LOCK_PLAYER", playerTeamSeasonId: player.playerTeamSeasonId, battingPosition: player.positions.find((position) => position.available)!.battingPosition }));
  }
  state = accepted(reduceEraDraft(catalog, state, { type: "SPIN" }));
  if (state.phase !== "AWAITING_PICK") assert.fail("Expected roster");
  const html = renderToStaticMarkup(<DraftExperience session={{ catalog, state }} persistenceWarning={null} onExit={() => undefined} onAccepted={() => null} />);
  const document = new JSDOM(html).window.document;
  const disabled = [...document.querySelectorAll<HTMLButtonElement>(".candidate-card:disabled")];
  assert.ok(disabled.length > 0);
  assert.ok(disabled.some((row) => row.getAttribute("aria-description")?.includes("four overseas")));
  for (const row of disabled) {
    assert.ok(row.getAttribute("aria-description"));
    assert.equal(row.title, row.getAttribute("aria-description"));
    assert.equal(row.querySelector(".candidate-unavailable"), null);
    assert.equal(row.querySelector(".select-mark")?.textContent, "");
    assert.doesNotMatch(row.textContent ?? "", /already drafted|at most four|Unavailable/);
  }
});

test("Start League retains the synchronous one-call guard with the redesigned reveal list", async () => {
  const catalog = loadEraDraftCatalog();
  let state = accepted(reduceEraDraft(catalog, createEraDraftGame({ catalog, rootSeed: "final-start-guard" }), { type: "CHOOSE_ERA", eraId: "era-foundation" }));
  while (state.phase === "AWAITING_SPIN") {
    state = accepted(reduceEraDraft(catalog, state, { type: "SPIN" }));
    if (state.phase !== "AWAITING_PICK") assert.fail("Expected roster");
    const view = projectEraDraftPublicState(catalog, state);
    if (view.phase !== "AWAITING_PICK") assert.fail("Expected roster");
    const candidate = view.candidates.find((item) => item.available)!;
    state = accepted(reduceEraDraft(catalog, state, { type: "LOCK_PLAYER", playerTeamSeasonId: candidate.playerTeamSeasonId,
      battingPosition: candidate.positions.find((position) => position.available)!.battingPosition }));
  }
  state = accepted(reduceEraDraft(catalog, state, { type: "REVEAL_XI" }));
  if (state.phase !== "REVEALED") assert.fail("Expected reveal");
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://example.test/era-draft" });
  const restoreGlobals = installDomGlobals(dom);
  const element = dom.window.document.getElementById("root")!;
  const root = createRoot(element);
  let starts = 0;
  try {
    const revealed = state;
    await act(async () => root.render(<RevealedExperience session={{ catalog, state: revealed }} persistenceWarning={null}
      onBeginSeason={() => { starts += 1; }} onExit={() => undefined} />));
    assert.equal(element.querySelectorAll(".revealed-player").length, 11);
    assert.equal(element.querySelector(".quality-tier"), null);
    await act(async () => {
      const button = element.querySelector<HTMLButtonElement>(".phase-boundary button")!;
      button.click(); button.click();
    });
    assert.equal(starts, 1);
    assert.equal(element.querySelector<HTMLButtonElement>(".phase-boundary button")!.disabled, true);
    assert.match(element.textContent ?? "", /Starting league…/);
  } finally { await act(async () => root.unmount()); restoreGlobals(); dom.window.close(); }
});

test("homepage keeps all five era selections separate from starting and preserves nested Classic links", async () => {
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>", { url: "https://example.test/game/" });
  const restoreGlobals = installDomGlobals(dom);
  const element = dom.window.document.querySelector<HTMLElement>("#root")!;
  const root = createRoot(element);
  const starts: EraId[] = [];
  let continues = 0;
  function Home() {
    const [selectedEra, setSelectedEra] = useState<EraId | null>(null);
    return <Landing manifest={manifest} manifestLoading={false} error={null} loadingEra={null} selectedEra={selectedEra}
      savedGame={{ kind: "CANDIDATE", save: candidate }} loadingContinue={false} overwriteEra={null} notice={null} basePath="/game/"
      onContinue={() => { continues += 1; }} onDiscardSave={() => true} onRetryManifest={() => undefined}
      onCancelOverwrite={() => undefined} onConfirmOverwrite={() => undefined} onSelect={setSelectedEra} onStart={(era) => starts.push(era)} />;
  }
  try {
    await act(async () => root.render(<Home />));
    assert.equal(element.querySelectorAll('.era-card[aria-pressed="true"]').length, 0);
    assert.equal(element.querySelector(".start-draft-action"), null);
    assert.equal(element.querySelector(".classic-link")?.getAttribute("href"), "/game/classic");
    assert.equal(element.querySelector(".wordmark")?.getAttribute("href"), "/game/");
    const ids: EraId[] = ["era-foundation", "era-expansion", "era-transition", "era-modern-pre-impact", "era-impact"];
    const rows = [...element.querySelectorAll<HTMLButtonElement>(".era-card")];
    assert.equal(rows.length, 5);
    for (const [index, row] of rows.entries()) {
      await act(async () => row.click());
      assert.equal(row.getAttribute("aria-pressed"), "true");
      assert.equal(element.querySelectorAll('.era-card[aria-pressed="true"]').length, 1);
      assert.equal(element.querySelector(".era-detail-kicker")?.textContent, row.querySelector("strong")?.textContent);
      assert.equal(element.querySelector(".era-detail-years")?.textContent, row.querySelector(".era-years")?.textContent);
      assert.equal(starts.length, index);
      await act(async () => element.querySelector<HTMLButtonElement>(".start-draft-action")!.click());
      assert.equal(starts[index], ids[index]);
    }
    await act(async () => element.querySelector<HTMLButtonElement>(".landing-continue")!.click());
    assert.equal(continues, 1);
    assert.match(element.querySelector("#continue-summary")?.textContent ?? "", /Continue Transition/);
  } finally {
    await act(async () => root.unmount()); restoreGlobals(); dom.window.close();
  }
});

test("homepage hides Continue for absent or unusable saves and keeps loading actions disabled", () => {
  for (const saved of [{ kind: "EMPTY" }, { kind: "INVALID", message: "Invalid save" },
    { kind: "UNAVAILABLE", message: "Storage unavailable" }] as EraDraftUiSaveReadResult[]) {
    assert.doesNotMatch(renderLanding(saved), /class="[^"]*landing-continue/);
  }
  const loading = new JSDOM(renderLanding({ kind: "CANDIDATE", save: candidate }, null,
    { manifest: null, manifestLoading: true })).window.document;
  assert.ok(loading.querySelector<HTMLButtonElement>(".landing-continue")?.disabled);
  assert.ok([...loading.querySelectorAll<HTMLButtonElement>(".era-card")].every((row) => row.disabled));
  const restoring = new JSDOM(renderLanding({ kind: "CANDIDATE", save: candidate }, null,
    { loadingContinue: true })).window.document;
  assert.ok(restoring.querySelector<HTMLButtonElement>(".landing-continue")?.disabled);
});

test("homepage replacement cancellation and successful discard return focus to the existing recovery targets", async () => {
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>", { url: "https://example.test/" });
  const restoreGlobals = installDomGlobals(dom);
  // Focus restoration runs after React commits the replacement UI in the browser.
  const frames: FrameRequestCallback[] = [];
  globalThis.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length; };
  const element = dom.window.document.querySelector<HTMLElement>("#root")!;
  const root = createRoot(element);
  let confirmed = 0;
  function Home({ invalid = false }: { invalid?: boolean }) {
    const [overwrite, setOverwrite] = useState(false);
    const [saved, setSaved] = useState<EraDraftUiSaveReadResult>(invalid
      ? { kind: "INVALID", message: "Invalid save" } : { kind: "CANDIDATE", save: candidate });
    return <Landing manifest={manifest} manifestLoading={false} error={null} loadingEra={null} selectedEra="era-foundation"
      savedGame={saved} loadingContinue={false} overwriteEra={overwrite ? "era-foundation" : null} notice={null} basePath="/"
      onContinue={() => undefined} onDiscardSave={() => { setSaved({ kind: "EMPTY" }); return true; }} onRetryManifest={() => undefined}
      onCancelOverwrite={() => setOverwrite(false)} onConfirmOverwrite={() => { confirmed += 1; }}
      onSelect={() => undefined} onStart={() => setOverwrite(true)} />;
  }
  const button = (name: string) => [...element.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === name)!;
  try {
    await act(async () => root.render(<Home />));
    await act(async () => element.querySelector<HTMLButtonElement>(".start-draft-action")!.click());
    assert.ok(element.querySelector(".overwrite-confirm"));
    assert.equal(confirmed, 0);
    await act(async () => button("Cancel").click());
    frames.splice(0).forEach((callback) => callback(0));
    assert.equal(dom.window.document.activeElement, element.querySelector(".start-draft-action"));
    await act(async () => element.querySelector<HTMLButtonElement>(".start-draft-action")!.click());
    await act(async () => button("Start new draft").click());
    assert.equal(confirmed, 1);
    await act(async () => root.render(<Home key="invalid" invalid />));
    await act(async () => button("Discard unusable save").click());
    frames.splice(0).forEach((callback) => callback(0));
    assert.equal(element.querySelector(".save-recovery"), null);
    assert.equal(dom.window.document.activeElement, element.querySelector("#era-picker-title"));
  } finally {
    await act(async () => root.unmount()); restoreGlobals(); dom.window.close();
  }
});

function renderLanding(
  savedGame: EraDraftUiSaveReadResult,
  overwriteEra: "era-impact" | null = null,
  options: {
    readonly manifest?: EraDraftWebManifest | null;
    readonly manifestLoading?: boolean;
    readonly selectedEra?: EraId | null;
    readonly loadingEra?: EraId | null;
    readonly loadingContinue?: boolean;
    readonly error?: string | null;
  } = {},
): string {
  return renderToStaticMarkup(<Landing
    manifest={options.manifest === undefined ? manifest : options.manifest}
    manifestLoading={options.manifestLoading ?? false}
    error={options.error ?? null}
    loadingEra={options.loadingEra ?? null}
    selectedEra={options.selectedEra === undefined ? overwriteEra : options.selectedEra}
    savedGame={savedGame}
    loadingContinue={options.loadingContinue ?? false}
    overwriteEra={overwriteEra}
    notice={null}
    basePath="/"
    onContinue={() => undefined}
    onDiscardSave={() => true}
    onRetryManifest={() => undefined}
    onCancelOverwrite={() => undefined}
    onConfirmOverwrite={() => undefined}
    onSelect={() => undefined}
    onStart={() => undefined}
  />);
}

function installDomGlobals(dom: JSDOM): () => void {
  // JSDOM does not implement native modal dialogs; browser QA covers the top layer.
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    KeyboardEvent: globalThis.KeyboardEvent,
    PopStateEvent: globalThis.PopStateEvent,
    requestAnimationFrame: globalThis.requestAnimationFrame,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    KeyboardEvent: dom.window.KeyboardEvent,
    PopStateEvent: dom.window.PopStateEvent,
    requestAnimationFrame: (callback: FrameRequestCallback) => { callback(0); return 1; },
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  dom.window.scrollTo = () => undefined;
  return () => Object.assign(globalThis, { ...previous, IS_REACT_ACT_ENVIRONMENT: false });
}

function accepted(result: EraDraftTransitionResult): Exclude<EraDraftState, { phase: "SETUP" }> {
  if (!result.ok) assert.fail(result.error.message);
  if (result.state.phase === "SETUP") assert.fail("unexpected setup state");
  return result.state;
}
