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
import { EraDraftDataError, type DraftPresentationFit, type DraftStatusView } from "./eraDraftTypes.js";
import type { FitClassification } from "./playerRoleContract.js";

export function projectEraDraftPublicState(
  catalog: EraDraftCatalog,
  state: EraDraftHiddenState,
): EraDraftPublicView {
  assertEraDraftState(catalog, state);
  if (state.phase === "SETUP") return Object.freeze({ phase: "SETUP", revision: state.revision });
  const era = catalog.getEra(state.eraId)!;
  const picks = projectPicks(catalog, state.picks);
  const status = projectDraftStatus(catalog, state);
  if (state.phase === "AWAITING_SPIN") {
    return freezeDeep({ phase: "AWAITING_SPIN", revision: state.revision, eraId: state.eraId, eraLabel: era.label, status, picks });
  }
  if (state.phase === "XI_COMPLETE") {
    return freezeDeep({ phase: "XI_COMPLETE", revision: state.revision, eraId: state.eraId, eraLabel: era.label, status, picks });
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
    status,
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
      presentationFit: toDraftPresentationFit(
        player.role.battingFit.slots[battingPosition - 1]!.classification,
        player.role.battingFit.slots[battingPosition - 1]!.bandDistance,
      ),
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
    const slot = evaluated.role.battingFit.slots[evaluated.position - 1]!;
    return {
      ...projectPlayerFacts(player),
      battingPosition: evaluated.position,
      presentationFit: toDraftPresentationFit(slot.classification, slot.bandDistance),
      battingRating: evaluated.quality.batting.battingRating,
      bowlingRating: evaluated.quality.bowling.bowlingRating,
      overallRating: evaluated.quality.overall.overallRating,
      qualityTier: evaluated.quality.overall.qualityTier,
    };
  });
  const fitCounts: Record<DraftPresentationFit, number> = {
    NATURAL: 0,
    ACCEPTABLE: 0,
    STRETCH: 0,
    MAJOR_STRETCH: 0,
    UNKNOWN: 0,
  };
  for (const player of players) fitCounts[player.presentationFit] += 1;
  return freezeDeep({
    phase: "REVEALED",
    revision: state.revision,
    eraId: state.eraId,
    eraLabel: era.label,
    status: projectDraftStatus(catalog, state),
    picks,
    players,
    evaluation: {
      strength: {
        overall: state.evaluation.adjustedStrength.overall,
        batting: state.evaluation.adjustedStrength.batting,
        bowling: state.evaluation.adjustedStrength.bowling,
      },
      tierCounts: { ...state.evaluation.diagnostics.tierCounts },
      fitCounts,
      construction: {
        overseasCount: state.evaluation.diagnostics.overseasCount,
        overseasLimit: 4,
        hasWicketkeeper: state.evaluation.diagnostics.hasWicketkeeper,
        deployedBowlingUnits: state.evaluation.diagnostics.deployedBowlingUnits,
        requiredBowlingUnits: 5,
        frontlineBowlers: state.evaluation.diagnostics.bowlingWorkloadCounts.FRONTLINE,
        supportBowlers: state.evaluation.diagnostics.bowlingWorkloadCounts.SUPPORT,
      },
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
      presentationFit: toDraftPresentationFit(
        player.role.battingFit.slots[pick.battingPosition - 1]!.classification,
        player.role.battingFit.slots[pick.battingPosition - 1]!.bandDistance,
      ),
    });
  });
}

export function toDraftPresentationFit(
  classification: FitClassification,
  bandDistance: number | null,
): DraftPresentationFit {
  if (classification === "NATURAL") return "NATURAL";
  if (classification === "ACCEPTABLE") return "ACCEPTABLE";
  if (classification === "UNKNOWN") {
    if (bandDistance !== null) throw invalidFit(classification, bandDistance);
    return "UNKNOWN";
  }
  if (!Number.isInteger(bandDistance) || bandDistance === null || bandDistance < 2 || bandDistance > 4) {
    throw invalidFit(classification, bandDistance);
  }
  return bandDistance === 2 ? "STRETCH" : "MAJOR_STRETCH";
}

function projectDraftStatus(
  catalog: EraDraftCatalog,
  state: Pick<Exclude<EraDraftHiddenState, { phase: "SETUP" }> | RevealedState, "picks" | "respin">,
): DraftStatusView {
  const players = state.picks.map((pick) => catalog.getPlayer(pick.playerTeamSeasonId)!);
  return Object.freeze({
    pickCount: state.picks.length,
    pickLimit: 11,
    overseasCount: players.filter((player) => player.rosterStatus === "OVERSEAS").length,
    overseasLimit: 4,
    hasWicketkeeper: players.some((player) => player.role.keeperMetadata.capabilityStatus === "CONFIRMED"),
    respinStatus: state.respin.status,
  });
}

function invalidFit(classification: FitClassification, bandDistance: number | null): EraDraftDataError {
  return new EraDraftDataError(
    "INVALID_PRESENTATION_FIT_DISTANCE",
    `Draft presentation cannot project ${classification} with band distance ${String(bandDistance)}.`,
    { classification, bandDistance },
  );
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
