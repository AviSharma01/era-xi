import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { canonicalSha256 } from "./eraDraftCanonical.js";
import { FOUNDATION_SIMULATION_COMPATIBILITY_FINGERPRINT } from "./eraDraftCompatibility.js";
import { loadEraDraftCatalog } from "./eraDraftData.js";
import { revealEraXi } from "./eraDraftPhase4TestSupport.js";
import { deriveEraDraftSimulationSeeds, simulateEraDraftSeason } from "./eraDraftSimulation.js";
import { opponentAsSimulationTeamV2 } from "./stage7Data.js";
import { selectLeagueOpponentsV2 } from "./simulationV2.js";

type GoldenFixture = {
  capturedFrom: {
    commit: string;
    catalogFingerprint: string;
    foundationSimulationCompatibilityFingerprint: string;
  };
  foundationOpponentArtifact: { path: string; sha256: string };
  runtimeProfileIds: string[];
  profiles: Array<{ candidateId: string; orderedXi: unknown[]; evaluation: unknown }>;
  compositionCases: Array<{
    compositionSeed: string;
    selectedProfileIds: string[];
    omittedProfileId: string;
  }>;
  fixedGame: {
    rootSeed: string;
    userXi: unknown[];
    seedBundle: unknown;
    leagueResult: unknown;
    leagueResultCanonicalSha256: string;
  };
};

const root = process.cwd();
const fixture = JSON.parse(readFileSync(
  resolve(root, "tests/fixtures/stage9a/foundation_stage8_parity.json"), "utf8",
)) as GoldenFixture;
const catalog = loadEraDraftCatalog(root);

test("Foundation Stage 8 content, order, and generic simulation-team mapping match the golden fixture", () => {
  const artifact = readFileSync(resolve(root, fixture.foundationOpponentArtifact.path));
  assert.equal(createHash("sha256").update(artifact).digest("hex"), fixture.foundationOpponentArtifact.sha256);
  assert.equal(fixture.foundationOpponentArtifact.sha256, "c904df120bf8920f6967c13f04bd1725826e5e20cfa31291a49934187c373a0c");
  assert.equal(fixture.capturedFrom.catalogFingerprint, FOUNDATION_SIMULATION_COMPATIBILITY_FINGERPRINT);
  assert.equal(fixture.capturedFrom.foundationSimulationCompatibilityFingerprint, FOUNDATION_SIMULATION_COMPATIBILITY_FINGERPRINT);

  const profiles = catalog.getFoundationOpponents();
  assert.deepEqual(profiles.map((profile) => profile.candidateId), fixture.runtimeProfileIds);
  assert.deepEqual(profiles.map((profile) => ({
    candidateId: profile.candidateId,
    orderedXi: profile.xi.map(({ position, playerTeamSeasonId, playerId }) => ({ position, playerTeamSeasonId, playerId })),
    evaluation: profile.evaluation,
  })), fixture.profiles);

  const mapped = profiles.map(opponentAsSimulationTeamV2);
  assert.deepEqual(mapped.map((team) => team.teamId), fixture.runtimeProfileIds);
  assert.deepEqual(mapped.map((team) => team.strength), profiles.map((profile) => ({
    batting: profile.evaluation.batting,
    bowling: profile.evaluation.bowling,
    overall: profile.evaluation.overall,
  })));
});

test("Foundation Stage 8 composition seed matrix preserves selection order and omitted opponent", () => {
  const pool = catalog.getFoundationOpponents().map(opponentAsSimulationTeamV2);
  for (const expected of fixture.compositionCases) {
    const actual = selectLeagueOpponentsV2(expected.compositionSeed, pool);
    assert.deepEqual(actual.selected.map((team) => team.teamId), expected.selectedProfileIds);
    assert.equal(actual.omitted.teamId, expected.omittedProfileId);
  }
});

test("Foundation Stage 8 fixed game preserves seeds and the complete LeagueResultV2", () => {
  const revealed = revealEraXi(catalog, fixture.fixedGame.rootSeed, "era-foundation");
  assert.deepEqual([...revealed.picks]
    .sort((left, right) => left.battingPosition - right.battingPosition)
    .map(({ battingPosition, playerTeamSeasonId, playerId, seasonId, teamId, franchiseId }) => ({
      battingPosition, playerTeamSeasonId, playerId, seasonId, teamId, franchiseId,
    })), fixture.fixedGame.userXi);
  assert.deepEqual(deriveEraDraftSimulationSeeds(revealed), fixture.fixedGame.seedBundle);
  const league = simulateEraDraftSeason(catalog, revealed).league;
  assert.deepEqual(league, fixture.fixedGame.leagueResult);
  assert.equal(canonicalSha256(league), fixture.fixedGame.leagueResultCanonicalSha256);
  assert.equal(fixture.fixedGame.leagueResultCanonicalSha256, "c8ef8e6b3011f89fcc6b3faa73c897087bda274d1fc633bde473b4e57967f1d6");
});
