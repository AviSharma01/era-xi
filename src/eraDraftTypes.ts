import type {
  AllRounderLean,
  BowlingFamily,
  BowlingWorkloadClass,
  DerivedRole,
  KeeperStatus,
} from "./playerRoleContract.js";
import type { QualityTier } from "./playerQualityContract.js";
import type { LeagueResultV2, SimulationTeamV2 } from "./simulationV2.js";
import type { EraId, IplRosterStatus, TeamEvaluationV2 } from "./teamEvaluationV2.js";

export const ERA_DRAFT_ENGINE_VERSION = "ipl-era-draft-engine/v1" as const;
export const ERA_DRAFT_STATE_SCHEMA_VERSION = "ipl-era-draft-state/v2" as const;
export const ERA_DRAFT_SAVE_VERSION = "ipl-era-draft-save/v2" as const;
export const ERA_DRAFT_SIMULATION_SEED_VERSION = "ipl-era-draft-simulation-seeds/v1" as const;
export const ERA_DRAFT_OPPONENT_COMPOSITION_SCHEMA_VERSION = "ipl-era-opponent-composition/v1" as const;

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

export type EraDraftOpponentComposition = {
  readonly schemaVersion: typeof ERA_DRAFT_OPPONENT_COMPOSITION_SCHEMA_VERSION;
  readonly eraId: EraId;
  readonly fullPoolProfileIds: readonly string[];
  readonly shortlistedProfileIds: readonly string[];
};

export type EraDraftOpponentCompositionView = EraDraftOpponentComposition & {
  readonly actualOpponentProfileIds: readonly string[];
  readonly omittedShortlistedProfileId: string;
};

export type EraDraftSeasonResult = {
  readonly stage7Versions: {
    readonly simulationVersion: LeagueResultV2["version"];
    readonly environmentSchemaVersion: string;
  };
  readonly seedBundle: EraDraftSimulationSeedBundle;
  readonly opponentComposition: EraDraftOpponentComposition;
  readonly userTeam: SimulationTeamV2;
  readonly league: LeagueResultV2;
  readonly userOutcome: EraDraftUserOutcome;
};

export type GameCompleteState = EraDraftStateCommon & {
  readonly phase: "GAME_COMPLETE";
  readonly eraId: EraId;
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
  | "RESPIN_REPLACEMENT_UNAVAILABLE";

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
  readonly displayRole: DraftDisplayRole;
  readonly bowlingWorkloadClass: BowlingWorkloadClass;
  readonly bowlingFamily: BowlingFamily;
};

export type DraftDisplayRole =
  | "BATTER"
  | "WICKETKEEPER_BATTER"
  | "ALL_ROUNDER"
  | "BOWLER"
  | "UNKNOWN";

export type DraftPresentationFit =
  | "NATURAL"
  | "ACCEPTABLE"
  | "STRETCH"
  | "MAJOR_STRETCH"
  | "UNKNOWN";

export type DraftStatusView = {
  readonly pickCount: number;
  readonly pickLimit: 11;
  readonly overseasCount: number;
  readonly overseasLimit: 4;
  readonly hasWicketkeeper: boolean;
  readonly respinStatus: "AVAILABLE" | "USED";
};

export type DraftPickView = DraftPlayerFactsView & {
  readonly pickNumber: number;
  readonly battingPosition: EraDraftPick["battingPosition"];
  readonly presentationFit: DraftPresentationFit;
};

export type DraftCandidateIdentityView = DraftPlayerFactsView & {
  readonly presentationGroup: "BATTERS" | "ALL_ROUNDERS" | "BOWLERS";
  readonly allRounderLean: AllRounderLean | null;
  readonly historicalStats: DraftHistoricalStatsView;
  readonly available: boolean;
  readonly positions: readonly {
    readonly battingPosition: EraDraftPick["battingPosition"];
    readonly presentationFit: DraftPresentationFit;
    readonly available: boolean;
    readonly reasons: readonly EraDraftSelectionRejection[];
  }[];
};

export type DraftHistoricalBattingView = {
  readonly innings: number;
  readonly runs: number;
  readonly average: number | null;
  readonly strikeRate: number | null;
};

export type DraftHistoricalBowlingView = {
  readonly innings: number;
  readonly wickets: number;
  readonly legalBalls: number;
  readonly economy: number | null;
};

export type DraftHistoricalPeakView<T> = T & {
  readonly seasonId: string;
  readonly seasonYear: number;
  readonly teamId: string;
  readonly teamName: string;
  readonly playerTeamSeasonId: string;
};

export type DraftHistoricalStatsView = {
  readonly currentSeason: {
    readonly batting: DraftHistoricalBattingView;
    readonly bowling: DraftHistoricalBowlingView;
  };
  readonly eraBest: {
    readonly batting: DraftHistoricalPeakView<DraftHistoricalBattingView> | null;
    readonly bowling: DraftHistoricalPeakView<DraftHistoricalBowlingView> | null;
  };
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
  readonly status: DraftStatusView;
  readonly picks: readonly DraftPickView[];
};

export type AwaitingPickPublicView = {
  readonly phase: "AWAITING_PICK";
  readonly revision: number;
  readonly eraId: EraId;
  readonly eraLabel: string;
  readonly status: DraftStatusView;
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
  readonly status: DraftStatusView;
  readonly picks: readonly DraftPickView[];
};

export type EraDraftPublicView = SetupPublicView | AwaitingSpinPublicView | AwaitingPickPublicView | XiCompletePublicView;

export type RevealPlayerView = DraftPlayerFactsView & {
  readonly battingPosition: EraDraftPick["battingPosition"];
  readonly presentationFit: DraftPresentationFit;
  readonly battingRating: number | null;
  readonly bowlingRating: number | null;
  readonly overallRating: number;
  readonly qualityTier: QualityTier;
};

export type TeamEvaluationSummaryView = {
  readonly strength: {
    readonly overall: number;
    readonly batting: number;
    readonly bowling: number;
  };
  readonly tierCounts: Readonly<Record<QualityTier, number>>;
  readonly fitCounts: Readonly<Record<DraftPresentationFit, number>>;
  readonly construction: {
    readonly overseasCount: number;
    readonly overseasLimit: 4;
    readonly hasWicketkeeper: boolean;
    readonly deployedBowlingUnits: number;
    readonly requiredBowlingUnits: 5;
    readonly frontlineBowlers: number;
    readonly supportBowlers: number;
  };
};

export type EraDraftRevealView = {
  readonly phase: "REVEALED";
  readonly revision: number;
  readonly eraId: EraId;
  readonly eraLabel: string;
  readonly status: DraftStatusView;
  readonly picks: readonly DraftPickView[];
  readonly players: readonly RevealPlayerView[];
  readonly evaluation: TeamEvaluationSummaryView;
};

export type SeasonStandingView = {
  readonly position: number;
  readonly teamId: string;
  readonly teamName: string;
  readonly played: number;
  readonly won: number;
  readonly lost: number;
  readonly points: number;
  readonly netRunRate: number;
  readonly isUser: boolean;
  readonly qualified: boolean | null;
};

export type SeasonMatchView = {
  readonly matchId: string;
  readonly sequence: number;
  readonly stage: "LEAGUE" | "QUALIFIER_1" | "ELIMINATOR" | "QUALIFIER_2" | "FINAL";
  readonly firstInnings: {
    readonly teamId: string;
    readonly teamName: string;
    readonly runs: number;
    readonly wickets: number;
    readonly balls: number;
  };
  readonly secondInnings: {
    readonly teamId: string;
    readonly teamName: string;
    readonly runs: number;
    readonly wickets: number;
    readonly balls: number;
  };
  readonly winnerTeamId: string;
  readonly result: "WIN" | "LOSS" | "AI_RESULT";
  readonly resultLabel: string;
  readonly opponent: { readonly teamId: string; readonly teamName: string } | null;
};

export type UserLeagueCheckpointView = {
  readonly matchNumber: number;
  readonly round: number;
  readonly match: SeasonMatchView;
  readonly record: { readonly won: number; readonly lost: number };
  readonly position: number;
  readonly previousPosition: number | null;
  readonly movement: "UP" | "DOWN" | "SAME" | "FIRST";
  readonly standings: readonly SeasonStandingView[];
};

export type EraDraftGameCompleteView = {
  readonly phase: "GAME_COMPLETE";
  readonly revision: number;
  readonly eraId: EraId;
  readonly eraLabel: string;
  readonly league: {
    readonly userMatches: readonly UserLeagueCheckpointView[];
    readonly finalStandings: readonly SeasonStandingView[];
    readonly userFinalPosition: number;
    readonly userRecord: { readonly won: number; readonly lost: number };
    readonly qualified: boolean;
  };
  readonly playoffs: {
    readonly allMatches: readonly SeasonMatchView[];
    readonly userMatches: readonly SeasonMatchView[];
    readonly userResult: string;
  };
  readonly champion: { readonly teamId: string; readonly teamName: string; readonly isUser: boolean };
};
