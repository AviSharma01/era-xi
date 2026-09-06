import assert from "node:assert/strict";
import test from "node:test";

import {
  INITIAL_SIMULATION_V2_MODEL,
  generateDoubleRoundRobinScheduleV2,
  random01,
  simulateLeagueAndPlayoffsV2,
  simulateMatchV2,
  type EraEnvironmentV2,
  type SimulationTeamV2,
} from "./simulationV2.js";
import {
  passesStrengthResponseBand,
  strengthResponseAcceptanceBand,
  STRENGTH_RESPONSE_ACCEPTANCE_BANDS,
  STRENGTH_RESPONSE_DIFFERENTIALS,
} from "./simulationV2Acceptance.js";

const environment: EraEnvironmentV2 = {
  schemaVersion: "ipl-era-simulation/v2", eraId: "era-foundation", label: "Foundation Era",
  seasonIds: ["ipl-2008", "ipl-2009", "ipl-2010"], sourceCohort: "all_normal", sample: { matches: 175, innings: 350 },
  runs: { firstInningsMean: 159, chaseInningsMean: 153, allInningsMean: 156, standardDeviation: 31,
    observedMinimum: 58, observedMaximum: 246, simulationMinimum: 38, simulationMaximum: 276 },
  wickets: { mean: 6.02, standardDeviation: 2.3, runSlope: -0.02, residualStandardDeviation: 1.9 },
  chase: { successful: 90, failed: 83, tied: 2, successRateExcludingTies: 0.52, initialBiasRuns: 2.2 },
  regulationTieRate: 0.011, allOutBallsHistogram: [{ balls: 100, count: 1 }, { balls: 120, count: 1 }],
};

function team(teamId: string, rating: number): SimulationTeamV2 {
  return { teamId, displayName: teamId, strength: { batting: rating, bowling: rating, overall: rating } };
}

test("match output is deterministic and RNG domains are isolated", () => {
  const input = { seed: "seed", matchId: "m1", teamA: team("a", 60), teamB: team("b", 60), environment };
  assert.deepEqual(simulateMatchV2(input), simulateMatchV2(input));
  assert.equal(random01("seed", "m1", "runs"), random01("seed", "m1", "runs"));
  assert.notEqual(random01("seed", "m1", "runs"), random01("seed", "m1", "wickets"));
});

test("approved strength-response bands are explicit, inclusive, and unchanged", () => {
  assert.equal(INITIAL_SIMULATION_V2_MODEL.runsCoefficient, 1.07);
  assert.equal(INITIAL_SIMULATION_V2_MODEL.wicketsCoefficient, 0.08);
  assert.equal(INITIAL_SIMULATION_V2_MODEL.superOverLogitCoefficient, 0.04);
  assert.deepEqual(STRENGTH_RESPONSE_DIFFERENTIALS, [-10, -5, 0, 5, 10]);
  assert.deepEqual(STRENGTH_RESPONSE_ACCEPTANCE_BANDS, {
    0: { minimum: 0.46, maximum: 0.54 },
    5: { minimum: 0.58, maximum: 0.68 },
    10: { minimum: 0.68, maximum: 0.80 },
  });
  const plusTen = strengthResponseAcceptanceBand(10);
  assert.equal(passesStrengthResponseBand(0.68, plusTen), true);
  assert.equal(passesStrengthResponseBand(0.80, plusTen), true);
  assert.equal(passesStrengthResponseBand(0.679999, plusTen), false);
  assert.equal(passesStrengthResponseBand(0.800001, plusTen), false);
  assert.equal(passesStrengthResponseBand(0.5, strengthResponseAcceptanceBand(-5)), null);
});

test("successful chases always use 1-120 balls and can use ball 120", () => {
  const successful = Array.from({ length: 3000 }, (_, index) => simulateMatchV2({
    seed: index, matchId: "chase", teamA: team("a", 60), teamB: team("b", 60), environment,
  })).filter((match) => match.resultType === "wickets").map((match) => match.innings[1].balls);
  assert.ok(successful.length > 500);
  assert.ok(successful.every((balls) => balls >= 1 && balls <= 120));
  assert.ok(successful.includes(120));
});

test("stronger teams win monotonically more often while equal teams remain neutral", () => {
  const rates = [-15, 0, 15].map((gap) => {
    let wins = 0;
    for (let seed = 0; seed < 4000; seed += 1) {
      const match = simulateMatchV2({ seed, matchId: `gap-${gap}`, teamA: team("a", 60 + gap), teamB: team("b", 60), environment });
      wins += match.winnerTeamId === "a" ? 1 : 0;
    }
    return wins / 4000;
  });
  assert.ok(rates[0] < rates[1] && rates[1] < rates[2]);
  assert.ok(Math.abs(rates[1] - 0.5) < 0.03);
});

test("eight-team league has 56 matches, 14 per team, generic standings, and the IPL bracket", () => {
  const teams = Array.from({ length: 8 }, (_, index) => team(`t${index}`, 55 + index));
  const schedule = generateDoubleRoundRobinScheduleV2(teams);
  assert.equal(schedule.length, 56);
  assert.equal(new Set(schedule.map((match) => match.matchId)).size, 56);
  for (const entry of teams) {
    assert.equal(schedule.filter((match) => match.homeTeamId === entry.teamId || match.awayTeamId === entry.teamId).length, 14);
  }
  const league = simulateLeagueAndPlayoffsV2({
    compositionSeed: "composition", simulationSeed: "simulation", userTeam: { ...team("user", 62), displayName: "User" },
    opponentPool: teams, environment,
  });
  assert.equal(league.leagueMatches.length, 56);
  assert.equal(league.standings.length, 8);
  assert.equal(league.playoffs.length, 4);
  assert.equal(league.standings.reduce((sum, row) => sum + row.won, 0), 56);
  assert.equal(league.standings.reduce((sum, row) => sum + row.lost, 0), 56);
  assert.deepEqual(league, simulateLeagueAndPlayoffsV2({
    compositionSeed: "composition", simulationSeed: "simulation", userTeam: { ...team("user", 62), displayName: "User" },
    opponentPool: teams, environment,
  }));
});
