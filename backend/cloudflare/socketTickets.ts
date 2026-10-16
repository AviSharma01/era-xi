import { ApiError } from './contracts';
import { digest, equalDigest, randomSecret } from './enrollment';
import { consumeBucket, type Limits } from './limits';

const PREFIX = 'api:socket-ticket:';
type TicketRecord = { version: 1; verifier: string; roomCode: string; participantId: string; origin: string; issuedAtMs: number; expiresAtMs: number };
export const ticketVerifier = (room: string, ticket: string) => digest('draft-off-socket-ticket-v1', room, ticket);

function validRow(key: string, record: TicketRecord | undefined): record is TicketRecord {
  return !!record && record.version === 1 && typeof record.verifier === 'string' && /^[0-9a-f]{64}$/.test(record.verifier)
    && key === PREFIX + record.verifier && typeof record.roomCode === 'string' && typeof record.participantId === 'string'
    && typeof record.origin === 'string' && Number.isSafeInteger(record.issuedAtMs) && record.issuedAtMs >= 0
    && Number.isSafeInteger(record.expiresAtMs) && record.expiresAtMs > record.issuedAtMs;
}

function authenticate(record: TicketRecord | undefined, hash: string, roomCode: string, origin: string, nowMs: number) {
  const valid = validRow(PREFIX + hash, record);
  const equal = equalDigest(hash, valid ? record.verifier : '0'.repeat(64));
  if (!equal || !valid || record.roomCode !== roomCode || record.origin !== origin
    || record.issuedAtMs > nowMs || record.expiresAtMs <= nowMs) throw new ApiError(401, 'AUTHENTICATION_FAILED');
  return record.participantId;
}

/** Cheap authentication before catalog/replay/recovery. Redemption revalidates atomically. */
export async function verifySocketTicket(storage: DurableObjectStorage, roomCode: string, ticket: string, origin: string, nowMs: number) {
  const hash = await ticketVerifier(roomCode, ticket);
  return authenticate(await storage.get<TicketRecord>(PREFIX + hash), hash, roomCode, origin, nowMs);
}

export async function pruneSocketTickets(tx: DurableObjectTransaction, nowMs: number) {
  const tickets = await tx.list<TicketRecord>({ prefix: PREFIX });
  for (const [key, record] of tickets) {
    // Unusable advisory auth rows grant no access and must not block HTTP gameplay.
    if (!validRow(key, record) || record.expiresAtMs <= nowMs) {
      await tx.delete(key); tickets.delete(key);
    }
  }
  return tickets;
}

/** Adapter-only transaction: no canonical state, receipts, counters or alarm changes. */
export async function issueSocketTicket(storage: DurableObjectStorage, roomCode: string, participantId: string,
  origin: string, nowMs: number, policy: Limits, beforeCommit: () => void = () => {}) {
  const ticket = randomSecret(), verifier = await ticketVerifier(roomCode, ticket), expiresAtMs = nowMs + policy.ticketLifetimeMs;
  if (!Number.isSafeInteger(expiresAtMs)) throw new ApiError(503, 'TEMPORARY_UNAVAILABLE');
  await storage.transaction(async tx => {
    const rows = await pruneSocketTickets(tx, nowMs);
    if (rows.size >= policy.pendingTicketsPerRoom || [...rows.values()].filter(row => row.participantId === participantId).length >= policy.pendingTicketsPerParticipant) throw new ApiError(429, 'RATE_LIMITED');
    await consumeBucket(tx, 'socket-tickets:room', nowMs, policy.roomTicketsPerMinute, policy.roomTicketBurst);
    await consumeBucket(tx, `socket-tickets:${participantId}`, nowMs, policy.ticketsPerMinute, policy.ticketBurst);
    await tx.put(PREFIX + verifier, { version: 1, verifier, roomCode, participantId, origin, issuedAtMs: nowMs, expiresAtMs } satisfies TicketRecord);
    beforeCommit();
  });
  return { ok: true as const, ticket, expiresAtMs };
}

export async function consumeSocketTicket(storage: DurableObjectStorage, roomCode: string, ticket: string,
  origin: string, nowMs: number, registered: ReadonlySet<string>, admit: (participantId: string) => void,
  beforeCommit: () => void = () => {}) {
  const hash = await ticketVerifier(roomCode, ticket);
  return storage.transaction(async tx => {
    await pruneSocketTickets(tx, nowMs);
    const record = await tx.get<TicketRecord>(PREFIX + hash);
    const participantId = authenticate(record, hash, roomCode, origin, nowMs);
    if (!registered.has(participantId)) throw new ApiError(401, 'AUTHENTICATION_FAILED');
    admit(participantId);
    await tx.delete(PREFIX + hash);
    beforeCommit();
    return participantId;
  });
}
