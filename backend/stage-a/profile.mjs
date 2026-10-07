import { writeFileSync } from 'node:fs';
import { request, seed, fixture, envelope } from './runtime.mjs';

// Diagnostic runs are separate from the repeated latency samples. Inspector
// sampling/heap queries can perturb execution, so they never set the latency gate.
export async function profile(runtime, era) {
  const inspector = await runtime.mf.getInspectorURL();
  const httpInspector = new URL(inspector); httpInspector.protocol = 'http:';
  const targets = await (await fetch(new URL('/json/list', httpInspector))).json();
  const target = targets.find(t => /stage-a/.test(t.title ?? t.url ?? '')) ?? targets.find(t=>t.webSocketDebuggerUrl);
  if (!target) throw new Error('No workerd inspector target');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  let id=0;const pending=new Map();
  socket.addEventListener('message',event=>{const message=JSON.parse(event.data);const waiting=pending.get(message.id);if(waiting){pending.delete(message.id);message.error?waiting.reject(new Error(JSON.stringify(message.error))):waiting.resolve(message.result);}});
  const call=(method,params={})=>new Promise((resolve,reject)=>{const sequence=++id;pending.set(sequence,{resolve,reject});socket.send(JSON.stringify({id:sequence,method,params}));});
  try {
    await call('Profiler.enable');await call('Runtime.enable');
    const data=fixture(era,8,'late');await seed(runtime,'profile',data);
    const heapBefore=await call('Runtime.getHeapUsage');
    await call('Profiler.setSamplingInterval',{interval:1000});await call('Profiler.start');
    const measured=await request(runtime,'profile','command',{envelope:envelope('profile-spin',data.draftRevisions[0].revision,{type:'SPIN'})});
    const {profile:cpu}=await call('Profiler.stop');const heapAfter=await call('Runtime.getHeapUsage');
    const nodes=new Map(cpu.nodes.map(n=>[n.id,n])),weights=new Map();
    for(let i=0;i<(cpu.samples??[]).length;i++){const node=nodes.get(cpu.samples[i]);const label=node?.callFrame.functionName||'(anonymous)';weights.set(label,(weights.get(label)??0)+(cpu.timeDeltas?.[i]??0));}
    const result={era,inspectorTarget:target.title,diagnosticClientMs:measured.sample.clientMs,heapBefore,heapAfter,
      profileDurationMs:(cpu.endTime-cpu.startTime)/1000,sampleCount:cpu.samples?.length,
      hottestSelfSamples:[...weights].sort((a,b)=>b[1]-a[1]).slice(0,20).map(([functionName,microseconds])=>({functionName,selfSampleMs:microseconds/1000}))};
    writeFileSync(new URL('results/diagnostic.cpuprofile',import.meta.url),JSON.stringify(cpu));
    writeFileSync(new URL('results/diagnostic.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
    return result;
  } finally {socket.close();}
}
