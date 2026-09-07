import { canonicalJson, canonicalSha256 } from "./eraDraftCanonical.js";
import type { EraDraftCatalog } from "./eraDraftData.js";
import { assertEraDraftState } from "./eraDraftInvariants.js";
import { evaluateEraDraftXi } from "./eraDraftReveal.js";
import { assertEraDraftSeasonResult } from "./eraDraftSimulation.js";
import {
  ERA_DRAFT_ENGINE_VERSION,
  ERA_DRAFT_SAVE_VERSION,
  ERA_DRAFT_SIMULATION_SEED_VERSION,
  ERA_DRAFT_STATE_SCHEMA_VERSION,
  EraDraftDataError,
  type CurrentSpin,
  type EraDraftHistoryEntry,
  type EraDraftPick,
  type EraDraftSeasonResult,
  type EraDraftState,
  type GameCompleteState,
  type RevealedState,
  type TeamSeasonId,
  type XiCompleteState,
} from "./eraDraftTypes.js";
import {
  SIMULATION_V2_VERSION,
  type InningsV2,
  type LeagueResultV2,
  type MatchResultV2,
  type PlayoffMatchV2,
  type ScheduledMatchV2,
  type SimulationTeamV2,
  type StandingsRowV2,
} from "./simulationV2.js";
import { TEAM_EVALUATION_V2_VERSION, type EraId, type TeamEvaluationV2 } from "./teamEvaluationV2.js";

type EvaluationSnapshot = {
  readonly version: typeof TEAM_EVALUATION_V2_VERSION;
  readonly eraId: EraId;
  readonly evaluationHash: string;
};

type SeasonSnapshot = {
  readonly simulationVersion: typeof SIMULATION_V2_VERSION;
  readonly seedVersion: typeof ERA_DRAFT_SIMULATION_SEED_VERSION;
  readonly resultHash: string;
  readonly result: EraDraftSeasonResult;
};

export function serializeEraDraftState(state: EraDraftState): string {
  return canonicalJson(serializableState(state));
}

export function canonicalEraDraftStateHash(state: EraDraftState): string {
  return canonicalSha256(serializableState(state));
}

export function restoreEraDraftState(catalog: EraDraftCatalog, serialized: string): EraDraftState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new EraDraftDataError("INVALID_SERIALIZED_JSON", "Era Draft save is not valid JSON.", {}, { cause: error });
  }
  const row = object(parsed, "save");
  const phase = oneOf(row.phase, [
    "SETUP", "AWAITING_SPIN", "AWAITING_PICK", "XI_COMPLETE", "REVEALED", "GAME_COMPLETE",
  ] as const, "save.phase");
  const phaseKeys: Record<typeof phase, readonly string[]> = {
    SETUP: [],
    AWAITING_SPIN: ["eraId"],
    AWAITING_PICK: ["eraId", "currentSpin"],
    XI_COMPLETE: ["eraId"],
    REVEALED: ["eraId", "evaluationSnapshot"],
    GAME_COMPLETE: ["eraId", "evaluationSnapshot", "seasonSnapshot"],
  };
  exactKeys(row, [
    "saveVersion", "engineVersion", "stateSchemaVersion", "catalogFingerprint", "rootSeed", "phase",
    "revision", "rngCounters", "respin", "history", "picks", ...phaseKeys[phase],
  ], "save");
  requireVersion(row.saveVersion, ERA_DRAFT_SAVE_VERSION, "UNSUPPORTED_SAVE_VERSION", "save version");
  requireVersion(row.engineVersion, ERA_DRAFT_ENGINE_VERSION, "UNSUPPORTED_ENGINE_VERSION", "engine version");
  requireVersion(row.stateSchemaVersion, ERA_DRAFT_STATE_SCHEMA_VERSION, "UNSUPPORTED_STATE_SCHEMA_VERSION", "state schema version");
  if (row.catalogFingerprint !== catalog.fingerprint) {
    throw new EraDraftDataError("CATALOG_FINGERPRINT_MISMATCH", "Era Draft save belongs to a different catalog.", {
      expected: catalog.fingerprint,
      actual: row.catalogFingerprint,
    });
  }

  const common = {
    engineVersion: ERA_DRAFT_ENGINE_VERSION,
    schemaVersion: ERA_DRAFT_STATE_SCHEMA_VERSION,
    catalogFingerprint: text(row.catalogFingerprint, "save.catalogFingerprint"),
    rootSeed: text(row.rootSeed, "save.rootSeed"),
    revision: integer(row.revision, "save.revision", 0),
    rngCounters: parseRngCounters(row.rngCounters),
    respin: parseRespin(row.respin),
    history: array(row.history, "save.history").map(parseHistoryEntry),
    picks: array(row.picks, "save.picks").map(parsePick),
  };

  let state: EraDraftState;
  if (phase === "SETUP") {
    state = { ...common, phase };
  } else {
    const eraId = parseEraId(catalog, row.eraId);
    if (phase === "AWAITING_SPIN") state = { ...common, phase, eraId };
    else if (phase === "AWAITING_PICK") state = { ...common, phase, eraId, currentSpin: parseCurrentSpin(row.currentSpin) };
    else if (phase === "XI_COMPLETE") state = { ...common, phase, eraId };
    else {
      const xi = { ...common, phase: "XI_COMPLETE", eraId } satisfies XiCompleteState;
      const evaluation = evaluateEraDraftXi(catalog, xi);
      assertEvaluationSnapshot(parseEvaluationSnapshot(row.evaluationSnapshot), evaluation);
      if (phase === "REVEALED") {
        state = { ...common, phase, eraId, evaluation };
      } else {
        if (eraId !== "era-foundation") invalid("GAME_COMPLETE can only use era-foundation.");
        const season = parseSeasonSnapshot(row.seasonSnapshot);
        const revealedIdentity = { ...common, phase: "REVEALED" as const, eraId, evaluation };
        assertEraDraftSeasonResult(catalog, revealedIdentity, season);
        state = { ...common, phase, eraId, evaluation, season };
      }
    }
  }
  const frozen = freezeDeep(state);
  assertEraDraftState(catalog, frozen);
  return frozen;
}

function serializableState(state: EraDraftState): object {
  const common = {
    saveVersion: ERA_DRAFT_SAVE_VERSION,
    engineVersion: state.engineVersion,
    stateSchemaVersion: state.schemaVersion,
    catalogFingerprint: state.catalogFingerprint,
    rootSeed: state.rootSeed,
    phase: state.phase,
    revision: state.revision,
    rngCounters: state.rngCounters,
    respin: state.respin,
    history: state.history,
    picks: state.picks,
  };
  if (state.phase === "SETUP") return common;
  if (state.phase === "AWAITING_SPIN" || state.phase === "XI_COMPLETE") {
    return { ...common, eraId: state.eraId };
  }
  if (state.phase === "AWAITING_PICK") {
    return { ...common, eraId: state.eraId, currentSpin: state.currentSpin };
  }
  const evaluationSnapshot = snapshotEvaluation(state.evaluation);
  if (state.phase === "REVEALED") return { ...common, eraId: state.eraId, evaluationSnapshot };
  return {
    ...common,
    eraId: state.eraId,
    evaluationSnapshot,
    seasonSnapshot: {
      simulationVersion: state.season.league.version,
      seedVersion: state.season.seedBundle.version,
      resultHash: canonicalSha256(state.season),
      result: state.season,
    } satisfies SeasonSnapshot,
  };
}

function snapshotEvaluation(evaluation: TeamEvaluationV2): EvaluationSnapshot {
  return {
    version: evaluation.version,
    eraId: evaluation.eraId,
    evaluationHash: canonicalSha256(evaluation),
  };
}

function assertEvaluationSnapshot(snapshot: EvaluationSnapshot, evaluation: TeamEvaluationV2): void {
  if (snapshot.version !== TEAM_EVALUATION_V2_VERSION) {
    throw new EraDraftDataError("TEAM_EVALUATION_VERSION_MISMATCH", "Save uses an unsupported Team Evaluation version.");
  }
  if (snapshot.eraId !== evaluation.eraId || snapshot.evaluationHash !== canonicalSha256(evaluation)) {
    throw new EraDraftDataError("TAMPERED_EVALUATION_SNAPSHOT", "Stored reveal snapshot differs from the catalog-derived evaluation.");
  }
}

function parseEvaluationSnapshot(value: unknown): EvaluationSnapshot {
  const row = object(value, "evaluationSnapshot");
  exactKeys(row, ["version", "eraId", "evaluationHash"], "evaluationSnapshot");
  if (row.version !== TEAM_EVALUATION_V2_VERSION) {
    throw new EraDraftDataError("TEAM_EVALUATION_VERSION_MISMATCH", "Save uses an unsupported Team Evaluation version.");
  }
  return {
    version: TEAM_EVALUATION_V2_VERSION,
    eraId: oneOf(row.eraId, [
      "era-foundation", "era-expansion", "era-transition", "era-modern-pre-impact", "era-impact",
    ] as const, "evaluationSnapshot.eraId"),
    evaluationHash: hash(row.evaluationHash, "evaluationSnapshot.evaluationHash"),
  };
}

function parseSeasonSnapshot(value: unknown): EraDraftSeasonResult {
  const row = object(value, "seasonSnapshot");
  exactKeys(row, ["simulationVersion", "seedVersion", "resultHash", "result"], "seasonSnapshot");
  requireVersion(row.simulationVersion, SIMULATION_V2_VERSION, "SIMULATION_VERSION_MISMATCH", "Simulation V2 version");
  requireVersion(row.seedVersion, ERA_DRAFT_SIMULATION_SEED_VERSION, "SIMULATION_SEED_VERSION_MISMATCH", "simulation seed version");
  const result = parseSeasonResult(row.result);
  if (hash(row.resultHash, "seasonSnapshot.resultHash") !== canonicalSha256(result)) {
    throw new EraDraftDataError("TAMPERED_SIMULATION_RESULT", "Stored terminal simulation result failed its canonical hash.");
  }
  return result;
}

function parseSeasonResult(value: unknown): EraDraftSeasonResult {
  const row = object(value, "season result");
  exactKeys(row, ["stage7Versions", "seedBundle", "userTeam", "league", "userOutcome"], "season result");
  const versions = object(row.stage7Versions, "stage7Versions");
  exactKeys(versions, ["simulationVersion", "environmentSchemaVersion"], "stage7Versions");
  requireVersion(versions.simulationVersion, SIMULATION_V2_VERSION, "SIMULATION_VERSION_MISMATCH", "Simulation V2 version");
  const seed = object(row.seedBundle, "seedBundle");
  exactKeys(seed, ["version", "gameIdentityHash", "opponentCompositionSeed", "matchSimulationSeed"], "seedBundle");
  requireVersion(seed.version, ERA_DRAFT_SIMULATION_SEED_VERSION, "SIMULATION_SEED_VERSION_MISMATCH", "simulation seed version");
  const outcome = object(row.userOutcome, "userOutcome");
  exactKeys(outcome, ["leaguePosition", "qualified", "champion"], "userOutcome");
  return {
    stage7Versions: {
      simulationVersion: SIMULATION_V2_VERSION,
      environmentSchemaVersion: text(versions.environmentSchemaVersion, "stage7Versions.environmentSchemaVersion"),
    },
    seedBundle: {
      version: ERA_DRAFT_SIMULATION_SEED_VERSION,
      gameIdentityHash: hash(seed.gameIdentityHash, "seedBundle.gameIdentityHash"),
      opponentCompositionSeed: hash(seed.opponentCompositionSeed, "seedBundle.opponentCompositionSeed"),
      matchSimulationSeed: hash(seed.matchSimulationSeed, "seedBundle.matchSimulationSeed"),
    },
    userTeam: parseSimulationTeam(row.userTeam, "userTeam"),
    league: parseLeague(row.league),
    userOutcome: {
      leaguePosition: integer(outcome.leaguePosition, "userOutcome.leaguePosition", 1),
      qualified: boolean(outcome.qualified, "userOutcome.qualified"),
      champion: boolean(outcome.champion, "userOutcome.champion"),
    },
  };
}

function parseLeague(value: unknown): LeagueResultV2 {
  const row = object(value, "league");
  exactKeys(row, [
    "version", "compositionSeed", "simulationSeed", "omittedOpponentTeamId", "teams", "schedule",
    "leagueMatches", "standings", "playoffs", "championTeamId",
  ], "league");
  requireVersion(row.version, SIMULATION_V2_VERSION, "SIMULATION_VERSION_MISMATCH", "league version");
  return {
    version: SIMULATION_V2_VERSION,
    compositionSeed: text(row.compositionSeed, "league.compositionSeed"),
    simulationSeed: text(row.simulationSeed, "league.simulationSeed"),
    omittedOpponentTeamId: text(row.omittedOpponentTeamId, "league.omittedOpponentTeamId"),
    teams: array(row.teams, "league.teams").map((item, index) => parseSimulationTeam(item, `league.teams[${index}]`)),
    schedule: array(row.schedule, "league.schedule").map(parseSchedule),
    leagueMatches: array(row.leagueMatches, "league.leagueMatches").map((item) => parseMatch(item, false)),
    standings: array(row.standings, "league.standings").map(parseStanding),
    playoffs: array(row.playoffs, "league.playoffs").map((item) => parseMatch(item, true) as PlayoffMatchV2),
    championTeamId: text(row.championTeamId, "league.championTeamId"),
  };
}

function parseSimulationTeam(value: unknown, label: string): SimulationTeamV2 {
  const row = object(value, label);
  exactKeys(row, ["teamId", "displayName", "strength"], label);
  const strength = object(row.strength, `${label}.strength`);
  exactKeys(strength, ["batting", "bowling", "overall"], `${label}.strength`);
  return {
    teamId: text(row.teamId, `${label}.teamId`),
    displayName: text(row.displayName, `${label}.displayName`),
    strength: {
      batting: finite(strength.batting, `${label}.strength.batting`),
      bowling: finite(strength.bowling, `${label}.strength.bowling`),
      overall: finite(strength.overall, `${label}.strength.overall`),
    },
  };
}

function parseSchedule(value: unknown, index: number): ScheduledMatchV2 {
  const label = `league.schedule[${index}]`;
  const row = object(value, label);
  exactKeys(row, ["matchId", "round", "leg", "homeTeamId", "awayTeamId"], label);
  return {
    matchId: text(row.matchId, `${label}.matchId`),
    round: integer(row.round, `${label}.round`, 1),
    leg: oneOf(row.leg, [1, 2] as const, `${label}.leg`),
    homeTeamId: text(row.homeTeamId, `${label}.homeTeamId`),
    awayTeamId: text(row.awayTeamId, `${label}.awayTeamId`),
  };
}

function parseMatch(value: unknown, playoff: boolean): MatchResultV2 | PlayoffMatchV2 {
  const label = playoff ? "playoff" : "league match";
  const row = object(value, label);
  exactKeys(row, [
    "version", "matchId", "firstBattingTeamId", "chasingTeamId", "innings", "winnerTeamId", "loserTeamId",
    "resultType", "margin", ...(playoff ? ["stage"] : []),
  ], label);
  requireVersion(row.version, SIMULATION_V2_VERSION, "SIMULATION_VERSION_MISMATCH", `${label} version`);
  const innings = array(row.innings, `${label}.innings`);
  if (innings.length !== 2) invalid(`${label}.innings must contain exactly two innings.`);
  const base: MatchResultV2 = {
    version: SIMULATION_V2_VERSION,
    matchId: text(row.matchId, `${label}.matchId`),
    firstBattingTeamId: text(row.firstBattingTeamId, `${label}.firstBattingTeamId`),
    chasingTeamId: text(row.chasingTeamId, `${label}.chasingTeamId`),
    innings: [parseInnings(innings[0], `${label}.innings[0]`), parseInnings(innings[1], `${label}.innings[1]`)],
    winnerTeamId: text(row.winnerTeamId, `${label}.winnerTeamId`),
    loserTeamId: text(row.loserTeamId, `${label}.loserTeamId`),
    resultType: oneOf(row.resultType, ["runs", "wickets", "super_over"] as const, `${label}.resultType`),
    margin: row.margin === null ? null : finite(row.margin, `${label}.margin`),
  };
  return playoff
    ? { ...base, stage: oneOf(row.stage, ["qualifier_1", "eliminator", "qualifier_2", "final"] as const, `${label}.stage`) }
    : base;
}

function parseInnings(value: unknown, label: string): InningsV2 {
  const row = object(value, label);
  exactKeys(row, ["teamId", "runs", "wickets", "balls", "allOut"], label);
  return {
    teamId: text(row.teamId, `${label}.teamId`),
    runs: integer(row.runs, `${label}.runs`, 0),
    wickets: integer(row.wickets, `${label}.wickets`, 0),
    balls: integer(row.balls, `${label}.balls`, 1),
    allOut: boolean(row.allOut, `${label}.allOut`),
  };
}

function parseStanding(value: unknown, index: number): StandingsRowV2 {
  const label = `league.standings[${index}]`;
  const row = object(value, label);
  exactKeys(row, [
    "position", "teamId", "displayName", "played", "won", "lost", "points", "runsFor", "ballsFacedForNrr",
    "runsAgainst", "ballsBowledForNrr", "netRunRate", "qualified",
  ], label);
  return {
    position: integer(row.position, `${label}.position`, 1),
    teamId: text(row.teamId, `${label}.teamId`),
    displayName: text(row.displayName, `${label}.displayName`),
    played: integer(row.played, `${label}.played`, 0),
    won: integer(row.won, `${label}.won`, 0),
    lost: integer(row.lost, `${label}.lost`, 0),
    points: integer(row.points, `${label}.points`, 0),
    runsFor: integer(row.runsFor, `${label}.runsFor`, 0),
    ballsFacedForNrr: integer(row.ballsFacedForNrr, `${label}.ballsFacedForNrr`, 0),
    runsAgainst: integer(row.runsAgainst, `${label}.runsAgainst`, 0),
    ballsBowledForNrr: integer(row.ballsBowledForNrr, `${label}.ballsBowledForNrr`, 0),
    netRunRate: finite(row.netRunRate, `${label}.netRunRate`),
    qualified: boolean(row.qualified, `${label}.qualified`),
  };
}

function parseRngCounters(value: unknown): EraDraftState["rngCounters"] {
  const row = object(value, "rngCounters");
  exactKeys(row, ["normalSpin", "voluntaryRespin", "deadSpinRecovery"], "rngCounters");
  return {
    normalSpin: integer(row.normalSpin, "rngCounters.normalSpin", 0),
    voluntaryRespin: integer(row.voluntaryRespin, "rngCounters.voluntaryRespin", 0),
    deadSpinRecovery: integer(row.deadSpinRecovery, "rngCounters.deadSpinRecovery", 0),
  };
}

function parseRespin(value: unknown): EraDraftState["respin"] {
  const row = object(value, "respin");
  exactKeys(row, ["status"], "respin");
  return { status: oneOf(row.status, ["AVAILABLE", "USED"] as const, "respin.status") };
}

function parsePick(value: unknown, index: number): EraDraftPick {
  const label = `picks[${index}]`;
  const row = object(value, label);
  exactKeys(row, [
    "pickNumber", "playerTeamSeasonId", "playerId", "seasonId", "teamId", "franchiseId", "teamSeasonId",
    "battingPosition",
  ], label);
  return {
    pickNumber: integer(row.pickNumber, `${label}.pickNumber`, 1),
    playerTeamSeasonId: text(row.playerTeamSeasonId, `${label}.playerTeamSeasonId`),
    playerId: text(row.playerId, `${label}.playerId`),
    seasonId: text(row.seasonId, `${label}.seasonId`),
    teamId: text(row.teamId, `${label}.teamId`),
    franchiseId: text(row.franchiseId, `${label}.franchiseId`),
    teamSeasonId: text(row.teamSeasonId, `${label}.teamSeasonId`) as TeamSeasonId,
    battingPosition: integer(row.battingPosition, `${label}.battingPosition`, 1, 11) as EraDraftPick["battingPosition"],
  };
}

function parseCurrentSpin(value: unknown): CurrentSpin {
  const row = object(value, "currentSpin");
  exactKeys(row, ["spinOrdinal", "origin", "teamSeasonId", "seasonId", "teamId", "franchiseId", "recovery"], "currentSpin");
  let recovery: CurrentSpin["recovery"] = null;
  if (row.recovery !== null) {
    const item = object(row.recovery, "currentSpin.recovery");
    exactKeys(item, ["triggeringTeamSeasonId", "skippedDeadTeamSeasonIds"], "currentSpin.recovery");
    recovery = {
      triggeringTeamSeasonId: text(item.triggeringTeamSeasonId, "currentSpin.recovery.triggeringTeamSeasonId") as TeamSeasonId,
      skippedDeadTeamSeasonIds: array(item.skippedDeadTeamSeasonIds, "currentSpin.recovery.skippedDeadTeamSeasonIds")
        .map((id, index) => text(id, `currentSpin.recovery.skippedDeadTeamSeasonIds[${index}]`) as TeamSeasonId),
    };
  }
  return {
    spinOrdinal: integer(row.spinOrdinal, "currentSpin.spinOrdinal", 0),
    origin: oneOf(row.origin, ["NORMAL", "RESPIN"] as const, "currentSpin.origin"),
    teamSeasonId: text(row.teamSeasonId, "currentSpin.teamSeasonId") as TeamSeasonId,
    seasonId: text(row.seasonId, "currentSpin.seasonId"),
    teamId: text(row.teamId, "currentSpin.teamId"),
    franchiseId: text(row.franchiseId, "currentSpin.franchiseId"),
    recovery,
  };
}

function parseHistoryEntry(value: unknown, index: number): EraDraftHistoryEntry {
  const label = `history[${index}]`;
  const row = object(value, label);
  const command = oneOf(row.command, [
    "CHOOSE_ERA", "SPIN", "LOCK_PLAYER", "RESPIN", "REVEAL_XI", "SIMULATE_SEASON",
  ] as const, `${label}.command`);
  const revision = integer(row.revision, `${label}.revision`, 1);
  if (command === "CHOOSE_ERA") {
    exactKeys(row, ["revision", "command", "payload", "resultingPhase"], label);
    const payload = object(row.payload, `${label}.payload`);
    exactKeys(payload, ["eraId"], `${label}.payload`);
    return {
      revision, command, payload: { eraId: oneOf(payload.eraId, [
        "era-foundation", "era-expansion", "era-transition", "era-modern-pre-impact", "era-impact",
      ] as const, `${label}.payload.eraId`) },
      resultingPhase: oneOf(row.resultingPhase, ["AWAITING_SPIN"] as const, `${label}.resultingPhase`),
    };
  }
  if (command === "SPIN") {
    exactKeys(row, [
      "revision", "command", "payload", "resultingPhase", "spinOrdinal", "triggeringTeamSeasonId",
      "skippedDeadTeamSeasonIds", "selectedTeamSeasonId",
    ], label);
    emptyPayload(row.payload, label);
    const resultingPhase = oneOf(row.resultingPhase, ["AWAITING_PICK"] as const, `${label}.resultingPhase`);
    return {
      revision, command, payload: {}, resultingPhase,
      spinOrdinal: integer(row.spinOrdinal, `${label}.spinOrdinal`, 0),
      triggeringTeamSeasonId: text(row.triggeringTeamSeasonId, `${label}.triggeringTeamSeasonId`) as TeamSeasonId,
      skippedDeadTeamSeasonIds: stringArray(row.skippedDeadTeamSeasonIds, `${label}.skippedDeadTeamSeasonIds`) as TeamSeasonId[],
      selectedTeamSeasonId: text(row.selectedTeamSeasonId, `${label}.selectedTeamSeasonId`) as TeamSeasonId,
    };
  }
  if (command === "LOCK_PLAYER") {
    exactKeys(row, ["revision", "command", "payload", "resultingPhase"], label);
    const payload = object(row.payload, `${label}.payload`);
    exactKeys(payload, ["playerTeamSeasonId", "playerId", "battingPosition"], `${label}.payload`);
    return {
      revision, command,
      payload: {
        playerTeamSeasonId: text(payload.playerTeamSeasonId, `${label}.payload.playerTeamSeasonId`),
        playerId: text(payload.playerId, `${label}.payload.playerId`),
        battingPosition: integer(payload.battingPosition, `${label}.payload.battingPosition`, 1, 11) as EraDraftPick["battingPosition"],
      },
      resultingPhase: oneOf(row.resultingPhase, ["AWAITING_SPIN", "XI_COMPLETE"] as const, `${label}.resultingPhase`),
    };
  }
  if (command === "RESPIN") {
    exactKeys(row, [
      "revision", "command", "payload", "resultingPhase", "respinOrdinal", "discardedTeamSeasonId",
      "triggeringTeamSeasonId", "skippedDeadTeamSeasonIds", "replacementTeamSeasonId", "resultingRespinStatus",
    ], label);
    emptyPayload(row.payload, label);
    const resultingPhase = oneOf(row.resultingPhase, ["AWAITING_PICK"] as const, `${label}.resultingPhase`);
    return {
      revision, command, payload: {}, resultingPhase,
      respinOrdinal: integer(row.respinOrdinal, `${label}.respinOrdinal`, 0),
      discardedTeamSeasonId: text(row.discardedTeamSeasonId, `${label}.discardedTeamSeasonId`) as TeamSeasonId,
      triggeringTeamSeasonId: text(row.triggeringTeamSeasonId, `${label}.triggeringTeamSeasonId`) as TeamSeasonId,
      skippedDeadTeamSeasonIds: stringArray(row.skippedDeadTeamSeasonIds, `${label}.skippedDeadTeamSeasonIds`) as TeamSeasonId[],
      replacementTeamSeasonId: text(row.replacementTeamSeasonId, `${label}.replacementTeamSeasonId`) as TeamSeasonId,
      resultingRespinStatus: oneOf(row.resultingRespinStatus, ["USED"] as const, `${label}.resultingRespinStatus`),
    };
  }
  exactKeys(row, ["revision", "command", "payload", "resultingPhase"], label);
  emptyPayload(row.payload, label);
  return command === "REVEAL_XI"
    ? { revision, command, payload: {}, resultingPhase: oneOf(row.resultingPhase, ["REVEALED"] as const, `${label}.resultingPhase`) }
    : { revision, command, payload: {}, resultingPhase: oneOf(row.resultingPhase, ["GAME_COMPLETE"] as const, `${label}.resultingPhase`) };
}

function emptyPayload(value: unknown, label: string): void {
  exactKeys(object(value, `${label}.payload`), [], `${label}.payload`);
}

function parseEraId(catalog: EraDraftCatalog, value: unknown): EraId {
  const eraId = oneOf(value, [
    "era-foundation", "era-expansion", "era-transition", "era-modern-pre-impact", "era-impact",
  ] as const, "save.eraId");
  if (!catalog.getEra(eraId)) invalid(`Unknown era ${eraId}.`);
  return eraId;
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
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
    throw new EraDraftDataError("INVALID_SERIALIZED_SHAPE", `${label} has missing or unexpected fields.`, {
      actual,
      expected: sortedExpected,
    });
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) invalid(`${label} must be a non-empty string.`);
  return value;
}

function hash(value: unknown, label: string): string {
  const result = text(value, label);
  if (!/^[0-9a-f]{64}$/.test(result)) invalid(`${label} must be a SHA-256 hash.`);
  return result;
}

function integer(value: unknown, label: string, minimum: number, maximum?: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (maximum !== undefined && (value as number) > maximum)) {
    invalid(`${label} must be an integer in range.`);
  }
  return value as number;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid(`${label} must be finite.`);
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") invalid(`${label} must be boolean.`);
  return value;
}

function oneOf<const T extends readonly (string | number)[]>(value: unknown, allowed: T, label: string): T[number] {
  if (!allowed.includes(value as never)) invalid(`${label} has unsupported value ${String(value)}.`);
  return value as T[number];
}

function stringArray(value: unknown, label: string): string[] {
  return array(value, label).map((item, index) => text(item, `${label}[${index}]`));
}

function requireVersion(value: unknown, expected: string, code: string, label: string): void {
  if (value !== expected) throw new EraDraftDataError(code, `Unsupported ${label}: ${String(value)}.`);
}

function invalid(message: string): never {
  throw new EraDraftDataError("INVALID_SERIALIZED_STATE", message);
}

function freezeDeep<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) value.forEach(freezeDeep);
  else Object.values(value as Record<string, unknown>).forEach(freezeDeep);
  return Object.freeze(value);
}
