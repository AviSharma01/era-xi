import type { EraDraftCatalog } from "./eraDraftData.js";
import { countDraftTiers, type EraDraftTierCaps } from "./eraDraftTierCaps.js";
import { EraDraftInvariantError, type EraDraftPick } from "./eraDraftTypes.js";
import type { EraId } from "./teamEvaluationV2.js";
import type { FutureCompletionFeasibility } from "./eraDraftLegality.js";

type Cost = readonly [overseas: number, s: number, sa: number];
type PlayerOptions = { readonly playerId: string; readonly costs: readonly Cost[]; readonly zeroCost: boolean };
type CompletionOptionsIndex = {
  readonly players: readonly PlayerOptions[];
  readonly byPlayerId: ReadonlyMap<string, PlayerOptions>;
  readonly keepers: readonly PlayerOptions[];
  readonly zeroCostPlayers: number;
};
const indexes = new WeakMap<EraDraftCatalog, Map<EraId, CompletionOptionsIndex>>();

function optionsFor(catalog: EraDraftCatalog, eraId: EraId): CompletionOptionsIndex {
  let eras = indexes.get(catalog);
  if (!eras) { eras = new Map(); indexes.set(catalog, eras); }
  const existing = eras.get(eraId);
  if (existing) return existing;
  const players = new Map<string, Map<string, Cost>>();
  for (const team of catalog.getTeamSeasonsForEra(eraId)) for (const player of catalog.getCandidatesForTeamSeason(team.teamSeasonId)) {
    if ((player as { rosterStatus: string }).rosterStatus === "UNKNOWN") {
      throw new EraDraftInvariantError("UNKNOWN_REMAINING_ROSTER_STATUS", `${player.playerTeamSeasonId} has unresolved roster status.`);
    }
    const tier = player.quality.overall.qualityTier;
    const cost: Cost = [Number(player.rosterStatus === "OVERSEAS"), Number(tier === "S"), Number(tier === "S" || tier === "A")];
    let variants = players.get(player.playerId);
    if (!variants) { variants = new Map(); players.set(player.playerId, variants); }
    variants.set(cost.join(), cost);
  }
  const options = [...players].map(([playerId, variants]) => {
    const costs = [...variants.values()];
    return { playerId, costs, zeroCost: costs.some(cost => cost.every(value => value === 0)) };
  });
  const keeperIds = new Set(catalog.getKeeperCapablePlayerIds(eraId));
  const result = {
    players: options,
    byPlayerId: new Map(options.map(player => [player.playerId, player])),
    keepers: options.filter(player => keeperIds.has(player.playerId)),
    zeroCostPlayers: options.reduce((count, player) => count + Number(player.zeroCost), 0),
  };
  eras.set(eraId, result);
  return result;
}

/** Exact multiple-choice resource DP: select at most one historical variant per real player.
 * Overseas and tier costs stay coupled; independent minima can invent nonexistent variants.
 */
function minimumCost(
  index: CompletionOptionsIndex, drafted: ReadonlySet<string>, remainingPlayers: number,
  slots: number, s: number, sa: number, zeroCostPlayers: number, excluded?: PlayerOptions,
): number | null {
  if (slots < 0 || s < 0 || sa < 0) return null;
  if (slots === 0) return 0;
  if (remainingPlayers - Number(!!excluded) < slots) return null;
  // Catalog counts minus drafted IDs give an exact witness without rescanning
  // every historical option at each canonical replay boundary.
  if (zeroCostPlayers - Number(excluded?.zeroCost ?? false) >= slots) return 0;
  const available = index.players.filter(player => !drafted.has(player.playerId) && player !== excluded);
  const width = (s + 1) * (sa + 1), size = (slots + 1) * width;
  const dp = new Float64Array(size).fill(Infinity); dp[0] = 0;
  let seen = 0;
  for (const player of available) {
    for (let n = Math.min(slots, ++seen); n >= 1; n--) for (let ns = 0; ns <= s; ns++) for (let ne = 0; ne <= sa; ne++) {
      const at = n * width + ns * (sa + 1) + ne;
      for (const [o, cs, ce] of player.costs) if (cs <= ns && ce <= ne) {
        dp[at] = Math.min(dp[at]!, dp[(n - 1) * width + (ns - cs) * (sa + 1) + ne - ce]! + o);
      }
    }
  }
  let best = Infinity;
  for (let i = slots * width; i < size; i++) best = Math.min(best, dp[i]!);
  return Number.isFinite(best) ? best : null;
}

export function evaluateTierCompletion(catalog: EraDraftCatalog, eraId: EraId, picks: readonly EraDraftPick[], caps: EraDraftTierCaps): FutureCompletionFeasibility {
  const drafted = new Set(picks.map(pick => pick.playerId)), keepers = new Set(catalog.getKeeperCapablePlayerIds(eraId));
  const index = optionsFor(catalog, eraId);
  let remainingCanonicalPlayers = index.players.length, zeroCostPlayers = index.zeroCostPlayers;
  for (const playerId of drafted) {
    const player = index.byPlayerId.get(playerId);
    if (player) { remainingCanonicalPlayers--; zeroCostPlayers -= Number(player.zeroCost); }
  }
  const counts = countDraftTiers(catalog, picks), s = caps.maxS - counts.s, sa = caps.maxSA - counts.sa;
  const remainingSlots = 11 - picks.length;
  const remainingOverseasCapacity = 4 - picks.filter(pick => catalog.getPlayer(pick.playerTeamSeasonId)!.rosterStatus === "OVERSEAS").length;
  const keeperAlreadyDrafted = picks.some(pick => keepers.has(pick.playerId));
  let minimumOverseasNeeded: number | null = null;
  const viableKeeperPlayerIds: string[] = [];
  if (remainingSlots >= 0 && remainingOverseasCapacity >= 0 && s >= 0 && sa >= 0) {
    if (keeperAlreadyDrafted) minimumOverseasNeeded = minimumCost(index, drafted, remainingCanonicalPlayers, remainingSlots, s, sa, zeroCostPlayers);
    else if (remainingSlots > 0) for (const keeper of index.keepers) {
      if (drafted.has(keeper.playerId)) continue;
      let best: number | null = null;
      for (const [o, cs, ce] of keeper.costs) {
        const rest = minimumCost(index, drafted, remainingCanonicalPlayers, remainingSlots - 1, s - cs, sa - ce, zeroCostPlayers, keeper);
        if (rest !== null) best = Math.min(best ?? Infinity, rest + o);
      }
      if (best !== null) {
        minimumOverseasNeeded = Math.min(minimumOverseasNeeded ?? Infinity, best);
        if (best <= remainingOverseasCapacity) viableKeeperPlayerIds.push(keeper.playerId);
      }
    }
  }
  return Object.freeze({ feasible: minimumOverseasNeeded !== null && minimumOverseasNeeded <= remainingOverseasCapacity,
    remainingSlots, remainingOverseasCapacity, remainingCanonicalPlayers, keeperAlreadyDrafted,
    minimumOverseasNeeded, viableKeeperPlayerIds: Object.freeze(viableKeeperPlayerIds.sort()) });
}
