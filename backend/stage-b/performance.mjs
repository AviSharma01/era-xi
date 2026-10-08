// Deliberately small matched regression check; never invokes the Stage A full matrix.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, cpus, totalmem, release, arch } from 'node:os';
import { join } from 'node:path';
import * as stageA from '../stage-a/runtime.mjs';
import * as stageB from './runtime.mjs';

const results = new URL('results/', import.meta.url);
const resultName = process.argv.includes('--hint-authority') ? 'hint-authority-performance' : 'performance';
mkdirSync(results, { recursive: true });
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const fixtureHashes = () => Object.fromEntries(readdirSync(new URL('../stage-a/.generated/fixtures/', import.meta.url)).sort().map((name) =>
  [name, hash(new URL(`../stage-a/.generated/fixtures/${name}`, import.meta.url))]));
const original = JSON.parse(readFileSync(new URL('../stage-a/index-milestone/full-2.json', import.meta.url)));
const output = { startedAt: new Date().toISOString(),
  environment: { node: process.version, platform: process.platform, arch: arch(), osRelease: release(),
    cpu: cpus()[0].model, cpuCount: cpus().length, memoryBytes: totalmem() },
  compatibilityDate: '2026-10-01', dependencyPackage: '../stage-a/package-lock.json',
  indexedBaseline: { source: '../stage-a/index-milestone/full-2.json', primaryEra: original.primaryEra,
    summaries: Object.fromEntries(Object.entries(original.summaries).filter(([key]) => [
      'primary/8/late/spin', 'primary/8/late/lock', 'primary/8/late/cold-spin',
      'primary/8/late/final-submit', 'primary/8/deadline/overdue-cold',
    ].includes(key))) },
  fixtureHashesBefore: fixtureHashes(), adapters: {},
  limitations: ['Small regression sample; p95 is directional and is the maximum for n < 20.',
    'Five burst trials produce 40 correlated participant responses per action, not 40 independent room trials.',
    'Sequential local workerd/loopback runs; not deployed hardware, Internet RTT, quota or multi-room load measurements.'],
};
const save = () => writeFileSync(new URL(`${resultName}.json`, results), JSON.stringify(output, null, 2) + '\n');

for (const [name, adapter] of [['stageA', stageA], ['stageB', stageB]]) {
  // Miniflare V5 derives module names from cwd. Match each harness's normal npm cwd;
  // loading Stage A from Stage B's directory otherwise creates an outside-root module.
  process.chdir(new URL(name === 'stageA' ? '../stage-a/' : './', import.meta.url).pathname);
  const result = { samples: {}, summaries: {}, bursts: [] };
  output.adapters[name] = result; save();
  let runtime;
  try { runtime = await adapter.startRuntime(mkdtempSync(join(tmpdir(), `draft-off-regression-${name}-`))); }
  catch (error) { result.failure = { phase: 'startup', error: String(error) }; save(); throw error; }
  const collect = async (key, action, input, participant) => {
    const response = await adapter.request(runtime, 'measured', action, input, participant);
    (result.samples[key] ??= []).push(response.sample);
    assert.ok(response.result.ok ?? true);
    return response;
  };
  try {
    const era = 'era-modern-pre-impact'; // Indexed Stage A's repeated worst-era fixture.
    const late = adapter.fixture(era, 8, 'late'), spun = adapter.fixture(era, 8, 'spun');
    const submitted = adapter.fixture(era, 8, 'submitted'), complete = adapter.fixture(era, 8, 'complete');
    for (let trial = 0; trial < 8; trial++) {
      await adapter.seed(runtime, 'measured', late);
      await collect('warmSpin', 'command', { envelope: adapter.envelope('warm-spin', late.draftRevisions[0].revision, { type: 'SPIN' }) });
      await adapter.seed(runtime, 'measured', spun);
      await collect('warmLock', 'command', { envelope: spun.lockEnvelopes[0] });
    }
    for (let trial = 0; trial < 5; trial++) {
      await adapter.seed(runtime, 'measured', late); await adapter.evict(runtime, 'measured');
      await collect('coldSpin', 'command', { envelope: adapter.envelope('cold-spin', late.draftRevisions[0].revision, { type: 'SPIN' }) });
      await adapter.seed(runtime, 'measured', submitted);
      const final = await collect('finalSubmit', 'command', { envelope: adapter.envelope('final-submit', submitted.draftRevisions[7].revision, { type: 'SUBMIT' }) }, 'p7');
      assert.equal(final.result.view.phase, 'COMPLETE');
      if (name === 'stageA') await adapter.seed(runtime, 'measured', complete, 900020, false);
      else {
        await adapter.seed(runtime, 'measured', complete, 100, false);
        await adapter.request(runtime, 'measured', 'time', { logicalNow: 900020, suppress: true });
      }
      await adapter.evict(runtime, 'measured');
      const overdue = await collect('coldOverdue', 'snapshot'); assert.equal(overdue.result.phase, 'COMPLETE');
    }
    for (const eraId of [era, 'era-impact']) {
      const late = adapter.fixture(eraId, 8, 'late'), spun = adapter.fixture(eraId, 8, 'spun');
      for (let trial = 0; trial < 5; trial++) {
        await adapter.seed(runtime, 'measured', late);
        for (const action of ['spin', 'lock']) {
          const responses = await Promise.all(late.draftRevisions.map((p, index) => adapter.request(runtime, 'measured', 'command', {
            envelope: action === 'spin' ? adapter.envelope(`burst-spin-${index}`, p.revision, { type: 'SPIN' }) : spun.lockEnvelopes[index],
          }, p.participantId)));
          responses.forEach((response) => assert.ok(response.result.ok));
          const key = `${eraId}/burst-${action}`;
          (result.samples[key] ??= []).push(...responses.map((response) => response.sample));
          result.bursts.push({ eraId, trial, action, participants: responses.map((response, index) => ({ participantId: `p${index}`, ...response.sample })) });
        }
      }
    }
    result.summaries = Object.fromEntries(Object.entries(result.samples).map(([key, samples]) => {
      const value = adapter.summary(samples);
      // Stage B intentionally has no phase instrumentation; missing counts are not zero restores.
      if (samples.every((sample) => sample.metrics.restoreCalls === undefined)) delete value.meanRestoreCalls;
      return [key, value];
    }));
    result.completedAt = new Date().toISOString(); save();
    console.log(`${name} small matched check complete`);
  } catch (error) {
    result.failure = { error: String(error), sample: error.stageASample }; save(); throw error;
  } finally { await runtime.mf.dispose(); }
}
output.fixtureHashesAfter = fixtureHashes();
assert.deepEqual(output.fixtureHashesAfter, output.fixtureHashesBefore);
const frozenHashes = JSON.parse(readFileSync(new URL('../stage-a/index-milestone/fixture-hashes-after.json', import.meta.url)));
assert.deepEqual(output.fixtureHashesAfter, frozenHashes);
output.gates = Object.fromEntries(Object.entries(output.adapters.stageB.summaries).map(([key, value]) => {
  const [p95, max] = key.startsWith('warm') ? [500, 1000] : key === 'coldSpin' ? [1500, 3000] : [2000, 3000];
  return [key, { p95LimitMs: p95, maxLimitMs: max, pass: value.p95Ms <= p95 && value.maxMs <= max }];
}));
output.completedAt = new Date().toISOString(); save();
for (const gate of Object.values(output.gates)) assert.ok(gate.pass, 'Stage B interaction regression gate failed');
const rows = Object.entries(output.adapters.stageB.summaries).map(([key, b]) => {
  const a = output.adapters.stageA.summaries[key];
  return `| ${key} | ${b.count} | ${a.p95Ms.toFixed(1)} / ${a.maxMs.toFixed(1)} | ${b.p95Ms.toFixed(1)} / ${b.maxMs.toFixed(1)} | PASS |`;
});
writeFileSync(new URL(`${resultName}.md`, results), `# Stage B small indexed regression check\n\nSequential matched native workerd runs; unchanged Stage A indexed catalog, fixture bytes, M3 envelopes, and independent HTTP connections.\n\n| Operation | Responses per adapter | Stage A p95 / max (ms) | Stage B p95 / max (ms) | Original gate |\n| --- | ---: | ---: | ---: | --- |\n${rows.join('\n')}\n\n${output.limitations.join(' ')} All samples are retained in ${resultName}.json; no failures, omitted trials, or automatic retries. All 80 fixture hashes match the committed indexed milestone.\n\nEnvironment: ${output.environment.cpu}, Node ${output.environment.node}, ${output.environment.platform}/${output.environment.arch}, OS ${output.environment.osRelease}. Same pinned Stage A Miniflare/workerd packages and compatibility date. Historical full indexed primary-era p95: warm SPIN 81 ms, LOCK 100 ms, cold SPIN 194 ms, final submission 187 ms, cold overdue 275 ms. The small paired runs are the direct current comparison; the original full baseline remains unchanged.\n`);
console.log(JSON.stringify(output.adapters.stageB.summaries, null, 2));
