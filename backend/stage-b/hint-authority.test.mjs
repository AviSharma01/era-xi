import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, startRuntime, request, seed, evict } from './runtime.mjs';

const DAY = 86_400_000;
const inspect = async (runtime, room) => (await request(runtime, room, 'inspect')).result;
const payload = (record) => ({ canonical: record.canonical, receipts: record.receipts, descriptor: record.descriptor });
async function failingRequest(runtime, room, action, input = {}) {
  const response = await fetch(new URL(`/room/${room}/${action}`, runtime.url), {
    method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify(input),
  });
  await response.text(); assert.equal(response.status, 500);
}
const hints = [
  ['missing', undefined],
  ['stale lobby', { phase: 'LOBBY', createdAtMs: 0 }],
  ['wrong phase', { phase: 'COMPLETE', completedAtMs: 0 }],
  ['late deadline', { phase: 'IN_PROGRESS', deadlineAtMs: 900010 + DAY }],
  ['early deadline', { phase: 'IN_PROGRESS', deadlineAtMs: 0 }],
  ['missing time', { phase: 'IN_PROGRESS' }],
  ['extra field', { phase: 'IN_PROGRESS', deadlineAtMs: 900010, createdAtMs: 0 }],
];

test('canonical scheduling authority in native workerd/SQLite', { timeout: 180000 }, async (t) => {
  const path = mkdtempSync(join(tmpdir(), 'draft-off-hint-authority-'));
  let runtime = await startRuntime(path);
  try {
    await t.test('create and commit repair missing/stale/wrong-phase/wrong-deadline hints immediately', async () => {
      const data = fixture('era-impact', 2, 'complete');
      for (const [label, hint] of hints) {
        await request(runtime, 'hints', 'seed', { fixture: data, hint, warm: false });
        const before = await inspect(runtime, 'hints');
        assert.deepEqual(before.wake, { kind: 'DEADLINE', atMs: 900010 }, label);
        await request(runtime, 'hints', 'snapshot');
        // Use the repository contract directly with a live service, bypassing M3's hint producer.
        await request(runtime, 'hints', 'hint', { hint });
        const after = await inspect(runtime, 'hints');
        assert.deepEqual(payload(after), payload(before), label);
        assert.deepEqual(after.wake, before.wake, label); assert.equal(after.alarmAt, before.alarmAt, label);
      }
    });

    await t.test('wrong lobby/completed retention anchors never replace canonical scheduling', async () => {
      for (const [stage, correctWake, wrongHints] of [
        ['lobby', { kind: 'LOBBY_EXPIRY', atMs: DAY }, [
          { phase: 'LOBBY', createdAtMs: -2 * DAY }, { phase: 'LOBBY', createdAtMs: DAY },
          { phase: 'IN_PROGRESS', deadlineAtMs: 0 },
        ]],
        ['resolved', { kind: 'COMPLETED_EXPIRY', atMs: 20 + 7 * DAY }, [
          { phase: 'COMPLETE', completedAtMs: -8 * DAY }, { phase: 'COMPLETE', completedAtMs: DAY },
          { phase: 'LOBBY', createdAtMs: 0 },
        ]],
      ]) {
        await seed(runtime, 'retention-hints', fixture('era-impact', 2, stage));
        const before = await inspect(runtime, 'retention-hints'); assert.deepEqual(before.wake, correctWake);
        for (const hint of wrongHints) {
          await request(runtime, 'retention-hints', 'hint', { hint });
          const after = await inspect(runtime, 'retention-hints');
          assert.deepEqual(payload(after), payload(before)); assert.deepEqual(after.wake, correctWake); assert.equal(after.alarmAt, before.alarmAt);
        }
      }
    });

    await t.test('warm access repairs missing/future/premature wakes before deadline or expiry decisions', async () => {
      await seed(runtime, 'warm', fixture('era-impact', 2, 'complete'));
      const before = await inspect(runtime, 'warm');
      for (const wake of [undefined, { kind: 'LOBBY_EXPIRY', atMs: 0 },
        { kind: 'COMPLETED_EXPIRY', atMs: 0 }, { kind: 'DEADLINE', atMs: 900010 + DAY }]) {
        await request(runtime, 'warm', 'wake', { wake, alarmInMs: DAY });
        const view = await request(runtime, 'warm', 'snapshot'); assert.equal(view.result.phase, 'IN_PROGRESS');
        const after = await inspect(runtime, 'warm');
        assert.deepEqual(payload(after), payload(before)); assert.deepEqual(after.wake, before.wake);
        assert.equal(after.alarmAt, before.alarmAt); assert.equal(after.retired, undefined);
      }
      await request(runtime, 'warm', 'time', { logicalNow: 900020, suppress: true });
      await request(runtime, 'warm', 'wake', { wake: { kind: 'DEADLINE', atMs: 900010 + DAY } });
      assert.equal((await request(runtime, 'warm', 'snapshot')).result.resolution.trigger, 'DEADLINE');
    });

    await t.test('destructive expiry restores phase/time again and refuses premature deletion', async () => {
      for (const stage of ['lobby', 'complete', 'resolved']) {
        await seed(runtime, 'guard', fixture('era-impact', 2, stage));
        const before = await inspect(runtime, 'guard');
        for (const wake of [undefined, { kind: 'LOBBY_EXPIRY', atMs: 0 }, { kind: 'COMPLETED_EXPIRY', atMs: 0 }]) {
          await request(runtime, 'guard', 'wake', { wake, alarmInMs: DAY });
          assert.equal((await request(runtime, 'guard', 'expiry')).result.expired, false);
          const after = await inspect(runtime, 'guard');
          assert.deepEqual(payload(after), payload(before)); assert.deepEqual(after.wake, before.wake);
          assert.equal(after.retired, undefined); assert.equal(after.alarmAt, before.alarmAt);
        }
      }
      await seed(runtime, 'corrupt-guard', fixture('era-impact', 2, 'lobby'));
      await request(runtime, 'corrupt-guard', 'wake', { wake: { kind: 'LOBBY_EXPIRY', atMs: 0 } });
      await request(runtime, 'corrupt-guard', 'corrupt');
      const corrupt = await inspect(runtime, 'corrupt-guard');
      await failingRequest(runtime, 'corrupt-guard', 'expiry');
      const after = await inspect(runtime, 'corrupt-guard'); assert.deepEqual(payload(after), payload(corrupt));
      assert.deepEqual(after.wake, corrupt.wake); assert.equal(after.alarmAt, corrupt.alarmAt); assert.equal(after.retired, undefined);
    });

    await t.test('canonical expiry is not postponed by future or wrong-kind metadata', async () => {
      for (const stage of ['lobby', 'resolved']) {
        await seed(runtime, 'due-expiry', fixture('era-impact', 2, stage));
        const before = await inspect(runtime, 'due-expiry');
        await request(runtime, 'due-expiry', 'time', { logicalNow: before.wake.atMs, suppress: true });
        await request(runtime, 'due-expiry', 'wake', { wake: { kind: 'DEADLINE', atMs: before.wake.atMs + DAY } });
        assert.equal((await request(runtime, 'due-expiry', 'expiry')).result.expired, true);
        const expired = await inspect(runtime, 'due-expiry');
        assert.equal(expired.canonical, undefined); assert.deepEqual(expired.receipts, {});
        assert.equal(expired.retired.retiredAtMs, before.wake.atMs);
        assert.equal(expired.retired.purgeAtMs, before.wake.atMs + 30 * DAY);
      }
    });

    await t.test('bad hint and corrupt save cannot bypass replay or split repaired alarm/state/receipts', async () => {
      await seed(runtime, 'hint-rollback', fixture('era-impact', 2, 'complete'));
      await request(runtime, 'hint-rollback', 'wake', { wake: { kind: 'LOBBY_EXPIRY', atMs: 0 }, alarmInMs: DAY });
      const before = await inspect(runtime, 'hint-rollback');
      await failingRequest(runtime, 'hint-rollback', 'hint', { hint: { phase: 'LOBBY', createdAtMs: 0 }, failBeforeCommit: true });
      const failed = await inspect(runtime, 'hint-rollback');
      assert.deepEqual(payload(failed), payload(before)); assert.deepEqual(failed.wake, before.wake); assert.equal(failed.alarmAt, before.alarmAt);
      await request(runtime, 'hint-rollback', 'hint', { hint: { phase: 'LOBBY', createdAtMs: 0 } });
      assert.deepEqual((await inspect(runtime, 'hint-rollback')).wake, { kind: 'DEADLINE', atMs: 900010 });
      await request(runtime, 'hint-rollback', 'corrupt');
      const corrupt = await inspect(runtime, 'hint-rollback');
      await failingRequest(runtime, 'hint-rollback', 'hint', { hint: { phase: 'IN_PROGRESS', deadlineAtMs: 900010 } });
      assert.deepEqual(payload(await inspect(runtime, 'hint-rollback')), payload(corrupt));
    });

    await t.test('cold eviction and process restart repair scheduling without changing saves or receipts', async () => {
      const cases = [
        ['lobby', { kind: 'DEADLINE', atMs: 0 }],
        ['complete', { kind: 'COMPLETED_EXPIRY', atMs: 0 }],
        ['resolved', { kind: 'LOBBY_EXPIRY', atMs: 0 }],
      ];
      const saved = [];
      for (const [stage, wake] of cases) {
        const room = `restart-${stage}`; await seed(runtime, room, fixture('era-impact', 2, stage));
        const before = await inspect(runtime, room); saved.push([room, before]);
        await request(runtime, room, 'wake', { wake, alarmInMs: DAY }); await evict(runtime, room);
        await request(runtime, room, 'snapshot');
        const cold = await inspect(runtime, room);
        assert.notEqual(cold.instanceId, before.instanceId); assert.deepEqual(payload(cold), payload(before));
        assert.deepEqual(cold.wake, before.wake); assert.equal(cold.alarmAt, before.alarmAt);
        await request(runtime, room, 'wake', { alarmInMs: DAY });
      }
      await runtime.mf.dispose(); runtime = await startRuntime(path);
      for (const [room, before] of saved) {
        await request(runtime, room, 'snapshot'); const cold = await inspect(runtime, room);
        assert.deepEqual(payload(cold), payload(before)); assert.deepEqual(cold.wake, before.wake); assert.equal(cold.alarmAt, before.alarmAt);
      }
    });

    await t.test('late/wrong-phase hints cannot delay autonomous warm/cold native deadline resolution', async () => {
      for (const cold of [false, true]) {
        const room = `autonomous-${cold}`;
        await seed(runtime, room, fixture('era-impact', 2, 'complete'));
        const before = await inspect(runtime, room);
        await request(runtime, room, 'hint', { hint: { phase: 'IN_PROGRESS', deadlineAtMs: 900010 + DAY } });
        await request(runtime, room, 'hint', { hint: { phase: 'COMPLETE', completedAtMs: 0 } });
        const arm = await request(runtime, room, 'time', { logicalNow: 899010 });
        if (cold) await evict(runtime, room);
        // No requests while the real native alarm becomes due and resolves the room.
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const after = await inspect(runtime, room);
        assert.ok(after.alarmReport?.startedAt >= arm.result.alarmAt);
        const events = JSON.parse(after.canonical).history;
        assert.equal(events.filter((event) => event.command.type === 'FINALIZE_ROUND').length, 1);
        assert.equal(events.at(-1).resultingCompetitionPhase, 'COMPLETE');
        assert.equal(after.wake.kind, 'COMPLETED_EXPIRY');
        assert.equal(Object.keys(after.receipts).filter((id) => id.startsWith('receipt:deadline:')).length, 1);
        assert.notEqual(after.canonical, before.canonical);
      }
    });

    await t.test('already-overdue native delivery reconciles bad metadata without any participant request', async () => {
      await seed(runtime, 'overdue-native', fixture('era-impact', 2, 'complete'));
      await request(runtime, 'overdue-native', 'wake', { wake: { kind: 'COMPLETED_EXPIRY', atMs: 0 } });
      const arm = await request(runtime, 'overdue-native', 'time', { logicalNow: 900020, nativeInMs: 100 });
      await evict(runtime, 'overdue-native');
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const after = await inspect(runtime, 'overdue-native');
      assert.ok(after.alarmReport?.startedAt >= arm.result.alarmAt);
      assert.equal(JSON.parse(after.canonical).history.at(-1).resultingCompetitionPhase, 'COMPLETE');
      assert.equal(after.wake.kind, 'COMPLETED_EXPIRY'); assert.equal(after.retired, undefined);
    });
  } finally { await runtime.mf.dispose(); }
});
