import type { EraDraftCatalog } from '../../src/eraDraftData';
import { restoreDraftOffCompetition } from '../../src/draftOffCompetitionPersistence';
import { projectDraftOffRoomLifecycle, type DraftOffRoomLifecycle } from '../../src/draftOffRoomLifecycle';
import { DraftOffRoomRepositoryError, type DraftOffRoomRepository, type DraftOffRoomTransactionResult } from '../../src/draftOffRoomRepository';
import type { DraftOffRoomRepositoryRecord } from '../../src/draftOffRoomTypes';
import type { EraId } from '../../src/teamEvaluationV2';

const DAY = 86_400_000;
export const ROOM_RETENTION = Object.freeze({ lobbyMs: DAY, completedMs: 7 * DAY, retiredMs: 30 * DAY });
export type RoomDescriptor = { version: 1; roomId: string; eraId: EraId };
export type RoomWake = { kind: 'DEADLINE' | 'LOBBY_EXPIRY' | 'COMPLETED_EXPIRY'; atMs: number };
export type RetiredRoom = { version: 1; roomId: string; retiredAtMs: number; purgeAtMs: number };
export type CompanionCommit = (tx: DurableObjectTransaction, next: DraftOffRoomRepositoryRecord) => Promise<void>;

export function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freezeDeep); Object.freeze(value);
  }
  return value;
}

function restoredLifecycle(catalog: EraDraftCatalog, serialized: string, roomId: string, hint?: DraftOffRoomLifecycle) {
  const state = restoreDraftOffCompetition(catalog, serialized);
  if (state.competitionId !== roomId) throw new Error('Canonical room ID mismatch');
  return projectDraftOffRoomLifecycle(state, hint);
}

function wakeForLifecycle(lifecycle: DraftOffRoomLifecycle): RoomWake {
  const wake: RoomWake = lifecycle.phase === 'IN_PROGRESS' ? { kind: 'DEADLINE', atMs: lifecycle.deadlineAtMs }
    : lifecycle.phase === 'LOBBY' ? { kind: 'LOBBY_EXPIRY', atMs: lifecycle.createdAtMs + ROOM_RETENTION.lobbyMs }
    : { kind: 'COMPLETED_EXPIRY', atMs: lifecycle.completedAtMs + ROOM_RETENTION.completedMs };
  if (!Number.isSafeInteger(wake.atMs) || wake.atMs < 0) throw new Error('Invalid lifecycle timestamp');
  return wake;
}

async function persistWake(tx: DurableObjectTransaction, wake: RoomWake, toAlarmTime: (atMs: number) => number) {
  const previousWake = await tx.get<RoomWake>('wake');
  if (previousWake?.kind !== wake.kind || previousWake.atMs !== wake.atMs) await tx.put('wake', wake);
  const target = toAlarmTime(wake.atMs);
  if (await tx.getAlarm() !== target) await tx.setAlarm(target);
}

/** SQLite-backed DO KV API. No authoritative state cache; reads return canonical bytes. */
export class DurableDraftOffRoomRepository implements DraftOffRoomRepository {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly descriptor: RoomDescriptor,
    private readonly catalog: EraDraftCatalog,
    private readonly toAlarmTime: (atMs: number) => number = (atMs) => atMs,
    private readonly beforeCommit: () => void = () => {},
    private readonly companion: () => CompanionCommit | undefined = () => undefined,
  ) {}

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.tail.then(operation);
    this.tail = pending.catch(() => {});
    return pending;
  }
  private requireRoom(roomId: string) {
    if (roomId !== this.descriptor.roomId) throw new DraftOffRoomRepositoryError('ROOM_NOT_FOUND', 'Room does not belong to this object.');
  }
  private async load(tx: DurableObjectTransaction): Promise<DraftOffRoomRepositoryRecord | undefined> {
    const serializedCompetition = await tx.get<string>('competition');
    if (serializedCompetition === undefined) return undefined;
    const rows = await tx.list<DraftOffRoomRepositoryRecord['receipts'][string]>({ prefix: 'receipt:' });
    return freezeDeep({ serializedCompetition, receipts: Object.fromEntries([...rows].map(([key, receipt]) => [key.slice(8), receipt])) });
  }
  async create(roomId: string, record: DraftOffRoomRepositoryRecord, lifecycle?: DraftOffRoomLifecycle) {
    this.requireRoom(roomId);
    await this.exclusive(() => this.storage.transaction(async (tx) => {
      if (await tx.get('competition') !== undefined || await tx.get('retired') !== undefined) {
        throw new DraftOffRoomRepositoryError('ROOM_ALREADY_EXISTS', 'Room exists or its code is retired.');
      }
      await tx.put('descriptor', this.descriptor);
      await this.commit(tx, undefined, record, lifecycle);
    }));
  }
  async read(roomId: string) {
    this.requireRoom(roomId);
    return this.exclusive(() => this.storage.transaction((tx) => this.load(tx)));
  }
  async transact<T>(roomId: string, operation: (record: DraftOffRoomRepositoryRecord) => DraftOffRoomTransactionResult<T> | Promise<DraftOffRoomTransactionResult<T>>): Promise<T> {
    this.requireRoom(roomId);
    return this.exclusive(() => this.storage.transaction(async (tx) => {
      const previous = await this.load(tx);
      if (!previous) throw new DraftOffRoomRepositoryError('ROOM_NOT_FOUND', 'Room has expired or does not exist.');
      const completed = await operation(previous);
      await this.commit(tx, previous, completed.record, completed.lifecycle);
      return completed.value;
    }));
  }
  private async commit(tx: DurableObjectTransaction, previous: DraftOffRoomRepositoryRecord | undefined, next: DraftOffRoomRepositoryRecord, lifecycle?: DraftOffRoomLifecycle) {
    // Always restore the exact bytes being committed. The hint can only reuse a
    // matching immutable projection; it cannot supply phase/time or bypass replay.
    lifecycle = restoredLifecycle(this.catalog, next.serializedCompetition, this.descriptor.roomId, lifecycle);
    if (next.serializedCompetition !== previous?.serializedCompetition) await tx.put('competition', next.serializedCompetition);
    const removed = Object.keys(previous?.receipts ?? {}).filter((id) => !Object.hasOwn(next.receipts, id));
    if (removed.length) await tx.delete(removed.map((id) => `receipt:${id}`));
    for (const [id, receipt] of Object.entries(next.receipts)) {
      if (previous?.receipts[id] !== receipt) await tx.put(`receipt:${id}`, receipt);
    }
    await persistWake(tx, wakeForLifecycle(lifecycle), this.toAlarmTime);
    await this.companion()?.(tx, next);
    this.beforeCommit();
  }
}

/** The room operation queue owns these housekeeping calls as well as M3 operations. */
export async function expireRoom(storage: DurableObjectStorage, catalog: EraDraftCatalog, nowMs: number, toAlarmTime: (atMs: number) => number): Promise<boolean> {
  return storage.transaction(async (tx) => {
    const descriptor = await tx.get<RoomDescriptor>('descriptor');
    const serialized = await tx.get<string>('competition');
    if (!descriptor || serialized === undefined) throw new Error('Missing canonical room');
    // Stored wake metadata is advisory, including on warm paths. Verify canonical
    // phase/time again inside the same transaction as any destructive expiry.
    const wake = wakeForLifecycle(restoredLifecycle(catalog, serialized, descriptor.roomId));
    await persistWake(tx, wake, toAlarmTime);
    if (wake.kind === 'DEADLINE' || nowMs < wake.atMs) return false;
    // Anchored to expiry, not late handler delivery: a cold room cannot extend retention.
    const marker: RetiredRoom = { version: 1, roomId: descriptor.roomId, retiredAtMs: wake.atMs, purgeAtMs: wake.atMs + ROOM_RETENTION.retiredMs };
    if (!Number.isSafeInteger(marker.purgeAtMs)) throw new Error('Invalid retired marker timestamp');
    await tx.delete([...await tx.list()].map(([key]) => key));
    if (nowMs < marker.purgeAtMs) {
      await tx.put('retired', marker);
      await tx.setAlarm(toAlarmTime(marker.purgeAtMs));
    } else await tx.deleteAlarm();
    return true;
  });
}

export async function reconcileRetiredRoom(storage: DurableObjectStorage, nowMs: number, toAlarmTime: (atMs: number) => number): Promise<void> {
  await storage.transaction(async (tx) => {
    const marker = await tx.get<RetiredRoom>('retired');
    if (!marker) { if (!await tx.get('descriptor')) await tx.deleteAlarm(); return; }
    if (nowMs >= marker.purgeAtMs) { await tx.delete('retired'); await tx.deleteAlarm(); }
    else await tx.setAlarm(toAlarmTime(marker.purgeAtMs));
  });
}
