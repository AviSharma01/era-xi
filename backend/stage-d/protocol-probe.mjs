import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from '../stage-a/node_modules/miniflare/dist/src/index.js';
const require = createRequire(import.meta.url);
// Optional browser verification uses an existing installation; no project dependency.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const watchdog = setTimeout(() => { console.error('Protocol probe timed out'); process.exit(1); }, 60000);
const mf = new Miniflare(convertV4MiniflareOptions({ name: 'stage-d-protocol', modules: true,
  scriptPath: new URL('protocol-probe.worker.mjs', import.meta.url).pathname, compatibilityDate: '2026-10-01',
  durableObjects: { ROOMS: { className: 'ProtocolProbe', useSQLite: true } },
  host: '127.0.0.1', port: 0, cf: false, telemetry: { enabled: false }, inspectorPort: 0, log: new Log(LogLevel.ERROR) }));
let browser;
try {
  const url = await mf.ready;
  console.log('Pinned workerd started');
  browser = await chromium.launch({ ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}), headless: true });
  const page = await browser.newPage();
  await page.goto(url.toString());
  const result = await page.evaluate(async () => {
    const url = new URL('/realtime', location.href); url.protocol = 'ws:';
    const ticket = 'A'.repeat(43);
    const ws = new WebSocket(url, ['draft-off.v1', `ticket.${ticket}`]);
    window.probeSocket = ws;
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('Upgrade failed')); });
    window.probeMessage = new Promise(resolve => { ws.onmessage = event => resolve(event.data); });
    return { selectedProtocol: ws.protocol, ticketAbsentFromUrl: !ws.url.includes(ticket) };
  });
  assert.deepEqual(result, { selectedProtocol: 'draft-off.v1', ticketAbsentFromUrl: true });
  await mf.unsafeEvictDurableObject('stage-d-protocol', 'ProtocolProbe', { name: 'probe', webSockets: 'hibernate' });
  assert.equal((await fetch(new URL('/notify', url))).status, 200);
  assert.equal(await page.evaluate(() => window.probeMessage), 'after-hibernation');
  console.log(JSON.stringify({ ...result, chromium: browser.version(), hibernationDelivery: true }));
} finally { await browser?.close(); await mf.dispose(); clearTimeout(watchdog); }
