import type { EraDraftCatalog, EraDraftTeamSeason } from "./eraDraftData.js";
import { assertEraDraftState } from "./eraDraftInvariants.js";
import { evaluateSelectionLegality, teamSeasonHasViableSelection } from "./eraDraftLegality.js";
import { evaluateEraDraftXi } from "./eraDraftReveal.js";
import { simulateEraDraftSeason } from "./eraDraftSimulation.js";
import {
  rankRecoveryTeamSeasons,
  selectNormalSpinTeamSeason,
  selectRespinTeamSeason,
} from "./eraDraftRng.js";
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
  type EraDraftPick,
  type EraDraftSelectionRejection,
  type EraDraftState,
  type EraDraftTransitionResult,
  type LockPlayerCommand,
  type GameCompleteState,
  type RespinCommand,
  type RevealXiCommand,
  type RevealedState,
  type SetupState,
  type SpinCommand,
  type SimulateSeasonCommand,
  type TeamSeasonId,
  type XiCompleteState,
} from "./eraDraftTypes.js";

type ResolvedSpin = {
  readonly selected: EraDraftTeamSeason;
  readonly triggeringTeamSeasonId: TeamSeasonId;
  readonly skippedDeadTeamSeasonIds: readonly TeamSeasonId[];
};

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
  switch (command.type) {
    case "CHOOSE_ERA": return chooseEra(catalog, state, command);
    case "SPIN": return spin(catalog, state, command);
    case "LOCK_PLAYER": return lockPlayer(catalog, state, command);
    case "RESPIN": return respin(catalog, state, command);
    case "REVEAL_XI": return revealXi(catalog, state, command);
    case "SIMULATE_SEASON": return simulateSeason(catalog, state, command);
  }
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
  const triggering = selectNormalSpinTeamSeason(catalog, state.rootSeed, state.eraId, spinOrdinal);
  const resolved = resolveViableSpin(catalog, state, triggering, `normal:${spinOrdinal}:${triggering.teamSeasonId}`);
  if (!resolved) {
    throw new EraDraftInvariantError("NO_VIABLE_TEAM_SEASON", `No viable team-season remains in ${state.eraId}.`);
  }
  const revision = state.revision + 1;
  const event = freezeState({
    revision,
    command: "SPIN",
    payload: {},
    resultingPhase: "AWAITING_PICK",
    spinOrdinal,
    triggeringTeamSeasonId: resolved.triggeringTeamSeasonId,
    skippedDeadTeamSeasonIds: resolved.skippedDeadTeamSeasonIds,
    selectedTeamSeasonId: resolved.selected.teamSeasonId,
  } satisfies EraDraftHistoryEntry);
  const recovered = resolved.skippedDeadTeamSeasonIds.length > 0;
  const next = freezeState({
    ...state,
    phase: "AWAITING_PICK",
    revision,
    rngCounters: {
      ...state.rngCounters,
      normalSpin: spinOrdinal + 1,
      deadSpinRecovery: state.rngCounters.deadSpinRecovery + (recovered ? 1 : 0),
    },
    history: [...state.history, event],
    currentSpin: currentSpin(resolved, "NORMAL", spinOrdinal),
  } satisfies AwaitingPickState);
  assertEraDraftState(catalog, next);
  return { ok: true, state: next, event };
}

function lockPlayer(
  catalog: EraDraftCatalog,
  state: EraDraftState,
  command: LockPlayerCommand,
): EraDraftTransitionResult {
  if (state.phase !== "AWAITING_PICK") {
    return rejected(state, command, "INVALID_PHASE", "A player can only be locked from AWAITING_PICK.");
  }
  if (!state.currentSpin) return rejected(state, command, "NO_ACTIVE_SPIN", "No active spin is available.");
  const legality = evaluateSelectionLegality(catalog, {
    eraId: state.eraId,
    picks: state.picks,
    activeTeamSeasonId: state.currentSpin.teamSeasonId,
  }, command);
  if (!legality.available) {
    const primary = legality.reasons[0]!;
    return rejected(state, command, primary.code, primary.message, legality.reasons);
  }
  const player = legality.player!;
  const battingPosition = command.battingPosition as EraDraftPick["battingPosition"];
  const pick = freezeState({
    pickNumber: state.picks.length + 1,
    playerTeamSeasonId: player.playerTeamSeasonId,
    playerId: player.playerId,
    seasonId: player.seasonId,
    teamId: player.teamId,
    franchiseId: player.franchiseId,
    teamSeasonId: player.teamSeasonId,
    battingPosition,
  } satisfies EraDraftPick);
  const picks = freezeState([...state.picks, pick]);
  const resultingPhase = picks.length === 11 ? "XI_COMPLETE" : "AWAITING_SPIN";
  const revision = state.revision + 1;
  const event = freezeState({
    revision,
    command: "LOCK_PLAYER",
    payload: { playerTeamSeasonId: player.playerTeamSeasonId, playerId: player.playerId, battingPosition },
    resultingPhase,
  } satisfies EraDraftHistoryEntry);
  const { currentSpin: _clearedSpin, ...withoutSpin } = state;
  const next = freezeState({
    ...withoutSpin,
    phase: resultingPhase,
    revision,
    picks,
    history: [...state.history, event],
  } satisfies AwaitingSpinState | XiCompleteState);
  assertEraDraftState(catalog, next);
  return { ok: true, state: next, event };
}

function respin(
  catalog: EraDraftCatalog,
  state: EraDraftState,
  command: RespinCommand,
): EraDraftTransitionResult {
  if (state.phase !== "AWAITING_PICK") return rejected(state, command, "INVALID_PHASE", "A respin requires AWAITING_PICK.");
  if (state.respin.status !== "AVAILABLE") return rejected(state, command, "RESPIN_UNAVAILABLE", "The voluntary respin has already been used.");
  const respinOrdinal = state.rngCounters.voluntaryRespin;
  const discardedTeamSeasonId = state.currentSpin.teamSeasonId;
  const triggering = selectRespinTeamSeason(catalog, state.rootSeed, state.eraId, respinOrdinal, discardedTeamSeasonId);
  if (!triggering) {
    return rejected(state, command, "RESPIN_REPLACEMENT_UNAVAILABLE", "No replacement team-season is available for this respin.");
  }
  const excluded = new Set<string>([discardedTeamSeasonId]);
  const resolved = resolveViableSpin(
    catalog,
    state,
    triggering,
    `respin:${respinOrdinal}:${discardedTeamSeasonId}:${triggering.teamSeasonId}`,
    excluded,
  );
  if (!resolved) {
    return rejected(state, command, "RESPIN_REPLACEMENT_UNAVAILABLE", "No viable replacement exists outside the discarded team-season.");
  }
  const revision = state.revision + 1;
  const event = freezeState({
    revision,
    command: "RESPIN",
    payload: {},
    resultingPhase: "AWAITING_PICK",
    respinOrdinal,
    discardedTeamSeasonId,
    triggeringTeamSeasonId: resolved.triggeringTeamSeasonId,
    skippedDeadTeamSeasonIds: resolved.skippedDeadTeamSeasonIds,
    replacementTeamSeasonId: resolved.selected.teamSeasonId,
    resultingRespinStatus: "USED",
  } satisfies EraDraftHistoryEntry);
  const recovered = resolved.skippedDeadTeamSeasonIds.length > 0;
  const next = freezeState({
    ...state,
    revision,
    rngCounters: {
      ...state.rngCounters,
      voluntaryRespin: respinOrdinal + 1,
      deadSpinRecovery: state.rngCounters.deadSpinRecovery + (recovered ? 1 : 0),
    },
    respin: { status: "USED" },
    history: [...state.history, event],
    currentSpin: currentSpin(resolved, "RESPIN", respinOrdinal),
  } satisfies AwaitingPickState);
  assertEraDraftState(catalog, next);
  return { ok: true, state: next, event };
}

function revealXi(
  catalog: EraDraftCatalog,
  state: EraDraftState,
  command: RevealXiCommand,
): EraDraftTransitionResult {
  if (state.phase !== "XI_COMPLETE") {
    return rejected(state, command, "INVALID_PHASE", "An XI can only be revealed from XI_COMPLETE.");
  }

  // Evaluation happens before any next-state object is constructed, so a data
  // or evaluator failure cannot partially advance authoritative state.
  const evaluation = evaluateEraDraftXi(catalog, state);
  const revision = state.revision + 1;
  const event = freezeState({
    revision,
    command: "REVEAL_XI",
    payload: {},
    resultingPhase: "REVEALED",
  } satisfies EraDraftHistoryEntry);
  const next = freezeState({
    ...state,
    phase: "REVEALED",
    revision,
    history: [...state.history, event],
    evaluation,
  } satisfies RevealedState);
  assertEraDraftState(catalog, next);
  return { ok: true, state: next, event };
}

function simulateSeason(
  catalog: EraDraftCatalog,
  state: EraDraftState,
  command: SimulateSeasonCommand,
): EraDraftTransitionResult {
  if (state.phase !== "REVEALED") {
    return rejected(state, command, "INVALID_PHASE", "A season can only be simulated from REVEALED.");
  }
  const season = simulateEraDraftSeason(catalog, state);
  const revision = state.revision + 1;
  const event = freezeState({
    revision,
    command: "SIMULATE_SEASON",
    payload: {},
    resultingPhase: "GAME_COMPLETE",
  } satisfies EraDraftHistoryEntry);
  const next = freezeState({
    ...state,
    phase: "GAME_COMPLETE",
    eraId: state.eraId,
    revision,
    history: [...state.history, event],
    season,
  } satisfies GameCompleteState);
  assertEraDraftState(catalog, next);
  return { ok: true, state: next, event };
}

function resolveViableSpin(
  catalog: EraDraftCatalog,
  state: AwaitingSpinState | AwaitingPickState,
  triggering: EraDraftTeamSeason,
  triggerContext: string,
  excludedTeamSeasonIds: ReadonlySet<string> = new Set(),
): ResolvedSpin | undefined {
  if (
    !excludedTeamSeasonIds.has(triggering.teamSeasonId)
    && teamSeasonHasViableSelection(catalog, state.eraId, state.picks, triggering.teamSeasonId)
  ) {
    return freezeState({ selected: triggering, triggeringTeamSeasonId: triggering.teamSeasonId, skippedDeadTeamSeasonIds: [] });
  }

  const skipped: TeamSeasonId[] = excludedTeamSeasonIds.has(triggering.teamSeasonId) ? [] : [triggering.teamSeasonId];
  const excluded = new Set(excludedTeamSeasonIds);
  excluded.add(triggering.teamSeasonId);
  const ranked = rankRecoveryTeamSeasons(
    catalog,
    state.rootSeed,
    state.eraId,
    state.rngCounters.deadSpinRecovery,
    triggerContext,
    excluded,
  );
  for (const candidate of ranked) {
    if (teamSeasonHasViableSelection(catalog, state.eraId, state.picks, candidate.teamSeasonId)) {
      return freezeState({
        selected: candidate,
        triggeringTeamSeasonId: triggering.teamSeasonId,
        skippedDeadTeamSeasonIds: skipped,
      });
    }
    skipped.push(candidate.teamSeasonId);
  }
  return undefined;
}

function currentSpin(
  resolved: ResolvedSpin,
  origin: "NORMAL" | "RESPIN",
  spinOrdinal: number,
): AwaitingPickState["currentSpin"] {
  const recovered = resolved.skippedDeadTeamSeasonIds.length > 0;
  return freezeState({
    spinOrdinal,
    origin,
    teamSeasonId: resolved.selected.teamSeasonId,
    seasonId: resolved.selected.seasonId,
    teamId: resolved.selected.teamId,
    franchiseId: resolved.selected.franchiseId,
    recovery: recovered ? {
      triggeringTeamSeasonId: resolved.triggeringTeamSeasonId,
      skippedDeadTeamSeasonIds: resolved.skippedDeadTeamSeasonIds,
    } : null,
  });
}

function rejected(
  state: EraDraftState,
  command: EraDraftCommand,
  code: EraDraftCommandRejection["code"],
  message: string,
  reasons?: readonly EraDraftSelectionRejection[],
  context?: Readonly<Record<string, unknown>>,
): EraDraftTransitionResult {
  return {
    ok: false,
    state,
    error: freezeState({
      kind: "COMMAND_REJECTED",
      code,
      message,
      command: command.type,
      phase: state.phase,
      ...(reasons ? { reasons } : {}),
      ...(context ? { context } : {}),
    }),
  };
}

function freezeState<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) value.forEach(freezeState);
  else Object.values(value as Record<string, unknown>).forEach(freezeState);
  return Object.freeze(value);
}
