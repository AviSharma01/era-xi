import { canonicalJson, canonicalSha256 } from "./eraDraftCanonical.js";
import type { EraDraftCatalog } from "./eraDraftData.js";
import { createDraftOffCompetition, reduceDraftOffCompetition } from "./draftOffCompetition.js";
import {
  DRAFT_OFF_COMPETITION_ENGINE_VERSION,
  DRAFT_OFF_COMPETITION_SAVE_VERSION,
  DRAFT_OFF_COMPETITION_STATE_SCHEMA_VERSION,
  DraftOffCompetitionDataError,
  type DraftOffCompetitionCommand,
  type DraftOffCompetitionGenesis,
  type DraftOffCompetitionHistoryEntry,
  type DraftOffCompetitionState,
  type DraftOffDraftCommand,
} from "./draftOffCompetitionTypes.js";
import type { EraId } from "./teamEvaluationV2.js";

type DraftOffCompetitionSave = {
  readonly saveVersion: typeof DRAFT_OFF_COMPETITION_SAVE_VERSION;
  readonly engineVersion: typeof DRAFT_OFF_COMPETITION_ENGINE_VERSION;
  readonly stateSchemaVersion: typeof DRAFT_OFF_COMPETITION_STATE_SCHEMA_VERSION;
  readonly genesis: DraftOffCompetitionGenesis;
  readonly history: readonly DraftOffCompetitionHistoryEntry[];
  readonly stateHash: string;
};

export function canonicalDraftOffCompetitionStateHash(state: DraftOffCompetitionState): string {
  return canonicalSha256(state);
}

export function serializeDraftOffCompetition(state: DraftOffCompetitionState): string {
  return canonicalJson({
    saveVersion: DRAFT_OFF_COMPETITION_SAVE_VERSION,
    engineVersion: DRAFT_OFF_COMPETITION_ENGINE_VERSION,
    stateSchemaVersion: DRAFT_OFF_COMPETITION_STATE_SCHEMA_VERSION,
    genesis: state.genesis,
    history: state.history,
    stateHash: canonicalDraftOffCompetitionStateHash(state),
  } satisfies DraftOffCompetitionSave);
}

export function replayDraftOffCompetition(input: {
  readonly catalog: EraDraftCatalog;
  readonly genesis: DraftOffCompetitionGenesis;
  readonly history: readonly DraftOffCompetitionHistoryEntry[];
  readonly expectedStateHash?: string;
}): DraftOffCompetitionState {
  let state = createDraftOffCompetition(input.catalog, input.genesis);
  for (const recorded of input.history) {
    const result = reduceDraftOffCompetition(input.catalog, state, recorded.command);
    if (!result.ok || !result.changed) {
      throw new DraftOffCompetitionDataError(
        "REPLAY_COMMAND_REJECTED",
        `Accepted ${recorded.command.type} event did not change state during deterministic replay.`,
        { revision: recorded.revision, rejectionCode: result.ok ? "IDEMPOTENT_NO_OP" : result.error.code },
      );
    }
    if (canonicalJson(result.event) !== canonicalJson(recorded)) {
      throw new DraftOffCompetitionDataError(
        "REPLAY_EVENT_MISMATCH",
        `Competition replay diverged at revision ${recorded.revision}.`,
        { command: recorded.command.type },
      );
    }
    state = result.state;
  }
  if (input.expectedStateHash && canonicalDraftOffCompetitionStateHash(state) !== input.expectedStateHash) {
    throw new DraftOffCompetitionDataError(
      "REPLAY_STATE_HASH_MISMATCH",
      "Replayed competition differs from the expected canonical state hash.",
    );
  }
  return state;
}

export function restoreDraftOffCompetition(
  catalog: EraDraftCatalog,
  serialized: string,
): DraftOffCompetitionState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new DraftOffCompetitionDataError(
      "INVALID_SERIALIZED_JSON",
      "Draft-Off competition save is not valid JSON.",
      {},
      { cause: error },
    );
  }
  const row = object(parsed, "save");
  exactKeys(row, ["saveVersion", "engineVersion", "stateSchemaVersion", "genesis", "history", "stateHash"], "save");
  requireVersion(row.saveVersion, DRAFT_OFF_COMPETITION_SAVE_VERSION, "UNSUPPORTED_SAVE_VERSION");
  requireVersion(row.engineVersion, DRAFT_OFF_COMPETITION_ENGINE_VERSION, "UNSUPPORTED_ENGINE_VERSION");
  requireVersion(row.stateSchemaVersion, DRAFT_OFF_COMPETITION_STATE_SCHEMA_VERSION, "UNSUPPORTED_STATE_SCHEMA_VERSION");
  const genesis = parseGenesis(catalog, row.genesis);
  if (genesis.catalogFingerprint !== catalog.fingerprint) {
    throw new DraftOffCompetitionDataError(
      "CATALOG_FINGERPRINT_MISMATCH",
      "Competition save belongs to a different catalog.",
      { expected: catalog.fingerprint, actual: genesis.catalogFingerprint },
    );
  }
  const history = array(row.history, "save.history").map(parseHistoryEntry);
  const stateHash = hash(row.stateHash, "save.stateHash");
  return replayDraftOffCompetition({ catalog, genesis, history, expectedStateHash: stateHash });
}

function parseGenesis(catalog: EraDraftCatalog, value: unknown): DraftOffCompetitionGenesis {
  const row = object(value, "genesis");
  exactKeys(row, ["competitionId", "catalogFingerprint", "createdAtMs", "host", "initialRound"], "genesis");
  const host = object(row.host, "genesis.host");
  exactKeys(host, ["participantId", "displayName"], "genesis.host");
  const round = object(row.initialRound, "genesis.initialRound");
  exactKeys(round, ["roundId", "roundOrdinal", "label", "eraId", "challengeSeed"], "genesis.initialRound");
  const eraId = text(round.eraId, "genesis.initialRound.eraId") as EraId;
  if (!catalog.getEra(eraId)) invalid(`Unknown era ${eraId}.`);
  return {
    competitionId: id(row.competitionId, "genesis.competitionId"),
    catalogFingerprint: hash(row.catalogFingerprint, "genesis.catalogFingerprint"),
    createdAtMs: timestamp(row.createdAtMs, "genesis.createdAtMs"),
    host: {
      participantId: id(host.participantId, "genesis.host.participantId"),
      displayName: trimmedText(host.displayName, "genesis.host.displayName"),
    },
    initialRound: {
      roundId: id(round.roundId, "genesis.initialRound.roundId"),
      roundOrdinal: integer(round.roundOrdinal, "genesis.initialRound.roundOrdinal", 1),
      label: trimmedText(round.label, "genesis.initialRound.label"),
      eraId,
      challengeSeed: text(round.challengeSeed, "genesis.initialRound.challengeSeed"),
    },
  };
}

function parseHistoryEntry(value: unknown, index: number): DraftOffCompetitionHistoryEntry {
  const label = `history[${index}]`;
  const row = object(value, label);
  exactKeys(row, ["revision", "command", "resultingCompetitionPhase"], label);
  return {
    revision: integer(row.revision, `${label}.revision`, 1),
    command: parseCommand(row.command, `${label}.command`),
    resultingCompetitionPhase: oneOf(
      row.resultingCompetitionPhase,
      ["LOBBY", "IN_PROGRESS", "COMPLETE"] as const,
      `${label}.resultingCompetitionPhase`,
    ),
  };
}

function parseCommand(value: unknown, label: string): DraftOffCompetitionCommand {
  const row = object(value, label);
  const type = oneOf(row.type, [
    "JOIN_COMPETITION",
    "LEAVE_COMPETITION",
    "START_ROUND",
    "APPLY_DRAFT_COMMAND",
    "SUBMIT_XI",
    "FINALIZE_ROUND",
  ] as const, `${label}.type`);
  if (type === "JOIN_COMPETITION") {
    const keys = row.displayName === undefined ? ["type", "participantId", "atMs"] : ["type", "participantId", "displayName", "atMs"];
    exactKeys(row, keys, label);
    return {
      type,
      participantId: id(row.participantId, `${label}.participantId`),
      ...(row.displayName === undefined ? {} : { displayName: trimmedText(row.displayName, `${label}.displayName`) }),
      atMs: timestamp(row.atMs, `${label}.atMs`),
    };
  }
  if (type === "LEAVE_COMPETITION") {
    exactKeys(row, ["type", "participantId", "atMs"], label);
    return { type, participantId: id(row.participantId, `${label}.participantId`), atMs: timestamp(row.atMs, `${label}.atMs`) };
  }
  if (type === "START_ROUND") {
    exactKeys(row, ["type", "actorParticipantId", "roundId", "atMs", "deadlineAtMs"], label);
    return {
      type,
      actorParticipantId: id(row.actorParticipantId, `${label}.actorParticipantId`),
      roundId: id(row.roundId, `${label}.roundId`),
      atMs: timestamp(row.atMs, `${label}.atMs`),
      deadlineAtMs: timestamp(row.deadlineAtMs, `${label}.deadlineAtMs`),
    };
  }
  if (type === "APPLY_DRAFT_COMMAND") {
    exactKeys(row, ["type", "participantId", "atMs", "expectedDraftRevision", "draftCommand"], label);
    return {
      type,
      participantId: id(row.participantId, `${label}.participantId`),
      atMs: timestamp(row.atMs, `${label}.atMs`),
      expectedDraftRevision: integer(row.expectedDraftRevision, `${label}.expectedDraftRevision`, 0),
      draftCommand: parseDraftCommand(row.draftCommand, `${label}.draftCommand`),
    };
  }
  if (type === "SUBMIT_XI") {
    exactKeys(row, ["type", "participantId", "atMs", "expectedDraftRevision"], label);
    return {
      type,
      participantId: id(row.participantId, `${label}.participantId`),
      atMs: timestamp(row.atMs, `${label}.atMs`),
      expectedDraftRevision: integer(row.expectedDraftRevision, `${label}.expectedDraftRevision`, 0),
    };
  }
  exactKeys(row, ["type", "roundId", "atMs"], label);
  return { type, roundId: id(row.roundId, `${label}.roundId`), atMs: timestamp(row.atMs, `${label}.atMs`) };
}

function parseDraftCommand(value: unknown, label: string): DraftOffDraftCommand {
  const row = object(value, label);
  const type = oneOf(row.type, ["SPIN", "RESPIN", "LOCK_PLAYER"] as const, `${label}.type`);
  if (type === "SPIN" || type === "RESPIN") {
    exactKeys(row, ["type"], label);
    return { type };
  }
  exactKeys(row, ["type", "playerTeamSeasonId", "battingPosition"], label);
  return {
    type,
    playerTeamSeasonId: text(row.playerTeamSeasonId, `${label}.playerTeamSeasonId`),
    battingPosition: integer(row.battingPosition, `${label}.battingPosition`, 1, 11),
  };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) invalid(`${label} must be an array.`);
  return value;
}

function exactKeys(row: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(row).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new DraftOffCompetitionDataError(
      "INVALID_SERIALIZED_SHAPE",
      `${label} has missing or unexpected fields.`,
      { actual, expected: wanted },
    );
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) invalid(`${label} must be a non-empty string.`);
  return value;
}

function trimmedText(value: unknown, label: string): string {
  const result = text(value, label);
  if (result !== result.trim()) invalid(`${label} must already be trimmed.`);
  return result;
}

function id(value: unknown, label: string): string {
  return trimmedText(value, label);
}

function integer(value: unknown, label: string, minimum: number, maximum?: number): number {
  if (
    !Number.isSafeInteger(value)
    || (value as number) < minimum
    || (maximum !== undefined && (value as number) > maximum)
  ) invalid(`${label} must be a safe integer in range.`);
  return value as number;
}

function timestamp(value: unknown, label: string): number {
  return integer(value, label, 0);
}

function hash(value: unknown, label: string): string {
  const result = text(value, label);
  if (!/^[0-9a-f]{64}$/.test(result)) invalid(`${label} must be a SHA-256 hash.`);
  return result;
}

function oneOf<const T extends readonly string[]>(value: unknown, allowed: T, label: string): T[number] {
  if (!allowed.includes(value as never)) invalid(`${label} has unsupported value ${String(value)}.`);
  return value as T[number];
}

function requireVersion(value: unknown, expected: string, code: string): void {
  if (value !== expected) throw new DraftOffCompetitionDataError(code, `Unsupported version ${String(value)}.`);
}

function invalid(message: string): never {
  throw new DraftOffCompetitionDataError("INVALID_SERIALIZED_STATE", message);
}
