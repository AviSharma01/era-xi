import test from "node:test";
import assert from "node:assert/strict";
import type { PlayerRoleConsumer } from "./playerRoleContract.js";
import type { PlayerQualityConsumer } from "./playerQualityContract.js";
import {
  evaluateCompletedEraXi,
  getPositionFitDeduction,
  type BattingPositionV2,
  type EraCompletedXiInput,
} from "./teamEvaluationV2.js";

test("slot-aware batting punishes moving strong batters into the tail independently of fit", () => {
  const natural = xi([90, 85, 80, 75, 70, 65, 60, 30, 28, 25, 20]);
  const broken = xi([30, 28, 25, 20, 60, 65, 70, 90, 85, 80, 75]);
  const good = evaluateCompletedEraXi(natural);
  const bad = evaluateCompletedEraXi(broken);
  assert.equal(good.diagnostics.highestSevenBattingBenchmark, bad.diagnostics.highestSevenBattingBenchmark);
  assert.ok(good.baseStrength.batting - bad.baseStrength.batting > 20);
  assert.equal(good.adjustedStrength.bowling, bad.adjustedStrength.bowling);
});

test("position fit remains a separate batting-only effect capped at four team points", () => {
  const input = xi(Array.from({ length: 11 }, () => 80), Array.from({ length: 11 }, () => "OUT_OF_ROLE"));
  const result = evaluateCompletedEraXi(input);
  assert.ok(result.diagnostics.rawPositionFitEffect < -4);
  assert.equal(result.diagnostics.appliedPositionFitEffect, -4);
  assert.equal(result.adjustedStrength.batting, result.baseStrength.batting - 4);
  assert.equal(result.adjustedStrength.bowling, result.baseStrength.bowling);
  assert.equal(result.effects.length, 1);
});

test("UNKNOWN fit is neutral and acceptable/out-of-role deductions match the frozen policy", () => {
  assert.equal(getPositionFitDeduction("NATURAL", 0), 0);
  assert.equal(getPositionFitDeduction("UNKNOWN", null), 0);
  assert.equal(getPositionFitDeduction("ACCEPTABLE", 1), 1);
  assert.equal(getPositionFitDeduction("OUT_OF_ROLE", 1), 3);
  assert.equal(getPositionFitDeduction("OUT_OF_ROLE", 4), 6);
});

test("capacity deployment uses the 0.75 threshold, ignores surplus, and fills shortages at 20", () => {
  const full = evaluateCompletedEraXi(xi(
    Array.from({ length: 11 }, () => 50),
    undefined,
    [70, 68, 65, 62, 60],
    [0.75, 0.75, 0.75, 0.75, 0.75],
  ));
  assert.equal(full.baseStrength.bowling, 65);
  assert.equal(full.adjustedStrength.bowling, 65);
  assert.equal(full.diagnostics.uncoveredBowlingUnits, 0);

  const occasional = evaluateCompletedEraXi(xi(
    Array.from({ length: 11 }, () => 50),
    undefined,
    [80, 75, 70, 65, 60],
    [0.2, 0.2, 0.2, 0.2, 0.2],
  ));
  assert.equal(Number(occasional.adjustedStrength.bowling.toFixed(2)), 33.33);
  assert.equal(occasional.adjustedStrength.bowling, occasional.baseStrength.bowling);
  assert.ok(occasional.diagnostics.bowlingDeploymentEffect < -30);

  const surplus = evaluateCompletedEraXi(xi(
    Array.from({ length: 11 }, () => 50),
    undefined,
    [80, 75, 70, 65, 60, 95],
    [0.75, 0.75, 0.75, 0.75, 0.75, 0],
  ));
  assert.equal(surplus.adjustedStrength.bowling, 70);
  assert.equal(surplus.adjustedStrength.bowling, surplus.baseStrength.bowling);
});

test("evaluation rejects structural, identity, era, overseas, keeper, and UNKNOWN metadata violations", () => {
  const noKeeper = xi(Array.from({ length: 11 }, () => 50));
  noKeeper.players.forEach((player) => {
    player.role.keeperMetadata.capabilityStatus = "UNKNOWN";
  });
  assert.throws(() => evaluateCompletedEraXi(noKeeper), /wicketkeeper/);

  const unknown = xi(Array.from({ length: 11 }, () => 50));
  unknown.players[0]!.rosterStatus = "UNKNOWN";
  assert.throws(() => evaluateCompletedEraXi(unknown), /UNKNOWN/);

  const overseas = xi(Array.from({ length: 11 }, () => 50));
  overseas.players.slice(0, 5).forEach((player) => { player.rosterStatus = "OVERSEAS"; });
  assert.throws(() => evaluateCompletedEraXi(overseas), /four overseas/);
});

function xi(
  batting: number[],
  fits?: string[],
  bowling: number[] = [70, 68, 65, 62, 60],
  capacities: number[] = [0.75, 0.75, 0.75, 0.75, 0.75],
): EraCompletedXiInput & { players: Array<EraCompletedXiInput["players"][number]> } {
  return {
    era: { eraId: "era-foundation", seasonIds: ["ipl-2008", "ipl-2009", "ipl-2010"] },
    players: batting.map((rating, index) => player(
      (index + 1) as BattingPositionV2,
      rating,
      bowling[index] ?? null,
      capacities[index] ?? 0,
      (fits?.[index] ?? "NATURAL") as "NATURAL" | "ACCEPTABLE" | "OUT_OF_ROLE" | "UNKNOWN",
    )),
  };
}

function player(
  position: BattingPositionV2,
  battingRating: number,
  bowlingRating: number | null,
  bowlingCapacity: number,
  fit: "NATURAL" | "ACCEPTABLE" | "OUT_OF_ROLE" | "UNKNOWN",
): EraCompletedXiInput["players"][number] {
  const playerId = position.toString(16).padStart(8, "0");
  const playerTeamSeasonId = `pts:${playerId}:ipl-2008:team-test`;
  const role = {
    schemaVersion: "ipl-era-draft-player-role-consumer/v1",
    roleMetadataVersion: "ipl-era-draft-player-roles/v1",
    playerTeamSeasonId,
    playerId,
    canonicalDisplayName: `Player ${position}`,
    seasonId: "ipl-2008",
    teamId: "team-test",
    franchiseId: "franchise-test",
    derivedRole: "BATTER",
    allRounderLean: null,
    battingFit: {
      confidence: fit === "UNKNOWN" ? "NONE" : "HIGH",
      basis: fit === "UNKNOWN" ? "UNOBSERVED" : "SEASON",
      primaryBands: fit === "UNKNOWN" ? [] : ["OPENING"],
      slots: Array.from({ length: 11 }, (_, slotIndex) => ({
        position: slotIndex + 1,
        slotBand: slotIndex < 2 ? "OPENING" : slotIndex === 2 ? "TOP_ORDER" : slotIndex < 5 ? "MIDDLE_ORDER" : slotIndex < 8 ? "LOWER_ORDER" : "TAIL",
        classification: slotIndex === position - 1 ? fit : "UNKNOWN",
        bandDistance: slotIndex === position - 1 && fit !== "UNKNOWN"
          ? fit === "NATURAL" ? 0 : fit === "OUT_OF_ROLE" ? 4 : 1
          : null,
      })),
    },
    bowlingCapacity,
    bowlingWorkloadClass: bowlingCapacity >= 0.75 ? "FRONTLINE" : bowlingCapacity >= 0.25 ? "SUPPORT" : bowlingCapacity > 0 ? "OCCASIONAL" : "NONE",
    bowlingEvidence: bowlingRating === null ? "NONE" : "HIGH",
    bowlingFamily: bowlingRating === null ? "UNKNOWN" : position % 2 ? "PACE" : "SPIN",
    phaseBowlingUsage: {
      powerplay: { legalBalls: 1, share: bowlingRating === null ? null : 0.3 },
      middle: { legalBalls: 1, share: bowlingRating === null ? null : 0.5 },
      death: { legalBalls: 1, share: bowlingRating === null ? null : 0.2 },
    },
    keeperMetadata: {
      metadataVersion: "ipl-wicketkeeper-metadata/v1",
      capabilityStatus: position === 1 ? "CONFIRMED" : "UNKNOWN",
      capabilityPlayerId: playerId,
      seasonUsageStatus: position === 1 ? "CONFIRMED" : "UNKNOWN",
      seasonUsagePlayerTeamSeasonId: playerTeamSeasonId,
    },
  } satisfies PlayerRoleConsumer;
  const quality = {
    schemaVersion: "ipl-era-draft-player-quality-consumer/v1",
    qualityModelVersion: "ipl-era-draft-player-quality/v1",
    playerTeamSeasonId,
    playerId,
    canonicalDisplayName: `Player ${position}`,
    seasonId: "ipl-2008",
    teamId: "team-test",
    franchiseId: "franchise-test",
    batting: { evidenceState: "ESTABLISHED", internalScore: 0, battingRating },
    bowling: {
      evidenceState: bowlingRating === null ? "NONE" : "ESTABLISHED",
      internalScore: bowlingRating === null ? null : 0,
      bowlingRating,
    },
    overall: {
      primaryComponent: "BATTING",
      evidenceState: "ESTABLISHED",
      primaryInternalScore: 0,
      secondaryBonus: 0,
      internalScore: 0,
      overallRating: battingRating,
      qualityTier: "B",
      limitedDFloorApplied: false,
    },
  } satisfies PlayerQualityConsumer;
  return { position, role, quality, rosterStatus: "INDIAN" };
}
