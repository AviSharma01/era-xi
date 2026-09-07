import type { EraDraftCatalog, EraDraftPlayerRecord } from "./eraDraftData.js";
import {
  EraDraftInvariantError,
  type EraDraftPick,
  type EraDraftSelectionRejection,
  type EraDraftSelectionRejectionCode,
  type TeamSeasonId,
} from "./eraDraftTypes.js";
import type { EraId } from "./teamEvaluationV2.js";

export type EraDraftSelectionContext = {
  readonly eraId: EraId;
  readonly picks: readonly EraDraftPick[];
  readonly activeTeamSeasonId: TeamSeasonId;
};

export type EraDraftSelectionInput = {
  readonly playerTeamSeasonId: string;
  readonly battingPosition: number;
};

export type FutureCompletionFeasibility = {
  readonly feasible: boolean;
  readonly remainingSlots: number;
  readonly remainingOverseasCapacity: number;
  readonly remainingCanonicalPlayers: number;
  readonly keeperAlreadyDrafted: boolean;
  readonly minimumOverseasNeeded: number | null;
  readonly viableKeeperPlayerIds: readonly string[];
};

export type EraDraftSelectionLegality = {
  readonly available: boolean;
  readonly reasons: readonly EraDraftSelectionRejection[];
  readonly player?: EraDraftPlayerRecord;
  readonly futureFeasibility?: FutureCompletionFeasibility;
};

export function evaluateSelectionLegality(
  catalog: EraDraftCatalog,
  context: EraDraftSelectionContext,
  input: EraDraftSelectionInput,
): EraDraftSelectionLegality {
  const reasons: EraDraftSelectionRejection[] = [];
  const eligibility = catalog.getEligibilityRow(input.playerTeamSeasonId);
  if (!eligibility) {
    reasons.push(reason("PLAYER_NOT_FOUND", `Unknown player-team-season ${input.playerTeamSeasonId}.`));
    return frozenLegality(reasons);
  }
  if (eligibility.eligibilityStatus !== "ELIGIBLE") {
    reasons.push(reason("PLAYER_NOT_G2_ELIGIBLE", `${input.playerTeamSeasonId} is not G2 eligible.`));
    return frozenLegality(reasons);
  }
  const player = catalog.getPlayer(input.playerTeamSeasonId);
  if (!player) {
    reasons.push(reason("PLAYER_NOT_FOUND", `Eligible player-team-season ${input.playerTeamSeasonId} is absent from the runtime catalog.`));
    return frozenLegality(reasons);
  }
  if (player.teamSeasonId !== context.activeTeamSeasonId) {
    reasons.push(reason("PLAYER_NOT_IN_CURRENT_SPIN", `${input.playerTeamSeasonId} does not belong to the active team-season.`));
  }
  if (context.picks.some((pick) => pick.playerId === player.playerId)) {
    reasons.push(reason("DUPLICATE_CANONICAL_PLAYER", `${player.canonicalDisplayName} is already drafted through another historical version.`));
  }
  if (!isBattingPosition(input.battingPosition)) {
    reasons.push(reason("INVALID_POSITION", `Batting position ${input.battingPosition} must be an integer from 1 to 11.`));
  } else if (context.picks.some((pick) => pick.battingPosition === input.battingPosition)) {
    reasons.push(reason("POSITION_OCCUPIED", `Batting position ${input.battingPosition} is already occupied.`));
  }
  if ((player as { rosterStatus: string }).rosterStatus === "UNKNOWN") {
    reasons.push(reason("ROSTER_STATUS_UNRESOLVED", `${input.playerTeamSeasonId} has unresolved IPL roster status.`));
  }
  if (player.rosterStatus === "OVERSEAS" && countOverseas(catalog, context.picks) >= 4) {
    reasons.push(reason("OVERSEAS_LIMIT", "An Era Draft XI may contain at most four overseas players."));
  }
  if (reasons.length > 0 || !isBattingPosition(input.battingPosition)) return frozenLegality(reasons, player);

  const hypotheticalPick: EraDraftPick = {
    pickNumber: context.picks.length + 1,
    playerTeamSeasonId: player.playerTeamSeasonId,
    playerId: player.playerId,
    seasonId: player.seasonId,
    teamId: player.teamId,
    franchiseId: player.franchiseId,
    teamSeasonId: player.teamSeasonId,
    battingPosition: input.battingPosition,
  };
  const futureFeasibility = evaluateFutureCompletion(catalog, context.eraId, [...context.picks, hypotheticalPick]);
  if (!futureFeasibility.feasible) {
    reasons.push(reason("FUTURE_XI_IMPOSSIBLE", "This selection would make a legal eleven-player completion impossible."));
  }
  return frozenLegality(reasons, player, futureFeasibility);
}

export function evaluateFutureCompletion(
  catalog: EraDraftCatalog,
  eraId: EraId,
  picks: readonly EraDraftPick[],
): FutureCompletionFeasibility {
  const remainingSlots = 11 - picks.length;
  const remainingOverseasCapacity = 4 - countOverseas(catalog, picks);
  const keeperIds = new Set(catalog.getKeeperCapablePlayerIds(eraId));
  const draftedIds = new Set(picks.map((pick) => pick.playerId));
  const keeperAlreadyDrafted = picks.some((pick) => keeperIds.has(pick.playerId));
  const minimumCostByPlayer = new Map<string, number>();

  for (const teamSeason of catalog.getTeamSeasonsForEra(eraId)) {
    for (const player of catalog.getCandidatesForTeamSeason(teamSeason.teamSeasonId)) {
      if (draftedIds.has(player.playerId)) continue;
      if ((player as { rosterStatus: string }).rosterStatus === "UNKNOWN") {
        throw new EraDraftInvariantError("UNKNOWN_REMAINING_ROSTER_STATUS", `${player.playerTeamSeasonId} has unresolved roster status.`);
      }
      const cost = player.rosterStatus === "INDIAN" ? 0 : 1;
      minimumCostByPlayer.set(player.playerId, Math.min(minimumCostByPlayer.get(player.playerId) ?? 1, cost));
    }
  }

  const base = {
    remainingSlots,
    remainingOverseasCapacity,
    remainingCanonicalPlayers: minimumCostByPlayer.size,
    keeperAlreadyDrafted,
  };
  if (remainingSlots < 0 || remainingOverseasCapacity < 0) {
    return freezeFeasibility({ ...base, feasible: false, minimumOverseasNeeded: null, viableKeeperPlayerIds: [] });
  }
  if (remainingSlots === 0) {
    return freezeFeasibility({
      ...base,
      feasible: keeperAlreadyDrafted,
      minimumOverseasNeeded: keeperAlreadyDrafted ? 0 : null,
      viableKeeperPlayerIds: [],
    });
  }

  if (keeperAlreadyDrafted) {
    const costs = [...minimumCostByPlayer.values()].sort((left, right) => left - right);
    const minimumOverseasNeeded = costs.length >= remainingSlots
      ? costs.slice(0, remainingSlots).reduce((total, cost) => total + cost, 0)
      : null;
    return freezeFeasibility({
      ...base,
      feasible: minimumOverseasNeeded !== null && minimumOverseasNeeded <= remainingOverseasCapacity,
      minimumOverseasNeeded,
      viableKeeperPlayerIds: [],
    });
  }

  let minimumOverseasNeeded: number | null = null;
  const viableKeeperPlayerIds: string[] = [];
  for (const keeperId of [...keeperIds].sort()) {
    const keeperCost = minimumCostByPlayer.get(keeperId);
    if (keeperCost === undefined) continue;
    const otherCosts = [...minimumCostByPlayer]
      .filter(([playerId]) => playerId !== keeperId)
      .map(([, cost]) => cost)
      .sort((left, right) => left - right);
    if (otherCosts.length < remainingSlots - 1) continue;
    const completionCost = keeperCost
      + otherCosts.slice(0, remainingSlots - 1).reduce((total, cost) => total + cost, 0);
    minimumOverseasNeeded = minimumOverseasNeeded === null
      ? completionCost
      : Math.min(minimumOverseasNeeded, completionCost);
    if (completionCost <= remainingOverseasCapacity) viableKeeperPlayerIds.push(keeperId);
  }
  return freezeFeasibility({
    ...base,
    feasible: viableKeeperPlayerIds.length > 0,
    minimumOverseasNeeded,
    viableKeeperPlayerIds,
  });
}

export function teamSeasonHasViableSelection(
  catalog: EraDraftCatalog,
  eraId: EraId,
  picks: readonly EraDraftPick[],
  teamSeasonId: TeamSeasonId,
): boolean {
  const positions = getOpenBattingPositions(picks);
  const context = { eraId, picks, activeTeamSeasonId: teamSeasonId };
  return catalog.getCandidatesForTeamSeason(teamSeasonId).some((player) =>
    positions.some((battingPosition) => evaluateSelectionLegality(
      catalog,
      context,
      { playerTeamSeasonId: player.playerTeamSeasonId, battingPosition },
    ).available));
}

export function getOpenBattingPositions(picks: readonly EraDraftPick[]): readonly EraDraftPick["battingPosition"][] {
  const occupied = new Set(picks.map((pick) => pick.battingPosition));
  return Object.freeze(Array.from({ length: 11 }, (_, index) => index + 1)
    .filter((position) => !occupied.has(position as EraDraftPick["battingPosition"])) as EraDraftPick["battingPosition"][]);
}

function countOverseas(catalog: EraDraftCatalog, picks: readonly EraDraftPick[]): number {
  return picks.reduce((count, pick) => {
    const player = catalog.getPlayer(pick.playerTeamSeasonId);
    if (!player) throw new EraDraftInvariantError("UNKNOWN_PICK_PLAYER", `Pick references unknown ${pick.playerTeamSeasonId}.`);
    if ((player as { rosterStatus: string }).rosterStatus === "UNKNOWN") {
      throw new EraDraftInvariantError("UNKNOWN_PICK_ROSTER_STATUS", `Pick ${pick.playerTeamSeasonId} has unresolved roster status.`);
    }
    return count + (player.rosterStatus === "OVERSEAS" ? 1 : 0);
  }, 0);
}

function isBattingPosition(value: number): value is EraDraftPick["battingPosition"] {
  return Number.isInteger(value) && value >= 1 && value <= 11;
}

function reason(code: EraDraftSelectionRejectionCode, message: string): EraDraftSelectionRejection {
  return Object.freeze({ code, message });
}

function frozenLegality(
  reasons: EraDraftSelectionRejection[],
  player?: EraDraftPlayerRecord,
  futureFeasibility?: FutureCompletionFeasibility,
): EraDraftSelectionLegality {
  Object.freeze(reasons);
  return Object.freeze({ available: reasons.length === 0, reasons, player, futureFeasibility });
}

function freezeFeasibility(value: FutureCompletionFeasibility): FutureCompletionFeasibility {
  Object.freeze(value.viableKeeperPlayerIds);
  return Object.freeze(value);
}
