import type { EraDraftCatalog } from "./eraDraftData.js";
import { createEraDraftGame, reduceEraDraft } from "./eraDraftEngine.js";
import { evaluateSelectionLegality, getOpenBattingPositions } from "./eraDraftLegality.js";
import type { EraDraftState, RevealedState, XiCompleteState } from "./eraDraftTypes.js";
import type { EraId } from "./teamEvaluationV2.js";

export function draftEraXi(catalog: EraDraftCatalog, rootSeed: string, eraId: EraId): XiCompleteState {
  let state = accepted(reduceEraDraft(
    catalog,
    createEraDraftGame({ catalog, rootSeed }),
    { type: "CHOOSE_ERA", eraId },
  ));
  for (let pickIndex = 0; pickIndex < 11; pickIndex += 1) {
    state = accepted(reduceEraDraft(catalog, state, { type: "SPIN" }));
    if (state.phase !== "AWAITING_PICK") throw new Error("Expected AWAITING_PICK fixture state.");
    const context = {
      eraId,
      picks: state.picks,
      activeTeamSeasonId: state.currentSpin.teamSeasonId,
    };
    const choice = catalog.getCandidatesForTeamSeason(state.currentSpin.teamSeasonId)
      .flatMap((player) => getOpenBattingPositions(state.picks).map((battingPosition) => ({ player, battingPosition })))
      .find(({ player, battingPosition }) => evaluateSelectionLegality(
        catalog,
        context,
        { playerTeamSeasonId: player.playerTeamSeasonId, battingPosition },
      ).available);
    if (!choice) throw new Error("Viable spin exposed no legal fixture choice.");
    state = accepted(reduceEraDraft(catalog, state, {
      type: "LOCK_PLAYER",
      playerTeamSeasonId: choice.player.playerTeamSeasonId,
      battingPosition: choice.battingPosition,
    }));
  }
  if (state.phase !== "XI_COMPLETE") throw new Error("Fixture draft did not complete its XI.");
  return state;
}

export function revealEraXi(catalog: EraDraftCatalog, rootSeed: string, eraId: EraId): RevealedState {
  const state = accepted(reduceEraDraft(catalog, draftEraXi(catalog, rootSeed, eraId), { type: "REVEAL_XI" }));
  if (state.phase !== "REVEALED") throw new Error("Fixture draft did not reach REVEALED.");
  return state;
}

export function accepted(result: ReturnType<typeof reduceEraDraft>): EraDraftState {
  if (!result.ok) throw new Error(result.error.message);
  return result.state;
}

export function wrapEraDraftCatalog(
  base: EraDraftCatalog,
  overrides: Partial<Pick<
    EraDraftCatalog,
    "getCandidatesForTeamSeason" | "getSimulationContent" | "getEnvironment" | "getFoundationOpponents"
  >>,
): EraDraftCatalog {
  return {
    fingerprint: base.fingerprint,
    diagnostics: base.diagnostics,
    getEra: (id) => base.getEra(id),
    getEraIds: () => base.getEraIds(),
    getEraForSeason: (id) => base.getEraForSeason(id),
    getTeamSeason: (id) => base.getTeamSeason(id),
    getTeamSeasonsForEra: (id) => base.getTeamSeasonsForEra(id),
    getEligibilityRow: (id) => base.getEligibilityRow(id),
    getPlayer: (id) => base.getPlayer(id),
    getCandidatesForTeamSeason: overrides.getCandidatesForTeamSeason
      ?? ((id) => base.getCandidatesForTeamSeason(id)),
    getPlayerVariantsForEra: (eraId, playerId) => base.getPlayerVariantsForEra(eraId, playerId),
    getKeeperCapablePlayerIds: (id) => base.getKeeperCapablePlayerIds(id),
    getSimulationContent: overrides.getSimulationContent ?? ((id) => base.getSimulationContent(id)),
    getEnvironment: overrides.getEnvironment ?? ((id) => base.getEnvironment(id)),
    getFoundationOpponents: overrides.getFoundationOpponents ?? (() => base.getFoundationOpponents()),
  };
}
