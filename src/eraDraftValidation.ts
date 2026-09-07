import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { canonicalJson } from "./eraDraftCanonical.js";
import {
  loadEraDraftCatalog,
  type EraDraftCatalog,
  type EraDraftPlayerRecord,
} from "./eraDraftData.js";
import { createEraDraftGame, reduceEraDraft } from "./eraDraftEngine.js";
import { assertEraDraftState } from "./eraDraftInvariants.js";
import {
  evaluateFutureCompletion,
  evaluateSelectionLegality,
  getOpenBattingPositions,
} from "./eraDraftLegality.js";
import {
  canonicalEraDraftStateHash,
  restoreEraDraftState,
  serializeEraDraftState,
} from "./eraDraftPersistence.js";
import { projectEraDraftPublicState } from "./eraDraftProjection.js";
import { replayEraDraftState } from "./eraDraftReplay.js";
import {
  rankRecoveryTeamSeasons,
  selectNormalSpinTeamSeason,
} from "./eraDraftRng.js";
import { deriveEraDraftSimulationSeeds } from "./eraDraftSimulation.js";
import {
  ERA_DRAFT_ENGINE_VERSION,
  ERA_DRAFT_SAVE_VERSION,
  ERA_DRAFT_SIMULATION_SEED_VERSION,
  ERA_DRAFT_STATE_SCHEMA_VERSION,
  EraDraftInvariantError,
  type AwaitingPickState,
  type EraDraftCommand,
  type EraDraftCommandRejectionCode,
  type EraDraftHiddenState,
  type EraDraftState,
  type RevealedState,
} from "./eraDraftTypes.js";
import { random01, SIMULATION_V2_VERSION } from "./simulationV2.js";
import { ERA_IDS, TEAM_EVALUATION_V2_VERSION, type EraId } from "./teamEvaluationV2.js";

export const ERA_DRAFT_VALIDATION_VERSION = "ipl-era-draft-validation/v1" as const;

export type EraDraftValidationOptions = {
  readonly drafts: number;
  readonly foundationCycles: number;
  readonly validationSeed: string;
  readonly catalog?: EraDraftCatalog;
  readonly catalogLoadMilliseconds?: number;
};

type Strategy = "RANDOM_LEGAL" | "KEEPER_DEFERRAL" | "OVERSEAS_PRESSURE" | "DUPLICATE_PRESSURE" | "POOR_BATTING_ORDER";
type RespinPolicy = "NEVER" | "EARLY" | "LATE" | "STRATEGIC";
type RestoreTarget = "AWAITING_SPIN" | "AWAITING_PICK" | "PARTIAL_DRAFT" | "RECOVERY" | "RESPIN" | "XI_COMPLETE" | "REVEALED";

type AvailabilityAccumulator = {
  observations: number;
  total: number;
  minimum: number;
};

type StrengthAccumulator = {
  count: number;
  total: number;
  minimum: number;
  maximum: number;
};

type EraAccumulator = {
  drafts: number;
  completed: number;
  deadEnds: number;
  recoveries: number;
  respins: number;
  expectedRejections: Record<string, number>;
  availability: AvailabilityAccumulator[];
  keeperPick: number[];
  finalOverseas: number[];
  strength: StrengthAccumulator;
  fit: Record<string, number>;
};

type ValidationCounters = {
  acceptedCommands: number;
  expectedRejections: Record<string, number>;
  automaticRecoveries: number;
  respins: number;
  serializationAttempts: number;
  serializationFailures: number;
  restoreDivergences: number;
  replayRuns: number;
  replayEventMismatches: number;
  replayFinalHashMismatches: number;
  hiddenLeaks: number;
  invariantFailures: number;
  illegalCompletedXis: number;
  nondeterministicResults: number;
  unexpectedDeadEnds: number;
  laterEraExpectedSimulationRejections: Record<string, number>;
  duplicatePressureAttempts: number;
  overseasPressureAttempts: number;
  keeperFeasibilityPressureAttempts: number;
  occupiedSlotPressureAttempts: number;
  rngIsolationChecks: number;
};

type FoundationAccumulator = {
  cycles: number;
  qualified: number;
  finalist: number;
  champion: number;
  positions: number[];
  nrr: StrengthAccumulator;
  strength: StrengthAccumulator;
  omitted: Record<string, number>;
};

type TimingAccumulator = {
  draftMilliseconds: number;
  draftCount: number;
  simulationMilliseconds: number;
  simulationCount: number;
};

type Choice = {
  readonly player: EraDraftPlayerRecord;
  readonly battingPosition: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;
  readonly fit: string;
};

type ChoiceAnalysis = {
  readonly legal: readonly Choice[];
  readonly futureFeasibilityRejection?: {
    readonly playerTeamSeasonId: string;
    readonly battingPosition: Choice["battingPosition"];
  };
};

export type EraDraftValidationResult = ReturnType<typeof runEraDraftValidation>;

export function runEraDraftValidation(options: EraDraftValidationOptions) {
  positiveInteger(options.drafts, "drafts");
  positiveInteger(options.foundationCycles, "foundationCycles");
  if (!options.validationSeed) throw new Error("validationSeed must be non-empty.");

  const validationStarted = performance.now();
  const catalog = options.catalog ?? loadEraDraftCatalog();
  const strategyCounts = Object.fromEntries(STRATEGIES.map((strategy) => [strategy, 0])) as Record<Strategy, number>;
  const respinPolicyCounts = Object.fromEntries(RESPIN_POLICIES.map((policy) => [policy, 0])) as Record<RespinPolicy, number>;
  const restoreByTarget = Object.fromEntries(RESTORE_TARGETS.map((target) => [target, 0])) as Record<RestoreTarget, number>;
  const eras = Object.fromEntries(ERA_IDS.map((eraId) => [eraId, newEraAccumulator()])) as Record<EraId, EraAccumulator>;
  const counters: ValidationCounters = {
    acceptedCommands: 0,
    expectedRejections: {},
    automaticRecoveries: 0,
    respins: 0,
    serializationAttempts: 0,
    serializationFailures: 0,
    restoreDivergences: 0,
    replayRuns: 0,
    replayEventMismatches: 0,
    replayFinalHashMismatches: 0,
    hiddenLeaks: 0,
    invariantFailures: 0,
    illegalCompletedXis: 0,
    nondeterministicResults: 0,
    unexpectedDeadEnds: 0,
    laterEraExpectedSimulationRejections: {},
    duplicatePressureAttempts: 0,
    overseasPressureAttempts: 0,
    keeperFeasibilityPressureAttempts: 0,
    occupiedSlotPressureAttempts: 0,
    rngIsolationChecks: 0,
  };
  const foundation = newFoundationAccumulator(catalog);
  const timings: TimingAccumulator = { draftMilliseconds: 0, draftCount: 0, simulationMilliseconds: 0, simulationCount: 0 };
  const recoveryPaths: Record<string, number> = {};
  const fixtureChecks = runSyntheticRecoveryValidation(catalog, options.validationSeed, counters, recoveryPaths, restoreByTarget);
  const primitiveTimings = measurePrimitiveTimings(catalog, options.validationSeed);

  let firstFoundationReveal: RevealedState | undefined;
  for (let index = 0; index < options.drafts; index += 1) {
    const eraId = ERA_IDS[index % ERA_IDS.length]!;
    runOne(index, false, eraId);
  }
  for (let index = 0; index < options.foundationCycles; index += 1) {
    runOne(options.drafts + index, true, "era-foundation");
  }

  if (!firstFoundationReveal) throw new Error("Foundation validation produced no revealed state.");
  const rngIsolation = runRngIsolationValidation(catalog, firstFoundationReveal, counters);
  const totalCycles = options.drafts + options.foundationCycles;
  const totalMilliseconds = performance.now() - validationStarted;

  const deterministic = {
    validationVersion: ERA_DRAFT_VALIDATION_VERSION,
    validationSeed: options.validationSeed,
    identities: {
      engineVersion: ERA_DRAFT_ENGINE_VERSION,
      stateSchemaVersion: ERA_DRAFT_STATE_SCHEMA_VERSION,
      saveVersion: ERA_DRAFT_SAVE_VERSION,
      simulationSeedVersion: ERA_DRAFT_SIMULATION_SEED_VERSION,
      catalogFingerprint: catalog.fingerprint,
      teamEvaluationVersion: TEAM_EVALUATION_V2_VERSION,
      simulationVersion: SIMULATION_V2_VERSION,
    },
    requestedRuns: { draftOnly: options.drafts, foundationFullCycles: options.foundationCycles },
    completedRuns: { draftOnly: options.drafts, foundationFullCycles: foundation.cycles, totalDrafts: totalCycles },
    strategyCounts,
    respinPolicyCounts,
    perEra: Object.fromEntries(ERA_IDS.map((eraId) => [eraId, summarizeEra(eras[eraId])])),
    acceptedCommands: counters.acceptedCommands,
    expectedRejectedCommandsByCode: sortedRecord(counters.expectedRejections),
    recovery: {
      automaticCount: counters.automaticRecoveries,
      paths: sortedRecord(recoveryPaths),
      synthetic: fixtureChecks,
    },
    respinCount: counters.respins,
    pressure: {
      duplicateAttempts: counters.duplicatePressureAttempts,
      overseasLimitAttempts: counters.overseasPressureAttempts,
      keeperFeasibilityAttempts: counters.keeperFeasibilityPressureAttempts,
      occupiedSlotAttempts: counters.occupiedSlotPressureAttempts,
    },
    serialization: {
      attempts: counters.serializationAttempts,
      failures: counters.serializationFailures,
      postRestoreDivergences: counters.restoreDivergences,
      byTarget: restoreByTarget,
    },
    replay: {
      runs: counters.replayRuns,
      eventMismatches: counters.replayEventMismatches,
      finalHashMismatches: counters.replayFinalHashMismatches,
    },
    rngIsolation,
    hiddenLeakCount: counters.hiddenLeaks,
    invariantFailureCount: counters.invariantFailures,
    illegalCompletedXiCount: counters.illegalCompletedXis,
    nondeterministicResultCount: counters.nondeterministicResults,
    unexpectedDeadEndCount: counters.unexpectedDeadEnds,
    laterEraExpectedSimulationRejections: sortedRecord(counters.laterEraExpectedSimulationRejections),
    foundation: summarizeFoundation(foundation),
    acceptance: {
      passed: acceptancePassed(counters, eras, options),
      invariantFailures: counters.invariantFailures === 0,
      illegalCompletedXis: counters.illegalCompletedXis === 0,
      hiddenLeaks: counters.hiddenLeaks === 0,
      replayEventMismatches: counters.replayEventMismatches === 0,
      replayFinalHashMismatches: counters.replayFinalHashMismatches === 0,
      restoreDivergences: counters.restoreDivergences === 0,
      nondeterministicOutputs: counters.nondeterministicResults === 0,
      unexpectedDeadEnds: counters.unexpectedDeadEnds === 0,
      legalDraftCompletionRate: round(totalCompleted(eras) / totalCycles),
      laterEraSimulationRejectionsExact: ERA_IDS.slice(1).every((eraId) =>
        counters.laterEraExpectedSimulationRejections[eraId] === eras[eraId].completed),
      foundationStructuresValid: foundation.cycles === options.foundationCycles,
    },
  };
  const performanceReport = {
    catalogLoadMilliseconds: round(options.catalogLoadMilliseconds ?? 0),
    oneCandidateProjectionMilliseconds: primitiveTimings.candidateProjection,
    oneFeasibilityEvaluationMilliseconds: primitiveTimings.feasibility,
    averageFullDraftMilliseconds: round(timings.draftMilliseconds / timings.draftCount),
    averageFoundationSimulationMilliseconds: round(timings.simulationMilliseconds / Math.max(1, timings.simulationCount)),
    validationMilliseconds: round(totalMilliseconds),
    draftsPerSecond: round(totalCycles / (totalMilliseconds / 1000)),
  };
  if (!deterministic.acceptance.passed) throw new Error(`Era Draft validation acceptance failed: ${canonicalJson(deterministic.acceptance)}`);
  return { deterministic, performance: performanceReport };

  function runOne(runOrdinal: number, simulateFoundation: boolean, eraId: EraId): void {
    const strategyCycle = Math.floor(runOrdinal / ERA_IDS.length);
    const strategy = STRATEGIES[strategyCycle % STRATEGIES.length]!;
    const respinPolicy = RESPIN_POLICIES[
      Math.floor(strategyCycle / STRATEGIES.length) % RESPIN_POLICIES.length
    ]!;
    const restoreTarget = RESTORE_TARGETS[runOrdinal % RESTORE_TARGETS.length]!;
    const gameSeed = `${options.validationSeed}:game:${runOrdinal}:${eraId}:${strategy}:${respinPolicy}`;
    const progress: { phase: EraDraftState["phase"]; acceptedCommands: EraDraftCommand[] } = {
      phase: "SETUP",
      acceptedCommands: [],
    };
    strategyCounts[strategy] += 1;
    respinPolicyCounts[respinPolicy] += 1;
    eras[eraId].drafts += 1;
    const draftStarted = performance.now();
    try {
      const outcome = runDraft({ catalog, eraId, gameSeed, runOrdinal, strategy, respinPolicy, restoreTarget, progress }, counters, eras[eraId], recoveryPaths, restoreByTarget);
      timings.draftMilliseconds += performance.now() - draftStarted;
      timings.draftCount += 1;
      const reveal = outcome.revealed;
      if (eraId === "era-foundation" && !firstFoundationReveal) firstFoundationReveal = reveal;
      if (simulateFoundation) {
        const simulationStarted = performance.now();
        const complete = outcome.applyAccepted({ type: "SIMULATE_SEASON" });
        timings.simulationMilliseconds += performance.now() - simulationStarted;
        timings.simulationCount += 1;
        if (complete.phase !== "GAME_COMPLETE") throw new Error("Foundation simulation did not reach GAME_COMPLETE.");
        validateFoundationComplete(catalog, complete, foundation);
        replayCompleted(catalog, complete, counters);
      } else {
        replayCompleted(catalog, reveal, counters);
        if (eraId !== "era-foundation") {
          outcome.expectRejected({ type: "SIMULATE_SEASON" }, "SIMULATION_CONTENT_UNAVAILABLE");
          increment(counters.laterEraExpectedSimulationRejections, eraId);
        }
      }
    } catch (error) {
      eras[eraId].deadEnds += 1;
      counters.unexpectedDeadEnds += 1;
      throw new EraDraftValidationError("GAME_VALIDATION_FAILED", error instanceof Error ? error.message : String(error), {
        validationSeed: options.validationSeed,
        gameSeed,
        eraId,
        strategy,
        respinPolicy,
        runOrdinal,
        acceptedCommandSequence: progress.acceptedCommands,
        failurePhase: progress.phase,
        failureCode: error instanceof EraDraftInvariantError ? error.code : "VALIDATION_ASSERTION_FAILED",
      }, error);
    }
  }
}

const STRATEGIES: readonly Strategy[] = [
  "RANDOM_LEGAL", "KEEPER_DEFERRAL", "OVERSEAS_PRESSURE", "DUPLICATE_PRESSURE", "POOR_BATTING_ORDER",
];
const RESPIN_POLICIES: readonly RespinPolicy[] = ["NEVER", "EARLY", "LATE", "STRATEGIC"];
const RESTORE_TARGETS: readonly RestoreTarget[] = [
  "AWAITING_SPIN", "AWAITING_PICK", "PARTIAL_DRAFT", "RECOVERY", "RESPIN", "XI_COMPLETE", "REVEALED",
];

function runDraft(
  input: {
    readonly catalog: EraDraftCatalog;
    readonly eraId: EraId;
    readonly gameSeed: string;
    readonly runOrdinal: number;
    readonly strategy: Strategy;
    readonly respinPolicy: RespinPolicy;
    readonly restoreTarget: RestoreTarget;
    readonly progress: { phase: EraDraftState["phase"]; acceptedCommands: EraDraftCommand[] };
  },
  counters: ValidationCounters,
  era: EraAccumulator,
  recoveryPaths: Record<string, number>,
  restoreByTarget: Record<RestoreTarget, number>,
): {
  readonly revealed: RevealedState;
  readonly applyAccepted: (command: EraDraftCommand) => EraDraftState;
  readonly expectRejected: (command: EraDraftCommand, code: EraDraftCommandRejectionCode) => void;
} {
  let state: EraDraftState = createEraDraftGame({ catalog: input.catalog, rootSeed: input.gameSeed });
  let mirror: EraDraftState | undefined;
  let restored = false;
  scanHidden(input.catalog, state, counters);

  const maybeRestore = (): void => {
    if (restored || !matchesRestoreTarget(state, input.restoreTarget)) return;
    counters.serializationAttempts += 1;
    try {
      const serialized = serializeEraDraftState(state);
      mirror = restoreEraDraftState(input.catalog, serialized);
      if (canonicalEraDraftStateHash(mirror) !== canonicalEraDraftStateHash(state)) {
        counters.restoreDivergences += 1;
        throw new Error("Immediate restore hash divergence.");
      }
      restoreByTarget[input.restoreTarget] += 1;
      restored = true;
    } catch (error) {
      counters.serializationFailures += 1;
      throw error;
    }
  };

  const applyAccepted = (command: EraDraftCommand): EraDraftState => {
    const result = reduceEraDraft(input.catalog, state, command);
    if (!result.ok) throw new Error(`Expected ${command.type} acceptance, received ${result.error.code}.`);
    counters.acceptedCommands += 1;
    assertState(input.catalog, result.state, counters);
    if (mirror) {
      const mirrored = reduceEraDraft(input.catalog, mirror, command);
      if (!mirrored.ok || canonicalJson(mirrored.event) !== canonicalJson(result.event)
        || canonicalEraDraftStateHash(mirrored.state) !== canonicalEraDraftStateHash(result.state)) {
        counters.restoreDivergences += 1;
        throw new Error(`Post-restore divergence after ${command.type}.`);
      }
      mirror = mirrored.state;
    }
    state = result.state;
    input.progress.acceptedCommands.push(command);
    input.progress.phase = state.phase;
    recordRecovery(result.event, counters, era, recoveryPaths);
    if (state.phase !== "REVEALED" && state.phase !== "GAME_COMPLETE") {
      const project = state.phase !== "AWAITING_PICK"
        || input.runOrdinal % 25 === 0
        || (input.runOrdinal < 250 && (state.currentSpin.origin === "RESPIN" || state.currentSpin.recovery !== null));
      scanHidden(input.catalog, state, counters, project);
    }
    maybeRestore();
    return state;
  };

  const expectRejected = (command: EraDraftCommand, code: EraDraftCommandRejectionCode): void => {
    const beforeHash = canonicalEraDraftStateHash(state);
    const beforeRevision = state.revision;
    const beforeHistory = state.history;
    const beforeCounters = state.rngCounters;
    const result = reduceEraDraft(input.catalog, state, command);
    if (result.ok || result.error.code !== code || result.state !== state
      || canonicalEraDraftStateHash(result.state) !== beforeHash || result.state.revision !== beforeRevision
      || result.state.history !== beforeHistory || result.state.rngCounters !== beforeCounters) {
      counters.nondeterministicResults += 1;
      throw new Error(`Rejected ${command.type} did not preserve state or return ${code}.`);
    }
    increment(counters.expectedRejections, code);
    increment(era.expectedRejections, code);
    if (mirror) {
      const mirrored = reduceEraDraft(input.catalog, mirror, command);
      if (mirrored.ok || mirrored.error.code !== code || canonicalEraDraftStateHash(mirrored.state) !== beforeHash) {
        counters.restoreDivergences += 1;
        throw new Error(`Restored rejection diverged for ${command.type}.`);
      }
    }
  };

  if (input.runOrdinal % 10 === 0) expectRejected({ type: "SPIN" }, "INVALID_PHASE");
  state = applyAccepted({ type: "CHOOSE_ERA", eraId: input.eraId });
  maybeRestore();
  if (input.runOrdinal % 10 === 0) {
    expectRejected({ type: "LOCK_PLAYER", playerTeamSeasonId: "pts:validation-invalid", battingPosition: 1 }, "INVALID_PHASE");
  }

  for (let pickIndex = 0; pickIndex < 11; pickIndex += 1) {
    state = applyAccepted({ type: "SPIN" });
    if (state.phase !== "AWAITING_PICK") throw new Error("SPIN did not reach AWAITING_PICK.");
    if (input.runOrdinal % 10 === 0) expectRejected({ type: "SPIN" }, "INVALID_PHASE");

    let analysis = analyzeChoices(input.catalog, state, input.strategy);
    let choices = analysis.legal;
    recordAvailability(era.availability[pickIndex]!, choices);
    if (choices.length === 0) throw new Error(`No legal choice at pick ${pickIndex + 1}.`);

    const shouldRespin = state.respin.status === "AVAILABLE" && (
      (input.respinPolicy === "EARLY" && pickIndex === 0)
      || (input.respinPolicy === "LATE" && pickIndex === 9)
      || (input.respinPolicy === "STRATEGIC" && pickIndex >= 7
        && (!choices.some((choice) => choice.player.role.keeperMetadata.capabilityStatus === "CONFIRMED") || pickIndex === 8))
    );
    if (shouldRespin) {
      state = applyAccepted({ type: "RESPIN" });
      counters.respins += 1;
      era.respins += 1;
      if (state.phase !== "AWAITING_PICK") throw new Error("RESPIN did not retain AWAITING_PICK.");
      expectRejected({ type: "RESPIN" }, "RESPIN_UNAVAILABLE");
      analysis = analyzeChoices(input.catalog, state, input.strategy);
      choices = analysis.legal;
      if (choices.length === 0) throw new Error("RESPIN exposed no legal choice.");
    }

    pressureRejections(input.catalog, state, choices, analysis, input.strategy, input.runOrdinal, expectRejected, counters);
    const choice = choose(choices, input.strategy, state, input.gameSeed, pickIndex);
    state = applyAccepted({
      type: "LOCK_PLAYER",
      playerTeamSeasonId: choice.player.playerTeamSeasonId,
      battingPosition: choice.battingPosition,
    });
  }

  if (state.phase !== "XI_COMPLETE") {
    counters.illegalCompletedXis += 1;
    throw new Error("Draft did not reach XI_COMPLETE.");
  }
  validateCompletedXi(input.catalog, state, counters);
  maybeRestore();
  state = applyAccepted({ type: "REVEAL_XI" });
  if (state.phase !== "REVEALED") throw new Error("Reveal did not reach REVEALED.");
  maybeRestore();
  era.completed += 1;
  const keeperPick = state.picks.find((pick) =>
    input.catalog.getPlayer(pick.playerTeamSeasonId)?.role.keeperMetadata.capabilityStatus === "CONFIRMED")!.pickNumber;
  era.keeperPick[keeperPick - 1] += 1;
  const overseas = state.picks.filter((pick) => input.catalog.getPlayer(pick.playerTeamSeasonId)?.rosterStatus === "OVERSEAS").length;
  era.finalOverseas[overseas] += 1;
  addStrength(era.strength, state.evaluation.adjustedStrength.overall);
  for (const [fit, count] of Object.entries(state.evaluation.diagnostics.positionFitCounts)) increment(era.fit, fit, count);
  return { revealed: state, applyAccepted, expectRejected };
}

function pressureRejections(
  catalog: EraDraftCatalog,
  state: AwaitingPickState,
  legal: readonly Choice[],
  analysis: ChoiceAnalysis,
  strategy: Strategy,
  runOrdinal: number,
  expectRejected: (command: EraDraftCommand, code: EraDraftCommandRejectionCode) => void,
  counters: ValidationCounters,
): void {
  const openPosition = legal[0]!.battingPosition;
  const candidates = catalog.getCandidatesForTeamSeason(state.currentSpin.teamSeasonId);
  if (strategy === "DUPLICATE_PRESSURE" && state.picks.length > 0) {
    const duplicate = candidates.find((candidate) => state.picks.some((pick) => pick.playerId === candidate.playerId));
    if (duplicate) {
      expectRejected({ type: "LOCK_PLAYER", playerTeamSeasonId: duplicate.playerTeamSeasonId, battingPosition: openPosition }, "DUPLICATE_CANONICAL_PLAYER");
      counters.duplicatePressureAttempts += 1;
    }
  }
  const overseasCount = state.picks.filter((pick) => catalog.getPlayer(pick.playerTeamSeasonId)?.rosterStatus === "OVERSEAS").length;
  if (strategy === "OVERSEAS_PRESSURE" && overseasCount >= 4) {
    const fifth = candidates.find((candidate) => candidate.rosterStatus === "OVERSEAS"
      && !state.picks.some((pick) => pick.playerId === candidate.playerId));
    if (fifth) {
      expectRejected({ type: "LOCK_PLAYER", playerTeamSeasonId: fifth.playerTeamSeasonId, battingPosition: openPosition }, "OVERSEAS_LIMIT");
      counters.overseasPressureAttempts += 1;
    }
  }
  const keeperPressure = analysis.futureFeasibilityRejection;
  if (keeperPressure && strategy === "KEEPER_DEFERRAL") {
    expectRejected({
      type: "LOCK_PLAYER",
      playerTeamSeasonId: keeperPressure.playerTeamSeasonId,
      battingPosition: keeperPressure.battingPosition,
    }, "FUTURE_XI_IMPOSSIBLE");
    counters.keeperFeasibilityPressureAttempts += 1;
  }
  if (runOrdinal % 10 === 0 && state.picks.length > 0) {
    const occupied = state.picks[0]!.battingPosition;
    const candidate = legal.find((choice) => !state.picks.some((pick) => pick.playerId === choice.player.playerId))!.player;
    expectRejected({ type: "LOCK_PLAYER", playerTeamSeasonId: candidate.playerTeamSeasonId, battingPosition: occupied }, "POSITION_OCCUPIED");
    counters.occupiedSlotPressureAttempts += 1;
  }
}

function analyzeChoices(catalog: EraDraftCatalog, state: AwaitingPickState, strategy: Strategy): ChoiceAnalysis {
  const context = { eraId: state.eraId, picks: state.picks, activeTeamSeasonId: state.currentSpin.teamSeasonId };
  const openPositions = [...getOpenBattingPositions(state.picks)];
  const legal: Choice[] = [];
  let futureFeasibilityRejection: ChoiceAnalysis["futureFeasibilityRejection"];
  for (const player of catalog.getCandidatesForTeamSeason(state.currentSpin.teamSeasonId)) {
    const positions = [...openPositions].sort((left, right) => {
      if (strategy !== "POOR_BATTING_ORDER") return left - right;
      const rank: Record<string, number> = { OUT_OF_ROLE: 0, UNKNOWN: 1, ACCEPTABLE: 2, NATURAL: 3 };
      return (rank[player.role.battingFit.slots[left - 1]!.classification] ?? 4)
        - (rank[player.role.battingFit.slots[right - 1]!.classification] ?? 4) || left - right;
    });
    for (const battingPosition of positions) {
      const result = evaluateSelectionLegality(catalog, context, { playerTeamSeasonId: player.playerTeamSeasonId, battingPosition });
      if (result.available) {
        legal.push({ player, battingPosition, fit: player.role.battingFit.slots[battingPosition - 1]!.classification });
        break;
      }
      if (!futureFeasibilityRejection && result.reasons.length === 1 && result.reasons[0]?.code === "FUTURE_XI_IMPOSSIBLE") {
        futureFeasibilityRejection = { playerTeamSeasonId: player.playerTeamSeasonId, battingPosition };
      }
    }
  }
  legal.sort((left, right) => left.player.playerTeamSeasonId.localeCompare(right.player.playerTeamSeasonId)
    || left.battingPosition - right.battingPosition);
  return { legal, futureFeasibilityRejection };
}

function choose(
  choices: readonly Choice[],
  strategy: Strategy,
  state: AwaitingPickState,
  gameSeed: string,
  pickIndex: number,
): Choice {
  let preferred = [...choices];
  if (strategy === "KEEPER_DEFERRAL") {
    const nonKeepers = preferred.filter((choice) => choice.player.role.keeperMetadata.capabilityStatus !== "CONFIRMED");
    if (nonKeepers.length > 0) preferred = nonKeepers;
  } else if (strategy === "OVERSEAS_PRESSURE") {
    const overseas = preferred.filter((choice) => choice.player.rosterStatus === "OVERSEAS");
    if (overseas.length > 0) preferred = overseas;
  } else if (strategy === "POOR_BATTING_ORDER") {
    const rank: Record<string, number> = { OUT_OF_ROLE: 0, UNKNOWN: 1, ACCEPTABLE: 2, NATURAL: 3 };
    const worst = Math.min(...preferred.map((choice) => rank[choice.fit] ?? 4));
    preferred = preferred.filter((choice) => (rank[choice.fit] ?? 4) === worst);
  } else if (strategy === "DUPLICATE_PRESSURE") {
    const variants = preferred.filter((choice) => state.picks.some((pick) =>
      catalogPlayerHasOtherVariant(choice.player, pick.playerId)));
    if (variants.length > 0) preferred = variants;
  }
  const draw = random01(ERA_DRAFT_VALIDATION_VERSION, gameSeed, strategy, "choice", String(pickIndex));
  return preferred[Math.floor(draw * preferred.length)]!;
}

function catalogPlayerHasOtherVariant(player: EraDraftPlayerRecord, draftedPlayerId: string): boolean {
  return player.playerId === draftedPlayerId;
}

function scanHidden(
  catalog: EraDraftCatalog,
  state: EraDraftHiddenState,
  counters: ValidationCounters,
  project = true,
): void {
  if (project) scanForLeaks(projectEraDraftPublicState(catalog, state), counters, `projection:${state.phase}`);
  scanForLeaks(JSON.parse(serializeEraDraftState(state)), counters, `serialized:${state.phase}`);
}

const FORBIDDEN_HIDDEN_KEYS = new Set([
  "evaluation", "evaluationSnapshot", "season", "seasonSnapshot", "quality", "battingRating", "bowlingRating",
  "overallRating", "qualityTier", "internalScore", "secondaryBonus", "baseStrength", "adjustedStrength",
  "bandDistance", "nominalFitDeduction", "effectiveRatingBeforeTeamCap", "bowlingCapacity", "phaseBowlingUsage",
  "phaseBowlingCapacity", "battingContributions", "bowlingDeployment", "constructionEffects", "effects",
]);

function scanForLeaks(value: unknown, counters: ValidationCounters, location: string): void {
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) return item.forEach(visit);
    if (typeof item !== "object" || item === null) return;
    for (const [key, nested] of Object.entries(item)) {
      if (FORBIDDEN_HIDDEN_KEYS.has(key)) {
        counters.hiddenLeaks += 1;
        throw new Error(`Hidden-information leak ${key} at ${location}.`);
      }
      visit(nested);
    }
  };
  visit(value);
}

function assertState(catalog: EraDraftCatalog, state: EraDraftState, counters: ValidationCounters): void {
  try {
    assertEraDraftState(catalog, state);
  } catch (error) {
    counters.invariantFailures += 1;
    throw error;
  }
}

function validateCompletedXi(
  catalog: EraDraftCatalog,
  state: Extract<EraDraftState, { phase: "XI_COMPLETE" }>,
  counters: ValidationCounters,
): void {
  const positions = [...state.picks].map((pick) => pick.battingPosition).sort((left, right) => left - right);
  const valid = state.picks.length === 11
    && new Set(state.picks.map((pick) => pick.playerTeamSeasonId)).size === 11
    && new Set(state.picks.map((pick) => pick.playerId)).size === 11
    && positions.every((position, index) => position === index + 1)
    && state.picks.filter((pick) => catalog.getPlayer(pick.playerTeamSeasonId)?.rosterStatus === "OVERSEAS").length <= 4
    && state.picks.some((pick) => catalog.getPlayer(pick.playerTeamSeasonId)?.role.keeperMetadata.capabilityStatus === "CONFIRMED");
  if (!valid) {
    counters.illegalCompletedXis += 1;
    throw new Error("Illegal completed XI.");
  }
}

function replayCompleted(catalog: EraDraftCatalog, state: EraDraftState, counters: ValidationCounters): void {
  counters.replayRuns += 1;
  try {
    const replayed = replayEraDraftState(catalog, state);
    if (canonicalEraDraftStateHash(replayed) !== canonicalEraDraftStateHash(state)) {
      counters.replayFinalHashMismatches += 1;
      throw new Error("Replay final hash mismatch.");
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("event")) counters.replayEventMismatches += 1;
    else if (!(error instanceof Error && error.message.includes("final hash"))) counters.replayEventMismatches += 1;
    throw error;
  }
}

function recordRecovery(
  event: { readonly command: string; readonly [key: string]: unknown },
  counters: ValidationCounters,
  era: EraAccumulator,
  paths: Record<string, number>,
): void {
  if ((event.command !== "SPIN" && event.command !== "RESPIN") || !Array.isArray(event.skippedDeadTeamSeasonIds)
    || event.skippedDeadTeamSeasonIds.length === 0) return;
  counters.automaticRecoveries += 1;
  era.recoveries += 1;
  const selected = event.command === "SPIN" ? event.selectedTeamSeasonId : event.replacementTeamSeasonId;
  const key = `${String(event.triggeringTeamSeasonId)} -> [${event.skippedDeadTeamSeasonIds.join(",")}] -> ${String(selected)}`;
  increment(paths, key);
}

function runSyntheticRecoveryValidation(
  catalog: EraDraftCatalog,
  seed: string,
  counters: ValidationCounters,
  paths: Record<string, number>,
  restoreByTarget: Record<RestoreTarget, number>,
) {
  const eraId = "era-foundation" as const;
  const recoverySeed = `${seed}:synthetic-recovery`;
  const triggering = selectNormalSpinTeamSeason(catalog, recoverySeed, eraId, 0);
  const wrapped = withDeadTeamSeasons(catalog, new Set([triggering.teamSeasonId]));
  const spin = (): AwaitingPickState => {
    let state: EraDraftState = createEraDraftGame({ catalog: wrapped, rootSeed: recoverySeed });
    const chosen = reduceEraDraft(wrapped, state, { type: "CHOOSE_ERA", eraId });
    if (!chosen.ok) throw new Error("Synthetic CHOOSE_ERA rejected.");
    counters.acceptedCommands += 1;
    state = chosen.state;
    const result = reduceEraDraft(wrapped, state, { type: "SPIN" });
    if (!result.ok || result.state.phase !== "AWAITING_PICK") throw new Error("Synthetic recovery failed.");
    counters.acceptedCommands += 1;
    return result.state;
  };
  const first = spin();
  const second = spin();
  if (canonicalEraDraftStateHash(first) !== canonicalEraDraftStateHash(second)
    || first.currentSpin.teamSeasonId === triggering.teamSeasonId || !first.currentSpin.recovery) {
    counters.nondeterministicResults += 1;
    throw new Error("Synthetic recovery is not deterministic.");
  }
  counters.automaticRecoveries += 2;
  const recoveryKey = `${triggering.teamSeasonId} -> [${first.currentSpin.recovery.skippedDeadTeamSeasonIds.join(",")}] -> ${first.currentSpin.teamSeasonId}`;
  increment(paths, recoveryKey, 2);
  counters.serializationAttempts += 1;
  const restored = restoreEraDraftState(wrapped, serializeEraDraftState(first));
  if (canonicalEraDraftStateHash(restored) !== canonicalEraDraftStateHash(first)) {
    counters.restoreDivergences += 1;
    throw new Error("Synthetic recovered state failed restore.");
  }
  restoreByTarget.RECOVERY += 1;
  const recoveryAnalysis = analyzeChoices(wrapped, first, "RANDOM_LEGAL");
  const recoveryChoice = recoveryAnalysis.legal[0];
  if (!recoveryChoice) throw new Error("Synthetic recovered state exposed no legal continuation.");
  const recoveryCommand = {
    type: "LOCK_PLAYER" as const,
    playerTeamSeasonId: recoveryChoice.player.playerTeamSeasonId,
    battingPosition: recoveryChoice.battingPosition,
  };
  const continuedOriginal = reduceEraDraft(wrapped, first, recoveryCommand);
  const continuedRestored = reduceEraDraft(wrapped, restored, recoveryCommand);
  if (!continuedOriginal.ok || !continuedRestored.ok
    || canonicalEraDraftStateHash(continuedOriginal.state) !== canonicalEraDraftStateHash(continuedRestored.state)) {
    counters.restoreDivergences += 1;
    throw new Error("Synthetic recovery restore diverged after continuation.");
  }
  const heads = new Set(Array.from({ length: 20 }, (_, index) =>
    rankRecoveryTeamSeasons(catalog, `${seed}:recovery-order:${index}`, eraId, 0, "fixture")[0]!.teamSeasonId));
  if (heads.size < 2) throw new Error("Different seeds did not vary synthetic recovery ordering.");

  const impossible = withDeadTeamSeasons(catalog, new Set(catalog.getTeamSeasonsForEra(eraId).map((item) => item.teamSeasonId)));
  let impossibleCode = "";
  try {
    const setup = createEraDraftGame({ catalog: impossible, rootSeed: `${seed}:impossible` });
    reduceEraDraft(impossible, setup, { type: "CHOOSE_ERA", eraId });
  } catch (error) {
    if (error instanceof EraDraftInvariantError) impossibleCode = error.code;
  }
  if (impossibleCode !== "NO_VIABLE_TEAM_SEASON") throw new Error("Globally impossible synthetic catalog did not fail closed.");
  return {
    deterministicSameSeed: true,
    differentSeedOrderingHeads: heads.size,
    triggeringTeamSeasonId: triggering.teamSeasonId,
    selectedReplacementTeamSeasonId: first.currentSpin.teamSeasonId,
    skippedDeadTeamSeasonIds: first.currentSpin.recovery.skippedDeadTeamSeasonIds,
    globallyImpossibleErrorCode: impossibleCode,
  };
}

function runRngIsolationValidation(catalog: EraDraftCatalog, revealed: RevealedState, counters: ValidationCounters) {
  const baseline = deriveEraDraftSimulationSeeds(revealed);
  const counterVariant = {
    ...revealed,
    revision: revealed.revision + 999,
    rngCounters: { normalSpin: 999, voluntaryRespin: 1, deadSpinRecovery: 999 },
    respin: { status: "USED" as const },
    history: [],
  };
  if (canonicalJson(deriveEraDraftSimulationSeeds(counterVariant)) !== canonicalJson(baseline)) {
    throw new Error("Draft counters directly perturbed simulation seeds.");
  }
  counters.rngIsolationChecks += 2;

  let awaitingSpin: EraDraftState = createEraDraftGame({ catalog, rootSeed: `${revealed.rootSeed}:rejection-isolation` });
  const chose = reduceEraDraft(catalog, awaitingSpin, { type: "CHOOSE_ERA", eraId: "era-foundation" });
  if (!chose.ok) throw new Error("RNG isolation fixture could not choose Foundation.");
  awaitingSpin = chose.state;
  const invalidRespin = reduceEraDraft(catalog, awaitingSpin, { type: "RESPIN" });
  const directSpin = reduceEraDraft(catalog, awaitingSpin, { type: "SPIN" });
  const afterRejectedSpin = reduceEraDraft(catalog, invalidRespin.state, { type: "SPIN" });
  if (invalidRespin.ok || !directSpin.ok || !afterRejectedSpin.ok
    || canonicalJson(directSpin.event) !== canonicalJson(afterRejectedSpin.event)) {
    throw new Error("Rejected command changed the next normal spin.");
  }
  counters.rngIsolationChecks += 1;
  if (baseline.opponentCompositionSeed === baseline.matchSimulationSeed) throw new Error("Simulation RNG domains collided.");
  counters.rngIsolationChecks += 1;

  const rejected = reduceEraDraft(catalog, revealed, { type: "SPIN" });
  if (rejected.ok || rejected.state !== revealed) throw new Error("Rejected command changed revealed state.");
  const direct = reduceEraDraft(catalog, revealed, { type: "SIMULATE_SEASON" });
  const afterRejected = reduceEraDraft(catalog, rejected.state, { type: "SIMULATE_SEASON" });
  if (!direct.ok || !afterRejected.ok || canonicalJson(direct.state) !== canonicalJson(afterRejected.state)) {
    throw new Error("Rejected command changed simulation output.");
  }
  counters.rngIsolationChecks += 2;

  const priorSpins = Array.from({ length: 25 }, (_, ordinal) =>
    selectNormalSpinTeamSeason(catalog, revealed.rootSeed, revealed.eraId, ordinal).teamSeasonId);
  deriveEraDraftSimulationSeeds(revealed);
  reduceEraDraft(catalog, revealed, { type: "SIMULATE_SEASON" });
  const laterSpins = Array.from({ length: 25 }, (_, ordinal) =>
    selectNormalSpinTeamSeason(catalog, revealed.rootSeed, revealed.eraId, ordinal).teamSeasonId);
  if (canonicalJson(priorSpins) !== canonicalJson(laterSpins)) throw new Error("Simulation changed prior draft spin derivation.");
  counters.rngIsolationChecks += 1;
  return {
    checks: counters.rngIsolationChecks,
    rejectedCommandsPreserveFutureSpins: true,
    rejectedCommandsPreserveSimulation: true,
    respinCounterExcludedFromSimulationIdentity: true,
    recoveryCounterExcludedFromSimulationIdentity: true,
    simulationDoesNotPerturbDraftSpins: true,
    compositionAndMatchDomainsDistinct: true,
    saveRestorePreservesRng: counters.restoreDivergences === 0,
    replayReproducesRngOutcomes: counters.replayEventMismatches === 0,
  };
}

function validateFoundationComplete(
  catalog: EraDraftCatalog,
  state: Extract<EraDraftState, { phase: "GAME_COMPLETE" }>,
  accumulator: FoundationAccumulator,
): void {
  assertEraDraftState(catalog, state);
  const league = state.season.league;
  if (state.picks.length !== 11 || league.teams.length !== 8 || league.teams.filter((team) => team.teamId !== "user").length !== 7
    || league.schedule.length !== 56 || league.leagueMatches.length !== 56 || league.standings.length !== 8
    || league.standings.some((row) => row.played !== 14) || league.playoffs.length !== 4
    || !league.teams.some((team) => team.teamId === league.championTeamId)
    || canonicalJson(state.season.userTeam.strength) !== canonicalJson({
      batting: state.evaluation.adjustedStrength.batting,
      bowling: state.evaluation.adjustedStrength.bowling,
      overall: state.evaluation.adjustedStrength.overall,
    })) throw new Error("Invalid Foundation full-cycle structure.");
  const user = league.standings.find((row) => row.teamId === "user")!;
  accumulator.cycles += 1;
  accumulator.qualified += user.qualified ? 1 : 0;
  const final = league.playoffs.at(-1)!;
  accumulator.finalist += final.firstBattingTeamId === "user" || final.chasingTeamId === "user" ? 1 : 0;
  accumulator.champion += league.championTeamId === "user" ? 1 : 0;
  accumulator.positions[user.position - 1] += 1;
  addStrength(accumulator.nrr, user.netRunRate);
  addStrength(accumulator.strength, state.evaluation.adjustedStrength.overall);
  increment(accumulator.omitted, league.omittedOpponentTeamId);
}

function matchesRestoreTarget(state: EraDraftState, target: RestoreTarget): boolean {
  switch (target) {
    case "AWAITING_SPIN": return state.phase === "AWAITING_SPIN" && state.picks.length === 0;
    case "AWAITING_PICK": return state.phase === "AWAITING_PICK" && state.picks.length === 0 && state.currentSpin.origin === "NORMAL";
    case "PARTIAL_DRAFT": return state.phase === "AWAITING_SPIN" && state.picks.length > 0;
    case "RECOVERY": return state.phase === "AWAITING_PICK" && state.currentSpin.recovery !== null;
    case "RESPIN": return state.phase === "AWAITING_PICK" && state.currentSpin.origin === "RESPIN";
    case "XI_COMPLETE": return state.phase === "XI_COMPLETE";
    case "REVEALED": return state.phase === "REVEALED";
  }
}

function withDeadTeamSeasons(base: EraDraftCatalog, dead: ReadonlySet<string>): EraDraftCatalog {
  return {
    fingerprint: base.fingerprint,
    diagnostics: base.diagnostics,
    getEra: (id) => base.getEra(id),
    getEraIds: () => base.getEraIds(),
    getEraForSeason: (id) => base.getEraForSeason(id),
    getTeamSeason: (id) => base.getTeamSeason(id),
    getTeamSeasonsForEra: (id) => base.getTeamSeasonsForEra(id),
    getEligibilityRow: (id) => base.getEligibilityRow(id),
    getPlayer: (id) => base.getPlayer(id),
    getCandidatesForTeamSeason: (id) => dead.has(id) ? [] : base.getCandidatesForTeamSeason(id),
    getPlayerVariantsForEra: (eraId, playerId) => base.getPlayerVariantsForEra(eraId, playerId),
    getKeeperCapablePlayerIds: (id) => base.getKeeperCapablePlayerIds(id),
    getSimulationContent: (id) => base.getSimulationContent(id),
    getEnvironment: (id) => base.getEnvironment(id),
    getFoundationOpponents: () => base.getFoundationOpponents(),
  };
}

function measurePrimitiveTimings(catalog: EraDraftCatalog, seed: string) {
  let state: EraDraftState = createEraDraftGame({ catalog, rootSeed: `${seed}:timing` });
  const chosen = reduceEraDraft(catalog, state, { type: "CHOOSE_ERA", eraId: "era-foundation" });
  if (!chosen.ok) throw new Error("Timing fixture era selection failed.");
  state = chosen.state;
  const spun = reduceEraDraft(catalog, state, { type: "SPIN" });
  if (!spun.ok || spun.state.phase !== "AWAITING_PICK") throw new Error("Timing fixture spin failed.");
  const projectionStarted = performance.now();
  projectEraDraftPublicState(catalog, spun.state);
  const candidateProjection = performance.now() - projectionStarted;
  const feasibilityStarted = performance.now();
  evaluateFutureCompletion(catalog, spun.state.eraId, spun.state.picks);
  const feasibility = performance.now() - feasibilityStarted;
  return { candidateProjection: round(candidateProjection), feasibility: round(feasibility) };
}

function newEraAccumulator(): EraAccumulator {
  return {
    drafts: 0,
    completed: 0,
    deadEnds: 0,
    recoveries: 0,
    respins: 0,
    expectedRejections: {},
    availability: Array.from({ length: 11 }, () => ({ observations: 0, total: 0, minimum: Number.POSITIVE_INFINITY })),
    keeperPick: Array(11).fill(0),
    finalOverseas: Array(5).fill(0),
    strength: newStrengthAccumulator(),
    fit: { NATURAL: 0, ACCEPTABLE: 0, OUT_OF_ROLE: 0, UNKNOWN: 0 },
  };
}

function newFoundationAccumulator(catalog: EraDraftCatalog): FoundationAccumulator {
  return {
    cycles: 0,
    qualified: 0,
    finalist: 0,
    champion: 0,
    positions: Array(8).fill(0),
    nrr: newStrengthAccumulator(),
    strength: newStrengthAccumulator(),
    omitted: Object.fromEntries(catalog.getFoundationOpponents().map((opponent) => [opponent.candidateId, 0])),
  };
}

function summarizeEra(era: EraAccumulator) {
  return {
    drafts: era.drafts,
    completed: era.completed,
    completionRate: round(era.completed / Math.max(1, era.drafts)),
    deadEnds: era.deadEnds,
    candidateAvailabilityByPick: era.availability.map((item, index) => ({
      pickNumber: index + 1,
      observations: item.observations,
      average: round(item.total / Math.max(1, item.observations)),
      minimum: Number.isFinite(item.minimum) ? item.minimum : 0,
    })),
    recoveryCount: era.recoveries,
    recoveryFrequency: round(era.recoveries / Math.max(1, era.drafts * 11)),
    respinCount: era.respins,
    duplicateRejectionCount: era.expectedRejections.DUPLICATE_CANONICAL_PLAYER ?? 0,
    overseasLimitRejectionCount: era.expectedRejections.OVERSEAS_LIMIT ?? 0,
    keeperFeasibilityRejectionCount: era.expectedRejections.FUTURE_XI_IMPOSSIBLE ?? 0,
    keeperSelectedByPickNumber: era.keeperPick.map((count, index) => ({ pickNumber: index + 1, count })),
    finalOverseasCount: era.finalOverseas.map((count, overseas) => ({ overseas, count })),
    adjustedStrength: summarizeStrength(era.strength),
    categoricalBattingFit: sortedRecord(era.fit),
  };
}

function summarizeFoundation(value: FoundationAccumulator) {
  return {
    cycles: value.cycles,
    adjustedStrength: summarizeStrength(value.strength),
    qualificationCount: value.qualified,
    qualificationRate: round(value.qualified / Math.max(1, value.cycles)),
    finalistCount: value.finalist,
    finalistRate: round(value.finalist / Math.max(1, value.cycles)),
    championshipCount: value.champion,
    championshipRate: round(value.champion / Math.max(1, value.cycles)),
    finishingPosition: value.positions.map((count, index) => ({ position: index + 1, count })),
    netRunRate: summarizeStrength(value.nrr),
    omittedOpponentFrequency: sortedRecord(value.omitted),
  };
}

function newStrengthAccumulator(): StrengthAccumulator {
  return { count: 0, total: 0, minimum: Number.POSITIVE_INFINITY, maximum: Number.NEGATIVE_INFINITY };
}

function addStrength(target: StrengthAccumulator, value: number): void {
  target.count += 1;
  target.total += value;
  target.minimum = Math.min(target.minimum, value);
  target.maximum = Math.max(target.maximum, value);
}

function summarizeStrength(value: StrengthAccumulator) {
  return {
    observations: value.count,
    average: round(value.total / Math.max(1, value.count)),
    minimum: value.count ? round(value.minimum) : 0,
    maximum: value.count ? round(value.maximum) : 0,
  };
}

function recordAvailability(target: AvailabilityAccumulator, choices: readonly Choice[]): void {
  const candidates = new Set(choices.map((choice) => choice.player.playerTeamSeasonId)).size;
  target.observations += 1;
  target.total += candidates;
  target.minimum = Math.min(target.minimum, candidates);
}

function totalCompleted(eras: Record<EraId, EraAccumulator>): number {
  return ERA_IDS.reduce((total, eraId) => total + eras[eraId].completed, 0);
}

function acceptancePassed(counters: ValidationCounters, eras: Record<EraId, EraAccumulator>, options: EraDraftValidationOptions): boolean {
  const total = options.drafts + options.foundationCycles;
  return counters.invariantFailures === 0 && counters.illegalCompletedXis === 0 && counters.hiddenLeaks === 0
    && counters.replayEventMismatches === 0 && counters.replayFinalHashMismatches === 0
    && counters.serializationFailures === 0 && counters.restoreDivergences === 0
    && counters.nondeterministicResults === 0 && counters.unexpectedDeadEnds === 0
    && totalCompleted(eras) === total
    && ERA_IDS.slice(1).every((eraId) => counters.laterEraExpectedSimulationRejections[eraId] === eras[eraId].completed);
}

function increment(record: Record<string, number>, key: string, amount = 1): void {
  record[key] = (record[key] ?? 0) + amount;
}

function sortedRecord(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer.`);
}

class EraDraftValidationError extends Error {
  readonly name = "EraDraftValidationError";
  constructor(
    readonly code: string,
    message: string,
    readonly reproduction: Readonly<Record<string, unknown>>,
    options?: unknown,
  ) {
    super(message, options instanceof Error ? { cause: options } : undefined);
  }
}

function parseArgs(args: readonly string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!argument.startsWith("--")) throw new Error(`Unexpected argument ${argument}.`);
    values.set(argument.slice(2), args[index + 1] ?? "true");
    index += 1;
  }
  return {
    drafts: Number.parseInt(values.get("drafts") ?? "5000", 10),
    foundationCycles: Number.parseInt(values.get("foundation-cycles") ?? "250", 10),
    validationSeed: values.get("seed") ?? "stage8-phase5",
    deterministicOnly: values.get("deterministic-only") === "true",
    output: values.get("output"),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const catalogStarted = performance.now();
  const catalog = loadEraDraftCatalog();
  const catalogLoadMilliseconds = performance.now() - catalogStarted;
  try {
    const result = runEraDraftValidation({ ...args, catalog, catalogLoadMilliseconds });
    const output = `${args.deterministicOnly
      ? canonicalJson(result.deterministic)
      : JSON.stringify(result, null, 2)}\n`;
    if (args.output) writeFileSync(args.output, output, "utf8");
    else process.stdout.write(output);
  } catch (error) {
    const failure = error instanceof EraDraftValidationError
      ? { name: error.name, code: error.code, message: error.message, reproduction: error.reproduction }
      : { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) };
    process.stderr.write(`${JSON.stringify(failure, null, 2)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
