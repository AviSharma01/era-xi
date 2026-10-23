import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RevealedExperience } from "./eraDraftApp.js";
import { revealEraXi } from "./eraDraftPhase4TestSupport.js";
import { projectEraDraftRevealState } from "./eraDraftProjection.js";
import { projectDraftOffParticipantResults } from "./draftOffResultsProjection.js";
import { serializeDraftOffCompetition } from "./draftOffCompetitionPersistence.js";
import { DraftOffRoomService } from "./draftOffRoomService.js";
import { InMemoryDraftOffRoomRepository } from "./draftOffRoomRepository.js";
import { changed, completeXi, ManualDraftOffClock, participant } from "./draftOffRoomTestSupport.js";
import { catalog, roomCode, hostId, memberId, leftId, resultsLobby, resultsStarted, resultsResolved, resultsBody, assertResultsAgainstState } from "./draftOffResultsTestSupport.js";
import { DRAFT_OFF_RESULTS_MAX_BYTES } from "./draftOffResultsTypes.js";
import type { DraftOffCampaignResult } from "./draftOffTypes.js";

test("M5.3 extraction preserves pre-change solo reveal JSON and rendered markup in all five eras", () => {
  // Captured from committed V1 dist before extracting the projection helper.
  const expected = [
    ["69686257765f31e5157dde2a94975407f3d7674342408f5bcd817d560bfcdcbe", "783a921eb1e0f84e30a7c6a4870ca595137324f0c7538854a4a933bcd6261a09"],
    ["1aced79625d8819e1bf6e186253dc688c50cf495ed7f4bd50f0ee06cb01658f5", "e677bd87d0be31c9b5c78914e035eb505b45782f467665b7298d2602fcf57501"],
    ["d6e8ebfa4f5a1f9df1dc136bce5da11d9f3ca24280c9a8c769ba74366c6adcf2", "4026a119fc0ceb0474c7b2388abf88aee4ca79edf1c712ce4d8ea0a2636c361f"],
    ["b71206ac4d80b14485b204ccee88bbb17d347a2b894b5d820192daa9ed4202c9", "953a1d35147b8b2a27f3a194f19b7a06d4236250a47c26ff8caa9d7c15c73ce0"],
    ["4ac9240c91a25aa6d29446cf16de73efcb48e956318e3dad406b62947a686ae7", "438b4909071e753201aca942871036b7008eba30a3642c0e3d52a7316782a8c3"],
  ];
  catalog.getEraIds().forEach((eraId, index) => {
    const state = revealEraXi(catalog, "m53-solo-parity", eraId);
    const view = projectEraDraftRevealState(catalog, state);
    const html = renderToStaticMarkup(<RevealedExperience session={{ catalog, state }} persistenceWarning={null} onBeginSeason={() => {}} onExit={() => {}} />);
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    assert.deepEqual([hash(JSON.stringify(view)), hash(html)], expected[index], eraId);
  });
});

test("results access is resolution-gated, locked-roster-only and permits incomplete entrants", () => {
  for (const state of [resultsLobby(), resultsStarted()]) {
    for (const target of [hostId, leftId, "unknown"]) assert.throws(() => resultsBody(state, hostId, target), /RESULTS_NOT_READY/);
  }
  const state = resultsResolved(1);
  assert.equal(resultsBody(state, memberId).participantId, hostId);
  for (const target of [memberId, leftId, "unknown"]) assert.throws(() => resultsBody(state, hostId, target), /RESULT_UNAVAILABLE/);
  for (const target of [hostId, "unknown"]) assert.throws(() => resultsBody(state, leftId, target), /RESULT_UNAVAILABLE/);
  assert.throws(() => resultsBody(state, "outsider"), /AUTHENTICATION_FAILED/);
  assert.throws(() => resultsBody(resultsResolved(0)), /RESULT_UNAVAILABLE/);
  let manual = completeXi(resultsStarted(), hostId);
  manual = changed(manual, { type: "SUBMIT_XI", participantId: hostId, atMs: 30, expectedDraftRevision: participant(manual, hostId).draftState.revision });
  assert.throws(() => resultsBody(manual), /RESULTS_NOT_READY/);
});

test("results are an explicit projection of the submitted XI, stored evaluation and authoritative twenty-match campaign", () => {
  const state = resultsResolved();
  const round = state.rounds[0]!; assert.equal(round.phase, "RESOLVED"); if (round.phase !== "RESOLVED") return;
  const [first, second] = [hostId, memberId].map(id => round.resolution.challengeResult!.campaigns.find(c => c.participantId === id)!);
  assert.notDeepEqual(participant(state, hostId).draftState.picks, participant(state, memberId).draftState.picks);
  assert.notDeepEqual(first!.evaluation.adjustedStrength, second!.evaluation.adjustedStrength);
  assert.notDeepEqual(first!.aggregate, second!.aggregate);
  assert.notDeepEqual(first!.matches, second!.matches);
  for (const targetId of [hostId, memberId]) {
    const body = resultsBody(state, hostId, targetId);
    const campaign: DraftOffCampaignResult = round.resolution.challengeResult!.campaigns.find(row => row.participantId === targetId)!;
    assertResultsAgainstState(body, state, targetId);
    assert.deepEqual(body.players.map(row => row.battingPosition), Array.from({ length: 11 }, (_, i) => i + 1));
    assert.deepEqual(body.players.map(row => row.playerTeamSeasonId), [...participant(state, targetId).draftState.picks].sort((a,b) => a.battingPosition-b.battingPosition).map(row => row.playerTeamSeasonId));
    assert.deepEqual(body.evaluation.strength, { overall: campaign.evaluation.adjustedStrength.overall, batting: campaign.evaluation.adjustedStrength.batting, bowling: campaign.evaluation.adjustedStrength.bowling });
    assert.deepEqual(body.campaign.aggregate, campaign.aggregate);
    body.campaign.matches.forEach((match, index) => {
      const raw = campaign.matches[index]!;
      assert.equal(match.matchId, raw.fixture.matchId); assert.equal(match.sequence, raw.fixture.sequence);
      assert.equal(match.resultType, raw.result.resultType); assert.equal(match.margin, raw.result.margin);
      for (const [innings, original] of [[match.firstInnings, raw.result.innings[0]], [match.secondInnings, raw.result.innings[1]]] as const) {
        assert.deepEqual(innings, { side: original.teamId === "draft-off-entry" ? "ENTRY" : "OPPONENT", runs: original.runs, wickets: original.wickets, balls: original.balls, allOut: original.allOut });
      }
      const profile = catalog.getOpponentProfiles(round.eraId).find(p => p.candidateId === match.opponent.profileId)!;
      assert.equal(match.opponent.seasonYear, catalog.getTeamSeasonsForEra(round.eraId).find(t => t.teamId === profile.teamId && t.seasonId === profile.seasonId)!.seasonYear);
    });
    const bytes = JSON.stringify(body);
    assert.ok(Buffer.byteLength(bytes) < DRAFT_OFF_RESULTS_MAX_BYTES);
    assert.doesNotMatch(bytes, /scenarioSeed|simulationSeed|challengeSeed|submissionHash|campaignHash|resultHash|internalScore|battingContributions|history|receipts|reconnectCredential|catalogFingerprint/);
    assert.ok(Object.isFrozen(body.players));
  }
});

test("service restores canonical results without new evaluation/reduction, receipts or storage writes", async () => {
  const repository = new InMemoryDraftOffRoomRepository(), clock = new ManualDraftOffClock(), state = resultsResolved();
  const record = { serializedCompetition: serializeDraftOffCompetition(state), receipts: {} };
  await repository.create(roomCode, record);
  const service = new DraftOffRoomService(catalog, repository, clock);
  try {
    const first = await service.readResults({ kind: "PARTICIPANT", participantId: memberId }, roomCode, hostId);
    assert.deepEqual(first, projectDraftOffParticipantResults(catalog, state, memberId, hostId));
    service.dispose();
    const restarted = new DraftOffRoomService(catalog, repository, clock);
    try {
      assert.deepEqual(await restarted.readResults({ kind: "PARTICIPANT", participantId: hostId }, roomCode, hostId), first);
      for (const targetId of [hostId, memberId]) {
        const view = await restarted.readResults({ kind: "PARTICIPANT", participantId: hostId }, roomCode, targetId);
        assertResultsAgainstState({ ok: true, version: 1, roomCode, ...view }, state, targetId);
      }
    }
    finally { restarted.dispose(); }
    assert.deepEqual(await repository.read(roomCode), record);
    const broken = structuredClone(state); const round = broken.rounds[0]!;
    assert.equal(round.phase, "RESOLVED"); if (round.phase !== "RESOLVED") return;
    Object.assign(round.resolution, { challengeResult: null });
    assert.throws(() => resultsBody(broken), /Invalid resolved campaign/);
  } finally { service.dispose(); }
});

test("results canonical player/opponent joins and strict presentation contract work in every era", () => {
  for (const eraId of catalog.getEraIds()) {
    const state = resultsResolved(1, eraId), body = resultsBody(state, memberId);
    assert.equal(body.eraId, eraId);
    assertResultsAgainstState(body, state, hostId);
    assert.equal(body.campaign.matches.length, 20);
    assert.ok(body.players.every(player => catalog.getPlayer(player.playerTeamSeasonId)?.eraId === eraId));
    for (const match of body.campaign.matches) {
      const profile = catalog.getOpponentProfiles(eraId).find(profile => profile.candidateId === match.opponent.profileId)!;
      assert.ok(profile);
      assert.equal(match.opponent.teamName, profile.teamName);
      assert.equal(match.opponent.seasonYear, catalog.getTeamSeasonsForEra(eraId).find(team => team.teamId === profile.teamId && team.seasonId === profile.seasonId)!.seasonYear);
    }
  }
});
