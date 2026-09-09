import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parsePlayerRoleConsumer, type PlayerRoleConsumer } from "./playerRoleContract.js";

const CONTRACT_PATH = "data/processed/era-draft/roles/v1/player_role_consumer.jsonl";

function loadRows(): PlayerRoleConsumer[] {
  return readFileSync(CONTRACT_PATH, "utf8")
    .trim()
    .split("\n")
    .map((line, index) => parsePlayerRoleConsumer(JSON.parse(line), `row[${index}]`));
}

test("generated Stage 5 consumer rows satisfy the stable contract", () => {
  const rows = loadRows();
  assert.equal(rows.length, 2_992);
  assert.equal(new Set(rows.map((row) => row.playerTeamSeasonId)).size, 2_992);
  assert.deepEqual(rows.map((row) => row.playerTeamSeasonId), [...rows].map((row) => row.playerTeamSeasonId).sort());

  const roleCounts = Object.fromEntries(
    ["BATTER", "WICKETKEEPER_BATTER", "ALL_ROUNDER", "BOWLER", "UNKNOWN"]
      .map((role) => [role, rows.filter((row) => row.derivedRole === role).length]),
  );
  assert.deepEqual(roleCounts, {
    BATTER: 1_037,
    WICKETKEEPER_BATTER: 271,
    ALL_ROUNDER: 787,
    BOWLER: 897,
    UNKNOWN: 0,
  });

  const leanCounts = Object.fromEntries(
    ["BATTING", "BOWLING", "BALANCED", "NONE"].map((lean) => [
      lean,
      rows.filter((row) => (row.allRounderLean ?? "NONE") === lean).length,
    ]),
  );
  assert.deepEqual(leanCounts, { BATTING: 153, BOWLING: 373, BALANCED: 261, NONE: 2_205 });

  const outOfRole = rows.flatMap((row) => row.battingFit.slots).filter((slot) => slot.classification === "OUT_OF_ROLE");
  assert.equal(outOfRole.length, 13_742);
  assert.ok(outOfRole.every((slot) => Number.isInteger(slot.bandDistance)
    && slot.bandDistance !== null && slot.bandDistance >= 2 && slot.bandDistance <= 4));
});

test("UNKNOWN batting fit remains neutral descriptive metadata", () => {
  const unknown = loadRows().filter((row) => row.battingFit.basis === "UNOBSERVED");
  assert.equal(unknown.length, 91);
  for (const row of unknown) {
    assert.equal(row.battingFit.confidence, "NONE");
    assert.deepEqual(row.battingFit.primaryBands, []);
    assert.ok(row.battingFit.slots.every((slot) => slot.classification === "UNKNOWN" && slot.bandDistance === null));
  }
});

test("contract rejects invalid enums, shapes, and keeper-derived roles", () => {
  const source = JSON.parse(readFileSync(CONTRACT_PATH, "utf8").split("\n", 1)[0] ?? "null");
  const invalidRole = structuredClone(source);
  invalidRole.derivedRole = "FINISHER";
  assert.throws(() => parsePlayerRoleConsumer(invalidRole), /derivedRole/);

  const extraQuality = structuredClone(source);
  extraQuality.baseRating = 99;
  assert.throws(() => parsePlayerRoleConsumer(extraQuality), /invalid shape/);

  const inferredKeeper = structuredClone(source);
  inferredKeeper.derivedRole = "WICKETKEEPER_BATTER";
  inferredKeeper.keeperMetadata.capabilityStatus = "CONFIRMED";
  inferredKeeper.keeperMetadata.seasonUsageStatus = "UNKNOWN";
  assert.throws(() => parsePlayerRoleConsumer(inferredKeeper), /confirmed season usage/);

  const fractionalDistance = structuredClone(source);
  const resolvedSlot = fractionalDistance.battingFit.slots.find((slot: { bandDistance: number | null }) => slot.bandDistance !== null);
  resolvedSlot.bandDistance = 1.5;
  assert.throws(() => parsePlayerRoleConsumer(fractionalDistance), /bandDistance must be an integer/);
});

test("consumer contract exposes no evaluation or selection-policy fields", () => {
  const forbidden = /rating|tier|multiplier|penalty|boost|selectionLegality|bowlingBalance/i;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (typeof value === "object" && value !== null) {
      for (const [key, nested] of Object.entries(value)) {
        assert.doesNotMatch(key, forbidden);
        visit(nested);
      }
    }
  };
  loadRows().forEach(visit);
});
