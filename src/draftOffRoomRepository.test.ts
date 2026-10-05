import assert from "node:assert/strict";
import test from "node:test";
import { FakeDraftOffClock, InMemoryDraftOffRoomRepository } from "./draftOffRoomRepository.js";
import type { DraftOffRoomRepositoryRecord } from "./draftOffRoomTypes.js";

const record = (serializedCompetition: string): DraftOffRoomRepositoryRecord => ({ serializedCompetition, receipts: {} });

test("room repository serializes one room and lets another room proceed", async () => {
  const repository = new InMemoryDraftOffRoomRepository();
  await repository.create("a", record("initial"));
  await repository.create("b", record("other"));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const first = repository.transact("a", async (current) => {
    assert.equal(current.serializedCompetition, "initial");
    entered();
    await gate;
    return { record: record("first"), value: 1 };
  });
  await started;
  const second = repository.transact("a", (current) => {
    assert.equal(current.serializedCompetition, "first");
    return { record: record("second"), value: 2 };
  });
  assert.equal((await repository.read("b"))!.serializedCompetition, "other");
  release();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.equal((await repository.read("a"))!.serializedCompetition, "second");
});

test("repository failure rolls back, releases its queue, and freezes records and receipts", async () => {
  const repository = new InMemoryDraftOffRoomRepository();
  await repository.create("a", record("initial"));
  await assert.rejects(repository.transact("a", () => { throw new Error("interrupted"); }), /interrupted/);
  assert.equal((await repository.read("a"))!.serializedCompetition, "initial");
  await assert.rejects(repository.create("a", record("replacement")), /already exists/);
  assert.equal(await repository.read("missing"), undefined);
  await assert.rejects(repository.transact("missing", (current) => ({ record: current, value: 1 })), /does not exist/);
  const receipt = { fingerprint: "hash", result: { ok: true as const, changed: false, roomRevision: 0 } };
  await repository.transact("a", (current) => ({
    record: { ...current, receipts: { receipt } }, value: undefined,
  }));
  const stored = (await repository.read("a"))!;
  assert.ok(Object.isFrozen(stored));
  assert.ok(Object.isFrozen(stored.receipts));
  assert.ok(Object.isFrozen(stored.receipts.receipt.result));
  assert.throws(() => { (stored.receipts as Record<string, unknown>).extra = "mutable"; });
});

test("fake clock runs due tasks in stable order, permits cancellation, and propagates failures", async () => {
  const clock = new FakeDraftOffClock(10);
  const order: string[] = [];
  clock.scheduleAt(20, async () => { order.push("first"); });
  clock.scheduleAt(20, () => { order.push("second"); clock.scheduleAt(20, () => { order.push("nested"); }); });
  clock.scheduleAt(15, () => { order.push("cancelled"); }).cancel();
  await clock.advanceTo(19);
  assert.deepEqual(order, []);
  await clock.advanceBy(1);
  assert.deepEqual(order, ["first", "second", "nested"]);
  assert.equal(clock.pendingTaskCount(), 0);
  clock.scheduleAt(21, () => { throw new Error("failure"); });
  await assert.rejects(clock.advanceTo(21), /failure/);
  await assert.rejects(clock.advanceTo(20), /backwards/);
  assert.throws(() => new FakeDraftOffClock(-1), /timestamp|time/);
});
