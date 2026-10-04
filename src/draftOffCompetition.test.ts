import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson } from "./eraDraftCanonical.js";
import { loadEraDraftCatalog } from "./eraDraftData.js";
import { evaluateSelectionLegality, getOpenBattingPositions } from "./eraDraftLegality.js";
import { createDraftOffCompetition, reduceDraftOffCompetition } from "./draftOffCompetition.js";
import type {
  DraftOffCompetitionCommand,
  DraftOffCompetitionState,
  DraftOffRoundParticipant,
} from "./draftOffCompetitionTypes.js";

const catalog = loadEraDraftCatalog();

test("lobby trims and reserves case-insensitive names across leave and rejoin", () => {
  let state = competition("name-rules", "  Host Name  ", 0);
  assert.equal(state.participants[0]!.displayName, "Host Name");
  assert.equal(state.participants[0]!.displayNameKey, "host name");
  const blank = reduceDraftOffCompetition(catalog, state, {
    type: "JOIN_COMPETITION", participantId: "blank", displayName: "   ", atMs: 1,
  });
  assert.equal(blank.ok, false);
  if (!blank.ok) assert.equal(blank.error.code, "INVALID_DISPLAY_NAME");

  state = changed(state, { type: "JOIN_COMPETITION", participantId: "member-a", displayName: "  Alpha  ", atMs: 1 });
  const duplicate = reduceDraftOffCompetition(catalog, state, {
    type: "JOIN_COMPETITION", participantId: "member-b", displayName: "alpha", atMs: 2,
  });
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(duplicate.error.code, "DISPLAY_NAME_RESERVED");

  state = changed(state, { type: "LEAVE_COMPETITION", participantId: "member-a", atMs: 2 });
  const reserved = reduceDraftOffCompetition(catalog, state, {
    type: "JOIN_COMPETITION", participantId: "member-b", displayName: "ALPHA", atMs: 3,
  });
  assert.equal(reserved.ok, false);
  if (!reserved.ok) assert.equal(reserved.error.code, "DISPLAY_NAME_RESERVED");

  state = changed(state, { type: "JOIN_COMPETITION", participantId: "member-a", atMs: 3 });
  assert.equal(member(state, "member-a").membershipStatus, "JOINED");
  assert.equal(member(state, "member-a").displayName, "Alpha");
  const duplicateRejoin = reduceDraftOffCompetition(catalog, state, {
    type: "JOIN_COMPETITION", participantId: "member-a", atMs: 3,
  });
  assert.equal(duplicateRejoin.ok, true);
  if (duplicateRejoin.ok) assert.equal(duplicateRejoin.changed, false);

  const renamed = reduceDraftOffCompetition(catalog, state, {
    type: "JOIN_COMPETITION", participantId: "member-a", displayName: "Alpha 2", atMs: 4,
  });
  assert.equal(renamed.ok, false);
  if (!renamed.ok) assert.equal(renamed.error.code, "PARTICIPANT_ID_CONFLICT");
  const hostLeave = reduceDraftOffCompetition(catalog, state, {
    type: "LEAVE_COMPETITION", participantId: "host", atMs: 4,
  });
  assert.equal(hostLeave.ok, false);
  if (!hostLeave.ok) assert.equal(hostLeave.error.code, "HOST_CANNOT_LEAVE");
});

test("lobby enforces the active capacity while left members retain their identities", () => {
  let state = competition("capacity", "Host", 0);
  for (let index = 1; index <= 7; index += 1) {
    state = changed(state, {
      type: "JOIN_COMPETITION",
      participantId: `member-${index}`,
      displayName: `Member ${index}`,
      atMs: index,
    });
  }
  const ninth = reduceDraftOffCompetition(catalog, state, {
    type: "JOIN_COMPETITION", participantId: "member-8", displayName: "Member 8", atMs: 8,
  });
  assert.equal(ninth.ok, false);
  if (!ninth.ok) assert.equal(ninth.error.code, "PARTICIPANT_LIMIT");
  state = changed(state, { type: "LEAVE_COMPETITION", participantId: "member-7", atMs: 8 });
  state = changed(state, { type: "JOIN_COMPETITION", participantId: "member-8", displayName: "Member 8", atMs: 9 });
  const blockedRejoin = reduceDraftOffCompetition(catalog, state, {
    type: "JOIN_COMPETITION", participantId: "member-7", atMs: 10,
  });
  assert.equal(blockedRejoin.ok, false);
  if (!blockedRejoin.ok) assert.equal(blockedRejoin.error.code, "PARTICIPANT_LIMIT");
});

test("round start locks 2-8 participants into independent private drafts with one shared root seed", () => {
  const state = startedCompetition("shared-seed", 10, 1000);
  assert.equal(state.phase, "IN_PROGRESS");
  const round = draftingRound(state);
  assert.equal(round.participants.length, 2);
  assert.equal(round.participants[0]!.status, "DRAFTING");
  assert.equal(round.participants[1]!.status, "DRAFTING");
  const first = round.participants[0]!.draftState;
  const second = round.participants[1]!.draftState;
  assert.notEqual(first, second);
  assert.equal(first.rootSeed, round.seeds.draftRootSeed);
  assert.equal(second.rootSeed, round.seeds.draftRootSeed);
  assert.equal(canonicalJson(first), canonicalJson(second));

  const lateJoin = reduceDraftOffCompetition(catalog, state, {
    type: "JOIN_COMPETITION", participantId: "late", displayName: "Late", atMs: 11,
  });
  assert.equal(lateJoin.ok, false);
  if (!lateJoin.ok) assert.equal(lateJoin.error.code, "INVALID_PHASE");
});

test("draft commands delegate to Era Draft, enforce revisions, and stop exactly at the deadline", () => {
  let state = startedCompetition("delegation", 10, 100);
  const initial = roundParticipant(state, "host");
  const stale = reduceDraftOffCompetition(catalog, state, {
    type: "APPLY_DRAFT_COMMAND",
    participantId: "host",
    expectedDraftRevision: initial.draftState.revision + 1,
    draftCommand: { type: "SPIN" },
    atMs: 20,
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.error.code, "STALE_DRAFT_REVISION");

  state = changed(state, {
    type: "APPLY_DRAFT_COMMAND",
    participantId: "host",
    expectedDraftRevision: initial.draftState.revision,
    draftCommand: { type: "SPIN" },
    atMs: 20,
  });
  assert.equal(roundParticipant(state, "host").draftState.phase, "AWAITING_PICK");
  assert.equal(roundParticipant(state, "member").draftState.phase, "AWAITING_SPIN");

  const atDeadline = reduceDraftOffCompetition(catalog, state, {
    type: "APPLY_DRAFT_COMMAND",
    participantId: "member",
    expectedDraftRevision: roundParticipant(state, "member").draftState.revision,
    draftCommand: { type: "SPIN" },
    atMs: 100,
  });
  assert.equal(atDeadline.ok, false);
  if (!atDeadline.ok) assert.equal(atDeadline.error.code, "DEADLINE_REACHED");
});

test("all manual submissions resolve early and submitted XIs cannot be modified", () => {
  let state = startedCompetition("manual-resolution", 10, 1000);
  state = completeXi(state, "host", 20);
  state = completeXi(state, "member", 20);
  state = changed(state, {
    type: "SUBMIT_XI",
    participantId: "host",
    expectedDraftRevision: roundParticipant(state, "host").draftState.revision,
    atMs: 30,
  });
  assert.equal(state.phase, "IN_PROGRESS");
  const mutation = reduceDraftOffCompetition(catalog, state, {
    type: "APPLY_DRAFT_COMMAND",
    participantId: "host",
    expectedDraftRevision: roundParticipant(state, "host").draftState.revision,
    draftCommand: { type: "SPIN" },
    atMs: 31,
  });
  assert.equal(mutation.ok, false);
  if (!mutation.ok) assert.equal(mutation.error.code, "PARTICIPANT_FINALIZED");

  state = changed(state, {
    type: "SUBMIT_XI",
    participantId: "member",
    expectedDraftRevision: roundParticipant(state, "member").draftState.revision,
    atMs: 31,
  });
  assert.equal(state.phase, "COMPLETE");
  const round = resolvedRound(state);
  assert.equal(round.resolution.trigger, "ALL_SUBMITTED");
  assert.equal(round.resolution.contestStatus, "CONTESTED");
  assert.equal(round.resolution.challengeResult?.campaigns.length, 2);
  assert.ok(Object.isFrozen(round.resolution));
  assert.ok(Object.isFrozen(round.participants[0]));
  const repeat = reduceDraftOffCompetition(catalog, state, {
    type: "SUBMIT_XI",
    participantId: "member",
    expectedDraftRevision: roundParticipant(state, "member").draftState.revision,
    atMs: 32,
  });
  assert.equal(repeat.ok, true);
  assert.equal(repeat.changed, false);
});

test("deadline resolves one complete XI as uncontested and repeated finalization is idempotent", () => {
  let state = startedCompetition("uncontested", 10, 100);
  state = completeXi(state, "host", 20);
  state = changed(state, { type: "FINALIZE_ROUND", roundId: "round-1", atMs: 100 });
  const round = resolvedRound(state);
  assert.equal(round.resolution.contestStatus, "UNCONTESTED");
  assert.deepEqual(round.resolution.eligibleParticipantIds, ["host"]);
  assert.deepEqual(round.resolution.ineligibleParticipantIds, ["member"]);
  assert.equal(round.resolution.challengeResult?.campaigns.length, 1);
  assert.equal(round.resolution.leaderboard[0]!.rank, 1);
  const host = round.participants.find((participant) => participant.participantId === "host")!;
  assert.equal(host.status, "SUBMITTED");
  if (host.status === "SUBMITTED") {
    assert.equal(host.submission.source, "DEADLINE_AUTO");
    assert.equal(host.submission.submittedAtMs, 100);
  }
  const repeat = reduceDraftOffCompetition(catalog, state, {
    type: "FINALIZE_ROUND", roundId: "round-1", atMs: 101,
  });
  assert.equal(repeat.ok, true);
  assert.equal(repeat.changed, false);
  assert.equal(repeat.state, state);
});

test("deadline with no completed XI produces an empty no-contest result", () => {
  let state = startedCompetition("no-contest", 10, 100);
  state = changed(state, { type: "FINALIZE_ROUND", roundId: "round-1", atMs: 100 });
  const resolution = resolvedRound(state).resolution;
  assert.equal(resolution.contestStatus, "NO_CONTEST");
  assert.equal(resolution.challengeResult, null);
  assert.deepEqual(resolution.leaderboard, []);
  assert.deepEqual(resolution.eligibleParticipantIds, []);
  assert.deepEqual(resolution.ineligibleParticipantIds, ["host", "member"]);
});

test("identity, display names, and timestamps do not alter uncontested gameplay outcomes", () => {
  let first = startedCompetition("metadata-independent", 10, 100, "Host A", "Member A", "host", "member", 0);
  let second = startedCompetition("metadata-independent", 1010, 1100, "Renamed Host", "Renamed Member", "z-host", "z-member", 1000);
  first = completeXi(first, "host", 20);
  second = completeXi(second, "z-host", 1020);
  first = changed(first, { type: "FINALIZE_ROUND", roundId: "round-1", atMs: 100 });
  second = changed(second, { type: "FINALIZE_ROUND", roundId: "round-1", atMs: 1100 });
  const left = resolvedRound(first).resolution.challengeResult!.campaigns[0]!;
  const right = resolvedRound(second).resolution.challengeResult!.campaigns[0]!;
  assert.equal(left.gameplayXiIdentity, right.gameplayXiIdentity);
  assert.deepEqual(left.matches, right.matches);
  assert.deepEqual(left.aggregate, right.aggregate);
  assert.deepEqual(
    resolvedRound(first).resolution.challengeResult!.schedule,
    resolvedRound(second).resolution.challengeResult!.schedule,
  );
});

function competition(id: string, hostName: string, createdAtMs: number): DraftOffCompetitionState {
  return createDraftOffCompetition(catalog, {
    competitionId: id,
    catalogFingerprint: catalog.fingerprint,
    createdAtMs,
    host: { participantId: "host", displayName: hostName },
    initialRound: {
      roundId: "round-1",
      roundOrdinal: 1,
      label: "Draft-Off",
      eraId: "era-transition",
      challengeSeed: "m2-shared-round-seed",
    },
  });
}

function startedCompetition(
  seed: string,
  startAtMs: number,
  deadlineAtMs: number,
  hostName = "Host",
  memberName = "Member",
  hostId = "host",
  memberId = "member",
  createdAtMs = 0,
): DraftOffCompetitionState {
  let state = createDraftOffCompetition(catalog, {
    competitionId: `competition-${seed}-${createdAtMs}`,
    catalogFingerprint: catalog.fingerprint,
    createdAtMs,
    host: { participantId: hostId, displayName: hostName },
    initialRound: {
      roundId: "round-1",
      roundOrdinal: 1,
      label: "Draft-Off",
      eraId: "era-transition",
      challengeSeed: seed,
    },
  });
  state = changed(state, {
    type: "JOIN_COMPETITION", participantId: memberId, displayName: memberName, atMs: createdAtMs + 1,
  });
  return changed(state, {
    type: "START_ROUND", actorParticipantId: hostId, roundId: "round-1", atMs: startAtMs, deadlineAtMs,
  });
}

function completeXi(state: DraftOffCompetitionState, participantId: string, atMs: number): DraftOffCompetitionState {
  for (let pick = 0; pick < 11; pick += 1) {
    let participant = roundParticipant(state, participantId);
    state = changed(state, {
      type: "APPLY_DRAFT_COMMAND",
      participantId,
      expectedDraftRevision: participant.draftState.revision,
      draftCommand: { type: "SPIN" },
      atMs,
    });
    participant = roundParticipant(state, participantId);
    if (participant.status !== "DRAFTING" || participant.draftState.phase !== "AWAITING_PICK") {
      assert.fail("Expected active participant spin.");
    }
    const context = {
      eraId: participant.draftState.eraId,
      picks: participant.draftState.picks,
      activeTeamSeasonId: participant.draftState.currentSpin.teamSeasonId,
    };
    const choice = catalog.getCandidatesForTeamSeason(participant.draftState.currentSpin.teamSeasonId)
      .flatMap((player) => getOpenBattingPositions(participant.draftState.picks)
        .map((battingPosition) => ({ playerTeamSeasonId: player.playerTeamSeasonId, battingPosition })))
      .find((candidate) => evaluateSelectionLegality(catalog, context, candidate).available);
    assert.ok(choice);
    state = changed(state, {
      type: "APPLY_DRAFT_COMMAND",
      participantId,
      expectedDraftRevision: participant.draftState.revision,
      draftCommand: { type: "LOCK_PLAYER", ...choice },
      atMs,
    });
  }
  assert.equal(roundParticipant(state, participantId).draftState.phase, "XI_COMPLETE");
  return state;
}

function changed(state: DraftOffCompetitionState, command: DraftOffCompetitionCommand): DraftOffCompetitionState {
  const result = reduceDraftOffCompetition(catalog, state, command);
  if (!result.ok) assert.fail(`${result.error.code}: ${result.error.message}`);
  if (!result.changed) assert.fail(`Expected ${command.type} to change state.`);
  return result.state;
}

function member(state: DraftOffCompetitionState, participantId: string) {
  return state.participants.find((participant) => participant.participantId === participantId)!;
}

function draftingRound(state: DraftOffCompetitionState) {
  const round = state.rounds.find((candidate) => candidate.phase === "DRAFTING");
  if (!round || round.phase !== "DRAFTING") assert.fail("Expected drafting round.");
  return round;
}

function resolvedRound(state: DraftOffCompetitionState) {
  const round = state.rounds.find((candidate) => candidate.phase === "RESOLVED");
  if (!round || round.phase !== "RESOLVED") assert.fail("Expected resolved round.");
  return round;
}

function roundParticipant(state: DraftOffCompetitionState, participantId: string): DraftOffRoundParticipant {
  const round = state.rounds[0]!;
  if (round.phase === "PENDING") assert.fail("Expected started round.");
  return round.participants.find((participant) => participant.participantId === participantId)!;
}
