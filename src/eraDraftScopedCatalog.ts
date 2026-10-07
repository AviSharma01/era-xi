import { buildEraDraftCompletionIndex, type EraDraftCompletionIndex } from "./eraDraftCompletionIndex.js";
import { canonicalJson } from "./eraDraftCanonical.js";
import {
  parseEraDraftHistoricalStats,
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
import type { EraOpponentProfileV2, FoundationOpponentProfileV2 } from "./stage7Data.js";
import {
  ERA_IDS,
  evaluateCompletedEraXi,
  TEAM_EVALUATION_V2_VERSION,
  type EraId,
  type EraXiPlayerInput,
  type IplRosterStatus,
} from "./teamEvaluationV2.js";
import { SIMULATION_V2_VERSION, type EraEnvironmentV2 } from "./simulationV2.js";
import type {
  EraDraftCatalog,
  EraDraftCatalogDiagnostics,
  EraDraftCatalogVersions,
  EraDraftEligibilityRow,
  EraDraftEra,
  EraDraftPlayerRecord,
  EraDraftRosterRow,
  EraDraftTeamSeason,
  SimulationContentAvailability,
} from "./eraDraftData.js";
import { EraDraftDataError, type TeamSeasonId } from "./eraDraftTypes.js";

export const ERA_DRAFT_WEB_ARTIFACT_SCHEMA_VERSION = "ipl-era-draft-web-artifact/v2" as const;

export type EraDraftWebSeason = {
  readonly seasonId: string;
  readonly displayYear: number;
  readonly eraIds: readonly string[];
};

export type EraDraftWebTeam = {
  readonly teamId: string;
  readonly canonicalName: string;
  readonly franchiseId: string;
  readonly activeSeasonIds: readonly string[];
};

export type EraDraftWebFranchise = {
  readonly franchiseId: string;
  readonly canonicalName: string;
};

export type EraDraftWebArtifact = {
  readonly schemaVersion: typeof ERA_DRAFT_WEB_ARTIFACT_SCHEMA_VERSION;
  readonly catalogFingerprint: string;
  readonly eraId: EraId;
  readonly runtimeVersions: EraDraftCatalogVersions;
  readonly era: EraDraftEra;
  readonly seasons: readonly EraDraftWebSeason[];
  readonly teams: readonly EraDraftWebTeam[];
  readonly franchises: readonly EraDraftWebFranchise[];
  readonly eligibility: readonly EraDraftEligibilityRow[];
  readonly roles: readonly PlayerRoleConsumer[];
  readonly qualities: readonly PlayerQualityConsumer[];
  readonly historicalStats: readonly EraDraftHistoricalStats[];
  readonly roster: readonly EraDraftRosterRow[];
  readonly environment: EraEnvironmentV2;
  readonly opponents: readonly EraOpponentProfileV2[];
};

const EXPECTED_TEAM_SEASONS: Readonly<Record<EraId, number>> = {
  "era-foundation": 24,
  "era-expansion": 28,
  "era-transition": 32,
  "era-modern-pre-impact": 42,
  "era-impact": 40,
};

const EXPECTED_OPPONENTS: Readonly<Record<EraId, number>> = {
  "era-foundation": 8,
  "era-expansion": 11,
  "era-transition": 10,
  "era-modern-pre-impact": 10,
  "era-impact": 10,
};

export function buildScopedEraDraftCatalog(
  value: unknown,
  expected: { readonly eraId: EraId; readonly catalogFingerprint: string },
): EraDraftCatalog {
  const artifact = parseWebArtifact(value, expected);
  const eraId = artifact.eraId;
  const era = artifact.era;
  const seasonById = uniqueMap(artifact.seasons, (item) => item.seasonId, "season ID");
  const teamById = uniqueMap(artifact.teams, (item) => item.teamId, "team ID");
  const franchiseById = uniqueMap(artifact.franchises, (item) => item.franchiseId, "franchise ID");
  assertExactSet(artifact.seasons.map((item) => item.seasonId), era.seasonIds, `${eraId} seasons`);
  for (const seasonId of era.seasonIds) {
    const season = required(seasonById, seasonId, "season");
    if (season.eraIds.length !== 1 || season.eraIds[0] !== eraId) {
      fail("ERA_MEMBERSHIP_MISMATCH", `${seasonId} disagrees with ${eraId}.`);
    }
  }

  const eligibilityById = uniqueMap(artifact.eligibility, (item) => item.playerTeamSeasonId, "eligibility PTS ID");
  if (artifact.eligibility.some((item) => item.eligibilityStatus !== "ELIGIBLE")) {
    fail("INVALID_SCOPED_ELIGIBILITY", `${eraId} web data must contain only eligible profiles.`);
  }
  const eligibleIds = [...eligibilityById.keys()].sort();
  const roleById = uniqueMap(artifact.roles, (item) => item.playerTeamSeasonId, "role PTS ID");
  const qualityById = uniqueMap(artifact.qualities, (item) => item.playerTeamSeasonId, "quality PTS ID");
  const historicalStatsById = uniqueMap(artifact.historicalStats, (item) => item.playerTeamSeasonId, "historical stats PTS ID");
  const rosterById = uniqueMap(artifact.roster, (item) => item.playerTeamSeasonId, "roster PTS ID");
  assertExactSet([...roleById.keys()], eligibleIds, "scoped Stage 5 PTS IDs");
  assertExactSet([...qualityById.keys()], eligibleIds, "scoped Stage 6 PTS IDs");
  assertExactSet([...historicalStatsById.keys()], eligibleIds, "scoped historical stats PTS IDs");
  assertExactSet([...rosterById.keys()], eligibleIds, "scoped roster PTS IDs");

  const playerById = new Map<string, EraDraftPlayerRecord>();
  const candidatesByTeamSeason = new Map<TeamSeasonId, EraDraftPlayerRecord[]>();
  const variantsByEraPlayer = new Map<string, EraDraftPlayerRecord[]>();
  const keeperIds = new Set<string>();
  for (const eligibility of artifact.eligibility) {
    const role = required(roleById, eligibility.playerTeamSeasonId, "Stage 5 role");
    const quality = required(qualityById, eligibility.playerTeamSeasonId, "Stage 6 quality");
    const historicalStats = required(historicalStatsById, eligibility.playerTeamSeasonId, "historical stats");
    const roster = required(rosterById, eligibility.playerTeamSeasonId, "roster metadata");
    assertPlayerIdentity(eligibility, role, quality, roster);
    assertHistoricalStatsIdentity(eligibility, historicalStats);
    if (roster.reviewState !== "APPROVED" && roster.reviewState !== "ROSTER_APPROVED_NATION_UNRESOLVED") {
      fail("UNAPPROVED_G2_ROSTER_METADATA", `${eligibility.playerTeamSeasonId} does not have approved roster metadata.`);
    }
    if (roster.iplRosterStatus === "UNKNOWN") {
      fail("UNKNOWN_G2_ROSTER_STATUS", `${eligibility.playerTeamSeasonId} has UNKNOWN IPL roster status.`);
    }
    const season = required(seasonById, eligibility.seasonId, "season");
    const team = required(teamById, eligibility.teamId, "team");
    const franchise = required(franchiseById, team.franchiseId, "franchise");
    if (!era.seasonIds.includes(season.seasonId) || !team.activeSeasonIds.includes(season.seasonId)) {
      fail("INACTIVE_TEAM_SEASON", `${team.teamId} is not active in scoped season ${season.seasonId}.`);
    }
    if (role.franchiseId !== team.franchiseId || quality.franchiseId !== team.franchiseId) {
      fail("FRANCHISE_IDENTITY_MISMATCH", `${eligibility.playerTeamSeasonId} has inconsistent franchise identity.`);
    }
    const teamSeasonId = `ts:${team.teamId}:${season.seasonId}` as TeamSeasonId;
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
    if (role.keeperMetadata.capabilityStatus === "CONFIRMED") keeperIds.add(player.playerId);
  }

  const teamSeasonById = new Map<TeamSeasonId, EraDraftTeamSeason>();
  const teamSeasons: EraDraftTeamSeason[] = [];
  for (const [teamSeasonId, candidates] of candidatesByTeamSeason) {
    candidates.sort((left, right) => left.playerTeamSeasonId.localeCompare(right.playerTeamSeasonId));
    const first = candidates[0]!;
    const identity = freezeDeep({
      teamSeasonId,
      eraId,
      seasonId: first.seasonId,
      seasonYear: first.seasonYear,
      teamId: first.teamId,
      teamName: first.teamName,
      franchiseId: first.franchiseId,
      franchiseName: first.franchiseName,
    } satisfies EraDraftTeamSeason);
    teamSeasonById.set(teamSeasonId, identity);
    teamSeasons.push(identity);
    Object.freeze(candidates);
  }
  teamSeasons.sort((left, right) => left.teamSeasonId.localeCompare(right.teamSeasonId));
  Object.freeze(teamSeasons);
  if (teamSeasons.length !== EXPECTED_TEAM_SEASONS[eraId]) {
    fail("TEAM_SEASON_COUNT_MISMATCH", `${eraId} expected ${EXPECTED_TEAM_SEASONS[eraId]} team-seasons, found ${teamSeasons.length}.`);
  }
  for (const variants of variantsByEraPlayer.values()) {
    variants.sort((left, right) => left.playerTeamSeasonId.localeCompare(right.playerTeamSeasonId));
    Object.freeze(variants);
  }

  validateEnvironment(artifact.environment, era);
  const opponents = [...artifact.opponents];
  if (opponents.length !== EXPECTED_OPPONENTS[eraId]) {
    fail("OPPONENT_COUNT_MISMATCH", `${eraId} expected ${EXPECTED_OPPONENTS[eraId]} opponents, found ${opponents.length}.`);
  }
  if (new Set(opponents.map((profile) => profile.franchiseId)).size !== opponents.length) {
    fail("DUPLICATE_OPPONENT_LINEAGE", `${eraId} opponents must have distinct franchise lineages.`);
  }
  for (const profile of opponents) validateOpponent(profile, era, teamById, franchiseById, playerById);
  if (eraId === "era-foundation") opponents.sort((left, right) => left.candidateId.localeCompare(right.candidateId));
  Object.freeze(opponents);

  const simulationContent: SimulationContentAvailability = Object.freeze({
    status: "AVAILABLE",
    opponentCount: opponents.length,
  });
  const emptyCounts = Object.fromEntries(ERA_IDS.map((id) => [id, id === eraId ? opponents.length : 0])) as Record<EraId, number>;
  const teamSeasonCounts = Object.fromEntries(ERA_IDS.map((id) => [id, id === eraId ? teamSeasons.length : 0])) as Record<EraId, number>;
  const availability = Object.fromEntries(ERA_IDS.map((id) => [id, id === eraId
    ? simulationContent
    : { status: "UNAVAILABLE" as const, opponentCount: 0 as const }])) as Record<EraId, SimulationContentAvailability>;
  const diagnostics = freezeDeep({
    eligibleProfiles: playerById.size,
    canonicalPlayers: new Set([...playerById.values()].map((player) => player.playerId)).size,
    eras: 1,
    environments: 1,
    foundationOpponents: eraId === "era-foundation" ? opponents.length : 0,
    opponentsByEra: emptyCounts,
    unknownG2RosterStatuses: 0,
    teamSeasonsByEra: teamSeasonCounts,
    simulationContentByEra: availability,
    sourceFiles: [],
    fingerprint: artifact.catalogFingerprint,
  } satisfies EraDraftCatalogDiagnostics);

  return new ScopedCatalog({ artifact, diagnostics, teamSeasonById, teamSeasons, eligibilityById, playerById,
    candidatesByTeamSeason, variantsByEraPlayer, keeperIds, simulationContent, opponents });
}

class ScopedCatalog implements EraDraftCatalog {
  readonly fingerprint: string;
  readonly diagnostics: EraDraftCatalogDiagnostics;
  readonly #completionIndex: EraDraftCompletionIndex;
  readonly #artifact: EraDraftWebArtifact;
  readonly #teamSeasonById: ReadonlyMap<TeamSeasonId, EraDraftTeamSeason>;
  readonly #teamSeasons: readonly EraDraftTeamSeason[];
  readonly #eligibilityById: ReadonlyMap<string, EraDraftEligibilityRow>;
  readonly #playerById: ReadonlyMap<string, EraDraftPlayerRecord>;
  readonly #candidatesByTeamSeason: ReadonlyMap<TeamSeasonId, readonly EraDraftPlayerRecord[]>;
  readonly #variantsByEraPlayer: ReadonlyMap<string, readonly EraDraftPlayerRecord[]>;
  readonly #keeperIds: ReadonlySet<string>;
  readonly #simulationContent: SimulationContentAvailability;
  readonly #opponents: readonly EraOpponentProfileV2[];

  constructor(input: {
    artifact: EraDraftWebArtifact;
    diagnostics: EraDraftCatalogDiagnostics;
    teamSeasonById: Map<TeamSeasonId, EraDraftTeamSeason>;
    teamSeasons: readonly EraDraftTeamSeason[];
    eligibilityById: Map<string, EraDraftEligibilityRow>;
    playerById: Map<string, EraDraftPlayerRecord>;
    candidatesByTeamSeason: Map<TeamSeasonId, EraDraftPlayerRecord[]>;
    variantsByEraPlayer: Map<string, EraDraftPlayerRecord[]>;
    keeperIds: Set<string>;
    simulationContent: SimulationContentAvailability;
    opponents: readonly EraOpponentProfileV2[];
  }) {
    this.fingerprint = input.artifact.catalogFingerprint;
    this.diagnostics = input.diagnostics;
    this.#artifact = input.artifact;
    this.#teamSeasonById = input.teamSeasonById;
    this.#teamSeasons = input.teamSeasons;
    this.#eligibilityById = input.eligibilityById;
    this.#playerById = input.playerById;
    this.#candidatesByTeamSeason = input.candidatesByTeamSeason;
    this.#variantsByEraPlayer = input.variantsByEraPlayer;
    this.#keeperIds = input.keeperIds;
    this.#simulationContent = input.simulationContent;
    this.#opponents = input.opponents;
    this.#completionIndex = buildEraDraftCompletionIndex(input.teamSeasons
      .flatMap(team => input.candidatesByTeamSeason.get(team.teamSeasonId) ?? []));
    Object.freeze(this);
  }

  getCompletionCostIndex(eraId: EraId): EraDraftCompletionIndex | undefined {
    return eraId === this.#artifact.eraId ? this.#completionIndex : undefined;
  }
  getEra(eraId: EraId): EraDraftEra | undefined { return eraId === this.#artifact.eraId ? this.#artifact.era : undefined; }
  getEraIds(): readonly EraId[] { return Object.freeze([this.#artifact.eraId]); }
  getEraForSeason(seasonId: string): EraId | undefined { return this.#artifact.era.seasonIds.includes(seasonId) ? this.#artifact.eraId : undefined; }
  getTeamSeason(id: TeamSeasonId): EraDraftTeamSeason | undefined { return this.#teamSeasonById.get(id); }
  getTeamSeasonsForEra(eraId: EraId): readonly EraDraftTeamSeason[] { return eraId === this.#artifact.eraId ? this.#teamSeasons : []; }
  getEligibilityRow(id: string): EraDraftEligibilityRow | undefined { return this.#eligibilityById.get(id); }
  getPlayer(id: string): EraDraftPlayerRecord | undefined { return this.#playerById.get(id); }
  getCandidatesForTeamSeason(id: TeamSeasonId): readonly EraDraftPlayerRecord[] { return this.#candidatesByTeamSeason.get(id) ?? []; }
  getPlayerVariantsForEra(eraId: EraId, playerId: string): readonly EraDraftPlayerRecord[] {
    return this.#variantsByEraPlayer.get(`${eraId}\u001f${playerId}`) ?? [];
  }
  getKeeperCapablePlayerIds(eraId: EraId): readonly string[] {
    return eraId === this.#artifact.eraId ? Object.freeze([...this.#keeperIds].sort()) : [];
  }
  getSimulationContent(eraId: EraId): SimulationContentAvailability {
    return eraId === this.#artifact.eraId ? this.#simulationContent : { status: "UNAVAILABLE", opponentCount: 0 };
  }
  getEnvironment(eraId: EraId): EraEnvironmentV2 | undefined { return eraId === this.#artifact.eraId ? this.#artifact.environment : undefined; }
  getOpponentProfiles(eraId: EraId): readonly EraOpponentProfileV2[] { return eraId === this.#artifact.eraId ? this.#opponents : []; }
  getFoundationOpponents(): readonly FoundationOpponentProfileV2[] {
    return this.#artifact.eraId === "era-foundation" ? this.#opponents as readonly FoundationOpponentProfileV2[] : [];
  }
}

function parseWebArtifact(value: unknown, expected: { eraId: EraId; catalogFingerprint: string }): EraDraftWebArtifact {
  const row = record(value, "Era Draft web artifact");
  exactKeys(row, ["schemaVersion", "catalogFingerprint", "eraId", "runtimeVersions", "era", "seasons", "teams", "franchises",
    "eligibility", "roles", "qualities", "historicalStats", "roster", "environment", "opponents"], "Era Draft web artifact");
  if (row.schemaVersion !== ERA_DRAFT_WEB_ARTIFACT_SCHEMA_VERSION) fail("UNSUPPORTED_WEB_ARTIFACT", "Unsupported Era Draft web artifact schema.");
  if (row.eraId !== expected.eraId || row.catalogFingerprint !== expected.catalogFingerprint
    || typeof row.catalogFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(row.catalogFingerprint)) {
    fail("WEB_ARTIFACT_IDENTITY_MISMATCH", "Era artifact does not match its selected era and authoritative fingerprint.");
  }
  const runtimeVersions = parseVersions(row.runtimeVersions);
  const eraRow = record(row.era, "artifact era");
  exactKeys(eraRow, ["eraId", "label", "seasonIds"], "artifact era");
  const era: EraDraftEra = freezeDeep({
    eraId: enumEra(eraRow.eraId, "artifact eraId"),
    label: text(eraRow.label, "artifact era label"),
    seasonIds: stringArray(eraRow.seasonIds, "artifact era seasons"),
  });
  if (era.eraId !== expected.eraId) fail("WEB_ARTIFACT_IDENTITY_MISMATCH", "Artifact era definition disagrees with eraId.");

  const seasons = array(row.seasons, "artifact seasons").map((item, index): EraDraftWebSeason => {
    const season = record(item, `artifact seasons[${index}]`);
    exactKeys(season, ["seasonId", "displayYear", "eraIds"], `artifact seasons[${index}]`);
    if (!Number.isInteger(season.displayYear)) fail("INVALID_WEB_ARTIFACT", `artifact seasons[${index}] displayYear must be an integer.`);
    return freezeDeep({ seasonId: text(season.seasonId, "seasonId"), displayYear: season.displayYear as number,
      eraIds: stringArray(season.eraIds, "season eraIds") });
  });
  const teams = array(row.teams, "artifact teams").map((item, index): EraDraftWebTeam => {
    const team = record(item, `artifact teams[${index}]`);
    exactKeys(team, ["teamId", "canonicalName", "franchiseId", "activeSeasonIds"], `artifact teams[${index}]`);
    return freezeDeep({ teamId: text(team.teamId, "teamId"), canonicalName: text(team.canonicalName, "team name"),
      franchiseId: text(team.franchiseId, "franchiseId"), activeSeasonIds: stringArray(team.activeSeasonIds, "activeSeasonIds") });
  });
  const franchises = array(row.franchises, "artifact franchises").map((item, index): EraDraftWebFranchise => {
    const franchise = record(item, `artifact franchises[${index}]`);
    exactKeys(franchise, ["franchiseId", "canonicalName"], `artifact franchises[${index}]`);
    return freezeDeep({ franchiseId: text(franchise.franchiseId, "franchiseId"), canonicalName: text(franchise.canonicalName, "franchise name") });
  });
  const eligibility = array(row.eligibility, "artifact eligibility").map(parseEligibility);
  const roles = array(row.roles, "artifact roles").map((item, index) => parsePlayerRoleConsumer(item, `artifact roles[${index}]`));
  const qualities = array(row.qualities, "artifact qualities").map((item, index) => parsePlayerQualityConsumer(item, `artifact qualities[${index}]`));
  const historicalStats = array(row.historicalStats, "artifact historicalStats")
    .map((item, index) => parseEraDraftHistoricalStats(item, `artifact historicalStats[${index}]`));
  const roster = array(row.roster, "artifact roster").map(parseRoster);
  const environment = row.environment as EraEnvironmentV2;
  const opponents = array(row.opponents, "artifact opponents") as EraOpponentProfileV2[];
  return freezeDeep({ schemaVersion: ERA_DRAFT_WEB_ARTIFACT_SCHEMA_VERSION, catalogFingerprint: row.catalogFingerprint as string,
    eraId: row.eraId as EraId, runtimeVersions, era, seasons, teams, franchises, eligibility, roles, qualities, historicalStats, roster,
    environment, opponents });
}

function parseVersions(value: unknown): EraDraftCatalogVersions {
  const row = record(value, "artifact runtimeVersions");
  const expected: EraDraftCatalogVersions = {
    registryVersion: "ipl-identities-v1",
    eligibilityVersion: "ipl-era-draft-eligibility/v1",
    roleSchemaVersion: PLAYER_ROLE_CONSUMER_SCHEMA_VERSION,
    roleMetadataVersion: ROLE_METADATA_VERSION,
    qualitySchemaVersion: PLAYER_QUALITY_CONSUMER_SCHEMA_VERSION,
    qualityModelVersion: PLAYER_QUALITY_MODEL_VERSION,
    rosterMetadataVersion: "ipl-country-overseas-metadata/v1",
    simulationDataVersion: "ipl-era-simulation/v2",
    teamEvaluationVersion: TEAM_EVALUATION_V2_VERSION,
    simulationVersion: SIMULATION_V2_VERSION,
  };
  exactKeys(row, Object.keys(expected), "artifact runtimeVersions");
  for (const key of Object.keys(expected) as (keyof EraDraftCatalogVersions)[]) {
    if (row[key] !== expected[key]) fail("UNSUPPORTED_VERSION", `Unsupported artifact ${key}: ${String(row[key])}.`);
  }
  return freezeDeep({ ...expected });
}

function parseEligibility(value: unknown, index: number): EraDraftEligibilityRow {
  const row = record(value, `artifact eligibility[${index}]`);
  exactKeys(row, ["schemaVersion", "eligibilityVersion", "playerTeamSeasonId", "playerId", "canonicalDisplayName", "seasonId", "teamId", "eligibilityStatus"], `artifact eligibility[${index}]`);
  if (row.schemaVersion !== "ipl-era-draft-eligibility-row/v1" || row.eligibilityVersion !== "ipl-era-draft-eligibility/v1"
    || row.eligibilityStatus !== "ELIGIBLE") fail("INVALID_SCOPED_ELIGIBILITY", `Invalid scoped eligibility row ${index}.`);
  return freezeDeep({ schemaVersion: row.schemaVersion, eligibilityVersion: row.eligibilityVersion,
    playerTeamSeasonId: text(row.playerTeamSeasonId, "playerTeamSeasonId"), playerId: text(row.playerId, "playerId"),
    canonicalDisplayName: text(row.canonicalDisplayName, "canonicalDisplayName"), seasonId: text(row.seasonId, "seasonId"),
    teamId: text(row.teamId, "teamId"), eligibilityStatus: row.eligibilityStatus });
}

function parseRoster(value: unknown, index: number): EraDraftRosterRow {
  const row = record(value, `artifact roster[${index}]`);
  exactKeys(row, ["schemaVersion", "metadataVersion", "playerTeamSeasonId", "playerId", "canonicalDisplayName", "seasonId", "teamId", "iplRosterStatus", "reviewState"], `artifact roster[${index}]`);
  const rosterStatus = row.iplRosterStatus;
  const reviewState = row.reviewState;
  if (row.schemaVersion !== "ipl-country-overseas-pts-row/v3" || row.metadataVersion !== "ipl-country-overseas-metadata/v1"
    || !["INDIAN", "OVERSEAS", "UNKNOWN"].includes(rosterStatus as string)
    || !["APPROVED", "PENDING", "ROSTER_APPROVED_NATION_UNRESOLVED"].includes(reviewState as string)) {
    fail("INVALID_ROSTER_STATUS", `Invalid scoped roster row ${index}.`);
  }
  return freezeDeep({ schemaVersion: row.schemaVersion, metadataVersion: row.metadataVersion,
    playerTeamSeasonId: text(row.playerTeamSeasonId, "playerTeamSeasonId"), playerId: text(row.playerId, "playerId"),
    canonicalDisplayName: text(row.canonicalDisplayName, "canonicalDisplayName"), seasonId: text(row.seasonId, "seasonId"),
    teamId: text(row.teamId, "teamId"), iplRosterStatus: rosterStatus as IplRosterStatus,
    reviewState: reviewState as EraDraftRosterRow["reviewState"] });
}

function validateEnvironment(environment: EraEnvironmentV2, era: EraDraftEra): void {
  if (!environment || typeof environment !== "object" || environment.eraId !== era.eraId
    || environment.sourceCohort !== "all_normal" || !Array.isArray(environment.seasonIds)
    || !environment.sample || environment.sample.matches <= 0 || !environment.runs
    || environment.runs.standardDeviation <= 0 || !environment.wickets || !environment.chase
    || !Array.isArray(environment.allOutBallsHistogram)) {
    fail("INVALID_ERA_ENVIRONMENT", `Invalid ${era.eraId} environment.`);
  }
  assertExactSet([...environment.seasonIds], [...era.seasonIds], `${era.eraId} environment seasons`);
}

function validateOpponent(profile: EraOpponentProfileV2, era: EraDraftEra, teams: ReadonlyMap<string, EraDraftWebTeam>,
  franchises: ReadonlyMap<string, EraDraftWebFranchise>, players: ReadonlyMap<string, EraDraftPlayerRecord>): void {
  if (!profile || typeof profile !== "object" || profile.eraId !== era.eraId || typeof profile.candidateId !== "string"
    || typeof profile.teamId !== "string" || typeof profile.franchiseId !== "string" || typeof profile.seasonId !== "string"
    || !Array.isArray(profile.xi) || profile.xi.length !== 11 || profile.review?.status !== "APPROVED" || !profile.evaluation) {
    fail("INVALID_OPPONENT_PROFILE", `Invalid opponent profile in ${era.eraId}.`);
  }
  const team = required(teams, profile.teamId, "opponent team");
  required(franchises, profile.franchiseId, "opponent franchise");
  if (profile.candidateId !== `opponent:${profile.teamId}:${profile.seasonId}` || team.franchiseId !== profile.franchiseId
    || team.canonicalName !== profile.teamName || !team.activeSeasonIds.includes(profile.seasonId)
    || !era.seasonIds.includes(profile.seasonId)) fail("OPPONENT_IDENTITY_MISMATCH", `${profile.candidateId} has invalid identity.`);
  if (new Set(profile.xi.map((item) => item.playerId)).size !== 11
    || new Set(profile.xi.map((item) => item.playerTeamSeasonId)).size !== 11
    || profile.xi.some((item, index) => item.position !== index + 1)
    || profile.xi.filter((item) => item.rosterStatus === "OVERSEAS").length > 4) {
    fail("ILLEGAL_OPPONENT_XI", `${profile.candidateId} is not an ordered, unique, legal XI.`);
  }
  let keepers = 0;
  const xi = profile.xi.map((item): EraXiPlayerInput => {
    const player = required(players, item.playerTeamSeasonId, "opponent player");
    if (player.playerId !== item.playerId || player.canonicalDisplayName !== item.displayName || player.teamId !== profile.teamId
      || player.franchiseId !== profile.franchiseId || player.seasonId !== profile.seasonId || player.rosterStatus !== item.rosterStatus) {
      fail("OPPONENT_PLAYER_IDENTITY_MISMATCH", `${item.playerTeamSeasonId} does not join to ${profile.candidateId}.`);
    }
    if (player.role.keeperMetadata.capabilityStatus === "CONFIRMED") keepers += 1;
    return { position: item.position as EraXiPlayerInput["position"], role: player.role, quality: player.quality,
      rosterStatus: player.rosterStatus };
  });
  if (keepers < 1) fail("ILLEGAL_OPPONENT_XI", `${profile.candidateId} lacks a confirmed wicketkeeper.`);
  const actual = evaluateCompletedEraXi({ era, players: xi });
  const expected = { battingCore: rounded(actual.baseStrength.battingCore), battingDepth: rounded(actual.baseStrength.battingDepth),
    batting: rounded(actual.adjustedStrength.batting), bowling: rounded(actual.adjustedStrength.bowling), overall: rounded(actual.adjustedStrength.overall),
    structuralBattingOrderEffect: rounded(actual.diagnostics.structuralBattingOrderEffect),
    appliedPositionFitEffect: rounded(actual.diagnostics.appliedPositionFitEffect), bowlingCapacity: rounded(actual.diagnostics.bowlingCapacity),
    uncoveredBowlingUnits: rounded(actual.diagnostics.uncoveredBowlingUnits) };
  if ((Object.keys(expected) as (keyof typeof expected)[]).some((key) => profile.evaluation[key] !== expected[key])) {
    fail("OPPONENT_EVALUATION_MISMATCH", `${profile.candidateId} differs from Team Evaluation V2.`);
  }
}

function assertPlayerIdentity(eligibility: EraDraftEligibilityRow, role: PlayerRoleConsumer,
  quality: PlayerQualityConsumer, roster: EraDraftRosterRow): void {
  for (const field of ["playerTeamSeasonId", "playerId", "canonicalDisplayName", "seasonId", "teamId"] as const) {
    if (role[field] !== eligibility[field] || quality[field] !== eligibility[field] || roster[field] !== eligibility[field]) {
      fail("PLAYER_IDENTITY_MISMATCH", `${eligibility.playerTeamSeasonId} disagrees on ${field}.`);
    }
  }
}

function assertHistoricalStatsIdentity(eligibility: EraDraftEligibilityRow, stats: EraDraftHistoricalStats): void {
  for (const field of ["playerTeamSeasonId", "playerId", "seasonId", "teamId"] as const) {
    if (stats[field] !== eligibility[field]) {
      fail("PLAYER_IDENTITY_MISMATCH", `${eligibility.playerTeamSeasonId} historical stats disagree on ${field}.`);
    }
  }
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail("INVALID_WEB_ARTIFACT", `${label} must be an array.`);
  return value as unknown[];
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_WEB_ARTIFACT", `${label} must be an object.`);
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((item, index) => item !== expected[index])) {
    fail("INVALID_WEB_ARTIFACT", `${label} has unexpected fields.`);
  }
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) fail("INVALID_WEB_ARTIFACT", `${label} must be a non-empty string.`);
  return value as string;
}
function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    fail("INVALID_WEB_ARTIFACT", `${label} must be an array of non-empty strings.`);
  }
  return [...value] as string[];
}
function enumEra(value: unknown, label: string): EraId {
  if (typeof value !== "string" || !ERA_IDS.includes(value as EraId)) fail("INVALID_WEB_ARTIFACT", `${label} is unsupported.`);
  return value as EraId;
}
function uniqueMap<T, K>(items: readonly T[], key: (item: T) => K, label: string): Map<K, T> {
  const result = new Map<K, T>();
  for (const item of items) {
    const id = key(item);
    if (result.has(id)) fail("DUPLICATE_ID", `Duplicate ${label}: ${String(id)}.`);
    result.set(id, item);
  }
  return result;
}
function required<K, V>(items: ReadonlyMap<K, V>, key: K, label: string): V {
  const value = items.get(key);
  if (value === undefined) fail("MISSING_JOINED_ROW", `Missing ${label} ${String(key)}.`);
  return value as V;
}
function assertExactSet(actualValues: readonly string[], expectedValues: readonly string[], label: string): void {
  const actual = [...actualValues].sort();
  const expected = [...expectedValues].sort();
  if (actual.length !== expected.length || actual.some((item, index) => item !== expected[index])) {
    fail("ID_SET_MISMATCH", `${label} do not match.`);
  }
}
function pushMap<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const values = map.get(key) ?? [];
  values.push(value);
  map.set(key, values);
}
function rounded(value: number): number { return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000; }
function fail(code: string, message: string): never { throw new EraDraftDataError(code, message); }
function freezeDeep<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) value.forEach(freezeDeep);
  else Object.values(value as Record<string, unknown>).forEach(freezeDeep);
  return Object.freeze(value);
}
