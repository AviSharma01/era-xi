import type { EraDraftCatalog } from "./eraDraftData.js";
import { assertEraDraftState } from "./eraDraftInvariants.js";
import { selectNormalSpinTeamSeason } from "./eraDraftRng.js";
import {
  ERA_DRAFT_ENGINE_VERSION,
  ERA_DRAFT_STATE_SCHEMA_VERSION,
  EraDraftInvariantError,
  type AwaitingPickState,
  type AwaitingSpinState,
  type ChooseEraCommand,
  type EraDraftCommand,
  type EraDraftCommandRejection,
  type EraDraftHistoryEntry,
  type EraDraftState,
  type EraDraftTransitionResult,
  type SetupState,
  type SpinCommand,
} from "./eraDraftTypes.js";

export function createEraDraftGame(input: {
  readonly catalog: EraDraftCatalog;
  readonly rootSeed: string;
}): SetupState {
  if (typeof input.rootSeed !== "string" || input.rootSeed.length === 0) {
    throw new EraDraftInvariantError("INVALID_ROOT_SEED", "Era Draft requires an explicit non-empty root seed.");
  }
  const state = freezeState({
    engineVersion: ERA_DRAFT_ENGINE_VERSION,
    schemaVersion: ERA_DRAFT_STATE_SCHEMA_VERSION,
    catalogFingerprint: input.catalog.fingerprint,
    rootSeed: input.rootSeed,
    revision: 0,
    rngCounters: { normalSpin: 0, voluntaryRespin: 0, deadSpinRecovery: 0 },
    respin: { status: "AVAILABLE" },
    history: [],
    picks: [],
    phase: "SETUP",
  } satisfies SetupState);
  assertEraDraftState(input.catalog, state);
  return state;
}

export function reduceEraDraft(
  catalog: EraDraftCatalog,
  state: EraDraftState,
  command: EraDraftCommand,
): EraDraftTransitionResult {
  assertEraDraftState(catalog, state);
  if (command.type === "CHOOSE_ERA") return chooseEra(catalog, state, command);
  return spin(catalog, state, command);
}

function chooseEra(
  catalog: EraDraftCatalog,
  state: EraDraftState,
  command: ChooseEraCommand,
): EraDraftTransitionResult {
  if (state.phase !== "SETUP") return rejected(state, command, "INVALID_PHASE", "An era can only be chosen during SETUP.");
  if (!catalog.getEra(command.eraId)) return rejected(state, command, "UNKNOWN_ERA", `Unknown Era Draft era ${command.eraId}.`);
  const revision = state.revision + 1;
  const event = freezeState({
    revision,
    command: "CHOOSE_ERA",
    payload: { eraId: command.eraId },
    resultingPhase: "AWAITING_SPIN",
  } satisfies EraDraftHistoryEntry);
  const next = freezeState({
    ...state,
    phase: "AWAITING_SPIN",
    eraId: command.eraId,
    revision,
    history: [...state.history, event],
  } satisfies AwaitingSpinState);
  assertEraDraftState(catalog, next);
  return { ok: true, state: next, event };
}

function spin(
  catalog: EraDraftCatalog,
  state: EraDraftState,
  command: SpinCommand,
): EraDraftTransitionResult {
  if (state.phase !== "AWAITING_SPIN") return rejected(state, command, "INVALID_PHASE", "A normal spin requires AWAITING_SPIN.");
  const spinOrdinal = state.rngCounters.normalSpin;
  const selected = selectNormalSpinTeamSeason(catalog, state.rootSeed, state.eraId, spinOrdinal);
  const revision = state.revision + 1;
  const event = freezeState({
    revision,
    command: "SPIN",
    payload: {},
    resultingPhase: "AWAITING_PICK",
    selectedTeamSeasonId: selected.teamSeasonId,
  } satisfies EraDraftHistoryEntry);
  const next = freezeState({
    ...state,
    phase: "AWAITING_PICK",
    revision,
    rngCounters: { ...state.rngCounters, normalSpin: spinOrdinal + 1 },
    history: [...state.history, event],
    currentSpin: {
      spinOrdinal,
      origin: "NORMAL",
      teamSeasonId: selected.teamSeasonId,
      seasonId: selected.seasonId,
      teamId: selected.teamId,
      franchiseId: selected.franchiseId,
    },
  } satisfies AwaitingPickState);
  assertEraDraftState(catalog, next);
  return { ok: true, state: next, event };
}

function rejected(
  state: EraDraftState,
  command: EraDraftCommand,
  code: EraDraftCommandRejection["code"],
  message: string,
): EraDraftTransitionResult {
  return {
    ok: false,
    state,
    error: freezeState({ kind: "COMMAND_REJECTED", code, message, command: command.type, phase: state.phase }),
  };
}

function freezeState<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) value.forEach(freezeState);
  else Object.values(value as Record<string, unknown>).forEach(freezeState);
  return Object.freeze(value);
}
