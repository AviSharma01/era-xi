import assert from "node:assert/strict";
import test from "node:test";

import { loadEraDraftCatalog } from "./eraDraftData.js";
import { createEraDraftGame, reduceEraDraft } from "./eraDraftEngine.js";
import { evaluateSelectionLegality, getOpenBattingPositions } from "./eraDraftLegality.js";
import {
  canonicalEraDraftStateHash,
  restoreEraDraftState,
  serializeEraDraftState,
} from "./eraDraftPersistence.js";
import { accepted, draftEraXi, wrapEraDraftCatalog } from "./eraDraftPhase4TestSupport.js";
import { replayEraDraftGame, replayEraDraftState } from "./eraDraftReplay.js";
import { selectNormalSpinTeamSeason } from "./eraDraftRng.js";
import { EraDraftDataError, type AwaitingPickState, type EraDraftState } from "./eraDraftTypes.js";
import { ERA_IDS } from "./teamEvaluationV2.js";

const catalog = loadEraDraftCatalog();

test("accepted-command replay reconstructs setup, spins, picks, respin, reveal, and complete game", () => {
  const setup = createEraDraftGame({ catalog, rootSeed: "phase-4-replay" });
  const chosen = accepted(reduceEraDraft(catalog, setup, { type: "CHOOSE_ERA", eraId: "era-foundation" }));
  const spun = accepted(reduceEraDraft(catalog, chosen, { type: "SPIN" }));
  const respun = accepted(reduceEraDraft(catalog, spun, { type: "RESPIN" }));
  const partial = lockFirstLegal(spun as AwaitingPickState);
  const xi = draftEraXi(catalog, "phase-4-replay-complete", "era-foundation");
  const revealed = accepted(reduceEraDraft(catalog, xi, { type: "REVEAL_XI" }));
  const complete = accepted(reduceEraDraft(catalog, revealed, { type: "SIMULATE_SEASON" }));

  for (const state of [setup, chosen, spun, partial, respun, xi, revealed, complete]) {
    const replayed = replayEraDraftState(catalog, state);
    assert.deepEqual(replayed, state, state.phase);
    assert.equal(canonicalEraDraftStateHash(replayed), canonicalEraDraftStateHash(state), state.phase);
  }
});

test("replay independently reproduces dead-spin recovery and detects recorded resolution drift", () => {
  const rootSeed = "phase-4-replay-recovery";
  const triggering = selectNormalSpinTeamSeason(catalog, rootSeed, "era-foundation", 0);
  const recoveryCatalog = wrapEraDraftCatalog(catalog, {
    getCandidatesForTeamSeason: (teamSeasonId) => teamSeasonId === triggering.teamSeasonId
      ? []
      : catalog.getCandidatesForTeamSeason(teamSeasonId),
  });
  const setup = createEraDraftGame({ catalog: recoveryCatalog, rootSeed });
  const chosen = accepted(reduceEraDraft(recoveryCatalog, setup, { type: "CHOOSE_ERA", eraId: "era-foundation" }));
  const recovered = accepted(reduceEraDraft(recoveryCatalog, chosen, { type: "SPIN" }));
  assert.equal(recovered.phase, "AWAITING_PICK");
  if (recovered.phase === "AWAITING_PICK") assert.ok(recovered.currentSpin.recovery);
  assert.deepEqual(replayEraDraftState(recoveryCatalog, recovered), recovered);

  const history = recovered.history.map((entry) => entry.command === "SPIN"
    ? { ...entry, selectedTeamSeasonId: triggering.teamSeasonId }
    : entry);
  assert.throws(
    () => replayEraDraftGame({ catalog: recoveryCatalog, rootSeed, history }),
    (error) => error instanceof EraDraftDataError && error.code === "REPLAY_EVENT_MISMATCH",
  );
});

test("complete-game original, restored, and replayed canonical hashes are identical", () => {
  const xi = draftEraXi(catalog, "phase-4-hash-identity", "era-foundation");
  const revealed = accepted(reduceEraDraft(catalog, xi, { type: "REVEAL_XI" }));
  const original = accepted(reduceEraDraft(catalog, revealed, { type: "SIMULATE_SEASON" }));
  const restored = restoreEraDraftState(catalog, serializeEraDraftState(original));
  const replayed = replayEraDraftState(catalog, original);
  const hash = canonicalEraDraftStateHash(original);
  assert.equal(canonicalEraDraftStateHash(restored), hash);
  assert.equal(canonicalEraDraftStateHash(replayed), hash);
  assert.equal(serializeEraDraftState(restored), serializeEraDraftState(original));
  assert.equal(serializeEraDraftState(replayed), serializeEraDraftState(original));
});

test("accepted-command replay recomputes identical GAME_COMPLETE results for every era", () => {
  for (const eraId of ERA_IDS) {
    const xi = draftEraXi(catalog, `stage9a-replay:${eraId}`, eraId);
    const revealed = accepted(reduceEraDraft(catalog, xi, { type: "REVEAL_XI" }));
    const original = accepted(reduceEraDraft(catalog, revealed, { type: "SIMULATE_SEASON" }));
    const replayed = replayEraDraftState(catalog, original);
    assert.deepEqual(replayed, original, eraId);
    assert.equal(canonicalEraDraftStateHash(replayed), canonicalEraDraftStateHash(original), eraId);
    if (original.phase === "GAME_COMPLETE" && replayed.phase === "GAME_COMPLETE") {
      assert.deepEqual(replayed.season.opponentComposition, original.season.opponentComposition, eraId);
      assert.deepEqual(replayed.season.league, original.season.league, eraId);
    }
  }
});

test("rejected commands never enter replay history", () => {
  const setup = createEraDraftGame({ catalog, rootSeed: "phase-4-rejected-history" });
  const before = setup.history;
  const rejected = reduceEraDraft(catalog, setup, { type: "SPIN" });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.state.history, before);
  assert.deepEqual(replayEraDraftState(catalog, setup), setup);
});

function lockFirstLegal(state: AwaitingPickState): EraDraftState {
  const positions = getOpenBattingPositions(state.picks);
  const context = { eraId: state.eraId, picks: state.picks, activeTeamSeasonId: state.currentSpin.teamSeasonId };
  const choice = catalog.getCandidatesForTeamSeason(state.currentSpin.teamSeasonId)
    .flatMap((player) => positions.map((battingPosition) => ({ player, battingPosition })))
    .find(({ player, battingPosition }) => evaluateSelectionLegality(
      catalog, context, { playerTeamSeasonId: player.playerTeamSeasonId, battingPosition },
    ).available);
  assert.ok(choice);
  return accepted(reduceEraDraft(catalog, state, {
    type: "LOCK_PLAYER",
    playerTeamSeasonId: choice.player.playerTeamSeasonId,
    battingPosition: choice.battingPosition,
  }));
}
