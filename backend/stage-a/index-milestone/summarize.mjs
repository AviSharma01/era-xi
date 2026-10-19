// Report analysis only; original Stage A implementation and gate expressions are unchanged.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const read = p => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const runs = [read('full-1.json'), read('full-2.json')];
const prior = [read('../performance-milestone/full-modern.json'), read('../performance-milestone/full-repeat.json')];
const original = read('../results/full.json');
const matched = read('matched-impact.json');
const diagnostic = read('diagnostic.json'), previousDiagnostic = read('../performance-milestone/diagnostic.json');
const harnessHashes = read('../baseline-before-counts/harness-hashes.json');
for (const [name, hash] of Object.entries(harnessHashes)) assert.equal(
  createHash('sha256').update(readFileSync(new URL('../'+name, import.meta.url))).digest('hex'), hash);
assert.deepEqual(read('fixture-hashes-before.json'), read('fixture-hashes-after.json'));
assert.ok(read('verification.json').checks.every(c=>c.exitCode===0));
const gateSource = readFileSync(new URL('../report.mjs', import.meta.url), 'utf8');
const keys = gateSource.slice(gateSource.indexOf('const keys='), gateSource.indexOf('const table='));
const expressions = gateSource.slice(gateSource.indexOf('const meets ='), gateSource.indexOf('const phases='));
const originalGate = new Function('data', 'assert', keys+expressions+'return {decision,gates};');
const gates = runs.map(d=>{ assert.ok(d.completedAt); return originalGate(d,assert); });
const matchedGates = matched.runs.map(d=>{
  assert.ok(d.completedAt); assert.ok(!d.failure); assert.equal(d.bursts.length,40);
  for (const k of ['spin','lock']) assert.equal(d.samples[k].length,160);
  // Reuse the exact original burst gate by substituting only the fixed-era summary rows.
  const data = {...runs[0], summaries:{...runs[0].summaries,
    'primary/8/burst-spin':d.summaries.spin, 'primary/8/burst-lock':d.summaries.lock}};
  return originalGate(data,assert).gates.bursts;
});
assert.equal(matched.runs.length,2);
for(const d of [...runs,matched]) assert.deepEqual(d.environment, runs[0].environment);
const decision = gates.every(g=>g.decision==='GO') && matchedGates.every(Boolean) ? 'GO' : 'HOLD';
writeFileSync(new URL('gate.json',import.meta.url),JSON.stringify({decision,runs:gates,matchedImpactBursts:matchedGates},null,2)+'\n');
const s = ms => (ms/1000).toFixed(3);
const pair = (data,key) => `${s(data.summaries[key].p95Ms)} / ${s(data.summaries[key].maxMs)}`;
const rows = [['Warm SPIN','primary/8/late/spin'],['Warm LOCK','primary/8/late/lock'],['Cold SPIN','primary/8/late/cold-spin'],
  ['Queued SPIN','primary/8/burst-spin'],['Queued LOCK','primary/8/burst-lock'],['Final submission','primary/8/late/final-submit'],
  ['Overdue cold recovery','primary/8/deadline/overdue-cold']];
const weights = profile => {
  const nodes = new Map(profile.nodes.map(n=>[n.id,n])), result = new Map();
  for(let i=0;i<(profile.samples??[]).length;i++){
    const label=nodes.get(profile.samples[i])?.callFrame.functionName||'(anonymous)';
    result.set(label,(result.get(label)??0)+(profile.timeDeltas?.[i]??0)/1000);
  }
  return result;
};
const selfMs = weights(read('diagnostic.cpuprofile')).get('evaluateFutureCompletion')??0;
const previousSelf = previousDiagnostic.hottestSelfSamples.find(r=>r.functionName==='evaluateFutureCompletion').selfSampleMs;
let out = `# Catalog minimum-cost index performance milestone — ${decision}\n\n`;
out += `**${decision} for M4 Stages B–E under the original local product-performance gates.** This milestone stops here: no B–E implementation or deployment, no memoization, no broader caching, no commit or push.\n\n`;
out += '## Scope and exact behavior\n\nFull and scoped immutable catalogs eagerly derive one canonical minimum-cost index per era. The index stores domestic/canonical counts, private read-only minimum-cost lookup, and frozen UNKNOWN identity rows in the original team-season/candidate scan order. evaluateFutureCompletion checks the first undrafted UNKNOWN, subtracts each distinct drafted canonical ID once, then uses the existing keeper/overseas calculation and sorted keeper iteration. UNKNOWN-only canonical players never receive a domestic/overseas classification. Adapters without an index retain the original ordered scan; adapters that alter candidates must omit or rebuild the index. No feasibility result, picks, room state, or command is cached.\n\n';
out += 'The frozen current count-based implementation and earlier sorting implementation are test-only differential oracles. No M1–M3 command, persistence, receipt, seed, simulation, canonical serialization, or catalog fingerprint contract changed. The optional catalog index is derived runtime data and is never persisted or included in game-input artifacts.\n\n';
out += '## Complete repeated matrices\n\n';
out += `Prior count-only primary era: ${prior.map(d=>d.primaryEra).join(' / ')}. Indexed primary era: ${runs.map(d=>d.primaryEra).join(' / ')}. Each run uses the unchanged five-era smoke ranking and existing expansion rule. Expanded eras: ${runs.map(d=>d.expandedEras.join(', ')||'none').join(' / ')}. When eras match, the table is a matched fixture comparison; any era difference must be treated as a worst-workload comparison rather than a causal speedup. Fixture hashes are identical throughout.\n\n`;
out += '| Operation | Count-only run 1 p95 / max (s) | Count-only run 2 p95 / max (s) | Indexed run 1 p95 / max (s) | Indexed run 2 p95 / max (s) |\n|---|---:|---:|---:|---:|\n';
out += rows.map(([label,k])=>`| ${label} | ${pair(prior[0],k)} | ${pair(prior[1],k)} | ${pair(runs[0],k)} | ${pair(runs[1],k)} |`).join('\n')+'\n\n';
out += 'Warm commands: 30 samples per row; object-cold/overdue: 20 each; queued bursts: 20 trials, eight independently connected clients, 160 responses per action. Process-cold: five full workerd restarts per matrix. Both complete runs are retained; no samples are dropped, no retries, no concurrent builds/tests/profiling during measurement. Cold percentiles are directional, with underlying samples/maxima below.\n\n';
out += '## Matched Impact bursts\n\nTwo additional independent fresh-runtime runs each execute 20 late-draft eight-player SPIN/LOCK burst pairs using the unchanged Stage A runtime, fixtures, transport and command envelopes. The supplemental driver pins only the requested era; original harness files remain unchanged.\n\n';
out += '| Impact burst | Original Stage A p95 / max (s) | Count-only expanded run 1 p95 / max (s) | Count-only expanded run 2 p95 / max (s) | Indexed matched run 1 p95 / max (s) | Indexed matched run 2 p95 / max (s) |\n|---|---:|---:|---:|---:|---:|\n';
for (const k of ['spin','lock']) out += `| ${k} | ${pair(original,'primary/8/burst-'+k)} | ${pair(prior[0],'era-impact/8/expanded-burst-'+k)} | ${pair(prior[1],'era-impact/8/expanded-burst-'+k)} | ${pair(matched.runs[0],k)} | ${pair(matched.runs[1],k)} |\n`;
out += '\nOriginal Stage A: 160 client responses per action; count-only expanded: 40 per action/run; indexed dedicated matched: 160 per action/run. Participant responses share each trial’s room queue; 160 responses are not 160 independent room trials. All requests must succeed; failures would be preserved and invalidate completion.\n\n';
out += '## Original gates and repeat consistency\n\nOriginal report.mjs completeness assertions and performance expressions were executed unchanged against both full matrices. Matched Impact applies the exact original burst gate, without relaxing thresholds.\n\n| Gate | Indexed full run 1 | Indexed full run 2 |\n|---|---|---|\n';
out += Object.keys(gates[0].gates).map(k=>`| ${k} | ${gates[0].gates[k]?'PASS':'FAIL'} | ${gates[1].gates[k]?'PASS':'FAIL'} |`).join('\n')+'\n\n';
out += `Matched Impact burst gate: ${matchedGates.map(v=>v?'PASS':'FAIL').join(' / ')}. Overall decision: **${decision}**. Warm p95/max ≤0.5/1 s; cold ≤1.5/3 s; burst/final/deadline-to-handler completion ≤2/3 s. Provider CPU limits are not gates.\n\n`;
out += '| Operation | Indexed p95 range (s) | Largest max across both full runs (s) |\n|---|---:|---:|\n';
out += rows.map(([label,k])=>`| ${label} | ${s(Math.min(...runs.map(d=>d.summaries[k].p95Ms)))}–${s(Math.max(...runs.map(d=>d.summaries[k].p95Ms)))} | ${s(Math.max(...runs.map(d=>d.summaries[k].maxMs)))} |`).join('\n')+'\n\n';
out += '## Updated profiling and attribution\n\n';
out += `A separate unchanged Impact inspector diagnostic measured ${diagnostic.profileDurationMs.toFixed(1)} ms / ${diagnostic.sampleCount} samples. evaluateFutureCompletion self samples are ${selfMs.toFixed(1)} ms (${(100*selfMs/diagnostic.profileDurationMs).toFixed(1)}% sampled elapsed), versus count-only ${previousSelf.toFixed(1)} ms (${(100*previousSelf/previousDiagnostic.profileDurationMs).toFixed(1)}%). Attribution comes from the complete raw profile, including functions outside the diagnostic’s top-20 list. Short profiles are directional; absence of samples does not prove zero CPU cost.\n\n`;
out += '| Current function | Self sampled ms |\n|---|---:|\n'+diagnostic.hottestSelfSamples.slice(0,12).map(r=>`| ${r.functionName||'(anonymous)'} | ${r.selfSampleMs.toFixed(1)} |`).join('\n')+'\n\n';
out += '| Command, indexed full run 2 | Mean restore (ms) | Reduce (ms) | Storage read (ms) | Storage write (ms) | Serialize (ms) |\n|---|---:|---:|---:|---:|---:|\n';
for(const k of ['spin','lock','final-submit']){
  const samples=runs[1].samples['primary/8/late/'+k];
  out += `| ${k} | `+['restoreMs','reduceMs','storageReadMs','storageWriteMs','serializeMs'].map(f=>(samples.reduce((sum,r)=>sum+(r.metrics[f]??0),0)/samples.length).toFixed(1)).join(' | ')+' |\n';
}
out += '\nRestoreMs overlaps nested storage/resume timings; do not add it to those phases. Heap observations are available in diagnostic.json and are not peak-memory/quota/headroom proofs.\n\n';
out += decision==='GO' ? 'The requested local responsiveness gate is met consistently, including matched Impact queues. No further optimization is required for this milestone. Remaining replay validation/storage/serialization costs are retained; no memoization or broader optimization is proposed or implemented here. Worker → one Durable Object per room → M3 → M2 → M1 remains unchanged.\n\n' : 'Burst responsiveness still misses the gate. The top remaining sampled functions and restore attribution above identify the next measured bottleneck. Stop for review before any memoization or broader change; no further optimization is implemented.\n\n';
out += '## Underlying cold and deadline samples\n\n';
for(let i=0;i<runs.length;i++){
  const d=runs[i];out+=`### Full run ${i+1}\n\nStarted ${d.startedAt}, completed ${d.completedAt} UTC.\n\n`;
  for(const k of ['primary/8/late/cold-spin','primary/8/late/cold-snapshot','primary/8/resolved/cold-snapshot','primary/8/late/process-cold-snapshot','primary/8/deadline/overdue-cold']) out+=`- ${k}, HTTP ms: ${d.samples[k].map(r=>r.clientMs.toFixed(1)).join(', ')}.\n`;
  out+='- Process startup separately, ms: '+d.samples['primary/8/late/process-cold-snapshot'].map(r=>r.runtimeBootMs.toFixed(1)).join(', ')+'.\n';
  out+='- Deadline-to-handler completion ms, 20 native alarms alternating cold/warm: '+d.deadlines.map(r=>r.deadlineToCompletionMs).join(', ')+'.\n';
  out+='- Native alarm delivery delay ms: '+d.deadlines.map(r=>r.alarmDeliveryDelayMs).join(', ')+'.\n\n';
}
out += '## Verification and limits\n\n- 18 focused legality/feasibility/scoped-catalog tests passed: all five eras, first/interior/last player-season variants, partial/near-complete/completed/oversized XIs, keeper-needed/satisfied, overseas boundaries, 16,224 synthetic combination checks against both frozen implementations, UNKNOWN scan order/drafted exclusions, all-UNKNOWN exclusion, duplicate and cross-era picks, immutable index/results, and no candidate rescans on indexed calls.\n- Full existing release pipeline: 278 tests passed; production web build and route/artifact/MIME smoke passed; Era Draft smoke validation passed. Root and Stage A typechecks passed.\n- Six unchanged native Stage A tests passed: all-era restoration/retries, participant races, atomic rollback, cold/process recovery, exactly-once deadline recovery and repeated alarms.\n- All 80 fixture SHA-256 hashes match across the original, count-only, and indexed versions, including canonical bytes, seed-derived simulation outcomes and receipts. Original harness source hashes match.\n- Raw complete matrices, all per-client burst samples, matched Impact runs, profile, gate expressions/results and check logs are retained. All runtimes are disposed after each run; no benchmark is left running.\n\n';
out += `Environment: ${runs[0].environment.cpu}, ${runs[0].environment.cpuCount} cores, ${(runs[0].environment.memoryBytes/2**30).toFixed(0)} GiB, ${runs[0].environment.platform}/${runs[0].environment.arch}, OS ${runs[0].environment.osRelease}, Node ${runs[0].environment.node}. Same pinned local Miniflare/workerd and compatibility date as Stage A. These are native local loopback measurements, not deployed Cloudflare hardware, Internet RTT or multi-room contention measurements. Twenty cold trials/five process starts give directional percentiles only. Original results and prior milestone results remain preserved.\n`;
writeFileSync(new URL('report.md',import.meta.url),out);
console.log(JSON.stringify({decision,runs:gates,matchedImpactBursts:matchedGates}));
