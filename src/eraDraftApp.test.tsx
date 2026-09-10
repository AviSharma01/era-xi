import assert from "node:assert/strict";
import test from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import { Landing } from "./eraDraftApp.js";
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
