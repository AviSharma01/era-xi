import { shortTeamSeasonName } from "../../copy.js";
import type { EraDraftCatalog } from "../../eraDraftData.js";
import type { EraId } from "../../teamEvaluationV2.js";

/**
 * Short names for the league's opponents, keyed by the team id the season results use ("MI 2013"). Built from the
 * catalog's opponent profiles and team-seasons, so no id is ever parsed. An opponent without one keeps its full name.
 */
export function opponentShortNames(catalog: EraDraftCatalog, eraId: EraId): ReadonlyMap<string, string> {
  const years = new Map(catalog.getTeamSeasonsForEra(eraId).map((teamSeason) => [`${teamSeason.teamId}|${teamSeason.seasonId}`, teamSeason.seasonYear]));
  return new Map(catalog.getOpponentProfiles(eraId).flatMap((profile) => {
    const year = years.get(`${profile.teamId}|${profile.seasonId}`);
    return year === undefined ? [] : [[profile.candidateId, shortTeamSeasonName(profile.teamId, profile.teamName, year)] as const];
  }));
}
