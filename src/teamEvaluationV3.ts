import type { FitClassification } from "./playerRoleContract.js";
import {
  BATTING_CORE_WEIGHT, BATTING_DEPTH_WEIGHT, STAGE_6_COMPONENT_FLOOR,
  evaluateCompletedEraXi, type BattingPositionV2, type EraCompletedXiInput, type TeamEvaluationV2,
} from "./teamEvaluationV2.js";

export const TEAM_EVALUATION_V3_VERSION = "ipl-era-draft-team-evaluation/v3" as const;
export const POSITION_PENALTY_PERCENT = Object.freeze({
  NATURAL: 0, ACCEPTABLE: 5, MODERATE: 12, MAJOR: 20, EXTREME: 30, UNKNOWN: 0,
} as const);
export type PositionPenaltySeverity = keyof typeof POSITION_PENALTY_PERCENT;

export function positionPenaltySeverity(classification: FitClassification, distance: number | null): PositionPenaltySeverity {
  if (classification === "UNKNOWN" && distance === null) return "UNKNOWN";
  if (classification === "NATURAL" && distance === 0) return "NATURAL";
  if (classification === "ACCEPTABLE" && Number.isInteger(distance) && distance !== null && distance >= 1 && distance <= 4) return "ACCEPTABLE";
  if (classification === "OUT_OF_ROLE") {
    if (distance === 2) return "MODERATE";
    if (distance === 3) return "MAJOR";
    if (distance === 4) return "EXTREME";
  }
  throw new Error(`Invalid V3 batting fit ${classification}/${distance}.`);
}

/** Contribution diagnostics, also safe to project after reveal/resolution. Percentages use 0–100 units. */
export type BattingAdjustmentV3 = {
  fitClassification: FitClassification;
  bandDistance: number | null;
  penaltySeverity: PositionPenaltySeverity;
  penaltyPercent: number;
  appliedPenaltyPercent: number;
  rawContribution: number;
  effectiveContribution: number;
  nominalDeduction: number;
  deduction: number;
  aggregationWeight: number;
  weightedDeduction: number;
  floorApplied: boolean;
  ratingImputed: boolean;
};
export type BattingContributionV3 = BattingAdjustmentV3 & {
  position: BattingPositionV2;
  playerTeamSeasonId: string;
  playerId: string;
};
export type TeamEvaluationV3 = Omit<TeamEvaluationV2, "version" | "battingContributions" | "adjustedStrength" | "diagnostics" | "effects"> & {
  version: typeof TEAM_EVALUATION_V3_VERSION;
  battingContributions: readonly BattingContributionV3[];
  adjustedStrength: { battingCore: number; battingDepth: number; batting: number; bowling: number; overall: number };
  diagnostics: Omit<TeamEvaluationV2["diagnostics"], "rawPositionFitEffect" | "appliedPositionFitEffect" | "positionFitCapApplied"> & {
    nominalPositionFitDeduction: number;
    appliedPositionFitDeduction: number;
    penaltySeverityCounts: Record<PositionPenaltySeverity, number>;
  };
  effects: readonly [{ id: "batting_position_fit"; component: "batting"; nominalValue: number; appliedValue: number }];
};

export function evaluateCompletedEraXiV3(input: EraCompletedXiInput): TeamEvaluationV3 {
  // V2 is frozen: reuse its identity/legality validation, base strengths and bowling deployment.
  // Its fitted contributions and capped batting outputs never enter V3 aggregation.
  const baseline = evaluateCompletedEraXi(input);
  const battingContributions = baseline.players.map((player): BattingContributionV3 => {
    const slot = player.role.battingFit.slots[player.position - 1]!;
    const penaltySeverity = positionPenaltySeverity(slot.classification, slot.bandDistance);
    const penaltyPercent = POSITION_PENALTY_PERCENT[penaltySeverity];
    const rawContribution = player.quality.batting.battingRating ?? STAGE_6_COMPONENT_FLOOR;
    const nominalContribution = rawContribution * (1 - penaltyPercent / 100);
    const effectiveContribution = Math.max(STAGE_6_COMPONENT_FLOOR, nominalContribution);
    const deduction = rawContribution - effectiveContribution;
    const aggregationWeight = player.position <= 7 ? BATTING_CORE_WEIGHT / 7 : BATTING_DEPTH_WEIGHT / 4;
    return {
      position: player.position, playerTeamSeasonId: player.quality.playerTeamSeasonId, playerId: player.quality.playerId,
      fitClassification: slot.classification, bandDistance: slot.bandDistance, penaltySeverity, penaltyPercent,
      appliedPenaltyPercent: deduction / rawContribution * 100,
      rawContribution, effectiveContribution, nominalDeduction: rawContribution - nominalContribution, deduction,
      aggregationWeight, weightedDeduction: deduction * aggregationWeight,
      floorApplied: effectiveContribution > nominalContribution,
      ratingImputed: player.quality.batting.battingRating === null,
    };
  });
  const mean = (rows: readonly BattingContributionV3[]) => rows.reduce((sum, row) => sum + row.effectiveContribution, 0) / rows.length;
  const battingCore = mean(battingContributions.slice(0, 7));
  const battingDepth = mean(battingContributions.slice(7));
  const batting = BATTING_CORE_WEIGHT * battingCore + BATTING_DEPTH_WEIGHT * battingDepth;
  const bowling = baseline.adjustedStrength.bowling;
  const nominalPositionFitDeduction = battingContributions.reduce((sum, row) => sum + row.nominalDeduction * row.aggregationWeight, 0);
  const appliedPositionFitDeduction = baseline.baseStrength.batting - batting;
  const { rawPositionFitEffect: _raw, appliedPositionFitEffect: _applied, positionFitCapApplied: _cap, ...diagnostics } = baseline.diagnostics;
  const penaltySeverityCounts = Object.fromEntries(Object.keys(POSITION_PENALTY_PERCENT).map(key => [key, 0])) as Record<PositionPenaltySeverity, number>;
  for (const row of battingContributions) penaltySeverityCounts[row.penaltySeverity] += 1;
  return {
    version: TEAM_EVALUATION_V3_VERSION, eraId: baseline.eraId, players: baseline.players,
    battingContributions, bowlingDeployment: baseline.bowlingDeployment, baseStrength: baseline.baseStrength,
    adjustedStrength: { battingCore, battingDepth, batting, bowling, overall: (batting + bowling) / 2 },
    diagnostics: { ...diagnostics, nominalPositionFitDeduction, appliedPositionFitDeduction, penaltySeverityCounts },
    effects: [{ id: "batting_position_fit", component: "batting", nominalValue: -nominalPositionFitDeduction, appliedValue: -appliedPositionFitDeduction }],
  };
}
