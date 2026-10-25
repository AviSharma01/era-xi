import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { delimiter, dirname } from 'node:path';

// The same sequential correctness lane is used locally and in CI. No benchmarks.
// Stage E records latency in observe mode by default; controlled hosts may opt in
// to DRAFT_OFF_PERFORMANCE_MODE=enforce without changing correctness coverage.
const root = fileURLToPath(new URL('../', import.meta.url));
if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Backend verification requires Node >=22.');
function run(args) {
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    cwd: root, stdio: 'inherit', env: { ...process.env, PATH: [dirname(process.execPath), process.env.PATH ?? ''].join(delimiter) },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run(['run', 'build']);
run(['run', 'typecheck']);
for (const stage of ['a', 'b', 'c', 'd']) run(['run', 'build', '--prefix', `backend/stage-${stage}`]);
for (const stage of ['a', 'b', 'c', 'd']) run(['run', 'typecheck', '--prefix', `backend/stage-${stage}`]);
const baseline = JSON.parse(readFileSync(new URL('stage-a/index-milestone/fixture-hashes-after.json', import.meta.url)));
for (const [name, expected] of Object.entries(baseline)) {
  const bytes = readFileSync(new URL(`stage-a/.generated/fixtures/${name}`, import.meta.url));
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error(`Canonical fixture changed: ${name}`);
}
for (const stage of ['a', 'b', 'c', 'd', 'e']) run(['test', '--prefix', `backend/stage-${stage}`]);
run(['run', 'test:draft-off-client:local']);
console.log(`Backend correctness PASS; ${Object.keys(baseline).length} canonical fixtures unchanged.`);
