import type {
  FitClassification,
  PlayerRoleConsumer,
} from "./playerRoleContract.js";
import type { PlayerQualityConsumer, QualityTier } from "./playerQualityContract.js";

export const TEAM_EVALUATION_V2_VERSION = "ipl-era-draft-team-evaluation/v2" as const;
export const STAGE_6_COMPONENT_FLOOR = 20;
export const BATTING_CORE_WEIGHT = 0.9;
export const BATTING_DEPTH_WEIGHT = 0.1;
export const MAX_TEAM_FIT_DEDUCTION = 4;
export const REQUIRED_BOWLING_UNITS = 5;
export const FULL_BOWLING_DEPLOYMENT_CAPACITY = 0.75;

export const ERA_IDS = [
  "era-foundation",
  "era-expansion",
  "era-transition",
  "era-modern-pre-impact",
  "era-impact",
] as const;

export type EraId = typeof ERA_IDS[number];
export type BattingPositionV2 = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;
export type IplRosterStatus = "INDIAN" | "OVERSEAS" | "UNKNOWN";

export type EraDefinitionV2 = {
  eraId: EraId;
  seasonIds: readonly string[];
};

export type EraXiPlayerInput = {
  position: BattingPositionV2;
  role: PlayerRoleConsumer;
  quality: PlayerQualityConsumer;
  rosterStatus: IplRosterStatus;
};

export type EraCompletedXiInput = {
  era: EraDefinitionV2;
  players: readonly EraXiPlayerInput[];
};

export type BattingContributionV2 = {
  position: BattingPositionV2;
  playerTeamSeasonId: string;
  playerId: string;
  rawRating: number;
  fitClassification: FitClassification;
  bandDistance: number | null;
  nominalFitDeduction: number;
  effectiveRatingBeforeTeamCap: number;
};

export type BowlingDeploymentContributionV2 = {
  playerTeamSeasonId: string;
  playerId: string;
  bowlingRating: number;
  bowlingCapacity: number;
  availableUnits: number;
  deployedUnits: number;
  weightedContribution: number;
};

export type TeamEvaluationV2 = {
  version: typeof TEAM_EVALUATION_V2_VERSION;
  eraId: EraId;
  players: readonly EraXiPlayerInput[];
  battingContributions: readonly BattingContributionV2[];
  bowlingDeployment: readonly BowlingDeploymentContributionV2[];
  baseStrength: {
    battingCore: number;
    battingDepth: number;
    batting: number;
    bowlingTopFiveBenchmark: number;
    bowling: number;
    overall: number;
  };
  adjustedStrength: {
    battingCoreBeforeTeamCap: number;
    battingDepthBeforeTeamCap: number;
    battingBeforeTeamCap: number;
    batting: number;
    bowling: number;
    overall: number;
  };
  diagnostics: {
    highestSevenBattingBenchmark: number;
    structuralBattingOrderEffect: number;
    rawPositionFitEffect: number;
    appliedPositionFitEffect: number;
    positionFitCapApplied: boolean;
    positionFitCounts: Record<FitClassification, number>;
    battingEvidenceCounts: Record<"NONE" | "LIMITED" | "ESTABLISHED", number>;
    bowlingEvidenceCounts: Record<"NONE" | "LIMITED" | "ESTABLISHED", number>;
    tierCounts: Record<QualityTier, number>;
    bowlingCapacity: number;
    normalizedBowlingUnitsAvailable: number;
    deployedBowlingUnits: number;
    uncoveredBowlingUnits: number;
    bowlingDeploymentEffect: number;
    bowlingWorkloadCounts: Record<"NONE" | "OCCASIONAL" | "SUPPORT" | "FRONTLINE", number>;
    bowlingFamilyCapacity: Record<"PACE" | "SPIN" | "UNKNOWN", number>;
    phaseBowlingCapacity: Record<"powerplay" | "middle" | "death", number>;
    overseasCount: number;
    hasWicketkeeper: boolean;
  };
  effects: readonly [{
    id: "batting_position_fit";
    component: "batting";
    rawValue: number;
    appliedValue: number;
    cap: number;
    capApplied: boolean;
  }];
};

export function evaluateCompletedEraXi(input: EraCompletedXiInput): TeamEvaluationV2 {
  const players = validateAndOrderXi(input);
  const rawBattingRatings = players.map((player) => player.quality.batting.battingRating ?? STAGE_6_COMPONENT_FLOOR);
  const battingContributions = players.map(buildBattingContribution);
  const fittedRatings = battingContributions.map((player) => player.effectiveRatingBeforeTeamCap);

  const battingCore = mean(rawBattingRatings.slice(0, 7));
  const battingDepth = mean(rawBattingRatings.slice(7));
  const baseBatting = weightedBatting(battingCore, battingDepth);
  const fittedCore = mean(fittedRatings.slice(0, 7));
  const fittedDepth = mean(fittedRatings.slice(7));
  const battingBeforeTeamCap = weightedBatting(fittedCore, fittedDepth);
  const rawPositionFitEffect = battingBeforeTeamCap - baseBatting;
  const appliedPositionFitEffect = Math.max(-MAX_TEAM_FIT_DEDUCTION, rawPositionFitEffect);
  const adjustedBatting = baseBatting + appliedPositionFitEffect;

  const bowlingRatings = players
    .filter((player) => player.quality.bowling.bowlingRating !== null)
    .map((player) => player.quality.bowling.bowlingRating as number)
    .sort((left, right) => right - left);
  const topFive = bowlingRatings.slice(0, REQUIRED_BOWLING_UNITS);
  while (topFive.length < REQUIRED_BOWLING_UNITS) topFive.push(STAGE_6_COMPONENT_FLOOR);
  const bowlingTopFiveBenchmark = mean(topFive);
  const { contributions: bowlingDeployment, uncoveredUnits, totalAvailableUnits } = deployBowling(players);
  const adjustedBowling = (
    bowlingDeployment.reduce((sum, player) => sum + player.weightedContribution, 0)
    + uncoveredUnits * STAGE_6_COMPONENT_FLOOR
  ) / REQUIRED_BOWLING_UNITS;

  const baseOverall = mean([baseBatting, adjustedBowling]);
  const adjustedOverall = mean([adjustedBatting, adjustedBowling]);
  const positionFitCounts = countValues(
    battingContributions.map((player) => player.fitClassification),
    ["NATURAL", "ACCEPTABLE", "OUT_OF_ROLE", "UNKNOWN"] as const,
  );
  const tierCounts = countValues(
    players.map((player) => player.quality.overall.qualityTier),
    ["S", "A", "B", "C", "D"] as const,
  );
  const battingEvidenceCounts = countValues(
    players.map((player) => player.quality.batting.evidenceState),
    ["NONE", "LIMITED", "ESTABLISHED"] as const,
  );
  const bowlingEvidenceCounts = countValues(
    players.map((player) => player.quality.bowling.evidenceState),
    ["NONE", "LIMITED", "ESTABLISHED"] as const,
  );
  const bowlingWorkloadCounts = countValues(
    players.map((player) => player.role.bowlingWorkloadClass),
    ["NONE", "OCCASIONAL", "SUPPORT", "FRONTLINE"] as const,
  );

  return {
    version: TEAM_EVALUATION_V2_VERSION,
    eraId: input.era.eraId,
    players,
    battingContributions,
    bowlingDeployment,
    baseStrength: {
      battingCore,
      battingDepth,
      batting: baseBatting,
      bowlingTopFiveBenchmark,
      bowling: adjustedBowling,
      overall: baseOverall,
    },
    adjustedStrength: {
      battingCoreBeforeTeamCap: fittedCore,
      battingDepthBeforeTeamCap: fittedDepth,
      battingBeforeTeamCap,
      batting: adjustedBatting,
      bowling: adjustedBowling,
      overall: adjustedOverall,
    },
    diagnostics: {
      highestSevenBattingBenchmark: mean([...rawBattingRatings].sort((left, right) => right - left).slice(0, 7)),
      structuralBattingOrderEffect:
        baseBatting - mean([...rawBattingRatings].sort((left, right) => right - left).slice(0, 7)),
      rawPositionFitEffect,
      appliedPositionFitEffect,
      positionFitCapApplied: appliedPositionFitEffect !== rawPositionFitEffect,
      positionFitCounts,
      battingEvidenceCounts,
      bowlingEvidenceCounts,
      tierCounts,
      bowlingCapacity: players.reduce((sum, player) => sum + player.role.bowlingCapacity, 0),
      normalizedBowlingUnitsAvailable: totalAvailableUnits,
      deployedBowlingUnits: REQUIRED_BOWLING_UNITS - uncoveredUnits,
      uncoveredBowlingUnits: uncoveredUnits,
      bowlingDeploymentEffect: adjustedBowling - bowlingTopFiveBenchmark,
      bowlingWorkloadCounts,
      bowlingFamilyCapacity: calculateFamilyCapacity(players),
      phaseBowlingCapacity: calculatePhaseCapacity(players),
      overseasCount: players.filter((player) => player.rosterStatus === "OVERSEAS").length,
      hasWicketkeeper: players.some((player) => player.role.keeperMetadata.capabilityStatus === "CONFIRMED"),
    },
    effects: [{
      id: "batting_position_fit",
      component: "batting",
      rawValue: rawPositionFitEffect,
      appliedValue: appliedPositionFitEffect,
      cap: MAX_TEAM_FIT_DEDUCTION,
      capApplied: appliedPositionFitEffect !== rawPositionFitEffect,
    }],
  };
}

export function getPositionFitDeduction(
  classification: FitClassification,
  bandDistance: number | null,
): number {
  if (classification === "NATURAL" || classification === "UNKNOWN") return 0;
  if (classification === "ACCEPTABLE") return 1;
  if (bandDistance === null) throw new Error("OUT_OF_ROLE batting fit requires a band distance.");
  return Math.min(6, 2 + bandDistance);
}

function validateAndOrderXi(input: EraCompletedXiInput): EraXiPlayerInput[] {
  if (!ERA_IDS.includes(input.era.eraId) || input.era.seasonIds.length === 0) {
    throw new Error("Team Evaluation V2 requires a supported non-empty era definition.");
  }
  if (input.players.length !== 11) throw new Error("Team Evaluation V2 requires exactly 11 players.");
  const players = [...input.players].sort((left, right) => left.position - right.position);
  if (players.some((player, index) => player.position !== index + 1)) {
    throw new Error("Team Evaluation V2 requires batting positions 1-11 exactly once.");
  }
  if (new Set(players.map((player) => player.quality.playerTeamSeasonId)).size !== 11) {
    throw new Error("Team Evaluation V2 requires unique player-team-season IDs.");
  }
  if (new Set(players.map((player) => player.quality.playerId)).size !== 11) {
    throw new Error("Team Evaluation V2 does not allow duplicate canonical players.");
  }
  for (const player of players) {
    const role = player.role;
    const quality = player.quality;
    if (
      role.playerTeamSeasonId !== quality.playerTeamSeasonId
      || role.playerId !== quality.playerId
      || role.seasonId !== quality.seasonId
      || role.teamId !== quality.teamId
      || role.franchiseId !== quality.franchiseId
    ) {
      throw new Error(`Stage 5/6 identity mismatch for ${quality.playerTeamSeasonId}.`);
    }
    if (!input.era.seasonIds.includes(quality.seasonId)) {
      throw new Error(`${quality.playerTeamSeasonId} does not belong to ${input.era.eraId}.`);
    }
    if (player.rosterStatus === "UNKNOWN") {
      throw new Error(`${quality.playerTeamSeasonId} has UNKNOWN IPL roster status.`);
    }
  }
  if (players.filter((player) => player.rosterStatus === "OVERSEAS").length > 4) {
    throw new Error("Team Evaluation V2 permits at most four overseas players.");
  }
  if (!players.some((player) => player.role.keeperMetadata.capabilityStatus === "CONFIRMED")) {
    throw new Error("Team Evaluation V2 requires a confirmed wicketkeeper capability.");
  }
  return players;
}

function buildBattingContribution(player: EraXiPlayerInput): BattingContributionV2 {
  const slotFit = player.role.battingFit.slots[player.position - 1];
  if (!slotFit || slotFit.position !== player.position) {
    throw new Error(`Missing Stage 5 batting fit for ${player.quality.playerTeamSeasonId} at ${player.position}.`);
  }
  const rawRating = player.quality.batting.battingRating ?? STAGE_6_COMPONENT_FLOOR;
  const nominalFitDeduction = getPositionFitDeduction(slotFit.classification, slotFit.bandDistance);
  return {
    position: player.position,
    playerTeamSeasonId: player.quality.playerTeamSeasonId,
    playerId: player.quality.playerId,
    rawRating,
    fitClassification: slotFit.classification,
    bandDistance: slotFit.bandDistance,
    nominalFitDeduction,
    effectiveRatingBeforeTeamCap: Math.max(STAGE_6_COMPONENT_FLOOR, rawRating - nominalFitDeduction),
  };
}

function deployBowling(players: readonly EraXiPlayerInput[]): {
  contributions: BowlingDeploymentContributionV2[];
  uncoveredUnits: number;
  totalAvailableUnits: number;
} {
  const eligible = players
    .filter((player) => player.quality.bowling.bowlingRating !== null)
    .map((player) => ({
      player,
      rating: player.quality.bowling.bowlingRating as number,
      availableUnits: Math.min(1, player.role.bowlingCapacity / FULL_BOWLING_DEPLOYMENT_CAPACITY),
    }))
    .sort((left, right) =>
      right.rating - left.rating || left.player.quality.playerId.localeCompare(right.player.quality.playerId));
  const totalAvailableUnits = eligible.reduce((sum, player) => sum + player.availableUnits, 0);
  let remaining = REQUIRED_BOWLING_UNITS;
  const contributions: BowlingDeploymentContributionV2[] = [];
  for (const candidate of eligible) {
    const deployedUnits = Math.min(remaining, candidate.availableUnits);
    if (deployedUnits > 0) {
      contributions.push({
        playerTeamSeasonId: candidate.player.quality.playerTeamSeasonId,
        playerId: candidate.player.quality.playerId,
        bowlingRating: candidate.rating,
        bowlingCapacity: candidate.player.role.bowlingCapacity,
        availableUnits: candidate.availableUnits,
        deployedUnits,
        weightedContribution: deployedUnits * candidate.rating,
      });
      remaining -= deployedUnits;
    }
    if (remaining <= Number.EPSILON) break;
  }
  return { contributions, uncoveredUnits: Math.max(0, remaining), totalAvailableUnits };
}

function calculateFamilyCapacity(
  players: readonly EraXiPlayerInput[],
): Record<"PACE" | "SPIN" | "UNKNOWN", number> {
  const result = { PACE: 0, SPIN: 0, UNKNOWN: 0 };
  for (const player of players) {
    const capacity = player.role.bowlingCapacity;
    if (player.role.bowlingFamily === "MIXED") {
      result.PACE += capacity / 2;
      result.SPIN += capacity / 2;
    } else {
      result[player.role.bowlingFamily] += capacity;
    }
  }
  return result;
}

function calculatePhaseCapacity(
  players: readonly EraXiPlayerInput[],
): Record<"powerplay" | "middle" | "death", number> {
  const result = { powerplay: 0, middle: 0, death: 0 };
  for (const player of players) {
    for (const phase of ["powerplay", "middle", "death"] as const) {
      result[phase] += player.role.bowlingCapacity * (player.role.phaseBowlingUsage[phase].share ?? 0);
    }
  }
  return result;
}

function weightedBatting(core: number, depth: number): number {
  return BATTING_CORE_WEIGHT * core + BATTING_DEPTH_WEIGHT * depth;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) throw new Error("Cannot average an empty collection.");
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function countValues<const T extends string>(values: readonly T[], keys: readonly T[]): Record<T, number> {
  const counts = Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
  for (const value of values) counts[value] += 1;
  return counts;
}
