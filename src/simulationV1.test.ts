import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadDraftPool } from "./draftClassic.js";
import {
  CURATED_OPPONENT_XIS_2016,
  buildCuratedOpponentState2016,
  buildOpponentStrengthProfile2016,
  buildOpponentStrengthProfiles2016,
  type CuratedOpponentXi2016,
} from "./opponentProfiles2016.js";
import { evaluateCompletedTeam } from "./teamEvaluation.js";
import { applyTeamBoostsV1 } from "./teamBoostV1.js";
import {
  type AccumulatedUserPlayerStats,
  FRANCHISES_2016,
  SIMULATION_V1_LEAGUE_CONSTANTS,
  createLeagueComposition,
  generateDoubleRoundRobinSchedule,
  simulateLeagueV1,
  simulatePlayoffsV1,
} from "./simulationV1.js";

const pool = loadDraftPool(
  JSON.parse(readFileSync("data/processed/2016/rated_player_seasons.json", "utf8")) as unknown,
);

test("2016 franchise identities and curated profiles are complete and deterministic", () => {
  assert.equal(FRANCHISES_2016.length, 8);
  assert.equal(new Set(FRANCHISES_2016.map((franchise) => franchise.id)).size, 8);
  assert.equal(new Set(FRANCHISES_2016.map((franchise) => franchise.name)).size, 8);
  assert.equal(CURATED_OPPONENT_XIS_2016.length, 8);

  const first = buildOpponentStrengthProfiles2016(pool);
  const second = buildOpponentStrengthProfiles2016(pool);
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.map((profile) => profile.franchiseId),
    FRANCHISES_2016.map((franchise) => franchise.id),
  );
});

test("curated XIs are legal canonical 2016 teams", () => {
  for (const xi of CURATED_OPPONENT_XIS_2016) {
    const state = buildCuratedOpponentState2016(pool, xi);
    assert.equal(state.slots.length, 11);
    assert.deepEqual(state.slots.map((slot) => slot.position), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    assert.equal(new Set(state.slots.map((slot) => slot.player.id)).size, 11);
    assert.equal(new Set(state.slots.map((slot) => slot.player.playerId)).size, 11);
    assert.ok(state.slots.filter((slot) => slot.player.isOverseas).length <= 4);
    assert.ok(state.slots.some((slot) => slot.player.isWicketkeeper));
    assert.ok(state.slots.every((slot) => slot.player.season === 2016));
  }
});

test("profile strength keeps base and Boost V1 adjusted values separate", () => {
  const expected = [
    ["delhi-daredevils", 56.97228571428572, 56.97228571428572, []],
    ["gujarat-lions", 62.43996571428572, 63.43996571428572, ["strong_opening_pair", "sufficient_bowling_coverage", "balanced_construction"]],
    ["kings-xi-punjab", 58.43000571428571, 58.43000571428571, []],
    ["kolkata-knight-riders", 62.175388571428584, 62.77538857142858, ["strong_opening_pair", "sufficient_bowling_coverage"]],
    ["mumbai-indians", 60.03537142857143, 60.335371428571435, ["sufficient_bowling_coverage"]],
    ["rising-pune-supergiants", 57.59628571428571, 58.196285714285715, ["strong_opening_pair", "sufficient_bowling_coverage"]],
    ["royal-challengers-bangalore", 63.115102857142865, 64.11510285714286, ["strong_opening_pair", "sufficient_bowling_coverage", "balanced_construction"]],
    ["sunrisers-hyderabad", 63.088668571428585, 64.08866857142858, ["strong_opening_pair", "sufficient_bowling_coverage", "balanced_construction"]],
  ] as const;
  const profiles = buildOpponentStrengthProfiles2016(pool);
  for (const [index, profile] of profiles.entries()) {
    assert.equal(profile.franchiseId, expected[index][0]);
    assert.equal(profile.baseStrength.overallTeamRating, expected[index][1]);
    assert.equal(profile.adjustedStrength.overallTeamRating, expected[index][2]);
    assert.deepEqual(profile.appliedBoostIds, expected[index][3]);
    assert.equal(profile.boostVersion, "team-boost-v1");
    assert.ok(!("battingComposite" in profile));
  }
});

test("profile validation rejects malformed curated XIs", () => {
  const valid = CURATED_OPPONENT_XIS_2016[0];
  const withEntries = (entries: CuratedOpponentXi2016["entries"]): CuratedOpponentXi2016 => ({
    franchiseId: valid.franchiseId,
    entries,
  });
  assert.throws(() => buildCuratedOpponentState2016(pool, withEntries(valid.entries.slice(0, 10))), /exactly 11/);
  assert.throws(
    () => buildCuratedOpponentState2016(pool, withEntries(valid.entries.map((entry, index) => index === 10 ? { ...entry, position: 10 } : entry))),
    /positions 1-11/,
  );
  assert.throws(
    () => buildCuratedOpponentState2016(pool, withEntries(valid.entries.map((entry, index) => index === 10 ? { ...entry, playerSeasonId: valid.entries[0].playerSeasonId } : entry))),
    /unique players/,
  );
  assert.throws(
    () => buildCuratedOpponentState2016(pool, withEntries(valid.entries.map((entry, index) => index === 0 ? { ...entry, playerSeasonId: "missing-2016-id" } : entry))),
    /missing player-season/,
  );
  assert.throws(
    () => buildCuratedOpponentState2016(pool, withEntries(valid.entries.map((entry, index) => index === 0 ? { ...entry, playerSeasonId: "b8a55852-2016-gujarat-lions" } : entry))),
    /does not belong/,
  );
  const excessOverseasIds = new Map([
    [1, "e342e5fb-2016-delhi-daredevils"],
    [2, "56ab442f-2016-delhi-daredevils"],
    [3, "acee4cc4-2016-delhi-daredevils"],
  ]);
  assert.throws(
    () => buildCuratedOpponentState2016(pool, withEntries(valid.entries.map((entry, index) => ({
      ...entry,
      playerSeasonId: excessOverseasIds.get(index) ?? entry.playerSeasonId,
    })))),
    /overseas-player limit/,
  );
  const replacementKeepers = new Map([
    [0, "00ea847a-2016-delhi-daredevils"],
    [3, "81049310-2016-delhi-daredevils"],
    [5, "9d80c5e1-2016-delhi-daredevils"],
  ]);
  assert.throws(
    () => buildCuratedOpponentState2016(pool, withEntries(valid.entries.map((entry, index) => ({
      ...entry,
      playerSeasonId: replacementKeepers.get(index) ?? entry.playerSeasonId,
    })))),
    /wicketkeeper/,
  );
});

test("profile building does not mutate the draft pool or curated definition", () => {
  const xi = structuredClone(CURATED_OPPONENT_XIS_2016[0]);
  const beforePlayers = structuredClone(pool.players);
  buildOpponentStrengthProfile2016(pool, xi);
  assert.deepEqual(xi, CURATED_OPPONENT_XIS_2016[0]);
  assert.deepEqual(pool.players, beforePlayers);
});

test("each replacement slot produces the user and seven hidden opponents", () => {
  const profiles = buildOpponentStrengthProfiles2016(pool);
  for (const franchise of FRANCHISES_2016) {
    const teams = createLeagueComposition(franchise.id, profiles);
    assert.equal(teams.length, 8);
    assert.equal(new Set(teams.map((team) => team.teamId)).size, 8);
    const user = teams.find((team) => team.teamId === "user");
    assert.deepEqual(user, { teamId: "user", displayName: franchise.name, replacedFranchiseId: franchise.id });
    assert.ok(!teams.some((team) => team.teamId === franchise.id));
    assert.equal(teams.filter((team) => team.teamId !== "user").length, 7);
  }
});

test("double round robin schedule satisfies every league invariant", () => {
  const teams = createLeagueComposition("delhi-daredevils", buildOpponentStrengthProfiles2016(pool));
  const schedule = generateDoubleRoundRobinSchedule(teams);
  assert.deepEqual(schedule, generateDoubleRoundRobinSchedule(teams));
  assert.equal(schedule.length, SIMULATION_V1_LEAGUE_CONSTANTS.totalMatches);
  assert.equal(new Set(schedule.map((match) => match.id)).size, schedule.length);

  const appearances = new Map<string, { total: number; home: number; away: number }>();
  const pairings = new Map<string, string[]>();
  for (let round = 1; round <= 14; round += 1) {
    const matches = schedule.filter((match) => match.round === round);
    assert.equal(matches.length, 4);
    assert.equal(new Set(matches.flatMap((match) => [match.homeTeamId, match.awayTeamId])).size, 8);
  }
  for (const match of schedule) {
    assert.notEqual(match.homeTeamId, match.awayTeamId);
    for (const [id, side] of [[match.homeTeamId, "home"], [match.awayTeamId, "away"]] as const) {
      const count = appearances.get(id) ?? { total: 0, home: 0, away: 0 };
      count.total += 1;
      count[side] += 1;
      appearances.set(id, count);
    }
    const pair = [match.homeTeamId, match.awayTeamId].sort().join("|");
    pairings.set(pair, [...(pairings.get(pair) ?? []), `${match.homeTeamId}>${match.awayTeamId}`]);
  }
  assert.equal(appearances.size, 8);
  for (const count of appearances.values()) assert.deepEqual(count, { total: 14, home: 7, away: 7 });
  assert.equal(pairings.size, 28);
  for (const orientations of pairings.values()) {
    assert.equal(orientations.length, 2);
    assert.notEqual(orientations[0], orientations[1]);
  }
});

test("league composition and schedule reject invalid inputs", () => {
  const profiles = buildOpponentStrengthProfiles2016(pool);
  assert.throws(() => createLeagueComposition("invalid" as never, profiles), /Unknown/);
  assert.throws(() => createLeagueComposition("delhi-daredevils", profiles.slice(0, 7)), /every 2016 franchise/);
  const teams = createLeagueComposition("delhi-daredevils", profiles);
  assert.throws(() => generateDoubleRoundRobinSchedule(teams.slice(0, 7)), /exactly eight/);
  assert.throws(() => generateDoubleRoundRobinSchedule(teams.map((team, index) => index === 1 ? teams[0] : team)), /unique/);
  assert.throws(() => generateDoubleRoundRobinSchedule(teams.map((team) => team.teamId === "user" ? teams[1] : team)), /unique|user/);
});

test("league simulation is deterministic and consumes the schedule exactly once", () => {
  const fixture = simulationFixture();
  const before = structuredClone({
    teams: fixture.teams,
    schedule: fixture.schedule,
    userState: fixture.userState,
    userBoostedEvaluation: fixture.userBoostedEvaluation,
  });
  const first = simulateLeagueV1({ seed: "deterministic-season", ...fixture });
  const second = simulateLeagueV1({ seed: "deterministic-season", ...fixture });
  const different = simulateLeagueV1({ seed: "different-season", ...fixture });

  assert.deepEqual(first, second);
  assert.notDeepEqual(first.matches, different.matches);
  assert.deepEqual(first.matches.map((match) => match.matchId), fixture.schedule.map((match) => match.id));
  assert.equal(new Set(first.matches.map((match) => match.matchId)).size, 56);
  assert.deepEqual({
    teams: fixture.teams,
    schedule: fixture.schedule,
    userState: fixture.userState,
    userBoostedEvaluation: fixture.userBoostedEvaluation,
  }, before);
});

test("league results, points table, chases, and qualification satisfy invariants", () => {
  const result = simulateLeagueV1({ seed: "table-invariants", ...simulationFixture() });
  assert.equal(result.matches.length, 56);
  assert.equal(result.pointsTable.length, 8);
  assert.equal(result.pointsTable.reduce((total, row) => total + row.points, 0), 112);
  assert.equal(result.pointsTable.reduce((total, row) => total + row.won, 0), 56);
  assert.equal(result.pointsTable.reduce((total, row) => total + row.lost, 0), 56);
  assert.deepEqual(result.pointsTable.map((row) => row.position), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(result.pointsTable.filter((row) => row.qualified).length, 4);
  for (const row of result.pointsTable) {
    assert.equal(row.played, 14);
    assert.equal(row.played, row.won + row.lost);
    assert.equal(row.points, row.won * 2);
    assert.equal(row.qualified, row.position <= 4);
    assert.ok(Number.isFinite(row.netRunRate));
  }
  for (const match of result.matches) {
    const [first, chase] = match.innings;
    for (const innings of match.innings) {
      assert.ok(innings.runs >= 75 && innings.runs <= 241);
      assert.ok(innings.wickets >= 0 && innings.wickets <= 10);
      assert.ok(innings.balls >= 90 && innings.balls <= 120);
      assert.equal(innings.allOut, innings.wickets === 10);
    }
    if (match.resultType === "wickets") {
      assert.equal(chase.runs, first.runs + 1);
      assert.ok(chase.balls < 120);
      assert.ok(chase.wickets <= 9);
    }
  }
  const userRow = result.pointsTable.find((row) => row.teamId === "user")!;
  assert.equal(result.userQualified, userRow.qualified);
  assert.equal(result.userRecord.tablePosition, userRow.position);
});

test("user player runs and wickets reconcile without opponent player statistics", () => {
  const fixture = simulationFixture();
  const result = simulateLeagueV1({ seed: "user-stat-reconciliation", ...fixture });
  assert.equal(result.userMatchSummaries.length, 14);
  assert.equal(result.accumulatedUserPlayerStats.length, 11);
  assert.equal(result.topRunScorers.length, 3);
  assert.equal(result.topWicketTakers.length, 3);
  for (const summary of result.userMatchSummaries) {
    assert.equal(summary.playerRuns.reduce((total, player) => total + player.runs, 0), summary.userInnings.runs);
    assert.ok(summary.playerWickets.reduce((total, player) => total + player.wickets, 0) <= summary.opponentInnings.wickets);
    assert.ok(!("opponentPlayerStats" in summary));
  }
  for (const accumulated of result.accumulatedUserPlayerStats) {
    assert.equal(accumulated.matches, 14);
    assert.equal(
      accumulated.runs,
      result.userMatchSummaries.reduce((total, summary) =>
        total + summary.playerRuns.find((player) => player.playerSeasonId === accumulated.playerSeasonId)!.runs, 0),
    );
    assert.equal(
      accumulated.wickets,
      result.userMatchSummaries.reduce((total, summary) =>
        total + summary.playerWickets.find((player) => player.playerSeasonId === accumulated.playerSeasonId)!.wickets, 0),
    );
    const player = fixture.userState.slots.find((slot) => slot.player.id === accumulated.playerSeasonId)!.player;
    if (player.bowlingRating === null || !["frontline", "secondary", "part_time"].includes(player.bowlingOptionStrength)) {
      assert.equal(accumulated.wickets, 0);
    }
  }
});

test("materially stronger teams outperform weak teams across broad seed samples", () => {
  const fixture = simulationFixture();
  const strongId = "gujarat-lions";
  const weakId = "kings-xi-punjab";
  const teams = fixture.teams.map((team) => {
    if (team.teamId === "user" || (team.teamId !== strongId && team.teamId !== weakId)) return team;
    const rating = team.teamId === strongId ? 80 : 40;
    return {
      ...team,
      opponentProfile: {
        ...team.opponentProfile,
        adjustedStrength: { battingComposite: rating, bowlingComposite: rating, overallTeamRating: rating },
      },
    };
  });
  let strongWins = 0;
  let meetings = 0;
  for (let seed = 0; seed < 200; seed += 1) {
    const result = simulateLeagueV1({ seed: `strength-${seed}`, ...fixture, teams });
    for (const match of result.matches) {
      if (new Set([match.homeTeamId, match.awayTeamId]).has(strongId) &&
          new Set([match.homeTeamId, match.awayTeamId]).has(weakId)) {
        meetings += 1;
        if (match.winnerTeamId === strongId) strongWins += 1;
      }
    }
  }
  assert.equal(meetings, 400);
  assert.ok(strongWins / meetings > 0.75, `strong-team win rate was ${strongWins / meetings}`);
});

test("match-core extraction preserves the fixed pre-playoff league result", () => {
  const result = simulateLeagueV1({ seed: "simulation-v1-milestone-2-review", ...simulationFixture() });
  assert.deepEqual(result.matches[0], {
    matchId: "league-r01-m01",
    round: 1,
    leg: 1,
    homeTeamId: "user",
    awayTeamId: "sunrisers-hyderabad",
    innings: [
      { teamId: "user", runs: 146, wickets: 5, balls: 120, allOut: false },
      { teamId: "sunrisers-hyderabad", runs: 147, wickets: 3, balls: 90, allOut: false },
    ],
    winnerTeamId: "sunrisers-hyderabad",
    loserTeamId: "user",
    resultType: "wickets",
    margin: 7,
  });
});

test("non-qualified users return no simulated playoffs and unchanged combined totals", () => {
  const fixture = simulationFixture();
  const leagueResult = simulateLeagueV1({ seed: "simulation-v1-milestone-2-review", ...fixture });
  assert.ok(!leagueResult.userQualified);
  const before = structuredClone({ leagueResult, ...fixture });
  const playoffs = simulatePlayoffsV1({ leagueResult, ...fixture });

  assert.equal(playoffs.qualified, false);
  assert.equal(playoffs.championTeamId, null);
  assert.equal(playoffs.userOutcome, "not_qualified");
  assert.deepEqual(playoffs.matches, []);
  assert.deepEqual(playoffs.userMatchSummaries, []);
  assert.ok(playoffs.playoffPlayerStats.every((player) =>
    player.matches === 0 && player.runs === 0 && player.wickets === 0));
  assert.deepEqual(playoffs.combinedSeasonPlayerStats, leagueResult.accumulatedUserPlayerStats);
  assert.deepEqual({ leagueResult, ...fixture }, before);
});

test("qualified playoffs propagate the complete IPL bracket and reconcile user statistics", () => {
  const fixture = simulationFixture();
  const leagueResult = qualifiedLeagueResult(fixture, "qualified-bracket", 1);
  const playoffs = simulatePlayoffsV1({ leagueResult, ...fixture });
  assert.equal(playoffs.qualified, true);
  assert.equal(playoffs.matches.length, 4);
  assert.deepEqual(playoffs.matches.map((match) => match.stage), [
    "qualifier_1", "eliminator", "qualifier_2", "final",
  ]);
  const [qualifierOne, eliminator, qualifierTwo, final] = playoffs.matches;
  assert.deepEqual(
    [qualifierTwo!.firstBattingTeamId, qualifierTwo!.chasingTeamId],
    [qualifierOne!.loserTeamId, eliminator!.winnerTeamId],
  );
  assert.deepEqual(
    [final!.firstBattingTeamId, final!.chasingTeamId],
    [qualifierOne!.winnerTeamId, qualifierTwo!.winnerTeamId],
  );
  assert.equal(playoffs.championTeamId, final!.winnerTeamId);
  assert.ok(playoffs.userMatchSummaries.length >= 2 && playoffs.userMatchSummaries.length <= 3);
  assert.ok(!playoffs.matches.some((match) => "opponentPlayerStats" in match));
  for (const match of playoffs.matches) {
    if (match.resultType === "wickets") assert.equal(match.innings[1].runs, match.innings[0].runs + 1);
  }
  for (const summary of playoffs.userMatchSummaries) {
    assert.equal(summary.playerRuns.reduce((total, player) => total + player.runs, 0), summary.userInnings.runs);
    assert.ok(summary.playerWickets.reduce((total, player) => total + player.wickets, 0) <= summary.opponentInnings.wickets);
  }
  for (const player of playoffs.playoffPlayerStats) {
    assert.equal(player.matches, playoffs.userMatchSummaries.length);
    const combinedPlayer: AccumulatedUserPlayerStats =
      playoffs.combinedSeasonPlayerStats.find((candidate) => candidate.playerSeasonId === player.playerSeasonId)!;
    const league = leagueResult.accumulatedUserPlayerStats.find((candidate) => candidate.playerSeasonId === player.playerSeasonId)!;
    assert.equal(combinedPlayer.matches, league.matches + player.matches);
    assert.equal(combinedPlayer.runs, league.runs + player.runs);
    assert.equal(combinedPlayer.wickets, league.wickets + player.wickets);
  }
  assert.deepEqual(playoffs, simulatePlayoffsV1({ leagueResult, ...fixture }));
});

test("top-four user routes expose only valid terminal playoff outcomes", () => {
  const fixture = simulationFixture();
  for (const position of [1, 2, 3, 4] as const) {
    const leagueResult = qualifiedLeagueResult(fixture, `route-${position}`, position);
    const playoffs = simulatePlayoffsV1({ leagueResult, ...fixture });
    assert.ok(playoffs.qualified);
    const stages = playoffs.userMatchSummaries.map((summary) => summary.stage);
    if (position <= 2) {
      assert.equal(stages[0], "qualifier_1");
      assert.ok(!stages.includes("eliminator"));
      assert.ok(["eliminated_in_qualifier_2", "runner_up", "champion"].includes(playoffs.userOutcome));
    } else {
      assert.equal(stages[0], "eliminator");
      assert.ok(!stages.includes("qualifier_1"));
      assert.ok(["eliminated_in_eliminator", "eliminated_in_qualifier_2", "runner_up", "champion"].includes(playoffs.userOutcome));
    }
  }
});

test("a controlled seed set can produce different playoff outcomes", () => {
  const fixture = simulationFixture();
  const champions = new Set<string>();
  const outcomes = new Set<string>();
  for (const seed of ["playoff-a", "playoff-b", "playoff-c", "playoff-d", "playoff-e", "playoff-f"]) {
    const leagueResult = qualifiedLeagueResult(fixture, seed, 1);
    const playoffs = simulatePlayoffsV1({ leagueResult, ...fixture });
    champions.add(playoffs.championTeamId!);
    outcomes.add(playoffs.userOutcome);
  }
  assert.ok(champions.size > 1 || outcomes.size > 1);
});

test("playoff validation rejects inconsistent qualification and XI inputs", () => {
  const fixture = simulationFixture();
  const leagueResult = qualifiedLeagueResult(fixture, "invalid-playoffs", 1);
  assert.throws(
    () => simulatePlayoffsV1({
      leagueResult: { ...leagueResult, userQualified: false },
      ...fixture,
    }),
    /qualification/,
  );
  assert.throws(
    () => simulatePlayoffsV1({
      leagueResult,
      ...fixture,
      userState: { ...fixture.userState, slots: fixture.userState.slots.slice(0, 10) },
    }),
    /completed user XI/,
  );
});

function simulationFixture() {
  const profiles = buildOpponentStrengthProfiles2016(pool);
  const teams = createLeagueComposition("delhi-daredevils", profiles);
  const schedule = generateDoubleRoundRobinSchedule(teams);
  const userState = buildCuratedOpponentState2016(pool, CURATED_OPPONENT_XIS_2016[0]);
  const userBoostedEvaluation = applyTeamBoostsV1(evaluateCompletedTeam(userState));
  return { teams, schedule, userState, userBoostedEvaluation };
}

function qualifiedLeagueResult(
  fixture: ReturnType<typeof simulationFixture>,
  seed: string,
  userPosition: 1 | 2 | 3 | 4,
) {
  const original = simulateLeagueV1({ seed, ...fixture });
  const currentUserPosition = original.userRecord.tablePosition;
  const pointsTable = original.pointsTable.map((row) => {
    let position = row.position;
    if (row.teamId === "user") position = userPosition;
    else if (row.position === userPosition) position = currentUserPosition;
    return { ...row, position, qualified: position <= 4 };
  }).sort((left, right) => left.position - right.position);
  return {
    ...original,
    pointsTable,
    userRecord: { ...original.userRecord, tablePosition: userPosition },
    userQualified: true,
  };
}
