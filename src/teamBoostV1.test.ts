import test from "node:test";
import assert from "node:assert/strict";
import type { BattingPosition, DraftPlayerSeason, PositionFit } from "./draftClassic.js";
import { applyTeamBoostsV1 } from "./teamBoostV1.js";
import type { EvaluatedPlayerContribution, TeamEvaluation } from "./teamEvaluation.js";

test("strong opening pair passes at the exact individual and pair-average boundaries", () => {
  const result = applyTeamBoostsV1(evaluation({ openerRatings: [60, 70] }));

  assert.deepEqual(boostIds(result), ["strong_opening_pair"]);
  assert.equal(result.rawBoostTotals.battingComposite, 0.6);
  assert.equal(result.adjustedBattingComposite, 60.6);
});

test("strong opening pair fails below either rating boundary", () => {
  assert.deepEqual(boostIds(applyTeamBoostsV1(evaluation({ openerRatings: [59.99, 80] }))), []);
  assert.deepEqual(boostIds(applyTeamBoostsV1(evaluation({ openerRatings: [60, 69.99] }))), []);
});

test("strong opening pair fails for a missing rating or out-of-position opener", () => {
  assert.deepEqual(boostIds(applyTeamBoostsV1(evaluation({ openerRatings: [null, 75] }))), []);
  assert.deepEqual(
    boostIds(applyTeamBoostsV1(evaluation({ openerRatings: [65, 65], openerFits: ["out_of_position", "natural"] }))),
    [],
  );
});

test("bowling coverage passes with four frontline and two secondary options", () => {
  const result = applyTeamBoostsV1(evaluation({ bowlingCounts: [4, 2, 0] }));

  assert.deepEqual(boostIds(result), ["sufficient_bowling_coverage", "balanced_construction"]);
  assert.equal(result.appliedBoosts[0]?.evidence.bowlingCapacity, 5);
});

test("bowling coverage rejects insufficient capacity and ignores part-time options", () => {
  assert.deepEqual(boostIds(applyTeamBoostsV1(evaluation({ bowlingCounts: [4, 1, 5] }))), []);
  assert.deepEqual(boostIds(applyTeamBoostsV1(evaluation({ bowlingCounts: [3, 4, 0] }))), []);
});

test("balanced construction uses base composite, gap, fit, and coverage boundaries", () => {
  const passing = applyTeamBoostsV1(
    evaluation({ battingComposite: 60, bowlingComposite: 66, bowlingCounts: [5, 0, 0], outOfPosition: 1 }),
  );
  assert.ok(boostIds(passing).includes("balanced_construction"));

  assert.ok(!boostIds(applyTeamBoostsV1(evaluation({ battingComposite: 59.99, bowlingCounts: [5, 0, 0] }))).includes("balanced_construction"));
  assert.ok(!boostIds(applyTeamBoostsV1(evaluation({ battingComposite: 60, bowlingComposite: 66.01, bowlingCounts: [5, 0, 0] }))).includes("balanced_construction"));
  assert.ok(!boostIds(applyTeamBoostsV1(evaluation({ bowlingCounts: [5, 0, 0], outOfPosition: 2 }))).includes("balanced_construction"));
  assert.ok(!boostIds(applyTeamBoostsV1(evaluation({ bowlingCounts: [4, 1, 0] }))).includes("balanced_construction"));
});

test("all triggers use the base evaluation rather than earlier adjusted values", () => {
  const result = applyTeamBoostsV1(
    evaluation({ battingComposite: 59.6, bowlingComposite: 60, openerRatings: [65, 65], bowlingCounts: [5, 0, 0] }),
  );

  assert.deepEqual(boostIds(result), ["strong_opening_pair", "sufficient_bowling_coverage"]);
  assert.equal(result.adjustedBattingComposite, 60.2);
});

test("stacked boosts obey component and overall caps", () => {
  const result = applyTeamBoostsV1(
    evaluation({ openerRatings: [65, 65], bowlingCounts: [5, 0, 0], battingComposite: 82.5, bowlingComposite: 82.5 }),
  );

  assert.deepEqual(boostIds(result), ["strong_opening_pair", "sufficient_bowling_coverage", "balanced_construction"]);
  assert.deepEqual(result.rawBoostTotals, { battingComposite: 1, bowlingComposite: 1 });
  assert.equal(result.adjustedBattingComposite, 83);
  assert.equal(result.adjustedBowlingComposite, 83);
  assert.equal(result.adjustedOverallTeamRating, 83);
  assert.deepEqual(result.capApplied, { battingComposite: true, bowlingComposite: true, overallTeamRating: false });
  assert.ok(result.appliedBoostTotals.overallTeamRating <= 1);
});

test("boost output is deterministic and does not mutate its base evaluation or player ratings", () => {
  const base = evaluation({ openerRatings: [65, 65], bowlingCounts: [5, 0, 0] });
  const snapshot = structuredClone(base);
  const first = applyTeamBoostsV1(base);
  const second = applyTeamBoostsV1(base);

  assert.deepEqual(first, second);
  assert.deepEqual(base, snapshot);
  assert.strictEqual(first.baseTeamEvaluation, base);
  assert.deepEqual(
    base.players.map((player) => [player.slot.player.baseRating, player.slot.player.battingRating, player.effectiveBattingRating, player.effectivePlayerRating]),
    snapshot.players.map((player) => [player.slot.player.baseRating, player.slot.player.battingRating, player.effectiveBattingRating, player.effectivePlayerRating]),
  );
});

function boostIds(result: ReturnType<typeof applyTeamBoostsV1>): string[] {
  return result.appliedBoosts.map((boost) => boost.id);
}

function evaluation(overrides: {
  openerRatings?: [number | null, number | null];
  openerFits?: [PositionFit, PositionFit];
  bowlingCounts?: [frontline: number, secondary: number, partTime: number];
  battingComposite?: number;
  bowlingComposite?: number;
  outOfPosition?: number;
} = {}): TeamEvaluation {
  const battingComposite = overrides.battingComposite ?? 60;
  const bowlingComposite = overrides.bowlingComposite ?? 60;
  const openerRatings = overrides.openerRatings ?? [50, 50];
  const openerFits = overrides.openerFits ?? ["natural", "natural"];
  const bowlingCounts = overrides.bowlingCounts ?? [0, 0, 0];
  const players = Array.from({ length: 11 }, (_, index) =>
    contribution(
      (index + 1) as BattingPosition,
      index < 2 ? openerRatings[index]! : 50,
      index < 2 ? openerFits[index]! : "natural",
    ),
  );
  return {
    players,
    averageBaseRating: 60,
    averageEffectivePlayerRating: 60,
    battingStrength: 60,
    bowlingStrength: 60,
    battingDepth: 60,
    bowlingDepth: 60,
    battingComposite,
    bowlingComposite,
    overallTeamRating: (battingComposite + bowlingComposite) / 2,
    fitRating: 80,
    tierCounts: { S: 0, A: 0, B: 11, C: 0, D: 0 },
    positionFitCounts: {
      natural: 11 - (overrides.outOfPosition ?? 0),
      acceptable: 0,
      out_of_position: overrides.outOfPosition ?? 0,
    },
    bowlingOptionCounts: {
      frontline: bowlingCounts[0],
      secondary: bowlingCounts[1],
      part_time: bowlingCounts[2],
    },
    overseasCount: 0,
    hasWicketkeeper: true,
  };
}

function contribution(
  position: BattingPosition,
  effectiveBattingRating: number | null,
  positionFit: PositionFit,
): EvaluatedPlayerContribution {
  const player: DraftPlayerSeason = {
    id: `id-${position}`,
    playerId: `player-${position}`,
    name: `Player ${position}`,
    franchise: "Team",
    season: 2016,
    sourceSeason: "2016",
    matchesPlayed: 10,
    seasonRole: "batter",
    preferredBattingPositions: [position],
    naturalPositions: [position],
    acceptablePositions: [position],
    positionConfidence: "high",
    bowlingOptionStrength: "none",
    displayedStats: {
      matches: 10,
      inningsBatted: 10,
      runs: 300,
      ballsFaced: 240,
      battingAverage: 30,
      strikeRate: 125,
      wickets: 0,
      legalBallsBowled: 0,
      runsConceded: 0,
      economy: null,
    },
    draftEligible: true,
    country: "India",
    isOverseas: false,
    isWicketkeeper: position === 1,
    battingRating: effectiveBattingRating,
    bowlingRating: null,
    baseRating: 60,
    ratingConfidence: "high",
    absoluteTier: "B",
    draftTier: "B",
    tierAdjustment: null,
  };
  return {
    slot: { position, player },
    positionFit,
    positionDistance: positionFit === "out_of_position" ? 1 : 0,
    positionFitMultiplier: positionFit === "out_of_position" ? 0.92 : 1,
    battingDependence: 1,
    effectiveBattingRating,
    bowlingContribution: null,
    battingPenalty: 0,
    effectivePlayerRating: 60,
  };
}
