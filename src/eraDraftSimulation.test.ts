import assert from "node:assert/strict";
import test from "node:test";

import { loadEraDraftCatalog } from "./eraDraftData.js";
import { createEraDraftGame, reduceEraDraft } from "./eraDraftEngine.js";
import { projectEraDraftOpponentComposition } from "./eraDraftOpponentComposition.js";
import { accepted, revealEraXi, wrapEraDraftCatalog } from "./eraDraftPhase4TestSupport.js";
import { deriveEraDraftSimulationSeeds } from "./eraDraftSimulation.js";
import { selectNormalSpinTeamSeason } from "./eraDraftRng.js";
import { opponentAsSimulationTeamV2 } from "./stage7Data.js";
import { selectLeagueOpponentsV2 } from "./simulationV2.js";
import { EraDraftDataError } from "./eraDraftTypes.js";
import type { EraId } from "./teamEvaluationV2.js";

const catalog = loadEraDraftCatalog();

test("SIMULATE_SEASON is legal only from REVEALED and Foundation reaches GAME_COMPLETE", () => {
  const setup = createEraDraftGame({ catalog, rootSeed: "phase-4-invalid-simulation" });
  const invalid = reduceEraDraft(catalog, setup, { type: "SIMULATE_SEASON" });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.error.code, "INVALID_PHASE");

  const revealed = revealEraXi(catalog, "phase-4-foundation", "era-foundation");
  const opponentSnapshot = JSON.stringify(catalog.getFoundationOpponents());
  const first = accepted(reduceEraDraft(catalog, revealed, { type: "SIMULATE_SEASON" }));
  const second = accepted(reduceEraDraft(catalog, revealed, { type: "SIMULATE_SEASON" }));
  assert.equal(first.phase, "GAME_COMPLETE");
  assert.deepEqual(first, second);
  if (first.phase !== "GAME_COMPLETE") return;

  assert.deepEqual(first.season.userTeam.strength, {
    batting: revealed.evaluation.adjustedStrength.batting,
    bowling: revealed.evaluation.adjustedStrength.bowling,
    overall: revealed.evaluation.adjustedStrength.overall,
  });
  assert.equal(first.season.league.teams.length, 8);
  assert.equal(first.season.league.teams.filter((team) => team.teamId !== "user").length, 7);
  assert.deepEqual(first.season.opponentComposition.fullPoolProfileIds, catalog.getFoundationOpponents().map((profile) => profile.candidateId));
  assert.deepEqual(first.season.opponentComposition.shortlistedProfileIds, first.season.opponentComposition.fullPoolProfileIds);
  assert.equal(catalog.getFoundationOpponents().length, 8);
  const expectedComposition = selectLeagueOpponentsV2(
    first.season.seedBundle.opponentCompositionSeed,
    catalog.getFoundationOpponents().map(opponentAsSimulationTeamV2),
  );
  assert.equal(first.season.league.omittedOpponentTeamId, expectedComposition.omitted.teamId);
  assert.deepEqual(
    first.season.league.teams.slice(1).map((team) => team.teamId),
    expectedComposition.selected.map((team) => team.teamId),
  );
  assert.equal(first.season.stage7Versions.simulationVersion, first.season.league.version);
  assert.equal(first.season.stage7Versions.environmentSchemaVersion, catalog.getEnvironment("era-foundation")!.schemaVersion);
  assert.equal(first.season.league.leagueMatches.length, 56);
  assert.equal(first.season.league.standings.length, 8);
  assert.ok(first.season.league.standings.every((row) => row.played === 14));
  assert.equal(first.season.league.playoffs.length, 4);
  assert.ok(first.season.league.teams.some((team) => team.teamId === first.season.league.championTeamId));
  assert.equal(first.history.at(-1)?.command, "SIMULATE_SEASON");
  assert.equal(JSON.stringify(catalog.getFoundationOpponents()), opponentSnapshot, "opponent profiles and XIs remain intact");

  const repeated = reduceEraDraft(catalog, first, { type: "SIMULATE_SEASON" });
  assert.equal(repeated.ok, false);
  assert.equal(repeated.state, first);
});

test("all later eras deterministically reach GAME_COMPLETE through the real reducer path", () => {
  const laterEras: readonly EraId[] = [
    "era-expansion", "era-transition", "era-modern-pre-impact", "era-impact",
  ];
  for (const eraId of laterEras) {
    const revealed = revealEraXi(catalog, `stage9a-all-era-${eraId}`, eraId);
    const first = accepted(reduceEraDraft(catalog, revealed, { type: "SIMULATE_SEASON" }));
    const second = accepted(reduceEraDraft(catalog, revealed, { type: "SIMULATE_SEASON" }));
    assert.deepEqual(second, first);
    assert.equal(first.phase, "GAME_COMPLETE");
    if (first.phase !== "GAME_COMPLETE") continue;
    assert.equal(first.eraId, eraId);
    const view = projectEraDraftOpponentComposition(first.season);
    assert.equal(view.fullPoolProfileIds.length, catalog.getOpponentProfiles(eraId).length);
    assert.equal(view.shortlistedProfileIds.length, 8);
    assert.equal(new Set(view.shortlistedProfileIds).size, 8);
    assert.equal(view.actualOpponentProfileIds.length, 7);
    assert.ok(view.shortlistedProfileIds.includes(view.omittedShortlistedProfileId));
    assert.ok(view.actualOpponentProfileIds.every((id) => view.shortlistedProfileIds.includes(id)));
    assert.equal(first.season.league.leagueMatches.length, 56);
    assert.ok(first.season.league.standings.every((row) => row.played === 14));
    assert.equal(first.season.league.playoffs.length, 4);
    assert.ok(first.season.league.teams.some((team) => team.teamId === first.season.league.championTeamId));
  }
});

test("missing required era content is a typed atomic system failure", () => {
  const revealed = revealEraXi(catalog, "phase-4-corrupt-content", "era-foundation");
  const broken = wrapEraDraftCatalog(catalog, { getOpponentProfiles: () => [] });
  const snapshot = JSON.stringify(revealed);
  assert.throws(
    () => reduceEraDraft(broken, revealed, { type: "SIMULATE_SEASON" }),
    (error) => error instanceof EraDraftDataError && error.code === "MISSING_ERA_SIMULATION_CONTENT",
  );
  assert.equal(JSON.stringify(revealed), snapshot);
});

test("simulation seeds are distinct, XI-derived domains independent of draft counters and rejections", () => {
  const revealed = revealEraXi(catalog, "phase-4-domain-isolation", "era-foundation");
  const seeds = deriveEraDraftSimulationSeeds(revealed);
  assert.notEqual(seeds.opponentCompositionSeed, seeds.matchSimulationSeed);

  const counterVariant = {
    ...revealed,
    revision: revealed.revision + 100,
    rngCounters: { normalSpin: 999, voluntaryRespin: 1, deadSpinRecovery: 888 },
    respin: { status: "USED" as const },
    history: [],
  };
  assert.deepEqual(deriveEraDraftSimulationSeeds(counterVariant), seeds);

  const rejected = reduceEraDraft(catalog, revealed, { type: "SPIN" });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.state, revealed);
  const afterRejected = accepted(reduceEraDraft(catalog, rejected.state, { type: "SIMULATE_SEASON" }));
  const direct = accepted(reduceEraDraft(catalog, revealed, { type: "SIMULATE_SEASON" }));
  assert.deepEqual(afterRejected, direct);

  const normalSequence = () => Array.from({ length: 25 }, (_, ordinal) =>
    selectNormalSpinTeamSeason(catalog, revealed.rootSeed, revealed.eraId, ordinal).teamSeasonId);
  const before = normalSequence();
  deriveEraDraftSimulationSeeds(revealed);
  reduceEraDraft(catalog, revealed, { type: "SIMULATE_SEASON" });
  assert.deepEqual(normalSequence(), before);
});
