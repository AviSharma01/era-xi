import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { projectEraDraftPublicState } from "./eraDraftProjection.js";
import { projectDraftOffPublicRoom, projectDraftOffRoom } from "./draftOffRoomProjection.js";
import { restoreDraftOffCompetition, serializeDraftOffCompetition } from "./draftOffCompetitionPersistence.js";
import { createDraftOffCompetition } from "./draftOffCompetition.js";
import { FakeDraftOffClock, InMemoryDraftOffRoomRepository } from "./draftOffRoomRepository.js";
import { DraftOffRoomService } from "./draftOffRoomService.js";
import type { DraftOffCompetitionState } from "./draftOffCompetitionTypes.js";
import type { DraftOffRoomView } from "./draftOffRoomTypes.js";
import {
  baseState, catalog, changed, completeXi, host, legalLock, member, participant,
  rejection, startedState, success,
} from "./draftOffRoomTestSupport.js";

const forbiddenKeys = new Set([
  "draftState", "history", "genesis", "submission", "xi", "seeds", "rootSeed", "challengeSeed",
  "roundSeed", "draftRootSeed", "scheduleSeed", "rngCounters", "stateHash", "draftStateHash",
  "submissionHash", "resolutionHash", "campaignHash", "resultHash", "gameplayXiIdentity",
  "challengeResult", "evaluation", "evaluationSnapshot", "campaigns", "schedule", "matches",
  "quality", "battingRating", "bowlingRating", "overallRating", "qualityTier", "internalScore",
  "secondaryBonus", "baseStrength", "adjustedStrength", "bandDistance", "nominalFitDeduction",
  "effectiveRatingBeforeTeamCap", "bowlingCapacity", "phaseBowlingUsage", "phaseBowlingCapacity",
  "battingContributions", "bowlingDeployment", "constructionEffects", "serializedCompetition", "receipts",
]);

function scan(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  if (Array.isArray(value)) return value.forEach(scan);
  for (const [key, nested] of Object.entries(value)) {
    assert.ok(!forbiddenKeys.has(key), `Private key leaked: ${key}`);
    scan(nested);
  }
}

function exactKeys(value: object, keys: string[]) {
  assert.deepEqual(Object.keys(value).sort(), keys.sort());
}

function assertView(state: DraftOffCompetitionState, id: string, view: DraftOffRoomView) {
  scan(JSON.parse(JSON.stringify(view)));
  const round = state.rounds[0]!;
  exactKeys(view, ["roomId", "revision", "phase", "participants", "round",
    ...(round.phase === "PENDING" ? [] : ["myDraft"]),
    ...(round.phase === "RESOLVED" ? ["resolution"] : []),
  ]);
  exactKeys(view.round, ["roundId", "roundOrdinal", "label", "eraId", "phase",
    ...(round.phase === "PENDING" ? [] : ["startedAtMs", "deadlineAtMs"]),
  ]);
  for (const entry of view.participants) {
    exactKeys(entry, ["participantId", "displayName", "role", "membershipStatus",
      ...(round.phase === "PENDING" ? [] : ["roundStatus", "lockedPickCount"]),
    ]);
  }
  if (round.phase !== "PENDING") {
    assert.deepEqual(view.myDraft, projectEraDraftPublicState(catalog, participant(state, id).draftState));
  }
  if (view.resolution) {
    exactKeys(view.resolution, ["trigger", "contestStatus", "resolvedAtMs", "eligibleParticipantIds", "ineligibleParticipantIds", "leaderboard"]);
    for (const row of view.resolution.leaderboard) {
      exactKeys(row, ["rank", "participantId", "displayName", "played", "won", "lost", "points", "netRunRate"]);
    }
  }
  assert.ok(Object.isFrozen(view));
  assert.ok(Object.isFrozen(view.participants));
  assert.ok(Object.isFrozen(view.round));
  const { myDraft: _private, ...shared } = view;
  assert.deepEqual(projectDraftOffPublicRoom(state), shared);
  assert.ok(!Object.hasOwn(projectDraftOffPublicRoom(state), 'myDraft'));
}

test("apart from additive pick counts, pre-Stage-D private HTTP JSON retains its frozen hashes", () => {
  // Captured from the committed Stage C projector, before extraction. Includes
  // values, optional-field absence, nested shape, and original JSON key order.
  const lobby = baseState(), active = startedState();
  const spun = changed(active, { type: 'APPLY_DRAFT_COMMAND', participantId: 'member', atMs: 20, expectedDraftRevision: 1, draftCommand: { type: 'SPIN' } });
  const picked = changed(spun, { type: 'APPLY_DRAFT_COMMAND', participantId: 'member', atMs: 20, expectedDraftRevision: 2, draftCommand: legalLock(spun, 'member') });
  const complete = completeXi(active, 'host');
  const submitted = changed(complete, { type: 'SUBMIT_XI', participantId: 'host', atMs: 30, expectedDraftRevision: participant(complete, 'host').draftState.revision });
  const resolved = changed(submitted, { type: 'FINALIZE_ROUND', roundId: 'round-1', atMs: 100 });
  const noContest = changed(active, { type: 'FINALIZE_ROUND', roundId: 'round-1', atMs: 100 });
  const expected = {
    lobby: '65ca99df7709fb6bc7be6c77145d5f9503e1e52b0dbfbcf1155fbaa38338e359',
    active: '418168b8da6ba22d34fb513b14a56aa94456f088b8b76cd3a6f647eb32b31cac',
    spun: 'b5ef91705b2e67082c2fb1e870a9c5b185b7c8e89beebac9cfce6d7416849875',
    picked: 'b1ce933f63715b3df50a8ac802c8134c78762b39b0faea0d404e6a84d6fc0b6f',
    complete: 'ba30bb9b6f50466fd0d17b0e97b336fcc897bc1d62569596c896596b87447980',
    submitted: '4506f5dab41eae759051c1fa4d9219b52eb86f0c43af627de4603586a1381ff7',
    resolved: '6647d717279fcc5f99f08e50e15ab69a65f68bbcd14fb196e6844850bb32dc20',
    noContest: '24a11ae5a96efc8428fc7a8cb261f256d5b23990313bd1424e09ea0a9828cfd1',
  };
  for (const [label, state] of Object.entries({ lobby, active, spun, picked, complete, submitted, resolved, noContest })) {
    const view = projectDraftOffRoom(catalog, state, 'host');
    const historical = { ...view, participants: view.participants.map(({ lockedPickCount: _progress, ...entry }) => entry) };
    assert.equal(createHash('sha256').update(JSON.stringify(historical)).digest('hex'), expected[label as keyof typeof expected], label);
  }
});

test("room projections whitelist all shared fields and expose only the caller draft across every phase", () => {
  const lobby = baseState();
  const active = startedState();
  const spun = changed(active, {
    type: "APPLY_DRAFT_COMMAND", participantId: "member", atMs: 20,
    expectedDraftRevision: 1, draftCommand: { type: "SPIN" },
  });
  const respun = changed(spun, {
    type: "APPLY_DRAFT_COMMAND", participantId: "member", atMs: 20,
    expectedDraftRevision: 2, draftCommand: { type: "RESPIN" },
  });
  const picked = changed(respun, {
    type: "APPLY_DRAFT_COMMAND", participantId: "member", atMs: 20,
    expectedDraftRevision: 3, draftCommand: legalLock(respun, "member"),
  });
  const complete = completeXi(active, "host");
  const submitted = changed(complete, {
    type: "SUBMIT_XI", participantId: "host", atMs: 30,
    expectedDraftRevision: participant(complete, "host").draftState.revision,
  });
  const resolved = changed(submitted, { type: "FINALIZE_ROUND", roundId: "round-1", atMs: 100 });
  const noContest = changed(active, { type: "FINALIZE_ROUND", roundId: "round-1", atMs: 100 });
  let bothComplete = completeXi(complete, "member");
  bothComplete = changed(bothComplete, {
    type: "SUBMIT_XI", participantId: "host", atMs: 30,
    expectedDraftRevision: participant(bothComplete, "host").draftState.revision,
  });
  const contested = changed(bothComplete, {
    type: "SUBMIT_XI", participantId: "member", atMs: 30,
    expectedDraftRevision: participant(bothComplete, "member").draftState.revision,
  });
  assertView(lobby, "host", projectDraftOffRoom(catalog, lobby, "host"));
  for (const state of [active, spun, respun, picked, complete, submitted, resolved, noContest, contested]) {
    for (const id of ["host", "member"]) assertView(state, id, projectDraftOffRoom(catalog, state, id));
  }
  const hostView = projectDraftOffRoom(catalog, picked, "host");
  const memberView = projectDraftOffRoom(catalog, picked, "member");
  assert.ok(hostView.myDraft && hostView.myDraft.phase !== "SETUP");
  assert.ok(memberView.myDraft && memberView.myDraft.phase !== "SETUP");
  assert.equal(hostView.myDraft.picks.length, 0);
  assert.equal(memberView.myDraft.picks.length, 1);
  assert.throws(() => projectDraftOffRoom(catalog, active, "outsider"), /not registered/);
});

test("public progress derives only from locked picks across v1 Mirror and both v2 formats, including replay and deadline outcomes", () => {
  for (const format of [undefined, "MIRROR", "VARIED"] as const) {
    let state = createDraftOffCompetition(catalog, { ...baseState().genesis, ...(format ? { format } : {}) });
    state = changed(state, { type: "JOIN_COMPETITION", participantId: "member", displayName: "Member", atMs: 1 });
    state = changed(state, { type: "JOIN_COMPETITION", participantId: "left", displayName: "Left", atMs: 1 });
    state = changed(state, { type: "LEAVE_COMPETITION", participantId: "left", atMs: 1 });
    assert.ok(projectDraftOffPublicRoom(state).participants.every(row => row.lockedPickCount === undefined));
    state = changed(state, { type: "START_ROUND", actorParticipantId: "host", roundId: "round-1", atMs: 10, deadlineAtMs: 100 });
    const progress = (value: DraftOffCompetitionState) => projectDraftOffPublicRoom(value).participants
      .filter(row => row.roundStatus !== undefined).map(row => [row.participantId, row.lockedPickCount, row.roundStatus]);
    assert.deepEqual(progress(state), [["host", 0, "DRAFTING"], ["member", 0, "DRAFTING"]]);
    for (const type of ["SPIN", "RESPIN"] as const) {
      state = changed(state, { type: "APPLY_DRAFT_COMMAND", participantId: "member", atMs: 20,
        expectedDraftRevision: participant(state, "member").draftState.revision, draftCommand: { type } });
      assert.deepEqual(progress(state), [["host", 0, "DRAFTING"], ["member", 0, "DRAFTING"]]);
    }
    const lock = legalLock(state, "member");
    state = changed(state, { type: "APPLY_DRAFT_COMMAND", participantId: "member", atMs: 20,
      expectedDraftRevision: participant(state, "member").draftState.revision, draftCommand: lock });
    assert.deepEqual(progress(state), [["host", 0, "DRAFTING"], ["member", 1, "DRAFTING"]]);
    state = completeXi(state, "host");
    const complete = state;
    const submitted = changed(state, { type: "SUBMIT_XI", participantId: "host", atMs: 30,
      expectedDraftRevision: participant(state, "host").draftState.revision });
    for (const before of [complete, submitted]) {
      const final = changed(before, { type: "FINALIZE_ROUND", roundId: "round-1", atMs: 100 });
      assert.deepEqual(progress(final), [["host", 11, "SUBMITTED"], ["member", 1, "INELIGIBLE"]]);
      for (const value of [before, final]) {
        const publicView = projectDraftOffPublicRoom(value);
        assert.deepEqual(projectDraftOffPublicRoom(restoreDraftOffCompetition(catalog, serializeDraftOffCompetition(value))), publicView);
        assert.ok(!JSON.stringify(publicView).includes(lock.playerTeamSeasonId));
        scan(publicView);
        for (const id of ["host", "member", "left"]) {
          const { myDraft: _private, ...shared } = projectDraftOffRoom(catalog, value, id);
          assert.deepEqual(shared, publicView);
        }
        assert.equal(publicView.participants.find(row => row.participantId === "left")!.lockedPickCount, undefined);
      }
    }
  }
});

test("service responses, rejected commands and conflicting receipt access stay participant-scoped", async () => {
  const repository = new InMemoryDraftOffRoomRepository();
  const service = new DraftOffRoomService(catalog, repository, new FakeDraftOffClock(20));
  const state = startedState();
  await service.restoreRoom(serializeDraftOffCompetition(state));
  const beforeHost = await service.readRoom(host, "room");
  const memberResult = success(await service.execute(member, {
    roomId: "room", commandId: "member-secret", expectedDraftRevision: 1, command: { type: "SPIN" },
  }));
  scan(memberResult);
  const afterHost = await service.readRoom(host, "room");
  assert.deepEqual(afterHost.myDraft, beforeHost.myDraft);
  const conflictingHost = rejection(await service.execute(host, {
    roomId: "room", commandId: "member-secret", expectedDraftRevision: 1, command: { type: "SPIN" },
  }), "COMMAND_ID_CONFLICT");
  scan(conflictingHost);
  assert.deepEqual(conflictingHost.view!.myDraft, beforeHost.myDraft);
  assert.notDeepEqual(conflictingHost.view!.myDraft, memberResult.view!.myDraft);
  const staleMember = rejection(await service.execute(member, {
    roomId: "room", commandId: "stale", expectedDraftRevision: 1, command: { type: "RESPIN" },
  }), "STALE_DRAFT_REVISION");
  scan(staleMember);
  assert.deepEqual(staleMember.view!.myDraft, memberResult.view!.myDraft);
  assert.ok(Object.isFrozen(memberResult));
  assert.ok(Object.isFrozen(memberResult.view!.myDraft));
});
