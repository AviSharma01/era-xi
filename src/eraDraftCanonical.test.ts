import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { canonicalJson, canonicalSha256 } from "./eraDraftCanonical.js";

const vectors: readonly unknown[] = [
  {},
  [],
  { nested: { beta: 2, alpha: 1 }, active: true },
  { z: [3, 2, 1], a: [null, false, "value"] },
  { integer: 42, negative: -17, fraction: 12.375, zero: 0 },
  { unicode: "Era Draft · भारत · 🏏" },
  {
    engineVersion: "ipl-era-draft-engine/v1",
    catalogFingerprint: "a4dfc3d6fac0e0ccce5b8803db4ffcfde9a1b8fc2c437deb8c8b66668f028339",
    rootSeed: "browser-parity",
    eraId: "era-foundation",
    picks: [{ battingPosition: 1, playerTeamSeasonId: "pts:test:2008" }],
  },
];

test("portable canonical SHA-256 matches Node SHA-256 byte-for-byte", () => {
  for (const vector of vectors) {
    const canonical = canonicalJson(vector);
    const expected = createHash("sha256").update(canonical).digest("hex");
    assert.equal(canonicalSha256(vector), expected, canonical);
  }
});

test("canonical SHA-256 remains independent of object insertion order", () => {
  const first = { z: 3, nested: { second: 2, first: 1 }, a: 1 };
  const second = { a: 1, nested: { first: 1, second: 2 }, z: 3 };
  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.equal(canonicalSha256(first), canonicalSha256(second));
});
