import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadDraftPool } from "./draftClassic.js";
import {
  CURATED_OPPONENT_XIS_2016,
  buildCuratedOpponentState2016,
  buildOpponentStrengthProfiles2016,
} from "./opponentProfiles2016.js";
import {
  createLeagueComposition,
  generateDoubleRoundRobinSchedule,
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
  console.log("\nSimulation V1 Milestone 1 validation passed.");
}

function formatStrength(strength: { battingComposite: number; bowlingComposite: number; overallTeamRating: number }): string {
  return `bat ${strength.battingComposite.toFixed(2)}; bowl ${strength.bowlingComposite.toFixed(2)}; overall ${strength.overallTeamRating.toFixed(2)}`;
}

function formatDelta(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSimulationV1Validation();
}
