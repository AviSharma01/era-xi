import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, renameSync, copyFileSync } from 'node:fs';
import { cpus, totalmem, release, arch } from 'node:os';
import { performance } from 'node:perf_hooks';
import { fixture, startRuntime, request, seed, evict, envelope, summary } from './runtime.mjs';
import { profile } from './profile.mjs';

const mode = process.argv[2] ?? 'smoke';
if(mode==='inspect-failure'){
  const inspectedRuntime=await startRuntime(new URL(process.argv[3],import.meta.url).pathname);
  try{
    const inspected=await request(inspectedRuntime,'measured','inspect');
    const saved=JSON.parse(inspected.result.canonical);
    const receipt=kind=>Object.fromEntries(Array.from({length:8},(_,p)=>[p,inspected.result.receipts[`receipt:burst-${kind}-${p}`]?.result.ok??null]));
    const evidence={inspectedAt:new Date().toISOString(),lastCommandType:saved.history.at(-1).command.type,spinReceipts:receipt('spin'),lockReceipts:receipt('lock')};
    writeFileSync(new URL('results/transport-incident.json',import.meta.url),JSON.stringify({
      failedAttempt:'Thirteenth burst trial, after 12 checkpointed successful trials',
      error:'TypeError: fetch failed; UND_ERR_SOCKET: other side closed; Promise.all participant index 7; no response bytes',
      timing:'Failure duration was not captured by the original driver; do not include it as a successful latency sample',
      evidence,changedClientDriver:'Node built-in HTTP, agent:false, one connection per request; no automatic retries',
      cause:'Unresolved local transport failure; cannot attribute to production Cloudflare or domain behavior'
    },null,2)+'\n');
    console.log(JSON.stringify(evidence));
  }finally{await inspectedRuntime.mf.dispose();}
  process.exit(0);
}
assert.ok(['smoke','full','profile'].includes(mode));
const inventory = JSON.parse(readFileSync(new URL('results/artifact-inventory.json', import.meta.url)));
const environment = { node: process.version, platform: process.platform,
  arch: arch(), osRelease: release(), cpu: cpus()[0].model, cpuCount: cpus().length, memoryBytes: totalmem() };
const resultPath = new URL(`results/${mode}.json`, import.meta.url);
const resuming = process.argv.includes('--resume');
let output = { mode, startedAt: new Date().toISOString(), environment, inventory,
  samples: {}, bursts: [], checks: [], limitations: ['Local loopback HTTP, not production Cloudflare hardware or internet latency.',
    'Worker phase clocks may be IO-coarsened; client timings use Node monotonic time.', 'Cold percentiles are directional; raw samples and maxima are retained.'] };
if (resuming) {
  assert.equal(mode, 'full', 'Only full matrices support checkpoint resume');
  output = JSON.parse(readFileSync(resultPath));
  assert.ok(!output.completedAt, 'Matrix already completed');
  assert.deepEqual(output.environment, environment, 'Environment changed; report separate runs instead');
  assert.deepEqual(output.inventory, inventory, 'Artifacts changed');
  copyFileSync(resultPath, new URL(`results/full.checkpoint-${Date.now()}.json`, import.meta.url));
  (output.resumeHistory ??= []).push({ resumedAt: new Date().toISOString(), priorCheckpointAt: output.updatedAt,
    reason: process.argv.includes('--after-transport-failure')?'Resume after recorded local transport failure; client now uses node:http agent:false':'User requested pause and later continuation', environment });
}
const countSamples = name => output.samples[name]?.length ?? 0;
const statePath = new URL(`.state/${mode}-${Date.now()}/`, import.meta.url).pathname;
let runtime = await startRuntime(statePath);
const collect = async (name, room, action, input, participant) => {
  const measured = await request(runtime, room, action, input, participant);
  measured.sample.runSegment = output.resumeHistory?.length ?? 0;
  (output.samples[name] ??= []).push(measured.sample);
  return measured;
};
const reset = async (era, count, stage, room = 'measured') => {
  const data = fixture(era,count,stage); await seed(runtime,room,data); return data;
};
const checkpoint = () => {
  output.summaries = Object.fromEntries(Object.entries(output.samples).map(([name,samples])=>[name,summary(samples)]));
  output.updatedAt = new Date().toISOString();
  const temporary = new URL(`results/${mode}.json.tmp`, import.meta.url);
  writeFileSync(temporary, JSON.stringify(output,null,2)+'\n');
  renameSync(temporary, resultPath);
};
try {
  if (mode === 'profile') {
    output.diagnostic = await profile(runtime, 'era-impact');
    output.completedAt = new Date().toISOString();checkpoint();
  } else {
  // All eras get correctness and late eight-player smoke before selecting the
  // repeated matrix, because artifact size alone does not establish replay cost.
  for (const era of inventory.map(e=>e.eraId)) {
    if (output.checks.some(check=>check.era===era)) continue;
    const data = await reset(era,8,'late');
    for(let i=0;i<3;i++) await collect(`${era}/8/late/warm-snapshot`,'measured','snapshot');
    const spun = await collect(`${era}/8/late/spin`,'measured','command', { envelope: envelope('smoke-spin', data.draftRevisions[0].revision,{type:'SPIN'}) });
    assert.ok(spun.result.ok);
    const duplicate = await request(runtime,'measured','command',{envelope:envelope('smoke-spin',data.draftRevisions[0].revision,{type:'SPIN'})});
    assert.deepEqual(duplicate.result,spun.result);
    const instance = duplicate.sample.instanceId;
    await evict(runtime,'measured');
    const cold = await collect(`${era}/8/late/cold-snapshot`,'measured','snapshot');
    assert.notEqual(cold.sample.instanceId,instance);
    assert.deepEqual(cold.result,spun.result.view);
    await reset(era,8,'submitted');
    const submitted = fixture(era,8,'submitted');
    const final = await collect(`${era}/8/final-submit`,'measured','command',{envelope:envelope('smoke-final',submitted.draftRevisions.find(p=>p.participantId==='p7').revision,{type:'SUBMIT'})},'p7');
    assert.ok(final.result.ok); assert.equal(final.result.view.phase,'COMPLETE'); assert.equal(final.result.view.resolution.contestStatus,'CONTESTED');
    output.checks.push({era, canonicalRestartAndReceiptRetry:true,finalResolution:true});
    checkpoint(); console.log(`Smoke ${era}: snapshot ${Math.round(summary(output.samples[`${era}/8/late/warm-snapshot`]).p50Ms)} ms, spin ${Math.round(spun.sample.clientMs)} ms, cold ${Math.round(cold.sample.clientMs)} ms`);
  }
  const ranking=inventory.map(e=>({era:e.eraId,ms:summary(output.samples[`${e.eraId}/8/late/warm-snapshot`]).p50Ms})).sort((a,b)=>b.ms-a.ms);
  output.primaryEra=ranking[0].era; output.crossEraRanking=ranking;
  const primary=ranking[0];
  output.expandedEras=ranking.filter(e=>e.era!==primary.era&&e.ms>=primary.ms*.9).map(e=>e.era);
  if(mode==='smoke'){checkpoint();console.log(`Heaviest runtime fixture: ${output.primaryEra}`);}
  else {
    // The full matrix is primarily on the measured worst era. Any era within
    // 10% gets additional burst/finalization checks, not another redundant matrix.
    const era=output.primaryEra;
    const warm=30,cold=20,burstTrials=20;
    for(const count of [2,8])for(const stage of ['early','middle','late','resolved']) {
      if(countSamples(`primary/${count}/${stage}/warm-snapshot`)>=warm)continue;
      await reset(era,count,stage);
      for(let i=countSamples(`primary/${count}/${stage}/warm-snapshot`);i<warm;i++)await collect(`primary/${count}/${stage}/warm-snapshot`,'measured','snapshot');
      checkpoint();console.log(`Warm ${count} players ${stage} complete`);
    }
    const late=fixture(era,8,'late'),spun=fixture(era,8,'spun'),submitted=fixture(era,8,'submitted'),complete=fixture(era,8,'complete');
    for(const [name,data,participant,make]of [
      ['spin',late,'p0',()=>envelope('measure',late.draftRevisions[0].revision,{type:'SPIN'})],
      ['respin',spun,'p0',()=>envelope('measure',spun.draftRevisions[0].revision,{type:'RESPIN'})],
      ['lock',spun,'p0',()=>spun.lockEnvelopes?.[0]],
      ['submit',complete,'p0',()=>envelope('measure',complete.draftRevisions[0].revision,{type:'SUBMIT'})],
      ['final-submit',submitted,'p7',()=>envelope('measure',submitted.draftRevisions.find(p=>p.participantId==='p7').revision,{type:'SUBMIT'})],
      ['stale',late,'p0',()=>envelope('measure',0,{type:'SPIN'})],
      ['retry',late,late.lastCommand.actor.participantId,()=>late.lastCommand.envelope],
    ]) {
      for(let i=countSamples(`primary/8/late/${name}`);i<warm;i++){
        await seed(runtime,'measured',data);
        const cmd=make();assert.ok(cmd,`Missing ${name} fixture envelope`);
        const r=await collect(`primary/8/late/${name}`,'measured','command',{envelope:cmd},participant);
        if(name==='stale')assert.equal(r.result.code,'STALE_DRAFT_REVISION');else assert.ok(r.result.ok);
        if(name==='final-submit')assert.equal(r.result.view.phase,'COMPLETE');
      }
      checkpoint();console.log(`Command ${name} complete`);
    }
    for(const stage of ['late','resolved']){
      if(countSamples(`primary/8/${stage}/cold-snapshot`)>=cold)continue;
      await reset(era,8,stage);
      for(let i=countSamples(`primary/8/${stage}/cold-snapshot`);i<cold;i++){
        const before=await request(runtime,'measured','snapshot');await evict(runtime,'measured');
        const r=await collect(`primary/8/${stage}/cold-snapshot`,'measured','snapshot');
        assert.notEqual(r.sample.instanceId,before.sample.instanceId);assert.deepEqual(r.result,before.result);
      }
      checkpoint();console.log(`Cold ${stage} complete`);
    }
    for(let i=countSamples('primary/8/late/cold-spin');i<cold;i++){
      await seed(runtime,'measured',late);await evict(runtime,'measured');
      const r=await collect('primary/8/late/cold-spin','measured','command',{envelope:envelope('cold-spin',late.draftRevisions[0].revision,{type:'SPIN'})});assert.ok(r.result.ok);
      checkpoint();console.log(`Cold SPIN ${i+1}/${cold} complete`);
    }
    for(let trial=0;trial<burstTrials;trial++){
      if(['spin','lock'].every(stage=>output.bursts.some(b=>b.trial===trial&&b.stage===stage)))continue;
      await reset(era,8,'late');
      for(const stage of ['spin','lock']){
        const begin=performance.now();
        const responses=await Promise.all(late.draftRevisions.map((p,index)=>collect(`primary/8/burst-${stage}`,'measured','command',{
          envelope:stage==='spin'?envelope(`burst-spin-${index}`,p.revision,{type:'SPIN'}):spun.lockEnvelopes[index]},p.participantId)));
        responses.forEach(r=>assert.ok(r.result.ok));
        output.bursts.push({trial,stage,drainMs:performance.now()-begin,participants:responses.map((r,index)=>({participantId:`p${index}`, ...r.sample}))});
      }
      checkpoint();console.log(`Burst ${trial+1}/${burstTrials} complete`);
    }
    for (const alternate of output.expandedEras) {
      const alternateLate = fixture(alternate,8,'late'), alternateSpun = fixture(alternate,8,'spun');
      for (let trial=0;trial<5;trial++) {
        await reset(alternate,8,'late');
        for (const stage of ['spin','lock']) {
          const responses = await Promise.all(alternateLate.draftRevisions.map((p,index)=>collect(
            `${alternate}/8/expanded-burst-${stage}`,'measured','command',{
              envelope:stage==='spin'?envelope(`expanded-spin-${index}`,p.revision,{type:'SPIN'}):alternateSpun.lockEnvelopes[index]
            },p.participantId)));
          responses.forEach(r=>assert.ok(r.result.ok));
        }
        const finalFixture = await reset(alternate,8,'submitted');
        const final = await collect(`${alternate}/8/expanded-final-submit`,'measured','command',{
          envelope:envelope('expanded-final',finalFixture.draftRevisions.find(p=>p.participantId==='p7').revision,{type:'SUBMIT'})
        },'p7');
        assert.equal(final.result.view.phase,'COMPLETE');
      }
      checkpoint();
    }
    // Repeated process-cold recovery preserves the same SQLite directory.
    await reset(era,8,'late');
    for(let i=countSamples('primary/8/late/process-cold-snapshot');i<5;i++){
      const before=await request(runtime,'measured','snapshot');const t=performance.now();await runtime.mf.dispose();runtime=await startRuntime(statePath);
      const bootMs=performance.now()-t;const r=await collect('primary/8/late/process-cold-snapshot','measured','snapshot');r.sample.runtimeBootMs=bootMs;
      assert.notEqual(r.sample.instanceId,before.sample.instanceId);assert.deepEqual(r.result,before.result);
      checkpoint();console.log(`Process-cold ${i+1}/5 complete`);
    }
    // Real autonomous alarms: no polling/snapshot request until alarmReport exists
    // via an inspection endpoint that does not initialize/resume the M3 service.
    for(let i=output.deadlines?.length??0;i<cold;i++){
      await seed(runtime,'deadline',complete);
      const armed = await request(runtime,'deadline','arm',{logicalNow:900010-1000});
      if(i%2===0)await evict(runtime,'deadline');
      const waitingAt=performance.now();let inspect;
      await new Promise(resolve=>setTimeout(resolve,1500));
      for(let poll=0;poll<120;poll++){
        await new Promise(resolve=>setTimeout(resolve,250));inspect=await request(runtime,'deadline','inspect');
        if(inspect.result.alarmReport)break;
      }
      assert.ok(inspect.result.alarmReport,'Autonomous alarm did not complete');
      const canonical=JSON.parse(inspect.result.canonical);assert.equal(canonical.history.at(-1).resultingCompetitionPhase,'COMPLETE');
      assert.equal(canonical.history.filter(e=>e.command.type==='FINALIZE_ROUND').length,1);
      const r=await collect('primary/8/deadline/resolved-snapshot','deadline','snapshot');assert.equal(r.result.resolution.trigger,'DEADLINE');
      (output.deadlines??=[]).push({trial:i,cold:i%2===0,observedWaitMs:performance.now()-waitingAt,
        alarmDeliveryDelayMs:inspect.result.alarmReport.startedAt-armed.result.alarmAt,
        deadlineToCompletionMs:inspect.result.alarmReport.completedAt-armed.result.alarmAt,...inspect.result.alarmReport});
      // Repeated resume must neither change history nor add another receipt.
      await request(runtime,'deadline','resume');const after=await request(runtime,'deadline','inspect');assert.equal(after.result.canonical,inspect.result.canonical);
      checkpoint();console.log(`Deadline ${i+1}/${cold} complete`);
    }
    for(let i=countSamples('primary/8/deadline/overdue-cold');i<cold;i++){
      await seed(runtime,'overdue',complete,900020,false);await evict(runtime,'overdue');
      const r=await collect('primary/8/deadline/overdue-cold','overdue','snapshot');assert.equal(r.result.resolution.trigger,'DEADLINE');
      checkpoint();console.log(`Overdue-cold ${i+1}/${cold} complete`);
    }
    checkpoint();
  }
  output.completedAt=new Date().toISOString();checkpoint();
  }
} catch(error){
  writeFileSync(new URL(`results/${mode}.failure-${Date.now()}.json`,import.meta.url),JSON.stringify({
    failedAt:new Date().toISOString(),lastCheckpointAt:output.updatedAt,error:String(error),sample:error.stageASample,
    note:'Not included in successful latency percentiles; persisted room may already contain the command receipt'
  },null,2)+'\n');
  throw error;
} finally { await runtime.mf.dispose(); }
