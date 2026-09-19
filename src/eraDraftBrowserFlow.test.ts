import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";

import { createEraDraftGame, reduceEraDraft } from "./eraDraftEngine.js";
import { projectEraDraftPublicState, projectEraDraftRevealState } from "./eraDraftProjection.js";
import type { EraDraftHiddenState, RevealedState } from "./eraDraftTypes.js";
import { loadEraDraftCatalogDocuments } from "./eraDraftData.js";
import { createEraDraftWebAssets } from "./eraDraftWebArtifacts.js";
import { fetchScopedEraDraftCatalog, type EraDraftWebFetch } from "./eraDraftWebData.js";

const documents = loadEraDraftCatalogDocuments();
const assets = createEraDraftWebAssets(documents);
const manifestUrl = new URL("https://example.test/data/era-draft/v1/manifest.json");

test("every fetched era reaches REVEALED through browser-facing projections", async () => {
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
      const appearances = { S: "violet", A: "gold", B: "cobalt", C: "emerald", D: "slate" } as const;
      for (const candidate of view.candidates) {
        assert.equal(candidate.tierAppearance, appearances[catalog.getPlayer(candidate.playerTeamSeasonId)!.quality.overall.qualityTier]);
      }
      assert.doesNotMatch(JSON.stringify(view), /"(?:quality|qualityTier|battingRating|bowlingRating|overallRating|internalScore|bandDistance|evaluation)"/);
      for (const pick of view.picks) {
        assert.equal(pick.tierAppearance, appearances[catalog.getPlayer(pick.playerTeamSeasonId)!.quality.overall.qualityTier]);
        assert.ok(pick.historicalStats.currentSeason);
      }
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
    const revealed = revealedState(reduceEraDraft(catalog, state, { type: "REVEAL_XI" }));
    const revealView = projectEraDraftRevealState(catalog, revealed);
    assert.equal(revealView.phase, "REVEALED");
    assert.equal(revealView.players.length, 11);
    assert.deepEqual(
      revealView.players.map((player) => player.playerTeamSeasonId),
      complete.picks.map((pick) => pick.playerTeamSeasonId),
    );
    assert.ok(revealView.players.every((player) => ["S", "A", "B", "C", "D"].includes(player.qualityTier)));
    assert.ok(revealView.players.every((player) =>
      ["NATURAL", "ACCEPTABLE", "STRETCH", "MAJOR_STRETCH", "UNKNOWN"].includes(player.presentationFit)));
  }
});

function accepted(result: ReturnType<typeof reduceEraDraft>): EraDraftHiddenState {
  if (!result.ok) assert.fail(result.error.message);
  if (result.state.phase === "REVEALED" || result.state.phase === "GAME_COMPLETE") assert.fail("Phase 1 flow crossed the reveal boundary.");
  return result.state;
}

function revealedState(result: ReturnType<typeof reduceEraDraft>): RevealedState {
  if (!result.ok) assert.fail(result.error.message);
  if (result.state.phase !== "REVEALED") assert.fail("Phase 2 browser flow must reach REVEALED.");
  return result.state;
}
