import assert from "node:assert/strict";
import test from "node:test";

import { loadEraDraftCatalog } from "./eraDraftData.js";
import { runEraDraftValidation } from "./eraDraftValidation.js";
import { ERA_IDS } from "./teamEvaluationV2.js";

const catalog = loadEraDraftCatalog();

test("deterministic headless validation completes all eras and Foundation full cycles", () => {
  const result = runEraDraftValidation({
    catalog,
    validationSeed: "phase-5-focused",
    drafts: 25,
    foundationCycles: 5,
  });
  assert.equal(result.deterministic.acceptance.passed, true);
  assert.equal(result.deterministic.completedRuns.totalDrafts, 30);
  assert.equal(result.deterministic.foundation.cycles, 5);
  assert.equal(result.deterministic.hiddenLeakCount, 0);
  assert.equal(result.deterministic.invariantFailureCount, 0);
  assert.equal(result.deterministic.replay.eventMismatches, 0);
  assert.equal(result.deterministic.replay.finalHashMismatches, 0);
  assert.equal(result.deterministic.serialization.failures, 0);
  assert.equal(result.deterministic.serialization.postRestoreDivergences, 0);
  for (const eraId of ERA_IDS) {
    assert.ok(result.deterministic.perEra[eraId].drafts > 0);
    assert.equal(result.deterministic.perEra[eraId].completionRate, 1);
    assert.equal(result.deterministic.perEra[eraId].deadEnds, 0);
  }
  assert.equal(result.deterministic.acceptance.allEraSimulationContentAvailable, true);
});

test("same validation seed produces byte-identical non-timing reports", () => {
  const input = { catalog, validationSeed: "phase-5-repeat", drafts: 10, foundationCycles: 2 } as const;
  const first = runEraDraftValidation(input);
  const second = runEraDraftValidation(input);
  assert.deepEqual(second.deterministic, first.deterministic);
  assert.equal(JSON.stringify(second.deterministic), JSON.stringify(first.deterministic));
});

test("validation explicitly covers recovery fixtures, pressure paths, and RNG isolation", () => {
  const result = runEraDraftValidation({
    catalog,
    validationSeed: "phase-5-adversarial",
    drafts: 100,
    foundationCycles: 10,
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
  assert.equal(result.deterministic.nondeterministicResultCount, 0);
});
