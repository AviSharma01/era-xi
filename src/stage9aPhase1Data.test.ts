import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { parsePlayerQualityConsumer, type PlayerQualityConsumer } from "./playerQualityContract.js";
import { parsePlayerRoleConsumer, type PlayerRoleConsumer } from "./playerRoleContract.js";
import { ERA_IDS, evaluateCompletedEraXi, type EraDefinitionV2, type EraId, type EraXiPlayerInput } from "./teamEvaluationV2.js";

type Candidate = {
  candidateId: string;
  eraId: EraId;
  franchiseId: string;
  teamId: string;
  seasonId: string;
  xi: Array<{
    position: number;
    playerTeamSeasonId: string;
    playerId: string;
    rosterStatus: "INDIAN" | "OVERSEAS";
  }>;
  evaluation: Record<string, number>;
  diagnostics: {
    legality: { playerCount: number; uniqueCanonicalPlayerCount: number; overseasCount: number; confirmedKeeperCount: number };
    replacementContext: { diagnosticOnly: boolean };
  };
  selectionHeuristic: { advisoryOnly: boolean };
};

const root = process.cwd();
const phase1 = JSON.parse(readFileSync(resolve(root, "data/processed/era-draft/simulation/v2/all_era_opponent_candidates.json"), "utf8")) as {
  candidates: Candidate[];
  candidateCountsByEra: Record<EraId, number>;
};
const eras = JSON.parse(readFileSync(resolve(root, "data/registries/ipl/v1/eras.json"), "utf8")) as { eras: EraDefinitionV2[] };
const roles = jsonLines("data/processed/era-draft/roles/v1/player_role_consumer.jsonl", parsePlayerRoleConsumer);
const qualities = jsonLines("data/processed/era-draft/quality/v1/player_quality_consumer.jsonl", parsePlayerQualityConsumer);
const roster = jsonLines("data/metadata/ipl/country_overseas/v1/player_team_season_metadata.jsonl", (value) => value as {
  playerTeamSeasonId: string; playerId: string; seasonId: string; teamId: string;
  iplRosterStatus: "INDIAN" | "OVERSEAS" | "UNKNOWN";
});
const roleById = new Map<string, PlayerRoleConsumer>(roles.map((row) => [row.playerTeamSeasonId, row]));
const qualityById = new Map<string, PlayerQualityConsumer>(qualities.map((row) => [row.playerTeamSeasonId, row]));
const rosterById = new Map(roster.map((row) => [row.playerTeamSeasonId, row]));
const eraById = new Map(eras.eras.map((era) => [era.eraId, era]));

test("Stage 9A candidate XIs preserve strict identity and legality across all 166 team-seasons", () => {
  assert.equal(phase1.candidates.length, 166);
  assert.deepEqual(phase1.candidateCountsByEra, {
    "era-foundation": 24, "era-expansion": 28, "era-transition": 32,
    "era-modern-pre-impact": 42, "era-impact": 40,
  });
  assert.deepEqual(phase1.candidates.map((candidate) => `${candidate.teamId}:${candidate.seasonId}`),
    [...phase1.candidates].sort((left, right) => left.teamId.localeCompare(right.teamId) || left.seasonId.localeCompare(right.seasonId))
      .map((candidate) => `${candidate.teamId}:${candidate.seasonId}`));
  assert.equal(new Set(phase1.candidates.map((candidate) => `${candidate.teamId}:${candidate.seasonId}`)).size, 166);

  for (const candidate of phase1.candidates) {
    assert.equal(candidate.xi.length, 11, candidate.candidateId);
    assert.deepEqual(candidate.xi.map((player) => player.position), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    assert.equal(new Set(candidate.xi.map((player) => player.playerId)).size, 11, candidate.candidateId);
    assert.ok(candidate.xi.filter((player) => player.rosterStatus === "OVERSEAS").length <= 4, candidate.candidateId);
    assert.equal(candidate.diagnostics.legality.playerCount, 11);
    assert.equal(candidate.diagnostics.legality.uniqueCanonicalPlayerCount, 11);
    assert.ok(candidate.diagnostics.legality.confirmedKeeperCount >= 1, candidate.candidateId);
    assert.equal(candidate.diagnostics.replacementContext.diagnosticOnly, true);
    assert.equal(candidate.selectionHeuristic.advisoryOnly, true);
    for (const player of candidate.xi) {
      const role = required(roleById, player.playerTeamSeasonId);
      const quality = required(qualityById, player.playerTeamSeasonId);
      const status = required(rosterById, player.playerTeamSeasonId);
      assert.deepEqual([role.playerId, role.seasonId, role.teamId, role.franchiseId],
        [player.playerId, candidate.seasonId, candidate.teamId, candidate.franchiseId]);
      assert.deepEqual([quality.playerId, quality.seasonId, quality.teamId, quality.franchiseId],
        [player.playerId, candidate.seasonId, candidate.teamId, candidate.franchiseId]);
      assert.deepEqual([status.playerId, status.seasonId, status.teamId, status.iplRosterStatus],
        [player.playerId, candidate.seasonId, candidate.teamId, player.rosterStatus]);
    }
  }
  assert.deepEqual(ERA_IDS, eras.eras.map((era) => era.eraId));
});

test("all 166 stored candidate strengths agree with frozen Team Evaluation V2", () => {
  for (const candidate of phase1.candidates) {
    const result = evaluateCompletedEraXi({
      era: required(eraById, candidate.eraId),
      players: candidate.xi.map((player): EraXiPlayerInput => ({
        position: player.position as EraXiPlayerInput["position"],
        role: required(roleById, player.playerTeamSeasonId),
        quality: required(qualityById, player.playerTeamSeasonId),
        rosterStatus: player.rosterStatus,
      })),
    });
    assert.deepEqual(candidate.evaluation, {
      battingCore: rounded(result.baseStrength.battingCore),
      battingDepth: rounded(result.baseStrength.battingDepth),
      batting: rounded(result.adjustedStrength.batting),
      bowling: rounded(result.adjustedStrength.bowling),
      overall: rounded(result.adjustedStrength.overall),
      structuralBattingOrderEffect: rounded(result.diagnostics.structuralBattingOrderEffect),
      appliedPositionFitEffect: rounded(result.diagnostics.appliedPositionFitEffect),
      bowlingCapacity: rounded(result.diagnostics.bowlingCapacity),
      uncoveredBowlingUnits: rounded(result.diagnostics.uncoveredBowlingUnits),
    }, candidate.candidateId);
  }
});

function jsonLines<T>(relativePath: string, parser: (value: unknown, label: string) => T): T[] {
  return readFileSync(resolve(root, relativePath), "utf8").split("\n").filter(Boolean)
    .map((line, index) => parser(JSON.parse(line), `${relativePath}:${index + 1}`));
}

function required<K, V>(map: Map<K, V>, key: K): V {
  const value = map.get(key);
  if (value === undefined) throw new Error(`Missing Stage 9A test input ${String(key)}`);
  return value;
}

function rounded(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}
