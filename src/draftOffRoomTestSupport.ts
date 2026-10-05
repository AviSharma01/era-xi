import assert from "node:assert/strict";
import { loadEraDraftCatalog } from "./eraDraftData.js";
import { createDraftOffCompetition, reduceDraftOffCompetition } from "./draftOffCompetition.js";
import { restoreDraftOffCompetition } from "./draftOffCompetitionPersistence.js";
import type { DraftOffCompetitionCommand, DraftOffCompetitionState } from "./draftOffCompetitionTypes.js";
import { evaluateSelectionLegality, getOpenBattingPositions } from "./eraDraftLegality.js";
import type { DraftOffClock, DraftOffRoomActor, DraftOffRoomCommandResult } from "./draftOffRoomTypes.js";

export const catalog = loadEraDraftCatalog();
export const host: DraftOffRoomActor = { kind: "PARTICIPANT", participantId: "host" };
export const member: DraftOffRoomActor = { kind: "PARTICIPANT", participantId: "member" };
export const outsider: DraftOffRoomActor = { kind: "PARTICIPANT", participantId: "outsider" };

export const roomInput = {
  roomId: "room",
  hostDisplayName: "Host",
  initialRound: {
    roundId: "round-1", roundOrdinal: 1, label: "Draft-Off", eraId: "era-transition" as const,
    challengeSeed: "m3-seed",
  },
};

export function baseState(): DraftOffCompetitionState {
  return createDraftOffCompetition(catalog, {
    competitionId: roomInput.roomId, createdAtMs: 0, catalogFingerprint: catalog.fingerprint,
    host: { participantId: "host", displayName: "Host" }, initialRound: roomInput.initialRound,
  });
}

export function joinedState(): DraftOffCompetitionState {
  return changed(baseState(), { type: "JOIN_COMPETITION", participantId: "member", displayName: "Member", atMs: 1 });
}

export function startedState(): DraftOffCompetitionState {
  return changed(joinedState(), { type: "START_ROUND", actorParticipantId: "host", roundId: "round-1", atMs: 10, deadlineAtMs: 100 });
}

export function changed(state: DraftOffCompetitionState, command: DraftOffCompetitionCommand): DraftOffCompetitionState {
  const result = reduceDraftOffCompetition(catalog, state, command);
  assert.ok(result.ok, result.ok ? undefined : result.error.message);
  assert.ok(result.changed);
  return result.state;
}

export function participant(state: DraftOffCompetitionState, participantId: string) {
  const round = state.rounds[0]!;
  assert.notEqual(round.phase, "PENDING");
  if (round.phase === "PENDING") throw new Error("Expected started round");
  return round.participants.find((entry) => entry.participantId === participantId)!;
}

export function completeXi(state: DraftOffCompetitionState, participantId: string, count = 11) {
  for (let pick = 0; pick < count; pick += 1) {
    state = changed(state, {
      type: "APPLY_DRAFT_COMMAND", participantId, atMs: 20,
      expectedDraftRevision: participant(state, participantId).draftState.revision, draftCommand: { type: "SPIN" },
    });
    state = changed(state, {
      type: "APPLY_DRAFT_COMMAND", participantId, atMs: 20,
      expectedDraftRevision: participant(state, participantId).draftState.revision,
      draftCommand: legalLock(state, participantId),
    });
  }
  return state;
}

export function legalLock(state: DraftOffCompetitionState, participantId: string) {
  const draft = participant(state, participantId).draftState;
  assert.equal(draft.phase, "AWAITING_PICK");
  if (draft.phase !== "AWAITING_PICK") throw new Error("Expected spun draft");
  const context = { eraId: draft.eraId, picks: draft.picks, activeTeamSeasonId: draft.currentSpin.teamSeasonId };
  const choice = catalog.getCandidatesForTeamSeason(draft.currentSpin.teamSeasonId)
    .flatMap((player) => getOpenBattingPositions(draft.picks)
      .map((battingPosition) => ({ playerTeamSeasonId: player.playerTeamSeasonId, battingPosition })))
    .find((candidate) => evaluateSelectionLegality(catalog, context, candidate).available);
  assert.ok(choice);
  return { type: "LOCK_PLAYER" as const, ...choice };
}

export function success(result: DraftOffRoomCommandResult) {
  assert.ok(result.ok, result.ok ? undefined : `${result.code}: ${result.message}`);
  return result;
}

export function rejection(result: DraftOffRoomCommandResult, code: string) {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("Expected rejection");
  assert.equal(result.code, code);
  return result;
}

export { restoreDraftOffCompetition };

/** Separates advancing authoritative time from timer delivery to enumerate race orderings. */
export class ManualDraftOffClock implements DraftOffClock {
  time = 20;
  readonly callbacks: Array<{ cancelled: boolean; callback: () => void | Promise<void> }> = [];
  nowMs() { return this.time; }
  scheduleAt(_atMs: number, callback: () => void | Promise<void>) {
    const entry = { cancelled: false, callback };
    this.callbacks.push(entry);
    return { cancel: () => { entry.cancelled = true; } };
  }
  async fire(index = 0) { await this.callbacks[index]!.callback(); }
}
