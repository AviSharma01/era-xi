import type { DraftOffCompetitionRejectionCode } from "./draftOffCompetitionTypes.js";
import type { DraftOffDraftCommand } from "./draftOffCompetitionTypes.js";
import type { EraDraftPublicView } from "./eraDraftTypes.js";
import type { EraId } from "./teamEvaluationV2.js";

export type DraftOffRoomActor =
  | { readonly kind: "PARTICIPANT"; readonly participantId: string }
  | { readonly kind: "SYSTEM" };

export type CreateDraftOffRoomInput = {
  readonly roomId: string;
  readonly hostDisplayName: string;
  readonly initialRound: {
    readonly roundId: string;
    readonly roundOrdinal: number;
    readonly label: string;
    readonly eraId: EraId;
    readonly challengeSeed: string;
  };
};

export type DraftOffRoomLifecycleCommand =
  | { readonly type: "JOIN"; readonly displayName?: string }
  | { readonly type: "LEAVE" }
  | { readonly type: "START"; readonly roundId: string; readonly deadlineAtMs: number };

export type DraftOffRoomParticipantCommand =
  | DraftOffDraftCommand
  | { readonly type: "SUBMIT" };

export type DraftOffRoomLifecycleEnvelope = {
  readonly roomId: string;
  readonly commandId: string;
  readonly expectedRoomRevision: number;
  readonly command: DraftOffRoomLifecycleCommand;
};

export type DraftOffRoomParticipantEnvelope = {
  readonly roomId: string;
  readonly commandId: string;
  readonly expectedDraftRevision: number;
  readonly command: DraftOffRoomParticipantCommand;
};

export type DraftOffRoomCommandEnvelope = DraftOffRoomLifecycleEnvelope | DraftOffRoomParticipantEnvelope;

export type DraftOffRoomParticipantView = {
  readonly participantId: string;
  readonly displayName: string;
  readonly role: "HOST" | "MEMBER";
  readonly membershipStatus: "JOINED" | "LEFT";
  readonly roundStatus?: "DRAFTING" | "SUBMITTED" | "INELIGIBLE";
};

export type DraftOffRoomLeaderboardRowView = {
  readonly rank: number;
  readonly participantId: string;
  readonly displayName: string;
  readonly played: number;
  readonly won: number;
  readonly lost: number;
  readonly points: number;
  readonly netRunRate: number;
};

export type DraftOffRoomView = {
  readonly roomId: string;
  readonly revision: number;
  readonly phase: "LOBBY" | "IN_PROGRESS" | "COMPLETE";
  readonly participants: readonly DraftOffRoomParticipantView[];
  readonly round: {
    readonly roundId: string;
    readonly roundOrdinal: number;
    readonly label: string;
    readonly eraId: EraId;
    readonly phase: "PENDING" | "DRAFTING" | "RESOLVED";
    readonly startedAtMs?: number;
    readonly deadlineAtMs?: number;
  };
  readonly myDraft?: EraDraftPublicView;
  readonly resolution?: {
    readonly trigger: "ALL_SUBMITTED" | "DEADLINE";
    readonly contestStatus: "CONTESTED" | "UNCONTESTED" | "NO_CONTEST";
    readonly resolvedAtMs: number;
    readonly eligibleParticipantIds: readonly string[];
    readonly ineligibleParticipantIds: readonly string[];
    readonly leaderboard: readonly DraftOffRoomLeaderboardRowView[];
  };
};

export type DraftOffRoomServiceRejectionCode =
  | "ROOM_NOT_FOUND"
  | "ROOM_ALREADY_EXISTS"
  | "INVALID_ACTOR"
  | "INVALID_COMMAND_ID"
  | "INVALID_COMMAND"
  | "COMMAND_ID_CONFLICT"
  | "STALE_ROOM_REVISION"
  | "FORBIDDEN"
  | DraftOffCompetitionRejectionCode;

export type DraftOffRoomCommandResult =
  | {
      readonly ok: true;
      readonly changed: boolean;
      readonly roomRevision: number;
      readonly view?: DraftOffRoomView;
    }
  | {
      readonly ok: false;
      readonly code: DraftOffRoomServiceRejectionCode;
      readonly message: string;
      readonly roomRevision?: number;
      readonly view?: DraftOffRoomView;
    };

export type DraftOffRoomCommandReceipt = {
  readonly fingerprint: string;
  readonly result: DraftOffRoomCommandResult;
};

export type DraftOffRoomRepositoryRecord = {
  readonly serializedCompetition: string;
  readonly receipts: Readonly<Record<string, DraftOffRoomCommandReceipt>>;
};

export type DraftOffScheduledTask = {
  cancel(): void;
};

export interface DraftOffClock {
  nowMs(): number;
  /** Callbacks run asynchronously at/after the deadline; cancellation prevents pending delivery. */
  scheduleAt(atMs: number, callback: () => void | Promise<void>): DraftOffScheduledTask;
}
