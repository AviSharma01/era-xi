import type { BattingPosition, ClassicDraftState } from "./draftClassic.js";
import type { BoostedTeamEvaluationV1, TeamBoostV1Id, TEAM_BOOST_V1_VERSION } from "./teamBoostV1.js";

export const SIMULATION_V1_VERSION = "simulation-v1" as const;

export const FRANCHISES_2016 = [
  { id: "delhi-daredevils", name: "Delhi Daredevils" },
  { id: "gujarat-lions", name: "Gujarat Lions" },
  { id: "kings-xi-punjab", name: "Kings XI Punjab" },
  { id: "kolkata-knight-riders", name: "Kolkata Knight Riders" },
  { id: "mumbai-indians", name: "Mumbai Indians" },
  { id: "rising-pune-supergiants", name: "Rising Pune Supergiants" },
  { id: "royal-challengers-bangalore", name: "Royal Challengers Bangalore" },
  { id: "sunrisers-hyderabad", name: "Sunrisers Hyderabad" },
] as const;

export type Franchise2016Id = (typeof FRANCHISES_2016)[number]["id"];
export type SimulationTeamId = "user" | Franchise2016Id;

export type TeamStrengthSnapshot = {
  battingComposite: number;
  bowlingComposite: number;
  overallTeamRating: number;
};

export type OpponentStrengthProfile = {
  franchiseId: Franchise2016Id;
  franchiseName: string;
  season: 2016;
  baseStrength: TeamStrengthSnapshot;
  adjustedStrength: TeamStrengthSnapshot;
  boostVersion: typeof TEAM_BOOST_V1_VERSION;
  appliedBoostIds: readonly TeamBoostV1Id[];
};

export type LeagueTeam =
  | {
      teamId: "user";
      displayName: string;
      replacedFranchiseId: Franchise2016Id;
    }
  | {
      teamId: Franchise2016Id;
      displayName: string;
      opponentProfile: OpponentStrengthProfile;
    };

export type ScheduledLeagueMatch = {
  id: string;
  round: number;
  leg: 1 | 2;
  homeTeamId: SimulationTeamId;
  awayTeamId: SimulationTeamId;
};

export const SIMULATION_V1_LEAGUE_CONSTANTS = {
  teams: 8,
  roundsPerLeg: 7,
  legs: 2,
  matchesPerRound: 4,
  matchesPerTeam: 14,
  totalMatches: 56,
} as const;

export const SIMULATION_V1_MATCH_CONSTANTS = {
  baselineRuns: 165,
  runsPerRatingPoint: 1.25,
  inningsRunStandardDeviation: 18,
  minimumRuns: 75,
  maximumRuns: 240,
  baselineWickets: 6,
  wicketsPerBowlingAdvantagePoint: 0.12,
  wicketStandardDeviation: 1.6,
  minimumCompletedInningsBalls: 90,
  maximumBalls: 120,
  bowlerCreditedWicketProbability: 0.88,
  pointsPerWin: 2,
  qualificationPlaces: 4,
  nrrPrecisionForDisplay: 3,
} as const;

export type InningsSummary = {
  teamId: SimulationTeamId;
  runs: number;
  wickets: number;
  balls: number;
  allOut: boolean;
};

export type LeagueMatchResult = {
  matchId: string;
  round: number;
  leg: 1 | 2;
  homeTeamId: SimulationTeamId;
  awayTeamId: SimulationTeamId;
  innings: readonly [InningsSummary, InningsSummary];
  winnerTeamId: SimulationTeamId;
  loserTeamId: SimulationTeamId;
  resultType: "runs" | "wickets" | "super_over";
  margin: number | null;
};

export type UserMatchSummary = {
  matchId: string;
  round: number;
  opponentTeamId: Franchise2016Id;
  result: "W" | "L";
  userInnings: InningsSummary;
  opponentInnings: InningsSummary;
  playerRuns: readonly { playerSeasonId: string; runs: number }[];
  playerWickets: readonly { playerSeasonId: string; wickets: number }[];
};

export type AccumulatedUserPlayerStats = {
  playerSeasonId: string;
  playerName: string;
  battingPosition: BattingPosition;
  matches: number;
  runs: number;
  wickets: number;
};

export type PointsTableRow = {
  position: number;
  teamId: SimulationTeamId;
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

export type LeagueSimulationResult = {
  version: typeof SIMULATION_V1_VERSION;
  seed: string;
  matches: readonly LeagueMatchResult[];
  pointsTable: readonly PointsTableRow[];
  userMatchSummaries: readonly UserMatchSummary[];
  userRecord: { played: number; won: number; lost: number; points: number; tablePosition: number };
  accumulatedUserPlayerStats: readonly AccumulatedUserPlayerStats[];
  topRunScorers: readonly AccumulatedUserPlayerStats[];
  topWicketTakers: readonly AccumulatedUserPlayerStats[];
  userQualified: boolean;
};

export type SimulateLeagueV1Input = {
  seed: string | number;
  teams: readonly LeagueTeam[];
  schedule: readonly ScheduledLeagueMatch[];
  userState: ClassicDraftState;
  userBoostedEvaluation: BoostedTeamEvaluationV1;
};

export type PlayoffStage = "qualifier_1" | "eliminator" | "qualifier_2" | "final";

export type UserPlayoffOutcome =
  | "not_qualified"
  | "eliminated_in_eliminator"
  | "eliminated_in_qualifier_2"
  | "runner_up"
  | "champion";

export type PlayoffMatchResult = {
  matchId: string;
  stage: PlayoffStage;
  firstBattingTeamId: SimulationTeamId;
  chasingTeamId: SimulationTeamId;
  innings: readonly [InningsSummary, InningsSummary];
  winnerTeamId: SimulationTeamId;
  loserTeamId: SimulationTeamId;
  resultType: "runs" | "wickets" | "super_over";
  margin: number | null;
};

export type UserPlayoffMatchSummary = {
  matchId: string;
  stage: PlayoffStage;
  opponentTeamId: Franchise2016Id;
  result: "W" | "L";
  userInnings: InningsSummary;
  opponentInnings: InningsSummary;
  playerRuns: readonly { playerSeasonId: string; runs: number }[];
  playerWickets: readonly { playerSeasonId: string; wickets: number }[];
};

export type SimulatePlayoffsV1Input = {
  leagueResult: LeagueSimulationResult;
  teams: readonly LeagueTeam[];
  userState: ClassicDraftState;
  userBoostedEvaluation: BoostedTeamEvaluationV1;
};

type PlayoffSimulationResultBase = {
  leaguePosition: number;
  matches: readonly PlayoffMatchResult[];
  userMatchSummaries: readonly UserPlayoffMatchSummary[];
  playoffPlayerStats: readonly AccumulatedUserPlayerStats[];
  combinedSeasonPlayerStats: readonly AccumulatedUserPlayerStats[];
};

export type PlayoffSimulationResult =
  | PlayoffSimulationResultBase & {
      qualified: false;
      championTeamId: null;
      userOutcome: "not_qualified";
    }
  | PlayoffSimulationResultBase & {
      qualified: true;
      leaguePosition: 1 | 2 | 3 | 4;
      championTeamId: SimulationTeamId;
      userOutcome: Exclude<UserPlayoffOutcome, "not_qualified">;
    };

export function isFranchise2016Id(value: string): value is Franchise2016Id {
  return FRANCHISES_2016.some((franchise) => franchise.id === value);
}

export function createLeagueComposition(
  replacedFranchiseId: Franchise2016Id,
  profiles: readonly OpponentStrengthProfile[],
): LeagueTeam[] {
  if (!isFranchise2016Id(replacedFranchiseId)) {
    throw new Error(`Unknown 2016 franchise: ${replacedFranchiseId}`);
  }
  const profilesById = new Map(profiles.map((profile) => [profile.franchiseId, profile]));
  if (profilesById.size !== FRANCHISES_2016.length) {
    throw new Error("League composition requires one opponent profile for every 2016 franchise.");
  }

  return FRANCHISES_2016.map((franchise): LeagueTeam => {
    if (franchise.id === replacedFranchiseId) {
      return {
        teamId: "user",
        displayName: franchise.name,
        replacedFranchiseId,
      };
    }
    const opponentProfile = profilesById.get(franchise.id);
    if (!opponentProfile) {
      throw new Error(`Missing opponent profile for ${franchise.name}.`);
    }
    return {
      teamId: franchise.id,
      displayName: franchise.name,
      opponentProfile,
    };
  });
}

export function generateDoubleRoundRobinSchedule(teams: readonly LeagueTeam[]): ScheduledLeagueMatch[] {
  validateScheduleTeams(teams);
  let rotation = teams.map((team) => team.teamId);
  const firstLeg: ScheduledLeagueMatch[] = [];

  for (let roundIndex = 0; roundIndex < SIMULATION_V1_LEAGUE_CONSTANTS.roundsPerLeg; roundIndex += 1) {
    for (let matchIndex = 0; matchIndex < SIMULATION_V1_LEAGUE_CONSTANTS.matchesPerRound; matchIndex += 1) {
      const left = rotation[matchIndex];
      const right = rotation[rotation.length - 1 - matchIndex];
      const swap = (roundIndex + matchIndex) % 2 === 1;
      firstLeg.push({
        id: matchId(roundIndex + 1, matchIndex + 1),
        round: roundIndex + 1,
        leg: 1,
        homeTeamId: swap ? right : left,
        awayTeamId: swap ? left : right,
      });
    }
    rotation = [rotation[0], rotation[rotation.length - 1], ...rotation.slice(1, -1)];
  }

  const secondLeg = firstLeg.map((match, index): ScheduledLeagueMatch => {
    const round = match.round + SIMULATION_V1_LEAGUE_CONSTANTS.roundsPerLeg;
    const matchIndex = index % SIMULATION_V1_LEAGUE_CONSTANTS.matchesPerRound;
    return {
      id: matchId(round, matchIndex + 1),
      round,
      leg: 2,
      homeTeamId: match.awayTeamId,
      awayTeamId: match.homeTeamId,
    };
  });
  return [...firstLeg, ...secondLeg];
}

export function simulateLeagueV1(input: SimulateLeagueV1Input): LeagueSimulationResult {
  validateSimulationInput(input);
  const seed = String(input.seed);
  const strengths = buildStrengthMap(input.teams, input.userBoostedEvaluation);

  const matches = input.schedule.map((match) => simulateMatch(seed, match, strengths));
  const pointsTable = buildPointsTable(input.teams, matches);
  const userMatchSummaries = matches
    .filter((match) => match.homeTeamId === "user" || match.awayTeamId === "user")
    .map((match) => buildUserMatchSummary(seed, match, input.userBoostedEvaluation));
  const accumulatedUserPlayerStats = accumulateUserStats(userMatchSummaries, input.userState);
  const userRow = pointsTable.find((row) => row.teamId === "user");
  if (!userRow) throw new Error("Simulation V1 table is missing the user team.");
  return {
    version: SIMULATION_V1_VERSION,
    seed,
    matches,
    pointsTable,
    userMatchSummaries,
    userRecord: {
      played: userRow.played,
      won: userRow.won,
      lost: userRow.lost,
      points: userRow.points,
      tablePosition: userRow.position,
    },
    accumulatedUserPlayerStats,
    topRunScorers: [...accumulatedUserPlayerStats].sort(compareRunScorers).slice(0, 3),
    topWicketTakers: [...accumulatedUserPlayerStats].sort(compareWicketTakers).slice(0, 3),
    userQualified: userRow.qualified,
  };
}

export function simulatePlayoffsV1(input: SimulatePlayoffsV1Input): PlayoffSimulationResult {
  const userRow = validatePlayoffInput(input);
  const emptyPlayoffStats = accumulateUserStats([], input.userState);
  if (!userRow.qualified) {
    return {
      qualified: false,
      leaguePosition: userRow.position,
      championTeamId: null,
      userOutcome: "not_qualified",
      matches: [],
      userMatchSummaries: [],
      playoffPlayerStats: emptyPlayoffStats,
      combinedSeasonPlayerStats: combineUserStats(
        input.leagueResult.accumulatedUserPlayerStats,
        emptyPlayoffStats,
      ),
    };
  }

  const seed = input.leagueResult.seed;
  const strengths = buildStrengthMap(input.teams, input.userBoostedEvaluation);
  const ranked = [...input.leagueResult.pointsTable].sort((left, right) => left.position - right.position);
  const qualifierOne = simulatePlayoffMatch(
    seed, "qualifier_1", "playoff-qualifier-1", ranked[0]!.teamId, ranked[1]!.teamId, strengths,
  );
  const eliminator = simulatePlayoffMatch(
    seed, "eliminator", "playoff-eliminator", ranked[2]!.teamId, ranked[3]!.teamId, strengths,
  );
  const qualifierTwo = simulatePlayoffMatch(
    seed, "qualifier_2", "playoff-qualifier-2",
    qualifierOne.loserTeamId, eliminator.winnerTeamId, strengths,
  );
  const final = simulatePlayoffMatch(
    seed, "final", "playoff-final", qualifierOne.winnerTeamId, qualifierTwo.winnerTeamId, strengths,
  );
  const matches = [qualifierOne, eliminator, qualifierTwo, final];
  const userMatchSummaries = matches
    .filter((match) => match.firstBattingTeamId === "user" || match.chasingTeamId === "user")
    .map((match) => buildUserPlayoffMatchSummary(seed, match, input.userBoostedEvaluation));
  const playoffPlayerStats = accumulateUserStats(userMatchSummaries, input.userState);
  return {
    qualified: true,
    leaguePosition: userRow.position as 1 | 2 | 3 | 4,
    championTeamId: final.winnerTeamId,
    userOutcome: deriveUserPlayoffOutcome(matches),
    matches,
    userMatchSummaries,
    playoffPlayerStats,
    combinedSeasonPlayerStats: combineUserStats(
      input.leagueResult.accumulatedUserPlayerStats,
      playoffPlayerStats,
    ),
  };
}

type CoreMatchResult = Pick<
  LeagueMatchResult,
  "innings" | "winnerTeamId" | "loserTeamId" | "resultType" | "margin"
>;

function simulateMatch(
  seed: string,
  match: ScheduledLeagueMatch,
  strengths: ReadonlyMap<SimulationTeamId, TeamStrengthSnapshot>,
): LeagueMatchResult {
  return {
    matchId: match.id,
    round: match.round,
    leg: match.leg,
    homeTeamId: match.homeTeamId,
    awayTeamId: match.awayTeamId,
    ...simulateMatchCore(seed, match.id, match.homeTeamId, match.awayTeamId, strengths),
  };
}

function simulatePlayoffMatch(
  seed: string,
  stage: PlayoffStage,
  matchIdValue: string,
  firstBattingTeamId: SimulationTeamId,
  chasingTeamId: SimulationTeamId,
  strengths: ReadonlyMap<SimulationTeamId, TeamStrengthSnapshot>,
): PlayoffMatchResult {
  return {
    matchId: matchIdValue,
    stage,
    firstBattingTeamId,
    chasingTeamId,
    ...simulateMatchCore(seed, matchIdValue, firstBattingTeamId, chasingTeamId, strengths),
  };
}

function simulateMatchCore(
  seed: string,
  matchIdValue: string,
  firstBattingTeamId: SimulationTeamId,
  chasingTeamId: SimulationTeamId,
  strengths: ReadonlyMap<SimulationTeamId, TeamStrengthSnapshot>,
): CoreMatchResult {
  const firstStrength = requiredStrength(strengths, firstBattingTeamId);
  const chaseStrength = requiredStrength(strengths, chasingTeamId);
  const first = simulateUnconstrainedInnings(
    seed, matchIdValue, "first", firstBattingTeamId, firstStrength, chaseStrength,
  );
  const rawChase = simulateUnconstrainedInnings(
    seed, matchIdValue, "chase", chasingTeamId, chaseStrength, firstStrength,
  );
  const targetRuns = first.runs + 1;
  let chase: InningsSummary;
  if (rawChase.runs >= targetRuns) {
    const excess = rawChase.runs - targetRuns;
    const finishReduction = Math.min(29, Math.round(excess * 0.7 + randomFor(seed, matchIdValue, "chase-balls") * 12));
    chase = {
      teamId: chasingTeamId,
      runs: targetRuns,
      wickets: Math.min(rawChase.wickets, 9),
      balls: SIMULATION_V1_MATCH_CONSTANTS.maximumBalls - 1 - finishReduction,
      allOut: false,
    };
  } else {
    chase = { ...rawChase, runs: Math.min(rawChase.runs, first.runs) };
  }

  let winnerTeamId: SimulationTeamId;
  let resultType: LeagueMatchResult["resultType"];
  let margin: number | null;
  if (chase.runs > first.runs) {
    winnerTeamId = chasingTeamId;
    resultType = "wickets";
    margin = 10 - chase.wickets;
  } else if (chase.runs < first.runs) {
    winnerTeamId = firstBattingTeamId;
    resultType = "runs";
    margin = first.runs - chase.runs;
  } else {
    const firstWeight = firstStrength.overallTeamRating;
    const threshold = firstWeight / (firstWeight + chaseStrength.overallTeamRating);
    winnerTeamId = randomFor(seed, matchIdValue, "super-over") < threshold ? firstBattingTeamId : chasingTeamId;
    resultType = "super_over";
    margin = null;
  }
  return {
    innings: [first, chase],
    winnerTeamId,
    loserTeamId: winnerTeamId === firstBattingTeamId ? chasingTeamId : firstBattingTeamId,
    resultType,
    margin,
  };
}

function simulateUnconstrainedInnings(
  seed: string,
  matchIdValue: string,
  domain: "first" | "chase",
  teamId: SimulationTeamId,
  batting: TeamStrengthSnapshot,
  opposition: TeamStrengthSnapshot,
): InningsSummary {
  const constants = SIMULATION_V1_MATCH_CONSTANTS;
  const expectedRuns = constants.baselineRuns +
    constants.runsPerRatingPoint * (batting.battingComposite - opposition.bowlingComposite);
  const runs = clampInteger(
    Math.round(expectedRuns + normalFor(seed, matchIdValue, `${domain}-runs`) * constants.inningsRunStandardDeviation),
    constants.minimumRuns,
    constants.maximumRuns,
  );
  const expectedWickets = constants.baselineWickets +
    constants.wicketsPerBowlingAdvantagePoint * (opposition.bowlingComposite - batting.battingComposite);
  const wickets = clampInteger(
    Math.round(expectedWickets + normalFor(seed, matchIdValue, `${domain}-wickets`) * constants.wicketStandardDeviation),
    0,
    10,
  );
  const allOut = wickets === 10;
  const balls = allOut
    ? constants.minimumCompletedInningsBalls + Math.floor(
      randomFor(seed, matchIdValue, `${domain}-all-out-balls`) *
      (constants.maximumBalls - constants.minimumCompletedInningsBalls),
    )
    : constants.maximumBalls;
  return { teamId, runs, wickets, balls, allOut };
}

function buildPointsTable(teams: readonly LeagueTeam[], matches: readonly LeagueMatchResult[]): PointsTableRow[] {
  const rows = new Map<SimulationTeamId, Omit<PointsTableRow, "position" | "netRunRate" | "qualified">>();
  for (const team of teams) {
    rows.set(team.teamId, {
      teamId: team.teamId, displayName: team.displayName, played: 0, won: 0, lost: 0, points: 0,
      runsFor: 0, ballsFacedForNrr: 0, runsAgainst: 0, ballsBowledForNrr: 0,
    });
  }
  for (const match of matches) {
    const [first, second] = match.innings;
    updateTableInnings(rows, first, second);
    updateTableInnings(rows, second, first);
    const winner = rows.get(match.winnerTeamId)!;
    const loser = rows.get(match.loserTeamId)!;
    winner.played += 1; winner.won += 1; winner.points += SIMULATION_V1_MATCH_CONSTANTS.pointsPerWin;
    loser.played += 1; loser.lost += 1;
  }
  const ranked = [...rows.values()].map((row) => ({
    ...row,
    netRunRate: row.runsFor * 6 / row.ballsFacedForNrr - row.runsAgainst * 6 / row.ballsBowledForNrr,
  })).sort((left, right) =>
    right.points - left.points || right.netRunRate - left.netRunRate || right.won - left.won ||
    left.teamId.localeCompare(right.teamId),
  );
  return ranked.map((row, index) => ({
    ...row, position: index + 1, qualified: index < SIMULATION_V1_MATCH_CONSTANTS.qualificationPlaces,
  }));
}

function updateTableInnings(
  rows: Map<SimulationTeamId, Omit<PointsTableRow, "position" | "netRunRate" | "qualified">>,
  innings: InningsSummary,
  opposition: InningsSummary,
): void {
  const row = rows.get(innings.teamId)!;
  row.runsFor += innings.runs;
  row.ballsFacedForNrr += innings.allOut ? SIMULATION_V1_MATCH_CONSTANTS.maximumBalls : innings.balls;
  row.runsAgainst += opposition.runs;
  row.ballsBowledForNrr += opposition.allOut ? SIMULATION_V1_MATCH_CONSTANTS.maximumBalls : opposition.balls;
}

const BATTING_ORDER_EXPOSURE = [1.45, 1.4, 1.25, 1.1, 0.95, 0.8, 0.65, 0.5, 0.38, 0.28, 0.22] as const;
const BOWLING_ROLE_WEIGHT: Readonly<Record<string, number>> = { frontline: 1, secondary: 0.55, part_time: 0.2 };

function buildUserMatchSummary(
  seed: string,
  match: LeagueMatchResult,
  evaluation: BoostedTeamEvaluationV1,
): UserMatchSummary {
  const userInnings = match.innings.find((innings) => innings.teamId === "user")!;
  const opponentInnings = match.innings.find((innings) => innings.teamId !== "user")!;
  const opponentTeamId = opponentInnings.teamId as Franchise2016Id;
  const allocations = buildUserPlayerAllocations(seed, match.matchId, userInnings, opponentInnings, evaluation);
  return {
    matchId: match.matchId,
    round: match.round,
    opponentTeamId,
    result: match.winnerTeamId === "user" ? "W" : "L",
    userInnings,
    opponentInnings,
    ...allocations,
  };
}

function buildUserPlayoffMatchSummary(
  seed: string,
  match: PlayoffMatchResult,
  evaluation: BoostedTeamEvaluationV1,
): UserPlayoffMatchSummary {
  const userInnings = match.innings.find((innings) => innings.teamId === "user")!;
  const opponentInnings = match.innings.find((innings) => innings.teamId !== "user")!;
  return {
    matchId: match.matchId,
    stage: match.stage,
    opponentTeamId: opponentInnings.teamId as Franchise2016Id,
    result: match.winnerTeamId === "user" ? "W" : "L",
    userInnings,
    opponentInnings,
    ...buildUserPlayerAllocations(seed, match.matchId, userInnings, opponentInnings, evaluation),
  };
}

function buildUserPlayerAllocations(
  seed: string,
  matchIdValue: string,
  userInnings: InningsSummary,
  opponentInnings: InningsSummary,
  evaluation: BoostedTeamEvaluationV1,
): Pick<UserMatchSummary, "playerRuns" | "playerWickets"> {
  const battingWeights = evaluation.baseTeamEvaluation.players.map((contribution, index) =>
    (contribution.effectiveBattingRating === null
      ? 0.2
      : Math.exp((contribution.effectiveBattingRating - 55) / 20)) * BATTING_ORDER_EXPOSURE[index]!,
  );
  const playerRuns = allocateUnits(
    userInnings.runs, battingWeights, seed, matchIdValue, "user-runs",
  ).map((runs, index) => ({
    playerSeasonId: evaluation.baseTeamEvaluation.players[index]!.slot.player.id, runs,
  }));
  const eligibleBowlers = evaluation.baseTeamEvaluation.players.map((contribution) => {
    const rating = contribution.slot.player.bowlingRating;
    const roleWeight = BOWLING_ROLE_WEIGHT[contribution.slot.player.bowlingOptionStrength] ?? 0;
    return rating === null ? 0 : Math.exp((rating - 55) / 18) * roleWeight;
  });
  let creditedWickets = 0;
  if (eligibleBowlers.some((weight) => weight > 0)) {
    for (let index = 0; index < opponentInnings.wickets; index += 1) {
      if (randomFor(seed, matchIdValue, `user-wicket-credit-${index}`) <
          SIMULATION_V1_MATCH_CONSTANTS.bowlerCreditedWicketProbability) creditedWickets += 1;
    }
  }
  const playerWickets = allocateUnits(
    creditedWickets, eligibleBowlers, seed, matchIdValue, "user-wickets",
  ).map((wickets, index) => ({
    playerSeasonId: evaluation.baseTeamEvaluation.players[index]!.slot.player.id, wickets,
  }));
  return { playerRuns, playerWickets };
}

function allocateUnits(
  total: number,
  weights: readonly number[],
  seed: string,
  matchIdValue: string,
  domain: string,
): number[] {
  const allocated = weights.map(() => 0);
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  if (weightTotal <= 0) return allocated;
  for (let unit = 0; unit < total; unit += 1) {
    let draw = randomFor(seed, matchIdValue, `${domain}-${unit}`) * weightTotal;
    let selected = weights.length - 1;
    for (let index = 0; index < weights.length; index += 1) {
      draw -= weights[index]!;
      if (draw < 0) { selected = index; break; }
    }
    allocated[selected]! += 1;
  }
  return allocated;
}

function accumulateUserStats(
  summaries: readonly Pick<UserMatchSummary, "playerRuns" | "playerWickets">[],
  state: ClassicDraftState,
): AccumulatedUserPlayerStats[] {
  const byId = new Map(state.slots.map((slot) => [slot.player.id, {
    playerSeasonId: slot.player.id,
    playerName: slot.player.name,
    battingPosition: slot.position,
    matches: summaries.length,
    runs: 0,
    wickets: 0,
  }]));
  for (const summary of summaries) {
    for (const value of summary.playerRuns) byId.get(value.playerSeasonId)!.runs += value.runs;
    for (const value of summary.playerWickets) byId.get(value.playerSeasonId)!.wickets += value.wickets;
  }
  return state.slots.map((slot) => byId.get(slot.player.id)!);
}

function combineUserStats(
  leagueStats: readonly AccumulatedUserPlayerStats[],
  playoffStats: readonly AccumulatedUserPlayerStats[],
): AccumulatedUserPlayerStats[] {
  const playoffById = new Map(playoffStats.map((player) => [player.playerSeasonId, player]));
  return leagueStats.map((leaguePlayer) => {
    const playoffPlayer = playoffById.get(leaguePlayer.playerSeasonId);
    if (!playoffPlayer) throw new Error(`Missing playoff statistics for ${leaguePlayer.playerSeasonId}.`);
    return {
      ...leaguePlayer,
      matches: leaguePlayer.matches + playoffPlayer.matches,
      runs: leaguePlayer.runs + playoffPlayer.runs,
      wickets: leaguePlayer.wickets + playoffPlayer.wickets,
    };
  });
}

function deriveUserPlayoffOutcome(
  matches: readonly PlayoffMatchResult[],
): Exclude<UserPlayoffOutcome, "not_qualified"> {
  const final = matches.find((match) => match.stage === "final")!;
  if (final.winnerTeamId === "user") return "champion";
  if (final.firstBattingTeamId === "user" || final.chasingTeamId === "user") return "runner_up";
  const qualifierTwo = matches.find((match) => match.stage === "qualifier_2")!;
  if ((qualifierTwo.firstBattingTeamId === "user" || qualifierTwo.chasingTeamId === "user") &&
      qualifierTwo.loserTeamId === "user") return "eliminated_in_qualifier_2";
  const eliminator = matches.find((match) => match.stage === "eliminator")!;
  if (eliminator.loserTeamId === "user") return "eliminated_in_eliminator";
  throw new Error("Unable to derive the qualified user's playoff outcome.");
}

function compareRunScorers(left: AccumulatedUserPlayerStats, right: AccumulatedUserPlayerStats): number {
  return right.runs - left.runs || right.wickets - left.wickets ||
    left.battingPosition - right.battingPosition || left.playerSeasonId.localeCompare(right.playerSeasonId);
}

function compareWicketTakers(left: AccumulatedUserPlayerStats, right: AccumulatedUserPlayerStats): number {
  return right.wickets - left.wickets || right.runs - left.runs ||
    left.battingPosition - right.battingPosition || left.playerSeasonId.localeCompare(right.playerSeasonId);
}

function validateSimulationInput(input: SimulateLeagueV1Input): void {
  validateScheduleTeams(input.teams);
  if (!input.userState.completed || input.userState.slots.length !== 11) {
    throw new Error("Simulation V1 requires a completed user XI.");
  }
  const stateIds = input.userState.slots.map((slot) => slot.player.id);
  const evaluationIds = input.userBoostedEvaluation.baseTeamEvaluation.players.map((player) => player.slot.player.id);
  if (stateIds.length !== evaluationIds.length || stateIds.some((id, index) => id !== evaluationIds[index])) {
    throw new Error("The user Boost V1 evaluation must belong to the supplied XI.");
  }
  if (input.schedule.length !== SIMULATION_V1_LEAGUE_CONSTANTS.totalMatches ||
      new Set(input.schedule.map((match) => match.id)).size !== input.schedule.length) {
    throw new Error("Simulation V1 requires the complete unique 56-match schedule.");
  }
  if (JSON.stringify(input.schedule) !== JSON.stringify(generateDoubleRoundRobinSchedule(input.teams))) {
    throw new Error("Simulation V1 requires the existing deterministic double round-robin schedule.");
  }
  const teamIds = new Set(input.teams.map((team) => team.teamId));
  const appearances = new Map<SimulationTeamId, number>();
  for (const match of input.schedule) {
    if (!teamIds.has(match.homeTeamId) || !teamIds.has(match.awayTeamId) || match.homeTeamId === match.awayTeamId) {
      throw new Error(`Invalid teams in scheduled match ${match.id}.`);
    }
    appearances.set(match.homeTeamId, (appearances.get(match.homeTeamId) ?? 0) + 1);
    appearances.set(match.awayTeamId, (appearances.get(match.awayTeamId) ?? 0) + 1);
  }
  if ([...teamIds].some((id) => appearances.get(id) !== SIMULATION_V1_LEAGUE_CONSTANTS.matchesPerTeam)) {
    throw new Error("Every Simulation V1 team must play exactly 14 matches.");
  }
}

function validatePlayoffInput(input: SimulatePlayoffsV1Input): PointsTableRow {
  validateScheduleTeams(input.teams);
  if (!input.userState.completed || input.userState.slots.length !== 11) {
    throw new Error("Simulation V1 playoffs require a completed user XI.");
  }
  const stateIds = input.userState.slots.map((slot) => slot.player.id);
  const evaluationIds = input.userBoostedEvaluation.baseTeamEvaluation.players.map((player) => player.slot.player.id);
  if (stateIds.length !== evaluationIds.length || stateIds.some((id, index) => id !== evaluationIds[index])) {
    throw new Error("The user Boost V1 evaluation must belong to the supplied XI.");
  }
  const table = input.leagueResult.pointsTable;
  const positions = table.map((row) => row.position).sort((left, right) => left - right);
  const expectedPositions = Array.from({ length: SIMULATION_V1_LEAGUE_CONSTANTS.teams }, (_, index) => index + 1);
  if (table.length !== SIMULATION_V1_LEAGUE_CONSTANTS.teams ||
      JSON.stringify(positions) !== JSON.stringify(expectedPositions)) {
    throw new Error("Simulation V1 playoffs require a complete uniquely ranked points table.");
  }
  const teamIds = [...input.teams.map((team) => team.teamId)].sort();
  const tableIds = [...table.map((row) => row.teamId)].sort();
  if (JSON.stringify(teamIds) !== JSON.stringify(tableIds)) {
    throw new Error("Playoff table team IDs must match the supplied league composition.");
  }
  const userRow = table.find((row) => row.teamId === "user");
  if (!userRow || userRow.qualified !== input.leagueResult.userQualified ||
      userRow.position !== input.leagueResult.userRecord.tablePosition ||
      userRow.qualified !== (userRow.position <= SIMULATION_V1_MATCH_CONSTANTS.qualificationPlaces)) {
    throw new Error("Playoff qualification must agree with the league result and table position.");
  }
  const leaguePlayerIds = input.leagueResult.accumulatedUserPlayerStats.map((player) => player.playerSeasonId);
  if (leaguePlayerIds.length !== stateIds.length || leaguePlayerIds.some((id, index) => id !== stateIds[index])) {
    throw new Error("League player statistics must belong to the supplied user XI.");
  }
  return userRow;
}

function buildStrengthMap(
  teams: readonly LeagueTeam[],
  evaluation: BoostedTeamEvaluationV1,
): Map<SimulationTeamId, TeamStrengthSnapshot> {
  const strengths = new Map<SimulationTeamId, TeamStrengthSnapshot>();
  for (const team of teams) {
    strengths.set(team.teamId, team.teamId === "user" ? {
      battingComposite: evaluation.adjustedBattingComposite,
      bowlingComposite: evaluation.adjustedBowlingComposite,
      overallTeamRating: evaluation.adjustedOverallTeamRating,
    } : team.opponentProfile.adjustedStrength);
  }
  return strengths;
}

function requiredStrength(
  strengths: ReadonlyMap<SimulationTeamId, TeamStrengthSnapshot>,
  teamId: SimulationTeamId,
): TeamStrengthSnapshot {
  const strength = strengths.get(teamId);
  if (!strength) throw new Error(`Missing strength for ${teamId}.`);
  return strength;
}

function normalFor(seed: string, matchIdValue: string, domain: string): number {
  const first = Math.max(Number.EPSILON, randomFor(seed, matchIdValue, `${domain}-normal-a`));
  const second = randomFor(seed, matchIdValue, `${domain}-normal-b`);
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
}

function randomFor(seed: string, matchIdValue: string, domain: string): number {
  return mulberry32(hash32(`${SIMULATION_V1_VERSION}|${seed}|${matchIdValue}|${domain}`))();
}

function hash32(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  return () => {
    let value = seed += 0x6d2b79f5;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function validateScheduleTeams(teams: readonly LeagueTeam[]): void {
  if (teams.length !== SIMULATION_V1_LEAGUE_CONSTANTS.teams) {
    throw new Error("A Simulation V1 league requires exactly eight teams.");
  }
  const ids = teams.map((team) => team.teamId);
  if (new Set(ids).size !== ids.length) {
    throw new Error("Simulation V1 league team IDs must be unique.");
  }
  if (!ids.includes("user")) {
    throw new Error("A Simulation V1 league must contain the user team.");
  }
}

function matchId(round: number, match: number): string {
  return `league-r${String(round).padStart(2, "0")}-m${String(match).padStart(2, "0")}`;
}
