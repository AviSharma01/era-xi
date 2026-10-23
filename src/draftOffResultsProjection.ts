import type { EraDraftCatalog } from "./eraDraftData.js";
import type { DraftOffCompetitionState } from "./draftOffCompetitionTypes.js";
import { DRAFT_OFF_ENTRY_TEAM_ID } from "./draftOffTypes.js";
import { projectEraDraftHistoricalStats, projectEraDraftRevealedEvaluation } from "./eraDraftProjection.js";
import { DraftOffResultsError, type DraftOffParticipantResultsView, type ResultsInningsView, type ResultsMatchView } from "./draftOffResultsTypes.js";
import type { InningsV2 } from "./simulationV2.js";

/** Consumes canonical restored resolution only; never evaluates or simulates an XI. */
export function projectDraftOffParticipantResults(
  catalog: EraDraftCatalog, state: DraftOffCompetitionState, viewerId: string, targetId: string,
): DraftOffParticipantResultsView {
  if (!state.participants.some(row => row.participantId === viewerId)) throw new DraftOffResultsError("AUTHENTICATION_FAILED");
  const round = [...state.rounds].sort((a, b) => b.roundOrdinal - a.roundOrdinal)[0]!;
  if (round.phase !== "RESOLVED") throw new DraftOffResultsError("RESULTS_NOT_READY");
  if (!round.rosterParticipantIds.includes(viewerId) || !round.resolution.eligibleParticipantIds.includes(targetId)) {
    throw new DraftOffResultsError("RESULT_UNAVAILABLE");
  }
  const target = round.participants.find(row => row.participantId === targetId);
  const identity = state.participants.find(row => row.participantId === targetId);
  const campaign = round.resolution.challengeResult?.campaigns.find(row => row.participantId === targetId);
  if (target?.status !== "SUBMITTED" || !identity || !campaign
    || campaign.submissionHash !== target.submission.submissionHash || campaign.matches.length !== 20) throw new Error("Invalid resolved campaign");
  const revealed = projectEraDraftRevealedEvaluation(catalog, campaign.evaluation);
  const submitted = [...target.submission.xi.picks].sort((a, b) => a.battingPosition - b.battingPosition);
  const players = [...revealed.players].sort((a, b) => a.battingPosition - b.battingPosition).map((player, index) => {
    const pick = submitted[index], facts = catalog.getPlayer(player.playerTeamSeasonId);
    if (!pick || !facts || player.battingPosition !== index + 1 || pick.battingPosition !== player.battingPosition
      || pick.playerTeamSeasonId !== player.playerTeamSeasonId || pick.playerId !== player.playerId
      || pick.seasonId !== player.seasonId || pick.teamId !== player.teamId || pick.franchiseId !== player.franchiseId) throw new Error("Invalid resolved XI");
    return { ...player, historicalStats: projectEraDraftHistoricalStats(catalog, facts) };
  });
  if (players.length !== 11) throw new Error("Invalid resolved XI size");
  const profiles = new Map(catalog.getOpponentProfiles(round.eraId).map(row => [row.candidateId, row]));
  const teamSeasons = catalog.getTeamSeasonsForEra(round.eraId);
  const matches = campaign.matches.map(({ fixture, result }, index): ResultsMatchView => {
    const profile = profiles.get(fixture.opponentProfileId);
    const teamSeason = profile && teamSeasons.find(row => row.teamId === profile.teamId && row.seasonId === profile.seasonId);
    if (!profile || !teamSeason || fixture.sequence !== index + 1 || result.matchId !== fixture.matchId
      || ![DRAFT_OFF_ENTRY_TEAM_ID, profile.candidateId].includes(result.winnerTeamId)) throw new Error("Invalid resolved fixture");
    const innings = (value: InningsV2): ResultsInningsView => {
      if (value.teamId !== DRAFT_OFF_ENTRY_TEAM_ID && value.teamId !== profile.candidateId) throw new Error("Invalid innings identity");
      return { side: value.teamId === DRAFT_OFF_ENTRY_TEAM_ID ? "ENTRY" : "OPPONENT",
        runs: value.runs, wickets: value.wickets, balls: value.balls, allOut: value.allOut };
    };
    const common = { matchId: fixture.matchId, sequence: fixture.sequence,
      opponent: { profileId: profile.candidateId, teamName: profile.teamName, seasonYear: teamSeason.seasonYear },
      firstInnings: innings(result.innings[0]), secondInnings: innings(result.innings[1]),
      outcome: result.winnerTeamId === DRAFT_OFF_ENTRY_TEAM_ID ? "WIN" as const : "LOSS" as const };
    if (result.resultType === "super_over") {
      if (result.margin !== null) throw new Error("Invalid Super Over margin");
      return { ...common, resultType: "super_over", margin: null };
    }
    if (result.margin === null) throw new Error("Missing result margin");
    return { ...common, resultType: result.resultType, margin: result.margin };
  });
  const a = campaign.aggregate;
  return freezeDeep({ roundId: round.roundId, roundOrdinal: round.roundOrdinal, eraId: round.eraId,
    participantId: targetId, displayName: identity.displayName, players, evaluation: revealed.evaluation,
    campaign: { aggregate: { played: a.played, won: a.won, lost: a.lost, points: a.points,
      runsFor: a.runsFor, ballsFacedForNrr: a.ballsFacedForNrr, runsAgainst: a.runsAgainst,
      ballsBowledForNrr: a.ballsBowledForNrr, netRunRate: a.netRunRate }, matches } });
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.values(value).forEach(freezeDeep); Object.freeze(value); }
  return value;
}
