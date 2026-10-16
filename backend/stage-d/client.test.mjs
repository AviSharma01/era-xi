import test from 'node:test';
import assert from 'node:assert/strict';
import { createDraftOffRealtimeClient, DEFAULT_REALTIME_CLIENT_POLICY, parseRoomSnapshot } from './.generated/client.js';

const code = '0123456789AB';
const view = revision => ({ roomId: code, revision, phase: 'LOBBY', participants: [{ participantId: 'p1', displayName: 'Host', role: 'HOST', membershipStatus: 'JOINED' }],
  round: { roundId: 'r1', roundOrdinal: 1, label: 'Draft-Off', eraId: 'era-foundation', phase: 'PENDING' } });
const message = revision => ({ version: 1, type: 'ROOM_SNAPSHOT', serverTimeMs: 1000, view: view(revision) });
const snapshot = revision => ({ ok: true, roomCode: code, participantId: 'p1', settings: { draftMinutes: 15 }, serverTimeMs: 1000,
  view: { ...view(revision), myDraft: { privateSentinel: revision } } });
const response = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 15; i++) await new Promise(resolve => setImmediate(resolve)); };

function setup({ policy = {}, read, events } = {}) {
  let revision = 0, sequence = 0, reads = 0, tickets = 0;
  const timers = new Map(), sockets = [], publicViews = [], privateViews = [], errors = [], requests = [];
  const client = createDraftOffRealtimeClient({ apiOrigin: 'https://api.example', roomCode: code, reconnectCredential: 'C'.repeat(43), policy,
    events,
    onSnapshot: reply => privateViews.push(reply), onPublicSnapshot: reply => publicViews.push(reply), onError: error => errors.push(error), random: () => 0,
    setTimer(callback, delay) { const id = ++sequence; timers.set(id, { callback, delay }); return id; }, clearTimer(id) { timers.delete(id); },
    async transport(url, options) {
      requests.push({ url, options });
      if (url.endsWith('/socket-tickets')) { tickets++; return response({ ok: true, ticket: String(tickets).padStart(43, 'A'), expiresAtMs: 30000 }); }
      reads++; return read ? read(reads, revision) : response(snapshot(revision));
    },
    createSocket(url, protocols) {
      const socket = { url, protocols, protocol: 'draft-off.v1', readyState: 1,
        close(code = 1000) { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.({ code }); },
        sendSnapshot(value) { this.onmessage?.({ data: JSON.stringify(typeof value === 'number' ? message(value) : value) }); },
      };
      sockets.push(socket); return socket;
    },
  });
  return { client, timers, sockets, publicViews, privateViews, errors, requests,
    setRevision(value) { revision = value; }, stats: () => ({ reads, tickets }),
    async fire(delay) { const found = [...timers].find(([, timer]) => timer.delay === delay); assert.ok(found, `Missing timer ${delay}`); timers.delete(found[0]); found[1].callback(); await flush(); },
  };
}

test('message parser strictly whitelists every nested public field', () => {
  assert.deepEqual(parseRoomSnapshot(JSON.stringify(message(1)), code), message(1));
  for (const bad of [
    { ...message(1), version: 2 }, { ...message(1), ticket: 'secret' }, { ...message(1), view: { ...view(1), myDraft: {} } },
    { ...message(1), view: { ...view(1), roomId: 'wrong' } }, { ...message(1), view: { ...view(1), revision: -1 } },
    { ...message(1), view: { ...view(1), participants: [{ ...view(1).participants[0], picks: [] }] } },
    { ...message(1), view: { ...view(1), round: { ...view(1).round, challengeSeed: 'secret' } } },
    { ...message(1), view: { ...view(1), resolution: { trigger: 'DEADLINE', contestStatus: 'NO_CONTEST', resolvedAtMs: 1000,
      eligibleParticipantIds: [], ineligibleParticipantIds: [], leaderboard: [], submission: {} } } },
  ]) assert.throws(() => parseRoomSnapshot(JSON.stringify(bad), code));
  assert.throws(() => parseRoomSnapshot('{', code)); assert.throws(() => parseRoomSnapshot(new ArrayBuffer(8), code));
  assert.throws(() => parseRoomSnapshot(JSON.stringify(message(1)), code, 2));
});

test('GET-connect-GET closes reconnect races without overwriting private state or regressing revisions', async () => {
  const pending = deferred();
  const state = setup({ read: count => count === 2 ? pending.promise : response(snapshot(count === 1 ? 1 : 5)) });
  try {
    await state.client.start(); assert.deepEqual(state.stats(), { reads: 1, tickets: 1 });
    assert.deepEqual(state.sockets[0].protocols, ['draft-off.v1', 'ticket.' + '1'.padStart(43, 'A')]);
    assert.equal(new URL(state.sockets[0].url).search, '');
    state.sockets[0].sendSnapshot(3); state.sockets[0].sendSnapshot(5); state.sockets[0].sendSnapshot(2);
    await flush(); assert.equal(state.stats().reads, 2);
    pending.resolve(response(snapshot(3))); await flush();
    assert.equal(state.stats().reads, 3);
    assert.deepEqual(state.privateViews.map(reply => reply.view.revision), [1, 5]);
    assert.deepEqual(state.publicViews.map(reply => reply.view.revision), [1, 3, 5]);
    assert.equal(state.privateViews.at(-1).view.myDraft.privateSentinel, 5);
    assert.ok(state.publicViews.every(reply => !Object.hasOwn(reply.view, 'myDraft')));
    state.client.observeCommand({ ok: true, changed: true, roomRevision: 2, view: { ...view(2), myDraft: { privateSentinel: 'old receipt' } } });
    await flush(); assert.equal(state.privateViews.at(-1).view.myDraft.privateSentinel, 5);
  } finally { state.client.stop(); }
});

test('a newer HTTP command response withholds an older in-flight GET until reconciliation catches up', async () => {
  const stale = deferred(), current = deferred();
  const state = setup({ read: count => count === 2 ? stale.promise : count === 3 ? current.promise : response(snapshot(count === 1 ? 1 : 5)) });
  try {
    await state.client.start();
    state.sockets[0].sendSnapshot(1); await flush(); // Initial socket snapshot starts the second GET.
    assert.equal(state.stats().reads, 2);
    state.client.observeCommand({ roomRevision: 5 });
    state.client.observeCommand({ roomRevision: 3 }); // Historical receipt cannot lower the target.
    state.sockets[0].sendSnapshot(3); // Above the published revision, but still below the command response.
    assert.deepEqual(state.publicViews.map(reply => reply.view.revision), [1]);
    stale.resolve(response(snapshot(4))); await flush();
    assert.equal(state.stats().reads, 3);
    assert.deepEqual(state.privateViews.map(reply => reply.view.revision), [1]);
    assert.deepEqual(state.publicViews.map(reply => reply.view.revision), [1]);
    current.resolve(response(snapshot(5))); await flush();
    assert.deepEqual(state.privateViews.map(reply => reply.view.revision), [1, 5]);
    assert.deepEqual(state.publicViews.map(reply => reply.view.revision), [1, 5]);
    state.sockets[0].sendSnapshot(4); state.client.observeCommand({ roomRevision: 2 }); await flush();
    assert.ok(state.privateViews.slice(1).every(reply => reply.view.revision === 5));
    assert.ok(state.publicViews.slice(1).every(reply => reply.view.revision === 5));
  } finally { state.client.stop(); }
});

test('HTTP reconciliation accepts snapshots exceeding the realtime frame limit', async () => {
  const maxMessageBytes = 128;
  const state = setup({ policy: { maxMessageBytes } }); state.setRevision(7);
  try {
    assert.ok(new TextEncoder().encode(JSON.stringify(snapshot(7))).byteLength > maxMessageBytes);
    assert.throws(() => parseRoomSnapshot(JSON.stringify(message(7)), code, maxMessageBytes));
    await state.client.start();
    assert.equal(state.privateViews.at(-1)?.view.revision, 7);
    assert.equal(state.publicViews.at(-1)?.view.revision, 7);
    state.sockets[0].sendSnapshot(8); await flush(); // The same size bound still rejects socket frames.
    assert.ok(state.errors.includes('INVALID_REALTIME_MESSAGE'));
    state.setRevision(9); await state.client.resync();
    assert.equal(state.privateViews.at(-1).view.revision, 9);
    assert.equal(state.publicViews.at(-1).view.revision, 9);
    assert.ok(!state.errors.includes('HTTP_RESYNC_FAILED'));
  } finally { state.client.stop(); }
});

test('HTTP transport independently bounds declared and streamed response bodies', async () => {
  for (const length of ['oversized', 'missing', 'understated']) {
    let cancelled = false;
    const bytes = new TextEncoder().encode(JSON.stringify(snapshot(1)));
    const body = new ReadableStream({
      start(controller) { for (let offset = 0; offset < bytes.length; offset += 128) controller.enqueue(bytes.slice(offset, offset + 128)); },
      cancel() { cancelled = true; },
    });
    const state = setup({ policy: { maxHttpResponseBytes: 256, maxMessageBytes: 1024 },
      read: () => new Response(body, { headers: { ...(length === 'missing' ? {} : { 'Content-Length': length === 'oversized' ? String(bytes.length) : '1' }) } }) });
    try {
      await state.client.start();
      assert.equal(state.privateViews.length, 0, length);
      assert.ok(state.errors.includes('HTTP_RESYNC_FAILED'), length);
      assert.equal(cancelled, true, length);
    } finally { state.client.stop(); }
  }
});

test('configurable HTTP fallback converges with zero socket messages; replacement stops reconnect loops', async () => {
  const state = setup({ policy: { reconciliationIntervalMs: 1234 } });
  try {
    await state.client.start(); state.setRevision(4);
    await state.fire(1234); assert.equal(state.privateViews.at(-1).view.revision, 4);
    state.sockets[0].close(4001); await flush();
    assert.equal(state.stats().tickets, 1);
    assert.ok([...state.timers.values()].some(timer => timer.delay === 1234));
    assert.ok(![...state.timers.values()].some(timer => timer.delay === DEFAULT_REALTIME_CLIENT_POLICY.reconnectInitialMs));
    state.setRevision(8); await state.fire(1234); assert.equal(state.privateViews.at(-1).view.revision, 8);
  } finally { state.client.stop(); }
  assert.equal(state.timers.size, 0);
});

test('transient disconnect obtains a fresh ticket; stale socket callbacks and stopped fetches are ignored', async () => {
  const state = setup();
  await state.client.start(); const first = state.sockets[0];
  first.close(1006); await flush();
  await state.fire(500); assert.equal(state.stats().tickets, 2);
  first.sendSnapshot(99); assert.ok(!state.publicViews.some(reply => reply.view.revision === 99));
  state.client.stop(); state.sockets[1].sendSnapshot(100); await flush();
  assert.ok(!state.publicViews.some(reply => reply.view.revision === 100)); assert.equal(state.timers.size, 0);
  const pending = deferred(); const late = setup({ read: () => pending.promise });
  const started = late.client.start(); late.client.stop(); pending.resolve(response(snapshot(1))); await started;
  assert.equal(late.privateViews.length, 0); assert.equal(late.stats().tickets, 0);
});

test('bad socket data cannot change private state; HTTP remains usable after socket policy failure', async () => {
  const state = setup();
  try {
    await state.client.start(); state.sockets[0].sendSnapshot({ ...message(999), view: { ...view(999), myDraft: { stolen: true } } });
    await flush(); assert.ok(state.errors.includes('INVALID_REALTIME_MESSAGE'));
    state.setRevision(2); await state.client.resync(); assert.equal(state.privateViews.at(-1).view.myDraft.privateSentinel, 2);
    assert.equal(state.stats().tickets, 1);
  } finally { state.client.stop(); }
});

test('terminal HTTP state stops polling and invalid credentials stop the transport', async () => {
  const terminal = snapshot(1); terminal.view.phase = 'COMPLETE';
  const state = setup({ read: () => response(terminal) }); await state.client.start();
  assert.equal(state.stats().tickets, 0); assert.equal(state.timers.size, 0); state.client.stop();
  const unauthorized = setup({ read: () => new Response('{}', { status: 401 }) }); await unauthorized.client.start();
  assert.equal(unauthorized.stats().tickets, 0); assert.ok(unauthorized.errors.includes('AUTHENTICATION_FAILED')); assert.equal(unauthorized.timers.size, 0);
});

test('focus/online and one deadline timer resync independently of periodic polling', async () => {
  const handlers = new Map();
  const events = { addEventListener(type, handler) { handlers.set(type, handler); }, removeEventListener(type) { handlers.delete(type); } };
  const drafting = snapshot(1); drafting.view.phase = 'IN_PROGRESS';
  drafting.view.round = { ...drafting.view.round, phase: 'DRAFTING', startedAtMs: 500, deadlineAtMs: 3000 };
  let current = drafting;
  const state = setup({ events, read: () => response(current), policy: { reconciliationIntervalMs: 60000 } });
  try {
    await state.client.start(); assert.equal(handlers.size, 2);
    const initialReads = state.stats().reads;
    handlers.get('focus')(); await flush(); handlers.get('online')(); await flush();
    assert.equal(state.stats().reads, initialReads + 2);
    await state.fire(2000); assert.equal(state.stats().reads, initialReads + 3);
    assert.ok(![...state.timers.values()].some(timer => timer.delay === 2000));
    const complete = snapshot(2); complete.view.phase = 'COMPLETE'; current = complete;
    handlers.get('focus')(); await flush();
    assert.ok(![...state.timers.values()].some(timer => timer.delay === 60000));
  } finally { state.client.stop(); }
  assert.equal(handlers.size, 0);
});
