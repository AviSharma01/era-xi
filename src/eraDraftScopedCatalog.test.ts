import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson } from "./eraDraftCanonical.js";
import { createEraDraftGame, reduceEraDraft } from "./eraDraftEngine.js";
import { loadEraDraftCatalog, loadEraDraftCatalogDocuments } from "./eraDraftData.js";
import { projectEraDraftPublicState } from "./eraDraftProjection.js";
import { buildScopedEraDraftCatalog } from "./eraDraftScopedCatalog.js";
import { createEraDraftWebArtifact } from "./eraDraftWebArtifacts.js";
import { ERA_IDS } from "./teamEvaluationV2.js";

const documents = loadEraDraftCatalogDocuments();
const full = loadEraDraftCatalog();

test("scoped browser catalogs preserve complete-catalog behavior for every era", () => {
  for (const eraId of ERA_IDS) {
    const scoped = buildScopedEraDraftCatalog(createEraDraftWebArtifact(documents, eraId), {
      eraId,
      catalogFingerprint: documents.fingerprint,
    });
    assert.equal(scoped.fingerprint, full.fingerprint, eraId);
    assert.equal(canonicalJson(scoped.getEra(eraId)), canonicalJson(full.getEra(eraId)), eraId);
    assert.equal(canonicalJson(scoped.getTeamSeasonsForEra(eraId)), canonicalJson(full.getTeamSeasonsForEra(eraId)), eraId);
    assert.equal(canonicalJson(scoped.getKeeperCapablePlayerIds(eraId)), canonicalJson(full.getKeeperCapablePlayerIds(eraId)), eraId);
    assert.equal(canonicalJson(scoped.getEnvironment(eraId)), canonicalJson(full.getEnvironment(eraId)), eraId);
    assert.equal(canonicalJson(scoped.getOpponentProfiles(eraId)), canonicalJson(full.getOpponentProfiles(eraId)), eraId);
    for (const teamSeason of full.getTeamSeasonsForEra(eraId)) {
      assert.equal(canonicalJson(scoped.getCandidatesForTeamSeason(teamSeason.teamSeasonId)),
        canonicalJson(full.getCandidatesForTeamSeason(teamSeason.teamSeasonId)), teamSeason.teamSeasonId);
    }

    const fullSetup = createEraDraftGame({ catalog: full, rootSeed: `scoped-parity:${eraId}` });
    const scopedSetup = createEraDraftGame({ catalog: scoped, rootSeed: `scoped-parity:${eraId}` });
    const fullChosen = reduceEraDraft(full, fullSetup, { type: "CHOOSE_ERA", eraId });
    const scopedChosen = reduceEraDraft(scoped, scopedSetup, { type: "CHOOSE_ERA", eraId });
    assert.ok(fullChosen.ok && scopedChosen.ok);
    const fullSpin = reduceEraDraft(full, fullChosen.state, { type: "SPIN" });
    const scopedSpin = reduceEraDraft(scoped, scopedChosen.state, { type: "SPIN" });
    assert.ok(fullSpin.ok && scopedSpin.ok);
    assert.equal(fullSpin.state.phase, "AWAITING_PICK");
    assert.equal(scopedSpin.state.phase, "AWAITING_PICK");
    if (fullSpin.state.phase !== "AWAITING_PICK" || scopedSpin.state.phase !== "AWAITING_PICK") throw new Error("spin parity failed");
    assert.equal(canonicalJson(projectEraDraftPublicState(full, fullSpin.state)),
      canonicalJson(projectEraDraftPublicState(scoped, scopedSpin.state)), eraId);
  }
});

test("scoped catalog fails closed on fingerprint and joined identity changes", () => {
  const artifact = createEraDraftWebArtifact(documents, "era-foundation");
  assert.throws(() => buildScopedEraDraftCatalog(artifact, { eraId: "era-foundation", catalogFingerprint: "0".repeat(64) }),
    (error) => typeof error === "object" && error !== null && "code" in error && error.code === "WEB_ARTIFACT_IDENTITY_MISMATCH");
  const changed = structuredClone(artifact);
  changed.roles[0]!.playerId = changed.roles[0]!.playerId === "ffffffff" ? "eeeeeeee" : "ffffffff";
  assert.throws(() => buildScopedEraDraftCatalog(changed, { eraId: "era-foundation", catalogFingerprint: documents.fingerprint }));
});
