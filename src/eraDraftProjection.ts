import type { EraDraftCatalog, EraDraftPlayerRecord } from "./eraDraftData.js";
import { assertEraDraftState } from "./eraDraftInvariants.js";
import { evaluateSelectionLegality, getOpenBattingPositions } from "./eraDraftLegality.js";
import type {
  AwaitingPickPublicView,
  DraftCandidateIdentityView,
  EraDraftPublicView,
  EraDraftState,
} from "./eraDraftTypes.js";

export function projectEraDraftPublicState(
  catalog: EraDraftCatalog,
  state: EraDraftState,
): EraDraftPublicView {
  assertEraDraftState(catalog, state);
  if (state.phase === "SETUP") return Object.freeze({ phase: "SETUP", revision: state.revision });
  const era = catalog.getEra(state.eraId)!;
  if (state.phase === "AWAITING_SPIN") {
    return Object.freeze({ phase: "AWAITING_SPIN", revision: state.revision, eraId: state.eraId, eraLabel: era.label });
  }
  if (state.phase === "XI_COMPLETE") {
    return Object.freeze({ phase: "XI_COMPLETE", revision: state.revision, eraId: state.eraId, eraLabel: era.label });
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
    playerTeamSeasonId: player.playerTeamSeasonId,
    playerId: player.playerId,
    playerName: player.canonicalDisplayName,
    seasonId: player.seasonId,
    seasonYear: player.seasonYear,
    teamId: player.teamId,
    teamName: player.teamName,
    franchiseId: player.franchiseId,
    franchiseName: player.franchiseName,
    available: positions.some((position) => position.available),
    positions,
  });
}

function freezeDeep<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) value.forEach(freezeDeep);
  else Object.values(value as Record<string, unknown>).forEach(freezeDeep);
  return Object.freeze(value);
}
