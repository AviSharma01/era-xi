/** Transport helper only; no UI. Pending enrollment keys are never invite/auth credentials. */
export interface EnrollmentStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
type Pending = { key: string; input: string };
export async function enrollGuest(apiOrigin: string, operation: 'CREATE' | 'JOIN', roomCode: string | undefined,
  input: unknown, storage: EnrollmentStorage, transport: typeof fetch = fetch) {
  const slot = `draft-off:pending:${operation}:${roomCode ?? ''}`;
  const serialized = JSON.stringify(input);
  let pending: Pending | undefined = JSON.parse(storage.getItem(slot) ?? 'null') ?? undefined;
  if (pending && pending.input !== serialized) throw new Error('Pending enrollment input differs; recover it before starting another enrollment.');
  const newKey = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (!pending) {
    pending = { key: newKey(), input: serialized };
    const saved = JSON.stringify(pending); storage.setItem(slot, saved);
    if (storage.getItem(slot) !== saved) throw new Error('Pending enrollment storage could not be verified.');
  }
  const path = operation === 'CREATE' ? '/rooms' : `/rooms/${encodeURIComponent(roomCode!)}/join`;
  const response = await transport(new URL(`/api/draft-off/v1${path}`, apiOrigin).toString(), { method: 'POST', credentials: 'omit',
    headers: { 'Content-Type': 'application/json', 'Enrollment-Key': pending.key }, body: pending.input });
  const result = await response.json() as { ok: boolean; roomCode?: string; participantId?: string; reconnectCredential?: string; error?: { code: string } };
  if (response.status === 201 && result.ok && result.roomCode && result.participantId && result.reconnectCredential) {
    const credentialSlot = `draft-off:credential:${result.roomCode}`;
    const saved = JSON.stringify({ participantId: result.participantId, reconnectCredential: result.reconnectCredential });
    storage.setItem(credentialSlot, saved);
    if (storage.getItem(credentialSlot) !== saved) throw new Error('Credential storage could not be verified.');
    storage.removeItem(slot);
  } else if (operation === 'CREATE' && response.status === 409 && result.error?.code === 'ROOM_CODE_COLLISION') {
    storage.setItem(slot, JSON.stringify({ key: newKey(), input: serialized }));
  }
  return { status: response.status, body: result };
}
