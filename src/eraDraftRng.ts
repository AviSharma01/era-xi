import type { EraDraftCatalog, EraDraftTeamSeason } from "./eraDraftData.js";
import { ERA_DRAFT_ENGINE_VERSION } from "./eraDraftTypes.js";
import type { EraId } from "./teamEvaluationV2.js";
import { random01 } from "./simulationV2.js";

export const ERA_DRAFT_NORMAL_SPIN_DOMAIN = "normal-spin" as const;

export function selectNormalSpinTeamSeason(
  catalog: EraDraftCatalog,
  rootSeed: string,
  eraId: EraId,
  normalSpinOrdinal: number,
): EraDraftTeamSeason {
  if (!Number.isInteger(normalSpinOrdinal) || normalSpinOrdinal < 0) {
    throw new RangeError("Normal spin ordinal must be a non-negative integer.");
  }
  const teamSeasons = [...catalog.getTeamSeasonsForEra(eraId)]
    .sort((left, right) => left.teamSeasonId.localeCompare(right.teamSeasonId));
  if (teamSeasons.length === 0) throw new RangeError(`${eraId} has no team-seasons to spin.`);
  const draw = random01(
    ERA_DRAFT_ENGINE_VERSION,
    rootSeed,
    eraId,
    ERA_DRAFT_NORMAL_SPIN_DOMAIN,
    String(normalSpinOrdinal),
  );
  return teamSeasons[Math.floor(draw * teamSeasons.length)]!;
}
