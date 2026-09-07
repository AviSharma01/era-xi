import type { EraDraftCatalog } from "./eraDraftData.js";
import {
  ERA_DRAFT_ENGINE_VERSION,
  ERA_DRAFT_STATE_SCHEMA_VERSION,
  EraDraftInvariantError,
  type EraDraftState,
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
  if (state.rngCounters.normalSpin !== state.history.filter((entry) => entry.command === "SPIN").length) {
    fail("NORMAL_SPIN_COUNTER_MISMATCH", "Normal spin counter disagrees with accepted history.");
  }
  if (state.rngCounters.voluntaryRespin !== 0 || state.rngCounters.deadSpinRecovery !== 0) {
    fail("PHASE1_RNG_SCOPE_VIOLATION", "Phase 1 cannot advance respin or recovery RNG counters.");
  }
  if (state.respin.status !== "AVAILABLE") fail("PHASE1_RESPIN_SCOPE_VIOLATION", "Phase 1 cannot consume the respin.");
  if (state.picks.length !== 0) fail("PHASE1_PICK_SCOPE_VIOLATION", "Phase 1 state cannot contain picks.");
  state.history.forEach((entry, index) => {
    if (entry.revision !== index + 1) fail("INVALID_HISTORY", "Accepted history revisions must be contiguous.");
  });
  if (state.history.at(-1)?.resultingPhase !== state.phase && state.history.length > 0) {
    fail("HISTORY_PHASE_MISMATCH", "Latest accepted history entry disagrees with state phase.");
  }

  if (state.phase === "SETUP") {
    if ("eraId" in state || "currentSpin" in state || state.history.length !== 0 || state.revision !== 0) {
      fail("INVALID_SETUP_STATE", "SETUP cannot contain an era, spin, or accepted history.");
    }
    return;
  }

  const era = catalog.getEra(state.eraId);
  if (!era) fail("UNKNOWN_STATE_ERA", `State references unknown era ${state.eraId}.`);
  if (state.phase === "AWAITING_SPIN") {
    if ("currentSpin" in state) fail("INVALID_AWAITING_SPIN_STATE", "AWAITING_SPIN cannot contain a current spin.");
    const choose = state.history[0];
    if (
      state.history.length !== 1
      || state.revision !== 1
      || state.rngCounters.normalSpin !== 0
      || choose?.command !== "CHOOSE_ERA"
      || choose.payload.eraId !== state.eraId
    ) {
      fail("INVALID_AWAITING_SPIN_HISTORY", "Phase 1 AWAITING_SPIN must directly follow its accepted era choice.");
    }
    return;
  }

  const spin = state.currentSpin;
  if (spin.origin !== "NORMAL" || spin.spinOrdinal !== state.rngCounters.normalSpin - 1) {
    fail("INVALID_CURRENT_SPIN", "Current spin origin or ordinal is invalid.");
  }
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
  const candidates = catalog.getCandidatesForTeamSeason(spin.teamSeasonId);
  if (candidates.length === 0) fail("EMPTY_CURRENT_SPIN", "Current spin has no G2 candidates.");
  if (candidates.some((candidate) => candidate.teamSeasonId !== spin.teamSeasonId || candidate.eraId !== state.eraId)) {
    fail("CURRENT_SPIN_CANDIDATE_MISMATCH", "Current spin candidates disagree with its team-season or era.");
  }
  const choose = state.history[0];
  const spinEvent = state.history[1];
  if (
    state.history.length !== 2
    || state.revision !== 2
    || state.rngCounters.normalSpin !== 1
    || choose?.command !== "CHOOSE_ERA"
    || choose.payload.eraId !== state.eraId
    || spinEvent?.command !== "SPIN"
    || spinEvent.selectedTeamSeasonId !== spin.teamSeasonId
  ) {
    fail("INVALID_AWAITING_PICK_HISTORY", "Phase 1 AWAITING_PICK history must match its era and current spin.");
  }
}

function fail(code: string, message: string): never {
  throw new EraDraftInvariantError(code, message);
}
