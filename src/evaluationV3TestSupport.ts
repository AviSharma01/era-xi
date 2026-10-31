/** Deterministic test-only builders; all selections pass the real legality/reducer paths. */
import assert from "node:assert/strict";
import { loadEraDraftCatalog } from "./eraDraftData.js";
import { createEraDraftGame, reduceEraDraft } from "./eraDraftEngine.js";
import { createDraftOffCompetition, reduceDraftOffCompetition } from "./draftOffCompetition.js";
import type { DraftOffCompetitionCommand, DraftOffCompetitionState } from "./draftOffCompetitionTypes.js";
import { evaluateSelectionLegality, getOpenBattingPositions } from "./eraDraftLegality.js";
import type { EraDraftState, XiCompleteState } from "./eraDraftTypes.js";
import type { EraDraftTierCaps } from "./eraDraftTierCaps.js";
import type { EraId } from "./teamEvaluationV2.js";
import type { DraftOffFormat } from "./draftOffFormat.js";
import { TEAM_EVALUATION_V3_VERSION } from "./teamEvaluationV3.js";

export const catalog = loadEraDraftCatalog();
export const roomCode = "0123456789AB";
export const participantId = (index: number) => `p_${String(index).padStart(32, "0")}`;
export function legalLock(draft: EraDraftState, tierCaps?: EraDraftTierCaps) {
  assert.equal(draft.phase, "AWAITING_PICK");
  if (draft.phase !== "AWAITING_PICK") throw new Error("Expected spun draft");
  const context = { eraId: draft.eraId, picks: draft.picks, activeTeamSeasonId: draft.currentSpin.teamSeasonId, tierCaps };
  const choice = catalog.getCandidatesForTeamSeason(draft.currentSpin.teamSeasonId)
    .flatMap(player => getOpenBattingPositions(draft.picks).map(battingPosition => ({ playerTeamSeasonId: player.playerTeamSeasonId, battingPosition })))
    .find(choice => evaluateSelectionLegality(catalog, context, choice).available);
  assert.ok(choice);
  return { type: "LOCK_PLAYER" as const, ...choice };
}
export function soloXi(eraId: EraId, modern = true): XiCompleteState {
  let state: EraDraftState = createEraDraftGame({ catalog, rootSeed: `evaluation-v3:${eraId}`, ...(modern ? { teamEvaluationVersion: TEAM_EVALUATION_V3_VERSION } : {}) });
  const apply = (command: Parameters<typeof reduceEraDraft>[2]) => {
    const result = reduceEraDraft(catalog, state, command); assert.ok(result.ok); state = result.state;
  };
  apply({ type: "CHOOSE_ERA", eraId });
  for (let n = 0; n < 11; n++) { apply({ type: "SPIN" }); apply(legalLock(state)); }
  assert.equal(state.phase, "XI_COMPLETE");
  return state as XiCompleteState;
}
export function roomLobby(eraId: EraId, format: DraftOffFormat, count: 2 | 8): DraftOffCompetitionState {
  let state = createDraftOffCompetition(catalog, {
    teamEvaluationVersion: TEAM_EVALUATION_V3_VERSION, format, tierCaps: { maxS: 3, maxSA: 6 },
    competitionId: roomCode, catalogFingerprint: catalog.fingerprint, createdAtMs: 0,
    host: { participantId: participantId(1), displayName: "Player 1" },
    initialRound: { roundId: "r1", roundOrdinal: 1, label: "Evaluation V3", eraId, challengeSeed: `evaluation-v3:${eraId}:${format}:${count}` },
  });
  for (let n = 2; n <= count; n++) state = roomApply(state, { type: "JOIN_COMPETITION", participantId: participantId(n), displayName: `Player ${n}`, atMs: n });
  return state;
}
export function roomApply(state: DraftOffCompetitionState, command: DraftOffCompetitionCommand) {
  const result = reduceDraftOffCompetition(catalog, state, command); assert.ok(result.ok, result.ok ? undefined : result.error.message); return result.state;
}
export function startRoom(state: DraftOffCompetitionState) {
  return roomApply(state, { type: "START_ROUND", actorParticipantId: participantId(1), roundId: "r1", atMs: 10, deadlineAtMs: 100 });
}
export function draftOf(state: DraftOffCompetitionState, id: string) {
  const round = state.rounds[0]!; assert.notEqual(round.phase, "PENDING");
  if (round.phase === "PENDING") throw new Error("Expected started round");
  return round.participants.find(row => row.participantId === id)!.draftState;
}
export function completeParticipant(state: DraftOffCompetitionState, id: string) {
  for (let n = 0; n < 11; n++) {
    state = roomApply(state, { type: "APPLY_DRAFT_COMMAND", participantId: id, atMs: 20, expectedDraftRevision: draftOf(state, id).revision, draftCommand: { type: "SPIN" } });
    state = roomApply(state, { type: "APPLY_DRAFT_COMMAND", participantId: id, atMs: 20, expectedDraftRevision: draftOf(state, id).revision, draftCommand: legalLock(draftOf(state, id), state.genesis.tierCaps) });
  }
  return state;
}
export function resolvedRoom(eraId: EraId, format: DraftOffFormat, count: 2 | 8, eligible: number = count, manual = true) {
  let state = startRoom(roomLobby(eraId, format, count));
  for (let n = 1; n <= eligible; n++) state = completeParticipant(state, participantId(n));
  if (manual) for (let n = 1; n <= eligible; n++) state = roomApply(state, { type: "SUBMIT_XI", participantId: participantId(n), atMs: 30, expectedDraftRevision: draftOf(state, participantId(n)).revision });
  if (state.phase !== "COMPLETE") state = roomApply(state, { type: "FINALIZE_ROUND", roundId: "r1", atMs: 100 });
  return state;
}
