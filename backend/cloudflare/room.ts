import { DurableObject } from 'cloudflare:workers';
import type { EraDraftCatalog } from '../../src/eraDraftData';
import { DraftOffRoomService } from '../../src/draftOffRoomService';
import { DraftOffRoomRepositoryError } from '../../src/draftOffRoomRepository';
import type { CreateDraftOffRoomInput, DraftOffRoomActor, DraftOffRoomCommandEnvelope } from '../../src/draftOffRoomTypes';
import { loadRoomCatalog } from './catalog';
import { DurableDraftOffClock } from './clock';
import { DurableDraftOffRoomRepository, expireRoom, reconcileRetiredRoom, type RoomDescriptor, type RoomWake } from './repository';

export interface RoomEnv { ROOMS: DurableObjectNamespace }

/** Internal Worker/DO boundary. Actors must come from a future trusted authentication adapter. */
export class DraftOffRoom extends DurableObject<RoomEnv> {
  protected service?: DraftOffRoomService;
  protected clock?: DurableDraftOffClock;
  protected descriptor?: RoomDescriptor;
  protected catalog?: EraDraftCatalog;
  private tail: Promise<unknown> = Promise.resolve();
  protected nowMs() { return Date.now(); }
  protected toAlarmTime(atMs: number) { return atMs; }
  protected beforeCommit() {}
  protected async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.tail.then(operation);
    this.tail = pending.catch(() => {});
    return pending;
  }
  protected resetService() {
    this.service?.dispose(); this.service = undefined; this.clock = undefined; this.descriptor = undefined; this.catalog = undefined;
  }
  protected async initialize(descriptor: RoomDescriptor, resume: boolean) {
    if (this.service) return;
    if (descriptor.version !== 1 || !descriptor.roomId || descriptor.roomId !== descriptor.roomId.trim()) throw new Error('Invalid room descriptor');
    const catalog = await loadRoomCatalog(descriptor.eraId);
    const clock = new DurableDraftOffClock(() => this.nowMs());
    const repository = new DurableDraftOffRoomRepository(this.ctx.storage, descriptor, catalog,
      (atMs) => this.toAlarmTime(atMs), () => this.beforeCommit());
    const service = new DraftOffRoomService(catalog, repository, clock);
    try {
      if (resume) await service.resumeRoom(descriptor.roomId);
      this.descriptor = descriptor; this.catalog = catalog; this.clock = clock; this.service = service;
    } catch (error) { service.dispose(); throw error; }
  }
  protected async existingRoom() {
    const descriptor = await this.ctx.storage.get<RoomDescriptor>('descriptor');
    if (!descriptor) {
      await reconcileRetiredRoom(this.ctx.storage, this.nowMs(), (atMs) => this.toAlarmTime(atMs));
      throw new DraftOffRoomRepositoryError('ROOM_NOT_FOUND', 'Room has expired or does not exist.');
    }
    await this.initialize(descriptor, true);
    if (await expireRoom(this.ctx.storage, this.catalog!, this.nowMs(), (atMs) => this.toAlarmTime(atMs))) {
      this.resetService();
      throw new DraftOffRoomRepositoryError('ROOM_NOT_FOUND', 'Room has expired.');
    }
    const wake = await this.ctx.storage.get<RoomWake>('wake'); // Repaired from canonical state above.
    if (wake?.kind === 'DEADLINE' && this.nowMs() >= wake.atMs) await this.service!.resumeRoom(descriptor.roomId);
    return this.service!;
  }
  async createRoom(actor: DraftOffRoomActor, input: CreateDraftOffRoomInput) {
    return this.exclusive(async () => {
      if (!this.env.ROOMS.idFromName(input.roomId).equals(this.ctx.id)) throw new Error('Room must use its own Durable Object');
      if (await this.ctx.storage.get('descriptor')) {
        // Enforce expiry on access even if native delivery was delayed.
        await this.existingRoom().catch((error) => { if (!(error instanceof DraftOffRoomRepositoryError)) throw error; });
      }
      await reconcileRetiredRoom(this.ctx.storage, this.nowMs(), (atMs) => this.toAlarmTime(atMs));
      if (await this.ctx.storage.get('descriptor') || await this.ctx.storage.get('retired')) {
        throw new DraftOffRoomRepositoryError('ROOM_ALREADY_EXISTS', 'Room exists or its code is retired.');
      }
      this.resetService();
      await this.initialize({ version: 1, roomId: input.roomId, eraId: input.initialRound.eraId }, false);
      try { return await this.service!.createRoom(actor, input); }
      catch (error) { this.resetService(); throw error; }
    });
  }
  async readRoom(actor: DraftOffRoomActor, roomId: string) {
    return this.exclusive(async () => (await this.existingRoom()).readRoom(actor, roomId));
  }
  async execute(actor: DraftOffRoomActor, envelope: DraftOffRoomCommandEnvelope) {
    return this.exclusive(async () => (await this.existingRoom()).execute(actor, envelope));
  }
  async alarm() {
    return this.exclusive(async () => {
      const descriptor = await this.ctx.storage.get<RoomDescriptor>('descriptor');
      if (!descriptor) return reconcileRetiredRoom(this.ctx.storage, this.nowMs(), (atMs) => this.toAlarmTime(atMs));
      const cold = !this.service;
      await this.initialize(descriptor, true); // M3 performs cold overdue resolution.
      if (!cold && !await this.clock!.deliverDue()) await this.service!.resumeRoom(descriptor.roomId);
      if (await expireRoom(this.ctx.storage, this.catalog!, this.nowMs(), (atMs) => this.toAlarmTime(atMs))) this.resetService();
    });
  }
  async fetch(_request: Request) { return new Response('No public room API in Stage B', { status: 404 }); }
}
