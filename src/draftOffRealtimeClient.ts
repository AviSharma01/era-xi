import { isDraftOffFormat } from './draftOffFormat.js';
import type { DraftOffPublicRoomView, DraftOffRoomSnapshotMessage } from './draftOffRoomTypes.js';
import type { SnapshotSuccess } from './draftOffClientTypes.js';

/** Transport policy only. Changing polling never changes game deadlines or legality. */
export const DEFAULT_REALTIME_CLIENT_POLICY = Object.freeze({ reconciliationIntervalMs: 15_000,
  reconnectInitialMs: 500, reconnectMaxMs: 30_000, connectTimeoutMs: 10_000, requestTimeoutMs: 10_000,
  maxMessageBytes: 131_072, maxHttpResponseBytes: 2_097_152 });
export type RealtimeClientPolicy = { [K in keyof typeof DEFAULT_REALTIME_CLIENT_POLICY]: number };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, required: string[], optional: string[] = []) =>
  required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const integer = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
const strings = (value: unknown) => Array.isArray(value) && value.every(item => typeof item === 'string');

export function parseRoomSnapshot(data: unknown, roomId: string, maxBytes: number = DEFAULT_REALTIME_CLIENT_POLICY.maxMessageBytes): DraftOffRoomSnapshotMessage {
  if (typeof data !== 'string' || new TextEncoder().encode(data).byteLength > maxBytes) throw new Error('INVALID_REALTIME_MESSAGE');
  return validateRoomSnapshot(JSON.parse(data), roomId);
}

/** Shared structural validation; only the WebSocket parser imposes a frame-size limit. */
function validateRoomSnapshot(message: unknown, roomId: string): DraftOffRoomSnapshotMessage {
  if (!record(message) || !exact(message, ['version', 'type', 'serverTimeMs', 'view']) || (message.version !== 1 && message.version !== 2)
    || message.type !== 'ROOM_SNAPSHOT' || !integer(message.serverTimeMs) || !record(message.view)) throw new Error('INVALID_REALTIME_MESSAGE');
  const view = message.view;
  if (!exact(view, ['roomId', 'revision', 'phase', 'participants', 'round'], ['resolution']) || view.roomId !== roomId
    || !integer(view.revision) || !['LOBBY', 'IN_PROGRESS', 'COMPLETE'].includes(view.phase as string)
    || !Array.isArray(view.participants) || !view.participants.every(p => record(p)
      && exact(p, ['participantId', 'displayName', 'role', 'membershipStatus'], ['roundStatus'])
      && typeof p.participantId === 'string' && typeof p.displayName === 'string' && ['HOST', 'MEMBER'].includes(p.role as string)
      && ['JOINED', 'LEFT'].includes(p.membershipStatus as string)
      && (!Object.hasOwn(p, 'roundStatus') || ['DRAFTING', 'SUBMITTED', 'INELIGIBLE'].includes(p.roundStatus as string)))
    || !record(view.round)) throw new Error('INVALID_REALTIME_MESSAGE');
  const round = view.round;
  if (!exact(round, ['roundId', 'roundOrdinal', 'label', 'eraId', 'phase'], ['startedAtMs', 'deadlineAtMs', ...(message.version === 2 ? ['format'] : [])])
    || !['roundId', 'label', 'eraId'].every(key => typeof round[key] === 'string') || !integer(round.roundOrdinal)
    || !['PENDING', 'DRAFTING', 'RESOLVED'].includes(round.phase as string)
    || ['startedAtMs', 'deadlineAtMs'].some(key => Object.hasOwn(round, key) && !integer(round[key]))) throw new Error('INVALID_REALTIME_MESSAGE');
  if (message.version === 2 && !isDraftOffFormat(round.format)) throw new Error('INVALID_REALTIME_MESSAGE');
  if (Object.hasOwn(view, 'resolution')) {
    const r = view.resolution;
    if (!record(r) || !exact(r, ['trigger', 'contestStatus', 'resolvedAtMs', 'eligibleParticipantIds', 'ineligibleParticipantIds', 'leaderboard'])
      || !['ALL_SUBMITTED', 'DEADLINE'].includes(r.trigger as string) || !['CONTESTED', 'UNCONTESTED', 'NO_CONTEST'].includes(r.contestStatus as string)
      || !integer(r.resolvedAtMs) || !strings(r.eligibleParticipantIds) || !strings(r.ineligibleParticipantIds)
      || !Array.isArray(r.leaderboard) || !r.leaderboard.every(row => record(row)
        && exact(row, ['rank', 'participantId', 'displayName', 'played', 'won', 'lost', 'points', 'netRunRate'])
        && typeof row.participantId === 'string' && typeof row.displayName === 'string'
        && ['rank', 'played', 'won', 'lost', 'points'].every(key => integer(row[key])) && typeof row.netRunRate === 'number' && Number.isFinite(row.netRunRate))) throw new Error('INVALID_REALTIME_MESSAGE');
  }
  return message as DraftOffRoomSnapshotMessage;
}

/** Bound HTTP JSON at the transport layer, independently of realtime frame policy. */
async function readHttpJson(response: Response, maxBytes: number, signal: AbortSignal): Promise<unknown> {
  const declared = response.headers.get('Content-Length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    await response.body?.cancel(); throw new Error('INVALID_HTTP_RESPONSE_SIZE');
  }
  if (!response.body) throw new Error('INVALID_HTTP_RESPONSE');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  const interrupted = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', interrupted, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new Error('HTTP_RESPONSE_TOO_LARGE'); }
      chunks.push(chunk.value);
    }
    signal.throwIfAborted();
  } finally { signal.removeEventListener('abort', interrupted); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

export type RealtimeClientOptions = {
  apiOrigin: string; roomCode: string; reconnectCredential: string;
  onSnapshot: (snapshot: SnapshotSuccess) => void;
  onPublicSnapshot: (snapshot: DraftOffRoomSnapshotMessage) => void;
  onError?: (code: string) => void;
  policy?: Partial<RealtimeClientPolicy>;
  transport?: typeof fetch;
  createSocket?: (url: string, protocols: string[]) => WebSocket;
  random?: () => number;
  nowMs?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  events?: { addEventListener(type: string, listener: () => void): void; removeEventListener(type: string, listener: () => void): void };
};

/** Advisory socket + independently usable HTTP resync. No UI or gameplay state. */
export function createDraftOffRealtimeClient(options: RealtimeClientOptions) {
  const policy = { ...DEFAULT_REALTIME_CLIENT_POLICY, ...options.policy };
  if (Object.values(policy).some(value => !Number.isSafeInteger(value) || value < 1) || policy.reconnectMaxMs < policy.reconnectInitialMs) throw new Error('INVALID_REALTIME_POLICY');
  const base = new URL(options.apiOrigin);
  if (base.username || base.password || base.search || base.hash || (base.protocol !== 'https:'
    && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) || !/^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{12}$/.test(options.roomCode)) throw new Error('INVALID_REALTIME_ENDPOINT');
  const path = `/api/draft-off/v1/rooms/${options.roomCode}`;
  const transport = options.transport ?? fetch, createSocket = options.createSocket ?? ((url, protocols) => new WebSocket(url, protocols));
  const later = options.setTimer ?? setTimeout, cancel = options.clearTimer ?? clearTimeout;
  const nowMs = options.nowMs ?? Date.now;
  const events = options.events ?? (typeof globalThis.addEventListener === 'function' ? globalThis : undefined);
  let running = false, stopped = false, terminal = false, socketDisabled = false, generation = 0;
  let socket: WebSocket | undefined, pollTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined, connectTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined, deadlineKey: string | undefined;
  let cooldownTimer: ReturnType<typeof setTimeout> | undefined, cooldownUntilMs = 0;
  // Monotonic publication floor from validated HTTP/socket snapshots and HTTP command revisions.
  let sync: Promise<void> | undefined, requested = false, knownRevision = -1, privateRevision = -1, publicRevision = -1, attempt = 0;
  const abort = new AbortController();
  const report = (code: string) => options.onError?.(code);
  const clear = (timer: ReturnType<typeof setTimeout> | undefined) => { if (timer !== undefined) cancel(timer); };
  const resume = () => { void resync(); };
  function stop() {
    if (stopped) return;
    stopped = true; running = false; generation++; abort.abort();
    clear(pollTimer); clear(retryTimer); clear(connectTimer); clear(deadlineTimer); clear(cooldownTimer);
    events?.removeEventListener('focus', resume); events?.removeEventListener('online', resume);
    socket?.close(1000, 'Stopped'); socket = undefined;
  }
  const coolingDown = () => nowMs() < cooldownUntilMs;
  function cooldown(header: string | null) {
    const now = nowMs();
    const target = header && /^\d+$/.test(header.trim()) ? now + Number(header) * 1000 : Date.parse(header ?? '');
    cooldownUntilMs = Math.max(cooldownUntilMs, Number.isSafeInteger(target) ? Math.max(now, target) : now + 60_000);
    if (!coolingDown()) return; // A valid zero/expired Retry-After imposes no extra wait.
    clear(pollTimer); pollTimer = undefined; clear(retryTimer); retryTimer = undefined; clear(cooldownTimer);
    const resumeAfterCooldown = () => {
      cooldownTimer = undefined;
      if (!running || terminal) return;
      if (coolingDown()) { arm(); return; }
      void resync().finally(schedulePoll);
      if (!socket) void connect();
    };
    // Native timers cannot represent arbitrary Retry-After values in one delay.
    const arm = () => { cooldownTimer = later(resumeAfterCooldown, Math.min(2_147_483_647, Math.max(1, cooldownUntilMs - nowMs()))); };
    arm();
  }
  async function request(suffix: string, post = false) {
    if (coolingDown()) throw new Error('HTTP_COOLDOWN');
    const controller = new AbortController();
    const dispose = () => controller.abort();
    abort.signal.addEventListener('abort', dispose, { once: true });
    if (abort.signal.aborted) dispose();
    const timer = later(() => controller.abort(), policy.requestTimeoutMs);
    let onAbort!: () => void;
    const interrupted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error('HTTP_REQUEST_ABORTED'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
      if (controller.signal.aborted) onAbort();
    });
    const operation = (async () => {
      const response = await transport(new URL(path + suffix, base).toString(), { method: post ? 'POST' : 'GET', credentials: 'omit', cache: 'no-store',
        signal: controller.signal, headers: { Authorization: `Bearer ${options.reconnectCredential}`, ...(post ? { 'Content-Type': 'application/json' } : {}) },
        ...(post ? { body: '{}' } : {}) });
      if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); controller.signal.throwIfAborted(); }
      if (response.status === 401) { report('AUTHENTICATION_FAILED'); stop(); throw new Error('AUTHENTICATION_FAILED'); }
      if (!response.ok) {
        if (response.status === 429) cooldown(response.headers.get('Retry-After'));
        void response.body?.cancel().catch(() => {});
        throw new Error('HTTP_UNAVAILABLE');
      }
      return readHttpJson(response, policy.maxHttpResponseBytes, controller.signal);
    })();
    try { return await Promise.race([operation, interrupted]); }
    finally {
      clear(timer); abort.signal.removeEventListener('abort', dispose);
      controller.signal.removeEventListener('abort', onAbort);
    }
  }
  function observeRevision(revision: unknown) {
    if (integer(revision)) knownRevision = Math.max(knownRevision, revision as number);
  }
  function applyPublic(message: DraftOffRoomSnapshotMessage) {
    observeRevision(message.view.revision);
    if (message.view.revision >= knownRevision && message.view.revision > publicRevision) {
      publicRevision = message.view.revision; options.onPublicSnapshot(message);
      if (!running) return;
      const round = message.view.round;
      if (round.phase !== 'DRAFTING') { clear(deadlineTimer); deadlineTimer = undefined; }
      else if (round.deadlineAtMs !== undefined) {
        const key = `${round.roundId}:${round.deadlineAtMs}`;
        if (key !== deadlineKey) {
          deadlineKey = key; clear(deadlineTimer);
          deadlineTimer = later(() => { deadlineTimer = undefined; void resync(); }, Math.max(1, round.deadlineAtMs - message.serverTimeMs));
        }
      }
    }
  }
  function resync(): Promise<void> {
    if (!running || coolingDown()) return Promise.resolve();
    requested = true;
    if (sync) return sync;
    sync = (async () => {
      try {
        let reads = 0;
        do {
          reads++;
          requested = false;
          const reply = await request('') as SnapshotSuccess;
          if (!running) return;
          if (!reply.ok || reply.roomCode !== options.roomCode || !integer(reply.serverTimeMs) || !record(reply.view)) throw new Error('INVALID_HTTP_SNAPSHOT');
          const { myDraft: _private, ...shared } = reply.view;
          const modern = Object.hasOwn(shared.round, 'format');
          if (!record(reply.settings) || !exact(reply.settings, ['draftMinutes', ...(modern ? ['format'] : [])])
            || ![10, 15].includes(reply.settings.draftMinutes as number)
            || (modern && reply.settings.format !== shared.round.format)) throw new Error('INVALID_HTTP_SETTINGS');
          const publicMessage = validateRoomSnapshot({ version: modern ? 2 : 1, type: 'ROOM_SNAPSHOT', serverTimeMs: reply.serverTimeMs, view: shared }, options.roomCode);
          observeRevision(reply.view.revision);
          if (reply.view.revision >= privateRevision) {
            privateRevision = reply.view.revision;
            // A pending GET cannot publish below a newer command or socket revision.
            if (privateRevision >= knownRevision) options.onSnapshot(reply);
          }
          if (!running) return; // A consumer may dispose after detecting lost session ownership.
          applyPublic(publicMessage);
          if (reply.view.revision >= knownRevision) terminal = reply.view.phase === 'COMPLETE';
          if (terminal) { clear(pollTimer); clear(retryTimer); }
          if (privateRevision < knownRevision) requested = true;
          // One immediate follow-up closes in-flight races. Repeated stale replies
          // must yield to the existing fallback timer instead of flooding HTTP.
        } while (running && requested && reads < 2);
      } catch { if (running) report('HTTP_RESYNC_FAILED'); }
      finally { sync = undefined; }
    })();
    return sync;
  }
  function schedulePoll() {
    if (!running || terminal || coolingDown()) return;
    clear(pollTimer);
    pollTimer = later(() => { pollTimer = undefined; void resync().finally(schedulePoll); }, policy.reconciliationIntervalMs);
  }
  function retry() {
    if (!running || terminal || socketDisabled || retryTimer !== undefined || coolingDown()) return;
    const delay = Math.min(policy.reconnectMaxMs, policy.reconnectInitialMs * 2 ** Math.min(attempt++, 16));
    retryTimer = later(() => { retryTimer = undefined; void connect(); }, Math.max(policy.reconnectInitialMs,
      Math.round(delay * (0.5 + (options.random ?? Math.random)() * 0.5))));
  }
  async function connect() {
    if (!running || terminal || socketDisabled || coolingDown()) return;
    const current = ++generation;
    try {
      const issued = await request('/socket-tickets', true) as { ok: boolean; ticket: string; expiresAtMs: number };
      if (!running || current !== generation || coolingDown()) return;
      if (!issued.ok || !/^[A-Za-z0-9_-]{43}$/.test(issued.ticket) || !integer(issued.expiresAtMs)) throw new Error('INVALID_SOCKET_TICKET');
      const url = new URL(path + '/realtime', base); url.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = createSocket(url.toString(), ['draft-off.v1', `ticket.${issued.ticket}`]); socket = ws;
      let initial = true;
      const active = () => running && current === generation;
      connectTimer = later(() => { if (active() && initial) ws.close(1000, 'Reconnect required'); }, policy.connectTimeoutMs);
      ws.onopen = () => { if (active() && ws.protocol !== 'draft-off.v1') { socketDisabled = true; ws.close(1008, 'Invalid protocol'); } };
      ws.onmessage = event => {
        if (!active()) return;
        try {
          const message = parseRoomSnapshot(event.data, options.roomCode, policy.maxMessageBytes);
          const first = initial; initial = false; attempt = 0; clear(connectTimer); connectTimer = undefined;
          applyPublic(message);
          if (first || privateRevision < knownRevision) void resync();
        } catch { socketDisabled = true; report('INVALID_REALTIME_MESSAGE'); ws.close(1008, 'Invalid message'); }
      };
      ws.onerror = () => { /* The subsequent close schedules recovery; never log the credential-bearing protocol header. */ };
      ws.onclose = event => {
        if (!active()) return;
        clear(connectTimer); connectTimer = undefined; socket = undefined;
        if ([4001, 1008, 1009].includes(event.code)) socketDisabled = true;
        if (event.code === 4004) socketDisabled = true;
        void resync(); retry();
      };
    } catch { if (running && current === generation) { report('REALTIME_UNAVAILABLE'); retry(); } }
  }
  return {
    async start() {
      if (running || stopped) return;
      running = true; events?.addEventListener('focus', resume); events?.addEventListener('online', resume); await resync();
      if (!running) return;
      schedulePoll(); await connect();
    },
    resync,
    observeCommand(result: { readonly roomRevision?: number }) {
      observeRevision(result.roomRevision);
      // Receipts can contain historical private views. Always obtain a fresh GET.
      if (running) void resync();
    },
    stop,
  };
}

export type { DraftOffPublicRoomView };
