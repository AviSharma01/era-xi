import type { EraDraftPlayerRecord } from "./eraDraftData.js";

/** Derived once from an immutable catalog's original team-season/candidate scan order. */
export type EraDraftCompletionIndex = {
  readonly canonicalPlayers: number;
  readonly domesticPlayers: number;
  readonly unknownRows: readonly {
    readonly playerId: string;
    readonly playerTeamSeasonId: string;
  }[];
  getMinimumCost(playerId: string): number | undefined;
};

export function buildEraDraftCompletionIndex(playersInScanOrder: Iterable<EraDraftPlayerRecord>): EraDraftCompletionIndex {
  const costs = new Map<string, number>();
  const unknownRows: { readonly playerId: string; readonly playerTeamSeasonId: string }[] = [];
  for (const player of playersInScanOrder) {
    if ((player as { rosterStatus: string }).rosterStatus === "UNKNOWN") {
      // Do not throw during catalog construction: a drafted canonical player is
      // excluded before UNKNOWN is checked by the original feasibility scan.
      unknownRows.push(Object.freeze({ playerId: player.playerId, playerTeamSeasonId: player.playerTeamSeasonId }));
      continue;
    }
    const cost = player.rosterStatus === "INDIAN" ? 0 : 1;
    costs.set(player.playerId, Math.min(costs.get(player.playerId) ?? 1, cost));
  }
  let domesticPlayers = 0;
  for (const cost of costs.values()) if (cost === 0) domesticPlayers += 1;
  return Object.freeze({
    canonicalPlayers: costs.size,
    domesticPlayers,
    unknownRows: Object.freeze(unknownRows),
    // The private map cannot be mutated through the index; no result/pick state is retained.
    getMinimumCost: Object.freeze((playerId: string) => costs.get(playerId)),
  });
}
