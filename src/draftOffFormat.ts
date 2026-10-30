import { canonicalSha256 } from "./eraDraftCanonical.js";

export type DraftOffFormat = "VARIED" | "MIRROR";
export const DRAFT_OFF_PARTICIPANT_SEED_VERSION = "ipl-draft-off-participant-seeds/v1" as const;
export const isDraftOffFormat = (value: unknown): value is DraftOffFormat => value === "VARIED" || value === "MIRROR";
export const draftOffFormatLabel = (format: DraftOffFormat) => format === "VARIED" ? "Varied Draft" : "Mirror Draft";
export const draftOffFormatDescription = (format: DraftOffFormat) => format === "VARIED"
  ? "Different spins for every player. Everyone faces the same 20-match opponent schedule. Opportunities can be unequal in individual rounds."
  : "Shared base spins. Your player choices, placements and respin decisions shape your XI.";

/** No participant metadata enters the shared schedule or XI simulation seed paths. */
export function deriveDraftOffParticipantSeed(roomDraftSeed: string, participantId: string, format: DraftOffFormat): string {
  if (!roomDraftSeed || !participantId || participantId !== participantId.trim() || !isDraftOffFormat(format)) {
    throw new RangeError("Draft-Off requires a room draft seed, stable participant ID and supported format.");
  }
  return format === "MIRROR" ? roomDraftSeed : canonicalSha256({
    version: DRAFT_OFF_PARTICIPANT_SEED_VERSION,
    domain: "participant-draft-opportunities",
    roomDraftSeed,
    participantId,
  });
}
