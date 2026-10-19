import type { DraftOffClock, DraftOffRoomRepositoryRecord } from "./draftOffRoomTypes.js";
import type { DraftOffRoomLifecycle } from "./draftOffRoomLifecycle.js";

export class DraftOffRoomRepositoryError extends Error {
  readonly name = "DraftOffRoomRepositoryError";

  constructor(readonly code: "ROOM_NOT_FOUND" | "ROOM_ALREADY_EXISTS", message: string) {
    super(message);
  }
}

export type DraftOffRoomTransactionResult<T> = {
  readonly record: DraftOffRoomRepositoryRecord;
  readonly value: T;
  /** Optional advisory scheduling hint; adapters must verify it against restored canonical state. */
  readonly lifecycle?: DraftOffRoomLifecycle;
};

export interface DraftOffRoomRepository {
  create(roomId: string, record: DraftOffRoomRepositoryRecord, lifecycle?: DraftOffRoomLifecycle): Promise<void>;
  read(roomId: string): Promise<DraftOffRoomRepositoryRecord | undefined>;
  /** Serialize per room and atomically commit the entire returned record only on success. */
  transact<T>(
    roomId: string,
    operation: (
      record: DraftOffRoomRepositoryRecord,
    ) => DraftOffRoomTransactionResult<T> | Promise<DraftOffRoomTransactionResult<T>>,
  ): Promise<T>;
}

export class InMemoryDraftOffRoomRepository implements DraftOffRoomRepository {
  private readonly records = new Map<string, DraftOffRoomRepositoryRecord>();
  private readonly tails = new Map<string, Promise<void>>();

  async create(roomId: string, record: DraftOffRoomRepositoryRecord): Promise<void> {
    await this.exclusive(roomId, () => {
      if (this.records.has(roomId)) {
        throw new DraftOffRoomRepositoryError("ROOM_ALREADY_EXISTS", `Room ${roomId} already exists.`);
      }
      this.records.set(roomId, freezeRecord(record));
    });
  }

  async read(roomId: string): Promise<DraftOffRoomRepositoryRecord | undefined> {
    return this.exclusive(roomId, () => this.records.get(roomId));
  }

  async transact<T>(
    roomId: string,
    operation: (
      record: DraftOffRoomRepositoryRecord,
    ) => DraftOffRoomTransactionResult<T> | Promise<DraftOffRoomTransactionResult<T>>,
  ): Promise<T> {
    return this.exclusive(roomId, async () => {
      const current = this.records.get(roomId);
      if (!current) throw new DraftOffRoomRepositoryError("ROOM_NOT_FOUND", `Room ${roomId} does not exist.`);
      const completed = await operation(current);
      this.records.set(roomId, freezeRecord(completed.record));
      return completed.value;
    });
  }

  private async exclusive<T>(roomId: string, operation: () => T | Promise<T>): Promise<T> {
    const prior = this.tails.get(roomId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = prior.then(() => gate);
    this.tails.set(roomId, tail);
    await prior;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(roomId) === tail) this.tails.delete(roomId);
    }
  }
}

type FakeTask = {
  readonly id: number;
  readonly atMs: number;
  readonly callback: () => void | Promise<void>;
  cancelled: boolean;
};

export class FakeDraftOffClock implements DraftOffClock {
  private currentMs: number;
  private nextId = 1;
  private readonly tasks: FakeTask[] = [];

  constructor(initialMs = 0) {
    requireTimestamp(initialMs);
    this.currentMs = initialMs;
  }

  nowMs(): number {
    return this.currentMs;
  }

  scheduleAt(atMs: number, callback: () => void | Promise<void>) {
    requireTimestamp(atMs);
    const task: FakeTask = { id: this.nextId, atMs, callback, cancelled: false };
    this.nextId += 1;
    this.tasks.push(task);
    return Object.freeze({ cancel: () => { task.cancelled = true; } });
  }

  async advanceTo(atMs: number): Promise<void> {
    requireTimestamp(atMs);
    if (atMs < this.currentMs) throw new RangeError("Fake clock cannot move backwards.");
    this.currentMs = atMs;
    while (true) {
      const next = this.tasks
        .filter((task) => !task.cancelled && task.atMs <= this.currentMs)
        .sort((left, right) => left.atMs - right.atMs || left.id - right.id)[0];
      if (!next) return;
      next.cancelled = true;
      await next.callback();
    }
  }

  async advanceBy(durationMs: number): Promise<void> {
    requireTimestamp(durationMs);
    await this.advanceTo(this.currentMs + durationMs);
  }

  pendingTaskCount(): number {
    return this.tasks.filter((task) => !task.cancelled).length;
  }
}

function freezeRecord(record: DraftOffRoomRepositoryRecord): DraftOffRoomRepositoryRecord {
  return freezeDeep({
    serializedCompetition: record.serializedCompetition,
    receipts: { ...record.receipts },
  });
}

function requireTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("Clock time must be a non-negative safe integer.");
}

function freezeDeep<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) value.forEach(freezeDeep);
  else Object.values(value as Record<string, unknown>).forEach(freezeDeep);
  return Object.freeze(value);
}
