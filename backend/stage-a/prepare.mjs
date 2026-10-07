import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { buildScopedEraDraftCatalog } from '../../dist/eraDraftScopedCatalog.js';
import { createDraftOffCompetition, reduceDraftOffCompetition } from '../../dist/draftOffCompetition.js';
import { serializeDraftOffCompetition, restoreDraftOffCompetition } from '../../dist/draftOffCompetitionPersistence.js';
import { projectDraftOffRoom } from '../../dist/draftOffRoomProjection.js';
import { canonicalSha256 } from '../../dist/eraDraftCanonical.js';
import { evaluateSelectionLegality, getOpenBattingPositions } from '../../dist/eraDraftLegality.js';

const directory = new URL('./.generated/', import.meta.url);
const root = new URL('../../data/processed/era-draft/web/v1/public/data/era-draft/v1/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'));
mkdirSync(new URL('fixtures/', directory), { recursive: true });
mkdirSync(new URL('results/', import.meta.url), { recursive: true });
const inventory = [];
let modules = `export const manifest = ${JSON.stringify(manifest)};\n`;
const bindings = [];
for (const [index, entry] of manifest.eras.entries()) {
  const bytes = readFileSync(new URL(entry.path, root));
  assert.equal(bytes.length, entry.sizeBytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
  inventory.push({ ...entry, gzipBytes: gzipSync(bytes).length });
  bindings.push(`${JSON.stringify(entry.eraId)}: ${JSON.stringify(bytes.toString('utf8'))}`);
  const catalog = buildScopedEraDraftCatalog(JSON.parse(bytes), { eraId: entry.eraId, catalogFingerprint: manifest.catalogFingerprint });
  for (const count of [2, 8]) {
    let state = createDraftOffCompetition(catalog, {
      competitionId: 'fixture-room', catalogFingerprint: catalog.fingerprint, createdAtMs: 0,
      host: { participantId: 'p0', displayName: 'Player 0' },
      initialRound: { roundId: 'r1', roundOrdinal: 1, label: 'Stage A fixture', eraId: entry.eraId, challengeSeed: 'stage-a-fixed-seed-v1' },
    });
    let receipts = {};
    const save = (name) => {
      const record = { serializedCompetition: serializeDraftOffCompetition(state), receipts };
      restoreDraftOffCompetition(catalog, record.serializedCompetition);
      const last = Object.entries(receipts).at(-1);
      writeFileSync(new URL(`fixtures/${entry.eraId}-${count}-${name}.json`, directory), JSON.stringify({
        eraId: entry.eraId, count, name, record,
        lastCommand: last ? { commandId: last[0], envelope: envelopes[last[0]], actor: { kind: 'PARTICIPANT', participantId: actors[last[0]] }, result: last[1].result } : null,
        draftRevisions: state.rounds[0].phase === 'PENDING' ? [] : state.rounds[0].participants.map(p => ({ participantId: p.participantId, revision: p.draftState.revision })),
        revision: state.revision, historyCount: state.history.length,
        lockEnvelopes: name === 'spun' ? state.rounds[0].participants.map((p,index) => ({
          roomId: 'fixture-room', commandId: `burst-lock-${index}`, expectedDraftRevision: p.draftState.revision, command: lock(p.participantId),
        })) : undefined,
      }));
    };
    const envelopes = {}, actors = {};
    let sequence = 0;
    const apply = (participantId, command, expectedDraftRevision) => {
      const commandId = `fixture-${sequence++}`;
      const envelope = { roomId: 'fixture-room', commandId,
        ...(expectedDraftRevision === undefined ? { expectedRoomRevision: state.revision } : { expectedDraftRevision }), command };
      const domain = command.type === 'JOIN' ? { type: 'JOIN_COMPETITION', participantId, displayName: command.displayName, atMs: 1 }
        : command.type === 'START' ? { type: 'START_ROUND', actorParticipantId: participantId, roundId: 'r1', deadlineAtMs: command.deadlineAtMs, atMs: 10 }
        : command.type === 'SUBMIT' ? { type: 'SUBMIT_XI', participantId, expectedDraftRevision, atMs: 20 }
        : { type: 'APPLY_DRAFT_COMMAND', participantId, expectedDraftRevision, draftCommand: command, atMs: 20 };
      const result = reduceDraftOffCompetition(catalog, state, domain);
      assert.ok(result.ok && result.changed, result.ok ? 'Expected state change' : result.error.code);
      state = result.state;
      const actor = { kind: 'PARTICIPANT', participantId };
      receipts = { ...receipts, [commandId]: { fingerprint: canonicalSha256({ actor, envelope }),
        result: { ok: true, changed: true, roomRevision: state.revision, view: projectDraftOffRoom(catalog, state, participantId) } } };
      envelopes[commandId] = envelope; actors[commandId] = participantId;
    };
    const draft = id => state.rounds[0].participants.find(p => p.participantId === id).draftState;
    const lock = id => {
      const d = draft(id), context = { eraId: entry.eraId, picks: d.picks, activeTeamSeasonId: d.currentSpin.teamSeasonId };
      const candidates = [...catalog.getCandidatesForTeamSeason(d.currentSpin.teamSeasonId)];
      const offset = (Number(id.slice(1)) * 3 + d.picks.length) % candidates.length;
      const ordered = [...candidates.slice(offset), ...candidates.slice(0, offset)];
      for (const player of ordered) for (const battingPosition of getOpenBattingPositions(d.picks)) {
        const selection = { playerTeamSeasonId: player.playerTeamSeasonId, battingPosition };
        if (evaluateSelectionLegality(catalog, context, selection).available) return { type: 'LOCK_PLAYER', ...selection };
      }
      throw new Error('Fixture has no legal selection');
    };
    for (let p = 1; p < count; p++) apply(`p${p}`, { type: 'JOIN', displayName: `Player ${p}` });
    save('lobby');
    apply('p0', { type: 'START', roundId: 'r1', deadlineAtMs: 900010 });
    save('early');
    for (let pick = 0; pick < 11; pick++) {
      for (let p = 0; p < count; p++) apply(`p${p}`, { type: 'SPIN' }, draft(`p${p}`).revision);
      if (pick === 10) save('spun');
      for (let p = 0; p < count; p++) apply(`p${p}`, lock(`p${p}`), draft(`p${p}`).revision);
      if (pick === 4) save('middle');
      if (pick === 9) save('late');
    }
    save('complete');
    for (let p = 0; p < count - 1; p++) apply(`p${p}`, { type: 'SUBMIT' }, draft(`p${p}`).revision);
    save('submitted');
    apply(`p${count - 1}`, { type: 'SUBMIT' }, draft(`p${count - 1}`).revision);
    save('resolved');
    console.log(`Prepared ${entry.eraId}: ${count} players, ${state.history.length} final events`);
  }
}
modules += `export const artifacts: Record<string, string> = {${bindings.join(',')}};\n`;
writeFileSync(new URL('catalogs.ts', directory), modules);
writeFileSync(new URL('results/artifact-inventory.json', import.meta.url), JSON.stringify(inventory, null, 2) + '\n');
await build({ entryPoints: [new URL('worker.ts', import.meta.url).pathname], outfile: new URL('worker.js', directory).pathname,
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers'],
  loader: { '.json': 'text' }, sourcemap: true, metafile: true,
}).then(result => writeFileSync(new URL('bundle-meta.json', directory), JSON.stringify(result.metafile, null, 2)));
console.log('Built local-only Worker bundle');
