import type { EraDraftCatalog } from "./eraDraftData.js";
import { projectEraDraftPublicState } from "./eraDraftProjection.js";
import type { DraftOffCompetitionState } from "./draftOffCompetitionTypes.js";
import type { DraftOffPublicRoomView, DraftOffRoomView } from "./draftOffRoomTypes.js";

export function projectDraftOffRoom(
  catalog: EraDraftCatalog,
  state: DraftOffCompetitionState,
  participantId: string,
): DraftOffRoomView {
  const viewer = state.participants.find((participant) => participant.participantId === participantId);
  if (!viewer) throw new DraftOffRoomProjectionError("VIEWER_NOT_REGISTERED", "Participant is not registered in this room.");

  const round = currentRound(state);
  const ownRoundState = round.phase === "PENDING" ? undefined : round.participants.find((participant) => participant.participantId === participantId);
  const { resolution, ...shared } = projectDraftOffPublicRoom(state);
  // Preserve the existing private HTTP shape, optional fields and JSON field order.
  return freezeDeep({ ...shared,
    ...(ownRoundState ? { myDraft: projectEraDraftPublicState(catalog, ownRoundState.draftState) } : {}),
    ...(resolution ? { resolution } : {}),
  } satisfies DraftOffRoomView);
}

function currentRound(state: DraftOffCompetitionState) {
  return [...state.rounds].sort((left, right) => right.roundOrdinal - left.roundOrdinal)[0]!;
}

/** Explicit shared whitelist. Never derive this by deleting fields from a private view. */
export function projectDraftOffPublicRoom(state: DraftOffCompetitionState): DraftOffPublicRoomView {
  const round = currentRound(state);
  const roundParticipants = round.phase === "PENDING" ? [] : round.participants;
  const participants = state.participants.map((participant) => {
    const roundParticipant = roundParticipants.find((candidate) => candidate.participantId === participant.participantId);
    return {
      participantId: participant.participantId,
      displayName: participant.displayName,
      role: participant.role,
      membershipStatus: participant.membershipStatus,
      ...(roundParticipant ? { roundStatus: roundParticipant.status } : {}),
    };
  });

  return freezeDeep({
    roomId: state.competitionId,
    revision: state.revision,
    phase: state.phase,
    participants,
    round: {
      ...(state.genesis.format === undefined ? {} : { format: state.genesis.format }),
      roundId: round.roundId,
      roundOrdinal: round.roundOrdinal,
      label: round.label,
      eraId: round.eraId,
      phase: round.phase,
      ...(round.phase === "PENDING" ? {} : {
        startedAtMs: round.startedAtMs,
        deadlineAtMs: round.deadlineAtMs,
      }),
    },
    ...(round.phase === "RESOLVED" ? {
      resolution: {
        trigger: round.resolution.trigger,
        contestStatus: round.resolution.contestStatus,
        resolvedAtMs: round.resolution.resolvedAtMs,
        eligibleParticipantIds: [...round.resolution.eligibleParticipantIds],
        ineligibleParticipantIds: [...round.resolution.ineligibleParticipantIds],
        leaderboard: round.resolution.leaderboard.map((row) => ({
          rank: row.rank,
          participantId: row.participantId,
          displayName: row.displayName,
          played: row.played,
          won: row.won,
          lost: row.lost,
          points: row.points,
          netRunRate: row.netRunRate,
        })),
      },
    } : {}),
  } satisfies DraftOffPublicRoomView);
}

export class DraftOffRoomProjectionError extends Error {
  readonly name = "DraftOffRoomProjectionError";

  constructor(readonly code: "VIEWER_NOT_REGISTERED", message: string) {
    super(message);
  }
}

function freezeDeep<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) value.forEach(freezeDeep);
  else Object.values(value as Record<string, unknown>).forEach(freezeDeep);
  return Object.freeze(value);
}
