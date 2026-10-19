import { DurableObject } from 'cloudflare:workers';
export class ProtocolProbe extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/notify') {
      for (const ws of this.ctx.getWebSockets()) ws.send('after-hibernation');
      return new Response('ok');
    }
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('<!doctype html><title>Protocol probe</title>', { headers: { 'Content-Type': 'text/html' } });
    const protocols = (request.headers.get('Sec-WebSocket-Protocol') ?? '').split(',').map(value => value.trim());
    if (url.search || protocols.length !== 2 || protocols[0] !== 'draft-off.v1' || !/^ticket\.[A-Za-z0-9_-]{43}$/.test(protocols[1])) return new Response(null, { status: 400 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ version: 1 });
    return new Response(null, { status: 101, webSocket: pair[0], headers: { 'Sec-WebSocket-Protocol': 'draft-off.v1' } });
  }
}
export default { fetch(request, env) { return env.ROOMS.get(env.ROOMS.idFromName('probe')).fetch(request); } };
