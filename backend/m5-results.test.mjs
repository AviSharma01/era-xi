import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { request as httpRequest } from 'node:http';
import WebSocket from './stage-a/node_modules/ws/wrapper.mjs';
import { startRuntime, call, control, origin } from './stage-d/runtime.mjs';
import { parseDraftOffResults } from '../dist/draftOffResultsClient.js';
import { DRAFT_OFF_RESULTS_MAX_BYTES } from '../dist/draftOffResultsTypes.js';
import { restoreDraftOffCompetition } from '../dist/draftOffCompetitionPersistence.js';
import { catalog, assertResultsAgainstState } from '../dist/draftOffResultsTestSupport.js';

process.chdir(fileURLToPath(new URL('stage-d/', import.meta.url)));
const key = () => randomBytes(32).toString('base64url');
const missingId = 'p_' + '0'.repeat(32);
const permissive = { requestsPerMinute:50000,enrollmentPerMinute:50000,roomEnrollmentsPerMinute:1000,roomEnrollmentBurst:100,
  commandsPerMinute:5000,commandBurst:1000,readsPerMinute:5000,readBurst:1000 };
const error = (reply,status,code) => { assert.equal(reply.status,status);assert.deepEqual(reply.body,{ok:false,error:{code,message:code==='RESULTS_NOT_READY'?'Results are not ready.':code==='RESULT_UNAVAILABLE'?'Result is unavailable.':code==='AUTHENTICATION_FAILED'?'Authentication failed.':reply.body.error.message}}); };
async function fixture(run, options={}) {
  const path=mkdtempSync(join(tmpdir(),'draft-off-m53-'));
  let runtime=await startRuntime(path,{overrides:{...permissive,...options.overrides},production:options.production});
  const logs=[runtime.logs];
  const read=async entry=>{const reply=await call(runtime,`/rooms/${entry.roomCode}`,{token:entry.reconnectCredential});assert.equal(reply.status,200);entry.view=reply.body.view;return reply;};
  async function enroll(name, host=false, roomCode, eraId='era-impact') {
    const reply=await call(runtime,host?'/rooms':`/rooms/${roomCode}/join`,{method:'POST',key:key(),body:host?{displayName:name,eraId,draftMinutes:10}:{displayName:name}});
    assert.equal(reply.status,201);return {...reply.body,displayName:name};
  }
  async function command(entry,type,fields={}) {
    const lifecycle=['START','LEAVE','REJOIN'].includes(type);
    const reply=await call(runtime,`/rooms/${entry.roomCode}/commands`,{method:'POST',token:entry.reconnectCredential,
      body:{commandId:key(),...(lifecycle?{expectedRoomRevision:entry.view.revision}:{expectedDraftRevision:entry.view.myDraft.revision}),command:{type,...fields}}});
    assert.equal(reply.status,200,JSON.stringify(reply.body));entry.view=reply.body.view;return reply;
  }
  async function draft(entry, variant=0) {
    for(let n=0;n<11;n++) {
      await command(entry,'SPIN');
      const choices=entry.view.myDraft.candidates.filter(p=>p.available).flatMap(p=>p.positions.filter(s=>s.available)
        .map(s=>({playerTeamSeasonId:p.playerTeamSeasonId,battingPosition:s.battingPosition})));
      const choice=choices[variant===0?0:Math.max(0,choices.length-variant)];assert.ok(choice);
      await command(entry,'LOCK_PLAYER',choice);
    }
  }
  const results=(viewer,target=viewer.participantId,extra={})=>call(runtime,`/rooms/${viewer.roomCode}/results/${target}`,{token:viewer.reconnectCredential,...extra});
  const api={ get runtime(){return runtime;},logs,enroll,read,command,draft,results,
    async authority(roomCode){return restoreDraftOffCompetition(catalog,(await control(runtime,roomCode,'inspect')).records.competition);},
    async restart(){await runtime.mf.dispose();runtime=await startRuntime(path,{overrides:{...permissive,...options.overrides},production:options.production});logs.push(runtime.logs);},
    async start(entries){await read(entries[0]);await command(entries[0],'START');for(const entry of entries.slice(1))await read(entry);},
  };
  try{await run(api);}finally{await runtime.mf.dispose();rmSync(path,{recursive:true,force:true});}
}
function safe(body, secrets=[]) {
  const bytes=JSON.stringify(body);
  assert.doesNotMatch(bytes,/challengeSeed|draftRootSeed|scenarioSeed|simulationSeed|scheduleSeed|submissionHash|campaignHash|resolutionHash|resultIdentityHash|gameplayXiIdentity|catalogFingerprint|internalScore|battingContributions|serializedCompetition|receipts|reconnectCredential|verifier|ciphertext/);
  for(const secret of secrets)assert.ok(!bytes.includes(secret));
}
function rawGet(runtime,path,token) {
  return new Promise((resolve,reject)=>{const req=httpRequest(new URL(`/api/draft-off/v1${path}`,runtime.url),{method:'GET',headers:{Origin:origin,'CF-Connecting-IP':'127.0.0.1',Authorization:`Bearer ${token}`,'Content-Length':'2'}},res=>{
    const chunks=[];res.on('data',data=>chunks.push(data));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks))}));});req.on('error',reject);req.end('{}');});
}
async function socket(runtime,entry) {
  const ticket=await call(runtime,`/rooms/${entry.roomCode}/socket-tickets`,{method:'POST',body:{},token:entry.reconnectCredential});assert.equal(ticket.status,201);
  const url=new URL(`/api/draft-off/v1/rooms/${entry.roomCode}/realtime`,runtime.url);url.protocol='ws:';
  const ws=new WebSocket(url,['draft-off.v1',`ticket.${ticket.body.ticket}`],{headers:{Origin:origin,'CF-Connecting-IP':'127.0.0.1'}}),messages=[];
  ws.on('message',data=>messages.push(JSON.parse(data.toString())));
  await new Promise((resolve,reject)=>{ws.once('message',resolve);ws.once('error',reject);});
  return{ws,messages};
}

test('M5.3 native results authorization, privacy, overdue resolution, expiry and HTTP validation', {timeout:90000},()=>fixture(async api=>{
  const host=await api.enroll('Host',true), member=await api.enroll('Incomplete',false,host.roomCode), left=await api.enroll('Left',false,host.roomCode);
  await api.command(left,'LEAVE');
  for(const target of [host.participantId,missingId])error(await api.results(host,target),409,'RESULTS_NOT_READY');
  await api.start([host,member]);await api.draft(host);await api.command(host,'SUBMIT');
  error(await api.results(host),409,'RESULTS_NOT_READY');error(await api.results(member,missingId),409,'RESULTS_NOT_READY');
  const targetPath=`/rooms/${host.roomCode}/results/${host.participantId}`;
  const unauth=await call(api.runtime,targetPath);error(unauth,401,'AUTHENTICATION_FAILED');
  const foreign=await api.enroll('Other room',true);
  assert.deepEqual((await api.results({...host,reconnectCredential:foreign.reconnectCredential})).body,unauth.body);
  assert.deepEqual((await api.results({...host,roomCode:'ZZZZZZZZZZZZ'})).body,unauth.body);
  const validation=[
    [await call(api.runtime,targetPath,{token:host.reconnectCredential,headers:{Origin:'https://evil.example'}}),403,'ORIGIN_NOT_ALLOWED'],
    [await call(api.runtime,targetPath,{token:host.reconnectCredential,headers:{Origin:''}}),403,'ORIGIN_NOT_ALLOWED'],
    [await call(api.runtime,targetPath+'?roundId=r1',{token:host.reconnectCredential}),400,'INVALID_REQUEST'],
    [await call(api.runtime,targetPath,{method:'POST',token:host.reconnectCredential}),405,'METHOD_NOT_ALLOWED'],
    [await call(api.runtime,targetPath,{token:host.reconnectCredential,key:key()}),400,'INVALID_REQUEST'],
    [await call(api.runtime,`/rooms/${host.roomCode}/results/bad`,{token:host.reconnectCredential}),400,'INVALID_REQUEST'],
    [await rawGet(api.runtime,targetPath,host.reconnectCredential),400,'INVALID_REQUEST'],
  ];for(const [reply,status,code]of validation)error(reply,status,code);
  const preflight=await call(api.runtime,targetPath,{method:'OPTIONS',headers:{'Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'authorization'}});assert.equal(preflight.status,204);
  await control(api.runtime,host.roomCode,'offset',{offset:host.view.round.deadlineAtMs-Date.now()+1});
  // First results GET itself performs existing overdue recovery; incomplete entrant may inspect host.
  const reply=await api.results(member,host.participantId);assert.equal(reply.status,200);
  const authority=await api.authority(host.roomCode);assertResultsAgainstState(reply.body,authority,host.participantId);safe(reply.body,[host.reconnectCredential,member.reconnectCredential]);
  assert.equal(reply.headers.get('cache-control'),'private, no-store');assert.equal(reply.headers.get('access-control-allow-origin'),origin);
  await api.read(member);assert.equal(member.view.resolution.contestStatus,'UNCONTESTED');
  for(const target of [member.participantId,left.participantId,missingId,foreign.participantId])error(await api.results(member,target),404,'RESULT_UNAVAILABLE');
  for(const target of [host.participantId,missingId])error(await api.results(left,target),404,'RESULT_UNAVAILABLE');
  await api.restart();const restarted=await api.results(member,host.participantId);assert.equal(restarted.status,200);
  assertResultsAgainstState(restarted.body,authority,host.participantId);assert.deepEqual(restarted.body,reply.body);
  const resolvedAt=member.view.resolution.resolvedAtMs;
  await control(api.runtime,host.roomCode,'offset',{offset:resolvedAt+7*86400000-Date.now()});
  assert.deepEqual((await api.results(host)).body,unauth.body);
  const records=(await control(api.runtime,host.roomCode,'inspect')).records;
  assert.deepEqual(Object.keys(records),['retired']);assert.equal(records.retired.retiredAtMs,resolvedAt+7*86400000);
}));

test('M5.3 eight-player resolved reads preserve snapshots/receipts, survive cold restoration and report replay cost', {timeout:180000},()=>fixture(async api=>{
  const host=await api.enroll('Eight host',true),entries=[host];for(let n=1;n<8;n++)entries.push(await api.enroll(`Eight ${n}`,false,host.roomCode));
  await api.start(entries);for(const [index,entry] of entries.entries())await api.draft(entry,index);for(const entry of entries)await api.command(entry,'SUBMIT');
  const before=(await api.read(host)).body.view, stored=await control(api.runtime,host.roomCode,'inspect');
  // Independent oracle: restore the persisted submission history, never the HTTP response.
  const authority=restoreDraftOffCompetition(catalog,stored.records.competition),round=authority.rounds[0];
  assert.equal(round.phase,'RESOLVED');
  assert.equal(new Set(round.participants.map(p=>JSON.stringify(p.submission.xi.picks))).size,8);
  const campaigns=round.resolution.challengeResult.campaigns;
  assert.ok(new Set(campaigns.map(c=>c.evaluation.adjustedStrength.overall)).size>1);
  assert.ok(new Set(campaigns.map(c=>JSON.stringify(c.aggregate))).size>1);
  const connection=await socket(api.runtime,host);
  try {
    const replies=[];
    for(const viewer of entries){const reply=await api.results(viewer,host.participantId);assert.equal(reply.status,200);assertResultsAgainstState(reply.body,authority,host.participantId);replies.push(reply.body);}
    assert.ok(replies.every(body=>JSON.stringify(body)===JSON.stringify(replies[0])));
    assert.equal(connection.messages.length,1);safe(connection.messages[0]);assert.ok(!JSON.stringify(connection.messages).includes('battingRating'));
  }finally{connection.ws.terminate();}
  const expected=new Map(),warm=[],cold=[],baseline=[];let maxBytes=0;
  for(let pass=0;pass<2;pass++)for(const entry of entries){const start=performance.now(),reply=await api.results(host,entry.participantId);warm.push(performance.now()-start);assert.equal(reply.status,200);
    const size=Buffer.byteLength(JSON.stringify(reply.body));maxBytes=Math.max(maxBytes,size);assert.ok(size<=DRAFT_OFF_RESULTS_MAX_BYTES);safe(reply.body,entries.map(e=>e.reconnectCredential));
    assertResultsAgainstState(reply.body,authority,entry.participantId);if(pass===0)expected.set(entry.participantId,reply.body);else assert.deepEqual(reply.body,expected.get(entry.participantId));}
  for(let n=0;n<8;n++){const start=performance.now();await api.read(host);baseline.push(performance.now()-start);}
  let previous=(await control(api.runtime,host.roomCode,'instance')).instanceId;
  for(const entry of entries){
    await api.runtime.mf.unsafeEvictDurableObject('stage-d','StageDTestRoom',{name:host.roomCode});
    const start=performance.now(),reply=await api.results(host,entry.participantId);cold.push(performance.now()-start);assert.equal(reply.status,200);assert.deepEqual(reply.body,expected.get(entry.participantId));
    assertResultsAgainstState(reply.body,authority,entry.participantId);
    const current=(await control(api.runtime,host.roomCode,'instance')).instanceId;assert.notEqual(current,previous);previous=current;
  }
  await api.restart();const start=performance.now(),restarted=await api.results(host,entries[7].participantId);const restartMs=performance.now()-start;
  assert.equal(restarted.status,200);assertResultsAgainstState(restarted.body,authority,entries[7].participantId);assert.deepEqual(restarted.body,expected.get(entries[7].participantId));
  assert.deepEqual((await api.read(host)).body.view,before);
  const after=await control(api.runtime,host.roomCode,'inspect');assert.equal(after.records.competition,stored.records.competition);assert.equal(after.alarm,stored.alarm);
  const receipts=records=>Object.fromEntries(Object.entries(records).filter(([key])=>key.startsWith('receipt:')||key.startsWith('api:command:')));
  assert.deepEqual(receipts(after.records),receipts(stored.records));
  const summary=values=>{const sorted=[...values].sort((a,b)=>a-b);return{count:values.length,medianMs:+sorted[Math.floor(sorted.length/2)].toFixed(2),p95Ms:+sorted[Math.ceil(sorted.length*.95)-1].toFixed(2),maxMs:+sorted.at(-1).toFixed(2)};};
  console.log(JSON.stringify({m53EightPlayerResults:{warm:summary(warm),cold:summary(cold),roomGet:summary(baseline),restartMs:+restartMs.toFixed(2),maxResponseBytes:maxBytes}}));
  for(const log of api.logs.flat()){const bytes=JSON.stringify(log);for(const entry of entries){assert.ok(!bytes.includes(entry.reconnectCredential));assert.ok(!bytes.includes(entry.participantId));assert.ok(!bytes.includes(entry.displayName));}assert.ok(!bytes.includes('battingRating'));}
}));

test('M5.3 no-contest has no inspectable XI and shared READ quota rejects before cold replay', {timeout:90000},()=>fixture(async api=>{
  const host=await api.enroll('Empty',true),member=await api.enroll('Other',false,host.roomCode);await api.start([host,member]);
  await control(api.runtime,host.roomCode,'offset',{offset:host.view.round.deadlineAtMs-Date.now()+1});error(await api.results(host),404,'RESULT_UNAVAILABLE');
  const noContest=await api.read(host);assert.equal(noContest.body.view.resolution.contestStatus,'NO_CONTEST');
  await control(api.runtime,host.roomCode,'put',{key:`api:bucket:READ:${host.participantId}`,value:{tokens:0,atMs:Date.now()+86400000}});
  const before=await control(api.runtime,host.roomCode,'recovery-count');
  const denied=await api.results(host);error(denied,429,'RATE_LIMITED');assert.equal(denied.headers.get('retry-after'),'60');
  error(await call(api.runtime,`/rooms/${host.roomCode}`,{token:host.reconnectCredential}),429,'RATE_LIMITED');
  assert.equal(await control(api.runtime,host.roomCode,'recovery-count'),before);
  await api.runtime.mf.unsafeEvictDurableObject('stage-d','StageDTestRoom',{name:host.roomCode});
  error(await api.results(host),429,'RATE_LIMITED');assert.equal(await control(api.runtime,host.roomCode,'recovery-count'),0);
  await control(api.runtime,host.roomCode,'delete',{key:`api:bucket:READ:${host.participantId}`});
  await control(api.runtime,host.roomCode,'put',{key:'competition',value:'{}'});error(await api.results(host),503,'TEMPORARY_UNAVAILABLE');
}));

test('M5.3 production bundle supports early resolved results without fixture routes', {timeout:90000},()=>fixture(async api=>{
  const host=await api.enroll('Production host',true),member=await api.enroll('Production guest',false,host.roomCode);await api.start([host,member]);
  await api.draft(host);await api.draft(member,1);await api.command(host,'SUBMIT');await api.command(member,'SUBMIT');
  const reply=await api.results(host,member.participantId);assert.equal(reply.status,200);
  parseDraftOffResults(reply.body,{roomCode:host.roomCode,roundId:member.view.round.roundId,roundOrdinal:member.view.round.roundOrdinal,eraId:member.view.round.eraId,participantId:member.participantId});
  assert.deepEqual(reply.body.players.map(p=>[p.battingPosition,p.playerTeamSeasonId]),[...member.view.myDraft.picks].sort((a,b)=>a.battingPosition-b.battingPosition).map(p=>[p.battingPosition,p.playerTeamSeasonId]));safe(reply.body);
  assert.equal((await fetch(new URL('/__test/anything/inspect',api.runtime.url))).status,404);
},{production:true}));
