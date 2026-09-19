import { canonicalJson, canonicalSha256 } from "./eraDraftCanonical.js";
import { FOUNDATION_SIMULATION_COMPATIBILITY_FINGERPRINT } from "./eraDraftCompatibility.js";
import type { EraDraftCatalog } from "./eraDraftData.js";
import {
  buildEraDraftOpponentComposition,
  shortlistEraOpponentProfiles,
} from "./eraDraftOpponentComposition.js";
import {
  ERA_DRAFT_OPPONENT_COMPOSITION_SCHEMA_VERSION,
  ERA_DRAFT_SIMULATION_SEED_VERSION,
  EraDraftDataError,
  type EraDraftPick,
  type EraDraftSeasonResult,
  type EraDraftSimulationSeedBundle,
  type RevealedState,
} from "./eraDraftTypes.js";
import { opponentAsSimulationTeamV2 } from "./eraDraftOpponentRuntime.js";
import {
  SIMULATION_V2_VERSION,
  generateDoubleRoundRobinScheduleV2,
  selectLeagueOpponentsV2,
  simulateLeagueAndPlayoffsV2,
  type SimulationTeamV2,
} from "./simulationV2.js";

type SimulationIdentityState = Pick<
  RevealedState,
  "engineVersion" | "catalogFingerprint" | "rootSeed" | "eraId" | "picks" | "evaluation"
>;

export function deriveEraDraftSimulationSeeds(state: SimulationIdentityState): EraDraftSimulationSeedBundle {
  const xiIdentity = [...state.picks]
    .sort((left, right) => left.battingPosition - right.battingPosition)
    .map(stablePickIdentity);
  const gameIdentityHash = canonicalSha256({
    engineVersion: state.engineVersion,
    catalogFingerprint: state.eraId === "era-foundation"
      ? FOUNDATION_SIMULATION_COMPATIBILITY_FINGERPRINT
      : state.catalogFingerprint,
    rootSeed: state.rootSeed,
    eraId: state.eraId,
    xi: xiIdentity,
    teamEvaluationVersion: state.evaluation.version,
    simulationVersion: SIMULATION_V2_VERSION,
  });
  return Object.freeze({
    version: ERA_DRAFT_SIMULATION_SEED_VERSION,
    gameIdentityHash,
    opponentCompositionSeed: canonicalSha256({
      version: ERA_DRAFT_SIMULATION_SEED_VERSION,
      gameIdentityHash,
      domain: "opponent-composition",
    }),
    matchSimulationSeed: canonicalSha256({
      version: ERA_DRAFT_SIMULATION_SEED_VERSION,
      gameIdentityHash,
      domain: "match-simulation",
    }),
  });
}

export function simulateEraDraftSeason(
  catalog: EraDraftCatalog,
  state: RevealedState,
): EraDraftSeasonResult {
  const availability = catalog.getSimulationContent(state.eraId);
  const environment = catalog.getEnvironment(state.eraId);
  const profiles = catalog.getOpponentProfiles(state.eraId);
  if (availability.status !== "AVAILABLE" || availability.opponentCount !== profiles.length || !environment || profiles.length < 8) {
    throw new EraDraftDataError(
      "MISSING_ERA_SIMULATION_CONTENT",
      `${state.eraId} simulation requires its frozen environment and complete opponent pool.`,
      {
        availability: availability.status,
        opponentCount: profiles.length,
        environmentPresent: Boolean(environment),
      },
    );
  }

  const seedBundle = deriveEraDraftSimulationSeeds(state);
  const userTeam = buildUserSimulationTeam(state);
  const shortlistedProfiles = shortlistEraOpponentProfiles(profiles, seedBundle.opponentCompositionSeed);
  const opponentPool = shortlistedProfiles.map(opponentAsSimulationTeamV2);
  let league: EraDraftSeasonResult["league"];
  try {
    league = simulateLeagueAndPlayoffsV2({
      compositionSeed: seedBundle.opponentCompositionSeed,
      simulationSeed: seedBundle.matchSimulationSeed,
      userTeam,
      opponentPool,
      environment,
    });
  } catch (error) {
    throw new EraDraftDataError(
      "STAGE7_SIMULATION_FAILED",
      "Frozen Stage 7 league/playoff simulation failed.",
      { eraId: state.eraId },
      { cause: error },
    );
  }
  const userStanding = league.standings.find((row) => row.teamId === "user");
  if (!userStanding) {
    throw new EraDraftDataError("MISSING_USER_STANDING", "Stage 7 result omitted the user standings row.");
  }
  const season = freezeDeep({
    stage7Versions: {
      simulationVersion: SIMULATION_V2_VERSION,
      environmentSchemaVersion: environment.schemaVersion,
    },
    seedBundle,
    opponentComposition: buildEraDraftOpponentComposition(profiles, shortlistedProfiles),
    userTeam,
    league,
    userOutcome: {
      leaguePosition: userStanding.position,
      qualified: userStanding.qualified,
      champion: league.championTeamId === "user",
    },
  } satisfies EraDraftSeasonResult);
  assertEraDraftSeasonResult(catalog, state, season);
  return season;
}

export function assertEraDraftSeasonResult(
  catalog: EraDraftCatalog,
  state: SimulationIdentityState,
  season: EraDraftSeasonResult,
): void {
  const expectedSeeds = deriveEraDraftSimulationSeeds(state);
  if (canonicalJson(season.seedBundle) !== canonicalJson(expectedSeeds)) {
    fail("SIMULATION_SEED_MISMATCH", "Stored simulation seeds do not match the deterministic game identity.");
  }
  const expectedUser = buildUserSimulationTeam(state);
  if (canonicalJson(season.userTeam) !== canonicalJson(expectedUser)) {
    fail("USER_SIMULATION_STRENGTH_MISMATCH", "User simulation strength differs from Team Evaluation V2 adjusted strength.");
  }

  const league = season.league;
  const environment = catalog.getEnvironment(state.eraId);
  if (
    season.stage7Versions.simulationVersion !== SIMULATION_V2_VERSION
    || !environment
    || season.stage7Versions.environmentSchemaVersion !== environment.schemaVersion
  ) fail("STAGE7_VERSION_MISMATCH", "Stored Stage 7 version identifiers do not match the frozen runtime catalog.");
  if (
    league.version !== SIMULATION_V2_VERSION
    || league.compositionSeed !== season.seedBundle.opponentCompositionSeed
    || league.simulationSeed !== season.seedBundle.matchSimulationSeed
  ) fail("SIMULATION_VERSION_OR_SEED_MISMATCH", "Stored Stage 7 result has an invalid version or seed identity.");
  if (league.teams.length !== 8 || new Set(league.teams.map((team) => team.teamId)).size !== 8) {
    fail("INVALID_LEAGUE_TEAMS", "Completed Era Draft league must contain eight unique teams.");
  }
  if (!league.teams.some((team) => team.teamId === "user")) fail("MISSING_USER_TEAM", "Completed league omits the user team.");
  const profiles = catalog.getOpponentProfiles(state.eraId);
  const availability = catalog.getSimulationContent(state.eraId);
  if (availability.status !== "AVAILABLE" || availability.opponentCount !== profiles.length || profiles.length < 8) {
    fail("MISSING_ERA_SIMULATION_CONTENT", "Completed season era content is unavailable or inconsistent.");
  }
  const expectedShortlist = shortlistEraOpponentProfiles(profiles, season.seedBundle.opponentCompositionSeed);
  const expectedCompositionProvenance = buildEraDraftOpponentComposition(profiles, expectedShortlist);
  if (season.opponentComposition.schemaVersion !== ERA_DRAFT_OPPONENT_COMPOSITION_SCHEMA_VERSION
    || canonicalJson(season.opponentComposition) !== canonicalJson(expectedCompositionProvenance)) {
    fail("OPPONENT_COMPOSITION_PROVENANCE_MISMATCH", "Stored opponent composition differs from the current frozen era pool or deterministic shortlist.");
  }
  const profileIds = new Set(profiles.map((profile) => profile.candidateId));
  const shortlistIds = new Set(season.opponentComposition.shortlistedProfileIds);
  if (season.opponentComposition.eraId !== state.eraId
    || season.opponentComposition.fullPoolProfileIds.length !== profiles.length
    || season.opponentComposition.shortlistedProfileIds.length !== 8 || shortlistIds.size !== 8
    || season.opponentComposition.shortlistedProfileIds.some((teamId) => !profileIds.has(teamId))) {
    fail("INVALID_OPPONENT_COMPOSITION_PROVENANCE", "Stored opponent composition is not a legal eight-profile subset of the producing era pool.");
  }
  const historicalIds = league.teams.filter((team) => team.teamId !== "user").map((team) => team.teamId);
  if (
    historicalIds.length !== 7
    || historicalIds.some((teamId) => !shortlistIds.has(teamId))
    || !shortlistIds.has(league.omittedOpponentTeamId)
    || historicalIds.includes(league.omittedOpponentTeamId)
  ) fail("INVALID_OPPONENT_COMPOSITION", "Stage 7 opponent composition is inconsistent with the deterministic era shortlist.");
  const expectedComposition = selectLeagueOpponentsV2(
    season.seedBundle.opponentCompositionSeed,
    expectedShortlist.map(opponentAsSimulationTeamV2),
  );
  const expectedTeams = [expectedUser, ...expectedComposition.selected];
  if (
    expectedComposition.omitted.teamId !== league.omittedOpponentTeamId
    || canonicalJson(league.teams) !== canonicalJson(expectedTeams)
  ) fail("OPPONENT_SELECTION_MISMATCH", "Stored opponent selection differs from frozen Stage 7 selection.");
  if (league.schedule.length !== 56 || league.leagueMatches.length !== 56) {
    fail("INVALID_LEAGUE_MATCH_COUNT", "Completed Era Draft league requires 56 scheduled and simulated matches.");
  }
  if (canonicalJson(league.schedule) !== canonicalJson(generateDoubleRoundRobinScheduleV2(expectedTeams))) {
    fail("LEAGUE_SCHEDULE_MISMATCH", "Stored schedule differs from frozen Stage 7 scheduling.");
  }
  if (league.standings.length !== 8 || league.standings.some((row) => row.played !== 14)) {
    fail("INVALID_STANDINGS", "Completed Era Draft standings require eight teams with fourteen matches each.");
  }
  const teamIds = new Set(league.teams.map((team) => team.teamId));
  if (
    new Set(league.standings.map((row) => row.teamId)).size !== 8
    || league.standings.some((row) => !teamIds.has(row.teamId))
  ) fail("INVALID_STANDINGS_MEMBERSHIP", "Standings membership differs from league membership.");
  if (league.playoffs.length !== 4 || league.playoffs.map((match) => match.stage).join("|")
    !== "qualifier_1|eliminator|qualifier_2|final") {
    fail("INVALID_PLAYOFF_STRUCTURE", "Completed Era Draft season requires the four-stage IPL playoff bracket.");
  }
  if (!teamIds.has(league.championTeamId) || league.playoffs[3]?.winnerTeamId !== league.championTeamId) {
    fail("INVALID_CHAMPION", "Champion must be the simulated final winner.");
  }
  if ([...league.leagueMatches, ...league.playoffs].some((match) => match.version !== SIMULATION_V2_VERSION)) {
    fail("MATCH_VERSION_MISMATCH", "Every Stage 7 match must use Simulation V2.");
  }
  for (const [index, match] of league.leagueMatches.entries()) {
    const scheduled = league.schedule[index];
    const participants = new Set([match.firstBattingTeamId, match.chasingTeamId]);
    if (
      !scheduled
      || match.matchId !== scheduled.matchId
      || !participants.has(scheduled.homeTeamId)
      || !participants.has(scheduled.awayTeamId)
      || !teamIds.has(match.winnerTeamId)
      || !teamIds.has(match.loserTeamId)
    ) fail("LEAGUE_MATCH_MEMBERSHIP_MISMATCH", "Stored league match differs from its schedule or team membership.");
  }
  if (league.playoffs.some((match) =>
    !teamIds.has(match.firstBattingTeamId)
    || !teamIds.has(match.chasingTeamId)
    || !teamIds.has(match.winnerTeamId)
    || !teamIds.has(match.loserTeamId))) {
    fail("PLAYOFF_MEMBERSHIP_MISMATCH", "Stored playoff contains a team outside the simulated league.");
  }
  const userStanding = league.standings.find((row) => row.teamId === "user");
  if (
    !userStanding
    || season.userOutcome.leaguePosition !== userStanding.position
    || season.userOutcome.qualified !== userStanding.qualified
    || season.userOutcome.champion !== (league.championTeamId === "user")
  ) fail("USER_OUTCOME_MISMATCH", "Stored user outcome disagrees with the Stage 7 result.");
}

function buildUserSimulationTeam(state: SimulationIdentityState): SimulationTeamV2 {
  return {
    teamId: "user",
    displayName: "Era Draft XI",
    strength: {
      batting: state.evaluation.adjustedStrength.batting,
      bowling: state.evaluation.adjustedStrength.bowling,
      overall: state.evaluation.adjustedStrength.overall,
    },
  };
}

function stablePickIdentity(pick: EraDraftPick): object {
  return {
    playerTeamSeasonId: pick.playerTeamSeasonId,
    playerId: pick.playerId,
    seasonId: pick.seasonId,
    teamId: pick.teamId,
    franchiseId: pick.franchiseId,
    battingPosition: pick.battingPosition,
  };
}

function fail(code: string, message: string): never {
  throw new EraDraftDataError(code, message);
}

function freezeDeep<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) value.forEach(freezeDeep);
  else Object.values(value as Record<string, unknown>).forEach(freezeDeep);
  return Object.freeze(value);
}
