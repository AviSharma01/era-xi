export const PLAYER_ROLE_CONSUMER_SCHEMA_VERSION = "ipl-era-draft-player-role-consumer/v1" as const;
export const ROLE_METADATA_VERSION = "ipl-era-draft-player-roles/v1" as const;
export const WICKETKEEPER_METADATA_VERSION = "ipl-wicketkeeper-metadata/v1" as const;

export const DERIVED_ROLES = [
  "BATTER", "WICKETKEEPER_BATTER", "ALL_ROUNDER", "BOWLER", "UNKNOWN",
] as const;
export const ALL_ROUNDER_LEANS = ["BATTING", "BOWLING", "BALANCED"] as const;
export const BATTING_BANDS = ["OPENING", "TOP_ORDER", "MIDDLE_ORDER", "LOWER_ORDER", "TAIL"] as const;
export const FIT_CLASSIFICATIONS = ["NATURAL", "ACCEPTABLE", "OUT_OF_ROLE", "UNKNOWN"] as const;
export const BATTING_FIT_BASES = [
  "SEASON", "SEASON_PLUS_PLAYER_HISTORY", "SEASON_SPARSE", "PLAYER_HISTORY_FALLBACK", "UNOBSERVED",
] as const;
export const EVIDENCE_LEVELS = ["HIGH", "MEDIUM", "LOW", "NONE"] as const;
export const BOWLING_WORKLOAD_CLASSES = ["NONE", "OCCASIONAL", "SUPPORT", "FRONTLINE"] as const;
export const BOWLING_FAMILIES = ["PACE", "SPIN", "MIXED", "UNKNOWN"] as const;
export const KEEPER_STATUSES = ["CONFIRMED", "UNKNOWN"] as const;

export type DerivedRole = typeof DERIVED_ROLES[number];
export type AllRounderLean = typeof ALL_ROUNDER_LEANS[number];
export type BattingBand = typeof BATTING_BANDS[number];
export type FitClassification = typeof FIT_CLASSIFICATIONS[number];
export type BattingFitBasis = typeof BATTING_FIT_BASES[number];
export type EvidenceLevel = typeof EVIDENCE_LEVELS[number];
export type BowlingWorkloadClass = typeof BOWLING_WORKLOAD_CLASSES[number];
export type BowlingFamily = typeof BOWLING_FAMILIES[number];
export type KeeperStatus = typeof KEEPER_STATUSES[number];
export type BowlingPhase = "powerplay" | "middle" | "death";

export interface BattingSlotFit {
  position: number;
  slotBand: BattingBand;
  classification: FitClassification;
  bandDistance: number | null;
}

export interface PlayerRoleConsumer {
  schemaVersion: typeof PLAYER_ROLE_CONSUMER_SCHEMA_VERSION;
  roleMetadataVersion: typeof ROLE_METADATA_VERSION;
  playerTeamSeasonId: string;
  playerId: string;
  canonicalDisplayName: string;
  seasonId: string;
  teamId: string;
  franchiseId: string;
  derivedRole: DerivedRole;
  allRounderLean: AllRounderLean | null;
  battingFit: {
    confidence: EvidenceLevel;
    basis: BattingFitBasis;
    primaryBands: BattingBand[];
    slots: BattingSlotFit[];
  };
  bowlingCapacity: number;
  bowlingWorkloadClass: BowlingWorkloadClass;
  bowlingEvidence: EvidenceLevel;
  bowlingFamily: BowlingFamily;
  phaseBowlingUsage: Record<BowlingPhase, { legalBalls: number; share: number | null }>;
  keeperMetadata: {
    metadataVersion: typeof WICKETKEEPER_METADATA_VERSION;
    capabilityStatus: KeeperStatus;
    capabilityPlayerId: string;
    seasonUsageStatus: KeeperStatus;
    seasonUsagePlayerTeamSeasonId: string;
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has an invalid shape`);
  }
}

function string(value: unknown, label: string, pattern?: RegExp): string {
  if (typeof value !== "string" || value.length === 0 || (pattern && !pattern.test(value))) {
    throw new TypeError(`${label} must be a valid non-empty string`);
  }
  return value;
}

function enumValue<const T extends readonly string[]>(value: unknown, allowed: T, label: string): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new TypeError(`${label} has unsupported value ${String(value)}`);
  }
  return value as T[number];
}

function finiteNumber(value: unknown, label: string, minimum: number, maximum?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || (maximum !== undefined && value > maximum)) {
    throw new TypeError(`${label} must be a finite number in range`);
  }
  return value;
}

function expectedBand(position: number): BattingBand {
  if (position <= 2) return "OPENING";
  if (position === 3) return "TOP_ORDER";
  if (position <= 5) return "MIDDLE_ORDER";
  if (position <= 8) return "LOWER_ORDER";
  return "TAIL";
}

export function parsePlayerRoleConsumer(value: unknown, label = "playerRoleConsumer"): PlayerRoleConsumer {
  const row = record(value, label);
  exactKeys(row, [
    "schemaVersion", "roleMetadataVersion", "playerTeamSeasonId", "playerId", "canonicalDisplayName",
    "seasonId", "teamId", "franchiseId", "derivedRole", "allRounderLean", "battingFit",
    "bowlingCapacity", "bowlingWorkloadClass", "bowlingEvidence", "bowlingFamily",
    "phaseBowlingUsage", "keeperMetadata",
  ], label);
  if (row.schemaVersion !== PLAYER_ROLE_CONSUMER_SCHEMA_VERSION || row.roleMetadataVersion !== ROLE_METADATA_VERSION) {
    throw new TypeError(`${label} has unsupported schema metadata`);
  }
  const playerId = string(row.playerId, `${label}.playerId`, /^[0-9a-f]{8}$/);
  const ptsId = string(row.playerTeamSeasonId, `${label}.playerTeamSeasonId`, /^pts:[^:]+:ipl-[0-9]{4}:[^:]+$/);
  const role = enumValue(row.derivedRole, DERIVED_ROLES, `${label}.derivedRole`);
  const lean = row.allRounderLean === null
    ? null
    : enumValue(row.allRounderLean, ALL_ROUNDER_LEANS, `${label}.allRounderLean`);
  if ((role === "ALL_ROUNDER") !== (lean !== null)) {
    throw new TypeError(`${label}.allRounderLean must exist only for ALL_ROUNDER`);
  }

  const battingFit = record(row.battingFit, `${label}.battingFit`);
  exactKeys(battingFit, ["confidence", "basis", "primaryBands", "slots"], `${label}.battingFit`);
  if (!Array.isArray(battingFit.primaryBands)) throw new TypeError(`${label}.battingFit.primaryBands must be an array`);
  const primaryBands = battingFit.primaryBands.map((band, index) =>
    enumValue(band, BATTING_BANDS, `${label}.battingFit.primaryBands[${index}]`));
  if (new Set(primaryBands).size !== primaryBands.length) throw new TypeError(`${label}.battingFit.primaryBands must be unique`);
  if (!Array.isArray(battingFit.slots) || battingFit.slots.length !== 11) {
    throw new TypeError(`${label}.battingFit.slots must cover positions 1-11`);
  }
  const slots = battingFit.slots.map((slotValue, index): BattingSlotFit => {
    const slot = record(slotValue, `${label}.battingFit.slots[${index}]`);
    exactKeys(slot, ["position", "slotBand", "classification", "bandDistance"], `${label}.battingFit.slots[${index}]`);
    const position = finiteNumber(slot.position, `${label}.battingFit.slots[${index}].position`, 1, 11);
    if (!Number.isInteger(position) || position !== index + 1) throw new TypeError(`${label}.battingFit.slots must be ordered 1-11`);
    const slotBand = enumValue(slot.slotBand, BATTING_BANDS, `${label}.battingFit.slots[${index}].slotBand`);
    if (slotBand !== expectedBand(position)) throw new TypeError(`${label}.battingFit slot band disagrees with position`);
    const classification = enumValue(slot.classification, FIT_CLASSIFICATIONS, `${label}.battingFit.slots[${index}].classification`);
    const bandDistance = slot.bandDistance === null
      ? null
      : finiteNumber(slot.bandDistance, `${label}.battingFit.slots[${index}].bandDistance`, 0, 4);
    if ((classification === "UNKNOWN") !== (bandDistance === null)) {
      throw new TypeError(`${label}.battingFit UNKNOWN and bandDistance must remain aligned`);
    }
    return { position, slotBand, classification, bandDistance };
  });

  const phases = record(row.phaseBowlingUsage, `${label}.phaseBowlingUsage`);
  exactKeys(phases, ["powerplay", "middle", "death"], `${label}.phaseBowlingUsage`);
  const phaseBowlingUsage = Object.fromEntries((["powerplay", "middle", "death"] as const).map((phase) => {
    const usage = record(phases[phase], `${label}.phaseBowlingUsage.${phase}`);
    exactKeys(usage, ["legalBalls", "share"], `${label}.phaseBowlingUsage.${phase}`);
    const legalBalls = finiteNumber(usage.legalBalls, `${label}.phaseBowlingUsage.${phase}.legalBalls`, 0);
    if (!Number.isInteger(legalBalls)) throw new TypeError(`${label}.phaseBowlingUsage.${phase}.legalBalls must be an integer`);
    const share = usage.share === null ? null : finiteNumber(usage.share, `${label}.phaseBowlingUsage.${phase}.share`, 0, 1);
    return [phase, { legalBalls, share }];
  })) as PlayerRoleConsumer["phaseBowlingUsage"];

  const keeper = record(row.keeperMetadata, `${label}.keeperMetadata`);
  exactKeys(keeper, [
    "metadataVersion", "capabilityStatus", "capabilityPlayerId", "seasonUsageStatus", "seasonUsagePlayerTeamSeasonId",
  ], `${label}.keeperMetadata`);
  if (keeper.metadataVersion !== WICKETKEEPER_METADATA_VERSION) throw new TypeError(`${label}.keeperMetadata has unsupported version`);
  if (string(keeper.capabilityPlayerId, `${label}.keeperMetadata.capabilityPlayerId`) !== playerId) {
    throw new TypeError(`${label}.keeperMetadata capability reference does not match player`);
  }
  if (string(keeper.seasonUsagePlayerTeamSeasonId, `${label}.keeperMetadata.seasonUsagePlayerTeamSeasonId`) !== ptsId) {
    throw new TypeError(`${label}.keeperMetadata usage reference does not match profile`);
  }
  const capabilityStatus = enumValue(keeper.capabilityStatus, KEEPER_STATUSES, `${label}.keeperMetadata.capabilityStatus`);
  const seasonUsageStatus = enumValue(
    keeper.seasonUsageStatus,
    KEEPER_STATUSES,
    `${label}.keeperMetadata.seasonUsageStatus`,
  );
  if (role === "WICKETKEEPER_BATTER" && seasonUsageStatus !== "CONFIRMED") {
    throw new TypeError(`${label} cannot derive WICKETKEEPER_BATTER without confirmed season usage`);
  }
  if (seasonUsageStatus === "CONFIRMED" && capabilityStatus !== "CONFIRMED") {
    throw new TypeError(`${label} confirmed keeper usage must reference confirmed capability`);
  }

  return {
    schemaVersion: PLAYER_ROLE_CONSUMER_SCHEMA_VERSION,
    roleMetadataVersion: ROLE_METADATA_VERSION,
    playerTeamSeasonId: ptsId,
    playerId,
    canonicalDisplayName: string(row.canonicalDisplayName, `${label}.canonicalDisplayName`),
    seasonId: string(row.seasonId, `${label}.seasonId`, /^ipl-[0-9]{4}$/),
    teamId: string(row.teamId, `${label}.teamId`),
    franchiseId: string(row.franchiseId, `${label}.franchiseId`),
    derivedRole: role,
    allRounderLean: lean,
    battingFit: {
      confidence: enumValue(battingFit.confidence, EVIDENCE_LEVELS, `${label}.battingFit.confidence`),
      basis: enumValue(battingFit.basis, BATTING_FIT_BASES, `${label}.battingFit.basis`),
      primaryBands,
      slots,
    },
    bowlingCapacity: finiteNumber(row.bowlingCapacity, `${label}.bowlingCapacity`, 0, 1),
    bowlingWorkloadClass: enumValue(row.bowlingWorkloadClass, BOWLING_WORKLOAD_CLASSES, `${label}.bowlingWorkloadClass`),
    bowlingEvidence: enumValue(row.bowlingEvidence, EVIDENCE_LEVELS, `${label}.bowlingEvidence`),
    bowlingFamily: enumValue(row.bowlingFamily, BOWLING_FAMILIES, `${label}.bowlingFamily`),
    phaseBowlingUsage,
    keeperMetadata: {
      metadataVersion: WICKETKEEPER_METADATA_VERSION,
      capabilityStatus,
      capabilityPlayerId: playerId,
      seasonUsageStatus,
      seasonUsagePlayerTeamSeasonId: ptsId,
    },
  };
}
