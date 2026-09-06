import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parsePlayerQualityConsumer, type PlayerQualityConsumer } from "./playerQualityContract.js";
import { parsePlayerRoleConsumer, type PlayerRoleConsumer } from "./playerRoleContract.js";
import type { EraCompletedXiInput, EraDefinitionV2, EraId, EraXiPlayerInput } from "./teamEvaluationV2.js";
import type { EraEnvironmentV2, SimulationTeamV2 } from "./simulationV2.js";

export type EraOpponentProfileV2 = {
  candidateId: string;
  eraId: EraId;
  franchiseId: string;
  teamId: string;
  teamName: string;
  seasonId: string;
  xi: readonly {
    position: number;
    playerTeamSeasonId: string;
    playerId: string;
    displayName: string;
    rosterStatus: "INDIAN" | "OVERSEAS";
    officialListMatchCount: number;
  }[];
  evaluation: {
    battingCore: number;
    battingDepth: number;
    batting: number;
    bowling: number;
    overall: number;
    structuralBattingOrderEffect: number;
    appliedPositionFitEffect: number;
    bowlingCapacity: number;
    uncoveredBowlingUnits: number;
  };
  review: { status: "APPROVED"; reviewedOn: string; rationale: string; heuristicIsAdvisory: true };
};

export type FoundationOpponentProfileV2 = EraOpponentProfileV2 & { eraId: "era-foundation" };

export function loadEraEnvironmentsV2(root = process.cwd()): EraEnvironmentV2[] {
  const value = JSON.parse(readFileSync(resolve(root, "data/processed/era-draft/simulation/v2/era_environments.json"), "utf8")) as { environments?: unknown };
  if (!Array.isArray(value.environments) || value.environments.length !== 5) {
    throw new Error("Stage 7 requires exactly five generated era environments.");
  }
  return value.environments.map(parseEnvironment);
}

export function loadFoundationOpponentProfilesV2(root = process.cwd()): FoundationOpponentProfileV2[] {
  const value = JSON.parse(readFileSync(resolve(root, "data/processed/era-draft/simulation/v2/foundation_opponents.json"), "utf8")) as { eraId?: unknown; opponents?: unknown };
  if (value.eraId !== "era-foundation" || !Array.isArray(value.opponents) || value.opponents.length !== 8) {
    throw new Error("Stage 7 Foundation content requires eight reviewed opponents.");
  }
  const profiles = value.opponents.map((opponent) => parseOpponent(opponent, "era-foundation"));
  if (new Set(profiles.map((profile) => profile.franchiseId)).size !== 8) {
    throw new Error("Foundation opponents must represent eight distinct franchise lineages.");
  }
  return profiles;
}

export function loadEraOpponentProfilesV2(eraId: EraId, root = process.cwd()): EraOpponentProfileV2[] {
  if (eraId === "era-foundation") return loadFoundationOpponentProfilesV2(root);
  throw new Error(`No curated opponent content is frozen for ${eraId}; the V2 contract supports it when added.`);
}

export function opponentAsSimulationTeamV2(profile: FoundationOpponentProfileV2): SimulationTeamV2 {
  return {
    teamId: profile.candidateId,
    displayName: `${profile.teamName} ${profile.seasonId.slice(4)}`,
    strength: { batting: profile.evaluation.batting, bowling: profile.evaluation.bowling, overall: profile.evaluation.overall },
  };
}

export function loadOpponentXiInputV2(
  profile: FoundationOpponentProfileV2,
  root = process.cwd(),
): EraCompletedXiInput {
  const roles = readJsonLines(resolve(root, "data/processed/era-draft/roles/v1/player_role_consumer.jsonl"), parsePlayerRoleConsumer);
  const qualities = readJsonLines(resolve(root, "data/processed/era-draft/quality/v1/player_quality_consumer.jsonl"), parsePlayerQualityConsumer);
  const rosterRows = readJsonLines(resolve(root, "data/metadata/ipl/country_overseas/v1/player_team_season_metadata.jsonl"), parseRosterRow);
  const roleById = new Map(roles.map((row) => [row.playerTeamSeasonId, row]));
  const qualityById = new Map(qualities.map((row) => [row.playerTeamSeasonId, row]));
  const rosterById = new Map(rosterRows.map((row) => [row.playerTeamSeasonId, row.iplRosterStatus]));
  const era: EraDefinitionV2 = { eraId: "era-foundation", seasonIds: ["ipl-2008", "ipl-2009", "ipl-2010"] };
  const players = profile.xi.map((item): EraXiPlayerInput => ({
    position: item.position as EraXiPlayerInput["position"],
    role: required(roleById, item.playerTeamSeasonId),
    quality: required(qualityById, item.playerTeamSeasonId),
    rosterStatus: required(rosterById, item.playerTeamSeasonId),
  }));
  return { era, players };
}

function parseEnvironment(value: unknown): EraEnvironmentV2 {
  const row = value as Partial<EraEnvironmentV2>;
  if (!row || typeof row !== "object" || typeof row.eraId !== "string" || row.sourceCohort !== "all_normal"
    || !row.sample || row.sample.matches <= 0 || !row.runs || row.runs.standardDeviation <= 0 || !row.wickets || !row.chase
    || !Array.isArray(row.allOutBallsHistogram)) {
    throw new Error("Invalid generated Stage 7 era environment.");
  }
  return row as EraEnvironmentV2;
}

function parseOpponent(value: unknown, expectedEraId: EraId): FoundationOpponentProfileV2 {
  const row = value as Partial<FoundationOpponentProfileV2>;
  if (!row || typeof row !== "object" || row.eraId !== expectedEraId || typeof row.candidateId !== "string" || typeof row.franchiseId !== "string"
    || typeof row.teamName !== "string" || !Array.isArray(row.xi) || row.xi.length !== 11
    || row.review?.status !== "APPROVED" || !row.evaluation || !Number.isFinite(row.evaluation.overall)) {
    throw new Error("Invalid reviewed Foundation opponent profile.");
  }
  if (new Set(row.xi.map((player) => player.playerId)).size !== 11
    || row.xi.some((player, index) => player.position !== index + 1)
    || row.xi.filter((player) => player.rosterStatus === "OVERSEAS").length > 4) {
    throw new Error(`Illegal reviewed Foundation XI: ${row.candidateId}.`);
  }
  return row as FoundationOpponentProfileV2;
}

function readJsonLines<T>(path: string, parser: (value: unknown, label: string) => T): T[] {
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line, index) => parser(JSON.parse(line), `${path}:${index + 1}`));
}

function parseRosterRow(value: unknown, label: string): { playerTeamSeasonId: string; iplRosterStatus: "INDIAN" | "OVERSEAS" | "UNKNOWN" } {
  const row = value as { playerTeamSeasonId?: unknown; iplRosterStatus?: unknown };
  if (typeof row.playerTeamSeasonId !== "string" || !["INDIAN", "OVERSEAS", "UNKNOWN"].includes(String(row.iplRosterStatus))) {
    throw new Error(`${label} has invalid roster metadata.`);
  }
  return row as { playerTeamSeasonId: string; iplRosterStatus: "INDIAN" | "OVERSEAS" | "UNKNOWN" };
}

function required<T>(map: Map<string, T>, id: string): T {
  const value = map.get(id);
  if (value === undefined) throw new Error(`Missing Stage 7 input ${id}.`);
  return value;
}

export type { PlayerRoleConsumer, PlayerQualityConsumer };
