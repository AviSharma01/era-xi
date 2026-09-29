import { canonicalSha256 } from "./eraDraftCanonical.js";
import type { EraDraftCatalog } from "./eraDraftData.js";
import { assertEraDraftState } from "./eraDraftInvariants.js";
import { opponentAsSimulationTeamV2 } from "./eraDraftOpponentRuntime.js";
import { evaluateEraDraftXi } from "./eraDraftReveal.js";
import {
  DRAFT_OFF_ENTRY_TEAM_ID,
  DRAFT_OFF_MATCH_COUNT,
  DRAFT_OFF_SCHEDULE_VERSION,
  DRAFT_OFF_SEED_VERSION,
  DRAFT_OFF_VERSION,
  type DraftOffCampaignAggregate,
  type DraftOffCampaignResult,
  type DraftOffChallengeResult,
  type DraftOffFixture,
  type DraftOffLeaderboardRow,
  type DraftOffParticipantInput,
  type DraftOffSchedule,
  type DraftOffSeedBundle,
} from "./draftOffTypes.js";
import type { EraOpponentProfileV2 } from "./stage7Data.js";
import {
  buildStandingsV2,
  simulateMatchV2,
  type EraEnvironmentV2,
  type SimulationTeamV2,
} from "./simulationV2.js";
import type { EraId, TeamEvaluationV2 } from "./teamEvaluationV2.js";

export function deriveDraftOffSeeds(input: {
  readonly challengeSeed: string;
  readonly catalogFingerprint: string;
  readonly eraId: EraId;
  readonly roundOrdinal: number;
}): DraftOffSeedBundle {
  if (!input.challengeSeed) throw new RangeError("Draft-Off requires a non-empty challenge seed.");
  if (!input.catalogFingerprint) throw new RangeError("Draft-Off requires a catalog fingerprint.");
  if (!Number.isInteger(input.roundOrdinal) || input.roundOrdinal < 1) {
    throw new RangeError("Draft-Off round ordinal must be a positive integer.");
  }
  const roundSeed = canonicalSha256({
    version: DRAFT_OFF_SEED_VERSION,
    domain: "round",
    challengeSeed: input.challengeSeed,
    catalogFingerprint: input.catalogFingerprint,
    eraId: input.eraId,
    roundOrdinal: input.roundOrdinal,
  });
  return freezeDeep({
    version: DRAFT_OFF_SEED_VERSION,
    roundSeed,
    draftRootSeed: canonicalSha256({
      version: DRAFT_OFF_SEED_VERSION,
      domain: "draft-opportunities",
      roundSeed,
    }),
    scheduleSeed: canonicalSha256({
      version: DRAFT_OFF_SEED_VERSION,
      domain: "opponent-schedule",
      roundSeed,
    }),
  });
}

export function generateDraftOffSchedule(input: {
  readonly catalog: EraDraftCatalog;
  readonly eraId: EraId;
  readonly roundOrdinal: number;
  readonly scheduleSeed: string;
}): DraftOffSchedule {
  if (!input.scheduleSeed) throw new RangeError("Draft-Off schedule requires a non-empty seed.");
  if (!Number.isInteger(input.roundOrdinal) || input.roundOrdinal < 1) {
    throw new RangeError("Draft-Off round ordinal must be a positive integer.");
  }
  const profiles = authoritativeProfiles(input.catalog, input.eraId);
  const authoritativeOpponentProfileIds = profiles.map((profile) => profile.candidateId).sort();
  const fixtures: DraftOffFixture[] = [];
  let previousProfileId: string | undefined;

  for (let cycleOrdinal = 1; fixtures.length < DRAFT_OFF_MATCH_COUNT; cycleOrdinal += 1) {
    const cycle = [...authoritativeOpponentProfileIds].sort((left, right) => {
      const leftRank = cycleRank(input.scheduleSeed, cycleOrdinal, left);
      const rightRank = cycleRank(input.scheduleSeed, cycleOrdinal, right);
      return leftRank.localeCompare(rightRank) || left.localeCompare(right);
    });
    if (previousProfileId && cycle[0] === previousProfileId) cycle.push(cycle.shift()!);

    for (const opponentProfileId of cycle) {
      if (fixtures.length === DRAFT_OFF_MATCH_COUNT) break;
      const sequence = fixtures.length + 1;
      const matchId = `draft-off-r${input.roundOrdinal}-f${String(sequence).padStart(2, "0")}`;
      fixtures.push({
        sequence,
        cycleOrdinal,
        matchId,
        opponentProfileId,
        scenarioSeed: canonicalSha256({
          version: DRAFT_OFF_SEED_VERSION,
          domain: "fixture-scenario",
          scheduleSeed: input.scheduleSeed,
          sequence,
          opponentProfileId,
        }),
      });
      previousProfileId = opponentProfileId;
    }
  }

  const body = {
    version: DRAFT_OFF_SCHEDULE_VERSION,
    eraId: input.eraId,
    roundOrdinal: input.roundOrdinal,
    scheduleSeed: input.scheduleSeed,
    authoritativeOpponentProfileIds,
    fixtures,
  } as const;
  return freezeDeep({ ...body, scheduleHash: canonicalSha256(body) });
}

export function simulateDraftOffChallenge(input: {
  readonly catalog: EraDraftCatalog;
  readonly challengeSeed: string;
  readonly eraId: EraId;
  readonly roundOrdinal: number;
  readonly participants: readonly DraftOffParticipantInput[];
}): DraftOffChallengeResult {
  validateParticipants(input.participants);
  const seeds = deriveDraftOffSeeds({
    challengeSeed: input.challengeSeed,
    catalogFingerprint: input.catalog.fingerprint,
    eraId: input.eraId,
    roundOrdinal: input.roundOrdinal,
  });
  const schedule = generateDraftOffSchedule({
    catalog: input.catalog,
    eraId: input.eraId,
    roundOrdinal: input.roundOrdinal,
    scheduleSeed: seeds.scheduleSeed,
  });
  const profiles = authoritativeProfiles(input.catalog, input.eraId);
  const environment = input.catalog.getEnvironment(input.eraId);
  if (!environment) throw new Error(`${input.eraId} has no authoritative Era Draft environment.`);
  const profileById = new Map(profiles.map((profile) => [profile.candidateId, profile]));
  const opponentTeams = profiles.map(opponentAsSimulationTeamV2);

  const campaigns = [...input.participants]
    .sort((left, right) => left.participantId.localeCompare(right.participantId))
    .map((participant) => simulateParticipant({
      catalog: input.catalog,
      eraId: input.eraId,
      roundSeed: seeds.roundSeed,
      schedule,
      participant,
      environment,
      profileById,
      opponentTeams,
    }));
  const leaderboard = buildDraftOffLeaderboard(campaigns);
  const body = {
    version: DRAFT_OFF_VERSION,
    eraId: input.eraId,
    roundOrdinal: input.roundOrdinal,
    catalogFingerprint: input.catalog.fingerprint,
    seeds,
    schedule,
    campaigns,
    leaderboard,
  } as const;
  return freezeDeep({ ...body, resultHash: canonicalSha256(body) });
}

export function buildDraftOffLeaderboard(
  campaigns: readonly DraftOffCampaignResult[],
): readonly DraftOffLeaderboardRow[] {
  const sorted = [...campaigns].sort((left, right) =>
    right.aggregate.points - left.aggregate.points
    || right.aggregate.netRunRate - left.aggregate.netRunRate
    || left.participantId.localeCompare(right.participantId));
  return freezeDeep(sorted.map((campaign, index) => {
    const previous = sorted[index - 1];
    const tied = previous
      && previous.aggregate.points === campaign.aggregate.points
      && previous.aggregate.netRunRate === campaign.aggregate.netRunRate;
    const rank = tied ? (index === 0 ? 1 : findPriorRank(sorted, index)) : index + 1;
    return {
      rank,
      participantId: campaign.participantId,
      displayName: campaign.displayName,
      submissionHash: campaign.submissionHash,
      campaignHash: campaign.campaignHash,
      ...campaign.aggregate,
    };
  }));
}

function simulateParticipant(input: {
  readonly catalog: EraDraftCatalog;
  readonly eraId: EraId;
  readonly roundSeed: string;
  readonly schedule: DraftOffSchedule;
  readonly participant: DraftOffParticipantInput;
  readonly environment: EraEnvironmentV2;
  readonly profileById: ReadonlyMap<string, EraOpponentProfileV2>;
  readonly opponentTeams: readonly SimulationTeamV2[];
}): DraftOffCampaignResult {
  const { participant } = input;
  assertEraDraftState(input.catalog, participant.xi);
  if (participant.xi.phase !== "XI_COMPLETE" || participant.xi.eraId !== input.eraId) {
    throw new Error(`${participant.participantId} must provide a completed XI from ${input.eraId}.`);
  }
  const evaluation = evaluateEraDraftXi(input.catalog, participant.xi);
  const entrant = evaluationAsDraftOffTeam(evaluation);
  const submissionHash = canonicalSha256({
    version: DRAFT_OFF_VERSION,
    domain: "submission",
    catalogFingerprint: input.catalog.fingerprint,
    eraId: input.eraId,
    xi: [...participant.xi.picks]
      .sort((left, right) => left.battingPosition - right.battingPosition)
      .map((pick) => ({
        playerTeamSeasonId: pick.playerTeamSeasonId,
        playerId: pick.playerId,
        seasonId: pick.seasonId,
        teamId: pick.teamId,
        franchiseId: pick.franchiseId,
        battingPosition: pick.battingPosition,
      })),
  });
  const matches = input.schedule.fixtures.map((fixture) => {
    const profile = input.profileById.get(fixture.opponentProfileId);
    if (!profile) throw new Error(`Draft-Off fixture references unknown opponent ${fixture.opponentProfileId}.`);
    return {
      fixture,
      result: simulateMatchV2({
        seed: fixture.scenarioSeed,
        matchId: fixture.matchId,
        teamA: entrant,
        teamB: opponentAsSimulationTeamV2(profile),
        environment: input.environment,
      }),
    };
  });
  const authoritativeRow = buildStandingsV2(
    [entrant, ...input.opponentTeams],
    matches.map((match) => match.result),
  ).find((row) => row.teamId === DRAFT_OFF_ENTRY_TEAM_ID);
  if (!authoritativeRow || authoritativeRow.played !== DRAFT_OFF_MATCH_COUNT) {
    throw new Error(`Draft-Off campaign for ${participant.participantId} did not produce twenty authoritative matches.`);
  }
  const aggregate: DraftOffCampaignAggregate = {
    played: authoritativeRow.played,
    won: authoritativeRow.won,
    lost: authoritativeRow.lost,
    points: authoritativeRow.points,
    runsFor: authoritativeRow.runsFor,
    ballsFacedForNrr: authoritativeRow.ballsFacedForNrr,
    runsAgainst: authoritativeRow.runsAgainst,
    ballsBowledForNrr: authoritativeRow.ballsBowledForNrr,
    netRunRate: authoritativeRow.netRunRate,
  };
  const resultIdentityHash = canonicalSha256({
    version: DRAFT_OFF_VERSION,
    domain: "participant-result",
    roundSeed: input.roundSeed,
    participantId: participant.participantId,
    submissionHash,
  });
  const body = {
    participantId: participant.participantId,
    displayName: participant.displayName,
    submissionHash,
    resultIdentityHash,
    evaluation,
    scheduleHash: input.schedule.scheduleHash,
    matches,
    aggregate,
  } as const;
  return freezeDeep({ ...body, campaignHash: canonicalSha256(body) });
}

function authoritativeProfiles(catalog: EraDraftCatalog, eraId: EraId): readonly EraOpponentProfileV2[] {
  const availability = catalog.getSimulationContent(eraId);
  const profiles = catalog.getOpponentProfiles(eraId);
  if (availability.status !== "AVAILABLE" || availability.opponentCount !== profiles.length || profiles.length < 2) {
    throw new Error(`${eraId} does not have a complete authoritative Era Draft opponent pool.`);
  }
  if (profiles.some((profile) => profile.eraId !== eraId)) {
    throw new Error(`Draft-Off opponent pool for ${eraId} mixes eras.`);
  }
  if (new Set(profiles.map((profile) => profile.candidateId)).size !== profiles.length) {
    throw new Error(`Draft-Off opponent pool for ${eraId} contains duplicate profile IDs.`);
  }
  return profiles;
}

function evaluationAsDraftOffTeam(evaluation: TeamEvaluationV2): SimulationTeamV2 {
  return {
    teamId: DRAFT_OFF_ENTRY_TEAM_ID,
    displayName: "Draft-Off XI",
    strength: {
      batting: evaluation.adjustedStrength.batting,
      bowling: evaluation.adjustedStrength.bowling,
      overall: evaluation.adjustedStrength.overall,
    },
  };
}

function validateParticipants(participants: readonly DraftOffParticipantInput[]): void {
  if (participants.length < 2 || participants.length > 8) {
    throw new RangeError("Draft-Off requires between two and eight participants.");
  }
  if (new Set(participants.map((participant) => participant.participantId)).size !== participants.length) {
    throw new Error("Draft-Off participant IDs must be unique.");
  }
  for (const participant of participants) {
    if (!participant.participantId || !participant.displayName.trim()) {
      throw new Error("Draft-Off participants require non-empty IDs and display names.");
    }
  }
}

function cycleRank(scheduleSeed: string, cycleOrdinal: number, opponentProfileId: string): string {
  return canonicalSha256({
    version: DRAFT_OFF_SCHEDULE_VERSION,
    domain: "opponent-cycle",
    scheduleSeed,
    cycleOrdinal,
    opponentProfileId,
  });
}

function findPriorRank(campaigns: readonly DraftOffCampaignResult[], index: number): number {
  const current = campaigns[index]!;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const candidate = campaigns[cursor]!;
    if (candidate.aggregate.points !== current.aggregate.points
      || candidate.aggregate.netRunRate !== current.aggregate.netRunRate) return cursor + 2;
  }
  return 1;
}

function freezeDeep<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) value.forEach(freezeDeep);
  else Object.values(value as Record<string, unknown>).forEach(freezeDeep);
  return Object.freeze(value);
}
