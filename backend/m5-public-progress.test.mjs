import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from './stage-a/node_modules/ws/wrapper.mjs';
import { startRuntime, origin } from './stage-d/runtime.mjs';
import { DEFAULT_LIMITS } from './stage-d/.generated/limits.js';
import { enrollGuest } from '../dist/draftOffEnrollmentClient.js';
import { createDraftOffSession, readDraftOffCredential } from '../dist/draftOffSession.js';
import { createDraftOffTransport } from '../dist/draftOffClientTransport.js';
import { parseRoomSnapshot, DEFAULT_REALTIME_CLIENT_POLICY } from '../dist/draftOffRealtimeClient.js';
import { legalLock } from './stage-a/runtime.mjs';

const storage = () => { const rows = new Map(); return { rows, getItem: key => rows.get(key) ?? null,
  setItem: (key, value) => rows.set(key, value), removeItem: key => rows.delete(key) }; };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 10000) {
  const end = Date.now() + timeout;
  while (!check()) { assert.ok(Date.now() < end, 'Session did not converge'); await delay(10); }
}

test('eight real sessions: opponent progress consumes no private READs under default production limits', { timeout: 60000 }, async () => {
  process.chdir(fileURLToPath(new URL('stage-d/', import.meta.url)));
  assert.equal(DEFAULT_LIMITS.outstandingOperations, 16);
  assert.equal(DEFAULT_LIMITS.readBurst, 10);
  assert.equal(DEFAULT_LIMITS.readsPerMinute, 60);
  assert.equal(DEFAULT_REALTIME_CLIENT_POLICY.reconciliationIntervalMs, 15000);
  const path = mkdtempSync(join(tmpdir(), 'draft-off-public-defaults-'));
  // Deliberately independent from the accelerated gameplay fixture: no overrides,
  // including command, READ, admission, edge, socket or client timer policies.
  const runtime = await startRuntime(path, { production: true });
  const entries = [], allClients = [], replies = [];
  let code, stage = 'enrollment';
  const send = async (url, init, ip) => {
    const headers = new Headers(init?.headers); headers.set('Origin', origin); headers.set('CF-Connecting-IP', ip);
    const requestStage = stage;
    const reply = await fetch(url, { ...init, headers });
    const route = new URL(url).pathname.split('/').at(-1);
    replies.push({ status: reply.status, stage: requestStage, route: route === code ? 'room' : route, ip }); return reply;
  };
  const count = (entry, participantId) => entry.client.getState().publicSnapshot?.view.participants
    .find(row => row.participantId === participantId)?.lockedPickCount;
  const current = entry => entry.client.getState().snapshot.view;
  const ready = async entry => {
    await until(() => !entry.client.getState().pending || entry.client.getState().retryAvailable);
    assert.equal(entry.client.getState().pending, false, entry.client.getState().error ?? 'Pending action');
  };
  function connect(entry) {
    const client = createDraftOffSession({ apiOrigin: runtime.url.origin, roomCode: code,
      credential: entry.credential, credentialStorage: entry.saved, journalStorage: entry.journal, onChange() {},
      transport: createDraftOffTransport({ fetch: async (url, init) => {
        const read = new URL(url).pathname === `/api/draft-off/v1/rooms/${code}`;
        if (read) {
          entry.reads++;
          if (entry.holdReads) await new Promise(resolve => entry.held.push(resolve));
        }
        const command = String(url).endsWith('/commands');
        if (command) entry.bodies.push(init.body);
        const reply = await send(url, init, entry.ip);
        if (command && entry.loseLock && JSON.parse(init.body).command.type === 'LOCK_PLAYER' && reply.status === 200) {
          entry.loseLock = false; await reply.body.cancel(); throw new Error('Lost committed LOCK response');
        }
        return reply;
      } }),
      realtime: { events: { addEventListener() {}, removeEventListener() {} }, createSocket: (url, protocols) => {
        const socket = new WebSocket(url, protocols, { headers: { Origin: origin, 'CF-Connecting-IP': entry.ip } });
        entry.socket = socket;
        socket.on('message', bytes => {
          const message = parseRoomSnapshot(bytes.toString(), code);
          entry.frames.push(message);
          const scan = value => {
            if (!value || typeof value !== 'object') return;
            for (const [key, nested] of Object.entries(value)) {
              assert.ok(!['myDraft', 'draftState', 'picks', 'candidates', 'playerId', 'playerTeamSeasonId', 'battingPosition',
                'currentSpin', 'seeds', 'rootSeed', 'evaluation', 'battingRating', 'bowlingRating', 'qualityTier'].includes(key), key);
              scan(nested);
            }
          };
          scan(message);
        });
        return socket;
      } },
    });
    entry.client = client; allClients.push(client); return client;
  }
  try {
    for (let index = 0; index < 8; index++) {
      const saved = storage(), ip = `198.18.1.${index + 1}`;
      const result = await enrollGuest(runtime.url.origin, index === 0 ? 'CREATE' : 'JOIN', code,
        index === 0 ? { displayName: 'Idle host', eraId: 'era-foundation', draftMinutes: 10 } : { displayName: `Opponent ${index}` },
        saved, (url, init) => send(url, init, ip));
      assert.equal(result.status, 201); code = result.body.roomCode;
      entries.push({ saved, ip, credential: readDraftOffCredential(saved, code), journal: storage(), reads: 0,
        frames: [], bodies: [], held: [], holdReads: false, loseLock: false });
    }
    stage = 'initial load';
    for (const entry of entries) await connect(entry).start();
    const idle = entries[0];
    await idle.client.command({ type: 'START' }); await ready(idle);
    await until(() => entries.every(entry => current(entry).phase === 'IN_PROGRESS'
      && entry.client.getState().publicSnapshot?.view.round.phase === 'DRAFTING'));
    await delay(50); // Drain initial/reconnect and START reconciliation before measuring.
    const baselineReads = idle.reads, privateBefore = current(idle).myDraft, authenticatedBefore = idle.client.getState().snapshot;
    const beforeMs = Date.now();
    stage = 'opponent locks';
    for (let pick = 0; pick < 2; pick++) {
      for (const actor of entries.slice(1)) {
        await actor.client.command({ type: 'SPIN' }); await ready(actor);
        await actor.client.command(legalLock(current(actor))); await ready(actor);
        await until(() => entries.every(entry => count(entry, actor.credential.participantId) === pick + 1));
      }
    }
    assert.ok(Date.now() - beforeMs < 15000, 'Opponent burst must finish before the default fallback tick');
    assert.equal(idle.reads, baselineReads, 'Opponent locks must issue zero idle private GETs');
    assert.strictEqual(idle.client.getState().snapshot, authenticatedBefore);
    assert.strictEqual(current(idle).myDraft, privateBefore);
    assert.equal(idle.client.getState().pending, false);
    assert.notEqual(idle.client.getState().retryAvailable, true);
    assert.ok(entries.every(entry => entries.slice(1).every(actor => count(entry, actor.credential.participantId) === 2)));

    // A fresh session must still authenticate its private state and close the
    // reconnect race even though ordinary opponent progress no longer GETs.
    stage = 'reconnect';
    const resumed = idle; resumed.client.stop();
    await connect(resumed).start();
    await until(() => count(resumed, entries[1].credential.participantId) === 2);
    assert.equal(current(resumed).myDraft.picks.length, 0);

    const offline = entries[7], offlineReads = offline.reads, offlineBefore = offline.client.getState().snapshot;
    // A server policy close disables socket reconnection while preserving the
    // existing HTTP fallback. No shortened timer or custom client policy.
    offline.socket.send('unsupported application frame');
    await until(() => offline.socket.readyState === WebSocket.CLOSED);
    await until(() => offline.reads > offlineReads);
    await until(() => offline.client.getState().snapshot !== offlineBefore);
    stage = 'own recovery';
    await idle.client.command({ type: 'SPIN' }); await ready(idle);
    assert.equal(current(idle).myDraft.phase, 'AWAITING_PICK');
    const ownBefore = current(idle).myDraft;
    idle.holdReads = true; idle.loseLock = true;
    await idle.client.command(legalLock(current(idle)));
    await until(() => count(idle, idle.credential.participantId) === 1);
    assert.strictEqual(current(idle).myDraft, ownBefore, 'Public own count cannot replace private draft');
    assert.equal(idle.client.getState().pending, true);
    assert.equal(idle.journal.rows.size, 1);
    const original = idle.bodies.at(-1);
    idle.holdReads = false; idle.held.splice(0).forEach(resolve => resolve());
    await until(() => current(idle).myDraft.picks.length === 1);
    assert.equal(idle.client.getState().pending, true, 'HTTP snapshot alone cannot confirm a lost command receipt');
    await idle.client.retry(); await ready(idle);
    assert.equal(idle.bodies.at(-1), original);
    assert.equal(idle.journal.rows.size, 0);
    assert.equal(current(idle).myDraft.picks.length, 1);
    stage = 'fallback';
    await until(() => count(offline, idle.credential.participantId) === 1, 20000);
    assert.equal(offline.socket.readyState, WebSocket.CLOSED);
    assert.ok(offline.reads <= offlineReads + 2, 'Disconnected client uses close recovery plus existing fallback');
    assert.deepEqual(replies.filter(reply => reply.status === 429), [],
      `Default limits throttled a request; READ totals: ${entries.map(entry => entry.reads).join(',')}`);
    assert.ok(entries.every(entry => !entry.client.getState().error && !entry.client.getState().pending));
  } finally {
    for (const entry of entries) { entry.holdReads = false; entry.held.splice(0).forEach(resolve => resolve()); }
    allClients.forEach(client => client.stop()); await runtime.mf.dispose(); rmSync(path, { recursive: true, force: true });
  }
});
