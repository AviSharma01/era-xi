import {
  RATING_MAX,
  TEAM_EVALUATION_WEIGHTS,
  type TeamEvaluation,
  clamp,
} from "./teamEvaluation.js";

export const TEAM_BOOST_V1_VERSION = "team-boost-v1" as const;

export const TEAM_BOOST_V1_CONSTANTS = {
  strongOpeningPair: {
    minimumIndividualEffectiveBattingRating: 60,
    minimumPairAverageEffectiveBattingRating: 65,
    battingCompositeBoost: 0.6,
  },
  sufficientBowlingCoverage: {
    minimumFrontlineOptions: 4,
    minimumCapacity: 5,
    frontlineCapacity: 1,
    secondaryCapacity: 0.5,
    partTimeCapacity: 0,
    bowlingCompositeBoost: 0.6,
  },
  balancedConstruction: {
    minimumBattingComposite: 60,
    minimumBowlingComposite: 60,
    maximumCompositeGap: 6,
    maximumOutOfPositionPlayers: 1,
    battingCompositeBoost: 0.4,
    bowlingCompositeBoost: 0.4,
  },
  caps: {
    maximumBattingCompositeBoost: 1,
    maximumBowlingCompositeBoost: 1,
    maximumOverallTeamRatingUplift: 1,
  },
} as const;

export type TeamBoostV1Id =
  | "strong_opening_pair"
  | "sufficient_bowling_coverage"
  | "balanced_construction";

export type TeamBoostV1Effect = {
  battingComposite: number;
  bowlingComposite: number;
};

export type AppliedTeamBoostV1 = {
  id: TeamBoostV1Id;
  label: string;
  explanation: string;
  effects: TeamBoostV1Effect;
  evidence: Record<string, string | number | boolean>;
};

export type BoostedTeamEvaluationV1 = {
  version: typeof TEAM_BOOST_V1_VERSION;
  baseTeamEvaluation: TeamEvaluation;
  appliedBoosts: AppliedTeamBoostV1[];
  rawBoostTotals: TeamBoostV1Effect;
  appliedBoostTotals: TeamBoostV1Effect & { overallTeamRating: number };
  adjustedBattingComposite: number;
  adjustedBowlingComposite: number;
  adjustedOverallTeamRating: number;
  capApplied: {
    battingComposite: boolean;
    bowlingComposite: boolean;
    overallTeamRating: boolean;
  };
  boostSummaryForUI: {
    headline: string;
    lines: string[];
    totalOverallEffect: number;
  };
};

export function applyTeamBoostsV1(baseTeamEvaluation: TeamEvaluation): BoostedTeamEvaluationV1 {
  const appliedBoosts: AppliedTeamBoostV1[] = [];
  const openingPair = getOpeningPairEvidence(baseTeamEvaluation);
  const bowlingCoverage = getBowlingCoverageEvidence(baseTeamEvaluation);

  if (openingPair.passes) {
    appliedBoosts.push({
      id: "strong_opening_pair",
      label: "Strong opening pair",
      explanation: "Both openers are well suited to the role and provide strong combined batting.",
      effects: {
        battingComposite: TEAM_BOOST_V1_CONSTANTS.strongOpeningPair.battingCompositeBoost,
        bowlingComposite: 0,
      },
      evidence: openingPair.evidence,
    });
  }

  if (bowlingCoverage.passes) {
    appliedBoosts.push({
      id: "sufficient_bowling_coverage",
      label: "Sufficient bowling coverage",
      explanation: "Four frontline bowlers plus enough support can cover a full innings.",
      effects: {
        battingComposite: 0,
        bowlingComposite: TEAM_BOOST_V1_CONSTANTS.sufficientBowlingCoverage.bowlingCompositeBoost,
      },
      evidence: bowlingCoverage.evidence,
    });
  }

  const compositeGap = Math.abs(baseTeamEvaluation.battingComposite - baseTeamEvaluation.bowlingComposite);
  if (
    baseTeamEvaluation.battingComposite >= TEAM_BOOST_V1_CONSTANTS.balancedConstruction.minimumBattingComposite &&
    baseTeamEvaluation.bowlingComposite >= TEAM_BOOST_V1_CONSTANTS.balancedConstruction.minimumBowlingComposite &&
    compositeGap <= TEAM_BOOST_V1_CONSTANTS.balancedConstruction.maximumCompositeGap &&
    baseTeamEvaluation.positionFitCounts.out_of_position <=
      TEAM_BOOST_V1_CONSTANTS.balancedConstruction.maximumOutOfPositionPlayers &&
    bowlingCoverage.passes
  ) {
    appliedBoosts.push({
      id: "balanced_construction",
      label: "Balanced construction",
      explanation: "The XI combines credible batting and bowling with a largely well-placed lineup.",
      effects: {
        battingComposite: TEAM_BOOST_V1_CONSTANTS.balancedConstruction.battingCompositeBoost,
        bowlingComposite: TEAM_BOOST_V1_CONSTANTS.balancedConstruction.bowlingCompositeBoost,
      },
      evidence: {
        baseBattingComposite: baseTeamEvaluation.battingComposite,
        baseBowlingComposite: baseTeamEvaluation.bowlingComposite,
        compositeGap,
        outOfPositionPlayers: baseTeamEvaluation.positionFitCounts.out_of_position,
        sufficientBowlingCoverage: bowlingCoverage.passes,
      },
    });
  }

  const rawBoostTotals = appliedBoosts.reduce<TeamBoostV1Effect>(
    (totals, boost) => ({
      battingComposite: totals.battingComposite + boost.effects.battingComposite,
      bowlingComposite: totals.bowlingComposite + boost.effects.bowlingComposite,
    }),
    { battingComposite: 0, bowlingComposite: 0 },
  );
  const battingBoost = Math.min(
    rawBoostTotals.battingComposite,
    TEAM_BOOST_V1_CONSTANTS.caps.maximumBattingCompositeBoost,
    RATING_MAX - baseTeamEvaluation.battingComposite,
  );
  const bowlingBoost = Math.min(
    rawBoostTotals.bowlingComposite,
    TEAM_BOOST_V1_CONSTANTS.caps.maximumBowlingCompositeBoost,
    RATING_MAX - baseTeamEvaluation.bowlingComposite,
  );
  const adjustedBattingComposite = baseTeamEvaluation.battingComposite + battingBoost;
  const adjustedBowlingComposite = baseTeamEvaluation.bowlingComposite + bowlingBoost;
  const uncappedOverallTeamRating = clamp(
    TEAM_EVALUATION_WEIGHTS.battingComposite * adjustedBattingComposite +
      TEAM_EVALUATION_WEIGHTS.bowlingComposite * adjustedBowlingComposite,
    baseTeamEvaluation.overallTeamRating,
    RATING_MAX,
  );
  const adjustedOverallTeamRating = Math.min(
    uncappedOverallTeamRating,
    baseTeamEvaluation.overallTeamRating + TEAM_BOOST_V1_CONSTANTS.caps.maximumOverallTeamRatingUplift,
    RATING_MAX,
  );
  const overallEffect = adjustedOverallTeamRating - baseTeamEvaluation.overallTeamRating;

  return {
    version: TEAM_BOOST_V1_VERSION,
    baseTeamEvaluation,
    appliedBoosts,
    rawBoostTotals,
    appliedBoostTotals: {
      battingComposite: battingBoost,
      bowlingComposite: bowlingBoost,
      overallTeamRating: overallEffect,
    },
    adjustedBattingComposite,
    adjustedBowlingComposite,
    adjustedOverallTeamRating,
    capApplied: {
      battingComposite: battingBoost < rawBoostTotals.battingComposite,
      bowlingComposite: bowlingBoost < rawBoostTotals.bowlingComposite,
      overallTeamRating: adjustedOverallTeamRating < uncappedOverallTeamRating,
    },
    boostSummaryForUI: {
      headline:
        appliedBoosts.length === 0
          ? "No team-construction boosts applied"
          : `${appliedBoosts.length} team-construction boost${appliedBoosts.length === 1 ? "" : "s"} applied`,
      lines: appliedBoosts.map((boost) => `${boost.label}: ${boost.explanation}`),
      totalOverallEffect: overallEffect,
    },
  };
}

function getOpeningPairEvidence(baseTeamEvaluation: TeamEvaluation): {
  passes: boolean;
  evidence: Record<string, string | number | boolean>;
} {
  const first = baseTeamEvaluation.players.find((player) => player.slot.position === 1);
  const second = baseTeamEvaluation.players.find((player) => player.slot.position === 2);
  const firstRating = first?.effectiveBattingRating ?? null;
  const secondRating = second?.effectiveBattingRating ?? null;
  const pairAverage = firstRating === null || secondRating === null ? null : (firstRating + secondRating) / 2;
  const bothInPosition = first?.positionFit !== "out_of_position" && second?.positionFit !== "out_of_position";
  const passes =
    firstRating !== null &&
    secondRating !== null &&
    firstRating >= TEAM_BOOST_V1_CONSTANTS.strongOpeningPair.minimumIndividualEffectiveBattingRating &&
    secondRating >= TEAM_BOOST_V1_CONSTANTS.strongOpeningPair.minimumIndividualEffectiveBattingRating &&
    pairAverage !== null &&
    pairAverage >= TEAM_BOOST_V1_CONSTANTS.strongOpeningPair.minimumPairAverageEffectiveBattingRating &&
    bothInPosition;

  return {
    passes,
    evidence: {
      openerOneEffectiveBattingRating: firstRating ?? "missing",
      openerTwoEffectiveBattingRating: secondRating ?? "missing",
      pairAverageEffectiveBattingRating: pairAverage ?? "missing",
      openerOnePositionFit: first?.positionFit ?? "missing",
      openerTwoPositionFit: second?.positionFit ?? "missing",
    },
  };
}

function getBowlingCoverageEvidence(baseTeamEvaluation: TeamEvaluation): {
  passes: boolean;
  evidence: Record<string, string | number | boolean>;
} {
  const { frontline, secondary, part_time: partTime } = baseTeamEvaluation.bowlingOptionCounts;
  const constants = TEAM_BOOST_V1_CONSTANTS.sufficientBowlingCoverage;
  const capacity =
    frontline * constants.frontlineCapacity +
    secondary * constants.secondaryCapacity +
    partTime * constants.partTimeCapacity;
  return {
    passes: frontline >= constants.minimumFrontlineOptions && capacity >= constants.minimumCapacity,
    evidence: {
      frontlineOptions: frontline,
      secondaryOptions: secondary,
      partTimeOptions: partTime,
      bowlingCapacity: capacity,
    },
  };
}
