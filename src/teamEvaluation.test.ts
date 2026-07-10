import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  type BattingPosition,
  type ClassicDraftState,
  type DraftPlayerSeason,
  createClassicDraftState,
  loadDraftPool,
} from "./draftClassic.js";
import {
  OUT_OF_POSITION_DISTANCE_MULTIPLIERS,
  POSITION_FIT_MULTIPLIERS,
  evaluateCompletedTeam,
  evaluatePlayerContribution,
} from "./teamEvaluation.js";

test("natural fit preserves batting contribution", () => {
  const contribution = evaluatePlayerContribution({
    position: 3,
    player: player({ battingRating: 72, naturalPositions: [3], acceptablePositions: [3] }),
  });

  assert.equal(contribution.positionFit, "natural");
  assert.equal(contribution.positionDistance, 0);
  assert.equal(contribution.positionFitMultiplier, POSITION_FIT_MULTIPLIERS.natural);
  assert.equal(contribution.effectiveBattingRating, 72);
  assert.equal(contribution.battingPenalty, 0);
  assert.equal(contribution.effectivePlayerRating, 70);
});

test("acceptable fit applies the role-aware batting reduction", () => {
  const contribution = evaluatePlayerContribution({
    position: 4,
    player: player({
      seasonRole: "batting_all_rounder",
      battingRating: 80,
      baseRating: 72,
      naturalPositions: [5],
      acceptablePositions: [4, 5],
    }),
  });

  assert.equal(contribution.positionFit, "acceptable");
  assert.equal(contribution.positionDistance, 1);
  assertAlmostEqual(contribution.effectiveBattingRating, 75.2);
  assertAlmostEqual(contribution.battingPenalty, 3.6);
  assertAlmostEqual(contribution.effectivePlayerRating, 68.4);
});

test("out-of-position fit applies the correct reduction and clamps batting contribution", () => {
  const contribution = evaluatePlayerContribution({
    position: 6,
    player: player({
      battingRating: 35,
      baseRating: 60,
      naturalPositions: [1],
      acceptablePositions: [1, 2],
    }),
  });

  assert.equal(contribution.positionFit, "out_of_position");
  assert.equal(contribution.positionDistance, 4);
  assert.equal(contribution.positionFitMultiplier, OUT_OF_POSITION_DISTANCE_MULTIPLIERS[4]);
  assert.equal(contribution.effectiveBattingRating, 30);
  assert.equal(contribution.battingPenalty, 5);
  assert.equal(contribution.effectivePlayerRating, 55);
});

test("bowling contribution remains unchanged by batting position", () => {
  const natural = evaluatePlayerContribution({
    position: 10,
    player: player({ seasonRole: "bowler", battingRating: 55, bowlingRating: 78, naturalPositions: [10], acceptablePositions: [10] }),
  });
  const unusual = evaluatePlayerContribution({
    position: 1,
    player: player({ seasonRole: "bowler", battingRating: 55, bowlingRating: 78, preferredBattingPositions: [10], naturalPositions: [10], acceptablePositions: [10] }),
  });

  assert.equal(natural.bowlingContribution, 78);
  assert.equal(unusual.bowlingContribution, 78);
  assertAlmostEqual(unusual.effectivePlayerRating, 67.525);
});

test("base rating remains immutable when effective rating changes", () => {
  const source = player({ battingRating: 80, baseRating: 70, naturalPositions: [1], acceptablePositions: [1] });
  const contribution = evaluatePlayerContribution({ position: 11, player: source });

  assert.equal(source.baseRating, 70);
  assert.equal(contribution.slot.player.baseRating, 70);
  assertAlmostEqual(contribution.effectivePlayerRating, 46);
});

test("Warner and de Villiers preserve effective-rating invariants at natural fit", () => {
  const pool = loadCanonical2016Pool();
  const warner = requiredPlayer(pool, "DA Warner");
  const deVilliers = requiredPlayer(pool, "AB de Villiers");

  assert.equal(warner.baseRating, 83);
  assert.equal(deVilliers.baseRating, 79.5);

  for (const contribution of [
    evaluatePlayerContribution({ position: 1, player: warner }),
    evaluatePlayerContribution({ position: 3, player: deVilliers }),
  ]) {
    assert.notEqual(contribution.effectiveBattingRating, contribution.effectivePlayerRating);
    assert.equal(contribution.positionFit, "natural");
    assert.equal(contribution.battingPenalty, 0);
    assert.equal(contribution.effectivePlayerRating, contribution.slot.player.baseRating);
    assertEffectiveRatingInvariant(contribution);
  }
});

test("canonical player-seasons never evaluate above base rating", () => {
  const pool = loadCanonical2016Pool();

  for (const playerSeason of pool.players) {
    for (const position of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] as BattingPosition[]) {
      assertEffectiveRatingInvariant(evaluatePlayerContribution({ position, player: playerSeason }));
    }
  }
});

test("opener positions 1 and 2 are equivalent", () => {
  const opener = player({
    battingRating: 80,
    preferredBattingPositions: [1],
    naturalPositions: [1],
    acceptablePositions: [1],
  });

  const atOne = evaluatePlayerContribution({ position: 1, player: opener });
  const atTwo = evaluatePlayerContribution({ position: 2, player: opener });

  assert.equal(atOne.positionFit, "natural");
  assert.equal(atTwo.positionFit, "natural");
  assert.equal(atOne.positionDistance, 0);
  assert.equal(atTwo.positionDistance, 0);
  assert.equal(atTwo.positionFitMultiplier, 1);
  assert.equal(atTwo.battingPenalty, 0);
});

test("explicit acceptable position takes precedence over distance", () => {
  const contribution = evaluatePlayerContribution({
    position: 3,
    player: player({
      battingRating: 80,
      preferredBattingPositions: [1],
      naturalPositions: [1],
      acceptablePositions: [1, 3],
    }),
  });

  assert.equal(contribution.positionFit, "acceptable");
  assert.equal(contribution.positionDistance, 1);
  assert.equal(contribution.positionFitMultiplier, 0.94);
  assertAlmostEqual(contribution.effectiveBattingRating, 75.2);
});

test("increasing distance never produces a weaker penalty", () => {
  const opener = player({
    battingRating: 80,
    preferredBattingPositions: [1],
    naturalPositions: [1],
    acceptablePositions: [1],
  });
  const contributions = ([3, 4, 5, 6] as BattingPosition[]).map((position) =>
    evaluatePlayerContribution({ position, player: opener }),
  );

  assert.deepEqual(contributions.map((contribution) => contribution.positionDistance), [1, 2, 3, 4]);
  for (let index = 1; index < contributions.length; index += 1) {
    assert.ok(contributions[index]!.battingPenalty >= contributions[index - 1]!.battingPenalty);
  }
});

test("opener at 3 is penalized less than opener at 6", () => {
  const opener = player({
    battingRating: 80,
    preferredBattingPositions: [1],
    naturalPositions: [1],
    acceptablePositions: [1],
  });
  const atThree = evaluatePlayerContribution({ position: 3, player: opener });
  const atSix = evaluatePlayerContribution({ position: 6, player: opener });

  assert.equal(atThree.positionFitMultiplier, OUT_OF_POSITION_DISTANCE_MULTIPLIERS[1]);
  assert.equal(atSix.positionFitMultiplier, OUT_OF_POSITION_DISTANCE_MULTIPLIERS[4]);
  assert.ok(atThree.battingPenalty < atSix.battingPenalty);
});

test("lower-order players receive distance treatment near positions 8 and 9", () => {
  const lowerOrderPlayer = player({
    battingRating: 50,
    preferredBattingPositions: [9],
    naturalPositions: [9],
    acceptablePositions: [9],
  });
  const atEight = evaluatePlayerContribution({ position: 8, player: lowerOrderPlayer });
  const atSeven = evaluatePlayerContribution({ position: 7, player: lowerOrderPlayer });

  assert.equal(atEight.positionDistance, 1);
  assert.equal(atEight.positionFitMultiplier, OUT_OF_POSITION_DISTANCE_MULTIPLIERS[1]);
  assert.equal(atSeven.positionDistance, 2);
  assert.equal(atSeven.positionFitMultiplier, OUT_OF_POSITION_DISTANCE_MULTIPLIERS[2]);
  assert.ok(atEight.battingPenalty < atSeven.battingPenalty);
});

test("team calculations use only confirmed XI players and are deterministic", () => {
  const state = completedState([
    player({ id: "p1", playerId: "p1", battingRating: 80, bowlingRating: null, baseRating: 76, naturalPositions: [1], acceptablePositions: [1], draftTier: "S", absoluteTier: "S", isWicketkeeper: true }),
    player({ id: "p2", playerId: "p2", battingRating: 78, bowlingRating: null, baseRating: 74, naturalPositions: [2], acceptablePositions: [2], draftTier: "A", absoluteTier: "A" }),
    player({ id: "p3", playerId: "p3", battingRating: 75, bowlingRating: 45, baseRating: 72, naturalPositions: [3], acceptablePositions: [3], draftTier: "A", absoluteTier: "A", bowlingOptionStrength: "part_time" }),
    player({ id: "p4", playerId: "p4", battingRating: 70, bowlingRating: null, baseRating: 68, naturalPositions: [4], acceptablePositions: [4], draftTier: "B", absoluteTier: "B" }),
    player({ id: "p5", playerId: "p5", battingRating: 68, bowlingRating: 50, baseRating: 66, naturalPositions: [5], acceptablePositions: [5], draftTier: "B", absoluteTier: "B", bowlingOptionStrength: "secondary" }),
    player({ id: "p6", playerId: "p6", seasonRole: "batting_all_rounder", battingRating: 64, bowlingRating: 58, baseRating: 64, naturalPositions: [7], acceptablePositions: [6, 7], draftTier: "C", absoluteTier: "C", bowlingOptionStrength: "secondary" }),
    player({ id: "p7", playerId: "p7", seasonRole: "bowling_all_rounder", battingRating: 62, bowlingRating: 67, baseRating: 66, naturalPositions: [7], acceptablePositions: [7], draftTier: "B", absoluteTier: "B", bowlingOptionStrength: "frontline", isOverseas: true }),
    player({ id: "p8", playerId: "p8", seasonRole: "bowling_all_rounder", battingRating: 58, bowlingRating: 70, baseRating: 67, naturalPositions: [8], acceptablePositions: [8], draftTier: "A", absoluteTier: "A", bowlingOptionStrength: "frontline", isOverseas: true }),
    player({ id: "p9", playerId: "p9", seasonRole: "bowler", battingRating: 45, bowlingRating: 73, baseRating: 69, naturalPositions: [10], acceptablePositions: [9, 10], draftTier: "A", absoluteTier: "A", bowlingOptionStrength: "frontline" }),
    player({ id: "p10", playerId: "p10", seasonRole: "bowler", battingRating: null, bowlingRating: 69, baseRating: 66, naturalPositions: [10], acceptablePositions: [10, 11], draftTier: "B", absoluteTier: "B", bowlingOptionStrength: "frontline" }),
    player({ id: "p11", playerId: "p11", seasonRole: "bowler", battingRating: 39, bowlingRating: 65, baseRating: 62, naturalPositions: [11], acceptablePositions: [11], draftTier: "C", absoluteTier: "C", bowlingOptionStrength: "frontline" }),
  ]);

  const first = evaluateCompletedTeam(state);
  const second = evaluateCompletedTeam(state);

  assert.deepEqual(first, second);
  assert.equal(first.players.length, 11);
  assert.equal(first.positionFitCounts.natural, 9);
  assert.equal(first.positionFitCounts.acceptable, 2);
  assert.equal(first.positionFitCounts.out_of_position, 0);
  assert.equal(first.bowlingOptionCounts.frontline, 5);
  assert.equal(first.bowlingOptionCounts.secondary, 2);
  assert.equal(first.bowlingOptionCounts.part_time, 1);
  assert.equal(first.overseasCount, 2);
  assert.equal(first.hasWicketkeeper, true);
  assert.equal(round(first.averageBaseRating), 68.2);
  assert.equal(round(first.averageEffectivePlayerRating), 67.9);
  assert.equal(round(first.battingStrength), 70.5);
  assert.equal(round(first.bowlingStrength), 68.8);
  assert.equal(round(first.battingDepth), 46.3);
  assert.equal(round(first.bowlingDepth), 54);
  assert.equal(round(first.battingComposite), 65.6);
  assert.equal(round(first.bowlingComposite), 65.8);
  assert.equal(round(first.overallTeamRating), 65.7);
  assert.equal(round(first.fitRating), 81.1);
});

test("team evaluation rejects incomplete drafts", () => {
  assert.throws(() => evaluateCompletedTeam(createClassicDraftState()), /completed XI/);
});

function completedState(players: DraftPlayerSeason[]): ClassicDraftState {
  return {
    ...createClassicDraftState(),
    completed: true,
    currentSquadKey: "2016 Team A",
    slots: players.map((draftedPlayer, index) => ({
      position: (index + 1) as BattingPosition,
      player: draftedPlayer,
    })),
  };
}

function round(value: number): number {
  return Number(value.toFixed(1));
}

function assertAlmostEqual(actual: number | null, expected: number): void {
  assert.notEqual(actual, null);
  if (actual === null) {
    return;
  }
  assert.ok(Math.abs(actual - expected) < 1e-9, `Expected ${String(actual)} to be within tolerance of ${expected}`);
}

function assertEffectiveRatingInvariant(contribution: ReturnType<typeof evaluatePlayerContribution>): void {
  assert.ok(contribution.effectivePlayerRating >= 30);
  assert.ok(contribution.effectivePlayerRating <= contribution.slot.player.baseRating);
  assert.ok(contribution.slot.player.baseRating <= 83);
}

function loadCanonical2016Pool(): ReturnType<typeof loadDraftPool> {
  return loadDraftPool(JSON.parse(readFileSync("data/processed/2016/rated_player_seasons.json", "utf8")) as unknown);
}

function requiredPlayer(pool: ReturnType<typeof loadDraftPool>, name: string): DraftPlayerSeason {
  const found = pool.players.find((candidate) => candidate.name === name);
  assert.ok(found, `Expected ${name} in canonical 2016 pool`);
  return found;
}

function player(overrides: Partial<DraftPlayerSeason>): DraftPlayerSeason {
  return {
    id: "id",
    playerId: "player-id",
    name: "Player",
    franchise: "Team",
    season: 2016,
    sourceSeason: "2016",
    matchesPlayed: 1,
    seasonRole: "batter",
    preferredBattingPositions: [1],
    naturalPositions: [1],
    acceptablePositions: [1, 2],
    positionConfidence: "medium",
    bowlingOptionStrength: "none",
    displayedStats: {
      matches: 1,
      inningsBatted: 1,
      runs: 10,
      ballsFaced: 8,
      battingAverage: 10,
      strikeRate: 125,
      wickets: 0,
      legalBallsBowled: 0,
      runsConceded: 0,
      economy: null,
    },
    draftEligible: true,
    country: "India",
    isOverseas: false,
    isWicketkeeper: false,
    battingRating: 50,
    bowlingRating: null,
    baseRating: 70,
    ratingConfidence: "medium",
    absoluteTier: "C",
    draftTier: "C",
    tierAdjustment: null,
    ...overrides,
  };
}
