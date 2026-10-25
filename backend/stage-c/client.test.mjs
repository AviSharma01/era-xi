import test from 'node:test';
import assert from 'node:assert/strict';
import { enrollGuest } from './.generated/client.js';
const storage = () => { const rows = new Map(); return { rows, getItem: key => rows.get(key) ?? null,
  setItem: (key, value) => rows.set(key, value), removeItem: key => rows.delete(key) }; };
const code = '0123456789AB';
const failure = (status, code) => Response.json({ ok: false, error: { code } }, { status });

test('definitive CREATE/JOIN rejection permits corrected input with a fresh enrollment key', async () => {
  for (const [operation, status, rejectionCode] of [['CREATE', 400, 'INVALID_REQUEST'], ['CREATE', 413, 'PAYLOAD_TOO_LARGE'],
    ['JOIN', 409, 'DISPLAY_NAME_RESERVED'], ['JOIN', 409, 'PARTICIPANT_LIMIT'],
    ['JOIN', 409, 'INVALID_PHASE'], ['JOIN', 404, 'ROOM_UNAVAILABLE']]) {
    const saved = storage(), keys = [], inputs = [];
    const send = async (_url, request) => {
      keys.push(request.headers['Enrollment-Key']); inputs.push(JSON.parse(request.body));
      return keys.length === 1 ? failure(status, rejectionCode)
        : Response.json({ ok: true, roomCode: code, participantId: 'p1', reconnectCredential: 'C'.repeat(43) }, { status: 201 });
    };
    await enrollGuest('https://api.example', operation, operation === 'JOIN' ? code : undefined, { displayName: 'Taken' }, saved, send);
    const corrected = await enrollGuest('https://api.example', operation, operation === 'JOIN' ? code : undefined, { displayName: 'Available' }, saved, send);
    assert.equal(corrected.status, 201); assert.notEqual(keys[0], keys[1]);
    assert.equal(inputs[1].displayName, 'Available'); assert.equal(saved.rows.size, 1);
  }
});

test('uncertain enrollment outcomes preserve exact input/key including credential-storage failure', async () => {
  for (const outcome of ['lost', '503', '429', 'conflict', 'bad-json', 'storage']) {
    const saved = storage(); let sent;
    const send = async (_url, request) => {
      sent = request.headers['Enrollment-Key'];
      if (outcome === 'lost') throw new Error('Response lost');
      if (outcome === 'bad-json') return new Response('{', { status: 503 });
      if (outcome === 'storage') return Response.json({ ok: true, roomCode: code, participantId: 'p1', reconnectCredential: 'C'.repeat(43) }, { status: 201 });
      return failure(outcome === '503' ? 503 : outcome === '429' ? 429 : 409,
        outcome === 'conflict' ? 'ENROLLMENT_KEY_CONFLICT' : 'TEMPORARY_UNAVAILABLE');
    };
    const broken = { ...saved, setItem(key, value) { if (outcome === 'storage' && key.startsWith('draft-off:credential:')) throw new Error('Storage failed'); saved.setItem(key, value); } };
    await enrollGuest('https://api.example', 'JOIN', code, { displayName: 'Original' }, broken, send).catch(() => {});
    const pending = JSON.parse(saved.getItem('draft-off:pending:JOIN:' + code));
    assert.equal(pending.key, sent); assert.equal(pending.input, JSON.stringify({ displayName: 'Original' }));
    await assert.rejects(enrollGuest('https://api.example', 'JOIN', code, { displayName: 'Changed' }, saved, send), /Pending enrollment/);
    await enrollGuest('https://api.example', 'JOIN', code, { displayName: 'Original' }, saved, async (_url, request) => {
      assert.equal(request.headers['Enrollment-Key'], sent);
      return Response.json({ ok: true, roomCode: code, participantId: 'p1', reconnectCredential: 'C'.repeat(43) }, { status: 201 });
    });
    assert.equal(saved.getItem('draft-off:pending:JOIN:' + code), null);
  }
});


const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const enrollmentSuccess = (participantId = 'corrected') => Response.json({ ok: true, roomCode: code, participantId,
  reconnectCredential: (participantId === 'old' ? 'A' : 'C').repeat(43) }, { status: 201 });

test('a delayed old rejection cannot delete corrected enrollment recovery after response loss', async () => {
  for (const operation of ['CREATE', 'JOIN']) {
    const saved = storage(), requests = [], room = operation === 'JOIN' ? code : undefined;
    const slot = `draft-off:pending:${operation}:${room ?? ''}`;
    const send = (_url, request) => { const pending = deferred(); requests.push({ ...pending, request }); return pending.promise; };
    const original = operation === 'CREATE' ? { displayName: 'Host', eraId: 'invalid' } : { displayName: 'Taken' };
    const corrected = operation === 'CREATE' ? { displayName: 'Host', eraId: 'era-foundation' } : { displayName: 'Available' };
    const first = enrollGuest('https://api.example', operation, room, original, saved, send);
    const duplicate = enrollGuest('https://api.example', operation, room, original, saved, send);
    assert.equal(requests[0].request.headers['Enrollment-Key'], requests[1].request.headers['Enrollment-Key']);
    const reject = () => failure(operation === 'CREATE' ? 400 : 409, operation === 'CREATE' ? 'INVALID_REQUEST' : 'DISPLAY_NAME_RESERVED');
    requests[0].resolve(reject()); await first;
    const next = enrollGuest('https://api.example', operation, room, corrected, saved, send);
    const nextPending = saved.getItem(slot), nextKey = requests[2].request.headers['Enrollment-Key'];
    assert.notEqual(nextKey, requests[0].request.headers['Enrollment-Key']);
    requests[1].resolve(reject()); await duplicate;
    assert.ok(saved.getItem(slot) === nextPending, 'Delayed rejection must preserve the newer attempt');
    requests[2].reject(new Error('Corrected enrollment committed but response lost')); await assert.rejects(next, /response lost/);
    const retry = enrollGuest('https://api.example', operation, room, corrected, saved, send);
    assert.equal(requests[3].request.headers['Enrollment-Key'], nextKey);
    assert.equal(requests[3].request.body, requests[2].request.body);
    requests[3].resolve(enrollmentSuccess()); await retry;
    assert.equal(saved.getItem(slot), null);
    assert.equal(JSON.parse(saved.getItem('draft-off:credential:' + code)).participantId, 'corrected');
  }
});

test('stale success and collision responses cannot mutate a newer pending attempt or its credentials', async () => {
  for (const outcome of ['success', 'collision']) {
    const saved = storage(), requests = [], slot = 'draft-off:pending:CREATE:';
    const send = (_url, request) => { const pending = deferred(); requests.push({ ...pending, request }); return pending.promise; };
    const input = { displayName: 'Host' };
    const first = enrollGuest('https://api.example', 'CREATE', undefined, input, saved, send);
    const oldRetry = enrollGuest('https://api.example', 'CREATE', undefined, input, saved, send);
    requests[0].resolve(failure(409, 'ROOM_CODE_COLLISION')); await first;
    const currentPending = saved.getItem(slot);
    const next = enrollGuest('https://api.example', 'CREATE', undefined, input, saved, send);
    const credentialSlot = 'draft-off:credential:' + code;
    if (outcome === 'success') saved.setItem(credentialSlot, JSON.stringify({ participantId: 'newer-identity', reconnectCredential: 'C'.repeat(43) }));
    const credentialsBefore = saved.getItem(credentialSlot);
    requests[1].resolve(outcome === 'success' ? enrollmentSuccess('old') : failure(409, 'ROOM_CODE_COLLISION')); await oldRetry;
    assert.ok(saved.getItem(slot) === currentPending, 'Newer pending attempt must remain unchanged');
    assert.ok(saved.getItem(credentialSlot) === credentialsBefore, 'Stale success must not overwrite credentials');
    requests[2].reject(new Error('Lost response')); await assert.rejects(next, /Lost response/);
    assert.ok(saved.getItem(slot) === currentPending, 'Newer pending attempt must remain unchanged');
  }
});

test('ROOM_CODE_UNAVAILABLE preserves the CREATE attempt and never silently rotates or clears its key', async () => {
  const saved = storage(), keys = [], input = { displayName: 'Host' };
  const send = async (_url, request) => { keys.push(request.headers['Enrollment-Key']); return failure(409, 'ROOM_CODE_UNAVAILABLE'); };
  await enrollGuest('https://api.example', 'CREATE', undefined, input, saved, send);
  const pending = saved.getItem('draft-off:pending:CREATE:'); assert.ok(pending);
  await enrollGuest('https://api.example', 'CREATE', undefined, input, saved, send);
  assert.equal(keys[0], keys[1]); assert.equal(saved.getItem('draft-off:pending:CREATE:'), pending);
  await assert.rejects(enrollGuest('https://api.example', 'CREATE', undefined, { displayName: 'Changed' }, saved, send), /Pending enrollment/);
});


test('conflicting JOIN success and delayed duplicates preserve the established identity and exact recovery', async () => {
  const saved = storage(), requests = [], slot = 'draft-off:pending:JOIN:' + code;
  const send = (_url, request) => { const pending = deferred(); requests.push({ ...pending, request }); return pending.promise; };
  const first = enrollGuest('https://api.example', 'JOIN', code, { displayName: 'Old' }, saved, send);
  const duplicate = enrollGuest('https://api.example', 'JOIN', code, { displayName: 'Old' }, saved, send);
  requests[0].resolve(enrollmentSuccess('old')); await first;
  const credentials = saved.getItem('draft-off:credential:' + code);
  const newer = enrollGuest('https://api.example', 'JOIN', code, { displayName: 'New' }, saved, send);
  const pending = saved.getItem(slot);
  requests[2].resolve(enrollmentSuccess()); await newer;
  requests[1].resolve(enrollmentSuccess('old')); await duplicate;
  assert.equal(saved.getItem(slot), pending);
  assert.ok(saved.getItem('draft-off:credential:' + code) === credentials, 'Conflicting or stale success must preserve the established identity');
});

test('credential-storage side effects cannot clear a pending attempt installed during success handling', async () => {
  const saved = storage(), slot = 'draft-off:pending:JOIN:' + code;
  const newer = JSON.stringify({ key: 'N'.repeat(43), input: JSON.stringify({ displayName: 'New' }) });
  const changing = { ...saved, setItem(key, value) {
    saved.setItem(key, value);
    if (key.startsWith('draft-off:credential:')) saved.setItem(slot, newer);
  } };
  await enrollGuest('https://api.example', 'JOIN', code, { displayName: 'Old' }, changing, async () => enrollmentSuccess('old'));
  assert.ok(saved.getItem(slot) === newer, 'Success cleanup must recheck attempt ownership');
});
