import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from '../stage-a/node_modules/miniflare/dist/src/index.js';
import { DEFAULT_LIMITS, edgeRateDefinitions } from './.generated/limits.js';
export const origin = 'https://frontend.example';
export async function startRuntime(statePath, { production = false, overrides = {}, bindings = {}, edgeBindings = true, log = new Log(LogLevel.ERROR) } = {}) {
  const logs = [];
  const policy = { ...DEFAULT_LIMITS, ...overrides };
  const mf = new Miniflare(convertV4MiniflareOptions({ name: 'stage-c', modules: true,
    scriptPath: new URL(production ? '.generated/worker.js' : '.generated/harness.js', import.meta.url).pathname,
    compatibilityDate: '2026-10-01', bindings: { ALLOWED_ORIGINS: JSON.stringify([origin]), STAGE_C_LIMITS: JSON.stringify(overrides),
      ...(production ? {} : { STAGE_C_ONLY: 'local-workerd-fixtures-only' }), ...bindings },
    durableObjects: { ROOMS: { className: production ? 'DraftOffRoom' : 'StageCTestRoom', useSQLite: true } },
    ratelimits: edgeBindings ? Object.fromEntries(Object.entries(edgeRateDefinitions(policy))
      .map(([name, limit], index) => [name, { namespace_id: String(index + 1), simple: { limit, period: 60 } }])) : {},
    resourcePersistencePath: statePath, host: '127.0.0.1', port: 0, cf: false, telemetry: { enabled: false }, inspectorPort: 0, log,
    handleStructuredLogs: entry => logs.push(entry),
  }));
  return { mf, url: await mf.ready, logs };
}
export async function control(runtime, code, action, input = {}) {
  const response = await fetch(new URL(`/__test/${code}/${action}`, runtime.url), { method: 'POST', body: JSON.stringify(input), headers: { 'content-type': 'application/json' } });
  if (!response.ok) throw new Error(`Control failed: ${response.status}`);
  return response.json();
}
export async function call(runtime, path, { method = 'GET', body, key, token, headers = {} } = {}) {
  const response = await fetch(new URL(`/api/draft-off/v1${path}`, runtime.url), { method,
    headers: { Origin: origin, 'CF-Connecting-IP': '127.0.0.1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(key ? { 'Enrollment-Key': key } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
  return { status: response.status, body: response.status === 204 ? null : await response.json(), headers: response.headers };
}
