import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";

import { createEraDraftGame, reduceEraDraft } from "./eraDraftEngine.js";
import { projectEraDraftPublicState } from "./eraDraftProjection.js";
import type { EraDraftHiddenState } from "./eraDraftTypes.js";
import { loadEraDraftCatalogDocuments } from "./eraDraftData.js";
import { createEraDraftWebAssets } from "./eraDraftWebArtifacts.js";
import { fetchScopedEraDraftCatalog, type EraDraftWebFetch } from "./eraDraftWebData.js";

const documents = loadEraDraftCatalogDocuments();
const assets = createEraDraftWebAssets(documents);
const manifestUrl = new URL("https://example.test/data/era-draft/v1/manifest.json");

test("every fetched era reaches XI_COMPLETE through browser-facing projections", async () => {
  for (const entry of assets.manifest.eras) {
    const file = assets.artifacts.get(entry.path)!;
    const fetcher: EraDraftWebFetch = async () => new Response(file.json);
    const catalog = await fetchScopedEraDraftCatalog({ manifest: assets.manifest, manifestUrl, eraId: entry.eraId,
      fetcher, subtle: webcrypto.subtle as unknown as SubtleCrypto });
    let state: EraDraftHiddenState = createEraDraftGame({ catalog, rootSeed: `browser-flow:${entry.eraId}` });
    state = accepted(reduceEraDraft(catalog, state, { type: "CHOOSE_ERA", eraId: entry.eraId }));
    for (let pick = 0; pick < 11; pick += 1) {
      assert.equal(state.phase, "AWAITING_SPIN", `${entry.eraId} before pick ${pick + 1}`);
      state = accepted(reduceEraDraft(catalog, state, { type: "SPIN" }));
      assert.equal(state.phase, "AWAITING_PICK", `${entry.eraId} spin ${pick + 1}`);
      if (state.phase !== "AWAITING_PICK") throw new Error("Expected browser-facing pick state.");
      const view = projectEraDraftPublicState(catalog, state);
      assert.equal(view.phase, "AWAITING_PICK");
      if (view.phase !== "AWAITING_PICK") throw new Error("Expected browser-facing candidate view.");
      const choice = view.candidates.flatMap((candidate) => candidate.positions.map((position) => ({ candidate, position })))
        .find(({ position }) => position.available);
      assert.ok(choice, `${entry.eraId} must expose a legal public choice at pick ${pick + 1}`);
      state = accepted(reduceEraDraft(catalog, state, { type: "LOCK_PLAYER",
        playerTeamSeasonId: choice.candidate.playerTeamSeasonId, battingPosition: choice.position.battingPosition }));
    }
    assert.equal(state.phase, "XI_COMPLETE", entry.eraId);
    const complete = projectEraDraftPublicState(catalog, state);
    assert.equal(complete.phase, "XI_COMPLETE");
    if (complete.phase === "XI_COMPLETE") {
      assert.equal(complete.status.pickCount, 11);
      assert.equal(complete.status.hasWicketkeeper, true);
      assert.ok(complete.status.overseasCount <= 4);
    }
  }
});

function accepted(result: ReturnType<typeof reduceEraDraft>): EraDraftHiddenState {
  if (!result.ok) assert.fail(result.error.message);
  if (result.state.phase === "REVEALED" || result.state.phase === "GAME_COMPLETE") assert.fail("Phase 1 flow crossed the reveal boundary.");
  return result.state;
}

