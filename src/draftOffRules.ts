import type { EraDraftTierCaps } from "./eraDraftTierCaps.js";

/** Copied into new rooms at creation. Existing rooms always use their stored values. */
export const STANDARD_DRAFT_OFF_TIER_CAPS: EraDraftTierCaps = Object.freeze({ maxS: 3, maxSA: 6 });
