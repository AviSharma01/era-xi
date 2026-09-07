import type { EraId } from "./teamEvaluationV2.js";

export const ERA_DRAFT_ENGINE_VERSION = "ipl-era-draft-engine/v1" as const;
export const ERA_DRAFT_STATE_SCHEMA_VERSION = "ipl-era-draft-state/v1" as const;

export type TeamSeasonId = `ts:${string}:${string}`;

export type EraDraftPick = {
  readonly pickNumber: number;
  readonly playerTeamSeasonId: string;
  readonly playerId: string;
  readonly seasonId: string;
  readonly teamId: string;
  readonly franchiseId: string;
  readonly teamSeasonId: TeamSeasonId;
  readonly battingPosition: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;
};

export type EraDraftRngCounters = {
  readonly normalSpin: number;
  readonly voluntaryRespin: number;
  readonly deadSpinRecovery: number;
};

export type EraDraftRespinState = {
  readonly status: "AVAILABLE";
};

export type CurrentSpin = {
  readonly spinOrdinal: number;
  readonly origin: "NORMAL";
  readonly teamSeasonId: TeamSeasonId;
  readonly seasonId: string;
  readonly teamId: string;
  readonly franchiseId: string;
};

export type ChooseEraCommand = {
  readonly type: "CHOOSE_ERA";
  readonly eraId: EraId;
};

export type SpinCommand = {
  readonly type: "SPIN";
};

export type EraDraftCommand = ChooseEraCommand | SpinCommand;

export type ChooseEraHistoryEntry = {
  readonly revision: number;
  readonly command: "CHOOSE_ERA";
  readonly payload: { readonly eraId: EraId };
  readonly resultingPhase: "AWAITING_SPIN";
};

export type SpinHistoryEntry = {
  readonly revision: number;
  readonly command: "SPIN";
  readonly payload: Record<string, never>;
  readonly resultingPhase: "AWAITING_PICK";
  readonly selectedTeamSeasonId: TeamSeasonId;
};

export type EraDraftHistoryEntry = ChooseEraHistoryEntry | SpinHistoryEntry;

type EraDraftStateCommon = {
  readonly engineVersion: typeof ERA_DRAFT_ENGINE_VERSION;
  readonly schemaVersion: typeof ERA_DRAFT_STATE_SCHEMA_VERSION;
  readonly catalogFingerprint: string;
  readonly rootSeed: string;
  readonly revision: number;
  readonly rngCounters: EraDraftRngCounters;
  readonly respin: EraDraftRespinState;
  readonly history: readonly EraDraftHistoryEntry[];
  readonly picks: readonly EraDraftPick[];
};

export type SetupState = EraDraftStateCommon & {
  readonly phase: "SETUP";
};

export type AwaitingSpinState = EraDraftStateCommon & {
  readonly phase: "AWAITING_SPIN";
  readonly eraId: EraId;
};

export type AwaitingPickState = EraDraftStateCommon & {
  readonly phase: "AWAITING_PICK";
  readonly eraId: EraId;
  readonly currentSpin: CurrentSpin;
};

export type EraDraftState = SetupState | AwaitingSpinState | AwaitingPickState;

export type EraDraftCommandRejectionCode = "INVALID_PHASE" | "UNKNOWN_ERA";

export type EraDraftCommandRejection = {
  readonly kind: "COMMAND_REJECTED";
  readonly code: EraDraftCommandRejectionCode;
  readonly message: string;
  readonly command: EraDraftCommand["type"];
  readonly phase: EraDraftState["phase"];
};

export type EraDraftTransitionResult =
  | {
      readonly ok: true;
      readonly state: EraDraftState;
      readonly event: EraDraftHistoryEntry;
    }
  | {
      readonly ok: false;
      readonly state: EraDraftState;
      readonly error: EraDraftCommandRejection;
    };

export class EraDraftDataError extends Error {
  readonly name = "EraDraftDataError";

  constructor(
    readonly code: string,
    message: string,
    readonly context: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class EraDraftInvariantError extends Error {
  readonly name = "EraDraftInvariantError";

  constructor(
    readonly code: string,
    message: string,
    readonly context: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

export type DraftCandidateIdentityView = {
  readonly playerTeamSeasonId: string;
  readonly playerId: string;
  readonly playerName: string;
  readonly seasonId: string;
  readonly seasonYear: number;
  readonly teamId: string;
  readonly teamName: string;
  readonly franchiseId: string;
  readonly franchiseName: string;
};

export type SetupPublicView = {
  readonly phase: "SETUP";
  readonly revision: number;
};

export type AwaitingSpinPublicView = {
  readonly phase: "AWAITING_SPIN";
  readonly revision: number;
  readonly eraId: EraId;
  readonly eraLabel: string;
};

export type AwaitingPickPublicView = {
  readonly phase: "AWAITING_PICK";
  readonly revision: number;
  readonly eraId: EraId;
  readonly eraLabel: string;
  readonly currentSpin: {
    readonly spinOrdinal: number;
    readonly teamSeasonId: TeamSeasonId;
    readonly seasonId: string;
    readonly seasonYear: number;
    readonly teamId: string;
    readonly teamName: string;
    readonly franchiseId: string;
    readonly franchiseName: string;
  };
  readonly candidates: readonly DraftCandidateIdentityView[];
};

export type EraDraftPublicView = SetupPublicView | AwaitingSpinPublicView | AwaitingPickPublicView;
