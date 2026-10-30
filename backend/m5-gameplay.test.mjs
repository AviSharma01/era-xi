import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from './stage-a/node_modules/ws/wrapper.mjs';
import { startRuntime, control } from './stage-d/runtime.mjs';
import { enrollGuest } from '../dist/draftOffEnrollmentClient.js';
import { createDraftOffSession, readDraftOffCredential } from '../dist/draftOffSession.js';
import { createDraftOffTransport } from '../dist/draftOffClientTransport.js';
const origin = 'https://frontend.example';
const storage = () => { const rows = new Map(); return { getItem: key => rows.get(key) ?? null, setItem: (key, value) => rows.set(key, value), removeItem: key => rows.delete(key) }; };
async function until(check) { const end = Date.now() + 15000; while (!check()) { assert.ok(Date.now() < end, 'HTTP reconciliation did not converge'); await new Promise(resolve => setTimeout(resolve, 20)); } }
async function fixture(production, run) {
  process.chdir(fileURLToPath(new URL('stage-d/', import.meta.url)));
  const path = mkdtempSync(join(tmpdir(), 'draft-off-m52-')), clients = [];
  // Accelerated test-only request/ticket budgets; interactive defaults are unchanged.
  const runtime = await startRuntime(path, { production, overrides: { requestsPerMinute: 50000, readBurst: 1000, readsPerMinute: 5000, commandBurst: 1000, commandsPerMinute: 5000, ticketBurst: 100, ticketsPerMinute: 1000, roomTicketBurst: 1000, roomTicketsPerMinute: 5000, pendingTicketsPerParticipant: 100, pendingTicketsPerRoom: 200 } });
  const send = async (url, init) => { const headers = new Headers(init?.headers); headers.set('Origin', origin); if(!headers.has('CF-Connecting-IP')) headers.set('CF-Connecting-IP', '198.18.0.52'); return fetch(url, { ...init, headers }); };
  let code, connection = 0;
  async function enroll(name, host = false, eraId = 'era-foundation', draftMinutes = 10, format) { const saved = storage(); const reply = await enrollGuest(runtime.url.origin, host ? 'CREATE' : 'JOIN', host ? undefined : code, host ? { displayName: name, eraId, draftMinutes, ...(format ? { format } : {}) } : { displayName: name }, saved, send); assert.equal(reply.status, 201); if (host) code = reply.body.roomCode; return saved; }
  function connect(saved, { brokenSocket = false, loseCommand = false, journal = storage() } = {}) {
    const ip = `198.18.${process.pid % 250}.${++connection}`;
    let state, lose = loseCommand; const bodies = [];
    const transport = createDraftOffTransport({ fetch: async (url, init) => {
      if (String(url).endsWith('/commands')) bodies.push(init.body);
      const headers = new Headers(init?.headers); headers.set('CF-Connecting-IP', ip);
      const response = await send(url, { ...init, headers });
      if (lose && String(url).endsWith('/commands') && response.status === 200) { lose = false; await response.body.cancel(); throw new Error('lost committed command response'); }
      return response;
    } });
    const client = createDraftOffSession({ apiOrigin: runtime.url.origin, roomCode: code, credential: readDraftOffCredential(saved, code), journalStorage: journal, transport,
      realtime: { policy: { reconciliationIntervalMs: brokenSocket ? 250 : 15000 }, createSocket: brokenSocket ? () => { throw new Error('socket unavailable'); } : (url, protocols) => new WebSocket(url, protocols, { headers: { Origin: origin, 'CF-Connecting-IP': ip } }) },
      onChange: next => { state = next; } });
    clients.push(client); return { client, state: () => state, bodies, journal, saved };
  }
  async function draft(player, count = 11, reverse = false) {
    for (let n = 0; n < count; n++) {
      await player.client.command({ type: 'SPIN' });
      const before = player.state().snapshot.view.myDraft;
      assert.equal(before.phase, 'AWAITING_PICK');
      const candidates = before.candidates.filter(row => row.available && row.positions.some(slot => slot.available));
      const candidate = reverse ? candidates.at(-1) : candidates[0];
      assert.ok(candidate);
      const positions = candidate.positions.filter(slot => slot.available);
      const slot = reverse ? positions.at(-1) : positions[0];
      await player.client.command({ type: 'LOCK_PLAYER', playerTeamSeasonId: candidate.playerTeamSeasonId, battingPosition: slot.battingPosition });
      assert.equal(player.state().snapshot.view.myDraft.status.pickCount, n + 1);
      assert.equal(JSON.parse(player.bodies.at(-1)).expectedDraftRevision, before.revision);
    }
  }
  try { await run({ runtime, code: () => code, enroll, connect, draft }); }
  finally { clients.forEach(client => client.stop()); await runtime.mf.dispose(); rmSync(path, { recursive: true, force: true }); }
}

test('M5.2 production backend: two independent guests draft, retry, reload, submit, wait and converge without WebSocket', { timeout: 90000 }, () => fixture(true, async ({ enroll, connect }) => {
  const hostSaved = await enroll('Host', true), guestSaved = await enroll('Guest');
  let host = connect(hostSaved), guest = connect(guestSaved, { brokenSocket: true });
  await host.client.start(); await guest.client.start();
  await host.client.command({ type: 'START' }); await until(() => guest.state()?.snapshot.view.phase === 'IN_PROGRESS');
  // Concurrent duplicate UI intents cannot create replacement commands.
  const duplicate = await Promise.allSettled([host.client.command({ type: 'SPIN' }), host.client.command({ type: 'SPIN' })]);
  assert.equal(duplicate.filter(reply => reply.status === 'fulfilled').length, 1);
  const revision = host.state().snapshot.view.myDraft.revision;
  const pending = structuredClone(host.state().snapshot.view.myDraft);
  await guest.client.command({ type: 'SPIN' }); await host.client.resync();
  assert.deepEqual(host.state().snapshot.view.myDraft, pending); // unrelated room revision
  host.client.stop(); host = connect(hostSaved); await host.client.start();
  assert.equal(host.state().snapshot.view.myDraft.revision, revision);
  const pick = async player => { const view = player.state().snapshot.view.myDraft; const row = view.candidates.find(row => row.available && row.positions.some(slot => slot.available)); await player.client.command({ type: 'LOCK_PLAYER', playerTeamSeasonId: row.playerTeamSeasonId, battingPosition: row.positions.find(slot => slot.available).battingPosition }); };
  await pick(host); await pick(guest);
  // Lost success and refresh retry must reuse exactly the immutable journal.
  host.client.stop(); host = connect(hostSaved, { loseCommand: true }); await host.client.start();
  await host.client.command({ type: 'SPIN' }); assert.equal(host.state().pending, true); assert.equal(host.state().retryAvailable, true);
  const intent = host.bodies.at(-1), journal = host.journal; host.client.stop();
  host = connect(hostSaved, { journal }); await host.client.start(); assert.equal(host.bodies[0], intent); await pick(host);
  // Finish from existing picks using only the HTTP-projected legal options.
  async function finish(player) { while (player.state().snapshot.view.myDraft.phase !== 'XI_COMPLETE') { await until(() => !player.state().pending); await player.client.command({ type: 'SPIN' }); await until(() => !player.state().pending); await pick(player); if (player.state().pending && player.state().retryAvailable) assert.fail(player.state().error); } }
  await finish(host); await finish(guest);
  assert.equal(host.state().snapshot.view.myDraft.picks.length, 11); assert.equal(guest.state().snapshot.view.myDraft.picks.length, 11);
  for (const player of [host, guest]) {
    assert.ok(player.state().snapshot.view.participants.every(row => Object.keys(row).sort().join() === 'displayName,membershipStatus,participantId,role,roundStatus'));
    assert.ok(!JSON.stringify(player.state().snapshot).includes('baseQuality'));
  }
  await host.client.command({ type: 'SUBMIT' });
  assert.equal(host.state().snapshot.view.phase, 'IN_PROGRESS');
  host.client.stop(); host = connect(hostSaved); await host.client.start();
  assert.equal(host.state().snapshot.view.participants.find(row => row.participantId === host.state().snapshot.participantId).roundStatus, 'SUBMITTED');
  const frozen = structuredClone(host.state().snapshot.view.myDraft);
  await host.client.command({ type: 'SPIN' }); assert.deepEqual(host.state().snapshot.view.myDraft, frozen); // server locks submission
  await guest.client.command({ type: 'SUBMIT' });
  await until(() => host.state().snapshot.view.phase === 'COMPLETE' && guest.state().snapshot.view.phase === 'COMPLETE');
  const result = host.state().snapshot.view.resolution;
  assert.equal(result.contestStatus, 'CONTESTED'); assert.equal(result.trigger, 'ALL_SUBMITTED'); assert.equal(result.leaderboard.length, 2);
  assert.ok(result.leaderboard.every(row => row.played === 20));
  assert.deepEqual(guest.state().snapshot.view.resolution, result);
}));

test('M5.2 native backend deadline: complete XI auto-submits, incomplete XI excluded; empty round has no contest', { timeout: 90000 }, () => fixture(false, async ({ runtime, code, enroll, connect, draft }) => {
  const host = connect(await enroll('Complete', true)); const guest = connect(await enroll('Incomplete'));
  await host.client.start(); await guest.client.start(); await host.client.command({ type: 'START' }); await guest.client.resync();
  await draft(host); await draft(guest, 1);
  const deadline = host.state().snapshot.view.round.deadlineAtMs;
  await control(runtime, code(), 'offset', { offset: deadline - Date.now() + 1 });
  await host.client.resync(); await guest.client.resync();
  const result = host.state().snapshot.view.resolution;
  assert.equal(result.trigger, 'DEADLINE'); assert.equal(result.contestStatus, 'UNCONTESTED'); assert.equal(result.leaderboard.length, 1);
  assert.equal(result.leaderboard[0].played, 20); assert.equal(guest.state().snapshot.view.participants.find(row => row.participantId === guest.state().snapshot.participantId).roundStatus, 'INELIGIBLE');
  host.client.stop(); guest.client.stop();
  const next = connect(await enroll('Empty host', true)); const other = connect(await enroll('Empty guest'));
  await next.client.start(); await other.client.start(); await next.client.command({ type: 'START' });
  await control(runtime, code(), 'offset', { offset: next.state().snapshot.view.round.deadlineAtMs - Date.now() + 1 }); await next.client.resync();
  assert.equal(next.state().snapshot.view.resolution.contestStatus, 'NO_CONTEST'); assert.deepEqual(next.state().snapshot.view.resolution.leaderboard, []);
}));

test('M5.2 production backend: eight entrants finish independent XIs and receive one leaderboard', { timeout: 90000 }, () => fixture(true, async ({ enroll, connect, draft }) => {
  const players = [connect(await enroll('Host eight', true))];
  for (let i = 1; i < 8; i++) players.push(connect(await enroll(`Guest ${i}`)));
  for (const player of players) await player.client.start();
  await players[0].client.command({ type: 'START' });
  for (const player of players) { await player.client.resync(); await draft(player); }
  for (const player of players) await player.client.command({ type: 'SUBMIT' });
  for (const player of players) await player.client.resync();
  const result = players[0].state().snapshot.view.resolution;
  assert.equal(result.leaderboard.length, 8); assert.equal(result.contestStatus, 'CONTESTED');
  assert.ok(result.leaderboard.every(row => row.played === 20));
  for (const player of players) assert.deepEqual(player.state().snapshot.view.resolution, result);
}));

// Combined acceptance matrix, not a Cartesian benchmark. Existing journeys also
// cover Foundation/10/two+eight and Transition/10 in the real browser.
for (const [eraId, minutes, count, format] of [
  ['era-foundation', 15, 2], ['era-expansion', 10, 2],
  ['era-transition', 15, 2], ['era-modern-pre-impact', 10, 2],
  ['era-impact', 15, 8],
  ['era-foundation', 10, 2, 'MIRROR'], ['era-impact', 15, 8, 'MIRROR'],
]) {
  test(`M5.6 production acceptance: ${eraId}/${minutes} minutes/${count} entrants/${format ?? "VARIED default"}, distinct strategies and aligned campaigns`,
    { timeout: 180000 }, () => fixture(true, async ({ runtime, code, enroll, connect, draft }) => {
      const saved = [await enroll('Matrix host', true, eraId, minutes, format)];
      for (let i = 1; i < count; i++) saved.push(await enroll(`Matrix member ${i}`));
      const players = saved.map(row => connect(row));
      for (const player of players) await player.client.start();
      // Member START fails and cannot change fixed settings or room phase.
      await players[1].client.command({ type: 'START' });
      assert.equal(players[1].state().snapshot.view.phase, 'LOBBY');
      await players[0].client.resync(); await players[0].client.command({ type: 'START' });
      for (const player of players) {
        await player.client.resync();
        const snapshot = player.state().snapshot;
        assert.equal(snapshot.settings.draftMinutes, minutes);
        assert.equal(snapshot.settings.format, format ?? "VARIED");
        assert.equal(snapshot.view.round.format, format ?? "VARIED");
        assert.equal(snapshot.view.round.eraId, eraId);
        const duration = snapshot.view.round.deadlineAtMs - snapshot.view.round.startedAtMs;
        // Deadline is derived immediately before the START event timestamp;
        // match the established native Stage E tolerance for that clock read.
        assert.ok(duration > minutes * 60000 - 1000 && duration <= minutes * 60000);
        assert.equal(snapshot.view.round.deadlineAtMs, players[0].state().snapshot.view.round.deadlineAtMs);
      }
      for (const [i, player] of players.entries()) await draft(player, 11, i % 2 === 1);
      const picks = players.map(player => player.state().snapshot.view.myDraft.picks);
      assert.notDeepEqual(picks[0], picks[1]);
      for (const player of players) await player.client.command({ type: 'SUBMIT' });
      for (const player of players) await player.client.resync();
      const resolution = players[0].state().snapshot.view.resolution;
      assert.equal(resolution.contestStatus, 'CONTESTED');
      assert.equal(resolution.leaderboard.length, count);
      const campaigns = [];
      for (const player of players) {
        assert.deepEqual(player.state().snapshot.view.resolution, resolution);
        const participantId = player.state().snapshot.participantId;
        const result = await player.client.loadResults(participantId);
        assert.equal(result.players.length, 11);
        assert.equal(new Set(result.players.map(row => row.playerId)).size, 11);
        assert.ok(result.players.some(row => row.keeperCapability === 'CONFIRMED'));
        assert.ok(result.players.filter(row => row.rosterStatus === 'OVERSEAS').length <= 4);
        const { aggregate: a, matches } = result.campaign;
        assert.equal(matches.length, 20);
        assert.equal(a.won, matches.filter(row => row.outcome === 'WIN').length);
        assert.equal(a.lost, 20 - a.won); assert.equal(a.points, a.won * 2);
        assert.equal(a.netRunRate, 6 * a.runsFor / a.ballsFacedForNrr - 6 * a.runsAgainst / a.ballsBowledForNrr);
        const row = resolution.leaderboard.find(row => row.participantId === participantId);
        for (const field of ['played','won','lost','points','netRunRate']) assert.equal(row[field], a[field]);
        campaigns.push(matches);
      }
      assert.notDeepEqual(campaigns[0], campaigns[1]);
      const fixtureKeys = rows => rows.map(row => [row.sequence, row.matchId, row.opponent.profileId]);
      for (const campaign of campaigns) assert.deepEqual(fixtureKeys(campaign), fixtureKeys(campaigns[0]));
      const forbidden = await fetch(new URL(`/__test/${code()}/inspect`, runtime.url));
      assert.equal(forbidden.status, 404);
    }));
}
