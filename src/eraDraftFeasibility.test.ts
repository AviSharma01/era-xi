import assert from "node:assert/strict";
import test from "node:test";

import type {
  EraDraftCatalog,
  EraDraftEligibilityRow,
  EraDraftPlayerRecord,
  EraDraftTeamSeason,
} from "./eraDraftData.js";
import { evaluateFutureCompletion, evaluateSelectionLegality } from "./eraDraftLegality.js";
import type { EraDraftPick, TeamSeasonId } from "./eraDraftTypes.js";

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
