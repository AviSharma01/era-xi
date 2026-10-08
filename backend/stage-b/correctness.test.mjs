import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, startRuntime, request, seed, evict, envelope } from './runtime.mjs';

const DAY = 86_400_000;
const inspect = async (runtime, room) => (await request(runtime, room, 'inspect')).result;
const state = (record) => JSON.parse(record.canonical);
const finalizations = (record) => state(record).history.filter((event) => event.command.type === 'FINALIZE_ROUND');
const deadlineReceipts = (record) => Object.keys(record.receipts).filter((id) => id.startsWith('receipt:deadline:'));
const stableRecord = (record) => ({ canonical: record.canonical, receipts: record.receipts, descriptor: record.descriptor, wake: record.wake, alarmAt: record.alarmAt, retired: record.retired });
const createInput = (roomId) => ({ roomId, hostDisplayName: 'Player 0', initialRound: {
  roundId: 'r1', roundOrdinal: 1, label: 'Stage B test', eraId: 'era-impact', challengeSeed: 'stage-b-test-seed',
} });
async function failingRequest(runtime, room, action, input, participant = 'p0') {
  const response = await fetch(new URL(`/room/${room}/${action}?participant=${participant}`, runtime.url), {
    method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify(input),
  });
  await response.text();
  assert.equal(response.status, 500);
}
async function waitForNativeAlarm(runtime, room, alarmAt) {
  for (let attempt = 0; attempt < 100; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const record = await inspect(runtime, room);
    if (record.alarmReport?.startedAt >= alarmAt) return record;
  }
  throw new Error('Native alarm failed to complete');
}

test('Stage B native workerd / SQLite persistence and lifecycle', { timeout: 180000 }, async (t) => {
  const path = mkdtempSync(join(tmpdir(), 'draft-off-stage-b-'));
  let runtime = await startRuntime(path);
  try {
    await t.test('production bundle has no fixture HTTP routes or participant auth', async () => {
      const production = await startRuntime(mkdtempSync(join(tmpdir(), 'draft-off-stage-b-production-')), true);
      try {
        const response = await fetch(new URL('/room/x/seed?participant=p0', production.url));
        assert.equal(response.status, 404);
        const bundle = readFileSync(new URL('.generated/worker.js', import.meta.url), 'utf8');
        for (const text of ['StageBTestRoom', 'STAGE_B_ONLY', 'test:offset', 'failBeforeCommit', 'Invalid fixture actor']) assert.ok(!bundle.includes(text));
      } finally { await production.mf.dispose(); }
    });

    await t.test('create persists a lobby and expiry atomically, eviction restores it', async () => {
      const created = await request(runtime, 'created', 'create', { room: createInput('created'), logicalNow: 100 });
      const before = await inspect(runtime, 'created');
      assert.equal(before.wake.kind, 'LOBBY_EXPIRY');
      assert.equal(before.wake.atMs, state(before).genesis.createdAtMs + DAY);
      assert.ok(before.alarmAt > Date.now());
      await evict(runtime, 'created');
      const restored = await request(runtime, 'created', 'snapshot', { roomId: 'created' });
      assert.notEqual(created.sample.instanceId, restored.sample.instanceId);
      assert.deepEqual(restored.result, created.result);
      await failingRequest(runtime, 'failed-create', 'create', { room: createInput('failed-create'), logicalNow: 100, failBeforeCommit: true });
      const failed = await inspect(runtime, 'failed-create');
      assert.equal(failed.canonical, undefined); assert.equal(failed.descriptor, undefined); assert.equal(failed.wake, undefined); assert.equal(failed.alarmAt, null);
      assert.deepEqual(failed.receipts, {});
      await request(runtime, 'failed-create', 'create', { room: createInput('failed-create') });
    });

    await t.test('all eras retain canonical saves and exact historical M3 receipts through eviction', async () => {
      const inventory = JSON.parse(readFileSync(new URL('../stage-a/results/artifact-inventory.json', import.meta.url)));
      for (const { eraId } of inventory) {
        const data = fixture(eraId, 2, 'late');
        await seed(runtime, 'eras', data);
        const before = await request(runtime, 'eras', 'snapshot');
        const durable = await inspect(runtime, 'eras');
        await evict(runtime, 'eras');
        const after = await request(runtime, 'eras', 'snapshot');
        assert.notEqual(before.sample.instanceId, after.sample.instanceId); assert.deepEqual(after.result, before.result);
        const retry = await request(runtime, 'eras', 'command', { envelope: data.lastCommand.envelope }, data.lastCommand.actor.participantId);
        assert.deepEqual(retry.result, data.lastCommand.result);
        assert.deepEqual(stableRecord(await inspect(runtime, 'eras')), stableRecord(durable));
        const conflict = await request(runtime, 'eras', 'command', { envelope: { ...data.lastCommand.envelope, command: { type: 'SPIN' } } }, 'p0');
        assert.equal(conflict.result.code, 'COMMAND_ID_CONFLICT');
      }
    });

    await t.test('START canonical deadline, receipt, wake, and native alarm cannot split', async () => {
      const data = fixture('era-impact', 2, 'lobby'); await seed(runtime, 'start', data);
      const before = await inspect(runtime, 'start');
      const command = { roomId: 'fixture-room', commandId: 'start-test', expectedRoomRevision: data.revision,
        command: { type: 'START', roundId: 'r1', deadlineAtMs: 900100 } };
      await failingRequest(runtime, 'start', 'command', { envelope: command, failBeforeCommit: true });
      assert.deepEqual(stableRecord(await inspect(runtime, 'start')), stableRecord(before));
      const accepted = await request(runtime, 'start', 'command', { envelope: command }); assert.ok(accepted.result.ok);
      const after = await inspect(runtime, 'start');
      assert.deepEqual(after.wake, { kind: 'DEADLINE', atMs: 900100 });
      assert.equal(state(after).history.at(-1).command.deadlineAtMs, after.wake.atMs);
      assert.ok(after.receipts['receipt:start-test']); assert.ok(after.alarmAt < before.alarmAt);
      await evict(runtime, 'start');
      assert.deepEqual((await request(runtime, 'start', 'command', { envelope: command })).result, accepted.result);
      await failingRequest(runtime, 'start', 'throw-transaction', {});
      assert.deepEqual(stableRecord(await inspect(runtime, 'start')), stableRecord(after));
    });

    await t.test('receipt-only rejection is durable and full record rollback is atomic', async () => {
      const data = fixture('era-impact', 8, 'late'); await seed(runtime, 'reject', data);
      const command = envelope('rejected', 999, { type: 'SPIN' });
      const before = await inspect(runtime, 'reject');
      await failingRequest(runtime, 'reject', 'command', { envelope: command, failBeforeCommit: true });
      assert.deepEqual(stableRecord(await inspect(runtime, 'reject')), stableRecord(before));
      const rejected = await request(runtime, 'reject', 'command', { envelope: command });
      assert.equal(rejected.result.code, 'STALE_DRAFT_REVISION');
      assert.equal((await inspect(runtime, 'reject')).canonical, before.canonical);
      await evict(runtime, 'reject');
      assert.deepEqual((await request(runtime, 'reject', 'command', { envelope: command })).result, rejected.result);
    });

    await t.test('concurrent participant commands serialize and same-draft races preserve M3 CAS', async () => {
      const data = fixture('era-impact', 8, 'late'); await seed(runtime, 'races', data);
      const responses = await Promise.all([0, 1].map((p) => request(runtime, 'races', 'command', {
        envelope: envelope(`race-${p}`, data.draftRevisions[p].revision, { type: 'SPIN' }),
      }, `p${p}`)));
      responses.forEach((response) => assert.ok(response.result.ok));
      const revision = responses[0].result.view.myDraft.revision;
      const same = await Promise.all([0, 1].map((p) => request(runtime, 'races', 'command', {
        envelope: envelope(`same-${p}`, revision, { type: 'RESPIN' }),
      })));
      assert.equal(same.filter((response) => response.result.ok).length, 1);
      assert.equal(same.find((response) => !response.result.ok).result.code, 'STALE_DRAFT_REVISION');
    });

    await t.test('strict replay blocks reads and persisted receipt retries of corrupt canonical state', async () => {
      const data = fixture('era-impact', 2, 'late'); await seed(runtime, 'corrupt', data);
      await request(runtime, 'corrupt', 'corrupt');
      await failingRequest(runtime, 'corrupt', 'snapshot', {});
      await failingRequest(runtime, 'corrupt', 'command', { envelope: data.lastCommand.envelope }, data.lastCommand.actor.participantId);
      await evict(runtime, 'corrupt'); await failingRequest(runtime, 'corrupt', 'snapshot', {});
    });

    await t.test('early/repeated native alarms rearm the authoritative deadline without reserving a receipt', async () => {
      await seed(runtime, 'early', fixture('era-impact', 2, 'complete'));
      const before = await inspect(runtime, 'early');
      const arm = await request(runtime, 'early', 'time', { logicalNow: 1000, nativeInMs: 100 });
      const after = await waitForNativeAlarm(runtime, 'early', arm.result.alarmAt);
      assert.equal(after.canonical, before.canonical); assert.deepEqual(after.receipts, before.receipts);
      assert.equal(deadlineReceipts(after).length, 0); assert.equal(after.wake.kind, 'DEADLINE'); assert.ok(after.alarmAt > Date.now());
      await request(runtime, 'early', 'alarm'); await evict(runtime, 'early'); await request(runtime, 'early', 'alarm');
      assert.equal((await inspect(runtime, 'early')).canonical, before.canonical);
      assert.equal(deadlineReceipts(await inspect(runtime, 'early')).length, 0);
    });

    await t.test('native warm/cold deadlines resolve autonomously with zero browser clients; duplicate alarms are harmless', async () => {
      for (const cold of [false, true]) {
        const room = `deadline-${cold}`;
        await seed(runtime, room, fixture('era-impact', 2, 'complete'));
        const arm = await request(runtime, room, 'time', { logicalNow: 899410 });
        if (cold) await evict(runtime, room);
        // No requests during delivery. The later inspection only reads persisted bytes.
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const after = await waitForNativeAlarm(runtime, room, arm.result.alarmAt);
        assert.equal(finalizations(after).length, 1); assert.equal(deadlineReceipts(after).length, 1);
        assert.equal(after.wake.kind, 'COMPLETED_EXPIRY');
        assert.equal((await request(runtime, room, 'snapshot')).result.resolution.trigger, 'DEADLINE');
        await request(runtime, room, 'alarm'); await request(runtime, room, 'alarm');
        const duplicate = await inspect(runtime, room);
        assert.deepEqual(stableRecord(duplicate), stableRecord(after));
      }
    });

    await t.test('cold overdue recovery retries a failed resolution atomically and preserves one finalization', async () => {
      await seed(runtime, 'overdue', fixture('era-impact', 2, 'complete'));
      const before = await inspect(runtime, 'overdue');
      await request(runtime, 'overdue', 'time', { logicalNow: 900020, suppress: true });
      await evict(runtime, 'overdue');
      // initialize/resume is deliberately the operation that fails before any state is published.
      await failingRequest(runtime, 'overdue', 'command', { envelope: envelope('overdue-read', 22, { type: 'SUBMIT' }), failBeforeCommit: true });
      const failed = await inspect(runtime, 'overdue');
      assert.equal(failed.canonical, before.canonical); assert.deepEqual(failed.receipts, before.receipts);
      assert.equal(failed.wake.kind, 'DEADLINE'); assert.equal(failed.alarmAt, null);
      const recovered = await request(runtime, 'overdue', 'snapshot'); assert.equal(recovered.result.phase, 'COMPLETE');
      const after = await inspect(runtime, 'overdue'); assert.equal(finalizations(after).length, 1);
      await request(runtime, 'overdue', 'resume'); assert.deepEqual(stableRecord(await inspect(runtime, 'overdue')), stableRecord(after));
    });

    await t.test('warm deadline transaction rollback leaves no result/receipt; a repeated alarm recovers', async () => {
      await seed(runtime, 'deadline-failure', fixture('era-impact', 2, 'complete'));
      const before = await inspect(runtime, 'deadline-failure');
      await request(runtime, 'deadline-failure', 'time', { logicalNow: 900020, suppress: true });
      await failingRequest(runtime, 'deadline-failure', 'alarm', { failBeforeCommit: true });
      const failed = await inspect(runtime, 'deadline-failure');
      assert.equal(failed.canonical, before.canonical); assert.deepEqual(failed.receipts, before.receipts);
      assert.deepEqual(failed.wake, before.wake); assert.equal(failed.alarmAt, null);
      await request(runtime, 'deadline-failure', 'alarm');
      const after = await inspect(runtime, 'deadline-failure');
      assert.equal(finalizations(after).length, 1); assert.equal(deadlineReceipts(after).length, 1);
      assert.equal(after.wake.kind, 'COMPLETED_EXPIRY');
    });

    await t.test('warm access recovers an overdue room when alarm delivery was missed', async () => {
      await seed(runtime, 'warm-overdue', fixture('era-impact', 2, 'complete'));
      await request(runtime, 'warm-overdue', 'time', { logicalNow: 900020, suppress: true });
      assert.equal((await request(runtime, 'warm-overdue', 'snapshot')).result.resolution.trigger, 'DEADLINE');
      assert.equal(finalizations(await inspect(runtime, 'warm-overdue')).length, 1);
    });

    await t.test('final pre-deadline submission resolves early; rollback retains old deadline and retry cancels/replaces it', async () => {
      const data = fixture('era-impact', 8, 'submitted'); await seed(runtime, 'final', data);
      await request(runtime, 'final', 'time', { logicalNow: 898010, suppress: true });
      // Restore the real future alarm with an early handler before fault testing.
      await request(runtime, 'final', 'alarm');
      const before = await inspect(runtime, 'final');
      const command = envelope('final-submit', data.draftRevisions[7].revision, { type: 'SUBMIT' });
      await failingRequest(runtime, 'final', 'command', { envelope: command, failBeforeCommit: true }, 'p7');
      assert.deepEqual(stableRecord(await inspect(runtime, 'final')), stableRecord(before));
      const submitted = await request(runtime, 'final', 'command', { envelope: command }, 'p7');
      assert.equal(submitted.result.view.resolution.trigger, 'ALL_SUBMITTED');
      const after = await inspect(runtime, 'final'); assert.equal(after.wake.kind, 'COMPLETED_EXPIRY');
      assert.equal(after.wake.atMs, state(after).history.at(-1).command.atMs + 7 * DAY);
      assert.ok(state(after).history.at(-1).command.atMs < 900010); assert.ok(after.alarmAt > before.alarmAt);
      await evict(runtime, 'final');
      assert.deepEqual((await request(runtime, 'final', 'command', { envelope: command }, 'p7')).result, submitted.result);
      await request(runtime, 'final', 'time', { logicalNow: 900010, suppress: true });
      await request(runtime, 'final', 'alarm');
      const repeated = await inspect(runtime, 'final'); assert.equal(repeated.canonical, after.canonical); assert.deepEqual(repeated.receipts, after.receipts);
      assert.equal(finalizations(repeated).length, 0); assert.equal(deadlineReceipts(repeated).length, 0);
    });

    await t.test('process restart uses persisted SQLite state, receipts, and deadline without import', async () => {
      const data = fixture('era-impact', 8, 'late'); await seed(runtime, 'restart', data);
      const before = await request(runtime, 'restart', 'snapshot');
      const saved = await inspect(runtime, 'restart');
      await runtime.mf.dispose(); runtime = await startRuntime(path);
      const after = await request(runtime, 'restart', 'snapshot');
      assert.notEqual(before.sample.instanceId, after.sample.instanceId); assert.deepEqual(after.result, before.result);
      assert.deepEqual(stableRecord(await inspect(runtime, 'restart')), stableRecord(saved));
      assert.deepEqual((await request(runtime, 'restart', 'command', { envelope: data.lastCommand.envelope }, data.lastCommand.actor.participantId)).result, data.lastCommand.result);
    });

    await t.test('lobby/completed expiry and 30-day marker anchors survive eviction and repeated delivery', async () => {
      for (const [name, fixtureName, duration] of [['lobby-expiry', 'lobby', DAY], ['completed-expiry', 'resolved', 7 * DAY]]) {
        await seed(runtime, name, fixture('era-impact', 2, fixtureName));
        const before = await inspect(runtime, name);
        const anchor = fixtureName === 'lobby' ? state(before).genesis.createdAtMs : state(before).history.at(-1).command.atMs;
        assert.equal(before.wake.atMs, anchor + duration);
        await request(runtime, name, 'time', { logicalNow: before.wake.atMs - 1000, suppress: true });
        await request(runtime, name, 'alarm'); assert.equal((await inspect(runtime, name)).canonical, before.canonical);
        await request(runtime, name, 'time', { logicalNow: before.wake.atMs, suppress: true });
        await evict(runtime, name); await request(runtime, name, 'alarm');
        const expired = await inspect(runtime, name);
        assert.equal(expired.canonical, undefined); assert.deepEqual(expired.receipts, {}); assert.equal(expired.descriptor, undefined); assert.equal(expired.wake, undefined);
        assert.deepEqual(expired.retired, { version: 1, roomId: 'fixture-room', retiredAtMs: before.wake.atMs, purgeAtMs: before.wake.atMs + 30 * DAY });
        assert.deepEqual(expired.keys.sort(), ['retired', 'test:offset']); assert.ok(expired.alarmAt > Date.now());
        await evict(runtime, name); await request(runtime, name, 'alarm');
        assert.deepEqual((await inspect(runtime, name)).retired, expired.retired);
        await failingRequest(runtime, name, 'snapshot', {});
        await request(runtime, name, 'time', { logicalNow: expired.retired.purgeAtMs, suppress: true });
        await request(runtime, name, 'alarm');
        const purged = await inspect(runtime, name); assert.equal(purged.retired, undefined); assert.equal(purged.alarmAt, null); assert.deepEqual(purged.keys, []);
      }
    });

    await t.test('expired code refuses creation during marker interval and permits reuse after purge', async () => {
      await request(runtime, 'reuse', 'create', { room: createInput('reuse'), logicalNow: 100 });
      const before = await inspect(runtime, 'reuse');
      await request(runtime, 'reuse', 'time', { logicalNow: before.wake.atMs, suppress: true });
      // Expiry-on-access, even with missed alarm delivery.
      await failingRequest(runtime, 'reuse', 'snapshot', { roomId: 'reuse' });
      const expired = await inspect(runtime, 'reuse');
      await failingRequest(runtime, 'reuse', 'create', { room: createInput('reuse') });
      assert.deepEqual((await inspect(runtime, 'reuse')).retired, expired.retired);
      await request(runtime, 'reuse', 'time', { logicalNow: expired.retired.purgeAtMs + 1, suppress: true });
      const created = await request(runtime, 'reuse', 'create', { room: createInput('reuse') }); assert.equal(created.result.phase, 'LOBBY');
    });

    await t.test('native expiry and marker purge run autonomously after eviction', async () => {
      for (const fixtureName of ['lobby', 'resolved']) {
        const room = `native-expiry-${fixtureName}`;
        await seed(runtime, room, fixture('era-impact', 2, fixtureName));
        const before = await inspect(runtime, room);
        await request(runtime, room, 'time', { logicalNow: before.wake.atMs - 300 }); await evict(runtime, room);
        await new Promise((resolve) => setTimeout(resolve, 700));
        const expired = await inspect(runtime, room); assert.ok(expired.retired); assert.equal(expired.canonical, undefined);
        await request(runtime, room, 'time', { logicalNow: expired.retired.purgeAtMs - 300, nativeInMs: 300 }); await evict(runtime, room);
        await new Promise((resolve) => setTimeout(resolve, 700));
        const purged = await inspect(runtime, room); assert.deepEqual(purged.keys, []); assert.equal(purged.alarmAt, null);
      }
    });

    await t.test('very late expiry does not recreate a marker beyond its 30-day bound', async () => {
      await seed(runtime, 'late-expiry', fixture('era-impact', 2, 'lobby'));
      const before = await inspect(runtime, 'late-expiry');
      await request(runtime, 'late-expiry', 'time', { logicalNow: before.wake.atMs + 30 * DAY + 100, suppress: true });
      await evict(runtime, 'late-expiry'); await request(runtime, 'late-expiry', 'alarm');
      const purged = await inspect(runtime, 'late-expiry'); assert.equal(purged.retired, undefined); assert.deepEqual(purged.keys, []); assert.equal(purged.alarmAt, null);
    });
  } finally { await runtime.mf.dispose(); }
});
