import assert from "node:assert/strict";
import test from "node:test";

import { canonicalSha256 } from "./eraDraftCanonical.js";
import { FOUNDATION_SIMULATION_COMPATIBILITY_FINGERPRINT } from "./eraDraftCompatibility.js";
import { loadEraDraftCatalog } from "./eraDraftData.js";
import { createEraDraftGame, reduceEraDraft } from "./eraDraftEngine.js";
import { evaluateSelectionLegality, getOpenBattingPositions } from "./eraDraftLegality.js";
import {
  canonicalEraDraftStateHash,
  restoreEraDraftState,
  serializeEraDraftState,
} from "./eraDraftPersistence.js";
import { accepted, draftEraXi, wrapEraDraftCatalog } from "./eraDraftPhase4TestSupport.js";
import { selectNormalSpinTeamSeason } from "./eraDraftRng.js";
import { EraDraftDataError, EraDraftInvariantError, type EraDraftState } from "./eraDraftTypes.js";
import { ERA_IDS } from "./teamEvaluationV2.js";

const catalog = loadEraDraftCatalog();

test("strict canonical serialization round-trips every Phase 4 lifecycle state", () => {
  const setup = createEraDraftGame({ catalog, rootSeed: "phase-4-roundtrip" });
  const awaitingSpin = accepted(reduceEraDraft(catalog, setup, { type: "CHOOSE_ERA", eraId: "era-foundation" }));
  const awaitingPick = accepted(reduceEraDraft(catalog, awaitingSpin, { type: "SPIN" }));
  if (awaitingPick.phase !== "AWAITING_PICK") assert.fail("Expected AWAITING_PICK.");
  const respun = accepted(reduceEraDraft(catalog, awaitingPick, { type: "RESPIN" }));
  const partial = lockFirstLegal(catalog, awaitingPick);
  const xi = draftEraXi(catalog, "phase-4-roundtrip-xi", "era-foundation");
  const revealed = accepted(reduceEraDraft(catalog, xi, { type: "REVEAL_XI" }));
  const complete = accepted(reduceEraDraft(catalog, revealed, { type: "SIMULATE_SEASON" }));
  const states = [setup, awaitingSpin, awaitingPick, partial, respun, xi, revealed, complete];

  for (const state of states) {
    const serialized = serializeEraDraftState(state);
    const restored = restoreEraDraftState(catalog, serialized);
    assert.equal(serializeEraDraftState(restored), serialized, state.phase);
    assert.equal(canonicalEraDraftStateHash(restored), canonicalEraDraftStateHash(state), state.phase);
    assert.deepEqual(restored, state, state.phase);
    assert.ok(Object.isFrozen(restored));
  }

  const trigger = selectNormalSpinTeamSeason(catalog, "phase-4-recovery", "era-foundation", 0);
  const recoveryCatalog = wrapEraDraftCatalog(catalog, {
    getCandidatesForTeamSeason: (teamSeasonId) =>
      teamSeasonId === trigger.teamSeasonId ? [] : catalog.getCandidatesForTeamSeason(teamSeasonId),
  });
  const recoverySetup = createEraDraftGame({ catalog: recoveryCatalog, rootSeed: "phase-4-recovery" });
  const recoveryChosen = accepted(reduceEraDraft(recoveryCatalog, recoverySetup, {
    type: "CHOOSE_ERA", eraId: "era-foundation",
  }));
  const recovered = accepted(reduceEraDraft(recoveryCatalog, recoveryChosen, { type: "SPIN" }));
  assert.equal(recovered.phase, "AWAITING_PICK");
  if (recovered.phase === "AWAITING_PICK") assert.ok(recovered.currentSpin.recovery);
  const restoredRecovery = restoreEraDraftState(recoveryCatalog, serializeEraDraftState(recovered));
  assert.deepEqual(restoredRecovery, recovered);
  if (recovered.phase !== "AWAITING_PICK") assert.fail("Expected recovered AWAITING_PICK.");
  const recoveredLock = firstLegalCommand(recoveryCatalog, recovered);
  assert.deepEqual(
    reduceEraDraft(recoveryCatalog, restoredRecovery, recoveredLock),
    reduceEraDraft(recoveryCatalog, recovered, recoveredLock),
  );
});

test("restored states produce identical future reducer results and RNG outcomes", () => {
  const setup = createEraDraftGame({ catalog, rootSeed: "phase-4-future" });
  const awaitingSpin = accepted(reduceEraDraft(catalog, setup, { type: "CHOOSE_ERA", eraId: "era-foundation" }));
  const restoredSpin = restoreEraDraftState(catalog, serializeEraDraftState(awaitingSpin));
  assert.deepEqual(
    reduceEraDraft(catalog, restoredSpin, { type: "SPIN" }),
    reduceEraDraft(catalog, awaitingSpin, { type: "SPIN" }),
  );

  const awaitingPick = accepted(reduceEraDraft(catalog, awaitingSpin, { type: "SPIN" }));
  if (awaitingPick.phase !== "AWAITING_PICK") assert.fail("Expected AWAITING_PICK.");
  const restoredPick = restoreEraDraftState(catalog, serializeEraDraftState(awaitingPick));
  const command = firstLegalCommand(catalog, awaitingPick);
  assert.deepEqual(reduceEraDraft(catalog, restoredPick, command), reduceEraDraft(catalog, awaitingPick, command));

  const partial = lockFirstLegal(catalog, awaitingPick);
  const restoredPartial = restoreEraDraftState(catalog, serializeEraDraftState(partial));
  assert.deepEqual(
    reduceEraDraft(catalog, restoredPartial, { type: "SPIN" }),
    reduceEraDraft(catalog, partial, { type: "SPIN" }),
  );

  const respun = accepted(reduceEraDraft(catalog, awaitingPick, { type: "RESPIN" }));
  if (respun.phase !== "AWAITING_PICK") assert.fail("Expected respun AWAITING_PICK.");
  const restoredRespin = restoreEraDraftState(catalog, serializeEraDraftState(respun));
  const respinLock = firstLegalCommand(catalog, respun);
  assert.deepEqual(
    reduceEraDraft(catalog, restoredRespin, respinLock),
    reduceEraDraft(catalog, respun, respinLock),
  );

  const xi = draftEraXi(catalog, "phase-4-future-xi", "era-foundation");
  const restoredXi = restoreEraDraftState(catalog, serializeEraDraftState(xi));
  assert.deepEqual(
    reduceEraDraft(catalog, restoredXi, { type: "REVEAL_XI" }),
    reduceEraDraft(catalog, xi, { type: "REVEAL_XI" }),
  );

  const revealed = accepted(reduceEraDraft(catalog, xi, { type: "REVEAL_XI" }));
  const restoredReveal = restoreEraDraftState(catalog, serializeEraDraftState(revealed));
  assert.deepEqual(
    reduceEraDraft(catalog, restoredReveal, { type: "SIMULATE_SEASON" }),
    reduceEraDraft(catalog, revealed, { type: "SIMULATE_SEASON" }),
  );
});

test("serialized unrevealed states retain the Phase 3 hidden-information boundary", () => {
  const setup = createEraDraftGame({ catalog, rootSeed: "phase-4-save-leaks" });
  const awaitingSpin = accepted(reduceEraDraft(catalog, setup, { type: "CHOOSE_ERA", eraId: "era-foundation" }));
  const awaitingPick = accepted(reduceEraDraft(catalog, awaitingSpin, { type: "SPIN" }));
  const partial = lockFirstLegal(catalog, awaitingPick);
  const xi = draftEraXi(catalog, "phase-4-save-leaks-xi", "era-foundation");
  for (const state of [setup, awaitingSpin, awaitingPick, partial, xi]) {
    assertNoPersistedQualityLeak(JSON.parse(serializeEraDraftState(state)));
  }
});

test("restore fails closed on malformed shapes, versions, drift, and invalid authoritative state", () => {
  const xi = draftEraXi(catalog, "phase-4-corruption-xi", "era-foundation");
  const revealed = accepted(reduceEraDraft(catalog, xi, { type: "REVEAL_XI" }));
  const complete = accepted(reduceEraDraft(catalog, revealed, { type: "SIMULATE_SEASON" }));

  assertDataFailure(() => restoreEraDraftState(catalog, "{"), "INVALID_SERIALIZED_JSON");
  corruptAndReject(xi, (row) => { row.extra = true; }, "INVALID_SERIALIZED_SHAPE");
  corruptAndReject(xi, (row) => { delete row.revision; }, "INVALID_SERIALIZED_SHAPE");
  corruptAndReject(xi, (row) => { row.saveVersion = "unsupported"; }, "UNSUPPORTED_SAVE_VERSION");
  corruptAndReject(xi, (row) => { row.engineVersion = "unsupported"; }, "UNSUPPORTED_ENGINE_VERSION");
  corruptAndReject(xi, (row) => { row.stateSchemaVersion = "unsupported"; }, "UNSUPPORTED_STATE_SCHEMA_VERSION");
  corruptAndReject(xi, (row) => { row.catalogFingerprint = "0".repeat(64); }, "CATALOG_FINGERPRINT_MISMATCH");
  corruptAndReject(xi, (row) => { row.respin.status = "USED"; }, "RESPIN_STATUS_MISMATCH", true);
  corruptAndReject(xi, (row) => { row.rngCounters.normalSpin += 1; }, "NORMAL_SPIN_COUNTER_MISMATCH", true);
  corruptAndReject(xi, (row) => { row.picks[1] = { ...row.picks[0], pickNumber: 2 }; }, undefined, true);
  corruptAndReject(xi, (row) => { row.picks[1].battingPosition = row.picks[0].battingPosition; }, undefined, true);
  corruptAndReject(xi, (row) => { row.picks[0].playerTeamSeasonId = "pts:tampered"; }, undefined, true);
  corruptAndReject(xi, (row) => { row.currentSpin = {}; }, "INVALID_SERIALIZED_SHAPE");
  const active = accepted(reduceEraDraft(
    catalog,
    accepted(reduceEraDraft(
      catalog,
      createEraDraftGame({ catalog, rootSeed: "phase-4-corrupt-spin" }),
      { type: "CHOOSE_ERA", eraId: "era-foundation" },
    )),
    { type: "SPIN" },
  ));
  corruptAndReject(active, (row) => { row.currentSpin.teamId = "team-tampered"; }, "CURRENT_SPIN_IDENTITY_MISMATCH", true);
  corruptAndReject(revealed, (row) => { row.evaluationSnapshot.version = "unsupported"; }, "TEAM_EVALUATION_VERSION_MISMATCH");
  corruptAndReject(revealed, (row) => { row.evaluationSnapshot.evaluationHash = "0".repeat(64); }, "TAMPERED_EVALUATION_SNAPSHOT");
  corruptAndReject(complete, (row) => { row.seasonSnapshot.simulationVersion = "unsupported"; }, "SIMULATION_VERSION_MISMATCH");
  corruptAndReject(complete, (row) => { row.seasonSnapshot.result.league.championTeamId = "tampered"; }, "TAMPERED_SIMULATION_RESULT");

  corruptAndReject(complete, (row) => {
    row.seasonSnapshot.result.league.championTeamId = "tampered";
    row.seasonSnapshot.resultHash = canonicalSha256(row.seasonSnapshot.result);
  }, "INVALID_CHAMPION");
});

test("GAME_COMPLETE persistence round-trips and rejects composition tampering in every era", () => {
  for (const eraId of ERA_IDS) {
    const xi = draftEraXi(catalog, `stage9a-persistence:${eraId}`, eraId);
    const revealed = accepted(reduceEraDraft(catalog, xi, { type: "REVEAL_XI" }));
    const complete = accepted(reduceEraDraft(catalog, revealed, { type: "SIMULATE_SEASON" }));
    assert.equal(complete.phase, "GAME_COMPLETE");
    if (complete.phase !== "GAME_COMPLETE") continue;
    const serialized = serializeEraDraftState(complete);
    const restored = restoreEraDraftState(catalog, serialized);
    assert.deepEqual(restored, complete);
    assert.equal(canonicalEraDraftStateHash(restored), canonicalEraDraftStateHash(complete));
    assert.deepEqual(
      (restored as typeof complete).season.opponentComposition,
      complete.season.opponentComposition,
    );

    for (const mutate of [
      (row: any) => { row.seasonSnapshot.result.opponentComposition.fullPoolProfileIds[0] = "opponent:tampered:full"; },
      (row: any) => { row.seasonSnapshot.result.opponentComposition.shortlistedProfileIds[0] = "opponent:tampered:shortlist"; },
      (row: any) => { row.seasonSnapshot.result.opponentComposition.shortlistedProfileIds.reverse(); },
      (row: any) => { row.seasonSnapshot.result.opponentComposition.eraId = eraId === "era-impact" ? "era-foundation" : "era-impact"; },
    ]) {
      corruptAndReject(complete, (row) => {
        mutate(row);
        row.seasonSnapshot.resultHash = canonicalSha256(row.seasonSnapshot.result);
      }, "OPPONENT_COMPOSITION_PROVENANCE_MISMATCH");
    }
    corruptAndReject(complete, (row) => {
      row.seasonSnapshot.result.league.omittedOpponentTeamId = "opponent:tampered:omitted";
    }, "TAMPERED_SIMULATION_RESULT");
  }
});

test("terminal restore uses the current catalog fingerprint even for Foundation compatibility seeds", () => {
  const xi = draftEraXi(catalog, "stage9a-foundation-current-drift", "era-foundation");
  const revealed = accepted(reduceEraDraft(catalog, xi, { type: "REVEAL_XI" }));
  const complete = accepted(reduceEraDraft(catalog, revealed, { type: "SIMULATE_SEASON" }));
  const row = JSON.parse(serializeEraDraftState(complete));
  row.catalogFingerprint = FOUNDATION_SIMULATION_COMPATIBILITY_FINGERPRINT;
  assertDataFailure(() => restoreEraDraftState(catalog, JSON.stringify(row)), "CATALOG_FINGERPRINT_MISMATCH");
});

function lockFirstLegal(activeCatalog: typeof catalog, state: EraDraftState): EraDraftState {
  if (state.phase !== "AWAITING_PICK") assert.fail("Expected AWAITING_PICK.");
  return accepted(reduceEraDraft(activeCatalog, state, firstLegalCommand(activeCatalog, state)));
}

function firstLegalCommand(activeCatalog: typeof catalog, state: Extract<EraDraftState, { phase: "AWAITING_PICK" }>) {
  const context = { eraId: state.eraId, picks: state.picks, activeTeamSeasonId: state.currentSpin.teamSeasonId };
  const choice = activeCatalog.getCandidatesForTeamSeason(state.currentSpin.teamSeasonId)
    .flatMap((player) => getOpenBattingPositions(state.picks).map((battingPosition) => ({ player, battingPosition })))
    .find(({ player, battingPosition }) => evaluateSelectionLegality(
      activeCatalog, context, { playerTeamSeasonId: player.playerTeamSeasonId, battingPosition },
    ).available);
  assert.ok(choice);
  return { type: "LOCK_PLAYER" as const, playerTeamSeasonId: choice.player.playerTeamSeasonId, battingPosition: choice.battingPosition };
}

function corruptAndReject(
  state: EraDraftState,
  mutate: (row: any) => void,
  expectedCode?: string,
  allowInvariant = false,
): void {
  const row = JSON.parse(serializeEraDraftState(state));
  mutate(row);
  assert.throws(
    () => restoreEraDraftState(catalog, JSON.stringify(row)),
    (error) => {
      if (!(error instanceof EraDraftDataError) && !(allowInvariant && error instanceof EraDraftInvariantError)) return false;
      return expectedCode === undefined || error.code === expectedCode;
    },
  );
}

function assertDataFailure(action: () => unknown, code: string): void {
  assert.throws(action, (error) => error instanceof EraDraftDataError && error.code === code);
}

function assertNoPersistedQualityLeak(value: unknown): void {
  const forbidden = new Set([
    "evaluationSnapshot", "seasonSnapshot", "quality", "battingRating", "bowlingRating", "overallRating",
    "qualityTier", "internalScore", "secondaryBonus", "baseStrength", "adjustedStrength", "bandDistance",
    "bowlingCapacity", "phaseBowlingUsage",
  ]);
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) return item.forEach(visit);
    if (typeof item !== "object" || item === null) return;
    for (const [key, nested] of Object.entries(item)) {
      assert.equal(forbidden.has(key), false, `unrevealed save leaked ${key}`);
      visit(nested);
    }
  };
  visit(value);
}
