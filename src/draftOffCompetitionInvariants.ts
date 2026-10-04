import { canonicalJson, canonicalSha256 } from "./eraDraftCanonical.js";
import type { EraDraftCatalog } from "./eraDraftData.js";
import { assertEraDraftState } from "./eraDraftInvariants.js";
import { canonicalEraDraftStateHash } from "./eraDraftPersistence.js";
import { deriveDraftOffSeeds, deriveDraftOffSubmissionHash } from "./draftOffSimulation.js";
import {
  DRAFT_OFF_COMPETITION_ENGINE_VERSION,
  DRAFT_OFF_COMPETITION_STATE_SCHEMA_VERSION,
  DRAFT_OFF_ROUND_RESOLUTION_VERSION,
  DRAFT_OFF_SUBMISSION_VERSION,
  DraftOffCompetitionInvariantError,
  type ActiveDraftOffRound,
  type DraftOffCompetitionState,
  type DraftOffRoundParticipant,
  type ResolvedDraftOffRound,
} from "./draftOffCompetitionTypes.js";

export function assertDraftOffCompetitionState(
  catalog: EraDraftCatalog,
  state: DraftOffCompetitionState,
): void {
  if (
    state.engineVersion !== DRAFT_OFF_COMPETITION_ENGINE_VERSION
    || state.schemaVersion !== DRAFT_OFF_COMPETITION_STATE_SCHEMA_VERSION
  ) fail("STATE_VERSION_MISMATCH", "Competition state uses unsupported version fields.");
  if (state.catalogFingerprint !== catalog.fingerprint || state.genesis.catalogFingerprint !== catalog.fingerprint) {
    fail("CATALOG_FINGERPRINT_MISMATCH", "Competition state belongs to a different catalog.");
  }
  if (state.competitionId !== state.genesis.competitionId) fail("COMPETITION_ID_MISMATCH", "Competition ID differs from genesis.");
  timestamp(state.genesis.createdAtMs, "createdAtMs");
  timestamp(state.lastAcceptedAtMs, "lastAcceptedAtMs");
  if (state.lastAcceptedAtMs < state.genesis.createdAtMs) fail("INVALID_TIMESTAMP_ORDER", "State predates competition creation.");
  if (!Number.isInteger(state.revision) || state.revision < 0 || state.revision !== state.history.length) {
    fail("INVALID_REVISION", "Competition revision must equal accepted history length.");
  }
  let priorAtMs = state.genesis.createdAtMs;
  for (const [index, event] of state.history.entries()) {
    if (event.revision !== index + 1) fail("INVALID_HISTORY_REVISION", "Competition history revisions must be contiguous.");
    timestamp(event.command.atMs, `history[${index}].command.atMs`);
    if (event.command.atMs < priorAtMs) fail("INVALID_HISTORY_TIME", "Competition history timestamps must be nondecreasing.");
    priorAtMs = event.command.atMs;
  }
  if (state.revision > 0 && state.lastAcceptedAtMs !== priorAtMs) {
    fail("LAST_ACCEPTED_TIME_MISMATCH", "Latest accepted time differs from history.");
  }
  if (state.history.length > 0 && state.history.at(-1)!.resultingCompetitionPhase !== state.phase) {
    fail("HISTORY_PHASE_MISMATCH", "Latest accepted event disagrees with competition phase.");
  }

  validateParticipants(state);
  validateRounds(catalog, state);
}

function validateParticipants(state: DraftOffCompetitionState): void {
  if (state.participants.length < 1) fail("MISSING_HOST", "Competition requires a host.");
  const ids = new Set<string>();
  const names = new Set<string>();
  let hosts = 0;
  let joined = 0;
  for (const [index, participant] of state.participants.entries()) {
    if (!isValidId(participant.participantId)) fail("INVALID_PARTICIPANT_ID", "Participant IDs must be non-empty and trimmed.");
    if (ids.has(participant.participantId)) fail("DUPLICATE_PARTICIPANT_ID", "Participant IDs must be unique.");
    if (index > 0 && state.participants[index - 1]!.participantId.localeCompare(participant.participantId) >= 0) {
      fail("UNSORTED_PARTICIPANTS", "Competition participants must be sorted by ID.");
    }
    if (!participant.displayName || participant.displayName !== participant.displayName.trim()) {
      fail("INVALID_DISPLAY_NAME", "Stored display names must be non-empty and trimmed.");
    }
    if (participant.displayNameKey !== participant.displayName.toLowerCase()) {
      fail("DISPLAY_NAME_KEY_MISMATCH", "Display-name key must be deterministic lowercase.");
    }
    if (names.has(participant.displayNameKey)) fail("DUPLICATE_DISPLAY_NAME", "Display names must be case-insensitively unique.");
    timestamp(participant.firstJoinedAtMs, "firstJoinedAtMs");
    timestamp(participant.membershipChangedAtMs, "membershipChangedAtMs");
    if (
      participant.firstJoinedAtMs < state.genesis.createdAtMs
      || participant.membershipChangedAtMs < participant.firstJoinedAtMs
      || participant.membershipChangedAtMs > state.lastAcceptedAtMs
    ) fail("INVALID_MEMBERSHIP_TIME", "Participant membership timestamps are inconsistent.");
    if (participant.role === "HOST") {
      hosts += 1;
      if (participant.membershipStatus !== "JOINED") fail("HOST_LEFT", "Host must remain joined.");
      if (participant.participantId !== state.genesis.host.participantId) fail("HOST_ID_MISMATCH", "Host differs from genesis.");
      if (participant.displayName !== state.genesis.host.displayName) fail("HOST_NAME_MISMATCH", "Host name differs from genesis.");
    }
    if (participant.membershipStatus === "JOINED") joined += 1;
    ids.add(participant.participantId);
    names.add(participant.displayNameKey);
  }
  if (hosts !== 1) fail("INVALID_HOST_COUNT", "Competition requires exactly one host.");
  if (joined > 8) fail("PARTICIPANT_LIMIT", "Competition has more than eight joined participants.");
}

function validateRounds(catalog: EraDraftCatalog, state: DraftOffCompetitionState): void {
  if (state.rounds.length < 1) fail("MISSING_ROUND", "Competition requires at least one round.");
  const ids = new Set<string>();
  const ordinals = new Set<number>();
  let drafting = 0;
  for (const [index, round] of state.rounds.entries()) {
    if (!isValidId(round.roundId) || !Number.isInteger(round.roundOrdinal) || round.roundOrdinal < 1) {
      fail("INVALID_ROUND_IDENTITY", "Round requires a valid ID and positive ordinal.");
    }
    if (ids.has(round.roundId) || ordinals.has(round.roundOrdinal)) fail("DUPLICATE_ROUND", "Round IDs and ordinals must be unique.");
    if (index > 0 && state.rounds[index - 1]!.roundOrdinal >= round.roundOrdinal) {
      fail("UNSORTED_ROUNDS", "Rounds must be ordered by ordinal.");
    }
    if (!round.label || round.label !== round.label.trim() || !catalog.getEra(round.eraId) || !round.challengeSeed) {
      fail("INVALID_ROUND_CONFIG", "Round configuration is invalid.");
    }
    ids.add(round.roundId);
    ordinals.add(round.roundOrdinal);
    if (round.phase === "DRAFTING") drafting += 1;
    if (round.phase !== "PENDING") validateStartedRound(catalog, state, round);
  }
  const initial = state.rounds.find((round) => round.roundId === state.genesis.initialRound.roundId);
  if (!initial || canonicalJson({
    roundId: initial.roundId,
    roundOrdinal: initial.roundOrdinal,
    label: initial.label,
    eraId: initial.eraId,
    challengeSeed: initial.challengeSeed,
  }) !== canonicalJson(state.genesis.initialRound)) {
    fail("INITIAL_ROUND_MISMATCH", "Initial round differs from genesis.");
  }
  if (drafting > 1) fail("MULTIPLE_ACTIVE_ROUNDS", "Only one round may be drafting at a time.");
  if (state.phase === "LOBBY" && state.rounds.some((round) => round.phase !== "PENDING")) {
    fail("LOBBY_ROUND_MISMATCH", "Lobby competition may only contain pending rounds.");
  }
  if (state.phase === "IN_PROGRESS" && drafting !== 1) fail("ACTIVE_ROUND_MISMATCH", "In-progress competition requires one drafting round.");
  if (state.phase === "COMPLETE" && state.rounds.some((round) => round.phase !== "RESOLVED")) {
    fail("COMPLETE_ROUND_MISMATCH", "Complete competition requires all declared rounds to be resolved.");
  }
}

function validateStartedRound(
  catalog: EraDraftCatalog,
  state: DraftOffCompetitionState,
  round: ActiveDraftOffRound | ResolvedDraftOffRound,
): void {
  timestamp(round.startedAtMs, "round.startedAtMs");
  timestamp(round.deadlineAtMs, "round.deadlineAtMs");
  if (round.startedAtMs < state.genesis.createdAtMs || round.deadlineAtMs <= round.startedAtMs) {
    fail("INVALID_ROUND_TIME", "Round start/deadline timestamps are inconsistent.");
  }
  const expectedSeeds = deriveDraftOffSeeds({
    challengeSeed: round.challengeSeed,
    catalogFingerprint: state.catalogFingerprint,
    eraId: round.eraId,
    roundOrdinal: round.roundOrdinal,
  });
  if (canonicalJson(expectedSeeds) !== canonicalJson(round.seeds)) fail("ROUND_SEED_MISMATCH", "Round seeds are not canonical.");
  if (round.rosterParticipantIds.length < 2 || round.rosterParticipantIds.length > 8) {
    fail("INVALID_ROUND_ROSTER", "Round roster must contain two to eight participants.");
  }
  const sortedRoster = [...round.rosterParticipantIds].sort();
  if (canonicalJson(sortedRoster) !== canonicalJson(round.rosterParticipantIds) || new Set(sortedRoster).size !== sortedRoster.length) {
    fail("INVALID_ROUND_ROSTER", "Round roster must be unique and sorted.");
  }
  if (round.participants.length !== round.rosterParticipantIds.length) {
    fail("ROUND_PARTICIPANT_MISMATCH", "Round participant states must match the roster.");
  }
  for (const [index, participant] of round.participants.entries()) {
    if (participant.participantId !== round.rosterParticipantIds[index]) {
      fail("ROUND_PARTICIPANT_MISMATCH", "Round participant ordering differs from roster.");
    }
    if (!state.participants.some((member) =>
      member.participantId === participant.participantId && member.membershipStatus === "JOINED")) {
      fail("UNKNOWN_ROUND_PARTICIPANT", "Round participant is absent from competition registry.");
    }
    validateRoundParticipant(catalog, state, round, participant);
  }
  if (round.phase === "RESOLVED") validateResolution(state, round);
}

function validateRoundParticipant(
  catalog: EraDraftCatalog,
  state: DraftOffCompetitionState,
  round: ActiveDraftOffRound | ResolvedDraftOffRound,
  participant: DraftOffRoundParticipant,
): void {
  assertEraDraftState(catalog, participant.draftState);
  const draftPhase = (participant.draftState as { readonly phase: string }).phase;
  if (
    draftPhase === "SETUP"
    || draftPhase === "REVEALED"
    || draftPhase === "GAME_COMPLETE"
    || participant.draftState.eraId !== round.eraId
    || participant.draftState.rootSeed !== round.seeds.draftRootSeed
  ) fail("INVALID_PRIVATE_DRAFT", "Round participant has an invalid private Era Draft state.");
  if (participant.status === "SUBMITTED") {
    if (participant.draftState.phase !== "XI_COMPLETE" || participant.submission.xi !== participant.draftState) {
      fail("INVALID_SUBMISSION_STATE", "Submission must retain the participant's complete XI state.");
    }
    if (
      participant.submission.version !== DRAFT_OFF_SUBMISSION_VERSION
      || participant.submission.participantId !== participant.participantId
      || participant.submission.draftStateHash !== canonicalEraDraftStateHash(participant.draftState)
      || participant.submission.submissionHash !== deriveDraftOffSubmissionHash({
        catalogFingerprint: state.catalogFingerprint,
        eraId: round.eraId,
        xi: participant.draftState,
      })
    ) fail("SUBMISSION_HASH_MISMATCH", "Submitted XI hashes are invalid.");
    timestamp(participant.submission.submittedAtMs, "submission.submittedAtMs");
    if (participant.submission.submittedAtMs < round.startedAtMs || participant.submission.submittedAtMs > round.deadlineAtMs) {
      fail("INVALID_SUBMISSION_TIME", "Submission timestamp lies outside the round window.");
    }
    if (
      (participant.submission.source === "MANUAL" && participant.submission.submittedAtMs >= round.deadlineAtMs)
      || (participant.submission.source === "DEADLINE_AUTO" && participant.submission.submittedAtMs !== round.deadlineAtMs)
    ) fail("INVALID_SUBMISSION_SOURCE_TIME", "Submission source disagrees with its effective timestamp.");
  }
  if (participant.status === "INELIGIBLE" && draftPhase === "XI_COMPLETE") {
    fail("COMPLETE_XI_INELIGIBLE", "A complete XI must auto-submit at the deadline.");
  }
}

function validateResolution(state: DraftOffCompetitionState, round: ResolvedDraftOffRound): void {
  const resolution = round.resolution;
  if (resolution.version !== DRAFT_OFF_ROUND_RESOLUTION_VERSION) fail("RESOLUTION_VERSION_MISMATCH", "Unsupported resolution version.");
  timestamp(resolution.resolvedAtMs, "resolution.resolvedAtMs");
  const eligible = round.participants.filter((participant) => participant.status === "SUBMITTED").map((participant) => participant.participantId);
  const ineligible = round.participants.filter((participant) => participant.status === "INELIGIBLE").map((participant) => participant.participantId);
  if (
    canonicalJson(eligible) !== canonicalJson(resolution.eligibleParticipantIds)
    || canonicalJson(ineligible) !== canonicalJson(resolution.ineligibleParticipantIds)
  ) fail("RESOLUTION_PARTICIPANT_MISMATCH", "Resolution eligibility differs from participant states.");
  const expectedStatus = eligible.length >= 2 ? "CONTESTED" : eligible.length === 1 ? "UNCONTESTED" : "NO_CONTEST";
  if (resolution.contestStatus !== expectedStatus) fail("CONTEST_STATUS_MISMATCH", "Resolution contest status is invalid.");
  if (
    (resolution.trigger === "ALL_SUBMITTED"
      && (ineligible.length !== 0 || eligible.length !== round.participants.length || resolution.resolvedAtMs >= round.deadlineAtMs))
    || (resolution.trigger === "DEADLINE" && resolution.resolvedAtMs < round.deadlineAtMs)
  ) fail("RESOLUTION_TRIGGER_MISMATCH", "Resolution trigger is inconsistent with deadline and participant states.");
  if (eligible.length === 0) {
    if (resolution.challengeResult !== null || resolution.leaderboard.length !== 0) {
      fail("NO_CONTEST_RESULT_MISMATCH", "No-contest resolution must have no challenge result or leaderboard.");
    }
  } else {
    const result = resolution.challengeResult;
    if (
      !result
      || result.eraId !== round.eraId
      || result.roundOrdinal !== round.roundOrdinal
      || result.catalogFingerprint !== state.catalogFingerprint
      || canonicalJson(result.seeds) !== canonicalJson(round.seeds)
      || canonicalJson(result.leaderboard) !== canonicalJson(resolution.leaderboard)
      || canonicalJson(result.campaigns.map((campaign) => campaign.participantId)) !== canonicalJson(eligible)
    ) fail("CHALLENGE_RESULT_MISMATCH", "Challenge result does not match the resolved round.");
    const { resultHash, ...resultBody } = result;
    if (resultHash !== canonicalSha256(resultBody)) fail("CHALLENGE_RESULT_HASH_MISMATCH", "Challenge result hash is invalid.");
    for (const campaign of result.campaigns) {
      const participant = round.participants.find((item) => item.participantId === campaign.participantId);
      if (participant?.status !== "SUBMITTED" || participant.submission.submissionHash !== campaign.submissionHash) {
        fail("CAMPAIGN_SUBMISSION_MISMATCH", "Campaign does not link to its immutable submission.");
      }
    }
  }
  const body = {
    version: resolution.version,
    trigger: resolution.trigger,
    contestStatus: resolution.contestStatus,
    resolvedAtMs: resolution.resolvedAtMs,
    eligibleParticipantIds: resolution.eligibleParticipantIds,
    ineligibleParticipantIds: resolution.ineligibleParticipantIds,
    challengeResult: resolution.challengeResult,
    leaderboard: resolution.leaderboard,
  };
  if (resolution.resolutionHash !== canonicalSha256(body)) fail("RESOLUTION_HASH_MISMATCH", "Resolution hash is invalid.");
}

function timestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) fail("INVALID_TIMESTAMP", `${label} must be a non-negative safe integer.`);
}

function isValidId(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

function fail(code: string, message: string): never {
  throw new DraftOffCompetitionInvariantError(code, message);
}
