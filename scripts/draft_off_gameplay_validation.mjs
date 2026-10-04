import assert from "node:assert/strict";

import { canonicalSha256 } from "../dist/eraDraftCanonical.js";
import { loadEraDraftCatalog } from "../dist/eraDraftData.js";
import { createEraDraftGame, reduceEraDraft } from "../dist/eraDraftEngine.js";
import { opponentAsSimulationTeamV2 } from "../dist/eraDraftOpponentRuntime.js";
import { projectEraDraftPublicState } from "../dist/eraDraftProjection.js";
import { evaluateEraDraftXi } from "../dist/eraDraftReveal.js";
import { deriveDraftOffSeeds, generateDraftOffSchedule, simulateDraftOffChallenge } from "../dist/draftOffSimulation.js";
import { DRAFT_OFF_ENTRY_TEAM_ID, DRAFT_OFF_MATCH_COUNT } from "../dist/draftOffTypes.js";
import { buildStandingsV2, SIMULATION_V2_VERSION, simulateMatchV2 } from "../dist/simulationV2.js";
import { ERA_IDS, TEAM_EVALUATION_V2_VERSION } from "../dist/teamEvaluationV2.js";

const VALIDATION_VERSION = "ipl-draft-off-gameplay-validation/v1";
const XI_VARIANCE_VERSION = "ipl-draft-off-xi-variance-experiment/v1";
const MODEL = process.argv.includes("--xi-specific") ? "EXPERIMENTAL_XI_SPECIFIC" : "PRODUCTION_MODEL_B";
const TRIALS_PER_ERA = numericArgument("--trials", 20);
const PHASE_COVERAGE_CAP = numericArgument("--phase-cap", 0);
const PHASE_SHARE_FLOORS = Object.freeze({
  powerplay: 0.281242,
  middle: 0.460911,
  death: 0.154672,
});
const STRATEGIES = ["BALANCED", "BATTING_FIRST", "BOWLING_FIRST", "STAR_FIRST", "BASELINE"];
const ERA_LABELS = {
  "era-foundation": "Foundation",
  "era-expansion": "Expansion",
  "era-transition": "Transition",
  "era-modern-pre-impact": "Modern Pre-Impact",
  "era-impact": "Impact",
};
const TIER_RANK = { violet: 5, gold: 4, cobalt: 3, emerald: 2, slate: 1 };
const FIT_RANK = { NATURAL: 5, ACCEPTABLE: 4, UNKNOWN: 3, STRETCH: 2, MAJOR_STRETCH: 1 };
const WORKLOAD_RANK = { FRONTLINE: 4, SUPPORT: 3, OCCASIONAL: 2, NONE: 1 };

const startedAt = performance.now();
const catalog = loadEraDraftCatalog();
const records = [];
const trialGroups = [];

for (const eraId of ERA_IDS) {
  for (let trial = 1; trial <= TRIALS_PER_ERA; trial += 1) {
    const challengeSeed = `${VALIDATION_VERSION}:${eraId}:trial-${String(trial).padStart(2, "0")}`;
    const seeds = deriveDraftOffSeeds({
      challengeSeed,
      catalogFingerprint: catalog.fingerprint,
      eraId,
      roundOrdinal: 1,
    });
    const drafted = STRATEGIES.map((strategy) => draftXi({ eraId, rootSeed: seeds.draftRootSeed, strategy }));
    const challengeInput = {
      catalog,
      challengeSeed,
      eraId,
      roundOrdinal: 1,
      participants: drafted.map((entry) => ({
        participantId: entry.strategy,
        displayName: entry.strategy,
        xi: entry.xi,
      })),
    };
    const result = MODEL === "EXPERIMENTAL_XI_SPECIFIC"
      ? simulateXiSpecificChallenge(challengeInput)
      : simulateDraftOffChallenge(challengeInput);
    assert.equal(result.campaigns.length, STRATEGIES.length);
    const canonicalFixtures = result.schedule.fixtures;
    assert.equal(canonicalFixtures.length, DRAFT_OFF_MATCH_COUNT);
    for (const campaign of result.campaigns) {
      assert.deepEqual(campaign.matches.map((match) => match.fixture), canonicalFixtures);
    }

    const byStrategy = new Map(drafted.map((entry) => [entry.strategy, entry]));
    const rankByStrategy = new Map(result.leaderboard.map((row) => [row.participantId, row.rank]));
    const groupRecords = result.campaigns.map((campaign) => {
      const draft = byStrategy.get(campaign.participantId);
      assert.ok(draft);
      const tierCounts = countBy(draft.publicXi.picks, (pick) => pick.tierAppearance);
      const fitCounts = countBy(draft.publicXi.picks, (pick) => pick.presentationFit);
      const roleCounts = countBy(draft.publicXi.picks, (pick) => pick.displayRole);
      const record = {
        eraId,
        eraLabel: ERA_LABELS[eraId],
        trial,
        challengeSeed,
        scheduleHash: result.schedule.scheduleHash,
        strategy: campaign.participantId,
        playerIds: draft.publicXi.picks.map((pick) => pick.playerId).sort(),
        playerNames: draft.publicXi.picks
          .slice()
          .sort((left, right) => left.battingPosition - right.battingPosition)
          .map((pick) => pick.playerName),
        spinSequence: draft.spinSequence,
        respinUsed: draft.publicXi.status.respinStatus === "USED",
        tierCounts,
        fitCounts,
        roleCounts,
        frontlineBowlers: campaign.evaluation.diagnostics.bowlingWorkloadCounts.FRONTLINE,
        supportBowlers: campaign.evaluation.diagnostics.bowlingWorkloadCounts.SUPPORT,
        deployedBowlingUnits: campaign.evaluation.diagnostics.deployedBowlingUnits,
        construction: campaign.construction ?? constructionEffect(campaign.evaluation, PHASE_COVERAGE_CAP),
        evaluation: campaign.evaluation.adjustedStrength,
        gameplayXiIdentity: campaign.gameplayXiIdentity ?? campaign.submissionHash,
        played: campaign.aggregate.played,
        won: campaign.aggregate.won,
        lost: campaign.aggregate.lost,
        points: campaign.aggregate.points,
        nrr: campaign.aggregate.netRunRate,
        rank: rankByStrategy.get(campaign.participantId),
        opponentResults: campaign.matches.map((match) => ({
          opponentProfileId: match.fixture.opponentProfileId,
          won: match.result.winnerTeamId === "draft-off-entry",
        })),
      };
      assert.equal(record.played, 20);
      assert.equal(record.won + record.lost, 20);
      records.push(record);
      return record;
    });
    trialGroups.push({ eraId, trial, challengeSeed, scheduleHash: result.schedule.scheduleHash, records: groupRecords });
  }
}

const report = {
  validationVersion: VALIDATION_VERSION,
  configuration: {
    model: MODEL,
    eras: ERA_IDS.map((eraId) => ({ eraId, label: ERA_LABELS[eraId], opponentPoolSize: catalog.getOpponentProfiles(eraId).length })),
    trialsPerEra: TRIALS_PER_ERA,
    strategies: STRATEGIES,
    completedXis: records.length,
    simulatedMatches: records.length * DRAFT_OFF_MATCH_COUNT,
    sharedFixturesVerifiedForEveryTrial: true,
    catalogFingerprint: catalog.fingerprint,
    xiVarianceVersion: MODEL === "EXPERIMENTAL_XI_SPECIFIC" ? XI_VARIANCE_VERSION : "production",
    experimentalPhaseCoverage: {
      enabled: PHASE_COVERAGE_CAP > 0,
      maximumBowlingStrengthDeduction: PHASE_COVERAGE_CAP,
      phaseShareFloors: PHASE_SHARE_FLOORS,
      baseline: "all-era p10 among 125 committed representative XIs with five deployed bowling units",
    },
  },
  draftDiversity: draftDiversity(records, trialGroups),
  byStrategy: Object.fromEntries(STRATEGIES.map((strategy) => [strategy, summarize(records.filter((row) => row.strategy === strategy))])),
  byEra: Object.fromEntries(ERA_IDS.map((eraId) => [eraId, summarizeEra(records.filter((row) => row.eraId === eraId), trialGroups.filter((group) => group.eraId === eraId))])),
  byEraAndStrategy: Object.fromEntries(ERA_IDS.map((eraId) => [
    eraId,
    Object.fromEntries(STRATEGIES.map((strategy) => [
      strategy,
      compactPerformance(records.filter((row) => row.eraId === eraId && row.strategy === strategy)),
    ])),
  ])),
  pairedStrategyDifferences: pairedStrategyDifferences(trialGroups),
  construction: constructionSummary(records),
  signalVersusRandomness: signalVersusRandomness(records, trialGroups),
  opponentDifficulty: opponentDifficulty(records),
  representativeExamples: representativeExamples(trialGroups),
  runtime: {
    milliseconds: round(performance.now() - startedAt, 3),
    seconds: round((performance.now() - startedAt) / 1000, 3),
  },
};

console.log(JSON.stringify(report, null, 2));

function simulateXiSpecificChallenge(input) {
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
  const environment = input.catalog.getEnvironment(input.eraId);
  if (!environment) throw new Error(`Missing environment for ${input.eraId}.`);
  const profiles = input.catalog.getOpponentProfiles(input.eraId);
  const profileById = new Map(profiles.map((profile) => [profile.candidateId, profile]));
  const opponentTeams = profiles.map(opponentAsSimulationTeamV2);
  const campaigns = input.participants.slice().sort((left, right) => left.participantId.localeCompare(right.participantId)).map((participant) => {
    const evaluation = evaluateEraDraftXi(input.catalog, participant.xi);
    const construction = constructionEffect(evaluation, PHASE_COVERAGE_CAP);
    const gameplayXiIdentity = canonicalSha256({
      version: XI_VARIANCE_VERSION,
      domain: "gameplay-xi-identity",
      catalogFingerprint: input.catalog.fingerprint,
      simulationVersion: SIMULATION_V2_VERSION,
      teamEvaluationVersion: TEAM_EVALUATION_V2_VERSION,
      eraId: input.eraId,
      orderedXi: participant.xi.picks.slice()
        .sort((left, right) => left.battingPosition - right.battingPosition)
        .map((pick) => ({
          playerTeamSeasonId: pick.playerTeamSeasonId,
          battingPosition: pick.battingPosition,
        })),
    });
    const entrant = {
      teamId: DRAFT_OFF_ENTRY_TEAM_ID,
      displayName: "Draft-Off XI",
      strength: {
        batting: evaluation.adjustedStrength.batting,
        bowling: evaluation.adjustedStrength.bowling - construction.appliedBowlingDeduction,
        overall: (evaluation.adjustedStrength.batting
          + evaluation.adjustedStrength.bowling - construction.appliedBowlingDeduction) / 2,
      },
    };
    const matches = schedule.fixtures.map((fixture) => {
      const profile = profileById.get(fixture.opponentProfileId);
      if (!profile) throw new Error(`Unknown opponent profile ${fixture.opponentProfileId}.`);
      const stochasticMatchSeed = xiFixtureSeed(fixture.scenarioSeed, gameplayXiIdentity);
      return {
        fixture,
        stochasticMatchSeed,
        result: simulateMatchV2({
          seed: stochasticMatchSeed,
          matchId: fixture.matchId,
          teamA: entrant,
          teamB: opponentAsSimulationTeamV2(profile),
          environment,
        }),
      };
    });
    const row = buildStandingsV2([entrant, ...opponentTeams], matches.map((match) => match.result))
      .find((candidate) => candidate.teamId === DRAFT_OFF_ENTRY_TEAM_ID);
    if (!row || row.played !== DRAFT_OFF_MATCH_COUNT) throw new Error("XI-specific campaign did not produce twenty matches.");
    return {
      participantId: participant.participantId,
      gameplayXiIdentity,
      evaluation,
      construction,
      matches,
      aggregate: {
        played: row.played,
        won: row.won,
        lost: row.lost,
        points: row.points,
        runsFor: row.runsFor,
        ballsFacedForNrr: row.ballsFacedForNrr,
        runsAgainst: row.runsAgainst,
        ballsBowledForNrr: row.ballsBowledForNrr,
        netRunRate: row.netRunRate,
      },
    };
  });
  const leaderboard = campaigns.slice().sort((left, right) =>
    right.aggregate.points - left.aggregate.points
    || right.aggregate.netRunRate - left.aggregate.netRunRate
    || left.participantId.localeCompare(right.participantId))
    .map((campaign, index, sorted) => {
      const previous = sorted[index - 1];
      const tied = previous
        && previous.aggregate.points === campaign.aggregate.points
        && previous.aggregate.netRunRate === campaign.aggregate.netRunRate;
      return {
        participantId: campaign.participantId,
        rank: tied ? sorted.findIndex((candidate) =>
          candidate.aggregate.points === campaign.aggregate.points
          && candidate.aggregate.netRunRate === campaign.aggregate.netRunRate) + 1 : index + 1,
      };
    });
  assertXiSeedInvariants(campaigns, schedule.fixtures);
  return { seeds, schedule, campaigns, leaderboard };
}

function assertXiSeedInvariants(campaigns, fixtures) {
  for (const fixture of fixtures) {
    const matches = campaigns.map((campaign) => campaign.matches[fixture.sequence - 1]);
    const byXi = new Map();
    for (let index = 0; index < campaigns.length; index += 1) {
      const identity = campaigns[index].gameplayXiIdentity;
      const seed = matches[index].stochasticMatchSeed;
      assert.equal(seed, xiFixtureSeed(fixture.scenarioSeed, identity));
      assert.equal(seed, xiFixtureSeed(fixture.scenarioSeed, identity));
      if (byXi.has(identity)) assert.equal(seed, byXi.get(identity));
      else byXi.set(identity, seed);
    }
    assert.equal(new Set(byXi.values()).size, byXi.size);
  }
}

function xiFixtureSeed(fixtureScenarioSeed, gameplayXiIdentity) {
  return canonicalSha256({
    version: XI_VARIANCE_VERSION,
    domain: "xi-fixture-residual",
    fixtureScenarioSeed,
    gameplayXiIdentity,
  });
}

function draftXi({ eraId, rootSeed, strategy }) {
  let state = accepted(reduceEraDraft(catalog, createEraDraftGame({ catalog, rootSeed }), { type: "CHOOSE_ERA", eraId }));
  const spinSequence = [];
  let consideredRespin = false;
  while (state.phase !== "XI_COMPLETE") {
    if (state.phase === "AWAITING_SPIN") state = accepted(reduceEraDraft(catalog, state, { type: "SPIN" }));
    if (state.phase !== "AWAITING_PICK") throw new Error(`Expected AWAITING_PICK, received ${state.phase}.`);
    let view = projectEraDraftPublicState(catalog, state);
    assert.equal(view.phase, "AWAITING_PICK");
    spinSequence.push(`${view.currentSpin.teamSeasonId}:NORMAL`);
    if (!consideredRespin && shouldRespin(strategy, view)) {
      consideredRespin = true;
      const response = reduceEraDraft(catalog, state, { type: "RESPIN" });
      if (response.ok) {
        state = response.state;
        view = projectEraDraftPublicState(catalog, state);
        assert.equal(view.phase, "AWAITING_PICK");
        spinSequence.push(`${view.currentSpin.teamSeasonId}:RESPIN`);
      }
    }
    const choice = choose(strategy, view);
    state = accepted(reduceEraDraft(catalog, state, {
      type: "LOCK_PLAYER",
      playerTeamSeasonId: choice.candidate.playerTeamSeasonId,
      battingPosition: choice.position.battingPosition,
    }));
  }
  const publicXi = projectEraDraftPublicState(catalog, state);
  assert.equal(publicXi.phase, "XI_COMPLETE");
  return { strategy, xi: state, publicXi, spinSequence };
}

function shouldRespin(strategy, view) {
  if (strategy === "BASELINE" || view.status.respinStatus !== "AVAILABLE" || view.status.pickCount > 5) return false;
  const choices = availableChoices(view);
  if (choices.length === 0) return false;
  if (strategy === "STAR_FIRST") {
    return !choices.some(({ candidate }) => TIER_RANK[candidate.tierAppearance] >= TIER_RANK.gold);
  }
  if (strategy === "BATTING_FIRST") {
    return Math.max(...choices.map(({ candidate }) => candidate.historicalStats.currentSeason.batting.runs)) < 250;
  }
  if (strategy === "BOWLING_FIRST") {
    return Math.max(...choices.map(({ candidate }) => candidate.historicalStats.currentSeason.bowling.wickets)) < 10;
  }
  return !choices.some(({ candidate, position }) =>
    TIER_RANK[candidate.tierAppearance] >= TIER_RANK.cobalt
    && FIT_RANK[position.presentationFit] >= FIT_RANK.ACCEPTABLE);
}

function choose(strategy, view) {
  const choices = availableChoices(view);
  if (choices.length === 0) throw new Error(`${strategy} has no legal choice at pick ${view.status.pickCount + 1}.`);
  if (strategy === "BASELINE") return choices[0];
  const comparator = strategy === "BALANCED" ? compareBalanced(view)
    : strategy === "BATTING_FIRST" ? compareBatting
      : strategy === "BOWLING_FIRST" ? compareBowling
        : compareStar;
  return choices.slice().sort((left, right) => comparator(left, right) || stableChoice(left, right))[0];
}

function availableChoices(view) {
  return view.candidates.flatMap((candidate) => candidate.positions
    .filter((position) => position.available)
    .map((position) => ({ candidate, position })));
}

function compareBalanced(view) {
  const needsKeeper = !view.status.hasWicketkeeper && view.status.pickCount >= 7;
  const currentBowling = view.picks.filter((pick) => pick.bowlingWorkloadClass === "FRONTLINE").length
    + 0.5 * view.picks.filter((pick) => pick.bowlingWorkloadClass === "SUPPORT").length;
  const needsBowling = currentBowling < Math.min(4, Math.max(1, view.status.pickCount / 2));
  return (left, right) => descending(needsKeeper && left.candidate.keeperCapability === "CONFIRMED", needsKeeper && right.candidate.keeperCapability === "CONFIRMED")
    || descending(needsBowling ? WORKLOAD_RANK[left.candidate.bowlingWorkloadClass] : 0, needsBowling ? WORKLOAD_RANK[right.candidate.bowlingWorkloadClass] : 0)
    || descending(TIER_RANK[left.candidate.tierAppearance], TIER_RANK[right.candidate.tierAppearance])
    || descending(FIT_RANK[left.position.presentationFit], FIT_RANK[right.position.presentationFit])
    || descending(visibleCombinedEvidence(left.candidate), visibleCombinedEvidence(right.candidate));
}

function compareBatting(left, right) {
  return descending(FIT_RANK[left.position.presentationFit], FIT_RANK[right.position.presentationFit])
    || descending(left.candidate.historicalStats.currentSeason.batting.runs, right.candidate.historicalStats.currentSeason.batting.runs)
    || descending(nullable(left.candidate.historicalStats.currentSeason.batting.strikeRate), nullable(right.candidate.historicalStats.currentSeason.batting.strikeRate))
    || descending(TIER_RANK[left.candidate.tierAppearance], TIER_RANK[right.candidate.tierAppearance]);
}

function compareBowling(left, right) {
  return descending(WORKLOAD_RANK[left.candidate.bowlingWorkloadClass], WORKLOAD_RANK[right.candidate.bowlingWorkloadClass])
    || descending(left.candidate.historicalStats.currentSeason.bowling.wickets, right.candidate.historicalStats.currentSeason.bowling.wickets)
    || ascending(nullable(left.candidate.historicalStats.currentSeason.bowling.economy, Number.POSITIVE_INFINITY), nullable(right.candidate.historicalStats.currentSeason.bowling.economy, Number.POSITIVE_INFINITY))
    || descending(TIER_RANK[left.candidate.tierAppearance], TIER_RANK[right.candidate.tierAppearance])
    || descending(FIT_RANK[left.position.presentationFit], FIT_RANK[right.position.presentationFit]);
}

function compareStar(left, right) {
  return descending(TIER_RANK[left.candidate.tierAppearance], TIER_RANK[right.candidate.tierAppearance])
    || descending(visibleCombinedEvidence(left.candidate), visibleCombinedEvidence(right.candidate))
    || descending(FIT_RANK[left.position.presentationFit], FIT_RANK[right.position.presentationFit]);
}

function visibleCombinedEvidence(candidate) {
  const stats = candidate.historicalStats.currentSeason;
  return stats.batting.runs + stats.bowling.wickets * 20;
}

function stableChoice(left, right) {
  return left.candidate.playerTeamSeasonId.localeCompare(right.candidate.playerTeamSeasonId)
    || left.position.battingPosition - right.position.battingPosition;
}

function accepted(result) {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.state;
}

function summarize(rows) {
  return {
    count: rows.length,
    completionRate: rows.length === 0 ? null : 1,
    respinUsageRate: mean(rows.map((row) => row.respinUsed ? 1 : 0)),
    wins: distribution(rows.map((row) => row.won)),
    points: distribution(rows.map((row) => row.points)),
    nrr: distribution(rows.map((row) => row.nrr)),
    evaluationOverall: distribution(rows.map((row) => row.evaluation.overall)),
    evaluationBatting: distribution(rows.map((row) => row.evaluation.batting)),
    evaluationBowling: distribution(rows.map((row) => row.evaluation.bowling)),
    firstPlaceRate: mean(rows.map((row) => row.rank === 1 ? 1 : 0)),
    meanTierCounts: meanObject(rows.map((row) => row.tierCounts), ["violet", "gold", "cobalt", "emerald", "slate"]),
    meanFitCounts: meanObject(rows.map((row) => row.fitCounts), ["NATURAL", "ACCEPTABLE", "UNKNOWN", "STRETCH", "MAJOR_STRETCH"]),
    meanRoleCounts: meanObject(rows.map((row) => row.roleCounts), ["BATTER", "WICKETKEEPER_BATTER", "ALL_ROUNDER", "BOWLER", "UNKNOWN"]),
    meanFrontlineBowlers: mean(rows.map((row) => row.frontlineBowlers)),
    meanSupportBowlers: mean(rows.map((row) => row.supportBowlers)),
    meanDeployedBowlingUnits: mean(rows.map((row) => row.deployedBowlingUnits)),
  };
}

function constructionEffect(evaluation, cap) {
  const totalCapacity = evaluation.diagnostics.bowlingCapacity;
  const family = evaluation.diagnostics.bowlingFamilyCapacity;
  const phase = evaluation.diagnostics.phaseBowlingCapacity;
  const phaseShares = Object.fromEntries(Object.keys(PHASE_SHARE_FLOORS).map((key) => [
    key,
    totalCapacity === 0 ? 0 : phase[key] / totalCapacity,
  ]));
  const relativeShortfalls = Object.fromEntries(Object.entries(PHASE_SHARE_FLOORS).map(([key, floor]) => [
    key,
    Math.max(0, (floor - phaseShares[key]) / floor),
  ]));
  const severity = Math.max(...Object.values(relativeShortfalls));
  return {
    totalCapacity,
    meaningfulOptions: evaluation.diagnostics.bowlingWorkloadCounts.FRONTLINE
      + evaluation.diagnostics.bowlingWorkloadCounts.SUPPORT,
    paceCapacity: family.PACE,
    spinCapacity: family.SPIN,
    unknownCapacity: family.UNKNOWN,
    paceShare: totalCapacity === 0 ? 0 : family.PACE / totalCapacity,
    spinShare: totalCapacity === 0 ? 0 : family.SPIN / totalCapacity,
    phaseShares,
    relativeShortfalls,
    severity,
    appliedBowlingDeduction: cap * severity,
  };
}

function constructionSummary(rows) {
  const buckets = {
    paceHeavy: rows.filter((row) => row.construction.paceShare >= 0.8),
    spinHeavy: rows.filter((row) => row.construction.spinShare >= 0.6),
    wellCovered: rows.filter((row) => row.construction.severity === 0),
    phaseDeficient: rows.filter((row) => row.construction.severity > 0),
    materiallyPhaseDeficient: rows.filter((row) => row.construction.severity >= 0.25),
  };
  return {
    distributions: {
      paceShare: distribution(rows.map((row) => row.construction.paceShare)),
      spinShare: distribution(rows.map((row) => row.construction.spinShare)),
      powerplayShare: distribution(rows.map((row) => row.construction.phaseShares.powerplay)),
      middleShare: distribution(rows.map((row) => row.construction.phaseShares.middle)),
      deathShare: distribution(rows.map((row) => row.construction.phaseShares.death)),
      severity: distribution(rows.map((row) => row.construction.severity)),
      appliedBowlingDeduction: distribution(rows.map((row) => row.construction.appliedBowlingDeduction)),
    },
    buckets: Object.fromEntries(Object.entries(buckets).map(([name, values]) => [name, {
      count: values.length,
      meanRawBowling: mean(values.map((row) => row.evaluation.bowling)),
      meanRawOverall: mean(values.map((row) => row.evaluation.overall)),
      meanPenalty: mean(values.map((row) => row.construction.appliedBowlingDeduction)),
      meanWins: mean(values.map((row) => row.won)),
      meanNrr: mean(values.map((row) => row.nrr)),
      firstPlaceRate: mean(values.map((row) => row.rank === 1 ? 1 : 0)),
    }])),
  };
}

function compactPerformance(rows) {
  return {
    count: rows.length,
    respinUsageRate: mean(rows.map((row) => row.respinUsed ? 1 : 0)),
    wins: distribution(rows.map((row) => row.won)),
    points: distribution(rows.map((row) => row.points)),
    nrr: distribution(rows.map((row) => row.nrr)),
    evaluationOverall: distribution(rows.map((row) => row.evaluation.overall)),
    firstPlaceRate: mean(rows.map((row) => row.rank === 1 ? 1 : 0)),
  };
}

function summarizeEra(rows, groups) {
  const summary = summarize(rows);
  const trialTieStats = groups.map((group) => {
    const points = group.records.map((row) => row.points);
    const maxPoints = Math.max(...points);
    return {
      anyPointsTie: new Set(points).size < points.length,
      topPointsTie: points.filter((pointsValue) => pointsValue === maxPoints).length > 1,
      allSamePoints: new Set(points).size === 1,
    };
  });
  return {
    ...summary,
    trialsWithAnyPointsTieRate: mean(trialTieStats.map((row) => row.anyPointsTie ? 1 : 0)),
    trialsWithTopPointsTieRate: mean(trialTieStats.map((row) => row.topPointsTie ? 1 : 0)),
    trialsWithAllStrategiesSamePointsRate: mean(trialTieStats.map((row) => row.allSamePoints ? 1 : 0)),
    correlationEvaluationToPoints: pearson(rows.map((row) => row.evaluation.overall), rows.map((row) => row.points)),
    correlationEvaluationToNrr: pearson(rows.map((row) => row.evaluation.overall), rows.map((row) => row.nrr)),
  };
}

function draftDiversity(allRows, groups) {
  const pairs = flatPairs(groups);
  const overlaps = pairs.map(({ left, right }) => overlap(left.playerIds, right.playerIds));
  const exactSpinPairs = pairs.filter(({ left, right }) => JSON.stringify(left.spinSequence) === JSON.stringify(right.spinSequence));
  const exactSpinOverlaps = exactSpinPairs.map(({ left, right }) => overlap(left.playerIds, right.playerIds));
  return {
    attemptedXis: ERA_IDS.length * TRIALS_PER_ERA * STRATEGIES.length,
    completedXis: allRows.length,
    completionRate: allRows.length / (ERA_IDS.length * TRIALS_PER_ERA * STRATEGIES.length),
    respinUsageRate: mean(allRows.map((row) => row.respinUsed ? 1 : 0)),
    pairwiseCanonicalPlayerOverlap: distribution(overlaps),
    identicalXiPairRate: mean(overlaps.map((value) => value === 11 ? 1 : 0)),
    meaningfullyDifferentPairRateOverlapAtMostEight: mean(overlaps.map((value) => value <= 8 ? 1 : 0)),
    pairsWithIdenticalSpinSequence: exactSpinPairs.length,
    identicalSpinSequencePairRate: exactSpinPairs.length / pairs.length,
    overlapWhenSpinSequenceIdentical: distribution(exactSpinOverlaps),
  };
}

function pairedStrategyDifferences(groups) {
  const output = {};
  for (let leftIndex = 0; leftIndex < STRATEGIES.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < STRATEGIES.length; rightIndex += 1) {
      const leftName = STRATEGIES[leftIndex];
      const rightName = STRATEGIES[rightIndex];
      const pairs = groups.map((group) => ({
        left: group.records.find((row) => row.strategy === leftName),
        right: group.records.find((row) => row.strategy === rightName),
      }));
      output[`${leftName} minus ${rightName}`] = {
        meanPointsDifference: mean(pairs.map(({ left, right }) => left.points - right.points)),
        meanNrrDifference: mean(pairs.map(({ left, right }) => left.nrr - right.nrr)),
        leftHigherPointsRate: mean(pairs.map(({ left, right }) => left.points > right.points ? 1 : 0)),
        equalPointsRate: mean(pairs.map(({ left, right }) => left.points === right.points ? 1 : 0)),
        leftHigherNrrRate: mean(pairs.map(({ left, right }) => left.nrr > right.nrr ? 1 : 0)),
      };
    }
  }
  return output;
}

function signalVersusRandomness(allRows, groups) {
  const pairs = flatPairs(groups).map(({ left, right }) => left.evaluation.overall >= right.evaluation.overall
    ? { stronger: left, weaker: right }
    : { stronger: right, weaker: left });
  const clearlyDifferent = pairs.filter(({ stronger, weaker }) => stronger.evaluation.overall - weaker.evaluation.overall >= 3);
  const similar = pairs.filter(({ stronger, weaker }) => stronger.evaluation.overall - weaker.evaluation.overall <= 1);
  const topEvaluationResults = groups.map((group) => {
    const topEvaluation = group.records.slice().sort((left, right) => right.evaluation.overall - left.evaluation.overall)[0];
    return topEvaluation.rank === 1;
  });
  return {
    correlationEvaluationToPointsOverall: pearson(allRows.map((row) => row.evaluation.overall), allRows.map((row) => row.points)),
    correlationEvaluationToNrrOverall: pearson(allRows.map((row) => row.evaluation.overall), allRows.map((row) => row.nrr)),
    clearlyStrongerPairsThreshold: 3,
    clearlyStrongerPairCount: clearlyDifferent.length,
    strongerHigherPointsRate: mean(clearlyDifferent.map(({ stronger, weaker }) => stronger.points > weaker.points ? 1 : 0)),
    strongerEqualPointsRate: mean(clearlyDifferent.map(({ stronger, weaker }) => stronger.points === weaker.points ? 1 : 0)),
    strongerHigherNrrRate: mean(clearlyDifferent.map(({ stronger, weaker }) => stronger.nrr > weaker.nrr ? 1 : 0)),
    similarPairsThreshold: 1,
    similarPairCount: similar.length,
    similarPairLowerEvaluationHigherPointsRate: mean(similar.map(({ stronger, weaker }) => weaker.points > stronger.points ? 1 : 0)),
    similarPairLowerEvaluationHigherNrrRate: mean(similar.map(({ stronger, weaker }) => weaker.nrr > stronger.nrr ? 1 : 0)),
    highestEvaluatedXiFinishesFirstRate: mean(topEvaluationResults.map((value) => value ? 1 : 0)),
  };
}

function opponentDifficulty(allRows) {
  const byEra = {};
  for (const eraId of ERA_IDS) {
    const buckets = new Map();
    for (const row of allRows.filter((candidate) => candidate.eraId === eraId)) {
      for (const match of row.opponentResults) {
        const id = match.opponentProfileId;
        const bucket = buckets.get(id) ?? { opponentProfileId: id, played: 0, won: 0 };
        bucket.played += 1;
        bucket.won += match.won ? 1 : 0;
        buckets.set(id, bucket);
      }
    }
    const rows = [...buckets.values()].map((bucket) => ({ ...bucket, winRate: bucket.won / bucket.played }))
      .sort((left, right) => left.winRate - right.winRate || left.opponentProfileId.localeCompare(right.opponentProfileId));
    byEra[eraId] = {
      hardest: rows[0],
      easiest: rows.at(-1),
      winRateSpread: round(rows.at(-1).winRate - rows[0].winRate),
    };
  }
  return byEra;
}

function representativeExamples(groups) {
  const pairs = flatPairs(groups);
  const sameSequenceDivergence = pairs
    .filter(({ left, right }) => JSON.stringify(left.spinSequence) === JSON.stringify(right.spinSequence))
    .sort((a, b) => overlap(a.left.playerIds, a.right.playerIds) - overlap(b.left.playerIds, b.right.playerIds))[0];
  const strongerOutperforms = pairs.map((pair) => orientByEvaluation(pair))
    .filter(({ stronger, weaker }) => stronger.points > weaker.points)
    .sort((a, b) => (b.stronger.evaluation.overall - b.weaker.evaluation.overall)
      - (a.stronger.evaluation.overall - a.weaker.evaluation.overall))[0];
  const similarReversal = pairs.map((pair) => orientByEvaluation(pair))
    .filter(({ stronger, weaker }) => stronger.evaluation.overall - weaker.evaluation.overall <= 0.5 && weaker.points > stronger.points)
    .sort((a, b) => (b.weaker.points - b.stronger.points) - (a.weaker.points - a.stronger.points))[0];
  const baselineSuccess = groups.flatMap((group) => group.records)
    .filter((row) => row.strategy === "BASELINE")
    .sort((left, right) => left.rank - right.rank || right.points - left.points)[0];
  return {
    sameSequenceDivergence: pairExample(sameSequenceDivergence),
    strongerOutperforms: orientedPairExample(strongerOutperforms),
    similarEvaluationReversal: orientedPairExample(similarReversal),
    baselineBestFinish: recordExample(baselineSuccess),
  };
}

function flatPairs(groups) {
  return groups.flatMap((group) => {
    const pairs = [];
    for (let left = 0; left < group.records.length; left += 1) {
      for (let right = left + 1; right < group.records.length; right += 1) {
        pairs.push({ left: group.records[left], right: group.records[right] });
      }
    }
    return pairs;
  });
}

function orientByEvaluation({ left, right }) {
  return left.evaluation.overall >= right.evaluation.overall ? { stronger: left, weaker: right } : { stronger: right, weaker: left };
}

function pairExample(pair) {
  if (!pair) return null;
  return { overlap: overlap(pair.left.playerIds, pair.right.playerIds), left: recordExample(pair.left), right: recordExample(pair.right) };
}

function orientedPairExample(pair) {
  if (!pair) return null;
  return {
    evaluationDifference: round(pair.stronger.evaluation.overall - pair.weaker.evaluation.overall),
    stronger: recordExample(pair.stronger),
    weaker: recordExample(pair.weaker),
  };
}

function recordExample(row) {
  if (!row) return null;
  return {
    eraId: row.eraId,
    trial: row.trial,
    strategy: row.strategy,
    playerNamesInBattingOrder: row.playerNames,
    evaluation: mapNumbers(row.evaluation),
    won: row.won,
    points: row.points,
    nrr: round(row.nrr),
    rank: row.rank,
    respinUsed: row.respinUsed,
    frontlineBowlers: row.frontlineBowlers,
    supportBowlers: row.supportBowlers,
    tierCounts: row.tierCounts,
    fitCounts: row.fitCounts,
  };
}

function distribution(values) {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((left, right) => left - right);
  return {
    mean: mean(values),
    min: round(sorted[0]),
    p10: quantile(sorted, 0.1),
    p25: quantile(sorted, 0.25),
    median: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    p90: quantile(sorted, 0.9),
    max: round(sorted.at(-1)),
  };
}

function quantile(sorted, probability) {
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return round(sorted[lower]);
  return round(sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower));
}

function pearson(left, right) {
  const leftMean = rawMean(left);
  const rightMean = rawMean(right);
  let numerator = 0;
  let leftSquares = 0;
  let rightSquares = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftDelta = left[index] - leftMean;
    const rightDelta = right[index] - rightMean;
    numerator += leftDelta * rightDelta;
    leftSquares += leftDelta ** 2;
    rightSquares += rightDelta ** 2;
  }
  return round(numerator / Math.sqrt(leftSquares * rightSquares));
}

function overlap(left, right) {
  const rightSet = new Set(right);
  return left.filter((value) => rightSet.has(value)).length;
}

function countBy(values, selector) {
  const output = {};
  for (const value of values) {
    const key = selector(value);
    output[key] = (output[key] ?? 0) + 1;
  }
  return output;
}

function meanObject(objects, keys) {
  return Object.fromEntries(keys.map((key) => [key, mean(objects.map((object) => object[key] ?? 0))]));
}

function mean(values) {
  return values.length === 0 ? null : round(rawMean(values));
}

function rawMean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function mapNumbers(object) {
  return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, round(value)]));
}

function round(value, digits = 6) {
  if (value === null || !Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function numericArgument(name, fallback) {
  const prefix = `${name}=`;
  const argument = process.argv.find((value) => value.startsWith(prefix));
  if (!argument) return fallback;
  const value = Number(argument.slice(prefix.length));
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} requires a non-negative number.`);
  return value;
}

function nullable(value, fallback = -1) {
  return value ?? fallback;
}

function descending(left, right) {
  return Number(right) - Number(left);
}

function ascending(left, right) {
  return Number(left) - Number(right);
}
