import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus } from 'node:os';

// Shared runners measure correctness plus directional latency. Enforce the original
// budgets only on a controlled host; never infer that host from CI or platform.
const mode = process.env.DRAFT_OFF_PERFORMANCE_MODE ?? 'observe';
assert.ok(['observe', 'enforce'].includes(mode), 'DRAFT_OFF_PERFORMANCE_MODE must be observe or enforce');

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b), round = n => n === undefined ? null : Math.round(n * 100) / 100;
  return { count: sorted.length, p50Ms: round(sorted[Math.ceil(sorted.length * .5) - 1]),
    p95Ms: round(sorted[Math.ceil(sorted.length * .95) - 1]), maxMs: round(sorted.at(-1)), samplesMs: samples.map(round) };
}

// Call from finally, before disposal, even when a functional assertion failed.
// Accept only numeric timings and static aggregate metadata, never replies/logs.
export function recordLatency({ file, samples, gatedMetrics, correctnessPassed, details }, {
  performanceMode = mode, directory = new URL('.generated/results/', import.meta.url), log = console.log,
} = {}) {
  assert.ok(['observe', 'enforce'].includes(performanceMode));
  const latency = Object.fromEntries(Object.entries(samples).map(([name, values]) => [name, summarize(values)]));
  const missing = gatedMetrics.filter(name => !latency[name]?.count);
  const violations = gatedMetrics.filter(name => latency[name]?.count && (latency[name].p95Ms > 2000 || latency[name].maxMs > 3000))
    .map(metric => ({ metric, p95Ms: latency[metric].p95Ms, maxMs: latency[metric].maxMs }));
  const performanceGate = { mode: performanceMode, status: missing.length ? 'INCOMPLETE' : violations.length ? 'EXCEEDED' : 'PASS',
    p95BudgetMs: 2000, maxBudgetMs: 3000, gatedMetrics, missing, violations };
  const report = { ...details, status: correctnessPassed && !missing.length && !(performanceMode === 'enforce' && violations.length) ? 'PASS' : 'FAIL',
    correctnessStatus: correctnessPassed ? 'PASS' : 'FAIL', timestamp: new Date().toISOString(),
    runtime: { node: process.versions.node, platform: process.platform, arch: process.arch,
      cpuModel: cpus()[0]?.model ?? 'unknown', availableParallelism: availableParallelism(), githubActions: process.env.GITHUB_ACTIONS === 'true' },
    performanceGate, latency };
  mkdirSync(directory, { recursive: true });
  writeFileSync(new URL(file, directory), JSON.stringify(report, null, 2) + '\n');
  log(`Stage E latency ${file}: ${JSON.stringify(report)}`);
  if (violations.length) log(`${process.env.GITHUB_ACTIONS === 'true' ? '::warning title=Stage E latency budget exceeded::' : 'Stage E latency WARNING: '}${performanceMode}: ${JSON.stringify(violations)}`);
  // Do not mask an earlier correctness failure with an incomplete timing gate.
  if (correctnessPassed) {
    assert.equal(missing.length, 0, `Missing Stage E timing samples: ${missing.join(', ')}`);
    if (performanceMode === 'enforce') assert.equal(violations.length, 0, `Stage E responsiveness regression: ${JSON.stringify(violations)}`);
  }
  return report;
}
