import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";

import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { DraftExperience, Landing } from "./eraDraftApp.js";
import { loadEraDraftCatalog } from "./eraDraftData.js";
import { createEraDraftGame, reduceEraDraft } from "./eraDraftEngine.js";
import { projectEraDraftPublicState } from "./eraDraftProjection.js";
import type { AwaitingPickState, EraDraftState, EraDraftTransitionResult } from "./eraDraftTypes.js";
import type { EraDraftUiSaveCandidate, EraDraftUiSaveReadResult } from "./eraDraftUiPersistence.js";
import type { EraDraftWebManifest } from "./eraDraftWebData.js";

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
  assert.match(html, /Continue game/);
  assert.doesNotMatch(html, /rating|quality tier|serializedEngineState/i);
});

test("landing presents invalid-save recovery without crashing era selection", () => {
  const html = renderLanding({ kind: "INVALID", message: "The local save uses an unsupported version." });
  assert.match(html, /Saved game unavailable/);
  assert.match(html, /Discard local save/);
  assert.match(html, /Choose an era/);
});

test("starting over a valid save requires the lightweight overwrite decision", () => {
  const html = renderLanding({ kind: "CANDIDATE", save: candidate }, "era-impact");
  assert.match(html, /Starting a new draft will replace your current saved draft/);
  assert.match(html, />Cancel</);
  assert.match(html, /Start new draft/);
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
      && candidate.derivedRole === "ALL_ROUNDER" && candidate.historicalStats.currentSeason.batting.strikeRate !== null
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
      new RegExp(`BAT · ${allRounder.historicalStats.currentSeason.batting.runs} runs`, "i"));
    assert.match(rootElement.querySelector(".selected-player-detail")?.textContent ?? "",
      new RegExp(`BOWL · ${allRounder.historicalStats.currentSeason.bowling.wickets} wickets`, "i"));
    assert.equal(candidateButtons()[firstIndex]!.getAttribute("aria-pressed"), "false");
    assert.equal(candidateButtons()[allRounderIndex]!.getAttribute("aria-pressed"), "true");
    assert.deepEqual(rosterOrder(), initialOrder);

    const lockTarget = rootElement.querySelector<HTMLButtonElement>(".xi-slot-active:not(:disabled)")!;
    await act(async () => lockTarget.click());
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

function renderLanding(savedGame: EraDraftUiSaveReadResult, overwriteEra: "era-impact" | null = null): string {
  return renderToStaticMarkup(<Landing
    manifest={manifest}
    error={null}
    loadingEra={null}
    selectedEra={overwriteEra}
    savedGame={savedGame}
    loadingContinue={false}
    overwriteEra={overwriteEra}
    notice={null}
    basePath="/"
    onContinue={() => undefined}
    onDiscardSave={() => true}
    onCancelOverwrite={() => undefined}
    onConfirmOverwrite={() => undefined}
    onSelect={() => undefined}
    onStart={() => undefined}
  />);
}

function accepted(result: EraDraftTransitionResult): Exclude<EraDraftState, { phase: "SETUP" }> {
  if (!result.ok) assert.fail(result.error.message);
  if (result.state.phase === "SETUP") assert.fail("unexpected setup state");
  return result.state;
}
