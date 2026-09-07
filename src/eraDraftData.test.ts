import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEraDraftCatalog,
  computeEraDraftCatalogFingerprint,
  loadEraDraftCatalog,
  loadEraDraftCatalogDocuments,
  type EraDraftCatalogDocuments,
  type EraDraftRosterRow,
} from "./eraDraftData.js";
import { EraDraftDataError } from "./eraDraftTypes.js";
import type { PlayerRoleConsumer } from "./playerRoleContract.js";
import { SIMULATION_V2_VERSION } from "./simulationV2.js";
import { TEAM_EVALUATION_V2_VERSION } from "./teamEvaluationV2.js";

const documents = loadEraDraftCatalogDocuments();

test("catalog reconciles the frozen Stage 8 universe and availability", () => {
  const catalog = buildEraDraftCatalog(documents);
  assert.deepEqual(catalog.diagnostics, {
    eligibleProfiles: 2_992,
    canonicalPlayers: 727,
    eras: 5,
    environments: 5,
    foundationOpponents: 8,
    unknownG2RosterStatuses: 0,
    teamSeasonsByEra: {
      "era-foundation": 24,
      "era-expansion": 28,
      "era-transition": 32,
      "era-modern-pre-impact": 42,
      "era-impact": 40,
    },
    simulationContentByEra: {
      "era-foundation": { status: "AVAILABLE", opponentCount: 8 },
      "era-expansion": { status: "UNAVAILABLE", opponentCount: 0 },
      "era-transition": { status: "UNAVAILABLE", opponentCount: 0 },
      "era-modern-pre-impact": { status: "UNAVAILABLE", opponentCount: 0 },
      "era-impact": { status: "UNAVAILABLE", opponentCount: 0 },
    },
    sourceFiles: catalog.diagnostics.sourceFiles,
    fingerprint: "03054faff39520da6a835e0aaecb1a9887ca82291d9ba0a5923540c862793808",
  });
  assert.ok(catalog.diagnostics.sourceFiles.every((path) => !path.includes("data/analytical/")));
  assert.equal(catalog.getEraIds().length, 5);
  assert.equal(catalog.getFoundationOpponents().length, 8);
});

test("catalog fingerprint and sorted indexes are stable across repeated loads", () => {
  const first = loadEraDraftCatalog();
  const second = loadEraDraftCatalog();
  assert.equal(first.fingerprint, second.fingerprint);
  for (const eraId of first.getEraIds()) {
    const ids = first.getTeamSeasonsForEra(eraId).map((item) => item.teamSeasonId);
    assert.deepEqual(ids, [...ids].sort());
    assert.deepEqual(ids, second.getTeamSeasonsForEra(eraId).map((item) => item.teamSeasonId));
  }
});

test("catalog fingerprint includes both frozen runtime model versions", () => {
  assert.deepEqual(documents.fingerprintInput.runtimeVersions, {
    simulationVersion: SIMULATION_V2_VERSION,
    teamEvaluationVersion: TEAM_EVALUATION_V2_VERSION,
  });
  assert.deepEqual(
    documents.fingerprintInput.sources.map((source) => source.relativePath),
    documents.sourceFiles,
  );
  assert.equal(computeEraDraftCatalogFingerprint(documents.fingerprintInput), documents.fingerprint);
  assert.equal(
    computeEraDraftCatalogFingerprint({
      ...documents.fingerprintInput,
      sources: [...documents.fingerprintInput.sources].reverse(),
    }),
    documents.fingerprint,
  );

  const changedTeamEvaluation = computeEraDraftCatalogFingerprint({
    ...documents.fingerprintInput,
    runtimeVersions: {
      ...documents.fingerprintInput.runtimeVersions,
      teamEvaluationVersion: `${TEAM_EVALUATION_V2_VERSION}-fixture-change`,
    },
  });
  const changedSimulation = computeEraDraftCatalogFingerprint({
    ...documents.fingerprintInput,
    runtimeVersions: {
      ...documents.fingerprintInput.runtimeVersions,
      simulationVersion: `${SIMULATION_V2_VERSION}-fixture-change`,
    },
  });
  assert.notEqual(changedTeamEvaluation, documents.fingerprint);
  assert.notEqual(changedSimulation, documents.fingerprint);
  assert.notEqual(changedTeamEvaluation, changedSimulation);
});

test("catalog construction does not depend on source array insertion order", () => {
  const reversed = buildEraDraftCatalog({
    ...documents,
    eras: [...documents.eras].reverse(),
    seasons: [...documents.seasons].reverse(),
    teams: [...documents.teams].reverse(),
    franchises: [...documents.franchises].reverse(),
    eligibility: [...documents.eligibility].reverse(),
    roles: [...documents.roles].reverse(),
    qualities: [...documents.qualities].reverse(),
    roster: [...documents.roster].reverse(),
    environments: [...documents.environments].reverse(),
    foundationOpponents: [...documents.foundationOpponents].reverse(),
  });
  const ordinary = buildEraDraftCatalog(documents);
  assert.equal(reversed.fingerprint, ordinary.fingerprint);
  for (const eraId of ordinary.getEraIds()) {
    assert.deepEqual(
      reversed.getTeamSeasonsForEra(eraId).map((item) => item.teamSeasonId),
      ordinary.getTeamSeasonsForEra(eraId).map((item) => item.teamSeasonId),
    );
  }
});

test("missing, duplicated, mismatched, unknown, and unsupported inputs fail as typed data errors", () => {
  assert.throws(
    () => loadEraDraftCatalog("/definitely/missing/era-draft-root"),
    (error) => error instanceof EraDraftDataError && error.code === "MISSING_SOURCE_FILE",
  );

  const duplicate: EraDraftCatalogDocuments = {
    ...documents,
    eligibility: [...documents.eligibility, documents.eligibility[0]!],
  };
  assert.throws(
    () => buildEraDraftCatalog(duplicate),
    (error) => error instanceof EraDraftDataError && error.code === "DUPLICATE_ID",
  );

  const missing: EraDraftCatalogDocuments = { ...documents, qualities: documents.qualities.slice(1) };
  assert.throws(
    () => buildEraDraftCatalog(missing),
    (error) => error instanceof EraDraftDataError && error.code === "ID_SET_MISMATCH",
  );

  const mismatchedRole = {
    ...documents.roles[0]!,
    playerId: documents.roles[0]!.playerId === "ffffffff" ? "eeeeeeee" : "ffffffff",
  } as PlayerRoleConsumer;
  const mismatch: EraDraftCatalogDocuments = {
    ...documents,
    roles: [mismatchedRole, ...documents.roles.slice(1)],
  };
  assert.throws(
    () => buildEraDraftCatalog(mismatch),
    (error) => error instanceof EraDraftDataError && error.code === "PLAYER_IDENTITY_MISMATCH",
  );

  const firstEligibleId = documents.eligibility.find((row) => row.eligibilityStatus === "ELIGIBLE")!.playerTeamSeasonId;
  const unknownRoster = documents.roster.map((row): EraDraftRosterRow => row.playerTeamSeasonId === firstEligibleId
    ? { ...row, iplRosterStatus: "UNKNOWN" }
    : row);
  assert.throws(
    () => buildEraDraftCatalog({ ...documents, roster: unknownRoster }),
    (error) => error instanceof EraDraftDataError && error.code === "UNKNOWN_G2_ROSTER_STATUS",
  );

  assert.throws(
    () => buildEraDraftCatalog({
      ...documents,
      versions: { ...documents.versions, qualityModelVersion: "unsupported" },
    }),
    (error) => error instanceof EraDraftDataError && error.code === "UNSUPPORTED_VERSION",
  );
});

test("catalog lookups expose immutable joined records through private indexes", () => {
  const catalog = buildEraDraftCatalog(documents);
  const teamSeason = catalog.getTeamSeasonsForEra("era-foundation")[0]!;
  const candidates = catalog.getCandidatesForTeamSeason(teamSeason.teamSeasonId);
  const player = candidates[0]!;
  assert.ok(candidates.length > 0);
  assert.equal(player.teamSeasonId, teamSeason.teamSeasonId);
  assert.equal(catalog.getPlayer(player.playerTeamSeasonId), player);
  assert.ok(catalog.getPlayerVariantsForEra(player.eraId, player.playerId).includes(player));
  assert.ok(Object.isFrozen(player));
  assert.ok(Object.isFrozen(player.role));
  assert.ok(Object.isFrozen(player.quality));
  assert.ok(Object.isFrozen(candidates));
});
