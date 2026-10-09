import { ApiError, createInput, errorReply, joinInput, publicCommand, type ApiReply, type Operation } from './contracts';
import { digest, normalizeCode, roomCode, secret } from './enrollment';
import { limits, type LimitEnv } from './limits';
export interface HttpEnv extends LimitEnv {
  ROOMS: DurableObjectNamespace;
  ALLOWED_ORIGINS?: string;
  CREATE_RATE?: RateLimit;
  ENROLLMENT_RATE?: RateLimit;
  REQUEST_RATE?: RateLimit;
}
export function route(pathname: string) {
  if (pathname === '/api/draft-off/v1/rooms') return { kind: 'CREATE' as const, method: 'POST', template: '/rooms' };
  const match = /^\/api\/draft-off\/v1\/rooms\/([^/]+)(?:\/(join|commands))?$/.exec(pathname);
  if (!match) return undefined;
  return { kind: match[2] === 'join' ? 'JOIN' as const : match[2] === 'commands' ? 'COMMAND' as const : 'READ' as const,
    method: match[2] ? 'POST' : 'GET', code: match[1], template: match[2] ? `/rooms/:code/${match[2]}` : '/rooms/:code' };
}
function allowedOrigin(request: Request, env: HttpEnv): string {
  let origins: unknown;
  try { origins = JSON.parse(env.ALLOWED_ORIGINS ?? ''); } catch { throw new ApiError(503, 'SERVICE_UNAVAILABLE'); }
  if (!Array.isArray(origins) || !origins.length || origins.some(origin => {
    try { const parsed = new URL(origin); return typeof origin !== 'string' || parsed.origin !== origin || !['https:', 'http:'].includes(parsed.protocol)
      || (parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)); }
    catch { return true; }
  })) throw new ApiError(503, 'SERVICE_UNAVAILABLE');
  const origin = request.headers.get('Origin');
  if (!origin || !origins.includes(origin)) throw new ApiError(403, 'ORIGIN_NOT_ALLOWED');
  return origin;
}
async function jsonBody(request: Request, maxBytes: number): Promise<unknown> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('Content-Type') ?? '') || request.headers.has('Content-Encoding')) throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE');
  const length = request.headers.get('Content-Length');
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw new ApiError(/^\d+$/.test(length) ? 413 : 400, /^\d+$/.test(length) ? 'PAYLOAD_TOO_LARGE' : 'INVALID_REQUEST');
  if (!request.body) throw new ApiError(400, 'INVALID_REQUEST');
  const reader = request.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new ApiError(413, 'PAYLOAD_TOO_LARGE'); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new ApiError(400, 'INVALID_REQUEST'); }
}
function response(reply: ApiReply, id: string, origin?: string, extra: Record<string, string> = {}) {
  return new Response(reply.status === 204 ? null : JSON.stringify(reply.body), { status: reply.status, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
    'X-Request-Id': id, Vary: 'Origin', ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
    ...(origin ? { 'Access-Control-Expose-Headers': 'Retry-After, X-Request-Id' } : {}),
    ...(reply.retryAfter ? { 'Retry-After': String(reply.retryAfter) } : {}), ...extra,
  } });
}
export async function handleHttp(request: Request, env: HttpEnv): Promise<Response> {
  const id = crypto.randomUUID(), start = Date.now(); let origin: string | undefined;
  let template = 'unknown', reply: ApiReply, extra: Record<string, string> = {};
  try {
    const url = new URL(request.url), selected = route(url.pathname);
    if (!selected) throw new ApiError(404, 'NOT_FOUND');
    template = selected.template;
    origin = allowedOrigin(request, env);
    if (url.search) throw new ApiError(400, 'INVALID_REQUEST');
    if ('code' in selected) normalizeCode(selected.code!);
    if (request.method === 'OPTIONS') {
      const method = request.headers.get('Access-Control-Request-Method');
      const headers = (request.headers.get('Access-Control-Request-Headers') ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
      if (method !== selected.method || headers.some(header => !['content-type', 'authorization', 'enrollment-key'].includes(header))) throw new ApiError(400, 'INVALID_REQUEST');
      reply = { status: 204, body: null };
      extra = { 'Access-Control-Allow-Methods': selected.method, 'Access-Control-Allow-Headers': 'Content-Type, Authorization, Enrollment-Key' };
    } else {
      if (request.method !== selected.method) { extra.Allow = `${selected.method}, OPTIONS`; throw new ApiError(405, 'METHOD_NOT_ALLOWED'); }
      const policy = limits(env);
      if (!env.CREATE_RATE || !env.ENROLLMENT_RATE || !env.REQUEST_RATE) throw new ApiError(503, 'SERVICE_UNAVAILABLE');
      const address = request.headers.get('CF-Connecting-IP');
      if (!address) throw new ApiError(503, 'SERVICE_UNAVAILABLE');
      const source = await digest('draft-off-edge-address-v1', address);
      if (!(await env.REQUEST_RATE.limit({ key: source })).success) throw new ApiError(429, 'RATE_LIMITED');
      const edge = selected.kind === 'CREATE' ? env.CREATE_RATE : env.ENROLLMENT_RATE;
      if ((selected.kind !== 'COMMAND' || !request.headers.has('Authorization')) && !(await edge.limit({ key: source })).success) throw new ApiError(429, 'RATE_LIMITED');
      let operation: Operation;
      if (selected.kind === 'CREATE' || selected.kind === 'JOIN') {
        if (request.headers.has('Authorization')) throw new ApiError(400, 'INVALID_REQUEST');
        const enrollmentKey = secret(request.headers.get('Enrollment-Key'));
        const body = await jsonBody(request, policy.bodyBytes);
        operation = selected.kind === 'CREATE' ? { kind: 'CREATE', roomCode: await roomCode(enrollmentKey), enrollmentKey, input: createInput(body) }
          : { kind: 'JOIN', roomCode: normalizeCode(selected.code!), enrollmentKey, input: joinInput(body) };
      } else {
        if (request.headers.has('Enrollment-Key')) throw new ApiError(400, 'INVALID_REQUEST');
        const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(request.headers.get('Authorization') ?? '');
        const credential = secret(match?.[1], true), code = normalizeCode(selected.code!);
        if (selected.kind === 'READ') {
          if (request.body || Number(request.headers.get('Content-Length') ?? 0) !== 0) throw new ApiError(400, 'INVALID_REQUEST');
          operation = { kind: 'READ', roomCode: code, credential };
        } else operation = { kind: 'COMMAND', roomCode: code, credential, input: publicCommand(await jsonBody(request, policy.bodyBytes)) };
      }
      const stub = env.ROOMS.get(env.ROOMS.idFromName(operation.roomCode)) as DurableObjectStub & { publicOperation(operation: Operation): Promise<ApiReply> };
      reply = await stub.publicOperation(operation);
      if (selected.kind === 'COMMAND' && reply.status === 401 && !(await env.ENROLLMENT_RATE.limit({ key: source })).success) throw new ApiError(429, 'RATE_LIMITED');
    }
  } catch (error) { reply = errorReply(error); }
  const code = (reply.body as { error?: { code: string } } | null)?.error?.code;
  console.info(JSON.stringify({ requestId: id, route: template, status: reply.status, ...(code ? { code } : {}), elapsedMs: Date.now() - start }));
  return response(reply, id, origin, extra);
}
