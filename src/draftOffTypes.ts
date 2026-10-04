import type { MatchResultV2 } from "./simulationV2.js";
import type { TeamEvaluationV2, EraId } from "./teamEvaluationV2.js";
import type { XiCompleteState } from "./eraDraftTypes.js";

export const DRAFT_OFF_VERSION = "ipl-draft-off/v1" as const;
export const DRAFT_OFF_SEED_VERSION = "ipl-draft-off-seeds/v1" as const;
export const DRAFT_OFF_SCHEDULE_VERSION = "ipl-draft-off-schedule/v1" as const;
export const DRAFT_OFF_XI_VARIANCE_VERSION = "ipl-draft-off-xi-variance/v1" as const;
export const DRAFT_OFF_MATCH_COUNT = 20 as const;
export const DRAFT_OFF_ENTRY_TEAM_ID = "draft-off-entry" as const;

export type DraftOffSeedBundle = {
  readonly version: typeof DRAFT_OFF_SEED_VERSION;
  readonly roundSeed: string;
  readonly draftRootSeed: string;
  readonly scheduleSeed: string;
};

export type DraftOffFixture = {
  readonly sequence: number;
  readonly cycleOrdinal: number;
  readonly matchId: string;
  readonly opponentProfileId: string;
  readonly scenarioSeed: string;
};

export type DraftOffSchedule = {
  readonly version: typeof DRAFT_OFF_SCHEDULE_VERSION;
  readonly eraId: EraId;
  readonly roundOrdinal: number;
  readonly scheduleSeed: string;
  readonly authoritativeOpponentProfileIds: readonly string[];
  readonly fixtures: readonly DraftOffFixture[];
  readonly scheduleHash: string;
};

export type DraftOffParticipantInput = {
  readonly participantId: string;
  readonly displayName: string;
  readonly xi: XiCompleteState;
};

export type DraftOffCampaignAggregate = {
  readonly played: number;
  readonly won: number;
  readonly lost: number;
  readonly points: number;
  readonly runsFor: number;
  readonly ballsFacedForNrr: number;
  readonly runsAgainst: number;
  readonly ballsBowledForNrr: number;
  readonly netRunRate: number;
};

export type DraftOffCampaignMatch = {
  readonly fixture: DraftOffFixture;
  readonly simulationSeed: string;
  readonly result: MatchResultV2;
};

export type DraftOffCampaignResult = {
  readonly participantId: string;
  readonly displayName: string;
  readonly submissionHash: string;
  readonly gameplayXiIdentity: string;
  readonly resultIdentityHash: string;
  readonly evaluation: TeamEvaluationV2;
  readonly scheduleHash: string;
  readonly matches: readonly DraftOffCampaignMatch[];
  readonly aggregate: DraftOffCampaignAggregate;
  readonly campaignHash: string;
};

export type DraftOffLeaderboardRow = DraftOffCampaignAggregate & {
  readonly rank: number;
  readonly participantId: string;
  readonly displayName: string;
  readonly submissionHash: string;
  readonly campaignHash: string;
};

export type DraftOffChallengeResult = {
  readonly version: typeof DRAFT_OFF_VERSION;
  readonly eraId: EraId;
  readonly roundOrdinal: number;
  readonly catalogFingerprint: string;
  readonly seeds: DraftOffSeedBundle;
  readonly schedule: DraftOffSchedule;
  readonly campaigns: readonly DraftOffCampaignResult[];
  readonly leaderboard: readonly DraftOffLeaderboardRow[];
  readonly resultHash: string;
};
