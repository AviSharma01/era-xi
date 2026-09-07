import type { EraDraftCatalog, EraDraftPlayerRecord } from "./eraDraftData.js";
import { assertEraDraftState } from "./eraDraftInvariants.js";
import { evaluateSelectionLegality, getOpenBattingPositions } from "./eraDraftLegality.js";
import type {
  AwaitingPickPublicView,
  DraftCandidateIdentityView,
  DraftPickView,
  DraftPlayerFactsView,
  EraDraftHiddenState,
  EraDraftPublicView,
  EraDraftRevealView,
  RevealedState,
} from "./eraDraftTypes.js";

export function projectEraDraftPublicState(
  catalog: EraDraftCatalog,
  state: EraDraftHiddenState,
): EraDraftPublicView {
  assertEraDraftState(catalog, state);
  if (state.phase === "SETUP") return Object.freeze({ phase: "SETUP", revision: state.revision });
  const era = catalog.getEra(state.eraId)!;
  const picks = projectPicks(catalog, state.picks);
  if (state.phase === "AWAITING_SPIN") {
    return freezeDeep({ phase: "AWAITING_SPIN", revision: state.revision, eraId: state.eraId, eraLabel: era.label, picks });
  }
  if (state.phase === "XI_COMPLETE") {
    return freezeDeep({ phase: "XI_COMPLETE", revision: state.revision, eraId: state.eraId, eraLabel: era.label, picks });
  }
  const teamSeason = catalog.getTeamSeason(state.currentSpin.teamSeasonId)!;
  const context = { eraId: state.eraId, picks: state.picks, activeTeamSeasonId: teamSeason.teamSeasonId };
  const openPositions = getOpenBattingPositions(state.picks);
  const candidates = catalog.getCandidatesForTeamSeason(teamSeason.teamSeasonId)
    .map((player) => projectCandidate(catalog, player, context, openPositions));
  return freezeDeep({
    phase: "AWAITING_PICK",
    revision: state.revision,
    eraId: state.eraId,
    eraLabel: era.label,
    picks,
    currentSpin: {
      spinOrdinal: state.currentSpin.spinOrdinal,
      teamSeasonId: teamSeason.teamSeasonId,
      seasonId: teamSeason.seasonId,
      seasonYear: teamSeason.seasonYear,
      teamId: teamSeason.teamId,
      teamName: teamSeason.teamName,
      franchiseId: teamSeason.franchiseId,
      franchiseName: teamSeason.franchiseName,
    },
    candidates,
  } satisfies AwaitingPickPublicView);
}

function projectCandidate(
  catalog: EraDraftCatalog,
  player: EraDraftPlayerRecord,
  context: Parameters<typeof evaluateSelectionLegality>[1],
  openPositions: ReturnType<typeof getOpenBattingPositions>,
): DraftCandidateIdentityView {
  const positions = openPositions.map((battingPosition) => {
    const legality = evaluateSelectionLegality(catalog, context, { playerTeamSeasonId: player.playerTeamSeasonId, battingPosition });
    return Object.freeze({
      battingPosition,
      fit: player.role.battingFit.slots[battingPosition - 1]!.classification,
      available: legality.available,
      reasons: legality.reasons,
    });
  });
  return freezeDeep({
    ...projectPlayerFacts(player),
    available: positions.some((position) => position.available),
    positions,
  });
}

export function projectEraDraftRevealState(
  catalog: EraDraftCatalog,
  state: RevealedState,
): EraDraftRevealView {
  assertEraDraftState(catalog, state);
  const era = catalog.getEra(state.eraId)!;
  const picks = projectPicks(catalog, state.picks);
  const players = state.evaluation.players.map((evaluated) => {
    const player = catalog.getPlayer(evaluated.quality.playerTeamSeasonId)!;
    return {
      ...projectPlayerFacts(player),
      battingPosition: evaluated.position,
      fit: evaluated.role.battingFit.slots[evaluated.position - 1]!.classification,
      battingRating: evaluated.quality.batting.battingRating,
      bowlingRating: evaluated.quality.bowling.bowlingRating,
      overallRating: evaluated.quality.overall.overallRating,
      qualityTier: evaluated.quality.overall.qualityTier,
    };
  });
  return freezeDeep({
    phase: "REVEALED",
    revision: state.revision,
    eraId: state.eraId,
    eraLabel: era.label,
    picks,
    players,
    evaluation: {
      version: state.evaluation.version,
      battingContributions: state.evaluation.battingContributions,
      bowlingDeployment: state.evaluation.bowlingDeployment,
      baseStrength: state.evaluation.baseStrength,
      adjustedStrength: state.evaluation.adjustedStrength,
      diagnostics: state.evaluation.diagnostics,
      effects: state.evaluation.effects,
    },
  } satisfies EraDraftRevealView);
}

function projectPicks(catalog: EraDraftCatalog, picks: EraDraftHiddenState["picks"]): readonly DraftPickView[] {
  return picks.map((pick) => {
    const player = catalog.getPlayer(pick.playerTeamSeasonId)!;
    return freezeDeep({
      ...projectPlayerFacts(player),
      pickNumber: pick.pickNumber,
      battingPosition: pick.battingPosition,
      fit: player.role.battingFit.slots[pick.battingPosition - 1]!.classification,
    });
  });
}

function projectPlayerFacts(player: EraDraftPlayerRecord): DraftPlayerFactsView {
  return Object.freeze({
    playerTeamSeasonId: player.playerTeamSeasonId,
    playerId: player.playerId,
    playerName: player.canonicalDisplayName,
    seasonId: player.seasonId,
    seasonYear: player.seasonYear,
    teamId: player.teamId,
    teamName: player.teamName,
    franchiseId: player.franchiseId,
    franchiseName: player.franchiseName,
    rosterStatus: player.rosterStatus,
    keeperCapability: player.role.keeperMetadata.capabilityStatus,
    derivedRole: player.role.derivedRole,
    bowlingWorkloadClass: player.role.bowlingWorkloadClass,
    bowlingFamily: player.role.bowlingFamily,
  });
}

function freezeDeep<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) value.forEach(freezeDeep);
  else Object.values(value as Record<string, unknown>).forEach(freezeDeep);
  return Object.freeze(value);
}
