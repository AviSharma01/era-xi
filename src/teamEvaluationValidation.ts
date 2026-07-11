import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  type BattingPosition,
  type ClassicDraftState,
  type DraftPlayerSeason,
  type DraftSlot,
  MAX_OVERSEAS,
  XI_SIZE,
  createClassicDraftState,
  getOverseasCount,
  hasWicketkeeper,
  loadDraftPool,
} from "./draftClassic.js";
import {
  AGGREGATE_SHORTAGE_FLOOR,
  RATING_MAX,
  RATING_MIN,
  type TeamEvaluation,
  evaluateCompletedTeam,
  evaluatePlayerContribution,
} from "./teamEvaluation.js";
import { type BoostedTeamEvaluationV1, applyTeamBoostsV1 } from "./teamBoostV1.js";

type ValidationXI = {
  label: string;
  archetype: string;
  assigned: readonly PlayerPick[];
};

type PlayerPick = {
  name: string;
  position: BattingPosition;
};

type EvaluatedCase = {
  label: string;
  scenario: "assigned" | "best reasonable";
  state: ClassicDraftState;
  evaluation: TeamEvaluation;
  boostedEvaluation: BoostedTeamEvaluationV1;
  arrays: ContributingArrays;
};

type ContributingArrays = {
  topSevenBattingStrength: Array<number | "SHORTAGE_FLOOR">;
  topFiveBowlingStrength: Array<number | "SHORTAGE_FLOOR">;
  battingDepthPositionsSevenToEleven: Array<number | "SHORTAGE_FLOOR">;
  sixthAndSeventhBowlingDepth: Array<number | "SHORTAGE_FLOOR">;
  shortageFloorsInserted: {
    battingStrength: number;
    bowlingStrength: number;
    battingDepth: number;
    bowlingDepth: number;
  };
};

const BATTING_POSITIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] as const;

const VALIDATION_XIS: readonly ValidationXI[] = [
  {
    label: "Elite balanced XI",
    archetype: "Elite top order, four strong frontline bowlers, all-round support, legal overseas count, and mostly natural placement.",
    assigned: [
      { position: 1, name: "DA Warner" },
      { position: 2, name: "V Kohli" },
      { position: 3, name: "AB de Villiers" },
      { position: 4, name: "YK Pathan" },
      { position: 5, name: "AD Russell" },
      { position: 6, name: "CH Morris" },
      { position: 7, name: "AR Patel" },
      { position: 8, name: "B Kumar" },
      { position: 9, name: "DS Kulkarni" },
      { position: 10, name: "YS Chahal" },
      { position: 11, name: "Sandeep Sharma" },
    ],
  },
  {
    label: "Batting-heavy and bowling-weak XI",
    archetype: "Seven credible batting records, a wicketkeeper-rich top/middle order, and only low/part-time bowling after the first seven.",
    assigned: [
      { position: 1, name: "DA Warner" },
      { position: 2, name: "V Kohli" },
      { position: 3, name: "AB de Villiers" },
      { position: 4, name: "KL Rahul" },
      { position: 5, name: "YK Pathan" },
      { position: 6, name: "MS Dhoni" },
      { position: 7, name: "P Negi" },
      { position: 8, name: "KV Sharma" },
      { position: 9, name: "PJ Sangwan" },
      { position: 10, name: "DL Chahar" },
      { position: 11, name: "Anureet Singh" },
    ],
  },
  {
    label: "Bowling-heavy and batting-weak XI",
    archetype: "Nine frontline bowling options plus one secondary option, with the weakest reasonable top seven available under legal/wicketkeeper constraints.",
    assigned: [
      { position: 1, name: "MP Stoinis" },
      { position: 2, name: "DR Smith" },
      { position: 3, name: "WP Saha" },
      { position: 4, name: "PP Chawla" },
      { position: 5, name: "DJ Bravo" },
      { position: 6, name: "CR Brathwaite" },
      { position: 7, name: "AR Patel" },
      { position: 8, name: "B Kumar" },
      { position: 9, name: "DS Kulkarni" },
      { position: 10, name: "YS Chahal" },
      { position: 11, name: "Sandeep Sharma" },
    ],
  },
  {
    label: "XI with multiple out-of-position specialist batters",
    archetype: "A deliberately broken batting order: elite specialist batters are pushed into lower-order slots while specialist bowlers open.",
    assigned: [
      { position: 1, name: "B Kumar" },
      { position: 2, name: "YS Chahal" },
      { position: 3, name: "A Zampa" },
      { position: 4, name: "DS Kulkarni" },
      { position: 5, name: "DA Warner" },
      { position: 6, name: "AB de Villiers" },
      { position: 7, name: "V Kohli" },
      { position: 8, name: "RG Sharma" },
      { position: 9, name: "AM Rahane" },
      { position: 10, name: "G Gambhir" },
      { position: 11, name: "KL Rahul" },
    ],
  },
  {
    label: "Star-heavy XI with poor depth",
    archetype: "Six star or near-star records up front, followed by five weak natural lower-order records.",
    assigned: [
      { position: 1, name: "DA Warner" },
      { position: 2, name: "V Kohli" },
      { position: 3, name: "AB de Villiers" },
      { position: 4, name: "SR Watson" },
      { position: 5, name: "YK Pathan" },
      { position: 6, name: "CH Morris" },
      { position: 7, name: "STR Binny" },
      { position: 8, name: "KV Sharma" },
      { position: 9, name: "Ankit Sharma" },
      { position: 10, name: "KC Cariappa" },
      { position: 11, name: "I Sharma" },
    ],
  },
];

export function runTeamEvaluationValidation(includeBoosts = process.argv.includes("--boosts")): void {
  const players = loadCanonicalPlayers();
  const cases = VALIDATION_XIS.flatMap((xi) => {
    const assigned = evaluateCase(xi.label, "assigned", createState(xi.assigned, players));
    const bestReasonable = evaluateCase(
      xi.label,
      "best reasonable",
      createState(getBestReasonableAssignment(xi.assigned.map((pick) => pick.name), players), players),
    );
    return [assigned, bestReasonable];
  });

  for (const validationXI of VALIDATION_XIS) {
    const assigned = cases.find((candidate) => candidate.label === validationXI.label && candidate.scenario === "assigned");
    const bestReasonable = cases.find((candidate) => candidate.label === validationXI.label && candidate.scenario === "best reasonable");
    assert.ok(assigned);
    assert.ok(bestReasonable);
    verifyCase(assigned);
    verifyCase(bestReasonable);
    assert.deepEqual(assigned.evaluation, evaluateCompletedTeam(assigned.state));
    assert.deepEqual(assigned.boostedEvaluation, applyTeamBoostsV1(assigned.evaluation));
    verifyBowlingUnchanged(assigned.state.slots, bestReasonable.state.slots);
    verifyNaturalPlacementHasNoBattingPenalty(bestReasonable);
  }
  verifyDistanceMultiplierMonotonicity(players);

  verifyExpectedBoostBehavior(cases);
  printReport(cases, includeBoosts);
}

function loadCanonicalPlayers(): Map<string, DraftPlayerSeason> {
  const raw = JSON.parse(readFileSync("data/processed/2016/rated_player_seasons.json", "utf8")) as unknown;
  const pool = loadDraftPool(raw);
  const playersByName = new Map<string, DraftPlayerSeason>();
  for (const player of pool.players) {
    playersByName.set(player.name, player);
  }
  return playersByName;
}

function createState(picks: readonly PlayerPick[], players: Map<string, DraftPlayerSeason>): ClassicDraftState {
  assert.equal(picks.length, XI_SIZE);
  const seenPositions = new Set<BattingPosition>();
  const seenPlayerIds = new Set<string>();
  const slots: DraftSlot[] = picks.map((pick) => {
    assert.ok(!seenPositions.has(pick.position), `Repeated batting position ${pick.position}`);
    seenPositions.add(pick.position);
    const player = players.get(pick.name);
    assert.ok(player, `Missing canonical 2016 player-season for ${pick.name}`);
    assert.ok(!seenPlayerIds.has(player.playerId), `Repeated player-season for ${pick.name}`);
    seenPlayerIds.add(player.playerId);
    return { position: pick.position, player };
  });

  return {
    ...createClassicDraftState(),
    completed: true,
    currentSquadKey: "2016 validation",
    slots: slots.sort((left, right) => left.position - right.position),
  };
}

function evaluateCase(label: string, scenario: EvaluatedCase["scenario"], state: ClassicDraftState): EvaluatedCase {
  const evaluation = evaluateCompletedTeam(state);
  return {
    label,
    scenario,
    state,
    evaluation,
    boostedEvaluation: applyTeamBoostsV1(evaluation),
    arrays: getContributingArrays(evaluation),
  };
}

function verifyExpectedBoostBehavior(cases: readonly EvaluatedCase[]): void {
  const expectedByCase: Record<string, readonly string[]> = {
    "Elite balanced XI|assigned": ["strong_opening_pair", "sufficient_bowling_coverage", "balanced_construction"],
    "Elite balanced XI|best reasonable": ["strong_opening_pair", "sufficient_bowling_coverage", "balanced_construction"],
    "Batting-heavy and bowling-weak XI|assigned": ["strong_opening_pair"],
    "Batting-heavy and bowling-weak XI|best reasonable": ["strong_opening_pair"],
    "Bowling-heavy and batting-weak XI|assigned": ["sufficient_bowling_coverage"],
    "Bowling-heavy and batting-weak XI|best reasonable": ["sufficient_bowling_coverage"],
    "XI with multiple out-of-position specialist batters|assigned": [],
    "XI with multiple out-of-position specialist batters|best reasonable": ["strong_opening_pair"],
    "Star-heavy XI with poor depth|assigned": ["strong_opening_pair"],
    "Star-heavy XI with poor depth|best reasonable": ["strong_opening_pair"],
  };
  for (const result of cases) {
    const boostIds = result.boostedEvaluation.appliedBoosts.map((boost) => boost.id);
    const key = `${result.label}|${result.scenario}`;
    assert.deepEqual(boostIds, expectedByCase[key], `${key} has unexpected Boost V1 behavior`);
  }
}

function verifyCase(result: EvaluatedCase): void {
  assert.equal(result.state.slots.length, XI_SIZE, `${result.label} ${result.scenario} must contain 11 players`);
  assert.ok(getOverseasCount(result.state) <= MAX_OVERSEAS, `${result.label} ${result.scenario} exceeds overseas limit`);
  assert.ok(hasWicketkeeper(result.state), `${result.label} ${result.scenario} must contain a wicketkeeper`);
  assert.equal(new Set(result.state.slots.map((slot) => slot.player.playerId)).size, XI_SIZE, `${result.label} ${result.scenario} has repeated player-seasons`);

  for (const contribution of result.evaluation.players) {
    assert.ok(
      contribution.effectivePlayerRating >= RATING_MIN &&
        contribution.effectivePlayerRating <= contribution.slot.player.baseRating &&
        contribution.slot.player.baseRating <= RATING_MAX,
      `${result.label} ${result.scenario} has invalid effective/base rating for ${contribution.slot.player.name}`,
    );
    if (contribution.positionFit === "natural") {
      assert.equal(contribution.battingPenalty, 0, `${result.label} ${result.scenario} natural placement penalized ${contribution.slot.player.name}`);
    }
  }
}

function verifyNaturalPlacementHasNoBattingPenalty(result: EvaluatedCase): void {
  for (const contribution of result.evaluation.players) {
    if (contribution.positionFit === "natural") {
      assert.equal(contribution.battingPenalty, 0, `${result.label} natural placement penalized ${contribution.slot.player.name}`);
    }
  }
}

function verifyBowlingUnchanged(assigned: readonly DraftSlot[], reassigned: readonly DraftSlot[]): void {
  const reassignedByPlayerId = new Map(reassigned.map((slot) => [slot.player.playerId, slot]));
  for (const slot of assigned) {
    const other = reassignedByPlayerId.get(slot.player.playerId);
    assert.ok(other);
    assert.equal(
      evaluatePlayerContribution(slot).bowlingContribution,
      evaluatePlayerContribution(other).bowlingContribution,
      `Bowling contribution changed for ${slot.player.name}`,
    );
  }
}

function verifyDistanceMultiplierMonotonicity(players: Map<string, DraftPlayerSeason>): void {
  for (const player of players.values()) {
    const outOfPositionContributions = BATTING_POSITIONS.map((position) => evaluatePlayerContribution({ position, player }))
      .filter((contribution) => contribution.positionFit === "out_of_position")
      .sort((left, right) => left.positionDistance - right.positionDistance);
    for (let index = 1; index < outOfPositionContributions.length; index += 1) {
      assert.ok(
        outOfPositionContributions[index]!.positionFitMultiplier <= outOfPositionContributions[index - 1]!.positionFitMultiplier,
        `${player.name} has better multiplier at greater position distance`,
      );
    }
  }
}

function getBestReasonableAssignment(names: readonly string[], players: Map<string, DraftPlayerSeason>): PlayerPick[] {
  const candidates = names
    .map((name) => {
      const player = players.get(name);
      assert.ok(player, `Missing canonical 2016 player-season for ${name}`);
      return player;
    })
    .sort((left, right) => candidatePositionCount(left) - candidatePositionCount(right) || left.name.localeCompare(right.name));
  const best = searchAssignment(candidates, 0, new Map());
  assert.ok(best, `No assignment found for ${names.join(", ")}`);
  return best.picks;
}

function searchAssignment(
  players: readonly DraftPlayerSeason[],
  usedPositionMask: number,
  memo: Map<string, { score: number; picks: PlayerPick[] } | null>,
): { score: number; picks: PlayerPick[] } | null {
  const playerIndex = countUsedPositions(usedPositionMask);
  if (playerIndex === players.length) {
    return { score: 0, picks: [] };
  }

  const memoKey = String(usedPositionMask);
  if (memo.has(memoKey)) {
    return memo.get(memoKey) ?? null;
  }

  const player = players[playerIndex]!;
  let best: { score: number; picks: PlayerPick[] } | null = null;
  for (const position of BATTING_POSITIONS) {
    const positionBit = 1 << (position - 1);
    if ((usedPositionMask & positionBit) !== 0) {
      continue;
    }
    const child = searchAssignment(players, usedPositionMask | positionBit, memo);
    if (child !== null) {
      const candidate = {
        score: positionAssignmentCost(player, position) + child.score,
        picks: [{ name: player.name, position }, ...child.picks].sort((left, right) => left.position - right.position),
      };
      if (best === null || candidate.score < best.score) {
        best = candidate;
      }
    }
  }
  memo.set(memoKey, best);
  return best;
}

function candidatePositionCount(player: DraftPlayerSeason): number {
  return new Set([...player.naturalPositions, ...player.acceptablePositions]).size || BATTING_POSITIONS.length;
}

function positionAssignmentCost(player: DraftPlayerSeason, position: BattingPosition): number {
  const contribution = evaluatePlayerContribution({ position, player });
  if (contribution.positionFit === "natural") {
    return contribution.positionDistance / 100 + position / 10000;
  }
  if (contribution.positionFit === "acceptable") {
    return 10 + contribution.positionDistance / 100 + position / 10000;
  }
  return 1000 + contribution.positionDistance + position / 10000;
}

function countUsedPositions(mask: number): number {
  let count = 0;
  let current = mask;
  while (current !== 0) {
    current &= current - 1;
    count += 1;
  }
  return count;
}

function getContributingArrays(evaluation: TeamEvaluation): ContributingArrays {
  const battingRatings = evaluation.players
    .map((player) => player.effectiveBattingRating)
    .filter((rating): rating is number => rating !== null)
    .sort((left, right) => right - left);
  const bowlingRatings = evaluation.players
    .map((player) => player.bowlingContribution)
    .filter((rating): rating is number => rating !== null)
    .sort((left, right) => right - left);
  const topSevenBattingStrength = padWithShortageFloor(battingRatings.slice(0, 7), 7);
  const topFiveBowlingStrength = padWithShortageFloor(bowlingRatings.slice(0, 5), 5);
  const battingDepthPositionsSevenToEleven = evaluation.players
    .filter((player) => player.slot.position >= 7)
    .map((player) => player.effectiveBattingRating ?? "SHORTAGE_FLOOR");
  const sixthAndSeventhBowlingDepth = padWithShortageFloor(bowlingRatings.slice(5, 7), 2);
  return {
    topSevenBattingStrength,
    topFiveBowlingStrength,
    battingDepthPositionsSevenToEleven,
    sixthAndSeventhBowlingDepth,
    shortageFloorsInserted: {
      battingStrength: topSevenBattingStrength.filter(isShortageFloor).length,
      bowlingStrength: topFiveBowlingStrength.filter(isShortageFloor).length,
      battingDepth: battingDepthPositionsSevenToEleven.filter(isShortageFloor).length,
      bowlingDepth: sixthAndSeventhBowlingDepth.filter(isShortageFloor).length,
    },
  };
}

function padWithShortageFloor(values: number[], count: number): Array<number | "SHORTAGE_FLOOR"> {
  const padded: Array<number | "SHORTAGE_FLOOR"> = [...values];
  while (padded.length < count) {
    padded.push("SHORTAGE_FLOOR");
  }
  return padded;
}

function isShortageFloor(value: number | "SHORTAGE_FLOOR"): boolean {
  return value === "SHORTAGE_FLOOR";
}

function printReport(cases: readonly EvaluatedCase[], includeBoosts: boolean): void {
  console.log("# Team Evaluation V1 deterministic validation");
  console.log(`Shortage floor: ${AGGREGATE_SHORTAGE_FLOOR}`);
  for (const xi of VALIDATION_XIS) {
    console.log(`\n## ${xi.label}`);
    console.log(xi.archetype);
    for (const scenario of ["assigned", "best reasonable"] as const) {
      const result = cases.find((candidate) => candidate.label === xi.label && candidate.scenario === scenario);
      assert.ok(result);
      printCase(result, includeBoosts);
    }
  }
  console.log("\nAll validation assertions passed.");
}

function printCase(result: EvaluatedCase, includeBoosts: boolean): void {
  const { evaluation } = result;
  console.log(`\n### ${result.scenario}`);
  console.log(
    [
      `overall=${fmt(evaluation.overallTeamRating)}`,
      `battingComposite=${fmt(evaluation.battingComposite)}`,
      `bowlingComposite=${fmt(evaluation.bowlingComposite)}`,
      `battingStrength=${fmt(evaluation.battingStrength)}`,
      `bowlingStrength=${fmt(evaluation.bowlingStrength)}`,
      `battingDepth=${fmt(evaluation.battingDepth)}`,
      `bowlingDepth=${fmt(evaluation.bowlingDepth)}`,
      `averageBase=${fmt(evaluation.averageBaseRating)}`,
      `averageEffective=${fmt(evaluation.averageEffectivePlayerRating)}`,
      `fit=${fmt(evaluation.fitRating)}`,
      `fits=${evaluation.positionFitCounts.natural}/${evaluation.positionFitCounts.acceptable}/${evaluation.positionFitCounts.out_of_position}`,
      `bowlingOptions=${evaluation.bowlingOptionCounts.frontline}/${evaluation.bowlingOptionCounts.secondary}/${evaluation.bowlingOptionCounts.part_time}`,
      `overseas=${evaluation.overseasCount}`,
      `wk=${evaluation.hasWicketkeeper ? "yes" : "no"}`,
    ].join(" | "),
  );
  console.log(
    "pos | player | role | ov | wk | base | bat | bowl | fit | dist | mult | effBat | effPlayer | bowlContribution",
  );
  for (const contribution of evaluation.players) {
    const player = contribution.slot.player;
    console.log(
      [
        contribution.slot.position,
        player.name,
        player.seasonRole,
        player.isOverseas ? "Y" : "N",
        player.isWicketkeeper ? "Y" : "N",
        fmt(player.baseRating),
        fmtNullable(player.battingRating),
        fmtNullable(player.bowlingRating),
        contribution.positionFit,
        contribution.positionDistance,
        contribution.positionFitMultiplier.toFixed(2),
        fmtNullable(contribution.effectiveBattingRating),
        fmt(contribution.effectivePlayerRating),
        fmtNullable(contribution.bowlingContribution),
      ].join(" | "),
    );
  }
  console.log(`top-seven batting strength: ${formatArray(result.arrays.topSevenBattingStrength)}`);
  console.log(`top-five bowling strength: ${formatArray(result.arrays.topFiveBowlingStrength)}`);
  console.log(`batting depth positions 7-11: ${formatArray(result.arrays.battingDepthPositionsSevenToEleven)}`);
  console.log(`sixth and seventh bowling depth: ${formatArray(result.arrays.sixthAndSeventhBowlingDepth)}`);
  console.log(`shortage floors inserted: ${JSON.stringify(result.arrays.shortageFloorsInserted)}`);
  if (includeBoosts) {
    const boosted = result.boostedEvaluation;
    const boostLabels = boosted.appliedBoosts.map((boost) => boost.label).join(", ") || "none";
    console.log(
      `Boost V1: overall=${fmt(evaluation.overallTeamRating)} -> ${fmt(boosted.adjustedOverallTeamRating)}` +
        ` | battingComposite=${fmt(evaluation.battingComposite)} -> ${fmt(boosted.adjustedBattingComposite)}` +
        ` | bowlingComposite=${fmt(evaluation.bowlingComposite)} -> ${fmt(boosted.adjustedBowlingComposite)}`,
    );
    console.log(`Boost V1 applied: ${boostLabels}`);
  }
}

function formatArray(values: ReadonlyArray<number | "SHORTAGE_FLOOR">): string {
  return `[${values.map((value) => (value === "SHORTAGE_FLOOR" ? `SHORTAGE_FLOOR(${AGGREGATE_SHORTAGE_FLOOR})` : fmt(value))).join(", ")}]`;
}

function fmtNullable(value: number | null): string {
  return value === null ? "-" : fmt(value);
}

function fmt(value: number): string {
  return value.toFixed(1);
}

runTeamEvaluationValidation();
