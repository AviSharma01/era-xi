import { createDraftOffRealtimeClient, type RealtimeClientOptions } from "./draftOffRealtimeClient.js";
import { createDraftOffTransport } from "./draftOffClientTransport.js";
import type { PublicCommand, SnapshotSuccess } from "./draftOffClientTypes.js";
import { enrollGuest, type EnrollmentStorage, type EnrollmentLock } from "./draftOffEnrollmentClient.js";
import { fetchDraftOffResults, ResultsClientError } from "./draftOffResultsClient.js";
import type { ResultsSuccess } from "./draftOffResultsTypes.js";
import type { DraftOffRoomSnapshotMessage } from "./draftOffRoomTypes.js";

export type GuestCredential = { participantId: string; reconnectCredential: string };
export function readDraftOffCredential(storage: EnrollmentStorage, code: string): GuestCredential | null {
  const raw = storage.getItem(`draft-off:credential:${code}`);
  if (raw === null) return null;
  const value = JSON.parse(raw) as GuestCredential;
  if (!value || typeof value.participantId !== "string" || !/^p_[a-f0-9]{32}$/.test(value.participantId) ||
    typeof value.reconnectCredential !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.reconnectCredential)) throw new Error("Stored room access is unavailable.");
  return value;
}

/** Activate only inside the helper's verified storage handoff, before pending cleanup.
 * The callback is synchronous: no awaited work may separate this guard from navigation.
 */
export async function enrollDraftOffGuest(options: {
  apiOrigin: string; operation: "CREATE" | "JOIN"; roomCode?: string; input: unknown;
  storage: EnrollmentStorage; transport?: typeof fetch; isActive: () => boolean;
  withLock?: EnrollmentLock; expectedPendingRecord?: string | null;
  onEnrolled: (roomCode: string, credential: GuestCredential) => void;
}) {
  const enroll = async () => {
    if (!options.isActive()) throw new Error("Enrollment owner is no longer active.");
    if (options.operation === "JOIN" && options.roomCode) {
      const current = readDraftOffCredential(options.storage, options.roomCode);
      if (current) {
        // A queued or stale form resumes the profile's identity; no new key or request.
        if (!options.isActive()) throw new Error("Enrollment owner is no longer active.");
        options.onEnrolled(options.roomCode, current);
        return { resumed: true as const, activated: true };
      }
    }
    const slot = `draft-off:pending:${options.operation}:${options.roomCode ?? ""}`;
    if (options.expectedPendingRecord !== undefined && options.storage.getItem(slot) !== options.expectedPendingRecord) {
      throw new Error("Enrollment recovery changed. Read the current attempt before retrying.");
    }
    let activated = false;
    const reply = await enrollGuest(options.apiOrigin, options.operation, options.roomCode, options.input,
      options.storage, options.transport, (enrollment, ownsAttempt) => {
        const credential = readDraftOffCredential(options.storage, enrollment.roomCode);
        if (credential?.participantId !== enrollment.participantId || credential.reconnectCredential !== enrollment.reconnectCredential) return;
        // Read current persisted ownership AFTER credential readback and immediately
        // before handing off the active room. No storage mutation or await intervenes.
        if (!options.isActive() || !ownsAttempt()) return;
        options.onEnrolled(enrollment.roomCode, credential);
        activated = true;
      });
    return { ...reply, resumed: false as const, activated };
  };
  return options.withLock
    ? options.withLock(`draft-off:enrollment:${options.operation}:${options.roomCode ?? ""}`, enroll)
    : enroll();
}

type Journal = { version: 1; roomCode: string; participantId: string; envelope: PublicCommand };
export type DraftOffSessionState = {
  snapshot: SnapshotSuccess | null; pending: boolean; error: string | null; accessUnavailable: boolean;
  /** Independently versioned public data; never confirms or replaces snapshot.myDraft. */
  publicSnapshot?: DraftOffRoomSnapshotMessage;
  pendingCommand?: PublicCommand["command"]["type"]; retryAvailable?: boolean;
};

function validEnvelope(value: PublicCommand): boolean {
  if (!value || typeof value !== "object" || !/^[A-Za-z0-9_-]{1,80}$/.test(value.commandId) || !value.command) return false;
  const lifecycle = ["START", "LEAVE", "REJOIN"].includes(value.command.type);
  const revision = lifecycle ? "expectedRoomRevision" : "expectedDraftRevision";
  if (Object.keys(value).sort().join() !== ["commandId", "command", revision].sort().join()) return false;
  const number = (value as unknown as Record<string, unknown>)[revision];
  if (!Number.isSafeInteger(number) || (number as number) < 0) return false;
  if (value.command.type === "LOCK_PLAYER") return Object.keys(value.command).sort().join() === "battingPosition,playerTeamSeasonId,type" &&
    typeof value.command.playerTeamSeasonId === "string" && !!value.command.playerTeamSeasonId && Number.isSafeInteger(value.command.battingPosition) && value.command.battingPosition >= 1 && value.command.battingPosition <= 11;
  return ["START", "LEAVE", "REJOIN", "SPIN", "RESPIN", "SUBMIT"].includes(value.command.type) && Object.keys(value.command).join() === "type";
}

/** Owns one guest's intents. Only authenticated HTTP publishes private state/confirmation. */
export function createDraftOffSession(options: {
  apiOrigin: string; roomCode: string; credential: GuestCredential; journalStorage: EnrollmentStorage;
  credentialStorage?: EnrollmentStorage;
  onChange: (state: DraftOffSessionState) => void;
  transport?: ReturnType<typeof createDraftOffTransport>;
  realtime?: Pick<RealtimeClientOptions, "createSocket" | "events" | "policy">;
}) {
  const transport = options.transport ?? createDraftOffTransport();
  const slot = `draft-off:command:${options.roomCode}:${options.credential.participantId}`;
  let state: DraftOffSessionState = { snapshot: null, pending: false, error: null, accessUnavailable: false };
  let stopped = false, sending = false, started = false, awaitingSnapshot = false, confirmedRevision = -1;
  let receiptConfirmed = false;
  const resultsCache = new Map<string, ResultsSuccess>();
  const resultsPending = new Map<string, { promise: Promise<ResultsSuccess>; signal?: AbortSignal }>();
  let journal: Journal | null = null, stored: string | null = options.journalStorage.getItem(slot);
  if (stored !== null) {
    const parsed = JSON.parse(stored) as Journal;
    if (!parsed || parsed.version !== 1 || parsed.roomCode !== options.roomCode || parsed.participantId !== options.credential.participantId || !validEnvelope(parsed.envelope)) throw new Error("Pending command cannot be safely recovered.");
    journal = freezeJournal(parsed); state.pending = true; state.pendingCommand = journal.envelope.command.type; state.retryAvailable = true;
  }
  const publish = (patch: Partial<DraftOffSessionState>) => { if (!stopped) { state = { ...state, ...patch }; options.onChange(state); } };
  function stop() {
    stopped = true; resultsCache.clear(); resultsPending.clear(); realtime.stop(); transport.stop();
  }
  function loseAccess(message: string, preserveLeaderboard = false) {
    let snapshot: SnapshotSuccess | null = null;
    if (preserveLeaderboard && state.snapshot?.view.phase === "COMPLETE") {
      const { myDraft: _private, ...view } = state.snapshot.view;
      snapshot = { ...state.snapshot, view };
    }
    publish({ snapshot, publicSnapshot: undefined, accessUnavailable: true, error: message, retryAvailable: false });
    stop();
  }
  function verifyCredential(): boolean {
    if (stopped || state.accessUnavailable) return false;
    if (!options.credentialStorage) return true;
    try {
      const current = readDraftOffCredential(options.credentialStorage, options.roomCode);
      if (current?.participantId === options.credential.participantId && current.reconnectCredential === options.credential.reconnectCredential) return true;
    } catch { /* Storage loss cannot authorize continued private access. */ }
    loseAccess("Saved room access changed or cannot be read. Reload after restoring browser storage. Pending actions are preserved.");
    return false;
  }
  const realtime = createDraftOffRealtimeClient({ ...options.realtime, apiOrigin: options.apiOrigin, roomCode: options.roomCode,
    reconnectCredential: options.credential.reconnectCredential,
    transport: (input, init) => verifyCredential() ? transport.fetch(input, init) : Promise.reject(new Error("AUTHENTICATION_FAILED")),
    onPublicSnapshot(snapshot) {
      if (!verifyCredential() || !state.snapshot || (state.publicSnapshot && state.publicSnapshot.view.revision >= snapshot.view.revision)) return;
      publish({ publicSnapshot: snapshot });
    },
    onSnapshot(snapshot) {
      if (!verifyCredential()) return;
      if (snapshot.participantId !== options.credential.participantId) {
        loseAccess("Room access could not be verified."); return;
      }
      const draft = snapshot.view.myDraft;
      if (!snapshot.settings || ![10, 15].includes(snapshot.settings.draftMinutes) ||
        (draft !== undefined && (!draft || !Number.isSafeInteger(draft.revision) || draft.revision < 0 ||
          !["SETUP", "AWAITING_SPIN", "AWAITING_PICK", "XI_COMPLETE"].includes(draft.phase)))) {
        publish({ error: "The room response could not be verified. Your saved access is preserved." }); return;
      }
      if (snapshot.view.revision < confirmedRevision || (state.snapshot && snapshot.view.revision < state.snapshot.view.revision)) return;
      awaitingSnapshot = false;
      publish({ snapshot, pending: journal !== null || sending, error: journal ? state.error : null });
    },
    onError(code) {
      if (code === "AUTHENTICATION_FAILED") {
        loseAccess("Room access is unavailable. The room may have expired or this browser may no longer have access.", true); return;
      }
      if (!verifyCredential()) return;
      publish({ error: code === "REALTIME_UNAVAILABLE" || code === "INVALID_REALTIME_MESSAGE"
          ? "Live updates are interrupted. Room refresh continues over HTTP."
          : "The room could not refresh. Saved access and pending actions are preserved." });
    },
  });
  function clearJournal() {
    const current = options.journalStorage.getItem(slot);
    if (current !== stored && !(receiptConfirmed && current === null)) throw new Error("Pending command storage changed in another session.");
    if (current !== null) options.journalStorage.removeItem(slot);
    if (options.journalStorage.getItem(slot) !== null) throw new Error("Pending command cleanup could not be verified.");
    journal = null; stored = null; receiptConfirmed = false;
  }
  function loadResults(targetParticipantId: string, signal?: AbortSignal): Promise<ResultsSuccess> {
    const snapshot = state.snapshot;
    if (!verifyCredential() || !snapshot) return Promise.reject(new ResultsClientError("AUTHENTICATION_FAILED"));
    const { view } = snapshot;
    if (view.phase !== "COMPLETE" || view.round.phase !== "RESOLVED" || !view.resolution) return Promise.reject(new ResultsClientError("RESULTS_NOT_READY"));
    const me = view.participants.find(row => row.participantId === options.credential.participantId);
    const row = view.resolution.leaderboard.find(row => row.participantId === targetParticipantId);
    if (!me?.roundStatus || !row || !view.resolution.eligibleParticipantIds.includes(targetParticipantId)) return Promise.reject(new ResultsClientError("RESULT_UNAVAILABLE"));
    const key = `${view.round.roundId}:${targetParticipantId}`;
    const cached = resultsCache.get(key);
    if (cached) return signal?.aborted ? Promise.reject(new ResultsClientError("RESULTS_REQUEST_ABORTED")) : Promise.resolve(cached);
    const pending = resultsPending.get(key);
    if (pending && !pending.signal?.aborted) return pending.promise;
    const identity = { roomCode: options.roomCode, roundId: view.round.roundId, roundOrdinal: view.round.roundOrdinal,
      eraId: view.round.eraId, participantId: targetParticipantId };
    let promise!: Promise<ResultsSuccess>;
    promise = (async () => {
      try {
        const result = await fetchDraftOffResults({ apiOrigin: options.apiOrigin, credential: options.credential.reconnectCredential,
          identity, transport: transport.fetch, signal });
        // Session ownership and round identity are sufficient: resolved campaigns never mutate.
        if (!verifyCredential() || signal?.aborted || state.snapshot?.view.round.roundId !== identity.roundId) throw new ResultsClientError("RESULTS_REQUEST_ABORTED");
        if (result.displayName !== row.displayName || (["played", "won", "lost", "points", "netRunRate"] as const)
          .some(key => result.campaign.aggregate[key] !== row[key])) throw new ResultsClientError("INVALID_RESULTS_RESPONSE");
        if (resultsCache.size >= 8) resultsCache.delete(resultsCache.keys().next().value!);
        resultsCache.set(key, result);
        return result;
      } catch (error) {
        if (!stopped && error instanceof ResultsClientError && error.code === "AUTHENTICATION_FAILED") {
          loseAccess("Room access is unavailable. Saved access is preserved.", true);
        } else if (!stopped && error instanceof ResultsClientError && error.code === "RESULTS_NOT_READY") {
          void realtime.resync();
        }
        throw error;
      } finally { if (resultsPending.get(key)?.promise === promise) resultsPending.delete(key); }
    })();
    resultsPending.set(key, { promise, signal });
    return promise;
  }
  async function retry() {
    if (!verifyCredential() || sending || !journal) return;
    sending = true; publish({ pending: true, error: null, pendingCommand: journal.envelope.command.type, retryAvailable: false });
    const attempt = journal, record = stored;
    try {
      const current = options.journalStorage.getItem(slot);
      if (current !== record && !(receiptConfirmed && current === null)) throw new Error("Pending command storage changed.");
      const reply = await transport.fetch(new URL(`/api/draft-off/v1/rooms/${options.roomCode}/commands`, options.apiOrigin), {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.credential.reconnectCredential}` },
        body: JSON.stringify(attempt.envelope),
      });
      const body: unknown = await reply.json();
      if (!verifyCredential() || journal !== attempt) return;
      const persisted = options.journalStorage.getItem(slot);
      if (persisted !== record && !(receiptConfirmed && persisted === null)) throw new Error("Pending command storage changed.");
      if (!body || typeof body !== "object") throw new Error("INVALID_COMMAND_REPLY");
      const result = body as { ok?: boolean; changed?: boolean; roomRevision?: number; error?: { code?: string } };
      if (reply.status === 401) {
        loseAccess("Room access is unavailable. Your pending action is preserved.", true); return;
      }
      const success = reply.status === 200 && result.ok === true && typeof result.changed === "boolean" && Number.isSafeInteger(result.roomRevision) && result.roomRevision! >= 0;
      const definitive = [400, 403, 404, 409, 413, 415, 422].includes(reply.status) && result.ok === false && typeof result.error?.code === "string";
      if (!success && !definitive) throw new Error("UNCERTAIN_COMMAND_REPLY");
      // A verified receipt permits idempotent cleanup if a prior remove succeeded
      // before storage threw. A different saved record is never ours to remove.
      receiptConfirmed = true;
      if (Number.isSafeInteger(result.roomRevision) && result.roomRevision! >= 0) confirmedRevision = Math.max(confirmedRevision, result.roomRevision!);
      clearJournal();
      awaitingSnapshot = true;
      await realtime.observeCommand(result);
      if (!success) publish({ error: `Action rejected (${result.error!.code}). Refresh the room before trying a corrected action.` });
    } catch { publish({ error: "The action is not yet confirmed. Retry the saved action; do not create a replacement." }); }
    finally { sending = false; publish({ pending: journal !== null || awaitingSnapshot || !state.snapshot || state.snapshot.view.revision < confirmedRevision,
      pendingCommand: journal?.envelope.command.type, retryAvailable: journal !== null && !state.accessUnavailable }); }
  }
  return {
    getState: () => state,
    async start() { if (started || !verifyCredential()) return; started = true; await realtime.start(); if (!stopped && state.snapshot && journal) await retry(); },
    async command(command: PublicCommand["command"]) {
      if (!verifyCredential() || journal || sending || state.pending || !state.snapshot) throw new Error("Room is not ready for a new action.");
      const snapshot = state.snapshot;
      const copied = JSON.parse(JSON.stringify(command)) as PublicCommand["command"];
      const lifecycle = ["START", "LEAVE", "REJOIN"].includes(copied.type);
      if (!lifecycle && !snapshot.view.myDraft) throw new Error("No private draft is available.");
      const envelope = { commandId: crypto.randomUUID(), ...(lifecycle ? { expectedRoomRevision: snapshot.view.revision } : { expectedDraftRevision: snapshot.view.myDraft!.revision }), command: copied } as PublicCommand;
      if (!validEnvelope(envelope)) throw new Error("Invalid command intent.");
      const next = freezeJournal({ version: 1, roomCode: options.roomCode, participantId: options.credential.participantId, envelope });
      const raw = JSON.stringify(next);
      if (options.journalStorage.getItem(slot) !== null) throw new Error("A saved action must be recovered first.");
      options.journalStorage.setItem(slot, raw);
      if (options.journalStorage.getItem(slot) !== raw) throw new Error("Pending action storage could not be verified.");
      journal = next; stored = raw;
      await retry();
    },
    retry,
    loadResults,
    resultsRetryAtMs: () => transport.cooldownUntil(),
    subscribeResultsCooldown: transport.subscribeCooldown,
    verifyCredential,
    resync: () => verifyCredential() ? realtime.resync() : Promise.resolve(),
    stop,
  };
}
function freezeJournal(value: Journal): Journal {
  Object.freeze(value.envelope.command); Object.freeze(value.envelope); return Object.freeze(value);
}
