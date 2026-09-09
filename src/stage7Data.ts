import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parsePlayerQualityConsumer, type PlayerQualityConsumer } from "./playerQualityContract.js";
import { parsePlayerRoleConsumer, type PlayerRoleConsumer } from "./playerRoleContract.js";
import {
  ERA_IDS,
  evaluateCompletedEraXi,
  type EraCompletedXiInput,
  type EraDefinitionV2,
  type EraId,
  type EraXiPlayerInput,
} from "./teamEvaluationV2.js";
import type { EraEnvironmentV2, SimulationTeamV2 } from "./simulationV2.js";

export const EXPECTED_OPPONENT_PROFILE_COUNTS: Readonly<Record<EraId, number>> = Object.freeze({
  "era-foundation": 8,
  "era-expansion": 11,
  "era-transition": 10,
  "era-modern-pre-impact": 10,
  "era-impact": 10,
});

const OPPONENT_PATHS: Readonly<Record<EraId, string>> = Object.freeze({
  "era-foundation": "data/processed/era-draft/simulation/v2/foundation_opponents.json",
  "era-expansion": "data/processed/era-draft/simulation/v2/expansion_opponents.json",
  "era-transition": "data/processed/era-draft/simulation/v2/transition_opponents.json",
  "era-modern-pre-impact": "data/processed/era-draft/simulation/v2/modern_pre_impact_opponents.json",
  "era-impact": "data/processed/era-draft/simulation/v2/impact_opponents.json",
});

export type EraOpponentProfileV2 = {
  candidateId: string;
  eraId: EraId;
  franchiseId: string;
  franchiseName?: string;
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
  review: {
    status: "APPROVED";
    reviewedOn: string;
    rationale: string;
    heuristicIsAdvisory: true;
    selectionAuthority?: "HUMAN_APPROVED_MANUAL_REVIEW";
    xiProvenance?: "BASELINE_ACCEPTED" | "REVIEWED_OVERRIDE";
  };
};

export type FoundationOpponentProfileV2 = EraOpponentProfileV2 & { eraId: "era-foundation" };

type RegistryTeam = {
  teamId: string;
  canonicalName: string;
  franchiseId: string;
  activeSeasonIds: readonly string[];
};

type OpponentValidationContext = {
  eras: ReadonlyMap<EraId, EraDefinitionV2>;
  teams: ReadonlyMap<string, RegistryTeam>;
  franchiseIds: ReadonlySet<string>;
  eligibilityIds: ReadonlySet<string>;
  roles: ReadonlyMap<string, PlayerRoleConsumer>;
  qualities: ReadonlyMap<string, PlayerQualityConsumer>;
  roster: ReadonlyMap<string, "INDIAN" | "OVERSEAS" | "UNKNOWN">;
};

export function loadEraEnvironmentsV2(root = process.cwd()): EraEnvironmentV2[] {
  const value = readJson(resolve(root, "data/processed/era-draft/simulation/v2/era_environments.json")) as { environments?: unknown };
  if (!Array.isArray(value.environments) || value.environments.length !== 5) {
    throw new Error("Stage 7 requires exactly five generated era environments.");
  }
  return value.environments.map(parseEnvironment);
}

export function loadAllEraOpponentProfilesV2(
  root = process.cwd(),
): Readonly<Record<EraId, readonly EraOpponentProfileV2[]>> {
  const context = loadOpponentValidationContext(root);
  const pools = {} as Record<EraId, readonly EraOpponentProfileV2[]>;
  for (const eraId of ERA_IDS) {
    const value = readJson(resolve(root, OPPONENT_PATHS[eraId])) as { eraId?: unknown; opponents?: unknown };
    if (value.eraId !== eraId || !Array.isArray(value.opponents)
      || value.opponents.length !== EXPECTED_OPPONENT_PROFILE_COUNTS[eraId]) {
      throw new Error(`${eraId} requires exactly ${EXPECTED_OPPONENT_PROFILE_COUNTS[eraId]} frozen opponent profiles.`);
    }
    const profiles = value.opponents.map((opponent) => parseOpponent(opponent, eraId, context));
    if (new Set(profiles.map((profile) => profile.franchiseId)).size !== profiles.length) {
      throw new Error(`${eraId} opponent profiles must represent distinct canonical franchise lineages.`);
    }
    pools[eraId] = Object.freeze(profiles);
  }
  return Object.freeze(pools);
}

export function loadEraOpponentProfilesV2(eraId: EraId, root = process.cwd()): EraOpponentProfileV2[] {
  return [...loadAllEraOpponentProfilesV2(root)[eraId]];
}

export function loadFoundationOpponentProfilesV2(root = process.cwd()): FoundationOpponentProfileV2[] {
  return loadEraOpponentProfilesV2("era-foundation", root) as FoundationOpponentProfileV2[];
}

export function opponentAsSimulationTeamV2(profile: EraOpponentProfileV2): SimulationTeamV2 {
  return {
    teamId: profile.candidateId,
    displayName: `${profile.teamName} ${profile.seasonId.slice(4)}`,
    strength: {
      batting: profile.evaluation.batting,
      bowling: profile.evaluation.bowling,
      overall: profile.evaluation.overall,
    },
  };
}

export function loadOpponentXiInputV2(
  profile: EraOpponentProfileV2,
  root = process.cwd(),
): EraCompletedXiInput {
  const context = loadOpponentValidationContext(root);
  return opponentXiInput(profile, context);
}

function loadOpponentValidationContext(root: string): OpponentValidationContext {
  const eraRows = (readJson(resolve(root, "data/registries/ipl/v1/eras.json")) as { eras?: unknown }).eras;
  const teamRows = (readJson(resolve(root, "data/registries/ipl/v1/teams.json")) as { teams?: unknown }).teams;
  const franchiseRows = (readJson(resolve(root, "data/registries/ipl/v1/franchises.json")) as { franchises?: unknown }).franchises;
  if (!Array.isArray(eraRows) || !Array.isArray(teamRows) || !Array.isArray(franchiseRows)) {
    throw new Error("Opponent validation requires canonical era, team, and franchise registries.");
  }
  const eras = new Map(eraRows.map((value) => {
    const row = value as { eraId?: unknown; seasonIds?: unknown };
    if (!ERA_IDS.includes(row.eraId as EraId) || !Array.isArray(row.seasonIds)
      || row.seasonIds.some((seasonId) => typeof seasonId !== "string")) {
      throw new Error("Opponent validation encountered an invalid canonical era.");
    }
    return [row.eraId as EraId, { eraId: row.eraId as EraId, seasonIds: row.seasonIds as string[] }] as const;
  }));
  const teams = new Map(teamRows.map((value) => {
    const row = value as Partial<RegistryTeam>;
    if (typeof row.teamId !== "string" || typeof row.canonicalName !== "string"
      || typeof row.franchiseId !== "string" || !Array.isArray(row.activeSeasonIds)) {
      throw new Error("Opponent validation encountered an invalid canonical team.");
    }
    return [row.teamId, row as RegistryTeam] as const;
  }));
  const franchiseIds = new Set(franchiseRows.map((value) => {
    const row = value as { franchiseId?: unknown };
    if (typeof row.franchiseId !== "string") throw new Error("Opponent validation encountered an invalid canonical franchise.");
    return row.franchiseId;
  }));
  const eligibilityRows = readJsonLines(resolve(root, "data/processed/era-draft/v1/eligibility.jsonl"), (value, label) => {
    const row = value as { playerTeamSeasonId?: unknown; eligibilityStatus?: unknown };
    if (typeof row.playerTeamSeasonId !== "string" || !["ELIGIBLE", "INELIGIBLE"].includes(String(row.eligibilityStatus))) {
      throw new Error(`${label} has invalid eligibility data.`);
    }
    return row as { playerTeamSeasonId: string; eligibilityStatus: "ELIGIBLE" | "INELIGIBLE" };
  });
  const roles = readJsonLines(resolve(root, "data/processed/era-draft/roles/v1/player_role_consumer.jsonl"), parsePlayerRoleConsumer);
  const qualities = readJsonLines(resolve(root, "data/processed/era-draft/quality/v1/player_quality_consumer.jsonl"), parsePlayerQualityConsumer);
  const rosterRows = readJsonLines(resolve(root, "data/metadata/ipl/country_overseas/v1/player_team_season_metadata.jsonl"), parseRosterRow);
  return {
    eras,
    teams,
    franchiseIds,
    eligibilityIds: new Set(eligibilityRows.filter((row) => row.eligibilityStatus === "ELIGIBLE").map((row) => row.playerTeamSeasonId)),
    roles: uniqueMap(roles, (row) => row.playerTeamSeasonId, "role"),
    qualities: uniqueMap(qualities, (row) => row.playerTeamSeasonId, "quality"),
    roster: uniqueMap(rosterRows, (row) => row.playerTeamSeasonId, "roster status", (row) => row.iplRosterStatus),
  };
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

function parseOpponent(
  value: unknown,
  expectedEraId: EraId,
  context: OpponentValidationContext,
): EraOpponentProfileV2 {
  const row = value as Partial<EraOpponentProfileV2>;
  if (!row || typeof row !== "object" || row.eraId !== expectedEraId
    || typeof row.candidateId !== "string" || typeof row.franchiseId !== "string"
    || typeof row.teamId !== "string" || typeof row.teamName !== "string" || typeof row.seasonId !== "string"
    || !Array.isArray(row.xi) || row.xi.length !== 11 || row.review?.status !== "APPROVED"
    || !row.evaluation || !Number.isFinite(row.evaluation.overall)) {
    throw new Error(`Invalid frozen opponent profile for ${expectedEraId}.`);
  }
  const era = context.eras.get(expectedEraId);
  const team = context.teams.get(row.teamId);
  if (!era || !era.seasonIds.includes(row.seasonId) || !team || team.franchiseId !== row.franchiseId
    || team.canonicalName !== row.teamName || !team.activeSeasonIds.includes(row.seasonId)
    || !context.franchiseIds.has(row.franchiseId)
    || row.candidateId !== `opponent:${row.teamId}:${row.seasonId}`) {
    throw new Error(`Frozen opponent identity does not match canonical registries: ${row.candidateId}.`);
  }
  if (new Set(row.xi.map((player) => player.playerId)).size !== 11
    || new Set(row.xi.map((player) => player.playerTeamSeasonId)).size !== 11
    || row.xi.some((player, index) => player.position !== index + 1)
    || row.xi.filter((player) => player.rosterStatus === "OVERSEAS").length > 4) {
    throw new Error(`Illegal frozen opponent XI: ${row.candidateId}.`);
  }
  let confirmedKeepers = 0;
  for (const player of row.xi) {
    const role = context.roles.get(player.playerTeamSeasonId);
    const quality = context.qualities.get(player.playerTeamSeasonId);
    const rosterStatus = context.roster.get(player.playerTeamSeasonId);
    if (!context.eligibilityIds.has(player.playerTeamSeasonId) || !role || !quality || !rosterStatus
      || role.playerId !== player.playerId || quality.playerId !== player.playerId
      || role.teamId !== row.teamId || quality.teamId !== row.teamId
      || role.seasonId !== row.seasonId || quality.seasonId !== row.seasonId
      || role.franchiseId !== row.franchiseId || quality.franchiseId !== row.franchiseId
      || role.canonicalDisplayName !== player.displayName || rosterStatus !== player.rosterStatus
      || rosterStatus === "UNKNOWN") {
      throw new Error(`Frozen opponent PTS identity does not join exactly: ${player.playerTeamSeasonId}.`);
    }
    if (role.keeperMetadata.capabilityStatus === "CONFIRMED") confirmedKeepers += 1;
  }
  if (confirmedKeepers < 1) throw new Error(`Frozen opponent XI lacks a confirmed keeper: ${row.candidateId}.`);
  const profile = row as EraOpponentProfileV2;
  const actual = evaluateCompletedEraXi(opponentXiInput(profile, context));
  const expected = {
    battingCore: rounded(actual.baseStrength.battingCore),
    battingDepth: rounded(actual.baseStrength.battingDepth),
    batting: rounded(actual.adjustedStrength.batting),
    bowling: rounded(actual.adjustedStrength.bowling),
    overall: rounded(actual.adjustedStrength.overall),
    structuralBattingOrderEffect: rounded(actual.diagnostics.structuralBattingOrderEffect),
    appliedPositionFitEffect: rounded(actual.diagnostics.appliedPositionFitEffect),
    bowlingCapacity: rounded(actual.diagnostics.bowlingCapacity),
    uncoveredBowlingUnits: rounded(actual.diagnostics.uncoveredBowlingUnits),
  };
  if ((Object.keys(expected) as (keyof typeof expected)[]).some((key) => profile.evaluation[key] !== expected[key])) {
    throw new Error(`Frozen opponent Team Evaluation V2 mismatch: ${row.candidateId}.`);
  }
  return freezeDeep(profile);
}

function opponentXiInput(profile: EraOpponentProfileV2, context: OpponentValidationContext): EraCompletedXiInput {
  const era = required(context.eras, profile.eraId, "era");
  const players = profile.xi.map((item): EraXiPlayerInput => ({
    position: item.position as EraXiPlayerInput["position"],
    role: required(context.roles, item.playerTeamSeasonId, "role"),
    quality: required(context.qualities, item.playerTeamSeasonId, "quality"),
    rosterStatus: required(context.roster, item.playerTeamSeasonId, "roster status"),
  }));
  return { era, players };
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Unable to load frozen Stage 7 JSON ${path}.`, { cause: error });
  }
}

function readJsonLines<T>(path: string, parser: (value: unknown, label: string) => T): T[] {
  return readFileSync(path, "utf8").split("\n").filter(Boolean)
    .map((line, index) => parser(JSON.parse(line), `${path}:${index + 1}`));
}

function parseRosterRow(value: unknown, label: string): {
  playerTeamSeasonId: string;
  iplRosterStatus: "INDIAN" | "OVERSEAS" | "UNKNOWN";
} {
  const row = value as { playerTeamSeasonId?: unknown; iplRosterStatus?: unknown };
  if (typeof row.playerTeamSeasonId !== "string" || !["INDIAN", "OVERSEAS", "UNKNOWN"].includes(String(row.iplRosterStatus))) {
    throw new Error(`${label} has invalid roster metadata.`);
  }
  return row as { playerTeamSeasonId: string; iplRosterStatus: "INDIAN" | "OVERSEAS" | "UNKNOWN" };
}

function uniqueMap<T, V = T>(
  rows: readonly T[],
  key: (row: T) => string,
  label: string,
  value: (row: T) => V = (row) => row as unknown as V,
): Map<string, V> {
  const result = new Map<string, V>();
  for (const row of rows) {
    const id = key(row);
    if (result.has(id)) throw new Error(`Duplicate Stage 7 ${label} ${id}.`);
    result.set(id, value(row));
  }
  return result;
}

function required<K, V>(map: ReadonlyMap<K, V>, id: K, label: string): V {
  const value = map.get(id);
  if (value === undefined) throw new Error(`Missing Stage 7 ${label} ${String(id)}.`);
  return value;
}

function rounded(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function freezeDeep<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) value.forEach(freezeDeep);
  else Object.values(value as Record<string, unknown>).forEach(freezeDeep);
  return Object.freeze(value);
}

export type { PlayerRoleConsumer, PlayerQualityConsumer };
