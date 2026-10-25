import type { DraftHistoricalStatsView, RevealPlayerView, TeamEvaluationSummaryView } from "./eraDraftTypes.js";
import type { EraId } from "./teamEvaluationV2.js";

export const DRAFT_OFF_RESULTS_MAX_BYTES = 2_097_152;

export type ResultsPlayerView = RevealPlayerView & Readonly<{ historicalStats: DraftHistoricalStatsView }>;
export type ResultsInningsView = Readonly<{
  side: "ENTRY" | "OPPONENT";
  runs: number;
  wickets: number;
  balls: number;
  allOut: boolean;
}>;
export type ResultsMatchView = Readonly<{
  matchId: string;
  sequence: number;
  opponent: Readonly<{ profileId: string; teamName: string; seasonYear: number }>;
  firstInnings: ResultsInningsView;
  secondInnings: ResultsInningsView;
  outcome: "WIN" | "LOSS";
}> & (Readonly<{ resultType: "runs" | "wickets"; margin: number }>
  | Readonly<{ resultType: "super_over"; margin: null }>);

export type ResultsAggregateView = Readonly<{
  played: number; won: number; lost: number; points: number;
  runsFor: number; ballsFacedForNrr: number;
  runsAgainst: number; ballsBowledForNrr: number; netRunRate: number;
}>;
/** Provider-independent view; no solo controller, simulation state or HTTP actor. */
export type DraftOffParticipantResultsView = Readonly<{
  roundId: string;
  roundOrdinal: number;
  eraId: EraId;
  participantId: string;
  displayName: string;
  players: readonly ResultsPlayerView[];
  evaluation: TeamEvaluationSummaryView;
  campaign: Readonly<{ aggregate: ResultsAggregateView; matches: readonly ResultsMatchView[] }>;
}>;
export type ResultsSuccess = Readonly<{ ok: true; version: 1; roomCode: string }> & DraftOffParticipantResultsView;
export type ResultsErrorCode = "INVALID_REQUEST" | "AUTHENTICATION_FAILED" | "ORIGIN_NOT_ALLOWED"
  | "NOT_FOUND" | "METHOD_NOT_ALLOWED" | "RESULTS_NOT_READY" | "RESULT_UNAVAILABLE"
  | "RATE_LIMITED" | "TEMPORARY_UNAVAILABLE" | "SERVICE_UNAVAILABLE";
export type ResultsFailure = Readonly<{ ok: false; error: Readonly<{ code: ResultsErrorCode; message: string }> }>;

export class DraftOffResultsError extends Error {
  constructor(readonly code: "AUTHENTICATION_FAILED" | "RESULTS_NOT_READY" | "RESULT_UNAVAILABLE") { super(code); }
}
