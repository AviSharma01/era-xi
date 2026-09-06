import type { EraId } from "./teamEvaluationV2.js";

export const SIMULATION_V2_VERSION = "ipl-era-draft-simulation/v2" as const;

export const INITIAL_SIMULATION_V2_MODEL = {
  schemaVersion: SIMULATION_V2_VERSION,
  calibrationStatus: "PROVISIONAL",
  runsCoefficient: 1.07,
  wicketsCoefficient: 0.08,
  superOverLogitCoefficient: 0.04,
} as const;

export type SimulationModelV2 = {
  schemaVersion: typeof SIMULATION_V2_VERSION;
  calibrationStatus: "PROVISIONAL";
  runsCoefficient: number;
  wicketsCoefficient: number;
  superOverLogitCoefficient: number;
};

export type EraEnvironmentV2 = {
  schemaVersion: string;
  eraId: EraId;
  label: string;
  seasonIds: readonly string[];
  sourceCohort: "all_normal";
  sample: { matches: number; innings: number };
  runs: {
    firstInningsMean: number;
    chaseInningsMean: number;
    allInningsMean: number;
    standardDeviation: number;
    observedMinimum: number;
    observedMaximum: number;
    simulationMinimum: number;
    simulationMaximum: number;
  };
  wickets: {
    mean: number;
    standardDeviation: number;
    runSlope: number;
    residualStandardDeviation: number;
  };
  chase: {
    successful: number;
    failed: number;
    tied: number;
    successRateExcludingTies: number;
    initialBiasRuns: number;
  };
  regulationTieRate: number;
  allOutBallsHistogram: readonly { balls: number; count: number }[];
};

export type TeamStrengthV2 = { batting: number; bowling: number; overall: number };
export type SimulationTeamV2 = { teamId: string; displayName: string; strength: TeamStrengthV2 };

export type InningsV2 = {
  teamId: string;
  runs: number;
  wickets: number;
  balls: number;
  allOut: boolean;
};

export type MatchResultV2 = {
  version: typeof SIMULATION_V2_VERSION;
  matchId: string;
  firstBattingTeamId: string;
  chasingTeamId: string;
  innings: readonly [InningsV2, InningsV2];
  winnerTeamId: string;
  loserTeamId: string;
  resultType: "runs" | "wickets" | "super_over";
  margin: number | null;
};

export type ScheduledMatchV2 = {
  matchId: string;
  round: number;
  leg: 1 | 2;
  homeTeamId: string;
  awayTeamId: string;
};

export type StandingsRowV2 = {
  position: number;
  teamId: string;
  displayName: string;
  played: number;
  won: number;
  lost: number;
  points: number;
  runsFor: number;
  ballsFacedForNrr: number;
  runsAgainst: number;
  ballsBowledForNrr: number;
  netRunRate: number;
  qualified: boolean;
};

export type PlayoffStageV2 = "qualifier_1" | "eliminator" | "qualifier_2" | "final";
export type PlayoffMatchV2 = MatchResultV2 & { stage: PlayoffStageV2 };

export type LeagueResultV2 = {
  version: typeof SIMULATION_V2_VERSION;
  compositionSeed: string;
  simulationSeed: string;
  omittedOpponentTeamId: string;
  teams: readonly SimulationTeamV2[];
  schedule: readonly ScheduledMatchV2[];
  leagueMatches: readonly MatchResultV2[];
  standings: readonly StandingsRowV2[];
  playoffs: readonly PlayoffMatchV2[];
  championTeamId: string;
};

export function simulateMatchV2(input: {
  seed: string | number;
  matchId: string;
  teamA: SimulationTeamV2;
  teamB: SimulationTeamV2;
  environment: EraEnvironmentV2;
  model?: SimulationModelV2;
}): MatchResultV2 {
  validateTeam(input.teamA);
  validateTeam(input.teamB);
  if (input.teamA.teamId === input.teamB.teamId) throw new Error("A match requires two distinct teams.");
  validateEnvironment(input.environment);
  const model = input.model ?? INITIAL_SIMULATION_V2_MODEL;
  const seed = String(input.seed);
  const firstBatting = random01(seed, input.matchId, "batting-first") < 0.5 ? input.teamA : input.teamB;
  const chasing = firstBatting === input.teamA ? input.teamB : input.teamA;
  const firstExpected = input.environment.runs.firstInningsMean
    + model.runsCoefficient * (firstBatting.strength.batting - chasing.strength.bowling);
  const firstRuns = boundedScore(
    firstExpected + normal(seed, input.matchId, "first-runs") * input.environment.runs.standardDeviation,
    input.environment,
  );
  const firstInnings = createInnings(
    firstBatting.teamId, firstRuns, firstExpected, firstBatting, chasing,
    input.environment, model, seed, input.matchId, "first", false,
  );
  const target = firstRuns + 1;
  const chaseExpected = input.environment.runs.firstInningsMean + input.environment.chase.initialBiasRuns
    + model.runsCoefficient * (chasing.strength.batting - firstBatting.strength.bowling);
  const chasePotential = boundedScore(
    chaseExpected + normal(seed, input.matchId, "chase-runs") * input.environment.runs.standardDeviation,
    input.environment,
  );
  const chaseSucceeded = chasePotential >= target;
  const chaseRuns = chaseSucceeded ? target : Math.min(firstRuns, chasePotential);
  const chaseInnings = createInnings(
    chasing.teamId, chaseRuns, chaseExpected, chasing, firstBatting,
    input.environment, model, seed, input.matchId, "chase", chaseSucceeded,
    chaseSucceeded ? Math.max(1, Math.min(120, Math.round(120 * target / Math.max(target, chasePotential)))) : undefined,
  );
  if (chaseRuns > firstRuns) {
    return result(input.matchId, firstBatting, chasing, firstInnings, chaseInnings, chasing, "wickets", 10 - chaseInnings.wickets);
  }
  if (chaseRuns < firstRuns) {
    return result(input.matchId, firstBatting, chasing, firstInnings, chaseInnings, firstBatting, "runs", firstRuns - chaseRuns);
  }
  const probabilityA = logistic(model.superOverLogitCoefficient * (input.teamA.strength.overall - input.teamB.strength.overall));
  const winner = random01(seed, input.matchId, "super-over") < probabilityA ? input.teamA : input.teamB;
  return result(input.matchId, firstBatting, chasing, firstInnings, chaseInnings, winner, "super_over", null);
}

export function selectLeagueOpponentsV2(
  compositionSeed: string | number,
  opponents: readonly SimulationTeamV2[],
): { selected: SimulationTeamV2[]; omitted: SimulationTeamV2 } {
  if (opponents.length !== 8 || new Set(opponents.map((team) => team.teamId)).size !== 8) {
    throw new Error("League composition requires exactly eight unique lineage opponents.");
  }
  const ordered = [...opponents].sort((left, right) => {
    const randomDifference = random01(String(compositionSeed), "composition", left.teamId)
      - random01(String(compositionSeed), "composition", right.teamId);
    return randomDifference || left.teamId.localeCompare(right.teamId);
  });
  return { selected: ordered.slice(0, 7), omitted: ordered[7] };
}

export function generateDoubleRoundRobinScheduleV2(teams: readonly SimulationTeamV2[]): ScheduledMatchV2[] {
  if (teams.length !== 8 || new Set(teams.map((team) => team.teamId)).size !== 8) {
    throw new Error("V2 double round robin requires eight unique teams.");
  }
  let rotation = teams.map((team) => team.teamId);
  const firstLeg: ScheduledMatchV2[] = [];
  for (let round = 1; round <= 7; round += 1) {
    for (let index = 0; index < 4; index += 1) {
      const left = rotation[index];
      const right = rotation[7 - index];
      const swap = (round + index) % 2 === 0;
      const homeTeamId = swap ? right : left;
      const awayTeamId = swap ? left : right;
      firstLeg.push({ matchId: `league-r${round}-m${index + 1}`, round, leg: 1, homeTeamId, awayTeamId });
    }
    rotation = [rotation[0], rotation[7], ...rotation.slice(1, 7)];
  }
  const secondLeg = firstLeg.map((match) => ({
    ...match, matchId: `league-r${match.round + 7}-m${match.matchId.split("-m")[1]}`,
    round: match.round + 7, leg: 2 as const, homeTeamId: match.awayTeamId, awayTeamId: match.homeTeamId,
  }));
  return [...firstLeg, ...secondLeg];
}

export function simulateLeagueAndPlayoffsV2(input: {
  compositionSeed: string | number;
  simulationSeed: string | number;
  userTeam: SimulationTeamV2;
  opponentPool: readonly SimulationTeamV2[];
  environment: EraEnvironmentV2;
  model?: SimulationModelV2;
}): LeagueResultV2 {
  if (input.userTeam.teamId !== "user") throw new Error("The user team must use teamId 'user'.");
  const composition = selectLeagueOpponentsV2(input.compositionSeed, input.opponentPool);
  const teams = [input.userTeam, ...composition.selected];
  const byId = new Map(teams.map((team) => [team.teamId, team]));
  const schedule = generateDoubleRoundRobinScheduleV2(teams);
  const leagueMatches = schedule.map((match) => simulateMatchV2({
    seed: input.simulationSeed, matchId: match.matchId,
    teamA: requiredTeam(byId, match.homeTeamId), teamB: requiredTeam(byId, match.awayTeamId),
    environment: input.environment, model: input.model,
  }));
  const standings = buildStandingsV2(teams, leagueMatches);
  const [first, second, third, fourth] = standings.slice(0, 4).map((row) => requiredTeam(byId, row.teamId));
  const playoffSeed = `${input.simulationSeed}`;
  const qualifier1 = withStage(simulateMatchV2({ seed: playoffSeed, matchId: "playoff-qualifier-1", teamA: first, teamB: second, environment: input.environment, model: input.model }), "qualifier_1");
  const eliminator = withStage(simulateMatchV2({ seed: playoffSeed, matchId: "playoff-eliminator", teamA: third, teamB: fourth, environment: input.environment, model: input.model }), "eliminator");
  const qualifier2 = withStage(simulateMatchV2({
    seed: playoffSeed, matchId: "playoff-qualifier-2", teamA: requiredTeam(byId, qualifier1.loserTeamId),
    teamB: requiredTeam(byId, eliminator.winnerTeamId), environment: input.environment, model: input.model,
  }), "qualifier_2");
  const final = withStage(simulateMatchV2({
    seed: playoffSeed, matchId: "playoff-final", teamA: requiredTeam(byId, qualifier1.winnerTeamId),
    teamB: requiredTeam(byId, qualifier2.winnerTeamId), environment: input.environment, model: input.model,
  }), "final");
  return {
    version: SIMULATION_V2_VERSION, compositionSeed: String(input.compositionSeed), simulationSeed: String(input.simulationSeed),
    omittedOpponentTeamId: composition.omitted.teamId, teams, schedule, leagueMatches, standings,
    playoffs: [qualifier1, eliminator, qualifier2, final], championTeamId: final.winnerTeamId,
  };
}

export function buildStandingsV2(teams: readonly SimulationTeamV2[], matches: readonly MatchResultV2[]): StandingsRowV2[] {
  const rows = new Map(teams.map((team) => [team.teamId, {
    teamId: team.teamId, displayName: team.displayName, played: 0, won: 0, lost: 0, points: 0,
    runsFor: 0, ballsFacedForNrr: 0, runsAgainst: 0, ballsBowledForNrr: 0,
  }]));
  for (const match of matches) {
    const [first, chase] = match.innings;
    accumulate(rows, first, chase);
    accumulate(rows, chase, first);
    const winner = requiredRow(rows, match.winnerTeamId);
    const loser = requiredRow(rows, match.loserTeamId);
    winner.won += 1; winner.points += 2; loser.lost += 1;
  }
  return [...rows.values()].map((row) => ({
    ...row, position: 0,
    netRunRate: row.runsFor * 6 / row.ballsFacedForNrr - row.runsAgainst * 6 / row.ballsBowledForNrr,
    qualified: false,
  })).sort((left, right) => right.points - left.points || right.netRunRate - left.netRunRate || right.won - left.won || left.teamId.localeCompare(right.teamId))
    .map((row, index) => ({ ...row, position: index + 1, qualified: index < 4 }));
}

function createInnings(
  teamId: string, runs: number, expectedRuns: number, battingTeam: SimulationTeamV2, bowlingTeam: SimulationTeamV2,
  environment: EraEnvironmentV2, model: SimulationModelV2, seed: string, matchId: string, domain: string,
  successfulChase: boolean, successfulChaseBalls?: number,
): InningsV2 {
  const wicketMean = environment.wickets.mean
    + model.wicketsCoefficient * (bowlingTeam.strength.bowling - battingTeam.strength.batting)
    + environment.wickets.runSlope * (runs - expectedRuns);
  let wickets = Math.max(0, Math.min(10, Math.round(
    wicketMean + normal(seed, matchId, `${domain}-wickets`) * environment.wickets.residualStandardDeviation,
  )));
  if (successfulChase) wickets = Math.min(9, wickets);
  const allOut = wickets === 10;
  const balls = successfulChaseBalls ?? (allOut ? sampleAllOutBalls(environment, seed, matchId, domain) : 120);
  return { teamId, runs, wickets, balls, allOut };
}

function sampleAllOutBalls(environment: EraEnvironmentV2, seed: string, matchId: string, domain: string): number {
  const total = environment.allOutBallsHistogram.reduce((sum, item) => sum + item.count, 0);
  if (total === 0) return 120;
  let draw = random01(seed, matchId, `${domain}-all-out-balls`) * total;
  for (const item of environment.allOutBallsHistogram) {
    draw -= item.count;
    if (draw < 0) return Math.max(1, Math.min(120, item.balls));
  }
  return 120;
}

function result(
  matchId: string, first: SimulationTeamV2, chase: SimulationTeamV2, firstInnings: InningsV2, chaseInnings: InningsV2,
  winner: SimulationTeamV2, resultType: MatchResultV2["resultType"], margin: number | null,
): MatchResultV2 {
  const loser = winner.teamId === first.teamId ? chase : first;
  return { version: SIMULATION_V2_VERSION, matchId, firstBattingTeamId: first.teamId, chasingTeamId: chase.teamId,
    innings: [firstInnings, chaseInnings], winnerTeamId: winner.teamId, loserTeamId: loser.teamId, resultType, margin };
}

function withStage(match: MatchResultV2, stage: PlayoffStageV2): PlayoffMatchV2 { return { ...match, stage }; }

function boundedScore(score: number, environment: EraEnvironmentV2): number {
  return Math.max(environment.runs.simulationMinimum, Math.min(environment.runs.simulationMaximum, Math.round(score)));
}

function accumulate(
  rows: Map<string, { teamId: string; displayName: string; played: number; won: number; lost: number; points: number; runsFor: number; ballsFacedForNrr: number; runsAgainst: number; ballsBowledForNrr: number }>,
  own: InningsV2, opposition: InningsV2,
): void {
  const row = requiredRow(rows, own.teamId);
  row.played += 1; row.runsFor += own.runs; row.ballsFacedForNrr += own.allOut ? 120 : own.balls;
  row.runsAgainst += opposition.runs; row.ballsBowledForNrr += opposition.allOut ? 120 : opposition.balls;
}

function requiredRow<T>(rows: Map<string, T>, teamId: string): T {
  const row = rows.get(teamId); if (!row) throw new Error(`Missing standings row for ${teamId}.`); return row;
}

function requiredTeam(teams: Map<string, SimulationTeamV2>, teamId: string): SimulationTeamV2 {
  const team = teams.get(teamId); if (!team) throw new Error(`Missing team ${teamId}.`); return team;
}

function validateTeam(team: SimulationTeamV2): void {
  if (!team.teamId || !team.displayName || ![team.strength.batting, team.strength.bowling, team.strength.overall].every(Number.isFinite)) {
    throw new Error("Simulation V2 team profiles require IDs, names, and finite strengths.");
  }
}

function validateEnvironment(environment: EraEnvironmentV2): void {
  if (environment.sourceCohort !== "all_normal" || environment.sample.matches <= 0 || environment.runs.standardDeviation <= 0) {
    throw new Error("Simulation V2 requires a non-empty all_normal era environment.");
  }
}

function logistic(value: number): number { return 1 / (1 + Math.exp(-value)); }

function normal(...domains: readonly string[]): number {
  const u1 = Math.max(Number.EPSILON, random01(...domains, "normal-u1"));
  const u2 = random01(...domains, "normal-u2");
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

export function random01(...domains: readonly string[]): number {
  const text = domains.join("\u001f");
  let value = 1779033703 ^ text.length;
  for (const character of text) {
    value = Math.imul(value ^ character.charCodeAt(0), 3432918353);
    value = value << 13 | value >>> 19;
  }
  value = Math.imul(value ^ value >>> 16, 2246822507);
  value = Math.imul(value ^ value >>> 13, 3266489909);
  return ((value ^= value >>> 16) >>> 0) / 4294967296;
}
