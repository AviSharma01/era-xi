import type { EraDraftCatalog } from "./eraDraftData.js";
import { EraDraftInvariantError, type EraDraftPick } from "./eraDraftTypes.js";

/** Effective values are persisted by the owning competition, never inferred on replay. */
export type EraDraftTierCaps = { readonly maxS: number; readonly maxSA: number };

export function isEraDraftTierCaps(value: unknown): value is EraDraftTierCaps {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === 2 && Object.hasOwn(row, "maxS") && Object.hasOwn(row, "maxSA")
    && Number.isInteger(row.maxS) && Number.isInteger(row.maxSA)
    && (row.maxS as number) >= 0 && (row.maxSA as number) >= (row.maxS as number) && (row.maxSA as number) <= 11;
}

export function countDraftTiers(catalog: EraDraftCatalog, picks: readonly EraDraftPick[]) {
  let s = 0, sa = 0;
  for (const pick of picks) {
    const player = catalog.getPlayer(pick.playerTeamSeasonId);
    if (!player) throw new EraDraftInvariantError("UNKNOWN_PICK_PLAYER", `Unknown pick ${pick.playerTeamSeasonId}.`);
    const tier = player.quality.overall.qualityTier;
    s += Number(tier === "S");
    sa += Number(tier === "S" || tier === "A");
  }
  return { s, sa };
}
