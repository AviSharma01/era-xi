import type {
  BowlingFamily,
  BowlingWorkloadClass,
  DerivedRole,
  FitClassification,
  KeeperStatus,
} from "./playerRoleContract.js";
import type { QualityTier } from "./playerQualityContract.js";
import type { LeagueResultV2, SimulationTeamV2 } from "./simulationV2.js";
import type { EraId, IplRosterStatus, TeamEvaluationV2 } from "./teamEvaluationV2.js";

export const ERA_DRAFT_ENGINE_VERSION = "ipl-era-draft-engine/v1" as const;
export const ERA_DRAFT_STATE_SCHEMA_VERSION = "ipl-era-draft-state/v1" as const;
export const ERA_DRAFT_SAVE_VERSION = "ipl-era-draft-save/v1" as const;
export const ERA_DRAFT_SIMULATION_SEED_VERSION = "ipl-era-draft-simulation-seeds/v1" as const;

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
  readonly status: "AVAILABLE" | "USED";
};

export type CurrentSpin = {
  readonly spinOrdinal: number;
  readonly origin: "NORMAL" | "RESPIN";
  readonly teamSeasonId: TeamSeasonId;
  readonly seasonId: string;
  readonly teamId: string;
  readonly franchiseId: string;
  readonly recovery: {
    readonly triggeringTeamSeasonId: TeamSeasonId;
    readonly skippedDeadTeamSeasonIds: readonly TeamSeasonId[];
  } | null;
};

export type ChooseEraCommand = {
  readonly type: "CHOOSE_ERA";
  readonly eraId: EraId;
};

export type SpinCommand = {
  readonly type: "SPIN";
};

export type LockPlayerCommand = {
  readonly type: "LOCK_PLAYER";
  readonly playerTeamSeasonId: string;
  readonly battingPosition: number;
};

export type RespinCommand = {
  readonly type: "RESPIN";
};

export type RevealXiCommand = {
  readonly type: "REVEAL_XI";
};

export type SimulateSeasonCommand = {
  readonly type: "SIMULATE_SEASON";
};

export type EraDraftCommand =
  | ChooseEraCommand
  | SpinCommand
  | LockPlayerCommand
  | RespinCommand
  | RevealXiCommand
  | SimulateSeasonCommand;

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
  readonly spinOrdinal: number;
  readonly triggeringTeamSeasonId: TeamSeasonId;
  readonly skippedDeadTeamSeasonIds: readonly TeamSeasonId[];
  readonly selectedTeamSeasonId: TeamSeasonId;
};

export type LockPlayerHistoryEntry = {
  readonly revision: number;
  readonly command: "LOCK_PLAYER";
  readonly payload: {
    readonly playerTeamSeasonId: string;
    readonly playerId: string;
    readonly battingPosition: EraDraftPick["battingPosition"];
  };
  readonly resultingPhase: "AWAITING_SPIN" | "XI_COMPLETE";
};

export type RespinHistoryEntry = {
  readonly revision: number;
  readonly command: "RESPIN";
  readonly payload: Record<string, never>;
  readonly resultingPhase: "AWAITING_PICK";
  readonly respinOrdinal: number;
  readonly discardedTeamSeasonId: TeamSeasonId;
  readonly triggeringTeamSeasonId: TeamSeasonId;
  readonly skippedDeadTeamSeasonIds: readonly TeamSeasonId[];
  readonly replacementTeamSeasonId: TeamSeasonId;
  readonly resultingRespinStatus: "USED";
};

export type RevealXiHistoryEntry = {
  readonly revision: number;
  readonly command: "REVEAL_XI";
  readonly payload: Record<string, never>;
  readonly resultingPhase: "REVEALED";
};

export type SimulateSeasonHistoryEntry = {
  readonly revision: number;
  readonly command: "SIMULATE_SEASON";
  readonly payload: Record<string, never>;
  readonly resultingPhase: "GAME_COMPLETE";
};

export type EraDraftHistoryEntry =
  | ChooseEraHistoryEntry
  | SpinHistoryEntry
  | LockPlayerHistoryEntry
  | RespinHistoryEntry
  | RevealXiHistoryEntry
  | SimulateSeasonHistoryEntry;

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

export type XiCompleteState = EraDraftStateCommon & {
  readonly phase: "XI_COMPLETE";
  readonly eraId: EraId;
};

export type RevealedState = EraDraftStateCommon & {
  readonly phase: "REVEALED";
  readonly eraId: EraId;
  readonly evaluation: TeamEvaluationV2;
};

export type EraDraftSimulationSeedBundle = {
  readonly version: typeof ERA_DRAFT_SIMULATION_SEED_VERSION;
  readonly gameIdentityHash: string;
  readonly opponentCompositionSeed: string;
  readonly matchSimulationSeed: string;
};

export type EraDraftUserOutcome = {
  readonly leaguePosition: number;
  readonly qualified: boolean;
  readonly champion: boolean;
};

export type EraDraftSeasonResult = {
  readonly stage7Versions: {
    readonly simulationVersion: LeagueResultV2["version"];
    readonly environmentSchemaVersion: string;
  };
  readonly seedBundle: EraDraftSimulationSeedBundle;
  readonly userTeam: SimulationTeamV2;
  readonly league: LeagueResultV2;
  readonly userOutcome: EraDraftUserOutcome;
};

export type GameCompleteState = EraDraftStateCommon & {
  readonly phase: "GAME_COMPLETE";
  readonly eraId: "era-foundation";
  readonly evaluation: TeamEvaluationV2;
  readonly season: EraDraftSeasonResult;
};

export type EraDraftState =
  | SetupState
  | AwaitingSpinState
  | AwaitingPickState
  | XiCompleteState
  | RevealedState
  | GameCompleteState;
export type EraDraftHiddenState = Exclude<EraDraftState, RevealedState | GameCompleteState>;

export type EraDraftSelectionRejectionCode =
  | "PLAYER_NOT_FOUND"
  | "PLAYER_NOT_G2_ELIGIBLE"
  | "PLAYER_NOT_IN_CURRENT_SPIN"
  | "DUPLICATE_CANONICAL_PLAYER"
  | "INVALID_POSITION"
  | "POSITION_OCCUPIED"
  | "ROSTER_STATUS_UNRESOLVED"
  | "OVERSEAS_LIMIT"
  | "FUTURE_XI_IMPOSSIBLE";

export type EraDraftCommandRejectionCode =
  | "INVALID_PHASE"
  | "NO_ACTIVE_SPIN"
  | "UNKNOWN_ERA"
  | EraDraftSelectionRejectionCode
  | "RESPIN_UNAVAILABLE"
  | "RESPIN_REPLACEMENT_UNAVAILABLE"
  | "SIMULATION_CONTENT_UNAVAILABLE";

export type EraDraftSelectionRejection = {
  readonly code: EraDraftSelectionRejectionCode;
  readonly message: string;
};

export type EraDraftCommandRejection = {
  readonly kind: "COMMAND_REJECTED";
  readonly code: EraDraftCommandRejectionCode;
  readonly message: string;
  readonly command: EraDraftCommand["type"];
  readonly phase: EraDraftState["phase"];
  readonly reasons?: readonly EraDraftSelectionRejection[];
  readonly context?: Readonly<Record<string, unknown>>;
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

export type DraftPlayerFactsView = {
  readonly playerTeamSeasonId: string;
  readonly playerId: string;
  readonly playerName: string;
  readonly seasonId: string;
  readonly seasonYear: number;
  readonly teamId: string;
  readonly teamName: string;
  readonly franchiseId: string;
  readonly franchiseName: string;
  readonly rosterStatus: Exclude<IplRosterStatus, "UNKNOWN">;
  readonly keeperCapability: KeeperStatus;
  readonly derivedRole: DerivedRole;
  readonly bowlingWorkloadClass: BowlingWorkloadClass;
  readonly bowlingFamily: BowlingFamily;
};

export type DraftPickView = DraftPlayerFactsView & {
  readonly pickNumber: number;
  readonly battingPosition: EraDraftPick["battingPosition"];
  readonly fit: FitClassification;
};

export type DraftCandidateIdentityView = DraftPlayerFactsView & {
  readonly available: boolean;
  readonly positions: readonly {
    readonly battingPosition: EraDraftPick["battingPosition"];
    readonly fit: FitClassification;
    readonly available: boolean;
    readonly reasons: readonly EraDraftSelectionRejection[];
  }[];
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
  readonly picks: readonly DraftPickView[];
};

export type AwaitingPickPublicView = {
  readonly phase: "AWAITING_PICK";
  readonly revision: number;
  readonly eraId: EraId;
  readonly eraLabel: string;
  readonly picks: readonly DraftPickView[];
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

export type XiCompletePublicView = {
  readonly phase: "XI_COMPLETE";
  readonly revision: number;
  readonly eraId: EraId;
  readonly eraLabel: string;
  readonly picks: readonly DraftPickView[];
};

export type EraDraftPublicView = SetupPublicView | AwaitingSpinPublicView | AwaitingPickPublicView | XiCompletePublicView;

export type RevealPlayerView = DraftPlayerFactsView & {
  readonly battingPosition: EraDraftPick["battingPosition"];
  readonly fit: FitClassification;
  readonly battingRating: number | null;
  readonly bowlingRating: number | null;
  readonly overallRating: number;
  readonly qualityTier: QualityTier;
};

export type EraDraftRevealView = {
  readonly phase: "REVEALED";
  readonly revision: number;
  readonly eraId: EraId;
  readonly eraLabel: string;
  readonly picks: readonly DraftPickView[];
  readonly players: readonly RevealPlayerView[];
  readonly evaluation: {
    readonly version: TeamEvaluationV2["version"];
    readonly battingContributions: TeamEvaluationV2["battingContributions"];
    readonly bowlingDeployment: TeamEvaluationV2["bowlingDeployment"];
    readonly baseStrength: TeamEvaluationV2["baseStrength"];
    readonly adjustedStrength: TeamEvaluationV2["adjustedStrength"];
    readonly diagnostics: TeamEvaluationV2["diagnostics"];
    readonly effects: TeamEvaluationV2["effects"];
  };
};
