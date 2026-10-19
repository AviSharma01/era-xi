import { ApiError } from './contracts';

/** Shared by Worker and DO: exact configured Origin, independently checked at both boundaries. */
export function allowedOrigin(request: Request, env: { ALLOWED_ORIGINS?: string }): string {
  let origins: unknown;
  try { origins = JSON.parse(env.ALLOWED_ORIGINS ?? ''); } catch { throw new ApiError(503, 'SERVICE_UNAVAILABLE'); }
  if (!Array.isArray(origins) || !origins.length || origins.some(origin => {
    try { const parsed = new URL(origin); return typeof origin !== 'string' || parsed.origin !== origin || !['https:', 'http:'].includes(parsed.protocol)
      || (parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)); }
    catch { return true; }
  })) throw new ApiError(503, 'SERVICE_UNAVAILABLE');
  const origin = request.headers.get('Origin');
  if (!origin || !origins.includes(origin)) throw new ApiError(403, 'ORIGIN_NOT_ALLOWED');
  return origin;
}
