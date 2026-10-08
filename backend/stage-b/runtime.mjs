import { mkdirSync } from 'node:fs';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from '../stage-a/node_modules/miniflare/dist/src/index.js';
export { fixture, request, seed, envelope, legalLock, summary } from '../stage-a/runtime.mjs';

export async function startRuntime(statePath, production = false) {
  mkdirSync(statePath, { recursive: true });
  const mf = new Miniflare(convertV4MiniflareOptions({
    name: 'stage-b', modules: true,
    scriptPath: new URL(production ? '.generated/worker.js' : '.generated/harness.js', import.meta.url).pathname,
    compatibilityDate: '2026-10-01',
    bindings: production ? {} : { STAGE_B_ONLY: 'local-workerd-fixtures-only' },
    durableObjects: { ROOMS: { className: production ? 'DraftOffRoom' : 'StageBTestRoom', useSQLite: true } },
    resourcePersistencePath: statePath, host: '127.0.0.1', port: 0,
    telemetry: { enabled: false }, cf: false, inspectorPort: 0, log: new Log(LogLevel.ERROR),
  }));
  return { mf, url: await mf.ready };
}
export async function evict(runtime, room) {
  await runtime.mf.unsafeEvictDurableObject('stage-b', 'StageBTestRoom', { name: room });
}
