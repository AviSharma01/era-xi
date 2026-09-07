import { canonicalJson } from "./eraDraftCanonical.js";
import type { EraDraftCatalog } from "./eraDraftData.js";
import { createEraDraftGame, reduceEraDraft } from "./eraDraftEngine.js";
import { canonicalEraDraftStateHash } from "./eraDraftPersistence.js";
import {
  EraDraftDataError,
  type EraDraftCommand,
  type EraDraftHistoryEntry,
  type EraDraftState,
} from "./eraDraftTypes.js";

export function replayEraDraftGame(input: {
  readonly catalog: EraDraftCatalog;
  readonly rootSeed: string;
  readonly history: readonly EraDraftHistoryEntry[];
  readonly expectedStateHash?: string;
}): EraDraftState {
  let state: EraDraftState = createEraDraftGame({ catalog: input.catalog, rootSeed: input.rootSeed });
  for (const recorded of input.history) {
    const result = reduceEraDraft(input.catalog, state, commandFromHistory(recorded));
    if (!result.ok) {
      throw new EraDraftDataError(
        "REPLAY_COMMAND_REJECTED",
        `Accepted ${recorded.command} history rejected during deterministic replay.`,
        { revision: recorded.revision, rejectionCode: result.error.code },
      );
    }
    if (canonicalJson(result.event) !== canonicalJson(recorded)) {
      throw new EraDraftDataError(
        "REPLAY_EVENT_MISMATCH",
        `Deterministic replay diverged at revision ${recorded.revision}.`,
        { command: recorded.command },
      );
    }
    state = result.state;
  }
  if (input.expectedStateHash && canonicalEraDraftStateHash(state) !== input.expectedStateHash) {
    throw new EraDraftDataError("REPLAY_STATE_HASH_MISMATCH", "Replayed state differs from the expected canonical state hash.");
  }
  return state;
}

export function replayEraDraftState(catalog: EraDraftCatalog, expected: EraDraftState): EraDraftState {
  return replayEraDraftGame({
    catalog,
    rootSeed: expected.rootSeed,
    history: expected.history,
    expectedStateHash: canonicalEraDraftStateHash(expected),
  });
}

function commandFromHistory(entry: EraDraftHistoryEntry): EraDraftCommand {
  switch (entry.command) {
    case "CHOOSE_ERA": return { type: "CHOOSE_ERA", eraId: entry.payload.eraId };
    case "SPIN": return { type: "SPIN" };
    case "LOCK_PLAYER": return {
      type: "LOCK_PLAYER",
      playerTeamSeasonId: entry.payload.playerTeamSeasonId,
      battingPosition: entry.payload.battingPosition,
    };
    case "RESPIN": return { type: "RESPIN" };
    case "REVEAL_XI": return { type: "REVEAL_XI" };
    case "SIMULATE_SEASON": return { type: "SIMULATE_SEASON" };
  }
}
