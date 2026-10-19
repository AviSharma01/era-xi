import assert from "node:assert/strict";
import test from "node:test";
import { reduceDraftOffCompetition, createDraftOffCompetition } from "./draftOffCompetition.js";
import { restoreDraftOffCompetition, serializeDraftOffCompetition } from "./draftOffCompetitionPersistence.js";
import {
  FakeDraftOffClock, InMemoryDraftOffRoomRepository, type DraftOffRoomTransactionResult,
} from "./draftOffRoomRepository.js";
import { DraftOffRoomService, type DraftOffRoomRuntime } from "./draftOffRoomService.js";
import type { DraftOffCompetitionState } from "./draftOffCompetitionTypes.js";
import type { DraftOffRoomCommandEnvelope, DraftOffRoomRepositoryRecord } from "./draftOffRoomTypes.js";
import { projectDraftOffRoomLifecycle, type DraftOffRoomLifecycle } from "./draftOffRoomLifecycle.js";
import {
  baseState, catalog, changed, completeXi, host, joinedState, legalLock,
  ManualDraftOffClock, member, outsider, participant, rejection, roomInput, startedState, success,
} from "./draftOffRoomTestSupport.js";

const runtime: DraftOffRoomRuntime = {
  create: createDraftOffCompetition, reduce: reduceDraftOffCompetition,
  restore: restoreDraftOffCompetition, serialize: serializeDraftOffCompetition,
};

async function fixture(state = startedState(), time = 20, override = runtime) {
  const repository = new InMemoryDraftOffRoomRepository();
  const clock = new FakeDraftOffClock(time);
  const service = new DraftOffRoomService(catalog, repository, clock, override);
  await service.restoreRoom(serializeDraftOffCompetition(state));
  return { service, repository, clock };
}

const join = (commandId: string, expectedRoomRevision: number, displayName = "Member"): DraftOffRoomCommandEnvelope => ({
  roomId: "room", commandId, expectedRoomRevision, command: { type: "JOIN", displayName },
});
const start = (commandId: string, expectedRoomRevision: number): DraftOffRoomCommandEnvelope => ({
  roomId: "room", commandId, expectedRoomRevision,
  command: { type: "START", roundId: "round-1", deadlineAtMs: 100 },
});
const spin = (commandId: string, expectedDraftRevision = 1): DraftOffRoomCommandEnvelope => ({
  roomId: "room", commandId, expectedDraftRevision, command: { type: "SPIN" },
});
const submit = (commandId: string, state: DraftOffCompetitionState, id: string): DraftOffRoomCommandEnvelope => ({
  roomId: "room", commandId, expectedDraftRevision: participant(state, id).draftState.revision,
  command: { type: "SUBMIT" },
});

test("durable scheduling hints come from current validated state, including old receipt retries", async () => {
  class SchedulingRepository extends InMemoryDraftOffRoomRepository {
    readonly hints: DraftOffRoomLifecycle[] = [];
    async create(roomId: string, record: DraftOffRoomRepositoryRecord, lifecycle?: DraftOffRoomLifecycle) {
      assert.deepEqual(lifecycle, projectDraftOffRoomLifecycle(restoreDraftOffCompetition(catalog, record.serializedCompetition)));
      this.hints.push(lifecycle!);
      await super.create(roomId, record);
    }
    async transact<T>(roomId: string, operation: (record: DraftOffRoomRepositoryRecord) => DraftOffRoomTransactionResult<T> | Promise<DraftOffRoomTransactionResult<T>>) {
      return super.transact(roomId, async (record) => {
        const completed = await operation(record);
        assert.deepEqual(completed.lifecycle, projectDraftOffRoomLifecycle(restoreDraftOffCompetition(catalog, completed.record.serializedCompetition)));
        this.hints.push(completed.lifecycle!);
        return completed;
      });
    }
  }
  const repository = new SchedulingRepository(), clock = new FakeDraftOffClock(0);
  const service = new DraftOffRoomService(catalog, repository, clock);
  await service.createRoom(host, roomInput);
  assert.deepEqual(repository.hints.at(-1), { phase: "LOBBY", createdAtMs: 0 });
  await service.execute(member, join("join-hint", 0));
  const started = success(await service.execute(host, start("start-hint", 1)));
  assert.deepEqual(repository.hints.at(-1), { phase: "IN_PROGRESS", deadlineAtMs: 100 });
  await clock.advanceTo(100);
  assert.deepEqual(repository.hints.at(-1), { phase: "COMPLETE", completedAtMs: 100 });
  assert.deepEqual(await service.execute(host, start("start-hint", 1)), started);
  assert.deepEqual(repository.hints.at(-1), { phase: "COMPLETE", completedAtMs: 100 });
});

test("lifecycle projection only reuses hints matching authoritative phase, fields and time", () => {
  const state = startedState();
  const expected = projectDraftOffRoomLifecycle(state);
  assert.strictEqual(projectDraftOffRoomLifecycle(state, expected), expected);
  for (const hint of [
    undefined,
    Object.freeze({ phase: "LOBBY", createdAtMs: 0 }),
    Object.freeze({ phase: "IN_PROGRESS", deadlineAtMs: 101 }),
    Object.freeze({ phase: "COMPLETE", completedAtMs: 0 }),
    Object.freeze({ phase: "IN_PROGRESS", deadlineAtMs: 100, extra: true }),
    Object.freeze({ phase: "IN_PROGRESS" }),
    Object.freeze({ phase: "IN_PROGRESS", deadlineAtMs: Number.NaN }),
    Object.freeze({ get phase() { throw new Error("Hints must not execute accessors"); }, deadlineAtMs: 100 }),
    { phase: "IN_PROGRESS", deadlineAtMs: 100 },
  ]) {
    const projected = projectDraftOffRoomLifecycle(state, hint as DraftOffRoomLifecycle | undefined);
    assert.deepEqual(projected, expected);
    assert.notStrictEqual(projected, hint);
    assert.ok(Object.isFrozen(projected));
  }
  const lobby = baseState();
  assert.deepEqual(projectDraftOffRoomLifecycle(lobby, Object.freeze({ phase: "LOBBY", createdAtMs: 999 })),
    projectDraftOffRoomLifecycle(lobby));
});

test("create, join, leave and rejoin use trusted identity and preserve M2 membership", async () => {
  const repository = new InMemoryDraftOffRoomRepository();
  const clock = new FakeDraftOffClock();
  const service = new DraftOffRoomService(catalog, repository, clock);
  assert.equal((await service.createRoom(host, roomInput)).revision, 0);
  await assert.rejects(service.createRoom(host, roomInput), /already exists/);
  const joined = success(await service.execute(member, join("join", 0, "  Member  ")));
  assert.equal(joined.view!.participants.find((entry) => entry.participantId === "member")!.displayName, "Member");
  success(await service.execute(member, { roomId: "room", commandId: "leave", expectedRoomRevision: 1, command: { type: "LEAVE" } }));
  rejection(await service.execute(outsider, join("reserved", 2)), "DISPLAY_NAME_RESERVED");
  const rejoined = success(await service.execute(member, {
    roomId: "room", commandId: "rejoin", expectedRoomRevision: 2, command: { type: "JOIN" },
  }));
  assert.equal(rejoined.roomRevision, 3);
  rejection(await service.execute(host, { roomId: "room", commandId: "host-leave", expectedRoomRevision: 3, command: { type: "LEAVE" } }), "HOST_CANNOT_LEAVE");
  assert.equal(clock.pendingTaskCount(), 0);
});

test("join versus start and leave versus start obey transactional lifecycle CAS in both orders", async () => {
  for (const action of ["JOIN", "LEAVE"] as const) {
    for (const membershipFirst of [true, false]) {
      const { service } = await fixture(joinedState());
      const actor = action === "JOIN" ? outsider : member;
      const membership: DraftOffRoomCommandEnvelope = action === "JOIN"
        ? join("membership", 1, "Outsider")
        : { roomId: "room", commandId: "membership", expectedRoomRevision: 1, command: { type: "LEAVE" } };
      const calls = membershipFirst
        ? [service.execute(actor, membership), service.execute(host, start("start", 1))]
        : [service.execute(host, start("start", 1)), service.execute(actor, membership)];
      const [first, second] = await Promise.all(calls);
      success(first);
      rejection(second, "STALE_ROOM_REVISION");
      const view = await service.readRoom(host, "room");
      assert.equal(view.phase, membershipFirst ? "LOBBY" : "IN_PROGRESS");
      if (membershipFirst && action === "LEAVE") {
        rejection(await service.execute(host, start("retry-start", view.revision)), "PARTICIPANT_LIMIT");
      }
    }
  }
});

test("duplicate delivery replays original receipts even after other activity and restart", async () => {
  let restores = 0;
  const { service, repository, clock } = await fixture(startedState(), 20, {
    ...runtime, restore: (...args) => { restores += 1; return restoreDraftOffCompetition(...args); },
  });
  const envelope = spin("duplicate");
  const [first, repeated] = await Promise.all([service.execute(host, envelope), service.execute(host, envelope)]);
  assert.deepEqual(first, repeated);
  assert.equal(success(first).roomRevision, 3);
  success(await service.execute(member, spin("member")));
  const beforeRetry = restores;
  assert.deepEqual(await service.execute(host, envelope), first);
  assert.ok(restores > beforeRetry, "Duplicate reads still restore canonical M2 state");
  rejection(await service.execute(member, envelope), "COMMAND_ID_CONFLICT");
  rejection(await service.execute(host, { ...envelope, expectedDraftRevision: 2 }), "COMMAND_ID_CONFLICT");
  service.dispose();
  assert.equal(clock.pendingTaskCount(), 0);
  const restarted = new DraftOffRoomService(catalog, repository, clock);
  await restarted.resumeRoom("room");
  await restarted.resumeRoom("room");
  assert.equal(clock.pendingTaskCount(), 1);
  assert.deepEqual(await restarted.execute(host, envelope), first);
  assert.equal((await restarted.readRoom(host, "room")).revision, 4);
});

test("same-participant races use nested revisions while different participants both succeed", async () => {
  const { service } = await fixture();
  const [first, second] = await Promise.all([
    service.execute(host, spin("host-a")), service.execute(host, spin("host-b")),
  ]);
  success(first);
  rejection(second, "STALE_DRAFT_REVISION");
  const memberResult = success(await service.execute(member, spin("member-a")));
  assert.equal(memberResult.roomRevision, 4);
  assert.equal(memberResult.view!.myDraft!.revision, 2);
  const separate = await fixture();
  const results = await Promise.all([
    separate.service.execute(host, spin("host")), separate.service.execute(member, spin("member")),
  ]);
  assert.deepEqual(results.map((result) => success(result).roomRevision), [3, 4]);
  assert.equal((await separate.service.readRoom(host, "room")).myDraft!.revision, 2);
  assert.equal((await separate.service.readRoom(member, "room")).myDraft!.revision, 2);
});

test("all participant mutations reject stale nested revisions without a room revision requirement", async () => {
  const state = completeXi(startedState(), "host");
  const { service } = await fixture(state);
  for (const command of [
    { type: "SPIN" as const }, { type: "RESPIN" as const }, { type: "SUBMIT" as const },
    { type: "LOCK_PLAYER" as const, playerTeamSeasonId: "unused", battingPosition: 1 },
  ]) {
    rejection(await service.execute(host, {
      roomId: "room", commandId: `stale-${command.type}`, expectedDraftRevision: 0, command,
    }), "STALE_DRAFT_REVISION");
  }
  const lobby = await fixture(joinedState());
  rejection(await lobby.service.execute(host, start("stale-start", 0)), "STALE_ROOM_REVISION");
  const receipt = await lobby.service.execute(host, start("stale-start", 0));
  rejection(receipt, "STALE_ROOM_REVISION");
});

test("authorization and strict envelopes reject actor spoofing, system participant commands and finalization", async () => {
  const { service } = await fixture(joinedState());
  rejection(await service.execute(member, start("member-start", 1)), "FORBIDDEN");
  rejection(await service.execute(outsider, spin("outsider-spin")), "FORBIDDEN");
  rejection(await service.execute({ kind: "SYSTEM" }, spin("system-spin")), "INVALID_ACTOR");
  await assert.rejects(service.readRoom({ kind: "SYSTEM" }, "room"), /participant actor/);
  await assert.rejects(service.readRoom(outsider, "room"), /not registered/);
  await assert.rejects(service.createRoom({ kind: "SYSTEM" }, { ...roomInput, roomId: "other" }), /participant actor/);
  for (const envelope of [
    { ...start("spoof", 1), command: { type: "START", roundId: "round-1", deadlineAtMs: 100, actorParticipantId: "host" } },
    { ...spin("target"), command: { type: "SPIN", participantId: "host" } },
    { ...spin("time"), atMs: 99 },
    { ...spin("wrong-revision"), expectedRoomRevision: 1 },
    { ...spin("finalize"), command: { type: "FINALIZE_ROUND", roundId: "round-1" } },
  ]) {
    rejection(await service.execute(member, envelope as DraftOffRoomCommandEnvelope), "INVALID_COMMAND");
  }
  rejection(await service.execute(host, spin("deadline:reserved")), "INVALID_COMMAND_ID");
  rejection(await service.execute(host, { ...spin("missing"), roomId: "missing" }), "ROOM_NOT_FOUND");
});

test("queued envelopes are snapshotted and special object-key command IDs are safe", async () => {
  const { service } = await fixture();
  const envelope = spin("__proto__") as { roomId: string; commandId: string; expectedDraftRevision: number; command: { type: "SPIN" | "RESPIN" } };
  const call = service.execute(host, envelope);
  envelope.command.type = "RESPIN";
  const result = success(await call);
  assert.equal(result.view!.myDraft!.phase, "AWAITING_PICK");
  assert.deepEqual(await service.execute(host, spin("__proto__")), result);
  rejection(await service.execute(host, spin("constructor")), "STALE_DRAFT_REVISION");
});

test("last pre-deadline submission resolves early and cancels the timer", async () => {
  let state = completeXi(completeXi(startedState(), "host"), "member");
  const { service, clock, repository } = await fixture(state);
  success(await service.execute(host, submit("host-submit", state, "host")));
  assert.equal(clock.pendingTaskCount(), 1);
  await clock.advanceTo(99);
  const final = success(await service.execute(member, submit("member-submit", state, "member")));
  assert.equal(final.view!.phase, "COMPLETE");
  assert.equal(final.view!.resolution!.trigger, "ALL_SUBMITTED");
  assert.equal(clock.pendingTaskCount(), 0);
  const before = (await repository.read("room"))!.serializedCompetition;
  await clock.advanceTo(100);
  assert.equal((await repository.read("room"))!.serializedCompetition, before);
  const repeated = success(await service.execute(member, submit("new-repeat", state, "member")));
  assert.equal(repeated.changed, false);
  assert.equal(repeated.roomRevision, final.roomRevision);
});

test("manual submit at the deadline is rejected before timer delivery and auto-submits on finalization", async () => {
  const state = completeXi(startedState(), "host");
  const repository = new InMemoryDraftOffRoomRepository();
  const clock = new ManualDraftOffClock();
  const service = new DraftOffRoomService(catalog, repository, clock);
  await service.restoreRoom(serializeDraftOffCompetition(state));
  clock.time = 100;
  rejection(await service.execute(host, submit("too-late", state, "host")), "DEADLINE_REACHED");
  await clock.fire();
  const resolved = restoreDraftOffCompetition(catalog, (await repository.read("room"))!.serializedCompetition);
  assert.equal(participant(resolved, "host").status, "SUBMITTED");
  const own = participant(resolved, "host");
  if (own.status === "SUBMITTED") {
    assert.equal(own.submission.source, "DEADLINE_AUTO");
    assert.equal(own.submission.submittedAtMs, 100);
  }
  const view = await service.readRoom(host, "room");
  assert.equal(view.resolution!.contestStatus, "UNCONTESTED");
  const bytes = (await repository.read("room"))!.serializedCompetition;
  await clock.fire();
  await service.resumeRoom("room");
  assert.equal((await repository.read("room"))!.serializedCompetition, bytes);
});

test("final lock before deadline counts, whereas a lock exactly at deadline leaves an incomplete XI", async () => {
  let state = completeXi(startedState(), "host", 10);
  state = changed(state, {
    type: "APPLY_DRAFT_COMMAND", participantId: "host", atMs: 20,
    expectedDraftRevision: participant(state, "host").draftState.revision, draftCommand: { type: "SPIN" },
  });
  for (const time of [99, 100]) {
    const repository = new InMemoryDraftOffRoomRepository();
    const clock = new ManualDraftOffClock();
    const service = new DraftOffRoomService(catalog, repository, clock);
    await service.restoreRoom(serializeDraftOffCompetition(state));
    clock.time = time;
    const result = await service.execute(host, {
      roomId: "room", commandId: "last-lock", expectedDraftRevision: participant(state, "host").draftState.revision,
      command: legalLock(state, "host"),
    });
    if (time === 99) success(result);
    else rejection(result, "DEADLINE_REACHED");
    clock.time = 100;
    await clock.fire();
    const view = await service.readRoom(host, "room");
    assert.equal(view.resolution!.contestStatus, time === 99 ? "UNCONTESTED" : "NO_CONTEST");
  }
});

test("deadline-first and submit-first at the boundary both preserve deadline resolution", async () => {
  const state = completeXi(completeXi(startedState(), "host"), "member");
  for (const timerFirst of [true, false]) {
    const repository = new InMemoryDraftOffRoomRepository();
    const clock = new ManualDraftOffClock();
    const service = new DraftOffRoomService(catalog, repository, clock);
    await service.restoreRoom(serializeDraftOffCompetition(state));
    success(await service.execute(host, submit("host", state, "host")));
    clock.time = 100;
    const calls = timerFirst
      ? [clock.fire(), service.execute(member, submit("member", state, "member"))]
      : [service.execute(member, submit("member", state, "member")), clock.fire()];
    const results = await Promise.all(calls);
    if (!timerFirst) rejection(results[0]!, "DEADLINE_REACHED");
    const view = await service.readRoom(host, "room");
    assert.equal(view.resolution!.trigger, "DEADLINE");
    assert.equal(view.resolution!.contestStatus, "CONTESTED");
  }
});

test("restoration covers lobby, active, overdue and resolved states with canonical bytes", async () => {
  const resolved = changed(startedState(), { type: "FINALIZE_ROUND", roundId: "round-1", atMs: 100 });
  for (const state of [baseState(), startedState(), resolved]) {
    const { service, repository, clock } = await fixture(state, state.phase === "COMPLETE" ? 100 : 20);
    assert.equal((await repository.read("room"))!.serializedCompetition, serializeDraftOffCompetition(state));
    assert.equal((await service.readRoom(host, "room")).phase, state.phase);
    assert.equal(clock.pendingTaskCount(), state.phase === "IN_PROGRESS" ? 1 : 0);
  }
  const overdue = await fixture(startedState(), 150);
  assert.equal((await overdue.service.readRoom(host, "room")).phase, "COMPLETE");
  assert.equal(overdue.clock.pendingTaskCount(), 0);
  const fresh = new InMemoryDraftOffRoomRepository();
  const service = new DraftOffRoomService(catalog, fresh, new FakeDraftOffClock());
  const corrupt = JSON.parse(serializeDraftOffCompetition(baseState()));
  corrupt.stateHash = "0".repeat(64);
  await assert.rejects(service.restoreRoom(JSON.stringify(corrupt)), /canonical state hash/);
  assert.equal(await fresh.read("room"), undefined);
  await fresh.create("wrong-room", { serializedCompetition: serializeDraftOffCompetition(baseState()), receipts: {} });
  await assert.rejects(service.resumeRoom("wrong-room"), /room ID/);
});

test("resolution failure rolls back the final submit and permits the exact retry", async () => {
  const state = completeXi(completeXi(startedState(), "host"), "member");
  let fail = true;
  const { service, repository } = await fixture(state, 20, {
    ...runtime,
    reduce: (...args) => {
      const result = reduceDraftOffCompetition(...args);
      if (result.ok && result.state.phase === "COMPLETE" && fail) {
        fail = false;
        throw new Error("resolution interruption");
      }
      return result;
    },
  });
  success(await service.execute(host, submit("host", state, "host")));
  const before = (await repository.read("room"))!;
  const envelope = submit("last-submit", state, "member");
  await assert.rejects(service.execute(member, envelope), /resolution interruption/);
  assert.deepEqual(await repository.read("room"), before);
  assert.equal((await service.readRoom(member, "room")).participants.find((entry) => entry.participantId === "member")!.roundStatus, "DRAFTING");
  const retried = success(await service.execute(member, envelope));
  assert.equal(retried.view!.phase, "COMPLETE");
  assert.deepEqual(await service.execute(member, envelope), retried);
});

test("failed deadline resolution can be resumed and retried without partial state or a receipt", async () => {
  const state = completeXi(startedState(), "host");
  let fail = true;
  const { service, repository, clock } = await fixture(state, 20, {
    ...runtime, reduce: (...args) => {
      const result = reduceDraftOffCompetition(...args);
      if (result.ok && result.state.phase === "COMPLETE" && fail) {
        fail = false;
        throw new Error("deadline interruption");
      }
      return result;
    },
  });
  const before = (await repository.read("room"))!;
  await assert.rejects(clock.advanceTo(100), /deadline interruption/);
  assert.deepEqual(await repository.read("room"), before);
  await service.resumeRoom("room");
  assert.equal((await service.readRoom(host, "room")).phase, "COMPLETE");
  const after = (await repository.read("room"))!;
  await service.resumeRoom("room");
  assert.deepEqual(await repository.read("room"), after);
});

test("restore-first failures block reads and even retries of committed commands", async () => {
  const { service, repository } = await fixture();
  success(await service.execute(host, spin("accepted")));
  await repository.transact("room", (record) => ({
    record: { ...record, serializedCompetition: "{}" }, value: undefined,
  }));
  await assert.rejects(service.readRoom(host, "room"), /missing or unexpected fields/);
  await assert.rejects(service.execute(host, spin("accepted")), /missing or unexpected fields/);
});

test("a response lost after atomic commit is recovered without reducing again and re-arms start timing", async () => {
  class LostResponseRepository extends InMemoryDraftOffRoomRepository {
    loseNextResponse = false;
    override async transact<T>(
      roomId: string,
      operation: (record: DraftOffRoomRepositoryRecord) => DraftOffRoomTransactionResult<T> | Promise<DraftOffRoomTransactionResult<T>>,
    ): Promise<T> {
      const value = await super.transact(roomId, operation);
      if (this.loseNextResponse) {
        this.loseNextResponse = false;
        throw new Error("response lost after commit");
      }
      return value;
    }
  }
  const repository = new LostResponseRepository();
  const clock = new FakeDraftOffClock(20);
  let reductions = 0;
  const service = new DraftOffRoomService(catalog, repository, clock, {
    ...runtime, reduce: (...args) => { reductions += 1; return reduceDraftOffCompetition(...args); },
  });
  await service.restoreRoom(serializeDraftOffCompetition(joinedState()));
  repository.loseNextResponse = true;
  await assert.rejects(service.execute(host, start("start", 1)), /response lost/);
  assert.equal((await service.readRoom(host, "room")).phase, "IN_PROGRESS");
  assert.equal(clock.pendingTaskCount(), 0);
  const recovered = success(await service.execute(host, start("start", 1)));
  assert.equal(recovered.roomRevision, 2);
  assert.equal(reductions, 1);
  assert.equal(clock.pendingTaskCount(), 1);
});

test("early/spurious and repeated timer delivery cannot poison the finalization receipt", async () => {
  const repository = new InMemoryDraftOffRoomRepository();
  const clock = new ManualDraftOffClock();
  const service = new DraftOffRoomService(catalog, repository, clock);
  await service.restoreRoom(serializeDraftOffCompetition(startedState()));
  await clock.fire();
  assert.equal((await service.readRoom(host, "room")).phase, "IN_PROGRESS");
  assert.deepEqual((await repository.read("room"))!.receipts, {});
  clock.time = 100;
  await Promise.all([clock.fire(0), clock.fire(1)]);
  const record = (await repository.read("room"))!;
  const resolved = restoreDraftOffCompetition(catalog, record.serializedCompetition);
  assert.equal(resolved.revision, 3);
  assert.equal(resolved.history.filter((event) => event.command.type === "FINALIZE_ROUND").length, 1);
  assert.equal(Object.keys(record.receipts).length, 1);
});

test("resume finalizes an overdue room even when its scheduled timer has not delivered", async () => {
  const state = completeXi(startedState(), "host");
  for (const time of [100, 150]) {
    const repository = new InMemoryDraftOffRoomRepository();
    const clock = new ManualDraftOffClock();
    const service = new DraftOffRoomService(catalog, repository, clock);
    await service.restoreRoom(serializeDraftOffCompetition(state));
    assert.equal(clock.callbacks.filter((task) => !task.cancelled).length, 1);
    clock.time = time;
    await service.resumeRoom("room");
    const view = await service.readRoom(host, "room");
    assert.equal(view.phase, "COMPLETE");
    assert.equal(view.resolution!.trigger, "DEADLINE");
    assert.equal(view.resolution!.contestStatus, "UNCONTESTED");
    assert.equal(clock.callbacks.filter((task) => !task.cancelled).length, 0);
    const after = (await repository.read("room"))!;
    // Even an already-dispatched callback cannot finalize twice.
    await clock.fire();
    assert.deepEqual(await repository.read("room"), after);
  }
});

test("disposal during pending resume or start leaves deadline ownership to the replacement service", async () => {
  for (const operation of ["resume", "start"] as const) {
    const { repository, clock, service } = await fixture(operation === "resume" ? startedState() : joinedState());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const locked = new Promise<void>((resolve) => { entered = resolve; });
    const blocker = repository.transact("room", async (record) => {
      entered();
      await gate;
      return { record, value: undefined };
    });
    await locked;
    const pending = operation === "resume"
      ? service.resumeRoom("room")
      : service.execute(host, start("pending-start", 1));
    service.dispose();
    assert.equal(clock.pendingTaskCount(), 0);
    release();
    await blocker;
    await pending;
    assert.equal(clock.pendingTaskCount(), 0);
    await service.resumeRoom("room");
    assert.equal(clock.pendingTaskCount(), 0, "Disposal permanently prevents new timers");
    const replacement = new DraftOffRoomService(catalog, repository, clock);
    await replacement.resumeRoom("room");
    await replacement.resumeRoom("room");
    assert.equal(clock.pendingTaskCount(), 1);
    await clock.advanceTo(100);
    assert.equal((await replacement.readRoom(host, "room")).phase, "COMPLETE");
    assert.equal(clock.pendingTaskCount(), 0);
  }
});

test("disposed callbacks and queued timer transactions cannot finalize or re-arm timers", async () => {
  const { repository, clock, service } = await fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const locked = new Promise<void>((resolve) => { entered = resolve; });
  const blocker = repository.transact("room", async (record) => {
    entered();
    await gate;
    return { record, value: undefined };
  });
  await locked;
  const callback = clock.advanceTo(100);
  service.dispose();
  release();
  await blocker;
  await callback;
  assert.equal((await service.readRoom(host, "room")).phase, "IN_PROGRESS");
  assert.equal(clock.pendingTaskCount(), 0);
  await clock.advanceTo(100);
  assert.equal((await service.readRoom(host, "room")).phase, "IN_PROGRESS");
  const replacement = new DraftOffRoomService(catalog, repository, clock);
  await replacement.resumeRoom("room");
  assert.equal((await replacement.readRoom(host, "room")).phase, "COMPLETE");
  assert.equal(clock.pendingTaskCount(), 0);
});
