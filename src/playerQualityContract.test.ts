import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  parsePlayerQualityConsumer,
  type PlayerQualityConsumer,
} from "./playerQualityContract.js";

const CONTRACT_PATH = "data/processed/era-draft/quality/v1/player_quality_consumer.jsonl";

function rawRows(): Record<string, unknown>[] {
  return readFileSync(CONTRACT_PATH, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function loadRows(): PlayerQualityConsumer[] {
  return rawRows().map((row, index) => parsePlayerQualityConsumer(row, `row[${index}]`));
}

test("generated Stage 6 consumer rows satisfy the strict standalone contract", () => {
  const rows = loadRows();
  assert.equal(rows.length, 2_992);
  assert.equal(new Set(rows.map((row) => row.playerId)).size, 727);
  assert.equal(new Set(rows.map((row) => row.playerTeamSeasonId)).size, 2_992);
  assert.deepEqual(
    rows.map((row) => row.playerTeamSeasonId),
    [...rows].map((row) => row.playerTeamSeasonId).sort(),
  );

  assert.deepEqual(
    Object.fromEntries(["NONE", "LIMITED", "ESTABLISHED"].map((state) => [
      state,
      rows.filter((row) => row.batting.evidenceState === state).length,
    ])),
    { NONE: 216, LIMITED: 1_698, ESTABLISHED: 1_078 },
  );
  assert.deepEqual(
    Object.fromEntries(["NONE", "LIMITED", "ESTABLISHED"].map((state) => [
      state,
      rows.filter((row) => row.bowling.evidenceState === state).length,
    ])),
    { NONE: 1_025, LIMITED: 943, ESTABLISHED: 1_024 },
  );
});

test("overall primary, bonus, tiers, and sparse-evidence policy match v1", () => {
  const rows = loadRows();
  assert.deepEqual(
    Object.fromEntries(["BATTING", "BOWLING"].map((component) => [
      component,
      rows.filter((row) => row.overall.primaryComponent === component).length,
    ])),
    { BATTING: 1_593, BOWLING: 1_399 },
  );
  assert.deepEqual(
    Object.fromEntries(["S", "A", "B", "C", "D"].map((tier) => [
      tier,
      rows.filter((row) => row.overall.qualityTier === tier).length,
    ])),
    { S: 332, A: 318, B: 948, C: 1_243, D: 151 },
  );
  assert.equal(rows.filter((row) => row.overall.secondaryBonus > 0).length, 29);
  assert.equal(rows.filter((row) => row.overall.limitedDFloorApplied).length, 626);
  assert.equal(rows.filter((row) =>
    row.overall.evidenceState === "LIMITED" && ["S", "A"].includes(row.overall.qualityTier)).length, 10);
});

test("contract rejects shape, nullability, primary-selection, and floor violations", () => {
  const source = rawRows();
  const observed = source.find((row) =>
    (row.batting as Record<string, unknown>).evidenceState !== "NONE"
    && (row.bowling as Record<string, unknown>).evidenceState !== "NONE");
  assert.ok(observed);

  const classicField = structuredClone(observed);
  classicField.baseRating = 80;
  assert.throws(() => parsePlayerQualityConsumer(classicField), /invalid shape/);

  const badNone = structuredClone(source.find((row) =>
    (row.bowling as Record<string, unknown>).evidenceState === "NONE")!);
  (badNone.bowling as Record<string, unknown>).bowlingRating = 60;
  assert.throws(() => parsePlayerQualityConsumer(badNone), /NONE evidence/);

  const badPrimary = structuredClone(observed);
  const overall = badPrimary.overall as Record<string, unknown>;
  overall.primaryInternalScore = (overall.primaryInternalScore as number) + 0.1;
  assert.throws(() => parsePlayerQualityConsumer(badPrimary), /primary score/);

  const badFloor = structuredClone(source.find((row) =>
    (row.overall as Record<string, unknown>).limitedDFloorApplied === true)!);
  (badFloor.overall as Record<string, unknown>).limitedDFloorApplied = false;
  assert.throws(() => parsePlayerQualityConsumer(badFloor), /D-floor/);
});

test("Stage 5 and Stage 6 remain separate joinable contracts", () => {
  const quality = loadRows();
  const roleIds = readFileSync(
    "data/processed/era-draft/roles/v1/player_role_consumer.jsonl",
    "utf8",
  ).trim().split("\n").map((line) => (JSON.parse(line) as { playerTeamSeasonId: string }).playerTeamSeasonId);
  assert.deepEqual(quality.map((row) => row.playerTeamSeasonId), roleIds);

  const forbidden = /baseRating|absoluteTier|draftTier|derivedRole|positionFit|keeper|bowlingFamily|overseas/i;
  for (const row of rawRows()) {
    assert.doesNotMatch(JSON.stringify(row), forbidden);
  }
});
