// Local integration entry point only. The production bundle never imports this module.
import { DraftOffRoom, type RoomEnv } from '../cloudflare/room';
import { DurableDraftOffRoomRepository, expireRoom, freezeDeep, type RoomWake } from '../cloudflare/repository';
import { loadRoomCatalog } from '../cloudflare/catalog';

interface TestEnv extends RoomEnv { STAGE_B_ONLY: string }
export default {
  async fetch(request: Request, env: TestEnv) {
    const url = new URL(request.url), parts = url.pathname.split('/').filter(Boolean);
    if (env.STAGE_B_ONLY !== 'local-workerd-fixtures-only' || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
      return new Response('Disabled', { status: 403 });
    }
    if (parts[0] !== 'room' || !parts[1]) return new Response('Not found', { status: 404 });
    return env.ROOMS.get(env.ROOMS.idFromName(parts[1])).fetch(request);
  },
};

export class StageBTestRoom extends DraftOffRoom {
  private offset = 0;
  private failCommit = false;
  private readonly instanceId = crypto.randomUUID();
  protected nowMs() { return Date.now() + this.offset; }
  protected toAlarmTime(atMs: number) { return atMs - this.offset; }
  protected beforeCommit() {
    if (this.failCommit) { this.failCommit = false; throw new Error('Stage B injected transaction failure'); }
  }
  private async loadClock() { this.offset = await this.ctx.storage.get<number>('test:offset') ?? 0; }
  private async retainTestClock() {
    if (await this.ctx.storage.get('retired')) await this.ctx.storage.put('test:offset', this.offset);
    else if (!await this.ctx.storage.get('descriptor')) await this.ctx.storage.delete('test:offset');
  }
  protected async existingRoom() {
    try { return await super.existingRoom(); }
    finally { await this.retainTestClock(); }
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url), action = url.pathname.split('/')[3];
    const input = request.method === 'POST' ? await request.json() as any : {};
    await this.loadClock();
    const participantId = url.searchParams.get('participant') ?? 'p0';
    if (!/^p[0-7]$/.test(participantId)) return new Response('Invalid fixture actor', { status: 400 });
    const actor = { kind: 'PARTICIPANT' as const, participantId };
    const begin = performance.now();
    let result: unknown;
    if (action === 'seed') {
      result = await this.exclusive(async () => {
        this.resetService(); await this.ctx.storage.deleteAll();
        this.offset = (input.logicalNow ?? 100) - Date.now();
        await this.ctx.storage.put('test:offset', this.offset);
        const catalog = await loadRoomCatalog(input.fixture.eraId);
        const descriptor = { version: 1 as const, roomId: 'fixture-room', eraId: input.fixture.eraId };
        const repository = new DurableDraftOffRoomRepository(this.ctx.storage, descriptor, catalog, (atMs) => this.toAlarmTime(atMs));
        await repository.create('fixture-room', input.fixture.record, freezeDeep(input.hint));
        if (input.warm !== false) await this.initialize(descriptor, true);
        return { seeded: true };
      });
    } else if (action === 'create') {
      if (input.logicalNow !== undefined) {
        this.offset = input.logicalNow - Date.now(); await this.ctx.storage.put('test:offset', this.offset);
      }
      this.failCommit = input.failBeforeCommit === true;
      result = await this.createRoom(actor, input.room);
    } else if (action === 'inspect') {
      result = await this.exclusive(async () => ({
        instanceId: this.instanceId, canonical: await this.ctx.storage.get('competition'),
        receipts: Object.fromEntries(await this.ctx.storage.list({ prefix: 'receipt:' })),
        descriptor: await this.ctx.storage.get('descriptor'), wake: await this.ctx.storage.get('wake'),
        retired: await this.ctx.storage.get('retired'), alarmAt: await this.ctx.storage.getAlarm(),
        alarmReport: await this.ctx.storage.get('test:alarmReport'),
        keys: [...await this.ctx.storage.list()].map(([key]) => key), logicalNow: this.nowMs(),
      }));
    } else if (action === 'time') {
      result = await this.exclusive(async () => {
        this.offset = input.logicalNow - Date.now();
        await this.ctx.storage.put('test:offset', this.offset);
        const wake = await this.ctx.storage.get<RoomWake>('wake');
        // Missing/late deliveries can be simulated without mutating canonical history.
        if (input.suppress) await this.ctx.storage.deleteAlarm();
        else if (input.nativeInMs !== undefined) await this.ctx.storage.setAlarm(Date.now() + input.nativeInMs);
        else if (wake) await this.ctx.storage.setAlarm(this.toAlarmTime(wake.atMs));
        return { alarmAt: await this.ctx.storage.getAlarm() };
      });
    } else if (action === 'alarm') { this.failCommit = input.failBeforeCommit === true; await this.alarm(); result = { delivered: true }; }
    else if (action === 'resume') { await this.exclusive(async () => { const s = await this.existingRoom(); await s.resumeRoom('fixture-room'); }); result = { resumed: true }; }
    else if (action === 'snapshot') result = await this.readRoom(actor, input.roomId ?? 'fixture-room');
    else if (action === 'command') {
      this.failCommit = input.failBeforeCommit === true;
      result = await this.execute(actor, input.envelope);
    } else if (action === 'hint') {
      result = await this.exclusive(async () => {
        const descriptor = (await this.ctx.storage.get<any>('descriptor'));
        const catalog = await loadRoomCatalog(descriptor.eraId);
        const repository = new DurableDraftOffRoomRepository(this.ctx.storage, descriptor, catalog,
          (atMs) => this.toAlarmTime(atMs), () => this.beforeCommit());
        this.failCommit = input.failBeforeCommit === true;
        await repository.transact(descriptor.roomId, (record) => ({ record, value: undefined, lifecycle: freezeDeep(input.hint) }));
        return { reconciled: true };
      });
    } else if (action === 'wake') {
      result = await this.exclusive(async () => {
        if (input.wake === undefined) await this.ctx.storage.delete('wake');
        else await this.ctx.storage.put('wake', input.wake);
        if (input.alarmInMs !== undefined) await this.ctx.storage.setAlarm(Date.now() + input.alarmInMs);
        return { injected: true };
      });
    } else if (action === 'expiry') {
      result = await this.exclusive(async () => {
        const descriptor = (await this.ctx.storage.get<any>('descriptor'));
        const catalog = await loadRoomCatalog(descriptor.eraId);
        const expired = await expireRoom(this.ctx.storage, catalog, this.nowMs(), (atMs) => this.toAlarmTime(atMs));
        if (expired) this.resetService();
        await this.retainTestClock();
        return { expired };
      });
    } else if (action === 'corrupt') {
      await this.exclusive(async () => { await this.ctx.storage.put('competition', '{}'); }); result = { corrupted: true };
    } else if (action === 'throw-transaction') {
      result = await this.exclusive(async () => {
        const descriptor = (await this.ctx.storage.get<any>('descriptor'));
        const catalog = await loadRoomCatalog(descriptor.eraId);
        const repository = new DurableDraftOffRoomRepository(this.ctx.storage, descriptor, catalog);
        await repository.transact(descriptor.roomId, () => { throw new Error('Callback failure'); });
      });
    } else return new Response('Not found', { status: 404 });
    return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json',
      'x-stage-a-instance': this.instanceId, 'x-stage-a-metrics': JSON.stringify({ serviceMs: performance.now() - begin }) } });
  }
  async alarm() {
    await this.loadClock();
    const startedAt = Date.now();
    await super.alarm();
    await this.retainTestClock();
    // Do not recreate fixture diagnostics after retention removed the room payload.
    if (await this.ctx.storage.get('descriptor')) await this.ctx.storage.put('test:alarmReport', { instanceId: this.instanceId, startedAt, completedAt: Date.now() });
  }
}
