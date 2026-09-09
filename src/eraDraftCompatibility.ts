/** Frozen Stage 8 seed identity for Foundation simulation compatibility.
 *
 * This is deliberately not the current catalog fingerprint contract. Later content may
 * advance the catalog fingerprint while Foundation replays continue to use this value.
 * Phase 3 will integrate the compatibility fingerprint into seed derivation.
 */
export const FOUNDATION_SIMULATION_COMPATIBILITY_FINGERPRINT =
  "03054faff39520da6a835e0aaecb1a9887ca82291d9ba0a5923540c862793808" as const;
