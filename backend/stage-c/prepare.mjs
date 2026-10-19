import { mkdirSync, existsSync } from 'node:fs';
import { build } from '../stage-a/node_modules/esbuild/lib/main.js';
if (!existsSync(new URL('../stage-a/.generated/catalogs.ts', import.meta.url))) throw new Error('Prepare Stage A catalogs first.');
mkdirSync(new URL('.generated/', import.meta.url), { recursive: true });
for (const [entry, output, platform] of [['harness.ts', 'harness.js', 'browser'], ['../cloudflare/worker.ts', 'worker.js', 'browser'], ['../client/draftOff.ts', 'client.js', 'node'], ['../cloudflare/limits.ts', 'limits.js', 'node']]) {
  await build({ entryPoints: [new URL(entry, import.meta.url).pathname], outfile: new URL(`.generated/${output}`, import.meta.url).pathname,
    bundle: true, format: 'esm', platform, target: 'es2022', external: ['cloudflare:workers'], sourcemap: true });
}
