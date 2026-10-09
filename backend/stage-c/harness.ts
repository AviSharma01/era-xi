import { DraftOffRoom } from '../cloudflare/room';
import production from '../cloudflare/worker';
import { equalDigest } from '../cloudflare/enrollment';
import type { HttpEnv } from '../cloudflare/http';
type TestEnv = HttpEnv & { STAGE_C_ONLY: string };
/** Only the isolated test bundle exports this class and these routes. */
export class StageCTestRoom extends DraftOffRoom {
  private offset = 0;
  private fail = false;
  private lastFailure?: string;
  protected async handlePublic(operation: Parameters<DraftOffRoom['publicOperation']>[0]) {
    try { return await super.handlePublic(operation); }
    catch (error) { this.lastFailure = error instanceof Error ? error.stack : 'Unknown failure'; throw error; }
  }
  protected nowMs() { return Date.now() + this.offset; }
  protected toAlarmTime(atMs: number) { return atMs - this.offset; }
  protected beforeCommit() { if (this.fail) { this.fail = false; throw new Error('Injected commit failure'); } }
  private async loadClock() { this.offset = await this.ctx.storage.get<number>('test:offset') ?? 0; }
  async control(action: string, input: any) {
    if (action === 'legacy-create') return this.createRoom({ kind: 'PARTICIPANT', participantId: 'p0' }, {
      roomId: input.roomCode, hostDisplayName: 'Player 0', initialRound: {
        roundId: 'r1', roundOrdinal: 1, label: 'Stage B test', eraId: 'era-impact', challengeSeed: 'stage-b-test-seed',
      },
    });
    return this.exclusive(async () => {
      await this.loadClock();
      if (action === 'inspect') return { records: Object.fromEntries(await this.ctx.storage.list()), alarm: await this.ctx.storage.getAlarm() };
      if (action === 'failure') return { failure: this.lastFailure };
      if (action === 'offset') { this.offset = input.offset; await this.ctx.storage.put('test:offset', this.offset); return true; }
      if (action === 'fail') { this.fail = true; return true; }
      if (action === 'put') { await this.ctx.storage.put(input.key, input.value); return true; }
      if (action === 'delete') { await this.ctx.storage.delete(input.key); return true; }
      throw new Error('Unknown test control');
    });
  }
  async publicOperation(operation: Parameters<DraftOffRoom['publicOperation']>[0]) { await this.loadClock(); return super.publicOperation(operation); }
  async alarm() { await this.loadClock(); await super.alarm(); }
}
export default { async fetch(request: Request, env: TestEnv) {
  if (env.STAGE_C_ONLY !== 'local-workerd-fixtures-only' || !['localhost', '127.0.0.1'].includes(new URL(request.url).hostname)) return new Response(null, { status: 403 });
  const path = new URL(request.url).pathname;
  if (path === '/__test/crypto') {
    let unequalLengthThrows = false;
    try { (crypto.subtle as any).timingSafeEqual(new Uint8Array(32), new Uint8Array(31)); } catch { unequalLengthThrows = true; }
    return Response.json({ equal: equalDigest('a'.repeat(64), 'a'.repeat(64)), different: equalDigest('a'.repeat(64), 'b'.repeat(64)), unequalLengthThrows });
  }
  const match = /^\/__test\/([^/]+)\/([^/]+)$/.exec(path);
  if (match) {
    const stub = env.ROOMS.get(env.ROOMS.idFromName(match[1])) as unknown as { control(action: string, input: unknown): Promise<unknown> };
    return Response.json(await stub.control(match[2], await request.json()));
  }
  return production.fetch(request, env);
} };
