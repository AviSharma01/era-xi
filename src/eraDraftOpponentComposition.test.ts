import assert from "node:assert/strict";
import test from "node:test";

import { loadEraDraftCatalog } from "./eraDraftData.js";
import {
  ERA_DRAFT_OPPONENT_SHORTLIST_DOMAIN,
  shortlistEraOpponentProfiles,
} from "./eraDraftOpponentComposition.js";
import { random01 } from "./simulationV2.js";
import { ERA_IDS } from "./teamEvaluationV2.js";

const catalog = loadEraDraftCatalog();

test("eight-profile Foundation shortlisting is an order-preserving identity operation", () => {
  const pool = catalog.getOpponentProfiles("era-foundation");
  for (const seed of ["foundation-a", "foundation-b", "foundation-c"]) {
    const shortlist = shortlistEraOpponentProfiles(pool, seed);
    assert.deepEqual(shortlist, pool);
    assert.deepEqual(shortlist.map((profile) => profile.candidateId), pool.map((profile) => profile.candidateId));
  }
});

test("later-era shortlists are deterministic seeded eight-profile frozen-order subsets", () => {
  for (const eraId of ERA_IDS.slice(1)) {
    const pool = catalog.getOpponentProfiles(eraId);
    const first = shortlistEraOpponentProfiles(pool, `shortlist:${eraId}:same`);
    const repeated = shortlistEraOpponentProfiles(pool, `shortlist:${eraId}:same`);
    const other = shortlistEraOpponentProfiles(pool, `shortlist:${eraId}:other`);
    assert.deepEqual(repeated, first);
    assert.equal(first.length, 8);
    assert.equal(new Set(first.map((profile) => profile.candidateId)).size, 8);
    assert.ok(first.every((profile) => profile.eraId === eraId && pool.includes(profile)));
    assert.notDeepEqual(other.map((profile) => profile.candidateId), first.map((profile) => profile.candidateId));

    const poolIndexes = first.map((profile) => pool.indexOf(profile));
    assert.deepEqual(poolIndexes, [...poolIndexes].sort((left, right) => left - right));
    const rankedMembership = new Set([...pool]
      .sort((left, right) => random01(`shortlist:${eraId}:same`, ERA_DRAFT_OPPONENT_SHORTLIST_DOMAIN, left.candidateId)
        - random01(`shortlist:${eraId}:same`, ERA_DRAFT_OPPONENT_SHORTLIST_DOMAIN, right.candidateId)
        || left.candidateId.localeCompare(right.candidateId))
      .slice(0, 8)
      .map((profile) => profile.candidateId));
    assert.deepEqual(new Set(first.map((profile) => profile.candidateId)), rankedMembership);
    assert.notDeepEqual(first.map((profile) => profile.candidateId), [...pool]
      .map((profile) => profile.candidateId).sort().slice(0, 8));
  }
});

test("deterministic multi-seed coverage does not permanently exclude any later-era lineage", () => {
  for (const eraId of ERA_IDS.slice(1)) {
    const pool = catalog.getOpponentProfiles(eraId);
    const represented = new Set<string>();
    const membershipHeads = new Set<string>();
    for (let index = 0; index < 64; index += 1) {
      const shortlist = shortlistEraOpponentProfiles(pool, `shortlist-coverage:${eraId}:${index}`);
      shortlist.forEach((profile) => represented.add(profile.candidateId));
      membershipHeads.add(shortlist.map((profile) => profile.candidateId).join("|"));
    }
    assert.deepEqual(represented, new Set(pool.map((profile) => profile.candidateId)));
    assert.ok(membershipHeads.size > 1);
  }
});
