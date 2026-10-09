import { ApiError } from './contracts';
export const DEFAULT_LIMITS = Object.freeze({ bodyBytes: 4096, createPerMinute: 10, enrollmentPerMinute: 120,
  requestsPerMinute: 600, roomEnrollmentsPerMinute: 20, roomEnrollmentBurst: 8,
  readsPerMinute: 60, readBurst: 10, commandsPerMinute: 30, commandBurst: 6,
  outstandingOperations: 16, enrollmentRecords: 256, participantCommandIds: 512, negativeResultRecords: 64 });
export type Limits = { [K in keyof typeof DEFAULT_LIMITS]: number };
export type LimitEnv = { STAGE_C_LIMITS?: string };
/** Provisioning/local harness definitions must use the same policy as the Worker environment. */
export function edgeRateDefinitions(policy: Limits) {
  return { CREATE_RATE: policy.createPerMinute, ENROLLMENT_RATE: policy.enrollmentPerMinute, REQUEST_RATE: policy.requestsPerMinute };
}
export function limits(env: LimitEnv): Limits {
  let overrides: Record<string, unknown> = {};
  try {
    if (env.STAGE_C_LIMITS) overrides = JSON.parse(env.STAGE_C_LIMITS);
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error();
    for (const [key, value] of Object.entries(overrides)) {
      if (!Object.hasOwn(DEFAULT_LIMITS, key) || !Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 1_000_000) throw new Error();
    }
  } catch { throw new ApiError(503, 'SERVICE_UNAVAILABLE'); }
  return { ...DEFAULT_LIMITS, ...overrides };
}
type Bucket = { tokens: number; atMs: number };
/** Separate housekeeping records; never touches the lifecycle alarm. Call under the room queue. */
export async function consume(storage: DurableObjectStorage, key: string, nowMs: number, perMinute: number, burst: number) {
  await storage.transaction(async tx => {
    const previous = await tx.get<Bucket>(`api:bucket:${key}`);
    const atMs = Math.max(nowMs, previous?.atMs ?? nowMs);
    const tokens = Math.min(burst, (previous?.tokens ?? burst) + (atMs - (previous?.atMs ?? atMs)) * perMinute / 60_000);
    if (tokens < 1) throw new ApiError(429, 'RATE_LIMITED');
    await tx.put(`api:bucket:${key}`, { tokens: tokens - 1, atMs });
  });
}
