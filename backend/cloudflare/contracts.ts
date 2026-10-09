import { ERA_IDS, type EraId } from '../../src/teamEvaluationV2';
import type { DraftOffRoomCommandResult, DraftOffRoomView } from '../../src/draftOffRoomTypes';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export type Settings = { draftMinutes: 10 | 15 };
export type CreateInput = Settings & { displayName: string; eraId: EraId };
export type PublicCommand =
  | { commandId: string; expectedRoomRevision: number; command: { type: 'LEAVE' | 'REJOIN' | 'START' } }
  | { commandId: string; expectedDraftRevision: number; command:
      { type: 'SPIN' | 'RESPIN' | 'SUBMIT' } |
      { type: 'LOCK_PLAYER'; playerTeamSeasonId: string; battingPosition: number } };
export type Operation =
  | { kind: 'CREATE'; roomCode: string; enrollmentKey: string; input: CreateInput }
  | { kind: 'JOIN'; roomCode: string; enrollmentKey: string; input: { displayName: string } }
  | { kind: 'READ'; roomCode: string; credential: string }
  | { kind: 'COMMAND'; roomCode: string; credential: string; input: PublicCommand };
export type ApiFailure = { ok: false; error: { code: string; message: string }; roomRevision?: number; view?: DraftOffRoomView };
export type SnapshotSuccess = { ok: true; roomCode: string; participantId: string; settings: Settings; view: DraftOffRoomView };
export type ApiBody = EnrollmentSuccess | SnapshotSuccess | Extract<DraftOffRoomCommandResult, { ok: true }> | ApiFailure | null;
export type ApiReply = { status: number; body: ApiBody; retryAfter?: number };
export type EnrollmentSuccess = { ok: true; roomCode: string; participantId: string;
  reconnectCredential: string; settings: Settings; view: DraftOffRoomView };
export type SafeEnrollment = Omit<EnrollmentSuccess, 'reconnectCredential'>;

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'INVALID_REQUEST');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new ApiError(400, 'INVALID_REQUEST');
}
export function displayName(value: unknown): string {
  if (typeof value !== 'string') throw new ApiError(400, 'INVALID_REQUEST');
  const name = value.trim();
  if (!name || [...name].length > 64 || /[\u0000-\u001f\u007f-\u009f]/u.test(name)) throw new ApiError(400, 'INVALID_REQUEST');
  return name;
}
export function createInput(value: unknown): CreateInput {
  const input = object(value); keys(input, ['displayName', 'eraId'], ['draftMinutes']);
  const minutes = input.draftMinutes === undefined ? 15 : input.draftMinutes;
  if (!ERA_IDS.includes(input.eraId as EraId) || (minutes !== 10 && minutes !== 15)) throw new ApiError(400, 'INVALID_REQUEST');
  return { displayName: displayName(input.displayName), eraId: input.eraId as EraId, draftMinutes: minutes };
}
export function joinInput(value: unknown) { const input = object(value); keys(input, ['displayName']); return { displayName: displayName(input.displayName) }; }
export function publicCommand(value: unknown): PublicCommand {
  const input = object(value), command = object(input.command);
  const lifecycle = ['LEAVE', 'REJOIN', 'START'].includes(command.type as string);
  const revision = lifecycle ? 'expectedRoomRevision' : 'expectedDraftRevision';
  keys(input, ['commandId', revision, 'command']);
  if (typeof input.commandId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(input.commandId)
      || !Number.isSafeInteger(input[revision]) || (input[revision] as number) < 0) throw new ApiError(400, 'INVALID_REQUEST');
  if (command.type === 'LOCK_PLAYER') {
    keys(command, ['type', 'playerTeamSeasonId', 'battingPosition']);
    if (typeof command.playerTeamSeasonId !== 'string' || !command.playerTeamSeasonId || command.playerTeamSeasonId.length > 160
        || command.playerTeamSeasonId !== command.playerTeamSeasonId.trim() || !Number.isSafeInteger(command.battingPosition)
        || (command.battingPosition as number) < 1 || (command.battingPosition as number) > 11) throw new ApiError(400, 'INVALID_REQUEST');
  } else {
    keys(command, ['type']);
    if (!['LEAVE', 'REJOIN', 'START', 'SPIN', 'RESPIN', 'SUBMIT'].includes(command.type as string)) throw new ApiError(400, 'INVALID_REQUEST');
  }
  const commandId = input.commandId as string;
  if (lifecycle) return { commandId, expectedRoomRevision: input.expectedRoomRevision as number,
    command: { type: command.type as 'LEAVE' | 'REJOIN' | 'START' } };
  return { commandId, expectedDraftRevision: input.expectedDraftRevision as number,
    command: command.type === 'LOCK_PLAYER' ? { type: 'LOCK_PLAYER', playerTeamSeasonId: command.playerTeamSeasonId as string,
      battingPosition: command.battingPosition as number } : { type: command.type as 'SPIN' | 'RESPIN' | 'SUBMIT' } };
}
const messages: Record<string, string> = {
  INVALID_REQUEST: 'Invalid request.', AUTHENTICATION_FAILED: 'Authentication failed.',
  ORIGIN_NOT_ALLOWED: 'Origin is not allowed.', NOT_FOUND: 'Not found.', ROOM_UNAVAILABLE: 'Room is unavailable.',
  METHOD_NOT_ALLOWED: 'Method is not allowed.', PAYLOAD_TOO_LARGE: 'Payload is too large.',
  UNSUPPORTED_MEDIA_TYPE: 'Unsupported media type.', RATE_LIMITED: 'Request limit reached.',
  ENROLLMENT_KEY_CONFLICT: 'Enrollment key was used for different input.', ROOM_CODE_COLLISION: 'Room code collision. Use a new enrollment key.',
  ROOM_CODE_UNAVAILABLE: 'Room code is unavailable.', TEMPORARY_UNAVAILABLE: 'Temporarily unavailable. Retry the same request.',
  SERVICE_UNAVAILABLE: 'Service is unavailable.',
};
const conflictCodes = new Set(['COMMAND_ID_CONFLICT', 'STALE_ROOM_REVISION', 'STALE_DRAFT_REVISION', 'INVALID_PHASE',
  'DISPLAY_NAME_RESERVED', 'PARTICIPANT_LIMIT', 'PARTICIPANT_FINALIZED', 'DEADLINE_REACHED', 'PARTICIPANT_NOT_JOINED']);
const forbiddenCodes = new Set(['FORBIDDEN', 'NOT_HOST', 'HOST_CANNOT_LEAVE']);
const invalidCodes = new Set(['INVALID_COMMAND', 'INVALID_COMMAND_ID', 'INVALID_DISPLAY_NAME']);
export function errorReply(error: unknown): ApiReply {
  const known = error instanceof ApiError ? error : new ApiError(503, 'TEMPORARY_UNAVAILABLE');
  return { status: known.status, body: { ok: false, error: { code: known.code, message: messages[known.code] ?? 'Request rejected.' } },
    ...(known.status === 429 ? { retryAfter: 60 } : {}) };
}
export function commandReply(result: DraftOffRoomCommandResult): ApiReply {
  if (result.ok) return { status: 200, body: result };
  const status = conflictCodes.has(result.code) ? 409 : forbiddenCodes.has(result.code) ? 403 : invalidCodes.has(result.code) ? 400
    : ['INCOMPLETE_XI', 'ERA_DRAFT_COMMAND_REJECTED'].includes(result.code) ? 422 : result.code === 'ROOM_NOT_FOUND' ? 404 : 503;
  const code = status === 503 ? 'TEMPORARY_UNAVAILABLE' : result.code === 'ROOM_NOT_FOUND' ? 'ROOM_UNAVAILABLE' : result.code;
  return { status, body: { ok: false, error: { code, message: messages[code] ?? 'Command rejected.' },
    ...(result.roomRevision === undefined ? {} : { roomRevision: result.roomRevision }), ...(result.view ? { view: result.view } : {}) } };
}
