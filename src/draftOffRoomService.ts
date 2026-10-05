import { canonicalSha256 } from "./eraDraftCanonical.js";
import type { EraDraftCatalog } from "./eraDraftData.js";
import { createDraftOffCompetition, reduceDraftOffCompetition } from "./draftOffCompetition.js";
import {
  restoreDraftOffCompetition,
  serializeDraftOffCompetition,
} from "./draftOffCompetitionPersistence.js";
import type {
  DraftOffCompetitionCommand,
  DraftOffCompetitionState,
} from "./draftOffCompetitionTypes.js";
import { projectDraftOffRoom } from "./draftOffRoomProjection.js";
import {
  DraftOffRoomRepositoryError,
  type DraftOffRoomRepository,
} from "./draftOffRoomRepository.js";
import type {
  CreateDraftOffRoomInput,
  DraftOffClock,
  DraftOffRoomActor,
  DraftOffRoomCommandEnvelope,
  DraftOffRoomCommandResult,
  DraftOffRoomLifecycleEnvelope,
  DraftOffRoomRepositoryRecord,
  DraftOffRoomView,
  DraftOffScheduledTask,
} from "./draftOffRoomTypes.js";

export type DraftOffRoomRuntime = {
  readonly create: typeof createDraftOffCompetition;
  readonly reduce: typeof reduceDraftOffCompetition;
  readonly serialize: typeof serializeDraftOffCompetition;
  readonly restore: typeof restoreDraftOffCompetition;
};

const DEFAULT_RUNTIME: DraftOffRoomRuntime = {
  create: createDraftOffCompetition,
  reduce: reduceDraftOffCompetition,
  serialize: serializeDraftOffCompetition,
  restore: restoreDraftOffCompetition,
};

type ScheduledDeadline = {
  readonly roundId: string;
  readonly deadlineAtMs: number;
  readonly task: DraftOffScheduledTask;
};

export class DraftOffRoomService {
  private readonly scheduledDeadlines = new Map<string, ScheduledDeadline>();
  private disposed = false;

  constructor(
    private readonly catalog: EraDraftCatalog,
    private readonly repository: DraftOffRoomRepository,
    private readonly clock: DraftOffClock,
    private readonly runtime: DraftOffRoomRuntime = DEFAULT_RUNTIME,
  ) {}

  async createRoom(actor: DraftOffRoomActor, input: CreateDraftOffRoomInput): Promise<DraftOffRoomView> {
    const participantId = requireParticipantActor(actor);
    const createdAtMs = authoritativeClockTime(this.clock.nowMs(), 0);
    const state = this.runtime.create(this.catalog, {
      competitionId: input.roomId,
      catalogFingerprint: this.catalog.fingerprint,
      createdAtMs,
      host: { participantId, displayName: input.hostDisplayName },
      initialRound: {
        roundId: input.initialRound.roundId,
        roundOrdinal: input.initialRound.roundOrdinal,
        label: input.initialRound.label,
        eraId: input.initialRound.eraId,
        challengeSeed: input.initialRound.challengeSeed,
      },
    });
    await this.repository.create(input.roomId, {
      serializedCompetition: this.runtime.serialize(state),
      receipts: {},
    });
    return projectDraftOffRoom(this.catalog, state, participantId);
  }

  async restoreRoom(serializedCompetition: string): Promise<void> {
    const state = this.runtime.restore(this.catalog, serializedCompetition);
    await this.repository.create(state.competitionId, {
      serializedCompetition: this.runtime.serialize(state),
      receipts: {},
    });
    await this.reconcileDeadline(state.competitionId);
  }

  async resumeRoom(roomId: string): Promise<void> {
    const record = await this.repository.read(roomId);
    if (!record) throw new DraftOffRoomRepositoryError("ROOM_NOT_FOUND", `Room ${roomId} does not exist.`);
    this.restoreRecord(roomId, record);
    await this.reconcileDeadline(roomId);
  }

  async readRoom(actor: DraftOffRoomActor, roomId: string): Promise<DraftOffRoomView> {
    const participantId = requireParticipantActor(actor);
    const record = await this.repository.read(roomId);
    if (!record) throw new DraftOffRoomRepositoryError("ROOM_NOT_FOUND", `Room ${roomId} does not exist.`);
    const state = this.restoreRecord(roomId, record);
    return projectDraftOffRoom(this.catalog, state, participantId);
  }

  async execute(
    actor: DraftOffRoomActor,
    envelope: DraftOffRoomCommandEnvelope,
  ): Promise<DraftOffRoomCommandResult> {
    if (actor.kind !== "PARTICIPANT" || !isId(actor.participantId)) {
      return freezeDeep({ ok: false, code: "INVALID_ACTOR", message: "Room commands require a valid participant actor." });
    }
    if (!isId(envelope.commandId) || envelope.commandId.startsWith("deadline:")) {
      return freezeDeep({ ok: false, code: "INVALID_COMMAND_ID", message: "Command ID must be a non-empty trimmed string outside the reserved deadline: namespace." });
    }
    if (!validEnvelope(envelope)) {
      return freezeDeep({ ok: false, code: "INVALID_COMMAND", message: "Command envelope has invalid or unexpected fields." });
    }
    // Snapshot before yielding: caller mutation must not change queued work or its receipt identity.
    envelope = freezeDeep({ ...envelope, command: { ...envelope.command } }) as DraftOffRoomCommandEnvelope;
    const participantId = actor.participantId;

    let result: DraftOffRoomCommandResult;
    try {
      result = await this.repository.transact(envelope.roomId, (record) =>
        this.executeParticipantTransaction(participantId, envelope, record));
    } catch (error) {
      if (error instanceof DraftOffRoomRepositoryError && error.code === "ROOM_NOT_FOUND") {
        return freezeDeep({ ok: false, code: "ROOM_NOT_FOUND", message: error.message });
      }
      throw error;
    }

    if (result.ok && result.changed) await this.reconcileDeadline(envelope.roomId);
    return result;
  }

  private executeParticipantTransaction(
    participantId: string,
    envelope: DraftOffRoomCommandEnvelope,
    record: DraftOffRoomRepositoryRecord,
  ): { readonly record: DraftOffRoomRepositoryRecord; readonly value: DraftOffRoomCommandResult } {
    const state = this.restoreRecord(envelope.roomId, record);
    const fingerprint = canonicalSha256({ actor: { kind: "PARTICIPANT", participantId }, envelope });
    const existing = Object.hasOwn(record.receipts, envelope.commandId) ? record.receipts[envelope.commandId] : undefined;
    if (existing) {
      if (existing.fingerprint === fingerprint) return { record, value: existing.result };
      const conflict = this.rejectedForParticipant(
        state,
        participantId,
        "COMMAND_ID_CONFLICT",
        "Command ID was already used for different input.",
      );
      return { record, value: conflict };
    }

    let serviceRejection: DraftOffRoomCommandResult | undefined;
    if (isLifecycleEnvelope(envelope) && envelope.expectedRoomRevision !== state.revision) {
      serviceRejection = this.rejectedForParticipant(
        state,
        participantId,
        "STALE_ROOM_REVISION",
        "Expected room revision does not match the authoritative room.",
      );
    } else {
      serviceRejection = authorize(state, participantId, envelope, this.catalog);
    }
    if (serviceRejection) return receipt(record, envelope.commandId, fingerprint, serviceRejection);

    const atMs = authoritativeClockTime(this.clock.nowMs(), state.lastAcceptedAtMs);
    const command = toCompetitionCommand(participantId, envelope, atMs);
    const transition = this.runtime.reduce(this.catalog, state, command);
    const nextState = transition.state;
    const result: DraftOffRoomCommandResult = transition.ok
      ? freezeDeep({
          ok: true,
          changed: transition.changed,
          roomRevision: nextState.revision,
          view: projectDraftOffRoom(this.catalog, nextState, participantId),
        })
      : freezeDeep({
          ok: false,
          code: transition.error.code,
          message: transition.error.message,
          roomRevision: state.revision,
          view: optionalParticipantView(this.catalog, state, participantId),
        });
    const nextRecord = {
      serializedCompetition: transition.ok && transition.changed
        ? this.runtime.serialize(nextState)
        : record.serializedCompetition,
      receipts: record.receipts,
    };
    return receipt(nextRecord, envelope.commandId, fingerprint, result);
  }

  private rejectedForParticipant(
    state: DraftOffCompetitionState,
    participantId: string,
    code: "COMMAND_ID_CONFLICT" | "STALE_ROOM_REVISION" | "FORBIDDEN",
    message: string,
  ): DraftOffRoomCommandResult {
    return freezeDeep({
      ok: false,
      code,
      message,
      roomRevision: state.revision,
      view: optionalParticipantView(this.catalog, state, participantId),
    });
  }

  private async reconcileDeadline(roomId: string): Promise<void> {
    if (this.disposed) return;
    const overdue = await this.repository.transact(roomId, (record) => {
      const state = this.restoreRecord(roomId, record);
      if (this.disposed) return { record, value: undefined };
      const active = state.rounds.find((round) => round.phase === "DRAFTING");
      if (!active || active.phase !== "DRAFTING") {
        this.cancelDeadline(roomId);
        return { record, value: undefined };
      }
      if (active.deadlineAtMs <= this.clock.nowMs()) {
        this.cancelDeadline(roomId);
        return { record, value: { roundId: active.roundId, deadlineAtMs: active.deadlineAtMs } };
      }
      const existing = this.scheduledDeadlines.get(roomId);
      if (existing?.roundId === active.roundId && existing.deadlineAtMs === active.deadlineAtMs) {
        return { record, value: undefined };
      }
      this.cancelDeadline(roomId);
      let scheduled!: ScheduledDeadline;
      const task = this.clock.scheduleAt(active.deadlineAtMs, async () => {
        if (this.disposed) return;
        if (this.scheduledDeadlines.get(roomId) === scheduled) this.scheduledDeadlines.delete(roomId);
        await this.finalizeDeadline(roomId, active.roundId, active.deadlineAtMs);
        await this.reconcileDeadline(roomId);
      });
      scheduled = { roundId: active.roundId, deadlineAtMs: active.deadlineAtMs, task };
      this.scheduledDeadlines.set(roomId, scheduled);
      return { record, value: undefined };
    });
    if (overdue) await this.finalizeDeadline(roomId, overdue.roundId, overdue.deadlineAtMs);
  }

  private async finalizeDeadline(roomId: string, roundId: string, deadlineAtMs: number): Promise<void> {
    if (this.disposed) return;
    const commandId = `deadline:${roomId}:${roundId}:${deadlineAtMs}`;
    await this.repository.transact(roomId, (record) => {
      const fingerprint = canonicalSha256({ actor: { kind: "SYSTEM" }, roomId, roundId, deadlineAtMs });
      const state = this.restoreRecord(roomId, record);
      if (this.disposed) return { record, value: undefined };
      const existing = Object.hasOwn(record.receipts, commandId) ? record.receipts[commandId] : undefined;
      if (existing) return { record, value: undefined };
      const atMs = authoritativeClockTime(this.clock.nowMs(), state.lastAcceptedAtMs);
      // An early/spurious timer delivery must not reserve the deadline command ID.
      if (atMs < deadlineAtMs) return { record, value: undefined };
      const transition = this.runtime.reduce(this.catalog, state, { type: "FINALIZE_ROUND", roundId, atMs });
      const nextState = transition.state;
      const result: DraftOffRoomCommandResult = transition.ok
        ? freezeDeep({ ok: true, changed: transition.changed, roomRevision: nextState.revision })
        : freezeDeep({
            ok: false,
            code: transition.error.code,
            message: transition.error.message,
            roomRevision: state.revision,
          });
      const nextRecord = {
        serializedCompetition: transition.ok && transition.changed
          ? this.runtime.serialize(nextState)
          : record.serializedCompetition,
        receipts: record.receipts,
      };
      const completed = receipt(nextRecord, commandId, fingerprint, result);
      return { record: completed.record, value: undefined };
    });
  }

  private cancelDeadline(roomId: string): void {
    this.scheduledDeadlines.get(roomId)?.task.cancel();
    this.scheduledDeadlines.delete(roomId);
  }

  /** Permanently stop deadline work before replacing this instance during a restart. */
  dispose(): void {
    this.disposed = true;
    for (const roomId of this.scheduledDeadlines.keys()) this.cancelDeadline(roomId);
  }

  private restoreRecord(roomId: string, record: DraftOffRoomRepositoryRecord): DraftOffCompetitionState {
    const state = this.runtime.restore(this.catalog, record.serializedCompetition);
    if (state.competitionId !== roomId) throw new Error("Repository room ID differs from canonical competition ID.");
    return state;
  }
}

function authorize(
  state: DraftOffCompetitionState,
  participantId: string,
  envelope: DraftOffRoomCommandEnvelope,
  catalog: EraDraftCatalog,
): DraftOffRoomCommandResult | undefined {
  if (isLifecycleEnvelope(envelope)) {
    if (envelope.command.type === "JOIN") return undefined;
    const participant = state.participants.find((candidate) => candidate.participantId === participantId);
    if (!participant) return forbidden(catalog, state, participantId, "Participant is not registered in this room.");
    if (envelope.command.type === "START" && participant.role !== "HOST") {
      return forbidden(catalog, state, participantId, "Only the room host may start the round.");
    }
    return undefined;
  }
  const round = state.rounds.find((candidate) => candidate.phase !== "PENDING");
  const entrant = round
    ? round.participants.find((participant) => participant.participantId === participantId)
    : undefined;
  if (!entrant) return forbidden(catalog, state, participantId, "Participant is not an active entrant in this round.");
  return undefined;
}

function forbidden(
  catalog: EraDraftCatalog,
  state: DraftOffCompetitionState,
  participantId: string,
  message: string,
): DraftOffRoomCommandResult {
  return freezeDeep({
    ok: false,
    code: "FORBIDDEN",
    message,
    roomRevision: state.revision,
    view: optionalParticipantView(catalog, state, participantId),
  });
}

function toCompetitionCommand(
  participantId: string,
  envelope: DraftOffRoomCommandEnvelope,
  atMs: number,
): DraftOffCompetitionCommand {
  if (isLifecycleEnvelope(envelope)) {
    if (envelope.command.type === "JOIN") {
      return {
        type: "JOIN_COMPETITION",
        participantId,
        ...(envelope.command.displayName === undefined ? {} : { displayName: envelope.command.displayName }),
        atMs,
      };
    }
    if (envelope.command.type === "LEAVE") return { type: "LEAVE_COMPETITION", participantId, atMs };
    return {
      type: "START_ROUND",
      actorParticipantId: participantId,
      roundId: envelope.command.roundId,
      deadlineAtMs: envelope.command.deadlineAtMs,
      atMs,
    };
  }
  if (envelope.command.type === "SUBMIT") {
    return {
      type: "SUBMIT_XI",
      participantId,
      expectedDraftRevision: envelope.expectedDraftRevision,
      atMs,
    };
  }
  return {
    type: "APPLY_DRAFT_COMMAND",
    participantId,
    expectedDraftRevision: envelope.expectedDraftRevision,
    draftCommand: { ...envelope.command },
    atMs,
  };
}

function isLifecycleEnvelope(envelope: DraftOffRoomCommandEnvelope): envelope is DraftOffRoomLifecycleEnvelope {
  return "expectedRoomRevision" in envelope;
}

function validEnvelope(envelope: DraftOffRoomCommandEnvelope): boolean {
  if (!isId(envelope.roomId) || !envelope.command || typeof envelope.command !== "object") return false;
  const command = envelope.command;
  const lifecycle = ["JOIN", "LEAVE", "START"].includes(command.type);
  const revisionKey = lifecycle ? "expectedRoomRevision" : "expectedDraftRevision";
  if (!exactKeys(envelope, ["roomId", "commandId", revisionKey, "command"])) return false;
  const revision = (envelope as unknown as Record<string, unknown>)[revisionKey];
  if (!Number.isSafeInteger(revision) || (revision as number) < 0) return false;
  switch (command.type) {
    case "JOIN": return command.displayName === undefined
      ? exactKeys(command, ["type"])
      : exactKeys(command, ["type", "displayName"]) && typeof command.displayName === "string";
    case "LEAVE":
    case "SPIN":
    case "RESPIN":
    case "SUBMIT": return exactKeys(command, ["type"]);
    case "START": return exactKeys(command, ["type", "roundId", "deadlineAtMs"])
      && isId(command.roundId) && Number.isSafeInteger(command.deadlineAtMs) && command.deadlineAtMs >= 0;
    case "LOCK_PLAYER": return exactKeys(command, ["type", "playerTeamSeasonId", "battingPosition"])
      && isId(command.playerTeamSeasonId) && Number.isSafeInteger(command.battingPosition)
      && command.battingPosition >= 1 && command.battingPosition <= 11;
    default: return false;
  }
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function receipt(
  record: DraftOffRoomRepositoryRecord,
  commandId: string,
  fingerprint: string,
  result: DraftOffRoomCommandResult,
): { readonly record: DraftOffRoomRepositoryRecord; readonly value: DraftOffRoomCommandResult } {
  return {
    record: {
      ...record,
      receipts: { ...record.receipts, [commandId]: freezeDeep({ fingerprint, result }) },
    },
    value: result,
  };
}

function optionalParticipantView(
  catalog: EraDraftCatalog,
  state: DraftOffCompetitionState,
  participantId: string,
): DraftOffRoomView | undefined {
  return state.participants.some((participant) => participant.participantId === participantId)
    ? projectDraftOffRoom(catalog, state, participantId)
    : undefined;
}

function requireParticipantActor(actor: DraftOffRoomActor): string {
  if (actor.kind !== "PARTICIPANT" || !isId(actor.participantId)) {
    throw new DraftOffRoomServiceError("INVALID_ACTOR", "Operation requires a valid participant actor.");
  }
  return actor.participantId;
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

function authoritativeClockTime(nowMs: number, minimumMs: number): number {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new DraftOffRoomServiceError("INVALID_CLOCK", "Clock returned an invalid timestamp.");
  }
  return Math.max(nowMs, minimumMs);
}

export class DraftOffRoomServiceError extends Error {
  readonly name = "DraftOffRoomServiceError";

  constructor(readonly code: "INVALID_ACTOR" | "INVALID_CLOCK", message: string) {
    super(message);
  }
}

function freezeDeep<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) value.forEach(freezeDeep);
  else Object.values(value as Record<string, unknown>).forEach(freezeDeep);
  return Object.freeze(value);
}
