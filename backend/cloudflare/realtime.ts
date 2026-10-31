import type { DraftOffCompetitionState } from '../../src/draftOffCompetitionTypes';
import type { DraftOffRoomSnapshotMessage } from '../../src/draftOffRoomTypes';
import { projectDraftOffPublicRoom } from '../../src/draftOffRoomProjection';
import { ApiError } from './contracts';
import { normalizeCode, secret } from './enrollment';
import { allowedOrigin } from './origin';

export const REALTIME_PROTOCOL = 'draft-off.v1';
export const SOCKET_REPLACED = 4001;
export const ROOM_EXPIRED = 4004;
export type SocketAttachment = { version: 1; roomId: string; participantId: string; connectionId: string; connectedAtMs: number };

export function upgradeInput(request: Request, env: { ALLOWED_ORIGINS?: string }) {
  const origin = allowedOrigin(request, env), url = new URL(request.url);
  const route = /^\/api\/draft-off\/v1\/rooms\/([^/]+)\/realtime$/.exec(url.pathname);
  if (!route || url.search || request.method !== 'GET' || request.body || Number(request.headers.get('Content-Length') ?? 0) !== 0
    || request.headers.has('Content-Encoding') || request.headers.has('Authorization') || request.headers.has('Enrollment-Key')) throw new ApiError(400, 'INVALID_REQUEST');
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') throw new ApiError(400, 'INVALID_REQUEST');
  const protocols = (request.headers.get('Sec-WebSocket-Protocol') ?? '').split(',').map(value => value.trim());
  if (protocols.length !== 2 || protocols[0] !== REALTIME_PROTOCOL || !protocols[1].startsWith('ticket.')) throw new ApiError(401, 'AUTHENTICATION_FAILED');
  return { origin, roomCode: normalizeCode(route[1]), ticket: secret(protocols[1].slice(7), true) };
}

export function attachment(ws: WebSocket): SocketAttachment | undefined {
  const value = ws.deserializeAttachment() as SocketAttachment | null;
  if (!value || value.version !== 1 || typeof value.roomId !== 'string' || typeof value.participantId !== 'string'
    || typeof value.connectionId !== 'string' || !Number.isSafeInteger(value.connectedAtMs) || value.connectedAtMs < 0) return undefined;
  return value;
}

export function closeSocket(ws: WebSocket, code: number, reason: string) {
  try { ws.close(code, reason); } catch { /* Socket failure cannot affect authoritative work. */ }
}

export function snapshotBytes(state: DraftOffCompetitionState, nowMs: number, maxBytes: number) {
  const message: DraftOffRoomSnapshotMessage = { version: state.genesis.tierCaps ? 3 : state.genesis.format === undefined ? 1 : 2, type: 'ROOM_SNAPSHOT',
    serverTimeMs: Math.max(nowMs, state.lastAcceptedAtMs), view: projectDraftOffPublicRoom(state) };
  const serialized = JSON.stringify(message);
  if (new TextEncoder().encode(serialized).byteLength > maxBytes) throw new ApiError(503, 'TEMPORARY_UNAVAILABLE');
  return serialized;
}

export function samePublicContent(previous: DraftOffCompetitionState, next: DraftOffCompetitionState) {
  const { revision: _previous, ...before } = projectDraftOffPublicRoom(previous);
  const { revision: _next, ...after } = projectDraftOffPublicRoom(next);
  return JSON.stringify(before) === JSON.stringify(after);
}
