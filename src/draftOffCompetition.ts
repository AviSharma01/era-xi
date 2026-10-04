import { canonicalSha256 } from "./eraDraftCanonical.js";
import type { EraDraftCatalog } from "./eraDraftData.js";
import { createEraDraftGame, reduceEraDraft } from "./eraDraftEngine.js";
import { assertEraDraftState } from "./eraDraftInvariants.js";
import { canonicalEraDraftStateHash } from "./eraDraftPersistence.js";
import {
  deriveDraftOffSeeds,
  deriveDraftOffSubmissionHash,
  simulateDraftOffChallenge,
  simulateDraftOffEntries,
} from "./draftOffSimulation.js";
import {
  DRAFT_OFF_COMPETITION_ENGINE_VERSION,
  DRAFT_OFF_COMPETITION_STATE_SCHEMA_VERSION,
  DRAFT_OFF_ROUND_RESOLUTION_VERSION,
  DRAFT_OFF_SUBMISSION_VERSION,
  DraftOffCompetitionInvariantError,
  type ActiveDraftOffRound,
  type ApplyDraftCommand,
  type DraftOffCompetitionCommand,
  type DraftOffCompetitionCommandRejection,
  type DraftOffCompetitionGenesis,
  type DraftOffCompetitionHistoryEntry,
  type DraftOffCompetitionParticipant,
  type DraftOffCompetitionState,
  type DraftOffCompetitionTransitionResult,
  type DraftOffPrivateDraftState,
  type DraftOffRoundParticipant,
  type DraftOffRoundResolution,
  type DraftOffSubmission,
  type FinalizeRoundCommand,
  type JoinCompetitionCommand,
  type LeaveCompetitionCommand,
  type ResolvedDraftOffRound,
  type StartRoundCommand,
  type SubmitXiCommand,
} from "./draftOffCompetitionTypes.js";
import { assertDraftOffCompetitionState } from "./draftOffCompetitionInvariants.js";
import type { XiCompleteState } from "./eraDraftTypes.js";

export function createDraftOffCompetition(
  catalog: EraDraftCatalog,
  input: DraftOffCompetitionGenesis,
): DraftOffCompetitionState {
  requireId(input.competitionId, "competitionId");
  requireTimestamp(input.createdAtMs, "createdAtMs");
  requireId(input.host.participantId, "host participantId");
  requireId(input.initialRound.roundId, "roundId");
  if (!Number.isInteger(input.initialRound.roundOrdinal) || input.initialRound.roundOrdinal < 1) {
    throw new DraftOffCompetitionInvariantError("INVALID_ROUND_ORDINAL", "Round ordinal must be a positive integer.");
  }
  if (!catalog.getEra(input.initialRound.eraId)) {
    throw new DraftOffCompetitionInvariantError("UNKNOWN_ERA", `Unknown era ${input.initialRound.eraId}.`);
  }
  if (!input.initialRound.challengeSeed) {
    throw new DraftOffCompetitionInvariantError("INVALID_CHALLENGE_SEED", "Round challenge seed must be non-empty.");
  }
  const displayName = normalizeDisplayName(input.host.displayName);
  const label = input.initialRound.label.trim();
  if (!label) throw new DraftOffCompetitionInvariantError("INVALID_ROUND_LABEL", "Round label must be non-empty.");
  if (input.catalogFingerprint !== catalog.fingerprint) {
    throw new DraftOffCompetitionInvariantError(
      "CATALOG_FINGERPRINT_MISMATCH",
      "Competition genesis belongs to a different catalog.",
    );
  }
  const genesis = freezeDeep({
    ...input,
    host: { ...input.host, displayName },
    initialRound: { ...input.initialRound, label },
  });
  const state = freezeDeep({
    engineVersion: DRAFT_OFF_COMPETITION_ENGINE_VERSION,
    schemaVersion: DRAFT_OFF_COMPETITION_STATE_SCHEMA_VERSION,
    catalogFingerprint: catalog.fingerprint,
    competitionId: input.competitionId,
    phase: "LOBBY",
    revision: 0,
    lastAcceptedAtMs: input.createdAtMs,
    genesis,
    participants: [{
      participantId: input.host.participantId,
      role: "HOST",
      displayName,
      displayNameKey: displayName.toLowerCase(),
      membershipStatus: "JOINED",
      firstJoinedAtMs: input.createdAtMs,
      membershipChangedAtMs: input.createdAtMs,
    }],
    rounds: [{ ...genesis.initialRound, phase: "PENDING" }],
    history: [],
  } satisfies DraftOffCompetitionState);
  assertDraftOffCompetitionState(catalog, state);
  return state;
}

export function reduceDraftOffCompetition(
  catalog: EraDraftCatalog,
  state: DraftOffCompetitionState,
  command: DraftOffCompetitionCommand,
): DraftOffCompetitionTransitionResult {
  assertDraftOffCompetitionState(catalog, state);
  const timeError = validateCommandTime(state, command);
  if (timeError) return rejected(state, command, timeError.code, timeError.message);
  switch (command.type) {
    case "JOIN_COMPETITION": return joinCompetition(catalog, state, command);
    case "LEAVE_COMPETITION": return leaveCompetition(catalog, state, command);
    case "START_ROUND": return startRound(catalog, state, command);
    case "APPLY_DRAFT_COMMAND": return applyDraftCommand(catalog, state, command);
    case "SUBMIT_XI": return submitXi(catalog, state, command);
    case "FINALIZE_ROUND": return finalizeRound(catalog, state, command);
  }
}

function joinCompetition(
  catalog: EraDraftCatalog,
  state: DraftOffCompetitionState,
  command: JoinCompetitionCommand,
): DraftOffCompetitionTransitionResult {
  if (state.phase !== "LOBBY") return rejected(state, command, "INVALID_PHASE", "Participants may only join in the lobby.");
  if (!isValidId(command.participantId)) {
    return rejected(state, command, "INVALID_PARTICIPANT_ID", "Participant ID must be a non-empty trimmed string.");
  }
  const existing = state.participants.find((participant) => participant.participantId === command.participantId);
  if (existing) {
    if (command.displayName !== undefined) {
      let supplied: string;
      try {
        supplied = normalizeDisplayName(command.displayName);
      } catch {
        return rejected(state, command, "INVALID_DISPLAY_NAME", "Display name must be non-empty after trimming.");
      }
      if (supplied !== existing.displayName) {
        return rejected(state, command, "PARTICIPANT_ID_CONFLICT", "A known participant ID cannot change its display name.");
      }
    }
    if (existing.membershipStatus === "JOINED") return unchanged(state);
    if (joinedParticipants(state).length >= 8) {
      return rejected(state, command, "PARTICIPANT_LIMIT", "Draft-Off supports at most eight joined participants.");
    }
    const participants = state.participants.map((participant) => participant.participantId === command.participantId
      ? { ...participant, membershipStatus: "JOINED" as const, membershipChangedAtMs: command.atMs }
      : participant);
    const acceptedCommand = command.displayName === undefined
      ? command
      : { ...command, displayName: existing.displayName };
    return commit(catalog, state, acceptedCommand, { ...state, participants: sortParticipants(participants) });
  }
  if (command.displayName === undefined) {
    return rejected(state, command, "INVALID_DISPLAY_NAME", "A new participant requires a display name.");
  }
  let displayName: string;
  try {
    displayName = normalizeDisplayName(command.displayName);
  } catch {
    return rejected(state, command, "INVALID_DISPLAY_NAME", "Display name must be non-empty after trimming.");
  }
  const displayNameKey = displayName.toLowerCase();
  if (state.participants.some((participant) => participant.displayNameKey === displayNameKey)) {
    return rejected(state, command, "DISPLAY_NAME_RESERVED", "Display name is already reserved in this competition.");
  }
  if (joinedParticipants(state).length >= 8) {
    return rejected(state, command, "PARTICIPANT_LIMIT", "Draft-Off supports at most eight joined participants.");
  }
  const participant: DraftOffCompetitionParticipant = {
    participantId: command.participantId,
    role: "MEMBER",
    displayName,
    displayNameKey,
    membershipStatus: "JOINED",
    firstJoinedAtMs: command.atMs,
    membershipChangedAtMs: command.atMs,
  };
  return commit(catalog, state, { ...command, displayName }, {
    ...state,
    participants: sortParticipants([...state.participants, participant]),
  });
}

function leaveCompetition(
  catalog: EraDraftCatalog,
  state: DraftOffCompetitionState,
  command: LeaveCompetitionCommand,
): DraftOffCompetitionTransitionResult {
  if (state.phase !== "LOBBY") return rejected(state, command, "INVALID_PHASE", "Participants may only leave in the lobby.");
  const participant = state.participants.find((item) => item.participantId === command.participantId);
  if (!participant) return rejected(state, command, "PARTICIPANT_NOT_FOUND", "Participant is not registered in this competition.");
  if (participant.role === "HOST") return rejected(state, command, "HOST_CANNOT_LEAVE", "The host cannot leave the competition.");
  if (participant.membershipStatus === "LEFT") return unchanged(state);
  const participants = state.participants.map((item) => item.participantId === command.participantId
    ? { ...item, membershipStatus: "LEFT" as const, membershipChangedAtMs: command.atMs }
    : item);
  return commit(catalog, state, command, { ...state, participants: sortParticipants(participants) });
}

function startRound(
  catalog: EraDraftCatalog,
  state: DraftOffCompetitionState,
  command: StartRoundCommand,
): DraftOffCompetitionTransitionResult {
  if (state.phase !== "LOBBY") return rejected(state, command, "INVALID_PHASE", "The round can only start from the lobby.");
  const host = state.participants.find((participant) => participant.role === "HOST");
  if (host?.participantId !== command.actorParticipantId) {
    return rejected(state, command, "NOT_HOST", "Only the competition host may start the round.");
  }
  const round = state.rounds.find((candidate) => candidate.roundId === command.roundId);
  if (!round) return rejected(state, command, "ROUND_NOT_FOUND", "Round does not belong to this competition.");
  if (round.phase !== "PENDING") return rejected(state, command, "INVALID_PHASE", "Only a pending round may start.");
  const roster = joinedParticipants(state);
  if (roster.length < 2 || roster.length > 8) {
    return rejected(state, command, "PARTICIPANT_LIMIT", "Starting Draft-Off requires between two and eight joined participants.");
  }
  if (!Number.isSafeInteger(command.deadlineAtMs) || command.deadlineAtMs <= command.atMs) {
    return rejected(state, command, "INVALID_DEADLINE", "Round deadline must be a safe-integer timestamp after its start.");
  }
  const seeds = deriveDraftOffSeeds({
    challengeSeed: round.challengeSeed,
    catalogFingerprint: state.catalogFingerprint,
    eraId: round.eraId,
    roundOrdinal: round.roundOrdinal,
  });
  const participants = roster.map((member): DraftOffRoundParticipant => {
    const setup = createEraDraftGame({ catalog, rootSeed: seeds.draftRootSeed });
    const chosen = reduceEraDraft(catalog, setup, { type: "CHOOSE_ERA", eraId: round.eraId });
    if (!chosen.ok || chosen.state.phase !== "AWAITING_SPIN") {
      throw new DraftOffCompetitionInvariantError("ROUND_INITIALIZATION_FAILED", "Shared Era Draft initialization failed.");
    }
    return { participantId: member.participantId, status: "DRAFTING", draftState: chosen.state };
  });
  const activeRound: ActiveDraftOffRound = {
    ...round,
    phase: "DRAFTING",
    seeds,
    startedAtMs: command.atMs,
    deadlineAtMs: command.deadlineAtMs,
    rosterParticipantIds: roster.map((participant) => participant.participantId),
    participants,
  };
  return commit(catalog, state, command, {
    ...state,
    phase: "IN_PROGRESS",
    rounds: replaceRound(state, activeRound),
  });
}

function applyDraftCommand(
  catalog: EraDraftCatalog,
  state: DraftOffCompetitionState,
  command: ApplyDraftCommand,
): DraftOffCompetitionTransitionResult {
  const round = activeRound(state);
  if (state.phase !== "IN_PROGRESS" || !round) {
    return rejected(state, command, "INVALID_PHASE", "Draft commands require an active drafting round.");
  }
  const cutoff = validateDraftWindow(state, command, round);
  if (cutoff) return cutoff;
  const participant = round.participants.find((item) => item.participantId === command.participantId);
  if (!participant) return rejected(state, command, "PARTICIPANT_NOT_JOINED", "Participant is not in the round roster.");
  if (participant.status !== "DRAFTING") {
    return rejected(state, command, "PARTICIPANT_FINALIZED", "A submitted or ineligible participant cannot modify their XI.");
  }
  if (participant.draftState.revision !== command.expectedDraftRevision) {
    return rejected(state, command, "STALE_DRAFT_REVISION", "Draft revision does not match the authoritative participant state.");
  }
  const reduced = reduceEraDraft(catalog, participant.draftState, command.draftCommand);
  if (!reduced.ok) {
    return {
      ok: false,
      state,
      error: freezeDeep({
        kind: "COMMAND_REJECTED",
        code: "ERA_DRAFT_COMMAND_REJECTED",
        message: reduced.error.message,
        command: command.type,
        competitionPhase: state.phase,
        eraDraftError: reduced.error,
      }),
    };
  }
  if (reduced.state.phase === "SETUP" || reduced.state.phase === "REVEALED" || reduced.state.phase === "GAME_COMPLETE") {
    throw new DraftOffCompetitionInvariantError("INVALID_PRIVATE_DRAFT_PHASE", "Competition draft command escaped private draft phases.");
  }
  const nextDraftState = reduced.state as DraftOffPrivateDraftState;
  const participants = round.participants.map((item) => item.participantId === command.participantId
    ? { participantId: item.participantId, status: "DRAFTING" as const, draftState: nextDraftState }
    : item);
  return commit(catalog, state, command, {
    ...state,
    rounds: replaceRound(state, { ...round, participants }),
  });
}

function submitXi(
  catalog: EraDraftCatalog,
  state: DraftOffCompetitionState,
  command: SubmitXiCommand,
): DraftOffCompetitionTransitionResult {
  const round = currentRound(state);
  const existing = round && round.phase !== "PENDING"
    ? round.participants.find((item) => item.participantId === command.participantId)
    : undefined;
  if (existing?.status === "SUBMITTED") return unchanged(state);
  if (state.phase !== "IN_PROGRESS" || !round || round.phase !== "DRAFTING") {
    return rejected(state, command, "INVALID_PHASE", "XI submission requires an active drafting round.");
  }
  const cutoff = validateDraftWindow(state, command, round);
  if (cutoff) return cutoff;
  if (!existing) return rejected(state, command, "PARTICIPANT_NOT_JOINED", "Participant is not in the round roster.");
  if (existing.status !== "DRAFTING") {
    return rejected(state, command, "PARTICIPANT_FINALIZED", "Participant has already been finalized.");
  }
  if (existing.draftState.revision !== command.expectedDraftRevision) {
    return rejected(state, command, "STALE_DRAFT_REVISION", "Draft revision does not match the authoritative participant state.");
  }
  if (existing.draftState.phase !== "XI_COMPLETE") {
    return rejected(state, command, "INCOMPLETE_XI", "Only a complete legal XI may be submitted.");
  }
  const xi = existing.draftState;
  assertEraDraftState(catalog, xi);
  const submission = createSubmission(state, round, existing.participantId, xi, "MANUAL", command.atMs);
  const participants = round.participants.map((item): DraftOffRoundParticipant => item.participantId === command.participantId
    ? { participantId: item.participantId, status: "SUBMITTED", draftState: xi, submission }
    : item);
  if (participants.every((participant) => participant.status === "SUBMITTED")) {
    const resolved = resolveRound(catalog, state, { ...round, participants }, "ALL_SUBMITTED", command.atMs);
    return commit(catalog, state, command, {
      ...state,
      phase: "COMPLETE",
      rounds: replaceRound(state, resolved),
    });
  }
  return commit(catalog, state, command, {
    ...state,
    rounds: replaceRound(state, { ...round, participants }),
  });
}

function finalizeRound(
  catalog: EraDraftCatalog,
  state: DraftOffCompetitionState,
  command: FinalizeRoundCommand,
): DraftOffCompetitionTransitionResult {
  const round = state.rounds.find((candidate) => candidate.roundId === command.roundId);
  if (!round) return rejected(state, command, "ROUND_NOT_FOUND", "Round does not belong to this competition.");
  if (round.phase === "RESOLVED") return unchanged(state);
  if (state.phase !== "IN_PROGRESS" || round.phase !== "DRAFTING") {
    return rejected(state, command, "INVALID_PHASE", "Only an active drafting round can be finalized.");
  }
  if (command.atMs < round.deadlineAtMs) {
    return rejected(state, command, "DEADLINE_NOT_REACHED", "Round cannot finalize before its deadline.");
  }
  const participants = round.participants.map((participant): DraftOffRoundParticipant => {
    if (participant.status !== "DRAFTING") return participant;
    if (participant.draftState.phase === "XI_COMPLETE") {
      assertEraDraftState(catalog, participant.draftState);
      const submission = createSubmission(
        state,
        round,
        participant.participantId,
        participant.draftState,
        "DEADLINE_AUTO",
        round.deadlineAtMs,
      );
      return { participantId: participant.participantId, status: "SUBMITTED", draftState: participant.draftState, submission };
    }
    return {
      participantId: participant.participantId,
      status: "INELIGIBLE",
      draftState: participant.draftState,
      reason: "INCOMPLETE_AT_DEADLINE",
    };
  });
  const resolved = resolveRound(catalog, state, { ...round, participants }, "DEADLINE", command.atMs);
  return commit(catalog, state, command, {
    ...state,
    phase: "COMPLETE",
    rounds: replaceRound(state, resolved),
  });
}

function resolveRound(
  catalog: EraDraftCatalog,
  state: DraftOffCompetitionState,
  round: ActiveDraftOffRound,
  trigger: DraftOffRoundResolution["trigger"],
  resolvedAtMs: number,
): ResolvedDraftOffRound {
  const submitted = round.participants
    .filter((participant): participant is Extract<DraftOffRoundParticipant, { status: "SUBMITTED" }> => participant.status === "SUBMITTED")
    .sort((left, right) => left.participantId.localeCompare(right.participantId));
  const ineligibleParticipantIds = round.participants
    .filter((participant) => participant.status === "INELIGIBLE")
    .map((participant) => participant.participantId)
    .sort();
  const inputs = submitted.map((participant) => {
    const member = state.participants.find((candidate) => candidate.participantId === participant.participantId);
    if (!member) throw new DraftOffCompetitionInvariantError("MISSING_COMPETITION_PARTICIPANT", "Round participant is absent from registry.");
    return { participantId: participant.participantId, displayName: member.displayName, xi: participant.submission.xi };
  });
  const challengeResult = inputs.length === 0
    ? null
    : inputs.length === 1
      ? simulateDraftOffEntries({
          catalog,
          challengeSeed: round.challengeSeed,
          eraId: round.eraId,
          roundOrdinal: round.roundOrdinal,
          participants: inputs,
        })
      : simulateDraftOffChallenge({
          catalog,
          challengeSeed: round.challengeSeed,
          eraId: round.eraId,
          roundOrdinal: round.roundOrdinal,
          participants: inputs,
        });
  const body = {
    version: DRAFT_OFF_ROUND_RESOLUTION_VERSION,
    trigger,
    contestStatus: inputs.length >= 2 ? "CONTESTED" : inputs.length === 1 ? "UNCONTESTED" : "NO_CONTEST",
    resolvedAtMs,
    eligibleParticipantIds: submitted.map((participant) => participant.participantId),
    ineligibleParticipantIds,
    challengeResult,
    leaderboard: challengeResult?.leaderboard ?? [],
  } as const;
  return freezeDeep({
    ...round,
    phase: "RESOLVED",
    resolution: { ...body, resolutionHash: canonicalSha256(body) },
  });
}

function createSubmission(
  state: DraftOffCompetitionState,
  round: ActiveDraftOffRound,
  participantId: string,
  xi: XiCompleteState,
  source: DraftOffSubmission["source"],
  submittedAtMs: number,
): DraftOffSubmission {
  return freezeDeep({
    version: DRAFT_OFF_SUBMISSION_VERSION,
    participantId,
    source,
    submittedAtMs,
    xi,
    draftStateHash: canonicalEraDraftStateHash(xi),
    submissionHash: deriveDraftOffSubmissionHash({
      catalogFingerprint: state.catalogFingerprint,
      eraId: round.eraId,
      xi,
    }),
  });
}

function validateDraftWindow(
  state: DraftOffCompetitionState,
  command: ApplyDraftCommand | SubmitXiCommand,
  round: ActiveDraftOffRound,
): DraftOffCompetitionTransitionResult | undefined {
  if (command.atMs < round.startedAtMs) {
    return rejected(state, command, "STALE_TIMESTAMP", "Draft command predates the round start.");
  }
  if (command.atMs >= round.deadlineAtMs) {
    return rejected(state, command, "DEADLINE_REACHED", "Draft commands are closed at the deadline.");
  }
  return undefined;
}

function validateCommandTime(
  state: DraftOffCompetitionState,
  command: DraftOffCompetitionCommand,
): { code: "INVALID_TIMESTAMP" | "STALE_TIMESTAMP"; message: string } | undefined {
  if (!Number.isSafeInteger(command.atMs) || command.atMs < 0) {
    return { code: "INVALID_TIMESTAMP", message: "Command timestamp must be a non-negative safe integer." };
  }
  if (command.atMs < state.lastAcceptedAtMs) {
    return { code: "STALE_TIMESTAMP", message: "Command timestamp predates the latest accepted transition." };
  }
  return undefined;
}

function commit(
  catalog: EraDraftCatalog,
  previous: DraftOffCompetitionState,
  command: DraftOffCompetitionCommand,
  candidate: Omit<DraftOffCompetitionState, "revision" | "lastAcceptedAtMs" | "history"> &
    Pick<DraftOffCompetitionState, "revision" | "lastAcceptedAtMs" | "history">,
): DraftOffCompetitionTransitionResult {
  const revision = previous.revision + 1;
  const event = freezeDeep({
    revision,
    command: copyCommand(command),
    resultingCompetitionPhase: candidate.phase,
  } satisfies DraftOffCompetitionHistoryEntry);
  const state = freezeDeep({
    ...candidate,
    revision,
    lastAcceptedAtMs: command.atMs,
    history: [...previous.history, event],
  } satisfies DraftOffCompetitionState);
  assertDraftOffCompetitionState(catalog, state);
  return { ok: true, changed: true, state, event };
}

function copyCommand(command: DraftOffCompetitionCommand): DraftOffCompetitionCommand {
  return command.type === "APPLY_DRAFT_COMMAND"
    ? { ...command, draftCommand: { ...command.draftCommand } }
    : { ...command };
}

function currentRound(state: DraftOffCompetitionState) {
  return [...state.rounds].sort((left, right) => right.roundOrdinal - left.roundOrdinal)[0];
}

function activeRound(state: DraftOffCompetitionState): ActiveDraftOffRound | undefined {
  return state.rounds.find((round): round is ActiveDraftOffRound => round.phase === "DRAFTING");
}

function replaceRound(state: DraftOffCompetitionState, round: ActiveDraftOffRound | ResolvedDraftOffRound) {
  return state.rounds
    .map((candidate) => candidate.roundId === round.roundId ? round : candidate)
    .sort((left, right) => left.roundOrdinal - right.roundOrdinal);
}

function joinedParticipants(state: DraftOffCompetitionState): readonly DraftOffCompetitionParticipant[] {
  return state.participants
    .filter((participant) => participant.membershipStatus === "JOINED")
    .sort((left, right) => left.participantId.localeCompare(right.participantId));
}

function sortParticipants(participants: readonly DraftOffCompetitionParticipant[]) {
  return [...participants].sort((left, right) => left.participantId.localeCompare(right.participantId));
}

function normalizeDisplayName(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new DraftOffCompetitionInvariantError("INVALID_DISPLAY_NAME", "Display name must be non-empty after trimming.");
  return normalized;
}

function requireId(value: string, label: string): void {
  if (!isValidId(value)) throw new DraftOffCompetitionInvariantError("INVALID_ID", `${label} must be a non-empty trimmed string.`);
}

function isValidId(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

function requireTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DraftOffCompetitionInvariantError("INVALID_TIMESTAMP", `${label} must be a non-negative safe integer.`);
  }
}

function unchanged(state: DraftOffCompetitionState): DraftOffCompetitionTransitionResult {
  return { ok: true, changed: false, state };
}

function rejected(
  state: DraftOffCompetitionState,
  command: DraftOffCompetitionCommand,
  code: DraftOffCompetitionCommandRejection["code"],
  message: string,
  context?: Readonly<Record<string, unknown>>,
): DraftOffCompetitionTransitionResult {
  return {
    ok: false,
    state,
    error: freezeDeep({
      kind: "COMMAND_REJECTED",
      code,
      message,
      command: command.type,
      competitionPhase: state.phase,
      ...(context ? { context } : {}),
    }),
  };
}

function freezeDeep<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) value.forEach(freezeDeep);
  else Object.values(value as Record<string, unknown>).forEach(freezeDeep);
  return Object.freeze(value);
}
