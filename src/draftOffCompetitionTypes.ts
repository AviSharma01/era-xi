import type { DraftOffChallengeResult, DraftOffLeaderboardRow, DraftOffSeedBundle } from "./draftOffTypes.js";
import type {
  AwaitingPickState,
  AwaitingSpinState,
  EraDraftCommandRejection,
  LockPlayerCommand,
  RespinCommand,
  SpinCommand,
  XiCompleteState,
} from "./eraDraftTypes.js";
import type { EraId } from "./teamEvaluationV2.js";

export const DRAFT_OFF_COMPETITION_ENGINE_VERSION = "ipl-draft-off-competition-engine/v1" as const;
export const DRAFT_OFF_COMPETITION_STATE_SCHEMA_VERSION = "ipl-draft-off-competition-state/v1" as const;
export const DRAFT_OFF_COMPETITION_SAVE_VERSION = "ipl-draft-off-competition-save/v1" as const;
export const DRAFT_OFF_SUBMISSION_VERSION = "ipl-draft-off-submission/v1" as const;
export const DRAFT_OFF_ROUND_RESOLUTION_VERSION = "ipl-draft-off-round-resolution/v1" as const;

export type DraftOffCompetitionPhase = "LOBBY" | "IN_PROGRESS" | "COMPLETE";
export type DraftOffRoundPhase = "PENDING" | "DRAFTING" | "RESOLVED";
export type DraftOffParticipantRole = "HOST" | "MEMBER";
export type DraftOffMembershipStatus = "JOINED" | "LEFT";

export type DraftOffCompetitionParticipant = {
  readonly participantId: string;
  readonly role: DraftOffParticipantRole;
  readonly displayName: string;
  readonly displayNameKey: string;
  readonly membershipStatus: DraftOffMembershipStatus;
  readonly firstJoinedAtMs: number;
  readonly membershipChangedAtMs: number;
};

export type DraftOffRoundGenesis = {
  readonly roundId: string;
  readonly roundOrdinal: number;
  readonly label: string;
  readonly eraId: EraId;
  readonly challengeSeed: string;
};

export type DraftOffCompetitionGenesis = {
  readonly competitionId: string;
  readonly catalogFingerprint: string;
  readonly createdAtMs: number;
  readonly host: {
    readonly participantId: string;
    readonly displayName: string;
  };
  readonly initialRound: DraftOffRoundGenesis;
};

export type DraftOffPrivateDraftState = AwaitingSpinState | AwaitingPickState | XiCompleteState;

export type DraftOffSubmission = {
  readonly version: typeof DRAFT_OFF_SUBMISSION_VERSION;
  readonly participantId: string;
  readonly source: "MANUAL" | "DEADLINE_AUTO";
  readonly submittedAtMs: number;
  readonly xi: XiCompleteState;
  readonly draftStateHash: string;
  readonly submissionHash: string;
};

export type DraftingRoundParticipant = {
  readonly participantId: string;
  readonly status: "DRAFTING";
  readonly draftState: DraftOffPrivateDraftState;
};

export type SubmittedRoundParticipant = {
  readonly participantId: string;
  readonly status: "SUBMITTED";
  readonly draftState: XiCompleteState;
  readonly submission: DraftOffSubmission;
};

export type IneligibleRoundParticipant = {
  readonly participantId: string;
  readonly status: "INELIGIBLE";
  readonly draftState: Exclude<DraftOffPrivateDraftState, XiCompleteState>;
  readonly reason: "INCOMPLETE_AT_DEADLINE";
};

export type DraftOffRoundParticipant =
  | DraftingRoundParticipant
  | SubmittedRoundParticipant
  | IneligibleRoundParticipant;

type DraftOffRoundCommon = DraftOffRoundGenesis & {
  readonly phase: DraftOffRoundPhase;
};

export type PendingDraftOffRound = DraftOffRoundCommon & {
  readonly phase: "PENDING";
};

export type ActiveDraftOffRound = DraftOffRoundCommon & {
  readonly phase: "DRAFTING";
  readonly seeds: DraftOffSeedBundle;
  readonly startedAtMs: number;
  readonly deadlineAtMs: number;
  readonly rosterParticipantIds: readonly string[];
  readonly participants: readonly DraftOffRoundParticipant[];
};

export type DraftOffRoundResolution = {
  readonly version: typeof DRAFT_OFF_ROUND_RESOLUTION_VERSION;
  readonly trigger: "ALL_SUBMITTED" | "DEADLINE";
  readonly contestStatus: "CONTESTED" | "UNCONTESTED" | "NO_CONTEST";
  readonly resolvedAtMs: number;
  readonly eligibleParticipantIds: readonly string[];
  readonly ineligibleParticipantIds: readonly string[];
  readonly challengeResult: DraftOffChallengeResult | null;
  readonly leaderboard: readonly DraftOffLeaderboardRow[];
  readonly resolutionHash: string;
};

export type ResolvedDraftOffRound = Omit<ActiveDraftOffRound, "phase"> & {
  readonly phase: "RESOLVED";
  readonly resolution: DraftOffRoundResolution;
};

export type DraftOffRoundState = PendingDraftOffRound | ActiveDraftOffRound | ResolvedDraftOffRound;

export type DraftOffCompetitionState = {
  readonly engineVersion: typeof DRAFT_OFF_COMPETITION_ENGINE_VERSION;
  readonly schemaVersion: typeof DRAFT_OFF_COMPETITION_STATE_SCHEMA_VERSION;
  readonly catalogFingerprint: string;
  readonly competitionId: string;
  readonly phase: DraftOffCompetitionPhase;
  readonly revision: number;
  readonly lastAcceptedAtMs: number;
  readonly genesis: DraftOffCompetitionGenesis;
  readonly participants: readonly DraftOffCompetitionParticipant[];
  readonly rounds: readonly DraftOffRoundState[];
  readonly history: readonly DraftOffCompetitionHistoryEntry[];
};

export type DraftOffDraftCommand = SpinCommand | RespinCommand | LockPlayerCommand;

export type JoinCompetitionCommand = {
  readonly type: "JOIN_COMPETITION";
  readonly participantId: string;
  readonly displayName?: string;
  readonly atMs: number;
};

export type LeaveCompetitionCommand = {
  readonly type: "LEAVE_COMPETITION";
  readonly participantId: string;
  readonly atMs: number;
};

export type StartRoundCommand = {
  readonly type: "START_ROUND";
  readonly actorParticipantId: string;
  readonly roundId: string;
  readonly atMs: number;
  readonly deadlineAtMs: number;
};

export type ApplyDraftCommand = {
  readonly type: "APPLY_DRAFT_COMMAND";
  readonly participantId: string;
  readonly atMs: number;
  readonly expectedDraftRevision: number;
  readonly draftCommand: DraftOffDraftCommand;
};

export type SubmitXiCommand = {
  readonly type: "SUBMIT_XI";
  readonly participantId: string;
  readonly atMs: number;
  readonly expectedDraftRevision: number;
};

export type FinalizeRoundCommand = {
  readonly type: "FINALIZE_ROUND";
  readonly roundId: string;
  readonly atMs: number;
};

export type DraftOffCompetitionCommand =
  | JoinCompetitionCommand
  | LeaveCompetitionCommand
  | StartRoundCommand
  | ApplyDraftCommand
  | SubmitXiCommand
  | FinalizeRoundCommand;

export type DraftOffCompetitionHistoryEntry = {
  readonly revision: number;
  readonly command: DraftOffCompetitionCommand;
  readonly resultingCompetitionPhase: DraftOffCompetitionPhase;
};

export type DraftOffCompetitionRejectionCode =
  | "INVALID_PHASE"
  | "INVALID_TIMESTAMP"
  | "STALE_TIMESTAMP"
  | "INVALID_PARTICIPANT_ID"
  | "INVALID_DISPLAY_NAME"
  | "DISPLAY_NAME_RESERVED"
  | "PARTICIPANT_ID_CONFLICT"
  | "PARTICIPANT_NOT_FOUND"
  | "PARTICIPANT_NOT_JOINED"
  | "PARTICIPANT_LIMIT"
  | "HOST_CANNOT_LEAVE"
  | "NOT_HOST"
  | "ROUND_NOT_FOUND"
  | "INVALID_DEADLINE"
  | "STALE_DRAFT_REVISION"
  | "PARTICIPANT_FINALIZED"
  | "DEADLINE_REACHED"
  | "DEADLINE_NOT_REACHED"
  | "INCOMPLETE_XI"
  | "ERA_DRAFT_COMMAND_REJECTED";

export type DraftOffCompetitionCommandRejection = {
  readonly kind: "COMMAND_REJECTED";
  readonly code: DraftOffCompetitionRejectionCode;
  readonly message: string;
  readonly command: DraftOffCompetitionCommand["type"];
  readonly competitionPhase: DraftOffCompetitionPhase;
  readonly context?: Readonly<Record<string, unknown>>;
  readonly eraDraftError?: EraDraftCommandRejection;
};

export type DraftOffCompetitionTransitionResult =
  | {
      readonly ok: true;
      readonly changed: true;
      readonly state: DraftOffCompetitionState;
      readonly event: DraftOffCompetitionHistoryEntry;
    }
  | {
      readonly ok: true;
      readonly changed: false;
      readonly state: DraftOffCompetitionState;
    }
  | {
      readonly ok: false;
      readonly state: DraftOffCompetitionState;
      readonly error: DraftOffCompetitionCommandRejection;
    };

export class DraftOffCompetitionDataError extends Error {
  readonly name = "DraftOffCompetitionDataError";

  constructor(
    readonly code: string,
    message: string,
    readonly context: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class DraftOffCompetitionInvariantError extends Error {
  readonly name = "DraftOffCompetitionInvariantError";

  constructor(
    readonly code: string,
    message: string,
    readonly context: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}
