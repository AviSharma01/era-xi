import { StageCTestRoom } from '../stage-c/harness';
import production from '../cloudflare/worker';
import type { HttpEnv } from '../cloudflare/http';
type TestEnv = HttpEnv & { STAGE_D_ONLY: string };

/** Loopback-only fixture bundle. Never imported into production. */
export class StageDTestRoom extends StageCTestRoom {
  private instanceId = crypto.randomUUID();
  async fetch(request: Request) { await this.loadClock(); return super.fetch(request); }
  async stageDControl(action: string, input: any) {
    if (action === 'instance') return this.exclusive(async () => ({ instanceId: this.instanceId, sockets: this.ctx.getWebSockets().length,
      attachments: this.ctx.getWebSockets().map(ws => ws.deserializeAttachment()) }));
    if (action === 'alarm') { await this.alarm(); return true; }
    return super.control(action, input);
  }
}
export default { async fetch(request: Request, env: TestEnv) {
  if (env.STAGE_D_ONLY !== 'local-workerd-fixtures-only' || !['localhost', '127.0.0.1'].includes(new URL(request.url).hostname)) return new Response(null, { status: 403 });
  const match = /^\/__test\/([^/]+)\/([^/]+)$/.exec(new URL(request.url).pathname);
  if (match) {
    const stub = env.ROOMS.get(env.ROOMS.idFromName(match[1])) as unknown as { stageDControl(action: string, input: unknown): Promise<unknown> };
    return Response.json(await stub.stageDControl(match[2], await request.json()));
  }
  return production.fetch(request, env);
} };
