import assert from "node:assert/strict";
import test from "node:test";

import {
  loadEraEnvironmentsV2,
  loadEraOpponentProfilesV2,
  loadFoundationOpponentProfilesV2,
  loadOpponentXiInputV2,
  opponentAsSimulationTeamV2,
} from "./stage7Data.js";
import { evaluateCompletedEraXi } from "./teamEvaluationV2.js";

test("generated Stage 7 environments satisfy the all-era runtime contract", () => {
  const environments = loadEraEnvironmentsV2();
  assert.equal(environments.length, 5);
  assert.deepEqual(environments.map((item) => item.eraId), [
    "era-foundation", "era-expansion", "era-transition", "era-modern-pre-impact", "era-impact",
  ]);
  assert.ok(environments.every((item) => item.sourceCohort === "all_normal" && item.sample.matches > 0));
});

test("all eight reviewed Foundation profiles are legal and reproduce their frozen strengths", () => {
  const profiles = loadFoundationOpponentProfilesV2();
  assert.deepEqual(loadEraOpponentProfilesV2("era-foundation"), profiles);
  assert.throws(() => loadEraOpponentProfilesV2("era-expansion"), /No curated opponent content/);
  assert.equal(new Set(profiles.map((profile) => profile.franchiseId)).size, 8);
  for (const profile of profiles) {
    const actual = evaluateCompletedEraXi(loadOpponentXiInputV2(profile));
    assert.ok(Math.abs(actual.adjustedStrength.batting - profile.evaluation.batting) < 0.00001);
    assert.ok(Math.abs(actual.adjustedStrength.bowling - profile.evaluation.bowling) < 0.00001);
    assert.ok(Math.abs(actual.adjustedStrength.overall - profile.evaluation.overall) < 0.00001);
    const simulationTeam = opponentAsSimulationTeamV2(profile);
    assert.equal(simulationTeam.strength.overall, profile.evaluation.overall);
  }
});
