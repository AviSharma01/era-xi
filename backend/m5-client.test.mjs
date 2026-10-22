import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from './stage-a/node_modules/ws/wrapper.mjs';
import { startRuntime } from './stage-d/runtime.mjs';
import { enrollGuest } from '../dist/draftOffEnrollmentClient.js';
import { createDraftOffSession, readDraftOffCredential } from '../dist/draftOffSession.js';
import { createDraftOffTransport } from '../dist/draftOffClientTransport.js';

const origin = 'http://127.0.0.1:5173';
const storage = () => { const rows = new Map(); return { rows, getItem: key => rows.get(key) ?? null,
  setItem: (key, value) => rows.set(key, value), removeItem: key => rows.delete(key) }; };
async function until(predicate) {
  const end = Date.now() + 15000;
  while (!predicate()) { assert.ok(Date.now() < end, 'Local client did not converge'); await new Promise(resolve => setTimeout(resolve, 20)); }
}

test('M5.1 production local backend: enrollment loss, refresh journals, revisions, privacy and persisted restart', { timeout: 90000 }, async () => {
  process.chdir(fileURLToPath(new URL('stage-d/', import.meta.url)));
  const path = mkdtempSync(join(tmpdir(), 'draft-off-m5-client-')), clients = [];
  let runtime;
  // Automated test bursts only; interactive development retains unchanged defaults.
  const options = { production: true, overrides: { readBurst: 100, readsPerMinute: 1000, commandBurst: 100, commandsPerMinute: 1000,
    ticketBurst: 50, ticketsPerMinute: 100, roomTicketBurst: 100, roomTicketsPerMinute: 1000 },
    bindings: { ALLOWED_ORIGINS: JSON.stringify([origin]) } };
  const send = async (input, init) => {
    const headers = new Headers(init?.headers); headers.set('Origin', origin); headers.set('CF-Connecting-IP', '127.0.0.1');
    return fetch(input, { ...init, headers });
  };
  const enroll = async (operation, code, input, saved, lost = false) => {
    let lose = lost;
    return enrollGuest(runtime.url.origin, operation, code, input, saved, async (url, init) => {
      const reply = await send(url, init);
      if (lose && reply.status === 201) { lose = false; await reply.body.cancel(); throw new Error('deliberately lost enrollment reply'); }
      return reply;
    });
  };
  function session(code, saved, journal = storage(), loseCommand = false) {
    let state, lose = loseCommand;
    const bodies = [];
    const transport = createDraftOffTransport({ fetch: async (url, init) => {
      if (String(url).endsWith('/commands')) bodies.push(init.body);
      const response = await send(url, init);
      if (lose && String(url).endsWith('/commands') && response.status === 200) {
        lose = false; await response.body.cancel(); throw new Error('deliberately lost committed reply');
      }
      return response;
    } });
    const client = createDraftOffSession({ apiOrigin: runtime.url.origin, roomCode: code,
      credential: readDraftOffCredential(saved, code), journalStorage: journal, transport,
      realtime: { createSocket: (url, protocols) => new WebSocket(url, protocols, { headers: { Origin: origin, 'CF-Connecting-IP': '127.0.0.1' } }) },
      onChange: next => { state = next; } });
    clients.push(client); return { client, state: () => state, journal, bodies };
  }
  try {
    runtime = await startRuntime(path, options);
    const hostStorage = storage(), memberStorage = storage();
    const input = { displayName: 'Local Host', eraId: 'era-foundation', draftMinutes: 15 };
    await assert.rejects(enroll('CREATE', undefined, input, hostStorage, true), /lost enrollment/);
    const pending = hostStorage.getItem('draft-off:pending:CREATE:'); assert.ok(pending);
    const host = await enroll('CREATE', undefined, input, hostStorage);
    assert.equal(host.status, 201); assert.equal(hostStorage.getItem('draft-off:pending:CREATE:'), null);
    const code = host.body.roomCode;
    const member = await enroll('JOIN', code, { displayName: 'Local Guest' }, memberStorage);
    assert.equal(member.status, 201);
    assert.notEqual(host.body.participantId, member.body.participantId);
    const guest = session(code, memberStorage, storage(), true); await guest.client.start();
    await guest.client.command({ type: 'LEAVE' }); assert.equal(guest.state().pending, true);
    const journal = [...guest.journal.rows.values()][0]; assert.ok(journal); guest.client.stop();
    const restored = session(code, memberStorage, guest.journal); await restored.client.start();
    assert.equal(restored.bodies[0], JSON.stringify(JSON.parse(journal).envelope));
    assert.equal(restored.state().pending, false);
    assert.equal(restored.state().snapshot.view.participants.find(p => p.participantId === member.body.participantId).membershipStatus, 'LEFT');
    await restored.client.command({ type: 'REJOIN' });
    const owner = session(code, hostStorage); await owner.client.start();
    assert.equal(owner.state().snapshot.view.participants.length, 2);
    await owner.client.command({ type: 'START' });
    await restored.client.resync();
    await Promise.all([owner.client.command({ type: 'SPIN' }), restored.client.command({ type: 'SPIN' })]);
    assert.ok(owner.state().snapshot.view.myDraft.candidates.length);
    const guestDraft = structuredClone(restored.state().snapshot.view.myDraft);
    const privateRevision = owner.state().snapshot.view.myDraft.revision;
    const candidate = owner.state().snapshot.view.myDraft.candidates.find(p => p.positions.some(slot => slot.available));
    const position = candidate.positions.find(slot => slot.available).battingPosition;
    await owner.client.command({ type: 'LOCK_PLAYER', playerTeamSeasonId: candidate.playerTeamSeasonId, battingPosition: position });
    const envelope = JSON.parse(owner.bodies.at(-1));
    assert.equal(envelope.expectedDraftRevision, privateRevision); assert.equal(envelope.expectedRoomRevision, undefined);
    await restored.client.resync();
    assert.deepEqual(restored.state().snapshot.view.myDraft, guestDraft);
    assert.ok(restored.state().snapshot.view.participants.every(p => !('picks' in p) && !('myDraft' in p)));
    const before = structuredClone(owner.state().snapshot.view.myDraft);
    clients.forEach(client => client.stop());
    await runtime.mf.dispose(); runtime = await startRuntime(path, options);
    const restarted = session(code, hostStorage); await restarted.client.start();
    await until(() => restarted.state()?.snapshot);
    assert.deepEqual(restarted.state().snapshot.view.myDraft, before);
    assert.equal(restarted.state().snapshot.participantId, host.body.participantId);
  } finally { clients.forEach(client => client.stop()); await runtime?.mf.dispose(); rmSync(path, { recursive: true, force: true }); }
});
