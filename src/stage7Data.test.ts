import assert from "node:assert/strict";
import test from "node:test";

import {
  EXPECTED_OPPONENT_PROFILE_COUNTS,
  loadAllEraOpponentProfilesV2,
  loadEraEnvironmentsV2,
  loadEraOpponentProfilesV2,
  loadFoundationOpponentProfilesV2,
  loadOpponentXiInputV2,
  opponentAsSimulationTeamV2,
} from "./stage7Data.js";
import { evaluateCompletedEraXi } from "./teamEvaluationV2.js";

const EXPECTED_LINEAGES = {
  "era-foundation": ["franchise-chennai-super-kings", "franchise-deccan-chargers", "franchise-delhi", "franchise-kolkata-knight-riders", "franchise-mumbai-indians", "franchise-punjab", "franchise-rajasthan-royals", "franchise-royal-challengers"],
  "era-expansion": ["franchise-chennai-super-kings", "franchise-deccan-chargers", "franchise-delhi", "franchise-kochi-tuskers-kerala", "franchise-kolkata-knight-riders", "franchise-mumbai-indians", "franchise-pune-warriors", "franchise-punjab", "franchise-rajasthan-royals", "franchise-royal-challengers", "franchise-sunrisers-hyderabad"],
  "era-transition": ["franchise-chennai-super-kings", "franchise-delhi", "franchise-gujarat-lions", "franchise-kolkata-knight-riders", "franchise-mumbai-indians", "franchise-punjab", "franchise-rajasthan-royals", "franchise-rising-pune", "franchise-royal-challengers", "franchise-sunrisers-hyderabad"],
  "era-modern-pre-impact": ["franchise-chennai-super-kings", "franchise-delhi", "franchise-gujarat-titans", "franchise-kolkata-knight-riders", "franchise-lucknow-super-giants", "franchise-mumbai-indians", "franchise-punjab", "franchise-rajasthan-royals", "franchise-royal-challengers", "franchise-sunrisers-hyderabad"],
  "era-impact": ["franchise-chennai-super-kings", "franchise-delhi", "franchise-gujarat-titans", "franchise-kolkata-knight-riders", "franchise-lucknow-super-giants", "franchise-mumbai-indians", "franchise-punjab", "franchise-rajasthan-royals", "franchise-royal-challengers", "franchise-sunrisers-hyderabad"],
} as const;

test("generated Stage 7 environments satisfy the all-era runtime contract", () => {
  const environments = loadEraEnvironmentsV2();
  assert.equal(environments.length, 5);
  assert.deepEqual(environments.map((item) => item.eraId), [
    "era-foundation", "era-expansion", "era-transition", "era-modern-pre-impact", "era-impact",
  ]);
  assert.ok(environments.every((item) => item.sourceCohort === "all_normal" && item.sample.matches > 0));
});

test("all 49 reviewed era profiles are legal, deterministic, and reproduce frozen strengths", () => {
  const pools = loadAllEraOpponentProfilesV2();
  const repeated = loadAllEraOpponentProfilesV2();
  assert.deepEqual(repeated, pools);
  assert.deepEqual(loadEraOpponentProfilesV2("era-foundation"), loadFoundationOpponentProfilesV2());
  for (const [eraId, expectedCount] of Object.entries(EXPECTED_OPPONENT_PROFILE_COUNTS)) {
    const profiles = pools[eraId as keyof typeof pools];
    assert.equal(profiles.length, expectedCount);
    assert.equal(new Set(profiles.map((profile) => profile.franchiseId)).size, expectedCount);
    assert.ok(profiles.every((profile) => profile.eraId === eraId));
    assert.deepEqual(profiles.map((profile) => profile.franchiseId), EXPECTED_LINEAGES[eraId as keyof typeof EXPECTED_LINEAGES]);
    assert.deepEqual(profiles.map((profile) => profile.candidateId), repeated[eraId as keyof typeof pools].map((profile) => profile.candidateId));
  }
  for (const profile of Object.values(pools).flat()) {
    const actual = evaluateCompletedEraXi(loadOpponentXiInputV2(profile));
    assert.ok(Math.abs(actual.adjustedStrength.batting - profile.evaluation.batting) < 0.00001);
    assert.ok(Math.abs(actual.adjustedStrength.bowling - profile.evaluation.bowling) < 0.00001);
    assert.ok(Math.abs(actual.adjustedStrength.overall - profile.evaluation.overall) < 0.00001);
    const simulationTeam = opponentAsSimulationTeamV2(profile);
    assert.equal(simulationTeam.strength.overall, profile.evaluation.overall);
  }
});
