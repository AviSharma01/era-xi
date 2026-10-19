import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { recordLatency } from './latency.mjs';

function fixture(t) {
  const path = mkdtempSync(join(tmpdir(), 'draft-off-latency-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  const lines = [], directory = pathToFileURL(path + '/');
  return { options: { directory, log: line => lines.push(line) }, lines,
    read: () => JSON.parse(readFileSync(new URL('smoke.json', directory))) };
}
const measured = { file: 'smoke.json', samples: { spin: [100, 200], lock: [100, 3100], finalSubmit: [2100] },
  gatedMetrics: ['spin', 'lock', 'finalSubmit'], correctnessPassed: true, details: { participants: 8 } };

test('ordinary correctness records and warns on named p95/max breaches without weakening the controlled gate', t => {
  const { options, lines, read } = fixture(t);
  const report = recordLatency(measured, { ...options, performanceMode: 'observe' });
  assert.equal(report.status, 'PASS'); assert.equal(report.correctnessStatus, 'PASS');
  assert.equal(report.performanceGate.status, 'EXCEEDED');
  assert.deepEqual(report.performanceGate.violations, [
    { metric: 'lock', p95Ms: 3100, maxMs: 3100 }, { metric: 'finalSubmit', p95Ms: 2100, maxMs: 2100 },
  ]);
  assert.deepEqual(read(), report);
  assert.ok(lines.some(line => line.includes('lock') && line.includes('3100')));
  assert.ok(lines.some(line => line.includes('WARNING') || line.startsWith('::warning')));
});

test('controlled performance failure persists and prints samples before throwing with metric names and values', t => {
  const { options, lines, read } = fixture(t);
  assert.throws(() => recordLatency(measured, { ...options, performanceMode: 'enforce' }), /responsiveness regression:.*lock.*3100.*finalSubmit.*2100/);
  assert.equal(read().status, 'FAIL'); assert.equal(read().correctnessStatus, 'PASS');
  assert.deepEqual(read().latency.lock.samplesMs, [100, 3100]);
  assert.ok(lines[0].includes('"maxMs":3100'));
});

test('a functional failure retains partial measurements and remains a failure in either performance mode', t => {
  const { options, read } = fixture(t);
  for (const performanceMode of ['observe', 'enforce']) {
    recordLatency({ ...measured, correctnessPassed: false, samples: { spin: [2500], lock: [], finalSubmit: [] } }, { ...options, performanceMode });
    const report = read();
    assert.equal(report.status, 'FAIL'); assert.equal(report.correctnessStatus, 'FAIL');
    assert.equal(report.performanceGate.status, 'INCOMPLETE');
    assert.deepEqual(report.performanceGate.missing, ['lock', 'finalSubmit']);
    assert.equal(report.latency.lock.maxMs, null);
  }
});

test('missing measurements fail completed correctness runs; passing samples retain the original controlled budgets', t => {
  const { options, read } = fixture(t);
  assert.throws(() => recordLatency({ ...measured, samples: {} }, { ...options, performanceMode: 'observe' }), /Missing Stage E timing samples/);
  assert.equal(read().status, 'FAIL');
  const report = recordLatency({ ...measured, samples: { spin: [2000], lock: [100], finalSubmit: [50] } }, { ...options, performanceMode: 'enforce' });
  assert.equal(report.status, 'PASS'); assert.equal(report.performanceGate.status, 'PASS');
  assert.equal(report.performanceGate.p95BudgetMs, 2000); assert.equal(report.performanceGate.maxBudgetMs, 3000);
});

test('the max budget is enforced independently when p95 is within budget', t => {
  const { options, read } = fixture(t);
  const samples = { spin: [...Array(20).fill(100), 3100], lock: [100], finalSubmit: [50] };
  assert.throws(() => recordLatency({ ...measured, samples }, { ...options, performanceMode: 'enforce' }), /"metric":"spin","p95Ms":100,"maxMs":3100/);
  samples.spin[20] = 3000;
  recordLatency({ ...measured, samples }, { ...options, performanceMode: 'enforce' });
  assert.equal(read().performanceGate.status, 'PASS');
});
