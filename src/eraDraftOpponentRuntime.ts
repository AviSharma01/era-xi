import type { EraOpponentProfileV2 } from "./stage7Data.js";
import type { SimulationTeamV2 } from "./simulationV2.js";

export function opponentAsSimulationTeamV2(profile: EraOpponentProfileV2): SimulationTeamV2 {
  return {
    teamId: profile.candidateId,
    displayName: `${profile.teamName} ${profile.seasonId.slice(4)}`,
    strength: {
      batting: profile.evaluation.batting,
      bowling: profile.evaluation.bowling,
      overall: profile.evaluation.overall,
    },
  };
}
