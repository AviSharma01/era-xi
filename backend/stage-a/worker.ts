import { DurableObject } from 'cloudflare:workers';
import { artifacts, manifest } from './.generated/catalogs';
import { buildScopedEraDraftCatalog } from '../../src/eraDraftScopedCatalog';
import { DraftOffRoomService } from '../../src/draftOffRoomService';
import { createDraftOffCompetition, reduceDraftOffCompetition } from '../../src/draftOffCompetition';
import { restoreDraftOffCompetition, serializeDraftOffCompetition } from '../../src/draftOffCompetitionPersistence';
import { DraftOffRoomRepositoryError, type DraftOffRoomRepository, type DraftOffRoomTransactionResult } from '../../src/draftOffRoomRepository';
import type { DraftOffClock, DraftOffRoomRepositoryRecord } from '../../src/draftOffRoomTypes';

interface Env { ROOMS: DurableObjectNamespace; STAGE_A_ONLY: string }
type Metrics = { queueMs: number; serviceMs: number; catalogMs: number; resumeMs: number; restoreCalls: number;
  restoreMs: number; reduceMs: number; serializeMs: number; storageReadMs: number; storageWriteMs: number;
  readBytes: number; writtenBytes: number; projectionAndOtherMs: number; responseSerializeMs: number };
const metrics = (): Metrics => ({ queueMs: 0, serviceMs: 0, catalogMs: 0, resumeMs: 0, restoreCalls: 0,
  restoreMs: 0, reduceMs: 0, serializeMs: 0, storageReadMs: 0, storageWriteMs: 0,
  readBytes: 0, writtenBytes: 0, projectionAndOtherMs: 0, responseSerializeMs: 0 });
const byteLength = (s: string) => new TextEncoder().encode(s).length;
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

// Stage A only. The runner adds this binding exclusively on local workerd instances.
// There is deliberately no deployable Wrangler configuration or production auth route.
export default {
  async fetch(request: Request, env: Env) {
    if (env.STAGE_A_ONLY !== 'local-workerd-fixtures-only') return new Response('Disabled', { status: 403 });
    const url = new URL(request.url), parts = url.pathname.split('/').filter(Boolean);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) return new Response('Local harness only', { status: 403 });
    if (parts[0] !== 'room' || !parts[1]) return new Response('Not found', { status: 404 });
    return env.ROOMS.get(env.ROOMS.idFromName(parts[1])).fetch(request);
  },
};

class AlarmClock implements DraftOffClock {
  private task?: { atMs: number; callback: () => void | Promise<void>; cancelled: boolean };
  constructor(private readonly readNow: () => number) {}
  nowMs() { return this.readNow(); }
  scheduleAt(atMs: number, callback: () => void | Promise<void>) {
    const task = { atMs, callback, cancelled: false }; this.task = task;
    return { cancel: () => { task.cancelled = true; if (this.task === task) this.task = undefined; } };
  }
  async deliverDue() {
    const task = this.task;
    if (!task || task.cancelled || this.nowMs() < task.atMs) return false;
    this.task = undefined;
    await task.callback();
    return true;
  }
}

class SQLiteRepository implements DraftOffRoomRepository {
  constructor(private readonly storage: DurableObjectStorage, private readonly owner: StageARoom) {}
  async load() {
    const t = performance.now();
    const serializedCompetition = await this.storage.get<string>('competition');
    if (!serializedCompetition) return undefined;
    const rows = await this.storage.list({ prefix: 'receipt:' });
    const receipts = Object.fromEntries([...rows].map(([key, value]) => [key.slice(8), value])) as DraftOffRoomRepositoryRecord['receipts'];
    const record = { serializedCompetition, receipts };
    this.owner.current.storageReadMs += performance.now() - t;
    this.owner.current.readBytes += byteLength(serializedCompetition) + byteLength(JSON.stringify(receipts));
    return freeze(record);
  }
  async create(_roomId: string, record: DraftOffRoomRepositoryRecord) {
    await this.storage.transaction(async () => {
      if (await this.storage.get('competition')) throw new DraftOffRoomRepositoryError('ROOM_ALREADY_EXISTS', 'Already exists');
      await this.commit(undefined, record);
    });
  }
  async read(_roomId: string) { return this.load(); }
  async transact<T>(_roomId: string, operation: (record: DraftOffRoomRepositoryRecord) => DraftOffRoomTransactionResult<T> | Promise<DraftOffRoomTransactionResult<T>>) {
    return this.storage.transaction(async () => {
      const record = await this.load();
      if (!record) throw new DraftOffRoomRepositoryError('ROOM_NOT_FOUND', 'Missing fixture');
      const completed = await operation(record);
      await this.commit(record, completed.record);
      return completed.value;
    });
  }
  private async commit(previous: DraftOffRoomRepositoryRecord | undefined, next: DraftOffRoomRepositoryRecord) {
    const t = performance.now();
    if (previous?.serializedCompetition !== next.serializedCompetition) {
      await this.storage.put('competition', next.serializedCompetition);
      this.owner.current.writtenBytes += byteLength(next.serializedCompetition);
    }
    // Reconcile even unchanged records: cold resume must re-arm an imported fixture.
    // This is a scheduling projection of M3's canonical accepted-event format,
    // not a reducer, legality, or resolution implementation.
    const saved = JSON.parse(next.serializedCompetition);
    const phase = saved.history.at(-1)?.resultingCompetitionPhase ?? 'LOBBY';
    const start = saved.history.find((event: any) => event.command.type === 'START_ROUND');
    const wakeAt = phase === 'IN_PROGRESS' ? start?.command.deadlineAtMs : undefined;
    const target = wakeAt === undefined ? null : wakeAt - this.owner.clockOffset;
    if ((await this.storage.getAlarm()) !== target) {
      if (target === null) await this.storage.deleteAlarm(); else await this.storage.setAlarm(target);
    }
    for (const [id, receipt] of Object.entries(next.receipts)) if (!previous || !Object.hasOwn(previous.receipts, id)) {
      await this.storage.put(`receipt:${id}`, receipt);
      this.owner.current.writtenBytes += byteLength(JSON.stringify(receipt));
    }
    if (this.owner.failBeforeCommit) {
      this.owner.failBeforeCommit = false;
      throw new Error('Stage A injected failure before durable transaction commit');
    }
    this.owner.current.storageWriteMs += performance.now() - t;
  }
}

export class StageARoom extends DurableObject<Env> {
  current = metrics();
  clockOffset = 0;
  failBeforeCommit = false;
  private service?: DraftOffRoomService;
  private clock?: AlarmClock;
  private tail: Promise<unknown> = Promise.resolve();
  private meta: any;
  private readonly instanceId = crypto.randomUUID();
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.tail.then(operation);
    this.tail = pending.catch(() => {});
    return pending;
  }
  private async initialize() {
    if (this.service) return;
    const t = performance.now();
    this.meta = await this.ctx.storage.get('meta');
    if (!this.meta) throw new Error('No fixture');
    this.clockOffset = this.meta.clockOffset;
    const entry = manifest.eras.find((e: any) => e.eraId === this.meta.eraId)!;
    const raw = artifacts[this.meta.eraId];
    if (byteLength(raw) !== entry.sizeBytes) throw new Error('Artifact size mismatch');
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)))].map(x => x.toString(16).padStart(2, '0')).join('');
    if (hash !== entry.sha256) throw new Error('Artifact hash mismatch');
    const catalog = buildScopedEraDraftCatalog(JSON.parse(raw), { eraId: entry.eraId as any, catalogFingerprint: manifest.catalogFingerprint });
    this.current.catalogMs = performance.now() - t;
    const timed = <F extends (...args: any[]) => any>(f: F, field: keyof Metrics) => ((...args: Parameters<F>) => {
      const begin = performance.now();
      try { return f(...args); } finally { (this.current[field] as number) += performance.now() - begin; }
    }) as F;
    this.clock = new AlarmClock(() => Date.now() + this.clockOffset);
    this.service = new DraftOffRoomService(catalog, new SQLiteRepository(this.ctx.storage, this), this.clock, {
      create: createDraftOffCompetition,
      reduce: timed(reduceDraftOffCompetition, 'reduceMs'),
      serialize: timed(serializeDraftOffCompetition, 'serializeMs'),
      restore: (c, s) => { this.current.restoreCalls++; return timed(restoreDraftOffCompetition, 'restoreMs')(c, s); },
    });
    const begin = performance.now();
    await this.service.resumeRoom('fixture-room');
    this.current.resumeMs = performance.now() - begin;
  }
  async fetch(request: Request): Promise<Response> {
    const receivedAt = performance.now();
    const action = new URL(request.url).pathname.split('/')[3];
    if (action === 'evict') this.ctx.abort('Stage A deliberate cold-instance reset');
    const input = request.method === 'POST' ? await request.json() as any : {};
    return this.exclusive(async () => {
      this.current = metrics(); this.current.queueMs = performance.now() - receivedAt;
      if (action === 'seed') {
        this.service?.dispose(); this.service = undefined;
        await this.ctx.storage.deleteAll();
        this.clockOffset = (input.logicalNow ?? 100) - Date.now();
        await this.ctx.storage.transaction(async () => {
          await this.ctx.storage.put('meta', { eraId: input.fixture.eraId, clockOffset: this.clockOffset });
          await this.ctx.storage.put('competition', input.fixture.record.serializedCompetition);
          for (const [id, receipt] of Object.entries(input.fixture.record.receipts)) await this.ctx.storage.put(`receipt:${id}`, receipt);
          await this.ctx.storage.deleteAlarm();
        });
        if (input.warm) await this.initialize();
        return Response.json({ seeded: true, instanceId: this.instanceId });
      }
      if (action === 'inspect') {
        const serialized = await this.ctx.storage.get<string>('competition');
        return Response.json({ instanceId: this.instanceId, alarmAt: await this.ctx.storage.getAlarm(),
          alarmReport: await this.ctx.storage.get('alarmReport'), canonical: serialized,
          receipts: Object.fromEntries(await this.ctx.storage.list({ prefix: 'receipt:' })) });
      }
      const t = performance.now();
      await this.initialize();
      const id = new URL(request.url).searchParams.get('participant') ?? 'p0';
      // Fixture-only identity mapping. Never a public product trust boundary.
      if (!/^p[0-7]$/.test(id)) return new Response('Invalid fixture participant', { status: 400 });
      const actor = { kind: 'PARTICIPANT' as const, participantId: id };
      this.failBeforeCommit = input.failBeforeCommit === true;
      let result: unknown;
      if (action === 'snapshot') result = await this.service!.readRoom(actor, 'fixture-room');
      else if (action === 'command') result = await this.service!.execute(actor, input.envelope);
      else if (action === 'resume') { await this.service!.resumeRoom('fixture-room'); result = await this.service!.readRoom(actor, 'fixture-room'); }
      else if (action === 'arm') {
        // Accelerates server elapsed time only in this harness, retaining a real
        // 15-minute domain duration and real Date.now()/alarm execution.
        this.meta.clockOffset = input.logicalNow - Date.now();
        this.clockOffset = this.meta.clockOffset;
        await this.ctx.storage.put('meta', this.meta);
        const saved = JSON.parse((await this.ctx.storage.get<string>('competition'))!);
        const deadline = saved.history.find((event: any) => event.command.type === 'START_ROUND').command.deadlineAtMs;
        const alarmAt = deadline - this.clockOffset;
        await this.ctx.storage.setAlarm(alarmAt);
        result = { armed: true, alarmAt };
      } else return new Response('Not found', { status: 404 });
      this.current.serviceMs = performance.now() - t;
      // resumeMs is an overlapping aggregate, not another exclusive phase.
      this.current.projectionAndOtherMs = this.current.serviceMs - this.current.catalogMs - this.current.restoreMs - this.current.reduceMs - this.current.serializeMs - this.current.storageReadMs - this.current.storageWriteMs;
      const serializeAt = performance.now(), text = JSON.stringify(result);
      this.current.responseSerializeMs = performance.now() - serializeAt;
      return new Response(text, { headers: { 'content-type': 'application/json', 'x-stage-a-instance': this.instanceId,
        'x-stage-a-metrics': JSON.stringify(this.current), 'x-stage-a-response-bytes': String(byteLength(text)) } });
    });
  }
  async alarm() {
    return this.exclusive(async () => {
      this.current = metrics(); const t = performance.now(), startedAt = Date.now();
      const wasCold = !this.service;
      await this.initialize();
      if (!wasCold && !await this.clock!.deliverDue()) await this.service!.resumeRoom('fixture-room');
      this.current.serviceMs = performance.now() - t;
      await this.ctx.storage.put('alarmReport', { metrics: this.current, instanceId: this.instanceId, startedAt, completedAt: Date.now() });
    });
  }
}
