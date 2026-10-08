import type { DraftOffCompetitionState } from "./draftOffCompetitionTypes.js";

/** Storage scheduling facts projected only from validated M2 state; never a save format. */
export type DraftOffRoomLifecycle =
  | { readonly phase: "LOBBY"; readonly createdAtMs: number }
  | { readonly phase: "IN_PROGRESS"; readonly deadlineAtMs: number }
  | { readonly phase: "COMPLETE"; readonly completedAtMs: number };

export function projectDraftOffRoomLifecycle(state: DraftOffCompetitionState, hint?: DraftOffRoomLifecycle): DraftOffRoomLifecycle {
  if (state.phase === "LOBBY") return validatedProjection("LOBBY", "createdAtMs", state.genesis.createdAtMs, hint);
  if (state.phase === "COMPLETE") return validatedProjection("COMPLETE", "completedAtMs", state.lastAcceptedAtMs, hint);
  const active = state.rounds.find((round) => round.phase === "DRAFTING");
  if (!active || active.phase !== "DRAFTING") throw new Error("Active competition has no drafting round.");
  return validatedProjection("IN_PROGRESS", "deadlineAtMs", active.deadlineAtMs, hint);
}

function validatedProjection(
  phase: DraftOffRoomLifecycle["phase"],
  timeKey: "createdAtMs" | "completedAtMs" | "deadlineAtMs",
  atMs: number,
  hint?: DraftOffRoomLifecycle,
): DraftOffRoomLifecycle {
  // Only reuse an immutable hint after comparing every field with restored state.
  // Missing, stale, malformed and mutable hints are replaced; they never bypass replay.
  if (hint && typeof hint === "object" && Object.isFrozen(hint)) {
    const row = hint as unknown as Record<string, unknown>;
    const keys = Object.keys(row);
    const phaseField = Object.getOwnPropertyDescriptor(row, "phase");
    const timeField = Object.getOwnPropertyDescriptor(row, timeKey);
    if (keys.length === 2 && Object.hasOwn(row, "phase") && Object.hasOwn(row, timeKey)
        && phaseField?.value === phase && timeField?.value === atMs) return hint;
  }
  return Object.freeze({ phase, [timeKey]: atMs }) as DraftOffRoomLifecycle;
}
