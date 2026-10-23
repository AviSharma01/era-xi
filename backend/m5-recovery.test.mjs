import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRuntime, control, origin } from './stage-d/runtime.mjs';
import { enrollGuest } from '../dist/draftOffEnrollmentClient.js';
import { createDraftOffSession, readDraftOffCredential } from '../dist/draftOffSession.js';
import { createDraftOffTransport } from '../dist/draftOffClientTransport.js';

const storage = () => { const rows = new Map(); return { rows, getItem: key => rows.get(key) ?? null,
  setItem: (key, value) => rows.set(key, value), removeItem: key => rows.delete(key) }; };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(production, run) {
  process.chdir(fileURLToPath(new URL('stage-d/', import.meta.url)));
  const path = mkdtempSync(join(tmpdir(), 'draft-off-m54-')), clients = [];
  const options = { production, overrides: { requestsPerMinute: 50000, readBurst: 1000, readsPerMinute: 5000,
    commandBurst: 1000, commandsPerMinute: 5000, ticketBurst: 100, ticketsPerMinute: 1000,
    roomTicketBurst: 1000, roomTicketsPerMinute: 5000, pendingTicketsPerParticipant: 100, pendingTicketsPerRoom: 200 } };
  let runtime = await startRuntime(path, options), code;
  const send = (url, init) => {
    const headers = new Headers(init?.headers); headers.set('Origin', origin); headers.set('CF-Connecting-IP', '198.18.0.54');
    return fetch(url, { ...init, headers });
  };
  async function enroll(name, host = false) {
    const saved = storage();
    const reply = await enrollGuest(runtime.url.origin, host ? 'CREATE' : 'JOIN', host ? undefined : code,
      host ? { displayName: name, eraId: 'era-foundation', draftMinutes: 10 } : { displayName: name }, saved, send);
    assert.equal(reply.status, 201); if (host) code = reply.body.roomCode; return saved;
  }
  function connect(saved, { journal = storage(), commandResponse, timeoutMs } = {}) {
    const bodies = [], replies = [];
    const transport = createDraftOffTransport({ timeoutMs, fetch: async (url, init) => {
      const command = String(url).endsWith('/commands'); if (command) bodies.push(init.body);
      const reply = await send(url, init);
      if (command) {
        replies.push(await reply.clone().json());
        if (commandResponse) return commandResponse(reply, url, init);
      }
      return reply;
    } });
    const client = createDraftOffSession({ apiOrigin: runtime.url.origin, roomCode: code,
      credential: readDraftOffCredential(saved, code), credentialStorage: saved, journalStorage: journal, transport, onChange() {},
      realtime: { events: { addEventListener() {}, removeEventListener() {} },
        createSocket: () => { throw new Error('offline realtime; existing HTTP fallback remains authoritative'); } } });
    clients.push(client); return { client, journal, bodies, replies, state: client.getState };
  }
  const api = { enroll, connect, send, get runtime() { return runtime; }, get code() { return code; },
    async restart() { clients.forEach(client => client.stop()); await runtime.mf.dispose(); runtime = await startRuntime(path, options); } };
  try { await run(api); }
  finally { clients.forEach(client => client.stop()); await runtime.mf.dispose(); rmSync(path, { recursive: true, force: true }); }
}

test('M5.4 production: same-credential tabs, duplicate commit, stalled body timeout and exact recovery after process restart', { timeout: 90000 },
  () => fixture(true, async api => {
    const saved = await api.enroll('Shared host', true); await api.enroll('Independent guest');
    const starter = api.connect(saved); await starter.client.start(); await starter.client.command({ type: 'START' }); starter.client.stop();
    const committed = deferred(); let cancelled = false, duplicateBody;
    const first = api.connect(saved, { timeoutMs: 2000, commandResponse: async (reply, url, init) => {
      assert.equal(reply.status, 200);
      const duplicate = await api.send(url, init);
      duplicateBody = await duplicate.json(); assert.deepEqual(duplicateBody, first.replies[0]);
      await reply.body.cancel(); committed.resolve();
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 200 });
    } });
    const second = api.connect(saved);
    await first.client.start(); await second.client.start();
    const before = first.state().snapshot.view.myDraft.revision;
    const uncertain = first.client.command({ type: 'SPIN' }); await committed.promise;
    // The second tab still owns the same pre-command draft revision.
    await second.client.command({ type: 'SPIN' }); await uncertain;
    assert.equal(second.replies[0].error.code, 'STALE_DRAFT_REVISION');
    assert.equal(second.state().pending, false);
    assert.equal(second.state().snapshot.view.myDraft.revision, before + 1);
    assert.equal(first.state().pending, true); assert.equal(first.state().retryAvailable, true); assert.equal(cancelled, true);
    const original = first.bodies[0], frozen = structuredClone(second.state().snapshot.view.myDraft), journal = first.journal;
    assert.equal(JSON.parse([...journal.rows.values()][0]).envelope.commandId, JSON.parse(original).commandId);
    assert.equal(JSON.parse(original).expectedDraftRevision, before);
    await api.restart();
    const recovered = api.connect(saved, { journal }); await recovered.client.start();
    assert.ok(recovered.state().snapshot, recovered.state().error ?? 'Missing restored snapshot');
    assert.equal(recovered.bodies[0], original, recovered.state().error ?? 'Missing exact replay');
    assert.deepEqual(recovered.replies[0], duplicateBody);
    assert.deepEqual(recovered.state().snapshot.view.myDraft, frozen); assert.equal(recovered.state().pending, false);
    assert.equal(journal.rows.size, 0);
    const otherTab = api.connect(saved); await otherTab.client.start();
    assert.deepEqual(otherTab.state().snapshot.view.myDraft, frozen);
    const fixtureRoute = await api.send(new URL(`/__test/${api.code}/inspect`, api.runtime.url), { method: 'POST', body: '{}' });
    assert.equal(fixtureRoute.status, 404);
  }));

test('M5.4 native: delayed pre-deadline receipt cannot restore drafting after authoritative NO_CONTEST resolution', { timeout: 90000 },
  () => fixture(false, async api => {
    const saved = await api.enroll('Delayed host', true); await api.enroll('Incomplete guest');
    const starter = api.connect(saved); await starter.client.start(); await starter.client.command({ type: 'START' }); starter.client.stop();
    const committed = deferred(), release = deferred();
    const player = api.connect(saved, { commandResponse: async reply => { committed.resolve(); await release.promise; return reply; } });
    await player.client.start();
    const pending = player.client.command({ type: 'SPIN' }); await committed.promise;
    const deadline = player.state().snapshot.view.round.deadlineAtMs;
    await control(api.runtime, api.code, 'offset', { offset: deadline - Date.now() + 1 });
    await player.client.resync();
    const resolution = structuredClone(player.state().snapshot.view.resolution);
    assert.equal(resolution.contestStatus, 'NO_CONTEST'); assert.equal(resolution.trigger, 'DEADLINE');
    assert.equal(resolution.ineligibleParticipantIds.length, 2);
    release.resolve(); await pending;
    assert.equal(player.state().snapshot.view.phase, 'COMPLETE');
    assert.deepEqual(player.state().snapshot.view.resolution, resolution);
    assert.equal(player.state().pending, false); assert.equal(player.journal.rows.size, 0);
    await api.restart(); const restored = api.connect(saved); await restored.client.start();
    assert.deepEqual(restored.state().snapshot.view.resolution, resolution);
  }));
