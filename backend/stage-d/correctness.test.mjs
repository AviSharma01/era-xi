import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import WebSocket from '../stage-a/node_modules/ws/wrapper.mjs';
import { call, control, origin, startRuntime } from './runtime.mjs';
import { legalLock } from '../stage-a/runtime.mjs';
import { parseRoomSnapshot } from './.generated/client.js';

const temp = () => mkdtempSync(join(tmpdir(), 'draft-off-stage-d-'));
const secret = () => randomBytes(32).toString('base64url');
const permissive = { requestsPerMinute: 10000, enrollmentPerMinute: 10000, roomEnrollmentsPerMinute: 1000, roomEnrollmentBurst: 100,
  commandsPerMinute: 1000, commandBurst: 100, readsPerMinute: 1000, readBurst: 100,
  ticketsPerMinute: 1000, ticketBurst: 100, roomTicketsPerMinute: 1000, roomTicketBurst: 100, upgradesPerMinute: 1000, upgradeBurst: 100 };
const create = async runtime => (await call(runtime, '/rooms', { method: 'POST', key: secret(), body: { displayName: 'Host', eraId: 'era-foundation' } })).body;
const guest = async (runtime, host, name = 'Guest') => (await call(runtime, `/rooms/${host.roomCode}/join`, { method: 'POST', key: secret(), body: { displayName: name } })).body;
const snapshot = (runtime, room) => call(runtime, `/rooms/${room.roomCode}`, { token: room.reconnectCredential });
const command = (runtime, room, input) => call(runtime, `/rooms/${room.roomCode}/commands`, { method: 'POST', token: room.reconnectCredential, body: input });
const lifecycle = (id, revision, type) => ({ commandId: id, expectedRoomRevision: revision, command: { type } });
const draft = (id, revision, command) => ({ commandId: id, expectedDraftRevision: revision, command });
const ticket = (runtime, room, headers) => call(runtime, `/rooms/${room.roomCode}/socket-tickets`, { method: 'POST', token: room.reconnectCredential, body: {}, headers });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout = 15000) { const end = Date.now() + timeout; while (!await predicate()) { if (Date.now() >= end) throw new Error('Condition timed out'); await delay(15); } }
function connection(runtime, room, token, { headers = {}, suffix = '', protocols } = {}) {
  const url = new URL(`/api/draft-off/v1/rooms/${room.roomCode}/realtime${suffix}`, runtime.url); url.protocol = 'ws:';
  const ws = new WebSocket(url, protocols ?? ['draft-off.v1', `ticket.${token}`], { headers: { Origin: origin, 'CF-Connecting-IP': '127.0.0.1', ...headers } });
  const messages = []; let selected;
  ws.on('message', bytes => messages.push(bytes.toString()));
  ws.on('upgrade', response => { selected = response.headers['sec-websocket-protocol']; });
  ws.on('error', () => {});
  const opened = new Promise((resolve, reject) => {
    ws.once('open', () => resolve(true));
    ws.once('unexpected-response', (_request, response) => {
      const chunks = []; response.on('data', data => chunks.push(data)); response.on('end', () => {
        resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); ws.terminate();
      });
    });
    ws.once('error', reject);
  });
  const closed = new Promise(resolve => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  return { ws, messages, opened, closed, selected: () => selected, wait: async count => { await until(() => messages.length >= count); return JSON.parse(messages[count - 1]); } };
}
async function open(runtime, room, issued) {
  const result = issued ?? await ticket(runtime, room); assert.equal(result.status, 201, JSON.stringify(result.body));
  const client = connection(runtime, room, result.body.ticket); assert.equal(await client.opened, true); await client.wait(1);
  assert.equal(client.selected(), 'draft-off.v1'); assert.ok(!client.ws.url.includes(result.body.ticket));
  return client;
}
function safe(client, code, secrets = []) {
  for (const bytes of client.messages) {
    parseRoomSnapshot(bytes, code);
    for (const forbidden of ['myDraft', 'picks', 'candidates', 'xi', 'submissionHash', 'serializedCompetition', 'receipts', 'challengeSeed', 'draftRootSeed', 'scheduleSeed', ...secrets]) assert.ok(!bytes.includes(forbidden), `Leaked ${forbidden}`);
  }
}
async function begin(runtime, host, member) {
  const view = (await snapshot(runtime, host)).body.view;
  const result = await command(runtime, host, lifecycle('start', view.revision, 'START')); assert.equal(result.status, 200);
  return result.body.view;
}

test('single-use, room/Origin-bound persisted ticket and strict upgrade security', { timeout: 120000 }, async t => {
  const runtime = await startRuntime(temp(), { overrides: permissive, bindings: { ALLOWED_ORIGINS: JSON.stringify([origin, 'https://second.example']) } });
  const sockets = [];
  try {
    const host = await create(runtime), other = await create(runtime);
    const issued = await ticket(runtime, host); assert.equal(issued.status, 201); assert.ok(issued.body.expiresAtMs - Date.now() <= 30000);
    const records = (await control(runtime, host.roomCode, 'inspect')).records;
    assert.equal(Object.keys(records).filter(key => key.startsWith('api:socket-ticket:')).length, 1);
    assert.ok(!JSON.stringify(records).includes(issued.body.ticket)); assert.ok(!JSON.stringify(records).includes(host.reconnectCredential));
    for (const [room, token, options, expected] of [
      [host, secret(), {}, 401], [host, host.reconnectCredential, {}, 401], [other, issued.body.ticket, {}, 401],
      [host, issued.body.ticket, { headers: { Origin: 'https://evil.example' } }, 403],
      [host, issued.body.ticket, { headers: { Origin: 'https://second.example' } }, 401],
      [host, issued.body.ticket, { suffix: '?ticket=forbidden' }, 400],
      [host, issued.body.ticket, { headers: { Authorization: `Bearer ${host.reconnectCredential}` } }, 400],
      [host, issued.body.ticket, { protocols: ['draft-off.v1'] }, 401],
    ]) {
      const failed = connection(runtime, room, token, options); assert.equal((await failed.opened).status, expected);
    }
    await runtime.mf.unsafeEvictDurableObject('stage-d', 'StageDTestRoom', { name: host.roomCode });
    const races = [connection(runtime, host, issued.body.ticket), connection(runtime, host, issued.body.ticket)];
    const results = await Promise.all(races.map(client => client.opened));
    assert.equal(results.filter(value => value === true).length, 1); assert.equal(results.find(value => value !== true).status, 401);
    const accepted = races[results.indexOf(true)]; sockets.push(accepted); await accepted.wait(1);
    assert.equal((await connection(runtime, host, issued.body.ticket).opened).status, 401);
    const expired = await ticket(runtime, host);
    await control(runtime, host.roomCode, 'offset', { offset: 31000 });
    assert.equal((await connection(runtime, host, expired.body.ticket).opened).status, 401);
    const fresh = await ticket(runtime, host);
    await control(runtime, host.roomCode, 'fail');
    assert.equal((await connection(runtime, host, fresh.body.ticket).opened).status, 503);
    sockets.push(await open(runtime, host, fresh));
    assert.equal(Object.keys((await control(runtime, host.roomCode, 'inspect')).records).filter(key => key.startsWith('api:socket-ticket:')).length, 0);
    for (const client of sockets) safe(client, host.roomCode, [issued.body.ticket, fresh.body.ticket, host.reconnectCredential]);
    assert.ok(!JSON.stringify(runtime.logs).includes(issued.body.ticket));
    assert.ok(!JSON.stringify(runtime.logs).includes('ticket.'));
    await control(runtime, host.roomCode, 'put', { key: 'api:socket-ticket:invalid', value: { version: 99 } });
    assert.equal((await snapshot(runtime, host)).status, 200);
    assert.ok(!Object.hasOwn((await control(runtime, host.roomCode, 'inspect')).records, 'api:socket-ticket:invalid'));
    const bad = await call(runtime, `/rooms/${host.roomCode}/socket-tickets`, { method: 'POST', token: host.reconnectCredential, body: { participantId: other.participantId } }); assert.equal(bad.status, 400);
  } finally { for (const client of sockets) client.ws.close(); await runtime.mf.dispose(); }
});

test('committed locks and statuses broadcast once; spins and historical retries never broadcast', { timeout: 240000 }, async () => {
  const runtime = await startRuntime(temp(), { overrides: permissive }); const clients = [];
  try {
    const host = await create(runtime); const a = await open(runtime, host); clients.push(a);
    const member = await guest(runtime, host); await a.wait(2);
    const b = await open(runtime, member); clients.push(b);
    const before = (await snapshot(runtime, host)).body.view;
    const leave = lifecycle('leave', before.revision, 'LEAVE');
    assert.equal((await command(runtime, member, leave)).status, 200); await a.wait(3); await b.wait(2); assert.equal(a.messages.at(-1), b.messages.at(-1));
    const rejoin = lifecycle('rejoin', (await snapshot(runtime, member)).body.view.revision, 'REJOIN');
    assert.equal((await command(runtime, member, rejoin)).status, 200); await a.wait(4); await b.wait(3);
    const view = await begin(runtime, host, member); await a.wait(5); await b.wait(4); assert.equal(a.messages.at(-1), b.messages.at(-1));
    assert.equal(JSON.parse(a.messages.at(-1)).view.round.deadlineAtMs, view.round.deadlineAtMs);
    assert.ok(view.participants.every(row => row.lockedPickCount === 0));
    let locks = 0;
    for (const room of [host, member]) {
      let own = (await snapshot(runtime, room)).body.view;
      for (let pick = 0; pick < 11; pick++) {
        const reply = await command(runtime, room, draft(`${room.participantId}_spin_${pick}`, own.myDraft.revision, { type: 'SPIN' }));
        assert.equal(reply.status, 200); own = reply.body.view;
        assert.equal(a.messages.length, 5 + locks); assert.equal(b.messages.length, 4 + locks);
        const locked = await command(runtime, room, draft(`${room.participantId}_lock_${pick}`, own.myDraft.revision, legalLock(own)));
        assert.equal(locked.status, 200); own = locked.body.view;
        locks++;
        const update = await a.wait(5 + locks); await b.wait(4 + locks);
        assert.equal(a.messages.at(-1), b.messages.at(-1));
        assert.equal(update.view.participants.find(row => row.participantId === room.participantId).lockedPickCount, pick + 1);
        const { myDraft: _private, ...shared } = own;
        assert.deepEqual(update.view, shared);
      }
    }
    assert.equal(a.messages.length, 27); assert.equal(b.messages.length, 26);
    const hostView = (await snapshot(runtime, host)).body.view;
    const submit = draft('submit-host', hostView.myDraft.revision, { type: 'SUBMIT' });
    const submitted = await command(runtime, host, submit); assert.equal(submitted.status, 200); await a.wait(28); await b.wait(27);
    assert.equal((await command(runtime, host, submit)).body.changed, true);
    const memberView = (await snapshot(runtime, member)).body.view;
    const last = await command(runtime, member, draft('submit-member', memberView.myDraft.revision, { type: 'SUBMIT' })); assert.equal(last.status, 200);
    await a.wait(29); await b.wait(28); assert.equal(a.messages.at(-1), b.messages.at(-1));
    assert.ok(JSON.parse(a.messages.at(-1)).view.participants.every(row => row.lockedPickCount === 11 && row.roundStatus === 'SUBMITTED'));
    assert.equal(JSON.parse(a.messages.at(-1)).view.resolution.contestStatus, 'CONTESTED');
    assert.equal((await command(runtime, host, submit)).body.roomRevision, submitted.body.roomRevision);
    await control(runtime, host.roomCode, 'alarm'); await delay(50);
    assert.equal(a.messages.length, 29); assert.equal(b.messages.length, 28);
    for (const client of clients) safe(client, host.roomCode, [host.reconnectCredential, member.reconnectCredential]);
  } finally { for (const client of clients) client.ws.close(); await runtime.mf.dispose(); }
});

test('lock progress is commit-atomic, idempotent and concurrent-safe, and survives hibernation, restart and reconnect', { timeout: 120000 }, async () => {
  const statePath = temp(); let runtime = await startRuntime(statePath, { overrides: permissive }); const clients = [];
  try {
    const host = await create(runtime), member = await guest(runtime, host);
    const a = await open(runtime, host), b = await open(runtime, member); clients.push(a, b);
    const initial = await begin(runtime, host, member); await a.wait(2); await b.wait(2);
    let own = initial;
    const counts = view => [host, member].map(room => view.participants.find(row => row.participantId === room.participantId).lockedPickCount);
    assert.deepEqual(counts(initial), [0, 0]);
    const send = async (id, cmd, revision = own.myDraft.revision) => command(runtime, host, draft(id, revision, cmd));
    assert.equal((await send('invalid-lock', { type: 'LOCK_PLAYER', playerTeamSeasonId: 'unknown', battingPosition: 1 })).status, 422);
    own = (await send('spin', { type: 'SPIN' })).body.view;
    own = (await send('respin', { type: 'RESPIN' })).body.view;
    assert.equal((await send('second-respin', { type: 'RESPIN' })).status, 422);
    assert.equal((await send('stale', legalLock(own), 0)).status, 409);
    const input = draft('lock', own.myDraft.revision, legalLock(own));
    const before = (await control(runtime, host.roomCode, 'inspect')).records.competition;
    await control(runtime, host.roomCode, 'fail');
    assert.equal((await command(runtime, host, input)).status, 503);
    assert.equal((await control(runtime, host.roomCode, 'inspect')).records.competition, before);
    assert.deepEqual(counts((await snapshot(runtime, member)).body.view), [0, 0]);
    await delay(30); assert.equal(a.messages.length, 2); assert.equal(b.messages.length, 2);
    const replies = await Promise.all([command(runtime, host, input), command(runtime, host, input)]);
    assert.equal(replies[0].status, 200); assert.deepEqual(replies[0].body, replies[1].body);
    const stale = await command(runtime, host, { ...input, commandId: 'stale-lock' });
    assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'STALE_DRAFT_REVISION');
    await a.wait(3); await b.wait(3); assert.equal(a.messages.at(-1), b.messages.at(-1));
    assert.deepEqual(counts(JSON.parse(a.messages.at(-1)).view), [1, 0]);
    const hibernating = await control(runtime, host.roomCode, 'instance');
    await runtime.mf.unsafeEvictDurableObject('stage-d', 'StageDTestRoom', { name: host.roomCode, webSockets: 'hibernate' });
    own = (await send('next-spin', { type: 'SPIN' }, replies[0].body.view.myDraft.revision)).body.view;
    const next = draft('next-lock', own.myDraft.revision, legalLock(own));
    const races = await Promise.all([command(runtime, host, next), command(runtime, host, { ...next, commandId: 'racing-lock' })]);
    assert.deepEqual(races.map(reply => reply.status).sort(), [200, 409]);
    assert.equal(races.find(reply => reply.status === 409).body.error.code, 'STALE_DRAFT_REVISION');
    await a.wait(4); await b.wait(4);
    assert.notEqual((await control(runtime, host.roomCode, 'instance')).instanceId, hibernating.instanceId);
    assert.deepEqual(counts(JSON.parse(a.messages.at(-1)).view), [2, 0]);
    assert.deepEqual((await command(runtime, host, input)).body, replies[0].body);
    await delay(30); assert.equal(a.messages.length, 4); assert.equal(b.messages.length, 4);
    const { myDraft: _private, ...shared } = (await snapshot(runtime, member)).body.view;
    assert.deepEqual(JSON.parse(b.messages.at(-1)).view, shared);
    const identity = input.command.playerTeamSeasonId;
    for (const client of clients) safe(client, host.roomCode, [identity, host.reconnectCredential, member.reconnectCredential]);
    for (const client of clients) { client.ws.close(); await client.closed; }
    await runtime.mf.dispose(); runtime = await startRuntime(statePath, { overrides: permissive });
    assert.deepEqual((await command(runtime, host, input)).body, replies[0].body);
    for (const room of [host, member]) {
      const fresh = await open(runtime, room); clients.push(fresh);
      const { myDraft: _own, ...publicView } = (await snapshot(runtime, room)).body.view;
      assert.deepEqual(JSON.parse(fresh.messages[0]).view, publicView);
      assert.deepEqual(counts(publicView), [2, 0]);
    }
  } finally { for (const client of clients) client.ws.close(); await runtime.mf.dispose(); }
});

test('hibernated sockets survive re-instantiation; native deadlines resolve with and without sockets', { timeout: 120000 }, async () => {
  const runtime = await startRuntime(temp(), { overrides: permissive }); const clients = [];
  try {
    for (const connected of [true, false]) {
      const host = await create(runtime), member = await guest(runtime, host);
      const a = connected ? await open(runtime, host) : undefined;
      if (a) clients.push(a);
      const view = await begin(runtime, host, member); if (a) await a.wait(2);
      await control(runtime, host.roomCode, 'alarm');
      if (a) assert.equal(a.messages.length, 2); // An early alarm only reconciles scheduling.
      const before = await control(runtime, host.roomCode, 'instance');
      await control(runtime, host.roomCode, 'offset', { offset: view.round.deadlineAtMs - Date.now() - 250 });
      await snapshot(runtime, host); // Re-arm native deadline against the fixture clock.
      await runtime.mf.unsafeEvictDurableObject('stage-d', 'StageDTestRoom', { name: host.roomCode, webSockets: 'hibernate' });
      await until(async () => (await control(runtime, host.roomCode, 'inspect')).records.wake.kind === 'COMPLETED_EXPIRY');
      const after = await control(runtime, host.roomCode, 'instance'); assert.notEqual(after.instanceId, before.instanceId);
      if (a) {
        const final = await a.wait(3); assert.equal(final.view.resolution.contestStatus, 'NO_CONTEST');
        assert.ok(final.view.participants.every(row => row.roundStatus === 'INELIGIBLE' && row.lockedPickCount === 0));
        assert.equal(a.ws.readyState, WebSocket.OPEN); assert.equal(after.attachments[0].participantId, host.participantId);
        const beforeCount = a.messages.length;
        await control(runtime, host.roomCode, 'alarm'); await delay(30); assert.equal(a.messages.length, beforeCount);
      }
      const resynced = await open(runtime, host); clients.push(resynced); assert.equal(JSON.parse(resynced.messages[0]).view.phase, 'COMPLETE');
    }
  } finally { for (const client of clients) client.ws.close(); await runtime.mf.dispose(); }
});

test('failed public commit emits nothing; exact successful retry emits once and corruption fails closed', { timeout: 120000 }, async () => {
  const runtime = await startRuntime(temp(), { overrides: permissive }); const clients = [];
  try {
    const host = await create(runtime), socket = await open(runtime, host); clients.push(socket);
    const before = await control(runtime, host.roomCode, 'inspect'), key = secret();
    await control(runtime, host.roomCode, 'fail');
    const join = () => call(runtime, `/rooms/${host.roomCode}/join`, { method: 'POST', key, body: { displayName: 'Guest' } });
    assert.equal((await join()).status, 503); assert.equal(socket.messages.length, 1);
    assert.equal((await control(runtime, host.roomCode, 'inspect')).records.competition, before.records.competition);
    assert.equal((await join()).status, 201); await socket.wait(2);
    assert.equal((await join()).status, 201); await delay(20); assert.equal(socket.messages.length, 2);
    const canonical = (await control(runtime, host.roomCode, 'inspect')).records.competition;
    await control(runtime, host.roomCode, 'put', { key: 'competition', value: '{corrupt' });
    // Invalid tickets fail before expensive canonical recovery or payload projection.
    assert.equal((await connection(runtime, host, secret()).opened).status, 401);
    assert.equal((await snapshot(runtime, host)).status, 503); assert.equal((await socket.closed).code, 1011);
    assert.equal(socket.messages.length, 2);
    await control(runtime, host.roomCode, 'put', { key: 'competition', value: canonical });
    assert.equal((await snapshot(runtime, host)).status, 200);
    clients.push(await open(runtime, host));
    assert.equal(JSON.parse(clients.at(-1).messages[0]).view.participants.length, 2);
  } finally { for (const client of clients) client.ws.close(); await runtime.mf.dispose(); }
});

test('ticket issuance throttles persist across eviction, refill, and never change lifecycle scheduling', { timeout: 120000 }, async () => {
  const runtime = await startRuntime(temp(), { overrides: { ...permissive, ticketsPerMinute: 2, ticketBurst: 1 } });
  try {
    const host = await create(runtime), before = await control(runtime, host.roomCode, 'inspect');
    assert.equal((await ticket(runtime, host)).status, 201); assert.equal((await ticket(runtime, host)).status, 429);
    await runtime.mf.unsafeEvictDurableObject('stage-d', 'StageDTestRoom', { name: host.roomCode });
    assert.equal((await ticket(runtime, host)).status, 429);
    await control(runtime, host.roomCode, 'offset', { offset: 31000 }); assert.equal((await ticket(runtime, host)).status, 201);
    const after = await control(runtime, host.roomCode, 'inspect');
    assert.equal(after.records.competition, before.records.competition); assert.equal(after.alarm + 31000, before.alarm);
    assert.deepEqual(after.records.wake, before.records.wake);
    assert.equal(Object.keys(after.records).filter(key => key.startsWith('api:socket-ticket:')).length, 1);
  } finally { await runtime.mf.dispose(); }
});

test('socket replacement, room caps, malformed messages and ticket caps preserve membership and alarms', { timeout: 120000 }, async () => {
  const runtime = await startRuntime(temp(), { overrides: { ...permissive, socketsPerParticipant: 2, socketsPerRoom: 2, pendingTicketsPerParticipant: 2 } }); const clients = [];
  try {
    const host = await create(runtime), member = await guest(runtime, host);
    const before = await control(runtime, host.roomCode, 'inspect');
    const a = await open(runtime, host), b = await open(runtime, host); clients.push(a, b);
    const c = await open(runtime, host); clients.push(c); assert.equal((await a.closed).code, 4001); assert.equal(b.ws.readyState, WebSocket.OPEN);
    const deniedTicket = await ticket(runtime, member); assert.equal((await connection(runtime, member, deniedTicket.body.ticket).opened).status, 429);
    b.ws.send('{"type":"START","participantId":"spoof"}'); assert.equal((await b.closed).code, 1008);
    const memberSocket = await open(runtime, member, deniedTicket); clients.push(memberSocket);
    c.ws.send(Buffer.alloc(2048)); assert.equal((await c.closed).code, 1009);
    const first = await ticket(runtime, host), second = await ticket(runtime, host);
    assert.equal(first.status, 201); assert.equal(second.status, 201); assert.equal((await ticket(runtime, host)).status, 429);
    const after = await control(runtime, host.roomCode, 'inspect');
    assert.equal(after.records.competition, before.records.competition); assert.deepEqual(after.records.wake, before.records.wake); assert.equal(after.alarm, before.alarm);
    await control(runtime, host.roomCode, 'offset', { offset: 31000 }); assert.equal((await ticket(runtime, host)).status, 201);
    assert.ok(Object.keys((await control(runtime, host.roomCode, 'inspect')).records).filter(key => key.startsWith('api:socket-ticket:')).length <= 2);
    memberSocket.ws.close(); await memberSocket.closed;
    assert.equal((await snapshot(runtime, member)).body.view.participants.find(p => p.participantId === member.participantId).membershipStatus, 'JOINED');
  } finally { for (const client of clients) client.ws.close(); await runtime.mf.dispose(); }
});

test('tickets survive process restart; expiry closes sockets and removes ticket records', { timeout: 120000 }, async () => {
  const statePath = temp(); let runtime = await startRuntime(statePath, { overrides: permissive }); const clients = [];
  try {
    const host = await create(runtime), issued = await ticket(runtime, host);
    await runtime.mf.dispose(); runtime = await startRuntime(statePath, { overrides: permissive });
    const socket = await open(runtime, host, issued); clients.push(socket);
    const pending = await ticket(runtime, host); assert.equal(pending.status, 201);
    const { records } = await control(runtime, host.roomCode, 'inspect');
    await control(runtime, host.roomCode, 'offset', { offset: records.wake.atMs - Date.now() + 1 });
    assert.equal((await snapshot(runtime, host)).status, 401); assert.equal((await socket.closed).code, 4004);
    assert.deepEqual(Object.keys((await control(runtime, host.roomCode, 'inspect')).records), ['retired']);
    assert.equal((await connection(runtime, host, pending.body.ticket).opened).status, 401);
    assert.deepEqual(Object.keys((await control(runtime, host.roomCode, 'inspect')).records), ['retired']);
  } finally { for (const client of clients) client.ws.close(); await runtime.mf.dispose(); }
});

test('production bundle excludes fixture controls and serves advisory realtime for eight participants', { timeout: 120000 }, async () => {
  const runtime = await startRuntime(temp(), { production: true, overrides: permissive }); const clients = [];
  try {
    const bundle = readFileSync(new URL('.generated/worker.js', import.meta.url), 'utf8');
    for (const forbidden of ['STAGE_D_ONLY', 'STAGE_C_ONLY', 'Injected commit failure', '__test', 'ProtocolProbe']) assert.ok(!bundle.includes(forbidden));
    assert.equal((await fetch(new URL('/__test/anything/inspect', runtime.url))).status, 404);
    const host = await create(runtime), rooms = [host];
    for (let index = 1; index < 8; index++) rooms.push(await guest(runtime, host, `Guest ${index}`));
    for (const room of rooms) clients.push(await open(runtime, room));
    await begin(runtime, host, rooms[1]);
    for (const client of clients) await client.wait(2);
    assert.equal(new Set(clients.map(client => client.messages[1])).size, 1);
    const spun = await command(runtime, host, draft('spin', 1, { type: 'SPIN' })); assert.equal(spun.status, 200);
    const locked = await command(runtime, host, draft('lock', spun.body.view.myDraft.revision, legalLock(spun.body.view))); assert.equal(locked.status, 200);
    for (const client of clients) {
      const update = await client.wait(3);
      assert.ok(update.view.participants.every(row => row.lockedPickCount === (row.participantId === host.participantId ? 1 : 0)));
    }
    assert.equal(new Set(clients.map(client => client.messages[2])).size, 1);
    for (const client of clients) safe(client, host.roomCode, rooms.map(room => room.reconnectCredential));
  } finally { for (const client of clients) client.ws.close(); await runtime.mf.dispose(); }
});

test('an oversized realtime projection cannot roll back a public commit or weaken deadline resolution', { timeout: 120000 }, async () => {
  const runtime = await startRuntime(temp(), { overrides: { ...permissive, snapshotBytes: 1024 } }); const clients = [];
  try {
    const host = await create(runtime), socket = await open(runtime, host); clients.push(socket);
    for (let index = 0; index < 3; index++) {
      const member = await guest(runtime, host, `${index}${'😀'.repeat(63)}`); assert.equal(member.ok, true);
    }
    assert.equal((await socket.closed).code, 1011);
    const before = (await snapshot(runtime, host)).body.view; assert.equal(before.participants.length, 4);
    assert.equal((await command(runtime, host, lifecycle('start', before.revision, 'START'))).status, 200);
    const active = (await snapshot(runtime, host)).body.view;
    await control(runtime, host.roomCode, 'offset', { offset: active.round.deadlineAtMs - Date.now() + 1 });
    await control(runtime, host.roomCode, 'alarm');
    const final = (await snapshot(runtime, host)).body.view;
    assert.equal(final.phase, 'COMPLETE'); assert.equal(final.resolution.contestStatus, 'NO_CONTEST');
  } finally { for (const client of clients) client.ws.close(); await runtime.mf.dispose(); }
});


test('unsupported socket-message floods close while the gameplay queue is held', { timeout: 60000 }, async () => {
  const runtime = await startRuntime(temp(), { overrides: permissive }); const clients = []; let host;
  try {
    host = await create(runtime); const member = await guest(runtime, host);
    const abusive = await open(runtime, host), healthy = await open(runtime, member); clients.push(abusive, healthy);
    const before = await control(runtime, host.roomCode, 'inspect');
    await control(runtime, host.roomCode, 'hold-queue');
    for (let index = 0; index < 64; index++) abusive.ws.send('{"type":"START"}');
    const closed = await Promise.race([abusive.closed, delay(1500).then(() => { throw new Error('Unsupported frames waited behind gameplay'); })]);
    assert.equal(closed.code, 1008); assert.equal(healthy.ws.readyState, WebSocket.OPEN);
    await control(runtime, host.roomCode, 'release-queue');
    assert.equal((await snapshot(runtime, member)).status, 200);
    const after = await control(runtime, host.roomCode, 'inspect');
    assert.equal(after.records.competition, before.records.competition);
    assert.deepEqual(after.records.wake, before.records.wake); assert.equal(after.alarm, before.alarm);
  } finally {
    if (host) await control(runtime, host.roomCode, 'release-queue');
    for (const client of clients) client.ws.terminate(); await runtime.mf.dispose();
  }
});
