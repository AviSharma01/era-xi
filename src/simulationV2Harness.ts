import {
  loadEraEnvironmentsV2,
  loadFoundationOpponentProfilesV2,
  loadOpponentXiInputV2,
  opponentAsSimulationTeamV2,
} from "./stage7Data.js";
import { evaluateCompletedEraXi, type EraCompletedXiInput, type EraXiPlayerInput } from "./teamEvaluationV2.js";
import {
  INITIAL_SIMULATION_V2_MODEL,
  simulateLeagueAndPlayoffsV2,
  simulateMatchV2,
  type EraEnvironmentV2,
  type MatchResultV2,
  type SimulationTeamV2,
} from "./simulationV2.js";
import {
  passesStrengthResponseBand,
  strengthResponseAcceptanceBand,
  STRENGTH_RESPONSE_ACCEPTANCE_BANDS,
  STRENGTH_RESPONSE_DIFFERENTIALS,
} from "./simulationV2Acceptance.js";

type Mode = "match" | "league" | "monte-carlo" | "sensitivity" | "validate";

const options = parseArgs(process.argv.slice(2));
const environments = loadEraEnvironmentsV2();
const environment = environments.find((item) => item.eraId === options.eraId);
if (!environment) throw new Error(`Unknown era environment ${options.eraId}.`);
const profiles = loadFoundationOpponentProfilesV2();
const opponents = profiles.map(opponentAsSimulationTeamV2);
const averageStrength = {
  batting: average(opponents.map((team) => team.strength.batting)),
  bowling: average(opponents.map((team) => team.strength.bowling)),
  overall: average(opponents.map((team) => team.strength.overall)),
};
const userTeam: SimulationTeamV2 = { teamId: "user", displayName: "User XI", strength: averageStrength };

let output: unknown;
if (options.mode === "match") {
  output = simulateMatchV2({ seed: options.seed, matchId: "harness-match", teamA: userTeam, teamB: opponents[0], environment });
} else if (options.mode === "league") {
  output = simulateLeagueAndPlayoffsV2({
    compositionSeed: options.compositionSeed, simulationSeed: options.seed, userTeam, opponentPool: opponents, environment,
  });
} else if (options.mode === "monte-carlo") {
  output = monteCarlo(options.iterations, environment, opponents, userTeam, options.seed);
} else if (options.mode === "sensitivity") {
  output = sensitivity(profiles[0], options.iterations, environment);
} else {
  const monteCarloByEra = Object.fromEntries(environments.map((item) => [
    item.eraId, matchDistribution(options.iterations, item, averageStrength, options.seed),
  ]));
  const monteCarloResult = monteCarlo(options.iterations, environment, opponents, userTeam, options.seed);
  const sensitivityResult = sensitivity(profiles[0], options.iterations, environment);
  output = {
    schemaVersion: "ipl-era-simulation-v2-validation/v1",
    model: INITIAL_SIMULATION_V2_MODEL,
    acceptance: acceptance(monteCarloByEra, monteCarloResult, sensitivityResult),
    matchMonteCarloByEra: monteCarloByEra,
    foundationLeagueMonteCarlo: monteCarloResult,
    sensitivity: sensitivityResult,
  };
}
const serialized = `${JSON.stringify(output, null, 2)}\n`;
if (options.outputPath) {
  const outputPath = resolve(options.outputPath);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, serialized);
}
process.stdout.write(serialized);
if (options.mode === "validate" && !(output as { acceptance: { passed: boolean } }).acceptance.passed) {
  process.exitCode = 1;
}

function parseArgs(args: string[]): { mode: Mode; iterations: number; seed: string; compositionSeed: string; eraId: EraEnvironmentV2["eraId"]; outputPath?: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    if (args[index].startsWith("--")) values.set(args[index].slice(2), args[index + 1] ?? "true");
  }
  const mode = (values.get("mode") ?? "match") as Mode;
  if (!["match", "league", "monte-carlo", "sensitivity", "validate"].includes(mode)) throw new Error(`Unsupported mode ${mode}.`);
  const iterations = Number.parseInt(values.get("iterations") ?? "1000", 10);
  if (!Number.isInteger(iterations) || iterations < 1) throw new Error("--iterations must be a positive integer.");
  return {
    mode, iterations, seed: values.get("seed") ?? "stage7", compositionSeed: values.get("composition-seed") ?? "stage7-composition",
    eraId: (values.get("era") ?? "era-foundation") as EraEnvironmentV2["eraId"],
    outputPath: values.get("output"),
  };
}

function matchDistribution(iterations: number, environment: EraEnvironmentV2, strength: SimulationTeamV2["strength"], seed: string) {
  const neutralStrength = { batting: strength.overall, bowling: strength.overall, overall: strength.overall };
  const equalA: SimulationTeamV2 = { teamId: "a", displayName: "Equal A", strength: neutralStrength };
  const equalB: SimulationTeamV2 = { teamId: "b", displayName: "Equal B", strength: neutralStrength };
  const matches = Array.from({ length: iterations }, (_, index) => simulateMatchV2({
    seed: `${seed}:${index}`, matchId: "environment", teamA: equalA, teamB: equalB, environment,
  }));
  const innings = matches.flatMap((match) => match.innings);
  const firstInnings = matches.map((match) => match.innings[0]);
  const chases = matches.map((match) => match.innings[1]);
  return {
    iterations,
    averageFirstInningsRuns: rounded(average(firstInnings.map((item) => item.runs))),
    averageAllInningsRuns: rounded(average(innings.map((item) => item.runs))),
    averageWickets: rounded(average(innings.map((item) => item.wickets))),
    chaseSuccessRate: rounded(matches.filter((match) => match.resultType === "wickets").length / iterations),
    regulationTieRate: rounded(matches.filter((match) => match.resultType === "super_over").length / iterations),
    equalTeamAWinRate: rounded(matches.filter((match) => match.winnerTeamId === "a").length / iterations),
    nrrRunStandardDeviationProxy: rounded(standardDeviation(innings.map((item) => item.runs))),
    observedSuccessfulChaseBallRange: range(chases.filter((_, index) => matches[index].resultType === "wickets").map((item) => item.balls)),
    target: {
      firstInningsRuns: environment.runs.firstInningsMean,
      wickets: environment.wickets.mean,
      chaseRate: environment.chase.successRateExcludingTies,
      regulationTieRate: environment.regulationTieRate,
    },
  };
}

function monteCarlo(
  iterations: number, environment: EraEnvironmentV2, opponents: readonly SimulationTeamV2[], userTeam: SimulationTeamV2, seed: string,
) {
  const winProbabilityByStrengthDifferential = STRENGTH_RESPONSE_DIFFERENTIALS.map((gap) => {
    const teamA: SimulationTeamV2 = { teamId: "a", displayName: "A", strength: { batting: 60 + gap, bowling: 60 + gap, overall: 60 + gap } };
    const teamB: SimulationTeamV2 = { teamId: "b", displayName: "B", strength: { batting: 60, bowling: 60, overall: 60 } };
    let wins = 0;
    for (let index = 0; index < iterations; index += 1) {
      wins += simulateMatchV2({ seed: `${seed}:gap:${index}`, matchId: `gap:${gap}`, teamA, teamB, environment }).winnerTeamId === "a" ? 1 : 0;
    }
    const teamAWinRate = rounded(wins / iterations);
    const acceptanceBand = strengthResponseAcceptanceBand(gap);
    return {
      requestedStrengthDifferential: gap,
      runCount: iterations,
      wins,
      winRate: teamAWinRate,
      acceptanceBand,
      passesAcceptanceBand: passesStrengthResponseBand(teamAWinRate, acceptanceBand),
    };
  });
  const standings = Array(8).fill(0);
  const nrr: number[] = [];
  const omission = Object.fromEntries(opponents.map((team) => [team.teamId, 0])) as Record<string, number>;
  let qualified = 0; let finalist = 0; let champion = 0;
  for (let index = 0; index < iterations; index += 1) {
    const league = simulateLeagueAndPlayoffsV2({
      compositionSeed: `${seed}:composition:${index}`, simulationSeed: `${seed}:simulation:${index}`,
      userTeam, opponentPool: opponents, environment,
    });
    const userRow = league.standings.find((row) => row.teamId === "user");
    if (!userRow) throw new Error("Monte Carlo league omitted user row.");
    standings[userRow.position - 1] += 1;
    nrr.push(userRow.netRunRate);
    omission[league.omittedOpponentTeamId] += 1;
    qualified += userRow.qualified ? 1 : 0;
    finalist += league.playoffs.at(-1)?.firstBattingTeamId === "user" || league.playoffs.at(-1)?.chasingTeamId === "user" ? 1 : 0;
    champion += league.championTeamId === "user" ? 1 : 0;
  }
  return {
    iterations, model: INITIAL_SIMULATION_V2_MODEL,
    winProbabilityByStrengthDifferential,
    userStandingDistribution: standings.map((count, index) => ({ position: index + 1, count, rate: rounded(count / iterations) })),
    userQualificationRate: rounded(qualified / iterations), userFinalRate: rounded(finalist / iterations), userChampionshipRate: rounded(champion / iterations),
    userNrrDistribution: { mean: rounded(average(nrr)), standardDeviation: rounded(standardDeviation(nrr)), minimum: rounded(Math.min(...nrr)), maximum: rounded(Math.max(...nrr)) },
    opponentOmissionFrequency: Object.entries(omission).map(([teamId, count]) => ({ teamId, omitted: count, selected: iterations - count, omissionRate: rounded(count / iterations) })),
    matchDistribution: matchDistribution(iterations, environment, userTeam.strength, seed),
  };
}

function sensitivity(profile: ReturnType<typeof loadFoundationOpponentProfilesV2>[number], iterations: number, environment: EraEnvironmentV2) {
  const baselineInput = loadOpponentXiInputV2(profile);
  const baseline = evaluateCompletedEraXi(baselineInput);
  const reversed = evaluateCompletedEraXi({ ...baselineInput, players: [...baselineInput.players].reverse().map((player, index) => ({ ...player, position: index + 1 as EraXiPlayerInput["position"] })) });
  const forcedFit = evaluateCompletedEraXi(mapXi(baselineInput, (player) => ({
    ...player,
    role: { ...player.role, battingFit: { ...player.role.battingFit, slots: player.role.battingFit.slots.map((slot) =>
      slot.position === player.position ? { ...slot, classification: "OUT_OF_ROLE" as const, bandDistance: 4 } : slot) } },
  })));
  const capacityLevels = [1, 0.75, 0.5, 0.25, 0].map((factor) => {
    const value = evaluateCompletedEraXi(mapXi(baselineInput, (player) => ({
      ...player, role: { ...player.role, bowlingCapacity: player.role.bowlingCapacity * factor },
    })));
    return { factor, bowling: rounded(value.adjustedStrength.bowling), uncoveredUnits: rounded(value.diagnostics.uncoveredBowlingUnits) };
  });
  const occasionalOnly = evaluateCompletedEraXi(mapXi(baselineInput, (player) => ({
    ...player,
    role: { ...player.role, bowlingCapacity: player.quality.bowling.bowlingRating === null ? 0 : 0.1875 },
  })));
  const descriptiveMutation = evaluateCompletedEraXi(mapXi(baselineInput, (player) => ({
    ...player,
    role: {
      ...player.role, bowlingFamily: player.role.bowlingFamily === "PACE" ? "SPIN" : "PACE",
      phaseBowlingUsage: {
        powerplay: { ...player.role.phaseBowlingUsage.powerplay, share: 1 },
        middle: { ...player.role.phaseBowlingUsage.middle, share: 0 },
        death: { ...player.role.phaseBowlingUsage.death, share: 0 },
      },
    },
  })));
  const baselineTeam = evaluationTeam("baseline", baseline);
  const opponent = evaluationTeam("opponent", baseline);
  return {
    sourceOpponent: profile.candidateId,
    storedEvaluationMatchesRuntime: near(profile.evaluation.batting, baseline.adjustedStrength.batting) && near(profile.evaluation.bowling, baseline.adjustedStrength.bowling),
    structuralOrder: {
      baselineBatting: rounded(baseline.adjustedStrength.batting), degradedBatting: rounded(reversed.adjustedStrength.batting),
      battingDelta: rounded(reversed.adjustedStrength.batting - baseline.adjustedStrength.batting),
      bowlingUnchanged: near(reversed.adjustedStrength.bowling, baseline.adjustedStrength.bowling),
      structuralEffect: rounded(reversed.diagnostics.structuralBattingOrderEffect), fitEffect: rounded(reversed.diagnostics.appliedPositionFitEffect),
    },
    positionFit: {
      baselineEffect: rounded(baseline.diagnostics.appliedPositionFitEffect), forcedEffect: rounded(forcedFit.diagnostics.appliedPositionFitEffect),
      cap: 4, capRespected: forcedFit.diagnostics.appliedPositionFitEffect >= -4,
      battingDelta: rounded(forcedFit.adjustedStrength.batting - baseline.adjustedStrength.batting),
      bowlingUnchanged: near(forcedFit.adjustedStrength.bowling, baseline.adjustedStrength.bowling),
    },
    bowlingCapacity: {
      levels: capacityLevels, monotonic: capacityLevels.every((item, index) => index === 0 || item.bowling <= capacityLevels[index - 1].bowling),
      occasionalOnlyBowling: rounded(occasionalOnly.adjustedStrength.bowling),
      occasionalOnlyDelta: rounded(occasionalOnly.adjustedStrength.bowling - baseline.adjustedStrength.bowling),
    },
    descriptiveDiagnostics: {
      strengthUnchanged: near(descriptiveMutation.adjustedStrength.batting, baseline.adjustedStrength.batting)
        && near(descriptiveMutation.adjustedStrength.bowling, baseline.adjustedStrength.bowling),
    },
    illustrativeWinRates: [baseline, reversed, forcedFit, occasionalOnly].map((value, index) => {
      const candidate = evaluationTeam(`candidate-${index}`, value);
      let wins = 0;
      for (let run = 0; run < iterations; run += 1) {
        wins += simulateMatchV2({ seed: `sensitivity:${run}`, matchId: `case-${index}`, teamA: candidate, teamB: opponent, environment }).winnerTeamId === candidate.teamId ? 1 : 0;
      }
      return { case: ["baseline", "reversed-order", "forced-fit-cap", "occasional-only"][index], winRate: rounded(wins / iterations), strength: candidate.strength };
    }),
    baselineTeam,
  };
}

function acceptance(
  byEra: Record<string, ReturnType<typeof matchDistribution>>,
  monteCarloResult: ReturnType<typeof monteCarlo>,
  sensitivityResult: ReturnType<typeof sensitivity>,
) {
  const rates = monteCarloResult.winProbabilityByStrengthDifferential.map((item) => item.winRate);
  const responseByDifferential = new Map(
    monteCarloResult.winProbabilityByStrengthDifferential.map((item) => [item.requestedStrengthDifferential, item]),
  );
  const eraTracking = Object.values(byEra).every((item) => Math.abs(item.averageFirstInningsRuns - item.target.firstInningsRuns) <= 4
    && Math.abs(item.averageWickets - item.target.wickets) <= 0.5
    && Math.abs(item.chaseSuccessRate - item.target.chaseRate) <= 0.08
    && item.regulationTieRate >= 0.002 && item.regulationTieRate <= 0.04);
  const checks = {
    coefficientsRemainProvisional: INITIAL_SIMULATION_V2_MODEL.calibrationStatus === "PROVISIONAL",
    eraEnvironmentTracking: eraTracking,
    equalStrengthNeutral: responseByDifferential.get(0)?.passesAcceptanceBand === true,
    plusFiveStrengthBand: responseByDifferential.get(5)?.passesAcceptanceBand === true,
    plusTenStrengthBand: responseByDifferential.get(10)?.passesAcceptanceBand === true,
    strengthMonotonic: rates.every((rate, index) => index === 0 || rate > rates[index - 1]),
    structureAndFitIsolated: sensitivityResult.structuralOrder.bowlingUnchanged && sensitivityResult.positionFit.bowlingUnchanged,
    fitCapRespected: sensitivityResult.positionFit.capRespected,
    capacityMonotonic: sensitivityResult.bowlingCapacity.monotonic,
    occasionalOnlyMateriallyWeak: sensitivityResult.bowlingCapacity.occasionalOnlyDelta <= -10,
    descriptiveDiagnosticsNeutral: sensitivityResult.descriptiveDiagnostics.strengthUnchanged,
    runtimeArtifactAgreement: sensitivityResult.storedEvaluationMatchesRuntime,
  };
  return {
    passed: Object.values(checks).every(Boolean),
    strengthResponseRules: {
      sampledDifferentials: STRENGTH_RESPONSE_DIFFERENTIALS,
      bands: STRENGTH_RESPONSE_ACCEPTANCE_BANDS,
      bandBoundsInclusive: true,
      monotonicity: "strictly_increasing",
    },
    checks,
  };
}

function mapXi(input: EraCompletedXiInput, mapper: (player: EraXiPlayerInput) => EraXiPlayerInput): EraCompletedXiInput {
  return { ...input, players: input.players.map(mapper) };
}

function evaluationTeam(teamId: string, value: ReturnType<typeof evaluateCompletedEraXi>): SimulationTeamV2 {
  return { teamId, displayName: teamId, strength: {
    batting: value.adjustedStrength.batting, bowling: value.adjustedStrength.bowling, overall: value.adjustedStrength.overall,
  } };
}

function range(values: readonly number[]) { return values.length ? { minimum: Math.min(...values), maximum: Math.max(...values) } : null; }
function average(values: readonly number[]) { return values.reduce((sum, value) => sum + value, 0) / values.length; }
function standardDeviation(values: readonly number[]) { const center = average(values); return Math.sqrt(average(values.map((value) => (value - center) ** 2))); }
function rounded(value: number) { return Math.round(value * 1_000_000) / 1_000_000; }
function near(left: number, right: number) { return Math.abs(left - right) <= 0.00001; }
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
