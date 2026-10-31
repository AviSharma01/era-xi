import { POSITION_PENALTY_PERCENT, positionPenaltySeverity, TEAM_EVALUATION_V3_VERSION } from "./teamEvaluationV3.js";
import type { FitClassification } from "./playerRoleContract.js";
import { BOWLING_FAMILIES, BOWLING_WORKLOAD_CLASSES, DERIVED_ROLES, KEEPER_STATUSES } from "./playerRoleContract.js";
import { ERA_IDS } from "./teamEvaluationV2.js";
import type { ResultsSuccess } from "./draftOffResultsTypes.js";

export class ResultsClientError extends Error {
  constructor(readonly code: string) { super(code); }
}
const invalid = (): never => { throw new ResultsClientError("INVALID_RESULTS_RESPONSE"); };
function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== fields.length || fields.some(key => !Object.hasOwn(row, key))) return invalid();
  return row;
}
function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value || value !== value.trim() || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) invalid();
}
function number(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) invalid();
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  number(value, min, max); if (!Number.isSafeInteger(value)) invalid();
}
function nullable(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER) { if (value !== null) number(value, min, max); }
function oneOf(value: unknown, values: readonly unknown[]) { if (!values.includes(value)) invalid(); }
function bool(value: unknown) { if (typeof value !== "boolean") invalid(); }
function list(value: unknown, length: number): unknown[] {
  if (!Array.isArray(value) || value.length !== length) return invalid(); return value;
}
const tiers = ["S", "A", "B", "C", "D"] as const;
const fits = ["NATURAL", "ACCEPTABLE", "STRETCH", "MAJOR_STRETCH", "UNKNOWN"] as const;
const battingFields = ["innings", "runs", "average", "strikeRate"];
const bowlingFields = ["innings", "wickets", "legalBalls", "economy"];
const peakFields = ["seasonId", "seasonYear", "teamId", "teamName", "playerTeamSeasonId"];
function stats(value: unknown, bowling: boolean, peak = false) {
  const row = object(value, [...(bowling ? bowlingFields : battingFields), ...(peak ? peakFields : [])]);
  integer(row.innings);
  if (bowling) { integer(row.wickets); integer(row.legalBalls); nullable(row.economy); }
  else { integer(row.runs); nullable(row.average); nullable(row.strikeRate); }
  if (peak) {
    integer(row.seasonYear, 1);
    for (const key of peakFields.filter(key => key !== "seasonYear")) text(row[key]);
  }
}
function historical(value: unknown) {
  const row = object(value, ["currentSeason", "eraBest"]);
  const current = object(row.currentSeason, ["batting", "bowling"]), best = object(row.eraBest, ["batting", "bowling"]);
  stats(current.batting, false); stats(current.bowling, true);
  if (best.batting !== null) stats(best.batting, false, true);
  if (best.bowling !== null) stats(best.bowling, true, true);
}
function counts(value: unknown, fields: readonly string[]) {
  const row = object(value, fields); fields.forEach(key => integer(row[key], 0, 11));
  if (fields.reduce((sum, key) => sum + (row[key] as number), 0) !== 11) invalid();
  return row;
}
function innings(value: unknown) {
  const row = object(value, ["side", "runs", "wickets", "balls", "allOut"]);
  oneOf(row.side, ["ENTRY", "OPPONENT"]); integer(row.runs); integer(row.wickets, 0, 10); integer(row.balls, 0, 120); bool(row.allOut);
  if (row.allOut !== (row.wickets === 10)) invalid();
  return row;
}

export type ResultsIdentity = Pick<ResultsSuccess, "roomCode" | "roundId" | "roundOrdinal" | "eraId" | "participantId">;
/** Exact recursive allowlist. No room revision: resolved content is immutable within this identity. */
export function parseDraftOffResults(value: unknown, expected: ResultsIdentity): ResultsSuccess {
  const row = object(value, ["ok", "version", "roomCode", "roundId", "roundOrdinal", "eraId", "participantId", "displayName", "players", "evaluation", "campaign"]);
  if (row.ok !== true || (row.version !== 1 && row.version !== 2)) invalid();
  const v3 = row.version === 2;
  for (const key of ["roomCode", "roundId", "participantId", "displayName"]) text(row[key]);
  if (!/^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{12}$/.test(row.roomCode as string)
    || !/^p_[a-f0-9]{32}$/.test(row.participantId as string) || [...row.displayName as string].length > 64) invalid();
  integer(row.roundOrdinal, 1); oneOf(row.eraId, ERA_IDS);
  for (const key of ["roomCode", "roundId", "roundOrdinal", "eraId", "participantId"] as const) if (row[key] !== expected[key]) invalid();
  const players = list(row.players, 11).map((value, index) => {
    const p = object(value, ["playerTeamSeasonId", "playerId", "playerName", "seasonId", "seasonYear", "teamId", "teamName", "franchiseId", "franchiseName",
      "rosterStatus", "keeperCapability", "derivedRole", "displayRole", "bowlingWorkloadClass", "bowlingFamily", "battingPosition", "presentationFit",
      "battingRating", "bowlingRating", "overallRating", "qualityTier", "historicalStats", ...(v3 ? ["battingAdjustment"] : [])]);
    for (const key of ["playerTeamSeasonId", "playerId", "playerName", "seasonId", "teamId", "teamName", "franchiseId", "franchiseName"]) text(p[key]);
    integer(p.seasonYear, 1); if (p.battingPosition !== index + 1) invalid();
    oneOf(p.rosterStatus, ["INDIAN", "OVERSEAS"]); oneOf(p.keeperCapability, KEEPER_STATUSES);
    oneOf(p.derivedRole, DERIVED_ROLES); oneOf(p.displayRole, DERIVED_ROLES);
    oneOf(p.bowlingWorkloadClass, BOWLING_WORKLOAD_CLASSES); oneOf(p.bowlingFamily, BOWLING_FAMILIES);
    oneOf(p.presentationFit, fits); oneOf(p.qualityTier, tiers);
    nullable(p.battingRating, 20, 100); nullable(p.bowlingRating, 20, 100); number(p.overallRating, 20, 100); historical(p.historicalStats);
    if (v3) validateBattingAdjustment(p.battingAdjustment, p.battingRating as number | null, index + 1, p.presentationFit);
    return p;
  });
  if (new Set(players.map(p => p.playerId)).size !== 11 || new Set(players.map(p => p.playerTeamSeasonId)).size !== 11) invalid();
  const evaluation = object(row.evaluation, ["strength", "tierCounts", "fitCounts", "construction", ...(v3 ? ["teamEvaluationVersion", "battingAdjustment"] : [])]);
  const strength = object(evaluation.strength, ["overall", "batting", "bowling"]);
  Object.values(strength).forEach(value => number(value, 20, 100));
  if (v3) {
    if (evaluation.teamEvaluationVersion !== TEAM_EVALUATION_V3_VERSION) invalid();
    const adjustment = object(evaluation.battingAdjustment, ["baseBatting", "nominalDeduction", "appliedDeduction", "adjustedBatting"]);
    Object.values(adjustment).forEach(value => number(value));
    const rows = players.map(player => player.battingAdjustment as Record<string, number>);
    const weighted = (key: string) => rows.reduce((sum, row) => sum + row[key] * row.aggregationWeight, 0);
    close(adjustment.baseBatting, weighted("rawContribution"));
    close(adjustment.nominalDeduction, weighted("nominalDeduction"));
    close(adjustment.appliedDeduction, weighted("deduction"));
    close(adjustment.adjustedBatting, weighted("effectiveContribution"));
    close(strength.batting, adjustment.adjustedBatting as number);
    close(strength.overall, ((strength.batting as number) + (strength.bowling as number)) / 2);
  }
  const tierCounts = counts(evaluation.tierCounts, tiers), fitCounts = counts(evaluation.fitCounts, fits);
  for (const tier of tiers) if (tierCounts[tier] !== players.filter(p => p.qualityTier === tier).length) invalid();
  for (const fit of fits) if (fitCounts[fit] !== players.filter(p => p.presentationFit === fit).length) invalid();
  const c = object(evaluation.construction, ["overseasCount", "overseasLimit", "hasWicketkeeper", "deployedBowlingUnits", "requiredBowlingUnits", "frontlineBowlers", "supportBowlers"]);
  integer(c.overseasCount, 0, 4); integer(c.frontlineBowlers, 0, 11); integer(c.supportBowlers, 0, 11); number(c.deployedBowlingUnits, 0, 5);
  if (c.overseasLimit !== 4 || c.requiredBowlingUnits !== 5 || c.hasWicketkeeper !== true
    || c.overseasCount !== players.filter(p => p.rosterStatus === "OVERSEAS").length || !players.some(p => p.keeperCapability === "CONFIRMED")
    || c.frontlineBowlers !== players.filter(p => p.bowlingWorkloadClass === "FRONTLINE").length
    || c.supportBowlers !== players.filter(p => p.bowlingWorkloadClass === "SUPPORT").length) invalid();
  const campaign = object(row.campaign, ["aggregate", "matches"]);
  const a = object(campaign.aggregate, ["played", "won", "lost", "points", "runsFor", "ballsFacedForNrr", "runsAgainst", "ballsBowledForNrr", "netRunRate"]);
  if (a.played !== 20) invalid();
  integer(a.won, 0, 20); integer(a.lost, 0, 20); integer(a.points, 0, 40);
  if (a.won + a.lost !== 20 || a.points !== a.won * 2) invalid();
  integer(a.runsFor); integer(a.runsAgainst); integer(a.ballsFacedForNrr, 1, 2400); integer(a.ballsBowledForNrr, 1, 2400);
  number(a.netRunRate, -Number.MAX_VALUE, Number.MAX_VALUE);
  const matches = list(campaign.matches, 20).map((value, index) => {
    const m = object(value, ["matchId", "sequence", "opponent", "firstInnings", "secondInnings", "outcome", "resultType", "margin"]);
    text(m.matchId); if (m.sequence !== index + 1) invalid();
    const opponent = object(m.opponent, ["profileId", "teamName", "seasonYear"]);
    text(opponent.profileId); text(opponent.teamName); integer(opponent.seasonYear, 1);
    const first = innings(m.firstInnings), second = innings(m.secondInnings);
    if (first.side === second.side) invalid();
    oneOf(m.outcome, ["WIN", "LOSS"]); oneOf(m.resultType, ["runs", "wickets", "super_over"]);
    if (m.resultType === "super_over") { if (m.margin !== null || first.runs !== second.runs) invalid(); }
    else {
      integer(m.margin, 1, m.resultType === "wickets" ? 10 : Number.MAX_SAFE_INTEGER);
      const firstWon = m.resultType === "runs";
      if (m.outcome !== ((firstWon ? first.side : second.side) === "ENTRY" ? "WIN" : "LOSS")
        || m.margin !== (firstWon ? (first.runs as number) - (second.runs as number) : 10 - (second.wickets as number))) invalid();
    }
    return m;
  });
  if (new Set(matches.map(m => m.matchId)).size !== 20 || matches.filter(m => m.outcome === "WIN").length !== a.won) invalid();
  return freezeDeep(value as ResultsSuccess);
}

const errors: Record<number, readonly string[]> = {
  400: ["INVALID_REQUEST"], 401: ["AUTHENTICATION_FAILED"], 403: ["ORIGIN_NOT_ALLOWED"],
  404: ["NOT_FOUND", "RESULT_UNAVAILABLE"], 405: ["METHOD_NOT_ALLOWED"], 409: ["RESULTS_NOT_READY"],
  429: ["RATE_LIMITED"], 503: ["TEMPORARY_UNAVAILABLE", "SERVICE_UNAVAILABLE"],
};
export async function fetchDraftOffResults(options: {
  apiOrigin: string; credential: string; identity: ResultsIdentity; transport: typeof fetch; signal?: AbortSignal;
}): Promise<ResultsSuccess> {
  const { roomCode, participantId } = options.identity;
  const reply = await options.transport(new URL(`/api/draft-off/v1/rooms/${encodeURIComponent(roomCode)}/results/${encodeURIComponent(participantId)}`, options.apiOrigin), {
    method: "GET", headers: { Authorization: `Bearer ${options.credential}` }, signal: options.signal,
  });
  if (reply.status === 401) throw new ResultsClientError("AUTHENTICATION_FAILED");
  const body: unknown = await reply.json();
  if (reply.status === 200) return parseDraftOffResults(body, options.identity);
  const failure = object(body, ["ok", "error"]), error = object(failure.error, ["code", "message"]);
  if (failure.ok !== false || !errors[reply.status]?.includes(error.code as string)) invalid();
  text(error.message);
  throw new ResultsClientError(error.code as string);
}
function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.values(value).forEach(freezeDeep); Object.freeze(value); }
  return value;
}

function close(actual: unknown, expected: number): void {
  if (typeof actual !== "number" || !Number.isFinite(actual) || Math.abs(actual - expected) > 1e-9) invalid();
}
function validateBattingAdjustment(value: unknown, battingRating: number | null, position: number, presentationFit: unknown): void {
  const row = object(value, ["fitClassification", "bandDistance", "penaltySeverity", "penaltyPercent", "appliedPenaltyPercent",
    "rawContribution", "effectiveContribution", "nominalDeduction", "deduction", "aggregationWeight", "weightedDeduction", "floorApplied", "ratingImputed"]);
  oneOf(row.fitClassification, ["NATURAL", "ACCEPTABLE", "OUT_OF_ROLE", "UNKNOWN"]);
  let severity: keyof typeof POSITION_PENALTY_PERCENT;
  try { severity = positionPenaltySeverity(row.fitClassification as FitClassification, row.bandDistance as number | null); }
  catch { return invalid(); }
  const expectedFit = severity === "MODERATE" ? "STRETCH" : severity === "MAJOR" || severity === "EXTREME" ? "MAJOR_STRETCH" : severity;
  if (presentationFit !== expectedFit) invalid();
  const percent = POSITION_PENALTY_PERCENT[severity];
  if (row.penaltySeverity !== severity || row.penaltyPercent !== percent) invalid();
  const raw = battingRating ?? 20, nominal = raw * (1 - percent / 100), effective = Math.max(20, nominal);
  const deduction = raw - effective, weight = position <= 7 ? 0.9 / 7 : 0.1 / 4;
  close(row.rawContribution, raw); close(row.effectiveContribution, effective);
  close(row.nominalDeduction, raw - nominal); close(row.deduction, deduction);
  close(row.appliedPenaltyPercent, deduction / raw * 100);
  close(row.aggregationWeight, weight); close(row.weightedDeduction, deduction * weight);
  if (row.floorApplied !== (effective > nominal) || row.ratingImputed !== (battingRating === null)) invalid();
}
