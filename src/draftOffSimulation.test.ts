import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson, canonicalSha256 } from "./eraDraftCanonical.js";
import type { EraDraftCatalog } from "./eraDraftData.js";
import { createEraDraftGame, reduceEraDraft } from "./eraDraftEngine.js";
import { evaluateSelectionLegality, getOpenBattingPositions } from "./eraDraftLegality.js";
import { opponentAsSimulationTeamV2 } from "./eraDraftOpponentRuntime.js";
import {
  buildDraftOffLeaderboard,
  deriveDraftOffFixtureSimulationSeed,
  deriveDraftOffGameplayXiIdentity,
  deriveDraftOffSeeds,
  deriveDraftOffSubmissionHash,
  generateDraftOffSchedule,
  simulateDraftOffChallenge,
  simulateDraftOffEntries,
} from "./draftOffSimulation.js";
import {
  DRAFT_OFF_ENTRY_TEAM_ID,
  DRAFT_OFF_MATCH_COUNT,
  type DraftOffCampaignAggregate,
} from "./draftOffTypes.js";
import { loadEraDraftCatalog } from "./eraDraftData.js";
import type { AwaitingPickState, EraDraftState, XiCompleteState } from "./eraDraftTypes.js";
import { buildStandingsV2, type SimulationTeamV2 } from "./simulationV2.js";
import { ERA_IDS, type EraId } from "./teamEvaluationV2.js";

const catalog = loadEraDraftCatalog();
const transitionSeedInput = {
  challengeSeed: "draft-off-milestone-1-transition",
  catalogFingerprint: catalog.fingerprint,
  eraId: "era-transition" as const,
  roundOrdinal: 1,
};

test("all eras schedule twenty fixtures from full frozen pools in complete non-repeating cycles", () => {
  for (const eraId of ERA_IDS) {
    const authoritativeIds = catalog.getOpponentProfiles(eraId).map((profile) => profile.candidateId).sort();
    const authoritativeSet = new Set(authoritativeIds);
    const scheduleHashes = new Set<string>();

    for (let seedIndex = 0; seedIndex < 8; seedIndex += 1) {
      const seeds = deriveDraftOffSeeds({
        ...transitionSeedInput,
        challengeSeed: `draft-off-schedule-property:${seedIndex}`,
        eraId,
      });
      const first = generateDraftOffSchedule({ catalog, eraId, roundOrdinal: 1, scheduleSeed: seeds.scheduleSeed });
      const repeated = generateDraftOffSchedule({ catalog, eraId, roundOrdinal: 1, scheduleSeed: seeds.scheduleSeed });
      scheduleHashes.add(first.scheduleHash);

      assert.equal(first.fixtures.length, DRAFT_OFF_MATCH_COUNT, eraId);
      assert.deepEqual(first.authoritativeOpponentProfileIds, authoritativeIds, eraId);
      assert.ok(first.fixtures.every((fixture) => authoritativeSet.has(fixture.opponentProfileId)), eraId);
      assert.deepEqual(repeated, first, eraId);

      const cycles = groupFixturesByCycle(first.fixtures);
      for (const [cycleOrdinal, fixtures] of cycles) {
        const ids = fixtures.map((fixture) => fixture.opponentProfileId);
        assert.equal(new Set(ids).size, ids.length, `${eraId} cycle ${cycleOrdinal}`);
        if (fixtures.length === authoritativeIds.length) {
          assert.deepEqual([...ids].sort(), authoritativeIds, `${eraId} cycle ${cycleOrdinal}`);
        } else {
          assert.equal(cycleOrdinal, Math.max(...cycles.keys()), `${eraId} partial cycle must be last`);
          assert.ok(ids.every((id) => authoritativeSet.has(id)), `${eraId} partial cycle membership`);
        }
      }
      for (let index = 1; index < first.fixtures.length; index += 1) {
        assert.notEqual(
          first.fixtures[index - 1]!.opponentProfileId,
          first.fixtures[index]!.opponentProfileId,
          `${eraId} immediate repeat at fixture ${index + 1}`,
        );
      }
    }
    assert.ok(scheduleHashes.size > 1, `${eraId} should vary across challenge seeds`);
  }
});

test("Transition challenge gives distinct XIs an identical schedule and authoritative NRR aggregates", () => {
  const seeds = deriveDraftOffSeeds(transitionSeedInput);
  const firstXi = draftXi(catalog, seeds.draftRootSeed, transitionSeedInput.eraId, "ASCENDING");
  const secondXi = draftXi(catalog, seeds.draftRootSeed, transitionSeedInput.eraId, "DESCENDING");
  assert.notDeepEqual(firstXi.picks, secondXi.picks);

  const input = {
    catalog,
    challengeSeed: transitionSeedInput.challengeSeed,
    eraId: transitionSeedInput.eraId,
    roundOrdinal: 1,
    participants: [
      { participantId: "participant-alpha", displayName: "Alpha", xi: firstXi },
      { participantId: "participant-bravo", displayName: "Bravo", xi: secondXi },
    ],
  } as const;
  const first = simulateDraftOffChallenge(input);
  const extractedCore = simulateDraftOffEntries(input);
  const repeated = simulateDraftOffChallenge(input);
  const firstBytes = new TextEncoder().encode(canonicalJson(first));
  const repeatedBytes = new TextEncoder().encode(canonicalJson(repeated));

  assert.deepEqual(repeated, first);
  assert.equal(canonicalJson(extractedCore), canonicalJson(first));
  assert.deepEqual(repeatedBytes, firstBytes);
  assert.equal(canonicalSha256(repeated), canonicalSha256(first));
  assert.equal(first.resultHash, "185061964f5960f8f2304436b68c184d8e0f0b9a1169b60c09491dd2a115c501");
  assert.equal(first.campaigns.length, 2);
  const fixtureViews = first.campaigns.map((campaign) => campaign.matches.map((match) => match.fixture));
  assert.deepEqual(fixtureViews[1], fixtureViews[0]);
  assert.deepEqual(fixtureViews[0], first.schedule.fixtures);
  assert.equal(new Set(first.schedule.fixtures.map((fixture) => fixture.scenarioSeed)).size, DRAFT_OFF_MATCH_COUNT);
  assert.notEqual(first.campaigns[0]!.gameplayXiIdentity, first.campaigns[1]!.gameplayXiIdentity);
  for (let index = 0; index < DRAFT_OFF_MATCH_COUNT; index += 1) {
    const left = first.campaigns[0]!.matches[index]!;
    const right = first.campaigns[1]!.matches[index]!;
    assert.deepEqual(left.fixture, right.fixture);
    assert.notEqual(left.simulationSeed, right.simulationSeed);
    assert.equal(left.simulationSeed, deriveDraftOffFixtureSimulationSeed({
      fixtureScenarioSeed: left.fixture.scenarioSeed,
      gameplayXiIdentity: first.campaigns[0]!.gameplayXiIdentity,
    }));
    assert.equal(right.simulationSeed, deriveDraftOffFixtureSimulationSeed({
      fixtureScenarioSeed: right.fixture.scenarioSeed,
      gameplayXiIdentity: first.campaigns[1]!.gameplayXiIdentity,
    }));
  }

  const counts = countOpponents(first.schedule.fixtures.map((fixture) => fixture.opponentProfileId));
  assert.equal(counts.size, 10);
  assert.ok([...counts.values()].every((count) => count === 2));

  for (const campaign of first.campaigns) {
    assert.equal(campaign.aggregate.played, DRAFT_OFF_MATCH_COUNT);
    assert.equal(campaign.aggregate.won + campaign.aggregate.lost, DRAFT_OFF_MATCH_COUNT);
    assert.equal(campaign.aggregate.points, campaign.aggregate.won * 2);
    assert.deepEqual(campaign.aggregate, authoritativeAggregate(campaign, catalog, transitionSeedInput.eraId));
    const xi = input.participants.find((participant) => participant.participantId === campaign.participantId)!.xi;
    assert.equal(campaign.submissionHash, deriveDraftOffSubmissionHash({
      catalogFingerprint: catalog.fingerprint,
      eraId: transitionSeedInput.eraId,
      xi,
    }));
  }

  console.log(`DRAFT_OFF_M1_EVIDENCE ${JSON.stringify({
    scheduleHash: first.schedule.scheduleHash,
    fixtureOpponentIds: first.schedule.fixtures.map((fixture) => fixture.opponentProfileId),
    scenarioSeeds: first.schedule.fixtures.map((fixture) => fixture.scenarioSeed),
    campaigns: first.campaigns.map((campaign) => ({
      participantId: campaign.participantId,
      gameplayXiIdentity: campaign.gameplayXiIdentity,
      simulationSeeds: campaign.matches.map((match) => match.simulationSeed),
    })),
    leaderboard: first.leaderboard.map((row) => ({
      rank: row.rank,
      participantId: row.participantId,
      played: row.played,
      won: row.won,
      lost: row.lost,
      points: row.points,
      netRunRate: row.netRunRate,
    })),
    canonicalBytes: firstBytes.byteLength,
    resultHash: first.resultHash,
    rerunHash: repeated.resultHash,
  })}`);
});

test("single resolved entry uses the frozen M1/M1.1 campaign path without weakening the challenge contract", () => {
  const seeds = deriveDraftOffSeeds(transitionSeedInput);
  const xi = draftXi(catalog, seeds.draftRootSeed, transitionSeedInput.eraId, "ASCENDING");
  const single = simulateDraftOffEntries({
    catalog,
    challengeSeed: transitionSeedInput.challengeSeed,
    eraId: transitionSeedInput.eraId,
    roundOrdinal: 1,
    participants: [{ participantId: "uncontested", displayName: "Uncontested", xi }],
  });
  assert.equal(single.campaigns.length, 1);
  assert.equal(single.leaderboard.length, 1);
  assert.equal(single.leaderboard[0]!.rank, 1);
  assert.equal(single.campaigns[0]!.matches.length, DRAFT_OFF_MATCH_COUNT);
  assert.throws(() => simulateDraftOffChallenge({
    catalog,
    challengeSeed: transitionSeedInput.challengeSeed,
    eraId: transitionSeedInput.eraId,
    roundOrdinal: 1,
    participants: [{ participantId: "uncontested", displayName: "Uncontested", xi }],
  }), /between two and eight/);
});

test("fixture randomness and normalized match outputs are independent of participant identity", () => {
  const seeds = deriveDraftOffSeeds(transitionSeedInput);
  const firstXi = draftXi(catalog, seeds.draftRootSeed, transitionSeedInput.eraId, "ASCENDING");
  const secondXi = draftXi(catalog, seeds.draftRootSeed, transitionSeedInput.eraId, "DESCENDING");
  const first = simulateDraftOffChallenge({
    catalog,
    challengeSeed: transitionSeedInput.challengeSeed,
    eraId: transitionSeedInput.eraId,
    roundOrdinal: 1,
    participants: [
      { participantId: "identity-a", displayName: "First Name", xi: firstXi },
      { participantId: "identity-b", displayName: "Second Name", xi: secondXi },
    ],
  });
  const renamedAndReordered = simulateDraftOffChallenge({
    catalog,
    challengeSeed: transitionSeedInput.challengeSeed,
    eraId: transitionSeedInput.eraId,
    roundOrdinal: 1,
    participants: [
      { participantId: "identity-z", displayName: "Renamed Z", xi: secondXi },
      { participantId: "identity-y", displayName: "Renamed Y", xi: firstXi },
    ],
  });
  const identicalXiParticipants = simulateDraftOffChallenge({
    catalog,
    challengeSeed: transitionSeedInput.challengeSeed,
    eraId: transitionSeedInput.eraId,
    roundOrdinal: 1,
    participants: [
      { participantId: "same-xi-one", displayName: "Same XI One", xi: firstXi },
      { participantId: "same-xi-two", displayName: "Same XI Two", xi: firstXi },
    ],
  });

  assert.deepEqual(identicalXiParticipants.campaigns[0]!.matches, identicalXiParticipants.campaigns[1]!.matches);
  assert.deepEqual(identicalXiParticipants.campaigns[0]!.aggregate, identicalXiParticipants.campaigns[1]!.aggregate);
  assert.equal(identicalXiParticipants.campaigns[0]!.submissionHash, identicalXiParticipants.campaigns[1]!.submissionHash);
  assert.equal(identicalXiParticipants.campaigns[0]!.gameplayXiIdentity, identicalXiParticipants.campaigns[1]!.gameplayXiIdentity);
  assert.notEqual(identicalXiParticipants.campaigns[0]!.resultIdentityHash, identicalXiParticipants.campaigns[1]!.resultIdentityHash);
  assert.deepEqual(renamedAndReordered.schedule, first.schedule);
  const firstByXi = new Map(first.campaigns.map((campaign) => [campaign.gameplayXiIdentity, campaign]));
  const renamedByXi = new Map(renamedAndReordered.campaigns.map((campaign) => [campaign.gameplayXiIdentity, campaign]));
  assert.deepEqual([...renamedByXi.keys()].sort(), [...firstByXi.keys()].sort());
  for (const [gameplayXiIdentity, campaign] of firstByXi) {
    assert.deepEqual(renamedByXi.get(gameplayXiIdentity)?.matches, campaign.matches);
    assert.deepEqual(renamedByXi.get(gameplayXiIdentity)?.aggregate, campaign.aggregate);
  }
  assert.equal(deriveDraftOffGameplayXiIdentity({
    catalogFingerprint: catalog.fingerprint,
    eraId: transitionSeedInput.eraId,
    xi: firstXi,
  }), deriveDraftOffGameplayXiIdentity({
    catalogFingerprint: catalog.fingerprint,
    eraId: transitionSeedInput.eraId,
    xi: { ...firstXi, picks: [...firstXi.picks].reverse() },
  }));
  assert.equal(deriveDraftOffGameplayXiIdentity({
    catalogFingerprint: catalog.fingerprint,
    eraId: transitionSeedInput.eraId,
    xi: firstXi,
  }), deriveDraftOffGameplayXiIdentity({
    catalogFingerprint: catalog.fingerprint,
    eraId: transitionSeedInput.eraId,
    xi: {
      ...firstXi,
      rootSeed: "irrelevant-draft-history-seed",
      revision: firstXi.revision + 100,
      rngCounters: { normalSpin: 99, voluntaryRespin: 99, deadSpinRecovery: 99 },
      respin: { status: "USED" },
      history: [],
    },
  }));
  assert.ok(first.campaigns.flatMap((campaign) => campaign.matches)
    .every((match) => match.result.firstBattingTeamId === DRAFT_OFF_ENTRY_TEAM_ID
      || match.result.chasingTeamId === DRAFT_OFF_ENTRY_TEAM_ID));
  const sharedRandomness = canonicalJson({
    seeds: first.seeds,
    schedule: first.schedule,
    campaignRandomness: first.campaigns.map((campaign) => ({
      gameplayXiIdentity: campaign.gameplayXiIdentity,
      simulationSeeds: campaign.matches.map((match) => match.simulationSeed),
    })),
  });
  for (const forbidden of [
    "identity-a", "identity-b", "First Name", "Second Name",
    "identity-y", "identity-z", "Renamed Y", "Renamed Z",
  ]) {
    assert.equal(sharedRandomness.includes(forbidden), false, forbidden);
  }
});

test("leaderboard assigns shared ranks to exact points and NRR ties", () => {
  const seeds = deriveDraftOffSeeds(transitionSeedInput);
  const xi = draftXi(catalog, seeds.draftRootSeed, transitionSeedInput.eraId, "ASCENDING");
  const challenge = simulateDraftOffChallenge({
    catalog,
    challengeSeed: transitionSeedInput.challengeSeed,
    eraId: transitionSeedInput.eraId,
    roundOrdinal: 1,
    participants: [
      { participantId: "tie-b", displayName: "Tie B", xi },
      { participantId: "tie-a", displayName: "Tie A", xi },
    ],
  });
  const leaderboard = buildDraftOffLeaderboard(challenge.campaigns);
  assert.deepEqual(leaderboard.map((row) => ({ id: row.participantId, rank: row.rank })), [
    { id: "tie-a", rank: 1 },
    { id: "tie-b", rank: 1 },
  ]);
});

function draftXi(
  activeCatalog: EraDraftCatalog,
  rootSeed: string,
  eraId: EraId,
  strategy: "ASCENDING" | "DESCENDING",
): XiCompleteState {
  let state: EraDraftState = accepted(reduceEraDraft(
    activeCatalog,
    createEraDraftGame({ catalog: activeCatalog, rootSeed }),
    { type: "CHOOSE_ERA", eraId },
  ));
  while (state.phase !== "XI_COMPLETE") {
    state = accepted(reduceEraDraft(activeCatalog, state, { type: "SPIN" }));
    if (state.phase !== "AWAITING_PICK") throw new Error("Draft-Off fixture expected an active spin.");
    const choice = legalChoices(activeCatalog, state).sort((left, right) => {
      const identity = left.playerTeamSeasonId.localeCompare(right.playerTeamSeasonId);
      const position = left.battingPosition - right.battingPosition;
      return strategy === "ASCENDING" ? identity || position : -identity || -position;
    })[0];
    if (!choice) throw new Error("Draft-Off fixture spin exposed no legal choice.");
    state = accepted(reduceEraDraft(activeCatalog, state, {
      type: "LOCK_PLAYER",
      playerTeamSeasonId: choice.playerTeamSeasonId,
      battingPosition: choice.battingPosition,
    }));
  }
  return state;
}

function legalChoices(catalogInput: EraDraftCatalog, state: AwaitingPickState) {
  const context = { eraId: state.eraId, picks: state.picks, activeTeamSeasonId: state.currentSpin.teamSeasonId };
  return catalogInput.getCandidatesForTeamSeason(state.currentSpin.teamSeasonId)
    .flatMap((player) => getOpenBattingPositions(state.picks).map((battingPosition) => ({
      playerTeamSeasonId: player.playerTeamSeasonId,
      battingPosition,
    })))
    .filter((choice) => evaluateSelectionLegality(catalogInput, context, choice).available);
}

function authoritativeAggregate(
  campaign: ReturnType<typeof simulateDraftOffChallenge>["campaigns"][number],
  activeCatalog: EraDraftCatalog,
  eraId: EraId,
): DraftOffCampaignAggregate {
  const entrant: SimulationTeamV2 = {
    teamId: DRAFT_OFF_ENTRY_TEAM_ID,
    displayName: "Draft-Off XI",
    strength: {
      batting: campaign.evaluation.adjustedStrength.batting,
      bowling: campaign.evaluation.adjustedStrength.bowling,
      overall: campaign.evaluation.adjustedStrength.overall,
    },
  };
  const row = buildStandingsV2(
    [entrant, ...activeCatalog.getOpponentProfiles(eraId).map(opponentAsSimulationTeamV2)],
    campaign.matches.map((match) => match.result),
  ).find((candidate) => candidate.teamId === DRAFT_OFF_ENTRY_TEAM_ID)!;
  return {
    played: row.played,
    won: row.won,
    lost: row.lost,
    points: row.points,
    runsFor: row.runsFor,
    ballsFacedForNrr: row.ballsFacedForNrr,
    runsAgainst: row.runsAgainst,
    ballsBowledForNrr: row.ballsBowledForNrr,
    netRunRate: row.netRunRate,
  };
}

function accepted(result: ReturnType<typeof reduceEraDraft>): EraDraftState {
  if (!result.ok) throw new Error(result.error.message);
  return result.state;
}

function countOpponents(ids: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
}

function groupFixturesByCycle(
  fixtures: ReturnType<typeof generateDraftOffSchedule>["fixtures"],
): Map<number, typeof fixtures[number][]> {
  const cycles = new Map<number, typeof fixtures[number][]>();
  for (const fixture of fixtures) {
    const cycle = cycles.get(fixture.cycleOrdinal) ?? [];
    cycle.push(fixture);
    cycles.set(fixture.cycleOrdinal, cycle);
  }
  return cycles;
}
