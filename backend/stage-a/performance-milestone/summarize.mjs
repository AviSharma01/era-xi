// Analysis only. Invokes the original Stage A gate expressions without changing the harness.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const read = p => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const baseline = read('../results/full.json');
const runs = [read('full-modern.json'), read('full-repeat.json')];
const diagnostic = read('diagnostic.json');
const oldDiagnostic = read('../results/diagnostic.json');
const harness = read('../baseline-before-counts/harness-hashes.json');
for (const [name, hash] of Object.entries(harness)) {
  assert.equal(createHash('sha256').update(readFileSync(new URL('../'+name, import.meta.url))).digest('hex'), hash);
}
const source = readFileSync(new URL('../report.mjs', import.meta.url), 'utf8');
const keys = source.slice(source.indexOf('const keys='), source.indexOf('const table='));
const gateCode = source.slice(source.indexOf('const meets ='), source.indexOf('const phases='));
const originalGates = new Function('data', 'assert', keys + gateCode + 'return { decision, gates };');
const gates = runs.map(d => originalGates(d, assert));
writeFileSync(new URL('gate.json', import.meta.url), JSON.stringify({ baseline: read('../results/gate.json'), runs: gates }, null, 2)+'\n');
const seconds = x => (x/1000).toFixed(3);
const stat = (d,k) => `${seconds(d.summaries[k].p95Ms)} / ${seconds(d.summaries[k].maxMs)}`;
const cases = [['spin','Warm SPIN'],['lock','Warm LOCK'],['cold-spin','Cold SPIN'],['final-submit','Final submission']];
const rows = cases.map(([k,label]) => [label,'primary/8/late/'+k]);
rows.push(['Eight-player queued SPIN','primary/8/burst-spin'],['Eight-player queued LOCK','primary/8/burst-lock'],['Overdue cold recovery','primary/8/deadline/overdue-cold']);
const hot = d => d.hottestSelfSamples.find(r => r.functionName === 'evaluateFutureCompletion');
const currentHot = hot(diagnostic), previousHot = hot(oldDiagnostic);
let out = `# Focused legality performance milestone — ${gates.every(g=>g.decision==='GO')?'GO':'HOLD'}\n\n`;
out += `Only evaluateFutureCompletion was optimized: canonical minimum costs are still discovered by the original ordered variant scan; a domestic count replaces repeated binary-cost sorting. Keeper ordering, UNKNOWN errors, fields, freezes, and overseas accounting remain unchanged. No caching, indexing, M1–M3 protocol/persistence change, simulation change, deployment, commit, or push.\n\n`;
out += `## Measurements and comparison\n\nThe original baseline used **${baseline.primaryEra}**. Both complete optimized runs automatically selected **${runs[0].primaryEra}**, with Impact included in the existing near-equal-era expansion. These main-table rows compare the baseline workload with the newly selected worst fixture; they are **not matched-era causal speedups**. All five eras passed the unchanged smoke/correctness checks in both runs. Both complete runs are retained; no faster run was selected or samples dropped.\n\n`;
out += '| Operation | Baseline Impact p95 / max (s) | Optimized Modern run 1 p95 / max (s) | Optimized Modern run 2 p95 / max (s) |\n|---|---:|---:|---:|\n';
out += rows.map(([label,k])=>`| ${label} | ${stat(baseline,k)} | ${stat(runs[0],k)} | ${stat(runs[1],k)} |`).join('\n')+'\n\n';
out += 'Warm rows have 30 samples, cold rows 20, bursts 20 trials / 160 client responses per action. Process-cold has five samples. Cold p95 is directional; underlying samples/maxima follow.\n\n';
out += '### Matched Impact comparison\n\nThe unchanged harness performs five expanded Impact burst/final trials per optimized run, and one Impact smoke SPIN. It does not perform a full Impact cold-SPIN/overdue matrix after selecting Modern. **A full matched-era comparison for those two operations is therefore unavailable**, rather than inferred from Modern data.\n\n';
out += '| Impact operation | Baseline p95 / max (s) | Optimized run 1 p95 / max (s) | Optimized run 2 p95 / max (s) | Optimized sample count per run |\n|---|---:|---:|---:|---:|\n';
for (const [label,bk,nk] of [['Queued SPIN','primary/8/burst-spin','era-impact/8/expanded-burst-spin'],['Queued LOCK','primary/8/burst-lock','era-impact/8/expanded-burst-lock'],['Final submission','primary/8/late/final-submit','era-impact/8/expanded-final-submit']]) {
  out += `| ${label} | ${stat(baseline,bk)} | ${stat(runs[0],nk)} | ${stat(runs[1],nk)} | ${runs[0].summaries[nk].count} |\n`;
}
out += `\nImpact smoke SPIN (one sample each): baseline ${seconds(baseline.samples['era-impact/8/late/spin'][0].clientMs)} s; optimized ${runs.map(d=>seconds(d.samples['era-impact/8/late/spin'][0].clientMs)).join(' / ')} s. These single samples have no meaningful p95.\n\n`;
out += '## Original responsiveness gates\n\nOriginal report.mjs completeness assertions and gate expressions were executed unchanged against both complete runs; harness file hashes are verified.\n\n';
out += '| Gate | Run 1 | Run 2 |\n|---|---|---|\n'+Object.keys(gates[0].gates).map(k=>`| ${k} | ${gates[0].gates[k]?'PASS':'FAIL'} | ${gates[1].gates[k]?'PASS':'FAIL'} |`).join('\n')+'\n\n';
out += 'Budgets: warm p95/max 0.5/1 s; cold 1.5/3 s; per-client burst, final submission, and deadline-to-handler completion 2/3 s. A provider CPU quota was not substituted for a product gate. Timed drafting still exceeds the burst responsiveness budget.\n\n';
out += '## Profiling and remaining bottleneck\n\n';
out += `The separate unchanged Impact inspector diagnostic measured ${diagnostic.profileDurationMs.toFixed(0)} ms / ${diagnostic.sampleCount} samples. evaluateFutureCompletion self samples: ${currentHot?.selfSampleMs.toFixed(0)??'not among reported hottest functions'} ms (${currentHot?(100*currentHot.selfSampleMs/diagnostic.profileDurationMs).toFixed(1):'unavailable'}% sampled elapsed), versus ${previousHot.selfSampleMs.toFixed(0)} ms / ${(100*previousHot.selfSampleMs/oldDiagnostic.profileDurationMs).toFixed(1)}% before. The shorter optimized profile has less attribution precision; this is a diagnostic, not an independent latency distribution or CPU-quota measurement.\n\n`;
out += 'Top optimized self samples:\n\n| Function | Self sampled ms |\n|---|---:|\n'+diagnostic.hottestSelfSamples.slice(0,12).map(r=>`| ${r.functionName||'(anonymous)'} | ${r.selfSampleMs.toFixed(1)} |`).join('\n')+'\n\n';
out += '| Command, run 2 | Mean restore (ms) | Reduce (ms) | Storage read (ms) | Storage write (ms) | Serialize (ms) |\n|---|---:|---:|---:|---:|---:|\n';
for (const k of ['spin','lock','final-submit']) {
  const samples=runs[1].samples['primary/8/late/'+k];
  out += `| ${k} | `+['restoreMs','reduceMs','storageReadMs','storageWriteMs','serializeMs'].map(f=>(samples.reduce((s,r)=>s+(r.metrics[f]??0),0)/samples.length).toFixed(1)).join(' | ')+' |\n';
}
out += '\nThe original variant scan and per-call canonical-cost Map construction remain in the shared feasibility path, and repeated replay work queues inside one room. The next smallest proposal is a catalog-derived canonical minimum-cost index used by this helper, with explicit equivalence coverage preserving drafted-player exclusion and the original first UNKNOWN error in scan order. It must not weaken restore validation or cache command results. **This proposal requires review and is not implemented.** No memoization or broader optimization was added.\n\n';
out += '## Underlying cold and deadline samples\n\n';
for (let i=0;i<runs.length;i++) {
  const d=runs[i]; out += `### Run ${i+1}\n\nStarted ${d.startedAt}; completed ${d.completedAt} UTC.\n\n`;
  for (const k of ['primary/8/late/cold-spin','primary/8/late/cold-snapshot','primary/8/resolved/cold-snapshot','primary/8/late/process-cold-snapshot','primary/8/deadline/overdue-cold']) out += `- ${k}, HTTP ms: ${d.samples[k].map(r=>r.clientMs.toFixed(1)).join(', ')}.\n`;
  out += '- Deadline-to-handler completion ms (20 native alarms, alternating cold/warm): '+d.deadlines.map(r=>r.deadlineToCompletionMs).join(', ')+'.\n';
  out += '- Alarm delivery delay ms: '+d.deadlines.map(r=>r.alarmDeliveryDelayMs).join(', ')+'.\n\n';
}
out += '## Verification and boundaries\n\n- Focused legality/equivalence: 14 passed. Frozen sorting implementation serves as a test-only oracle; five real eras, first/interior/last variants, partial/near-complete/completed/oversized XIs, keeper-needed/satisfied, overseas 0/1/3/4/5, more than 16,000 synthetic domestic/overseas/keeper/variant combinations, ordered fail-closed errors, and immutable fields.\n- Full existing release pipeline: 276 tests passed; production web build and route/artifact/MIME smoke passed; Era Draft smoke validation passed. Root typecheck passed.\n- Native Stage A correctness: six tests passed; Stage A typecheck passed.\n- All 80 pre/post generated fixture SHA-256 hashes match, including canonical bytes and receipt payloads. Harness hashes match. Runtime exact retries, cold restores, transactions/rollback, native alarms, and exactly-once deadline recovery retain their checks.\n- No optimized benchmark transport failures, retries, or omitted failed attempts were recorded. Original baseline transport incident remains part of the preserved baseline evidence.\n\nLocal Apple M5/workerd loopback measurements do not predict deployed Cloudflare hardware, Internet RTT, or multi-room load. Twenty cold samples and small expanded-era sets provide directional percentiles only. The original baseline results remain in ../results/; optimized complete raw matrices, profile, gates, and check logs are in this directory. Changes remain uncommitted and unpushed. **HOLD for M4 Stages B–E; stop after this milestone.**\n';
writeFileSync(new URL('report.md', import.meta.url), out);
console.log(JSON.stringify(gates));
