export const PLAYER_QUALITY_CONSUMER_SCHEMA_VERSION =
  "ipl-era-draft-player-quality-consumer/v1" as const;
export const PLAYER_QUALITY_MODEL_VERSION = "ipl-era-draft-player-quality/v1" as const;

export const QUALITY_EVIDENCE_STATES = ["NONE", "LIMITED", "ESTABLISHED"] as const;
export const QUALITY_COMPONENTS = ["BATTING", "BOWLING"] as const;
export const QUALITY_TIERS = ["S", "A", "B", "C", "D"] as const;

export type QualityEvidenceState = typeof QUALITY_EVIDENCE_STATES[number];
export type QualityComponent = typeof QUALITY_COMPONENTS[number];
export type QualityTier = typeof QUALITY_TIERS[number];

export interface BattingQuality {
  evidenceState: QualityEvidenceState;
  internalScore: number | null;
  battingRating: number | null;
}

export interface BowlingQuality {
  evidenceState: QualityEvidenceState;
  internalScore: number | null;
  bowlingRating: number | null;
}

export interface OverallQuality {
  primaryComponent: QualityComponent;
  evidenceState: Exclude<QualityEvidenceState, "NONE">;
  primaryInternalScore: number;
  secondaryBonus: number;
  internalScore: number;
  overallRating: number;
  qualityTier: QualityTier;
  limitedDFloorApplied: boolean;
}

export interface PlayerQualityConsumer {
  schemaVersion: typeof PLAYER_QUALITY_CONSUMER_SCHEMA_VERSION;
  qualityModelVersion: typeof PLAYER_QUALITY_MODEL_VERSION;
  playerTeamSeasonId: string;
  playerId: string;
  canonicalDisplayName: string;
  seasonId: string;
  teamId: string;
  franchiseId: string;
  batting: BattingQuality;
  bowling: BowlingQuality;
  overall: OverallQuality;
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

function enumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new TypeError(`${label} has unsupported value ${String(value)}`);
  }
  return value as T[number];
}

function finiteNumber(value: unknown, label: string, minimum?: number, maximum?: number): number {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || (minimum !== undefined && value < minimum)
    || (maximum !== undefined && value > maximum)
  ) {
    throw new TypeError(`${label} must be a finite number in range`);
  }
  return value;
}

function nullableNumber(value: unknown, label: string, minimum?: number, maximum?: number): number | null {
  return value === null ? null : finiteNumber(value, label, minimum, maximum);
}

function parseBatting(value: unknown, label: string): BattingQuality {
  const component = record(value, label);
  exactKeys(component, ["evidenceState", "internalScore", "battingRating"], label);
  const evidenceState = enumValue(component.evidenceState, QUALITY_EVIDENCE_STATES, `${label}.evidenceState`);
  const internalScore = nullableNumber(component.internalScore, `${label}.internalScore`);
  const battingRating = nullableNumber(component.battingRating, `${label}.battingRating`, 20, 100);
  if ((evidenceState === "NONE") !== (internalScore === null && battingRating === null)) {
    throw new TypeError(`${label} NONE evidence must have null score and rating`);
  }
  if ((internalScore === null) !== (battingRating === null)) {
    throw new TypeError(`${label} score and rating nullability must match`);
  }
  return { evidenceState, internalScore, battingRating };
}

function parseBowling(value: unknown, label: string): BowlingQuality {
  const component = record(value, label);
  exactKeys(component, ["evidenceState", "internalScore", "bowlingRating"], label);
  const evidenceState = enumValue(component.evidenceState, QUALITY_EVIDENCE_STATES, `${label}.evidenceState`);
  const internalScore = nullableNumber(component.internalScore, `${label}.internalScore`);
  const bowlingRating = nullableNumber(component.bowlingRating, `${label}.bowlingRating`, 20, 100);
  if ((evidenceState === "NONE") !== (internalScore === null && bowlingRating === null)) {
    throw new TypeError(`${label} NONE evidence must have null score and rating`);
  }
  if ((internalScore === null) !== (bowlingRating === null)) {
    throw new TypeError(`${label} score and rating nullability must match`);
  }
  return { evidenceState, internalScore, bowlingRating };
}

function rawTier(score: number): QualityTier {
  if (score >= 0.90) return "S";
  if (score >= 0.45) return "A";
  if (score >= -0.45) return "B";
  if (score >= -0.90) return "C";
  return "D";
}

export function parsePlayerQualityConsumer(
  value: unknown,
  label = "playerQualityConsumer",
): PlayerQualityConsumer {
  const row = record(value, label);
  exactKeys(row, [
    "schemaVersion", "qualityModelVersion", "playerTeamSeasonId", "playerId",
    "canonicalDisplayName", "seasonId", "teamId", "franchiseId", "batting",
    "bowling", "overall",
  ], label);
  if (
    row.schemaVersion !== PLAYER_QUALITY_CONSUMER_SCHEMA_VERSION
    || row.qualityModelVersion !== PLAYER_QUALITY_MODEL_VERSION
  ) {
    throw new TypeError(`${label} has unsupported schema metadata`);
  }

  const playerId = string(row.playerId, `${label}.playerId`, /^[0-9a-f]{8}$/);
  const seasonId = string(row.seasonId, `${label}.seasonId`, /^ipl-[0-9]{4}$/);
  const teamId = string(row.teamId, `${label}.teamId`);
  const playerTeamSeasonId = string(
    row.playerTeamSeasonId,
    `${label}.playerTeamSeasonId`,
    /^pts:[^:]+:ipl-[0-9]{4}:[^:]+$/,
  );
  if (playerTeamSeasonId !== `pts:${playerId}:${seasonId}:${teamId}`) {
    throw new TypeError(`${label}.playerTeamSeasonId does not match its identity fields`);
  }

  const batting = parseBatting(row.batting, `${label}.batting`);
  const bowling = parseBowling(row.bowling, `${label}.bowling`);
  const overallValue = record(row.overall, `${label}.overall`);
  exactKeys(overallValue, [
    "primaryComponent", "evidenceState", "primaryInternalScore", "secondaryBonus",
    "internalScore", "overallRating", "qualityTier", "limitedDFloorApplied",
  ], `${label}.overall`);
  const primaryComponent = enumValue(
    overallValue.primaryComponent,
    QUALITY_COMPONENTS,
    `${label}.overall.primaryComponent`,
  );
  const evidenceState = enumValue(
    overallValue.evidenceState,
    ["LIMITED", "ESTABLISHED"] as const,
    `${label}.overall.evidenceState`,
  );
  const primaryInternalScore = finiteNumber(
    overallValue.primaryInternalScore,
    `${label}.overall.primaryInternalScore`,
  );
  const secondaryBonus = finiteNumber(
    overallValue.secondaryBonus,
    `${label}.overall.secondaryBonus`,
    0,
    0.20,
  );
  const internalScore = finiteNumber(overallValue.internalScore, `${label}.overall.internalScore`);
  const overallRating = finiteNumber(overallValue.overallRating, `${label}.overall.overallRating`, 20, 100);
  const qualityTier = enumValue(overallValue.qualityTier, QUALITY_TIERS, `${label}.overall.qualityTier`);
  if (typeof overallValue.limitedDFloorApplied !== "boolean") {
    throw new TypeError(`${label}.overall.limitedDFloorApplied must be boolean`);
  }
  const limitedDFloorApplied = overallValue.limitedDFloorApplied;

  const primary = primaryComponent === "BATTING" ? batting : bowling;
  const secondary = primaryComponent === "BATTING" ? bowling : batting;
  if (primary.internalScore === null || primary.evidenceState !== evidenceState) {
    throw new TypeError(`${label}.overall must carry its primary component evidence`);
  }
  if (Math.abs(primaryInternalScore - primary.internalScore) > 0.000_002) {
    throw new TypeError(`${label}.overall primary score does not match its component`);
  }
  if (secondary.internalScore !== null && primaryInternalScore < secondary.internalScore - 0.000_002) {
    throw new TypeError(`${label}.overall primary component is not the highest available score`);
  }
  if (Math.abs(internalScore - (primaryInternalScore + secondaryBonus)) > 0.000_002) {
    throw new TypeError(`${label}.overall score does not reconcile`);
  }

  const bothEstablished = batting.evidenceState === "ESTABLISHED" && bowling.evidenceState === "ESTABLISHED";
  if (!bothEstablished && secondaryBonus !== 0) {
    throw new TypeError(`${label}.overall bonus requires both components to be ESTABLISHED`);
  }
  if (bothEstablished && batting.internalScore !== null && bowling.internalScore !== null) {
    const expectedBonus = Math.min(0.20, 0.20 * Math.max(0, Math.min(batting.internalScore, bowling.internalScore)));
    if (Math.abs(secondaryBonus - expectedBonus) > 0.000_002) {
      throw new TypeError(`${label}.overall secondary bonus does not match the v1 formula`);
    }
  }

  const hasEstablished = batting.evidenceState === "ESTABLISHED" || bowling.evidenceState === "ESTABLISHED";
  const expectedRawTier = rawTier(internalScore);
  const expectedFloor = expectedRawTier === "D" && !hasEstablished;
  if (limitedDFloorApplied !== expectedFloor) {
    throw new TypeError(`${label}.overall LIMITED D-floor flag is invalid`);
  }
  if (qualityTier !== (expectedFloor ? "C" : expectedRawTier)) {
    throw new TypeError(`${label}.overall quality tier is invalid`);
  }

  return {
    schemaVersion: PLAYER_QUALITY_CONSUMER_SCHEMA_VERSION,
    qualityModelVersion: PLAYER_QUALITY_MODEL_VERSION,
    playerTeamSeasonId,
    playerId,
    canonicalDisplayName: string(row.canonicalDisplayName, `${label}.canonicalDisplayName`),
    seasonId,
    teamId,
    franchiseId: string(row.franchiseId, `${label}.franchiseId`),
    batting,
    bowling,
    overall: {
      primaryComponent,
      evidenceState,
      primaryInternalScore,
      secondaryBonus,
      internalScore,
      overallRating,
      qualityTier,
      limitedDFloorApplied,
    },
  };
}
