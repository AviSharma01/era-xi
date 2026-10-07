// Supplemental fixed-era checks requested by the user. Existing Stage A code stays unchanged.
// Uses the exact Stage A runtime, fixtures, independent connections, envelopes, and burst ordering.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { cpus, totalmem, release, arch } from 'node:os';
import { fixture, startRuntime, request, seed, envelope, summary } from '../runtime.mjs';

const output = { era: 'era-impact', startedAt: new Date().toISOString(),
  environment: { node: process.version, platform: process.platform, arch: arch(), osRelease: release(),
    cpu: cpus()[0].model, cpuCount: cpus().length, memoryBytes: totalmem() }, runs: [] };
const save = () => writeFileSync(new URL('matched-impact.json', import.meta.url), JSON.stringify(output, null, 2)+'\n');
const late = fixture(output.era, 8, 'late'), spun = fixture(output.era, 8, 'spun');
for (let run = 0; run < 2; run++) {
  const runtime = await startRuntime(new URL(`../.state/index-matched-${Date.now()}-${run}/`, import.meta.url).pathname);
  const result = { run: run + 1, startedAt: new Date().toISOString(), samples: { spin: [], lock: [] }, bursts: [] };
  output.runs.push(result);
  try {
    for (let trial = 0; trial < 20; trial++) {
      await seed(runtime, 'measured', late);
      for (const stage of ['spin', 'lock']) {
        const begin = performance.now();
        const responses = await Promise.all(late.draftRevisions.map((p, index) => request(runtime, 'measured', 'command', {
          envelope: stage === 'spin' ? envelope(`burst-spin-${index}`, p.revision, { type: 'SPIN' }) : spun.lockEnvelopes[index],
        }, p.participantId)));
        responses.forEach(r => assert.ok(r.result.ok));
        result.samples[stage].push(...responses.map(r => r.sample));
        result.bursts.push({ trial, stage, drainMs: performance.now() - begin,
          participants: responses.map((r, index) => ({ participantId: `p${index}`, ...r.sample })) });
      }
      save();
      console.log(`Matched Impact run ${run + 1}: burst ${trial + 1}/20 complete`);
    }
    result.summaries = Object.fromEntries(Object.entries(result.samples).map(([key, samples]) => [key, summary(samples)]));
    result.completedAt = new Date().toISOString();
    save();
  } catch (error) {
    result.failure = { at: new Date().toISOString(), error: String(error), sample: error.stageASample };
    save();
    throw error;
  } finally {
    await runtime.mf.dispose();
  }
}
output.completedAt = new Date().toISOString();
save();
