import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadDraftPool } from "./draftClassic.js";
import {
  CURATED_OPPONENT_XIS_2016,
  buildCuratedOpponentState2016,
  buildOpponentStrengthProfiles2016,
} from "./opponentProfiles2016.js";
import { evaluateCompletedTeam } from "./teamEvaluation.js";
import { applyTeamBoostsV1 } from "./teamBoostV1.js";
import {
  createLeagueComposition,
  generateDoubleRoundRobinSchedule,
  simulateLeagueV1,
} from "./simulationV1.js";

export function runSimulationV1Validation(): void {
  const pool = loadDraftPool(
    JSON.parse(readFileSync("data/processed/2016/rated_player_seasons.json", "utf8")) as unknown,
  );
  const profiles = buildOpponentStrengthProfiles2016(pool);
  assert.deepEqual(profiles, buildOpponentStrengthProfiles2016(pool));

  console.log("Simulation V1 hidden opponent profiles\n");
  for (const [index, profile] of profiles.entries()) {
    const state = buildCuratedOpponentState2016(pool, CURATED_OPPONENT_XIS_2016[index]);
    console.log(profile.franchiseName);
    for (const slot of state.slots) {
      console.log(`  ${slot.position}. ${slot.player.name} (${slot.player.id})`);
    }
    console.log(
      `  Legal: ${state.slots.filter((slot) => slot.player.isOverseas).length} overseas; ` +
      `WK: ${state.slots.filter((slot) => slot.player.isWicketkeeper).map((slot) => slot.player.name).join(", ")}`,
    );
    console.log(`  Base:     ${formatStrength(profile.baseStrength)}`);
    console.log(`  Adjusted: ${formatStrength(profile.adjustedStrength)}`);
    console.log(
      `  Delta:    bat ${formatDelta(profile.adjustedStrength.battingComposite - profile.baseStrength.battingComposite)}; ` +
      `bowl ${formatDelta(profile.adjustedStrength.bowlingComposite - profile.baseStrength.bowlingComposite)}; ` +
      `overall ${formatDelta(profile.adjustedStrength.overallTeamRating - profile.baseStrength.overallTeamRating)}`,
    );
    console.log(`  Boosts:   ${profile.appliedBoostIds.join(", ") || "none"}\n`);
  }

  const teams = createLeagueComposition("delhi-daredevils", profiles);
  const schedule = generateDoubleRoundRobinSchedule(teams);
  const rounds = new Set(schedule.map((match) => match.round));
  const pairings = new Map<string, number>();
  const appearances = new Map<string, { matches: number; home: number; away: number }>();
  for (const match of schedule) {
    const pair = [match.homeTeamId, match.awayTeamId].sort().join("|");
    pairings.set(pair, (pairings.get(pair) ?? 0) + 1);
    for (const [teamId, side] of [[match.homeTeamId, "home"], [match.awayTeamId, "away"]] as const) {
      const count = appearances.get(teamId) ?? { matches: 0, home: 0, away: 0 };
      count.matches += 1;
      count[side] += 1;
      appearances.set(teamId, count);
    }
  }
  assert.equal(teams.length, 8);
  assert.equal(teams.filter((team) => team.teamId !== "user").length, 7);
  assert.equal(rounds.size, 14);
  assert.equal(schedule.length, 56);
  assert.ok([...rounds].every((round) => schedule.filter((match) => match.round === round).length === 4));
  assert.ok([...appearances.values()].every((count) => count.matches === 14 && count.home === 7 && count.away === 7));
  assert.equal(pairings.size, 28);
  assert.ok([...pairings.values()].every((meetings) => meetings === 2));

  console.log("Schedule review (user replaces Delhi Daredevils)");
  console.log(`  Teams: ${teams.length} (1 user, 7 hidden opponents)`);
  console.log(`  Rounds: ${rounds.size}; matches: ${schedule.length}; matches per round: 4`);
  for (const team of teams) {
    const count = appearances.get(team.teamId);
    console.log(`  ${team.displayName}: ${count?.matches} matches, ${count?.home} home, ${count?.away} away`);
  }
  console.log(`  Unique pairs: ${pairings.size}; meetings per pair: 2`);
  console.log("\nSimulation V1 Milestone 1 validation passed.\n");

  const userState = buildCuratedOpponentState2016(pool, CURATED_OPPONENT_XIS_2016[0]);
  const userBoostedEvaluation = applyTeamBoostsV1(evaluateCompletedTeam(userState));
  const inputs = { teams, schedule, userState, userBoostedEvaluation };
  const inputSnapshot = structuredClone(inputs);
  const seed = "simulation-v1-milestone-2-review";
  const result = simulateLeagueV1({ seed, ...inputs });
  assert.deepEqual(result, simulateLeagueV1({ seed, ...inputs }));
  assert.deepEqual(inputs, inputSnapshot);
  assert.equal(result.matches.length, 56);
  assert.equal(result.pointsTable.reduce((total, row) => total + row.points, 0), 112);
  assert.equal(result.userMatchSummaries.length, 14);
  assert.ok(result.userMatchSummaries.every((summary) =>
    summary.playerRuns.reduce((total, player) => total + player.runs, 0) === summary.userInnings.runs));
  assert.ok(result.userMatchSummaries.every((summary) =>
    summary.playerWickets.reduce((total, player) => total + player.wickets, 0) <= summary.opponentInnings.wickets));

  console.log(`Simulation V1 Milestone 2 representative league (seed: ${seed})`);
  for (let round = 1; round <= 14; round += 1) {
    console.log(`Round ${round}`);
    for (const match of result.matches.filter((candidate) => candidate.round === round)) {
      const [first, chase] = match.innings;
      const suffix = match.resultType === "super_over"
        ? "the Super Over"
        : match.resultType === "runs"
          ? `${match.margin} run${match.margin === 1 ? "" : "s"}`
          : `${match.margin} wicket${match.margin === 1 ? "" : "s"}`;
      console.log(
        `  ${first.teamId} ${formatInnings(first)}; ${chase.teamId} ${formatInnings(chase)} — ` +
        `${match.winnerTeamId} won by ${suffix}`,
      );
    }
  }

  console.log("\nFinal table");
  console.log("  Pos Team                         P  W  L Pts    NRR  Q");
  for (const row of result.pointsTable) {
    console.log(
      `  ${String(row.position).padStart(2)}  ${row.displayName.padEnd(27)} ` +
      `${String(row.played).padStart(2)} ${String(row.won).padStart(2)} ${String(row.lost).padStart(2)} ` +
      `${String(row.points).padStart(3)} ${formatDelta(row.netRunRate).padStart(7)}  ${row.qualified ? "Y" : "-"}`,
    );
  }
  console.log(
    `\nUser: ${result.userRecord.won}-${result.userRecord.lost}, position ${result.userRecord.tablePosition}, ` +
    `${result.userQualified ? "qualified" : "not qualified"}`,
  );
  console.log("Top 3 user run scorers");
  for (const player of result.topRunScorers) console.log(`  ${player.playerName}: ${player.runs}`);
  console.log("Top 3 user wicket takers");
  for (const player of result.topWicketTakers) console.log(`  ${player.playerName}: ${player.wickets}`);

  const samples = 500;
  let inningsRuns = 0;
  let inningsWickets = 0;
  let inningsCount = 0;
  let chaseWins = 0;
  let superOvers = 0;
  const qualificationCounts = new Map<string, number>();
  for (let index = 0; index < samples; index += 1) {
    const sample = simulateLeagueV1({ seed: `distribution-${index}`, ...inputs });
    for (const match of sample.matches) {
      for (const innings of match.innings) {
        inningsRuns += innings.runs;
        inningsWickets += innings.wickets;
        inningsCount += 1;
      }
      if (match.winnerTeamId === match.awayTeamId) chaseWins += 1;
      if (match.resultType === "super_over") superOvers += 1;
    }
    for (const row of sample.pointsTable.filter((row) => row.qualified)) {
      qualificationCounts.set(row.teamId, (qualificationCounts.get(row.teamId) ?? 0) + 1);
    }
  }
  const totalMatches = samples * 56;
  const averageRuns = inningsRuns / inningsCount;
  const averageWickets = inningsWickets / inningsCount;
  const chaseWinRate = chaseWins / totalMatches;
  const superOverRate = superOvers / totalMatches;
  assert.ok(averageRuns > 130 && averageRuns < 190);
  assert.ok(averageWickets > 3 && averageWickets < 9);
  assert.ok(chaseWinRate > 0.3 && chaseWinRate < 0.7);
  assert.ok(superOverRate >= 0 && superOverRate < 0.1);

  const strongId = "gujarat-lions" as const;
  const weakId = "kings-xi-punjab" as const;
  const strengthReviewTeams = teams.map((team) => {
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
  let headToHeadMatches = 0;
  let strongPoints = 0;
  let weakPoints = 0;
  const strengthSamples = 200;
  for (let index = 0; index < strengthSamples; index += 1) {
    const sample = simulateLeagueV1({
      seed: `strength-distribution-${index}`,
      ...inputs,
      teams: strengthReviewTeams,
    });
    strongPoints += sample.pointsTable.find((row) => row.teamId === strongId)!.points;
    weakPoints += sample.pointsTable.find((row) => row.teamId === weakId)!.points;
    for (const match of sample.matches) {
      if ([match.homeTeamId, match.awayTeamId].includes(strongId) &&
          [match.homeTeamId, match.awayTeamId].includes(weakId)) {
        headToHeadMatches += 1;
        if (match.winnerTeamId === strongId) strongWins += 1;
      }
    }
  }
  const strongHeadToHeadRate = strongWins / headToHeadMatches;
  const strongAveragePoints = strongPoints / strengthSamples;
  const weakAveragePoints = weakPoints / strengthSamples;
  assert.ok(strongHeadToHeadRate > 0.75);
  assert.ok(strongAveragePoints > weakAveragePoints + 8);

  console.log(`\nDistribution review (${samples} seeds)`);
  console.log(`  Average innings: ${averageRuns.toFixed(2)} runs, ${averageWickets.toFixed(2)} wickets`);
  console.log(`  Chase win rate: ${(chaseWinRate * 100).toFixed(1)}%`);
  console.log(`  Super-over rate: ${(superOverRate * 100).toFixed(2)}%`);
  console.log(
    `  Synthetic strength check: ${(strongHeadToHeadRate * 100).toFixed(1)}% strong-team head-to-head wins; ` +
    `${strongAveragePoints.toFixed(1)} vs ${weakAveragePoints.toFixed(1)} average points`,
  );
  console.log("  Qualification frequency:");
  for (const team of teams) {
    console.log(`    ${team.displayName}: ${(((qualificationCounts.get(team.teamId) ?? 0) / samples) * 100).toFixed(1)}%`);
  }
  console.log("  Invariants: determinism, schedule, 112 points, user stats, wicket credit, and immutability passed");
  console.log("\nSimulation V1 Milestone 2 validation passed.");
}

function formatStrength(strength: { battingComposite: number; bowlingComposite: number; overallTeamRating: number }): string {
  return `bat ${strength.battingComposite.toFixed(2)}; bowl ${strength.bowlingComposite.toFixed(2)}; overall ${strength.overallTeamRating.toFixed(2)}`;
}

function formatDelta(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}

function formatInnings(innings: { runs: number; wickets: number; balls: number }): string {
  return `${innings.runs}/${innings.wickets} (${Math.floor(innings.balls / 6)}.${innings.balls % 6})`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSimulationV1Validation();
}
