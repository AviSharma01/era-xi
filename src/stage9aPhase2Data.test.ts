import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { loadEraDraftCatalog } from "./eraDraftData.js";
import { parsePlayerQualityConsumer, type PlayerQualityConsumer } from "./playerQualityContract.js";
import { parsePlayerRoleConsumer, type PlayerRoleConsumer } from "./playerRoleContract.js";
import { loadEraOpponentProfilesV2 } from "./stage7Data.js";
import { evaluateCompletedEraXi, type EraDefinitionV2, type EraId, type EraXiPlayerInput } from "./teamEvaluationV2.js";

type FrozenProfile = {
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
  review: {
    status: "APPROVED";
    xiProvenance: "BASELINE_ACCEPTED" | "REVIEWED_OVERRIDE";
    selectionAuthority: "HUMAN_APPROVED_MANUAL_REVIEW";
  };
};

const root = process.cwd();
const paths = [
  "data/processed/era-draft/simulation/v2/expansion_opponents.json",
  "data/processed/era-draft/simulation/v2/transition_opponents.json",
  "data/processed/era-draft/simulation/v2/modern_pre_impact_opponents.json",
  "data/processed/era-draft/simulation/v2/impact_opponents.json",
];
const documents = paths.map((path) => JSON.parse(readFileSync(resolve(root, path), "utf8")) as {
  eraId: EraId;
  runtimeIntegrationStatus: "NOT_INTEGRATED";
  opponents: FrozenProfile[];
});
const profiles = documents.flatMap((document) => document.opponents);
const eras = JSON.parse(readFileSync(resolve(root, "data/registries/ipl/v1/eras.json"), "utf8")) as { eras: EraDefinitionV2[] };
const roles = jsonLines("data/processed/era-draft/roles/v1/player_role_consumer.jsonl", parsePlayerRoleConsumer);
const qualities = jsonLines("data/processed/era-draft/quality/v1/player_quality_consumer.jsonl", parsePlayerQualityConsumer);
const roster = jsonLines("data/metadata/ipl/country_overseas/v1/player_team_season_metadata.jsonl", (value) => value as {
  playerTeamSeasonId: string;
  iplRosterStatus: "INDIAN" | "OVERSEAS" | "UNKNOWN";
});
const roleById = new Map<string, PlayerRoleConsumer>(roles.map((row) => [row.playerTeamSeasonId, row]));
const qualityById = new Map<string, PlayerQualityConsumer>(qualities.map((row) => [row.playerTeamSeasonId, row]));
const rosterById = new Map(roster.map((row) => [row.playerTeamSeasonId, row]));
const eraById = new Map(eras.eras.map((era) => [era.eraId, era]));

test("Stage 9A Phase 2 exposes exactly 41 offline-only human-approved profiles", () => {
  assert.deepEqual(Object.fromEntries(documents.map((document) => [document.eraId, document.opponents.length])), {
    "era-expansion": 11,
    "era-transition": 10,
    "era-modern-pre-impact": 10,
    "era-impact": 10,
  });
  assert.equal(profiles.length, 41);
  assert.equal(new Set(profiles.map((profile) => `${profile.eraId}:${profile.franchiseId}`)).size, 41);
  assert.equal(profiles.filter((profile) => profile.review.xiProvenance === "BASELINE_ACCEPTED").length, 31);
  assert.equal(profiles.filter((profile) => profile.review.xiProvenance === "REVIEWED_OVERRIDE").length, 10);
  assert.ok(documents.every((document) => document.runtimeIntegrationStatus === "NOT_INTEGRATED"));
  assert.ok(profiles.every((profile) => profile.review.status === "APPROVED"
    && profile.review.selectionAuthority === "HUMAN_APPROVED_MANUAL_REVIEW"));
});

test("all 41 Phase 2 strengths agree with the runtime-compatible frozen Team Evaluation V2", () => {
  for (const profile of profiles) {
    const result = evaluateCompletedEraXi({
      era: required(eraById, profile.eraId),
      players: profile.xi.map((player): EraXiPlayerInput => ({
        position: player.position as EraXiPlayerInput["position"],
        role: required(roleById, player.playerTeamSeasonId),
        quality: required(qualityById, player.playerTeamSeasonId),
        rosterStatus: required(rosterById, player.playerTeamSeasonId).iplRosterStatus,
      })),
    });
    assert.deepEqual(profile.evaluation, {
      battingCore: rounded(result.baseStrength.battingCore),
      battingDepth: rounded(result.baseStrength.battingDepth),
      batting: rounded(result.adjustedStrength.batting),
      bowling: rounded(result.adjustedStrength.bowling),
      overall: rounded(result.adjustedStrength.overall),
      structuralBattingOrderEffect: rounded(result.diagnostics.structuralBattingOrderEffect),
      appliedPositionFitEffect: rounded(result.diagnostics.appliedPositionFitEffect),
      bowlingCapacity: rounded(result.diagnostics.bowlingCapacity),
      uncoveredBowlingUnits: rounded(result.diagnostics.uncoveredBowlingUnits),
    }, profile.candidateId);
  }
});

test("Phase 2 files do not enable later-era Stage 8 simulation", () => {
  const catalog = loadEraDraftCatalog(root);
  for (const eraId of ["era-expansion", "era-transition", "era-modern-pre-impact", "era-impact"] as const) {
    assert.deepEqual(catalog.getSimulationContent(eraId), { status: "UNAVAILABLE", opponentCount: 0 });
    assert.throws(() => loadEraOpponentProfilesV2(eraId, root), /No curated opponent content is frozen/);
  }
});

function jsonLines<T>(relativePath: string, parser: (value: unknown, label: string) => T): T[] {
  return readFileSync(resolve(root, relativePath), "utf8").split("\n").filter(Boolean)
    .map((line, index) => parser(JSON.parse(line), `${relativePath}:${index + 1}`));
}

function required<K, V>(map: Map<K, V>, key: K): V {
  const value = map.get(key);
  if (value === undefined) throw new Error(`Missing Stage 9A Phase 2 test input ${String(key)}`);
  return value;
}

function rounded(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}
