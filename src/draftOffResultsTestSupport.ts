import { createDraftOffCompetition } from "./draftOffCompetition.js";
import { catalog, changed, completeXi } from "./draftOffRoomTestSupport.js";
import type { DraftOffCompetitionState } from "./draftOffCompetitionTypes.js";
import { projectDraftOffParticipantResults } from "./draftOffResultsProjection.js";
import type { ResultsSuccess } from "./draftOffResultsTypes.js";
import type { EraId } from "./teamEvaluationV2.js";
import assert from "node:assert/strict";
import { participant } from "./draftOffRoomTestSupport.js";
import { evaluateSelectionLegality, getOpenBattingPositions } from "./eraDraftLegality.js";
import { parseDraftOffResults } from "./draftOffResultsClient.js";

export { catalog };
export const roomCode = "0123456789AB";
export const hostId = "p_" + "1".repeat(32), memberId = "p_" + "2".repeat(32), leftId = "p_" + "3".repeat(32);
export function resultsLobby(eraId: EraId = "era-transition", challengeSeed = "m53-results") {
  let state = createDraftOffCompetition(catalog, { competitionId: roomCode, catalogFingerprint: catalog.fingerprint,
    createdAtMs: 0, host: { participantId: hostId, displayName: "Results host" },
    initialRound: { roundId: "r1", roundOrdinal: 1, label: "Draft-Off", eraId, challengeSeed } });
  state = changed(state, { type: "JOIN_COMPETITION", participantId: memberId, displayName: "Results member", atMs: 1 });
  state = changed(state, { type: "JOIN_COMPETITION", participantId: leftId, displayName: "Left member", atMs: 2 });
  return changed(state, { type: "LEAVE_COMPETITION", participantId: leftId, atMs: 3 });
}
export function resultsStarted(eraId: EraId = "era-transition", challengeSeed = "m53-results") {
  return changed(resultsLobby(eraId, challengeSeed), { type: "START_ROUND", actorParticipantId: hostId, roundId: "r1", atMs: 10, deadlineAtMs: 100 });
}
/** Deliberately uses the opposite legal selection/order from completeXi. Test-only. */
function completeDifferentXi(state: DraftOffCompetitionState, participantId: string) {
  for (let n = 0; n < 11; n++) {
    state = changed(state, { type: "APPLY_DRAFT_COMMAND", participantId, atMs: 20,
      expectedDraftRevision: participant(state, participantId).draftState.revision, draftCommand: { type: "SPIN" } });
    const draft = participant(state, participantId).draftState;
    assert.equal(draft.phase, "AWAITING_PICK"); if (draft.phase !== "AWAITING_PICK") throw new Error("Expected spun fixture");
    const context = { eraId: draft.eraId, picks: draft.picks, activeTeamSeasonId: draft.currentSpin.teamSeasonId };
    const choice = catalog.getCandidatesForTeamSeason(draft.currentSpin.teamSeasonId)
      .flatMap(player => getOpenBattingPositions(draft.picks).map(battingPosition => ({ playerTeamSeasonId: player.playerTeamSeasonId, battingPosition })))
      .filter(choice => evaluateSelectionLegality(catalog, context, choice).available).at(-1)!;
    assert.ok(choice);
    state = changed(state, { type: "APPLY_DRAFT_COMMAND", participantId, atMs: 20,
      expectedDraftRevision: draft.revision, draftCommand: { type: "LOCK_PLAYER", ...choice } });
  }
  return state;
}
export function resultsResolved(eligible = 2, eraId: EraId = "era-transition", challengeSeed = "m53-results") {
  let state = resultsStarted(eraId, challengeSeed);
  if (eligible >= 1) state = completeXi(state, hostId);
  if (eligible >= 2) state = completeDifferentXi(state, memberId);
  return changed(state, { type: "FINALIZE_ROUND", roundId: "r1", atMs: 100 });
}

/** Expected data comes from canonical domain state, never the response being checked. */
export function assertResultsAgainstState(body: ResultsSuccess, state: DraftOffCompetitionState, targetId: string) {
  const round = [...state.rounds].sort((a, b) => b.roundOrdinal - a.roundOrdinal)[0]!;
  assert.equal(round.phase, "RESOLVED"); if (round.phase !== "RESOLVED") throw new Error("Expected resolution");
  parseDraftOffResults(body, { roomCode: state.competitionId, roundId: round.roundId, roundOrdinal: round.roundOrdinal, eraId: round.eraId, participantId: targetId });
  const target = round.participants.find(p => p.participantId === targetId)!;
  assert.equal(target.status, "SUBMITTED"); if (target.status !== "SUBMITTED") throw new Error("Expected submission");
  const campaign = round.resolution.challengeResult!.campaigns.find(c => c.participantId === targetId)!;
  assert.equal(body.displayName, state.participants.find(p => p.participantId === targetId)!.displayName);
  const picks = [...target.submission.xi.picks].sort((a, b) => a.battingPosition - b.battingPosition);
  assert.deepEqual(body.players.map(p => [p.battingPosition,p.playerTeamSeasonId,p.playerId,p.seasonId,p.teamId,p.franchiseId]),
    picks.map(p => [p.battingPosition,p.playerTeamSeasonId,p.playerId,p.seasonId,p.teamId,p.franchiseId]));
  body.players.forEach((player, index) => {
    const facts = catalog.getPlayer(picks[index]!.playerTeamSeasonId)!;
    const rated = campaign.evaluation.players.find(p => p.position === picks[index]!.battingPosition)!.quality;
    assert.equal(player.playerName, facts.canonicalDisplayName);
    assert.deepEqual([player.battingRating,player.bowlingRating,player.overallRating,player.qualityTier],
      [rated.batting.battingRating,rated.bowling.bowlingRating,rated.overall.overallRating,rated.overall.qualityTier]);
  });
  const evaluation = campaign.evaluation;
  assert.deepEqual(body.evaluation.strength, { overall: evaluation.adjustedStrength.overall, batting: evaluation.adjustedStrength.batting, bowling: evaluation.adjustedStrength.bowling });
  assert.deepEqual(body.evaluation.tierCounts, evaluation.diagnostics.tierCounts);
  assert.deepEqual(body.evaluation.construction, { overseasCount: evaluation.diagnostics.overseasCount, overseasLimit: 4,
    hasWicketkeeper: evaluation.diagnostics.hasWicketkeeper, deployedBowlingUnits: evaluation.diagnostics.deployedBowlingUnits, requiredBowlingUnits: 5,
    frontlineBowlers: evaluation.diagnostics.bowlingWorkloadCounts.FRONTLINE, supportBowlers: evaluation.diagnostics.bowlingWorkloadCounts.SUPPORT });
  assert.deepEqual(body.campaign.aggregate, campaign.aggregate);
  const profiles = catalog.getOpponentProfiles(round.eraId), seasons = catalog.getTeamSeasonsForEra(round.eraId);
  body.campaign.matches.forEach((match, index) => {
    const { fixture, result } = campaign.matches[index]!;
    const profile = profiles.find(p => p.candidateId === fixture.opponentProfileId)!;
    const team = seasons.find(t => t.teamId === profile.teamId && t.seasonId === profile.seasonId)!;
    const innings = (n: 0 | 1) => { const i = result.innings[n]; return { side: i.teamId === "draft-off-entry" ? "ENTRY" : "OPPONENT", runs: i.runs, wickets: i.wickets, balls: i.balls, allOut: i.allOut }; };
    assert.deepEqual(match, { matchId: fixture.matchId, sequence: fixture.sequence,
      opponent: { profileId: fixture.opponentProfileId, teamName: profile.teamName, seasonYear: team.seasonYear },
      firstInnings: innings(0), secondInnings: innings(1), outcome: result.winnerTeamId === "draft-off-entry" ? "WIN" : "LOSS", resultType: result.resultType, margin: result.margin });
  });
}
export function resultsBody(state: DraftOffCompetitionState, viewerId = hostId, targetId = hostId): ResultsSuccess {
  return { ok: true, version: 1, roomCode, ...projectDraftOffParticipantResults(catalog, state, viewerId, targetId) };
}
