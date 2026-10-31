import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import WebSocket from './stage-a/node_modules/ws/wrapper.mjs';
import { call, control, origin, startRuntime } from './stage-d/runtime.mjs';
import { loadEraDraftCatalog } from '../dist/eraDraftData.js';
import { restoreDraftOffCompetition, serializeDraftOffCompetition } from '../dist/draftOffCompetitionPersistence.js';
import { countDraftTiers } from '../dist/eraDraftTierCaps.js';
import { parseRoomSnapshot } from '../dist/draftOffRealtimeClient.js';
import { parseDraftOffResults } from '../dist/draftOffResultsClient.js';
import { TEAM_EVALUATION_V3_VERSION } from '../dist/teamEvaluationV3.js';
const secret = () => randomBytes(32).toString('base64url');
const catalog = loadEraDraftCatalog(), caps = { maxS: 3, maxSA: 6 };
const overrides = { requestsPerMinute: 10000, enrollmentPerMinute: 10000, readsPerMinute: 2000, readBurst: 200,
  commandsPerMinute: 2000, commandBurst: 200, roomEnrollmentsPerMinute: 1000, roomEnrollmentBurst: 100 };

for (const format of ['VARIED', 'MIRROR']) test(`${format} Standard: native caps, immutable retries, v4 socket reconnect, restart and deadline auto-submission`, { timeout: 120000 }, async () => {
  process.chdir(fileURLToPath(new URL('stage-d/', import.meta.url)));
  const path = mkdtempSync(join(tmpdir(), 'draft-off-caps-'));
  let runtime = await startRuntime(path, { overrides }), socket;
  try {
    const key = secret(), input = { displayName: 'Host', eraId: 'era-transition', format, draftMinutes: 10 };
    for (const extra of [{ tierCaps: caps }, { maxS: 5 }, { preset: 'CUSTOM' }, { teamEvaluationVersion: TEAM_EVALUATION_V3_VERSION }]) {
      assert.equal((await call(runtime, '/rooms', { method: 'POST', key: secret(), body: { ...input, ...extra } })).status, 400);
    }
    const created = await call(runtime, '/rooms', { method: 'POST', key, body: input }); assert.equal(created.status, 201);
    const host = created.body, code = host.roomCode;
    assert.deepEqual(host.view.round.tierCaps, caps);
    assert.equal(host.view.round.teamEvaluationVersion, TEAM_EVALUATION_V3_VERSION);
    assert.deepEqual((await call(runtime, '/rooms', { method: 'POST', key, body: input })).body, host);
    const member = (await call(runtime, `/rooms/${code}/join`, { method: 'POST', key: secret(), body: { displayName: 'Member' } })).body;
    const read = async room => (await call(runtime, `/rooms/${code}`, { token: room.reconnectCredential })).body;
    const command = async (room, body) => call(runtime, `/rooms/${code}/commands`, { method: 'POST', token: room.reconnectCredential, body });
    const canonical = async () => (await control(runtime, code, 'inspect')).records.competition;
    const frames = [];
    async function connect() {
      const issued = await call(runtime, `/rooms/${code}/socket-tickets`, { method: 'POST', token: member.reconnectCredential, body: {} }); assert.equal(issued.status, 201);
      const url = new URL(`/api/draft-off/v1/rooms/${code}/realtime`, runtime.url); url.protocol = 'ws:';
      const next = new WebSocket(url, ['draft-off.v1', `ticket.${issued.body.ticket}`], { headers: { Origin: origin, 'CF-Connecting-IP': '127.0.0.1' } });
      const initial = new Promise((resolve, reject) => { next.once('message', resolve); next.once('error', reject); });
      next.on('message', bytes => frames.push(parseRoomSnapshot(bytes.toString(), code)));
      await initial; assert.equal(frames.at(-1).version, 4); assert.deepEqual(frames.at(-1).view.round.tierCaps, caps);
      return next;
    }
    socket = await connect();
    assert.equal((await command(host, { commandId: 'start', expectedRoomRevision: (await read(host)).view.revision, command: { type: 'START' } })).status, 200);
    let rejected = 0, lastLock, lastReply;
    for (let n = 0; n < 11; n++) {
      let view = (await read(host)).view;
      const spun = await command(host, { commandId: `spin-${n}`, expectedDraftRevision: view.myDraft.revision, command: { type: 'SPIN' } }); assert.equal(spun.status, 200);
      view = spun.body.view;
      if (n === 7) {
        const respun = await command(host, { commandId: 'late-respin', expectedDraftRevision: view.myDraft.revision, command: { type: 'RESPIN' } });
        assert.equal(respun.status, 200); view = respun.body.view;
      }
      const blocked = view.myDraft.candidates.find(c => c.positions.some(p => p.reasons.some(r => ['S_TIER_LIMIT', 'SA_TIER_LIMIT'].includes(r.code))));
      if (blocked) {
        const before = await canonical();
        const bad = { commandId: `blocked-${n}`, expectedDraftRevision: view.myDraft.revision,
          command: { type: 'LOCK_PLAYER', playerTeamSeasonId: blocked.playerTeamSeasonId, battingPosition: blocked.positions[0].battingPosition } };
        const denied = await command(host, bad); assert.equal(denied.status, 422);
        assert.deepEqual((await command(host, bad)).body, denied.body); assert.equal(await canonical(), before);
        assert.deepEqual((await read(host)).view.myDraft, view.myDraft); rejected++;
      }
      const choices = view.myDraft.candidates.filter(c => c.available).sort((a, b) => {
        const tiers = ['S', 'A', 'B', 'C', 'D']; return tiers.indexOf(catalog.getPlayer(a.playerTeamSeasonId).quality.overall.qualityTier) - tiers.indexOf(catalog.getPlayer(b.playerTeamSeasonId).quality.overall.qualityTier);
      });
      const choice = choices[0]; assert.ok(choice);
      lastLock = { commandId: `lock-${n}`, expectedDraftRevision: view.myDraft.revision, command: { type: 'LOCK_PLAYER', playerTeamSeasonId: choice.playerTeamSeasonId, battingPosition: choice.positions.find(p => p.available).battingPosition } };
      lastReply = await command(host, lastLock); assert.equal(lastReply.status, 200);
      assert.deepEqual((await command(host, lastLock)).body, lastReply.body);
      assert.equal(lastReply.body.view.myDraft.status.pickCount, n + 1);
    }
    assert.ok(rejected > 0, 'Elite-first drafting must encounter cap-blocked selections');
    const stored = await canonical(), state = restoreDraftOffCompetition(catalog, stored);
    assert.match(state.engineVersion, /\/v4$/); assert.deepEqual(state.genesis.tierCaps, caps);
    assert.equal(state.genesis.teamEvaluationVersion, TEAM_EVALUATION_V3_VERSION);
    const counts = countDraftTiers(catalog, state.rounds[0].participants.find(p => p.participantId === host.participantId).draftState.picks);
    assert.ok(counts.s <= 3 && counts.sa <= 6);
    assert.equal(serializeDraftOffCompetition(state), stored);
    socket.terminate(); socket = undefined;
    await runtime.mf.dispose(); runtime = await startRuntime(path, { overrides });
    assert.equal(await canonical(), stored);
    assert.deepEqual((await command(host, lastLock)).body, lastReply.body);
    socket = await connect();
    assert.equal((await read(member)).view.myDraft.picks.length, 0);
    assert.equal((await read(member)).view.participants.find(p => p.participantId === host.participantId).lockedPickCount, 11);
    for (const frame of frames) for (const privateKey of ['myDraft', 'picks', 'candidates', 'rootSeed', 'qualityTier', 'history', 'rngCounters']) assert.ok(!JSON.stringify(frame).includes(`"${privateKey}"`));
    const deadline = (await read(host)).view.round.deadlineAtMs;
    await control(runtime, code, 'offset', { offset: deadline - Date.now() + 1 });
    const ended = (await read(host)).view;
    assert.equal(ended.phase, 'COMPLETE'); assert.deepEqual(ended.round.tierCaps, caps);
    assert.deepEqual(ended.resolution.eligibleParticipantIds, [host.participantId]);
    assert.deepEqual(ended.resolution.ineligibleParticipantIds, [member.participantId]);
    const resolved = restoreDraftOffCompetition(catalog, await canonical());
    assert.equal(resolved.rounds[0].participants.find(p => p.participantId === host.participantId).submission.source, 'DEADLINE_AUTO');
    const response = await call(runtime, `/rooms/${code}/results/${host.participantId}`, { token: member.reconnectCredential });
    assert.equal(response.status, 200); assert.equal(response.body.version, 2);
    const result = parseDraftOffResults(response.body, { roomCode: code, roundId: ended.round.roundId,
      roundOrdinal: ended.round.roundOrdinal, eraId: ended.round.eraId, participantId: host.participantId });
    assert.equal(result.evaluation.teamEvaluationVersion, TEAM_EVALUATION_V3_VERSION);
    assert.ok(result.players.every(p => p.battingAdjustment));
    const authoritative = resolved.rounds[0].resolution.challengeResult.campaigns[0].evaluation.adjustedStrength;
    assert.deepEqual(result.evaluation.strength, { batting: authoritative.batting, bowling: authoritative.bowling, overall: authoritative.overall });
    assert.deepEqual((await command(host, lastLock)).body, lastReply.body);
  } finally { socket?.terminate(); await runtime.mf.dispose(); rmSync(path, { recursive: true, force: true }); }
});
