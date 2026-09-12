export const ERA_DRAFT_HISTORICAL_STATS_SCHEMA_VERSION =
  "ipl-era-draft-historical-stats/v1" as const;

export type EraDraftHistoricalStats = {
  readonly schemaVersion: typeof ERA_DRAFT_HISTORICAL_STATS_SCHEMA_VERSION;
  readonly playerTeamSeasonId: string;
  readonly playerId: string;
  readonly seasonId: string;
  readonly teamId: string;
  readonly batting: {
    readonly innings: number;
    readonly runs: number;
    readonly balls: number;
    readonly dismissals: number;
    readonly average: number | null;
    readonly strikeRate: number | null;
  };
  readonly bowling: {
    readonly innings: number;
    readonly wickets: number;
    readonly legalBalls: number;
    readonly runsConceded: number;
    readonly economy: number | null;
  };
};

/**
 * Builds the public presentation-only record from the frozen Stage 6 artifact's
 * Stage 4 input totals. Deliberately ignores every rating/model output beside
 * these transparent cricket counts.
 */
export function deriveEraDraftHistoricalStats(value: unknown, label: string): EraDraftHistoricalStats {
  const row = record(value, label);
  const batting = record(record(row.batting, `${label}.batting`).inputs, `${label}.batting.inputs`);
  const bowling = record(record(row.bowling, `${label}.bowling`).inputs, `${label}.bowling.inputs`);
  const runs = integer(batting.runs, `${label}.batting.inputs.runs`);
  const balls = integer(batting.balls, `${label}.batting.inputs.balls`);
  const dismissals = integer(batting.dismissals, `${label}.batting.inputs.dismissals`);
  const legalBalls = integer(bowling.legalBalls, `${label}.bowling.inputs.legalBalls`);
  const runsConceded = integer(bowling.runsConceded, `${label}.bowling.inputs.runsConceded`);
  return freezeDeep({
    schemaVersion: ERA_DRAFT_HISTORICAL_STATS_SCHEMA_VERSION,
    playerTeamSeasonId: text(row.playerTeamSeasonId, `${label}.playerTeamSeasonId`),
    playerId: text(row.playerId, `${label}.playerId`),
    seasonId: text(row.seasonId, `${label}.seasonId`),
    teamId: text(row.teamId, `${label}.teamId`),
    batting: {
      innings: integer(batting.innings, `${label}.batting.inputs.innings`),
      runs,
      balls,
      dismissals,
      average: dismissals === 0 ? null : roundTwo(runs / dismissals),
      strikeRate: balls === 0 ? null : roundTwo(runs * 100 / balls),
    },
    bowling: {
      innings: integer(bowling.innings, `${label}.bowling.inputs.innings`),
      wickets: integer(bowling.creditedWickets, `${label}.bowling.inputs.creditedWickets`),
      legalBalls,
      runsConceded,
      economy: legalBalls === 0 ? null : roundTwo(runsConceded * 6 / legalBalls),
    },
  });
}

export function parseEraDraftHistoricalStats(value: unknown, label: string): EraDraftHistoricalStats {
  const row = record(value, label);
  exactKeys(row, ["schemaVersion", "playerTeamSeasonId", "playerId", "seasonId", "teamId", "batting", "bowling"], label);
  if (row.schemaVersion !== ERA_DRAFT_HISTORICAL_STATS_SCHEMA_VERSION) {
    throw new TypeError(`${label} has an unsupported schema version`);
  }
  const batting = record(row.batting, `${label}.batting`);
  exactKeys(batting, ["innings", "runs", "balls", "dismissals", "average", "strikeRate"], `${label}.batting`);
  const bowling = record(row.bowling, `${label}.bowling`);
  exactKeys(bowling, ["innings", "wickets", "legalBalls", "runsConceded", "economy"], `${label}.bowling`);
  return freezeDeep({
    schemaVersion: ERA_DRAFT_HISTORICAL_STATS_SCHEMA_VERSION,
    playerTeamSeasonId: text(row.playerTeamSeasonId, `${label}.playerTeamSeasonId`),
    playerId: text(row.playerId, `${label}.playerId`),
    seasonId: text(row.seasonId, `${label}.seasonId`),
    teamId: text(row.teamId, `${label}.teamId`),
    batting: {
      innings: integer(batting.innings, `${label}.batting.innings`),
      runs: integer(batting.runs, `${label}.batting.runs`),
      balls: integer(batting.balls, `${label}.batting.balls`),
      dismissals: integer(batting.dismissals, `${label}.batting.dismissals`),
      average: nullableNumber(batting.average, `${label}.batting.average`),
      strikeRate: nullableNumber(batting.strikeRate, `${label}.batting.strikeRate`),
    },
    bowling: {
      innings: integer(bowling.innings, `${label}.bowling.innings`),
      wickets: integer(bowling.wickets, `${label}.bowling.wickets`),
      legalBalls: integer(bowling.legalBalls, `${label}.bowling.legalBalls`),
      runsConceded: integer(bowling.runsConceded, `${label}.bowling.runsConceded`),
      economy: nullableNumber(bowling.economy, `${label}.bowling.economy`),
    },
  });
}

function roundTwo(value: number): number { return Math.round(value * 100) / 100; }

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(row: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(row).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has an invalid shape`);
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw new TypeError(`${label} must be a non-negative integer`);
  return value as number;
}

function nullableNumber(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new TypeError(`${label} must be null or a non-negative number`);
  return value;
}

function freezeDeep<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) value.forEach(freezeDeep);
  else Object.values(value as Record<string, unknown>).forEach(freezeDeep);
  return Object.freeze(value);
}
