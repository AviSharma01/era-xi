import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { request as httpRequest } from 'node:http';
import { call, control, startRuntime, origin } from './runtime.mjs';
import { legalLock } from '../stage-a/runtime.mjs';
import { enrollGuest } from './.generated/client.js';
import { DEFAULT_LIMITS } from './.generated/limits.js';

const key = () => randomBytes(32).toString('base64url');
const temp = () => mkdtempSync(join(tmpdir(), 'draft-off-stage-c-'));
const permissive = { createPerMinute: 1000, enrollmentPerMinute: 10000, requestsPerMinute: 10000,
  roomEnrollmentsPerMinute: 1000, roomEnrollmentBurst: 100, readsPerMinute: 1000, readBurst: 100,
  commandsPerMinute: 1000, commandBurst: 100 };
const create = (runtime, enrollmentKey = key(), input = {}) => call(runtime, '/rooms', { method: 'POST', key: enrollmentKey,
  body: { displayName: 'Host', eraId: 'era-foundation', ...input } });
const guest = (runtime, code, name = 'Guest', enrollmentKey = key()) => call(runtime, `/rooms/${code}/join`, { method: 'POST', key: enrollmentKey, body: { displayName: name } });
const snapshot = (runtime, room) => call(runtime, `/rooms/${room.roomCode}`, { token: room.reconnectCredential });
const command = (runtime, room, input) => call(runtime, `/rooms/${room.roomCode}/commands`, { method: 'POST', token: room.reconnectCredential, body: input });
const lifecycle = (id, revision, type) => ({ commandId: id, expectedRoomRevision: revision, command: { type } });
const draft = (id, revision, command) => ({ commandId: id, expectedDraftRevision: revision, command });
const error = (reply, status, code) => { assert.equal(reply.status, status); assert.equal(reply.body.error.code, code); };
const safe = (value, forbidden = []) => {
  const text = JSON.stringify(value);
  for (const needle of ['challengeSeed', 'draftRootSeed', 'scheduleSeed', 'serializedCompetition', 'acceptedHistory', 'canonicalSave', 'submissionHash', 'reconnectCredential', ...forbidden]) assert.ok(!text.includes(needle), `Unsafe response: ${needle}`);
};
async function raw(runtime, path, method, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(new URL(`/api/draft-off/v1${path}`, runtime.url), { method, agent: false,
      headers: { Origin: origin, 'CF-Connecting-IP': '127.0.0.1', 'Content-Type': 'application/json', ...headers } }, incoming => {
      const chunks = []; incoming.on('data', chunk => chunks.push(chunk)); incoming.on('error', reject);
      incoming.on('end', () => resolve({ status: incoming.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    outgoing.on('error', reject); outgoing.end(body);
  });
}
test('streamed payload limit, GET body, missing origin and enrollment identity spoofing', { timeout: 60000 }, async () => {
  const runtime = await startRuntime(temp(), { overrides: permissive });
  try {
    const host = (await create(runtime)).body;
    error(await raw(runtime, '/rooms', 'POST', 'x'.repeat(DEFAULT_LIMITS.bodyBytes + 1), { 'Enrollment-Key': key(), 'Transfer-Encoding': 'chunked' }), 413, 'PAYLOAD_TOO_LARGE');
    error(await raw(runtime, `/rooms/${host.roomCode}`, 'GET', '{}', { Authorization: `Bearer ${host.reconnectCredential}`, 'Content-Length': '2' }), 400, 'INVALID_REQUEST');
    const missingOrigin = await fetch(new URL('/api/draft-off/v1/rooms', runtime.url), { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json', 'Enrollment-Key': key() } });
    assert.equal(missingOrigin.status, 403);
    error(await call(runtime, `/rooms/${host.roomCode}/join`, { method: 'POST', key: key(), body: { displayName: 'Member', participantId: host.participantId } }), 400, 'INVALID_REQUEST');
    const started = await command(runtime, host, lifecycle('too-few', 0, 'START')); error(started, 409, 'PARTICIPANT_LIMIT');
  } finally { await runtime.mf.dispose(); }
});
async function begin(runtime, count = 2, input = {}) {
  const host = (await create(runtime, key(), input)).body;
  assert.equal(host.ok, true);
  const rooms = [host];
  for (let index = 1; index < count; index++) {
    const reply = await guest(runtime, host.roomCode, `Guest ${index}`); assert.equal(reply.status, 201); rooms.push(reply.body);
  }
  const view = (await snapshot(runtime, host)).body.view;
  const started = await command(runtime, host, lifecycle('start', view.revision, 'START'));
  assert.equal(started.status, 200, started.status === 200 ? undefined : JSON.stringify(await control(runtime, host.roomCode, 'failure')));
  return { rooms, started };
}

test('Stage C native HTTP, enrollment, authentication and persistence', { timeout: 240000 }, async t => {
  const statePath = temp(); let runtime = await startRuntime(statePath, { overrides: permissive });
  try {
    await t.test('pinned crypto extension compares fixed verifiers and throws for different lengths', async () => {
      const reply = await fetch(new URL('/__test/crypto', runtime.url));
      assert.deepEqual(await reply.json(), { equal: true, different: false, unequalLengthThrows: true });
    });
    await t.test('CREATE exact retry after response loss, concurrent delivery, eviction and process restart', async () => {
      const enrollmentKey = key();
      const replies = await Promise.all([create(runtime, enrollmentKey), create(runtime, enrollmentKey)]);
      assert.equal(replies[0].status, 201); assert.deepEqual(replies[1].body, replies[0].body);
      const room = replies[0].body;
      assert.equal(room.settings.draftMinutes, 15); assert.match(room.roomCode, /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{12}$/);
      const records = (await control(runtime, room.roomCode, 'inspect')).records;
      assert.ok(records['api:create'].sealed); assert.ok(!JSON.stringify(records).includes(room.reconnectCredential));
      assert.ok(!JSON.stringify(records).includes(enrollmentKey));
      await runtime.mf.unsafeEvictDurableObject('stage-c', 'StageCTestRoom', { name: room.roomCode });
      assert.deepEqual((await create(runtime, enrollmentKey)).body, room);
      await runtime.mf.dispose(); runtime = await startRuntime(statePath, { overrides: permissive });
      assert.deepEqual((await create(runtime, enrollmentKey)).body, room);
      error(await create(runtime, enrollmentKey, { displayName: 'Other' }), 409, 'ENROLLMENT_KEY_CONFLICT');
      assert.equal((await snapshot(runtime, room)).status, 200);
    });
    await t.test('JOIN recovery is exact, does not duplicate or rejoin, and reserves stored identity/name', async () => {
      const host = (await create(runtime)).body, enrollmentKey = key();
      const joined = await Promise.all([guest(runtime, host.roomCode, 'Member', enrollmentKey), guest(runtime, host.roomCode, 'Member', enrollmentKey)]);
      assert.equal(joined[0].status, 201); assert.deepEqual(joined[0].body, joined[1].body);
      const member = joined[0].body;
      assert.notEqual(host.participantId, member.participantId);
      error(await guest(runtime, host.roomCode, 'Different', enrollmentKey), 409, 'ENROLLMENT_KEY_CONFLICT');
      error(await guest(runtime, host.roomCode, 'member'), 409, 'DISPLAY_NAME_RESERVED');
      let view = (await snapshot(runtime, member)).body.view;
      assert.equal(view.participants.length, 2);
      const left = await command(runtime, member, lifecycle('leave', view.revision, 'LEAVE')); assert.equal(left.status, 200);
      assert.deepEqual((await guest(runtime, host.roomCode, 'Member', enrollmentKey)).body, member);
      view = (await snapshot(runtime, member)).body.view;
      assert.equal(view.participants.find(row => row.participantId === member.participantId).membershipStatus, 'LEFT');
      error(await guest(runtime, host.roomCode, 'Member'), 409, 'DISPLAY_NAME_RESERVED');
      const rejoined = await command(runtime, member, lifecycle('rejoin', view.revision, 'REJOIN')); assert.equal(rejoined.status, 200);
      assert.equal(rejoined.body.view.participants.find(row => row.participantId === member.participantId).membershipStatus, 'JOINED');
      view = rejoined.body.view;
      error(await command(runtime, host, lifecycle('host-leave', view.revision, 'LEAVE')), 403, 'HOST_CANNOT_LEAVE');
      error(await command(runtime, member, lifecycle('member-start', view.revision, 'START')), 403, 'FORBIDDEN');
      const started = await command(runtime, host, lifecycle('host-start', view.revision, 'START')); assert.equal(started.status, 200);
      assert.deepEqual((await guest(runtime, host.roomCode, 'Member', enrollmentKey)).body, member);
      error(await guest(runtime, host.roomCode, 'New'), 409, 'INVALID_PHASE');
      error(await command(runtime, member, lifecycle('late-leave', started.body.roomRevision, 'LEAVE')), 409, 'INVALID_PHASE');
    });
    await t.test('identity spoofing, guessed codes and wrong-room/invalid credentials grant no authority', async () => {
      const host = (await create(runtime)).body, other = (await create(runtime)).body;
      const replies = [await call(runtime, `/rooms/${host.roomCode}`), await call(runtime, `/rooms/${host.roomCode}`, { token: key() }),
        await call(runtime, `/rooms/${host.roomCode}`, { token: other.reconnectCredential }), await call(runtime, '/rooms/ZZZZZZZZZZZZ', { token: host.reconnectCredential })];
      for (const reply of replies) { error(reply, 401, 'AUTHENTICATION_FAILED'); safe(reply.body); assert.deepEqual(reply.body, replies[0].body); }
      error(await call(runtime, `/rooms/${host.roomCode}`, { token: 'bad' }), 401, 'AUTHENTICATION_FAILED');
      error(await call(runtime, `/rooms/${host.roomCode}?participantId=${host.participantId}`, { token: host.reconnectCredential }), 400, 'INVALID_REQUEST');
      for (const forbidden of [{ participantId: host.participantId }, { actor: { kind: 'SYSTEM' } }, { atMs: 1 }, { seed: 'chosen' }, { deadlineAtMs: 1 }]) {
        error(await command(runtime, host, { ...lifecycle('spoof', 0, 'START'), ...forbidden }), 400, 'INVALID_REQUEST');
        error(await call(runtime, '/rooms', { method: 'POST', key: key(), body: { displayName: 'H', eraId: 'era-impact', ...forbidden } }), 400, 'INVALID_REQUEST');
      }
      error(await command(runtime, host, lifecycle('system', 0, 'FINALIZE_ROUND')), 400, 'INVALID_REQUEST');
    });
    await t.test('strict HTTP validation, body limits, origins, preflights and cache headers', async () => {
      const host = (await create(runtime)).body;
      for (const bad of ['null', 'https://frontend.example.evil', 'https://other.example', '']) error(await call(runtime, '/rooms', { method: 'POST', key: key(), body: {}, headers: { Origin: bad } }), 403, 'ORIGIN_NOT_ALLOWED');
      for (const draftMinutes of [12, null, '15']) error(await create(runtime, key(), { draftMinutes }), 400, 'INVALID_REQUEST');
      for (const body of ['{', 'null', '[]']) error(await call(runtime, '/rooms', { method: 'POST', key: key(), body }), 400, 'INVALID_REQUEST');
      error(await call(runtime, '/rooms', { method: 'POST', key: key(), body: 'x'.repeat(4097) }), 413, 'PAYLOAD_TOO_LARGE');
      error(await call(runtime, '/rooms', { method: 'POST', key: key(), body: '{}', headers: { 'Content-Type': 'text/plain' } }), 415, 'UNSUPPORTED_MEDIA_TYPE');
      error(await call(runtime, '/rooms', { method: 'POST', key: key(), body: '{}', headers: { 'Content-Encoding': 'identity' } }), 415, 'UNSUPPORTED_MEDIA_TYPE');
      error(await call(runtime, '/rooms'), 405, 'METHOD_NOT_ALLOWED');
      error(await command(runtime, host, { ...draft('wrong-revision', 0, { type: 'SPIN' }), expectedRoomRevision: 0 }), 400, 'INVALID_REQUEST');
      error(await command(runtime, host, { ...draft('extra', 0, { type: 'SPIN', participantId: host.participantId }) }), 400, 'INVALID_REQUEST');
      error(await command(runtime, host, draft('bad-lock', 0, { type: 'LOCK_PLAYER', playerTeamSeasonId: 'x', battingPosition: 12 })), 400, 'INVALID_REQUEST');
      const preflight = await call(runtime, `/rooms/${host.roomCode}`, { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'Authorization' } });
      assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
      assert.equal(preflight.headers.get('access-control-allow-credentials'), null);
      error(await call(runtime, '/rooms', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'X-Actor' } }), 400, 'INVALID_REQUEST');
      const read = await snapshot(runtime, host); assert.equal(read.headers.get('cache-control'), 'private, no-store'); assert.equal(read.headers.get('vary'), 'Origin');
    });
    await t.test('START retries preserve server deadline, original receipt and private-revision concurrency', async () => {
      const { rooms: [host, member], started } = await begin(runtime, 2, { draftMinutes: 10 });
      const startInput = lifecycle('start', 1, 'START');
      assert.ok(started.body.view.round.deadlineAtMs - started.body.view.round.startedAtMs <= 600000);
      assert.ok(started.body.view.round.deadlineAtMs - started.body.view.round.startedAtMs > 599000);
      const initialRevision = started.body.view.myDraft.revision;
      const spin = draft('host-spin', initialRevision, { type: 'SPIN' });
      const memberSpin = draft('member-spin', initialRevision, { type: 'SPIN' });
      const [a, b] = await Promise.all([command(runtime, host, spin), command(runtime, member, memberSpin)]);
      assert.equal(a.status, 200); assert.equal(b.status, 200);
      assert.deepEqual((await command(runtime, host, startInput)).body, started.body);
      assert.deepEqual((await command(runtime, host, spin)).body, a.body);
      assert.deepEqual((await command(runtime, host, { command: spin.command, expectedDraftRevision: spin.expectedDraftRevision, commandId: spin.commandId })).body, a.body);
      error(await command(runtime, host, { ...spin, command: { type: 'RESPIN' } }), 409, 'COMMAND_ID_CONFLICT');
      error(await command(runtime, member, spin), 409, 'COMMAND_ID_CONFLICT');
      const memberRead = await snapshot(runtime, member); safe(memberRead.body, [host.reconnectCredential]);
      assert.notDeepEqual(a.body.view.myDraft, undefined);
      error(await command(runtime, host, draft('stale', initialRevision, { type: 'RESPIN' })), 409, 'STALE_DRAFT_REVISION');
      error(await command(runtime, host, draft('incomplete', a.body.view.myDraft.revision, { type: 'SUBMIT' })), 422, 'INCOMPLETE_XI');
      await runtime.mf.unsafeEvictDurableObject('stage-c', 'StageCTestRoom', { name: host.roomCode });
      assert.deepEqual((await command(runtime, host, startInput)).body, started.body);
    });
    await t.test('creation/JOIN/START companion records roll back with canonical state, receipts and alarm', async () => {
      // Discover deterministic code from a committed enrollment, then remove every record to inject a pristine create failure.
      const enrollmentKey = key(), initial = (await create(runtime, enrollmentKey)).body;
      const before = await control(runtime, initial.roomCode, 'inspect');
      for (const record of Object.keys(before.records)) await control(runtime, initial.roomCode, 'delete', { key: record });
      await runtime.mf.unsafeEvictDurableObject('stage-c', 'StageCTestRoom', { name: initial.roomCode });
      await control(runtime, initial.roomCode, 'fail');
      error(await create(runtime, enrollmentKey), 503, 'TEMPORARY_UNAVAILABLE');
      let records = (await control(runtime, initial.roomCode, 'inspect')).records;
      for (const record of ['competition', 'descriptor', 'api:create', 'api:settings']) assert.equal(records[record], undefined);
      assert.equal(Object.keys(records).filter(key => key.startsWith('api:auth:')).length, 0);
      const host = (await create(runtime, enrollmentKey)).body;
      const joinKey = key();
      await control(runtime, host.roomCode, 'fail');
      error(await guest(runtime, host.roomCode, 'Member', joinKey), 503, 'TEMPORARY_UNAVAILABLE');
      records = (await control(runtime, host.roomCode, 'inspect')).records;
      assert.equal(JSON.parse(records.competition).history.length, 0);
      assert.equal(Object.keys(records).filter(key => key.startsWith('api:auth:')).length, 1);
      const member = (await guest(runtime, host.roomCode, 'Member', joinKey)).body; assert.equal(member.ok, true);
      const view = (await snapshot(runtime, host)).body.view;
      await control(runtime, host.roomCode, 'fail');
      error(await command(runtime, host, lifecycle('atomic-start', view.revision, 'START')), 503, 'TEMPORARY_UNAVAILABLE');
      records = (await control(runtime, host.roomCode, 'inspect')).records;
      assert.equal(records['api:command:atomic-start'], undefined); assert.equal(records['receipt:atomic-start'], undefined); assert.equal(records.wake.kind, 'LOBBY_EXPIRY');
      assert.equal((await command(runtime, host, lifecycle('atomic-start', view.revision, 'START'))).status, 200);
    });
    await t.test('full digest detects forced code collisions; sealed recovery corruption fails closed', async () => {
      const enrollmentKey = key(), host = (await create(runtime, enrollmentKey)).body;
      const initial = (await control(runtime, host.roomCode, 'inspect')).records['api:create'];
      await control(runtime, host.roomCode, 'put', { key: 'api:create', value: { ...initial, enrollmentDigest: '0'.repeat(64) } });
      error(await create(runtime, enrollmentKey), 409, 'ROOM_CODE_COLLISION');
      await control(runtime, host.roomCode, 'put', { key: 'api:create', value: { ...initial, sealed: { ...initial.sealed, ciphertext: key() } } });
      error(await create(runtime, enrollmentKey), 503, 'TEMPORARY_UNAVAILABLE');
      await control(runtime, host.roomCode, 'put', { key: 'api:create', value: initial });
      assert.deepEqual((await create(runtime, enrollmentKey)).body, host);
      await control(runtime, host.roomCode, 'put', { key: 'competition', value: '{}' });
      error(await create(runtime, enrollmentKey), 503, 'TEMPORARY_UNAVAILABLE');
      error(await snapshot(runtime, host), 503, 'TEMPORARY_UNAVAILABLE');
    });
    await t.test('deadline recovery and retention remove auth/enrollment data and retain only the bounded marker', async () => {
      const { rooms: [host], started } = await begin(runtime);
      await control(runtime, host.roomCode, 'offset', { offset: started.body.view.round.deadlineAtMs - Date.now() + 20 });
      await runtime.mf.unsafeEvictDurableObject('stage-c', 'StageCTestRoom', { name: host.roomCode });
      const complete = await snapshot(runtime, host); assert.equal(complete.body.view.phase, 'COMPLETE'); assert.equal(complete.body.view.resolution.contestStatus, 'NO_CONTEST'); safe(complete.body);
      await control(runtime, host.roomCode, 'offset', { offset: complete.body.view.resolution.resolvedAtMs + 7 * 86400000 - Date.now() + 20 });
      error(await snapshot(runtime, host), 401, 'AUTHENTICATION_FAILED');
      const records = (await control(runtime, host.roomCode, 'inspect')).records;
      assert.deepEqual(Object.keys(records), ['retired']);
      const lobbyKey = key(), lobby = (await create(runtime, lobbyKey)).body;
      const wake = (await control(runtime, lobby.roomCode, 'inspect')).records.wake;
      await control(runtime, lobby.roomCode, 'offset', { offset: wake.atMs - Date.now() + 20 });
      error(await create(runtime, lobbyKey), 409, 'ROOM_CODE_UNAVAILABLE');
      assert.deepEqual(Object.keys((await control(runtime, lobby.roomCode, 'inspect')).records), ['retired']);
    });
    await t.test('eight-player HTTP smoke uses participant-safe projections and completes a legal XI/submission', async () => {
      const { rooms, started } = await begin(runtime, 8, { eraId: 'era-impact' });
      const host = rooms[0];
      const at = performance.now();
      const spins = await Promise.all(rooms.map((room, i) => command(runtime, room, draft(`burst-spin-${i}`, started.body.view.myDraft.revision, { type: 'SPIN' }))));
      const burstMs = performance.now() - at;
      for (const spin of spins) { assert.equal(spin.status, 200); safe(spin.body); }
      let view = spins[0].body.view;
      for (let pick = 0; pick < 11; pick++) {
        const locked = await command(runtime, host, draft(`lock-${pick}`, view.myDraft.revision, legalLock(view))); assert.equal(locked.status, 200); view = locked.body.view;
        if (pick < 10) { const spun = await command(runtime, host, draft(`spin-${pick}`, view.myDraft.revision, { type: 'SPIN' })); assert.equal(spun.status, 200); view = spun.body.view; }
      }
      assert.equal(view.myDraft.phase, 'XI_COMPLETE');
      const submitted = await command(runtime, host, draft('submit', view.myDraft.revision, { type: 'SUBMIT' })); assert.equal(submitted.status, 200); safe(submitted.body);
      const memberRead = await snapshot(runtime, rooms[1]); assert.equal(memberRead.body.view.myDraft.picks.length, 0);
      assert.ok(memberRead.body.view.participants.every(row => !('picks' in row))); assert.equal(memberRead.body.view.myDraft.picks.length, 0);
      await control(runtime, host.roomCode, 'offset', { offset: started.body.view.round.deadlineAtMs - Date.now() + 20 });
      const resolved = await snapshot(runtime, host); assert.equal(resolved.body.view.resolution.contestStatus, 'UNCONTESTED'); safe(resolved.body);
      mkdirSync(new URL('results/', import.meta.url), { recursive: true });
      writeFileSync(new URL('results/http-smoke.json', import.meta.url), JSON.stringify({ era: 'era-impact', participants: 8, spinBurstMs: burstMs,
        completedLegalXi: true, submission: true, deadlineRecovery: true, privacyChecks: true }, null, 2) + '\n');
    });
  } finally { await runtime.mf.dispose(); }
});

test('JOIN response-loss recovery survives cold restart, and failures remain exact receipts', { timeout: 60000 }, async () => {
  const statePath = temp(); let runtime = await startRuntime(statePath, { overrides: permissive });
  try {
    const host = (await create(runtime)).body, enrollmentKey = key();
    const member = (await guest(runtime, host.roomCode, 'Member', enrollmentKey)).body;
    const rejectedKey = key(), rejected = await guest(runtime, host.roomCode, 'Member', rejectedKey);
    error(rejected, 409, 'DISPLAY_NAME_RESERVED'); assert.equal(rejected.body.view, undefined);
    await runtime.mf.dispose(); runtime = await startRuntime(statePath, { overrides: permissive });
    assert.deepEqual((await guest(runtime, host.roomCode, 'Member', enrollmentKey)).body, member);
    assert.deepEqual((await guest(runtime, host.roomCode, 'Member', rejectedKey)).body, rejected.body);
    assert.equal((await snapshot(runtime, member)).status, 200);
    const records = (await control(runtime, host.roomCode, 'inspect')).records;
    assert.equal(Object.keys(records).filter(name => name.startsWith('api:auth:')).length, 2);
  } finally { await runtime.mf.dispose(); }
});

test('production-safe logs exclude secrets, names, seeds and canonical/private state', { timeout: 60000 }, async () => {
  const runtime = await startRuntime(temp(), { overrides: permissive });
  try {
    const enrollmentKey = key(), name = 'SECRET_DISPLAY_SENTINEL', host = (await create(runtime, enrollmentKey, { displayName: name })).body;
    assert.equal((await snapshot(runtime, host)).status, 200);
    const secretSeed = JSON.parse((await control(runtime, host.roomCode, 'inspect')).records.competition).genesis.initialRound.challengeSeed;
    error(await command(runtime, host, { ...lifecycle('unsafe', 0, 'START'), seed: secretSeed }), 400, 'INVALID_REQUEST');
    error(await snapshot(runtime, { ...host, reconnectCredential: key() }), 401, 'AUTHENTICATION_FAILED');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.ok(runtime.logs.length >= 4);
    const output = JSON.stringify(runtime.logs);
    for (const forbidden of [enrollmentKey, host.reconnectCredential, name, secretSeed, host.participantId, host.roomCode,
      'canonicalSave', 'serializedCompetition', 'reconnectCredential', 'Enrollment-Key', 'Authorization']) assert.ok(!output.includes(forbidden));
    for (const entry of runtime.logs) {
      const data = JSON.parse(entry.message);
      for (const field of Object.keys(data)) assert.ok(['requestId', 'route', 'status', 'code', 'elapsedMs'].includes(field));
    }
  } finally { await runtime.mf.dispose(); }
});

test('room bucket refill, pending-operation bounds and independent participant limits', { timeout: 60000 }, async () => {
  const runtime = await startRuntime(temp(), { overrides: { ...permissive, readBurst: 1, readsPerMinute: 1,
    roomEnrollmentBurst: 1, roomEnrollmentsPerMinute: 1, outstandingOperations: 1 } });
  try {
    const host = (await create(runtime)).body;
    const first = await snapshot(runtime, host); assert.equal(first.status, 200);
    error(await snapshot(runtime, host), 429, 'RATE_LIMITED');
    await runtime.mf.unsafeEvictDurableObject('stage-c', 'StageCTestRoom', { name: host.roomCode });
    error(await snapshot(runtime, host), 429, 'RATE_LIMITED');
    const member = (await guest(runtime, host.roomCode, 'Member')).body; assert.equal(member.ok, true);
    error(await guest(runtime, host.roomCode, 'Another'), 429, 'RATE_LIMITED');
    assert.equal((await snapshot(runtime, member)).status, 200);
    await control(runtime, host.roomCode, 'offset', { offset: 61000 });
    assert.equal((await snapshot(runtime, host)).status, 200);
    assert.equal((await guest(runtime, host.roomCode, 'Another')).status, 201);
    await control(runtime, host.roomCode, 'offset', { offset: 122000 });
    const burst = await Promise.all(Array.from({ length: 8 }, () => snapshot(runtime, host)));
    assert.ok(burst.some(reply => reply.status === 200));
    assert.ok(burst.some(reply => reply.status === 429));
    const rateFailure = burst.find(reply => reply.status === 429); assert.equal(rateFailure.headers.get('retry-after'), '60');
  } finally { await runtime.mf.dispose(); }
});

test('native edge limiter and invalid/missing configuration fail before room allocation', { timeout: 60000 }, async () => {
  const runtime = await startRuntime(temp(), { overrides: { ...permissive, createPerMinute: 1 } });
  try {
    assert.equal((await create(runtime)).status, 201);
    let throttled = false;
    for (let index = 0; index < 8; index++) if ((await create(runtime)).status === 429) { throttled = true; break; }
    assert.ok(throttled);
  } finally { await runtime.mf.dispose(); }
  const invalid = await startRuntime(temp(), { overrides: { unexpectedLimit: 1 } });
  try { error(await create(invalid), 503, 'SERVICE_UNAVAILABLE'); }
  finally { await invalid.mf.dispose(); }
  for (const options of [{ bindings: { ALLOWED_ORIGINS: '' } }, { edgeBindings: false }]) {
    const missing = await startRuntime(temp(), options);
    try { error(await create(missing), 503, 'SERVICE_UNAVAILABLE'); } finally { await missing.mf.dispose(); }
  }
});

test('real CREATE/JOIN response loss recovers through the pending-key client helper', { timeout: 60000 }, async () => {
  const runtime = await startRuntime(temp(), { overrides: permissive });
  try {
    const map = new Map(), storage = { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) };
    const transport = (url, request) => fetch(url, { ...request, headers: { ...request.headers, Origin: origin, 'CF-Connecting-IP': '127.0.0.1' } });
    let lost;
    const loseResponse = async (url, request) => { const response = await transport(url, request); lost = await response.json(); assert.equal(response.status, 201); throw new Error('Lost response after server commit'); };
    const createInput = { displayName: 'Host', eraId: 'era-foundation' };
    await assert.rejects(enrollGuest(runtime.url, 'CREATE', undefined, createInput, storage, loseResponse));
    const host = await enrollGuest(runtime.url, 'CREATE', undefined, createInput, storage, transport); assert.equal(host.status, 201); assert.deepEqual(host.body, lost);
    assert.equal(map.has('draft-off:pending:CREATE:'), false);
    const joinInput = { displayName: 'Member' };
    await assert.rejects(enrollGuest(runtime.url, 'JOIN', host.body.roomCode, joinInput, storage, loseResponse));
    const member = await enrollGuest(runtime.url, 'JOIN', host.body.roomCode, joinInput, storage, transport); assert.equal(member.status, 201); assert.deepEqual(member.body, lost);
    assert.equal((await snapshot(runtime, member.body)).body.view.participants.length, 2);
    assert.equal(map.has(`draft-off:pending:JOIN:${host.body.roomCode}`), false);
  } finally { await runtime.mf.dispose(); }
});

test('all era catalogs start with generated IDs and default controls allow an eight-player opening', { timeout: 60000 }, async () => {
  const runtime = await startRuntime(temp());
  try {
    for (const eraId of ['era-foundation', 'era-expansion', 'era-transition', 'era-modern-pre-impact', 'era-impact']) {
      const { rooms, started } = await begin(runtime, eraId === 'era-impact' ? 8 : 2, { eraId });
      for (const room of rooms) assert.match(room.participantId, /^p_[0-9a-f]{32}$/);
      const replies = await Promise.all(rooms.map((room, index) => command(runtime, room,
        draft(`opening-${index}`, started.body.view.myDraft.revision, { type: 'SPIN' }))));
      for (const reply of replies) { assert.equal(reply.status, 200); safe(reply.body); }
    }
  } finally { await runtime.mf.dispose(); }
});

test('successful retries survive eviction and positive record ceilings', { timeout: 60000 }, async () => {
  const runtime = await startRuntime(temp(), { overrides: { ...permissive, commandBurst: 2, commandsPerMinute: 1, participantCommandIds: 1, enrollmentRecords: 2 } });
  try {
    const host = (await create(runtime)).body, joinKey = key();
    const member = (await guest(runtime, host.roomCode, 'Member', joinKey)).body;
    error(await guest(runtime, host.roomCode, 'Third'), 429, 'RATE_LIMITED');
    assert.deepEqual((await guest(runtime, host.roomCode, 'Member', joinKey)).body, member);
    const input = lifecycle('leave', 1, 'LEAVE'); const left = await command(runtime, member, input); assert.equal(left.status, 200);
    await runtime.mf.unsafeEvictDurableObject('stage-c', 'StageCTestRoom', { name: host.roomCode });
    assert.deepEqual((await command(runtime, member, input)).body, left.body);
    const records = (await control(runtime, host.roomCode, 'inspect')).records;
    assert.equal(records['api:enrollment-count'], 2);
    assert.equal(records[`api:command-count:${member.participantId}`], 1);
  } finally { await runtime.mf.dispose(); }
});

test('rejected command records stay bounded and cannot consume successful progress across eviction/restart', { timeout: 180000 }, async () => {
  const statePath = temp(), overrides = { ...permissive, commandBurst: 2, commandsPerMinute: 60,
    negativeResultRecords: 3, participantCommandIds: 25, enrollmentRecords: 2 };
  let runtime = await startRuntime(statePath, { overrides }), offset = 0;
  const refill = async () => { offset += 2100; await control(runtime, host.roomCode, 'offset', { offset }); };
  const records = async () => (await control(runtime, host.roomCode, 'inspect')).records;
  const restart = async () => { await runtime.mf.dispose(); runtime = await startRuntime(statePath, { overrides }); };
  let host;
  try {
    const hostKey = key(), memberKey = key();
    host = (await create(runtime, hostKey)).body;
    const member = (await guest(runtime, host.roomCode, 'Member', memberKey)).body;
    const left = await command(runtime, member, lifecycle('leave', 1, 'LEAVE')); assert.equal(left.status, 200);
    for (let index = 0; index < 8; index++) {
      await refill();
      error(await command(runtime, host, lifecycle(`rejected-start-${index}`, 999, 'START')), 409, 'STALE_ROOM_REVISION');
      error(await command(runtime, member, lifecycle(`rejected-rejoin-${index}`, 999, 'REJOIN')), 409, 'STALE_ROOM_REVISION');
      assert.ok((await records())['api:negative-results'].length <= 3);
    }
    assert.equal((await records())[`api:command-count:${host.participantId}`], undefined);
    assert.equal((await records())[`api:command-count:${member.participantId}`], 1);
    // A failed commit must restore the eviction victim as well as the new receipt/mapping.
    const retained = value => Object.fromEntries(Object.entries(value).filter(([name]) => !name.startsWith('api:bucket:') && !name.startsWith('test:')));
    const before = retained(await records());
    await refill(); await control(runtime, host.roomCode, 'fail');
    error(await command(runtime, host, lifecycle('negative-rollback', 999, 'START')), 503, 'TEMPORARY_UNAVAILABLE');
    assert.deepEqual(retained(await records()), before);
    await runtime.mf.unsafeEvictDurableObject('stage-c', 'StageCTestRoom', { name: host.roomCode });
    await refill();
    const rejoined = await command(runtime, member, lifecycle('rejoin', 2, 'REJOIN')); assert.equal(rejoined.status, 200);
    await restart(); await refill();
    // This ID's rejection was evicted. Re-evaluation may now succeed; no positive receipt is evicted.
    const startInput = lifecycle('rejected-start-0', rejoined.body.roomRevision, 'START');
    const started = await command(runtime, host, startInput); assert.equal(started.status, 200);
    let view = started.body.view;
    for (let index = 0; index < 6; index++) {
      await refill();
      error(await command(runtime, host, draft(`stale-spin-${index}`, 999, { type: 'SPIN' })), 409, 'STALE_DRAFT_REVISION');
      error(await command(runtime, host, draft(`stale-respin-${index}`, 999, { type: 'RESPIN' })), 409, 'STALE_DRAFT_REVISION');
      error(await command(runtime, host, draft(`throttled-${index}`, 999, { type: 'SPIN' })), 429, 'RATE_LIMITED');
      if (index === 2) await runtime.mf.unsafeEvictDurableObject('stage-c', 'StageCTestRoom', { name: host.roomCode });
      if (index === 4) await restart();
    }
    assert.equal((await records())[`api:command-count:${host.participantId}`], 1);
    await refill();
    const spinInput = draft('first-spin', view.myDraft.revision, { type: 'SPIN' });
    const spun = await command(runtime, host, spinInput); assert.equal(spun.status, 200); view = spun.body.view;
    const respun = await command(runtime, host, draft('respin', view.myDraft.revision, { type: 'RESPIN' })); assert.equal(respun.status, 200); view = respun.body.view;
    for (let pick = 0; pick < 11; pick++) {
      await refill();
      const locked = await command(runtime, host, draft(`lock-${pick}`, view.myDraft.revision, legalLock(view)));
      assert.equal(locked.status, 200); view = locked.body.view;
      if (pick < 10) {
        const next = await command(runtime, host, draft(`spin-${pick}`, view.myDraft.revision, { type: 'SPIN' }));
        assert.equal(next.status, 200); view = next.body.view;
      }
    }
    assert.equal(view.myDraft.phase, 'XI_COMPLETE');
    for (let index = 0; index < 6; index++) {
      await refill();
      error(await command(runtime, host, draft(`stale-submit-${index}`, 999, { type: 'SUBMIT' })), 409, 'STALE_DRAFT_REVISION');
    }
    await restart(); await refill();
    const submitInput = draft('submit', view.myDraft.revision, { type: 'SUBMIT' });
    const submitted = await command(runtime, host, submitInput); assert.equal(submitted.status, 200);
    const durable = await records();
    assert.equal(durable[`api:command-count:${host.participantId}`], 25);
    assert.equal(durable['api:enrollment-count'], 2);
    assert.equal(durable['api:negative-results'].length, 3);
    assert.equal(Object.keys(durable).filter(name => name.startsWith('api:command:')).length, 25 + 2 + 3);
    assert.equal(Object.keys(durable).filter(name => name.startsWith('receipt:')).length, 25 + 2 + 3 + 1);
    assert.equal(durable['api:command:rejected-start-7'], undefined);
    await restart(); await refill();
    assert.deepEqual((await command(runtime, host, startInput)).body, started.body);
    assert.deepEqual((await command(runtime, host, submitInput)).body, submitted.body);
    await refill(); assert.deepEqual((await command(runtime, host, spinInput)).body, spun.body);
    assert.deepEqual((await create(runtime, hostKey)).body, host);
    assert.deepEqual((await guest(runtime, host.roomCode, 'Member', memberKey)).body, member);
    assert.deepEqual(retained(await records()), retained(durable));
  } finally { await runtime.mf.dispose(); }
});

test('rejected JOINs use a bounded shared cache and leave available enrollment capacity after refill/restart', { timeout: 60000 }, async () => {
  const statePath = temp(), overrides = { ...permissive, roomEnrollmentBurst: 2, roomEnrollmentsPerMinute: 60,
    enrollmentRecords: 2, negativeResultRecords: 3 };
  let runtime = await startRuntime(statePath, { overrides }), offset = 0;
  try {
    const hostKey = key(), host = (await create(runtime, hostKey)).body;
    let firstKey, recentKey, recentFailure;
    for (let batch = 0; batch < 6; batch++) {
      offset += 2100; await control(runtime, host.roomCode, 'offset', { offset });
      for (let index = 0; index < 2; index++) {
        recentKey = key(); firstKey ??= recentKey;
        recentFailure = await guest(runtime, host.roomCode, 'Host', recentKey); error(recentFailure, 409, 'DISPLAY_NAME_RESERVED');
      }
      error(await guest(runtime, host.roomCode, 'Member'), 429, 'RATE_LIMITED');
      const { records } = await control(runtime, host.roomCode, 'inspect');
      assert.equal(records['api:enrollment-count'], 1);
      assert.equal(records['api:negative-results'].length, Math.min(3, (batch + 1) * 2));
      assert.ok(Object.keys(records).filter(name => name.startsWith('api:enrollment:')).length <= 3);
      assert.ok(Object.keys(records).filter(name => name.startsWith('receipt:')).length <= 3);
      assert.equal(Object.keys(records).filter(name => name.startsWith('api:auth:')).length, 1);
      if (batch === 1) await runtime.mf.unsafeEvictDurableObject('stage-c', 'StageCTestRoom', { name: host.roomCode });
      if (batch === 3) { await runtime.mf.dispose(); runtime = await startRuntime(statePath, { overrides }); }
    }
    assert.deepEqual((await guest(runtime, host.roomCode, 'Host', recentKey)).body, recentFailure.body);
    // Command and enrollment negatives share one ceiling, not independent unbounded stores.
    error(await command(runtime, host, lifecycle('mixed-negative', 999, 'START')), 409, 'STALE_ROOM_REVISION');
    const mixed = (await control(runtime, host.roomCode, 'inspect')).records;
    assert.equal(mixed['api:negative-results'].length, 3);
    assert.equal(Object.keys(mixed).filter(name => name.startsWith('api:enrollment:')).length, 2);
    assert.equal(Object.keys(mixed).filter(name => name.startsWith('api:command:')).length, 1);
    assert.equal(Object.keys(mixed).filter(name => name.startsWith('receipt:')).length, 3);
    offset += 2100; await control(runtime, host.roomCode, 'offset', { offset });
    // An evicted failed key had no committed identity. It may now enroll successfully with new input.
    const member = (await guest(runtime, host.roomCode, 'Member', firstKey)).body; assert.equal(member.ok, true);
    const { records } = await control(runtime, host.roomCode, 'inspect');
    assert.equal(records['api:enrollment-count'], 2);
    assert.equal(records['api:negative-results'].length, 3);
    assert.equal(Object.keys(records).filter(name => name.startsWith('api:enrollment:')).length, 3);
    assert.equal(Object.keys(records).filter(name => name.startsWith('receipt:')).length, 4);
    assert.equal(Object.keys(records).filter(name => name.startsWith('api:auth:')).length, 2);
    await runtime.mf.dispose(); runtime = await startRuntime(statePath, { overrides });
    assert.deepEqual((await create(runtime, hostKey)).body, host);
    assert.deepEqual((await guest(runtime, host.roomCode, 'Member', firstKey)).body, member);
    error(await guest(runtime, host.roomCode, 'Different', firstKey), 409, 'ENROLLMENT_KEY_CONFLICT');
    error(await guest(runtime, host.roomCode, 'Third'), 429, 'RATE_LIMITED');
    assert.equal((await snapshot(runtime, member)).body.view.participants.length, 2);
  } finally { await runtime.mf.dispose(); }
});

test('legacy Stage B trusted rooms cannot acquire or use public Stage C authentication', { timeout: 60000 }, async () => {
  const statePath = temp(); let runtime = await startRuntime(statePath, { overrides: permissive });
  try {
    const enrollmentKey = key(), hash = createHash('sha256').update(JSON.stringify(['draft-off-enrollment-v1', 'CREATE', '', enrollmentKey])).digest('hex');
    let bits = BigInt(`0x${hash.slice(0, 15)}`), code = '';
    for (let index = 0; index < 12; index++) { code = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'[Number(bits & 31n)] + code; bits >>= 5n; }
    await control(runtime, code, 'legacy-create', { roomCode: code });
    const before = (await control(runtime, code, 'inspect')).records;
    const verify = async () => {
      error(await create(runtime, enrollmentKey), 409, 'ROOM_CODE_UNAVAILABLE');
      error(await guest(runtime, code, 'Member'), 503, 'TEMPORARY_UNAVAILABLE');
      for (const token of ['p0', key()]) {
        error(await call(runtime, `/rooms/${code}`, { token }), 401, 'AUTHENTICATION_FAILED');
        error(await command(runtime, { roomCode: code, reconnectCredential: token }, lifecycle('legacy-start', 0, 'START')), 401, 'AUTHENTICATION_FAILED');
      }
      const { records } = await control(runtime, code, 'inspect');
      assert.equal(records.competition, before.competition); assert.deepEqual(records.wake, before.wake);
      for (const name of Object.keys(records)) assert.ok(!name.startsWith('api:auth:') && !name.startsWith('api:enrollment:') && !name.startsWith('receipt:'));
      assert.equal(records['api:create'], undefined); assert.equal(records['api:settings'], undefined);
    };
    await verify();
    await runtime.mf.unsafeEvictDurableObject('stage-c', 'StageCTestRoom', { name: code }); await verify();
    await runtime.mf.dispose(); runtime = await startRuntime(statePath, { overrides: permissive }); await verify();
  } finally { await runtime.mf.dispose(); }
});

test('pending enrollment client retains uncertain key and deletes it only after verified credential storage', async () => {
  const map = new Map(); const storage = { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) };
  const input = { displayName: 'Host', eraId: 'era-foundation' }; let sent;
  await assert.rejects(enrollGuest('https://api.example', 'CREATE', undefined, input, storage, async (_url, request) => { sent = request.headers['Enrollment-Key']; throw new Error('Response lost'); }));
  assert.equal(JSON.parse(map.get('draft-off:pending:CREATE:')).key, sent);
  const success = async (_url, request) => { assert.equal(request.headers['Enrollment-Key'], sent); return Response.json({ ok: true, roomCode: '0123456789AB', participantId: 'p', reconnectCredential: key() }, { status: 201 }); };
  const broken = { ...storage, setItem: (slot, value) => { if (slot.startsWith('draft-off:credential:')) throw new Error('Storage unavailable'); storage.setItem(slot, value); } };
  await assert.rejects(enrollGuest('https://api.example', 'CREATE', undefined, input, broken, success)); assert.ok(map.has('draft-off:pending:CREATE:'));
  await enrollGuest('https://api.example', 'CREATE', undefined, input, storage, success);
  assert.equal(map.has('draft-off:pending:CREATE:'), false); assert.ok(map.has('draft-off:credential:0123456789AB'));
  await enrollGuest('https://api.example', 'CREATE', undefined, input, storage, async () => Response.json({ ok: false, error: { code: 'ROOM_CODE_COLLISION' } }, { status: 409 }));
  assert.notEqual(JSON.parse(map.get('draft-off:pending:CREATE:')).key, sent);
});

test('production bundle serves product HTTP and has no fixture/debug routes', { timeout: 60000 }, async () => {
  const runtime = await startRuntime(temp(), { production: true });
  try {
    const created = await create(runtime); assert.equal(created.status, 201);
    const read = await snapshot(runtime, created.body); assert.equal(read.status, 200); safe(read.body);
    assert.equal((await fetch(new URL('/__test/crypto', runtime.url))).status, 404);
    const bundle = readFileSync(new URL('.generated/worker.js', import.meta.url), 'utf8');
    for (const needle of ['StageCTestRoom', 'STAGE_C_ONLY', 'test:offset', 'Injected commit failure', '/__test/', 'legacy-create']) assert.ok(!bundle.includes(needle));
    assert.equal(DEFAULT_LIMITS.bodyBytes, 4096);
  } finally { await runtime.mf.dispose(); }
});
