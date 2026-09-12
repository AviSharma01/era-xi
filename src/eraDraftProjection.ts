import type { EraDraftCatalog, EraDraftPlayerRecord } from "./eraDraftData.js";
import { assertEraDraftState } from "./eraDraftInvariants.js";
import { evaluateSelectionLegality, getOpenBattingPositions } from "./eraDraftLegality.js";
import type {
  AwaitingPickPublicView,
  DraftCandidateIdentityView,
  DraftHistoricalBattingView,
  DraftHistoricalBowlingView,
  DraftHistoricalPeakView,
  DraftPickView,
  DraftPlayerFactsView,
  EraDraftHiddenState,
  EraDraftPublicView,
  EraDraftRevealView,
  EraDraftGameCompleteView,
  GameCompleteState,
  SeasonMatchView,
  SeasonStandingView,
  RevealedState,
} from "./eraDraftTypes.js";
import { EraDraftDataError, type DraftPresentationFit, type DraftStatusView } from "./eraDraftTypes.js";
import type { FitClassification } from "./playerRoleContract.js";
import {
  buildStandingsV2,
  type MatchResultV2,
  type PlayoffStageV2,
  type StandingsRowV2,
} from "./simulationV2.js";

export function projectEraDraftPublicState(
  catalog: EraDraftCatalog,
  state: EraDraftHiddenState,
): EraDraftPublicView {
  assertEraDraftState(catalog, state);
  if (state.phase === "SETUP") return Object.freeze({ phase: "SETUP", revision: state.revision });
  const era = catalog.getEra(state.eraId)!;
  const picks = projectPicks(catalog, state.picks);
  const status = projectDraftStatus(catalog, state);
  if (state.phase === "AWAITING_SPIN") {
    return freezeDeep({ phase: "AWAITING_SPIN", revision: state.revision, eraId: state.eraId, eraLabel: era.label, status, picks });
  }
  if (state.phase === "XI_COMPLETE") {
    return freezeDeep({ phase: "XI_COMPLETE", revision: state.revision, eraId: state.eraId, eraLabel: era.label, status, picks });
  }
  const teamSeason = catalog.getTeamSeason(state.currentSpin.teamSeasonId)!;
  const context = { eraId: state.eraId, picks: state.picks, activeTeamSeasonId: teamSeason.teamSeasonId };
  const openPositions = getOpenBattingPositions(state.picks);
  const candidates = catalog.getCandidatesForTeamSeason(teamSeason.teamSeasonId)
    .map((player) => projectCandidate(catalog, player, context, openPositions))
    .sort(compareDraftCandidatesForPresentation);
  return freezeDeep({
    phase: "AWAITING_PICK",
    revision: state.revision,
    eraId: state.eraId,
    eraLabel: era.label,
    status,
    picks,
    currentSpin: {
      spinOrdinal: state.currentSpin.spinOrdinal,
      teamSeasonId: teamSeason.teamSeasonId,
      seasonId: teamSeason.seasonId,
      seasonYear: teamSeason.seasonYear,
      teamId: teamSeason.teamId,
      teamName: teamSeason.teamName,
      franchiseId: teamSeason.franchiseId,
      franchiseName: teamSeason.franchiseName,
    },
    candidates,
  } satisfies AwaitingPickPublicView);
}

function projectCandidate(
  catalog: EraDraftCatalog,
  player: EraDraftPlayerRecord,
  context: Parameters<typeof evaluateSelectionLegality>[1],
  openPositions: ReturnType<typeof getOpenBattingPositions>,
): DraftCandidateIdentityView {
  const positions = openPositions.map((battingPosition) => {
    const legality = evaluateSelectionLegality(catalog, context, { playerTeamSeasonId: player.playerTeamSeasonId, battingPosition });
    return Object.freeze({
      battingPosition,
      presentationFit: toDraftPresentationFit(
        player.role.battingFit.slots[battingPosition - 1]!.classification,
        player.role.battingFit.slots[battingPosition - 1]!.bandDistance,
      ),
      available: legality.available,
      reasons: legality.reasons,
    });
  });
  return freezeDeep({
    ...projectPlayerFacts(player),
    presentationGroup: getDraftCandidatePresentationGroup(player.role.derivedRole),
    historicalStats: projectEraDraftHistoricalStats(catalog, player),
    available: positions.some((position) => position.available),
    positions,
  });
}

export function compareDraftCandidatesForPresentation(
  left: DraftCandidateIdentityView,
  right: DraftCandidateIdentityView,
): number {
  return groupRank(left.presentationGroup) - groupRank(right.presentationGroup)
    || roleRank(left) - roleRank(right)
    || compareText(left.playerName, right.playerName)
    || compareText(left.playerTeamSeasonId, right.playerTeamSeasonId);
}

export function getDraftCandidatePresentationGroup(
  role: EraDraftPlayerRecord["role"]["derivedRole"],
): DraftCandidateIdentityView["presentationGroup"] {
  if (role === "BATTER" || role === "WICKETKEEPER_BATTER") return "BATTERS";
  if (role === "ALL_ROUNDER") return "ALL_ROUNDERS";
  return "BOWLERS";
}

export function projectEraDraftHistoricalStats(
  catalog: EraDraftCatalog,
  player: EraDraftPlayerRecord,
): DraftCandidateIdentityView["historicalStats"] {
  const variants = catalog.getPlayerVariantsForEra(player.eraId, player.playerId);
  const battingCandidates = variants.filter((variant) =>
    variant.historicalStats.batting.runs > 0 || variant.historicalStats.batting.balls > 0);
  const bowlingCandidates = variants.filter((variant) =>
    variant.historicalStats.bowling.wickets > 0 || variant.historicalStats.bowling.legalBalls > 0);
  return freezeDeep({
    currentSeason: {
      batting: battingView(player),
      bowling: bowlingView(player),
    },
    eraBest: {
      batting: battingCandidates.length === 0 ? null : battingPeak([...battingCandidates].sort(compareBattingPeak)[0]!),
      bowling: bowlingCandidates.length === 0 ? null : bowlingPeak([...bowlingCandidates].sort(compareBowlingPeak)[0]!),
    },
  });
}

function battingView(player: EraDraftPlayerRecord): DraftHistoricalBattingView {
  const stats = player.historicalStats.batting;
  return { innings: stats.innings, runs: stats.runs, average: stats.average, strikeRate: stats.strikeRate };
}

function bowlingView(player: EraDraftPlayerRecord): DraftHistoricalBowlingView {
  const stats = player.historicalStats.bowling;
  return { innings: stats.innings, wickets: stats.wickets, legalBalls: stats.legalBalls, economy: stats.economy };
}

function battingPeak(player: EraDraftPlayerRecord): DraftHistoricalPeakView<DraftHistoricalBattingView> {
  return { ...peakIdentity(player), ...battingView(player) };
}

function bowlingPeak(player: EraDraftPlayerRecord): DraftHistoricalPeakView<DraftHistoricalBowlingView> {
  return { ...peakIdentity(player), ...bowlingView(player) };
}

function peakIdentity(player: EraDraftPlayerRecord) {
  return {
    playerTeamSeasonId: player.playerTeamSeasonId,
    seasonId: player.seasonId,
    seasonYear: player.seasonYear,
    teamId: player.teamId,
    teamName: player.teamName,
  };
}

// Peak definitions are intentionally transparent: maximum runs/wickets. Equal
// totals resolve to the earlier season, then stable team and PTS identity.
function compareBattingPeak(left: EraDraftPlayerRecord, right: EraDraftPlayerRecord): number {
  return right.historicalStats.batting.runs - left.historicalStats.batting.runs || comparePeakIdentity(left, right);
}

function compareBowlingPeak(left: EraDraftPlayerRecord, right: EraDraftPlayerRecord): number {
  return right.historicalStats.bowling.wickets - left.historicalStats.bowling.wickets || comparePeakIdentity(left, right);
}

function comparePeakIdentity(left: EraDraftPlayerRecord, right: EraDraftPlayerRecord): number {
  return left.seasonYear - right.seasonYear
    || compareText(left.teamId, right.teamId)
    || compareText(left.playerTeamSeasonId, right.playerTeamSeasonId);
}

function groupRank(group: DraftCandidateIdentityView["presentationGroup"]): number {
  return group === "BATTERS" ? 0 : group === "ALL_ROUNDERS" ? 1 : 2;
}

function roleRank(candidate: DraftCandidateIdentityView): number {
  if (candidate.derivedRole === "BATTER") return 0;
  if (candidate.derivedRole === "WICKETKEEPER_BATTER") return 1;
  if (candidate.derivedRole === "ALL_ROUNDER") return 0;
  if (candidate.derivedRole === "BOWLER") return 0;
  return 1;
}

function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }

export function projectEraDraftRevealState(
  catalog: EraDraftCatalog,
  state: RevealedState,
): EraDraftRevealView {
  assertEraDraftState(catalog, state);
  const era = catalog.getEra(state.eraId)!;
  const picks = projectPicks(catalog, state.picks);
  const players = state.evaluation.players.map((evaluated) => {
    const player = catalog.getPlayer(evaluated.quality.playerTeamSeasonId)!;
    const slot = evaluated.role.battingFit.slots[evaluated.position - 1]!;
    return {
      ...projectPlayerFacts(player),
      battingPosition: evaluated.position,
      presentationFit: toDraftPresentationFit(slot.classification, slot.bandDistance),
      battingRating: evaluated.quality.batting.battingRating,
      bowlingRating: evaluated.quality.bowling.bowlingRating,
      overallRating: evaluated.quality.overall.overallRating,
      qualityTier: evaluated.quality.overall.qualityTier,
    };
  });
  const fitCounts: Record<DraftPresentationFit, number> = {
    NATURAL: 0,
    ACCEPTABLE: 0,
    STRETCH: 0,
    MAJOR_STRETCH: 0,
    UNKNOWN: 0,
  };
  for (const player of players) fitCounts[player.presentationFit] += 1;
  return freezeDeep({
    phase: "REVEALED",
    revision: state.revision,
    eraId: state.eraId,
    eraLabel: era.label,
    status: projectDraftStatus(catalog, state),
    picks,
    players,
    evaluation: {
      strength: {
        overall: state.evaluation.adjustedStrength.overall,
        batting: state.evaluation.adjustedStrength.batting,
        bowling: state.evaluation.adjustedStrength.bowling,
      },
      tierCounts: { ...state.evaluation.diagnostics.tierCounts },
      fitCounts,
      construction: {
        overseasCount: state.evaluation.diagnostics.overseasCount,
        overseasLimit: 4,
        hasWicketkeeper: state.evaluation.diagnostics.hasWicketkeeper,
        deployedBowlingUnits: state.evaluation.diagnostics.deployedBowlingUnits,
        requiredBowlingUnits: 5,
        frontlineBowlers: state.evaluation.diagnostics.bowlingWorkloadCounts.FRONTLINE,
        supportBowlers: state.evaluation.diagnostics.bowlingWorkloadCounts.SUPPORT,
      },
    },
  } satisfies EraDraftRevealView);
}

export function projectEraDraftGameCompleteState(
  catalog: EraDraftCatalog,
  state: GameCompleteState,
): EraDraftGameCompleteView {
  assertEraDraftState(catalog, state);
  const era = catalog.getEra(state.eraId)!;
  const league = state.season.league;
  const teamNames = new Map(league.teams.map((team) => [team.teamId, team.displayName]));
  const userSchedule = league.schedule.filter((match) => match.homeTeamId === "user" || match.awayTeamId === "user");
  const checkpoints = userSchedule.map((scheduled, index) => {
    const leagueIndex = league.schedule.findIndex((item) => item.matchId === scheduled.matchId);
    const match = league.leagueMatches[leagueIndex]!;
    const matchesThroughRound = league.leagueMatches.filter((_, matchIndex) =>
      league.schedule[matchIndex]!.round <= scheduled.round);
    const standings = buildStandingsV2(league.teams, matchesThroughRound);
    const userStanding = standings.find((row) => row.teamId === "user")!;
    const previousPosition = index === 0 ? null : undefined;
    return {
      matchNumber: index + 1,
      round: scheduled.round,
      match: projectSeasonMatch(match, index + 1, "LEAGUE", teamNames),
      record: {
        won: userSchedule.slice(0, index + 1).filter((item) => {
          const result = league.leagueMatches[league.schedule.findIndex((scheduledMatch) => scheduledMatch.matchId === item.matchId)];
          return result?.winnerTeamId === "user";
        }).length,
        lost: userSchedule.slice(0, index + 1).filter((item) => {
          const result = league.leagueMatches[league.schedule.findIndex((scheduledMatch) => scheduledMatch.matchId === item.matchId)];
          return result?.loserTeamId === "user";
        }).length,
      },
      position: userStanding.position,
      previousPosition,
      movement: "FIRST" as const,
      standings: projectStandings(standings, index === userSchedule.length - 1),
    };
  });
  const userMatches = checkpoints.map((checkpoint, index) => {
    const previousPosition = index === 0 ? null : checkpoints[index - 1]!.position;
    return freezeDeep({
      ...checkpoint,
      previousPosition,
      movement: previousPosition === null ? "FIRST" as const
        : checkpoint.position < previousPosition ? "UP" as const
          : checkpoint.position > previousPosition ? "DOWN" as const
            : "SAME" as const,
    });
  });
  const finalStandings = projectStandings(league.standings, true);
  const userFinal = finalStandings.find((row) => row.isUser)!;
  const allPlayoffs = league.playoffs.map((match, index) =>
    projectSeasonMatch(match, index + 1, playoffStage(match.stage), teamNames));
  const userPlayoffs = allPlayoffs.filter((match) =>
    match.firstInnings.teamId === "user" || match.secondInnings.teamId === "user");
  const championName = requiredTeamName(teamNames, league.championTeamId);
  return freezeDeep({
    phase: "GAME_COMPLETE",
    revision: state.revision,
    eraId: state.eraId,
    eraLabel: era.label,
    league: {
      userMatches,
      finalStandings,
      userFinalPosition: userFinal.position,
      userRecord: { won: userFinal.won, lost: userFinal.lost },
      qualified: state.season.userOutcome.qualified,
    },
    playoffs: {
      allMatches: allPlayoffs,
      userMatches: userPlayoffs,
      userResult: playoffResult(state, userPlayoffs),
    },
    champion: { teamId: league.championTeamId, teamName: championName, isUser: league.championTeamId === "user" },
  });
}

function projectStandings(rows: readonly StandingsRowV2[], final: boolean): readonly SeasonStandingView[] {
  return rows.map((row) => ({
    position: row.position,
    teamId: row.teamId,
    teamName: row.displayName,
    played: row.played,
    won: row.won,
    lost: row.lost,
    points: row.points,
    netRunRate: row.netRunRate,
    isUser: row.teamId === "user",
    qualified: final ? row.qualified : null,
  }));
}

function projectSeasonMatch(
  match: MatchResultV2,
  sequence: number,
  stage: SeasonMatchView["stage"],
  teamNames: ReadonlyMap<string, string>,
): SeasonMatchView {
  const includesUser = match.firstBattingTeamId === "user" || match.chasingTeamId === "user";
  const opponentId = includesUser
    ? match.firstBattingTeamId === "user" ? match.chasingTeamId : match.firstBattingTeamId
    : null;
  return {
    matchId: match.matchId,
    sequence,
    stage,
    firstInnings: { ...match.innings[0], teamName: requiredTeamName(teamNames, match.innings[0].teamId) },
    secondInnings: { ...match.innings[1], teamName: requiredTeamName(teamNames, match.innings[1].teamId) },
    winnerTeamId: match.winnerTeamId,
    result: includesUser ? match.winnerTeamId === "user" ? "WIN" : "LOSS" : "AI_RESULT",
    resultLabel: match.resultType === "super_over"
      ? `${requiredTeamName(teamNames, match.winnerTeamId)} won the Super Over`
      : `${requiredTeamName(teamNames, match.winnerTeamId)} won by ${match.margin} ${resultUnit(match.resultType, match.margin)}`,
    opponent: opponentId ? { teamId: opponentId, teamName: requiredTeamName(teamNames, opponentId) } : null,
  };
}

function resultUnit(type: "runs" | "wickets", margin: number | null): string {
  if (margin === 1) return type === "runs" ? "run" : "wicket";
  return type;
}

function playoffStage(stage: PlayoffStageV2): SeasonMatchView["stage"] {
  if (stage === "qualifier_1") return "QUALIFIER_1";
  if (stage === "qualifier_2") return "QUALIFIER_2";
  if (stage === "eliminator") return "ELIMINATOR";
  return "FINAL";
}

function playoffResult(state: GameCompleteState, userMatches: readonly SeasonMatchView[]): string {
  if (!state.season.userOutcome.qualified) return "Did not qualify for the playoffs";
  if (state.season.userOutcome.champion) return "IPL Era Draft champions";
  const last = userMatches.at(-1);
  return last ? `Eliminated in ${playoffOutcomeStage(last.stage)}` : "Qualified for the playoffs";
}

function playoffOutcomeStage(stage: SeasonMatchView["stage"]): string {
  if (stage === "QUALIFIER_1") return "Qualifier 1";
  if (stage === "QUALIFIER_2") return "Qualifier 2";
  if (stage === "ELIMINATOR") return "the Eliminator";
  return "the Final";
}

function requiredTeamName(names: ReadonlyMap<string, string>, teamId: string): string {
  const name = names.get(teamId);
  if (!name) throw new EraDraftDataError("MISSING_PRESENTATION_TEAM", `Season result has no display name for ${teamId}.`);
  return name;
}

function projectPicks(catalog: EraDraftCatalog, picks: EraDraftHiddenState["picks"]): readonly DraftPickView[] {
  return picks.map((pick) => {
    const player = catalog.getPlayer(pick.playerTeamSeasonId)!;
    return freezeDeep({
      ...projectPlayerFacts(player),
      pickNumber: pick.pickNumber,
      battingPosition: pick.battingPosition,
      presentationFit: toDraftPresentationFit(
        player.role.battingFit.slots[pick.battingPosition - 1]!.classification,
        player.role.battingFit.slots[pick.battingPosition - 1]!.bandDistance,
      ),
    });
  });
}

export function toDraftPresentationFit(
  classification: FitClassification,
  bandDistance: number | null,
): DraftPresentationFit {
  if (classification === "NATURAL") return "NATURAL";
  if (classification === "ACCEPTABLE") return "ACCEPTABLE";
  if (classification === "UNKNOWN") {
    if (bandDistance !== null) throw invalidFit(classification, bandDistance);
    return "UNKNOWN";
  }
  if (!Number.isInteger(bandDistance) || bandDistance === null || bandDistance < 2 || bandDistance > 4) {
    throw invalidFit(classification, bandDistance);
  }
  return bandDistance === 2 ? "STRETCH" : "MAJOR_STRETCH";
}

function projectDraftStatus(
  catalog: EraDraftCatalog,
  state: Pick<Exclude<EraDraftHiddenState, { phase: "SETUP" }> | RevealedState, "picks" | "respin">,
): DraftStatusView {
  const players = state.picks.map((pick) => catalog.getPlayer(pick.playerTeamSeasonId)!);
  return Object.freeze({
    pickCount: state.picks.length,
    pickLimit: 11,
    overseasCount: players.filter((player) => player.rosterStatus === "OVERSEAS").length,
    overseasLimit: 4,
    hasWicketkeeper: players.some((player) => player.role.keeperMetadata.capabilityStatus === "CONFIRMED"),
    respinStatus: state.respin.status,
  });
}

function invalidFit(classification: FitClassification, bandDistance: number | null): EraDraftDataError {
  return new EraDraftDataError(
    "INVALID_PRESENTATION_FIT_DISTANCE",
    `Draft presentation cannot project ${classification} with band distance ${String(bandDistance)}.`,
    { classification, bandDistance },
  );
}

function projectPlayerFacts(player: EraDraftPlayerRecord): DraftPlayerFactsView {
  return Object.freeze({
    playerTeamSeasonId: player.playerTeamSeasonId,
    playerId: player.playerId,
    playerName: player.canonicalDisplayName,
    seasonId: player.seasonId,
    seasonYear: player.seasonYear,
    teamId: player.teamId,
    teamName: player.teamName,
    franchiseId: player.franchiseId,
    franchiseName: player.franchiseName,
    rosterStatus: player.rosterStatus,
    keeperCapability: player.role.keeperMetadata.capabilityStatus,
    derivedRole: player.role.derivedRole,
    bowlingWorkloadClass: player.role.bowlingWorkloadClass,
    bowlingFamily: player.role.bowlingFamily,
  });
}

function freezeDeep<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) value.forEach(freezeDeep);
  else Object.values(value as Record<string, unknown>).forEach(freezeDeep);
  return Object.freeze(value);
}
