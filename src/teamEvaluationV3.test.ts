import assert from "node:assert/strict";
import test from "node:test";
import { evaluationVersionOf } from "./teamEvaluationPolicy.js";
import { catalog } from "./evaluationV3TestSupport.js";
import { evaluateCompletedEraXi, type BattingPositionV2, type EraCompletedXiInput, type EraId } from "./teamEvaluationV2.js";
import { evaluateCompletedEraXiV3, positionPenaltySeverity, POSITION_PENALTY_PERCENT } from "./teamEvaluationV3.js";

function opponent(eraId: EraId, teamId: string): EraCompletedXiInput {
  const profile = catalog.getOpponentProfiles(eraId).find(row => row.teamId === teamId)!;
  return { era: catalog.getEra(eraId)!, players: profile.xi.map(row => {
    const record = catalog.getPlayer(row.playerTeamSeasonId)!;
    return { position: row.position as BattingPositionV2, role: record.role, quality: record.quality, rosterStatus: record.rosterStatus };
  }) };
}
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test("V3 mapping respects classifications, distant acceptable evidence and invalid combinations", () => {
  for (const [classification, distance, severity, percent] of [
    ["NATURAL", 0, "NATURAL", 0], ["UNKNOWN", null, "UNKNOWN", 0],
    ...[1, 2, 3, 4].map(d => ["ACCEPTABLE", d, "ACCEPTABLE", 5]),
    ["OUT_OF_ROLE", 2, "MODERATE", 12], ["OUT_OF_ROLE", 3, "MAJOR", 20], ["OUT_OF_ROLE", 4, "EXTREME", 30],
  ] as const) {
    const result = positionPenaltySeverity(classification as "NATURAL", distance as number | null);
    assert.equal(result, severity); assert.equal(POSITION_PENALTY_PERCENT[result], percent);
  }
  for (const distance of [null, 0, 1, 2.5, 5, NaN]) assert.throws(() => positionPenaltySeverity("OUT_OF_ROLE", distance));
  assert.throws(() => positionPenaltySeverity("UNKNOWN", 0));
  assert.throws(() => positionPenaltySeverity("NATURAL", 1));
  assert.throws(() => positionPenaltySeverity("ACCEPTABLE", null));
  assert.throws(() => evaluationVersionOf({ teamEvaluationVersion: null } as never));
  assert.throws(() => evaluationVersionOf({ teamEvaluationVersion: undefined }));
});

test("V3 applies percentages only to batting, retaining the floor and imputation diagnostics", () => {
  const input = structuredClone(opponent("era-expansion", "team-chennai-super-kings"));
  const cases = [
    [80, "NATURAL", 0, 80], [80, "ACCEPTABLE", 1, 76], [80, "OUT_OF_ROLE", 2, 70.4],
    [80, "OUT_OF_ROLE", 3, 64], [80, "OUT_OF_ROLE", 4, 56], [80, "UNKNOWN", null, 80],
    [25, "OUT_OF_ROLE", 4, 20], [20, "OUT_OF_ROLE", 4, 20], [null, "OUT_OF_ROLE", 4, 20],
  ] as const;
  for (const [rating, classification, distance, effective] of cases) {
    const player = input.players[0]!;
    player.quality.batting.battingRating = rating;
    Object.assign(player.role.battingFit.slots[player.position - 1]!, { classification, bandDistance: distance });
    const before = JSON.stringify(input), v2 = evaluateCompletedEraXi(input), result = evaluateCompletedEraXiV3(input), row = result.battingContributions[0]!;
    close(row.effectiveContribution, effective);
    assert.equal(row.floorApplied, (rating ?? 20) * (1 - row.penaltyPercent / 100) < 20);
    assert.equal(row.ratingImputed, rating === null);
    assert.deepEqual(result.bowlingDeployment, v2.bowlingDeployment);
    assert.equal(result.adjustedStrength.bowling, v2.adjustedStrength.bowling);
    assert.deepEqual(result.players.map(p => p.quality.overall), v2.players.map(p => p.quality.overall));
    close(result.baseStrength.batting - result.adjustedStrength.batting, result.battingContributions.reduce((sum, p) => sum + p.weightedDeduction, 0));
    close(result.adjustedStrength.overall, (result.adjustedStrength.batting + result.adjustedStrength.bowling) / 2);
    assert.equal(JSON.stringify(input), before);
  }
});

test("all committed player-slot combinations map safely without altering metadata", () => {
  let slots = 0, distantAcceptable = 0;
  for (const era of catalog.getEraIds()) for (const team of catalog.getTeamSeasonsForEra(era)) for (const player of catalog.getCandidatesForTeamSeason(team.teamSeasonId)) {
    for (const slot of player.role.battingFit.slots) {
      const severity = positionPenaltySeverity(slot.classification, slot.bandDistance); slots++;
      if (slot.classification === "ACCEPTABLE" && slot.bandDistance! > 1) { distantAcceptable++; assert.equal(severity, "ACCEPTABLE"); }
    }
  }
  assert.equal(slots, 32912); assert.equal(distantAcceptable, 539);
});

test("natural representative XIs are unchanged in all five eras", () => {
  const cases = [
    ["era-foundation", "team-rajasthan-royals"], ["era-expansion", "team-chennai-super-kings"],
    ["era-transition", "team-delhi-daredevils"], ["era-modern-pre-impact", "team-chennai-super-kings"], ["era-impact", "team-mumbai-indians"],
  ] as const;
  for (const [era, team] of cases) {
    const input = opponent(era, team), old = evaluateCompletedEraXi(input), result = evaluateCompletedEraXiV3(input);
    assert.ok(result.battingContributions.every(row => row.penaltyPercent === 0));
    assert.equal(result.adjustedStrength.batting, old.adjustedStrength.batting);
    assert.equal(result.adjustedStrength.overall, old.adjustedStrength.overall);
  }
});

test("elite opener placements preserve the existing bands, slot weights and calibrated contribution", () => {
  const input = opponent("era-transition", "team-royal-challengers-bangalore");
  const kohli = input.players.find(row => row.quality.playerId === "ba607b88")!;
  const relocate = (position: number) => ({ ...input, players: input.players.map(row => ({ ...row, position: (row.position === kohli.position ? position : row.position === position ? kohli.position : row.position) as BattingPositionV2 })) });
  for (const [position, expected] of [[1, 98.1], [2, 98.1], [4, 86.328], [8, 78.48], [9, 68.67], [10, 68.67], [11, 68.67]]) {
    const result = evaluateCompletedEraXiV3(relocate(position));
    close(result.battingContributions.find(row => row.playerId === kohli.quality.playerId)!.effectiveContribution, expected);
  }
  const tail = evaluateCompletedEraXiV3(relocate(11));
  assert.ok(Math.abs(tail.adjustedStrength.batting - 54.172) < 0.0005);
  close(tail.battingContributions.find(row => row.playerId === kohli.quality.playerId)!.weightedDeduction, 0.73575);
});

test("reversed Rajasthan 2022 has no four-point or percentage team cap", () => {
  const input = opponent("era-modern-pre-impact", "team-rajasthan-royals");
  const reversed = { ...input, players: input.players.map(row => ({ ...row, position: (12 - row.position) as BattingPositionV2 })) };
  const result = evaluateCompletedEraXiV3(reversed);
  assert.ok(result.diagnostics.appliedPositionFitDeduction > 6);
  assert.ok(Math.abs(result.adjustedStrength.batting - 41.7905) < 0.00005);
  assert.equal("positionFitCapApplied" in result.diagnostics, false);
  assert.equal("cap" in result.effects[0], false);
  const shuffled = { ...reversed, players: [...reversed.players].reverse() };
  assert.deepEqual(evaluateCompletedEraXiV3(shuffled), result);
});
