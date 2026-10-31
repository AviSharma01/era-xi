/** One-time capture for the new contract. Exclusive creation prevents silently accepting drift. */
import { writeFileSync } from 'node:fs';
import { canonicalSha256 } from '../dist/eraDraftCanonical.js';
import { canonicalEraDraftStateHash } from '../dist/eraDraftPersistence.js';
import { reduceEraDraft } from '../dist/eraDraftEngine.js';
import { projectDraftOffParticipantResults } from '../dist/draftOffResultsProjection.js';
import { ERA_IDS } from '../dist/teamEvaluationV2.js';
import { catalog, soloXi, resolvedRoom, participantId } from '../dist/evaluationV3TestSupport.js';
const solo = {}, rooms = {};
for (const era of ERA_IDS) {
  let state = soloXi(era);
  for (const command of [undefined, { type: 'REVEAL_XI' }, { type: 'SIMULATE_SEASON' }]) {
    if (command) { const result = reduceEraDraft(catalog, state, command); if (!result.ok) throw Error(result.error.message); state = result.state; }
    solo[`${era}/${state.phase}`] = canonicalEraDraftStateHash(state);
  }
  for (const format of ['MIRROR', 'VARIED']) for (const count of [2, 8]) {
    const state = resolvedRoom(era, format, count);
    rooms[`${era}/${format}/${count}`] = {
      stateHash: canonicalSha256(state),
      resultsHash: canonicalSha256(projectDraftOffParticipantResults(catalog, state, participantId(1), participantId(1))),
    };
  }
}
const output = new URL('../src/fixtures/evaluationV3Goldens.json', import.meta.url);
writeFileSync(output, JSON.stringify({
  provenance: 'Initial Evaluation V3 / Solo engine v2 / Draft-Off competition v4 capture. Change policy through a new version; do not recapture to accept historical drift.',
  catalogFingerprint: catalog.fingerprint, solo, rooms,
}, null, 2) + '\n', { flag: 'wx' });
console.log(`Captured ${Object.keys(solo).length} Solo and ${Object.keys(rooms).length} room goldens.`);
