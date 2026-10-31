import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { call, control, startRuntime } from './stage-d/runtime.mjs';
import { loadEraDraftCatalog } from '../dist/eraDraftData.js';
import { replayDraftOffCompetition, restoreDraftOffCompetition, serializeDraftOffCompetition } from '../dist/draftOffCompetitionPersistence.js';
import { deriveDraftOffParticipantSeed } from '../dist/draftOffFormat.js';
import { projectDraftOffRoom } from '../dist/draftOffRoomProjection.js';
const secret = () => randomBytes(32).toString('base64url');
const catalog = loadEraDraftCatalog();
const overrides = { requestsPerMinute: 10000, enrollmentPerMinute: 10000, readsPerMinute: 1000, readBurst: 100,
  commandsPerMinute: 1000, commandBurst: 100, roomEnrollmentsPerMinute: 1000, roomEnrollmentBurst: 100 };

test('format contracts: default Varied, explicit Mirror, invite privacy, stable retries and native restart', { timeout: 120000 }, async () => {
  process.chdir(fileURLToPath(new URL('stage-d/', import.meta.url)));
  const path = mkdtempSync(join(tmpdir(), 'draft-off-formats-'));
  let runtime = await startRuntime(path, { overrides });
  const read = room => call(runtime, `/rooms/${room.roomCode}`, { token: room.reconnectCredential });
  const command = (room, input) => call(runtime, `/rooms/${room.roomCode}/commands`, { method: 'POST', token: room.reconnectCredential, body: input });
  try {
    for (const requested of [undefined, 'MIRROR']) {
      const format = requested ?? 'VARIED', key = secret();
      const input = { displayName: 'Host', eraId: 'era-transition', ...(requested ? { format: requested } : {}) };
      const created = await call(runtime, '/rooms', { method: 'POST', key, body: input }); assert.equal(created.status, 201);
      const host = created.body, code = host.roomCode;
      assert.equal(host.settings.format, format); assert.equal(host.view.round.format, format);
      assert.deepEqual((await call(runtime, '/rooms', { method: 'POST', key, body: input })).body, host);
      const invite = await call(runtime, `/rooms/${code}/invite`);
      assert.equal(invite.status, 200); assert.equal(invite.headers.get('cache-control'), 'private, no-store');
      assert.deepEqual(invite.body, { ok: true, version: 2, roomCode: code, eraId: input.eraId, draftMinutes: 15, format });
      for (const [suffix, options, status] of [
        ['/invite?format=MIRROR', {}, 400], ['/invite', { token: host.reconnectCredential }, 400],
        ['/invite', { key }, 400], ['/invite', { method: 'POST' }, 405],
        ['/invite', { headers: { 'Content-Encoding': 'gzip' } }, 400],
      ]) assert.equal((await call(runtime, `/rooms/${code}${suffix}`, options)).status, status);
      assert.equal((await call(runtime, `/rooms/${code}/join`, { method: 'POST', key: secret(), body: { displayName: 'Guest', format: 'MIRROR' } })).status, 400);
      const guestReply = await call(runtime, `/rooms/${code}/join`, { method: 'POST', key: secret(), body: { displayName: 'Guest' } });
      assert.equal(guestReply.status, 201); const guest = guestReply.body;
      assert.equal(guest.settings.format, format);
      const lobby = (await read(host)).body;
      assert.equal((await command(guest, { commandId: 'guest-start', expectedRoomRevision: lobby.view.revision, command: { type: 'START' } })).status, 403);
      assert.equal((await command(host, { commandId: 'edit-format', expectedRoomRevision: lobby.view.revision, command: { type: 'START', format: 'MIRROR' } })).status, 400);
      assert.equal((await command(host, { commandId: 'start', expectedRoomRevision: lobby.view.revision, command: { type: 'START' } })).status, 200);
      for (const room of [host, guest]) {
        let snapshot = (await read(room)).body;
        const envelope = { commandId: `spin-${room.participantId}`, expectedDraftRevision: snapshot.view.myDraft.revision, command: { type: 'SPIN' } };
        const spun = await command(room, envelope); assert.equal(spun.status, 200);
        assert.deepEqual((await command(room, envelope)).body, spun.body);
        const respin = { commandId: `respin-${room.participantId}`, expectedDraftRevision: spun.body.view.myDraft.revision, command: { type: 'RESPIN' } };
        assert.equal((await command(room, respin)).status, 200);
        snapshot = (await read(room)).body;
        assert.equal(snapshot.view.round.format, format);
        const bytes = JSON.stringify(snapshot);
        for (const privateKey of ['rootSeed', 'challengeSeed', 'scheduleSeed', 'history', 'rngCounters']) assert.ok(!bytes.includes(privateKey));
      }
      const stored = (await control(runtime, code, 'inspect')).records.competition;
      const state = restoreDraftOffCompetition(catalog, stored), round = state.rounds[0];
      assert.equal(state.genesis.format, format);
      const roots = round.participants.map(p => p.draftState.rootSeed);
      assert.equal(new Set(roots).size, format === 'VARIED' ? 2 : 1);
      for (const p of round.participants) {
        assert.equal(p.draftState.rootSeed, deriveDraftOffParticipantSeed(round.seeds.draftRootSeed, p.participantId, format));
        assert.deepEqual(p.draftState.rngCounters, { normalSpin: 1, voluntaryRespin: 1, deadSpinRecovery: 0 });
      }
      const before = (await read(host)).body;
      await runtime.mf.dispose(); runtime = await startRuntime(path, { overrides });
      const after = (await read(host)).body;
      assert.deepEqual(after.view, before.view); assert.deepEqual(after.settings, before.settings);
      assert.equal((await control(runtime, code, 'inspect')).records.competition, stored);
      assert.deepEqual((await call(runtime, '/rooms', { method: 'POST', key, body: input })).body, host);
    }

    for (const format of ['BALANCED', null, 1]) assert.equal((await call(runtime, '/rooms', {
      method: 'POST', key: secret(), body: { displayName: 'Invalid', eraId: 'era-foundation', format },
    })).status, 400);
    assert.equal((await call(runtime, '/rooms/000000000000/invite')).status, 404);
    assert.deepEqual((await control(runtime, '000000000000', 'inspect')).records, {});
  } finally { await runtime.mf.dispose(); rmSync(path, { recursive: true, force: true }); }
});

for (const legacyVersion of [1, 2, 3]) test(`persisted v${legacyVersion} lobby and lost CREATE reply retain historical policy without rewriting canonical bytes`, { timeout: 90000 }, async () => {
  process.chdir(fileURLToPath(new URL('stage-d/', import.meta.url)));
  const path = mkdtempSync(join(tmpdir(), 'draft-off-format-legacy-'));
  let runtime = await startRuntime(path, { overrides });
  try {
    const key = secret(), input = { displayName: 'Legacy host', eraId: 'era-foundation' };
    const host = (await call(runtime, '/rooms', { method: 'POST', key, body: input })).body;
    const code = host.roomCode, records = (await control(runtime, code, 'inspect')).records;
    // Reconstruct the authentic legacy contract using the preserved v1 constructor/replay path.
    const current = restoreDraftOffCompetition(catalog, records.competition);
    const { format: _format, tierCaps: _caps, teamEvaluationVersion: _evaluation, ...baseGenesis } = current.genesis;
    const genesis = { ...baseGenesis, ...(legacyVersion >= 2 ? { format: 'VARIED' } : {}),
      ...(legacyVersion === 3 ? { tierCaps: _caps } : {}) };
    const legacySettings = { draftMinutes: 15, ...(legacyVersion >= 2 ? { format: 'VARIED' } : {}) };
    const legacy = replayDraftOffCompetition({ catalog, genesis, history: current.history });
    const serialized = serializeDraftOffCompetition(legacy);
    await control(runtime, code, 'put', { key: 'competition', value: serialized });
    await control(runtime, code, 'put', { key: 'api:settings', value: legacySettings });
    const enrollment = records['api:create'];
    enrollment.reply.body.settings = legacySettings;
    enrollment.reply.body.view = projectDraftOffRoom(catalog, legacy, host.participantId);
    await control(runtime, code, 'put', { key: 'api:create', value: enrollment });
    await runtime.mf.dispose(); runtime = await startRuntime(path, { overrides });
    const recovered = await call(runtime, '/rooms', { method: 'POST', key, body: input });
    assert.equal(recovered.status, 201); assert.equal(recovered.body.reconnectCredential, host.reconnectCredential);
    assert.deepEqual(recovered.body.settings, legacySettings);
    assert.equal(Object.hasOwn(recovered.body.view.round, 'format'), legacyVersion >= 2);
    assert.equal((await call(runtime, `/rooms/${code}/invite`)).body.format, legacyVersion === 1 ? 'MIRROR' : 'VARIED');
    assert.equal(Object.hasOwn(recovered.body.view.round, 'tierCaps'), legacyVersion === 3);
    assert.equal(Object.hasOwn(recovered.body.view.round, 'teamEvaluationVersion'), false);
    assert.equal((await control(runtime, code, 'inspect')).records.competition, serialized);
    await call(runtime, `/rooms/${code}/join`, { method: 'POST', key: secret(), body: { displayName: 'Legacy guest' } });
    const read = await call(runtime, `/rooms/${code}`, { token: host.reconnectCredential });
    const started = await call(runtime, `/rooms/${code}/commands`, { method: 'POST', token: host.reconnectCredential,
      body: { commandId: 'start', expectedRoomRevision: read.body.view.revision, command: { type: 'START' } } });
    assert.equal(started.status, 200); assert.equal(Object.hasOwn(started.body.view.round, 'format'), legacyVersion >= 2);
    const restored = restoreDraftOffCompetition(catalog, (await control(runtime, code, 'inspect')).records.competition);
    assert.equal(restored.engineVersion, `ipl-draft-off-competition-engine/v${legacyVersion}`);
    assert.ok(restored.rounds[0].participants.every(p => p.draftState.teamEvaluationVersion === undefined));
    assert.equal(new Set(restored.rounds[0].participants.map(p => p.draftState.rootSeed)).size, legacyVersion === 1 ? 1 : 2);
  } finally { await runtime.mf.dispose(); rmSync(path, { recursive: true, force: true }); }
});

test('invite quota survives restart, rejects before replay and leaves authenticated reads available', { timeout: 90000 }, async () => {
  process.chdir(fileURLToPath(new URL('stage-d/', import.meta.url)));
  const path = mkdtempSync(join(tmpdir(), 'draft-off-invite-limits-'));
  const policy = { ...overrides, roomEnrollmentsPerMinute: 1, roomEnrollmentBurst: 1 };
  let runtime = await startRuntime(path, { overrides: policy });
  try {
    const host = (await call(runtime, '/rooms', { method: 'POST', key: secret(), body: { displayName: 'Host', eraId: 'era-foundation' } })).body;
    const code = host.roomCode;
    assert.equal((await call(runtime, `/rooms/${code}/invite`, { headers: { Origin: 'https://unapproved.example' } })).status, 403);
    assert.equal((await call(runtime, `/rooms/${code}/invite`)).status, 200);
    const canonical = (await control(runtime, code, 'inspect')).records.competition;
    await runtime.mf.dispose(); runtime = await startRuntime(path, { overrides: policy });
    const before = await control(runtime, code, 'recovery-count');
    const throttled = await call(runtime, `/rooms/${code}/invite`);
    assert.equal(throttled.status, 429); assert.equal(throttled.headers.get('retry-after'), '60');
    assert.equal(await control(runtime, code, 'recovery-count'), before);
    assert.equal((await call(runtime, `/rooms/${code}`, { token: host.reconnectCredential })).status, 200);
    assert.equal((await control(runtime, code, 'inspect')).records.competition, canonical);
    await control(runtime, code, 'offset', { offset: 61000 });
    assert.equal((await call(runtime, `/rooms/${code}/invite`)).status, 200);
  } finally { await runtime.mf.dispose(); rmSync(path, { recursive: true, force: true }); }
});
