import type { EraOpponentProfileV2 } from "./stage7Data.js";
import { random01 } from "./simulationV2.js";
import {
  ERA_DRAFT_OPPONENT_COMPOSITION_SCHEMA_VERSION,
  type EraDraftOpponentComposition,
  type EraDraftOpponentCompositionView,
  type EraDraftSeasonResult,
} from "./eraDraftTypes.js";

export const ERA_DRAFT_OPPONENT_SHORTLIST_DOMAIN = "stage9a-opponent-shortlist/v1" as const;

export function shortlistEraOpponentProfiles(
  profiles: readonly EraOpponentProfileV2[],
  opponentCompositionSeed: string,
): readonly EraOpponentProfileV2[] {
  if (profiles.length < 8) throw new Error("Era opponent shortlist requires at least eight profiles.");
  if (new Set(profiles.map((profile) => profile.candidateId)).size !== profiles.length) {
    throw new Error("Era opponent shortlist requires unique candidate IDs.");
  }
  const eraId = profiles[0]?.eraId;
  if (!eraId || profiles.some((profile) => profile.eraId !== eraId)) {
    throw new Error("Era opponent shortlist cannot mix eras.");
  }
  if (profiles.length === 8) return Object.freeze([...profiles]);

  const selectedIds = new Set([...profiles]
    .sort((left, right) => shortlistRank(opponentCompositionSeed, left.candidateId)
      - shortlistRank(opponentCompositionSeed, right.candidateId)
      || left.candidateId.localeCompare(right.candidateId))
    .slice(0, 8)
    .map((profile) => profile.candidateId));
  return Object.freeze(profiles.filter((profile) => selectedIds.has(profile.candidateId)));
}

export function buildEraDraftOpponentComposition(
  profiles: readonly EraOpponentProfileV2[],
  shortlisted: readonly EraOpponentProfileV2[],
): EraDraftOpponentComposition {
  const eraId = profiles[0]?.eraId;
  const fullPoolIds = profiles.map((profile) => profile.candidateId);
  const shortlistedIds = shortlisted.map((profile) => profile.candidateId);
  const fullPoolIndex = new Map(fullPoolIds.map((candidateId, index) => [candidateId, index]));
  if (!eraId || shortlisted.length !== 8 || new Set(shortlistedIds).size !== 8
    || shortlisted.some((profile) => profile.eraId !== eraId || !fullPoolIndex.has(profile.candidateId))
    || shortlistedIds.some((candidateId, index) => index > 0
      && fullPoolIndex.get(candidateId)! < fullPoolIndex.get(shortlistedIds[index - 1]!)!)) {
    throw new Error("Opponent composition requires one era.");
  }
  return Object.freeze({
    schemaVersion: ERA_DRAFT_OPPONENT_COMPOSITION_SCHEMA_VERSION,
    eraId,
    fullPoolProfileIds: Object.freeze(fullPoolIds),
    shortlistedProfileIds: Object.freeze(shortlistedIds),
  });
}

export function projectEraDraftOpponentComposition(
  season: Pick<EraDraftSeasonResult, "opponentComposition" | "league">,
): EraDraftOpponentCompositionView {
  return Object.freeze({
    ...season.opponentComposition,
    fullPoolProfileIds: Object.freeze([...season.opponentComposition.fullPoolProfileIds]),
    shortlistedProfileIds: Object.freeze([...season.opponentComposition.shortlistedProfileIds]),
    actualOpponentProfileIds: Object.freeze(season.league.teams
      .filter((team) => team.teamId !== "user")
      .map((team) => team.teamId)),
    omittedShortlistedProfileId: season.league.omittedOpponentTeamId,
  });
}

function shortlistRank(seed: string, candidateId: string): number {
  return random01(seed, ERA_DRAFT_OPPONENT_SHORTLIST_DOMAIN, candidateId);
}
