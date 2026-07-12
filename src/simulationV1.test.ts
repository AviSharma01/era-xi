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
import {
  FRANCHISES_2016,
  SIMULATION_V1_LEAGUE_CONSTANTS,
  createLeagueComposition,
  generateDoubleRoundRobinSchedule,
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
