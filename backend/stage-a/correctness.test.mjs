import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, startRuntime, request, seed, evict, envelope } from './runtime.mjs';

test('real workerd/SQLite adapter correctness and recovery', { timeout: 180000 }, async t => {
  const path=mkdtempSync(join(tmpdir(),'draft-off-stage-a-'));
  let runtime=await startRuntime(path);
  try {
    await t.test('all five eras restore lobby and drafting; fixture receipts reproduce the exact M3 result',async()=>{
      const inventory=JSON.parse(readFileSync(new URL('results/artifact-inventory.json',import.meta.url)));
      for(const {eraId}of inventory){
        await seed(runtime,'correctness',fixture(eraId,2,'lobby'));
        assert.equal((await request(runtime,'correctness','snapshot')).result.phase,'LOBBY');
        const data=fixture(eraId,2,'late');await seed(runtime,'correctness',data);
        const before=await request(runtime,'correctness','snapshot');
        await evict(runtime,'correctness');const after=await request(runtime,'correctness','snapshot');
        assert.notEqual(before.sample.instanceId,after.sample.instanceId);assert.deepEqual(before.result,after.result);
        const retry=await request(runtime,'correctness','command',{envelope:data.lastCommand.envelope},data.lastCommand.actor.participantId);
        assert.deepEqual(retry.result,data.lastCommand.result);
      }
    });
    await t.test('different participant commands both succeed; same-participant races accept exactly one',async()=>{
      const data=fixture('era-impact',8,'late');await seed(runtime,'races',data);await request(runtime,'races','snapshot');
      const r=await Promise.all([0,1].map(p=>request(runtime,'races','command',{envelope:envelope(`different-${p}`,data.draftRevisions[p].revision,{type:'SPIN'})},`p${p}`)));
      r.forEach(x=>assert.ok(x.result.ok));
      const revision=r[0].result.view.myDraft.revision;
      const conflicts=await Promise.all([0,1].map(p=>request(runtime,'races','command',{envelope:envelope(`same-${p}`,revision,{type:'RESPIN'})})));
      assert.equal(conflicts.filter(x=>x.result.ok).length,1);
      assert.equal(conflicts.find(x=>!x.result.ok).result.code,'STALE_DRAFT_REVISION');
    });
    await t.test('failure rolls back canonical state, receipt, and alarm; exact retry then resolves',async()=>{
      const data=fixture('era-impact',8,'submitted');await seed(runtime,'rollback',data);await request(runtime,'rollback','snapshot');
      const before=await request(runtime,'rollback','inspect');
      const cmd=envelope('last-submit',data.draftRevisions.find(p=>p.participantId==='p7').revision,{type:'SUBMIT'});
      const response=await fetch(new URL('/room/rollback/command?participant=p7',runtime.url),{
        method:'POST',headers:{'content-type':'application/json',connection:'close'},body:JSON.stringify({envelope:cmd,failBeforeCommit:true})});
      await response.text();assert.equal(response.status,500);
      const after=await request(runtime,'rollback','inspect');assert.equal(after.result.canonical,before.result.canonical);
      assert.deepEqual(after.result.receipts,before.result.receipts);assert.equal(after.result.alarmAt,before.result.alarmAt);
      const accepted=await request(runtime,'rollback','command',{envelope:cmd},'p7');assert.ok(accepted.result.ok);assert.equal(accepted.result.view.phase,'COMPLETE');
      const inspection=await request(runtime,'rollback','inspect');assert.equal(inspection.result.alarmAt,null);
      await evict(runtime,'rollback');const retry=await request(runtime,'rollback','command',{envelope:cmd},'p7');assert.deepEqual(retry.result,accepted.result);
    });
    await t.test('process restart keeps SQLite state and receipts; overdue restore commits finalization once',async()=>{
      const data=fixture('era-impact',8,'late');await seed(runtime,'restart',data);const before=await request(runtime,'restart','snapshot');
      await runtime.mf.dispose();runtime=await startRuntime(path);const after=await request(runtime,'restart','snapshot');
      assert.notEqual(before.sample.instanceId,after.sample.instanceId);assert.deepEqual(before.result,after.result);
      const retry=await request(runtime,'restart','command',{envelope:data.lastCommand.envelope},data.lastCommand.actor.participantId);assert.deepEqual(retry.result,data.lastCommand.result);
      await seed(runtime,'overdue',fixture('era-impact',8,'complete'),900020,false);
      assert.equal((await request(runtime,'overdue','snapshot')).result.resolution.trigger,'DEADLINE');
      const first=await request(runtime,'overdue','inspect');await request(runtime,'overdue','resume');
      const second=await request(runtime,'overdue','inspect');assert.equal(second.result.canonical,first.result.canonical);
      assert.equal(JSON.parse(second.result.canonical).history.filter(e=>e.command.type==='FINALIZE_ROUND').length,1);
    });
    await t.test('native cold alarm resolves once; another native alarm after resolution is harmless',async()=>{
      await seed(runtime,'alarms',fixture('era-impact',8,'complete'));
      const firstArm=await request(runtime,'alarms','arm',{logicalNow:899010});
      await evict(runtime,'alarms');
      const waitForAlarm=async alarmAt=>{
        await new Promise(resolve=>setTimeout(resolve,1500));
        for(let i=0;i<80;i++){
          const inspected=await request(runtime,'alarms','inspect');
          if(inspected.result.alarmReport?.startedAt>=alarmAt)return inspected.result;
          await new Promise(resolve=>setTimeout(resolve,250));
        }
        throw new Error('Native alarm did not complete');
      };
      const first=await waitForAlarm(firstArm.result.alarmAt);
      assert.equal(JSON.parse(first.canonical).history.filter(e=>e.command.type==='FINALIZE_ROUND').length,1);
      assert.equal((await request(runtime,'alarms','snapshot')).result.resolution.trigger,'DEADLINE');
      const secondArm=await request(runtime,'alarms','arm',{logicalNow:899010});
      const second=await waitForAlarm(secondArm.result.alarmAt);
      assert.equal(second.canonical,first.canonical);
      assert.deepEqual(second.receipts,first.receipts);
      assert.equal(second.alarmAt,null);
    });
  } finally {await runtime.mf.dispose();}
});
