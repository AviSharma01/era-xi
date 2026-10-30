import type { DraftOffFormat } from './draftOffFormat.js';
import type { EraId } from './teamEvaluationV2.js';
import type { DraftOffRoomView } from './draftOffRoomTypes.js';

export type Settings = { draftMinutes: 10 | 15; format?: DraftOffFormat };
export type DraftOffInvite = { ok: true; version: 2; roomCode: string; eraId: EraId; draftMinutes: 10 | 15; format: DraftOffFormat };
export type PublicCommand =
  | { commandId: string; expectedRoomRevision: number; command: { type: 'LEAVE' | 'REJOIN' | 'START' } }
  | { commandId: string; expectedDraftRevision: number; command:
      { type: 'SPIN' | 'RESPIN' | 'SUBMIT' } |
      { type: 'LOCK_PLAYER'; playerTeamSeasonId: string; battingPosition: number } };
export type SnapshotSuccess = { ok: true; roomCode: string; participantId: string; settings: Settings; view: DraftOffRoomView; serverTimeMs: number };
