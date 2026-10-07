import assert from "node:assert/strict";
import test from "node:test";

import { loadEraDraftCatalog, loadEraDraftCatalogDocuments } from "./eraDraftData.js";
import type {
  EraDraftCatalog,
  EraDraftEligibilityRow,
  EraDraftPlayerRecord,
  EraDraftTeamSeason,
} from "./eraDraftData.js";
import { evaluateFutureCompletion, evaluateSelectionLegality, type FutureCompletionFeasibility } from "./eraDraftLegality.js";
import { EraDraftInvariantError, type EraDraftPick, type TeamSeasonId } from "./eraDraftTypes.js";

import { buildEraDraftCompletionIndex } from "./eraDraftCompletionIndex.js";
import { buildScopedEraDraftCatalog } from "./eraDraftScopedCatalog.js";
import { createEraDraftWebArtifact } from "./eraDraftWebArtifacts.js";
import type { EraId } from "./teamEvaluationV2.js";

type PlayerDefinition = {
  readonly ptsId: string;
  readonly playerId: string;
  readonly teamSeasonId?: TeamSeasonId;
  readonly status?: "INDIAN" | "OVERSEAS";
  readonly keeper?: boolean;
};

test("feasibility counts distinct canonical players rather than historical variants", () => {
  const tooFew = makeCatalog(Array.from({ length: 10 }, (_, index) => player(`p${index}`, index === 0)));
  assert.equal(evaluateFutureCompletion(tooFew, "era-foundation", []).feasible, false);

  const variantHeavy = makeCatalog(Array.from({ length: 20 }, (_, index) => ({
    ...player(`variant-${index}`, index === 0),
    playerId: `canonical-${index % 10}`,
  })));
  const result = evaluateFutureCompletion(variantHeavy, "era-foundation", []);
  assert.equal(result.remainingCanonicalPlayers, 10);
  assert.equal(result.feasible, false);
});

test("minimum overseas cost uses Indian alternatives across historical variants", () => {
  const definitions = [
    ...Array.from({ length: 4 }, (_, index) => player(`overseas-${index}`, index === 0, "OVERSEAS")),
    ...Array.from({ length: 7 }, (_, index) => player(`indian-${index}`, false, "INDIAN")),
    { ...player("dual-overseas", false, "OVERSEAS"), playerId: "dual" },
    { ...player("dual-indian", false, "INDIAN"), playerId: "dual", teamSeasonId: "ts:team-b:ipl-2009" as const },
  ];
  const catalog = makeCatalog(definitions);
  const result = evaluateFutureCompletion(catalog, "era-foundation", []);
  assert.equal(result.feasible, true);
  assert.equal(result.minimumOverseasNeeded, 3);

  const overseasOnly = makeCatalog(Array.from({ length: 11 }, (_, index) => player(`o${index}`, index === 0, "OVERSEAS")));
  assert.equal(evaluateFutureCompletion(overseasOnly, "era-foundation", []).feasible, false);
});

test("completion fails when no undrafted confirmed keeper remains", () => {
  const catalog = makeCatalog(Array.from({ length: 11 }, (_, index) => player(`p${index}`, false)));
  const result = evaluateFutureCompletion(catalog, "era-foundation", []);
  assert.equal(result.feasible, false);
  assert.deepEqual(result.viableKeeperPlayerIds, []);
});

test("keeper alternatives account for their own overseas cost and distinct fillers", () => {
  const drafted = [
    ...Array.from({ length: 5 }, (_, index) => player(`drafted-i${index}`)),
    ...Array.from({ length: 4 }, (_, index) => player(`drafted-o${index}`, false, "OVERSEAS")),
  ];
  const keeperOverseas = player("keeper-overseas", true, "OVERSEAS", "ts:team-k1:ipl-2008");
  const keeperIndian = player("keeper-indian", true, "INDIAN", "ts:team-k2:ipl-2008");
  const fillerIndian = player("filler-indian", false, "INDIAN", "ts:team-f:ipl-2008");
  const catalog = makeCatalog([...drafted, keeperOverseas, keeperIndian, fillerIndian]);
  const picks = drafted.map((definition, index) => makePick(catalog, definition.ptsId, index + 1, index + 1));
  const feasibility = evaluateFutureCompletion(catalog, "era-foundation", picks);
  assert.equal(feasibility.remainingSlots, 2);
  assert.equal(feasibility.remainingOverseasCapacity, 0);
  assert.equal(feasibility.minimumOverseasNeeded, 0);
  assert.deepEqual(feasibility.viableKeeperPlayerIds, [keeperIndian.playerId]);

  const dualDrafted = [
    ...Array.from({ length: 6 }, (_, index) => player(`dual-drafted-i${index}`)),
    ...Array.from({ length: 3 }, (_, index) => player(`dual-drafted-o${index}`, false, "OVERSEAS")),
  ];
  const keeperOverseasVariant = { ...player("keeper-o-variant", true, "OVERSEAS", "ts:team-k1:ipl-2008"), playerId: "dual-keeper" };
  const keeperIndianVariant = { ...player("keeper-i-variant", true, "INDIAN", "ts:team-k2:ipl-2009"), playerId: "dual-keeper" };
  const overseasFiller = player("dual-filler-o", false, "OVERSEAS", "ts:team-f:ipl-2008");
  const dualCatalog = makeCatalog([...dualDrafted, keeperOverseasVariant, keeperIndianVariant, overseasFiller]);
  const dualPicks = dualDrafted.map((definition, index) => makePick(dualCatalog, definition.ptsId, index + 1, index + 1));
  const selectingExpensiveKeeper = evaluateSelectionLegality(dualCatalog, {
    eraId: "era-foundation",
    picks: dualPicks,
    activeTeamSeasonId: keeperOverseasVariant.teamSeasonId!,
  }, { playerTeamSeasonId: keeperOverseasVariant.ptsId, battingPosition: 10 });
  assert.deepEqual(selectingExpensiveKeeper.reasons.map(({ code }) => code), ["FUTURE_XI_IMPOSSIBLE"]);
});

test("fit, bowling, and quality metadata do not affect feasibility", () => {
  const definitions = Array.from({ length: 11 }, (_, index) => player(`p${index}`, index === 0, index < 4 ? "OVERSEAS" : "INDIAN"));
  const ordinary = makeCatalog(definitions, "ordinary");
  const mutated = makeCatalog(definitions, "mutated-fit-bowling-quality");
  assert.deepEqual(
    evaluateFutureCompletion(ordinary, "era-foundation", []),
    evaluateFutureCompletion(mutated, "era-foundation", []),
  );
});

function player(
  suffix: string,
  keeper = false,
  status: "INDIAN" | "OVERSEAS" = "INDIAN",
  teamSeasonId: TeamSeasonId = "ts:team-a:ipl-2008",
): PlayerDefinition {
  return { ptsId: `pts:${suffix}:ipl-2008:team-a`, playerId: suffix, teamSeasonId, status, keeper };
}

function makeCatalog(definitions: readonly PlayerDefinition[], metadataMarker = "ordinary"): EraDraftCatalog {
  const eligible = definitions.map((definition): EraDraftEligibilityRow => ({
    schemaVersion: "ipl-era-draft-eligibility-row/v1",
    eligibilityVersion: "ipl-era-draft-eligibility/v1",
    playerTeamSeasonId: definition.ptsId,
    playerId: definition.playerId,
    canonicalDisplayName: definition.playerId,
    seasonId: definition.teamSeasonId?.split(":")[2] ?? "ipl-2008",
    teamId: definition.teamSeasonId?.split(":")[1] ?? "team-a",
    eligibilityStatus: "ELIGIBLE",
  }));
  const eligibilityById = new Map(eligible.map((row) => [row.playerTeamSeasonId, row]));
  const players = definitions.map((definition, index): EraDraftPlayerRecord => {
    const teamSeasonId = definition.teamSeasonId ?? "ts:team-a:ipl-2008";
    const [, teamId, seasonId] = teamSeasonId.split(":");
    return {
      playerTeamSeasonId: definition.ptsId,
      playerId: definition.playerId,
      canonicalDisplayName: definition.playerId,
      seasonId: seasonId!,
      seasonYear: 2008 + index,
      eraId: "era-foundation",
      teamId: teamId!,
      teamName: teamId!,
      franchiseId: `franchise-${teamId}`,
      franchiseName: teamId!,
      teamSeasonId,
      eligibility: eligible[index]!,
      role: { metadataMarker } as unknown as EraDraftPlayerRecord["role"],
      quality: { metadataMarker } as unknown as EraDraftPlayerRecord["quality"],
      historicalStats: { metadataMarker } as unknown as EraDraftPlayerRecord["historicalStats"],
      rosterStatus: definition.status ?? "INDIAN",
    };
  });
  const playerByPts = new Map(players.map((record) => [record.playerTeamSeasonId, record]));
  const teamSeasonIds = [...new Set(players.map((record) => record.teamSeasonId))].sort();
  const teamSeasons = teamSeasonIds.map((teamSeasonId): EraDraftTeamSeason => {
    const first = players.find((record) => record.teamSeasonId === teamSeasonId)!;
    return {
      teamSeasonId,
      eraId: "era-foundation",
      seasonId: first.seasonId,
      seasonYear: first.seasonYear,
      teamId: first.teamId,
      teamName: first.teamName,
      franchiseId: first.franchiseId,
      franchiseName: first.franchiseName,
    };
  });
  const teamSeasonById = new Map(teamSeasons.map((record) => [record.teamSeasonId, record]));
  const candidatesByTeamSeason = new Map(teamSeasonIds.map((teamSeasonId) => [
    teamSeasonId,
    players.filter((record) => record.teamSeasonId === teamSeasonId),
  ]));
  const keepers = [...new Set(definitions.filter((definition) => definition.keeper).map((definition) => definition.playerId))].sort();
  return {
    fingerprint: `synthetic-${metadataMarker}`,
    diagnostics: {} as EraDraftCatalog["diagnostics"],
    getEra: (eraId) => eraId === "era-foundation" ? { eraId, label: "Foundation", seasonIds: ["ipl-2008"] } : undefined,
    getEraIds: () => ["era-foundation"],
    getEraForSeason: () => "era-foundation",
    getTeamSeason: (teamSeasonId) => teamSeasonById.get(teamSeasonId),
    getTeamSeasonsForEra: (eraId) => eraId === "era-foundation" ? teamSeasons : [],
    getEligibilityRow: (ptsId) => eligibilityById.get(ptsId),
    getPlayer: (ptsId) => playerByPts.get(ptsId),
    getCandidatesForTeamSeason: (teamSeasonId) => candidatesByTeamSeason.get(teamSeasonId) ?? [],
    getPlayerVariantsForEra: (eraId, playerId) => eraId === "era-foundation"
      ? players.filter((record) => record.playerId === playerId)
      : [],
    getKeeperCapablePlayerIds: (eraId) => eraId === "era-foundation" ? keepers : [],
    getSimulationContent: () => ({ status: "UNAVAILABLE", opponentCount: 0 }),
    getEnvironment: () => undefined,
    getOpponentProfiles: () => [],
    getFoundationOpponents: () => [],
  };
}

function makePick(
  catalog: EraDraftCatalog,
  playerTeamSeasonId: string,
  pickNumber: number,
  battingPosition: number,
): EraDraftPick {
  const playerRecord = catalog.getPlayer(playerTeamSeasonId)!;
  return {
    pickNumber,
    playerTeamSeasonId,
    playerId: playerRecord.playerId,
    seasonId: playerRecord.seasonId,
    teamId: playerRecord.teamId,
    franchiseId: playerRecord.franchiseId,
    teamSeasonId: playerRecord.teamSeasonId,
    battingPosition: battingPosition as EraDraftPick["battingPosition"],
  };
}

// Frozen pre-optimization implementation: differential oracle, not used by production.
function sortingReference(
  catalog: EraDraftCatalog,
  eraId: EraId,
  picks: readonly EraDraftPick[],
): FutureCompletionFeasibility {
  const remainingSlots = 11 - picks.length;
  const remainingOverseasCapacity = 4 - countOverseas(catalog, picks);
  const keeperIds = new Set(catalog.getKeeperCapablePlayerIds(eraId));
  const draftedIds = new Set(picks.map((pick) => pick.playerId));
  const keeperAlreadyDrafted = picks.some((pick) => keeperIds.has(pick.playerId));
  const minimumCostByPlayer = new Map<string, number>();

  for (const teamSeason of catalog.getTeamSeasonsForEra(eraId)) {
    for (const player of catalog.getCandidatesForTeamSeason(teamSeason.teamSeasonId)) {
      if (draftedIds.has(player.playerId)) continue;
      if ((player as { rosterStatus: string }).rosterStatus === "UNKNOWN") {
        throw new EraDraftInvariantError("UNKNOWN_REMAINING_ROSTER_STATUS", `${player.playerTeamSeasonId} has unresolved roster status.`);
      }
      const cost = player.rosterStatus === "INDIAN" ? 0 : 1;
      minimumCostByPlayer.set(player.playerId, Math.min(minimumCostByPlayer.get(player.playerId) ?? 1, cost));
    }
  }

  const base = {
    remainingSlots,
    remainingOverseasCapacity,
    remainingCanonicalPlayers: minimumCostByPlayer.size,
    keeperAlreadyDrafted,
  };
  if (remainingSlots < 0 || remainingOverseasCapacity < 0) {
    return freezeFeasibility({ ...base, feasible: false, minimumOverseasNeeded: null, viableKeeperPlayerIds: [] });
  }
  if (remainingSlots === 0) {
    return freezeFeasibility({
      ...base,
      feasible: keeperAlreadyDrafted,
      minimumOverseasNeeded: keeperAlreadyDrafted ? 0 : null,
      viableKeeperPlayerIds: [],
    });
  }

  if (keeperAlreadyDrafted) {
    const costs = [...minimumCostByPlayer.values()].sort((left, right) => left - right);
    const minimumOverseasNeeded = costs.length >= remainingSlots
      ? costs.slice(0, remainingSlots).reduce((total, cost) => total + cost, 0)
      : null;
    return freezeFeasibility({
      ...base,
      feasible: minimumOverseasNeeded !== null && minimumOverseasNeeded <= remainingOverseasCapacity,
      minimumOverseasNeeded,
      viableKeeperPlayerIds: [],
    });
  }

  let minimumOverseasNeeded: number | null = null;
  const viableKeeperPlayerIds: string[] = [];
  for (const keeperId of [...keeperIds].sort()) {
    const keeperCost = minimumCostByPlayer.get(keeperId);
    if (keeperCost === undefined) continue;
    const otherCosts = [...minimumCostByPlayer]
      .filter(([playerId]) => playerId !== keeperId)
      .map(([, cost]) => cost)
      .sort((left, right) => left - right);
    if (otherCosts.length < remainingSlots - 1) continue;
    const completionCost = keeperCost
      + otherCosts.slice(0, remainingSlots - 1).reduce((total, cost) => total + cost, 0);
    minimumOverseasNeeded = minimumOverseasNeeded === null
      ? completionCost
      : Math.min(minimumOverseasNeeded, completionCost);
    if (completionCost <= remainingOverseasCapacity) viableKeeperPlayerIds.push(keeperId);
  }
  return freezeFeasibility({
    ...base,
    feasible: viableKeeperPlayerIds.length > 0,
    minimumOverseasNeeded,
    viableKeeperPlayerIds,
  });
}

function countOverseas(catalog: EraDraftCatalog, picks: readonly EraDraftPick[]): number {
  return picks.reduce((count, pick) => {
    const player = catalog.getPlayer(pick.playerTeamSeasonId);
    if (!player) throw new EraDraftInvariantError("UNKNOWN_PICK_PLAYER", `Pick references unknown ${pick.playerTeamSeasonId}.`);
    if ((player as { rosterStatus: string }).rosterStatus === "UNKNOWN") {
      throw new EraDraftInvariantError("UNKNOWN_PICK_ROSTER_STATUS", `Pick ${pick.playerTeamSeasonId} has unresolved roster status.`);
    }
    return count + (player.rosterStatus === "OVERSEAS" ? 1 : 0);
  }, 0);
}

function freezeFeasibility(value: FutureCompletionFeasibility): FutureCompletionFeasibility {
  Object.freeze(value.viableKeeperPlayerIds);
  return Object.freeze(value);
}

test("count-based completion equals sorting across all five committed eras and historical variants", () => {
  const full = loadEraDraftCatalog();
  const documents = loadEraDraftCatalogDocuments();
  assert.equal(full.getEraIds().length, 5);
  const catalogs = [full, ...full.getEraIds().map(eraId => buildScopedEraDraftCatalog(
    createEraDraftWebArtifact(documents, eraId), { eraId, catalogFingerprint: full.fingerprint },
  ))];
  for (const catalog of catalogs) for (const eraId of catalog.getEraIds()) {
    const records = catalog.getTeamSeasonsForEra(eraId)
      .flatMap(({ teamSeasonId }) => catalog.getCandidatesForTeamSeason(teamSeasonId));
    const keepers = new Set(catalog.getKeeperCapablePlayerIds(eraId));
    const variants = [...new Map(records.map(p => [p.playerId, p])).values()];
    // Both first and last historical variants, plus an interior variant where present.
    for (const variantIndex of [0, 1, -1]) {
      const players = variants.map(p => {
        const versions = catalog.getPlayerVariantsForEra(eraId, p.playerId);
        return versions[variantIndex < 0 ? versions.length - 1 : Math.min(variantIndex, versions.length - 1)]!;
      });
      for (const count of [0, 1, 5, 9, 10, 11, 12]) {
        for (const overseasCount of [0, 1, 3, 4, 5]) {
          if (overseasCount > count) continue;
          for (const keeperNeeded of [true, false]) {
            const selected: EraDraftPlayerRecord[] = [];
            if (!keeperNeeded && count > 0) {
              selected.push(players.find(p => keepers.has(p.playerId)
                && p.rosterStatus === (overseasCount > 0 ? "OVERSEAS" : "INDIAN"))!);
            }
            assert.ok(selected.every(Boolean));
            for (const status of ["OVERSEAS", "INDIAN"] as const) {
              const target = status === "OVERSEAS" ? overseasCount : count - overseasCount;
              const pool = players.filter(p => p.rosterStatus === status
                && (!keeperNeeded || !keepers.has(p.playerId)));
              for (const p of pool) {
                if (selected.filter(s => s.rosterStatus === status).length >= target) break;
                if (!selected.some(s => s.playerId === p.playerId)) selected.push(p);
              }
            }
            assert.equal(selected.length, count);
            const picks = selected.map((p, i) => makePick(catalog, p.playerTeamSeasonId, i + 1, i % 11 + 1));
            assertEquivalent(catalog, eraId, picks);
          }
        }
      }
    }
  }
});

test("count-based completion equals sorting for scarce domestic/overseas fillers and keeper variants", () => {
  for (let domestic = 0; domestic <= 12; domestic++) {
    for (let overseas = 0; overseas <= 12; overseas++) {
      for (const keeperStatus of ["none", "INDIAN", "OVERSEAS", "dual"] as const) {
        for (const draftedOverseas of [0, 3, 4, 5]) {
          for (const draftedKeeper of [false, true]) {
            const drafted = Array.from({ length: 9 }, (_, i) => player(`picked-${i}`, draftedKeeper && i === 8,
              i < draftedOverseas ? "OVERSEAS" : "INDIAN"));
            const remaining = [
              ...Array.from({ length: domestic }, (_, i) => player(`i-${i}`)),
              ...Array.from({ length: overseas }, (_, i) => player(`o-${i}`, false, "OVERSEAS")),
            ];
            if (keeperStatus !== "none") remaining.push(player("z-keeper", true, keeperStatus === "INDIAN" ? "INDIAN" : "OVERSEAS"));
            if (keeperStatus === "dual") remaining.push({ ...player("keeper-domestic-variant", true), playerId: "z-keeper", teamSeasonId: "ts:team-b:ipl-2009" });
            if (domestic > 0) remaining.push({ ...player("a-keeper", true), playerId: "i-0" });
            const catalog = makeCatalog([...drafted, ...remaining]);
            for (const count of [0, 5, 9]) {
              assertEquivalent(catalog, "era-foundation", drafted.slice(0, count).map((p, i) => makePick(catalog, p.ptsId, i + 1, i + 1)));
            }
          }
        }
      }
    }
  }
});

test("equivalence preserves fail-closed errors and scan order even for complete or invalid XIs", () => {
  const definitions = Array.from({ length: 13 }, (_, i) => player(`p${i}`, i === 0));
  const base = makeCatalog(definitions);
  const unknown = (p: EraDraftPlayerRecord) => ({ ...p, rosterStatus: "UNKNOWN" } as unknown as EraDraftPlayerRecord);
  for (const count of [0, 5, 11, 12, 13]) {
    const picks = definitions.slice(0, count).map((p, i) => makePick(base, p.ptsId, i + 1, i % 11 + 1));
    const catalog = { ...base, getCandidatesForTeamSeason: (id: TeamSeasonId) => base.getCandidatesForTeamSeason(id).map(unknown) };
    assertEquivalent(catalog, "era-foundation", picks);
    if (count < definitions.length) {
      assert.throws(() => evaluateFutureCompletion(catalog, "era-foundation", picks), { code: "UNKNOWN_REMAINING_ROSTER_STATUS", message: `${definitions[count]!.ptsId} has unresolved roster status.` });
    } else {
      assert.equal(evaluateFutureCompletion(catalog, "era-foundation", picks).remainingCanonicalPlayers, 0);
    }
  }
  const pick = makePick(base, definitions[0]!.ptsId, 1, 1);
  const missing = { ...base, getPlayer: () => undefined };
  const unresolved = { ...base, getPlayer: (id: string) => { const p = base.getPlayer(id); return p && unknown(p); } };
  for (const catalog of [missing, unresolved]) assertEquivalent(catalog, "era-foundation", [pick]);
  // Drafted variants are skipped before checking UNKNOWN, as in the original scan.
  const skipped = { ...base, getCandidatesForTeamSeason: (id: TeamSeasonId) => base.getCandidatesForTeamSeason(id).map(p => p.playerId === pick.playerId ? unknown(p) : p) };
  assertEquivalent(skipped, "era-foundation", [pick]);
});

function assertEquivalent(catalog: EraDraftCatalog, eraId: Parameters<typeof evaluateFutureCompletion>[1], picks: readonly EraDraftPick[]): void {
  const outcome = (fn: typeof evaluateFutureCompletion) => {
    try { return { result: fn(catalog, eraId, picks) }; }
    catch (error) {
      assert.ok(error instanceof EraDraftInvariantError);
      return { error: { name: error.name, code: error.code, message: error.message } };
    }
  };
  const actual = outcome(evaluateFutureCompletion);
  assert.deepEqual(actual, outcome(sortingReference));
  assert.deepEqual(actual, outcome(countReference));
  const index = buildEraDraftCompletionIndex(catalog.getTeamSeasonsForEra(eraId)
    .flatMap(team => catalog.getCandidatesForTeamSeason(team.teamSeasonId)));
  const indexed = indexView(catalog, eraId, index);
  assert.deepEqual(outcome((_catalog, _era, _picks) => evaluateFutureCompletion(indexed, _era, _picks)), actual);
  assert.ok(Object.isFrozen(index));
  assert.ok(Object.isFrozen(index.unknownRows));
  assert.ok(index.unknownRows.every(Object.isFrozen));
  if (actual.result) {
    assert.ok(Object.isFrozen(actual.result));
    assert.ok(Object.isFrozen(actual.result.viableKeeperPlayerIds));
  }
}

// Frozen count-based implementation before the catalog index.
function countReference(
  catalog: EraDraftCatalog,
  eraId: EraId,
  picks: readonly EraDraftPick[],
): FutureCompletionFeasibility {
  const remainingSlots = 11 - picks.length;
  const remainingOverseasCapacity = 4 - countOverseas(catalog, picks);
  const keeperIds = new Set(catalog.getKeeperCapablePlayerIds(eraId));
  const draftedIds = new Set(picks.map((pick) => pick.playerId));
  const keeperAlreadyDrafted = picks.some((pick) => keeperIds.has(pick.playerId));
  const minimumCostByPlayer = new Map<string, number>();

  for (const teamSeason of catalog.getTeamSeasonsForEra(eraId)) {
    for (const player of catalog.getCandidatesForTeamSeason(teamSeason.teamSeasonId)) {
      if (draftedIds.has(player.playerId)) continue;
      if ((player as { rosterStatus: string }).rosterStatus === "UNKNOWN") {
        throw new EraDraftInvariantError("UNKNOWN_REMAINING_ROSTER_STATUS", `${player.playerTeamSeasonId} has unresolved roster status.`);
      }
      const cost = player.rosterStatus === "INDIAN" ? 0 : 1;
      minimumCostByPlayer.set(player.playerId, Math.min(minimumCostByPlayer.get(player.playerId) ?? 1, cost));
    }
  }

  const base = {
    remainingSlots,
    remainingOverseasCapacity,
    remainingCanonicalPlayers: minimumCostByPlayer.size,
    keeperAlreadyDrafted,
  };
  if (remainingSlots < 0 || remainingOverseasCapacity < 0) {
    return freezeFeasibility({ ...base, feasible: false, minimumOverseasNeeded: null, viableKeeperPlayerIds: [] });
  }
  if (remainingSlots === 0) {
    return freezeFeasibility({
      ...base,
      feasible: keeperAlreadyDrafted,
      minimumOverseasNeeded: keeperAlreadyDrafted ? 0 : null,
      viableKeeperPlayerIds: [],
    });
  }

  // Each canonical player's cheapest historical variant costs exactly zero or one.
  // Choosing the cheapest slots therefore uses all available domestic players first.
  let domesticPlayers = 0;
  for (const cost of minimumCostByPlayer.values()) {
    if (cost === 0) domesticPlayers += 1;
  }

  if (keeperAlreadyDrafted) {
    const minimumOverseasNeeded = minimumCostByPlayer.size >= remainingSlots
      ? Math.max(0, remainingSlots - domesticPlayers)
      : null;
    return freezeFeasibility({
      ...base,
      feasible: minimumOverseasNeeded !== null && minimumOverseasNeeded <= remainingOverseasCapacity,
      minimumOverseasNeeded,
      viableKeeperPlayerIds: [],
    });
  }

  let minimumOverseasNeeded: number | null = null;
  const viableKeeperPlayerIds: string[] = [];
  for (const keeperId of [...keeperIds].sort()) {
    const keeperCost = minimumCostByPlayer.get(keeperId);
    if (keeperCost === undefined) continue;
    if (minimumCostByPlayer.size - 1 < remainingSlots - 1) continue;
    const otherDomesticPlayers = domesticPlayers - (keeperCost === 0 ? 1 : 0);
    const completionCost = keeperCost + Math.max(0, remainingSlots - 1 - otherDomesticPlayers);
    minimumOverseasNeeded = minimumOverseasNeeded === null
      ? completionCost
      : Math.min(minimumOverseasNeeded, completionCost);
    if (completionCost <= remainingOverseasCapacity) viableKeeperPlayerIds.push(keeperId);
  }
  return freezeFeasibility({
    ...base,
    feasible: viableKeeperPlayerIds.length > 0,
    minimumOverseasNeeded,
    viableKeeperPlayerIds,
  });
}



function indexView(catalog: EraDraftCatalog, eraId: EraId, index: ReturnType<typeof buildEraDraftCompletionIndex>): EraDraftCatalog {
  return new Proxy(catalog, {
    get(target, key) {
      if (key === "getCompletionCostIndex") return (id: EraId) => id === eraId ? index : undefined;
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

test("index preserves the first undrafted UNKNOWN across team seasons and known/unknown variants", () => {
  const definitions = [
    player("z-known", true),
    { ...player("unknown-first"), playerId: "z-known" },
    player("a-unknown", false, "INDIAN", "ts:team-b:ipl-2009"),
    ...Array.from({ length: 12 }, (_, i) => player(`filler-${i}`)),
  ];
  const base = makeCatalog(definitions);
  const unknownIds = new Set([definitions[1]!.ptsId, definitions[2]!.ptsId]);
  const catalog = { ...base, getCandidatesForTeamSeason: (id: TeamSeasonId) => base.getCandidatesForTeamSeason(id)
    .map(p => unknownIds.has(p.playerTeamSeasonId) ? { ...p, rosterStatus: "UNKNOWN" } as unknown as EraDraftPlayerRecord : p) };
  const index = buildEraDraftCompletionIndex(catalog.getTeamSeasonsForEra("era-foundation")
    .flatMap(team => catalog.getCandidatesForTeamSeason(team.teamSeasonId)));
  const indexed = indexView(catalog, "era-foundation", index);
  assert.deepEqual(index.unknownRows.map(p => p.playerTeamSeasonId), [definitions[1]!.ptsId, definitions[2]!.ptsId]);
  assert.equal(index.getMinimumCost("z-known"), 0);
  const known = makePick(base, definitions[0]!.ptsId, 1, 1);
  const other = makePick(base, definitions[2]!.ptsId, 2, 2);
  for (const picks of [[], [known], [other], [known, other], [known, known, other]]) {
    assertEquivalent(catalog, "era-foundation", picks);
    assertEquivalent(indexed, "era-foundation", picks);
  }
  assert.throws(() => evaluateFutureCompletion(indexed, "era-foundation", []), {
    code: "UNKNOWN_REMAINING_ROSTER_STATUS", message: `${definitions[1]!.ptsId} has unresolved roster status.`,
  });
  assert.throws(() => evaluateFutureCompletion(indexed, "era-foundation", [known]), {
    code: "UNKNOWN_REMAINING_ROSTER_STATUS", message: `${definitions[2]!.ptsId} has unresolved roster status.`,
  });
});

test("catalog index is stable and avoids candidate rescans; out-of-era and duplicate drafted IDs are excluded correctly", () => {
  const catalog = loadEraDraftCatalog();
  const eraId = "era-foundation";
  const index = catalog.getCompletionCostIndex!(eraId)!;
  assert.equal(catalog.getCompletionCostIndex!(eraId), index);
  const noScan = new Proxy(catalog, {
    get(target, key) {
      if (key === "getTeamSeasonsForEra" || key === "getCandidatesForTeamSeason") return () => assert.fail("Indexed completion rescanned candidates");
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const outside = catalog.getTeamSeasonsForEra("era-impact").flatMap(t => catalog.getCandidatesForTeamSeason(t.teamSeasonId))
    .find(p => index.getMinimumCost(p.playerId) === undefined)!;
  assert.ok(outside);
  const pick = makePick(catalog, outside.playerTeamSeasonId, 1, 1);
  for (const picks of [[], [pick], [pick, pick]]) {
    assert.deepEqual(evaluateFutureCompletion(noScan, eraId, picks), countReference(catalog, eraId, picks));
    assertEquivalent(catalog, eraId, picks);
  }
});
