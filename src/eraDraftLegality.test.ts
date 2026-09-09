import assert from "node:assert/strict";
import test from "node:test";

import { loadEraDraftCatalog, loadEraDraftCatalogDocuments, type EraDraftCatalog } from "./eraDraftData.js";
import { createEraDraftGame, reduceEraDraft } from "./eraDraftEngine.js";
import { evaluateSelectionLegality } from "./eraDraftLegality.js";
import { projectEraDraftPublicState } from "./eraDraftProjection.js";
import type { AwaitingPickState, EraDraftPick } from "./eraDraftTypes.js";

const catalog = loadEraDraftCatalog();

test("LOCK_PLAYER is rejected outside AWAITING_PICK without mutation", () => {
  const setup = createEraDraftGame({ catalog, rootSeed: "invalid-lock-phase" });
  const result = reduceEraDraft(catalog, setup, {
    type: "LOCK_PLAYER",
    playerTeamSeasonId: "pts:missing:ipl-2008:team-missing",
    battingPosition: 1,
  });
  assert.equal(result.ok, false);
  assert.equal(result.state, setup);
  if (!result.ok) assert.equal(result.error.code, "INVALID_PHASE");
});

test("LOCK_PLAYER stores exact identity atomically, clears the spin, and rejects reused slots", () => {
  const spun = initialSpin("lock-identity");
  const candidate = catalog.getCandidatesForTeamSeason(spun.currentSpin.teamSeasonId)[0]!;
  const locked = reduceEraDraft(catalog, spun, {
    type: "LOCK_PLAYER",
    playerTeamSeasonId: candidate.playerTeamSeasonId,
    battingPosition: 7,
  });
  assert.equal(locked.ok, true);
  if (!locked.ok) return;
  assert.equal(locked.state.phase, "AWAITING_SPIN");
  assert.equal("currentSpin" in locked.state, false);
  assert.deepEqual(locked.state.picks[0], {
    pickNumber: 1,
    playerTeamSeasonId: candidate.playerTeamSeasonId,
    playerId: candidate.playerId,
    seasonId: candidate.seasonId,
    teamId: candidate.teamId,
    franchiseId: candidate.franchiseId,
    teamSeasonId: candidate.teamSeasonId,
    battingPosition: 7,
  });

  const nextSpin = requiredState(reduceEraDraft(catalog, locked.state, { type: "SPIN" })) as AwaitingPickState;
  const nextCandidate = catalog.getCandidatesForTeamSeason(nextSpin.currentSpin.teamSeasonId)
    .find((player) => player.playerId !== candidate.playerId)!;
  const occupied = reduceEraDraft(catalog, nextSpin, {
    type: "LOCK_PLAYER",
    playerTeamSeasonId: nextCandidate.playerTeamSeasonId,
    battingPosition: 7,
  });
  assert.equal(occupied.ok, false);
  assert.equal(occupied.state, nextSpin);
  if (!occupied.ok) assert.equal(occupied.error.code, "POSITION_OCCUPIED");
});

test("selection legality distinguishes missing, ineligible, and outside-spin candidates", () => {
  const spun = initialSpin("immediate-legality");
  const context = { eraId: spun.eraId, picks: spun.picks, activeTeamSeasonId: spun.currentSpin.teamSeasonId };
  assert.deepEqual(
    evaluateSelectionLegality(catalog, context, { playerTeamSeasonId: "pts:missing:ipl-2008:team-missing", battingPosition: 1 }).reasons.map(({ code }) => code),
    ["PLAYER_NOT_FOUND"],
  );

  const ineligible = loadEraDraftCatalogDocuments().eligibility.find((row) => row.eligibilityStatus === "INELIGIBLE")!;
  assert.deepEqual(
    evaluateSelectionLegality(catalog, context, { playerTeamSeasonId: ineligible.playerTeamSeasonId, battingPosition: 1 }).reasons.map(({ code }) => code),
    ["PLAYER_NOT_G2_ELIGIBLE"],
  );

  const otherTeamSeason = catalog.getTeamSeasonsForEra(spun.eraId)
    .find((item) => item.teamSeasonId !== spun.currentSpin.teamSeasonId)!;
  const outsider = catalog.getCandidatesForTeamSeason(otherTeamSeason.teamSeasonId)[0]!;
  assert.ok(evaluateSelectionLegality(catalog, context, {
    playerTeamSeasonId: outsider.playerTeamSeasonId,
    battingPosition: 1,
  }).reasons.some(({ code }) => code === "PLAYER_NOT_IN_CURRENT_SPIN"));

  const currentCandidate = catalog.getCandidatesForTeamSeason(spun.currentSpin.teamSeasonId)[0]!;
  assert.deepEqual(
    evaluateSelectionLegality(catalog, context, {
      playerTeamSeasonId: currentCandidate.playerTeamSeasonId,
      battingPosition: 12,
    }).reasons.map(({ code }) => code),
    ["INVALID_POSITION"],
  );

  const unresolvedCatalog = withUnknownRosterStatus(catalog, currentCandidate.playerTeamSeasonId);
  assert.deepEqual(
    evaluateSelectionLegality(unresolvedCatalog, context, {
      playerTeamSeasonId: currentCandidate.playerTeamSeasonId,
      battingPosition: 1,
    }).reasons.map(({ code }) => code),
    ["ROSTER_STATUS_UNRESOLVED"],
  );
});

test("canonical duplicate protection spans historical player-team-season variants", () => {
  const eraId = "era-foundation" as const;
  const player = allEraPlayers(eraId).find((candidate) =>
    catalog.getPlayerVariantsForEra(eraId, candidate.playerId).some((variant) => variant.teamSeasonId !== candidate.teamSeasonId))!;
  const variant = catalog.getPlayerVariantsForEra(eraId, player.playerId)
    .find((candidate) => candidate.teamSeasonId !== player.teamSeasonId)!;
  const pick = makePick(player, 1, 1);
  const result = evaluateSelectionLegality(catalog, {
    eraId,
    picks: [pick],
    activeTeamSeasonId: variant.teamSeasonId,
  }, { playerTeamSeasonId: variant.playerTeamSeasonId, battingPosition: 2 });
  assert.ok(result.reasons.some(({ code }) => code === "DUPLICATE_CANONICAL_PLAYER"));
});

test("fifth overseas player is rejected using roster status only", () => {
  const eraId = "era-impact" as const;
  const overseas = uniqueCanonical(allEraPlayers(eraId).filter((player) => player.rosterStatus === "OVERSEAS"));
  const picks = overseas.slice(0, 4).map((player, index) => makePick(player, index + 1, index + 1));
  const fifth = overseas[4]!;
  const result = evaluateSelectionLegality(catalog, {
    eraId,
    picks,
    activeTeamSeasonId: fifth.teamSeasonId,
  }, { playerTeamSeasonId: fifth.playerTeamSeasonId, battingPosition: 5 });
  assert.ok(result.reasons.some(({ code }) => code === "OVERSEAS_LIMIT"));
});

test("projection availability and per-slot reasons equal authoritative legality", () => {
  const spun = initialSpin("projection-legality");
  const view = projectEraDraftPublicState(catalog, spun);
  assert.equal(view.phase, "AWAITING_PICK");
  if (view.phase !== "AWAITING_PICK") return;
  const projected = view.candidates[0]!;
  const context = { eraId: spun.eraId, picks: spun.picks, activeTeamSeasonId: spun.currentSpin.teamSeasonId };
  for (const position of projected.positions) {
    const direct = evaluateSelectionLegality(catalog, context, {
      playerTeamSeasonId: projected.playerTeamSeasonId,
      battingPosition: position.battingPosition,
    });
    assert.equal(position.available, direct.available);
    assert.deepEqual(position.reasons, direct.reasons);
    assert.ok(["NATURAL", "ACCEPTABLE", "OUT_OF_ROLE", "UNKNOWN"].includes(position.fit));
  }
  assertNoHiddenQuality(projected);
});

function initialSpin(seed: string): AwaitingPickState {
  const setup = createEraDraftGame({ catalog, rootSeed: seed });
  const chosen = requiredState(reduceEraDraft(catalog, setup, { type: "CHOOSE_ERA", eraId: "era-foundation" }));
  return requiredState(reduceEraDraft(catalog, chosen, { type: "SPIN" })) as AwaitingPickState;
}

function requiredState(result: ReturnType<typeof reduceEraDraft>) {
  if (!result.ok) assert.fail(result.error.message);
  return result.state;
}

function allEraPlayers(eraId: "era-foundation" | "era-impact") {
  return catalog.getTeamSeasonsForEra(eraId).flatMap((teamSeason) => catalog.getCandidatesForTeamSeason(teamSeason.teamSeasonId));
}

function uniqueCanonical<T extends { playerId: string }>(players: readonly T[]): T[] {
  return [...new Map(players.map((player) => [player.playerId, player])).values()];
}

function makePick(player: ReturnType<typeof allEraPlayers>[number], pickNumber: number, battingPosition: number): EraDraftPick {
  return {
    pickNumber,
    playerTeamSeasonId: player.playerTeamSeasonId,
    playerId: player.playerId,
    seasonId: player.seasonId,
    teamId: player.teamId,
    franchiseId: player.franchiseId,
    teamSeasonId: player.teamSeasonId,
    battingPosition: battingPosition as EraDraftPick["battingPosition"],
  };
}

function assertNoHiddenQuality(value: unknown): void {
  const forbidden = /battingRating|bowlingRating|overallRating|qualityTier|internalScore|primaryInternalScore|adjustedStrength|baseStrength|evaluation|numericEffect|bandDistance/i;
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) item.forEach(visit);
    else if (typeof item === "object" && item !== null) {
      for (const [key, nested] of Object.entries(item)) {
        assert.doesNotMatch(key, forbidden);
        visit(nested);
      }
    }
  };
  visit(value);
}

function withUnknownRosterStatus(base: EraDraftCatalog, targetPlayerTeamSeasonId: string): EraDraftCatalog {
  return {
    fingerprint: base.fingerprint,
    diagnostics: base.diagnostics,
    getEra: (id) => base.getEra(id),
    getEraIds: () => base.getEraIds(),
    getEraForSeason: (id) => base.getEraForSeason(id),
    getTeamSeason: (id) => base.getTeamSeason(id),
    getTeamSeasonsForEra: (id) => base.getTeamSeasonsForEra(id),
    getEligibilityRow: (id) => base.getEligibilityRow(id),
    getPlayer: (id) => {
      const player = base.getPlayer(id);
      return id === targetPlayerTeamSeasonId && player
        ? { ...player, rosterStatus: "UNKNOWN" } as unknown as typeof player
        : player;
    },
    getCandidatesForTeamSeason: (id) => base.getCandidatesForTeamSeason(id),
    getPlayerVariantsForEra: (activeEraId, playerId) => base.getPlayerVariantsForEra(activeEraId, playerId),
    getKeeperCapablePlayerIds: (id) => base.getKeeperCapablePlayerIds(id),
    getSimulationContent: (id) => base.getSimulationContent(id),
    getEnvironment: (id) => base.getEnvironment(id),
    getOpponentProfiles: (id) => base.getOpponentProfiles(id),
    getFoundationOpponents: () => base.getFoundationOpponents(),
  };
}
