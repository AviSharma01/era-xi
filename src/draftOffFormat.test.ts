import assert from "node:assert/strict";
import test from "node:test";
import { canonicalSha256 } from "./eraDraftCanonical.js";
import { createDraftOffCompetition, reduceDraftOffCompetition } from "./draftOffCompetition.js";
import { assertDraftOffCompetitionState } from "./draftOffCompetitionInvariants.js";
import { canonicalDraftOffCompetitionStateHash, restoreDraftOffCompetition, serializeDraftOffCompetition } from "./draftOffCompetitionPersistence.js";
import { deriveDraftOffParticipantSeed, DRAFT_OFF_PARTICIPANT_SEED_VERSION, type DraftOffFormat } from "./draftOffFormat.js";
import { deriveDraftOffSeeds } from "./draftOffSimulation.js";
import { projectDraftOffRoom } from "./draftOffRoomProjection.js";
import { catalog, baseState, joinedState, startedState, changed, participant, legalLock } from "./draftOffRoomTestSupport.js";
import { ERA_IDS, type EraId } from "./teamEvaluationV2.js";
import { createEraDraftGame, reduceEraDraft } from "./eraDraftEngine.js";
import { selectNormalSpinTeamSeason } from "./eraDraftRng.js";
import { restoreEraDraftState, serializeEraDraftState } from "./eraDraftPersistence.js";
import type { EraDraftCatalog } from "./eraDraftData.js";
import type { DraftOffCompetitionState, DraftOffDraftCommand } from "./draftOffCompetitionTypes.js";

function lobby(format: DraftOffFormat, eraId: EraId = "era-transition") {
  return createDraftOffCompetition(catalog, { ...baseState().genesis, format,
    initialRound: { ...baseState().genesis.initialRound, eraId } });
}
function start(format: DraftOffFormat, ids = ["member"], eraId: EraId = "era-transition", rename = false) {
  let state = lobby(format, eraId);
  for (const id of ids) state = changed(state, { type: "JOIN_COMPETITION", participantId: id, displayName: `${rename ? "Renamed" : "Player"} ${id}`, atMs: 1 });
  return changed(state, { type: "START_ROUND", actorParticipantId: "host", roundId: "round-1", atMs: 10, deadlineAtMs: 1000 });
}
function apply(state: DraftOffCompetitionState, id: string, draftCommand: DraftOffDraftCommand) {
  return changed(state, { type: "APPLY_DRAFT_COMMAND", participantId: id, atMs: 20,
    expectedDraftRevision: participant(state, id).draftState.revision, draftCommand });
}

test("participant seed policy is domain-separated, stable and Mirror is exactly the room root", () => {
  const actual = deriveDraftOffParticipantSeed("room-root", "p_0123", "VARIED");
  assert.equal(actual, "09301103ee6ee64d45bfdfb60723746b46adc6d00022e25ec8b6ef2af6a41e81");
  assert.equal(actual, canonicalSha256({ version: DRAFT_OFF_PARTICIPANT_SEED_VERSION,
    domain: "participant-draft-opportunities", roomDraftSeed: "room-root", participantId: "p_0123" }));
  assert.notEqual(actual, deriveDraftOffParticipantSeed("room-root", "p_4567", "VARIED"));
  assert.notEqual(actual, deriveDraftOffParticipantSeed("other-room-root", "p_0123", "VARIED"));
  assert.equal(deriveDraftOffParticipantSeed("room-root", "p_0123", "MIRROR"), "room-root");
  assert.throws(() => deriveDraftOffParticipantSeed("room-root", "", "VARIED"));
});

test("both formats ignore join order, other entrants, display names and lifecycle metadata", () => {
  for (const format of ["VARIED", "MIRROR"] as const) {
    const a = start(format, ["member", "other"]), b = start(format, ["other", "member"], "era-transition", true), c = start(format);
    for (const id of ["host", "member"]) {
      assert.deepEqual(participant(a, id).draftState, participant(b, id).draftState);
      assert.deepEqual(participant(a, id).draftState, participant(c, id).draftState);
    }
    let rejoined = lobby(format);
    rejoined = changed(rejoined, { type: "JOIN_COMPETITION", participantId: "member", displayName: "Reserved member", atMs: 1 });
    rejoined = changed(rejoined, { type: "LEAVE_COMPETITION", participantId: "member", atMs: 2 });
    rejoined = changed(rejoined, { type: "JOIN_COMPETITION", participantId: "member", atMs: 3 });
    rejoined = changed(rejoined, { type: "START_ROUND", actorParticipantId: "host", roundId: "round-1", atMs: 15, deadlineAtMs: 800 });
    assert.deepEqual(participant(a, "member").draftState, participant(rejoined, "member").draftState);
  }
});

test("historical pending, joined and started v1 hashes stay frozen and remain Mirror on replay", () => {
  // Captured from main da390d4's compiled implementation before this change.
  for (const [state, expected] of [
    [baseState(), "876426af1235ae4d5a452ed347e7f6789b18d51d1a264bde9046a9b97eaba392"],
    [joinedState(), "1d473348e81262ad2578d8e237f93b0e9ea1f1d6edf8d4b35e76391a9382d5ad"],
    [startedState(), "18641c42b6a0302e1d0cd416401b43a19029fefd0d2ebc77882fef116fe0e691"],
  ] as const) {
    assert.equal(canonicalDraftOffCompetitionStateHash(state), expected);
    const restored = restoreDraftOffCompetition(catalog, serializeDraftOffCompetition(state));
    assert.deepEqual(restored, state); assert.equal(restored.genesis.format, undefined);
    assert.equal(Object.hasOwn(projectDraftOffRoom(catalog, restored, "host").round, "format"), false);
  }
  const oldStarted = changed(restoreDraftOffCompetition(catalog, serializeDraftOffCompetition(joinedState())),
    { type: "START_ROUND", actorParticipantId: "host", roundId: "round-1", atMs: 10, deadlineAtMs: 1000 });
  assert.deepEqual(participant(oldStarted, "host").draftState, participant(start("MIRROR"), "host").draftState);
});

test("explicit Mirror reproduces the entire historical v1 challenge result for equivalent inputs", () => {
  let legacy = changed(baseState(), { type: "JOIN_COMPETITION", participantId: "member", displayName: "Player member", atMs: 1 });
  legacy = changed(legacy, { type: "START_ROUND", actorParticipantId: "host", roundId: "round-1", atMs: 10, deadlineAtMs: 1000 });
  const finish = (initial: DraftOffCompetitionState) => {
    let state = initial;
    for (const id of ["host", "member"]) {
      for (let pick = 0; pick < 11; pick++) {
        state = apply(state, id, { type: "SPIN" });
        if (pick === 3) state = apply(state, id, { type: "RESPIN" });
        state = apply(state, id, legalLock(state, id));
      }
      state = changed(state, { type: "SUBMIT_XI", participantId: id, atMs: 20, expectedDraftRevision: participant(state, id).draftState.revision });
    }
    const round = state.rounds[0]!;
    if (round.phase !== "RESOLVED") throw new Error("Expected resolved round");
    return round.resolution.challengeResult;
  };
  assert.deepEqual(finish(start("MIRROR")), finish(legacy));
});

test("v2 saves require format, reject version mixing/tampering and preserve immutable format", () => {
  for (const format of ["VARIED", "MIRROR"] as const) {
    // New contract evidence is separate from the 80 frozen v1 fixtures.
    assert.equal(canonicalDraftOffCompetitionStateHash(lobby(format)), format === "VARIED"
      ? "f803aa3b450d1aa8f7fed6b257bf7c927892632240b0b1b1f3efbf116688ac6e"
      : "c51633b536ba05a8008d706c0f3b4e12c4b1d98f18a5a77d3820a2b31b34165f");
    for (const state of [lobby(format), start(format)]) {
      const serialized = serializeDraftOffCompetition(state), saved = JSON.parse(serialized);
      assert.match(saved.saveVersion, /\/v2$/); assert.match(saved.engineVersion, /\/v2$/);
      assert.equal(saved.genesis.format, format);
      assert.equal(serializeDraftOffCompetition(restoreDraftOffCompetition(catalog, serialized)), serialized);
      for (const mutate of [
        (row: typeof saved) => { delete row.genesis.format; },
        (row: typeof saved) => { row.genesis.format = "BALANCED"; },
        (row: typeof saved) => { row.genesis.format = format === "VARIED" ? "MIRROR" : "VARIED"; },
        (row: typeof saved) => { row.saveVersion = "ipl-draft-off-competition-save/v1"; },
      ]) { const row = structuredClone(saved); mutate(row); assert.throws(() => restoreDraftOffCompetition(catalog, JSON.stringify(row))); }
    }
    const state = start(format), round = state.rounds[0]!;
    if (round.phase === "PENDING") throw new Error("Expected started round");
    const corrupted = structuredClone(state);
    const badRound = corrupted.rounds[0]!;
    if (badRound.phase === "PENDING") throw new Error("Expected started round");
    Object.assign(badRound.participants[0]!.draftState, { rootSeed: "client-controlled" });
    assert.throws(() => assertDraftOffCompetitionState(catalog, corrupted));
  }
});

for (const eraId of ERA_IDS) for (const format of ["VARIED", "MIRROR"] as const) {
  test(`${eraId}/${format}: complete two-player competition, respin, replay and unchanged campaign path`, () => {
    let state = start(format, ["member"], eraId);
    const root = participant(state, "host").draftState.rootSeed;
    assert.equal(root === participant(state, "member").draftState.rootSeed, format === "MIRROR");
    for (const id of ["host", "member"]) {
      for (let pick = 0; pick < 11; pick++) {
        state = apply(state, id, { type: "SPIN" });
        if (pick === 0) state = apply(state, id, { type: "RESPIN" });
        state = apply(state, id, legalLock(state, id));
      }
      state = changed(state, { type: "SUBMIT_XI", participantId: id, atMs: 20, expectedDraftRevision: participant(state, id).draftState.revision });
    }
    assert.equal(state.phase, "COMPLETE");
    assert.deepEqual(restoreDraftOffCompetition(catalog, serializeDraftOffCompetition(state)), state);
    const round = state.rounds[0]!;
    if (round.phase !== "RESOLVED") throw new Error("Expected resolved round");
    const campaigns = round.resolution.challengeResult!.campaigns;
    assert.equal(campaigns.length, 2);
    assert.deepEqual(campaigns[0]!.matches.map(row => row.fixture), campaigns[1]!.matches.map(row => row.fixture));
    const oldSeeds = deriveDraftOffSeeds({ challengeSeed: round.challengeSeed, catalogFingerprint: catalog.fingerprint, eraId, roundOrdinal: 1 });
    assert.deepEqual(round.seeds, oldSeeds);
    if (format === "MIRROR") {
      assert.deepEqual(campaigns[0]!.matches, campaigns[1]!.matches);
      assert.deepEqual(campaigns[0]!.aggregate, campaigns[1]!.aggregate);
    }
  });
}

test("both formats retain deterministic dead-spin recovery, respin isolation and nested draft replay", () => {
  for (const format of ["VARIED", "MIRROR"] as const) {
    const seed = deriveDraftOffParticipantSeed("forced-recovery-room", "host", format), eraId = "era-foundation";
    const dead = selectNormalSpinTeamSeason(catalog, seed, eraId, 0).teamSeasonId;
    const wrapped: EraDraftCatalog = new Proxy(catalog, { get(target, key) {
      if (key === "getCandidatesForTeamSeason") return (id: Parameters<EraDraftCatalog["getCandidatesForTeamSeason"]>[0]) => id === dead ? [] : target.getCandidatesForTeamSeason(id);
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    const choose = reduceEraDraft(wrapped, createEraDraftGame({ catalog: wrapped, rootSeed: seed }), { type: "CHOOSE_ERA", eraId });
    assert.ok(choose.ok);
    const spin = reduceEraDraft(wrapped, choose.state, { type: "SPIN" }); assert.ok(spin.ok);
    assert.equal(spin.state.phase, "AWAITING_PICK");
    if (spin.state.phase !== "AWAITING_PICK") throw new Error("Expected spun state");
    assert.deepEqual(spin.state.currentSpin.recovery?.skippedDeadTeamSeasonIds, [dead]);
    assert.equal(spin.state.respin.status, "AVAILABLE");
    const nextNormal = selectNormalSpinTeamSeason(wrapped, seed, eraId, 1);
    const respin = reduceEraDraft(wrapped, spin.state, { type: "RESPIN" }); assert.ok(respin.ok);
    assert.equal(respin.state.respin.status, "USED");
    assert.equal(respin.state.rngCounters.normalSpin, 1);
    assert.deepEqual(selectNormalSpinTeamSeason(wrapped, seed, eraId, 1), nextNormal);
    assert.deepEqual(restoreEraDraftState(wrapped, serializeEraDraftState(respin.state)), respin.state);
  }
});
