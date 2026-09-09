import assert from "node:assert/strict";
import test from "node:test";

import type { EraDraftCatalog } from "./eraDraftData.js";
import { loadEraDraftCatalog } from "./eraDraftData.js";
import { createEraDraftGame, reduceEraDraft } from "./eraDraftEngine.js";
import {
  rankRecoveryTeamSeasons,
  selectNormalSpinTeamSeason,
  selectRespinTeamSeason,
} from "./eraDraftRng.js";
import { EraDraftInvariantError, type AwaitingPickState } from "./eraDraftTypes.js";

const catalog = loadEraDraftCatalog();
const eraId = "era-foundation" as const;

test("a dead normal spin recovers deterministically without consuming the respin", () => {
  const seed = "dead-initial-spin";
  const triggering = selectNormalSpinTeamSeason(catalog, seed, eraId, 0);
  const wrapped = withDeadTeamSeasons(catalog, new Set([triggering.teamSeasonId]));
  const first = spinInitial(wrapped, seed);
  const second = spinInitial(wrapped, seed);
  assert.equal(first.currentSpin.teamSeasonId, second.currentSpin.teamSeasonId);
  assert.notEqual(first.currentSpin.teamSeasonId, triggering.teamSeasonId);
  assert.deepEqual(first.currentSpin.recovery?.skippedDeadTeamSeasonIds, [triggering.teamSeasonId]);
  assert.equal(first.respin.status, "AVAILABLE");
  assert.equal(first.rngCounters.voluntaryRespin, 0);
  assert.equal(first.rngCounters.deadSpinRecovery, 1);
  const event = first.history.at(-1)!;
  assert.equal(event.command, "SPIN");
  if (event.command === "SPIN") assert.deepEqual(event.skippedDeadTeamSeasonIds, [triggering.teamSeasonId]);
});

test("recovery ranking is seed-derived rather than lexical", () => {
  const lexicalFirst = [...catalog.getTeamSeasonsForEra(eraId)]
    .sort((left, right) => left.teamSeasonId.localeCompare(right.teamSeasonId))[0]!.teamSeasonId;
  let nonLexicalSeed: string | undefined;
  for (let index = 0; index < 100; index += 1) {
    const ranked = rankRecoveryTeamSeasons(catalog, `rank-${index}`, eraId, 0, "fixture");
    if (ranked[0]!.teamSeasonId !== lexicalFirst) {
      nonLexicalSeed = `rank-${index}`;
      break;
    }
  }
  assert.ok(nonLexicalSeed);
  const first = rankRecoveryTeamSeasons(catalog, nonLexicalSeed, eraId, 0, "fixture");
  const repeated = rankRecoveryTeamSeasons(catalog, nonLexicalSeed, eraId, 0, "fixture");
  assert.deepEqual(first, repeated);
  assert.notEqual(first[0]!.teamSeasonId, lexicalFirst);

  const heads = new Set(Array.from({ length: 20 }, (_, index) =>
    rankRecoveryTeamSeasons(catalog, `different-${index}`, eraId, 0, "fixture")[0]!.teamSeasonId));
  assert.ok(heads.size > 1);
});

test("globally impossible catalog fails with typed NO_VIABLE_TEAM_SEASON", () => {
  const impossible = withDeadTeamSeasons(
    catalog,
    new Set(catalog.getTeamSeasonsForEra(eraId).map((item) => item.teamSeasonId)),
  );
  const setup = createEraDraftGame({ catalog: impossible, rootSeed: "globally-impossible" });
  assert.throws(
    () => reduceEraDraft(impossible, setup, { type: "CHOOSE_ERA", eraId }),
    (error) => error instanceof EraDraftInvariantError && error.code === "NO_VIABLE_TEAM_SEASON",
  );
});

test("one voluntary respin succeeds, excludes the exact team-season, and is immutable thereafter", () => {
  const spun = spinInitial(catalog, "successful-respin");
  const discarded = spun.currentSpin.teamSeasonId;
  const result = reduceEraDraft(catalog, spun, { type: "RESPIN" });
  assert.equal(result.ok, true);
  if (!result.ok || result.state.phase !== "AWAITING_PICK") return;
  assert.notEqual(result.state.currentSpin.teamSeasonId, discarded);
  assert.equal(result.state.currentSpin.origin, "RESPIN");
  assert.equal(result.state.respin.status, "USED");
  assert.equal(result.state.rngCounters.voluntaryRespin, 1);
  const event = result.state.history.at(-1)!;
  assert.equal(event.command, "RESPIN");
  if (event.command === "RESPIN") {
    assert.equal(event.discardedTeamSeasonId, discarded);
    assert.equal(event.replacementTeamSeasonId, result.state.currentSpin.teamSeasonId);
    assert.equal(event.resultingRespinStatus, "USED");
  }

  const snapshot = JSON.stringify(result.state);
  const second = reduceEraDraft(catalog, result.state, { type: "RESPIN" });
  assert.equal(second.ok, false);
  assert.equal(second.state, result.state);
  assert.equal(JSON.stringify(second.state), snapshot);
  if (!second.ok) assert.equal(second.error.code, "RESPIN_UNAVAILABLE");
});

test("respin recovery uses its own domain and marks USED only after viable resolution", () => {
  const spun = spinInitial(catalog, "respin-recovery");
  const triggering = selectRespinTeamSeason(
    catalog,
    spun.rootSeed,
    eraId,
    spun.rngCounters.voluntaryRespin,
    spun.currentSpin.teamSeasonId,
  )!;
  const wrapped = withDeadTeamSeasons(catalog, new Set([triggering.teamSeasonId]));
  const result = reduceEraDraft(wrapped, spun, { type: "RESPIN" });
  assert.equal(result.ok, true);
  if (!result.ok || result.state.phase !== "AWAITING_PICK") return;
  assert.equal(result.state.respin.status, "USED");
  assert.equal(result.state.rngCounters.voluntaryRespin, 1);
  assert.equal(result.state.rngCounters.deadSpinRecovery, 1);
  assert.deepEqual(result.state.currentSpin.recovery?.skippedDeadTeamSeasonIds, [triggering.teamSeasonId]);
});

test("failed respin replacement preserves availability, counters, history, and state", () => {
  const spun = spinInitial(catalog, "failed-respin");
  const onlyCurrentViable = withDeadTeamSeasons(
    catalog,
    new Set(catalog.getTeamSeasonsForEra(eraId)
      .map((item) => item.teamSeasonId)
      .filter((teamSeasonId) => teamSeasonId !== spun.currentSpin.teamSeasonId)),
  );
  const before = JSON.stringify(spun);
  const result = reduceEraDraft(onlyCurrentViable, spun, { type: "RESPIN" });
  assert.equal(result.ok, false);
  assert.equal(result.state, spun);
  assert.equal(JSON.stringify(result.state), before);
  assert.equal(result.state.respin.status, "AVAILABLE");
  if (!result.ok) assert.equal(result.error.code, "RESPIN_REPLACEMENT_UNAVAILABLE");
});

test("respin excludes only the exact team-season and does not perturb normal-spin derivation", () => {
  let sameFranchiseExample: { discarded: string; replacement: string } | undefined;
  for (const discarded of catalog.getTeamSeasonsForEra(eraId)) {
    for (let index = 0; index < 200; index += 1) {
      const replacement = selectRespinTeamSeason(catalog, `same-franchise-${index}`, eraId, 0, discarded.teamSeasonId)!;
      if (replacement.franchiseId === discarded.franchiseId && replacement.teamSeasonId !== discarded.teamSeasonId) {
        sameFranchiseExample = { discarded: discarded.teamSeasonId, replacement: replacement.teamSeasonId };
        break;
      }
    }
    if (sameFranchiseExample) break;
  }
  assert.ok(sameFranchiseExample, "same-franchise/different-season replacement must remain possible");

  const seed = "domain-isolation";
  const before = Array.from({ length: 30 }, (_, ordinal) => selectNormalSpinTeamSeason(catalog, seed, eraId, ordinal).teamSeasonId);
  const spun = spinInitial(catalog, seed);
  const respun = reduceEraDraft(catalog, spun, { type: "RESPIN" });
  assert.equal(respun.ok, true);
  if (respun.ok) assert.equal(respun.state.rootSeed, spun.rootSeed);
  const after = Array.from({ length: 30 }, (_, ordinal) => selectNormalSpinTeamSeason(catalog, seed, eraId, ordinal).teamSeasonId);
  assert.deepEqual(after, before);
  const laterNormalSpins = Array.from({ length: 1_000 }, (_, index) =>
    selectNormalSpinTeamSeason(catalog, seed, eraId, index + spun.rngCounters.normalSpin).teamSeasonId);
  assert.ok(laterNormalSpins.includes(spun.currentSpin.teamSeasonId), "discarded team-season remains eligible on later normal spins");
});

test("RESPIN is rejected outside AWAITING_PICK without mutation", () => {
  const setup = createEraDraftGame({ catalog, rootSeed: "invalid-respin-phase" });
  const result = reduceEraDraft(catalog, setup, { type: "RESPIN" });
  assert.equal(result.ok, false);
  assert.equal(result.state, setup);
  if (!result.ok) assert.equal(result.error.code, "INVALID_PHASE");
});

function spinInitial(activeCatalog: EraDraftCatalog, seed: string): AwaitingPickState {
  const setup = createEraDraftGame({ catalog: activeCatalog, rootSeed: seed });
  const chosen = requiredState(reduceEraDraft(activeCatalog, setup, { type: "CHOOSE_ERA", eraId }));
  return requiredState(reduceEraDraft(activeCatalog, chosen, { type: "SPIN" })) as AwaitingPickState;
}

function requiredState(result: ReturnType<typeof reduceEraDraft>) {
  if (!result.ok) assert.fail(result.error.message);
  return result.state;
}

function withDeadTeamSeasons(base: EraDraftCatalog, dead: ReadonlySet<string>): EraDraftCatalog {
  return {
    fingerprint: base.fingerprint,
    diagnostics: base.diagnostics,
    getEra: (id) => base.getEra(id),
    getEraIds: () => base.getEraIds(),
    getEraForSeason: (id) => base.getEraForSeason(id),
    getTeamSeason: (id) => base.getTeamSeason(id),
    getTeamSeasonsForEra: (id) => base.getTeamSeasonsForEra(id),
    getEligibilityRow: (id) => base.getEligibilityRow(id),
    getPlayer: (id) => base.getPlayer(id),
    getCandidatesForTeamSeason: (id) => dead.has(id) ? [] : base.getCandidatesForTeamSeason(id),
    getPlayerVariantsForEra: (activeEraId, playerId) => base.getPlayerVariantsForEra(activeEraId, playerId),
    getKeeperCapablePlayerIds: (id) => base.getKeeperCapablePlayerIds(id),
    getSimulationContent: (id) => base.getSimulationContent(id),
    getEnvironment: (id) => base.getEnvironment(id),
    getOpponentProfiles: (id) => base.getOpponentProfiles(id),
    getFoundationOpponents: () => base.getFoundationOpponents(),
  };
}
