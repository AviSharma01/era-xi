/** Transport helper only; no UI. Pending enrollment keys are never invite/auth credentials. */
export interface EnrollmentStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
type Pending = { key: string; input: string };
type StoredEnrollment = { roomCode: string; participantId: string; reconnectCredential: string };
export type EnrollmentLock = <T>(name: string, work: () => Promise<T>) => Promise<T>;
/** No localStorage read/write sequence is a cross-tab mutex. Unsupported browsers fail closed. */
export const browserEnrollmentLock: EnrollmentLock = async (name, work) => {
  if (!navigator.locks) throw new Error('ENROLLMENT_LOCK_UNAVAILABLE');
  return await navigator.locks.request(name, work);
};
export async function enrollGuest(apiOrigin: string, operation: 'CREATE' | 'JOIN', roomCode: string | undefined,
  input: unknown, storage: EnrollmentStorage, transport: typeof fetch = fetch,
  onStored?: (enrollment: StoredEnrollment, ownsAttempt: () => boolean) => void) {
  const slot = `draft-off:pending:${operation}:${roomCode ?? ''}`;
  const serialized = JSON.stringify(input);
  let pendingRecord = storage.getItem(slot);
  let pending: Pending | undefined = JSON.parse(pendingRecord ?? 'null') ?? undefined;
  if (pending && pending.input !== serialized) throw new Error('Pending enrollment input differs; recover it before starting another enrollment.');
  const newKey = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (!pending) {
    pending = { key: newKey(), input: serialized };
    pendingRecord = JSON.stringify(pending); storage.setItem(slot, pendingRecord);
    if (storage.getItem(slot) !== pendingRecord) throw new Error('Pending enrollment storage could not be verified.');
  }
  // The exact stored record binds both the recovery key and serialized input.
  // Check ownership after all network awaits, before any response-side writes.
  const attemptRecord = pendingRecord;
  const ownsAttempt = () => storage.getItem(slot) === attemptRecord;
  const path = operation === 'CREATE' ? '/rooms' : `/rooms/${encodeURIComponent(roomCode!)}/join`;
  const response = await transport(new URL(`/api/draft-off/v1${path}`, apiOrigin).toString(), { method: 'POST', credentials: 'omit',
    headers: { 'Content-Type': 'application/json', 'Enrollment-Key': pending.key }, body: pending.input });
  const result = await response.json() as { ok: boolean; roomCode?: string; participantId?: string; reconnectCredential?: string; error?: { code: string } };
  if (!ownsAttempt()) return { status: response.status, body: result };
  if (response.status === 201 && result.ok && result.roomCode && result.participantId && result.reconnectCredential) {
    if (operation === 'JOIN' && result.roomCode !== roomCode) return { status: response.status, body: result };
    const credentialSlot = `draft-off:credential:${result.roomCode}`;
    const saved = JSON.stringify({ participantId: result.participantId, reconnectCredential: result.reconnectCredential });
    const current = storage.getItem(credentialSlot);
    // Even a response owning the pending key cannot replace an established identity.
    // Preserve the exact key/input on conflict, including malformed existing storage.
    const matches = (raw: string) => {
      try { const value = JSON.parse(raw); return value?.participantId === result.participantId && value?.reconnectCredential === result.reconnectCredential; }
      catch { return false; }
    };
    if (current !== null && !matches(current)) return { status: response.status, body: result };
    if (!ownsAttempt()) return { status: response.status, body: result };
    if (current === null) storage.setItem(credentialSlot, saved);
    const readback = storage.getItem(credentialSlot);
    if (readback === null || !matches(readback)) throw new Error('Credential storage could not be verified.');
    // A UI may activate synchronously while the exact persisted attempt still
    // exists. A historical reply must never authorize navigation via credentials alone.
    if (ownsAttempt()) onStored?.({ roomCode: result.roomCode, participantId: result.participantId,
      reconnectCredential: result.reconnectCredential }, ownsAttempt);
    if (ownsAttempt()) storage.removeItem(slot);
  } else if (operation === 'CREATE' && response.status === 409 && result.error?.code === 'ROOM_CODE_COLLISION') {
    storage.setItem(slot, JSON.stringify({ key: newKey(), input: serialized }));
  } else if (result.ok === false && ((response.status === 400 && result.error?.code === 'INVALID_REQUEST')
      || (response.status === 409 && ['DISPLAY_NAME_RESERVED', 'PARTICIPANT_LIMIT', 'INVALID_PHASE'].includes(result.error?.code ?? ''))
      || (response.status === 413 && result.error?.code === 'PAYLOAD_TOO_LARGE')
      || (response.status === 404 && result.error?.code === 'ROOM_UNAVAILABLE'))) {
    // These responses confirm that this attempt enrolled nobody. Unknown/uncertain
    // failures and key conflicts keep the original key/input available for recovery.
    storage.removeItem(slot);
  }
  return { status: response.status, body: result };
}
