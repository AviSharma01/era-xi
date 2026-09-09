import assert from "node:assert/strict";
import test from "node:test";

import { loadEraDraftCatalog } from "./eraDraftData.js";
import { runEraDraftValidation } from "./eraDraftValidation.js";
import { ERA_IDS } from "./teamEvaluationV2.js";

const catalog = loadEraDraftCatalog();

test("deterministic headless validation completes full seasons in all five eras", () => {
  const result = runEraDraftValidation({
    catalog,
    validationSeed: "stage9a-phase4-focused",
    games: 25,
  });
  assert.equal(result.deterministic.acceptance.passed, true);
  assert.equal(result.deterministic.completedRuns.completeGames, 25);
  assert.ok(Object.values(result.deterministic.correctnessCounters).every((count) => count === 0));
  assert.equal(result.deterministic.replay.eventMismatches, 0);
  assert.equal(result.deterministic.replay.finalHashMismatches, 0);
  assert.equal(result.deterministic.serialization.failures, 0);
  assert.equal(result.deterministic.serialization.postRestoreDivergences, 0);
  for (const eraId of ERA_IDS) {
    assert.ok(result.deterministic.perEra[eraId].drafts > 0);
    assert.equal(result.deterministic.perEra[eraId].completeGames, 5);
    assert.equal(result.deterministic.perEra[eraId].completionRate, 1);
    assert.equal(result.deterministic.perEra[eraId].deadEnds, 0);
    assert.ok(Object.values(result.deterministic.perEra[eraId].strategyRuns).every((count) => count > 0));
  }
  assert.equal(result.deterministic.acceptance.allEraSimulationContentAvailable, true);
});

test("same validation seed produces byte-identical all-era non-timing reports", () => {
  const input = { catalog, validationSeed: "stage9a-phase4-repeat", games: 25 } as const;
  const first = runEraDraftValidation(input);
  const second = runEraDraftValidation(input);
  assert.deepEqual(second.deterministic, first.deterministic);
  assert.equal(JSON.stringify(second.deterministic), JSON.stringify(first.deterministic));
});

test("validation explicitly covers recovery fixtures, pressure paths, and RNG isolation", () => {
  const result = runEraDraftValidation({
    catalog,
    validationSeed: "stage9a-phase4-adversarial",
    games: 100,
  });
  assert.equal(result.deterministic.recovery.synthetic.deterministicSameSeed, true);
  assert.ok(result.deterministic.recovery.synthetic.differentSeedOrderingHeads > 1);
  assert.equal(result.deterministic.recovery.synthetic.globallyImpossibleErrorCode, "NO_VIABLE_TEAM_SEASON");
  assert.ok(result.deterministic.pressure.duplicateAttempts > 0);
  assert.ok(result.deterministic.pressure.overseasLimitAttempts > 0);
  assert.ok(result.deterministic.pressure.keeperFeasibilityAttempts > 0);
  assert.ok(result.deterministic.pressure.occupiedSlotAttempts > 0);
  assert.equal(result.deterministic.rngIsolation.compositionAndMatchDomainsDistinct, true);
  assert.equal(result.deterministic.rngIsolation.rejectedCommandsPreserveSimulation, true);
  assert.equal(result.deterministic.rngIsolation.simulationDoesNotPerturbDraftSpins, true);
  assert.equal(result.deterministic.rngIsolation.normalRespinRecoveryDomainsDistinct, true);
  assert.equal(result.deterministic.rngIsolation.draftAndShortlistDomainsDistinct, true);
  assert.equal(result.deterministic.correctnessCounters.nondeterministicResults, 0);
  assert.ok(result.deterministic.serialization.byTarget.GAME_COMPLETE > 0);
  assert.equal(result.deterministic.replay.runs, 100);
});
