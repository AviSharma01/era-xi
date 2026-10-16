import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from '../stage-a/node_modules/miniflare/dist/src/index.js';
import { DEFAULT_LIMITS, edgeRateDefinitions } from './.generated/limits.js';
export { call, control, origin } from '../stage-c/runtime.mjs';
export async function startRuntime(statePath, { production = false, overrides = {}, bindings = {} } = {}) {
  const logs = [], policy = { ...DEFAULT_LIMITS, ...overrides };
  const mf = new Miniflare(convertV4MiniflareOptions({ name: 'stage-d', modules: true,
    scriptPath: new URL(production ? '.generated/worker.js' : '.generated/harness.js', import.meta.url).pathname,
    compatibilityDate: '2026-10-01', bindings: { ALLOWED_ORIGINS: JSON.stringify(['https://frontend.example']), STAGE_C_LIMITS: JSON.stringify(overrides),
      ...(production ? {} : { STAGE_D_ONLY: 'local-workerd-fixtures-only' }), ...bindings },
    durableObjects: { ROOMS: { className: production ? 'DraftOffRoom' : 'StageDTestRoom', useSQLite: true } },
    ratelimits: Object.fromEntries(Object.entries(edgeRateDefinitions(policy)).map(([name, limit], index) => [name, { namespace_id: String(index + 1), simple: { limit, period: 60 } }])),
    resourcePersistencePath: statePath, host: '127.0.0.1', port: 0, cf: false, telemetry: { enabled: false }, inspectorPort: 0,
    log: new Log(LogLevel.ERROR), handleStructuredLogs: entry => logs.push(entry),
  }));
  return { mf, url: await mf.ready, logs };
}
