import type { EraDraftCatalog, EraDraftPlayerRecord } from "./eraDraftData.js";
import { EraDraftDataError, type XiCompleteState } from "./eraDraftTypes.js";
import {
  evaluateCompletedEraXi,
  type EraCompletedXiInput,
  type EraXiPlayerInput,
  type TeamEvaluationV2,
} from "./teamEvaluationV2.js";

/**
 * The only Stage 8 pick-to-evaluator join. Input order remains draft order;
 * locked batting positions are passed explicitly for Team Evaluation V2 to validate.
 */
export function buildEraDraftEvaluationInput(
  catalog: EraDraftCatalog,
  state: XiCompleteState,
): EraCompletedXiInput {
  const era = catalog.getEra(state.eraId);
  if (!era) {
    throw new EraDraftDataError("REVEAL_ERA_NOT_FOUND", `Cannot reveal unknown era ${state.eraId}.`, {
      eraId: state.eraId,
    });
  }
  if (state.picks.length !== 11) {
    throw new EraDraftDataError("REVEAL_XI_INCOMPLETE", "Reveal requires exactly eleven drafted picks.", {
      pickCount: state.picks.length,
    });
  }

  const players = state.picks.map((pick): EraXiPlayerInput => {
    const player = catalog.getPlayer(pick.playerTeamSeasonId);
    if (!player) {
      throw new EraDraftDataError(
        "REVEAL_PLAYER_JOIN_FAILED",
        `Cannot join drafted player-team-season ${pick.playerTeamSeasonId}.`,
        { playerTeamSeasonId: pick.playerTeamSeasonId },
      );
    }
    assertPickIdentity(pick, player);
    return {
      position: pick.battingPosition,
      role: player.role,
      quality: player.quality,
      rosterStatus: player.rosterStatus,
    };
  });

  return {
    era: { eraId: era.eraId, seasonIds: era.seasonIds },
    players,
  };
}

export function evaluateEraDraftXi(
  catalog: EraDraftCatalog,
  state: XiCompleteState,
): TeamEvaluationV2 {
  const input = buildEraDraftEvaluationInput(catalog, state);
  try {
    return evaluateCompletedEraXi(input);
  } catch (error) {
    if (error instanceof EraDraftDataError) throw error;
    throw new EraDraftDataError(
      "TEAM_EVALUATION_V2_FAILED",
      "Team Evaluation V2 rejected the completed Era Draft XI.",
      { eraId: state.eraId },
      { cause: error },
    );
  }
}

function assertPickIdentity(
  pick: XiCompleteState["picks"][number],
  player: EraDraftPlayerRecord,
): void {
  if (
    player.playerTeamSeasonId !== pick.playerTeamSeasonId
    || player.playerId !== pick.playerId
    || player.seasonId !== pick.seasonId
    || player.teamId !== pick.teamId
    || player.franchiseId !== pick.franchiseId
    || player.teamSeasonId !== pick.teamSeasonId
  ) {
    throw new EraDraftDataError(
      "REVEAL_PICK_IDENTITY_MISMATCH",
      `Drafted identity ${pick.playerTeamSeasonId} no longer matches the Stage 8 catalog.`,
      {
        playerTeamSeasonId: pick.playerTeamSeasonId,
        playerId: pick.playerId,
        seasonId: pick.seasonId,
        teamId: pick.teamId,
        franchiseId: pick.franchiseId,
        teamSeasonId: pick.teamSeasonId,
      },
    );
  }
}
