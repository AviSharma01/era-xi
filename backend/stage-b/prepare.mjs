import { mkdirSync, existsSync } from 'node:fs';
import { build } from '../stage-a/node_modules/esbuild/lib/main.js';

if (!existsSync(new URL('../stage-a/.generated/catalogs.ts', import.meta.url))) {
  throw new Error('Run root build and backend/stage-a/prepare.mjs first; Stage B reuses those exact artifacts/fixtures.');
}
mkdirSync(new URL('.generated/', import.meta.url), { recursive: true });
for (const [entry, output] of [['harness.ts', 'harness.js'], ['../cloudflare/worker.ts', 'worker.js']]) {
  await build({ entryPoints: [new URL(entry, import.meta.url).pathname],
    outfile: new URL(`.generated/${output}`, import.meta.url).pathname,
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers'], sourcemap: true });
}
