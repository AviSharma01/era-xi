import type { DraftOffCampaignResult } from "./draftOffTypes.js";
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { canonicalJson, canonicalSha256 } from "./eraDraftCanonical.js";
import { createEraDraftGame, reduceEraDraft } from "./eraDraftEngine.js";
import { restoreEraDraftState, serializeEraDraftState, canonicalEraDraftStateHash } from "./eraDraftPersistence.js";
import { replayEraDraftState, replayEraDraftGame } from "./eraDraftReplay.js";
import { projectEraDraftPublicState, projectEraDraftRevealState } from "./eraDraftProjection.js";
import { createDraftOffCompetition } from "./draftOffCompetition.js";
import { restoreDraftOffCompetition, serializeDraftOffCompetition } from "./draftOffCompetitionPersistence.js";
import { projectDraftOffRoom } from "./draftOffRoomProjection.js";
import { projectDraftOffParticipantResults } from "./draftOffResultsProjection.js";
import { parseDraftOffResults } from "./draftOffResultsClient.js";
import { parseRoomSnapshot } from "./draftOffRealtimeClient.js";
import { deriveDraftOffGameplayXiIdentity, simulateDraftOffEntries } from "./draftOffSimulation.js";
import { evaluateEraDraftXi } from "./eraDraftReveal.js";
import { TEAM_EVALUATION_V2_VERSION, ERA_IDS } from "./teamEvaluationV2.js";
import { TEAM_EVALUATION_V3_VERSION } from "./teamEvaluationV3.js";
import { countDraftTiers } from "./eraDraftTierCaps.js";
import { catalog, soloXi, resolvedRoom, participantId, roomLobby, startRoom, completeParticipant, draftOf, roomApply, roomCode } from "./evaluationV3TestSupport.js";
import { createEraDraftUiSave, parseEraDraftUiSave } from "./eraDraftUiPersistence.js";

const legacy = JSON.parse(readFileSync("src/fixtures/evaluationV3Legacy.json", "utf8")) as {
  catalogFingerprint: string;
  solo: { eraId: string; phase: string; save: string }[];
  rooms: { version: number; label: string; save: string; viewHash: string; resultsHash?: string }[];
};

const goldens = JSON.parse(readFileSync("src/fixtures/evaluationV3Goldens.json", "utf8")) as {
  catalogFingerprint: string; solo: Record<string, string>; rooms: Record<string, { stateHash: string; resultsHash: string }>;
};

test("pre-V3 Solo save bytes, replay, evaluations and historical results remain frozen at every phase and era", () => {
  assert.equal(catalog.fingerprint, legacy.catalogFingerprint);
  for (const row of legacy.solo) {
    const state = restoreEraDraftState(catalog, row.save);
    assert.equal(serializeEraDraftState(state), row.save);
    assert.deepEqual(replayEraDraftState(catalog, state), state);
    assert.equal(Object.hasOwn(state, "teamEvaluationVersion"), false);
    if (state.phase === "REVEALED" || state.phase === "GAME_COMPLETE") assert.equal(state.evaluation.version, TEAM_EVALUATION_V2_VERSION);
    if (state.phase === "XI_COMPLETE") assert.equal(evaluateEraDraftXi(catalog, state).version, TEAM_EVALUATION_V2_VERSION);
  }
});

test("historical Draft-Off v1/v2/v3 saves, accepted histories, result and projection hashes remain byte-identical", () => {
  for (const row of legacy.rooms) {
    const state = restoreDraftOffCompetition(catalog, row.save);
    assert.equal(serializeDraftOffCompetition(state), row.save);
    assert.equal(canonicalSha256(projectDraftOffRoom(catalog, state, "host")), row.viewHash);
    if (row.resultsHash) assert.equal(canonicalSha256(projectDraftOffParticipantResults(catalog, state, "host", "host")), row.resultsHash);
    if (row.label === "host-complete") {
      const round = state.rounds[0]!; assert.notEqual(round.phase, "PENDING");
      if (round.phase !== "PENDING") assert.equal(evaluateEraDraftXi(catalog, round.participants.find(p => p.participantId === "host")!.draftState as ReturnType<typeof soloXi>).version, TEAM_EVALUATION_V2_VERSION);
    }
  }
  // A lobby created before release still starts with the original nested draft contract.
  for (const row of legacy.rooms.filter(row => row.label === "lobby")) {
    let state = restoreDraftOffCompetition(catalog, row.save);
    state = roomApply(state, { type: "JOIN_COMPETITION", participantId: "new", displayName: "New entrant", atMs: 1000 });
    state = roomApply(state, { type: "START_ROUND", actorParticipantId: "host", roundId: "r1", atMs: 1010, deadlineAtMs: 1100 });
    const round = state.rounds[0]!;
    if (round.phase !== "PENDING") for (const p of round.participants) assert.equal(p.draftState.teamEvaluationVersion, undefined);
  }
});

test("V3 Solo policy is pinned before reveal and survives every phase, replay, UI save and simulation in all eras", () => {
  for (const era of ERA_IDS) {
    const xi = soloXi(era);
    const old = soloXi(era, false);
    assert.deepEqual(xi.picks, old.picks); assert.deepEqual(xi.history, old.history); assert.deepEqual(xi.rngCounters, old.rngCounters);
    let state = xi as ReturnType<typeof reduceEraDraft>["state"];
    for (const command of [undefined, { type: "REVEAL_XI" }, { type: "SIMULATE_SEASON" }] as const) {
      if (command) { const result = reduceEraDraft(catalog, state, command); assert.ok(result.ok); state = result.state; }
      assert.equal(state.teamEvaluationVersion, TEAM_EVALUATION_V3_VERSION);
      assert.equal(catalog.fingerprint, goldens.catalogFingerprint);
      assert.equal(canonicalEraDraftStateHash(state), goldens.solo[`${era}/${state.phase}`]);
      const save = serializeEraDraftState(state), restored = restoreEraDraftState(catalog, save);
      assert.equal(serializeEraDraftState(restored), save); assert.deepEqual(replayEraDraftState(catalog, state), state);
      const cursor = state.phase === "GAME_COMPLETE" ? { phase: "COMPLETE" as const } : null;
      if (state.phase !== "SETUP") assert.equal(parseEraDraftUiSave(createEraDraftUiSave(state, cursor).raw).summary.eraId, era);
      if (state.phase === "XI_COMPLETE") {
        const hidden = canonicalJson(projectEraDraftPublicState(catalog, state));
        assert.doesNotMatch(hidden, /penaltyPercent|effectiveContribution|battingAdjustment|adjustedStrength/);
      }
      if (state.phase === "REVEALED") {
        const view = projectEraDraftRevealState(catalog, state);
        assert.equal(view.evaluation.teamEvaluationVersion, TEAM_EVALUATION_V3_VERSION);
        assert.ok(view.players.every(p => p.battingAdjustment));
        assert.deepEqual(view.evaluation.strength, state.evaluation.adjustedStrength && {
          batting: state.evaluation.adjustedStrength.batting, bowling: state.evaluation.adjustedStrength.bowling, overall: state.evaluation.adjustedStrength.overall,
        });
      }
      if (state.phase === "GAME_COMPLETE") {
        assert.equal(state.evaluation.version, TEAM_EVALUATION_V3_VERSION);
        assert.equal(state.season.userTeam.strength.batting, state.evaluation.adjustedStrength.batting);
        for (const team of state.season.league.teams.filter(row => row.teamId !== "user")) {
          const profile = catalog.getOpponentProfiles(era).find(p => p.candidateId === team.teamId)!;
          assert.deepEqual(team.strength, { batting: profile.evaluation.batting, bowling: profile.evaluation.bowling, overall: profile.evaluation.overall });
        }
      }
    }
    const setup = createEraDraftGame({ catalog, rootSeed: "v3-phases", teamEvaluationVersion: TEAM_EVALUATION_V3_VERSION });
    const chosen = reduceEraDraft(catalog, setup, { type: "CHOOSE_ERA", eraId: era }); assert.ok(chosen.ok);
    const spun = reduceEraDraft(catalog, chosen.state, { type: "SPIN" }); assert.ok(spun.ok);
    const respun = reduceEraDraft(catalog, spun.state, { type: "RESPIN" }); assert.ok(respun.ok);
    for (const intermediate of [setup, chosen.state, spun.state, respun.state]) assert.deepEqual(replayEraDraftState(catalog, restoreEraDraftState(catalog, serializeEraDraftState(intermediate))), intermediate);
  }
});

test("Solo and room restoration fail closed on mixed version triples, missing policies and policy tampering", () => {
  const xi = soloXi("era-transition"), row = JSON.parse(serializeEraDraftState(xi));
  for (const policy of [undefined, null, TEAM_EVALUATION_V2_VERSION, "unsupported"]) {
    assert.throws(() => replayEraDraftGame({ catalog, rootSeed: "bad-policy", history: [], teamEvaluationVersion: policy } as never));
  }

  for (const change of [
    { engineVersion: "ipl-era-draft-engine/v1" }, { stateSchemaVersion: "ipl-era-draft-state/v2" },
    { saveVersion: "ipl-era-draft-save/v2" }, { teamEvaluationVersion: TEAM_EVALUATION_V2_VERSION }, { teamEvaluationVersion: null },
  ]) assert.throws(() => restoreEraDraftState(catalog, JSON.stringify({ ...row, ...change })));
  const missing = { ...row }; delete missing.teamEvaluationVersion;
  assert.throws(() => restoreEraDraftState(catalog, JSON.stringify(missing)));
  const room = JSON.parse(serializeDraftOffCompetition(roomLobby("era-impact", "MIRROR", 2)));
  for (const key of ["format", "tierCaps", "teamEvaluationVersion"]) {
    const corrupt = structuredClone(room); delete corrupt.genesis[key];
    assert.throws(() => restoreDraftOffCompetition(catalog, JSON.stringify(corrupt)));
  }
  for (const [key, value] of [["engineVersion", "ipl-draft-off-competition-engine/v3"], ["saveVersion", "ipl-draft-off-competition-save/v3"], ["stateSchemaVersion", "ipl-draft-off-competition-state/v3"]]) {
    assert.throws(() => restoreDraftOffCompetition(catalog, JSON.stringify({ ...room, [key]: value })));
  }
  assert.throws(() => createDraftOffCompetition(catalog, { ...room.genesis, tierCaps: undefined }));
});

for (const era of ERA_IDS) for (const format of ["MIRROR", "VARIED"] as const) for (const count of [2, 8] as const) {
  test(`v4 ${era}/${format}/${count}: caps, replay, authoritative diagnostics and versioned transports`, () => {
    const state = resolvedRoom(era, format, count);
    assert.equal(canonicalSha256(state), goldens.rooms[`${era}/${format}/${count}`]!.stateHash);
    assert.equal(canonicalSha256(projectDraftOffParticipantResults(catalog, state, participantId(1), participantId(1))), goldens.rooms[`${era}/${format}/${count}`]!.resultsHash);
    const bytes = serializeDraftOffCompetition(state), restored = restoreDraftOffCompetition(catalog, bytes);
    assert.equal(serializeDraftOffCompetition(restored), bytes);
    const view = projectDraftOffRoom(catalog, state, participantId(1));
    assert.equal(parseRoomSnapshot(JSON.stringify({ type: "ROOM_SNAPSHOT", version: 4, serverTimeMs: 100, view: (({myDraft: _, ...publicView}) => publicView)(view) }), roomCode).version, 4);
    const round = state.rounds[0]!; assert.equal(round.phase, "RESOLVED"); if (round.phase !== "RESOLVED") return;
    for (const participant of round.participants) {
      const tiers = countDraftTiers(catalog, participant.draftState.picks); assert.ok(tiers.s <= 3 && tiers.sa <= 6);
      const result = { ok: true as const, version: 2 as const, roomCode, ...projectDraftOffParticipantResults(catalog, restored, participantId(1), participant.participantId) };
      assert.equal(parseDraftOffResults(result, result).evaluation.teamEvaluationVersion, TEAM_EVALUATION_V3_VERSION);
      assert.equal(result.players.length, 11); assert.ok(result.players.every(p => p.battingAdjustment));
      const campaign: DraftOffCampaignResult = round.resolution.challengeResult!.campaigns.find(c => c.participantId === participant.participantId)!;
      assert.equal(campaign.evaluation.version, TEAM_EVALUATION_V3_VERSION);
      assert.deepEqual(result.evaluation.strength, { batting: campaign.evaluation.adjustedStrength.batting, bowling: campaign.evaluation.adjustedStrength.bowling, overall: campaign.evaluation.adjustedStrength.overall });
    }
    if (format === "MIRROR") {
      const campaigns = round.resolution.challengeResult!.campaigns;
      assert.deepEqual(campaigns[0]!.matches, campaigns[1]!.matches);
      assert.equal(campaigns[0]!.gameplayXiIdentity, campaigns[1]!.gameplayXiIdentity);
    }
  });
}

test("v4 deadline resolves automatic, uncontested and no-contest entries and restricts results access", () => {
  for (const eligible of [0, 1, 2]) {
    const state = resolvedRoom("era-impact", "VARIED", 2, eligible, false);
    assert.equal(serializeDraftOffCompetition(restoreDraftOffCompetition(catalog, serializeDraftOffCompetition(state))), serializeDraftOffCompetition(state));
    const round = state.rounds[0]!; if (round.phase !== "RESOLVED") throw new Error("Expected resolution");
    assert.equal(round.resolution.contestStatus, eligible === 0 ? "NO_CONTEST" : eligible === 1 ? "UNCONTESTED" : "CONTESTED");
    for (const p of round.participants) if (p.status === "SUBMITTED") assert.equal(p.submission.source, "DEADLINE_AUTO");
    if (eligible) assert.doesNotThrow(() => projectDraftOffParticipantResults(catalog, state, participantId(2), participantId(1)));
    assert.throws(() => projectDraftOffParticipantResults(catalog, state, "outsider", participantId(1)));
  }
  const partial = completeParticipant(startRoom(roomLobby("era-impact", "MIRROR", 2)), participantId(1));
  assert.throws(() => projectDraftOffParticipantResults(catalog, partial, participantId(1), participantId(1)));
  const hidden = canonicalJson(projectDraftOffRoom(catalog, partial, participantId(2)));
  assert.doesNotMatch(hidden, /penaltyPercent|effectiveContribution|battingAdjustment|adjustedStrength/);
});

test("evaluation version changes gameplay identity without changing submission/schedule or participant variance rules", () => {
  const xi = soloXi("era-transition"), old = soloXi("era-transition", false);
  const modernIdentity = deriveDraftOffGameplayXiIdentity({ catalogFingerprint: catalog.fingerprint, eraId: xi.eraId, xi, teamEvaluationVersion: TEAM_EVALUATION_V3_VERSION });
  const legacyIdentity = deriveDraftOffGameplayXiIdentity({ catalogFingerprint: catalog.fingerprint, eraId: old.eraId, xi: old });
  assert.notEqual(modernIdentity, legacyIdentity);
  assert.throws(() => deriveDraftOffGameplayXiIdentity({ catalogFingerprint: catalog.fingerprint, eraId: xi.eraId, xi }));
  const run = (draft: typeof xi, modern: boolean, id = "one") => simulateDraftOffEntries({ catalog, eraId: xi.eraId, challengeSeed: "same-schedule", roundOrdinal: 1,
    ...(modern ? { teamEvaluationVersion: TEAM_EVALUATION_V3_VERSION } : {}), participants: [{ participantId: id, displayName: id, xi: draft }] });
  const a = run(xi, true), b = run(xi, true, "two"), historical = run(old, false);
  assert.deepEqual(a.schedule, historical.schedule); assert.deepEqual(a.seeds, historical.seeds);
  assert.equal(a.campaigns[0]!.submissionHash, historical.campaigns[0]!.submissionHash);
  assert.deepEqual(a.campaigns[0]!.matches, b.campaigns[0]!.matches);
  assert.throws(() => run(xi, false));
});

test("strict v4 snapshots and v2 result diagnostics reject omissions, cross-version fields and inconsistent totals", () => {
  const state = resolvedRoom("era-transition", "MIRROR", 2);
  const result = { ok: true as const, version: 2 as const, roomCode, ...projectDraftOffParticipantResults(catalog, state, participantId(1), participantId(1)) };
  for (const mutate of [
    (r: any) => { r.version = 1; }, (r: any) => { delete r.players[0].battingAdjustment; },
    (r: any) => { r.players[0].battingAdjustment.penaltyPercent = 99; },
    (r: any) => { r.players[0].presentationFit = "UNKNOWN"; },
    (r: any) => { r.players[0].battingAdjustment.effectiveContribution += 1; },
    (r: any) => { r.players[0].battingAdjustment.playerId = "leak"; },
    (r: any) => { r.evaluation.battingAdjustment.appliedDeduction += 1; },
    (r: any) => { r.evaluation.teamEvaluationVersion = TEAM_EVALUATION_V2_VERSION; },
  ]) { const corrupt = structuredClone(result); mutate(corrupt); assert.throws(() => parseDraftOffResults(corrupt, result)); }
  const { myDraft: _, ...view } = projectDraftOffRoom(catalog, state, participantId(1));
  const frame = { version: 4, type: "ROOM_SNAPSHOT", serverTimeMs: 100, view };
  for (const mutate of [(f: any) => { f.version = 3; }, (f: any) => { delete f.view.round.teamEvaluationVersion; }, (f: any) => { delete f.view.round.tierCaps; }]) {
    const corrupt = structuredClone(frame); mutate(corrupt); assert.throws(() => parseRoomSnapshot(JSON.stringify(corrupt), roomCode));
  }
});
