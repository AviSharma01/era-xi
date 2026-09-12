import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { canonicalJson } from "./eraDraftCanonical.js";
import {
  deriveEraDraftHistoricalStats,
  type EraDraftHistoricalStats,
} from "./eraDraftHistoricalStats.js";

import {
  parsePlayerQualityConsumer,
  PLAYER_QUALITY_CONSUMER_SCHEMA_VERSION,
  PLAYER_QUALITY_MODEL_VERSION,
  type PlayerQualityConsumer,
} from "./playerQualityContract.js";
import {
  parsePlayerRoleConsumer,
  PLAYER_ROLE_CONSUMER_SCHEMA_VERSION,
  ROLE_METADATA_VERSION,
  type PlayerRoleConsumer,
} from "./playerRoleContract.js";
import {
  EXPECTED_OPPONENT_PROFILE_COUNTS,
  loadAllEraOpponentProfilesV2,
  loadEraEnvironmentsV2,
  type EraOpponentProfileV2,
  type FoundationOpponentProfileV2,
} from "./stage7Data.js";
import {
  ERA_IDS,
  evaluateCompletedEraXi,
  TEAM_EVALUATION_V2_VERSION,
  type EraDefinitionV2,
  type EraId,
  type EraXiPlayerInput,
  type IplRosterStatus,
} from "./teamEvaluationV2.js";
import { SIMULATION_V2_VERSION, type EraEnvironmentV2 } from "./simulationV2.js";
import { EraDraftDataError, type TeamSeasonId } from "./eraDraftTypes.js";

const EXPECTED_G2_PROFILES = 2_992;
const EXPECTED_G2_PLAYERS = 727;
const STAGE7_DATA_VERSION = "ipl-era-simulation/v2";
const EXPECTED_TEAM_SEASONS: Readonly<Record<EraId, number>> = {
  "era-foundation": 24,
  "era-expansion": 28,
  "era-transition": 32,
  "era-modern-pre-impact": 42,
  "era-impact": 40,
};

const PATHS = {
  registryManifest: "data/registries/ipl/v1/registry_manifest.json",
  eras: "data/registries/ipl/v1/eras.json",
  seasons: "data/registries/ipl/v1/seasons.json",
  teams: "data/registries/ipl/v1/teams.json",
  franchises: "data/registries/ipl/v1/franchises.json",
  eligibilityManifest: "data/processed/era-draft/v1/eligibility_manifest.json",
  eligibility: "data/processed/era-draft/v1/eligibility.jsonl",
  roleManifest: "data/processed/era-draft/roles/v1/role_manifest.json",
  roles: "data/processed/era-draft/roles/v1/player_role_consumer.jsonl",
  qualityManifest: "data/processed/era-draft/quality/v1/quality_manifest.json",
  qualities: "data/processed/era-draft/quality/v1/player_quality_consumer.jsonl",
  qualityPresentationSource: "data/processed/era-draft/quality/v1/player_team_season_quality.jsonl",
  rosterManifest: "data/metadata/ipl/country_overseas/v1/metadata_manifest.json",
  roster: "data/metadata/ipl/country_overseas/v1/player_team_season_metadata.jsonl",
  simulationManifest: "data/processed/era-draft/simulation/v2/manifest.json",
  phase2Manifest: "data/processed/era-draft/simulation/v2/stage9a_phase2_manifest.json",
  environments: "data/processed/era-draft/simulation/v2/era_environments.json",
  foundationOpponents: "data/processed/era-draft/simulation/v2/foundation_opponents.json",
  expansionOpponents: "data/processed/era-draft/simulation/v2/expansion_opponents.json",
  transitionOpponents: "data/processed/era-draft/simulation/v2/transition_opponents.json",
  modernPreImpactOpponents: "data/processed/era-draft/simulation/v2/modern_pre_impact_opponents.json",
  impactOpponents: "data/processed/era-draft/simulation/v2/impact_opponents.json",
} as const;

const OPPONENT_PATHS: Readonly<Record<EraId, string>> = {
  "era-foundation": PATHS.foundationOpponents,
  "era-expansion": PATHS.expansionOpponents,
  "era-transition": PATHS.transitionOpponents,
  "era-modern-pre-impact": PATHS.modernPreImpactOpponents,
  "era-impact": PATHS.impactOpponents,
};

export type EraDraftEra = EraDefinitionV2 & {
  readonly label: string;
};

export type EraDraftEligibilityRow = {
  readonly schemaVersion: "ipl-era-draft-eligibility-row/v1";
  readonly eligibilityVersion: "ipl-era-draft-eligibility/v1";
  readonly playerTeamSeasonId: string;
  readonly playerId: string;
  readonly canonicalDisplayName: string;
  readonly seasonId: string;
  readonly teamId: string;
  readonly eligibilityStatus: "ELIGIBLE" | "INELIGIBLE";
};

export type EraDraftRosterRow = {
  readonly schemaVersion: "ipl-country-overseas-pts-row/v3";
  readonly metadataVersion: "ipl-country-overseas-metadata/v1";
  readonly playerTeamSeasonId: string;
  readonly playerId: string;
  readonly canonicalDisplayName: string;
  readonly seasonId: string;
  readonly teamId: string;
  readonly iplRosterStatus: IplRosterStatus;
  readonly reviewState: "APPROVED" | "PENDING" | "ROSTER_APPROVED_NATION_UNRESOLVED";
};

export type EraDraftPlayerRecord = {
  readonly playerTeamSeasonId: string;
  readonly playerId: string;
  readonly canonicalDisplayName: string;
  readonly seasonId: string;
  readonly seasonYear: number;
  readonly eraId: EraId;
  readonly teamId: string;
  readonly teamName: string;
  readonly franchiseId: string;
  readonly franchiseName: string;
  readonly teamSeasonId: TeamSeasonId;
  readonly eligibility: EraDraftEligibilityRow;
  readonly role: PlayerRoleConsumer;
  readonly quality: PlayerQualityConsumer;
  readonly historicalStats: EraDraftHistoricalStats;
  readonly rosterStatus: Exclude<IplRosterStatus, "UNKNOWN">;
};

export type EraDraftTeamSeason = {
  readonly teamSeasonId: TeamSeasonId;
  readonly eraId: EraId;
  readonly seasonId: string;
  readonly seasonYear: number;
  readonly teamId: string;
  readonly teamName: string;
  readonly franchiseId: string;
  readonly franchiseName: string;
};

export type SimulationContentAvailability =
  | { readonly status: "AVAILABLE"; readonly opponentCount: number }
  | { readonly status: "UNAVAILABLE"; readonly opponentCount: 0 };

export type EraDraftCatalogDiagnostics = {
  readonly eligibleProfiles: number;
  readonly canonicalPlayers: number;
  readonly eras: number;
  readonly environments: number;
  readonly foundationOpponents: number;
  readonly opponentsByEra: Readonly<Record<EraId, number>>;
  readonly unknownG2RosterStatuses: number;
  readonly teamSeasonsByEra: Readonly<Record<EraId, number>>;
  readonly simulationContentByEra: Readonly<Record<EraId, SimulationContentAvailability>>;
  readonly sourceFiles: readonly string[];
  readonly fingerprint: string;
};

export interface EraDraftCatalog {
  readonly fingerprint: string;
  readonly diagnostics: EraDraftCatalogDiagnostics;
  getEra(eraId: EraId): EraDraftEra | undefined;
  getEraIds(): readonly EraId[];
  getEraForSeason(seasonId: string): EraId | undefined;
  getTeamSeason(teamSeasonId: TeamSeasonId): EraDraftTeamSeason | undefined;
  getTeamSeasonsForEra(eraId: EraId): readonly EraDraftTeamSeason[];
  getEligibilityRow(playerTeamSeasonId: string): EraDraftEligibilityRow | undefined;
  getPlayer(playerTeamSeasonId: string): EraDraftPlayerRecord | undefined;
  getCandidatesForTeamSeason(teamSeasonId: TeamSeasonId): readonly EraDraftPlayerRecord[];
  getPlayerVariantsForEra(eraId: EraId, playerId: string): readonly EraDraftPlayerRecord[];
  getKeeperCapablePlayerIds(eraId: EraId): readonly string[];
  getSimulationContent(eraId: EraId): SimulationContentAvailability;
  getEnvironment(eraId: EraId): EraEnvironmentV2 | undefined;
  getOpponentProfiles(eraId: EraId): readonly EraOpponentProfileV2[];
  getFoundationOpponents(): readonly FoundationOpponentProfileV2[];
}

type RegistrySeason = { readonly seasonId: string; readonly displayYear: number; readonly eraIds: readonly string[] };
type RegistryTeam = { readonly teamId: string; readonly canonicalName: string; readonly franchiseId: string; readonly activeSeasonIds: readonly string[] };
type RegistryFranchise = { readonly franchiseId: string; readonly canonicalName: string };

export type EraDraftCatalogVersions = {
  readonly registryVersion: string;
  readonly eligibilityVersion: string;
  readonly roleSchemaVersion: string;
  readonly roleMetadataVersion: string;
  readonly qualitySchemaVersion: string;
  readonly qualityModelVersion: string;
  readonly rosterMetadataVersion: string;
  readonly simulationDataVersion: string;
  readonly teamEvaluationVersion: string;
  readonly simulationVersion: string;
};

export type EraDraftCatalogFingerprintInput = {
  readonly runtimeVersions: {
    readonly simulationVersion: string;
    readonly teamEvaluationVersion: string;
  };
  readonly sources: readonly {
    readonly relativePath: string;
    readonly sha256: string;
  }[];
};

export type EraDraftCatalogDocuments = {
  readonly fingerprint: string;
  readonly fingerprintInput: EraDraftCatalogFingerprintInput;
  readonly sourceFiles: readonly string[];
  readonly versions: EraDraftCatalogVersions;
  readonly eras: readonly EraDraftEra[];
  readonly seasons: readonly RegistrySeason[];
  readonly teams: readonly RegistryTeam[];
  readonly franchises: readonly RegistryFranchise[];
  readonly eligibility: readonly EraDraftEligibilityRow[];
  readonly roles: readonly PlayerRoleConsumer[];
  readonly qualities: readonly PlayerQualityConsumer[];
  readonly historicalStats: readonly EraDraftHistoricalStats[];
  readonly roster: readonly EraDraftRosterRow[];
  readonly environments: readonly EraEnvironmentV2[];
  readonly opponentProfiles: readonly EraOpponentProfileV2[];
  readonly foundationOpponents: readonly FoundationOpponentProfileV2[];
  readonly opponentContentEraIds: readonly string[];
};

type SourceFile = { readonly relativePath: string; readonly content: string; readonly sha256: string };

export function loadEraDraftCatalog(root = process.cwd()): EraDraftCatalog {
  return buildEraDraftCatalog(loadEraDraftCatalogDocuments(root));
}

export function loadEraDraftCatalogDocuments(root = process.cwd()): EraDraftCatalogDocuments {
  const loaded = new Map<string, SourceFile>();
  const source = (relativePath: string): SourceFile => {
    const existing = loaded.get(relativePath);
    if (existing) return existing;
    let content: string;
    try {
      content = readFileSync(resolve(root, relativePath), "utf8");
    } catch (error) {
      throw new EraDraftDataError("MISSING_SOURCE_FILE", `Missing Era Draft source file ${relativePath}.`, { relativePath }, { cause: error });
    }
    const result = { relativePath, content, sha256: sha256(content) };
    loaded.set(relativePath, result);
    return result;
  };

  const registryManifest = jsonDocument(source(PATHS.registryManifest), "registry manifest");
  requireVersion(registryManifest, "schemaVersion", "1.0.0", "registry manifest");
  requireVersion(registryManifest, "registryVersion", "ipl-identities-v1", "registry manifest");
  for (const path of [PATHS.eras, PATHS.seasons, PATHS.teams, PATHS.franchises]) {
    verifyListedFile(source(path), registryManifest.generatedFiles, path.split("/").at(-1)!, "registry manifest");
  }

  const eligibilityManifest = jsonDocument(source(PATHS.eligibilityManifest), "eligibility manifest");
  requireVersion(eligibilityManifest, "schemaVersion", "ipl-era-draft-eligibility-manifest/v1", "eligibility manifest");
  requireVersion(eligibilityManifest, "eligibilityVersion", "ipl-era-draft-eligibility/v1", "eligibility manifest");
  verifyListedFile(source(PATHS.eligibility), eligibilityManifest.artifacts, "eligibility.jsonl", "eligibility manifest");

  const roleManifest = jsonDocument(source(PATHS.roleManifest), "role manifest");
  requireVersion(roleManifest, "schemaVersion", "ipl-era-draft-player-role-manifest/v1", "role manifest");
  requireVersion(roleManifest, "roleMetadataVersion", ROLE_METADATA_VERSION, "role manifest");
  verifyListedFile(source(PATHS.roles), roleManifest.artifacts, "player_role_consumer.jsonl", "role manifest");

  const qualityManifest = jsonDocument(source(PATHS.qualityManifest), "quality manifest");
  requireVersion(qualityManifest, "schemaVersion", "ipl-era-draft-player-quality-manifest/v1", "quality manifest");
  requireVersion(qualityManifest, "qualityModelVersion", PLAYER_QUALITY_MODEL_VERSION, "quality manifest");
  verifyListedFile(source(PATHS.qualities), qualityManifest.artifacts, "player_quality_consumer.jsonl", "quality manifest");

  const rosterManifest = jsonDocument(source(PATHS.rosterManifest), "roster manifest");
  requireVersion(rosterManifest, "schemaVersion", "ipl-country-overseas-manifest/v1", "roster manifest");
  requireVersion(rosterManifest, "metadataVersion", "ipl-country-overseas-metadata/v1", "roster manifest");
  verifyListedFile(source(PATHS.roster), rosterManifest.artifacts, "player_team_season_metadata.jsonl", "roster manifest");

  const simulationManifest = jsonDocument(source(PATHS.simulationManifest), "simulation manifest");
  requireVersion(simulationManifest, "schemaVersion", STAGE7_DATA_VERSION, "simulation manifest");
  const stage7OpponentContentEraIds = stringArray(simulationManifest.opponentContentEraIds, "simulation manifest opponentContentEraIds");
  if (stage7OpponentContentEraIds.length !== 1 || stage7OpponentContentEraIds[0] !== "era-foundation") {
    throw new EraDraftDataError("INVALID_STAGE7_MANIFEST", "The frozen Stage 7 manifest must describe only Foundation opponent content.");
  }

  source(PATHS.environments);
  source(PATHS.foundationOpponents);
  const inputHashes = record(simulationManifest.inputHashes, "simulation manifest inputHashes");
  for (const path of [PATHS.eras, PATHS.roles, PATHS.qualities, PATHS.roster]) {
    if (inputHashes[path] !== source(path).sha256) {
      throw new EraDraftDataError("STAGE7_INPUT_MISMATCH", `Stage 7 input hash differs for ${path}.`, { path });
    }
  }

  const phase2Manifest = jsonDocument(source(PATHS.phase2Manifest), "Stage 9A Phase 2 manifest");
  requireVersion(phase2Manifest, "schemaVersion", "ipl-era-opponent-content-phase2-manifest/v1", "Stage 9A Phase 2 manifest");
  requireVersion(phase2Manifest, "contentVersion", "ipl-era-opponent-content-phase2/v1", "Stage 9A Phase 2 manifest");
  if (phase2Manifest.totalLaterEraProfiles !== 41 || phase2Manifest.totalProfilesIncludingFoundation !== 49
    || phase2Manifest.unresolvedReviewCount !== 0) {
    throw new EraDraftDataError("INVALID_PHASE2_MANIFEST", "Stage 9A Phase 2 manifest does not describe the frozen 41-profile review result.");
  }
  if (phase2Manifest.foundationOpponentArtifactSha256 !== source(PATHS.foundationOpponents).sha256) {
    throw new EraDraftDataError("FOUNDATION_ARTIFACT_MISMATCH", "The Phase 2 manifest does not reference the frozen Foundation artifact.");
  }
  for (const eraId of ERA_IDS.filter((value) => value !== "era-foundation")) {
    const path = OPPONENT_PATHS[eraId];
    verifyListedFile(source(path), phase2Manifest.artifacts, path.split("/").at(-1)!, "Stage 9A Phase 2 manifest");
  }

  const erasDoc = jsonDocument(source(PATHS.eras), "era registry");
  const seasonsDoc = jsonDocument(source(PATHS.seasons), "season registry");
  const teamsDoc = jsonDocument(source(PATHS.teams), "team registry");
  const franchisesDoc = jsonDocument(source(PATHS.franchises), "franchise registry");

  let environments: EraEnvironmentV2[];
  let opponentProfilesByEra: Readonly<Record<EraId, readonly EraOpponentProfileV2[]>>;
  try {
    environments = loadEraEnvironmentsV2(root);
    opponentProfilesByEra = loadAllEraOpponentProfilesV2(root);
  } catch (error) {
    throw new EraDraftDataError("INVALID_SIMULATION_CONTENT", "Era environments or frozen all-era opponents are invalid.", {}, { cause: error });
  }
  const opponentProfiles = ERA_IDS.flatMap((eraId) => opponentProfilesByEra[eraId]);
  const foundationOpponents = opponentProfilesByEra["era-foundation"] as readonly FoundationOpponentProfileV2[];

  const fingerprintSources = [...loaded.values()]
    .map(({ relativePath, sha256: hash }) => ({ relativePath, sha256: hash }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const fingerprintInput = canonicalFingerprintInput({
    runtimeVersions: {
      simulationVersion: SIMULATION_V2_VERSION,
      teamEvaluationVersion: TEAM_EVALUATION_V2_VERSION,
    },
    sources: fingerprintSources,
  });
  const fingerprint = computeEraDraftCatalogFingerprint(fingerprintInput);
  // This presentation-only source is already content-bound by the quality
  // manifest above. Read it after fingerprint construction so adding a public
  // view of existing Stage 4 totals does not alter the frozen game catalog ID.
  const qualityPresentationSource = readSourceFile(root, PATHS.qualityPresentationSource);
  verifyListedFile(
    qualityPresentationSource,
    qualityManifest.artifacts,
    "player_team_season_quality.jsonl",
    "quality manifest",
  );

  return freezeDeep({
    fingerprint,
    fingerprintInput,
    sourceFiles: fingerprintSources.map((item) => item.relativePath),
    versions: {
      registryVersion: requiredString(registryManifest.registryVersion, "registry version"),
      eligibilityVersion: requiredString(eligibilityManifest.eligibilityVersion, "eligibility version"),
      roleSchemaVersion: PLAYER_ROLE_CONSUMER_SCHEMA_VERSION,
      roleMetadataVersion: ROLE_METADATA_VERSION,
      qualitySchemaVersion: PLAYER_QUALITY_CONSUMER_SCHEMA_VERSION,
      qualityModelVersion: PLAYER_QUALITY_MODEL_VERSION,
      rosterMetadataVersion: requiredString(rosterManifest.metadataVersion, "roster metadata version"),
      simulationDataVersion: STAGE7_DATA_VERSION,
      teamEvaluationVersion: TEAM_EVALUATION_V2_VERSION,
      simulationVersion: SIMULATION_V2_VERSION,
    },
    eras: parseEras(erasDoc),
    seasons: parseSeasons(seasonsDoc),
    teams: parseTeams(teamsDoc),
    franchises: parseFranchises(franchisesDoc),
    eligibility: jsonLines(source(PATHS.eligibility), parseEligibility),
    roles: jsonLines(source(PATHS.roles), (value, label) => parsePlayerRoleConsumer(value, label)),
    qualities: jsonLines(source(PATHS.qualities), (value, label) => parsePlayerQualityConsumer(value, label)),
    historicalStats: jsonLines(qualityPresentationSource, deriveEraDraftHistoricalStats),
    roster: jsonLines(source(PATHS.roster), parseRoster),
    environments,
    opponentProfiles,
    foundationOpponents,
    opponentContentEraIds: [...ERA_IDS],
  });
}

export function buildEraDraftCatalog(documents: EraDraftCatalogDocuments): EraDraftCatalog {
  validateVersions(documents.versions);
  const eraById = uniqueMap(documents.eras, (item) => item.eraId, "era ID");
  assertExactSet([...eraById.keys()], ERA_IDS, "era IDs");

  const seasonById = uniqueMap(documents.seasons, (item) => item.seasonId, "season ID");
  const teamById = uniqueMap(documents.teams, (item) => item.teamId, "team ID");
  const franchiseById = uniqueMap(documents.franchises, (item) => item.franchiseId, "franchise ID");
  const eraBySeason = new Map<string, EraId>();
  for (const eraId of ERA_IDS) {
    const era = required(eraById, eraId, "era");
    if (era.seasonIds.length === 0) throw new EraDraftDataError("EMPTY_ERA", `${eraId} has no seasons.`);
    for (const seasonId of era.seasonIds) {
      const season = required(seasonById, seasonId, "season");
      if (season.eraIds.length !== 1 || season.eraIds[0] !== eraId) {
        throw new EraDraftDataError("ERA_MEMBERSHIP_MISMATCH", `${seasonId} disagrees with ${eraId}.`);
      }
      if (eraBySeason.has(seasonId)) throw new EraDraftDataError("DUPLICATE_ERA_MEMBERSHIP", `${seasonId} belongs to multiple eras.`);
      eraBySeason.set(seasonId, eraId);
    }
  }

  const eligibilityById = uniqueMap(documents.eligibility, (item) => item.playerTeamSeasonId, "eligibility PTS ID");
  const eligible = documents.eligibility.filter((row) => row.eligibilityStatus === "ELIGIBLE");
  const eligibleIds = eligible.map((row) => row.playerTeamSeasonId).sort();
  const roleById = uniqueMap(documents.roles, (item) => item.playerTeamSeasonId, "role PTS ID");
  const qualityById = uniqueMap(documents.qualities, (item) => item.playerTeamSeasonId, "quality PTS ID");
  const historicalStatsById = uniqueMap(documents.historicalStats, (item) => item.playerTeamSeasonId, "historical stats PTS ID");
  const rosterById = uniqueMap(documents.roster, (item) => item.playerTeamSeasonId, "roster PTS ID");
  assertExactSet([...roleById.keys()], eligibleIds, "Stage 5/G2 PTS IDs");
  assertExactSet([...qualityById.keys()], eligibleIds, "Stage 6/G2 PTS IDs");
  assertExactSet([...historicalStatsById.keys()], eligibleIds, "historical stats/G2 PTS IDs");
  if (eligibilityById.size !== documents.eligibility.length) {
    throw new EraDraftDataError("DUPLICATE_ID", "Eligibility IDs are not unique.");
  }
  if (eligible.length !== EXPECTED_G2_PROFILES) {
    throw new EraDraftDataError("G2_PROFILE_COUNT_MISMATCH", `Expected ${EXPECTED_G2_PROFILES} G2 profiles, found ${eligible.length}.`);
  }
  const canonicalPlayers = new Set(eligible.map((row) => row.playerId));
  if (canonicalPlayers.size !== EXPECTED_G2_PLAYERS) {
    throw new EraDraftDataError("G2_PLAYER_COUNT_MISMATCH", `Expected ${EXPECTED_G2_PLAYERS} G2 players, found ${canonicalPlayers.size}.`);
  }

  const playerById = new Map<string, EraDraftPlayerRecord>();
  const candidatesByTeamSeason = new Map<TeamSeasonId, EraDraftPlayerRecord[]>();
  const variantsByEraPlayer = new Map<string, EraDraftPlayerRecord[]>();
  const keeperIdsByEra = new Map<EraId, Set<string>>(ERA_IDS.map((eraId) => [eraId, new Set()]));

  for (const eligibility of eligible) {
    const role = required(roleById, eligibility.playerTeamSeasonId, "Stage 5 role");
    const quality = required(qualityById, eligibility.playerTeamSeasonId, "Stage 6 quality");
    const historicalStats = required(historicalStatsById, eligibility.playerTeamSeasonId, "historical stats");
    const roster = required(rosterById, eligibility.playerTeamSeasonId, "roster metadata");
    assertPlayerIdentity(eligibility, role, quality, roster);
    assertHistoricalStatsIdentity(eligibility, historicalStats);
    if (roster.reviewState !== "APPROVED" && roster.reviewState !== "ROSTER_APPROVED_NATION_UNRESOLVED") {
      throw new EraDraftDataError("UNAPPROVED_G2_ROSTER_METADATA", `${eligibility.playerTeamSeasonId} does not have approved IPL roster metadata.`);
    }
    if (roster.iplRosterStatus === "UNKNOWN") {
      throw new EraDraftDataError("UNKNOWN_G2_ROSTER_STATUS", `${eligibility.playerTeamSeasonId} has UNKNOWN IPL roster status.`);
    }
    const eraId = eraBySeason.get(eligibility.seasonId);
    if (!eraId) throw new EraDraftDataError("UNKNOWN_ERA_MEMBERSHIP", `${eligibility.seasonId} is not assigned to an era.`);
    const season = required(seasonById, eligibility.seasonId, "season");
    const team = required(teamById, eligibility.teamId, "team");
    const franchise = required(franchiseById, team.franchiseId, "franchise");
    if (!team.activeSeasonIds.includes(eligibility.seasonId)) {
      throw new EraDraftDataError("INACTIVE_TEAM_SEASON", `${team.teamId} is not active in ${eligibility.seasonId}.`);
    }
    if (role.franchiseId !== team.franchiseId || quality.franchiseId !== team.franchiseId) {
      throw new EraDraftDataError("FRANCHISE_IDENTITY_MISMATCH", `${eligibility.playerTeamSeasonId} has inconsistent franchise identity.`);
    }
    const teamSeasonId = makeTeamSeasonId(team.teamId, season.seasonId);
    const player = freezeDeep({
      playerTeamSeasonId: eligibility.playerTeamSeasonId,
      playerId: eligibility.playerId,
      canonicalDisplayName: eligibility.canonicalDisplayName,
      seasonId: season.seasonId,
      seasonYear: season.displayYear,
      eraId,
      teamId: team.teamId,
      teamName: team.canonicalName,
      franchiseId: franchise.franchiseId,
      franchiseName: franchise.canonicalName,
      teamSeasonId,
      eligibility,
      role,
      quality,
      historicalStats,
      rosterStatus: roster.iplRosterStatus,
    } satisfies EraDraftPlayerRecord);
    playerById.set(player.playerTeamSeasonId, player);
    pushMap(candidatesByTeamSeason, teamSeasonId, player);
    pushMap(variantsByEraPlayer, `${eraId}\u001f${player.playerId}`, player);
    if (role.keeperMetadata.capabilityStatus === "CONFIRMED") keeperIdsByEra.get(eraId)!.add(player.playerId);
  }

  const teamSeasonById = new Map<TeamSeasonId, EraDraftTeamSeason>();
  const teamSeasonsByEra = new Map<EraId, EraDraftTeamSeason[]>(ERA_IDS.map((eraId) => [eraId, []]));
  for (const [teamSeasonId, candidates] of candidatesByTeamSeason) {
    candidates.sort((left, right) => left.playerTeamSeasonId.localeCompare(right.playerTeamSeasonId));
    const first = candidates[0]!;
    const identity = freezeDeep({
      teamSeasonId,
      eraId: first.eraId,
      seasonId: first.seasonId,
      seasonYear: first.seasonYear,
      teamId: first.teamId,
      teamName: first.teamName,
      franchiseId: first.franchiseId,
      franchiseName: first.franchiseName,
    } satisfies EraDraftTeamSeason);
    if (candidates.some((candidate) => candidate.teamSeasonId !== teamSeasonId || candidate.eraId !== identity.eraId)) {
      throw new EraDraftDataError("TEAM_SEASON_IDENTITY_MISMATCH", `${teamSeasonId} contains inconsistent candidates.`);
    }
    teamSeasonById.set(teamSeasonId, identity);
    teamSeasonsByEra.get(identity.eraId)!.push(identity);
    Object.freeze(candidates);
  }

  const teamSeasonCounts = {} as Record<EraId, number>;
  for (const eraId of ERA_IDS) {
    const items = teamSeasonsByEra.get(eraId)!;
    items.sort((left, right) => left.teamSeasonId.localeCompare(right.teamSeasonId));
    Object.freeze(items);
    teamSeasonCounts[eraId] = items.length;
    if (items.length !== EXPECTED_TEAM_SEASONS[eraId]) {
      throw new EraDraftDataError("TEAM_SEASON_COUNT_MISMATCH", `${eraId} expected ${EXPECTED_TEAM_SEASONS[eraId]} team-seasons, found ${items.length}.`);
    }
  }
  for (const variants of variantsByEraPlayer.values()) {
    variants.sort((left, right) => left.playerTeamSeasonId.localeCompare(right.playerTeamSeasonId));
    Object.freeze(variants);
  }

  const environmentByEra = uniqueMap(documents.environments, (item) => item.eraId, "environment era ID");
  assertExactSet([...environmentByEra.keys()], ERA_IDS, "Stage 7 environment eras");
  for (const eraId of ERA_IDS) {
    const environment = required(environmentByEra, eraId, "era environment");
    const era = required(eraById, eraId, "era");
    assertExactSet([...environment.seasonIds], [...era.seasonIds], `${eraId} environment seasons`);
  }
  assertExactSet(documents.opponentContentEraIds, ERA_IDS, "opponent-content era IDs");
  const opponentsByEra = new Map<EraId, EraOpponentProfileV2[]>(ERA_IDS.map((eraId) => [eraId, []]));
  const opponentById = uniqueMap(documents.opponentProfiles, (item) => item.candidateId, "opponent candidate ID");
  for (const profile of documents.opponentProfiles) {
    validateOpponentProfile(profile, eraById, teamById, franchiseById, playerById);
    opponentsByEra.get(profile.eraId)!.push(profile);
  }
  for (const eraId of ERA_IDS) {
    const profiles = opponentsByEra.get(eraId)!;
    const expectedCount = EXPECTED_OPPONENT_PROFILE_COUNTS[eraId];
    if (profiles.length !== expectedCount) {
      throw new EraDraftDataError("OPPONENT_COUNT_MISMATCH", `${eraId} expected ${expectedCount} frozen opponents, found ${profiles.length}.`);
    }
    if (new Set(profiles.map((profile) => profile.franchiseId)).size !== profiles.length) {
      throw new EraDraftDataError("DUPLICATE_OPPONENT_LINEAGE", `${eraId} opponents must represent distinct canonical franchise lineages.`);
    }
    if (eraId === "era-foundation") profiles.sort((left, right) => left.candidateId.localeCompare(right.candidateId));
    Object.freeze(profiles);
  }
  if (documents.foundationOpponents.length !== EXPECTED_OPPONENT_PROFILE_COUNTS["era-foundation"]
    || documents.foundationOpponents.some((profile) => {
      const authoritative = opponentById.get(profile.candidateId);
      return !authoritative || canonicalJson(authoritative) !== canonicalJson(profile);
    })) {
    throw new EraDraftDataError("FOUNDATION_OPPONENT_ALIAS_MISMATCH", "Foundation opponent compatibility view must reference the all-era Foundation pool exactly.");
  }

  const simulationContentByEra = Object.fromEntries(ERA_IDS.map((eraId) => [eraId, {
    status: "AVAILABLE" as const,
    opponentCount: opponentsByEra.get(eraId)!.length,
  }])) as Record<EraId, SimulationContentAvailability>;
  const opponentsByEraCounts = Object.fromEntries(ERA_IDS.map((eraId) => [
    eraId,
    opponentsByEra.get(eraId)!.length,
  ])) as Record<EraId, number>;
  const diagnostics = freezeDeep({
    eligibleProfiles: eligible.length,
    canonicalPlayers: canonicalPlayers.size,
    eras: eraById.size,
    environments: environmentByEra.size,
    foundationOpponents: opponentsByEraCounts["era-foundation"],
    opponentsByEra: opponentsByEraCounts,
    unknownG2RosterStatuses: 0,
    teamSeasonsByEra: teamSeasonCounts,
    simulationContentByEra,
    sourceFiles: [...documents.sourceFiles],
    fingerprint: documents.fingerprint,
  } satisfies EraDraftCatalogDiagnostics);

  return new EraDraftCatalogImpl({
    fingerprint: documents.fingerprint,
    diagnostics,
    eraById,
    eraBySeason,
    teamSeasonById,
    teamSeasonsByEra,
    eligibilityById,
    playerById,
    candidatesByTeamSeason,
    variantsByEraPlayer,
    keeperIdsByEra,
    simulationContentByEra,
    environmentByEra,
    opponentsByEra,
  });
}

class EraDraftCatalogImpl implements EraDraftCatalog {
  readonly fingerprint: string;
  readonly diagnostics: EraDraftCatalogDiagnostics;
  readonly #eraById: ReadonlyMap<EraId, EraDraftEra>;
  readonly #eraBySeason: ReadonlyMap<string, EraId>;
  readonly #teamSeasonById: ReadonlyMap<TeamSeasonId, EraDraftTeamSeason>;
  readonly #teamSeasonsByEra: ReadonlyMap<EraId, readonly EraDraftTeamSeason[]>;
  readonly #eligibilityById: ReadonlyMap<string, EraDraftEligibilityRow>;
  readonly #playerById: ReadonlyMap<string, EraDraftPlayerRecord>;
  readonly #candidatesByTeamSeason: ReadonlyMap<TeamSeasonId, readonly EraDraftPlayerRecord[]>;
  readonly #variantsByEraPlayer: ReadonlyMap<string, readonly EraDraftPlayerRecord[]>;
  readonly #keeperIdsByEra: ReadonlyMap<EraId, ReadonlySet<string>>;
  readonly #simulationContentByEra: Readonly<Record<EraId, SimulationContentAvailability>>;
  readonly #environmentByEra: ReadonlyMap<EraId, EraEnvironmentV2>;
  readonly #opponentsByEra: ReadonlyMap<EraId, readonly EraOpponentProfileV2[]>;

  constructor(input: {
    fingerprint: string;
    diagnostics: EraDraftCatalogDiagnostics;
    eraById: Map<EraId, EraDraftEra>;
    eraBySeason: Map<string, EraId>;
    teamSeasonById: Map<TeamSeasonId, EraDraftTeamSeason>;
    teamSeasonsByEra: Map<EraId, EraDraftTeamSeason[]>;
    eligibilityById: Map<string, EraDraftEligibilityRow>;
    playerById: Map<string, EraDraftPlayerRecord>;
    candidatesByTeamSeason: Map<TeamSeasonId, EraDraftPlayerRecord[]>;
    variantsByEraPlayer: Map<string, EraDraftPlayerRecord[]>;
    keeperIdsByEra: Map<EraId, Set<string>>;
    simulationContentByEra: Readonly<Record<EraId, SimulationContentAvailability>>;
    environmentByEra: Map<EraId, EraEnvironmentV2>;
    opponentsByEra: Map<EraId, EraOpponentProfileV2[]>;
  }) {
    this.fingerprint = input.fingerprint;
    this.diagnostics = input.diagnostics;
    this.#eraById = input.eraById;
    this.#eraBySeason = input.eraBySeason;
    this.#teamSeasonById = input.teamSeasonById;
    this.#teamSeasonsByEra = input.teamSeasonsByEra;
    this.#eligibilityById = input.eligibilityById;
    this.#playerById = input.playerById;
    this.#candidatesByTeamSeason = input.candidatesByTeamSeason;
    this.#variantsByEraPlayer = input.variantsByEraPlayer;
    this.#keeperIdsByEra = input.keeperIdsByEra;
    this.#simulationContentByEra = input.simulationContentByEra;
    this.#environmentByEra = input.environmentByEra;
    this.#opponentsByEra = input.opponentsByEra;
    Object.freeze(this);
  }

  getEra(eraId: EraId): EraDraftEra | undefined { return this.#eraById.get(eraId); }
  getEraIds(): readonly EraId[] { return ERA_IDS; }
  getEraForSeason(seasonId: string): EraId | undefined { return this.#eraBySeason.get(seasonId); }
  getTeamSeason(teamSeasonId: TeamSeasonId): EraDraftTeamSeason | undefined { return this.#teamSeasonById.get(teamSeasonId); }
  getTeamSeasonsForEra(eraId: EraId): readonly EraDraftTeamSeason[] { return this.#teamSeasonsByEra.get(eraId) ?? []; }
  getEligibilityRow(playerTeamSeasonId: string): EraDraftEligibilityRow | undefined { return this.#eligibilityById.get(playerTeamSeasonId); }
  getPlayer(playerTeamSeasonId: string): EraDraftPlayerRecord | undefined { return this.#playerById.get(playerTeamSeasonId); }
  getCandidatesForTeamSeason(teamSeasonId: TeamSeasonId): readonly EraDraftPlayerRecord[] { return this.#candidatesByTeamSeason.get(teamSeasonId) ?? []; }
  getPlayerVariantsForEra(eraId: EraId, playerId: string): readonly EraDraftPlayerRecord[] { return this.#variantsByEraPlayer.get(`${eraId}\u001f${playerId}`) ?? []; }
  getKeeperCapablePlayerIds(eraId: EraId): readonly string[] { return Object.freeze([...(this.#keeperIdsByEra.get(eraId) ?? [])].sort()); }
  getSimulationContent(eraId: EraId): SimulationContentAvailability { return this.#simulationContentByEra[eraId]; }
  getEnvironment(eraId: EraId): EraEnvironmentV2 | undefined { return this.#environmentByEra.get(eraId); }
  getOpponentProfiles(eraId: EraId): readonly EraOpponentProfileV2[] { return this.#opponentsByEra.get(eraId) ?? []; }
  getFoundationOpponents(): readonly FoundationOpponentProfileV2[] {
    return this.getOpponentProfiles("era-foundation") as readonly FoundationOpponentProfileV2[];
  }
}

function validateOpponentProfile(
  profile: EraOpponentProfileV2,
  eraById: ReadonlyMap<EraId, EraDraftEra>,
  teamById: ReadonlyMap<string, RegistryTeam>,
  franchiseById: ReadonlyMap<string, RegistryFranchise>,
  playerById: ReadonlyMap<string, EraDraftPlayerRecord>,
): void {
  const era = required(eraById, profile.eraId, "opponent era");
  const team = required(teamById, profile.teamId, "opponent team");
  const franchise = required(franchiseById, profile.franchiseId, "opponent franchise");
  if (profile.candidateId !== `opponent:${profile.teamId}:${profile.seasonId}`
    || team.franchiseId !== profile.franchiseId || team.canonicalName !== profile.teamName
    || (profile.franchiseName !== undefined && profile.franchiseName !== franchise.canonicalName)
    || !team.activeSeasonIds.includes(profile.seasonId) || !era.seasonIds.includes(profile.seasonId)) {
    throw new EraDraftDataError("OPPONENT_IDENTITY_MISMATCH", `${profile.candidateId} disagrees with canonical team, franchise, season, or era identity.`);
  }
  if (profile.review.status !== "APPROVED" || profile.xi.length !== 11
    || new Set(profile.xi.map((item) => item.playerTeamSeasonId)).size !== 11
    || new Set(profile.xi.map((item) => item.playerId)).size !== 11
    || profile.xi.some((item, index) => item.position !== index + 1)) {
    throw new EraDraftDataError("ILLEGAL_OPPONENT_XI", `${profile.candidateId} is not an approved, ordered, unique XI.`);
  }
  let confirmedKeepers = 0;
  const xiPlayers = profile.xi.map((item): EraXiPlayerInput => {
    const player = required(playerById, item.playerTeamSeasonId, "opponent player");
    if (player.playerId !== item.playerId || player.canonicalDisplayName !== item.displayName
      || player.teamId !== profile.teamId || player.franchiseId !== profile.franchiseId
      || player.seasonId !== profile.seasonId || player.eraId !== profile.eraId
      || player.rosterStatus !== item.rosterStatus || !Number.isInteger(item.officialListMatchCount)
      || item.officialListMatchCount < 0) {
      throw new EraDraftDataError("OPPONENT_PLAYER_IDENTITY_MISMATCH", `${item.playerTeamSeasonId} does not join exactly to ${profile.candidateId}.`);
    }
    if (player.role.keeperMetadata.capabilityStatus === "CONFIRMED") confirmedKeepers += 1;
    return {
      position: item.position as EraXiPlayerInput["position"],
      role: player.role,
      quality: player.quality,
      rosterStatus: player.rosterStatus,
    };
  });
  if (confirmedKeepers < 1 || xiPlayers.filter((item) => item.rosterStatus === "OVERSEAS").length > 4) {
    throw new EraDraftDataError("ILLEGAL_OPPONENT_XI", `${profile.candidateId} violates keeper or overseas legality.`);
  }
  const actual = evaluateCompletedEraXi({ era, players: xiPlayers });
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
    throw new EraDraftDataError("OPPONENT_EVALUATION_MISMATCH", `${profile.candidateId} does not match frozen Team Evaluation V2 output.`);
  }
}

function parseEras(document: Record<string, unknown>): EraDraftEra[] {
  if (!Array.isArray(document.eras)) throw new EraDraftDataError("INVALID_REGISTRY", "Era registry must contain eras.");
  return document.eras.map((value, index) => {
    const row = record(value, `eras[${index}]`);
    const eraId = requiredString(row.eraId, `eras[${index}].eraId`);
    if (!ERA_IDS.includes(eraId as EraId)) throw new EraDraftDataError("UNSUPPORTED_ERA", `Unsupported era ${eraId}.`);
    return freezeDeep({
      eraId: eraId as EraId,
      label: requiredString(row.label, `eras[${index}].label`),
      seasonIds: stringArray(row.seasonIds, `eras[${index}].seasonIds`),
    });
  });
}

function parseSeasons(document: Record<string, unknown>): RegistrySeason[] {
  if (!Array.isArray(document.seasons)) throw new EraDraftDataError("INVALID_REGISTRY", "Season registry must contain seasons.");
  return document.seasons.map((value, index) => {
    const row = record(value, `seasons[${index}]`);
    const displayYear = row.displayYear;
    if (!Number.isInteger(displayYear)) throw new EraDraftDataError("INVALID_REGISTRY", `seasons[${index}].displayYear must be an integer.`);
    return freezeDeep({
      seasonId: requiredString(row.seasonId, `seasons[${index}].seasonId`),
      displayYear: displayYear as number,
      eraIds: stringArray(row.eraIds, `seasons[${index}].eraIds`),
    });
  });
}

function parseTeams(document: Record<string, unknown>): RegistryTeam[] {
  if (!Array.isArray(document.teams)) throw new EraDraftDataError("INVALID_REGISTRY", "Team registry must contain teams.");
  return document.teams.map((value, index) => {
    const row = record(value, `teams[${index}]`);
    return freezeDeep({
      teamId: requiredString(row.teamId, `teams[${index}].teamId`),
      canonicalName: requiredString(row.canonicalName, `teams[${index}].canonicalName`),
      franchiseId: requiredString(row.franchiseId, `teams[${index}].franchiseId`),
      activeSeasonIds: stringArray(row.activeSeasonIds, `teams[${index}].activeSeasonIds`),
    });
  });
}

function parseFranchises(document: Record<string, unknown>): RegistryFranchise[] {
  if (!Array.isArray(document.franchises)) throw new EraDraftDataError("INVALID_REGISTRY", "Franchise registry must contain franchises.");
  return document.franchises.map((value, index) => {
    const row = record(value, `franchises[${index}]`);
    return freezeDeep({
      franchiseId: requiredString(row.franchiseId, `franchises[${index}].franchiseId`),
      canonicalName: requiredString(row.canonicalName, `franchises[${index}].canonicalName`),
    });
  });
}

function parseEligibility(value: unknown, label: string): EraDraftEligibilityRow {
  const row = record(value, label);
  requireVersion(row, "schemaVersion", "ipl-era-draft-eligibility-row/v1", label);
  requireVersion(row, "eligibilityVersion", "ipl-era-draft-eligibility/v1", label);
  const status = requiredString(row.eligibilityStatus, `${label}.eligibilityStatus`);
  if (status !== "ELIGIBLE" && status !== "INELIGIBLE") throw new EraDraftDataError("INVALID_ELIGIBILITY", `${label} has invalid eligibility status.`);
  return freezeDeep({
    schemaVersion: "ipl-era-draft-eligibility-row/v1",
    eligibilityVersion: "ipl-era-draft-eligibility/v1",
    playerTeamSeasonId: requiredString(row.playerTeamSeasonId, `${label}.playerTeamSeasonId`),
    playerId: requiredString(row.playerId, `${label}.playerId`),
    canonicalDisplayName: requiredString(row.canonicalDisplayName, `${label}.canonicalDisplayName`),
    seasonId: requiredString(row.seasonId, `${label}.seasonId`),
    teamId: requiredString(row.teamId, `${label}.teamId`),
    eligibilityStatus: status,
  });
}

function parseRoster(value: unknown, label: string): EraDraftRosterRow {
  const row = record(value, label);
  requireVersion(row, "schemaVersion", "ipl-country-overseas-pts-row/v3", label);
  requireVersion(row, "metadataVersion", "ipl-country-overseas-metadata/v1", label);
  const rosterStatus = requiredString(row.iplRosterStatus, `${label}.iplRosterStatus`);
  if (!(["INDIAN", "OVERSEAS", "UNKNOWN"] as const).includes(rosterStatus as IplRosterStatus)) {
    throw new EraDraftDataError("INVALID_ROSTER_STATUS", `${label} has invalid IPL roster status.`);
  }
  const reviewState = requiredString(row.reviewState, `${label}.reviewState`);
  if (!["APPROVED", "PENDING", "ROSTER_APPROVED_NATION_UNRESOLVED"].includes(reviewState)) {
    throw new EraDraftDataError("INVALID_ROSTER_REVIEW_STATE", `${label} has invalid review state.`);
  }
  return freezeDeep({
    schemaVersion: "ipl-country-overseas-pts-row/v3",
    metadataVersion: "ipl-country-overseas-metadata/v1",
    playerTeamSeasonId: requiredString(row.playerTeamSeasonId, `${label}.playerTeamSeasonId`),
    playerId: requiredString(row.playerId, `${label}.playerId`),
    canonicalDisplayName: requiredString(row.canonicalDisplayName, `${label}.canonicalDisplayName`),
    seasonId: requiredString(row.seasonId, `${label}.seasonId`),
    teamId: requiredString(row.teamId, `${label}.teamId`),
    iplRosterStatus: rosterStatus as IplRosterStatus,
    reviewState: reviewState as EraDraftRosterRow["reviewState"],
  });
}

function validateVersions(versions: EraDraftCatalogVersions): void {
  const expected: EraDraftCatalogVersions = {
    registryVersion: "ipl-identities-v1",
    eligibilityVersion: "ipl-era-draft-eligibility/v1",
    roleSchemaVersion: PLAYER_ROLE_CONSUMER_SCHEMA_VERSION,
    roleMetadataVersion: ROLE_METADATA_VERSION,
    qualitySchemaVersion: PLAYER_QUALITY_CONSUMER_SCHEMA_VERSION,
    qualityModelVersion: PLAYER_QUALITY_MODEL_VERSION,
    rosterMetadataVersion: "ipl-country-overseas-metadata/v1",
    simulationDataVersion: STAGE7_DATA_VERSION,
    teamEvaluationVersion: TEAM_EVALUATION_V2_VERSION,
    simulationVersion: SIMULATION_V2_VERSION,
  };
  for (const key of Object.keys(expected) as (keyof EraDraftCatalogVersions)[]) {
    if (versions[key] !== expected[key]) throw new EraDraftDataError("UNSUPPORTED_VERSION", `Unsupported ${key}: ${versions[key]}.`);
  }
}

function assertPlayerIdentity(
  eligibility: EraDraftEligibilityRow,
  role: PlayerRoleConsumer,
  quality: PlayerQualityConsumer,
  roster: EraDraftRosterRow,
): void {
  for (const field of ["playerTeamSeasonId", "playerId", "canonicalDisplayName", "seasonId", "teamId"] as const) {
    const expected = eligibility[field];
    if (role[field] !== expected || quality[field] !== expected || roster[field] !== expected) {
      throw new EraDraftDataError("PLAYER_IDENTITY_MISMATCH", `${eligibility.playerTeamSeasonId} disagrees on ${field}.`, { field });
    }
  }
}

function assertHistoricalStatsIdentity(
  eligibility: EraDraftEligibilityRow,
  stats: EraDraftHistoricalStats,
): void {
  for (const field of ["playerTeamSeasonId", "playerId", "seasonId", "teamId"] as const) {
    if (stats[field] !== eligibility[field]) {
      throw new EraDraftDataError(
        "PLAYER_IDENTITY_MISMATCH",
        `${eligibility.playerTeamSeasonId} historical stats disagree on ${field}.`,
        { field },
      );
    }
  }
}

function makeTeamSeasonId(teamId: string, seasonId: string): TeamSeasonId {
  return `ts:${teamId}:${seasonId}`;
}

function pushMap<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const items = map.get(key) ?? [];
  items.push(value);
  map.set(key, items);
}

function uniqueMap<T, K>(items: readonly T[], key: (item: T) => K, label: string): Map<K, T> {
  const result = new Map<K, T>();
  for (const item of items) {
    const id = key(item);
    if (result.has(id)) throw new EraDraftDataError("DUPLICATE_ID", `Duplicate ${label}: ${String(id)}.`);
    result.set(id, item);
  }
  return result;
}

function assertExactSet(actualValues: readonly string[], expectedValues: readonly string[], label: string): void {
  const actual = [...actualValues].sort();
  const expected = [...expectedValues].sort();
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new EraDraftDataError("ID_SET_MISMATCH", `${label} do not match.`, { actualCount: actual.length, expectedCount: expected.length });
  }
}

function required<K, V>(map: ReadonlyMap<K, V>, key: K, label: string): V {
  const value = map.get(key);
  if (value === undefined) throw new EraDraftDataError("MISSING_JOINED_ROW", `Missing ${label} ${String(key)}.`);
  return value;
}

function jsonLines<T>(file: SourceFile, parser: (value: unknown, label: string) => T): T[] {
  return file.content.split("\n").filter(Boolean).map((line, index) => {
    try {
      return parser(JSON.parse(line), `${file.relativePath}:${index + 1}`);
    } catch (error) {
      if (error instanceof EraDraftDataError) throw error;
      throw new EraDraftDataError("INVALID_SOURCE_ROW", `Invalid source row at ${file.relativePath}:${index + 1}.`, {}, { cause: error });
    }
  });
}

function readSourceFile(root: string, relativePath: string): SourceFile {
  let content: string;
  try {
    content = readFileSync(resolve(root, relativePath), "utf8");
  } catch (error) {
    throw new EraDraftDataError("MISSING_SOURCE_FILE", `Missing Era Draft source file ${relativePath}.`, { relativePath }, { cause: error });
  }
  return { relativePath, content, sha256: sha256(content) };
}

function jsonDocument(file: SourceFile, label: string): Record<string, unknown> {
  try {
    return record(JSON.parse(file.content), label);
  } catch (error) {
    if (error instanceof EraDraftDataError) throw error;
    throw new EraDraftDataError("INVALID_JSON", `Invalid JSON in ${file.relativePath}.`, {}, { cause: error });
  }
}

function verifyListedFile(file: SourceFile, listing: unknown, listedPath: string, label: string): void {
  if (!Array.isArray(listing)) throw new EraDraftDataError("INVALID_MANIFEST", `${label} has no file listing.`);
  const item = listing.find((value) => record(value, `${label} entry`).path === listedPath);
  if (!item) throw new EraDraftDataError("MISSING_MANIFEST_ENTRY", `${label} does not list ${listedPath}.`);
  const expected = requiredString(record(item, `${label} ${listedPath}`).sha256, `${label} ${listedPath} sha256`);
  if (file.sha256 !== expected) {
    throw new EraDraftDataError("SOURCE_HASH_MISMATCH", `${file.relativePath} does not match its frozen manifest hash.`, { expected, actual: file.sha256 });
  }
}

function requireVersion(document: Record<string, unknown>, field: string, expected: string, label: string): void {
  if (document[field] !== expected) throw new EraDraftDataError("UNSUPPORTED_VERSION", `${label} has unsupported ${field}: ${String(document[field])}.`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EraDraftDataError("INVALID_SHAPE", `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new EraDraftDataError("INVALID_SHAPE", `${label} must be a non-empty string.`);
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new EraDraftDataError("INVALID_SHAPE", `${label} must be an array of non-empty strings.`);
  }
  return [...value] as string[];
}

export function computeEraDraftCatalogFingerprint(input: EraDraftCatalogFingerprintInput): string {
  return sha256(JSON.stringify(canonicalFingerprintInput(input)));
}

function canonicalFingerprintInput(input: EraDraftCatalogFingerprintInput): EraDraftCatalogFingerprintInput {
  return freezeDeep({
    runtimeVersions: {
      simulationVersion: input.runtimeVersions.simulationVersion,
      teamEvaluationVersion: input.runtimeVersions.teamEvaluationVersion,
    },
    sources: input.sources
      .map(({ relativePath, sha256: hash }) => ({ relativePath, sha256: hash }))
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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
