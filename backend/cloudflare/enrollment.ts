import { ApiError, type ApiReply, type SafeEnrollment } from './contracts';
const encoder = new TextEncoder();
const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function encode(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
export function secret(value: unknown, auth = false): string {
  const fail = () => { throw new ApiError(auth ? 401 : 400, auth ? 'AUTHENTICATION_FAILED' : 'INVALID_REQUEST'); };
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) return fail();
  if (encode(decode(value)) !== value) return fail();
  return value;
}
function decode(value: string): Uint8Array<ArrayBuffer> { return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), ch => ch.charCodeAt(0)); }
export function randomSecret(): string { return encode(crypto.getRandomValues(new Uint8Array(32))); }
// Lowercase hex preserves M2's existing roster-sort convention without changing domain identity logic.
export function participantId(): string { return `p_${Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')}`; }
export async function digest(...parts: unknown[]): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(parts)));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function enrollmentDigest(kind: 'CREATE' | 'JOIN', room: string, key: string) { return digest('draft-off-enrollment-v1', kind, kind === 'CREATE' ? '' : room, key); }
export async function roomCode(key: string): Promise<string> {
  const full = await enrollmentDigest('CREATE', '', key);
  let bits = BigInt(`0x${full.slice(0, 15)}`), result = '';
  for (let index = 0; index < 12; index++) { result = alphabet[Number(bits & 31n)] + result; bits >>= 5n; }
  return result;
}
export function normalizeCode(value: string): string {
  const code = value.toUpperCase();
  if (!/^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{12}$/.test(code)) throw new ApiError(400, 'INVALID_REQUEST');
  return code;
}
export function verifier(room: string, credential: string) { return digest('draft-off-reconnect-v1', room, credential); }
export function equalDigest(left: string, right: string): boolean {
  const bytes = (value: string) => Uint8Array.from(value.match(/../g) ?? [], pair => parseInt(pair, 16));
  if (!/^[0-9a-f]{64}$/.test(left) || !/^[0-9a-f]{64}$/.test(right)) return false;
  // Verified against the pinned workerd runtime. Node's ambient SubtleCrypto type omits this Workers extension.
  return (crypto.subtle as SubtleCrypto & { timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean }).timingSafeEqual(bytes(left), bytes(right));
}
type Sealed = { nonce: string; ciphertext: string };
export type EnrollmentRecord = { version: 1; enrollmentDigest: string; fingerprint: string;
  participantId: string; reply: ApiReply; sealed?: Sealed };
export type AuthRecord = { version: 1; roomCode: string; participantId: string; verifier: string };
async function wrappingKey(key: string, context: string) {
  const material = await crypto.subtle.importKey('raw', decode(key), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('draft-off-recovery-v1'), info: encoder.encode(context) },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export function recoveryContext(kind: string, room: string, participant: string, fingerprint: string) { return JSON.stringify(['draft-off-recovery-v1', kind, room, participant, fingerprint]); }
export async function seal(key: string, context: string, credential: string): Promise<Sealed> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: encoder.encode(context) }, await wrappingKey(key, context), encoder.encode(credential));
  return { nonce: encode(nonce), ciphertext: encode(new Uint8Array(ciphertext)) };
}
export async function recover(record: EnrollmentRecord, key: string, kind: string, room: string): Promise<ApiReply> {
  if (!record.sealed) return record.reply;
  const context = recoveryContext(kind, room, record.participantId, record.fingerprint);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(record.sealed.nonce), additionalData: encoder.encode(context) },
    await wrappingKey(key, context), decode(record.sealed.ciphertext));
  const credential = secret(new TextDecoder().decode(plaintext));
  return { ...record.reply, body: { ...record.reply.body as SafeEnrollment, reconnectCredential: credential } };
}
