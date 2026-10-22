// Local development only. No Cloudflare resources or deployment configuration.
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Local backend requires Node >=22.');
if (!existsSync(new URL('stage-d/.generated/worker.js', import.meta.url))) throw new Error('Run npm run verify:backend to prepare the local runtime.');
process.chdir(fileURLToPath(new URL('stage-d/', import.meta.url)));
const { startRuntime } = await import('./stage-d/runtime.mjs');
const state = process.env.DRAFT_OFF_LOCAL_STATE ?? mkdtempSync(join(tmpdir(), 'draft-off-dev-'));
const port = Number(process.env.DRAFT_OFF_LOCAL_PORT ?? 8787);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local port.');
const runtime = await startRuntime(state, { production: true, port,
  bindings: { ALLOWED_ORIGINS: JSON.stringify(['http://127.0.0.1:5173']) } });
console.log(`Local Draft-Off API: ${runtime.url.origin}`);
console.log(`Local state directory (private; preserve for restart): ${state}`);
console.log(`Frontend: VITE_DRAFT_OFF_API_ORIGIN=${runtime.url.origin} npm run dev:web -- --port 5173 --strictPort`);
let closing = false;
async function close() { if (closing) return; closing = true; await runtime.mf.dispose(); process.exit(0); }
process.on('SIGINT', close); process.on('SIGTERM', close);
