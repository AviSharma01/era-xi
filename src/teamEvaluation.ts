import {
  type ClassicDraftState,
  type DraftSlot,
  type PositionFit,
  type Tier,
  XI_SIZE,
  getOverseasCount,
  getPositionFit,
  hasWicketkeeper,
} from "./draftClassic.js";

export const RATING_MIN = 30;
export const RATING_MAX = 83;
export const AGGREGATE_SHORTAGE_FLOOR = RATING_MIN;

export const NATURAL_POSITION_FIT_MULTIPLIER = 1;
export const ACCEPTABLE_POSITION_FIT_MULTIPLIER = 0.94;
export const OUT_OF_POSITION_DISTANCE_MULTIPLIERS = {
  1: 0.92,
  2: 0.86,
  3: 0.79,
  4: 0.7,
} as const;

export const POSITION_FIT_MULTIPLIERS: Record<"natural" | "acceptable", number> = {
  natural: NATURAL_POSITION_FIT_MULTIPLIER,
  acceptable: ACCEPTABLE_POSITION_FIT_MULTIPLIER,
};

export const BATTING_DEPENDENCE_BY_ROLE: Record<string, number> = {
  batter: 1,
  wicketkeeper_batter: 1,
  batting_all_rounder: 0.75,
  bowling_all_rounder: 0.35,
  bowler: 0.15,
};

export const TEAM_EVALUATION_WEIGHTS = {
  battingStrength: 0.8,
  battingDepth: 0.2,
  bowlingStrength: 0.8,
  bowlingDepth: 0.2,
  battingComposite: 0.5,
  bowlingComposite: 0.5,
} as const;

export type EvaluatedPlayerContribution = {
  slot: DraftSlot;
  positionFit: PositionFit;
  positionDistance: number;
  positionFitMultiplier: number;
  battingDependence: number;
  effectiveBattingRating: number | null;
  bowlingContribution: number | null;
  battingPenalty: number;
  effectivePlayerRating: number;
};

export type TeamEvaluation = {
  players: EvaluatedPlayerContribution[];
  averageBaseRating: number;
  averageEffectivePlayerRating: number;
  battingStrength: number;
  bowlingStrength: number;
  battingDepth: number;
  bowlingDepth: number;
  battingComposite: number;
  bowlingComposite: number;
  overallTeamRating: number;
  fitRating: number;
  tierCounts: Record<Tier, number>;
  positionFitCounts: Record<PositionFit, number>;
  bowlingOptionCounts: Record<"frontline" | "secondary" | "part_time", number>;
  overseasCount: number;
  hasWicketkeeper: boolean;
};

export function evaluateCompletedTeam(state: ClassicDraftState): TeamEvaluation {
  if (!state.completed || state.slots.length !== XI_SIZE) {
    throw new Error("Team evaluation requires a completed XI.");
  }

  const players = state.slots.map(evaluatePlayerContribution);
  const tierCounts: Record<Tier, number> = { S: 0, A: 0, B: 0, C: 0, D: 0 };
  const positionFitCounts: Record<PositionFit, number> = { natural: 0, acceptable: 0, out_of_position: 0 };
  const bowlingOptionCounts: Record<"frontline" | "secondary" | "part_time", number> = {
    frontline: 0,
    secondary: 0,
    part_time: 0,
  };

  for (const contribution of players) {
    tierCounts[contribution.slot.player.draftTier] += 1;
    positionFitCounts[contribution.positionFit] += 1;
    const bowlingStrength = contribution.slot.player.bowlingOptionStrength;
    if (bowlingStrength === "frontline" || bowlingStrength === "secondary" || bowlingStrength === "part_time") {
      bowlingOptionCounts[bowlingStrength] += 1;
    }
  }

  const battingStrength = averageTopValues(
    players.map((player) => player.effectiveBattingRating),
    7,
  );
  const bowlingStrength = averageTopValues(
    players.map((player) => player.bowlingContribution),
    5,
  );
  const battingDepth = average(
    players
      .filter((player) => player.slot.position >= 7)
      .map((player) => player.effectiveBattingRating ?? AGGREGATE_SHORTAGE_FLOOR),
  );
  const bowlingDepth = averageTopValues(
    players.map((player) => player.bowlingContribution),
    7,
    5,
  );
  const battingComposite =
    TEAM_EVALUATION_WEIGHTS.battingStrength * battingStrength +
    TEAM_EVALUATION_WEIGHTS.battingDepth * battingDepth;
  const bowlingComposite =
    TEAM_EVALUATION_WEIGHTS.bowlingStrength * bowlingStrength +
    TEAM_EVALUATION_WEIGHTS.bowlingDepth * bowlingDepth;
  const overallTeamRating = clamp(
    TEAM_EVALUATION_WEIGHTS.battingComposite * battingComposite +
      TEAM_EVALUATION_WEIGHTS.bowlingComposite * bowlingComposite,
    RATING_MIN,
    RATING_MAX,
  );

  return {
    players,
    averageBaseRating: average(players.map((player) => player.slot.player.baseRating)),
    averageEffectivePlayerRating: average(players.map((player) => player.effectivePlayerRating)),
    battingStrength,
    bowlingStrength,
    battingDepth,
    bowlingDepth,
    battingComposite,
    bowlingComposite,
    overallTeamRating,
    fitRating: calculateFitRating(players),
    tierCounts,
    positionFitCounts,
    bowlingOptionCounts,
    overseasCount: getOverseasCount(state),
    hasWicketkeeper: hasWicketkeeper(state),
  };
}

export function evaluatePlayerContribution(slot: DraftSlot): EvaluatedPlayerContribution {
  const positionFit = getPositionFit(slot.player, slot.position);
  const positionDistance = getMinimumNaturalPositionDistance(slot);
  const positionFitMultiplier = getPositionFitMultiplier(positionFit, positionDistance);
  const battingRating = slot.player.battingRating;
  const effectiveBattingRating =
    battingRating === null
      ? null
      : clamp(battingRating * positionFitMultiplier, RATING_MIN, RATING_MAX);
  const battingDependence = BATTING_DEPENDENCE_BY_ROLE[slot.player.seasonRole] ?? 1;
  let battingPenalty = 0;
  if (battingRating !== null && effectiveBattingRating !== null) {
    battingPenalty = (battingRating - effectiveBattingRating) * battingDependence;
  }

  return {
    slot,
    positionFit,
    positionDistance,
    positionFitMultiplier,
    battingDependence,
    effectiveBattingRating,
    bowlingContribution: slot.player.bowlingRating,
    battingPenalty,
    effectivePlayerRating: clamp(slot.player.baseRating - battingPenalty, RATING_MIN, RATING_MAX),
  };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function getMinimumNaturalPositionDistance(slot: DraftSlot): number {
  const distances = slot.player.naturalPositions.map((naturalPosition) =>
    getBattingPositionDistance(slot.position, naturalPosition),
  );
  if (distances.length === 0) {
    return 4;
  }
  return Math.min(...distances);
}

export function getBattingPositionDistance(left: number, right: number): number {
  return Math.abs(normalizeOpenerPosition(left) - normalizeOpenerPosition(right));
}

function getPositionFitMultiplier(positionFit: PositionFit, positionDistance: number): number {
  if (positionFit === "natural") {
    return NATURAL_POSITION_FIT_MULTIPLIER;
  }
  if (positionFit === "acceptable") {
    return ACCEPTABLE_POSITION_FIT_MULTIPLIER;
  }
  if (positionDistance <= 1) {
    return OUT_OF_POSITION_DISTANCE_MULTIPLIERS[1];
  }
  if (positionDistance === 2) {
    return OUT_OF_POSITION_DISTANCE_MULTIPLIERS[2];
  }
  if (positionDistance === 3) {
    return OUT_OF_POSITION_DISTANCE_MULTIPLIERS[3];
  }
  return OUT_OF_POSITION_DISTANCE_MULTIPLIERS[4];
}

function calculateFitRating(players: EvaluatedPlayerContribution[]): number {
  const averageMultiplier = average(players.map((player) => player.positionFitMultiplier));
  const fitRange = NATURAL_POSITION_FIT_MULTIPLIER - OUT_OF_POSITION_DISTANCE_MULTIPLIERS[4];
  const normalizedFit = (averageMultiplier - OUT_OF_POSITION_DISTANCE_MULTIPLIERS[4]) / fitRange;
  return clamp(RATING_MIN + (RATING_MAX - RATING_MIN) * normalizedFit, RATING_MIN, RATING_MAX);
}

function normalizeOpenerPosition(position: number): number {
  return position === 1 || position === 2 ? 2 : position;
}

function averageTopValues(values: (number | null)[], count: number, startIndex = 0): number {
  const sorted = values
    .filter((value): value is number => value !== null)
    .sort((left, right) => right - left);
  const selected = sorted.slice(startIndex, count);
  while (selected.length < count - startIndex) {
    selected.push(AGGREGATE_SHORTAGE_FLOOR);
  }
  return average(selected);
}

function average(values: number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}
