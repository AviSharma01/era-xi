import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import WebSocket from '../stage-a/node_modules/ws/wrapper.mjs';
import { call, control, origin, startRuntime } from '../stage-d/runtime.mjs';
import { parseRoomSnapshot } from '../stage-d/.generated/client.js';
import { recordLatency } from './latency.mjs';

// Reuse the unmodified Stage D runtime and isolated controls. All gameplay,
// enrollment, snapshots and socket auth go through the real product interfaces.
const permissive = { requestsPerMinute: 10000, enrollmentPerMinute: 10000, roomEnrollmentsPerMinute: 1000, roomEnrollmentBurst: 100,
  commandsPerMinute: 1000, commandBurst: 100, readsPerMinute: 1000, readBurst: 100,
  ticketsPerMinute: 1000, ticketBurst: 100, roomTicketsPerMinute: 1000, roomTicketBurst: 100, upgradesPerMinute: 1000, upgradeBurst: 100 };
const secret = () => randomBytes(32).toString('base64url');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const end = Date.now() + 15000;
  while (!await predicate()) { assert.ok(Date.now() < end, 'Timed out waiting for local transport'); await delay(20); }
}
const draft = (commandId, expectedDraftRevision, command) => ({ commandId, expectedDraftRevision, command });
const lifecycle = (commandId, expectedRoomRevision, type) => ({ commandId, expectedRoomRevision, command: { type } });
const forbiddenKeys = new Set(['canonicalSave', 'serializedCompetition', 'history', 'receipts', 'challengeSeed', 'draftRootSeed',
  'scheduleSeed', 'submissionHash', 'resolutionHash', 'submissions', 'campaigns', 'auth', 'verifier', 'ciphertext', 'reconnectCredential', 'ticket']);
function safeHttp(body, secrets) {
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) { assert.ok(!forbiddenKeys.has(key), `Forbidden HTTP field: ${key}`); visit(child); }
  };
  visit(body);
  const bytes = JSON.stringify(body);
  for (const value of secrets) assert.ok(!bytes.includes(value), 'Sensitive value escaped HTTP projection');
}
function publicOnly(view) { const { myDraft: _private, ...shared } = view; return shared; }
function legalLock(view, variant) {
  const choices = view.myDraft.candidates.flatMap(candidate => candidate.positions.filter(slot => slot.available)
    .map(slot => ({ type: 'LOCK_PLAYER', playerTeamSeasonId: candidate.playerTeamSeasonId, battingPosition: slot.battingPosition })));
  assert.ok(choices.length > 0, 'No legal projected selection');
  return choices[variant % choices.length];
}
function connect(runtime, room, ticket) {
  const url = new URL(`/api/draft-off/v1/rooms/${room.roomCode}/realtime`, runtime.url); url.protocol = 'ws:';
  const ws = new WebSocket(url, ['draft-off.v1', `ticket.${ticket}`], { headers: { Origin: origin, 'CF-Connecting-IP': '127.0.0.1' } });
  const messages = []; let selected;
  ws.on('message', bytes => messages.push(bytes.toString()));
  ws.on('upgrade', response => { selected = response.headers['sec-websocket-protocol']; });
  ws.on('error', () => {});
  const opened = new Promise((resolve, reject) => {
    ws.once('open', () => resolve(101)); ws.once('error', reject);
    ws.once('unexpected-response', (_request, response) => {
      response.resume(); response.once('end', () => { resolve(response.statusCode); ws.terminate(); });
    });
  });
  const closed = new Promise(resolve => ws.once('close', code => resolve(code)));
  return { ws, messages, opened, closed, selected: () => selected };
}
test('M4 Stage E combined HTTP/WebSocket multiplayer, recovery, privacy and directional latency smoke', { timeout: 240000 }, async () => {
  const statePath = mkdtempSync(join(tmpdir(), 'draft-off-stage-e-'));
  const sockets = [], logs = [], secrets = [], timings = {};
  let runtime, correctnessPassed = false, evidence;
  const timed = async (name, action) => {
    const start = performance.now();
    try { return await action(); }
    finally { (timings[name] ??= []).push(performance.now() - start); }
  };
  const start = async () => { runtime = await startRuntime(statePath, { overrides: permissive }); logs.push(runtime.logs); };
  const snapshot = async room => {
    const reply = await call(runtime, `/rooms/${room.roomCode}`, { token: room.reconnectCredential });
    assert.equal(reply.status, 200); assert.equal(reply.headers.get('cache-control'), 'private, no-store');
    safeHttp(reply.body, secrets); return reply.body.view;
  };
  const command = async (room, input) => {
    const reply = await call(runtime, `/rooms/${room.roomCode}/commands`, { method: 'POST', token: room.reconnectCredential, body: input });
    safeHttp(reply.body, secrets); return reply;
  };
  const issue = async room => {
    const reply = await call(runtime, `/rooms/${room.roomCode}/socket-tickets`, { method: 'POST', token: room.reconnectCredential, body: {} });
    assert.equal(reply.status, 201); assert.deepEqual(Object.keys(reply.body).sort(), ['expiresAtMs', 'ok', 'ticket']);
    assert.equal(reply.headers.get('cache-control'), 'private, no-store'); secrets.push(reply.body.ticket); return reply.body.ticket;
  };
  const open = async (room, issued) => {
    const ticket = issued ?? await issue(room), client = connect(runtime, room, ticket); sockets.push(client);
    assert.equal(await client.opened, 101); await until(() => client.messages.length > 0);
    assert.equal(client.selected(), 'draft-off.v1'); assert.equal(new URL(client.ws.url).search, ''); return client;
  };
  const evict = () => runtime.mf.unsafeEvictDurableObject('stage-d', 'StageDTestRoom', { name: host.roomCode, webSockets: 'hibernate' });
  let host;
  try {
    await start();
    const enrollments = [];
    const enroll = async (path, input) => {
      const key = secret(); secrets.push(key);
      const invoke = () => call(runtime, path, { method: 'POST', key, body: input });
      const responses = await Promise.all([invoke(), invoke()]);
      assert.ok(responses.every(reply => reply.status === 201));
      assert.deepEqual(responses[0].body, responses[1].body);
      secrets.push(responses[0].body.reconnectCredential);
      enrollments.push({ path, input, key, original: responses[0].body }); return responses[0].body;
    };
    host = await enroll('/rooms', { displayName: 'E_PRIVATE_HOST_SENTINEL', eraId: 'era-impact', draftMinutes: 10 });
    const members = await Promise.all([1, 2].map(index => enroll(`/rooms/${host.roomCode}/join`, { displayName: `E_PRIVATE_GUEST_${index}_SENTINEL` })));
    const rooms = [host, ...members]; assert.equal(new Set(rooms.map(room => room.participantId)).size, 3);
    const clients = await Promise.all(rooms.map(room => open(room)));
    const lobby = await snapshot(host);
    assert.equal(lobby.participants.length, 3);
    const lobbyWake = (await control(runtime, host.roomCode, 'inspect')).records.wake;
    assert.equal(lobbyWake.kind, 'LOBBY_EXPIRY');
    const startInput = lifecycle('e_start', lobby.revision, 'START'), started = await command(host, startInput);
    assert.equal(started.status, 200);
    await until(() => clients.every(client => client.messages.length === 2));
    const deadline = started.body.view.round.deadlineAtMs;
    assert.ok(deadline - started.body.view.round.startedAtMs > 599000 && deadline - started.body.view.round.startedAtMs <= 600000);
    let views = await Promise.all(rooms.map(snapshot));
    const initialRevision = views[0].myDraft.revision;
    assert.ok(views.every(view => view.myDraft.revision === initialRevision));
    // Two same-participant commands race, while unrelated participants use the
    // same private revision and succeed despite changing global revisions.
    const initialInputs = rooms.map((_room, index) => draft(`e_spin_${index}_0`, initialRevision, { type: 'SPIN' }));
    const first = await Promise.all([...rooms.map((room, index) => command(room, initialInputs[index])),
      command(host, draft('e_same_participant_race', initialRevision, { type: 'SPIN' }))]);
    assert.equal(first[1].status, 200); assert.equal(first[2].status, 200);
    assert.deepEqual([first[0].status, first[3].status].sort(), [200, 409]);
    const winningHost = first[0].status === 200 ? initialInputs[0] : draft('e_same_participant_race', initialRevision, { type: 'SPIN' });
    const winningReply = first[0].status === 200 ? first[0] : first[3];
    const losingReply = first[0].status === 409 ? first[0] : first[3];
    assert.equal(losingReply.body.error.code, 'STALE_DRAFT_REVISION');
    views = await Promise.all(rooms.map(snapshot));
    const conflict = await command(members[0], winningHost);
    assert.equal(conflict.status, 409); assert.equal(conflict.body.error.code, 'COMMAND_ID_CONFLICT');
    if (conflict.body.view) assert.deepEqual(conflict.body.view.myDraft, views[1].myDraft);
    const savedPrivate = views[2].myDraft;
    const extra = await command(host, draft('e_respin', views[0].myDraft.revision, { type: 'RESPIN' }));
    assert.equal(extra.status, 200); views[0] = extra.body.view;
    assert.deepEqual((await snapshot(members[1])).myDraft, savedPrivate);
    for (let pick = 0; pick < 11; pick++) {
      const active = rooms.map((_room, index) => index).filter(index => pick < 10 || index < 2);
      if (pick > 0) {
        const replies = await timed('concurrentSpinBatch', () => Promise.all(active.map(index => timed('spin', () => command(rooms[index],
          draft(`e_spin_${index}_${pick}`, views[index].myDraft.revision, { type: 'SPIN' }))))));
        replies.forEach((reply, offset) => { assert.equal(reply.status, 200); views[active[offset]] = reply.body.view; });
      }
      const replies = await timed('concurrentLockBatch', () => Promise.all(active.map(index => timed('lock', () => command(rooms[index],
        draft(`e_lock_${index}_${pick}`, views[index].myDraft.revision, legalLock(views[index], index)))))));
      replies.forEach((reply, offset) => { assert.equal(reply.status, 200); views[active[offset]] = reply.body.view; });
      if (pick === 4) {
        const before = await control(runtime, host.roomCode, 'instance'); await evict();
        const after = await control(runtime, host.roomCode, 'instance');
        assert.notEqual(after.instanceId, before.instanceId); assert.equal(after.sockets, 3);
        assert.ok(clients.every(client => client.ws.readyState === WebSocket.OPEN));
        for (let index = 0; index < rooms.length; index++) assert.deepEqual((await snapshot(rooms[index])).myDraft, views[index].myDraft);
        assert.deepEqual((await command(host, winningHost)).body, winningReply.body);
        // A dropped socket gets a new one-use ticket; reconnect has no membership effect.
        clients[0].ws.close(); await clients[0].closed;
        const fresh = await issue(host); clients[0] = await open(host, fresh);
        const replay = connect(runtime, host, fresh); sockets.push(replay); assert.equal(await replay.opened, 401);
      }
    }
    assert.ok(clients.slice(1).every(client => client.messages.length === 2), 'Private draft progress broadcast');
    assert.equal(clients[0].messages.length, 1);
    assert.equal(views[0].myDraft.phase, 'XI_COMPLETE'); assert.equal(views[1].myDraft.phase, 'XI_COMPLETE');
    // Persisted-runtime restart loses sockets, but not drafts, receipts, recovery
    // records or an unconsumed ticket. Exact enrollment retries return old views.
    const pendingTicket = await issue(host);
    for (const client of clients) { client.ws.close(); await client.closed; }
    await runtime.mf.dispose(); runtime = undefined; await start();
    await timed('restartSnapshot', () => snapshot(host));
    for (let index = 0; index < rooms.length; index++) assert.deepEqual((await snapshot(rooms[index])).myDraft, views[index].myDraft);
    assert.deepEqual((await command(host, winningHost)).body, winningReply.body);
    assert.deepEqual((await command(host, startInput)).body, started.body);
    for (const enrollment of enrollments) {
      const retry = await call(runtime, enrollment.path, { method: 'POST', key: enrollment.key, body: enrollment.input });
      assert.equal(retry.status, 201); assert.deepEqual(retry.body, enrollment.original);
    }
    clients[0] = await open(host, pendingTicket);
    clients[1] = await open(members[0]); clients[2] = await open(members[1]);
    // Credential classes are deliberately non-interchangeable.
    for (const value of [enrollments[0].key, pendingTicket]) {
      const denied = await call(runtime, `/rooms/${host.roomCode}`, { token: value });
      assert.equal(denied.status, 401); safeHttp(denied.body, secrets);
      assert.deepEqual(Object.keys(denied.body).sort(), ['error', 'ok']);
    }
    for (const value of [host.reconnectCredential, enrollments[0].key]) {
      const denied = connect(runtime, host, value); sockets.push(denied); assert.equal(await denied.opened, 401);
    }
    const mixed = await call(runtime, `/rooms/${host.roomCode}`, { token: host.reconnectCredential, key: enrollments[0].key });
    assert.equal(mixed.status, 400); safeHttp(mixed.body, secrets);
    const submitInput = draft('e_submit_host', views[0].myDraft.revision, { type: 'SUBMIT' });
    const submitted = await timed('submit', () => command(host, submitInput)); assert.equal(submitted.status, 200);
    await until(() => clients.every(client => client.messages.length === 2));
    assert.equal(new Set(clients.map(client => client.messages.at(-1))).size, 1);
    assert.deepEqual((await command(host, submitInput)).body, submitted.body);
    // Native alarm must resolve without a browser GET/command. Control inspection
    // only reads storage and cannot invoke M3 recovery. The same sockets survive
    // another forced hibernation and receive the final public snapshot.
    const beforeDeadline = await control(runtime, host.roomCode, 'instance');
    await control(runtime, host.roomCode, 'offset', { offset: deadline - Date.now() - 800 });
    await snapshot(host); await evict();
    await until(async () => (await control(runtime, host.roomCode, 'inspect')).records.wake.kind === 'COMPLETED_EXPIRY');
    await until(() => clients.every(client => client.messages.length === 3));
    const afterDeadline = await control(runtime, host.roomCode, 'instance');
    assert.notEqual(afterDeadline.instanceId, beforeDeadline.instanceId); assert.equal(afterDeadline.sockets, 3);
    assert.equal(new Set(clients.map(client => client.messages.at(-1))).size, 1);
    const finalSocketTime = JSON.parse(clients[0].messages.at(-1)).serverTimeMs;
    assert.ok(finalSocketTime >= deadline);
    timings.deadlineToPublicSnapshot = [finalSocketTime - deadline];
    const final = await snapshot(host);
    assert.equal(final.phase, 'COMPLETE'); assert.equal(final.resolution.trigger, 'DEADLINE');
    assert.equal(final.resolution.contestStatus, 'CONTESTED'); assert.equal(final.resolution.leaderboard.length, 2);
    assert.deepEqual([...final.resolution.eligibleParticipantIds].sort(), rooms.slice(0, 2).map(room => room.participantId).sort());
    assert.deepEqual(final.resolution.ineligibleParticipantIds, [members[1].participantId]);
    for (const client of clients) assert.deepEqual(JSON.parse(client.messages.at(-1)).view, publicOnly(final));
    const resolvedRecords = (await control(runtime, host.roomCode, 'inspect')).records;
    assert.equal(resolvedRecords.wake.atMs, final.resolution.resolvedAtMs + 7 * 86400000);
    assert.equal(Object.keys(resolvedRecords).filter(key => key.startsWith('receipt:deadline:')).length, 1);
    await control(runtime, host.roomCode, 'alarm');
    assert.deepEqual((await command(host, submitInput)).body, submitted.body);
    assert.deepEqual(await snapshot(host), final); await delay(30);
    assert.ok(clients.every(client => client.messages.length === 3));
    // Cross the exact completed-room expiry. No auth/ticket/recovery/receipt data
    // may survive, and repeated requests cannot extend the retired marker.
    await control(runtime, host.roomCode, 'offset', { offset: resolvedRecords.wake.atMs - Date.now() + 1 });
    assert.equal((await call(runtime, `/rooms/${host.roomCode}`, { token: host.reconnectCredential })).status, 401);
    for (const client of clients) assert.equal(await client.closed, 4004);
    const expired = (await control(runtime, host.roomCode, 'inspect')).records;
    assert.deepEqual(Object.keys(expired), ['retired']);
    assert.equal(expired.retired.retiredAtMs, resolvedRecords.wake.atMs);
    assert.equal(expired.retired.purgeAtMs, resolvedRecords.wake.atMs + 30 * 86400000);
    const retryExpired = await call(runtime, enrollments[0].path, { method: 'POST', key: enrollments[0].key, body: enrollments[0].input });
    assert.equal(retryExpired.status, 409); safeHttp(retryExpired.body, secrets);
    assert.deepEqual((await control(runtime, host.roomCode, 'inspect')).records, expired);
    for (const client of sockets) for (const bytes of client.messages) {
      parseRoomSnapshot(bytes, host.roomCode);
      safeHttp(JSON.parse(bytes), secrets);
      for (const field of ['myDraft', 'picks', 'candidates', 'xi', 'submission']) assert.ok(!Object.hasOwn(JSON.parse(bytes).view, field));
    }
    await delay(50);
    const entries = logs.flat(); assert.ok(entries.length > 100, 'Application log scan was vacuous');
    for (const entry of entries) {
      const event = JSON.parse(entry.message);
      for (const field of Object.keys(event)) assert.ok(['requestId', 'route', 'status', 'code', 'elapsedMs'].includes(field));
      assert.ok(!event.route.includes(host.roomCode));
    }
    const logBytes = JSON.stringify(entries);
    const seeds = JSON.parse(resolvedRecords.competition).genesis.initialRound;
    for (const value of [...secrets, ...rooms.flatMap(room => [room.participantId, room.view.participants.find(p => p.participantId === room.participantId).displayName]),
      host.roomCode, seeds.challengeSeed, 'ticket.', 'Authorization', 'Enrollment-Key', 'Sec-WebSocket-Protocol', 'myDraft', 'candidates', 'serializedCompetition']) {
      assert.ok(!logBytes.includes(value), 'Sensitive value escaped application logging');
    }
    const baseline = JSON.parse(readFileSync(new URL('../stage-a/index-milestone/fixture-hashes-after.json', import.meta.url)));
    for (const [file, expected] of Object.entries(baseline)) {
      assert.equal(createHash('sha256').update(readFileSync(new URL(`../stage-a/.generated/fixtures/${file}`, import.meta.url))).digest('hex'), expected);
    }
    evidence = {
      participants: 3, era: 'era-impact', manualSubmissions: 1, deadlineAutoSubmissions: 1, incompleteAtDeadline: 1,
      contestedLeaderboardRows: 2, exactEnrollmentRecoveryAfterRestart: true, exactCommandRetriesAfterHibernationAndRestart: true,
      participantRevisionIsolation: true, sameParticipantRaceProtected: true, credentialClassesSeparated: true,
      hibernationWithSurvivingSockets: true, persistedRuntimeRestart: true, nativeDeadlineAfterHibernation: true,
      fixedCompletedRetentionAndMinimalMarker: true, publicOnlyIdenticalSocketSnapshots: true, noSecretsInHttpErrorsOrApplicationLogs: true,
      applicationLogEventsScanned: entries.length, canonicalFixtureHashesUnchanged: Object.keys(baseline).length,
      permissiveLocalRateOverrides: true };
    correctnessPassed = true;
  } finally {
    try {
      recordLatency({ file: 'multiplayer-smoke.json', samples: timings, correctnessPassed,
        gatedMetrics: ['concurrentSpinBatch', 'concurrentLockBatch', 'submit', 'deadlineToPublicSnapshot'],
        details: { ...evidence, participants: 3, era: 'era-impact', limitations: ['Local loopback only; no deployed latency/quota claim.',
          'Small correlated sample; no expensive Stage A matrix repeated.', 'External observability configuration is a future deployment gate.'] } });
    } finally {
      for (const client of sockets) client.ws.terminate();
      if (runtime) await runtime.mf.dispose();
      rmSync(statePath, { recursive: true, force: true });
    }
  }
});

test('eight-player production HTTP/WebSocket full drafts and late concurrent latency smoke', { timeout: 240000 }, async () => {
  const statePath = mkdtempSync(join(tmpdir(), 'draft-off-stage-e-production-'));
  const clients = [], secrets = [], samples = { spin: [], lock: [], spinBatch: [], lockBatch: [], finalSubmit: [] };
  let runtime, correctnessPassed = false, evidence;
  try {
    runtime = await startRuntime(statePath, { production: true, overrides: permissive });
    assert.equal((await fetch(new URL('/__test/anything/inspect', runtime.url))).status, 404);
    const createKey = secret(); secrets.push(createKey);
    const created = await call(runtime, '/rooms', { method: 'POST', key: createKey,
      body: { displayName: 'Production host', eraId: 'era-impact', draftMinutes: 10 } });
    assert.equal(created.status, 201); const host = created.body, rooms = [host]; secrets.push(host.reconnectCredential);
    for (let index = 1; index < 8; index++) {
      const key = secret(); secrets.push(key);
      const joined = await call(runtime, `/rooms/${host.roomCode}/join`, { method: 'POST', key, body: { displayName: `Production guest ${index}` } });
      assert.equal(joined.status, 201); rooms.push(joined.body); secrets.push(joined.body.reconnectCredential);
    }
    for (const room of rooms) {
      const issued = await call(runtime, `/rooms/${room.roomCode}/socket-tickets`, { method: 'POST', token: room.reconnectCredential, body: {} });
      assert.equal(issued.status, 201); secrets.push(issued.body.ticket);
      const client = connect(runtime, room, issued.body.ticket); clients.push(client);
      assert.equal(await client.opened, 101); await until(() => client.messages.length === 1);
      assert.equal(client.selected(), 'draft-off.v1');
    }
    const read = async room => {
      const result = await call(runtime, `/rooms/${room.roomCode}`, { token: room.reconnectCredential });
      assert.equal(result.status, 200); safeHttp(result.body, secrets); return result.body.view;
    };
    const command = async (room, input, metric) => {
      const begin = performance.now();
      let reply;
      try { reply = await call(runtime, `/rooms/${room.roomCode}/commands`, { method: 'POST', token: room.reconnectCredential, body: input }); }
      finally { if (metric) samples[metric].push(performance.now() - begin); }
      assert.equal(reply.status, 200); safeHttp(reply.body, secrets); return reply.body.view;
    };
    const lobby = await read(host);
    await command(host, lifecycle('production_start', lobby.revision, 'START'));
    await until(() => clients.every(client => client.messages.length === 2));
    let views = await Promise.all(rooms.map(read));
    for (let pick = 0; pick < 11; pick++) {
      const late = pick >= 9;
      let begin = performance.now();
      views = await Promise.all(rooms.map((room, index) => command(room,
        draft(`production_spin_${index}_${pick}`, views[index].myDraft.revision, { type: 'SPIN' }), late ? 'spin' : undefined)));
      if (late) samples.spinBatch.push(performance.now() - begin);
      begin = performance.now();
      views = await Promise.all(rooms.map((room, index) => command(room,
        draft(`production_lock_${index}_${pick}`, views[index].myDraft.revision, legalLock(views[index], index)), late ? 'lock' : undefined)));
      if (late) samples.lockBatch.push(performance.now() - begin);
    }
    assert.ok(views.every(view => view.myDraft.phase === 'XI_COMPLETE'));
    assert.ok(clients.every(client => client.messages.length === 2), 'Private progress broadcast in production');
    for (let index = 0; index < rooms.length; index++) {
      views[index] = await command(rooms[index], draft(`production_submit_${index}`, views[index].myDraft.revision, { type: 'SUBMIT' }),
        index === rooms.length - 1 ? 'finalSubmit' : undefined);
    }
    await until(() => clients.every(client => client.messages.length === 10));
    assert.equal(new Set(clients.map(client => client.messages.at(-1))).size, 1);
    const final = await read(host);
    assert.equal(final.phase, 'COMPLETE'); assert.equal(final.resolution.trigger, 'ALL_SUBMITTED');
    assert.equal(final.resolution.contestStatus, 'CONTESTED'); assert.equal(final.resolution.leaderboard.length, 8);
    for (const client of clients) for (const bytes of client.messages) {
      parseRoomSnapshot(bytes, host.roomCode); safeHttp(JSON.parse(bytes), secrets);
    }
    evidence = {
      productionBundle: true, participants: 8, era: 'era-impact', completedXis: 8, contestedLeaderboardRows: 8,
      trigger: 'ALL_SUBMITTED', identicalPublicSnapshots: true, privateProgressDoesNotBroadcast: true,
      fixtureControlsUnavailable: true, permissiveLocalRateOverrides: true };
    correctnessPassed = true;
  } finally {
    try {
      recordLatency({ file: 'production-smoke.json', samples, correctnessPassed, gatedMetrics: Object.keys(samples),
        details: { ...evidence, productionBundle: true, participants: 8, era: 'era-impact',
          limitations: ['Two late spin/lock burst pairs; correlated responses, not independent trials.',
            'Local workerd loopback, no deployed Cloudflare or multi-room claim.',
            'Original 2s p95 / 3s max budgets; enforced only in controlled performance mode. No expensive Stage A matrix.'] } });
    } finally {
      for (const client of clients) client.ws.terminate();
      if (runtime) await runtime.mf.dispose();
      rmSync(statePath, { recursive: true, force: true });
    }
  }
});
