import assert from "node:assert/strict";
import test from "node:test";

import { loadEraDraftCatalog } from "./eraDraftData.js";
import { evaluateSelectionLegality, getOpenBattingPositions } from "./eraDraftLegality.js";
import { createDraftOffCompetition, reduceDraftOffCompetition } from "./draftOffCompetition.js";
import {
  canonicalDraftOffCompetitionStateHash,
  replayDraftOffCompetition,
  restoreDraftOffCompetition,
  serializeDraftOffCompetition,
} from "./draftOffCompetitionPersistence.js";
import {
  DRAFT_OFF_COMPETITION_SAVE_VERSION,
  DraftOffCompetitionDataError,
  type DraftOffCompetitionCommand,
  type DraftOffCompetitionState,
} from "./draftOffCompetitionTypes.js";

const catalog = loadEraDraftCatalog();

test("competition serialization and replay round-trip lobby, drafting, and resolved states", () => {
  const lobby = baseCompetition();
  const joined = changed(lobby, {
    type: "JOIN_COMPETITION", participantId: "member", displayName: "Member", atMs: 1,
  });
  const drafting = changed(joined, {
    type: "START_ROUND", actorParticipantId: "host", roundId: "round-1", atMs: 10, deadlineAtMs: 100,
  });
  const spun = changed(drafting, {
    type: "APPLY_DRAFT_COMMAND",
    participantId: "host",
    expectedDraftRevision: 1,
    draftCommand: { type: "SPIN" },
    atMs: 20,
  });
  const resolved = changed(spun, { type: "FINALIZE_ROUND", roundId: "round-1", atMs: 100 });

  for (const state of [lobby, joined, drafting, spun, resolved]) {
    const serialized = serializeDraftOffCompetition(state);
    const restored = restoreDraftOffCompetition(catalog, serialized);
    const replayed = replayDraftOffCompetition({
      catalog,
      genesis: state.genesis,
      history: state.history,
      expectedStateHash: canonicalDraftOffCompetitionStateHash(state),
    });
    assert.deepEqual(restored, state, state.phase);
    assert.deepEqual(replayed, state, state.phase);
    assert.equal(serializeDraftOffCompetition(restored), serialized, state.phase);
    assert.equal(canonicalDraftOffCompetitionStateHash(restored), canonicalDraftOffCompetitionStateHash(state));
    assert.ok(Object.isFrozen(restored));
  }
});

test("an uncontested campaign result is reproduced byte-for-byte through domain replay", () => {
  let state = baseCompetition();
  state = changed(state, {
    type: "JOIN_COMPETITION", participantId: "member", displayName: "Member", atMs: 1,
  });
  state = changed(state, {
    type: "START_ROUND", actorParticipantId: "host", roundId: "round-1", atMs: 10, deadlineAtMs: 100,
  });
  state = completeXi(state, "host", 20);
  state = changed(state, { type: "FINALIZE_ROUND", roundId: "round-1", atMs: 100 });
  const restored = restoreDraftOffCompetition(catalog, serializeDraftOffCompetition(state));
  assert.deepEqual(restored, state);
  const round = restored.rounds[0]!;
  assert.equal(round.phase, "RESOLVED");
  if (round.phase === "RESOLVED") {
    assert.equal(round.resolution.contestStatus, "UNCONTESTED");
    assert.equal(round.resolution.challengeResult?.campaigns.length, 1);
    assert.equal(round.resolution.challengeResult?.resultHash, state.rounds[0]!.phase === "RESOLVED"
      ? state.rounds[0]!.resolution.challengeResult?.resultHash
      : undefined);
  }
});

test("restore fails closed on malformed versions, fingerprints, history, and hashes", () => {
  let state = baseCompetition();
  state = changed(state, {
    type: "JOIN_COMPETITION", participantId: "member", displayName: "Member", atMs: 1,
  });
  state = changed(state, {
    type: "START_ROUND", actorParticipantId: "host", roundId: "round-1", atMs: 10, deadlineAtMs: 100,
  });

  assertDataFailure(() => restoreDraftOffCompetition(catalog, "{"), "INVALID_SERIALIZED_JSON");
  corruptAndReject(state, (row) => { row.extra = true; }, "INVALID_SERIALIZED_SHAPE");
  corruptAndReject(state, (row) => { row.saveVersion = "unsupported"; }, "UNSUPPORTED_SAVE_VERSION");
  corruptAndReject(state, (row) => { row.engineVersion = "unsupported"; }, "UNSUPPORTED_ENGINE_VERSION");
  corruptAndReject(state, (row) => { row.stateSchemaVersion = "unsupported"; }, "UNSUPPORTED_STATE_SCHEMA_VERSION");
  corruptAndReject(state, (row) => { row.genesis.catalogFingerprint = "0".repeat(64); }, "CATALOG_FINGERPRINT_MISMATCH");
  corruptAndReject(state, (row) => { row.stateHash = "0".repeat(64); }, "REPLAY_STATE_HASH_MISMATCH");
  corruptAndReject(state, (row) => { row.history[0].command.displayName = "Renamed"; }, "REPLAY_STATE_HASH_MISMATCH");
  corruptAndReject(state, (row) => { row.history[0].revision = 2; }, "REPLAY_EVENT_MISMATCH");
  corruptAndReject(state, (row) => { row.history[1].command.deadlineAtMs = 5; }, "REPLAY_COMMAND_REJECTED");
});

test("save format is domain-only genesis, accepted events, and canonical hash", () => {
  const state = baseCompetition();
  const row = JSON.parse(serializeDraftOffCompetition(state));
  assert.deepEqual(Object.keys(row).sort(), [
    "engineVersion", "genesis", "history", "saveVersion", "stateHash", "stateSchemaVersion",
  ]);
  assert.equal(row.saveVersion, DRAFT_OFF_COMPETITION_SAVE_VERSION);
  assert.deepEqual(row.history, []);
  assert.equal("repository" in row, false);
  assert.equal("database" in row, false);
  assert.equal("provider" in row, false);
});

test("accepted join events persist the trimmed display name", () => {
  const state = changed(baseCompetition(), {
    type: "JOIN_COMPETITION", participantId: "member", displayName: "  Member  ", atMs: 1,
  });
  const row = JSON.parse(serializeDraftOffCompetition(state));
  assert.equal(row.history[0].command.displayName, "Member");
  assert.deepEqual(restoreDraftOffCompetition(catalog, JSON.stringify(row)), state);
});

function baseCompetition(): DraftOffCompetitionState {
  return createDraftOffCompetition(catalog, {
    competitionId: "persistence-competition",
    catalogFingerprint: catalog.fingerprint,
    createdAtMs: 0,
    host: { participantId: "host", displayName: "Host" },
    initialRound: {
      roundId: "round-1",
      roundOrdinal: 1,
      label: "Draft-Off",
      eraId: "era-transition",
      challengeSeed: "persistence-seed",
    },
  });
}

function changed(state: DraftOffCompetitionState, command: DraftOffCompetitionCommand): DraftOffCompetitionState {
  const result = reduceDraftOffCompetition(catalog, state, command);
  if (!result.ok) assert.fail(`${result.error.code}: ${result.error.message}`);
  if (!result.changed) assert.fail(`Expected ${command.type} to change state.`);
  return result.state;
}

function completeXi(state: DraftOffCompetitionState, participantId: string, atMs: number): DraftOffCompetitionState {
  for (let pick = 0; pick < 11; pick += 1) {
    const round = state.rounds[0]!;
    if (round.phase === "PENDING") assert.fail("Expected started round.");
    let participant = round.participants.find((item) => item.participantId === participantId)!;
    state = changed(state, {
      type: "APPLY_DRAFT_COMMAND",
      participantId,
      expectedDraftRevision: participant.draftState.revision,
      draftCommand: { type: "SPIN" },
      atMs,
    });
    const spunRound = state.rounds[0]!;
    if (spunRound.phase === "PENDING") assert.fail("Expected started round.");
    participant = spunRound.participants.find((item) => item.participantId === participantId)!;
    if (participant.status !== "DRAFTING" || participant.draftState.phase !== "AWAITING_PICK") {
      assert.fail("Expected awaiting-pick participant.");
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
  return state;
}

function corruptAndReject(
  state: DraftOffCompetitionState,
  mutate: (row: any) => void,
  expectedCode: string,
): void {
  const row = JSON.parse(serializeDraftOffCompetition(state));
  mutate(row);
  assertDataFailure(() => restoreDraftOffCompetition(catalog, JSON.stringify(row)), expectedCode);
}

function assertDataFailure(action: () => unknown, code: string): void {
  assert.throws(action, (error) => error instanceof DraftOffCompetitionDataError && error.code === code);
}
