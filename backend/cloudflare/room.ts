import { DurableObject } from 'cloudflare:workers';
import type { EraDraftCatalog } from '../../src/eraDraftData';
import { DraftOffRoomService } from '../../src/draftOffRoomService';
import { DraftOffRoomRepositoryError } from '../../src/draftOffRoomRepository';
import type { CreateDraftOffRoomInput, DraftOffRoomActor, DraftOffRoomCommandEnvelope } from '../../src/draftOffRoomTypes';
import { loadRoomCatalog } from './catalog';
import { DurableDraftOffClock } from './clock';
import { DurableDraftOffRoomRepository, expireRoom, reconcileRetiredRoom, type RoomDescriptor, type RoomWake } from './repository';
import type { CompanionCommit } from './repository';
import { restoreDraftOffCompetition } from '../../src/draftOffCompetitionPersistence';
import { projectDraftOffRoom } from '../../src/draftOffRoomProjection';
import { ApiError, commandReply, errorReply, type Operation, type ApiReply, type Settings, type SafeEnrollment } from './contracts';
import { digest, enrollmentDigest, equalDigest, participantId, randomSecret, recoveryContext, recover, roomCode, seal, verifier,
  type AuthRecord, type EnrollmentRecord } from './enrollment';
import { consume, limits, type LimitEnv } from './limits';
import { retainNegativeResult } from './negativeResults';

export interface RoomEnv extends LimitEnv { ROOMS: DurableObjectNamespace }

/** Internal trusted RPCs plus the adapter-local guest enrollment/authentication boundary. */
export class DraftOffRoom extends DurableObject<RoomEnv> {
  protected service?: DraftOffRoomService;
  protected clock?: DurableDraftOffClock;
  protected descriptor?: RoomDescriptor;
  protected catalog?: EraDraftCatalog;
  private tail: Promise<unknown> = Promise.resolve();
  private companion?: CompanionCommit;
  private outstanding = 0;
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
      (atMs) => this.toAlarmTime(atMs), () => this.beforeCommit(), () => this.companion);
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
  /** Public adapter boundary: receives validated transport data, never a browser actor. */
  async publicOperation(operation: Operation): Promise<ApiReply> {
    try {
      const policy = limits(this.env);
      if (this.outstanding >= policy.outstandingOperations) throw new ApiError(429, 'RATE_LIMITED');
      this.outstanding++;
      try { return await this.exclusive(() => this.handlePublic(operation)); }
      finally { this.outstanding--; }
    } catch (error) { return errorReply(error); }
  }
  private async liveRoom(enrollment = false) {
    try { return await this.existingRoom(); }
    catch (error) {
      if (error instanceof DraftOffRoomRepositoryError && error.code === 'ROOM_NOT_FOUND') {
        throw new ApiError(enrollment ? 404 : 401, enrollment ? 'ROOM_UNAVAILABLE' : 'AUTHENTICATION_FAILED');
      }
      throw error;
    }
  }
  protected async handlePublic(operation: Operation): Promise<ApiReply> {
    if (!this.env.ROOMS.idFromName(operation.roomCode).equals(this.ctx.id)) throw new ApiError(400, 'INVALID_REQUEST');
    if (operation.kind === 'CREATE' || operation.kind === 'JOIN') return this.enroll(operation);
    const hash = await verifier(operation.roomCode, operation.credential);
    const auth = await this.ctx.storage.get<AuthRecord>(`api:auth:${hash}`);
    const matches = equalDigest(hash, auth?.verifier ?? '0'.repeat(64));
    if (!matches || auth?.version !== 1 || auth.roomCode !== operation.roomCode) throw new ApiError(401, 'AUTHENTICATION_FAILED');
    const service = await this.liveRoom();
    const actor = { kind: 'PARTICIPANT' as const, participantId: auth.participantId };
    const policy = limits(this.env);
    await consume(this.ctx.storage, `${operation.kind}:${auth.participantId}`, this.nowMs(),
      operation.kind === 'READ' ? policy.readsPerMinute : policy.commandsPerMinute,
      operation.kind === 'READ' ? policy.readBurst : policy.commandBurst);
    const settings = await this.ctx.storage.get<Settings>('api:settings');
    if (!settings || ![10, 15].includes(settings.draftMinutes)) throw new ApiError(503, 'TEMPORARY_UNAVAILABLE');
    if (operation.kind === 'READ') return { status: 200, body: { ok: true, roomCode: operation.roomCode,
      participantId: auth.participantId, settings, view: await service.readRoom(actor, operation.roomCode) } };
    const input = operation.input;
    const fingerprint = await digest('draft-off-http-command-v1', operation.roomCode, actor, input);
    const mappingKey = `api:command:${input.commandId}`;
    const existing = await this.ctx.storage.get<{ fingerprint: string; envelope: DraftOffRoomCommandEnvelope }>(mappingKey);
    if (existing && !equalDigest(existing.fingerprint, fingerprint)) {
      // Ask M3 for the actor-safe conflict projection; never replay another actor's envelope.
      const result = await service.execute(actor, this.directEnvelope(operation.roomCode, input));
      return result.ok ? errorReply(new ApiError(409, 'COMMAND_ID_CONFLICT')) : commandReply(result);
    }
    const countKey = `api:command-count:${auth.participantId}`;
    const count = await this.ctx.storage.get<number>(countKey) ?? 0;
    if (!existing && count >= policy.participantCommandIds) throw new ApiError(429, 'RATE_LIMITED');
    let envelope = existing?.envelope;
    if (!envelope) {
      envelope = this.directEnvelope(operation.roomCode, input);
      if (input.command.type === 'START') {
        const canonical = await this.ctx.storage.get<string>('competition');
        const state = restoreDraftOffCompetition(this.catalog!, canonical!);
        const view = await service.readRoom(actor, operation.roomCode);
        envelope = { roomId: operation.roomCode, commandId: input.commandId,
          expectedRoomRevision: (input as { expectedRoomRevision: number }).expectedRoomRevision,
          command: { type: 'START', roundId: view.round.roundId,
            deadlineAtMs: Math.max(this.nowMs(), state.lastAcceptedAtMs) + settings.draftMinutes * 60_000 } };
      }
    }
    const stableEnvelope = envelope;
    this.companion = async (tx, next) => {
      if (!Object.hasOwn(next.receipts, input.commandId)) return;
      const receipt = next.receipts[input.commandId];
      if (!await tx.get(mappingKey)) {
        await tx.put(mappingKey, { fingerprint, envelope: stableEnvelope });
        if (receipt.result.ok) await tx.put(countKey, count + 1);
        else await retainNegativeResult(tx, { mappingKey, receiptId: input.commandId }, policy.negativeResultRecords);
      }
    };
    try { return commandReply(await service.execute(actor, envelope)); }
    finally { this.companion = undefined; }
  }
  private directEnvelope(roomId: string, input: import('./contracts').PublicCommand): DraftOffRoomCommandEnvelope {
    if ('expectedRoomRevision' in input) return { roomId, commandId: input.commandId, expectedRoomRevision: input.expectedRoomRevision,
      command: input.command.type === 'REJOIN' ? { type: 'JOIN' } : input.command.type === 'START'
        ? { type: 'START', roundId: 'invalid', deadlineAtMs: 0 } : { type: 'LEAVE' } };
    return { roomId, commandId: input.commandId, expectedDraftRevision: input.expectedDraftRevision, command: { ...input.command } };
  }
  private async enroll(operation: Extract<Operation, { kind: 'CREATE' | 'JOIN' }>): Promise<ApiReply> {
    const { kind, enrollmentKey, roomCode: code, input } = operation;
    const policy = limits(this.env);
    if (kind === 'CREATE' && await roomCode(enrollmentKey) !== code) throw new ApiError(400, 'INVALID_REQUEST');
    const fullDigest = await enrollmentDigest(kind, code, enrollmentKey);
    const key = kind === 'CREATE' ? 'api:create' : `api:enrollment:${fullDigest}`;
    const fingerprint = await digest('draft-off-http-enrollment-v1', kind, code, input);
    let service: DraftOffRoomService | undefined;
    if (await this.ctx.storage.get('descriptor')) {
      try { service = await this.existingRoom(); }
      catch (error) { if (!(error instanceof DraftOffRoomRepositoryError)) throw error; }
    }
    await reconcileRetiredRoom(this.ctx.storage, this.nowMs(), atMs => this.toAlarmTime(atMs));
    const previous = await this.ctx.storage.get<EnrollmentRecord>(key);
    if (previous) {
      if (!service || previous.version !== 1) throw new ApiError(503, 'TEMPORARY_UNAVAILABLE');
      if (!equalDigest(previous.enrollmentDigest, fullDigest)) throw new ApiError(409, 'ROOM_CODE_COLLISION');
      if (!equalDigest(previous.fingerprint, fingerprint)) throw new ApiError(409, 'ENROLLMENT_KEY_CONFLICT');
      return recover(previous, enrollmentKey, kind, code);
    }
    if (kind === 'CREATE') {
      if (service || await this.ctx.storage.get('retired')) throw new ApiError(409, 'ROOM_CODE_UNAVAILABLE');
    } else {
      service = await this.liveRoom(true);
      await consume(this.ctx.storage, 'enrollment', this.nowMs(), policy.roomEnrollmentsPerMinute, policy.roomEnrollmentBurst);
      if ((await this.ctx.storage.get<number>('api:enrollment-count') ?? 0) >= policy.enrollmentRecords) throw new ApiError(429, 'RATE_LIMITED');
    }
    const id = participantId(), credential = randomSecret();
    const hash = await verifier(code, credential);
    const sealed = await seal(enrollmentKey, recoveryContext(kind, code, id, fingerprint), credential);
    const actor = { kind: 'PARTICIPANT' as const, participantId: id };
    const settings: Settings = kind === 'CREATE' ? { draftMinutes: operation.input.draftMinutes }
      : (await this.ctx.storage.get<Settings>('api:settings'))!;
    if (!settings || ![10, 15].includes(settings.draftMinutes)) throw new ApiError(503, 'TEMPORARY_UNAVAILABLE');
    const commandId = `enroll:join:${fullDigest}`;
    this.companion = async (tx, next) => {
      const receipt = kind === 'JOIN' ? next.receipts[commandId] : undefined;
      if (kind === 'JOIN' && !receipt) return;
      if (await tx.get(key)) return;
      const success = kind === 'CREATE' || receipt!.result.ok;
      let reply: ApiReply;
      if (success) {
        const view = kind === 'CREATE'
          ? projectDraftOffRoom(this.catalog!, restoreDraftOffCompetition(this.catalog!, next.serializedCompetition), id)
          : (receipt!.result as { view: NonNullable<SafeEnrollment['view']> }).view;
        reply = { status: 201, body: { ok: true, roomCode: code, participantId: id, settings, view } satisfies SafeEnrollment };
        await tx.put(`api:auth:${hash}`, { version: 1, roomCode: code, participantId: id, verifier: hash } satisfies AuthRecord);
        if (kind === 'CREATE') await tx.put('api:settings', settings);
      } else reply = commandReply(receipt!.result);
      await tx.put(key, { version: 1, enrollmentDigest: fullDigest, fingerprint, participantId: id, reply,
        ...(success ? { sealed } : {}) } satisfies EnrollmentRecord);
      if (success) await tx.put('api:enrollment-count', (await tx.get<number>('api:enrollment-count') ?? 0) + 1);
      else await retainNegativeResult(tx, { mappingKey: key, receiptId: commandId }, policy.negativeResultRecords);
    };
    try {
      if (kind === 'CREATE') {
        this.resetService();
        await this.initialize({ version: 1, roomId: code, eraId: operation.input.eraId }, false);
        await this.service!.createRoom(actor, { roomId: code, hostDisplayName: input.displayName,
          initialRound: { roundId: 'r1', roundOrdinal: 1, label: 'Era XI Draft-Off', eraId: operation.input.eraId, challengeSeed: randomSecret() } });
      } else {
        const canonical = await this.ctx.storage.get<string>('competition');
        const state = restoreDraftOffCompetition(this.catalog!, canonical!);
        await service!.execute(actor, { roomId: code, commandId, expectedRoomRevision: state.revision, command: { type: 'JOIN', displayName: input.displayName } });
      }
      const record = await this.ctx.storage.get<EnrollmentRecord>(key);
      if (!record) throw new Error('Missing enrollment commit');
      return await recover(record, enrollmentKey, kind, code);
    } catch (error) {
      if (kind === 'CREATE') this.resetService();
      throw error;
    } finally { this.companion = undefined; }
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
