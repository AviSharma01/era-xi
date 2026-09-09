import type { EraDraftCatalog } from "./eraDraftData.js";
import { evaluateFutureCompletion, teamSeasonHasViableSelection } from "./eraDraftLegality.js";
import { evaluateEraDraftXi } from "./eraDraftReveal.js";
import { assertEraDraftSeasonResult } from "./eraDraftSimulation.js";
import {
  ERA_DRAFT_ENGINE_VERSION,
  ERA_DRAFT_STATE_SCHEMA_VERSION,
  EraDraftInvariantError,
  type EraDraftHistoryEntry,
  type EraDraftPick,
  type EraDraftState,
  type TeamSeasonId,
} from "./eraDraftTypes.js";

export function assertEraDraftState(catalog: EraDraftCatalog, state: EraDraftState): void {
  if (state.engineVersion !== ERA_DRAFT_ENGINE_VERSION || state.schemaVersion !== ERA_DRAFT_STATE_SCHEMA_VERSION) {
    fail("STATE_VERSION_MISMATCH", "Era Draft state uses unsupported version fields.");
  }
  if (state.catalogFingerprint !== catalog.fingerprint) {
    fail("CATALOG_FINGERPRINT_MISMATCH", "Era Draft state belongs to a different runtime catalog.");
  }
  if (typeof state.rootSeed !== "string" || state.rootSeed.length === 0) {
    fail("INVALID_ROOT_SEED", "Era Draft root seed must be a non-empty string.");
  }
  if (!Number.isInteger(state.revision) || state.revision < 0 || state.revision !== state.history.length) {
    fail("INVALID_REVISION", "Era Draft revision must equal accepted history length.");
  }
  for (const [domain, counter] of Object.entries(state.rngCounters)) {
    if (!Number.isInteger(counter) || counter < 0) fail("INVALID_RNG_COUNTER", `Invalid RNG counter ${domain}.`);
  }

  const normalEvents = state.history.filter((entry) => entry.command === "SPIN");
  const respinEvents = state.history.filter((entry) => entry.command === "RESPIN");
  const recoveryEvents = state.history.filter((entry) =>
    (entry.command === "SPIN" || entry.command === "RESPIN") && entry.skippedDeadTeamSeasonIds.length > 0);
  if (state.rngCounters.normalSpin !== normalEvents.length) {
    fail("NORMAL_SPIN_COUNTER_MISMATCH", "Normal spin counter disagrees with accepted history.");
  }
  if (state.rngCounters.voluntaryRespin !== respinEvents.length || respinEvents.length > 1) {
    fail("RESPIN_COUNTER_MISMATCH", "Voluntary respin counter disagrees with accepted history.");
  }
  if (state.rngCounters.deadSpinRecovery !== recoveryEvents.length) {
    fail("RECOVERY_COUNTER_MISMATCH", "Recovery counter disagrees with accepted history.");
  }
  if ((state.respin.status === "USED") !== (respinEvents.length === 1)) {
    fail("RESPIN_STATUS_MISMATCH", "Respin status must change exactly once from AVAILABLE to USED.");
  }

  validateHistory(catalog, state);
  validatePicks(catalog, state);

  if (state.phase === "SETUP") {
    if (
      "eraId" in state || "currentSpin" in state || "evaluation" in state || "season" in state
      || state.history.length !== 0 || state.picks.length !== 0
    ) {
      fail("INVALID_SETUP_STATE", "SETUP cannot contain an era, spin, picks, or accepted history.");
    }
    return;
  }

  const era = catalog.getEra(state.eraId);
  if (!era) fail("UNKNOWN_STATE_ERA", `State references unknown era ${state.eraId}.`);
  const feasibility = evaluateFutureCompletion(catalog, state.eraId, state.picks);

  if (state.phase === "XI_COMPLETE") {
    if ("currentSpin" in state || "evaluation" in state || "season" in state || state.picks.length !== 11) {
      fail("INVALID_XI_COMPLETE_STATE", "XI_COMPLETE requires exactly eleven picks, no active spin, and no evaluation.");
    }
    const positions = [...state.picks].map((pick) => pick.battingPosition).sort((left, right) => left - right);
    if (positions.some((position, index) => position !== index + 1) || !feasibility.feasible) {
      fail("INVALID_COMPLETED_XI", "Completed XI must fill positions 1-11 and contain a confirmed keeper.");
    }
    return;
  }

  if (state.phase === "REVEALED") {
    if ("currentSpin" in state || "season" in state || state.picks.length !== 11 || !state.evaluation) {
      fail("INVALID_REVEALED_STATE", "REVEALED requires exactly eleven picks, no active spin, and an evaluation.");
    }
    const positions = [...state.picks].map((pick) => pick.battingPosition).sort((left, right) => left - right);
    if (positions.some((position, index) => position !== index + 1) || !feasibility.feasible) {
      fail("INVALID_REVEALED_XI", "Revealed XI must remain a legal completed XI.");
    }
    if (state.evaluation.eraId !== state.eraId) {
      fail("REVEAL_ERA_MISMATCH", "Revealed evaluation uses a different era from the draft.");
    }
    const expectedEvaluation = evaluateEraDraftXi(catalog, { ...state, phase: "XI_COMPLETE" });
    if (JSON.stringify(state.evaluation) !== JSON.stringify(expectedEvaluation)) {
      fail("REVEAL_EVALUATION_MISMATCH", "Revealed evaluation is not the deterministic result for the drafted XI.");
    }
    return;
  }

  if (state.phase === "GAME_COMPLETE") {
    if ("currentSpin" in state || state.picks.length !== 11 || !state.evaluation || !state.season) {
      fail("INVALID_GAME_COMPLETE_STATE", "GAME_COMPLETE requires a revealed XI and completed season result.");
    }
    const positions = [...state.picks].map((pick) => pick.battingPosition).sort((left, right) => left - right);
    if (positions.some((position, index) => position !== index + 1) || !feasibility.feasible) {
      fail("INVALID_GAME_COMPLETE_XI", "Completed game must retain the legal drafted XI.");
    }
    const expectedEvaluation = evaluateEraDraftXi(catalog, { ...state, phase: "XI_COMPLETE" });
    if (JSON.stringify(state.evaluation) !== JSON.stringify(expectedEvaluation)) {
      fail("GAME_COMPLETE_EVALUATION_MISMATCH", "Completed game evaluation differs from the drafted XI.");
    }
    try {
      assertEraDraftSeasonResult(catalog, state, state.season);
    } catch (error) {
      if (error instanceof EraDraftInvariantError) throw error;
      fail("GAME_COMPLETE_SIMULATION_MISMATCH", error instanceof Error ? error.message : "Invalid completed simulation.");
    }
    return;
  }

  if (!feasibility.feasible) {
    fail("NO_VIABLE_TEAM_SEASON", "Incomplete Era Draft state has no existential legal completion.");
  }
  if (state.phase === "AWAITING_SPIN") {
    if ("currentSpin" in state || "evaluation" in state || "season" in state || state.picks.length >= 11) {
      fail("INVALID_AWAITING_SPIN_STATE", "AWAITING_SPIN cannot contain a current spin or complete XI.");
    }
    return;
  }

  if ("evaluation" in state || "season" in state || state.picks.length >= 11) {
    fail("INVALID_AWAITING_PICK_STATE", "AWAITING_PICK cannot contain evaluation, season, or a complete XI.");
  }
  validateCurrentSpin(catalog, state);
  if (!teamSeasonHasViableSelection(catalog, state.eraId, state.picks, state.currentSpin.teamSeasonId)) {
    fail("DEAD_CURRENT_SPIN", "AWAITING_PICK cannot expose a team-season without a feasible player-slot selection.");
  }
}

function validateHistory(catalog: EraDraftCatalog, state: EraDraftState): void {
  let replayPhase: EraDraftState["phase"] = "SETUP";
  let selectedEra: string | undefined;
  let lockedCount = 0;
  let normalOrdinal = 0;
  let respinOrdinal = 0;
  let activeTeamSeasonId: TeamSeasonId | undefined;
  for (const [index, entry] of state.history.entries()) {
    if (entry.revision !== index + 1) fail("INVALID_HISTORY", "Accepted history revisions must be contiguous.");
    switch (entry.command) {
      case "CHOOSE_ERA":
        if (replayPhase !== "SETUP" || !catalog.getEra(entry.payload.eraId)) fail("INVALID_HISTORY_SEQUENCE", "Invalid CHOOSE_ERA history entry.");
        selectedEra = entry.payload.eraId;
        replayPhase = "AWAITING_SPIN";
        break;
      case "SPIN":
        if (replayPhase !== "AWAITING_SPIN" || entry.spinOrdinal !== normalOrdinal) fail("INVALID_HISTORY_SEQUENCE", "Invalid SPIN history entry.");
        validateSpinHistoryIdentities(catalog, selectedEra, entry);
        normalOrdinal += 1;
        activeTeamSeasonId = entry.selectedTeamSeasonId;
        replayPhase = "AWAITING_PICK";
        break;
      case "RESPIN":
        if (
          replayPhase !== "AWAITING_PICK"
          || entry.respinOrdinal !== respinOrdinal
          || respinOrdinal !== 0
          || entry.discardedTeamSeasonId !== activeTeamSeasonId
          || entry.discardedTeamSeasonId === entry.replacementTeamSeasonId
          || entry.resultingRespinStatus !== "USED"
        ) {
          fail("INVALID_HISTORY_SEQUENCE", "Invalid RESPIN history entry.");
        }
        validateSpinHistoryIdentities(catalog, selectedEra, {
          triggeringTeamSeasonId: entry.triggeringTeamSeasonId,
          skippedDeadTeamSeasonIds: entry.skippedDeadTeamSeasonIds,
          selectedTeamSeasonId: entry.replacementTeamSeasonId,
        });
        respinOrdinal += 1;
        activeTeamSeasonId = entry.replacementTeamSeasonId;
        replayPhase = "AWAITING_PICK";
        break;
      case "LOCK_PLAYER": {
        if (replayPhase !== "AWAITING_PICK") fail("INVALID_HISTORY_SEQUENCE", "Invalid LOCK_PLAYER history entry.");
        const pick = state.picks[lockedCount];
        if (
          !pick
          || entry.payload.playerTeamSeasonId !== pick.playerTeamSeasonId
          || entry.payload.playerId !== pick.playerId
          || entry.payload.battingPosition !== pick.battingPosition
          || pick.teamSeasonId !== activeTeamSeasonId
        ) {
          fail("PICK_HISTORY_MISMATCH", "LOCK_PLAYER history disagrees with authoritative picks.");
        }
        lockedCount += 1;
        activeTeamSeasonId = undefined;
        replayPhase = lockedCount === 11 ? "XI_COMPLETE" : "AWAITING_SPIN";
        break;
      }
      case "REVEAL_XI":
        if (replayPhase !== "XI_COMPLETE" || lockedCount !== 11) {
          fail("INVALID_HISTORY_SEQUENCE", "Invalid REVEAL_XI history entry.");
        }
        activeTeamSeasonId = undefined;
        replayPhase = "REVEALED";
        break;
      case "SIMULATE_SEASON":
        if (replayPhase !== "REVEALED" || selectedEra === undefined) {
          fail("INVALID_HISTORY_SEQUENCE", "Invalid SIMULATE_SEASON history entry.");
        }
        replayPhase = "GAME_COMPLETE";
        break;
    }
    if (entry.resultingPhase !== replayPhase) fail("HISTORY_PHASE_MISMATCH", "History resulting phase is invalid.");
  }
  if (lockedCount !== state.picks.length || replayPhase !== state.phase) {
    fail("HISTORY_STATE_MISMATCH", "Accepted history does not reconstruct the current state.");
  }
  if (state.phase !== "SETUP" && selectedEra !== state.eraId) {
    fail("HISTORY_ERA_MISMATCH", "Accepted era history disagrees with state.");
  }
}

function validateSpinHistoryIdentities(
  catalog: EraDraftCatalog,
  eraId: string | undefined,
  entry: {
    readonly triggeringTeamSeasonId: TeamSeasonId;
    readonly skippedDeadTeamSeasonIds: readonly TeamSeasonId[];
    readonly selectedTeamSeasonId: TeamSeasonId;
  },
): void {
  const allIds = [entry.triggeringTeamSeasonId, ...entry.skippedDeadTeamSeasonIds, entry.selectedTeamSeasonId];
  for (const teamSeasonId of allIds) {
    if (catalog.getTeamSeason(teamSeasonId)?.eraId !== eraId) {
      fail("HISTORY_TEAM_SEASON_MISMATCH", `${teamSeasonId} does not belong to the accepted era.`);
    }
  }
  if (entry.skippedDeadTeamSeasonIds.includes(entry.selectedTeamSeasonId)) {
    fail("INVALID_RECOVERY_HISTORY", "Recovered team-season cannot also be logged as dead.");
  }
  if (entry.skippedDeadTeamSeasonIds.length === 0 && entry.triggeringTeamSeasonId !== entry.selectedTeamSeasonId) {
    fail("INVALID_RECOVERY_HISTORY", "A changed spin result requires a recovery path.");
  }
  if (entry.skippedDeadTeamSeasonIds.length > 0 && entry.skippedDeadTeamSeasonIds[0] !== entry.triggeringTeamSeasonId) {
    fail("INVALID_RECOVERY_HISTORY", "Recovery history must begin with the triggering dead team-season.");
  }
}

function validatePicks(catalog: EraDraftCatalog, state: EraDraftState): void {
  const positions = new Set<number>();
  const ptsIds = new Set<string>();
  const playerIds = new Set<string>();
  let overseas = 0;
  for (const [index, pick] of state.picks.entries()) {
    if (pick.pickNumber !== index + 1) fail("INVALID_PICK_NUMBER", "Pick numbers must be contiguous.");
    if (!Number.isInteger(pick.battingPosition) || pick.battingPosition < 1 || pick.battingPosition > 11) {
      fail("INVALID_PICK_POSITION", "Every pick must occupy a batting position from 1 to 11.");
    }
    if (positions.has(pick.battingPosition)) fail("DUPLICATE_PICK_POSITION", "Batting positions must be unique.");
    if (ptsIds.has(pick.playerTeamSeasonId)) fail("DUPLICATE_PICK_PTS", "Picked PTS IDs must be unique.");
    if (playerIds.has(pick.playerId)) fail("DUPLICATE_PICK_PLAYER", "Picked canonical player IDs must be unique.");
    positions.add(pick.battingPosition);
    ptsIds.add(pick.playerTeamSeasonId);
    playerIds.add(pick.playerId);

    const player = catalog.getPlayer(pick.playerTeamSeasonId);
    if (!player) fail("UNKNOWN_PICK_PLAYER", `Pick references unknown ${pick.playerTeamSeasonId}.`);
    if (
      state.phase === "SETUP"
      || player.eraId !== state.eraId
      || player.playerId !== pick.playerId
      || player.seasonId !== pick.seasonId
      || player.teamId !== pick.teamId
      || player.franchiseId !== pick.franchiseId
      || player.teamSeasonId !== pick.teamSeasonId
    ) {
      fail("PICK_IDENTITY_MISMATCH", `Pick ${pick.playerTeamSeasonId} disagrees with the catalog.`);
    }
    if ((player as { rosterStatus: string }).rosterStatus === "UNKNOWN") fail("UNKNOWN_PICK_ROSTER_STATUS", "Picked roster status is unresolved.");
    if (player.rosterStatus === "OVERSEAS") overseas += 1;
  }
  if (overseas > 4) fail("OVERSEAS_LIMIT_EXCEEDED", "Era Draft state exceeds four overseas players.");
}

function validateCurrentSpin(catalog: EraDraftCatalog, state: Extract<EraDraftState, { phase: "AWAITING_PICK" }>): void {
  const spin = state.currentSpin;
  const teamSeason = catalog.getTeamSeason(spin.teamSeasonId);
  if (!teamSeason) fail("UNKNOWN_TEAM_SEASON", `Current spin references unknown ${spin.teamSeasonId}.`);
  if (
    teamSeason.eraId !== state.eraId
    || teamSeason.seasonId !== spin.seasonId
    || teamSeason.teamId !== spin.teamId
    || teamSeason.franchiseId !== spin.franchiseId
  ) {
    fail("CURRENT_SPIN_IDENTITY_MISMATCH", "Current spin identity disagrees with the catalog.");
  }
  const latest = [...state.history].reverse().find((entry) => entry.command === "SPIN" || entry.command === "RESPIN");
  if (!latest) fail("MISSING_SPIN_HISTORY", "Current spin has no accepted spin history.");
  const selected = latest.command === "SPIN" ? latest.selectedTeamSeasonId : latest.replacementTeamSeasonId;
  const ordinal = latest.command === "SPIN" ? latest.spinOrdinal : latest.respinOrdinal;
  const origin = latest.command === "SPIN" ? "NORMAL" : "RESPIN";
  if (spin.teamSeasonId !== selected || spin.spinOrdinal !== ordinal || spin.origin !== origin) {
    fail("CURRENT_SPIN_HISTORY_MISMATCH", "Current spin disagrees with the latest accepted spin event.");
  }
  const skipped = latest.skippedDeadTeamSeasonIds;
  if (skipped.length === 0 && spin.recovery !== null) fail("CURRENT_SPIN_RECOVERY_MISMATCH", "Direct spin cannot contain recovery metadata.");
  if (
    skipped.length > 0
    && (
      spin.recovery?.triggeringTeamSeasonId !== latest.triggeringTeamSeasonId
      || !sameStrings(spin.recovery.skippedDeadTeamSeasonIds, skipped)
    )
  ) {
    fail("CURRENT_SPIN_RECOVERY_MISMATCH", "Current spin recovery metadata disagrees with history.");
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function fail(code: string, message: string): never {
  throw new EraDraftInvariantError(code, message);
}
